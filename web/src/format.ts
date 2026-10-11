import type { ClaimStatus } from './types';

export const STATUS_LABEL: Record<ClaimStatus, string> = {
  filed: 'Filed',
  triaging: 'Triaging',
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
  dead_lettered: 'Dead-lettered',
};

export const CAUSE_LABEL: Record<string, string> = {
  BATTERY_CELL_IMBALANCE: 'Cell imbalance',
  INVERTER_OVERCURRENT: 'Inverter overcurrent',
  COOLANT_PUMP_FAILURE: 'Coolant pump',
  CHARGE_PORT_WATER_INGRESS: 'Water ingress',
  THROTTLE_CONNECTOR_INTERMITTENT: 'Throttle connector',
  FIRMWARE_BELOW_MINIMUM: 'Firmware',
  IMPACT_DAMAGE: 'Impact damage',
  UNDETERMINED: 'Undetermined',
};

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const fmtMs = (ms: number | null | undefined) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
export const fmtUsd = (v: number | undefined) => (v == null ? '' : `$${v.toFixed(4)}`);
export const fmtInt = (n: number | undefined) => (n == null ? '' : n.toLocaleString('en-US'));
