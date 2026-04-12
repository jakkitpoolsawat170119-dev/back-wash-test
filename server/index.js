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

    db.run("DELETE FROM operators WHERE name = 'นาย จักรกฤษ พูลสวัสดิ์'");
    const insertOp = db.prepare("INSERT OR IGNORE INTO operators (name, pin) VALUES (?, ?)");
    insertOp.run("พัฒพริศ อ่ำอยู่", "1234");
    insertOp.run("อนุวัตร รวรรณวงค์", "1234");
    insertOp.finalize();
});

const sendToN8n = async (data) => {
  const webhookUrl = process.env.N8N_WEBHOOK_URL || "https://n8n.m-creation.co/webhook/back-wash-test";
  try {
    await axios.post(webhookUrl, data);
  } catch (error) {
    console.error('n8n error:', error.message);
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
    
    // ส่งแจ้งเตือนรายขั้นตอนเข้า LINE
    sendToN8n({
      type: 'cip_step_logged',
      batchId,
      stepNumber,
      stepDescription,
      pressure,
      brix,
      ph,
      remarks,
      imagePath: imagePath ? `https://back-wash-test.onrender.com${imagePath}` : null
    });

    res.json({ success: true, imagePath });
  });
});

app.post('/api/batches/finish', (req, res) => {
  const { batchId } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  db.run("UPDATE cip_batches SET end_time = ?, status = 'completed' WHERE id = ?", [now, batchId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    
    // ส่งแจ้งเตือนจบงานเข้า LINE
    sendToN8n({
      type: 'cip_batch_finished',
      batchId,
      endTime: now
    });

    res.json({ success: true, endTime: now });
  });
});

app.post('/api/production/log', (req, res) => {
  const { line, flavor, batch, operator, timestamp, cipCount } = req.body;
  const fmtTime = timestamp ? new Date(timestamp).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T') : null;
  const query = `INSERT INTO production_logs (timestamp, line_name, flavor, batch, operator_name, cip_count) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(query, [fmtTime, line, flavor, batch, operator, cipCount], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    sendToN8n({ type: 'production_logged', line, flavor, batch, operator, timestamp: fmtTime, cipCount });
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
