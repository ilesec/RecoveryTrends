import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { isDate } from '../shared/dates.js';
import type { Activity, Wellness } from '../shared/model.js';

const BASE = 'https://personal.connectapi.garmin.com';
const dateSchema = z.string().refine(isDate);
const measurement = z.number().finite().nullable().optional();
const hrvSchema = z.object({
  hrvSummaries: z.array(z.object({
    calendarDate: dateSchema,
    lastNightAvg: measurement,
    weeklyAvg: measurement,
    status: z.string().nullable().optional(),
    baseline: z.object({
      balancedLow: measurement,
      balancedUpper: measurement,
    }).nullable().optional(),
  })),
});
const rhrSchema = z.object({
  calendarDate: dateSchema,
  restingHeartRate: measurement,
});
const idSchema = z.union([z.number().int().safe().nonnegative(), z.string().regex(/^\d+$/)])
  .transform(String);
const activitiesSchema = z.array(z.object({
  activityId: idSchema,
  activityName: z.string().nullable().optional(),
  startTimeLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/)
    .refine(value => isDate(value.slice(0, 10))),
  startTimeGMT: z.string().nullable().optional(),
  activityType: z.object({ typeKey: z.string() }).nullable().optional(),
  parentId: idSchema.nullable().optional(),
  duration: measurement,
  distance: measurement,
  activityTrainingLoad: measurement,
}));

export class GarminError extends Error {}

function positive(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

function nonnegative(value: number | null | undefined): number | null {
  return value != null && value >= 0 ? value : null;
}

export function parseHrv(payload: unknown): Wellness[] {
  const parsed = hrvSchema.safeParse(payload);
  if (!parsed.success) throw new GarminError('Garmin HRV response does not match the documented schema.');
  return parsed.data.hrvSummaries.map(item => ({
    date: item.calendarDate,
    hrv: positive(item.lastNightAvg),
    rhr: null,
    garminWeeklyHrv: positive(item.weeklyAvg),
    hrvStatus: item.status ?? null,
    baselineLow: positive(item.baseline?.balancedLow),
    baselineHigh: positive(item.baseline?.balancedUpper),
  }));
}

export function parseRhr(payload: unknown, date: string): number | null {
  const parsed = rhrSchema.safeParse(payload);
  if (!parsed.success || parsed.data.calendarDate !== date) {
    throw new GarminError('Garmin daily resting-heart-rate response has an invalid schema or date.');
  }
  return positive(parsed.data.restingHeartRate);
}

export function parseActivities(payload: unknown): { activities: Activity[]; received: number } {
  const parsed = activitiesSchema.safeParse(payload);
  if (!parsed.success) throw new GarminError('Garmin activities response does not match the documented schema.');
  return {
    received: parsed.data.length,
    activities: parsed.data.filter(item => !item.parentId || item.parentId === '0').map(item => ({
      id: item.activityId,
      date: item.startTimeLocal.slice(0, 10),
      name: item.activityName || 'Untitled activity',
      sport: item.activityType?.typeKey ?? 'unknown',
      startLocal: item.startTimeLocal,
      startGmt: item.startTimeGMT ?? null,
      duration: nonnegative(item.duration),
      distance: nonnegative(item.distance),
      load: nonnegative(item.activityTrainingLoad),
    })),
  };
}

interface ClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class GarminClient {
  private token: string | null = null;
  private expires = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly key: string, options: ClientOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(`${BASE}${path}`, {
          ...init,
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
      } catch {
        signal?.throwIfAborted();
        if (attempt === 3) throw new GarminError('Garmin request timed out or could not connect. Check your connection and retry.');
        await this.sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt === 3) throw new GarminError(`Garmin is unavailable or throttling requests (HTTP ${response.status}). Retry sync later.`);
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const retryAfter = header === null ? NaN
          : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - this.now();
        const wait = Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 1000 * 2 ** attempt;
        if (wait > 300_000) throw new GarminError('Garmin requested a long rate-limit pause. Retry sync later.');
        await this.sleep(wait, signal);
        continue;
      }
      return response;
    }
    throw new GarminError('Garmin request retry limit exceeded.');
  }

  private async authenticate(signal?: AbortSignal): Promise<void> {
    if (this.token && this.now() < this.expires) return;
    const acquiredAt = this.now();
    const response = await this.request('/personalapitoken-service/personal-api/personal-api-key/token', {
      method: 'POST',
      headers: { Authorization: `ApiKey ${this.key}` },
    }, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new GarminError(`Garmin API key was rejected or token creation failed (HTTP ${response.status}). Check backend key configuration.`);
    }
    const token = (await response.text()).trim();
    if (!token || /\s/.test(token) || token.startsWith('{') || token.startsWith('"')) {
      throw new GarminError('Garmin returned an unexpected token format; expected a raw token response.');
    }
    this.token = token;
    this.expires = acquiredAt + 24 * 60 * 60 * 1000 - 60_000;
  }

  async get(path: string, signal?: AbortSignal): Promise<unknown> {
    for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
      await this.authenticate(signal);
      const response = await this.request(path, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      }, signal);
      if (response.status === 401 && authAttempt === 0) {
        await response.body?.cancel();
        this.token = null;
        continue;
      }
      if (response.status === 204 && path.startsWith('/hrv-service/')) return { hrvSummaries: [] };
      if (!response.ok) {
        await response.body?.cancel();
        throw new GarminError(`Garmin data request failed (HTTP ${response.status}). Check API permissions and selected dates; cached data has been retained.`);
      }
      try {
        return await response.json();
      } catch {
        signal?.throwIfAborted();
        throw new GarminError('Garmin returned an invalid JSON response.');
      }
    }
    throw new GarminError('Garmin authentication failed after renewing the token.');
  }

  async hrv(start: string, end: string, signal?: AbortSignal): Promise<Wellness[]> {
    const rows = parseHrv(await this.get(`/hrv-service/hrv/daily/${start}/${end}`, signal));
    if (rows.some(row => row.date < start || row.date > end)) {
      throw new GarminError('Garmin returned HRV outside the requested date range.');
    }
    return rows;
  }

  async rhr(date: string, signal?: AbortSignal): Promise<number | null> {
    return parseRhr(await this.get(`/usersummary-service/usersummary/daily?calendarDate=${date}`, signal), date);
  }

  async activities(start: string, end: string, signal?: AbortSignal): Promise<Activity[]> {
    const result = new Map<string, Activity>();
    const pageSignatures = new Set<string>();
    for (let offset = 0; ; offset += 99) {
      const query = new URLSearchParams({
        start: String(offset), limit: '99', startDate: start, endDate: end,
        excludeChildren: 'true', sortBy: 'startLocal', sortOrder: 'asc',
      });
      const { activities, received } = parseActivities(await this.get(`/activitylist-service/activities/search/activities?${query}`, signal));
      if (activities.some(row => row.date < start || row.date > end)) {
        throw new GarminError('Garmin returned activities outside the requested local-date range.');
      }
      const signature = JSON.stringify(activities.map(row => row.id));
      if (received > 0 && pageSignatures.has(signature)) {
        throw new GarminError('Garmin repeated an activity page; sync stopped to avoid incomplete coverage.');
      }
      pageSignatures.add(signature);
      for (const activity of activities) result.set(activity.id, activity);
      if (received < 99) break;
    }
    return [...result.values()];
  }
}
