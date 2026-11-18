import crypto from 'node:crypto';

export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const uid = () => crypto.randomUUID();
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [kind, saltHex, keyHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const mac = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function readSession(token, secret, nowMs) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(body, secret));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp && payload.exp > nowMs ? payload : null;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const clip = (value, n) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
