import { addDays, datesBetween } from '../shared/dates.js';
import type { Activity, Average, Correlation, Dashboard, Day, Predictor, RecoveryMetric, Wellness } from '../shared/model.js';
import { Store } from './store.js';

export function rollingAverage(values: Map<string, number | null>, date: string, window: number): Average {
  const observed = datesBetween(addDays(date, 1 - window), date)
    .map(day => values.get(day))
    .filter((value): value is number => value != null && Number.isFinite(value));
  return {
    count: observed.length, window,
    value: observed.length >= Math.ceil(window * 0.7)
      ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null,
  };
}

export function buildDays(
  start: string, end: string, wellness: Wellness[], activities: Activity[], coverage: Set<string>,
): Day[] {
  const byDate = new Map(wellness.map(day => [day.date, day]));
  const hrv = new Map(wellness.map(day => [day.date, day.hrv]));
  const rhr = new Map(wellness.map(day => [day.date, day.rhr]));
  const grouped = new Map<string, Activity[]>();
  for (const row of activities) {
    const group = grouped.get(row.date) ?? [];
    group.push(row);
    grouped.set(row.date, group);
  }
  const days: Day[] = datesBetween(start, end).map(date => {
    const row = byDate.get(date);
    const activityRows = grouped.get(date) ?? [];
    const activityCoverage = coverage.has(date);
    const loadComplete = activityCoverage && activityRows.every(activity => activity.load !== null);
    const durationComplete = activityCoverage && activityRows.every(activity => activity.duration !== null);
    const knownLoad = activityRows.reduce((sum, activity) => sum + (activity.load ?? 0), 0);
    return {
      date, hrv: row?.hrv ?? null, rhr: row?.rhr ?? null,
      garminWeeklyHrv: row?.garminWeeklyHrv ?? null, hrvStatus: row?.hrvStatus ?? null,
      baselineLow: row?.baselineLow ?? null, baselineHigh: row?.baselineHigh ?? null,
      hrv7: rollingAverage(hrv, date, 7), hrv28: rollingAverage(hrv, date, 28),
      rhr7: rollingAverage(rhr, date, 7), rhr28: rollingAverage(rhr, date, 28),
      activityCount: activityCoverage ? activityRows.length : null,
      duration: durationComplete ? activityRows.reduce((sum, activity) => sum + (activity.duration ?? 0), 0) / 60 : null,
      load: loadComplete ? knownLoad : null,
      knownLoad, loadComplete, load7: null, activityCoverage,
    };
  });
  const loads = new Map(days.map(day => [day.date, day.load]));
  for (const day of days) {
    const values = datesBetween(addDays(day.date, -6), day.date).map(date => loads.get(date));
    day.load7 = values.every((value): value is number => value != null)
      ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return days;
}

export function correlate(
  days: Day[], start: string, end: string, predictor: Predictor, metric: RecoveryMetric, lag: number,
): Correlation {
  const byDate = new Map(days.map(day => [day.date, day]));
  const pairs: Correlation['pairs'] = [];
  const dates = datesBetween(start, end);
  for (const date of dates) {
    const predictorDate = addDays(date, -lag);
    const previous = byDate.get(predictorDate);
    const recovery = byDate.get(date)?.[metric];
    const x = predictor === 'load' ? previous?.load
      : predictor === 'duration' ? previous?.duration : previous?.activityCount;
    if (x != null && recovery != null && Number.isFinite(x) && Number.isFinite(recovery)) {
      pairs.push({ date, predictorDate, x, y: recovery });
    }
  }
  if (pairs.length < 20) {
    return { coefficient: null, reason: 'At least 20 complete paired days are required.', pairs, possibleDays: dates.length };
  }
  const meanX = pairs.reduce((sum, pair) => sum + pair.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair.y, 0) / pairs.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const pair of pairs) {
    covariance += (pair.x - meanX) * (pair.y - meanY);
    varianceX += (pair.x - meanX) ** 2;
    varianceY += (pair.y - meanY) ** 2;
  }
  if (varianceX === 0 || varianceY === 0) {
    return { coefficient: null, reason: 'Correlation is undefined for a constant series.', pairs, possibleDays: dates.length };
  }
  return {
    coefficient: Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceX * varianceY))),
    reason: null, pairs, possibleDays: dates.length,
  };
}

export function dashboard(
  store: Store, start: string, end: string, sport: string, predictor: Predictor, metric: RecoveryMetric, lag: number,
): Dashboard {
  const lookback = addDays(start, -27);
  const activities = store.activities(lookback, end).filter(activity => sport === 'all' || activity.sport === sport);
  const days = buildDays(lookback, end, store.wellness(lookback, end), activities, store.covered('activities', lookback, end));
  return {
    days: days.filter(day => day.date >= start),
    activities: activities.filter(activity => activity.date >= start),
    sports: store.sports(), correlation: correlate(days, start, end, predictor, metric, lag),
  };
}
