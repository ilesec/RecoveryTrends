import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Activity, Wellness } from '../shared/model.js';
import { GarminClient, GarminError } from './garmin.js';
import { Store } from './store.js';
import { SyncService } from './sync.js';

const sample: Wellness = {
  date: '2025-01-01', hrv: 60, rhr: null, garminWeeklyHrv: 58, hrvStatus: 'BALANCED', baselineLow: 50, baselineHigh: 70,
};
const activity: Activity = {
  id: '1', date: sample.date, name: 'Run', sport: 'running', startLocal: '2025-01-01 10:00:00', startGmt: null,
  duration: 1800, distance: 5000, load: 75,
};

class FixtureClient extends GarminClient {
  calls: string[] = [];
  failDate: string | null = null;
  constructor() { super('fixture-only'); }
  override async hrv(start: string, end: string): Promise<Wellness[]> {
    this.calls.push(`hrv:${start}:${end}`);
    return start <= sample.date && end >= sample.date ? [sample] : [];
  }
  override async rhr(date: string): Promise<number | null> {
    this.calls.push(`rhr:${date}`);
    if (date === this.failDate) throw new GarminError('Fixture API failure.');
    return 50;
  }
  override async activities(start: string, end: string): Promise<Activity[]> {
    this.calls.push(`activities:${start}:${end}`);
    return start <= activity.date && end >= activity.date ? [activity] : [];
  }
}

describe('SQLite persistence', () => {
  it('upserts each metric independently and replaces refreshed activity dates atomically', () => {
    const store = new Store(':memory:');
    try {
      store.saveHrv(sample.date, sample.date, [sample]);
      store.saveRhr(sample.date, 51);
      store.saveHrv(sample.date, sample.date, [{ ...sample, hrv: 65 }]);
      expect(store.wellness(sample.date, sample.date)[0]).toMatchObject({ hrv: 65, rhr: 51 });
      store.saveActivities(sample.date, sample.date, [activity]);
      store.saveActivities(sample.date, sample.date, [activity]);
      expect(store.activities(sample.date, sample.date)).toHaveLength(1);
      store.saveActivities(sample.date, sample.date, []);
      expect(store.activities(sample.date, sample.date)).toHaveLength(0);
      expect(store.covered('activities', sample.date, sample.date).has(sample.date)).toBe(true);
      expect(store.coverage().find(source => source.source === 'activities')?.days).toBe(1);
    } finally { store.close(); }
  });
  it('rolls back failed writes and does not mark partial coverage', () => {
    const store = new Store(':memory:');
    try {
      store.saveActivities(sample.date, sample.date, [activity]);
      store.db.exec(`CREATE TRIGGER reject_test BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
      expect(() => store.saveActivities('2025-01-01', '2025-01-02', [activity])).toThrow('test failure');
      expect(store.activities(sample.date, sample.date)).toHaveLength(1);
      expect(store.covered('activities', '2025-01-01', '2025-01-02').has('2025-01-02')).toBe(false);
    } finally { store.close(); }
  });
  it('persists across restarts and recovers interrupted job state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'recovery-trends-test-'));
    const path = join(directory, 'test.sqlite');
    let store = new Store(path);
    try {
      store.saveHrv(sample.date, sample.date, [sample]);
      store.saveJob({
        start: sample.date, end: sample.date, mode: 'resume', state: 'running',
        completed: 1, total: 3, source: 'rhr', currentDate: sample.date, error: null,
      });
      store.close();
      store = new Store(path);
      const sync = new SyncService(store, null, '2015-01-01');
      expect(store.wellness(sample.date, sample.date)[0].hrv).toBe(60);
      expect(sync.status().job?.state).toBe('cancelled');
      expect(sync.status().job?.error).toContain('server stopped');
    } finally {
      store.close();
      rmSync(directory, { recursive: true });
    }
  });
});

describe('resumable sync', () => {
  it('chunks ranges, accounts for empty dates, and resumes without duplicate calls', async () => {
    const store = new Store(':memory:');
    const client = new FixtureClient();
    const sync = new SyncService(store, client, '2015-01-01');
    try {
      sync.start('2025-01-01', '2025-02-28', 'resume');
      await vi.waitFor(() => { expect(sync.status().job?.state).toBe('complete'); });
      expect(sync.status().job?.completed).toBe(59 * 3);
      expect(client.calls.filter(call => call.startsWith('hrv:'))).toEqual([
        'hrv:2025-01-01:2025-01-28', 'hrv:2025-01-29:2025-02-25', 'hrv:2025-02-26:2025-02-28',
      ]);
      expect(store.coverage().every(source => source.days === 59)).toBe(true);
      expect(store.wellness('2025-02-01', '2025-02-01')[0].hrv).toBeNull();
      const count = client.calls.length;
      sync.start('2025-01-01', '2025-02-28', 'resume');
      await vi.waitFor(() => { expect(sync.status().job?.state).toBe('complete'); });
      expect(client.calls).toHaveLength(count);
      sync.start('2025-01-01', '2025-01-01', 'refresh');
      await vi.waitFor(() => { expect(sync.status().job?.state).toBe('complete'); });
      expect(client.calls).toHaveLength(count + 3);
      expect(store.activities('2025-01-01', '2025-02-28')).toHaveLength(1);
    } finally { await sync.stop(); store.close(); }
  });
  it('preserves successful dates after failure and resumes only missing dates', async () => {
    const store = new Store(':memory:');
    const client = new FixtureClient();
    client.failDate = '2025-01-02';
    const sync = new SyncService(store, client, '2015-01-01');
    try {
      sync.start('2025-01-01', '2025-01-03', 'resume');
      await vi.waitFor(() => { expect(sync.status().job?.state).toBe('failed'); });
      expect(sync.status().job?.error).toBe('Fixture API failure.');
      expect(store.covered('rhr', '2025-01-01', '2025-01-03').size).toBe(1);
      expect(sync.status().lastSuccessfulSync).toBeNull();
      const count = client.calls.length;
      client.failDate = null;
      sync.start('2025-01-01', '2025-01-03', 'resume');
      await vi.waitFor(() => { expect(sync.status().job?.state).toBe('complete'); });
      expect(client.calls.slice(count)).toEqual(['rhr:2025-01-02', 'rhr:2025-01-03', 'activities:2025-01-01:2025-01-03']);
    } finally { await sync.stop(); store.close(); }
  });
  it('supports cancellation without committing the in-flight range', async () => {
    const store = new Store(':memory:');
    const sync = new SyncService(store, new FixtureClient(), '2015-01-01');
    try {
      sync.start('2025-01-01', '2025-01-03', 'resume');
      expect(() => sync.start('2025-01-01', '2025-01-03', 'resume')).toThrow('already running');
      sync.cancel();
      await sync.stop();
      expect(sync.status().job?.state).toBe('cancelled');
      expect(store.coverage().every(source => source.days === 0)).toBe(true);
    } finally { store.close(); }
  });
  it('rejects syncing without a configured key', () => {
    const store = new Store(':memory:');
    try {
      const sync = new SyncService(store, null, '2015-01-01');
      expect(() => sync.start('2025-01-01', '2025-01-01', 'resume')).toThrow('Configure GARMIN_API_KEY');
    } finally { store.close(); }
  });
});
