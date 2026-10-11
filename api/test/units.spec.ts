import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdits, canonicalHash, parseIfMatch } from '../src/claims/commands.js';
import { CursorCodec, CursorError, filterHash } from '../src/claims/cursor.js';
import { loadConfig } from '../src/config.js';
import { fullJitterDelay } from '../src/jobs/backoff.js';
import { CircuitBreaker, type BreakerChange } from '../src/jobs/circuit-breaker.js';
import { TriageContract, type TriageResult } from '../src/jobs/contract.js';
import { buildChildEnv, pickPort } from '../src/triage-service/supervisor.service.js';

const root = loadConfig({}).repoRoot;
const fixtures = readdirSync(join(root, 'fixtures'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(root, 'fixtures', f), 'utf8')) as { scenario: string; result: TriageResult });

describe('CursorCodec', () => {
  const codec = new CursorCodec('secret');
  const pos = { filedAt: '2026-10-11T08:00:00.123Z', id: '6f1c2b8e-1d2a-4e5f-9a7b-0c1d2e3f4a5b' };

  it('round-trips a position', () => {
    expect(codec.decode(codec.encode(pos, 'h'), 'h')).toEqual(pos);
  });

  it('refuses another secret, another filter hash and garbage', () => {
    const c = codec.encode(pos, 'h');
    expect(() => new CursorCodec('other').decode(c, 'h')).toThrow(CursorError);
    expect(() => codec.decode(c, 'other-filters')).toThrow(/different filters/);
    expect(() => codec.decode('a.b.c', 'h')).toThrow(CursorError);
  });

  it('filter hash ignores order and empty values', () => {
    expect(filterHash({ status: 'approved', dealer_id: 3 })).toBe(filterHash({ dealer_id: 3, status: 'approved', q: undefined }));
    expect(filterHash({ status: 'approved' })).not.toBe(filterHash({ status: 'rejected' }));
  });
});

describe('fullJitterDelay', () => {
  it('stays inside [0, min(cap, base * 2^(n-1)))', () => {
    expect(fullJitterDelay(1, 1000, 15000, () => 0.999)).toBe(999);
    expect(fullJitterDelay(3, 1000, 15000, () => 0.5)).toBe(2000);
    expect(fullJitterDelay(10, 1000, 15000, () => 0.999)).toBeLessThan(15000);
    expect(fullJitterDelay(4, 1000, 15000, () => 0)).toBe(0);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, waits, probes, then closes', () => {
    let now = 0;
    const changes: BreakerChange[] = [];
    const b = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 }, () => now);
    b.onChange((c) => changes.push(c));
    b.recordFailure('refused');
    expect(b.state).toBe('closed');
    b.recordFailure('refused');
    expect(b.state).toBe('open');
    expect(b.allowsRequests()).toBe(false);
    now = 999;
    expect(b.readyToProbe()).toBe(false);
    now = 1000;
    expect(b.readyToProbe()).toBe(true);
    b.beginProbe();
    expect(b.state).toBe('half_open');
    b.recordFailure('probe failed');
    expect(b.state).toBe('open');
    now = 2500;
    b.beginProbe();
    b.recordSuccess('probe ok');
    expect(b.state).toBe('closed');
    expect(changes.map((c) => c.to)).toEqual(['open', 'half_open', 'open', 'half_open', 'closed']);
  });

  it('a success resets the failure count', () => {
    const b = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 });
    b.recordFailure('x');
    b.recordSuccess();
    b.recordFailure('x');
    expect(b.state).toBe('closed');
  });
});

describe('TriageContract (shared JSON Schema)', () => {
  const contract = new TriageContract(root);

  it('accepts every recorded fixture', () => {
    expect(fixtures.length).toBe(7);
    for (const f of fixtures) expect(contract.errors(f.result), f.scenario).toEqual([]);
  });

  it('rejects results that break it', () => {
    const base = fixtures[0].result;
    const broken = [
      { ...base, warranty: { ...base.warranty, clause: 'W9' } },
      { ...base, root_cause: { ...base.root_cause, confidence: 2 } },
      { ...base, evidence: [] },
      { ...base, surprise: true },
    ];
    for (const b of broken) expect(contract.errors(b).length).toBeGreaterThan(0);
  });
});

describe('claim helpers', () => {
  it('canonicalHash ignores key order', () => {
    expect(canonicalHash({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(canonicalHash({ b: { d: 'x', c: [1, 2] }, a: 1 }));
    expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
  });

  it('parseIfMatch accepts strong and weak ETags', () => {
    expect(parseIfMatch('"4"')).toBe(4);
    expect(parseIfMatch('W/"12"')).toBe(12);
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('4')).toBeNaN();
  });

  it('applyEdits records each changed field next to the suggestion', () => {
    const suggested = fixtures.find((f) => f.scenario === 'cell-imbalance')!.result;
    const { final, edits } = applyEdits(suggested, { action: 'approve', repair: { labour_hours: 2 } });
    expect(edits).toEqual([{ field: 'repair.labour_hours', from: suggested.repair.labour_hours, to: 2 }]);
    expect(final.repair.labour_hours).toBe(2);
    expect(suggested.repair.labour_hours).not.toBe(2);
    expect(applyEdits(suggested, { action: 'approve', repair: { labour_hours: suggested.repair.labour_hours } }).edits).toEqual([]);
  });
});

describe('triage service child process', () => {
  it('passes only allowlisted variables and never Claude Code session variables', () => {
    const env = buildChildEnv({ PATH: '/bin', HOME: '/h', SECRET_TOKEN: 'x', CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '1' }, { TRIAGE_PORT: '5000', CLAUDE_CODE_ENTRYPOINT: 'x' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', TRIAGE_PORT: '5000' });
  });

  it('picks a loopback port outside 4101-4130', async () => {
    const p = await pickPort();
    expect(p).toBeGreaterThan(0);
    expect(p < 4101 || p > 4130).toBe(true);
  });
});
