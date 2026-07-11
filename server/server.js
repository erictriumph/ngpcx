require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');   // ADD THIS
const db = require('./db');
const { seedFromCache } = require('./seed');

const app = express();
// Seed database from cache if empty
seedFromCache();
const PORT = process.env.PORT || 3000;

// Parse JSON request bodies
app.use(express.json());

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