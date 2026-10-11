export type ClaimStatus = 'filed' | 'triaging' | 'awaiting_review' | 'approved' | 'rejected' | 'dead_lettered';

export interface ClaimSummary {
  id: string;
  claim_number: string;
  dealer: { id: number; name: string };
  vin: string;
  model: string;
  complaint: string;
  status: ClaimStatus;
  filed_at: string;
  version: number;
  triage: { root_cause_code: string; confidence: number | null; warranty_decision: string | null } | null;
  historical: boolean;
}

export interface ClaimPage {
  data: ClaimSummary[];
  next_cursor: string | null;
}

export interface TriageResult {
  schema_version: '1';
  root_cause: { code: string; title: string; component: string; confidence: number };
  evidence: { kind: 'telemetry' | 'fault_code' | 'bulletin' | 'policy'; ref: string; detail: string }[];
  repair: { parts: { part_number: string; description: string; qty: number }[]; labour_hours: number };
  warranty: { decision: 'covered' | 'not_covered' | 'needs_inspection'; clause: string; reason: string };
  summary: string;
}

export interface RunMeta {
  mode: 'live' | 'replay';
  model?: string;
  duration_ms?: number;
  cost_usd?: number;
  num_turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  model_runs: number;
  served_from_store: boolean;
  guardrails?: string[];
  source?: { kind: string; recorded_at?: string; model?: string };
}

export interface ClaimDetail {
  claim: ClaimSummary;
  odometer_km: number;
  trace_id: string;
  vehicle: { sale_date: string; firmware: string | null };
  triage: { result: TriageResult; run: RunMeta; created_at: string } | null;
  decision: { decision: 'approved' | 'rejected'; final: TriageResult | null; edits: { field: string; from: unknown; to: unknown }[]; note: string | null; decided_by: string; decided_at: string } | null;
  job: { id: string; status: string; attempts: number; max_attempts: number; last_error: string | null; dead_reason: string | null; next_run_at: string } | null;
  attempts: { n: number; started_at: string; ended_at: string | null; outcome: string | null; error: string | null; served_from_store: boolean | null }[];
}

export type SpanKind = 'event' | 'job' | 'attempt' | 'tool' | 'note' | 'breaker' | 'dedup' | 'drill' | 'decision';

export interface Span {
  id: number;
  claim_id: string;
  trace_id: string;
  kind: SpanKind;
  name: string;
  started_at: string;
  duration_ms: number | null;
  attempt: number | null;
  status: 'ok' | 'error' | 'info';
  attrs: Record<string, unknown>;
}

export interface Health {
  api: string;
  triage_service: { state: string; mode: 'live' | 'replay' | null; model: string | null; restart_in_ms: number | null; model_runs: { live_today: number; today: number; total: number } | null };
  circuit: { state: 'closed' | 'open' | 'half_open'; consecutive_failures: number };
  queue: { queued: number; running: number; in_flight: number };
  dead_letters: number;
  claims: number;
}

export interface DemoKey {
  id: string;
  label: string;
  role: 'dealer' | 'engineer' | 'console';
  scopes: string[];
  dealer_id: number | null;
  value: string;
}

export interface Scenario {
  id: string;
  title: string;
  complaint: string;
  vehicle: { vin: string; model: string; sale_months_ago: number; odometer_km: number };
  rows: number;
}

export interface DemoConfig {
  synthetic_data: boolean;
  keys: DemoKey[];
  scenarios: Scenario[];
}
