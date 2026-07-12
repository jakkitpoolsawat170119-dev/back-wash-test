require('dotenv').config();
const express = require('express');
const db = require('./db');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const Anthropic = require('@anthropic-ai/sdk');
const { renderShiftCardPNG, canRenderCard } = require('./shiftCard');

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
  `CREATE TABLE IF NOT EXISTS line_state (
      line_name TEXT PRIMARY KEY,
      status TEXT DEFAULT 'idle',
      flavor TEXT,
      batch TEXT,
      operator_name TEXT,
      since TEXT,
      updated_at TEXT
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
  // คิวการบันทึกจากผู้ช่วย AI ที่รอผู้ใช้กดยืนยัน + audit log ว่าใครสั่งบันทึกอะไร
  `CREATE TABLE IF NOT EXISTS assistant_actions (
      id ${db.pk},
      session TEXT,
      operator_name TEXT,
      tool TEXT,
      input TEXT,
      summary TEXT,
      status TEXT DEFAULT 'pending',
      result TEXT,
      created_at TEXT,
      decided_at TEXT
    )`,
  // ── เฟส 2: ความจำถาวรของผู้ช่วย AI ───────────────────────────────────────
  // สิ่งที่ผู้ใช้บอกให้จำ (ค่ามาตรฐาน, ชื่อเล่น, ความชอบ, บริบทงาน) — ข้ามหลาย session
  // scope='global' = จำรวมทุกคน · scope=ชื่อ operator = จำเฉพาะคนนั้น
  `CREATE TABLE IF NOT EXISTS assistant_memory (
      id ${db.pk},
      scope TEXT DEFAULT 'global',
      key TEXT,
      value TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(scope, key)
    )`,
  // ── เฟส 1: กันรันวิเคราะห์สิ้นกะซ้ำ — 1 แถวต่อ (วันทำงาน+กะ) ──────────────
  `CREATE TABLE IF NOT EXISTS shift_analysis_log (
      id ${db.pk},
      work_day TEXT,
      shift TEXT,
      summary TEXT,
      created_at TEXT,
      UNIQUE(work_day, shift)
    )`,
  // ── ค่ามาตรฐานคุณภาพ (baseline) ต่อรสชาติ — ผู้ใช้ตั้งเอง ให้เตือน Brix/pH เฉพาะที่ผิดจริง
  `CREATE TABLE IF NOT EXISTS quality_specs (
      flavor TEXT UNIQUE,
      brix_min REAL,
      brix_max REAL,
      ph_min REAL,
      ph_max REAL,
      updated_at TEXT
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
  // migration (เฟส 1): เปิด/ปิดการวิเคราะห์สิ้นกะอัตโนมัติของผู้ช่วย AI (เปิดเป็นค่าเริ่มต้น)
  try { await db.exec('ALTER TABLE report_config ADD COLUMN shift_analysis_enabled INTEGER DEFAULT 1'); } catch { /* มีแล้ว */ }
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

// ── สถานะไลน์แบบ real-time (Live board) ─────────────────────────
// อัปเดตเมื่อกด Start (producing/cip) / Done (idle) ในหน้า Production Control
app.post('/api/line-state', (req, res) => {
  const { line, status, flavor, batch, operator } = req.body;
  if (!line) return res.status(400).json({ error: 'line จำเป็น' });
  const now = nowBKK();
  db.run(
    `INSERT INTO line_state (line_name, status, flavor, batch, operator_name, since, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(line_name) DO UPDATE SET status = excluded.status, flavor = excluded.flavor, batch = excluded.batch, operator_name = excluded.operator_name, since = excluded.since, updated_at = excluded.updated_at`,
    [line, status || 'idle', flavor || null, batch || null, operator || null, now, now],
    (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
  );
});

app.get('/api/line-state', (req, res) => {
  db.all('SELECT * FROM line_state', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const map = {};
    for (const r of rows) map[r.line_name] = { status: r.status, flavor: r.flavor, batch: r.batch, operator: r.operator_name, since: r.since, updatedAt: r.updated_at };
    res.json({ lines: map });
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

// ── ตารางกะ 2 ชั้น (ดู memory shift-schedule) ────────────────────────────────
// (1) "ทีมผู้ใช้" = shiftsForWeekday — เสาร์เป็นวันหยุดของทีมนี้ (ตรงกับ client/src/shiftSchedule.ts)
//     ใช้กับ duty board / งานประจำ (recurring) / รายงานสิ้นกะของทีม
// (2) "โรงงาน" = factoryShiftsForWeekday — โรงงานเดินจริง 7 วัน (เสาร์เดิน 2 กะเหมือน ศ/อา
//     มีอีก 2 กะหมุนมาแทนทีมที่หยุด) ใช้กับแผน/ผลิต/วิเคราะห์สิ้นกะ (เฟส 1)
// จ–พฤ: เช้า06-14/บ่าย14-22/ดึก22-06 · ศ,ส,อา: เช้า06-18/ดึก18-06 · วันทำงาน=06:00→06:00
function shiftsForWeekday(wd) {
  if (wd === 6) return []; // เสาร์ = ทีมผู้ใช้หยุด
  if (wd === 5 || wd === 0) return [{ key: 'เช้า', start: 6, end: 18 }, { key: 'ดึก', start: 18, end: 6 }];
  return [{ key: 'เช้า', start: 6, end: 14 }, { key: 'บ่าย', start: 14, end: 22 }, { key: 'ดึก', start: 22, end: 6 }];
}
// ตารางกะระดับโรงงาน — เดินจริงทุกวัน (เสาร์เดิน 2 กะเหมือน ศ/อา)
function factoryShiftsForWeekday(wd) {
  if (wd === 5 || wd === 6 || wd === 0) return [{ key: 'เช้า', start: 6, end: 18 }, { key: 'ดึก', start: 18, end: 6 }];
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
    const isPacking = isIn && /บรรจุ/.test(n.text || '');
    const label = isPacking ? '📦 รายงานบรรจุ' : isIn ? '📥 รับกะ' : '📝 ส่งกะ';
    events.push({ time: n.created_at, type: isIn ? 'handover-in' : 'handover', line: '',
      text: `${label} (${n.shift || '-'})`, operator: n.operator_name });
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
    shiftAnalysisEnabled: r.shift_analysis_enabled == null ? true : !!r.shift_analysis_enabled,
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
  const { autoEnabled, times, weekdays, onlyIfPending, autoAtShiftEnd, shiftAnalysisEnabled } = req.body;
  try {
    const cfg = await getReportConfig();
    const sae = shiftAnalysisEnabled == null ? cfg.shiftAnalysisEnabled : shiftAnalysisEnabled;
    await db.exec('UPDATE report_config SET auto_enabled = ?, times = ?, weekdays = ?, only_if_pending = ?, auto_at_shift_end = ?, shift_analysis_enabled = ?, updated_at = ? WHERE id = ?',
      [autoEnabled ? 1 : 0, JSON.stringify(times || []), JSON.stringify(weekdays || []), onlyIfPending ? 1 : 0, autoAtShiftEnd ? 1 : 0, sae ? 1 : 0, nowBKK(), cfg.id]);
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
  await shiftAnalysisTick();
  res.json({ ok: true, at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }) });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── เฟส 1: วิเคราะห์สิ้นกะอัตโนมัติ → สรุป/แจ้งเตือน Telegram ────────────────
// เกาะจังหวะเดียวกับ reportTick (ทุก 60s) เช็กว่าเวลานี้เป็น "เวลาสิ้นกะ" ตามตารางจริงไหม
// ═══════════════════════════════════════════════════════════════════════════
// คืนกะที่เพิ่งจบพอดีที่เวลา hm ของวัน dateStr (ตามตารางกะจริง) หรือ null
function shiftJustEnded(dateStr, hm) {
  if (!/^\d\d:00$/.test(hm)) return null; // กะจบเป็นชั่วโมงเต็มเสมอ
  const H = Number(hm.slice(0, 2));
  // กะดึกจบ 06:00 = นับเป็นวันทำงานก่อนหน้า (เหมือน sendDay ใน reportTick)
  const workDay = (H < 6 || hm === '06:00') ? addDaysStr(dateStr, -1) : dateStr;
  // ใช้ตารางระดับ "โรงงาน" — วิเคราะห์สิ้นกะทุกวันที่โรงงานเดินจริง (รวมเสาร์)
  const shifts = factoryShiftsForWeekday(weekdayOf(workDay));
  const s = shifts.find((sh) => sh.end === H);
  return s ? { workDay, shift: s.key, shiftLabel: `กะ${s.key}` } : null;
}

// ── ค่ามาตรฐานคุณภาพ (baseline) ต่อรส — อ่าน/เขียนตาราง quality_specs ──────────
async function getQualitySpecs() {
  const rows = await dbAll('SELECT flavor, brix_min, brix_max, ph_min, ph_max, updated_at FROM quality_specs', []);
  const map = {};
  for (const r of rows) map[r.flavor] = r;
  return map;
}
async function setQualitySpec(flavor, spec = {}) {
  const f = String(flavor || '').trim();
  if (!f) throw new Error('ต้องระบุรสชาติ');
  const num = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const row = { brix_min: num(spec.brix_min), brix_max: num(spec.brix_max), ph_min: num(spec.ph_min), ph_max: num(spec.ph_max) };
  await db.exec(
    `INSERT INTO quality_specs (flavor, brix_min, brix_max, ph_min, ph_max, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(flavor) DO UPDATE SET brix_min = excluded.brix_min, brix_max = excluded.brix_max, ph_min = excluded.ph_min, ph_max = excluded.ph_max, updated_at = excluded.updated_at`,
    [f, row.brix_min, row.brix_max, row.ph_min, row.ph_max, nowBKK()]);
  return { flavor: f, ...row };
}

// ── วันที่ไทยแบบย่อ (คงปี ค.ศ. ตามที่ใช้ในแอป) ──────────────────────────────
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const pad2 = (n) => String(n).padStart(2, '0');
function formatThaiDate(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return `${d} ${TH_MONTHS[(m - 1) % 12]} ${y}`;
}
const levelRank = { crit: 0, warn: 1, mute: 2 };

// ═══════════════════════════════════════════════════════════════════════════
// buildShiftCardData — สร้าง "ข้อมูลการ์ดสรุปสิ้นกะ" จาก DB โดยตรง (deterministic)
// ตัวเลขทุกตัวมาจาก query จริง (ไม่ให้ AI พิมพ์เอง = ไม่มั่ว) · นับตามช่วงกะ/วันทำงานจริง
// โหมด: กะดึก(ปิดวัน) = เทียบยอดทั้งวันกับแผน · กะเช้า/บ่าย = โชว์ยอดเฉพาะกะนี้ (ยังไม่เทียบแผนทั้งวัน)
// คืน null ถ้าไม่มีข้อมูลเลย (กะว่างจริง)
// ═══════════════════════════════════════════════════════════════════════════
async function buildShiftCardData(workDay, shiftKey) {
  const wd = weekdayOf(workDay);
  const key = String(shiftKey || '').replace(/^กะ/, '');
  const shiftObj = factoryShiftsForWeekday(wd).find((s) => s.key === key);
  if (!shiftObj) return null;
  const isLast = shiftObj.end === 6; // กะดึกปิดวันทำงาน → สรุปทั้งวันเทียบแผนได้

  // ช่วงเวลา "กะนี้" (ข้ามเที่ยงคืนถ้าจำเป็น) และ "วันทำงาน" (06:00→06:00)
  const shiftStart = `${workDay}T${pad2(shiftObj.start)}:00:00`;
  const shiftEndDate = shiftObj.end <= shiftObj.start ? addDaysStr(workDay, 1) : workDay;
  const shiftEnd = `${shiftEndDate}T${pad2(shiftObj.end)}:00:00`;
  const dayStart = `${workDay}T06:00:00`, dayEnd = `${addDaysStr(workDay, 1)}T06:00:00`;

  await syncTaskProgress(workDay).catch(() => {});
  const [shiftRows, dayRows, planRows, specs, cip, qRows, taskRows] = await Promise.all([
    dbAll('SELECT line_name, flavor, COUNT(*) n FROM production_logs WHERE timestamp >= ? AND timestamp < ? GROUP BY line_name, flavor', [shiftStart, shiftEnd]),
    dbAll('SELECT line_name, flavor, COUNT(*) n FROM production_logs WHERE timestamp >= ? AND timestamp < ? GROUP BY line_name, flavor', [dayStart, dayEnd]),
    dbAll('SELECT line_name, flavor, SUM(planned_batches) planned FROM production_plans WHERE plan_date = ? GROUP BY line_name, flavor', [workDay]),
    getQualitySpecs(),
    cipRoundsForDate(workDay),
    dbAll('SELECT flavor, MIN(brix) bmin, MAX(brix) bmax, MIN(ph) pmin, MAX(ph) pmax, COUNT(brix) bc, COUNT(ph) pc FROM production_logs WHERE timestamp >= ? AND timestamp < ? AND (brix IS NOT NULL OR ph IS NOT NULL) GROUP BY flavor', [dayStart, dayEnd]),
    dbAll("SELECT line_name, category, title, status, target_count, actual_count FROM daily_tasks WHERE task_date = ? AND status != 'done' ORDER BY category, line_name", [workDay]),
  ]);

  const shiftTotal = shiftRows.reduce((s, r) => s + Number(r.n), 0);
  const dayTotal = dayRows.reduce((s, r) => s + Number(r.n), 0);
  const dayPlanTotal = planRows.reduce((s, r) => s + Number(r.planned || 0), 0);
  const cipTotal = Object.values(cip.cip).reduce((a, b) => a + Number(b || 0), 0)
    + Object.values(cip.backwash).reduce((a, b) => a + Number(b || 0), 0);

  // ── ยอดผลิตต่อไลน์ ──────────────────────────────────────────────────────
  const kmap = (rows, f) => { const m = {}; for (const r of rows) m[`${r.line_name}||${r.flavor}`] = f(r); return m; };
  const dayMap = kmap(dayRows, (r) => Number(r.n));
  const shiftMap = kmap(shiftRows, (r) => Number(r.n));
  const planMap = kmap(planRows, (r) => Number(r.planned || 0));
  const watch = [];
  let lines = [];
  if (isLast) {
    // โหมดทั้งวัน — union(แผน, ผลิตจริงทั้งวัน)
    const keys = [...new Set([...Object.keys(planMap), ...Object.keys(dayMap)])];
    lines = keys.map((k) => {
      const [line, flavor] = k.split('||');
      const actual = dayMap[k] || 0;
      const plan = planMap[k] != null ? planMap[k] : null;
      let status = 'mute', label = null, pct = null;
      if (plan == null) { status = 'mute'; label = 'นอกแผน'; }
      else if (plan === 0) { status = 'mute'; label = null; }
      else {
        pct = Math.round((actual / plan) * 100);
        if (actual >= plan) { status = 'good'; label = actual > plan ? 'เกินแผน' : 'ครบแผน'; }
        else { status = pct >= 50 ? 'warn' : 'crit'; label = 'ตกแผน'; }
      }
      return { line, flavor, actual, plan, pct, status, statusLabel: label };
    }).sort((a, b) => (a.line || '').localeCompare(b.line || '') || (a.flavor || '').localeCompare(b.flavor || ''));
    // แจ้งเตือนไลน์ที่ตกแผน
    for (const ln of lines) {
      if (ln.plan && ln.actual < ln.plan) {
        const p = ln.pct;
        watch.push({ level: p < 50 ? 'crit' : 'warn', text: `${ln.line} ${ln.flavor} ตกแผน — ทำได้ ${ln.actual}/${ln.plan} (${p}%)` });
      }
    }
  } else {
    // โหมดกะ — โชว์เฉพาะยอดที่ผลิตในกะนี้
    lines = Object.keys(shiftMap).map((k) => {
      const [line, flavor] = k.split('||');
      return { line, flavor, actual: shiftMap[k], plan: null, pct: null, status: 'mute', statusLabel: null };
    }).sort((a, b) => (a.line || '').localeCompare(b.line || '') || (a.flavor || '').localeCompare(b.flavor || ''));
  }

  // ── คุณภาพ (Brix/pH) เทียบสเปกจริง — เตือนเฉพาะที่มีสเปกและออกนอกช่วง ─────
  const fmtNum = (v) => (v == null ? '-' : (Math.round(v * 100) / 100));
  const rangeStr = (a, b) => (a === b ? `${fmtNum(a)}` : `${fmtNum(a)}–${fmtNum(b)}`);
  for (const q of qRows) {
    const sp = specs[q.flavor];
    if (!sp) continue; // ยังไม่ตั้งสเปก → ไม่เตือน (กัน false alarm)
    if (q.bc > 0 && (sp.brix_min != null || sp.brix_max != null)) {
      const low = sp.brix_min != null && q.bmin < sp.brix_min;
      const high = sp.brix_max != null && q.bmax > sp.brix_max;
      if (low || high) watch.push({ level: 'warn', text: `Brix ${q.flavor} ${rangeStr(q.bmin, q.bmax)} · ${low ? 'ต่ำ' : 'สูง'}กว่าสเปก ${rangeStr(sp.brix_min, sp.brix_max)} — ควรตรวจซ้ำ` });
    }
    if (q.pc > 0 && (sp.ph_min != null || sp.ph_max != null)) {
      const low = sp.ph_min != null && q.pmin < sp.ph_min;
      const high = sp.ph_max != null && q.pmax > sp.ph_max;
      if (low || high) watch.push({ level: 'warn', text: `pH ${q.flavor} ${rangeStr(q.pmin, q.pmax)} · ${low ? 'ต่ำ' : 'สูง'}กว่าสเปก ${rangeStr(sp.ph_min, sp.ph_max)} — ควรตรวจซ้ำ` });
    }
  }

  // ── CIP / Backwash ──────────────────────────────────────────────────────
  let cipBlock;
  if (cipTotal === 0) {
    cipBlock = { level: isLast ? 'warn' : 'mute', text: 'ไม่มีรอบบันทึกวันนี้ (0 ทุกไลน์)' + (isLast ? ' — เช็กว่าตกหล่นหรือยังไม่ได้ล้าง' : '') };
    if (isLast) watch.push({ level: 'warn', text: 'CIP ไม่มีบันทึกทั้งวัน — เช็กว่าตกหล่นหรือยังไม่ได้ล้าง' });
  } else {
    const parts = [];
    for (const L of ['Line 1', 'Line 2', 'Line 3']) {
      const c = Number(cip.cip[L] || 0), b = Number(cip.backwash?.[L] || 0);
      if (c || b) parts.push(`${L}: ${c}${b ? ` (+BW ${b})` : ''}`);
    }
    cipBlock = { level: 'mute', text: parts.join(' · ') + ' รอบ' };
  }

  // ── งานค้าง ──────────────────────────────────────────────────────────────
  const prodPending = taskRows.filter((t) => t.category === 'production');
  const otherPending = taskRows.filter((t) => t.category !== 'production');
  const taskItems = [];
  for (const t of prodPending) taskItems.push({ text: `${t.title}${t.line_name ? ` (${t.line_name})` : ''} ยังไม่เสร็จ` });
  if (otherPending.length) {
    const grouped = {};
    for (const t of otherPending) (grouped[t.category] || (grouped[t.category] = [])).push(t.title);
    const catName = { maintenance: 'ซ่อมบำรุง', cip: 'CIP', backwash: 'Backwash', recurring: 'งานประจำ' };
    for (const [cat, titles] of Object.entries(grouped)) {
      taskItems.push({ text: catName[cat] || cat, sub: titles.join(' · ') });
    }
  }

  // ไม่มีข้อมูลเลย → SKIP
  if (dayTotal === 0 && planRows.length === 0 && taskRows.length === 0 && cipTotal === 0) return null;

  // ── KPI ตามโหมด ──────────────────────────────────────────────────────────
  const pctDay = dayPlanTotal > 0 ? Math.round((dayTotal / dayPlanTotal) * 100) : null;
  const pctColor = pctDay == null ? '#93a2ab' : (pctDay >= 95 ? '#39b57e' : (pctDay >= 70 ? '#eea23a' : '#ec5f5c'));
  const warnCount = watch.filter((w) => w.level === 'crit' || w.level === 'warn').length;
  const kpiCols = isLast
    ? [
        { num: `${dayTotal}`, unit: ` / ${dayPlanTotal}`, label: 'ผลิตจริง / แผน (batch)', color: '#eaf0f3' },
        { num: pctDay != null ? `${pctDay}%` : '–', label: 'ทำได้ตามแผน', color: pctColor },
        { num: `${warnCount}`, label: 'จุดต้องระวัง', color: warnCount ? '#ec5f5c' : '#39b57e' },
      ]
    : [
        { num: `${shiftTotal}`, label: 'ผลิตกะนี้ (batch)', color: '#eaf0f3' },
        { num: `${dayTotal}`, label: 'สะสมวันทำงาน', color: '#eaf0f3' },
        { num: `${warnCount}`, label: 'จุดต้องระวัง', color: warnCount ? '#ec5f5c' : '#39b57e' },
      ];

  watch.sort((a, b) => (levelRank[a.level] ?? 3) - (levelRank[b.level] ?? 3));
  const nowHM = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(11, 16);
  return {
    workDay, shiftKey: key, mode: isLast ? 'day' : 'shift',
    shiftLabel: `กะ${key}`, shiftTime: `${pad2(shiftObj.start)}:00–${pad2(shiftObj.end)}:00`,
    workDayText: formatThaiDate(workDay), sentTime: nowHM,
    kpiCols, lines,
    cip: cipBlock,
    tasks: { count: taskRows.length, items: taskItems },
    watch: watch.slice(0, 5),
  };
}

// สรุปเป็นข้อความ (fallback เมื่อ render รูปไม่ได้ หรือส่งรูปพลาด) — HTML สำหรับ Telegram
function shiftDataToText(d) {
  const L = [];
  L.push(`🏁 <b>สรุปสิ้น${escapeHtml(d.shiftLabel)}</b> · วันทำงาน ${escapeHtml(d.workDayText)}`);
  L.push('');
  L.push('📦 <b>ยอดผลิต</b>');
  if (!d.lines.length) L.push('• ไม่มีการผลิตในกะนี้');
  for (const ln of d.lines) {
    const val = ln.plan != null ? `${ln.actual}/${ln.plan}` : `${ln.actual} batch`;
    L.push(`• ${escapeHtml(ln.line)} ${escapeHtml(ln.flavor)}: ${val}${ln.statusLabel ? ` — ${escapeHtml(ln.statusLabel)}` : ''}`);
  }
  L.push('');
  L.push(`🫧 CIP/Backwash: ${escapeHtml(d.cip.text)}`);
  L.push(`📋 งานค้าง: ${d.tasks.count ? d.tasks.count + ' รายการ' : 'ไม่มี ✅'}`);
  for (const it of d.tasks.items) L.push(`• ${escapeHtml(it.text)}${it.sub ? ` — ${escapeHtml(it.sub)}` : ''}`);
  if (d.watch.length) {
    L.push('');
    L.push('⚠️ <b>จุดที่ต้องระวัง</b>');
    for (const w of d.watch) L.push(`• ${escapeHtml(w.text)}`);
  }
  return L.join('\n');
}

// รวมทุกอย่าง: สร้างข้อมูล → เรนเดอร์รูป (มี fallback ข้อความ) — คืน { data, png, caption, text } หรือ null
async function runShiftAnalysis(workDay, shiftKey) {
  const data = await buildShiftCardData(workDay, shiftKey);
  if (!data) return null;
  const caption = `🏁 สรุปสิ้น${data.shiftLabel} · วันทำงาน ${data.workDayText}`;
  let png = null;
  try { png = renderShiftCardPNG(data); } catch (e) { console.error('[shift-analysis] render error', e.message); }
  return { data, png, caption, text: shiftDataToText(data) };
}

const _shiftAnalysisRunning = new Set(); // กันรันซ้อนภายในโปรเซสเดียวระหว่างที่ Claude ยังตอบไม่เสร็จ
async function shiftAnalysisTick() {
  try {
    // เดิมพึ่ง Claude — ตอนนี้ deterministic (ดึงเลขจาก DB + เรนเดอร์การ์ดเอง) ไม่ต้องมี API key
    const cfg = await getReportConfig();
    if (!cfg.shiftAnalysisEnabled) return; // ปิดจากตั้งค่า
    const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const date = bkk.slice(0, 10), hm = bkk.slice(11, 16);
    const ended = shiftJustEnded(date, hm);
    if (!ended) return;
    const { workDay, shift, shiftLabel } = ended;
    const memKey = `${workDay} ${shift}`;
    if (_shiftAnalysisRunning.has(memKey)) return;
    // กันรันซ้ำข้ามการรีสตาร์ต: จอง 1 แถวต่อ (วันทำงาน+กะ) ด้วย UNIQUE — ถ้าจองไม่ได้แปลว่าทำไปแล้ว
    const existing = await dbAll('SELECT id FROM shift_analysis_log WHERE work_day = ? AND shift = ?', [workDay, shift]);
    if (existing.length) return;
    _shiftAnalysisRunning.add(memKey);
    await db.exec('INSERT INTO shift_analysis_log (work_day, shift, created_at) VALUES (?, ?, ?)', [workDay, shift, nowBKK()]);
    try {
      const analysis = await runShiftAnalysis(workDay, shift);
      if (analysis) {
        const footer = `<i>— วิเคราะห์อัตโนมัติสิ้น${escapeHtml(shiftLabel)} ${escapeHtml(workDay)}</i>`;
        if (analysis.png) await sendPhotoBufferToTelegram(analysis.png, 'image/png', analysis.caption);
        else await sendToTelegram(`${analysis.text}\n\n${footer}`); // fallback: render ไม่ได้ → ส่งข้อความ
        await db.exec('UPDATE shift_analysis_log SET summary = ? WHERE work_day = ? AND shift = ?', [analysis.text.slice(0, 4000), workDay, shift]);
        console.log(`[shift-analysis] sent ${memKey} (${analysis.png ? 'image' : 'text'})`);
      } else {
        await db.exec('UPDATE shift_analysis_log SET summary = ? WHERE work_day = ? AND shift = ?', ['(skipped — ไม่มีข้อมูล)', workDay, shift]);
        console.log(`[shift-analysis] skipped ${memKey} (no data)`);
      }
    } catch (e) {
      console.error('[shift-analysis] run error', e.message);
      // ปลดล็อกให้ลองใหม่รอบถัดไป (เฉพาะแถวที่ยังไม่มีผล)
      await db.exec('DELETE FROM shift_analysis_log WHERE work_day = ? AND shift = ? AND summary IS NULL', [workDay, shift]);
    } finally {
      _shiftAnalysisRunning.delete(memKey);
    }
  } catch (e) { console.error('[shift-analysis] tick error', e.message); }
}

// เรียกวิเคราะห์สิ้นกะเอง (ทดสอบ/รันย้อนหลัง) — ?send=1 เพื่อส่งรูปเข้า Telegram จริง
// shift = คีย์กะ (เช้า/บ่าย/ดึก) ไม่ระบุ = ใช้กะล่าสุดที่เพิ่งจบ (หรือกะดึกของวันทำงานนั้น)
app.post('/api/assistant/shift-analysis/run', async (req, res) => {
  const workDay = req.body.workDay || req.query.workDay || workDayBKK();
  let shift = req.body.shift || req.query.shift || req.body.shiftLabel || req.query.shiftLabel;
  if (!shift) { const sh = factoryShiftsForWeekday(weekdayOf(workDay)); shift = sh[sh.length - 1]?.key || 'ดึก'; }
  const send = String(req.body.send || req.query.send || '') === '1' || req.body.send === true;
  try {
    const analysis = await runShiftAnalysis(workDay, shift);
    if (send && analysis) {
      if (analysis.png) await sendPhotoBufferToTelegram(analysis.png, 'image/png', `${analysis.caption} (manual)`);
      else await sendToTelegram(`${analysis.text}\n\n<i>— วิเคราะห์ (manual) ${escapeHtml(String(shift))} ${escapeHtml(workDay)}</i>`);
    }
    res.json({ ok: true, workDay, shift, mode: analysis?.data.mode || null,
      rendered: !!analysis?.png, sent: !!(send && analysis && process.env.TELEGRAM_CHAT_ID),
      data: analysis?.data || null, text: analysis?.text || '(SKIP — ไม่มีข้อมูล)' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// พรีวิวการ์ดเป็นรูป PNG ในเบราว์เซอร์ (ไม่ส่ง Telegram) — เปิดดูหน้าตาได้เลย
// GET /api/assistant/shift-analysis/preview?workDay=YYYY-MM-DD&shift=ดึก
app.get('/api/assistant/shift-analysis/preview', async (req, res) => {
  const workDay = req.query.workDay || workDayBKK();
  let shift = req.query.shift;
  if (!shift) { const sh = factoryShiftsForWeekday(weekdayOf(workDay)); shift = sh[sh.length - 1]?.key || 'ดึก'; }
  try {
    const analysis = await runShiftAnalysis(workDay, String(shift));
    if (!analysis) return res.status(404).type('text/plain; charset=utf-8').send('SKIP — ไม่มีข้อมูลของกะนี้');
    if (!analysis.png) return res.status(200).type('text/plain; charset=utf-8').send(analysis.text.replace(/<[^>]+>/g, ''));
    res.type('image/png').send(analysis.png);
  } catch (err) { res.status(500).type('text/plain; charset=utf-8').send('error: ' + err.message); }
});

// ── ค่ามาตรฐานคุณภาพ (baseline Brix/pH ต่อรส) — ผู้ใช้ตั้งเอง ────────────────
app.get('/api/quality-specs', async (req, res) => {
  try {
    const specs = await getQualitySpecs();
    res.json({ flavors: ASSISTANT_FLAVORS.split(', '), specs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/quality-specs', async (req, res) => {
  try {
    const body = req.body || {};
    if (Array.isArray(body.items)) { // บันทึกทีละหลายรส
      const out = [];
      for (const it of body.items) out.push(await setQualitySpec(it.flavor, it));
      return res.json({ ok: true, saved: out.length, items: out });
    }
    const saved = await setQualitySpec(body.flavor, body);
    res.json({ ok: true, saved });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/quality-specs/:flavor', async (req, res) => {
  try { await db.exec('DELETE FROM quality_specs WHERE flavor = ?', [req.params.flavor]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
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
      if (ln.lotNo && String(ln.lotNo).trim()) L.push(`   ${it('(Lot no ' + String(ln.lotNo).trim() + ')')}`);
      L.push(HO_DIV);
    }
    if (p.line4) {
      L.push(`▶️ ${b('Line 4')} ${esc(p.line4.flavor || '')}`.trimEnd());
      L4_STAGES.forEach((nm, i) => L.push(`   ${nm} — ${esc(((p.line4.stages || [])[i] || '').trim() || 'ว่าง')}`));
      if (p.line4.lotNo && String(p.line4.lotNo).trim()) L.push(`   ${it('(Lot no ' + String(p.line4.lotNo).trim() + ')')}`);
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
  const payload = { shift, operator, text, lines, line4, note, date: d, kind: k }; // Lot No. อยู่รายไลน์ใน lines[]/line4
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

// รายงานพนักงานบรรจุ (แอปคำนวณ Boxes มาแล้ว) → ส่งกลุ่ม Production report + ขึ้น timeline ช่อง [รับกะ]
app.post('/api/packing-report', async (req, res) => {
  const { date, operator, shift, text } = req.body;
  if (!text) return res.status(400).json({ error: 'text จำเป็น' });
  const d = date || todayBKK();
  try {
    // บันทึกเป็น handover kind='in' → โผล่ในไทม์ไลน์เป็น 📦 รายงานบรรจุ (ช่องรับกะ)
    await db.exec('INSERT INTO handover_notes (note_date, shift, operator_name, text, data, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d, shift || null, operator || null, text, null, 'in', nowBKK()]);
    sendToTelegram(escapeHtml(text));
    res.json({ success: true });
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

// ── ความรู้ + สืบค้น DB โดยตรง (แนวทาง "สมองรวม") ─────────────────────────
// สรุป schema เป็นบรรทัดสั้นๆ "table(col1, col2, …)" จาก DDL จริง → ใส่ system prompt
const SCHEMA_SUMMARY = SCHEMA.map((ddl) => {
  const m = ddl.match(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)/);
  if (!m) return null;
  const cols = m[2].split(',')
    .map(c => c.trim().split(/\s+/)[0])
    .filter(c => c && !/^(UNIQUE|FOREIGN|PRIMARY)/i.test(c) && !c.includes(')'));
  return `${m[1]}(${cols.join(', ')})`;
}).filter(Boolean).join('\n');

// ค้นคู่มือในโฟลเดอร์ knowledge/ — แบ่งไฟล์เป็นหัวข้อ (## …) แล้วให้คะแนนตามคำค้น
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
function searchKnowledge(query) {
  let files = [];
  try { files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md')); } catch { return []; }
  const terms = String(query || '').split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2);
  const sections = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8');
    const parts = text.split(/\n(?=## )/);
    for (const p of parts) {
      const title = (p.match(/^#+ (.+)/) || [])[1] || f;
      let score = 0;
      for (const t of terms) {
        const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        score += (p.match(re) || []).length * (title.includes(t) ? 3 : 1);
      }
      if (score > 0) sections.push({ doc: f, title, score, text: p.trim().slice(0, 1500) });
    }
  }
  sections.sort((a, b) => b.score - a.score);
  return sections.slice(0, 5).map(({ doc, title, text }) => ({ doc, title, text }));
}

// SQL อ่านอย่างเดียว: อนุญาตเฉพาะ SELECT เดี่ยว ไม่มีคำสั่งเขียน/DDL และบังคับ LIMIT
function runReadonlySql(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^select\s/i.test(s)) throw new Error('อนุญาตเฉพาะคำสั่ง SELECT เท่านั้น');
  if (s.includes(';')) throw new Error('ห้ามมีหลายคำสั่งใน query เดียว');
  if (/\b(insert|update|delete|drop|alter|create|replace|truncate|attach|pragma|grant|vacuum)\b/i.test(s))
    throw new Error('พบคำสั่งที่ไม่ใช่การอ่าน — อนุญาตเฉพาะ SELECT');
  const limited = /\blimit\s+\d+/i.test(s) ? s : `${s} LIMIT 100`;
  return dbAll(limited, []).then(rows => rows.slice(0, 200));
}

// ── เฟส 2: ความจำถาวร (assistant_memory) ────────────────────────────────────
// จำสิ่งที่ผู้ใช้บอกให้จำข้ามหลาย session (ค่ามาตรฐาน, ชื่อเล่น, ความชอบ, บริบท)
// scope 'global' เห็นร่วมกันทุกคน · scope=ชื่อ operator เห็นเฉพาะคนนั้น
async function rememberFact(scope, key, value) {
  const k = String(key || '').trim().slice(0, 120);
  const v = String(value || '').trim().slice(0, 1000);
  if (!k || !v) throw new Error('ต้องมีทั้งหัวข้อ (key) และเนื้อหา (value)');
  await db.exec(`INSERT INTO assistant_memory (scope, key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [scope || 'global', k, v, nowBKK(), nowBKK()]);
  return { ok: true, remembered: `${k}: ${v}`, scope: scope || 'global' };
}
async function recallFacts(operator, query) {
  const scopes = ['global']; if (operator) scopes.push(operator);
  const ph = scopes.map(() => '?').join(', ');
  let rows = await dbAll(`SELECT scope, key, value, updated_at FROM assistant_memory WHERE scope IN (${ph}) ORDER BY updated_at DESC LIMIT 200`, scopes);
  const q = String(query || '').trim();
  if (q) {
    const terms = q.split(/\s+/).filter(t => t.length >= 2).map(t => t.toLowerCase());
    if (terms.length) rows = rows.filter(r => terms.some(t => (`${r.key} ${r.value}`).toLowerCase().includes(t)));
  }
  return rows.slice(0, 50);
}
async function forgetFact(operator, key) {
  const scopes = ['global']; if (operator) scopes.push(operator);
  const ph = scopes.map(() => '?').join(', ');
  const r = await db.exec(`DELETE FROM assistant_memory WHERE key = ? AND scope IN (${ph})`, [String(key || ''), ...scopes]);
  return { ok: true, removed: (r && r.rowCount) || 0 };
}
// สรุปความจำเป็นข้อความสั้นๆ ใส่ system prompt (โหลดทุกครั้งที่คุย — เปลี่ยนไม่บ่อย cache แทบไม่รีเซ็ต)
async function memoryPromptBlock(operator) {
  const rows = await recallFacts(operator, '');
  if (!rows.length) return '';
  const lines = rows.slice(0, 40).map(r => `• ${r.key}: ${r.value}${r.scope !== 'global' ? ` (เฉพาะ ${r.scope})` : ''}`);
  return ['ความจำถาวร (สิ่งที่เคยถูกสั่งให้จำ — ใช้ประกอบการตอบ ไม่ต้องเรียก recall ซ้ำถ้ามีอยู่แล้วด้านล่าง):', ...lines].join('\n');
}

// ── การเขียนข้อมูลผ่านผู้ช่วย (แนวทาง "มือทำงาน") — ต้องยืนยันก่อนเสมอ ─────
// tool เขียนจะไม่แตะ DB ทันที แต่สร้างแถว pending ใน assistant_actions
// → client แสดงการ์ดให้กด ✅/❌ → POST /api/assistant/confirm ค่อยเขียนจริง
const ASSISTANT_WRITE_TOOLS = new Set(['record_production', 'record_cip_round', 'save_handover_note', 'update_production_plan']);

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes }); });
});

function summarizeAction(tool, input) {
  if (tool === 'record_production')
    return [`🏭 บันทึกผลิต: ${input.line || '-'} | ${input.flavor || '-'} | Batch ${input.batch || '-'}`,
      input.brix != null ? `Brix ${input.brix}` : null, input.ph != null ? `pH ${input.ph}` : null,
      input.lot_no ? `Lot ${input.lot_no}` : null, input.date ? `วันที่ ${input.date}` : null,
    ].filter(Boolean).join(' · ');
  if (tool === 'record_cip_round')
    return `💧 บันทึกรอบ CIP: ${input.line || '-'}${input.backwash ? ' + Backwash' : ''}${input.date ? ` · วันที่ ${input.date}` : ''}${input.remark ? ` · ${input.remark}` : ''}`;
  if (tool === 'save_handover_note')
    return `📝 โน้ตส่งเวร (${input.shift || '-'}): ${String(input.text || '').slice(0, 120)}`;
  if (tool === 'update_production_plan')
    return `📋 แผนผลิต ${input.date || 'วันนี้'}: ` + (input.items || []).map(it => `${it.line || 'รวม'} ${it.flavor} ${it.planned_batches} batch`).join(', ');
  return `${tool}`;
}

// เขียนจริงหลังผู้ใช้กดยืนยัน — เลียนแบบ endpoint ปกติของแอป (Telegram/n8n ครบ)
async function executeAssistantAction(tool, input, operator) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const op = input.operator || operator || 'ผู้ช่วย AI';
  if (tool === 'record_production') {
    const ts = input.date ? `${input.date}T${input.time || nowBKK().slice(11, 19)}` : nowBKK();
    await dbRun(`INSERT INTO production_logs (timestamp, line_name, flavor, batch, operator_name, cip_count, brix, ph) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ts, input.line, input.flavor, input.batch || '-', op, input.cip_count || '-',
       input.brix == null ? null : Number(input.brix), input.ph == null ? null : Number(input.ph)]);
    await syncTaskProgress(ts.slice(0, 10));
    sendToTelegram([
      `🏭 <b>บันทึกการผลิต</b> (ผ่านผู้ช่วย AI)`,
      `📍 Line: ${escapeHtml(input.line || '-')} | รสชาติ: ${escapeHtml(input.flavor || '-')}`,
      `📦 Batch: ${escapeHtml(input.batch || '-')}`,
      input.lot_no ? `🏷️ Lot No.: <b>${escapeHtml(input.lot_no)}</b>` : null,
      `👤 ผู้ดำเนินการ: ${escapeHtml(op)}`,
      input.brix != null ? `🍬 Brix: ${escapeHtml(String(input.brix))}` : null,
      input.ph != null ? `🧪 pH: ${escapeHtml(String(input.ph))}` : null,
    ].filter(Boolean).join('\n'));
    sendToN8n({ type: 'production', timestamp: ts, line: input.line || '', flavor: input.flavor || '',
      batch: input.batch || '', lotNo: input.lot_no || '', operator: op, startTime: '', endTime: '',
      duration: '', brix: input.brix ?? '', ph: input.ph ?? '', cipCount: input.cip_count || '' });
    return `บันทึกผลิต ${input.flavor} Batch ${input.batch || '-'} (${input.line}) เรียบร้อย`;
  }
  if (tool === 'record_cip_round') {
    const date = input.date || today;
    const isL1 = input.line === 'Line 1';
    const sessTable = isL1 ? 'cip_line1_sessions' : 'cip_line2_sessions';
    const rowTable = isL1 ? 'cip_line1_rows' : 'cip_line2_rows';
    // ใช้ session ที่ผู้ช่วยสร้างของวัน/ไลน์เดิมถ้ามี ไม่งั้นเปิดใหม่ (sku='ASSISTANT' เป็นตัวบ่งชี้)
    const cond = isL1 ? 'date = ? AND sku = ?' : "date = ? AND sku = ? AND COALESCE(line, 'Line 2') = ?";
    const args = isL1 ? [date, 'ASSISTANT'] : [date, 'ASSISTANT', input.line || 'Line 2'];
    const found = await dbAll(`SELECT id FROM ${sessTable} WHERE ${cond} ORDER BY id DESC LIMIT 1`, args);
    let sessionId = found[0] && found[0].id;
    if (!sessionId) {
      const ins = isL1
        ? await dbRun(`INSERT INTO cip_line1_sessions (operator_name, date, sku, created_at, status) VALUES (?, ?, 'ASSISTANT', ?, 'done')`, [op, date, nowBKK()])
        : await dbRun(`INSERT INTO cip_line2_sessions (operator_name, date, sku, line, flavor, created_at, status) VALUES (?, ?, 'ASSISTANT', ?, ?, ?, 'done')`, [op, date, input.line || 'Line 2', input.flavor || '', nowBKK()]);
      sessionId = ins.lastID;
    }
    const rows = await dbAll(`SELECT MAX(row_no) AS n FROM ${rowTable} WHERE session_id = ?`, [sessionId]);
    const rowNo = (Number(rows[0] && rows[0].n) || 0) + 1;
    const endTime = input.date ? `${input.date}T${input.time || '12:00:00'}` : nowBKK();
    const data = JSON.stringify({ endTime, backwash: !!input.backwash, remark: input.remark || '', via: 'assistant' });
    await dbRun(`INSERT INTO ${rowTable} (session_id, row_no, data) VALUES (?, ?, ?)`, [sessionId, rowNo, data]);
    sendToTelegram(`💧 <b>บันทึกรอบ CIP</b> (ผ่านผู้ช่วย AI)\n📍 ${escapeHtml(input.line || '-')} รอบที่ ${rowNo}${input.backwash ? ' + Backwash' : ''}\n👤 ${escapeHtml(op)}${input.remark ? `\n📝 ${escapeHtml(input.remark)}` : ''}`);
    return `บันทึกรอบ CIP ${input.line} (รอบที่ ${rowNo} ของ session ผู้ช่วย) เรียบร้อย`;
  }
  if (tool === 'save_handover_note') {
    const date = input.date || today;
    await dbRun('INSERT INTO handover_notes (note_date, shift, operator_name, text, data, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [date, input.shift || null, op, String(input.text || ''), null, 'out', nowBKK()]);
    sendToTelegram(`📝 <b>โน้ตส่งเวร</b> (ผ่านผู้ช่วย AI)\n🗓 ${escapeHtml(date)} กะ${escapeHtml(input.shift || '-')} — ${escapeHtml(op)}\n${escapeHtml(String(input.text || ''))}`);
    return 'บันทึกโน้ตส่งเวรเรียบร้อย';
  }
  if (tool === 'update_production_plan') {
    const date = input.date || today;
    const items = input.items || [];
    const createdAt = nowBKK();
    for (const it of items) {
      await db.exec(`INSERT INTO production_plans (plan_date, line_name, flavor, planned_batches, operator_name, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_date, line_name, flavor)
        DO UPDATE SET planned_batches=excluded.planned_batches, operator_name=excluded.operator_name, note=excluded.note, created_at=excluded.created_at`,
        [date, it.line || '', it.flavor || '', Number(it.planned_batches) || 0, op, it.note || '', createdAt]);
    }
    await generateTasksForDate(date, op);
    await syncTaskProgress(date);
    const total = items.reduce((s, it) => s + (Number(it.planned_batches) || 0), 0);
    sendToTelegram([`📋 <b>บันทึกแผนผลิต</b> (ผ่านผู้ช่วย AI)`, `🗓 ${escapeHtml(date)} — ${escapeHtml(op)}`,
      ...items.map(it => `• ${escapeHtml(it.line || 'รวม')} | ${escapeHtml(it.flavor || '-')}: <b>${Number(it.planned_batches) || 0}</b> batch`),
      `รวมแผน: <b>${total}</b> batch`].join('\n'));
    sendToN8n({ type: 'production_plan', planDate: date, operator: op, createdAt,
      items: items.map(it => ({ line: it.line || '', flavor: it.flavor || '', plannedBatches: String(Number(it.planned_batches) || 0), note: it.note || '' })) });
    return `บันทึกแผนผลิต ${items.length} รายการ (รวม ${total} batch) เรียบร้อย`;
  }
  throw new Error(`ไม่รู้จัก action: ${tool}`);
}

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
  // ── สมองรวม: ค้นคู่มือ + สืบค้น DB ทุกตาราง ──────────────────────────────
  { name: 'search_knowledge', description: 'ค้นคู่มือ/ความรู้ของแอป (ภาพรวมระบบ, ตารางกะ, ขั้นตอนงาน, โครงสร้างข้อมูล) — ใช้เมื่อถูกถามเรื่องวิธีใช้แอป กะทำงาน ขั้นตอน หรือสิ่งที่ไม่ใช่ตัวเลขใน DB ห้ามเดาถ้ายังไม่ค้น',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'คำค้นแยกเป็นคำสั้นๆ คั่นช่องว่าง เช่น "กะ ศุกร์", "ส่งเวร", "Line 4 บรรจุ"' } }, required: ['query'] } },
  { name: 'query_database', description: 'รันคำสั่ง SELECT อ่านข้อมูลจากตารางใดก็ได้ในระบบ — ใช้เมื่อคำถามเกินขอบเขต tool สรุปสำเร็จรูป (schema อยู่ใน system prompt) อ่านอย่างเดียว ระบบบังคับ LIMIT ให้',
    input_schema: { type: 'object', properties: {
      sql: { type: 'string', description: 'คำสั่ง SELECT เดี่ยว (SQLite/Postgres compatible)' },
      purpose: { type: 'string', description: 'อธิบายสั้นๆ ว่าดึงไปตอบอะไร' } }, required: ['sql'] } },
  // ── เฟส 2: ความจำถาวร ─────────────────────────────────────────────────────
  { name: 'remember', description: 'จำข้อมูลถาวรข้ามการสนทนา เมื่อผู้ใช้บอกให้จำ/ตั้งค่ามาตรฐาน/ชื่อเล่น/ความชอบ/บริบทงานที่ควรรู้ในอนาคต (เช่น "จำไว้ว่า Brix มาตรฐาน Amazon คือ 12", "เรียกฉันว่าพี่หนึ่ง") — เขียนทันทีไม่ต้องยืนยัน',
    input_schema: { type: 'object', properties: {
      key: { type: 'string', description: 'หัวข้อสั้นๆ ของสิ่งที่จำ เช่น "Brix มาตรฐาน Amazon", "ชื่อเล่นผู้ใช้"' },
      value: { type: 'string', description: 'เนื้อหาที่จะจำ' },
      personal: { type: 'boolean', description: 'true = จำเฉพาะผู้ใช้คนนี้ (ไม่ระบุ/false = จำรวมทุกคน)' } }, required: ['key', 'value'] } },
  { name: 'recall', description: 'ค้นความจำถาวรที่เคยบันทึกไว้ — ใช้เมื่อจะตอบเรื่องค่ามาตรฐาน/ความชอบ/บริบทที่ผู้ใช้เคยสั่งให้จำ (ความจำที่มีอยู่ถูกใส่ใน system prompt ให้แล้ว เรียก tool นี้เมื่ออยากค้นเจาะจงหรือยืนยัน)',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'คำค้น (เว้นว่าง = ดึงทั้งหมด)' } } } },
  { name: 'forget', description: 'ลบความจำถาวรตามหัวข้อ (key) เมื่อผู้ใช้บอกให้ลืม/ยกเลิกสิ่งที่เคยจำ',
    input_schema: { type: 'object', properties: {
      key: { type: 'string', description: 'หัวข้อ (key) ที่จะลบ ตรงกับที่บันทึกไว้' } }, required: ['key'] } },
  // ── มือทำงาน: เขียนข้อมูลจริง (สร้างรายการรอยืนยัน — ไม่เขียนทันที) ─────
  { name: 'record_production', description: 'บันทึกการผลิต 1 batch ลง production_logs (เหมือนกด Done ที่หน้าผลิต) — ระบบจะขึ้นการ์ดให้ผู้ใช้กดยืนยันก่อน ยังไม่บันทึกทันที',
    input_schema: { type: 'object', properties: {
      line: { type: 'string', description: '"Line 1"–"Line 4"' },
      flavor: { type: 'string' }, batch: { type: 'string', description: 'A-Z หรือ No.1-20 สำหรับ Dilute' },
      brix: { type: 'number' }, ph: { type: 'number' }, cip_count: { type: 'string' },
      lot_no: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD (ไม่ระบุ = ตอนนี้)' },
      time: { type: 'string', description: 'HH:MM:SS' } }, required: ['line', 'flavor'] } },
  { name: 'record_cip_round', description: 'บันทึกรอบ CIP/Backwash ที่ทำเสร็จแล้ว (เหมาะกับบันทึกย้อนหลัง/ตกหล่น) — ต้องให้ผู้ใช้กดยืนยันก่อน',
    input_schema: { type: 'object', properties: {
      line: { type: 'string', description: '"Line 1", "Line 2", "Line 3"' },
      backwash: { type: 'boolean', description: 'รอบนี้มี Backwash ด้วยไหม (Line 2/3)' },
      flavor: { type: 'string' }, remark: { type: 'string' },
      date: { type: 'string' }, time: { type: 'string' } }, required: ['line'] } },
  { name: 'save_handover_note', description: 'บันทึกโน้ตส่งเวร (ข้อความอิสระ) + แจ้ง Telegram — ต้องให้ผู้ใช้กดยืนยันก่อน',
    input_schema: { type: 'object', properties: {
      text: { type: 'string' }, shift: { type: 'string', description: 'เช้า/บ่าย/ดึก' },
      date: { type: 'string' } }, required: ['text'] } },
  { name: 'update_production_plan', description: 'บันทึก/แก้แผนผลิตของวัน (สร้าง To-do อัตโนมัติด้วย) — ต้องให้ผู้ใช้กดยืนยันก่อน',
    input_schema: { type: 'object', properties: {
      date: { type: 'string' },
      items: { type: 'array', items: { type: 'object', properties: {
        line: { type: 'string' }, flavor: { type: 'string' },
        planned_batches: { type: 'integer' }, note: { type: 'string' } },
        required: ['flavor', 'planned_batches'] } } }, required: ['items'] } },
  // ยืนยัน/ยกเลิกด้วยการพิมพ์ (สำหรับ Telegram ที่ไม่มีปุ่ม) — เว็บใช้ปุ่มการ์ดแทน
  { name: 'confirm_pending_action', description: 'ยืนยันรายการบันทึกที่ค้างอยู่ → เขียนข้อมูลจริง เรียกได้เฉพาะเมื่อผู้ใช้พิมพ์ยืนยันชัดเจนเท่านั้น (เช่น "ยืนยัน", "ตกลง", "ใช่ บันทึกเลย")',
    input_schema: { type: 'object', properties: {
      action_id: { type: 'integer', description: 'ไม่ระบุ = รายการล่าสุดที่รออยู่ของ session นี้' } } } },
  { name: 'cancel_pending_action', description: 'ยกเลิกรายการบันทึกที่ค้างอยู่ เมื่อผู้ใช้บอกไม่เอา/ยกเลิก/ข้อมูลผิด',
    input_schema: { type: 'object', properties: { action_id: { type: 'integer' } } } },
  // ── ค่ามาตรฐานคุณภาพ (baseline Brix/pH ต่อรส) — ใช้ให้การเตือนสิ้นกะแม่น ไม่ false alarm ──
  { name: 'set_quality_spec', description: 'ตั้ง/แก้ค่ามาตรฐาน (สเปก) Brix และ/หรือ pH ของรสชาติ เพื่อให้ระบบเตือนเฉพาะค่าที่ออกนอกสเปกจริง เมื่อผู้ใช้บอกสเปก เช่น "สเปก Freshy Orange pH 3.2-4.0", "Amazon Brix 50-55" — เขียนทันทีไม่ต้องยืนยัน · หลายรสให้เรียกทีละรส · ไม่ระบุค่าไหน = ไม่เปลี่ยนค่านั้น',
    input_schema: { type: 'object', properties: {
      flavor: { type: 'string', description: 'ชื่อรสชาติ (ตรงกับลิสต์)' },
      brix_min: { type: 'number' }, brix_max: { type: 'number' },
      ph_min: { type: 'number' }, ph_max: { type: 'number' } }, required: ['flavor'] } },
  { name: 'get_quality_specs', description: 'ดูค่ามาตรฐาน (สเปก) Brix/pH ที่ตั้งไว้ต่อรสชาติ — ใช้เมื่อผู้ใช้ถามว่าตั้งสเปกอะไรไว้บ้าง หรือก่อนแก้',
    input_schema: { type: 'object', properties: { flavor: { type: 'string', description: 'เจาะจงรส (ไม่ระบุ = ทั้งหมด)' } } } },
];

async function runAssistantTool(name, input, operator, ctx = {}) {
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const date = input.date || today();
  // ── tool เขียนข้อมูล → สร้างรายการรอยืนยัน (ไม่เขียน DB ทันที) ──────────
  if (ASSISTANT_WRITE_TOOLS.has(name)) {
    const summary = summarizeAction(name, input);
    const ins = await dbRun('INSERT INTO assistant_actions (session, operator_name, tool, input, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ctx.session || null, operator || null, name, JSON.stringify(input), summary, 'pending', nowBKK()]);
    const action = { id: ins.lastID, tool: name, summary };
    if (ctx.pending) ctx.pending.push(action);
    return { pending: true, action_id: action.id, summary,
      note: 'สร้างรายการรอยืนยันแล้ว — ยังไม่บันทึกจริง บอกผู้ใช้ให้กดปุ่ม ✅ ยืนยันบนการ์ด (หรือพิมพ์ "ยืนยัน") ห้ามบอกว่าบันทึกแล้ว' };
  }
  if (name === 'confirm_pending_action' || name === 'cancel_pending_action') {
    const approve = name === 'confirm_pending_action';
    const rows = input.action_id
      ? await dbAll("SELECT * FROM assistant_actions WHERE id = ? AND status = 'pending'", [input.action_id])
      : await dbAll("SELECT * FROM assistant_actions WHERE session = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [ctx.session || '']);
    const act = rows[0];
    if (!act) return { error: 'ไม่พบรายการที่รอยืนยัน' };
    if (!approve) {
      await db.exec("UPDATE assistant_actions SET status = 'rejected', decided_at = ? WHERE id = ?", [nowBKK(), act.id]);
      if (ctx.resolved) ctx.resolved.push(act.id);
      return { ok: true, cancelled: act.summary };
    }
    try {
      const msg = await executeAssistantAction(act.tool, JSON.parse(act.input || '{}'), operator || act.operator_name);
      await db.exec("UPDATE assistant_actions SET status = 'approved', result = ?, decided_at = ? WHERE id = ?", [msg, nowBKK(), act.id]);
      if (ctx.resolved) ctx.resolved.push(act.id);
      return { ok: true, executed: msg };
    } catch (e) {
      await db.exec("UPDATE assistant_actions SET status = 'error', result = ?, decided_at = ? WHERE id = ?", [e.message, nowBKK(), act.id]);
      if (ctx.resolved) ctx.resolved.push(act.id);
      return { error: `บันทึกไม่สำเร็จ: ${e.message}` };
    }
  }
  if (name === 'search_knowledge') {
    const results = searchKnowledge(input.query);
    return results.length ? { results } : { results: [], note: 'ไม่พบด้วยคำค้นนี้ — ลองค้นใหม่ด้วยคำที่สั้นลงหรือคำอื่น 1-2 ครั้ง (เช่นชื่อคน/คำหลักคำเดียว) ถ้ายังไม่เจอและเป็นข้อมูลตัวเลขลอง query_database ไม่งั้นตอบตรงๆ ว่าไม่พบข้อมูล' };
  }
  if (name === 'query_database') {
    const rows = await runReadonlySql(input.sql);
    return { rowCount: rows.length, rows };
  }
  if (name === 'remember') return await rememberFact(input.personal ? (operator || 'global') : 'global', input.key, input.value);
  if (name === 'recall') { const results = await recallFacts(operator, input.query); return { count: results.length, results }; }
  if (name === 'forget') return await forgetFact(operator, input.key);
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
    const specs = await getQualitySpecs(); // แนบสเปกไปด้วย → เทียบได้ว่าค่าไหนออกนอกสเปกจริง
    return { from, to, count: rows.length, rows, specs, note: 'เตือน "ผิดปกติ" เฉพาะรสที่มีสเปกใน specs และค่าออกนอกช่วงเท่านั้น รสที่ไม่มีสเปกอย่าเดาว่าปกติ/ผิด' };
  }
  if (name === 'set_quality_spec') {
    const saved = await setQualitySpec(input.flavor, input);
    return { ok: true, saved, note: 'บันทึกสเปกแล้ว (มีผลกับการเตือนสิ้นกะทันที)' };
  }
  if (name === 'get_quality_specs') {
    const specs = await getQualitySpecs();
    if (input.flavor) return { flavor: input.flavor, spec: specs[input.flavor] || null };
    return { count: Object.keys(specs).length, specs };
  }
  return { error: 'unknown tool' };
}

const ASSISTANT_FLAVORS = 'Amazon, FDS, Golden, Freshy Lychee, Freshy Strawberry, Senorita Coconut, Senorita Caramel, Freshy Blue Hawaii, Freshy Lime, Freshy Green Apple, Freshy Sala, Senorita Yuzu, Senorita Peach, MLH 02, Freshy Pineapple, Freshy Grape, Freshy Punch, Freshy blue Lemon, Senorita Fres Mint, Freshy Orange, Signature Rose, Freshy Shine Muscat Grape, Freshy Peach, Freshy Mango, Dilute W-Molass';

// สร้าง system prompt ของผู้ช่วย — async เพราะดึงความจำถาวร (เฟส 2) มาแปะด้วย
async function buildAssistantSystem(operator) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const memBlock = await memoryPromptBlock(operator); // เฟส 2
  return [
    'คุณเป็นผู้ช่วยอัจฉริยะสำหรับบันทึกและวิเคราะห์ข้อมูลการผลิตน้ำเชื่อม/น้ำหวานของโรงงาน คุยแบบเป็นกันเองแต่มืออาชีพ',
    `วันนี้คือ ${today} (เขตเวลา Asia/Bangkok)`,
    'สายการผลิต/CIP: Line 1 (Syrup), Line 2 และ Line 3 (Flavour), Line 4 (Mixing/Pasteurizer)',
    `รสชาติที่มี: ${ASSISTANT_FLAVORS}`,
    'ถ้าผู้ใช้พิมพ์ชื่อรสผิด/สะกดเพี้ยน/เป็นภาษาไทย ให้จับคู่กับรสที่ใกล้เคียงที่สุดในลิสต์เอง (เช่น "อเมซอน"→Amazon, "ลิ้นจี่"→Freshy Lychee) ไม่แน่ใจค่อยถามยืนยัน',
    'หมายเหตุ: Dilute W-Molass บันทึกเป็นรอบ No.1–20 (รสอื่นเป็น Batch A-Z)',
    '',
    'ความสามารถ:',
    '• บันทึกงาน: create_task (category ผลิต=production, ทำความสะอาด=cip, backwash=backwash, ซ่อมบำรุง=maintenance) · ปิดงาน: complete_task',
    '• ข้อมูลวันเดียว: get_production_summary / get_cip_summary / get_timeline / list_tasks',
    '• ข้ามวัน/ช่วงเวลา/แนวโน้ม: query_production_range (from,to) เช่น "สัปดาห์นี้", "3 วันก่อน", "เดือนนี้"',
    '• คุณภาพ: get_quality (Brix/pH — แนบสเปกมาด้วย) เตือน "ผิดปกติ" เฉพาะรสที่มีสเปกและค่าออกนอกช่วง · ตั้งสเปกด้วย set_quality_spec (เช่นผู้ใช้บอก "สเปกส้ม pH 3.2-4") · ดูสเปกที่ตั้งไว้ด้วย get_quality_specs',
    '• ความรู้เรื่องแอป/กะ/ขั้นตอน/ทีม: search_knowledge — ถูกถามเรื่องวิธีใช้/ระบบ/กะทำงาน/บุคคล ให้ค้นก่อนตอบเสมอ ถ้าครั้งแรกไม่เจอ ให้เปลี่ยนคำค้น (สั้นลง/คำพ้อง/ชื่อที่ถูกถาม) ลองอีก 1-2 ครั้งก่อนจะสรุปว่าไม่พบ',
    '• คำถามข้อมูลที่ tool สรุปไม่ครอบคลุม: query_database (SELECT อย่างเดียว) — schema ทั้งหมด:',
    SCHEMA_SUMMARY,
    '• ความจำถาวร: remember (สั่งให้จำ) · recall (ค้นสิ่งที่จำ) · forget (ลบ) — จำค่ามาตรฐาน/ชื่อเล่น/ความชอบ/บริบทข้ามการสนทนา',
    '',
    'การบันทึกข้อมูลจริง (สำคัญมาก):',
    '• บันทึกผลิต=record_production · รอบ CIP/Backwash=record_cip_round · โน้ตส่งเวร=save_handover_note · แผนผลิต=update_production_plan',
    '• tool เหล่านี้สร้าง "รายการรอยืนยัน" — ระบบขึ้นการ์ดให้ผู้ใช้กด ✅ เอง ห้ามพูดว่า "บันทึกแล้ว" จนกว่าจะยืนยัน ให้สรุปข้อมูลที่จะบันทึกและบอกให้กดยืนยัน',
    '• ก่อนเรียก tool เขียน ต้องมีข้อมูลครบพอ (Line, รสชาติ ฯลฯ) ถ้าคลุมเครือให้ถามก่อน',
    '• confirm_pending_action เรียกได้เฉพาะเมื่อผู้ใช้พิมพ์ยืนยันเองชัดเจน ("ยืนยัน"/"ตกลง"/"บันทึกเลย") ห้ามเรียกเอง · ผู้ใช้ปฏิเสธ→cancel_pending_action',
    '',
    'คำสั่งหลายขั้นตอน (ทำงานเป็นชุดได้ในทีเดียว — เรียกหลาย tool ต่อเนื่องจนจบงาน):',
    '• "ปิดกะ/สรุปปิดกะ" = ดึง get_production_summary + get_cip_summary + list_tasks (งานค้าง) ของวันทำงานนั้น → สรุปให้ครบ → ถ้าผู้ใช้อยากบันทึกโน้ตส่งเวรค่อยเสนอ save_handover_note (รอยืนยัน)',
    '• "เตรียมประชุมเช้า/บรีฟเช้า" = get_production_summary (เทียบแผน) + get_quality (ค่าผิดปกติ) + list_tasks (งานค้าง) → สรุปประเด็นสั้นๆ พร้อมจุดที่ต้องระวัง',
    '• "เช็ก/ตรวจของวันนี้" = get_production_summary + get_cip_summary + get_quality → รายงานพร้อมทักถ้าผิดปกติ',
    '• เมื่อผู้ใช้กดยืนยัน (มีข้อความ [ระบบ] แจ้งผล) ให้ทำขั้นตอนถัดไปที่ค้างอยู่ต่อทันที ถ้าไม่มีก็ตอบรับสั้นๆ',
    '',
    'ทีมของผู้ใช้ ("กะจักรกฤษ") — ใช้ตีความคำว่า "กะผม/ทีมผม/ของเรา":',
    '• หัวหน้ากะ: จักรกฤษ · สมาชิก: ม้ำ (ผู้ช่วยหลัก คุมผลิต&CIP), นาย (ส่วนผสม & ผู้ช่วยม้ำ), พลุ๊ก (ส่วนผสม & เครื่องบรรจุ)',
    '• วันหยุดของทีมนี้ = วันเสาร์ (โรงงานยังเดินโดยมีอีก 2 กะหมุนมาแทน) → ถ้าถามยอด "กะผม" วันเสาร์ = ทีมนี้หยุด',
    '• ตารางกะโรงงาน: จ-พฤ 3 กะ (เช้า06-14/บ่าย14-22/ดึก22-06) · ศ,ส,อา 2 กะ (เช้า06-18/ดึก18-06)',
    '',
    'อ่านรูปแผนผลิต (เมื่อผู้ใช้แนบรูป):',
    '• ถ้าแนบรูปตารางแผนผลิตรายสัปดาห์แล้วถาม "วันนี้/กะผมผลิตอะไร": หาคอลัมน์ของวันนี้จากหัวตาราง (รูปแบบวันที่เช่น 10-7-69 = 10 ก.ค. 2026), อ่าน SKU/รสชาติ + จำนวนผลิตแยกตามช่องกะ (Worker เช้า/บ่าย/ดึก) + จำนวนคนบรรจุต่อ Line',
    '• แผนอาจเปลี่ยนได้ตลอด — สรุปตามรูปที่เห็น ระบุว่าอ้างอิงจากรูป · เลขที่อ่านไม่ชัดให้บอกตรงๆ ว่าอ่านไม่ชัด อย่าเดา · ถ้ารูปกว้าง/แน่นมากแนะนำให้ครอปเฉพาะส่วนที่ถามมา',
    '• CIP ในช่องแผน = ไลน์นั้นล้างระบบรอบนั้น (ไม่ใช่ยอดผลิต)',
    '',
    'วิธีตอบ:',
    '• เรียก tool ดึงข้อมูลจริงก่อนตอบเสมอ ห้ามเดา/มโนตัวเลข — ไม่แน่ใจให้ค้น search_knowledge หรือ query_database ก่อน ถ้ายังไม่พบให้ตอบตรงๆ ว่าไม่พบข้อมูล อย่าแต่งเรื่อง',
    '• เชิงรุก: ถ้าผลิตไม่ทันแผน (จริงน้อยกว่าแผนมาก) / ค่า Brix,pH ผิดปกติ / เห็นแนวโน้มน่าสนใจ ให้ทักเตือนผู้ใช้ด้วย',
    '• ตอบภาษาไทย กระชับ อ่านง่าย เน้นตัวเลขสำคัญ ใส่ emoji พอประมาณ',
    '• ห้ามใช้ Markdown (** ## ฯลฯ) — หน้าแชทแสดงข้อความธรรมดา ใช้ • ขึ้นบรรทัดใหม่ และ emoji จัดรูปแบบแทน',
    '• ใช้บริบทจากบทสนทนาก่อนหน้าเมื่อเป็นคำถามต่อเนื่อง',
    memBlock ? '\n' + memBlock : '',
  ].join('\n');
}

// เลเยอร์คุยกับ Claude ที่ใช้ร่วมกัน — หน้าเว็บ (/api/assistant), ต่อหลังกดยืนยัน (เฟส 3), วิเคราะห์สิ้นกะ (เฟส 1)
// opts: { userMessage, image | images, operator, session, persist=true, maxTurns=12, systemExtra }
// image = { data: base64 ไม่รวม prefix, media_type } หรือ images = [ ... ] (หลายรูป/หลายส่วนของตารางเดียว)
// → แนบเป็น image block เทิร์นแรก (vision อ่านรูปแผน) · รูปส่งเฉพาะเทิร์นนี้ ไม่เก็บลง history
async function runAssistantConversation(opts) {
  const { userMessage, image = null, images = null, operator = null, session = null, persist = true, maxTurns = 12, systemExtra = '' } = opts;
  const client = getAnthropic();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์');
  let system = await buildAssistantSystem(operator);
  if (systemExtra) system += '\n\n' + systemExtra;

  const actions = [];
  const ctx = { session, pending: [], resolved: [] }; // pending = การ์ดยืนยันที่เกิดใหม่รอบนี้
  // โหลดบทสนทนาก่อนหน้าของ session นี้ (multi-turn memory) — เก็บเฉพาะข้อความเป็น text
  let history = [];
  if (session) {
    const rows = await dbAll('SELECT role, content FROM assistant_messages WHERE session = ? ORDER BY id DESC LIMIT 12', [session]);
    history = rows.reverse().filter(r => r.content && String(r.content).trim());
    while (history.length && history[0].role !== 'user') history.shift(); // ต้องเริ่มด้วย user
  }
  // เทิร์นแรก: รวมรูปทั้งหมด (image เดี่ยว หรือ images อาเรย์) เป็น image block + text
  const imgList = (images && images.length) ? images : (image && image.data ? [image] : []);
  const imgBlocks = imgList.filter(im => im && im.data)
    .map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data } }));
  const nImg = imgBlocks.length;
  // หลายรูป = มักเป็นส่วนย่อยของตารางเดียวกันที่ครอปแยกเพื่อความชัด → บอก Claude ให้ประกอบกัน
  const tileNote = nImg > 1 ? '\n\n(รูปที่แนบมา ' + nImg + ' รูป — อาจเป็นส่วนย่อยของตารางเดียวกันที่แยกเพื่อความชัด เรียงซ้าย→ขวา คอลัมน์ชื่อ/รหัสสินค้าซ้ายสุดถูกใส่ซ้ำในทุกส่วนให้เทียบแถวได้ ให้ประกอบกันเมื่ออ่าน)' : '';
  const firstContent = nImg
    ? [...imgBlocks, { type: 'text', text: String(userMessage || 'ช่วยดูรูปนี้ให้หน่อย') + tileNote }]
    : String(userMessage);
  const messages = [...history.map(r => ({ role: r.role, content: r.content })), { role: 'user', content: firstContent }];
  let reply = '';
  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await client.messages.create({
      model: 'claude-opus-4-8', max_tokens: 4096,
      // prompt caching: จุด cache ท้าย system → tools+system (ส่วนหัวที่ซ้ำทุกครั้ง) อ่านจาก cache เหลือ ~0.1x
      // หมายเหตุ: system มีวันที่+ความจำถาวร → cache รีเซ็ตเมื่อเปลี่ยน ซึ่งไม่บ่อย
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: ASSISTANT_TOOLS, messages,
    });
    const u = resp.usage || {};
    console.log(`[assistant] turn=${turn} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
    if (resp.stop_reason !== 'tool_use') {
      reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      break;
    }
    messages.push({ role: 'assistant', content: resp.content });
    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      let out;
      try { out = await runAssistantTool(block.name, block.input || {}, operator, ctx); }
      catch (e) { out = { error: e.message }; }
      actions.push({ tool: block.name, input: block.input });
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  reply = reply || 'รับทราบครับ';
  // เก็บบทสนทนารอบนี้ไว้ต่อ session (จำกัดไว้ ~30 ข้อความล่าสุดต่อ session)
  if (persist && session) {
    const ts = nowBKK();
    await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [session, 'user', String(userMessage || '') + (nImg ? ` 🖼[แนบรูป${nImg > 1 ? ' ' + nImg + ' รูป' : ''}]` : ''), ts]);
    await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [session, 'assistant', reply, ts]);
    await db.exec(`DELETE FROM assistant_messages WHERE session = ? AND id NOT IN (SELECT id FROM assistant_messages WHERE session = ? ORDER BY id DESC LIMIT 30)`, [session, session]);
  }
  return { reply, actions, pending: ctx.pending };
}

app.post('/api/assistant', async (req, res) => {
  if (!getAnthropic()) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์' });
  const { message, operator, session, image, images } = req.body;
  // รวมรูป: images (อาเรย์ หลายส่วน) หรือ image (เดี่ยว) — จำกัด 6 รูปกัน payload บวม
  let imgs = Array.isArray(images) ? images.filter(im => im && im.data).map(im => ({ data: String(im.data), media_type: im.media_type || 'image/jpeg' })) : [];
  if (!imgs.length && image && image.data) imgs = [{ data: String(image.data), media_type: image.media_type || 'image/jpeg' }];
  imgs = imgs.slice(0, 6);
  if (!message && !imgs.length) return res.status(400).json({ error: 'message หรือ image จำเป็น' });
  try {
    const { reply, actions, pending } = await runAssistantConversation({ userMessage: String(message || ''), images: imgs, operator, session });
    res.json({ reply, actions, pending });
  } catch (err) {
    console.error('[assistant] error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// กดปุ่ม ✅/❌ บนการ์ดยืนยันในหน้าแชท → เขียนข้อมูลจริง (หรือยกเลิก) + จดผลลง memory ของ session
app.post('/api/assistant/confirm', async (req, res) => {
  const { action_id, approve, operator } = req.body;
  if (!action_id) return res.status(400).json({ error: 'action_id จำเป็น' });
  try {
    const rows = await dbAll('SELECT * FROM assistant_actions WHERE id = ?', [action_id]);
    const act = rows[0];
    if (!act) return res.status(404).json({ error: 'ไม่พบรายการนี้' });
    if (act.status !== 'pending') return res.json({ ok: false, message: `รายการนี้ถูก${act.status === 'approved' ? 'บันทึกไปแล้ว' : 'ปิดไปแล้ว'}`, status: act.status });
    let message, status;
    if (approve) {
      try {
        message = await executeAssistantAction(act.tool, JSON.parse(act.input || '{}'), operator || act.operator_name);
        status = 'approved';
      } catch (e) {
        await db.exec("UPDATE assistant_actions SET status = 'error', result = ?, decided_at = ? WHERE id = ?", [e.message, nowBKK(), act.id]);
        return res.status(500).json({ ok: false, error: `บันทึกไม่สำเร็จ: ${e.message}` });
      }
    } else {
      message = 'ยกเลิกรายการแล้ว ไม่มีการบันทึก';
      status = 'rejected';
    }
    await db.exec('UPDATE assistant_actions SET status = ?, result = ?, decided_at = ? WHERE id = ?', [status, message, nowBKK(), act.id]);
    // ── เฟส 3: หลังกดยืนยัน ให้ผู้ช่วยทำขั้นตอนถัดไปที่ค้างอยู่ต่ออัตโนมัติ ──
    // ป้อน [ระบบ] note กลับเข้าบทสนทนา แล้วเรียก loop ใหม่ → ได้ reply/การ์ดใหม่ส่งให้ client แสดง
    let followUp = null, followUpPending = [];
    if (act.session) {
      const note = approve
        ? `[ระบบ] ผู้ใช้กดยืนยันรายการ #${act.id} แล้ว — ${message}. ถ้ามีขั้นตอนถัดไปในงานชุดที่กำลังทำอยู่ ให้ทำต่อทันที (เช่นเสนอบันทึกรายการถัดไป/สรุปผล) ถ้าไม่มีก็ตอบรับสั้นๆ`
        : `[ระบบ] ผู้ใช้ยกเลิกรายการ #${act.id} (${act.summary}). ถามผู้ใช้ว่าต้องการแก้ไขหรือข้ามขั้นตอนนี้ไหม`;
      if (getAnthropic()) {
        try {
          const conv = await runAssistantConversation({ userMessage: note, operator: operator || act.operator_name, session: act.session });
          followUp = conv.reply;
          followUpPending = conv.pending || [];
        } catch (e) {
          console.error('[assistant/confirm] follow-up error', e.message);
          // fallback: จดผลแบบเดิม เพื่อให้เทิร์นถัดไปรู้บริบท
          await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [act.session, 'user', note, nowBKK()]);
          await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [act.session, 'assistant', 'รับทราบครับ', nowBKK()]);
        }
      } else {
        // ไม่มี API key (local) — จดผลไว้ในประวัติเฉยๆ
        await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [act.session, 'user', note, nowBKK()]);
        await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [act.session, 'assistant', 'รับทราบครับ', nowBKK()]);
      }
    }
    res.json({ ok: true, status, message, followUp, pending: followUpPending });
  } catch (err) {
    console.error('[assistant/confirm] error', err.message);
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

// เผยฟังก์ชันภายในให้เทสต์ require ได้ (โดยไม่ต้องบูตเซิร์ฟเวอร์)
module.exports = { app, initDb, shiftJustEnded, shiftsForWeekday, factoryShiftsForWeekday, rememberFact, recallFacts,
  forgetFact, memoryPromptBlock, buildAssistantSystem, runAssistantTool, getReportConfig,
  buildShiftCardData, runShiftAnalysis, getQualitySpecs, setQualitySpec, formatThaiDate };

if (require.main === module) {
  initDb()
    .then(() => {
      app.listen(port, '0.0.0.0', () => {
        console.log(`Server running at http://0.0.0.0:${port}`);
        // ปิดไว้ชั่วคราว — Telegram อนุญาตแค่ webhook เดียวต่อบอท และ n8n's Telegram Trigger
        // (n8n-Telegram-Production-Chart.json) ใช้บอทตัวเดียวกันสำหรับ "สรุปยอดผลิตวันนี้"
        // เปิดอีกครั้งได้เมื่อ n8n ฝั่งนั้น deactivate ไปแล้วจริงๆ หรือออกแบบให้ทำงานร่วมกันแล้ว
        // registerTelegramWebhook();
        // ตัวจับเวลาส่งรายงานอัตโนมัติ + วิเคราะห์สิ้นกะ (เฟส 1) — เช็กทุกนาที (ต้องให้เซิร์ฟเวอร์ตื่นอยู่; มี Keep-Warm ping ช่วย)
        setInterval(() => { reportTick(); shiftAnalysisTick(); }, 60 * 1000);
        console.log('[report] scheduler started (every 60s) + shift-analysis');
      });
    })
    .catch((err) => {
      console.error('[db] init failed — server not started', err);
      process.exit(1);
    });
}
