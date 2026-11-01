export type Source = 'hrv' | 'rhr' | 'activities';
export type Predictor = 'load' | 'duration' | 'count';
export type RecoveryMetric = 'hrv' | 'rhr';

export interface Wellness {
  date: string;
  hrv: number | null;
  rhr: number | null;
  garminWeeklyHrv: number | null;
  hrvStatus: string | null;
  baselineLow: number | null;
  baselineHigh: number | null;
}

export interface Activity {
  id: string;
  date: string;
  name: string;
  sport: string;
  startLocal: string;
  startGmt: string | null;
  duration: number | null;
  distance: number | null;
  load: number | null;
}

export interface Average {
  value: number | null;
  count: number;
  window: number;
}

export interface Day extends Wellness {
  hrv7: Average;
  hrv28: Average;
  rhr7: Average;
  rhr28: Average;
  activityCount: number | null;
  duration: number | null;
  load: number | null;
  knownLoad: number;
  loadComplete: boolean;
  load7: number | null;
  activityCoverage: boolean;
}

export interface Pair {
  date: string;
  predictorDate: string;
  x: number;
  y: number;
}

export interface Correlation {
  coefficient: number | null;
  reason: string | null;
  pairs: Pair[];
  possibleDays: number;
}

export interface Dashboard {
  days: Day[];
  activities: Activity[];
  sports: string[];
  correlation: Correlation;
}

export interface CoverageSummary {
  source: Source;
  first: string | null;
  last: string | null;
  days: number;
  latestSync: string | null;
}

export interface SyncJob {
  start: string;
  end: string;
  mode: 'resume' | 'refresh';
  state: 'running' | 'cancelled' | 'failed' | 'complete';
  completed: number;
  total: number;
  source: Source | null;
  currentDate: string | null;
  error: string | null;
}

export interface Status {
  configured: boolean;
  historyStart: string;
  coverage: CoverageSummary[];
  job: SyncJob | null;
  lastSuccessfulSync: string | null;
}
