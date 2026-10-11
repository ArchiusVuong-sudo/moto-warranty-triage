import { Ajv, type ValidateFunction } from 'ajv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TriageResult {
  schema_version: '1';
  root_cause: { code: string; title: string; component: string; confidence: number };
  evidence: { kind: 'telemetry' | 'fault_code' | 'bulletin' | 'policy'; ref: string; detail: string }[];
  repair: { parts: { part_number: string; description: string; qty: number }[]; labour_hours: number };
  warranty: { decision: 'covered' | 'not_covered' | 'needs_inspection'; clause: string; reason: string };
  summary: string;
}

/** The shared contract file, also used by the Python service's pytest suite. */
export class TriageContract {
  private readonly validateFn: ValidateFunction<TriageResult>;

  constructor(repoRoot: string) {
    const schema = JSON.parse(readFileSync(join(repoRoot, 'contracts', 'triage-result.v1.schema.json'), 'utf8')) as object;
    this.validateFn = new Ajv({ allErrors: true, strict: true }).compile<TriageResult>(schema);
  }

  errors(value: unknown): string[] {
    if (this.validateFn(value)) return [];
    return (this.validateFn.errors ?? []).slice(0, 8).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`);
  }

  isValid(value: unknown): value is TriageResult {
    return this.errors(value).length === 0;
  }
}
