import { describe, expect, it, vi } from 'vitest';
import { GarminClient, parseActivities, parseHrv, parseRhr } from './garmin.js';

const token = () => new Response('test-token');
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const rawActivity = (id: number, extra = {}) => ({
  activityId: id, activityName: 'Run', startTimeLocal: '2025-01-01 23:30:00',
  startTimeGMT: '2025-01-02 04:30:00', activityType: { typeKey: 'running' },
  duration: 600, distance: 1000, activityTrainingLoad: 50, ...extra,
});

describe('Garmin normalization', () => {
  it('preserves local dates and excludes multisport children', () => {
    const result = parseActivities([rawActivity(1), rawActivity(2, { parentId: 1 })]);
    expect(result.received).toBe(2);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0].date).toBe('2025-01-01');
    expect(result.activities[0].duration).toBe(600);
  });
  it('preserves zero load, and marks missing/negative values unknown', () => {
    expect(parseActivities([rawActivity(1, { activityTrainingLoad: 0 })]).activities[0].load).toBe(0);
    expect(parseActivities([rawActivity(1, { activityTrainingLoad: -1, duration: -1 })]).activities[0].load).toBeNull();
    expect(parseRhr({ calendarDate: '2025-01-01', restingHeartRate: -1 }, '2025-01-01')).toBeNull();
    expect(parseHrv({ hrvSummaries: [{ calendarDate: '2025-01-01', lastNightAvg: 0 }] })[0].hrv).toBeNull();
  });
  it('rejects malformed schemas, unsafe numeric identifiers, and mismatched RHR dates', () => {
    expect(() => parseHrv({})).toThrow('schema');
    expect(() => parseActivities([rawActivity(Number.MAX_SAFE_INTEGER + 1)])).toThrow('schema');
    expect(() => parseRhr({ calendarDate: '2025-01-02', restingHeartRate: 50 }, '2025-01-01')).toThrow('date');
  });
});

describe('Personal API client', () => {
  it('uses a raw token body, backend ApiKey exchange and subsequent Bearer requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ hrvSummaries: [] }));
    const client = new GarminClient('fixture-key', { fetch: fetcher });
    await client.hrv('2025-01-01', '2025-01-02');
    expect(fetcher.mock.calls[0][0]).toContain('personal-api-key/token');
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: 'ApiKey fixture-key' });
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer test-token', Accept: 'application/json' });
  });
  it('caches tokens and renews before their 24-hour expiry', async () => {
    let time = 0;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}));
    const client = new GarminClient('fixture-key', { fetch: fetcher, now: () => time });
    await client.get('/test');
    time = 60_000;
    await client.get('/test');
    time = 24 * 60 * 60 * 1000;
    await client.get('/test');
    expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(2);
  });
  it('renews on 401 once, then reports rejection without leaking credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 401));
    const client = new GarminClient('secret-fixture-key', { fetch: fetcher });
    await expect(client.get('/test')).rejects.toThrow('HTTP 401');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('does not retry invalid API keys or treat 404 as empty history', async () => {
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'sensitive' }, 403));
    await expect(new GarminClient('secret-key', { fetch: rejected }).get('/test')).rejects.toThrow('HTTP 403');
    expect(rejected).toHaveBeenCalledTimes(1);
    const missing = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 404));
    await expect(new GarminClient('key', { fetch: missing }).rhr('2025-01-01')).rejects.toThrow('HTTP 404');
  });
  it('handles documented empty HRV responses without inventing readings', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await new GarminClient('key', { fetch: fetcher }).hrv('2025-01-01', '2025-01-02')).toEqual([]);
  });
  it('rejects unexpected token and non-JSON data responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ token: 'wrong-shape' }));
    await expect(new GarminClient('key', { fetch: fetcher }).get('/test')).rejects.toThrow('token format');
    const invalidJson = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('<html>'));
    await expect(new GarminClient('key', { fetch: invalidJson }).get('/test')).rejects.toThrow('JSON');
  });
  it('honors Retry-After and retries a transient server error', async () => {
    const sleep = vi.fn(async () => {});
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ ok: true }));
    expect(await new GarminClient('key', { fetch: fetcher, sleep }).get('/test')).toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[2000, undefined], [2000, undefined]]);
  });
  it('bounds network/server retries and supports cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private request internals'));
    const client = new GarminClient('key', { fetch: fetcher, sleep: async () => {} });
    await expect(client.get('/test')).rejects.toThrow('could not connect');
    expect(fetcher).toHaveBeenCalledTimes(4);
    const controller = new AbortController();
    controller.abort();
    await expect(client.get('/test', controller.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('paginates through complete pages and rejects repeated pages', async () => {
    const page = Array.from({ length: 99 }, (_, index) => rawActivity(index + 1));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json([rawActivity(100)]));
    const rows = await new GarminClient('key', { fetch: fetcher }).activities('2025-01-01', '2025-01-01');
    expect(rows).toHaveLength(100);
    expect(String(fetcher.mock.calls[2][0])).toContain('start=99');
    const repeated = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockImplementation(async () => json(page));
    await expect(new GarminClient('key', { fetch: repeated }).activities('2025-01-01', '2025-01-01')).rejects.toThrow('repeated');
  });
  it('rejects out-of-range activity and HRV dates', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json([rawActivity(1)]));
    await expect(new GarminClient('key', { fetch: fetcher }).activities('2025-01-02', '2025-01-02')).rejects.toThrow('outside');
    const hrv = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ hrvSummaries: [{ calendarDate: '2025-01-03' }] }));
    await expect(new GarminClient('key', { fetch: hrv }).hrv('2025-01-01', '2025-01-02')).rejects.toThrow('outside');
  });
});
