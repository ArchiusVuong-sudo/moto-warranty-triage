import { PGlite } from '@electric-sql/pglite';
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MigrationChecksumError, runMigrations } from '../src/db/migrator.js';

describe('SQL migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwt-migrations-'));
  cpSync(join(loadConfig({}).repoRoot, 'api', 'migrations'), dir, { recursive: true });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('applies each file once, records checksums and refuses an edited migration', async () => {
    const pg = await PGlite.create();
    const db = { query: pg.query.bind(pg), exec: pg.exec.bind(pg), transaction: pg.transaction.bind(pg) } as Parameters<typeof runMigrations>[0];
    expect(await runMigrations(db, dir)).toEqual(['001_core.sql', '002_events_jobs.sql', '003_read_model.sql']);
    expect(await runMigrations(db, dir)).toEqual([]);
    writeFileSync(join(dir, '004_extra.sql'), 'CREATE TABLE extra (id int);');
    expect(await runMigrations(db, dir)).toEqual(['004_extra.sql']);
    appendFileSync(join(dir, '001_core.sql'), '\n-- edited later\n');
    await expect(runMigrations(db, dir)).rejects.toBeInstanceOf(MigrationChecksumError);
    const { rows } = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
    expect(rows[0].n).toBe(4);
    await pg.close();
  });
});
