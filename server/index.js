require('dotenv').config();
const express = require('express');
const db = require('./db');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const Anthropic = require('@anthropic-ai/sdk');
const { renderShiftCardPNG, renderKpiCardPNG, canRenderCard, renderBeforeAfterCardPNG } = require('./shiftCard');
const vault = require('./vault');
const articlePage = require('./articlePage');
const chartSvg = require('./chartSvg');
const jsGenPrompt = require('./jsGenPrompt');

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
  // ── ค่ามาตรฐานคุณภาพ (baseline) ต่อรสชาติ — ผู้ใช้ตั้งเอง ให้เตือน Brix/pH เฉพาะที่ผิดจริง
  `CREATE TABLE IF NOT EXISTS quality_specs (
      flavor TEXT UNIQUE,
      brix_min REAL,
      brix_max REAL,
      ph_min REAL,
      ph_max REAL,
      updated_at TEXT
    )`,
  // ── สถานะ "กำลังรอรูปหลังทำ" ต่อผู้ใช้ Telegram — กดปุ่ม 📸 แล้วส่งรูปงานเข้ามา
  // 1 แถวต่อ (chat_id, user_id) — เก็บว่ากำลังแนบรูปของงาน task_id ไหน (เก็บ DB กัน Render restart หาย)
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
  // migration (KM): ที่อยู่ไฟล์โน้ตของเครื่องจักรใน vault — ใช้ย้าย/ลบไฟล์เก่าตอนเปลี่ยนชื่อเครื่อง
  try { await db.exec('ALTER TABLE machines ADD COLUMN vault_path TEXT'); } catch { /* มีแล้ว */ }
  // migration (ERP เฟส 3): ค่าเสียโอกาสต่อชั่วโมงของเครื่องนี้ (ว่าง = ใช้ค่ากลางจาก cost_config)
  try { await db.exec('ALTER TABLE machines ADD COLUMN downtime_cost REAL'); } catch { /* มีแล้ว */ }
  // seed แถวตั้งค่าต้นทุน (แถวเดียว เหมือน report_config)
  try {
    const cc = await dbAll('SELECT id FROM cost_config LIMIT 1', []);
    if (!cc.length) await db.exec('INSERT INTO cost_config (downtime_per_hour, note, updated_at) VALUES (0, ?, ?)',
      ['ยังไม่ได้ตั้งค่าเสียโอกาสต่อชั่วโมง', nowBKK()]);
  } catch { /* ช่างมัน */ }
  // migration (โซนซ่อมบำรุง): ช่องใหม่ของงานประจำตามตารางจริง
  //   machine = เครื่องจักร · goal = เป้าหมาย · owner_role/co_owner_role = บทบาทผู้รับผิดชอบหลัก/รอง
  //   ค่า role: 'mt' Maintenance · 'op' Operate · 'qc' QC · 'pd' พนักงานผลิต (NULL = งานเก่าที่ไม่ได้ระบุ)
  for (const col of ['machine', 'goal', 'owner_role', 'co_owner_role']) {
    try { await db.exec(`ALTER TABLE duty_routines ADD COLUMN ${col} TEXT`); } catch { /* มีแล้ว */ }
  }
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
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = toChatId || process.env.TELEGRAM_CHAT_ID;
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
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
    const rows = await dbAll('SELECT name, role, pin FROM operators ORDER BY name', []);
    if (req.query.withRole !== '1') return res.json(rows.map(r => r.name));
    res.json({
      operators: rows.map(r => ({ name: r.name, role: r.role || 'operator', hasPin: !!r.pin })),
      roles: ROLES,
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
app.get('/api/shift-crew', async (req, res) => {
  try {
    const rows = await dbAll('SELECT shift, name FROM shift_crew WHERE active = 1 ORDER BY sort_order', []);
    const byShift = {};
    for (const r of rows) (byShift[r.shift] = byShift[r.shift] || []).push(r.name);
    res.json({ shifts: byShift });
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
const SPP_PARSE_MODEL = process.env.SPP_PARSE_MODEL || 'claude-opus-5';

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
  const client = getAnthropic();
  if (!client) return null;

  try {
    const resp = await client.messages.create({
      model: SPP_PARSE_MODEL,
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
    if (!getAnthropic()) {
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
  if (!getAnthropic()) return sppSend(chatId, '⚠️ ยังตั้งค่า AI ไม่เสร็จ — ดูย้อนหลังที่หน้า "ประวัติยอดผลิต" ในเว็บได้');
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

app.post('/api/tasks/update', (req, res) => {
  const { id, status, actualCount, title, detail, doneBy } = req.body;
  if (!id) return res.status(400).json({ error: 'id จำเป็น' });
  const completedAt = status === 'done' ? nowBKK() : null;
  // ปิดงานพร้อมแนบรูปหลังทำ (หน้าติดตามผลใบตรวจ) — ไม่ส่งมาก็ไม่แตะของเดิม (COALESCE)
  const di = filterImgs(req.body.doneImages);
  db.run(`UPDATE daily_tasks SET
      status = COALESCE(?, status),
      actual_count = COALESCE(?, actual_count),
      title = COALESCE(?, title),
      detail = COALESCE(?, detail),
      done_images = COALESCE(?, done_images),
      done_by = COALESCE(?, done_by),
      completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END
    WHERE id = ?`,
    [status || null, actualCount == null ? null : Number(actualCount), title || null, detail || null,
      di.length ? JSON.stringify(di) : null, doneBy || null, status || '', completedAt, id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
      scheduleVaultSyncForTask(id);
    });
});

// ย้ายงานมอบหมายไปให้อีกคน (ลากการ์ดในบอร์ดหน้าที่)
// ต้องอัปเดตทั้ง assignee และ line_name เพราะงานมอบหมายเก็บ line_name = คนรับ
// (UNIQUE(task_date, line_name, category, title) คือตัวที่ทำให้งานชื่อเดียวกันมอบหลายคนได้)
app.post('/api/tasks/reassign', async (req, res) => {
  const { id, assignTo, operator } = req.body;
  if (!id || !assignTo) return res.status(400).json({ error: 'id/assignTo จำเป็น' });
  try {
    const row = (await dbAll('SELECT task_date, category, title, assignee, priority FROM daily_tasks WHERE id = ?', [id]))[0];
    if (!row) return res.status(404).json({ error: 'ไม่พบงานนี้' });
    if (row.assignee === assignTo) return res.json({ success: true, unchanged: true });
    // กันชนกับงานชื่อเดียวกันที่ปลายทางมีอยู่แล้ว — ไม่กันจะติด UNIQUE แล้ว error ดิบๆ
    const dup = (await dbAll('SELECT id FROM daily_tasks WHERE task_date = ? AND line_name = ? AND category = ? AND title = ?',
      [row.task_date, assignTo, row.category, row.title]))[0];
    if (dup) return res.status(409).json({ error: 'duplicate', message: `${dutyName(assignTo)} มีงาน "${row.title}" อยู่แล้ว` });
    await db.exec('UPDATE daily_tasks SET assignee = ?, line_name = ? WHERE id = ?', [assignTo, assignTo, id]);
    res.json({ success: true, from: row.assignee, to: assignTo });
    if (process.env.TELEGRAM_CHAT_ID) {
      sendToTelegram(`🔁 <b>ย้ายงาน</b>\n${catIcon(row.category)} ${escapeHtml(row.title)}${row.priority === 'urgent' ? '  🔴 <b>ด่วน</b>' : ''}\n\n`
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
async function refreshPeopleCache() {
  try {
    _peopleCache = await dbAll('SELECT * FROM duty_people WHERE active = 1 ORDER BY sort_order, created_at', []);
  } catch { _peopleCache = []; }
  for (const k of Object.keys(_peopleNameMap)) delete _peopleNameMap[k];
  for (const k of Object.keys(_peopleDotMap)) delete _peopleDotMap[k];
  for (const p of _peopleCache) { _peopleNameMap[p.person_key] = p.name; _peopleDotMap[p.person_key] = p.dot || '👤'; }
}
const dutyName = (k) => _peopleNameMap[k] || k;
const dutyDot = (k) => _peopleDotMap[k] || '👤';
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
// ══ Knowledge management ═════════════════════════════════════════════════════
// ทะเบียนเครื่องจักร (ERP Phase 1) — ชื่อเครื่องใช้เป็น [[wikilink]] ปลายทางของโน้ตใน vault
app.get('/api/machines', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM machines WHERE active = 1 ORDER BY sort_order, id', []);
    // นับงาน PM ที่ผูกกับเครื่องนี้ + เหตุการณ์ที่ยังไม่ปิด — ให้หน้าทะเบียนเห็นภาพโดยไม่ต้องยิงซ้ำ
    const pm = await dbAll("SELECT machine, COUNT(*) AS n FROM duty_routines WHERE active = 1 AND machine IS NOT NULL AND machine <> '' GROUP BY machine", []);
    const inc = await dbAll("SELECT machine, COUNT(*) AS n FROM incidents WHERE status = 'open' AND machine IS NOT NULL AND machine <> '' GROUP BY machine", []);
    const nOf = (list, name) => Number((list.find(x => x.machine === name) || {}).n || 0);
    res.json({
      machines: rows.map(r => ({
        id: r.id, code: r.code || '', name: r.name, line: r.line_name || '',
        installedAt: r.installed_at || '', lastPm: r.last_pm || '', note: r.note || '',
        vaultPath: r.vault_path || '',
        pmCount: nOf(pm, r.name), openIncidents: nOf(inc, r.name),
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/machines', async (req, res) => {
  const { id, code, name, line, installedAt, lastPm, note } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name จำเป็น' });
  try {
    let rowId = id;
    if (id) {
      await db.exec('UPDATE machines SET code = ?, name = ?, line_name = ?, installed_at = ?, last_pm = ?, note = ? WHERE id = ?',
        [code || null, name.trim(), line || null, installedAt || null, lastPm || null, note || null, id]);
    } else {
      const max = (await dbAll('SELECT MAX(sort_order) AS m FROM machines', []))[0];
      const order = (max && max.m != null ? Number(max.m) : -1) + 1;
      const r = await dbRun(
        `INSERT INTO machines (code, name, line_name, installed_at, last_pm, note, sort_order, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [code || null, name.trim(), line || null, installedAt || null, lastPm || null, note || null, order, nowBKK()]);
      rowId = r.lastID;
    }
    // เขียนโน้ตให้ทันที — คนกดบันทึกแล้วต้องเห็นไฟล์ในวอลต์เลย ไม่ต้องกดซิงก์อีกที
    const cur = (await dbAll('SELECT * FROM machines WHERE id = ?', [rowId]))[0];
    const sync = cur ? await syncMachineNote(cur) : {};
    res.json({ success: true, id: rowId, vaultPath: sync.path || null, vaultError: sync.error || null, vaultSkipped: sync.skipped || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ซิงก์โน้ตทุกเครื่องในทะเบียนเข้า vault รอบเดียว (ใช้ตอนเริ่มใช้งาน / หลังแก้ทะเบียนงาน PM)
app.post('/api/machines/sync-notes', async (req, res) => {
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

app.post('/api/machines/delete', async (req, res) => {
  if (!req.body.id) return res.status(400).json({ error: 'id จำเป็น' });
  try { await db.exec('UPDATE machines SET active = 0 WHERE id = ?', [req.body.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── โน้ตเครื่องจักรใน vault (แผน KM ข้อ 4.1: 1 โน้ตต่อ 1 เครื่อง) ──────────────
// ระบบเป็นเจ้าของเฉพาะ "ในเขต marker" — นอกเขตคนเขียนเองได้ (spec/รูป/บันทึกช่าง) ไม่โดนทับ
const MACHINE_MARK = 'ข้อมูลเครื่องจักร';
const ROLE_LABEL = { mt: 'Maintenance', op: 'Operate', qc: 'QC', pd: 'พนักงานผลิต' };

function machineBlock(m, pmRows, incidents) {
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
    const body = machineBlock(m, pmRows, incidents);
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

app.get('/api/incidents', async (req, res) => {
  const status = req.query.status;
  try {
    const rows = status === 'open' || status === 'closed'
      ? await dbAll('SELECT * FROM incidents WHERE status = ? ORDER BY occurred_at DESC, id DESC', [status])
      : await dbAll('SELECT * FROM incidents ORDER BY occurred_at DESC, id DESC', []);
    res.json({
      incidents: rows.map(r => ({
        id: r.id, title: r.title, machine: r.machine || '', line: r.line_name || '',
        batchId: r.batch_id || '', operator: r.operator || '', occurredAt: r.occurred_at || '',
        symptom: r.symptom || '', cause: r.cause || '', fix: r.fix || '', result: r.result || '',
        images: jsonList(r.images), resultImages: jsonList(r.result_images),
        status: r.status || 'open', vaultPath: r.vault_path || '',
        downFrom: r.down_from || '', downTo: r.down_to || '',
        downtimeMin: downMinutes(r.down_from, r.down_to),
      })),
      openCount: rows.filter(r => (r.status || 'open') !== 'closed').length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/incidents', async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title จำเป็น' });
  // รับเฉพาะ URL — ถ้าอัปโหลดขึ้น Supabase ไม่สำเร็จ client จะส่ง data: กลับมา ซึ่งห้ามลง DB
  const badPhoto = [...(Array.isArray(b.images) ? b.images : []), ...(Array.isArray(b.resultImages) ? b.resultImages : [])]
    .some(u => typeof u === 'string' && !u.startsWith('http'));
  if (badPhoto) return res.status(400).json({ error: 'อัปโหลดรูปไม่สำเร็จ (ยังไม่ได้ URL) — ลองแนบรูปใหม่อีกครั้ง' });
  // เวลากลับมาเดินอยู่ก่อนเวลาหยุด = พิมพ์ผิดแน่ ๆ — ไม่รับ ไม่งั้นได้แถวที่คิดนาทีไม่ได้ค้างในสรุป
  if (cleanDt(b.downFrom) && cleanDt(b.downTo) && downMinutes(b.downFrom, b.downTo) == null) {
    return res.status(400).json({ error: 'เวลากลับมาเดินอยู่ก่อนเวลาที่เครื่องหยุด — ตรวจเวลาอีกครั้ง' });
  }
  const row = {
    title: String(b.title).trim(), machine: b.machine || null, line_name: b.line || null,
    images: photoJson(b.images), result_images: photoJson(b.resultImages),
    batch_id: b.batchId || null, operator: b.operator || null,
    occurred_at: b.occurredAt || todayBKK(),
    symptom: b.symptom || null, cause: b.cause || null, fix: b.fix || null, result: b.result || null,
    status: b.status === 'closed' ? 'closed' : 'open',
    down_from: cleanDt(b.downFrom), down_to: cleanDt(b.downTo),
  };
  try {
    let id = b.id, prevPath = null, prevMachine = null;
    if (id) {
      const cur = (await dbAll('SELECT * FROM incidents WHERE id = ?', [id]))[0];
      if (!cur) return res.status(404).json({ error: 'ไม่พบเหตุการณ์นี้' });
      prevPath = cur.vault_path || null;
      prevMachine = cur.machine || null;
      await db.exec(
        `UPDATE incidents SET title = ?, machine = ?, line_name = ?, batch_id = ?, operator = ?,
           occurred_at = ?, symptom = ?, cause = ?, fix = ?, result = ?, status = ?,
           images = ?, result_images = ?, down_from = ?, down_to = ?, updated_at = ? WHERE id = ?`,
        [row.title, row.machine, row.line_name, row.batch_id, row.operator, row.occurred_at,
         row.symptom, row.cause, row.fix, row.result, row.status,
         row.images, row.result_images, row.down_from, row.down_to, nowBKK(), id]);
    } else {
      const r = await dbRun(
        `INSERT INTO incidents (title, machine, line_name, batch_id, operator, occurred_at,
           symptom, cause, fix, result, status, images, result_images, down_from, down_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.title, row.machine, row.line_name, row.batch_id, row.operator, row.occurred_at,
         row.symptom, row.cause, row.fix, row.result, row.status,
         row.images, row.result_images, row.down_from, row.down_to, nowBKK(), nowBKK()]);
      id = r.lastID;
    }
    const sync = await syncIncident({ ...row, id, vault_path: prevPath });
    if (sync.path) await db.exec('UPDATE incidents SET vault_path = ? WHERE id = ?', [sync.path, id]);
    // รายการ "เหตุการณ์ที่เคยเกิด" ในโน้ตเครื่องจักรต้องตามให้ทัน (ทั้งเครื่องใหม่และเครื่องเดิมถ้าย้าย)
    touchMachineNote(row.machine);
    if (prevMachine && prevMachine !== row.machine) touchMachineNote(prevMachine);
    res.json({ success: true, id, vaultPath: sync.path || null, vaultError: sync.error || null, vaultSkipped: sync.skipped || null });
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
      sendToTelegram(`⚠️ <b>วัสดุใกล้หมด</b>\n${escapeHtml(m.name)}\n\n`
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
    const rows = await dbAll(
      `SELECT id, person_key, node_key, title, machine, goal, owner_role, co_owner_role, sort_order
         FROM duty_routines WHERE active = 1 AND person_key IN (${keys.map(() => '?').join(',')})
        ORDER BY sort_order, id`, keys);
    res.json({
      people: people.map(p => ({ key: p.person_key, name: p.name, role: p.role, color: p.color, initial: p.initial })),
      rows: rows.map(r => ({
        id: r.id, personKey: r.person_key, nodeKey: r.node_key, title: r.title,
        machine: r.machine || '', goal: r.goal || '',
        ownerRole: r.owner_role || '', coOwnerRole: r.co_owner_role || '', sortOrder: r.sort_order,
      })),
    });
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
  const client = getAnthropic();
  if (!client) return null;
  const list = roster.map(p => `${p.person_key}=${p.name} (${p.role || ''})`).join('; ');
  const prompt = `ใบตรวจโรงงานอาหาร มีประเด็นที่กฎอัตโนมัติแบ่งไม่ได้ ช่วยเลือกผู้รับผิดชอบที่เหมาะสมที่สุด 1 คน จากรายชื่อนี้เท่านั้น\n`
    + `รายชื่อ (key=ชื่อ · หน้าที่): ${list}\n`
    + `ประเด็น: ${finding.issue || '-'}\nสถานที่: ${finding.location || '-'}\n`
    + `ตอบเป็น JSON บรรทัดเดียวเท่านั้น: {"owner_key":"...","category":"cleaning|maintenance","reason":"เหตุผลสั้นๆ","confidence":0.0-1.0}`;
  try {
    const resp = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
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
    `SELECT id, parent_id, node_key, title, mono, sort_order, machine, goal, owner_role, co_owner_role,
       CASE WHEN ref_image LIKE 'http%' THEN ref_image ELSE NULL END AS ref_image_url,
       CASE WHEN ref_image IS NULL OR ref_image = '' THEN 0 ELSE 1 END AS has_ref_image
     FROM duty_routines WHERE person_key = ? AND active = 1 ORDER BY parent_id, sort_order, id`, [personKey]);
  const byParent = {};
  for (const r of rows) { const k = r.parent_id == null ? 'root' : String(r.parent_id); (byParent[k] = byParent[k] || []).push(r); }
  const build = (key) => (byParent[key] || []).map(r => {
    const node = { key: r.node_key, title: r.title, id: r.id, parentId: r.parent_id == null ? null : r.parent_id,
      machine: r.machine || null, goal: r.goal || null,
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
      machine: n.machine || null, goal: n.goal || null,
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
  const client = getAnthropic();
  // ไม่มีคีย์ = ปิดเฉพาะฟีเจอร์อ่านรูป (503) ฟอร์มพิมพ์มือต้องใช้ได้ตามปกติ
  if (!client) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์ — พิมพ์แถวเองได้ตามปกติ' });
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
    const resp = await client.messages.create({
      model: 'claude-opus-4-8', max_tokens: 8000,
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
    console.log(`[read-sheet] imgs=${imgs.length} rows=${rows.length} boxes=${rows.filter(r => r.photoBox).length} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('[read-sheet] error', err.message);
    res.status(500).json({ error: `อ่านเอกสารไม่สำเร็จ: ${err.message}` });
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
  const { id, personKey, parentId, title, mono, sortOrder, machine, goal, ownerRole, coOwnerRole, assigneeKey } = req.body;
  // ช่องของโซนซ่อมบำรุง — ไม่ส่งมา = ไม่แตะของเดิม (งานของทีมกะไม่ได้ใช้ช่องพวกนี้)
  const role = (v) => (['mt', 'op', 'qc', 'pd'].includes(v) ? v : null);
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
           machine = ?, goal = ?, owner_role = ?, co_owner_role = ? WHERE id = ?`,
        [owner, title.trim(), mono ? 1 : 0, sortOrder != null ? sortOrder : cur.sort_order,
         machine !== undefined ? (machine || null) : cur.machine,
         goal !== undefined ? (goal || null) : cur.goal,
         ownerRole !== undefined ? role(ownerRole) : cur.owner_role,
         coOwnerRole !== undefined ? role(coOwnerRole) : cur.co_owner_role, id]);
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
         machine, goal, owner_role, co_owner_role)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [personKey, parentId || null, nodeKey, title.trim(), mono ? 1 : 0, order, nowBKK(),
       machine || null, goal || null, role(ownerRole), role(coOwnerRole)]);
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
async function sendBeforeAfterCard({ date, personKey, title, kicker, beforeImage, beforeSub, afterImages, pairList, operator, footerExtra }) {
  if (!process.env.TELEGRAM_CHAT_ID) return;
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
  });
}

// งานมอบหมาย: จับคู่ตามจุด — photo_specs[i] คู่กับ images[i] (ก่อนทำ) และ done_images[i] (หลังทำ)
// พื้นที่เดียวหลายจุด จะได้เห็นชัดว่ารูปไหนคู่กับรูปไหน
async function sendAdhocDoneCard(taskId, operator) {
  const row = (await dbAll('SELECT task_date, title, assignee, images, done_images, done_by, photo_specs, machine, location, reporter FROM daily_tasks WHERE id = ?', [taskId]))[0];
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

// มอบหมายงานระหว่างวัน → เก็บลง daily_tasks (source = 'assigned') ผูก assignee
// ── งานมอบหมาย: หมวด, วันที่ทำ, แจ้งเตือนล่วงหน้า ──────────────────────────
const CAT_ICON = { production: '🏭', cip: '💧', backwash: '🧴', cleaning: '🧽', mixing: '🥤', packing: '📦', maintenance: '🔧', manual: '📌', am: '🔧' };
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
      if (photoSet.length) sendPhotosToTelegram(photoSet, msg); // มีรูป → ส่งเป็นอัลบั้มพร้อมข้อความ (URL/base64)
      else sendToTelegram(msg);
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

app.post('/api/duty/telegram', async (req, res) => {
  const date = req.body.date || req.query.date || workDayBKK();
  try {
    const duty = await buildDuty(date, { maint: req.body.kind === 'maint' });
    const text = buildDutyText(duty);
    await sendToTelegram(text);
    res.json({ success: true, sent: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), preview: text });
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
  const { autoEnabled, times, weekdays, onlyIfPending, autoAtShiftEnd, shiftAnalysisEnabled, kpiWeeklyEnabled, kpiMonthlyEnabled, kpiAlertEnabled, kpiAlertStreakDays, kpiAlertCipStaleHours } = req.body;
  try {
    const cfg = await getReportConfig();
    const sae = shiftAnalysisEnabled == null ? cfg.shiftAnalysisEnabled : shiftAnalysisEnabled;
    const kw = kpiWeeklyEnabled == null ? cfg.kpiWeeklyEnabled : kpiWeeklyEnabled;
    const km = kpiMonthlyEnabled == null ? cfg.kpiMonthlyEnabled : kpiMonthlyEnabled;
    const ka = kpiAlertEnabled == null ? cfg.kpiAlertEnabled : kpiAlertEnabled;
    const ksd = kpiAlertStreakDays == null ? cfg.kpiAlertStreakDays : Math.max(1, Number(kpiAlertStreakDays) || 2);
    const kch = kpiAlertCipStaleHours == null ? cfg.kpiAlertCipStaleHours : Math.max(1, Number(kpiAlertCipStaleHours) || 30);
    await db.exec('UPDATE report_config SET auto_enabled = ?, times = ?, weekdays = ?, only_if_pending = ?, auto_at_shift_end = ?, shift_analysis_enabled = ?, kpi_weekly_enabled = ?, kpi_monthly_enabled = ?, kpi_alert_enabled = ?, kpi_alert_streak_days = ?, kpi_alert_cip_stale_hours = ?, updated_at = ? WHERE id = ?',
      [autoEnabled ? 1 : 0, JSON.stringify(times || []), JSON.stringify(weekdays || []), onlyIfPending ? 1 : 0, autoAtShiftEnd ? 1 : 0, sae ? 1 : 0, kw ? 1 : 0, km ? 1 : 0, ka ? 1 : 0, ksd, kch, nowBKK(), cfg.id]);
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
  await sendToTelegram(buildDutyText(duty));
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
      "SELECT id, category, title, priority, assignee, location, task_date, due_time, images FROM daily_tasks WHERE source = 'assigned' AND reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ? AND status != 'done' ORDER BY id",
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
        if (imgs.length) sendPhotosToTelegram(imgs, msg);
        else sendToTelegram(msg);
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
  await sheetSyncTick(); // ให้ tick ที่ n8n ยิงครบเท่า setInterval (สำคัญเมื่อ Render หลับนอกช่วง window)
  await vaultTick();     // ตาข่ายกันพลาดของ Obsidian — ทำงานจริงชั่วโมงละครั้ง
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

app.get('/api/quality/history', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  try {
    res.json(await buildQualityHistory({ from, to, flavor: req.query.flavor, line: req.query.line }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
      const base = {
        line: m.line, operator: m.operator, item: m.item, day,
        at: local ? `${day}T${pad2(local.getHours())}:${pad2(local.getMinutes())}` : '',
        shift: sh ? sh.key : '', workDay: sh ? sh.workDay : day,
        backwash: !!d.backwash,
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

  const [states, tasks, prodRows, cip] = await Promise.all([
    dbAll('SELECT state_date, assignee, node_key, checked, bypassed, handoff_to, updated_at FROM routine_state WHERE state_date BETWEEN ? AND ?', [from, to]),
    dbAll("SELECT task_date, assignee, status, category FROM daily_tasks WHERE task_date BETWEEN ? AND ? AND source = 'assigned'", [from, to]),
    // ช่วงวันทำงาน 06:00→06:00 (แบบเดียวกับ fetchProductionByWorkday) — กะดึกคาบเที่ยงคืน
    dbAll('SELECT timestamp, line_name, flavor, operator_name FROM production_logs WHERE timestamp >= ? AND timestamp < ?',
      [`${from}T06:00:00`, `${addDaysStr(to, 1)}T06:00:00`]),
    fetchCipRounds(from, to),
  ]);

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
  const operators = {};
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
    const o = operators[op] || (operators[op] = { name: op, batches: 0, days: {}, shifts: {}, cipRounds: 0 });
    o.batches += 1; o.days[sh.workDay] = true; o.shifts[sh.key] = (o.shifts[sh.key] || 0) + 1;
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
    shifts: o.shifts,
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
    shifts,
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
    `แตะเลือกดูงานของแต่ละคน 👇`;
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
  const token = process.env.TELEGRAM_BOT_TOKEN;
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
      if (/ปิดงาน|งานค้าง|เช็[กค]งาน|เช็[กค]\s*งาน|หน้าที่/.test(text)) {
        const kb = buildDutyHome(await buildDuty(date), await countAuditOpen());
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
    memBlock ? '\n' + memBlock : '',
  ].join('\n');
}

// เลเยอร์คุยกับ Claude ที่ใช้ร่วมกัน — หน้าเว็บ (/api/assistant), ต่อหลังกดยืนยัน (เฟส 3), วิเคราะห์สิ้นกะ (เฟส 1)
// opts: { userMessage, image | images, operator, session, persist=true, maxTurns=12, systemExtra }
// image = { data: base64 ไม่รวม prefix, media_type } หรือ images = [ ... ] (หลายรูป/หลายส่วนของตารางเดียว)
// → แนบเป็น image block เทิร์นแรก (vision อ่านรูปแผน) · รูปส่งเฉพาะเทิร์นนี้ ไม่เก็บลง history
async function runAssistantConversation(opts) {
  const { userMessage, image = null, images = null, operator = null, session = null, persist = true, maxTurns = 12, systemExtra = '', forceTool = null } = opts;
  const client = getAnthropic();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์');
  let system = await buildAssistantSystem(operator);
  if (systemExtra) system += '\n\n' + systemExtra;

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
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 4096,
      // prompt caching: จุด cache ท้าย system → tools+system (ส่วนหัวที่ซ้ำทุกครั้ง) อ่านจาก cache เหลือ ~0.1x
      // หมายเหตุ: system มีวันที่+ความจำถาวร → cache รีเซ็ตเมื่อเปลี่ยน ซึ่งไม่บ่อย
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: ASSISTANT_TOOLS, messages,
      // บังคับเรียก tool เจาะจงเฉพาะเทิร์นแรก (กันโมเดลแค่ "บรรยาย" ว่าทำแล้วโดยไม่เรียก tool จริง) —
      // เทิร์นถัดไปปล่อย auto ตามปกติ ไม่งั้นจะวนบังคับเรียกซ้ำไม่รู้จบ
      ...(turn === 0 && forceTool ? { tool_choice: { type: 'tool', name: forceTool } } : {}),
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
  if (!getAnthropic()) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์' });
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
    res.json({ item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// สร้างใหม่ (ไม่ส่ง id มา) หรือแก้ของเดิม (ส่ง id มา) — คืน id กลับไปเสมอ
app.post('/api/posts', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'ต้องมีหัวข้อบทความ' });
  const now = nowBKK();
  const vals = {
    slug: String(b.slug || '').trim(),
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
      return res.json({ id: Number(b.id), updatedAt: now, vault: vaultRes });
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
    res.json({ id, updatedAt: now, vault: vaultRes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════ อนุมัติ + เวอร์ชันของคู่มือ/SOP (แผน KM ข้อ 7) ══════════
   ร่าง → ส่งขออนุมัติ (review) → หัวหน้างานกดอนุมัติ (published + เก็บเวอร์ชัน) หรือตีกลับ
   บทความหมวดอื่นไม่เปลี่ยนพฤติกรรมเลย — กดเผยแพร่เองได้เหมือนเดิม                */
const SOP_CATEGORY = 'คู่มือ / SOP';
const isSopPost = (row) => String((row || {}).category || '').trim() === SOP_CATEGORY;

const sopNotify = (text) => { if (process.env.TELEGRAM_CHAT_ID) sendToTelegram(text); };

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
      const cat = String((req.query && req.query.cat) || '').trim();
      return send(articlePage.renderIndex(rows.map(postFromRow), PUBLIC_URL, cat));
    }
    const row = await dbGet("SELECT * FROM posts WHERE slug = ? AND status = 'published'", [slug]);
    if (!row) return send(articlePage.renderNotFound(), 404);
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
    return send(articlePage.renderArticle(post, PUBLIC_URL));
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
const JS_GEN_MODEL = process.env.SPP_JS_MODEL || 'claude-sonnet-5';
const JS_GEN_EFFORT = process.env.SPP_JS_EFFORT || 'medium';

// แยกเป็นฟังก์ชันเล็ก ๆ ไว้ให้ "ผู้ช่วยเขียนทั้งบทความ" (เฟส 2) เรียกต่อได้โดยไม่ต้องรื้อ handler
//
// ⚠️ max_tokens คุม "ความคิด (thinking) + โค้ดที่เขียนออกมา" รวมกัน ไม่ใช่แค่โค้ด
//    เดิมตั้ง 8000 แล้วคำสั่ง WebGL ที่รายละเอียดเยอะ (แถบสี + ท่อ + ป้าย) ชนเพดานจริง
//    ผู้ใช้เห็นเป็น "โค้ดยาวเกินโควตา เลยได้มาไม่ครบ" — 16000 คือค่าที่คู่มือ API แนะนำ
//    สำหรับการเรียกแบบไม่ stream (สูงกว่านี้เสี่ยง HTTP timeout ต้องเปลี่ยนไปใช้ stream)
//    เพดานนี้เป็นแค่ "ห้ามเกิน" ไม่ได้จองโทเคนไว้ล่วงหน้า โหมด 2D สั้น ๆ จึงไม่แพงขึ้นเลย
async function callJsGen(client, { messages, effort, maxTokens = 16000 }) {
  return client.messages.create({
    model: JS_GEN_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    // ⚠️ ก้อน system ต้องคงที่ 100% ห้ามมีโหมด/วันที่/ความสูงปนเข้ามา ไม่งั้น cache miss ทุกครั้ง
    system: [{ type: 'text', text: jsGenPrompt.JS_GEN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  });
}

app.post('/api/blog/js-gen', async (req, res) => {
  const client = getAnthropic();
  // ไม่มีคีย์ = ปิดเฉพาะปุ่มนี้ (503) เขียนโค้ดเองในบล็อกยังทำได้ตามปกติ
  if (!client) {
    return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์ — เขียนโค้ดเองในบล็อกได้ตามปกติ' });
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
    res.status(e.extract ? 422 : 502).json({ error: e.message || 'เรียกโมเดลไม่สำเร็จ' });
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
        // บอท SPP เป็นคนละบอท จึงตั้ง webhook ของตัวเองได้โดยไม่ชนกับข้างบน
        // (แต่ต้องปิด Telegram Trigger ใน n8n v4 ก่อน เพราะใช้บอทตัวเดียวกัน)
        registerSppWebhook();
        // ตัวจับเวลาส่งรายงานอัตโนมัติ + วิเคราะห์สิ้นกะ (เฟส 1) — เช็กทุกนาที (ต้องให้เซิร์ฟเวอร์ตื่นอยู่; มี Keep-Warm ping ช่วย)
        setInterval(() => { reportTick(); reminderTick(); shiftAnalysisTick(); kpiReportTick(); kpiAlertTick(); sheetSyncTick(); sppShiftNudgeTick(); vaultTick(); }, 60 * 1000);
        console.log('[report] scheduler started (every 60s) + shift-analysis');
      });
    })
    .catch((err) => {
      console.error('[db] init failed — server not started', err);
      process.exit(1);
    });
}
