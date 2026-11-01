import { useEffect, useRef, useState } from 'react';
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts';
import { addDays, isDate, localToday, monthsBefore } from '../shared/dates';
import type { Dashboard, Day, Predictor, RecoveryMetric, Status, SyncJob } from '../shared/model';

const metricNames = { hrv: 'Overnight HRV', rhr: 'Resting heart rate' };
const predictorNames = { load: 'Activity training load', duration: 'Activity duration (min)', count: 'Activity count' };
const number = (value: number | null | undefined, digits = 1) => value == null ? '--' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  if (!response.ok) {
    const body: unknown = await response.json();
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : `Local request failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected request failure occurred.';
}

function TrendChart({ days, metric, daily, average7, average28 }: {
  days: Day[]; metric: RecoveryMetric; daily: boolean; average7: boolean; average28: boolean;
}) {
  const color = metric === 'hrv' ? '#63e4bd' : '#aeb3ff';
  const data = days.map(day => ({
    date: day.date, daily: day[metric],
    seven: metric === 'hrv' ? day.hrv7.value : day.rhr7.value,
    twentyEight: metric === 'hrv' ? day.hrv28.value : day.rhr28.value,
    sevenCount: metric === 'hrv' ? day.hrv7.count : day.rhr7.count,
    twentyEightCount: metric === 'hrv' ? day.hrv28.count : day.rhr28.count,
  }));
  return <div className="chart" role="img" aria-label={`${metricNames[metric]} daily values and rolling averages`}>
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} syncId="recovery" margin={{ left: 0, right: 16, top: 8, bottom: 0 }}>
        <CartesianGrid stroke="#273447" strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="date" tickFormatter={dateLabel} minTickGap={55} tick={{ fill: '#9aabc0', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis domain={['auto', 'auto']} tick={{ fill: '#9aabc0', fontSize: 11 }} axisLine={false} tickLine={false} width={42} />
        <Tooltip content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const day = data.find(row => row.date === label);
          return <div className="tooltip"><strong>{String(label)}</strong>{payload.map(entry =>
            <div key={String(entry.dataKey)} style={{ color: entry.color }}>
              {entry.name}: {number(typeof entry.value === 'number' ? entry.value : null)}
              {entry.dataKey === 'seven' && ` (${day?.sevenCount}/7 days)`}
              {entry.dataKey === 'twentyEight' && ` (${day?.twentyEightCount}/28 days)`}
            </div>)}</div>;
        }} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, paddingTop: 14 }} />
        {daily && <Line type="linear" dataKey="daily" name="Daily" stroke={color} strokeOpacity={0.4} strokeWidth={1.3} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} connectNulls={false} />}
        {average7 && <Line type="linear" dataKey="seven" name="7-day average" stroke={color} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false} />}
        {average28 && <Line type="linear" dataKey="twentyEight" name="28-day average" stroke="#f4be70" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls={false} />}
      </ComposedChart>
    </ResponsiveContainer>
  </div>;
}

function StatCard({ title, value, unit, note, color }: { title: string; value: string; unit: string; note: string; color: string }) {
  return <article className="stat"><span className="eyebrow">{title}</span><div className="stat-value" style={{ color }}>{value}<small>{unit}</small></div><p>{note}</p></article>;
}

export function App() {
  const today = localToday();
  const [range, setRange] = useState({ start: monthsBefore(today, 3), end: today });
  const [draft, setDraft] = useState(range);
  const [preset, setPreset] = useState('3m');
  const [sport, setSport] = useState('all');
  const [sports, setSports] = useState<string[]>([]);
  const [predictor, setPredictor] = useState<Predictor>('load');
  const [metric, setMetric] = useState<RecoveryMetric>('hrv');
  const [lag, setLag] = useState(1);
  const [daily, setDaily] = useState(true);
  const [average7, setAverage7] = useState(true);
  const [average28, setAverage28] = useState(true);
  const [showLoad7, setShowLoad7] = useState(false);
  const [selectedDate, setSelectedDate] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [data, setData] = useState<Dashboard | null>(null);
  const [statusError, setStatusError] = useState('');
  const [chartError, setChartError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const lastJobState = useRef<string | undefined>(undefined);
  const running = status?.job?.state === 'running';

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    async function loadStatus() {
      try {
        const next = await api<Status>('/status', { signal: controller.signal });
        if (disposed) return;
        if (lastJobState.current === 'running' && next.job?.state !== 'running') setRevision(value => value + 1);
        lastJobState.current = next.job?.state;
        setStatus(next);
        setStatusError('');
      } catch (error) {
        if (!disposed) setStatusError(`Cannot read sync status: ${message(error)}`);
      }
    }
    void loadStatus();
    const timer = setInterval(() => { void loadStatus(); }, 2500);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setChartError('');
    const query = new URLSearchParams({ ...range, sport, predictor, metric, lag: String(lag) });
    api<Dashboard>(`/dashboard?${query}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setData(result); setSports(result.sports); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setChartError(message(error)); });
    return () => { controller.abort(); };
  }, [range, sport, predictor, metric, lag, revision]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { setRevision(value => value + 1); }, 15_000);
    return () => { clearInterval(timer); };
  }, [running]);

  function choosePreset(value: string) {
    setPreset(value);
    if (value === 'custom') return;
    const next = {
      start: value === '4w' ? addDays(today, -27) : monthsBefore(today, value === '3m' ? 3 : value === '6m' ? 6 : 12),
      end: today,
    };
    setRange(next);
    setDraft(next);
    setSelectedDate('');
  }

  async function startSync(start: string, end: string, mode: SyncJob['mode']) {
    setBusy(true);
    setActionError('');
    try {
      const next = await api<Status>('/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start, end, mode }) });
      lastJobState.current = next.job?.state;
      setStatus(next);
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  }

  async function cancel() {
    setActionError('');
    setBusy(true);
    try { await api('/sync/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  }

  const days = data?.days ?? [];
  const latestHrv = days.filter(day => day.hrv !== null).at(-1);
  const latestRhr = days.filter(day => day.rhr !== null).at(-1);
  const latestLoad = days.at(-1);
  const hasWellness = days.some(day => day.hrv !== null || day.rhr !== null);
  const hasCoverage = status?.coverage.some(source => source.days > 0);
  const correlation = data?.correlation;
  const listedActivities = (data?.activities ?? []).filter(activity => !selectedDate || activity.date === selectedDate);
  const selectedDay = days.find(day => day.date === selectedDate);
  const coveredDays = days.filter(day => day.activityCoverage).length;
  const unit = metric === 'hrv' ? 'ms' : 'bpm';
  const progress = status?.job ? Math.round(status.job.completed / status.job.total * 100) : 0;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">r<span>.</span></span><div>Recovery<span className="brand-light">Trends</span><small>YOUR PERSONAL TRAINING PICTURE</small></div></div>
      <span className="local-badge"><span className="status-dot" />LOCAL &amp; PRIVATE</span>
    </header>
    <main>
      <section className="page-heading"><div><p className="eyebrow mint">RECOVERY / OVERVIEW</p><h1>The bigger picture.</h1><p className="subtitle">Your recovery signals, in the context of your training.</p></div><div className="date-stamp">{dateLabel(today)}<span>GARMIN CONNECT PERSONAL API</span></div></section>

      <section className="sync-panel" aria-label="Garmin connection and sync">
        <div className="sync-heading"><span className={`status-dot ${status?.configured ? '' : 'muted-dot'}`} /><strong>{status ? status.configured ? 'Garmin key configured' : 'Connect your Garmin data' : 'Connecting to local server...'}</strong><span className="sync-meta">{status?.lastSuccessfulSync ? `Last complete sync ${new Date(status.lastSuccessfulSync).toLocaleString()}` : 'No complete sync yet'}</span></div>
        {!status?.configured && <p>Set <code>GARMIN_API_KEY</code> in the backend <code>.env</code> file, then restart. Your key and health data stay on this computer. Never enter your key into this page.</p>}
        <div className="sync-actions">
          <button className="primary" disabled={!status?.configured || running || busy} onClick={() => { if (status) void startSync(status.historyStart, today, 'resume'); }}>{hasCoverage ? 'Continue full-history sync' : 'Sync full history'}</button>
          <button disabled={!status?.configured || running || busy} onClick={() => { void startSync(range.start, range.end, 'refresh'); }}>Refresh selected range</button>
          {status?.job && ['cancelled', 'failed'].includes(status.job.state) && <button disabled={!status.configured || busy || running} onClick={() => { if (status.job) void startSync(status.job.start, status.job.end, 'resume'); }}>Resume interrupted range</button>}
          {running && <button disabled={busy} onClick={() => { void cancel(); }}>Cancel sync</button>}
          <span className="sync-meta">History starts {status?.historyStart ?? '2015-01-01'} &middot; refresh also supports older backfill ranges</span>
        </div>
        {status?.job && <div className="sync-progress" aria-live="polite">
          <div><span>{status.job.state === 'running' ? 'Syncing' : `Sync ${status.job.state}`} {status.job.source ? ` / ${status.job.source.toUpperCase()}` : ''}{status.job.currentDate ? ` / ${status.job.currentDate}` : ''}</span><span>{progress}% &middot; {status.job.completed.toLocaleString()} / {status.job.total.toLocaleString()} source-days</span></div>
          <progress value={status.job.completed} max={status.job.total} aria-label="Historical sync progress" />
          {status.job.error && <p className="error" role="alert">{status.job.error}</p>}
        </div>}
        {[statusError, actionError].filter(Boolean).map(error => <p className="error" role="alert" key={error}>{error}</p>)}
        {hasCoverage && <details className="coverage"><summary>Source coverage (includes successfully checked empty dates)</summary><div className="coverage-grid">{status?.coverage.map(source => <div key={source.source}><strong>{source.source.toUpperCase()}</strong><span>{source.first ?? '--'} to {source.last ?? '--'}</span><span>{source.days.toLocaleString()} checked dates; gaps may exist</span><span>{source.latestSync ? `Last updated ${new Date(source.latestSync).toLocaleString()}` : 'Not yet checked'}</span></div>)}</div></details>}
      </section>

      <section className="toolbar" aria-label="Date range and activity filters">
        <div className="segments" aria-label="Timescale">{[['4w', '4 weeks'], ['3m', '3 months'], ['6m', '6 months'], ['1y', '1 year'], ['custom', 'Custom']].map(([value, label]) => <button key={value} aria-pressed={preset === value} className={preset === value ? 'active' : ''} onClick={() => { choosePreset(value); }}>{label}</button>)}</div>
        <label className="sport-select">Activity type<select value={sport} onChange={event => { setSport(event.target.value); }}><option value="all">All activities</option>{sports.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
      </section>
      {preset === 'custom' && <form className="custom-range" onSubmit={event => {
        event.preventDefault();
        if (!isDate(draft.start) || !isDate(draft.end) || draft.start > draft.end || draft.end > today) {
          setChartError('Choose valid, ordered dates no later than today.');
          return;
        }
        setRange({ ...draft }); setSelectedDate('');
      }}><label>From<input type="date" required min="1900-01-01" max={draft.end} value={draft.start} onChange={event => { setDraft({ ...draft, start: event.target.value }); }} /></label><label>To<input type="date" required min={draft.start} max={today} value={draft.end} onChange={event => { setDraft({ ...draft, end: event.target.value }); }} /></label><button type="submit">Apply dates</button></form>}
      <div className="range-caption"><span>{range.start} &mdash; {range.end}</span><span>{sport === 'all' ? 'All activities' : sport.replaceAll('_', ' ')} &middot; Garmin calendar dates</span></div>
      {chartError && <p className="error error-banner" role="alert">{chartError} <button onClick={() => { setRevision(value => value + 1); }}>Retry</button></p>}

      <section className="stats-grid" aria-label="Latest observations within selected range">
        <StatCard title="OVERNIGHT HRV" value={number(latestHrv?.hrv)} unit="ms" color="#63e4bd" note={latestHrv ? `${latestHrv.date} / ${latestHrv.hrvStatus?.toLowerCase() ?? 'status unavailable'}` : 'No overnight observation in this range'} />
        <StatCard title="RESTING HEART RATE" value={number(latestRhr?.rhr, 0)} unit="bpm" color="#aeb3ff" note={latestRhr ? `${latestRhr.date} / latest daily observation` : 'No resting heart rate in this range'} />
        <StatCard title="7-DAY ACTIVITY LOAD" value={number(latestLoad?.load7, 0)} unit="load" color="#f4be70" note={`Ending ${range.end} / ${sport === 'all' ? 'all activities' : 'filtered activities'}`} />
        <StatCard title="ACTIVITY COVERAGE" value={number(coveredDays, 0)} unit={`/ ${days.length} days`} color="#eef2fa" note="Checked dates, not necessarily days with exercise" />
      </section>
      {!data && !chartError && <p className="notice" role="status">Loading your local data...</p>}
      {data && !hasWellness && <div className="empty-state"><span className="eyebrow mint">A LITTLE HISTORY GOES A LONG WAY</span><h2>{hasCoverage ? 'No recovery observations in this range.' : 'Your recovery story starts here.'}</h2><p>{hasCoverage ? 'Try a different date range, check source coverage, or refresh these dates.' : 'Configure your Personal API key and sync Garmin history to see your trends. Missing readings will remain gaps, never zeros.'}</p></div>}

      <section className="panel trends">
        <div className="panel-heading"><div><p className="eyebrow">01 / RECOVERY SIGNALS</p><h2>Less noise. More perspective.</h2></div><div className="toggles"><label><input type="checkbox" checked={daily} onChange={event => { setDaily(event.target.checked); }} />Daily</label><label><input type="checkbox" checked={average7} onChange={event => { setAverage7(event.target.checked); }} />7-day</label><label><input type="checkbox" checked={average28} onChange={event => { setAverage28(event.target.checked); }} />28-day</label></div></div>
        <div className="chart-heading"><h3><span className="legend-dot mint-bg" />Overnight HRV</h3><span>Milliseconds &middot; higher is not always better</span></div>
        <TrendChart days={days} metric="hrv" daily={daily} average7={average7} average28={average28} />
        <div className="chart-heading second-chart"><h3><span className="legend-dot purple-bg" />Resting heart rate</h3><span>Beats per minute</span></div>
        <TrendChart days={days} metric="rhr" daily={daily} average7={average7} average28={average28} />
        <p className="footnote">Trailing calendar-day averages require 5 of 7 or 20 of 28 valid readings. Hover for coverage. Missing days are not interpolated. Overnight HRV is shown in milliseconds, as confirmed from your Garmin display.</p>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">02 / TRAINING CONTEXT</p><h2>The work behind the numbers.</h2></div><label className="inline-toggle"><input type="checkbox" checked={showLoad7} onChange={event => { setShowLoad7(event.target.checked); }} />7-day load sum</label></div>
        <p className="panel-description">Daily activity training load {sport !== 'all' && ` / ${sport.replaceAll('_', ' ')}`}. Select a day below to inspect its activities.</p>
        <div className="chart load-chart" role="img" aria-label="Daily activity training load">
          <ResponsiveContainer width="100%" height="100%"><ComposedChart data={days} syncId="recovery" margin={{ right: 16 }}>
            <CartesianGrid stroke="#273447" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="date" tickFormatter={dateLabel} minTickGap={55} tick={{ fill: '#9aabc0', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#9aabc0', fontSize: 11 }} width={42} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: '#152133', borderColor: '#344359', borderRadius: 10 }} labelFormatter={label => String(label)} />
            <Bar dataKey="load" name="Daily load" fill="#e7b66e" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            {showLoad7 && <Line dataKey="load7" name="7-day load sum" stroke="#63e4bd" dot={false} connectNulls={false} isAnimationActive={false} />}
          </ComposedChart></ResponsiveContainer>
        </div>
        <p className="footnote">Not Garmin acute/chronic load. A missing activity-load value makes that day's total incomplete. Zero means a fully checked day with no included activities (or a reported zero load).</p>
        <div className="activity-heading"><h3>Activity log <span className="count-badge">{listedActivities.length}</span></h3><label>Inspect date<input type="date" aria-label="Inspect activity date" min={range.start} max={range.end} value={selectedDate} onChange={event => { setSelectedDate(event.target.value); }} /></label>{selectedDate && <button onClick={() => { setSelectedDate(''); }}>Show all dates</button>}</div>
        {selectedDay && <p className="notice">{selectedDay.activityCoverage ? `${selectedDay.activityCount} activities checked. ${selectedDay.loadComplete ? `Load ${number(selectedDay.load)}.` : `Load incomplete; known subtotal ${number(selectedDay.knownLoad)}.`}` : 'This day has not been synced for activities; no totals can be inferred.'}</p>}
        <div className="table-scroll"><table><thead><tr><th>Date / activity</th><th>Type</th><th>Duration</th><th>Distance</th><th>Load</th></tr></thead><tbody>{listedActivities.slice(0, 100).map(activity => <tr key={activity.id}><td><strong>{activity.name}</strong><span>{activity.startLocal}</span></td><td>{activity.sport.replaceAll('_', ' ')}</td><td>{number(activity.duration == null ? null : activity.duration / 60, 0)} min</td><td>{number(activity.distance == null ? null : activity.distance / 1000)} km</td><td>{number(activity.load, 0)}</td></tr>)}</tbody></table></div>
        {listedActivities.length === 0 && <p className="table-empty">No activities stored for these filters. Check activity coverage before interpreting this as a rest day.</p>}
        {listedActivities.length > 100 && <p className="footnote">Showing the latest 100 of {listedActivities.length.toLocaleString()} activities. Narrow the range or inspect a date for older activities. Charts include the entire range.</p>}
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">03 / CONNECT THE DOTS</p><h2>What moves together?</h2></div><span className="subtle-badge">EXPLORATORY ANALYSIS</span></div>
        <div className="analysis-controls"><label>Training signal<select value={predictor} onChange={event => {
          const value = event.target.value; if (value === 'load' || value === 'duration' || value === 'count') setPredictor(value);
        }}>{Object.entries(predictorNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Recovery signal<select value={metric} onChange={event => {
          const value = event.target.value; if (value === 'hrv' || value === 'rhr') setMetric(value);
        }}><option value="hrv">Overnight HRV</option><option value="rhr">Resting heart rate</option></select></label><label>Recovery measured<select value={lag} onChange={event => { setLag(Number(event.target.value)); }}><option value={0}>Same calendar day</option><option value={1}>1 day after training</option><option value={2}>2 days after training</option><option value={3}>3 days after training</option></select></label></div>
        <div className="correlation-layout"><div className="correlation-summary"><span className="eyebrow">PEARSON r</span><div className="correlation-value">{correlation?.coefficient == null ? '--' : correlation.coefficient.toFixed(2)}</div><p>{correlation?.reason ?? (correlation?.coefficient != null ? 'Association, not causation.' : 'Waiting for data.')}</p><strong>{correlation?.pairs.length ?? 0} paired days</strong><span>{correlation ? `${correlation.pairs.length} / ${correlation.possibleDays} possible recovery dates (${Math.round(correlation.pairs.length / Math.max(1, correlation.possibleDays) * 100)}%)` : 'Coverage unavailable'}</span></div>
          <div className="scatter-chart" role="img" aria-label={`${predictorNames[predictor]} versus ${metricNames[metric]} scatterplot`}>
            <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 12, right: 22, bottom: 35, left: 5 }}>
              <CartesianGrid stroke="#273447" strokeDasharray="3 5" />
              <XAxis type="number" dataKey="x" name={predictorNames[predictor]} tick={{ fill: '#9aabc0', fontSize: 11 }} label={{ value: predictorNames[predictor], position: 'bottom', fill: '#9aabc0', fontSize: 12 }} />
              <YAxis type="number" dataKey="y" name={metricNames[metric]} unit={` ${unit}`} domain={['auto', 'auto']} width={70} tick={{ fill: '#9aabc0', fontSize: 11 }} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const x = payload.find(entry => entry.dataKey === 'x')?.value;
                const y = payload.find(entry => entry.dataKey === 'y')?.value;
                const point: unknown = payload[0]?.payload;
                const recoveryDate = point && typeof point === 'object' && 'date' in point && typeof point.date === 'string' ? point.date : '';
                const trainingDate = point && typeof point === 'object' && 'predictorDate' in point && typeof point.predictorDate === 'string' ? point.predictorDate : '';
                return <div className="tooltip"><strong>Recovery: {recoveryDate}</strong><div>Training: {trainingDate}</div><div>{predictorNames[predictor]}: {number(typeof x === 'number' ? x : null)}</div><div>{metricNames[metric]}: {number(typeof y === 'number' ? y : null)}</div></div>;
              }} />
              <Scatter data={correlation?.pairs ?? []} fill="#63e4bd" fillOpacity={0.65} isAnimationActive={false} />
            </ScatterChart></ResponsiveContainer>
          </div>
        </div>
        <p className="footnote">{lag === 0 ? "Same-day caution: overnight HRV usually precedes that day's exercise. " : `Training on day D is paired with recovery on day D + ${lag}. `}Uses raw daily values, not rolling averages. Requires 20 complete pairs and variation in both series. Missing load is excluded; filtered activity load includes only the selected sport.</p>
        <div className="caution"><strong>Patterns are a starting point, not a verdict.</strong><p>Sleep, illness, life stress, measurement changes, and serial dependence can affect both signals. Comparing multiple lags can produce chance associations. This app does not establish causation or offer medical or training prescriptions.</p></div>
      </section>
      <footer><span>RecoveryTrends <span className="mint">/</span> Personal insights, kept personal.</span><span>Stored locally &middot; No analytics &middot; No cloud database</span></footer>
    </main>
  </div>;
}
