import type { DemoConfig, DemoKey } from './types';

export type Role = DemoKey['role'] | 'dealer2';

export interface LoggedRequest {
  id: number;
  at: number;
  method: string;
  path: string;
  role: Role | 'none';
  status: number;
  ms: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  body?: unknown;
}

export interface ApiResponse<T> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
  ms: number;
}

type Listener = () => void;
let log: LoggedRequest[] = [];
let seq = 0;
const listeners = new Set<Listener>();

export const requestLog = {
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  snapshot: () => log,
  push(entry: LoggedRequest) {
    log = [entry, ...log].slice(0, 80);
    listeners.forEach((l) => l());
  },
};

let keys: Record<Role, string> = { console: '', dealer: '', dealer2: '', engineer: '' };

export function setKeys(config: DemoConfig) {
  const pick = (id: string) => config.keys.find((k) => k.id === id)?.value ?? '';
  keys = { console: pick('key_console'), dealer: pick('key_dealer_1'), dealer2: pick('key_dealer_2'), engineer: pick('key_engineer') };
}

export const keyFor = (role: Role) => keys[role];
export const maskKey = (k: string) => (k.length > 14 ? `${k.slice(0, 12)}...${k.slice(-4)}` : k);

const SHOWN_HEADERS = ['content-type', 'etag', 'link', 'location', 'idempotent-replayed', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'ratelimit-policy', 'deprecation', 'sunset'];

export async function api<T>(
  method: string,
  path: string,
  opts: { role?: Role; body?: unknown; headers?: Record<string, string>; log?: boolean } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.role) headers.authorization = `Bearer ${keyFor(opts.role)}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const t0 = performance.now();
  const res = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (opts.log !== false) {
    const responseHeaders: Record<string, string> = {};
    for (const h of SHOWN_HEADERS) {
      const v = res.headers.get(h);
      if (v) responseHeaders[h] = v;
    }
    const shownReq = { ...headers };
    if (shownReq.authorization) shownReq.authorization = `Bearer ${maskKey(keyFor(opts.role!))}`;
    requestLog.push({ id: ++seq, at: Date.now(), method, path, role: opts.role ?? 'none', status: res.status, ms, requestHeaders: shownReq, responseHeaders, body: res.ok ? undefined : data });
  }
  return { status: res.status, ok: res.ok, headers: res.headers, data: data as T, ms };
}

export function problemText(data: unknown): string {
  if (data && typeof data === 'object') {
    const p = data as { title?: string; detail?: string };
    return [p.title, p.detail].filter(Boolean).join(': ');
  }
  return String(data);
}
