const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'cafe.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('TV', 'Console', 'Simulator', 'PC')),
    hourly_rate REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'occupied'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    session_type TEXT NOT NULL CHECK(session_type IN ('post-paid', 'pre-paid')),
    start_time TEXT NOT NULL,
    end_time TEXT,
    duration_limit INTEGER,
    total_minutes REAL,
    total_amount REAL,
    snacks_total REAL DEFAULT 0,
    gaming_amount REAL,
    player_count INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed')),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    category TEXT NOT NULL DEFAULT 'Snacks',
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS session_snacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    snack_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (snack_id) REFERENCES snacks(id)
  );

  CREATE TABLE IF NOT EXISTS cash_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,
    offline_amount REAL NOT NULL DEFAULT 0,
    online_amount REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL
  );
`);

const deviceCols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
if (!deviceCols.includes('rate_30min')) {
  db.exec('ALTER TABLE devices ADD COLUMN rate_30min REAL NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE devices ADD COLUMN rate_60min REAL NOT NULL DEFAULT 0');
  db.exec(`
    UPDATE devices SET rate_60min = hourly_rate, rate_30min = ROUND(hourly_rate * 0.5, 2)
    WHERE rate_60min = 0 AND hourly_rate > 0
  `);
}
if (!deviceCols.includes('station_label')) {
  db.exec('ALTER TABLE devices ADD COLUMN station_label TEXT');
  db.exec('ALTER TABLE devices ADD COLUMN controller_slot INTEGER');
}
if (!deviceCols.includes('rate_30min_2p')) {
  db.exec('ALTER TABLE devices ADD COLUMN rate_30min_2p REAL');
  db.exec('ALTER TABLE devices ADD COLUMN rate_60min_2p REAL');
}

const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
if (!sessionCols.includes('snacks_total')) {
  db.exec('ALTER TABLE sessions ADD COLUMN snacks_total REAL DEFAULT 0');
  db.exec('ALTER TABLE sessions ADD COLUMN gaming_amount REAL');
}
if (!sessionCols.includes('player_count')) {
  db.exec('ALTER TABLE sessions ADD COLUMN player_count INTEGER DEFAULT 1');
}

function mergeTvControllerDevices() {
  const done = db.prepare("SELECT 1 FROM settings WHERE key = 'tv_players_merged'").get();
  if (done) return;

  const stations = db
    .prepare(
      `SELECT station_label FROM devices WHERE type = 'TV' AND station_label IS NOT NULL
       GROUP BY station_label HAVING COUNT(*) >= 1`
    )
    .all();

  for (const { station_label } of stations) {
    const devs = db
      .prepare(
        'SELECT * FROM devices WHERE type = ? AND station_label = ? ORDER BY controller_slot, id'
      )
      .all('TV', station_label);

    if (devs.length === 0) continue;

    const primary = devs.find((d) => d.controller_slot === 1) || devs[0];
    const secondary = devs.find((d) => d.controller_slot === 2);

    let r30_2p = primary.rate_30min_2p || primary.rate_30min;
    let r60_2p = primary.rate_60min_2p || primary.rate_60min;
    if (secondary) {
      r30_2p = secondary.rate_30min;
      r60_2p = secondary.rate_60min;
    }

    db.prepare(
      `UPDATE devices SET name = ?, station_label = ?, controller_slot = NULL,
       rate_30min_2p = ?, rate_60min_2p = ? WHERE id = ?`
    ).run(station_label, station_label, r30_2p, r60_2p, primary.id);

    for (const d of devs) {
      if (d.id === primary.id) continue;
      const active = db
        .prepare("SELECT id FROM sessions WHERE device_id = ? AND status = 'active'")
        .get(d.id);
      if (!active && d.status === 'available') {
        db.prepare('DELETE FROM devices WHERE id = ?').run(d.id);
      }
    }
  }

  const loneTvs = db
    .prepare("SELECT * FROM devices WHERE type = 'TV' AND name LIKE '%Controller%'")
    .all();
  for (const tv of loneTvs) {
    const station = tv.station_label || tv.name.replace(/\s*·\s*Controller\s*\d+/i, '').trim();
    const slotMatch = tv.name.match(/Controller\s*(\d)/i);
    const slot = slotMatch ? parseInt(slotMatch[1], 10) : 1;
    if (slot === 1) {
      db.prepare(
        `UPDATE devices SET name = ?, station_label = ?, controller_slot = NULL,
         rate_30min_2p = COALESCE(rate_30min_2p, rate_30min),
         rate_60min_2p = COALESCE(rate_60min_2p, rate_60min) WHERE id = ?`
      ).run(station, station, tv.id);
    }
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tv_players_merged', '1')").run();
}

mergeTvControllerDevices();

db.prepare(
  `UPDATE devices SET rate_30min_2p = rate_30min, rate_60min_2p = rate_60min
   WHERE type = 'TV' AND rate_30min_2p IS NULL`
).run();

const snackCount = db.prepare('SELECT COUNT(*) AS count FROM snacks').get().count;
if (snackCount === 0) {
  const insertSnack = db.prepare('INSERT INTO snacks (name, price, category) VALUES (?, ?, ?)');
  const seedSnacks = [
    ['Cold Coffee', 60, 'Beverages'],
    ['Hot Coffee', 50, 'Beverages'],
    ['Masala Chai', 30, 'Beverages'],
    ['Coca Cola', 40, 'Beverages'],
    ['Lays Chips', 20, 'Snacks'],
    ['Samosa (2 pcs)', 40, 'Snacks'],
    ['Veg Sandwich', 80, 'Food'],
    ['Maggi', 60, 'Food'],
    ['French Fries', 70, 'Food'],
    ['Energy Drink', 90, 'Beverages'],
  ];
  for (const row of seedSnacks) insertSnack.run(...row);
}

const deviceCount = db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
if (deviceCount === 0) {
  const insertDevice = db.prepare(
    `INSERT INTO devices (name, type, hourly_rate, rate_30min, rate_60min, rate_30min_2p, rate_60min_2p, status, station_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`
  );
  const seedDevices = [
    ['TV-1', 'TV', 300, 150, 300, 120, 250, 'TV-1'],
    ['TV-2', 'TV', 300, 150, 300, 120, 250, 'TV-2'],
    ['Apex Console-1', 'Console', 400, 200, 400, null, null, null],
    ['Apex Sim-1', 'Simulator', 500, 250, 500, null, null, null],
    ['Apex PC-1', 'PC', 360, 180, 360, null, null, null],
  ];
  for (const row of seedDevices) insertDevice.run(...row);
}

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('MINIMUM_CHARGE', '50.00');
insertSetting.run('CURRENCY_SYMBOL', '₹');
db.prepare("UPDATE settings SET value = '₹' WHERE key = 'CURRENCY_SYMBOL' AND value IN ('$', 'Rs')").run();
db.prepare("UPDATE settings SET value = '50.00' WHERE key = 'MINIMUM_CHARGE' AND CAST(value AS REAL) < 10").run();

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

function getSessionSnacksTotal(sessionId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(line_total), 0) AS total FROM session_snacks WHERE session_id = ?')
    .get(sessionId);
  return row.total;
}

function getDeviceRates(device, playerCount = 1) {
  const players = device.type === 'TV' && playerCount === 2 ? 2 : 1;
  if (players === 2) {
    return {
      rate_30min: device.rate_30min_2p ?? device.rate_30min,
      rate_60min: device.rate_60min_2p ?? device.rate_60min,
    };
  }
  return { rate_30min: device.rate_30min, rate_60min: device.rate_60min };
}

module.exports = { db, getSettings, getSessionSnacksTotal, getDeviceRates };
