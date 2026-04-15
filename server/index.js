require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const db = new sqlite3.Database('./cip_database.sqlite', (err) => {
  if (err) console.error(err.message);
  console.log('Connected to the SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      pin TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cip_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_name TEXT,
      start_time TEXT,
      end_time TEXT,
      status TEXT DEFAULT 'in_progress'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cip_step_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER,
      step_number INTEGER,
      step_description TEXT,
      start_time TEXT,
      end_time TEXT,
      pressure REAL,
      brix REAL,
      ph REAL,
      remarks TEXT,
      image_path TEXT,
      UNIQUE(batch_id, step_number),
      FOREIGN KEY (batch_id) REFERENCES cip_batches (id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS production_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      line_name TEXT,
      flavor TEXT,
      batch TEXT,
      operator_name TEXT,
      cip_count TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cip_line2_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_name TEXT,
      date TEXT,
      sku TEXT,
      line TEXT,
      flavor TEXT,
      created_at TEXT,
      status TEXT DEFAULT 'in_progress'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS cip_line2_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      row_no INTEGER,
      data TEXT,
      UNIQUE(session_id, row_no),
      FOREIGN KEY (session_id) REFERENCES cip_line2_sessions(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS cip_line2_back (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER UNIQUE,
      data TEXT,
      FOREIGN KEY (session_id) REFERENCES cip_line2_sessions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cip_line1_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_name TEXT,
      date TEXT,
      sku TEXT,
      created_at TEXT,
      status TEXT DEFAULT 'in_progress'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS cip_line1_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      row_no INTEGER,
      data TEXT,
      UNIQUE(session_id, row_no),
      FOREIGN KEY (session_id) REFERENCES cip_line1_sessions(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS cip_line1_extra (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      section TEXT,
      data TEXT,
      UNIQUE(session_id, section),
      FOREIGN KEY (session_id) REFERENCES cip_line1_sessions(id)
    )`);

    db.run("DELETE FROM operators");
    const insertOp = db.prepare("INSERT OR IGNORE INTO operators (name, pin) VALUES (?, ?)");
    insertOp.run("จักรกฤษ พูลสวัสดิ์", "1234");
    insertOp.run("พัฒพริศ อ่ำอยู่", "1234");
    insertOp.run("อนุวัตร สุวรรณวงค์", "1234");
    insertOp.finalize();
});

// ─── CIP Line 2 API ───────────────────────────────────────────────────────────
app.post('/api/cip-line2/start', (req, res) => {
  const { operatorName, date, sku, line, flavor } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  db.run(`INSERT INTO cip_line2_sessions (operator_name, date, sku, line, flavor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [operatorName, date, sku, line, flavor, now],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, sessionId: this.lastID });
    }
  );
});

app.post('/api/cip-line2/row', (req, res) => {
  const { sessionId, rowNo, data } = req.body;
  db.run(`INSERT INTO cip_line2_rows (session_id, row_no, data) VALUES (?, ?, ?)
    ON CONFLICT(session_id, row_no) DO UPDATE SET data = excluded.data`,
    [sessionId, rowNo, JSON.stringify(data)],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // ส่งแจ้งเตือนเมื่อกด Stop (มี endTime)
      if (data.endTime) {
        db.get(`SELECT * FROM cip_line2_sessions WHERE id = ?`, [sessionId], (err2, session) => {
          if (!err2 && session) {
            sendToTelegram([
              `📋 <b>CIP Line 2 — Batch เสร็จสิ้น</b>`,
              `NO.${rowNo} | ${session.sku || ''} ${session.flavor || ''}`,
              `📍 ${session.line || ''} | 👤 ${session.operator_name}`,
              `📅 ${session.date}`,
              data.startTime ? `⏱ เริ่ม: ${data.startTime}` : null,
              data.endTime   ? `⏱ จบ: ${data.endTime}` : null,
              data.pump1Pressure ? `💨 Pump1: ${data.pump1Pressure} Bar` : null,
              data.pump2Pressure ? `💨 Pump2: ${data.pump2Pressure} Bar` : null,
              data.ph   ? `🧪 pH: ${data.ph}` : null,
              data.brix ? `🍬 Brix: ${data.brix}` : null,
            ].filter(Boolean).join('\n'));
          }
        });
      }

      res.json({ success: true });
    }
  );
});

app.post('/api/cip-line2/back', (req, res) => {
  const { sessionId, data } = req.body;
  db.run(`INSERT INTO cip_line2_back (session_id, data) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`,
    [sessionId, JSON.stringify(data)],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.post('/api/cip-line2/finish', (req, res) => {
  const { sessionId } = req.body;
  db.run(`UPDATE cip_line2_sessions SET status = 'completed' WHERE id = ?`, [sessionId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// ─── CIP Line 1 API ───────────────────────────────────────────────────────────
app.post('/api/cip-line1/start', (req, res) => {
  const { operatorName, date, sku } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  db.run(`INSERT INTO cip_line1_sessions (operator_name, date, sku, created_at) VALUES (?, ?, ?, ?)`,
    [operatorName, date, sku, now],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, sessionId: this.lastID });
    }
  );
});

app.post('/api/cip-line1/row', (req, res) => {
  const { sessionId, rowNo, data } = req.body;
  db.run(`INSERT INTO cip_line1_rows (session_id, row_no, data) VALUES (?, ?, ?)
    ON CONFLICT(session_id, row_no) DO UPDATE SET data = excluded.data`,
    [sessionId, rowNo, JSON.stringify(data)],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.post('/api/cip-line1/extra', (req, res) => {
  const { sessionId, section, data } = req.body;
  db.run(`INSERT INTO cip_line1_extra (session_id, section, data) VALUES (?, ?, ?)
    ON CONFLICT(session_id, section) DO UPDATE SET data = excluded.data`,
    [sessionId, section, JSON.stringify(data)],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.post('/api/cip-line1/finish', (req, res) => {
  const { sessionId } = req.body;
  db.run(`UPDATE cip_line1_sessions SET status = 'completed' WHERE id = ?`, [sessionId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

const sendToTelegram = async (message) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    });
  } catch (error) {
    console.error('Telegram error:', error.message);
  }
};

app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  db.get("SELECT name FROM operators WHERE pin = ?", [pin], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) res.json({ success: true, name: row.name });
    else res.status(401).json({ success: false, message: 'PIN ไม่ถูกต้อง' });
  });
});

app.get('/api/operators', (req, res) => {
  db.all("SELECT name FROM operators", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.name));
  });
});

app.post('/api/batches/start', (req, res) => {
  const { operatorName } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  db.run("INSERT INTO cip_batches (operator_name, start_time) VALUES (?, ?)", [operatorName, now], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, batchId: this.lastID });
  });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ imagePath: `/uploads/${req.file.filename}` });
});

app.post('/api/steps/log', upload.single('image'), (req, res) => {
  const { batchId, stepNumber, stepDescription, startTime, endTime, pressure, brix, ph, remarks } = req.body;
  const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

  const query = `
    INSERT INTO cip_step_logs (batch_id, step_number, step_description, start_time, end_time, pressure, brix, ph, remarks, image_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id, step_number) DO UPDATE SET
      end_time = COALESCE(excluded.end_time, end_time),
      pressure = COALESCE(excluded.pressure, pressure),
      brix = COALESCE(excluded.brix, brix),
      ph = COALESCE(excluded.ph, ph),
      remarks = COALESCE(excluded.remarks, remarks),
      image_path = COALESCE(excluded.image_path, image_path)
  `;

  db.run(query, [batchId, stepNumber, stepDescription, startTime, endTime, pressure, brix, ph, remarks, imagePath], function(err) {
    if (err) return res.status(500).json({ error: err.message });

    // ส่งแจ้งเตือนเข้า LINE เฉพาะตอน step เสร็จสมบูรณ์ (มี endTime) เพื่อไม่ให้ยิง API เกินโควต้า
    if (endTime) {
      const fullQuery = `
        SELECT s.*, b.operator_name FROM cip_step_logs s
        LEFT JOIN cip_batches b ON s.batch_id = b.id
        WHERE s.batch_id = ? AND s.step_number = ?
      `;
      db.get(fullQuery, [batchId, stepNumber], (err2, row) => {
        if (!err2 && row) {
          const msg = [
            `📋 <b>CIP Step เสร็จสิ้น</b>`,
            `Batch #${row.batch_id} | Step ${row.step_number}: ${row.step_description}`,
            `👤 ผู้ดำเนินการ: ${row.operator_name}`,
            `⏱ เริ่ม: ${row.start_time}`,
            `⏱ จบ: ${row.end_time}`,
            row.pressure ? `💨 Pressure: ${row.pressure}` : null,
            row.brix     ? `🍬 Brix: ${row.brix}` : null,
            row.ph       ? `🧪 pH: ${row.ph}` : null,
            row.remarks  ? `💬 หมายเหตุ: ${row.remarks}` : null,
          ].filter(Boolean).join('\n');
          sendToTelegram(msg);
        }
      });
    }

    res.json({ success: true, imagePath });
  });
});

app.post('/api/batches/finish', (req, res) => {
  const { batchId } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  db.run("UPDATE cip_batches SET end_time = ?, status = 'completed' WHERE id = ?", [now, batchId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    
    sendToTelegram([
      `✅ <b>CIP Batch จบแล้ว</b>`,
      `Batch #${batchId}`,
      `⏰ เวลาจบ: ${now}`,
    ].join('\n'));

    res.json({ success: true, endTime: now });
  });
});

app.post('/api/production/log', (req, res) => {
  const { line, flavor, batch, operator, timestamp, cipCount } = req.body;
  const fmtTime = timestamp ? new Date(timestamp).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T') : null;
  const query = `INSERT INTO production_logs (timestamp, line_name, flavor, batch, operator_name, cip_count) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(query, [fmtTime, line, flavor, batch, operator, cipCount], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    sendToTelegram([
      `🏭 <b>บันทึกการผลิต</b>`,
      `📍 Line: ${line} | รสชาติ: ${flavor}`,
      `📦 Batch: ${batch}`,
      `👤 ผู้ดำเนินการ: ${operator}`,
      cipCount ? `🧼 CIP: ${cipCount}` : null,
      `⏰ เวลา: ${fmtTime}`,
    ].filter(Boolean).join('\n'));
    res.json({ success: true, logId: this.lastID });
  });
});

app.get('/api/batches', (req, res) => {
  db.all("SELECT * FROM cip_batches ORDER BY id DESC LIMIT 50", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/steps', (req, res) => {
  const query = `
    SELECT s.*, b.operator_name FROM cip_step_logs s
    LEFT JOIN cip_batches b ON s.batch_id = b.id
    ORDER BY s.id DESC LIMIT 100
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/batches/reset', (req, res) => {
  db.run("DELETE FROM cip_step_logs", () => {
    db.run("DELETE FROM cip_batches", () => {
      res.json({ success: true });
    });
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});
