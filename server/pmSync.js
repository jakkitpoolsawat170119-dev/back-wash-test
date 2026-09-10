/* ─── ดึงแผน PM จากแอปทีมช่าง (Netlify + Firebase spp-am) ─────────────────────
   แอปหลัก = กระจกอ่านอย่างเดียว · เจ้าของแผนและผลปิดงานคือแอปทีมช่าง
   ปิดงาน / แก้แผน ทำที่ https://sppmaintennceteam.netlify.app/ ที่เดียว

   ที่มาของข้อมูล 2 ทาง:
   1) แผนตั้งต้น 30 รายการ — hardcode อยู่ในไฟล์ HTML ของ Netlify ไม่ได้อยู่บน Firebase
      คัดลอกมาไว้ที่ server/data/pm-baseline.json ครั้งเดียว (ดึงเมื่อ 2026-09-10)
   2) Firebase REST (อ่านได้ไม่ต้อง auth) — 3 path ที่ทับ/เติมของตั้งต้น
      pm_plan_overrides · pm_weekly_done · pm_weekly_skip
      (pm_plans เป็น null ไม่ได้ใช้ · am_records เป็นใบเช็ก AM ไม่เกี่ยวกับ PM)

   🔴 กติกาเหล็ก: ดึงไม่สำเร็จ = ไม่แตะของเดิมเลย แค่ log แล้วออก
      ตาราง pm_items / pm_done / pm_skip ถูกเขียนทับทุกรอบ ห้ามเอาข้อมูลของแอปนี้ไปฝาก
      (ลิสต์งานย่อย · ผู้รับผิดชอบ อยู่ pm_jobs / pm_item_meta ซึ่งที่นี่ไม่แตะ)         */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('./db');

const envStr = (k, dflt = '') => String(process.env[k] || dflt).trim();
const FIREBASE = envStr('PM_FIREBASE_URL',
  'https://spp-am-default-rtdb.asia-southeast1.firebasedatabase.app').replace(/\/+$/, '');
const NETLIFY_URL = envStr('PM_NETLIFY_URL', 'https://sppmaintennceteam.netlify.app/');

/* ══════════════ ปฏิทิน ISO ══════════════
   ⚠️ เดือนของสัปดาห์ ISO ตัดสินที่ "วันพฤหัส" ไม่ใช่วันจันทร์
      (จันทร์ของ W1/2026 = 29 ธ.ค. 2025 — ถ้าใช้วันจันทร์ หัวเดือนจะขึ้น ธ.ค.) */

// จันทร์ของสัปดาห์ ISO ที่ w ปี y — คิดจาก 4 ม.ค. ซึ่งอยู่ใน W1 เสมอ
function mondayOfIsoWeek(y, w) {
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const dow = (jan4.getUTCDay() + 6) % 7;              // จ.=0 … อา.=6
  const d = new Date(jan4);
  d.setUTCDate(jan4.getUTCDate() - dow + (w - 1) * 7);
  return d;
}
// วัน (YYYY-MM-DD) → { year, week } ตามปฏิทิน ISO
function isoWeekOf(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const th = new Date(d);
  th.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));   // เลื่อนไปวันพฤหัสของสัปดาห์
  const year = th.getUTCFullYear();                                // ปี ISO = ปีของวันพฤหัสนั้น
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((th - jan1) / 86400000 + 1) / 7);
  return { year, week };
}
// ปีนี้มี 52 หรือ 53 สัปดาห์ — ดูจากสัปดาห์ของ 28 ธ.ค. (อยู่สัปดาห์สุดท้ายเสมอ)
const isoWeeksInYear = (y) => isoWeekOf(`${y}-12-28`).week;
// เดือน (0-11) ของสัปดาห์ ISO — ใช้วันพฤหัสตัดสิน
const monthOfIsoWeek = (y, w) => {
  const th = mondayOfIsoWeek(y, w);
  th.setUTCDate(th.getUTCDate() + 3);
  return th.getUTCMonth();
};
const ymd = (d) => d.toISOString().slice(0, 10);
const weekRange = (y, w) => {
  const mon = mondayOfIsoWeek(y, w);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return { monday: ymd(mon), sunday: ymd(sun) };
};

/* ══════════════ ป้ายความถี่ ══════════════ */
const FREQ_TH = {
  '1 wk.': 'ทุกสัปดาห์', '2 wk.': 'ทุก 2 สัปดาห์', '1 month': 'ทุกเดือน',
  '3 months': 'ทุก 3 เดือน', '6 months': 'ทุก 6 เดือน', '1 year': 'ปีละครั้ง',
};
const FREQ_STEP = { '1 wk.': 1, '2 wk.': 2, '1 month': 4, '3 months': 13, '6 months': 26, '1 year': 52 };
const freqLabel = (freq) => FREQ_TH[freq] || String(freq || '').trim() || 'ไม่ระบุความถี่';

// ระยะห่างระหว่างรอบ (สัปดาห์) — ใช้ป้ายความถี่ก่อน ไม่รู้จักค่อยเดาจากช่องว่างที่เจอบ่อยที่สุด
// (แผนจริงไม่ได้ห่างเท่ากันเป๊ะ เช่น w01 มี …24,26,27,29,32… เพราะมีการเลื่อนรอบ)
function stepOf(freq, weeks) {
  if (FREQ_STEP[freq]) return FREQ_STEP[freq];
  const ws = (weeks || []).slice().sort((a, b) => a - b);
  if (ws.length < 2) return 52;
  const tally = {};
  for (let i = 1; i < ws.length; i += 1) { const g = ws[i] - ws[i - 1]; tally[g] = (tally[g] || 0) + 1; }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return Math.max(1, Number(best[0]) || 1);
}
// ป้ายความถี่ของงานย่อย · every = ทำทุกกี่รอบของเครื่อง
function jobFreqLabel(step, every) {
  const n = Math.max(1, Number(every) || 1);
  if (n === 1) return 'ทุกครั้ง';
  const wk = step * n;
  if (wk >= 48) return 'ปีละครั้ง';
  if (wk >= 24) return 'ทุก 6 เดือน';
  if (wk >= 12) return 'ทุก 3 เดือน';
  return `ทุก ${wk} สัปดาห์`;
}
// สัปดาห์ที่งานย่อยนี้ต้องทำ — subset ของรอบแม่เสมอ (ถี่กว่ารอบเครื่องไม่ได้)
const jobWeeks = (weeks, every) => {
  const n = Math.max(1, Number(every) || 1);
  return (weeks || []).filter((_, nth) => nth % n === 0);
};

/* สถานะรายจุด — ลำดับสำคัญ: skip → done → future → due → over */
function cycleStatus(year, week, cur, hasDone, hasSkip) {
  if (hasSkip) return 'skip';
  if (hasDone) return 'done';
  if (year > cur.year || (year === cur.year && week > cur.week)) return 'future';
  if (year === cur.year && week === cur.week) return 'due';
  return 'over';
}

/* ══════════════ แผนตั้งต้น 30 รายการ ══════════════ */
let _baseline = null;
function baselineItems() {
  if (_baseline) return _baseline;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'pm-baseline.json'), 'utf8'));
    _baseline = (raw.items || []).map((it) => ({
      id: String(it.id), name: String(it.name || ''), freq: String(it.freq || ''),
      weeks: (it.weeks || []).map(Number).filter((n) => n >= 1 && n <= 53),
    }));
  } catch (e) {
    console.error('[pm] อ่านแผนตั้งต้นไม่ได้', e.message);
    _baseline = [];
  }
  return _baseline;
}

/* ══════════════ ชั้นคุยกับ Firebase ══════════════ */
// RTDB คืน array เป็น object เมื่อคีย์ไม่เรียงจาก 0 — รับทั้ง 2 แบบ
const toArr = (v) => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []));
const toWeeks = (v) => toArr(v).map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 53);

async function fetchPath(p, timeout = 20000) {
  const r = await axios.get(`${FIREBASE}/${p}.json`, { timeout, validateStatus: () => true });
  if (r.status >= 400) throw new Error(`${p} → HTTP ${r.status}`);
  return r.data && typeof r.data === 'object' ? r.data : {};
}

/* baseline + overrides → รายการที่ใช้จริง
   override ที่มีแค่ deleted:true จะไม่มี name/freq/weeks มาด้วย — ต้องคงค่าตั้งต้นไว้ */
function mergeItems(baseline, overrides) {
  const map = new Map(baseline.map((it) => ({ ...it, deleted: 0, isCustom: 0, updatedAt: null }))
    .map((it) => [it.id, it]));
  for (const [k, o] of Object.entries(overrides || {})) {
    if (!o || typeof o !== 'object') continue;
    const id = String(o.id || k);
    const cur = map.get(id)
      || { id, name: '', freq: '', weeks: [], deleted: 0, isCustom: 1, updatedAt: null };
    if (o.name != null) cur.name = String(o.name);
    if (o.freq != null) cur.freq = String(o.freq);
    if (o.weeks != null) cur.weeks = toWeeks(o.weeks);
    cur.deleted = o.deleted ? 1 : 0;
    if (o.isCustom) cur.isCustom = 1;
    if (o.updatedAt) cur.updatedAt = String(o.updatedAt);
    map.set(id, cur);
  }
  return [...map.values()];
}

/* ══════════════ เขียนลงตารางกระจก ══════════════
   ON CONFLICT … DO UPDATE ใช้ได้ทั้ง SQLite (≥3.24) และ Postgres
   ล้างของเก่าด้วย synced_at: แถวที่รอบนี้ไม่ได้แตะ = ถูกลบที่ต้นทางแล้ว          */
async function pmSyncRun() {
  const stamp = new Date().toISOString();
  let ov, done, skip;
  try {
    [ov, done, skip] = await Promise.all([
      fetchPath('pm_plan_overrides'), fetchPath('pm_weekly_done'), fetchPath('pm_weekly_skip'),
    ]);
  } catch (e) {
    console.error('[pm] ดึงจากแอปทีมช่างไม่สำเร็จ — คงข้อมูลเดิมไว้ทั้งหมด:', e.message);
    return { ok: false, error: e.message };
  }

  const items = mergeItems(baselineItems(), ov);
  for (const it of items) {
    await db.exec(
      `INSERT INTO pm_items (net_id, name, freq, weeks, deleted, is_custom, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (net_id) DO UPDATE SET name = excluded.name, freq = excluded.freq,
         weeks = excluded.weeks, deleted = excluded.deleted, is_custom = excluded.is_custom,
         updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
      [it.id, it.name, it.freq, JSON.stringify(it.weeks), it.deleted, it.isCustom, it.updatedAt, stamp]);
  }
  // รายการที่หายไปจากต้นทาง = ซ่อน ไม่ลบ (งานย่อย/ผู้รับผิดชอบใน pm_jobs ผูก net_id อยู่)
  await db.exec('UPDATE pm_items SET deleted = 1 WHERE synced_at <> ?', [stamp]);

  const doneRows = Object.entries(done || {}).map(([k, v]) => ({ k, v })).filter((r) => r.v && r.v.done);
  for (const { k, v } of doneRows) {
    await db.exec(
      `INSERT INTO pm_done (key, net_id, iso_year, week, done, done_by, done_date, note, updated_at, synced_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET net_id = excluded.net_id, iso_year = excluded.iso_year,
         week = excluded.week, done = 1, done_by = excluded.done_by, done_date = excluded.done_date,
         note = excluded.note, updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
      [String(v.id || k), String(v.itemId || ''), Number(v.isoYear) || 0, Number(v.week) || 0,
        v.doneBy || null, v.doneDate || null, v.note || null, v.updatedAt || null, stamp]);
  }
  const skipRows = Object.entries(skip || {}).map(([k, v]) => ({ k, v })).filter((r) => r.v && r.v.itemId);
  for (const { k, v } of skipRows) {
    await db.exec(
      `INSERT INTO pm_skip (key, net_id, iso_year, week, reason, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET net_id = excluded.net_id, iso_year = excluded.iso_year,
         week = excluded.week, reason = excluded.reason, updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`,
      [String(v.id || k), String(v.itemId || ''), Number(v.isoYear) || 0, Number(v.week) || 0,
        v.reason || null, v.updatedAt || null, stamp]);
  }
  // ต้นทางว่างเปล่าทั้งก้อน = สงสัยว่าดึงพลาด ไม่ใช่ "คนไปลบหมด" — กันล้างผลปิดงานทิ้งทั้งปี
  await pruneStale('pm_done', doneRows.length, stamp);
  await pruneStale('pm_skip', skipRows.length, stamp);

  lastSync = { at: stamp, ok: true, items: items.length, done: doneRows.length, skip: skipRows.length };
  console.log(`[pm] sync ok — แผน ${items.length} · ปิดงาน ${doneRows.length} · ปิดรอบ ${skipRows.length}`);
  return { ok: true, ...lastSync };
}

async function pruneStale(table, fetched, stamp) {
  if (fetched === 0) {
    const n = await new Promise((res) => db.get(`SELECT COUNT(*) AS c FROM ${table}`, [],
      (e, r) => res(e ? 0 : Number(r?.c) || 0)));
    if (n > 0) { console.warn(`[pm] ${table}: ต้นทางว่าง แต่ของเดิมมี ${n} แถว — ไม่ล้าง`); return; }
  }
  await db.exec(`DELETE FROM ${table} WHERE synced_at <> ?`, [stamp]);
}

/* ══════════════ จังหวะการดึง ══════════════
   เกาะ /api/report/tick ที่ n8n เคาะทุกนาที (04–23) แต่ทำจริงชั่วโมงละครั้ง
   ห้ามเพิ่ม polling ใหม่ — เคยชน Render 750 instance-hours มาแล้ว                */
let lastSync = { at: null, ok: null, items: 0, done: 0, skip: 0 };
let lastTickHour = '';
let inFlight = null;

// กันยิงซ้อน: ถ้ากำลังดึงอยู่ ให้รอผลรอบเดียวกัน
function pmSync() {
  if (inFlight) return inFlight;
  inFlight = pmSyncRun().finally(() => { inFlight = null; });
  return inFlight;
}
async function pmSyncTick() {
  const hour = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 13);
  if (hour === lastTickHour) return;
  lastTickHour = hour;
  try { await pmSync(); } catch (e) { console.error('[pm] tick error', e.message); }
}
const pmLastSync = () => lastSync;

module.exports = {
  pmSync, pmSyncTick, pmLastSync, baselineItems, mergeItems,
  mondayOfIsoWeek, isoWeekOf, isoWeeksInYear, monthOfIsoWeek, weekRange, ymd,
  freqLabel, stepOf, jobFreqLabel, jobWeeks, cycleStatus,
  NETLIFY_URL, FIREBASE,
};
