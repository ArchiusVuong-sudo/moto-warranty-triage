import { createHmac } from 'node:crypto';

export type Scope = 'claims:read' | 'claims:write' | 'triage:decide' | 'ops';

export interface KeyDefinition {
  id: string;
  label: string;
  role: 'dealer' | 'engineer' | 'console';
  scopes: Scope[];
  dealerId: number | null;
  rateCapacity: number;
  rateRefillPerSec: number;
}

/** Demo keys. Values are derived from DEMO_KEY_SEED at runtime; only their HMAC is stored. */
export const DEMO_KEYS: KeyDefinition[] = [
  { id: 'key_dealer_1', label: 'Dealer: Northgate Moto Works', role: 'dealer', scopes: ['claims:read', 'claims:write'], dealerId: 1, rateCapacity: 20, rateRefillPerSec: 1 },
  { id: 'key_dealer_2', label: 'Dealer: Ridgeway Cycles', role: 'dealer', scopes: ['claims:read', 'claims:write'], dealerId: 2, rateCapacity: 20, rateRefillPerSec: 1 },
  { id: 'key_engineer', label: 'Service engineer', role: 'engineer', scopes: ['claims:read', 'triage:decide'], dealerId: null, rateCapacity: 120, rateRefillPerSec: 10 },
  { id: 'key_console', label: 'Ops console', role: 'console', scopes: ['claims:read', 'ops'], dealerId: null, rateCapacity: 2000, rateRefillPerSec: 200 },
];

export function demoKeyValue(seed: string, id: string): string {
  const role = id.replace(/^key_/, '').replace(/_\d+$/, '');
  return `demo_${role}_${createHmac('sha256', seed).update(id).digest('hex').slice(0, 24)}`;
}

/** Keys are stored as HMAC-SHA256 with a server-side pepper, never in plain text. */
export function hashKey(pepper: string, key: string): string {
  return createHmac('sha256', pepper).update(key).digest('hex');
}
