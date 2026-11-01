import express, { type ErrorRequestHandler } from 'express';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { datesBetween, isDate, localToday } from '../shared/dates.js';
import { dashboard } from './analysis.js';
import { GarminError } from './garmin.js';
import { Store } from './store.js';
import { SyncService } from './sync.js';

const date = z.string().refine(isDate, 'Expected a valid YYYY-MM-DD date.');
const range = z.object({ start: date, end: date }).refine(
  value => value.start >= '1900-01-01' && value.start <= value.end && value.end <= localToday()
    && datesBetween(value.start, value.end).length <= 20_000,
  'Choose an ordered, non-future range of at most 20,000 days starting after 1899.',
);
const chartQuery = z.object({
  start: date, end: date, sport: z.string().max(100).default('all'),
  predictor: z.enum(['load', 'duration', 'count']).default('load'),
  metric: z.enum(['hrv', 'rhr']).default('hrv'),
  lag: z.coerce.number().int().min(0).max(3).default(1),
});

export function createApp(store: Store, sync: SyncService, staticPath = resolve('dist')) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host?.split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.status(403).json({ error: 'Only localhost access is permitted.' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin) {
        const parsed = z.url().safeParse(origin);
        if (!parsed.success || !['127.0.0.1', 'localhost'].includes(new URL(parsed.data).hostname)) {
          res.status(403).json({ error: 'Cross-origin requests are not permitted.' });
          return;
        }
      }
      if (!req.is('application/json')) {
        res.status(415).json({ error: 'Expected application/json.' });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.get('/api/status', (_req, res) => { res.json(sync.status()); });
  app.get('/api/dashboard', (req, res) => {
    const query = chartQuery.parse(req.query);
    range.parse(query);
    res.json(dashboard(store, query.start, query.end, query.sport, query.predictor, query.metric, query.lag));
  });
  app.post('/api/sync', (req, res) => {
    const input = z.object({ start: date, end: date, mode: z.enum(['resume', 'refresh']) }).parse(req.body);
    range.parse(input);
    if (sync.status().job?.state === 'running') {
      res.status(409).json({ error: 'A sync is already running.' });
      return;
    }
    sync.start(input.start, input.end, input.mode);
    res.status(202).json(sync.status());
  });
  app.post('/api/sync/cancel', (_req, res) => {
    sync.cancel();
    res.status(202).json({ message: 'Cancellation requested; saved dates are retained.' });
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown local API endpoint.' }); });
  if (existsSync(resolve(staticPath, 'index.html'))) {
    app.use(express.static(staticPath));
    app.get('/{*path}', (_req, res) => { res.sendFile(resolve(staticPath, 'index.html')); });
  }
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid date range or request options. Use valid, non-future YYYY-MM-DD dates and supported analysis settings.' });
    } else if (error instanceof GarminError) {
      res.status(503).json({ error: error.message });
    } else if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'Invalid JSON request body.' });
    } else {
      console.error('Local API failure:', error instanceof Error ? error.name : 'Unknown error');
      res.status(500).json({ error: 'Local server error. Check the server logs and database access.' });
    }
  };
  app.use(errors);
  return app;
}
