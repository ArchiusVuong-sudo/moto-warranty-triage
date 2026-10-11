import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DbService } from './db.service.js';

export class MigrationChecksumError extends Error {}

/** Plain SQL migrations in name order, each in its own transaction, with a checksum so an edited migration is caught. */
export async function runMigrations(db: Pick<DbService, 'query' | 'exec' | 'transaction'>, dir: string): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const { rows } = await db.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
  const done = new Map(rows.map((r) => [r.version, r.checksum]));
  const applied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prior = done.get(file);
    if (prior) {
      if (prior !== checksum) throw new MigrationChecksumError(`migration ${file} changed after it was applied`);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
    });
    applied.push(file);
  }
  return applied;
}
