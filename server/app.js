// FLO Print — backend core. Framework-free: handle({method,path,query,headers,body,ip}) -> response.
// Used by the Vercel function (api/[...path].js), the local dev server and the tests.
import crypto from 'node:crypto';
import { Problem, uid, sha256, randomToken, hashPassword, verifyPassword, signSession, readSession, parseCookies, clip } from './util.js';
import { parsePages, fileKind, fmtBytes, NOT_SUPPORTED } from '../shared/pages.js';

export const CHUNK_SIZE = 2 * 1024 * 1024;
export const DEFAULTS = {
  max_file_mb: 20, max_files: 10, max_copies: 50, max_pages: 300,
  retry_max: 5, retry_delay_s: 30, retention_hours: 24, failed_retention_hours: 72,
};
const ONLINE_MS = 90_000;
const LEASE_MS = 5 * 60_000;
const SESSION_MS = 7 * 24 * 3600_000;
const STATUSES = ['UPLOADING', 'QUEUED', 'CLAIMED', 'PRINTING', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED', 'NEEDS_REVIEW'];
const ACTIVE = ['UPLOADING', 'QUEUED', 'CLAIMED', 'PRINTING', 'NEEDS_REVIEW'];

const JOB_SELECT = `SELECT j.*, p.name AS printer_name, p.online AS printer_online, p.updated AS printer_updated,
  a.last_seen AS agent_seen, a.enabled AS agent_enabled, u.name AS user_name,
  (SELECT COUNT(*) FROM jobs q WHERE q.printer_id = j.printer_id AND q.seq < j.seq
     AND q.status IN ('QUEUED','CLAIMED','PRINTING','NEEDS_REVIEW')) AS ahead
  FROM jobs j JOIN printers p ON p.id = j.printer_id LEFT JOIN agents a ON a.id = p.agent_id JOIN users u ON u.id = j.user_id`;

const PRINTER_SELECT = `SELECT p.*, a.name AS agent_name, a.last_seen AS agent_seen, a.enabled AS agent_enabled
  FROM printers p LEFT JOIN agents a ON a.id = p.agent_id`;

export function createApp({ db, env = {}, now = Date.now }) {
  const secret = String(env.SESSION_SECRET || '');
  let ready = null;
  let lastSweep = 0;

  const q = (sql, params = []) => db.run(sql, params);
  const one = async (sql, params = []) => (await db.run(sql, params)).rows[0] || null;
  const all = async (sql, params = []) => (await db.run(sql, params)).rows;
  const json = (status, body, extra = {}) => ({ status, json: body, ...extra });

  async function getConfig() {
    const r = await one('SELECT value FROM config WHERE id=$1', ['settings']);
    let saved = {};
    try { saved = JSON.parse(r?.value || '{}'); } catch { /* ignore corrupt settings */ }
    return { ...DEFAULTS, ...saved };
  }

  const event = (jobId, actor, type, detail = '') =>
    q('INSERT INTO events(job_id,actor,event,detail,at) VALUES($1,$2,$3,$4,$5)', [jobId, clip(actor, 80), type, clip(detail, 500), now()]);

  async function ensureReady() {
    ready ??= (async () => {
      await db.exec(db.schema);
      const t = now();
      await q('INSERT INTO printers(id,name,windows_name,enabled,created) VALUES($1,$2,$3,1,$4) ON CONFLICT(id) DO NOTHING',
        ['epson-l6270', 'Epson L6270', 'EPSON L6270 Series', t]);
      const c = await one('SELECT COUNT(*) AS c FROM users');
      if (c.c === 0 && env.ADMIN_PASSWORD) {
        await q('INSERT INTO users(id,username,name,role,pass_hash,created) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(username) DO NOTHING',
          [uid(), String(env.ADMIN_USERNAME || 'admin').toLowerCase(), 'Administrator', 'admin', hashPassword(String(env.ADMIN_PASSWORD)), t]);
      }
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  // ---------- security helpers ----------
  const cookie = (value, maxAgeSec) =>
    `flo_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${env.INSECURE_COOKIES === '1' ? '' : '; Secure'}`;

  function csrf(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers['x-requested-with'] !== 'flo-print') throw new Problem(403, 'Request verification failed. Reload the page and try again.');
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { throw new Problem(403, 'Cross-site request rejected.'); }
      const allowed = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).host : req.headers.host;
      if (host !== allowed) throw new Problem(403, 'Cross-site request rejected.');
    }
  }

  async function authUser(req) {
    const s = readSession(parseCookies(req.headers.cookie).flo_session, secret, now());
    if (!s) throw new Problem(401, 'Please sign in.');
    const u = await one('SELECT id,username,name,role,active FROM users WHERE id=$1', [s.u]);
    if (!u || !u.active) throw new Problem(401, 'Please sign in.');
    return u;
  }

  async function authAgent(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token.length < 32) throw new Problem(401, 'Agent authentication required.');
    const a = await one('SELECT * FROM agents WHERE token_hash=$1 AND enabled=1', [sha256(token)]);
    if (!a) throw new Problem(403, 'This agent is not authorised.');
    await q('UPDATE agents SET last_seen=$1 WHERE id=$2', [now(), a.id]);
    return a;
  }

  async function rateLimit(key, max, period, amount = 1) {
    const bucket = Math.floor(now() / period);
    const r = await one(
      'INSERT INTO counters(key,count,expires) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET count=counters.count+$2 RETURNING count',
      [`${key}:${bucket}`, amount, (bucket + 2) * period]);
    if (r.count > max) throw new Problem(429, 'Too many requests. Please wait a little and try again.');
  }

  // ---------- shaping ----------
  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, ...(u.active !== undefined ? { active: !!u.active } : {}) });

  function printerShape(p, admin) {
    const agentOnline = !!p.agent_id && p.agent_enabled === 1 && p.agent_seen > now() - ONLINE_MS;
    return {
      id: p.id, name: p.name, enabled: !!p.enabled, online: agentOnline && !!p.online, agent_online: agentOnline,
      color: !!p.color, seen: p.updated > 0, note: p.status_note || '',
      ...(admin ? { windows_name: p.windows_name, agent_id: p.agent_id, agent_name: p.agent_name || null } : {}),
    };
  }

  function publicJob(j) {
    const agentOnline = j.agent_enabled === 1 && j.agent_seen > now() - ONLINE_MS;
    const position = j.ahead + 1;
    let status = j.status;
    let message;
    switch (j.status) {
      case 'UPLOADING': message = 'Uploading file…'; break;
      case 'QUEUED':
        if (!agentOnline) { status = 'WAITING_FOR_AGENT'; message = 'Queued. The printer PC is offline right now. It will print as soon as it is back.'; }
        else if (!j.printer_online) message = 'Queued. The printer is currently unavailable.';
        else if (j.retry_count > 0) message = `Waiting to retry (attempt ${j.retry_count + 1}).`;
        else message = `In the queue. Position ${position}. It will print when earlier jobs are done.`;
        break;
      case 'CLAIMED': message = 'Preparing to print.'; break;
      case 'PRINTING': message = 'Printing in progress.'; break;
      case 'COMPLETED': message = 'Print completed.'; break;
      case 'FAILED': message = `Print failed. Reason: ${j.error || 'unknown'}`; break;
      case 'REJECTED': message = `Rejected. Reason: ${j.error || 'unknown'}`; break;
      case 'CANCELLED': message = 'Cancelled.'; break;
      case 'NEEDS_REVIEW': message = 'Result uncertain. Check the printer, then ask an admin to confirm.'; break;
      default: message = '';
    }
    return {
      id: j.id, filename: j.filename, file_type: j.file_type, bytes: j.bytes, printer: j.printer_name, printer_id: j.printer_id,
      copies: j.copies, color: j.color, orientation: j.orientation, pages: j.pages, status, raw_status: j.status,
      queue_position: j.status === 'QUEUED' ? position : null, error: j.error, evidence: j.evidence, page_count: j.page_count,
      created: j.created, started: j.started, completed: j.completed, user: j.user_name, retry_count: j.retry_count,
      parent_id: j.parent_id, can_requeue: !!j.has_file && ['FAILED', 'CANCELLED', 'COMPLETED'].includes(j.status), message,
    };
  }

  async function ownedJob(id, user) {
    const j = await one(`${JOB_SELECT} WHERE j.id=$1`, [id]);
    if (!j || (user.role !== 'admin' && j.user_id !== user.id)) throw new Problem(404, 'Job not found.');
    return j;
  }

  // ---------- maintenance ----------
  async function sweep(force = false) {
    const t = now();
    if (!force && t - lastSweep < 30_000) return;
    lastSweep = t;
    const cfg = await getConfig();
    const stale = await all("SELECT id FROM jobs WHERE status='UPLOADING' AND created<$1", [t - 2 * 3600_000]);
    for (const j of stale) {
      await q("UPDATE jobs SET status='FAILED', error='Upload was not completed.', completed=$2 WHERE id=$1 AND status='UPLOADING'", [j.id, t]);
      await q('DELETE FROM job_chunks WHERE job_id=$1', [j.id]);
    }
    await q("UPDATE jobs SET status='QUEUED', claim_id=NULL WHERE status='CLAIMED' AND claim_until<$1", [t]);
    await q(`UPDATE jobs SET status='NEEDS_REVIEW', error='The printer PC stopped responding while printing. Check the printer output.'
             WHERE status='PRINTING' AND printer_id IN (SELECT p.id FROM printers p JOIN agents a ON a.id=p.agent_id WHERE a.last_seen<$1)`, [t - 10 * 60_000]);
    const groups = [["('COMPLETED','CANCELLED')", t - cfg.retention_hours * 3600_000], ["('FAILED','REJECTED')", t - cfg.failed_retention_hours * 3600_000]];
    for (const [statuses, cutoff] of groups) {
      await q(`DELETE FROM job_chunks WHERE job_id IN (SELECT id FROM jobs WHERE has_file=1 AND status IN ${statuses} AND completed<$1)`, [cutoff]);
      await q(`UPDATE jobs SET has_file=0 WHERE has_file=1 AND status IN ${statuses} AND completed<$1`, [cutoff]);
    }
    await q('DELETE FROM counters WHERE expires<$1', [t]);
  }

  // ---------- auth routes ----------
  async function login({ req, body }) {
    const username = clip(body.username, 60).toLowerCase();
    const password = String(body.password || '');
    const key = `login:${req.ip || '?'}:${username}`;
    const f = await one('SELECT count FROM counters WHERE key=$1 AND expires>$2', [key, now()]);
    if (f && f.count >= 8) throw new Problem(429, 'Too many failed attempts. Try again in 15 minutes.');
    const u = username ? await one('SELECT * FROM users WHERE username=$1', [username]) : null;
    if (!u || !u.active || !verifyPassword(password, u.pass_hash)) {
      await q(`INSERT INTO counters(key,count,expires) VALUES($1,1,$2)
               ON CONFLICT(key) DO UPDATE SET count=CASE WHEN counters.expires>$3 THEN counters.count+1 ELSE 1 END,
               expires=CASE WHEN counters.expires>$3 THEN counters.expires ELSE CAST($2 AS BIGINT) END`,
        [key, now() + 15 * 60_000, now()]);
      const n = await one('SELECT COUNT(*) AS c FROM users');
      if (n.c === 0) throw new Problem(503, 'No users exist yet. Set ADMIN_PASSWORD in the Vercel environment variables and redeploy.');
      throw new Problem(401, 'Wrong username or password.');
    }
    const token = signSession({ u: u.id, exp: now() + SESSION_MS }, secret);
    return json(200, { user: publicUser(u) }, { cookie: cookie(token, SESSION_MS / 1000) });
  }

  const logout = async () => json(200, { ok: true }, { cookie: cookie('', 0) });

  async function me({ user }) {
    const cfg = await getConfig();
    return json(200, {
      user: publicUser(user), chunk_size: CHUNK_SIZE, server_time: now(),
      config: { max_file_mb: cfg.max_file_mb, max_files: cfg.max_files, max_copies: cfg.max_copies, max_pages: cfg.max_pages },
    });
  }

  // ---------- printers ----------
  async function printersList({ user }) {
    const rows = await all(`${PRINTER_SELECT} ${user.role === 'admin' ? '' : 'WHERE p.enabled=1'} ORDER BY p.created`);
    return json(200, { printers: rows.map((p) => printerShape(p, user.role === 'admin')) });
  }

  // ---------- jobs ----------
  async function jobsStart({ user, body }) {
    const cfg = await getConfig();
    const key = String(body.key || '');
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new Problem(400, 'Missing request key. Reload the page and try again.');
    const printer = await one('SELECT * FROM printers WHERE id=$1 AND enabled=1', [String(body.printer_id || '')]);
    if (!printer) throw new Problem(400, 'Choose an available printer.');
    const copies = Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > cfg.max_copies) throw new Problem(400, `Copies must be between 1 and ${cfg.max_copies}.`);
    if (!['bw', 'color'].includes(body.color)) throw new Problem(400, 'Choose Black & White or Colour.');
    if (!['portrait', 'landscape'].includes(body.orientation)) throw new Problem(400, 'Choose Portrait or Landscape.');
    if (body.color === 'color' && printer.updated > 0 && !printer.color) throw new Problem(400, 'This printer does not support colour. Choose Black & White.');
    const pg = parsePages(body.pages, cfg.max_pages);
    if (!pg.ok) throw new Problem(400, pg.error);
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length < 1) throw new Problem(400, 'Add at least one file.');
    if (files.length > cfg.max_files) throw new Problem(400, `You can print up to ${cfg.max_files} files at a time.`);
    await rateLimit(`start:${user.id}`, 200, 3600_000, files.length);

    const t = now();
    const jobs = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i] || {};
      const name = clip(String(f.name || 'file').split(/[\\/]/).pop(), 200) || 'file';
      const size = Number(f.size);
      const kind = fileKind(name);
      let reject = null;
      if (!kind) reject = NOT_SUPPORTED;
      else if (!Number.isInteger(size) || size <= 0) reject = 'The file is empty.';
      else if (size > cfg.max_file_mb * 1048576) reject = `The file is larger than the ${cfg.max_file_mb} MB limit.`;
      const id = uid();
      const idem = `${user.id}:${key}:${i}`;
      const ins = await q(
        `INSERT INTO jobs(id,idem,user_id,filename,file_type,bytes,total_chunks,printer_id,copies,color,orientation,pages,status,error,created,completed)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(idem) DO NOTHING`,
        [id, idem, user.id, name, kind, reject ? 0 : size, reject ? 0 : Math.ceil(size / CHUNK_SIZE), printer.id, copies, body.color,
          body.orientation, pg.value, reject ? 'REJECTED' : 'UPLOADING', reject, t, reject ? t : null]);
      if (ins.count === 1) await event(id, user.name, reject ? 'rejected' : 'created', reject || `${name} (${fmtBytes(size)})`);
      const job = await one(`${JOB_SELECT} WHERE j.idem=$1`, [idem]);
      jobs.push({ ...publicJob(job), chunk_size: CHUNK_SIZE, total_chunks: job.total_chunks });
    }
    return json(200, { jobs });
  }

  async function chunkUpload({ user, params, body }) {
    const job = await ownedJob(params.id, user);
    if (job.status !== 'UPLOADING') throw new Problem(409, 'This file is not accepting uploads.');
    const n = Number(params.n);
    if (!Number.isInteger(n) || n < 0 || n >= job.total_chunks) throw new Problem(400, 'Invalid part number.');
    const b64 = String(body.data || '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Problem(400, 'Invalid upload data.');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0 || buf.length > CHUNK_SIZE || (n < job.total_chunks - 1 && buf.length !== CHUNK_SIZE)) throw new Problem(400, 'Unexpected part size.');
    await q('INSERT INTO job_chunks(job_id,n,data) VALUES($1,$2,$3) ON CONFLICT(job_id,n) DO UPDATE SET data=excluded.data', [job.id, n, buf]);
    return json(200, { ok: true, n });
  }

  async function rejectUpload(job, reason, actor) {
    await q("UPDATE jobs SET status='REJECTED', error=$2, completed=$3 WHERE id=$1 AND status='UPLOADING'", [job.id, reason, now()]);
    await q('DELETE FROM job_chunks WHERE job_id=$1', [job.id]);
    await event(job.id, actor, 'rejected', reason);
    return json(200, { job: publicJob(await one(`${JOB_SELECT} WHERE j.id=$1`, [job.id])) });
  }

  async function jobFinish({ user, params }) {
    const job = await ownedJob(params.id, user);
    if (job.status !== 'UPLOADING') return json(200, { job: publicJob(job) }); // idempotent
    const rows = await all('SELECT n,data FROM job_chunks WHERE job_id=$1 ORDER BY n', [job.id]);
    if (rows.length !== job.total_chunks || rows.some((r, i) => r.n !== i)) throw new Problem(409, 'Upload is incomplete. Some parts are missing.');
    const bufs = rows.map((r) => Buffer.from(r.data));
    if (bufs.reduce((s, b) => s + b.length, 0) !== job.bytes) return rejectUpload(job, 'Upload size did not match the file.', user.name);
    const head = bufs[0];
    const okSig = job.file_type === 'pdf' ? head.subarray(0, 5).toString('latin1') === '%PDF-' : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    if (!okSig) return rejectUpload(job, `The file content is not a real ${job.file_type === 'pdf' ? 'PDF' : 'JPEG'}.`, user.name);
    const h = crypto.createHash('sha256');
    bufs.forEach((b) => h.update(b));
    const r = await q("UPDATE jobs SET status='QUEUED', sha256=$2, has_file=1, queued_at=$3 WHERE id=$1 AND status='UPLOADING'", [job.id, h.digest('hex'), now()]);
    if (r.count === 1) await event(job.id, user.name, 'queued', 'Added to the print queue');
    return json(200, { job: publicJob(await one(`${JOB_SELECT} WHERE j.id=$1`, [job.id])) });
  }

  async function jobsList({ user, query }) {
    await sweep();
    const where = [];
    const params = [];
    const mine = user.role !== 'admin' || query.scope !== 'all';
    if (mine) { params.push(user.id); where.push(`j.user_id=$${params.length}`); }
    const s = String(query.status || '');
    if (s === 'active') where.push(`j.status IN (${ACTIVE.map((x) => `'${x}'`).join(',')})`);
    else if (STATUSES.includes(s)) { params.push(s); where.push(`j.status=$${params.length}`); }
    if (query.q) { params.push(`%${String(query.q).toLowerCase().slice(0, 80)}%`); where.push(`LOWER(j.filename) LIKE $${params.length}`); }
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
    const rows = await all(`${JOB_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY j.seq DESC LIMIT ${limit}`, params);
    const cparams = mine ? [user.id] : [];
    const counts = await all(`SELECT status, COUNT(*) AS c FROM jobs ${mine ? 'WHERE user_id=$1' : ''} GROUP BY status`, cparams);
    return json(200, { jobs: rows.map(publicJob), counts: Object.fromEntries(counts.map((r) => [r.status, r.c])) });
  }

  async function jobDetail({ user, params }) {
    const job = await ownedJob(params.id, user);
    const events = await all('SELECT actor,event,detail,at FROM events WHERE job_id=$1 ORDER BY id', [job.id]);
    return json(200, { job: publicJob(job), events });
  }

  async function jobCancel({ user, params }) {
    const job = await ownedJob(params.id, user);
    const r = await q("UPDATE jobs SET status='CANCELLED', error=NULL, completed=$2 WHERE id=$1 AND status IN ('UPLOADING','QUEUED')", [job.id, now()]);
    if (r.count !== 1) throw new Problem(409, 'This job can no longer be cancelled. It is already being printed or finished.');
    await event(job.id, user.name, 'cancelled', 'Cancelled before printing');
    return json(200, { job: publicJob(await one(`${JOB_SELECT} WHERE j.id=$1`, [job.id])) });
  }

  async function jobRequeue({ user, params, body }) {
    const src = await ownedJob(params.id, user);
    if (!src.has_file || !['FAILED', 'CANCELLED', 'COMPLETED'].includes(src.status)) throw new Problem(409, 'This file is no longer stored, so it cannot be printed again. Please upload it again.');
    const printer = await one('SELECT * FROM printers WHERE id=$1 AND enabled=1', [src.printer_id]);
    if (!printer) throw new Problem(409, 'That printer is disabled.');
    const cfg = await getConfig();
    const key = /^[A-Za-z0-9_-]{8,80}$/.test(String(body.key || '')) ? body.key : uid();
    const copies = body.copies === undefined ? src.copies : Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > cfg.max_copies) throw new Problem(400, `Copies must be between 1 and ${cfg.max_copies}.`);
    const idem = `rq:${user.id}:${key}`;
    const id = uid();
    const ins = await q(
      `INSERT INTO jobs(id,idem,user_id,filename,file_type,bytes,total_chunks,sha256,printer_id,copies,color,orientation,pages,status,parent_id,created)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'UPLOADING',$14,$15) ON CONFLICT(idem) DO NOTHING`,
      [id, idem, user.id, src.filename, src.file_type, src.bytes, src.total_chunks, src.sha256, src.printer_id, copies, src.color, src.orientation, src.pages, src.id, now()]);
    if (ins.count === 1) {
      await q('INSERT INTO job_chunks(job_id,n,data) SELECT CAST($1 AS TEXT), n, data FROM job_chunks WHERE job_id=$2', [id, src.id]);
      await q("UPDATE jobs SET status='QUEUED', has_file=1, queued_at=$2 WHERE id=$1 AND status='UPLOADING'", [id, now()]);
      await event(id, user.name, 'queued', `Printed again from ${src.id.slice(0, 8)}`);
    }
    return json(200, { job: publicJob(await one(`${JOB_SELECT} WHERE j.idem=$1`, [idem])) });
  }

  async function jobResolve({ user, params, body }) {
    const job = await ownedJob(params.id, user);
    if (job.status !== 'NEEDS_REVIEW') throw new Problem(409, 'This job is not waiting for review.');
    const printed = body.outcome === 'printed';
    if (!printed && body.outcome !== 'not-printed') throw new Problem(400, 'Choose printed or not-printed.');
    const r = await q("UPDATE jobs SET status=$2, error=$3, evidence=$4, completed=$5 WHERE id=$1 AND status='NEEDS_REVIEW'",
      [job.id, printed ? 'COMPLETED' : 'FAILED', printed ? null : 'Confirmed by admin: nothing was printed.', printed ? `Confirmed printed by ${user.name}` : null, now()]);
    if (r.count !== 1) throw new Problem(409, 'This job was already resolved.');
    await event(job.id, user.name, 'resolved', printed ? 'Marked as printed' : 'Marked as not printed');
    return json(200, { job: publicJob(await one(`${JOB_SELECT} WHERE j.id=$1`, [job.id])) });
  }

  // ---------- admin ----------
  async function adminPrinterAdd({ body }) {
    const name = clip(body.name, 80);
    const windowsName = clip(body.windows_name, 200);
    if (!name || !windowsName) throw new Problem(400, 'Enter a display name and the exact Windows printer name.');
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'printer'}-${randomToken(3)}`;
    await q('INSERT INTO printers(id,name,windows_name,enabled,created) VALUES($1,$2,$3,1,$4)', [id, name, windowsName, now()]);
    return json(200, { ok: true, id });
  }

  async function adminPrinterEdit({ params, body }) {
    const p = await one('SELECT * FROM printers WHERE id=$1', [params.id]);
    if (!p) throw new Problem(404, 'Printer not found.');
    const name = body.name === undefined ? p.name : clip(body.name, 80);
    const windowsName = body.windows_name === undefined ? p.windows_name : clip(body.windows_name, 200);
    if (!name || !windowsName) throw new Problem(400, 'Names cannot be empty.');
    const enabled = body.enabled === undefined ? p.enabled : body.enabled ? 1 : 0;
    const agentId = body.agent_id === undefined ? p.agent_id : body.agent_id || null;
    if (agentId && !(await one('SELECT id FROM agents WHERE id=$1', [agentId]))) throw new Problem(400, 'Unknown agent.');
    await q('UPDATE printers SET name=$2, windows_name=$3, enabled=$4, agent_id=$5 WHERE id=$1', [p.id, name, windowsName, enabled, agentId]);
    return json(200, { ok: true });
  }

  const agentShape = (a) => ({
    id: a.id, name: a.name, enabled: !!a.enabled, online: a.enabled === 1 && a.last_seen > now() - ONLINE_MS,
    last_seen: a.last_seen, installed: JSON.parse(a.installed || '[]'),
  });

  async function adminAgents() {
    return json(200, { agents: (await all('SELECT * FROM agents ORDER BY created')).map(agentShape) });
  }

  async function adminAgentAdd({ body }) {
    const name = clip(body.name, 80);
    if (!name) throw new Problem(400, 'Give the printer PC a name.');
    const token = `flo_${randomToken(24)}`;
    const id = uid();
    await q('INSERT INTO agents(id,name,token_hash,created) VALUES($1,$2,$3,$4)', [id, name, sha256(token), now()]);
    return json(200, { id, token });
  }

  async function adminAgentEdit({ params, body }) {
    const a = await one('SELECT * FROM agents WHERE id=$1', [params.id]);
    if (!a) throw new Problem(404, 'Agent not found.');
    let token = null;
    let hash = a.token_hash;
    if (body.rotate) { token = `flo_${randomToken(24)}`; hash = sha256(token); }
    await q('UPDATE agents SET name=$2, enabled=$3, token_hash=$4 WHERE id=$1',
      [a.id, body.name === undefined ? a.name : clip(body.name, 80) || a.name, body.enabled === undefined ? a.enabled : body.enabled ? 1 : 0, hash]);
    return json(200, { ok: true, token });
  }

  async function adminUsers() {
    return json(200, { users: (await all('SELECT id,username,name,role,active FROM users ORDER BY created')).map(publicUser) });
  }

  async function adminUserAdd({ body }) {
    const username = clip(body.username, 40).toLowerCase();
    const name = clip(body.name, 80);
    const password = String(body.password || '');
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Problem(400, 'Username: 3-40 letters, numbers, dot, dash or underscore.');
    if (!name) throw new Problem(400, 'Enter the person\'s name.');
    if (password.length < 8) throw new Problem(400, 'Password must be at least 8 characters.');
    if (!['admin', 'staff'].includes(body.role)) throw new Problem(400, 'Choose a role.');
    const r = await q('INSERT INTO users(id,username,name,role,pass_hash,created) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(username) DO NOTHING',
      [uid(), username, name, body.role, hashPassword(password), now()]);
    if (r.count !== 1) throw new Problem(409, 'That username is already taken.');
    return json(200, { ok: true });
  }

  async function adminUserEdit({ user, params, body }) {
    const u = await one('SELECT * FROM users WHERE id=$1', [params.id]);
    if (!u) throw new Problem(404, 'User not found.');
    const role = body.role === undefined ? u.role : body.role;
    const active = body.active === undefined ? u.active : body.active ? 1 : 0;
    if (!['admin', 'staff'].includes(role)) throw new Problem(400, 'Invalid role.');
    if (u.id === user.id && (role !== 'admin' || !active)) throw new Problem(400, 'You cannot remove your own admin access.');
    let hash = u.pass_hash;
    if (body.password !== undefined) {
      if (String(body.password).length < 8) throw new Problem(400, 'Password must be at least 8 characters.');
      hash = hashPassword(String(body.password));
    }
    await q('UPDATE users SET name=$2, role=$3, active=$4, pass_hash=$5 WHERE id=$1', [u.id, body.name === undefined ? u.name : clip(body.name, 80) || u.name, role, active, hash]);
    return json(200, { ok: true });
  }

  async function adminSettingsGet() { return json(200, { settings: await getConfig() }); }

  async function adminSettingsPut({ body }) {
    const limits = { max_file_mb: [1, 25], max_files: [1, 20], max_copies: [1, 200], max_pages: [1, 500], retry_max: [0, 5], retry_delay_s: [5, 600], retention_hours: [1, 168], failed_retention_hours: [1, 720] };
    const next = {};
    for (const [k, [lo, hi]] of Object.entries(limits)) {
      const v = Number(body[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Problem(400, `${k.replace(/_/g, ' ')} must be a whole number from ${lo} to ${hi}.`);
      next[k] = v;
    }
    await q('INSERT INTO config(id,value) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET value=excluded.value', ['settings', JSON.stringify(next)]);
    return json(200, { settings: next });
  }

  // ---------- agent protocol ----------
  async function agentJob(agent, id, claim, statuses) {
    const j = await one('SELECT j.*, p.agent_id AS p_agent FROM jobs j JOIN printers p ON p.id=j.printer_id WHERE j.id=$1', [id]);
    if (!j || j.p_agent !== agent.id) throw new Problem(404, 'Job not found.');
    if (!claim || j.claim_id !== claim) throw new Problem(409, 'Claim is no longer valid.');
    if (statuses && !statuses.includes(j.status)) throw new Problem(409, `Job is ${j.status}.`);
    return j;
  }

  async function agentHeartbeat({ agent, body }) {
    const t = now();
    const list = Array.isArray(body.printers) ? body.printers.slice(0, 20) : [];
    const installed = Array.isArray(body.installed) ? body.installed.slice(0, 60).map((x) => clip(x, 120)) : [];
    await q('UPDATE agents SET installed=$1 WHERE id=$2', [JSON.stringify(installed), agent.id]);
    await q('UPDATE printers SET online=0 WHERE agent_id=$1', [agent.id]);
    for (const p of list) {
      await q(`UPDATE printers SET online=$1, color=$2, status_note=$3, updated=$4, agent_id=COALESCE(agent_id,$5)
               WHERE windows_name=$6 AND (agent_id IS NULL OR agent_id=$5)`,
        [p.online ? 1 : 0, p.color ? 1 : 0, clip(p.note, 200) || null, t, agent.id, clip(p.name, 200)]);
    }
    await sweep();
    const expected = await all('SELECT windows_name FROM printers WHERE enabled=1 AND (agent_id IS NULL OR agent_id=$1)', [agent.id]);
    return json(200, { ok: true, server_time: t, expected: expected.map((r) => r.windows_name) });
  }

  async function agentClaim({ agent }) {
    await sweep();
    const cfg = await getConfig();
    const t = now();
    const cand = await one(
      `SELECT j.id FROM jobs j JOIN printers p ON p.id=j.printer_id
       WHERE j.status='QUEUED' AND j.retry_at<=$1 AND p.agent_id=$2 AND p.enabled=1
         AND NOT EXISTS (SELECT 1 FROM jobs b WHERE b.printer_id=j.printer_id AND b.status IN ('CLAIMED','PRINTING','NEEDS_REVIEW'))
       ORDER BY j.seq LIMIT 1`, [t, agent.id]);
    if (!cand) return json(200, { job: null });
    const claimId = randomToken(16);
    const r = await one(
      `UPDATE jobs SET status='CLAIMED', claim_id=$2, claim_until=$3
       WHERE id=$1 AND status='QUEUED'
         AND NOT EXISTS (SELECT 1 FROM jobs b WHERE b.printer_id=jobs.printer_id AND b.status IN ('CLAIMED','PRINTING','NEEDS_REVIEW'))
       RETURNING *`, [cand.id, claimId, t + LEASE_MS]);
    if (!r) return json(200, { job: null });
    const pr = await one('SELECT windows_name FROM printers WHERE id=$1', [r.printer_id]);
    await event(r.id, agent.name, 'claimed', 'Printer PC picked up the job');
    return json(200, {
      job: {
        id: r.id, filename: r.filename, file_type: r.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg', bytes: r.bytes, hash: r.sha256,
        total_chunks: r.total_chunks, printer: pr.windows_name, copies: r.copies, color: r.color, orientation: r.orientation, pages: r.pages,
        claim_id: claimId, config: { max_file_mb: cfg.max_file_mb, max_pages: cfg.max_pages, max_copies: cfg.max_copies },
      },
    });
  }

  async function agentFile({ agent, req, params, query }) {
    const job = await agentJob(agent, params.id, req.headers['x-claim-id'], ['CLAIMED', 'PRINTING']);
    const n = Number(query.part);
    if (!Number.isInteger(n) || n < 0 || n >= job.total_chunks) throw new Problem(400, 'Invalid part number.');
    const row = await one('SELECT data FROM job_chunks WHERE job_id=$1 AND n=$2', [job.id, n]);
    if (!row) throw new Problem(404, 'File part not found.');
    return { status: 200, buffer: Buffer.from(row.data), contentType: 'application/octet-stream' };
  }

  async function agentStart({ agent, req, params }) {
    const job = await agentJob(agent, params.id, req.headers['x-claim-id'], null);
    if (job.status === 'PRINTING') return json(200, { ok: true });
    if (job.status !== 'CLAIMED') throw new Problem(409, `Job is ${job.status}.`);
    const r = await q("UPDATE jobs SET status='PRINTING', started=$3, claim_until=$4 WHERE id=$1 AND claim_id=$2 AND status='CLAIMED'", [job.id, job.claim_id, now(), now() + LEASE_MS]);
    if (r.count !== 1) throw new Problem(409, 'Job state changed.');
    await event(job.id, agent.name, 'printing', 'Printing started');
    return json(200, { ok: true });
  }

  async function agentSpool({ agent, req, params, body }) {
    const job = await agentJob(agent, params.id, req.headers['x-claim-id'], ['CLAIMED', 'PRINTING']);
    const spool = Number(body.spool_id);
    if (Number.isInteger(spool)) await q('UPDATE jobs SET spool_id=$2 WHERE id=$1', [job.id, spool]);
    return json(200, { ok: true });
  }

  async function agentRetry({ agent, req, params, body }) {
    const job = await agentJob(agent, params.id, req.headers['x-claim-id'], ['CLAIMED']);
    const cfg = await getConfig();
    const reason = clip(body.error, 300) || 'Temporary printer problem';
    if (job.retry_count + 1 > cfg.retry_max) {
      await q("UPDATE jobs SET status='FAILED', error=$2, completed=$3 WHERE id=$1 AND status='CLAIMED'", [job.id, `${reason} (gave up after ${cfg.retry_max} retries)`, now()]);
      await event(job.id, agent.name, 'failed', reason);
    } else {
      await q("UPDATE jobs SET status='QUEUED', claim_id=NULL, retry_count=retry_count+1, retry_at=$2, error=$3 WHERE id=$1 AND status='CLAIMED'",
        [job.id, now() + cfg.retry_delay_s * 1000, reason]);
      await event(job.id, agent.name, 'retry', reason);
    }
    return json(200, { ok: true });
  }

  async function agentResult({ agent, req, params, body }) {
    const job = await agentJob(agent, params.id, req.headers['x-claim-id'], null);
    const status = String(body.status || '');
    if (!['COMPLETED', 'FAILED', 'NEEDS_REVIEW'].includes(status)) throw new Problem(400, 'Invalid result status.');
    if (job.status === status) return json(200, { ok: true }); // idempotent re-report
    if (!['CLAIMED', 'PRINTING'].includes(job.status)) throw new Problem(409, `Job is already ${job.status}.`);
    const pages = Number.isInteger(body.page_count) ? body.page_count : null;
    const r = await q(
      "UPDATE jobs SET status=$3, error=$4, evidence=$5, page_count=$6, completed=$7 WHERE id=$1 AND claim_id=$2 AND status IN ('CLAIMED','PRINTING')",
      [job.id, job.claim_id, status, status === 'COMPLETED' ? null : clip(body.error, 300) || 'Unknown error', clip(body.evidence, 400) || null, pages, status === 'NEEDS_REVIEW' ? null : now()]);
    if (r.count !== 1) throw new Problem(409, 'Job state changed.');
    await event(job.id, agent.name, status.toLowerCase(), status === 'COMPLETED' ? clip(body.evidence, 300) : clip(body.error, 300));
    return json(200, { ok: true });
  }

  // ---------- routing ----------
  const routes = [
    ['GET', '/health', 'public', async () => json(200, { ok: true, time: now() })],
    ['POST', '/login', 'public', login],
    ['POST', '/logout', 'public', logout],
    ['GET', '/me', 'user', me],
    ['GET', '/printers', 'user', printersList],
    ['POST', '/jobs/start', 'user', jobsStart],
    ['GET', '/jobs', 'user', jobsList],
    ['GET', '/jobs/:id', 'user', jobDetail],
    ['POST', '/jobs/:id/chunk/:n', 'user', chunkUpload],
    ['POST', '/jobs/:id/finish', 'user', jobFinish],
    ['POST', '/jobs/:id/cancel', 'user', jobCancel],
    ['POST', '/jobs/:id/requeue', 'user', jobRequeue],
    ['POST', '/jobs/:id/resolve', 'admin', jobResolve],
    ['POST', '/admin/printers', 'admin', adminPrinterAdd],
    ['PATCH', '/admin/printers/:id', 'admin', adminPrinterEdit],
    ['GET', '/admin/agents', 'admin', adminAgents],
    ['POST', '/admin/agents', 'admin', adminAgentAdd],
    ['PATCH', '/admin/agents/:id', 'admin', adminAgentEdit],
    ['GET', '/admin/users', 'admin', adminUsers],
    ['POST', '/admin/users', 'admin', adminUserAdd],
    ['PATCH', '/admin/users/:id', 'admin', adminUserEdit],
    ['GET', '/admin/settings', 'admin', adminSettingsGet],
    ['PUT', '/admin/settings', 'admin', adminSettingsPut],
    ['POST', '/agent/heartbeat', 'agent', agentHeartbeat],
    ['POST', '/agent/claim', 'agent', agentClaim],
    ['GET', '/agent/jobs/:id/file', 'agent', agentFile],
    ['POST', '/agent/jobs/:id/start', 'agent', agentStart],
    ['POST', '/agent/jobs/:id/spool', 'agent', agentSpool],
    ['POST', '/agent/jobs/:id/retry', 'agent', agentRetry],
    ['POST', '/agent/jobs/:id/result', 'agent', agentResult],
  ];

  function match(pattern, segs) {
    const p = pattern.split('/').filter(Boolean);
    if (p.length !== segs.length) return null;
    const params = {};
    for (let i = 0; i < p.length; i++) {
      if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (p[i] !== segs[i]) return null;
    }
    return params;
  }

  async function handle(req) {
    try {
      if (secret.length < 16) throw new Problem(500, 'Server is not configured: set SESSION_SECRET (16+ characters) in the environment.');
      req = { ...req, method: String(req.method || 'GET').toUpperCase(), headers: req.headers || {}, query: req.query || {} };
      await ensureReady();
      const segs = String(req.path || '').replace(/^\/api\/?/, '').split('/').filter(Boolean);
      let methodMismatch = false;
      for (const [method, pattern, auth, fn] of routes) {
        const params = match(pattern, segs);
        if (!params) continue;
        if (method !== req.method) { methodMismatch = true; continue; }
        const ctx = { req, params, query: req.query, body: req.body && typeof req.body === 'object' ? req.body : {} };
        if (auth === 'agent') ctx.agent = await authAgent(req);
        else {
          csrf(req);
          if (auth !== 'public') {
            ctx.user = await authUser(req);
            if (auth === 'admin' && ctx.user.role !== 'admin') throw new Problem(403, 'Administrator access required.');
          }
        }
        return await fn(ctx);
      }
      throw new Problem(methodMismatch ? 405 : 404, methodMismatch ? 'Method not allowed.' : 'Not found.');
    } catch (e) {
      if (e instanceof Problem) return json(e.status, { error: e.message });
      console.error('Unhandled error:', e);
      return json(500, { error: 'Unexpected server error. Please try again.' });
    }
  }

  return { handle, sweep, getConfig, db };
}
