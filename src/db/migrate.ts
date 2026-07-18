import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createPool } from './postgres';
import { config } from '../config';
import { logger } from '../logger';

async function main(): Promise<void> {
  const pool = createPool(config.databaseUrl);
  const dir = path.join(__dirname, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    logger.info(`Applying migration ${file}`);
    await pool.query(sql);
  }

  await pool.end();
  logger.info('Migrations complete');
}

main().catch((err) => {
  logger.error('Migration failed', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
