// One schema, two dialects: Postgres (production, Neon/Vercel) and SQLite (local dev + tests).
// Only `seq` and the binary column type differ. All timestamps are epoch milliseconds.
const jobCols = `
  id TEXT NOT NULL UNIQUE, idem TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, filename TEXT NOT NULL, file_type TEXT,
  bytes BIGINT NOT NULL DEFAULT 0, total_chunks INTEGER NOT NULL DEFAULT 0, sha256 TEXT, has_file INTEGER NOT NULL DEFAULT 0,
  printer_id TEXT NOT NULL, copies INTEGER NOT NULL, color TEXT NOT NULL, orientation TEXT NOT NULL, pages TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, evidence TEXT, page_count INTEGER, spool_id BIGINT,
  claim_id TEXT, claim_until BIGINT NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, retry_at BIGINT NOT NULL DEFAULT 0,
  parent_id TEXT, created BIGINT NOT NULL, queued_at BIGINT, started BIGINT, completed BIGINT`;

const build = (jobsTable, bin, eventId) => `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
  pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
  last_seen BIGINT NOT NULL DEFAULT 0, installed TEXT NOT NULL DEFAULT '[]', created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS printers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, windows_name TEXT NOT NULL, agent_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, online INTEGER NOT NULL DEFAULT 0, color INTEGER NOT NULL DEFAULT 0,
  status_note TEXT, updated BIGINT NOT NULL DEFAULT 0, created BIGINT NOT NULL);
${jobsTable}
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(printer_id, status, seq);
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(user_id, seq);
CREATE TABLE IF NOT EXISTS job_chunks(
  job_id TEXT NOT NULL, n INTEGER NOT NULL, data ${bin} NOT NULL, PRIMARY KEY(job_id, n));
CREATE TABLE IF NOT EXISTS events(
  ${eventId}, job_id TEXT, actor TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL, at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, id);
CREATE TABLE IF NOT EXISTS config(id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires BIGINT NOT NULL);
`;

export const pgSchema = build(`CREATE TABLE IF NOT EXISTS jobs(seq BIGSERIAL UNIQUE, ${jobCols});`, 'BYTEA', 'id BIGSERIAL PRIMARY KEY');
export const sqliteSchema = build(`CREATE TABLE IF NOT EXISTS jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, ${jobCols});`, 'BLOB', 'id INTEGER PRIMARY KEY AUTOINCREMENT');
