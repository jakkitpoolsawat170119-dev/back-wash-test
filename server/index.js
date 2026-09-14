require('dotenv').config();
const express = require('express');
const db = require('./db');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const axios = require('axios');
const FormData = require('form-data');
const { renderShiftCardPNG, renderKpiCardPNG, canRenderCard, renderBeforeAfterCardPNG,
  renderRepairCardPNG, renderAmSheetCardPNG } = require('./shiftCard');
const amShift = require('./shiftSchedule');   // mirror ของ client/src/shiftSchedule.ts — แก้ต้องแก้คู่กัน
const vault = require('./vault');
const pm = require('./pmSync');   // ดึงแผน PM จากแอปทีมช่าง (Netlify) — กระจกอ่านอย่างเดียว
const articlePage = require('./articlePage');
const chartSvg = require('./chartSvg');
const jsGenPrompt = require('./jsGenPrompt');
const ai = require('./ai');   // ชั้นกลางเลือกเจ้า/รุ่นต่อจุด — ดู server/ai/index.js

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
// เก็บ raw body ไว้ด้วย — LINE เซ็น payload ด้วย HMAC ของ "ไบต์ดิบ" ถ้าเอา JSON ที่ parse แล้วมา
// stringify ใหม่ ลายเซ็นจะไม่ตรง (ลำดับคีย์/ช่องว่างเปลี่ยน)
app.use(express.json({ limit: '20mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
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
  // แผนผลิตรายกะ (วางข้อความ → AI แกะ) — เก็บเป้าเป็น Boxes/batch ต่อรส ไม่ผูก Line (match ด้วยรสตอนทำ balance)
  // แยกจาก production_plans เดิม (line-keyed, ผูก daily_tasks/KPI) เพื่อไม่กระทบ flow เดิม · 1 batch = 100 boxes
  `CREATE TABLE IF NOT EXISTS shift_plans (
      id ${db.pk},
      work_day TEXT,
      shift TEXT,
      flavor TEXT,
      target_boxes INTEGER,
      target_batches REAL,
      staff INTEGER,
      machine_code TEXT,
      spec TEXT,
      created_at TEXT,
      UNIQUE(work_day, shift, flavor)
    )`,
  // ── ระบบลงยอดผลิต (เฟส 0) ────────────────────────────────────────────────
  // sku_master = บ้านเดียวของข้อมูลสินค้า (ย้ายจาก SKU_PRESETS ที่ hardcode ใน client
  //   + ชีต SKU ที่ n8n อ่าน) · keyword ยังเป็น join key เดิมกับโหนด Resolve SKU
  // count_unit = หน่วยที่ "นับของจริง" ต่อ SKU: กล่อง | หม้อ | กระสอบ
  //   (ฟอร์ม Google เขียน "กล่อง/หม้อ" · Icing บางตัวนับเป็นกระสอบ — แก้ผ่าน /api/sku ได้)
  // plan_flavor = ของเก่า เลิกใช้จับคู่แล้ว (ย้ายไป sku_alias) · คอลัมน์ยังอยู่เพื่อไม่ต้อง migrate
  `CREATE TABLE IF NOT EXISTS sku_master (
      id ${db.pk},
      keyword TEXT UNIQUE,
      sku_code TEXT,
      product_name TEXT,
      group_name TEXT,
      machine TEXT,
      count_unit TEXT DEFAULT 'กล่อง',
      pack_factor INTEGER DEFAULT 0,
      plan_flavor TEXT,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      updated_at TEXT
    )`,
  // ── พจนานุกรมชื่อเล่น → รหัส SKU ────────────────────────────────────────
  // ชื่อสินค้าตัวเดียวกันมี 3 แบบและไม่มีทางตรงกัน: ชื่อในแผนบรรจุ · ชื่อในแผนรายอาทิตย์ · ชื่อทางการใน SKU master
  // ตัวยึดจริงคือ "รหัส SKU" เพราะเป็นตัวที่ไหลเข้า Google Sheet — ตารางนี้คือสะพานเชื่อมชื่อเล่นเข้ารหัส
  //
  // ⚠️ machine_norm อยู่ในคีย์เพราะ "ชื่อเดียวกันบนคนละเครื่อง = คนละ SKU"
  //    เช่น Syrup 800 บน Linear#3 = S76S9Z000M (MT) แต่บน Linear#4 = S76S9Z000T (TT)
  //    ชีตจับคู่ทำมือรุ่นเก่าผูก "Syrup800" ไว้กับ TT ตัวเดียว ยอดเลยเข้าผิด SKU (บั๊กข้อ C 2026-08-06)
  //    machine_norm = '' แปลว่าชื่อนี้ไม่กำกวม ใช้ได้ทุกเครื่อง
  //
  // ⚠️ กฎเหล็ก: แถวในตารางนี้เกิดจาก "คนกดเลือก" เท่านั้น ห้ามให้ AI หรือกฎเดาแล้วเขียนเอง
  `CREATE TABLE IF NOT EXISTS sku_alias (
      id ${db.pk},
      alias_norm TEXT,
      alias_raw TEXT,
      machine_norm TEXT DEFAULT '',
      sku_code TEXT,
      source TEXT,
      created_by TEXT,
      created_at TEXT,
      UNIQUE(alias_norm, machine_norm)
    )`,
  // ทีมงานประจำกะ (ตามฟอร์ม Google หมวด 2) — ติ๊กเลือกตอนลงยอด แล้วนับเป็น "จำนวนคนผลิต"
  `CREATE TABLE IF NOT EXISTS shift_crew (
      id ${db.pk},
      shift TEXT,
      name TEXT,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(shift, name)
    )`,
  // รายงานยอดผลิต = source of truth (DB นำ · Google Sheet ตามทีหลัง)
  // สถานะ: pending_review → pending_warehouse → pending_approval → approved | rejected
  //   pending_review    = เข้าแอปแล้ว รอหัวหน้าตรวจ (แก้ได้ทุกช่องเฉพาะช่วงนี้)
  //   pending_warehouse = หัวหน้าตรวจครบแล้วส่งลิงก์ให้คลัง → ล็อกค่า ห้ามแก้
  //   pending_approval  = คลังนับเสร็จ ไหลกลับมาให้หัวหน้าอนุมัติรอบสอง
  // กฎเหล็ก: ข้อมูลห้ามข้ามไปคลังโดยไม่ผ่าน pending_review
  // prod_qty / wh_qty อยู่ในหน่วยเดียวกันเสมอ (= count_unit) · *_pcs คำนวณฝั่ง server เท่านั้น
  // payload = JSON ของช่องที่ไม่ต้อง query (เวลา 6 ช่อง, ของเสียรายประเภท, ทีมงาน, Lot)
  `CREATE TABLE IF NOT EXISTS production_reports (
      id ${db.pk},
      report_id TEXT UNIQUE,
      work_day TEXT,
      report_date TEXT,
      shift TEXT,
      sku_keyword TEXT,
      sku_code TEXT,
      product_name TEXT,
      group_name TEXT,
      machine TEXT,
      count_unit TEXT,
      pack_factor INTEGER DEFAULT 0,
      plan_qty REAL,
      plan_source TEXT DEFAULT 'none',
      prod_qty REAL,
      prod_pcs REAL,
      reporter_name TEXT,
      crew_count INTEGER DEFAULT 0,
      reported_at TEXT,
      wh_qty REAL,
      wh_pcs REAL,
      wh_name TEXT,
      wh_note TEXT,
      wh_submitted_at TEXT,
      variance_qty REAL,
      variance_pct REAL,
      variance_flag TEXT,
      variance_reason TEXT,
      status TEXT DEFAULT 'pending_warehouse',
      prod_status TEXT,
      miss_reason TEXT,
      approver_name TEXT,
      approved_qty REAL,
      approved_source TEXT,
      decision_note TEXT,
      decided_at TEXT,
      verify_token TEXT UNIQUE,
      verify_expires_at TEXT,
      verify_used_at TEXT,
      verify_sent_via TEXT,
      verify_sent_at TEXT,
      sheet_status TEXT DEFAULT 'pending',
      sheet_sent_at TEXT,
      sheet_attempts INTEGER DEFAULT 0,
      sheet_error TEXT,
      payload TEXT,
      created_at TEXT,
      updated_at TEXT
    )`,
  // ชุดรายงานของกะ — 1 ชุด = 1 ลิงก์ให้คลัง
  // กะหนึ่งลง 8+ รายการ ถ้าออกลิงก์ทีละรายการ = 24+ ลิงก์/วัน คลังกดไม่ไหวและกลุ่ม LINE รก
  // token อยู่ที่ batch (report ที่อยู่ในชุดไม่ต้องมี token ของตัวเอง)
  `CREATE TABLE IF NOT EXISTS production_batches (
      id ${db.pk},
      batch_id TEXT UNIQUE,
      work_day TEXT,
      shift TEXT,
      created_by TEXT,
      item_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending_warehouse',
      verify_token TEXT UNIQUE,
      verify_expires_at TEXT,
      verify_used_at TEXT,
      wh_name TEXT,
      wh_submitted_at TEXT,
      sent_via TEXT,
      sent_at TEXT,
      created_at TEXT,
      updated_at TEXT
    )`,
  // ── บอท Production_SPP (เฟส 2) ────────────────────────────────────────────
  // ผูก Telegram user → ชื่อคนจริง · ถามครั้งเดียวแล้วจำไว้ ไม่ต้องพิมพ์ชื่อทุกครั้ง
  `CREATE TABLE IF NOT EXISTS spp_tg_user (
      id ${db.pk},
      telegram_user_id TEXT UNIQUE,
      name TEXT,
      role TEXT DEFAULT 'production',
      chat_id TEXT,
      registered_at TEXT,
      last_seen_at TEXT
    )`,
  // ร่างของกะที่กำลังกรอกอยู่ในแชท — เก็บลง DB ไม่ใช่หน่วยความจำ
  // Render free tier หลับ/รีสตาร์ตได้ตลอด ถ้าเก็บใน RAM ยอดที่กรอกมาทั้งกะหายทันที
  // draft = JSON { header, items[], current{} } · ยังไม่เป็น production_reports จนกว่าจะกด "ส่งทั้งกะ"
  // (จงใจไม่เขียนเป็นแถว draft ใน production_reports เพื่อไม่ให้ของค้างครึ่ง ๆ โผล่ในหน้าอนุมัติ)
  `CREATE TABLE IF NOT EXISTS spp_tg_session (
      id ${db.pk},
      chat_id TEXT,
      user_id TEXT,
      state TEXT,
      draft TEXT,
      updated_at TEXT,
      UNIQUE(chat_id, user_id)
    )`,
  // audit trail แบบ append-only — ห้ามมี UNIQUE/NOT NULL ที่ทำให้เขียนไม่ผ่าน
  `CREATE TABLE IF NOT EXISTS production_report_events (
      id ${db.pk},
      report_id TEXT,
      event TEXT,
      actor TEXT,
      actor_role TEXT,
      detail TEXT,
      channel TEXT,
      created_at TEXT
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
  /* ══ ใบเช็ก AM รายกะ ══════════════════════════════════════════════════════
     1 ใบ = 1 Line ต้ม × 1 กะ × 1 วันทำงาน — ต่างจาก routine_state ตรงที่บันทึก "ผลตรวจ"
     ไม่ใช่แค่ "ทำแล้ว/ยังไม่ทำ" และมีมิติ "กะ" (จ-พฤ มี 3 กะ ตรวจ 3 รอบ)
     🔴 ห้ามเอาไปยัดใน routine_state — ตารางนั้นมี UNIQUE(state_date,assignee,node_key)
        เป็น ON CONFLICT target อยู่ 6 จุด และ 34 แถว pm* ใช้ร่วมกันอยู่
     UNIQUE อยู่ใน CREATE TABLE ทั้งคู่ → ทำงานเหมือนกันทั้ง SQLite/Postgres ไม่ต้อง ALTER ตลอดชีพ */
  `CREATE TABLE IF NOT EXISTS am_sheets (
      id ${db.pk},
      work_day TEXT,
      shift TEXT,
      line TEXT,
      line_status TEXT,
      status TEXT DEFAULT 'draft',
      opened_by TEXT,
      opened_at TEXT,
      submitted_by TEXT,
      submitted_at TEXT,
      updated_at TEXT,
      UNIQUE(work_day, shift, line)
    )`,
  // ผลตรวจรายข้อ · result: NULL ยังไม่ตรวจ · 'ok' ปกติ · 'ng' ไม่ปกติ (บังคับมี cause)
  // title เก็บ snapshot ไว้ เผื่อหัวข้อในทะเบียนถูกแก้ทีหลัง ใบเก่าจะได้ยังอ่านรู้เรื่อง
  `CREATE TABLE IF NOT EXISTS am_sheet_items (
      id ${db.pk},
      sheet_id INTEGER,
      node_key TEXT,
      routine_id INTEGER,
      title TEXT,
      result TEXT,
      cause TEXT,
      photo TEXT,
      photo_at TEXT,
      checked_by TEXT,
      updated_at TEXT,
      UNIQUE(sheet_id, node_key)
    )`,
  // ลิงก์สาธารณะ 1 ต่อ 1 ไลน์ — ปักหมุดในกลุ่มช่างได้ (ระดับความน่าเชื่อถือเดียวกับลิงก์ตรวจนับคลัง)
  `CREATE TABLE IF NOT EXISTS am_sheet_links (
      token TEXT PRIMARY KEY,
      line TEXT,
      created_by TEXT,
      created_at TEXT,
      last_used_at TEXT,
      active INTEGER DEFAULT 1
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
  // ── KPI report เฟส 2: กันส่งสรุป KPI รายสัปดาห์/รายเดือนซ้ำ — 1 แถวต่อ (ช่วง+ประเภท) ─
  `CREATE TABLE IF NOT EXISTS kpi_report_log (
      id ${db.pk},
      period_key TEXT,
      period_type TEXT,
      created_at TEXT,
      UNIQUE(period_key, period_type)
    )`,
  // ── KPI report เฟส 4: กันส่งแจ้งเตือนซ้ำข้าม restart ภายในวันเดียวกัน (1 แถวต่อวัน) ─
  `CREATE TABLE IF NOT EXISTS kpi_alert_log (
      id ${db.pk},
      alert_key TEXT UNIQUE,
      last_sent_at TEXT
    )`,
  // ── กันสร้างเหตุการณ์ "ค่าหลุดสเปก" ซ้ำ — 1 แถวต่อ (วัน+รส+ค่าที่หลุด) ─────
  `CREATE TABLE IF NOT EXISTS quality_watch_log (
      watch_key TEXT UNIQUE,
      incident_id INTEGER,
      created_at TEXT
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
  // ── สเปกน้ำล้าง CIP ต่อไลน์ — pH / แรงดันปั๊ม / เวลาต่อรอบที่ยอมรับได้ ─────────
  //    คนละเรื่องกับ quality_specs (นั่นคือค่าของ "สินค้า" ต่อรส) — ห้ามเอามาปนกัน
  `CREATE TABLE IF NOT EXISTS cip_specs (
      line TEXT UNIQUE,
      ph_min REAL,
      ph_max REAL,
      pressure_min REAL,
      pressure_max REAL,
      max_minutes REAL,
      updated_at TEXT
    )`,
  // ── สถานะ "กำลังรอรูปหลังทำ" ต่อผู้ใช้ Telegram — กดปุ่ม 📸 แล้วส่งรูปงานเข้ามา
  // 1 แถวต่อ (chat_id, user_id) — เก็บว่ากำลังแนบรูปของงาน task_id ไหน (เก็บ DB กัน Render restart หาย)
  // ── ร่างเหตุการณ์ที่กำลังแจ้งผ่าน Telegram (1 แถวต่อ 1 คนในแชตนั้น) ─────────
  //    เก็บใน DB ไม่ใช่ตัวแปรในหน่วยความจำ — Render รีสตาร์ตบ่อย ร่างต้องไม่หาย
  /* ร่างของกระดานซ่อมบำรุงในบอท (คนละเรื่องกับ tg_incident_draft ที่เป็นร่าง "ใบแจ้งซ่อมใหม่")
     kind = 'close' ปิดงานซ่อม (ถามวิธีแก้ + รูปหลังซ่อม) · 'pm' ตั้งงาน PM ใหม่
     ref_id = ใบงานที่กำลังทำอยู่ · data = JSON คำตอบสะสม
     เก็บลง DB ไม่ใช่ตัวแปรในหน่วยความจำ เพราะ Render รีสตาร์ตกลางบทสนทนาบ่อย       */
  `CREATE TABLE IF NOT EXISTS tg_maint_draft (
      chat_id TEXT,
      user_id TEXT,
      kind TEXT,
      ref_id INTEGER,
      step TEXT,
      data TEXT,
      created_at TEXT,
      UNIQUE(chat_id, user_id)
    )`,
  `CREATE TABLE IF NOT EXISTS tg_incident_draft (
      chat_id TEXT,
      user_id TEXT,
      step TEXT,
      title TEXT,
      machine TEXT,
      symptom TEXT,
      images TEXT,
      operator TEXT,
      created_at TEXT,
      UNIQUE(chat_id, user_id)
    )`,
  `CREATE TABLE IF NOT EXISTS tg_photo_wait (
      chat_id TEXT,
      user_id TEXT,
      task_id INTEGER,
      page TEXT,
      created_at TEXT,
      UNIQUE(chat_id, user_id)
    )`,
  // ── Duty board: รายชื่อผู้รับผิดชอบ (ย้ายจาก hardcode → DB เพื่อเพิ่ม/แก้เองได้) ─
  `CREATE TABLE IF NOT EXISTS duty_people (
      person_key TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      color TEXT,
      wash TEXT,
      initial TEXT,
      dot TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT
    )`,
  // ── Duty board: เช็กลิสต์งานประจำ (ซ้อนชั้นผ่าน parent_id) — จัดการเองได้ ─────
  `CREATE TABLE IF NOT EXISTS duty_routines (
      id ${db.pk},
      person_key TEXT,
      parent_id INTEGER,
      node_key TEXT,
      title TEXT,
      mono INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT
    )`,
  // ── ทะเบียนเครื่องจักร (ERP Phase 1 Master Data) — ใช้เป็นปลายทาง [[wikilink]] ของ KM ด้วย ──
  // ── โทเคนของคนที่ผ่านหน้า Admin แล้ว (ใช้กับเส้นที่แก้สิทธิ์ผู้ใช้) ──────────
  //   เก็บลง DB ไม่ใช่ตัวแปรในหน่วยความจำ เพราะ Render รีสตาร์ตบ่อย
  `CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      created_at TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS machines (
      id ${db.pk},
      code TEXT,
      name TEXT UNIQUE,
      line_name TEXT,
      installed_at TEXT,
      last_pm TEXT,
      note TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT
    )`,
  // ── เหตุการณ์ (หัวใจของ KM) — 1 แถว = 1 ปัญหา พร้อมสาเหตุ/วิธีแก้ · sync เป็นโน้ตใน vault ──
  `CREATE TABLE IF NOT EXISTS incidents (
      id ${db.pk},
      title TEXT,
      machine TEXT,
      line_name TEXT,
      batch_id TEXT,
      operator TEXT,
      occurred_at TEXT,
      symptom TEXT,
      cause TEXT,
      fix TEXT,
      result TEXT,
      status TEXT DEFAULT 'open',
      vault_path TEXT,
      created_at TEXT,
      updated_at TEXT
    )`,
  // ── ทีมซ่อมบำรุง: ชื่อกะ (แถวเดียว) — สมาชิกอยู่ใน duty_people kind='maint' ─────
  `CREATE TABLE IF NOT EXISTS maint_team (
      id ${db.pk},
      shift_name TEXT,
      updated_at TEXT
    )`,
  // ── ระบบแบ่งงานใบตรวจ (Audit auto-assign): กฎ zone/keyword → ผู้รับผิดชอบ ─────
  `CREATE TABLE IF NOT EXISTS assign_rules (
      id ${db.pk},
      rule_type TEXT,          -- 'keyword' (อ่านช่องประเด็น) | 'zone' (อ่านช่องสถานที่)
      pattern TEXT,
      owner_key TEXT,
      co_owner_key TEXT,       -- ผู้รับร่วม (เช่น เจ้าของโซนตรวจซ้ำงานช่าง)
      category TEXT,
      priority TEXT,
      specificity INTEGER DEFAULT 0,  -- มาก = จำเพาะ = แมตช์ก่อน
      active INTEGER DEFAULT 1,
      created_at TEXT
    )`,
  // ── บทความเทคนิค (เขียนจาก editor ในหน้า Admin) ────────────────────────────
  // blocks/tags เก็บเป็น JSON string เพราะต้องใช้ได้ทั้ง SQLite และ Postgres
  // (ไม่ใช้ชนิด jsonb ของ Postgres เพราะฝั่ง SQLite ไม่มี)
  `CREATE TABLE IF NOT EXISTS posts (
      id ${db.pk},
      slug TEXT,
      title TEXT,
      blocks TEXT,                    -- JSON: [{id,type,...}]
      status TEXT DEFAULT 'draft',    -- draft | review | published
      author TEXT,
      category TEXT,
      tags TEXT,                      -- JSON: ["CIP","Line2"]
      machine TEXT,                   -- เครื่องจักรที่เกี่ยว → [[wikilink]] ใน Obsidian
      excerpt TEXT,
      cover_url TEXT,
      seo_keyword TEXT,
      seo_desc TEXT,
      script_head TEXT,
      script_body TEXT,
      obs_folder TEXT DEFAULT 'บทความ',
      created_at TEXT,
      updated_at TEXT,
      published_at TEXT
    )`,
  // ── คลังวัสดุ/สารเคมี (ERP เฟส 1-2 ในแผน) ────────────────────────────────
  //   materials = ทะเบียนของ · material_moves = ทุกครั้งที่ของเข้า-ออก (ไม่ลบ ไม่ทับ)
  //   ยอดคงเหลือเก็บไว้ที่ materials.stock เพื่อไม่ต้องบวกย้อนหลังทุกครั้งที่เปิดหน้า
  //   แต่ทุกความเคลื่อนไหวจดยอดหลังทำ (balance_after) ไว้ตรวจย้อนได้ว่ายอดเพี้ยนตอนไหน
  `CREATE TABLE IF NOT EXISTS materials (
      id ${db.pk},
      code TEXT,
      name TEXT UNIQUE,
      unit TEXT,
      stock REAL DEFAULT 0,
      reorder_point REAL DEFAULT 0,
      cost_per_unit REAL DEFAULT 0,
      supplier TEXT,
      note TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS material_moves (
      id ${db.pk},
      material_id INTEGER,
      kind TEXT,                      -- out=เบิกใช้ · in=รับเข้า · adjust=ปรับยอดตามที่นับได้
      qty REAL,
      unit_cost REAL,                 -- ราคาต่อหน่วย ณ ตอนนั้น (เก็บไว้กับรายการ ราคาขึ้นทีหลังไม่ทำให้ของเก่าเพี้ยน)
      balance_after REAL,
      batch_ref TEXT,                 -- เบิกไปใช้กับ batch ไหน (พิมพ์เอง — CIP หรือ batch ผลิตก็ได้)
      cip_batch_id INTEGER,
      note TEXT,
      operator TEXT,
      moved_at TEXT
    )`,
  // ── อัตราค่าใช้จ่ายสำหรับคิดต้นทุน (ERP เฟส 3) — แถวเดียว ─────────────────
  //   downtime_per_hour = ค่าเสียโอกาสต่อชั่วโมงที่เครื่องหยุด (ตั้งเองได้ · รายเครื่องตั้งทับได้ที่ machines.downtime_cost)
  `CREATE TABLE IF NOT EXISTS cost_config (
      id ${db.pk},
      downtime_per_hour REAL DEFAULT 0,
      note TEXT,
      updated_at TEXT
    )`,
  // ── เวอร์ชันของ SOP/คู่มือ (แผน KM ข้อ 7) ─────────────────────────────────
  //   1 แถว = 1 ครั้งที่ "อนุมัติ" — เก็บเนื้อหาตอนนั้นไว้ทั้งชุด ย้อนดู/กู้คืนได้
  //   บทความทั่วไปไม่แตะตารางนี้เลย
  `CREATE TABLE IF NOT EXISTS post_versions (
      id ${db.pk},
      post_id INTEGER,
      version INTEGER,
      title TEXT,
      blocks TEXT,
      author TEXT,
      approved_by TEXT,
      approved_at TEXT,
      note TEXT
    )`,
  // ── sha ของไฟล์ที่ระบบเป็นคนเขียนเข้า vault ล่าสุด ─────────────────────────
  // ใช้แยกว่า push ที่เข้ามาเป็นฝีมือระบบเองหรือคน — ถ้า sha ตรงกับที่จดไว้ = ของเราเอง ข้ามไป
  // (ไม่งั้นจะวนลูป: ระบบเขียน → webhook → reconcile → เขียนอีก)
  `CREATE TABLE IF NOT EXISTS vault_files (
      path TEXT PRIMARY KEY,
      sha TEXT,
      updated_at TEXT
    )`,
  // ── กล่องรอยืนยันจาก Obsidian ─────────────────────────────────────────────
  // ติ๊กปิดงานทำให้เลย ส่วนที่เหลือ (ขอเปิดใหม่ / แก้ข้อความ / งานใหม่) ต้องให้คนกดรับก่อน
  // task_id = 0 สำหรับงานใหม่ที่ยังไม่มีในระบบ (ใช้ 0 ไม่ใช่ NULL เพราะ UNIQUE ไม่กัน NULL ซ้ำ)
  `CREATE TABLE IF NOT EXISTS vault_inbox (
      id ${db.pk},
      kind TEXT,                      -- reopen | edit | new
      task_id INTEGER DEFAULT 0,
      file_path TEXT,
      line_text TEXT,                 -- บรรทัดดิบในไฟล์ ใช้ตามไปลบตอนกดรับงานใหม่
      proposed_title TEXT,
      task_date TEXT,
      author TEXT,                    -- คนที่ push (จาก commit)
      status TEXT DEFAULT 'pending',  -- pending | accepted | rejected
      created_at TEXT,
      decided_at TEXT,
      decided_by TEXT,
      UNIQUE(kind, task_id, line_text)
    )`,
  // ── คลังไฟล์ (เฟส 2) ───────────────────────────────────────────────────────
  // ไฟล์จริงอยู่บน Supabase Storage เหมือนเดิม — ตารางนี้เก็บแค่ "ทะเบียน" ไว้ให้ค้น/กรอง
  // เพราะชื่อไฟล์ในที่เก็บเป็น <timestamp>-<สุ่ม>.<ext> ซึ่งค้นอะไรไม่ได้เลย
  // url เป็น UNIQUE เพื่อให้ลงทะเบียนซ้ำได้โดยไม่เกิดแถวซ้ำ (ตอนสแกนไฟล์เก่า)
  `CREATE TABLE IF NOT EXISTS media_files (
      id ${db.pk},
      url TEXT UNIQUE,
      path TEXT,               -- path ใน bucket (ใช้ตอนสแกนเทียบของเก่า)
      name TEXT,               -- ชื่อไฟล์ตอนอัปโหลด (ของเก่าที่สแกนเจอจะเป็น path)
      mime TEXT,
      size INTEGER DEFAULT 0,
      folder TEXT DEFAULT '',  -- พื้นที่ผลิต: ระบบ CIP / Boiler / Evaporator / SCADA-HMI / SOP
      tags TEXT,               -- JSON: ["ก่อนล้าง","ปั๊ม"]
      caption TEXT,            -- คำบรรยายเริ่มต้น เอาไปเติมให้บล็อกรูปตอนแทรก
      uploaded_by TEXT,
      created_at TEXT
    )`,
  /* ══ งาน PM รายปี 52 สัปดาห์ ══════════════════════════════════════════════
     🔴 3 ตารางแรกเป็น "กระจก" ของแอปทีมช่าง (Netlify + Firebase spp-am)
        pmSync เขียนทับทุกรอบ — ห้ามเอาข้อมูลของแอปนี้ไปฝากไว้ เดี๋ยวหายเงียบ
     เจ้าของแผน/ผลปิดงานคือแอปทีมช่าง แอปนี้อ่านอย่างเดียว (ดู server/pmSync.js) */
  `CREATE TABLE IF NOT EXISTS pm_items (
      net_id TEXT PRIMARY KEY,      -- w01–w30 (+ รายการที่เพิ่มบน Netlify)
      name TEXT,
      freq TEXT,                    -- '2 wk.' | '1 month' | '6 months' (ดิบจาก Netlify)
      weeks TEXT,                   -- JSON array เลขสัปดาห์ ISO ที่ครบกำหนด (ใช้ได้ทุกปี ไม่ผูกปี)
      deleted INTEGER DEFAULT 0,    -- ลบบน Netlify = ซ่อน (ไม่ลบจริง งานย่อยจะได้ไม่หาย)
      is_custom INTEGER DEFAULT 0,  -- รายการที่เพิ่มใหม่บน Netlify (ไม่มีในแผนตั้งต้น)
      updated_at TEXT,
      synced_at TEXT
    )`,
  // ผลปิดงานรายสัปดาห์ · key = {net_id}_{iso_year}_{week} (คีย์เดียวกับ Firebase)
  `CREATE TABLE IF NOT EXISTS pm_done (
      key TEXT PRIMARY KEY,
      net_id TEXT,
      iso_year INTEGER,
      week INTEGER,
      done INTEGER DEFAULT 1,
      done_by TEXT,
      done_date TEXT,
      note TEXT,
      updated_at TEXT,
      synced_at TEXT
    )`,
  // รอบที่ปิดใช้งาน — ไม่นับทั้งตัวตั้งและตัวหาร
  `CREATE TABLE IF NOT EXISTS pm_skip (
      key TEXT PRIMARY KEY,
      net_id TEXT,
      iso_year INTEGER,
      week INTEGER,
      reason TEXT,
      updated_at TEXT,
      synced_at TEXT
    )`,
  /* ── ต่อจากนี้เป็นของแอปนี้เอง (Netlify ไม่มีช่องเก็บ) — pmSync ห้ามแตะ ──── */
  // ลิสต์งานย่อยต่อเครื่อง · every = ทำทุกกี่ "รอบของเครื่อง" (1 = ทุกครั้ง)
  // ⚠️ ถี่กว่ารอบของเครื่องไม่ได้ — จุดของงานย่อยเป็น subset ของรอบแม่เสมอ
  //    (ถ้านับงานย่อยเป็นรอบด้วย เลขทั้งหน้าจะเด้งจาก 234 เป็นหลายร้อยทันที)
  `CREATE TABLE IF NOT EXISTS pm_jobs (
      id ${db.pk},
      net_id TEXT,
      title TEXT,
      every INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT
    )`,
  // ผู้รับผิดชอบตั้งต้นรายเครื่อง — Netlify มีแต่ doneBy หลังปิดงาน ไม่มี assignee ล่วงหน้า
  `CREATE TABLE IF NOT EXISTS pm_item_meta (
      net_id TEXT PRIMARY KEY,
      owner TEXT,
      updated_at TEXT
    )`,
  // กันแจ้งเตือนซ้ำ · key = {isoYear}_{week}_{open|chase} — จองคีย์ก่อนส่งจริง
  `CREATE TABLE IF NOT EXISTS pm_notify_log (
      key TEXT PRIMARY KEY,
      sent_at TEXT
    )`,
  // ชื่อพ้องของเครื่องจักร — Netlify เขียน "ไลน์ต้ม 1" ทะเบียนเขียน "Line ต้ม 1"
  `CREATE TABLE IF NOT EXISTS machine_alias (
      alias TEXT PRIMARY KEY,
      machine_name TEXT,
      created_at TEXT
    )`,

  /* ══ ทะเบียนเครื่องจักรแบบเชื่อมโยง (Machine Hub) ══════════════════════════
     คู่ที่ "เป็นไปได้" อยู่ที่ machine_links · คู่ "ของจริงรายวัน" อยู่ที่ machine_runs
     ทุกตารางอ้างเครื่องด้วย machines.name — คีย์เดียวกับ duty_routines / incidents /
     ชื่อไฟล์โน้ตใน vault · เปลี่ยนชื่อเครื่องต้อง UPDATE ตามให้ครบทุกตารางในกลุ่มนี้
     ══════════════════════════════════════════════════════════════════════════ */
  `CREATE TABLE IF NOT EXISTS machine_links (
      id ${db.pk},
      line_name TEXT,
      packer_name TEXT,
      note TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT,
      UNIQUE(line_name, packer_name)
    )`,
  // สินค้าประจำคู่ = ประโยค "Line ต้ม1 ผลิต Amazon ใช้เครื่องบรรจุ L2" ในโน้ตโจทย์
  // ใช้เดาไลน์ให้รอบวันนี้ ตอนเครื่องบรรจุตัวเดียวรับได้หลายไลน์ (ไม่ต้องถามคน)
  // ⚠️ flavor_norm ต้องเป็น '' ห้าม NULL — Postgres ถือ NULL ต่างกันเสมอ UNIQUE จะเลิกกันซ้ำ
  `CREATE TABLE IF NOT EXISTS machine_link_products (
      id ${db.pk},
      link_id INTEGER,
      flavor TEXT,
      flavor_norm TEXT DEFAULT '',
      sku_code TEXT,
      note TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT,
      UNIQUE(link_id, flavor_norm)
    )`,
  /* กฎเตือน — ช่องเงื่อนไขที่เว้นว่าง = "อะไรก็ได้" · AND กันทุกช่องที่ไม่ว่าง
     specificity มาก = จำเพาะมาก = ขึ้นก่อนในเช็กลิสต์ (ยืมสำนวนจาก assign_rules)
     🔑 หลายกฎเข้าพร้อมกันได้ ข้อของทุกกฎรวมเป็นใบเดียว — ไม่ใช่ "ผู้ชนะคนเดียว"
     items = JSON [{key,title,detail,needPhoto,needQc}] — key ต้องนิ่งตลอดกาล
       เพราะ run_check_items ใช้ (check_id, item_key) เป็น ON CONFLICT target */
  `CREATE TABLE IF NOT EXISTS machine_rules (
      id ${db.pk},
      code TEXT,
      title TEXT,
      timing TEXT DEFAULT 'start',
      line_name TEXT DEFAULT '',
      packer_name TEXT DEFAULT '',
      packer_key TEXT DEFAULT '',
      product_pattern TEXT DEFAULT '',
      shift TEXT DEFAULT '',
      items TEXT,
      owner_role TEXT,
      note TEXT,
      specificity INTEGER DEFAULT 0,
      notify INTEGER DEFAULT 1,
      active INTEGER DEFAULT 1,
      deleted INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )`,
  /* 1 แถว = "วันนี้ เครื่องบรรจุตัวนี้ ผลิตสินค้าตัวนี้ ป้อนจากไลน์นี้"
     ตั้งต้นจากแผนบรรจุ (shift_plans) แล้วคนแก้ทับได้ — 🔴 manual ชนะ plan เสมอ
     ⚠️ packer_key / flavor_norm ต้องเป็น '' ห้าม NULL (เหตุผลเดียวกับข้างบน) */
  `CREATE TABLE IF NOT EXISTS machine_runs (
      id ${db.pk},
      work_day TEXT,
      shift TEXT,
      packer_name TEXT DEFAULT '',
      packer_key TEXT DEFAULT '',
      line_name TEXT,
      flavor TEXT,
      flavor_norm TEXT DEFAULT '',
      sku_code TEXT,
      target_boxes INTEGER,
      source TEXT DEFAULT 'plan',
      line_source TEXT,
      plan_key TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      confirmed_by TEXT,
      confirmed_at TEXT,
      note TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(work_day, shift, packer_key, flavor_norm)
    )`,
  // ใบเช็กของรอบ — 1 รอบมีได้หลายใบตามจังหวะ (start/during/end) · โครงยกมาจาก am_sheets
  `CREATE TABLE IF NOT EXISTS run_checks (
      id ${db.pk},
      run_id INTEGER,
      work_day TEXT,
      shift TEXT,
      machine_name TEXT,
      timing TEXT,
      status TEXT DEFAULT 'draft',
      opened_by TEXT,
      opened_at TEXT,
      submitted_by TEXT,
      submitted_at TEXT,
      card_chat_id TEXT,
      card_msg_id TEXT,
      card_kind TEXT,
      updated_at TEXT,
      UNIQUE(run_id, timing)
    )`,
  // title/detail เก็บเป็น snapshot — แก้กฎทีหลังแล้วใบเก่าต้องยังอ่านรู้เรื่อง
  // (กติกาเดียวกับ am_sheet_items) · result = NULL | 'ok' | 'ng'
  `CREATE TABLE IF NOT EXISTS run_check_items (
      id ${db.pk},
      check_id INTEGER,
      item_key TEXT,
      rule_id INTEGER,
      title TEXT,
      detail TEXT,
      need_photo INTEGER DEFAULT 0,
      need_qc INTEGER DEFAULT 0,
      result TEXT,
      cause TEXT,
      photo TEXT,
      photo_at TEXT,
      checked_by TEXT,
      qc_by TEXT,
      updated_at TEXT,
      UNIQUE(check_id, item_key)
    )`,
  // ลิงก์สาธารณะ 1 ต่อ 1 เครื่อง ปักหมุดในกลุ่มได้ (แพทเทิร์นเดียวกับ am_sheet_links)
  `CREATE TABLE IF NOT EXISTS run_check_links (
      token TEXT PRIMARY KEY,
      machine_name TEXT,
      created_by TEXT,
      created_at TEXT,
      last_used_at TEXT,
      active INTEGER DEFAULT 1
    )`,
  // กันยิงซ้ำ · key = 'run:{run_id}:{timing}' — จองคีย์ก่อนส่งจริง (วิธีเดียวกับ pm_notify_log)
  `CREATE TABLE IF NOT EXISTS run_notify_log (
      key TEXT PRIMARY KEY,
      sent_at TEXT
    )`,
];

// [ชื่อ, PIN, สิทธิ์] — seed ครั้งแรกเท่านั้น แก้สิทธิ์ทีหลังได้ที่หน้า "ผู้ใช้และสิทธิ์"
const DEFAULT_OPERATORS = [
  ["จักรกฤษ พูลสวัสดิ์", "1234", "admin"],
  ["พัฒพริศ อ่ำอยู่", "1234", "operator"],
  ["อนุวัตร สุวรรณวงค์", "1234", "operator"],
];

// ทีมงานประจำกะ ตามฟอร์ม Google หมวด 2 (ดู GOOGLE_FORM_STRUCTURE.md)
const DEFAULT_SHIFT_CREW = [
  ['กะ1', 'อนุวัตร สุวรรณวงศ์'], ['กะ1', 'ดำรงค์ มีแก้ว'], ['กะ1', 'รัตนะ ธงเพ็ง'], ['กะ1', 'นพพร พิมพ์ทอง'],
  ['กะ2', 'จักรกฤษ พูลสวัสดิ์'], ['กะ2', 'สุรศักดิ์ สรหงษ์'], ['กะ2', 'ศราวุธ เกษประทุม'], ['กะ2', 'เกรียงไกร ศรีนิล'],
  ['กะ3', 'พัฒน์พริศร์ อ่ำอยู่'], ['กะ3', 'ไพรวรรณ ย้อนเพชร'], ['กะ3', 'รัชพล รัตนานนท์'], ['กะ3', 'สมเจตน์ การภักดี'],
];

/* ── จับคู่ชื่อคนไทยแบบ "พอเดาได้" ────────────────────────────────────────────
   ชื่อเดียวกันในระบบสะกดไม่ตรงกันเป็นเรื่องปกติ (ไม้เอก/ไม้โท/การันต์/ค-ศ-ษ-ส หาย)
   nameKey() ตัดสิ่งที่มักพิมพ์ต่างกันออก แล้วค่อยเทียบ — ใช้ "เดา" เท่านั้น
   ตัวจริงที่ระบบยึดคือคอลัมน์ operators.shift ที่คนกดยืนยันเอง                */
const THAI_MARKS = /[ัิ-ฺ็-๎\s.\-]/g;   // สระบน/ล่าง · วรรณยุกต์ · การันต์ · ช่องว่าง
function nameKey(s) {
  return String(s || '').replace(THAI_MARKS, '')
    .replace(/[ทฑธ]/g, 'ท').replace(/[ศษส]/g, 'ส').replace(/[คขฆ]/g, 'ค')   // เสียงเดียวกัน เขียนได้หลายตัว
    .replace(/[ณน]/g, 'น').replace(/[ฏต]/g, 'ต').replace(/[รล]/g, 'ร')
    .toLowerCase();
}
// ระยะแก้คำ (Levenshtein) — ตัวอักษรหาย/เกิน/สลับไม่กี่ตัวยังถือว่าคนเดียวกัน
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
/* หาคนในรายชื่อทีมกะที่ "น่าจะเป็นคนเดียวกัน"
   ตรงเป๊ะก่อน → ถ้าไม่เจอค่อยยอมให้ต่างได้ ≤2 ตัว (ชื่อไทยตกการันต์/ศ-ค กันบ่อยมาก)
   ⚠️ ถ้าใกล้เคียงหลายคนพอ ๆ กัน = **ไม่เดา** ปล่อยให้คนเลือกเอง ดีกว่านับยอดผิดทีม */
function matchCrew(name, crewRows) {
  const k = nameKey(name);
  if (!k) return null;
  const exact = crewRows.find(c => nameKey(c.name) === k);
  if (exact) return { shift: exact.shift, name: exact.name, distance: 0 };
  if (k.length < 6) return null;                   // ชื่อสั้นเกินไป เดาแล้วเสี่ยงชนคนอื่น
  const scored = crewRows.map(c => ({ c, d: editDistance(k, nameKey(c.name)) }))
    .filter(x => x.d <= 2).sort((a, b) => a.d - b.d);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].d === scored[1].d) return null;   // ก้ำกึ่ง = ไม่เดา
  return { shift: scored[0].c.shift, name: scored[0].c.name, distance: scored[0].d };
}
// เดาว่าผู้ใช้แต่ละคนอยู่ทีมกะไหน จากรายชื่อ shift_crew (เติมให้เฉพาะคนที่ยังไม่ได้ตั้ง)
async function autoLinkOperatorShifts() {
  try {
    const [ops, crew] = await Promise.all([
      dbAll('SELECT name, shift FROM operators', []),
      dbAll('SELECT shift, name FROM shift_crew WHERE active = 1', []),
    ]);
    let n = 0;
    for (const o of ops) {
      if (o.shift) continue;                       // คนตั้งไว้เองแล้ว ห้ามทับ
      const guess = matchCrew(o.name, crew);
      if (guess) { await db.exec('UPDATE operators SET shift = ? WHERE name = ?', [guess.shift, o.name]); n += 1; }
    }
    if (n) console.log(`[db] ผูกผู้ใช้เข้าทีมกะอัตโนมัติ ${n} คน`);
  } catch (e) { console.error('[db] autoLinkOperatorShifts failed', e.message); }
}

// ⚠️ DEFAULT_SKUS ถูกถอดออก 2026-08-07 พร้อมกับชีตจับคู่ทำมือ (121Xch…)
//    เหตุผล: มันเป็น "แหล่งความจริงที่ 3" ที่ขัดกับชีตหลัก — ชื่อไม่ตรงกัน (Syrup 1.8 vs Syrup1.8)
//    และถูก seed ใหม่ทุกครั้งที่บูต ทำให้ลบทิ้งไม่ได้จริง
//    รายการสินค้าตอนนี้มาจากชีตหลักทางเดียว: POST /api/sku/import-all → ตรวจในแท็บ "SKU รอตรวจสอบ"

async function initDb() {
  for (const ddl of SCHEMA) await db.exec(ddl);
  // migration: เพิ่มคอลัมน์ brix/ph ให้ production_logs (สำหรับ DB เดิมที่สร้างก่อนมีคอลัมน์นี้)
  for (const col of ['brix', 'ph']) {
    try { await db.exec(`ALTER TABLE production_logs ADD COLUMN ${col} REAL`); }
    catch { /* มีคอลัมน์อยู่แล้ว — ข้าม */ }
  }
  // migration: คอลัมน์งานมอบหมายรายบุคคลใน daily_tasks (assignee/location/priority/handoff_from)
  // audit_batch: NULL = งานปกติ | ไม่ NULL = มาจากใบตรวจ (ค่า = id ของการส่ง 1 ครั้ง → จัดกลุ่ม "ใบตรวจ 1 ใบ")
  // แยกจาก source เพราะ source='assigned' ถูกใช้โดย duty board + reminder tick — เปลี่ยนไม่ได้
  // photo_specs: JSON array ป้ายรูปที่ต้องถ่าย เช่น ["ก่อนทำ","หลังทำ"] — คนมอบงานกำหนดตอนมอบ
  // NULL/ว่าง = ["หลังทำ"] (งานเก่าทั้งหมดยังทำงานได้เหมือนเดิม)
  // machine = พื้นที่/เครื่องจักร (พิมพ์เอง) · reporter = คนแจ้ง (เลือกจากทีม)
  for (const col of ['assignee', 'location', 'priority', 'handoff_from', 'images', 'done_images', 'done_by', 'audit_batch', 'photo_specs', 'machine', 'reporter']) {
    try { await db.exec(`ALTER TABLE daily_tasks ADD COLUMN ${col} TEXT`); }
    catch { /* มีคอลัมน์อยู่แล้ว — ข้าม */ }
  }
  // migration (KM): รูปแนบของเหตุการณ์ — JSON array ของ URL (Supabase Storage)
  //   images = รูปตอนเจอปัญหา · result_images = รูปหลังแก้
  //   เก็บ URL อย่างเดียว ไม่เก็บ base64 ลง DB (เคยทำให้ DB บวมมาแล้ว)
  for (const col of ['images', 'result_images']) {
    try { await db.exec(`ALTER TABLE incidents ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  // migration (ERP เฟส 3): เวลาที่เครื่องหยุด/กลับมาเดิน — เก็บเป็น 'YYYY-MM-DDTHH:MM' (wall clock BKK)
  //   นาทีที่เสียคำนวณจากสองช่องนี้เสมอ ไม่เก็บซ้ำ (แก้เวลาแล้วตัวเลขตามทันทุกที่)
  //   down_from มีแต่ down_to ว่าง = ยังหยุดอยู่ตอนนี้
  for (const col of ['down_from', 'down_to']) {
    try { await db.exec(`ALTER TABLE incidents ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  /* migration (กระดานซ่อมบำรุงในบอท) — ใบแจ้งซ่อมต้องมีสถานะ/ความเร่งด่วน/คนรับงาน
     priority: 'stop' หยุดไลน์ · 'warn' ยังเดินได้แต่มีปัญหา · 'low' ไว้ทำตอนว่าง
     status เดิมมีแค่ open/closed → เพิ่มค่า 'wip' (ช่างรับงานแล้ว กำลังซ่อม) ไม่ต้องแก้ชนิดคอลัมน์
     card_chat_id/card_msg_id = การ์ดในกลุ่ม Telegram ของใบนี้ ไว้แก้ข้อความเดิมเวลาสถานะเปลี่ยน
       (แก้การ์ดใบเดิมแทนการโพสต์ใหม่ ทีมผลิตจะได้ไม่ต้องไล่หาว่าอันไหนล่าสุด)              */
  for (const col of ['priority', 'assignee', 'card_chat_id', 'card_msg_id']) {
    try { await db.exec(`ALTER TABLE incidents ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  /* migration: การ์ดในกลุ่มเป็นข้อความหรือรูป — 'photo' = การ์ด PNG (ของใหม่ 6 ก.ย.) · NULL/'text' = ของเดิม
     ⚠️ ต้องจำไว้ที่แถว ไม่ใช่เดาจาก canRenderCard() ตอนแก้ — Telegram แก้ข้อความเป็นรูปข้ามชนิดไม่ได้
        การ์ดที่โพสต์ไปแล้วก่อนอัปเดตยังต้องแก้แบบข้อความไปตลอดอายุของมัน                      */
  for (const col of ['card_kind']) {
    try { await db.exec(`ALTER TABLE incidents ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  /* migration: ที่มาของใบ + กุญแจกันเปิดซ้ำ
     source: 'web' หน้าเว็บ · 'bot' wizard แจ้งซ่อมในบอท · 'ai' ระบบเฝ้าคุณภาพอัตโนมัติ
             · 'amsheet' ใบเช็ก AM รายกะ · 'runcheck' เช็กลิสต์รอบเดินเครื่อง
     ref_key: กุญแจ 1 ต่อ 1 กับต้นทาง เช่น 'am:Line ต้ม 2:am31' — ใบเช็ก AM ใบเดิมจะได้ไม่เปิดซ้ำ
     ⚠️ ยังไม่ใส่ UNIQUE index — กติกาจริงคือ "เจอซ้ำให้ต่อในใบเดิม" (UPDATE) ไม่ใช่ปฏิเสธ
        และบน Postgres ค่า '' ซ้ำไม่ได้แต่ NULL ซ้ำได้ ใส่ตอนนี้จะเป็นระเบิดเวลา            */
  for (const col of ['source', 'ref_key']) {
    try { await db.exec(`ALTER TABLE incidents ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  /* backfill ที่มาของใบเก่า — เดาไม่ได้ก็ปล่อย NULL ดีกว่าเดาผิด (UI ไม่โชว์ชิปที่มา)
     ใบจากบอทพิสูจน์ได้จาก card_chat_id · ใบจากระบบเฝ้าคุณภาพพิสูจน์ได้จากชื่อผู้บันทึก
     เงื่อนไข source IS NULL ทำให้รันซ้ำกี่รอบก็ no-op                                    */
  try {
    await db.exec("UPDATE incidents SET source = 'bot' WHERE source IS NULL AND card_chat_id IS NOT NULL");
    await db.exec("UPDATE incidents SET source = 'ai' WHERE source IS NULL AND operator = 'ระบบตรวจอัตโนมัติ'");
  } catch (e) { console.error('[migrate] backfill incidents.source', e.message); }
  /* migration: ความถี่ของงานรูทีน — ไม่ใช่ทุกงานทำทุกวัน (เดิมกระดานนับรวมหมดเลยดู "ค้าง" ตลอด)
     'daily' ทุกวัน · 'weekly' ทุกสัปดาห์ · 'monthly' ทุกเดือน · 'quarterly' ทุก 3 เดือน
     'onuse' เมื่อใช้งานเครื่องนั้น · 'onissue' เมื่อมีปัญหาเท่านั้น (ไม่ขึ้นกระดานเอง)
     NULL = งานเก่าที่ยังไม่ได้ตั้ง → ถือเป็น 'daily' เหมือนพฤติกรรมเดิม ไม่ทำให้ของเก่าเปลี่ยน   */
  try { await db.exec('ALTER TABLE duty_routines ADD COLUMN freq TEXT'); } catch { /* มีแล้ว */ }
  /* migration: ผูกบัญชี Telegram กับคนในทีม — ใช้ตัดสินว่า "คนกดปุ่มนี้เป็นช่างไหม"
     ปุ่มรับงาน/ปิดงานต้องล็อกเฉพาะช่าง เพราะกลุ่มมีทีมผลิตอยู่ด้วย                        */
  try { await db.exec('ALTER TABLE duty_people ADD COLUMN tg_user_id TEXT'); } catch { /* มีแล้ว */ }
  // migration: ความเร่งด่วนของร่างใบแจ้งซ่อมที่กำลังกรอกอยู่
  try { await db.exec('ALTER TABLE tg_incident_draft ADD COLUMN priority TEXT'); } catch { /* มีแล้ว */ }

  // migration (KM): ที่อยู่ไฟล์โน้ตของเครื่องจักรใน vault — ใช้ย้าย/ลบไฟล์เก่าตอนเปลี่ยนชื่อเครื่อง
  try { await db.exec('ALTER TABLE machines ADD COLUMN vault_path TEXT'); } catch { /* มีแล้ว */ }
  // migration (ERP เฟส 3): ค่าเสียโอกาสต่อชั่วโมงของเครื่องนี้ (ว่าง = ใช้ค่ากลางจาก cost_config)
  try { await db.exec('ALTER TABLE machines ADD COLUMN downtime_cost REAL'); } catch { /* มีแล้ว */ }
  /* migration (Machine Hub): จัดหมวด + ชื่อที่โชว์ + คีย์สั้น
     🔴 name ยังเป็น join key เดิม ห้ามเปลี่ยน — duty_routines.machine / incidents.machine /
        daily_tasks.machine / ชื่อไฟล์โน้ตใน vault / [[wikilink]] อ้างอยู่ทั้งหมด
        ชื่อสวยที่เอาไว้โชว์ ("เครื่องบรรจุ L2") อยู่ใน label ไม่ใช่ name ("ไลน์ L2")
     mkey = คีย์สั้นที่ตรงกับผลของ normMachine() — ใช้จับ [L2] ในแผนบรรจุเข้ากับเครื่อง
            ⚠️ ต้องเป็น NULL ห้ามเป็น '' เพราะมี unique index (NULL หลายตัวไม่ชนกัน แต่ '' ชน)
     pm_net_id = w01..w30 ผูกตรงกับ pm_items.net_id ไม่ต้องเดาจากชื่อ                      */
  for (const [col, type] of [
    ['grp', 'TEXT'],          // line | packer | central | tool
    ['mkey', 'TEXT'],         // boil1..4, icing, sugar, l1..l4, a1..a3, robot, ml300, manual, pail
    ['label', 'TEXT'],
    ['spec', 'TEXT'],
    ['pm_net_id', 'TEXT'],
  ]) {
    try { await db.exec(`ALTER TABLE machines ADD COLUMN ${col} ${type}`); } catch { /* มีแล้ว */ }
  }
  /* Machine Hub: รอบเดินเครื่องต้องจำว่า "เกิดจากบรรทัดไหนของแผน"
     คนย้ายเครื่อง/แก้สินค้าแล้วคีย์ UNIQUE เปลี่ยน — ถ้าตามด้วยคีย์นั้นอย่างเดียว ดึงแผนรอบหน้า
     จะสร้างแถวเดิมขึ้นมาซ้ำอีกใบ (เจอตอนทดสอบ: แถว "ไม่รู้ว่าเครื่องไหน" ที่คนเติมเครื่องให้แล้ว) */
  try { await db.exec("ALTER TABLE machine_runs ADD COLUMN plan_key TEXT DEFAULT ''"); } catch { /* มีแล้ว */ }
  /* กฎเตือน: "ปิดใช้" กับ "ลบ" ต้องแยกกัน — ปิดใช้คือ active=0 (ยังเห็นในลิสต์ กดเปิดกลับได้)
     ลบคือ deleted=1 ซ่อนถาวรแต่แถวยังอยู่ เพราะใบเช็กเก่าอ้าง rule_id ไว้ (สำนวนเดียวกับ pm_items) */
  try { await db.exec('ALTER TABLE machine_rules ADD COLUMN deleted INTEGER DEFAULT 0'); } catch { /* มีแล้ว */ }
  // สวิตช์การ์ดเช็กลิสต์เดินเครื่อง — default 0 (ปิด) ตั้งใจให้ต้องเปิดเอง ดูเหตุผลที่ getReportConfig
  try { await db.exec('ALTER TABLE report_config ADD COLUMN run_notify_enabled INTEGER DEFAULT 0'); } catch { /* มีแล้ว */ }
  // seed แถวตั้งค่าต้นทุน (แถวเดียว เหมือน report_config)
  try {
    const cc = await dbAll('SELECT id FROM cost_config LIMIT 1', []);
    if (!cc.length) await db.exec('INSERT INTO cost_config (downtime_per_hour, note, updated_at) VALUES (0, ?, ?)',
      ['ยังไม่ได้ตั้งค่าเสียโอกาสต่อชั่วโมง', nowBKK()]);
  } catch { /* ช่างมัน */ }
  // migration (โซนซ่อมบำรุง): ช่องใหม่ของงานประจำตามตารางจริง
  //   machine = เครื่องจักร · goal = เป้าหมาย · owner_role/co_owner_role = บทบาทผู้รับผิดชอบหลัก/รอง
  //   ค่า role: 'mt' Maintenance · 'op' Operate · 'qc' QC · 'pd' พนักงานผลิต (NULL = งานเก่าที่ไม่ได้ระบุ)
  //   method = วิธีการตรวจสอบ (เพิ่มทีหลังคู่กับ AM List — goal เดิมทำหน้าที่ "มาตรฐานการตรวจสอบ" อยู่แล้ว)
  for (const col of ['machine', 'goal', 'owner_role', 'co_owner_role', 'method']) {
    try { await db.exec(`ALTER TABLE duty_routines ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  /* migration: งานรูทีนที่ย้ายไปอยู่ "ใบตรวจ" แทนกระดานเวร
     sheet = 'am' → 45 ข้อของ AM List ที่ต้องบันทึกผล "ปกติ/ไม่ปกติ" รายกะ ซึ่งกระดานเวรทำไม่ได้
       (routine_state เก็บได้แค่ ทำแล้ว/ข้าม และ UNIQUE(state_date,assignee,node_key) = ติ๊กได้วันละครั้ง
        แต่ จ-พฤ มี 3 กะ) → ใบตรวจจริงอยู่ที่ตาราง am_sheets แยกต่างหาก
     person_key = NULL เพราะข้อตรวจพวกนี้เป็นของ "ไลน์+กะ" ไม่ใช่ของบุคคล — ใครเข้ากะไลน์นั้นกรอก
     ⚠️ การตั้ง person_key เป็น NULL กระทบอีก 2 จุดที่กรองด้วย person_key ต้องแก้พร้อมกันเสมอ:
        (1) GET /api/maint/routines — ไม่งั้นทะเบียนงานรูทีนว่างเปล่า
        (2) seedAmListRoutines() guard — ไม่งั้น insert ซ้ำทุกครั้งที่บูต                        */
  try { await db.exec('ALTER TABLE duty_routines ADD COLUMN sheet TEXT'); } catch { /* มีแล้ว */ }
  try {
    await db.exec("UPDATE duty_routines SET sheet = 'am' WHERE node_key LIKE 'am%' AND sheet IS NULL");
    await db.exec("UPDATE duty_routines SET person_key = NULL WHERE sheet = 'am' AND person_key IS NOT NULL");
  } catch (e) { console.error('[migrate] duty_routines.sheet', e.message); }
  // migration: รูปของงานประจำ (หัวข้อหน้าที่)
  // ref_image = "รูปอ้างอิง" ผูกกับหัวข้อ ไม่ใช่รายวัน → ตั้งครั้งเดียวใช้เป็นมาตรฐานทุกวัน
  for (const col of ['ref_image', 'ref_image_by', 'ref_image_at']) {
    try { await db.exec(`ALTER TABLE duty_routines ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  // done_image = "รูปหลังทำ" รายวัน เปลี่ยนทับได้ตลอด
  for (const col of ['done_image', 'done_image_at']) {
    try { await db.exec(`ALTER TABLE routine_state ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  // migration: ให้บอทรอรับรูปของ "งานประจำ" ได้ด้วย (เดิมรองรับแค่งานมอบหมายที่อ้างด้วย task_id)
  // มี node_key = โหมดงานประจำ · ไม่มี = โหมดงานมอบหมายเดิม
  for (const col of ['node_key', 'node_owner']) {
    try { await db.exec(`ALTER TABLE tg_photo_wait ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  // migration: เก็บ JSON โครงสร้างส่งกะ (สำหรับ "คัดลอกจากกะก่อน")
  try { await db.exec('ALTER TABLE handover_notes ADD COLUMN data TEXT'); } catch { /* มีแล้ว */ }
  try { await db.exec("ALTER TABLE handover_notes ADD COLUMN kind TEXT DEFAULT 'out'"); } catch { /* มีแล้ว */ }
  // migration: ส่งรายงานอัตโนมัติตอนสิ้นกะ (ตามตารางกะจริง)
  try { await db.exec('ALTER TABLE report_config ADD COLUMN auto_at_shift_end INTEGER DEFAULT 0'); } catch { /* มีแล้ว */ }
  // migration (เฟส 1): เปิด/ปิดการวิเคราะห์สิ้นกะอัตโนมัติของผู้ช่วย AI (เปิดเป็นค่าเริ่มต้น)
  try { await db.exec('ALTER TABLE report_config ADD COLUMN shift_analysis_enabled INTEGER DEFAULT 1'); } catch { /* มีแล้ว */ }
  // migration (KPI report เฟส 2): เปิด/ปิดสรุป KPI รายสัปดาห์/รายเดือนเข้า Telegram
  try { await db.exec('ALTER TABLE report_config ADD COLUMN kpi_weekly_enabled INTEGER DEFAULT 0'); } catch { /* มีแล้ว */ }
  try { await db.exec('ALTER TABLE report_config ADD COLUMN kpi_monthly_enabled INTEGER DEFAULT 0'); } catch { /* มีแล้ว */ }
  // migration (KPI report เฟส 4): แจ้งเตือนเฉพาะจุดต้องระวัง (exception-based)
  try { await db.exec('ALTER TABLE report_config ADD COLUMN kpi_alert_enabled INTEGER DEFAULT 0'); } catch { /* มีแล้ว */ }
  // เฝ้าค่าคุณภาพ: ค่าหลุดสเปก → เปิดเหตุการณ์ให้อัตโนมัติ (แผน KM ข้อ 5) — ปิดไว้ก่อนเป็นค่าเริ่มต้น
  try { await db.exec('ALTER TABLE report_config ADD COLUMN quality_watch_enabled INTEGER DEFAULT 0'); } catch { /* มีแล้ว */ }
  // แจ้งเตือนงาน PM เข้ากลุ่มช่าง — เปิดไว้ตั้งแต่ต้น (ต่างจาก alert ตัวอื่นที่ default ปิด)
  try { await db.exec('ALTER TABLE report_config ADD COLUMN pm_notify_enabled INTEGER DEFAULT 1'); } catch { /* มีแล้ว */ }
  try { await db.exec('ALTER TABLE report_config ADD COLUMN kpi_alert_streak_days INTEGER DEFAULT 2'); } catch { /* มีแล้ว */ }
  try { await db.exec('ALTER TABLE report_config ADD COLUMN kpi_alert_cip_stale_hours INTEGER DEFAULT 30'); } catch { /* มีแล้ว */ }
  // migration (ERP เฟส 1): สิทธิ์ผู้ใช้ — 'operator' | 'supervisor' | 'admin'
  //   เดิมทุกคนเท่ากันหมด (มีแต่ PIN) → ไม่มีทางบอกได้ว่าใครมีสิทธิ์อนุมัติอะไร
  try { await db.exec("ALTER TABLE operators ADD COLUMN role TEXT DEFAULT 'operator'"); } catch { /* มีแล้ว */ }
  try { await db.exec("UPDATE operators SET role = 'operator' WHERE role IS NULL OR role = ''"); } catch { /* ช่างมัน */ }
  // seed รายชื่อ operator (idempotent — ไม่ลบของเดิมเพื่อไม่ให้ข้อมูลหายตอน restart)
  for (const [name, pin, role] of DEFAULT_OPERATORS) {
    await db.exec("INSERT INTO operators (name, pin, role) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING", [name, pin, role]);
  }
  // ต้องมี admin อย่างน้อย 1 คนเสมอ ไม่งั้นไม่มีใครแก้สิทธิ์ได้เลย (ล็อกตัวเองออกจากระบบ)
  try {
    const admins = await dbAll("SELECT name FROM operators WHERE role = 'admin'", []);
    if (!admins.length) await db.exec("UPDATE operators SET role = 'admin' WHERE name = ?", [DEFAULT_OPERATORS[0][0]]);
  } catch { /* ช่างมัน */ }
  // migration: ผูกผู้ใช้เข้ากับทีมกะ (กะ1/กะ2/กะ3) — ทำให้รู้ว่ายอดที่คนนี้ลงเป็นผลงานของกะไหน
  //   เดิมต้องเดาจากชื่อ ซึ่งใช้ไม่ได้จริงเพราะ operators กับ shift_crew สะกดไม่ตรงกัน 3 ใน 4 คน
  //   (ศราวุติ/ศราวุธ · พัฒพริศ/พัฒน์พริศร์ · สุวรรณวงค์/สุวรรณวงศ์)
  try { await db.exec('ALTER TABLE operators ADD COLUMN shift TEXT'); } catch { /* มีแล้ว */ }
  await autoLinkOperatorShifts();
  // migration: คอลัมน์แจ้งเตือนล่วงหน้าใน daily_tasks (วันที่ทำ/เตือนล่วงหน้า → Telegram)
  for (const [col, type] of [['remind_at', 'TEXT'], ['remind_lead', 'TEXT'], ['reminded', 'INTEGER DEFAULT 0']]) {
    try { await db.exec(`ALTER TABLE daily_tasks ADD COLUMN ${col} ${type}`); } catch { /* มีแล้ว */ }
  }
  // seed แถวตั้งค่ารายงาน (แถวเดียว)
  const cfg = await dbAll('SELECT id FROM report_config LIMIT 1', []);
  if (!cfg.length) await db.exec("INSERT INTO report_config (auto_enabled, times, weekdays, only_if_pending, updated_at) VALUES (0, '[]', '[1,2,3,4,5]', 0, ?)", [nowBKK()]);
  // migration: แยกทีมกะ (kind='shift') ออกจากผู้รับผิดชอบใบตรวจ (kind='audit') — กันคน audit ปนใน duty board รายวัน
  try { await db.exec("ALTER TABLE duty_people ADD COLUMN kind TEXT DEFAULT 'shift'"); } catch { /* มีแล้ว */ }
  // seed รายชื่อ + เช็กลิสต์ duty board (ครั้งแรกที่ตารางว่าง) — ย้ายจาก hardcode
  await seedDutyBoard();
  // seed ผู้รับผิดชอบใบตรวจ + กฎแบ่งงานอัตโนมัติ (idempotent)
  await seedAuditBoard();
  // seed ทีมซ่อมบำรุง + งานประจำ 34 รายการจากตารางจริง (idempotent)
  await seedMaintBoard();
  // seed เช็คลิสต์ AM List 45 รายการ (ถอดจากเอกสาร Line ต้ม 1/2/3, idempotent)
  await seedAmListRoutines();
  // seed ชื่อพ้อง + เครื่องจักรที่แผน PM อ้างถึงแต่ยังไม่มีในทะเบียน (idempotent)
  await seedPmMachines();
  // seed หมวด/ชื่อที่โชว์/คีย์สั้น ให้เครื่องในทะเบียน + ชื่อพ้องฝั่งเครื่องบรรจุ (idempotent)
  await seedMachineGroups();
  await seedMachineRules();
  // migration (ระบบลงยอดผลิต): เตรียมคอลัมน์สิทธิ์ไว้ก่อน — ยังไม่บังคับใช้จนถึงเฟส 3
  try { await db.exec("ALTER TABLE operators ADD COLUMN role TEXT DEFAULT 'operator'"); } catch { /* มีแล้ว */ }
  // batch_id: ผูกรายงานเข้ากับชุดของกะ — NULL = รายงานเดี่ยวแบบเดิม (ลิงก์เก่ายังใช้ได้)
  try { await db.exec('ALTER TABLE production_reports ADD COLUMN batch_id TEXT'); } catch { /* มีแล้ว */ }
  // migration (เฟส 2): ทางเข้า Telegram + วงจร "ส่งกลับแก้" + คลังกดรับทราบใน LINE
  //   telegram_*  = ผูกรายงานกับคนที่ลงยอดในแชท เพื่อเด้งกลับไปหาคนเดิมได้
  //   fix_*       = ประวัติการถูกส่งกลับแก้ (ห้าม insert แถวใหม่ — แก้ที่แถวเดิมเสมอ)
  //   wh_ack_*    = คลังกด "รับทราบ" บนการ์ด LINE หลังหัวหน้าอนุมัติ
  for (const [col, type] of [
    ['telegram_user_id', 'TEXT'], ['telegram_chat_id', 'TEXT'],
    ['fix_note', 'TEXT'], ['fix_count', 'INTEGER DEFAULT 0'],
    ['wh_ack_at', 'TEXT'], ['wh_ack_by', 'TEXT'],
    ['line_pushed_at', 'TEXT'], ['line_push_error', 'TEXT'],
  ]) {
    try { await db.exec(`ALTER TABLE production_reports ADD COLUMN ${col} ${type}`); } catch { /* มีแล้ว */ }
  }
  // migration (เฟส 3): หัวหน้าตรวจก่อนถึงจะไปคลัง
  //   reviewed_* = หัวหน้ากด "ตรวจแล้ว" รายตัว (ต้องครบทุกรายการในชุดถึงจะส่งคลังได้)
  //   edited_*   = หัวหน้าแก้ค่าเองก่อนส่งคลัง — เก็บไว้ให้รู้ว่าเลขถูกแตะโดยใคร
  // ล็อกหลังส่งคลัง: แก้ได้เฉพาะตอน status='pending_review' เท่านั้น เพราะคลังนับเทียบกับเลขชุดที่ส่งไป
  for (const [col, type] of [
    ['reviewed_at', 'TEXT'], ['reviewed_by', 'TEXT'],
    ['edited_at', 'TEXT'], ['edited_by', 'TEXT'], ['edit_count', 'INTEGER DEFAULT 0'],
  ]) {
    try { await db.exec(`ALTER TABLE production_reports ADD COLUMN ${col} ${type}`); } catch { /* มีแล้ว */ }
  }
  for (const col of ['reviewed_at', 'reviewed_by']) {
    try { await db.exec(`ALTER TABLE production_batches ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  // เฟส 3 ข้อ 6: กันเตือนสิ้นกะซ้ำ — UNIQUE(work_day, shift) ทำให้ INSERT ชนะได้ครั้งเดียว
  // ใช้ INSERT แทน flag เพราะ scheduler เช็คทุก 60 วิ และอาจมีหลาย instance พร้อมกัน
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS spp_shift_nudge (
        id ${db.pk}, work_day TEXT, shift TEXT, sent_at TEXT, UNIQUE(work_day, shift))`);
  } catch { /* มีแล้ว */ }
  // migration: ผล sync บทความเข้า Obsidian vault
  //   vault_path = ที่อยู่ไฟล์ล่าสุดที่เขียนสำเร็จ — ใช้ตามไปลบ/ย้ายตอนเปลี่ยน slug หรือถอนเผยแพร่
  //   vault_error = เหตุผลที่ sync ไม่ผ่านครั้งล่าสุด (NULL = ผ่าน) เอาไว้โชว์ในกล่อง Obsidian
  for (const col of ['vault_path', 'vault_synced_at', 'vault_error']) {
    try { await db.exec(`ALTER TABLE posts ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
  // migration (เฟส 2): review_note = เหตุผลที่ SKU ตัวนี้ยังเปิดใช้ไม่ได้ (คิวรอตรวจหลัง import ทั้งชีต)
  try { await db.exec('ALTER TABLE sku_master ADD COLUMN review_note TEXT'); } catch { /* มีแล้ว */ }
  // pallet_route: 1/NULL = สายพาน → robot จัดเรียงพาเลท (คลังเห็นของเอง) · 2 = พนักงานบรรจุจัดเรียงเอง
  // สาย 2 คลังมองไม่เห็นของที่ค้างพาเลท → บอทต้องบังคับแนบรูปค้างพาเลท
  // ไม่ใส่ DEFAULT เพื่อให้ NULL = "ยังไม่เคยตั้ง" — seed ข้างล่างจะแตะเฉพาะแถวที่ยัง NULL (แก้เองแล้วไม่ถูกทับ)
  try { await db.exec('ALTER TABLE sku_master ADD COLUMN pallet_route INTEGER'); } catch { /* มีแล้ว */ }
  await seedPalletRoutes();
  // index สำหรับหน้าค้นย้อนหลัง (เฟส 2) — ข้อมูลสะสมข้ามเดือนแล้ว scan ทั้งตารางจะช้าขึ้นเรื่อย ๆ
  for (const ix of [
    'CREATE INDEX IF NOT EXISTS ix_prod_reports_work_day ON production_reports (work_day)',
    'CREATE INDEX IF NOT EXISTS ix_prod_reports_sku ON production_reports (sku_keyword)',
    'CREATE INDEX IF NOT EXISTS ix_prod_reports_status ON production_reports (status)',
    'CREATE INDEX IF NOT EXISTS ix_prod_events_report ON production_report_events (report_id)',
    // Machine Hub — mkey ต้อง unique เพราะใช้จับ [L2] จากแผนบรรจุเข้าเครื่องตัวเดียว
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_machines_mkey ON machines (mkey)',
    'CREATE INDEX IF NOT EXISTS ix_machine_links_packer ON machine_links (packer_name)',
    'CREATE INDEX IF NOT EXISTS ix_link_products_link ON machine_link_products (link_id)',
    'CREATE INDEX IF NOT EXISTS ix_machine_runs_day ON machine_runs (work_day)',
    'CREATE INDEX IF NOT EXISTS ix_run_checks_run ON run_checks (run_id)',
    'CREATE INDEX IF NOT EXISTS ix_run_check_items_chk ON run_check_items (check_id)',
  ]) {
    try { await db.exec(ix); } catch (e) { console.error('[db] index failed', e.message); }
  }
  // ── เลิกจับคู่ด้วย plan_flavor ถาวร (2026-08-07) ──────────────────────────
  // plan_flavor มาจากชีตจับคู่ทำมือที่ยกเลิกไปแล้ว และเป็นตัวที่ผูก "Syrup800" ไว้กับ SKU ของ Linear#4
  // ตอนนี้จับคู่ผ่าน sku_alias อย่างเดียว — ล้างค่าเก่าทิ้งให้เด็ดขาด ไม่งั้นมันจะแอบชนะ alias ที่คนตั้งเอง
  // idempotent: รันซ้ำกี่รอบก็ได้ (รอบหลัง ๆ ไม่มีแถวให้แตะ)
  try {
    const r = await db.exec("UPDATE sku_master SET plan_flavor = '' WHERE plan_flavor IS NOT NULL AND plan_flavor <> ''");
    if (r.rowCount) console.log(`[db] ล้าง plan_flavor เก่า ${r.rowCount} แถว (ใช้ sku_alias แทน)`);
  } catch (e) { console.error('[db] clear plan_flavor failed', e.message); }
  try { await db.exec('CREATE INDEX IF NOT EXISTS ix_sku_alias_norm ON sku_alias (alias_norm)'); }
  catch (e) { console.error('[db] alias index failed', e.message); }

  // ⚠️ ไม่ seed SKU ตั้งต้นอีกแล้ว — DEFAULT_SKUS 16 ตัวถูกถอดออกพร้อมชีตจับคู่ทำมือ
  //    รายการสินค้ามาจากชีตหลักทางเดียวผ่าน POST /api/sku/import-all เท่านั้น
  for (let i = 0; i < DEFAULT_SHIFT_CREW.length; i++) {
    const [sh, nm] = DEFAULT_SHIFT_CREW[i];
    await db.exec(
      "INSERT INTO shift_crew (shift, name, sort_order) VALUES (?, ?, ?) ON CONFLICT (shift, name) DO NOTHING",
      [sh, nm, i]
    );
  }
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

/* ══════════ บอท Telegram หลายตัวในแอปเดียว ══════════
   ปัญหาเดิม: ตัวส่ง Telegram ทุกตัวอ่าน TELEGRAM_BOT_TOKEN แบบตายตัว → มีบอทได้ตัวเดียว
   วิธีแก้: จำ "บอทที่กำลังคุยอยู่" ไว้ใน AsyncLocalStorage แล้วให้ตัวส่งทุกตัวอ่านจากตรงนั้น
   ไม่ได้อยู่ในบริบทของบอทไหน = บอทหลัก (ของเดิม) → ทุกจุดที่มีอยู่พฤติกรรมไม่เปลี่ยนเลย
   ยังไม่ตั้ง env ของบอทซ่อมบำรุง → fallback ไปบอท/กลุ่มเดิม เพื่อไม่ให้ของที่ใช้อยู่เงียบ    */
const TG_BOTS = {
  main: { token: () => process.env.TELEGRAM_BOT_TOKEN, chat: () => process.env.TELEGRAM_CHAT_ID },
  maint: {
    token: () => process.env.MAINT_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
    chat: () => process.env.MAINT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
  },
};
const botCtx = new AsyncLocalStorage();
const curBot = () => TG_BOTS[botCtx.getStore()] || TG_BOTS.main;
const tgToken = () => curBot().token();
const tgChatId = () => curBot().chat();
// กำลังทำงานในนามบอทซ่อมบำรุงอยู่ไหม — ใช้เลือกว่าจะโชว์กระดานไหน/ถามความเร่งด่วนไหม
const onMaintBot = () => botCtx.getStore() === 'maint';
// รันโค้ดชุดหนึ่ง "ในนามบอทตัวที่ระบุ" — ตัวส่งข้างในทุกตัวจะใช้ token/chat ของบอทนั้นเอง
// (บริบทติดข้าม await ไปเองทั้งสาย ไม่ต้องส่งพารามิเตอร์ผ่าน 60 กว่าจุด)
const runAsBot = (name, fn) => botCtx.run(TG_BOTS[name] ? name : 'main', fn);

/* ปลายทางแจ้งเตือน: เรื่องไหนเข้ากลุ่มไหน — แก้ที่นี่ที่เดียว
   'maint' = กลุ่มซ่อมบำรุง · 'main' = กลุ่มผลิตเดิม
   (ยังไม่ตั้ง env ของบอทซ่อมบำรุง → 'maint' ตกไปกลุ่มเดิมอยู่ดี ปลอดภัย)                */
const NOTIFY_ROUTE = {
  duty: 'maint',      // กระดานงานประจำ/งานมอบหมาย · เตือนงาน · ย้ายงาน · การ์ดก่อน-หลัง
  audit: 'main',      // งานที่มาจาก "พื้นที่รับผิดชอบ" (ใบตรวจ) — คนทำคือทีมผลิต → กลุ่มผลิตเดิม
  material: 'maint',  // วัสดุใกล้หมด
  incident: 'maint',  // เหตุการณ์ + ค่าหลุดสเปกเปิดเหตุการณ์ให้
  sop: 'maint',       // คู่มือ/SOP รออนุมัติ
  pm: 'maint',        // แผน PM รายสัปดาห์ (จันทร์เปิดสัปดาห์ · ศุกร์ตามที่ยังไม่ปิด)
  production: 'main', // ยอดผลิต · CIP · KPI · ส่ง/รับกะ · ผู้ช่วย AI
  runcheck: 'maint',  // เช็กลิสต์เดินเครื่อง (กฎเตือนของทะเบียนเครื่องจักร) — คนทำคือช่าง/พนักงานหน้าเครื่อง
};
// ส่งข้อความตามหัวข้อ — ใช้แทน sendToTelegram ตรง ๆ ในจุดที่ต้องเลือกกลุ่ม
const notify = (topic, ...args) => runAsBot(NOTIFY_ROUTE[topic] || 'main', () => sendToTelegram(...args));
// ใช้ห่อโค้ดหลายบรรทัด (เช่นส่งรูป+ข้อความ) ให้ทั้งก้อนไปกลุ่มเดียวกัน
const inTopic = (topic, fn) => runAsBot(NOTIFY_ROUTE[topic] || 'main', fn);
/* งานใน daily_tasks / งานประจำ ควรแจ้งเข้ากลุ่มไหน — ตัดสินจาก "ใครเป็นคนทำ"
     · มาจากใบตรวจ (มี audit_batch) → กลุ่มผลิตเสมอ (ตกลงไว้ 26 ส.ค.)
     · ไม่ใช่ใบตรวจ → ผู้รับเป็นช่างในทีมซ่อมบำรุง = กลุ่มช่าง · เป็นทีมผลิต = กลุ่มผลิต
   ใช้ทั้งสาย: ตอนมอบหมาย · ตอนเตือน · ตอนย้ายงาน · การ์ดก่อน-หลังตอนทำเสร็จ
   ⚠️ เดิมเหมาว่า "งานมอบหมายทั้งหมด = งานช่าง" ซึ่งจริงตอนทีมช่างมีคนเดียว — ไม่จริงแล้ว
      ทำให้ "จ่ายงาน" จากกระดานเวรทีมผลิตไปโผล่กลุ่มช่าง (เจอตอนใช้จริง 27 ส.ค.)          */
const dutyTopic = (auditBatch, assignee) => {
  if (auditBatch) return 'audit';
  return isMaintPerson(assignee) ? 'duty' : 'production';
};

const sendToTelegram = async (message) => {
  const token = tgToken();
  const chatId = tgChatId();
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
  const token = tgToken();
  if (!token) { console.log(`[TG] ${method} skipped (no token)`); return null; }
  try { const r = await axios.post(`https://api.telegram.org/bot${token}/${method}`, payload); return r.data; }
  catch (e) { console.error(`[TG] ${method} error`, e.response?.data || e.message); return null; }
};

/* เรียก Telegram Bot API แบบแนบไฟล์ (multipart) — คู่กับ tgApi ที่ส่ง JSON ล้วน
   ใช้กับ sendPhoto/editMessageMedia ที่ต้องอัปโหลด buffer จากเครื่องเรา
   fields = ค่าธรรมดา (ค่าที่เป็น object จะถูก JSON.stringify ให้ ตามที่ Telegram ต้องการ)
   file   = { field, buffer, filename } → อ้างถึงใน media ด้วย `attach://<field>`
   ⚠️ อ่าน token จาก tgToken() เหมือน tgApi → ต้องเรียกใต้ runAsBot/inTopic ไม่งั้นตกไปบอทหลัก */
const tgApiForm = async (method, fields, file) => {
  const token = tgToken();
  if (!token) { console.log(`[TG] ${method} skipped (no token)`); return null; }
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) continue;
      form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    if (file) form.append(file.field, file.buffer, { filename: file.filename, contentType: 'image/png' });
    const r = await axios.post(`https://api.telegram.org/bot${token}/${method}`, form, {
      headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
    return r.data;
  } catch (e) { console.error(`[TG] ${method} error`, JSON.stringify(e.response?.data) || e.message); return null; }
};

// ── ช่องทาง Telegram ของระบบลงยอดผลิต (SPP) ────────────────────────────────
// แยกบอท/กลุ่มออกจากบอท CIP-duty: คนละเรื่อง คนละกลุ่มผู้รับ และบอท SPP ต้องเป็นเจ้าของ
// webhook ที่ /api/telegram/spp-update เอง (Telegram ให้บอทละ 1 webhook)
// ยังไม่ตั้ง env → fallback ไปบอท/กลุ่มเดิม เพื่อให้ของที่ใช้อยู่ไม่พังก่อนตั้งค่าบน Render
const sppBotToken = () => process.env.SPP_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const sppChatId = () => process.env.SPP_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

const sppTg = async (method, payload) => {
  const token = sppBotToken();
  if (!token) { console.log(`[SPP-TG] ${method} skipped (no token)`); return null; }
  try { const r = await axios.post(`https://api.telegram.org/bot${token}/${method}`, payload); return r.data; }
  catch (e) { console.error(`[SPP-TG] ${method} error`, e.response?.data || e.message); return null; }
};

// ชื่อบอท — ใช้ดูว่าในกลุ่มมีคนพิมพ์ @ชื่อบอท ไหม · ถามครั้งเดียวแล้วจำไว้
let _sppBotUsername = null;
const sppBotUsername = async () => {
  if (_sppBotUsername !== null) return _sppBotUsername;
  const r = await sppTg('getMe', {});
  _sppBotUsername = r?.result?.username || '';
  return _sppBotUsername;
};

// คำที่บอกว่าเป็น "คำถามย้อนหลัง" — ใช้ 2 ที่ (คัดว่าคุยกับบอทไหม + เลือกทางใน sppHandleText)
const SPP_QUESTION_RE = /^(ถาม|สรุป)\b|[?？]\s*$|กี่|เท่าไห?ร่|เมื่อวาน|เดือน(นี้|ที่แล้ว|ก่อน)|สัปดาห์|ย้อนหลัง|เฉลี่ย|มากสุด|น้อยสุด|ใครลง/;

// คำสั่งควบคุมบอทที่ไม่ได้ขึ้นต้นด้วย "/" — ต้องทำงานในกลุ่มด้วย
// ⚠️ ที่ต้องมี: กติกาเงียบในกลุ่มดูแค่ "เป็นเรื่องงานไหม" คำพวกนี้เลยเงียบไปด้วย
//    ผลคือคนใช้งานในกลุ่มพิมพ์ "ยกเลิก" หรือ "เปลี่ยนชื่อ" แล้วบอทไม่ตอบอะไรเลย — ตันสนิท
//    (พบ 2026-08-07 · ห้องทำงานจริงเป็นกลุ่ม ไม่ใช่แชทเดี่ยว)
// ต้องเป็น "ทั้งข้อความ" ไม่ใช่แค่ขึ้นต้น (ต่อท้ายด้วยคำสุภาพได้) —
// ไม่งั้นพนักงานคุยกันว่า "ยกเลิกออเดอร์ลูกค้าแล้วนะ" บอทจะเด้งมาตอบกลางวง
// (เข้มกว่าเช็คใน sppHandleText ที่ยอมรับแค่ขึ้นต้น เพราะตรงนั้นรู้แล้วว่าคุยกับบอทอยู่)
const SPP_CONTROL_RE = /^(ยกเลิก|เมนูหลัก|เมนู|เปลี่ยนชื่อ|แก้ชื่อ|ฉันคือใคร|ผมคือใคร)\s*(ครับ|ค่ะ|คะ|นะ|น่ะ)?\s*[!.?]*$/i;

// "ข้อความนี้เป็นเรื่องงานไหม" — ใช้เฉพาะตอนอยู่ในกลุ่ม เพื่อตัดสินว่าจะตอบหรือเงียบ
// เข้มกว่าตอนแชทเดี่ยวตั้งใจ: ในกลุ่มมีคนคุยกันทั้งวัน แค่ "มีตัวเลข" ไม่พอ ต้องมีคำของงานด้วย
const sppLooksLikeWork = (t) =>
  !!t && (looksLikePlanText(t) || SPP_QUESTION_RE.test(t) || /^แผนผลิตวันนี้/.test(t)
    || (/\d/.test(t) && /ได้|กล่อง|กระสอบ|ถุง|ปี๊บ|เครื่อง|เลข/.test(t)));

// ส่งข้อความเข้ากลุ่ม SPP · คืน true เมื่อส่งสำเร็จจริง (ผู้เรียกใช้ตัดสินว่าจะบันทึกว่า "ส่งแล้ว" ไหม)
const sendSppTelegram = async (text, extra = {}) => {
  if (!sppBotToken() || !sppChatId()) { console.error('[SPP-TG] missing token/chatId'); return false; }
  const r = await sppTg('sendMessage', { chat_id: sppChatId(), text, parse_mode: 'HTML', ...extra });
  return !!(r && r.ok);
};

const dataUrlToBuffer = (dataUrl) => {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const [header, b64] = dataUrl.split(',');
  if (!b64) return null;
  const mime = header.replace('data:', '').replace(';base64', '');
  return { buffer: Buffer.from(b64, 'base64'), mimeType: mime };
};

// toChatId: ส่งเข้าแชทที่ระบุ (ปุ่มดูรูปต้องตอบในแชทที่กด) — ไม่ระบุ = กลุ่มหลักเหมือนเดิม
const sendPhotoBufferToTelegram = async (buffer, mimeType, caption, toChatId) => {
  const token = tgToken();
  const chatId = toChatId || tgChatId();
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

// ส่งรูปหลายรูปเป็นอัลบั้มเดียว (sendMediaGroup) — caption อยู่รูปแรก · รับ data URL array
// 0 รูป=ไม่ทำ · 1 รูป=ใช้ sendPhoto เดิม · ≥2=อัลบั้ม (cap 6) · กันพังด้วย try/catch
const sendMediaGroupToTelegram = async (dataUrls, caption) => {
  const token = tgToken();
  const chatId = tgChatId();
  const bufs = (dataUrls || []).map(dataUrlToBuffer).filter(Boolean).slice(0, 6);
  if (!bufs.length) { if (caption) await sendToTelegram(caption); return; }
  if (!token || !chatId) { console.error('[TG Album] missing token/chatId'); return; }
  if (bufs.length === 1) return sendPhotoBufferToTelegram(bufs[0].buffer, bufs[0].mimeType, caption || '');
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    const media = bufs.map((_b, i) => ({ type: 'photo', media: `attach://p${i}`,
      ...(i === 0 && caption ? { caption: caption.slice(0, 1024), parse_mode: 'HTML' } : {}) }));
    form.append('media', JSON.stringify(media));
    bufs.forEach((b, i) => {
      const ext = b.mimeType === 'image/png' ? 'png' : 'jpg';
      form.append(`p${i}`, b.buffer, { filename: `p${i}.${ext}`, contentType: b.mimeType });
    });
    await axios.post(`https://api.telegram.org/bot${token}/sendMediaGroup`, form, {
      headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    console.log(`[TG Album] sent OK (${bufs.length} รูป)`);
  } catch (error) {
    console.error('[TG Album] error:', JSON.stringify(error.response?.data) || error.message);
  }
};

// ส่งรูปด้วย "URL" (Supabase Storage) — Telegram ดึงรูปเองจาก URL (ไม่ต้องโหลดผ่าน server → ประหยัด egress)
const sendPhotoUrlsToTelegram = async (urls, caption) => {
  const token = tgToken();
  const chatId = tgChatId();
  const list = (urls || []).slice(0, 6);
  if (!list.length) { if (caption) await sendToTelegram(caption); return; }
  if (!token || !chatId) { console.error('[TG url] missing token/chatId'); return; }
  try {
    if (list.length === 1) {
      await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`,
        { chat_id: chatId, photo: list[0], caption: (caption || '').slice(0, 1024), parse_mode: 'HTML' });
    } else {
      const media = list.map((u, i) => ({ type: 'photo', media: u,
        ...(i === 0 && caption ? { caption: caption.slice(0, 1024), parse_mode: 'HTML' } : {}) }));
      await axios.post(`https://api.telegram.org/bot${token}/sendMediaGroup`, { chat_id: chatId, media });
    }
    console.log(`[TG url] sent OK (${list.length} รูป)`);
  } catch (error) {
    console.error('[TG url] error:', JSON.stringify(error.response?.data) || error.message);
  }
};

// ตัวส่งรูปรวม: ถ้าเป็น URL ทั้งหมด → ส่งแบบ URL (ประหยัด) · ถ้าเป็น base64 (legacy/fallback) → ส่งแบบ buffer เดิม
const sendPhotosToTelegram = async (items, caption) => {
  const list = (items || []).filter(x => typeof x === 'string' && x);
  if (!list.length) { if (caption) await sendToTelegram(caption); return; }
  if (list.every(x => /^https?:\/\//.test(x))) return sendPhotoUrlsToTelegram(list, caption);
  return sendMediaGroupToTelegram(list, caption);
};

// ส่งรูปเข้าแชทที่ระบุ — รองรับทั้ง URL (Supabase) และ base64 · ใช้กับปุ่ม 🖼 "ดูรูปงาน"
const sendPhotoToChat = async (chatId, image, caption) => {
  if (!image || !chatId) return;
  if (/^https?:\/\//.test(image)) {
    return tgApi('sendPhoto', { chat_id: chatId, photo: image, caption: (caption || '').slice(0, 1024), parse_mode: 'HTML' });
  }
  const b = dataUrlToBuffer(image);
  if (b) return sendPhotoBufferToTelegram(b.buffer, b.mimeType, caption || '', chatId);
};

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
});

// คู่กับ dbAll แต่เอาแถวเดียว — undefined ถ้าไม่เจอ
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
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

// 🔴 เดิมเช็กแค่ PIN ไม่ดูชื่อ — PIN เริ่มต้นเป็น 1234 เหมือนกันทุกคน แปลว่าใครก็ล็อกอิน
//    เป็นใครก็ได้ · ตอนนี้ต้องตรงทั้งชื่อและ PIN (ไม่ส่งชื่อมา = พฤติกรรมเดิมไว้ให้ของเก่าไม่พัง)
app.post('/api/login', async (req, res) => {
  const { name, pin } = req.body || {};
  try {
    const row = name
      ? (await dbAll('SELECT name, role FROM operators WHERE name = ? AND pin = ?', [name, pin]))[0]
      : (await dbAll('SELECT name, role FROM operators WHERE pin = ?', [pin]))[0];
    if (!row) return res.status(401).json({ success: false, message: 'ชื่อหรือ PIN ไม่ถูกต้อง' });
    res.json({ success: true, name: row.name, role: row.role || 'operator' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// รายชื่อผู้ปฏิบัติงาน — ค่าเริ่มต้นคืน "อาร์เรย์ของชื่อ" เหมือนเดิมเป๊ะ (หน้า login เดิมใช้อยู่)
//   ?withRole=1 → คืน [{name, role, hasPin}] สำหรับหน้าจัดการสิทธิ์
app.get('/api/operators', async (req, res) => {
  try {
    const rows = await dbAll('SELECT name, role, pin, shift FROM operators ORDER BY name', []);
    if (req.query.withRole !== '1') return res.json(rows.map(r => r.name));
    const crew = await dbAll('SELECT shift, name FROM shift_crew WHERE active = 1', []);
    res.json({
      operators: rows.map(r => {
        const guess = matchCrew(r.name, crew);
        return {
          name: r.name, role: r.role || 'operator', hasPin: !!r.pin, shift: r.shift || '',
          // ชื่อในรายชื่อทีมกะที่ "น่าจะใช่คนเดียวกัน" — โชว์ให้เห็นว่าสะกดต่างกันตรงไหน
          crewGuess: guess ? { shift: guess.shift, name: guess.name, sameSpelling: guess.distance === 0 } : null,
        };
      }),
      roles: ROLES, shifts: SHIFT_CODES,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── สิทธิ์ผู้ใช้ (ERP เฟส 1) ─────────────────────────────────────────────────
   operator   = ใช้งานหน้างานทั่วไป
   supervisor = อนุมัติงาน/SOP ได้ (ตามแผน KM ข้อ 7)
   admin      = แก้สิทธิ์คนอื่นได้
   การบังคับสิทธิ์จริงมีเฉพาะเส้นในไฟล์นี้ที่เรียก requireRole() — ต้องแนบโทเคนจากหน้า Admin
   (n8n เรียกแค่ /api/assistant · /api/cip-summary · /api/report/tick จึงไม่กระทบ)         */
const ROLES = ['operator', 'supervisor', 'admin'];
const ROLE_RANK = { operator: 1, supervisor: 2, admin: 3 };
const SHIFT_CODES = ['กะ1', 'กะ2', 'กะ3'];   // ตรงกับ shift_crew + ฟอร์มลงยอดผลิต
const newToken = () => require('crypto').randomBytes(24).toString('hex');

// อ่านโทเคนจาก header → คืนแถวใน auth_tokens (null ถ้าไม่มี/ไม่รู้จัก)
async function whoIs(req) {
  const t = req.get('x-spp-token') || '';
  if (!t) return null;
  try { return (await dbAll('SELECT token, name, role FROM auth_tokens WHERE token = ?', [t]))[0] || null; }
  catch { return null; }
}
// middleware: ต้องมีสิทธิ์อย่างน้อยระดับนี้
const requireRole = (min) => async (req, res, next) => {
  const who = await whoIs(req);
  if (!who) return res.status(401).json({ error: 'ต้องเข้าหน้าผู้ดูแลก่อน (ไม่พบสิทธิ์)' });
  if ((ROLE_RANK[who.role] || 0) < ROLE_RANK[min]) {
    return res.status(403).json({ error: `ต้องเป็น ${min} ขึ้นไปถึงจะทำรายการนี้ได้` });
  }
  req.who = who;
  next();
};

// เข้าหน้า Admin — 2 ทาง: (1) ชื่อ+PIN ของตัวเอง ต้องเป็น supervisor ขึ้นไป
//                        (2) รหัสผู้ดูแลระบบจาก env (ทางเดิม กันล็อกตัวเองออก)
// เดิมเทียบรหัสในโค้ดหน้าเว็บ ใครเปิดดูก็เห็น — ย้ายมาเช็กที่เซิร์ฟเวอร์แล้ว
app.post('/api/auth/admin', async (req, res) => {
  const { name, pin, pass } = req.body || {};
  try {
    let who = null;
    if (name && pin) {
      const row = (await dbAll('SELECT name, role FROM operators WHERE name = ? AND pin = ?', [name, pin]))[0];
      if (!row) return res.status(401).json({ error: 'ชื่อหรือ PIN ไม่ถูกต้อง' });
      if ((ROLE_RANK[row.role] || 0) < ROLE_RANK.supervisor) {
        return res.status(403).json({ error: 'บัญชีนี้ยังไม่มีสิทธิ์เข้าหน้าผู้ดูแล — ให้ admin ตั้งสิทธิ์ให้ก่อน' });
      }
      who = { name: row.name, role: row.role };
    } else if (pass != null) {
      const ok = String(pass) === String(process.env.ADMIN_PASS || 'admin1234');
      if (!ok) return res.status(401).json({ error: 'รหัสผู้ดูแลไม่ถูกต้อง' });
      who = { name: 'ผู้ดูแลระบบ', role: 'admin' };
    } else return res.status(400).json({ error: 'ต้องส่งชื่อ+PIN หรือรหัสผู้ดูแล' });

    const token = newToken();
    await db.exec('INSERT INTO auth_tokens (token, name, role, created_at) VALUES (?, ?, ?, ?)',
      [token, who.name, who.role, nowBKK()]);
    // เก็บแค่ 200 โทเคนล่าสุด กันตารางโตไม่รู้จบ
    try { await db.exec('DELETE FROM auth_tokens WHERE token NOT IN (SELECT token FROM auth_tokens ORDER BY created_at DESC LIMIT 200)'); }
    catch { /* ช่างมัน */ }
    res.json({ token, name: who.name, role: who.role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// เพิ่ม/แก้ผู้ใช้ (ชื่อ · PIN · สิทธิ์) — admin เท่านั้น
app.post('/api/operators', requireRole('admin'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const role = ROLES.includes(req.body.role) ? req.body.role : 'operator';
  const pin = req.body.pin == null ? null : String(req.body.pin).trim();
  if (!name) return res.status(400).json({ error: 'ต้องมีชื่อ' });
  if (pin != null && pin !== '' && !/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'PIN ต้องเป็นตัวเลข 4-6 หลัก' });
  try {
    const cur = (await dbAll('SELECT name, role FROM operators WHERE name = ?', [name]))[0];
    if (!cur) {
      await db.exec('INSERT INTO operators (name, pin, role) VALUES (?, ?, ?)', [name, pin || '1234', role]);
    } else {
      // ถอด admin คนสุดท้ายไม่ได้ ไม่งั้นไม่เหลือใครแก้สิทธิ์
      if (cur.role === 'admin' && role !== 'admin') {
        const admins = await dbAll("SELECT name FROM operators WHERE role = 'admin'", []);
        if (admins.length <= 1) return res.status(400).json({ error: 'ต้องเหลือ admin อย่างน้อย 1 คน' });
      }
      await db.exec('UPDATE operators SET role = ?, pin = COALESCE(NULLIF(?, \'\'), pin) WHERE name = ?', [role, pin || '', name]);
    }
    // ทีมกะ: ส่ง shift มา = ตั้งค่า · ส่ง '' = ล้างการผูก · ไม่ส่งเลย = ไม่แตะของเดิม
    if (req.body.shift !== undefined) {
      const sh = String(req.body.shift || '').trim();
      if (sh && !SHIFT_CODES.includes(sh)) return res.status(400).json({ error: 'กะต้องเป็น กะ1 / กะ2 / กะ3' });
      await db.exec('UPDATE operators SET shift = ? WHERE name = ?', [sh || null, name]);
    }
    res.json({ success: true, name, role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/operators/delete', requireRole('admin'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'ต้องมีชื่อ' });
  try {
    const cur = (await dbAll('SELECT role FROM operators WHERE name = ?', [name]))[0];
    if (!cur) return res.status(404).json({ error: 'ไม่พบผู้ใช้นี้' });
    if (cur.role === 'admin') {
      const admins = await dbAll("SELECT name FROM operators WHERE role = 'admin'", []);
      if (admins.length <= 1) return res.status(400).json({ error: 'ลบ admin คนสุดท้ายไม่ได้' });
    }
    await db.exec('DELETE FROM operators WHERE name = ?', [name]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// ── ลงยอดผลิต SPP (ฟอร์มหน้า Admin) ─────────────────────────────
// forward payload ทั้งก้อนไป webhook branch ของ workflow "SPP Production Auto-Submit"
// n8n จะ resolve SKU จาก SKU Sheet → append ลง Pending → แจ้งกลุ่ม Telegram พร้อมปุ่มอนุมัติ/ปฏิเสธ
const SPP_N8N_WEBHOOK_URL = process.env.SPP_N8N_WEBHOOK_URL || 'https://n8n.srv1267366.hstgr.cloud/webhook/spp-web-report';

app.post('/api/production/spp-report', async (req, res) => {
  const p = req.body || {};
  if (!p.sku || !String(p['ชื่อ'] || '').trim()) {
    return res.status(400).json({ error: 'ต้องมี sku และชื่อผู้รายงาน' });
  }
  if (p.actual_box === undefined || p.actual_box === null) {
    return res.status(400).json({ error: 'ต้องมีจำนวนผลิตจริง (actual_box)' });
  }
  try {
    const r = await axios.post(SPP_N8N_WEBHOOK_URL, p, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 25000,
    });
    const reportId = r.data?.report_id || '';
    console.log(`[SPP] report forwarded OK report_id=${reportId} sku=${p.sku}`);
    res.json({ success: true, report_id: reportId });
  } catch (error) {
    console.error('[SPP] forward error:', error.response?.data || error.message);
    res.status(502).json({ error: 'ส่งรายงานไป n8n ไม่สำเร็จ กรุณาลองใหม่ (ตรวจสอบว่า workflow SPP เปิดใช้งานอยู่)' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ระบบลงยอดผลิต (เฟส 1) — "เลขตัวหนึ่งพิมพ์ครั้งเดียวโดยเจ้าของตัวเลข"
//   ฝ่ายผลิตลงยอด → ระบบส่งลิงก์ให้คลังนับ → คลังกรอกเลขของคลัง → หัวหน้าอนุมัติ → ลง Sheet
//   DB เขียนก่อนเสมอ · ไม่มีใครพิมพ์เลขซ้ำ · ทุกก้าวบันทึกลง production_report_events
// ═══════════════════════════════════════════════════════════════════════════
const SPP_N8N_APPROVED_URL = process.env.SPP_N8N_APPROVED_URL || 'https://n8n.srv1267366.hstgr.cloud/webhook/spp-approved-report';
const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || 'https://back-wash-test.vercel.app').replace(/\/+$/, '');
const VERIFY_TTL_HOURS = Number(process.env.SPP_VERIFY_TTL_HOURS || 24);

// เวลาไทยแบบเดียวกับ nowBKK() แต่บวกชั่วโมงได้ — เก็บเป็น string รูปเดียวกันเพื่อเทียบแบบ lexicographic
const bkkPlusHours = (h) =>
  new Date(Date.now() + h * 3600 * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');

// ฟอร์มส่ง 'กะ1/กะ2/กะ3' แต่ shift_plans + ตารางกะภายในใช้ 'กะเช้า/กะบ่าย/กะดึก'
// ถ้าไม่แปลง จะ query แผนไม่เจอแบบเงียบ ๆ
const SHIFT_ALIAS = { 'กะ1': 'กะเช้า', 'กะ2': 'กะบ่าย', 'กะ3': 'กะดึก' };
const normalizeShift = (s) => SHIFT_ALIAS[String(s || '').trim()] || String(s || '').trim();

const logReportEvent = async (reportId, event, actor, detail, channel, role) => {
  // audit ต้องไม่ทำให้ business write ล้ม — กลืน error เสมอ
  try {
    await db.exec(
      `INSERT INTO production_report_events (report_id, event, actor, actor_role, detail, channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [reportId, event, actor || '', role || '', detail || '', channel || '', nowBKK()]
    );
  } catch (e) { console.error('[SPP] event log failed', e.message); }
};

// ═══════════════════════════════════════════════════════════════════════════
// ตัวจับคู่ "ชื่อที่คนเขียน" → "รหัส SKU"  (แก้บั๊กข้อ C + F ของการทดสอบ 2026-08-06)
//
// ชื่อสินค้าตัวเดียวกันมี 3 แบบและไม่มีทางบังคับให้ตรงกัน:
//   1. ชื่อในแผนบรรจุ  — คนจัดแผนตั้งเองให้คนหน้างานอ่านรู้เรื่อง ("Syrup 800×3×4", "ปี๊บ 1×20")
//   2. ชื่อที่พนักงานพิมพ์ในแชท — ย่ออีกแบบ ("Syrup 800")
//   3. ชื่อทางการใน SKU master — ตัวที่ไหลเข้า Google Sheet
// จึงยึด "รหัส SKU" เป็นตัวจริง แล้วให้ sku_alias เป็นสะพานจากชื่อเล่นทุกแบบเข้าหารหัส
//
// ⚠️ กฎเหล็ก: กำกวมเมื่อไหร่ = ถามคน ห้ามเลือกเอง
//    ปล่อยให้เดาแล้วพลาดมาแล้ว 2 แบบ: AI สวมชื่อจาก master ("ปี๊บ 1×20" → "Dilute W-Molass")
//    และชีตทำมือผูก "Syrup800" ไว้กับ SKU ของ Linear#4 ทั้งที่หน้างานเดิน Linear#3
//    ผิดตรงนี้ = ยอดเข้าผิด SKU ใน Google Sheet โดยไม่มีใครรู้
// ═══════════════════════════════════════════════════════════════════════════

// ตัวระบุตัวตนของสินค้า 1 ตัว — ปกติคือรหัส SKU
// แต่ชีตหลักมีสินค้า 13 ตัวที่ "ไม่มีรหัส" (ไซรัปเฟรชชี่ 20kg BIB ฯลฯ) จึงถอยไปใช้ keyword
// ทุกที่ที่เทียบว่า "สินค้าตัวเดียวกันไหม" ต้องผ่านฟังก์ชันนี้ ห้ามเทียบ sku_code ดิบ ๆ
const skuIdOf = (s) => String((s?.sku_code || '').trim() || (s?.keyword || '').trim());

// ยุบข้อความให้เทียบกันได้: ตัวคูณทุกแบบเป็น x · ตัดอักขระที่ไม่ใช่ตัวอักษร/ตัวเลข
// เก็บตัวเลขไว้ทุกตัวเพราะขนาดแพ็ก (800, 3, 4) คือสัญญาณแยกสินค้าที่แรงที่สุด
const normAlias = (s) => String(s || '')
  .toLowerCase()
  .replace(/[×✕✖*]/g, 'x')
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .trim();

// ชื่อเครื่องมาได้หลายแบบ: "Linear#3 (Lina Pack)" · "L3" · "[L3]" · "linear 3" → l3
// คืน '' เมื่อไม่รู้ว่าเครื่องไหน (แปลว่า "ไม่ใช้เครื่องช่วยตัดตัวเลือก")
const normMachine = (s) => {
  const t = String(s || '').toLowerCase();
  const m = t.match(/linear\s*#?\s*(\d+)/) || t.match(/\bl\s*(\d+)\b/);
  if (m) return `l${m[1]}`;
  const a = t.match(/\ba\s*(\d+)\b/);
  if (a) return `a${a[1]}`;
  return '';
};

// ดึงชื่อเครื่องจากข้อความดิบ — regex ล้วน ไม่ผ่าน AI
// ใช้ได้ทั้งกับที่พนักงานพิมพ์ ("เครื่อง Linear#3") และวงเล็บเหลี่ยมในแผน ("[L3+L4]")
const extractMachine = (text) => {
  const t = String(text || '');
  const bracket = t.match(/\[([^\]]+)\]/);
  return normMachine(bracket ? bracket[1] : t);
};

// คะแนนความใกล้เคียงแบบกฎล้วน — ไม่เรียก AI ไม่มีค่าใช้จ่าย อธิบายได้ว่าทำไมได้อันดับนี้
// ตัวเลขสำคัญกว่าตัวอักษร: "Syrup 800×3×4" กับ "Syrup 800×12" ต่างกันที่เลขล้วน ๆ
const skuScore = (queryNorm, qNums, sku) => {
  const target = normAlias(`${sku.product_name || ''} ${sku.keyword || ''}`);
  if (!target) return 0;
  let score = 0;
  if (target.includes(queryNorm) || queryNorm.includes(target)) score += 50;
  const tNums = target.match(/\d+/g) || [];
  for (const n of qNums) if (tNums.includes(n)) score += 12;
  for (const n of tNums) if (!qNums.includes(n)) score -= 3;   // เลขที่ไม่ได้ขอ = คนละแพ็ก
  // ตัวอักษรที่ทับกัน (ตัดตัวเลขออกแล้ว) — ช่วยแยก Syrup / Icing / Amazon
  const qLetters = queryNorm.replace(/\d+/g, '');
  const tLetters = target.replace(/\d+/g, '');
  if (qLetters && tLetters.includes(qLetters)) score += 20;
  else if (qLetters.length >= 3 && tLetters.includes(qLetters.slice(0, 3))) score += 6;
  return score;
};

const SPP_ASK_LIMIT = 6;      // จำนวนปุ่มสูงสุดตอนถาม — มากกว่านี้คนอ่านไม่ไหวบนมือถือ

// คืน { status: 'exact' | 'ask' | 'none', sku?, candidates[] }
//   exact = มั่นใจพอจะใช้เลย (มาจากรหัสตรง / alias ที่คนเคยผูก / ชื่อตรงเป๊ะ / เหลือตัวเลือกเดียวหลังกรองเครื่อง)
//   ask   = มีหลายตัวใกล้กัน → ผู้เรียกต้องเด้งปุ่มให้คนเลือก ห้ามหยิบตัวแรกเอง
async function resolveSku(text, machineText = '') {
  const raw = String(text || '').trim();
  const q = normAlias(raw);
  if (!q) return { status: 'none', candidates: [] };
  const mach = normMachine(machineText) || extractMachine(raw);

  const all = await dbAll('SELECT * FROM sku_master WHERE active = 1', []).catch(() => []);
  const byCode = new Map(all.map(s => [skuIdOf(s).toUpperCase(), s]).filter(([k]) => k));

  // 1) พิมพ์รหัส SKU มาตรง ๆ
  const asCode = byCode.get(raw.toUpperCase());
  if (asCode) return { status: 'exact', sku: asCode, candidates: [] };

  // 2+3) เคยมีคนผูกไว้แล้ว — เครื่องตรงก่อน แล้วค่อยตัวที่ไม่ระบุเครื่อง
  const aliases = await dbAll(
    'SELECT sku_code, machine_norm FROM sku_alias WHERE alias_norm = ?', [q]).catch(() => []);
  const pick = aliases.find(a => a.machine_norm && a.machine_norm === mach)
            || aliases.find(a => !a.machine_norm);
  // จัดอันดับผู้สมัครด้วยกฎ (ไม่เรียก AI) แล้วกรองด้วยเครื่องที่คนหน้างานบอกมา
  const rankAll = () => {
    const qNums = q.match(/\d+/g) || [];
    let r = all.map(x => ({ sku: x, score: skuScore(q, qNums, x) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (mach) {
      const sameMachine = r.filter(x => normMachine(x.sku.machine) === mach);
      if (sameMachine.length) r = sameMachine;      // เครื่องตรง = สัญญาณแรงสุด เชื่อการกรอง
    }
    return r.map(x => x.sku);
  };

  if (pick) {
    const hit = byCode.get(String(pick.sku_code).toUpperCase());
    if (hit) {
      // ⚠️ จำได้ ≠ ใช้เลย — ผู้ใช้สั่งไว้ 2026-08-07 ว่าของที่มาจากความจำ "ต้องกดยืนยันทุกครั้ง"
      //    เหตุผล: ชื่อในแผนอย่าง "Syrup 800×3×4" มีของจริงใกล้กัน 2 ตัว (Stand pouch / Makro)
      //    คนละลูกค้า · ถ้าจำคำตอบเดียวไว้แล้วใช้เงียบ ๆ วันที่คนตั้งใจลงอีกตัวจะเข้าผิดโดยไม่มีใครรู้
      //    ความจำจึงมีหน้าที่แค่ "เดาให้ก่อน + ทำให้ช่องแผนขึ้นเลขได้" ไม่ใช่ตัดสินแทนคน
      const others = rankAll().filter(x => skuIdOf(x) !== skuIdOf(hit));
      return { status: 'confirm', sku: hit, candidates: [hit, ...others].slice(0, SPP_ASK_LIMIT) };
    }
    // alias ชี้ไปยัง SKU ที่ถูกปิด/ลบไปแล้ว → ตกไปหาใหม่ ดีกว่าคืนของที่ใช้ไม่ได้
  }

  // 4) ชื่อทางการหรือ keyword ตรงเป๊ะ — ไม่ได้พึ่งความจำ จึงใช้ได้เลย
  const exactName = all.find(x => normAlias(x.product_name) === q || normAlias(x.keyword) === q);
  if (exactName) return { status: 'exact', sku: exactName, candidates: [] };

  // 5) เดาจากกฎ · เหลือตัวเดียวจริง ๆ ถึงจะรับอัตโนมัติ
  //    คะแนนนำห่างไม่นับว่า "ชัดเจน" — เคยพลาดมาแล้ว
  const ranked = rankAll();
  if (!ranked.length) return { status: 'none', candidates: [] };
  if (ranked.length === 1) return { status: 'exact', sku: ranked[0], candidates: [] };
  return { status: 'ask', candidates: ranked.slice(0, SPP_ASK_LIMIT) };
}

// จำคู่ที่คนกดเลือก — ครั้งหน้าจะเข้าทางที่ 2 ทันที ไม่ต้องถามอีก
// skuId = skuIdOf(sku) ไม่ใช่ sku_code ดิบ — สินค้าที่ไม่มีรหัสก็ต้องผูกชื่อเล่นได้
async function rememberAlias(rawText, machineText, skuId, source, by) {
  const alias = normAlias(rawText);
  if (!alias || !skuId) return;
  const mach = normMachine(machineText);
  try {
    await db.exec(
      `INSERT INTO sku_alias (alias_norm, alias_raw, machine_norm, sku_code, source, created_by, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(alias_norm, machine_norm)
       DO UPDATE SET sku_code=excluded.sku_code, alias_raw=excluded.alias_raw,
                     source=excluded.source, created_by=excluded.created_by, created_at=excluded.created_at`,
      [alias, String(rawText).trim(), mach, skuId, source || 'floor', by || '', nowBKK()]
    );
    console.log(`[SKU alias] "${String(rawText).trim()}"${mach ? ` (${mach})` : ''} → ${skuId} โดย ${by || '-'}`);
  } catch (e) { console.error('[SKU alias] save failed', e.message); }
}

// แผนของวันนั้นทั้งวัน แปลงเป็นรหัส SKU แล้ว — ใช้ร่วมกัน 3 ที่: เมนู "แผนผลิตวันนี้",
// ช่อง "แผน" ในหน้าอนุมัติ และตัวเตือนสิ้นกะ · จับคู่ครั้งเดียวแล้วทุกที่เห็นตรงกัน
// คืนทุกแถวรวมตัวที่ยังจับคู่ไม่ได้ (sku = null) — ตัวที่จับไม่ได้ต้องโผล่ให้คนเห็นเพื่อไปผูก
// ไม่ใช่หายเงียบ ๆ แบบเดิมที่ทำให้แผน 6 รายการกลายเป็น "ไม่มีแผนผลิตในระบบ"
async function resolveDayPlan(workDay, shift = null) {
  const shiftN = shift ? normalizeShift(shift) : null;
  const rows = await dbAll(
    'SELECT shift, flavor, target_boxes, staff, machine_code FROM shift_plans WHERE work_day = ? ORDER BY id', [workDay]
  ).catch(() => []);
  const wanted = shiftN ? rows.filter(r => normalizeShift(r.shift) === shiftN) : rows;
  const use = wanted.length ? wanted : rows;      // กะนั้นไม่มีแผน → ถอยไปดูทั้งวัน (เหมือนพฤติกรรมเดิม)
  const out = [];
  for (const p of use) {
    const r = await resolveSku(p.flavor, p.machine_code || '');
    out.push({
      plan: p,
      // 'confirm' = รู้แล้วว่าน่าจะเป็นตัวไหน (จากความจำ) แต่ยังต้องให้คนกดยืนยันก่อนลงยอด
      // ยังใส่ sku มาด้วยเพราะช่อง "แผน" กับตัวเตือนสิ้นกะต้องรู้ว่าแผนหมายถึงสินค้าตัวไหน
      sku: (r.status === 'exact' || r.status === 'confirm') ? r.sku : null,
      status: r.status,
      candidates: r.candidates || [],
      exact_shift: shiftN ? normalizeShift(p.shift) === shiftN : true,
    });
  }
  return out;
}

// หาแผนของ SKU นี้ในวัน+กะที่ระบุ · แผนเก็บเป็น "กล่อง" เท่านั้น จึงห้ามเติมข้ามหน่วย
async function resolvePlanQty(workDay, shift, sku) {
  if (!sku) return { plan_qty: null, plan_source: 'none' };
  try {
    // เทียบด้วยรหัส SKU ไม่ใช่ชื่อ — ชื่อในแผน ("Syrup 800×3×4") ไม่มีวันตรงกับชื่อทางการ
    // ⚠️ ผ่าน skuIdOf เสมอ — สินค้า 13 ตัวในชีตหลักไม่มีรหัส SKU ถ้ายึดรหัสดิบจะเทียบแผนไม่ได้ตลอดกาล
    const mineId = skuIdOf(sku);
    const day = await resolveDayPlan(workDay, shift);
    const mine = mineId ? day.filter(x => x.sku && skuIdOf(x.sku) === mineId) : [];
    if (mine.length) {
      const hit = mine.find(x => x.exact_shift) || mine[0];
      return {
        plan_qty: Number(hit.plan.target_boxes) || 0,
        plan_source: hit.exact_shift ? 'shift_plans' : 'shift_plans_other_shift',
      };
    }
    // แผนผลิตรายอาทิตย์ (production_plans) ยังจับด้วยชื่อรสแบบเดิม — คนละชุดข้อมูลกับแผนบรรจุ
    // เส้นนี้คิดเป็น "batch × 100 กล่อง" จึงใช้ได้เฉพาะสินค้าที่นับเป็นกล่องจริง ๆ
    // (ต่างจากแผนบรรจุข้างบนที่เลขในแผนคือเป้าของสินค้าตัวนั้นตรง ๆ ไม่ว่านับหน่วยอะไร)
    if (sku.count_unit && sku.count_unit !== 'กล่อง') return { plan_qty: null, plan_source: 'unit_mismatch' };
    const flavor = (sku.keyword || '').trim();
    if (flavor) {
      const pp = await dbAll('SELECT planned_batches FROM production_plans WHERE plan_date = ? AND flavor = ?', [workDay, flavor]);
      if (pp.length) {
        const batches = pp.reduce((s, r) => s + (Number(r.planned_batches) || 0), 0);
        return { plan_qty: batches * 100, plan_source: 'production_plans' }; // 1 batch = 100 boxes
      }
    }
  } catch (e) { console.error('[SPP] plan lookup failed', e.message); }
  return { plan_qty: null, plan_source: 'none' };
}

const verifyUrlOf = (token) => `${APP_PUBLIC_URL}/?verify=${token}`;

// แจ้งลิงก์ให้คลัง — เฟส 1 ใช้ Telegram (ทำงานอยู่แล้ว) · LINE push มาเฟส 4
async function notifyVerifyLink(rep) {
  const url = verifyUrlOf(rep.verify_token);
  const text = [
    '📦 <b>รอคลังตรวจนับ</b>',
    `สินค้า: <b>${escapeHtml(rep.product_name || rep.sku_keyword)}</b>`,
    `วันที่/กะ: ${escapeHtml(rep.report_date)} · ${escapeHtml(rep.shift)}`,
    `ผู้รายงาน: ${escapeHtml(rep.reporter_name || '-')}`,
    `ฝ่ายผลิตแจ้ง: <b>${rep.prod_qty} ${escapeHtml(rep.count_unit)}</b>`,
    '',
    `กรอกยอดที่นับได้: ${url}`,
    `(ลิงก์ใช้ได้ครั้งเดียว หมดอายุ ${escapeHtml(rep.verify_expires_at)})`,
  ].join('\n');
  // sendSppTelegram คืน true เฉพาะตอนส่งผ่านจริง — ห้ามรายงานว่า "ส่งแล้ว" ทั้งที่ไม่ได้ส่ง
  return (await sendSppTelegram(text)) ? 'telegram' : 'none';
}

// แจ้งลิงก์ชุด (กะหนึ่ง 8+ รายการ = ลิงก์เดียว) — ข้อความสรุปแทนการยิงทีละรายการ
async function notifyBatchLink(batch, items) {
  const url = verifyUrlOf(batch.verify_token);
  const text = [
    `📦 <b>รอคลังตรวจนับ · ${items.length} รายการ</b>`,
    `วันที่/กะ: ${escapeHtml(batch.work_day)} · ${escapeHtml(batch.shift)}`,
    `ผู้ลงยอด: ${escapeHtml(batch.created_by || '-')}`,
    '',
    ...items.map((it, i) => `${i + 1}. ${escapeHtml(it.product_name)} — <b>${it.prod_qty} ${escapeHtml(it.count_unit)}</b>`),
    '',
    `กรอกยอดที่นับได้ทั้งหมดในลิงก์เดียว: ${url}`,
    `(ลิงก์ใช้ได้ครั้งเดียว หมดอายุ ${escapeHtml(batch.verify_expires_at)})`,
  ].join('\n');
  return (await sendSppTelegram(text)) ? 'telegram' : 'none';
}

// ── สร้าง 1 รายงานลง DB ─────────────────────────────────────────────────
// ใช้ร่วมกันทั้งลงรายการเดี่ยวและลงเป็นชุด — ตรรกะคำนวณต้องมีชุดเดียวเท่านั้น
// header = ข้อมูลระดับกะ (วันที่/กะ/ผู้รายงาน/ทีมงาน/เวลา) · item = ข้อมูลรายสินค้า
// โยน Error พร้อม .httpStatus เมื่อข้อมูลไม่ผ่าน ให้ผู้เรียกจับไปตอบเอง
const badRequest = (msg) => Object.assign(new Error(msg), { httpStatus: 400 });

async function createReportRow({ header, item, batchId = null, token = null, expires = null, channel = 'web' }) {
  const keyword = String(item.sku_keyword || '').trim();
  const prodQty = Number(item.prod_qty);
  if (!keyword) throw badRequest('ต้องเลือกสินค้า (SKU)');
  if (!Number.isFinite(prodQty) || prodQty < 0) throw badRequest(`จำนวนผลิตจริงของ "${keyword}" ไม่ถูกต้อง`);

  // SKU ต้องรู้จัก — SKU มั่วคือข้อมูลเสียแบบเงียบ
  const skuRows = await dbAll('SELECT * FROM sku_master WHERE keyword = ? AND active = 1', [keyword]);
  const sku = skuRows[0];
  if (!sku) throw badRequest(`ไม่รู้จักสินค้า "${keyword}" — เพิ่มใน SKU master ก่อน`);

  const workDay = header.work_day;
  const shift = header.shift;
  const reporter = header.reporter;
  const crew = Array.isArray(header.crew) ? header.crew.filter(Boolean) : [];
  const packFactor = Number(sku.pack_factor) || 0;
  const prodPcs = prodQty * packFactor;                       // คำนวณฝั่ง server เท่านั้น

  const plan = item.plan_qty_override != null && item.plan_qty_override !== ''
    ? { plan_qty: Number(item.plan_qty_override), plan_source: 'manual' }
    : await resolvePlanQty(workDay, shift, sku);
  const prodStatus = plan.plan_qty > 0 && prodQty < plan.plan_qty ? 'ไม่ได้ยอดผลิต' : 'ได้ยอดผลิต';
  const missReason = prodStatus === 'ไม่ได้ยอดผลิต' ? String(item.miss_reason || '').trim() : '-';
  if (prodStatus === 'ไม่ได้ยอดผลิต' && !missReason) {
    throw badRequest(`"${keyword}" ผลิตไม่ถึงแผน — ต้องระบุสาเหตุที่ไม่ได้ยอดผลิต`);
  }

  const n = (v) => Number(v) || 0;
  const payload = {
    crew,
    lot_date: item.lot_date || '',
    counter: n(item.counter),
    machine_cycle: n(item.machine_cycle),
    run_time: n(header.run_time),
    setup_time: n(header.setup_time),
    break_time: n(header.break_time),
    clean_time: n(header.clean_time),
    stop_after_target: n(header.stop_after_target),
    bdown_time: n(item.bdown_time),
    machine_run_time: n(header.run_time) - n(header.setup_time) - n(header.break_time)
                      - n(header.clean_time) - n(header.stop_after_target) - n(item.bdown_time),
    wastes: Array.isArray(item.wastes) ? item.wastes : [],
    extra_note: item.extra_note || '',
    // เฟส 2 (ทางเข้า Telegram): รูปค้างพาเลท + ภาชนะบรรจุชำรุด 5 ประเภท
    // สินค้าสาย 2 คลังมองไม่เห็นของที่ค้างพาเลท รูปคือหลักฐานเดียวที่ยันยอดได้
    ...(item.pallet_photo ? { pallet_photo: item.pallet_photo } : {}),
    ...(item.damaged ? { damaged: item.damaged } : {}),
  };

  const reportId = 'RPT-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const now = nowBKK();
  await db.exec(
    `INSERT INTO production_reports
      (report_id, batch_id, work_day, report_date, shift, sku_keyword, sku_code, product_name, group_name, machine,
       count_unit, pack_factor, plan_qty, plan_source, prod_qty, prod_pcs, reporter_name, crew_count, reported_at,
       prod_status, miss_reason, status, verify_token, verify_expires_at, payload,
       telegram_user_id, telegram_chat_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_review',?,?,?,?,?,?,?)`,
    [reportId, batchId, workDay, workDay, shift, keyword, sku.sku_code || '', sku.product_name || keyword,
     // เครื่องเลือกได้หน้างาน (สินค้าเดียวกันวิ่งได้หลายเครื่อง เช่น Syrup → Linear#1-#4)
     sku.group_name || '', String(item.machine || sku.machine || '').trim(), sku.count_unit || 'กล่อง', packFactor,
     plan.plan_qty, plan.plan_source, prodQty, prodPcs, reporter, crew.length, now,
     prodStatus, missReason, token, expires, JSON.stringify(payload),
     // ผูกไว้กับคนที่ลงยอดใน Telegram — หัวหน้ากด "ส่งกลับแก้" แล้วต้องรู้ว่าจะเด้งหาใคร
     header.telegram_user_id || null, header.telegram_chat_id || null, now, now]
  );
  await logReportEvent(reportId, 'created', reporter, `ลงยอด ${prodQty} ${sku.count_unit}`, channel, 'production');

  return {
    report_id: reportId, sku_keyword: keyword, product_name: sku.product_name || keyword,
    count_unit: sku.count_unit || 'กล่อง', prod_qty: prodQty, prod_pcs: prodPcs,
    plan_qty: plan.plan_qty, plan_source: plan.plan_source, prod_status: prodStatus,
  };
}

// ── ตรวจจับความผิดปกติของรายงาน (เฟส 2) ────────────────────────────────────
// เป็นกฎล้วน ๆ ไม่เรียก LLM: เร็ว ทำนายผลได้ อธิบายได้ และไม่มีค่าใช้จ่ายต่อการส่ง 1 ชุด
// ผลเก็บใน payload.ai_flags → หน้าอนุมัติเอาไปแสดงเป็นป้ายเตือน
// ⚠️ ห้ามใช้ตัดสินใจแทนหัวหน้า — เตือนอย่างเดียว
// ตรวจความผิดปกติของ 1 รายการ — ทำงานได้ทั้งกับแถวที่เขียน DB แล้วและกับร่างที่ยังไม่ได้บันทึก
// (บอทเรียกก่อนบันทึกเพื่อทักผู้ใช้ · createProductionBatch เรียกหลังบันทึกเพื่อติดป้ายให้หัวหน้า)
// คืน [] เมื่อไม่พบอะไร — เป็นป้ายเตือนอย่างเดียว ไม่บล็อกและไม่ตัดสินแทนคน
async function checkItemAnomalies({ sku_keyword, prod_qty, plan_qty, pack_factor, counter, pallet_photo, work_day, report_id = null }) {
  const flags = [];
  const qty = Number(prod_qty) || 0;
  const day = work_day || workDayBKK();

  // 1) ห่างจากแผนมาก
  if (Number(plan_qty) > 0) {
    const pct = Math.round((qty / Number(plan_qty)) * 100);
    if (pct < 70) flags.push({ level: 'warn', text: `ได้แค่ ${pct}% ของแผน (${qty}/${plan_qty})` });
    else if (pct > 130) flags.push({ level: 'info', text: `เกินแผน ${pct}% — เช็กว่าลงยอดถูกกะไหม` });
  }

  // 2) ต่างจากค่าเฉลี่ยของ SKU นี้ใน 30 วันหลัง (ต้องมีประวัติ ≥3 ใบถึงจะเชื่อค่าเฉลี่ย)
  try {
    const hist = await dbAll(
      `SELECT AVG(prod_qty) AS avg_qty, COUNT(*) AS n FROM production_reports
        WHERE sku_keyword = ? AND report_id <> ? AND work_day >= ? AND prod_qty > 0`,
      [sku_keyword, report_id || '', addDaysStr(day, -30)]
    );
    const avg = Number(hist[0]?.avg_qty) || 0;
    const n = Number(hist[0]?.n) || 0;
    if (n >= 3 && avg > 0) {
      const ratio = qty / avg;
      if (ratio > 2) flags.push({ level: 'warn', text: `มากกว่าค่าเฉลี่ย 30 วัน ${ratio.toFixed(1)} เท่า (เฉลี่ย ${Math.round(avg)})` });
      else if (ratio < 0.4) flags.push({ level: 'info', text: `น้อยกว่าค่าเฉลี่ย 30 วันมาก (เฉลี่ย ${Math.round(avg)})` });
    }
  } catch { /* ไม่มีประวัติก็ข้าม */ }

  // 3) สินค้าสาย 2 (จัดพาเลทเอง) แต่ไม่มีรูปค้างพาเลท — คลังยันยอดไม่ได้
  try {
    const sku = (await dbAll('SELECT pallet_route FROM sku_master WHERE keyword = ?', [sku_keyword]))[0];
    if (Number(sku?.pallet_route) === 2 && !pallet_photo) {
      flags.push({ level: 'warn', text: 'สินค้าจัดพาเลทเอง แต่ไม่มีรูปค้างพาเลท', fix: 'photo' });
    }
  } catch { /* ข้าม */ }

  // 4) เลขหน้าเครื่องไม่สมเหตุผลกับยอด (counter ควรใกล้ยอด×ชิ้นต่อกล่อง)
  const cnt = Number(counter) || 0;
  const expectPcs = qty * (Number(pack_factor) || 0);
  if (cnt > 0 && expectPcs > 0) {
    const ratio = cnt / expectPcs;
    if (ratio > 3 || ratio < 0.33) {
      flags.push({ level: 'info', text: `เลขหน้าเครื่อง ${cnt.toLocaleString()} ไม่สอดคล้องกับยอด ${expectPcs.toLocaleString()} ชิ้น` });
    }
  }
  return flags;
}

async function flagBatchAnomalies(created) {
  for (const c of created) {
    const rows = await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [c.report_id]);
    const r = rows[0];
    if (!r) continue;
    let payload = {};
    try { payload = JSON.parse(r.payload || '{}'); } catch { continue; }

    const flags = await checkItemAnomalies({
      sku_keyword: r.sku_keyword, prod_qty: r.prod_qty, plan_qty: r.plan_qty, pack_factor: r.pack_factor,
      counter: payload.counter, pallet_photo: payload.pallet_photo, work_day: r.work_day, report_id: r.report_id,
    });
    if (!flags.length) continue;
    payload.ai_flags = flags;
    await db.exec('UPDATE production_reports SET payload = ? WHERE report_id = ?', [JSON.stringify(payload), r.report_id]);
  }
}

// ส่งรายการที่อนุมัติแล้วเข้า n8n → เขียนชีต1 · ไม่ throw (ให้ sheetSyncTick ตามเก็บ)
async function syncReportToSheet(reportId) {
  const rows = await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [reportId]);
  const r = rows[0];
  if (!r || r.status !== 'approved') return;
  let payload = {};
  try { payload = JSON.parse(r.payload || '{}'); } catch { /* payload เสีย — ส่งเท่าที่มี */ }
  const body = {
    report_id: r.report_id,
    date: r.report_date, shift: r.shift,
    ชื่อ: r.reporter_name,
    sku_code: r.sku_code || '', product_name: r.product_name || r.sku_keyword, group: r.group_name || '',
    machine: r.machine || '',
    count_unit: r.count_unit,
    plan_box: r.plan_qty ?? 0,
    actual_box: r.prod_qty ?? 0,
    pack_factor: r.pack_factor ?? 0,
    actual_pcs: r.prod_pcs ?? 0,
    workers: r.crew_count ?? 0,
    warehouse_qty: r.wh_qty ?? 0,
    warehouse_pcs: r.approved_qty != null ? Math.round(r.approved_qty * (r.pack_factor || 0)) : (r.wh_pcs ?? 0),
    variance_qty: r.variance_qty ?? 0,
    wh_name: r.wh_name || '', approver: r.approver_name || '', approved_at: r.decided_at || '',
    status: r.prod_status || '', miss_reason: r.miss_reason || '-',
    ...payload,
  };
  try {
    await axios.post(SPP_N8N_APPROVED_URL, body, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
    await db.exec("UPDATE production_reports SET sheet_status='sent', sheet_sent_at=?, sheet_error=NULL WHERE report_id=?", [nowBKK(), reportId]);
    await logReportEvent(reportId, 'sheet_synced', 'system', 'เขียนลงชีต1 แล้ว', 'n8n');
  } catch (e) {
    const msg = String(e.response?.data?.message || e.message).slice(0, 300);
    await db.exec("UPDATE production_reports SET sheet_status='error', sheet_attempts=sheet_attempts+1, sheet_error=? WHERE report_id=?", [msg, reportId]);
    await logReportEvent(reportId, 'sheet_failed', 'system', msg, 'n8n');
    console.error('[SPP] sheet sync failed', msg);
  }
}

// ตัดสินรายการ (ใช้ร่วมกันระหว่าง HTTP endpoint กับปุ่มใน Telegram ในอนาคต)
async function decideReport(reportId, approve, actor, opts = {}) {
  const rows = await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [reportId]);
  const r = rows[0];
  if (!r) return { ok: false, message: 'ไม่พบรายงานนี้' };
  if (r.status !== 'pending_approval') return { ok: false, message: `รายการนี้ถูกตัดสินไปแล้ว (${r.status})`, status: r.status };
  const source = opts.approved_source === 'production' ? 'production' : 'warehouse';
  const qty = approve ? (source === 'production' ? r.prod_qty : r.wh_qty) : null;
  // ยึดเลขคลังทั้งที่คลังยังไม่ได้นับ = ส่งค่าว่างเข้า Google Sheet เงียบ ๆ · ต้องกันไว้ที่นี่
  // (เกิดได้จริงตอนใบเด้งมา pending_approval โดยข้ามคลัง — ตัวเลือกในหน้าอนุมัติตั้งต้นที่ "คลังนับได้")
  if (approve && qty == null) {
    return { ok: false, message: source === 'warehouse'
      ? 'คลังยังไม่ได้นับใบนี้ — เลือก "ยึดยอดฝ่ายผลิต" หรือส่งให้คลังนับก่อน'
      : 'ใบนี้ไม่มียอดฝ่ายผลิต' , status: r.status };
  }
  await db.exec(
    `UPDATE production_reports SET status=?, approver_name=?, approved_qty=?, approved_source=?, decision_note=?, decided_at=?, updated_at=?
     WHERE report_id=? AND status='pending_approval'`,
    [approve ? 'approved' : 'rejected', actor || '', qty, approve ? source : null, opts.note || '', nowBKK(), nowBKK(), reportId]
  );
  await logReportEvent(reportId, approve ? 'approved' : 'rejected', actor, approve ? `ยึดยอด${source === 'production' ? 'ฝ่ายผลิต' : 'คลัง'} ${qty}` : (opts.note || ''), opts.channel || 'web');
  if (approve) syncReportToSheet(reportId);
  return { ok: true, status: approve ? 'approved' : 'rejected' };
}

// rate limit แบบง่ายสำหรับหน้าสาธารณะของคลัง (ไม่เพิ่ม dependency)
// bucket = แยกโควตาต่อฟีเจอร์ ไม่งั้นคนที่ยิงหน้าคลังถี่จะไปกินโควตาของฟีเจอร์อื่นด้วย
const verifyHits = new Map();
function rateLimited(ip, max = 30, windowMs = 60000, bucket = 'default') {
  const now = Date.now();
  const key = bucket + '|' + ip;
  const rec = verifyHits.get(key);
  if (!rec || now - rec.t > windowMs) { verifyHits.set(key, { t: now, n: 1 }); return false; }
  rec.n++;
  if (verifyHits.size > 500) for (const [k, v] of verifyHits) if (now - v.t > windowMs) verifyHits.delete(k);
  return rec.n > max;
}

// ── SKU master ────────────────────────────────────────────────────────────
app.get('/api/sku', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM sku_master WHERE active = 1 ORDER BY sort_order, group_name, keyword', []);
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// แก้ข้อมูล SKU (โดยเฉพาะ count_unit ที่ต้องให้หน้างานยืนยัน) — upsert ด้วย keyword
app.post('/api/sku', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'items ต้องเป็น array และไม่ว่าง' });
  try {
    for (const it of items) {
      if (!it.keyword) continue;
      // ตรวจแล้วมี pack_factor และเปิดใช้ → เคลียร์ review_note ออกจากคิวรอตรวจไปเลย
      const active = it.active === 0 ? 0 : 1;
      const packFactor = Number(it.pack_factor) || 0;
      const reviewNote = active && packFactor ? null : (it.review_note ?? null);
      await db.exec(
        `INSERT INTO sku_master (keyword, sku_code, product_name, group_name, machine, count_unit, pack_factor, plan_flavor, active, pallet_route, review_note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (keyword) DO UPDATE SET
           sku_code=excluded.sku_code, product_name=excluded.product_name, group_name=excluded.group_name,
           machine=excluded.machine, count_unit=excluded.count_unit, pack_factor=excluded.pack_factor,
           plan_flavor=excluded.plan_flavor, active=excluded.active, pallet_route=excluded.pallet_route,
           review_note=excluded.review_note, updated_at=excluded.updated_at`,
        [it.keyword, it.sku_code || '', it.product_name || '', it.group_name || '', it.machine || '',
         it.count_unit || 'กล่อง', packFactor, it.plan_flavor || '',
         active, it.pallet_route === 2 ? 2 : (it.pallet_route === 1 ? 1 : null), reviewNote, nowBKK()]
      );
    }
    res.json({ ok: true, saved: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ⚠️ ชีตจับคู่ทำมือ (121Xch… · keyword/full_product/group) ถูกยกเลิก 2026-08-07
//    พร้อมกับ route POST /api/sku/sync และ webhook n8n "spp-sku-list"
//    เหตุผล: มันผูก "Syrup800" ไว้กับ S76S9Z000T (Stand pouch TT ของ Linear#4) ทั้งที่หน้างานเดิน
//    Linear#3 (= S76S9Z000M / MT) ยอดจึงเข้าผิด SKU ใน Google Sheet โดยไม่มีใครเห็นและแก้ไม่ได้
//    ตอนนี้รายการสินค้ามาจากชีตหลักทางเดียว (POST /api/sku/import-all) และชื่อเล่นอยู่ในตาราง sku_alias
//    ที่คนกดผูกเอง + ตรวจ/ลบได้จากแท็บ "SKU รอตรวจสอบ"
//    (เส้น n8n ที่ส่งยอดอนุมัติแล้วเข้า Google Sheet — SPP_N8N_APPROVED_URL — ยังใช้งานตามปกติ)

// เดาจำนวนชิ้นต่อกล่องจากตัวคูณท้ายชื่อ: "(8g*30*4*10)" → 30×4×10 = 1200 · "(800ml*12)" → 12
// เดาไม่ได้คืน 0 แล้วให้หน้างานมาเติมเอง (แจ้งไว้ใน needsReview)
const guessPackFactor = (full) => {
  const m = String(full || '').match(/\*\s*(\d+)/g);
  if (!m) return 0;
  return m.reduce((acc, x) => acc * (Number(x.replace(/[^\d]/g, '')) || 1), 1);
};

// ── สินค้าสาย 2: พนักงานบรรจุจัดเรียงพาเลทเอง คลังมองไม่เห็นของที่ค้างพาเลท ───
// (จากโน้ต Notion: Icing, น้ำตาลปี๊บ, Lowcal, Senorita, น้ำเชื่อม 20x1)
// แตะเฉพาะแถวที่ pallet_route ยัง NULL → รันกี่รอบก็ได้ และไม่ทับค่าที่หน้างานแก้เอง
const PALLET_ROUTE2_GROUPS = ['Icing', 'Senorita', 'Low Cal.'];
// ชื่อในชีตปนไทย/อังกฤษ — ต้องจับทั้งสองแบบ (ไอซิ่ง/icing, เซนญอ/senorita) ไม่งั้นหลุดเงียบ ๆ
const PALLET_ROUTE2_NAME_RE = /ปี๊บ|low\s*cal|โลว์แคล|icing|ไอซิ่ง|เซนญอ|senorita|20\s*kg|20\s*×\s*1|20\s*x\s*1|\(BIB\)/i;

async function seedPalletRoutes() {
  try {
    const rows = await dbAll('SELECT keyword, group_name, product_name FROM sku_master WHERE pallet_route IS NULL', []);
    let n = 0;
    for (const r of rows) {
      const hay = `${r.keyword || ''} ${r.product_name || ''}`;
      const isRoute2 = PALLET_ROUTE2_GROUPS.includes((r.group_name || '').trim()) || PALLET_ROUTE2_NAME_RE.test(hay);
      if (!isRoute2) continue;
      await db.exec('UPDATE sku_master SET pallet_route = 2 WHERE keyword = ? AND pallet_route IS NULL', [r.keyword]);
      n++;
    }
    if (n) console.log(`[SKU] pallet_route=2 seeded for ${n} SKUs`);
  } catch (e) { console.error('[SKU] seedPalletRoutes failed', e.message); }
}

// ── CSV parser เล็ก ๆ (ไม่เพิ่ม dependency) — รองรับฟิลด์ในเครื่องหมายคำพูดที่มี , หรือขึ้นบรรทัดใหม่ ──
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── นำเข้า "รายการสินค้าทั้งหมด" จากชีตของฝ่ายผลิต (~200 SKU) ────────────────
// ชีตเปิดสาธารณะ → ดึง CSV ตรงได้ ไม่ต้องผ่าน n8n และไม่ต้องใช้ Google credential
// รูปแบบชีตไม่สะอาด: ชื่อสินค้าถูกตัดคร่อมหลายคอลัมน์ (B–H) เพราะเดิมวางมาจากข้อความ
//   คอลัมน์ 0 = รหัส SKU · 1..7 = ชิ้นส่วนของชื่อ · 8 = เครื่อง
//   บางแถวขึ้นต้นด้วย "EX" แล้วรหัสไปอยู่คอลัมน์ 1
//   บางแถวไม่มีรหัสเลย (เช่น ไซรัปเฟรชชี่ 20 kg. BIB.) — ยังเป็นสินค้า
//   ท้ายชีตเป็นรายชื่อ "กลุ่ม" ล้วน ๆ (Syrup/Freshy/Icing/...) ไม่ใช่สินค้า → แยกด้วย "ไม่มีตัวเลขในแถว"
const ALL_SKU_CSV_URL = process.env.SPP_ALL_SKU_CSV_URL
  || 'https://docs.google.com/spreadsheets/d/1a7_hNWzGErVEdwkmASRf-UmWE5ecf2TsdQZS3Y6YRbA/export?format=csv';

const looksLikeSkuCode = (v) => /^[A-Z][0-9A-Z]{6,12}$/.test(String(v || '').trim());

// แปลง 1 แถว CSV → { sku_code, product_name, machine } หรือ null ถ้าไม่ใช่สินค้า
function parseAllSkuRow(cells) {
  const c = cells.map(x => String(x || '').trim());
  if (!c.some(Boolean)) return null;
  if (c[0] === 'SKU') return null;                       // แถวหัวตาราง
  if (!/[0-9]/.test(c.join(' '))) return null;           // ไม่มีตัวเลขเลย = ชื่อกลุ่มท้ายชีต ไม่ใช่สินค้า

  const machine = (c[8] || '').trim();
  let code = '', nameParts;
  if (c[0] === 'EX' && looksLikeSkuCode(c[1])) { code = c[1]; nameParts = c.slice(2, 8); }
  else if (looksLikeSkuCode(c[0])) { code = c[0]; nameParts = c.slice(1, 8); }
  else nameParts = c.slice(0, 8);                        // สินค้าที่ไม่มีรหัสในชีต

  const product_name = nameParts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!code && !product_name) return null;
  return { sku_code: code, product_name, machine };
}

app.post('/api/sku/import-all', async (req, res) => {
  let csv;
  try {
    const r = await axios.get(ALL_SKU_CSV_URL, { timeout: 25000, responseType: 'text' });
    csv = typeof r.data === 'string' ? r.data : String(r.data);
  } catch (e) {
    console.error('[SKU import-all] fetch error:', e.response?.status || e.message);
    return res.status(502).json({ error: 'ดึงชีตรายการสินค้าไม่สำเร็จ (ตรวจว่าชีตยังเปิดให้ "ผู้ที่มีลิงก์" อ่านได้)' });
  }

  const parsed = parseCsv(csv).map(parseAllSkuRow).filter(Boolean);
  if (!parsed.length) return res.status(502).json({ error: 'อ่านชีตแล้วไม่พบรายการสินค้า' });

  const created = [], updated = [], needsReview = [], skipped = [], duplicates = [];
  const seen = new Set();
  try {
    for (const row of parsed) {
      // ชีตมีรหัสซ้ำกันจริงอยู่ 2 ตัว — ข้ามตัวที่ซ้ำแล้วรายงานให้รู้ ดีกว่าปล่อยให้ DO NOTHING เงียบ ๆ
      const dupKey = row.sku_code || row.product_name;
      if (seen.has(dupKey)) { duplicates.push(dupKey); continue; }
      seen.add(dupKey);

      // จับคู่ด้วย sku_code ก่อน (ของเดิม 16 ตัวมี keyword เป็นชื่อเล่น เช่น "Syrup 1.8" ไม่ใช่รหัส)
      // แล้วค่อยลอง keyword — กันสร้างซ้ำเมื่อชีตกับ seed เป็นสินค้าตัวเดียวกัน
      const existing = row.sku_code
        ? (await dbAll('SELECT keyword, pack_factor, count_unit FROM sku_master WHERE sku_code = ?', [row.sku_code]))[0]
        : (await dbAll('SELECT keyword, pack_factor, count_unit FROM sku_master WHERE keyword = ?', [row.product_name]))[0];

      if (existing) {
        // invariant: ชีตเป็นเจ้าของแค่ชื่อ/รหัส/กลุ่ม — count_unit, pack_factor, machine ตั้งกันหน้างาน ห้ามทับ
        await db.exec(
          'UPDATE sku_master SET sku_code = ?, product_name = ?, updated_at = ? WHERE keyword = ?',
          [row.sku_code || '', row.product_name, nowBKK(), existing.keyword]
        );
        updated.push(existing.keyword);
        if (!Number(existing.pack_factor)) needsReview.push({ keyword: existing.keyword, reason: 'ยังไม่มีจำนวนชิ้น/หน่วยนับ' });
        continue;
      }

      // keyword ต้องไม่ชนของเดิม — ใช้รหัส SKU เป็นหลัก ไม่มีรหัสค่อยใช้ชื่อ
      const keyword = row.sku_code || row.product_name;
      if (!keyword) { skipped.push(row.product_name); continue; }

      const pf = guessPackFactor(row.product_name);
      // เดา pack_factor ไม่ได้ = ยังคำนวณยอดชิ้นไม่ถูก → ปิดไว้ก่อน ไม่ให้โผล่ในฟอร์มจนกว่าจะมีคนมาตรวจ
      const reviewNote = pf
        ? 'นำเข้าจากชีตรายการสินค้า — ยังไม่ได้ยืนยันหน่วยนับ/เครื่อง'
        : 'นำเข้าจากชีตรายการสินค้า — เดาจำนวนชิ้นต่อหน่วยไม่ได้ ต้องกรอกเอง';
      await db.exec(
        `INSERT INTO sku_master (keyword, sku_code, product_name, group_name, machine, count_unit, pack_factor,
                                 plan_flavor, active, review_note, updated_at)
         VALUES (?, ?, ?, '', ?, 'กล่อง', ?, '', ?, ?, ?)
         ON CONFLICT (keyword) DO NOTHING`,
        [keyword, row.sku_code || '', row.product_name, row.machine, pf, pf ? 1 : 0, reviewNote, nowBKK()]
      );
      created.push(keyword);
      needsReview.push({ keyword, product_name: row.product_name, pack_factor: pf, active: pf ? 1 : 0, reason: reviewNote });
    }
    await seedPalletRoutes();   // สินค้าที่เพิ่งเข้ามาต้องได้ธงสาย 2 ด้วย
  } catch (e) {
    console.error('[SKU import-all] db error:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log(`[SKU import-all] parsed=${parsed.length} created=${created.length} updated=${updated.length} dup=${duplicates.length} review=${needsReview.length}`);
  res.json({ ok: true, total: parsed.length, created, updated, skipped, duplicates, needsReview });
});

// ── ชื่อเล่นที่ระบบจำไว้ (sku_alias) ────────────────────────────────────────
// ต้องดูและลบได้เสมอ — ชีตจับคู่ทำมือรุ่นก่อนผูก "Syrup800" ผิดตัวแล้วไม่มีใครเห็น
// ยอดเข้าผิด SKU อยู่หลายเดือนกว่าจะจับได้ · ของใหม่ห้ามซ้ำรอยนั้น
app.get('/api/sku/alias', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT a.id, a.alias_raw, a.alias_norm, a.machine_norm, a.sku_code, a.source, a.created_by, a.created_at,
              m.product_name, m.keyword, m.machine
         FROM sku_alias a LEFT JOIN sku_master m ON (m.sku_code = a.sku_code OR m.keyword = a.sku_code)
        ORDER BY a.created_at DESC`, []);
    res.json({ items: rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sku/alias', async (req, res) => {
  const { alias, machine, sku_code, actor } = req.body || {};
  if (!String(alias || '').trim()) return res.status(400).json({ error: 'ต้องระบุชื่อเล่น' });
  if (!String(sku_code || '').trim()) return res.status(400).json({ error: 'ต้องระบุรหัส SKU' });
  try {
    const id = String(sku_code).trim();
    const hit = (await dbAll('SELECT keyword FROM sku_master WHERE sku_code = ? OR keyword = ?', [id, id]))[0];
    if (!hit) return res.status(400).json({ error: `ไม่รู้จักรหัส SKU "${sku_code}"` });
    await rememberAlias(alias, machine || '', String(sku_code).trim(), 'manual', String(actor || '').trim() || 'เว็บ');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sku/alias/:id', async (req, res) => {
  try {
    const r = await db.exec('DELETE FROM sku_alias WHERE id = ?', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'ไม่พบคู่นี้' });
    res.json({ ok: true });        // ลบแล้วครั้งหน้าบอทจะถามใหม่ ไม่ได้ทำให้ข้อมูลเก่าเสีย
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// รายการ SKU ที่ยังเปิดใช้ไม่ได้ / ยังไม่มี pack_factor — คิวให้หน้างานมาเติมแล้วกดเปิดใช้
app.get('/api/sku/review', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT keyword, sku_code, product_name, group_name, machine, count_unit, pack_factor, pallet_route, active, review_note
         FROM sku_master
        WHERE active = 0 OR pack_factor IS NULL OR pack_factor = 0
        ORDER BY active, group_name, keyword`, []);
    res.json({ items: rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ทีมงานประจำกะ (ให้ฟอร์มติ๊กเลือก แล้วนับเป็นจำนวนคนผลิต)
//   คีย์ `shifts` = รูปแบบเดิมเป๊ะ (ฟอร์มลงยอดผลิตใช้อยู่) · `members` = ของใหม่สำหรับหน้าแก้ไข
app.get('/api/shift-crew', async (req, res) => {
  try {
    const rows = await dbAll('SELECT id, shift, name, sort_order FROM shift_crew WHERE active = 1 ORDER BY sort_order, id', []);
    const byShift = {};
    for (const r of rows) (byShift[r.shift] = byShift[r.shift] || []).push(r.name);
    if (req.query.detail !== '1') return res.json({ shifts: byShift });
    const ops = await dbAll('SELECT name, shift FROM operators', []);
    res.json({
      shifts: byShift, codes: SHIFT_CODES,
      members: rows.map(r => {
        const m = matchCrew(r.name, ops.map(o => ({ shift: o.shift || '', name: o.name })));
        const op = m ? ops.find(o => o.name === m.name) : null;
        return {
          id: r.id, shift: r.shift, name: r.name, sortOrder: r.sort_order,
          // มีบัญชีผู้ใช้ในระบบไหม + ผูกกะตรงกันไหม (ผูกคนละกะ = ต้องมีคนไปแก้)
          account: op ? { name: op.name, shift: op.shift || '', mismatch: !!op.shift && op.shift !== r.shift } : null,
        };
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// แก้รายชื่อทีมกะ — เดิมแก้ได้แต่ในโค้ด (DEFAULT_SHIFT_CREW) คนหน้างานเปลี่ยนเองไม่ได้
//   action: add | rename | move | remove   (remove = ปิด active ไม่ลบจริง — ยอดเก่ายังอ้างชื่อนี้อยู่)
app.post('/api/shift-crew', requireRole('supervisor'), async (req, res) => {
  const b = req.body || {};
  const action = String(b.action || '').trim();
  const name = String(b.name || '').trim();
  const shift = String(b.shift || '').trim();
  if (!name) return res.status(400).json({ error: 'ต้องมีชื่อ' });
  if (shift && !SHIFT_CODES.includes(shift)) return res.status(400).json({ error: 'กะต้องเป็น กะ1 / กะ2 / กะ3' });
  try {
    if (action === 'add') {
      if (!shift) return res.status(400).json({ error: 'ต้องเลือกกะ' });
      const dup = (await dbAll('SELECT id, active FROM shift_crew WHERE shift = ? AND name = ?', [shift, name]))[0];
      if (dup && dup.active) return res.status(409).json({ error: `${name} อยู่ใน${shift} อยู่แล้ว` });
      if (dup) await db.exec('UPDATE shift_crew SET active = 1 WHERE id = ?', [dup.id]);   // เคยเอาออก → เอากลับเข้ามา
      else {
        const mx = (await dbAll('SELECT MAX(sort_order) AS m FROM shift_crew', []))[0] || {};
        await db.exec('INSERT INTO shift_crew (shift, name, sort_order) VALUES (?, ?, ?)', [shift, name, Number(mx.m || 0) + 1]);
      }
    } else if (action === 'rename') {
      const to = String(b.newName || '').trim();
      if (!to) return res.status(400).json({ error: 'ต้องมีชื่อใหม่' });
      await db.exec('UPDATE shift_crew SET name = ? WHERE name = ?', [to, name]);
    } else if (action === 'move') {
      if (!shift) return res.status(400).json({ error: 'ต้องเลือกกะปลายทาง' });
      await db.exec('UPDATE shift_crew SET shift = ? WHERE name = ?', [shift, name]);
    } else if (action === 'remove') {
      await db.exec('UPDATE shift_crew SET active = 0 WHERE name = ?', [name]);
    } else return res.status(400).json({ error: 'action ต้องเป็น add / rename / move / remove' });

    // แก้รายชื่อทีมกะแล้ว ลองผูกบัญชีผู้ใช้ที่ยังไม่มีกะให้ใหม่ (คนที่ตั้งเองไว้แล้วไม่ถูกแตะ)
    await autoLinkOperatorShifts();
    const rows = await dbAll('SELECT shift, name FROM shift_crew WHERE active = 1 ORDER BY sort_order, id', []);
    const byShift = {};
    for (const r of rows) (byShift[r.shift] = byShift[r.shift] || []).push(r.name);
    res.json({ success: true, shifts: byShift });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// แผนของ SKU นี้ในวัน+กะที่ระบุ (ให้ฟอร์มเติมช่อง "จำนวนแผนผลิต" เอง)
app.get('/api/production/plan-hint', async (req, res) => {
  const workDay = req.query.date || workDayBKK();
  const skuRows = await dbAll('SELECT * FROM sku_master WHERE keyword = ?', [req.query.sku || '']);
  const hint = await resolvePlanQty(workDay, req.query.shift, skuRows[0]);
  res.json({ ...hint, count_unit: skuRows[0]?.count_unit || 'กล่อง' });
});

// ── ① ฝ่ายผลิตลงยอด — รายการเดียว (คงไว้ให้ของเดิมใช้ได้) ──────────────────
app.post('/api/production/report', async (req, res) => {
  const b = req.body || {};
  const reporter = String(b.reporter || '').trim();
  if (!reporter) return res.status(400).json({ error: 'ต้องระบุชื่อผู้รายงาน' });

  const workDay = b.date || workDayBKK();
  const shift = String(b.shift || '').trim();
  const keyword = String(b.sku_keyword || '').trim();
  const prodQty = Number(b.prod_qty);

  try {
    // กันกดส่งซ้ำ (เน็ตช้าแล้วกดสองที) — รายการเดียวกันภายใน 2 นาที
    const dup = await dbAll(
      `SELECT report_id FROM production_reports
       WHERE work_day = ? AND shift = ? AND sku_keyword = ? AND prod_qty = ? AND created_at >= ?`,
      [workDay, shift, keyword, prodQty, bkkPlusHours(-2 / 60)]
    );
    if (dup.length) return res.status(409).json({ error: 'รายการนี้เพิ่งถูกส่งไปแล้ว', existing_report_id: dup[0].report_id });

    const token = crypto.randomBytes(24).toString('base64url');
    const expires = bkkPlusHours(VERIFY_TTL_HOURS);
    const header = { work_day: workDay, shift, reporter, crew: b.crew, ...b };
    const r = await createReportRow({ header, item: b, token, expires });

    const now = nowBKK();
    const sentVia = await notifyVerifyLink({
      verify_token: token, verify_expires_at: expires, product_name: r.product_name,
      report_date: workDay, shift, reporter_name: reporter, prod_qty: r.prod_qty, count_unit: r.count_unit,
      sku_keyword: r.sku_keyword,
    });
    await db.exec('UPDATE production_reports SET verify_sent_via=?, verify_sent_at=? WHERE report_id=?', [sentVia, now, r.report_id]);
    await logReportEvent(r.report_id, 'link_sent', 'system', `ช่องทาง: ${sentVia}`, sentVia);

    res.json({
      ok: true, report_id: r.report_id, verify_url: verifyUrlOf(token), verify_expires_at: expires,
      sent_via: sentVia, plan_qty: r.plan_qty, plan_source: r.plan_source,
      prod_pcs: r.prod_pcs, prod_status: r.prod_status,
    });
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
    console.error('[SPP] create report failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ①' ลงยอดทั้งกะเป็นชุดเดียว → ออกลิงก์เดียวให้คลัง ───────────────────────
// กะหนึ่งลง 8+ รายการ · ลิงก์รายการละอันคลังกดไม่ไหว
//
// แยกไส้ออกจาก route เพราะบอท Telegram เรียกเส้นทางเดียวกันนี้ (เหมือน createReportRow/decideReport)
// โยน Error พร้อม .httpStatus เมื่อข้อมูลไม่ผ่าน ให้ผู้เรียกจับไปตอบเอง
async function createProductionBatch({ header: h = {}, items = [], channel = 'web' }) {
  const reporter = String(h.reporter || '').trim();
  const shift = String(h.shift || '').trim();
  const workDay = h.date || h.work_day || workDayBKK();

  if (!reporter) throw badRequest('ต้องระบุชื่อผู้ลงยอด');
  if (!items.length) throw badRequest('ต้องมีอย่างน้อย 1 รายการ');

  // กันกดส่งซ้ำทั้งชุด — ชุดของกะเดียวกันโดยคนเดียวกันที่ยังไม่ถึงคลัง สร้างไม่เกิน 2 นาที
  const dup = await dbAll(
    `SELECT batch_id FROM production_batches
     WHERE work_day = ? AND shift = ? AND created_by = ?
       AND status IN ('pending_review','pending_warehouse') AND created_at >= ?`,
    [workDay, shift, reporter, bkkPlusHours(-2 / 60)]
  );
  if (dup.length) {
    throw Object.assign(new Error('ชุดนี้เพิ่งถูกส่งไปแล้ว'), { httpStatus: 409, existing_batch_id: dup[0].batch_id });
  }

  const batchId = 'BAT-' + Date.now();
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = bkkPlusHours(VERIFY_TTL_HOURS);
  const now = nowBKK();
  const header = { work_day: workDay, shift, reporter, crew: h.crew, ...h };

  // สร้าง batch ก่อน แล้วค่อยใส่รายการ — ถ้ารายการไหนพัง ลบชุดทิ้งทั้งหมด ไม่ทิ้งของครึ่ง ๆ
  await db.exec(
    `INSERT INTO production_batches
      (batch_id, work_day, shift, created_by, item_count, status, verify_token, verify_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?, 'pending_review', ?,?,?,?)`,
    [batchId, workDay, shift, reporter, items.length, token, expires, now, now]
  );

  const created = [];
  try {
    for (const item of items) {
      created.push(await createReportRow({ header, item, batchId, channel }));
    }
  } catch (e) {
    await db.exec('DELETE FROM production_reports WHERE batch_id = ?', [batchId]);
    await db.exec('DELETE FROM production_batches WHERE batch_id = ?', [batchId]);
    throw e;
  }

  // ตรวจความผิดปกติแล้วติดป้ายไว้ให้หัวหน้าดู — เป็น "ป้ายเตือน" ไม่ใช่คนตัดสิน
  // (กติกาเดิม: หัวหน้าอนุมัติทุกรายการ ไม่มี auto-approve)
  await flagBatchAnomalies(created).catch(e => console.error('[SPP] flag anomalies failed', e.message));

  // ❗ไม่ส่งลิงก์ให้คลังตรงนี้ — ข้อมูลต้องผ่านหัวหน้าตรวจในหน้า Admin ก่อนเสมอ
  // คลังจะได้ลิงก์ก็ต่อเมื่อหัวหน้ากด "ส่งให้คลังนับ" (POST .../send-to-warehouse) เท่านั้น
  for (const r of created) await logReportEvent(r.report_id, 'created', reporter, `ชุด ${batchId} · รอหัวหน้าตรวจ`, channel);
  const sentVia = await notifyReviewNeeded({ batch_id: batchId, work_day: workDay, shift, created_by: reporter }, created);

  console.log(`[SPP] batch ${batchId} created items=${created.length} → pending_review channel=${channel}`);
  return {
    batch_id: batchId, item_count: created.length, items: created,
    status: 'pending_review', notified_via: sentVia,
    // ยังไม่เปิดเผยลิงก์ตรงนี้ — ออกให้ตอนหัวหน้ากดส่งคลัง
    verify_expires_at: expires,
  };
}

// ── เพิ่มทีละรายการเข้าชุดของกะ (ทางเข้าจากบอท) ────────────────────────────
// ชุด = "กะ" ไม่ใช่ "คน" — แต่ละไลน์มีคนลงคนละคน แต่คลังต้องได้ลิงก์เดียวต่อกะ
// ยืนยันปุ๊บเขียน DB ปั๊บ (status=pending_review) หัวหน้าเห็นในหน้า Admin ทันทีระหว่างกะ
async function addReportToShiftBatch({ header = {}, item = {}, channel = 'telegram' }) {
  const workDay = header.date || header.work_day || workDayBKK();
  const shift = String(header.shift || '').trim();
  const reporter = String(header.reporter || '').trim();
  if (!shift) throw badRequest('ไม่รู้ว่ากะไหน');
  if (!reporter) throw badRequest('ต้องระบุชื่อผู้ลงยอด');

  let bt = (await dbAll(
    "SELECT * FROM production_batches WHERE work_day = ? AND shift = ? AND status = 'pending_review' ORDER BY id DESC",
    [workDay, shift]
  ))[0];

  const now = nowBKK();
  if (!bt) {
    const batchId = 'BAT-' + Date.now();
    const token = crypto.randomBytes(24).toString('base64url');
    await db.exec(
      `INSERT INTO production_batches
        (batch_id, work_day, shift, created_by, item_count, status, verify_token, verify_expires_at, created_at, updated_at)
       VALUES (?,?,?,?,0,'pending_review',?,?,?,?)`,
      // อายุลิงก์นับจากตอนหัวหน้ากดส่งคลัง — ตรงนี้ใส่ไว้ก่อนแล้วเขียนทับทีหลัง
      [batchId, workDay, shift, reporter, token, bkkPlusHours(VERIFY_TTL_HOURS), now, now]
    );
    bt = { batch_id: batchId, verify_token: token };
  }

  const created = await createReportRow({
    header: { ...header, work_day: workDay, shift, reporter }, item, batchId: bt.batch_id, channel,
  });
  await db.exec(
    `UPDATE production_batches
        SET item_count = (SELECT COUNT(*) FROM production_reports WHERE batch_id = ?), updated_at = ?
      WHERE batch_id = ?`,
    [bt.batch_id, now, bt.batch_id]
  );
  await flagBatchAnomalies([created]).catch(e => console.error('[SPP] flag failed', e.message));
  await logReportEvent(created.report_id, 'created', reporter, `ชุด ${bt.batch_id} · รอหัวหน้าตรวจ`, channel);
  return { ...created, batch_id: bt.batch_id };
}

// แจ้งหัวหน้าว่ามียอดเข้ามารอตรวจ — ไม่มีลิงก์คลังในข้อความนี้โดยตั้งใจ
async function notifyReviewNeeded(batch, reports) {
  const lines = [
    `📥 <b>ยอดผลิตเข้าใหม่ ${reports.length} รายการ</b> · ${escapeHtml(batch.work_day)} ${escapeHtml(batch.shift)}`,
    `ผู้ลงยอด: ${escapeHtml(batch.created_by)}`,
    '',
    ...reports.slice(0, 8).map(r => `• ${escapeHtml(r.product_name || r.sku_keyword)} — <b>${r.prod_qty}</b> ${escapeHtml(r.count_unit)}`),
    reports.length > 8 ? `… และอีก ${reports.length - 8} รายการ` : null,
    '',
    '🔎 รอหัวหน้าตรวจในหน้า Admin ก่อนส่งให้คลัง',
    `${PUBLIC_URL}/admin`,
  ].filter(Boolean).join('\n');
  try { await sendSppTelegram(lines); return 'telegram'; }
  catch (e) { console.error('[SPP] notify review failed', e.message); return 'none'; }
}

app.post('/api/production/batch', async (req, res) => {
  const b = req.body || {};
  try {
    const out = await createProductionBatch({ header: b.header || {}, items: Array.isArray(b.items) ? b.items : [] });
    res.json({
      ok: true, batch_id: out.batch_id, item_count: out.item_count,
      verify_url: out.verify_url, verify_expires_at: out.verify_expires_at, sent_via: out.sent_via,
      items: out.items,
    });
  } catch (e) {
    // ส่งซ้ำ (409) แนบ batch เดิมกลับไปด้วย เหมือนพฤติกรรมเดิมก่อนแยกฟังก์ชัน
    if (e.httpStatus) {
      return res.status(e.httpStatus).json({
        error: e.message, ...(e.existing_batch_id ? { existing_batch_id: e.existing_batch_id } : {}),
      });
    }
    console.error('[SPP] create batch failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// payload ที่ปลอดภัยต่อการส่งเป็นลิสต์ — ตัด base64 ของรูปออก เหลือแค่ธงว่า "มีรูปไหม"
function stripPhotoFromPayload(raw) {
  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch { return { payload: {}, has_pallet_photo: false }; }
  const { pallet_photo, ...rest } = p;
  return { payload: rest, has_pallet_photo: !!pallet_photo };
}

// ── รายการรายงาน (หน้าอนุมัติของหัวหน้า) ────────────────────────────────────
app.get('/api/production/reports', async (req, res) => {
  const date = req.query.date || workDayBKK();
  const status = req.query.status;
  try {
    const rows = status
      ? await dbAll('SELECT * FROM production_reports WHERE work_day = ? AND status = ? ORDER BY id DESC', [date, status])
      : await dbAll('SELECT * FROM production_reports WHERE work_day = ? ORDER BY id DESC', [date]);
    // ไม่ส่ง token ออกไปกับรายการ — ป้องกันหลุดผ่านหน้าจอที่ไม่เกี่ยว
    // และไม่ส่งรูปค้างพาเลท (base64 ใน payload) มากับลิสต์ — กะหนึ่ง 8+ รูปคือหลาย MB ต่อการโหลด 1 ครั้ง
    // อยากดูรูป → เรียก /api/production/report/:id ทีละใบ
    res.json({ date, items: rows.map(({ verify_token, payload, ...r }) => ({
      ...r, has_link: !!verify_token, ...stripPhotoFromPayload(payload),
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/production/report/:reportId', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [req.params.reportId]);
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบรายงานนี้' });
    const events = await dbAll('SELECT * FROM production_report_events WHERE report_id = ? ORDER BY id', [req.params.reportId]);
    const { verify_token, ...rep } = rows[0];
    res.json({ report: { ...rep, verify_url: verify_token ? verifyUrlOf(verify_token) : null }, events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ค้นย้อนหลัง / Timeline (เฟส 2) ──────────────────────────────────────────
// หน้าอนุมัติดูได้ทีละวัน · หน้านี้ดูข้ามช่วงวัน + กรองตาม SKU/กะ/สถานะ + สรุปยอดต่อ SKU
app.get('/api/production/history', async (req, res) => {
  const to = String(req.query.to || workDayBKK());
  const from = String(req.query.from || to);
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = ['work_day >= ?', 'work_day <= ?'];
  const params = [from, to];
  if (req.query.sku) { where.push('sku_keyword = ?'); params.push(String(req.query.sku)); }
  if (req.query.shift) { where.push('shift = ?'); params.push(String(req.query.shift)); }
  if (req.query.status) { where.push('status = ?'); params.push(String(req.query.status)); }
  if (req.query.q) {
    // ค้นแบบหลวม ๆ ด้วย LIKE — ใช้ได้ทั้ง SQLite และ Postgres (ไม่ใช้ฟังก์ชันเฉพาะ dialect)
    where.push('(product_name LIKE ? OR sku_keyword LIKE ? OR sku_code LIKE ? OR reporter_name LIKE ?)');
    const like = `%${String(req.query.q)}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.join(' AND ');

  try {
    const rows = await dbAll(
      `SELECT * FROM production_reports WHERE ${whereSql} ORDER BY work_day DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const totalRow = await dbAll(`SELECT COUNT(*) AS n FROM production_reports WHERE ${whereSql}`, params);
    const summary = await dbAll(
      `SELECT sku_keyword, product_name, count_unit,
              COUNT(*) AS reports,
              SUM(prod_qty) AS total_prod,
              SUM(COALESCE(approved_qty, wh_qty, prod_qty)) AS total_final
         FROM production_reports WHERE ${whereSql}
        GROUP BY sku_keyword, product_name, count_unit
        ORDER BY total_prod DESC`, params
    );
    res.json({
      from, to, total: Number(totalRow[0]?.n) || 0, limit, offset,
      items: rows.map(({ verify_token, payload, ...r }) => ({ ...r, ...stripPhotoFromPayload(payload) })),
      summary,
    });
  } catch (e) {
    console.error('[SPP] history failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// รูปค้างพาเลทของรายงานเดียว — โหลดตอนกดดูเท่านั้น ไม่ติดมากับลิสต์
app.get('/api/production/report/:reportId/pallet-photo', async (req, res) => {
  try {
    const rows = await dbAll('SELECT payload FROM production_reports WHERE report_id = ?', [req.params.reportId]);
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบรายงานนี้' });
    let payload = {};
    try { payload = JSON.parse(rows[0].payload || '{}'); } catch { /* payload เสีย */ }
    if (!payload.pallet_photo) return res.status(404).json({ error: 'รายงานนี้ไม่มีรูปค้างพาเลท' });
    res.json({ image: payload.pallet_photo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ③ หัวหน้าอนุมัติ (ทุกรายการ ไม่มี auto-approve แม้เลขตรงกัน) ─────────────
app.post('/api/production/report/:reportId/decide', async (req, res) => {
  const { approve, approver, approved_source, note } = req.body || {};
  if (!String(approver || '').trim()) return res.status(400).json({ error: 'ต้องระบุชื่อผู้อนุมัติ' });
  if (approve === false && !String(note || '').trim()) return res.status(400).json({ error: 'ปฏิเสธต้องระบุเหตุผล' });
  try {
    const out = await decideReport(req.params.reportId, approve !== false, String(approver).trim(), { approved_source, note, channel: 'web' });
    res.status(out.ok ? 200 : 409).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ③' หัวหน้า "ส่งกลับให้แก้" (เฟส 2) ────────────────────────────────────────
// ต่างจากปฏิเสธ: ปฏิเสธ = จบ · ส่งกลับแก้ = เด้งไปหาคนลงยอดใน Telegram แล้วรอส่งใหม่
// แก้ที่แถวเดิมเสมอ — ไม่ออกลิงก์คลังใหม่ (คลังนับของจริงไปแล้ว · กันลิงก์ท่วมกลุ่ม)
async function sendBackReport(reportId, actor, note, channel = 'web') {
  const r = (await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [reportId]))[0];
  if (!r) return { ok: false, message: 'ไม่พบรายงานนี้' };
  // ส่งกลับได้ 2 จังหวะ: ตอนหัวหน้าตรวจก่อนส่งคลัง (pending_review) และตอนอนุมัติหลังคลังนับ (pending_approval)
  // ถ้าส่งไปคลังแล้ว (pending_warehouse) ห้ามดึงกลับทางนี้ — คลังกำลังนับอยู่ ต้องยกเลิกลิงก์ก่อน
  const CAN_SEND_BACK = ['pending_review', 'pending_approval'];
  if (!CAN_SEND_BACK.includes(r.status)) {
    return { ok: false, message: `สถานะ "${r.status}" ส่งกลับให้แก้ไม่ได้`, status: r.status };
  }

  // จำไว้ว่าถูกดึงกลับมาจากขั้นไหน — พอแก้เสร็จต้องคืนไปที่เดิมเป๊ะ ๆ ห้ามข้ามขั้น
  // (ส่งกลับตอน pending_review = คลังยังไม่เคยเห็นใบนี้ ถ้าเด้งไป pending_approval เลยคือข้ามคลังทั้งขั้น)
  let backPl = {};
  try { backPl = JSON.parse(r.payload || '{}'); } catch { /* payload เสีย — เริ่มก้อนใหม่ */ }
  backPl.sent_back_from = r.status;

  const upd = await db.exec(
    `UPDATE production_reports SET status='needs_fix', fix_note=?, payload=?, updated_at=?
      WHERE report_id=? AND status=?`,
    [note, JSON.stringify(backPl), nowBKK(), reportId, r.status]
  );
  if (!upd.rowCount) return { ok: false, message: 'รายการนี้ถูกจัดการไปแล้ว' };
  await logReportEvent(reportId, 'sent_back', actor, note, channel, 'supervisor');

  // เด้งหาคนลงยอดในแชทเดิมถ้ารู้ว่าเป็นใคร ไม่รู้ก็ประกาศเข้ากลุ่ม
  const text = [
    '✏️ <b>หัวหน้าส่งกลับให้แก้</b>',
    `${escapeHtml(r.product_name || r.sku_keyword)} · ${escapeHtml(r.work_day)} ${escapeHtml(r.shift)}`,
    `ยอดที่ส่งไป: <b>${r.prod_qty} ${escapeHtml(r.count_unit)}</b>`,
    r.wh_qty != null ? `คลังนับได้: <b>${r.wh_qty} ${escapeHtml(r.count_unit)}</b>` : null,
    `\n📝 <i>${escapeHtml(note)}</i>`,
  ].filter(Boolean).join('\n');
  const kb = [[{ text: '✏️ แก้ไขรายการนี้', callback_data: `s:fix:${reportId}` }]];

  if (r.telegram_chat_id) await sppTg('sendMessage', { chat_id: r.telegram_chat_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
  else await sendSppTelegram(`${text}\n\n<i>(ลงยอดผ่านเว็บ — แก้ในหน้าลงยอดผลิต)</i>`);

  return { ok: true, status: 'needs_fix' };
}

app.post('/api/production/report/:reportId/send-back', async (req, res) => {
  const { actor, note } = req.body || {};
  if (!String(actor || '').trim()) return res.status(400).json({ error: 'ต้องระบุชื่อผู้ส่งกลับ' });
  if (!String(note || '').trim()) return res.status(400).json({ error: 'ต้องระบุว่าให้แก้อะไร' });
  try {
    const out = await sendBackReport(req.params.reportId, String(actor).trim(), String(note).trim(), 'web');
    res.status(out.ok ? 200 : 409).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ขั้นที่ 4: หัวหน้าตรวจก่อนส่งคลัง ────────────────────────────────────
// ช่องที่หัวหน้าแก้ได้ตอน pending_review · นอกลิสต์นี้แก้ไม่ได้ (กันแก้ยอดคลัง/สถานะ/token)
// ⚠️ counter / machine_cycle ไม่ใช่คอลัมน์จริง — มันเป็นคีย์ใน JSON คอลัมน์ payload (ดู createReportRow)
//    เคยรวมไว้ในลิสต์เดียวกัน UPDATE เลยยิงใส่คอลัมน์ที่ไม่มีอยู่ → 500 ทุกครั้งที่หัวหน้าแก้เลขหน้าเครื่อง
//    (ทั้ง Postgres และ SQLite ฟ้องเหมือนกัน ที่หลุดถึงหน้างานเพราะไม่มีเทสต์ตัวไหนแตะ counter เลย)
//    สองลิสต์นี้ห้ามเอามารวมกันอีก
const REVIEW_EDITABLE = ['sku_keyword', 'product_name', 'machine', 'reporter_name', 'prod_qty'];
const REVIEW_EDITABLE_PAYLOAD = ['counter', 'machine_cycle'];
const REVIEW_NUMERIC = ['prod_qty', 'counter', 'machine_cycle'];

// แก้ค่าก่อนส่งคลัง — ล็อกทันทีที่ออกจาก pending_review เพราะคลังนับเทียบกับเลขที่ส่งไป
app.patch('/api/production/report/:reportId', async (req, res) => {
  const actor = String(req.body?.actor || '').trim();
  if (!actor) return res.status(400).json({ error: 'ต้องระบุชื่อผู้แก้' });
  try {
    const rows = await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [req.params.reportId]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'ไม่พบรายการนี้' });
    if (r.status !== 'pending_review') {
      return res.status(409).json({ error: 'แก้ได้เฉพาะก่อนส่งให้คลัง — รายการนี้ส่งไปแล้ว ต้องดึงกลับก่อน' });
    }

    const sets = [], vals = [], changes = [];
    const patch = req.body?.fields || {};
    for (const k of REVIEW_EDITABLE) {
      if (!(k in patch)) continue;
      const isNum = REVIEW_NUMERIC.includes(k);
      const before = r[k];
      const after = isNum ? Math.round(Number(patch[k])) : String(patch[k]).trim();
      if (isNum && (!Number.isFinite(after) || after < 0)) {
        return res.status(400).json({ error: `ค่า ${k} ไม่ถูกต้อง` });
      }
      if (String(before ?? '') === String(after)) continue;
      sets.push(`${k}=?`); vals.push(after);
      changes.push(`${k}: ${before ?? '-'} → ${after}`);
    }

    // prod_qty เปลี่ยน → ชิ้นต้องคิดใหม่ฝั่ง server เสมอ (ห้ามให้ client ส่ง pcs มาเอง)
    if ('prod_qty' in patch) {
      sets.push('prod_pcs=?'); vals.push(Math.round(Number(patch.prod_qty)) * (Number(r.pack_factor) || 0));
    }

    // ── ของที่อยู่ใน payload: เลขหน้าเครื่อง/รอบเดินเครื่อง + ของเสีย 5 ช่อง + รูปค้างพาเลท ──
    // อ่านทั้งก้อนครั้งเดียว แก้ในหน่วยความจำ แล้วเขียนกลับครั้งเดียว — payload เขียนทับทั้งก้อน
    // ถ้าแยกกันเขียนหลายรอบ ของที่ไม่ได้แก้จะหายไป
    let pl = null;
    let payloadDirty = false;
    const openPayload = () => {
      if (pl === null) {
        try { pl = JSON.parse(r.payload || '{}'); } catch { pl = {}; }   // payload เสีย — เริ่มก้อนใหม่
      }
      return pl;
    };
    for (const k of REVIEW_EDITABLE_PAYLOAD) {
      if (!(k in patch)) continue;
      const after = Math.round(Number(patch[k]));
      if (!Number.isFinite(after) || after < 0) {
        return res.status(400).json({ error: `ค่า ${k} ไม่ถูกต้อง` });
      }
      const p = openPayload();
      const before = Number(p[k]) || 0;
      if (before === after) continue;
      p[k] = after; payloadDirty = true;
      changes.push(`${k}: ${before} → ${after}`);
    }
    if (patch.damaged) { openPayload().damaged = patch.damaged; payloadDirty = true; changes.push('ภาชนะบรรจุชำรุด'); }
    if ('pallet_photo' in patch) {
      const p = openPayload();
      if (patch.pallet_photo) p.pallet_photo = patch.pallet_photo; else delete p.pallet_photo;
      payloadDirty = true;
      changes.push(patch.pallet_photo ? 'เปลี่ยนรูปค้างพาเลท' : 'ลบรูปค้างพาเลท');
    }
    if (payloadDirty) { sets.push('payload=?'); vals.push(JSON.stringify(pl)); }
    if (!sets.length) return res.json({ ok: true, changed: 0, message: 'ไม่มีอะไรเปลี่ยน' });

    const now = nowBKK();
    sets.push('edited_at=?', 'edited_by=?', 'edit_count=COALESCE(edit_count,0)+1', 'updated_at=?');
    vals.push(now, actor, now, req.params.reportId);
    // แก้ได้เฉพาะตอนยัง pending_review — เช็คซ้ำใน WHERE กัน race กับปุ่มส่งคลัง
    const upd = await db.exec(
      `UPDATE production_reports SET ${sets.join(', ')} WHERE report_id=? AND status='pending_review'`, vals);
    if (!upd.rowCount) return res.status(409).json({ error: 'รายการเพิ่งถูกส่งให้คลัง แก้ไม่ได้แล้ว' });

    await logReportEvent(req.params.reportId, 'edited', actor, changes.join(' · '), 'web', 'supervisor');
    res.json({ ok: true, changed: changes.length, changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// หัวหน้ากด "ตรวจแล้ว" รายตัว (กดซ้ำ = ยกเลิกการตรวจ)
app.post('/api/production/report/:reportId/review', async (req, res) => {
  const actor = String(req.body?.actor || '').trim();
  if (!actor) return res.status(400).json({ error: 'ต้องระบุชื่อผู้ตรวจ' });
  const undo = req.body?.undo === true;
  try {
    const upd = await db.exec(
      `UPDATE production_reports SET reviewed_at=?, reviewed_by=?, updated_at=?
        WHERE report_id=? AND status='pending_review'`,
      [undo ? null : nowBKK(), undo ? null : actor, nowBKK(), req.params.reportId]
    );
    if (!upd.rowCount) return res.status(409).json({ error: 'รายการนี้ไม่ได้อยู่ในขั้นรอหัวหน้าตรวจ' });
    await logReportEvent(req.params.reportId, undo ? 'review_undone' : 'reviewed', actor,
      undo ? 'ยกเลิกการตรวจ' : 'หัวหน้าตรวจแล้ว', 'web', 'supervisor');
    res.json({ ok: true, reviewed: !undo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ส่งให้คลังนับ — ทางเดียวที่ข้อมูลจะถึงคลังได้ · ต้องตรวจครบทุกรายการก่อน
app.post('/api/production/batch/:batchId/send-to-warehouse', async (req, res) => {
  const actor = String(req.body?.actor || '').trim();
  if (!actor) return res.status(400).json({ error: 'ต้องระบุชื่อหัวหน้าที่ส่ง' });
  try {
    const batches = await dbAll('SELECT * FROM production_batches WHERE batch_id = ?', [req.params.batchId]);
    const bt = batches[0];
    if (!bt) return res.status(404).json({ error: 'ไม่พบชุดนี้' });
    if (bt.status !== 'pending_review') return res.status(409).json({ error: 'ชุดนี้ส่งให้คลังไปแล้ว' });

    const rows = await dbAll("SELECT * FROM production_reports WHERE batch_id = ? AND status='pending_review' ORDER BY id",
      [req.params.batchId]);
    if (!rows.length) return res.status(409).json({ error: 'ไม่มีรายการที่รอตรวจในชุดนี้' });
    const notYet = rows.filter(r => !r.reviewed_at);
    if (notYet.length) {
      return res.status(409).json({
        error: `ยังตรวจไม่ครบ — เหลืออีก ${notYet.length} รายการ`,
        pending: notYet.map(r => r.product_name || r.sku_keyword),
      });
    }

    // ต่ออายุลิงก์จากตอนกดส่ง (ไม่ใช่ตอนพนักงานลงยอด) — คลังจะได้เวลาเต็มตามกำหนด
    const now = nowBKK();
    const expires = bkkPlusHours(VERIFY_TTL_HOURS);
    const upd = await db.exec(
      `UPDATE production_batches SET status='pending_warehouse', verify_expires_at=?, reviewed_by=?, reviewed_at=?, updated_at=?
        WHERE batch_id=? AND status='pending_review'`,
      [expires, actor, now, now, req.params.batchId]
    );
    if (!upd.rowCount) return res.status(409).json({ error: 'ชุดนี้เพิ่งถูกส่งไปแล้ว' });
    await db.exec(
      `UPDATE production_reports SET status='pending_warehouse', verify_expires_at=?, updated_at=?
        WHERE batch_id=? AND status='pending_review'`,
      [expires, now, req.params.batchId]
    );

    const sentVia = await notifyBatchLink(
      { batch_id: bt.batch_id, work_day: bt.work_day, shift: bt.shift, created_by: bt.created_by,
        verify_token: bt.verify_token, verify_expires_at: expires },
      rows
    );
    await db.exec('UPDATE production_batches SET sent_via=?, sent_at=?, updated_at=? WHERE batch_id=?',
      [sentVia, now, now, req.params.batchId]);
    for (const r of rows) {
      await logReportEvent(r.report_id, 'sent_to_warehouse', actor, `หัวหน้าตรวจครบแล้ว · ช่องทาง: ${sentVia}`, sentVia, 'supervisor');
    }
    res.json({ ok: true, sent: rows.length, sent_via: sentVia, verify_url: verifyUrlOf(bt.verify_token), verify_expires_at: expires });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// อนุมัติ/ปฏิเสธทั้งชุด — วนใช้ decideReport() เดิม (guard กันตัดสินซ้ำทำงานอยู่แล้ว)
app.post('/api/production/batch/:batchId/decide', async (req, res) => {
  const { approve, approver, approved_source, note } = req.body || {};
  if (!String(approver || '').trim()) return res.status(400).json({ error: 'ต้องระบุชื่อผู้อนุมัติ' });
  if (approve === false && !String(note || '').trim()) return res.status(400).json({ error: 'ปฏิเสธต้องระบุเหตุผล' });
  try {
    const rows = await dbAll(
      "SELECT report_id FROM production_reports WHERE batch_id = ? AND status = 'pending_approval' ORDER BY id",
      [req.params.batchId]
    );
    if (!rows.length) return res.status(409).json({ error: 'ไม่มีรายการที่รออนุมัติในชุดนี้' });

    const done = [], failed = [];
    for (const r of rows) {
      const out = await decideReport(r.report_id, approve !== false, String(approver).trim(), { approved_source, note, channel: 'web' });
      (out.ok ? done : failed).push({ report_id: r.report_id, message: out.message });
    }
    const now = nowBKK();
    await db.exec("UPDATE production_batches SET status='closed', updated_at=? WHERE batch_id=?", [now, req.params.batchId]);
    // อนุมัติแล้ว → ยิงการ์ดให้คลังกดรับทราบในกลุ่ม LINE (ไม่ตั้ง env ก็ข้ามไป ไม่ทำให้ตอบช้า/พัง)
    let lineSent = 'none';
    if (approve !== false) lineSent = await pushWarehouseCard(req.params.batchId).catch(() => 'none');
    res.json({ ok: true, decided: done.length, failed: failed.length, failures: failed, line_sent: lineSent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ออกลิงก์ใหม่ให้คลัง (ของเดิมหมดอายุ/ส่งผิดกลุ่ม) — token เก่าใช้ไม่ได้ทันที
app.post('/api/production/report/:reportId/resend-link', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [req.params.reportId]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'ไม่พบรายงานนี้' });
    if (r.status !== 'pending_warehouse') return res.status(409).json({ error: 'รายการนี้ไม่ได้รอคลังตรวจนับแล้ว' });
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = bkkPlusHours(VERIFY_TTL_HOURS);
    await db.exec('UPDATE production_reports SET verify_token=?, verify_expires_at=?, updated_at=? WHERE report_id=?',
      [token, expires, nowBKK(), req.params.reportId]);
    const sentVia = await notifyVerifyLink({ ...r, verify_token: token, verify_expires_at: expires });
    await logReportEvent(req.params.reportId, 'link_issued', req.body?.actor || '', `ออกลิงก์ใหม่ (${sentVia})`, sentVia);
    res.json({ ok: true, verify_url: verifyUrlOf(token), verify_expires_at: expires, sent_via: sentVia });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ② หน้าคลังตรวจนับ (สาธารณะ ไม่ต้อง login · token ใช้ครั้งเดียว) ──────────
app.get('/api/production/verify/:token', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  try {
    // ชุดก่อน แล้วค่อยรายการเดี่ยว (ลิงก์เก่าที่ออกก่อนมี batch ต้องยังใช้ได้)
    const batches = await dbAll('SELECT * FROM production_batches WHERE verify_token = ?', [req.params.token]);
    const bt = batches[0];
    if (bt) {
      if (bt.status !== 'pending_warehouse') {
        return res.status(409).json({ error: 'ชุดนี้ยืนยันไปแล้ว', wh_name: bt.wh_name, submitted_at: bt.wh_submitted_at });
      }
      if (bt.verify_expires_at && bt.verify_expires_at < nowBKK()) {
        return res.status(410).json({ error: 'ลิงก์หมดอายุแล้ว — ขอลิงก์ใหม่จากฝ่ายผลิต' });
      }
      const its = await dbAll(
        `SELECT report_id, product_name, sku_keyword, group_name, machine, count_unit, prod_qty
           FROM production_reports WHERE batch_id = ? ORDER BY id`, [bt.batch_id]);
      return res.json({
        type: 'batch', batch_id: bt.batch_id, date: bt.work_day, shift: bt.shift,
        reporter_name: bt.created_by, expires_at: bt.verify_expires_at,
        items: its.map(i => ({
          report_id: i.report_id, product_name: i.product_name || i.sku_keyword,
          group_name: i.group_name, machine: i.machine, count_unit: i.count_unit, prod_qty: i.prod_qty,
        })),
      });
    }

    const rows = await dbAll('SELECT * FROM production_reports WHERE verify_token = ?', [req.params.token]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'ไม่พบลิงก์นี้ (อาจถูกออกใหม่ไปแล้ว)' });
    if (r.status !== 'pending_warehouse') {
      return res.status(409).json({ error: 'รายการนี้ยืนยันไปแล้ว', wh_qty: r.wh_qty, wh_name: r.wh_name, submitted_at: r.wh_submitted_at });
    }
    if (r.verify_expires_at && r.verify_expires_at < nowBKK()) {
      return res.status(410).json({ error: 'ลิงก์หมดอายุแล้ว — ขอลิงก์ใหม่จากฝ่ายผลิต' });
    }
    // คืนเฉพาะที่จำเป็น ไม่คืน row เต็ม ไม่คืน id/token
    res.json({
      report_id: r.report_id, date: r.report_date, shift: r.shift,
      product_name: r.product_name || r.sku_keyword, group_name: r.group_name,
      count_unit: r.count_unit, prod_qty: r.prod_qty, reporter_name: r.reporter_name,
      expires_at: r.verify_expires_at,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/production/verify/:token', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  const whName = String(req.body?.wh_name || '').trim();
  if (!whName) return res.status(400).json({ error: 'กรุณาระบุชื่อผู้ตรวจนับ' });

  // ── โหมดชุด: กรอกทุกรายการในหน้าเดียว ยืนยันครั้งเดียว ──
  const batches = await dbAll('SELECT * FROM production_batches WHERE verify_token = ?', [req.params.token]).catch(() => []);
  if (batches[0]) {
    const bt = batches[0];
    try {
      if (bt.status !== 'pending_warehouse') return res.status(409).json({ error: 'ชุดนี้ยืนยันไปแล้ว' });
      if (bt.verify_expires_at && bt.verify_expires_at < nowBKK()) return res.status(410).json({ error: 'ลิงก์หมดอายุแล้ว' });

      const rows = await dbAll('SELECT * FROM production_reports WHERE batch_id = ? ORDER BY id', [bt.batch_id]);
      const byId = Object.fromEntries(rows.map(r => [r.report_id, r]));
      const sent = Array.isArray(req.body?.items) ? req.body.items : [];
      if (sent.length !== rows.length) {
        return res.status(400).json({ error: `ต้องกรอกให้ครบทุกรายการ (${sent.length}/${rows.length})` });
      }

      // ตรวจก่อนเขียน: report_id ต้องอยู่ในชุดนี้จริง และตัวเลขต้องใช้ได้
      const calc = [];
      for (const s of sent) {
        const r = byId[s.report_id];
        if (!r) return res.status(400).json({ error: 'มีรายการที่ไม่ได้อยู่ในชุดนี้' });
        const q = Number(s.wh_qty);
        if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: `จำนวนของ "${r.product_name || r.sku_keyword}" ไม่ถูกต้อง` });
        const diff = q - (Number(r.prod_qty) || 0);
        calc.push({ r, wh_qty: q, wh_note: String(s.wh_note || ''), diff,
                    pct: r.prod_qty ? Math.round((diff / r.prod_qty) * 1000) / 10 : 0,
                    reason: String(s.variance_reason || '') });
      }

      // มีรายการที่ไม่ตรง → ถามยืนยันรอบเดียว (ไม่บล็อก ไม่แก้เลขให้)
      const diffs = calc.filter(c => c.diff !== 0);
      if (diffs.length && !req.body?.confirm_variance) {
        return res.json({
          needs_confirm: true,
          diffs: diffs.map(c => ({
            report_id: c.r.report_id, product_name: c.r.product_name || c.r.sku_keyword,
            count_unit: c.r.count_unit, prod_qty: c.r.prod_qty, wh_qty: c.wh_qty, variance_qty: c.diff,
          })),
        });
      }

      // single-use ที่ระดับชุด — race-free ด้วย conditional UPDATE + rowCount
      const now = nowBKK();
      const upd = await db.exec(
        `UPDATE production_batches
            SET status='pending_approval', wh_name=?, wh_submitted_at=?, verify_used_at=?, updated_at=?
          WHERE verify_token=? AND status='pending_warehouse'`,
        [whName, now, now, now, req.params.token]
      );
      if (!upd.rowCount) return res.status(409).json({ error: 'ลิงก์นี้ถูกใช้ไปแล้วหรือหมดอายุ' });

      for (const c of calc) {
        await db.exec(
          `UPDATE production_reports
              SET wh_qty=?, wh_pcs=?, wh_name=?, wh_note=?, wh_submitted_at=?,
                  variance_qty=?, variance_pct=?, variance_flag=?, variance_reason=?,
                  status='pending_approval', verify_used_at=?, updated_at=?
            WHERE report_id=? AND status='pending_warehouse'`,
          [c.wh_qty, c.wh_qty * (Number(c.r.pack_factor) || 0), whName, c.wh_note, now,
           c.diff, c.pct, c.diff === 0 ? 'match' : 'diff', c.reason, now, now, c.r.report_id]
        );
        await logReportEvent(c.r.report_id, 'warehouse_submitted', whName,
          `คลังนับได้ ${c.wh_qty} ${c.r.count_unit}${c.diff !== 0 ? ` (ต่าง ${c.diff > 0 ? '+' : ''}${c.diff})` : ' (ตรงกัน)'}`, 'web', 'warehouse');
      }

      // แนบปุ่มให้หัวหน้าอนุมัติทั้งชุดได้จากแชทเลย — เรียก decideReport() ตัวเดียวกับเว็บ
      sendSppTelegram([
        `📥 <b>คลังยืนยันแล้ว ${calc.length} รายการ</b> · ${escapeHtml(bt.work_day)} ${escapeHtml(bt.shift)}`,
        `ตรงกัน ${calc.length - diffs.length} · ต่าง <b>${diffs.length}</b>`,
        ...diffs.map(c => `• ${escapeHtml(c.r.product_name || c.r.sku_keyword)}: แจ้ง ${c.r.prod_qty} → นับได้ <b>${c.wh_qty}</b> (${c.diff > 0 ? '+' : ''}${c.diff} ${escapeHtml(c.r.count_unit)})`),
        `ผู้ตรวจนับ: ${escapeHtml(whName)} · รอหัวหน้างานอนุมัติ`,
      ].join('\n'), {
        reply_markup: { inline_keyboard: [
          [{ text: '✅ อนุมัติทั้งชุด', callback_data: `s:appb:${bt.batch_id}` }],
          [{ text: '🔍 เปิดในแอป', url: `${APP_PUBLIC_URL}/` }],
        ] },
      }).catch(() => {});

      return res.json({
        ok: true, batch_id: bt.batch_id, item_count: calc.length,
        matched: calc.length - diffs.length, diff_count: diffs.length,
      });
    } catch (e) {
      console.error('[SPP] batch verify failed', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── โหมดรายการเดียว (ลิงก์เก่า) ──
  const whQty = Number(req.body?.wh_qty);
  if (!Number.isFinite(whQty) || whQty < 0) return res.status(400).json({ error: 'จำนวนที่นับได้ไม่ถูกต้อง' });
  try {
    const rows = await dbAll('SELECT * FROM production_reports WHERE verify_token = ?', [req.params.token]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'ไม่พบลิงก์นี้' });
    if (r.status !== 'pending_warehouse') return res.status(409).json({ error: 'รายการนี้ยืนยันไปแล้ว' });
    if (r.verify_expires_at && r.verify_expires_at < nowBKK()) return res.status(410).json({ error: 'ลิงก์หมดอายุแล้ว' });

    const diff = whQty - (Number(r.prod_qty) || 0);
    // ต่างจากที่ผลิตแจ้ง → ถามยืนยันรอบเดียวก่อน (ไม่บล็อก ไม่แก้เลขให้)
    if (diff !== 0 && !req.body?.confirm_variance) {
      return res.json({ needs_confirm: true, variance_qty: diff, prod_qty: r.prod_qty, count_unit: r.count_unit });
    }
    const now = nowBKK();
    const pct = r.prod_qty ? Math.round((diff / r.prod_qty) * 1000) / 10 : 0;
    // single-use แบบ race-free: เงื่อนไขอยู่ใน WHERE แล้วเช็ค rowCount (ไม่ต้องใช้ transaction)
    const upd = await db.exec(
      `UPDATE production_reports
         SET wh_qty=?, wh_pcs=?, wh_name=?, wh_note=?, wh_submitted_at=?,
             variance_qty=?, variance_pct=?, variance_flag=?, variance_reason=?,
             status='pending_approval', verify_used_at=?, updated_at=?
       WHERE verify_token=? AND status='pending_warehouse'`,
      [whQty, whQty * (Number(r.pack_factor) || 0), whName, String(req.body?.wh_note || ''), now,
       diff, pct, diff === 0 ? 'match' : 'diff', String(req.body?.variance_reason || ''), now, now, req.params.token]
    );
    if (!upd.rowCount) return res.status(409).json({ error: 'ลิงก์นี้ถูกใช้ไปแล้วหรือหมดอายุ' });

    await logReportEvent(r.report_id, 'warehouse_submitted', whName,
      `คลังนับได้ ${whQty} ${r.count_unit}${diff !== 0 ? ` (ต่าง ${diff > 0 ? '+' : ''}${diff})` : ' (ตรงกัน)'}`, 'web', 'warehouse');
    sendSppTelegram([
      diff === 0 ? '✅ <b>คลังยืนยันแล้ว — ตัวเลขตรงกัน</b>' : '⚠️ <b>คลังยืนยันแล้ว — ตัวเลขไม่ตรง</b>',
      `${escapeHtml(r.product_name || r.sku_keyword)} · ${escapeHtml(r.shift)}`,
      `ฝ่ายผลิตแจ้ง ${r.prod_qty} ${escapeHtml(r.count_unit)} · คลังนับได้ <b>${whQty} ${escapeHtml(r.count_unit)}</b>`,
      diff !== 0 ? `ผลต่าง: <b>${diff > 0 ? '+' : ''}${diff}</b>${req.body?.variance_reason ? ` — ${escapeHtml(String(req.body.variance_reason))}` : ''}` : null,
      `ผู้ตรวจนับ: ${escapeHtml(whName)} · รอหัวหน้างานอนุมัติ`,
    ].filter(Boolean).join('\n')).catch(() => {});

    res.json({ ok: true, variance_qty: diff, count_unit: r.count_unit, product_name: r.product_name || r.sku_keyword });
  } catch (e) {
    console.error('[SPP] verify submit failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// บอท Production_SPP (เฟส 2) — กรอกยอดผลิตจบในแชท Telegram
//   "แผนผลิตวันนี้" → เลือกสินค้า → เดินฟอร์มทีละช่อง → เก็บเข้าร่างของกะ
//   → กด "ส่งทั้งกะ" ครั้งเดียว → createProductionBatch() เส้นทางเดียวกับเว็บ (1 ลิงก์ต่อกะ)
// ร่างเก็บลง spp_tg_session (DB) ไม่ใช่ RAM — Render free tier หลับได้ตลอด
// ใช้แพตเทิร์นเดียวกับบอท duty ที่ /api/telegram/duty-update
// ═══════════════════════════════════════════════════════════════════════════

const SPP_DAMAGE_KINDS = [
  { key: 'ถุง', re: /ถุง(?!\s*pack)/i },
  { key: 'กล่อง', re: /กล่อง/i },
  { key: 'ถุง pack', re: /ถุง\s*pack|pack/i },
  { key: 'ขวด/กระปุก', re: /ขวด|กระปุก/i },
  { key: 'ฝา', re: /ฝา/i },
];

// ── ข้อ 2: พิมพ์ประโยคเดียวจบ ──────────────────────────────────────────────
// แกะข้อความไทยแบบพูดปกติเป็นฟอร์มลงยอด เช่น
//   "Amazon 750 ได้ 120 กล่อง เครื่อง Linear#1 เลข 1440"
//   "Icing 25 kg ได้ 200 กระสอบ เครื่อง - เลขหน้าเครื่อง 200"
//
// ใช้ structured outputs (json_schema) ไม่ใช่ tool use — งานนี้ไม่มี side effect
// ต้องการแค่ JSON ที่ถูกโครงแน่นอน · json_schema การันตีรูปให้เลย ไม่ต้องกัน AI
// ตอบเป็นข้อความปนมา
//
// ปิด thinking + effort low เพราะเป็นงานแกะสั้น ๆ ที่เรียกทุกครั้งที่พนักงานพิมพ์:
// บน Opus 5 thinking เปิดเป็นค่าเริ่มต้น และ max_tokens คุมทั้ง thinking+คำตอบรวมกัน
// ถ้าปล่อยเปิดต้องเผื่อ max_tokens เยอะขึ้นมากโดยไม่ได้อะไรกลับมา
// (ปิด thinking ใช้ได้เมื่อ effort ไม่เกิน high — low ผ่าน)

const SPP_PARSE_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      // ⚠️ ให้คืน "ข้อความส่วนที่เป็นชื่อสินค้า" ตามที่พนักงานพิมพ์เท่านั้น ห้ามเลือก SKU
      //    ตัวจับคู่ (resolveSku) เป็นคนหาเอง กำกวมเมื่อไหร่ก็ยื่นปุ่มให้คนกด
      //    เคยให้โมเดลเลือกเองแล้วมันไปหยิบชื่อจาก SKU master มาสวม และเลือก SKU ของคนละเครื่อง
      product_text: { type: 'string', description: 'ชื่อสินค้าตามที่พิมพ์มาเป๊ะ ๆ ไม่ต้องแปลง ไม่ต้องเทียบกับรายการใด ๆ เช่น "Syrup 800" · ไม่มีให้ใส่ ""' },
      prod_qty: { type: 'number', description: 'จำนวนที่ผลิตได้ (ตัวเลขล้วน) · ไม่ได้บอกให้ใส่ 0' },
      machine: { type: 'string', description: 'ชื่อเครื่องบรรจุตามที่พิมพ์มา · ถ้าเขียน "-" หรือไม่ได้บอกให้ใส่ ""' },
      counter: { type: 'number', description: 'เลขหน้าเครื่อง หน่วยชิ้น · ไม่ได้บอกให้ใส่ 0 (และต้องใส่ "counter" ใน missing ด้วย เพราะ 0 เป็นค่าที่ใช้จริงได้)' },
      damaged: {
        type: 'object',
        description: 'ภาชนะบรรจุชำรุด · ประเภทที่ไม่ได้พูดถึงให้ใส่ 0',
        properties: {
          'ถุง': { type: 'number' }, 'กล่อง': { type: 'number' }, 'ถุง pack': { type: 'number' },
          'ขวด/กระปุก': { type: 'number' }, 'ฝา': { type: 'number' },
        },
        required: ['ถุง', 'กล่อง', 'ถุง pack', 'ขวด/กระปุก', 'ฝา'],
        additionalProperties: false,
      },
      missing: {
        type: 'array',
        description: 'ชื่อช่องที่ข้อความไม่ได้พูดถึงเลย — บอทจะไปถามต่อเฉพาะช่องพวกนี้',
        items: { type: 'string', enum: ['product_text', 'prod_qty', 'machine', 'counter'] },
      },
      note: { type: 'string', description: 'อ่านไม่ออกตรงไหน บอกสั้น ๆ เป็นภาษาไทย · ปกติใส่ ""' },
    },
    required: ['product_text', 'prod_qty', 'machine', 'counter', 'damaged', 'missing', 'note'],
    additionalProperties: false,
  },
};

// คืน null เมื่อไม่ได้ตั้ง ANTHROPIC_API_KEY หรือ AI ล่ม → บอทถอยไปโหมดกดปุ่มเอง
async function parseSppFreeText(text) {
  if (!ai.available('parse')) return null;

  try {
    const resp = await ai.createMessage('parse', {
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: SPP_PARSE_FORMAT },
      system: [{
        type: 'text',
        // ก้อนนี้คงที่แล้ว (ไม่มีรายการ SKU ปนอีก) → cache ได้เต็ม ๆ และไม่พังเมื่อ SKU เปลี่ยน
        text: [
          'คุณคือตัวช่วยแกะข้อความลงยอดผลิตของโรงงาน แปลงประโยคภาษาไทยที่พนักงานพิมพ์เป็นข้อมูลตามสคีมา',
          '',
          'กติกา:',
          '- product_text = ลอกชื่อสินค้าตามที่พิมพ์มาเป๊ะ ๆ ("Syrup 800", "ปี๊บ 1×20") ห้ามแปลง ห้ามเติม ห้ามย่อ',
          '- คุณไม่มีรายการสินค้าและไม่ต้องมี — ระบบจับคู่กับ SKU เอง หน้าที่คุณคือแยกส่วนของประโยคเท่านั้น',
          '- ตัวเลขที่ตามด้วยหน่วยนับ (กล่อง/กระสอบ/หม้อ/ปี๊บ) คือ prod_qty',
          '- ตัวเลขที่มาหลังคำว่า "เลข" หรือ "เลขหน้าเครื่อง" หรือ "counter" คือ counter',
          '- machine = ชื่อเครื่องตามที่พิมพ์มา ("Linear#3", "L3") · เขียน "-" หรือไม่ได้บอกให้ใส่ ""',
          '- อย่าเดาค่าที่ข้อความไม่ได้บอก ให้ใส่ค่าว่าง/0 แล้วระบุชื่อช่องนั้นใน missing',
          // เจอตอนย้ายไป Kimi (7 ก.ย.): ตัวเลขจำนวนติดมาใน product_text ("golden 80") → จับคู่ SKU พลาด
          // กติกานี้แก้ได้ตรงจุดโดยไม่กระทบชื่อที่มีเลขจริง ("Syrup 800", "ปี๊บ 1x20") — ทดสอบเทียบแล้ว
          '- ตัวเลขที่นับเป็น prod_qty หรือ counter แล้ว ห้ามติดอยู่ใน product_text อีก ("golden 80 กล่อง" → product_text="golden") · แต่ตัวเลขที่เป็นส่วนหนึ่งของชื่อสินค้าเองต้องเก็บไว้ ("Syrup 800", "ปี๊บ 1x20")',
        ].join('\n'),
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: String(text).slice(0, 500) }],
    });

    if (resp.stop_reason === 'refusal') { console.error('[SPP parse] refused'); return null; }
    const block = resp.content.find(b => b.type === 'text');
    if (!block) return null;
    return JSON.parse(block.text);
  } catch (e) {
    console.error('[SPP parse] failed', e.message);
    return null;
  }
}

// กะปัจจุบันตามตารางโรงงาน (เดินจริง 7 วัน) → คืนรูปแบบเดียวกับฟอร์มเว็บและ shift_crew: กะ1/กะ2/กะ3
function currentShiftCode() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const h = now.getHours();
  const shifts = factoryShiftsForWeekday(now.getDay());
  if (shifts.length === 2) return (h >= 6 && h < 18) ? 'กะ1' : 'กะ3';
  if (h >= 6 && h < 14) return 'กะ1';
  if (h >= 14 && h < 22) return 'กะ2';
  return 'กะ3';
}

// ── state ของบทสนทนา ────────────────────────────────────────────────────────
// state ค้างเกิน 2 ชม. = คนเดินจากไปแล้ว ไม่ใช่กำลังกรอกอยู่ · ทิ้ง state แต่ "เก็บร่างไว้"
// (ร่าง = ยอดทั้งกะที่ยืนยันไปแล้ว ต้องอยู่ข้ามการหลับของ Render — คนละเรื่องกับตำแหน่งในฟอร์ม)
// ถ้าปล่อยให้ค้าง: บอทจะถือว่าข้อความถัดไปของคนนี้ในกลุ่ม "คุยกับบอทอยู่" แล้วกลืนไปเป็นคำตอบของฟอร์ม
const SPP_STATE_TTL_MS = 2 * 60 * 60 * 1000;
async function getSppSession(chatId, userId) {
  const rows = await dbAll('SELECT state, draft, updated_at FROM spp_tg_session WHERE chat_id = ? AND user_id = ?', [String(chatId), String(userId)]);
  if (!rows[0]) return { state: '', draft: {} };
  let draft = {};
  try { draft = JSON.parse(rows[0].draft || '{}'); } catch { /* ร่างเสีย — เริ่มใหม่ดีกว่าพัง */ }
  let state = rows[0].state || '';
  if (state && rows[0].updated_at) {
    const age = new Date(nowBKK()).getTime() - new Date(rows[0].updated_at).getTime();
    // เทียบสองสตริงรูปแบบเดียวกัน (nowBKK) → ผลต่างถูกเสมอไม่ว่า server อยู่โซนไหน
    if (Number.isFinite(age) && age > SPP_STATE_TTL_MS) {
      state = '';
      delete draft.fix;                                        // ยอดที่รอยืนยันค้างไว้ก็หมดอายุไปด้วย
      delete draft.current;                                    // รายการที่กรอกค้างครึ่ง ๆ — ให้เริ่มใหม่
      await setSppSession(chatId, userId, '', draft).catch(() => {});
    }
  }
  return { state, draft };
}
async function setSppSession(chatId, userId, state, draft) {
  await db.exec(
    `INSERT INTO spp_tg_session (chat_id, user_id, state, draft, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET state=excluded.state, draft=excluded.draft, updated_at=excluded.updated_at`,
    [String(chatId), String(userId), state || '', JSON.stringify(draft || {}), nowBKK()]
  );
}
async function clearSppSession(chatId, userId) {
  await db.exec('DELETE FROM spp_tg_session WHERE chat_id = ? AND user_id = ?', [String(chatId), String(userId)]);
}
async function getSppUser(userId) {
  return (await dbAll('SELECT * FROM spp_tg_user WHERE telegram_user_id = ?', [String(userId)]))[0] || null;
}
async function setSppUser(userId, name, chatId) {
  await db.exec(
    `INSERT INTO spp_tg_user (telegram_user_id, name, chat_id, registered_at, last_seen_at) VALUES (?,?,?,?,?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET name=excluded.name, chat_id=excluded.chat_id, last_seen_at=excluded.last_seen_at`,
    [String(userId), name, String(chatId), nowBKK(), nowBKK()]
  );
}

// ── "คุณคือใคร" ────────────────────────────────────────────────────────────
// ⚠️ 2026-08-04 มีใบที่บันทึกชื่อผิดคน (อนุวัตร/กะ1 แทน จักรกฤษ/กะ2) จาก 3 สาเหตุรวมกัน:
//   1. บอทเสนอเฉพาะลูกกะของ currentShiftCode() — คนกะ2 ที่ทักตอนระบบคิดว่ากะ1 จะไม่เห็นชื่อตัวเอง
//   2. ปุ่มส่งมาแค่ "ลำดับ" ที่ชี้เข้า draft.name_opts ซึ่งถูกเขียนทับได้ระหว่างทาง
//   3. ลงทะเบียนผิดแล้วแก้เองไม่ได้เลย — หัวหน้าแก้ชื่อในใบได้ แต่ทะเบียนบอทยังผิด ใบถัดไปก็ผิดซ้ำ
// แก้: เห็นได้ทุกกะ · ปุ่มอ้าง (กะ, sort_order) ที่อ่านจาก DB ตอนกด ไม่ใช่จากร่าง · ยืนยันก่อนบันทึก
//      · เปลี่ยนทีหลังได้ · โชว์ชื่อที่ลงทะเบียนไว้ในเมนูหลักทุกครั้ง
async function sppAskWho(chatId, userId, draft, { all = false, note = '' } = {}) {
  const shift = currentShiftCode();
  const crew = all
    ? await dbAll('SELECT shift, name, sort_order FROM shift_crew WHERE active = 1 ORDER BY shift, sort_order', [])
    : await dbAll('SELECT shift, name, sort_order FROM shift_crew WHERE shift = ? AND active = 1 ORDER BY sort_order', [shift]);

  // callback_data จำกัด 64 ไบต์ · ชื่อไทยยาว ๆ ใส่ตรง ๆ ไม่พอ → อ้างด้วย (กะ, sort_order)
  // ซึ่งคงที่ใน DB · ต่างจากเดิมที่อ้าง index ของลิสต์ในร่างที่เปลี่ยนได้
  const kb = crew.map(c => [{
    text: all ? `${c.name} · ${c.shift}` : c.name,
    callback_data: `s:who:${c.shift}:${c.sort_order}`,
  }]);
  if (!all) kb.push([{ text: '👥 ไม่มีชื่อฉัน — ดูทุกกะ', callback_data: 's:whoall' }]);
  kb.push([{ text: '⌨️ พิมพ์ชื่อเอง', callback_data: 's:nametype' }]);

  await setSppSession(chatId, userId, 'ask_name', draft);
  return sppSend(chatId, [
    note || '👋 สวัสดี! ก่อนเริ่ม — <b>คุณคือใคร?</b>',
    all ? '<i>ทีมทั้งหมดทุกกะ</i>' : `<i>ทีม ${escapeHtml(shift)} · ไม่มีชื่อคุณให้กดดูทุกกะ</i>`,
  ].join('\n'), kb);
}

// หาคนจาก (กะ, sort_order) — อ่านสด ๆ จาก DB ตอนกดปุ่ม ไม่พึ่งอะไรที่ค้างในร่าง
const sppCrewAt = async (shift, sortOrder) =>
  (await dbAll('SELECT name FROM shift_crew WHERE shift = ? AND sort_order = ? AND active = 1',
    [shift, Number(sortOrder)]))[0]?.name || '';

// ── ปุ่ม / ข้อความ ──────────────────────────────────────────────────────────
const sppSend = (chatId, text, keyboard) =>
  sppTg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });

// ไม่มีปุ่มส่งคลังในเมนูบอทโดยตั้งใจ — ยืนยันแล้วเข้าแอปเลย หัวหน้าเป็นคนส่งคลังจากหน้า Admin
// ปุ่มชื่อตัวเองอยู่ท้ายเมนูเสมอ: ลงทะเบียนผิดคนแล้วต้องเห็นทันที ไม่ใช่รู้ตอนหัวหน้าทักว่าใบนี้ใครลง
// draft.who = ชื่อที่ลงทะเบียนไว้ (sync จากตาราง spp_tg_user ทุกครั้งที่มี update เข้ามา)
// เก็บไว้ในร่างเพื่อให้เมนูอ่านได้โดยไม่ต้องยิง DB ซ้ำทุกจุดที่เรียกเมนู
const sppMainMenu = (draft) => [
  [{ text: '📋 แผนผลิตวันนี้', callback_data: 's:plan' }],
  [{ text: '➕ ลงยอด (เลือกจากสินค้าทั้งหมด)', callback_data: 's:all:0' }],
  ...(draft?.count ? [[{ text: `👀 ที่ลงไปแล้ววันนี้ (${draft.count})`, callback_data: 's:draft' }]] : []),
  [{ text: draft?.who ? `👤 คุณคือ ${draft.who}` : '👤 ตั้งชื่อผู้ลงยอด', callback_data: 's:whoami' }],
];

// สรุปสิ่งที่คนนี้ลงไปแล้วในกะ — อ่านจาก DB จริง ไม่ใช่ร่างในบอท (ยืนยันแล้วเข้า DB ทันที)
async function sppDraftText(draft) {
  const day = workDayBKK();
  const shift = currentShiftCode();
  const who = draft.header?.reporter || '';
  if (!who) return 'ยังไม่ได้ลงยอดอะไรในกะนี้';
  const rows = await dbAll(
    'SELECT product_name, sku_keyword, prod_qty, count_unit, status FROM production_reports WHERE work_day = ? AND shift = ? AND reporter_name = ? ORDER BY id',
    [day, shift, who]
  ).catch(() => []);
  if (!rows.length) return 'ยังไม่ได้ลงยอดอะไรในกะนี้';
  const label = { pending_review: 'รอหัวหน้าตรวจ', pending_warehouse: 'ส่งคลังแล้ว', pending_approval: 'รออนุมัติ', approved: 'อนุมัติแล้ว', needs_fix: 'ถูกส่งกลับให้แก้' };
  return [
    `📝 <b>ที่คุณลงไปแล้ว · ${rows.length} รายการ</b>`,
    `${escapeHtml(day)} · ${escapeHtml(shift)}`,
    '',
    ...rows.map((r, i) => `${i + 1}. ${escapeHtml(r.product_name || r.sku_keyword)} — <b>${r.prod_qty} ${escapeHtml(r.count_unit || '')}</b> <i>(${label[r.status] || r.status})</i>`),
  ].join('\n');
}

// รายการสินค้าที่มีแผนวันนี้ — รวมทุกกะของวันนั้น
// คนลงยอดมักลงของกะที่เพิ่งจบ ไม่ใช่กะที่กำลังเดินอยู่ จึงไม่กรองกะตรงนี้
// (เดิมจับคู่ด้วยชื่อตรงเป๊ะผ่าน plan_flavor → ได้ 0 จาก 6 รายการเสมอ เพราะชื่อในแผน
//  "Syrup 800×3×4" ไม่มีวันตรงกับชื่อทางการใน SKU master · ตอนนี้ผ่าน resolveDayPlan)
const sppTodayPlan = (workDay) => resolveDayPlan(workDay);

const SPP_PAGE = 8;
// เก็บรายการที่กำลังโชว์ไว้ใน session แล้วให้ปุ่มอ้างด้วย index — callback_data จำกัด 64 ไบต์
// keyword ภาษาไทยยาว ๆ ใส่ตรง ๆ ไม่พอแน่
function sppSkuKeyboard(list, page, backTo) {
  const start = page * SPP_PAGE;
  const slice = list.slice(start, start + SPP_PAGE);
  const rows = slice.map((s, i) => [{
    text: `${s.product_name || s.keyword}`.slice(0, 55),
    callback_data: `s:sku:${start + i}`,
  }]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀️ ก่อนหน้า', callback_data: `s:${backTo}:${page - 1}` });
  if (start + SPP_PAGE < list.length) nav.push({ text: 'ถัดไป ▶️', callback_data: `s:${backTo}:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '⬅️ เมนูหลัก', callback_data: 's:menu' }]);
  return rows;
}

// ถามช่องถัดไปของฟอร์ม — ลำดับตามโน้ต Notion
async function sppAskNext(chatId, userId, draft) {
  const cur = draft.current || {};
  const sku = cur.sku || {};
  if (!cur.machine) {
    const opts = [...new Set([sku.machine, 'Manual', 'ต้มหัวเชื้อ'].filter(Boolean))];
    const rows = opts.map((m, i) => [{ text: m, callback_data: `s:mc:${i}` }]);
    rows.push([{ text: '⌨️ พิมพ์ชื่อเครื่องเอง', callback_data: 's:mctype' }]);
    draft.current.machine_opts = opts;
    await setSppSession(chatId, userId, 'item_machine', draft);
    return sppSend(chatId, `🏭 <b>${escapeHtml(sku.product_name || sku.keyword)}</b>\n\nเลือก <b>เครื่องบรรจุ</b>`, rows);
  }
  if (cur.counter === undefined) {
    // งาน Manual "ปกติ" ไม่มีเลขหน้าเครื่อง แต่บาง Line มีจริง → ต้องกรอกได้เสมอ (quick win 1a)
    // จึงให้ปุ่ม 0 เป็นทางลัด ไม่ใช่บังคับเป็น 0
    const manual = cur.machine === 'Manual' || cur.machine === 'ต้มหัวเชื้อ';
    await setSppSession(chatId, userId, 'item_counter', draft);
    return sppSend(chatId,
      `พิมพ์ <b>ยอดเลขหน้าเครื่อง (ชิ้น)</b>${manual ? '\n<i>งาน Manual ปกติไม่มีเลขหน้าเครื่อง — กด 0 ได้เลย</i>' : ''}`,
      [[{ text: '0 — ไม่มีเลขหน้าเครื่อง', callback_data: 's:counter0' }]]);
  }
  if (cur.prod_qty === undefined) {
    await setSppSession(chatId, userId, 'item_qty', draft);
    return sppSend(chatId, `พิมพ์ <b>จำนวนที่ผลิตได้</b> (${escapeHtml(sku.count_unit || 'กล่อง')})`);
  }
  if (cur.pallet_photo === undefined) {
    const mustPhoto = Number(sku.pallet_route) === 2;
    await setSppSession(chatId, userId, 'item_photo', draft);
    return sppSend(chatId,
      mustPhoto
        ? '📸 <b>ส่งรูปค้างพาเลท</b>\n<i>สินค้าตัวนี้พนักงานจัดเรียงพาเลทเอง คลังมองไม่เห็นของ จึงต้องมีรูปยืนยัน</i>'
        : '📸 ส่งรูปค้างพาเลท (ถ้ามี)',
      mustPhoto ? null : [[{ text: '⏭ ไม่มีรูป', callback_data: 's:skipphoto' }]]);
  }
  if (cur.damaged === undefined) {
    await setSppSession(chatId, userId, 'item_damaged', draft);
    return sppSend(chatId,
      ['🧺 <b>ภาชนะบรรจุชำรุด</b>',
       'พิมพ์เฉพาะที่มี เช่น <code>ถุง 2 กล่อง 1</code>',
       `<i>ประเภท: ${SPP_DAMAGE_KINDS.map(d => d.key).join(' · ')}</i>`].join('\n'),
      [[{ text: '✅ ไม่มีของเสีย', callback_data: 's:nodmg' }]]);
  }
  // ครบแล้ว → ให้ทวนก่อนเก็บเข้าร่าง
  const dmg = Object.entries(cur.damaged || {}).filter(([, v]) => v > 0);
  await setSppSession(chatId, userId, 'item_confirm', draft);
  return sppSend(chatId, [
    '🧾 <b>ทวนรายการ</b>',
    `สินค้า: <b>${escapeHtml(sku.product_name || sku.keyword)}</b>`,
    `เครื่องบรรจุ: ${escapeHtml(cur.machine)}`,
    `เลขหน้าเครื่อง: ${cur.counter}`,
    `ผลิตได้: <b>${cur.prod_qty} ${escapeHtml(sku.count_unit || 'กล่อง')}</b>`,
    `รูปค้างพาเลท: ${cur.pallet_photo ? 'แนบแล้ว ✅' : 'ไม่มี'}`,
    `ของเสีย: ${dmg.length ? dmg.map(([k, v]) => `${k} ${v}`).join(' · ') : 'ไม่มี'}`,
  ].join('\n'), [
    [{ text: '🔍 ส่งเพื่อตรวจสอบ', callback_data: 's:check' }],
    [{ text: '🔄 กรอกใหม่', callback_data: 's:redo' }, { text: '❌ ทิ้งรายการนี้', callback_data: 's:menu' }],
  ]);
}

// ตัวเลขล้วน (ผู้ใช้พิมพ์ 1,200 หรือ 1 200 ได้ — เป็นตัวคั่นหลักพัน)
// ⚠️ ห้ามลบช่องว่างทิ้งดื้อ ๆ แล้วแปลงเป็นเลข: "36 200 40" จะกลายเป็น 3620040 ทันที
//    คนพิมพ์เลขหลายตัวในข้อความเดียวเกิดขึ้นจริง (โดยเฉพาะในกลุ่ม) — ต้องปฏิเสธ ไม่ใช่เดา
//    รับเฉพาะ "เลขก้อนเดียว" · คั่นหลักพันต้องเป็นกลุ่มละ 3 หลักเป๊ะเท่านั้น
const SPP_NUM_PLAIN = /^\d+(?:\.\d+)?$/;                     // 3000 · 1440 · 12.5
const SPP_NUM_GROUPED = /^\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?$/; // 3,000 · 1 200 · 1,234,567
const sppNum = (t) => {
  const s = String(t ?? '').trim();
  if (!s) return null;
  if (!SPP_NUM_PLAIN.test(s) && !SPP_NUM_GROUPED.test(s)) return null;
  const v = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(v) && v >= 0 ? v : null;
};

async function sppHandleText(chatId, userId, text, sess, user = null) {
  const draft = sess.draft || {};

  // "ยกเลิก" ต้องทำงานได้ทุกจังหวะ รวมถึงตอนค้างกลางฟอร์ม — ถ้าเช็คทีหลัง state
  // ผู้ใช้ที่ค้างรออยู่ (เช่นรอส่งรูป) จะออกไม่ได้เลย ได้แต่โดนถามซ้ำ
  if (/^\/cancel$|^ยกเลิก/i.test(text.trim())) {
    await clearSppSession(chatId, userId);
    return sppSend(chatId, 'ล้างที่กรอกค้างแล้ว ✅ <i>(ของที่ยืนยันไปแล้วยังอยู่ในแอป)</i>', sppMainMenu({ who: draft.who }));
  }

  if (sess.state === 'ask_name_type') {
    const name = text.trim();
    if (!name) return sppSend(chatId, 'พิมพ์ชื่อ-นามสกุลของคุณ');
    const before = draft.who;
    await setSppUser(userId, name, chatId);
    draft.who = name;
    await setSppSession(chatId, userId, '', draft);
    return sppSend(chatId, before && before !== name
      ? `✅ เปลี่ยนเป็น <b>${escapeHtml(name)}</b> แล้ว\n<i>(ใบที่ลงไปก่อนหน้านี้ยังเป็นชื่อ ${escapeHtml(before)} — ให้หัวหน้าแก้ในหน้าอนุมัติ)</i>`
      : `ยินดีต้อนรับ <b>${escapeHtml(name)}</b> ✅`, sppMainMenu(draft));
  }
  if (sess.state === 'item_machine_type') {
    draft.current.machine = text.trim();
    return sppAskNext(chatId, userId, draft);
  }
  if (sess.state === 'item_counter') {
    const v = sppNum(text);
    if (v === null) return sppSend(chatId, '⚠️ ต้องเป็นตัวเลข เช่น <code>1440</code> (ไม่มีก็พิมพ์ 0)');
    draft.current.counter = v;
    return sppAskNext(chatId, userId, draft);
  }
  if (sess.state === 'item_qty') {
    const v = sppNum(text);
    if (v === null) return sppSend(chatId, '⚠️ ต้องเป็นตัวเลข เช่น <code>120</code>');
    draft.current.prod_qty = v;
    return sppAskNext(chatId, userId, draft);
  }
  if (sess.state === 'item_damaged') {
    // "ถุง 2 กล่อง 1" → { ถุง: 2, กล่อง: 1 } · ตัวที่ไม่พูดถึง = 0
    const damaged = {};
    let matched = false;
    for (const d of SPP_DAMAGE_KINDS) {
      const m = text.match(new RegExp(`${d.re.source}\\D{0,4}(\\d+)`, 'i'));
      if (m) { damaged[d.key] = Number(m[1]); matched = true; }
    }
    if (!matched) return sppSend(chatId, '⚠️ อ่านไม่ออก — พิมพ์แบบนี้ <code>ถุง 2 กล่อง 1</code> หรือกดปุ่ม "ไม่มีของเสีย"',
      [[{ text: '✅ ไม่มีของเสีย', callback_data: 's:nodmg' }]]);
    draft.current.damaged = damaged;
    return sppAskNext(chatId, userId, draft);
  }
  // กำลังแก้ใบที่หัวหน้าส่งกลับ — รับได้ทีละช่องที่ผู้ใช้กดเลือกไว้เท่านั้น
  // ค่าที่พิมพ์เข้ามาจะเก็บไว้ในร่างก่อน ยังไม่แตะ DB จนกว่าจะกด "ส่งกลับให้หัวหน้า"
  if (sess.state.startsWith('fixv:')) {
    const code = sess.state.slice(5);
    const f = SPP_FIX_FIELDS[code];
    if (!f) { await setSppSession(chatId, userId, '', draft); return sppSend(chatId, 'ไม่รู้จักช่องที่กำลังแก้'); }
    const v = sppNum(text);
    if (v === null) {
      // เดิมยอมรับข้อความที่มีเลขหลายตัวแล้วเชื่อมติดกัน — "36200 40" เคยกลายเป็น 3620040 มาแล้ว
      return sppSend(chatId, [
        `⚠️ <b>${escapeHtml(f.label)}</b> ต้องเป็น<b>ตัวเลขตัวเดียว</b> เช่น <code>3000</code>`,
        'ถ้าจะแก้หลายช่อง พิมพ์ทีละช่องแล้วกดเลือกช่องถัดไป',
        '<i>ไม่ได้ตั้งใจจะแก้ พิมพ์ "ยกเลิก"</i>',
      ].join('\n'));
    }
    return sppTakeFixValue(chatId, userId, draft, code, v);
  }
  if (sess.state === 'item_photo') {
    // กำลังรอรูปอยู่ — ถ้าปล่อยข้อความหลุดเงียบ ๆ ผู้ใช้จะนึกว่าบอทค้าง
    const mustPhoto = Number(draft.current?.sku?.pallet_route) === 2;
    return sppSend(chatId, `📸 ตอนนี้กำลังรอ<b>รูปค้างพาเลท</b>อยู่ — ส่งรูปเข้ามาได้เลย${mustPhoto ? '\n<i>สินค้าตัวนี้ต้องมีรูป ข้ามไม่ได้</i>' : ''}`,
      mustPhoto ? null : [[{ text: '⏭ ไม่มีรูป', callback_data: 's:skipphoto' }]]);
  }
  if (sess.state === 'item_confirm') {
    return sppSend(chatId, 'กดปุ่มด้านบนเพื่อ <b>ส่งเพื่อตรวจสอบ</b> หรือ <b>กรอกใหม่</b>',
      [[{ text: '🔍 ส่งเพื่อตรวจสอบ', callback_data: 's:check' }, { text: '🔄 กรอกใหม่', callback_data: 's:redo' }]]);
  }
  if (sess.state === 'item_checked') {
    return sppSend(chatId, 'บอทตรวจให้แล้ว — กด <b>ยืนยันข้อมูลถูกต้อง</b> เพื่อส่งเข้าแอป',
      [[{ text: '✅ ยืนยันข้อมูลถูกต้อง', callback_data: 's:confirm' }, { text: '✏️ ขอแก้', callback_data: 's:redo' }]]);
  }
  if (sess.state === 'item_machine') {
    // ผู้ใช้พิมพ์ชื่อเครื่องมาเองแทนที่จะกดปุ่ม — รับไปเลย ไม่ต้องบังคับให้กด
    draft.current.machine = text.trim();
    return sppAskNext(chatId, userId, draft);
  }

  // ไม่ได้อยู่ในฟอร์ม — ถือเป็นคำสั่ง
  const t = text.trim();
  // ต้องมาก่อน looksLikePlanText/ลงยอด — ไม่งั้น "เปลี่ยนชื่อ" ไปโดนทางอื่นดักก่อน
  if (/^\/whoami$|^ฉันคือใคร|^ผมคือใคร|^เปลี่ยนชื่อ|^แก้ชื่อ/i.test(t)) {
    if (/เปลี่ยนชื่อ|แก้ชื่อ/i.test(t)) {
      return sppAskWho(chatId, userId, draft, { all: true, note: '🔄 <b>เปลี่ยนชื่อผู้ลงยอด</b> — เลือกชื่อที่ถูกต้อง' });
    }
    if (!draft.who) return sppAskWho(chatId, userId, draft);
    return sppSend(chatId, `👤 ระบบบันทึกว่าคุณคือ <b>${escapeHtml(draft.who)}</b>\n<i>ไม่ใช่? พิมพ์ "เปลี่ยนชื่อ"</i>`,
      [[{ text: '🔄 เปลี่ยนชื่อ', callback_data: 's:whochg' }]]);
  }
  if (/^แผนผลิตวันนี้|^\/plan/i.test(t)) return sppShowPlan(chatId, userId, draft, 0);
  if (/ร่าง|ที่ลงไป|^\/draft/i.test(t)) return sppSend(chatId, await sppDraftText(draft), sppMainMenu(draft));

  // ข้อ 1: ลงแผนผลิต — ต้องเช็คก่อนโหมดลงยอด ไม่งั้นแผนทั้งก้อนจะถูกอ่านเป็นการลงยอด
  if (looksLikePlanText(t)) return sppTryPlanText(chatId, userId, draft, t, user);

  // ข้อ 7: เป็นคำถาม → ส่งให้ผู้ช่วย AI ตอบจากฐานข้อมูล
  // แยกจาก "ลงยอด" ด้วยคำถามชัด ๆ — ถ้าเดาผิดฝั่งผู้ใช้จะงงมาก จึงคุมด้วยรายการคำ
  // ไม่ใช่ปล่อยให้ AI เดาเจตนา
  if (SPP_QUESTION_RE.test(t)) {
    return sppAskHistory(chatId, userId, t, user);
  }

  // ข้อ 2: ไม่ตรงอะไรเลย → ลองแกะเป็นการลงยอด ก่อนจะตอบเมนู
  // ต้องมีตัวเลขอย่างน้อย 1 ตัวถึงจะคุ้มเรียก AI (ทักทายเปล่า ๆ ไม่ต้องเสียเงิน)
  if (/\d/.test(t) && t.length >= 6) {
    const hit = await sppTryFreeText(chatId, userId, draft, t, user);
    if (hit) return hit;
  }
  return sppSend(chatId, [
    '👋 <b>Production_SPP</b>',
    '',
    '<b>ลงยอด</b> — พิมพ์มาได้เลย',
    '<code>Amazon 750 ได้ 120 กล่อง เครื่อง Linear#1 เลข 1440</code>',
    '',
    '<b>ลงแผน</b> — ขึ้นต้นด้วยคำว่า "ลงแผน"',
    '<code>ลงแผนพรุ่งนี้กะเช้า Syrup800 300 กล่อง</code>',
    '',
    '<b>ถามย้อนหลัง</b> — ถามเป็นคำถามได้เลย',
    '<code>เมื่อวานกะดึกผลิตอะไรบ้าง</code>',
  ].join('\n'), sppMainMenu(draft));
}

// ── ข้อ 1: ลงแผนผลิตในบอท ──────────────────────────────────────────────────
// ใช้ intent 'fill_plan' ของผู้ช่วย AI ที่มีอยู่แล้ว (แกะข้อความแผน → รายการเป้าผลิต)
// แล้วเขียนลง shift_plans เส้นทางเดียวกับ POST /api/shift-plan
// ชั่วโมงกะไม่ต้องถาม — ระบบรู้จากวันในสัปดาห์ (จ–พฤ 3 กะ 8 ชม. · ศ–อา 2 กะ 12 ชม.)
const SPP_SHIFT_LABEL = { 'กะเช้า': 'กะ1', 'กะบ่าย': 'กะ2', 'กะดึก': 'กะ3' };

// รูปแบบแผนบรรจุที่โรงงานใช้จริง — หัวแผนตามด้วยรายการ "<สินค้า> =<Boxes>/<คน>"
//   แผนบรรจุกะ 2
//   วันที่ 03-08-26 (14.00-22.00)
//   🔴 Icing 900×12 REG-CAN =206/10
// ไม่บังคับให้ขึ้นต้นด้วย "ลงแผน" เพราะคนวางแผนจะ copy ทั้งก้อนมาวางตรง ๆ
const PLAN_ITEM_RE = /=\s*\d+\s*\/\s*\d+/g;
const looksLikePlanText = (t) =>
  /^\s*(ลงแผน|\/setplan)/i.test(t)                                  // สั่งตรง ๆ
  || (/^\s*(แผนบรรจุ|แผนผลิต)/i.test(t) && /=\s*\d/.test(t))         // หัวแผน + มีเป้าอย่างน้อย 1 รายการ
                                                                     // (กัน "แผนผลิตวันนี้" ที่เป็นคำสั่งดูแผน ไม่ใช่ลงแผน)
  || (t.match(PLAN_ITEM_RE) || []).length >= 2;                      // วางมาทั้งก้อนโดยไม่มีหัวแผน

// อ่านวันที่+กะจากหัวแผน — เชื่อหัวแผนก่อน AI เพราะเป็นข้อความที่คนพิมพ์ไว้ตรง ๆ
// คืน {} เมื่ออ่านไม่ได้ ให้ผู้เรียกถอยไปใช้ค่าจาก AI หรือวัน/กะปัจจุบัน
function parsePlanHeader(text) {
  const out = {};
  // วันที่ DD-MM-YY หรือ DD/MM/YYYY — ปีสองหลักคือ ค.ศ. ย่อ (26 = 2026)
  const d = text.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (d) {
    const day = Number(d[1]), mon = Number(d[2]);
    let yr = Number(d[3]);
    if (yr < 100) yr += 2000;
    if (yr > 2400) yr -= 543;                       // เผื่อมีคนใส่ พ.ศ.
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      out.work_day = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  // กะจากช่วงเวลาในหัวแผน — แม่นกว่าเลข "กะ 2" เพราะบางวันมี 2 กะ บางวันมี 3
  const t = text.match(/(\d{1,2})[.:]\d{2}\s*[-–]\s*(\d{1,2})[.:]\d{2}/);
  if (t) {
    const s = Number(t[1]), e = Number(t[2]);
    if (s === 6 && e === 14) out.shift = 'กะ1';
    else if (s === 14) out.shift = 'กะ2';
    else if (s === 22 || s === 18) out.shift = 'กะ3';
    else if (s === 6) out.shift = 'กะ1';            // 06-18 = กะเช้า 12 ชม.
  }
  if (!out.shift) {
    const g = text.match(/กะ\s*([123])/);           // "แผนบรรจุกะ 2"
    if (g) out.shift = `กะ${g[1]}`;
  }
  return out;
}

// แกะรายการในแผนบรรจุแบบ "ตรงตัว" ไม่ใช้ AI — รูปแบบของโรงงานคงที่พอที่จะอ่านเองได้
// ทำเองเพราะปล่อยให้ AI แกะแล้วมันเปลี่ยนชื่อสินค้า ("ปี๊บ 1×20" → "Dilute W-Molass"),
// ย่อชื่อจนสองรายการซ้ำกัน ("Syrup 800×12" กับ "Syrup 1.8×8" กลายเป็น "Syrup" ทั้งคู่)
// และทำรายการหล่นหายเงียบ ๆ ("ชาเช่ ...=25/5" หายทั้งบรรทัด)
// คืน skipped ด้วย เพื่อโชว์ให้ผู้ใช้เห็นว่าอะไรถูกข้าม จะได้ไม่มีอะไรหายแบบไม่รู้ตัว
// คำนำหน้าที่เป็น "หมายเหตุ" ไม่ใช่ส่วนหนึ่งของชื่อสินค้า — ในแผนจริงเขียนติดกับชื่อเลย เช่น
//   "ครบแล้วทำCaramel Señorita750×6EX=16ก."  → สินค้าคือ Caramel Señorita750×6EX
// ตัวท้าย EX คือของลูกค้าอีกเจ้า เป็น SKU คนละตัวกับ Caramel Señorita750×6 ต้องลงยอดแยกกัน
// จับเฉพาะคำไทยที่ลงท้ายด้วย "ทำ" (ครบแล้วทำ/เสร็จแล้วทำ) — ชื่อสินค้าไทยจริง (ชาเช่, ปี๊บ) ไม่โดน
const PLAN_NOTE_PREFIX = /^(?:[฀-๿]{1,12}ทำ|ต่อด้วย|แล้วต่อ)\s*/;

function parsePlanItems(text) {
  const items = [], skipped = [];
  const mk = (rawName, boxes, staff) => {
    // ตัดคำนำหน้าออก แต่ถ้าตัดแล้วไม่เหลือชื่อ ให้ใช้ของเดิม — ห้ามได้ชื่อว่าง
    const stripped = rawName.replace(PLAN_NOTE_PREFIX, '').trim();
    const name = /[\p{L}\p{N}]/u.test(stripped) ? stripped : rawName;
    const mc = name.match(/\[([^\]]+)\]/);
    return {
      flavor: name,                                        // นอกนั้นเก็บตามที่เขียนในแผนเป๊ะ ๆ ห้ามแปลง
      target_boxes: Number(String(boxes).replace(/,/g, '')),
      staff: staff == null ? null : Number(staff),
      machine_code: mc ? mc[1].trim() : '',
      spec: '',
    };
  };
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/^[^\p{L}\p{N}]+/u, '').trim();   // ตัด 🔴 • - นำหน้าออก
    if (!line.includes('=')) continue;                              // หัวแผน/หมายเหตุ ไม่มี = ข้ามหมด
    const eq = line.lastIndexOf('=');
    const name = line.slice(0, eq).trim().replace(/[,\s]+$/, '');
    const rhs = line.slice(eq + 1).trim();
    if (!name) continue;

    // "=3000/9" → เป้า 3000 กล่อง ใช้คน 9
    let m = rhs.match(/^(\d[\d,]*)\s*\/\s*(\d+)/);
    if (m) { items.push(mk(name, m[1], m[2])); continue; }

    // "=16ก." / "=16 กล่อง" → มีหน่วยกำกับ แปลว่าเป็นเป้าผลิต ไม่ใช่จำนวนคน
    m = rhs.match(/^(\d[\d,]*)\s*(ก\.|กล่อง|ลัง|ถุง|กระสอบ|ปี๊บ)/);
    if (m) { items.push(mk(name, m[1], null)); continue; }

    // "=2" เปล่า ๆ → งานซัพพอร์ต เลขคือจำนวนคน ไม่ใช่เป้าผลิต
    if (/^\d+\s*$/.test(rhs)) skipped.push(`${name}=${rhs}`);
  }
  return { items, skipped };
}

async function sppTryPlanText(chatId, userId, draft, text, user) {
  // ลำดับความเชื่อถือของวันที่/กะ: หัวแผน → คำว่าพรุ่งนี้/เมื่อวาน → วันปัจจุบัน
  const base = workDayBKK();
  const hdr = parsePlanHeader(text);
  const day = hdr.work_day
    || (/พรุ่งนี้/.test(text) ? addDaysStr(base, 1) : /เมื่อวาน/.test(text) ? addDaysStr(base, -1) : base);

  // แกะเองก่อนเสมอ — เร็ว ฟรี และที่สำคัญคือ "ตรงตามที่เขียน" ไม่เปลี่ยนชื่อ ไม่ทำหล่น
  // AI เป็นตัวสำรอง ใช้เฉพาะตอนพิมพ์เป็นประโยค เช่น "ลงแผนพรุ่งนี้กะเช้า Syrup800 300 กล่อง"
  const direct = parsePlanItems(text);
  let items = direct.items;
  const skipped = direct.skipped;
  let out = null;

  if (!items.length) {
    if (!ai.available('parse')) {
      return sppSend(chatId, '⚠️ ยังตั้งค่า AI ไม่เสร็จ — ลงแผนผ่านหน้าเว็บไปก่อนได้');
    }
    try {
      // ⚠️ runAssistantConversation ไม่รับ "intent" — ต้องกาง hint/tool เองเหมือนที่ /api/assistant ทำ
      //    (ส่ง intent เฉย ๆ จะถูกทิ้งเงียบ บอทจะคุยเล่นแทนที่จะแกะแผน)
      const cfg = ASSISTANT_INTENT_HINTS.fill_plan;
      out = await runAssistantConversation({
        userMessage: text, operator: user?.name || '', persist: false, maxTurns: 3,
        systemExtra: cfg.hint, forceTool: cfg.tool,
      });
    } catch (e) {
      console.error('[SPP plan] failed', e.message);
      return sppSend(chatId, '❌ แกะแผนไม่สำเร็จ ลองพิมพ์ใหม่ให้ชัดขึ้น เช่น <code>ลงแผนพรุ่งนี้กะเช้า Syrup800 300 กล่อง</code>');
    }
    items = out?.planDraft?.items || [];
  }

  if (!items.length) {
    return sppSend(chatId, '🤔 อ่านแล้วไม่เจอรายการเป้าผลิต\nพิมพ์แบบนี้ได้: <code>ลงแผนพรุ่งนี้กะเช้า Syrup800 300 กล่อง Icing900 200</code>');
  }
  const shift = hdr.shift || SPP_SHIFT_LABEL[out?.planDraft?.shift] || currentShiftCode();

  draft.plan_draft = { work_day: day, shift, items };
  await setSppSession(chatId, userId, '', draft);

  const hrs = factoryShiftsForWeekday(new Date(`${day}T12:00:00`).getDay()).length === 2 ? 12 : 8;
  const total = items.reduce((s, it) => s + (Number(it.target_boxes) || 0), 0);
  return sppSend(chatId, [
    `📋 <b>แผนผลิต · ${escapeHtml(formatThaiDate(day))} ${escapeHtml(shift)}</b>`,
    `<i>กะ ${hrs} ชม. (ระบบดูจากวันในสัปดาห์ให้)</i>`,
    '',
    // ไม่โชว์ batch แล้ว — 1 batch = 100 กล่อง ใช้ไม่ได้กับสินค้าทุกตัว เลขที่ได้เลยไม่มีความหมาย
    ...items.map(it => `• ${escapeHtml(it.flavor)}\n   <b>${it.target_boxes.toLocaleString()}</b> กล่อง${it.staff ? ` · ${it.staff} คน` : ''}`),
    '',
    `รวม <b>${total.toLocaleString()}</b> กล่อง · ${items.length} รายการ`,
    ...(skipped.length ? ['', `<i>ข้ามงานซัพพอร์ต ${skipped.length} รายการ: ${escapeHtml(skipped.join(', '))}</i>`] : []),
    '',
    'ถูกต้องไหม?',
  ].join('\n'), [
    [{ text: '✅ บันทึกแผน', callback_data: 's:planok' }],
    [{ text: '❌ ยกเลิก', callback_data: 's:planno' }],
  ]);
}

async function sppSavePlan(chatId, userId, draft, user) {
  const p = draft.plan_draft;
  if (!p?.items?.length) return sppSend(chatId, 'ไม่มีร่างแผนค้างอยู่', sppMainMenu(draft));
  const now = nowBKK();
  let saved = 0;
  try {
    for (const it of p.items) {
      await db.exec(
        `INSERT INTO shift_plans (work_day, shift, flavor, target_boxes, target_batches, staff, machine_code, spec, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(work_day, shift, flavor)
         DO UPDATE SET target_boxes=excluded.target_boxes, target_batches=excluded.target_batches,
                       staff=excluded.staff, machine_code=excluded.machine_code, spec=excluded.spec, created_at=excluded.created_at`,
        // target_batches คิดตอนบันทึกเอง (แกะแบบตรงตัวไม่ได้ส่งมา) · ไม่มีใครอ่านค่านี้ เก็บไว้ให้คอลัมน์ไม่ว่างเฉย ๆ
        [p.work_day, p.shift, it.flavor, it.target_boxes,
          isFinite(Number(it.target_batches)) ? Number(it.target_batches) : Math.round((Number(it.target_boxes) / 100) * 10) / 10,
          it.staff ?? null, it.machine_code || '', it.spec || '', now]
      );
      saved++;
    }
  } catch (e) {
    console.error('[SPP plan] save failed', e.message);
    return sppSend(chatId, `❌ บันทึกไม่สำเร็จ: ${escapeHtml(e.message)}`, sppMainMenu(draft));
  }
  delete draft.plan_draft;
  await setSppSession(chatId, userId, '', draft);
  console.log(`[SPP plan] ${p.work_day} ${p.shift} saved=${saved} by=${user?.name || '-'}`);
  return sppSend(chatId, [
    `✅ <b>บันทึกแผนแล้ว ${saved} รายการ</b>`,
    `${escapeHtml(formatThaiDate(p.work_day))} · ${escapeHtml(p.shift)}`,
    '',
    '<i>พนักงานพิมพ์ "แผนผลิตวันนี้" จะเห็นรายการนี้',
    'และถ้าลงยอดไม่ครบ บอทจะเตือนตอนใกล้หมดกะให้เอง</i>',
  ].join('\n'), sppMainMenu(draft));
}

// ── ข้อ 6: บอทตามงานตอนใกล้หมดกะ ───────────────────────────────────────────
// เกาะ scheduler เดิม (เช็คทุก 60 วิ) — เตือน 15 นาทีก่อนกะจบว่ามีตัวไหนในแผน
// ที่ยังไม่มีใครลงยอด · กันส่งซ้ำด้วยตาราง spp_shift_nudge (คีย์ = วัน+กะ)
// ทำงานเฉพาะเมื่อมีแผนในระบบ — ไม่มีแผนก็ไม่รู้ว่าควรมีอะไร จึงเงียบไว้
const SPP_NUDGE_MINUTES_BEFORE = 15;

async function sppShiftNudgeTick() {
  if (!sppBotToken() || !sppChatId()) return;
  try {
    const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const hour = Number(bkk.slice(11, 13)), min = Number(bkk.slice(14, 16));
    const wd = new Date(`${bkk.slice(0, 10)}T12:00:00`).getDay();

    // ตรงกับนาทีที่ต้องเตือนของกะไหนไหม (จบกะ ลบ 15 นาที)
    const hit = factoryShiftsForWeekday(wd).find(s => {
      const endMin = (s.end * 60 + 1440 - SPP_NUDGE_MINUTES_BEFORE) % 1440;
      return Math.floor(endMin / 60) === hour && endMin % 60 === min;
    });
    if (!hit) return;

    const workDay = workDayBKK();
    const shift = { 'เช้า': 'กะ1', 'บ่าย': 'กะ2', 'ดึก': 'กะ3' }[hit.key];
    // จองสิทธิ์ส่งก่อนทำงานจริง — INSERT ชนกันได้ครั้งเดียว กันยิงซ้ำแม้มีหลาย instance
    try {
      await db.exec('INSERT INTO spp_shift_nudge (work_day, shift, sent_at) VALUES (?,?,?)', [workDay, shift, nowBKK()]);
    } catch { return; }   // มีแถวแล้ว = เตือนไปแล้ว

    // เทียบด้วย "รหัส SKU" ทางเดียวกับเมนูแผนผลิตวันนี้ — ชื่อในแผนกับชื่อทางการไม่มีวันตรงกัน
    const planRows = await resolveDayPlan(workDay, shift);
    const plans = planRows.filter(x => x.exact_shift);
    if (!plans.length) return;    // ไม่มีแผนของกะนี้ → ไม่รู้ว่าควรมีอะไร เงียบไว้

    const done = await dbAll(
      'SELECT DISTINCT sku_code, sku_keyword FROM production_reports WHERE work_day = ? AND shift = ?', [workDay, shift]);
    const doneCodes = new Set(done.map(d => (d.sku_code || '').trim()).filter(Boolean));
    const doneKeywords = new Set(done.map(d => (d.sku_keyword || '').trim()).filter(Boolean));
    // ตัวที่ยังผูก SKU ไม่ได้ ถือว่า "ยังไม่ได้ลง" — เตือนไว้ดีกว่าเงียบแล้วยอดหาย
    const left = plans.filter(x =>
      !(x.sku && (doneCodes.has(x.sku.sku_code) || doneKeywords.has(x.sku.keyword))));

    if (!left.length) {
      console.log(`[SPP nudge] ${workDay} ${shift} ครบแล้ว ไม่ต้องเตือน`);
      return;
    }
    await sendSppTelegram([
      `⏰ <b>ใกล้หมด${escapeHtml(shift)}แล้ว (อีก ${SPP_NUDGE_MINUTES_BEFORE} นาที)</b>`,
      '',
      `แผนกะนี้มี <b>${plans.length}</b> ตัว · ลงยอดมาแล้ว <b>${plans.length - left.length}</b> ตัว`,
      '',
      'ยังไม่ได้ลง:',
      ...left.map(x => `• <b>${escapeHtml(x.plan.flavor)}</b> (แผน ${x.plan.target_boxes} กล่อง)${x.sku ? '' : ' ⚠️ ยังไม่ผูกกับสินค้า'}`),
      '',
      '<i>พิมพ์ยอดเข้ามาในแชทได้เลย · ถ้ากะนี้ไม่ได้ผลิตก็บอกได้</i>',
    ].join('\n'));
    console.log(`[SPP nudge] ${workDay} ${shift} เตือน ${left.length}/${plans.length} รายการ`);
  } catch (e) {
    console.error('[SPP nudge] failed', e.message);
  }
}

// ── ข้อ 7: ถามข้อมูลย้อนหลังในแชท ──────────────────────────────────────────
// ต่อกับผู้ช่วย AI ตัวเดิมที่มี query_database / query_production_range อยู่แล้ว
// ไม่สร้างสมองที่สอง — คำตอบจึงตรงกับที่ถามในหน้าเว็บเสมอ
// session ผูกกับ chat เพื่อให้ถามต่อเนื่องได้ ("แล้วเดือนก่อนล่ะ")
async function sppAskHistory(chatId, userId, text, user) {
  if (!ai.available('assist')) return sppSend(chatId, '⚠️ ยังตั้งค่า AI ไม่เสร็จ — ดูย้อนหลังที่หน้า "ประวัติยอดผลิต" ในเว็บได้');
  await sppTg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const out = await runAssistantConversation({
      userMessage: text,
      operator: user?.name || '',
      session: `tg:${chatId}`,
      maxTurns: 6,
      systemExtra: [
        'ตอนนี้คุณกำลังตอบในแชท Telegram ของบอทลงยอดผลิต:',
        '- ตอบสั้น กระชับ อ่านบนมือถือได้ ไม่ต้องมีหัวข้อย่อยเยอะ',
        '- ตอบด้วยตัวเลขจริงจากฐานข้อมูลเท่านั้น ห้ามเดา ไม่มีข้อมูลให้บอกตรง ๆ',
        '- ห้ามใช้ Markdown ตาราง (Telegram แสดงไม่ได้) ใช้บรรทัดละรายการแทน',
      ].join('\n'),
    });
    const reply = String(out?.reply || '').trim();
    if (!reply) return sppSend(chatId, 'ไม่มีข้อมูลตอบคำถามนี้');
    // ผู้ช่วยตอบเป็น Markdown — Telegram parse_mode=HTML จะพังถ้ามี < > ดิบ ส่งเป็น escape ไว้ก่อน
    return sppSend(chatId, escapeHtml(reply).slice(0, 3800));
  } catch (e) {
    console.error('[SPP ask] failed', e.message);
    return sppSend(chatId, `❌ ตอบไม่สำเร็จ: ${escapeHtml(e.message)}`);
  }
}

// แกะข้อความ → เติมลงร่าง → ให้ sppAskNext ถามเฉพาะช่องที่ยังขาด
// คืน falsy เมื่อแกะไม่ได้ ให้ผู้เรียกตอบเมนูตามปกติ (ไม่ทำให้พังถ้าไม่มี API key)
async function sppTryFreeText(chatId, userId, draft, text, user) {
  const parsed = await parseSppFreeText(text);
  if (!parsed) return null;

  const miss = new Set(parsed.missing || []);
  // เครื่องมาจาก regex บนข้อความดิบก่อนเสมอ แล้วค่อยถอยไปใช้ที่ AI แยกมา
  const machineText = extractMachine(text) ? text : (parsed.machine || '');
  const productText = String(parsed.product_text || '').trim();
  if (!productText) {
    return sppSend(chatId, [
      '🤔 <b>อ่านแล้วไม่เจอชื่อสินค้า</b>',
      parsed.note ? `<i>${escapeHtml(parsed.note)}</i>` : null,
      '',
      'เลือกจากรายการแทนได้เลย',
    ].filter(Boolean).join('\n'), [
      [{ text: '📋 แผนผลิตวันนี้', callback_data: 's:plan' }],
      [{ text: '🗂 สินค้าทั้งหมด', callback_data: 's:all:0' }],
    ]);
  }

  // ค่าที่แกะได้เก็บพักไว้ก่อน — ใช้ทั้งเส้นที่จับคู่ได้เลยและเส้นที่ต้องให้คนเลือกก่อน
  const pending = { from_text: true };
  if (!miss.has('machine') && parsed.machine) pending.machine = parsed.machine;
  if (!miss.has('prod_qty') && parsed.prod_qty > 0) pending.prod_qty = parsed.prod_qty;
  if (!miss.has('counter')) pending.counter = Math.max(0, Math.round(parsed.counter || 0));
  const dmg = parsed.damaged || {};
  if (Object.values(dmg).some(v => Number(v) > 0)) {
    pending.damaged = Object.fromEntries(SPP_DAMAGE_KINDS.map(d => [d.key, Math.max(0, Math.round(Number(dmg[d.key]) || 0))]));
  }
  draft.header = draft.header || {};
  draft.header.reporter = user?.name || draft.header.reporter || '';

  const hit = await resolveSku(productText, machineText);

  // กำกวม หรือมาจากความจำ → ยื่นปุ่มให้คนกด ห้ามหยิบตัวแรกเอง
  // นี่คือจุดที่เคยพลาด: "Syrup 800 … Linear#3" ถูกจับเป็น SKU ของ Linear#4 แล้วยอดเข้าผิดตัวใน Sheet
  if (hit.status !== 'exact') {
    const remembered = hit.status === 'confirm' ? skuIdOf(hit.sku) : null;
    draft.ask = { text: productText, machine: machineText, pending, cands: hit.candidates.map(c => c.keyword) };
    await setSppSession(chatId, userId, '', draft);
    const kb = hit.candidates.map((s, i) => [{
      text: `${skuIdOf(s) === remembered ? '✓ ' : ''}${s.product_name || s.keyword}`.slice(0, 60),
      callback_data: `s:abind:${i}`,
    }]);
    kb.push([{ text: '📋 แผนผลิตวันนี้', callback_data: 's:plan' }]);
    kb.push([{ text: '🗂 สินค้าทั้งหมด', callback_data: 's:all:0' }]);
    return sppSend(chatId, [
      `🤔 <b>"${escapeHtml(productText)}" คือตัวไหน?</b>`,
      normMachine(machineText) ? `<i>เครื่องที่พิมพ์มา: ${escapeHtml(String(machineText).match(/[Ll]inear\s*#?\s*\d+|\b[Ll]\s*\d+\b/)?.[0] || '')}</i>` : null,
      '',
      remembered
        ? 'ครั้งก่อนเลือกตัวที่มี ✓ ไว้ — <b>ยืนยันอีกครั้ง</b> หรือเปลี่ยนเป็นตัวอื่นก็ได้'
        : (hit.candidates.length ? 'เลือกให้ถูกตัว' : 'หาตัวใกล้เคียงไม่เจอ เลือกจากรายการได้เลย'),
    ].filter(Boolean).join('\n'), kb);
  }

  draft.current = { sku: hit.sku, ...pending };
  const got = [
    `✅ อ่านได้ว่า <b>${escapeHtml(hit.sku.product_name || hit.sku.keyword)}</b>`,
    draft.current.prod_qty ? `ผลิตได้ <b>${draft.current.prod_qty} ${escapeHtml(hit.sku.count_unit || 'กล่อง')}</b>` : null,
    draft.current.machine ? `เครื่อง ${escapeHtml(draft.current.machine)}` : null,
    draft.current.counter !== undefined ? `เลขหน้าเครื่อง ${draft.current.counter}` : null,
  ].filter(Boolean).join(' · ');
  await sppSend(chatId, got);
  return sppAskNext(chatId, userId, draft);
}

// เมนู "แผนผลิตวันนี้" — โชว์ตามแผนที่หัวหน้าวางไว้ ไม่ใช่รายการสินค้าทั้งคลัง
// รายการที่ยังจับคู่กับ SKU ไม่ได้ก็ต้องโผล่ (ติดป้าย ⚠️) ให้คนกดผูกได้ทันที
// ห้ามซ่อน — ของที่หายเงียบคือสาเหตุที่แผน 6 รายการเคยกลายเป็น "ไม่มีแผนผลิตในระบบ"
async function sppShowPlan(chatId, userId, draft, page = 0) {
  const workDay = workDayBKK();
  const shift = currentShiftCode();
  const rows = await sppTodayPlan(workDay);
  if (!rows.length) {
    return sppSend(chatId, `📋 <b>${escapeHtml(workDay)}</b> — ยังไม่มีแผนผลิตในระบบ\nเลือกจากสินค้าทั้งหมดแทนได้`,
      [[{ text: '➕ เลือกจากสินค้าทั้งหมด', callback_data: 's:all:0' }], [{ text: '⬅️ เมนูหลัก', callback_data: 's:menu' }]]);
  }

  // เก็บผลจับคู่ไว้ใน session — ปุ่มอ้างด้วย index เพราะ callback_data จำกัด 64 ไบต์
  draft.plan_list = rows.map(r => ({
    flavor: r.plan.flavor,
    machine_code: r.plan.machine_code || '',
    target: r.plan.target_boxes,
    keyword: r.sku ? r.sku.keyword : null,
    need_confirm: r.status === 'confirm',        // มาจากความจำ → ต้องให้คนยืนยันก่อนใช้
    // หน่วยตามสินค้าจริง ไม่ใช่ "กล่อง" เหมาะ ๆ — ต้มหัวเชื้อนับเป็นหม้อ ไอซิ่งบางตัวเป็นกระสอบ
    // เคยขึ้น "ต้มหัวเชื้อสูตรเก่า · 8 กล่อง" ทั้งที่แผนหมายถึง 8 หม้อ
    unit: r.sku ? (r.sku.count_unit || 'กล่อง') : '',
    cands: (r.candidates || []).map(c => c.keyword),
  }));
  await setSppSession(chatId, userId, '', draft);

  const start = page * SPP_PAGE, slice = draft.plan_list.slice(start, start + SPP_PAGE);
  const kb = slice.map((p, i) => [{
    // ยังไม่รู้ว่าเป็นสินค้าตัวไหน = ยังไม่รู้หน่วย → ไม่เดาหน่วยให้ โชว์แค่ตัวเลข
    text: (p.keyword ? '' : '⚠️ ') + `${p.flavor}${p.target ? ` · ${p.target}${p.unit ? ' ' + p.unit : ''}` : ''}`.slice(0, 60),
    // ตัวที่มาจากความจำก็ต้องผ่านหน้าเลือกเหมือนกัน (ตัวที่จำไว้จะขึ้นก่อนและติ๊ก ✓)
    callback_data: (p.keyword && !p.need_confirm) ? `s:pick:${start + i}` : `s:pmap:${start + i}`,
  }]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀️ ก่อนหน้า', callback_data: `s:plan:${page - 1}` });
  if (start + SPP_PAGE < draft.plan_list.length) nav.push({ text: 'ถัดไป ▶️', callback_data: `s:plan:${page + 1}` });
  if (nav.length) kb.push(nav);
  kb.push([{ text: '🗂 สินค้าทั้งหมด', callback_data: 's:all:0' }]);
  kb.push([{ text: '⬅️ เมนูหลัก', callback_data: 's:menu' }]);

  const unmapped = draft.plan_list.filter(p => !p.keyword).length;
  return sppSend(chatId, [
    `📋 <b>แผนผลิตวันนี้</b> · ${escapeHtml(workDay)} ${escapeHtml(shift)}`,
    `${draft.plan_list.length} รายการ — เลือกตัวที่จะลงยอด`,
    unmapped ? `\n⚠️ <i>${unmapped} รายการยังไม่รู้ว่าเป็นสินค้าตัวไหน กดที่รายการนั้นเพื่อจับคู่</i>` : null,
  ].filter(Boolean).join('\n'), kb);
}

// หน้าเลือกสินค้าให้ "ชื่อในแผน" · เสนอตัวเลือกให้กด ไม่เลือกให้เอง
// ตัวที่เคยเลือกไว้จะขึ้นก่อนและติ๊ก ✓ — คนกดยืนยันเองทุกครั้งตามที่ตกลงไว้
// (จำไว้เพื่อ "เดาให้ก่อน + ทำให้ช่องแผนขึ้นเลข" ไม่ใช่เพื่อตัดสินแทนคน)
async function sppShowPlanMap(chatId, userId, draft, idx) {
  const p = (draft.plan_list || [])[idx];
  if (!p) return sppSend(chatId, 'ไม่พบรายการนี้ในแผน', sppMainMenu(draft));
  const cands = [];
  for (const kw of p.cands || []) {
    const s = (await dbAll('SELECT * FROM sku_master WHERE keyword = ?', [kw]))[0];
    if (s) cands.push(s);
  }
  draft.map_idx = idx;
  await setSppSession(chatId, userId, '', draft);

  const remembered = p.need_confirm ? p.keyword : null;
  const kb = cands.map((s, i) => [{
    text: `${s.keyword === remembered ? '✓ ' : ''}${s.product_name || s.keyword}`.slice(0, 60),
    callback_data: `s:pbind:${i}`,
  }]);
  kb.push([{ text: '🗂 ไม่มีตัวที่ใช่ — ดูสินค้าทั้งหมด', callback_data: 's:all:0' }]);
  kb.push([{ text: '⬅️ กลับไปที่แผน', callback_data: 's:plan:0' }]);

  return sppSend(chatId, [
    `🔗 <b>"${escapeHtml(p.flavor)}" คือสินค้าตัวไหน?</b>`,
    p.machine_code ? `<i>แผนระบุเครื่อง ${escapeHtml(p.machine_code)}</i>` : null,
    '',
    remembered
      ? 'ครั้งก่อนเลือกตัวที่มี ✓ ไว้ — <b>ยืนยันอีกครั้ง</b> หรือเปลี่ยนเป็นตัวอื่นก็ได้'
      : (cands.length ? 'เลือกให้ถูกตัว' : 'ยังหาตัวใกล้เคียงไม่เจอ เลือกจากสินค้าทั้งหมดได้เลย'),
  ].filter(Boolean).join('\n'), kb);
}

async function sppShowAll(chatId, userId, draft, page) {
  const list = await dbAll('SELECT * FROM sku_master WHERE active = 1 ORDER BY group_name, keyword', []);
  if (!list.length) return sppSend(chatId, 'ยังไม่มีสินค้าที่เปิดใช้ในระบบ');
  draft.pick_list = list.map(s => s.keyword);
  await setSppSession(chatId, userId, '', draft);
  return sppSend(chatId, `🗂 <b>สินค้าทั้งหมด</b> (${list.length} รายการ)`, sppSkuKeyboard(list, page, 'all'));
}

// เก็บรายการปัจจุบันเข้าร่างของกะ
// แปลงร่างที่กรอกในแชท → รูปแบบ item ที่ createReportRow รับ
const sppItemOf = (cur) => {
  const sku = cur.sku || {};
  return {
    sku_keyword: sku.keyword,
    product_name: sku.product_name || sku.keyword,
    count_unit: sku.count_unit || 'กล่อง',
    machine: cur.machine,
    counter: cur.counter,
    machine_cycle: 0,
    prod_qty: cur.prod_qty,
    pallet_photo: cur.pallet_photo || '',
    damaged: cur.damaged || {},
    wastes: Object.entries(cur.damaged || {}).filter(([, v]) => v > 0)
      .map(([type, qty]) => ({ type, qty, reason: 'ภาชนะบรรจุชำรุด' })),
  };
};

// ── ข้อ 3: บอทตรวจให้ก่อน แล้วค่อยให้ยืนยัน ────────────────────────────────
// ตรวจ "ก่อน" เขียน DB — จับพิมพ์ผิดตั้งแต่ต้นทาง ไม่ต้องรอหัวหน้ามาไล่แก้ทีหลัง
async function sppCheckItem(chatId, userId, draft) {
  const cur = draft.current || {};
  const sku = cur.sku || {};
  if (!sku.keyword) return sppSend(chatId, 'ไม่มีรายการที่กรอกค้างอยู่', sppMainMenu(draft));

  const workDay = workDayBKK();
  const shift = currentShiftCode();
  const planQty = await resolvePlanQty(workDay, shift, sku).catch(() => null);

  const flags = await checkItemAnomalies({
    sku_keyword: sku.keyword, prod_qty: cur.prod_qty, plan_qty: planQty?.plan_qty,
    pack_factor: sku.pack_factor, counter: cur.counter, pallet_photo: cur.pallet_photo, work_day: workDay,
  }).catch(() => []);

  cur.checked = true;
  await setSppSession(chatId, userId, 'item_checked', draft);

  const unit = sku.count_unit || 'กล่อง';
  const pcs = (Number(cur.prod_qty) || 0) * (Number(sku.pack_factor) || 0);
  const needPhoto = flags.some(f => f.fix === 'photo');

  if (!flags.length) {
    return sppSend(chatId, [
      '🔍 <b>ตรวจแล้ว — ไม่พบอะไรผิดปกติ</b>',
      `${escapeHtml(sku.product_name || sku.keyword)} · <b>${cur.prod_qty} ${escapeHtml(unit)}</b>`,
      // สินค้าที่ไม่มี "ชิ้นต่อหน่วย" (ต้มหัวเชื้อนับเป็นหม้อ) ไม่ต้องโชว์ "คิดเป็น 0 ชิ้น" ให้สับสน
      pcs ? `คิดเป็น ${pcs.toLocaleString()} ชิ้น` : null,
      planQty?.plan_qty ? `เทียบแผนกะนี้ ${planQty.plan_qty} ${escapeHtml(unit)} ✓` : null,
      cur.pallet_photo ? 'มีรูปค้างพาเลทครบ ✓' : null,
    ].filter(Boolean).join('\n'), [
      [{ text: '✅ ยืนยันข้อมูลถูกต้อง', callback_data: 's:confirm' }],
      [{ text: '✏️ ขอแก้', callback_data: 's:redo' }],
    ]);
  }

  return sppSend(chatId, [
    `⚠️ <b>ขอเช็คก่อน ${flags.length} จุด</b>`,
    `${escapeHtml(sku.product_name || sku.keyword)} · <b>${cur.prod_qty} ${escapeHtml(unit)}</b>`,
    '',
    ...flags.map((f, i) => `<b>${i + 1}. ${escapeHtml(f.text)}</b>`),
    '',
    '<i>ถ้าเลขถูกจริง กดยืนยันได้เลย</i>',
  ].join('\n'), [
    [{ text: '✅ ยืนยันข้อมูลถูกต้อง', callback_data: 's:confirm' }],
    [{ text: '✏️ ขอแก้ยอด', callback_data: 's:fixqty' }],
    ...(needPhoto ? [[{ text: '📸 ส่งรูปค้างพาเลท', callback_data: 's:addphoto' }]] : []),
  ]);
}

// ยืนยัน → เขียน DB ทันที (pending_review) หัวหน้าเห็นในหน้า Admin เลย
// ❗บอทไม่ส่งอะไรไปคลัง — คลังได้ลิงก์ก็ต่อเมื่อหัวหน้ากดส่งจากในแอปเท่านั้น
async function sppConfirmItem(chatId, userId, draft, user) {
  const cur = draft.current || {};
  if (!cur.sku?.keyword) return sppSend(chatId, 'ไม่มีรายการที่กรอกค้างอยู่', sppMainMenu(draft));

  const header = {
    // ⚠️ ต้องคำนวณสดทุกครั้ง ห้ามอ่านจาก draft.header ที่ค้างอยู่ในร่าง
    //    ร่างอยู่ใน DB ข้ามวันได้ — เคยทำให้ยอดที่ลงวันที่ 7 ไปโผล่เป็นของวันที่ 4 (หน้า Admin หาไม่เจอ)
    date: workDayBKK(),
    shift: currentShiftCode(),
    reporter: user?.name || draft.header?.reporter || '',
    telegram_user_id: String(userId),
    telegram_chat_id: String(chatId),
  };
  try {
    const out = await addReportToShiftBatch({ header, item: sppItemOf(cur), channel: 'telegram' });
    draft.header = header;
    draft.count = (draft.count || 0) + 1;
    delete draft.current;
    await setSppSession(chatId, userId, '', draft);
    return sppSend(chatId, [
      '📥 <b>เข้าแอปแล้ว — รอหัวหน้าตรวจ</b>',
      `${escapeHtml(out.product_name || out.sku_keyword)} · <b>${out.prod_qty} ${escapeHtml(out.count_unit)}</b>`,
      `<i>กะนี้ลงมาแล้ว ${draft.count} รายการ (ของคุณ)</i>`,
    ].join('\n'), [
      [{ text: '➕ ลงตัวต่อไป', callback_data: 's:plan' }],
      [{ text: '📋 เมนูหลัก', callback_data: 's:menu' }],
    ]);
  } catch (e) {
    console.error('[SPP bot] confirm failed', e.message);
    // ร่างยังอยู่ครบ กดยืนยันใหม่ได้ ไม่ต้องกรอกซ้ำ
    return sppSend(chatId, `❌ บันทึกไม่สำเร็จ: ${escapeHtml(e.message)}\n\nข้อมูลยังอยู่ กดยืนยันใหม่ได้`,
      [[{ text: '✅ ลองยืนยันอีกครั้ง', callback_data: 's:confirm' }], [{ text: '✏️ ขอแก้', callback_data: 's:redo' }]]);
  }
}

// ── webhook ของบอท SPP ──────────────────────────────────────────────────────
app.post('/api/telegram/spp-update', (req, res) => {
  res.sendStatus(200);                       // ตอบทันที กัน Telegram ยิงซ้ำตอนประมวลผลช้า
  (async () => {
    try {
      const upd = req.body || {};
      const cq = upd.callback_query;
      const msg = cq ? cq.message : (upd.message || upd.edited_message);
      const chatId = msg?.chat?.id;
      const userId = (cq ? cq.from?.id : upd.message?.from?.id);
      if (!chatId || !userId) return;

      const sess = await getSppSession(chatId, userId);
      const draft = sess.draft || {};
      let user = await getSppUser(userId);

      // ── ในกลุ่ม บอทเห็นทุกข้อความ (ต้องปิด Privacy Mode ที่ BotFather ถึงจะเห็น)
      //    จึงต้องคัดเองว่าอันไหน "คุยกับบอท" ไม่งั้นบอทจะแทรกทุกบทสนทนาของพนักงานทั้งกลุ่ม
      const isGroup = msg?.chat?.type === 'group' || msg?.chat?.type === 'supergroup';
      const rawText = upd.message?.text || '';
      const uname = (isGroup && rawText) ? await sppBotUsername() : '';
      const atBot = uname ? new RegExp('@' + uname + '\\b', 'i') : null;
      // ตัด @ชื่อบอท ออกก่อน ไม่งั้นมันจะไปปนกับเนื้อความตอนแกะ
      // ⚠️ ห้ามใช้ \s+ ยุบช่องว่าง — มันกลืน \n ไปด้วย แล้วแผนทั้งหน้าจะเหลือบรรทัดเดียว
      //    ตัวแกะแผนอ่านทีละบรรทัด พอไม่มี \n ก็แกะไม่ออก ตกไปใช้ AI แล้วชื่อเพี้ยน/รายการหาย
      const text = atBot ? rawText.replace(new RegExp(atBot.source, 'gi'), ' ').replace(/[^\S\n]+/g, ' ').trim() : rawText;
      const forBot = !isGroup || !!cq
        || (atBot && atBot.test(rawText))                        // พิมพ์ @ชื่อบอท
        || /^\//.test(text)                                      // /คำสั่ง
        || !!upd.message?.reply_to_message?.from?.is_bot         // กด reply ข้อความบอท
        || !!sess.state                                          // ค้างกรอกฟอร์มอยู่ (รวมตอนส่งรูป)
        || SPP_CONTROL_RE.test(text.trim())                      // ยกเลิก / เปลี่ยนชื่อ / เมนู — สั่งบอทตรง ๆ
        || sppLooksLikeWork(text);                               // แผน / คำถาม / น่าจะเป็นการลงยอด
      if (!forBot) return;                                       // คุยกันเองในกลุ่ม — เงียบไว้

      // ชื่อที่ลงทะเบียนไว้ต้องติดมากับร่างเสมอ เพื่อให้เมนูโชว์ "คุณคือ ..." ได้ทุกจุด
      if (user?.name && draft.who !== user.name) draft.who = user.name;

      // ── ขึ้นวันทำงานใหม่ → ล้างของที่เป็น "ของเมื่อวาน" ทิ้ง ──
      // ร่างอยู่ใน DB และอยู่ข้ามวันได้ (จงใจ เพราะ Render หลับกลางกะ) แต่ของที่ผูกกับวัน
      // ต้องไม่ข้ามวันตามไปด้วย · draft.count ที่ค้างทำให้ขึ้น "กะนี้ลงมาแล้ว 3 รายการ"
      // ทั้งที่วันนี้ยังไม่ได้ลงอะไร และ header เก่าเคยลากยอดไปลงเป็นของวันก่อนหน้า
      const today = workDayBKK();
      if (draft.day !== today) {
        draft.day = today;
        delete draft.header;
        delete draft.count;
        delete draft.plan_list;
        delete draft.pick_list;
        // ต้องเขียนกลับทันที — ทางเดินหลายเส้น (เช่นตอบเมนูช่วยเหลือ) ไม่ได้เรียก setSppSession
        // ถ้าไม่เขียนตรงนี้ ของเมื่อวานจะยังค้างอยู่ใน DB แล้วกลับมาหลอกอีกในข้อความถัดไป
        await setSppSession(chatId, userId, sess.state, draft);
      }

      // ยังไม่รู้ว่าเป็นใคร → ถามก่อนเสมอ (ยกเว้นตอนกำลังตอบชื่ออยู่)
      if (!user && !cq && sess.state !== 'ask_name_type') {
        await sppAskWho(chatId, userId, draft);
        return;
      }

      // ── ปุ่ม ──
      if (cq) {
        const data = cq.data || '';
        const ack = (text, alert) => sppTg('answerCallbackQuery', {
          callback_query_id: cq.id, ...(text ? { text } : {}), ...(alert ? { show_alert: true } : {}),
        });

        // ── ตัวตนของคนลงยอด ── (ต้องอยู่ก่อน guard "ต้องลงทะเบียน" ข้างล่าง)
        if (data === 's:whoall') { await ack(); await sppAskWho(chatId, userId, draft, { all: true }); return; }
        if (data === 's:whoami') {
          await ack();
          if (!draft.who) { await sppAskWho(chatId, userId, draft); return; }
          await sppSend(chatId, [
            `👤 ตอนนี้ระบบบันทึกว่าคุณคือ <b>${escapeHtml(draft.who)}</b>`,
            'ยอดที่ลงจากเครื่องนี้จะขึ้นชื่อนี้ทั้งหมด',
            '<i>ถ้าไม่ใช่ กดเปลี่ยนได้เลย — ของที่ลงไปแล้วยังใช้ชื่อเดิม ให้หัวหน้าแก้ในหน้าอนุมัติ</i>',
          ].join('\n'), [
            [{ text: '🔄 เปลี่ยนชื่อ', callback_data: 's:whochg' }],
            [{ text: '⬅️ เมนูหลัก', callback_data: 's:menu' }],
          ]);
          return;
        }
        if (data === 's:whochg') {
          await ack();
          await sppAskWho(chatId, userId, draft, { all: true, note: '🔄 <b>เปลี่ยนชื่อผู้ลงยอด</b> — เลือกชื่อที่ถูกต้อง' });
          return;
        }
        // ปุ่มชื่อ: อ้าง (กะ, sort_order) แล้วอ่านสดจาก DB — ไม่พึ่งลิสต์ที่ค้างในร่างเหมือนเดิม
        if (data.startsWith('s:who:')) {
          const [, , sh, ord] = data.split(':');
          const name = await sppCrewAt(sh, ord);
          if (!name) { await ack('เลือกไม่สำเร็จ ลองใหม่'); return; }
          await ack();
          // ยืนยันก่อนบันทึกเสมอ — ลงทะเบียนผิดคนแล้วยอดทุกใบหลังจากนั้นขึ้นชื่อผิดหมด
          await sppSend(chatId, `ยืนยันว่าคุณคือ <b>${escapeHtml(name)}</b> (${escapeHtml(sh)}) ใช่ไหม?`, [
            [{ text: '✅ ใช่ ฉันเอง', callback_data: `s:whoy:${sh}:${ord}` }],
            [{ text: '↩️ ไม่ใช่ เลือกใหม่', callback_data: 's:whoall' }],
          ]);
          return;
        }
        if (data.startsWith('s:whoy:')) {
          const [, , sh, ord] = data.split(':');
          const name = await sppCrewAt(sh, ord);
          if (!name) { await ack('เลือกไม่สำเร็จ ลองใหม่'); return; }
          const before = draft.who;
          await setSppUser(userId, name, chatId);
          draft.who = name;
          await setSppSession(chatId, userId, '', draft);
          await ack(`สวัสดี ${name}`);
          await sppSend(chatId, before && before !== name
            ? `✅ เปลี่ยนเป็น <b>${escapeHtml(name)}</b> แล้ว\n<i>(ใบที่ลงไปก่อนหน้านี้ยังเป็นชื่อ ${escapeHtml(before)} — ให้หัวหน้าแก้ในหน้าอนุมัติ)</i>`
            : `ยินดีต้อนรับ <b>${escapeHtml(name)}</b> ✅`, sppMainMenu(draft));
          return;
        }
        if (data === 's:nametype') {
          await setSppSession(chatId, userId, 'ask_name_type', draft);
          await ack(); await sppSend(chatId, 'พิมพ์ชื่อ-นามสกุลของคุณ');
          return;
        }
        // อนุมัติทั้งชุดจากในกลุ่ม — อยู่ก่อน guard "ต้องลงทะเบียน" เพราะหัวหน้าอาจไม่เคยคุยกับบอทตัวต่อตัว
        // ชื่อผู้อนุมัติต้องบันทึกได้เสมอ: ใช้ชื่อที่ลงทะเบียนไว้ ไม่มีก็ใช้ชื่อ Telegram
        if (data.startsWith('s:appb:')) {
          const batchId = data.slice(7);
          const approver = user?.name
            || [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ')
            || (cq.from?.username ? '@' + cq.from.username : `TG:${userId}`);
          const rows = await dbAll(
            "SELECT report_id FROM production_reports WHERE batch_id = ? AND status = 'pending_approval' ORDER BY id", [batchId]);
          if (!rows.length) { await ack('ไม่มีรายการที่รออนุมัติในชุดนี้', true); return; }
          let done = 0;
          for (const r of rows) {
            const out = await decideReport(r.report_id, true, approver, { approved_source: 'warehouse', channel: 'telegram' });
            if (out.ok) done++;
          }
          await db.exec("UPDATE production_batches SET status='closed', updated_at=? WHERE batch_id=?", [nowBKK(), batchId]);
          const lineSent = await pushWarehouseCard(batchId).catch(() => 'none');
          await ack(`อนุมัติแล้ว ${done} รายการ`);
          await sendSppTelegram([
            `✅ <b>อนุมัติทั้งชุดแล้ว ${done} รายการ</b>`,
            `ชุด <code>${escapeHtml(batchId)}</code> · โดย <b>${escapeHtml(approver)}</b>`,
            lineSent === 'line' ? 'ส่งการ์ดให้คลังกดรับทราบใน LINE แล้ว 📦' : null,
          ].filter(Boolean).join('\n'));
          return;
        }

        if (!user) { await ack('กด /start ก่อน'); return; }

        if (data === 's:menu') { await ack(); await sppSend(chatId, 'เมนูหลัก', sppMainMenu(draft)); return; }
        if (data === 's:draft') { await ack(); await sppSend(chatId, await sppDraftText(draft), sppMainMenu(draft)); return; }
        if (data === 's:clear') {
          await clearSppSession(chatId, userId); await ack('ล้างที่กรอกค้างแล้ว');
          await sppSend(chatId, 'ล้างที่กรอกค้างแล้ว ✅ <i>(ของที่ยืนยันไปแล้วยังอยู่ในแอป)</i>', sppMainMenu({ who: draft.who })); return;
        }
        // ⚠️ s:planok / s:planno ต้องเช็คก่อน s:plan — ไม่งั้นโดน startsWith ดักไปแสดงแผนแทน
        if (data === 's:planok') { await ack('กำลังบันทึก…'); await sppSavePlan(chatId, userId, draft, user); return; }
        if (data === 's:planno') {
          delete draft.plan_draft; await setSppSession(chatId, userId, '', draft);
          await ack('ยกเลิกแล้ว'); await sppSend(chatId, 'ยกเลิกแผนแล้ว ✅', sppMainMenu(draft)); return;
        }
        // ── เลือกจาก "แผนผลิตวันนี้" ──
        // ⚠️ s:pick / s:pmap / s:pbind ต้องอยู่ก่อน s:plan เพราะข้างล่างใช้ startsWith('s:plan')
        if (data.startsWith('s:pick:')) {
          const p = (draft.plan_list || [])[Number(data.split(':')[2])];
          const sku = p?.keyword ? (await dbAll('SELECT * FROM sku_master WHERE keyword = ?', [p.keyword]))[0] : null;
          if (!sku) { await ack('ไม่พบสินค้านี้'); return; }
          // ไม่ต้องส่งเป้าไปเอง — พอผูก alias แล้ว resolvePlanQty หาแผนของ SKU นี้เจอเองทุกที่
          draft.current = { sku };
          await ack(sku.product_name || sku.keyword);
          await sppAskNext(chatId, userId, draft);
          return;
        }
        // คนเลือกสินค้าให้กับข้อความที่พิมพ์มา (เส้นลงยอดแบบพิมพ์ประโยค)
        if (data.startsWith('s:abind:')) {
          const a = draft.ask;
          const kw = (a?.cands || [])[Number(data.split(':')[2])];
          const sku = kw ? (await dbAll('SELECT * FROM sku_master WHERE keyword = ?', [kw]))[0] : null;
          if (!sku || !skuIdOf(sku)) { await ack('เลือกไม่สำเร็จ'); return; }
          await rememberAlias(a.text, a.machine, skuIdOf(sku), 'floor', user?.name || `TG:${userId}`);
          draft.current = { sku, ...(a.pending || {}) };
          delete draft.ask;
          await setSppSession(chatId, userId, '', draft);
          await ack(`จำแล้ว: ${a.text} = ${sku.product_name || sku.keyword}`.slice(0, 190));
          await sppSend(chatId, `🔗 <b>${escapeHtml(a.text)}</b> = ${escapeHtml(sku.product_name || sku.keyword)}\n<i>ครั้งหน้าจะขึ้นตัวนี้ให้ก่อน แต่ยังต้องกดยืนยันทุกครั้ง</i>`);
          await sppAskNext(chatId, userId, draft);
          return;
        }
        if (data.startsWith('s:pmap:')) {
          await ack(); await sppShowPlanMap(chatId, userId, draft, Number(data.split(':')[2]));
          return;
        }
        if (data.startsWith('s:pbind:')) {
          const idx = draft.map_idx;
          const p = (draft.plan_list || [])[idx];
          const kw = (p?.cands || [])[Number(data.split(':')[2])];
          const sku = kw ? (await dbAll('SELECT * FROM sku_master WHERE keyword = ?', [kw]))[0] : null;
          if (!sku || !skuIdOf(sku)) { await ack('เลือกไม่สำเร็จ'); return; }
          // คนเป็นคนชี้ → จำถาวร ครั้งหน้า resolveSku จะเจอตั้งแต่ขั้น alias
          await rememberAlias(p.flavor, p.machine_code, skuIdOf(sku), 'plan', user?.name || `TG:${userId}`);
          p.keyword = sku.keyword;
          delete draft.map_idx;
          draft.current = { sku };
          await setSppSession(chatId, userId, '', draft);
          await ack(`จำแล้ว: ${p.flavor} = ${sku.product_name || sku.keyword}`.slice(0, 190));
          await sppSend(chatId, `🔗 <b>${escapeHtml(p.flavor)}</b> = ${escapeHtml(sku.product_name || sku.keyword)}\n<i>ครั้งหน้าจะขึ้นตัวนี้ให้ก่อน แต่ยังต้องกดยืนยันทุกครั้ง</i>`);
          await sppAskNext(chatId, userId, draft);
          return;
        }
        if (data.startsWith('s:plan')) { await ack(); await sppShowPlan(chatId, userId, draft, Number(data.split(':')[2] || 0)); return; }
        if (data.startsWith('s:all')) { await ack(); await sppShowAll(chatId, userId, draft, Number(data.split(':')[2] || 0)); return; }

        if (data.startsWith('s:sku:')) {
          const kw = (draft.pick_list || [])[Number(data.split(':')[2])];
          const sku = kw ? (await dbAll('SELECT * FROM sku_master WHERE keyword = ?', [kw]))[0] : null;
          if (!sku) { await ack('ไม่พบสินค้านี้'); return; }
          draft.current = { sku };
          await ack(sku.product_name || sku.keyword);
          await sppAskNext(chatId, userId, draft);
          return;
        }
        if (data.startsWith('s:mc:')) {
          const opts = draft.current?.machine_opts || [];
          const m = opts[Number(data.split(':')[2])];
          if (!m || !draft.current) { await ack('เลือกไม่สำเร็จ'); return; }
          draft.current.machine = m;
          await ack(m);
          await sppAskNext(chatId, userId, draft);
          return;
        }
        if (data === 's:mctype') {
          await setSppSession(chatId, userId, 'item_machine_type', draft);
          await ack(); await sppSend(chatId, 'พิมพ์ชื่อเครื่องบรรจุ'); return;
        }
        if (data === 's:counter0') {
          if (!draft.current) { await ack(); return; }
          draft.current.counter = 0;
          await ack('0'); await sppAskNext(chatId, userId, draft); return;
        }
        if (data === 's:skipphoto') {
          if (!draft.current) { await ack(); return; }
          draft.current.pallet_photo = '';
          await ack('ข้ามรูปแล้ว'); await sppAskNext(chatId, userId, draft); return;
        }
        if (data === 's:nodmg') {
          if (!draft.current) { await ack(); return; }
          draft.current.damaged = {};
          await ack('ไม่มีของเสีย'); await sppAskNext(chatId, userId, draft); return;
        }
        if (data === 's:redo') {
          if (draft.current?.sku) draft.current = { sku: draft.current.sku };
          await ack('กรอกใหม่'); await sppAskNext(chatId, userId, draft); return;
        }
        if (data === 's:check') { await ack('กำลังตรวจ…'); await sppCheckItem(chatId, userId, draft); return; }
        if (data === 's:confirm') { await ack('กำลังบันทึก…'); await sppConfirmItem(chatId, userId, draft, user); return; }
        // แก้ยอดหลังบอททัก — วนกลับไปถามยอดใหม่แล้วตรวจซ้ำ
        if (data === 's:fixqty') {
          if (!draft.current) { await ack(); return; }
          delete draft.current.prod_qty; delete draft.current.checked;
          await ack('พิมพ์ยอดใหม่'); await sppAskNext(chatId, userId, draft); return;
        }
        // ส่งรูปเพิ่มหลังบอททักว่าสินค้าสาย 2 ไม่มีรูป
        if (data === 's:addphoto') {
          if (!draft.current) { await ack(); return; }
          delete draft.current.pallet_photo; delete draft.current.checked;
          await ack('ส่งรูปมาได้เลย'); await sppAskNext(chatId, userId, draft); return;
        }
        // ⚠️ s:fixf / s:fixdone / s:fixcancel ต้องอยู่ก่อน s:fix: — ไม่งั้นโดน startsWith ดักไปเปิดเมนูใหม่
        if (data.startsWith('s:fixf:')) {
          const code = data.slice(7);
          const f = SPP_FIX_FIELDS[code];
          if (!f || !draft.fix?.report_id) { await ack('เลือกไม่สำเร็จ'); return; }
          const r = (await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [draft.fix.report_id]))[0];
          if (!r) { await ack('ไม่พบรายงานนี้'); return; }
          await setSppSession(chatId, userId, `fixv:${code}`, draft);
          await ack();
          await sppSend(chatId, `พิมพ์ <b>${escapeHtml(f.label)}</b> ที่ถูกต้อง (${escapeHtml(f.unit || r.count_unit)})\n<i>ตอนนี้คือ ${sppFixCurrent(r, code)}</i>`);
          return;
        }
        if (data === 's:fixdone') { await ack('กำลังส่ง'); await sppApplyFix(chatId, userId, draft); return; }
        if (data === 's:fixcancel') {
          delete draft.fix;
          await setSppSession(chatId, userId, '', draft);
          await ack('ยกเลิกแล้ว');
          await sppSend(chatId, 'ยกเลิกการแก้แล้ว ✅ <i>(ใบนี้ยังรอแก้อยู่ กดปุ่มในข้อความของหัวหน้าเพื่อเริ่มใหม่)</i>', sppMainMenu(draft));
          return;
        }
        if (data.startsWith('s:fix:')) { await ack(); await sppStartFix(chatId, userId, draft, data.slice(6)); return; }
        await ack();
        return;
      }

      // ── รูป (รูปค้างพาเลท) ──
      const photos = upd.message?.photo;
      if (photos?.length && sess.state === 'item_photo' && draft.current) {
        const fileId = photos[photos.length - 1].file_id;       // ตัวสุดท้าย = ความละเอียดสูงสุด
        const dataUrl = await downloadSppFile(fileId);
        if (!dataUrl) { await sppSend(chatId, '⚠️ โหลดรูปไม่สำเร็จ ลองส่งใหม่'); return; }
        draft.current.pallet_photo = dataUrl;
        await sppSend(chatId, 'รับรูปแล้ว ✅');
        await sppAskNext(chatId, userId, draft);
        return;
      }

      // ── ข้อความ ── (text ตัด @ชื่อบอท ออกแล้วตั้งแต่ต้น)
      if (!text) return;
      await db.exec('UPDATE spp_tg_user SET last_seen_at = ? WHERE telegram_user_id = ?', [nowBKK(), String(userId)]).catch(() => {});
      await sppHandleText(chatId, userId, text, { ...sess, draft }, user);
    } catch (e) { console.error('[SPP bot] error', e); }
  })();
});

// ── วงจร "หัวหน้าส่งกลับให้แก้" ฝั่งบอท ─────────────────────────────────────
// กดปุ่มจากข้อความแจ้งเตือน → เลือกว่าจะแก้ช่องไหน → พิมพ์ค่า → ส่งกลับ · แก้ที่ "แถวเดิม" เสมอ
//
// ⚠️ บทเรียน 2026-08-04 (ใบ RPT-1785852378898-406): เดิมบอทถามได้อย่างเดียวคือ "ยอด"
//    หัวหน้าส่งกลับมาว่า "ใส่เลขหน้าเครื่องและรอบเดินเครื่อง" พนักงานพิมพ์ "36200 40" มาตามที่ถูกขอ
//    บอทเอาไปลงช่องยอด แล้ว sppNum เชื่อมเลขสองตัวเป็น 3620040 → ยอด 3 พันกลายเป็น 3.6 ล้าน
//    ฉะนั้น "ช่องที่แก้ได้" ต้องครอบคลุมสิ่งที่หัวหน้าขอได้จริง และต้องให้คนเลือกช่องเอง ไม่ใช่บอทเดา
const SPP_FIX_FIELDS = {
  qty:     { key: 'prod_qty',      label: 'ยอดผลิต',       where: 'column'  },
  counter: { key: 'counter',       label: 'เลขหน้าเครื่อง', where: 'payload', unit: 'ชิ้น' },
  cycle:   { key: 'machine_cycle', label: 'รอบเดินเครื่อง', where: 'payload', unit: 'รอบ'  },
};
// เตือนเมื่อยอดใหม่ต่างจากของเดิม/จากแผนแบบผิดสังเกต แต่ไม่บล็อก (คนหน้างานรู้ดีกว่าระบบ)
const SPP_FIX_ALERT_RATIO = 5;

const sppFixCurrent = (r, code) => {
  const f = SPP_FIX_FIELDS[code];
  if (f.where === 'column') return Number(r[f.key]) || 0;
  let pl = {};
  try { pl = JSON.parse(r.payload || '{}'); } catch { /* payload เสีย */ }
  return Number(pl[f.key]) || 0;
};

async function sppStartFix(chatId, userId, draft, reportId) {
  const r = (await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [reportId]))[0];
  if (!r) return sppSend(chatId, 'ไม่พบรายงานนี้');
  if (r.status !== 'needs_fix') return sppSend(chatId, `รายการนี้ไม่ได้รออยู่ในสถานะแก้ไขแล้ว (${escapeHtml(r.status)})`);
  draft.fix = { report_id: reportId, pending: {} };
  return sppFixMenu(chatId, userId, draft, r);
}

// เมนูกลางของวงจรแก้ — โชว์ค่าปัจจุบัน + ค่าที่กำลังจะแก้ · ยังไม่เขียน DB จนกว่าจะกด "ส่งกลับให้หัวหน้า"
async function sppFixMenu(chatId, userId, draft, r) {
  const pending = draft.fix?.pending || {};
  await setSppSession(chatId, userId, '', draft);          // ไม่ค้าง state ระหว่างอยู่หน้าเมนู

  const lines = Object.entries(SPP_FIX_FIELDS).map(([code, f]) => {
    const cur = sppFixCurrent(r, code);
    const unit = f.unit || r.count_unit;
    return code in pending
      ? `• ${f.label}: <s>${cur}</s> → <b>${pending[code]} ${escapeHtml(unit)}</b>`
      : `• ${f.label}: ${cur} ${escapeHtml(unit)}`;
  });

  const kb = Object.entries(SPP_FIX_FIELDS).map(([code, f]) =>
    [{ text: `✏️ ${f.label}`, callback_data: `s:fixf:${code}` }]);
  if (Object.keys(pending).length) kb.push([{ text: '📤 ส่งกลับให้หัวหน้า', callback_data: 's:fixdone' }]);
  kb.push([{ text: '❌ ยกเลิก', callback_data: 's:fixcancel' }]);

  return sppSend(chatId, [
    `✏️ <b>แก้ไข: ${escapeHtml(r.product_name || r.sku_keyword)}</b>`,
    `${escapeHtml(r.work_day)} · ${escapeHtml(r.shift)}`,
    r.fix_note ? `\n📝 หัวหน้าแจ้ง: <i>${escapeHtml(r.fix_note)}</i>` : null,
    r.wh_qty != null ? `คลังนับได้: <b>${r.wh_qty} ${escapeHtml(r.count_unit)}</b>` : null,
    '',
    ...lines,
    '',
    Object.keys(pending).length ? 'แก้ช่องอื่นต่อได้ หรือกดส่งกลับให้หัวหน้า' : '<b>เลือกช่องที่จะแก้</b>',
  ].filter(Boolean).join('\n'), kb);
}

// รับค่าที่พิมพ์เข้ามาของช่องที่เลือกไว้ — เก็บไว้ในร่างก่อน ยังไม่แตะ DB
async function sppTakeFixValue(chatId, userId, draft, code, value) {
  const reportId = draft.fix?.report_id;
  if (!reportId) { await setSppSession(chatId, userId, '', draft); return sppSend(chatId, 'ไม่พบรายการที่กำลังแก้'); }
  const r = (await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [reportId]))[0];
  if (!r) { await setSppSession(chatId, userId, '', draft); return sppSend(chatId, 'ไม่พบรายงานนี้'); }

  if (code === 'qty') {
    const old = Number(r.prod_qty) || 0;
    const plan = Number(r.plan_qty) || 0;
    const wild = (old > 0 && (value > old * SPP_FIX_ALERT_RATIO || value * SPP_FIX_ALERT_RATIO < old))
              || (plan > 0 && value > plan * SPP_FIX_ALERT_RATIO);
    if (wild) await sppSend(chatId, `⚠️ <b>ยอดใหม่ต่างจากเดิมมากผิดปกติ</b> (${old} → ${value})\nดูอีกทีว่าพิมพ์ถูกช่องไหม ก่อนกดส่งกลับ`);
  }
  draft.fix.pending[code] = value;
  return sppFixMenu(chatId, userId, draft, r);
}

async function sppApplyFix(chatId, userId, draft) {
  const reportId = draft.fix?.report_id;
  const pending = draft.fix?.pending || {};
  if (!reportId) { await setSppSession(chatId, userId, '', draft); return sppSend(chatId, 'ไม่พบรายการที่กำลังแก้'); }
  if (!Object.keys(pending).length) return sppSend(chatId, 'ยังไม่ได้แก้อะไรเลย');
  const r = (await dbAll('SELECT * FROM production_reports WHERE report_id = ?', [reportId]))[0];
  if (!r) return sppSend(chatId, 'ไม่พบรายงานนี้');

  const sets = [], vals = [], changes = [];
  let pl = {};
  try { pl = JSON.parse(r.payload || '{}'); } catch { /* payload เสีย — เริ่มก้อนใหม่ */ }

  // เลขหน้าเครื่อง / รอบเดินเครื่อง อยู่ใน payload ไม่ใช่คอลัมน์ (ดู createReportRow)
  for (const code of ['counter', 'cycle']) {
    if (!(code in pending)) continue;
    const f = SPP_FIX_FIELDS[code];
    changes.push(`${f.label} ${Number(pl[f.key]) || 0} → ${pending[code]}`);
    pl[f.key] = pending[code];
  }

  // ยอดเปลี่ยน → ชิ้น/สถานะผลิต/ผลต่างกับคลัง ต้องคิดใหม่ทั้งชุด ห้ามคิดแยกส่วน
  const whQty = r.wh_qty;
  const newQty = 'qty' in pending ? pending.qty : (Number(r.prod_qty) || 0);
  if ('qty' in pending) {
    const diff = whQty != null ? whQty - newQty : null;
    const pct = (whQty != null && newQty) ? Math.round((diff / newQty) * 1000) / 10 : null;
    sets.push('prod_qty=?', 'prod_pcs=?', 'prod_status=?', 'variance_qty=?', 'variance_pct=?', 'variance_flag=?');
    vals.push(newQty, newQty * (Number(r.pack_factor) || 0),
      r.plan_qty > 0 && newQty < r.plan_qty ? 'ไม่ได้ยอดผลิต' : 'ได้ยอดผลิต',
      diff, pct, diff === null ? null : (diff === 0 ? 'match' : 'diff'));
    changes.push(`ยอดผลิต ${r.prod_qty} → ${newQty} ${r.count_unit}`);
  }

  // ── คืนสถานะไปที่ "ขั้นเดิมที่ถูกดึงกลับมา" ห้ามข้ามขั้นเด็ดขาด ──
  // ส่งกลับตอนหัวหน้าตรวจ → กลับไปรอหัวหน้าตรวจใหม่ (และต้องล้าง "ตรวจแล้ว" ให้ตรวจซ้ำ เพราะเลขเปลี่ยนไปแล้ว)
  // ส่งกลับตอนรออนุมัติ (คลังนับแล้ว) → กลับไปรออนุมัติเหมือนเดิม
  // ใบเก่าที่ถูกส่งกลับก่อนมีการจำสถานะต้นทาง: เดาจากเลขคลัง — ยังไม่มีเลขคลัง = คลังยังไม่เคยนับ
  const backFrom = pl.sent_back_from || (whQty == null ? 'pending_review' : 'pending_approval');
  const nextStatus = backFrom === 'pending_review' ? 'pending_review' : 'pending_approval';
  delete pl.sent_back_from;                                   // ใช้แล้วทิ้ง ไม่ให้ค้างไปรอบหน้า

  // กลับไปขั้นตรวจ = ยังไม่ผ่านการตรวจ · ห้ามให้ reviewed_at ค้างจากรอบก่อน
  // ไม่งั้นปุ่ม "ส่งให้คลัง" จะปล่อยผ่านทั้งที่หัวหน้ายังไม่เห็นเลขใหม่
  const clearReview = nextStatus === 'pending_review' ? ', reviewed_at=NULL, reviewed_by=NULL' : '';

  // conditional UPDATE + rowCount — กันสองคนกดแก้พร้อมกัน
  const upd = await db.exec(
    `UPDATE production_reports
        SET ${sets.join(', ')}${sets.length ? ',' : ''}
            status=?, payload=?, fix_count=COALESCE(fix_count,0)+1, updated_at=?${clearReview}
      WHERE report_id=? AND status='needs_fix'`,
    [...vals, nextStatus, JSON.stringify(pl), nowBKK(), reportId]
  );
  if (!upd.rowCount) {
    delete draft.fix;
    await setSppSession(chatId, userId, '', draft);
    return sppSend(chatId, '⚠️ รายการนี้ถูกจัดการไปแล้ว');
  }

  delete draft.fix;
  await setSppSession(chatId, userId, '', draft);
  // ร่างถูกล้างไปตอนส่งกะแล้ว → header.reporter ว่าง ต้องดึงชื่อจากทะเบียนผู้ใช้ ไม่ใช่โชว์เลข id
  const fixer = (await getSppUser(userId))?.name || draft.header?.reporter || `TG:${userId}`;
  // เขียนสถานะปลายทางลง log ด้วย — เวลามีใบเพี้ยนจะได้ไล่ย้อนได้ว่ามันเด้งไปขั้นไหนและทำไม
  await logReportEvent(reportId, 'resubmitted', fixer, `${changes.join(' · ')} (→ ${nextStatus})`, 'telegram', 'production');

  const nextLabel = nextStatus === 'pending_review' ? 'รอหัวหน้าตรวจอีกครั้ง' : 'รออนุมัติอีกครั้ง';
  await sendSppTelegram([
    `🔄 <b>ฝ่ายผลิตแก้แล้ว — ${nextLabel}</b>`,
    `${escapeHtml(r.product_name || r.sku_keyword)} · ${escapeHtml(r.work_day)} ${escapeHtml(r.shift)}`,
    ...changes.map(c => `• ${escapeHtml(c)}`),
    whQty != null && 'qty' in pending ? `คลังนับได้ ${whQty} · ผลต่างใหม่ <b>${whQty - newQty > 0 ? '+' : ''}${whQty - newQty}</b>` : null,
  ].filter(Boolean).join('\n'));

  return sppSend(chatId, `✅ ส่งกลับให้หัวหน้าแล้ว\n${changes.map(c => `• ${escapeHtml(c)}`).join('\n')}\n<i>${nextLabel}</i>`, sppMainMenu(draft));
}

// getFile ของบอท SPP (บอทคนละตัวกับ duty → ใช้ token ของตัวเอง)
async function downloadSppFile(fileId) {
  const token = sppBotToken();
  if (!token) return null;
  try {
    const info = await sppTg('getFile', { file_id: fileId });
    const filePath = info?.result?.file_path;
    if (!filePath) return null;
    const resp = await axios.get(`https://api.telegram.org/file/bot${token}/${filePath}`, { responseType: 'arraybuffer' });
    const mime = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const buf = Buffer.from(resp.data);
    const url = await uploadBufferToStorage(buf, mime); // เก็บ URL แทน base64 ถ้าอัปได้
    return url || `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) { console.error('[SPP bot] getFile error', e.response?.data || e.message); return null; }
}

// ตั้ง webhook ของบอท SPP มาที่แอป — คนละบอทกับ CIP จึงไม่ชนกัน
// ⚠️ ต้องปิด Telegram Trigger ใน n8n v4 ก่อน ไม่งั้นแย่ง webhook กัน (Telegram ให้บอทละ 1 ตัว)
const registerSppWebhook = async () => {
  if (!process.env.SPP_TELEGRAM_BOT_TOKEN) return;      // ยังไม่ตั้ง token = ยังไม่เปิดใช้บอทนี้
  try {
    await axios.get(`https://api.telegram.org/bot${process.env.SPP_TELEGRAM_BOT_TOKEN}/setWebhook`,
      { params: { url: `${PUBLIC_URL}/api/telegram/spp-update` } });
    console.log('[SPP bot] webhook registered');
  } catch (e) { console.error('[SPP bot] webhook registration failed', e.response?.data || e.message); }
};

/* ตั้ง webhook ของบอทซ่อมบำรุงมาที่แอป — เป็นคนละบอทกับตัวที่ n8n ถืออยู่ จึงไม่แย่ง webhook กัน
   ⚠️ ห้ามเอา TELEGRAM_BOT_TOKEN ตัวเดิมมาใส่เด็ดขาด — จะแย่ง webhook จาก n8n แล้วสายผลิตเงียบทั้งเส้น
   ยังไม่ตั้ง MAINT_TELEGRAM_BOT_TOKEN = ข้ามเงียบ ๆ (ของเดิมทำงานเหมือนเดิมทุกอย่าง)          */
const registerMaintWebhook = async () => {
  const token = process.env.MAINT_TELEGRAM_BOT_TOKEN;
  if (!token) return;
  if (token === process.env.TELEGRAM_BOT_TOKEN) {
    console.error('[maint bot] ⛔ token ซ้ำกับบอทหลัก — ไม่ตั้ง webhook (จะแย่ง webhook ของ n8n)');
    return;
  }
  try {
    await axios.get(`https://api.telegram.org/bot${token}/setWebhook`,
      { params: { url: `${PUBLIC_URL}/api/telegram/maint-update` } });
    const me = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    console.log(`[maint bot] webhook registered → @${me.data?.result?.username || '?'}`
      + (process.env.MAINT_TELEGRAM_CHAT_ID ? '' : ' ⚠️ ยังไม่ได้ตั้ง MAINT_TELEGRAM_CHAT_ID'));
    // เมนูคำสั่งในช่องพิมพ์ของกลุ่ม — กดเลือกได้ ไม่ต้องจำ
    await axios.post(`https://api.telegram.org/bot${token}/setMyCommands`, {
      commands: [
        { command: 'menu', description: 'กระดานซ่อมบำรุงวันนี้' },
        { command: 'incident', description: 'แจ้งซ่อม — แจ้งเครื่องมีปัญหา' },
        { command: 'cancel', description: 'ยกเลิกที่ค้างอยู่' },
      ],
    });
  } catch (e) { console.error('[maint bot] webhook registration failed', e.response?.data || e.message); }
};

// ═══════════════════════════════════════════════════════════════════════════
// LINE — การ์ดแจ้งคลังหลังหัวหน้าอนุมัติ + ปุ่ม "กดรับทราบ" (เฟส 2)
//   งานจริงคลังคุยกันในกลุ่ม LINE ไม่ใช่ Telegram · การ์ดนี้คือใบรับของ
//   ไม่ได้ตั้ง env → ข้ามเงียบ ๆ ทุกอย่างที่เหลือยังทำงานเหมือนเดิม
// ═══════════════════════════════════════════════════════════════════════════
const LINE_TOKEN = () => process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_SECRET = () => process.env.LINE_CHANNEL_SECRET || '';
const LINE_GROUP = () => process.env.LINE_GROUP_ID || '';

// groupId ล่าสุดที่บอทเห็น — ใช้ครั้งเดียวตอน setup (เชิญ OA เข้ากลุ่ม แล้วมาอ่านค่าไปใส่ env)
let lastSeenLineGroupId = '';

const lineApi = async (path, body) => {
  const token = LINE_TOKEN();
  if (!token) return null;
  try {
    const r = await axios.post(`https://api.line.me/v2/bot/${path}`, body, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, timeout: 15000,
    });
    return r.data ?? {};
  } catch (e) {
    console.error(`[LINE] ${path} error`, e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
    throw e;
  }
};

const lineNum = (v) => (v == null ? '-' : Number(v).toLocaleString());

// การ์ดสรุปให้คลัง — ตัวเลขทั้งสองฝั่งอยู่บนใบเดียว + ปุ่มรับทราบ
function buildWarehouseFlex(batch, reports) {
  const row = (label, value, color) => ({
    type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: label, size: 'sm', color: '#8a7f72', flex: 5 },
      { type: 'text', text: String(value), size: 'sm', weight: 'bold', align: 'end', flex: 4, ...(color ? { color } : {}) },
    ],
  });
  const itemBlocks = reports.slice(0, 10).flatMap(r => {
    const diff = r.variance_qty;
    return [
      { type: 'separator', margin: 'md' },
      { type: 'text', text: r.product_name || r.sku_keyword, size: 'sm', weight: 'bold', wrap: true, margin: 'md' },
      row('ฝ่ายผลิตนับได้', `${lineNum(r.prod_qty)} ${r.count_unit}`),
      row('คลังสินค้านับได้', `${lineNum(r.wh_qty)} ${r.count_unit}`),
      ...(diff ? [row('ผลต่าง', `${diff > 0 ? '+' : ''}${diff} ${r.count_unit}`, '#c62828')] : []),
    ];
  });
  const more = reports.length > 10 ? [{ type: 'text', text: `… และอีก ${reports.length - 10} รายการ`, size: 'xs', color: '#8a7f72', margin: 'md' }] : [];

  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#1c8a4c', paddingAll: '14px',
      contents: [
        { type: 'text', text: '📦 ตรวจรับสินค้าเข้าคลัง', color: '#ffffff', weight: 'bold', size: 'md' },
        { type: 'text', text: `${batch.work_day} · ${batch.shift}`, color: '#dff0e5', size: 'xs', margin: 'sm' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px', contents: [
        row('ผู้ลงยอด', batch.created_by || '-'),
        row('ผู้ตรวจนับคลัง', batch.wh_name || '-'),
        row('จำนวนรายการ', `${reports.length} รายการ`),
        ...itemBlocks, ...more,
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', contents: [{
        type: 'button', style: 'primary', color: '#1c8a4c', height: 'sm',
        action: { type: 'postback', label: '✅ กดรับทราบ', data: `ack:${batch.batch_id}`, displayText: 'รับทราบยอดเข้าคลังแล้ว' },
      }],
    },
  };
}

// ส่งการ์ดเข้ากลุ่มคลัง — เรียกหลังอนุมัติครบทั้งชุด
async function pushWarehouseCard(batchId) {
  if (!LINE_TOKEN() || !LINE_GROUP()) return 'none';
  const batch = (await dbAll('SELECT * FROM production_batches WHERE batch_id = ?', [batchId]))[0];
  if (!batch) return 'none';
  const reports = await dbAll("SELECT * FROM production_reports WHERE batch_id = ? AND status = 'approved' ORDER BY id", [batchId]);
  if (!reports.length) return 'none';

  const now = nowBKK();
  try {
    await lineApi('message/push', {
      to: LINE_GROUP(),
      messages: [{ type: 'flex', altText: `ตรวจรับสินค้าเข้าคลัง ${batch.work_day} ${batch.shift} (${reports.length} รายการ)`, contents: buildWarehouseFlex(batch, reports) }],
    });
    for (const r of reports) {
      await db.exec('UPDATE production_reports SET line_pushed_at=?, line_push_error=NULL WHERE report_id=?', [now, r.report_id]);
    }
    console.log(`[LINE] warehouse card pushed batch=${batchId} items=${reports.length}`);
    return 'line';
  } catch (e) {
    const msg = String(e.response?.data?.message || e.message).slice(0, 300);
    for (const r of reports) {
      await db.exec('UPDATE production_reports SET line_push_error=? WHERE report_id=?', [msg, r.report_id]);
    }
    return 'none';
  }
}

// ตรวจลายเซ็น: HMAC-SHA256 ของ raw body ด้วย channel secret → base64
// เทียบด้วย timingSafeEqual · ยาวไม่เท่ากันถือว่าไม่ผ่านทันที (timingSafeEqual โยน error ถ้าความยาวต่างกัน)
function verifyLineSignature(req) {
  const secret = LINE_SECRET();
  if (!secret) return false;
  const sig = req.get('X-Line-Signature') || '';
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('base64');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/line/webhook', async (req, res) => {
  if (!LINE_SECRET()) return res.status(503).json({ error: 'ยังไม่ได้ตั้ง LINE_CHANNEL_SECRET' });
  if (!verifyLineSignature(req)) {
    console.warn('[LINE] bad signature from', req.ip);
    return res.sendStatus(401);
  }
  res.sendStatus(200);                       // ตอบก่อน แล้วค่อยทำงาน — LINE timeout เร็ว
  (async () => {
    for (const ev of (req.body?.events || [])) {
      try {
        // จำ groupId ไว้ให้ตอน setup อ่านไปใส่ env (ครั้งเดียว)
        const gid = ev.source?.groupId || ev.source?.roomId;
        if (gid && gid !== lastSeenLineGroupId) {
          lastSeenLineGroupId = gid;
          console.log(`[LINE] group id seen: ${gid}`);
        }
        if (ev.type !== 'postback') continue;
        const data = String(ev.postback?.data || '');
        if (!data.startsWith('ack:')) continue;
        await handleWarehouseAck(data.slice(4), ev);
      } catch (e) { console.error('[LINE] event error', e.message); }
    }
  })();
});

async function handleWarehouseAck(batchId, ev) {
  const reports = await dbAll("SELECT report_id, wh_ack_at FROM production_reports WHERE batch_id = ? AND status = 'approved'", [batchId]);
  if (!reports.length) return;
  if (reports.every(r => r.wh_ack_at)) {
    if (ev.replyToken) await lineApi('message/reply', { replyToken: ev.replyToken, messages: [{ type: 'text', text: 'ชุดนี้กดรับทราบไปแล้ว ✅' }] });
    return;
  }

  // ชื่อคนกด — ดึงจากโปรไฟล์ LINE เพื่อให้ audit trail มีชื่อคน ไม่ใช่ userId ดิบ
  let who = '';
  const uid = ev.source?.userId;
  const gid = ev.source?.groupId;
  if (uid) {
    try {
      const token = LINE_TOKEN();
      const path = gid ? `group/${gid}/member/${uid}` : `profile/${uid}`;
      const r = await axios.get(`https://api.line.me/v2/bot/${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
      who = r.data?.displayName || '';
    } catch { /* ดึงชื่อไม่ได้ก็ยังบันทึกเวลาได้ */ }
  }
  const actor = who || (uid ? `LINE:${uid.slice(0, 8)}` : 'คลัง');
  const now = nowBKK();
  for (const r of reports) {
    const upd = await db.exec('UPDATE production_reports SET wh_ack_at=?, wh_ack_by=?, updated_at=? WHERE report_id=? AND wh_ack_at IS NULL',
      [now, actor, now, r.report_id]);
    if (upd.rowCount) await logReportEvent(r.report_id, 'warehouse_ack', actor, 'คลังกดรับทราบในกลุ่ม LINE', 'line', 'warehouse');
  }
  console.log(`[LINE] warehouse ack batch=${batchId} by=${actor}`);
  if (ev.replyToken) {
    await lineApi('message/reply', {
      replyToken: ev.replyToken,
      messages: [{ type: 'text', text: `รับทราบแล้ว ✅\nผู้รับ: ${actor}\nบันทึกเข้าระบบเรียบร้อย` }],
    }).catch(() => {});
  }
}

// ใช้ตอน setup ครั้งเดียว: เชิญ OA เข้ากลุ่มคลัง → พิมพ์อะไรก็ได้ในกลุ่ม → เรียก endpoint นี้อ่าน groupId
app.get('/api/line/group-id', (req, res) => {
  res.json({
    group_id: lastSeenLineGroupId || null,
    configured_group_id: LINE_GROUP() || null,
    has_token: !!LINE_TOKEN(),
    has_secret: !!LINE_SECRET(),
    hint: lastSeenLineGroupId
      ? 'เอา group_id ไปใส่ env LINE_GROUP_ID บน Render แล้ว redeploy'
      : 'ยังไม่เห็น event จากกลุ่มไหนเลย — เชิญ LINE OA เข้ากลุ่มคลังแล้วพิมพ์ข้อความสักครั้ง',
  });
});

// ตามเก็บรายการที่อนุมัติแล้วแต่เขียนชีตไม่สำเร็จ (n8n ล่ม/เน็ตหลุด) — เกาะจังหวะ scheduler 60 วิ
async function sheetSyncTick() {
  try {
    // เก็บทั้งที่ error และที่ค้าง 'pending' — syncReportToSheet ยิงแบบ fire-and-forget
    // ถ้าเซิร์ฟเวอร์ดับ/หลับกลางคัน (Render free tier หลับบ่อย) แถวจะค้าง pending ตลอดกาล
    // และไม่มีใครตามเก็บ · กัน re-send ซ้ำระหว่างที่ยังยิงอยู่ด้วยการดูเฉพาะที่อนุมัติเกิน 5 นาที
    const staleBefore = bkkPlusHours(-5 / 60);
    const rows = await dbAll(
      `SELECT report_id FROM production_reports
        WHERE status='approved' AND sheet_attempts < 10
          AND (sheet_status='error' OR (sheet_status='pending' AND decided_at < ?))
        ORDER BY id LIMIT 5`, [staleBefore]
    );
    for (const r of rows) await syncReportToSheet(r.report_id);
  } catch (e) { console.error('[SPP] sheetSyncTick', e.message); }
}

// ดึงแผนผลิตของวัน (default = วันนี้)
app.get('/api/production/plan', (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  db.all("SELECT * FROM production_plans WHERE plan_date = ? ORDER BY line_name, flavor", [date], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ planDate: date, items: rows });
  });
});

// ── แผนผลิตรายกะ (material balance Phase 1) — บันทึก/ดึงเป้าผลิตต่อรสต่อกะ ──
// upsert หลายรายการต่อ (วันทำงาน+กะ) · 1 batch = 100 boxes (client คำนวณ target_batches มาแล้ว/เดารับได้)
app.post('/api/shift-plan', async (req, res) => {
  const { workDay, shift, operator, items } = req.body;
  const day = workDay || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  if (!shift) return res.status(400).json({ error: 'shift จำเป็น' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items ต้องเป็น array และไม่ว่าง' });
  const createdAt = nowBKK();
  const sql = `INSERT INTO shift_plans (work_day, shift, flavor, target_boxes, target_batches, staff, machine_code, spec, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_day, shift, flavor)
    DO UPDATE SET target_boxes=excluded.target_boxes, target_batches=excluded.target_batches, staff=excluded.staff, machine_code=excluded.machine_code, spec=excluded.spec, created_at=excluded.created_at`;
  try {
    let saved = 0;
    for (const it of items) {
      const flavor = String(it.flavor || '').trim();
      const boxes = Math.round(Number(it.target_boxes));
      if (!flavor || !isFinite(boxes) || boxes <= 0) continue;
      const batches = isFinite(Number(it.target_batches)) ? Number(it.target_batches) : Math.round((boxes / 100) * 10) / 10;
      const staff = isFinite(Number(it.staff)) && Number(it.staff) > 0 ? Math.round(Number(it.staff)) : null;
      await db.exec(sql, [day, shift, flavor, boxes, batches, staff, String(it.machine_code || ''), String(it.spec || ''), createdAt]);
      saved++;
    }
    res.json({ success: true, saved, workDay: day, shift });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shift-plan', (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const params = [date]; let where = 'work_day = ?';
  if (req.query.shift) { where += ' AND shift = ?'; params.push(req.query.shift); }
  db.all(`SELECT * FROM shift_plans WHERE ${where} ORDER BY shift, flavor`, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ workDay: date, items: rows });
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

  const doneTasks = await dbAll(`SELECT line_name, title, created_by, completed_at FROM daily_tasks WHERE task_date IN (?, ?) AND status = 'done' AND completed_at IS NOT NULL`, [date, next]);
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
    // ลด egress: ไม่ดึง images/done_images (base64) — client ไม่ได้ใช้รูปจาก endpoint นี้
    const items = await dbAll(
      `SELECT id, task_date, line_name, category, flavor, title, detail, target_count, actual_count,
         status, source, recurring_id, created_by, created_at, due_time, completed_at,
         assignee, location, priority, handoff_from, done_by, remind_at, remind_lead, reminded
       FROM daily_tasks WHERE task_date = ? ORDER BY line_name, category, id`, [date]);
    res.json({ date, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// กรองรายการรูปที่รับเข้ามา — รับได้ทั้ง URL (Supabase Storage) และ base64 (fallback ตอนไม่มี Supabase)
const filterImgs = (arr) => (Array.isArray(arr) ? arr : []).filter(x => typeof x === 'string' && (x.startsWith('http') || x.startsWith('data:'))).slice(0, 10);

// โหลดรูปของงานเฉพาะตอนกดดู (แยกจาก list เพื่อลด egress ของ Neon)
app.get('/api/tasks/images', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const row = (await dbAll('SELECT images, done_images FROM daily_tasks WHERE id = ?', [id]))[0];
    const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
    res.json({ images: parse(row && row.images), doneImages: parse(row && row.done_images) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/generate', async (req, res) => {
  const date = req.body.date || req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  try {
    await generateTasksForDate(date, req.body.operator);
    await syncTaskProgress(date);
    const items = await dbAll(
      `SELECT id, task_date, line_name, category, flavor, title, detail, target_count, actual_count,
         status, source, recurring_id, created_by, created_at, due_time, completed_at,
         assignee, location, priority, handoff_from, done_by, remind_at, remind_lead, reminded
       FROM daily_tasks WHERE task_date = ? ORDER BY line_name, category, id`, [date]);
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
      scheduleVaultTaskSync(d);
    });
});

/* แก้งานใน daily_tasks — ใช้ทั้ง "ติ๊ก/บันทึกผล" (ของเดิม) และ "แก้ไขงานมอบหมาย" จากกระดาน
   ⚠️ สองความหมายที่ห้ามปนกัน:
     · ไม่ส่ง key มาเลย      = ไม่แตะของเดิม  → COALESCE(?, col)
     · ส่ง key มาเป็นค่าว่าง = ล้างค่าทิ้ง     → ต้องต่อ SET เองทีละช่อง (COALESCE ทำไม่ได้)
   ช่อง machine/due_time/priority อยู่กลุ่มหลัง เพราะ "ลบเครื่อง/ลบเวลาที่กรอกผิด" ต้องทำได้จริง */
app.post('/api/tasks/update', async (req, res) => {
  const b = req.body || {};
  const { id, status, actualCount, title, detail, doneBy } = b;
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const completedAt = status === 'done' ? nowBKK() : null;
  // ปิดงานพร้อมแนบรูปหลังทำ (หน้าติดตามผลใบตรวจ) — ไม่ส่งมาก็ไม่แตะของเดิม (COALESCE)
  const di = filterImgs(b.doneImages);
  const sets = [
    'status = COALESCE(?, status)', 'actual_count = COALESCE(?, actual_count)',
    'title = COALESCE(?, title)', 'detail = COALESCE(?, detail)',
    'done_images = COALESCE(?, done_images)', 'done_by = COALESCE(?, done_by)',
    "completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END",
  ];
  const args = [status || null, actualCount == null ? null : Number(actualCount), title || null, detail || null,
    di.length ? JSON.stringify(di) : null, doneBy || null, status || '', completedAt];

  if (has('machine')) { sets.push('machine = ?'); args.push(String(b.machine || '').trim() || null); }
  if (has('dueTime')) {
    const t = String(b.dueTime || '').trim();
    if (t && !/^\d{1,2}:\d{2}$/.test(t)) return res.status(400).json({ error: 'เวลาต้องเป็นรูปแบบ HH:MM' });
    sets.push('due_time = ?'); args.push(t || null);
  }
  // 'urgent' = การ์ดแดง · อย่างอื่นถือเป็นงานปกติ (เก็บ null ไม่ใช่ '' — Postgres/SQLite เทียบ '' คนละแบบ)
  if (has('priority')) { sets.push('priority = ?'); args.push(b.priority === 'urgent' ? 'urgent' : null); }

  try {
    /* UNIQUE(task_date, line_name, category, title) — เปลี่ยนชื่อไปชนงานเดิมของคนเดียวกันได้
       ไม่กันไว้จะเด้ง error ดิบ ๆ จาก DB ที่หน้าเว็บอ่านไม่รู้เรื่อง (บทเรียนเดียวกับ pm/update) */
    if (title) {
      const cur = await dbGet('SELECT task_date, line_name, category, title FROM daily_tasks WHERE id = ?', [id]);
      if (!cur) return res.status(404).json({ error: 'ไม่พบงานนี้' });
      if (String(title) !== cur.title) {
        const dup = await dbGet(
          'SELECT id FROM daily_tasks WHERE task_date = ? AND line_name = ? AND category = ? AND title = ? AND id <> ?',
          [cur.task_date, cur.line_name, cur.category, String(title), id]);
        if (dup) return res.status(409).json({ error: 'duplicate', message: `มีงาน "${title}" ของคนเดียวกันในวันนี้อยู่แล้ว` });
      }
    }
    await db.exec(`UPDATE daily_tasks SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
    res.json({ success: true });
    scheduleVaultSyncForTask(id);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ย้ายงานมอบหมายไปให้อีกคน (ลากการ์ดในบอร์ดหน้าที่)
// ต้องอัปเดตทั้ง assignee และ line_name เพราะงานมอบหมายเก็บ line_name = คนรับ
// (UNIQUE(task_date, line_name, category, title) คือตัวที่ทำให้งานชื่อเดียวกันมอบหลายคนได้)
app.post('/api/tasks/reassign', async (req, res) => {
  const { id, assignTo, operator } = req.body;
  if (!id || !assignTo) return res.status(400).json({ error: 'id/assignTo จำเป็น' });
  try {
    const row = (await dbAll('SELECT task_date, category, title, assignee, priority, audit_batch FROM daily_tasks WHERE id = ?', [id]))[0];
    if (!row) return res.status(404).json({ error: 'ไม่พบงานนี้' });
    if (row.assignee === assignTo) return res.json({ success: true, unchanged: true });
    // กันชนกับงานชื่อเดียวกันที่ปลายทางมีอยู่แล้ว — ไม่กันจะติด UNIQUE แล้ว error ดิบๆ
    const dup = (await dbAll('SELECT id FROM daily_tasks WHERE task_date = ? AND line_name = ? AND category = ? AND title = ?',
      [row.task_date, assignTo, row.category, row.title]))[0];
    if (dup) return res.status(409).json({ error: 'duplicate', message: `${dutyName(assignTo)} มีงาน "${row.title}" อยู่แล้ว` });
    await db.exec('UPDATE daily_tasks SET assignee = ?, line_name = ? WHERE id = ?', [assignTo, assignTo, id]);
    res.json({ success: true, from: row.assignee, to: assignTo });
    if (process.env.TELEGRAM_CHAT_ID) {
      notify(dutyTopic(row.audit_batch, assignTo), `🔁 <b>ย้ายงาน</b>\n${catIcon(row.category)} ${escapeHtml(row.title)}${row.priority === 'urgent' ? '  🔴 <b>ด่วน</b>' : ''}\n\n`
        + `👤 ${escapeHtml(dutyName(row.assignee))} → <b>${escapeHtml(dutyName(assignTo))}</b>\n`
        + `🗓 ${thaiDate(row.task_date)}\n✍️ โดย ${escapeHtml(operator || 'จักรกฤษ')}`);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/delete-one', async (req, res) => {
  // อ่านวันที่ก่อนลบ ไม่งั้นไม่เหลืออะไรให้รู้ว่าต้องเขียนบันทึกวันไหนใหม่
  let date = null;
  try { date = (await dbGet('SELECT task_date FROM daily_tasks WHERE id = ?', [req.body.id]))?.task_date; } catch { /* ช่างมัน */ }
  db.run('DELETE FROM daily_tasks WHERE id = ?', [req.body.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
    if (date) scheduleVaultTaskSync(date);
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
// รายชื่อ + เช็กลิสต์เก็บใน DB (ตาราง duty_people / duty_routines) เพื่อเพิ่ม/แก้เองได้
// ค่าด้านล่างเป็น "seed เริ่มต้น" ใช้ครั้งแรกที่ตารางว่างเท่านั้น (ย้ายจาก hardcode เดิม)
const DUTY_PEOPLE_SEED = [
  { key: 'mam',  name: 'ม้ำ',   role: 'ผู้ช่วยหลัก · ควบคุมผลิต & CIP', color: '#00897b', wash: '#e0f2f1', initial: 'ม', dot: '🟢' },
  { key: 'nai',  name: 'นาย',   role: 'ส่วนผสม & ผู้ช่วย ม้ำ',        color: '#3949ab', wash: '#e8eaf6', initial: 'น', dot: '🔵' },
  { key: 'pluk', name: 'พลุ๊ก', role: 'ส่วนผสม & เครื่องบรรจุ',       color: '#c2185b', wash: '#fce4ec', initial: 'พ', dot: '🟣' },
  { key: 'kao',  name: 'เก้า',  role: 'ผู้ช่วยการผลิต',               color: '#f57f17', wash: '#fff8e1', initial: 'ก', dot: '🟠' },
];
// จานสีสำรองสำหรับคนที่เพิ่มใหม่เอง (วนใช้ตามลำดับ)
const DUTY_PALETTE = [
  { color: '#00897b', wash: '#e0f2f1' }, { color: '#3949ab', wash: '#e8eaf6' },
  { color: '#c2185b', wash: '#fce4ec' }, { color: '#f57f17', wash: '#fff8e1' },
  { color: '#00838f', wash: '#e0f7fa' }, { color: '#6d4c41', wash: '#efebe9' },
  { color: '#5e35b1', wash: '#ede7f6' }, { color: '#43a047', wash: '#e8f5e9' },
];
const DUTY_DOTS = ['🟢', '🔵', '🟣', '🟠', '🟡', '🟤', '🔴', '⚪'];
const ROUTINES_SEED = {
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
  kao: [],
};

// ── cache รายชื่อในหน่วยความจำ เพื่อให้ dutyName()/DUTY_DOT ใช้แบบ sync ได้ ────
// refresh ตอน seed และทุกครั้งที่มีการแก้ไขคน
let _peopleCache = [];
const _peopleNameMap = {};
const _peopleDotMap = {};
const _peopleKindMap = {};
async function refreshPeopleCache() {
  try {
    _peopleCache = await dbAll('SELECT * FROM duty_people WHERE active = 1 ORDER BY sort_order, created_at', []);
  } catch { _peopleCache = []; }
  for (const k of Object.keys(_peopleNameMap)) delete _peopleNameMap[k];
  for (const k of Object.keys(_peopleDotMap)) delete _peopleDotMap[k];
  for (const k of Object.keys(_peopleKindMap)) delete _peopleKindMap[k];
  for (const p of _peopleCache) {
    _peopleNameMap[p.person_key] = p.name; _peopleDotMap[p.person_key] = p.dot || '👤';
    _peopleKindMap[p.person_key] = p.kind || 'shift';
  }
}
const dutyName = (k) => _peopleNameMap[k] || k;
const dutyDot = (k) => _peopleDotMap[k] || '👤';
// เป็นช่างในทีมซ่อมบำรุงไหม — ใช้ตัดสินว่างานของคนนี้แจ้งเข้ากลุ่มไหน (dutyTopic)
// ไม่รู้จัก/ไม่มีในแคช = ไม่ใช่ช่าง → ตกไปกลุ่มผลิต (ปลอดภัยกว่า: คนทำงานอยู่กลุ่มนั้น)
const isMaintPerson = (k) => !!k && _peopleKindMap[k] === 'maint';
const getPeople = () => _peopleCache;

// seed duty board ครั้งแรก (idempotent) — คนจาก DUTY_PEOPLE_SEED, งานจาก ROUTINES_SEED
async function seedDutyBoard() {
  const existing = await dbAll('SELECT person_key FROM duty_people', []);
  if (!existing.length) {
    let i = 0;
    for (const p of DUTY_PEOPLE_SEED) {
      await db.exec(
        `INSERT INTO duty_people (person_key, name, role, color, wash, initial, dot, sort_order, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (person_key) DO NOTHING`,
        [p.key, p.name, p.role, p.color, p.wash, p.initial, p.dot, i++, nowBKK()]);
      // seed เช็กลิสต์ของคนนี้ (เดินต้นไม้ รักษา node_key เดิมไว้)
      await seedRoutineNodes(p.key, ROUTINES_SEED[p.key] || [], null);
    }
  }
  await refreshPeopleCache();
}
// insert เช็กลิสต์แบบ recursive — ใช้ lastID (dbRun) เป็น parent ของลูก
async function seedRoutineNodes(personKey, nodes, parentId) {
  let order = 0;
  for (const n of nodes) {
    const r = await dbRun(
      `INSERT INTO duty_routines (person_key, parent_id, node_key, title, mono, sort_order, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [personKey, parentId, n.key, n.title, n.mono ? 1 : 0, order++, nowBKK()]);
    if (n.children && n.children.length) await seedRoutineNodes(personKey, n.children, r.lastID);
  }
}

// ══ ระบบแบ่งงานใบตรวจอัตโนมัติ (Audit auto-assign) ═══════════════════════════
// ผู้รับผิดชอบใบตรวจ (kind='audit') — แยกจากทีมกะ ไม่ปนใน duty board รายวัน
// "เก้า" (kao) อยู่ในทีมกะแล้ว จึงไม่ seed ซ้ำ — กฎอ้าง key เดิมได้เลย
const AUDIT_ROSTER_SEED = [
  { key: 'jiab',   name: 'เจี๊ยบ',        role: 'ดูแลห้องเก็บ Ingredient',   dot: '🟡' },
  { key: 'keng',   name: 'เก่ง',          role: 'ดูแลหน้าไลน์ Icing',        dot: '🟤' },
  { key: 'dong',   name: 'โด้ง',          role: 'ดูแลชั้น 3',                dot: '🔴' },
  { key: 'note',   name: 'โน้ต',          role: 'ดูแลชั้น 3',                dot: '⚪' },
  { key: 'boy',    name: 'บอย (ดำรงค์)',  role: 'ดูแลโซน Icing / บรรจุ',      dot: '🟢' },
  { key: 'maeban', name: 'แม่บ้าน',       role: 'ความสะอาด/PPE ส่วนกลาง',    dot: '🔵' },
  { key: 'chang',  name: 'ทีมช่าง',       role: 'งานซ่อมบำรุง',              dot: '🔧' },
];
// กฎแบ่งงาน (seed) — ถอดจากใบตรวจจริง 17 ข้อ; specificity มาก = จำเพาะ = แมตช์ก่อน
const ASSIGN_RULES_SEED = [
  // keyword (อ่านช่อง "ประเด็น") — override โซน
  { rule_type: 'keyword', pattern: 'ประตูชำรุด', owner_key: 'chang',  category: 'maintenance', priority: 'normal', specificity: 100 },
  { rule_type: 'keyword', pattern: 'ปิดไม่ได้',  owner_key: 'chang',  category: 'maintenance', priority: 'normal', specificity: 100 },
  { rule_type: 'keyword', pattern: 'GMP',        owner_key: 'maeban', category: 'cleaning',    priority: 'normal', specificity: 95 },
  { rule_type: 'keyword', pattern: 'safety',     owner_key: 'maeban', category: 'cleaning',    priority: 'normal', specificity: 95 },
  { rule_type: 'keyword', pattern: 'หมวก',       owner_key: 'maeban', category: 'cleaning',    priority: 'normal', specificity: 95 },
  // zone (อ่านช่อง "สถานที่")
  { rule_type: 'zone', pattern: 'ingredient',     owner_key: 'jiab',   category: 'cleaning', priority: 'normal', specificity: 90 },
  { rule_type: 'zone', pattern: 'หน้าไลน์ icing', owner_key: 'keng',   category: 'cleaning', priority: 'normal', specificity: 85 },
  { rule_type: 'zone', pattern: 'ห้องแต่งตัว',    owner_key: 'maeban', category: 'cleaning', priority: 'normal', specificity: 80 },
  { rule_type: 'zone', pattern: 'ห้องต้ม',        owner_key: 'kao',    category: 'cleaning', priority: 'normal', specificity: 70 },
  { rule_type: 'zone', pattern: 'icing',          owner_key: 'boy',    category: 'cleaning', priority: 'normal', specificity: 50 },
  { rule_type: 'zone', pattern: 'ชั้น 2',         owner_key: 'kao',    category: 'cleaning', priority: 'normal', specificity: 40 },
  { rule_type: 'zone', pattern: 'ชั้น 3',         owner_key: 'dong',   category: 'cleaning', priority: 'normal', specificity: 30 },
  { rule_type: 'zone', pattern: 'ชั้น 1',         owner_key: 'maeban', category: 'cleaning', priority: 'normal', specificity: 30 },
];

let _assignRules = [];
async function refreshAssignRules() {
  try { _assignRules = await dbAll('SELECT * FROM assign_rules WHERE active = 1 ORDER BY specificity DESC, id', []); }
  catch { _assignRules = []; }
}
// seed คน audit + กฎ (idempotent) — ผูก dot/สีจาก DUTY_PALETTE ต่อจากทีมกะ
async function seedAuditBoard() {
  let i = DUTY_PEOPLE_SEED.length;
  for (const p of AUDIT_ROSTER_SEED) {
    const pal = DUTY_PALETTE[i % DUTY_PALETTE.length];
    await db.exec(
      `INSERT INTO duty_people (person_key, name, role, color, wash, initial, dot, kind, sort_order, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'audit', ?, 1, ?) ON CONFLICT (person_key) DO NOTHING`,
      [p.key, p.name, p.role, pal.color, pal.wash, p.name.slice(0, 1), p.dot, i, nowBKK()]);
    i++;
  }
  const has = await dbAll('SELECT id FROM assign_rules LIMIT 1', []);
  if (!has.length) {
    for (const r of ASSIGN_RULES_SEED) {
      await db.exec(
        `INSERT INTO assign_rules (rule_type, pattern, owner_key, co_owner_key, category, priority, specificity, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [r.rule_type, r.pattern, r.owner_key, r.co_owner_key || null, r.category, r.priority, r.specificity, nowBKK()]);
    }
  }
  await refreshPeopleCache();
  await refreshAssignRules();
}

// ══ โซนเจ้าหน้าที่ซ่อมบำรุง (kind='maint') ═══════════════════════════════════
// แยกกระดานจากทีมกะ เหมือนที่ใบตรวจ (kind='audit') แยกอยู่แล้ว
// งานประจำถอดจากตารางจริง "เครื่องจักร × รายการที่ต้องทำ × เป้าหมาย × ผู้รับผิดชอบหลัก × ผู้รับผิดชอบ 2"
//   owner_role='mt' → เป็นงานของทีมซ่อมบำรุง ขึ้นในเช็กลิสต์ให้ติ๊ก
//   owner_role อื่น + co_owner_role='mt' → ทีมผลิตทำ เราแค่ตามผล (ขึ้นแถบ "ตามผล" ไม่ต้องติ๊ก)
// seed ทั้ง 34 แถวไว้ตั้งแต่แรก เพื่อให้หน้า "ทะเบียนงาน PM" ที่จะทำทีหลังอ่านตารางเดียวกันได้
const MAINT_PERSON_SEED = {
  key: 'jakkrit', name: 'จักรกฤษ พูลสวัสดิ์', role: 'เจ้าหน้าที่ซ่อมบำรุง · หัวหน้าทีม',
  color: '#ff6b00', wash: '#fff3ea', initial: 'จ', dot: '🔧',
};
const MAINT_SHIFT_DEFAULT = 'กะ 1';
// [เครื่องจักร, รายการที่ต้องทำ, เป้าหมาย, ผู้รับผิดชอบหลัก, ผู้รับผิดชอบ 2]
const MAINT_ROUTINES_SEED = [
  ['', 'ตรวจสอบแผนผลิต', 'ทราบแผนประจำกะ', 'op', 'mt'],
  ['', 'จัดพนักงานเข้าไลน์ผลิต', 'พนักงานครบประจำตำแหน่ง', 'op', ''],

  ['เครื่องยิงวันที่', 'ติดตั้งเครื่องยิงวันที่', 'ครบทุกไลน์ผลิต', 'mt', ''],
  ['เครื่องยิงวันที่', 'ทดสอบเครื่องยิง', 'คมชัด ขนาดถูกต้อง', 'mt', ''],
  ['เครื่องยิงวันที่', 'ตั้งค่า Lot No', 'Lot No ถูกต้อง', 'op', 'qc'],
  ['เครื่องยิงวันที่', 'ล้างทำความสะอาดหัวยิง', 'หลังหยุดใช้งานใช้งานได้', 'mt', ''],
  ['เครื่องยิงวันที่', 'แก้ไข Alarm / ประสานงาน Supplier', 'แก้ไขใช้งานได้', 'mt', ''],

  ['เครื่องชั่ง Mettler1/2/Ishida', 'ตั้งค่า Lot No / SKU / ยอดผลิต', 'Lot No/SKU/ยอดผลิต ถูกต้อง', 'op', ''],
  ['เครื่องชั่ง Mettler1/2/Ishida', 'ตรวจสอบ Pass/NG', 'ไม่พบปัญหาน้ำหนักเกินขาด', 'mt', 'qc'],
  ['เครื่องชั่ง Mettler1/2/Ishida', 'ทำความสะอาดเครื่อง', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'mt'],
  ['เครื่องชั่ง Mettler1/2/Ishida', 'แก้ไข Alarm / ประสานงาน Supplier', 'แก้ไขใช้งานได้', 'mt', ''],

  ['เครื่องจับโละ 900g/25kg/ปี๊บ', 'ตั้งค่า SKU', 'SKU ถูกต้อง', 'mt', ''],
  ['เครื่องจับโละ 900g/25kg/ปี๊บ', 'ตรวจสอบ Pass/NG', 'ไม่พบปัญหาน้ำหนักเกินขาด', 'mt', 'qc'],
  ['เครื่องจับโละ 900g/25kg/ปี๊บ', 'ทำความสะอาดเครื่อง', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'mt'],
  ['เครื่องจับโละ 900g/25kg/ปี๊บ', 'แก้ไข Alarm / ประสานงาน Supplier', 'แก้ไขใช้งานได้', 'mt', ''],

  ['เครื่องชั่งเล็กประจำไลน์', 'ติดตั้งครบพร้อมใช้งาน', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'op'],
  ['เครื่องชั่งเล็กประจำไลน์', 'ทำความสะอาดเครื่อง', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'op'],
  ['เครื่องชั่งเล็กประจำไลน์', 'การจัดเก็บหลังเลิกใช้งาน', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'op'],
  ['เครื่องชั่งเล็กประจำไลน์', 'แก้ไข Alarm / ประสานงาน Instrument', 'แก้ไขใช้งานได้', 'mt', ''],

  ['ตั้งไลน์สำหรับผลิต', 'จัดโต๊ะ', 'พื้นที่พร้อมใช้งาน', 'pd', 'op'],
  ['ตั้งไลน์สำหรับผลิต', 'เตรียมอุปกรณ์', 'อุปกรณ์พร้อมใช้งาน', 'pd', 'op'],
  ['ตั้งไลน์สำหรับผลิต', 'ทำความสะอาดโต๊ะ อุปกรณ์', 'ความสะอาดพร้อมใช้งาน', 'pd', 'op'],
  ['ตั้งไลน์สำหรับผลิต', 'จัดเก็บ', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'op'],

  ['เครื่องปิดลัง', 'ตั้งค่าขนาดกล่องตาม SKU', 'SKU ถูกต้อง', 'mt', ''],
  ['เครื่องปิดลัง', 'ตรวจสอบความสามารถในการปิดลัง', 'เทปกาวไม่หลุด ลังไม่เสียหาย', 'mt', ''],
  ['เครื่องปิดลัง', 'ตรวจสอบระยะเทปปิดลัง', 'เทปกาวไม่หลุด ลังไม่เสียหาย', 'mt', ''],
  ['เครื่องปิดลัง', 'ทำความสะอาดเครื่อง', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'mt'],

  ['เครื่องซีลแนวตั้ง', 'วางเครื่องครบประจำตำแหน่ง', 'ครบทุกไลน์ผลิต', 'pd', 'op'],
  ['เครื่องซีลแนวตั้ง', 'ตั้งค่า Temp ตาม Control', 'รอยซีลไม่รั่ว', 'mt', ''],
  ['เครื่องซีลแนวตั้ง', 'ตรวจสอบรอยซีลก่อนใช้งาน', 'รอยซีลไม่รั่ว', 'mt', ''],
  ['เครื่องซีลแนวตั้ง', 'ทำความสะอาดหลังเลิกใช้งาน', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'mt'],
  ['เครื่องซีลแนวตั้ง', 'จัดเก็บ', 'หลังหยุดใช้งานใช้งานได้', 'pd', 'op'],

  ['เครน', 'ตรวจสอบความสมบูรณ์ สลิง & Hook', 'พร้อมใช้งาน', 'mt', ''],
  ['เครน', 'ใช้งานถูกต้องตามวิธี', 'ไม่เสียหาย', 'pd', 'op'],
];
// node_key ต้องนิ่งตลอดกาล — routine_state อ้าง (วันที่, คน, node_key) ถ้าเปลี่ยนคีย์ ประวัติติ๊กจะหลุด
const maintNodeKey = (i) => `pm${String(i + 1).padStart(2, '0')}`;

// seed ทีมซ่อมบำรุง (idempotent — เพิ่มเฉพาะแถวที่ยังไม่มี ไม่ทับของที่ user แก้เอง)
async function seedMaintBoard() {
  try {
    const p = MAINT_PERSON_SEED;
    await db.exec(
      `INSERT INTO duty_people (person_key, name, role, color, wash, initial, dot, kind, sort_order, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'maint', 100, 1, ?) ON CONFLICT (person_key) DO NOTHING`,
      [p.key, p.name, p.role, p.color, p.wash, p.initial, p.dot, nowBKK()]);
    // เช็ก node_key ของ "ทุกคนในทีมซ่อมบำรุง" ไม่ใช่แค่หัวหน้าทีม —
    // ไม่งั้นงานที่ถูกย้ายไปให้สมาชิกคนอื่นจะถูก seed ขึ้นมาใหม่ให้หัวหน้าทุกครั้งที่เซิร์ฟเวอร์รีสตาร์ต (Render รีบ่อย)
    // ไม่กรอง active — งานที่คนลบทิ้งเองต้องไม่ฟื้นกลับมา
    const maintKeys = (await dbAll("SELECT person_key FROM duty_people WHERE kind = 'maint'", [])).map(r => r.person_key);
    if (!maintKeys.includes(p.key)) maintKeys.push(p.key);
    const have = (await dbAll(
      `SELECT node_key FROM duty_routines WHERE person_key IN (${maintKeys.map(() => '?').join(',')})`,
      maintKeys)).map(r => r.node_key);
    for (let i = 0; i < MAINT_ROUTINES_SEED.length; i++) {
      const key = maintNodeKey(i);
      if (have.includes(key)) continue;                       // มีแล้ว (หรือ user ลบไปเอง) — ไม่ยัดซ้ำ
      const [machine, title, goal, owner, co] = MAINT_ROUTINES_SEED[i];
      await db.exec(
        `INSERT INTO duty_routines (person_key, parent_id, node_key, title, mono, sort_order, active, created_at,
           machine, goal, owner_role, co_owner_role)
         VALUES (?, NULL, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?)`,
        [p.key, key, title, i, nowBKK(), machine || null, goal || null, owner || null, co || null]);
    }
    const cfg = await dbAll('SELECT id FROM maint_team LIMIT 1', []);
    if (!cfg.length) await db.exec('INSERT INTO maint_team (shift_name, updated_at) VALUES (?, ?)', [MAINT_SHIFT_DEFAULT, nowBKK()]);
    // ทะเบียนเครื่องจักรตั้งต้น = ชื่อเครื่องที่โผล่ในทะเบียนงาน PM (ชื่อต้องตรงกันเป๊ะถึงจะผูกกันได้)
    let mi = 0;
    for (const name of [...new Set(MAINT_ROUTINES_SEED.map(r => r[0]).filter(Boolean))]) {
      await db.exec(
        `INSERT INTO machines (name, sort_order, active, created_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (name) DO NOTHING`, [name, mi++, nowBKK()]);
    }
    invalidateRoutineCache();
    await refreshPeopleCache();
  } catch (e) { console.error('[db] seedMaintBoard failed', e.message); }
}

/* ── AM List — เช็คลิสต์ตรวจสอบประจำวัน Pro/CIP/NPP (digitized จากเอกสารกระดาษ 3 แผ่น) ──
   งานของทีมซ่อมบำรุง (owner_role='mt') ไม่ใช่ทีมผลิต · "ถัง 1/2/3" ในเอกสารเดิม = "Line ต้ม 1/2/3"
   ⚠️ คนละอย่างกับ 'Line 1/2/3' ของ CIP (LINE_TARGETS, cip_line*_sessions) ที่เป็นไลน์บรรจุ —
   ห้ามตั้งชื่อชนกัน ไม่งั้นทะเบียนงานรูทีนจะไปรวมกลุ่มกับงานฝั่ง CIP
   node_key namespace "am01..am45" แยกจาก "pm01-34" เดิมของ MAINT_ROUTINES_SEED — ห้ามเปลี่ยนทั้งคู่
   [เครื่องจักร(ไลน์), หัวข้อการตรวจสอบ, มาตรฐานการตรวจสอบ, วิธีการตรวจสอบ]                     */
const AM_LIST_SEED = [
  // Line 1 (เดิม "ถัง 1" ในเอกสาร)
  ['Line ต้ม 1', 'จดบันทึกแรงดันในน้ำชาเข้าเมน', 'อยู่ในเกณฑ์มาตรฐานที่กำหนด (เช่น 4-6 bar)', 'ดูเกจวัดความดัน'],
  ['Line ต้ม 1', 'จดบันทึกอุณหภูมิในน้ำชาเข้า (ที่ห้องต้ม)', 'อยู่ในเกณฑ์มาตรฐานที่กำหนด', 'ดูเกจวัดอุณหภูมิ / เซ็นเซอร์'],
  ['Line ต้ม 1', 'จดบันทึกอุณหภูมิน้ำ Chiller ขาเข้า Plate', 'อุณหภูมิอยู่ในเกณฑ์ (เช่น < 5°C หรือตามที่กำหนด)', 'ดูหน้าจอแสดงผล / เทอร์โมมิเตอร์'],
  ['Line ต้ม 1', 'ตรวจสอบความผิดปกติของใบกวนถัง 1', 'ไม่มีเสียงดังผิดปกติ, แกนไม่แกว่ง, หมุนราบรื่น', 'ฟังเสียง, สังเกตการทำงาน'],
  ['Line ต้ม 1', 'ตรวจสอบความผิดปกติของน้ำเลี้ยงคอปั๊มเซนติฟิว', 'น้ำไหลเวียนสม่ำเสมอ, ท่อไม่ตัน, ไม่รั่วซึม', 'สังเกตการไหลของน้ำผ่านท่อ'],
  ['Line ต้ม 1', 'ตรวจสอบความผิดปกติของน้ำเลี้ยงคอปั๊มโฮป', 'น้ำไหลเวียนสม่ำเสมอ, ท่อไม่ตัน, ไม่รั่วซึม', 'สังเกตการไหลของน้ำผ่านท่อ'],
  ['Line ต้ม 1', 'ตรวจสอบความผิดปกติของมอเตอร์ปั๊มเซนติฟิว', 'ไม่สั่นสะเทือนรุนแรง, ไม่มีเสียงดัง, อุณหภูมิไม่ร้อนจัด', 'ฟังเสียง, สัมผัสอุณหภูมิ (หลังมือ)'],
  ['Line ต้ม 1', 'ตรวจสอบความผิดปกติของมอเตอร์ปั๊มโฮป', 'ไม่สั่นสะเทือนรุนแรง, ไม่มีเสียงดัง, อุณหภูมิไม่ร้อนจัด', 'ฟังเสียง, สัมผัสอุณหภูมิ (หลังมือ)'],
  ['Line ต้ม 1', 'ตรวจสอบจุดรั่วไหลของ Product', 'ไม่มีคราบ หรือรอยหยดของโปรดักส์ตามข้อต่อ/ซีล/วาล์ว', 'สังเกตหาคราบหรือรอยเปียกชื้น'],
  ['Line ต้ม 1', 'ตรวจสอบจุดรั่วไหลของลม', 'ไม่มีเสียงลมรั่ว, แรงดันในระบบไม่ตก', 'ฟังเสียง, ใช้น้ำสบู่ (หากต้องสงสัย)'],
  ['Line ต้ม 1', 'ตรวจสอบความผิดปกติของค่า Loadcell ถัง 200L', 'ค่าเริ่มต้นที่ 0 kg (เมื่อถังว่าง), ตัวเลขไม่แกว่งผิดปกติ', 'ดูหน้าจอแสดงผลน้ำหนัก'],
  ['Line ต้ม 1', 'ตรวจสอบความผิดปกติของค่า Loadcell ถังน้ำตาล W100', 'ค่าเริ่มต้นที่ 0 kg (เมื่อถังว่าง), ตัวเลขไม่แกว่งผิดปกติ', 'ดูหน้าจอแสดงผลน้ำหนัก'],
  ['Line ต้ม 1', 'ตรวจสอบการทำงานของเกจวาล์วส่งน้ำตาล W100', 'เปิด-ปิดสุดได้คล่องตัว, ไม่มีติดขัด, ไม่มีรอยรั่วซึม', 'ทดสอบเปิด-ปิดเกจวาล์ว'],
  ['Line ต้ม 1', 'ตรวจสอบความสะอาดของอุปกรณ์ต่างๆ', 'สะอาด, ไม่มีคราบเหนียว, ไม่มีฝุ่นหรือเศษวัสดุตกค้าง', 'ตรวจสอบด้วยตาเปล่ารอบอุปกรณ์'],
  ['Line ต้ม 1', 'ขันแน่นแคลมป์รัดท่อ', 'แคลมป์แน่นหนา, ข้อต่อท่อไม่ขยับหรือหลวมคลอน', 'ใช้มือจับโยก, ไม่ใช้ประแจขันย้ำ'],
  // Line 2 (เดิม "ถัง 2")
  ['Line ต้ม 2', 'จดบันทึกแรงดันในน้ำชาเข้าเมน', 'อยู่ในเกณฑ์มาตรฐานที่กำหนด', 'ดูเกจวัดความดัน'],
  ['Line ต้ม 2', 'จดบันทึกอุณหภูมิในน้ำชาเข้า (ที่ห้องต้ม)', 'อยู่ในเกณฑ์มาตรฐานที่กำหนด', 'ดูเกจวัดอุณหภูมิ / เซ็นเซอร์'],
  ['Line ต้ม 2', 'จดบันทึกอุณหภูมิน้ำ Chiller ขาเข้า Tube', 'อุณหภูมิอยู่ในเกณฑ์ (เช่น < 5°C หรือตามที่กำหนด)', 'ดูหน้าจอแสดงผล / เทอร์โมมิเตอร์'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของใบกวนถัง 1', 'ไม่มีเสียงดังผิดปกติ, แกนไม่แกว่ง, หมุนราบรื่น', 'ฟังเสียง, สังเกตการทำงาน'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของใบกวนถัง 3', 'ไม่มีเสียงดังผิดปกติ, แกนไม่แกว่ง, หมุนราบรื่น', 'ฟังเสียง, สังเกตการทำงาน'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของน้ำเลี้ยงคอปั๊มเซนติฟิว #1', 'น้ำไหลเวียนสม่ำเสมอ, ท่อไม่ตัน, ไม่รั่วซึม', 'สังเกตการไหลของน้ำผ่านท่อ'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของน้ำเลี้ยงคอปั๊มโฮป', 'น้ำไหลเวียนสม่ำเสมอ, ท่อไม่ตัน, ไม่รั่วซึม', 'สังเกตการไหลของน้ำผ่านท่อ'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของมอเตอร์ปั๊มเซนติฟิว #1', 'ไม่สั่นสะเทือนรุนแรง, ไม่มีเสียงดัง, อุณหภูมิไม่ร้อนจัด', 'ฟังเสียง, สัมผัสอุณหภูมิ (หลังมือ)'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของมอเตอร์ปั๊มโฮป', 'ไม่สั่นสะเทือนรุนแรง, ไม่มีเสียงดัง, อุณหภูมิไม่ร้อนจัด', 'ฟังเสียง, สัมผัสอุณหภูมิ (หลังมือ)'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของน้ำเลี้ยงคอปั๊มเซนติฟิว #2', 'น้ำไหลเวียนสม่ำเสมอ, ท่อไม่ตัน, ไม่รั่วซึม', 'สังเกตการไหลของน้ำผ่านท่อ'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของมอเตอร์ปั๊มเซนติฟิว #2', 'ไม่สั่นสะเทือนรุนแรง, ไม่มีเสียงดัง, อุณหภูมิไม่ร้อนจัด', 'ฟังเสียง, สัมผัสอุณหภูมิ (หลังมือ)'],
  ['Line ต้ม 2', 'ตรวจสอบจุดรั่วไหลของ Product', 'ไม่มีคราบ หรือรอยหยดของโปรดักส์ตามข้อต่อ/ซีล/วาล์ว', 'สังเกตหาคราบหรือรอยเปียกชื้น'],
  ['Line ต้ม 2', 'ตรวจสอบจุดรั่วไหลของลม', 'ไม่มีเสียงลมรั่ว, แรงดันในระบบไม่ตก', 'ฟังเสียง, ใช้น้ำสบู่ (หากต้องสงสัย)'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของค่า Loadcell ถัง 1 (Mixing)', 'ค่าเริ่มต้นที่ 0 kg (เมื่อถังว่าง), ตัวเลขไม่แกว่งผิดปกติ', 'ดูหน้าจอแสดงผลน้ำหนัก'],
  ['Line ต้ม 2', 'ตรวจสอบความผิดปกติของค่า Loadcell ถัง 3 (Storage)', 'ค่าเริ่มต้นที่ 0 kg (เมื่อถังว่าง), ตัวเลขไม่แกว่งผิดปกติ', 'ดูหน้าจอแสดงผลน้ำหนัก'],
  ['Line ต้ม 2', 'ตรวจสอบการเดินตัวเปล่าของไฮเชียร์', 'ไม่มีเสียงเสียดสีรุนแรง, ไม่สั่นสะเทือน, มอเตอร์ไม่ร้อนจัด', 'ฟังเสียง, สังเกตการทำงาน'],
  ['Line ต้ม 2', 'ขันแน่นแคลมป์รัดท่อ', 'แคลมป์แน่นหนา, ข้อต่อท่อไม่ขยับหรือหลวมคลอน', 'ใช้มือจับโยก, ไม่ใช้ประแจขันย้ำ'],
  // Line 3 (เดิม "ถัง 3")
  ['Line ต้ม 3', 'จดบันทึกแรงดันในน้ำชาเข้าเมน', 'อยู่ในเกณฑ์มาตรฐานที่กำหนด', 'ดูเกจวัดความดัน'],
  ['Line ต้ม 3', 'จดบันทึกอุณหภูมิในน้ำชาเข้า (ที่ห้องต้ม)', 'อยู่ในเกณฑ์มาตรฐานที่กำหนด', 'ดูเกจวัดอุณหภูมิ / เซ็นเซอร์'],
  ['Line ต้ม 3', 'จดบันทึกอุณหภูมิน้ำ Chiller ขาเข้า Tube', 'อุณหภูมิอยู่ในเกณฑ์ (เช่น < 5°C หรือตามที่กำหนด)', 'ดูหน้าจอแสดงผล / เทอร์โมมิเตอร์'],
  ['Line ต้ม 3', 'ตรวจสอบความผิดปกติของใบกวนถัง 1', 'ไม่มีเสียงดังผิดปกติ, แกนไม่แกว่ง, หมุนราบรื่น', 'ฟังเสียง, สังเกตการทำงาน'],
  ['Line ต้ม 3', 'ตรวจสอบความผิดปกติของใบกวนถัง 2', 'ไม่มีเสียงดังผิดปกติ, แกนไม่แกว่ง, หมุนราบรื่น', 'ฟังเสียง, สังเกตการทำงาน'],
  ['Line ต้ม 3', 'ตรวจสอบความผิดปกติของน้ำเลี้ยงคอปั๊มเซนติฟิว', 'น้ำไหลเวียนสม่ำเสมอ, ท่อไม่ตัน, ไม่รั่วซึม', 'สังเกตการไหลของน้ำผ่านท่อ'],
  ['Line ต้ม 3', 'ตรวจสอบความผิดปกติของน้ำเลี้ยงคอปั๊มโฮป', 'น้ำไหลเวียนสม่ำเสมอ, ท่อไม่ตัน, ไม่รั่วซึม', 'สังเกตการไหลของน้ำผ่านท่อ'],
  ['Line ต้ม 3', 'ตรวจสอบความผิดปกติของมอเตอร์ปั๊มเซนติฟิว #1', 'ไม่สั่นสะเทือนรุนแรง, ไม่มีเสียงดัง, อุณหภูมิไม่ร้อนจัด', 'ฟังเสียง, สัมผัสอุณหภูมิ (หลังมือ)'],
  ['Line ต้ม 3', 'ตรวจสอบความผิดปกติของมอเตอร์ปั๊มโฮป', 'ไม่สั่นสะเทือนรุนแรง, ไม่มีเสียงดัง, อุณหภูมิไม่ร้อนจัด', 'ฟังเสียง, สัมผัสอุณหภูมิ (หลังมือ)'],
  ['Line ต้ม 3', 'ตรวจสอบจุดรั่วไหลของ Product', 'ไม่มีคราบ หรือรอยหยดของโปรดักส์ตามข้อต่อ/ซีล/วาล์ว', 'สังเกตหาคราบหรือรอยเปียกชื้น'],
  ['Line ต้ม 3', 'ตรวจสอบจุดรั่วไหลของลม', 'ไม่มีเสียงลมรั่ว, แรงดันในระบบไม่ตก', 'ฟังเสียง, ใช้น้ำสบู่ (หากต้องสงสัย)'],
  ['Line ต้ม 3', 'ตรวจสอบความผิดปกติของค่า Loadcell ถัง 1 (Mixing)', 'ค่าเริ่มต้นที่ 0 kg (เมื่อถังว่าง), ตัวเลขไม่แกว่งผิดปกติ', 'ดูหน้าจอแสดงผลน้ำหนัก'],
  ['Line ต้ม 3', 'ขันแน่นแคลมป์รัดท่อ', 'แคลมป์แน่นหนา, ข้อต่อท่อไม่ขยับหรือหลวมคลอน', 'ใช้มือจับโยก, ไม่ใช้ประแจขันย้ำ'],
];
const amListNodeKey = (i) => `am${String(i + 1).padStart(2, '0')}`;

// seed AM List (idempotent — เพิ่มเฉพาะแถวที่ยังไม่มี ไม่ทับของที่ user แก้เอง)
// sort_order เริ่มที่ 1000 ตั้งใจให้สูงกว่า pm01-34 (0-33) เสมอ กันแทรกกลางกลุ่มเครื่องจักรเดิม
async function seedAmListRoutines() {
  try {
    /* 🔴 guard ต้องเช็คด้วย node_key เท่านั้น ห้ามกรองด้วย person_key
       เพราะ 45 แถวนี้ person_key = NULL (เป็นของไลน์+กะ ไม่ใช่ของคน) ถ้ากรองด้วย person_key
       จะหาไม่เจอแล้ว insert ซ้ำทุกครั้งที่บูต — Render รีสตาร์ตบ่อย จะได้ 45 → 90 → 135 แถว */
    const have = (await dbAll("SELECT node_key FROM duty_routines WHERE node_key LIKE 'am%'", []))
      .map(r => r.node_key);
    for (let i = 0; i < AM_LIST_SEED.length; i++) {
      const key = amListNodeKey(i);
      if (have.includes(key)) continue;                       // มีแล้ว (หรือ user ลบไปเอง) — ไม่ยัดซ้ำ
      const [machine, title, goal, method] = AM_LIST_SEED[i];
      await db.exec(
        `INSERT INTO duty_routines (person_key, parent_id, node_key, title, mono, sort_order, active, created_at,
           machine, goal, method, owner_role, co_owner_role, sheet)
         VALUES (NULL, NULL, ?, ?, 0, ?, 1, ?, ?, ?, ?, 'mt', NULL, 'am')`,
        [key, title, 1000 + i, nowBKK(), machine, goal, method]);
    }
    // ทะเบียนเครื่องจักร: ลงชื่อ Line 1/2/3 ไว้ด้วยถ้ายังไม่มี (sort_order สูงกว่าเครื่องเดิมของ seedMaintBoard)
    let mi = 500;
    for (const name of [...new Set(AM_LIST_SEED.map(r => r[0]))]) {
      await db.exec(
        `INSERT INTO machines (name, sort_order, active, created_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (name) DO NOTHING`, [name, mi++, nowBKK()]);
    }
    invalidateRoutineCache();
  } catch (e) { console.error('[db] seedAmListRoutines failed', e.message); }
}
// ══ Knowledge management ═════════════════════════════════════════════════════
// ทะเบียนเครื่องจักร (ERP Phase 1) — ชื่อเครื่องใช้เป็น [[wikilink]] ปลายทางของโน้ตใน vault
/* 🔴 เส้นนี้มีคนเรียก 4 ที่ (MachineRegistry · PmRegistry · IncidentBoard · MaintenanceBoard)
      เพิ่มฟิลด์ใหม่ได้ แต่ "คีย์เดิม 10 ตัว" ห้ามเปลี่ยนชื่อ/ความหมาย/หายไปเด็ดขาด
      id · code · name · line · installedAt · lastPm · note · vaultPath · pmCount · openIncidents  */
app.get('/api/machines', async (req, res) => {
  try {
    const grpFilter = String(req.query.grp || '').trim();
    const rows = await dbAll('SELECT * FROM machines WHERE active = 1 ORDER BY sort_order, id', []);
    // นับงาน PM ที่ผูกกับเครื่องนี้ + เหตุการณ์ที่ยังไม่ปิด — ให้หน้าทะเบียนเห็นภาพโดยไม่ต้องยิงซ้ำ
    // 🔴 ห้ามตั้งชื่อตัวแปรนี้ว่า pm — จะไปบังโมดูล pm (pmSync) ที่ใช้หา ISO week ข้างล่าง
    const pmCounts = await dbAll("SELECT machine, COUNT(*) AS n FROM duty_routines WHERE active = 1 AND machine IS NOT NULL AND machine <> '' GROUP BY machine", []);
    // นับใบที่ยังไม่ปิดทั้งหมด รวม 'wip' (ช่างรับไปแล้วแต่ยังซ่อมไม่เสร็จ = ยังค้างอยู่จริง)
    // สำนวนเดียวกับ maintCounts และ buildRepairList ในบอท ที่นับถูกอยู่แล้ว
    const inc = await dbAll("SELECT machine, COUNT(*) AS n FROM incidents WHERE COALESCE(status, 'open') <> 'closed' AND machine IS NOT NULL AND machine <> '' GROUP BY machine", []);
    const nOf = (list, name) => Number((list.find(x => x.machine === name) || {}).n || 0);

    // ── ของใหม่: คู่ไลน์ / กฎเตือน / สัปดาห์ PM รอบหน้า ────────────────────
    // นับคู่ทั้ง 2 ฝั่งแล้วบวกกัน — เครื่องหนึ่งเป็นได้ทั้งไลน์หรือเครื่องบรรจุ อีกฝั่งจะเป็น 0 เอง
    const [linkL, linkP, ruleL, ruleP] = await Promise.all([
      dbAll('SELECT line_name AS k, COUNT(*) AS n FROM machine_links WHERE active = 1 GROUP BY line_name', []),
      dbAll('SELECT packer_name AS k, COUNT(*) AS n FROM machine_links WHERE active = 1 GROUP BY packer_name', []),
      dbAll("SELECT line_name AS k, COUNT(*) AS n FROM machine_rules WHERE active = 1 AND deleted = 0 AND line_name <> '' GROUP BY line_name", []),
      dbAll("SELECT packer_name AS k, COUNT(*) AS n FROM machine_rules WHERE active = 1 AND deleted = 0 AND packer_name <> '' GROUP BY packer_name", []),
    ]);
    const kOf = (list, name) => Number((list.find(x => x.k === name) || {}).n || 0);

    /* สัปดาห์ PM รอบหน้า — อ่าน pm_items ตรง ๆ ไม่เรียก pmLoad()
       เพราะเส้นนี้โดนเรียกจาก 4 หน้า การลาก done/skip/jobs มาด้วยทำให้ทุกหน้าช้าโดยไม่ได้ใช้
       (หน้ารายละเอียดที่ต้องการของครบใช้ /api/machines/detail ซึ่งเรียก pmLoad เต็ม)   */
    const curWeek = pm.isoWeekOf(todayBKK()).week;
    const pmItems = await dbAll('SELECT net_id, weeks, freq FROM pm_items WHERE deleted = 0', []).catch(() => []);
    const pmNext = new Map();
    for (const it of pmItems) {
      let weeks = [];
      try { weeks = JSON.parse(it.weeks || '[]').map(Number).filter((n) => n >= 1 && n <= 53).sort((a, b) => a - b); } catch { weeks = []; }
      // รอบหน้า = สัปดาห์ตามแผนที่ยัง >= สัปดาห์นี้ · หมดปีแล้วก็วนกลับไปรอบแรกของปีหน้า
      const nx = weeks.find((w) => w >= curWeek);
      pmNext.set(it.net_id, { week: nx || weeks[0] || null, freq: it.freq || '', rollover: !nx && !!weeks.length });
    }

    const out = rows
      .filter((r) => !grpFilter || (r.grp || 'tool') === grpFilter)
      .map((r) => {
        const nx = pmNext.get(r.pm_net_id) || {};
        return {
          // ── คีย์เดิม (ห้ามแตะ) ──
          id: r.id, code: r.code || '', name: r.name, line: r.line_name || '',
          installedAt: r.installed_at || '', lastPm: r.last_pm || '', note: r.note || '',
          vaultPath: r.vault_path || '',
          pmCount: nOf(pmCounts, r.name), openIncidents: nOf(inc, r.name),
          // ── ของใหม่ (Machine Hub) ──
          grp: r.grp || 'tool',
          mkey: r.mkey || '',
          label: r.label || r.name,            // ชื่อที่โชว์ — ว่างเมื่อไหร่ถอยไปใช้ชื่อจริง
          spec: r.spec || '',
          pmNetId: r.pm_net_id || '',
          linkCount: kOf(linkL, r.name) + kOf(linkP, r.name),
          ruleCount: kOf(ruleL, r.name) + kOf(ruleP, r.name),
          pmNextWeek: nx.week || null,
          pmFreq: nx.freq || '',
          pmRollover: !!nx.rollover,           // true = รอบหน้าข้ามไปปีถัดไปแล้ว
        };
      });
    res.json({ machines: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
/* ══ เปลี่ยนชื่อเครื่อง = ต้องตามไปแก้ทุกที่ที่อ้างชื่อเดิม ═══════════════════════
   `machines.name` เป็น join key แบบ "ข้อความ" ไม่ใช่ id — ตารางที่อ้างชื่อไว้จะกำพร้าเงียบ ๆ
   ถ้าไม่ตามไปแก้ · **รายการนี้คือที่เดียวที่ต้องดูแล** เพิ่มตารางใหม่ที่เก็บชื่อเครื่องต้องมาเติมตรงนี้ด้วย

   🔴 ห้ามใส่คอลัมน์ "line" ของฝั่งผลิต/CIP ลงในรายการนี้เด็ดขาด — คำว่า line มี 4 ความหมายในระบบ
      (`Line 1/2/3` ของ CIP · `Line ต้ม N` · `ไลน์ L1` เครื่องบรรจุ · `Linear#1` ที่พนักงานพิมพ์)
      `production_logs.line_name` · `line_state` · `cip_specs.line` · `daily_tasks.line_name`
      เป็นคนละ namespace กับทะเบียนเครื่องจักร ตามไปแก้ = พังของที่ไม่เกี่ยวกัน
   🔴 `shift_plans.machine_code` · `production_reports.machine` · `sku_master.machine` ก็ไม่ใช่ —
      เก็บ "รหัสเครื่องในแผน" (`[L2]` / `Linear#3`) ที่จับคู่ผ่าน `normMachine()` ไม่ใช่ชื่อในทะเบียน  */
const MACHINE_NAME_REFS = [
  ['duty_routines', 'machine'],       // ทะเบียนงานรูทีน + 45 ข้อของใบเช็ก AM (sheet='am')
  ['incidents', 'machine'], ['incidents', 'line_name'],
  ['daily_tasks', 'machine'],         // งานที่มอบหมายระหว่างวัน (ช่อง "พื้นที่/เครื่องจักร")
  ['am_sheets', 'line'], ['am_sheet_links', 'line'],
  ['posts', 'machine'],               // บทความ KM → ปลายทาง [[wikilink]] ในวอลต์
  ['tg_incident_draft', 'machine'],   // ร่างแจ้งซ่อมที่ยังค้างอยู่ในบอท
  ['machine_alias', 'machine_name'],  // นามแฝงต้องชี้ชื่อใหม่ ไม่งั้นบอทหาเครื่องไม่เจอทั้งชุด
  ['machine_links', 'line_name'], ['machine_links', 'packer_name'],
  ['machine_rules', 'line_name'], ['machine_rules', 'packer_name'],
  ['machine_runs', 'line_name'], ['machine_runs', 'packer_name'],
  ['run_checks', 'machine_name'], ['run_check_links', 'machine_name'],
];

async function cascadeMachineRename(oldName, newName) {
  const changed = {};
  for (const [tbl, col] of MACHINE_NAME_REFS) {
    try {
      const r = await dbRun(`UPDATE ${tbl} SET ${col} = ? WHERE ${col} = ?`, [newName, oldName]);
      const n = Number(r && r.changes) || 0;
      if (n) changed[`${tbl}.${col}`] = n;
    } catch (e) { console.error('[machines] cascade', tbl, col, e.message); }
  }
  /* ref_key ของใบแจ้งซ่อมมี "ชื่อเครื่อง" ฝังอยู่ข้างใน ('am:<ไลน์>:<ข้อ>' · 'run:<เครื่อง>:<ข้อ>')
     ไม่ตามไปแก้ = ใบที่ยังเปิดค้างอยู่กลายเป็นคนละ key กับที่ระบบจะสร้างครั้งหน้า
     → เจออาการเดิมแล้วเปิดใบใหม่ซ้อนใบเก่า **ตัวกันซ้ำตายเงียบ ๆ**
     ประกอบ key ใหม่ใน JS ไม่ใช่ใน SQL — โปรเจกต์นี้ไม่มีชั้นแปลง dialect (prod=PG · local=SQLite) */
  for (const prefix of ['am', 'run']) {
    const head = `${prefix}:${oldName}:`;
    const rows = await dbAll('SELECT id, ref_key FROM incidents WHERE ref_key LIKE ?', [`${head}%`]);
    for (const r of rows) {
      await db.exec('UPDATE incidents SET ref_key = ? WHERE id = ?',
        [`${prefix}:${newName}:${String(r.ref_key).slice(head.length)}`, r.id]);
    }
    if (rows.length) changed[`incidents.ref_key(${prefix}:)`] = rows.length;
  }
  // ชื่อเก่าต้องยังหาเจอ — คนที่พิมพ์ชื่อเดิมใส่บอท/ใบเช็กจะได้ไม่หลุด
  const dup = await dbGet('SELECT alias FROM machine_alias WHERE alias = ?', [oldName]);
  if (!dup) {
    await db.exec('INSERT INTO machine_alias (alias, machine_name, created_at) VALUES (?, ?, ?)',
      [oldName, newName, nowBKK()]);
  }
  return changed;
}

app.post('/api/machines', requireRole('supervisor'), async (req, res) => {
  const { id, code, name, line, installedAt, lastPm, note, grp, mkey, label, spec, pmNetId } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name จำเป็น' });
  const nm = String(name).trim();
  // ช่องที่ไม่ได้ส่งมา = ไม่แก้ (ฟอร์มเก่าส่งมาแค่ 7 ช่อง ห้ามให้มันล้าง grp/mkey/label ทิ้ง)
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
  try {
    let rowId = id;
    let renamed = null;
    if (id) {
      const before = await dbGet('SELECT name FROM machines WHERE id = ?', [id]);
      await db.exec('UPDATE machines SET code = ?, name = ?, line_name = ?, installed_at = ?, last_pm = ?, note = ? WHERE id = ?',
        [code || null, nm, line || null, installedAt || null, lastPm || null, note || null, id]);
      if (before && before.name && before.name !== nm) renamed = before.name;
    } else {
      const max = (await dbAll('SELECT MAX(sort_order) AS m FROM machines', []))[0];
      const order = (max && max.m != null ? Number(max.m) : -1) + 1;
      const r = await dbRun(
        `INSERT INTO machines (code, name, line_name, installed_at, last_pm, note, sort_order, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [code || null, nm, line || null, installedAt || null, lastPm || null, note || null, order, nowBKK()]);
      rowId = r.lastID;
    }
    // ฟิลด์ Machine Hub — เขียนเฉพาะช่องที่ client ส่งมาจริง
    for (const [k, col] of [['grp', 'grp'], ['mkey', 'mkey'], ['label', 'label'], ['spec', 'spec'], ['pmNetId', 'pm_net_id']]) {
      if (!has(k)) continue;
      const v = String(req.body[k] ?? '').trim();
      // mkey ต้องเป็น NULL ไม่ใช่ '' — มี unique index อยู่ ('' หลายตัวชนกัน แต่ NULL ไม่ชน)
      await db.exec(`UPDATE machines SET ${col} = ? WHERE id = ?`, [v || null, rowId]);
    }
    // เปลี่ยนชื่อ = ตามไปแก้ทุกตารางที่อ้างชื่อเดิม + เก็บชื่อเก่าเป็นนามแฝง (ดูรายการด้านบน)
    let cascaded = null;
    if (renamed) {
      cascaded = await cascadeMachineRename(renamed, nm);
      console.log(`[machines] เปลี่ยนชื่อ "${renamed}" → "${nm}"`, cascaded);
    }
    // เขียนโน้ตให้ทันที — คนกดบันทึกแล้วต้องเห็นไฟล์ในวอลต์เลย ไม่ต้องกดซิงก์อีกที
    const cur = (await dbAll('SELECT * FROM machines WHERE id = ?', [rowId]))[0];
    const sync = cur ? await syncMachineNote(cur) : {};
    res.json({ success: true, id: rowId, renamedFrom: renamed, cascaded,
      vaultPath: sync.path || null, vaultError: sync.error || null, vaultSkipped: sync.skipped || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ซิงก์โน้ตทุกเครื่องในทะเบียนเข้า vault รอบเดียว (ใช้ตอนเริ่มใช้งาน / หลังแก้ทะเบียนงาน PM)
app.post('/api/machines/sync-notes', requireRole('supervisor'), async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM machines WHERE active = 1 ORDER BY sort_order, id', []);
    const results = [];
    for (const m of rows) results.push({ name: m.name, ...(await syncMachineNote(m)) });
    res.json({
      total: rows.length,
      written: results.filter(r => r.path).length,
      failed: results.filter(r => r.error).map(r => ({ name: r.name, error: r.error })),
      skipped: results.find(r => r.skipped)?.skipped || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/machines/delete', requireRole('supervisor'), async (req, res) => {
  if (!req.body.id) return res.status(400).json({ error: 'id จำเป็น' });
  try { await db.exec('UPDATE machines SET active = 0 WHERE id = ?', [req.body.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══ Machine Hub — หน้ารายละเอียดเครื่อง + คู่ไลน์↔เครื่องบรรจุ ═══════════════
   ใช้ query-string (?id=) ไม่ใช่ /:id — กันชนกับ segment 'delete' / 'sync-notes'
   ที่จดทะเบียนไว้ก่อนหน้าใต้ /api/machines/…                                     */
app.get('/api/machines/detail', async (req, res) => {
  const id = Number(req.query.id || 0);
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const m = await dbGet('SELECT * FROM machines WHERE id = ?', [id]);
    if (!m) return res.status(404).json({ error: 'ไม่พบเครื่องจักรนี้ในทะเบียน' });

    /* แผน PM — กระจกอ่านอย่างเดียวจากแอปทีมช่าง · จับด้วย pm_net_id ก่อน
       ถอยไปจับด้วยชื่อเฉพาะเครื่องเก่าที่ยังไม่มี net_id (seed ใส่ให้แล้ว 30 ตัว)
       ห้ามให้ทั้งเส้นพังเพราะ PM อ่านไม่ได้ — เครื่องที่ไม่มีแผน PM ก็ต้องเปิดหน้าได้ */
    let pmBlock = null;
    try {
      const year = pm.isoWeekOf(todayBKK()).year;
      const loaded = await pmLoad(year);
      const it = loaded.items.find((x) => (m.pm_net_id && x.netId === m.pm_net_id) || x.machine === m.name);
      if (it) pmBlock = { ...it, year, cur: loaded.cur };
    } catch (e) { pmBlock = null; }

    const [routines, incRows, rules, runs] = await Promise.all([
      dbAll(`SELECT id, node_key, title, goal, method, owner_role, co_owner_role, sheet, freq, person_key
               FROM duty_routines WHERE active = 1 AND machine = ? ORDER BY sort_order, id`, [m.name]),
      dbAll(`SELECT id, title, occurred_at, created_at, status, priority, assignee, source,
                    down_from, down_to, vault_path, cause, fix
               FROM incidents WHERE machine = ?
              ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC LIMIT 20`, [m.name]),
      dbAll(`SELECT * FROM machine_rules WHERE active = 1 AND deleted = 0 AND (packer_name = ? OR line_name = ?)
              ORDER BY specificity DESC, id`, [m.name, m.name]),
      dbAll(`SELECT id, work_day, shift, packer_name, line_name, flavor, target_boxes, status, source, line_source
               FROM machine_runs WHERE packer_name = ? OR line_name = ?
              ORDER BY work_day DESC, id DESC LIMIT 10`, [m.name, m.name]),
    ]);

    const incidents = incRows.map((r) => ({
      id: r.id, title: r.title, occurredAt: r.occurred_at || r.created_at || '',
      status: r.status || 'open', priority: r.priority || '', assignee: r.assignee || '',
      source: r.source || '', cause: r.cause || '', fix: r.fix || '',
      downFrom: r.down_from || '', downTo: r.down_to || '',
      minutes: downMinutes(r.down_from, r.down_to), vaultPath: r.vault_path || '',
    }));

    res.json({
      machine: {
        id: m.id, name: m.name, label: m.label || m.name, code: m.code || '',
        grp: m.grp || 'tool', mkey: m.mkey || '', spec: m.spec || '',
        line: m.line_name || '', installedAt: m.installed_at || '', lastPm: m.last_pm || '',
        note: m.note || '', downtimeCost: m.downtime_cost == null ? null : Number(m.downtime_cost),
        pmNetId: m.pm_net_id || '', vaultPath: m.vault_path || '',
      },
      pm: pmBlock,
      routines: routines.map((r) => ({
        id: r.id, nodeKey: r.node_key || '', title: r.title || '', goal: r.goal || '',
        method: r.method || '', ownerRole: r.owner_role || '', coOwnerRole: r.co_owner_role || '',
        sheet: r.sheet || '', freq: r.freq || '', shared: !r.person_key,
      })),
      incidents,
      downtime: {
        count: incidents.length,
        minutes: incidents.reduce((n, r) => n + (r.minutes || 0), 0),
        openCount: incidents.filter((r) => r.downFrom && !r.downTo).length,
      },
      links: await linksOf(m),
      rules: rules.map(shapeRule),
      runs: runs.map((r) => ({
        id: r.id, workDay: r.work_day, shift: r.shift || '', packer: r.packer_name || '',
        line: r.line_name || '', flavor: r.flavor || '', targetBoxes: r.target_boxes,
        status: r.status || 'draft', source: r.source || '', lineSource: r.line_source || '',
      })),
      netlifyUrl: pm.NETLIFY_URL,
      aliases: (await dbAll('SELECT alias FROM machine_alias WHERE machine_name = ? ORDER BY alias', [m.name])).map((a) => a.alias),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// กฎ 1 แถว → รูปที่หน้าเว็บใช้ (items เก็บเป็น JSON string เพราะต้องใช้ได้ทั้ง SQLite และ PG)
function shapeRule(r) {
  let items = [];
  try { items = JSON.parse(r.items || '[]'); } catch { items = []; }
  return {
    id: r.id, code: r.code || '', title: r.title || '', timing: r.timing || 'start',
    lineName: r.line_name || '', packerName: r.packer_name || '', packerKey: r.packer_key || '',
    productPattern: r.product_pattern || '', shift: r.shift || '',
    ownerRole: r.owner_role || '', note: r.note || '',
    specificity: Number(r.specificity) || 0, notify: r.notify == null ? 1 : Number(r.notify),
    active: r.active == null ? 1 : Number(r.active),
    items: Array.isArray(items) ? items : [],
  };
}

/* คู่ของเครื่องหนึ่งตัว — ไลน์ผลิตดูฝั่ง packer / เครื่องบรรจุดูฝั่ง line
   คืนทั้ง 2 ฝั่งเสมอ ให้หน้าเว็บไม่ต้องรู้ว่าตัวเองเป็นหมวดไหน */
async function linksOf(m) {
  const rows = await dbAll(
    'SELECT * FROM machine_links WHERE active = 1 AND (line_name = ? OR packer_name = ?) ORDER BY sort_order, id',
    [m.name, m.name]);
  return decorateLinks(rows);
}

// เติมชื่อที่โชว์ + สินค้าประจำคู่ให้ลิสต์คู่ (ยิงคำถามสินค้าครั้งเดียวสำหรับทุกคู่)
async function decorateLinks(rows) {
  if (!rows.length) return [];
  const names = await dbAll('SELECT name, label, grp FROM machines WHERE active = 1', []);
  const labelOf = new Map(names.map((x) => [x.name, x.label || x.name]));
  const prods = await dbAll(
    `SELECT * FROM machine_link_products WHERE active = 1 AND link_id IN (${rows.map(() => '?').join(',')})
      ORDER BY sort_order, id`, rows.map((r) => r.id));
  const byLink = new Map();
  for (const p of prods) {
    if (!byLink.has(p.link_id)) byLink.set(p.link_id, []);
    byLink.get(p.link_id).push({ id: p.id, flavor: p.flavor || '', skuCode: p.sku_code || '', note: p.note || '' });
  }
  return rows.map((r) => ({
    id: r.id,
    lineName: r.line_name, lineLabel: labelOf.get(r.line_name) || r.line_name,
    packerName: r.packer_name, packerLabel: labelOf.get(r.packer_name) || r.packer_name,
    note: r.note || '',
    products: byLink.get(r.id) || [],
  }));
}

// รายการคู่ทั้งหมด (หน้าผังเชื่อมโยง)
app.get('/api/machine-links', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM machine_links WHERE active = 1 ORDER BY sort_order, id', []);
    const machines = await dbAll(
      "SELECT id, name, label, grp, mkey FROM machines WHERE active = 1 AND grp IN ('line','packer') ORDER BY sort_order, id", []);
    res.json({
      links: await decorateLinks(rows),
      lines: machines.filter((x) => x.grp === 'line').map((x) => ({ name: x.name, label: x.label || x.name, mkey: x.mkey || '' })),
      packers: machines.filter((x) => x.grp === 'packer').map((x) => ({ name: x.name, label: x.label || x.name, mkey: x.mkey || '' })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* สร้าง/แก้คู่ + สินค้าประจำคู่ ในคำขอเดียว
   products ที่หายไปจาก array = ปิด active ไม่ลบแถวทิ้ง (กันประวัติหาย + id ไม่วน)   */
app.post('/api/machine-links', requireRole('supervisor'), async (req, res) => {
  const { id, lineName, packerName, note } = req.body;
  const products = Array.isArray(req.body.products) ? req.body.products : [];
  if (!lineName || !packerName) return res.status(400).json({ error: 'ต้องเลือกทั้งไลน์ผลิตและเครื่องบรรจุ' });
  try {
    const ln = await dbGet('SELECT name, grp FROM machines WHERE name = ? AND active = 1', [lineName]);
    const pk = await dbGet('SELECT name, grp FROM machines WHERE name = ? AND active = 1', [packerName]);
    if (!ln) return res.status(400).json({ error: `ไม่พบ "${lineName}" ในทะเบียนเครื่องจักร` });
    if (!pk) return res.status(400).json({ error: `ไม่พบ "${packerName}" ในทะเบียนเครื่องจักร` });

    // กันคู่ซ้ำเองก่อนถึง UNIQUE เพื่อให้ข้อความผิดพลาดอ่านรู้เรื่อง
    const dup = await dbGet('SELECT id FROM machine_links WHERE line_name = ? AND packer_name = ?', [lineName, packerName]);
    let linkId = id ? Number(id) : (dup ? dup.id : 0);
    if (dup && id && Number(id) !== dup.id) {
      return res.status(409).json({ error: 'คู่นี้ผูกไว้แล้ว — ไปแก้ที่แถวเดิมแทน' });
    }
    const hasNote = Object.prototype.hasOwnProperty.call(req.body, 'note');
    // ชื่อคู่เดิมก่อนแก้ — ย้ายคู่ไปเครื่องอื่นแล้วโน้ตของเครื่องที่ถูกถอดออกต้องอัปเดตด้วย
    const prev = linkId ? await dbGet('SELECT line_name, packer_name FROM machine_links WHERE id = ?', [linkId]) : null;
    if (linkId) {
      // ช่องที่ไม่ได้ส่งมา = ไม่แก้ — ปุ่ม "ผูกคู่เร็ว" ที่ส่งแค่ line+packer ต้องไม่ล้างหมายเหตุเดิมทิ้ง
      await db.exec(
        `UPDATE machine_links SET line_name = ?, packer_name = ?${hasNote ? ', note = ?' : ''}, active = 1 WHERE id = ?`,
        hasNote ? [lineName, packerName, note || null, linkId] : [lineName, packerName, linkId]);
    } else {
      const r = await dbRun(
        'INSERT INTO machine_links (line_name, packer_name, note, sort_order, active, created_at) VALUES (?, ?, ?, 0, 1, ?)',
        [lineName, packerName, note || null, nowBKK()]);
      linkId = r.lastID;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'products')) {
      const keep = [];
      for (let i = 0; i < products.length; i += 1) {
        const raw = products[i] || {};
        const flavor = String(raw.flavor || '').trim();
        if (!flavor) continue;
        const fnorm = normAlias(flavor);          // '' ไม่ได้ — เป็นคีย์ UNIQUE ร่วมกับ link_id
        if (!fnorm) continue;
        keep.push(fnorm);
        const ex = await dbGet('SELECT id FROM machine_link_products WHERE link_id = ? AND flavor_norm = ?', [linkId, fnorm]);
        if (ex) {
          await db.exec('UPDATE machine_link_products SET flavor = ?, sku_code = ?, note = ?, sort_order = ?, active = 1 WHERE id = ?',
            [flavor, raw.skuCode || null, raw.note || null, i, ex.id]);
        } else {
          await db.exec(
            `INSERT INTO machine_link_products (link_id, flavor, flavor_norm, sku_code, note, sort_order, active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
            [linkId, flavor, fnorm, raw.skuCode || null, raw.note || null, i, nowBKK()]);
        }
      }
      if (keep.length) {
        await db.exec(
          `UPDATE machine_link_products SET active = 0
            WHERE link_id = ? AND flavor_norm NOT IN (${keep.map(() => '?').join(',')})`, [linkId, ...keep]);
      } else {
        await db.exec('UPDATE machine_link_products SET active = 0 WHERE link_id = ?', [linkId]);
      }
    }

    const row = await dbGet('SELECT * FROM machine_links WHERE id = ?', [linkId]);
    touchMachineNotes(lineName, packerName, prev && prev.line_name, prev && prev.packer_name);
    res.json({ success: true, link: (await decorateLinks([row]))[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/machine-links/delete', requireRole('supervisor'), async (req, res) => {
  const id = Number(req.body.id || 0);
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const row = await dbGet('SELECT line_name, packer_name FROM machine_links WHERE id = ?', [id]);
    await db.exec('UPDATE machine_links SET active = 0 WHERE id = ?', [id]);
    await db.exec('UPDATE machine_link_products SET active = 0 WHERE link_id = ?', [id]);
    touchMachineNotes(row && row.line_name, row && row.packer_name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══ เสนอ "สินค้าที่เคยวิ่งบนเครื่องบรรจุตัวนี้จริง" จากใบลงยอดผลิตย้อนหลัง ═════
   ⚠️ ข้อจำกัดที่ต้องรู้: ใบลงยอดผลิต (production_reports) มี "เครื่อง + สินค้า"
      แต่ **ไม่มีไลน์ต้ม** — ไม่มีตารางไหนในระบบบันทึกว่าไลน์ไหนป้อนเข้าเครื่องไหน
      เส้นนี้จึงเสนอได้แค่ (เครื่องบรรจุ × สินค้า) · คนเป็นคนเลือกว่าไลน์ไหน
   🔴 อ่านอย่างเดียว ไม่เขียน DB — กติกาเดียวกับ sku_alias ที่ห้ามให้ระบบเดาแล้วบันทึกเอง */
app.get('/api/machine-links/suggest', async (req, res) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
  try {
    const since = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const rows = await dbAll(
      `SELECT machine, sku_code, sku_keyword, product_name, COUNT(*) AS n, MAX(work_day) AS last_day
         FROM production_reports
        WHERE work_day >= ? AND machine IS NOT NULL AND machine <> ''
        GROUP BY machine, sku_code, sku_keyword, product_name`, [since]);

    const packers = await dbAll("SELECT name, label, mkey FROM machines WHERE active = 1 AND grp = 'packer'", []);
    const byKey = new Map(packers.filter((p) => p.mkey).map((p) => [p.mkey, p]));

    // สินค้าที่ผูกไว้กับคู่ของเครื่องนั้นแล้ว — ไม่ต้องเสนอซ้ำ
    const linked = await dbAll(
      `SELECT l.packer_name AS packer, p.flavor_norm AS fnorm
         FROM machine_link_products p JOIN machine_links l ON l.id = p.link_id
        WHERE p.active = 1 AND l.active = 1`, []);
    const already = new Set(linked.map((x) => `${x.packer}|${x.fnorm}`));

    const out = new Map();
    let unmatched = 0;
    for (const r of rows) {
      const p = byKey.get(normMachine(r.machine));       // "Linear#2 (Lina Pack)" → l2 → ไลน์ L2
      if (!p) { unmatched += 1; continue; }
      const flavor = (r.product_name || r.sku_keyword || '').trim();
      if (!flavor) continue;
      const fnorm = normAlias(flavor);
      if (!fnorm || already.has(`${p.name}|${fnorm}`)) continue;
      const key = `${p.name}|${fnorm}`;
      const cur = out.get(key);
      if (cur) { cur.count += Number(r.n) || 0; if (r.last_day > cur.lastDay) cur.lastDay = r.last_day; continue; }
      out.set(key, {
        packerName: p.name, packerLabel: p.label || p.name,
        flavor, skuCode: r.sku_code || '', count: Number(r.n) || 0, lastDay: r.last_day || '',
      });
    }
    res.json({
      days, since,
      suggestions: [...out.values()].sort((a, b) => b.count - a.count).slice(0, 40),
      unmatchedRows: unmatched,
      // บอกหน้าเว็บตรง ๆ ว่าเดาไลน์ให้ไม่ได้ จะได้ไม่ไปโชว์ช่องไลน์ลอย ๆ
      note: 'ใบลงยอดผลิตไม่มีข้อมูลไลน์ต้ม — เสนอได้เฉพาะ "เครื่องบรรจุ × สินค้า" เท่านั้น',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══ รอบเดินเครื่องรายวัน (machine_runs) ══════════════════════════════════════
   1 แถว = "วันทำงานนี้ กะนี้ เครื่องบรรจุตัวนี้ ผลิตสินค้าตัวนี้ ป้อนจากไลน์ไหน"
   ตั้งต้นจากแผนบรรจุ (shift_plans → resolveDayPlan) แล้วคนแก้ทับได้

   🔴 manual ชนะ plan เสมอ — ดึงแผนใหม่ห้ามทับ line_name / status / confirmed_by
      และห้ามแตะแถวที่ source='manual' เลยแม้แต่ช่องเดียว (กันของที่คนแก้หายตอนแผนเปลี่ยน)
   🔴 อ่านอย่างเดียวห้ามสร้างแถว — เปิดดูย้อนหลังแล้วเกิดรอบเปล่าเป็นร้อย คือบทเรียนจากใบเช็ก AM
      (สัญญาณ "วันนี้ยังไม่มีใครกรอก" ตายทันทีที่ระบบสร้างใบให้เอง)
   ════════════════════════════════════════════════════════════════════════════ */

/* "[L3+L4]" → ['l3','l4'] · "Linear#2 (Lina Pack)" → ['l2'] · ไม่รู้จัก → []
   ต่างจาก extractMachine() ที่คืนเครื่องเดียว — แผนบรรจุ 1 บรรทัดลงได้หลายเครื่องพร้อมกัน
   ตัวคั่นครบทุกแบบที่เจอในแผนจริง: "L3+L4" · "L1,L2" · "L1/L2" · "L1 และ L2"                */
const splitMachineCodes = (text) => {
  const t = String(text || '');
  const bracket = t.match(/\[([^\]]+)\]/);
  const src = bracket ? bracket[1] : t;
  const out = [];
  for (const part of src.split(/[+,/&]|และ/)) {
    const k = normMachine(part);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
};

// ชื่อสินค้าที่คนอ่าน — แผนเก็บ "Amazon 850×12 [L2]" ไว้ทั้งก้อน รหัสเครื่องอยู่ในวงเล็บเหลี่ยม
const planFlavorText = (s) => String(s || '').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim();


// ตัวเลือกกะของวันนั้น = ตารางกะจริง (จ–พฤ 3 กะ · ศ/อา 2 กะ · เสาร์ OT) + กะที่แผนลงไว้จริง
// ⚠️ ตารางกะใช้ 'เช้า/บ่าย/ดึก' แต่ shift_plans ใช้ 'กะเช้า/กะบ่าย/กะดึก' — เติม "กะ" ให้ตรงชุดเดียว
const runShiftOptions = (workDay, extra = []) => {
  const out = amShift.allowedShifts(workDay).map((s) => (s === 'OT' ? 'OT' : `กะ${s}`));
  for (const s of extra) if (s && !out.includes(s)) out.push(s);
  return out;
};

/* ดึงแผนบรรจุของวันนั้นมาตั้งเป็นรอบเดินเครื่อง (idempotent — เรียกกี่ครั้งก็ได้)
   อ่านทั้งวันเสมอไม่แยกกะ เพราะแต่ละแถวเก็บลง "กะของตัวเอง" อยู่แล้ว
   (ถ้าส่งกะเข้าไป resolveDayPlan จะถอยไปคืนทั้งวันเมื่อกะนั้นไม่มีแผน แล้วรอบจะไปโผล่ผิดกะ) */
async function ensureRunsFromPlan(workDay) {
  const day = await resolveDayPlan(workDay, null);
  const packers = await dbAll("SELECT name, label, mkey FROM machines WHERE active = 1 AND grp = 'packer'", []);
  const byKey = new Map(packers.filter((p) => p.mkey).map((p) => [String(p.mkey).toLowerCase(), p]));
  const now = nowBKK();
  let rows = 0, noMachine = 0;
  const unknownKey = [], conflicts = [], keys = new Set();

  for (const p of day) {
    const shift = normalizeShift(p.plan.shift || '');
    const flavor = planFlavorText(p.plan.flavor);
    const fnorm = normAlias(flavor);
    if (!shift || !fnorm) continue;          // ไม่มีกะ/ไม่มีชื่อสินค้า = คีย์ UNIQUE ไม่ครบ ข้ามไป
    // รหัสเครื่องอยู่คนละที่ใน 2 ยุคของแผน: คอลัมน์ machine_code (ใหม่) กับวงเล็บในชื่อสินค้า (เก่า)
    const codes = splitMachineCodes(p.plan.machine_code || '');
    const use = codes.length ? codes : splitMachineCodes(p.plan.flavor);
    if (!use.length) noMachine += 1;
    const target = p.plan.target_boxes == null ? null : Number(p.plan.target_boxes);
    const sku = p.sku ? skuIdOf(p.sku) : null;
    // ไม่รู้เครื่อง → ยังสร้าง 1 แถวด้วย packer_key '' ให้คนเห็นแล้วเลือกเครื่องเอง (ดีกว่าหายเงียบ)
    const list = use.length ? use : [''];

    for (let i = 0; i < list.length; i += 1) {
      const code = list[i];
      const m = code ? byKey.get(code) : null;
      if (code && !m && !unknownKey.includes(code)) unknownKey.push(code);
      /* plan_key = ที่อยู่ของ "บรรทัดในแผน" ไม่ใช่ของเครื่อง — ลำดับ i ทำให้แผนที่ลง 2 เครื่อง
         ("[L3+L4]") ได้ 2 แถวที่นิ่ง และแผนที่ถูกแก้เครื่องทีหลังจะอัปเดตแถวเดิม ไม่ใช่งอกใบใหม่ */
      const planKey = `${shift}|${fnorm}|${i}`;
      keys.add(planKey);
      rows += 1;

      const ex = await dbGet('SELECT id, source FROM machine_runs WHERE work_day = ? AND plan_key = ?', [workDay, planKey]);
      if (ex) {
        if ((ex.source || 'plan') === 'manual') continue;         // 🔴 manual ชนะ plan — ไม่แตะแม้แต่ช่องเดียว
        try {
          // 🔴 ไม่มี line_name / status / confirmed_by ในนี้โดยตั้งใจ — ของที่คนตัดสินไปแล้วห้ามถูกแผนทับ
          await db.exec(
            `UPDATE machine_runs SET flavor = ?, flavor_norm = ?, packer_name = ?, packer_key = ?,
                    sku_code = COALESCE(?, sku_code), target_boxes = ?, updated_at = ?
              WHERE id = ?`,
            [flavor, fnorm, m ? m.name : '', code, sku, target, now, ex.id]);
        } catch { conflicts.push(`${code ? code.toUpperCase() : '—'} · ${flavor}`); }
        continue;
      }

      /* แผนบรรจุ 1 บรรทัดที่ลง 2 เครื่อง ไม่ได้บอกว่าเครื่องไหนกี่กล่อง
         → ใส่เป้าเต็มทั้งคู่ แล้วให้หน้าเว็บติดป้าย "แผนเดียวกันลง N เครื่อง" ไว้เตือนตา
         (หารสองเองคือการเดาตัวเลขที่ไม่มีในแผน — ห้ามทำ) */
      try {
        await db.exec(
          `INSERT INTO machine_runs
             (work_day, shift, packer_name, packer_key, line_name, flavor, flavor_norm, sku_code,
              target_boxes, source, line_source, plan_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'plan', NULL, ?, 'draft', ?, ?)
           ON CONFLICT (work_day, shift, packer_key, flavor_norm) DO UPDATE SET
              flavor = excluded.flavor,
              packer_name = excluded.packer_name,
              sku_code = COALESCE(excluded.sku_code, machine_runs.sku_code),
              target_boxes = excluded.target_boxes,
              plan_key = excluded.plan_key,
              updated_at = excluded.updated_at
            WHERE machine_runs.source <> 'manual'`,
          [workDay, shift, m ? m.name : '', code, flavor, fnorm, sku, target, planKey, now, now]);
      } catch { conflicts.push(`${code ? code.toUpperCase() : '—'} · ${flavor}`); }
    }
  }
  /* บรรทัดที่หายไปจากแผน (คนแก้แผนทีหลัง) — รอบที่ยังเป็นร่างให้พับเป็น "ยกเลิก"
     ไม่ลบทิ้ง: ยังเห็นอยู่ในตารางแบบจาง ๆ กดคืนค่าได้ถ้าแผนกลับมา
     🔴 รอบที่คนยืนยันไปแล้วห้ามแตะ — แค่รายงานให้คนตัดสินเอง (ของจริงอาจเดินไปแล้ว)      */
  const dropped = [];
  const staleConfirmed = [];
  const stale = await dbAll(
    `SELECT id, plan_key, packer_key, flavor, status FROM machine_runs
      WHERE work_day = ? AND source = 'plan' AND plan_key <> '' AND COALESCE(status, 'draft') <> 'cancelled'`,
    [workDay]).catch(() => []);
  for (const r of stale) {
    if (keys.has(r.plan_key)) continue;
    const label = `${r.packer_key ? r.packer_key.toUpperCase() : '—'} · ${r.flavor || ''}`.trim();
    if ((r.status || 'draft') !== 'draft') { staleConfirmed.push(label); continue; }
    await db.exec("UPDATE machine_runs SET status = 'cancelled', updated_at = ? WHERE id = ?", [now, r.id]);
    dropped.push(label);
  }

  return { planRows: day.length, rows, noMachine, unknownKey, conflicts, dropped, staleConfirmed };
}

/* เติมไลน์ต้มที่ป้อน — เฉพาะแถวที่ยังว่าง และเฉพาะเมื่อ "มีคำตอบเดียว" เท่านั้น
   ① สินค้าตัวนี้ถูกผูกไว้กับคู่ของเครื่องนี้ → line_source='product' (แม่นสุด คนผูกไว้เอง)
   ② เครื่องนี้มีคู่เดียวในระบบ            → line_source='guess'   (ไม่มีอะไรให้เลือกผิด)
   ③ หลายคู่ / สินค้าโยงหลายไลน์            → ปล่อยว่าง ให้คนเลือก 🔴 ห้ามเดามั่ว
      (เดาผิดแล้วคนกดยืนยันตามโดยไม่ดู = ข้อมูลเสียแบบเงียบ ๆ แย่กว่าช่องว่างสีส้ม)          */
async function guessRunLines(workDay) {
  const rows = await dbAll(
    `SELECT id, packer_name, flavor_norm FROM machine_runs
      WHERE work_day = ? AND packer_name <> '' AND (line_name IS NULL OR line_name = '')
        AND COALESCE(status, 'draft') <> 'cancelled'`, [workDay]).catch(() => []);
  if (!rows.length) return 0;
  const links = await dbAll('SELECT id, line_name, packer_name FROM machine_links WHERE active = 1', []);
  const prods = await dbAll("SELECT link_id, flavor_norm FROM machine_link_products WHERE active = 1 AND flavor_norm <> ''", []);
  const lineOf = new Map(links.map((l) => [l.id, l.line_name]));
  let filled = 0;
  for (const r of rows) {
    const mine = links.filter((l) => l.packer_name === r.packer_name);
    if (!mine.length) continue;
    const ids = new Set(mine.map((l) => l.id));
    const byProduct = [...new Set(prods
      .filter((p) => ids.has(p.link_id) && p.flavor_norm === r.flavor_norm)
      .map((p) => lineOf.get(p.link_id)).filter(Boolean))];
    let line = '', src = '';
    if (byProduct.length === 1) { line = byProduct[0]; src = 'product'; }
    else if (!byProduct.length && mine.length === 1) { line = mine[0].line_name; src = 'guess'; }
    if (!line) continue;
    // กันชนซ้ำ: ระหว่างนี้อาจมีคนเพิ่งเลือกไลน์เอง — เงื่อนไขท้ายทำให้ของคนไม่โดนทับ
    await db.exec(
      `UPDATE machine_runs SET line_name = ?, line_source = ?, updated_at = ?
        WHERE id = ? AND (line_name IS NULL OR line_name = '')`, [line, src, nowBKK(), r.id]);
    filled += 1;
  }
  return filled;
}

const shapeRun = (r, labelOf) => ({
  id: r.id, workDay: r.work_day, shift: r.shift || '',
  packerName: r.packer_name || '', packerKey: r.packer_key || '',
  packerLabel: r.packer_name ? (labelOf.get(r.packer_name) || r.packer_name) : '',
  lineName: r.line_name || '', lineLabel: r.line_name ? (labelOf.get(r.line_name) || r.line_name) : '',
  flavor: r.flavor || '', flavorNorm: r.flavor_norm || '', skuCode: r.sku_code || '',
  targetBoxes: r.target_boxes == null ? null : Number(r.target_boxes),
  source: r.source || 'plan', lineSource: r.line_source || '',
  status: r.status || 'draft', confirmedBy: r.confirmed_by || '', confirmedAt: r.confirmed_at || '',
  note: r.note || '',
});

/* รอบเดินเครื่องของวัน (+กะ) · seed=1 = "ขอดึงแผนมาตั้งให้ด้วย"
   🔴 ดึงแผนได้เฉพาะวันทำงานปัจจุบันหรืออนาคตเท่านั้น — ย้อนหลังคือการอ่านประวัติ ห้ามเขียนอะไรทั้งนั้น
      (ใช้ workDayBKK ไม่ใช่ todayBKK: ตี 2 ของวันที่ 14 ยังเป็นวันทำงานของวันที่ 13 คนกะดึกต้องดึงแผนได้) */
app.get('/api/machine-runs', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim() || workDayBKK();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'วันที่ไม่ถูกต้อง' });
    const shift = normalizeShift(String(req.query.shift || '').trim());
    const canSeed = date >= workDayBKK();
    let seeded = null, seedSkipped = '';
    if (String(req.query.seed || '') === '1') {
      // seed = การ "เขียน" ที่ห้อยอยู่บนเส้นอ่าน — ต้องเช็กสิทธิ์เองเพราะ requireRole ครอบทั้งเส้นไม่ได้
      // (คนทั่วไปต้องอ่านตารางรอบได้) · ไม่มีสิทธิ์/วันย้อนหลัง = อ่านต่อไปเฉย ๆ ไม่ต้องตอบ error
      const who = await whoIs(req);
      if (!canSeed) seedSkipped = 'past';
      else if ((ROLE_RANK[(who || {}).role] || 0) < ROLE_RANK.supervisor) seedSkipped = 'role';
      else {
        seeded = await ensureRunsFromPlan(date);
        seeded.filled = await guessRunLines(date);
      }
    }

    const all = await dbAll('SELECT * FROM machine_runs WHERE work_day = ? ORDER BY shift, packer_key, id', [date]);
    const machines = await dbAll(
      "SELECT name, label, grp, mkey FROM machines WHERE active = 1 AND grp IN ('line','packer') ORDER BY sort_order, id", []);
    const labelOf = new Map(machines.map((m) => [m.name, m.label || m.name]));
    const links = await dbAll('SELECT line_name, packer_name FROM machine_links WHERE active = 1', []);

    // ไลน์ที่ "ผูกคู่ไว้กับเครื่องนี้" — หน้าเว็บเอาไปดันขึ้นหัว dropdown แต่ยังเลือกไลน์อื่นได้
    const candidates = {};
    for (const l of links) {
      if (!candidates[l.packer_name]) candidates[l.packer_name] = [];
      if (!candidates[l.packer_name].includes(l.line_name)) candidates[l.packer_name].push(l.line_name);
    }

    const byShift = {};
    for (const r of all) byShift[r.shift || ''] = (byShift[r.shift || ''] || 0) + 1;

    res.json({
      date, shift, canSeed, seeded, seedSkipped,
      shifts: runShiftOptions(date, Object.keys(byShift)),
      byShift,
      runs: all.filter((r) => !shift || (r.shift || '') === shift).map((r) => shapeRun(r, labelOf)),
      lines: machines.filter((m) => m.grp === 'line').map((m) => ({ name: m.name, label: m.label || m.name })),
      packers: machines.filter((m) => m.grp === 'packer').map((m) => ({ name: m.name, label: m.label || m.name, mkey: m.mkey || '' })),
      candidates,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* เพิ่ม/แก้รอบด้วยมือ
   แก้เฉพาะ "ไลน์" → source เดิมคงไว้ (แถวยังมาจากแผน) แต่ line_source='manual' กันตัวเดาทับ
   แก้ช่องอื่น (สินค้า/เป้า/เครื่อง/กะ) → source='manual' ทั้งแถว = ล็อกจากการดึงแผนใหม่ถาวร   */
app.post('/api/machine-runs', requireRole('supervisor'), async (req, res) => {
  const b = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const id = Number(b.id || 0);
  try {
    const nameOk = async (name, grp) => !name
      || !!(await dbGet('SELECT name FROM machines WHERE name = ? AND active = 1 AND grp = ?', [name, grp]));
    const lineName = has('lineName') ? String(b.lineName || '').trim() : null;
    const packerName = has('packerName') ? String(b.packerName || '').trim() : null;
    if (lineName && !(await nameOk(lineName, 'line'))) return res.status(400).json({ error: `"${lineName}" ไม่ใช่ไลน์ผลิตในทะเบียน` });
    if (packerName && !(await nameOk(packerName, 'packer'))) return res.status(400).json({ error: `"${packerName}" ไม่ใช่เครื่องบรรจุในทะเบียน` });

    if (id) {
      const cur = await dbGet('SELECT * FROM machine_runs WHERE id = ?', [id]);
      if (!cur) return res.status(404).json({ error: 'ไม่พบรอบเดินเครื่องนี้' });
      const set = [], val = [];
      const put = (col, v) => { set.push(`${col} = ?`); val.push(v); };
      let heavy = false;                       // heavy = แก้เนื้อแผน ไม่ใช่แค่เติมไลน์

      if (lineName !== null && lineName !== (cur.line_name || '')) {
        put('line_name', lineName || null);
        put('line_source', lineName ? 'manual' : null);
      }
      if (has('flavor')) {
        const flavor = planFlavorText(b.flavor);
        const fnorm = normAlias(flavor);
        if (!fnorm) return res.status(400).json({ error: 'ต้องมีชื่อสินค้า' });
        if (fnorm !== (cur.flavor_norm || '')) { put('flavor', flavor); put('flavor_norm', fnorm); heavy = true; }
        else if (flavor !== (cur.flavor || '')) put('flavor', flavor);
      }
      if (packerName !== null && packerName !== (cur.packer_name || '')) {
        const pk = await dbGet('SELECT mkey FROM machines WHERE name = ?', [packerName]);
        put('packer_name', packerName);
        put('packer_key', (pk && pk.mkey) ? String(pk.mkey).toLowerCase() : '');
        heavy = true;
      }
      if (has('targetBoxes')) {
        const n = b.targetBoxes === '' || b.targetBoxes == null ? null : Number(b.targetBoxes);
        if (n != null && !Number.isFinite(n)) return res.status(400).json({ error: 'เป้าต้องเป็นตัวเลข' });
        if (n !== (cur.target_boxes == null ? null : Number(cur.target_boxes))) { put('target_boxes', n); heavy = true; }
      }
      if (has('note')) put('note', String(b.note || '').trim() || null);
      if (heavy && (cur.source || 'plan') !== 'manual') put('source', 'manual');
      if (!set.length) return res.json({ success: true, unchanged: true });

      /* ย้ายเครื่อง/เปลี่ยนสินค้า = ย้ายคีย์ UNIQUE (work_day, shift, packer_key, flavor_norm)
         ถ้าปลายทางมีรอบอยู่แล้วต้องตอบเป็นข้อความ ไม่ใช่ปล่อยให้ constraint เด้ง SQL ดิบใส่หน้าคน
         (เจอจริงตอนย้ายแถว "ไม่รู้ว่าเครื่องไหน" ไปทับรอบที่คนเพิ่มเองไว้แล้ว)                */
      const at = (col, fallback) => {
        const i = set.findIndex((x) => x.startsWith(`${col} =`));
        return i < 0 ? fallback : val[i];
      };
      const nextKey = { pkey: at('packer_key', cur.packer_key || ''), fnorm: at('flavor_norm', cur.flavor_norm || '') };
      if (nextKey.pkey !== (cur.packer_key || '') || nextKey.fnorm !== (cur.flavor_norm || '')) {
        const clash = await dbGet(
          `SELECT id FROM machine_runs WHERE work_day = ? AND shift = ? AND packer_key = ? AND flavor_norm = ? AND id <> ?`,
          [cur.work_day, cur.shift, nextKey.pkey, nextKey.fnorm, id]);
        if (clash) return res.status(409).json({ error: 'กะนี้มีรอบของเครื่อง+สินค้าคู่นี้อยู่แล้ว — รวมกับแถวเดิมแทน', id: clash.id });
      }

      put('updated_at', nowBKK());
      val.push(id);
      await db.exec(`UPDATE machine_runs SET ${set.join(', ')} WHERE id = ?`, val);
      const row = await dbGet('SELECT * FROM machine_runs WHERE id = ?', [id]);
      const labelOf = new Map((await dbAll('SELECT name, label FROM machines WHERE active = 1', [])).map((m) => [m.name, m.label || m.name]));
      return res.json({ success: true, run: shapeRun(row, labelOf) });
    }

    // ── เพิ่มรอบใหม่ด้วยมือ ──
    const workDay = String(b.workDay || '').trim() || workDayBKK();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDay)) return res.status(400).json({ error: 'วันที่ไม่ถูกต้อง' });
    const shift = normalizeShift(String(b.shift || '').trim());
    if (!shift) return res.status(400).json({ error: 'ต้องเลือกกะ' });
    const flavor = planFlavorText(b.flavor);
    const fnorm = normAlias(flavor);
    if (!fnorm) return res.status(400).json({ error: 'ต้องใส่ชื่อสินค้า' });
    if (!packerName) return res.status(400).json({ error: 'ต้องเลือกเครื่องบรรจุ' });
    const pk = await dbGet('SELECT mkey FROM machines WHERE name = ?', [packerName]);
    const pkey = (pk && pk.mkey) ? String(pk.mkey).toLowerCase() : '';
    // กันซ้ำเองก่อนชน UNIQUE เพื่อให้ข้อความอ่านรู้เรื่อง (แถวเดิมอาจถูกยกเลิกไว้ — บอกให้ไปเปิดใหม่)
    const dup = await dbGet(
      'SELECT id, status FROM machine_runs WHERE work_day = ? AND shift = ? AND packer_key = ? AND flavor_norm = ?',
      [workDay, shift, pkey, fnorm]);
    if (dup) {
      return res.status(409).json({
        error: dup.status === 'cancelled'
          ? 'รอบนี้มีอยู่แล้วแต่ถูกยกเลิกไว้ — กด "คืนค่า" ที่แถวเดิมแทน'
          : 'รอบนี้มีอยู่แล้วในตาราง — แก้ที่แถวเดิมแทน',
        id: dup.id,
      });
    }
    const now = nowBKK();
    const r = await dbRun(
      `INSERT INTO machine_runs
         (work_day, shift, packer_name, packer_key, line_name, flavor, flavor_norm, sku_code,
          target_boxes, source, line_source, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'draft', ?, ?, ?)`,
      [workDay, shift, packerName, pkey, lineName || null, flavor, fnorm, b.skuCode || null,
        b.targetBoxes == null || b.targetBoxes === '' ? null : Number(b.targetBoxes),
        lineName ? 'manual' : null, String(b.note || '').trim() || null, now, now]);
    const row = await dbGet('SELECT * FROM machine_runs WHERE id = ?', [r.lastID]);
    const labelOf = new Map((await dbAll('SELECT name, label FROM machines WHERE active = 1', [])).map((m) => [m.name, m.label || m.name]));
    res.json({ success: true, run: shapeRun(row, labelOf) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* เปลี่ยนสถานะรอบ — ทีละแถว (id) หรือทั้งกะ (workDay + shift + all)
   ยืนยันต้องมีไลน์ก่อนเสมอ: รอบที่ไม่รู้ว่าป้อนจากไลน์ไหน ยิงกฎเตือนในขั้นถัดไปไม่ได้
   "ยืนยันทั้งกะ" จึงข้ามแถวที่ยังไม่เลือกไลน์แล้วรายงานกลับ ไม่ใช่ล้มทั้งคำขอ                */
async function setRunStatus(req, res, status) {
  const b = req.body || {};
  const by = (req.who && req.who.name) || '';
  try {
    let rows = [];
    if (b.id) {
      const one = await dbGet('SELECT * FROM machine_runs WHERE id = ?', [Number(b.id)]);
      if (!one) return res.status(404).json({ error: 'ไม่พบรอบเดินเครื่องนี้' });
      rows = [one];
    } else if (Array.isArray(b.ids) && b.ids.length) {
      rows = await dbAll(`SELECT * FROM machine_runs WHERE id IN (${b.ids.map(() => '?').join(',')})`, b.ids.map(Number));
    } else if (b.workDay) {
      const shift = normalizeShift(String(b.shift || '').trim());
      rows = await dbAll(
        `SELECT * FROM machine_runs WHERE work_day = ?${shift ? ' AND shift = ?' : ''}
           AND COALESCE(status, 'draft') <> 'cancelled'`, shift ? [b.workDay, shift] : [b.workDay]);
    } else return res.status(400).json({ error: 'ต้องระบุ id หรือ workDay' });

    const now = nowBKK();
    let changed = 0;
    const skipped = [];
    for (const r of rows) {
      if ((r.status || 'draft') === status) continue;
      if (status === 'confirmed' && !(r.line_name || '').trim()) {
        skipped.push(`${r.packer_name || r.packer_key || '—'} · ${r.flavor || ''}`.trim());
        continue;
      }
      const stamp = status === 'confirmed';
      await db.exec(
        `UPDATE machine_runs SET status = ?, updated_at = ?${stamp ? ', confirmed_by = ?, confirmed_at = ?' : ''} WHERE id = ?`,
        stamp ? [status, now, by, now, r.id] : [status, now, r.id]);
      changed += 1;
      /* 🏁 ปิดงานบรรจุ = สัญญาณ "บรรจุจบแล้ว" ที่ user เคาะไว้ — ยิงการ์ดทันทีไม่ต้องรอนาฬิกา
         (นาฬิกา "ก่อนจบกะ 1 ชม." ยังทำงานอยู่ แต่คีย์ run:{id}:end กันไม่ให้ยิงซ้ำ)
         ไม่ await ผลลัพธ์เข้าคำตอบ — ส่งการ์ดพลาดต้องไม่ทำให้ปุ่มปิดงานล้ม                */
      if (status === 'done') {
        fireRunNotify(r, 'end').catch((e) => console.error('[run-notify] ยิงตอนปิดงานไม่สำเร็จ', e.message));
      }
    }
    res.json({ success: true, changed, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
app.post('/api/machine-runs/confirm', requireRole('supervisor'), (req, res) => setRunStatus(req, res, 'confirmed'));
app.post('/api/machine-runs/done', requireRole('supervisor'), (req, res) => setRunStatus(req, res, 'done'));
app.post('/api/machine-runs/cancel', requireRole('supervisor'), (req, res) => setRunStatus(req, res, 'cancelled'));
app.post('/api/machine-runs/reopen', requireRole('supervisor'), (req, res) => setRunStatus(req, res, 'draft'));

/* ══ กฎเตือน (machine_rules) ═══════════════════════════════════════════════════
   กฎ = "ถ้าวันนี้เครื่องนี้ผลิตสินค้าตัวนี้ → ต้องทำอะไรบ้าง ตอนไหน"
   เงื่อนไขช่องไหนเว้นว่าง = "อะไรก็ได้" · ช่องที่กรอกทั้งหมดต้องตรงพร้อมกัน (AND)

   🔴 หลายกฎเข้าพร้อมกันได้ — ไม่ใช่ "ผู้ชนะคนเดียว" ข้อของทุกกฎรวมเป็นใบเดียว ข้อซ้ำตัดทิ้ง
   🔴 packer_key / specificity เซิร์ฟเวอร์คิดเองเสมอ ห้ามเชื่อค่าที่ client ส่งมา
      (ค่าพวกนี้เป็นตัวตัดสินว่ากฎไหนเข้า/ขึ้นก่อน ปล่อยให้ client กำหนด = ปลอมลำดับได้)
   ══════════════════════════════════════════════════════════════════════════════ */

const RULE_TIMING = ['start', 'during', 'end'];
const RULE_TIMING_LABEL = { start: 'ก่อนเริ่มบรรจุ', during: 'ระหว่างเดินเครื่อง', end: 'หลังบรรจุจบ' };

/* ความจำเพาะ = "กฎนี้เจาะจงแค่ไหน" ใช้เรียงลำดับข้อในเช็กลิสต์ (มากขึ้นก่อน)
   สินค้า 8 > เครื่อง 4 > ไลน์ 2 > กะ 1 — สินค้าหนักสุดเพราะระบุตัวงานได้แคบที่สุด
   ("Amazon บน L2" เจาะจงกว่า "อะไรก็ได้บน L2") · เลขนี้ตรงกับที่โชว์ใน mockup */
const ruleSpecificity = (r) => (r.product_pattern ? 8 : 0) + (r.packer_name ? 4 : 0)
  + (r.line_name ? 2 : 0) + (r.shift ? 1 : 0);

// คีย์ของข้อ — ห้ามซ้ำกับของที่เคยใช้แม้แต่ครั้งเดียว เพราะ run_check_items ใช้เป็น ON CONFLICT target
// (ใช้สุ่มแทนเลขรันนิ่ง: ลบข้อ 2 แล้วเพิ่มใหม่จะได้เลข 2 ซ้ำ ไปทับผลติ๊กของใบเก่า)
const newItemKey = () => 'k' + require('crypto').randomBytes(4).toString('hex');

/* รายการที่ต้องทำของกฎ — เก็บเป็น JSON string (ต้องใช้ได้ทั้ง SQLite และ PG)
   ข้อที่ไม่มีชื่อถูกตัดทิ้ง · ข้อเดิมต้องส่ง key กลับมาด้วยไม่งั้นถือเป็นข้อใหม่ */
function normalizeRuleItems(raw) {
  const out = [];
  for (const it of (Array.isArray(raw) ? raw : [])) {
    const title = String((it || {}).title || '').trim();
    if (!title) continue;
    out.push({
      key: String((it || {}).key || '').trim() || newItemKey(),
      title,
      detail: String(it.detail || '').trim(),
      needPhoto: !!it.needPhoto,
      needQc: !!it.needQc,
    });
  }
  return out;
}

/* กฎนี้เข้ากับรอบเดินเครื่องนี้ไหม — ช่องว่างในกฎ = อะไรก็ได้
   เทียบสินค้าผ่าน normAlias ทั้งคู่ ("Amazon 850×12" ↔ "amazon" ต้องเจอกัน
   ไม่งั้นคนต้องพิมพ์ชื่อเป๊ะ ๆ ซึ่งเป็นไปไม่ได้กับชื่อในแผนที่สะกดกันคนละแบบ) */
function ruleHitsRun(rule, run) {
  if (rule.line_name && rule.line_name !== (run.line_name || '')) return false;
  if (rule.packer_name && rule.packer_name !== (run.packer_name || '')) return false;
  if (rule.shift && rule.shift !== (run.shift || '')) return false;
  if (rule.product_pattern) {
    const want = normAlias(rule.product_pattern);
    if (!want) return true;                       // กรอกมาแต่เหลือแต่อักขระพิเศษ = ไม่ใช้กรอง
    if (!normAlias(run.flavor || '').includes(want)) return false;
  }
  return true;
}

/* กฎทั้งหมดที่เข้ากับรอบนี้ เรียงจำเพาะมากขึ้นก่อน
   🔑 ไม่ตัดเหลือกฎเดียว — "ล้างหัวพิมพ์" กับ "ตรวจ o-ring" ต้องได้ทั้งคู่ถ้าเข้าเงื่อนไขทั้งคู่ */
const matchRules = (rules, run) => rules
  .filter((r) => ruleHitsRun(r, run))
  .sort((a, b) => (b.specificity || 0) - (a.specificity || 0) || a.id - b.id);

/* รวมข้อของทุกกฎที่เข้า → ใบเดียวต่อ (รอบ × จังหวะ)
   ข้อซ้ำตัดทิ้งโดยดูที่ "ชื่อข้อ" ไม่ใช่ key — กฎ 2 ตัวเขียนข้อเดียวกันคนละ key ได้
   (คนติ๊กไม่ควรเห็น "ล้างหัวพิมพ์" 2 บรรทัดเพราะบังเอิญมีกฎซ้อนกัน) */
function mergeRuleItems(hitRules) {
  const seen = new Set(), items = [];
  for (const r of hitRules) {
    for (const it of (r.items || [])) {
      const dedup = normAlias(it.title);
      if (!dedup || seen.has(dedup)) continue;
      seen.add(dedup);
      items.push({ ...it, ruleId: r.id, ruleTitle: r.title });
    }
  }
  return items;
}

// กฎที่ใช้งานอยู่ทั้งหมด (ผ่าน shapeRule แล้ว — มี items เป็น array พร้อมใช้)
const activeRules = async () => (await dbAll(
  'SELECT * FROM machine_rules WHERE active = 1 AND deleted = 0 ORDER BY specificity DESC, id', []))
  .map(shapeRuleRow);

// แถวดิบ + items ที่แปลงแล้ว — ใช้ภายในฝั่งเซิร์ฟเวอร์ (คนละรูปกับ shapeRule ที่ส่งให้หน้าเว็บ)
function shapeRuleRow(r) {
  let items = [];
  try { items = JSON.parse(r.items || '[]'); } catch { items = []; }
  return { ...r, items: Array.isArray(items) ? items : [] };
}

app.get('/api/machine-rules', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM machine_rules WHERE deleted = 0 ORDER BY specificity DESC, id', []);
    const machines = await dbAll(
      "SELECT name, label, grp, mkey FROM machines WHERE active = 1 AND grp IN ('line','packer') ORDER BY sort_order, id", []);
    const counts = { all: 0, start: 0, during: 0, end: 0, off: 0 };
    for (const r of rows) {
      if (!r.active) { counts.off += 1; continue; }
      counts.all += 1;
      counts[RULE_TIMING.includes(r.timing) ? r.timing : 'start'] += 1;
    }
    res.json({
      rules: rows.map(shapeRule),
      counts,
      timings: RULE_TIMING.map((k) => ({ key: k, label: RULE_TIMING_LABEL[k] })),
      lines: machines.filter((m) => m.grp === 'line').map((m) => ({ name: m.name, label: m.label || m.name })),
      packers: machines.filter((m) => m.grp === 'packer').map((m) => ({ name: m.name, label: m.label || m.name, mkey: m.mkey || '' })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/machine-rules', requireRole('supervisor'), async (req, res) => {
  const b = req.body || {};
  const id = Number(b.id || 0);
  try {
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'ต้องตั้งชื่อกฎ' });
    const timing = RULE_TIMING.includes(String(b.timing || '')) ? String(b.timing) : 'start';
    const lineName = String(b.lineName || '').trim();
    const packerName = String(b.packerName || '').trim();
    // ชื่อเครื่องต้องมีจริงในทะเบียน — กฎที่ชี้ไปยังเครื่องที่ไม่มีอยู่จะไม่มีวันเข้าเงื่อนไข แล้วไม่มีใครรู้ว่าทำไม
    const chk = async (name, grp) => !name
      || !!(await dbGet('SELECT name FROM machines WHERE name = ? AND active = 1 AND grp = ?', [name, grp]));
    if (!(await chk(lineName, 'line'))) return res.status(400).json({ error: `"${lineName}" ไม่ใช่ไลน์ผลิตในทะเบียน` });
    if (!(await chk(packerName, 'packer'))) return res.status(400).json({ error: `"${packerName}" ไม่ใช่เครื่องบรรจุในทะเบียน` });

    const items = normalizeRuleItems(b.items);
    if (!items.length) return res.status(400).json({ error: 'ต้องมีรายการที่ต้องทำอย่างน้อย 1 ข้อ' });

    // 🔴 packer_key + specificity คิดที่นี่เท่านั้น — ไม่อ่านจาก body เด็ดขาด
    const pk = packerName ? await dbGet('SELECT mkey FROM machines WHERE name = ?', [packerName]) : null;
    const row = {
      title, timing, line_name: lineName, packer_name: packerName,
      packer_key: (pk && pk.mkey) ? String(pk.mkey).toLowerCase() : '',
      product_pattern: String(b.productPattern || '').trim(),
      shift: normalizeShift(String(b.shift || '').trim()),
      items: JSON.stringify(items),
      owner_role: String(b.ownerRole || '').trim() || null,
      note: String(b.note || '').trim() || null,
      notify: b.notify === false || b.notify === 0 ? 0 : 1,
      active: b.active === false || b.active === 0 ? 0 : 1,
    };
    row.specificity = ruleSpecificity(row);

    if (id) {
      const cur = await dbGet('SELECT id, line_name, packer_name FROM machine_rules WHERE id = ? AND deleted = 0', [id]);
      if (!cur) return res.status(404).json({ error: 'ไม่พบกฎนี้' });
      await db.exec(
        `UPDATE machine_rules SET title = ?, timing = ?, line_name = ?, packer_name = ?, packer_key = ?,
                product_pattern = ?, shift = ?, items = ?, owner_role = ?, note = ?, specificity = ?,
                notify = ?, active = ?, updated_at = ? WHERE id = ?`,
        [row.title, row.timing, row.line_name, row.packer_name, row.packer_key, row.product_pattern,
          row.shift, row.items, row.owner_role, row.note, row.specificity, row.notify, row.active, nowBKK(), id]);
      const out = await dbGet('SELECT * FROM machine_rules WHERE id = ?', [id]);
      // ย้ายกฎไปเครื่องอื่น = โน้ตของเครื่องเดิมต้องเลิกโชว์กฎนี้ด้วย
      touchMachineNotes(row.line_name, row.packer_name, cur.line_name, cur.packer_name);
      return res.json({ success: true, rule: shapeRule(out) });
    }
    const ins = await dbRun(
      `INSERT INTO machine_rules (code, title, timing, line_name, packer_name, packer_key, product_pattern,
          shift, items, owner_role, note, specificity, notify, active, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [String(b.code || '').trim() || null, row.title, row.timing, row.line_name, row.packer_name, row.packer_key,
        row.product_pattern, row.shift, row.items, row.owner_role, row.note, row.specificity,
        row.notify, row.active, nowBKK(), nowBKK()]);
    const out = await dbGet('SELECT * FROM machine_rules WHERE id = ?', [ins.lastID]);
    touchMachineNotes(row.line_name, row.packer_name);
    res.json({ success: true, rule: shapeRule(out) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// เปิด/ปิดใช้ชั่วคราว — คนละเรื่องกับลบ (ปิดไว้ = ยังเห็นในลิสต์ กดเปิดกลับได้)
app.post('/api/machine-rules/toggle', requireRole('supervisor'), async (req, res) => {
  const id = Number((req.body || {}).id || 0);
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const cur = await dbGet('SELECT active, line_name, packer_name FROM machine_rules WHERE id = ? AND deleted = 0', [id]);
    if (!cur) return res.status(404).json({ error: 'ไม่พบกฎนี้' });
    const next = cur.active ? 0 : 1;
    await db.exec('UPDATE machine_rules SET active = ?, updated_at = ? WHERE id = ?', [next, nowBKK(), id]);
    touchMachineNotes(cur.line_name, cur.packer_name);
    res.json({ success: true, active: next });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ลบ = ซ่อนถาวร ไม่ล้างแถวทิ้ง — ใบเช็กเก่าอ้าง rule_id อยู่ ลบจริงแล้วประวัติจะหาที่มาไม่เจอ
app.post('/api/machine-rules/delete', requireRole('supervisor'), async (req, res) => {
  const id = Number((req.body || {}).id || 0);
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const cur = await dbGet('SELECT line_name, packer_name FROM machine_rules WHERE id = ?', [id]);
    await db.exec('UPDATE machine_rules SET deleted = 1, active = 0, updated_at = ? WHERE id = ?', [nowBKK(), id]);
    touchMachineNotes(cur && cur.line_name, cur && cur.packer_name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* 🧪 ลองกฎกับรอบเดินเครื่องจริงของวันนั้น — อ่านอย่างเดียว ไม่เขียน ไม่ส่งการ์ด
   ใช้ 2 ที่: ปุ่ม "ลองกับแผนวันนี้" ในหน้าแก้กฎ (ส่ง draft มาลองได้โดยยังไม่บันทึก)
             และการ์ด "กฎที่จะยิงวันนี้" ในแท็บ 📅 วันนี้
   ⚠️ รอบที่ถูกยกเลิกไม่นับ · รอบที่ยังไม่เลือกไลน์ยังนับ (กฎที่ไม่ได้ระบุไลน์ก็เข้าได้อยู่ดี) */
app.post('/api/machine-rules/preview', async (req, res) => {
  const b = req.body || {};
  try {
    const date = String(b.date || '').trim() || workDayBKK();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'วันที่ไม่ถูกต้อง' });
    const shift = normalizeShift(String(b.shift || '').trim());
    const runs = (await dbAll(
      `SELECT * FROM machine_runs WHERE work_day = ? AND COALESCE(status, 'draft') <> 'cancelled'
        ORDER BY shift, packer_key, id`, [date]))
      .filter((r) => !shift || (r.shift || '') === shift);

    let rules = await activeRules();
    // ร่างที่ยังไม่บันทึก — เอามาแทนตัวเดิม (หรือเพิ่มเข้าไปถ้าเป็นกฎใหม่) เพื่อให้ลองก่อนบันทึกได้
    if (b.draft) {
      const d = b.draft;
      const pk = d.packerName ? await dbGet('SELECT mkey FROM machines WHERE name = ?', [d.packerName]) : null;
      const draft = {
        id: Number(d.id || 0) || -1,
        title: String(d.title || '').trim() || '(กฎที่กำลังแก้)',
        timing: RULE_TIMING.includes(String(d.timing || '')) ? d.timing : 'start',
        line_name: String(d.lineName || '').trim(),
        packer_name: String(d.packerName || '').trim(),
        packer_key: (pk && pk.mkey) ? String(pk.mkey).toLowerCase() : '',
        product_pattern: String(d.productPattern || '').trim(),
        shift: normalizeShift(String(d.shift || '').trim()),
        items: normalizeRuleItems(d.items),
        owner_role: d.ownerRole || '',
      };
      draft.specificity = ruleSpecificity(draft);
      rules = rules.filter((r) => r.id !== draft.id).concat([draft]);
      rules.sort((a, b2) => (b2.specificity || 0) - (a.specificity || 0) || a.id - b2.id);
    }

    const byRule = {};
    const out = runs.map((run) => {
      const hits = matchRules(rules, run);
      for (const h of hits) byRule[h.id] = (byRule[h.id] || 0) + 1;
      const timings = {};
      for (const t of RULE_TIMING) {
        const sub = hits.filter((h) => (h.timing || 'start') === t);
        if (!sub.length) continue;
        timings[t] = {
          rules: sub.map((h) => ({ id: h.id, title: h.title, ownerRole: h.owner_role || '', specificity: h.specificity || 0 })),
          items: mergeRuleItems(sub),
        };
      }
      return {
        runId: run.id, shift: run.shift || '',
        packerName: run.packer_name || '', packerKey: run.packer_key || '',
        lineName: run.line_name || '', flavor: run.flavor || '',
        status: run.status || 'draft',
        hitCount: hits.length,
        timings,
      };
    });
    res.json({
      date, shift,
      runs: out,
      byRule,
      totalRuns: runs.length,
      hitRuns: out.filter((r) => r.hitCount).length,
      timingLabel: RULE_TIMING_LABEL,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══ ใบเช็กของรอบเดินเครื่อง (run_checks) ══════════════════════════════════════
   1 ใบ = 1 รอบเดินเครื่อง × 1 จังหวะ (ก่อนเริ่ม / ระหว่างเดิน / หลังจบ)
   ข้อในใบ = ข้อของทุกกฎที่เข้ากับรอบนั้น รวมกันแล้วตัดข้อซ้ำ (ผ่าน mergeRuleItems)

   🔴 title/detail เป็น "snapshot" — แก้กฎทีหลังแล้วใบที่ส่งไปแล้วต้องไม่เปลี่ยนตาม
      (ใบที่ยังเป็นร่างอัปเดตตามกฎได้ เพราะยังไม่ได้เป็นหลักฐานของอะไร)
   🔴 สร้างใบใหม่เฉพาะตอนคน "เปิดใบ" ของวันทำงานปัจจุบัน/อนาคตเท่านั้น
      ย้อนหลัง = อ่านของที่มีอยู่จริง ไม่สร้างใบเปล่า (บทเรียนใบเช็ก AM ข้อเดิม)
   🔴 กฎไม่เข้าเลย = ไม่มีใบ ไม่สร้างแถว — เงียบดีกว่าใบเปล่า
   ══════════════════════════════════════════════════════════════════════════════ */

const runCheckStatusOf = (rows) => {
  const done = rows.filter((r) => r.result === 'ok' || r.result === 'ng').length;
  return { total: rows.length, ok: rows.filter((r) => r.result === 'ok').length,
    ng: rows.filter((r) => r.result === 'ng').length, left: rows.length - done };
};

// รูปเก็บได้ 2 แบบ: URL (อัป Supabase แล้ว) กับ data: (เครื่องที่ไม่มี Supabase)
// ส่งกลับเฉพาะที่เป็น URL — ยัด data: ลง payload ทำให้ใบเดียวหนักหลาย MB บนเน็ตมือถือ
const shapeCheckItem = (r) => ({
  itemKey: r.item_key, ruleId: r.rule_id || 0,
  title: r.title || '', detail: r.detail || '',
  needPhoto: !!r.need_photo, needQc: !!r.need_qc,
  result: r.result === 'ok' || r.result === 'ng' ? r.result : null,
  cause: r.cause || '',
  hasPhoto: !!r.photo,
  photoUrl: r.photo && String(r.photo).startsWith('http') ? r.photo : null,
  checkedBy: r.checked_by || '', qcBy: r.qc_by || '', updatedAt: r.updated_at || '',
});

/* ประกอบใบของ (รอบ × จังหวะ) — create=false คือโหมดอ่านอย่างเดียว (ย้อนหลัง/ไม่มีสิทธิ์)
   ซิงก์ข้อจากกฎทุกครั้งที่เปิด แต่ 🔴 ไม่แตะ result/cause/photo/checked_by/qc_by เด็ดขาด
   — ช่างติ๊กไปครึ่งใบแล้วหัวหน้าแก้กฎ ผลที่ติ๊กไว้ต้องอยู่ครบเหมือนเดิม                  */
async function buildRunCheck(run, timing, { create = true, by = '' } = {}) {
  const rules = matchRules(await activeRules(), run).filter((r) => (r.timing || 'start') === timing);
  const wanted = mergeRuleItems(rules);
  let check = await dbGet('SELECT * FROM run_checks WHERE run_id = ? AND timing = ?', [run.id, timing]);

  if (!check && (!create || !wanted.length)) {
    return { check: null, items: [], summary: runCheckStatusOf([]), rules: rules.length };
  }
  if (!check) {
    await db.exec(
      `INSERT INTO run_checks (run_id, work_day, shift, machine_name, timing, status, opened_by, opened_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
       ON CONFLICT (run_id, timing) DO NOTHING`,
      [run.id, run.work_day, run.shift || '', run.packer_name || '', timing, by || null, nowBKK(), nowBKK()]);
    check = await dbGet('SELECT * FROM run_checks WHERE run_id = ? AND timing = ?', [run.id, timing]);
  }

  const locked = (check.status || 'draft') === 'submitted';
  if (!locked) {
    for (let i = 0; i < wanted.length; i += 1) {
      const it = wanted[i];
      await db.exec(
        `INSERT INTO run_check_items (check_id, item_key, rule_id, title, detail, need_photo, need_qc, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (check_id, item_key) DO UPDATE SET
            rule_id = excluded.rule_id, title = excluded.title, detail = excluded.detail,
            need_photo = excluded.need_photo, need_qc = excluded.need_qc`,
        [check.id, it.key, it.ruleId || null, it.title, it.detail || '',
          it.needPhoto ? 1 : 0, it.needQc ? 1 : 0, nowBKK()]);
    }
    /* ข้อที่กฎไม่ผลิตแล้ว (กฎถูกแก้ / ปิดใช้ / ลบ) — ลบเฉพาะข้อที่ "ยังไม่มีใครแตะ"
       ข้อที่ติ๊กไปแล้วเก็บไว้ เพราะมันคือบันทึกว่าวันนั้นตรวจอะไรไปจริง ๆ
       ⚠️ ต้องกวาดตอน wanted ว่างด้วย (ปิดกฎทั้งตัว) ไม่งั้นเหลือข้อค้างที่ไม่มีกฎไหนสั่งแล้ว */
    const keys = wanted.map((x) => x.key);
    await db.exec(
      keys.length
        ? `DELETE FROM run_check_items WHERE check_id = ? AND result IS NULL
             AND item_key NOT IN (${keys.map(() => '?').join(',')})`
        : 'DELETE FROM run_check_items WHERE check_id = ? AND result IS NULL',
      keys.length ? [check.id, ...keys] : [check.id]);
  }

  const rows = await dbAll(
    'SELECT * FROM run_check_items WHERE check_id = ? ORDER BY id', [check.id]);
  return { check, items: rows.map(shapeCheckItem), summary: runCheckStatusOf(rows), rules: rules.length };
}

// จังหวะที่รอบนี้ "มีของให้ทำ" — ปุ่มสลับบนหัวหน้ามือถือใช้ตัวนี้ ไม่ใช่โชว์ทั้ง 3 จังหวะเสมอ
async function runCheckTimings(run) {
  const rules = matchRules(await activeRules(), run);
  const checks = await dbAll('SELECT timing, status FROM run_checks WHERE run_id = ?', [run.id]);
  const out = [];
  for (const t of RULE_TIMING) {
    const sub = rules.filter((r) => (r.timing || 'start') === t);
    const ex = checks.find((c) => c.timing === t);
    if (!sub.length && !ex) continue;
    out.push({
      key: t, label: RULE_TIMING_LABEL[t],
      nItems: mergeRuleItems(sub).length,
      status: ex ? (ex.status || 'draft') : 'none',
    });
  }
  return out;
}

const shapeRunForCheck = (run, labelOf) => ({
  id: run.id, workDay: run.work_day, shift: run.shift || '',
  packerName: run.packer_name || '', packerKey: run.packer_key || '',
  packerLabel: run.packer_name ? (labelOf.get(run.packer_name) || run.packer_name) : '',
  lineName: run.line_name || '', lineLabel: run.line_name ? (labelOf.get(run.line_name) || run.line_name) : '',
  flavor: run.flavor || '', targetBoxes: run.target_boxes == null ? null : Number(run.target_boxes),
  status: run.status || 'draft',
});

const labelMap = async () => new Map(
  (await dbAll('SELECT name, label FROM machines WHERE active = 1', [])).map((m) => [m.name, m.label || m.name]));

// ใบของรอบที่ระบุ — ใช้จากหน้า Admin (มีสิทธิ์อยู่แล้ว) และเป็นฐานของเส้น token ข้างล่าง
async function runCheckPayload(run, timing, by) {
  const canCreate = run.work_day >= workDayBKK();     // ย้อนหลัง = อ่านอย่างเดียว ไม่เปิดใบใหม่
  const built = await buildRunCheck(run, timing, { create: canCreate, by });
  const labelOf = await labelMap();
  return {
    run: shapeRunForCheck(run, labelOf),
    timing,
    timings: await runCheckTimings(run),
    check: built.check ? {
      id: built.check.id, status: built.check.status || 'draft',
      submittedBy: built.check.submitted_by || '', submittedAt: built.check.submitted_at || '',
    } : null,
    items: built.items,
    summary: built.summary,
    readonly: !canCreate,
    ruleCount: built.rules,
  };
}

app.get('/api/run-check', async (req, res) => {
  try {
    const runId = Number(req.query.runId || 0);
    if (!runId) return res.status(400).json({ error: 'runId จำเป็น' });
    const run = await dbGet('SELECT * FROM machine_runs WHERE id = ?', [runId]);
    if (!run) return res.status(404).json({ error: 'ไม่พบรอบเดินเครื่องนี้' });
    const timings = await runCheckTimings(run);
    const timing = RULE_TIMING.includes(String(req.query.timing || ''))
      ? String(req.query.timing) : (timings[0] || {}).key || 'start';
    res.json(await runCheckPayload(run, timing, req.query.by));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* เปิดจากลิงก์ในกลุ่ม — token ผูกกับ "เครื่อง" ไม่ใช่รอบ
   เซิร์ฟเวอร์หาให้เองว่าวันนี้เครื่องนี้เดินรอบไหน (ลิงก์เดียวใช้ได้ทุกวันทุกกะ เหมือนใบเช็ก AM)
   หลายรอบในวันเดียว = ให้เลือก แต่เลือกรอบของกะปัจจุบันไว้ก่อน                            */
app.get('/api/run-check/open/:token', async (req, res) => {
  try {
    const link = await dbGet('SELECT * FROM run_check_links WHERE token = ? AND active = 1', [req.params.token]);
    if (!link) return res.status(404).json({ error: 'ลิงก์นี้ใช้ไม่ได้แล้ว — ขอลิงก์ใหม่จากหัวหน้า' });
    await db.exec('UPDATE run_check_links SET last_used_at = ? WHERE token = ?', [nowBKK(), req.params.token]);

    const workDay = workDayBKK();
    const runs = await dbAll(
      `SELECT * FROM machine_runs
        WHERE packer_name = ? AND work_day = ? AND COALESCE(status, 'draft') <> 'cancelled'
        ORDER BY shift, id`, [link.machine_name, workDay]);
    const labelOf = await labelMap();
    if (!runs.length) {
      return res.json({
        token: req.params.token, machineName: link.machine_name,
        machineLabel: labelOf.get(link.machine_name) || link.machine_name,
        workDay, runs: [], run: null, items: [], summary: runCheckStatusOf([]), timings: [],
        empty: 'วันนี้ยังไม่มีรอบเดินเครื่องของเครื่องนี้ — ให้หัวหน้าดึงแผนบรรจุที่หน้า “ทะเบียนเครื่องจักร → วันนี้” ก่อน',
      });
    }
    const cur = normalizeShift(currentShiftCode());
    const wantRun = Number(req.query.runId || 0);
    const run = runs.find((r) => r.id === wantRun) || runs.find((r) => (r.shift || '') === cur) || runs[0];
    const timings = await runCheckTimings(run);
    const timing = RULE_TIMING.includes(String(req.query.timing || ''))
      ? String(req.query.timing) : (timings[0] || {}).key || 'start';
    const payload = await runCheckPayload(run, timing, req.query.by);
    res.json({
      ...payload,
      token: req.params.token,
      machineName: link.machine_name,
      machineLabel: labelOf.get(link.machine_name) || link.machine_name,
      workDay,
      runs: runs.map((r) => shapeRunForCheck(r, labelOf)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* บันทึกผล 1 ข้อ — หน้ามือถือยิงทุกครั้งที่แตะ (ไม่มีปุ่ม "บันทึก")
   result: 'ok' | 'ng' | null (ล้างกลับเป็นยังไม่ตรวจ)
   🔴 'ng' ต้องมีสาเหตุ · ข้อที่กฎสั่ง "ต้องมี QC ร่วม" ต้องมีชื่อ QC ก่อนถึงจะติ๊กได้
   🔴 เปลี่ยนจาก ng → ok ต้องล้างสาเหตุ/รูปทิ้ง ไม่งั้นเหลือสาเหตุค้างบนข้อที่บอกว่าปกติ   */
app.post('/api/run-check/item', async (req, res) => {
  if (rateLimited(req.ip, 300, 60000, 'runcheck-item')) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  const b = req.body || {};
  try {
    const checkId = Number(b.checkId || 0);
    const itemKey = String(b.itemKey || '').trim();
    if (!checkId || !itemKey) return res.status(400).json({ error: 'checkId และ itemKey จำเป็น' });
    const check = await dbGet('SELECT * FROM run_checks WHERE id = ?', [checkId]);
    if (!check) return res.status(404).json({ error: 'ไม่พบใบเช็กนี้' });
    if ((check.status || 'draft') === 'submitted') return res.status(409).json({ error: 'ใบนี้ส่งไปแล้ว แก้ไม่ได้' });
    const item = await dbGet('SELECT * FROM run_check_items WHERE check_id = ? AND item_key = ?', [checkId, itemKey]);
    if (!item) return res.status(404).json({ error: 'ไม่พบข้อนี้ในใบ' });

    const result = b.result === 'ok' || b.result === 'ng' ? b.result : null;
    const cause = result === 'ng' ? String(b.cause || '').trim() : '';
    if (result === 'ng' && !cause) return res.status(400).json({ error: 'ข้อที่ไม่ปกติต้องระบุสาเหตุด้วย' });
    const qcBy = result ? String(b.qcBy || '').trim() : '';
    if (result && item.need_qc && !qcBy) {
      return res.status(400).json({ error: 'ข้อนี้ต้องตรวจร่วมกับ QC — ใส่ชื่อ QC ที่ตรวจด้วยกันก่อน' });
    }
    let photo = result ? (typeof b.photo === 'string' ? b.photo : '') : '';
    if (photo && !(photo.startsWith('http') || photo.startsWith('data:'))) {
      return res.status(400).json({ error: 'รูปไม่ถูกต้อง — ลองแนบใหม่อีกครั้ง' });
    }
    if (!photo && item.photo && result) photo = item.photo;     // ติ๊กซ้ำโดยไม่ได้ส่งรูปมา = เก็บรูปเดิมไว้

    await db.exec(
      `UPDATE run_check_items SET result = ?, cause = ?, photo = ?, photo_at = ?, checked_by = ?, qc_by = ?, updated_at = ?
        WHERE id = ?`,
      [result, cause || null, photo || null, photo ? nowBKK() : null,
        String(b.by || '').trim() || item.checked_by || null, qcBy || null, nowBKK(), item.id]);
    await db.exec('UPDATE run_checks SET updated_at = ? WHERE id = ?', [nowBKK(), checkId]);

    // คืนแค่ยอดสรุป ไม่คืนทั้งใบ — คนแตะหลายครั้งต่อกะบนเน็ตมือถือ (ลด egress เหมือนใบเช็ก AM)
    const rows = await dbAll('SELECT result FROM run_check_items WHERE check_id = ?', [checkId]);
    res.json({ success: true, summary: runCheckStatusOf(rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══ ข้อ "ไม่ปกติ" → ใบแจ้งซ่อม ════════════════════════════════════════════
   กติกาเดียวกับใบเช็ก AM ทุกข้อ (amOpenRepairs) ต่างแค่ที่มาของใบ — ทำตอนกดส่งเท่านั้น
   ไม่ใช่ตอนติ๊ก (ให้กรอกสาเหตุ + แนบรูปให้ครบก่อน ใบซ่อมที่เปิดไปแล้วแก้อาการทีหลังยาก)

   🔑 กันเปิดใบซ้ำด้วย ref_key = 'run:<ชื่อเครื่อง>:<ชื่อข้อ>' — ห้ามใส่วันที่/กะ/เลขรอบลงใน key
      ข้อเดิมของเครื่องเดิมที่ใบยังไม่ปิด = ใบเดียวกันเสมอ (เจอซ้ำ = ต่อบันทึกในใบเดิม)
   🔑 ใช้ "ชื่อข้อ" ที่ normAlias แล้ว ไม่ใช่ item_key — ข้อชื่อเดียวกันมาจากคนละกฎในแต่ละวันได้
      (mergeRuleItems ตัดข้อซ้ำด้วย normAlias ของชื่อ แล้วเก็บ key ของกฎที่จำเพาะกว่าไว้
       ถ้าผูกกับ item_key วันที่กฎเจาะจงไม่เข้า จะได้ใบใหม่ทั้งที่เป็นอาการเดิม)
      ⚠️ normAlias ตัดสระ/วรรณยุกต์ไทยทิ้ง ("ล้างหัวพิมพ์" → "ลางหวพมพ") — key อ่านไม่รู้เรื่อง
         ตั้งใจให้เป็นแบบนั้น: ต้องตัดซ้ำด้วยสูตรเดียวกับที่ใบเช็กใช้ตัดข้อซ้ำ ไม่งั้นเพี้ยนกัน
         และ ref_key ไม่เคยขึ้นหน้าจอ (หน้าเหตุการณ์โชว์ "ชิปที่มา" ไม่ใช่ key)                */
const runCheckRefKey = (machineName, title) =>
  `run:${machineName || ''}:${normAlias(title).slice(0, 60)}`;

async function runCheckOpenRepairs(check, rows, run, by) {
  const opened = [], repeated = [];
  const when = `${check.work_day} ${check.shift || ''}`.trim();
  const timingLabel = RULE_TIMING_LABEL[check.timing] || check.timing || '';
  for (const r of rows.filter((x) => x.result === 'ng')) {
    const refKey = runCheckRefKey(check.machine_name, r.title || '');
    const cur = (await dbAll(
      "SELECT id, symptom FROM incidents WHERE ref_key = ? AND COALESCE(status, 'open') <> 'closed' ORDER BY id DESC",
      [refKey]))[0];
    const cause = String(r.cause || '').trim();
    if (cur) {
      // ไม่เปิดใบใหม่ — ต่อบันทึกลงใบเดิม แล้วเด้งการ์ดในกลุ่มให้เห็นว่าเจอซ้ำ
      const add = `\n— เจอซ้ำ ${when} (${timingLabel}) โดย ${by || 'ไม่ระบุ'}: ${cause}`;
      await db.exec('UPDATE incidents SET symptom = ?, updated_at = ? WHERE id = ?',
        [String(cur.symptom || '') + add, nowBKK(), cur.id]);
      await bumpRepairCard(cur.id);
      repeated.push({ id: cur.id, title: r.title || '' });
      continue;
    }
    // รูปต้องเป็น URL เท่านั้น (photoJson ทิ้ง data: ทิ้ง) — อัปโหลดไม่ผ่านก็เปิดใบโดยไม่มีรูป
    const imgs = r.photo && String(r.photo).startsWith('http') ? [r.photo] : [];
    const inc = await createIncidentRow({
      title: String(r.title || '').trim() || 'พบสิ่งผิดปกติระหว่างเดินเครื่อง',
      machine: check.machine_name || null,
      lineName: (run && run.line_name) || null,
      operator: by || null,
      occurredAt: check.work_day,
      symptom: `[เช็กลิสต์เดินเครื่อง ${when} · ${timingLabel}`
        + (run && run.flavor ? ` · ${run.flavor}` : '') + `] ${cause}`,
      images: imgs, priority: 'warn', source: 'runcheck', refKey,
    });
    opened.push({ id: inc.id, title: r.title || '' });
  }
  return { opened, repeated };
}

/* การ์ดสรุปตอนส่งใบ — ใช้เครื่องเรนเดอร์ตัวเดียวกับใบเช็ก AM (หน้าตาเหมือนกันทุกอย่าง
   ต่างแค่ข้อความหัวการ์ด) · โชว์ข้อไม่ปกติได้ 4 ข้อ ที่เหลือสรุปเป็นตัวเลข
   ⚠️ เลขใบแจ้งซ่อมต้องอยู่ใน caption (ข้อความในรูปค้นหาย้อนหลังไม่ได้) */
async function sendRunCheckCard(check, rows, by, repairs = { opened: [], repeated: [] }) {
  const run = await dbGet('SELECT * FROM machine_runs WHERE id = ?', [check.run_id]);
  const labelOf = await labelMap();
  const machine = labelOf.get(check.machine_name) || check.machine_name || '—';
  const timingLabel = RULE_TIMING_LABEL[check.timing] || check.timing || '';
  const ngRows = rows.filter((r) => r.result === 'ng');
  const sum = runCheckStatusOf(rows);

  const caption = [
    `📋 <b>เช็กลิสต์เดินเครื่อง — ${escapeHtml(machine)}</b>`,
    `${escapeHtml(timingLabel)} · ${escapeHtml(check.work_day)} · ${escapeHtml(check.shift || '')}`
      + (run && run.flavor ? ` · ${escapeHtml(run.flavor)}` : ''),
    `✅ ปกติ ${sum.ok}　⚠️ ไม่ปกติ ${sum.ng}　รวม ${sum.total} ข้อ · โดย ${escapeHtml(by || '-')}`,
    repairs.opened.length
      ? `🆘 เปิดใบแจ้งซ่อมใหม่ ${repairs.opened.length} ใบ: ${repairs.opened.map((x) => '#' + x.id).join(' ')}` : '',
    repairs.repeated.length
      ? `🔁 เจอซ้ำ ต่อในใบเดิม ${repairs.repeated.length} ใบ: ${repairs.repeated.map((x) => '#' + x.id).join(' ')}` : '',
  ].filter(Boolean).join('\n');

  // ข้อความสำรอง — sendMessage จำกัด 4096 ตัวอักษร ไล่ข้อไม่ปกติได้สูงสุด 10 ข้อ
  const L = [caption];
  if (ngRows.length) {
    L.push('', '<b>ข้อที่ไม่ปกติ</b>');
    for (const it of ngRows.slice(0, 10)) {
      L.push(`• ${escapeHtml(it.title)}`);
      L.push(`　${escapeHtml(String(it.cause || '').slice(0, 160))}`);
    }
    if (ngRows.length > 10) L.push(`… และอีก ${ngRows.length - 10} ข้อ (ดูในแอป)`);
  }

  await inTopic('runcheck', async () => {
    let png = null;
    if (canRenderCard()) {
      const shown = ngRows.slice(0, 4);
      const uris = (await Promise.allSettled(shown.map((x) => fetchAsDataUri(x.photo))))
        .map((r) => (r.status === 'fulfilled' ? r.value : null));
      try {
        png = renderAmSheetCardPNG({
          eyebrow: 'เช็กลิสต์เดินเครื่อง',
          line: machine,
          dateLabel: thaiDate(check.work_day),
          shiftLabel: `${check.shift || ''} · ${timingLabel}`,
          lineStatus: '',
          total: sum.total, ok: sum.ok, ng: sum.ng,
          ngItems: shown.map((x, i) => ({ seq: i + 1, title: x.title, cause: x.cause || '', uri: uris[i] })),
          openedCount: repairs.opened.length, repeatedCount: repairs.repeated.length, by,
        });
      } catch (e) { console.error('[run-check] เรนเดอร์การ์ดไม่สำเร็จ', e.message); png = null; }
    }
    if (png) return sendPhotoBufferToTelegram(png, 'image/png', caption);
    return sendToTelegram(L.join('\n'));
  });
}

/* ส่งใบ — ปิดใบแล้วล็อก
   ต้องตอบครบทุกข้อก่อน · ข้อที่ "ไม่ปกติ" ต้องมีสาเหตุครบ
   กดส่งครั้งเดียวเกิด 3 อย่าง: ล็อกใบ · เปิด/ต่อใบแจ้งซ่อมของข้อที่ไม่ปกติ · การ์ดสรุปเข้ากลุ่มช่าง */
app.post('/api/run-check/submit', async (req, res) => {
  if (rateLimited(req.ip, 30, 60000, 'runcheck-submit')) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  const b = req.body || {};
  try {
    const checkId = Number(b.checkId || 0);
    if (!checkId) return res.status(400).json({ error: 'checkId จำเป็น' });
    const check = await dbGet('SELECT * FROM run_checks WHERE id = ?', [checkId]);
    if (!check) return res.status(404).json({ error: 'ไม่พบใบเช็กนี้' });
    if ((check.status || 'draft') === 'submitted') return res.status(409).json({ error: 'ใบนี้ส่งไปแล้ว' });
    const rows = await dbAll('SELECT * FROM run_check_items WHERE check_id = ? ORDER BY id', [checkId]);
    if (!rows.length) return res.status(400).json({ error: 'ใบนี้ไม่มีข้อให้ตรวจ' });
    const left = rows.filter((r) => r.result !== 'ok' && r.result !== 'ng');
    if (left.length) return res.status(400).json({ error: `ยังตรวจไม่ครบ เหลืออีก ${left.length} ข้อ` });
    const noCause = rows.filter((r) => r.result === 'ng' && !String(r.cause || '').trim());
    if (noCause.length) return res.status(400).json({ error: `ข้อที่ไม่ปกติต้องกรอกสาเหตุให้ครบก่อน (เหลือ ${noCause.length} ข้อ)` });

    await db.exec(
      "UPDATE run_checks SET status = 'submitted', submitted_by = ?, submitted_at = ?, updated_at = ? WHERE id = ?",
      [String(b.by || '').trim() || null, nowBKK(), nowBKK(), checkId]);
    const sum = runCheckStatusOf(rows);

    /* การ์ดสรุปเข้ากลุ่มช่าง — รูปของข้อที่ไม่ปกติต้องอยู่ในการ์ดด้วย
       ตัวเลขอย่างเดียวบอกไม่ได้ว่า "ไม่ปกติ" ที่เจอหน้าตาเป็นยังไง
       ⚠️ ข้อความในรูปค้นหาไม่ได้ → เลขที่ต้องใช้ค้นย้อนหลังต้องอยู่ใน caption ด้วย
       เรนเดอร์รูปไม่ได้ → ถอยไปข้อความธรรมดา บอทต้องไม่เงียบเพราะเรื่องหน้าตา */
    /* ข้อที่ "ไม่ปกติ" เปิดใบแจ้งซ่อมให้เอง · เจอซ้ำ = ต่อในใบเดิม ไม่เปิดใบใหม่
       ⚠️ ล้มเหลวต้องไม่ทำให้ "ส่งใบ" พัง — ใบถูกล็อกไปแล้วตั้งแต่บรรทัดบน ตอบ error กลับไป
          คนจะกดส่งซ้ำไม่ได้ (เจอ 409) แล้วใบค้างแบบไม่มีใครรู้ว่ามีอะไรต้องซ่อม */
    const run = await dbGet('SELECT * FROM machine_runs WHERE id = ?', [check.run_id]);
    let repairs = { opened: [], repeated: [] };
    try { repairs = await runCheckOpenRepairs(check, rows, run, String(b.by || '').trim()); }
    catch (e) { console.error('[run-check] เปิดใบแจ้งซ่อมไม่สำเร็จ', e.message); }

    try { await sendRunCheckCard(check, rows, String(b.by || '').trim(), repairs); }
    catch (e) { console.error('[run-check] แจ้งกลุ่มไม่สำเร็จ', e.message); }

    res.json({
      success: true, summary: sum,
      ng: rows.filter((r) => r.result === 'ng').map((r) => ({ itemKey: r.item_key, title: r.title, cause: r.cause || '' })),
      opened: repairs.opened, repeated: repairs.repeated,
      check: { id: checkId, status: 'submitted', submittedBy: String(b.by || '').trim(), submittedAt: nowBKK() },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ลิงก์ปักหมุดในกลุ่ม — 1 เครื่อง 1 token ใช้ซ้ำได้ตลอด (แพทเทิร์นเดียวกับ am_sheet_links)
   เรียกซ้ำได้คืน token เดิม — ไม่งั้นลิงก์ที่ปักหมุดไว้ในกลุ่มจะตายทุกครั้งที่มีคนกดปุ่ม */
app.post('/api/run-check/link', requireRole('supervisor'), async (req, res) => {
  const machineName = String((req.body || {}).machineName || '').trim();
  if (!machineName) return res.status(400).json({ error: 'machineName จำเป็น' });
  try {
    const m = await dbGet("SELECT name FROM machines WHERE name = ? AND active = 1 AND grp = 'packer'", [machineName]);
    if (!m) return res.status(400).json({ error: `"${machineName}" ไม่ใช่เครื่องบรรจุในทะเบียน` });
    const { token, url } = await runCheckLinkFor(machineName, (req.who && req.who.name) || '');
    res.json({ success: true, token, url: url || `/?runcheck=${token}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══ การ์ดเตือนเช็กลิสต์เดินเครื่อง → กลุ่มช่าง ══════════════════════════════════
   ยิง 1 การ์ดต่อ (รอบ × จังหวะ) พร้อมปุ่มเปิดเช็กลิสต์บนมือถือ

   จังหวะที่ยิง (นับเป็นนาทีจากเที่ยงคืนของ "วันทำงาน" — กะดึกจึงเลย 24:00 ไปได้)
     ⏱ ก่อนเริ่มบรรจุ   = เริ่มกะ + 15 นาที
     ⚙️ ระหว่างเดินเครื่อง = กลางกะ
     🏁 หลังบรรจุจบ      = ก่อนจบกะ 60 นาที **หรือ** มีคนกดปุ่ม 🏁 ปิดงานบรรจุ — อันไหนถึงก่อน
        (เคาะกับ user 14 ก.ย. · ปุ่มคือตัวหลัก นาฬิกาคือตาข่ายกันลืม)

   🔴 จองคีย์ `run:{id}:{timing}` ใน run_notify_log ก่อนส่งเสมอ — กดปุ่มแล้วนาฬิกามาถึงทีหลัง
      ต้องไม่ยิงซ้ำ (แพทเทิร์นเดียวกับ pm_notify_log)
   🔴 เกาะ tick เดิมที่มีอยู่ ห้ามเพิ่ม setInterval ใหม่ — เคยชนโควตา Render มาแล้ว
   🔴 ไม่มีกฎเข้า = ไม่ยิงอะไรเลย · รอบที่ยังไม่ยืนยัน = ไม่ยิง (เงียบดีกว่าส่งการ์ดเปล่า)
   ══════════════════════════════════════════════════════════════════════════════ */

const RUN_NOTIFY_LATE_MIN = 90;   // เลยเวลาที่ควรยิงเกินเท่านี้ = สายเกินจะมีประโยชน์ เงียบไว้ดีกว่า

// ช่วงเวลาของกะนั้นในหน่วย "นาทีจากเที่ยงคืนของวันทำงาน" (กะดึก 22–06 → 1320–1800)
function runShiftWindow(workDay, shiftName) {
  const key = String(shiftName || '').replace(/^กะ/, '');
  const s = amShift.shiftsForWeekday(amShift.weekdayOf(workDay)).find((x) => x.key === key);
  if (!s) return null;
  return { startMin: s.start * 60, endMin: (s.end > s.start ? s.end : s.end + 24) * 60 };
}

// เวลาปัจจุบันในหน่วยเดียวกัน — ก่อน 06:00 ยังเป็นวันทำงานเมื่อวาน จึงบวก 24 ชม.
function runNowMin(bkk) {
  const h = Number(bkk.slice(11, 13)), m = Number(bkk.slice(14, 16));
  return (h < 6 ? h + 24 : h) * 60 + m;
}

// นาทีที่ควรยิงของแต่ละจังหวะ · null = จังหวะนี้ไม่มีเวลาตายตัว (ไม่มีในตารางกะ)
function runNotifyAt(win, timing) {
  if (!win) return null;
  if (timing === 'start') return win.startMin + 15;
  if (timing === 'during') return Math.round((win.startMin + win.endMin) / 2);
  if (timing === 'end') return win.endMin - 60;
  return null;
}

/* ลิงก์เช็กลิสต์ของเครื่อง — ใช้ร่วมกันระหว่างปุ่มในหน้า Admin กับการ์ดที่บอทยิง
   เรียกซ้ำได้ token เดิมเสมอ (ลิงก์ที่ปักหมุดในกลุ่มต้องไม่ตาย) */
async function runCheckLinkFor(machineName, by = '') {
  let row = await dbGet('SELECT token FROM run_check_links WHERE machine_name = ? AND active = 1', [machineName]);
  if (!row) {
    const token = newToken();
    await db.exec(
      'INSERT INTO run_check_links (token, machine_name, created_by, created_at, active) VALUES (?, ?, ?, ?, 1)',
      [token, machineName, by || null, nowBKK()]);
    row = { token };
  }
  /* 🪤 ต้องเป็น PUBLIC_APP_URL เท่านั้น (ตัวเดียวกับลิงก์ใบเช็ก AM) — ห้ามใช้ PUBLIC_WEB_URL
     ตัวนั้นตั้งเป็นโดเมน Render ที่ใช้เป็น HTTP-Referer ของ AI ลิงก์จะพาไปเจอ "Cannot GET /" */
  const base = String(process.env.PUBLIC_APP_URL || APP_PUBLIC_URL || '').replace(/\/+$/, '');
  return { token: row.token, url: base ? `${base}/?runcheck=${row.token}` : '' };
}

/* ข้อความการ์ด + ปุ่ม — คืน null เมื่อ "ไม่มีอะไรต้องบอก"
   ⚠️ ข้อความในรูปค้นหาไม่ได้ การ์ดนี้จึงเป็นข้อความล้วน + ปุ่มลิงก์ (ไม่ใช่ PNG)
      PNG ใช้กับ "การ์ดสรุปตอนส่งใบ" ที่คนอ่านทีเดียวจบเท่านั้น                        */
async function buildRunNotify(run, timing) {
  const rules = matchRules(await activeRules(), run).filter((r) => (r.timing || 'start') === timing);
  const items = mergeRuleItems(rules);
  if (!items.length) return null;

  const labelOf = await labelMap();
  const machine = labelOf.get(run.packer_name) || run.packer_name || '—';
  const line = run.line_name ? (labelOf.get(run.line_name) || run.line_name) : '';
  const roles = [...new Set(rules.map((r) => ROLE_LABEL[r.owner_role] || '').filter(Boolean))].join(' + ');

  const L = [
    `🔔 <b>${escapeHtml(RULE_TIMING_LABEL[timing])} — ${escapeHtml(machine)}</b>`,
    `${escapeHtml(thaiDate(run.work_day))} · ${escapeHtml(run.shift || '')} · <b>${escapeHtml(run.flavor || '')}</b>`
      + (line ? ` · ป้อนจาก ${escapeHtml(line)}` : ''),
    roles ? `👤 ${escapeHtml(roles)}` : '',
    '',
  ].filter((x) => x !== '');
  for (const it of items.slice(0, 8)) {
    L.push(`• ${escapeHtml(it.title)}`
      + (it.needPhoto ? ' 📷' : '') + (it.needQc ? ' 🧪' : ''));
  }
  if (items.length > 8) L.push(`… และอีก ${items.length - 8} ข้อ`);

  const { url } = await runCheckLinkFor(run.packer_name);
  return {
    text: L.join('\n'),
    nItems: items.length,
    keyboard: url ? [[{ text: '📋 เปิดเช็กลิสต์', url: `${url}&runId=${run.id}&timing=${timing}` }]] : null,
  };
}

/* ยิงจริง — จองคีย์ก่อนเสมอ ชนแล้วออกเงียบ ๆ (แปลว่ารอบนี้ส่งไปแล้ว)
   force = ปุ่มลองส่งจากหน้า Admin — ไม่แตะคีย์ของรอบจริง                                */
async function fireRunNotify(run, timing, { force = false } = {}) {
  const key = `run:${run.id}:${timing}`;
  if (!force) {
    try { await db.exec('INSERT INTO run_notify_log (key, sent_at) VALUES (?, ?)', [key, nowBKK()]); }
    catch { return { skipped: 'sent' }; }
  }
  const card = await buildRunNotify(run, timing);
  if (!card) {
    /* ไม่มีกฎเข้า = ไม่มีอะไรต้องบอก — 🔴 ต้องคืนคีย์ที่จองไว้ด้วย
       ไม่งั้นกฎที่เพิ่มทีหลังในช่วงเวลาเดิมจะไม่มีวันยิง เพราะคีย์ถูกเผาไปแล้วแบบเงียบ ๆ */
    if (!force) await db.exec('DELETE FROM run_notify_log WHERE key = ?', [key]).catch(() => {});
    return { skipped: 'norules' };
  }
  try {
    await inTopic('runcheck', async () => {
      const chatId = tgChatId();
      if (!chatId) return;
      await tgApi('sendMessage', {
        chat_id: chatId, text: card.text, parse_mode: 'HTML',
        ...(card.keyboard ? { reply_markup: { inline_keyboard: card.keyboard } } : {}),
      });
    });
  } catch (e) { console.error('[run-notify] ส่งไม่สำเร็จ', e.message); return { skipped: 'senderr' }; }
  console.log(`[run-notify] ${key} ส่งเข้ากลุ่มช่างแล้ว (${card.nItems} ข้อ)`);
  return { sent: true, nItems: card.nItems };
}

/* เกาะ tick เดิม (ทุก 1 นาที) — ห้ามเพิ่ม loop ใหม่
   เดินเฉพาะรอบของ "วันทำงานปัจจุบัน" ที่ยืนยันแล้ว — รอบที่ยังเป็นร่างแปลว่าคนยังไม่รับรอง
   ว่าวันนี้เดินตามนี้จริง ยิงไปก็เป็นการรบกวน                                              */
async function runNotifyTick(atStr) {
  try {
    const cfg = await getReportConfig();
    if (!cfg.runNotifyEnabled) return;
    const bkk = atStr || new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const workDay = Number(bkk.slice(11, 13)) < 6 ? addDaysStr(bkk.slice(0, 10), -1) : bkk.slice(0, 10);
    const nowMin = runNowMin(bkk);

    const runs = await dbAll(
      `SELECT * FROM machine_runs
        WHERE work_day = ? AND packer_name <> '' AND COALESCE(status, 'draft') IN ('confirmed', 'done')`,
      [workDay]).catch(() => []);
    if (!runs.length) return;

    // อ่านกฎครั้งเดียวต่อ tick แล้วจับคู่ในหน่วยความจำ — tick เดินทุกนาที
    // ถ้าเรียก buildRunNotify (3-4 คิวรี่) ทุก รอบ×จังหวะ จะกลายเป็นร้อยคิวรี่ต่อนาที
    const rules = await activeRules();

    for (const run of runs) {
      const win = runShiftWindow(run.work_day, run.shift);
      if (!win) continue;                       // กะที่ไม่มีในตารางกะ (เช่น OT) — ไม่มีเวลาตายตัวให้ยิง
      const hits = matchRules(rules, run);
      for (const timing of RULE_TIMING) {
        // รอบที่ปิดงานแล้วยิง "หลังบรรจุจบ" ไปตอนกดปุ่มแล้ว — ตรงนี้ข้ามให้คีย์กันซ้ำจัดการ
        const at = runNotifyAt(win, timing);
        if (at == null) continue;
        if (nowMin < at || nowMin > at + RUN_NOTIFY_LATE_MIN) continue;
        if (!mergeRuleItems(hits.filter((r) => (r.timing || 'start') === timing)).length) continue;
        await fireRunNotify(run, timing);
      }
    }
  } catch (e) { console.error('[run-notify] tick error', e.message); }
}

/* สวิตช์เปิด/ปิดการ์ดอัตโนมัติ — แยกเส้นเฉพาะ ไม่ยิงผ่าน /api/report/config
   🪤 เส้นนั้นเขียนทับ auto_enabled/times/weekdays จาก body ตรง ๆ ไม่มี fallback
      ส่งไปแค่ฟิลด์เดียวจะล้างตารางส่งรายงานประจำวันทิ้งแบบเงียบ ๆ */
app.get('/api/machine-runs/notify-switch', async (req, res) => {
  try { res.json({ enabled: (await getReportConfig()).runNotifyEnabled }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/machine-runs/notify-switch', requireRole('supervisor'), async (req, res) => {
  try {
    const cfg = await getReportConfig();
    const on = (req.body || {}).enabled ? 1 : 0;
    await db.exec('UPDATE report_config SET run_notify_enabled = ?, updated_at = ? WHERE id = ?', [on, nowBKK(), cfg.id]);
    invalidateReportConfig();
    res.json({ success: true, enabled: !!on });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ลองส่ง / ดูตัวอย่าง — ไม่แตะคีย์กันยิงซ้ำของรอบจริง
   preview: true = คืนข้อความเฉย ๆ ไม่ส่งเข้ากลุ่ม                                         */
app.post('/api/machine-runs/notify-test', requireRole('supervisor'), async (req, res) => {
  const b = req.body || {};
  try {
    const runId = Number(b.runId || 0);
    if (!runId) return res.status(400).json({ error: 'runId จำเป็น' });
    const run = await dbGet('SELECT * FROM machine_runs WHERE id = ?', [runId]);
    if (!run) return res.status(404).json({ error: 'ไม่พบรอบเดินเครื่องนี้' });
    const timing = RULE_TIMING.includes(String(b.timing || '')) ? String(b.timing) : 'start';
    const card = await buildRunNotify(run, timing);
    if (!card) {
      return res.json({ success: true, skipped: true, timing,
        message: 'ไม่มีกฎเข้ากับรอบนี้ในจังหวะนั้น — ถึงเวลาจริงระบบจะเงียบ ไม่ส่งการ์ดเปล่า' });
    }
    if (b.preview) return res.json({ success: true, timing, preview: card.text, nItems: card.nItems });
    const r = await fireRunNotify(run, timing, { force: true });
    res.json({ success: true, timing, sent: !!r.sent, preview: card.text, nItems: card.nItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── โน้ตเครื่องจักรใน vault (แผน KM ข้อ 4.1: 1 โน้ตต่อ 1 เครื่อง) ──────────────
// ระบบเป็นเจ้าของเฉพาะ "ในเขต marker" — นอกเขตคนเขียนเองได้ (spec/รูป/บันทึกช่าง) ไม่โดนทับ
const MACHINE_MARK = 'ข้อมูลเครื่องจักร';
const ROLE_LABEL = { mt: 'Maintenance', op: 'Operate', qc: 'QC', pd: 'พนักงานผลิต' };

function machineBlock(m, pmRows, incidents, links = [], rules = []) {
  const L = [];
  L.push('> [!info] ส่วนนี้ระบบเขียนให้อัตโนมัติจากหน้า “ทะเบียนเครื่องจักร” — แก้ในแอปแล้วตรงนี้อัปเดตตาม');
  L.push('');
  L.push('| | |', '| --- | --- |');
  L.push(`| รหัส | ${m.code || '—'} |`);
  L.push(`| ไลน์ | ${m.line_name || '—'} |`);
  L.push(`| วันที่ติดตั้ง | ${m.installed_at || '—'} |`);
  L.push(`| PM ล่าสุด | ${m.last_pm || '—'} |`);
  L.push('');
  if (m.note) L.push('### จุดที่มักมีปัญหา', '', m.note, '');
  L.push(`### งาน PM ประจำ (${pmRows.length})`, '');
  if (!pmRows.length) L.push('_ยังไม่มีงาน PM ที่ผูกกับเครื่องนี้_');
  else for (const r of pmRows) {
    L.push(`- **${r.title}** — 🎯 ${r.goal || '—'} · ผู้รับผิดชอบหลัก: ${ROLE_LABEL[r.owner_role] || '—'}`);
  }
  L.push('');
  /* คู่ไลน์ ↔ เครื่องบรรจุ — โน้ตของเครื่องต้องตอบได้ว่า "ตัวนี้ทำงานคู่กับอะไร ผลิตอะไร"
     ชี้ฝั่งตรงข้ามด้วย [[wikilink]] เพื่อให้กราฟใน Obsidian เห็นเส้นเชื่อมจริง ๆ ไม่ใช่ข้อความลอย */
  L.push(`### คู่ไลน์ ↔ เครื่องบรรจุ (${links.length})`, '');
  if (!links.length) L.push('_ยังไม่ได้ผูกคู่ไว้ในผังเชื่อมโยง_');
  else for (const k of links) {
    const other = k.lineName === m.name ? k.packerName : k.lineName;
    const side = k.lineName === m.name ? 'ป้อนเข้า' : 'รับจาก';
    const prods = (k.products || []).map(p => p.flavor).filter(Boolean);
    L.push(`- ${side} ${vault.machineLink(other)}`
      + (prods.length ? ` — 🧃 ${prods.join(' · ')}` : ' — _ยังไม่ได้ผูกสินค้าประจำคู่_')
      + (k.note ? ` · ${k.note}` : ''));
  }
  L.push('');
  /* กฎเตือน — ช่างที่เปิดโน้ตเครื่องต้องเห็นว่า "เครื่องนี้ถึงเวลาแล้วระบบจะสั่งอะไร"
     ไล่ข้อในกฎออกมาด้วย เพราะข้อพวกนี้คือเนื้องานจริงที่ไปโผล่ในเช็กลิสต์มือถือ */
  L.push(`### กฎเตือนที่ผูกกับเครื่องนี้ (${rules.length})`, '');
  if (!rules.length) L.push('_ยังไม่มีกฎเตือนที่เข้าเงื่อนไขเครื่องนี้_');
  else for (const r of rules) {
    let items = [];
    try { items = JSON.parse(r.items || '[]'); } catch { items = []; }
    const cond = [
      r.product_pattern ? `เฉพาะสินค้า ${r.product_pattern}` : '',
      r.line_name && r.line_name !== m.name ? `คู่กับ ${r.line_name}` : '',
      r.packer_name && r.packer_name !== m.name ? `คู่กับ ${r.packer_name}` : '',
      r.shift || '',
    ].filter(Boolean).join(' · ');
    L.push(`- **${r.title}** — ⏱ ${RULE_TIMING_LABEL[r.timing] || r.timing || ''} · ${items.length} ข้อ`
      + (cond ? ` · ${cond}` : ''));
    for (const it of Array.isArray(items) ? items : []) {
      L.push(`    - ${it.title}${it.needQc ? ' · ร่วม QC' : ''}${it.needPhoto ? ' · ต้องแนบรูป' : ''}`);
    }
  }
  L.push('');
  const open = incidents.filter(i => (i.status || 'open') !== 'closed').length;
  // เวลาที่เครื่องนี้หยุดไปแล้วทั้งหมด (นับเฉพาะที่กรอกครบทั้งเวลาหยุดและเวลากลับมาเดิน)
  const mins = incidents.map(i => downMinutes(i.down_from, i.down_to)).filter(m => m != null);
  const stillDown = incidents.filter(i => i.down_from && !i.down_to).length;
  if (mins.length || stillDown) {
    const total = mins.reduce((a, b) => a + b, 0);
    L.push('### เวลาที่เครื่องหยุด', '');
    L.push(`- รวม **${downLabel(total)}** จาก ${mins.length} ครั้ง`
      + (mins.length ? ` · เฉลี่ยครั้งละ ${downLabel(Math.round(total / mins.length))}` : ''));
    if (stillDown) L.push(`- 🔴 ยังหยุดอยู่ ${stillDown} รายการ (ยังไม่ได้กรอกเวลากลับมาเดิน)`);
    L.push('');
  }
  L.push(`### เหตุการณ์ที่เคยเกิด (${incidents.length}${open ? ` · ยังไม่ปิด ${open}` : ''})`, '');
  if (!incidents.length) L.push('_ยังไม่มีเหตุการณ์ที่บันทึกไว้_');
  else for (const i of incidents) {
    const file = String(i.vault_path || '').replace(/^.*\//, '').replace(/\.md$/, '');
    const label = `${i.occurred_at || ''} ${i.title}`.trim();
    const m = downMinutes(i.down_from, i.down_to);
    const dt = m != null ? ` — ⏱ ${downLabel(m)}` : (i.down_from ? ' — 🔴 ยังหยุดอยู่' : '');
    L.push(`- ${(i.status || 'open') === 'closed' ? '✅' : '🔸'} ${file ? `[[${file}|${label}]]` : label}${dt}`);
  }
  return L.join('\n');
}
function machineSkeleton(m, region) {
  return [
    '---', `title: ${m.name}`, 'tags: [เครื่องจักร]', 'ที่มา: SPP-MP', '---', '',
    `# ${m.name}`, '', region, '', '## บันทึกของช่าง', '',
    '_เขียนอะไรตรงนี้ก็ได้ ระบบไม่แตะส่วนนี้_', '',
  ].join('\n');
}
// เขียน/อัปเดตโน้ตของเครื่องหนึ่ง · คืน {path} | {error} | {skipped} ไม่โยน error ออกไป
async function syncMachineNote(m) {
  if (!vault.vaultEnabled()) return { skipped: 'ยังไม่ได้ตั้งค่า vault' };
  const path = vault.machinePath(m.name);
  try {
    const pmRows = await dbAll(
      'SELECT title, goal, owner_role FROM duty_routines WHERE active = 1 AND machine = ? ORDER BY sort_order, id', [m.name]);
    const incidents = await dbAll(
      `SELECT title, occurred_at, status, vault_path, down_from, down_to
         FROM incidents WHERE machine = ? ORDER BY occurred_at DESC, id DESC`, [m.name]);
    // คู่ + กฎ ใช้คิวรี่ตัวเดียวกับหน้ารายละเอียดเครื่อง — โน้ตกับหน้าเว็บจะได้ไม่เล่าคนละเรื่อง
    const links = await linksOf(m);
    const rules = await dbAll(
      `SELECT * FROM machine_rules WHERE active = 1 AND deleted = 0 AND (packer_name = ? OR line_name = ?)
        ORDER BY specificity DESC, id`, [m.name, m.name]);
    const body = machineBlock(m, pmRows, incidents, links, rules);
    let existing = null;
    try { const r = await vault.vaultRead(path); existing = r && r.content ? r.content : null; } catch { existing = null; }
    const content = existing && vault.hasMarker(existing, MACHINE_MARK)
      ? vault.replaceMarked(existing, MACHINE_MARK, body)
      : existing
        ? vault.replaceMarked(existing, MACHINE_MARK, body)      // ไฟล์มีอยู่แต่ยังไม่มีเขต → ต่อท้าย
        : machineSkeleton(m, vault.replaceMarked('', MACHINE_MARK, body).trimEnd());
    await vault.vaultWrite(path, content, `เครื่องจักร: ${m.name}`);
    if (m.vault_path && m.vault_path !== path) {
      try { await vault.vaultDelete(m.vault_path, `ย้ายชื่อไฟล์เครื่องจักร: ${m.vault_path} → ${path}`); }
      catch { /* ไฟล์เก่าหายไปแล้วก็ช่าง */ }
    }
    await db.exec('UPDATE machines SET vault_path = ? WHERE id = ?', [path, m.id]);
    return { path };
  } catch (e) {
    console.error('[vault] เขียนโน้ตเครื่องจักรไม่สำเร็จ', m.name, e.message);
    return { error: e.message };
  }
}
/* แตะโน้ตของหลายเครื่องพร้อมกัน — ใช้ตอนแก้ "คู่" หรือ "กฎ" ซึ่งกระทบเครื่อง 2 ตัวเสมอ
   (แก้คู่แล้วโน้ตของอีกฝั่งต้องอัปเดตด้วย ไม่งั้นโน้ตฝั่งหนึ่งบอกว่าคู่กันอยู่ อีกฝั่งไม่รู้เรื่อง)
   ชื่อซ้ำ/ว่างถูกตัดทิ้งเอง — เขียนโน้ตเครื่องเดิม 2 รอบในคำขอเดียวเปลืองเปล่า ๆ */
const touchMachineNotes = (...names) => {
  for (const n of [...new Set(names.filter(Boolean))]) touchMachineNote(n);
};
// อัปเดตโน้ตของเครื่องหนึ่งแบบไม่ให้ผู้ใช้รอ (ใช้ตอนบันทึก/ลบเหตุการณ์ — รายการเหตุการณ์ในโน้ตจะได้ตรง)
function touchMachineNote(name) {
  if (!name || !vault.vaultEnabled()) return;
  dbAll('SELECT * FROM machines WHERE name = ? AND active = 1', [name])
    .then(rows => (rows[0] ? syncMachineNote(rows[0]) : null))
    .catch(e => console.error('[vault] touchMachineNote', e.message));
}

// รูปแนบของเหตุการณ์เก็บเป็น JSON string (ใช้ได้ทั้ง SQLite และ Postgres เหมือน blocks/tags ของบทความ)
const jsonList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const photoJson = (v) => JSON.stringify((Array.isArray(v) ? v : []).filter(u => typeof u === 'string' && u.startsWith('http')).slice(0, 8));

// ที่มาของใบแจ้งซ่อม — ต้องตรงกับ migration ด้านบนและชิปที่มาในหน้าเหตุการณ์
const INC_SOURCES = new Set(['web', 'bot', 'ai', 'amsheet', 'runcheck']);
const incSource = (v, dflt) => (INC_SOURCES.has(v) ? v : dflt);

// ── เหตุการณ์ ────────────────────────────────────────────────────────────────
// โน้ตใน vault ใช้เทมเพลตตาม "แผนพัฒนา ERP และ KM" ข้อ 4.2 เป๊ะ (อาการ/สาเหตุ/วิธีแก้/ผล/เกี่ยวข้อง)
// เขียนทับทั้งไฟล์ทุกครั้ง — ระบบเป็นเจ้าของไฟล์นี้ ต่างจากบันทึกประจำวันที่แตะแค่ในเขต marker
// เขียนโน้ตลง vault — ล้มเหลวไม่ทำให้บันทึกในแอปพัง (คืนเหตุผลไปให้หน้าเว็บบอกผู้ใช้แทน)
async function syncIncident(inc) {
  if (!vault.vaultEnabled()) return { skipped: 'ยังไม่ได้ตั้งค่า vault' };
  const path = vault.incidentPath(inc);
  try {
    await vault.vaultWrite(path, vault.incidentMarkdown(inc), `เหตุการณ์: ${inc.title || path}`);
    if (inc.vault_path && inc.vault_path !== path) {
      try { await vault.vaultDelete(inc.vault_path, `ย้ายชื่อไฟล์เหตุการณ์: ${inc.vault_path} → ${path}`); } catch { /* ไฟล์เก่าหายไปแล้วก็ช่าง */ }
    }
    return { path };
  } catch (e) { console.error('[vault] เขียนเหตุการณ์ไม่สำเร็จ', e.message); return { error: e.message }; }
}

// ── เวลาเครื่องหยุด (downtime) ────────────────────────────────────────────────
// รับเฉพาะรูปแบบ 'YYYY-MM-DDTHH:MM' (ค่าจาก <input type="datetime-local">) — อย่างอื่นทิ้ง
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const cleanDt = (v) => (typeof v === 'string' && DT_RE.test(v.trim()) ? v.trim() : null);
// คิดเลขบน wall clock (ใส่ Z เข้า-ออก) เลี่ยง timezone ของเซิร์ฟเวอร์ที่ไม่ใช่ไทย
const downMinutes = (from, to) => {
  if (!cleanDt(from) || !cleanDt(to)) return null;
  const m = Math.round((Date.parse(`${to}:00Z`) - Date.parse(`${from}:00Z`)) / 60000);
  return Number.isFinite(m) && m >= 0 ? m : null;   // กรอกกลับหลัง = ถือว่ายังไม่ได้กรอก
};
// "2 ชม. 15 น." — ใช้ทั้งในโน้ต vault และข้อความ Telegram
function downLabel(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} ชม.${m ? ` ${m} น.` : ''}` : `${m} น.`;
}

/* ── รายชื่อคอลัมน์ที่หน้าเหตุการณ์ต้องใช้ ─────────────────────────────────
   ระบุคอลัมน์เองแทน SELECT * เพราะของแพงจริงคือ images/symptom/cause/fix/result
   ที่เป็นข้อความยาวและถูกลากมาทุกแถวทุกครั้ง (ไม่ใช่จำนวนแถว)                 */
const INC_COLS = `id, title, machine, line_name, batch_id, operator, occurred_at,
  symptom, cause, fix, result, status, priority, assignee, images, result_images,
  vault_path, down_from, down_to, source, ref_key, card_chat_id, card_msg_id`;

// แถวดิบ → รูปแบบที่หน้าเว็บใช้ · ฟิลด์เดิมทุกตัวชื่อเดิมเป๊ะ ห้ามเปลี่ยน (client เก่ายังใช้อยู่)
function incidentDto(r) {
  return {
    id: r.id, title: r.title, machine: r.machine || '', line: r.line_name || '',
    batchId: r.batch_id || '', operator: r.operator || '', occurredAt: r.occurred_at || '',
    symptom: r.symptom || '', cause: r.cause || '', fix: r.fix || '', result: r.result || '',
    images: jsonList(r.images), resultImages: jsonList(r.result_images),
    status: r.status || 'open', vaultPath: r.vault_path || '',
    downFrom: r.down_from || '', downTo: r.down_to || '',
    downtimeMin: downMinutes(r.down_from, r.down_to),
    // ── ใหม่ (หน้าเหตุการณ์ 2 แท็บ) ──
    priority: r.priority || '',
    assignee: r.assignee || '',
    assigneeName: r.assignee ? dutyName(r.assignee) : '',   // client ไม่มี map person_key → ชื่อ
    source: r.source || '',
    refKey: r.ref_key || '',
    // ยังหยุดอยู่ = มีเวลาเริ่มแต่ไม่มีเวลากลับมาเดิน · นับให้จากฝั่งเซิร์ฟเวอร์ ไม่พึ่งนาฬิกา client
    downSoFarMin: r.down_from && !r.down_to ? downSoFar(r) : null,
    hasCard: !!(r.card_chat_id && r.card_msg_id),          // ไม่ส่ง chat id ออกไปนอกระบบ
  };
}

/* GET /api/incidents
     ?scope=queue  งานซ่อมที่ยังไม่ปิด เรียงตามความเร่งด่วนแบบเดียวกับกระดานในบอท
     ?scope=km     คลังความรู้ (ปิดแล้ว) เรียงตามวันที่ + แบ่งหน้า
     ?status=open|closed  ของเดิม ห้ามถอด — ยังมีผู้เรียกอยู่
   summary มาในก้อนเดียวกัน ไม่แยก endpoint เพราะถ้าแยกจะเกิด race:
   กดปิดงานแล้วสองคำขอกลับมาไม่พร้อมกัน ตัวเลขหัวหน้ากับลิสต์จะไม่ตรงกันชั่วขณะ            */
app.get('/api/incidents', async (req, res) => {
  const { status, scope } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    let rows, total = null, hasMore = false;
    if (scope === 'queue') {
      rows = await dbAll(`SELECT ${INC_COLS} FROM incidents WHERE COALESCE(status, 'open') <> 'closed'`, []);
      // เรียงใน JS เพราะลำดับความเร่งด่วนอยู่ใน SR_PRIO ไม่ใช่ใน SQL — สำนวนเดียวกับ buildRepairList
      rows.sort((a, b) => (srPrio(a.priority).order - srPrio(b.priority).order) || (b.id - a.id));
    } else if (scope === 'km') {
      rows = await dbAll(
        `SELECT ${INC_COLS} FROM incidents WHERE status = 'closed'
           ORDER BY occurred_at DESC, id DESC LIMIT ${limit + 1} OFFSET ${offset}`, []);
      hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);
    } else if (status === 'open' || status === 'closed') {
      rows = await dbAll(
        `SELECT ${INC_COLS} FROM incidents WHERE status = ? ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`, [status]);
    } else {
      rows = await dbAll(
        `SELECT ${INC_COLS} FROM incidents ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`, []);
    }

    /* ตัวเลขหัวทั้ง 2 แท็บ — สแกนทั้งตารางแต่เลือกเฉพาะคอลัมน์แคบ
       รวมยอดใน JS ไม่ใช่ใน SQL ตามธรรมเนียมโปรเจกต์ (เลี่ยงสำนวนที่ SQLite/Postgres เขียนไม่เหมือนกัน) */
    const all = await dbAll(
      'SELECT id, status, priority, machine, cause, fix, down_from, down_to FROM incidents', []);
    const q = { stop: 0, warn: 0, low: 0, open: 0, wip: 0, total: 0, downNowCount: 0, downNowMin: 0 };
    const km = { closed: 0, gaps: 0, machines: 0 };
    const kmMachines = new Set();
    for (const r of all) {
      const st = r.status || 'open';
      if (st === 'closed') {
        km.closed += 1;
        if (!r.cause || !r.fix) km.gaps += 1;          // ปิดแล้วแต่ค้นไปก็ไม่ได้คำตอบ
        if (r.machine) kmMachines.add(r.machine);
        continue;
      }
      q.total += 1;
      q[srPrio(r.priority) === SR_PRIO.stop ? 'stop' : srPrio(r.priority) === SR_PRIO.low ? 'low' : 'warn'] += 1;
      if (st === 'wip') q.wip += 1; else q.open += 1;
      if (r.down_from && !r.down_to) {
        q.downNowCount += 1;
        q.downNowMin += downSoFar(r) || 0;
      }
    }
    km.machines = kmMachines.size;
    if (scope === 'km') total = km.closed;

    res.json({
      incidents: rows.map(incidentDto),
      openCount: q.total,                              // ฟิลด์เดิม ห้ามถอด
      summary: { queue: q, km },
      total, hasMore,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* บันทึก/แก้ไขเหตุการณ์จากหน้าเว็บ
   🔑 กติกา "เขียนทับเฉพาะ key ที่ส่งมา" (presence-aware)
   เดิม handler นี้ประกอบ row ขึ้นมาใหม่ทุกฟิลด์แล้วยิง UPDATE ทั้งแถว ทำให้ค่าที่ "อีกประตูหนึ่ง"
   เขียนไว้หายเงียบเมื่อหน้าเว็บไม่รู้จักฟิลด์นั้น — เจอจริง 2 เคส:
     1. status: เดิม normalize เป็น open/closed เท่านั้น → ใบที่ช่างกดรับในบอท ('wip') พอหัวหน้า
        กดแก้ไขจากเว็บจะเด้งกลับเป็น 'รอรับงาน' ทั้งที่ช่างรับไปแล้ว (assignee ยังค้างอยู่)
     2. down_to: client ส่งค่าว่างมา → เวลาที่บอทเติมให้ตอนปิดงานถูกล้าง สรุปเวลาเครื่องหยุดเพี้ยน
   ตอนนี้: ไม่ส่ง key มา = คงค่าเดิมไว้ · ส่งมา (แม้เป็นค่าว่าง) = ตั้งใจเปลี่ยน                */
app.post('/api/incidents', async (req, res) => {
  const b = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const isNew = !b.id;
  if (isNew && !String(b.title || '').trim()) return res.status(400).json({ error: 'title จำเป็น' });
  if (has('title') && !String(b.title || '').trim()) return res.status(400).json({ error: 'title จำเป็น' });
  // รับเฉพาะ URL — ถ้าอัปโหลดขึ้น Supabase ไม่สำเร็จ client จะส่ง data: กลับมา ซึ่งห้ามลง DB
  const badPhoto = [...(Array.isArray(b.images) ? b.images : []), ...(Array.isArray(b.resultImages) ? b.resultImages : [])]
    .some(u => typeof u === 'string' && !u.startsWith('http'));
  if (badPhoto) return res.status(400).json({ error: 'อัปโหลดรูปไม่สำเร็จ (ยังไม่ได้ URL) — ลองแนบรูปใหม่อีกครั้ง' });
  try {
    let id = b.id, cur = null;
    if (id) {
      cur = (await dbAll('SELECT * FROM incidents WHERE id = ?', [id]))[0];
      if (!cur) return res.status(404).json({ error: 'ไม่พบเหตุการณ์นี้' });
    }
    // keep(key, ค่าใหม่, ค่าเดิม) — หัวใจของกติกาข้างบน
    const keep = (k, next, old) => (has(k) ? next : (old === undefined ? null : old));
    const row = {
      title: has('title') ? String(b.title).trim() : (cur ? cur.title : ''),
      machine: keep('machine', b.machine || null, cur && cur.machine),
      line_name: keep('line', b.line || null, cur && cur.line_name),
      batch_id: keep('batchId', b.batchId || null, cur && cur.batch_id),
      operator: keep('operator', b.operator || null, cur && cur.operator),
      occurred_at: keep('occurredAt', b.occurredAt || todayBKK(), cur && cur.occurred_at) || todayBKK(),
      symptom: keep('symptom', b.symptom || null, cur && cur.symptom),
      cause: keep('cause', b.cause || null, cur && cur.cause),
      fix: keep('fix', b.fix || null, cur && cur.fix),
      result: keep('result', b.result || null, cur && cur.result),
      // รับ 'wip' ด้วย (SR_STATUS) — ค่าที่ไม่รู้จักถือว่าไม่ได้ตั้งใจเปลี่ยน คงของเดิมไว้
      status: has('status') && SR_STATUS[b.status] ? b.status : ((cur && cur.status) || 'open'),
      priority: has('priority') ? (SR_PRIO[b.priority] ? b.priority : null) : (cur ? cur.priority : null),
      assignee: keep('assignee', b.assignee || null, cur && cur.assignee),
      images: keep('images', photoJson(b.images), cur && cur.images),
      result_images: keep('resultImages', photoJson(b.resultImages), cur && cur.result_images),
      down_from: keep('downFrom', cleanDt(b.downFrom), cur && cur.down_from),
      down_to: keep('downTo', cleanDt(b.downTo), cur && cur.down_to),
      // ที่มาของใบเปลี่ยนไม่ได้ตามนิยาม — ตอนแก้ไขจึงไม่แตะ 2 ช่องนี้เลย
      source: incSource(b.source, 'web'),
      ref_key: b.refKey || null,
    };
    // เวลากลับมาเดินอยู่ก่อนเวลาหยุด = พิมพ์ผิดแน่ ๆ — ไม่รับ ไม่งั้นได้แถวที่คิดนาทีไม่ได้ค้างในสรุป
    // เช็กบนค่าที่จะลงจริง (หลัง keep) ไม่ใช่บน body — ส่งมาแค่ downTo ก็ต้องเทียบกับ down_from เดิม
    if (row.down_from && row.down_to && downMinutes(row.down_from, row.down_to) == null) {
      return res.status(400).json({ error: 'เวลากลับมาเดินอยู่ก่อนเวลาที่เครื่องหยุด — ตรวจเวลาอีกครั้ง' });
    }
    const prevPath = cur ? (cur.vault_path || null) : null;
    const prevMachine = cur ? (cur.machine || null) : null;
    if (id) {
      await db.exec(
        `UPDATE incidents SET title = ?, machine = ?, line_name = ?, batch_id = ?, operator = ?,
           occurred_at = ?, symptom = ?, cause = ?, fix = ?, result = ?, status = ?,
           priority = ?, assignee = ?,
           images = ?, result_images = ?, down_from = ?, down_to = ?, updated_at = ? WHERE id = ?`,
        [row.title, row.machine, row.line_name, row.batch_id, row.operator, row.occurred_at,
         row.symptom, row.cause, row.fix, row.result, row.status, row.priority, row.assignee,
         row.images, row.result_images, row.down_from, row.down_to, nowBKK(), id]);
    } else {
      const r = await dbRun(
        `INSERT INTO incidents (title, machine, line_name, batch_id, operator, occurred_at,
           symptom, cause, fix, result, status, priority, assignee,
           images, result_images, down_from, down_to, source, ref_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.title, row.machine, row.line_name, row.batch_id, row.operator, row.occurred_at,
         row.symptom, row.cause, row.fix, row.result, row.status, row.priority, row.assignee,
         row.images, row.result_images, row.down_from, row.down_to,
         row.source, row.ref_key, nowBKK(), nowBKK()]);
      id = r.lastID;
    }
    const sync = await syncIncident({ ...row, id, vault_path: prevPath });
    if (sync.path) await db.exec('UPDATE incidents SET vault_path = ? WHERE id = ?', [sync.path, id]);
    // รายการ "เหตุการณ์ที่เคยเกิด" ในโน้ตเครื่องจักรต้องตามให้ทัน (ทั้งเครื่องใหม่และเครื่องเดิมถ้าย้าย)
    touchMachineNote(row.machine);
    if (prevMachine && prevMachine !== row.machine) touchMachineNote(prevMachine);
    // การ์ดในกลุ่มมี title/machine/symptom/สถานะอยู่ด้วย — แก้จากเว็บแล้วต้องตามให้ทัน
    const card = await bumpRepairCard(id);
    res.json({
      success: true, id, card,
      vaultPath: sync.path || null, vaultError: sync.error || null, vaultSkipped: sync.skipped || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ลบเหตุการณ์ทิ้ง (บันทึกผิด/ซ้ำ) — ลบทั้งแถวใน DB และไฟล์โน้ตใน vault
// ลบจริง ไม่ใช่ soft delete: โน้ตที่ค้างอยู่ในวอลต์โดยไม่มีของคู่กันในแอปจะสับสนกว่า
app.post('/api/incidents/delete', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const cur = (await dbAll('SELECT * FROM incidents WHERE id = ?', [id]))[0];
    if (!cur) return res.status(404).json({ error: 'ไม่พบเหตุการณ์นี้' });
    let vaultError = null;
    if (cur.vault_path && vault.vaultEnabled()) {
      try { await vault.vaultDelete(cur.vault_path, `ลบโน้ตเหตุการณ์: ${cur.vault_path}`); }
      catch (e) { vaultError = e.message; }        // ไฟล์หายไปแล้วก็ลบแถวต่อได้
    }
    await db.exec('DELETE FROM incidents WHERE id = ?', [id]);
    touchMachineNote(cur.machine);
    res.json({ success: true, removedVault: cur.vault_path || null, vaultError });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══════════ คำสั่งกับใบแจ้งซ่อมจากหน้าเว็บ (มอบหมาย / ปิดงาน / เปิดใหม่) ═══════════
   ทำไมเป็น endpoint แยก ไม่ใช้ POST /api/incidents:
     1. คนละความหมาย — ตัวนั้นคือ "บันทึกฟอร์ม" ตัวนี้คือ "คำสั่ง" ที่มีเงื่อนไขก่อนทำ
     2. กฎ "ปิดงานต้องกรอกวิธีแก้" ถ้าเอาไปยัดในฟอร์ม จะกลายเป็นห้ามบันทึกใบที่ปิดแล้ว
        ซึ่งพังใบเก่าที่ปิดไปโดยไม่มี fix ทันทีที่ใครกดแก้ไข
     3. ปิดงานต้องเติม down_to ให้เองถ้าเครื่องยังหยุดอยู่ — เป็นกฎของการปิดเท่านั้น
     4. บอทมีเส้นนี้อยู่แล้ว (m:take / m:csave) — แยกออกมาแล้วลอกลำดับ 5 ขั้นเดียวกันเป๊ะ
        (UPDATE → อ่านแถวใหม่ → syncIncident → touchMachineNote → bumpRepairCard)
        ทำให้ "หนึ่งพฤติกรรม สองประตูหน้า" ยังจริงอยู่
   ⚠️ เส้นพวกนี้สั่งการไปถึงกลุ่ม Telegram ได้ ซึ่งเป็นความเสี่ยงชนิดที่ของเดิมไม่มี → ใส่ rate limit */

// ทีมช่างสำหรับ dropdown มอบหมาย — เดิมหน้าเว็บไม่มีทางรู้ person_key ของช่างเลย
app.get('/api/maint/people', async (req, res) => {
  try {
    const rows = await dbAll(
      "SELECT person_key, name, tg_user_id FROM duty_people WHERE kind = 'maint' AND active = 1 ORDER BY sort_order, person_key", []);
    res.json({ people: rows.map(r => ({ key: r.person_key, name: r.name || r.person_key, bound: !!r.tg_user_id })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ลำดับหลังเขียน DB ที่ทุกคำสั่งต้องทำเหมือนกัน — ห้ามประกอบ object เอง ต้องอ่านแถวใหม่ทั้งแถว
// (syncIncident อ่าน vault_path เดิมเพื่อลบไฟล์เก่าตอนชื่อโน้ตเปลี่ยน ถ้าส่งไม่ครบจะได้ path ผิด)
async function afterIncidentCommand(id, { sync = true } = {}) {
  const fresh = await getIncident(id);
  let vaultPath = null, vaultError = null;
  if (sync && fresh) {
    const r = await syncIncident(fresh);
    if (r.path) { vaultPath = r.path; await db.exec('UPDATE incidents SET vault_path = ? WHERE id = ?', [r.path, id]); }
    vaultError = r.error || null;
  }
  if (fresh) touchMachineNote(fresh.machine);
  const card = await bumpRepairCard(id);
  return { incident: fresh ? incidentDto(await getIncident(id)) : null, card, vaultPath, vaultError };
}

/* มอบหมายช่าง — assignee ว่าง = ถอนมอบหมาย
   ต่างจากปุ่ม 🙋 รับงาน ในบอทโดยเจตนา: บอทบล็อกถ้าใบถูกรับไปแล้ว (กันช่าง 2 คนแย่งใบ)
   แต่หัวหน้าต้องเปลี่ยนตัวช่างได้ จึงไม่บล็อก · โน้ตวอลต์ไม่มีช่อง assignee เลยไม่ต้อง sync */
app.post('/api/incidents/assign', async (req, res) => {
  if (rateLimited(req.ip, 60, 60000, 'incident-cmd')) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  const { id } = req.body || {};
  const assignee = String((req.body || {}).assignee || '').trim();
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const cur = await getIncident(id);
    if (!cur) return res.status(404).json({ error: 'ไม่พบใบงานนี้' });
    if ((cur.status || 'open') === 'closed') {
      return res.status(409).json({ error: 'ใบนี้ปิดไปแล้ว — กดเปิดใหม่ก่อนถึงจะมอบหมายได้' });
    }
    if (assignee) {
      const ok = await dbAll(
        "SELECT person_key FROM duty_people WHERE kind = 'maint' AND active = 1 AND person_key = ?", [assignee]);
      if (!ok.length) return res.status(400).json({ error: 'ไม่พบช่างคนนี้ในทีมซ่อมบำรุง' });
    }
    await db.exec('UPDATE incidents SET status = ?, assignee = ?, updated_at = ? WHERE id = ?',
      [assignee ? 'wip' : 'open', assignee || null, nowBKK(), id]);
    res.json({ success: true, ...(await afterIncidentCommand(id, { sync: false })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ปิดงาน — ลอกลำดับจากปุ่ม ✅ ปิดงาน ในบอท (m:csave)
   บังคับกรอก "วิธีแก้" เพราะใบที่ปิดโดยไม่มี fix ค้นเจอแล้วไม่ได้คำตอบ = ไม่มีค่าทาง KM */
app.post('/api/incidents/close', async (req, res) => {
  if (rateLimited(req.ip, 60, 60000, 'incident-cmd')) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ error: 'id จำเป็น' });
  const fix = String(b.fix || '').trim();
  if (!fix) return res.status(400).json({ error: 'ต้องกรอก "วิธีแก้" ก่อนปิดงาน — ครั้งหน้าเจออีกจะได้รู้ว่าแก้ยังไง' });
  const imgs = Array.isArray(b.resultImages) ? b.resultImages : null;
  if (imgs && imgs.some(u => typeof u !== 'string' || !u.startsWith('http'))) {
    return res.status(400).json({ error: 'อัปโหลดรูปไม่สำเร็จ (ยังไม่ได้ URL) — ลองแนบรูปใหม่อีกครั้ง' });
  }
  try {
    const cur = await getIncident(b.id);
    if (!cur) return res.status(404).json({ error: 'ไม่พบใบงานนี้' });
    // ปิดซ้ำต้องไม่พัง — คนกดสองครั้งเพราะเน็ตช้าเกิดขึ้นจริง
    if ((cur.status || 'open') === 'closed') {
      return res.json({ success: true, alreadyClosed: true, ...(await afterIncidentCommand(b.id, { sync: false })) });
    }
    // เครื่องที่ยังหยุดอยู่ → ปิดเวลาหยุด ณ ตอนกดปิดงาน (แก้ย้อนหลังได้ในฟอร์ม) เหมือนที่บอททำ
    const downTo = cleanDt(b.downTo) || (cur.down_from && !cur.down_to ? nowBKK().slice(0, 16) : cur.down_to);
    if (cur.down_from && downTo && downMinutes(cur.down_from, downTo) == null) {
      return res.status(400).json({ error: 'เวลากลับมาเดินอยู่ก่อนเวลาที่เครื่องหยุด — ตรวจเวลาอีกครั้ง' });
    }
    await db.exec(
      `UPDATE incidents SET status = 'closed', fix = ?, cause = ?, result = ?,
         result_images = ?, down_to = ?, updated_at = ? WHERE id = ?`,
      [fix,
       b.cause !== undefined ? (String(b.cause).trim() || null) : cur.cause,
       b.result !== undefined ? (String(b.result).trim() || null) : cur.result,
       imgs ? photoJson(imgs) : cur.result_images,
       downTo || null, nowBKK(), b.id]);
    const done = await afterIncidentCommand(b.id);
    // การ์ดบทเรียนไม่ควรถ่วง/ล้มการปิดงาน — ส่งไม่ผ่านก็แค่ไม่มีใบสรุปเด้งในกลุ่ม
    postLessonCard(b.id).catch(() => {});
    res.json({ success: true, ...done });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* เปิดใหม่ — ใบที่ยังมีช่างถืออยู่ให้กลับไปเป็น "กำลังซ่อม" ไม่ใช่เด้งเป็น "รอรับงาน"
   (ไม่งั้นช่างที่รับไว้หายจากใบโดยไม่มีใครสั่ง) · โน้ตวอลต์มีบรรทัดสถานะ จึงต้อง sync */
app.post('/api/incidents/reopen', async (req, res) => {
  if (rateLimited(req.ip, 60, 60000, 'incident-cmd')) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const cur = await getIncident(id);
    if (!cur) return res.status(404).json({ error: 'ไม่พบใบงานนี้' });
    await db.exec('UPDATE incidents SET status = ?, updated_at = ? WHERE id = ?',
      [cur.assignee ? 'wip' : 'open', nowBKK(), id]);
    res.json({ success: true, ...(await afterIncidentCommand(id)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══════════ ต้นทุนรวมต่อ batch (ERP เฟส 3 — ส่วนที่เหลือ) ══════════
   ต้นทุน 1 batch = ค่าวัสดุที่เบิกไปใช้ + ค่าเสียโอกาสจากเวลาที่เครื่องหยุด
   ผูกกันด้วย "เลข batch" ที่คนกรอก: material_moves.batch_ref ↔ incidents.batch_id
   (เทียบแบบตัดช่องว่างและไม่สนตัวพิมพ์ใหญ่เล็ก — คนพิมพ์ CIP-88 กับ cip-88 ต้องเป็นก้อนเดียวกัน) */
const batchKey = (v) => String(v || '').trim().toUpperCase();

async function costRates() {
  const cfg = await dbGet('SELECT * FROM cost_config ORDER BY id LIMIT 1', []) || {};
  const machines = await dbAll('SELECT name, downtime_cost FROM machines WHERE active = 1', []);
  const perMachine = {};
  for (const m of machines) if (m.downtime_cost != null && m.downtime_cost !== '') perMachine[m.name] = num(m.downtime_cost);
  return { base: num(cfg.downtime_per_hour), perMachine };
}
const rateFor = (rates, machine) => (rates.perMachine[machine] != null ? rates.perMachine[machine] : rates.base);

app.get('/api/cost/config', async (req, res) => {
  try {
    const cfg = await dbGet('SELECT * FROM cost_config ORDER BY id LIMIT 1', []) || {};
    const machines = await dbAll('SELECT id, name, downtime_cost FROM machines WHERE active = 1 ORDER BY sort_order, id', []);
    res.json({
      downtimePerHour: round2(cfg.downtime_per_hour),
      note: cfg.note || '',
      machines: machines.map(m => ({ id: m.id, name: m.name, downtimeCost: m.downtime_cost == null ? null : round2(m.downtime_cost) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ตั้งอัตรา — ค่ากลาง และ/หรือ ค่าเฉพาะเครื่อง (ส่ง machineId + downtimeCost=null เพื่อกลับไปใช้ค่ากลาง)
app.post('/api/cost/config', requireRole('supervisor'), async (req, res) => {
  const b = req.body || {};
  try {
    if (b.downtimePerHour != null) {
      const row = await dbGet('SELECT id FROM cost_config ORDER BY id LIMIT 1', []);
      const v = Math.max(0, num(b.downtimePerHour));
      if (row) await db.exec('UPDATE cost_config SET downtime_per_hour = ?, updated_at = ? WHERE id = ?', [v, nowBKK(), row.id]);
      else await db.exec('INSERT INTO cost_config (downtime_per_hour, updated_at) VALUES (?, ?)', [v, nowBKK()]);
    }
    if (b.machineId) {
      const v = b.downtimeCost == null || b.downtimeCost === '' ? null : Math.max(0, num(b.downtimeCost));
      await db.exec('UPDATE machines SET downtime_cost = ? WHERE id = ?', [v, b.machineId]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ต้นทุนรายก้อน batch ในช่วงเวลา — วัสดุ + เวลาเสีย
async function buildCostRange(from, to) {
  {
    const rates = await costRates();
    const moves = await dbAll(
      `SELECT mv.batch_ref, mv.qty, mv.unit_cost, mv.moved_at, m.name, m.unit
         FROM material_moves mv LEFT JOIN materials m ON m.id = mv.material_id
        WHERE mv.kind = 'out' AND mv.batch_ref IS NOT NULL AND mv.batch_ref <> ''
          AND mv.moved_at >= ? AND mv.moved_at <= ?`, [`${from}T00:00`, `${to}T23:59`]);
    const incidents = await dbAll(
      `SELECT title, machine, batch_id, occurred_at, down_from, down_to, status
         FROM incidents WHERE batch_id IS NOT NULL AND batch_id <> ''`, []);

    const box = {};   // key = เลข batch แบบตัดช่องว่าง/ตัวพิมพ์
    const get = (raw) => {
      const k = batchKey(raw);
      return box[k] || (box[k] = {
        batchRef: String(raw).trim(), materialCost: 0, materialItems: 0,
        downtimeMin: 0, downtimeCost: 0, incidents: 0, openDowntime: 0,
        firstAt: '', machines: [],
      });
    };
    for (const r of moves) {
      const b = get(r.batch_ref);
      b.materialCost += num(r.qty) * num(r.unit_cost);
      b.materialItems += 1;
      if (!b.firstAt || String(r.moved_at) < b.firstAt) b.firstAt = String(r.moved_at || '');
    }
    for (const i of incidents) {
      // เหตุการณ์นับเข้าช่วงเวลาด้วยเวลาที่เครื่องหยุด (ไม่มีก็ใช้วันที่เกิด)
      const when = i.down_from || i.occurred_at || '';
      if (!(when >= from && when <= `${to}T23:59`)) continue;
      const b = get(i.batch_id);
      b.incidents += 1;
      const mins = downMinutes(i.down_from, i.down_to);
      if (mins == null) { if (i.down_from) b.openDowntime += 1; }
      else {
        b.downtimeMin += mins;
        b.downtimeCost += (mins / 60) * rateFor(rates, i.machine);
      }
      if (i.machine && !b.machines.includes(i.machine)) b.machines.push(i.machine);
      if (!b.firstAt || String(when) < b.firstAt) b.firstAt = String(when);
    }
    const batches = Object.values(box).map(b => ({
      ...b,
      materialCost: round2(b.materialCost),
      downtimeCost: round2(b.downtimeCost),
      downtimeMin: Math.round(b.downtimeMin),
      total: round2(b.materialCost + b.downtimeCost),
    })).sort((a, b2) => b2.total - a.total);
    return {
      from, to, batches, rates: { base: rates.base, perMachine: rates.perMachine },
      totalMaterial: round2(batches.reduce((n, b) => n + b.materialCost, 0)),
      totalDowntime: round2(batches.reduce((n, b) => n + b.downtimeCost, 0)),
      totalCost: round2(batches.reduce((n, b) => n + b.total, 0)),
      // เตือนว่ายังคิดต้นทุนไม่ครบ: ของที่เบิกโดยไม่ระบุ batch + เวลาเสียที่ไม่ผูก batch
      unassignedMaterialCost: round2((await dbAll(
        `SELECT qty, unit_cost FROM material_moves
          WHERE kind = 'out' AND (batch_ref IS NULL OR batch_ref = '') AND moved_at >= ? AND moved_at <= ?`,
        [`${from}T00:00`, `${to}T23:59`])).reduce((n, r) => n + num(r.qty) * num(r.unit_cost), 0)),
    };
  }
}
app.get('/api/cost/batches', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  try { res.json(await buildCostRange(from, to)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// รายละเอียดของ batch เดียว — เบิกอะไรไปบ้าง เครื่องไหนหยุดกี่นาที
app.get('/api/cost/batch', async (req, res) => {
  const ref = batchKey(req.query.ref);
  if (!ref) return res.status(400).json({ error: 'ต้องระบุเลข batch' });
  try {
    const rates = await costRates();
    const moves = (await dbAll(
      `SELECT mv.*, m.name, m.unit FROM material_moves mv LEFT JOIN materials m ON m.id = mv.material_id
        WHERE mv.kind = 'out' AND mv.batch_ref IS NOT NULL AND mv.batch_ref <> ''
        ORDER BY mv.moved_at DESC`, []))
      .filter(r => batchKey(r.batch_ref) === ref)
      .map(r => ({
        id: r.id, name: r.name || '(ถูกลบแล้ว)', unit: r.unit || '', qty: round2(r.qty),
        unitCost: round2(r.unit_cost), cost: round2(num(r.qty) * num(r.unit_cost)),
        operator: r.operator || '', note: r.note || '', movedAt: r.moved_at,
      }));
    const incidents = (await dbAll(
      `SELECT id, title, machine, batch_id, occurred_at, down_from, down_to, status, vault_path
         FROM incidents WHERE batch_id IS NOT NULL AND batch_id <> '' ORDER BY occurred_at DESC`, []))
      .filter(r => batchKey(r.batch_id) === ref)
      .map(r => {
        const mins = downMinutes(r.down_from, r.down_to);
        return {
          id: r.id, title: r.title, machine: r.machine || '', status: r.status || 'open',
          occurredAt: r.occurred_at || '', downFrom: r.down_from || '', downTo: r.down_to || '',
          minutes: mins, ratePerHour: round2(rateFor(rates, r.machine)),
          cost: mins == null ? 0 : round2((mins / 60) * rateFor(rates, r.machine)),
        };
      });
    const materialCost = round2(moves.reduce((n, m) => n + m.cost, 0));
    const downtimeCost = round2(incidents.reduce((n, i) => n + i.cost, 0));
    res.json({
      batchRef: ref, moves, incidents, materialCost, downtimeCost,
      downtimeMin: incidents.reduce((n, i) => n + (i.minutes || 0), 0),
      total: round2(materialCost + downtimeCost),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════ คลังวัสดุ/สารเคมี (ERP เฟส 2) ══════════
   ทะเบียนของ + บันทึกเบิกใช้ต่อ batch + เตือนเมื่อใกล้หมด + ต้นทุนวัสดุต่อช่วงเวลา
   แก้ทะเบียน (เพิ่ม/แก้ราคา/จุดสั่งซื้อ) = หัวหน้างานขึ้นไป · เบิก-รับของ = ใครก็ได้ (ทำหน้างานทุกวัน) */
const MOVE_KINDS = ['out', 'in', 'adjust'];
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round2 = (n) => Math.round(num(n) * 100) / 100;
const matRow = (r) => ({
  id: r.id, code: r.code || '', name: r.name, unit: r.unit || '',
  stock: round2(r.stock), reorderPoint: round2(r.reorder_point), costPerUnit: round2(r.cost_per_unit),
  supplier: r.supplier || '', note: r.note || '',
  low: num(r.reorder_point) > 0 && num(r.stock) <= num(r.reorder_point),
  value: round2(num(r.stock) * num(r.cost_per_unit)),
});

app.get('/api/materials', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM materials WHERE active = 1 ORDER BY name', []);
    const materials = rows.map(matRow);
    res.json({
      materials,
      lowCount: materials.filter(m => m.low).length,
      totalValue: round2(materials.reduce((n, m) => n + m.value, 0)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// เพิ่ม/แก้ทะเบียนวัสดุ — ยอดคงเหลือแก้ที่นี่ไม่ได้ ต้องผ่าน /move เสมอ (ประวัติจะได้ไม่ขาด)
app.post('/api/materials', requireRole('supervisor'), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'ต้องมีชื่อวัสดุ' });
  const vals = [String(b.code || '').trim(), String(b.unit || '').trim() || 'หน่วย',
    Math.max(0, num(b.reorderPoint)), Math.max(0, num(b.costPerUnit)),
    String(b.supplier || '').trim(), String(b.note || '').trim(), nowBKK()];
  try {
    const cur = await dbGet('SELECT id FROM materials WHERE name = ?', [name]);
    if (cur) {
      await db.exec(`UPDATE materials SET code = ?, unit = ?, reorder_point = ?, cost_per_unit = ?,
        supplier = ?, note = ?, updated_at = ?, active = 1 WHERE name = ?`, [...vals, name]);
    } else {
      await db.exec(`INSERT INTO materials (code, unit, reorder_point, cost_per_unit, supplier, note, updated_at, name, stock, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, [...vals, name, nowBKK()]);
    }
    const row = await dbGet('SELECT * FROM materials WHERE name = ?', [name]);
    res.json({ success: true, material: matRow(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// เอาออกจากทะเบียน = ปิดการใช้งาน ไม่ลบจริง (ประวัติการเบิกยังต้องอ่านได้)
app.post('/api/materials/delete', requireRole('supervisor'), async (req, res) => {
  if (!req.body.id) return res.status(400).json({ error: 'ต้องมี id' });
  try {
    await db.exec('UPDATE materials SET active = 0, updated_at = ? WHERE id = ?', [nowBKK(), req.body.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// เบิกใช้ / รับเข้า / ปรับยอด — จุดเดียวที่ยอดคงเหลือเปลี่ยนได้
app.post('/api/materials/move', async (req, res) => {
  const b = req.body || {};
  const kind = MOVE_KINDS.includes(b.kind) ? b.kind : null;
  const qty = num(b.qty);
  if (!b.materialId || !kind) return res.status(400).json({ error: 'ต้องมี materialId และประเภทรายการ' });
  if (kind !== 'adjust' && qty <= 0) return res.status(400).json({ error: 'จำนวนต้องมากกว่า 0' });
  if (kind === 'adjust' && qty < 0) return res.status(400).json({ error: 'ยอดที่นับได้ติดลบไม่ได้' });
  try {
    const m = await dbGet('SELECT * FROM materials WHERE id = ?', [b.materialId]);
    if (!m) return res.status(404).json({ error: 'ไม่พบวัสดุนี้' });
    const before = num(m.stock);
    // ราคาต่อหน่วย: รับเข้าใช้ราคาที่กรอกมา (ถ้ามี) · เบิก/ปรับยอดใช้ราคาล่าสุดในทะเบียน
    const unitCost = kind === 'in' && b.unitCost != null && num(b.unitCost) > 0
      ? round2(b.unitCost) : round2(m.cost_per_unit);
    const after = kind === 'in' ? before + qty : kind === 'out' ? before - qty : qty;
    await db.exec(
      `INSERT INTO material_moves (material_id, kind, qty, unit_cost, balance_after, batch_ref, cip_batch_id, note, operator, moved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.id, kind, kind === 'adjust' ? round2(qty - before) : round2(qty), unitCost, round2(after),
       String(b.batchRef || '').trim().slice(0, 40) || null,
       b.cipBatchId ? Number(b.cipBatchId) : null,
       String(b.note || '').trim().slice(0, 200) || null,
       String(b.operator || '').trim().slice(0, 60) || null, nowBKK()]);
    // รับเข้าพร้อมราคาใหม่ = อัปเดตราคาล่าสุดในทะเบียนด้วย
    if (kind === 'in' && b.unitCost != null && num(b.unitCost) > 0) {
      await db.exec('UPDATE materials SET stock = ?, cost_per_unit = ?, updated_at = ? WHERE id = ?',
        [round2(after), unitCost, nowBKK(), m.id]);
    } else {
      await db.exec('UPDATE materials SET stock = ?, updated_at = ? WHERE id = ?', [round2(after), nowBKK(), m.id]);
    }
    // เตือนเฉพาะ "ตอนที่เพิ่งตกลงมาถึงจุดสั่งซื้อ" ไม่ใช่ทุกครั้งที่เบิกตอนของน้อยอยู่แล้ว
    const rp = num(m.reorder_point);
    const justCrossed = rp > 0 && before > rp && after <= rp;
    if (justCrossed && process.env.TELEGRAM_CHAT_ID) {
      notify('material', `⚠️ <b>วัสดุใกล้หมด</b>\n${escapeHtml(m.name)}\n\n`
        + `📦 เหลือ <b>${round2(after)} ${escapeHtml(m.unit || '')}</b> (จุดสั่งซื้อ ${rp} ${escapeHtml(m.unit || '')})\n`
        + (m.supplier ? `🏭 ผู้ขาย: ${escapeHtml(m.supplier)}\n` : '')
        + `✍️ ${escapeHtml(String(b.operator || 'ไม่ระบุ'))}`);
    }
    const row = await dbGet('SELECT * FROM materials WHERE id = ?', [m.id]);
    res.json({ success: true, material: matRow(row), alerted: justCrossed, negative: after < 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ประวัติความเคลื่อนไหว (ค่าเริ่มต้น 30 วันล่าสุด)
app.get('/api/materials/moves', async (req, res) => {
  const today = todayBKK();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from
    : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  try {
    const rows = await dbAll(
      `SELECT mv.*, m.name AS material_name, m.unit AS material_unit
         FROM material_moves mv LEFT JOIN materials m ON m.id = mv.material_id
        WHERE mv.moved_at >= ? AND mv.moved_at <= ?
        ORDER BY mv.moved_at DESC, mv.id DESC`, [`${from}T00:00`, `${to}T23:59`]);
    const pick = req.query.materialId ? Number(req.query.materialId) : null;
    const moves = rows.filter(r => !pick || r.material_id === pick).map(r => ({
      id: r.id, materialId: r.material_id, name: r.material_name || '(ถูกลบแล้ว)', unit: r.material_unit || '',
      kind: r.kind, qty: round2(r.qty), unitCost: round2(r.unit_cost), balanceAfter: round2(r.balance_after),
      cost: r.kind === 'out' ? round2(num(r.qty) * num(r.unit_cost)) : 0,
      batchRef: r.batch_ref || '', note: r.note || '', operator: r.operator || '', movedAt: r.moved_at,
    }));
    res.json({ from, to, moves: moves.slice(0, 300), total: moves.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ต้นทุนวัสดุที่เบิกใช้ในช่วงเวลา — รายวัสดุ / รายวัน / ราย batch
async function buildMaterialUsage(from, to) {
  {
    const rows = await dbAll(
      `SELECT mv.material_id, mv.qty, mv.unit_cost, mv.moved_at, mv.batch_ref, m.name, m.unit
         FROM material_moves mv LEFT JOIN materials m ON m.id = mv.material_id
        WHERE mv.kind = 'out' AND mv.moved_at >= ? AND mv.moved_at <= ?`, [`${from}T00:00`, `${to}T23:59`]);
    const byMat = {}, byDay = {}, byBatch = {};
    for (const r of rows) {
      const cost = num(r.qty) * num(r.unit_cost);
      const day = String(r.moved_at || '').slice(0, 10);
      const name = r.name || '(ถูกลบแล้ว)';
      const mm = byMat[name] || (byMat[name] = { name, unit: r.unit || '', qty: 0, cost: 0, times: 0 });
      mm.qty += num(r.qty); mm.cost += cost; mm.times += 1;
      byDay[day] = round2((byDay[day] || 0) + cost);
      if (r.batch_ref) {
        const bb = byBatch[r.batch_ref] || (byBatch[r.batch_ref] = { batchRef: r.batch_ref, cost: 0, items: 0 });
        bb.cost += cost; bb.items += 1;
      }
    }
    const materials = Object.values(byMat)
      .map(m => ({ ...m, qty: round2(m.qty), cost: round2(m.cost) })).sort((a, b) => b.cost - a.cost);
    return {
      from, to, materials,
      byDay: Object.entries(byDay).map(([date, cost]) => ({ date, cost })).sort((a, b) => a.date.localeCompare(b.date)),
      byBatch: Object.values(byBatch).map(b => ({ ...b, cost: round2(b.cost) })).sort((a, b) => b.cost - a.cost).slice(0, 20),
      totalCost: round2(materials.reduce((n, m) => n + m.cost, 0)),
      totalMoves: rows.length,
    };
  }
}
app.get('/api/materials/summary', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  try { res.json(await buildMaterialUsage(from, to)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── สรุปเวลาเครื่องหยุด (ERP เฟส 3) ─────────────────────────────────────────
// ช่วงเวลา = อิง down_from (เวลาที่เริ่มหยุด) ไม่ใช่วันที่บันทึกเหตุการณ์
// รวมยอดในโค้ดไม่ใช่ใน SQL — ข้อมูลหลักร้อยแถว และเลี่ยงฟังก์ชันวันที่ที่ SQLite/Postgres เขียนไม่เหมือนกัน
async function buildDowntimeRange(from, to) {
  {
    const all = await dbAll(
      `SELECT id, title, machine, occurred_at, status, vault_path, down_from, down_to
         FROM incidents ORDER BY down_from DESC, occurred_at DESC, id DESC`, []);
    const inRange = (dt) => dt && dt >= `${from}T00:00` && dt <= `${to}T23:59`;
    const rows = all.filter(r => inRange(r.down_from)).map(r => ({
      id: r.id, title: r.title, machine: r.machine || '', occurredAt: r.occurred_at || '',
      status: r.status || 'open', vaultPath: r.vault_path || '',
      downFrom: r.down_from, downTo: r.down_to || '', minutes: downMinutes(r.down_from, r.down_to),
    }));
    const byMachine = {};
    for (const r of rows) {
      const name = r.machine || 'ไม่ระบุเครื่อง';
      const m = byMachine[name] || (byMachine[name] = { name, count: 0, minutes: 0, openCount: 0, lastAt: '' });
      m.count += 1;
      if (r.minutes != null) m.minutes += r.minutes; else m.openCount += 1;   // ยังหยุดอยู่ = ยังไม่นับนาที
      if (r.downFrom > m.lastAt) m.lastAt = r.downFrom;
    }
    const machines = Object.values(byMachine)
      .map(m => ({ ...m, avgMin: m.count - m.openCount > 0 ? Math.round(m.minutes / (m.count - m.openCount)) : null }))
      .sort((a, b) => b.minutes - a.minutes || b.count - a.count);
    // เหตุการณ์ในช่วงที่ยังไม่ได้กรอกเวลาหยุดเลย — เตือนว่าตัวเลขยังไม่ครบ
    const missing = all.filter(r => !r.down_from && (r.occurred_at || '') >= from && (r.occurred_at || '') <= to).length;
    return {
      from, to, rows, machines, missing,
      totalCount: rows.length,
      totalMin: rows.reduce((n, r) => n + (r.minutes || 0), 0),
      openNow: all.filter(r => r.down_from && !r.down_to)
        .map(r => ({ id: r.id, title: r.title, machine: r.machine || '', downFrom: r.down_from })),
    };
  }
}
app.get('/api/maint/downtime', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  try { res.json(await buildDowntimeRange(from, to)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ทะเบียนงาน PM — งานประจำ "ทุกแถว" ของทีมซ่อมบำรุง (บอร์ดโชว์แค่ owner_role='mt')
app.get('/api/maint/routines', async (req, res) => {
  try {
    const people = getPeople().filter(p => (p.kind || 'shift') === 'maint');
    const keys = people.map(p => p.person_key);
    if (!keys.length) return res.json({ people: [], rows: [] });
    // งาน sheet='am' มี person_key = NULL (เป็นของไลน์+กะ) ต้องดึงมาด้วย ไม่งั้นทะเบียนหาย 45 แถว
    const rows = await dbAll(
      `SELECT id, person_key, node_key, title, machine, goal, method, owner_role, co_owner_role, sort_order, freq, sheet
         FROM duty_routines WHERE active = 1 AND (person_key IN (${keys.map(() => '?').join(',')}) OR sheet = 'am')
        ORDER BY sort_order, id`, keys);
    res.json({
      people: people.map(p => ({ key: p.person_key, name: p.name, role: p.role, color: p.color, initial: p.initial })),
      rows: rows.map(r => ({
        id: r.id, personKey: r.person_key, nodeKey: r.node_key, title: r.title,
        machine: r.machine || '', goal: r.goal || '', method: r.method || '',
        ownerRole: r.owner_role || '', coOwnerRole: r.co_owner_role || '', sortOrder: r.sort_order,
        freq: r.freq || '', sheet: r.sheet || '',
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── หน้ารวมงาน PM ในแอป ──────────────────────────────────────────────────
   งาน PM = งานที่วางแผนไว้ว่าจะทำวันไหน (บำรุงรักษา/ปรับปรุง/แก้ไข)
   เก็บใน daily_tasks category='pm' — คนละอย่างกับ "งานรูทีน" (duty_routines)
   บอทเห็นทีละหน้าจอ (เกินกำหนด + วันนี้ + ถัดไปแค่ 5) และ **แก้วันที่ไม่ได้**
   หน้านี้จึงเป็นที่เดียวที่เห็นทั้งก้อนล่วงหน้าและเลื่อนวันได้                      */
const PM_KIND_KEY = { 'บำรุงรักษา': 'pm', 'ปรับปรุง': 'up', 'แก้ไข': 'fix' };
// ชื่องานเก็บเป็น "<ประเภท> — <ทำอะไร>" (savePmTask เป็นคนประกอบ) แยกกลับมาให้ UI แก้ทีละช่อง
function splitPmTitle(t) {
  const s = String(t || '');
  const i = s.indexOf(' — ');
  const kind = i > 0 ? PM_KIND_KEY[s.slice(0, i)] : null;
  return kind ? { kind, what: s.slice(i + 3) } : { kind: '', what: s };   // ไม่รู้จักหัว = ถือว่าไม่มีประเภท ห้ามเดา
}
const pmTitleOf = (kind, what) =>
  (PM_KIND[kind] ? `${PM_KIND[kind].replace(/^\S+\s/, '')} — ` : '') + String(what || '').trim();
// เตือนล่วงหน้าเก็บเป็นเวลาเต็ม (remind_at) — แปลงกลับเป็นตัวเลือกที่ UI เข้าใจ
const pmRemindOf = (row) => !row.remind_at ? 'none'
  : (String(row.remind_at).slice(0, 10) < String(row.task_date) ? 'prev' : 'day');
const pmRemindAt = (date, remind) => remind === 'none' ? null
  : remind === 'prev' ? `${pmDateOfFrom(date, -1)}T08:00` : `${date}T08:00`;
const _pmDaysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function pmRowOut(r, today) {
  const { kind, what } = splitPmTitle(r.title);
  const date = String(r.task_date || '');
  return {
    id: r.id, date, title: r.title || '', kind, kindLabel: PM_KIND[kind] || '', what,
    machine: r.machine || '', assignee: r.assignee || '', assigneeName: r.assignee ? dutyName(r.assignee) : '',
    status: r.status || 'pending', dueTime: r.due_time || '', remind: pmRemindOf(r),
    createdBy: r.created_by || '', createdAt: r.created_at || '',
    completedAt: r.completed_at || '', doneBy: r.done_by || '',
    hasImages: !!Number(r.has_images), hasDoneImages: !!Number(r.has_done_images),
    lateDays: date && date < today ? _pmDaysBetween(date, today) : 0,
  };
}

/* ปิดงาน PM — ใช้ร่วมกันระหว่างบอทกับหน้าเว็บ
   ปิดแล้วขยับ "PM ล่าสุด" ในทะเบียนเครื่องจักรให้ด้วย ไม่งั้นต้องไปกรอกมือทุกครั้ง */
async function bumpMachineLastPm(name) {
  if (!name) return;
  try {
    const today = todayBKK();
    const m = await dbGet('SELECT id, last_pm FROM machines WHERE name = ? AND active = 1', [name]);
    if (!m || (m.last_pm && String(m.last_pm) >= today)) return;
    await db.exec('UPDATE machines SET last_pm = ? WHERE id = ?', [today, m.id]);
    touchMachineNote(name);
  } catch { /* ทะเบียนเครื่องจักรไม่พร้อมก็ไม่บล็อกการปิดงาน */ }
}
async function markPmDone(id, byName) {
  const row = await dbGet("SELECT * FROM daily_tasks WHERE id = ? AND category = 'pm'", [id]);
  if (!row) return null;
  await db.exec("UPDATE daily_tasks SET status = 'done', completed_at = ?, done_by = ? WHERE id = ?",
    [nowBKK(), byName || null, id]);
  await bumpMachineLastPm(row.machine);
  scheduleVaultTaskSync(row.task_date);
  return row;
}

/* ══════════════════════════════════════════════════════════════════════════
   แผน PM รายปี 52 สัปดาห์ — กระจกอ่านอย่างเดียวของแอปทีมช่าง (Netlify)
   ตัวดึงข้อมูล + ปฏิทิน ISO อยู่ที่ server/pmSync.js
   🔴 เส้นในหมวดนี้ "อ่านอย่างเดียว" ทั้งหมด ยกเว้น 3 เส้นท้าย
      (ลิสต์งานย่อย · ผู้รับผิดชอบ · ปุ่มดึงเดี๋ยวนี้) ซึ่งเป็นข้อมูลของแอปนี้เอง
   ปิดงาน / เลื่อนวัน / แก้แผน ทำที่แอปทีมช่างที่เดียว
   ══════════════════════════════════════════════════════════════════════════ */

// ชื่อพ้องที่ต้องมีแน่ ๆ — Netlify เขียน "ไลน์ต้ม 1" ทะเบียนเครื่องเขียน "Line ต้ม 1"
// (ทะเบียนงานรูทีน/ใบเช็ก AM ยึด "Line ต้ม N" อยู่แล้ว ห้ามแตกเป็นชื่อที่ 2)
const PM_ALIAS_SEED = [
  ['ไลน์ต้ม 1', 'Line ต้ม 1'], ['ไลน์ต้ม 2', 'Line ต้ม 2'],
  ['ไลน์ต้ม 3', 'Line ต้ม 3'], ['ไลน์ต้ม 4', 'Line ต้ม 4'],
];

// seed ชื่อพ้อง + เติมเครื่องที่แผน PM อ้างถึงแต่ยังไม่มีในทะเบียน (idempotent)
async function seedPmMachines() {
  try {
    for (const [alias, name] of PM_ALIAS_SEED) {
      const has = await dbGet('SELECT alias FROM machine_alias WHERE alias = ?', [alias]);
      if (!has) {
        await db.exec('INSERT INTO machine_alias (alias, machine_name, created_at) VALUES (?, ?, ?)',
          [alias, name, nowBKK()]);
      }
    }
    const aliasRows = await dbAll('SELECT alias, machine_name FROM machine_alias', []);
    const aliasMap = new Map(aliasRows.map((r) => [r.alias, r.machine_name]));
    let added = 0, i = 0;
    for (const it of pm.baselineItems()) {
      const name = aliasMap.get(it.name) || it.name;
      i += 1;
      if (!name) continue;
      const has = await dbGet('SELECT id FROM machines WHERE name = ?', [name]);
      if (has) continue;
      await db.exec('INSERT INTO machines (name, sort_order, active, created_at) VALUES (?, ?, 1, ?)',
        [name, 200 + i, nowBKK()]);
      added += 1;
    }
    if (added) console.log(`[pm] เพิ่มเครื่องจักรจากแผน PM เข้าทะเบียน ${added} รายการ`);
  } catch (e) { console.error('[pm] seedPmMachines failed', e.message); }
}

/* ══ Machine Hub: จัดหมวดให้เครื่องในทะเบียน ═══════════════════════════════════
   [ชื่อในทะเบียน, หมวด, คีย์สั้น, ชื่อที่โชว์, ลำดับ, net_id ของแผน PM]

   🔴 ชื่อในทะเบียน (คอลัมน์ name) ห้ามเปลี่ยนเด็ดขาด — มันคือ join key ของ
      duty_routines.machine · incidents.machine · daily_tasks.machine ·
      ชื่อไฟล์โน้ตใน vault และ [[wikilink]] · เปลี่ยนแล้วของเก่ากำพร้าทันที
      ชื่อที่หน้าเว็บ/การ์ดโชว์ให้ใส่ที่ label แทน ("ไลน์ L2" → "เครื่องบรรจุ L2")

   🔑 คีย์สั้น (mkey) ของเครื่องบรรจุต้องตรงกับผลของ normMachine() เป๊ะ ๆ
      เพราะเป็นตัวจับ "[L2]" ในแผนบรรจุเข้ากับเครื่องตัวจริง
      เครื่องที่ normMachine() อ่านไม่ออก (300 ml / Manual / ปี๊บ / Robot) ตั้งคีย์เองได้
      แต่มันจะไม่ถูกจับจากแผนอัตโนมัติ — ต้องเพิ่มรอบเอง

   หมวดที่ไม่ได้อยู่ในลิสต์นี้จะถูกกวาดเป็น 'tool' (เครื่องประจำไลน์จากทะเบียนงานรูทีน)
   ══════════════════════════════════════════════════════════════════════════════ */
const MACHINE_GROUP_SEED = [
  // ── ไลน์ผลิต 6 ──────────────────────────────────────────────────────────
  ['Line ต้ม 1', 'line', 'boil1', 'Line ต้ม 1', 11, 'w03'],
  ['Line ต้ม 2', 'line', 'boil2', 'Line ต้ม 2', 12, 'w04'],
  ['Line ต้ม 3', 'line', 'boil3', 'Line ต้ม 3', 13, 'w05'],
  ['Line ต้ม 4', 'line', 'boil4', 'Line ต้ม 4', 14, 'w06'],
  ['ไลน์ไอซิ่ง', 'line', 'icing', 'Line ผลิตน้ำตาล Icing', 15, 'w01'],
  // ⏳ รอเคาะ: ในโจทย์แยก "ต้มหัวเชื้อ" กับ "น้ำตาล Coconut" เป็น 2 ไลน์
  //    แต่แผน PM ของแอปทีมช่างรวมเป็นรายการเดียว — ตอนนี้ใช้ตามแผน PM (6 ไลน์)
  //    ถ้าแยกจริงให้ INSERT เพิ่ม 1 แถว grp='line' (ไลน์ใหม่จะไม่มีแผน PM ให้ดู)
  ['ไลน์น้ำตาลปั้นและห้องต้มหัวเชื้อ', 'line', 'sugar', 'Line ต้มหัวเชื้อ / น้ำตาลปั้น', 16, 'w02'],

  // ── เครื่องบรรจุ 11 ─────────────────────────────────────────────────────
  ['ไลน์ L1', 'packer', 'l1', 'เครื่องบรรจุ L1', 21, 'w07'],
  ['ไลน์ L2', 'packer', 'l2', 'เครื่องบรรจุ L2', 22, 'w08'],
  ['ไลน์ L3', 'packer', 'l3', 'เครื่องบรรจุ L3', 23, 'w09'],
  ['ไลน์ L4', 'packer', 'l4', 'เครื่องบรรจุ L4', 24, 'w10'],
  ['ไลน์ A1', 'packer', 'a1', 'เครื่องบรรจุ A1', 25, 'w14'],
  ['ไลน์ A2', 'packer', 'a2', 'เครื่องบรรจุ A2', 26, 'w15'],
  ['ไลน์ A3', 'packer', 'a3', 'เครื่องบรรจุ A3', 27, 'w16'],
  ['ไลน์ 300 ml', 'packer', 'ml300', 'ไลน์ 300 ml', 28, 'w12'],
  ['ไลน์ Manual', 'packer', 'manual', 'ไลน์ Manual', 29, 'w13'],
  ['ไลน์ปี๊บ', 'packer', 'pail', 'ไลน์ปี๊บ', 30, 'w30'],
  ['Robot Clear Packer', 'packer', 'robot', 'Robot Clear Packer', 31, 'w11'],

  // ── อุปกรณ์ส่วนกลาง 13 (มีแผน PM แต่ไม่ผูกกับสินค้า/รอบผลิต) ────────────
  ['AHU & Chiller', 'central', null, 'AHU & Chiller', 41, 'w17'],
  ['Cold Room', 'central', null, 'Cold Room', 42, 'w18'],
  ['หลอดไฟและกริ้วแอร์', 'central', null, 'หลอดไฟและกริ้วแอร์', 43, 'w19'],
  ['ถุง AHU', 'central', null, 'ถุง AHU', 44, 'w20'],
  ['RO 10,000', 'central', null, 'RO 10,000', 45, 'w21'],
  ['RO 5,000', 'central', null, 'RO 5,000', 46, 'w22'],
  ['Lift (Otis - Supplier)', 'central', null, 'Lift (Otis)', 47, 'w23'],
  ['แอร์ Split Type (A&K - Supplier)', 'central', null, 'แอร์ Split Type (A&K)', 48, 'w24'],
  ['Air Shower', 'central', null, 'Air Shower', 49, 'w25'],
  ['ห้องเปลี่ยนชุด', 'central', null, 'ห้องเปลี่ยนชุด', 50, 'w26'],
  ['ห้องโหลดน้ำเชื่อมและกลุ่มถังโหลดน้ำเชื่อม', 'central', null, 'ห้องโหลดน้ำเชื่อมและกลุ่มถังโหลด', 51, 'w27'],
  ['บ่อซีเมนต์', 'central', null, 'บ่อซีเมนต์', 52, 'w28'],
  ['สายพานท้ายไลน์ชิ้น 1, 2, 3 และ Check weight', 'central', null, 'สายพานท้ายไลน์ 1,2,3 + Check weight', 53, 'w29'],
];

/* seed หมวด + ชื่อพ้องฝั่งเครื่องบรรจุ (idempotent)
   🔑 เติมเฉพาะช่องที่ยังว่าง (COALESCE) — ที่คนแก้เองในหน้าเว็บแล้วต้องไม่โดนทับ
      ยกเว้น sort_order ที่ระบบเป็นเจ้าของ (ยังไม่มี UI ให้จัดลำดับเอง) */
async function seedMachineGroups() {
  try {
    // ชื่อพ้องฝั่งเครื่องบรรจุ — โจทย์เรียก "เครื่องบรรจุ L2" คนพิมพ์สั้น ๆ ว่า "L2"
    // ทะเบียนเก็บชื่อจริงว่า "ไลน์ L2" (ชื่อที่มาจากแอปทีมช่าง)
    const aliasSeed = [];
    for (const c of ['L1', 'L2', 'L3', 'L4', 'A1', 'A2', 'A3']) {
      aliasSeed.push([`เครื่องบรรจุ ${c}`, `ไลน์ ${c}`], [c, `ไลน์ ${c}`]);
    }
    aliasSeed.push(
      ['Line ผลิตน้ำตาล Icing', 'ไลน์ไอซิ่ง'],
      ['Line ต้มหัวเชื้อ', 'ไลน์น้ำตาลปั้นและห้องต้มหัวเชื้อ'],
      ['ไลน์ต้มหัวเชื้อ', 'ไลน์น้ำตาลปั้นและห้องต้มหัวเชื้อ'],
    );
    for (const [alias, name] of aliasSeed) {
      const has = await dbGet('SELECT alias FROM machine_alias WHERE alias = ?', [alias]);
      if (!has) {
        await db.exec('INSERT INTO machine_alias (alias, machine_name, created_at) VALUES (?, ?, ?)',
          [alias, name, nowBKK()]);
      }
    }

    for (const [name, grp, mkey, label, sort, netId] of MACHINE_GROUP_SEED) {
      await db.exec(
        `UPDATE machines SET grp = COALESCE(grp, ?), mkey = COALESCE(mkey, ?),
            label = COALESCE(label, ?), pm_net_id = COALESCE(pm_net_id, ?), sort_order = ?
         WHERE name = ?`,
        [grp, mkey, label, netId, sort, name]);
    }
    // กวาดที่เหลือเป็น 'tool' — เครื่องประจำไลน์ที่มาจากทะเบียนงานรูทีน (เครื่องชั่ง/เครื่องยิงวันที่/เครน)
    await db.exec("UPDATE machines SET grp = 'tool' WHERE grp IS NULL");
    // ไม่มีชื่อโชว์ = ใช้ชื่อจริงไปก่อน หน้าเว็บจะได้ไม่ต้องเช็ก null ทุกที่
    await db.exec("UPDATE machines SET label = name WHERE label IS NULL OR label = ''");

    const rows = await dbAll(
      "SELECT grp, COUNT(*) AS n FROM machines WHERE active = 1 GROUP BY grp ORDER BY grp", []);
    console.log('[machine-hub] หมวดเครื่องจักร:',
      rows.map((r) => `${r.grp}=${r.n}`).join(' · ') || '(ไม่มีข้อมูล)');
  } catch (e) { console.error('[machine-hub] seedMachineGroups failed', e.message); }
}

/* 2 กฎตั้งต้นจากโจทย์ที่ user เขียนไว้ — มีไว้ให้เห็นรูปร่างของกฎทันทีที่เปิดแท็บ ไม่ใช่หน้าเปล่า
   idempotent ด้วย `code` (mr01/mr02) — ลบทิ้งเองแล้วต้องไม่โผล่กลับมา จึงเช็กรวม deleted ด้วย
   ⚠️ ชื่อเครื่องต้องมีจริงในทะเบียนก่อน ไม่งั้นข้ามไป (กฎที่ชี้ไปยังเครื่องที่ไม่มี = ไม่มีวันเข้าเงื่อนไข) */
const MACHINE_RULE_SEED = [
  {
    code: 'mr01', title: 'ล้างหัวพิมพ์ Lot.no', timing: 'start',
    packer: 'ไลน์ L2', product: 'Amazon', owner: 'pd',
    items: [{ key: 'mr01a', title: 'ล้างหัวพิมพ์ Lot.no ก่อนเริ่มบรรจุ',
      detail: 'ถอดหัวพิมพ์ แช่น้ำยา 5 นาที เช็ดด้วยผ้าไมโครไฟเบอร์', needPhoto: true, needQc: false }],
  },
  {
    code: 'mr02', title: 'ถอดลูกสูบตรวจ o-ring ร่วม QC', timing: 'end',
    packer: 'ไลน์ A1', product: '', owner: 'mt',
    items: [{ key: 'mr02a', title: 'ถอดลูกสูบเพื่อตรวจ o-ring ร่วม QC',
      detail: 'ดูรอยฉีก/รอยบวม เปลี่ยนทันทีถ้าผิดปกติ', needPhoto: true, needQc: true }],
  },
];
async function seedMachineRules() {
  try {
    for (const r of MACHINE_RULE_SEED) {
      const has = await dbGet('SELECT id FROM machine_rules WHERE code = ?', [r.code]);
      if (has) continue;                         // มีแล้ว หรือ user ลบไปเอง — ไม่ยัดซ้ำ
      const m = await dbGet("SELECT name, mkey FROM machines WHERE name = ? AND grp = 'packer'", [r.packer]);
      if (!m) continue;
      const row = { product_pattern: r.product, packer_name: r.packer, line_name: '', shift: '' };
      await db.exec(
        `INSERT INTO machine_rules (code, title, timing, line_name, packer_name, packer_key, product_pattern,
            shift, items, owner_role, note, specificity, notify, active, deleted, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?, ?, '', ?, ?, NULL, ?, 1, 1, 0, ?, ?)`,
        [r.code, r.title, r.timing, r.packer, String(m.mkey || '').toLowerCase(), r.product,
          JSON.stringify(r.items), r.owner, ruleSpecificity(row), nowBKK(), nowBKK()]);
      console.log(`[machine-hub] seed กฎเตือน "${r.title}"`);
    }
  } catch (e) { console.error('[machine-hub] seedMachineRules failed', e.message); }
}

/* อ่านทุกอย่างของปีนั้นมาประกอบเป็นโครงเดียว — ใช้ร่วมกันทั้ง 3 เส้น GET
   🔑 หน่วยนับคือ "เครื่อง × สัปดาห์" เท่านั้น งานย่อยเป็นรายละเอียดข้างใน ไม่ใช่หน่วยนับ
      (ถ้านับงานย่อยด้วย ตัวเลขจะเด้งจากหลักร้อยเป็นหลายร้อยทันที และทุกจอจะไม่ตรงกัน) */
async function pmLoad(year) {
  const today = todayBKK();
  const cur = pm.isoWeekOf(today);
  const [items, jobs, metas, dones, skips, aliasRows] = await Promise.all([
    dbAll('SELECT * FROM pm_items WHERE deleted = 0 ORDER BY net_id', []),
    dbAll('SELECT * FROM pm_jobs WHERE active = 1 ORDER BY net_id, sort_order, id', []),
    dbAll('SELECT * FROM pm_item_meta', []),
    dbAll('SELECT * FROM pm_done WHERE iso_year = ?', [year]),
    dbAll('SELECT * FROM pm_skip WHERE iso_year = ?', [year]),
    dbAll('SELECT alias, machine_name FROM machine_alias', []),
  ]);
  const aliasMap = new Map(aliasRows.map((r) => [r.alias, r.machine_name]));
  const ownerOf = new Map(metas.map((m) => [m.net_id, m.owner || '']));
  const doneOf = new Map(dones.map((d) => [`${d.net_id}_${d.week}`, d]));
  const skipOf = new Map(skips.map((d) => [`${d.net_id}_${d.week}`, d]));
  const jobsOf = new Map();
  for (const j of jobs) { if (!jobsOf.has(j.net_id)) jobsOf.set(j.net_id, []); jobsOf.get(j.net_id).push(j); }

  const out = items.map((r) => {
    let weeks = [];
    try { weeks = JSON.parse(r.weeks || '[]'); } catch { weeks = []; }
    weeks = weeks.map(Number).filter((n) => n >= 1 && n <= 53).sort((a, b) => a - b);
    const step = pm.stepOf(r.freq, weeks);
    const myJobs = (jobsOf.get(r.net_id) || []).map((j) => ({
      id: j.id, title: j.title, every: Math.max(1, Number(j.every) || 1),
      freqLabel: pm.jobFreqLabel(step, j.every),
      weeks: pm.jobWeeks(weeks, j.every),
    }));
    const cycles = weeks.map((w) => {
      const d = doneOf.get(`${r.net_id}_${w}`);
      const s = skipOf.get(`${r.net_id}_${w}`);
      const { monday, sunday } = pm.weekRange(year, w);
      return {
        week: w, monday, sunday,
        status: pm.cycleStatus(year, w, cur, !!d, !!s),
        doneBy: d?.done_by || '', doneDate: d?.done_date || '', note: d?.note || '',
        reason: s?.reason || '',
        jobs: myJobs.filter((j) => j.weeks.includes(w)).map((j) => j.title),
      };
    });
    const n = (st) => cycles.filter((c) => c.status === st).length;
    const doneN = n('done'); const overN = n('over'); const skipN = n('skip');
    const dueN = doneN + overN;                       // "ถึงกำหนดแล้ว" = ทำแล้ว + เลยกำหนด
    const doneDates = cycles.map((c) => c.doneDate).filter(Boolean).sort();
    const next = cycles.find((c) => c.status === 'due') || cycles.find((c) => c.status === 'future');
    return {
      netId: r.net_id, name: r.name, machine: aliasMap.get(r.name) || r.name,
      freq: r.freq, freqLabel: pm.freqLabel(r.freq), step,
      isCustom: !!r.is_custom, owner: ownerOf.get(r.net_id) || '',
      weeks, cycles, jobs: myJobs,
      stat: {
        planned: weeks.length,          // รอบทั้งปีตามแผน
        active: weeks.length - skipN,   // ตัวหาร "ทั้งปี" = รอบที่ไม่ปิดใช้งาน
        due: dueN, done: doneN, over: overN, skip: skipN,
        thisWeek: n('due'),
        pct: dueN ? Math.round((doneN / dueN) * 100) : null,   // ห้ามโชว์ % ลอย ๆ ไม่มีตัวหาร
        lastDone: doneDates.length ? doneDates[doneDates.length - 1] : '',
        nextWeek: next ? next.week : null,
        nextMonday: next ? next.monday : '',
      },
    };
  });
  return { today, cur, year, items: out };
}

// เวลาที่ดึงล่าสุด — หลัง Render รีสตาร์ต ตัวแปรในหน่วยความจำจะว่าง ต้องถอยไปดูรอยประทับในตาราง
// (ไม่งั้นแถบ "อัปเดตล่าสุด" บนหน้าเว็บจะว่างทุกครั้งที่เซิร์ฟเวอร์ตื่นใหม่ ทั้งที่ข้อมูลมีอยู่)
async function pmSyncInfo() {
  const l = pm.pmLastSync();
  let at = l.at;
  if (!at) {
    try { at = (await dbGet('SELECT MAX(synced_at) AS a FROM pm_items', []))?.a || null; }
    catch { /* ตารางยังไม่พร้อม */ }
  }
  return { syncedAt: at, syncOk: l.ok, netlifyUrl: pm.NETLIFY_URL };
}
const pmYearOf = (q) => {
  const y = Number(q);
  return (y >= 2000 && y <= 2100) ? y : pm.isoWeekOf(todayBKK()).year;
};

/* ── แผนทั้งปี: ป้อนตารางทั้งปี · ตามเครื่องจักร · ปฏิทินเดือน ─────────────── */
app.get('/api/maint/pm/plan', async (req, res) => {
  try {
    const year = pmYearOf(req.query.year);
    const { cur, items } = await pmLoad(year);
    const weeksInYear = pm.isoWeeksInYear(year);
    // แถบเดือนของตาราง — สัปดาห์ ISO สังกัดเดือนของ "วันพฤหัส" ไม่ใช่วันจันทร์
    const months = [];
    for (let w = 1; w <= weeksInYear; w += 1) {
      const m = pm.monthOfIsoWeek(year, w);
      if (!months.length || months[months.length - 1].month !== m) months.push({ month: m, weeks: 1, from: w });
      else months[months.length - 1].weeks += 1;
    }
    const reg = await dbAll(
      `SELECT title, COUNT(DISTINCT net_id) AS uses FROM pm_jobs WHERE active = 1
        GROUP BY title ORDER BY uses DESC, title`, []);
    const people = (await maintTeamRows()).map((p) => ({ key: p.person_key, name: p.name }));
    res.json({
      year, weeksInYear, curYear: cur.year, curWeek: cur.week, months, items,
      jobRegistry: reg.map((r) => ({ title: r.title, uses: Number(r.uses) || 0 })),
      people, ...(await pmSyncInfo()),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── งานสัปดาห์นี้ + งานค้างจากสัปดาห์ก่อน ─────────────────────────────────
   งานค้างยกมาไว้บนสุดจนกว่าจะปิดงานหรือปิดรอบที่แอปทีมช่าง ไม่ปล่อยตกไปกับสัปดาห์เก่า */
app.get('/api/maint/pm/week', async (req, res) => {
  try {
    const year = pmYearOf(req.query.year);
    const weeksInYear = pm.isoWeeksInYear(year);
    const { cur, items } = await pmLoad(year);
    const week = Math.min(weeksInYear, Math.max(1,
      Number(req.query.week) || (cur.year === year ? cur.week : 1)));
    const entry = (it, c) => ({
      netId: it.netId, name: it.name, machine: it.machine, freqLabel: it.freqLabel,
      owner: it.owner, week: c.week, monday: c.monday, sunday: c.sunday,
      status: c.status, doneBy: c.doneBy, doneDate: c.doneDate, note: c.note, reason: c.reason,
      jobs: c.jobs, lateWeeks: c.status === 'over' ? Math.max(0, cur.week - c.week) : 0,
    });
    const thisWeek = []; const late = []; let skipCount = 0;
    for (const it of items) {
      for (const c of it.cycles) {
        if (c.week === week) { thisWeek.push(entry(it, c)); if (c.status === 'skip') skipCount += 1; }
        else if (c.status === 'over' && c.week < week) late.push(entry(it, c));
      }
    }
    late.sort((a, b) => b.week - a.week);   // ใกล้ปัจจุบันที่สุดขึ้นก่อน
    const active = thisWeek.filter((t) => t.status !== 'skip');
    const doneN = active.filter((t) => t.status === 'done').length;
    const { monday, sunday } = pm.weekRange(year, week);
    res.json({
      year, week, weeksInYear, monday, sunday,
      curYear: cur.year, curWeek: cur.week, isCurrent: cur.year === year && cur.week === week,
      thisWeek, late: late.slice(0, 50), lateTotal: late.length,
      stat: {
        total: active.length, done: doneN, left: active.length - doneN,
        pct: active.length ? Math.round((doneN / active.length) * 100) : null,
        late: late.length, skip: skipCount,
      },
      ...(await pmSyncInfo()),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── สรุปผล: S-Curve + ตารางรายเครื่อง ────────────────────────────────────
   ⚠️ 2 ตัวเลขนี้คนละตัวหาร ห้ามเอามาวางคู่กันลอย ๆ:
      "ทำได้ตามแผนที่ถึงกำหนด" = done / (done+over)   · S-Curve = สะสม / รอบทั้งปีที่ไม่ปิดใช้งาน */
app.get('/api/maint/pm/summary', async (req, res) => {
  try {
    const year = pmYearOf(req.query.year);
    const { cur, items } = await pmLoad(year);
    const weeksInYear = pm.isoWeeksInYear(year);
    const curMonth = cur.year === year ? pm.monthOfIsoWeek(year, Math.min(cur.week, weeksInYear))
      : (cur.year > year ? 11 : -1);
    const T = { planned: 0, active: 0, due: 0, done: 0, over: 0, skip: 0 };
    for (const it of items) {
      T.planned += it.stat.planned; T.active += it.stat.active; T.due += it.stat.due;
      T.done += it.stat.done; T.over += it.stat.over; T.skip += it.stat.skip;
    }
    // S-Curve รายเดือน — นับที่ "เดือนของสัปดาห์ตามแผน" ทั้งสองเส้น จะได้เทียบกันตรง ๆ
    const planByMonth = Array(12).fill(0); const doneByMonth = Array(12).fill(0);
    for (const it of items) {
      for (const c of it.cycles) {
        if (c.status === 'skip') continue;
        const m = pm.monthOfIsoWeek(year, c.week);
        planByMonth[m] += 1;
        if (c.status === 'done') doneByMonth[m] += 1;
      }
    }
    let pc = 0; let dc = 0;
    const curve = planByMonth.map((_, m) => {
      pc += planByMonth[m]; dc += doneByMonth[m];
      return {
        month: m,
        plan: T.active ? Math.round((pc / T.active) * 1000) / 10 : 0,
        actual: (m <= curMonth && T.active) ? Math.round((dc / T.active) * 1000) / 10 : null,
      };
    });
    const rows = items.map((it) => ({
      netId: it.netId, name: it.name, machine: it.machine, freqLabel: it.freqLabel,
      planned: it.stat.planned, active: it.stat.active, due: it.stat.due,
      done: it.stat.done, over: it.stat.over, skip: it.stat.skip, pct: it.stat.pct,
      lastDone: it.stat.lastDone, nextWeek: it.stat.nextWeek,
    })).sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101) || b.over - a.over);
    const cm = curve[curMonth] || null;
    res.json({
      year, curYear: cur.year, curWeek: cur.week, curMonth,
      total: {
        ...T,
        pctDue: T.due ? Math.round((T.done / T.due) * 100) : null,   // ตัวหาร = รอบที่ถึงกำหนด
        machines: items.length, machinesOver: items.filter((i) => i.stat.over > 0).length,
      },
      curve,
      gap: cm && cm.actual != null ? Math.round((cm.plan - cm.actual) * 10) / 10 : null,
      rows, ...(await pmSyncInfo()),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── ต่อจากนี้เป็นส่วนที่ "เขียนได้" — ข้อมูลของแอปนี้เอง Netlify ไม่มีช่องเก็บ ── */

// ลิสต์งานย่อยต่อเครื่อง (เพิ่ม/แก้/ลบ/เรียง) — หัวหน้างานขึ้นไป
app.post('/api/maint/pm/jobs', requireRole('supervisor'), async (req, res) => {
  const b = req.body || {};
  const action = String(b.action || 'add');
  try {
    if (action === 'reorder') {
      const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
      for (let i = 0; i < ids.length; i += 1) {
        await db.exec('UPDATE pm_jobs SET sort_order = ? WHERE id = ?', [i + 1, ids[i]]);
      }
      return res.json({ success: true, ordered: ids.length });
    }
    if (action === 'delete') {
      const id = Number(b.id);
      if (!id) return res.status(400).json({ error: 'id จำเป็น' });
      await db.exec('DELETE FROM pm_jobs WHERE id = ?', [id]);
      return res.json({ success: true });
    }
    if (action === 'update') {
      const id = Number(b.id);
      const cur = id ? await dbGet('SELECT * FROM pm_jobs WHERE id = ?', [id]) : null;
      if (!cur) return res.status(404).json({ error: 'ไม่พบงานย่อยนี้' });
      const title = b.title === undefined ? cur.title : String(b.title || '').trim();
      if (!title) return res.status(400).json({ error: 'ชื่องานว่างไม่ได้' });
      const every = b.every === undefined ? cur.every : await pmEveryOf(cur.net_id, b.every);
      const dup = await dbGet('SELECT id FROM pm_jobs WHERE net_id = ? AND title = ? AND id <> ?',
        [cur.net_id, title, id]);
      if (dup) return res.status(409).json({ error: `"${title}" มีอยู่ในเครื่องนี้แล้ว` });
      await db.exec('UPDATE pm_jobs SET title = ?, every = ? WHERE id = ?', [title, every, id]);
      return res.json({ success: true, id, title, every });
    }
    // add
    const netId = String(b.netId || '').trim();
    const title = String(b.title || '').trim();
    if (!netId || !title) return res.status(400).json({ error: 'ต้องระบุรายการ PM และชื่องาน' });
    const item = await dbGet('SELECT net_id FROM pm_items WHERE net_id = ?', [netId]);
    if (!item) return res.status(404).json({ error: 'ไม่พบรายการ PM นี้ในแผนที่ดึงมา' });
    const dup = await dbGet('SELECT id FROM pm_jobs WHERE net_id = ? AND title = ?', [netId, title]);
    if (dup) return res.status(409).json({ error: `"${title}" มีอยู่ในเครื่องนี้แล้ว` });
    const last = await dbGet('SELECT MAX(sort_order) AS m FROM pm_jobs WHERE net_id = ?', [netId]);
    const every = await pmEveryOf(netId, b.every);
    await db.exec(
      'INSERT INTO pm_jobs (net_id, title, every, sort_order, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [netId, title, every, (Number(last?.m) || 0) + 1, nowBKK()]);
    return res.json({ success: true, netId, title, every });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// every = ทำทุกกี่รอบของเครื่อง — ถี่กว่ารอบเครื่องไม่ได้ และห้ามเกินจำนวนรอบทั้งปี
async function pmEveryOf(netId, raw) {
  const n = Math.max(1, Math.round(Number(raw) || 1));
  const row = await dbGet('SELECT weeks FROM pm_items WHERE net_id = ?', [netId]);
  let weeks = [];
  try { weeks = JSON.parse(row?.weeks || '[]'); } catch { weeks = []; }
  return Math.min(n, Math.max(1, weeks.length));
}

// ผู้รับผิดชอบตั้งต้นรายเครื่อง (Netlify มีแต่ doneBy หลังปิดงาน ไม่มี assignee ล่วงหน้า)
app.post('/api/maint/pm/owner', requireRole('supervisor'), async (req, res) => {
  const netId = String(req.body?.netId || '').trim();
  const owner = String(req.body?.owner || '').trim();
  if (!netId) return res.status(400).json({ error: 'netId จำเป็น' });
  try {
    await db.exec(
      `INSERT INTO pm_item_meta (net_id, owner, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (net_id) DO UPDATE SET owner = excluded.owner, updated_at = excluded.updated_at`,
      [netId, owner, nowBKK()]);
    res.json({ success: true, netId, owner });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ปุ่ม "ดึงเดี๋ยวนี้" — กันรัวด้วยระยะห่างขั้นต่ำ (ตัวดึงอัตโนมัติทำชั่วโมงละครั้งอยู่แล้ว)
let _pmSyncClickAt = 0;
app.post('/api/maint/pm/sync', async (req, res) => {
  const since = Date.now() - _pmSyncClickAt;
  if (since < 20000) {
    return res.status(429).json({ error: 'เพิ่งดึงไปเมื่อครู่ — รออีกสักครู่แล้วลองใหม่', ...(await pmSyncInfo()) });
  }
  _pmSyncClickAt = Date.now();
  try {
    const r = await pm.pmSync();
    if (!r.ok) return res.status(502).json({ error: `ดึงจากแอปทีมช่างไม่สำเร็จ — ${r.error}`, ...(await pmSyncInfo()) });
    res.json({ success: true, ...r, ...(await pmSyncInfo()) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══════════════ แจ้งเตือนงาน PM เข้ากลุ่มช่าง ══════════════
   2 จังหวะต่อสัปดาห์ (เคาะกับ user 10 ก.ย. 2026):
     จันทร์ 08:00 — เปิดสัปดาห์ บอกว่าสัปดาห์นี้ต้องทำอะไรบ้าง + ค้างเท่าไร
     ศุกร์ 16:00 — ตามเฉพาะตัวที่ยังไม่ปิด ก่อนสัปดาห์จะจบ
   ไม่มีอะไรต้องบอก = เงียบ (ไม่ส่งข้อความเปล่า ๆ ให้กลุ่มรก)

   🔑 กันยิงซ้ำด้วยการ "จองคีย์" ใน pm_notify_log ก่อนทำงานจริง — INSERT ชนได้ครั้งเดียว
      (วิธีเดียวกับ spp_shift_nudge · ปลอดภัยแม้ n8n เคาะซ้ำหรือมีหลาย instance)
   ⚠️ เทียบเวลาแบบ hm >= เป้าหมาย ไม่ใช่ตรงนาทีเป๊ะ — ถ้า tick หายไปนาทีนึงจะได้ไม่เงียบทั้งสัปดาห์ */
const PM_NOTIFY_AT = {
  open: { wd: 1, hm: '08:00', label: 'จันทร์เช้า' },
  chase: { wd: 5, hm: '16:00', label: 'ศุกร์บ่าย' },
};
const PM_TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const pmShortDate = (d) => `${Number(String(d).slice(8, 10))} ${PM_TH_MON[Number(String(d).slice(5, 7)) - 1]}`;

// ตัดลิสต์ยาว ๆ ให้เหลือพอดีข้อความ Telegram (เพดาน 4096 ตัวอักษร)
const pmCap = (arr, n, more) => (arr.length <= n ? arr : [...arr.slice(0, n), `   <i>…และอีก ${arr.length - n} ${more}</i>`]);

/* ประกอบข้อความ — คืน null ถ้าไม่มีอะไรต้องบอก
   อ่านจาก pmLoad() ตัวเดียวกับหน้าเว็บ ตัวเลขในกลุ่มกับบนเว็บจึงไม่มีทางเพี้ยนจากกัน */
async function buildPmNotify(kind) {
  const today = todayBKK();
  const cur = pm.isoWeekOf(today);
  const { items } = await pmLoad(cur.year);
  const { monday, sunday } = pm.weekRange(cur.year, cur.week);

  const thisWeek = []; const late = [];
  let done = 0; let due = 0;
  for (const it of items) {
    done += it.stat.done; due += it.stat.due;
    for (const c of it.cycles) {
      if (c.week === cur.week) { if (c.status !== 'skip') thisWeek.push({ it, c }); }
      else if (c.status === 'over' && c.week < cur.week) late.push({ it, c });
    }
  }
  const left = thisWeek.filter((r) => r.c.status !== 'done');
  if (!thisWeek.length && !late.length) return null;              // สัปดาห์ว่างจริง ๆ
  if (kind === 'chase' && !left.length && !late.length) return null; // ปิดครบแล้ว ไม่ต้องตาม

  // 1 บรรทัด = 1 รอบ (เครื่อง × สัปดาห์) · งานย่อยเป็นบรรทัดลูกใต้ชื่อเครื่อง
  const line = ({ it, c }) => {
    // ปิดแล้วขึ้นต้นด้วย ✅ และบอกคนปิดจริง — ไม่ต้องโชว์ "ยังไม่มอบหมาย" ให้สับสน
    const head = c.status === 'done'
      ? `✅ <b>${escapeHtml(it.name)}</b> — ปิดแล้ว${c.doneBy ? ` โดย ${escapeHtml(c.doneBy)}` : ''}`
      : `• <b>${escapeHtml(it.name)}</b> — 👤 ${escapeHtml(it.owner || 'ยังไม่มอบหมาย')}`;
    if (!c.jobs.length) return head;
    let jobs = c.jobs.join(' · ');
    if (jobs.length > 110) jobs = `${jobs.slice(0, 108)}…`;
    return `${head}\n   └ ${escapeHtml(jobs)}`;
  };
  const lateLine = ({ it, c }) =>
    `• <b>${escapeHtml(it.name)}</b> W${c.week} — ค้าง ${cur.week - c.week} สัปดาห์`;

  const L = [];
  if (kind === 'open') {
    L.push(`🗓 <b>งาน PM สัปดาห์ที่ ${cur.week}</b> (${pmShortDate(monday)}–${pmShortDate(sunday)})`);
    L.push(`สัปดาห์นี้มี <b>${thisWeek.length}</b> รอบ`
      + (thisWeek.length - left.length ? ` · ปิดแล้ว <b>${thisWeek.length - left.length}</b>` : '')
      + (late.length ? ` · ค้างจากสัปดาห์ก่อน <b>${late.length}</b>` : ''));
    if (thisWeek.length) {
      // ที่ยังไม่ปิดขึ้นก่อนเสมอ — คนอ่านในกลุ่มต้องเห็นของที่ต้องลงมือก่อน
      const sorted = [...left, ...thisWeek.filter((r) => r.c.status === 'done')];
      L.push('', '📌 <b>ต้องทำสัปดาห์นี้</b>', ...pmCap(sorted.map(line), 12, 'รอบ'));
    }
  } else {
    const daysLeft = Math.max(0, Math.round((Date.parse(`${sunday}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000));
    L.push(`⏰ <b>สัปดาห์ที่ ${cur.week} เหลืออีก ${daysLeft} วัน</b> (ถึง อา. ${pmShortDate(sunday)})`);
    L.push(left.length
      ? `ยังไม่ปิด <b>${left.length}</b> จาก <b>${thisWeek.length}</b> รอบของสัปดาห์นี้`
      : `รอบของสัปดาห์นี้ปิดครบแล้ว ✅ (${thisWeek.length} รอบ)`);
    if (left.length) L.push('', '📌 <b>ที่ยังไม่ปิด</b>', ...pmCap(left.map(line), 12, 'รอบ'));
  }

  if (late.length) {
    const oldest = [...late].sort((a, b) => a.c.week - b.c.week);
    L.push('', `⚠️ <b>ค้างจากสัปดาห์ก่อน ${late.length} รอบ</b> — ค้างนานสุด:`,
      ...pmCap(oldest.map(lateLine), 5, 'รอบ'));
  }

  // ทุก % ต้องพกตัวหาร — ห้ามโชว์ 93% ลอย ๆ
  if (due) L.push('', `📈 ถึงวันนี้ทำได้ <b>${done}</b> จาก <b>${due}</b> รอบที่ถึงกำหนด = <b>${Math.round((done / due) * 100)}%</b>`);
  L.push(`🔧 ปิดงาน/แก้แผนที่ <a href="${pm.NETLIFY_URL}">แอปทีมช่าง</a> — หน้าเว็บของแอปนี้อ่านอย่างเดียว`);
  return L.join('\n');
}

async function pmNotifyTick(atStr) {
  try {
    const cfg = await getReportConfig();
    if (!cfg.pmNotifyEnabled) return;
    const bkk = atStr || new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const hm = bkk.slice(11, 16);
    const wd = new Date(`${bkk.slice(0, 10)}T12:00:00`).getDay();
    const kind = Object.keys(PM_NOTIFY_AT).find((k) => PM_NOTIFY_AT[k].wd === wd && hm >= PM_NOTIFY_AT[k].hm);
    if (!kind) return;

    const cur = pm.isoWeekOf(bkk.slice(0, 10));
    const key = `${cur.year}_${cur.week}_${kind}`;
    // จองคีย์ก่อนทำงานจริง — ชนแล้วออกเงียบ ๆ แปลว่ารอบนี้ส่งไปแล้ว
    try { await db.exec('INSERT INTO pm_notify_log (key, sent_at) VALUES (?, ?)', [key, nowBKK()]); }
    catch { return; }

    await pm.pmSync();   // ดึงของสดก่อนบอกกลุ่ม (ดึงไม่ได้ก็ใช้ของเดิม ไม่ล้ม)
    const msg = await buildPmNotify(kind);
    if (!msg) { console.log(`[pm-notify] ${key} ไม่มีอะไรต้องบอก — เงียบไว้`); return; }
    await notify('pm', msg);
    console.log(`[pm-notify] ${key} ส่งเข้ากลุ่มช่างแล้ว`);
  } catch (e) { console.error('[pm-notify] tick error', e.message); }
}

/* ดูตัวอย่าง/ส่งทดสอบ — ไม่ต้องรอถึงวันจันทร์ และไม่แตะคีย์กันยิงซ้ำของรอบจริง
   preview: true = คืนข้อความเฉย ๆ ไม่ส่งเข้ากลุ่ม */
app.post('/api/maint/pm/notify-test', requireRole('supervisor'), async (req, res) => {
  const kind = req.body?.kind === 'chase' ? 'chase' : 'open';
  try {
    const msg = await buildPmNotify(kind);
    if (!msg) {
      return res.json({ success: true, skipped: true, kind,
        message: 'ตอนนี้ไม่มีรอบของสัปดาห์นี้และไม่มีงานค้าง — ถึงเวลาจริงระบบจะเงียบ ไม่ส่งข้อความเปล่า' });
    }
    if (req.body?.preview) return res.json({ success: true, kind, preview: msg });
    await notify('pm', msg);
    res.json({ success: true, sent: true, kind, preview: msg });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/maint/pm', async (req, res) => {
  const today = todayBKK();
  const soonDays = Math.min(90, Math.max(1, Number(req.query.soon) || 7));
  const backDays = Math.min(365, Math.max(1, Number(req.query.back) || 30));
  const soonEnd = pmDateOfFrom(today, soonDays);
  const doneFrom = pmDateOfFrom(today, -backDays);
  try {
    // ไม่ดึงคอลัมน์รูป (base64) — คืนแค่ธงว่ามีรูปไหม เหมือนบอร์ดงานมอบหมาย
    const cols = `id, task_date, title, machine, assignee, status, due_time, remind_at, created_by, created_at,
       completed_at, done_by,
       CASE WHEN images IS NULL OR images = '' OR images = '[]' THEN 0 ELSE 1 END AS has_images,
       CASE WHEN done_images IS NULL OR done_images = '' OR done_images = '[]' THEN 0 ELSE 1 END AS has_done_images`;
    const rows = await dbAll(
      `SELECT ${cols} FROM daily_tasks
        WHERE category = 'pm' AND (status <> 'done' OR task_date >= ?)
        ORDER BY task_date, id`, [doneFrom]);
    const all = rows.map(r => pmRowOut(r, today));
    const open = all.filter(r => r.status !== 'done');
    let machines = [];
    try {
      machines = (await dbAll('SELECT name FROM machines WHERE active = 1 ORDER BY sort_order, id', []))
        .map(m => m.name).filter(Boolean);
    } catch { /* ทะเบียนเครื่องจักรยังไม่พร้อม — เลือกเครื่องด้วยการพิมพ์เอาก็ได้ */ }
    const people = (await maintTeamRows()).map(p => ({ key: p.person_key, name: p.name }));
    res.json({
      today, soonDays, backDays,
      late: open.filter(r => r.date && r.date < today),
      todayList: open.filter(r => r.date === today),
      soon: open.filter(r => r.date > today && r.date <= soonEnd),
      later: open.filter(r => !r.date || r.date > soonEnd),
      done: all.filter(r => r.status === 'done')
        .sort((a, b) => String(b.completedAt || b.date).localeCompare(String(a.completedAt || a.date))),
      machines, people,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ตั้งงาน PM ใหม่จากหน้าเว็บ — ใช้ savePmTask ตัวเดียวกับ wizard ในบอท
app.post('/api/maint/pm', async (req, res) => {
  const b = req.body || {};
  const what = String(b.what || '').trim();
  const date = String(b.date || '');
  if (!what) return res.status(400).json({ error: 'ต้องบอกว่าจะทำอะไร' });
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return res.status(400).json({ error: 'วันที่ต้องเป็น YYYY-MM-DD' });
  try {
    const saved = await savePmTask({
      title: what, machine: String(b.machine || '').trim(), date,
      kind: PM_KIND[b.kind] ? b.kind : 'pm', remind: b.remind || 'day', dueTime: b.dueTime || null,
    }, b.assignee || null);
    res.json({ success: true, ...saved });
    scheduleVaultTaskSync(date);
    if (process.env.TELEGRAM_CHAT_ID) {
      notify('duty', `🗓 <b>ตั้งงาน PM ใหม่</b>\n📌 ${escapeHtml(saved.title)}\n`
        + (b.machine ? `🔩 ${escapeHtml(String(b.machine))}\n` : '')
        + `📅 ${thaiDate(date)}\n✍️ ตั้งจากหน้าเว็บโดย ${escapeHtml(String(b.operator || 'จักรกฤษ'))}`);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// แก้งาน PM — หัวใจของหน้านี้คือ "เลื่อนวัน" (date) ซึ่ง /api/tasks/update ทำไม่ได้
app.post('/api/maint/pm/update', async (req, res) => {
  const b = req.body || {};
  const id = Number(b.id);
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const cur = await dbGet("SELECT * FROM daily_tasks WHERE id = ? AND category = 'pm'", [id]);
    if (!cur) return res.status(404).json({ error: 'ไม่พบงาน PM นี้' });
    const old = splitPmTitle(cur.title);
    const kind = b.kind === undefined ? old.kind : (PM_KIND[b.kind] ? b.kind : '');
    const what = b.what === undefined ? old.what : String(b.what || '').trim();
    if (!what) return res.status(400).json({ error: 'ชื่องานว่างไม่ได้' });
    const title = pmTitleOf(kind, what);
    const date = b.date === undefined ? String(cur.task_date || '') : String(b.date || '');
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) return res.status(400).json({ error: 'วันที่ต้องเป็น YYYY-MM-DD' });
    const assignee = b.assignee === undefined ? (cur.assignee || '') : String(b.assignee || '');
    const machine = b.machine === undefined ? (cur.machine || '') : String(b.machine || '').trim();
    const dueTime = b.dueTime === undefined ? (cur.due_time || '') : String(b.dueTime || '').trim();
    const remind = b.remind === undefined ? pmRemindOf(cur) : String(b.remind || 'none');
    // UNIQUE(task_date, line_name, category, title) — ไม่กันไว้จะเด้ง error ดิบ ๆ ตอนเลื่อนวันไปชนงานเดิม
    if (date !== cur.task_date || title !== cur.title || assignee !== (cur.assignee || '')) {
      const dup = await dbGet(
        `SELECT id FROM daily_tasks WHERE task_date = ? AND line_name = ? AND category = 'pm' AND title = ? AND id <> ?`,
        [date, assignee, title, id]);
      if (dup) return res.status(409).json({
        error: 'duplicate', message: `มีงาน "${title}" ของคนเดียวกันในวันที่ ${date} อยู่แล้ว` });
    }
    const status = b.status === 'done' ? 'done' : b.status === 'pending' ? 'pending' : (cur.status || 'pending');
    const doneNow = status === 'done' && cur.status !== 'done';
    // ปิดงานแล้วยังเก็บ remind_at ไว้ (reminderTick กรอง status != 'done' อยู่แล้ว)
    // ถ้าล้างทิ้ง พอ "เปิดงานใหม่" การตั้งเตือนเดิมจะหายไปเงียบ ๆ
    const remindAt = pmRemindAt(date, remind);
    const reminded = remindAt && remindAt !== (cur.remind_at || null) ? 0 : (Number(cur.reminded) || 0);
    await db.exec(
      `UPDATE daily_tasks SET task_date = ?, line_name = ?, assignee = ?, title = ?, machine = ?, due_time = ?,
         remind_at = ?, remind_lead = ?, reminded = ?, status = ?, completed_at = ?, done_by = ? WHERE id = ?`,
      [date, assignee, assignee || null, title, machine || null, dueTime || null,
        remindAt, remind === 'none' ? null : 'morning', reminded, status,
        status === 'done' ? (cur.completed_at || nowBKK()) : null,
        status === 'done' ? (cur.done_by || b.operator || null) : null, id]);
    // gate ในหน่วยความจำ กัน reminderTick ข้ามงานที่เพิ่งเลื่อนมาใกล้ขึ้น
    if (remindAt && (_nextRemindAt == null || remindAt < _nextRemindAt)) { _nextRemindAt = remindAt; _nextRemindKnown = true; }
    if (doneNow) await bumpMachineLastPm(machine);
    res.json({ success: true, id, date, title });
    scheduleVaultTaskSync(date);
    if (date !== cur.task_date) scheduleVaultTaskSync(cur.task_date);
    if (date !== cur.task_date && status !== 'done' && process.env.TELEGRAM_CHAT_ID) {
      notify('duty', `🗓 <b>เลื่อนงาน PM</b>\n📌 ${escapeHtml(title)}\n`
        + (machine ? `🔩 ${escapeHtml(machine)}\n` : '')
        + `📅 ${thaiDate(cur.task_date)} → <b>${thaiDate(date)}</b>\n`
        + `✍️ ${escapeHtml(String(b.operator || 'จักรกฤษ'))}`);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/maint/pm/delete', async (req, res) => {
  const id = Number(req.body?.id);
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    const cur = await dbGet("SELECT task_date FROM daily_tasks WHERE id = ? AND category = 'pm'", [id]);
    if (!cur) return res.status(404).json({ error: 'ไม่พบงาน PM นี้' });
    await db.exec('DELETE FROM daily_tasks WHERE id = ?', [id]);
    res.json({ success: true });
    scheduleVaultTaskSync(cur.task_date);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ชื่อกะของทีมซ่อมบำรุง (แถวเดียว)
async function getMaintShiftName() {
  try { return (await dbAll('SELECT shift_name FROM maint_team ORDER BY id LIMIT 1', []))[0]?.shift_name || MAINT_SHIFT_DEFAULT; }
  catch { return MAINT_SHIFT_DEFAULT; }
}

// แมตช์แบบไม่สนช่องว่าง/ตัวพิมพ์ (ไทยไม่มีเคส · ละตินเทียบ lower)
const _normText = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
// สร้าง suggestion จากกฎที่แมตช์
function _mkSuggestion(keys, rule, source, confidence, desc) {
  const assignees = [...new Set(keys.filter(Boolean))];
  return {
    assignees, primary: assignees[0] || null,
    category: rule.category || 'cleaning', priority: rule.priority || 'normal',
    // needsReview = ไม่เข้ากฎเลย (→ ส่ง AI/คนช่วย) · low-spec zone ยังเชื่อได้แต่ UI ขึ้นหมายเหตุจาก confidence
    source, confidence, needsReview: confidence < 0.5, lowConfidence: confidence < 0.8, matchedRule: desc,
  };
}
// เครื่องตัดสินใจ 2 ปัจจัย: keyword (ประเด็น) override → zone (สถานที่) → ไม่เข้า = ต้องรีวิว
function routeFinding(f) {
  const issueN = _normText(f.issue);
  const locN = _normText(f.location);
  for (const r of _assignRules) {
    if (r.rule_type !== 'keyword') continue;
    if (issueN.includes(_normText(r.pattern)))
      return _mkSuggestion([r.owner_key, r.co_owner_key], r, 'rule', 0.95, `กฎคำสำคัญ “${r.pattern}”`);
  }
  for (const r of _assignRules) {
    if (r.rule_type !== 'zone') continue;
    if (locN.includes(_normText(r.pattern)))
      return _mkSuggestion([r.owner_key, r.co_owner_key], r, 'rule', r.specificity >= 60 ? 0.9 : 0.72, `กฎโซน “${r.pattern}”`);
  }
  return { assignees: [], primary: null, category: 'cleaning', priority: 'normal', source: 'review', confidence: 0, needsReview: true, matchedRule: null };
}
// AI fallback — เรียก Claude เดาผู้รับเมื่อกฎไม่เข้า (คืน null ถ้าไม่มี key / ตอบไม่ได้)
async function aiSuggestAssignee(finding, roster) {
  if (!ai.available('assign')) return null;
  const list = roster.map(p => `${p.person_key}=${p.name} (${p.role || ''})`).join('; ');
  const prompt = `ใบตรวจโรงงานอาหาร มีประเด็นที่กฎอัตโนมัติแบ่งไม่ได้ ช่วยเลือกผู้รับผิดชอบที่เหมาะสมที่สุด 1 คน จากรายชื่อนี้เท่านั้น\n`
    + `รายชื่อ (key=ชื่อ · หน้าที่): ${list}\n`
    + `ประเด็น: ${finding.issue || '-'}\nสถานที่: ${finding.location || '-'}\n`
    + `ตอบเป็น JSON บรรทัดเดียวเท่านั้น: {"owner_key":"...","category":"cleaning|maintenance","reason":"เหตุผลสั้นๆ","confidence":0.0-1.0}`;
  try {
    const resp = await ai.createMessage('assign', { max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
    const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const m = txt.match(/\{[\s\S]*\}/); if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!j.owner_key || !roster.find(p => p.person_key === j.owner_key)) return null;
    return { owner_key: j.owner_key, category: j.category === 'maintenance' ? 'maintenance' : 'cleaning', reason: j.reason || '', confidence: typeof j.confidence === 'number' ? j.confidence : 0.6 };
  } catch { return null; }
}

// สร้างโครงต้นไม้เช็กลิสต์ของคนหนึ่งจาก DB (รูปแบบเดียวกับ ROUTINES_SEED เดิม)
// cache ในหน่วยความจำ (เช็กลิสต์เปลี่ยนไม่บ่อย) — เลี่ยง query ซ้ำตอน buildDutyRange ยิงหลายร้อยวัน
let _routineCache = {};
const invalidateRoutineCache = () => { _routineCache = {}; };
async function buildRoutineTree(personKey) {
  if (_routineCache[personKey]) return _routineCache[personKey];
  // ลด egress: ไม่ดึง ref_image ที่เป็น base64 (fallback ตอนไม่มี Supabase) — คืน URL ตรงๆ ถ้าเป็น URL
  // ไม่งั้นคืนแค่ธง แล้วให้ client โหลดผ่าน GET /api/routine/image ตอนกดดู
  const rows = await dbAll(
    `SELECT id, parent_id, node_key, title, mono, sort_order, machine, goal, owner_role, co_owner_role, freq,
       CASE WHEN ref_image LIKE 'http%' THEN ref_image ELSE NULL END AS ref_image_url,
       CASE WHEN ref_image IS NULL OR ref_image = '' THEN 0 ELSE 1 END AS has_ref_image
     FROM duty_routines WHERE person_key = ? AND active = 1 AND (sheet IS NULL OR sheet <> 'am')
     ORDER BY parent_id, sort_order, id`, [personKey]);
  const byParent = {};
  for (const r of rows) { const k = r.parent_id == null ? 'root' : String(r.parent_id); (byParent[k] = byParent[k] || []).push(r); }
  const build = (key) => (byParent[key] || []).map(r => {
    const node = { key: r.node_key, title: r.title, id: r.id, parentId: r.parent_id == null ? null : r.parent_id,
      machine: r.machine || null, goal: r.goal || null, freq: r.freq || null,
      ownerRole: r.owner_role || null, coOwnerRole: r.co_owner_role || null,
      refImage: r.ref_image_url || null, hasRefImage: !!r.has_ref_image };
    if (r.mono) node.mono = true;
    const kids = build(String(r.id));
    if (kids.length) node.children = kids;
    return node;
  });
  const tree = build('root');
  _routineCache[personKey] = tree;
  return tree;
}

function flattenRoutine(nodes, depth = 0, prefix = '') {
  const out = [];
  for (const n of nodes) {
    const key = prefix ? `${prefix}/${n.key}` : n.key;
    out.push({ key, title: n.title, depth, mono: !!n.mono, id: n.id, parentId: n.parentId,
      machine: n.machine || null, goal: n.goal || null, freq: n.freq || null,
      ownerRole: n.ownerRole || null, coOwnerRole: n.coOwnerRole || null,
      refImage: n.refImage || null, hasRefImage: !!n.hasRefImage });
    if (n.children) out.push(...flattenRoutine(n.children, depth + 1, key));
  }
  return out;
}

// รวมสถานะงานประจำ + งานมอบหมาย ของทุกคนในวันนั้น
// opts.audit = true → บอร์ด "ใบตรวจ": คน kind='audit' + งานจากใบตรวจแบบค้างสะสมข้ามวัน
// (คืนโครงเดียวกับบอร์ดกะ nodes/received/adhoc → buildDutyPerson ใช้ซ้ำได้ทั้งดุ้น)
async function buildDuty(date, opts = {}) {
  const audit = !!opts.audit;
  const maint = !!opts.maint;   // บอร์ดทีมซ่อมบำรุง — ใช้ท่อเดียวกับบอร์ดกะ (มี routine_state/ติ๊กได้)
  // ลด egress เช่นกัน: done_image อาจเป็น base64 → คืน URL ตรงๆ ถ้าเป็น URL ไม่งั้นคืนแค่ธง
  const stateRows = audit ? [] : await dbAll(
    `SELECT id, state_date, assignee, node_key, title, checked, bypassed, bypass_reason, handoff_to,
       CASE WHEN done_image LIKE 'http%' THEN done_image ELSE NULL END AS done_image_url,
       CASE WHEN done_image IS NULL OR done_image = '' THEN 0 ELSE 1 END AS has_done_image
     FROM routine_state WHERE state_date = ?`, [date]);
  const stateMap = {};
  for (const s of stateRows) stateMap[`${s.assignee}|${s.node_key}`] = s;
  // ลด egress: ไม่ดึงคอลัมน์ base64 (images/done_images) จาก Neon — คืนแค่ธงว่ามีรูปไหม
  // (รูปโหลดตอนกดดูจริงผ่าน GET /api/tasks/images) — Neon นับ transfer ทุกครั้งที่ข้อมูลออกจาก DB
  // machine/due_time ติดมาด้วย — บอร์ดซ่อมบำรุงจัดกลุ่มงานตามเครื่องจักร (คอลัมน์สั้น ไม่กระทบ egress)
  const cols = `id, task_date, category, title, location, priority, status, handoff_from, assignee, machine, due_time,
       CASE WHEN images IS NULL OR images = '' OR images = '[]' THEN 0 ELSE 1 END AS has_images,
       CASE WHEN done_images IS NULL OR done_images = '' OR done_images = '[]' THEN 0 ELSE 1 END AS has_done_images`;
  const adhoc = await dbAll(
    audit
      // ค้างทุกวัน (ยังไม่ปิด) + ที่เพิ่งปิดวันนี้ — ประเด็นใบตรวจต้องตามจนกว่าจะปิด
      ? `SELECT ${cols} FROM daily_tasks
         WHERE audit_batch IS NOT NULL AND (status != 'done' OR task_date = ?) ORDER BY task_date, id`
      : `SELECT ${cols} FROM daily_tasks WHERE task_date = ? AND source = 'assigned' ORDER BY id`, [date]);

  let teamDone = 0, teamTotal = 0;
  // เฉพาะทีมกะ — ผู้รับผิดชอบใบตรวจ (kind='audit') ไม่โผล่ในบอร์ดหน้าที่รายวัน (โหมด audit กลับด้าน)
  //   audit → คนใบตรวจ · maint → ทีมซ่อมบำรุง · ปกติ → ทีมกะเท่านั้น (ไม่ให้ 2 กลุ่มนั้นปนเข้ามา)
  const kindOf = (p) => p.kind || 'shift';
  const peopleList = getPeople().filter(p =>
    audit ? kindOf(p) === 'audit' : maint ? kindOf(p) === 'maint' : kindOf(p) === 'shift');
  const people = await Promise.all(peopleList.map(async (pRow) => {
    const p = { key: pRow.person_key, name: pRow.name, role: pRow.role, color: pRow.color, wash: pRow.wash, initial: pRow.initial, dot: pRow.dot, kind: pRow.kind || 'shift' };
    // คนใบตรวจไม่มีงานประจำ — ข้าม query routine ทั้งก้อน
    const tree = audit ? [] : await buildRoutineTree(p.key);
    let nodes = flattenRoutine(tree).map(n => {
      const st = stateMap[`${p.key}|${n.key}`];
      return {
        ...n,
        checked: !!(st && st.checked),
        bypassed: !!(st && st.bypassed),
        bypassReason: st ? st.bypass_reason || null : null,
        handoffTo: st ? st.handoff_to || null : null,
        handoffToName: st && st.handoff_to ? dutyName(st.handoff_to) : null,
        // รูปหลังทำของวันนั้น (รูปอ้างอิงติดมากับ n จาก flattenRoutine แล้ว)
        doneImage: st ? st.done_image_url || null : null,
        hasDoneImage: !!(st && st.has_done_image),
      };
    });
    // งานที่คนอื่นมอบต่อมาให้คนนี้ (bypass + handoff_to = p.key)
    const received = stateRows
      .filter(s => s.handoff_to === p.key && s.bypassed)
      .map(s => ({ ownerKey: s.assignee, fromName: dutyName(s.assignee), nodeKey: s.node_key, title: s.title, checked: !!s.checked }));
    const myAdhoc = adhoc.filter(t => t.assignee === p.key).map(t => ({
      id: t.id, title: t.title, category: t.category, location: t.location || null,
      machine: t.machine || null, dueTime: t.due_time || null,
      priority: t.priority || 'normal', status: t.status, handoffFrom: t.handoff_from || null,
      hasImages: !!t.has_images, hasDoneImages: !!t.has_done_images, // รูปโหลด lazy ตอนกดดู
    }));

    // โหมดซ่อมบำรุง: งานที่ "ผู้รับผิดชอบ 2" เป็น Maintenance = ทีมผลิตทำ เราแค่ตามผล → ไม่นับ ไม่ต้องติ๊ก
    // ส่วนงานที่ไม่เกี่ยวกับซ่อมบำรุงเลย (เช่น Operate + Operate) ยังเก็บใน DB เป็นทะเบียนงาน แต่ไม่ขึ้นบอร์ด
    const watch = maint ? nodes.filter(n => n.ownerRole && n.ownerRole !== 'mt' && n.coOwnerRole === 'mt') : [];
    if (maint) nodes = nodes.filter(n => !n.ownerRole || n.ownerRole === 'mt');

    const active = nodes.filter(n => !n.bypassed);
    let done = active.filter(n => n.checked).length;
    let total = active.length;
    done += received.filter(r => r.checked).length; total += received.length;
    done += myAdhoc.filter(t => t.status === 'done').length; total += myAdhoc.length;
    teamDone += done; teamTotal += total;
    return { ...p, nodes, watch, received, adhoc: myAdhoc, done, total, pct: total ? Math.round(done / total * 100) : 100 };
  }));
  // โหมด audit ไม่มีวันหยุด — ประเด็นค้างต้องตามได้ทุกวัน (รวมเสาร์)
  return { date, audit, maint, shiftName: maint ? await getMaintShiftName() : null,
    holiday: !audit && !maint && weekdayOf(date) === 6, people,
    team: { done: teamDone, total: teamTotal, left: teamTotal - teamDone, pct: teamTotal ? Math.round(teamDone / teamTotal * 100) : 100 } };
}

// คนนี้เป็นผู้รับผิดชอบใบตรวจไหม (ใช้เลือกว่าจะสร้างบอร์ดกะหรือบอร์ดใบตรวจ)
const isAuditKey = (k) => ((getPeople().find(p => p.person_key === k) || {}).kind || 'shift') === 'audit';
// นับประเด็นใบตรวจที่ยังไม่ปิด — ใช้ติดป้ายบนปุ่มเมนูบอท
async function countAuditOpen() {
  try {
    const r = await dbAll("SELECT COUNT(*) AS n FROM daily_tasks WHERE audit_batch IS NOT NULL AND status != 'done'", []);
    return Number((r[0] || {}).n || 0);
  } catch { return 0; }
}

app.get('/api/duty', async (req, res) => {
  const date = req.query.date || workDayBKK();
  const maint = req.query.kind === 'maint';   // ไม่ส่ง kind = พฤติกรรมเดิมของบอร์ดกะเป๊ะ
  try { res.json(await buildDuty(date, { maint })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ชื่อกะของทีมซ่อมบำรุง — อ่าน/แก้จากหน้าเว็บ (สมาชิกใช้ /api/duty/person แบบเดียวกับทีมกะ)
app.get('/api/maint/team', async (req, res) => {
  try { res.json({ shiftName: await getMaintShiftName() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/maint/team', async (req, res) => {
  const name = String(req.body.shiftName || '').trim();
  if (!name) return res.status(400).json({ error: 'shiftName จำเป็น' });
  try {
    const cur = await dbAll('SELECT id FROM maint_team ORDER BY id LIMIT 1', []);
    if (cur.length) await db.exec('UPDATE maint_team SET shift_name = ?, updated_at = ? WHERE id = ?', [name, nowBKK(), cur[0].id]);
    else await db.exec('INSERT INTO maint_team (shift_name, updated_at) VALUES (?, ?)', [name, nowBKK()]);
    res.json({ success: true, shiftName: name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ระบบแบ่งงานใบตรวจอัตโนมัติ (Audit auto-assign) ──────────────────────────
// รับ findings[] → เดาผู้รับผิดชอบ (กฎก่อน · AI เติมเคสที่กฎไม่เข้า) → คืน suggestions[]
// ยังไม่บันทึก/ส่ง — หน้าเว็บเอาไปโชว์ตารางรีวิว แล้วค่อยกด "ส่งทั้งหมด" ผ่าน /api/duty/assign
app.post('/api/audit/route', async (req, res) => {
  const findings = Array.isArray(req.body.findings) ? req.body.findings : [];
  const useAi = req.body.ai !== false; // ปิดด้วย {ai:false} เพื่อวัด accuracy เฉพาะกฎ
  const roster = getPeople(); // ทุกคน (ทีมกะ + audit) เป็นผู้รับได้
  const nameOf = (k) => { const p = roster.find(x => x.person_key === k); return p ? { key: k, name: p.name, dot: p.dot, color: p.color } : { key: k, name: k, dot: '👤', color: '#607d8b' }; };
  try {
    const suggestions = [];
    for (const f of findings) {
      let s = routeFinding(f);
      if (s.needsReview && useAi) {
        const ai = await aiSuggestAssignee(f, roster);
        if (ai) s = { assignees: [ai.owner_key], primary: ai.owner_key, category: ai.category, priority: 'normal', source: 'ai', confidence: ai.confidence, needsReview: ai.confidence < 0.7, matchedRule: `AI: ${ai.reason}` };
      }
      suggestions.push({ issue: f.issue || '', location: f.location || '', date: f.date || null, ...s, names: s.assignees.map(nameOf) });
    }
    res.json({ count: suggestions.length, suggestions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── อ่านเอกสารตรวจจากรูป (Claude vision) → คืนแถวพร้อมเติมในฟอร์ม ──────────
// เจ้าหน้าที่ส่งเอกสารเป็นรูปเข้า Line → วางในแอป → ไม่ต้องพิมพ์เองทีละแถว
// ชื่อคนในเอกสาร (ถ้ามี) ชนะกฎแบ่งงาน — แมตช์กับ roster ให้แล้วคืน key มาด้วย
const READ_SHEET_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: 'ประเด็น/ปัญหาที่พบ คงคำเดิมจากเอกสาร' },
          location: { type: 'string', description: 'สถานที่/โซน ตามที่เขียนในเอกสาร ไม่มีให้เว้นว่าง' },
          priority: { type: 'string', enum: ['normal', 'urgent'] },
          assignee_name: { type: 'string', description: 'ชื่อผู้รับผิดชอบตามที่เขียนในเอกสาร ไม่มีให้เว้นว่าง' },
          has_photo: { type: 'boolean', description: 'แถวนี้มีรูปถ่ายประกอบอยู่ในเอกสารหรือไม่' },
          photo_index: { type: 'integer', description: 'รูปเอกสารใบที่เท่าไรที่รูปนี้อยู่ (0 = ใบแรกที่แนบมา)' },
          photo_box: {
            type: 'object',
            description: 'กรอบสี่เหลี่ยมของรูปถ่ายบนใบนั้น หน่วยเป็นพิกเซล — has_photo=false ให้ใส่ 0 ทั้งหมด',
            properties: {
              x: { type: 'number', description: 'ขอบซ้ายของกรอบ' },
              y: { type: 'number', description: 'ขอบบนของกรอบ' },
              w: { type: 'number', description: 'ความกว้างของกรอบ' },
              h: { type: 'number', description: 'ความสูงของกรอบ' },
            },
            required: ['x', 'y', 'w', 'h'],
            additionalProperties: false,
          },
        },
        required: ['issue', 'location', 'priority', 'assignee_name', 'has_photo', 'photo_index', 'photo_box'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};
// จับคู่ชื่อในเอกสาร → person_key (ตรงเป๊ะก่อน แล้วค่อยชื่อย่อย/ชื่อยาว) — กำกวม = ไม่แมตช์ ปล่อยให้กฎเดา
function matchPersonByName(raw, roster) {
  const n = _normText(raw);
  if (!n) return null;
  const exact = roster.filter(p => _normText(p.name) === n);
  if (exact.length === 1) return exact[0].person_key;
  const loose = roster.filter(p => { const pn = _normText(p.name); return pn && (pn.includes(n) || n.includes(pn)); });
  return loose.length === 1 ? loose[0].person_key : null;
}
app.post('/api/audit/read-sheet', async (req, res) => {
  // ไม่มีคีย์ = ปิดเฉพาะฟีเจอร์อ่านรูป (503) ฟอร์มพิมพ์มือต้องใช้ได้ตามปกติ
  if (!ai.available('sheet')) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าคีย์ AI บนเซิร์ฟเวอร์ — พิมพ์แถวเองได้ตามปกติ' });
  const imgs = (Array.isArray(req.body.images) ? req.body.images : [])
    .filter(im => im && im.data)
    .map(im => ({
      data: String(im.data), media_type: im.media_type || 'image/jpeg',
      width: Number(im.width) > 0 ? Math.round(Number(im.width)) : null,
      height: Number(im.height) > 0 ? Math.round(Number(im.height)) : null,
    }))
    .slice(0, 6);
  if (!imgs.length) return res.status(400).json({ error: 'ต้องแนบรูปเอกสารอย่างน้อย 1 รูป' });
  const roster = getPeople();
  const names = roster.map(p => p.name).join(', ');
  const tileNote = imgs.length > 1
    ? `\n(รูปที่แนบมา ${imgs.length} รูป — เป็นส่วนย่อยของเอกสารใบเดียวกันที่ครอปแยกเพื่อความชัด ให้ประกอบกันแล้วอ่านเรียงจากบนลงล่าง ห้ามนับแถวซ้ำ)`
    : '';
  // ขนาดพิกเซลของแต่ละใบ — โมเดลใช้อ้างอิงตอนชี้กรอบรูป (พิกัดที่ตอบกลับ map 1:1 กับรูปที่ส่งไป)
  const dims = imgs.every(im => im.width && im.height)
    ? '\n\nขนาดรูปที่แนบมา: ' + imgs.map((im, i) => `ใบที่ ${i} กว้าง ${im.width} สูง ${im.height} พิกเซล`).join(' · ')
    : '';
  const prompt = 'นี่คือรูปเอกสารตรวจพื้นที่ของโรงงานอาหาร ช่วยอ่านทุกแถวในตารางออกมาเป็นข้อมูล\n\n'
    + 'กฎการอ่านที่ต้องทำตามเคร่งครัด:\n'
    + '• อ่านเฉพาะที่เห็นในรูปเท่านั้น ห้ามแต่งเพิ่ม ห้ามสรุปใหม่ ห้ามแก้คำผิด — คงคำเดิมจากเอกสารทุกตัวอักษร\n'
    + '• ช่องไหนอ่านไม่ชัดหรือไม่มีข้อมูล ให้เว้นเป็นข้อความว่าง อย่าเดา\n'
    + '• ระวังสระ/วรรณยุกต์ไทยที่ตัวเล็ก (ำ ั ิ ี ื ่ ้ ๊ ๋) — ต้องอ่านให้ครบ เช่น "ท่อน้ำดี" ไม่ใช่ "ท่อนดี", "น้ำตาล" ไม่ใช่ "นตาล"\n'
    + '• priority = "urgent" เฉพาะแถวที่เอกสารระบุว่าด่วน/เร่งด่วน/ทำเครื่องหมายสีแดง นอกนั้น "normal"\n'
    + '• ถ้ามีคอลัมน์ผู้รับผิดชอบ/ผู้ตรวจ/ผู้แก้ไข ให้ใส่ชื่อใน assignee_name ตามที่เขียน (ชื่อเล่นก็ได้) ไม่มีคอลัมน์นี้ให้เว้นว่าง\n'
    + `• ชื่อคนที่เป็นไปได้ในโรงงานนี้: ${names}\n`
    + '• ข้ามหัวตาราง เลขลำดับ และแถวว่าง — เอาเฉพาะแถวที่มีประเด็นจริง\n\n'
    + 'รูปถ่ายประกอบในเอกสาร:\n'
    + '• แถวไหนมี "รูปถ่ายจริง" ของจุดที่พบปัญหาอยู่ในเอกสาร ให้ตอบ has_photo = true แล้วชี้กรอบสี่เหลี่ยมที่ล้อมเฉพาะตัวรูป (ไม่เอาเส้นขอบตาราง ไม่เอาคำบรรยายใต้รูป)\n'
    + '• photo_index = ใบที่รูปนั้นอยู่ (0 = ใบแรก) · photo_box = พิกัดพิกเซลบนใบนั้น x,y คือมุมซ้ายบน w,h คือกว้าง/สูง\n'
    + '• แถวไหนไม่มีรูป ให้ has_photo = false แล้วใส่ photo_box เป็น 0 ทั้งหมด — ห้ามเดาพิกัด ห้ามชี้ไปที่ข้อความหรือโลโก้\n'
    + '• รูปหนึ่งรูปใช้กับแถวเดียวเท่านั้น ห้ามชี้กรอบเดียวกันให้หลายแถว'
    + tileNote + dims;
  try {
    const resp = await ai.createMessage('sheet', {
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      // structured output → JSON ตรงสเปกแน่นอน · effort medium พอสำหรับอ่านตาราง (ปรับลงได้ถ้าช้า)
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: READ_SHEET_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          ...imgs.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
          { type: 'text', text: prompt },
        ],
      }],
    });
    const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch { const m = txt.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    const rows = (parsed && Array.isArray(parsed.rows) ? parsed.rows : [])
      .map(r => {
        const issue = String(r.issue || '').trim();
        const assigneeName = String(r.assignee_name || '').trim();
        // กรอบรูป: เอาเฉพาะที่เป็นตัวเลขจริงและมีขนาด — ที่เหลือตรวจละเอียด (ขนาด/ทับซ้อน) ฝั่ง client ที่รู้ขนาดรูป
        const b = r.photo_box || {};
        const nums = [b.x, b.y, b.w, b.h].map(Number);
        const boxOk = r.has_photo === true && nums.every(Number.isFinite) && nums[2] > 0 && nums[3] > 0;
        const idx = Number(r.photo_index);
        return {
          issue, location: String(r.location || '').trim(),
          priority: r.priority === 'urgent' ? 'urgent' : 'normal',
          assigneeName, assigneeKey: matchPersonByName(assigneeName, roster),
          photoIndex: boxOk && Number.isInteger(idx) && idx >= 0 && idx < imgs.length ? idx : 0,
          photoBox: boxOk ? { x: nums[0], y: nums[1], w: nums[2], h: nums[3] } : null,
        };
      })
      .filter(r => r.issue);
    const u = resp.usage || {};
    console.log(`[read-sheet] ${ai.describe('sheet')} imgs=${imgs.length} rows=${rows.length} boxes=${rows.filter(r => r.photoBox).length} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('[read-sheet] error', err.message);
    // เครดิตหมด/คีย์ผิด/ยิงถี่ = 503 "ยังใช้ไม่ได้" ไม่ใช่ 500 "แอปพัง" — ฝั่งเว็บจะได้บอกให้พิมพ์เอง
    res.status(err.status || 500).json({ error: `อ่านเอกสารไม่สำเร็จ: ${err.message}` });
  }
});

/* ── อ่าน "เช็คลิสต์ตรวจสอบประจำวัน" จากรูปเอกสาร → แถวทะเบียนงานรูทีน ─────────
   คนละใบกับใบตรวจพื้นที่ข้างบน: ใบนี้เป็นตารางงานประจำที่ทำซ้ำทุกวัน (เช่น AM List)
   คอลัมน์ในเอกสาร: ลำดับ / หัวข้อการตรวจสอบ / มาตรฐาน / วิธีการ / ช่องติ๊กวันที่ 1-31
   → ตรงกับช่อง title / goal / method ของ duty_routines · ช่องติ๊กรายวันไม่ต้องอ่าน
   ไม่เขียนลง DB เอง — คืนแถวให้หน้าเว็บตรวจทานก่อนกดนำเข้า (เหมือน read-sheet)   */
const READ_ROUTINE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'ชื่อไลน์/เครื่องจักรจากหัวเอกสารของแผ่นที่แถวนี้อยู่ เช่น "ถัง 1"' },
          seq: { type: 'integer', description: 'เลขลำดับในเอกสาร (ไม่มี = 0)' },
          title: { type: 'string', description: 'หัวข้อการตรวจสอบ' },
          goal: { type: 'string', description: 'มาตรฐานการตรวจสอบ (เกณฑ์ที่ถือว่าผ่าน)' },
          method: { type: 'string', description: 'วิธีการตรวจสอบ' },
          unclear: { type: 'boolean', description: 'true = อ่านจากรูปไม่ชัด ต้องให้คนตรวจทาน' },
        },
        required: ['group', 'seq', 'title', 'goal', 'method', 'unclear'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};
app.post('/api/routine/read-sheet', async (req, res) => {
  if (!ai.available('routine')) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าคีย์ AI บนเซิร์ฟเวอร์ — พิมพ์แถวเองได้ตามปกติ' });
  const imgs = (Array.isArray(req.body.images) ? req.body.images : [])
    .filter(im => im && im.data)
    .map(im => ({ data: String(im.data), media_type: im.media_type || 'image/jpeg' }))
    .slice(0, 6);
  if (!imgs.length) return res.status(400).json({ error: 'ต้องแนบรูปเอกสารอย่างน้อย 1 รูป' });
  // ชื่อเครื่องที่มีอยู่แล้ว — ให้โมเดลใช้ชื่อเดิมถ้าหัวเอกสารหมายถึงเครื่องเดียวกัน จะได้ไม่แตกกลุ่มใหม่
  let known = [];
  try { known = (await dbAll('SELECT name FROM machines WHERE active = 1 ORDER BY sort_order, name', [])).map(r => r.name); } catch { /* ไม่มีตารางก็ข้าม */ }
  const knownNote = known.length ? `\n• ชื่อเครื่องจักร/ไลน์ที่มีอยู่แล้วในระบบ: ${known.join(', ')}\n  ถ้าหัวเอกสารหมายถึงตัวเดียวกับในรายการนี้ ให้ตอบ group เป็นชื่อในระบบเพื่อไม่ให้กลุ่มซ้ำซ้อน` : '';
  const tileNote = imgs.length > 1
    ? `\n(แนบมา ${imgs.length} รูป — อาจเป็นคนละแผ่น (คนละไลน์) หรือครอปจากแผ่นเดียวกัน ให้ดูหัวเอกสารของแต่ละรูปแล้วแยก group ตามนั้น ห้ามนับแถวซ้ำ)`
    : '';
  const prompt = 'นี่คือรูปเอกสาร "เช็คลิสต์ตรวจสอบประจำวัน" ของโรงงานอาหาร ช่วยอ่านทุกแถวในตารางออกมาเป็นข้อมูล\n\n'
    + 'โครงตารางในเอกสาร: ลำดับ | หัวข้อการตรวจสอบ | มาตรฐานการตรวจสอบ | วิธีการตรวจสอบ | ช่องติ๊กวันที่ 1-31\n\n'
    + 'กฎการอ่านที่ต้องทำตามเคร่งครัด:\n'
    + '• อ่านเฉพาะที่เห็นในรูปเท่านั้น ห้ามแต่งเพิ่ม ห้ามสรุปใหม่ ห้ามแก้คำผิด — คงคำเดิมจากเอกสารทุกตัวอักษร\n'
    + '• ระวังสระ/วรรณยุกต์ไทยที่ตัวเล็ก (ำ ั ิ ี ื ่ ้ ๊ ๋) — ต้องอ่านให้ครบ เช่น "ท่อน้ำดี" ไม่ใช่ "ท่อนดี", "น้ำตาล" ไม่ใช่ "นตาล"\n'
    + '• ช่องไหนในแถวว่างจริง ๆ ให้ตอบเป็นข้อความว่าง อย่าเดาแทน\n'
    + '• แถวไหนอ่านไม่ออกหรือไม่มั่นใจ ให้ unclear = true แล้วใส่เท่าที่อ่านได้ — ห้ามเดาให้เต็ม เพราะจะมีคนมาตรวจทานต่อ\n'
    + '• ช่องติ๊กวันที่ 1-31 ไม่ต้องอ่าน ไม่ต้องตอบกลับมา\n'
    + '• ข้ามหัวตาราง แถวว่าง และช่องลงชื่อผู้ตรวจท้ายเอกสาร\n'
    + '• group = ชื่อไลน์/เครื่องจักรจากหัวเอกสารของแผ่นที่แถวนั้นอยู่ ทุกแถวในแผ่นเดียวกันต้องได้ group เดียวกัน'
    + knownNote + tileNote;
  try {
    const resp = await ai.createMessage('routine', {
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: READ_ROUTINE_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          ...imgs.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
          { type: 'text', text: prompt },
        ],
      }],
    });
    // ปฏิเสธจาก safety classifier = ตอบ 200 พร้อม stop_reason นี้ ต้องเช็คก่อนอ่าน content
    if (resp.stop_reason === 'refusal') return res.status(422).json({ error: 'โมเดลปฏิเสธคำขอนี้ — ลองใหม่หรือพิมพ์แถวเอง' });
    const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch { const m = txt.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    const rows = (parsed && Array.isArray(parsed.rows) ? parsed.rows : [])
      .map(r => ({
        group: String(r.group || '').trim(),
        seq: Number.isFinite(Number(r.seq)) ? Number(r.seq) : 0,
        title: String(r.title || '').trim(),
        goal: String(r.goal || '').trim(),
        method: String(r.method || '').trim(),
        unclear: r.unclear === true,
      }))
      .filter(r => r.title);
    const u = resp.usage || {};
    console.log(`[routine-sheet] ${ai.describe('routine')} imgs=${imgs.length} rows=${rows.length} unclear=${rows.filter(r => r.unclear).length} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('[routine-sheet] error', err.message);
    // เครดิตหมด/คีย์ผิด/ยิงถี่ = 503 "ยังใช้ไม่ได้" ไม่ใช่ 500 "แอปพัง" — ฝั่งเว็บจะได้บอกให้พิมพ์เอง
    res.status(err.status || 500).json({ error: `อ่านเอกสารไม่สำเร็จ: ${err.message}` });
  }
});

// รายชื่อผู้รับได้ทั้งหมด (dropdown ในตารางรีวิว)
app.get('/api/audit/people', (req, res) => {
  res.json({ people: getPeople().map(p => ({ key: p.person_key, name: p.name, role: p.role, color: p.color, dot: p.dot, kind: p.kind || 'shift' })) });
});
// กฎแบ่งงานปัจจุบัน (โชว์ที่มา/ให้ผู้ใช้ตรวจ)
app.get('/api/audit/rules', (req, res) => {
  res.json({ rules: _assignRules.map(r => ({ id: r.id, rule_type: r.rule_type, pattern: r.pattern, owner_key: r.owner_key, co_owner_key: r.co_owner_key, category: r.category, priority: r.priority, specificity: r.specificity, active: r.active })) });
});

// เพิ่ม/แก้กฎแบ่งงานจาก UI (ไม่ต้องแก้โค้ด) — ปิดท้ายด้วย refreshAssignRules() ให้ cache ตรงกับ DB
app.post('/api/audit/rules', async (req, res) => {
  const { id, rule_type, pattern, owner_key, co_owner_key, category, priority, specificity, active } = req.body;
  const type = rule_type === 'keyword' ? 'keyword' : 'zone';
  const pat = String(pattern || '').trim();
  if (!id && (!pat || !owner_key)) return res.status(400).json({ error: 'pattern และ owner_key จำเป็น' });
  try {
    if (id) {
      // co_owner_key ใช้ = ? ตรงๆ (ไม่ COALESCE) เพื่อให้ล้างผู้รับร่วมออกได้
      await db.exec(
        `UPDATE assign_rules SET rule_type = COALESCE(?, rule_type), pattern = COALESCE(?, pattern),
           owner_key = COALESCE(?, owner_key), co_owner_key = ?, category = COALESCE(?, category),
           priority = COALESCE(?, priority), specificity = COALESCE(?, specificity), active = COALESCE(?, active)
         WHERE id = ?`,
        [rule_type ? type : null, pat || null, owner_key || null, co_owner_key || null, category || null,
          priority || null, specificity == null ? null : Number(specificity),
          active == null ? null : (active ? 1 : 0), id]);
    } else {
      await db.exec(
        `INSERT INTO assign_rules (rule_type, pattern, owner_key, co_owner_key, category, priority, specificity, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [type, pat, owner_key, co_owner_key || null, category || 'cleaning', priority || 'normal',
          specificity == null ? 50 : Number(specificity), active === 0 || active === false ? 0 : 1, nowBKK()]);
    }
    await refreshAssignRules();
    res.json({ success: true, count: _assignRules.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/audit/rules/delete', async (req, res) => {
  if (!req.body.id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    await db.exec('DELETE FROM assign_rules WHERE id = ?', [req.body.id]);
    await refreshAssignRules();
    res.json({ success: true, count: _assignRules.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// จำนวนวันระหว่าง 2 วันที่ (YYYY-MM-DD) — ใช้บอกว่าประเด็นค้างมากี่วัน
const daysBetween = (from, to) => Math.max(0, Math.round((new Date(`${to}T12:00:00`) - new Date(`${from}T12:00:00`)) / 86400000));

// ── ติดตามผลใบตรวจ — เฉพาะงานที่มาจากใบตรวจ (audit_batch ไม่ NULL) ──────────
// ค้าง = ทุกวันไม่จำกัดวันที่ (ประเด็นค้างต้องตามจนกว่าจะปิด) · ปิดแล้ว = ย้อนหลัง N วัน
app.get('/api/audit/tracking', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const today = todayBKK();
  const since = addDaysStr(today, -days);
  try {
    // ลด egress: ไม่ดึง images/done_images (base64) — คืนแค่ธงว่ามีรูป (โหลดจริงตอนกดดูผ่าน /api/tasks/images)
    const rows = await dbAll(
      `SELECT id, task_date, category, title, location, priority, status, assignee, completed_at, done_by, audit_batch,
         CASE WHEN images IS NULL OR images = '' OR images = '[]' THEN 0 ELSE 1 END AS has_images,
         CASE WHEN done_images IS NULL OR done_images = '' OR done_images = '[]' THEN 0 ELSE 1 END AS has_done_images
       FROM daily_tasks
       WHERE audit_batch IS NOT NULL AND (status != 'done' OR task_date >= ?)
       ORDER BY task_date DESC, id DESC`, [since]);
    const items = rows.map(t => ({
      id: t.id, date: t.task_date, title: t.title, location: t.location || null,
      category: t.category, priority: t.priority || 'normal', status: t.status,
      assignee: t.assignee, assigneeName: dutyName(t.assignee), batch: t.audit_batch,
      completedAt: t.completed_at || null, doneBy: t.done_by || null,
      hasImages: !!t.has_images, hasDoneImages: !!t.has_done_images,
      ageDays: daysBetween(t.task_date, today),
    }));
    const pending = items.filter(t => t.status !== 'done');
    const done = items.filter(t => t.status === 'done');
    res.json({
      today, days, pending, done,
      summary: { open: pending.length, closed: done.length, overdue3: pending.filter(t => t.ageDays >= 3).length },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── จัดการคน/งานของ Duty board (ไม่ต้องแก้โค้ด) ─────────────────────────────
// สร้าง key จากข้อความ (รองรับไทย → ถ้าว่างใช้ p + timestamp) แล้วกันซ้ำ
const slugKey = (text, taken) => {
  let base = String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // ชื่อไทยล้วนจะเหลือแต่เศษ (เช่น "ทดสอบ สมาชิก2" → "2") — คีย์แบบนั้นอ่านไม่รู้เรื่องและชนง่าย
  if (base.length < 2 || /^[\d-]+$/.test(base)) base = 'p' + Date.now().toString(36);
  let k = base, i = 2;
  while (taken.includes(k)) k = `${base}-${i++}`;
  return k;
};

// upsert คน — สร้างใหม่ (auto key + สี default) หรือแก้ที่มีอยู่
app.post('/api/duty/person', async (req, res) => {
  const { key, name, role, color, wash, initial, sortOrder } = req.body;
  // kind = กลุ่มของคน: shift (ทีมกะ) · maint (ทีมซ่อมบำรุง) · audit (ผู้รับผิดชอบใบตรวจ)
  const kind = ['shift', 'maint', 'audit'].includes(req.body.kind) ? req.body.kind : 'shift';
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name จำเป็น' });
  try {
    if (key) {
      // แก้คนเดิม (เฉพาะฟิลด์ที่ส่งมา)
      const cur = (await dbAll('SELECT * FROM duty_people WHERE person_key = ?', [key]))[0];
      if (!cur) return res.status(404).json({ error: 'ไม่พบคนนี้' });
      await db.exec('UPDATE duty_people SET name = ?, role = ?, color = ?, wash = ?, initial = ?, sort_order = ? WHERE person_key = ?',
        [name.trim(), role != null ? role : cur.role, color || cur.color, wash || cur.wash, initial || cur.initial, sortOrder != null ? sortOrder : cur.sort_order, key]);
      await refreshPeopleCache();
      return res.json({ success: true, key });
    }
    // สร้างใหม่
    const all = await dbAll('SELECT person_key FROM duty_people', []);
    const taken = all.map(r => r.person_key);
    const newKey = slugKey(name, taken);
    const pal = DUTY_PALETTE[all.length % DUTY_PALETTE.length];
    const dot = DUTY_DOTS[all.length % DUTY_DOTS.length];
    const maxOrder = (await dbAll('SELECT MAX(sort_order) AS m FROM duty_people', []))[0];
    const order = sortOrder != null ? sortOrder : ((maxOrder && maxOrder.m != null ? Number(maxOrder.m) : 0) + 1);
    await db.exec(
      `INSERT INTO duty_people (person_key, name, role, color, wash, initial, dot, kind, sort_order, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [newKey, name.trim(), role || '', color || pal.color, wash || pal.wash, initial || name.trim().slice(0, 1), dot, kind, order, nowBKK()]);
    await refreshPeopleCache();
    res.json({ success: true, key: newKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ปิดใช้งานคน (soft delete — ไม่ลบสถานะเก่า)
app.post('/api/duty/person/delete', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key จำเป็น' });
  try {
    await db.exec('UPDATE duty_people SET active = 0 WHERE person_key = ?', [key]);
    await refreshPeopleCache();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// upsert งาน (node ในเช็กลิสต์) — สร้างใหม่ (บนสุด/เป็นลูก) หรือแก้ชื่อ/mono
app.post('/api/duty/routine', async (req, res) => {
  const { id, personKey, parentId, title, mono, sortOrder, machine, goal, method, ownerRole, coOwnerRole, assigneeKey, freq } = req.body;
  // ช่องของโซนซ่อมบำรุง — ไม่ส่งมา = ไม่แตะของเดิม (งานของทีมกะไม่ได้ใช้ช่องพวกนี้)
  const role = (v) => (['mt', 'op', 'qc', 'pd'].includes(v) ? v : null);
  // ความถี่: ค่านอกรายการ = ทิ้ง (ว่าง = ทุกวัน เหมือนพฤติกรรมเดิม)
  const freqOk = (v) => (['daily', 'weekly', 'monthly', 'quarterly', 'onuse', 'onissue'].includes(v) ? v : null);
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title จำเป็น' });
  try {
    if (id) {
      const cur = (await dbAll('SELECT * FROM duty_routines WHERE id = ?', [id]))[0];
      if (!cur) return res.status(404).json({ error: 'ไม่พบงานนี้' });
      // ย้ายงานให้คนอื่น: เปลี่ยน person_key ได้ก็ต่อเมื่อ node_key ไม่ชนกับงานของคนปลายทาง
      // ⚠️ ประวัติติ๊กของวันก่อน ๆ ยังผูกกับคนเดิม (routine_state อ้าง assignee+node_key) — ตั้งใจ ไม่ย้อนแก้อดีต
      let owner = cur.person_key;
      if (assigneeKey && assigneeKey !== cur.person_key) {
        const clash = await dbAll('SELECT id FROM duty_routines WHERE person_key = ? AND node_key = ? AND active = 1',
          [assigneeKey, cur.node_key]);
        if (clash.length) return res.status(409).json({ error: 'คนปลายทางมีงานรหัสนี้อยู่แล้ว' });
        owner = assigneeKey;
      }
      await db.exec(`UPDATE duty_routines SET person_key = ?, title = ?, mono = ?, sort_order = ?,
           machine = ?, goal = ?, method = ?, owner_role = ?, co_owner_role = ?, freq = ? WHERE id = ?`,
        // mono ไม่ส่งมา = ไม่แตะของเดิม — ตัวเรียกที่ส่งแค่ title/assigneeKey (ย้ายเจ้าของจากกระดาน)
        // จะได้ไม่ล้างธง mono ของงานเดิมทิ้งเงียบ ๆ
        [owner, title.trim(), mono !== undefined ? (mono ? 1 : 0) : (cur.mono ? 1 : 0),
         sortOrder != null ? sortOrder : cur.sort_order,
         machine !== undefined ? (machine || null) : cur.machine,
         goal !== undefined ? (goal || null) : cur.goal,
         method !== undefined ? (method || null) : cur.method,
         ownerRole !== undefined ? role(ownerRole) : cur.owner_role,
         coOwnerRole !== undefined ? role(coOwnerRole) : cur.co_owner_role,
         freq !== undefined ? freqOk(freq) : cur.freq, id]);
      invalidateRoutineCache();
      return res.json({ success: true, id });
    }
    if (!personKey) return res.status(400).json({ error: 'personKey จำเป็น' });
    // node_key ต้องไม่ซ้ำใน sibling เดียวกัน (เพื่อ path ที่ derive ไม่ชน)
    const sibs = await dbAll(
      parentId ? 'SELECT node_key FROM duty_routines WHERE person_key = ? AND parent_id = ?'
               : 'SELECT node_key FROM duty_routines WHERE person_key = ? AND parent_id IS NULL',
      parentId ? [personKey, parentId] : [personKey]);
    const nodeKey = slugKey(title, sibs.map(s => s.node_key));
    const maxOrder = (await dbAll(
      parentId ? 'SELECT MAX(sort_order) AS m FROM duty_routines WHERE person_key = ? AND parent_id = ?'
               : 'SELECT MAX(sort_order) AS m FROM duty_routines WHERE person_key = ? AND parent_id IS NULL',
      parentId ? [personKey, parentId] : [personKey]))[0];
    const order = sortOrder != null ? sortOrder : ((maxOrder && maxOrder.m != null ? Number(maxOrder.m) : -1) + 1);
    const r = await dbRun(
      `INSERT INTO duty_routines (person_key, parent_id, node_key, title, mono, sort_order, active, created_at,
         machine, goal, method, owner_role, co_owner_role, freq)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [personKey, parentId || null, nodeKey, title.trim(), mono ? 1 : 0, order, nowBKK(),
       machine || null, goal || null, method || null, role(ownerRole), role(coOwnerRole), freqOk(freq)]);
    invalidateRoutineCache();
    res.json({ success: true, id: r.lastID, nodeKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ลบงาน (soft delete node + ลูกทั้งหมด)
app.post('/api/duty/routine/delete', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  try {
    // เก็บ id ทั้งกิ่ง (BFS) แล้ว soft delete
    const all = await dbAll('SELECT id, parent_id FROM duty_routines WHERE active = 1', []);
    const toDel = [Number(id)];
    for (let i = 0; i < toDel.length; i++) {
      for (const r of all) if (Number(r.parent_id) === toDel[i]) toDel.push(Number(r.id));
    }
    for (const did of toDel) await db.exec('UPDATE duty_routines SET active = 0 WHERE id = ?', [did]);
    invalidateRoutineCache();
    res.json({ success: true, removed: toDel.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ตั้ง/เปลี่ยน "รูปอ้างอิง" ของหัวข้อหน้าที่ — ผูกกับหัวข้อ (duty_routines) ไม่ใช่รายวัน
// ตั้งครั้งแรกได้เลย · ถ้ามีอยู่แล้วต้องส่ง replace=true (ให้ client ถามยืนยันก่อน) กันทับโดยไม่ตั้งใจ
app.post('/api/duty/routine/ref-image', async (req, res) => {
  const { id, image, operator, replace } = req.body;
  if (!id || !image) return res.status(400).json({ error: 'id/image จำเป็น' });
  if (typeof image !== 'string' || !(image.startsWith('http') || image.startsWith('data:')))
    return res.status(400).json({ error: 'image ต้องเป็น URL หรือ data URL' });
  try {
    const cur = (await dbAll("SELECT CASE WHEN ref_image IS NULL OR ref_image = '' THEN 0 ELSE 1 END AS has_ref FROM duty_routines WHERE id = ? AND active = 1", [id]))[0];
    if (!cur) return res.status(404).json({ error: 'ไม่พบหัวข้อนี้' });
    if (cur.has_ref && !replace) return res.status(409).json({ error: 'exists' });
    await db.exec('UPDATE duty_routines SET ref_image = ?, ref_image_by = ?, ref_image_at = ? WHERE id = ?',
      [image, operator || null, nowBKK(), id]);
    invalidateRoutineCache(); // สำคัญ: ต้นไม้ routine ถูก cache ไว้ ไม่ล้างแล้วรูปใหม่จะไม่ขึ้น
    res.json({ success: true, replaced: !!cur.has_ref });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ประวัติ %ความคืบหน้าทีมต่อวัน — reuse โดย /api/duty/history และ /api/kpi/summary (KPI data layer)
async function buildDutyRange(from, to) {
  const days = [];
  const d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  let guard = 0;
  while (d <= end && guard++ < 366) {
    const ds = d.toISOString().slice(0, 10);
    const duty = await buildDuty(ds);
    // นับเฉพาะวันที่มีความเคลื่อนไหว เพื่อไม่ให้ heatmap เต็มไปด้วย 0%
    const active = duty.team.done > 0 || duty.people.some(p => p.received.length || p.adhoc.length || p.nodes.some(n => n.bypassed));
    days.push({ date: ds, pct: duty.team.pct, done: duty.team.done, total: duty.team.total, active });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ประวัติ %ความคืบหน้าทีมต่อวัน (สำหรับ heatmap ปฏิทิน + กราฟแนวโน้ม)
app.get('/api/duty/history', async (req, res) => {
  const to = req.query.to || todayBKK();
  const from = req.query.from || to;
  try { res.json({ from, to, days: await buildDutyRange(from, to) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ต้นสัปดาห์ ISO (จันทร์ 06:00 = ต้นสัปดาห์ ให้ตรงกับกฎวันทำงาน 06:00→06:00) ─
function isoWeekStart(dateStr) {
  const wd = weekdayOf(dateStr); // 0=อา..6=ส
  const diff = wd === 0 ? -6 : 1 - wd;
  return addDaysStr(dateStr, diff);
}

// ดึงแถวผลิตดิบในช่วงวันทำงาน [from, to] (06:00→06:00) ด้วยการเทียบ timestamp แบบ TEXT ตรงๆ
// (pattern เดียวกับ buildShiftCardData — ใช้ได้ทั้ง SQLite/Postgres ไม่มีฟังก์ชัน date เฉพาะ dialect)
// แล้ว bucket เป็น work_day ด้วย JS ตามกฎเดียวกับ workDayBKK() (ก่อน 06:00 = วันก่อนหน้า)
async function fetchProductionByWorkday(from, to) {
  const rangeStart = `${from}T06:00:00`, rangeEnd = `${addDaysStr(to, 1)}T06:00:00`;
  const rows = await dbAll('SELECT timestamp, line_name, flavor FROM production_logs WHERE timestamp >= ? AND timestamp < ?', [rangeStart, rangeEnd]);
  const countMap = {};
  for (const r of rows) {
    const t = String(r.timestamp || '');
    const day = t.slice(0, 10), hour = Number(t.slice(11, 13));
    const workDay = hour < 6 ? addDaysStr(day, -1) : day;
    const k = `${workDay}||${r.line_name}||${r.flavor}`;
    countMap[k] = (countMap[k] || 0) + 1;
  }
  return Object.entries(countMap).map(([k, actual]) => {
    const [work_day, line_name, flavor] = k.split('||');
    return { work_day, line_name, flavor, actual };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// buildKpiRange — KPI data layer: รวมผลิต+CIP ข้ามช่วงวันที่ใดๆ (bucket ด้วยกฎ
// วันทำงาน 06:00→06:00) ให้ Phase 2 (Telegram digest), Phase 3 (dashboard),
// Phase 4 (alert) เรียกใช้ร่วมกัน
// ═══════════════════════════════════════════════════════════════════════════
async function buildKpiRange(from, to) {
  const [prodRows, planRows] = await Promise.all([
    fetchProductionByWorkday(from, to),
    dbAll(
      `SELECT plan_date, line_name, flavor, SUM(planned_batches) planned
       FROM production_plans WHERE plan_date BETWEEN ? AND ? GROUP BY plan_date, line_name, flavor`, [from, to]),
  ]);
  // CIP: ตารางเล็ก loop ต่อวันในสเกลสัปดาห์/เดือนได้สบาย (ไม่ใช่จุดคอขวด)
  const cipDays = []; { let d = from, guard = 0;
    while (d <= to && guard++ < 366) { cipDays.push(d); d = addDaysStr(d, 1); } }
  const cipResults = await Promise.all(cipDays.map(async (day) => ({ day, ...(await cipRoundsForDate(day)) })));

  const total = prodRows.reduce((s, r) => s + Number(r.actual), 0);
  const planned = planRows.reduce((s, r) => s + Number(r.planned || 0), 0);

  const byDayMap = {};
  const dayBucket = (key) => byDayMap[key] || (byDayMap[key] = { workDay: key, actual: 0, planned: 0 });
  for (const r of prodRows) dayBucket(r.work_day).actual += Number(r.actual);
  for (const r of planRows) dayBucket(r.plan_date).planned += Number(r.planned || 0);
  const byDay = Object.values(byDayMap).sort((a, b) => a.workDay.localeCompare(b.workDay));

  const byLineMap = {}, byFlavorMap = {};
  for (const r of prodRows) {
    byLineMap[r.line_name] = (byLineMap[r.line_name] || 0) + Number(r.actual);
    byFlavorMap[r.flavor] = (byFlavorMap[r.flavor] || 0) + Number(r.actual);
  }
  const byLine = Object.entries(byLineMap).map(([line_name, actual]) => ({ line_name, actual })).sort((a, b) => b.actual - a.actual);
  const byFlavor = Object.entries(byFlavorMap).map(([flavor, actual]) => ({ flavor, actual })).sort((a, b) => b.actual - a.actual);

  // รวมยอดจริง/แผนต่อ (ไลน์+รสชาติ) ตลอดทั้งช่วง — ใช้หา "ไลน์ที่ควรจับตา" ในการ์ด KPI/แจ้งเตือน
  const lfMap = {};
  const lfBucket = (line, flavor) => { const k = `${line}||${flavor}`; return lfMap[k] || (lfMap[k] = { line_name: line, flavor, actual: 0, planned: 0 }); };
  for (const r of prodRows) lfBucket(r.line_name, r.flavor).actual += Number(r.actual);
  for (const r of planRows) lfBucket(r.line_name, r.flavor).planned += Number(r.planned || 0);
  const byLineFlavor = Object.values(lfMap).sort((a, b) => a.line_name.localeCompare(b.line_name) || a.flavor.localeCompare(b.flavor));

  const cipByLine = { 'Line 1': 0, 'Line 2': 0, 'Line 3': 0 };
  const cipByDay = [];
  let totalRounds = 0;
  for (const d of cipResults) {
    const dayCip = Object.values(d.cip).reduce((a, b) => a + Number(b || 0), 0)
      + Object.values(d.backwash || {}).reduce((a, b) => a + Number(b || 0), 0);
    if (dayCip > 0) cipByDay.push({ workDay: d.day, rounds: dayCip });
    totalRounds += dayCip;
    for (const L of ['Line 1', 'Line 2', 'Line 3']) cipByLine[L] += Number(d.cip[L] || 0) + Number(d.backwash?.[L] || 0);
  }

  return {
    from, to,
    production: { total, planned, pct: planned > 0 ? Math.round((total / planned) * 100) : null, byDay, byLine, byFlavor, byLineFlavor },
    cip: { totalRounds, byLine: cipByLine, byDay: cipByDay },
  };
}

// GET /api/kpi/summary?from=&to= — endpoint กลางของ KPI data layer (production+CIP+duty ข้ามช่วงวันที่)
app.get('/api/kpi/summary', async (req, res) => {
  const to = req.query.to || workDayBKK();
  const from = req.query.from || to;
  try {
    const [kpi, duty] = await Promise.all([buildKpiRange(from, to), buildDutyRange(from, to)]);
    res.json({ ...kpi, duty });
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

// โหลดรูปมาเป็น data: URI — resvg ฝัง <image> ได้เฉพาะ data URI (ดาวน์โหลด URL เองไม่ได้)
async function fetchAsDataUri(src) {
  if (!src || typeof src !== 'string') return null;
  if (src.startsWith('data:')) return src;
  if (!/^https?:\/\//.test(src)) return null;
  const r = await axios.get(src, { responseType: 'arraybuffer', timeout: 15000 });
  const mime = r.headers['content-type'] || 'image/jpeg';
  return `data:${mime};base64,${Buffer.from(r.data).toString('base64')}`;
}

// ส่งการ์ด "ก่อนทำ | หลังทำ" เข้า Telegram — รูป + ข้อความรวมอยู่ในภาพเดียว
// เพื่อให้ forward ต่อเข้ากลุ่ม Line แล้วรูปกับข้อความไม่หลุดจากกัน (album ผูก caption กับรูปแรกเท่านั้น)
// กติกา: 1 งาน = 1 การ์ด — ห้ามเอารูปของงานอื่น/คนอื่นมารวมใบเดียวกัน
// pairList = [{label, before, after}] → การ์ดโหมดจับคู่ตามจุด (ใช้แทน beforeImage/afterImages)
// ห่อด้วย inTopic เพื่อให้ทุกท่อนที่ส่งข้างใน (รูป/ข้อความ/fallback) ไปกลุ่มเดียวกันหมด
const sendBeforeAfterCard = (a) => inTopic(a.topic || 'duty', () => _sendBeforeAfterCard(a));
async function _sendBeforeAfterCard({ date, personKey, title, kicker, beforeImage, beforeSub, afterImages, pairList, operator, footerExtra }) {
  if (!tgChatId()) return;
  const who = dutyName(personKey);
  const timeLabel = `${nowBKK().slice(11, 16)} น.`;
  const afters = (afterImages || []).filter(Boolean);
  const usePairs = Array.isArray(pairList) && pairList.length > 1;   // จุดเดียวใช้เลย์เอาต์ปกติสวยกว่า
  const countTxt = usePairs ? ` (${pairList.length} จุด)` : (afters.length > 1 ? ` (${afters.length} รูป)` : '');
  const caption = `✅ <b>${escapeHtml(who)}</b> ทำ "${escapeHtml(title)}" เสร็จแล้ว${countTxt}\n🗓 ${thaiDate(date)} · ${timeLabel}`;
  try {
    let cardData;
    if (usePairs) {
      // โหลดเฉพาะ 4 จุดแรกที่จะโชว์ — ที่เหลือขึ้นเป็น "+ อีก N จุด"
      const shown = pairList.slice(0, 4);
      const loaded = await Promise.all(shown.map(async p => ({
        label: p.label,
        beforeUri: await fetchAsDataUri(p.before),
        afterUri: await fetchAsDataUri(p.after),
      })));
      cardData = { pairs: [...loaded, ...pairList.slice(4)] };   // ตัวที่เกิน 4 ส่งไปแค่ให้นับจำนวน
    } else {
      const uris = await Promise.all([fetchAsDataUri(beforeImage), ...afters.slice(0, 4).map(fetchAsDataUri)]);
      cardData = { beforeUri: uris[0], beforeSub, afterUris: uris.slice(1).filter(Boolean), afterTotal: afters.length };
    }
    let footer = footerExtra || '';
    try {
      const duty = await buildDuty(date);
      const teamTxt = `ทีมวันนี้ ${duty.team.done}/${duty.team.total} งาน · ${duty.team.pct}%`;
      footer = footerExtra ? `${footerExtra} · ${teamTxt}` : teamTxt;
    } catch { /* ไม่มีสรุปทีมก็ยังส่งการ์ดได้ */ }
    const png = renderBeforeAfterCardPNG({
      title, personName: who, dateLabel: thaiDate(date), timeLabel, kicker,
      footer, by: operator || who, ...cardData,
    });
    if (png) return await sendPhotoBufferToTelegram(png, 'image/png', caption);
  } catch (e) {
    console.error('[card] เรนเดอร์การ์ดไม่สำเร็จ → ถอยไปส่งแบบอัลบั้ม:', e.message);
  }
  // fallback: ส่งรูปแบบเดิม — caption อาจหลุดตอนแชร์ต่อ แต่ดีกว่าเงียบหาย
  const flat = usePairs ? pairList.flatMap(p => [p.before, p.after]) : [beforeImage, ...afters];
  await sendPhotosToTelegram(flat.filter(Boolean), caption);
}

// งานประจำ: รูปก่อนทำ = รูปอ้างอิงของหัวข้อนั้น (ตั้งไว้ครั้งเดียว ใช้ทุกวัน)
async function sendRoutineDoneCard({ date, assignee, nodeKey, title, doneImage, routineId, operator }) {
  let refImage = null;
  if (routineId) {
    const row = (await dbAll('SELECT ref_image FROM duty_routines WHERE id = ?', [routineId]))[0];
    refImage = row ? row.ref_image : null;
  }
  return sendBeforeAfterCard({
    date, personKey: assignee, title: title || nodeKey, kicker: 'บันทึกผลงานประจำ',
    beforeImage: refImage, afterImages: [doneImage], operator,
    topic: dutyTopic(null, assignee),   // งานประจำของทีมผลิต → กลุ่มผลิต · ของช่าง → กลุ่มช่าง
  });
}

// งานมอบหมาย: จับคู่ตามจุด — photo_specs[i] คู่กับ images[i] (ก่อนทำ) และ done_images[i] (หลังทำ)
// พื้นที่เดียวหลายจุด จะได้เห็นชัดว่ารูปไหนคู่กับรูปไหน
async function sendAdhocDoneCard(taskId, operator) {
  const row = (await dbAll('SELECT task_date, title, assignee, images, done_images, done_by, photo_specs, machine, location, reporter, audit_batch FROM daily_tasks WHERE id = ?', [taskId]))[0];
  if (!row) return;
  const specs = parsePhotoSpecs(row.photo_specs);
  const befores = parseImgsAligned(row.images);
  const afters = parseImgs(row.done_images);
  const pairList = specs.map((label, i) => ({ label, before: befores[i] || null, after: afters[i] || null }));
  // หัวการ์ดบอกบริบท: พื้นที่ · สถานที่ — ให้คนอ่านในกลุ่มรู้ว่างานนี้ของเครื่องไหน ตรงไหน
  const where = [row.machine, row.location].filter(Boolean).join(' · ');
  return sendBeforeAfterCard({
    date: row.task_date || todayBKK(), personKey: row.assignee, title: row.title || '',
    kicker: where || 'บันทึกผลงานมอบหมาย', beforeSub: 'ตอนมอบงาน',
    beforeImage: befores[0] || null, afterImages: afters,   // ใช้ตอนมีจุดเดียว
    pairList, operator: operator || row.done_by || '',
    footerExtra: row.reporter ? `แจ้งโดย ${dutyName(row.reporter)}` : '',
    topic: dutyTopic(row.audit_batch, row.assignee),   // การ์ดเข้ากลุ่มเดียวกับตอนมอบงาน
  });
}

// แนบ "รูปหลังทำ" ของงานประจำ — รายวัน เปลี่ยนทับได้ตลอด
// แนบแล้ว = ทำเสร็จ → ติ๊ก checked ให้เลย (ให้สอดคล้องกับงานมอบหมายที่ doneImages → status='done')
// แล้วส่งการ์ดรูปคู่ (ก่อน|หลัง) เข้า Telegram — ข้อความอยู่ในภาพ แชร์ต่อเข้า Line ได้ไม่หลุดจากกัน
app.post('/api/routine/photo', async (req, res) => {
  const { date, assignee, nodeKey, title, image, operator, routineId } = req.body;
  if (!assignee || !nodeKey || !image) return res.status(400).json({ error: 'assignee/nodeKey/image จำเป็น' });
  if (typeof image !== 'string' || !(image.startsWith('http') || image.startsWith('data:')))
    return res.status(400).json({ error: 'image ต้องเป็น URL หรือ data URL' });
  const d = date || todayBKK();
  const ts = nowBKK();
  try {
    await db.exec(
      `INSERT INTO routine_state (state_date, assignee, node_key, title, checked, done_image, done_image_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(state_date, assignee, node_key)
       DO UPDATE SET checked = 1, done_image = excluded.done_image, done_image_at = excluded.done_image_at,
                     title = COALESCE(excluded.title, routine_state.title), updated_at = excluded.updated_at`,
      [d, assignee, nodeKey, title || null, image, ts, ts]);
    res.json({ success: true });
    // ส่งการ์ดหลังตอบ client ไปแล้ว — ผู้ใช้ไม่ต้องรอเรนเดอร์รูป/ยิง Telegram
    sendRoutineDoneCard({ date: d, assignee, nodeKey, title, doneImage: image, routineId, operator })
      .catch(e => console.error('[routine card] error:', e.message));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// โหลดรูปงานประจำตอนกดดู (แยกจาก list เพื่อลด egress — ใช้เฉพาะกรณี fallback base64)
// which=ref → ต้องมี id (duty_routines) · which=done → ต้องมี date/assignee/nodeKey
app.get('/api/routine/image', async (req, res) => {
  const { which, id, date, assignee, nodeKey } = req.query;
  try {
    if (which === 'ref') {
      if (!id) return res.status(400).json({ error: 'id จำเป็น' });
      const row = (await dbAll('SELECT ref_image FROM duty_routines WHERE id = ?', [id]))[0];
      return res.json({ image: (row && row.ref_image) || null });
    }
    if (!assignee || !nodeKey) return res.status(400).json({ error: 'assignee/nodeKey จำเป็น' });
    const row = (await dbAll('SELECT done_image FROM routine_state WHERE state_date = ? AND assignee = ? AND node_key = ?',
      [date || todayBKK(), assignee, nodeKey]))[0];
    res.json({ image: (row && row.done_image) || null });
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

/* ═══════════════ ใบเช็ก AM รายกะ ═══════════════════════════════════════════
   1 ใบ = 1 Line ต้ม × 1 กะ × 1 วันทำงาน · ข้อตรวจยกมาจากทะเบียน (duty_routines sheet='am')
   ต่างจากกระดานเวรตรงที่บันทึก "ผลตรวจ" (ปกติ/ไม่ปกติ+สาเหตุ+รูป) ไม่ใช่แค่ "ทำแล้ว"
   ช่างเปิดจากลิงก์ใน Telegram บนมือถือ ไม่ต้อง login                                 */

// ไลน์ที่มีใบเช็ก = เครื่องที่มีข้อตรวจ sheet='am' ผูกอยู่ (ไม่ฮาร์ดโค้ดชื่อไลน์)
async function amLines() {
  const rows = await dbAll(
    "SELECT DISTINCT machine FROM duty_routines WHERE sheet = 'am' AND active = 1 AND machine IS NOT NULL AND machine <> '' ORDER BY machine", []);
  return rows.map(r => r.machine);
}

const AM_LINE_STATUS = new Set(['inprocess', 'cip', 'idle']);

/* หาใบ (หรือสร้างถ้ายังไม่มี) แล้วคืนแถวเต็ม
   ⚠️ ต้อง dbGet หา id ใหม่เอง — db.exec ไม่คืน lastID ทั้ง 2 dialect (มีแต่ dbRun)
      และ ON CONFLICT DO NOTHING ก็ไม่คืนแถวที่มีอยู่แล้วให้                          */
async function ensureAmSheet(workDay, shift, line, by) {
  const find = async () => (await dbAll(
    'SELECT * FROM am_sheets WHERE work_day = ? AND shift = ? AND line = ?', [workDay, shift, line]))[0] || null;
  let row = await find();
  if (row) return row;
  await db.exec(
    `INSERT INTO am_sheets (work_day, shift, line, status, opened_by, opened_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?)
     ON CONFLICT (work_day, shift, line) DO NOTHING`,
    [workDay, shift, line, by || null, nowBKK(), nowBKK()]);
  return await find();
}

// ตรวจ date/shift/line ที่ client ส่งมา — client เลือก server ตรวจเสมอ
async function amCheckArgs(q) {
  const date = String(q.date || '') || workDayBKK();
  const line = String(q.line || '').trim();
  const shift = String(q.shift || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'วันที่ไม่ถูกต้อง' };
  if (!line) return { error: 'line จำเป็น' };
  if (!(await amLines()).includes(line)) return { error: `ไม่พบใบเช็กของ "${line}"` };
  if (!amShift.isValidShift(date, shift)) {
    return { error: `กะ "${shift}" ไม่ตรงกับตารางกะของวันที่ ${date} (รับได้: ${amShift.allowedShifts(date).join(', ')})` };
  }
  return { date, shift, line };
}

/* ประกอบใบ = ทะเบียน (แม่แบบ) + ผลตรวจที่บันทึกไว้ (overlay)
   ลด egress: ไม่คืน base64 ของรูปในลิสต์ ส่งแค่ธง hasPhoto ให้ client โหลดทีหลัง
   (แพทเทิร์นเดียวกับ buildDuty — รูปแนบทำ payload บวมเร็วมาก)                        */
async function buildAmSheet(workDay, shift, line, by) {
  const sheet = await ensureAmSheet(workDay, shift, line, by);
  const routines = await dbAll(
    `SELECT id, node_key, title, goal, method, sort_order
       FROM duty_routines WHERE sheet = 'am' AND active = 1 AND machine = ?
      ORDER BY sort_order, id`, [line]);
  const saved = await dbAll(
    `SELECT node_key, result, cause, checked_by, updated_at,
       CASE WHEN photo IS NULL OR photo = '' THEN 0 ELSE 1 END AS has_photo,
       CASE WHEN photo LIKE 'http%' THEN photo ELSE NULL END AS photo_url
     FROM am_sheet_items WHERE sheet_id = ?`, [sheet.id]);
  const bykey = {};
  for (const r of saved) bykey[r.node_key] = r;
  const items = routines.map((r, i) => {
    const st = bykey[r.node_key] || {};
    return {
      seq: i + 1, nodeKey: r.node_key, routineId: r.id,
      title: r.title, goal: r.goal || '', method: r.method || '',
      result: st.result || null, cause: st.cause || '',
      hasPhoto: !!st.has_photo, photoUrl: st.photo_url || null,
      checkedBy: st.checked_by || '', updatedAt: st.updated_at || '',
    };
  });
  const ok = items.filter(i => i.result === 'ok').length;
  const ng = items.filter(i => i.result === 'ng').length;
  return {
    sheet: {
      id: sheet.id, workDay: sheet.work_day, shift: sheet.shift, line: sheet.line,
      lineStatus: sheet.line_status || '', status: sheet.status || 'draft',
      submittedBy: sheet.submitted_by || '', submittedAt: sheet.submitted_at || '',
    },
    shifts: amShift.allowedShifts(sheet.work_day),
    items,
    summary: { total: items.length, ok, ng, left: items.length - ok - ng },
  };
}

// เปิดใบ (หน้าเว็บ/แอดมิน) — ต้องระบุ date/shift/line เอง
app.get('/api/am-sheet', async (req, res) => {
  try {
    const a = await amCheckArgs(req.query);
    if (a.error) return res.status(400).json({ error: a.error });
    res.json(await buildAmSheet(a.date, a.shift, a.line, req.query.by));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* เปิดจากลิงก์ใน Telegram — เซิร์ฟเวอร์หาวันทำงาน+กะปัจจุบันให้เอง
   ช่างกดลิงก์เดียวได้ทั้งกะเช้า/บ่าย/ดึก ไม่ต้องมีลิงก์แยกต่อกะ                        */
app.get('/api/am-sheet/open/:token', async (req, res) => {
  try {
    const link = (await dbAll('SELECT * FROM am_sheet_links WHERE token = ? AND active = 1', [req.params.token]))[0];
    if (!link) return res.status(404).json({ error: 'ลิงก์นี้ใช้ไม่ได้แล้ว — ขอลิงก์ใหม่จากหัวหน้า' });
    const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const info = amShift.shiftInfo(bkk.slice(0, 10), Number(bkk.slice(11, 13)));
    const shift = info.shift || 'OT';        // นอกเวลากะ (เช่นเสาร์) ยังกรอกได้ในชื่อ OT
    await db.exec('UPDATE am_sheet_links SET last_used_at = ? WHERE token = ?', [nowBKK(), req.params.token]);
    const data = await buildAmSheet(info.workDay, shift, link.line, req.query.by);
    res.json({ ...data, token: req.params.token, holiday: info.holiday });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══════════ ดูใบเช็กย้อนหลัง — มุมมองรายเดือน (ตารางเหมือนใบกระดาษ) ═══════════
   ตอบคำถามที่ใบกระดาษเคยตอบได้แต่ระบบยังตอบไม่ได้: "เดือนนี้กะไหนไม่มีใครกรอกบ้าง"
   1 แถว = 1 วันทำงาน · 1 ช่อง = 1 กะ (จ–พฤ 3 กะ · ศ/อา 2 กะ · เสาร์ปกติหยุด)

   🔴 ห้ามเรียก buildAmSheet/ensureAmSheet ตรงนี้เด็ดขาด — สองตัวนั้น "เปิดใบให้ถ้ายังไม่มี"
      เปิดดูย้อนหลังเดือนเดียวจะสร้างใบร่างเปล่าเป็นร้อยใบ แล้ว **ช่องว่างที่แปลว่า
      "กะนั้นไม่มีใครกรอก" จะกลายเป็นใบร่างทั้งเดือน** = ตัวเลขที่ต้องใช้ตามงานหายเกลี้ยง
      (เส้นนี้อ่านอย่างเดียวล้วน ๆ ทุกคำสั่ง)                                            */
const daysInMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

async function buildAmMonth(month, line) {
  const nDays = daysInMonth(month);
  const first = `${month}-01`;
  const last = `${month}-${String(nDays).padStart(2, '0')}`;
  const sheets = await dbAll(
    `SELECT id, work_day, shift, line_status, status, submitted_by, submitted_at
       FROM am_sheets WHERE line = ? AND work_day >= ? AND work_day <= ?`, [line, first, last]);

  // นับผลตรวจของทุกใบในเดือนด้วยคำสั่งเดียว — ยิงทีละใบคือ 90 คำสั่งต่อการเปิดหน้า 1 ครั้ง
  const counts = sheets.length
    ? await dbAll(
      `SELECT sheet_id, result, COUNT(*) AS n FROM am_sheet_items
        WHERE result IS NOT NULL AND sheet_id IN (${sheets.map(() => '?').join(',')})
        GROUP BY sheet_id, result`, sheets.map(s => s.id))
    : [];
  const cnt = {};
  for (const c of counts) {
    const k = String(c.sheet_id);
    cnt[k] = cnt[k] || { ok: 0, ng: 0 };
    if (c.result === 'ok' || c.result === 'ng') cnt[k][c.result] = Number(c.n) || 0;
  }
  // จำนวนข้อตรวจ "ตอนนี้" ของไลน์นี้ — ใบที่ส่งแล้วใช้ยอดของใบเองแทน (ทะเบียนอาจถูกแก้ทีหลัง)
  const total = Number((await dbGet(
    "SELECT COUNT(*) AS n FROM duty_routines WHERE sheet = 'am' AND active = 1 AND machine = ?", [line]))?.n || 0);

  const byKey = {};
  for (const sh of sheets) byKey[`${sh.work_day}|${sh.shift}`] = sh;

  const days = [];
  let filled = 0, expected = 0, ngTotal = 0;
  for (let d = 1; d <= nDays; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const wd = amShift.weekdayOf(date);
    const planned = amShift.shiftsForWeekday(wd).map(x => x.key);
    /* เสาร์ (หรือวันที่ไม่มีกะ) ไม่นับเป็น "ขาด" แต่ถ้ามีคนมาทำ OT แล้วกรอกไว้ ต้องโชว์
       ไม่งั้นใบที่กรอกจริงหายไปจากตารางเฉย ๆ ซึ่งแย่กว่าตารางมีช่องเกิน                */
    const extra = sheets.filter(x => x.work_day === date && !planned.includes(x.shift)).map(x => x.shift);
    const shiftKeys = [...planned, ...Array.from(new Set(extra))];
    const cells = shiftKeys.map(shift => {
      const sh = byKey[`${date}|${shift}`];
      const isPlanned = planned.includes(shift);
      if (isPlanned) expected += 1;
      if (!sh) return { shift, planned: isPlanned, state: 'none' };
      const c = cnt[String(sh.id)] || { ok: 0, ng: 0 };
      const answered = c.ok + c.ng;
      const submitted = (sh.status || 'draft') === 'submitted';
      if (submitted && isPlanned) filled += 1;
      ngTotal += c.ng;
      return {
        shift, planned: isPlanned, id: sh.id,
        state: submitted ? (c.ng > 0 ? 'ng' : 'ok') : 'draft',
        ok: c.ok, ng: c.ng, answered,
        total: submitted ? answered : total,
        lineStatus: sh.line_status || '',
        submittedBy: sh.submitted_by || '', submittedAt: sh.submitted_at || '',
      };
    });
    days.push({ day: d, date, weekday: wd, holiday: planned.length === 0, cells });
  }
  return { month, line, days, summary: { expected, filled, missing: expected - filled, ng: ngTotal, total } };
}

// ตารางรายเดือนของไลน์เดียว — อ่านอย่างเดียว ไม่เปิดใบใหม่
app.get('/api/am-sheet/month', async (req, res) => {
  try {
    const month = String(req.query.month || '').trim() || workDayBKK().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'เดือนต้องเป็นรูปแบบ YYYY-MM' });
    const lines = await amLines();
    const line = String(req.query.line || '').trim() || lines[0] || '';
    if (!line) return res.json({ month, line: '', lines, days: [], summary: { expected: 0, filled: 0, missing: 0, ng: 0, total: 0 } });
    if (!lines.includes(line)) return res.status(400).json({ error: `ไม่พบใบเช็กของ "${line}"` });
    res.json({ ...(await buildAmMonth(month, line)), lines });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* เปิดดูใบที่กรอกไปแล้ว 1 ใบ — อ่านอย่างเดียว
   อ่านหัวข้อจาก am_sheet_items (snapshot ตอนกรอก) ไม่ใช่จากทะเบียนปัจจุบัน
   ทะเบียนถูกแก้/ลบทีหลังได้ ใบเก่าต้องยังอ่านรู้เรื่องว่าวันนั้นตรวจอะไรไปบ้าง            */
app.get('/api/am-sheet/view', async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: 'id จำเป็น' });
    const sheet = await dbGet('SELECT * FROM am_sheets WHERE id = ?', [id]);
    if (!sheet) return res.status(404).json({ error: 'ไม่พบใบนี้' });
    const rows = await dbAll(
      `SELECT node_key, title, result, cause, checked_by, updated_at,
         CASE WHEN photo IS NULL OR photo = '' THEN 0 ELSE 1 END AS has_photo,
         CASE WHEN photo LIKE 'http%' THEN photo ELSE NULL END AS photo_url
       FROM am_sheet_items WHERE sheet_id = ?`, [id]);
    // เรียงตามลำดับในทะเบียน ข้อที่ถูกลบออกจากทะเบียนแล้วไปต่อท้าย (ยังต้องเห็น)
    const ord = {};
    for (const r of await dbAll(
      "SELECT node_key, sort_order, id FROM duty_routines WHERE sheet = 'am' AND machine = ?", [sheet.line])) {
      ord[r.node_key] = Number(r.sort_order ?? r.id ?? 0);
    }
    const items = rows
      .map(r => ({
        nodeKey: r.node_key, title: r.title || r.node_key,
        result: r.result || null, cause: r.cause || '',
        hasPhoto: !!r.has_photo, photoUrl: r.photo_url || null,
        checkedBy: r.checked_by || '', updatedAt: r.updated_at || '',
        gone: !(r.node_key in ord),            // ข้อนี้ถูกเอาออกจากทะเบียนไปแล้ว
      }))
      .sort((a, b) => (ord[a.nodeKey] ?? 1e9) - (ord[b.nodeKey] ?? 1e9))
      .map((x, i) => ({ seq: i + 1, ...x }));
    res.json({
      sheet: {
        id: sheet.id, workDay: sheet.work_day, shift: sheet.shift, line: sheet.line,
        lineStatus: sheet.line_status || '', status: sheet.status || 'draft',
        submittedBy: sheet.submitted_by || '', submittedAt: sheet.submitted_at || '',
      },
      items,
      summary: {
        total: items.length,
        ok: items.filter(i => i.result === 'ok').length,
        ng: items.filter(i => i.result === 'ng').length,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// สถานะไลน์ระหว่างกะ — บันทึกไว้เฉย ๆ ไม่ซ่อนข้อตรวจ (ตามที่เคาะไว้)
app.post('/api/am-sheet/line-status', async (req, res) => {
  if (rateLimited(req.ip, 60, 60000, 'amsheet-line')) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  try {
    const a = await amCheckArgs(req.body || {});
    if (a.error) return res.status(400).json({ error: a.error });
    const st = String((req.body || {}).status || '');
    if (!AM_LINE_STATUS.has(st)) return res.status(400).json({ error: 'สถานะไลน์ไม่ถูกต้อง' });
    const sheet = await ensureAmSheet(a.date, a.shift, a.line, (req.body || {}).by);
    await db.exec('UPDATE am_sheets SET line_status = ?, updated_at = ? WHERE id = ?', [st, nowBKK(), sheet.id]);
    res.json({ success: true, lineStatus: st });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* บันทึกผลตรวจ 1 ข้อ
   result: 'ok' ปกติ · 'ng' ไม่ปกติ (บังคับมี cause) · null = ล้างกลับเป็นยังไม่ตรวจ
   เปลี่ยนจาก ng → ok ต้องล้าง cause/photo ไม่งั้นเหลือสาเหตุค้างอยู่บนข้อที่บอกว่าปกติ   */
app.post('/api/am-sheet/item', async (req, res) => {
  if (rateLimited(req.ip, 300, 60000, 'amsheet-item')) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  const b = req.body || {};
  try {
    const a = await amCheckArgs(b);
    if (a.error) return res.status(400).json({ error: a.error });
    const nodeKey = String(b.nodeKey || '').trim();
    if (!nodeKey) return res.status(400).json({ error: 'nodeKey จำเป็น' });
    const routine = (await dbAll(
      "SELECT id, title FROM duty_routines WHERE sheet = 'am' AND active = 1 AND node_key = ? AND machine = ?",
      [nodeKey, a.line]))[0];
    if (!routine) return res.status(404).json({ error: 'ไม่พบข้อตรวจนี้ในทะเบียนของไลน์นี้' });

    const result = b.result === 'ok' || b.result === 'ng' ? b.result : null;
    const cause = result === 'ng' ? String(b.cause || '').trim() : null;
    if (result === 'ng' && !cause) {
      return res.status(400).json({ error: 'ข้อที่ไม่ปกติต้องระบุสาเหตุด้วย' });
    }
    // รับทั้ง URL (อัป Supabase แล้ว) และ data: (เครื่องไม่มี Supabase) — ยกกติกาจาก /api/routine/photo
    let photo = result === 'ng' ? (typeof b.photo === 'string' ? b.photo : '') : '';
    if (photo && !(photo.startsWith('http') || photo.startsWith('data:'))) {
      return res.status(400).json({ error: 'รูปไม่ถูกต้อง — ลองแนบใหม่อีกครั้ง' });
    }
    const sheet = await ensureAmSheet(a.date, a.shift, a.line, b.by);
    if ((sheet.status || 'draft') === 'submitted') {
      return res.status(409).json({ error: 'ใบนี้ส่งรายงานไปแล้ว แก้ไม่ได้' });
    }
    await db.exec(
      `INSERT INTO am_sheet_items (sheet_id, node_key, routine_id, title, result, cause, photo, photo_at, checked_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sheet_id, node_key) DO UPDATE SET
         result = EXCLUDED.result, cause = EXCLUDED.cause, photo = EXCLUDED.photo,
         photo_at = EXCLUDED.photo_at, checked_by = EXCLUDED.checked_by, updated_at = EXCLUDED.updated_at`,
      [sheet.id, nodeKey, routine.id, routine.title, result, cause, photo || null,
       photo ? nowBKK() : null, b.by || null, nowBKK()]);
    await db.exec('UPDATE am_sheets SET updated_at = ? WHERE id = ?', [nowBKK(), sheet.id]);
    // คืนแค่ยอดสรุป ไม่คืนทั้งใบ — ช่างแตะ 15-17 ครั้งต่อกะบนเน็ตมือถือ (ลด egress)
    const cnt = await dbAll(
      "SELECT result, COUNT(*) AS n FROM am_sheet_items WHERE sheet_id = ? AND result IS NOT NULL GROUP BY result",
      [sheet.id]);
    const nOf = (k) => Number((cnt.find(x => x.result === k) || {}).n || 0);
    const total = (await dbAll(
      "SELECT COUNT(*) AS n FROM duty_routines WHERE sheet = 'am' AND active = 1 AND machine = ?", [a.line]))[0].n;
    const ok = nOf('ok'), ng = nOf('ng');
    res.json({ success: true, summary: { total: Number(total), ok, ng, left: Number(total) - ok - ng } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ส่งรายงาน — ปิดใบ แล้วเปิดใบแจ้งซ่อมให้ข้อที่ "ไม่ปกติ"
   ทำตอนกดส่งเท่านั้น ไม่ใช่ตอนติ๊ก (ให้ช่างกรอกสาเหตุ+รูปให้ครบก่อน)
   🔑 กันเปิดใบซ้ำด้วย ref_key = 'am:<ไลน์>:<nodeKey>' — ห้ามใส่วันที่/กะลงใน key
      เพราะข้อเดิมของไลน์เดิมที่ยังไม่ปิด ต้องเป็นใบเดียวกันข้ามกะ (เจอซ้ำ = ต่อในใบเดิม) */
const amRefKey = (line, nodeKey) => `am:${line}:${nodeKey}`;

async function amOpenRepairs(sheet, items, by) {
  const opened = [], repeated = [];
  for (const it of items.filter(x => x.result === 'ng')) {
    const refKey = amRefKey(sheet.line, it.nodeKey);
    const cur = (await dbAll(
      "SELECT id, symptom FROM incidents WHERE ref_key = ? AND COALESCE(status, 'open') <> 'closed' ORDER BY id DESC",
      [refKey]))[0];
    const when = `${sheet.workDay} กะ${sheet.shift}`;
    if (cur) {
      // ไม่เปิดใบใหม่ — ต่อบันทึกลงใบเดิม แล้วเด้งการ์ดในกลุ่มให้เห็นว่าเจอซ้ำ
      const add = `\n— เจอซ้ำ ${when} โดย ${by || 'ไม่ระบุ'}: ${it.cause}`;
      await db.exec('UPDATE incidents SET symptom = ?, updated_at = ? WHERE id = ?',
        [String(cur.symptom || '') + add, nowBKK(), cur.id]);
      await bumpRepairCard(cur.id);
      repeated.push({ id: cur.id, title: it.title });
      continue;
    }
    // รูปต้องเป็น URL เท่านั้น (POST /api/incidents ปฏิเสธ data:) — อัปไม่ผ่านก็เปิดใบโดยไม่มีรูป
    const imgs = it.photoUrl ? [it.photoUrl] : [];
    const r = await createIncidentRow({
      title: it.title, machine: sheet.line, lineName: sheet.line,
      operator: by || null, occurredAt: sheet.workDay,
      symptom: `[ใบเช็ก AM ${when}] ${it.cause}`,
      images: imgs, priority: 'warn', source: 'amsheet', refKey,
    });
    opened.push({ id: r.id, title: it.title });
  }
  return { opened, repeated };
}

/* การ์ดสรุปใบเช็ก AM — รูปของข้อที่ไม่ปกติต้องอยู่ในการ์ดด้วย
   ตัวเลขอย่างเดียวบอกไม่ได้ว่า "ไม่ปกติ" ที่ช่างเจอหน้าตาเป็นยังไง
   โชว์ได้ 4 ข้อ (การ์ดกว้าง 452 ใส่ 45 ข้อไม่ไหว) ที่เหลือขึ้นเป็น "+ อีก N รายการ" */
async function amSheetCardPng({ data, line, date, shift, by, opened, repeated }) {
  if (!canRenderCard()) return null;
  const shown = data.items.filter(x => x.result === 'ng').slice(0, 4);
  /* อ่านรูปจากตารางตรง ๆ ไม่ใช้ photoUrl ของ buildAmSheet — ตัวนั้นให้เฉพาะรูปที่เป็น URL
     แต่เครื่องที่ไม่มี Supabase เก็บรูปเป็น data: ไว้ในคอลัมน์ ซึ่งก็ต้องขึ้นการ์ดเหมือนกัน */
  const photos = await Promise.all(shown.map(async (x) => {
    const r = (await dbAll('SELECT photo FROM am_sheet_items WHERE sheet_id = ? AND node_key = ?',
      [data.sheet.id, x.nodeKey]))[0];
    return r ? r.photo : null;
  }));
  const uris = (await Promise.allSettled(photos.map(fetchAsDataUri)))
    .map(r => (r.status === 'fulfilled' ? r.value : null));
  try {
    return renderAmSheetCardPNG({
      line, dateLabel: thaiDate(date), shiftLabel: `กะ${shift}`, lineStatus: data.sheet.lineStatus,
      total: data.summary.total, ok: data.summary.ok, ng: data.summary.ng,
      ngItems: shown.map((x, i) => ({ seq: x.seq, title: x.title, cause: x.cause, uri: uris[i] })),
      openedCount: opened, repeatedCount: repeated, by,
    });
  } catch (e) { console.error('[amsheet] เรนเดอร์การ์ดไม่สำเร็จ', e.message); return null; }
}

app.post('/api/am-sheet/submit', async (req, res) => {
  if (rateLimited(req.ip, 30, 60000, 'amsheet-submit')) return res.status(429).json({ error: 'เรียกถี่เกินไป รอสักครู่' });
  const b = req.body || {};
  try {
    const a = await amCheckArgs(b);
    if (a.error) return res.status(400).json({ error: a.error });
    const by = String(b.by || '').trim();
    if (!by) return res.status(400).json({ error: 'ต้องระบุชื่อผู้รายงาน' });
    const data = await buildAmSheet(a.date, a.shift, a.line, by);
    if (data.sheet.status === 'submitted') {
      return res.json({ success: true, alreadySubmitted: true, ...data });
    }
    if (data.summary.left > 0) {
      return res.status(400).json({ error: `ยังตรวจไม่ครบ เหลืออีก ${data.summary.left} ข้อ` });
    }
    await db.exec(
      "UPDATE am_sheets SET status = 'submitted', submitted_by = ?, submitted_at = ?, updated_at = ? WHERE id = ?",
      [by, nowBKK(), nowBKK(), data.sheet.id]);

    const { opened, repeated } = await amOpenRepairs(data.sheet, data.items, by);

    /* แจ้งเข้ากลุ่มช่างเป็น "การ์ดสรุป" ตามที่หน้ากรอกสัญญาไว้
       (กดส่งครั้งเดียวเกิด 2 อย่าง: การ์ดสรุปเข้ากลุ่ม + ใบแจ้งซ่อมของข้อที่ไม่ปกติ)
       เรนเดอร์รูปไม่ได้ → ถอยไปข้อความธรรมดาแบบเดิม บอทต้องไม่เงียบเพราะเรื่องหน้าตา
       ⚠️ ข้อความในรูปค้นหาไม่ได้ เลขใบซ่อม/ตัวเลขที่ต้องใช้ค้นย้อนหลังจึงต้องอยู่ใน caption ด้วย */
    const ngItems = data.items.filter(x => x.result === 'ng');
    const caption = [
      `📋 <b>ใบเช็ก AM — ${escapeHtml(a.line)}</b>`,
      `${a.date} · กะ${escapeHtml(a.shift)} · โดย ${escapeHtml(by)}`,
      `✅ ปกติ ${data.summary.ok}　⚠️ ไม่ปกติ ${data.summary.ng}　รวม ${data.summary.total} ข้อ`,
      opened.length ? `🆘 เปิดใบแจ้งซ่อมใหม่ ${opened.length} ใบ: ${opened.map(x => '#' + x.id).join(' ')}` : '',
      repeated.length ? `🔁 เจอซ้ำ ต่อในใบเดิม ${repeated.length} ใบ: ${repeated.map(x => '#' + x.id).join(' ')}` : '',
    ].filter(Boolean).join('\n');
    /* ข้อความสำรอง — ⚠️ sendMessage จำกัด 4096 ตัวอักษร และโปรเจกต์นี้ไม่มีที่ไหนจัดการลิมิตนี้เลย
       จึงไล่ข้อไม่ปกติได้สูงสุด 10 ข้อ แล้วสรุปที่เหลือเป็นตัวเลข */
    const L = [caption];
    if (ngItems.length) {
      L.push('', '<b>ข้อที่ไม่ปกติ</b>');
      for (const it of ngItems.slice(0, 10)) {
        L.push(`• ${escapeHtml(it.title)}`);
        L.push(`　${escapeHtml(String(it.cause).slice(0, 160))}`);
      }
      if (ngItems.length > 10) L.push(`… และอีก ${ngItems.length - 10} ข้อ (ดูในแอป)`);
    }
    try {
      await inTopic('duty', async () => {
        const png = await amSheetCardPng({ data, line: a.line, date: a.date, shift: a.shift, by,
          opened: opened.length, repeated: repeated.length });
        if (png) return sendPhotoBufferToTelegram(png, 'image/png', caption);
        return sendToTelegram(L.join('\n'));
      });
    } catch (e) { console.error('[amsheet] แจ้งกลุ่มไม่สำเร็จ', e.message); }

    res.json({ success: true, opened, repeated, ...(await buildAmSheet(a.date, a.shift, a.line, by)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ออกลิงก์สาธารณะของไลน์ (1 ลิงก์ใช้ได้ทุกกะ) — ปักหมุดในกลุ่มช่างได้
app.post('/api/am-sheet/link', async (req, res) => {
  const b = req.body || {};
  const line = String(b.line || '').trim();
  try {
    if (!(await amLines()).includes(line)) return res.status(400).json({ error: 'ไม่พบไลน์นี้' });
    const cur = (await dbAll('SELECT token FROM am_sheet_links WHERE line = ? AND active = 1', [line]))[0];
    let token = cur && cur.token;
    if (!token) {
      token = crypto.randomBytes(12).toString('hex');
      await db.exec('INSERT INTO am_sheet_links (token, line, created_by, created_at, active) VALUES (?, ?, ?, ?, 1)',
        [token, line, b.by || null, nowBKK()]);
    }
    // ต้องแยกจาก PUBLIC_WEB_URL — ตัวนั้นตั้งเป็นโดเมน Render (ใช้เป็น HTTP-Referer ของ AI)
    // ไม่ใช่โดเมนหน้าเว็บจริงที่ผู้ใช้กดลิงก์ ถ้าใช้ตัวเดียวกันลิงก์จะพาไปเจอ "Cannot GET /"
    const base = String(process.env.PUBLIC_APP_URL || b.baseUrl || '').replace(/\/$/, '');
    const url = base ? `${base}/?amsheet=${token}` : `/?amsheet=${token}`;
    if (b.sendToGroup && base) {
      try {
        await notify('duty', `📋 <b>ใบเช็ก AM — ${escapeHtml(line)}</b>\n\nเปิดกรอกได้ที่ลิงก์นี้ (ใช้ได้ทุกกะ)\n${url}`);
      } catch (e) { console.error('[amsheet] ส่งลิงก์เข้ากลุ่มไม่สำเร็จ', e.message); }
    }
    res.json({ success: true, token, url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// โหลดรูปทีหลัง (คู่แฝดของ /api/routine/image) — ไม่ลากรูปมากับลิสต์
app.get('/api/am-sheet/image', async (req, res) => {
  const { sheetId, nodeKey } = req.query;
  if (!sheetId || !nodeKey) return res.status(400).json({ error: 'sheetId/nodeKey จำเป็น' });
  try {
    const row = (await dbAll('SELECT photo FROM am_sheet_items WHERE sheet_id = ? AND node_key = ?',
      [sheetId, nodeKey]))[0];
    res.json({ image: (row && row.photo) || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// มอบหมายงานระหว่างวัน → เก็บลง daily_tasks (source = 'assigned') ผูก assignee
// ── งานมอบหมาย: หมวด, วันที่ทำ, แจ้งเตือนล่วงหน้า ──────────────────────────
const CAT_ICON = { production: '🏭', cip: '💧', backwash: '🧴', cleaning: '🧽', mixing: '🥤', packing: '📦', maintenance: '🔧', manual: '📌', am: '🔧', pm: '🗓' };
const catIcon = (c) => CAT_ICON[c] || '📌';
// ป้ายเวลาแจ้งเตือนล่วงหน้า (สำหรับแสดงใน caption)
const REMIND_LABEL = { '30m': 'ล่วงหน้า 30 นาที', '1h': 'ล่วงหน้า 1 ชม.', '2h': 'ล่วงหน้า 2 ชม.', '1d': 'ล่วงหน้า 1 วัน', morning: 'เช้าวันงาน 08:00' };
// คำนวณเวลาแจ้งเตือนจริง (BKK wall-clock string 'YYYY-MM-DDTHH:MM') จากวันที่ทำ+เวลา+ล่วงหน้า
const _pad2 = (n) => String(n).padStart(2, '0');
function computeRemindAt(workDate, dueTime, lead) {
  if (!lead || lead === 'none') return null;
  const date = workDate || todayBKK();
  if (lead === 'morning') return `${date}T08:00`;
  const mins = { '30m': 30, '1h': 60, '2h': 120, '1d': 1440 }[lead];
  if (!mins) return null;
  const time = (dueTime && /^\d\d:\d\d/.test(dueTime)) ? dueTime.slice(0, 5) : '08:00'; // ไม่กำหนดเวลา → อิง 08:00
  const base = new Date(`${date}T${time}:00Z`); // คิดเลขบน wall-clock (Z เข้า Z ออก) เลี่ยง tz ของเซิร์ฟเวอร์
  base.setUTCMinutes(base.getUTCMinutes() - mins);
  return `${base.getUTCFullYear()}-${_pad2(base.getUTCMonth() + 1)}-${_pad2(base.getUTCDate())}T${_pad2(base.getUTCHours())}:${_pad2(base.getUTCMinutes())}`;
}

app.post('/api/duty/assign', async (req, res) => {
  const { date, category, title, location, priority, operator, workDate, dueTime, remindLead } = req.body;
  // รองรับทั้งคนเดียว (assignTo) และหลายคน (assignees[]) — มอบงานเดียวให้หลายคนพร้อมกัน
  const rawAssignees = Array.isArray(req.body.assignees) ? req.body.assignees
    : (req.body.assignTo != null ? [req.body.assignTo] : []);
  const assignees = [...new Set(rawAssignees.filter(a => typeof a === 'string' && a.trim()))];
  if (!title || assignees.length === 0) return res.status(400).json({ error: 'title/assignTo จำเป็น' });
  // task_date = วันที่ทำ (workDate) เพื่อให้งานไปโผล่บอร์ดของวันนั้น — ถ้าไม่ระบุใช้วันที่ปัจจุบันของบอร์ด
  const d = workDate || date || todayBKK();
  const due = (dueTime && /^\d\d:\d\d/.test(dueTime)) ? dueTime.slice(0, 5) : null;
  const remindAt = computeRemindAt(d, due, remindLead);
  // รูปก่อนทำ — index ต้องตรงกับ photoSpecs (จุดที่ไม่มีรูปเก็บเป็น '' ไว้กันลำดับเลื่อน)
  const images = (Array.isArray(req.body.images) ? req.body.images : [])
    .map(x => (typeof x === 'string' && (x.startsWith('http') || x.startsWith('data:'))) ? x : '')
    .slice(0, 10);
  // รูปหลังทำ (ใบตรวจ: แก้เสร็จหน้างานแล้ว) → บันทึกเป็นหลักฐาน + ปิดงานทันที
  const doneImages = filterImgs(req.body.doneImages);
  const hasDone = doneImages.length > 0;
  const status = hasDone ? 'done' : 'pending';
  const completedAt = hasDone ? nowBKK() : null;
  const doneBy = hasDone ? (operator || assignees[0] || null) : null;
  // มาจากใบตรวจไหม — 1 ครั้งที่กด "ส่งทั้งหมด" = 1 batch (ใช้จัดกลุ่ม + กรองในหน้าติดตามผล)
  const auditBatch = typeof req.body.auditBatch === 'string' && req.body.auditBatch.trim() ? req.body.auditBatch.trim().slice(0, 40) : null;
  // รายการรูปที่ต้องถ่าย — บอทจะถามทีละใบตามลำดับนี้ · ไม่ส่งมา = null → ฝั่งบอทใช้ default ["หลังทำ"]
  // พื้นที่ (พิมพ์เอง) + คนแจ้ง (key จากรายชื่อทีม) — ใบแจ้งงานซ่อมต้องรู้ว่า "เครื่องไหน ใครแจ้ง"
  const machine = typeof req.body.machine === 'string' && req.body.machine.trim() ? req.body.machine.trim().slice(0, 60) : null;
  const reporter = typeof req.body.reporter === 'string' && req.body.reporter.trim() ? req.body.reporter.trim().slice(0, 40) : null;
  const rawSpecs = Array.isArray(req.body.photoSpecs) ? req.body.photoSpecs : null;
  const specs = rawSpecs
    ? rawSpecs.map(s => String(s || '').trim().slice(0, 24)).filter(Boolean).slice(0, 6)
    : null;
  const photoSpecs = specs && specs.length ? JSON.stringify(specs) : null;
  try {
    // เก็บ line_name = assignee เพื่อให้ UNIQUE(task_date, line_name, category, title) แยกตามคน
    // → งานชื่อเดียวกันมอบให้หลายคนได้ (แต่ละคนได้แถวของตัวเอง) แทนที่จะทับกันเหลือคนสุดท้าย
    for (const assignTo of assignees) {
      await db.exec(
        `INSERT INTO daily_tasks (task_date, line_name, category, title, status, source, assignee, location, priority, images, done_images, due_time, remind_at, remind_lead, reminded, completed_at, done_by, audit_batch, photo_specs, machine, reporter, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_date, line_name, category, title)
         DO UPDATE SET assignee = excluded.assignee, location = excluded.location, priority = excluded.priority, images = excluded.images, done_images = excluded.done_images, status = excluded.status, due_time = excluded.due_time, remind_at = excluded.remind_at, remind_lead = excluded.remind_lead, reminded = 0, completed_at = excluded.completed_at, done_by = excluded.done_by, audit_batch = COALESCE(excluded.audit_batch, daily_tasks.audit_batch), photo_specs = COALESCE(excluded.photo_specs, daily_tasks.photo_specs), machine = COALESCE(excluded.machine, daily_tasks.machine), reporter = COALESCE(excluded.reporter, daily_tasks.reporter)`,
        [d, assignTo, category || 'manual', title, status, assignTo, location || null, priority || 'normal', JSON.stringify(images), JSON.stringify(doneImages), due, remindAt, remindLead || null, completedAt, doneBy, auditBatch, photoSpecs, machine, reporter, operator || null, nowBKK()]);
    }
    if (process.env.TELEGRAM_CHAT_ID) {
      const who = assignees.map(a => escapeHtml(dutyName(a))).join(', ');
      const L = [
        hasDone ? `✅ <b>บันทึกงานที่แก้เสร็จแล้ว</b>` : `🆕 <b>มอบหมายงานใหม่</b>`,
        `${catIcon(category)} ${escapeHtml(title)}${priority === 'urgent' ? '  🔴 <b>ด่วน</b>' : ''}`,
        ``,
        `👤 <b>ผู้รับ:</b> ${who}`,
      ];
      if (machine) L.push(`📌 <b>พื้นที่:</b> ${escapeHtml(machine)}`);
      if (location) L.push(`📍 <b>สถานที่:</b> ${escapeHtml(location)}`);
      if (reporter) L.push(`🙋 <b>คนแจ้ง:</b> ${escapeHtml(dutyName(reporter))}`);
      L.push(`🗓 <b>วันที่ทำ:</b> ${thaiDate(d)}${due ? ` · ${due} น.` : ''}`);
      if (hasDone) L.push(`✅ <b>สถานะ:</b> เสร็จแล้ว (แนบรูปก่อน/หลัง)`);
      if (remindAt && !hasDone) L.push(`⏰ <b>เตือน:</b> ${REMIND_LABEL[remindLead] || remindLead} (${remindAt.slice(11)} น.)`);
      L.push(`✍️ โดย ${escapeHtml(operator || 'จักรกฤษ')}`);
      const msg = L.join('\n');
      const photoSet = hasDone ? [...images, ...doneImages].slice(0, 10) : images;
      // มีรูป → ส่งเป็นอัลบั้มพร้อมข้อความ (URL/base64) · เข้ากลุ่มตาม NOTIFY_ROUTE (ใบตรวจ → กลุ่มผลิต)
      const topic = auditBatch ? 'audit' : (assignees.every(isMaintPerson) ? 'duty' : 'production');
      inTopic(topic, () => (photoSet.length ? sendPhotosToTelegram(photoSet, msg) : sendToTelegram(msg)));
    }
    // อัปเดต gate ในหน่วยความจำ — กัน reminderTick ข้ามงานที่เพิ่งตั้งเตือน (ไม่ยิง DB)
    if (remindAt && (_nextRemindAt == null || remindAt < _nextRemindAt)) { _nextRemindAt = remindAt; _nextRemindKnown = true; }
    res.json({ success: true, remindAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// สร้างข้อความสรุป + ส่งเข้า Telegram
const THAI_MON_ABBR = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thaiDate = (d) => { const [y, m, day] = String(d).split('-').map(Number); return `${day} ${THAI_MON_ABBR[m] || m} ${y + 543}`; };

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
    const dot = p.dot || dutyDot(p.key);
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

/* ── สรุปงานตามหน้าที่ · ทีมซ่อมบำรุง ────────────────────────────────────────
   ⚠️ แยกจาก buildDutyText() ตั้งใจ — ห้ามยุบรวมกัน ไม่งั้นสรุปของทีมกะเปลี่ยนตามทันที
   ต่างกันตรงไหน (แผน "กระดานทีมซ่อมบำรุง 3 คน" ข้อ C):
     1. บล็อก 🔴 ต้องรีบ บนสุด — งานซ่อมค้าง · เครื่องที่หยุดอยู่ + กี่นาที · PM เกินกำหนด
        (ข้อมูลมีอยู่แล้วใน maintCounts() ของเดิมไม่เคยเอามาโชว์ ทั้งที่เป็นเรื่องเดียวที่ต้องรีบ)
     2. งานค้างจัดกลุ่มตาม "เครื่อง" ใต้ชื่อคน — ช่างคิดเป็นเครื่อง เดินไปจุดเดียวจบหลายงาน
     3. ตัดที่ 3 งาน/คน แล้วยุบเป็น "…และอีก N งาน" — สรุปยาวพอ ๆ กันเสมอ ไม่ว่าจะค้างกี่อัน
     4. เรียงคนที่ค้างมากสุดขึ้นก่อน (ของเดิมเรียงตาม sort_order คนที่ต้องช่วยอาจอยู่ล่างสุด)
     5. แถบ ▓▓░░ รายคน ไม่ใช่แค่ของทีม
     6. คนที่ยังไม่มีงานในกระดานเลย ยุบเป็นบรรทัดเดียวท้ายสรุป
        (ตอนนี้งานรูทีน 16 รายการยัง seed อยู่กับจักรกฤษคนเดียว — สรุปจะได้บอกตรง ๆ ว่ายังไม่ได้แบ่ง)
   คืน { text, keyboard } — ปุ่มเป็น m:* ใช้ได้เฉพาะบอทซ่อมบำรุงที่แอปถือ webhook เอง
   คนส่งเป็นคนตัดสินว่าจะแนบปุ่มไหม (maintBotReady) ไม่งั้นปุ่มไปตายอยู่ในกลุ่มผลิต        */
const MAINT_SUM_MAX = 3;                       // งานค้างที่พิมพ์เต็มต่อคน
const THAI_DOW_ABBR = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
// ตั้ง env ของบอทช่างครบแล้วหรือยัง — ยังไม่ตั้ง = ทุกอย่าง fallback ไปกลุ่มผลิต ปุ่ม m:* จะกดไม่ติด
const maintBotReady = () => !!(process.env.MAINT_TELEGRAM_BOT_TOKEN
  && process.env.MAINT_TELEGRAM_BOT_TOKEN !== process.env.TELEGRAM_BOT_TOKEN);

// จัดรายการเป็นกลุ่มตามเครื่อง โดยคงลำดับที่เจอครั้งแรกไว้ (ลำดับเดิมสื่อความสำคัญ ไม่เรียงตามตัวอักษร)
function groupByMachine(items) {
  const order = [], map = new Map();
  for (const it of items) {
    const k = it.machine || 'ไม่ระบุเครื่อง';
    if (!map.has(k)) { map.set(k, []); order.push(k); }
    map.get(k).push(it);
  }
  return order.map(k => ({ machine: k, items: map.get(k) }));
}

async function buildMaintDutyText(duty, opts = {}) {
  const t = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  const dow = THAI_DOW_ABBR[weekdayOf(duty.date) ?? -1] || '';
  const c = await maintCounts(duty.date);
  const SEP = '━━━━━━━━━━━━━━━━';
  const L = [
    `📋 <b>สรุปงานตามหน้าที่</b> · ทีมซ่อมบำรุง`,
    `🗓 ${dow ? `${dow} ` : ''}${thaiDate(duty.date)} · ${t} น.`,
    SEP,
  ];

  // ── 🔴 ต้องรีบ ──
  const hot = [];
  if (c.open + c.wip) hot.push(`   🆘 งานซ่อมค้าง <b>${c.open + c.wip}</b>${c.wip ? ` (กำลังซ่อม ${c.wip})` : ''}`);
  if (c.downNow) {
    // โชว์แค่นาทีที่เครื่องหยุด — ห้ามโชว์ค่าเสียโอกาสเป็นเงินในกลุ่ม (ทีมผลิตอยู่ด้วย)
    const which = (c.downList || []).slice(0, 2)
      .map(d => `${escapeHtml(d.machine)}${d.mins != null ? ` ${downLabel(d.mins)}` : ''}`).join(' · ');
    hot.push(`   ⏱ <b>เครื่องหยุดอยู่ ${c.downNow} เครื่อง</b>${which ? ` · ${which}` : ''}`);
  }
  if (c.pmLate) hot.push(`   ⚠️ งาน PM เกินกำหนด <b>${c.pmLate}</b>`);
  if (hot.length) L.push(`🔴 <b>ต้องรีบ</b>`, ...hot, '');
  else L.push(`✅ <i>ไม่มีเรื่องด่วน — ไม่มีงานซ่อมค้าง เครื่องเดินครบ</i>`, '');

  L.push(`📊 <b>ทีม ${duty.team.done}/${duty.team.total} · ${duty.team.pct}%</b>  ${progressBar(duty.team.pct)}`, SEP);

  // งานที่คนอื่นมอบต่อมาให้ ไม่มีช่อง machine ของตัวเอง — ยืมของเจ้าของงานเดิม
  const machineOf = {};
  for (const p of duty.people) for (const n of p.nodes) machineOf[`${p.key}|${n.key}`] = n.machine || null;

  const pendingOf = (p) => {
    const urgent = [], rest = [];
    for (const a of p.adhoc) {
      if (a.status === 'done') continue;
      const item = { title: a.title, machine: a.machine, urgent: a.priority === 'urgent' };
      (item.urgent ? urgent : rest).push(item);
    }
    for (const n of p.nodes) if (!n.bypassed && !n.checked) rest.push({ title: n.title, machine: n.machine });
    for (const r of p.received) if (!r.checked) rest.push({ title: `${r.title} ⟵${r.fromName}`, machine: machineOf[`${r.ownerKey}|${r.nodeKey}`] });
    return [...urgent, ...rest];   // งานด่วนขึ้นก่อนเสมอ ที่เหลือคงลำดับเดิม
  };

  const hasAny = (p) => p.total > 0 || p.nodes.length > 0 || p.adhoc.length > 0 || p.received.length > 0;
  const blocks = duty.people.filter(hasAny).map(p => ({ p, pending: pendingOf(p) }));
  blocks.sort((a, b) => (b.pending.length - a.pending.length) || (a.p.pct - b.p.pct));

  for (const { p, pending } of blocks) {
    const full = p.total > 0 && p.done >= p.total;
    L.push('');
    // total = 0 ทั้งที่มีงานอยู่ = ข้ามหมดทุกอัน — โชว์ 0/0 (100%) จะอ่านเป็น "เสร็จแล้ว" ซึ่งไม่จริง
    L.push(p.total > 0
      ? `🔧 <b>${escapeHtml(p.name)}</b> · ${p.done}/${p.total} (${p.pct}%)${full ? ' 🎉' : ''}  ${progressBar(p.pct)}`
      : `🔧 <b>${escapeHtml(p.name)}</b> · <i>ไม่มีงานที่ต้องติ๊กวันนี้</i>`);
    // จัดกลุ่มก่อนแล้วค่อยตัด — งานเครื่องเดียวกันจะได้ไม่โดนหั่นแยกบรรทัด
    const flat = groupByMachine(pending).flatMap(g => g.items.map(it => ({ ...it, machine: g.machine })));
    for (const g of groupByMachine(flat.slice(0, MAINT_SUM_MAX))) {
      const titles = g.items.map(it => `${it.urgent ? '🔴 ' : ''}${escapeHtml(it.title)}`).join(' · ');
      L.push(`   🔩 <b>${escapeHtml(g.machine)}</b> — ${titles}`);
    }
    const more = flat.length - Math.min(flat.length, MAINT_SUM_MAX);
    if (more > 0) L.push(`   <i>…และอีก ${more} งาน</i>`);
    // ข้าม/มอบต่อ = ข้อมูลสำคัญ แต่ยุบเป็นบรรทัดเดียว ไม่ให้กินที่เท่างานจริง
    const skipped = p.nodes.filter(n => n.bypassed && !n.handoffTo);
    const handed = p.nodes.filter(n => n.bypassed && n.handoffTo);
    if (skipped.length) {
      const why = [...new Set(skipped.map(n => n.bypassReason).filter(Boolean))].slice(0, 2).map(escapeHtml).join(' · ');
      L.push(`   ⤼ <i>ข้าม ${skipped.length}${why ? ` (${why})` : ''}</i>`);
    }
    if (handed.length === 1) L.push(`   🔁 <i>มอบ ${escapeHtml(handed[0].title)} → ${escapeHtml(handed[0].handoffToName || '')}</i>`);
    else if (handed.length) L.push(`   🔁 <i>มอบต่อ ${handed.length} งาน → ${[...new Set(handed.map(n => n.handoffToName))].map(escapeHtml).join(', ')}</i>`);
    if (!pending.length && full) L.push(`   ✅ <i>เสร็จครบทุกงาน</i>`);
  }

  const idle = duty.people.filter(p => !hasAny(p));
  if (idle.length) L.push('', `👥 <i>ยังไม่มีงานในกระดาน: ${idle.map(p => escapeHtml(p.name)).join(' · ')}</i>`);

  L.push(SEP);
  L.push(opts.by ? `✍️ ส่งโดย ${escapeHtml(opts.by)} · ${t} น.` : `🤖 <i>ส่งอัตโนมัติ</i> · ${t} น.`);

  return {
    text: L.join('\n'),
    keyboard: [[
      { text: '🔧 เปิดกระดาน', callback_data: 'm:home' },
      { text: '🔄 อัปเดต', callback_data: 'm:sum' },
    ]],
  };
}

// ส่งสรุปทีมช่างพร้อมปุ่ม — ต้องเรียกใน runAsBot('maint') เท่านั้น (อ่าน chat id ของบอทที่คุยอยู่)
async function sendMaintSummary(card) {
  if (!tgToken() || !tgChatId()) { console.error('[maint] ส่งสรุปไม่ได้ — ยังไม่ได้ตั้ง token/chat id'); return false; }
  await tgApi('sendMessage', {
    chat_id: tgChatId(), text: card.text, parse_mode: 'HTML',
    ...(maintBotReady() ? { reply_markup: { inline_keyboard: card.keyboard } } : {}),
  });
  return true;
}

// kind='maint' = ปุ่มส่งจากกระดานทีมซ่อมบำรุง → ต้องเข้ากลุ่มช่าง ไม่ใช่กลุ่มผลิต
// (เดิมเรียก sendToTelegram ตรง ๆ ไม่ได้อยู่ในบริบทบอทไหน = ตกไปกลุ่มผลิตเสมอ — เจอตอนทดสอบจริง 26 ส.ค.)
app.post('/api/duty/telegram', async (req, res) => {
  const date = req.body.date || req.query.date || workDayBKK();
  const isMaint = req.body.kind === 'maint';
  try {
    const duty = await buildDuty(date, { maint: isMaint });
    // ทีมช่างใช้สรุปคนละแบบกับทีมกะ — สรุปของทีมกะห้ามเปลี่ยนตาม
    if (isMaint) {
      const card = await buildMaintDutyText(duty, { by: req.body.by || req.body.operator || null });
      const sent = await runAsBot('maint', () => sendMaintSummary(card));
      return res.json({ success: true, sent, preview: card.text });
    }
    const text = buildDutyText(duty);
    const sent = await runAsBot('main', async () => {
      await sendToTelegram(text);
      return !!(tgToken() && tgChatId());   // เช็ค env ของบอทที่ส่งจริง ไม่ใช่ของบอทหลักเสมอ
    });
    res.json({ success: true, sent, preview: text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ตั้งค่า/นัดส่งรายงานอัตโนมัติ ────────────────────────────────────────────
// cache report_config ในหน่วยความจำ — tick อ่านทุก 60 วิ ไม่ควรยิง DB ซ้ำ (ลด compute/egress)
// invalidate ตอนบันทึกตั้งค่า (POST /api/report/config)
let _reportConfigCache = null;
const invalidateReportConfig = () => { _reportConfigCache = null; };
async function getReportConfig() {
  if (_reportConfigCache) return _reportConfigCache;
  const rows = await dbAll('SELECT * FROM report_config ORDER BY id LIMIT 1', []);
  const r = rows[0] || {};
  _reportConfigCache = {
    id: r.id,
    autoEnabled: !!r.auto_enabled,
    times: (() => { try { return JSON.parse(r.times || '[]'); } catch { return []; } })(),
    weekdays: (() => { try { return JSON.parse(r.weekdays || '[]'); } catch { return []; } })(),
    onlyIfPending: !!r.only_if_pending,
    autoAtShiftEnd: !!r.auto_at_shift_end,
    shiftAnalysisEnabled: r.shift_analysis_enabled == null ? true : !!r.shift_analysis_enabled,
    kpiWeeklyEnabled: !!r.kpi_weekly_enabled,
    kpiMonthlyEnabled: !!r.kpi_monthly_enabled,
    kpiAlertEnabled: !!r.kpi_alert_enabled,
    kpiAlertStreakDays: r.kpi_alert_streak_days == null ? 2 : Number(r.kpi_alert_streak_days),
    kpiAlertCipStaleHours: r.kpi_alert_cip_stale_hours == null ? 30 : Number(r.kpi_alert_cip_stale_hours),
    qualityWatchEnabled: !!r.quality_watch_enabled,
    pmNotifyEnabled: r.pm_notify_enabled == null ? true : !!r.pm_notify_enabled,
    // เช็กลิสต์เดินเครื่อง — ค่าเริ่มต้น "ปิด" ต่างจากตัวอื่น เพราะยิงรายกะ ถี่กว่าทุกตัวในระบบ
    // ต้องให้ตั้งกฎเสร็จก่อนแล้วค่อยเปิดเอง ไม่ใช่เปิดมาแล้วยิงทันทีที่ deploy
    runNotifyEnabled: !!r.run_notify_enabled,
  };
  return _reportConfigCache;
}
app.get('/api/report/config', async (req, res) => {
  try {
    const cfg = await getReportConfig();
    const once = await dbAll("SELECT id, run_at FROM report_once WHERE sent = 0 ORDER BY run_at", []);
    res.json({ ...cfg, once });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/report/config', async (req, res) => {
  const { autoEnabled, times, weekdays, onlyIfPending, autoAtShiftEnd, shiftAnalysisEnabled, kpiWeeklyEnabled, kpiMonthlyEnabled, kpiAlertEnabled, kpiAlertStreakDays, kpiAlertCipStaleHours, qualityWatchEnabled, pmNotifyEnabled, runNotifyEnabled } = req.body;
  try {
    const cfg = await getReportConfig();
    const sae = shiftAnalysisEnabled == null ? cfg.shiftAnalysisEnabled : shiftAnalysisEnabled;
    const kw = kpiWeeklyEnabled == null ? cfg.kpiWeeklyEnabled : kpiWeeklyEnabled;
    const km = kpiMonthlyEnabled == null ? cfg.kpiMonthlyEnabled : kpiMonthlyEnabled;
    const ka = kpiAlertEnabled == null ? cfg.kpiAlertEnabled : kpiAlertEnabled;
    const ksd = kpiAlertStreakDays == null ? cfg.kpiAlertStreakDays : Math.max(1, Number(kpiAlertStreakDays) || 2);
    const kch = kpiAlertCipStaleHours == null ? cfg.kpiAlertCipStaleHours : Math.max(1, Number(kpiAlertCipStaleHours) || 30);
    const qw = qualityWatchEnabled == null ? cfg.qualityWatchEnabled : qualityWatchEnabled;
    const pmn = pmNotifyEnabled == null ? cfg.pmNotifyEnabled : pmNotifyEnabled;
    const rnn = runNotifyEnabled == null ? cfg.runNotifyEnabled : runNotifyEnabled;
    await db.exec('UPDATE report_config SET auto_enabled = ?, times = ?, weekdays = ?, only_if_pending = ?, auto_at_shift_end = ?, shift_analysis_enabled = ?, kpi_weekly_enabled = ?, kpi_monthly_enabled = ?, kpi_alert_enabled = ?, kpi_alert_streak_days = ?, kpi_alert_cip_stale_hours = ?, quality_watch_enabled = ?, pm_notify_enabled = ?, run_notify_enabled = ?, updated_at = ? WHERE id = ?',
      [autoEnabled ? 1 : 0, JSON.stringify(times || []), JSON.stringify(weekdays || []), onlyIfPending ? 1 : 0, autoAtShiftEnd ? 1 : 0, sae ? 1 : 0, kw ? 1 : 0, km ? 1 : 0, ka ? 1 : 0, ksd, kch, qw ? 1 : 0, pmn ? 1 : 0, rnn ? 1 : 0, nowBKK(), cfg.id]);
    invalidateReportConfig(); // ให้ tick อ่านค่าใหม่
    _sentAutoKeys.clear();     // เปลี่ยนเวลาส่ง → ยอมส่งซ้ำในเวลาใหม่ได้
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/report/schedule', async (req, res) => {
  const { runAt } = req.body; // 'YYYY-MM-DDTHH:MM'
  if (!runAt) return res.status(400).json({ error: 'runAt จำเป็น' });
  try {
    await db.exec('INSERT INTO report_once (run_at, sent, created_at) VALUES (?, 0, ?)', [runAt, nowBKK()]);
    if (_nextOnceAt == null || runAt < _nextOnceAt) { _nextOnceAt = runAt; _nextOnceKnown = true; } // อัปเดต gate (ไม่ยิง DB)
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/report/schedule/delete', async (req, res) => {
  try { await db.exec('DELETE FROM report_once WHERE id = ?', [req.body.id]); await refreshNextOnceAt(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ส่งรายงานของวันปัจจุบัน (ใช้ทั้งปุ่มและ scheduler) — คืน true ถ้าส่ง
async function sendDutyReport(date, onlyIfPending) {
  const duty = await buildDuty(date);
  if (onlyIfPending && duty.team.left <= 0) return false;
  // buildDuty() ไม่ใส่ maint = กระดานทีมกะ (ทีมผลิต) → สรุปต้องเข้ากลุ่มผลิต ไม่ใช่กลุ่มช่าง
  await notify('production', buildDutyText(duty));
  return true;
}

// ── Gate: จำ "เวลานัดถัดไป" ใน RAM เพื่อไม่ยิง DB ทุกนาที (ให้ Neon หลับได้ → ลด compute) ─
// nextOnceAt = MIN(run_at) ของนัดส่งรายงานครั้งเดียวที่ยังไม่ส่ง · nextRemindAt = MIN(remind_at) ของงานที่ยังไม่เตือน
// null = ไม่มีคิว · known=false = ยังไม่เคยคำนวณตั้งแต่ start (tick แรกจะไปคำนวณ)
let _nextOnceAt = null, _nextOnceKnown = false;
let _nextRemindAt = null, _nextRemindKnown = false;
async function refreshNextOnceAt() {
  const rows = await dbAll('SELECT MIN(run_at) AS m FROM report_once WHERE sent = 0', []);
  _nextOnceAt = rows[0] && rows[0].m ? rows[0].m : null; _nextOnceKnown = true;
}
async function refreshNextRemindAt() {
  const rows = await dbAll("SELECT MIN(remind_at) AS m FROM daily_tasks WHERE source = 'assigned' AND reminded = 0 AND remind_at IS NOT NULL AND status != 'done'", []);
  _nextRemindAt = rows[0] && rows[0].m ? rows[0].m : null; _nextRemindKnown = true;
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
    // one-time — gate ด้วย _nextOnceAt ใน RAM: ยิง DB เฉพาะตอนถึงเวลานัดจริง
    const nowKey = `${date}T${hm}`;
    if (!_nextOnceKnown) await refreshNextOnceAt();           // tick แรกหลัง start
    if (_nextOnceAt != null && nowKey >= _nextOnceAt) {       // ถึงเวลานัด → ค่อยแตะ DB
      const due = await dbAll("SELECT id, run_at FROM report_once WHERE sent = 0 AND run_at <= ?", [nowKey]);
      for (const row of due) {
        await db.exec('UPDATE report_once SET sent = 1 WHERE id = ?', [row.id]);
        await sendDutyReport(sendDay, false);
        console.log(`[report] once ${row.run_at} → sent`);
      }
      await refreshNextOnceAt();                              // คำนวณนัดถัดไป
    }
  } catch (e) { console.error('[report] tick error', e.message); }
}

// ── แจ้งเตือนงานมอบหมายตามเวลาที่ตั้งไว้ล่วงหน้า → Telegram (เกาะจังหวะ tick เดิม) ─
async function reminderTick() {
  try {
    const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const nowKey = bkk.slice(0, 10) + 'T' + bkk.slice(11, 16); // 'YYYY-MM-DDTHH:MM'
    // gate ด้วย _nextRemindAt ใน RAM: ยิง DB เฉพาะตอนถึงเวลาเตือนจริง (นาทีปกติ = 0 query → Neon หลับได้)
    if (!_nextRemindKnown) await refreshNextRemindAt();       // tick แรกหลัง start
    if (_nextRemindAt == null || nowKey < _nextRemindAt) return;
    const due = await dbAll(
      "SELECT id, category, title, priority, assignee, location, task_date, due_time, images, audit_batch FROM daily_tasks WHERE source = 'assigned' AND reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ? AND status != 'done' ORDER BY id",
      [nowKey]);
    for (const t of due) {
      await db.exec('UPDATE daily_tasks SET reminded = 1 WHERE id = ?', [t.id]); // กันส่งซ้ำก่อน
      if (process.env.TELEGRAM_CHAT_ID) {
        const L = [
          `⏰ <b>เตือนงาน</b>${t.priority === 'urgent' ? '  🔴 <b>ด่วน</b>' : ''}`,
          `${catIcon(t.category)} ${escapeHtml(t.title)}`,
          ``,
          `👤 <b>ผู้รับ:</b> ${escapeHtml(dutyName(t.assignee))}`,
        ];
        if (t.location) L.push(`📍 <b>สถานที่:</b> ${escapeHtml(t.location)}`);
        L.push(`🗓 <b>กำหนด:</b> ${thaiDate(t.task_date)}${t.due_time ? ` · ${t.due_time} น.` : ''}`);
        const imgs = (() => { try { return JSON.parse(t.images || '[]'); } catch { return []; } })();
        const msg = L.join('\n');
        inTopic(dutyTopic(t.audit_batch, t.assignee), () => (imgs.length ? sendPhotosToTelegram(imgs, msg) : sendToTelegram(msg)));
      }
      console.log(`[reminder] task#${t.id} "${t.title}" → sent`);
    }
    await refreshNextRemindAt(); // คำนวณเวลาเตือนถัดไป
  } catch (e) { console.error('[reminder] tick error', e.message); }
}

// ให้ n8n Schedule เคาะทุกนาที (ปลุก Render + ทริกส่งตามตั้งค่าในแอป) — เสริม setInterval ให้ตรงเวลาแม้ Render หลับ
app.post('/api/report/tick', async (req, res) => {
  await reportTick();
  await reminderTick();
  await shiftAnalysisTick();
  await kpiReportTick();
  await kpiAlertTick();
  await qualityWatchTick();
  await sheetSyncTick(); // ให้ tick ที่ n8n ยิงครบเท่า setInterval (สำคัญเมื่อ Render หลับนอกช่วง window)
  await vaultTick();     // ตาข่ายกันพลาดของ Obsidian — ทำงานจริงชั่วโมงละครั้ง
  await pm.pmSyncTick();  // ดึงแผน PM จากแอปทีมช่าง — ชั่วโมงละครั้งเหมือนกัน
  await pmNotifyTick();   // แจ้งงาน PM เข้ากลุ่มช่าง — จันทร์เช้า / ศุกร์บ่าย
  await runNotifyTick();  // การ์ดเช็กลิสต์เดินเครื่อง — ก่อนเริ่ม / กลางกะ / ก่อนจบกะ 1 ชม.
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

// ═══════════════════════════════════════════════════════════════════════════
// ── KPI report เฟส 2: สรุป KPI รายสัปดาห์/รายเดือน → Telegram (ใช้ KPI data layer
// จาก buildKpiRange/buildDutyRange เฟส 1) ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
async function buildKpiCardData(from, to, periodLabel, periodRangeText) {
  const [kpi, dutyDays] = await Promise.all([buildKpiRange(from, to), buildDutyRange(from, to)]);
  if (kpi.production.total === 0 && kpi.cip.totalRounds === 0) return null; // ไม่มีข้อมูลเลย → SKIP

  const activeDuty = dutyDays.filter((d) => d.active);
  const dutyDone = activeDuty.reduce((s, d) => s + d.done, 0);
  const dutyTotalN = activeDuty.reduce((s, d) => s + d.total, 0);
  const dutyPct = dutyTotalN > 0 ? Math.round((dutyDone / dutyTotalN) * 100) : null;

  const pct = kpi.production.pct;
  const colorFor = (p) => (p == null ? '#93a2ab' : (p >= 95 ? '#39b57e' : (p >= 70 ? '#eea23a' : '#ec5f5c')));

  // ไลน์ที่ควรจับตา — เรียงแย่สุดก่อน (ตกแผนมากสุดขึ้นบน) จำกัด 6 รายการกันการ์ดยาวเกิน
  const lines = kpi.production.byLineFlavor
    .filter((l) => l.planned > 0 || l.actual > 0)
    .map((l) => {
      let status = 'mute', label = null, p = null;
      if (!l.planned) { status = 'mute'; label = 'นอกแผน'; }
      else {
        p = Math.round((l.actual / l.planned) * 100);
        if (l.actual >= l.planned) { status = 'good'; label = l.actual > l.planned ? 'เกินแผน' : 'ครบแผน'; }
        else { status = p >= 50 ? 'warn' : 'crit'; label = 'ตกแผน'; }
      }
      return { line: l.line_name, flavor: l.flavor, actual: l.actual, plan: l.planned || null, pct: p, status, statusLabel: label };
    })
    .sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999))
    .slice(0, 6);

  const cipParts = [];
  for (const L of ['Line 1', 'Line 2', 'Line 3']) if (kpi.cip.byLine[L]) cipParts.push(`${L}: ${kpi.cip.byLine[L]}`);

  const nowHM = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(11, 16);
  return {
    periodLabel, periodRangeText,
    kpiCols: [
      { num: `${kpi.production.total}`, unit: ` / ${kpi.production.planned}`, label: 'ผลิตจริง / แผน (batch)', color: '#eaf0f3' },
      { num: pct != null ? `${pct}%` : '–', label: 'ทำได้ตามแผน', color: colorFor(pct) },
      { num: dutyPct != null ? `${dutyPct}%` : '–', label: 'งานตามหน้าที่เฉลี่ย', color: colorFor(dutyPct) },
    ],
    lines,
    cip: { text: cipParts.length ? cipParts.join(' · ') + ' รอบ' : 'ไม่มีรอบบันทึกช่วงนี้', level: kpi.cip.totalRounds ? 'mute' : 'warn' },
    sentTime: nowHM,
  };
}

function kpiDataToText(d) {
  const L = [];
  L.push(`📊 <b>${escapeHtml(d.periodLabel)}</b> · ${escapeHtml(d.periodRangeText)}`);
  L.push('');
  for (const c of d.kpiCols) L.push(`${escapeHtml(c.label)}: <b>${escapeHtml(c.num)}${escapeHtml(c.unit || '')}</b>`);
  L.push('');
  L.push('📦 <b>ไลน์ที่ควรจับตา</b>');
  if (!d.lines.length) L.push('• ไม่มีข้อมูลผลิตในช่วงนี้');
  for (const ln of d.lines) {
    const val = ln.plan != null ? `${ln.actual}/${ln.plan}` : `${ln.actual} batch`;
    L.push(`• ${escapeHtml(ln.line)} ${escapeHtml(ln.flavor)}: ${val}${ln.statusLabel ? ` — ${escapeHtml(ln.statusLabel)}` : ''}${ln.pct != null ? ` (${ln.pct}%)` : ''}`);
  }
  L.push('');
  L.push(`🫧 CIP/Backwash: ${escapeHtml(d.cip.text)}`);
  return L.join('\n');
}

// รวมทุกอย่าง: สร้างข้อมูล → เรนเดอร์รูป (มี fallback ข้อความ) — คืน { data, png, caption, text } หรือ null
async function runKpiAnalysis(from, to, periodLabel, periodRangeText) {
  const data = await buildKpiCardData(from, to, periodLabel, periodRangeText);
  if (!data) return null;
  const caption = `📊 ${data.periodLabel} · ${data.periodRangeText}`;
  let png = null;
  try { png = renderKpiCardPNG(data); } catch (e) { console.error('[kpi-report] render error', e.message); }
  return { data, png, caption, text: kpiDataToText(data) };
}

// กันส่งซ้ำข้าม restart ด้วย kpi_report_log (UNIQUE period_key+period_type) — pattern เดียวกับ shift_analysis_log
const _kpiReportRunning = new Set();
async function sendKpiPeriodOnce(periodKey, periodType, from, to, periodLabel, periodRangeText) {
  const memKey = `${periodType} ${periodKey}`;
  if (_kpiReportRunning.has(memKey)) return;
  const existing = await dbAll('SELECT id FROM kpi_report_log WHERE period_key = ? AND period_type = ?', [periodKey, periodType]);
  if (existing.length) return;
  _kpiReportRunning.add(memKey);
  await db.exec('INSERT INTO kpi_report_log (period_key, period_type, created_at) VALUES (?, ?, ?)', [periodKey, periodType, nowBKK()]);
  try {
    const analysis = await runKpiAnalysis(from, to, periodLabel, periodRangeText);
    if (analysis) {
      if (analysis.png) await sendPhotoBufferToTelegram(analysis.png, 'image/png', analysis.caption);
      else await sendToTelegram(analysis.text);
      console.log(`[kpi-report] sent ${memKey} (${analysis.png ? 'image' : 'text'})`);
    } else {
      console.log(`[kpi-report] skipped ${memKey} (no data)`);
    }
  } catch (e) {
    console.error('[kpi-report] run error', e.message);
    // ปลดล็อกให้ลองใหม่รอบถัดไปถ้าพัง (ยังไม่ส่งสำเร็จจริง)
    await db.exec('DELETE FROM kpi_report_log WHERE period_key = ? AND period_type = ?', [periodKey, periodType]);
  } finally {
    _kpiReportRunning.delete(memKey);
  }
}

// ตัวจับเวลา: เกาะจังหวะเดียวกับ reportTick/shiftAnalysisTick (ทุก 60s) — ยิงตอน 06:05
// (เว้นระยะจากรายงานสิ้นกะ 06:00 กันชนกัน) เฉพาะวันจันทร์ (รายสัปดาห์) หรือวันที่ 1 (รายเดือน)
async function kpiReportTick() {
  try {
    const cfg = await getReportConfig();
    if (!cfg.kpiWeeklyEnabled && !cfg.kpiMonthlyEnabled) return;
    const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const workDay = bkk.slice(0, 10), hm = bkk.slice(11, 16);
    if (hm !== '06:05') return;

    if (cfg.kpiWeeklyEnabled && weekdayOf(workDay) === 1) {
      const weekEnd = addDaysStr(isoWeekStart(workDay), -1); // อาทิตย์ของสัปดาห์ก่อน
      const weekStartPrev = addDaysStr(weekEnd, -6);
      await sendKpiPeriodOnce(weekStartPrev, 'weekly', weekStartPrev, weekEnd,
        'สรุป KPI รายสัปดาห์', `${formatThaiDate(weekStartPrev)} – ${formatThaiDate(weekEnd)}`);
    }
    if (cfg.kpiMonthlyEnabled && dayOfMonth(workDay) === 1) {
      const prevMonthEnd = addDaysStr(workDay, -1); // วันสุดท้ายของเดือนก่อน
      const prevMonthStart = prevMonthEnd.slice(0, 8) + '01';
      await sendKpiPeriodOnce(prevMonthStart.slice(0, 7), 'monthly', prevMonthStart, prevMonthEnd,
        'สรุป KPI รายเดือน', `${formatThaiDate(prevMonthStart)} – ${formatThaiDate(prevMonthEnd)}`);
    }
  } catch (e) { console.error('[kpi-report] tick error', e.message); }
}

// เรียกส่งสรุป KPI เอง (ทดสอบ/ปุ่ม "ส่งเดี๋ยวนี้") — period = 'weekly' (สัปดาห์นี้จนถึงวันนี้) | 'monthly' (เดือนนี้จนถึงวันนี้)
app.post('/api/kpi/report/run', async (req, res) => {
  const period = req.body.period || req.query.period || 'weekly';
  const today = workDayBKK();
  const from = period === 'monthly' ? `${today.slice(0, 7)}-01` : isoWeekStart(today);
  const label = period === 'monthly' ? 'สรุป KPI รายเดือน (จนถึงวันนี้)' : 'สรุป KPI รายสัปดาห์ (จนถึงวันนี้)';
  const rangeText = `${formatThaiDate(from)} – ${formatThaiDate(today)}`;
  try {
    const analysis = await runKpiAnalysis(from, today, label, rangeText);
    if (analysis) {
      if (analysis.png) await sendPhotoBufferToTelegram(analysis.png, 'image/png', `${analysis.caption} (manual)`);
      else await sendToTelegram(`${analysis.text}\n\n<i>— ส่งด้วยตนเอง</i>`);
    }
    res.json({ ok: true, sent: !!analysis, from, to: today, data: analysis?.data || null, text: analysis?.text || '(SKIP — ไม่มีข้อมูล)' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// พรีวิวการ์ด KPI เป็นรูป PNG ในเบราว์เซอร์ (ไม่ส่ง Telegram)
app.get('/api/kpi/report/preview', async (req, res) => {
  const period = req.query.period || 'weekly';
  const today = workDayBKK();
  const from = period === 'monthly' ? `${today.slice(0, 7)}-01` : isoWeekStart(today);
  const label = period === 'monthly' ? 'สรุป KPI รายเดือน (จนถึงวันนี้)' : 'สรุป KPI รายสัปดาห์ (จนถึงวันนี้)';
  const rangeText = `${formatThaiDate(from)} – ${formatThaiDate(today)}`;
  try {
    const analysis = await runKpiAnalysis(from, today, label, rangeText);
    if (!analysis) return res.status(404).type('text/plain; charset=utf-8').send('SKIP — ไม่มีข้อมูลของช่วงนี้');
    if (!analysis.png) return res.status(200).type('text/plain; charset=utf-8').send(analysis.text.replace(/<[^>]+>/g, ''));
    res.type('image/png').send(analysis.png);
  } catch (err) { res.status(500).type('text/plain; charset=utf-8').send('error: ' + err.message); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ── KPI report เฟส 4: แจ้งเตือนเฉพาะจุดต้องระวัง (exception-based) ───────────
// ไม่พึ่ง daily_tasks.due_time (ยังไม่มีจุดกรอกค่าจริงในระบบ) — ใช้สัญญาณที่มี
// อยู่แล้วในสคีมาแทน: (1) ผลิตต่ำกว่าแผนติดต่อกัน N วัน (2) CIP ค้างนานผิดปกติ
// (3) งานค้างข้ามวันทำงาน
// ═══════════════════════════════════════════════════════════════════════════

// (1) หาไลน์+รสชาติที่ผลิตต่ำกว่าแผน "ทุกวัน" ในช่วง N วันทำงานล่าสุดที่ปิดแล้ว (ไม่รวมวันนี้)
async function detectProductionStreaks(streakDays) {
  const toDay = addDaysStr(workDayBKK(), -1); // วันทำงานล่าสุดที่ปิดแล้ว (เมื่อวาน)
  const fromDay = addDaysStr(toDay, -(streakDays - 1));
  const [prodRows, planRows] = await Promise.all([
    fetchProductionByWorkday(fromDay, toDay),
    dbAll(
      `SELECT plan_date, line_name, flavor, SUM(planned_batches) planned
       FROM production_plans WHERE plan_date BETWEEN ? AND ? GROUP BY plan_date, line_name, flavor`, [fromDay, toDay]),
  ]);
  const key = (l, f) => `${l}||${f}`;
  const byDayLF = {};
  for (const r of prodRows) { (byDayLF[r.work_day] || (byDayLF[r.work_day] = {}))[key(r.line_name, r.flavor)] = { actual: Number(r.actual), planned: 0 }; }
  for (const r of planRows) {
    const day = byDayLF[r.plan_date] || (byDayLF[r.plan_date] = {});
    const k = key(r.line_name, r.flavor);
    if (!day[k]) day[k] = { actual: 0, planned: 0 };
    day[k].planned = Number(r.planned || 0);
  }
  const allKeys = new Set();
  Object.values(byDayLF).forEach((day) => Object.keys(day).forEach((k) => allKeys.add(k)));
  const days = []; { let d = fromDay; while (d <= toDay) { days.push(d); d = addDaysStr(d, 1); } }
  const flagged = [];
  for (const k of allKeys) {
    const shortfallEveryDay = days.every((day) => {
      const e = byDayLF[day]?.[k];
      return e && e.planned > 0 && e.actual < e.planned;
    });
    if (shortfallEveryDay) {
      const [line, flavor] = k.split('||');
      const last = byDayLF[toDay][k];
      flagged.push({ line, flavor, days: streakDays, lastActual: last.actual, lastPlanned: last.planned });
    }
  }
  return flagged;
}

// (2) หาไลน์ CIP ที่ไม่มีบันทึกมานานเกิน threshold ชม. (ข้ามถ้าไม่เคยมีบันทึกเลย — ไม่มี baseline เทียบ)
async function detectCipStale(hoursThreshold) {
  const [l1, l23] = await Promise.all([
    dbAll(`SELECT MAX(created_at) mx FROM cip_line1_sessions`, []),
    dbAll(`SELECT line, MAX(created_at) mx FROM cip_line2_sessions GROUP BY line`, []),
  ]);
  const nowMs = Date.parse(nowBKK());
  const flagged = [];
  const check = (line, mx) => {
    if (!mx) return;
    const ageH = (nowMs - Date.parse(mx)) / 36e5;
    if (ageH > hoursThreshold) flagged.push({ line, hours: Math.round(ageH) });
  };
  check('Line 1', l1[0]?.mx);
  for (const r of l23) check((r.line || 'Line 2') === 'Line 2' ? 'Line 2' : 'Line 3', r.mx);
  return flagged;
}

// (3) งานที่ยังไม่เสร็จจากวันทำงานก่อนหน้า (ไม่ใช่ของวันนี้) — ใช้ column ที่มีอยู่แล้วแทน due_time
async function detectTaskBacklog() {
  const today = workDayBKK();
  return dbAll(
    `SELECT task_date, line_name, category, title FROM daily_tasks
     WHERE status != 'done' AND task_date < ? ORDER BY task_date`, [today]);
}

// ตัวจับเวลา: เกาะจังหวะเดียวกับ tick อื่นๆ — ยิงวันละครั้งตอน 06:10 (ต่อจาก kpiReportTick 06:05)
const _kpiAlertRunning = new Set();
async function kpiAlertTick() {
  try {
    const cfg = await getReportConfig();
    if (!cfg.kpiAlertEnabled) return;
    const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const today = bkk.slice(0, 10), hm = bkk.slice(11, 16);
    if (hm !== '06:10') return;
    const alertKey = `daily-${today}`;
    if (_kpiAlertRunning.has(alertKey)) return;
    const existing = await dbAll('SELECT id FROM kpi_alert_log WHERE alert_key = ?', [alertKey]);
    if (existing.length) return;
    _kpiAlertRunning.add(alertKey);
    await db.exec('INSERT INTO kpi_alert_log (alert_key, last_sent_at) VALUES (?, ?)', [alertKey, nowBKK()]);
    try {
      const [streaks, cipStale, backlog] = await Promise.all([
        detectProductionStreaks(cfg.kpiAlertStreakDays),
        detectCipStale(cfg.kpiAlertCipStaleHours),
        detectTaskBacklog(),
      ]);
      if (!streaks.length && !cipStale.length && !backlog.length) {
        console.log('[kpi-alert] tick — no issues, skip'); return;
      }
      const L = ['⚠️ <b>KPI Alert — พบจุดต้องระวัง</b>', ''];
      for (const s of streaks) L.push(`🔴 ${escapeHtml(s.line)} ${escapeHtml(s.flavor)}: ผลิตต่ำกว่าแผนติดต่อกัน ${s.days} วัน (ล่าสุด ${s.lastActual}/${s.lastPlanned})`);
      for (const c of cipStale) L.push(`🟡 CIP ${escapeHtml(c.line)}: ไม่มีบันทึกมา ${c.hours} ชม.`);
      if (backlog.length) {
        const grouped = {};
        for (const t of backlog) (grouped[t.task_date] || (grouped[t.task_date] = [])).push(t);
        for (const [day, items] of Object.entries(grouped)) L.push(`🟡 งานค้างจากวันที่ ${escapeHtml(day)}: ${items.length} รายการ`);
      }
      await sendToTelegram(L.join('\n'));
      console.log(`[kpi-alert] sent ${alertKey} (streaks=${streaks.length} cip=${cipStale.length} backlog=${backlog.length})`);
    } catch (e) {
      console.error('[kpi-alert] run error', e.message);
      await db.exec('DELETE FROM kpi_alert_log WHERE alert_key = ?', [alertKey]);
    } finally {
      _kpiAlertRunning.delete(alertKey);
    }
  } catch (e) { console.error('[kpi-alert] tick error', e.message); }
}

// เรียกตรวจ KPI alert เอง (ทดสอบ) — ไม่รอเวลา 06:10 และไม่กันซ้ำด้วย kpi_alert_log
app.post('/api/kpi/alert/run', async (req, res) => {
  try {
    const cfg = await getReportConfig();
    const [streaks, cipStale, backlog] = await Promise.all([
      detectProductionStreaks(cfg.kpiAlertStreakDays),
      detectCipStale(cfg.kpiAlertCipStaleHours),
      detectTaskBacklog(),
    ]);
    res.json({ ok: true, streaks, cipStale, backlogCount: backlog.length, backlog });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ค่ามาตรฐานคุณภาพ (baseline Brix/pH ต่อรส) — ผู้ใช้ตั้งเอง ────────────────
app.get('/api/quality-specs', async (req, res) => {
  try {
    const specs = await getQualitySpecs();
    // รสที่ "ผลิตจริง" บางตัวไม่อยู่ในลิสต์ ASSISTANT_FLAVORS (เช่น Freshy Passion fruit)
    // ถ้าไม่เอามารวม จะตั้งสเปกให้รสนั้นไม่ได้เลย → ค่าของมันไม่มีวันถูกตรวจ
    let produced = [];
    try {
      produced = (await dbAll(
        'SELECT DISTINCT flavor FROM production_logs WHERE flavor IS NOT NULL AND flavor != \'\'', []))
        .map((r) => r.flavor);
    } catch { /* ไม่มีตาราง/DB มีปัญหา — ใช้ลิสต์ตั้งต้นก็ยังทำงานได้ */ }
    const known = ASSISTANT_FLAVORS.split(', ');
    const extra = [...new Set([...produced, ...Object.keys(specs)])]
      .filter((f) => !known.includes(f)).sort((a, b) => a.localeCompare(b));
    res.json({ flavors: [...known, ...extra], specs, extraFlavors: extra });
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

// ═══════════════════════════════════════════════════════════════════════════
// 4-e วิเคราะห์คุณภาพย้อนหลัง — เทียบ Brix/pH ที่บันทึกจริง กับสเปกต่อรส
// ตอบ 3 คำถาม: หลุดสเปกกี่ครั้ง · รส/ไลน์ไหนบ่อยสุด · ค่าเลื่อนไปทางไหน
//
// 🔑 แหล่งข้อมูล = `production_logs` (ค่าที่กรอกตอนกด Done ทุก batch) เท่านั้น
//    ไม่เอา `cip_step_logs` มาปนแม้แผนจะเขียนไว้ — ค่าใน CIP คือ "ค่าน้ำล้าง"
//    (เจอ pH 15 ได้เพราะเป็นน้ำด่าง) ไม่ใช่ค่าสินค้า เอามาเทียบสเปกรสไม่ได้
//    และตารางนั้นก็ไม่มีช่องรสชาติ + บน prod ยังว่างอยู่
// รวมยอดใน JS ไม่ใช่ SQL — เลี่ยงฟังก์ชันสถิติ/วันที่ที่ SQLite กับ Postgres ต่างกัน
// ═══════════════════════════════════════════════════════════════════════════

// ค่าหนึ่งค่าเทียบช่วงสเปก → null = ไม่มีสเปกด้านนั้น (ไม่ตัดสิน) · ok/low/high
function specSide(v, min, max) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const has = (x) => x != null && Number.isFinite(Number(x));
  if (!has(min) && !has(max)) return null;                // ไม่ได้ตั้งสเปกไว้ = ไม่เตือน
  if (has(min) && Number(v) < Number(min)) return 'low';
  if (has(max) && Number(v) > Number(max)) return 'high';
  return 'ok';
}
// ห่างจากขอบสเปกเท่าไหร่ (บวกเสมอ) — ใช้เรียงว่าครั้งไหนหลุดแรงสุด
function specOff(v, min, max, side) {
  if (side === 'low') return round2(Number(min) - Number(v));
  if (side === 'high') return round2(Number(v) - Number(max));
  return 0;
}
const avgOf = (a) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : null);
// ค่าเฉลี่ยอยู่ตรงไหนในช่วงสเปก: 0 = ขอบล่าง, 1 = ขอบบน (null ถ้าสเปกไม่ครบสองด้าน)
function bandPos(avg, min, max) {
  if (avg == null || min == null || max == null || Number(max) <= Number(min)) return null;
  return round2((avg - Number(min)) / (Number(max) - Number(min)));
}
// เทรนด์: เทียบค่าเฉลี่ยครึ่งแรกกับครึ่งหลังของช่วงที่ดู (ต้องมีอย่างน้อย 6 ค่า)
// ถือว่า "นิ่ง" ถ้าขยับน้อยกว่า 10% ของความกว้างสเปก (ไม่มีสเปก = 2% ของค่าเฉลี่ย)
function halfTrend(values, min, max) {
  if (values.length < 6) return null;
  const half = Math.floor(values.length / 2);
  const first = avgOf(values.slice(0, half)), last = avgOf(values.slice(values.length - half));
  const delta = last - first;
  const width = (min != null && max != null && Number(max) > Number(min)) ? Number(max) - Number(min) : null;
  const flatAt = width != null ? width * 0.1 : Math.abs(first) * 0.02;
  return {
    first: round2(first), last: round2(last), delta: round2(delta),
    dir: Math.abs(delta) < flatAt ? 'flat' : (delta > 0 ? 'up' : 'down'),
  };
}

async function buildQualityHistory({ from, to, flavor, line } = {}) {
  const cond = ['substr(timestamp,1,10) BETWEEN ? AND ?', '(brix IS NOT NULL OR ph IS NOT NULL)'];
  const args = [from, to];
  if (flavor) { cond.push('flavor = ?'); args.push(flavor); }
  if (line) { cond.push('line_name = ?'); args.push(line); }
  const [logs, specs] = await Promise.all([
    dbAll(`SELECT timestamp, line_name, flavor, batch, operator_name, brix, ph
             FROM production_logs WHERE ${cond.join(' AND ')} ORDER BY timestamp`, args),
    getQualitySpecs(),
  ]);

  const byFlavor = {}, byLine = {}, byDay = {}, noSpec = {}, out = [];
  let checked = 0, outCount = 0;
  for (const r of logs) {
    const fl = r.flavor || '(ไม่ระบุรส)';
    const sp = specs[fl] || null;
    const brix = r.brix == null ? null : Number(r.brix);
    const ph = r.ph == null ? null : Number(r.ph);
    const bSide = sp ? specSide(brix, sp.brix_min, sp.brix_max) : null;
    const pSide = sp ? specSide(ph, sp.ph_min, sp.ph_max) : null;
    const isChecked = bSide != null || pSide != null;     // มีอย่างน้อย 1 ด้านที่ตรวจได้
    const isOut = bSide === 'low' || bSide === 'high' || pSide === 'low' || pSide === 'high';
    if (isChecked) checked += 1; else if (!sp) noSpec[fl] = (noSpec[fl] || 0) + 1;
    if (isOut) outCount += 1;

    const f = byFlavor[fl] || (byFlavor[fl] = {
      flavor: fl, n: 0, checked: 0, out: 0, brixVals: [], phVals: [],
      brixOut: { low: 0, high: 0 }, phOut: { low: 0, high: 0 },
      spec: sp ? { brixMin: sp.brix_min, brixMax: sp.brix_max, phMin: sp.ph_min, phMax: sp.ph_max } : null,
    });
    f.n += 1;
    if (isChecked) f.checked += 1;
    if (isOut) f.out += 1;
    if (brix != null) f.brixVals.push(brix);
    if (ph != null) f.phVals.push(ph);
    if (bSide === 'low' || bSide === 'high') f.brixOut[bSide] += 1;
    if (pSide === 'low' || pSide === 'high') f.phOut[pSide] += 1;

    const ln = r.line_name || '(ไม่ระบุไลน์)';
    const L = byLine[ln] || (byLine[ln] = { line: ln, n: 0, checked: 0, out: 0, flavors: {} });
    L.n += 1; if (isChecked) L.checked += 1;
    if (isOut) { L.out += 1; L.flavors[fl] = (L.flavors[fl] || 0) + 1; }

    const day = String(r.timestamp || '').slice(0, 10);
    const d = byDay[day] || (byDay[day] = { day, n: 0, checked: 0, out: 0 });
    d.n += 1; if (isChecked) d.checked += 1; if (isOut) d.out += 1;

    if (isOut) out.push({
      at: r.timestamp, day, line: ln, flavor: fl, batch: r.batch || '',
      operator: r.operator_name || '',
      brix, ph, brixSide: bSide, phSide: pSide,
      off: Math.max(
        bSide ? specOff(brix, sp.brix_min, sp.brix_max, bSide) : 0,
        pSide ? specOff(ph, sp.ph_min, sp.ph_max, pSide) : 0),
      brixOff: bSide === 'low' || bSide === 'high' ? specOff(brix, sp.brix_min, sp.brix_max, bSide) : 0,
      phOff: pSide === 'low' || pSide === 'high' ? specOff(ph, sp.ph_min, sp.ph_max, pSide) : 0,
    });
  }

  const flavors = Object.values(byFlavor).map((f) => {
    const sp = f.spec || {};
    const bAvg = avgOf(f.brixVals), pAvg = avgOf(f.phVals);
    return {
      flavor: f.flavor, n: f.n, checked: f.checked, out: f.out,
      rate: f.checked ? Math.round((f.out / f.checked) * 100) : null,
      spec: f.spec,
      brix: {
        n: f.brixVals.length, avg: bAvg == null ? null : round2(bAvg),
        min: f.brixVals.length ? round2(Math.min(...f.brixVals)) : null,
        max: f.brixVals.length ? round2(Math.max(...f.brixVals)) : null,
        low: f.brixOut.low, high: f.brixOut.high,
        pos: bandPos(bAvg, sp.brixMin, sp.brixMax),
        trend: halfTrend(f.brixVals, sp.brixMin, sp.brixMax),
      },
      ph: {
        n: f.phVals.length, avg: pAvg == null ? null : round2(pAvg),
        min: f.phVals.length ? round2(Math.min(...f.phVals)) : null,
        max: f.phVals.length ? round2(Math.max(...f.phVals)) : null,
        low: f.phOut.low, high: f.phOut.high,
        pos: bandPos(pAvg, sp.phMin, sp.phMax),
        trend: halfTrend(f.phVals, sp.phMin, sp.phMax),
      },
    };
  }).sort((a, b) => b.out - a.out || (b.rate || 0) - (a.rate || 0) || b.n - a.n);

  const lines = Object.values(byLine).map((L) => {
    const top = Object.entries(L.flavors).sort((a, b) => b[1] - a[1])[0];
    return {
      line: L.line, n: L.n, checked: L.checked, out: L.out,
      rate: L.checked ? Math.round((L.out / L.checked) * 100) : null,
      topFlavor: top ? { flavor: top[0], out: top[1] } : null,
    };
  }).sort((a, b) => b.out - a.out || b.n - a.n);

  const worst = flavors.find((f) => f.out > 0) || null;
  const worstLine = lines.find((l) => l.out > 0) || null;
  // รสที่เลื่อนออกนอกกลางสเปกชัดเจน (ยังไม่หลุดก็เตือนได้) — เรียงจากที่เลื่อนแรงสุด
  const drifting = [];
  for (const f of flavors) {
    for (const [k, label] of [['brix', 'Brix'], ['ph', 'pH']]) {
      const m = f[k];
      if (m.trend && m.trend.dir !== 'flat') {
        drifting.push({ flavor: f.flavor, metric: label, ...m.trend, pos: m.pos, n: m.n });
      }
    }
  }
  drifting.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    from, to,
    filter: { flavor: flavor || '', line: line || '' },
    readings: logs.length, checked, out: outCount,
    rate: checked ? Math.round((outCount / checked) * 100) : null,
    flavors, lines,
    byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    rows: out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300),
    worstFlavor: worst ? { flavor: worst.flavor, out: worst.out, rate: worst.rate } : null,
    worstLine: worstLine ? { line: worstLine.line, out: worstLine.out, rate: worstLine.rate } : null,
    drifting: drifting.slice(0, 8),
    // ค่าที่ยังไม่ถูกตรวจเลยเพราะรสนั้นไม่มีสเปก — บอกตรงๆ ว่าตัวเลขข้างบนยังไม่ครอบคลุมทั้งหมด
    noSpec: Object.entries(noSpec).map(([f, n]) => ({ flavor: f, n })).sort((a, b) => b.n - a.n),
    specCount: Object.keys(specs).length,
  };
}

// ช่วงเวลาเริ่มต้น = 30 วันย้อนหลัง (แบบเดียวกับหน้า downtime/ต้นทุน)
function rangeFromQuery(q = {}) {
  const today = todayBKK();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from
    : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}


/* ══════════ สเปกน้ำล้าง CIP + วิเคราะห์ย้อนหลัง (ต่อยอดจาก 4-e ฝั่งสินค้า) ══════════
   🔴 ค่าใน CIP คือ "ค่าน้ำล้าง" ไม่ใช่ค่าสินค้า — เทียบกับ quality_specs (ต่อรส) ไม่ได้เด็ดขาด
      (น้ำด่างมี pH 12-14 เป็นเรื่องปกติ ถ้าเอาไปเทียบสเปกน้ำหวานจะเตือนผิดทั้งตาราง)
      จึงมีตารางสเปกของตัวเอง: cip_specs ต่อไลน์                                      */
async function getCipSpecs() {
  const rows = await dbAll('SELECT line, ph_min, ph_max, pressure_min, pressure_max, max_minutes, updated_at FROM cip_specs', []);
  const map = {};
  for (const r of rows) map[r.line] = r;
  return map;
}
async function setCipSpec(line, spec = {}) {
  const L = String(line || '').trim();
  if (!L) throw new Error('ต้องระบุไลน์');
  const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  const row = {
    ph_min: num(spec.ph_min), ph_max: num(spec.ph_max),
    pressure_min: num(spec.pressure_min), pressure_max: num(spec.pressure_max),
    max_minutes: num(spec.max_minutes),
  };
  await db.exec(
    `INSERT INTO cip_specs (line, ph_min, ph_max, pressure_min, pressure_max, max_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(line) DO UPDATE SET ph_min = excluded.ph_min, ph_max = excluded.ph_max,
       pressure_min = excluded.pressure_min, pressure_max = excluded.pressure_max,
       max_minutes = excluded.max_minutes, updated_at = excluded.updated_at`,
    [L, row.ph_min, row.ph_max, row.pressure_min, row.pressure_max, row.max_minutes, nowBKK()]);
  return { line: L, ...row };
}
const CIP_LINES = ['Line 1', 'Line 2', 'Line 3'];

app.get('/api/cip-specs', async (req, res) => {
  try { res.json({ lines: CIP_LINES, specs: await getCipSpecs() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cip-specs', async (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.items)) {
      const out = [];
      for (const it of b.items) out.push(await setCipSpec(it.line, it));
      return res.json({ ok: true, saved: out.length, items: out });
    }
    res.json({ ok: true, saved: await setCipSpec(b.line, b) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/cip-specs/:line', async (req, res) => {
  try { await db.exec('DELETE FROM cip_specs WHERE line = ?', [req.params.line]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// วิเคราะห์รอบ CIP ย้อนหลังเทียบสเปกของไลน์นั้น — โครงเดียวกับ 4-e ฝั่งสินค้า
async function buildCipQuality({ from, to, line } = {}) {
  const [cip, specs] = await Promise.all([fetchCipRounds(from, to), getCipSpecs()]);
  const all = [...cip.rounds].filter(r => !line || r.line === line);
  const byLine = {}, out = [];
  let checked = 0, outCount = 0;
  for (const r of all) {
    const sp = specs[r.line] || null;
    const phSide = sp ? specSide(r.ph, sp.ph_min, sp.ph_max) : null;
    const prSide = sp ? specSide(r.pressure, sp.pressure_min, sp.pressure_max) : null;
    // เวลาต่อรอบ: มีแต่ขอบบน (ล้างเร็วกว่ากำหนดไม่ใช่ปัญหา — ช้าเกินถึงจะผิด)
    const tmSide = sp && sp.max_minutes != null && Number.isFinite(Number(r.minutes))
      ? (Number(r.minutes) > Number(sp.max_minutes) ? 'high' : 'ok') : null;
    const isChecked = phSide != null || prSide != null || tmSide != null;
    const isOut = [phSide, prSide, tmSide].some(v => v === 'low' || v === 'high');
    if (isChecked) checked += 1;
    if (isOut) outCount += 1;

    const L = byLine[r.line] || (byLine[r.line] = {
      line: r.line, n: 0, checked: 0, out: 0, phVals: [], prVals: [], minVals: [],
      phOut: { low: 0, high: 0 }, prOut: { low: 0, high: 0 }, slow: 0,
      spec: sp ? { phMin: sp.ph_min, phMax: sp.ph_max, prMin: sp.pressure_min, prMax: sp.pressure_max, maxMin: sp.max_minutes } : null,
    });
    L.n += 1;
    if (isChecked) L.checked += 1;
    if (isOut) L.out += 1;
    if (r.ph != null) L.phVals.push(r.ph);
    if (r.pressure != null) L.prVals.push(r.pressure);
    if (Number.isFinite(Number(r.minutes))) L.minVals.push(Number(r.minutes));
    if (phSide === 'low' || phSide === 'high') L.phOut[phSide] += 1;
    if (prSide === 'low' || prSide === 'high') L.prOut[prSide] += 1;
    if (tmSide === 'high') L.slow += 1;

    if (isOut) out.push({
      at: r.at || r.day, day: r.day, line: r.line, operator: r.operator, item: r.item,
      row: r.row, shift: r.shift, minutes: r.minutes, ph: r.ph, pressure: r.pressure,
      phSide, prSide, slow: tmSide === 'high',
      phOff: phSide ? specOff(r.ph, sp.ph_min, sp.ph_max, phSide) : 0,
      prOff: prSide ? specOff(r.pressure, sp.pressure_min, sp.pressure_max, prSide) : 0,
      overMin: tmSide === 'high' ? round2(Number(r.minutes) - Number(sp.max_minutes)) : 0,
    });
  }
  const lines = Object.values(byLine).map((L) => ({
    line: L.line, n: L.n, checked: L.checked, out: L.out,
    rate: L.checked ? Math.round((L.out / L.checked) * 100) : null,
    spec: L.spec, slow: L.slow,
    ph: { n: L.phVals.length, avg: L.phVals.length ? round2(avgOf(L.phVals)) : null, median: medianOf(L.phVals), low: L.phOut.low, high: L.phOut.high },
    pressure: { n: L.prVals.length, avg: L.prVals.length ? round2(avgOf(L.prVals)) : null, median: medianOf(L.prVals), low: L.prOut.low, high: L.prOut.high },
    minutes: { n: L.minVals.length, median: medianOf(L.minVals), max: L.minVals.length ? Math.max(...L.minVals) : null },
  })).sort((a, b) => b.out - a.out || b.n - a.n);

  const noSpec = lines.filter(l => !l.spec).map(l => ({ line: l.line, n: l.n }));
  return {
    from, to, rounds: all.length, checked, out: outCount,
    rate: checked ? Math.round((outCount / checked) * 100) : null,
    lines, noSpec, openCount: cip.open.length,
    rows: out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200),
    specCount: Object.keys(specs).length,
  };
}

app.get('/api/cip/quality', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  try { res.json(await buildCipQuality({ from, to, line: req.query.line })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/quality/history', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  try {
    res.json(await buildQualityHistory({ from, to, flavor: req.query.flavor, line: req.query.line }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   เฝ้าค่าคุณภาพ → เปิดเหตุการณ์ให้อัตโนมัติ (แผน KM ข้อ 5)
   ต่อยอดจาก 4-e: buildQualityHistory() บอกอยู่แล้วว่าค่าไหนหลุดสเปกไปเท่าไหร่
   ที่นี่แค่ "จัดกลุ่ม → เปิดเหตุการณ์ → เขียนโน้ตเข้าวอลต์ → บอก Telegram"

   🔑 กันซ้ำด้วย `quality_watch_log` คีย์ = วัน|รส|ค่าที่หลุด
      (ยิงซ้ำกี่รอบก็ได้ ไม่เกิดเหตุการณ์ซ้ำ — n8n/tick เรียกทับกันได้ปลอดภัย)
   🔑 ไม่แตะรสที่ยังไม่ได้ตั้งสเปก (buildQualityHistory ไม่นับให้อยู่แล้ว)
   ═══════════════════════════════════════════════════════════════════════════ */
async function insertIncidentRow(row) {
  const r = await dbRun(
    `INSERT INTO incidents (title, machine, line_name, batch_id, operator, occurred_at,
       symptom, cause, fix, result, status, images, result_images, down_from, down_to,
       source, ref_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.title, row.machine || null, row.line_name || null, row.batch_id || null, row.operator || null,
     row.occurred_at || todayBKK(), row.symptom || null, row.cause || null, row.fix || null, row.result || null,
     row.status || 'open', row.images || null, row.result_images || null,
     row.down_from || null, row.down_to || null,
     incSource(row.source, 'ai'), row.ref_key || null, nowBKK(), nowBKK()]);
  const id = r.lastID;
  const sync = await syncIncident({ ...row, id });
  if (sync.path) await db.exec('UPDATE incidents SET vault_path = ? WHERE id = ?', [sync.path, id]);
  touchMachineNote(row.machine);
  return { id, vaultPath: sync.path || null, vaultError: sync.error || null };
}

// ข้อความอธิบายอาการ — เขียนให้คนอ่านรู้เรื่องโดยไม่ต้องเปิดหน้าคุณภาพ
function watchSymptom(metric, rows, spec) {
  const unit = metric === 'ph' ? 'pH' : 'Brix';
  const range = metric === 'ph'
    ? `${spec.phMin == null ? '–' : spec.phMin}–${spec.phMax == null ? '–' : spec.phMax}`
    : `${spec.brixMin == null ? '–' : spec.brixMin}–${spec.brixMax == null ? '–' : spec.brixMax}`;
  const lines = rows.slice(0, 12).map(r => {
    const v = metric === 'ph' ? r.ph : r.brix;
    const side = metric === 'ph' ? r.phSide : r.brixSide;
    const off = metric === 'ph' ? r.phOff : r.brixOff;
    return `- ${String(r.at).slice(11, 16)} น. · ${r.line}${r.batch ? ` · Batch ${r.batch}` : ''} · ${unit} ${v} ` +
      `(${side === 'low' ? 'ต่ำกว่า' : 'สูงกว่า'}สเปก ${off})${r.operator ? ` · ${r.operator}` : ''}`;
  });
  return [`${unit} หลุดสเปก ${rows.length} ครั้ง (สเปก ${range})`, ...lines,
    rows.length > 12 ? `- …อีก ${rows.length - 12} ครั้ง` : ''].filter(Boolean).join('\n');
}

async function runQualityWatch({ from, to, dryRun = false, minOut = 1 } = {}) {
  const h = await buildQualityHistory({ from, to });
  // จัดกลุ่ม: วัน × รส × ค่าที่หลุด (Brix กับ pH แยกกัน — คนละสาเหตุ)
  const groups = {};
  for (const r of h.rows) {
    for (const metric of ['brix', 'ph']) {
      const side = metric === 'ph' ? r.phSide : r.brixSide;
      if (side !== 'low' && side !== 'high') continue;
      const key = `${r.day}|${r.flavor}|${metric}`;
      (groups[key] = groups[key] || { key, day: r.day, flavor: r.flavor, metric, rows: [] }).rows.push(r);
    }
  }
  const found = Object.values(groups).filter(g => g.rows.length >= minOut);
  if (!found.length) return { from: h.from, to: h.to, checked: h.checked, out: h.out, created: [], skipped: [], found: 0 };

  const keys = found.map(g => g.key);
  const done = await dbAll(
    `SELECT watch_key FROM quality_watch_log WHERE watch_key IN (${keys.map(() => '?').join(',')})`, keys);
  const doneSet = new Set(done.map(d => d.watch_key));

  const created = [], skipped = [];
  for (const g of found) {
    if (doneSet.has(g.key)) { skipped.push(g.key); continue; }
    const unit = g.metric === 'ph' ? 'pH' : 'Brix';
    const spec = (h.flavors.find(f => f.flavor === g.flavor) || {}).spec || {};
    const lines = {}; for (const r of g.rows) lines[r.line] = (lines[r.line] || 0) + 1;
    const topLine = Object.entries(lines).sort((a, b) => b[1] - a[1])[0];
    const inc = {
      title: `${unit} หลุดสเปก — ${g.flavor} ${formatThaiDate(g.day)} (${g.rows.length} ครั้ง)`,
      machine: null, line_name: topLine ? topLine[0] : null,
      batch_id: g.rows[0].batch || null,
      operator: 'ระบบตรวจอัตโนมัติ',
      occurred_at: g.day,
      symptom: watchSymptom(g.metric, g.rows, spec),
      cause: null, fix: null, result: null, status: 'open',
    };
    if (dryRun) { created.push({ key: g.key, title: inc.title, dryRun: true }); continue; }
    // จองคีย์ก่อนสร้างจริง — ถ้ามีคนยิงพร้อมกัน อีกฝั่งจะ insert ไม่ผ่านแล้วข้ามไป
    try { await db.exec('INSERT INTO quality_watch_log (watch_key, created_at) VALUES (?, ?)', [g.key, nowBKK()]); }
    catch { skipped.push(g.key); continue; }
    const res = await insertIncidentRow(inc);
    await db.exec('UPDATE quality_watch_log SET incident_id = ? WHERE watch_key = ?', [res.id, g.key]);
    created.push({ key: g.key, id: res.id, title: inc.title, vaultPath: res.vaultPath, vaultError: res.vaultError });
  }

  if (created.length && !dryRun && process.env.TELEGRAM_CHAT_ID) {
    const L = ['🔬 <b>พบค่าหลุดสเปก — เปิดเหตุการณ์ให้แล้ว</b>', ''];
    for (const c of created) L.push(`• ${escapeHtml(c.title)}`);
    L.push('', 'เปิดหน้า <b>เหตุการณ์</b> ในแอปเพื่อกรอกสาเหตุ/วิธีแก้');
    await notify('incident', L.join('\n'));
  }
  return { from: h.from, to: h.to, checked: h.checked, out: h.out, found: found.length, created, skipped };
}

/* ให้ n8n (หรือปุ่มในแอป) เรียกได้ — ?hours=12 ดูย้อนหลังกี่ชั่วโมง · dryRun=1 ดูเฉย ๆ ไม่เขียน
   ยิงซ้ำได้ปลอดภัย: คีย์กันซ้ำทำให้ครั้งที่ 2 เป็น no-op                                */
app.post('/api/quality/watch', async (req, res) => {
  const b = { ...req.query, ...(req.body || {}) };
  const hours = Math.max(1, Math.min(24 * 30, Number(b.hours) || 12));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(b.to || '') ? b.to : todayBKK();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(b.from || '') ? b.from
    : new Date(Date.parse(`${to}T00:00:00Z`) - Math.ceil(hours / 24) * 86400000).toISOString().slice(0, 10);
  try {
    res.json(await runQualityWatch({ from, to, dryRun: b.dryRun === '1' || b.dryRun === true }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ตัวจับเวลา: ตรวจตอนสิ้นกะของวันนั้น (ตามตารางกะจริง) — เปิด/ปิดที่หน้ารายงาน
const _qualityWatchRan = new Set();
async function qualityWatchTick() {
  try {
    const cfg = await getReportConfig();
    if (!cfg.qualityWatchEnabled) return;
    const bkk = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const today = bkk.slice(0, 10), hm = bkk.slice(11, 16);
    const wd = weekdayOf((Number(hm.slice(0, 2)) < 6) ? addDaysStr(today, -1) : today);
    if (!shiftEndsForWeekday(wd).includes(hm)) return;      // ไม่ใช่เวลาสิ้นกะ = ไม่ต้องทำอะไร
    const key = `${today} ${hm}`;
    if (_qualityWatchRan.has(key)) return;
    _qualityWatchRan.add(key);
    const r = await runQualityWatch({ from: addDaysStr(today, -1), to: today });
    console.log(`[quality-watch] ${key} → เจอ ${r.found} กลุ่ม · เปิดใหม่ ${r.created.length}`);
  } catch (e) { console.error('[quality-watch] tick error', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4-f เทียบประสิทธิภาพรายคน / รายกะ — 3 มุมจากข้อมูลที่มีจริง
//  (1) งานประจำรายคน — `routine_state` + งานมอบหมาย เทียบเช็กลิสต์ปัจจุบัน
//  (2) รายกะ — bucket "เวลาที่เกิดเรื่อง" ด้วย `factoryShiftsForWeekday`
//      (ผลิต/รอบ CIP/เวลาที่ติ๊กงาน) · **ไม่ใช่** ทีมกะไหนเป็นคนทำ
//      เพราะระบบไม่ได้เก็บว่าใครอยู่กะไหนในวันนั้น (`shift_crew` = รายชื่อปัจจุบัน ไม่ใช่ประวัติ)
//  (3) เวลาต่อรอบ CIP — จาก rows ของ cip_line1/2 เทียบ **ค่ากลาง (median)** ไม่ใช่ค่าเฉลี่ย
//      เพราะรอบที่ลืมกด Stop/ทิ้งไว้ข้ามคืน ทำให้ค่าเฉลี่ยเพี้ยนง่าย
// รวมยอดใน JS ทั้งหมด (dialect-safe) · วันที่ไม่มีใครแตะระบบเลย = ไม่นับ ไม่ใช่ 0%
// ═══════════════════════════════════════════════════════════════════════════

// กะที่ครอบเวลานั้น (ตามตารางโรงงาน เดินจริง 7 วัน) + วันทำงานของมัน (06:00→06:00)
function shiftAt(dateStr, hour) {
  const workDay = hour < 6 ? addDaysStr(dateStr, -1) : dateStr;
  const shifts = factoryShiftsForWeekday(weekdayOf(workDay));
  for (const s of shifts) {
    const hit = s.start < s.end ? (hour >= s.start && hour < s.end) : (hour >= s.start || hour < s.end);
    if (hit) return { workDay, key: s.key };
  }
  return { workDay, key: (shifts[shifts.length - 1] || {}).key || 'ดึก' };
}
const medianOf = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? round2(s[m]) : round2((s[m - 1] + s[m]) / 2);
};
const pctOf = (done, total) => (total ? Math.round((done / total) * 100) : null);

// ── (3) รอบ CIP ที่ทำเสร็จในช่วง พร้อมเวลาที่ใช้ ────────────────────────────
// ⚠️ `data` ของ cip_line2_rows อาจมีรูป base64 อยู่ข้างใน — ดึงเฉพาะ session ที่อยู่ในช่วง
//    เท่านั้น (อย่าดึงทั้งตาราง) แล้วแกะในเซิร์ฟเวอร์ ไม่ส่งต่อให้ client
async function fetchCipRounds(from, to) {
  const [l1, l2] = await Promise.all([
    dbAll('SELECT id, operator_name, date, sku, created_at FROM cip_line1_sessions', []),
    dbAll('SELECT id, operator_name, date, line, flavor, created_at FROM cip_line2_sessions', []),
  ]);
  const dayOf = (s) => String(s.date || s.created_at || '').slice(0, 10);
  const inRange = (s) => { const d = dayOf(s); return d >= from && d <= to; };
  const s1 = l1.filter(inRange), s2 = l2.filter(inRange);
  const grab = async (table, ids) => {
    if (!ids.length) return [];
    return dbAll(`SELECT session_id, data FROM ${table} WHERE session_id IN (${ids.map(() => '?').join(',')})`, ids);
  };
  const [r1, r2] = await Promise.all([
    grab('cip_line1_rows', s1.map(s => s.id)),
    grab('cip_line2_rows', s2.map(s => s.id)),
  ]);
  const meta = {};
  for (const s of s1) meta[`1|${s.id}`] = { line: 'Line 1', operator: s.operator_name || '(ไม่ระบุ)', day: dayOf(s), item: s.sku || '' };
  for (const s of s2) meta[`2|${s.id}`] = { line: s.line || 'Line 2', operator: s.operator_name || '(ไม่ระบุ)', day: dayOf(s), item: s.flavor || '' };

  const rounds = [], open = [];
  const push = (kind, rows) => {
    for (const row of rows) {
      const m = meta[`${kind}|${row.session_id}`];
      if (!m) continue;
      let d; try { d = JSON.parse(row.data); } catch { continue; }
      // เวลาเริ่มจริง: Line 1 เก็บเป็น ISO (UTC) · Line 2 เก็บ epoch ms ใน startRaw
      let startedAt = null;
      if (typeof d.startRaw === 'number' && d.startRaw > 0) startedAt = new Date(d.startRaw);
      else if (typeof d.startTime === 'string' && d.startTime.length > 10) { const t = new Date(d.startTime); if (!isNaN(t)) startedAt = t; }
      const local = startedAt ? new Date(startedAt.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })) : null;
      const day = local ? local.toLocaleDateString('sv-SE') : m.day;
      const sh = local ? shiftAt(day, local.getHours()) : null;
      const minutes = Number(d.duration);
      // ค่าที่วัดในรอบนั้น — Line 2/3 มีแรงดันปั๊ม 2 ตัว เอาตัวที่กรอกมาเป็นหลัก
      const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
      const p1 = numOrNull(d.pump1Pressure), p2 = numOrNull(d.pump2Pressure);
      const base = {
        line: m.line, operator: m.operator, item: m.item, day,
        at: local ? `${day}T${pad2(local.getHours())}:${pad2(local.getMinutes())}` : '',
        shift: sh ? sh.key : '', workDay: sh ? sh.workDay : day,
        backwash: !!d.backwash,
        row: Number(d.rowNo) || null,
        ph: numOrNull(d.ph), brix: numOrNull(d.brix),
        pressure: p1 != null ? p1 : p2, pressure2: p1 != null ? p2 : null,
      };
      if (d.endTime && Number.isFinite(minutes) && minutes > 0) rounds.push({ ...base, minutes });
      else if (d.startTime) open.push(base);            // เริ่มแล้วแต่ไม่มีเวลาจบ = ลืมกด Stop
    }
  };
  push('1', r1); push('2', r2);
  rounds.sort((a, b) => String(b.at || b.day).localeCompare(String(a.at || a.day)));
  return { rounds, open, sessions: s1.length + s2.length };
}

async function buildPerfSummary({ from, to } = {}) {
  const people = getPeople().filter(p => (p.kind || 'shift') === 'shift');
  const trees = {};
  for (const p of people) trees[p.person_key] = flattenRoutine(await buildRoutineTree(p.person_key));

  const [states, tasks, prodRows, cip, opRows] = await Promise.all([
    dbAll('SELECT state_date, assignee, node_key, checked, bypassed, handoff_to, updated_at FROM routine_state WHERE state_date BETWEEN ? AND ?', [from, to]),
    dbAll("SELECT task_date, assignee, status, category FROM daily_tasks WHERE task_date BETWEEN ? AND ? AND source = 'assigned'", [from, to]),
    // ช่วงวันทำงาน 06:00→06:00 (แบบเดียวกับ fetchProductionByWorkday) — กะดึกคาบเที่ยงคืน
    dbAll('SELECT timestamp, line_name, flavor, operator_name FROM production_logs WHERE timestamp >= ? AND timestamp < ?',
      [`${from}T06:00:00`, `${addDaysStr(to, 1)}T06:00:00`]),
    fetchCipRounds(from, to),
    dbAll('SELECT name, shift FROM operators', []),
  ]);
  // ใครอยู่ทีมกะไหน (จาก operators.shift ที่คนตั้งเอง) — คนละเรื่องกับ "เกิดในช่วงเวลาของกะไหน"
  const crewOf = {}; for (const o of opRows || []) if (o.shift) crewOf[o.name] = o.shift;

  // ── (1) งานประจำรายคน ────────────────────────────────────────────────────
  // วันที่ "นับ" = วันที่มีคนแตะระบบจริง (ติ๊ก/ข้าม/มีงานมอบหมาย) — วันที่เงียบสนิท
  // ไม่ใช่ 0% แต่คือ "ไม่ได้ใช้งาน" ถ้าเอามาเฉลี่ยด้วยจะกดคะแนนทุกคนโดยไม่มีความหมาย
  const dayHits = {};
  for (const s of states) if (s.checked || s.bypassed) dayHits[s.state_date] = true;
  for (const t of tasks) dayHits[t.task_date] = true;
  const countedDays = Object.keys(dayHits).sort();

  const perDay = {};                                    // person → date → ตัวเลขของวันนั้น
  const blank = () => ({ done: 0, total: 0, bypassed: 0, received: 0, receivedDone: 0, adhoc: 0, adhocDone: 0 });
  for (const p of people) {
    perDay[p.person_key] = {};
    for (const day of countedDays) perDay[p.person_key][day] = { ...blank(), total: trees[p.person_key].length };
  }
  const keyOk = (pk, day) => perDay[pk] && perDay[pk][day];
  for (const s of states) {
    const d = perDay[s.assignee] && perDay[s.assignee][s.state_date];
    if (d) {
      if (s.bypassed) { d.bypassed += 1; d.total -= 1; }  // ข้ามงาน = ตัดออกจากตัวหาร (เหมือนบอร์ด)
      else if (s.checked) d.done += 1;
    }
    // งานที่ถูกมอบต่อไปให้คนอื่น → ไปเพิ่มภาระของ "คนรับ" ในวันนั้น
    if (s.bypassed && s.handoff_to && keyOk(s.handoff_to, s.state_date)) {
      const r = perDay[s.handoff_to][s.state_date];
      r.received += 1; r.total += 1;
      if (s.checked) { r.receivedDone += 1; r.done += 1; }
    }
  }
  for (const t of tasks) {
    const d = keyOk(t.assignee, t.task_date) ? perDay[t.assignee][t.task_date] : null;
    if (!d) continue;
    d.adhoc += 1; d.total += 1;
    if (t.status === 'done') { d.adhocDone += 1; d.done += 1; }
  }

  const persons = people.map((p) => {
    const days = countedDays.map(day => {
      const d = perDay[p.person_key][day];
      return { date: day, ...d, pct: pctOf(d.done, d.total) };
    });
    const worked = days.filter(d => d.done > 0 || d.bypassed > 0 || d.adhoc > 0);
    const sum = (f) => days.reduce((n, d) => n + f(d), 0);
    const done = sum(d => d.done), total = sum(d => d.total);
    // เทรนด์: ครึ่งแรกเทียบครึ่งหลังของวันที่นับ (ต้องมีอย่างน้อย 4 วัน ไม่งั้นเป็นเสียงรบกวน)
    let trend = null;
    if (days.length >= 4) {
      const h = Math.floor(days.length / 2);
      const avg = (arr) => { const t = arr.reduce((n, d) => n + d.total, 0); return t ? Math.round(arr.reduce((n, d) => n + d.done, 0) / t * 100) : null; };
      const first = avg(days.slice(0, h)), last = avg(days.slice(days.length - h));
      if (first != null && last != null) trend = { first, last, delta: last - first, dir: Math.abs(last - first) < 5 ? 'flat' : (last > first ? 'up' : 'down') };
    }
    const ranked = days.filter(d => d.pct != null).sort((a, b) => b.pct - a.pct || b.total - a.total);
    return {
      key: p.person_key, name: p.name, role: p.role || '', dot: p.dot || '👤', color: p.color || '',
      done, total, pct: pctOf(done, total),
      daysCounted: days.length, daysWorked: worked.length,
      full: days.filter(d => d.total > 0 && d.done === d.total).length,   // วันที่ปิดครบ 100%
      zero: days.filter(d => d.total > 0 && d.done === 0).length,
      bypassed: sum(d => d.bypassed), received: sum(d => d.received), receivedDone: sum(d => d.receivedDone),
      adhoc: sum(d => d.adhoc), adhocDone: sum(d => d.adhocDone),
      routineNodes: trees[p.person_key].length,
      trend, days,
      best: ranked[0] ? { date: ranked[0].date, pct: ranked[0].pct } : null,
      // โชว์ "วันที่แย่สุด" เฉพาะตอนที่แย่กว่าวันที่ดีสุดจริง ๆ (ไม่งั้นคนที่ปิดครบทุกวันจะมีวันแย่สุด 100%)
      worst: ranked.length > 1 && ranked[ranked.length - 1].pct < ranked[0].pct
        ? { date: ranked[ranked.length - 1].date, pct: ranked[ranked.length - 1].pct } : null,
    };
  }).sort((a, b) => (b.pct || 0) - (a.pct || 0) || b.done - a.done);

  // ── (2) รายกะ ────────────────────────────────────────────────────────────
  const shiftMap = {};
  const bucket = (key, workDay) => {
    const s = shiftMap[key] || (shiftMap[key] = { shift: key, batches: 0, cipRounds: 0, ticks: 0, days: {}, lines: {}, flavors: {} });
    if (workDay) s.days[workDay] = true;
    return s;
  };
  const operators = {}, crewMap = {}, noCrew = { batches: 0, people: {} };
  for (const r of prodRows) {
    const ts = String(r.timestamp || '');
    const day = ts.slice(0, 10), hour = Number(ts.slice(11, 13));
    if (!day) continue;
    const sh = shiftAt(day, hour);
    const s = bucket(sh.key, sh.workDay);
    s.batches += 1;
    s.lines[r.line_name || '-'] = (s.lines[r.line_name || '-'] || 0) + 1;
    s.flavors[r.flavor || '-'] = (s.flavors[r.flavor || '-'] || 0) + 1;
    const op = r.operator_name || '(ไม่ระบุ)';
    const o = operators[op] || (operators[op] = { name: op, batches: 0, days: {}, shifts: {}, cipRounds: 0, crew: crewOf[op] || '' });
    o.batches += 1; o.days[sh.workDay] = true; o.shifts[sh.key] = (o.shifts[sh.key] || 0) + 1;
    // ผลงาน "ของทีมกะ" จริง ๆ = ดูจากทีมของคนที่ลงยอด ไม่ใช่เวลาที่ลง
    const crew = crewOf[op];
    if (crew) {
      const c = crewMap[crew] || (crewMap[crew] = { crew, batches: 0, days: {}, people: {}, cipRounds: 0 });
      c.batches += 1; c.days[sh.workDay] = true; c.people[op] = (c.people[op] || 0) + 1;
    } else { noCrew.batches += 1; noCrew.people[op] = (noCrew.people[op] || 0) + 1; }
  }
  for (const r of cip.rounds) {
    const crew = crewOf[r.operator];
    if (crew && crewMap[crew]) crewMap[crew].cipRounds += 1;
  }
  for (const s of states) {
    if (!s.checked || !s.updated_at) continue;
    const day = String(s.updated_at).slice(0, 10), hour = Number(String(s.updated_at).slice(11, 13));
    if (!day || !Number.isFinite(hour)) continue;
    bucket(shiftAt(day, hour).key, null).ticks += 1;
  }
  for (const r of cip.rounds) if (r.shift) bucket(r.shift, r.workDay).cipRounds += 1;

  const shiftOrder = { 'เช้า': 0, 'บ่าย': 1, 'ดึก': 2 };
  const shifts = Object.values(shiftMap).map((s) => {
    const days = Object.keys(s.days).length;
    const topLine = Object.entries(s.lines).sort((a, b) => b[1] - a[1])[0];
    const topFlavor = Object.entries(s.flavors).sort((a, b) => b[1] - a[1])[0];
    return {
      shift: s.shift, batches: s.batches, cipRounds: s.cipRounds, ticks: s.ticks, days,
      perDay: days ? round2(s.batches / days) : null,
      topLine: topLine ? { line: topLine[0], n: topLine[1] } : null,
      topFlavor: topFlavor ? { flavor: topFlavor[0], n: topFlavor[1] } : null,
    };
  }).sort((a, b) => (shiftOrder[a.shift] ?? 9) - (shiftOrder[b.shift] ?? 9));

  // ── (2ข) ผลงานรายทีมกะจริง — ใช้ operators.shift (ต้องผูกบัญชีกับทีมกะไว้ก่อน) ──
  const crews = Object.values(crewMap).map((c) => {
    const days = Object.keys(c.days).length;
    return {
      crew: c.crew, batches: c.batches, cipRounds: c.cipRounds, days,
      perDay: days ? round2(c.batches / days) : null,
      people: Object.entries(c.people).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    };
  }).sort((a, b) => a.crew.localeCompare(b.crew));
  const crewUnlinked = {
    batches: noCrew.batches,
    people: Object.entries(noCrew.people).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
  };

  // ── (3) เวลาต่อรอบ CIP เทียบค่ากลาง ──────────────────────────────────────
  const mins = cip.rounds.map(r => r.minutes);
  const overallMedian = medianOf(mins);
  const groupRounds = (keyFn) => {
    const g = {};
    for (const r of cip.rounds) { const k = keyFn(r); (g[k] = g[k] || []).push(r); }
    return Object.entries(g).map(([name, rs]) => {
      const m = rs.map(r => r.minutes);
      const med = medianOf(m);
      return {
        name, n: rs.length, median: med,
        avg: round2(m.reduce((a, b) => a + b, 0) / m.length),
        min: Math.min(...m), max: Math.max(...m),
        vsMedian: overallMedian && med != null ? Math.round((med - overallMedian) / overallMedian * 100) : null,
      };
    }).sort((a, b) => b.n - a.n);
  };

  const opList = Object.values(operators).map(o => ({
    name: o.name, batches: o.batches, days: Object.keys(o.days).length,
    perDay: Object.keys(o.days).length ? round2(o.batches / Object.keys(o.days).length) : null,
    shifts: o.shifts, crew: o.crew || '',
  })).sort((a, b) => b.batches - a.batches);
  for (const o of opList) o.cipRounds = cip.rounds.filter(r => r.operator === o.name).length;

  return {
    from, to,
    countedDays: countedDays.length, firstDay: countedDays[0] || '', lastDay: countedDays[countedDays.length - 1] || '',
    people: persons,
    team: {
      done: persons.reduce((n, p) => n + p.done, 0),
      total: persons.reduce((n, p) => n + p.total, 0),
      pct: pctOf(persons.reduce((n, p) => n + p.done, 0), persons.reduce((n, p) => n + p.total, 0)),
    },
    shifts, crews, crewUnlinked,
    operators: opList,
    cip: {
      rounds: cip.rounds.slice(0, 200), count: cip.rounds.length, sessions: cip.sessions,
      openCount: cip.open.length, open: cip.open.slice(0, 20),
      median: overallMedian,
      avg: mins.length ? round2(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
      byOperator: groupRounds(r => r.operator),
      byLine: groupRounds(r => r.line),
      // ตัวอย่างน้อยเกินไป = อย่าเพิ่งสรุปว่าใครช้าใครเร็ว
      thin: cip.rounds.length < 10,
    },
  };
}

app.get('/api/perf/summary', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  try { res.json(await buildPerfSummary({ from, to })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4-g แดชบอร์ดรวมหน้าเดียว — ดึงจาก builder ของแต่ละโมดูลที่มีอยู่แล้ว
// ไม่คำนวณเลขใหม่เอง (ไม่งั้นตัวเลขหน้ารวมกับหน้าย่อยจะเริ่มไม่ตรงกัน)
// 🔑 กติกาของหน้านี้: **ช่องไหนยังไม่มีข้อมูลจริง ต้องบอกว่า "ยังไม่มี" ไม่ใช่โชว์ 0 เฉย ๆ**
//    ทุกก้อนมี status: ok | thin (มีแต่น้อยเกินจะเชื่อ) | empty | error
//    + dataSince = วันแรกที่ระบบมีข้อมูลนั้นจริง (โมดูลที่เพิ่งเริ่มเก็บจะได้ไม่ถูกอ่านผิด)
// ก้อนไหนพังก็ยังโชว์ก้อนที่เหลือได้ (Promise.allSettled) — หน้ารวมต้องไม่ล่มทั้งหน้า
// ═══════════════════════════════════════════════════════════════════════════
async function buildDashboard({ from, to } = {}) {
  const val = (r, d = null) => (r.status === 'fulfilled' ? r.value : d);
  const err = (r) => (r.status === 'rejected' ? String(r.reason && r.reason.message || r.reason) : null);

  const [rPerf, rQual, rDown, rCost, rMat, rStock, rProd, rPlan, rSince] = await Promise.allSettled([
    buildPerfSummary({ from, to }),
    buildQualityHistory({ from, to }),
    buildDowntimeRange(from, to),
    buildCostRange(from, to),
    buildMaterialUsage(from, to),
    dbAll('SELECT * FROM materials WHERE active = 1 ORDER BY name', []),
    fetchProductionByWorkday(from, to),
    dbAll('SELECT plan_date, SUM(planned_batches) planned FROM production_plans WHERE plan_date BETWEEN ? AND ? GROUP BY plan_date', [from, to]),
    Promise.all([
      dbAll('SELECT MIN(moved_at) AS a FROM material_moves', []),
      dbAll('SELECT MIN(occurred_at) AS a FROM incidents', []),
      dbAll('SELECT MIN(timestamp) AS a FROM production_logs', []),
    ]),
  ]);

  const perf = val(rPerf), qual = val(rQual), down = val(rDown), cost = val(rCost);
  const matUse = val(rMat), stockRows = val(rStock, []) || [], prodRows = val(rProd, []) || [], planRows = val(rPlan, []) || [];
  const since = val(rSince, [[], [], []]) || [[], [], []];
  const day10 = (v) => String((v && v[0] && v[0].a) || '').slice(0, 10) || null;
  const dataSince = { materials: day10(since[0]), incidents: day10(since[1]), production: day10(since[2]) };

  // ── ผลิต ────────────────────────────────────────────────────────────────
  const byDayMap = {};
  const dayB = (k) => byDayMap[k] || (byDayMap[k] = { workDay: k, actual: 0, planned: 0 });
  for (const r of prodRows) dayB(r.work_day).actual += Number(r.actual);
  for (const r of planRows) dayB(r.plan_date).planned += Number(r.planned || 0);
  const lineMap = {}, flavorMap = {};
  for (const r of prodRows) {
    lineMap[r.line_name] = (lineMap[r.line_name] || 0) + Number(r.actual);
    flavorMap[r.flavor] = (flavorMap[r.flavor] || 0) + Number(r.actual);
  }
  const top = (m) => { const e = Object.entries(m).sort((a, b) => b[1] - a[1])[0]; return e ? { name: e[0], n: e[1] } : null; };
  const actual = prodRows.reduce((n, r) => n + Number(r.actual), 0);
  const planned = planRows.reduce((n, r) => n + Number(r.planned || 0), 0);
  const production = {
    status: rProd.status === 'rejected' ? 'error' : (actual ? 'ok' : 'empty'), error: err(rProd),
    actual, planned, pct: planned > 0 ? Math.round((actual / planned) * 100) : null,
    byDay: Object.values(byDayMap).sort((a, b) => a.workDay.localeCompare(b.workDay)),
    topLine: top(lineMap), topFlavor: top(flavorMap), dataSince: dataSince.production,
  };

  // ── คุณภาพ (4-e) ────────────────────────────────────────────────────────
  const noSpecReadings = qual ? qual.noSpec.reduce((n, s) => n + s.n, 0) : 0;
  const quality = qual ? {
    // ตรวจได้น้อยกว่าที่ยังไม่ได้ตรวจ = ตัวเลขยังเชื่อไม่ได้เต็มปาก
    status: qual.checked === 0 ? 'empty' : (noSpecReadings > qual.checked ? 'thin' : 'ok'),
    readings: qual.readings, checked: qual.checked, out: qual.out, rate: qual.rate,
    worstFlavor: qual.worstFlavor, noSpecFlavors: qual.noSpec.length, noSpecReadings,
    drifting: qual.drifting.slice(0, 3),
  } : { status: 'error', error: err(rQual) };

  // ── งานประจำ + กะ + เวลาต่อรอบ CIP (4-f) ────────────────────────────────
  const duty = perf ? {
    status: perf.countedDays === 0 ? 'empty' : 'ok',
    pct: perf.team.pct, done: perf.team.done, total: perf.team.total,
    countedDays: perf.countedDays,
    people: perf.people.filter(p => p.pct != null).map(p => ({ name: p.name, pct: p.pct, dot: p.dot, trend: p.trend ? p.trend.dir : null })),
  } : { status: 'error', error: err(rPerf) };
  const shifts = perf ? perf.shifts : [];
  const cipTime = perf ? {
    status: perf.cip.count === 0 ? 'empty' : (perf.cip.thin ? 'thin' : 'ok'),
    count: perf.cip.count, median: perf.cip.median, openCount: perf.cip.openCount,
    slowest: perf.cip.byLine.slice().sort((a, b) => (b.median || 0) - (a.median || 0))[0] || null,
  } : { status: 'error', error: err(rPerf) };

  // ── เวลาเครื่องหยุด (เฟส 3) ─────────────────────────────────────────────
  const downtime = down ? {
    status: down.totalCount === 0 ? 'empty' : 'ok',
    totalMin: down.totalMin, totalCount: down.totalCount, missing: down.missing,
    openNow: down.openNow.length, openList: down.openNow.slice(0, 3),
    worstMachine: down.machines[0] ? { name: down.machines[0].name, minutes: down.machines[0].minutes, count: down.machines[0].count } : null,
    dataSince: dataSince.incidents,
  } : { status: 'error', error: err(rDown) };

  // ── ต้นทุนต่อ batch (เฟส 3) ─────────────────────────────────────────────
  const rateBase = cost ? Number(cost.rates.base || 0) : 0;
  const costCard = cost ? {
    // ยังไม่ตั้งค่าเสียโอกาส/ชม. = ค่าเวลาที่เสียคิดออกมาเป็น 0 เสมอ ตัวเลขจึงยังไม่ครบ
    status: cost.batches.length === 0 ? 'empty' : (rateBase <= 0 || cost.unassignedMaterialCost > 0 ? 'thin' : 'ok'),
    totalCost: cost.totalCost, totalMaterial: cost.totalMaterial, totalDowntime: cost.totalDowntime,
    batches: cost.batches.length, unassigned: cost.unassignedMaterialCost, rateBase,
    top: cost.batches.slice(0, 3).map(b => ({ batchRef: b.batchRef, total: b.total })),
    dataSince: dataSince.materials,
  } : { status: 'error', error: err(rCost) };

  // ── คลังวัสดุ (เฟส 2) ───────────────────────────────────────────────────
  const stock = stockRows.map(matRow);
  const lowItems = stock.filter(m => m.low);
  const materials = {
    status: rStock.status === 'rejected' ? 'error' : (stock.length === 0 ? 'empty' : (lowItems.length ? 'thin' : 'ok')),
    error: err(rStock),
    items: stock.length, lowCount: lowItems.length,
    low: lowItems.slice(0, 5).map(m => ({ name: m.name, stock: m.stock, unit: m.unit, reorderPoint: m.reorderPoint })),
    stockValue: round2(stock.reduce((n, m) => n + m.value, 0)),
    usedCost: matUse ? matUse.totalCost : null, moves: matUse ? matUse.totalMoves : 0,
    dataSince: dataSince.materials,
  };

  // ── สิ่งที่ต้องสนใจตอนนี้ (รวมข้ามโมดูล) ─────────────────────────────────
  // เรียงจากเรื่องที่ "ทำให้ตัวเลขผิด/ของขาด" ก่อน แล้วค่อยเรื่องคุณภาพ/ประสิทธิภาพ
  const alerts = [];
  const push = (level, icon, text, pane) => alerts.push({ level, icon, text, pane });
  if (downtime.status !== 'error' && downtime.openNow > 0)
    push('crit', '🔴', `มีเครื่องที่ยังไม่ได้กรอกเวลากลับมาเดิน ${downtime.openNow} รายการ — ชั่วโมงเสียยังนับไม่ครบ`, 'downtime');
  if (materials.lowCount > 0)
    push('crit', '🧪', `วัสดุถึงจุดสั่งซื้อแล้ว ${materials.lowCount} รายการ: ${materials.low.map(m => m.name).join(' · ')}`, 'materials');
  if (cipTime.status !== 'error' && cipTime.openCount > 0)
    push('warn', '🧼', `รอบ CIP ที่กดเริ่มแล้วไม่ได้กดจบ ${cipTime.openCount} รอบ — คิดเวลาต่อรอบไม่ได้`, 'perf');
  if (costCard.status !== 'error' && rateBase <= 0)
    push('warn', '💰', 'ยังไม่ได้ตั้งค่าเสียโอกาสต่อชั่วโมง — ต้นทุนส่วน "เวลาที่เสีย" ยังคิดออกมาเป็น 0', 'cost');
  if (costCard.status !== 'error' && costCard.unassigned > 0)
    push('warn', '📦', `มีของที่เบิกโดยไม่ระบุ batch มูลค่า ${costCard.unassigned} บาท — ต้นทุนต่อ batch ยังไม่ครบ`, 'cost');
  if (quality.status !== 'error' && quality.out > 0)
    push('warn', '🔬', `ค่าหลุดสเปก ${quality.out} ครั้ง${quality.worstFlavor ? ` — บ่อยสุดคือ ${quality.worstFlavor.flavor}` : ''}`, 'quality');
  if (quality.status !== 'error' && quality.noSpecFlavors > 0)
    push('info', '📐', `อีก ${quality.noSpecReadings} ค่ายังไม่ถูกตรวจ (${quality.noSpecFlavors} รสยังไม่ได้ตั้งสเปก)`, 'quality');
  if (duty.status === 'ok' && duty.pct != null && duty.pct < 70)
    push('warn', '👥', `งานประจำทั้งทีมอยู่ที่ ${duty.pct}% ในช่วงนี้`, 'perf');
  if (downtime.status !== 'error' && downtime.missing > 0)
    push('info', '⏱', `เหตุการณ์ ${downtime.missing} เรื่องยังไม่ได้กรอกเวลาเครื่องหยุด`, 'downtime');
  const rank = { crit: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => rank[a.level] - rank[b.level]);

  return {
    from, to, dataSince,
    production, quality, duty, shifts, cip: cipTime, downtime, cost: costCard, materials, alerts,
  };
}

app.get('/api/dashboard/summary', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  try { res.json(await buildDashboard({ from, to })); }
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
// ⚠️ กระดานนี้อยู่บน "บอทผลิต" ที่ n8n เป็นเจ้าของ webhook — ทุกปุ่มที่ใส่ตรงนี้
//    ต้องมี prefix ที่ Duty Gate ใน n8n ปล่อยผ่าน (ตอนนี้: p: · t: · sum) ไม่งั้นกดแล้วเงียบ
//    งานซ่อมบำรุงย้ายไปบอท @spp_maint_bot หมดแล้ว — อย่าเอาปุ่ม inc:/m:/mpm: กลับมาใส่ที่นี่
function buildDutyHome(duty, auditOpen = 0) {
  // ปุ่มใบตรวจโชว์ทุกวัน (รวมเสาร์) — ประเด็นค้างไม่หยุดตามวันหยุด
  const auditRow = [{ text: `🧾 พื้นที่รับผิดชอบ${auditOpen > 0 ? ` (ค้าง ${auditOpen})` : ' ✅'}`, callback_data: 'p:audithome' }];
  if (duty.holiday) return { text: `📋 <b>งานตามหน้าที่</b> · ${duty.date}\n🚫 วันเสาร์ — วันหยุด`, keyboard: [auditRow] };
  const rows = duty.people.map(p => {
    const done = p.total > 0 && p.done >= p.total;
    return [{ text: clip(`👤 ${p.name}　${p.done}/${p.total}${done ? ' ✅' : ''}`), callback_data: `p:${p.key}` }];
  });
  rows.push([{ text: '✈ ส่งสรุปเข้ากลุ่ม', callback_data: 'sum' }]);
  rows.push(auditRow);
  const text =
    `📋 <b>งานตามหน้าที่วันนี้</b> · ${duty.date}\n` +
    `${progressBar(duty.team.pct)} <b>${duty.team.pct}%</b> · คงค้าง ${duty.team.left} งาน\n\n` +
    `แตะเลือกดูงานของแต่ละคน 👇\n` +
    `<i>🆘 เครื่องเสีย/แจ้งซ่อม → พิมพ์ในกลุ่ม “SPP ช่างซ่อมบำรุง”</i>`;
  return { text, keyboard: rows };
}

// ── หน้ารายบุคคล — งานของคนนั้น (☐/✅ แตะสลับ) + งานข้าม/มอบต่อเป็นข้อความ ──
function buildDutyPerson(duty, pkey) {
  const p = duty.people.find(x => x.key === pkey);
  if (!p) return buildDutyHome(duty);
  const rows = [];
  const push = (label, data) => rows.push([{ text: clip(label), callback_data: data }]);
  // งานประจำ: แถวละ 2 ปุ่ม — ติ๊กเสร็จ + 📸 แนบรูปหลังทำ (แนบแล้วส่งการ์ดก่อน/หลังทันที)
  // 'ri' ย่อจาก routine-image ให้สั้น เพราะ callback_data จำกัด 64 ไบต์และ node key เป็น path ได้
  for (const n of p.nodes) {
    if (n.bypassed) continue; // งานข้ามโชว์ในข้อความด้านล่างแทน
    const pre = n.depth ? '↳ '.repeat(n.depth) : '';
    const row = [{ text: clip(`${n.checked ? '✅' : '☐'} ${pre}${n.title}`), callback_data: `t:${pkey}:r:${pkey}:${n.key}` }];
    // 🖼 = ดูรูปอ้างอิงว่าต้องทำตรงไหน (โชว์เฉพาะหัวข้อที่ตั้งรูปอ้างอิงไว้แล้ว)
    if (n.hasRefImage || n.refImage) row.push({ text: '🖼', callback_data: `t:${pkey}:rv:${pkey}:${n.key}` });
    row.push({ text: n.hasDoneImage || n.doneImage ? '🔄' : '📸', callback_data: `t:${pkey}:ri:${pkey}:${n.key}` });
    rows.push(row);
  }
  for (const r of p.received) push(`${r.checked ? '✅' : '☐'} ${r.title} ⟵${r.fromName}`, `t:${pkey}:r:${r.ownerKey}:${r.nodeKey}`);
  // งานมอบหมาย: แถวละ 2 ปุ่ม — ปิด/เปิดงาน + 📸 แนบรูปหลังทำ
  const isAudit = p.kind === 'audit';
  for (const t of p.adhoc) {
    const row = [{ text: clip(`${t.status === 'done' ? '✅' : '☐'} ${t.priority === 'urgent' ? '🔴 ' : ''}${t.title}${isAudit && t.location ? ` · ${t.location}` : ''}`), callback_data: `t:${pkey}:a:${t.id}` }];
    // 🖼 = ดูรูปที่แนบตอนมอบงาน (จุดที่ต้องไปทำ) — โชว์เฉพาะงานที่มีรูปแนบ
    if (t.hasImages) row.push({ text: '🖼', callback_data: `t:${pkey}:v:${t.id}` });
    row.push({ text: '📸', callback_data: `t:${pkey}:img:${t.id}` });
    rows.push(row);
  }
  rows.push([{ text: '⬅️ กลับ', callback_data: isAudit ? 'p:audithome' : 'p:home' }, { text: '🔄 รีเฟรช', callback_data: `p:${pkey}` }]);

  let text = `👤 <b>คุณ ${p.name}</b> · ${p.role}\n${progressBar(p.pct)} <b>${p.pct}%</b> · เสร็จ ${p.done}/${p.total}`;
  const byp = p.nodes.filter(n => n.bypassed);
  for (const n of byp) text += n.handoffTo ? `\n🔁 มอบ ${n.handoffToName}: ${n.title}` : `\n⤼ ข้าม: ${n.title} (${n.bypassReason || ''})`;
  if (rows.length === 1) text += isAudit ? `\n\n— ไม่มีประเด็นค้าง 🎉 —` : `\n\n— ไม่มีงานประจำ/มอบหมายวันนี้ —`;
  return { text, keyboard: rows };
}

// ── หน้าแรกของบอร์ดใบตรวจในบอท — รายชื่อผู้รับผิดชอบที่มีประเด็นค้าง ────────
function buildAuditHome(duty) {
  const withWork = duty.people.filter(p => p.total > 0);
  const rows = withWork.map(p => {
    const left = p.total - p.done;
    return [{ text: clip(`${p.dot || '👤'} ${p.name}　${left > 0 ? `ค้าง ${left}` : 'ครบ ✅'}`), callback_data: `p:${p.key}` }];
  });
  rows.push([{ text: '⬅️ กลับ', callback_data: 'p:home' }, { text: '🔄 รีเฟรช', callback_data: 'p:audithome' }]);
  const left = duty.team.total - duty.team.done;
  const text = withWork.length
    ? `🧾 <b>พื้นที่รับผิดชอบ — ประเด็นค้าง</b>\n${progressBar(duty.team.pct)} <b>${duty.team.pct}%</b> · ค้าง ${left} ประเด็น\n\nแตะเลือกคนเพื่อปิดงาน + ส่งรูปหลังทำ 👇`
    : `🧾 <b>พื้นที่รับผิดชอบ</b>\n\n— ไม่มีประเด็นค้าง 🎉 —`;
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
    const date = req.query.date || workDayBKK(), person = req.query.person;
    // บอร์ดใบตรวจ (คน kind='audit') แยกจากบอร์ดกะ — ค้างสะสมข้ามวัน
    if (person === 'audithome') return res.json(buildAuditHome(await buildDuty(date, { audit: true })));
    if (person && isAuditKey(person)) return res.json(buildDutyPerson(await buildDuty(date, { audit: true }), person));
    const duty = await buildDuty(date);
    res.json(person ? buildDutyPerson(duty, person) : buildDutyHome(duty, await countAuditOpen()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── สถานะ "รอรับรูปหลังทำ" ผ่าน Telegram (ต่อผู้ใช้) + ดาวน์โหลดรูปจาก Telegram ──
// ── รายการรูปที่ต้องถ่ายของงานมอบหมาย ────────────────────────────────────────
// บอทถามทีละใบตามรายการนี้ · ครบเมื่อไหร่ = ปิดงาน (ไม่ใช้การหน่วงเวลาเดาเอาแล้ว)
const DEFAULT_PHOTO_SPECS = ['หลังทำ'];
function parseImgs(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.filter(Boolean) : []; } catch { return []; }
}
// แบบคงลำดับ (ไม่ตัดช่องว่างออก) — ใช้กับรูปก่อนทำที่ index ต้องตรงกับ photo_specs
function parseImgsAligned(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.map(x => x || null) : []; } catch { return []; }
}
// ข้อความขอรูปใบถัดไป — ความคืบหน้าคำนวณจากจำนวนรูปที่ถ่ายไปแล้ว ไม่ต้องเก็บ state เพิ่ม
// (เข้ามาใหม่กลางคันก็ทำต่อจากเดิมได้เอง)
function askNextPhoto(trow, taskId, page) {
  const specs = parsePhotoSpecs(trow?.photo_specs);
  const have = parseImgs(trow?.done_images).length;
  const idx = Math.min(have, specs.length - 1);
  return {
    text: `📸 <b>รูปที่ ${have + 1}/${specs.length} — ${escapeHtml(specs[idx])}</b>\n`
      + `งาน "${escapeHtml(trow?.title || '')}"\n\n`
      + `<i>ถ่ายใหม่หรือเลือกจากคลังก็ได้ · ส่งทีละรูป</i>`,
    reply_markup: { inline_keyboard: [[{ text: '✖️ ยกเลิก', callback_data: `t:${page}:x:${taskId}` }]] },
  };
}
// ส่งรูป "ก่อนทำ" ของจุดที่กำลังจะถ่าย ให้ดูเทียบก่อน (images[i] คู่กับ photo_specs[i])
async function sendSpotReference(chatId, trow) {
  const specs = parsePhotoSpecs(trow?.photo_specs);
  const have = parseImgs(trow?.done_images).length;
  const idx = Math.min(have, specs.length - 1);
  const ref = parseImgsAligned(trow?.images)[idx];
  if (!ref) return;
  await sendPhotoToChat(chatId, ref, `🖼 <b>${escapeHtml(specs[idx])}</b> — จุดที่ต้องไปทำ`
    + `${trow?.location ? `\n📍 ${escapeHtml(trow.location)}` : ''}`);
}
function parsePhotoSpecs(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    if (Array.isArray(a) && a.length) return a.map(String);
  } catch { /* ค่าเสีย → ใช้ default */ }
  return DEFAULT_PHOTO_SPECS;          // งานเก่าที่ไม่มี photo_specs ต้องยังทำงานได้
}
// ปิดงาน + ส่งการ์ด — เรียกตอนถ่ายครบรายการแล้วเท่านั้น
async function finishAdhocWithPhotos(chatId, userId, taskId, operator) {
  await db.exec('UPDATE daily_tasks SET status = ?, completed_at = ? WHERE id = ?', ['done', nowBKK(), taskId]);
  // ล้าง wait เฉพาะตอนที่ยังชี้งานนี้อยู่ — คนหนึ่งมี wait ได้แถวเดียว ถ้าเขาสลับไปกด 📸 งานอื่นแล้ว
  // การล้างมั่วจะไปฆ่า wait ของงานใหม่ทิ้ง แล้วรูปงานใหม่จะถูกปฏิเสธ
  if (chatId != null && userId != null) {
    const w = await getPhotoWait(chatId, userId);
    if (w && String(w.task_id) === String(taskId)) await clearPhotoWait(chatId, userId);
  }
  await sendAdhocDoneCard(taskId, operator);
}

// nodeOwner/nodeKey มีค่า = รอรับรูปของ "งานประจำ" · ไม่มี = งานมอบหมาย (อ้างด้วย taskId เหมือนเดิม)
async function setPhotoWait(chatId, userId, taskId, page, nodeOwner = null, nodeKey = null) {
  await db.exec(
    `INSERT INTO tg_photo_wait (chat_id, user_id, task_id, page, node_owner, node_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET task_id = excluded.task_id, page = excluded.page,
       node_owner = excluded.node_owner, node_key = excluded.node_key, created_at = excluded.created_at`,
    [String(chatId), String(userId), taskId, page, nodeOwner, nodeKey, nowBKK()]);
}
async function getPhotoWait(chatId, userId) {
  const cutoff = new Date(Date.now() - 30 * 60000).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  await db.exec('DELETE FROM tg_photo_wait WHERE created_at < ?', [cutoff]); // ล้างที่ค้างเกิน 30 นาที
  const rows = await dbAll('SELECT task_id, page, node_owner, node_key FROM tg_photo_wait WHERE chat_id = ? AND user_id = ?', [String(chatId), String(userId)]);
  return rows[0] || null;
}
async function clearPhotoWait(chatId, userId) {
  await db.exec('DELETE FROM tg_photo_wait WHERE chat_id = ? AND user_id = ?', [String(chatId), String(userId)]);
}
// อัปไบต์รูปขึ้น Supabase Storage (bucket duty-images) → คืน public URL
// ไม่มี SUPABASE_URL/KEY หรือพลาด → คืน null (ให้ caller fallback เป็น base64 เหมือนเดิม)
// ใช้ anon key ได้ (bucket duty-images เปิด RLS insert ให้ anon อยู่แล้ว) — เก็บ URL แทน base64 กัน DB โต
async function uploadBufferToStorage(buffer, mime) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!base || !key) return null;
  try {
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
    const path = `tg/${day}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    await axios.post(`${base.replace(/\/$/, '')}/storage/v1/object/duty-images/${path}`, buffer, {
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': mime, 'x-upsert': 'false' },
      maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 20000,
    });
    return `${base.replace(/\/$/, '')}/storage/v1/object/public/duty-images/${path}`;
  } catch (e) { console.error('[storage upload]', e.response?.data || e.message); return null; }
}

// getFile → ดาวน์โหลดไบต์ → อัป Storage คืน URL (fallback base64 ถ้าไม่มี Supabase) หรือ null
async function downloadTelegramFile(fileId) {
  const token = tgToken();
  if (!token) return null;
  try {
    const info = await tgApi('getFile', { file_id: fileId });
    const filePath = info?.result?.file_path;
    if (!filePath) return null;
    const resp = await axios.get(`https://api.telegram.org/file/bot${token}/${filePath}`, { responseType: 'arraybuffer' });
    const mime = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const buf = Buffer.from(resp.data);
    const url = await uploadBufferToStorage(buf, mime); // เก็บ URL แทน base64 ถ้าอัปได้
    return url || `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) { console.error('[downloadTelegramFile] error', e.response?.data || e.message); return null; }
}

// รับ raw Telegram update (ข้อความสั่ง "งานค้าง" หรือปุ่ม callback) — n8n forward มาที่นี่
// server จัดการ Telegram API เอง (send/edit/answerCallback) ไม่ต้องต่อ node เพิ่มใน n8n

/* ══════════ แจ้งเหตุการณ์ผ่าน Telegram (เดิมต้องเปิดหน้า Admin เท่านั้น) ══════════
   ถาม 3 อย่างทีละข้อ: หัวข้อ → เครื่องจักร (ปุ่ม) → อาการ  แล้วค่อยถามรูป
   ร่างเก็บใน tg_incident_draft (คนละแถวต่อคน) — Render รีสตาร์ตกลางทางแล้วยังคุยต่อได้
   จบแล้วเขียนลง incidents + โน้ตในวอลต์ ผ่านทางเดียวกับหน้าเว็บ (createIncident)      */
const INC_TTL_MIN = 30;
async function getIncDraft(chatId, userId) {
  const cutoff = new Date(Date.now() - INC_TTL_MIN * 60000).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  try { await db.exec('DELETE FROM tg_incident_draft WHERE created_at < ?', [cutoff]); } catch { /* ช่างมัน */ }
  const rows = await dbAll('SELECT * FROM tg_incident_draft WHERE chat_id = ? AND user_id = ?', [String(chatId), String(userId)]);
  return rows[0] || null;
}
async function setIncDraft(chatId, userId, patch) {
  const cur = await getIncDraft(chatId, userId) || {};
  const row = {
    step: patch.step ?? cur.step ?? 'title',
    title: patch.title ?? cur.title ?? '',
    machine: patch.machine ?? cur.machine ?? '',
    symptom: patch.symptom ?? cur.symptom ?? '',
    images: patch.images ?? cur.images ?? '[]',
    operator: patch.operator ?? cur.operator ?? '',
    priority: patch.priority ?? cur.priority ?? '',
  };
  await db.exec(
    `INSERT INTO tg_incident_draft (chat_id, user_id, step, title, machine, symptom, images, operator, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET step = excluded.step, title = excluded.title,
       machine = excluded.machine, symptom = excluded.symptom, images = excluded.images,
       operator = excluded.operator, priority = excluded.priority`,
    [String(chatId), String(userId), row.step, row.title, row.machine, row.symptom, row.images, row.operator,
     row.priority, nowBKK()]);
  return row;
}
const clearIncDraft = (chatId, userId) =>
  db.exec('DELETE FROM tg_incident_draft WHERE chat_id = ? AND user_id = ?', [String(chatId), String(userId)]);

// ปุ่มเลือกเครื่องจักรจากทะเบียน (เรียงตามที่ใช้บ่อย = มีเหตุการณ์เยอะ) + ช่องพิมพ์เอง
async function incMachineKeyboard() {
  const [machines, hits] = await Promise.all([
    dbAll('SELECT name FROM machines WHERE active = 1 ORDER BY name', []),
    dbAll('SELECT machine, COUNT(*) n FROM incidents WHERE machine IS NOT NULL GROUP BY machine', []),
  ]);
  const score = {}; for (const h of hits) score[h.machine] = Number(h.n || 0);
  const names = machines.map(m => m.name).sort((a, b) => (score[b] || 0) - (score[a] || 0)).slice(0, 10);
  const rows = [];
  for (let i = 0; i < names.length; i += 2) {
    rows.push(names.slice(i, i + 2).map((n, j) => ({ text: clip(`🔩 ${n}`), callback_data: `inc:m:${i + j}` })));
  }
  rows.push([{ text: '⌨️ พิมพ์ชื่อเครื่องเอง', callback_data: 'inc:mtype' },
             { text: '➖ ไม่ระบุเครื่อง', callback_data: 'inc:mskip' }]);
  rows.push([{ text: '✕ ยกเลิก', callback_data: 'inc:cancel' }]);
  return { names, keyboard: rows };
}

// บันทึกเหตุการณ์ 1 เรื่อง (ใช้ร่วมกับหน้าเว็บ: เขียน DB → โน้ตวอลต์ → อัปเดตโน้ตเครื่องจักร)
async function createIncidentRow(row) {
  const r = await dbRun(
    `INSERT INTO incidents (title, machine, line_name, batch_id, operator, occurred_at,
       symptom, cause, fix, result, status, images, result_images, down_from, down_to, priority,
       source, ref_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.title, row.machine || null, row.lineName || null, null, row.operator || null, row.occurredAt || todayBKK(),
     row.symptom || null, null, null, null, 'open', photoJson(row.images), photoJson([]),
     row.downFrom || null, null, row.priority || null,
     incSource(row.source, 'bot'), row.refKey || null, nowBKK(), nowBKK()]);
  const id = r.lastID;
  const sync = await syncIncident({ ...row, id, images: photoJson(row.images), result_images: photoJson([]), status: 'open',
    occurred_at: row.occurredAt || todayBKK(), symptom: row.symptom || null });
  if (sync.path) await db.exec('UPDATE incidents SET vault_path = ? WHERE id = ?', [sync.path, id]);
  touchMachineNote(row.machine);
  return { id, vaultPath: sync.path || null, vaultError: sync.error || null };
}

// ถามข้อถัดไปตามสถานะของร่าง
/* ⚠️ ขั้นที่ต้อง "พิมพ์ตอบ" ยังส่งแบบ force_reply อยู่ — เก็บไว้ด้วยเหตุผล 2 ข้อ
   1) บอทเดิม: n8n เป็นเจ้าของ webhook มีโหนด Duty Gate กรองว่าอะไรถูกส่งต่อมาที่แอป
      (callback_query · รูป · ข้อความที่ตอบกลับ) — ข้อความพิมพ์ลอย ๆ ถูกทิ้ง ไม่มีวันมาถึงที่นี่
      gate ปัจจุบัน: `($json.callback_query || $json.message?.photo || $json.message?.reply_to_message)`
   2) บอทซ่อมบำรุง: ไม่มี gate แล้วก็จริง แต่ในกลุ่มต้องแยกให้ออกว่าข้อความไหน "ตอบบอท"
      ไม่งั้นคนคุยงานกันอยู่จะโดนดูดเข้าร่างเหตุการณ์ (ดูกติกาตอนอ่านคำตอบข้างล่าง)      */
// ขั้นถัดจาก "เลือกเครื่อง" — แยกไว้ที่เดียวเพราะมีทางเข้า 3 ทาง (ปุ่มเครื่อง/ไม่ระบุ/พิมพ์เอง)
const stepAfterMachine = () => (onMaintBot() ? 'priority' : 'symptom');

async function incAsk(chatId, draft, who = {}) {
  // ⚠️ ในกลุ่ม: force_reply + selective จะเด้งช่องตอบให้ "เฉพาะคนที่ถูก mention ในข้อความ" เท่านั้น
  //    ถ้าไม่ mention ใครเลย = ไม่เด้งให้ใครสักคน (เสียเปล่า) → ต้องแปะ inline mention ของคนถามไว้เสมอ
  const mention = who.userId
    ? `<a href="tg://user?id=${who.userId}">${escapeHtml(who.name || 'คุณ')}</a> ` : '';
  const send = (text, keyboard, forceReply) => tgApi('sendMessage', {
    chat_id: chatId, text: (forceReply ? mention : '') + text, parse_mode: 'HTML',
    ...(who.replyTo ? { reply_to_message_id: who.replyTo } : {}),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } }
      : forceReply ? { reply_markup: { force_reply: true, selective: true, input_field_placeholder: forceReply } }
      : {}),
  });
  const cancelRow = [[{ text: '✕ ยกเลิก', callback_data: 'inc:cancel' }]];
  const cancelTip = '\n\n<i>พิมพ์ “ยกเลิก” เพื่อเลิกแจ้ง</i>';
  const head = onMaintBot() ? '🆘 <b>แจ้งซ่อม</b>' : '⚡ <b>แจ้งเหตุการณ์</b>';
  if (draft.step === 'title') {
    return send(head + '\n\nเกิดอะไรขึ้นครับ? พิมพ์สั้น ๆ พอ เช่น <i>ปั๊มน้ำดิบรั่ว</i>' + cancelTip,
      null, 'เกิดอะไรขึ้น…');
  }
  /* ความเร่งด่วน — ถามเฉพาะกลุ่มซ่อมบำรุง เพราะมันคือตัวเรียงคิวงานของช่าง
     และ "หยุดไลน์" ยังเป็นตัวสั่งให้ระบบเริ่มจับเวลาเครื่องหยุดตั้งแต่วินาทีที่แจ้ง */
  if (draft.step === 'priority') {
    return send(`⚠️ <b>ด่วนแค่ไหนครับ?</b>\n🔩 ${escapeHtml(draft.machine || 'ไม่ระบุเครื่อง')}`, [
      [{ text: '🔴 หยุดไลน์ — ผลิตต่อไม่ได้', callback_data: 'inc:p:stop' }],
      [{ text: '🟡 ยังเดินได้ แต่มีปัญหา', callback_data: 'inc:p:warn' }],
      [{ text: '🟢 ไว้ทำตอนว่าง', callback_data: 'inc:p:low' }],
      ...cancelRow]);
  }
  if (draft.step === 'machine') {
    const { keyboard } = await incMachineKeyboard();
    return send(`🔩 <b>เครื่องไหน?</b>\nเรื่อง: ${escapeHtml(draft.title)}`, keyboard);
  }
  if (draft.step === 'mtype') return send('⌨️ พิมพ์ชื่อเครื่องมาได้เลย' + cancelTip, null, 'ชื่อเครื่อง…');
  if (draft.step === 'symptom') {
    return send(
      `📝 <b>อาการเป็นยังไง?</b>\nพิมพ์รายละเอียดมาได้เลย (หลายบรรทัดก็ได้)\nไม่มีอะไรเพิ่ม พิมพ์ <b>-</b> ก็ได้` + cancelTip,
      null, 'อาการที่เจอ…');
  }
  if (draft.step === 'photo') {
    const n = parseImgs(draft.images).length;
    return send(
      `📸 <b>ส่งรูปเข้ามาได้เลย</b> (จะส่งกี่รูปก็ได้)${n ? `\nตอนนี้มี ${n} รูปแล้ว` : ''}\nหรือกดบันทึกเลยถ้าไม่มีรูป`,
      [[{ text: '✅ บันทึกเหตุการณ์', callback_data: 'inc:save' }], ...cancelRow]);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   กระดานซ่อมบำรุงในบอท — กลุ่ม "SPP ช่างซ่อมบำรุง" (บอทของแอปเอง ไม่ผ่าน n8n)
   ───────────────────────────────────────────────────────────────────────────
   ในกลุ่มนี้มีคน 2 พวก: ทีมผลิต (มาแจ้งซ่อมอย่างเดียว) กับช่าง (ทำทุกอย่าง)
   กระดานจึงวางปุ่ม "แจ้งซ่อม" ไว้บนสุดแยกเส้น ส่วนปุ่มเปลี่ยนสถานะงานล็อกเฉพาะช่าง

   แยกงาน 3 ประเภทให้ขาดจากกัน (เคยปนกันจนกระดานอ่านไม่รู้เรื่อง):
     🆘 แจ้งซ่อม (CM)  = เสียแล้วต้องแก้ ไม่ได้วางแผน → ตาราง incidents
     🗓 งาน PM        = วางแผนไว้ล่วงหน้าว่าจะทำวันไหน (บำรุงรักษา/ปรับปรุง/แก้ไข)
                        → ตาราง daily_tasks category='pm' (ได้ระบบเตือน/รูปก่อน-หลังฟรี)
     🔁 งานรูทีน       = เช็กลิสต์ตอนตั้งไลน์ ไม่ได้ทำทุกวันทุกเครื่อง → duty_routines + freq

   ⚠️ ตัวเลขค่าเสียโอกาส (บาท) ห้ามโผล่ในกลุ่ม — ทีมผลิตอยู่ด้วย ให้ดูในแอปเท่านั้น
      ในกลุ่มโชว์ได้แค่ "เครื่องหยุดไปกี่นาที"
   ═══════════════════════════════════════════════════════════════════════════ */

// ความเร่งด่วนของใบแจ้งซ่อม — order ใช้เรียงคิว (หยุดไลน์ต้องอยู่บนสุดเสมอ)
const SR_PRIO = {
  stop: { icon: '🔴', label: 'หยุดไลน์', short: 'หยุดไลน์', order: 0 },
  warn: { icon: '🟡', label: 'ยังเดินได้ แต่มีปัญหา', short: 'มีปัญหา', order: 1 },
  low: { icon: '🟢', label: 'ไว้ทำตอนว่าง', short: 'ไม่ด่วน', order: 2 },
};
const srPrio = (p) => SR_PRIO[p] || SR_PRIO.warn;

// สถานะใบแจ้งซ่อม — 'open' รอรับงาน → 'wip' ช่างรับแล้ว → 'closed' ปิดงาน
const SR_STATUS = {
  open: { icon: '🔴', label: 'รอรับงาน' },
  wip: { icon: '🔧', label: 'กำลังซ่อม' },
  closed: { icon: '✅', label: 'ปิดงานแล้ว' },
};
const srStatus = (s) => SR_STATUS[s] || SR_STATUS.open;

// ความถี่ของงานรูทีน — onuse/onissue ไม่ขึ้นกระดานเอง (ต้องเปิดดูของเครื่องนั้นเอง)
const FREQ_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 90 };
const FREQ_LABEL = {
  daily: 'ทุกวัน', weekly: 'ทุกสัปดาห์', monthly: 'ทุกเดือน', quarterly: 'ทุก 3 เดือน',
  onuse: 'เมื่อใช้งานเครื่องนี้', onissue: 'เมื่อมีปัญหา',
};
const PM_KIND = { pm: '🔧 บำรุงรักษา', up: '⬆️ ปรับปรุง', fix: '🛠 แก้ไข' };

const dayGap = (from, to) => {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : 9999;
};
// งานรูทีนนี้ "ถึงคิว" ในวันนั้นหรือยัง — lastDone = วันที่ติ๊กล่าสุด (null = ไม่เคยทำ)
function routineDue(freq, lastDone, date) {
  const f = freq || 'daily';                       // งานเก่าที่ยังไม่ได้ตั้งความถี่ = ทุกวัน (พฤติกรรมเดิม)
  if (f === 'onuse' || f === 'onissue') return false;
  if (!lastDone) return true;
  return dayGap(lastDone, date) >= (FREQ_DAYS[f] || 1);
}

// นาทีที่เครื่องหยุดจนถึงตอนนี้ (ใบที่ยังไม่ปิด) — ใช้ทั้งการ์ดและกระดาน
const downSoFar = (row) => downMinutes(row.down_from, nowBKK().slice(0, 16));

/* ── ใครเป็นช่าง ────────────────────────────────────────────────────────────
   ปุ่มรับงาน/ปิดงานต้องล็อกเฉพาะช่าง เพราะกลุ่มนี้มีทีมผลิตอยู่ด้วย
   ผูก Telegram user id ไว้ที่ duty_people.tg_user_id (ผูกเองผ่านปุ่มในกระดาน)
   อ่านจาก DB ตรง ๆ ไม่ผ่าน cache รายชื่อ — ผูกปุ๊บต้องใช้ได้ปั๊บ ไม่ต้องรอ cache หมดอายุ */
async function maintTeamRows() {
  try {
    return await dbAll(
      "SELECT person_key, name, tg_user_id FROM duty_people WHERE kind = 'maint' AND active = 1 ORDER BY sort_order, person_key", []);
  } catch { return []; }
}
async function techOf(tgUserId) {
  if (!tgUserId) return null;
  const rows = await maintTeamRows();
  return rows.find(r => String(r.tg_user_id || '') === String(tgUserId)) || null;
}
// ใช้หน้าปุ่มที่ช่างเท่านั้นกดได้ — คืน null พร้อมเด้งเตือนถ้าไม่ใช่ช่าง
async function requireTech(cq) {
  const t = await techOf(cq.from?.id);
  if (t) return t;
  await tgApi('answerCallbackQuery', {
    callback_query_id: cq.id, show_alert: true,
    text: 'ปุ่มนี้สำหรับช่างซ่อมบำรุงเท่านั้นครับ\n\nถ้าคุณเป็นช่าง กดปุ่ม "🔧 ผมเป็นช่าง" ที่กระดานหลักเพื่อผูกบัญชีก่อน',
  });
  return null;
}

/* ── ร่างบทสนทนาของกระดาน (ปิดงาน / ตั้งงาน PM) ──────────────────────────── */
const MD_TTL_MIN = 30;
async function getMaintDraft(chatId, userId) {
  const cutoff = new Date(Date.now() - MD_TTL_MIN * 60000).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  try { await db.exec('DELETE FROM tg_maint_draft WHERE created_at < ?', [cutoff]); } catch { /* ช่างมัน */ }
  const rows = await dbAll('SELECT * FROM tg_maint_draft WHERE chat_id = ? AND user_id = ?', [String(chatId), String(userId)]);
  if (!rows[0]) return null;
  let data = {};
  try { data = JSON.parse(rows[0].data || '{}'); } catch { data = {}; }
  return { ...rows[0], data };
}
async function setMaintDraft(chatId, userId, patch) {
  const cur = await getMaintDraft(chatId, userId) || {};
  const row = {
    kind: patch.kind ?? cur.kind ?? '',
    refId: patch.refId ?? cur.ref_id ?? null,
    step: patch.step ?? cur.step ?? '',
    data: { ...(cur.data || {}), ...(patch.data || {}) },
  };
  await db.exec(
    `INSERT INTO tg_maint_draft (chat_id, user_id, kind, ref_id, step, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id,
       step = excluded.step, data = excluded.data`,
    [String(chatId), String(userId), row.kind, row.refId, row.step, JSON.stringify(row.data), nowBKK()]);
  return row;
}
const clearMaintDraft = (chatId, userId) =>
  db.exec('DELETE FROM tg_maint_draft WHERE chat_id = ? AND user_id = ?', [String(chatId), String(userId)]);

/* ── ตัวเลขบนหัวกระดาน ─────────────────────────────────────────────────────
   ยิงทีเดียวแล้วส่งต่อให้ทุกจอใช้ — กระดานเปิดบ่อย ไม่ควรถาม DB ซ้ำหลายรอบ */
async function maintCounts(date) {
  // downList = เครื่องที่หยุดอยู่ตอนนี้ + หยุดมากี่นาที (สรุปของทีมช่างเอาไปขึ้นบล็อก "ต้องรีบ")
  const out = { open: 0, wip: 0, downNow: 0, downList: [], pmToday: 0, pmLate: 0, rtDue: 0, matLow: 0, gap: 0 };
  try {
    /* ใบที่ปิดแล้วแต่ไม่มีสาเหตุหรือวิธีแก้ = ค้นเจอก็ไม่ได้คำตอบ (คลังความรู้มีรูแต่ไม่มีใครเห็น)
       COALESCE(...,'') เทียบครอบทั้ง NULL และ '' — Postgres/SQLite เทียบสองอย่างนี้คนละแบบ */
    out.gap = Number((await dbGet(
      "SELECT COUNT(*) AS n FROM incidents WHERE status = 'closed' AND (COALESCE(cause,'') = '' OR COALESCE(fix,'') = '')",
      []))?.n || 0);
    const inc = await dbAll(
      "SELECT status, machine, down_from, down_to FROM incidents WHERE COALESCE(status, 'open') <> 'closed'", []);
    for (const r of inc) {
      if ((r.status || 'open') === 'wip') out.wip++; else out.open++;
      if (r.down_from && !r.down_to) {
        out.downNow++;
        out.downList.push({ machine: r.machine || 'ไม่ระบุเครื่อง', mins: downSoFar(r) });
      }
    }
    out.downList.sort((a, b) => (b.mins || 0) - (a.mins || 0));   // หยุดนานสุดขึ้นก่อน
  } catch { /* ตารางยังไม่พร้อม — ปล่อยเป็น 0 */ }
  try {
    const pm = await dbAll(
      "SELECT task_date FROM daily_tasks WHERE category = 'pm' AND status <> 'done'", []);
    for (const r of pm) {
      if (String(r.task_date) < date) out.pmLate++;
      else if (String(r.task_date) === date) out.pmToday++;
    }
  } catch { /* ช่างมัน */ }
  try {
    const m = await dbAll(
      'SELECT COUNT(*) AS n FROM materials WHERE active = 1 AND reorder_point > 0 AND stock <= reorder_point', []);
    out.matLow = Number((m[0] || {}).n || 0);
  } catch { /* ช่างมัน */ }
  try { out.rtDue = (await dueRoutines(date)).length; } catch { /* ช่างมัน */ }
  return out;
}

/* งานรูทีนที่ "ถึงคิว" วันนี้ — เฉพาะงานที่ช่างเป็นเจ้าของ (owner_role='mt')
   งานของฝ่ายผลิตไม่เอามาปนในกระดานนี้ (เขามีกระดานของเขาในกลุ่มเดิมอยู่แล้ว) */
async function dueRoutines(date) {
  const people = await maintTeamRows();
  if (!people.length) return [];
  /* ── "ทำครั้งล่าสุดเมื่อไหร่" ต้องเป็นเรื่องของตัวงาน ไม่ใช่ของคน ────────────
     routine_state ผูก UNIQUE(state_date, assignee, node_key) = ประวัติ "ใครทำวันไหน"
     แต่ตอนย้ายเจ้าของงานถาวร แก้แค่ duty_routines.person_key → ประวัติยังอยู่ชื่อคนเดิม
     ถ้าหา lastDone ด้วยชื่อคนอย่างเดียว เจ้าของใหม่จะได้ null = **ถึงคิวทันทีทุกวัน**
     งานรายเดือนที่คนเดิมเพิ่งทำเมื่อวาน พอย้ายเจ้าของก็เด้งขึ้นกระดานทันที และเด้งไปเรื่อย ๆ
     จนกว่าเจ้าของใหม่จะติ๊ก (เจอตอนตรวจโค้ดข้อ "ประวัติติ๊กเก่าตอนย้ายเจ้าของ")

     ✅ แก้ที่การคำนวณ ไม่ใช่ที่ข้อมูล — ไม่ย้าย/ไม่เขียนทับประวัติของใครทั้งนั้น
        (ประวัติคือ "ใครทำวันนั้น" ซึ่งก็คือคนเดิมจริง ๆ การย้ายตามคือการปลอมประวัติ)
     ⚠️ ใช้ของสำรองได้เฉพาะงานที่มี **เจ้าของอยู่คนเดียว** — node_key ซ้ำข้ามคนได้จริง
        (ทีมผลิตแชร์ filter/mix/pour อยู่ 6 ตัว) งานที่หลายคนถือ ถ้าเหมารวมกันจะกลายเป็น
        "นายติ๊กแล้ว ม้ำถือว่าทำแล้วด้วย" ซึ่งผิดคนละแบบ                                */
  const lastMap = {};      // ติ๊กล่าสุด ต่อคน+งาน (ของเดิม)
  const nodeLast = {};     // ติ๊กล่าสุดของงานนั้น ไม่สนว่าใครทำ (ของสำรอง)
  const soleOwner = {};    // งานนี้มีเจ้าของอยู่คนเดียวไหม
  try {
    const rows = await dbAll(
      'SELECT assignee, node_key, MAX(state_date) AS last_done FROM routine_state WHERE checked = 1 GROUP BY assignee, node_key', []);
    for (const r of rows) {
      lastMap[`${r.assignee}|${r.node_key}`] = r.last_done;
      if (!nodeLast[r.node_key] || String(r.last_done) > String(nodeLast[r.node_key])) nodeLast[r.node_key] = r.last_done;
    }
    for (const r of await dbAll(
      'SELECT node_key, COUNT(*) AS n FROM duty_routines WHERE active = 1 GROUP BY node_key', [])) {
      soleOwner[r.node_key] = Number(r.n) === 1;
    }
  } catch { /* ช่างมัน */ }
  const out = [];
  for (const p of people) {
    const nodes = flattenRoutine(await buildRoutineTree(p.person_key));
    for (const n of nodes) {
      if (n.ownerRole && n.ownerRole !== 'mt') continue;        // ไม่ใช่งานของช่าง
      const last = lastMap[`${p.person_key}|${n.key}`]
        || (soleOwner[n.key] ? nodeLast[n.key] : null) || null;
      const doneToday = last === date;
      if (!doneToday && !routineDue(n.freq, last, date)) continue;
      out.push({ owner: p.person_key, key: n.key, title: n.title, machine: n.machine || 'ไม่ระบุเครื่อง',
        freq: n.freq || 'daily', lastDone: last, done: doneToday });
    }
  }
  return out;                     // รวมของที่ติ๊กไปแล้ววันนี้ด้วย — กระดานต้องโชว์ ✅ ให้เห็นว่าทำแล้ว
}

/* ── กระดานหลัก ──────────────────────────────────────────────────────────── */
async function buildMaintHome(date) {
  const c = await maintCounts(date);
  const team = await maintTeamRows();
  const unbound = team.filter(t => !t.tg_user_id).length;
  const rtDue = await dueRoutines(date);
  const rtLeft = rtDue.filter(r => !r.done).length;

  const L = [
    `🔧 <b>ซ่อมบำรุง SPP</b> · ${thaiDate(date)}`,
    ``,
    `${SR_STATUS.open.icon} รอรับงาน <b>${c.open}</b>　${SR_STATUS.wip.icon} กำลังซ่อม <b>${c.wip}</b>`,
  ];
  if (c.downNow) L.push(`⏱ <b>เครื่องหยุดอยู่ตอนนี้ ${c.downNow} เครื่อง</b>`);
  L.push('', 'เจอเครื่องมีปัญหา กดปุ่มแรกได้เลย 👇');

  const kb = [
    [{ text: '🆘  แ จ้ ง ซ่ อ ม', callback_data: 'inc:new' }],
    [{ text: `${c.open + c.wip ? '🔴' : '✅'} งานซ่อม · ${c.open + c.wip}`, callback_data: 'm:rep' }],
    [{ text: `🗓 งาน PM · วันนี้ ${c.pmToday}${c.pmLate ? ` · เกินกำหนด ${c.pmLate}` : ''}`, callback_data: 'm:pm' }],
    [{ text: `🔁 งานรูทีน · ถึงคิว ${rtLeft}`, callback_data: 'm:rt' }],
    [{ text: `📦 อะไหล่/วัสดุ${c.matLow ? ` · ใกล้หมด ${c.matLow}` : ''}`, callback_data: 'm:mat' }],
  ];
  // โผล่เฉพาะตอนมีของค้างจริง — ไม่มีของค้างแล้วยังโชว์ปุ่ม = เมนูรกโดยไม่ได้อะไร
  if (c.gap) kb.push([{ text: `✍️ เติมสาเหตุที่ยังขาด · ${c.gap}`, callback_data: 'm:gap' }]);
  kb.push([{ text: '🔄 รีเฟรช', callback_data: 'm:home' }]);
  if (unbound) kb.push([{ text: '🔧 ผมเป็นช่าง (ผูกบัญชี)', callback_data: 'm:bind' }]);
  return { text: L.join('\n'), keyboard: kb };
}

/* ── รายการงานซ่อมที่ยังไม่ปิด ───────────────────────────────────────────── */
async function buildRepairList() {
  const rows = await dbAll(
    "SELECT id, title, machine, status, priority, down_from, down_to, assignee FROM incidents WHERE COALESCE(status, 'open') <> 'closed'", []);
  rows.sort((a, b) => (srPrio(a.priority).order - srPrio(b.priority).order) || (b.id - a.id));
  const kb = rows.slice(0, 12).map(r => {
    const mins = r.down_from && !r.down_to ? downSoFar(r) : null;
    const tail = mins != null ? ` · หยุด ${downLabel(mins)}` : '';
    return [{ text: clip(`${srPrio(r.priority).icon} ${r.title}${tail}`), callback_data: `m:rep:${r.id}` }];
  });
  kb.push([{ text: '⬅️ กลับ', callback_data: 'm:home' }, { text: '🔄 รีเฟรช', callback_data: 'm:rep' }]);
  const text = rows.length
    ? `🔴 <b>งานซ่อมที่ยังไม่ปิด</b> · ${rows.length} งาน\n\nแตะเลือกใบงานเพื่อรับงาน/ปิดงาน 👇`
    : `✅ <b>ไม่มีงานซ่อมค้าง</b>\n\nเครื่องเดินครบทุกตัว 🎉`;
  return { text, keyboard: kb };
}

/* ── กระดาน "เติมสาเหตุที่ยังขาด" ─────────────────────────────────────────
   ใบที่ปิดแล้วแต่ไม่มีสาเหตุ/วิธีแก้ = ค้นเจอในคลังความรู้ก็ไม่ได้คำตอบ
   หน้าเว็บมีป้ายเตือนอยู่แล้ว แต่ไม่มีใครนั่งเปิดเว็บไล่ทีละใบ — ช่างอยู่ในกลุ่มทั้งวัน
   เลยทำทางเติมจากในกลุ่มให้ กดปุ่ม → พิมพ์ตอบ → จบ                              */
async function buildGapList() {
  const rows = await dbAll(
    `SELECT id, title, machine, cause, fix, occurred_at FROM incidents
      WHERE status = 'closed' AND (COALESCE(cause,'') = '' OR COALESCE(fix,'') = '')
      ORDER BY id DESC`, []);
  const kb = rows.slice(0, 12).map(r => {
    // บอกตั้งแต่บนปุ่มว่าใบนี้ขาดอะไร ช่างจะได้เลือกใบที่ตอบได้ก่อน
    const need = !r.cause && !r.fix ? 'ขาดทั้งคู่' : !r.cause ? 'ขาดสาเหตุ' : 'ขาดวิธีแก้';
    return [{ text: clip(`${r.machine ? `${r.machine} · ` : ''}${r.title} — ${need}`), callback_data: `m:gapf:${r.id}` }];
  });
  kb.push([{ text: '⬅️ กลับ', callback_data: 'm:home' }, { text: '🔄 รีเฟรช', callback_data: 'm:gap' }]);
  const text = rows.length
    ? `✍️ <b>ใบที่ปิดแล้วแต่ยังไม่มีสาเหตุ/วิธีแก้</b> · ${rows.length} ใบ\n`
      + `\nใบพวกนี้ค้นเจอในคลังความรู้ แต่เปิดมาแล้วไม่ได้คำตอบ`
      + `\nจำได้ใบไหน แตะแล้วพิมพ์ตอบได้เลย 👇`
      + (rows.length > 12 ? `\n\n<i>โชว์ 12 ใบล่าสุด · เติมแล้วกดรีเฟรชจะมีใบถัดไปขึ้นมา</i>` : '')
    : `🎉 <b>คลังความรู้ครบแล้ว</b>\n\nใบที่ปิดไปมีสาเหตุและวิธีแก้ครบทุกใบ`;
  return { text, keyboard: kb };
}

// ถามข้อถัดไปของการเติมความรู้ — ถามเฉพาะช่องที่ยังว่างจริง
async function gapAsk(chatId, who, row, step) {
  const head = `✍️ <b>เติมความรู้ใบ #${row.id}</b>\n🔩 ${escapeHtml(row.machine || 'ไม่ระบุเครื่อง')}`
    + `\n📌 ${escapeHtml(row.title || '')}`
    + (row.symptom ? `\n📝 ${escapeHtml(String(row.symptom).slice(0, 200))}` : '');
  if (step === 'cause') {
    return askText(chatId, who,
      `${head}\n\n🔍 <b>ตอนนั้นเกิดจากอะไรครับ?</b> พิมพ์สั้น ๆ พอ\n\n<i>พิมพ์ “ยกเลิก” เพื่อเลิก</i>`, 'สาเหตุ…');
  }
  return askText(chatId, who,
    `${head}${row.cause ? `\n🔍 สาเหตุ: ${escapeHtml(row.cause)}` : ''}`
    + `\n\n🔧 <b>แก้ยังไงครับ?</b> พิมพ์สั้น ๆ พอ\n\n<i>พิมพ์ “ยกเลิก” เพื่อเลิก</i>`, 'วิธีแก้…');
}

/* บันทึกความรู้ที่เติมมา แล้วทำตามลำดับ 5 ขั้นเดียวกับตอนปิดงาน
   (UPDATE → อ่านแถวใหม่ → syncIncident → touchMachineNote → เด้งการ์ด)
   ข้ามขั้นไหนไปโน้ตใน vault กับการ์ดในกลุ่มจะค้างข้อมูลเก่า                        */
async function saveGapAnswer(id, patch) {
  const sets = [], args = [];
  if (patch.cause != null) { sets.push('cause = ?'); args.push(patch.cause); }
  if (patch.fix != null) { sets.push('fix = ?'); args.push(patch.fix); }
  if (!sets.length) return null;
  sets.push('updated_at = ?'); args.push(nowBKK());
  await db.exec(`UPDATE incidents SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
  const fresh = await getIncident(id);
  try {
    const sync = await syncIncident(fresh);
    if (sync.path) await db.exec('UPDATE incidents SET vault_path = ? WHERE id = ?', [sync.path, id]);
  } catch { /* เขียนโน้ตไม่ได้ก็ไม่บล็อกการเติมความรู้ */ }
  touchMachineNote(fresh.machine);
  await refreshRepairCard(id);
  return fresh;
}

/* ── การ์ดใบแจ้งซ่อม 1 ใบ ────────────────────────────────────────────────
   ใช้ทั้งตอนโพสต์เข้ากลุ่มครั้งแรก และตอนแก้ข้อความเดิมเมื่อสถานะเปลี่ยน
   (แก้ใบเดิมแทนโพสต์ใหม่ ทีมผลิตจะได้ไม่ต้องไล่หาว่าอันไหนล่าสุด)              */
function repairCard(row) {
  const st = srStatus(row.status || 'open');
  const pr = srPrio(row.priority);
  const L = [
    `🆘 <b>แจ้งซ่อม #${row.id}</b>　${st.icon} <b>${st.label}</b>`,
    `━━━━━━━━━━━━━━━━`,
    `🔩 ${escapeHtml(row.machine || 'ไม่ระบุเครื่อง')}`,
    `${pr.icon} ${pr.label}`,
  ];
  if (row.title) L.push(`📌 ${escapeHtml(row.title)}`);
  if (row.symptom) L.push(`📝 ${escapeHtml(String(row.symptom).slice(0, 300))}`);
  const imgs = parseImgs(row.images);
  if (imgs.length) L.push(`📸 แนบรูป ${imgs.length} รูป`);
  L.push(`🙋 แจ้งโดย ${escapeHtml(row.operator || 'ไม่ระบุ')}`);
  if (row.assignee) L.push(`🔧 ช่างที่รับงาน: ${escapeHtml(dutyName(row.assignee))}`);

  // เวลาที่เครื่องหยุด — โชว์ "นาที" เท่านั้น ไม่โชว์ค่าเสียโอกาสเป็นเงินในกลุ่ม
  if (row.down_from) {
    const closedMin = downMinutes(row.down_from, row.down_to);
    if (row.down_to && closedMin != null) L.push(`⏱ หยุดรวม <b>${downLabel(closedMin)}</b>`);
    else {
      const m = downSoFar(row);
      if (m != null) L.push(`⏱ <b>หยุดมาแล้ว ${downLabel(m)}</b>`);
    }
  }
  if ((row.status || 'open') === 'closed') {
    if (row.fix) L.push('', `✅ <b>วิธีแก้:</b> ${escapeHtml(String(row.fix).slice(0, 400))}`);
    const after = parseImgs(row.result_images);
    if (after.length) L.push(`📸 รูปหลังซ่อม ${after.length} รูป`);
  }
  const kb = [];
  const s = row.status || 'open';
  if (s === 'open') kb.push([{ text: '🙋 รับงาน', callback_data: `m:take:${row.id}` }]);
  else if (s === 'wip') kb.push([{ text: '✅ ปิดงาน', callback_data: `m:close:${row.id}` }]);
  /* ปิดแล้วแต่ความรู้ไม่ครบ → ให้เติมจากการ์ดได้เลย ตรงจุดที่คนเพิ่งอ่านเรื่องนี้อยู่
     (ถามตอนที่ยังจำได้ ดีกว่าไปตามเก็บทีหลังตอนลืมแล้ว) */
  else if (s === 'closed' && (!row.cause || !row.fix)) {
    kb.push([{ text: !row.cause && !row.fix ? '✍️ เติมสาเหตุ + วิธีแก้' : !row.cause ? '✍️ เติมสาเหตุ' : '✍️ เติมวิธีแก้',
      callback_data: `m:gapf:${row.id}` }]);
  }
  kb.push([{ text: '📖 ประวัติเครื่องนี้', callback_data: `m:hist:${row.id}` },
           { text: '📋 งานซ่อมทั้งหมด', callback_data: 'm:rep' }]);
  return { text: L.join('\n'), keyboard: kb };
}

const getIncident = async (id) => (await dbAll('SELECT * FROM incidents WHERE id = ?', [id]))[0] || null;

/* ── "เครื่องนี้เจออาการนี้ครั้งที่ N แล้ว" ────────────────────────────────
   ช่างที่กำลังจะกดรับงานต้องรู้ก่อนว่านี่ไม่ใช่ครั้งแรก — ซ่อมซ้ำที่ 4 แปลว่าแก้ไม่ตรงสาเหตุ
   เกณฑ์จับคู่ "อาการเดียวกัน" เลือกให้แม่นไว้ก่อน เพราะบอกเลขผิดแย่กว่าไม่บอกเลย:
     · มี ref_key (ใบที่เกิดจากใบเช็ก AM) → นับจาก ref_key ตรง ๆ = ข้อตรวจเดียวกันของไลน์เดียวกัน
     · ไม่มี → เครื่องเดียวกัน + ชื่อเรื่องเหมือนกันหลังตัดช่องว่าง/เครื่องหมาย/ตัวพิมพ์
   ไม่ทำ fuzzy match และไม่ใช้ AI — เดาใกล้เคียงแล้วนับรวมมั่วเสียหายกว่านับได้น้อย
   ⚠️ ใบที่ "เจอซ้ำแล้วต่อในใบเดิม" (ใบเช็ก AM) ไม่เพิ่มเลข ถูกแล้ว — ยังเป็นใบงานใบเดียวกันอยู่ */
const repairSig = (t) => String(t || '').toLowerCase().replace(/[\s\u200b.,\-_/()[\]"'`]+/g, '');

async function repairRepeat(row) {
  const none = { times: 1, lastDate: null, closedBefore: 0, prevDowns: [] };
  try {
    if (row.ref_key) {
      const rows = await dbAll(
        'SELECT id, occurred_at, status, down_from, down_to FROM incidents WHERE ref_key = ? ORDER BY occurred_at',
        [row.ref_key]);
      return summarizeRepeat(rows, row);
    }
    const sig = repairSig(row.title);
    if (!row.machine || !sig) return none;
    const rows = (await dbAll(
      'SELECT id, title, occurred_at, status, down_from, down_to FROM incidents WHERE machine = ? ORDER BY occurred_at',
      [row.machine])).filter(r => repairSig(r.title) === sig);
    return summarizeRepeat(rows, row);
  } catch (e) { console.error('[repair-card] นับซ้ำไม่สำเร็จ', row.id, e.message); return none; }
}

// rows = ใบทั้งหมดที่ถือว่า "อาการเดียวกัน" (รวมใบปัจจุบัน) → แปลงเป็นตัวเลขบนการ์ด
function summarizeRepeat(rows, row) {
  // occurred_at เป็นวันที่ล้วน — 2 ใบวันเดียวกันต้องตัดสินด้วย id ไม่งั้นทั้งคู่ขึ้น "ครั้งที่ 2"
  const ord = (r) => `${r.occurred_at || ''}#${String(r.id).padStart(12, '0')}`;
  const mine = ord(row);
  const prev = rows.filter(r => String(r.id) !== String(row.id) && ord(r) < mine).sort((a, b) => (ord(a) < ord(b) ? -1 : 1));
  return {
    times: prev.length + 1,                                  // ใบนี้คือครั้งที่เท่าไหร่
    lastDate: prev.length ? prev[prev.length - 1].occurred_at : null,
    closedBefore: prev.filter(r => r.status === 'closed').length,
    /* เวลาที่เครื่องหยุดของครั้งก่อน ๆ — เอาไปเป็น "สเกล" ของแถบเวลาบนการ์ด
       แถบที่ไม่มีอะไรให้เทียบก็แค่แถบเต็มความยาวเสมอ = ไม่ได้บอกอะไรเลย
       เอาเฉพาะใบที่กรอกเวลาครบ (ใบที่ไม่ได้กรอกไม่ใช่ "หยุด 0 นาที") ล่าสุดก่อน */
    prevDowns: prev.slice().reverse()
      .map(r => ({ date: r.occurred_at, mins: downMinutes(r.down_from, r.down_to) }))
      .filter(x => x.mins != null && x.mins > 0)
      .slice(0, 3),
  };
}

/* ── การ์ดใบแจ้งซ่อมแบบรูป (PNG) ──────────────────────────────────────────
   ตัวที่ปักอยู่ในกลุ่มช่างเป็นรูป · repairCard() ที่เป็นข้อความยังอยู่ ใช้ตอนเปิดดูใบงาน
   จากเมนูในบอท (show() = editMessageText แก้ข้อความที่กดมา ซึ่งเป็นคนละใบกับการ์ดที่ปัก)
   คืน null เมื่อเรนเดอร์ไม่ได้ (lib/ฟอนต์ไม่พร้อม) → ผู้เรียกตกกลับไปใช้การ์ดข้อความ      */
async function repairCardPhoto(row, kicker) {
  if (!canRenderCard()) return null;
  const st = srStatus(row.status || 'open');
  const pr = srPrio(row.priority);
  const rep = await repairRepeat(row);
  const imgs = parseImgs(row.images);
  const after = parseImgs(row.result_images);
  const closed = (row.status || 'open') === 'closed';
  const closedMin = downMinutes(row.down_from, row.down_to);
  const soFar = row.down_from && !row.down_to ? downSoFar(row) : null;
  /* รูปที่แนบมาต้องอยู่ในการ์ด ไม่ใช่แค่บอกจำนวน — ช่างที่เห็นในกลุ่มต้องเห็นอาการทันที
     โหลดรูปพลาดใบหนึ่งไม่ล้มทั้งการ์ด (การ์ดที่รูปไม่ครบ ดีกว่าไม่มีการ์ดเลย)
     ⚠️ การ์ดเรนเดอร์ใหม่ทุกครั้งที่สถานะเปลี่ยน = โหลดรูปใหม่ทุกครั้ง จึงเอาแค่ 3 ใบที่โชว์จริง */
  const toUris = async (list) => (await Promise.allSettled(list.slice(0, 3).map(fetchAsDataUri)))
    .map(r => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
  const photoUris = imgs.length ? await toUris(imgs) : [];
  const afterUris = closed && after.length ? await toUris(after) : [];

  // จำนวนรูปขึ้น footer เฉพาะตอนที่โชว์รูปจริงไม่ได้ — โชว์ได้แล้วเขียนซ้ำก็ไม่ได้อะไรเพิ่ม
  const footL = [imgs.length ? (photoUris.length ? '' : `แนบรูป ${imgs.length} รูป`) : 'ยังไม่แนบรูป',
    after.length && !afterUris.length ? `หลังซ่อม ${after.length} รูป` : ''].filter(Boolean).join(' · ');
  const SRC_LABEL = { amsheet: 'จากใบเช็ก AM', bot: 'แจ้งจากบอท', web: 'แจ้งจากเว็บ', ai: 'ระบบเฝ้าคุณภาพ',
    runcheck: 'จากเช็กลิสต์เดินเครื่อง' };

  let png = null;
  try {
    png = renderRepairCardPNG({
      kicker: kicker || `แจ้งซ่อม #${row.id}`,
      title: row.title || 'ใบแจ้งซ่อม',
      machine: row.machine || 'ไม่ระบุเครื่อง',
      operator: row.operator || '',
      dateLabel: row.occurred_at ? thaiDate(row.occurred_at) : '',
      status: row.status || 'open',
      priority: row.priority || 'warn',
      symptom: row.symptom || '',
      assigneeName: row.assignee ? dutyName(row.assignee) : '',
      downLabel: closed && closedMin != null ? downLabel(closedMin) : (soFar != null ? downLabel(soFar) : ''),
      downClosed: !!(closed && closedMin != null),
      /* แถบเวลาเครื่องหยุด — ส่งไปเฉพาะตอนมีของให้เทียบจริง (ครั้งก่อนมีเวลาที่กรอกครบ)
         ไม่มีอะไรเทียบ = แถบเต็มความยาวตลอด ซึ่งกินที่บนการ์ดฟรี ๆ โดยไม่บอกอะไรเพิ่ม
         → กรณีนั้นตกไปใช้แถวตัวเลขธรรมดาเหมือนเดิม (ดู rows ใน buildRepairCardSVG) */
      downBars: rep.prevDowns.length && (closedMin != null || soFar != null)
        ? [{ label: closed ? 'ครั้งนี้ (ปิดแล้ว)' : 'ครั้งนี้ · ยังหยุดอยู่', mins: closedMin != null ? closedMin : soFar, me: true },
           ...rep.prevDowns.map(x => ({ label: thaiDate(x.date), mins: x.mins, me: false }))]
        : [],
      cause: row.cause || '',
      fix: closed ? (row.fix || '') : '',
      photoUris, photoTotal: imgs.length,
      afterUris, afterTotal: after.length,
      repeatTimes: rep.times,
      repeatLastLabel: rep.lastDate
        ? `ครั้งก่อน ${thaiDate(rep.lastDate)}${rep.closedBefore ? ` · ปิดไปแล้ว ${rep.closedBefore} ใบ` : ''}`
        : '',
      footer: footL,
      footerRight: SRC_LABEL[row.source] || '',
    });
  } catch (e) { console.error('[repair-card] เรนเดอร์รูปไม่สำเร็จ', row.id, e.message); return null; }
  if (!png) return null;

  /* caption สั้น ๆ แต่ต้องมี — ข้อความในรูปค้นหาไม่ได้ ก๊อปไม่ได้ อ่านด้วยโปรแกรมอ่านหน้าจอไม่ได้
     ใส่แค่ที่ต้องใช้ค้นย้อนหลังในกลุ่ม (เลขใบ/เครื่อง/หัวข้อ/สถานะ) รายละเอียดที่เหลืออยู่ในรูป */
  const caption = [
    `🆘 <b>แจ้งซ่อม #${row.id}</b>　${st.icon} ${st.label}`,
    `🔩 ${escapeHtml(row.machine || 'ไม่ระบุเครื่อง')}　${pr.icon} ${pr.label}`,
    row.title ? `📌 ${escapeHtml(row.title)}` : '',
    rep.times >= 2 ? `🔁 <b>เจออาการนี้ครั้งที่ ${rep.times}</b>` : '',
  ].filter(Boolean).join('\n').slice(0, 1024);

  return { png, caption, keyboard: repairCard(row).keyboard };
}

/* โพสต์การ์ดเข้ากลุ่มครั้งแรก แล้วจำ message_id + ชนิดการ์ดไว้แก้ทีหลัง
   เรนเดอร์รูปไม่ได้ → ตกกลับไปการ์ดข้อความแบบเดิม (บอทต้องไม่เงียบเพราะเรื่องหน้าตา) */
async function postRepairCard(id, chatId) {
  const row = await getIncident(id);
  if (!row) return;
  const photo = await repairCardPhoto(row);
  let mid = null, kind = 'text';
  if (photo) {
    const r = await tgApiForm('sendPhoto', {
      chat_id: chatId, caption: photo.caption, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: photo.keyboard },
    }, { field: 'photo', buffer: photo.png, filename: `repair-${id}.png` });
    mid = r?.result?.message_id;
    if (mid) kind = 'photo';
  }
  if (!mid) {
    const card = repairCard(row);
    const r = await tgApi('sendMessage', {
      chat_id: chatId, text: card.text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: card.keyboard },
    });
    mid = r?.result?.message_id;
  }
  if (mid) {
    try {
      await db.exec('UPDATE incidents SET card_chat_id = ?, card_msg_id = ?, card_kind = ? WHERE id = ?',
        [String(chatId), String(mid), kind, id]);
    } catch { /* ไม่ได้ก็ไม่เป็นไร แค่แก้การ์ดเดิมไม่ได้ */ }
  }
}

// แก้การ์ดเดิมให้ตรงกับสถานะล่าสุด (ไม่มีการ์ดเดิม = ข้ามเงียบ ๆ)
/* ⚠️ เรียกจาก HTTP endpoint ตรง ๆ ไม่ได้ — ต้องผ่าน bumpRepairCard() ข้างล่างเท่านั้น
   tgApi อ่าน token/chat จาก botCtx (AsyncLocalStorage) ถ้าไม่มี store จะตกไปบอทหลัก
   = ไปแก้ข้อความในกลุ่มผลิตด้วย message_id ที่ไม่มีอยู่จริง แล้วพังเงียบ

   ⚠️ แก้ข้ามชนิดไม่ได้ — การ์ดที่โพสต์เป็นข้อความจะกลายเป็นรูปทีหลังไม่ได้ (และกลับกัน)
      ต้องดู card_kind ของแถวนั้นเสมอ ไม่ใช่ดูว่าตอนนี้เรนเดอร์รูปได้ไหม               */
async function refreshRepairCard(id) {
  const row = await getIncident(id);
  if (!row || !row.card_chat_id || !row.card_msg_id) return 'no-card';   // ใบนี้ไม่ได้เปิดจากกลุ่ม
  if (row.card_kind === 'photo') {
    const photo = await repairCardPhoto(row);
    // เรนเดอร์ไม่ได้ชั่วคราว → ยังแก้ปุ่ม/caption ให้ตรงสถานะได้ ดีกว่าปล่อยการ์ดค้างสถานะเก่า
    if (!photo) {
      const st = srStatus(row.status || 'open');
      const r = await tgApi('editMessageCaption', {
        chat_id: row.card_chat_id, message_id: Number(row.card_msg_id),
        caption: `🆘 <b>แจ้งซ่อม #${row.id}</b>　${st.icon} ${st.label}`, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: repairCard(row).keyboard },
      });
      return r?.ok ? 'edited' : 'failed';
    }
    const r = await tgApiForm('editMessageMedia', {
      chat_id: row.card_chat_id, message_id: Number(row.card_msg_id),
      media: { type: 'photo', media: 'attach://card', caption: photo.caption, parse_mode: 'HTML' },
      reply_markup: { inline_keyboard: photo.keyboard },
    }, { field: 'card', buffer: photo.png, filename: `repair-${row.id}.png` });
    return r?.ok ? 'edited' : 'failed';
  }
  const card = repairCard(row);
  const r = await tgApi('editMessageText', {
    chat_id: row.card_chat_id, message_id: Number(row.card_msg_id),
    text: card.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: card.keyboard },
  });
  return r?.ok ? 'edited' : 'failed';
}

/* เด้งการ์ดในกลุ่มจากฝั่ง HTTP — จุดเดียวในระบบที่รู้เรื่อง bot context
   คืน 'edited' | 'no-card' | 'failed' เพื่อให้หน้าเว็บบอกผู้ใช้ได้ตรง ๆ ว่ากลุ่มเห็นแล้วหรือยัง
   (ผิดพลาดตรงนี้มองจากหน้าเว็บไม่เห็นเลย เพราะ tgApi กลืน error แล้ว endpoint ยังตอบ 200) */
async function bumpRepairCard(id) {
  try {
    return await inTopic('incident', () => refreshRepairCard(id));
  } catch (e) {
    console.error('[repair-card] refresh ไม่สำเร็จ', id, e.message);
    return 'failed';
  }
}

/* ── การ์ดบทเรียนตอนปิดงาน ────────────────────────────────────────────────
   ปิดงานแล้วระบบไป "แก้การ์ดใบเดิมทับที่เดิม" ซึ่งลอยไปไกลบนสกรอลล์ของกลุ่มแล้ว
   = ถูกตามที่เขียนไว้ แต่ไม่มีใครเห็น ซึ่งเท่ากับไม่มีรายงาน
   → โพสต์ใบใหม่ตอนจบงาน ให้บทเรียน (อาการ → สาเหตุ → วิธีแก้ → รูปหลังซ่อม) เด้งขึ้นมาเอง
   ⚠️ ใบนี้เป็น "ภาพนิ่ง ณ ตอนปิด" ไม่ใช่การ์ดที่แก้ทับตัวเอง — ตัวที่ระบบตามแก้ยังเป็น
      การ์ดเดิม (card_msg_id) ถ้ามีคนมาเติมสาเหตุทีหลัง ใบบทเรียนจะไม่ขยับตาม        */
async function postLessonCard(id) {
  const row = await getIncident(id);
  if (!row || (row.status || 'open') !== 'closed') return;
  const head = [
    `✅ <b>ปิดงานแล้ว — แจ้งซ่อม #${row.id}</b>`,
    `🔩 ${escapeHtml(row.machine || 'ไม่ระบุเครื่อง')}　📌 ${escapeHtml(row.title || '')}`,
    row.fix ? `🔧 <b>วิธีแก้:</b> ${escapeHtml(String(row.fix).slice(0, 300))}` : '',
    row.cause ? '' : '⚠️ ยังไม่ได้เติม "สาเหตุที่แท้จริง" — กดปุ่มบนการ์ดเติมได้เลย',
  ].filter(Boolean).join('\n');
  try {
    await inTopic('incident', async () => {
      const photo = await repairCardPhoto(row, `บทเรียนจากใบซ่อม #${row.id}`);
      if (!photo) return sendToTelegram(`${head}\n\n${repairCard(row).text}`);
      await tgApiForm('sendPhoto', {
        chat_id: tgChatId(), caption: head.slice(0, 1024), parse_mode: 'HTML',
        reply_markup: { inline_keyboard: photo.keyboard },
      }, { field: 'photo', buffer: photo.png, filename: `lesson-${id}.png` });
    });
  } catch (e) { console.error('[lesson-card] ส่งไม่สำเร็จ', id, e.message); }
}

/* ── งาน PM (งานที่วางแผนไว้ล่วงหน้า) ────────────────────────────────────
   เก็บใน daily_tasks category='pm' — ได้ระบบเตือนล่วงหน้า/รูปก่อน-หลัง/แก้-ลบ ของเดิมมาฟรี */
async function buildPmList(date) {
  const rows = await dbAll(
    "SELECT id, task_date, title, machine, priority, due_time, status FROM daily_tasks WHERE category = 'pm' AND status <> 'done' ORDER BY task_date, id", []);
  const late = rows.filter(r => String(r.task_date) < date);
  const today = rows.filter(r => String(r.task_date) === date);
  const next = rows.filter(r => String(r.task_date) > date).slice(0, 5);
  const kb = [];
  const push = (list, mark) => list.forEach(r =>
    kb.push([{ text: clip(`${mark} ${r.title}${r.machine ? ` · ${r.machine}` : ''}`), callback_data: `m:pmv:${r.id}` }]));
  push(late, '⚠️'); push(today, '🗓'); push(next, '📅');
  kb.push([{ text: '➕ ตั้งงาน PM ใหม่', callback_data: 'mpm:new' }]);
  kb.push([{ text: '⬅️ กลับ', callback_data: 'm:home' }, { text: '🔄 รีเฟรช', callback_data: 'm:pm' }]);
  const L = [`🗓 <b>งาน PM</b> — งานที่วางแผนไว้`, ``];
  if (late.length) L.push(`⚠️ <b>เกินกำหนด ${late.length}</b>`);
  L.push(`🗓 วันนี้ ${today.length}　📅 ถัดไป ${next.length}`);
  if (!rows.length) L.push('', '— ยังไม่มีงาน PM ที่วางแผนไว้ —');
  return { text: L.join('\n'), keyboard: kb };
}

async function buildPmView(id, date) {
  const r = (await dbAll('SELECT * FROM daily_tasks WHERE id = ?', [id]))[0];
  if (!r) return { text: 'ไม่พบงานนี้แล้ว', keyboard: [[{ text: '⬅️ กลับ', callback_data: 'm:pm' }]] };
  const overdue = String(r.task_date) < date;
  const L = [
    `🗓 <b>งาน PM #${r.id}</b>${overdue ? '　⚠️ <b>เกินกำหนด</b>' : ''}`,
    `━━━━━━━━━━━━━━━━`,
    `📌 ${escapeHtml(r.title)}`,
  ];
  if (r.machine) L.push(`🔩 ${escapeHtml(r.machine)}`);
  L.push(`📅 กำหนด ${thaiDate(r.task_date)}${r.due_time ? ` · ${r.due_time} น.` : ''}`);
  if (r.location) L.push(`📍 ${escapeHtml(r.location)}`);
  if (r.assignee) L.push(`👤 ${escapeHtml(dutyName(r.assignee))}`);
  return {
    text: L.join('\n'),
    keyboard: [
      [{ text: '✅ ทำเสร็จแล้ว', callback_data: `m:pmdone:${r.id}` }],
      [{ text: '⬅️ กลับ', callback_data: 'm:pm' }],
    ],
  };
}

/* ── งานรูทีน — สลับมุมได้ 2 แบบ (แผนข้อ B แบบ B3 · user เคาะ 2026-08-28) ──────
   👤 ตามคน   = "วันนี้งานของใครเหลืออะไร" — มุมตั้งต้น เพราะทีมมี 3 คนแล้ว
   🔩 ตามเครื่อง = "วันนี้เครื่องซีลมีอะไรต้องทำ" — ของเดิม ยังอยู่ครบ ห่างไปแค่แตะเดียว
   ทั้งสองมุมใช้ dueRoutines() ชุดเดียวกัน ไม่ได้แตะโครงข้อมูลเลย                    */
const machineListOf = (due) => Array.from(new Set(due.map(r => r.machine))).sort();
// รายชื่อคนที่มีงานถึงคิววันนี้ — เรียงตามลำดับในทีม (sort_order) ไม่ใช่ตามตัวอักษร
async function ownerListOf(due) {
  const have = new Set(due.map(r => r.owner));
  const out = (await maintTeamRows()).map(t => t.person_key).filter(k => have.has(k));
  // คนที่ถูกเอาออกจากทีมแล้วแต่ยังมีงานค้าง — ต่อท้ายไว้ ไม่ให้งานหายไปจากกระดานเงียบ ๆ
  for (const k of have) if (!out.includes(k)) out.push(k);
  return out;
}
// แถบสลับมุม — Telegram ไม่มีสถานะ "ปุ่มที่เลือกอยู่" ต้องติ๊กเองให้เห็นว่าอยู่มุมไหน
const rtViewRow = (view) => [
  { text: `${view === 'person' ? '✓ ' : ''}👤 ตามคน`, callback_data: 'm:rt' },
  { text: `${view === 'machine' ? '✓ ' : ''}🔩 ตามเครื่อง`, callback_data: 'm:rtx' },
];

async function buildRoutineBoard(date, view = 'person') {
  const due = await dueRoutines(date);
  const left = due.filter(r => !r.done).length;
  const kb = [];
  if (due.length) kb.push(rtViewRow(view));
  if (view === 'machine') {
    machineListOf(due).forEach((m, i) => {
      const list = due.filter(r => r.machine === m);
      const done = list.filter(r => r.done).length;
      kb.push([{ text: clip(`🔩 ${m}　${done}/${list.length}${done >= list.length ? ' ✅' : ''}`), callback_data: `m:rtm:${i}` }]);
    });
  } else {
    (await ownerListOf(due)).forEach((k, i) => {
      const list = due.filter(r => r.owner === k);
      const done = list.filter(r => r.done).length;
      kb.push([{ text: clip(`👤 ${dutyName(k)}　${done}/${list.length}${done >= list.length ? ' ✅' : ''}`), callback_data: `m:rtp:${i}` }]);
    });
  }
  kb.push([{ text: '⬅️ กลับ', callback_data: 'm:home' },
           { text: '🔄 รีเฟรช', callback_data: view === 'machine' ? 'm:rtx' : 'm:rt' }]);
  const text = due.length
    ? `🔁 <b>งานรูทีนที่ถึงคิววันนี้</b>\n${progressBar(Math.round((due.length - left) / due.length * 100))} ค้าง ${left} งาน\n\n`
      + `<i>โชว์เฉพาะงานที่ถึงคิวตามความถี่ที่ตั้งไว้ — งาน "เมื่อมีปัญหา" ไม่ขึ้นเอง</i>`
    : `🔁 <b>งานรูทีน</b>\n\n— วันนี้ไม่มีงานถึงคิว 🎉 —`;
  return { text, keyboard: kb };
}

/* หน้าของคนหนึ่งคน — ในนี้ยังจัดเรียงตามเครื่องอยู่ดี ช่างจะได้เดินไปจุดเดียวจบหลายงาน
   (ชื่อเครื่องต่อท้ายปุ่ม ไม่ทำหัวข้อคั่น เพราะปุ่มหัวข้อใน Telegram ต้องมี callback = ปุ่มตาย) */
async function buildRoutinePerson(idx, date) {
  const due = await dueRoutines(date);
  const owners = await ownerListOf(due);
  const key = owners[idx];
  if (!key) return buildRoutineBoard(date, 'person');
  const list = due.filter(r => r.owner === key);
  const machines = Array.from(new Set(list.map(r => r.machine))).sort();
  const kb = [];
  for (const m of machines) {
    for (const r of list.filter(x => x.machine === m)) {
      kb.push([{ text: clip(`${r.done ? '✅' : '⬜'} ${r.title} · ${m}`), callback_data: `m:rtt:P:${r.owner}:${r.key}` }]);
    }
  }
  kb.push([{ text: '⬅️ กลับ', callback_data: 'm:rt' }]);
  const doneN = list.filter(r => r.done).length;
  const perMachine = machines
    .map(m => `🔩 ${escapeHtml(m)} ${list.filter(x => x.machine === m && !x.done).length}`)
    .join('　');
  return {
    text: `👤 <b>${escapeHtml(dutyName(key))}</b>\n<i>ถึงคิววันนี้ ${list.length} งาน · เสร็จแล้ว ${doneN}</i>`
      + `\n\n${perMachine}\n\nแตะเพื่อติ๊กเสร็จ/ยกเลิก 👇`,
    keyboard: kb,
  };
}

async function buildRoutineMachine(idx, date) {
  const due = await dueRoutines(date);
  const machines = machineListOf(due);
  const m = machines[idx];
  if (!m) return buildRoutineBoard(date, 'machine');
  const list = due.filter(r => r.machine === m);
  const kb = list.map(r => [{
    text: clip(`${r.done ? '✅' : '⬜'} ${r.title}${r.owner ? ` · ${dutyName(r.owner)}` : ''}`),
    callback_data: `m:rtt:M:${r.owner}:${r.key}`,
  }]);
  // ประวัติเสียของเครื่องนี้ — ช่างจะได้รู้ว่าต้องระวังอะไรก่อนลงมือ
  let hist = '';
  try {
    const h = await dbAll('SELECT COUNT(*) AS n, MAX(occurred_at) AS last FROM incidents WHERE machine = ?', [m]);
    const n = Number((h[0] || {}).n || 0);
    if (n) hist = `\n\n📖 เครื่องนี้เคยมีเหตุ <b>${n} ครั้ง</b>${h[0].last ? ` · ล่าสุด ${thaiDate(String(h[0].last).slice(0, 10))}` : ''}`;
  } catch { /* ช่างมัน */ }
  kb.push([{ text: '⬅️ กลับ', callback_data: 'm:rtx' }]);
  const freqs = Array.from(new Set(list.map(r => FREQ_LABEL[r.freq] || 'ทุกวัน'))).join(' · ');
  return {
    text: `🔩 <b>${escapeHtml(m)}</b>\n<i>${escapeHtml(freqs)}</i>${hist}\n\nแตะเพื่อติ๊กเสร็จ/ยกเลิก 👇`,
    keyboard: kb,
  };
}

/* ── อะไหล่/วัสดุที่ถึงจุดสั่งซื้อ ─────────────────────────────────────────── */
async function buildMatList() {
  const rows = await dbAll(
    'SELECT name, unit, stock, reorder_point, supplier FROM materials WHERE active = 1 AND reorder_point > 0 AND stock <= reorder_point ORDER BY name', []);
  const L = rows.length
    ? [`📦 <b>อะไหล่/วัสดุที่ถึงจุดสั่งซื้อ</b> · ${rows.length} รายการ`, '']
    : [`📦 <b>อะไหล่/วัสดุ</b>`, '', '— ยังไม่มีรายการที่ถึงจุดสั่งซื้อ ✅ —'];
  for (const r of rows.slice(0, 20)) {
    L.push(`⚠️ <b>${escapeHtml(r.name)}</b>`);
    L.push(`　เหลือ ${round2(r.stock)} ${escapeHtml(r.unit || '')} (สั่งเมื่อ ≤ ${round2(r.reorder_point)})${r.supplier ? ` · ${escapeHtml(r.supplier)}` : ''}`);
  }
  if (rows.length > 20) L.push('', `<i>… และอีก ${rows.length - 20} รายการ ดูครบในแอป</i>`);
  return { text: L.join('\n'), keyboard: [[{ text: '⬅️ กลับ', callback_data: 'm:home' }, { text: '🔄 รีเฟรช', callback_data: 'm:mat' }]] };
}

/* ── ประวัติเหตุของเครื่อง (เปิดจากการ์ดใบแจ้งซ่อม) ──────────────────────── */
async function buildMachineHistory(incId) {
  const inc = await getIncident(incId);
  const machine = inc?.machine;
  if (!machine) return { text: 'ใบนี้ไม่ได้ระบุเครื่องจักร', keyboard: [[{ text: '⬅️ กลับ', callback_data: 'm:rep' }]] };
  const rows = await dbAll(
    'SELECT id, title, occurred_at, status, fix, down_from, down_to FROM incidents WHERE machine = ? AND id <> ? ORDER BY id DESC',
    [machine, incId]);
  const L = [`📖 <b>ประวัติ ${escapeHtml(machine)}</b>`, `เคยมีเหตุ <b>${rows.length} ครั้ง</b>`, ''];
  for (const r of rows.slice(0, 6)) {
    const min = downMinutes(r.down_from, r.down_to);
    L.push(`${srStatus(r.status).icon} <b>${escapeHtml(r.title || '-')}</b> · ${String(r.occurred_at || '').slice(0, 10)}${min != null ? ` · หยุด ${downLabel(min)}` : ''}`);
    if (r.fix) L.push(`　✅ ${escapeHtml(String(r.fix).slice(0, 140))}`);
  }
  if (!rows.length) L.push('— ยังไม่เคยมีเหตุที่บันทึกไว้ —');
  return { text: L.join('\n'), keyboard: [[{ text: '⬅️ กลับ', callback_data: `m:rep:${incId}` }]] };
}

/* ── ปุ่มเลือกเครื่องของ wizard อื่น — ใช้ปุ่มชุดเดียวกับใบแจ้งซ่อม เปลี่ยนแค่ prefix ── */
async function machineKeyboardFor(prefix) {
  const { names, keyboard } = await incMachineKeyboard();
  return { names, keyboard: keyboard.map(row => row.map(b => ({ text: b.text, callback_data: b.callback_data.replace(/^inc:/, `${prefix}:`) }))) };
}

/* ── ตัวช่วยถามคำถามแบบพิมพ์ตอบ ──────────────────────────────────────────
   ในกลุ่มต้อง force_reply + selective + แปะ mention ของคนถาม
   ไม่งั้นช่องตอบไม่เด้งให้ใครเลย (selective ดูจากคนที่ถูก mention ในข้อความ)   */
function askText(chatId, who, body, placeholder) {
  const mention = who.userId ? `<a href="tg://user?id=${who.userId}">${escapeHtml(who.name || 'คุณ')}</a> ` : '';
  return tgApi('sendMessage', {
    chat_id: chatId, text: mention + body, parse_mode: 'HTML',
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: placeholder },
  });
}
const whoOf = (from) => ({ userId: from?.id, name: [from?.first_name, from?.last_name].filter(Boolean).join(' ') });

// ปุ่มเลือกวันของงาน PM — ออฟเซ็ตเป็นวัน
const pmDateOf = (offset) => {
  const d = new Date(`${todayBKK()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(offset || 0));
  return d.toISOString().slice(0, 10);
};

// บันทึกงาน PM ลง daily_tasks (ใช้ท่อเดียวกับงานมอบหมาย → ได้ระบบเตือน/รูป/แก้-ลบ มาฟรี)
async function savePmTask(d, techKey) {
  const owner = techKey || (await maintTeamRows())[0]?.person_key || 'jakkrit';
  const title = `${PM_KIND[d.kind] ? PM_KIND[d.kind].replace(/^\S+\s/, '') : 'บำรุงรักษา'} — ${d.title}`;
  const remindAt = d.remind === 'none' ? null
    : d.remind === 'prev' ? `${pmDateOfFrom(d.date, -1)}T08:00`
    : `${d.date}T08:00`;
  await db.exec(
    `INSERT INTO daily_tasks (task_date, line_name, category, title, status, source, assignee, location, priority,
       images, done_images, due_time, remind_at, remind_lead, reminded, completed_at, done_by, audit_batch,
       photo_specs, machine, reporter, created_by, created_at)
     VALUES (?, ?, 'pm', ?, 'pending', 'assigned', ?, NULL, 'normal', '[]', '[]', ?, ?, ?, 0, NULL, NULL, NULL,
       NULL, ?, NULL, ?, ?)
     ON CONFLICT(task_date, line_name, category, title)
     DO UPDATE SET machine = excluded.machine, due_time = excluded.due_time, remind_at = excluded.remind_at,
       reminded = 0, status = 'pending', completed_at = NULL, done_by = NULL`,
    [d.date, owner, title, owner, d.dueTime || null, remindAt, d.remind === 'none' ? null : 'morning',
      d.machine || null, owner, nowBKK()]);
  // อัปเดต gate ในหน่วยความจำ กัน reminderTick ข้ามงานที่เพิ่งตั้ง
  if (remindAt && (_nextRemindAt == null || remindAt < _nextRemindAt)) { _nextRemindAt = remindAt; _nextRemindKnown = true; }
  return { title, date: d.date, remindAt };
}
const pmDateOfFrom = (date, offset) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(offset || 0));
  return d.toISOString().slice(0, 10);
};

// ถามข้อถัดไปของ wizard ตั้งงาน PM
async function pmAsk(chatId, draft, who) {
  const d = draft.data || {};
  if (draft.step === 'machine') {
    const { keyboard } = await machineKeyboardFor('mpm');
    return tgApi('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
      text: '🗓 <b>ตั้งงาน PM ใหม่</b>\n\n🔩 เครื่องไหนครับ?', reply_markup: { inline_keyboard: keyboard } });
  }
  if (draft.step === 'mtype') return askText(chatId, who, '⌨️ พิมพ์ชื่อเครื่องมาได้เลย', 'ชื่อเครื่อง…');
  if (draft.step === 'title')
    return askText(chatId, who, `🔩 ${escapeHtml(d.machine || 'ไม่ระบุเครื่อง')}\n\n📌 <b>จะทำอะไร?</b> พิมพ์สั้น ๆ เช่น <i>เปลี่ยนลูกยางหัวซีล</i>`, 'จะทำอะไร…');
  if (draft.step === 'kind')
    return tgApi('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
      text: `📌 ${escapeHtml(d.title || '')}\n\n<b>เป็นงานประเภทไหน?</b>`,
      reply_markup: { inline_keyboard: [
        [{ text: PM_KIND.pm, callback_data: 'mpm:k:pm' }],
        [{ text: PM_KIND.up, callback_data: 'mpm:k:up' }],
        [{ text: PM_KIND.fix, callback_data: 'mpm:k:fix' }],
        [{ text: '✕ ยกเลิก', callback_data: 'mpm:cancel' }]] } });
  if (draft.step === 'date')
    return tgApi('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
      text: '📅 <b>จะทำวันไหน?</b>',
      reply_markup: { inline_keyboard: [
        [{ text: 'วันนี้', callback_data: 'mpm:d:0' }, { text: 'พรุ่งนี้', callback_data: 'mpm:d:1' }],
        [{ text: 'อีก 7 วัน', callback_data: 'mpm:d:7' }, { text: 'อีก 30 วัน', callback_data: 'mpm:d:30' }],
        [{ text: '⌨️ พิมพ์วันที่เอง', callback_data: 'mpm:dtype' }],
        [{ text: '✕ ยกเลิก', callback_data: 'mpm:cancel' }]] } });
  if (draft.step === 'dtype') return askText(chatId, who, '⌨️ พิมพ์วันที่แบบ <b>2026-09-01</b>', 'YYYY-MM-DD');
  if (draft.step === 'remind')
    return tgApi('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
      text: `📅 ${thaiDate(d.date)}\n\n⏰ <b>ให้เตือนไหม?</b>`,
      reply_markup: { inline_keyboard: [
        [{ text: '🔔 เช้าวันงาน 08:00', callback_data: 'mpm:r:day' }],
        [{ text: '🔔 ล่วงหน้า 1 วัน', callback_data: 'mpm:r:prev' }],
        [{ text: '🔕 ไม่ต้องเตือน', callback_data: 'mpm:r:none' }]] } });
  return null;
}

/* ── ตัวรับ update ของกระดานซ่อมบำรุง ───────────────────────────────────────
   คืน true = จัดการเองแล้ว · false = ปล่อยให้ handleDutyUpdate เดิมทำต่อ
   (wizard แจ้งซ่อม ปุ่มติ๊กงานประจำ และการรับรูปงานมอบหมาย ยังใช้ของเดิมทั้งดุ้น) */
async function handleMaintUpdate(upd) {
  const date = workDayBKK();

  // ═══ ปุ่ม ═══
  if (upd.callback_query) {
    const cq = upd.callback_query;
    const data = cq.data || '';
    if (!/^(m|mpm):/.test(data)) return false;
    const chatId = cq.message?.chat?.id;
    const userId = cq.from?.id;
    const who = whoOf(cq.from);
    const ack = (text, alert) => tgApi('answerCallbackQuery', {
      callback_query_id: cq.id, ...(text ? { text } : {}), ...(alert ? { show_alert: true } : {}) });
    /* ⚠️ กดปุ่มมาจาก "การ์ดใบแจ้งซ่อม" ที่เป็นรูป → แก้ทับเป็นข้อความไม่ได้
       (Telegram: editMessageText กับข้อความที่ไม่มีข้อความ = error) และถึงแก้ได้ก็ไม่ควร —
       การ์ดที่ปักไว้ในกลุ่มจะกลายเป็นเมนูไป ทีมช่างหาใบงานไม่เจอ
       → ส่งข้อความใหม่แทน ปล่อยการ์ดเดิมคาที่ (ครอบทุกปุ่มนำทางที่โผล่บนการ์ดได้) */
    const show = async (kb, note) => {
      if (cq.message?.photo) {
        await tgApi('sendMessage', { chat_id: chatId, text: kb.text, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: kb.keyboard } });
        await ack(note);
        return;
      }
      await tgApi('editMessageText', {
        chat_id: chatId, message_id: cq.message.message_id,
        text: kb.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb.keyboard } });
      await ack(note);
    };

    // ── นำทางกระดาน ──
    if (data === 'm:home') { await show(await buildMaintHome(date)); return true; }
    if (data === 'm:rep') { await show(await buildRepairList()); return true; }
    if (data === 'm:pm') { await show(await buildPmList(date)); return true; }
    if (data === 'm:rt') { await show(await buildRoutineBoard(date, 'person')); return true; }
    if (data === 'm:rtx') { await show(await buildRoutineBoard(date, 'machine')); return true; }
    if (data === 'm:mat') { await show(await buildMatList()); return true; }
    // 🔄 อัปเดต ใต้สรุปงานตามหน้าที่ — เขียนทับข้อความเดิม ไม่โพสต์สรุปใหม่ให้รก
    if (data === 'm:sum') {
      const by = (await techOf(userId))?.name || who.name || null;
      await show(await buildMaintDutyText(await buildDuty(date, { maint: true }), { by }), 'อัปเดตแล้ว 🔄');
      return true;
    }

    // ── ผูกบัญชีช่าง ──
    if (data === 'm:bind') {
      const rows = await maintTeamRows();
      const kb = rows.filter(r => !r.tg_user_id)
        .map(r => [{ text: clip(`🔧 ${r.name}`), callback_data: `m:bind:${r.person_key}` }]);
      kb.push([{ text: '⬅️ กลับ', callback_data: 'm:home' }]);
      await show({
        text: '🔧 <b>ผูกบัญชีช่าง</b>\n\nเลือกชื่อของคุณ — หลังผูกแล้วจะกดปุ่มรับงาน/ปิดงานได้\n\n'
          + '<i>ผูกได้คนละครั้ง ถ้าผูกผิดให้แก้ในหน้า Admin</i>', keyboard: kb });
      return true;
    }
    if (data.startsWith('m:bind:')) {
      const key = data.slice(7);
      const rows = await maintTeamRows();
      const target = rows.find(r => r.person_key === key);
      if (!target) { await ack('ไม่พบชื่อนี้'); return true; }
      if (target.tg_user_id) { await ack('ชื่อนี้มีคนผูกไปแล้ว — แก้ได้ในหน้า Admin', true); return true; }
      await db.exec("UPDATE duty_people SET tg_user_id = ? WHERE person_key = ? AND kind = 'maint'", [String(userId), key]);
      await ack(`ผูกกับ ${target.name} แล้ว ✅`);
      await show(await buildMaintHome(date));
      return true;
    }

    // ── ใบแจ้งซ่อม ──
    if (data.startsWith('m:rep:')) {
      const row = await getIncident(Number(data.slice(6)));
      if (!row) { await ack('ไม่พบใบงานนี้'); return true; }
      await show(repairCard(row));
      return true;
    }
    if (data.startsWith('m:hist:')) { await show(await buildMachineHistory(Number(data.slice(7)))); return true; }

    // ── เติมสาเหตุ/วิธีแก้ที่ยังขาด ──
    if (data === 'm:gap') { await show(await buildGapList()); return true; }
    if (data.startsWith('m:gapf:')) {
      const tech = await requireTech(cq); if (!tech) return true;
      const id = Number(data.slice(7));
      const row = await getIncident(id);
      if (!row) { await ack('ไม่พบใบงานนี้'); return true; }
      if (row.cause && row.fix) { await ack('ใบนี้มีครบแล้ว ✅'); await show(await buildGapList()); return true; }
      const step = row.cause ? 'fix' : 'cause';
      await setMaintDraft(chatId, userId, { kind: 'gap', refId: id, step, data: {} });
      await ack('พิมพ์ตอบได้เลย');
      await gapAsk(chatId, who, row, step);
      return true;
    }

    if (data.startsWith('m:take:')) {
      const tech = await requireTech(cq); if (!tech) return true;
      const id = Number(data.slice(7));
      const row = await getIncident(id);
      if (!row) { await ack('ไม่พบใบงานนี้'); return true; }
      if ((row.status || 'open') !== 'open') { await ack(`ใบนี้ ${srStatus(row.status).label} อยู่แล้ว`); return true; }
      await db.exec('UPDATE incidents SET status = ?, assignee = ?, updated_at = ? WHERE id = ?',
        ['wip', tech.person_key, nowBKK(), id]);
      const fresh = await getIncident(id);
      // กดจากการ์ดที่ปักไว้เอง = เด้งการ์ดใบนั้นในที่พอ · กดจากที่อื่น = ตอบตรงนั้นแล้วค่อยเด้งการ์ด
      if (String(cq.message.message_id) === String(fresh.card_msg_id || '')) {
        await refreshRepairCard(id);
        await ack('รับงานแล้ว 🔧');
      } else {
        await show(repairCard(fresh), 'รับงานแล้ว 🔧');
        await refreshRepairCard(id);
      }
      return true;
    }

    if (data.startsWith('m:close:')) {
      const tech = await requireTech(cq); if (!tech) return true;
      const id = Number(data.slice(8));
      const row = await getIncident(id);
      if (!row) { await ack('ไม่พบใบงานนี้'); return true; }
      await setMaintDraft(chatId, userId, { kind: 'close', refId: id, step: 'fix', data: { images: [] } });
      await ack('ปิดงาน — ตอบคำถามต่อได้เลย');
      await askText(chatId, who,
        `✅ <b>ปิดงาน #${id}</b> — ${escapeHtml(row.title || '')}\n\n🔧 <b>แก้ยังไงครับ?</b> พิมพ์สั้น ๆ พอ\n\n<i>พิมพ์ “ยกเลิก” เพื่อเลิก</i>`,
        'วิธีแก้…');
      return true;
    }
    if (data === 'm:ccancel') { await clearMaintDraft(chatId, userId); await ack('ยกเลิกแล้ว'); await show(await buildMaintHome(date)); return true; }
    if (data === 'm:csave') {
      const tech = await requireTech(cq); if (!tech) return true;
      const draft = await getMaintDraft(chatId, userId);
      if (!draft || draft.kind !== 'close') { await ack('ร่างหมดอายุแล้ว'); return true; }
      const id = draft.ref_id;
      const row = await getIncident(id);
      if (!row) { await clearMaintDraft(chatId, userId); await ack('ไม่พบใบงานนี้'); return true; }
      // เครื่องที่ยังหยุดอยู่ → ปิดเวลาหยุด ณ ตอนกดปิดงาน (แก้เวลาย้อนหลังได้ในแอป)
      const downTo = row.down_from && !row.down_to ? nowBKK().slice(0, 16) : row.down_to;
      await db.exec(
        'UPDATE incidents SET status = ?, fix = ?, result_images = ?, down_to = ?, updated_at = ? WHERE id = ?',
        ['closed', draft.data.fix || null, photoJson(draft.data.images || []), downTo, nowBKK(), id]);
      await clearMaintDraft(chatId, userId);
      const fresh = await getIncident(id);
      try {
        const sync = await syncIncident(fresh);
        if (sync.path) await db.exec('UPDATE incidents SET vault_path = ? WHERE id = ?', [sync.path, id]);
      } catch { /* เขียนโน้ตไม่ได้ก็ไม่บล็อกการปิดงาน */ }
      touchMachineNote(fresh.machine);
      await ack('ปิดงานแล้ว ✅');
      await refreshRepairCard(id);
      await postLessonCard(id);
      // งานที่แก้เฉพาะหน้า มักต้องตามด้วยงานจริงทีหลัง — ถามเลยตอนที่ยังนึกออก
      await tgApi('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `✅ <b>ปิดงาน #${id} แล้ว</b>\n\nต้องตั้งงาน PM ตามต่อไหมครับ? (เช่นแก้เฉพาะหน้าไปก่อน เดี๋ยวเปลี่ยนอะไหล่จริง)`,
        reply_markup: { inline_keyboard: [
          [{ text: '🗓 ตั้งงาน PM ตามต่อ', callback_data: `mpm:from:${id}` }],
          [{ text: '👍 ไม่ต้อง จบเลย', callback_data: 'm:home' }]] },
      });
      return true;
    }

    // ── งาน PM ──
    if (data.startsWith('m:pmv:')) { await show(await buildPmView(Number(data.slice(6)), date)); return true; }
    if (data.startsWith('m:pmdone:')) {
      const tech = await requireTech(cq); if (!tech) return true;
      const id = Number(data.slice(9));
      await markPmDone(id, tech.name);   // ปิดงาน + ขยับ "PM ล่าสุด" ของเครื่องนั้นในทะเบียน
      await show(await buildPmList(date), 'ปิดงาน PM แล้ว ✅');
      return true;
    }

    // ── งานรูทีน ──
    if (data.startsWith('m:rtm:')) { await show(await buildRoutineMachine(Number(data.slice(6)), date)); return true; }
    if (data.startsWith('m:rtp:')) { await show(await buildRoutinePerson(Number(data.slice(6)), date)); return true; }
    if (data.startsWith('m:rtt:')) {
      const tech = await requireTech(cq); if (!tech) return true;
      let rest = data.slice(6);
      // ธงมุมที่กดมา P/M — ตัวพิมพ์ใหญ่จึงไม่มีวันชนกับ person_key (slugKey คืนตัวพิมพ์เล็กเสมอ)
      // ปุ่มรุ่นเก่าที่ยังค้างอยู่ในแชทไม่มีธง → ถือเป็นมุมเครื่องแบบเดิม กดแล้วต้องไม่พัง
      let view = 'machine';
      if (rest.startsWith('P:') || rest.startsWith('M:')) { view = rest[0] === 'P' ? 'person' : 'machine'; rest = rest.slice(2); }
      const owner = rest.slice(0, rest.indexOf(':'));
      const nodeKey = rest.slice(rest.indexOf(':') + 1);
      await toggleRoutineDone(owner, nodeKey, date);
      const due = await dueRoutines(date);
      if (view === 'person') {
        const idx = (await ownerListOf(due)).indexOf(owner);
        await show(idx >= 0 ? await buildRoutinePerson(idx, date) : await buildRoutineBoard(date, 'person'), 'อัปเดตแล้ว ✅');
      } else {
        const hit = due.find(r => r.owner === owner && r.key === nodeKey);
        const idx = machineListOf(due).indexOf(hit ? hit.machine : '');
        await show(idx >= 0 ? await buildRoutineMachine(idx, date) : await buildRoutineBoard(date, 'machine'), 'อัปเดตแล้ว ✅');
      }
      return true;
    }

    // ── wizard ตั้งงาน PM ──
    if (data === 'mpm:new' || data.startsWith('mpm:from:')) {
      const tech = await requireTech(cq); if (!tech) return true;
      const from = data.startsWith('mpm:from:') ? await getIncident(Number(data.slice(9))) : null;
      const d = await setMaintDraft(chatId, userId, {
        kind: 'pm', refId: from ? from.id : null,
        step: from && from.machine ? 'title' : 'machine',
        data: { images: [], ...(from && from.machine ? { machine: from.machine } : {}) },
      });
      await ack('ตั้งงาน PM');
      await pmAsk(chatId, d, who);
      return true;
    }
    if (data === 'mpm:cancel') { await clearMaintDraft(chatId, userId); await ack('ยกเลิกแล้ว'); return true; }
    if (data.startsWith('mpm:')) {
      const tech = await requireTech(cq); if (!tech) return true;
      const draft = await getMaintDraft(chatId, userId);
      if (!draft || draft.kind !== 'pm') { await ack('ร่างหมดอายุแล้ว กด "➕ ตั้งงาน PM ใหม่" อีกครั้ง'); return true; }
      const step = (patch) => setMaintDraft(chatId, userId, patch);
      if (data.startsWith('mpm:m:')) {
        const { names } = await machineKeyboardFor('mpm');
        const pick = names[Number(data.slice(6))] || '';
        await ack(pick || 'เลือกแล้ว');
        await pmAsk(chatId, await step({ step: 'title', data: { machine: pick } }), who); return true;
      }
      if (data === 'mpm:mskip') { await ack('ไม่ระบุเครื่อง'); await pmAsk(chatId, await step({ step: 'title', data: { machine: '' } }), who); return true; }
      if (data === 'mpm:mtype') { await ack(); await pmAsk(chatId, await step({ step: 'mtype' }), who); return true; }
      if (data.startsWith('mpm:k:')) { await ack(); await pmAsk(chatId, await step({ step: 'date', data: { kind: data.slice(6) } }), who); return true; }
      if (data === 'mpm:dtype') { await ack(); await pmAsk(chatId, await step({ step: 'dtype' }), who); return true; }
      if (data.startsWith('mpm:d:')) { await ack(); await pmAsk(chatId, await step({ step: 'remind', data: { date: pmDateOf(data.slice(6)) } }), who); return true; }
      if (data.startsWith('mpm:r:')) {
        const d2 = await step({ step: 'save', data: { remind: data.slice(6) } });
        const saved = await savePmTask(d2.data, tech.person_key);
        await clearMaintDraft(chatId, userId);
        await ack('ตั้งงาน PM แล้ว ✅');
        await tgApi('sendMessage', {
          chat_id: chatId, parse_mode: 'HTML',
          text: `🗓 <b>ตั้งงาน PM แล้ว</b>\n📌 ${escapeHtml(saved.title)}\n`
            + (d2.data.machine ? `🔩 ${escapeHtml(d2.data.machine)}\n` : '')
            + `📅 ${thaiDate(saved.date)}${saved.remindAt ? `\n🔔 เตือน ${saved.remindAt.replace('T', ' ')} น.` : ''}`,
          reply_markup: { inline_keyboard: [[{ text: '🗓 ดูงาน PM ทั้งหมด', callback_data: 'm:pm' }]] },
        });
        return true;
      }
      await ack(); return true;
    }
    return false;
  }

  // ═══ รูปที่ส่งเข้ามาระหว่างปิดงาน ═══
  if (upd.message?.photo?.length) {
    const chatId = upd.message.chat?.id, userId = upd.message.from?.id;
    const draft = await getMaintDraft(chatId, userId);
    if (!draft || draft.kind !== 'close' || draft.step !== 'photo') return false;
    const best = upd.message.photo[upd.message.photo.length - 1];
    const url = await downloadTelegramFile(best.file_id);
    if (!url || !url.startsWith('http')) {
      await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ เก็บรูปไม่สำเร็จ — กดปิดงานโดยไม่มีรูปไปก่อนได้' });
      return true;
    }
    const imgs = [...(draft.data.images || []), url].slice(-8);
    await setMaintDraft(chatId, userId, { data: { images: imgs } });
    await tgApi('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `📸 รับรูปหลังซ่อมแล้ว (${imgs.length} รูป) — ส่งเพิ่มได้ หรือกดปิดงาน`,
      reply_markup: { inline_keyboard: [
        [{ text: '✅ ปิดงานเลย', callback_data: 'm:csave' }],
        [{ text: '✕ ยกเลิก', callback_data: 'm:ccancel' }]] },
    });
    return true;
  }

  // ═══ ข้อความ ═══
  const text = (upd.message?.text || '').trim();
  if (!upd.message || !text) return false;
  const chatId = upd.message.chat?.id, userId = upd.message.from?.id;
  const who = whoOf(upd.message.from);

  // เปิดกระดาน — คำสั่งเดิมของบอทเก่าใช้ได้เหมือนกัน แต่ในกลุ่มนี้ต้องได้กระดานซ่อมบำรุง
  if (/^\/(start|menu|duty)\b/.test(text) || /^(เมนู|กระดาน)\s*$/.test(text)
      || /ปิดงาน|งานค้าง|เช็[กค]งาน|เช็[กค]\s*งาน|หน้าที่/.test(text)) {
    const kb = await buildMaintHome(date);
    await tgApi('sendMessage', { chat_id: chatId, text: kb.text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: kb.keyboard } });
    return true;
  }

  const draft = await getMaintDraft(chatId, userId);
  if (!draft) return false;                       // ไม่ได้คุยกับกระดานอยู่ → ปล่อยให้ของเดิมทำต่อ
  // ในกลุ่ม: นับเป็นคำตอบเฉพาะข้อความที่ตอบกลับบอท หรืออยู่ใน 5 นาทีแรก (กฎเดียวกับใบแจ้งซ่อม)
  const inGroup = /group/.test(upd.message.chat?.type || '');
  const repliedToBot = !!upd.message.reply_to_message?.from?.is_bot;
  const freshCut = new Date(Date.now() - 5 * 60000).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  if (inGroup && !repliedToBot && String(draft.created_at || '') < freshCut) return false;

  if (/^\/?(ยกเลิก|cancel)$/i.test(text)) {
    await clearMaintDraft(chatId, userId);
    await tgApi('sendMessage', { chat_id: chatId, text: '✕ ยกเลิกแล้ว' });
    return true;
  }

  /* เติมความรู้ใบเก่า — ถามทีละช่องที่ยังว่าง จบแล้วเด้งกระดานให้เติมใบถัดไปต่อได้เลย
     (คนที่ยอมเติมใบหนึ่ง มักเติมต่ออีก 2-3 ใบถ้าไม่ต้องเดินกลับไปหาเมนูเอง) */
  if (draft.kind === 'gap') {
    const id = draft.ref_id;
    const row = await getIncident(id);
    if (!row) { await clearMaintDraft(chatId, userId); await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ ไม่พบใบงานนี้แล้ว' }); return true; }
    if (draft.step === 'cause') {
      const fresh = await saveGapAnswer(id, { cause: text });
      if (fresh && !fresh.fix) {
        await setMaintDraft(chatId, userId, { step: 'fix' });
        await gapAsk(chatId, who, fresh, 'fix');
        return true;
      }
    } else {
      await saveGapAnswer(id, { fix: text });
    }
    await clearMaintDraft(chatId, userId);
    const kb = await buildGapList();
    await tgApi('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `✅ <b>บันทึกแล้ว — ใบ #${id} มีคำตอบครบแล้ว</b>\n\n${kb.text}`,
      reply_markup: { inline_keyboard: kb.keyboard },
    });
    return true;
  }

  if (draft.kind === 'close' && draft.step === 'fix') {
    await setMaintDraft(chatId, userId, { step: 'photo', data: { fix: text } });
    await tgApi('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: '📸 <b>ส่งรูปหลังซ่อมได้เลย</b> (จะส่งกี่รูปก็ได้)\nไม่มีรูปก็กดปิดงานได้เลย',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ ปิดงานเลย', callback_data: 'm:csave' }],
        [{ text: '✕ ยกเลิก', callback_data: 'm:ccancel' }]] },
    });
    return true;
  }
  if (draft.kind === 'pm') {
    if (draft.step === 'mtype') { await pmAsk(chatId, await setMaintDraft(chatId, userId, { step: 'title', data: { machine: text } }), who); return true; }
    if (draft.step === 'title') { await pmAsk(chatId, await setMaintDraft(chatId, userId, { step: 'kind', data: { title: text } }), who); return true; }
    if (draft.step === 'dtype') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ รูปแบบวันที่ต้องเป็น 2026-09-01 ลองใหม่อีกทีครับ' });
        return true;
      }
      await pmAsk(chatId, await setMaintDraft(chatId, userId, { step: 'remind', data: { date: text } }), who);
      return true;
    }
  }
  return false;
}

/* เนื้อในของกระดานงาน/wizard แจ้งเหตุการณ์ — ใช้ร่วมกัน 2 ทางเข้า:
     · /api/telegram/duty-update  = บอทเดิม (n8n เป็นเจ้าของ webhook แล้ว forward ผ่าน Duty Gate มา)
     · /api/telegram/maint-update = บอทซ่อมบำรุง (แอปเป็นเจ้าของ webhook เอง ข้อความมาถึงตรง ๆ)
   ตัวส่ง Telegram ข้างในอ่าน "บอทที่กำลังคุยอยู่" จากบริบทเอง จึงตอบกลับถูกบอทเสมอ            */
async function handleDutyUpdate(upd) {
  {   // บล็อกเปล่า: คงระดับย่อหน้าเดิมของโค้ดข้างในไว้ ดิฟตอนแยกบอทจะได้ไม่บวมทั้งฟังก์ชัน
    try {
      // บอทซ่อมบำรุง: กระดานใหม่ขอจัดการก่อน — อะไรที่มันไม่รับ (wizard แจ้งซ่อม ปุ่มติ๊กงานประจำ
      // การรับรูปงานมอบหมาย) ค่อยตกมาที่ของเดิมข้างล่าง ไม่ต้องเขียนซ้ำ
      if (onMaintBot() && await handleMaintUpdate(upd)) return;
      const date = workDayBKK();
      if (upd.callback_query) {
        const cq = upd.callback_query;
        const data = cq.data || '';
        // ── แจ้งเหตุการณ์ (wizard) ──
        if (data.startsWith('inc:')) {
          const chatId = cq.message?.chat?.id, userId = cq.from?.id;
          const ack = (text) => tgApi('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) });
          const who = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ');
          if (data === 'inc:new') {
            await clearIncDraft(chatId, userId);
            const d = await setIncDraft(chatId, userId, { step: 'title', operator: who });
            await ack('แจ้งเหตุการณ์'); await incAsk(chatId, d, { userId, name: who });
            return;
          }
          if (data === 'inc:cancel') {
            await clearIncDraft(chatId, userId); await ack('ยกเลิกแล้ว');
            await tgApi('sendMessage', { chat_id: chatId, text: '✕ ยกเลิกการแจ้งเหตุการณ์แล้ว' });
            return;
          }
          const draft = await getIncDraft(chatId, userId);
          // ชื่อปุ่มต่างกันตามบอท — บอทซ่อมบำรุงเรียก "แจ้งซ่อม" (บอทผลิตไม่มีปุ่มนี้แล้ว)
          if (!draft) { await ack(`ร่างหมดอายุแล้ว กด "${onMaintBot() ? '🆘 แจ้งซ่อม' : '⚡ แจ้งเหตุการณ์'}" ใหม่`); return; }
          if (data.startsWith('inc:m:')) {
            const { names } = await incMachineKeyboard();
            const pick = names[Number(data.slice(6))] || '';
            const d = await setIncDraft(chatId, userId, { machine: pick, step: stepAfterMachine() });
            await ack(pick || 'เลือกแล้ว'); await incAsk(chatId, d, { userId, name: who });
            return;
          }
          if (data === 'inc:mskip') {
            const d = await setIncDraft(chatId, userId, { machine: '', step: stepAfterMachine() });
            await ack('ไม่ระบุเครื่อง'); await incAsk(chatId, d, { userId, name: who }); return;
          }
          if (data === 'inc:mtype') {
            const d = await setIncDraft(chatId, userId, { step: 'mtype' });
            await ack(); await incAsk(chatId, d, { userId, name: who }); return;
          }
          if (data.startsWith('inc:p:')) {
            const pk = data.slice(6);
            const d = await setIncDraft(chatId, userId, { priority: SR_PRIO[pk] ? pk : 'warn', step: 'symptom' });
            await ack(srPrio(pk).label); await incAsk(chatId, d, { userId, name: who }); return;
          }
          if (data === 'inc:nosym') {
            const d = await setIncDraft(chatId, userId, { symptom: '', step: 'photo' });
            await ack(); await incAsk(chatId, d, { userId, name: who }); return;
          }
          if (data === 'inc:save') {
            const imgs = parseImgs(draft.images);
            /* "หยุดไลน์" = เริ่มจับเวลาเครื่องหยุดตั้งแต่วินาทีที่แจ้ง ไม่ต้องให้ใครมากรอกเวลาเอง
               (ปิดงานเมื่อไหร่ระบบเติม down_to ให้ → ได้นาทีที่เสียจริง แก้ย้อนหลังได้ในแอป) */
            const saved = await createIncidentRow({
              title: draft.title, machine: draft.machine, symptom: draft.symptom,
              images: imgs, operator: draft.operator || who,
              priority: draft.priority || null,
              downFrom: draft.priority === 'stop' ? nowBKK().slice(0, 16) : null,
            });
            await clearIncDraft(chatId, userId);
            await ack('บันทึกแล้ว ✅');
            // กลุ่มซ่อมบำรุง: โพสต์เป็น "การ์ดใบงาน" ที่อัปเดตสถานะตัวเองได้ แทนข้อความยืนยันเฉย ๆ
            if (onMaintBot()) { await postRepairCard(saved.id, chatId); return; }
            await tgApi('sendMessage', {
              chat_id: chatId, parse_mode: 'HTML',
              text: `✅ <b>บันทึกเหตุการณ์แล้ว</b>\n⚡ ${escapeHtml(draft.title)}`
                + (draft.machine ? `\n🔩 ${escapeHtml(draft.machine)}` : '')
                + (imgs.length ? `\n📸 แนบรูป ${imgs.length} รูป` : '')
                + (saved.vaultPath ? `\n📓 เขียนโน้ตไว้ที่ <code>${escapeHtml(saved.vaultPath)}</code>` : '')
                + (saved.vaultError ? `\n⚠️ เขียนโน้ตไม่สำเร็จ: ${escapeHtml(saved.vaultError)}` : '')
                + `\n\nไปเติมสาเหตุ/วิธีแก้/เวลาเครื่องหยุดต่อได้ที่หน้า <b>เหตุการณ์</b> ในเว็บ`,
            });
            return;
          }
          await ack();
          return;
        }
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
          if (kind === 'v') {                            // 🖼 ดูรูปงานมอบหมาย (จุดที่ต้องไปทำ)
            const taskId = Number(parts[3]);
            const chatId = cq.message?.chat?.id;
            const trow = (await dbAll('SELECT title, location, images FROM daily_tasks WHERE id = ?', [taskId]))[0];
            const imgs = parseImgs(trow?.images);
            if (!imgs.length) { await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'งานนี้ไม่มีรูปแนบ' }); return; }
            const cap = `🖼 <b>${escapeHtml(trow?.title || '')}</b>${trow?.location ? `\n📍 ${escapeHtml(trow.location)}` : ''}`
              + (imgs.length > 1 ? `\n(${imgs.length} รูป)` : '');
            for (let i = 0; i < Math.min(imgs.length, 3); i++) await sendPhotoToChat(chatId, imgs[i], i === 0 ? cap : '');
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'ส่งรูปงานให้แล้ว 🖼' });
            return;
          }
          if (kind === 'rv') {                           // 🖼 ดูรูปอ้างอิงของงานประจำ
            const owner = parts[3], nodeKey = parts.slice(4).join(':');
            const chatId = cq.message?.chat?.id;
            const duty0 = await buildDuty(date, { audit: isAuditKey(page) });
            const node = (duty0.people.find(x => x.key === owner)?.nodes || []).find(n => n.key === nodeKey);
            const rrow = node?.id != null ? (await dbAll('SELECT ref_image FROM duty_routines WHERE id = ?', [node.id]))[0] : null;
            if (!rrow?.ref_image) { await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'ยังไม่ได้ตั้งรูปอ้างอิง' }); return; }
            await sendPhotoToChat(chatId, rrow.ref_image, `🖼 <b>${escapeHtml(node?.title || nodeKey)}</b>\n<i>รูปอ้างอิง — ทำให้ได้แบบนี้</i>`);
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'ส่งรูปอ้างอิงให้แล้ว 🖼' });
            return;
          }
          if (kind === 'x') {                            // ✖️ ออกจากโหมดถ่ายรูป (งานยังเปิด รูปที่ถ่ายไปแล้วไม่หาย)
            await clearPhotoWait(cq.message?.chat?.id, cq.from?.id);
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'ยกเลิกการถ่ายรูปแล้ว' });
            return;
          }
          if (kind === 'img') {                          // กด 📸 → เริ่มถ่ายทีละรูปตามรายการ
            const taskId = Number(parts[3]);
            const chatId = cq.message?.chat?.id, userId = cq.from?.id;
            const trow = (await dbAll('SELECT title, location, images, done_images, photo_specs FROM daily_tasks WHERE id = ?', [taskId]))[0];
            await setPhotoWait(chatId, userId, taskId, page);
            // 1) โชว์รูปก่อนทำ "ของจุดที่กำลังจะถ่าย" ให้ดูเทียบ
            await sendSpotReference(chatId, trow);
            // 2) ขอรูปใบถัดไปตามรายการ
            await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'HTML', ...askNextPhoto(trow, taskId, page) });
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'ถ่ายรูปได้เลย 📸' });
            return;
          }
          if (kind === 'ri') {                           // กด 📸 บนงานประจำ → รอรับรูปหลังทำของหัวข้อนี้
            const owner = parts[3], nodeKey = parts.slice(4).join(':');
            const chatId = cq.message?.chat?.id, userId = cq.from?.id;
            const duty0 = await buildDuty(date, { audit: isAuditKey(page) });
            const node = (duty0.people.find(x => x.key === owner)?.nodes || []).find(n => n.key === nodeKey);
            await setPhotoWait(chatId, userId, null, page, owner, nodeKey);
            await tgApi('sendMessage', {
              chat_id: chatId, parse_mode: 'HTML',
              text: `📸 ส่งรูป <b>หลังทำ</b> ของ "${escapeHtml(node?.title || nodeKey)}" เข้ามาได้เลย\n`
                + `(ถ่ายใหม่หรือเลือกจากคลังก็ได้ · ส่งรูปเดียว)\n\n`
                + `<i>พอส่งรูปปุ๊บ ระบบจะติ๊กเสร็จให้ แล้วส่งการ์ดก่อน/หลังเข้ากลุ่มทันที</i>`,
            });
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'ส่งรูปเข้ามาได้เลย 📸' });
            return;
          }
          if (kind === 'done') {                         // ปุ่มเก่าจากข้อความก่อนอัปเดต — บอกให้ถ่ายให้ครบแทน
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'ตอนนี้ถ่ายให้ครบรายการแล้วระบบจะปิดงานให้เอง', show_alert: true });
            return;
          }
          if (kind === 'a') { await toggleAdhocDone(Number(parts[3])); note = 'อัปเดตแล้ว ✅'; }
          else if (kind === 'r') { await toggleRoutineDone(parts[3], parts.slice(4).join(':'), date); note = 'อัปเดตแล้ว ✅'; }
          kb = buildDutyPerson(await buildDuty(date, { audit: isAuditKey(page) }), page);
        } else if (data.startsWith('p:')) {              // นำทาง: home / หน้าคน / บอร์ดใบตรวจ
          const target = data.slice(2);
          if (target === 'audithome') kb = buildAuditHome(await buildDuty(date, { audit: true }));
          else if (isAuditKey(target)) kb = buildDutyPerson(await buildDuty(date, { audit: true }), target);
          else {
            const duty = await buildDuty(date);
            kb = target === 'home' ? buildDutyHome(duty, await countAuditOpen()) : buildDutyPerson(duty, target);
          }
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
      // รับรูป "หลังทำ" — เฉพาะผู้ใช้ที่กด 📸 ค้างไว้ (มี wait row)
      if (upd.message?.photo?.length) {
        const chatId = upd.message.chat?.id, userId = upd.message.from?.id;
        // กำลังแจ้งเหตุการณ์อยู่ = รูปนี้เป็นของเหตุการณ์ ไม่ใช่รูปงานประจำ (เช็กก่อนเสมอ)
        const incD = await getIncDraft(chatId, userId);
        if (incD && incD.step === 'photo') {
          const best0 = upd.message.photo[upd.message.photo.length - 1];
          const url = await downloadTelegramFile(best0.file_id);
          // incidents รับเฉพาะ URL — ถ้าไม่มี Supabase จะได้ base64 กลับมา ซึ่งลง DB ไม่ได้
          if (!url || !url.startsWith('http')) {
            await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ เก็บรูปไม่สำเร็จ (ที่เก็บไฟล์ไม่พร้อม) — กดบันทึกโดยไม่มีรูปไปก่อนได้' });
            return;
          }
          const imgs = [...parseImgs(incD.images), url].slice(-8);
          await setIncDraft(chatId, userId, { images: JSON.stringify(imgs) });
          await tgApi('sendMessage', {
            chat_id: chatId, parse_mode: 'HTML',
            text: `📸 รับรูปแล้ว (${imgs.length} รูป) — ส่งเพิ่มได้ หรือกดบันทึก`,
            reply_markup: { inline_keyboard: [
              [{ text: '✅ บันทึกเหตุการณ์', callback_data: 'inc:save' }],
              [{ text: '✕ ยกเลิก', callback_data: 'inc:cancel' }]] },
          });
          return;
        }
        const wait = await getPhotoWait(chatId, userId);
        if (!wait) return; // ไม่ได้ขอแนบรูปไว้ → ปล่อยผ่าน (ไม่ยุ่งรูปทั่วไปในกลุ่ม)
        const best = upd.message.photo[upd.message.photo.length - 1]; // ความละเอียดสูงสุด
        const dataUrl = await downloadTelegramFile(best.file_id);
        if (!dataUrl) return;
        // งานประจำ: รับรูป → ติ๊กเสร็จ + ส่งการ์ดก่อน/หลังทันที (ไม่ต้องกดปิดงานซ้ำ)
        if (wait.node_key) {
          const owner = wait.node_owner, nodeKey = wait.node_key;
          const duty0 = await buildDuty(date, { audit: isAuditKey(wait.page) });
          const node = (duty0.people.find(x => x.key === owner)?.nodes || []).find(n => n.key === nodeKey);
          const ts = nowBKK();
          await db.exec(
            `INSERT INTO routine_state (state_date, assignee, node_key, title, checked, done_image, done_image_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT(state_date, assignee, node_key)
             DO UPDATE SET checked = 1, done_image = excluded.done_image, done_image_at = excluded.done_image_at,
                           title = COALESCE(excluded.title, routine_state.title), updated_at = excluded.updated_at`,
            [date, owner, nodeKey, node?.title || null, dataUrl, ts, ts]);
          await clearPhotoWait(chatId, userId);
          await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
            text: `✅ รับรูปแล้ว — ติ๊ก "<b>${escapeHtml(node?.title || nodeKey)}</b>" เสร็จ กำลังส่งรายงานเข้ากลุ่ม…` });
          await sendRoutineDoneCard({ date, assignee: owner, nodeKey, title: node?.title,
            doneImage: dataUrl, routineId: node?.id, operator: upd.message.from?.first_name || '' });
          return;
        }
        // งานมอบหมาย: เก็บรูปตามรายการที่คนมอบงานกำหนด — ครบเมื่อไหร่ = ปิดงาน (ไม่เดาเวลาแล้ว)
        const trow = (await dbAll('SELECT title, location, images, done_images, photo_specs FROM daily_tasks WHERE id = ?', [wait.task_id]))[0];
        const trowImages = trow?.images;   // เก็บไว้ส่งต่อให้ sendSpotReference หารูปก่อนทำของจุดถัดไป
        const specs = parsePhotoSpecs(trow?.photo_specs);
        let imgs = parseImgs(trow?.done_images);
        imgs.push(dataUrl); imgs = imgs.slice(-10);
        const who = upd.message.from?.first_name || '';
        await db.exec('UPDATE daily_tasks SET done_images = ?, done_by = ? WHERE id = ?', [JSON.stringify(imgs), who, wait.task_id]);
        if (imgs.length >= specs.length) {
          await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
            text: `✅ ครบ ${specs.length} รูปแล้ว — ปิดงาน "<b>${escapeHtml(trow?.title || '')}</b>" กำลังส่งรายงานเข้ากลุ่ม…` });
          await finishAdhocWithPhotos(chatId, userId, wait.task_id, who);
        } else {
          // ยังไม่ครบ → โชว์รูปก่อนทำของจุดถัดไป แล้วขอรูปใบถัดไป
          const next = { ...trow, done_images: JSON.stringify(imgs), images: trowImages, location: trow?.location };
          await sendSpotReference(chatId, next);
          await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
            ...askNextPhoto(next, wait.task_id, wait.page) });
        }
        return;
      }
      const text = upd.message?.text || '';
      // ── กำลังกรอกเหตุการณ์อยู่ → ข้อความถัดไปคือคำตอบของขั้นนั้น ──
      if (upd.message && text) {
        const chatId = upd.message.chat?.id, userId = upd.message.from?.id;
        const who = [upd.message.from?.first_name, upd.message.from?.last_name].filter(Boolean).join(' ');
        if (/^\/?(ยกเลิก|cancel)$/i.test(text.trim())) {
          const d0 = await getIncDraft(chatId, userId);
          if (d0) {
            await clearIncDraft(chatId, userId);
            await tgApi('sendMessage', { chat_id: chatId, text: '✕ ยกเลิกการแจ้งเหตุการณ์แล้ว' });
            return;
          }
        }
        // "แจ้งเหตุ ปั๊มรั่ว" = ใส่หัวข้อมาในบรรทัดเดียวเลย ไม่ต้องถามซ้ำ
        const m = text.trim().match(/^\/?(?:แจ้งซ่อม|แจ้งเหตุ(?:การณ์)?|เหตุการณ์|incident)\s*(.*)$/i);
        if (m) {
          await clearIncDraft(chatId, userId);
          const title = (m[1] || '').trim();
          const d = await setIncDraft(chatId, userId, title
            ? { step: 'machine', title, operator: who }
            : { step: 'title', operator: who });
          await incAsk(chatId, d, { userId, name: who, replyTo: upd.message.message_id });
          return;
        }
        const draft = await getIncDraft(chatId, userId);
        /* ⚠️ ในกลุ่ม: ห้ามดูดข้อความทั่วไปเข้าร่างเหตุการณ์
           บอทซ่อมบำรุงเป็นเจ้าของ webhook เอง = เห็นทุกข้อความในกลุ่ม (ไม่มี Duty Gate กรองให้แล้ว)
           คนตั้งเรื่องค้างไว้แล้วคุยงานอื่นต่อ ข้อความจะกลายเป็น "อาการ" ของเหตุการณ์ทันที
           กติกา: นับเป็นคำตอบเมื่อ = แชทเดี่ยว · หรือกดตอบกลับคำถามของบอท (force_reply เด้งช่องให้อยู่แล้ว)
                  · หรือยังอยู่ในช่วง 5 นาทีแรก (เผื่อ force_reply ไม่ติด คนพิมพ์ตอบตรง ๆ)            */
        const inGroup = /group/.test(upd.message.chat?.type || '');
        const repliedToBot = !!upd.message.reply_to_message?.from?.is_bot;
        const freshCut = new Date(Date.now() - 5 * 60000).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
        const stillFresh = !!draft && String(draft.created_at || '') >= freshCut;
        if (draft && (!inGroup || repliedToBot || stillFresh)) {
          const asWho = { userId, name: who, replyTo: upd.message.message_id };
          if (draft.step === 'title') { await incAsk(chatId, await setIncDraft(chatId, userId, { title: text.trim(), step: 'machine' }), asWho); return; }
          if (draft.step === 'mtype') { await incAsk(chatId, await setIncDraft(chatId, userId, { machine: text.trim(), step: stepAfterMachine() }), asWho); return; }
          if (draft.step === 'symptom') {
            const sym = text.trim() === '-' ? '' : text.trim();   // "-" = ไม่มีรายละเอียดเพิ่ม
            await incAsk(chatId, await setIncDraft(chatId, userId, { symptom: sym, step: 'photo' }), asWho); return;
          }
          // step = photo แล้วพิมพ์ข้อความมา → เติมเป็นรายละเอียดเพิ่ม (คนมักพิมพ์ต่อ)
          if (draft.step === 'photo') {
            const more = [draft.symptom, text.trim()].filter(Boolean).join('\n');
            await setIncDraft(chatId, userId, { symptom: more });
            await tgApi('sendMessage', { chat_id: chatId, text: '📝 เพิ่มรายละเอียดแล้ว — ส่งรูปต่อ หรือกดบันทึกได้เลย',
              reply_markup: { inline_keyboard: [
                [{ text: '✅ บันทึกเหตุการณ์', callback_data: 'inc:save' }],
                [{ text: '✕ ยกเลิก', callback_data: 'inc:cancel' }]] } });
            return;
          }
        }
      }
      if (/^\/(start|menu|duty)\b/.test(text.trim()) || /^เมนู\s*$/.test(text.trim())
          || /ปิดงาน|งานค้าง|เช็[กค]งาน|เช็[กค]\s*งาน|หน้าที่/.test(text)) {
        const kb = buildDutyHome(await buildDuty(date), await countAuditOpen());
        await tgApi('sendMessage', {
          chat_id: upd.message.chat.id, text: kb.text, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: kb.keyboard },
        });
      }
    } catch (e) { console.error('[duty-update] error', e); }
  }
}

// บอทเดิม — n8n forward มาให้ (ยังใช้อยู่จนกว่าจะถอด Duty Gate ออก)
app.post('/api/telegram/duty-update', (req, res) => {
  res.sendStatus(200);
  handleDutyUpdate(req.body || {});
});

// บอทซ่อมบำรุง — Telegram ยิงตรงมาที่นี่ ไม่ผ่าน n8n (ไม่มี Duty Gate มากรองให้แล้ว)
// กันคนลากบอทไปเข้ากลุ่มอื่นแล้วสั่งงานได้: กลุ่มอื่นที่ไม่ใช่ MAINT_TELEGRAM_CHAT_ID = ทิ้ง
// แชทเดี่ยวยังใช้ได้ (ช่างทักบอทตรง ๆ เพื่อแจ้งเหตุการณ์)
app.post('/api/telegram/maint-update', (req, res) => {
  res.sendStatus(200);
  const upd = req.body || {};
  const chat = upd.message?.chat || upd.callback_query?.message?.chat || {};
  const allow = String(process.env.MAINT_TELEGRAM_CHAT_ID || '');
  if (allow && /group|channel/.test(chat.type || '') && String(chat.id) !== allow) {
    console.log(`[maint bot] ข้ามข้อความจากกลุ่ม ${chat.id} (ไม่ใช่กลุ่มซ่อมบำรุง)`);
    return;
  }
  runAsBot('maint', () => handleDutyUpdate(upd));
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
    const seqByLine = {}; // ลำดับ batch ที่ผลิตจริง (distinct ตามเวลา) ต่อไลน์ → ใช้หา "รองสุดท้าย+สุดท้าย"
    for (const r of rows) {
      byLine[r.line_name] = { flavor: r.flavor || '', batch: r.batch || '', prodTime: r.timestamp };
      const seq = seqByLine[r.line_name] || (seqByLine[r.line_name] = []);
      const b = (r.batch || '').trim();
      if (b && seq[seq.length - 1] !== b) seq.push(b); // เก็บเฉพาะตอน batch เปลี่ยน
    }
    // recentBatches = 2 batch ล่าสุดที่ผลิต (index สุดท้าย = ใหม่สุด) — ให้ client เอาไปเติมถัง
    for (const ln in byLine) byLine[ln].recentBatches = (seqByLine[ln] || []).slice(-2);
    // เวลา CIP ล่าสุดต่อไลน์วันนี้ (Line 1 = ตารางแยก · Line 2/3 = cip_line2_sessions แยกด้วยคอลัมน์ line)
    const maxT = async (sql, p) => { const r = await dbAll(sql, p); return r[0] && r[0].t ? r[0].t : null; };
    const cip = {
      'Line 1': await maxT('SELECT MAX(created_at) AS t FROM cip_line1_sessions WHERE date = ? OR created_at LIKE ?', [date, like]),
      'Line 2': await maxT("SELECT MAX(created_at) AS t FROM cip_line2_sessions WHERE COALESCE(line,'Line 2') = 'Line 2' AND (date = ? OR created_at LIKE ?)", [date, like]),
      'Line 3': await maxT("SELECT MAX(created_at) AS t FROM cip_line2_sessions WHERE line = 'Line 3' AND (date = ? OR created_at LIKE ?)", [date, like]),
    };
    for (const ln of ['Line 1', 'Line 2', 'Line 3']) if (cip[ln]) { byLine[ln] = byLine[ln] || {}; byLine[ln].cipTime = cip[ln]; }
    // งานที่ยังไม่เสร็จของวันนั้น → เอาไปเป็นหมายเหตุ "ส่งต่อ" ในร่างส่งกะ (reuse pattern จาก buildShiftCardData)
    const backlog = await dbAll("SELECT line_name, category, title FROM daily_tasks WHERE task_date = ? AND status != 'done' ORDER BY category, line_name", [date]);
    res.json({ date, lines: byLine, backlog });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ดึงข้อมูลส่งกะครั้งล่าสุด (สำหรับปุ่ม "คัดลอกจากกะก่อน")
app.get('/api/handover/last', async (req, res) => {
  try {
    const rows = await dbAll('SELECT data FROM handover_notes WHERE data IS NOT NULL ORDER BY id DESC LIMIT 1', []);
    res.json({ data: rows[0] ? JSON.parse(rows[0].data) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Material balance (Phase 2): คืนข้อมูลดิบต่อไลน์ 1-3 ให้ client คำนวณ boxes เอง (client มี pkFactor) ──
// received = ถังจากรับกะของกะนี้ · produced = จำนวน batch distinct ที่ผลิตในช่วงเวลากะนี้
app.get('/api/handover/balance', async (req, res) => {
  const workDay = req.query.date || workDayBKK();
  const shiftKey = String(req.query.shift || '').replace(/^กะ/, ''); // "กะบ่าย" → "บ่าย"
  const LINES = ['Line 1', 'Line 2', 'Line 3'];
  try {
    // received: รับกะ (kind='in') ล่าสุดที่ตรง work_day+กะ — ถ้าไม่ระบุกะ เอาแถวล่าสุดของวันนั้น
    const inRows = await dbAll(
      "SELECT shift, data FROM handover_notes WHERE kind = 'in' AND note_date = ? AND data IS NOT NULL ORDER BY id DESC",
      [workDay]);
    const wantShift = shiftKey ? `กะ${shiftKey}` : null;
    const inRow = (wantShift && inRows.find(r => r.shift === wantShift)) || inRows[0] || null;
    let receivedLines = [];
    try { receivedLines = inRow ? (JSON.parse(inRow.data).lines || []) : []; } catch { receivedLines = []; }

    // produced: ช่วงเวลาของกะนี้ (กะดึก end<=start ข้ามเที่ยงคืน) → นับ batch distinct ต่อไลน์
    const shiftObj = factoryShiftsForWeekday(weekdayOf(workDay)).find(s => s.key === shiftKey);
    let batchesByLine = {};
    if (shiftObj) {
      const start = `${workDay}T${pad2(shiftObj.start)}:00:00`;
      const endDate = shiftObj.end <= shiftObj.start ? addDaysStr(workDay, 1) : workDay;
      const end = `${endDate}T${pad2(shiftObj.end)}:00:00`;
      const prodRows = await dbAll(
        'SELECT line_name, batch FROM production_logs WHERE timestamp >= ? AND timestamp < ? AND batch IS NOT NULL',
        [start, end]);
      for (const r of prodRows) {
        const b = String(r.batch || '').trim();
        if (!b) continue;
        (batchesByLine[r.line_name] || (batchesByLine[r.line_name] = new Set())).add(b);
      }
    }

    const lines = LINES.map((line, i) => {
      const rl = receivedLines[i] || {};
      const batches = batchesByLine[line] ? Array.from(batchesByLine[line]).sort() : [];
      return {
        line,
        receivedFlavor: rl.flavor || '',
        receivedTanks: Array.isArray(rl.tanks) ? rl.tanks : [],
        producedBatches: batches,
        producedCount: batches.length,
      };
    });
    res.json({ workDay, shift: wantShift || null, hasReceived: !!inRow, lines });
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
  { name: 'get_performance', description: 'เทียบประสิทธิภาพย้อนหลัง — % งานประจำรายคน · ยอดผลิต/รอบ CIP แยกตามกะ · เวลาที่ใช้ต่อรอบ CIP เทียบค่ากลาง · ใช้เมื่อถูกถามว่า "ใครทำได้ดี/ตกงานประจำ" "กะไหนผลิตได้มากสุด" "ล้างรอบนึงใช้เวลาเท่าไหร่"',
    input_schema: { type: 'object', properties: {
      from: { type: 'string', description: 'วันเริ่ม YYYY-MM-DD (ไม่ระบุ = 30 วันย้อนหลัง)' },
      to: { type: 'string', description: 'วันสิ้นสุด YYYY-MM-DD' } } } },
  { name: 'get_quality_history', description: 'วิเคราะห์คุณภาพย้อนหลัง — สรุปว่าช่วงนี้ค่าหลุดสเปกกี่ครั้ง รสไหน/ไลน์ไหนบ่อยสุด และค่าเลื่อนไปทางไหน (เทรนด์) · ใช้เมื่อถูกถามภาพรวมย้อนหลัง เช่น "เดือนนี้หลุดสเปกกี่ครั้ง" "รสไหนมีปัญหาบ่อย" "ค่า pH เลื่อนขึ้นไหม" — ต่างจาก get_quality ที่คืนค่าดิบทีละรายการ',
    input_schema: { type: 'object', properties: {
      from: { type: 'string', description: 'วันเริ่ม YYYY-MM-DD (ไม่ระบุ = 30 วันย้อนหลัง)' },
      to: { type: 'string', description: 'วันสิ้นสุด YYYY-MM-DD' },
      flavor: { type: 'string', description: 'เจาะจงรส (ถ้าต้องการ)' },
      line: { type: 'string', description: 'เจาะจง Line (ถ้าต้องการ)' } } } },
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
  // ── โหมดกรอกฟอร์มรับกะด้วย AI: ไม่เขียน DB แค่ส่งร่างข้อมูลกลับให้ client เติมฟอร์ม ──
  { name: 'fill_handover_form', description: 'แกะข้อความข้อมูลสถานะกะ (ที่ผู้ใช้วางเป็นข้อความอิสระ) ให้เป็นฟิลด์โครงสร้าง เพื่อเติมในฟอร์ม "รับกะ" ให้ผู้ใช้ตรวจสอบ/แก้ไข/กดส่งเอง — tool นี้ไม่บันทึกอะไรลงฐานข้อมูลทั้งสิ้น ไม่ต้องขอยืนยัน เรียกได้ทันทีเมื่ออยู่ในโหมดนี้ · หลักการสำคัญ: คัดลอกข้อความตามที่เขียนมาให้ตรงช่อง อย่าย่อ/ตัด/แต่งเติม ถ้าไม่มีข้อมูลปล่อยว่าง',
    input_schema: { type: 'object', properties: {
      shift: { type: 'string', enum: ['กะเช้า', 'กะบ่าย', 'กะดึก'] },
      lines: { type: 'array', minItems: 3, maxItems: 3, description: 'Line 1, Line 2, Line 3 ตามลำดับ — ฟิลด์ไหนไม่มีข้อมูลในข้อความให้ปล่อยว่างไว้ ห้ามเดา/แต่งเติม',
        items: { type: 'object', properties: {
          flavor: { type: 'string', description: 'รส/สถานะไลน์ ตามที่เขียนมา เช่น "FDS", "Freshy Green Apple", "CIP" — ไม่ต้องเติมคำ เช่นเห็น "Cip" ก็ใส่ "CIP" เฉยๆ อย่าเติม "ต่อ" เอง' },
          tanks: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: 'ข้อความสถานะถัง 1, 2, 3 ตามลำดับ คัดลอกมาแบบครบถ้วนคำต่อคำ — เช่น "ถัง 2 Batch C 100%" ให้ใส่ tanks[1]="Batch C 100%" (เก็บทั้งชื่อ Batch และปริมาณไว้ในถัง ห้ามตัด/ย้ายส่วนไหนออก) · ถังที่ว่าง/ไม่มีของ ใส่ "ว่าง" หรือเว้นว่าง (ระบบจะเดาช่อง Batch dropdown ให้เองจากข้อความถัง คุณไม่ต้องแยก)' },
          lotNo: { type: 'string' }, note: { type: 'string' },
        } } },
      line4: { type: 'object', description: 'Mixing 1, Mixer, Pasteurizer, Mixing 2, Storage, Filling',
        properties: {
          flavor: { type: 'string' },
          stages: { type: 'array', items: { type: 'string' }, minItems: 6, maxItems: 6, description: 'สถานะ 6 สเตจตามลำดับ: Mixing 1, Mixer, Pasteurizer, Mixing 2, Storage, Filling' },
          lotNo: { type: 'string' },
        } },
      note: { type: 'string', description: 'หมายเหตุรวม (ถ้ามี)' },
    }, required: ['shift', 'lines', 'line4'] } },
  // ── โหมดลงแผนผลิตด้วย AI: แกะข้อความแผนเป็นรายการเป้าผลิต ไม่เขียน DB (ส่งร่างให้ client ตรวจ/บันทึกเอง) ──
  { name: 'fill_production_plan', description: 'แกะข้อความ "แผนผลิต" ที่ผู้ใช้วางมา ให้เป็นรายการเป้าผลิตแบบโครงสร้าง เพื่อให้ผู้ใช้ตรวจ/แก้/บันทึกเอง — ไม่บันทึกลง DB ไม่ต้องขอยืนยัน เรียกได้ทันทีเมื่ออยู่ในโหมดนี้ · รูปแบบแต่ละรายการในแผน: "<สินค้า/รส> <สเปก> [<เครื่องบรรจุ>] = <เป้าBoxes>/<จำนวนคน>" เช่น "Syrup 1.8×8 [L1] =1200/7" · [L1]/[A3] คือหมายเลขเครื่องบรรจุ ไม่ใช่ Line ผลิต · แกะเฉพาะรายการที่มีเป้า Boxes (เลขก่อน /) ข้ามงานซัพพอร์ตที่เป็นแค่ "ชื่อ=จำนวนคน" (เช่น "ผู้ช่วยต้ม=2", "จัด Packaging =2") · ห้ามเดา/แต่งเลข เอาตามที่เขียนมา',
    input_schema: { type: 'object', properties: {
      shift: { type: 'string', enum: ['กะเช้า', 'กะบ่าย', 'กะดึก'], description: 'กะของแผน (จากหัวแผน เช่น 14.00-22.00=กะบ่าย, 18.00-06.00=กะดึก, 06.00-14.00=กะเช้า)' },
      items: { type: 'array', description: 'รายการเป้าผลิต — 1 รายการต่อ 1 สินค้า/รสที่มีเป้า Boxes',
        items: { type: 'object', properties: {
          flavor: { type: 'string', description: 'ชื่อสินค้า/รส ตามที่เขียนมา เช่น "Syrup", "Fast Dissolving", "Amazon", "Coconut Señorita"' },
          target_boxes: { type: 'integer', description: 'เป้า Boxes = เลขก่อนเครื่องหมาย / เช่น "=1200/7" → 1200' },
          staff: { type: 'integer', description: 'จำนวนคนที่จัดให้งานนี้ = เลขหลัง / เช่น "=1200/7" → 7' },
          machine_code: { type: 'string', description: 'หมายเลขเครื่องบรรจุในวงเล็บ เช่น "L1", "A3" (ถ้ามี) — เก็บอ้างอิงเฉยๆ' },
          spec: { type: 'string', description: 'สเปกบรรจุ เช่น "1.8×8", "800×12" (ถ้ามี) — เก็บอ้างอิงเฉยๆ' },
        }, required: ['flavor', 'target_boxes'] } },
    }, required: ['items'] } },
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
  if (name === 'get_performance') {
    const { from, to } = rangeFromQuery({ from: input.from, to: input.to });
    const r = await buildPerfSummary({ from, to });
    return {
      ...r,
      people: r.people.map(({ days, ...rest }) => rest),   // ตัดรายวันออก สรุปพอ
      cip: { ...r.cip, rounds: r.cip.rounds.slice(0, 20) },
      note: 'countedDays = วันที่มีคนใช้ระบบจริงเท่านั้น (วันเงียบไม่นับเป็น 0%) · shifts = แบ่งตาม "เวลาที่เกิดเรื่อง" ไม่ใช่ทีมกะไหนทำ (ระบบไม่ได้เก็บว่าใครอยู่กะไหน) ห้ามบอกว่าเป็นผลงานของทีมกะนั้น · cip.thin = true แปลว่าจำนวนรอบน้อยเกินจะสรุปว่าใครเร็วช้า ให้บอกตรง ๆ · เทียบเวลา CIP ด้วย median ไม่ใช่ค่าเฉลี่ย',
    };
  }
  if (name === 'get_quality_history') {
    const { from, to } = rangeFromQuery({ from: input.from, to: input.to });
    const h = await buildQualityHistory({ from, to, flavor: input.flavor, line: input.line });
    return {
      ...h,
      rows: h.rows.slice(0, 30),                     // ตัดรายการดิบให้สั้น — สรุปอยู่ในคีย์อื่นครบแล้ว
      flavors: h.flavors.slice(0, 15),
      note: 'checked = จำนวนครั้งที่ตรวจได้จริง (รสนั้นตั้งสเปกไว้) · out = หลุดสเปก · rate = %จาก checked เท่านั้น ห้ามคิดจาก readings · noSpec = รสที่วัดค่าแล้วแต่ยังไม่ได้ตั้งสเปก อย่าบอกว่าปกติ ให้ชวนไปตั้งสเปก · pos = ค่าเฉลี่ยอยู่ตรงไหนในช่วงสเปก (0=ขอบล่าง 1=ขอบบน) · trend.dir up/down/flat = เทียบครึ่งแรกกับครึ่งหลังของช่วงที่ดู',
    };
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
  if (name === 'fill_handover_form') {
    const draft = normalizeHandoverDraft(input);
    if (ctx) ctx.handoverDraft = draft; // ไม่เขียน DB — ส่งร่างกลับให้ client เติมฟอร์มเอง
    return { ok: true, filled: true, note: 'ส่งร่างข้อมูลไปเติมในฟอร์มรับกะให้แล้ว ยังไม่ได้บันทึกอะไรทั้งสิ้น บอกผู้ใช้สรุปสั้นๆ ว่ากรอกอะไรให้บ้าง และให้ไปตรวจสอบ/แก้ไข/กดส่งเองที่ฟอร์ม ห้ามพูดว่าบันทึกแล้ว' };
  }
  if (name === 'fill_production_plan') {
    const draft = normalizePlanDraft(input);
    if (ctx) ctx.planDraft = draft; // ไม่เขียน DB — ส่งร่างแผนกลับให้ client ตรวจ/บันทึกเอง
    return { ok: true, filled: true, count: draft.items.length, note: 'แกะแผนเป็นรายการเป้าผลิตแล้ว ยังไม่ได้บันทึก บอกผู้ใช้สรุปสั้นๆ ว่ามีกี่รายการ/รสอะไรบ้าง แล้วให้ไปตรวจ/แก้/กดบันทึกเองที่การ์ด ห้ามพูดว่าบันทึกแล้ว' };
  }
  return { error: 'unknown tool' };
}

// แปลง args จาก fill_production_plan → รายการเป้าผลิตที่สะอาด (คำนวณ batch = boxes/100, ตัดรายการไม่มีรส/เป้า)
function normalizePlanDraft(input) {
  const shift = ['กะเช้า', 'กะบ่าย', 'กะดึก'].includes(input.shift) ? input.shift : '';
  const itemsIn = Array.isArray(input.items) ? input.items : [];
  const items = itemsIn.map(it => {
    const flavor = String((it && it.flavor) || '').trim();
    const boxes = Math.round(Number(it && it.target_boxes));
    if (!flavor || !isFinite(boxes) || boxes <= 0) return null; // ต้องมีรส + เป้า Boxes เป็นบวก
    const staffN = Math.round(Number(it && it.staff));
    return {
      flavor,
      target_boxes: boxes,
      target_batches: Math.round((boxes / 100) * 10) / 10, // 1 batch = 100 boxes (ทศนิยม 1 ตำแหน่ง)
      staff: isFinite(staffN) && staffN > 0 ? staffN : null,
      machine_code: String((it && it.machine_code) || '').trim(),
      spec: String((it && it.spec) || '').trim(),
    };
  }).filter(Boolean);
  return { shift, items };
}

// เดาช่อง Batch dropdown (ตัวอักษร A-Z เดี่ยว) จากข้อความถัง — เอา batch "ล่าสุด" = ตัวอักษรสูงสุด
// ที่ปรากฏ (เช่นถังมี "Batch J 30%","Batch K 100%" → K) ให้ตรงกับพฤติกรรมที่คนกรอกเอง
function deriveBatchFromTanks(tanks) {
  let best = '';
  for (const t of tanks) {
    const m = String(t || '').match(/batch\s*([A-Za-z])\b/i);
    if (m) { const c = m[1].toUpperCase(); if (c > best) best = c; }
  }
  return best;
}

// แปลง args จาก fill_handover_form ให้เป็นโครงสร้างตรงกับ HoState ฝั่ง client เสมอ (กัน AI ส่งฟิลด์ขาด/เกิน)
// batch dropdown ไม่ให้ AI กรอก (กันมันย้าย "Batch C" ออกจากถัง) — เดาจากข้อความถังด้วยโค้ดแทน
function normalizeHandoverDraft(input) {
  const clampArr = (arr, n) => {
    const a = Array.isArray(arr) ? arr.slice(0, n).map(x => String(x || '')) : [];
    while (a.length < n) a.push('');
    return a;
  };
  const linesIn = Array.isArray(input.lines) ? input.lines.slice(0, 3) : [];
  while (linesIn.length < 3) linesIn.push({});
  return {
    shift: ['กะเช้า', 'กะบ่าย', 'กะดึก'].includes(input.shift) ? input.shift : 'กะเช้า',
    lines: linesIn.map(l => {
      const tanks = clampArr(l && l.tanks, 3);
      return {
        flavor: String((l && l.flavor) || ''),
        batch: deriveBatchFromTanks(tanks), // เดาจากถัง ไม่พึ่งค่าจาก AI
        tanks,
        lotNo: String((l && l.lotNo) || ''),
        note: String((l && l.note) || ''),
      };
    }),
    line4: {
      flavor: String((input.line4 && input.line4.flavor) || ''),
      stages: clampArr(input.line4 && input.line4.stages, 6),
      lotNo: String((input.line4 && input.line4.lotNo) || ''),
    },
    note: String(input.note || ''),
  };
}

const ASSISTANT_FLAVORS = 'Amazon, FDS, Golden, Freshy Lychee, Freshy Strawberry, Senorita Coconut, Senorita Caramel, Freshy Blue Hawaii, Freshy Lime, Freshy Green Apple, Freshy Sala, Senorita Yuzu, Senorita Peach, MLH 02, Freshy Pineapple, Freshy Grape, Freshy Punch, Freshy blue Lemon, Senorita Fres Mint, Freshy Orange, Signature Rose, Freshy Shine Muscat Grape, Freshy Peach, Freshy Mango, Dilute W-Molass';

// ส่วน "คงที่" ของ system prompt — นี่คือก้อนที่ติด cache_control
// ⚠️ ห้ามเอาวันที่ / ความจำถาวร / อะไรที่เปลี่ยนรายคนรายวัน มาใส่ในนี้เด็ดขาด
//    cache เป็น prefix match — ไบต์เดียวเปลี่ยนคือเสีย cache ทั้งก้อน (ของเดิมเอาวันที่+ความจำ
//    ใส่ปนไว้ในนี้ ทำให้สั่ง "จำ" ทีเดียว cache รีเซ็ตทั้งก้อนทุกครั้ง)
function assistantSystemStable() {
  return [
    'คุณเป็นผู้ช่วยอัจฉริยะสำหรับบันทึกและวิเคราะห์ข้อมูลการผลิตน้ำเชื่อม/น้ำหวานของโรงงาน คุยแบบเป็นกันเองแต่มืออาชีพ',
    'สายการผลิต/CIP: Line 1 (Syrup), Line 2 และ Line 3 (Flavour), Line 4 (Mixing/Pasteurizer)',
    `รสชาติที่มี: ${ASSISTANT_FLAVORS}`,
    'ถ้าผู้ใช้พิมพ์ชื่อรสผิด/สะกดเพี้ยน/เป็นภาษาไทย ให้จับคู่กับรสที่ใกล้เคียงที่สุดในลิสต์เอง (เช่น "อเมซอน"→Amazon, "ลิ้นจี่"→Freshy Lychee) ไม่แน่ใจค่อยถามยืนยัน',
    'หมายเหตุ: Dilute W-Molass บันทึกเป็นรอบ No.1–20 (รสอื่นเป็น Batch A-Z)',
    '',
    'ความสามารถ:',
    '• บันทึกงาน: create_task (category ผลิต=production, ทำความสะอาด=cip, backwash=backwash, ซ่อมบำรุง=maintenance) · ปิดงาน: complete_task',
    '• ข้อมูลวันเดียว: get_production_summary / get_cip_summary / get_timeline / list_tasks',
    '• ข้ามวัน/ช่วงเวลา/แนวโน้ม: query_production_range (from,to) เช่น "สัปดาห์นี้", "3 วันก่อน", "เดือนนี้"',
    '• ประสิทธิภาพ/เทียบคน-กะ: get_performance (% งานประจำรายคน · ผลิตแยกกะ · เวลาต่อรอบ CIP เทียบค่ากลาง)',
    '• คุณภาพ: get_quality (Brix/pH — แนบสเปกมาด้วย) เตือน "ผิดปกติ" เฉพาะรสที่มีสเปกและค่าออกนอกช่วง · ถามภาพรวมย้อนหลัง/หลุดกี่ครั้ง/รสไหนบ่อย/เทรนด์ ใช้ get_quality_history · ตั้งสเปกด้วย set_quality_spec (เช่นผู้ใช้บอก "สเปกส้ม pH 3.2-4") · ดูสเปกที่ตั้งไว้ด้วย get_quality_specs',
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
    '• fill_handover_form: เรียกเฉพาะตอนอยู่ในโหมด "กรอกฟอร์มรับกะด้วย AI" เท่านั้น (ระบบจะบอกชัดเจนถ้าอยู่ในโหมดนี้) — ไม่ใช่เขียน DB แค่ส่งร่างข้อมูลเติมฟอร์มให้ผู้ใช้ตรวจสอบเอง ไม่ต้องขอยืนยัน',
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
  ].join('\n');
}

// ส่วน "ผันแปร" — วันที่ (เปลี่ยนทุกวัน) + ความจำถาวร (เปลี่ยนทุกครั้งที่สั่งจำ/ลืม)
// ต้องต่อ "ท้าย" ก้อนคงที่เสมอ ห้ามย้ายขึ้นไปข้างบน ไม่งั้น cache พังเหมือนเดิม
async function assistantSystemVolatile(operator) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const memBlock = await memoryPromptBlock(operator); // เฟส 2
  return [`วันนี้คือ ${today} (เขตเวลา Asia/Bangkok)`, memBlock || ''].filter(Boolean).join('\n');
}

// system ทั้งก้อนต่อกันเป็นสตริงเดียว — ไว้ให้เทสต์/ผู้เรียกภายนอกใช้ (ของจริงส่งเป็น 2 บล็อก)
async function buildAssistantSystem(operator) {
  return assistantSystemStable() + '\n' + (await assistantSystemVolatile(operator));
}

// หน้าแชท (เว็บ + Telegram) แสดงข้อความธรรมดา — Markdown ที่หลุดมาจะเห็นเป็นดอกจัน/ชาร์ปโต้ง ๆ
// system สั่งห้ามอยู่แล้ว แต่โมเดลไม่ได้ทำตาม 100% (Kimi หลุด 1 ใน 3 ครั้งตอนทดสอบ 7 ก.ย.)
// ข้อบังคับของหน้าจอแบบนี้ต้องบังคับด้วยโค้ด ไม่ใช่ฝากไว้กับดุลพินิจโมเดล — และได้ผลกับทุกเจ้า
function stripChatMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')       // **ตัวหนา**
    .replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|$)/g, '$1$2') // *เอียง* (ไม่แตะ • หรือ * ที่ติดตัวเลข)
    .replace(/^#{1,6}\s+/gm, '')             // ## หัวข้อ
    .replace(/^\s*[-*]\s+/gm, '• ')          // - รายการ → •
    .trim();
}

// เลเยอร์คุยกับ Claude ที่ใช้ร่วมกัน — หน้าเว็บ (/api/assistant), ต่อหลังกดยืนยัน (เฟส 3), วิเคราะห์สิ้นกะ (เฟส 1)
// opts: { userMessage, image | images, operator, session, persist=true, maxTurns=12, systemExtra }
// image = { data: base64 ไม่รวม prefix, media_type } หรือ images = [ ... ] (หลายรูป/หลายส่วนของตารางเดียว)
// → แนบเป็น image block เทิร์นแรก (vision อ่านรูปแผน) · รูปส่งเฉพาะเทิร์นนี้ ไม่เก็บลง history
async function runAssistantConversation(opts) {
  const { userMessage, image = null, images = null, operator = null, session = null, persist = true, maxTurns = 12, systemExtra = '', forceTool = null } = opts;
  if (!ai.available('assist')) throw Object.assign(new Error('ยังไม่ได้ตั้งค่าคีย์ AI บนเซิร์ฟเวอร์'), { status: 503, aiUnavailable: true });
  // โหมดบังคับเรียก tool = งานแกะข้อความเป็นฟิลด์ (รับกะ/ลงแผน) ใช้รุ่นเก่งกว่า — ดูเหตุผลใน server/ai/index.js
  const assistPurpose = forceTool ? 'assist_extract' : 'assist';
  // แยก 2 ก้อน: ก้อนคงที่ (ติด cache) → ก้อนผันแปร (วันที่ + ความจำ + hint รายคำขอ, ไม่ติด cache)
  const systemStable = assistantSystemStable();
  let systemVolatile = await assistantSystemVolatile(operator);
  if (systemExtra) systemVolatile += '\n\n' + systemExtra;

  const actions = [];
  const ctx = { session, pending: [], resolved: [], handoverDraft: null, planDraft: null }; // pending = การ์ดยืนยัน, handoverDraft = ร่างฟอร์มรับกะ, planDraft = ร่างแผนผลิต
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
    const resp = await ai.createMessage(assistPurpose, {
      max_tokens: 4096,
      // prompt caching: จุด cache อยู่ท้ายก้อนคงที่ → tools+ก้อนคงที่ อ่านจาก cache เหลือ ~0.1x
      // วันที่ + ความจำถาวร + hint รายคำขอ อยู่ในก้อนที่ 2 ซึ่ง "ไม่ติด cache" จึงเปลี่ยนได้โดย cache ไม่พัง
      system: [
        { type: 'text', text: systemStable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: systemVolatile },
      ],
      tools: ASSISTANT_TOOLS, messages,
      // บังคับเรียก tool เจาะจงเฉพาะเทิร์นแรก (กันโมเดลแค่ "บรรยาย" ว่าทำแล้วโดยไม่เรียก tool จริง) —
      // เทิร์นถัดไปปล่อย auto ตามปกติ ไม่งั้นจะวนบังคับเรียกซ้ำไม่รู้จบ
      ...(turn === 0 && forceTool ? { tool_choice: { type: 'tool', name: forceTool } } : {}),
    });
    const u = resp.usage || {};
    console.log(`[assistant] ${ai.describe(assistPurpose)} turn=${turn} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
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
  reply = stripChatMarkdown(reply) || 'รับทราบครับ';
  // เก็บบทสนทนารอบนี้ไว้ต่อ session (จำกัดไว้ ~30 ข้อความล่าสุดต่อ session)
  if (persist && session) {
    const ts = nowBKK();
    await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [session, 'user', String(userMessage || '') + (nImg ? ` 🖼[แนบรูป${nImg > 1 ? ' ' + nImg + ' รูป' : ''}]` : ''), ts]);
    await db.exec('INSERT INTO assistant_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)', [session, 'assistant', reply, ts]);
    await db.exec(`DELETE FROM assistant_messages WHERE session = ? AND id NOT IN (SELECT id FROM assistant_messages WHERE session = ? ORDER BY id DESC LIMIT 30)`, [session, session]);
  }
  return { reply, actions, pending: ctx.pending, handoverDraft: ctx.handoverDraft, planDraft: ctx.planDraft };
}

// hint พิเศษต่อ intent — บังคับให้ turn นี้เรียก fill_handover_form ทันทีเมื่อได้ข้อความ กันหลุดไปคุยทั่วไป
// forceTool ผูกคู่กัน: บังคับ tool_choice จริงๆ ที่ API ไม่ใช่แค่บอกในคำสั่ง (กันโมเดล "บรรยาย" ว่าทำแล้วทั้งที่ไม่ได้เรียก tool)
const ASSISTANT_INTENT_HINTS = {
  fill_handover: {
    hint: 'โหมดพิเศษ: ผู้ใช้กำลังจะวางข้อความข้อมูลสถานะกะที่ได้รับมาจากกะก่อน (รส/สถานะ, batch, ระดับถัง, lot no, หมายเหตุ ต่อ Line 1-4) '
      + 'หน้าที่ของคุณรอบนี้คือแกะข้อความให้เป็นฟิลด์แล้วเรียก fill_handover_form ทันที — ห้ามเดา/แต่งข้อมูลที่ไม่มีในข้อความ ปล่อยฟิลด์ว่างไว้ถ้าไม่มีข้อมูลในข้อความ '
      + 'ไม่ต้องขอยืนยันก่อนเรียก tool นี้ (ไม่ได้เขียน DB) จากนั้นสรุปสั้นๆ ว่ากรอกอะไรให้บ้าง และบอกให้ผู้ใช้ไปตรวจสอบ/แก้ไข/กดส่งเองที่ฟอร์มรับกะ ห้ามพูดว่าบันทึกแล้ว',
    tool: 'fill_handover_form',
  },
  fill_plan: {
    hint: 'โหมดพิเศษ: ผู้ใช้กำลังจะวางข้อความ "แผนผลิต" (มีหัวแผน วันที่/กะ/staffing แล้วตามด้วยรายการผลิตแต่ละบรรทัด) '
      + 'หน้าที่ของคุณรอบนี้คือแกะเป็นรายการเป้าผลิตแล้วเรียก fill_production_plan ทันที — แต่ละรายการรูปแบบ "<สินค้า/รส> <สเปก> [<เครื่องบรรจุ>] = <เป้าBoxes>/<จำนวนคน>" '
      + 'เอาเฉพาะรายการที่มีเป้า Boxes (เลขก่อน /) · ข้ามงานซัพพอร์ตที่เป็นแค่ "ชื่อ=จำนวนคน" (เช่น "ผู้ช่วยต้ม=2", "บดน้ำตาล=2", "จัด Packaging =2", "ดู CheckWeight =1") · [L1]/[A3] คือเครื่องบรรจุ ไม่ใช่ Line · ห้ามเดา/แต่งเลข '
      + 'กะดูจากเวลาในหัวแผน (06-14=กะเช้า, 14-22=กะบ่าย, 18-06 หรือ 22-06=กะดึก) · ไม่ต้องขอยืนยัน (ไม่ได้เขียน DB) จากนั้นสรุปสั้นๆ ว่าแกะได้กี่รายการ แล้วบอกให้ไปตรวจ/แก้/กดบันทึกเองที่การ์ด ห้ามพูดว่าบันทึกแล้ว',
    tool: 'fill_production_plan',
  },
};

app.post('/api/assistant', async (req, res) => {
  if (!ai.available('assist')) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าคีย์ AI บนเซิร์ฟเวอร์' });
  const { message, operator, session, image, images, intent } = req.body;
  // รวมรูป: images (อาเรย์ หลายส่วน) หรือ image (เดี่ยว) — จำกัด 6 รูปกัน payload บวม
  let imgs = Array.isArray(images) ? images.filter(im => im && im.data).map(im => ({ data: String(im.data), media_type: im.media_type || 'image/jpeg' })) : [];
  if (!imgs.length && image && image.data) imgs = [{ data: String(image.data), media_type: image.media_type || 'image/jpeg' }];
  imgs = imgs.slice(0, 6);
  if (!message && !imgs.length) return res.status(400).json({ error: 'message หรือ image จำเป็น' });
  try {
    const intentCfg = ASSISTANT_INTENT_HINTS[intent];
    const { reply, actions, pending, handoverDraft, planDraft } = await runAssistantConversation({ userMessage: String(message || ''), images: imgs, operator, session,
      systemExtra: intentCfg?.hint || '', forceTool: intentCfg?.tool || null });
    res.json({ reply, actions, pending, handoverDraft, planDraft });
  } catch (err) {
    console.error('[assistant] error', err.message);
    res.status(err.status || 500).json({ error: err.message });
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
      if (ai.available('assist')) {
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

// ═══ บทความเทคนิค (posts) ══════════════════════════════════════════════════
// ใช้กับ editor ในหน้า Admin → เมนู "บทความ / คู่มือระบบ"
// blocks/tags เก็บเป็น JSON string ในคอลัมน์ TEXT (ดูเหตุผลที่ SCHEMA)

const POST_FIELDS = ['slug','title','blocks','status','author','category','tags','machine','excerpt',
  'cover_url','seo_keyword','seo_desc','script_head','script_body','obs_folder'];

/* SOP: สิ่งที่คนอ่านเห็น = "ฉบับที่อนุมัติล่าสุด" ไม่ใช่ของที่กำลังแก้อยู่
   posts.blocks = ฉบับร่างที่คนเขียนแก้ไปเรื่อย ๆ · post_versions = ฉบับที่ผ่านตาหัวหน้าแล้ว
   → แก้คู่มือระหว่างวันได้โดยที่คนหน้างานยังเปิดอ่านฉบับที่อนุมัติไว้เหมือนเดิม             */
async function latestVersion(postId) {
  try {
    return await dbGet(
      'SELECT * FROM post_versions WHERE post_id = ? ORDER BY version DESC LIMIT 1', [postId]) || null;
  } catch { return null; }
}
// คืน post object ที่พร้อมเอาไปเรนเดอร์/เขียนไฟล์ (ถ้าเป็น SOP ที่อนุมัติแล้วจะสลับเนื้อหาเป็นฉบับอนุมัติ)
async function approvedPostView(row) {
  const post = postFromRow(row);
  if (!isSopPost(row)) return post;
  const v = await latestVersion(row.id);
  if (!v) return post;
  let blocks = post.blocks;
  try { blocks = JSON.parse(v.blocks || '[]'); } catch { /* พังก็ใช้ของเดิม */ }
  return { ...post, title: v.title || post.title, blocks,
    sopVersion: v.version, approvedBy: v.approved_by || '', approvedAt: v.approved_at || '' };
}

// แปลงแถวจาก DB → รูปที่ฝั่งหน้าเว็บใช้ (คลาย JSON ให้เรียบร้อย ไม่ให้หน้าเว็บต้อง parse เอง)
function postFromRow(r) {
  if (!r) return null;
  const safe = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
  return {
    id: r.id,
    slug: r.slug || '',
    title: r.title || '',
    blocks: safe(r.blocks, []),
    status: r.status || 'draft',
    author: r.author || '',
    category: r.category || '',
    tags: safe(r.tags, []),
    machine: r.machine || '',
    excerpt: r.excerpt || '',
    coverUrl: r.cover_url || '',
    seoKeyword: r.seo_keyword || '',
    seoDesc: r.seo_desc || '',
    scriptHead: r.script_head || '',
    scriptBody: r.script_body || '',
    obsFolder: r.obs_folder || 'บทความ',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
    vaultPath: r.vault_path || '',
    vaultSyncedAt: r.vault_synced_at || '',
    vaultError: r.vault_error || '',
  };
}

// เขียนบทความลง Obsidian vault แล้วจดผลไว้ที่แถวนั้น
// ⚠️ ห้าม throw ออกไป — บทความต้องบันทึกลง DB สำเร็จได้แม้ GitHub ล่ม (sync เป็นผลพลอยได้)
// คืนสถานะกลับให้หน้าเว็บโชว์ในกล่อง Obsidian
async function syncPostToVault(id) {
  if (!vault.vaultEnabled()) return { enabled: false };
  const row = await dbGet('SELECT * FROM posts WHERE id = ?', [id]);
  if (!row) return { enabled: true, ok: false, error: 'ไม่พบบทความนี้' };
  const post = postFromRow(row);
  const at = nowBKK();
  try {
    // ยังไม่เผยแพร่ = ไม่ควรอยู่ใน vault — ถอนไฟล์เก่าออกถ้าเคยเผยแพร่ไว้
    if (post.status !== 'published') {
      if (post.vaultPath) await vault.unsyncPost(post.vaultPath, 'กลับเป็นร่าง');
      await db.exec('UPDATE posts SET vault_path = ?, vault_synced_at = ?, vault_error = ? WHERE id = ?',
        ['', at, '', id]);
      return { enabled: true, ok: true, removed: !!post.vaultPath, at };
    }
    // SOP → เขียนฉบับที่อนุมัติแล้วลงไฟล์ (ไม่ใช่ฉบับร่างที่กำลังแก้)
    const r = await vault.syncPost(await approvedPostView(row), post.vaultPath);
    await vaultRemember(r.path, r.sha);
    await db.exec('UPDATE posts SET vault_path = ?, vault_synced_at = ?, vault_error = ? WHERE id = ?',
      [r.path, at, '', id]);
    return { enabled: true, ok: true, path: r.path, skipped: !!r.skipped, at };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 400);
    console.error('[vault] sync บทความ', id, 'ไม่สำเร็จ —', msg);
    try {
      await db.exec('UPDATE posts SET vault_synced_at = ?, vault_error = ? WHERE id = ?', [at, msg, id]);
    } catch { /* จดผลไม่ได้ก็ช่าง อย่าให้ล้มซ้อน */ }
    return { enabled: true, ok: false, error: msg, at };
  }
}

// รายการบทความ — ไม่ส่ง blocks กลับไป (หนักและหน้ารายการไม่ได้ใช้)
// ไม่ส่ง query อะไรมา = รายการของหน้า Admin (ได้ร่างด้วย เรียงตามที่แก้ล่าสุด) — พฤติกรรมเดิม
// ?status=published[&limit=n] = ชั้นบทความบนหน้าหลักของแอป เรียงตามวันเผยแพร่เหมือนหน้าอ่านสาธารณะ
app.get('/api/posts', async (req, res) => {
  try {
    const onlyPub = String(req.query.status || '') === 'published';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 50);
    const rows = await dbAll(
      `SELECT id, slug, title, status, author, category, tags, machine, excerpt, cover_url,
              created_at, updated_at, published_at
         FROM posts ${onlyPub ? "WHERE status = 'published'" : ''}
        ORDER BY ${onlyPub ? 'COALESCE(published_at, updated_at)' : 'updated_at'} DESC`, []);
    const items = rows.map(r => ({ ...postFromRow({ ...r, blocks: '[]' }), blocks: undefined }));
    res.json({ items: limit ? items.slice(0, limit) : items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM posts WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบบทความนี้' });
    const item = postFromRow(row);
    // SOP: บอกด้วยว่าอนุมัติถึงเวอร์ชันไหน และตอนนี้มีของที่แก้ค้างรออนุมัติอยู่ไหม
    if (isSopPost(row)) {
      const v = await latestVersion(row.id);
      item.sop = v
        ? { version: v.version, approvedBy: v.approved_by || '', approvedAt: v.approved_at || '',
            pending: String(v.blocks || '') !== String(row.blocks || '') || (v.title || '') !== (row.title || '') }
        : { version: 0, approvedBy: '', approvedAt: '', pending: true };
    }
    // ลิงก์ดูร่างเป็นหน้าอ่านจริง (ใช้ได้ทั้งตอนยังไม่เผยแพร่และหลังเผยแพร่)
    item.previewUrl = `${PUBLIC_URL}/บทความ/${encodeURIComponent(item.slug || '')}?preview=${previewToken(row.id)}`;
    res.json({ item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ทำ slug ให้ใช้งานได้เสมอ — เดิมเซิร์ฟเวอร์รับ slug ว่างได้ แล้วบทความนั้นเปิดไม่ได้เลย
   (ลิงก์กลายเป็น /บทความ/ ซึ่งเป็นหน้ารวม) · ว่าง → เอาจากหัวข้อ → ยังว่างอีก → ตั้งให้เอง
   ซ้ำกับเรื่องอื่น → ต่อท้าย -2, -3 (ไม่งั้นสองเรื่องแย่งลิงก์เดียวกัน เปิดได้เรื่องเดียว) */
const slugNorm = (s) => String(s || '').trim().toLowerCase()
  .replace(/[\s_/]+/g, '-').replace(/[^฀-๿a-z0-9-]/g, '')
  .replace(/-+/g, '-').replace(/^-|-$/g, '');
async function uniquePostSlug(raw, title, selfId) {
  const base = slugNorm(raw) || slugNorm(title) || `post-${Date.now().toString(36)}`;
  const rows = await dbAll('SELECT id, slug FROM posts WHERE slug LIKE ?', [`${base}%`]);
  const taken = new Set(rows.filter(r => String(r.id) !== String(selfId || '')).map(r => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

// สร้างใหม่ (ไม่ส่ง id มา) หรือแก้ของเดิม (ส่ง id มา) — คืน id กลับไปเสมอ
app.post('/api/posts', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'ต้องมีหัวข้อบทความ' });
  const now = nowBKK();
  const vals = {
    slug: '',                       // เติมทีหลังด้วย uniquePostSlug() (ต้อง await)
    title,
    blocks: JSON.stringify(Array.isArray(b.blocks) ? b.blocks : []),
    status: ['draft', 'review', 'published'].includes(b.status) ? b.status : 'draft',
    author: String(b.author || ''),
    category: String(b.category || ''),
    tags: JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
    machine: String(b.machine || ''),
    excerpt: String(b.excerpt || ''),
    cover_url: String(b.coverUrl || ''),
    seo_keyword: String(b.seoKeyword || ''),
    seo_desc: String(b.seoDesc || ''),
    script_head: String(b.scriptHead || ''),
    script_body: String(b.scriptBody || ''),
    obs_folder: String(b.obsFolder || 'บทความ'),
  };
  try {
    vals.slug = await uniquePostSlug(b.slug, title, b.id);
    // ── SOP ต้องผ่านการอนุมัติ ─────────────────────────────────────────────
    // ยังไม่เคยอนุมัติแล้วกดเผยแพร่เอง = ไม่ให้ (ต้องใช้ปุ่ม "ส่งขออนุมัติ")
    // เคยอนุมัติแล้ว = แก้ต่อได้ตามสบาย เพราะคนอ่านยังเห็นฉบับที่อนุมัติไว้ (approvedPostView)
    if (vals.category === SOP_CATEGORY && vals.status === 'published') {
      const who = await whoIs(req);
      const okRole = who && (ROLE_RANK[who.role] || 0) >= ROLE_RANK.supervisor;
      const approved = b.id ? await latestVersion(b.id) : null;
      if (!approved && !okRole) {
        return res.status(403).json({ error: 'คู่มือ/SOP ต้องผ่านการอนุมัติก่อน — กด "ส่งขออนุมัติ" แล้วให้หัวหน้างานตรวจ' });
      }
    }
    if (b.id) {
      // published_at ตั้งครั้งแรกที่เผยแพร่เท่านั้น เผยแพร่ซ้ำไม่รีเซ็ตวันที่เดิม
      const cur = await dbGet('SELECT published_at, status FROM posts WHERE id = ?', [b.id]);
      if (!cur) return res.status(404).json({ error: 'ไม่พบบทความนี้' });
      const publishedAt = vals.status === 'published' ? (cur.published_at || now) : cur.published_at;
      await db.exec(
        `UPDATE posts SET ${POST_FIELDS.map(f => `${f} = ?`).join(', ')}, updated_at = ?, published_at = ? WHERE id = ?`,
        [...POST_FIELDS.map(f => vals[f]), now, publishedAt, b.id]);
      // sync หลังบันทึกสำเร็จเท่านั้น — เคยเผยแพร่แล้วก็ sync ต่อ (แก้แล้วไฟล์ใน vault ต้องตามด้วย)
      const vaultRes = (vals.status === 'published' || cur.status === 'published')
        ? await syncPostToVault(b.id) : undefined;
      return res.json({ id: Number(b.id), slug: vals.slug, updatedAt: now, vault: vaultRes });
    }
    const publishedAt = vals.status === 'published' ? now : null;
    const r = await db.exec(
      `INSERT INTO posts (${POST_FIELDS.join(', ')}, created_at, updated_at, published_at)
       VALUES (${POST_FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`,
      [...POST_FIELDS.map(f => vals[f]), now, now, publishedAt]);
    // Postgres คืนแถวที่เพิ่งเขียนมาให้ ส่วน SQLite ต้องถามหา id ที่เพิ่งได้
    let id = r && r.rows && r.rows[0] ? r.rows[0].id : undefined;
    if (id === undefined) {
      const row = await dbGet('SELECT id FROM posts ORDER BY id DESC LIMIT 1', []);
      id = row && row.id;
    }
    const vaultRes = vals.status === 'published' && id ? await syncPostToVault(id) : undefined;
    res.json({ id, slug: vals.slug, updatedAt: now, vault: vaultRes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════ อนุมัติ + เวอร์ชันของคู่มือ/SOP (แผน KM ข้อ 7) ══════════
   ร่าง → ส่งขออนุมัติ (review) → หัวหน้างานกดอนุมัติ (published + เก็บเวอร์ชัน) หรือตีกลับ
   บทความหมวดอื่นไม่เปลี่ยนพฤติกรรมเลย — กดเผยแพร่เองได้เหมือนเดิม                */
const SOP_CATEGORY = 'คู่มือ / SOP';
const isSopPost = (row) => String((row || {}).category || '').trim() === SOP_CATEGORY;

const sopNotify = (text) => { if (process.env.TELEGRAM_CHAT_ID) notify('sop', text); };

// ส่งขออนุมัติ — ใครก็ส่งได้ (คนเขียนเอง)
app.post('/api/posts/submit', async (req, res) => {
  const { id, by } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ต้องมี id' });
  try {
    const row = await dbGet('SELECT id, title, status, category FROM posts WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบบทความนี้' });
    if (!isSopPost(row)) return res.status(400).json({ error: 'ใช้ได้เฉพาะหมวด "คู่มือ / SOP"' });
    if (row.status === 'published') return res.status(400).json({ error: 'อนุมัติไปแล้ว — แก้เนื้อหาก่อนแล้วค่อยส่งใหม่' });
    await db.exec("UPDATE posts SET status = 'review', updated_at = ? WHERE id = ?", [nowBKK(), id]);
    sopNotify(`📝 <b>ขออนุมัติ SOP</b>\n${escapeHtml(row.title)}\n\n✍️ โดย ${escapeHtml(by || 'ไม่ระบุ')}\n👉 เปิดหน้า Admin → บทความ เพื่อตรวจและอนุมัติ`);
    res.json({ success: true, status: 'review' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// อนุมัติ — หัวหน้างานขึ้นไปเท่านั้น · เก็บสำเนาเนื้อหาเป็นเวอร์ชันใหม่ แล้วเขียนลง vault
app.post('/api/posts/approve', requireRole('supervisor'), async (req, res) => {
  const { id, note } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ต้องมี id' });
  try {
    const row = await dbGet('SELECT * FROM posts WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบบทความนี้' });
    if (!isSopPost(row)) return res.status(400).json({ error: 'ใช้ได้เฉพาะหมวด "คู่มือ / SOP"' });
    const last = await dbGet('SELECT MAX(version) AS v FROM post_versions WHERE post_id = ?', [id]);
    const version = Number((last && last.v) || 0) + 1;
    const at = nowBKK();
    await db.exec(
      `INSERT INTO post_versions (post_id, version, title, blocks, author, approved_by, approved_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, version, row.title, row.blocks, row.author || '', req.who.name, at, String(note || '').slice(0, 300)]);
    await db.exec("UPDATE posts SET status = 'published', updated_at = ?, published_at = COALESCE(published_at, ?) WHERE id = ?",
      [at, at, id]);
    const vaultRes = await syncPostToVault(id);
    sopNotify(`✅ <b>อนุมัติ SOP แล้ว</b> (เวอร์ชัน ${version})\n${escapeHtml(row.title)}\n\n👤 อนุมัติโดย ${escapeHtml(req.who.name)}${note ? `\n📝 ${escapeHtml(String(note))}` : ''}`);
    res.json({ success: true, version, approvedBy: req.who.name, approvedAt: at, vault: vaultRes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ตีกลับ — กลับเป็นร่าง พร้อมเหตุผล (เหตุผลไปอยู่ใน Telegram ให้คนเขียนเห็น)
app.post('/api/posts/reject', requireRole('supervisor'), async (req, res) => {
  const { id, reason } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ต้องมี id' });
  try {
    const row = await dbGet('SELECT id, title, category, status FROM posts WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบบทความนี้' });
    if (!isSopPost(row)) return res.status(400).json({ error: 'ใช้ได้เฉพาะหมวด "คู่มือ / SOP"' });
    await db.exec("UPDATE posts SET status = 'draft', updated_at = ? WHERE id = ?", [nowBKK(), id]);
    // เคยเผยแพร่แล้วถูกตีกลับ = ถอนไฟล์ออกจาก vault ด้วย (syncPostToVault จัดการให้เอง)
    const vaultRes = await syncPostToVault(id);
    sopNotify(`↩️ <b>ตีกลับ SOP</b>\n${escapeHtml(row.title)}\n\n👤 โดย ${escapeHtml(req.who.name)}${reason ? `\n📝 ${escapeHtml(String(reason))}` : ''}`);
    res.json({ success: true, status: 'draft', vault: vaultRes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ประวัติเวอร์ชัน (ไม่ส่งเนื้อหามาด้วย — รายการอย่างเดียว)
app.get('/api/posts/:id/versions', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, version, title, author, approved_by, approved_at, note
         FROM post_versions WHERE post_id = ? ORDER BY version DESC`, [req.params.id]);
    res.json({
      versions: rows.map(r => ({
        id: r.id, version: r.version, title: r.title, author: r.author || '',
        approvedBy: r.approved_by || '', approvedAt: r.approved_at || '', note: r.note || '',
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// เนื้อหาของเวอร์ชันหนึ่ง (กดดูย้อนหลัง)
app.get('/api/posts/version/:vid', async (req, res) => {
  try {
    const r = await dbGet('SELECT * FROM post_versions WHERE id = ?', [req.params.vid]);
    if (!r) return res.status(404).json({ error: 'ไม่พบเวอร์ชันนี้' });
    let blocks = []; try { blocks = JSON.parse(r.blocks || '[]'); } catch { blocks = []; }
    res.json({
      version: {
        id: r.id, postId: r.post_id, version: r.version, title: r.title, blocks,
        author: r.author || '', approvedBy: r.approved_by || '', approvedAt: r.approved_at || '', note: r.note || '',
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// กู้คืนเวอร์ชันเก่า — เอาเนื้อหากลับมาเป็น "ร่าง" ต้องส่งอนุมัติใหม่อีกรอบ
// (ไม่ทับของที่อนุมัติแล้วเงียบ ๆ — ของที่คนหน้างานเปิดอ่านต้องผ่านตาหัวหน้าเสมอ)
app.post('/api/posts/restore-version', requireRole('supervisor'), async (req, res) => {
  const { versionId } = req.body || {};
  if (!versionId) return res.status(400).json({ error: 'ต้องมี versionId' });
  try {
    const v = await dbGet('SELECT * FROM post_versions WHERE id = ?', [versionId]);
    if (!v) return res.status(404).json({ error: 'ไม่พบเวอร์ชันนี้' });
    await db.exec("UPDATE posts SET title = ?, blocks = ?, status = 'draft', updated_at = ? WHERE id = ?",
      [v.title, v.blocks, nowBKK(), v.post_id]);
    const vaultRes = await syncPostToVault(v.post_id);
    res.json({ success: true, postId: v.post_id, version: v.version, status: 'draft', vault: vaultRes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


/* ═══════════════════════════════════════════════════════════════════════════
   คิวคู่มือ/SOP ที่รออนุมัติ + เทียบเวอร์ชัน (diff)
   เดิมมีระบบอนุมัติแล้วแต่ต้องเปิดบทความทีละเรื่องถึงจะรู้ว่ามีอะไรค้าง
   และเวลาอนุมัติก็ไม่เห็นว่า "แก้อะไรไปบ้าง" — ต้องอ่านทั้งเรื่องใหม่ทุกครั้ง
   ═══════════════════════════════════════════════════════════════════════════ */

// บล็อกบทความ → ข้อความบรรทัดต่อบรรทัด (ใช้เทียบ diff และให้คนอ่านรู้เรื่อง)
const stripTags = (h) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function blocksToLines(blocks) {
  const out = [];
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    const t = b.type || 'p';
    const push = (s) => String(s || '').split('\n').map(x => x.trim()).filter(Boolean).forEach(x => out.push(x));
    if (t === 'h1') push(`# ${stripTags(b.html)}`);
    else if (t === 'h2') push(`## ${stripTags(b.html)}`);
    else if (t === 'h3') push(`### ${stripTags(b.html)}`);
    else if (t === 'p' || t === 'quote' || t === 'callout') push(stripTags(b.html));
    else if (t === 'list' || t === 'checklist') (b.items || []).forEach(i => push(`- ${stripTags(i.html || i)}`));
    else if (t === 'image') push(`[รูป] ${b.caption || b.src || ''}`);
    else if (t === 'video') push(`[วิดีโอ] ${b.caption || b.src || ''}`);
    else if (t === 'file' || t === 'pdf') push(`[ไฟล์] ${b.caption || b.src || ''}`);
    else if (t === 'table') (b.cells || []).forEach(row => push(`| ${(row || []).join(' | ')}`));
    else if (t === 'code' || t === 'js') push(`[โค้ด] ${String(b.code || '').split('\n')[0] || ''}`);
    else if (t === 'chart') push(`[กราฟ] ${b.title || b.chartKind || ''}`);
    else if (t === 'divider') push('———');
    else push(stripTags(b.html || b.text || ''));
  }
  return out;
}

/* diff แบบบรรทัดต่อบรรทัด (LCS) — คู่มือยาวไม่กี่ร้อยบรรทัด ใช้ตารางตรง ๆ ได้สบาย
   คืนลำดับ same/del/add ตามที่คนอ่านเห็นในหน้าเทียบ                              */
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', text: a[i] }); i++; }
    else { out.push({ t: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', text: a[i++] });
  while (j < m) out.push({ t: 'add', text: b[j++] });
  return out;
}

const parseBlocks = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

// คิวงาน: อะไรบ้างที่รอหัวหน้าตรวจ — เรียงเรื่องที่ส่งมาขออนุมัติไว้บนสุด
app.get('/api/sop/queue', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, title, slug, author, status, category, blocks, updated_at
         FROM posts WHERE category = ? ORDER BY updated_at DESC`, [SOP_CATEGORY]);
    const items = [];
    for (const r of rows) {
      const v = await latestVersion(r.id);
      const changed = !v || String(v.blocks || '') !== String(r.blocks || '') || (v.title || '') !== (r.title || '');
      let state = '';
      if (r.status === 'review') state = 'review';                    // ส่งมาขออนุมัติ รอตรวจ
      else if (!v) state = 'never';                                   // ยังไม่เคยอนุมัติสักรอบ
      else if (changed) state = 'edited';                             // อนุมัติแล้วแต่มีของแก้ค้าง
      else continue;                                                  // ตรงกับฉบับอนุมัติ = ไม่ต้องทำอะไร
      const cur = blocksToLines(parseBlocks(r.blocks));
      const old = v ? blocksToLines(parseBlocks(v.blocks)) : [];
      const d = diffLines(old, cur);
      items.push({
        id: r.id, title: r.title, slug: r.slug, author: r.author || '', status: r.status,
        updatedAt: r.updated_at || '', state,
        version: v ? v.version : 0,
        approvedBy: v ? v.approved_by || '' : '', approvedAt: v ? v.approved_at || '' : '',
        added: d.filter(x => x.t === 'add').length, removed: d.filter(x => x.t === 'del').length,
      });
    }
    const rank = { review: 0, never: 1, edited: 2 };
    items.sort((a, b) => rank[a.state] - rank[b.state] || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ items, count: items.length, waiting: items.filter(i => i.state === 'review').length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* เทียบเนื้อหา 2 ฝั่ง — ค่าเริ่มต้น: ฉบับอนุมัติล่าสุด → ฉบับปัจจุบัน
   ระบุเวอร์ชันเองได้ด้วย ?from=<version>&to=<version|current>                */
app.get('/api/sop/diff', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'ต้องมี id' });
  try {
    const post = await dbGet('SELECT id, title, blocks, status, category FROM posts WHERE id = ?', [id]);
    if (!post) return res.status(404).json({ error: 'ไม่พบบทความนี้' });
    const versions = await dbAll(
      'SELECT id, version, title, blocks, approved_by, approved_at FROM post_versions WHERE post_id = ? ORDER BY version', [id]);
    const pick = (want, fallbackLatest) => {
      if (want === 'current') return { label: 'ฉบับปัจจุบัน', title: post.title, blocks: parseBlocks(post.blocks) };
      const n = Number(want);
      const v = versions.find(x => Number(x.version) === n) || (fallbackLatest ? versions[versions.length - 1] : null);
      return v
        ? { label: `เวอร์ชัน ${v.version}`, title: v.title, blocks: parseBlocks(v.blocks),
            approvedBy: v.approved_by || '', approvedAt: v.approved_at || '', version: v.version }
        : { label: 'ยังไม่มีฉบับอนุมัติ', title: '', blocks: [] };
    };
    const left = pick(req.query.from == null ? 'latest' : req.query.from, true);
    const right = pick(req.query.to == null ? 'current' : req.query.to, false);
    const lines = diffLines(blocksToLines(left.blocks), blocksToLines(right.blocks));
    res.json({
      id: Number(id), title: post.title, status: post.status,
      left, right,
      versions: versions.map(v => ({ version: v.version, approvedBy: v.approved_by || '', approvedAt: v.approved_at || '' })).reverse(),
      lines,
      added: lines.filter(l => l.t === 'add').length,
      removed: lines.filter(l => l.t === 'del').length,
      same: lines.filter(l => l.t === 'same').length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ปุ่ม "sync เดี๋ยวนี้" — เขียนไฟล์ใหม่จากข้อมูลที่อยู่ใน DB ตอนนี้
app.post('/api/posts/:id/sync', async (req, res) => {
  try {
    if (!vault.vaultEnabled()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า vault บนเซิร์ฟเวอร์' });
    const row = await dbGet('SELECT id FROM posts WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบบทความนี้' });
    const r = await syncPostToVault(req.params.id);
    res.json({ vault: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// markdown ที่จะถูกเขียนจริง (ฝั่ง server เป็นตัวตัดสิน) — ใช้เทียบกับ preview ในหน้าเว็บ
app.get('/api/posts/:id/markdown', async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM posts WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบบทความนี้' });
    const post = postFromRow(row);
    res.json({ path: vault.postPath(post), markdown: vault.postToMarkdown(post) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── กราฟในบทความ ───────────────────────────────────────────────────────────
// วาดฝั่งเซิร์ฟเวอร์เป็น SVG แล้วใช้ได้ทั้งหน้าอ่าน / ตัวอย่างใน editor / Obsidian
// ⚠️ ยอดผลิตต้องกรองก่อนรวม — ข้อมูลจริงมีทั้งหน่วย "กล่อง" และ "หม้อ" ปนกัน
//    และมีทั้ง approved / pending_review / rejected เอามาบวกดิบ ๆ ได้ตัวเลขมั่ว
const CHART_UNIT = 'กล่อง';
const nDaysAgo = (n) => {
  const d = new Date(`${workDayBKK()}T12:00:00`);
  d.setDate(d.getDate() - (n - 1));
  return d.toLocaleDateString('en-CA');
};

async function chartData(q) {
  const kind = q.k === 'line' ? 'line' : 'bar';
  const days = Math.min(Math.max(Number(q.d) || 14, 2), 90);
  const title = String(q.t || '').slice(0, 120);
  const src = String(q.s || 'manual');

  if (src === 'production-daily') {
    const rows = await dbAll(
      `SELECT work_day, SUM(prod_qty) AS total FROM production_reports
        WHERE work_day >= ? AND status = 'approved' AND count_unit = ?
        GROUP BY work_day ORDER BY work_day`, [nDaysAgo(days), CHART_UNIT]);
    return {
      title: title || `ยอดผลิตรายวัน ${days} วันล่าสุด`,
      kind,
      unit: CHART_UNIT,
      labels: rows.map(r => String(r.work_day).slice(5)),
      series: [{ name: 'ยอดผลิต', values: rows.map(r => Number(r.total) || 0) }],
    };
  }
  if (src === 'production-machine') {
    const rows = await dbAll(
      `SELECT machine, SUM(prod_qty) AS total FROM production_reports
        WHERE work_day >= ? AND status = 'approved' AND count_unit = ?
        GROUP BY machine ORDER BY total DESC`, [nDaysAgo(days), CHART_UNIT]);
    const keep = rows.filter(r => r.machine).slice(0, 8);
    return {
      title: title || `ยอดผลิตแยกตามเครื่อง ${days} วันล่าสุด`,
      kind,
      unit: CHART_UNIT,
      labels: keep.map(r => r.machine),
      series: [{ name: 'ยอดผลิต', values: keep.map(r => Number(r.total) || 0) }],
    };
  }
  if (src === 'tasks-daily') {
    const rows = await dbAll(
      `SELECT task_date,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM daily_tasks WHERE task_date >= ?
        GROUP BY task_date ORDER BY task_date`, [nDaysAgo(days)]);
    return {
      title: title || `งานรายวัน ${days} วันล่าสุด`,
      kind,
      unit: 'งาน',
      labels: rows.map(r => String(r.task_date).slice(5)),
      series: [
        { name: 'ทำเสร็จ', values: rows.map(r => Number(r.done) || 0) },
        { name: 'ทั้งหมด', values: rows.map(r => Number(r.total) || 0) },
      ],
    };
  }
  // พิมพ์เอง — ตารางที่คนกรอก แถวแรกคือหัวตาราง ช่องแรกของแต่ละแถวคือชื่อแกน
  let cells = [];
  try { cells = JSON.parse(Buffer.from(String(q.m || ''), 'base64').toString('utf8')); } catch { cells = []; }
  if (!Array.isArray(cells) || cells.length < 2) return { title, kind, labels: [], series: [], unit: '' };
  const head = cells[0].map(c => String(c || '').replace(/<[^>]+>/g, '').trim());
  const body = cells.slice(1).filter(r => Array.isArray(r) && String(r[0] || '').trim());
  return {
    title,
    kind,
    unit: '',
    labels: body.map(r => String(r[0] || '').replace(/<[^>]+>/g, '').trim()),
    series: head.slice(1).map((name, ci) => ({
      name: name || `ชุดที่ ${ci + 1}`,
      values: body.map(r => Number(String(r[ci + 1] || '').replace(/[^0-9.\-]/g, '')) || 0),
    })),
  };
}

app.get('/api/chart.svg', async (req, res) => {
  try {
    const data = await chartData(req.query || {});
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(chartSvg.renderChart(data));
  } catch (e) {
    console.error('[chart] วาดไม่สำเร็จ', e.message);
    res.status(500).type('image/svg+xml').send(chartSvg.renderChart({ title: 'ดึงข้อมูลไม่สำเร็จ', labels: [], series: [] }));
  }
});

// ── หน้าอ่านบทความสาธารณะ (เฟส 5) ──────────────────────────────────────────
// /บทความ            → รายชื่อบทความที่เผยแพร่แล้ว
// /บทความ/<slug>     → ตัวบทความ
// ใช้ middleware แทน app.get('/บทความ') เพราะ path ภาษาไทยที่เบราว์เซอร์ส่งมาเป็น
// percent-encoded ตัว router จับคู่กับสตริงไทยตรง ๆ ไม่ติด — decode เองก่อนแล้วค่อยแยกทาง
const ARTICLE_BASE = '/บทความ';
/* ลิงก์ดูร่าง — เดิมร่างเปิดหน้าอ่านจริงไม่ได้เลย ต้องเผยแพร่ก่อนถึงจะเห็นของจริง
   โทเคนผูกกับ id ของเรื่องนั้น (HMAC ด้วยรหัสผู้ดูแล) — เดาไม่ได้ ไม่ต้องล็อกอิน
   ⚠️ ใครได้ลิงก์ไปก็เปิดได้ ตั้งใจให้เป็นแบบนั้น (ส่งให้หัวหน้าดูก่อนเผยแพร่) */
const previewToken = (id) => require('crypto')
  .createHmac('sha256', String(process.env.ADMIN_PASS || 'admin1234') + '|preview')
  .update(String(id)).digest('hex').slice(0, 20);
app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  let path;
  try { path = decodeURIComponent(req.path || ''); } catch { return next(); }
  if (path !== ARTICLE_BASE && !path.startsWith(ARTICLE_BASE + '/')) return next();
  const slug = path.slice(ARTICLE_BASE.length + 1).replace(/\/+$/, '');
  const send = (html, code = 200) => res.status(code).type('html').send(html);
  try {
    if (!slug) {
      // ต้องดึง cover_url + tags + machine มาด้วย — การ์ดพรีวิวใช้รูปหน้าปกกับแท็ก
      const rows = await dbAll(
        `SELECT id, slug, title, excerpt, author, category, machine, tags, cover_url, updated_at, published_at
           FROM posts WHERE status = 'published'
          ORDER BY COALESCE(published_at, updated_at) DESC`, []);
      // ?cat=<หมวด> = กรองหมวด · ส่งรายการเต็มเข้าไปเสมอเพราะต้องนับจำนวนต่อหมวดให้เมนู/ชิป
      const q = String((req.query && req.query.q) || '').trim();
      const cat = String((req.query && req.query.cat) || '').trim();
      const page = Math.max(1, Number((req.query && req.query.p) || 1) || 1);
      return send(articlePage.renderIndex(rows.map(postFromRow), PUBLIC_URL, { cat, q, page }));
    }
    const row = await dbGet('SELECT * FROM posts WHERE slug = ?', [slug]);
    if (!row) return send(articlePage.renderNotFound(), 404);
    // ยังไม่เผยแพร่ = เปิดได้เฉพาะคนที่ถือลิงก์ดูร่าง
    const isDraft = row.status !== 'published';
    if (isDraft) {
      const t = String((req.query && req.query.preview) || '');
      if (!t || t !== previewToken(row.id)) return send(articlePage.renderNotFound(), 404);
    }
    const post = await approvedPostView(row);   // SOP: โชว์ฉบับที่อนุมัติล่าสุด
    // กราฟต้องดึงข้อมูลก่อน (เป็นงาน async) ตัวเรนเดอร์หน้าเป็นฟังก์ชันธรรมดา
    for (const b of post.blocks || []) {
      if (b.type !== 'chart') continue;
      try {
        b._chart = await chartData({
          k: b.chartKind, s: b.chartSrc, d: b.days, t: b.title,
          m: Buffer.from(JSON.stringify(b.cells || []), 'utf8').toString('base64'),
        });
      } catch (e) { console.error('[chart] ดึงข้อมูลไม่สำเร็จ', e.message); }
    }
    return send(articlePage.renderArticle(post, PUBLIC_URL, { draft: isDraft }));
  } catch (e) {
    console.error('[บทความ] เปิดหน้าไม่สำเร็จ', e.message);
    return send(articlePage.renderNotFound(), 500);
  }
});

app.get('/api/vault/status', (req, res) => {
  const c = vault.vaultConfig();
  res.json({ enabled: vault.vaultEnabled(), repo: c.repo, branch: c.branch });
});

app.post('/api/posts/delete', async (req, res) => {
  const id = req.body?.id;
  if (!id) return res.status(400).json({ error: 'ต้องระบุ id' });
  try {
    // ลบไฟล์ใน vault ก่อน แล้วค่อยลบแถว — ไม่งั้นไม่เหลือ path ให้ตามไปลบ
    const row = await dbGet('SELECT vault_path FROM posts WHERE id = ?', [id]);
    if (row && row.vault_path && vault.vaultEnabled()) {
      try { await vault.unsyncPost(row.vault_path, 'ลบบทความ'); }
      catch (e) { console.error('[vault] ลบไฟล์บทความไม่สำเร็จ', row.vault_path, e.message); }
    }
    await db.exec('DELETE FROM posts WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ ให้ AI เขียนโค้ดลงบล็อก "โค้ดที่รันได้" ════════════════════════════════
// endpoint นี้ไม่ผ่าน runAssistantConversation() เพราะตัวนั้นส่งชุดเครื่องมือ 23 ตัว
// ไปด้วยเสมอและปิดไม่ได้ — งานนี้ต้องการแค่ข้อความเข้า/ข้อความออก ไม่มีเครื่องมือ
// ⚠️ ค่าตั้งต้น 'low' เพราะ Kimi นับ "ความคิด" รวมใน output_tokens
//    วัดจริง 7 ก.ย.: effort medium ใช้ output 15,524 จากเพดาน 16,000 (เกือบชน = เสี่ยงได้โค้ดไม่ครบ)
//    · effort low ใช้ 7,867 เร็วกว่า 24 วินาที และโค้ด WebGL ที่ได้ยังใช้งานได้ครบ
//    ถ้าสลับกลับไป Anthropic ให้ตั้ง SPP_JS_EFFORT=medium (ค่าที่จูนไว้เดิมของ Sonnet 5)
const JS_GEN_EFFORT = process.env.SPP_JS_EFFORT || 'low';

// แยกเป็นฟังก์ชันเล็ก ๆ ไว้ให้ "ผู้ช่วยเขียนทั้งบทความ" (เฟส 2) เรียกต่อได้โดยไม่ต้องรื้อ handler
//
// ⚠️ max_tokens คุม "ความคิด (thinking) + โค้ดที่เขียนออกมา" รวมกัน ไม่ใช่แค่โค้ด
//    เดิมตั้ง 8000 แล้วคำสั่ง WebGL ที่รายละเอียดเยอะ (แถบสี + ท่อ + ป้าย) ชนเพดานจริง
//    ผู้ใช้เห็นเป็น "โค้ดยาวเกินโควตา เลยได้มาไม่ครบ" — 16000 คือค่าที่คู่มือ API แนะนำ
//    สำหรับการเรียกแบบไม่ stream (สูงกว่านี้เสี่ยง HTTP timeout ต้องเปลี่ยนไปใช้ stream)
//    เพดานนี้เป็นแค่ "ห้ามเกิน" ไม่ได้จองโทเคนไว้ล่วงหน้า โหมด 2D สั้น ๆ จึงไม่แพงขึ้นเลย
async function callJsGen(_client, { messages, effort, maxTokens = 16000 }) {
  return ai.createMessage('jsgen', {
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    // ⚠️ ก้อน system ต้องคงที่ 100% ห้ามมีโหมด/วันที่/ความสูงปนเข้ามา ไม่งั้น cache miss ทุกครั้ง
    system: [{ type: 'text', text: jsGenPrompt.JS_GEN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  });
}

app.post('/api/blog/js-gen', async (req, res) => {
  const client = null; // ชั้นกลางเลือกไคลเอนต์เอง — ตัวแปรนี้คงไว้ให้ callJsGen รับพารามิเตอร์เดิม
  // ไม่มีคีย์ = ปิดเฉพาะปุ่มนี้ (503) เขียนโค้ดเองในบล็อกยังทำได้ตามปกติ
  if (!ai.available('jsgen')) {
    return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าคีย์ AI บนเซิร์ฟเวอร์ — เขียนโค้ดเองในบล็อกได้ตามปกติ' });
  }
  if (rateLimited(req.ip, 8, 60000, 'jsgen')) {
    return res.status(429).json({ error: 'สั่งถี่เกินไป รอสักครู่แล้วลองใหม่' });
  }

  const b = req.body || {};
  const prompt = String(b.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'พิมพ์บอกก่อนว่าอยากได้อะไร' });
  // คำสั่งเป็นของที่คนพิมพ์เอง — ยาวเกินให้บอกไปตรง ๆ ดีกว่าตัดเงียบ ๆ
  if (prompt.length > 800) return res.status(400).json({ error: 'คำสั่งยาวเกินไป (เกิน 800 ตัวอักษร) ช่วยสรุปให้สั้นลง' });

  const mode = b.mode === 'calc' ? 'calc' : 'draw';
  const h = Number(b.h) > 0 ? Math.round(Number(b.h)) : 0;
  // ทดลอง 3D — มีความหมายเฉพาะโหมดวาดภาพ อย่าเชื่อ client เป็นแหล่งความจริงเดียว
  const webgl = mode === 'draw' && !!b.webgl;
  // บทความเป็นของที่ระบบดึงมาเอง ตัดเงียบ ๆ ได้
  const context = String(b.context || '').slice(0, 8000);
  const prev = b.previous && b.previous.code
    ? { code: String(b.previous.code).slice(0, 20000), error: String(b.previous.error || '').slice(0, 500) }
    : null;

  // ทุกอย่างที่เปลี่ยนได้อยู่ใน messages ทั้งหมด — หลัง cache breakpoint
  const หัวข้อ = [
    mode === 'draw'
      ? 'โหมด: วาดภาพเคลื่อนไหว (draw)' + (h ? ' · กล่องสูงประมาณ ' + h + ' พิกเซล' : '')
      : 'โหมด: คำนวณ (calc) — ผลลัพธ์ออกทาง console.log และค่าที่ return',
    '',
    'สิ่งที่ต้องการ:',
    prompt,
  ];
  // ข้อความนี้ต้องตรงกับที่ JS_GEN_SYSTEM สอนให้โมเดลมองหาเป๊ะ ๆ ("เทคนิค: WebGL")
  // ไม่งั้นโมเดลจะไม่รู้ว่าต้องสลับเทคนิค — แก้ฝั่งไหนต้องแก้อีกฝั่งด้วย (server/jsGenPrompt.js)
  if (webgl) {
    หัวข้อ.push('', 'เทคนิค: WebGL 3D (ทดลอง) — ใช้ตามตัวอย่างที่ 3 ห้ามใช้ canvas 2D ธรรมดา');
  }
  if (context) {
    หัวข้อ.push('', '── เนื้อหาบทความที่กำลังเขียนอยู่ (ใช้ชื่อขั้นตอน/ตัวเลขจริงจากตรงนี้) ──', context);
  }

  const messages = [{ role: 'user', content: หัวข้อ.join('\n') }];
  if (prev) {
    // รอบซ่อม: สนทนา 3 ท่อน user → assistant(โค้ดเดิม) → user(บอก error) แบบไม่เก็บ state ที่ไหนเลย
    messages.push({ role: 'assistant', content: '```js\n' + prev.code + '\n```' });
    messages.push({
      role: 'user',
      content: [
        'โค้ดข้างบนรันแล้วมีปัญหา:',
        prev.error || '(ไม่มีรายละเอียด)',
        '',
        'แก้เฉพาะจุดที่ทำให้เกิดปัญหานี้ อย่าเขียนใหม่ทั้งหมด อย่าเปลี่ยนดีไซน์',
        'ตอบเป็นโปรแกรมเต็มชุดในบล็อก ```js เหมือนเดิม',
      ].join('\n'),
    });
  }

  const t0 = Date.now();
  try {
    const resp = await callJsGen(client, {
      messages,
      effort: prev ? 'low' : JS_GEN_EFFORT,   // ซ่อมคือแก้จุดเดียวที่รู้ชื่อแล้ว ไม่ต้องคิดเยอะ
    });

    // เช็ก stop_reason ก่อนแตะ content เสมอ — refusal คืน 200 พร้อม content ว่าง
    if (resp.stop_reason === 'refusal') {
      console.warn('[js-gen] refused');
      return res.status(422).json({ error: 'โมเดลไม่ตอบคำสั่งนี้ ลองเปลี่ยนคำสั่งดู' });
    }
    if (resp.stop_reason === 'max_tokens') {
      return res.status(422).json({ error: 'โค้ดยาวเกินโควตา เลยได้มาไม่ครบ — ลองสั่งให้เรียบง่ายลง' });
    }

    const text = (resp.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const { code, note } = jsGenPrompt.extractCode(text);

    const u = resp.usage || {};
    console.log('[js-gen] in=%s out=%s cache_read=%s cache_write=%s ms=%s repair=%s mode=%s',
      u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens,
      Date.now() - t0, prev ? 1 : 0, mode);

    res.json({ code, note, repair: !!prev, ms: Date.now() - t0 });
  } catch (e) {
    // e.extract = คำตอบมาแล้วแต่แกะไม่ได้ (422) · ที่เหลือคือ upstream ล้ม (502)
    console.error('[js-gen] failed', e.message);
    res.status(e.status || (e.extract ? 422 : 502)).json({ error: e.message || 'เรียกโมเดลไม่สำเร็จ' });
  }
});

// ═══ คลังไฟล์ (เฟส 2) ═══════════════════════════════════════════════════════
// ไฟล์อยู่บน Supabase Storage (ฝั่งเว็บอัปเอง — เซิร์ฟเวอร์ไม่มีคีย์ Supabase)
// เซิร์ฟเวอร์เก็บแค่ทะเบียน: ชื่อจริง / โฟลเดอร์ / แท็ก / คำบรรยาย เพื่อให้ค้นเจอ
// "ลบ" ที่นี่ = เอาออกจากทะเบียนเท่านั้น ไฟล์ยังอยู่ในที่เก็บ (ไม่มีสิทธิ์ลบจากตรงนี้)
const MEDIA_FIELDS = ['url', 'path', 'name', 'mime', 'size', 'folder', 'tags', 'caption', 'uploaded_by'];

const mediaTags = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };

const mediaFromRow = (r) => ({
  id: r.id,
  url: r.url || '',
  path: r.path || '',
  name: r.name || '',
  mime: r.mime || '',
  size: Number(r.size || 0),
  folder: r.folder || '',
  tags: mediaTags(r.tags),
  caption: r.caption || '',
  uploadedBy: r.uploaded_by || '',
  createdAt: r.created_at || '',
});

// ค่าที่จะเขียนลงตาราง — ใช้ร่วมกันทั้งตอนลงทะเบียนไฟล์ใหม่และตอนสแกนของเก่า
const mediaVals = (b) => ({
  url: String(b.url || '').trim(),
  path: String(b.path || '').trim(),
  name: String(b.name || '').trim() || String(b.path || '').trim() || 'ไม่มีชื่อ',
  mime: String(b.mime || '').trim(),
  size: Number(b.size) > 0 ? Math.round(Number(b.size)) : 0,
  folder: String(b.folder || '').trim(),
  tags: JSON.stringify(Array.isArray(b.tags) ? b.tags.map(String) : []),
  caption: String(b.caption || '').trim(),
  uploaded_by: String(b.uploadedBy || '').trim(),
});

// ลงทะเบียนไฟล์ 1 ตัว — url ซ้ำ = ของเดิม ไม่สร้างแถวใหม่ (กันซ้ำตอนสแกนหลายรอบ)
// keepExisting = ตอนสแกนของเก่า: ห้ามทับชื่อ/แท็กที่คนตั้งไว้แล้วด้วยค่าว่าง
async function registerMedia(body, { keepExisting = false } = {}) {
  const v = mediaVals(body);
  if (!v.url) throw new Error('ต้องมี url ของไฟล์');
  const cur = await dbGet('SELECT * FROM media_files WHERE url = ?', [v.url]);
  if (cur) {
    if (!keepExisting) {
      await db.exec(
        `UPDATE media_files SET ${MEDIA_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE url = ?`,
        [...MEDIA_FIELDS.map(f => v[f]), v.url]);
    }
    return mediaFromRow(await dbGet('SELECT * FROM media_files WHERE url = ?', [v.url]));
  }
  await db.exec(
    `INSERT INTO media_files (${MEDIA_FIELDS.join(', ')}, created_at)
     VALUES (${MEDIA_FIELDS.map(() => '?').join(', ')}, ?)`,
    [...MEDIA_FIELDS.map(f => v[f]), String(body.createdAt || '').trim() || nowBKK()]);
  return mediaFromRow(await dbGet('SELECT * FROM media_files WHERE url = ?', [v.url]));
}

app.get('/api/media', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const folder = String(req.query.folder || '').trim();
    const kind = String(req.query.kind || '').trim();   // image | pdf | other
    const kindSql = kind === 'image' ? "mime LIKE 'image/%'"
      : kind === 'pdf' ? "mime LIKE '%pdf%'"
        : kind === 'other' ? "(mime NOT LIKE 'image/%' AND mime NOT LIKE '%pdf%')" : '';
    const where = [];
    const params = [];
    if (q) {
      where.push('(LOWER(name) LIKE ? OR LOWER(caption) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(folder) LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (folder) { where.push('folder = ?'); params.push(folder); }
    if (kindSql) where.push(kindSql);
    const rows = await dbAll(
      `SELECT * FROM media_files ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC, id DESC LIMIT 500`, params);
    // จำนวนต่อโฟลเดอร์ข้างเมนูซ้าย — ไม่นับคำค้น/โฟลเดอร์ที่เลือกอยู่ (ไม่งั้นตัวเลขจะเป็น 0 หมด)
    // แต่ต้องนับตามชนิดที่กรองไว้ ไม่งั้นกดโฟลเดอร์ที่ขึ้นว่ามี 2 แล้วเจอศูนย์ไฟล์
    const counts = await dbAll(
      `SELECT folder, COUNT(*) AS n FROM media_files ${kindSql ? 'WHERE ' + kindSql : ''} GROUP BY folder`, []);
    res.json({
      items: rows.map(mediaFromRow),
      folders: counts.map(c => ({ folder: c.folder || '', n: Number(c.n) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/media', async (req, res) => {
  try { res.json({ item: await registerMedia(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// สแกนของเก่า — หน้าเว็บอ่านรายการไฟล์จาก bucket แล้วส่งมาลงทะเบียนทีเดียว
// ของที่มีในทะเบียนแล้วจะไม่ถูกแตะ (ชื่อ/แท็กที่คนตั้งไว้ต้องอยู่เหมือนเดิม)
app.post('/api/media/import', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'ไม่มีรายการไฟล์ส่งมา' });
  let added = 0, skipped = 0;
  try {
    for (const it of items.slice(0, 1000)) {
      const url = String(it?.url || '').trim();
      if (!url) { skipped++; continue; }
      const cur = await dbGet('SELECT id FROM media_files WHERE url = ?', [url]);
      if (cur) { skipped++; continue; }
      await registerMedia(it, { keepExisting: true });
      added++;
    }
    res.json({ ok: true, added, skipped });
  } catch (e) { res.status(500).json({ error: e.message, added, skipped }); }
});

// แก้ทะเบียน (ชื่อ / โฟลเดอร์ / แท็ก / คำบรรยาย) — ส่งมาเฉพาะช่องที่จะแก้
app.patch('/api/media/:id', async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  if (b.name !== undefined) { sets.push('name = ?'); params.push(String(b.name).trim() || 'ไม่มีชื่อ'); }
  if (b.folder !== undefined) { sets.push('folder = ?'); params.push(String(b.folder).trim()); }
  if (b.caption !== undefined) { sets.push('caption = ?'); params.push(String(b.caption).trim()); }
  if (b.tags !== undefined) {
    sets.push('tags = ?');
    params.push(JSON.stringify(Array.isArray(b.tags) ? b.tags.map(String) : []));
  }
  if (!sets.length) return res.status(400).json({ error: 'ไม่มีอะไรให้แก้' });
  try {
    const row = await dbGet('SELECT id FROM media_files WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบไฟล์นี้ในคลัง' });
    await db.exec(`UPDATE media_files SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    res.json({ item: mediaFromRow(await dbGet('SELECT * FROM media_files WHERE id = ?', [req.params.id])) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/media/delete', async (req, res) => {
  const id = req.body?.id;
  if (!id) return res.status(400).json({ error: 'ต้องระบุ id' });
  try {
    await db.exec('DELETE FROM media_files WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Obsidian สองทาง: งานค้าง ↔ บันทึกประจำวันใน vault ════════════════════════
// ขาออก — งานเปลี่ยนในแอป → เขียนลงเขต marker ในบันทึกประจำวัน (หน่วงรวมก่อนเขียน)
// ขาเข้า — คนติ๊กใน Obsidian → Obsidian Git push → GitHub webhook → ปิดงานตาม
// นโยบาย: ติ๊กปิด = ทำเลย · ปลดติ๊ก / แก้ข้อความ / งานใหม่ = เข้ากล่องรอคนยืนยัน
//   เหตุผล: เผลอปัดโดนบนมือถือแล้วงานที่ปิดไปแล้วกลับมา เป็นความเสียหายที่มองไม่เห็น

// จำ sha ของไฟล์ที่เราเขียนเอง — ใช้กันวนลูปตอน webhook เด้งกลับมาจาก push ของเราเอง
async function vaultRemember(path, sha) {
  if (!path || !sha) return;
  try {
    await db.exec(
      `INSERT INTO vault_files (path, sha, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET sha = excluded.sha, updated_at = excluded.updated_at`,
      [path, sha, nowBKK()]);
  } catch (e) { console.error('[vault] จด sha ไม่สำเร็จ', path, e.message); }
}
async function vaultIsOurs(path, sha) {
  if (!sha) return false;
  const row = await dbGet('SELECT sha FROM vault_files WHERE path = ?', [path]);
  return !!row && row.sha === sha;
}

const tasksOfDate = (date) => dbAll(
  `SELECT id, title, status, category, machine, location, line_name, task_date, completed_at
     FROM daily_tasks WHERE task_date = ? ORDER BY id`, [date]);

// เขียนงานของวันนั้นลง vault — แตะเฉพาะในเขต marker ข้อความที่คนเขียนเองไม่หาย
async function syncTasksToVault(date) {
  if (!vault.vaultEnabled() || !date) return { enabled: false };
  const path = vault.dailyNotePath(date);
  try {
    const tasks = await tasksOfDate(date);
    const cur = await vault.vaultRead(path);
    // วันที่ยังไม่มีงานเลยและยังไม่เคยมีไฟล์ = ไม่ต้องสร้างไฟล์เปล่าทิ้งไว้ให้รก
    // (ถ้ามีไฟล์อยู่แล้วยังต้องเขียน เพราะงานอาจเพิ่งถูกลบออกหมด)
    if (!tasks.length && !cur) return { enabled: true, ok: true, path, count: 0, skipped: true };
    const content = vault.buildDailyNote(cur ? cur.text : '', date, tasks);
    const r = await vault.vaultWrite(path, content, `งานค้าง: ${date}`);
    await vaultRemember(path, r.sha);
    return { enabled: true, ok: true, path, count: tasks.length, skipped: !!r.skipped };
  } catch (e) {
    console.error('[vault] เขียนงานค้างไม่สำเร็จ', date, e.message);
    return { enabled: true, ok: false, path, error: String(e.message || e).slice(0, 300) };
  }
}

// หน่วงก่อนเขียน — ติ๊กงานรัวๆ ในแอปไม่ควรกลายเป็น commit ละครั้ง
const vaultTaskTimers = new Map();
function scheduleVaultTaskSync(date, delayMs = 45000) {
  if (!vault.vaultEnabled() || !date) return;
  clearTimeout(vaultTaskTimers.get(date));
  vaultTaskTimers.set(date, setTimeout(() => {
    vaultTaskTimers.delete(date);
    syncTasksToVault(date).catch(e => console.error('[vault] task sync', e.message));
  }, delayMs));
}
// เรียกจาก endpoint ที่รู้แค่ id ของงาน
async function scheduleVaultSyncForTask(id) {
  if (!vault.vaultEnabled() || !id) return;
  try {
    const row = await dbGet('SELECT task_date FROM daily_tasks WHERE id = ?', [id]);
    if (row) scheduleVaultTaskSync(row.task_date);
  } catch { /* ไม่ใช่เรื่องคอขาดบาดตาย */ }
}

const normTitle = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// เพิ่มรายการเข้ากล่องรอยืนยัน — ซ้ำของเดิม (คนยังไม่แตะไฟล์) จะถูก UNIQUE กันไว้เอง
async function inboxAdd(kind, taskId, filePath, line, title, date, author) {
  try {
    await db.exec(
      `INSERT INTO vault_inbox (kind, task_id, file_path, line_text, proposed_title, task_date, author, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (kind, task_id, line_text) DO NOTHING`,
      [kind, taskId || 0, filePath, line, title || '', date || '', author || '', nowBKK()]);
  } catch (e) { console.error('[vault] inbox add', e.message); }
}

// อ่านไฟล์บันทึกประจำวันที่คนแก้มา แล้วเทียบกับงานใน DB ทีละบรรทัด
async function reconcileNote(path, text, author) {
  const date = (path.match(/(\d{4}-\d{2}-\d{2})\.md$/) || [])[1] || todayBKK();
  const closed = [];
  let pending = 0;
  for (const raw of String(text || '').split('\n')) {
    const p = vault.parseTaskLine(raw);
    if (!p) continue;
    if (!p.id) {
      // บรรทัดที่คนจดเองในมือถือ — ยังไม่มีในระบบ (ที่ติ๊กแล้วถือว่าจบไปแล้ว ไม่ต้องรับเข้ามา)
      if (!p.done && p.title) { await inboxAdd('new', 0, path, raw.trim(), p.title, date, author); pending++; }
      continue;
    }
    const t = await dbGet('SELECT id, title, status FROM daily_tasks WHERE id = ?', [p.id]);
    if (!t) continue;                                   // งานถูกลบในแอปไปแล้ว
    const isDone = t.status === 'done';
    if (p.done && !isDone) {
      // ติ๊กปิด = การกดของคน ปิดแล้วปิดเลย ไม่มีทางพัง → ทำให้เลย
      await db.exec('UPDATE daily_tasks SET status = ?, completed_at = ?, done_by = COALESCE(done_by, ?) WHERE id = ?',
        ['done', nowBKK(), author || 'Obsidian', p.id]);
      // จดไว้ว่างานนี้ปิดเพราะติ๊กใน Obsidian — done_by อย่างเดียวแยกไม่ออกจากงานที่ปิดในแอปเอง
      await inboxAdd('closed', p.id, path, raw.trim(), t.title, date, author);
      closed.push({ id: p.id, title: t.title });
    } else if (!p.done && isDone) {
      await inboxAdd('reopen', p.id, path, raw.trim(), t.title, date, author); pending++;
    }
    if (p.title && normTitle(p.title) !== normTitle(t.title)) {
      await inboxAdd('edit', p.id, path, raw.trim(), p.title, date, author); pending++;
    }
  }
  return { date, closed, pending };
}

// ดึงไฟล์จาก vault มา reconcile เอง — ใช้เป็นตาข่ายกันพลาดตอน webhook หลุด
async function reconcileFromVault(date) {
  if (!vault.vaultEnabled()) return { enabled: false };
  const path = vault.dailyNotePath(date);
  const cur = await vault.vaultRead(path);
  if (!cur) return { enabled: true, missing: true, path };
  if (await vaultIsOurs(path, cur.sha)) return { enabled: true, path, unchanged: true };
  const r = await reconcileNote(path, cur.text, 'Obsidian');
  await vaultRemember(path, cur.sha);
  if (r.closed.length) scheduleVaultTaskSync(date, 5000);
  return { enabled: true, path, ...r };
}

// ── ขาเข้าจาก GitHub ────────────────────────────────────────────────────────
// GitHub ไม่ retry ให้อัตโนมัติ ถ้าพลาดต้องพึ่ง reconcile รอบชั่วโมงข้างล่าง
app.post('/api/obsidian/webhook', async (req, res) => {
  const secret = vault.vaultConfig().webhookSecret;
  if (!secret) return res.status(503).json({ error: 'ยังไม่ได้ตั้ง VAULT_WEBHOOK_SECRET' });
  // ลายเซ็นคิดจาก "ไบต์ดิบ" ของ body — เอา JSON ที่ parse แล้วมา stringify ใหม่ลายเซ็นจะไม่ตรง
  const sig = req.get('X-Hub-Signature-256') || '';
  const mine = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('hex');
  const ok = sig.length === mine.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mine));
  if (!ok) {
    // ไม่บอกค่าจริงออกไป แต่บอกความยาวไว้ใน log — ไล่หาสาเหตุ "รหัสสองฝั่งไม่ตรง" ได้เร็วขึ้นมาก
    console.warn(`[vault] ลายเซ็น webhook ไม่ตรง — รหัสที่ตั้งไว้ยาว ${secret.length} ตัวอักษร`);
    return res.status(401).json({ error: 'ลายเซ็นไม่ถูกต้อง' });
  }
  if (req.get('X-GitHub-Event') === 'ping') return res.json({ ok: true, pong: true });

  const body = req.body || {};
  const branch = vault.vaultConfig().branch;
  if (body.ref && body.ref !== `refs/heads/${branch}`) return res.json({ ok: true, ignored: 'คนละ branch' });
  res.json({ ok: true });                       // ตอบ GitHub ก่อน แล้วค่อยทำงานต่อ (กัน timeout)

  try {
    const author = (body.head_commit && body.head_commit.author && body.head_commit.author.name)
      || (body.pusher && body.pusher.name) || 'Obsidian';
    const paths = new Set();
    for (const c of body.commits || []) {
      for (const p of [...(c.added || []), ...(c.modified || [])]) {
        if (p.startsWith('บันทึกประจำวัน/') && p.endsWith('.md')) paths.add(p);
      }
    }
    for (const path of paths) {
      const cur = await vault.vaultRead(path);
      if (!cur) continue;
      if (await vaultIsOurs(path, cur.sha)) continue;   // push ของระบบเอง — ไม่ต้องอ่านซ้ำ
      const r = await reconcileNote(path, cur.text, author);
      await vaultRemember(path, cur.sha);
      console.log(`[vault] webhook ${path} — ปิดงาน ${r.closed.length} รอยืนยัน ${r.pending}`);
      if (r.closed.length) scheduleVaultTaskSync(r.date, 5000);
    }
  } catch (e) { console.error('[vault] webhook error', e.message); }
});

// ── กล่องรอยืนยัน ───────────────────────────────────────────────────────────
app.get('/api/obsidian/inbox', async (req, res) => {
  try {
    const items = await dbAll(
      `SELECT * FROM vault_inbox WHERE status = 'pending' AND kind <> 'closed'
        ORDER BY created_at DESC, id DESC LIMIT 100`, []);
    // เอาเฉพาะที่ปิดเพราะติ๊กใน Obsidian จริง ๆ — งานที่ปิดในแอปเองไม่ควรมาโผล่ในนี้
    const done = await dbAll(
      `SELECT id, task_id, proposed_title, author, created_at FROM vault_inbox
        WHERE kind = 'closed' ORDER BY id DESC LIMIT 20`, []);
    res.json({
      enabled: vault.vaultEnabled(),
      items,
      closedFromVault: done.map(r => ({
        id: r.task_id || r.id, title: r.proposed_title, done_by: r.author, completed_at: r.created_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/obsidian/inbox/decide', async (req, res) => {
  const { id, accept, operator } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ต้องระบุ id' });
  try {
    const it = await dbGet('SELECT * FROM vault_inbox WHERE id = ?', [id]);
    if (!it) return res.status(404).json({ error: 'ไม่พบรายการนี้' });
    if (it.status !== 'pending') return res.status(409).json({ error: 'รายการนี้ตัดสินไปแล้ว' });

    if (accept) {
      if (it.kind === 'reopen') {
        await db.exec("UPDATE daily_tasks SET status = 'pending', completed_at = NULL WHERE id = ?", [it.task_id]);
      } else if (it.kind === 'edit') {
        await db.exec('UPDATE daily_tasks SET title = ? WHERE id = ?', [it.proposed_title, it.task_id]);
      } else if (it.kind === 'new') {
        await db.exec(
          `INSERT INTO daily_tasks (task_date, line_name, category, title, status, source, created_by, created_at)
           VALUES (?, '', 'manual', ?, 'pending', 'obsidian', ?, ?)`,
          [it.task_date || todayBKK(), it.proposed_title, it.author || 'Obsidian', nowBKK()]);
        // ลบบรรทัดที่คนจดเองออก — เดี๋ยวงานนี้จะไปโผล่ในเขตที่ระบบดูแลพร้อมรหัส ^spp- แทน
        try {
          const cur = await vault.vaultRead(it.file_path);
          if (cur) {
            const next = vault.removeLine(cur.text, it.line_text);
            if (next !== cur.text) {
              const w = await vault.vaultWrite(it.file_path, next, `รับงานจาก Obsidian เข้าระบบ: ${it.proposed_title}`);
              await vaultRemember(it.file_path, w.sha);
            }
          }
        } catch (e) { console.error('[vault] ลบบรรทัดงานใหม่ไม่สำเร็จ', e.message); }
      }
    }
    await db.exec('UPDATE vault_inbox SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?',
      [accept ? 'accepted' : 'rejected', nowBKK(), operator || '', id]);
    scheduleVaultTaskSync(it.task_date || todayBKK(), 5000);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ปุ่ม "sync เดี๋ยวนี้" ของงานค้าง — อ่านของใน vault ก่อน แล้วค่อยเขียนทับ
app.post('/api/obsidian/sync-tasks', async (req, res) => {
  const date = req.body?.date || todayBKK();
  try {
    const inbound = await reconcileFromVault(date);
    const outbound = await syncTasksToVault(date);
    res.json({ date, inbound, outbound });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ตาข่ายกันพลาด: reconcile + เขียนทับชั่วโมงละครั้ง เกาะ tick เดิมที่มีอยู่แล้ว
// (ห้ามเพิ่ม polling ใหม่ — เคยชน Render 750 instance-hours มาแล้ว)
let lastVaultTickHour = '';
async function vaultTick() {
  if (!vault.vaultEnabled()) return;
  const hour = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 13);
  if (hour === lastVaultTickHour) return;
  lastVaultTickHour = hour;
  try {
    const date = todayBKK();
    await reconcileFromVault(date);
    await syncTasksToVault(date);
  } catch (e) { console.error('[vault] tick error', e.message); }
}

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
  __test_sppShiftNudgeTick: sppShiftNudgeTick,
  __test_parsePlanHeader: parsePlanHeader, __test_looksLikePlanText: looksLikePlanText,
  __test_parsePlanItems: parsePlanItems,
  __test_resolveSku: resolveSku, __test_normAlias: normAlias, __test_normMachine: normMachine,
  buildShiftCardData, runShiftAnalysis, getQualitySpecs, setQualitySpec, formatThaiDate,
  __test_pmNotifyTick: pmNotifyTick, __test_buildPmNotify: buildPmNotify,
  __test_runNotifyTick: runNotifyTick, __test_buildRunNotify: buildRunNotify, __test_initDb: initDb,
  __test_machineBlock: machineBlock, __test_cascadeMachineRename: cascadeMachineRename };

if (require.main === module) {
  initDb()
    .then(() => {
      app.listen(port, '0.0.0.0', () => {
        console.log(`Server running at http://0.0.0.0:${port}`);
        // ปิดไว้ชั่วคราว — Telegram อนุญาตแค่ webhook เดียวต่อบอท และ n8n's Telegram Trigger
        // (n8n-Telegram-Production-Chart.json) ใช้บอทตัวเดียวกันสำหรับ "สรุปยอดผลิตวันนี้"
        // เปิดอีกครั้งได้เมื่อ n8n ฝั่งนั้น deactivate ไปแล้วจริงๆ หรือออกแบบให้ทำงานร่วมกันแล้ว
        // registerTelegramWebhook();
        // บอท SPP เป็นคนละบอท จึงตั้ง webhook ของตัวเองได้โดยไม่ชนกับข้างบน
        // (แต่ต้องปิด Telegram Trigger ใน n8n v4 ก่อน เพราะใช้บอทตัวเดียวกัน)
        registerSppWebhook();
        // บอทซ่อมบำรุง — คนละบอทอีกตัว แอปเป็นเจ้าของ webhook เอง (ไม่ต้องผ่าน Duty Gate ใน n8n)
        registerMaintWebhook();
        // ตัวจับเวลาส่งรายงานอัตโนมัติ + วิเคราะห์สิ้นกะ (เฟส 1) — เช็กทุกนาที (ต้องให้เซิร์ฟเวอร์ตื่นอยู่; มี Keep-Warm ping ช่วย)
        setInterval(() => { reportTick(); reminderTick(); shiftAnalysisTick(); kpiReportTick(); kpiAlertTick(); qualityWatchTick(); sheetSyncTick(); sppShiftNudgeTick(); vaultTick(); pm.pmSyncTick(); pmNotifyTick(); runNotifyTick(); }, 60 * 1000);
        console.log('[report] scheduler started (every 60s) + shift-analysis');
      });
    })
    .catch((err) => {
      console.error('[db] init failed — server not started', err);
      process.exit(1);
    });
}
