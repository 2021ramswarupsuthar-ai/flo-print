// Browser end-to-end test (Playwright + Chromium). Not part of `npm test` because it needs a browser.
// Usage: build the UI to a folder, then  node tests/e2e/run.mjs <distDir> <screenshotDir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createApp } from '../../server/app.js';
import { sqliteDb } from '../../server/db-sqlite.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || 'playwright');
const [dist = 'dist', shots = '/tmp/shots'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });

const app = createApp({ db: sqliteDb(), env: { SESSION_SECRET: 'e2e-secret-e2e-secret', ADMIN_PASSWORD: 'adminpass123', INSECURE_COOKIES: '1' } });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { /* */ }
    const out = await app.handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, ip: '127.0.0.1' });
    if (out.cookie) res.setHeader('Set-Cookie', out.cookie);
    res.statusCode = out.status;
    if (out.buffer) return res.end(out.buffer);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(out.json));
  }
  let file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// --- fake printer PC speaking the agent protocol ---
let agentToken;
async function agentCall(method, p, body, claim, query = {}) {
  return app.handle({ method, path: `/api/agent${p}`, query, body, headers: { authorization: `Bearer ${agentToken}`, ...(claim ? { 'x-claim-id': claim } : {}) }, ip: '9.9.9.9' });
}

const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });

  // 1. opening animation
  await page.goto(base);
  await page.waitForSelector('[data-testid=splash]');
  await page.waitForTimeout(700);  await page.screenshot({ path: `${shots}/01-splash-frame.png` });
  await page.waitForTimeout(1300); await page.screenshot({ path: `${shots}/02-splash-letters.png` });
  await page.waitForTimeout(1300); await page.screenshot({ path: `${shots}/03-splash-full.png` });
  const dash = await page.$eval('.logo-frame', (el) => getComputedStyle(el).strokeDashoffset);
  ok(parseFloat(dash) === 0, 'splash: logo frame finished drawing');
  await page.waitForSelector('[data-testid=splash]', { state: 'detached', timeout: 8000 });
  ok(true, 'splash: dismisses itself');
  await page.screenshot({ path: `${shots}/04-login.png` });

  // 2. login failures then success
  await page.fill('input[autocomplete=username]', 'admin');
  await page.fill('input[type=password]', 'wrong-password');
  await page.click('button:has-text("Sign in")');
  ok(await page.locator('.alert.bad').innerText().then((t) => /Wrong username/.test(t)), 'login: wrong password is rejected with a message');
  await page.fill('input[type=password]', 'adminpass123');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('text=Print settings');
  ok(true, 'login: admin signs in');

  // 3. create the printer PC connection first (admin -> Manage)
  await page.click('.tabs >> text=Manage');
  await page.click('.chip:has-text("Printer PCs")');
  await page.fill('input[placeholder="e.g. Office PC"]', 'Office PC');
  await page.click('button:has-text("Create connection key")');
  agentToken = (await page.locator('code.token').innerText()).trim();
  ok(/^flo_[0-9a-f]{48}$/.test(agentToken), 'manage: connection key is shown once');
  await page.screenshot({ path: `${shots}/05-manage-agents.png` });
  await agentCall('POST', '/heartbeat', { printers: [{ name: 'EPSON L6270 Series', online: true, color: true, note: '' }], installed: ['EPSON L6270 Series', 'Microsoft Print to PDF'] });
  await page.click('.chip:has-text("Printers")');
  await page.waitForSelector('text=Epson L6270');
  ok(await page.locator('text=Ready').first().isVisible(), 'manage: Epson L6270 listed and shows Ready');
  await page.screenshot({ path: `${shots}/06-manage-printers.png` });

  // 4. print page: unsupported file, then valid files
  await page.click('.tabs >> text=Print');
  const pdfBuf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(300_000)]);
  const jpgBuf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(50_000)]);
  const input = page.locator('[data-testid=file-input]');
  await input.setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: jpgBuf });
  ok(await page.locator('text=Not Supported').first().isVisible(), 'print: .png is shown as Not Supported');
  ok(await page.locator('button:has-text("Print")').last().isDisabled(), 'print: cannot submit with only an unsupported file');
  await input.setInputFiles([{ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: pdfBuf }, { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: jpgBuf }]);
  await page.click('button[aria-label="More copies"]');
  await page.click('button[role=radio]:has-text("Colour")');
  await page.click('button[role=radio]:has-text("Choose pages")');
  await page.fill('input[aria-label="Pages to print"]', '3-1');
  ok(await page.locator('text=must go from a lower').isVisible(), 'print: invalid page range explained');
  ok(await page.locator('button:has-text("Print 2 files")').isDisabled(), 'print: submit blocked while pages invalid');
  await page.fill('input[aria-label="Pages to print"]', '1-2');
  await page.screenshot({ path: `${shots}/07-print-form.png` });
  await page.click('button:has-text("Print 2 files")');
  await page.waitForSelector('text=Added to the print queue');
  ok(await page.locator('.jobrow').count() === 2, 'print: both files queued');
  await page.screenshot({ path: `${shots}/08-print-done.png` });

  // 5. queue shows jobs; printer PC prints the first one
  await page.click('button:has-text("View queue")');
  await page.waitForSelector('.job');
  ok(await page.locator('.job').count() === 2, 'queue: two active jobs');
  ok(await page.locator('text=Position 2').count() === 1 || await page.locator('text=Position 1').count() === 1, 'queue: position message shown');
  const claim = (await agentCall('POST', '/claim', {})).json.job;
  ok(claim && claim.filename === 'invoice.pdf' && claim.copies === 2 && claim.color === 'color' && claim.pages === '1,2', 'agent: receives first job with the chosen settings');
  await agentCall('POST', `/jobs/${claim.id}/start`, {}, claim.claim_id);
  await page.waitForSelector('.badge:has-text("Printing")', { timeout: 10000 });
  ok(true, 'queue: live update to Printing');
  await page.screenshot({ path: `${shots}/09-queue-printing.png` });
  await agentCall('POST', `/jobs/${claim.id}/result`, { status: 'COMPLETED', evidence: 'Windows reported the job printed', page_count: 2 }, claim.claim_id);
  await page.waitForSelector('.job:has-text("invoice.pdf") .badge:has-text("Completed")', { timeout: 10000 }).catch(() => {});
  await page.click('.chip:has-text("Completed")');
  await page.waitForSelector('.job:has-text("invoice.pdf")');
  ok(true, 'queue: completed job moves to Completed');

  // 6. cancel the waiting job, print again the finished one, open details
  await page.click('.chip:has-text("Active")');
  await page.click('.job:has-text("photo.jpg") >> button:has-text("Cancel")');
  await page.waitForSelector('text=Job cancelled.');
  await page.click('.chip:has-text("Completed")');
  await page.click('.job:has-text("invoice.pdf") >> button:has-text("Print again")');
  await page.waitForSelector('text=Added to the queue again.');
  await page.click('.chip:has-text("All")');
  await page.waitForSelector('.job:has-text("invoice.pdf") >> nth=1');
  await page.click('.job:has-text("invoice.pdf") >> nth=0 >> button:has-text("Details")');
  await page.waitForSelector('.drawer .timeline li');
  await page.screenshot({ path: `${shots}/10-job-details.png` });
  await page.click('.drawer >> button:has-text("Close")');

  // 7. admin: users, settings
  await page.click('.tabs >> text=Manage');
  await page.click('.chip:has-text("Users")');
  await page.fill('.form-grid input >> nth=0', 'Riya Sharma');
  await page.fill('.form-grid input >> nth=1', 'riya');
  await page.fill('.form-grid input[type=password]', 'password123');
  await page.click('button:has-text("Add user")');
  await page.waitForSelector('text=User added.');
  await page.click('.chip:has-text("Settings")');
  await page.waitForSelector('text=Max file size');
  await page.screenshot({ path: `${shots}/11-manage-settings.png` });

  // 8. staff user sees no Manage tab and only own jobs; mobile layout
  await page.click('button:has-text("Sign out")');
  await page.fill('input[autocomplete=username]', 'riya');
  await page.fill('input[type=password]', 'password123');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('text=Print settings');
  ok(await page.locator('.tabs >> text=Manage').count() === 0, 'staff: Manage tab hidden');
  await page.click('.tabs >> text=Queue');
  await page.click('.chip:has-text("All")');
  await page.waitForSelector('text=Nothing here yet.');
  ok(true, 'staff: cannot see other people\'s jobs');
  const m = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 });
  const mp = await m.newPage();
  await mp.goto(base);
  await mp.waitForSelector('[data-testid=splash]');
  await mp.waitForTimeout(3000); await mp.screenshot({ path: `${shots}/12-mobile-splash.png` });
  await mp.click('[data-testid=splash]'); await mp.waitForSelector('[data-testid=splash]', { state: 'detached' });
  await mp.fill('input[autocomplete=username]', 'admin'); await mp.fill('input[type=password]', 'adminpass123');
  await mp.click('button:has-text("Sign in")'); await mp.waitForSelector('text=Print settings');
  await mp.screenshot({ path: `${shots}/13-mobile-print.png`, fullPage: true });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) console.log(await mp.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.splash')).slice(0, 8).map((e) => `${e.tagName}.${e.className} right=${Math.round(e.getBoundingClientRect().right)} vw=${window.innerWidth} sw=${document.documentElement.scrollWidth}`)));
  ok(!overflow, 'mobile: no horizontal scrolling');
  ok(errors.length === 0, `browser console: no errors${errors.length ? ' -> ' + errors.join(' | ') : ''}`);
} catch (e) {
  failures++;
  console.log('FAIL  exception:', e.message.split('\n')[0]);
  console.log(errors.join('\n'));
  try { const pg = browser.contexts()[0].pages()[0]; await pg.screenshot({ path: `${shots}/zz-failure.png` }); } catch { /* */ }
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
