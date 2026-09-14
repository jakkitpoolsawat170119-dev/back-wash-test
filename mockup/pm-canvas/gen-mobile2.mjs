import { writeFileSync } from 'node:fs';
import { page } from './shared.mjs';
import { ITEMS, status, weeksOfItem, CUR_WEEK as CUR, mondayOf } from './gen-views.mjs';

/* ══════════ v2: 2 จอมือถือใหม่ — ตารางทั้งปี + สรุปผล ══════════
   ตาราง 52 ช่องยัดจอ 390px ไม่ได้ → ตัดเป็นไตรมาส 13 สัปดาห์ แล้ววางเป็นรายการต่อแถว */

const MO = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const monthOf = (w) => { const d = mondayOf(w); d.setUTCDate(d.getUTCDate() + 3); return d.getUTCMonth(); };
const DOT = {
  future:'background:transparent;border:1.5px solid var(--sep)',
  due:'background:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)',
  over:'background:var(--danger)',
  done:'background:var(--ok)',
  skip:'background:transparent;border:1.5px dashed var(--muted)',
};
const Q = Math.ceil(CUR / 13);
const QW = Array.from({ length: 13 }, (_, k) => (Q - 1) * 13 + k + 1);

const MCSS = `
body{background:var(--paper)}
.mw{padding:12px 12px 78px}
.mhead{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.mhead h1{font-size:19px;letter-spacing:-.03em}
.mhead .sub{font-size:11.5px;color:var(--ink-soft)}
.nav{width:44px;height:44px;border-radius:12px;border:1px solid var(--line);background:var(--surface-3);
  color:var(--ink-soft);font-size:14px}
.tabbar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);border-top:1px solid var(--line);
  display:grid;grid-template-columns:repeat(4,1fr);padding:6px 6px calc(6px + env(safe-area-inset-bottom));gap:4px}
.tb{border:none;background:transparent;min-height:48px;border-radius:12px;font-family:var(--font-head);
  font-size:11px;font-weight:600;color:var(--ink-soft);display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:2px;cursor:pointer}
.tb .i{font-size:17px;line-height:1}
.tb.on{background:var(--brand-soft);color:var(--brand-deep)}

/* แถบเลือกไตรมาส */
.qbar{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;background:var(--surface-2);
  border:1px solid var(--line);border-radius:14px;padding:4px;margin-bottom:9px}
.qb{min-height:38px;border:none;background:transparent;border-radius:11px;font-family:var(--font-head);
  font-size:13px;font-weight:600;color:var(--ink-soft);cursor:pointer}
.qb.on{background:var(--card);color:var(--brand-deep);box-shadow:var(--shadow-card)}
.qcap{font-size:11.5px;color:var(--ink-soft);margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap}
.qcap b{color:var(--ink)}

/* แถวหนึ่ง = เครื่องหนึ่ง พร้อมแถบ 13 สัปดาห์ของไตรมาส */
.yr{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:9px 10px 10px;
  box-shadow:var(--shadow-card);margin-bottom:8px}
.yr .top{display:flex;align-items:baseline;gap:7px;margin-bottom:2px}
.yr h3{font-size:13.5px;flex:1;line-height:1.35}
.yr .fq{font-size:10.5px;color:var(--ink-soft);background:var(--surface-2);border-radius:999px;padding:1px 8px;
  white-space:nowrap}
.yr .cnt{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.wks{display:grid;grid-template-columns:repeat(13,1fr);gap:2px;margin-top:6px}
.wn{font-size:8.5px;color:var(--muted);text-align:center;font-variant-numeric:tabular-nums;line-height:1.4}
.wn.cur{color:var(--brand-deep);font-weight:700}
.wc{height:26px;border:none;background:var(--surface-3);border-radius:7px;display:grid;place-items:center;
  cursor:pointer;padding:0;transition:transform .18s cubic-bezier(.34,1.56,.64,1)}
.wc:active{transform:scale(.92)}
.wc.cur{background:var(--brand-soft)}
.wc.off{background:transparent}
.wc i{width:10px;height:10px;border-radius:50%;display:block}
.mbar{height:5px;border-radius:999px;background:var(--surface-2);overflow:hidden;margin-top:7px}
.mbar span{display:block;height:100%;border-radius:999px}
.mleg{display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--ink-soft);margin:10px 2px 0}
.mleg i{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px;vertical-align:-1px}

/* สรุปผล */
.m2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.mc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 12px;box-shadow:var(--shadow-card)}
.mc .l{font-size:11px;color:var(--ink-soft)}
.mc .v{font-family:var(--font-head);font-size:24px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.mc .d{font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.mc.hot{border-color:var(--p-stop);background:linear-gradient(180deg,var(--p-stop-w),var(--card) 70%)}
.mc.hot .v{color:var(--p-stop)}
.chartcard{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:11px 12px 6px;
  box-shadow:var(--shadow-card);margin-bottom:10px}
.chartcard h3{font-size:13px;margin-bottom:1px}
.chartcard .s{font-size:10.8px;color:var(--muted);margin-bottom:6px;line-height:1.5}
.sec{font-family:var(--font-head);font-size:11.5px;font-weight:700;color:var(--muted);margin:2px 2px 7px}
.si{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:9px 11px 10px;
  box-shadow:var(--shadow-card);margin-bottom:7px}
.si.bad{border-left:4px solid var(--danger)}
.si .top{display:flex;align-items:baseline;gap:8px}
.si h3{font-size:13.5px;flex:1}
.si .p{font-family:var(--font-head);font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.si .d{font-size:10.8px;color:var(--muted);margin-top:3px;font-variant-numeric:tabular-nums}
`;

/* ── จอ 1: ตารางทั้งปี (ไตรมาส) ───────────────────────────── */
const TALLY = { done:0, over:0, due:0, future:0, skip:0 };
ITEMS.forEach((it, i) => weeksOfItem(it).forEach(w => TALLY[status(i, w)]++));

const yrow = (it, i) => {
  const ws = weeksOfItem(it);
  const done = ws.filter(w => w <= CUR && status(i, w) === 'done').length;
  const plan = ws.filter(w => w <= CUR && status(i, w) !== 'skip').length;
  const pct = Math.round(done / plan * 100);
  const c = pct >= 95 ? 'var(--ok)' : pct >= 80 ? 'var(--warn)' : 'var(--danger)';
  return `<article class="yr">
    <div class="top"><h3>${it.name}</h3><span class="fq">${it.freq}</span>
      <span class="cnt" style="color:${c}">${done}/${plan}</span></div>
    <div class="wks">${QW.map(w => `<div class="wn${w === CUR ? ' cur' : ''}">${w}</div>`).join('')}</div>
    <div class="wks">${QW.map(w => ws.includes(w)
      ? `<button class="wc${w === CUR ? ' cur' : ''}" aria-label="W${w}"><i style="${DOT[status(i, w)]}"></i></button>`
      : `<span class="wc off"></span>`).join('')}</div>
    <div class="mbar"><span style="width:${pct}%;background:${c}"></span></div>
  </article>`;
};

writeFileSync('MobileYear.dc.html', page(`<div class="mw">
  <div class="mhead">
    <div><h1>ตารางทั้งปี</h1><div class="sub">แผน PM · ปี 2026</div></div>
    <div class="sp" style="flex:1"></div>
    <button class="nav">⋯</button>
  </div>

  <div class="qbar">
    ${[1,2,3,4].map(q => `<button class="qb${q === Q ? ' on' : ''}">Q${q}</button>`).join('')}
  </div>
  <div class="qcap">
    <span>W${QW[0]} – W${QW[12]} · <b>${MO[monthOf(QW[0])]} – ${MO[monthOf(QW[12])]}</b></span>
    <span style="color:var(--brand-deep)">· W${CUR} = สัปดาห์นี้</span>
  </div>

  ${ITEMS.map(yrow).join('\n')}

  <div class="mleg">
    <span><i style="${DOT.done}"></i>ทำแล้ว</span>
    <span><i style="${DOT.over}"></i>เลยกำหนด</span>
    <span><i style="${DOT.due}"></i>ครบกำหนด</span>
    <span><i style="${DOT.future}"></i>ยังไม่ถึง</span>
  </div>
</div>

<div class="tabbar">
  <button class="tb"><span class="i">🗓️</span>สัปดาห์นี้</button>
  <button class="tb on"><span class="i">📊</span>ทั้งปี</button>
  <button class="tb"><span class="i">🔩</span>เครื่อง</button>
  <button class="tb"><span class="i">📈</span>สรุปผล</button>
</div>`, MCSS));

/* ── จอ 2: สรุปผล ─────────────────────────────────────────── */
const stat = ITEMS.map((it, i) => {
  let planYear = 0, done = 0, over = 0;
  weeksOfItem(it).forEach(w => {
    const s = status(i, w); if (s === 'skip') return;
    planYear++; if (s === 'done') done++; if (s === 'over') over++;
  });
  return { name: it.name, planYear, done, over, due: done + over, pct: Math.round(done / (done + over) * 100) };
});
const T = stat.reduce((a, s) => ({ planYear: a.planYear + s.planYear, done: a.done + s.done, over: a.over + s.over }),
  { planYear: 0, done: 0, over: 0 });
const dueToDate = T.done + T.over;
const pctToDate = Math.round(T.done / dueToDate * 100);

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

// กราฟย่อสำหรับจอแคบ — ป้ายเดือนเว้นเดือนเว้น ไม่งั้นตัวหนังสือทับกัน
const W = 340, H = 150, L = 26, R = 10, T_ = 12, B = 22;
const x = (i) => L + i * (W - L - R) / 11;
const y = (v) => T_ + (100 - v) * (H - T_ - B) / 100;
const pts = (a) => a.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
const msvg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
  aria-label="กราฟ S-Curve แผน PM สะสมเทียบผลจริง คิดจากรอบทั้งปี ${T.planYear} รอบ ถึง ${MO[CUR_M]} แผน ${PLAN[CUR_M]}% ทำจริง ${ACT[CUR_M]}%">
  ${[0, 50, 100].map(v => `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="#eee3d9"/>
    <text x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end" font-size="8" fill="#a49a90">${v}</text>`).join('')}
  ${MO.map((m, i) => i % 2 === 0 || i === CUR_M
    ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="8" fill="${i === CUR_M ? '#c24f00' : '#a49a90'}"
        font-weight="${i === CUR_M ? 700 : 400}">${m}</text>` : '').join('')}
  <polygon fill="rgba(255,107,0,.15)" points="${PLAN.slice(0, CUR_M + 1).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} ${
    ACT.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' ')}"/>
  <line x1="${x(CUR_M)}" y1="${T_}" x2="${x(CUR_M)}" y2="${H - B}" stroke="#c24f00" stroke-dasharray="3 4" opacity=".5"/>
  <polyline points="${pts(PLAN)}" fill="none" stroke="#c24f00" stroke-width="1.8" stroke-dasharray="6 4"/>
  <polyline points="${pts(ACT)}" fill="none" stroke="#1565c0" stroke-width="1.8"/>
  <circle cx="${x(CUR_M)}" cy="${y(PLAN[CUR_M])}" r="3.5" fill="#fff" stroke="#c24f00" stroke-width="2"/>
  <circle cx="${x(CUR_M)}" cy="${y(ACT[CUR_M])}" r="3.5" fill="#fff" stroke="#1565c0" stroke-width="2"/>
</svg>`;

const sitem = (s) => {
  const c = s.pct >= 95 ? 'var(--ok)' : s.pct >= 80 ? 'var(--warn)' : 'var(--danger)';
  return `<article class="si${s.pct < 80 ? ' bad' : ''}">
    <div class="top"><h3>${s.name}</h3><span class="p" style="color:${c}">${s.pct}%</span></div>
    <div class="mbar"><span style="width:${s.pct}%;background:${c}"></span></div>
    <div class="d">${s.done} จาก ${s.due} รอบที่ถึงกำหนด${s.over ? ` · ค้าง ${s.over}` : ''}</div>
  </article>`;
};

writeFileSync('MobileSummary.dc.html', page(`<div class="mw">
  <div class="mhead">
    <div><h1>สรุปผล PM</h1><div class="sub">ปี 2026 · ถึงสัปดาห์ที่ ${CUR}</div></div>
    <div class="sp" style="flex:1"></div>
    <button class="nav">⋯</button>
  </div>

  <div class="m2">
    <div class="mc"><div class="l">✅ ทำเสร็จแล้ว</div>
      <div class="v" style="color:var(--ok)">${pctToDate}<span style="font-size:13px">%</span></div>
      <div class="d">${T.done} จาก ${dueToDate} รอบที่ถึงกำหนด</div></div>
    <div class="mc hot"><div class="l">⚠️ เลยกำหนด ยังไม่ทำ</div>
      <div class="v">${T.over}</div>
      <div class="d">จากแผนทั้งปี ${T.planYear} รอบ</div></div>
  </div>

  <div class="chartcard">
    <h3>แผนสะสม เทียบผลจริง</h3>
    <div class="s">คิดจากรอบทั้งปี ${T.planYear} รอบ — คนละตัวหารกับ ${pctToDate}% ข้างบน<br>
      ถึงสิ้น ${MO[CUR_M]}: แผน <b style="color:var(--brand-deep)">${PLAN[CUR_M]}%</b> ·
      ทำจริง <b style="color:var(--cip1)">${ACT[CUR_M]}%</b> · ตามหลัง <b>${GAP} จุด</b></div>
    ${msvg}
  </div>

  <div class="sec">เรียงตัวที่ตกแผนมากสุดขึ้นก่อน</div>
  ${[...stat].sort((a, b) => a.pct - b.pct || b.over - a.over).map(sitem).join('\n')}
</div>

<div class="tabbar">
  <button class="tb"><span class="i">🗓️</span>สัปดาห์นี้</button>
  <button class="tb"><span class="i">📊</span>ทั้งปี</button>
  <button class="tb"><span class="i">🔩</span>เครื่อง</button>
  <button class="tb on"><span class="i">📈</span>สรุปผล</button>
</div>`, MCSS));

console.log('mobile2: Q' + Q, 'W' + QW[0] + '-W' + QW[12], '·', ITEMS.length, 'แถว ·',
  T.done + '/' + dueToDate, '=', pctToDate + '%', '· ห่าง', GAP);
