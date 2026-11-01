# RecoveryTrends

A personal, localhost-only Garmin recovery dashboard. Explore overnight HRV,
resting heart rate, rolling averages, activities, and exploratory training-load
correlations. No cloud database, telemetry, or Garmin password login.

## Requirements

- Node.js 22.13 or newer (Node 22 LTS is supported).
- A Garmin Connect **Personal API key**, with permission to read your health and
  activity history.
- This app uses Node's built-in SQLite. Node 22 may print an experimental SQLite
  warning; this is expected.

## Set up and run (PowerShell)

From this project directory:

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

Set `GARMIN_API_KEY` in `.env` **locally**. Do not paste the key into chat,
screenshots, browser developer tools, or source control. Leave the historical
start date as `2015-01-01`, or adjust it if needed:

```dotenv
GARMIN_API_KEY=your-personal-api-key
GARMIN_HISTORY_START=2015-01-01
PORT=3210
```

Then:

```powershell
npm run build
npm start
```

Open **http://127.0.0.1:3210**. The app listens on loopback only. Stop it with
Ctrl+C. Restart the backend after changing `.env`.

The dashboard works without a key, but sync is explicitly disabled. No synthetic
health data is inserted into your database.

### Development

```powershell
npm run dev
```

Open Vite's local URL, normally **http://127.0.0.1:5173**. Vite proxies `/api` to
the backend at port 3210. Keep that backend port for development, or update the
proxy in `vite.config.ts` if you change it. Production serves the built UI from
the same backend.

## Connect and sync

1. Configure the key locally and restart.
2. Click **Sync full history** to scan from the configured start date to today.
   This means all history within that explicit bound, not a claim that Garmin
   retains or exposes every historical measurement.
3. Watch source progress. Dates checked successfully, including empty dates,
   are persisted. No-data readings remain missing.
4. Cancel safely or stop/restart the app, then use **Resume interrupted range**.
   Resume skips already checked historical source-dates and rechecks the latest
   seven days for changes.
5. For subsequent manual updates or corrected/deleted historical activities,
   select a range and click **Refresh selected range**. This re-fetches every
   selected date. A custom range also supports older backfill.

Daily RHR needs one request per day. Full-history sync is sequential and may
involve many API calls. HRV and activities use chunks of up to 28 days; activities
are paginated in pages of 99. These are app batch sizes, not claims about Garmin
rate limits. Throttling honors `Retry-After`, with bounded retries; long throttling
pauses and repeated failures stop the job with an actionable error. Resume later.
There is no unattended/background schedule.

Per-source coverage displays the first and last checked date **and the number of
checked dates**; gaps can exist. It describes fetched dates, not sensor wear time
or observation availability. All totals and correlations use date-level coverage
internally. Cached data remains available after failure.

Data is fetched source by source (HRV, RHR, activities); the dashboard refreshes
during sync. A successful HTTP response does not prove a sensor was worn, or that
Garmin returned every possible observation. Device/account retention and API
permissions can limit results. Unexpected schemas and undocumented error
responses stop sync rather than silently recording empty history.

## What the dashboard calculates

### Recovery trends

- HRV: Garmin `hrvSummaries[].lastNightAvg`, aligned by `calendarDate`.
  Garmin status/baseline and its separately calculated `weeklyAvg` are stored
  but **not substituted for the app's rolling averages**.
- Overnight HRV is displayed in **milliseconds (ms)**, confirmed by the user from
  their Garmin display. The supplied API schema alone does not state this unit.
- RHR: `UserDailySummaryDto.restingHeartRate`, in bpm, from the daily endpoint.
  The bulk V2 `heartRate.restingValue` can fall back to absolute minimum heart
  rate; the app deliberately does **not** use that fallback as RHR.
- 7-/28-day averages use trailing **calendar** windows, including the displayed
  day, and require respectively **5/7** and **20/28** valid observations. Hover
  to see coverage. Averages use raw daily observations, not Garmin weekly values.
- The app loads the previous 27 days behind the visible range for correct
  boundary averages. Missing values stay gaps; no interpolation or zero filling.
- Periods: trailing 4 weeks, 3/6 calendar months, 1 year, or custom inclusive dates.
  Calendar-month presets clamp to valid month-end dates.
- Activity local dates are preserved even when the UTC timestamp falls on a
  different day. These are Garmin calendar-day comparisons, not hour-level
  attribution across travel/timezone changes.

### Training context

- Garmin's `activityTrainingLoad`, summed per local day, plus an optional trailing
  seven-day sum. This is **not Garmin acute/chronic load or training readiness**.
- Parent activities are included and multisport children excluded to avoid
  double counting (`excludeChildren=true`, plus defensive parent-ID filtering).
  A parent missing load remains incomplete; child load is not invented.
- A verified day without included activities has zero count, duration, and load.
  An unfetched day has unknown totals. If an activity is missing load, its day
  has incomplete load; the date inspector shows the known subtotal. Seven-day
  load sums require seven complete days.
- Activity duration is shown in minutes and distance in kilometers.
- Sport filters change activities and their load/duration/count aggregates,
  **not** the wellness signals. Charts use the whole selected range; the log
  shows the latest 100 matching activities. Narrow the range or inspect a date
  to see older entries.

### Correlations

- Pearson `r` for daily load, duration, or count against raw daily HRV/RHR.
- Lag 0 pairs the same date; lag 1/2/3 pairs training on D with recovery on
  D+1/D+2/D+3. The selected date interval refers to **recovery dates**; predictor
  dates immediately before the interval are loaded too.
- Same-day overnight HRV usually **precedes** that day's exercise. Same-day
  association is not evidence that the exercise caused that night's HRV.
- Only complete finite pairs are used; at least **20 paired days** and variation
  in both series are required. Coefficients are not shown for insufficient or
  constant data. Scatterplots may still display the available observations.
- Sample count, possible recovery days, and paired coverage are displayed.
  Unknown load/duration is excluded, not treated as zero.
- Serial dependence, multiple comparisons, sleep, illness, stress, and measurement
  changes can create misleading associations. These are descriptive exploratory
  patterns, **not causal conclusions, medical advice, or training prescriptions**.

## Authentication and privacy

The integration follows the supplied Personal API authentication contract:

```text
POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token
Authorization: ApiKey <key>
```

The token is read from the raw response body, cached only in backend memory,
and renewed before its stated 24-hour expiry. Data calls send
`Authorization: Bearer <token>`. HTTP 401 triggers at most one token renewal per
data request. Invalid keys and permission errors are surfaced explicitly.

The key is read only by the backend; it is not stored in SQLite or exposed through
the local API. Garmin request/response bodies, tokens, and keys are not logged.
Outbound API requests go only to the configured Garmin Personal API host and do
not follow redirects. No third-party fonts or analytics are loaded by the UI.

By default SQLite is stored under `data\recovery.sqlite` in this directory.
`.env`, data, build output, and dependencies are gitignored. Set
`RECOVERY_DB_PATH` to an absolute local file path if desired. Data and the `.env`
file are **not encrypted by this app**; protect them with your OS account,
filesystem permissions, and disk encryption. Avoid placing them in shared or
cloud-synced folders. Other programs/users with local filesystem access may read
them. This app is not hardened for public hosting.

To reset health data, stop the app and remove the specific SQLite file and its
`-wal`/`-shm` companions if present. To back up, stop the app and copy the database
to a protected location. Schema versioning prevents opening a newer, incompatible
database with an older build.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm audit
```

Tests cover calendar boundaries, coverage thresholds, chart lookback, load
completeness, lag direction, known Pearson outputs, API schemas/auth/retries,
pagination, resumable sync, atomic SQLite writes, restart persistence, and local
HTTP validation.

Tests use sanitized synthetic fixtures and temporary/in-memory databases, never
your real key or Garmin data. Live API behavior must be verified with your
configured key: refresh a small range first, compare daily HRV/RHR and known
activities against Garmin Connect, then run historical sync. Do not interpret
fixture tests as proof of live access or complete historical coverage.

### Troubleshooting

- **Key configured but rejected:** check key validity and Personal API scopes;
  a Garmin password, standard Connect session, or unrelated OAuth credential is
  not a Personal API key.
- **HTTP 404 / schema error for old dates:** the app does not treat undocumented
  responses as empty data. Check API retention/response semantics and adjust the
  range; report the non-secret status/schema, not raw private responses.
- **No correlation:** expand the interval, check source coverage, or choose a
  predictor with variation. At least 20 complete paired days are necessary.
- **Blank averages:** check the tooltip coverage thresholds, not just the
  visible date span.
- **No live data yet:** the empty dashboard is intentional; configure your key
  and refresh a small range to verify access.
