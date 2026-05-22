'use strict';

const express      = require('express');
const session      = require('express-session');
const rateLimit    = require('express-rate-limit');
const fetch        = (...a) => import('node-fetch').then(({default: f}) => f(...a));
const path         = require('path');
const crypto       = require('crypto');

// ─── Config (all from environment variables) ──────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const ACCESS_PIN    = (process.env.ACCESS_PIN   || '1234').trim();
const SESSION_SECRET= process.env.SESSION_SECRET|| crypto.randomBytes(32).toString('hex');
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  || '';
const GEMINI_KEY    = process.env.GEMINI_API_KEY|| '';

const RAPIDAPI_HOST = 'irctc1.p.rapidapi.com';
const PNR_API_HOST  = 'irctc-indian-railway-pnr-status.p.rapidapi.com';
const GEMINI_URL    = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

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
});
