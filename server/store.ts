import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { datesBetween } from '../shared/dates.js';
import type { Activity, CoverageSummary, Source, SyncJob, Wellness } from '../shared/model.js';

const activityRow = z.object({
  id: z.string(), date: z.string(), name: z.string(), sport: z.string(),
  startLocal: z.string(), startGmt: z.string().nullable(),
  duration: z.number().nullable(), distance: z.number().nullable(), load: z.number().nullable(),
});
const wellnessRow = z.object({
  date: z.string(), hrv: z.number().nullable(), rhr: z.number().nullable(),
  garminWeeklyHrv: z.number().nullable(), hrvStatus: z.string().nullable(),
  baselineLow: z.number().nullable(), baselineHigh: z.number().nullable(),
});
const sourceSchema = z.enum(['hrv', 'rhr', 'activities']);
const jobSchema = z.object({
  start: z.string(), end: z.string(), mode: z.enum(['resume', 'refresh']),
  state: z.enum(['running', 'cancelled', 'failed', 'complete']),
  completed: z.number(), total: z.number(), source: sourceSchema.nullable(),
  currentDate: z.string().nullable(), error: z.string().nullable(),
});

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version = z.object({ user_version: z.number() }).parse(this.db.prepare('PRAGMA user_version').get()).user_version;
    if (version > 1) throw new Error('Database belongs to a newer app version.');
    if (version === 0) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE wellness (
          date TEXT PRIMARY KEY, hrv REAL, rhr REAL, garminWeeklyHrv REAL,
          hrvStatus TEXT, baselineLow REAL, baselineHigh REAL
        );
        CREATE TABLE activities (
          id TEXT PRIMARY KEY, date TEXT NOT NULL, name TEXT NOT NULL, sport TEXT NOT NULL,
          startLocal TEXT NOT NULL, startGmt TEXT, duration REAL, distance REAL, load REAL
        );
        CREATE INDEX activities_date ON activities(date);
        CREATE TABLE coverage (source TEXT NOT NULL, date TEXT NOT NULL, syncedAt TEXT NOT NULL, PRIMARY KEY(source, date));
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version=1;
        COMMIT;
      `);
    }
  }

  close(): void { this.db.close(); }

  transaction(action: () => void): void {
    this.db.exec('BEGIN');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private mark(source: Source, start: string, end: string): void {
    const statement = this.db.prepare('INSERT INTO coverage VALUES (?, ?, ?) ON CONFLICT(source,date) DO UPDATE SET syncedAt=excluded.syncedAt');
    const now = new Date().toISOString();
    for (const date of datesBetween(start, end)) statement.run(source, date, now);
  }

  saveHrv(start: string, end: string, rows: Wellness[]): void {
    const byDate = new Map(rows.map(row => [row.date, row]));
    const statement = this.db.prepare(`
      INSERT INTO wellness(date,hrv,garminWeeklyHrv,hrvStatus,baselineLow,baselineHigh) VALUES (?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET hrv=excluded.hrv,garminWeeklyHrv=excluded.garminWeeklyHrv,
        hrvStatus=excluded.hrvStatus,baselineLow=excluded.baselineLow,baselineHigh=excluded.baselineHigh
    `);
    this.transaction(() => {
      for (const date of datesBetween(start, end)) {
        const row = byDate.get(date);
        statement.run(date, row?.hrv ?? null, row?.garminWeeklyHrv ?? null,
          row?.hrvStatus ?? null, row?.baselineLow ?? null, row?.baselineHigh ?? null);
      }
      this.mark('hrv', start, end);
    });
  }

  saveRhr(date: string, value: number | null): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO wellness(date,rhr) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET rhr=excluded.rhr').run(date, value);
      this.mark('rhr', date, date);
    });
  }

  saveActivities(start: string, end: string, rows: Activity[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM activities WHERE date BETWEEN ? AND ?').run(start, end);
      const statement = this.db.prepare(`
        INSERT INTO activities VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET date=excluded.date,name=excluded.name,sport=excluded.sport,
          startLocal=excluded.startLocal,startGmt=excluded.startGmt,duration=excluded.duration,
          distance=excluded.distance,load=excluded.load
      `);
      for (const row of rows) {
        statement.run(row.id, row.date, row.name, row.sport, row.startLocal, row.startGmt, row.duration, row.distance, row.load);
      }
      this.mark('activities', start, end);
    });
  }

  wellness(start: string, end: string): Wellness[] {
    return z.array(wellnessRow).parse(this.db.prepare('SELECT * FROM wellness WHERE date BETWEEN ? AND ? ORDER BY date').all(start, end));
  }

  activities(start: string, end: string): Activity[] {
    return z.array(activityRow).parse(this.db.prepare('SELECT * FROM activities WHERE date BETWEEN ? AND ? ORDER BY startLocal DESC').all(start, end));
  }

  sports(): string[] {
    return z.array(z.object({ sport: z.string() })).parse(this.db.prepare('SELECT DISTINCT sport FROM activities ORDER BY sport').all()).map(row => row.sport);
  }

  covered(source: Source, start: string, end: string): Set<string> {
    return new Set(z.array(z.object({ date: z.string() })).parse(
      this.db.prepare('SELECT date FROM coverage WHERE source=? AND date BETWEEN ? AND ?').all(source, start, end),
    ).map(row => row.date));
  }

  coverage(): CoverageSummary[] {
    return (['hrv', 'rhr', 'activities'] satisfies Source[]).map(source => {
      const row = z.object({
        first: z.string().nullable(), last: z.string().nullable(), days: z.number(), latestSync: z.string().nullable(),
      }).parse(this.db.prepare('SELECT MIN(date) AS first, MAX(date) AS last, COUNT(*) AS days, MAX(syncedAt) AS latestSync FROM coverage WHERE source=?').get(source));
      return { source, ...row };
    });
  }

  setting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? z.object({ value: z.string() }).parse(row).value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  job(): SyncJob | null {
    const value = this.setting('job');
    return value ? jobSchema.parse(JSON.parse(value)) : null;
  }

  saveJob(job: SyncJob): void { this.setSetting('job', JSON.stringify(job)); }
}
