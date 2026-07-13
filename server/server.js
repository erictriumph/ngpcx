require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');   // ADD THIS
const cookieParser = require('cookie-parser');
const db = require('./db');
const { seedFromCache } = require('./seed');

const app = express();
// Seed database from cache if empty
seedFromCache();
const PORT = process.env.PORT || 3000;

// Railway terminates TLS at its edge — without trust proxy, Express can't see the
// request as secure, which breaks Secure-flagged cookies.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Parse JSON request bodies
app.use(express.json());
app.use(cookieParser());

// OAuth login is entirely opt-in, off by default even after this code is deployed —
// this is the deploy-readiness safeguard: turning it on in production is a deliberate
// one-line config change the operator makes only after manually confirming the Railway
// Volume (auth_sessions/users persistence) is provisioned, not something that happens
// automatically on push. See CLAUDE.md for the pre-flight verification procedure.
if (process.env.OAUTH_ENABLED === 'true') {
  if (!process.env.SESSION_SECRET) {
    console.error('OAUTH_ENABLED is true but SESSION_SECRET is not set — refusing to start.');
    process.exit(1);
  }

  const session = require('express-session');
  const passport = require('passport');
  const SqliteSessionStore = require('./sqliteSessionStore');
  const { configurePassport } = require('./passportConfig');

  configurePassport(passport);

  app.use(session({
    store: new SqliteSessionStore({ db }),
    secret: process.env.SESSION_SECRET,
    name: 'ngpcx.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  const authRoute = require('./routes/auth');
  app.use('/auth', authRoute);
}

// Public, always registered (even when OAuth is disabled) so the frontend can decide
// whether to show sign-in UI at all rather than linking to routes that don't exist.
app.get('/api/auth-status', (req, res) => {
  const enabled = process.env.OAUTH_ENABLED === 'true';
  res.json({
    enabled,
    providers: {
      google: enabled && !!process.env.GOOGLE_CLIENT_ID,
      github: enabled && !!process.env.GITHUB_CLIENT_ID,
    },
    user: req.user ? { displayName: req.user.display_name, role: req.user.role } : null,
  });
});

// Serve the public folder (HTML/JS front end)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
const scanRoute = require('./routes/scan');
app.use('/api', scanRoute);
const { classifyApps } = scanRoute;

const adminRoute = require('./routes/admin');
app.use('/api/admin', adminRoute);

const communityRoute = require('./routes/community');
app.use('/api/community', communityRoute);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'NGPCX server is running' });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const appCount = db.prepare(`SELECT COUNT(*) as count FROM apps WHERE type = 'app'`).get();
  const driverCount = db.prepare(`SELECT COUNT(*) as count FROM apps WHERE type = 'driver'`).get();
  const nativeCount = db.prepare(`SELECT COUNT(*) as count FROM apps WHERE arm_support = 'native'`).get();

  res.json({
    apps: appCount.count,
    drivers: driverCount.count,
    native: nativeCount.count,
    total: appCount.count + driverCount.count
  });
});

// Create a new scan session
app.post('/api/session', (req, res) => {
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO sessions (id, status, created_at, expires_at)
    VALUES (?, 'waiting', datetime('now'), datetime('now', '+24 hours'))
  `).run(id);

  res.json({ session_id: id });
});

// Poll for session results
app.get('/api/session/:id', (req, res) => {
  const session = db.prepare(`
    SELECT * FROM sessions WHERE id = ?
  `).get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (new Date(session.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Session expired' });
  }

  if (session.status === 'waiting') {
    return res.json({ status: 'waiting' });
  }

  res.json({
    status: 'complete',
    results: JSON.parse(session.results)
  });
});

// Re-classify a stored session's raw apps against current DB state — picks
// up anything an admin resolved or a background lookup found since the
// original scan, without needing a whole new physical scan.
app.post('/api/session/:id/refresh', (req, res) => {
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (new Date(session.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Session expired' });
  }

  if (!session.raw_apps) {
    return res.status(400).json({ error: 'This session predates refresh support — re-scan to use it.' });
  }

  const apps = JSON.parse(session.raw_apps);
  const classified = classifyApps(apps);
  const previous = JSON.parse(session.results);

  const report = {
    ...previous,
    ...classified,
    lastScanned: new Date().toISOString()
  };

  db.prepare(`UPDATE sessions SET results = ? WHERE id = ?`).run(JSON.stringify(report), req.params.id);

  res.json({ status: 'complete', results: report });
});

// Serve scanner exe with correct headers to prevent browser blocking
app.get('/ngpcx-scanner.exe', (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="ngpcx-scanner.exe"');
  res.sendFile(path.join(__dirname, '..', 'public', 'ngpcx-scanner.exe'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`NGPCX server running at http://localhost:${PORT}`);
});

// Re-run the same expiry cleanup db.js does once at startup, on a recurring basis —
// startup-only leaves expired sessions/auth_sessions/oauth_states physically on disk
// until the next restart, even though the app already treats them as inaccessible.
// Only registered here (not in db.js itself), since db.js is also required by one-off
// scripts (seed, scrapers) that need to exit normally — an interval registered at
// module load would keep those alive indefinitely.
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => db.cleanupExpiredRecords(), CLEANUP_INTERVAL_MS);