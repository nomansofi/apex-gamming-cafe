const express = require('express');
const path = require('path');
const os = require('os');
const { db, getSettings, getSessionSnacksTotal, getDeviceRates } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function parseSettings() {
  const raw = getSettings();
  return {
    MINIMUM_CHARGE: parseFloat(raw.MINIMUM_CHARGE) || 50,
    CURRENCY_SYMBOL: raw.CURRENCY_SYMBOL || '₹',
  };
}

function sessionAmount(durationLimit, rate30, rate60, minimumCharge) {
  const amount = durationLimit === 60 ? rate60 : rate30;
  return Math.max(amount, minimumCharge);
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Devices ──────────────────────────────────────────────────────────────────

app.get('/api/devices', (_req, res) => {
  const devices = db
    .prepare(
      `SELECT * FROM devices ORDER BY type, COALESCE(station_label, name), id`
    )
    .all();
  res.json(devices);
});

app.post('/api/devices', (req, res) => {
  const { name, type, rate_30min, rate_60min, rate_30min_2p, rate_60min_2p, station_label } = req.body;
  if (!name || !type || rate_30min == null || rate_60min == null) {
    return res.status(400).json({ error: 'name, type, rate_30min, and rate_60min are required' });
  }
  const validTypes = ['TV', 'Console', 'Simulator', 'PC'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid device type' });
  }
  const r30 = parseFloat(rate_30min);
  const r60 = parseFloat(rate_60min);
  const r30_2p = type === 'TV' ? parseFloat(rate_30min_2p ?? rate_30min) : null;
  const r60_2p = type === 'TV' ? parseFloat(rate_60min_2p ?? rate_60min) : null;
  const station = type === 'TV' ? station_label || name : null;
  const result = db
    .prepare(
      `INSERT INTO devices (name, type, hourly_rate, rate_30min, rate_60min, rate_30min_2p, rate_60min_2p, status, station_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`
    )
    .run(name, type, r60, r30, r60, r30_2p, r60_2p, station);
  res.status(201).json(db.prepare('SELECT * FROM devices WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/devices/:id/pricing', (req, res) => {
  const { rate_30min, rate_60min, rate_30min_2p, rate_60min_2p } = req.body;
  if (rate_30min == null || rate_60min == null) {
    return res.status(400).json({ error: 'rate_30min and rate_60min are required' });
  }
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const r30 = parseFloat(rate_30min);
  const r60 = parseFloat(rate_60min);
  if (device.type === 'TV') {
    const r30_2p = parseFloat(rate_30min_2p ?? device.rate_30min_2p ?? r30);
    const r60_2p = parseFloat(rate_60min_2p ?? device.rate_60min_2p ?? r60);
    db.prepare(
      `UPDATE devices SET rate_30min = ?, rate_60min = ?, rate_30min_2p = ?, rate_60min_2p = ?, hourly_rate = ? WHERE id = ?`
    ).run(r30, r60, r30_2p, r60_2p, r60, req.params.id);
  } else {
    db.prepare('UPDATE devices SET rate_30min = ?, rate_60min = ?, hourly_rate = ? WHERE id = ?').run(
      r30,
      r60,
      r60,
      req.params.id
    );
  }
  res.json(db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id));
});

app.delete('/api/devices/:id', (req, res) => {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const active = db
    .prepare("SELECT id FROM sessions WHERE device_id = ? AND status = 'active'")
    .get(req.params.id);
  if (active) {
    return res.status(409).json({ error: 'Cannot delete device with an active session' });
  }
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

app.post('/api/sessions/start', (req, res) => {
  const { device_id, duration_limit, player_count } = req.body;
  if (!device_id || duration_limit == null) {
    return res.status(400).json({ error: 'device_id and duration_limit are required' });
  }
  const limit = parseInt(duration_limit, 10);
  if (![30, 60].includes(limit)) {
    return res.status(400).json({ error: 'duration_limit must be 30 or 60' });
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.status === 'occupied') {
    return res.status(409).json({ error: 'Device is already occupied' });
  }

  let players = parseInt(player_count, 10) || 1;
  if (device.type === 'TV') {
    if (![1, 2].includes(players)) {
      return res.status(400).json({ error: 'player_count must be 1 or 2 for TV' });
    }
  } else {
    players = 1;
  }

  const startTime = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO sessions (device_id, customer_name, session_type, start_time, duration_limit, player_count, status)
       VALUES (?, '', 'pre-paid', ?, ?, ?, 'active')`
    )
    .run(device_id, startTime, limit, players);

  db.prepare("UPDATE devices SET status = 'occupied' WHERE id = ?").run(device_id);

  res.status(201).json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/sessions/extend/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') {
    return res.status(409).json({ error: 'Session is not active' });
  }
  if (session.duration_limit !== 30) {
    return res.status(400).json({ error: 'Only active 30-minute sessions can be extended' });
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(session.device_id);
  const rates = getDeviceRates(device, session.player_count || 1);
  db.prepare('UPDATE sessions SET duration_limit = 60 WHERE id = ?').run(req.params.id);

  const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  res.json({
    ...updated,
    extension_cost: rates.rate_60min - rates.rate_30min,
    ...rates,
  });
});

app.put('/api/sessions/stop/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') {
    return res.status(409).json({ error: 'Session is not active' });
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(session.device_id);
  const settings = parseSettings();
  const endTime = new Date();
  const totalMinutes = Math.ceil((endTime - new Date(session.start_time)) / 60000);

  const rates = getDeviceRates(device, session.player_count || 1);
  const gamingAmount = sessionAmount(
    session.duration_limit,
    rates.rate_30min,
    rates.rate_60min,
    settings.MINIMUM_CHARGE
  );
  const snacksTotal = getSessionSnacksTotal(session.id);
  const totalAmount = Math.round((gamingAmount + snacksTotal) * 100) / 100;

  db.prepare(
    `UPDATE sessions SET end_time = ?, total_minutes = ?, gaming_amount = ?, snacks_total = ?,
     total_amount = ?, status = 'completed' WHERE id = ?`
  ).run(endTime.toISOString(), totalMinutes, gamingAmount, snacksTotal, totalAmount, req.params.id);

  db.prepare("UPDATE devices SET status = 'available' WHERE id = ?").run(session.device_id);

  const snackLines = db
    .prepare(
      `SELECT ss.*, s.name AS snack_name FROM session_snacks ss
       JOIN snacks s ON ss.snack_id = s.id WHERE ss.session_id = ?`
    )
    .all(session.id);

  const completed = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  res.json({
    ...completed,
    device_name: device.name,
    device_type: device.type,
    station_label: device.station_label,
    player_count: session.player_count || 1,
    rate_30min: rates.rate_30min,
    rate_60min: rates.rate_60min,
    snack_lines: snackLines,
  });
});

app.get('/api/sessions/active/:deviceId', (req, res) => {
  const session = db
    .prepare("SELECT * FROM sessions WHERE device_id = ? AND status = 'active'")
    .get(req.params.deviceId);
  if (!session) return res.json(null);
  const snackLines = db
    .prepare(
      `SELECT ss.*, s.name AS snack_name FROM session_snacks ss
       JOIN snacks s ON ss.snack_id = s.id WHERE ss.session_id = ? ORDER BY ss.id`
    )
    .all(session.id);
  res.json({
    ...session,
    snacks_total: getSessionSnacksTotal(session.id),
    snack_lines: snackLines,
  });
});

// ── Snacks ───────────────────────────────────────────────────────────────────

app.get('/api/snacks', (_req, res) => {
  res.json(db.prepare('SELECT * FROM snacks WHERE active = 1 ORDER BY category, name').all());
});

app.post('/api/snacks', (req, res) => {
  const { name, price, category } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ error: 'name and price are required' });
  }
  const result = db
    .prepare('INSERT INTO snacks (name, price, category) VALUES (?, ?, ?)')
    .run(name, parseFloat(price), category || 'Snacks');
  res.status(201).json(db.prepare('SELECT * FROM snacks WHERE id = ?').get(result.lastInsertRowid));
});

app.delete('/api/snacks/:id', (req, res) => {
  db.prepare('UPDATE snacks SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/sessions/:id/snacks', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') {
    return res.status(409).json({ error: 'Session is not active' });
  }

  const { snack_id, quantity } = req.body;
  if (!snack_id) return res.status(400).json({ error: 'snack_id is required' });
  const snack = db.prepare('SELECT * FROM snacks WHERE id = ? AND active = 1').get(snack_id);
  if (!snack) return res.status(404).json({ error: 'Snack not found' });

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const lineTotal = Math.round(snack.price * qty * 100) / 100;
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO session_snacks (session_id, snack_id, quantity, unit_price, line_total, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(session.id, snack.id, qty, snack.price, lineTotal, now);

  const line = db
    .prepare(
      `SELECT ss.*, s.name AS snack_name FROM session_snacks ss
       JOIN snacks s ON ss.snack_id = s.id WHERE ss.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json({
    line,
    snacks_total: getSessionSnacksTotal(session.id),
  });
});

app.delete('/api/session-snacks/:id', (req, res) => {
  const line = db.prepare('SELECT * FROM session_snacks WHERE id = ?').get(req.params.id);
  if (!line) return res.status(404).json({ error: 'Line item not found' });
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(line.session_id);
  if (session.status !== 'active') {
    return res.status(409).json({ error: 'Cannot modify completed session' });
  }
  db.prepare('DELETE FROM session_snacks WHERE id = ?').run(req.params.id);
  res.json({ snacks_total: getSessionSnacksTotal(line.session_id) });
});

// ── Cash register ────────────────────────────────────────────────────────────

app.get('/api/cash', (req, res) => {
  const date = req.query.date || todayDateStr();
  const logs = db
    .prepare('SELECT * FROM cash_logs WHERE log_date = ? ORDER BY created_at DESC')
    .all(date);
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(offline_amount), 0) AS offline,
              COALESCE(SUM(online_amount), 0) AS online
       FROM cash_logs WHERE log_date = ?`
    )
    .get(date);
  res.json({ date, logs, totals });
});

app.get('/api/cash/summary', (_req, res) => {
  const all = db
    .prepare(
      `SELECT COALESCE(SUM(offline_amount), 0) AS offline,
              COALESCE(SUM(online_amount), 0) AS online
       FROM cash_logs`
    )
    .get();
  const today = db
    .prepare(
      `SELECT COALESCE(SUM(offline_amount), 0) AS offline,
              COALESCE(SUM(online_amount), 0) AS online
       FROM cash_logs WHERE log_date = ?`
    )
    .get(todayDateStr());
  res.json({ all_time: all, today });
});

app.post('/api/cash', (req, res) => {
  const { offline_amount, online_amount, notes, log_date } = req.body;
  if (offline_amount == null && online_amount == null) {
    return res.status(400).json({ error: 'offline_amount or online_amount required' });
  }
  const offline = parseFloat(offline_amount) || 0;
  const online = parseFloat(online_amount) || 0;
  if (offline < 0 || online < 0) {
    return res.status(400).json({ error: 'Amounts cannot be negative' });
  }
  const date = log_date || todayDateStr();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO cash_logs (log_date, offline_amount, online_amount, notes, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(date, offline, online, notes || '', now);
  res.status(201).json(db.prepare('SELECT * FROM cash_logs WHERE id = ?').get(result.lastInsertRowid));
});

app.delete('/api/cash/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM cash_logs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Entry not found' });
  db.prepare('DELETE FROM cash_logs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── History & Stats ──────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const { date } = req.query;
  let sql = `
    SELECT s.*, d.name AS device_name, d.type AS device_type,
           d.station_label, s.player_count
    FROM sessions s
    JOIN devices d ON s.device_id = d.id
    WHERE s.status = 'completed'`;
  const params = [];
  if (date) {
    sql += ' AND date(s.end_time) = date(?)';
    params.push(date);
  }
  sql += ' ORDER BY s.end_time DESC';
  res.json(db.prepare(sql).all(...params));
});

app.delete('/api/history/clear/all', (_req, res) => {
  const rows = db.prepare("SELECT id FROM sessions WHERE status = 'completed'").all();
  const clear = db.transaction((ids) => {
    for (const { id } of ids) {
      db.prepare('DELETE FROM session_snacks WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
  });
  clear(rows);
  res.json({ success: true, deleted: rows.length });
});

app.delete('/api/history/clear/by-date/:date', (req, res) => {
  const rows = db
    .prepare("SELECT id FROM sessions WHERE status = 'completed' AND date(end_time) = date(?)")
    .all(req.params.date);
  const clear = db.transaction((ids) => {
    for (const { id } of ids) {
      db.prepare('DELETE FROM session_snacks WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
  });
  clear(rows);
  res.json({ success: true, deleted: rows.length, date: req.params.date });
});

app.delete('/api/history/:id', (req, res) => {
  const session = db
    .prepare("SELECT id FROM sessions WHERE id = ? AND status = 'completed'")
    .get(req.params.id);
  if (!session) return res.status(404).json({ error: 'History record not found' });
  db.prepare('DELETE FROM session_snacks WHERE session_id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/stats', (_req, res) => {
  const revenue = db
    .prepare("SELECT COALESCE(SUM(total_amount), 0) AS total FROM sessions WHERE status = 'completed'")
    .get();
  const gaming = db
    .prepare("SELECT COALESCE(SUM(gaming_amount), 0) AS total FROM sessions WHERE status = 'completed'")
    .get();
  const snacksRev = db
    .prepare("SELECT COALESCE(SUM(snacks_total), 0) AS total FROM sessions WHERE status = 'completed'")
    .get();
  const hours = db
    .prepare("SELECT COALESCE(SUM(total_minutes), 0) AS total FROM sessions WHERE status = 'completed'")
    .get();
  const popular = db
    .prepare(
      `SELECT d.type, COUNT(*) AS count FROM sessions s
       JOIN devices d ON s.device_id = d.id WHERE s.status = 'completed'
       GROUP BY d.type ORDER BY count DESC LIMIT 1`
    )
    .get();
  const cash = db
    .prepare(
      `SELECT COALESCE(SUM(offline_amount), 0) AS offline,
              COALESCE(SUM(online_amount), 0) AS online FROM cash_logs`
    )
    .get();

  res.json({
    total_revenue: revenue.total,
    gaming_revenue: gaming.total,
    snacks_revenue: snacksRev.total,
    total_hours: Math.round((hours.total / 60) * 100) / 100,
    most_popular_type: popular ? popular.type : 'N/A',
    cash_offline: cash.offline,
    cash_online: cash.online,
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(parseSettings());
});

app.put('/api/settings', (req, res) => {
  const { MINIMUM_CHARGE, CURRENCY_SYMBOL } = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  if (MINIMUM_CHARGE != null) upsert.run('MINIMUM_CHARGE', String(MINIMUM_CHARGE));
  if (CURRENCY_SYMBOL != null) upsert.run('CURRENCY_SYMBOL', String(CURRENCY_SYMBOL));
  res.json(parseSettings());
});

function getLocalAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nApex Gaming Cafe is running:\n`);
  console.log(`  On this computer:  http://localhost:${PORT}`);
  const ips = getLocalAddresses();
  if (ips.length) {
    console.log(`  On other devices (same Wi‑Fi):`);
    for (const ip of ips) console.log(`    → http://${ip}:${PORT}`);
  } else {
    console.log(`  On other devices: use this Mac's Wi‑Fi IP with port ${PORT}`);
  }
  console.log('');
});
