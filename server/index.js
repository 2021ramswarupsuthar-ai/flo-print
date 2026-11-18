import { createApp } from './app.js';
import { pgDb } from './db.js';

let appPromise;

// One app instance per warm serverless container.
export function getApp(env = process.env) {
  appPromise ??= (async () => {
    const url = env.DATABASE_URL || env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    return createApp({ db: await pgDb(url), env });
  })().catch((e) => { appPromise = undefined; throw e; });
  return appPromise;
}
