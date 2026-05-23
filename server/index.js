'use strict';

const express      = require('express');
const session      = require('express-session');
const rateLimit    = require('express-rate-limit');
const fetch        = (...a) => import('node-fetch').then(({default: f}) => f(...a));
const path         = require('path');
const crypto       = require('crypto');
const fs           = require('fs');

// ─── Config (all from environment variables) ──────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const ACCESS_PIN    = (process.env.ACCESS_PIN   || '1234').trim();
const SESSION_SECRET= process.env.SESSION_SECRET|| crypto.randomBytes(32).toString('hex');
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  || '';
const GEMINI_KEY    = process.env.GEMINI_API_KEY|| '';

const RAPIDAPI_HOST = 'irctc1.p.rapidapi.com';
const PNR_API_HOST  = 'irctc-indian-railway-pnr-status.p.rapidapi.com';
const GEMINI_URL    = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// ─── Persistence ──────────────────────────────────────────────────────────────
// Reads/writes watchlist to a JSON file on disk.
// On Railway: mount a Volume at /data so this survives redeploys.
// Locally: falls back to ./watchlist.json in the project root.
const STORAGE_DIR  = process.env.STORAGE_PATH || (fs.existsSync('/data') ? '/data' : '.');
const STORAGE_FILE = path.join(STORAGE_DIR, 'watchlist.json');

function loadWatchlist() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        console.log(`[Storage] Loaded ${parsed.length} PNR(s) from ${STORAGE_FILE}`);
        return parsed;
      }
    }
  } catch (e) {
    console.warn('[Storage] Could not load watchlist:', e.message);
  }
  return [];
}

function saveWatchlist() {
  try {
    fs.mkdirSync(path.dirname(STORAGE_FILE), { recursive: true });
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(watchState.entries, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Storage] Could not save watchlist:', e.message);
  }
}

const app = express();
app.set('trust proxy', 1); // trust Railway's reverse proxy for IP detection

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000 // 12 hours
  }
}));

// ─── Rate limiter for PIN attempts ────────────────────────────────────────────
// 5 attempts per 15 minutes per IP — server-enforced, cannot be bypassed by
// clearing browser storage or refreshing
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15-minute window
  max: 5,                       // max 5 attempts
  skipSuccessfulRequests: true, // only count failures
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    // resetTime is a Date in express-rate-limit v7
    const resetMs = req.rateLimit.resetTime instanceof Date
      ? req.rateLimit.resetTime.getTime() - Date.now()
      : (req.rateLimit.resetTime || 0);
    const minsLeft = Math.max(1, Math.ceil(resetMs / 60000));
    res.status(429).json({
      ok: false,
      error: `Too many attempts. Try again in ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}.`,
      retryAfter: minsLeft
    });
  }
});

// ─── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  res.status(401).json({ ok: false, error: 'Not authenticated.' });
}

// ─── PIN endpoint ─────────────────────────────────────────────────────────────
app.post('/auth/login', pinLimiter, (req, res) => {
  const { pin } = req.body;
  if (!pin || typeof pin !== 'string') {
    return res.status(400).json({ ok: false, error: 'PIN required.' });
  }

  // Constant-time comparison to prevent timing attacks
  const supplied = Buffer.from(pin.trim().padEnd(64));
  const correct  = Buffer.from(ACCESS_PIN.padEnd(64));
  const match    = supplied.length === correct.length &&
                   crypto.timingSafeEqual(supplied, correct);

  if (match) {
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Session error.' });
      req.session.authed = true;
      req.session.at = Date.now();
      res.json({ ok: true });
    });
  } else {
    // Don't reveal remaining attempts (the limiter header does that)
    res.status(401).json({ ok: false, error: 'Incorrect PIN.' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/status', (req, res) => {
  res.json({ authed: !!req.session?.authed });
});

// ─── IRCTC proxy ──────────────────────────────────────────────────────────────
// All RapidAPI calls go through here — the key never leaves the server
app.get('/api/proxy', requireAuth, async (req, res) => {
  if (!RAPIDAPI_KEY) return res.status(503).json({ ok: false, error: 'API key not configured on server.' });

  const { endpoint, ...params } = req.query;
  if (!endpoint || !endpoint.startsWith('/api/')) {
    return res.status(400).json({ ok: false, error: 'Invalid endpoint.' });
  }

  const url = new URL('https://' + RAPIDAPI_HOST + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  try {
    const upstream = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key':  RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST
      }
    });
    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Upstream error: ' + e.message });
  }
});

// ─── PNR proxy ────────────────────────────────────────────────────────────────
app.get('/api/pnr/:pnr', requireAuth, async (req, res) => {
  if (!RAPIDAPI_KEY) return res.status(503).json({ ok: false, error: 'API key not configured on server.' });

  const pnr = req.params.pnr.replace(/\D/g, ''); // digits only
  if (pnr.length < 10 || pnr.length > 10) {
    return res.status(400).json({ ok: false, error: 'Invalid PNR.' });
  }

  const url = `https://${PNR_API_HOST}/getPNRStatus/${pnr}`;
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key':  RAPIDAPI_KEY,
        'x-rapidapi-host': PNR_API_HOST
      }
    });
    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Upstream error: ' + e.message });
  }
});

// ─── Gemini proxy ─────────────────────────────────────────────────────────────
app.post('/api/gemini', requireAuth, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ ok: false, error: 'Gemini key not configured.' });

  const { contents, generationConfig } = req.body;
  if (!contents) return res.status(400).json({ ok: false, error: 'contents required.' });

  try {
    const upstream = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig })
    });
    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Gemini error: ' + e.message });
  }
});

// ─── Config endpoint (tells the frontend what's available, no secrets) ────────
app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    hasApiKey:    !!RAPIDAPI_KEY,
    hasGeminiKey: !!GEMINI_KEY
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SERVER-SIDE PNR AUTO-POLL ENGINE
//  Watchlist lives in memory (survives tab close, page refresh, etc.).
//  Frontend syncs its list on load and subscribes to updates via polling the
//  /api/watch/state endpoint (simple long-poll-free approach).
// ═══════════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// State — loaded from disk on startup, saved on every mutation
const watchState = {
  entries: loadWatchlist(), // [{ pnr, addedAt, data, lastChecked, lastChanged, alerts:[] }]
  lastCycleAt: null,    // ISO string — when the last full poll ran
  nextCycleAt: null,    // ISO string — when the next poll is scheduled
  running: false,
  timer: null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPNR(pnr) {
  const url = `https://${PNR_API_HOST}/getPNRStatus/${pnr}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': PNR_API_HOST }
  });
  return res.json();
}

function normalizePNR(raw, pnr) {
  // Mirrors the frontend normalizePNR — keeps what the UI needs
  if (!raw) return null;
  const d = raw.data || raw;
  return {
    pnrNumber:    d.pnrNumber    || pnr,
    trainNumber:  d.trainNumber  || d.trainNo || '',
    trainName:    d.trainName    || '',
    boardingStation: d.boardingStation || d.boardingStationName || '',
    destinationStation: d.destinationStation || d.destinationStationName || '',
    journeyDate:  d.journeyDate  || d.dateOfJourney || '',
    passengers:   (d.passengerList || d.passengers || []).map(p => ({
      serialNo:      p.passengerSerialNumber || p.serialNo || '',
      currentStatus: p.currentStatusDetails  || p.currentStatus || '',
      bookingStatus: p.bookingStatusDetails   || p.bookingStatus || '',
    })),
    charting:     d.chartPrepared || d.charting || false,
  };
}

function statusKey(entry) {
  return (entry.data?.passengers || []).map(p => p.currentStatus).join('|');
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

async function runPollCycle() {
  if (!RAPIDAPI_KEY || !watchState.entries.length) return;

  console.log(`[PollEngine] Starting cycle — ${watchState.entries.length} PNR(s)`);
  watchState.running = true;
  watchState.lastCycleAt = new Date().toISOString();

  for (const entry of watchState.entries) {
    const prevKey = statusKey(entry);
    try {
      const raw = await fetchPNR(entry.pnr);
      if (raw?.data || raw?.pnrNumber) {
        const fresh = normalizePNR(raw, entry.pnr);
        if (fresh) {
          const newKey = (fresh.passengers || []).map(p => p.currentStatus).join('|');
          if (prevKey && newKey !== prevKey) {
            const alert = {
              pnr:      entry.pnr,
              at:       new Date().toISOString(),
              prev:     prevKey,
              curr:     newKey,
              allCnf:   fresh.passengers.every(p => p.currentStatus?.toUpperCase().startsWith('CNF')),
            };
            entry.alerts = entry.alerts || [];
            entry.alerts.unshift(alert);
            if (entry.alerts.length > 20) entry.alerts.length = 20; // cap history
            entry.lastChanged = alert.at;
            console.log(`[PollEngine] PNR ${entry.pnr} changed: ${prevKey} → ${newKey}`);
          }
          entry.data = fresh;
        }
      }
    } catch (e) {
      console.warn(`[PollEngine] PNR ${entry.pnr} fetch failed:`, e.message);
    }
    entry.lastChecked = new Date().toISOString();
    await sleep(500); // avoid rate limits
  }

  watchState.running = false;
  saveWatchlist(); // persist updated statuses after each poll
  console.log(`[PollEngine] Cycle done`);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function schedulePollCycle() {
  clearTimeout(watchState.timer);
  if (!watchState.entries.length) {
    watchState.nextCycleAt = null;
    return;
  }
  const next = new Date(Date.now() + POLL_INTERVAL_MS);
  watchState.nextCycleAt = next.toISOString();
  watchState.timer = setTimeout(async () => {
    await runPollCycle();
    schedulePollCycle(); // reschedule
  }, POLL_INTERVAL_MS);
  console.log(`[PollEngine] Next cycle at ${watchState.nextCycleAt}`);
}

// ── Watchlist API endpoints ───────────────────────────────────────────────────

// GET /api/watch/state  — full state snapshot (what the frontend renders)
app.get('/api/watch/state', requireAuth, (req, res) => {
  res.json({
    entries:     watchState.entries.map(e => ({
      pnr:         e.pnr,
      addedAt:     e.addedAt,
      data:        e.data,
      lastChecked: e.lastChecked,
      lastChanged: e.lastChanged,
      alerts:      e.alerts || [],
    })),
    lastCycleAt: watchState.lastCycleAt,
    nextCycleAt: watchState.nextCycleAt,
    running:     watchState.running,
    intervalMs:  POLL_INTERVAL_MS,
  });
});

// POST /api/watch/add  — body: { pnr }
app.post('/api/watch/add', requireAuth, async (req, res) => {
  const pnr = String(req.body.pnr || '').replace(/\D/g, '');
  if (pnr.length !== 10) return res.status(400).json({ ok: false, error: 'Invalid PNR.' });
  if (watchState.entries.find(e => e.pnr === pnr)) {
    return res.json({ ok: true, message: 'Already watching.' });
  }

  const entry = { pnr, addedAt: new Date().toISOString(), data: null, lastChecked: null, lastChanged: null, alerts: [] };
  watchState.entries.push(entry);

  // Fetch initial data immediately
  if (RAPIDAPI_KEY) {
    try {
      const raw = await fetchPNR(pnr);
      if (raw?.data || raw?.pnrNumber) entry.data = normalizePNR(raw, pnr);
      entry.lastChecked = new Date().toISOString();
    } catch {}
  }

  // (Re)start scheduler if this is the first entry
  if (watchState.entries.length === 1) schedulePollCycle();

  saveWatchlist(); // persist new entry immediately
  res.json({ ok: true, entry });
});

// DELETE /api/watch/:pnr  — remove from watchlist
app.delete('/api/watch/:pnr', requireAuth, (req, res) => {
  const pnr = req.params.pnr.replace(/\D/g, '');
  const before = watchState.entries.length;
  watchState.entries = watchState.entries.filter(e => e.pnr !== pnr);
  if (!watchState.entries.length) {
    clearTimeout(watchState.timer);
    watchState.nextCycleAt = null;
  }
  saveWatchlist(); // persist removal
  res.json({ ok: true, removed: before !== watchState.entries.length });
});

// POST /api/watch/poll-now  — manual trigger (force immediate cycle)
app.post('/api/watch/poll-now', requireAuth, async (req, res) => {
  if (watchState.running) return res.json({ ok: false, message: 'Poll already running.' });
  // Reschedule: cancel current timer, run now, then schedule next
  clearTimeout(watchState.timer);
  res.json({ ok: true, message: 'Poll started.' }); // respond immediately
  await runPollCycle();
  schedulePollCycle();
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// Catch-all: serve index.html for any unmatched route (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RailRadar running on port ${PORT}`);
  console.log(`  API key:    ${RAPIDAPI_KEY ? 'configured ✓' : 'NOT SET — demo mode'}`);
  console.log(`  Gemini key: ${GEMINI_KEY   ? 'configured ✓' : 'NOT SET — static advice only'}`);
  console.log(`  PIN auth:   server-enforced, 5 attempts / 15 min`);
  console.log(`  Storage:    ${STORAGE_FILE}`);
  // Resume polling for any PNRs that were persisted before restart
  if (watchState.entries.length) {
    console.log(`[PollEngine] Resuming — ${watchState.entries.length} PNR(s) loaded from disk`);
    schedulePollCycle();
  }
});
