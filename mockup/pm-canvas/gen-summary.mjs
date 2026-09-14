import { writeFileSync } from 'node:fs';
import { page, head } from './shared.mjs';
import { ITEMS, status, weeksOfItem, CUR_WEEK as CUR, mondayOf } from './gen-views.mjs';

/* ── ตัวเลขทุกตัวคำนวณจากข้อมูลชุดเดียวกับตารางทั้งปี ─────── */
const stat = ITEMS.map((it, i) => {
  let planYear = 0, done = 0, over = 0, skip = 0;
  weeksOfItem(it).forEach(w => {
    const s = status(i, w);
    if (s === 'skip') { skip++; return; }
    planYear++;
    if (s === 'done') done++;
    if (s === 'over') over++;
  });
  return { name: it.name, planYear, done, over, skip, pct: Math.round(done / (done + over) * 100) };
});
const T = stat.reduce((a, s) => ({
  planYear: a.planYear + s.planYear, done: a.done + s.done, over: a.over + s.over, skip: a.skip + s.skip,
}), { planYear: 0, done: 0, over: 0, skip: 0 });
const pctToDate = Math.round(T.done / (T.done + T.over) * 100);

// S-Curve: % สะสมรายเดือน — แผนนับจากเดือนของสัปดาห์ที่ครบกำหนด · ผลจริงนับเฉพาะที่ทำแล้ว
const planM = new Array(12).fill(0), actM = new Array(12).fill(0);
ITEMS.forEach((it, i) => weeksOfItem(it).forEach(w => {
  const s = status(i, w); if (s === 'skip') return;
  const m = mondayOf(w).getUTCMonth();
  for (let k = m; k < 12; k++) planM[k]++;
  if (s === 'done') for (let k = m; k < 12; k++) actM[k]++;
}));
const CUR_M = mondayOf(CUR).getUTCMonth();
const PLAN = planM.map(v => Math.round(v / T.planYear * 100));
const ACT = actM.slice(0, CUR_M + 1).map(v => Math.round(v / T.planYear * 100));

const MO = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const W = 1060, H = 268, L = 46, R = 92, T_ = 14, B = 34;
const x = (i) => L + i * (W - L - R) / 11;
const y = (v) => T_ + (100 - v) * (H - T_ - B) / 100;
const pts = (a) => a.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
const grid = [0, 25, 50, 75, 100].map(v =>
  `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="#eee3d9" stroke-width="1"/>
   <text x="${L - 9}" y="${y(v) + 4}" text-anchor="end" font-size="10.5" fill="#a49a90">${v}%</text>`).join('');
const xl = MO.map((m, i) =>
  `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-size="10.5" fill="${i === CUR_M ? '#c24f00' : '#a49a90'}"
    font-weight="${i === CUR_M ? 700 : 400}">${m}</text>`).join('');
const dots = (a, c) => a.map((v, i) =>
  `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#fff" stroke="${c}" stroke-width="2"/>`).join('');

const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
  aria-label="กราฟ S-Curve เปรียบเทียบเปอร์เซ็นต์แผน PM สะสมกับผลจริงสะสมรายเดือน ปี 2026">
  ${grid}${xl}
  <line x1="${x(CUR_M)}" y1="${T_}" x2="${x(CUR_M)}" y2="${H - B}" stroke="#c24f00" stroke-width="1" stroke-dasharray="3 4" opacity=".45"/>
  <polyline points="${pts(PLAN)}" fill="none" stroke="#c24f00" stroke-width="2" stroke-dasharray="7 5"/>
  <polyline points="${pts(ACT)}" fill="none" stroke="#1565c0" stroke-width="2"/>
  ${dots(PLAN, '#c24f00')}${dots(ACT, '#1565c0')}
  <text x="${x(11) + 9}" y="${y(100) + 4}" font-size="11.5" font-weight="700" fill="#c24f00">แผน 100%</text>
  <text x="${x(CUR_M) + 9}" y="${y(ACT[CUR_M]) + 4}" font-size="11.5" font-weight="700" fill="#1565c0">ผลจริง ${ACT[CUR_M]}%</text>
  <text x="${x(CUR_M)}" y="${T_ + 11}" text-anchor="middle" font-size="10" fill="#c24f00">วันนี้</text>
</svg>`;

const worst = [...stat].sort((a, b) => a.pct - b.pct).filter(s => s.pct < 100).slice(0, 2);
const rows = stat.map(s => {
  const c = s.pct >= 95 ? 'var(--ok)' : s.pct >= 80 ? 'var(--warn)' : 'var(--danger)';
  return `<tr><td style="font-weight:600">${s.name}</td><td class="num">${s.planYear}</td><td class="num">${s.done}</td>
  <td class="num">${s.over ? `<span style="color:var(--danger);font-weight:700">${s.over}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
  <td style="width:150px"><div class="bar"><span style="width:${s.pct}%;background:${c}"></span></div></td>
  <td class="num" style="color:${c};font-weight:700">${s.pct}%</td></tr>`;
}).join('');

writeFileSync('Summary.dc.html', page(`<div class="wrap">
${head('sum', null)}

<div style="display:flex;align-items:center;gap:10px;margin:16px 0 0;flex-wrap:wrap">
  <select class="isel"><option>ปี 2026</option></select>
  <span class="hintline">แผนงาน PM ปี 2026: ทั้งหมด ${T.planYear} รอบ · นับผลถึงสัปดาห์ที่ ${CUR}</span>
  <div class="sp"></div>
  <button class="ibtn">📊 Export Excel</button>
  <button class="ibtn">📸 Export Dashboard 16:9</button>
</div>

<div class="istats">
  <div class="istat"><div class="l">🗓️ แผนทั้งหมด (ปี 2026)</div><div class="v">${T.planYear}<span class="u">รอบ</span></div></div>
  <div class="istat good"><div class="l">✅ ดำเนินการเสร็จแล้ว</div><div class="v">${T.done}</div></div>
  <div class="istat hot"><div class="l">⚠️ เลยกำหนด / ยังไม่ทำ</div><div class="v">${T.over}</div></div>
  <div class="istat"><div class="l">📈 % แผนที่ทำได้ถึงวันนี้</div><div class="v" style="color:var(--cip1)">${pctToDate}<span class="u">%</span></div></div>
  <div class="istat"><div class="l">🚫 ปิดใช้งาน (ไม่นับ)</div><div class="v" style="color:var(--muted)">${T.skip + 1}</div></div>
</div>

<div class="card" style="padding:15px 18px 12px">
  <div style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:6px">
    <div>
      <h3 style="font-size:15px">S-Curve — % แผน PM สะสม เทียบผลจริงสะสม</h3>
      <div class="hintline">ปี 2026 · รอบที่ถูกปิดใช้งานไม่ถูกนับทั้งฝั่งแผนและฝั่งผลจริง</div>
    </div>
    <div class="sp"></div>
    <div class="legend" style="margin:0">
      <span><i style="background:#c24f00"></i>แผน (สะสม)</span>
      <span><i style="background:#1565c0"></i>ผลจริง (สะสม)</span>
    </div>
  </div>
  ${svg}
  <div class="infobox" style="margin-top:4px">
    สิ้นเดือน ก.ย. ผลจริงตามหลังแผนอยู่ <b>${PLAN[CUR_M] - ACT[CUR_M]} จุด</b> —
    ส่วนใหญ่มาจาก ${worst.map(w => `${w.name} (${w.pct}%)`).join(' และ ')}
  </div>
</div>

<div class="card" style="padding:4px 4px 8px;margin-top:14px">
  <div style="display:flex;align-items:center;gap:10px;padding:12px 14px 4px">
    <h3 style="font-size:15px">สรุปผล PM รายรายการ (ปี 2026)</h3>
    <span class="chip mute">% คิดจากรอบที่ถึงกำหนดแล้ว</span>
  </div>
  <table class="tb">
    <thead><tr><th>รายการ PM</th><th class="num">แผนทั้งปี</th><th class="num">เสร็จแล้ว</th>
      <th class="num">เลยกำหนด</th><th>ความคืบหน้าถึงวันนี้</th><th class="num">% เสร็จ</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
</div>`, `
.hintline{font-size:11.5px;color:var(--muted)}
.bar{height:7px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden}
.bar span{display:block;height:100%;border-radius:999px}
table.tb th.num{text-align:right}
`));
console.log('summary:', JSON.stringify(T), 'pct', pctToDate, 'plan@sep', PLAN[CUR_M], 'act@sep', ACT[CUR_M]);
