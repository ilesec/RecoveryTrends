import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { Store } from './store.js';
import { SyncService } from './sync.js';

describe('local HTTP API', () => {
  const store = new Store(':memory:');
  const sync = new SyncService(store, null, '2015-01-01');
  const server = createApp(store, sync, '__no_static_test_files__').listen(0, '127.0.0.1');
  let base = '';
  beforeAll(async () => {
    if (!server.listening) await new Promise<void>(resolve => { server.once('listening', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await sync.stop();
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    store.close();
  });
  it('reports connection state without leaking key/token material', async () => {
    const response = await fetch(`${base}/api/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ configured: false, historyStart: '2015-01-01', job: null });
  });
  it('returns a complete daily shape with missing observations and coverage', async () => {
    const response = await fetch(`${base}/api/dashboard?start=2025-01-01&end=2025-01-28`);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.days).toHaveLength(28);
    expect(data.days[0]).toMatchObject({ hrv: null, rhr: null, load: null, activityCoverage: false });
    expect(data.correlation).toMatchObject({ coefficient: null, pairs: [], possibleDays: 28 });
  });
  it.each([
    'start=2025-02-29&end=2025-03-01',
    'start=2025-02-01&end=2025-01-01',
    'start=2025-01-01&end=9999-01-01',
    'start=2025-01-01&end=2025-01-28&lag=4',
    'start=2025-01-01&end=2025-01-28&metric=invalid',
  ])('rejects invalid dates/options: %s', async query => {
    const response = await fetch(`${base}/api/dashboard?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  });
  it('returns actionable configuration errors instead of fake sync success', async () => {
    const response = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: '2025-01-01', end: '2025-01-28', mode: 'resume' }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('GARMIN_API_KEY') });
  });
  it('blocks foreign hosts, cross-origin writes, and form submissions', async () => {
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/status`, { headers: { Host: 'foreign.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(foreignHostStatus).toBe(403);
    expect((await fetch(`${base}/api/sync/cancel`, { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/api/sync/cancel`, { method: 'POST', body: 'cancel=true' })).status).toBe(415);
  });
  it('reports malformed JSON and unknown API routes', async () => {
    expect((await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404);
  });
});
