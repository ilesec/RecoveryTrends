import { addDays, datesBetween, localToday } from '../shared/dates.js';
import type { Source, Status, SyncJob } from '../shared/model.js';
import { GarminClient, GarminError } from './garmin.js';
import { Store } from './store.js';

export class SyncService {
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private job: SyncJob | null;

  constructor(private readonly store: Store, private readonly client: GarminClient | null, readonly historyStart: string) {
    this.job = store.job();
    if (this.job?.state === 'running') {
      this.job.state = 'cancelled';
      this.job.error = 'The server stopped during sync. Resume to continue from persisted coverage.';
      store.saveJob(this.job);
    }
  }

  status(): Status {
    return {
      configured: this.client !== null, historyStart: this.historyStart, coverage: this.store.coverage(),
      job: this.job ? { ...this.job } : null, lastSuccessfulSync: this.store.setting('lastSuccessfulSync'),
    };
  }

  start(start: string, end: string, mode: SyncJob['mode']): void {
    if (!this.client) throw new GarminError('Configure GARMIN_API_KEY in the backend .env file and restart the server.');
    if (this.job?.state === 'running') throw new GarminError('A sync is already running.');
    this.controller = new AbortController();
    this.job = {
      start, end, mode, state: 'running', completed: 0,
      total: datesBetween(start, end).length * 3, source: null, currentDate: null, error: null,
    };
    this.store.saveJob(this.job);
    const job = this.job;
    this.running = this.run(this.client, job, this.controller.signal).catch((error: unknown) => {
      job.state = 'failed';
      job.error = 'Could not persist sync state. Check database access and available disk space.';
      console.error('Could not persist sync state:', error instanceof Error ? error.name : 'Unknown error');
    }).finally(() => {
      if (this.job === job) {
        this.running = null;
        this.controller = null;
      }
    });
  }

  cancel(): void { this.controller?.abort(); }

  async stop(): Promise<void> {
    this.cancel();
    await this.running;
  }

  private async run(client: GarminClient, job: SyncJob, signal: AbortSignal): Promise<void> {
    try {
      const recent = addDays(localToday(), -6);
      for (const source of ['hrv', 'rhr', 'activities'] satisfies Source[]) {
        job.source = source;
        const covered = this.store.covered(source, job.start, job.end);
        const dates = datesBetween(job.start, job.end);
        for (let index = 0; index < dates.length;) {
          signal.throwIfAborted();
          const start = dates[index];
          if (job.mode === 'resume' && covered.has(start) && start < recent) {
            job.completed++;
            index++;
            continue;
          }
          let last = index;
          if (source !== 'rhr') {
            while (last + 1 < dates.length && last - index < 27
              && !(job.mode === 'resume' && covered.has(dates[last + 1]) && dates[last + 1] < recent)) last++;
          }
          const end = dates[last];
          job.currentDate = start;
          this.store.saveJob(job);
          if (source === 'hrv') {
            const rows = await client.hrv(start, end, signal);
            signal.throwIfAborted();
            this.store.saveHrv(start, end, rows);
          } else if (source === 'rhr') {
            const value = await client.rhr(start, signal);
            signal.throwIfAborted();
            this.store.saveRhr(start, value);
          } else {
            const rows = await client.activities(start, end, signal);
            signal.throwIfAborted();
            this.store.saveActivities(start, end, rows);
          }
          job.completed += last - index + 1;
          this.store.saveJob(job);
          index = last + 1;
        }
      }
      job.state = 'complete';
      job.currentDate = null;
      job.source = null;
      this.store.setSetting('lastSuccessfulSync', new Date().toISOString());
    } catch (error) {
      job.state = signal.aborted ? 'cancelled' : 'failed';
      job.error = signal.aborted ? 'Sync cancelled. Saved dates can be resumed.'
        : error instanceof GarminError ? error.message : 'Local sync failed. Check server logs and database access.';
      if (!signal.aborted && !(error instanceof GarminError)) {
        console.error('Local sync failure:', error instanceof Error ? error.name : 'Unknown error');
      }
    } finally {
      this.store.saveJob(job);
    }
  }
}
