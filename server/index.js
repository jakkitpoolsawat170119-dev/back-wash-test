require('dotenv').config();
const express = require('express');
const db = require('./db');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// In-memory cache for step start times (handles out-of-order handleStart/handleStop requests)
const stepStartCache = {};

// สร้างตารางตามลำดับ (ตาราง parent ก่อน child เพราะ Postgres เช็ค FK ตอน CREATE)
// ใช้ db.pk เพื่อให้ใช้ได้ทั้ง Postgres (SERIAL) และ SQLite (AUTOINCREMENT)
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS operators (
      id ${db.pk},
      name TEXT UNIQUE,
      pin TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS cip_batches (
      id ${db.pk},
      operator_name TEXT,
      start_time TEXT,
      end_time TEXT,
      status TEXT DEFAULT 'in_progress'
    )`,
  `CREATE TABLE IF NOT EXISTS cip_step_logs (
      id ${db.pk},
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
    )`,
  `CREATE TABLE IF NOT EXISTS production_logs (
      id ${db.pk},
      timestamp TEXT,
      line_name TEXT,
      flavor TEXT,
      batch TEXT,
      operator_name TEXT,
      cip_count TEXT,
      brix REAL,
      ph REAL
    )`,
  `CREATE TABLE IF NOT EXISTS production_plans (
      id ${db.pk},
      plan_date TEXT,
      line_name TEXT,
      flavor TEXT,
      planned_batches INTEGER,
      operator_name TEXT,
      note TEXT,
      created_at TEXT,
      UNIQUE(plan_date, line_name, flavor)
    )`,
  `CREATE TABLE IF NOT EXISTS cip_line2_sessions (
      id ${db.pk},
      operator_name TEXT,
      date TEXT,
      sku TEXT,
      line TEXT,
      flavor TEXT,
      created_at TEXT,
      status TEXT DEFAULT 'in_progress'
    )`,
  `CREATE TABLE IF NOT EXISTS cip_line2_rows (
      id ${db.pk},
      session_id INTEGER,
      row_no INTEGER,
      data TEXT,
      UNIQUE(session_id, row_no),
      FOREIGN KEY (session_id) REFERENCES cip_line2_sessions(id)
    )`,
  `CREATE TABLE IF NOT EXISTS cip_line2_back (
      id ${db.pk},
      session_id INTEGER UNIQUE,
      data TEXT,
      FOREIGN KEY (session_id) REFERENCES cip_line2_sessions(id)
    )`,
  `CREATE TABLE IF NOT EXISTS cip_line1_sessions (
      id ${db.pk},
      operator_name TEXT,
      date TEXT,
      sku TEXT,
      created_at TEXT,
      status TEXT DEFAULT 'in_progress'
    )`,
  `CREATE TABLE IF NOT EXISTS cip_line1_rows (
      id ${db.pk},
      session_id INTEGER,
      row_no INTEGER,
      data TEXT,
      UNIQUE(session_id, row_no),
      FOREIGN KEY (session_id) REFERENCES cip_line1_sessions(id)
    )`,
  `CREATE TABLE IF NOT EXISTS cip_line1_extra (
      id ${db.pk},
      session_id INTEGER,
      section TEXT,
      data TEXT,
      UNIQUE(session_id, section),
      FOREIGN KEY (session_id) REFERENCES cip_line1_sessions(id)
    )`,
  `CREATE TABLE IF NOT EXISTS page_locks (
      page_key TEXT PRIMARY KEY,
      operator_name TEXT,
      started_at TEXT,
      last_seen TEXT
    )`,
  // ── To-do List / งานรายวัน ─────────────────────────────────────────────
  // แกนหลัก: งานแต่ละวันของแต่ละ Line (ผลิต/CIP/backwash/maintenance/manual)
  // UNIQUE(task_date, line_name, category, title) → สร้างงานอัตโนมัติซ้ำได้แบบ idempotent
  `CREATE TABLE IF NOT EXISTS daily_tasks (
      id ${db.pk},
      task_date TEXT,
      line_name TEXT,
      category TEXT,
      flavor TEXT,
      title TEXT,
      detail TEXT,
      target_count INTEGER,
      actual_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      source TEXT DEFAULT 'manual',
      recurring_id INTEGER,
      created_by TEXT,
      created_at TEXT,
      due_time TEXT,
      completed_at TEXT,
      UNIQUE(task_date, line_name, category, title)
    )`,
  // เทมเพลตงานประจำ (recurring) — daily/weekly/monthly
  `CREATE TABLE IF NOT EXISTS task_templates (
      id ${db.pk},
      title TEXT,
      line_name TEXT,
      category TEXT,
      cadence TEXT DEFAULT 'daily',
      weekday INTEGER,
      target_count INTEGER,
      active INTEGER DEFAULT 1,
      created_at TEXT
    )`,
  // โน้ตส่งเวร (shift handover)
  `CREATE TABLE IF NOT EXISTS handover_notes (
      id ${db.pk},
      note_date TEXT,
      shift TEXT,
      operator_name TEXT,
      text TEXT,
      created_at TEXT
    )`,
  // ประวัติบทสนทนาผู้ช่วย AI (ต่อ session — เว็บ/Telegram) เพื่อ multi-turn memory
  `CREATE TABLE IF NOT EXISTS assistant_messages (
      id ${db.pk},
      session TEXT,
      role TEXT,
      content TEXT,
      created_at TEXT
    )`,
  // สถานะงานประจำตามหน้าที่รายบุคคล (ต่อวัน) — เช็ก/ข้าม/มอบต่อ ราย node ในเช็กลิสต์
  `CREATE TABLE IF NOT EXISTS routine_state (
      id ${db.pk},
      state_date TEXT,
      assignee TEXT,
      node_key TEXT,
      title TEXT,
      checked INTEGER DEFAULT 0,
      bypassed INTEGER DEFAULT 0,
      bypass_reason TEXT,
      handoff_to TEXT,
      updated_at TEXT,
      UNIQUE(state_date, assignee, node_key)
    )`,
  // ตั้งค่าส่งรายงานอัตโนมัติ (แถวเดียว)
  `CREATE TABLE IF NOT EXISTS report_config (
      id ${db.pk},
      auto_enabled INTEGER DEFAULT 0,
      times TEXT DEFAULT '[]',
      weekdays TEXT DEFAULT '[1,2,3,4,5]',
      only_if_pending INTEGER DEFAULT 0,
      auto_at_shift_end INTEGER DEFAULT 0,
      updated_at TEXT
    )`,
  // นัดส่งรายงานครั้งเดียว (run_at = 'YYYY-MM-DDTHH:MM')
  `CREATE TABLE IF NOT EXISTS report_once (
      id ${db.pk},
      run_at TEXT,
      sent INTEGER DEFAULT 0,
      created_at TEXT
    )`,
];

const DEFAULT_OPERATORS = [
  ["จักรกฤษ พูลสวัสดิ์", "1234"],
  ["พัฒพริศ อ่ำอยู่", "1234"],
  ["อนุวัตร สุวรรณวงค์", "1234"],
];

async function initDb() {
  for (const ddl of SCHEMA) await db.exec(ddl);
  // migration: เพิ่มคอลัมน์ brix/ph ให้ production_logs (สำหรับ DB เดิมที่สร้างก่อนมีคอลัมน์นี้)
  for (const col of ['brix', 'ph']) {
    try { await db.exec(`ALTER TABLE production_logs ADD COLUMN ${col} REAL`); }
    catch { /* มีคอลัมน์อยู่แล้ว — ข้าม */ }
  }
  // migration: คอลัมน์งานมอบหมายรายบุคคลใน daily_tasks (assignee/location/priority/handoff_from)
  for (const col of ['assignee', 'location', 'priority', 'handoff_from']) {
    try { await db.exec(`ALTER TABLE daily_tasks ADD COLUMN ${col} TEXT`); }
    catch { /* มีคอลัมน์อยู่แล้ว — ข้าม */ }
  }
  // migration: เก็บ JSON โครงสร้างส่งกะ (สำหรับ "คัดลอกจากกะก่อน")
  try { await db.exec('ALTER TABLE handover_notes ADD COLUMN data TEXT'); } catch { /* มีแล้ว */ }
  try { await db.exec("ALTER TABLE handover_notes ADD COLUMN kind TEXT DEFAULT 'out'"); } catch { /* มีแล้ว */ }
  // migration: ส่งรายงานอัตโนมัติตอนสิ้นกะ (ตามตารางกะจริง)
  try { await db.exec('ALTER TABLE report_config ADD COLUMN auto_at_shift_end INTEGER DEFAULT 0'); } catch { /* มีแล้ว */ }
  // seed รายชื่อ operator (idempotent — ไม่ลบของเดิมเพื่อไม่ให้ข้อมูลหายตอน restart)
  for (const [name, pin] of DEFAULT_OPERATORS) {
    await db.exec("INSERT INTO operators (name, pin) VALUES (?, ?) ON CONFLICT (name) DO NOTHING", [name, pin]);
  }
  // seed แถวตั้งค่ารายงาน (แถวเดียว)
  const cfg = await dbAll('SELECT id FROM report_config LIMIT 1', []);
  if (!cfg.length) await db.exec("INSERT INTO report_config (auto_enabled, times, weekdays, only_if_pending, updated_at) VALUES (0, '[]', '[1,2,3,4,5]', 0, ?)", [nowBKK()]);
  console.log('[db] schema ready');
}

// ─── Page Lock API (ป้องกันการบันทึกซ้ำซ้อนเมื่อมีคนใช้งานหน้าเดียวกัน) ───────
const LOCK_TIMEOUT_MS = 2 * 60 * 1000; // ถือว่าหมดอายุถ้าไม่มี heartbeat เกิน 2 นาที

app.get('/api/locks/status', (req, res) => {
  const { pageKey } = req.query;
  if (!pageKey) return res.status(400).json({ error: 'pageKey จำเป็นต้องระบุ' });

  db.get(`SELECT * FROM page_locks WHERE page_key = ?`, [pageKey], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    const isStale = row && (Date.now() - new Date(row.last_seen).getTime() > LOCK_TIMEOUT_MS);
    if (!row || isStale) return res.json({ locked: false });
    res.json({ locked: true, operatorName: row.operator_name, startedAt: row.started_at });
  });
});

app.post('/api/locks/acquire', (req, res) => {
  const { pageKey, operatorName } = req.body;
  if (!pageKey || !operatorName) return res.status(400).json({ error: 'pageKey และ operatorName จำเป็นต้องระบุ' });
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');

  db.get(`SELECT * FROM page_locks WHERE page_key = ?`, [pageKey], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const isStale = row && (Date.now() - new Date(row.last_seen).getTime() > LOCK_TIMEOUT_MS);
    const isSameOperator = row && row.operator_name === operatorName;

    if (row && !isStale && !isSameOperator) {
      return res.json({ success: false, locked: true, operatorName: row.operator_name, startedAt: row.started_at });
    }

    db.run(
      `INSERT INTO page_locks (page_key, operator_name, started_at, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(page_key) DO UPDATE SET operator_name = excluded.operator_name, started_at = excluded.started_at, last_seen = excluded.last_seen`,
      [pageKey, operatorName, now, now],
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ success: true, locked: false });
      }
    );
  });
});

app.post('/api/locks/heartbeat', (req, res) => {
  const { pageKey, operatorName } = req.body;
  if (!pageKey || !operatorName) return res.status(400).json({ error: 'pageKey และ operatorName จำเป็นต้องระบุ' });
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');

  db.run(
    `UPDATE page_locks SET last_seen = ? WHERE page_key = ? AND operator_name = ?`,
    [now, pageKey, operatorName],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.json({ success: false, locked: true });
      res.json({ success: true });
    }
  );
});

app.post('/api/locks/release', (req, res) => {
  const { pageKey, operatorName } = req.body;
  if (!pageKey || !operatorName) return res.status(400).json({ error: 'pageKey และ operatorName จำเป็นต้องระบุ' });

  db.run(`DELETE FROM page_locks WHERE page_key = ? AND operator_name = ?`, [pageKey, operatorName], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
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
  const { sessionId, rowNo, data, sessionInfo } = req.body;

  // ส่ง Telegram ทันทีเมื่อ Stop (มี endTime) โดยใช้ sessionInfo จาก client
  if (data.endTime) {
    const info = sessionInfo || {};
    const msg = [
      `📋 <b>CIP ${escapeHtml(info.line || 'Line 2')} — Batch เสร็จสิ้น</b>`,
      `NO.${rowNo} | ${escapeHtml(info.sku || '')} ${escapeHtml(info.flavor || '')}`,
      `👤 ${escapeHtml(info.operatorName || '')} | 📅 ${escapeHtml(info.date || '')}`,
      data.startTime     ? `⏱ เริ่ม: ${escapeHtml(data.startTime)}` : null,
      `⏱ จบ: ${escapeHtml(data.endTime)}`,
      data.duration      ? `⏱ รวม: ${escapeHtml(String(data.duration))} นาที` : null,
      data.pump1Pressure ? `💨 Pump1: ${escapeHtml(data.pump1Pressure)} Bar` : null,
      data.pump2Pressure ? `💨 Pump2: ${escapeHtml(data.pump2Pressure)} Bar` : null,
      data.ph            ? `🧪 pH: ${escapeHtml(data.ph)}` : null,
      data.brix          ? `🍬 Brix: ${escapeHtml(data.brix)}` : null,
      data.backwash      ? `🧴 Backwash: ✓` : null,
    ].filter(Boolean).join('\n');
    const img = data.imagePath ? dataUrlToBuffer(data.imagePath) : null;
    if (img) sendPhotoBufferToTelegram(img.buffer, img.mimeType, msg);
    else sendToTelegram(msg);

    sendToN8n({
      type: 'cip_line2',
      sessionId, rowNo,
      line: info.line || 'Line 2',
      sku: info.sku || '',
      flavor: info.flavor || '',
      operator: info.operatorName || '',
      date: info.date || '',
      startTime: data.startTime || '',
      endTime: data.endTime || '',
      duration: data.duration || '',
      pump1Pressure: data.pump1Pressure || '',
      pump2Pressure: data.pump2Pressure || '',
      ph: data.ph || '',
      brix: data.brix || '',
      backwash: !!data.backwash,
    });
  }

  db.run(`INSERT INTO cip_line2_rows (session_id, row_no, data) VALUES (?, ?, ?)
    ON CONFLICT(session_id, row_no) DO UPDATE SET data = excluded.data`,
    [sessionId, rowNo, JSON.stringify(data)],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
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
  const { sessionId, line, date, operatorName, firstStart, lastEnd, totalDuration, pump1, pump2, ph, brix, backwashCount, backwashBatches } = req.body;
  db.run(`UPDATE cip_line2_sessions SET status = 'completed' WHERE id = ?`, [sessionId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      sendToTelegram([
        `✅ <b>CIP ${escapeHtml(line || 'Line 2')} — เสร็จสิ้น</b>`,
        `─────────────────────`,
        `📅 ${escapeHtml(date || '-')}`,
        `👤 ${escapeHtml(operatorName || '-')}`,
        `─────────────────────`,
        (firstStart || lastEnd) ? `🕐 เริ่ม: <b>${escapeHtml(firstStart || '-')}</b>  →  จบ: <b>${escapeHtml(lastEnd || '-')}</b>` : null,
        totalDuration ? `⏱ รวม CIP: <b>${escapeHtml(String(totalDuration))} นาที</b>` : null,
        `─────────────────────`,
        (pump1 || pump2) ? `💨 Pump 1: ${escapeHtml(pump1 || '-')} Bar\n💨 Pump 2: ${escapeHtml(pump2 || '-')} Bar` : null,
        (ph || brix) ? `🧪 pH: ${escapeHtml(ph || '-')}  |  🍬 Brix: ${escapeHtml(brix || '-')}` : null,
        backwashCount ? `🧴 Backwash: ${escapeHtml(String(backwashCount))} Batch (NO. ${escapeHtml((backwashBatches || []).join(', '))})` : null,
      ].filter(Boolean).join('\n'));
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
  const { sessionId, rowNo, data, sessionInfo } = req.body;

  if (data.endTime) {
    const info = sessionInfo || {};
    const tStart = formatThaiTime(data.startTime);
    const tEnd   = formatThaiTime(data.endTime);
    const dur    = calcDuration(data.startTime, data.endTime);
    const msg = [
      `📋 <b>CIP Line 1 — รอบที่ ${rowNo} เสร็จสิ้น</b>`,
      `📦 SKU: ${escapeHtml(info.sku || '-')} | 📅 ${escapeHtml(info.date || '-')}`,
      `👤 ${escapeHtml(info.operatorName || '-')}`,
      (tStart || tEnd) ? `⏱ เริ่ม: ${tStart || '-'}  →  จบ: ${tEnd || '-'}` : null,
      dur ? `⏱ รวม: ${dur} นาที` : null,
      data.ph   ? `🧪 pH: ${escapeHtml(String(data.ph))}` : null,
      data.brix ? `🍬 Brix: ${escapeHtml(String(data.brix))}` : null,
    ].filter(Boolean).join('\n');
    const img = data.imagePath ? dataUrlToBuffer(data.imagePath) : null;
    if (img) sendPhotoBufferToTelegram(img.buffer, img.mimeType, msg);
    else sendToTelegram(msg);

    sendToN8n({
      type: 'cip_line1',
      sessionId, rowNo,
      sku: info.sku || '',
      operator: info.operatorName || '',
      date: info.date || '',
      startTime: formatThaiTime(data.startTime) || data.startTime || '',
      endTime: formatThaiTime(data.endTime) || data.endTime || '',
      duration: calcDuration(data.startTime, data.endTime) || '',
      ph: data.ph || '',
      brix: data.brix || '',
    });
  }

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
  const { sessionId, operatorName, date, sku, startTime, endTime, totalDuration } = req.body;
  db.run(`UPDATE cip_line1_sessions SET status = 'completed' WHERE id = ?`, [sessionId], function(err) {
    if (err) return res.status(500).json({ error: err.message });

    const tStart = formatThaiTime(startTime);
    const tEnd   = formatThaiTime(endTime);
    const dur    = calcDuration(startTime, endTime);
    let thaiDate = null;
    try { thaiDate = new Date(startTime || endTime).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch {}

    sendToTelegram([
      `✅ <b>CIP Line 1 — จบแล้ว</b>`,
      `─────────────────────`,
      (thaiDate || date) ? `📅 ${thaiDate || escapeHtml(date)}` : null,
      `👤 ผู้ดำเนินการ: ${escapeHtml(operatorName || '-')}`,
      sku ? `📦 SKU: ${escapeHtml(sku)}` : null,
      `─────────────────────`,
      (tStart || tEnd) ? `⏰ เริ่ม: <b>${tStart || '-'}</b>  →  จบ: <b>${tEnd || '-'}</b>` : null,
      (dur || totalDuration) ? `⏱ เวลารวม: <b>${dur || totalDuration} นาที</b>` : null,
    ].filter(Boolean).join('\n'));

    res.json({ success: true });
  });
});

app.get('/api/cip-line1/sessions', (req, res) => {
  db.all('SELECT * FROM cip_line1_sessions ORDER BY id DESC LIMIT 30', [], (err, sessions) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!sessions.length) return res.json([]);
    const ids = sessions.map(s => s.id);
    db.all(`SELECT session_id, row_no, data FROM cip_line1_rows WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY row_no`, ids, (err2, rows) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const bySession = {};
      (rows || []).forEach(r => {
        if (!bySession[r.session_id]) bySession[r.session_id] = [];
        try { bySession[r.session_id].push({ rowNo: r.row_no, ...JSON.parse(r.data) }); } catch {}
      });
      res.json(sessions.map(s => ({ ...s, rows: bySession[s.id] || [] })));
    });
  });
});

app.post('/api/cip-line1/delete-one', (req, res) => {
  const { sessionId } = req.body;
  db.run('DELETE FROM cip_line1_rows WHERE session_id = ?', [sessionId], () => {
    db.run('DELETE FROM cip_line1_extra WHERE session_id = ?', [sessionId], () => {
      db.run('DELETE FROM cip_line1_sessions WHERE id = ?', [sessionId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    });
  });
});

app.get('/api/cip-line2/sessions', (req, res) => {
  db.all('SELECT * FROM cip_line2_sessions ORDER BY id DESC LIMIT 30', [], (err, sessions) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!sessions.length) return res.json([]);
    const ids = sessions.map(s => s.id);
    db.all(`SELECT session_id, row_no, data FROM cip_line2_rows WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY row_no`, ids, (err2, rows) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const bySession = {};
      (rows || []).forEach(r => {
        if (!bySession[r.session_id]) bySession[r.session_id] = [];
        try { bySession[r.session_id].push({ rowNo: r.row_no, ...JSON.parse(r.data) }); } catch {}
      });
      res.json(sessions.map(s => ({ ...s, rows: bySession[s.id] || [] })));
    });
  });
});

app.post('/api/cip-line2/delete-one', (req, res) => {
  const { sessionId } = req.body;
  db.run('DELETE FROM cip_line2_rows WHERE session_id = ?', [sessionId], () => {
    db.run('DELETE FROM cip_line2_back WHERE session_id = ?', [sessionId], () => {
      db.run('DELETE FROM cip_line2_sessions WHERE id = ?', [sessionId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    });
  });
});

const escapeHtml = (str) => {
  if (!str && str !== 0) return str;
  return str.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

const formatThaiTime = (isoStr) => {
  if (!isoStr) return null;
  try {
    return new Date(isoStr).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  } catch { return isoStr; }
};

const calcDuration = (startIso, endIso) => {
  if (!startIso || !endIso) return null;
  try {
    const diff = Math.round((new Date(endIso) - new Date(startIso)) / 60000);
    return diff > 0 ? diff : null;
  } catch { return null; }
};

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.srv1267366.hstgr.cloud/webhook/cip-report';

const sendToN8n = async (data) => {
  try {
    await axios.post(N8N_WEBHOOK_URL, data, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log('[N8N] sent OK type=' + data.type);
  } catch (error) {
    console.error('[N8N] error:', error.response?.data || error.message);
  }
};

const sendToTelegram = async (message) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  console.log(`[Telegram] sendToTelegram called. hasToken=${!!token} hasChatId=${!!chatId} msgLen=${message?.length}`);
  if (!token || !chatId) { console.error('[Telegram] Missing token or chatId'); return; }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    });
    console.log('[Telegram] Message sent OK');
  } catch (error) {
    console.error('[Telegram] Error:', error.response?.data || error.message);
  }
};

// เรียก Telegram Bot API แบบ generic (sendMessage/editMessageText/answerCallbackQuery ฯลฯ)
const tgApi = async (method, payload) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log(`[TG] ${method} skipped (no token)`); return null; }
  try { const r = await axios.post(`https://api.telegram.org/bot${token}/${method}`, payload); return r.data; }
  catch (e) { console.error(`[TG] ${method} error`, e.response?.data || e.message); return null; }
};

const dataUrlToBuffer = (dataUrl) => {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const [header, b64] = dataUrl.split(',');
  if (!b64) return null;
  const mime = header.replace('data:', '').replace(';base64', '');
  return { buffer: Buffer.from(b64, 'base64'), mimeType: mime };
};

const sendPhotoBufferToTelegram = async (buffer, mimeType, caption) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.error('[TG Photo] missing token/chatId'); return; }
  console.log(`[TG Photo] sending buffer size=${buffer?.length} mime=${mimeType}`);
  try {
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('parse_mode', 'HTML');
    form.append('caption', caption.slice(0, 1024));
    form.append('photo', buffer, { filename: `image.${ext}`, contentType: mimeType });
    const res = await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    console.log('[TG Photo] sent OK', res.data?.ok);
  } catch (error) {
    console.error('[TG Photo] error:', JSON.stringify(error.response?.data) || error.message);
  }
};

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
});

// หาว่าข้อความระบุ Line ใดไว้หรือไม่ เช่น "สรุป CIP Line2" / "สรุป cip ไลน์ 3" / "สรุป cip ทดลอง"
// คืนค่า null ถ้าไม่ได้ระบุ Line (หมายถึงสรุปรวมทุก Line)
const detectLineFilter = (text) => {
  const m = text.match(/(?:line|ไลน์)\s*([123])/i);
  if (m) return `Line ${m[1]}`;
  if (text.includes('ทดลอง')) return 'CIP ทดลอง';
  return null;
};

const todayBKK = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

const LINE_TARGETS = { 'Line 1': 7, 'Line 2': 20, 'Line 3': 20 };
const LITERS_PER_ROUND = 1000;

// นับจำนวนรอบ (batch/row ที่กด Stop เสร็จแล้ว) จากตาราง rows ของ session ที่ระบุ
// เช็คจาก endTime แทน done เพราะ done ไม่ได้ถูกตั้งค่าสม่ำเสมอในข้อมูลเก่า/ทุก Line
const countDoneRows = async (table, sessionIds) => {
  if (!sessionIds.length) return 0;
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = await dbAll(`SELECT data FROM ${table} WHERE session_id IN (${placeholders})`, sessionIds);
  return rows.filter(r => { try { return !!JSON.parse(r.data).endTime; } catch { return false; } }).length;
};

const countBackwashRows = async (sessionIds) => {
  if (!sessionIds.length) return 0;
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = await dbAll(`SELECT data FROM cip_line2_rows WHERE session_id IN (${placeholders})`, sessionIds);
  return rows.filter(r => { try { return !!JSON.parse(r.data).backwash; } catch { return false; } }).length;
};

// จำนวนรอบ CIP ของวันนี้ แยกตาม Line สำหรับกราฟแท่งเปรียบเทียบ
const buildTodayRoundsByLine = async () => {
  const today = todayBKK();
  const [line1Sessions, line2Sessions, batches] = await Promise.all([
    dbAll("SELECT id FROM cip_line1_sessions WHERE date = ? OR created_at LIKE ?", [today, `${today}%`]),
    dbAll("SELECT id, line FROM cip_line2_sessions WHERE date = ? OR created_at LIKE ?", [today, `${today}%`]),
    dbAll('SELECT start_time, status FROM cip_batches'),
  ]);
  const line2Ids = line2Sessions.filter(s => (s.line || 'Line 2') === 'Line 2').map(s => s.id);
  const line3Ids = line2Sessions.filter(s => s.line === 'Line 3').map(s => s.id);
  const line1Ids = line1Sessions.map(s => s.id);

  const [line1Rounds, line2Rounds, line3Rounds] = await Promise.all([
    countDoneRows('cip_line1_rows', line1Ids),
    countDoneRows('cip_line2_rows', line2Ids),
    countDoneRows('cip_line2_rows', line3Ids),
  ]);
  const logbookRounds = batches.filter(b => {
    if (b.status !== 'completed') return false;
    try { return new Date(b.start_time).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) === today; } catch { return false; }
  }).length;

  return [
    { label: 'Line 1', value: line1Rounds, color: '#0d47a1' },
    { label: 'Line 2', value: line2Rounds, color: '#01579b' },
    { label: 'Line 3', value: line3Rounds, color: '#006064' },
    { label: 'CIP ทดลอง', value: logbookRounds, color: '#546e7a' },
  ];
};

// รายงานรายวันของ Line ที่ระบุ — เป้าหมาย/จำนวนรอบ/น้ำ RO/ประสิทธิภาพ
const buildLineDetailToday = async (lineFilter) => {
  const today = todayBKK();
  if (lineFilter === 'CIP ทดลอง') {
    const batches = await dbAll('SELECT operator_name, start_time, status FROM cip_batches ORDER BY id DESC');
    const todays = batches.filter(b => { try { return new Date(b.start_time).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) === today; } catch { return false; } });
    const rounds = todays.filter(b => b.status === 'completed').length;
    return { line: lineFilter, operator: todays[0]?.operator_name || '-', rounds };
  }

  const isLine1 = lineFilter === 'Line 1';
  const sessions = isLine1
    ? await dbAll("SELECT id, operator_name FROM cip_line1_sessions WHERE (date = ? OR created_at LIKE ?) ORDER BY id DESC", [today, `${today}%`])
    : await dbAll("SELECT id, operator_name FROM cip_line2_sessions WHERE (date = ? OR created_at LIKE ?) AND line = ? ORDER BY id DESC", [today, `${today}%`, lineFilter]);
  const ids = sessions.map(s => s.id);
  const rounds = await countDoneRows(isLine1 ? 'cip_line1_rows' : 'cip_line2_rows', ids);
  const backwashCount = isLine1 ? undefined : await countBackwashRows(ids);

  const target = LINE_TARGETS[lineFilter];
  const litersUsed = rounds * LITERS_PER_ROUND;
  // target = "เพดาน" จำนวนรอบ/น้ำ RO ที่ใช้ได้ต่อวัน
  // ใช้น้ำเทียบเพดาน = rounds/target: ใกล้ 100% แต่ไม่เกิน = ดี, เกิน 100% = สิ้นเปลือง, น้อยเกินไป = เตือน
  const usagePct = (rounds === 0 || target <= 0) ? null : Math.round((rounds / target) * 100);
  let waterStatus = null;
  if (usagePct !== null) {
    if (rounds > target) waterStatus = '🔴 เกินเพดาน ใช้น้ำเกินไป (สิ้นเปลือง)';
    else if (usagePct >= 50) waterStatus = '🟢 เหมาะสม';
    else waterStatus = '🟡 ใช้น้ำน้อยเกินไป';
  }

  // โดนัทสัดส่วนรอบที่ใช้ไปเทียบกับเป้าหมาย — ถ้าทำไม่เกินเป้าหมาย โชว์ "ใช้ไปแล้ว" vs "เหลือ"
  // ถ้าทำเกินเป้าหมาย โชว์ "เป้าหมาย" vs "เกินเป้าหมาย" (สีแดง เตือนว่าใช้น้ำเกิน)
  const slices = rounds <= target
    ? [
        { label: 'ใช้ไปแล้ว', value: rounds, color: '#2e7d32' },
        { label: 'เหลือก่อนถึงเป้าหมาย', value: target - rounds, color: '#e0e0e0' },
      ]
    : [
        { label: 'เป้าหมาย', value: target, color: '#ff9800' },
        { label: 'เกินเป้าหมาย', value: rounds - target, color: '#d32f2f' },
      ];

  return { line: lineFilter, operator: sessions[0]?.operator_name || '-', target, rounds, litersUsed, usagePct, waterStatus, backwashCount, slices };
};

// QuickChart รับ config เดียวกันได้ทั้งแบบขอ URL รูปตรงๆ (ให้ n8n ใช้) หรือขอเป็น buffer (ให้ส่ง Telegram เอง)
const buildQuickChartUrl = (config, width = 500, height = 500) => {
  const params = new URLSearchParams({ c: JSON.stringify(config), backgroundColor: 'white', width: String(width), height: String(height) });
  return `https://quickchart.io/chart?${params.toString()}`;
};
const fetchQuickChartBuffer = async (config, width = 500, height = 500) => {
  const res = await axios.get(buildQuickChartUrl(config, width, height), { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
};

// titleLines = อาเรย์ข้อความหลายบรรทัด ฝัง "สรุป" ลงในรูปเลย (Chart.js v2 รับ title.text เป็นอาเรย์ได้)
const barChartConfig = (slices, titleLines) => ({
  type: 'bar',
  data: { labels: slices.map(s => s.label), datasets: [{ label: 'จำนวนรอบ', data: slices.map(s => s.value), backgroundColor: slices.map(s => s.color) }] },
  options: {
    title: titleLines && titleLines.length ? { display: true, text: titleLines, fontSize: 15, fontStyle: 'bold' } : { display: false },
    legend: { display: false },
    plugins: { datalabels: { display: true, color: '#fff', anchor: 'end', align: 'start', font: { size: 18, weight: 'bold' } } },
    scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] },
  },
});
const donutChartConfig = (slices, titleLines) => ({
  type: 'doughnut',
  data: { labels: slices.map(s => s.label), datasets: [{ data: slices.map(s => s.value), backgroundColor: slices.map(s => s.color) }] },
  options: {
    title: titleLines && titleLines.length ? { display: true, text: titleLines, fontSize: 14, fontStyle: 'bold' } : { display: false },
    legend: { position: 'bottom' },
    plugins: { datalabels: { display: true, color: '#fff', font: { size: 16, weight: 'bold' } } },
  },
});

// ตรรกะกลางของคำสั่ง "สรุป CIP" — ใช้ทั้งจาก /api/telegram/webhook (ส่งเอง) และ /api/cip-summary (ให้ n8n เรียกแล้วส่งเอง)
const buildCipReplyPayload = async (rawText) => {
  const text = (rawText || '').trim().toLowerCase();
  const lineFilter = detectLineFilter(text);
  const isCipCommand = text.includes('สรุป') && (text.includes('cip') || lineFilter);
  if (!isCipCommand) return { matched: false };

  if (lineFilter) {
    const d = await buildLineDetailToday(lineFilter);
    const lines = [
      `🍩 สรุป CIP ${d.line}`,
      `👤 ผู้ปฏิบัติงานล่าสุด: ${d.operator}`,
    ];
    if (d.target !== undefined) lines.push(`🎯 เป้าหมาย: ${d.target} ขั้นตอน (รอบ)`);
    lines.push(`🔄 จำนวนรอบวันนี้: ${d.rounds} รอบ`);
    if (d.backwashCount !== undefined) lines.push(`🧴 Backwash: ${d.backwashCount} ครั้ง`);
    if (d.litersUsed !== undefined) lines.push(`💧 น้ำ RO ที่ใช้: ${d.litersUsed} ลิตร`);
    if (d.usagePct !== undefined) lines.push(`📊 การใช้น้ำ RO เทียบเพดาน: ${d.usagePct === null ? 'ยังไม่มีข้อมูลวันนี้' : `${d.usagePct}% (${d.rounds}/${d.target} รอบ)`}`);
    if (d.waterStatus) lines.push(`⚖️ สถานะ: ${d.waterStatus}`);
    // ฝังสรุป (ข้อความเดียวกับ caption) ลงในรูปกราฟเลย เพื่อแชร์รูปเดียวจบ
    return { matched: true, caption: lines.join('\n'), chartConfig: d.slices ? donutChartConfig(d.slices, lines) : null, width: 560, height: 620 };
  }

  const slices = await buildTodayRoundsByLine();
  const today = todayBKK();
  const lines = ['📊 สรุป CIP วันนี้ แยกตาม Line'];
  const titleLines = [`📊 สรุป CIP วันนี้ ${today}`];
  let totRounds = 0, totLiters = 0;
  for (const s of slices) {
    if (s.label === 'CIP ทดลอง') continue; // แสดงเฉพาะ Line 1/2/3
    const liters = s.value * LITERS_PER_ROUND;
    totRounds += s.value; totLiters += liters;
    lines.push('');
    lines.push(`🏭 ${s.label}`);
    lines.push(`   💧 จำนวนการใช้น้ำ RO: ${s.value} รอบ`);
    lines.push(`   🪣 รวมปริมาตรน้ำที่ใช้: ${liters} ลิตร`);
    titleLines.push(`${s.label}: ${s.value} รอบ · ${liters} ลิตร`);
  }
  titleLines.push(`รวม ${totRounds} รอบ · ${totLiters} ลิตร`);
  return { matched: true, caption: lines.join('\n'), chartConfig: barChartConfig(slices, titleLines), width: 560, height: 520 };
};

// เก็บไว้เผื่อใช้ในอนาคต — ตอนนี้ n8n's Telegram Trigger เป็นเจ้าของ webhook ของบอทอยู่ (ดู /api/cip-summary ด้านล่าง)
app.post('/api/telegram/webhook', (req, res) => {
  res.sendStatus(200); // ตอบ Telegram ทันที กันเคส retry ซ้ำถ้าประมวลผลช้า
  (async () => {
    try {
      const msg = req.body?.message;
      if (!msg?.text || String(msg.chat?.id) !== String(process.env.TELEGRAM_CHAT_ID || '')) return;
      const payload = await buildCipReplyPayload(msg.text);
      if (!payload.matched) return;
      if (payload.chartConfig) {
        const buffer = await fetchQuickChartBuffer(payload.chartConfig, payload.width, payload.height);
        await sendPhotoBufferToTelegram(buffer, 'image/png', payload.caption);
      } else {
        await sendToTelegram(payload.caption);
      }
    } catch (e) { console.error('[Telegram webhook] error', e); }
  })();
});

// ให้ n8n's Telegram Trigger workflow เรียกใช้ — ส่ง { message: { text, chat: { id } } } (เอาต์พุตจาก Telegram Trigger node ตรงๆ)
// คืนค่า { matched, chatId, caption, chartUrl } ให้ n8n ต่อด้วย node ส่ง Telegram เอง (เหมือน node "Send Chart" ที่มีอยู่แล้ว)
app.post('/api/cip-summary', async (req, res) => {
  try {
    const msg = req.body?.message || req.body;
    const payload = await buildCipReplyPayload(msg?.text);
    if (!payload.matched) return res.json({ matched: false });
    res.json({
      matched: true,
      chatId: msg?.chat?.id,
      caption: payload.caption,
      chartUrl: payload.chartConfig ? buildQuickChartUrl(payload.chartConfig, payload.width, payload.height) : null,
    });
  } catch (e) {
    console.error('[cip-summary] error', e);
    res.status(500).json({ matched: false, error: e.message });
  }
});

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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function fileToDataUrl(file) {
  if (!file) return null;
  const mime = file.mimetype || 'image/jpeg';
  return `data:${mime};base64,${file.buffer.toString('base64')}`;
}

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ imagePath: fileToDataUrl(req.file) });
});

app.post('/api/steps/log', upload.single('image'), (req, res) => {
  const { batchId, stepNumber, stepDescription, pressure, brix, ph, remarks } = req.body;
  const imagePath = fileToDataUrl(req.file);

  // Filter out literal "undefined" strings sent by old client build
  const cleanStart = (req.body.startTime && req.body.startTime !== 'undefined') ? req.body.startTime : null;
  const cleanEnd   = (req.body.endTime   && req.body.endTime   !== 'undefined') ? req.body.endTime   : null;
  const cacheKey   = `${batchId}_${stepNumber}`;

  console.log(`[steps/log] batchId=${batchId} step=${stepNumber} endTime=${!!cleanEnd} hasFile=${!!req.file}`);
  console.log(`[steps/log] endTime="${cleanEnd}" startTime="${cleanStart}"`);

  // Cache start time immediately so it's available when stop arrives (even out-of-order)
  if (cleanStart) {
    stepStartCache[cacheKey] = cleanStart;
  }

  if (cleanEnd) {
    const operatorName = req.body.operatorName || '-';
    // Delay 1.5s: handles race where handleStop arrives before handleStart's DB write
    setTimeout(() => {
      db.get('SELECT start_time, image_path FROM cip_step_logs WHERE batch_id = ? AND step_number = ?', [batchId, stepNumber], (err2, row) => {
        const resolvedStart = cleanStart || stepStartCache[cacheKey] || row?.start_time || '';
        const tStart = formatThaiTime(resolvedStart);
        const tEnd   = formatThaiTime(cleanEnd);
        const dur    = calcDuration(resolvedStart, cleanEnd);
        console.log(`[steps/log] resolvedStart="${resolvedStart}" dur=${dur}`);

        const msg = [
          `📋 <b>CIP Step ${escapeHtml(stepNumber)}: ${escapeHtml(stepDescription)}</b>`,
          `👤 ผู้ดำเนินการ: ${escapeHtml(operatorName)}`,
          (tStart || tEnd) ? `⏱ เริ่ม: ${tStart || '-'}  →  จบ: ${tEnd || '-'}` : null,
          dur              ? `⏱ รวม: ${dur} นาที` : null,
          pressure ? `💨 Pressure: ${escapeHtml(pressure)}` : null,
          brix     ? `🍬 Brix: ${escapeHtml(brix)}` : null,
          ph       ? `🧪 pH: ${escapeHtml(ph)}` : null,
          remarks  ? `💬 หมายเหตุ: ${escapeHtml(remarks)}` : null,
        ].filter(Boolean).join('\n');

        const stored = row?.image_path;
        if (req.file) {
          sendPhotoBufferToTelegram(req.file.buffer, req.file.mimetype, msg);
        } else if (stored) {
          const img = dataUrlToBuffer(stored);
          if (img) sendPhotoBufferToTelegram(img.buffer, img.mimeType, msg);
          else sendToTelegram(msg);
        } else {
          sendToTelegram(msg);
        }

        sendToN8n({
          type: 'cip_step',
          batchId, stepNumber,
          stepDescription,
          operator: operatorName,
          startTime: formatThaiTime(resolvedStart) || resolvedStart || '',
          endTime: formatThaiTime(cleanEnd) || cleanEnd || '',
          duration: dur !== null ? String(dur) : '',
          pressure: pressure || '',
          brix: brix || '',
          ph: ph || '',
          remarks: remarks || '',
        });
      });
    }, 1500);
  }

  db.get('SELECT id FROM cip_step_logs WHERE batch_id = ? AND step_number = ?', [batchId, stepNumber], (err, existing) => {
    if (existing) {
      db.run(`UPDATE cip_step_logs SET
        step_description = COALESCE(?, step_description),
        start_time = COALESCE(?, start_time),
        end_time = COALESCE(?, end_time),
        pressure = COALESCE(?, pressure),
        brix = COALESCE(?, brix),
        ph = COALESCE(?, ph),
        remarks = COALESCE(?, remarks),
        image_path = COALESCE(?, image_path)
        WHERE batch_id = ? AND step_number = ?`,
        [stepDescription || null, cleanStart || null, cleanEnd || null, pressure || null, brix || null, ph || null, remarks || null, imagePath || null, batchId, stepNumber],
        function(err2) {
          if (err2) { console.error('[steps/log] UPDATE error:', err2.message); return res.status(500).json({ error: err2.message }); }
          res.json({ success: true, imagePath });
        }
      );
    } else {
      db.run(`INSERT INTO cip_step_logs (batch_id, step_number, step_description, start_time, end_time, pressure, brix, ph, remarks, image_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, stepNumber, stepDescription, cleanStart, cleanEnd, pressure, brix, ph, remarks, imagePath],
        function(err2) {
          if (err2) { console.error('[steps/log] INSERT error:', err2.message); return res.status(500).json({ error: err2.message }); }
          res.json({ success: true, imagePath });
        }
      );
    }
  });
});

// Dedicated JSON endpoint for Telegram notification (bypasses multer/FormData)
app.post('/api/notify-step', (req, res) => {
  const { stepNumber, stepDescription, operatorName, startTime, endTime, pressure, brix, ph, remarks } = req.body;
  console.log(`[notify-step] HIT step=${stepNumber} endTime=${endTime}`);
  if (endTime) {
    const tStart = formatThaiTime(startTime);
    const tEnd   = formatThaiTime(endTime);
    const dur    = calcDuration(startTime, endTime);
    const msg = [
      `📋 <b>CIP Step ${escapeHtml(stepNumber)}: ${escapeHtml(stepDescription)}</b>`,
      `👤 ผู้ดำเนินการ: ${escapeHtml(operatorName || '-')}`,
      (tStart || tEnd) ? `⏱ เริ่ม: ${tStart || '-'}  →  จบ: ${tEnd || '-'}` : null,
      dur              ? `⏱ รวม: ${dur} นาที` : null,
      pressure ? `💨 Pressure: ${escapeHtml(pressure)}` : null,
      brix     ? `🍬 Brix: ${escapeHtml(brix)}` : null,
      ph       ? `🧪 pH: ${escapeHtml(ph)}` : null,
      remarks  ? `💬 หมายเหตุ: ${escapeHtml(remarks)}` : null,
    ].filter(Boolean).join('\n');
    sendToTelegram(msg);
  }
  res.json({ ok: true });
});

app.post('/api/batches/finish', (req, res) => {
  const { batchId, operatorName, startTime, endTime } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  db.run("UPDATE cip_batches SET end_time = ?, status = 'completed' WHERE id = ?", [now, batchId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, endTime: now });

    // Query steps for Telegram summary (async, after responding)
    db.all("SELECT * FROM cip_step_logs WHERE batch_id = ? ORDER BY step_number ASC", [batchId], (err2, steps) => {
      const tStart = formatThaiTime(startTime);
      const tEnd   = formatThaiTime(endTime);
      const dur    = calcDuration(startTime, endTime);
      const completed = steps ? steps.filter(s => s.end_time).length : 0;
      const lastDone  = steps ? [...steps].reverse().find(s => s.end_time) : null;

      let thaiDate = null;
      try { thaiDate = new Date(startTime).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch {}

      sendToTelegram([
        `✅ <b>CIP ทดลอง — จบแล้ว</b>`,
        `─────────────────────`,
        thaiDate ? `📅 ${thaiDate}` : null,
        operatorName ? `👤 ผู้ดำเนินการ: ${escapeHtml(operatorName)}` : null,
        `─────────────────────`,
        (tStart || tEnd) ? `⏰ เริ่ม: <b>${tStart || '-'}</b>  →  จบ: <b>${tEnd || '-'}</b>` : null,
        dur ? `⏱ เวลารวม: <b>${dur} นาที</b>` : null,
        `─────────────────────`,
        completed ? `✅ ขั้นตอนเสร็จ: ${completed} ขั้นตอน` : null,
        lastDone?.pressure ? `💨 Pressure: ${escapeHtml(String(lastDone.pressure))} Bar` : null,
        lastDone?.brix     ? `🍬 Brix: ${escapeHtml(String(lastDone.brix))}` : null,
        lastDone?.ph       ? `🧪 pH: ${escapeHtml(String(lastDone.ph))}` : null,
      ].filter(Boolean).join('\n'));
    });
  });
});

app.post('/api/production/log', (req, res) => {
  const { line, flavor, batch, operator, timestamp, cipCount, brix, ph, startTime, endTime, duration, lotNo } = req.body;
  const fmtTime = timestamp ? new Date(timestamp).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T') : null;
  const query = `INSERT INTO production_logs (timestamp, line_name, flavor, batch, operator_name, cip_count, brix, ph) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(query, [fmtTime, line, flavor, batch, operator, cipCount, brix === '' || brix == null ? null : Number(brix), ph === '' || ph == null ? null : Number(ph)], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    sendToTelegram([
      `🏭 <b>บันทึกการผลิต</b>`,
      `📍 Line: ${escapeHtml(line)} | รสชาติ: ${escapeHtml(flavor)}`,
      `📦 Batch: ${escapeHtml(batch)}`,
      lotNo ? `🏷️ Lot No.: <b>${escapeHtml(lotNo)}</b>` : null,
      `👤 ผู้ดำเนินการ: ${escapeHtml(operator)}`,
      startTime ? `▶️ เวลาเริ่ม: ${escapeHtml(startTime)}` : null,
      endTime   ? `⏹️ เวลาจบ: ${escapeHtml(endTime)}` : null,
      duration  ? `⏱ รวม: ${duration} นาที` : null,
      brix ? `🍬 Brix: ${escapeHtml(String(brix))}` : null,
      ph   ? `🧪 pH: ${escapeHtml(String(ph))}` : null,
      (cipCount && cipCount !== '-') ? `🧼 CIP: ${escapeHtml(cipCount)}` : null,
    ].filter(Boolean).join('\n'));
    sendToN8n({
      type: 'production',
      timestamp: fmtTime || '',
      line: line || '',
      flavor: flavor || '',
      batch: batch || '',
      lotNo: lotNo || '',
      operator: operator || '',
      startTime: startTime || '',
      endTime: endTime || '',
      duration: duration || '',
      brix: brix || '',
      ph: ph || '',
      cipCount: cipCount || '',
    });
    res.json({ success: true, logId: this.lastID });
  });
});

// ── แผนผลิตประจำวัน ─────────────────────────────
// บันทึก/อัปเดตแผนผลิตหลายรายการในครั้งเดียว
app.post('/api/production/plan', (req, res) => {
  const { planDate, operator, items } = req.body;
  const date = planDate || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items ต้องเป็น array และไม่ว่าง' });
  }
  const createdAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  const upsertSql = `INSERT INTO production_plans
    (plan_date, line_name, flavor, planned_batches, operator_name, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_date, line_name, flavor)
    DO UPDATE SET planned_batches=excluded.planned_batches, operator_name=excluded.operator_name, note=excluded.note, created_at=excluded.created_at`;
  (async () => {
    try {
      for (const it of items) {
        await db.exec(upsertSql, [date, it.line || '', it.flavor || '', Number(it.plannedBatches) || 0, operator || '', it.note || '', createdAt]);
      }
      // สร้าง To-do อัตโนมัติจากแผนที่เพิ่งบันทึก (ผลิต + CIP + งานประจำ)
      await generateTasksForDate(date, operator);
      await syncTaskProgress(date);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    const total = items.reduce((s, it) => s + (Number(it.plannedBatches) || 0), 0);
    sendToTelegram([
      `📋 <b>บันทึกแผนผลิตประจำวัน</b>`,
      `🗓 วันที่: <b>${escapeHtml(date)}</b>`,
      operator ? `👤 ผู้วางแผน: ${escapeHtml(operator)}` : null,
      `─────────────────────`,
      ...items.map((it) => `• ${escapeHtml(it.line || '-')} | ${escapeHtml(it.flavor || '-')}: <b>${Number(it.plannedBatches) || 0}</b> batch`),
      `─────────────────────`,
      `รวมแผน: <b>${total}</b> batch (${items.length} รายการ)`,
    ].filter(Boolean).join('\n'));
    // ส่งทั้งแผนเป็น payload เดียว (items[]) ให้ n8n แตกเป็นหลายแถวแล้ว append ใน execution เดียว
    // (ยิงทีละรายการทำให้ Google Sheets append เขียนทับแถวเดิม → ข้อมูลหาย)
    sendToN8n({
      type: 'production_plan',
      planDate: date,
      operator: operator || '',
      createdAt,
      items: items.map((it) => ({
        line: it.line || '',
        flavor: it.flavor || '',
        plannedBatches: String(Number(it.plannedBatches) || 0),
        note: it.note || '',
      })),
    });
    res.json({ success: true, saved: items.length, total });
  })();
});

// ดึงแผนผลิตของวัน (default = วันนี้)
app.get('/api/production/plan', (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  db.all("SELECT * FROM production_plans WHERE plan_date = ? ORDER BY line_name, flavor", [date], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ planDate: date, items: rows });
  });
});

// สรุปยอดผลิตจริง (นับ batch) จาก production_logs ตามวัน — ใช้เทียบแผน vs จริง
app.get('/api/production/summary', (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  db.all(
    `SELECT line_name, flavor, COUNT(*) AS actual_batches
     FROM production_logs
     WHERE substr(timestamp,1,10) = ?
     GROUP BY line_name, flavor`,
    [date],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ date, items: rows });
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ── To-do List / งานรายวัน (เชื่อมผลิต + CIP ทั้ง 3 Line) ───────────────────
// ═══════════════════════════════════════════════════════════════════════════
const nowBKK = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
const weekdayOf = (dateStr) => { try { return new Date(`${dateStr}T12:00:00`).getDay(); } catch { return null; } };
const dayOfMonth = (dateStr) => { try { return new Date(`${dateStr}T12:00:00`).getDate(); } catch { return null; } };

// ── ตารางกะโรงงาน (แหล่งความจริง — ตรงกับ client/src/shiftSchedule.ts · ดู memory shift-schedule) ──
// จ–พฤ: เช้า06-14/บ่าย14-22/ดึก22-06 · ศ,อา: เช้า06-18/ดึก18-06 · เสาร์หยุด · วันทำงาน=06:00→06:00
function shiftsForWeekday(wd) {
  if (wd === 6) return [];
  if (wd === 5 || wd === 0) return [{ key: 'เช้า', start: 6, end: 18 }, { key: 'ดึก', start: 18, end: 6 }];
  return [{ key: 'เช้า', start: 6, end: 14 }, { key: 'บ่าย', start: 14, end: 22 }, { key: 'ดึก', start: 22, end: 6 }];
}
const addDaysStr = (dateStr, n) => { const d = new Date(`${dateStr}T12:00:00`); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
// วันทำงานปัจจุบัน (ก่อน 06:00 = วันก่อนหน้า)
function workDayBKK() {
  const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }); // "YYYY-MM-DD HH:MM:SS"
  const today = bkk.slice(0, 10), hour = Number(bkk.slice(11, 13));
  return hour < 6 ? addDaysStr(today, -1) : today;
}
function nextShiftName(shiftThai, dateStr) {
  const key = String(shiftThai || '').replace('กะ', '');
  const shifts = shiftsForWeekday(weekdayOf(dateStr));
  if (!shifts.length) return '';
  const idx = shifts.findIndex(s => s.key === key);
  return idx < 0 ? '' : 'กะ' + shifts[(idx + 1) % shifts.length].key;
}
const shiftEndsForWeekday = (wd) => shiftsForWeekday(wd).map(s => `${String(s.end).padStart(2, '0')}:00`);

// upsert งานเข้า daily_tasks แบบไม่ทับ status/actual ที่มีอยู่ (idempotent)
const upsertTask = (t) => db.exec(
  `INSERT INTO daily_tasks (task_date, line_name, category, flavor, title, detail, target_count, source, recurring_id, created_by, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(task_date, line_name, category, title)
   DO UPDATE SET target_count = excluded.target_count, detail = excluded.detail, source = excluded.source, recurring_id = excluded.recurring_id`,
  [t.date, t.line || '', t.category, t.flavor || null, t.title, t.detail || null,
   t.target == null ? null : Number(t.target), t.source || 'auto_plan', t.recurring_id || null, t.createdBy || null, nowBKK()]
);

// สร้างงานประจำ (recurring) ของวันตามเทมเพลตที่ active — daily/weekly/monthly
// แยกออกมาเพื่อเรียกตอนโหลด /api/tasks ได้ → งานประจำโผล่เองทุกวัน แม้ไม่มีแผนผลิต
async function generateRecurringForDate(date) {
  if (weekdayOf(date) === 6) return; // เสาร์หยุด — ไม่สร้างงานประจำ
  const templates = await dbAll('SELECT * FROM task_templates WHERE active = 1', []);
  const wd = weekdayOf(date), dom = dayOfMonth(date);
  for (const tpl of templates) {
    const due = tpl.cadence === 'daily'
      || (tpl.cadence === 'weekly' && Number(tpl.weekday) === wd)
      || (tpl.cadence === 'monthly' && Number(tpl.weekday || 1) === dom);
    if (!due) continue;
    await upsertTask({ date, line: tpl.line_name || '', category: tpl.category || 'maintenance',
      title: tpl.title, detail: tpl.cadence, target: tpl.target_count, source: 'recurring',
      recurring_id: tpl.id, createdBy: null });
  }
}

// สร้างงานอัตโนมัติของวัน: งานผลิตจากแผน + งานประจำ
// (CIP/backwash เป็นการตัดสินใจหน้างาน operator → ไม่สร้างอัตโนมัติ; บันทึกผ่านหน้า CIP → โผล่ไทม์ไลน์)
async function generateTasksForDate(date, operator) {
  const plans = await dbAll('SELECT line_name, flavor, planned_batches FROM production_plans WHERE plan_date = ?', [date]);
  for (const p of plans) {
    await upsertTask({ date, line: p.line_name || '', category: 'production', flavor: p.flavor,
      title: `ผลิต ${p.flavor || '-'}`, detail: `แผน ${p.planned_batches || 0} batch`,
      target: p.planned_batches, source: 'auto_plan', createdBy: operator });
  }
  await generateRecurringForDate(date);
}

// นับรอบ CIP/backwash ที่ทำเสร็จของวันที่ระบุ แยกตาม Line (reuse countDoneRows/countBackwashRows)
async function cipRoundsForDate(date) {
  const [l1, l23] = await Promise.all([
    dbAll('SELECT id FROM cip_line1_sessions WHERE date = ? OR created_at LIKE ?', [date, `${date}%`]),
    dbAll('SELECT id, line FROM cip_line2_sessions WHERE date = ? OR created_at LIKE ?', [date, `${date}%`]),
  ]);
  const l2Ids = l23.filter(s => (s.line || 'Line 2') === 'Line 2').map(s => s.id);
  const l3Ids = l23.filter(s => s.line === 'Line 3').map(s => s.id);
  const [r1, r2, r3, b2, b3] = await Promise.all([
    countDoneRows('cip_line1_rows', l1.map(s => s.id)),
    countDoneRows('cip_line2_rows', l2Ids),
    countDoneRows('cip_line2_rows', l3Ids),
    countBackwashRows(l2Ids),
    countBackwashRows(l3Ids),
  ]);
  return { cip: { 'Line 1': r1, 'Line 2': r2, 'Line 3': r3 }, backwash: { 'Line 2': b2, 'Line 3': b3 } };
}

// คำนวณ actual + status ของงาน auto (ผลิต/CIP/backwash) จาก log จริง
async function syncTaskProgress(date) {
  // ติ๊ก "งานผลิต" อัตโนมัติจากยอด log จริง (CIP/backwash ติ๊กเอง/บันทึกผ่านหน้า CIP)
  const [prodRows, tasks] = await Promise.all([
    dbAll(`SELECT line_name, flavor, COUNT(*) AS n FROM production_logs WHERE substr(timestamp,1,10) = ? GROUP BY line_name, flavor`, [date]),
    dbAll(`SELECT * FROM daily_tasks WHERE task_date = ? AND source = 'auto_plan'`, [date]),
  ]);
  const prodMap = {};
  for (const r of prodRows) prodMap[`${r.line_name}||${r.flavor}`] = Number(r.n);
  for (const t of tasks) {
    const actual = prodMap[`${t.line_name}||${t.flavor}`] || 0;
    const target = t.target_count || 1;
    let status = 'pending';
    if (actual >= target) status = 'done';
    else if (actual > 0) status = 'in_progress';
    const completedAt = (status === 'done' && t.status !== 'done') ? nowBKK() : (status === 'done' ? t.completed_at : null);
    if (actual !== t.actual_count || status !== t.status) {
      await db.exec('UPDATE daily_tasks SET actual_count = ?, status = ?, completed_at = ? WHERE id = ?',
        [actual, status, completedAt, t.id]);
    }
  }
}

// รวมเหตุการณ์ของวันเป็นไทม์ไลน์เดียว (ผลิต + CIP + batch ทดลอง + โน้ตส่งเวร + งานเสร็จ)
async function buildTimeline(date) {
  // ไทม์ไลน์ตาม "วันทำงาน" = 06:00 ของวันนี้ → 06:00 ของวันถัดไป (ตรงกับ duty/กะดึก)
  const next = addDaysStr(date, 1);
  const start = `${date}T06:00:00`, end = `${next}T06:00:00`;
  const events = [];
  const prod = await dbAll(`SELECT timestamp, line_name, flavor, batch, operator_name FROM production_logs WHERE substr(timestamp,1,10) IN (?, ?)`, [date, next]);
  for (const p of prod) events.push({ time: p.timestamp, type: 'production', line: p.line_name,
    text: `🏭 ผลิต ${p.flavor || ''} (Batch ${p.batch || '-'}) — ${p.line_name || ''}`, operator: p.operator_name });

  const pushCipRows = async (table, sessTable, withLine) => {
    const sess = await dbAll(`SELECT * FROM ${sessTable} WHERE date IN (?, ?) OR created_at LIKE ? OR created_at LIKE ?`, [date, next, `${date}%`, `${next}%`]);
    if (!sess.length) return;
    const ids = sess.map(s => s.id);
    const byId = {}; sess.forEach(s => { byId[s.id] = s; });
    const rows = await dbAll(`SELECT session_id, row_no, data FROM ${table} WHERE session_id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const r of rows) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      if (!d.endTime) continue;
      const s = byId[r.session_id] || {};
      const line = withLine ? (s.line || 'Line 2') : 'Line 1';
      events.push({ time: d.endTime, type: 'cip', line,
        text: `💧 CIP ${line} รอบ ${r.row_no}${d.backwash ? ' + Backwash' : ''}`, operator: s.operator_name });
    }
  };
  await pushCipRows('cip_line1_rows', 'cip_line1_sessions', false);
  await pushCipRows('cip_line2_rows', 'cip_line2_sessions', true);

  const notes = await dbAll('SELECT * FROM handover_notes WHERE note_date IN (?, ?) ORDER BY created_at', [date, next]);
  for (const n of notes) {
    const isIn = n.kind === 'in';
    events.push({ time: n.created_at, type: isIn ? 'handover-in' : 'handover', line: '',
      text: `${isIn ? '📥 รับกะ' : '📝 ส่งกะ'} (${n.shift || '-'})`, operator: n.operator_name });
  }

  const doneTasks = await dbAll(`SELECT * FROM daily_tasks WHERE task_date IN (?, ?) AND status = 'done' AND completed_at IS NOT NULL`, [date, next]);
  for (const t of doneTasks) events.push({ time: t.completed_at, type: 'task', line: t.line_name,
    text: `✅ ${t.title}`, operator: t.created_by });

  // กรองเฉพาะเหตุการณ์ในหน้าต่างวันทำงาน [06:00 วันนี้, 06:00 วันถัดไป)
  return events.filter(e => e.time && String(e.time) >= start && String(e.time) < end)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

// ── Endpoints: tasks ──────────────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  try {
    await generateRecurringForDate(date); // งานประจำโผล่เองทุกวันที่เปิดหน้า
    await syncTaskProgress(date);
    const items = await dbAll('SELECT * FROM daily_tasks WHERE task_date = ? ORDER BY line_name, category, id', [date]);
    res.json({ date, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/generate', async (req, res) => {
  const date = req.body.date || req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  try {
    await generateTasksForDate(date, req.body.operator);
    await syncTaskProgress(date);
    const items = await dbAll('SELECT * FROM daily_tasks WHERE task_date = ? ORDER BY line_name, category, id', [date]);
    res.json({ success: true, date, count: items.length, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks', (req, res) => {
  const { date, line, category, title, detail, targetCount, operator } = req.body;
  if (!title) return res.status(400).json({ error: 'title จำเป็น' });
  const d = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  db.run(`INSERT INTO daily_tasks (task_date, line_name, category, title, detail, target_count, status, source, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'manual', ?, ?)
    ON CONFLICT(task_date, line_name, category, title) DO UPDATE SET detail = excluded.detail, target_count = excluded.target_count`,
    [d, line || '', category || 'manual', title, detail || null, targetCount == null ? null : Number(targetCount), operator || null, nowBKK()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    });
});

app.post('/api/tasks/update', (req, res) => {
  const { id, status, actualCount, title, detail } = req.body;
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  const completedAt = status === 'done' ? nowBKK() : null;
  db.run(`UPDATE daily_tasks SET
      status = COALESCE(?, status),
      actual_count = COALESCE(?, actual_count),
      title = COALESCE(?, title),
      detail = COALESCE(?, detail),
      completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END
    WHERE id = ?`,
    [status || null, actualCount == null ? null : Number(actualCount), title || null, detail || null, status || '', completedAt, id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.post('/api/tasks/delete-one', (req, res) => {
  db.run('DELETE FROM daily_tasks WHERE id = ?', [req.body.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// สรุปจำนวนงานต่อวันในช่วง [from, to] — ใช้วาดจุด/ตัวเลขบนปฏิทิน (ไม่ generate งานประจำล่วงหน้า)
app.get('/api/tasks/calendar', async (req, res) => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const from = req.query.from || today;
  const to = req.query.to || today;
  try {
    const rows = await dbAll(
      `SELECT task_date,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM daily_tasks
        WHERE task_date >= ? AND task_date <= ?
        GROUP BY task_date
        ORDER BY task_date`,
      [from, to]
    );
    res.json({ from, to, days: rows.map(r => ({ date: r.task_date, total: Number(r.total), done: Number(r.done) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── งานตามหน้าที่รับผิดชอบรายบุคคล (Duty board) ─────────────────────────────
// รายชื่อผู้รับผิดชอบ + เช็กลิสต์งานประจำ (โครงตายตัวตาม Notion, ซ้อนชั้นได้)
const DUTY_PEOPLE = [
  { key: 'mam',  name: 'ม้ำ',   role: 'ผู้ช่วยหลัก · ควบคุมผลิต & CIP' },
  { key: 'nai',  name: 'นาย',   role: 'ส่วนผสม & ผู้ช่วย ม้ำ' },
  { key: 'pluk', name: 'พลุ๊ก', role: 'ส่วนผสม & เครื่องบรรจุ' },
];
const ROUTINES = {
  mam: [
    { key: 'plan', title: 'ตรวจสอบแผนผลิต / CIP' },
    { key: 'assist', title: 'ทำหน้าที่ผู้ช่วย จักรกฤษ', children: [
      { key: 'control', title: 'ควบคุมกระบวนการผลิตและ CIP ทั้งหมด', children: [
        { key: 'pc', title: 'Control computer', mono: true },
        { key: 'filter', title: 'เปลี่ยนกรอง' },
        { key: 'record', title: 'จดบันทึกข้อมูลการผลิต' },
      ] },
    ] },
    { key: 'mix', title: 'ตรวจสอบส่วนผสมของผลิตภัณฑ์' },
  ],
  nai: [
    { key: 'move', title: 'ขนย้ายส่วนผสมเพื่อการผลิต' },
    { key: 'mix', title: 'ตรวจสอบส่วนผสมของผลิตภัณฑ์' },
    { key: 'pour', title: 'ดูแลการเทส่วนผสม' },
    { key: 'assist', title: 'ทำหน้าที่ผู้ช่วย ม้ำ', children: [
      { key: 'control', title: 'ควบคุมกระบวนการผลิตและ CIP', children: [
        { key: 'filter', title: 'เปลี่ยนกรอง' },
      ] },
    ] },
    { key: 'return', title: 'คืนภาชนะใช้แล้วกลับ FVH' },
  ],
  pluk: [
    { key: 'move', title: 'ขนย้ายส่วนผสมเพื่อการผลิต' },
    { key: 'pour', title: 'ดูแลการเทส่วนผสม' },
    { key: 'filter', title: 'เปลี่ยนกรอง' },
    { key: 'packer', title: 'ตรวจสอบเครื่องบรรจุ A1, A2, A3, L2', children: [
      { key: 'disasm', title: 'ถอดประกอบ, ล้าง' },
      { key: 'parts', title: 'ตรวจสอบชิ้นส่วนเครื่องจักร', children: [
        { key: 'valve', title: 'ลูกวาล์ว' },
        { key: 'oring', title: 'O-ring', mono: true },
      ] },
    ] },
  ],
};
const dutyName = (k) => (DUTY_PEOPLE.find(p => p.key === k) || {}).name || k;
function flattenRoutine(nodes, depth = 0, prefix = '') {
  const out = [];
  for (const n of nodes) {
    const key = prefix ? `${prefix}/${n.key}` : n.key;
    out.push({ key, title: n.title, depth, mono: !!n.mono });
    if (n.children) out.push(...flattenRoutine(n.children, depth + 1, key));
  }
  return out;
}

// รวมสถานะงานประจำ + งานมอบหมาย ของทุกคนในวันนั้น
async function buildDuty(date) {
  const stateRows = await dbAll('SELECT * FROM routine_state WHERE state_date = ?', [date]);
  const stateMap = {};
  for (const s of stateRows) stateMap[`${s.assignee}|${s.node_key}`] = s;
  const adhoc = await dbAll(`SELECT * FROM daily_tasks WHERE task_date = ? AND source = 'assigned' ORDER BY id`, [date]);

  let teamDone = 0, teamTotal = 0;
  const people = DUTY_PEOPLE.map(p => {
    const nodes = flattenRoutine(ROUTINES[p.key] || []).map(n => {
      const st = stateMap[`${p.key}|${n.key}`];
      return {
        ...n,
        checked: !!(st && st.checked),
        bypassed: !!(st && st.bypassed),
        bypassReason: st ? st.bypass_reason || null : null,
        handoffTo: st ? st.handoff_to || null : null,
        handoffToName: st && st.handoff_to ? dutyName(st.handoff_to) : null,
      };
    });
    // งานที่คนอื่นมอบต่อมาให้คนนี้ (bypass + handoff_to = p.key)
    const received = stateRows
      .filter(s => s.handoff_to === p.key && s.bypassed)
      .map(s => ({ ownerKey: s.assignee, fromName: dutyName(s.assignee), nodeKey: s.node_key, title: s.title, checked: !!s.checked }));
    const myAdhoc = adhoc.filter(t => t.assignee === p.key).map(t => ({
      id: t.id, title: t.title, category: t.category, location: t.location || null,
      priority: t.priority || 'normal', status: t.status, handoffFrom: t.handoff_from || null,
    }));

    const active = nodes.filter(n => !n.bypassed);
    let done = active.filter(n => n.checked).length;
    let total = active.length;
    done += received.filter(r => r.checked).length; total += received.length;
    done += myAdhoc.filter(t => t.status === 'done').length; total += myAdhoc.length;
    teamDone += done; teamTotal += total;
    return { ...p, nodes, received, adhoc: myAdhoc, done, total, pct: total ? Math.round(done / total * 100) : 100 };
  });
  return { date, holiday: weekdayOf(date) === 6, people, team: { done: teamDone, total: teamTotal, left: teamTotal - teamDone, pct: teamTotal ? Math.round(teamDone / teamTotal * 100) : 100 } };
}

app.get('/api/duty', async (req, res) => {
  const date = req.query.date || workDayBKK();
  try { res.json(await buildDuty(date)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ประวัติ %ความคืบหน้าทีมต่อวัน (สำหรับ heatmap ปฏิทิน + กราฟแนวโน้ม)
app.get('/api/duty/history', async (req, res) => {
  const to = req.query.to || todayBKK();
  const from = req.query.from || to;
  try {
    const days = [];
    const d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
    let guard = 0;
    while (d <= end && guard++ < 62) {
      const ds = d.toISOString().slice(0, 10);
      const duty = await buildDuty(ds);
      // นับเฉพาะวันที่มีความเคลื่อนไหว เพื่อไม่ให้ heatmap เต็มไปด้วย 0%
      const active = duty.team.done > 0 || duty.people.some(p => p.received.length || p.adhoc.length || p.nodes.some(n => n.bypassed));
      days.push({ date: ds, pct: duty.team.pct, done: duty.team.done, total: duty.team.total, active });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    res.json({ from, to, days });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// เช็ก/ยกเลิกเช็ก งานประจำ 1 node (ถ้าเป็นงานที่รับมอบต่อ ให้ส่ง assignee = เจ้าของงานเดิม)
app.post('/api/routine/toggle', async (req, res) => {
  const { date, assignee, nodeKey, title, checked } = req.body;
  if (!assignee || !nodeKey) return res.status(400).json({ error: 'assignee/nodeKey จำเป็น' });
  const d = date || todayBKK();
  try {
    await db.exec(
      `INSERT INTO routine_state (state_date, assignee, node_key, title, checked, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(state_date, assignee, node_key)
       DO UPDATE SET checked = excluded.checked, title = COALESCE(excluded.title, routine_state.title), updated_at = excluded.updated_at`,
      [d, assignee, nodeKey, title || null, checked ? 1 : 0, nowBKK()]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ข้ามงานประจำ (ต้องมีเหตุผล) — ถ้า reason = "ให้คนอื่นทำแทน" ให้ส่ง handoffTo = key ของคนที่รับ
app.post('/api/routine/bypass', async (req, res) => {
  const { date, assignee, nodeKey, title, reason, handoffTo } = req.body;
  if (!assignee || !nodeKey || !reason) return res.status(400).json({ error: 'assignee/nodeKey/reason จำเป็น' });
  const d = date || todayBKK();
  try {
    await db.exec(
      `INSERT INTO routine_state (state_date, assignee, node_key, title, bypassed, bypass_reason, handoff_to, checked, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)
       ON CONFLICT(state_date, assignee, node_key)
       DO UPDATE SET bypassed = 1, bypass_reason = excluded.bypass_reason, handoff_to = excluded.handoff_to,
                     checked = 0, title = COALESCE(excluded.title, routine_state.title), updated_at = excluded.updated_at`,
      [d, assignee, nodeKey, title || null, reason, handoffTo || null, nowBKK()]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// คืนงานที่ข้าม (กลับมาเป็นงานปกติ)
app.post('/api/routine/restore', async (req, res) => {
  const { date, assignee, nodeKey } = req.body;
  if (!assignee || !nodeKey) return res.status(400).json({ error: 'assignee/nodeKey จำเป็น' });
  const d = date || todayBKK();
  try {
    await db.exec(
      `UPDATE routine_state SET bypassed = 0, bypass_reason = NULL, handoff_to = NULL, updated_at = ?
       WHERE state_date = ? AND assignee = ? AND node_key = ?`,
      [nowBKK(), d, assignee, nodeKey]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// มอบหมายงานระหว่างวัน → เก็บลง daily_tasks (source = 'assigned') ผูก assignee
app.post('/api/duty/assign', async (req, res) => {
  const { date, assignTo, category, title, location, priority, operator } = req.body;
  if (!title || !assignTo) return res.status(400).json({ error: 'title/assignTo จำเป็น' });
  const d = date || todayBKK();
  try {
    await db.exec(
      `INSERT INTO daily_tasks (task_date, line_name, category, title, status, source, assignee, location, priority, created_by, created_at)
       VALUES (?, '', ?, ?, 'pending', 'assigned', ?, ?, ?, ?, ?)
       ON CONFLICT(task_date, line_name, category, title)
       DO UPDATE SET assignee = excluded.assignee, location = excluded.location, priority = excluded.priority`,
      [d, category || 'manual', title, assignTo, location || null, priority || 'normal', operator || null, nowBKK()]);
    if (process.env.TELEGRAM_CHAT_ID) {
      sendToTelegram(`🆕 <b>มอบหมายงานใหม่</b> → ${escapeHtml(dutyName(assignTo))}\n${escapeHtml(title)}${location ? ` · 📍${escapeHtml(location)}` : ''}${priority === 'urgent' ? ' · 🔴 ด่วน' : ''}\nโดย ${escapeHtml(operator || 'จักรกฤษ')}`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// สร้างข้อความสรุป + ส่งเข้า Telegram
const THAI_MON_ABBR = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thaiDate = (d) => { const [y, m, day] = String(d).split('-').map(Number); return `${day} ${THAI_MON_ABBR[m] || m} ${y + 543}`; };
const DUTY_DOT = { mam: '🟢', nai: '🔵', pluk: '🟣' };

function buildDutyText(duty) {
  if (duty.holiday) return `📋 <b>สรุปงานตามหน้าที่</b>\n🗓 ${thaiDate(duty.date)}\n\n🚫 <b>วันเสาร์ — วันหยุด</b> (ไม่มีกะทำงาน)`;
  const t = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  let bypass = 0;
  for (const p of duty.people) bypass += p.nodes.filter(n => n.bypassed).length;
  const L = [
    `📋 <b>สรุปงานตามหน้าที่</b>`,
    `🗓 ${thaiDate(duty.date)} · ${t} น.`,
    ``,
    `<b>ทีม ${duty.team.pct}%</b>  ${progressBar(duty.team.pct)}`,
    `✅ ${duty.team.done} เสร็จ · ⏳ ${duty.team.left} ค้าง${bypass ? ` · ⤼ ${bypass} ข้าม` : ''}`,
  ];
  for (const p of duty.people) {
    L.push('');
    const dot = DUTY_DOT[p.key] || '👤';
    const full = p.total && p.done >= p.total;
    L.push(`${dot} <b>${escapeHtml(p.name)}</b> · ${p.done}/${p.total} (${p.pct}%)${full ? ' 🎉' : ''}`);
    const pending = p.nodes.filter(n => !n.bypassed && !n.checked).map(n => escapeHtml(n.title))
      .concat(p.received.filter(r => !r.checked).map(r => `${escapeHtml(r.title)} <i>⟵${escapeHtml(r.fromName)}</i>`))
      .concat(p.adhoc.filter(a => a.status !== 'done').map(a => `${a.priority === 'urgent' ? '🔴 ' : ''}${escapeHtml(a.title)}`));
    for (const item of pending) L.push(`   • ${item}`);
    for (const n of p.nodes.filter(n => n.bypassed && !n.handoffTo)) L.push(`   ⤼ <i>ข้าม ${escapeHtml(n.title)} (${escapeHtml(n.bypassReason || '')})</i>`);
    for (const n of p.nodes.filter(n => n.bypassed && n.handoffTo)) L.push(`   🔁 <i>มอบ ${escapeHtml(n.title)} → ${escapeHtml(n.handoffToName)}</i>`);
    if (!pending.length && full) L.push(`   <i>— เสร็จครบทุกงาน —</i>`);
  }
  return L.join('\n');
}

app.post('/api/duty/telegram', async (req, res) => {
  const date = req.body.date || req.query.date || workDayBKK();
  try {
    const duty = await buildDuty(date);
    const text = buildDutyText(duty);
    await sendToTelegram(text);
    res.json({ success: true, sent: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), preview: text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ตั้งค่า/นัดส่งรายงานอัตโนมัติ ────────────────────────────────────────────
async function getReportConfig() {
  const rows = await dbAll('SELECT * FROM report_config ORDER BY id LIMIT 1', []);
  const r = rows[0] || {};
  return {
    id: r.id,
    autoEnabled: !!r.auto_enabled,
    times: (() => { try { return JSON.parse(r.times || '[]'); } catch { return []; } })(),
    weekdays: (() => { try { return JSON.parse(r.weekdays || '[]'); } catch { return []; } })(),
    onlyIfPending: !!r.only_if_pending,
    autoAtShiftEnd: !!r.auto_at_shift_end,
  };
}
app.get('/api/report/config', async (req, res) => {
  try {
    const cfg = await getReportConfig();
    const once = await dbAll("SELECT id, run_at FROM report_once WHERE sent = 0 ORDER BY run_at", []);
    res.json({ ...cfg, once });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/report/config', async (req, res) => {
  const { autoEnabled, times, weekdays, onlyIfPending, autoAtShiftEnd } = req.body;
  try {
    const cfg = await getReportConfig();
    await db.exec('UPDATE report_config SET auto_enabled = ?, times = ?, weekdays = ?, only_if_pending = ?, auto_at_shift_end = ?, updated_at = ? WHERE id = ?',
      [autoEnabled ? 1 : 0, JSON.stringify(times || []), JSON.stringify(weekdays || []), onlyIfPending ? 1 : 0, autoAtShiftEnd ? 1 : 0, nowBKK(), cfg.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/report/schedule', async (req, res) => {
  const { runAt } = req.body; // 'YYYY-MM-DDTHH:MM'
  if (!runAt) return res.status(400).json({ error: 'runAt จำเป็น' });
  try { await db.exec('INSERT INTO report_once (run_at, sent, created_at) VALUES (?, 0, ?)', [runAt, nowBKK()]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/report/schedule/delete', async (req, res) => {
  try { await db.exec('DELETE FROM report_once WHERE id = ?', [req.body.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ส่งรายงานของวันปัจจุบัน (ใช้ทั้งปุ่มและ scheduler) — คืน true ถ้าส่ง
async function sendDutyReport(date, onlyIfPending) {
  const duty = await buildDuty(date);
  if (onlyIfPending && duty.team.left <= 0) return false;
  await sendToTelegram(buildDutyText(duty));
  return true;
}

// ตัวจับเวลา: เช็กทุกนาที ว่าถึงเวลาส่ง auto หรือถึงนัดครั้งเดียวไหม
const _sentAutoKeys = new Set();
async function reportTick() {
  try {
    const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }); // "YYYY-MM-DD HH:MM:SS"
    const date = bkk.slice(0, 10), hm = bkk.slice(11, 16);
    const H = Number(hm.slice(0, 2));
    // รายงานสรุป "วันทำงาน" ที่กะกำลังจบ — 06:00 และหลังเที่ยงคืน = กะดึกของวันก่อนหน้า
    const sendDay = (H < 6 || hm === '06:00') ? addDaysStr(date, -1) : date;
    const wd = weekdayOf(sendDay);
    // auto: ตามเวลากำหนดเอง (+วันที่เลือก) หรือ "สิ้นกะอัตโนมัติ" (ตามตารางจริงของวันนั้น)
    const cfg = await getReportConfig();
    const shiftEndNow = cfg.autoAtShiftEnd && shiftEndsForWeekday(wd).includes(hm);
    const manualNow = cfg.times.includes(hm) && cfg.weekdays.includes(wd);
    if (cfg.autoEnabled && (shiftEndNow || manualNow)) {
      const key = `${sendDay} ${hm}`;
      if (!_sentAutoKeys.has(key)) {
        _sentAutoKeys.add(key);
        const sent = await sendDutyReport(sendDay, cfg.onlyIfPending);
        console.log(`[report] auto ${key} → ${sent ? 'sent' : 'skipped (no pending)'}`);
      }
    }
    // one-time
    const nowKey = `${date}T${hm}`;
    const due = await dbAll("SELECT id, run_at FROM report_once WHERE sent = 0 AND run_at <= ?", [nowKey]);
    for (const row of due) {
      await db.exec('UPDATE report_once SET sent = 1 WHERE id = ?', [row.id]);
      await sendDutyReport(sendDay, false);
      console.log(`[report] once ${row.run_at} → sent`);
    }
  } catch (e) { console.error('[report] tick error', e.message); }
}

// ให้ n8n Schedule เคาะทุกนาที (ปลุก Render + ทริกส่งตามตั้งค่าในแอป) — เสริม setInterval ให้ตรงเวลาแม้ Render หลับ
app.post('/api/report/tick', async (req, res) => {
  await reportTick();
  res.json({ ok: true, at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }) });
});

// แถบความคืบหน้าแบบ block (เพิ่มลูกเล่นให้ข้อความ Telegram)
function progressBar(pct, blocks = 10) {
  const filled = Math.max(0, Math.min(blocks, Math.round(pct / 100 * blocks)));
  return '▓'.repeat(filled) + '░'.repeat(blocks - filled);
}
const clip = (s) => (s.length > 60 ? s.slice(0, 59) + '…' : s);

// ── หน้า "เลือกคน" (home) — เมนูรายบุคคล + แถบทีม + ปุ่มส่งสรุป ──
// callback: p:<key> = เปิดหน้าคน, p:home = กลับ, sum = ส่งสรุป, t:<page>:<r|a>:<ref> = ปิด/เปิดงาน
function buildDutyHome(duty) {
  if (duty.holiday) return { text: `📋 <b>งานตามหน้าที่</b> · ${duty.date}\n🚫 วันเสาร์ — วันหยุด`, keyboard: [] };
  const rows = duty.people.map(p => {
    const done = p.total > 0 && p.done >= p.total;
    return [{ text: clip(`👤 ${p.name}　${p.done}/${p.total}${done ? ' ✅' : ''}`), callback_data: `p:${p.key}` }];
  });
  rows.push([{ text: '✈ ส่งสรุปเข้ากลุ่ม', callback_data: 'sum' }]);
  const text =
    `📋 <b>งานตามหน้าที่วันนี้</b> · ${duty.date}\n` +
    `${progressBar(duty.team.pct)} <b>${duty.team.pct}%</b> · คงค้าง ${duty.team.left} งาน\n\n` +
    `แตะเลือกดูงานของแต่ละคน 👇`;
  return { text, keyboard: rows };
}

// ── หน้ารายบุคคล — งานของคนนั้น (☐/✅ แตะสลับ) + งานข้าม/มอบต่อเป็นข้อความ ──
function buildDutyPerson(duty, pkey) {
  const p = duty.people.find(x => x.key === pkey);
  if (!p) return buildDutyHome(duty);
  const rows = [];
  const push = (label, data) => rows.push([{ text: clip(label), callback_data: data }]);
  for (const n of p.nodes) {
    if (n.bypassed) continue; // งานข้ามโชว์ในข้อความด้านล่างแทน
    const pre = n.depth ? '↳ '.repeat(n.depth) : '';
    push(`${n.checked ? '✅' : '☐'} ${pre}${n.title}`, `t:${pkey}:r:${pkey}:${n.key}`);
  }
  for (const r of p.received) push(`${r.checked ? '✅' : '☐'} ${r.title} ⟵${r.fromName}`, `t:${pkey}:r:${r.ownerKey}:${r.nodeKey}`);
  for (const t of p.adhoc) push(`${t.status === 'done' ? '✅' : '☐'} ${t.priority === 'urgent' ? '🔴 ' : ''}${t.title}`, `t:${pkey}:a:${t.id}`);
  rows.push([{ text: '⬅️ กลับ', callback_data: 'p:home' }, { text: '🔄 รีเฟรช', callback_data: `p:${pkey}` }]);

  let text = `👤 <b>คุณ ${p.name}</b> · ${p.role}\n${progressBar(p.pct)} <b>${p.pct}%</b> · เสร็จ ${p.done}/${p.total}`;
  const byp = p.nodes.filter(n => n.bypassed);
  for (const n of byp) text += n.handoffTo ? `\n🔁 มอบ ${n.handoffToName}: ${n.title}` : `\n⤼ ข้าม: ${n.title} (${n.bypassReason || ''})`;
  if (rows.length === 1) text += `\n\n— ไม่มีงานประจำ/มอบหมายวันนี้ —`;
  return { text, keyboard: rows };
}

// toggle งาน 1 รายการ (routine หรือ adhoc)
async function toggleAdhocDone(id) {
  const row = await dbAll('SELECT status FROM daily_tasks WHERE id = ?', [id]);
  const next = row[0] && row[0].status === 'done' ? 'pending' : 'done';
  await db.exec('UPDATE daily_tasks SET status = ?, completed_at = ? WHERE id = ?', [next, next === 'done' ? nowBKK() : null, id]);
}
async function toggleRoutineDone(owner, nodeKey, date) {
  const cur = await dbAll('SELECT checked FROM routine_state WHERE state_date = ? AND assignee = ? AND node_key = ?', [date, owner, nodeKey]);
  const next = cur[0] && cur[0].checked ? 0 : 1;
  await db.exec(
    `INSERT INTO routine_state (state_date, assignee, node_key, checked, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(state_date, assignee, node_key) DO UPDATE SET checked = excluded.checked, updated_at = excluded.updated_at`,
    [date, owner, nodeKey, next, nowBKK()]);
}

// GET keyboard (สำหรับทดสอบ) — ?person=<key> = หน้ารายบุคคล, ไม่ใส่ = หน้า home
app.get('/api/duty/keyboard', async (req, res) => {
  try {
    const duty = await buildDuty(req.query.date || workDayBKK());
    res.json(req.query.person ? buildDutyPerson(duty, req.query.person) : buildDutyHome(duty));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// รับ raw Telegram update (ข้อความสั่ง "งานค้าง" หรือปุ่ม callback) — n8n forward มาที่นี่
// server จัดการ Telegram API เอง (send/edit/answerCallback) ไม่ต้องต่อ node เพิ่มใน n8n
app.post('/api/telegram/duty-update', (req, res) => {
  res.sendStatus(200);
  (async () => {
    try {
      const upd = req.body || {};
      const date = workDayBKK();
      if (upd.callback_query) {
        const cq = upd.callback_query;
        const data = cq.data || '';
        // ส่งสรุปเข้ากลุ่ม
        if (data === 'sum') {
          await sendToTelegram(buildDutyText(await buildDuty(date)));
          await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'ส่งสรุปแล้ว ✅' });
          return;
        }
        let kb = null, note = '';
        if (data.startsWith('t:')) {                     // ปิด/เปิดงาน แล้วอยู่หน้าคนเดิม
          const parts = data.split(':');
          const page = parts[1], kind = parts[2];
          if (kind === 'a') await toggleAdhocDone(Number(parts[3]));
          else if (kind === 'r') await toggleRoutineDone(parts[3], parts.slice(4).join(':'), date);
          kb = buildDutyPerson(await buildDuty(date), page);
          note = 'อัปเดตแล้ว ✅';
        } else if (data.startsWith('p:')) {              // นำทาง: home / หน้าคน
          const target = data.slice(2);
          const duty = await buildDuty(date);
          kb = target === 'home' ? buildDutyHome(duty) : buildDutyPerson(duty, target);
        }
        if (kb && cq.message) {
          await tgApi('editMessageText', {
            chat_id: cq.message.chat.id, message_id: cq.message.message_id,
            text: kb.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb.keyboard },
          });
        }
        await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: note });
        return;
      }
      const text = upd.message?.text || '';
      if (/ปิดงาน|งานค้าง|เช็[กค]งาน|เช็[กค]\s*งาน|หน้าที่/.test(text)) {
        const kb = buildDutyHome(await buildDuty(date));
        await tgApi('sendMessage', {
          chat_id: upd.message.chat.id, text: kb.text, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: kb.keyboard },
        });
      }
    } catch (e) { console.error('[duty-update] error', e); }
  })();
});

// ── Endpoints: timeline + handover ────────────────────────────────────────
app.get('/api/timeline', async (req, res) => {
  const date = req.query.date || workDayBKK();
  try { res.json({ date, events: await buildTimeline(date) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

const SHIFT_META = { 'กะเช้า': { ic: '🌅' }, 'กะบ่าย': { ic: '🌆' }, 'กะดึก': { ic: '🌙' } };
const L4_STAGES = ['Mixing 1', 'Mixer', 'Pasteurizer', 'Mixing 2', 'Storage', 'Filling'];
const HO_DIV = '  ————————————';

// สร้างข้อความส่งกะ — รองรับทั้งฟอร์มโครงสร้าง (lines/line4) และโน้ตอิสระ (text)
// html=true → ใส่ tag สำหรับ Telegram · false → plain text สำหรับเก็บ DB/ไทม์ไลน์
function buildHandoverText(p, html) {
  const esc = html ? escapeHtml : (s) => String(s ?? '');
  const b = (s) => html ? `<b>${esc(s)}</b>` : esc(s);
  const it = (s) => html ? `<i>${esc(s)}</i>` : esc(s);
  const sm = SHIFT_META[p.shift] || { ic: '📝' };
  const nextSh = nextShiftName(p.shift, p.date);
  const t = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  const isIn = p.kind === 'in';
  const head = isIn ? `📥 ${b('รับกะ')}` : `📋 ${b('ส่งกะ')}`;
  // ส่งกะ = ส่งต่อกะถัดไป (→ next) · รับกะ = เริ่มกะของตัวเอง (ไม่มี →)
  const shiftLine = isIn
    ? `${sm.ic} ${b(p.shift || '-')} · 👤 ${esc(p.operator || '-')} · ${t} น.`
    : `${sm.ic} ${b(p.shift || '-')}${nextSh ? ` → ${esc(nextSh)}` : ''} · 👤 ${esc(p.operator || '-')} · ${t} น.`;
  const L = [head, shiftLine, ``];
  if (Array.isArray(p.lines) && p.lines.length) {
    for (const ln of p.lines) {
      L.push(`▶️ ${b(ln.line)} ${esc(ln.flavor || '')}${ln.batch ? ` (Batch ${esc(ln.batch)})` : ''}`.trimEnd());
      (ln.tanks || []).forEach((tk, i) => L.push(`   ถัง ${i + 1} ${esc((tk || '').trim() || 'ว่าง')}`));
      if (ln.note && ln.note.trim()) L.push(`   ${it('(' + ln.note.trim() + ')')}`);
      L.push(HO_DIV);
    }
    if (p.line4) {
      L.push(`▶️ ${b('Line 4')} ${esc(p.line4.flavor || '')}`.trimEnd());
      L4_STAGES.forEach((nm, i) => L.push(`   ${nm} — ${esc(((p.line4.stages || [])[i] || '').trim() || 'ว่าง')}`));
      L.push(HO_DIV);
    }
    if (p.note && p.note.trim()) L.push('', `📌 ${it(p.note.trim())}`);
    if (isIn) L.push('', `✅ ${b('รับทราบสถานะครบ')}`);
    return L.join('\n');
  }
  // โน้ตอิสระ (legacy)
  L.push(`📌 ${b('ฝากต่อกะถัดไป')}`, it(p.text || ''));
  if (isIn) L.push('', `✅ ${b('รับทราบสถานะครบ')}`);
  return L.join('\n');
}

app.post('/api/handover', async (req, res) => {
  const { date, shift, operator, text, lines, line4, note, kind } = req.body;
  const structured = Array.isArray(lines) && lines.length > 0;
  if (!structured && !text) return res.status(400).json({ error: 'text หรือ lines จำเป็น' });
  const d = date || todayBKK();
  const k = kind === 'in' ? 'in' : 'out'; // 'in' = รับกะ · 'out' = ส่งกะ (ค่าเริ่มต้น)
  const payload = { shift, operator, text, lines, line4, note, date: d, kind: k };
  const plain = buildHandoverText(payload, false);
  const dataJson = structured ? JSON.stringify({ shift, lines, line4, note }) : null;
  try {
    await db.exec('INSERT INTO handover_notes (note_date, shift, operator_name, text, data, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d, shift || null, operator || null, plain, dataJson, k, nowBKK()]);
    const html = buildHandoverText(payload, true);
    sendToTelegram(html);
    res.json({ success: true, preview: html });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// เติมฟอร์มส่งกะอัตโนมัติ: รส/batch ล่าสุดต่อ Line + เวลา CIP ล่าสุด (ให้ client ตัดสินว่าไลน์ไหน "CIP ต่อ")
app.get('/api/handover/prefill', async (req, res) => {
  const date = req.query.date || todayBKK();
  const like = `${date}%`;
  try {
    const rows = await dbAll('SELECT line_name, flavor, batch, timestamp FROM production_logs WHERE substr(timestamp,1,10) = ? ORDER BY timestamp', [date]);
    const byLine = {};
    for (const r of rows) byLine[r.line_name] = { flavor: r.flavor || '', batch: r.batch || '', prodTime: r.timestamp };
    // เวลา CIP ล่าสุดต่อไลน์วันนี้ (Line 1 = ตารางแยก · Line 2/3 = cip_line2_sessions แยกด้วยคอลัมน์ line)
    const maxT = async (sql, p) => { const r = await dbAll(sql, p); return r[0] && r[0].t ? r[0].t : null; };
    const cip = {
      'Line 1': await maxT('SELECT MAX(created_at) AS t FROM cip_line1_sessions WHERE date = ? OR created_at LIKE ?', [date, like]),
      'Line 2': await maxT("SELECT MAX(created_at) AS t FROM cip_line2_sessions WHERE COALESCE(line,'Line 2') = 'Line 2' AND (date = ? OR created_at LIKE ?)", [date, like]),
      'Line 3': await maxT("SELECT MAX(created_at) AS t FROM cip_line2_sessions WHERE line = 'Line 3' AND (date = ? OR created_at LIKE ?)", [date, like]),
    };
    for (const ln of ['Line 1', 'Line 2', 'Line 3']) if (cip[ln]) { byLine[ln] = byLine[ln] || {}; byLine[ln].cipTime = cip[ln]; }
    res.json({ date, lines: byLine });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ดึงข้อมูลส่งกะครั้งล่าสุด (สำหรับปุ่ม "คัดลอกจากกะก่อน")
app.get('/api/handover/last', async (req, res) => {
  try {
    const rows = await dbAll('SELECT data FROM handover_notes WHERE data IS NOT NULL ORDER BY id DESC LIMIT 1', []);
    res.json({ data: rows[0] ? JSON.parse(rows[0].data) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Endpoints: task templates (งานประจำ) ──────────────────────────────────
app.get('/api/task-templates', (req, res) => {
  db.all('SELECT * FROM task_templates ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/task-templates', (req, res) => {
  const { id, title, line, category, cadence, weekday, targetCount, active } = req.body;
  if (!title) return res.status(400).json({ error: 'title จำเป็น' });
  if (id) {
    db.run(`UPDATE task_templates SET title=?, line_name=?, category=?, cadence=?, weekday=?, target_count=?, active=? WHERE id=?`,
      [title, line || '', category || 'maintenance', cadence || 'daily', weekday == null ? null : Number(weekday),
       targetCount == null ? null : Number(targetCount), active == null ? 1 : Number(active), id],
      (err) => err ? res.status(500).json({ error: err.message }) : res.json({ success: true, id }));
  } else {
    db.run(`INSERT INTO task_templates (title, line_name, category, cadence, weekday, target_count, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, line || '', category || 'maintenance', cadence || 'daily', weekday == null ? null : Number(weekday),
       targetCount == null ? null : Number(targetCount), active == null ? 1 : Number(active), nowBKK()],
      function(err) { err ? res.status(500).json({ error: err.message }) : res.json({ success: true, id: this.lastID }); });
  }
});

app.post('/api/task-templates/delete-one', (req, res) => {
  db.run('DELETE FROM task_templates WHERE id = ?', [req.body.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── ผู้ช่วย AI (Claude) — พิมพ์ภาษาคน → สร้างงาน / สืบค้นข้อมูลการผลิต ───────
// เลเยอร์ tool-calling ตัวเดียว ใช้ได้ทั้งหน้าเว็บ (/api/assistant) และ Telegram (ผ่าน n8n)
// ═══════════════════════════════════════════════════════════════════════════
let _anthropic = null;
const getAnthropic = () => {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) _anthropic = new Anthropic(); // อ่าน ANTHROPIC_API_KEY จาก env
  return _anthropic;
};

const ASSISTANT_TOOLS = [
  { name: 'create_task', description: 'สร้างงานใหม่ลง To-do เมื่อผู้ใช้บอกว่าจะทำหรือทำงานอะไรเสร็จแล้ว',
    input_schema: { type: 'object', properties: {
      date: { type: 'string', description: 'วันที่ YYYY-MM-DD (ถ้าไม่ระบุ = วันนี้)' },
      line: { type: 'string', description: 'เช่น "Line 1", "Line 2", "Line 3", "Line 4" (ว่างได้)' },
      category: { type: 'string', enum: ['production', 'cip', 'backwash', 'maintenance', 'manual'] },
      title: { type: 'string' }, detail: { type: 'string' },
      target_count: { type: 'integer', description: 'จำนวนเป้าหมาย เช่น batch' },
    }, required: ['title', 'category'] } },
  { name: 'list_tasks', description: 'ดูรายการงานของวัน',
    input_schema: { type: 'object', properties: { date: { type: 'string' } } } },
  { name: 'complete_task', description: 'ทำเครื่องหมายว่างานเสร็จแล้ว (ระบุ id หรือ title)',
    input_schema: { type: 'object', properties: {
      id: { type: 'integer' }, title: { type: 'string' }, line: { type: 'string' }, date: { type: 'string' } } } },
  { name: 'get_production_summary', description: 'สรุปยอดผลิตจริงเทียบแผน แยกตาม Line/รสชาติ',
    input_schema: { type: 'object', properties: { date: { type: 'string' } } } },
  { name: 'get_cip_summary', description: 'สรุปจำนวนรอบ CIP/backwash ของวัน แยกตาม Line',
    input_schema: { type: 'object', properties: { date: { type: 'string' } } } },
  { name: 'get_timeline', description: 'ไทม์ไลน์เหตุการณ์ทั้งหมดของวัน (ผลิต/CIP/ส่งเวร)',
    input_schema: { type: 'object', properties: { date: { type: 'string' } } } },
  { name: 'query_production_range', description: 'สืบค้น/สรุปยอดผลิตข้ามวันหรือช่วงเวลา (เทียบแผน) — ใช้ตอบคำถามย้อนหลัง เช่น "สัปดาห์นี้ผลิตรสไหนเยอะสุด", เทียบหลายวัน, หรือดูแนวโน้ม',
    input_schema: { type: 'object', properties: {
      from: { type: 'string', description: 'วันเริ่ม YYYY-MM-DD' },
      to: { type: 'string', description: 'วันสิ้นสุด YYYY-MM-DD (รวมปลายทาง)' },
      flavor: { type: 'string', description: 'กรองเฉพาะรสชาติ (ถ้าต้องการ)' },
      line: { type: 'string', description: 'กรองเฉพาะ Line (ถ้าต้องการ)' },
    }, required: ['from', 'to'] } },
  { name: 'get_quality', description: 'ดูค่า Brix/pH ที่บันทึกจากการผลิต (ช่วงวัน) เพื่อตรวจค่าผิดปกติ',
    input_schema: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' },
      line: { type: 'string' }, flavor: { type: 'string' } } } },
];

async function runAssistantTool(name, input, operator) {
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const date = input.date || today();
  if (name === 'create_task') {
    await db.exec(`INSERT INTO daily_tasks (task_date, line_name, category, title, detail, target_count, status, source, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'chat', ?, ?)
      ON CONFLICT(task_date, line_name, category, title) DO UPDATE SET detail = excluded.detail, target_count = excluded.target_count`,
      [date, input.line || '', input.category || 'manual', input.title, input.detail || null,
       input.target_count == null ? null : Number(input.target_count), operator || null, nowBKK()]);
    await syncTaskProgress(date);
    return { ok: true, created: input.title };
  }
  if (name === 'list_tasks') {
    await syncTaskProgress(date);
    const items = await dbAll('SELECT id, line_name, category, title, status, target_count, actual_count FROM daily_tasks WHERE task_date = ? ORDER BY line_name, category', [date]);
    return { date, items };
  }
  if (name === 'complete_task') {
    if (input.id) await db.exec(`UPDATE daily_tasks SET status='done', completed_at=? WHERE id=?`, [nowBKK(), input.id]);
    else await db.exec(`UPDATE daily_tasks SET status='done', completed_at=? WHERE task_date=? AND title LIKE ? ${input.line ? 'AND line_name=?' : ''}`,
      input.line ? [nowBKK(), date, `%${input.title}%`, input.line] : [nowBKK(), date, `%${input.title}%`]);
    return { ok: true };
  }
  if (name === 'get_production_summary') {
    const [plan, actual] = await Promise.all([
      dbAll('SELECT line_name, flavor, planned_batches FROM production_plans WHERE plan_date = ?', [date]),
      dbAll(`SELECT line_name, flavor, COUNT(*) AS actual FROM production_logs WHERE substr(timestamp,1,10)=? GROUP BY line_name, flavor`, [date]),
    ]);
    return { date, plan, actual };
  }
  if (name === 'get_cip_summary') return { date, ...(await cipRoundsForDate(date)) };
  if (name === 'get_timeline') return { date, events: await buildTimeline(date) };
  if (name === 'query_production_range') {
    const from = input.from || date, to = input.to || date;
    const cond = ['substr(timestamp,1,10) BETWEEN ? AND ?']; const args = [from, to];
    if (input.flavor) { cond.push('flavor = ?'); args.push(input.flavor); }
    if (input.line) { cond.push('line_name = ?'); args.push(input.line); }
    const w = cond.join(' AND ');
    const pc = ['plan_date BETWEEN ? AND ?']; const pa = [from, to];
    if (input.flavor) { pc.push('flavor = ?'); pa.push(input.flavor); }
    if (input.line) { pc.push('line_name = ?'); pa.push(input.line); }
    const [byFlavor, byLine, byDay, plan] = await Promise.all([
      dbAll(`SELECT flavor, COUNT(*) AS actual FROM production_logs WHERE ${w} GROUP BY flavor ORDER BY actual DESC`, args),
      dbAll(`SELECT line_name, COUNT(*) AS actual FROM production_logs WHERE ${w} GROUP BY line_name`, args),
      dbAll(`SELECT substr(timestamp,1,10) AS day, COUNT(*) AS actual FROM production_logs WHERE ${w} GROUP BY day ORDER BY day`, args),
      dbAll(`SELECT flavor, SUM(planned_batches) AS planned FROM production_plans WHERE ${pc.join(' AND ')} GROUP BY flavor`, pa),
    ]);
    const total = byDay.reduce((s, r) => s + Number(r.actual), 0);
    const plannedTotal = plan.reduce((s, r) => s + Number(r.planned || 0), 0);
    return { from, to, total, plannedTotal, byFlavor, byLine, byDay, plan };
  }
  if (name === 'get_quality') {
    const from = input.from || date, to = input.to || date;
    const cond = ['substr(timestamp,1,10) BETWEEN ? AND ?', '(brix IS NOT NULL OR ph IS NOT NULL)']; const args = [from, to];
    if (input.line) { cond.push('line_name = ?'); args.push(input.line); }
    if (input.flavor) { cond.push('flavor = ?'); args.push(input.flavor); }
    const rows = await dbAll(`SELECT substr(timestamp,1,10) AS day, line_name, flavor, batch, brix, ph FROM production_logs WHERE ${cond.join(' AND ')} ORDER BY timestamp DESC LIMIT 100`, args);
    return { from, to, count: rows.length, rows };
  }
  return { error: 'unknown tool' };
}

app.post('/api/assistant', async (req, res) => {
  const client = getAnthropic();
  if (!client) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์' });
  const { message, operator, session } = req.body;
  if (!message) return res.status(400).json({ error: 'message จำเป็น' });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const FLAVORS = 'Amazon, FDS, Golden, Freshy Lychee, Freshy Strawberry, Senorita Coconut, Senorita Caramel, Freshy Blue Hawaii, Freshy Lime, Freshy Green Apple, Freshy Sala, Senorita Yuzu, Senorita Peach, MLH 02, Freshy Pineapple, Freshy Grape, Freshy Punch, Freshy blue Lemon, Senorita Fres Mint, Freshy Orange, Signature Rose, Freshy Shine Muscat Grape, Freshy Peach, Freshy Mango, Dilute W-Molass';
  const system = [
    'คุณเป็นผู้ช่วยอัจฉริยะสำหรับบันทึกและวิเคราะห์ข้อมูลการผลิตน้ำเชื่อม/น้ำหวานของโรงงาน คุยแบบเป็นกันเองแต่มืออาชีพ',
    `วันนี้คือ ${today} (เขตเวลา Asia/Bangkok)`,
    'สายการผลิต/CIP: Line 1 (Syrup), Line 2 และ Line 3 (Flavour), Line 4 (Mixing/Pasteurizer)',
    `รสชาติที่มี: ${FLAVORS}`,
    'ถ้าผู้ใช้พิมพ์ชื่อรสผิด/สะกดเพี้ยน/เป็นภาษาไทย ให้จับคู่กับรสที่ใกล้เคียงที่สุดในลิสต์เอง (เช่น "อเมซอน"→Amazon, "ลิ้นจี่"→Freshy Lychee) ไม่แน่ใจค่อยถามยืนยัน',
    'หมายเหตุ: Dilute W-Molass บันทึกเป็นรอบ No.1–20 (รสอื่นเป็น Batch A-Z)',
    '',
    'ความสามารถ:',
    '• บันทึกงาน: create_task (category ผลิต=production, ทำความสะอาด=cip, backwash=backwash, ซ่อมบำรุง=maintenance) · ปิดงาน: complete_task',
    '• ข้อมูลวันเดียว: get_production_summary / get_cip_summary / get_timeline / list_tasks',
    '• ข้ามวัน/ช่วงเวลา/แนวโน้ม: query_production_range (from,to) เช่น "สัปดาห์นี้", "3 วันก่อน", "เดือนนี้"',
    '• คุณภาพ: get_quality (Brix/pH) — เจอค่าที่ดูผิดปกติให้ทักเตือน',
    '',
    'วิธีตอบ:',
    '• เรียก tool ดึงข้อมูลจริงก่อนตอบเสมอ ห้ามเดา/มโนตัวเลข',
    '• เชิงรุก: ถ้าผลิตไม่ทันแผน (จริงน้อยกว่าแผนมาก) / ค่า Brix,pH ผิดปกติ / เห็นแนวโน้มน่าสนใจ ให้ทักเตือนผู้ใช้ด้วย',
    '• ตอบภาษาไทย กระชับ อ่านง่าย เน้นตัวเลขสำคัญ ใส่ emoji พอประมาณ',
    '• ใช้บริบทจากบทสนทนาก่อนหน้าเมื่อเป็นคำถามต่อเนื่อง',
  ].join('\n');

  try {
    const actions = [];
    // โหลดบทสนทนาก่อนหน้าของ session นี้ (multi-turn memory) — เก็บเฉพาะข้อความเป็น text
    let history = [];
    if (session) {
      const rows = await dbAll('SELECT role, content FROM assistant_messages WHERE session = ? ORDER BY id DESC LIMIT 12', [session]);
      history = rows.reverse().filter(r => r.content && String(r.content).trim());
      while (history.length && history[0].role !== 'user') history.shift(); // ต้องเริ่มด้วย user
    }
    const messages = [...history.map(r => ({ role: r.role, content: r.content })), { role: 'user', content: String(message) }];
    let reply = '';
    for (let turn = 0; turn < 6; turn++) {
      const resp = await client.messages.create({
        model: 'claude-opus-4-8', max_tokens: 4096, system, tools: ASSISTANT_TOOLS, messages,
      });
      if (resp.stop_reason !== 'tool_use') {
        reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        break;
      }
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        let out;
        try { out = await runAssistantTool(block.name, block.input || {}, operator); }
        catch (e) { out = { error: e.message }; }
        actions.push({ tool: block.name, input: block.input });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    reply = reply || 'รับทราบครับ';
    // เก็บบทสนทนารอบนี้ไว้ต่อ session (จำกัดไว้ ~30 ข้อความล่าสุดต่อ session)
    if (session) {
      const ts = nowBKK();
      await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [session, 'user', String(message), ts]);
      await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [session, 'assistant', reply, ts]);
      await db.exec(`DELETE FROM assistant_messages WHERE session = ? AND id NOT IN (SELECT id FROM assistant_messages WHERE session = ? ORDER BY id DESC LIMIT 30)`, [session, session]);
    }
    res.json({ reply, actions });
  } catch (err) {
    console.error('[assistant] error', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches', (req, res) => {
  db.all("SELECT * FROM cip_batches ORDER BY id DESC LIMIT 50", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/steps', (req, res) => {
  const query = `
    SELECT s.*, b.operator_name, b.start_time as batch_start, b.end_time as batch_end, b.status as batch_status
    FROM cip_step_logs s
    LEFT JOIN cip_batches b ON s.batch_id = b.id
    ORDER BY s.batch_id DESC, s.step_number ASC
    LIMIT 300
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/batches/delete-one', (req, res) => {
  const { batchId } = req.body;
  db.run("DELETE FROM cip_step_logs WHERE batch_id = ?", [batchId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.run("DELETE FROM cip_batches WHERE id = ?", [batchId], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ success: true });
    });
  });
});

app.post('/api/batches/reset', (req, res) => {
  db.run("DELETE FROM cip_step_logs", () => {
    db.run("DELETE FROM cip_batches", () => {
      res.json({ success: true });
    });
  });
});

const PUBLIC_URL = 'https://back-wash-test.onrender.com';
const registerTelegramWebhook = async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await axios.get(`https://api.telegram.org/bot${token}/setWebhook`, { params: { url: `${PUBLIC_URL}/api/telegram/webhook` } });
    console.log('[Telegram] Webhook registered');
  } catch (e) { console.error('[Telegram] Webhook registration failed', e.response?.data || e.message); }
};

initDb()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`Server running at http://0.0.0.0:${port}`);
      // ปิดไว้ชั่วคราว — Telegram อนุญาตแค่ webhook เดียวต่อบอท และ n8n's Telegram Trigger
      // (n8n-Telegram-Production-Chart.json) ใช้บอทตัวเดียวกันสำหรับ "สรุปยอดผลิตวันนี้"
      // เปิดอีกครั้งได้เมื่อ n8n ฝั่งนั้น deactivate ไปแล้วจริงๆ หรือออกแบบให้ทำงานร่วมกันแล้ว
      // registerTelegramWebhook();
      // ตัวจับเวลาส่งรายงานอัตโนมัติ — เช็กทุกนาที (ต้องให้เซิร์ฟเวอร์ตื่นอยู่; มี Keep-Warm ping ช่วย)
      setInterval(reportTick, 60 * 1000);
      console.log('[report] scheduler started (every 60s)');
    });
  })
  .catch((err) => {
    console.error('[db] init failed — server not started', err);
    process.exit(1);
  });
