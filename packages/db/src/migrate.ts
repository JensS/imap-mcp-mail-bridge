import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbPool } from './index.js';

async function main() {
  const pool = createDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id serial PRIMARY KEY,
        filename text NOT NULL UNIQUE,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsDir = path.resolve(__dirname, '../migrations');
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const filename of files) {
      const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
      if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
      console.log(`Applied migration ${filename}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
