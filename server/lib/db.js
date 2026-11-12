// Accès PostgreSQL (Render Postgres) et migrations SQL versionnées (dossier migrations/).
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function createDb(url, { ssl = process.env.DATABASE_SSL === 'require' } = {}) {
  const pool = new pg.Pool({ connectionString: url, max: 5, ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
  pool.on('error', e => console.error(JSON.stringify({ level: 'error', msg: 'db.pool_error', error: e.message })));
  return {
    pool,
    query: (text, params) => pool.query(text, params),
    async tx(fn) {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    close: () => pool.end()
  };
}

export async function migrate(db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const files = (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(MIGRATIONS, f), 'utf8');
    await db.tx(async c => { await c.query(sql); await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]); });
  }
}
