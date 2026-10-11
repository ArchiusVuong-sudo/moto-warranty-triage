import { rmSync } from 'node:fs';

export default function teardown(): void {
  const db = process.env.MWT_E2E_DB;
  if (!db) return;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${db}${suffix}`, { force: true });
}
