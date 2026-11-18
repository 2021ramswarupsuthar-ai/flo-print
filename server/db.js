// Production database adapter (Postgres). `run(sql, params)` returns { rows, count }; placeholders are $1, $2 ...
import { pgSchema } from './schema.js';

export async function pgDb(connectionString) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT / COUNT(*) -> number
  const pool = globalThis.__floPool ?? (globalThis.__floPool = new pg.Pool({ connectionString, max: 1, idleTimeoutMillis: 10_000 }));
  return {
    dialect: 'pg',
    schema: pgSchema,
    async run(sql, params = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows, count: r.rowCount ?? r.rows.length };
    },
    async exec(sql) {
      await pool.query(sql);
    },
  };
}
