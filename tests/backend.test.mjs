import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp, CHUNK_SIZE } from '../server/app.js';
import { sqliteDb } from '../server/db-sqlite.js';
import { parsePages, fileKind } from '../shared/pages.js';

const HOUR = 3600_000;
function setup(extraEnv = {}) {
  const clock = { t: 1_800_000_000_000 };
  const app = createApp({
    db: sqliteDb(), now: () => clock.t,
    env: { SESSION_SECRET: 'test-secret-test-secret', ADMIN_PASSWORD: 'adminpass123', ...extraEnv },
  });
  return { app, clock };
}
function client(app) {
  let cookie = '';
  return async (method, path, body, extra = {}) => {
    const r = await app.handle({
      method, path: `/api${path}`, query: extra.query || {}, body, ip: extra.ip || '1.1.1.1',
      headers: { host: 'x.test', 'x-requested-with': 'flo-print', ...(cookie ? { cookie } : {}), ...(extra.headers || {}) },
    });
    if (r.cookie) { cookie = r.cookie.split(';')[0]; if (cookie.endsWith('=')) cookie = ''; }
    return r;
  };
}
async function adminSession(app) {
  const c = client(app);
  const r = await c('POST', '/login', { username: 'admin', password: 'adminpass123' });
  assert.equal(r.status, 200);
  return c;
}
async function newAgent(admin, name = 'Office PC') {
  const r = await admin('POST', '/admin/agents', { name });
  assert.equal(r.status, 200);
  const token = r.json.token;
  const agent = (path, body, claim, method = 'POST', query = {}) =>
    ({ method, path: `/api/agent${path}`, query, body, ip: '2.2.2.2', headers: { authorization: `Bearer ${token}`, ...(claim ? { 'x-claim-id': claim } : {}) } });
  return { token, agent };
}
const heartbeat = (app, ag, online = true) =>
  app.handle(ag.agent('/heartbeat', { printers: [{ name: 'EPSON L6270 Series', online, color: true, note: '' }], installed: ['EPSON L6270 Series'] }));
const pdf = (size) => Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(size - 9)]);
const jpeg = (size) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(size - 4)]);

async function submit(c, files, opts = {}) {
  const key = opts.key || crypto.randomUUID();
  const settings = { printer_id: 'epson-l6270', copies: 1, color: 'bw', orientation: 'portrait', pages: 'all', ...opts.settings };
  const r = await c('POST', '/jobs/start', { key, ...settings, files: files.map((f) => ({ name: f.name, size: f.buf.length })) });
  if (r.status !== 200) return { r, key };
  const jobs = [];
  for (let i = 0; i < r.json.jobs.length; i++) {
    const j = r.json.jobs[i];
    if (j.raw_status !== 'UPLOADING') { jobs.push(j); continue; }
    const buf = files[i].buf;
    for (let n = 0; n < j.total_chunks; n++) {
      const part = buf.subarray(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE);
      const up = await c('POST', `/jobs/${j.id}/chunk/${n}`, { data: part.toString('base64') });
      assert.equal(up.status, 200, JSON.stringify(up.json));
    }
    const fin = await c('POST', `/jobs/${j.id}/finish`, {});
    assert.equal(fin.status, 200, JSON.stringify(fin.json));
    jobs.push(fin.json.job);
  }
  return { r, jobs, key };
}

test('shared: page parsing and file kinds', () => {
  assert.deepEqual(parsePages('all').value, 'all');
  assert.equal(parsePages('1-3,5').value, '1,2,3,5');
  assert.equal(parsePages('5,3,3,1').value, '1,3,5');
  for (const bad of ['0', '3-1', 'a', '1,,2', '-2', '1-1000', '1.5']) assert.equal(parsePages(bad).ok, false, bad);
  assert.equal(fileKind('A.PDF'), 'pdf');
  assert.equal(fileKind('photo.JPEG'), 'jpeg');
  assert.equal(fileKind('x.png'), null);
  assert.equal(fileKind('noext'), null);
});

test('auth: sign-in, CSRF header, throttling, roles', async () => {
  const { app } = setup();
  const anon = client(app);
  assert.equal((await anon('GET', '/me')).status, 401);
  assert.equal((await anon('GET', '/printers')).status, 401);
  const noCsrf = await app.handle({ method: 'POST', path: '/api/login', headers: { host: 'x.test' }, body: { username: 'admin', password: 'adminpass123' } });
  assert.equal(noCsrf.status, 403);
  const cross = await anon('POST', '/login', { username: 'admin', password: 'adminpass123' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal((await anon('POST', '/login', { username: 'admin', password: 'wrong' })).status, 401);
  const admin = await adminSession(app);
  const me = await admin('GET', '/me');
  assert.equal(me.json.user.role, 'admin');
  // brute force lock
  const victim = client(app);
  for (let i = 0; i < 8; i++) await victim('POST', '/login', { username: 'admin', password: 'nope' }, { ip: '9.9.9.9' });
  assert.equal((await victim('POST', '/login', { username: 'admin', password: 'adminpass123' }, { ip: '9.9.9.9' })).status, 429);
  // logout clears the session
  await admin('POST', '/logout', {});
  assert.equal((await admin('GET', '/me')).status, 401);
});

test('server refuses to run without SESSION_SECRET', async () => {
  const app = createApp({ db: sqliteDb(), env: { ADMIN_PASSWORD: 'x' } });
  const r = await client(app)('GET', '/health');
  assert.equal(r.status, 500);
});

test('seed: Epson L6270 printer exists and staff cannot use admin routes', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  const list = await admin('GET', '/printers');
  assert.equal(list.json.printers.length, 1);
  assert.equal(list.json.printers[0].name, 'Epson L6270');
  assert.equal((await admin('POST', '/admin/users', { username: 'riya', name: 'Riya', password: 'password123', role: 'staff' })).status, 200);
  assert.equal((await admin('POST', '/admin/users', { username: 'riya', name: 'Riya', password: 'password123', role: 'staff' })).status, 409);
  const staff = client(app);
  assert.equal((await staff('POST', '/login', { username: 'riya', password: 'password123' })).status, 200);
  assert.equal((await staff('GET', '/admin/users')).status, 403);
  assert.equal((await staff('POST', '/admin/printers', { name: 'x', windows_name: 'y' })).status, 403);
  const staffPrinters = await staff('GET', '/printers');
  assert.equal(staffPrinters.json.printers[0].windows_name, undefined);
  const self = (await admin('GET', '/admin/users')).json.users.find((u) => u.username === 'admin');
  assert.equal((await admin('PATCH', `/admin/users/${self.id}`, { role: 'staff' })).status, 400);
});

test('upload flow: chunked PDF + JPEG, idempotent start, queue position', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  const big = pdf(CHUNK_SIZE * 2 + 1234); // 3 parts
  const small = jpeg(5000);
  const { r, jobs, key } = await submit(admin, [{ name: 'report.pdf', buf: big }, { name: 'photo.JPG', buf: small }]);
  assert.equal(r.json.jobs[0].total_chunks, 3);
  assert.deepEqual(jobs.map((j) => j.raw_status), ['QUEUED', 'QUEUED']);
  assert.deepEqual(jobs.map((j) => j.queue_position), [1, 2]);
  // replaying the same key returns the same jobs, creates nothing new
  const replay = await admin('POST', '/jobs/start', { key, printer_id: 'epson-l6270', copies: 1, color: 'bw', orientation: 'portrait', pages: 'all', files: [{ name: 'report.pdf', size: big.length }, { name: 'photo.JPG', size: small.length }] });
  assert.deepEqual(replay.json.jobs.map((j) => j.id), jobs.map((j) => j.id));
  assert.equal((await admin('GET', '/jobs')).json.jobs.length, 2);
  // finishing twice is harmless
  assert.equal((await admin('POST', `/jobs/${jobs[0].id}/finish`, {})).json.job.raw_status, 'QUEUED');
  const detail = await admin('GET', `/jobs/${jobs[0].id}`);
  assert.ok(detail.json.events.some((e) => e.event === 'queued'));
});

test('validation: unsupported type, fake PDF, oversize, bad settings, missing parts', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  const { jobs } = await submit(admin, [
    { name: 'pic.png', buf: jpeg(500) },
    { name: 'fake.pdf', buf: Buffer.from('this is not a pdf at all, just text') },
    { name: 'fake.jpg', buf: pdf(300) },
    { name: 'ok.pdf', buf: pdf(400) },
  ]);
  assert.deepEqual(jobs.map((j) => j.raw_status), ['REJECTED', 'REJECTED', 'REJECTED', 'QUEUED']);
  assert.match(jobs[0].error, /Not Supported/);
  assert.match(jobs[1].error, /not a real PDF/);
  const huge = await admin('POST', '/jobs/start', { key: 'bigfile-key-1', printer_id: 'epson-l6270', copies: 1, color: 'bw', orientation: 'portrait', pages: 'all', files: [{ name: 'huge.pdf', size: 50 * 1048576 }] });
  assert.equal(huge.json.jobs[0].raw_status, 'REJECTED');
  const base = { key: 'settings-key-1', printer_id: 'epson-l6270', copies: 1, color: 'bw', orientation: 'portrait', pages: 'all', files: [{ name: 'a.pdf', size: 100 }] };
  for (const bad of [{ copies: 0 }, { copies: 999 }, { color: 'rainbow' }, { orientation: 'diag' }, { pages: '3-1' }, { printer_id: 'nope' }, { key: 'short' }, { files: [] }]) {
    const r = await admin('POST', '/jobs/start', { ...base, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  // missing chunk -> finish refuses and job stays UPLOADING
  const start = await admin('POST', '/jobs/start', { ...base, key: 'partial-key-12', files: [{ name: 'p.pdf', size: CHUNK_SIZE + 10 }] });
  const id = start.json.jobs[0].id;
  await admin('POST', `/jobs/${id}/chunk/0`, { data: pdf(CHUNK_SIZE).toString('base64') });
  assert.equal((await admin('POST', `/jobs/${id}/finish`, {})).status, 409);
  assert.equal((await admin('POST', `/jobs/${id}/chunk/5`, { data: 'AAAA' })).status, 400);
  assert.equal((await admin('POST', `/jobs/${id}/chunk/0`, { data: 'not base64!!' })).status, 400);
});

test('privacy: staff only see their own jobs; admin can see all', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  for (const [u, n] of [['aman', 'Aman'], ['sita', 'Sita']]) await admin('POST', '/admin/users', { username: u, name: n, password: 'password123', role: 'staff' });
  const aman = client(app); await aman('POST', '/login', { username: 'aman', password: 'password123' });
  const sita = client(app); await sita('POST', '/login', { username: 'sita', password: 'password123' });
  const { jobs } = await submit(aman, [{ name: 'secret.pdf', buf: pdf(1000) }]);
  assert.equal((await sita('GET', '/jobs')).json.jobs.length, 0);
  assert.equal((await sita('GET', `/jobs/${jobs[0].id}`)).status, 404);
  assert.equal((await sita('POST', `/jobs/${jobs[0].id}/cancel`, {})).status, 404);
  assert.equal((await aman('GET', '/jobs')).json.jobs.length, 1);
  assert.equal((await admin('GET', '/jobs', null, { query: { scope: 'all' } })).json.jobs.length, 1);
  assert.equal((await admin('GET', '/jobs')).json.jobs.length, 0);
});

test('agent: heartbeat, FIFO claim, chunked download with hash, start, complete', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  const ag = await newAgent(admin);
  const a = pdf(CHUNK_SIZE + 500);
  const b = jpeg(2000);
  const { jobs } = await submit(admin, [{ name: 'first.pdf', buf: a }, { name: 'second.jpg', buf: b }], { settings: { copies: 3, color: 'color', orientation: 'landscape', pages: '1-2' } });
  assert.equal(jobs[0].status, 'WAITING_FOR_AGENT'); // nobody home yet
  assert.equal((await app.handle({ ...ag.agent('/claim', {}), headers: {} })).status, 401);
  assert.equal((await app.handle({ ...ag.agent('/claim', {}), headers: { authorization: 'Bearer ' + 'x'.repeat(40) } })).status, 403);
  const hb = await heartbeat(app, ag);
  assert.deepEqual(hb.json.expected, ['EPSON L6270 Series']);
  const printers = (await admin('GET', '/printers')).json.printers;
  assert.equal(printers[0].online, true);
  assert.equal((await admin('GET', '/jobs')).json.jobs.at(-1).status, 'QUEUED');

  const c1 = (await app.handle(ag.agent('/claim', {}))).json.job;
  assert.equal(c1.filename, 'first.pdf');
  assert.deepEqual([c1.copies, c1.color, c1.orientation, c1.pages, c1.printer, c1.file_type], [3, 'color', 'landscape', '1,2', 'EPSON L6270 Series', 'application/pdf']);
  assert.equal(c1.total_chunks, 2);
  // printer is busy -> nothing else is handed out
  assert.equal((await app.handle(ag.agent('/claim', {}))).json.job, null);
  // download all parts and verify integrity
  const parts = [];
  for (let n = 0; n < c1.total_chunks; n++) {
    const r = await app.handle(ag.agent(`/jobs/${c1.id}/file`, null, c1.claim_id, 'GET', { part: String(n) }));
    assert.equal(r.status, 200);
    parts.push(r.buffer);
  }
  const whole = Buffer.concat(parts);
  assert.ok(whole.equals(a));
  assert.equal(crypto.createHash('sha256').update(whole).digest('hex'), c1.hash);
  assert.equal((await app.handle(ag.agent(`/jobs/${c1.id}/file`, null, 'wrong-claim', 'GET', { part: '0' }))).status, 409);
  assert.equal((await app.handle(ag.agent(`/jobs/${c1.id}/file`, null, c1.claim_id, 'GET', { part: '9' }))).status, 400);

  assert.equal((await app.handle(ag.agent(`/jobs/${c1.id}/start`, {}, c1.claim_id))).status, 200);
  assert.equal((await app.handle(ag.agent(`/jobs/${c1.id}/start`, {}, c1.claim_id))).status, 200); // idempotent
  assert.equal((await app.handle(ag.agent(`/jobs/${c1.id}/spool`, { spool_id: 17 }, c1.claim_id))).status, 200);
  assert.equal((await admin('GET', `/jobs/${c1.id}`)).json.job.status, 'PRINTING');
  assert.equal((await app.handle(ag.agent('/claim', {}))).json.job, null); // still busy
  const done = await app.handle(ag.agent(`/jobs/${c1.id}/result`, { status: 'COMPLETED', evidence: 'Windows spooler reported printed', page_count: 4 }, c1.claim_id));
  assert.equal(done.status, 200);
  assert.equal((await app.handle(ag.agent(`/jobs/${c1.id}/result`, { status: 'COMPLETED' }, c1.claim_id))).status, 200); // re-report is fine
  assert.equal((await app.handle(ag.agent(`/jobs/${c1.id}/result`, { status: 'FAILED', error: 'x' }, c1.claim_id))).status, 409); // cannot flip a finished job
  const fin = (await admin('GET', `/jobs/${c1.id}`)).json.job;
  assert.deepEqual([fin.status, fin.page_count, fin.message], ['COMPLETED', 4, 'Print completed.']);

  const c2 = (await app.handle(ag.agent('/claim', {}))).json.job;
  assert.equal(c2.filename, 'second.jpg');
  assert.equal(c2.file_type, 'image/jpeg');
});

test('agent isolation: a different agent cannot touch the job', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  const one = await newAgent(admin, 'PC one');
  const two = await newAgent(admin, 'PC two');
  await heartbeat(app, one);
  await submit(admin, [{ name: 'a.pdf', buf: pdf(500) }]);
  assert.equal((await app.handle(two.agent('/claim', {}))).json.job, null);
  const job = (await app.handle(one.agent('/claim', {}))).json.job;
  assert.equal((await app.handle(two.agent(`/jobs/${job.id}/start`, {}, job.claim_id))).status, 404);
  // disabled agents are locked out
  const agents = (await admin('GET', '/admin/agents')).json.agents;
  await admin('PATCH', `/admin/agents/${agents[0].id}`, { enabled: false });
  assert.equal((await app.handle(one.agent('/claim', {}))).status, 403);
});

test('queue safety: expired lease re-queues, old claim is dead, no double claim', async () => {
  const { app, clock } = setup();
  const admin = await adminSession(app);
  const ag = await newAgent(admin);
  await heartbeat(app, ag);
  const { jobs } = await submit(admin, [{ name: 'a.pdf', buf: pdf(600) }]);
  const claim = (await app.handle(ag.agent('/claim', {}))).json.job;
  clock.t += 6 * 60_000; // agent died before starting
  await heartbeat(app, ag);
  await app.sweep(true);
  assert.equal((await admin('GET', `/jobs/${jobs[0].id}`)).json.job.raw_status, 'QUEUED');
  assert.equal((await app.handle(ag.agent(`/jobs/${claim.id}/start`, {}, claim.claim_id))).status, 409);
  const again = (await app.handle(ag.agent('/claim', {}))).json.job;
  assert.equal(again.id, claim.id);
  assert.notEqual(again.claim_id, claim.claim_id);
});

test('retry: temporary failure waits, then gives up after the limit', async () => {
  const { app, clock } = setup();
  const admin = await adminSession(app);
  await admin('PUT', '/admin/settings', { max_file_mb: 20, max_files: 10, max_copies: 50, max_pages: 300, retry_max: 1, retry_delay_s: 30, retention_hours: 24, failed_retention_hours: 72 });
  const ag = await newAgent(admin);
  await heartbeat(app, ag);
  const { jobs } = await submit(admin, [{ name: 'a.pdf', buf: pdf(600) }]);
  let claim = (await app.handle(ag.agent('/claim', {}))).json.job;
  await app.handle(ag.agent(`/jobs/${claim.id}/retry`, { error: 'Printer is paused' }, claim.claim_id));
  const waiting = (await admin('GET', `/jobs/${jobs[0].id}`)).json.job;
  assert.equal(waiting.raw_status, 'QUEUED');
  assert.match(waiting.message, /retry/i);
  assert.equal((await app.handle(ag.agent('/claim', {}))).json.job, null); // too early
  clock.t += 31_000;
  claim = (await app.handle(ag.agent('/claim', {}))).json.job;
  assert.ok(claim);
  await app.handle(ag.agent(`/jobs/${claim.id}/retry`, { error: 'Printer is paused' }, claim.claim_id));
  const failed = (await admin('GET', `/jobs/${jobs[0].id}`)).json.job;
  assert.equal(failed.raw_status, 'FAILED');
  assert.match(failed.error, /gave up/);
});

test('uncertain result blocks the queue until an admin resolves it', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  await admin('POST', '/admin/users', { username: 'aman', name: 'Aman', password: 'password123', role: 'staff' });
  const aman = client(app); await aman('POST', '/login', { username: 'aman', password: 'password123' });
  const ag = await newAgent(admin);
  await heartbeat(app, ag);
  const { jobs } = await submit(aman, [{ name: 'one.pdf', buf: pdf(500) }, { name: 'two.pdf', buf: pdf(500) }]);
  const c = (await app.handle(ag.agent('/claim', {}))).json.job;
  await app.handle(ag.agent(`/jobs/${c.id}/start`, {}, c.claim_id));
  await app.handle(ag.agent(`/jobs/${c.id}/result`, { status: 'NEEDS_REVIEW', error: 'Spooler timed out' }, c.claim_id));
  assert.equal((await app.handle(ag.agent('/claim', {}))).json.job, null); // never risk a double print
  assert.equal((await aman('POST', `/jobs/${jobs[0].id}/resolve`, { outcome: 'printed' })).status, 403);
  assert.equal((await admin('POST', `/jobs/${jobs[0].id}/resolve`, { outcome: 'maybe' })).status, 400);
  assert.equal((await admin('POST', `/jobs/${jobs[0].id}/resolve`, { outcome: 'not-printed' })).json.job.raw_status, 'FAILED');
  assert.equal((await admin('POST', `/jobs/${jobs[0].id}/resolve`, { outcome: 'printed' })).status, 409);
  assert.equal((await app.handle(ag.agent('/claim', {}))).json.job.filename, 'two.pdf');
});

test('agent that disappears mid-print marks the job for review', async () => {
  const { app, clock } = setup();
  const admin = await adminSession(app);
  const ag = await newAgent(admin);
  await heartbeat(app, ag);
  const { jobs } = await submit(admin, [{ name: 'one.pdf', buf: pdf(500) }]);
  const c = (await app.handle(ag.agent('/claim', {}))).json.job;
  await app.handle(ag.agent(`/jobs/${c.id}/start`, {}, c.claim_id));
  clock.t += 11 * 60_000;
  await app.sweep(true);
  assert.equal((await admin('GET', `/jobs/${jobs[0].id}`)).json.job.raw_status, 'NEEDS_REVIEW');
});

test('cancel, requeue ("print again") and retention', async () => {
  const { app, clock } = setup();
  const admin = await adminSession(app);
  const ag = await newAgent(admin);
  await heartbeat(app, ag);
  const data = pdf(CHUNK_SIZE + 99);
  const { jobs } = await submit(admin, [{ name: 'a.pdf', buf: data }, { name: 'b.pdf', buf: pdf(500) }], { settings: { copies: 2 } });
  assert.equal((await admin('POST', `/jobs/${jobs[1].id}/cancel`, {})).json.job.raw_status, 'CANCELLED');
  const c = (await app.handle(ag.agent('/claim', {}))).json.job;
  await app.handle(ag.agent(`/jobs/${c.id}/start`, {}, c.claim_id));
  assert.equal((await admin('POST', `/jobs/${c.id}/cancel`, {})).status, 409); // already printing
  assert.equal((await admin('POST', `/jobs/${c.id}/requeue`, {})).status, 409); // not finished yet
  await app.handle(ag.agent(`/jobs/${c.id}/result`, { status: 'COMPLETED', evidence: 'ok' }, c.claim_id));
  const rq = await admin('POST', `/jobs/${c.id}/requeue`, { key: 'again-key-001', copies: 5 });
  assert.equal(rq.status, 200);
  assert.equal(rq.json.job.copies, 5);
  assert.equal(rq.json.job.parent_id, c.id);
  const rq2 = await admin('POST', `/jobs/${c.id}/requeue`, { key: 'again-key-001', copies: 5 });
  assert.equal(rq2.json.job.id, rq.json.job.id); // idempotent
  const c2 = (await app.handle(ag.agent('/claim', {}))).json.job;
  const parts = [];
  for (let n = 0; n < c2.total_chunks; n++) parts.push((await app.handle(ag.agent(`/jobs/${c2.id}/file`, null, c2.claim_id, 'GET', { part: String(n) }))).buffer);
  assert.ok(Buffer.concat(parts).equals(data));
  assert.equal(c2.hash, c.hash);
  await app.handle(ag.agent(`/jobs/${c2.id}/result`, { status: 'FAILED', error: 'Printer driver rejected settings' }, c2.claim_id));
  // retention wipes stored files, then "print again" is refused politely
  clock.t += 25 * HOUR;
  await app.sweep(true);
  const old = (await admin('GET', `/jobs/${c.id}`)).json.job;
  assert.equal(old.can_requeue, false);
  assert.equal((await admin('POST', `/jobs/${c.id}/requeue`, {})).status, 409);
  const left = await app.db.run('SELECT COUNT(*) AS c FROM job_chunks WHERE job_id=$1', [c.id]);
  assert.equal(left.rows[0].c, 0);
  // failed jobs keep their file longer (72h default)
  assert.equal((await admin('GET', `/jobs/${c2.id}`)).json.job.can_requeue, true);
  clock.t += 50 * HOUR;
  await app.sweep(true);
  assert.equal((await admin('GET', `/jobs/${c2.id}`)).json.job.can_requeue, false);
});

test('abandoned uploads are cleaned up', async () => {
  const { app, clock } = setup();
  const admin = await adminSession(app);
  const r = await admin('POST', '/jobs/start', { key: 'abandon-key-1', printer_id: 'epson-l6270', copies: 1, color: 'bw', orientation: 'portrait', pages: 'all', files: [{ name: 'a.pdf', size: 100 }] });
  const id = r.json.jobs[0].id;
  await admin('POST', `/jobs/${id}/chunk/0`, { data: pdf(100).toString('base64') });
  clock.t += 3 * HOUR;
  await app.sweep(true);
  const j = (await admin('GET', `/jobs/${id}`)).json.job;
  assert.equal(j.raw_status, 'FAILED');
  assert.match(j.error, /not completed/);
});

test('admin: printers, settings validation, password reset', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  const add = await admin('POST', '/admin/printers', { name: 'HP LaserJet', windows_name: 'HP LaserJet 1020' });
  assert.equal(add.status, 200);
  assert.equal((await admin('POST', '/admin/printers', { name: '', windows_name: '' })).status, 400);
  assert.equal((await admin('PATCH', `/admin/printers/${add.json.id}`, { enabled: false })).status, 200);
  const staff = client(app);
  await admin('POST', '/admin/users', { username: 'riya', name: 'Riya', password: 'password123', role: 'staff' });
  assert.equal((await staff('POST', '/login', { username: 'riya', password: 'password123' })).status, 200);
  assert.equal((await staff('GET', '/printers')).json.printers.length, 1); // disabled printer hidden from staff
  assert.equal((await admin('GET', '/printers')).json.printers.length, 2);
  const users = (await admin('GET', '/admin/users')).json.users;
  const riya = users.find((u) => u.username === 'riya');
  assert.equal((await admin('PATCH', `/admin/users/${riya.id}`, { password: 'short' })).status, 400);
  assert.equal((await admin('PATCH', `/admin/users/${riya.id}`, { password: 'brandnewpass1' })).status, 200);
  assert.equal((await client(app)('POST', '/login', { username: 'riya', password: 'password123' })).status, 401);
  assert.equal((await client(app)('POST', '/login', { username: 'riya', password: 'brandnewpass1' })).status, 200);
  assert.equal((await admin('PATCH', `/admin/users/${riya.id}`, { active: false })).status, 200);
  assert.equal((await staff('GET', '/me')).status, 401); // disabled users are signed out immediately
  assert.equal((await admin('PUT', '/admin/settings', { max_file_mb: 0 })).status, 400);
  const rotate = await admin('PATCH', `/admin/agents/${(await admin('POST', '/admin/agents', { name: 'x' })).json.id}`, { rotate: true });
  assert.match(rotate.json.token, /^flo_[0-9a-f]{48}$/);
});

test('colour is refused when the agent reports a mono-only printer', async () => {
  const { app } = setup();
  const admin = await adminSession(app);
  const ag = await newAgent(admin);
  await app.handle(ag.agent('/heartbeat', { printers: [{ name: 'EPSON L6270 Series', online: true, color: false, note: '' }] }));
  const r = await admin('POST', '/jobs/start', { key: 'colour-key-12', printer_id: 'epson-l6270', copies: 1, color: 'color', orientation: 'portrait', pages: 'all', files: [{ name: 'a.pdf', size: 100 }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /colour/);
});
