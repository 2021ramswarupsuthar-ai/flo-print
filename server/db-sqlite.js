// SQLite adapter (node:sqlite) for local development and the automated tests.
import { DatabaseSync } from 'node:sqlite';
import { sqliteSchema } from './schema.js';

export function sqliteDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  return {
    dialect: 'sqlite',
    schema: sqliteSchema,
    async run(sql, params = []) {
      const q = sql.replace(/\$(\d+)/g, '?$1');
      const stmt = db.prepare(q);
      if (/^\s*(select|with)\b/i.test(q) || /\breturning\b/i.test(q)) {
        const rows = stmt.all(...params).map((r) => ({ ...r }));
        return { rows, count: rows.length };
      }
      const info = stmt.run(...params);
      return { rows: [], count: Number(info.changes) };
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}
