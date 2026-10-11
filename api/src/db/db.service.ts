import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runMigrations } from './migrator.js';
import { seed } from './seed.js';

/** The part of PGlite (or a transaction) the app uses. Pass `tx` down; never call the pool inside a transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
}
export type Tx = Transaction;

/**
 * PGlite: Postgres compiled to WASM, in-process. One connection, so queries and
 * transactions are serialized by its mutex. The SQL is plain Postgres
 * (FOR UPDATE SKIP LOCKED, partial indexes) and runs unchanged on a server.
 */
@Injectable()
export class DbService implements OnModuleInit, OnApplicationShutdown, Queryable {
  private readonly log = new Logger('Db');
  private pg!: PGlite;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    const memory = this.config.dbPath === 'memory://';
    if (!memory) mkdirSync(this.config.dbPath, { recursive: true });
    this.pg = await PGlite.create(memory ? undefined : this.config.dbPath);
    const applied = await runMigrations(this, join(this.config.repoRoot, 'api', 'migrations'));
    if (applied.length) this.log.log(`applied migrations: ${applied.join(', ')}`);
    const seeded = await seed(this, this.config);
    if (seeded) this.log.log(`seeded ${this.config.seedClaims} synthetic claims`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pg?.close();
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; affectedRows?: number }> {
    return this.pg.query<T>(sql, params);
  }

  exec(sql: string): Promise<unknown> {
    return this.pg.exec(sql);
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.pg.transaction(fn);
  }
}
