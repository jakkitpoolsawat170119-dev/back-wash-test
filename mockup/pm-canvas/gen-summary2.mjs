import { writeFileSync } from 'node:fs';
import { page, head } from './shared.mjs';
import { ITEMS, status, weeksOfItem, CUR_WEEK as CUR, mondayOf } from './gen-views.mjs';

/* ══════════ v2: หน้าสรุปผล ══════════
   ปัญหาเดิม: 93% กับ 64% วางคู่กันทั้งที่ตัวหารคนละตัว (153/164 รอบที่ถึงกำหนด กับ 150/234 รอบทั้งปี)
   → รอบนี้ "ทุกตัวเลขต้องพกตัวหารมาด้วย" ทั้งในช่องสถิติและบนกราฟ */

const stat = ITEMS.map((it, i) => {
  let planYear = 0, done = 0, over = 0, skip = 0;
  weeksOfItem(it).forEach(w => {
    const s = status(i, w);
    if (s === 'skip') { skip++; return; }
    planYear++;
    if (s === 'done') done++;
    if (s === 'over') over++;
  });
  return { name: it.name, planYear, done, over, skip, due: done + over, pct: Math.round(done / (done + over) * 100) };
});
const T = stat.reduce((a, s) => ({
  planYear: a.planYear + s.planYear, done: a.done + s.done, over: a.over + s.over, skip: a.skip + s.skip,
}), { planYear: 0, done: 0, over: 0, skip: 0 });
const dueToDate = T.done + T.over;
const pctToDate = Math.round(T.done / dueToDate * 100);

// S-Curve: % สะสมรายเดือน — ตัวหารเดียวกันทั้งสองเส้น = จำนวนรอบทั้งปี
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
const GAP = PLAN[CUR_M] - ACT[CUR_M];

const MO = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const W = 1060, H = 288, L = 46, R = 128, T_ = 26, B = 34;
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
// ระบายช่องว่างแผน-ผลจริง ให้เห็น "ตามหลังอยู่เท่าไร" ด้วยตา ไม่ต้องอ่านตัวเลข
const band = `<polygon fill="rgba(255,107,0,.13)" points="${
  PLAN.slice(0, CUR_M + 1).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} ${
  ACT.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' ')}"/>`;

const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
  aria-label="กราฟ S-Curve เทียบ % แผน PM สะสมกับผลจริงสะสมรายเดือน ปี 2026 ทั้งสองเส้นคิดจากรอบทั้งปี ${T.planYear} รอบ">
  ${grid}${xl}${band}
  <line x1="${x(CUR_M)}" y1="${T_}" x2="${x(CUR_M)}" y2="${H - B}" stroke="#c24f00" stroke-width="1" stroke-dasharray="3 4" opacity=".45"/>
  <polyline points="${pts(PLAN)}" fill="none" stroke="#c24f00" stroke-width="2" stroke-dasharray="7 5"/>
  <polyline points="${pts(ACT)}" fill="none" stroke="#1565c0" stroke-width="2"/>
  ${dots(PLAN, '#c24f00')}${dots(ACT, '#1565c0')}
  <text x="${x(11) + 9}" y="${y(100) + 4}" font-size="11.5" font-weight="700" fill="#c24f00">แผน 100%</text>
  <g paint-order="stroke" stroke="#faf7f4" stroke-width="3.5" stroke-linejoin="round">
    <text x="${x(CUR_M) - 9}" y="${y(PLAN[CUR_M]) - 10}" text-anchor="end" font-size="11.5" font-weight="700" fill="#c24f00">แผนถึงสิ้น ${MO[CUR_M]} ${PLAN[CUR_M]}%</text>
    <text x="${x(CUR_M) - 9}" y="${y(ACT[CUR_M]) + 17}" text-anchor="end" font-size="11.5" font-weight="700" fill="#1565c0">ทำจริง ${ACT[CUR_M]}%</text>
    <text x="${x(CUR_M) + 9}" y="${(y(PLAN[CUR_M]) + y(ACT[CUR_M])) / 2 + 4}" font-size="11" font-weight="700" fill="#c24f00">ตามหลัง ${GAP} จุด</text>
  </g>
  <text x="${x(CUR_M)}" y="${T_ - 8}" text-anchor="middle" font-size="10" fill="#c24f00">วันนี้</text>
  <text x="${L}" y="${T_ - 8}" font-size="10.5" fill="#a49a90">ทั้งสองเส้นคิดจากรอบทั้งปี ${T.planYear} รอบ</text>
</svg>`;

const worst = [...stat].sort((a, b) => a.pct - b.pct).filter(s => s.pct < 100).slice(0, 2);
// เรียงตัวที่ตกที่สุดขึ้นก่อน — คนเปิดหน้านี้มาหาว่า "ตัวไหนมีปัญหา"
const rows = [...stat].sort((a, b) => a.pct - b.pct || b.over - a.over).map(s => {
  const c = s.pct >= 95 ? 'var(--ok)' : s.pct >= 80 ? 'var(--warn)' : 'var(--danger)';
  return `<tr${s.pct < 80 ? ' class="bad"' : ''}><td style="font-weight:600">${s.name}</td>
  <td class="num">${s.planYear}</td>
  <td class="num">${s.due}</td>
  <td class="num" style="color:var(--ok);font-weight:600">${s.done}</td>
  <td class="num">${s.over ? `<span style="color:var(--danger);font-weight:700">${s.over}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
  <td style="width:170px"><div class="bar"><span style="width:${s.pct}%;background:${c}"></span></div>
    <div class="bcap">${s.done} จาก ${s.due} รอบที่ถึงกำหนด</div></td>
  <td class="num" style="color:${c};font-weight:700">${s.pct}%</td></tr>`;
}).join('');

writeFileSync('Summary2.dc.html', page(`<div class="wrap">
${head('sum', null)}

<div style="display:flex;align-items:center;gap:10px;margin:16px 0 0;flex-wrap:wrap">
  <select class="isel"><option>ปี 2026</option></select>
  <span class="hintline">แผนงาน PM ปี 2026 · นับผลถึงสัปดาห์ที่ ${CUR} (${MO[CUR_M]})</span>
  <div class="sp"></div>
  <button class="ibtn">📊 Export Excel</button>
  <button class="ibtn">📸 Export Dashboard 16:9</button>
</div>

<div class="sgroups">
  <section class="sgrp">
    <h4>แผนทั้งปี</h4>
    <div class="srow">
      <div class="istat"><div class="l">🗓️ รอบที่วางแผนไว้</div>
        <div class="v">${T.planYear}<span class="u">รอบ</span></div></div>
      <div class="istat"><div class="l">🚫 ปิดใช้งาน (ไม่นับทั้งแผนและผล)</div>
        <div class="v" style="color:var(--muted)">${T.skip + 1}<span class="u">รอบ</span></div></div>
    </div>
  </section>
  <section class="sgrp">
    <h4>ถึงวันนี้ (สัปดาห์ที่ ${CUR})</h4>
    <div class="srow">
      <div class="istat"><div class="l">📆 ถึงกำหนดแล้ว</div>
        <div class="v">${dueToDate}<span class="u">รอบ</span></div></div>
      <div class="istat good"><div class="l">✅ ทำเสร็จแล้ว</div>
        <div class="v">${T.done}<span class="u">รอบ</span></div></div>
      <div class="istat hot"><div class="l">⚠️ เลยกำหนด ยังไม่ทำ</div>
        <div class="v">${T.over}<span class="u">รอบ</span></div></div>
      <div class="istat big"><div class="l">📈 ทำได้ตามแผนที่ถึงกำหนด</div>
        <div class="v" style="color:var(--cip1)">${pctToDate}<span class="u">%</span></div>
        <div class="den">${T.done} จาก ${dueToDate} รอบ</div></div>
    </div>
  </section>
</div>

<div class="card" style="padding:15px 18px 12px">
  <div style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:6px">
    <div>
      <h3 style="font-size:15px">S-Curve — % แผน PM สะสม เทียบผลจริงสะสม</h3>
      <div class="hintline">คนละตัวหารกับช่อง “ทำได้ตามแผนที่ถึงกำหนด ${pctToDate}%” ข้างบน —
        กราฟนี้คิดจาก <b>รอบทั้งปี ${T.planYear} รอบ</b> ส่วนช่องนั้นคิดจาก <b>รอบที่ถึงกำหนดแล้ว ${dueToDate} รอบ</b></div>
    </div>
    <div class="sp"></div>
    <div class="legend" style="margin:0">
      <span><i style="background:#c24f00"></i>แผน (สะสม)</span>
      <span><i style="background:#1565c0"></i>ผลจริง (สะสม)</span>
      <span><i style="background:rgba(255,107,0,.32)"></i>ช่องว่าง</span>
    </div>
  </div>
  ${svg}
  <div class="infobox" style="margin-top:4px">
    สิ้นเดือน ${MO[CUR_M]} ผลจริงตามหลังแผนอยู่ <b>${GAP} จุด</b> —
    ส่วนใหญ่มาจาก ${worst.map(w => `${w.name} (${w.done}/${w.due} รอบ = ${w.pct}%)`).join(' และ ')}
  </div>
</div>

<div class="card" style="padding:4px 4px 8px;margin-top:14px">
  <div style="display:flex;align-items:center;gap:10px;padding:12px 14px 4px;flex-wrap:wrap">
    <h3 style="font-size:15px">สรุปผล PM รายเครื่อง (ปี 2026)</h3>
    <span class="chip mute">เรียงตัวที่ตกแผนมากสุดขึ้นก่อน</span>
  </div>
  <div class="tw2">
    <table class="tb">
      <thead><tr><th>เครื่อง / พื้นที่</th><th class="num">แผนทั้งปี</th><th class="num">ถึงกำหนดแล้ว</th>
        <th class="num">เสร็จ</th><th class="num">ค้าง</th><th>ความคืบหน้าถึงวันนี้</th><th class="num">%</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>
</div>`, `
.hintline{font-size:11.5px;color:var(--muted);max-width:620px;line-height:1.55}
.hintline b{color:var(--ink-soft)}
.sgroups{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start;margin:14px 0}
.sgrp h4{font-family:var(--font-head);font-size:11.5px;font-weight:700;color:var(--muted);margin-bottom:6px;
  text-transform:none;letter-spacing:0}
.srow{display:flex;gap:10px;flex-wrap:wrap}
.srow .istat{min-width:132px;flex:1}
.istat.big{min-width:186px;background:linear-gradient(180deg,#eef5fb,var(--card) 72%);border-color:#cfe3f3}
.istat .den{font-size:11px;color:var(--ink-soft);margin-top:1px;font-variant-numeric:tabular-nums}
.tw2{overflow-x:auto}
.bar{height:7px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden}
.bar span{display:block;height:100%;border-radius:999px}
.bcap{font-size:10.5px;color:var(--muted);margin-top:3px;font-variant-numeric:tabular-nums}
table.tb{min-width:760px}
table.tb th.num,table.tb td.num{text-align:right;font-variant-numeric:tabular-nums}
table.tb tr.bad td{background:var(--danger-soft-bg)}
table.tb tr.bad td:first-child{box-shadow:inset 3px 0 0 var(--danger)}
@media(max-width:1000px){.sgroups{grid-template-columns:1fr}}
`));
console.log('summary2:', JSON.stringify(T), '· ถึงกำหนด', dueToDate, '· pct', pctToDate,
  '· แผน@' + MO[CUR_M], PLAN[CUR_M], '· จริง', ACT[CUR_M], '· ห่าง', GAP);
