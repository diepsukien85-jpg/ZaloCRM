import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Thiếu DATABASE_URL');
const reset = process.argv.includes('--reset');

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  if (reset) {
    if (process.env.NODE_ENV === 'production') throw new Error('Không được --reset ở production');
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('Đã reset schema (chỉ dev).');
  }
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = path.resolve(process.cwd(), 'db/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    console.log('Áp dụng', f);
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
  await client.end();
  console.log('Migration xong.');
}
main().catch((e) => { console.error(e); process.exit(1); });
