// Vercel serverless entry: every /api/* request lands here and is handled by server/app.js.
import { getApp } from '../server/index.js';

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : null;
  if (raw === null) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 4_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString();
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const app = await getApp();
    const url = new URL(req.url, 'http://localhost');
    const body = ['GET', 'HEAD'].includes(req.method) ? null : await readJson(req);
    const out = await app.handle({
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body,
      ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '',
    });
    if (out.cookie) res.setHeader('Set-Cookie', out.cookie);
    if (out.buffer) {
      res.statusCode = out.status;
      res.setHeader('Content-Type', out.contentType || 'application/octet-stream');
      res.setHeader('Content-Length', out.buffer.length);
      return res.end(out.buffer);
    }
    res.statusCode = out.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(out.json));
  } catch (e) {
    console.error('API error:', e);
    res.statusCode = e.status || 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: e.status === 413 ? 'Request too large.' : 'Server error. Check DATABASE_URL and SESSION_SECRET in Vercel settings.' }));
  }
}
