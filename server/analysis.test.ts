import { describe, expect, it } from 'vitest';
import { addDays, datesBetween, isDate, monthsBefore } from '../shared/dates.js';
import type { Activity, Wellness } from '../shared/model.js';
import { buildDays, correlate, dashboard, rollingAverage } from './analysis.js';
import { Store } from './store.js';

const wellness = (date: string, value: number | null): Wellness => ({
  date, hrv: value, rhr: value, garminWeeklyHrv: null, hrvStatus: null, baselineLow: null, baselineHigh: null,
});
const activity = (date: string, load: number | null, id = '1', sport = 'running'): Activity => ({
  id, date, load, sport, name: 'Run', startLocal: `${date} 23:30:00`, startGmt: `${addDays(date, 1)} 02:30:00`,
  duration: 600, distance: 2000,
});

describe('calendar days', () => {
  it('handles leap days and rejects normalized invalid dates', () => {
    expect(isDate('2024-02-29')).toBe(true);
    expect(isDate('2025-02-29')).toBe(false);
    expect(isDate('2025-2-01')).toBe(false);
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(datesBetween('2024-02-28', '2024-03-01')).toHaveLength(3);
  });
  it('clamps calendar month presets at month ends', () => {
    expect(monthsBefore('2024-03-31', 1)).toBe('2024-02-29');
    expect(monthsBefore('2025-03-31', 1)).toBe('2025-02-28');
  });
});

describe('rolling averages', () => {
  it('requires 5/7 observations and ignores nulls rather than injecting zeros', () => {
    const dates = datesBetween('2025-01-01', '2025-01-07');
    const map = new Map(dates.map((date, index) => [date, index < 4 ? 50 : null]));
    expect(rollingAverage(map, '2025-01-07', 7)).toEqual({ count: 4, window: 7, value: null });
    map.set('2025-01-05', 100);
    expect(rollingAverage(map, '2025-01-07', 7)).toEqual({ count: 5, window: 7, value: 60 });
  });
  it('requires 20/28 observations', () => {
    const dates = datesBetween('2025-01-01', '2025-01-28');
    const map = new Map(dates.slice(0, 19).map(date => [date, 40]));
    expect(rollingAverage(map, '2025-01-28', 28).value).toBeNull();
    map.set('2025-01-20', 40);
    expect(rollingAverage(map, '2025-01-28', 28).value).toBe(40);
  });
  it('uses calendar windows, excluding stale observations outside the window', () => {
    const map = new Map([['2024-12-31', 1000], ['2025-01-01', 50]]);
    expect(rollingAverage(map, '2025-01-07', 7).count).toBe(1);
  });
});

describe('daily activity aggregates', () => {
  it('distinguishes unsynced days, rest days, and missing activity load', () => {
    const days = buildDays('2025-01-01', '2025-01-04', [], [
      activity('2025-01-03', null), activity('2025-01-03', 10, '2'),
    ], new Set(['2025-01-02', '2025-01-03', '2025-01-04']));
    expect(days[0].activityCount).toBeNull();
    expect(days[0].load).toBeNull();
    expect(days[1].activityCount).toBe(0);
    expect(days[1].load).toBe(0);
    expect(days[2].knownLoad).toBe(10);
    expect(days[2].load).toBeNull();
    expect(days[2].duration).toBe(20);
    expect(days[2].activityCount).toBe(2);
  });
  it('requires all seven days for load sums', () => {
    const dates = datesBetween('2025-01-01', '2025-01-07');
    const rows = dates.map((date, index) => activity(date, index + 1, String(index)));
    expect(buildDays(dates[0], dates[6], [], rows, new Set(dates)).at(-1)?.load7).toBe(28);
    expect(buildDays(dates[0], dates[6], [], rows, new Set(dates.slice(1))).at(-1)?.load7).toBeNull();
  });
});

describe('correlation', () => {
  function series(length: number, multiplier = 1, constant = false) {
    const dates = datesBetween('2025-01-01', addDays('2025-01-01', length - 1));
    return buildDays(dates[0], dates.at(-1)!, dates.map((date, index) => wellness(date, constant ? 50 : (index + 1) * multiplier)),
      dates.map((date, index) => activity(date, index + 1, String(index))), new Set(dates));
  }
  it('returns exact positive and negative correlations', () => {
    expect(correlate(series(20), '2025-01-01', '2025-01-20', 'load', 'hrv', 0).coefficient).toBeCloseTo(1);
    expect(correlate(series(20, -2), '2025-01-01', '2025-01-20', 'load', 'rhr', 0).coefficient).toBeCloseTo(-1);
  });
  it('requires 20 pairs and variation in both series', () => {
    expect(correlate(series(19), '2025-01-01', '2025-01-19', 'load', 'hrv', 0).coefficient).toBeNull();
    expect(correlate(series(20, 1, true), '2025-01-01', '2025-01-20', 'load', 'hrv', 0).reason).toContain('constant');
    expect(correlate(series(20), '2025-01-01', '2025-01-20', 'count', 'hrv', 0).reason).toContain('constant');
  });
  it('pairs training D to recovery D+lag, including preceding predictor dates', () => {
    const result = correlate(series(25), '2025-01-04', '2025-01-25', 'load', 'hrv', 3);
    expect(result.pairs[0]).toEqual({ date: '2025-01-04', predictorDate: '2025-01-01', x: 1, y: 4 });
    expect(result.pairs).toHaveLength(22);
  });
  it('excludes unknown predictor/recovery days without changing the denominator', () => {
    const days = series(25);
    days[0].load = null;
    days[1].hrv = null;
    const result = correlate(days, '2025-01-01', '2025-01-25', 'load', 'hrv', 0);
    expect(result.pairs).toHaveLength(23);
    expect(result.possibleDays).toBe(25);
  });
});

describe('dashboard query', () => {
  it('fetches 27 preceding days and filters predictors but never wellness', () => {
    const store = new Store(':memory:');
    try {
      const dates = datesBetween('2025-01-01', '2025-01-28');
      store.saveHrv(dates[0], dates[27], dates.map(date => wellness(date, 60)));
      store.saveActivities(dates[0], dates[27], [activity('2025-01-28', 30), activity('2025-01-28', 20, '2', 'cycling')]);
      const result = dashboard(store, '2025-01-28', '2025-01-28', 'cycling', 'load', 'hrv', 0);
      expect(result.days).toHaveLength(1);
      expect(result.days[0].hrv28).toEqual({ count: 28, window: 28, value: 60 });
      expect(result.days[0].load).toBe(20);
      expect(result.days[0].load7).toBe(20);
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].date).toBe('2025-01-28');
    } finally { store.close(); }
  });
});
