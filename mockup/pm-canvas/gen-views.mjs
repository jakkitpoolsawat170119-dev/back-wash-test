import { writeFileSync } from 'node:fs';
import { page, head } from './shared.mjs';

/* ── ข้อมูลตัวอย่าง (user จะกรอกแผนจริงเอง) ───────────────── */
const CUR = 37;
export const ITEMS = [
  { name:'ไลน์ไอซิ่ง',          freq:'ทุก 2 สัปดาห์', start:1, step:2,  job:'ตรวจระดับน้ำยาและทำความสะอาดคอยล์', who:'จักรกฤษ',
    jobs:[{t:'ตรวจระดับน้ำยาและทำความสะอาดคอยล์',every:1},{t:'อัดจาระบีมอเตอร์พัดลม',every:6},{t:'เปลี่ยนไส้กรองน้ำยา',every:13}] },
  { name:'ไลน์ต้ม 1',           freq:'ทุกเดือน',      start:3, step:4,  job:'เปลี่ยนถ่ายน้ำมันเกียร์มอเตอร์หลัก', who:'จักรกฤษ',
    jobs:[{t:'เปลี่ยนถ่ายน้ำมันเกียร์มอเตอร์หลัก',every:6},{t:'ตรวจวาล์วไอน้ำและชุดกวน',every:1},{t:'อัดจาระบีชุดกวน',every:1},{t:'เช็คสภาพซีลกันรั่ว',every:3}] },
  { name:'ไลน์ต้ม 2',           freq:'ทุกเดือน',      start:4, step:4,  job:'ตรวจวาล์วไอน้ำและชุดกวน', who:'จักรกฤษ',
    jobs:[{t:'ตรวจวาล์วไอน้ำและชุดกวน',every:1},{t:'เปลี่ยนถ่ายน้ำมันเกียร์มอเตอร์หลัก',every:6},{t:'ตรวจชุดควบคุมอุณหภูมิ',every:3}] },
  { name:'ไลน์ L1',             freq:'ทุก 2 สัปดาห์', start:2, step:2,  job:'อัดจาระบีชุดสายพานลำเลียง', who:'ณรินศ์',
    jobs:[{t:'อัดจาระบีชุดสายพานลำเลียง',every:1},{t:'ตรวจความตึงสายพาน',every:1},{t:'เปลี่ยนลูกยางหัวซีล',every:6},{t:'ตรวจชุดเซนเซอร์นับชิ้น',every:13}] },
  { name:'ไลน์ L2',             freq:'ทุก 2 สัปดาห์', start:3, step:2,  job:'เปลี่ยนลูกยางหัวซีล', who:'ณรินศ์',
    jobs:[{t:'เปลี่ยนลูกยางหัวซีล',every:1},{t:'อัดจาระบีชุดสายพานลำเลียง',every:1},{t:'ตรวจฮีตเตอร์ชุดซีล',every:6}] },
  { name:'Robot Clear Packer',  freq:'ทุก 2 สัปดาห์', start:2, step:2,  job:'อัดจาระบีแกนหมุนและตรวจหัวจับ', who:'ณรินศ์',
    jobs:[{t:'อัดจาระบีแกนหมุนและตรวจหัวจับ',every:1},{t:'เช็คลมและชุดวาล์วนิวเมติก',every:1},{t:'สอบเทียบตำแหน่งหยิบวาง',every:6},{t:'เปลี่ยนสายลมและข้อต่อ',every:13}] },
  { name:'AHU & Chiller',       freq:'ทุกเดือน',      start:3, step:4,  job:'เช็คแรงดันน้ำยาและล้างฟิลเตอร์', who:'พัฒพริศ',
    jobs:[{t:'เช็คแรงดันน้ำยาและล้างฟิลเตอร์',every:1},{t:'ล้างคอยล์เย็นและถาดน้ำทิ้ง',every:3},{t:'ตรวจมอเตอร์พัดลมและสายพาน',every:3},{t:'เปลี่ยนถุงกรองอากาศ',every:6}] },
  { name:'Cold Room',           freq:'ทุกเดือน',      start:3, step:4,  job:'ละลายน้ำแข็งคอยล์เย็นและตรวจซีลประตู', who:'พัฒพริศ',
    jobs:[{t:'ละลายน้ำแข็งคอยล์เย็นและตรวจซีลประตู',every:1},{t:'ตรวจชุดควบคุมอุณหภูมิและเทอร์โมสตัท',every:3},{t:'เช็ครอยรั่วน้ำยาและแรงดัน',every:6}] },
  { name:'RO 10,000',           freq:'ทุกเดือน',      start:1, step:4,  job:'ล้างเมมเบรนและตรวจค่าความนำไฟฟ้า', who:'พัฒพริศ',
    jobs:[{t:'ล้างเมมเบรนและตรวจค่าความนำไฟฟ้า',every:1},{t:'ล้างไส้กรอง Pre-filter',every:1},{t:'เปลี่ยนไส้กรองคาร์บอน',every:3},{t:'สอบเทียบเครื่องวัดค่า EC',every:6}] },
  { name:'RO 5,000',            freq:'ทุกเดือน',      start:2, step:4,  job:'ล้างไส้กรอง Pre-filter', who:'พัฒพริศ',
    jobs:[{t:'ล้างไส้กรอง Pre-filter',every:1},{t:'ตรวจปั๊มแรงดันสูง',every:3},{t:'เปลี่ยนเมมเบรน',every:12}] },
  { name:'บ่อซีเมนต์',           freq:'ทุก 2 สัปดาห์', start:1, step:2,  job:'ตรวจปั๊มสูบและวาล์วกันกลับ', who:'',
    jobs:[{t:'ตรวจปั๊มสูบและวาล์วกันกลับ',every:1},{t:'ลอกตะกอนและล้างบ่อ',every:6}] },
  { name:'ถุง AHU',             freq:'ทุก 6 เดือน',   start:11, step:24, job:'เปลี่ยนถุงกรองอากาศ', who:'พัฒพริศ',
    jobs:[{t:'เปลี่ยนถุงกรองอากาศ',every:1},{t:'ตรวจกรอบยึดและซีลขอบถุง',every:1}] },
  { name:'ไลน์ปี๊บ',             freq:'ทุก 2 สัปดาห์', start:1, step:2,  job:'ตรวจชุดปิดฝาและโซ่ลำเลียง', who:'จักรกฤษ',
    jobs:[{t:'ตรวจชุดปิดฝาและโซ่ลำเลียง',every:1},{t:'หยอดน้ำมันโซ่ลำเลียง',every:1},{t:'ตรวจชุดตะเข็บและแม่พิมพ์',every:6},{t:'เปลี่ยนลูกกลิ้งนำปี๊บ',every:13}] },
];
const weeksOf = (it) => { const a=[]; for(let w=it.start; w<=52; w+=it.step) a.push(w); return a; };
// สถานะแต่ละจุดแบบคงที่ (ไม่สุ่ม) — ให้ภาพเหมือนใช้งานมาแล้วครึ่งปี
// 2 รายการที่ตามแผนไม่ทัน (RO 5,000 · ไลน์ L2) ทำให้ S-Curve มีเรื่องให้ดู
const LAG = { 9: 3, 4: 4 };
export function status(i, w) {
  if (i === 11 && w === 11) return 'skip';
  if (w > CUR) return 'future';
  if (w === CUR) return (i === 0 || i === 4) ? 'done' : 'due';
  const it = ITEMS[i];
  const nth = Math.floor((w - it.start) / it.step);
  const lag = LAG[i];
  if (lag && nth % lag === lag - 1) return 'over';
  return ((i * 7 + w) % 29 === 0) ? 'over' : 'done';
}
export function weeksOfItem(it) { const a = []; for (let w = it.start; w <= 52; w += it.step) a.push(w); return a; }
// ── งานย่อยต่อเครื่อง ─────────────────────────────────────
// jobs[].every = ทำทุกกี่ "รอบของเครื่อง" (1 = ทุกครั้ง) — ถี่กว่ารอบเครื่องไม่ได้
// จุดของงานย่อยจึงเป็น subset ของจุดแถวแม่เสมอ จำนวนรอบทั้งปีไม่เปลี่ยน
export function jobWeeks(it, jobIdx) {
  const every = (it.jobs && it.jobs[jobIdx] ? it.jobs[jobIdx].every : 1) || 1;
  return weeksOfItem(it).filter((w, nth) => nth % every === 0);
}
export function jobFreqLabel(it, jobIdx) {
  const every = (it.jobs && it.jobs[jobIdx] ? it.jobs[jobIdx].every : 1) || 1;
  if (every === 1) return 'ทุกครั้ง';
  const wk = it.step * every;
  if (wk >= 48) return 'ปีละครั้ง';
  if (wk >= 24) return 'ทุก 6 เดือน';
  if (wk >= 12) return 'ทุก 3 เดือน';
  return `ทุก ${wk} สัปดาห์`;
}
export const CUR_WEEK = CUR;
// ปฏิทิน ISO ปี 2026 — W37 = 7-13 ก.ย. (ตรวจกับ Date จริงแล้ว)
const TH_MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
export function mondayOf(w, y = 2026) {
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const dn = (jan4.getUTCDay() + 6) % 7;
  const m = new Date(jan4);
  m.setUTCDate(jan4.getUTCDate() - dn + (w - 1) * 7);
  return m;
}
export const thDate = (d) => `${d.getUTCDate()} ${TH_MON[d.getUTCMonth()]}`;
export const thDateY = (d) => `${thDate(d)} ${d.getUTCFullYear()}`;
const DOT = {
  future:'background:transparent;border:1.5px solid var(--sep)',
  due:'background:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)',
  over:'background:var(--danger)',
  done:'background:var(--ok)',
  skip:'background:transparent;border:1.5px dashed var(--muted)',
};

/* ══════════ 1. สัปดาห์นี้ ══════════ */
/* การ์ดทุกใบสร้างจากแผนชุดเดียวกับตารางทั้งปี — เลขในแถบสถิติจึงตรงกับที่เห็นในลิสต์เสมอ */
const sundayOf = (w) => { const d = mondayOf(w); d.setUTCDate(d.getUTCDate() + 6); return d; };
const TODAY = new Date(Date.UTC(2026, 8, 9));
const daysLate = (w) => Math.round((TODAY - sundayOf(w)) / 86400000);

const overAll = [];
ITEMS.forEach((it, i) => weeksOfItem(it).forEach(w => {
  if (w < CUR && status(i, w) === 'over') overAll.push({ i, it, w });
}));
overAll.sort((x, y) => y.w - x.w);
const carry = overAll.slice(0, 3);
const thisWeek = ITEMS.map((it, i) => ({ i, it, st: status(i, CUR) }))
  .filter(x => weeksOfItem(x.it).includes(CUR));
const doneCnt = thisWeek.filter(x => x.st === 'done').length;
const dueCnt = thisWeek.length - doneCnt + 1;            // +1 = งานเพิ่มเองของสัปดาห์นี้
const weekTotal = thisWeek.length + 1;

const kindChip = { pm:'<span class="chip kind-pm">🔧 บำรุงรักษา</span>',
  up:'<span class="chip kind-up">⬆️ ปรับปรุง</span>', fix:'<span class="chip kind-fix">🛠 แก้ไข</span>' };
const srcChip = { plan:'<span class="src plan">แผนประจำปี</span>', adhoc:'<span class="src adhoc">งานเพิ่มเอง</span>' };
const thumbs = (n) => n ? `<div class="thumbs">
      ${n>1?'<div class="th b">รูปก่อนทำ</div>':''}<div class="th">${n>1?'รูปหลังทำ':'รูปก่อนทำ'}</div>
      <div class="th" style="border-style:dashed;background:transparent">＋ แนบรูป</div>
    </div>` : '';
const taskCard = (k) => `<article class="tk ${k.st}">
  <div class="r1">
    <h3${k.st==='done'?' style="text-decoration:line-through;text-decoration-color:var(--sep)"':''}>${k.t}</h3>
    ${kindChip[k.kind]}${k.freq?`<span class="chip freq">${k.freq}</span>`:''}${srcChip[k.src]}${k.extra||''}
  </div>
  <div class="meta">
    <span>🔩 ${k.m}</span><span class="dot">·</span>
    <span>👤 ${k.who || 'ยังไม่มอบหมาย'}</span><span class="dot">·</span>
    <span>📅 ครบกำหนด ${k.due}</span>
    ${k.done?`<span class="dot">·</span><span style="color:var(--ok);font-weight:600">✅ ${k.done}</span>`:''}
    ${k.skip?`<span class="dot">·</span><span style="color:var(--muted)">🚫 ${k.skip}</span>`:''}
  </div>
  ${thumbs(k.photos)}
  <div class="acts">
    ${k.st==='done'
      ? '<button class="ibtn sm">↩ เปิดงานใหม่</button><button class="ibtn sm">🖼 ดูรูป</button><span class="lock-note">🔒 ยกเลิกได้เฉพาะหัวหน้างาน</span>'
      : k.st==='skip'
        ? '<button class="ibtn sm">▶️ เปิดใช้งานรอบนี้</button>'
        : '<button class="ibtn sm ok">✅ ทำเสร็จแล้ว</button><button class="ibtn sm">📅 เลื่อนวัน</button><button class="ibtn sm">👤 มอบหมาย</button><button class="ibtn sm">⛔ ปิดรอบนี้</button><button class="ibtn sm">✏️</button>'}
  </div>
</article>`;

const lateCards = carry.map(({ it, w }, n) => taskCard({
  st:'late', t:`${it.name} — ${it.job}`, m:it.name, who:it.who, freq:it.freq, src:'plan', kind:'pm',
  due:`W${w} · ${thDate(mondayOf(w))}`,
  extra:`<span class="chip stop">เกินกำหนด ${daysLate(w)} วัน</span>`,
  photos: n === 0 ? 1 : 0,
})).join('\n');

const weekCards = thisWeek.map(({ it, st }) => taskCard({
  st: st === 'done' ? 'done' : 'due',
  t:`${it.name} — ${it.job}`, m:it.name, who:it.who, freq:it.freq, src:'plan', kind:'pm',
  due:`W${CUR} · ${thDate(mondayOf(CUR))}–${thDate(sundayOf(CUR))}`,
  extra: it.who ? '' : '<span class="chip warn">ยังไม่มีคนรับ</span>',
  done: st === 'done' ? `เสร็จเมื่อ 8 ก.ย. โดย ${it.who}` : '',
  photos: st === 'done' ? 2 : 0,
})).join('\n');

const extraCards = [
  taskCard({ st:'due', t:'ไลน์ L4 — เปลี่ยนสายพานลำเลียงเส้นที่ 2', m:'ไลน์ L4', who:'พัฒพริศ',
    freq:'', src:'adhoc', kind:'fix', due:'11 ก.ย. 2026 · 09:00',
    extra:'<span class="chip mute">🔔 เตือนล่วงหน้า 1 วัน</span>' }),
  taskCard({ st:'skip', t:'ไลน์ A3 — ตรวจชุดเติมลมและหัวจ่าย', m:'ไลน์ A3', who:'—',
    freq:'ทุก 2 สัปดาห์', src:'plan', kind:'pm', due:`W${CUR}`,
    skip:'ปิดรอบนี้ — เครื่องยังไม่ติดตั้ง (โดย จักรกฤษ)' }),
].join('\n');

writeFileSync('Main.dc.html', page(`<div class="wrap">
${head('plan','week')}

<div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;margin-bottom:2px">
  <button class="ibtn" style="padding:6px 12px">‹</button>
  <div>
    <div style="font-family:var(--font-head);font-size:17px;font-weight:600;letter-spacing:-.02em">สัปดาห์ที่ ${CUR} / 2026</div>
    <div style="font-size:12px;color:var(--ink-soft)">จ. ${thDate(mondayOf(CUR))} – อา. ${thDate(sundayOf(CUR))} 2026 · สัปดาห์ปัจจุบัน</div>
  </div>
  <button class="ibtn" style="padding:6px 12px">›</button>
  <button class="ibtn">วันนี้</button>
  <div class="sp"></div>
  <select class="isel"><option>🔩 ทุกเครื่อง / พื้นที่</option></select>
  <button class="ibtn pri">➕ ตั้งงาน PM</button>
</div>

<div class="istats">
  <div class="istat"><div class="l">🗓️ ต้องทำสัปดาห์นี้</div><div class="v">${weekTotal}<span class="u">รายการ</span></div></div>
  <div class="istat good"><div class="l">✅ ทำแล้ว</div><div class="v">${doneCnt}<span class="u">/ ${weekTotal}</span></div></div>
  <div class="istat gap"><div class="l">⏳ ยังไม่ทำ</div><div class="v">${dueCnt}<span class="u">รายการ</span></div></div>
  <div class="istat hot"><div class="l">⚠️ ค้างจากสัปดาห์ก่อน</div><div class="v">${overAll.length}<span class="u">รายการ</span></div></div>
  <div class="istat"><div class="l">🚫 ปิดใช้งานรอบนี้</div><div class="v" style="color:var(--muted)">1</div></div>
</div>

<div class="warnbox" style="margin-bottom:14px">
  <b>ค้างจากสัปดาห์ก่อน ${overAll.length} รายการ</b> — ยกมาไว้บนสุดจนกว่าจะปิดงานหรือปิดรอบ ไม่ปล่อยให้ตกหล่นไปกับสัปดาห์เก่า
  (แสดง 3 รอบที่ใกล้ปัจจุบันที่สุด)
</div>

<div class="ilist">${lateCards}</div>
<div style="margin:11px 0 16px"><button class="ibtn">📋 ดูงานค้างทั้งหมด ${overAll.length} รายการ</button></div>
<div class="ilist">${weekCards}
${extraCards}</div>
</div>`, `.tk.late .meta{color:var(--ink-soft)}`));

/* ══════════ 2. ตารางทั้งปี ══════════ */
const cell = (i,w,due) => {
  if (!due) return `<td class="wk${w===CUR?' cur':''}"></td>`;
  const st = status(i,w);
  return `<td class="wk${w===CUR?' cur':''}"><span class="d" style="${DOT[st]}"></span></td>`;
};
const rows = ITEMS.map((it,i)=>{
  const ws = weeksOf(it);
  const done = ws.filter(w=>w<=CUR && status(i,w)==='done').length;
  const plan = ws.filter(w=>w<=CUR && status(i,w)!=='skip').length;
  return `<tr>
    <th class="nm">${it.name}</th>
    <th class="fq">${it.freq}</th>
    <th class="pc"><span style="color:${done===plan?'var(--ok)':'var(--warn)'};font-weight:700">${done}</span><span style="color:var(--muted)">/${plan}</span></th>
    ${Array.from({length:52},(_,k)=>cell(i,k+1,ws.includes(k+1))).join('')}
  </tr>`;
}).join('\n');
const heads = Array.from({length:52},(_,k)=>`<th class="wkh${k+1===CUR?' cur':''}">${k+1}</th>`).join('');

writeFileSync('YearGrid.dc.html', page(`<div class="wrap">
${head('plan','year')}
<div class="card" style="padding:14px 16px">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
    <h3 style="font-size:15px">ตารางแผน PM ทั้งปี</h3>
    <select class="isel"><option>ปี 2026 (ISO Week)</option></select>
    <div class="sp"></div>
    <button class="ibtn">⛔ โหมดเปิด/ปิดรายการ</button>
    <button class="ibtn">⚙️ จัดการแผน PM</button>
    <button class="ibtn">📊 Export Excel</button>
  </div>
  <div class="mx">
    <table class="grid">
      <thead><tr><th class="nm">รายการ PM</th><th class="fq">ความถี่</th><th class="pc">ทำแล้ว</th>${heads}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="legend">
    <span><i style="${DOT.future}"></i>ยังไม่ถึงกำหนด</span>
    <span><i style="${DOT.due}"></i>ครบกำหนดสัปดาห์นี้</span>
    <span><i style="${DOT.over}"></i>เลยกำหนด ยังไม่ทำ</span>
    <span><i style="${DOT.done}"></i>ทำแล้ว</span>
    <span><i style="${DOT.skip}"></i>ปิดใช้งาน (ไม่นับในแผน)</span>
    <span class="dot" style="color:var(--muted)">·</span>
    <span>คลิกที่จุดเพื่อบันทึกว่าทำแล้ว</span>
  </div>
</div>
</div>`, `
.mx{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
table.grid{border-collapse:collapse;font-size:11.5px;font-family:var(--font-body)}
table.grid th{font-weight:600;color:var(--ink-soft);padding:0;background:var(--surface-2)}
table.grid thead th{position:sticky;top:0;border-bottom:1px solid var(--line)}
table.grid th.nm{width:190px;min-width:190px;text-align:left;padding:7px 11px;font-family:var(--font-head);
  font-size:12.3px;color:var(--ink);background:var(--card);border-right:1px solid var(--line)}
table.grid th.fq{width:112px;min-width:112px;text-align:left;padding:7px 9px;background:var(--card);color:var(--ink-soft);font-size:11.3px}
table.grid th.pc{width:62px;min-width:62px;text-align:right;padding:7px 11px;background:var(--card);
  border-right:1px solid var(--line);font-variant-numeric:tabular-nums;font-size:11.5px}
table.grid th.wkh{width:21px;min-width:21px;font-size:9.5px;color:var(--muted);text-align:center;padding:6px 0;font-weight:500}
table.grid th.wkh.cur{color:var(--brand-deep);font-weight:700;background:var(--brand-soft)}
table.grid tbody tr:nth-child(even) th.nm,table.grid tbody tr:nth-child(even) th.fq,
table.grid tbody tr:nth-child(even) th.pc{background:var(--surface-3)}
table.grid tbody tr:nth-child(even) td{background:rgba(251,247,243,.6)}
table.grid td.wk{width:21px;min-width:21px;height:26px;text-align:center;border-left:1px solid #f6f1ec}
table.grid td.wk.cur{background:var(--brand-soft)}
table.grid tbody tr:nth-child(even) td.wk.cur{background:#ffeadb}
table.grid .d{width:9px;height:9px;border-radius:50%;display:inline-block;vertical-align:middle}
`));
