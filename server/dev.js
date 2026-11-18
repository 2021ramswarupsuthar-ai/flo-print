// Local development API server (SQLite file, no Postgres needed):  npm run dev:api
import http from 'node:http';
import fs from 'node:fs';
import { createApp } from './app.js';
import { sqliteDb } from './db-sqlite.js';

const dbFile = process.env.DB_FILE || '.data/dev.db';
if (dbFile !== ':memory:') fs.mkdirSync('.data', { recursive: true });
const env = {
  SESSION_SECRET: process.env.SESSION_SECRET || 'local-dev-secret-change-me',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin12345',
  INSECURE_COOKIES: '1',
};
const app = createApp({ db: sqliteDb(dbFile), env });

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = null;
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { body = {}; }
  const url = new URL(req.url, 'http://localhost');
  const out = await app.handle({
    method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
    headers: req.headers, body, ip: req.socket.remoteAddress,
  });
  if (out.cookie) res.setHeader('Set-Cookie', out.cookie);
  res.statusCode = out.status;
  if (out.buffer) { res.setHeader('Content-Type', out.contentType); return res.end(out.buffer); }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out.json));
}).listen(Number(process.env.PORT) || 3001, () => console.log(`FLO Print dev API on :${process.env.PORT || 3001}  (login: ${env.ADMIN_USERNAME} / ${env.ADMIN_PASSWORD})`));
