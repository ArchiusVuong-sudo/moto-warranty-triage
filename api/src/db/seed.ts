import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { DEMO_KEYS, demoKeyValue, hashKey } from '../auth/api-keys.js';
import type { DbService } from './db.service.js';

const PREFIXES = ['Northgate', 'Ridgeway', 'Lakeside', 'Ironbark', 'Coastline', 'Redrock', 'Summit', 'Pinehill', 'Riverbend', 'Westfield'];
const SUFFIXES = ['Moto Works', 'Cycles', 'Motorsport', 'Trail Centre'];
const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
export const BIKE_MODELS = [
  { code: 'RMX', name: 'Ridgeback MX', kind: 'motocross' },
  { code: 'TEN', name: 'Talus EN', kind: 'enduro' },
  { code: 'KSM', name: 'Kestrel SM', kind: 'supermoto' },
];

export interface ScenarioDoc {
  id: string;
  title: string;
  complaint: string;
  vehicle: { vin: string; model: string; sale_months_ago: number; odometer_km: number };
  expected: { cause: string; decision: string; clause: string };
  ride_log: Record<string, unknown> & { rows: unknown[] };
}

export function loadScenarios(repoRoot: string): ScenarioDoc[] {
  const dir = join(repoRoot, 'data', 'scenarios');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ScenarioDoc);
}

export function dealerNames(): string[] {
  return SUFFIXES.flatMap((s) => PREFIXES.map((p) => `${p} ${s}`));
}

/** Synthetic data, generated in SQL from fixed hashes so every fresh database is identical. Returns false if already seeded. */
export async function seed(db: Pick<DbService, 'query' | 'transaction'>, config: AppConfig): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM dealers');
  if (rows[0].n > 0) return false;
  const n = config.seedClaims;
  const scenarios = loadScenarios(config.repoRoot);
  await db.transaction(async (tx) => {
    const names = dealerNames();
    for (let i = 0; i < names.length; i++) {
      await tx.query('INSERT INTO dealers (id, name, region) VALUES ($1, $2, $3)', [i + 1, names[i], REGIONS[i % REGIONS.length]]);
    }
    // 6,000 vehicles; VIN = DEMO + model code + year + serial.
    await tx.query(
      `INSERT INTO vehicles (vin, model, dealer_id, sale_date, odometer_km)
       SELECT 'DEMO' || (ARRAY['RMX','TEN','KSM'])[1 + v % 3] || (ARRAY['24','25'])[1 + v % 2] || lpad(v::text, 8, '0'),
              (ARRAY['Ridgeback MX','Talus EN','Kestrel SM'])[1 + v % 3],
              1 + v % 40,
              current_date - ((abs(hashtext('sale' || v)) % 900) + 20) * interval '1 day',
              500 + abs(hashtext('odo' || v)) % 24000
       FROM generate_series(1000, 6999) v`,
    );
    for (const s of scenarios) {
      await tx.query(
        `INSERT INTO vehicles (vin, model, dealer_id, sale_date, odometer_km)
         VALUES ($1, $2, 1, (now() - make_interval(days => round(30.44 * $3)::int))::date, $4)`,
        [s.vehicle.vin, s.vehicle.model, s.vehicle.sale_months_ago, s.vehicle.odometer_km],
      );
    }
    for (const k of DEMO_KEYS) {
      await tx.query(
        `INSERT INTO api_keys (id, label, key_hash, scopes, dealer_id, rate_capacity, rate_refill_per_sec)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [k.id, k.label, hashKey(config.keyPepper, demoKeyValue(config.demoKeySeed, k.id)), k.scopes, k.dealerId, k.rateCapacity, k.rateRefillPerSec],
      );
    }
    const causes = ['BATTERY_CELL_IMBALANCE', 'INVERTER_OVERCURRENT', 'COOLANT_PUMP_FAILURE', 'CHARGE_PORT_WATER_INGRESS', 'THROTTLE_CONNECTOR_INTERMITTENT', 'FIRMWARE_BELOW_MINIMUM', 'IMPACT_DAMAGE'];
    const complaints = scenarios.filter((s) => s.expected.decision !== 'dead_letter').map((s) => s.title);
    // 20,000 historical claims over 18 months, written straight into the write model and the read model.
    await tx.query(
      `CREATE TEMP TABLE seed_claims ON COMMIT DROP AS
       SELECT g,
              md5('claim-' || g)::uuid AS id,
              'WC-' || lpad(g::text, 6, '0') AS claim_number,
              1000 + (g * 7919) % 6000 AS v,
              date_trunc('minute', now()) - interval '540 days' + (g - 1) * (interval '540 days' / $1) + (abs(hashtext('t' || g)) % 600) * interval '1 second' AS filed_at,
              abs(hashtext('s' || g)) % 100 AS hs,
              abs(hashtext('c' || g)) % 7 AS hc,
              abs(hashtext('f' || g)) % 43 AS hf
       FROM generate_series(1, $1::int) g`,
      [n],
    );
    await tx.query(
      `INSERT INTO claims (id, claim_number, dealer_id, vin, complaint, odometer_km, status, filed_at, trace_id, version)
       SELECT s.id, s.claim_number, ve.dealer_id, ve.vin, ($1::text[])[1 + s.hc], ve.odometer_km,
              CASE WHEN s.filed_at > now() - interval '3 days' THEN (CASE WHEN s.hs < 70 THEN 'awaiting_review' ELSE 'approved' END)
                   WHEN s.hs < 78 THEN 'approved' WHEN s.hs < 97 THEN 'rejected' ELSE 'dead_lettered' END,
              s.filed_at, md5('trace-' || s.g), 3
       FROM seed_claims s
       JOIN vehicles ve ON ve.vin = 'DEMO' || (ARRAY['RMX','TEN','KSM'])[1 + s.v % 3] || (ARRAY['24','25'])[1 + s.v % 2] || lpad(s.v::text, 8, '0')`,
      [complaints],
    );
    await tx.query(
      `INSERT INTO claim_view (claim_id, claim_number, dealer_id, dealer_name, vin, model, complaint, status, filed_at, version,
                               root_cause_code, confidence, warranty_decision, historical)
       SELECT c.id, c.claim_number, c.dealer_id, d.name, c.vin, ve.model, c.complaint, c.status, c.filed_at, c.version,
              CASE WHEN c.status = 'dead_lettered' THEN NULL ELSE ($1::text[])[1 + s.hc] END,
              CASE WHEN c.status = 'dead_lettered' THEN NULL ELSE round((0.55 + s.hf / 100.0)::numeric, 2)::float8 END,
              CASE WHEN c.status = 'dead_lettered' THEN NULL
                   WHEN s.hc IN (3, 6) OR c.status = 'rejected' THEN 'not_covered'
                   WHEN s.hf < 4 THEN 'needs_inspection' ELSE 'covered' END,
              true
       FROM claims c JOIN seed_claims s ON s.id = c.id JOIN dealers d ON d.id = c.dealer_id JOIN vehicles ve ON ve.vin = c.vin`,
      [causes],
    );
    await tx.query(`SELECT setval('claim_number_seq', $1::bigint)`, [n]);
  });
  await db.query('ANALYZE');
  return true;
}
