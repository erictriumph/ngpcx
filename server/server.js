const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON request bodies
app.use(express.json());

// Serve the public folder (HTML/JS front end)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
const scanRoute = require('./routes/scan');
app.use('/api', scanRoute);

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

// Start the server
app.listen(PORT, () => {
  console.log(`NGPCX server running at http://localhost:${PORT}`);
});