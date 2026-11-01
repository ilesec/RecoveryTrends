import 'dotenv/config';
import { resolve } from 'node:path';
import { isDate, localToday } from '../shared/dates.js';
import { createApp } from './app.js';
import { GarminClient } from './garmin.js';
import { Store } from './store.js';
import { SyncService } from './sync.js';

const historyStart = process.env.GARMIN_HISTORY_START ?? '2015-01-01';
if (!isDate(historyStart) || historyStart < '1900-01-01' || historyStart > localToday()) {
  throw new Error('GARMIN_HISTORY_START must be a valid, non-future YYYY-MM-DD date after 1899.');
}
const port = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const store = new Store(process.env.RECOVERY_DB_PATH ?? resolve('data', 'recovery.sqlite'));
const key = process.env.GARMIN_API_KEY?.trim();
const sync = new SyncService(store, key ? new GarminClient(key) : null, historyStart);
const server = createApp(store, sync).listen(port, '127.0.0.1', () => {
  console.log(`RecoveryTrends is ready at http://127.0.0.1:${port}`);
  if (!key) console.warn('Garmin key is not configured. Set GARMIN_API_KEY in .env and restart to enable sync.');
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`Local server could not start (${error.code ?? error.name}).`);
  store.close();
  process.exitCode = 1;
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await sync.stop();
  store.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
