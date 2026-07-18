import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createPool } from './postgres';
import { config } from '../config';

async function main(): Promise<void> {
  const pool = createPool(config.databaseUrl);
  const dir = path.join(__dirname, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[migrate] applying ${file}`);
    await pool.query(sql);
  }

  await pool.end();
  // eslint-disable-next-line no-console
  console.log('[migrate] done');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] failed', err);
  process.exit(1);
});
