/* โหนด "Build Chart" ของ workflow "Telegram Production Chart Bot" — ฉบับกันพัง
   วางทับ jsCode เดิมทั้งหมด (n8n → เปิดโหนด Build Chart → ลบโค้ดเก่า → วางอันนี้)

   แก้ 3 อย่างที่ทำให้โหนด "Send Chart" ตอบ Bad request:
   1) ไม่พบข้อมูลการผลิต → เดิมคืน chartUrl = '' แล้ว sendPhoto ส่งรูปเปล่า = Bad request
      ตอนนี้สร้างรูป "ไม่พบข้อมูล" ที่ใช้ได้จริงแทน จะได้ตอบกลับในกลุ่มแทนที่จะพังเงียบ ๆ
   2) caption ยาวเกิน 1024 ตัวอักษร (ลิมิตของ Telegram sendPhoto) → ตัดให้พอดีเสมอ
      วันที่ผลิตหลายรส/หลายไลน์ ข้อความรายละเอียดยาวทะลุง่ายมาก
   3) URL ของ QuickChart ยาวเกินไป (ชื่อรสเยอะ title ยาว) → ตัด title ให้สั้นลงอัตโนมัติ
*/

const q = $('Parse Query').first().json;
const wantFlavor = (q.flavor || '').toLowerCase();
const actualRows = $('Read Actual').all().map(i => i.json);
let planRows = [];
try { planRows = $('Read Plan').all().map(i => i.json); } catch (e) { planRows = []; }

const CUTOFF_HOUR = 6; // ตัดวัน: batch ก่อน 06:00 = วันผลิตของวันก่อนหน้า
function prodDay(ts) {
  ts = String(ts || '');
  const datePart = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(datePart)) return datePart;
  const hour = parseInt((ts.slice(11).trim().split(':')[0] || '0'), 10) || 0;
  if (hour < CUTOFF_HOUR) {
    const dt = new Date(datePart + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  }
  return datePart;
}
// คีย์เรียงตามเวลาจริง (รองรับชั่วโมงเลขเดียว เช่น "0:11")
function tsKey(ts) {
  const m = String(ts || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return String(ts || '');
  return m[1] + m[2] + m[3] + m[4].padStart(2, '0') + m[5] + (m[6] || '00');
}
function statusEmoji(p, a) {
  if (p <= 0) return a > 0 ? '🔵' : '⚪';
  const r = a / p * 100;
  if (r >= 100) return '✅';
  if (r >= 75) return '🟢';
  if (r >= 50) return '🟡';
  return '🔴';
}

// ── ตัวช่วยกันพัง ────────────────────────────────────────────────────────
const CAP_MAX = 1024;   // ลิมิต caption ของ Telegram sendPhoto
const URL_MAX = 1900;   // กันรูปไม่ออกเพราะ URL ยาวเกิน
function clampCaption(s) {
  s = String(s || '');
  return s.length <= CAP_MAX ? s : s.slice(0, CAP_MAX - 24) + '\n…(ข้อความยาว ตัดบางส่วน)';
}
function chartUrlOf(chartObj, h) {
  return 'https://quickchart.io/chart?w=760&h=' + h + '&c=' + encodeURIComponent(JSON.stringify(chartObj));
}

const actual = {};
const batchesByLine = {}; // "Line X | flavor" -> [{b, k}]
for (const r of actualRows) {
  const f = (r.flavor || '').toString().trim();
  if (!f) continue;
  if (q.date && prodDay(r.timestamp) !== q.date) continue;
  if (wantFlavor && !f.toLowerCase().includes(wantFlavor)) continue;
  actual[f] = (actual[f] || 0) + 1;
  const line = (r.line || '-').toString().trim();
  const b = (r.batch || '').toString().trim();
  const key = line + ' | ' + f;
  if (!batchesByLine[key]) batchesByLine[key] = [];
  if (b) batchesByLine[key].push({ b: b, k: tsKey(r.timestamp) });
}
const plan = {};
const planByLine = {}; // "Line X | flavor" -> planned batches
for (const r of planRows) {
  const f = (r.flavor || '').toString().trim();
  if (!f) continue;
  if (q.date && r.planDate && String(r.planDate) !== q.date) continue;
  if (wantFlavor && !f.toLowerCase().includes(wantFlavor)) continue;
  plan[f] = (plan[f] || 0) + Number(r.plannedBatches || 0);
  const line = (r.line || '-').toString().trim();
  const key = line + ' | ' + f;
  planByLine[key] = (planByLine[key] || 0) + Number(r.plannedBatches || 0);
}

let flavors = Array.from(new Set([...Object.keys(plan), ...Object.keys(actual)]));
if (wantFlavor) {
  const filtered = flavors.filter(f => f.toLowerCase().includes(wantFlavor));
  if (filtered.length) flavors = filtered;
}
flavors.sort();

// ── ไม่พบข้อมูล: ยังต้องส่งรูปที่ใช้ได้จริง ไม่งั้น sendPhoto = Bad request ──
if (flavors.length === 0) {
  const msg = '⚠️ ไม่พบข้อมูลการผลิต' + (q.date ? (' วันที่ ' + q.date) : '');
  const emptyChart = {
    type: 'bar',
    data: { labels: [''], datasets: [{ label: 'ยังไม่มีข้อมูล', data: [0], backgroundColor: 'rgba(150,150,150,0.4)' }] },
    options: {
      title: { display: true, text: [msg, 'ยังไม่มีการบันทึกแผน/ยอดผลิตของวันนี้'], fontStyle: 'bold', fontSize: 16 },
      legend: { display: false },
      scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0, max: 1 } }] }
    }
  };
  return [{ json: { chatId: q.chatId, caption: clampCaption(msg), chartUrl: chartUrlOf(emptyChart, 360) } }];
}

const planData = flavors.map(f => plan[f] || 0);
const actualData = flavors.map(f => actual[f] || 0);
// ฝังสรุป (header + ต่อรส + ยอดรวม) ลงใน title ของรูป + โชว์ตัวเลขบนแท่ง (datalabels)
let tTp = 0, tTa = 0;
const headLine = '📊 แผน vs ผลิตจริง (batch)' + (q.date ? (' ' + q.date) : '');
const perFlavorLines = [];
for (const f of flavors) {
  const p = plan[f] || 0, a = actual[f] || 0;
  tTp += p; tTa += a;
  const pct = p > 0 ? Math.round(a / p * 100) : 0;
  perFlavorLines.push(f + ': แผน ' + p + ' · จริง ' + a + ' (' + pct + '%)');
}
const totalLine = 'รวม จริง ' + tTa + ' / แผน ' + tTp + ' batch';

function buildChart(titleLines) {
  return {
    type: 'bar',
    data: { labels: flavors, datasets: [
      { label: 'แผน', data: planData, backgroundColor: 'rgba(21,101,192,0.75)', datalabels: { color: '#1565c0' } },
      { label: 'ผลิตจริง', data: actualData, backgroundColor: 'rgba(67,160,71,0.85)', datalabels: { color: '#2e7d32' } } ] },
    options: {
      title: { display: true, text: titleLines, fontStyle: 'bold', fontSize: 14 },
      legend: { display: true },
      plugins: { datalabels: { display: true, anchor: 'end', align: 'end', font: { size: 12, weight: 'bold' } } },
      scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] }
    }
  };
}

// title เต็มก่อน — ถ้า URL ยาวเกิน ค่อยตัดรายรสออก (ตัวเลขรายรสยังอยู่ครบใน caption อยู่ดี)
let titleLines = [headLine, ...perFlavorLines, totalLine];
let chartH = 440 + Math.max(0, titleLines.length - 3) * 22;
let chartUrl = chartUrlOf(buildChart(titleLines), chartH);
if (chartUrl.length > URL_MAX) {
  titleLines = [headLine, totalLine];
  chartH = 440;
  chartUrl = chartUrlOf(buildChart(titleLines), chartH);
}

const LINE = '━━━━━━━━━━━━━━━';
let cap = '📊 สรุปการผลิต   📅 ' + (q.date || 'ทั้งหมด') + '\n' + LINE + '\n';
let tp = 0, ta = 0;
for (const f of flavors) {
  const p = plan[f] || 0, a = actual[f] || 0; tp += p; ta += a;
  const pct = p > 0 ? Math.round(a / p * 100) : 0;
  cap += '\n🧃 ' + f + '\n';
  cap += '   🎯 แผน ' + p + '   ✅ จริง ' + a + '   ' + statusEmoji(p, a) + ' ' + pct + '%\n';
}
cap += LINE + '\n📦 รวม:  ✅ ' + ta + ' / 🎯 ' + tp + ' batch';

const allKeys = Array.from(new Set([...Object.keys(planByLine), ...Object.keys(batchesByLine)])).sort();
if (allKeys.length) {
  cap += '\n\n🏭 รายละเอียดแต่ละเลน';
  for (const k of allKeys) {
    const parts = k.split(' | ');
    const lineName = parts[0], fl = parts[1] || '';
    const planN = planByLine[k] || 0;
    const list = (batchesByLine[k] || []).slice()
      .sort((x, y) => x.k < y.k ? -1 : x.k > y.k ? 1 : 0)
      .map(o => o.b);
    cap += '\n\n▸ ' + lineName + ' · 🧃 ' + fl;
    cap += '\n   🎯 แผน ' + planN + '   ✅ จริง ' + list.length;
    if (list.length) cap += '\n   📋 Batch: ' + list.join(', ');
  }
}

return [{ json: { chatId: q.chatId, chartUrl, caption: clampCaption(cap) } }];
