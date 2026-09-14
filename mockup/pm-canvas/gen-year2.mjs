import { writeFileSync } from 'node:fs';
import { page, head } from './shared.mjs';
import { ITEMS, status, weeksOfItem, jobWeeks, jobFreqLabel, CUR_WEEK as CUR, mondayOf } from './gen-views.mjs';

/* ══════════ v2: ตารางแผน PM ทั้งปี ══════════
   แก้ 4 เรื่องจากของเดิม: คอลัมน์ชื่อติดหนึบ · แถบเดือน · เลือกช่วงเวลาได้ · แถวพับ/กางเห็นงานย่อย */

const TH_MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const DOT = {
  future:'background:transparent;border:1.5px solid var(--sep)',
  due:'background:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)',
  over:'background:var(--danger)',
  done:'background:var(--ok)',
  skip:'background:transparent;border:1.5px dashed var(--muted)',
};
const LBL = { done:'ทำแล้ว', over:'เลยกำหนด ยังไม่ทำ', due:'ครบกำหนดสัปดาห์นี้', future:'ยังไม่ถึงกำหนด', skip:'ปิดใช้งาน' };

// ช่วงเวลา — render ครบ 52 สัปดาห์เสมอ แล้วซ่อน/แสดงด้วย class (กดสลับได้จริงในหน้า)
const QUARTER = Math.ceil(CUR / 13);                       // W37 → Q3
const inHalf = (w) => w >= 27;
const inQtr  = (w) => w > (QUARTER - 1) * 13 && w <= QUARTER * 13;
const colCls = (w) => `g${inHalf(w) ? ' h' : ''}${inQtr(w) ? ' q' : ''}`;

// นับสถานะทั้งแผนไว้ทำ legend — นับที่ระดับ "เครื่อง × สัปดาห์" เท่านั้น งานย่อยไม่ใช่หน่วยนับ
const TALLY = { done:0, over:0, due:0, future:0, skip:0 };
ITEMS.forEach((it, i) => weeksOfItem(it).forEach(w => TALLY[status(i, w)]++));

/* ── หัวตาราง ─────────────────────────────────────────────── */
// สร้างแถบเดือนแยกตามช่วง เพราะ colspan ของแต่ละช่วงไม่เท่ากัน
const monthOf = (w) => { const d = mondayOf(w); d.setUTCDate(d.getUTCDate() + 3); return d.getUTCMonth(); };
const monthRow = (weeks, cls) => {
  const g = [];
  weeks.forEach(w => {
    const m = monthOf(w);
    if (g.length && g[g.length - 1].m === m) g[g.length - 1].n++;
    else g.push({ m, n: 1 });
  });
  return `<tr class="mrow ${cls}">
    <th class="nm mt"></th><th class="fq"></th><th class="pc"></th>
    ${g.map(x => `<th class="mh${x.m % 2 ? ' alt' : ''}${x.m === monthOf(CUR) ? ' cur' : ''}" colspan="${x.n}">${TH_MON[x.m]}</th>`).join('')}
  </tr>`;
};
const ALL = Array.from({ length: 52 }, (_, k) => k + 1);
const heads = ALL.map(w => `<th class="wkh ${colCls(w)}${w === CUR ? ' cur' : ''}">${w}</th>`).join('');

/* ── แถว ──────────────────────────────────────────────────── */
const cell = (i, w, on, st, small) => {
  if (!on) return `<td class="wk ${colCls(w)}${w === CUR ? ' cur' : ''}"></td>`;
  return `<td class="wk ${colCls(w)}${w === CUR ? ' cur' : ''}">
    <button class="d${small ? ' sm' : ''}" title="W${w} · ${LBL[st]}"><i style="${DOT[st]}"></i></button></td>`;
};

const rows = ITEMS.map((it, i) => {
  const ws = weeksOfItem(it);
  const done = ws.filter(w => w <= CUR && status(i, w) === 'done').length;
  const plan = ws.filter(w => w <= CUR && status(i, w) !== 'skip').length;
  const over = ws.filter(w => w <= CUR && status(i, w) === 'over').length;
  const pct = Math.round(done / plan * 100);
  const c = pct >= 95 ? 'var(--ok)' : pct >= 80 ? 'var(--warn)' : 'var(--danger)';
  const open = i === 1;                                    // กาง "ไลน์ต้ม 1" ไว้ให้เห็นตัวอย่าง

  const alt = i % 2 ? ' alt' : '';
  const machine = `<tr class="mach${alt}${open ? ' open' : ''}" data-i="${i}" data-over="${over}">
    <th class="nm"><button class="tw" aria-expanded="${open}">▸</button><span title="${it.name}">${it.name}</span>
      <span class="jn">${it.jobs.length}</span></th>
    <th class="fq">${it.freq}</th>
    <th class="pc"><div class="pcv" style="color:${c}">${done}<span>/${plan}</span></div>
      <div class="bar"><span style="width:${pct}%;background:${c}"></span></div></th>
    ${ALL.map(w => cell(i, w, ws.includes(w), status(i, w), false)).join('')}
  </tr>`;

  const jobs = it.jobs.map((j, k) => {
    const jw = jobWeeks(it, k);
    return `<tr class="jr p${i}${alt}${open ? ' on' : ''}">
      <th class="nm sub"><span class="tick">└</span><span title="${j.t}">${j.t}</span></th>
      <th class="fq sub">${jobFreqLabel(it, k)}</th>
      <th class="pc sub">${jw.length}<span> ครั้ง</span></th>
      ${ALL.map(w => cell(i, w, jw.includes(w), status(i, w), true)).join('')}
    </tr>`;
  }).join('\n');

  return machine + '\n' + jobs;
}).join('\n');

writeFileSync('YearGrid2.dc.html', page(`<div class="wrap">
${head('plan', 'year')}
<div id="yg2"><div class="card" style="padding:14px 16px">
  <div class="ybar">
    <h3 style="font-size:15px">ตารางแผน PM ทั้งปี</h3>
    <select class="isel"><option>ปี 2026 (ISO Week)</option></select>
    <div class="rngs">
      <button class="rng" data-r="year">ทั้งปี</button>
      <button class="rng on" data-r="half">ครึ่งปีหลัง</button>
      <button class="rng" data-r="qtr">ไตรมาสนี้ (Q${QUARTER})</button>
    </div>
    <button class="ibtn sortb">↕ เรียงงานค้างขึ้นก่อน</button>
    <div class="sp"></div>
    <button class="ibtn">⛔ เปิด/ปิดรายการ</button>
    <button class="ibtn">📊 Export Excel</button>
  </div>

  <div class="mx rng-half" id="mx">
    <table class="grid">
      <thead>
        ${monthRow(ALL, 'r-year')}
        ${monthRow(ALL.filter(inHalf), 'r-half')}
        ${monthRow(ALL.filter(inQtr), 'r-qtr')}
        <tr class="wrow"><th class="nm">รายการ PM</th><th class="fq">ความถี่</th><th class="pc">ทำแล้ว</th>${heads}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="legend">
    <span><i style="${DOT.done}"></i>ทำแล้ว ${TALLY.done}</span>
    <span><i style="${DOT.over}"></i>เลยกำหนด ยังไม่ทำ ${TALLY.over}</span>
    <span><i style="${DOT.due}"></i>ครบกำหนดสัปดาห์นี้ ${TALLY.due}</span>
    <span><i style="${DOT.future}"></i>ยังไม่ถึงกำหนด ${TALLY.future}</span>
    <span><i style="${DOT.skip}"></i>ปิดใช้งาน ${TALLY.skip} (ไม่นับในแผน)</span>
    <span class="dot" style="color:var(--muted)">·</span>
    <span>คลิกที่จุดเพื่อบันทึกว่าทำแล้ว · กด ▸ เพื่อกางดูงานย่อยของเครื่องนั้น</span>
  </div>
</div>

<script>
(function () {
  const root = document.getElementById('yg2');
  const mx = root.querySelector('#mx');
  root.querySelectorAll('.rng').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('.rng').forEach(x => x.classList.toggle('on', x === b));
    mx.className = 'mx rng-' + b.dataset.r;
  }));
  root.querySelectorAll('.tw').forEach(b => b.addEventListener('click', () => {
    const tr = b.closest('tr'), open = !tr.classList.contains('open');
    tr.classList.toggle('open', open); b.setAttribute('aria-expanded', open);
    root.querySelectorAll('.jr.p' + tr.dataset.i).forEach(j => j.classList.toggle('on', open));
  }));
  // เรียงตามงานค้าง — ต้องยกแถวงานย่อยตามแถวแม่ไปด้วย
  root.querySelector('.sortb').addEventListener('click', function () {
    const tb = root.querySelector('tbody'), on = this.classList.toggle('pri');
    const groups = [];
    tb.querySelectorAll('tr.mach').forEach(m => {
      const g = [m]; let n = m.nextElementSibling;
      while (n && n.classList.contains('jr')) { g.push(n); n = n.nextElementSibling; }
      groups.push(g);
    });
    groups.sort((a, b) => on ? b[0].dataset.over - a[0].dataset.over : a[0].dataset.i - b[0].dataset.i);
    groups.forEach(g => g.forEach(r => tb.appendChild(r)));
  });
})();
</script>
</div></div>`, `
.ybar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.rngs{display:inline-flex;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:3px;gap:3px}
.rng{border:none;background:transparent;color:var(--ink-soft);font-family:var(--font-head);font-size:12.5px;
  font-weight:600;padding:5px 14px;border-radius:999px;cursor:pointer;
  transition:transform .18s cubic-bezier(.34,1.56,.64,1),opacity .18s}
.rng:hover{color:var(--ink)}
.rng:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(255,107,0,.28)}
.rng.on{background:var(--card);color:var(--brand-deep);box-shadow:var(--shadow-card)}
.sortb{white-space:nowrap}

.mx{overflow:auto;border:1px solid var(--line);border-radius:12px;max-height:640px;width:max-content;max-width:100%}
table.grid{border-collapse:separate;border-spacing:0;font-size:11.5px;font-family:var(--font-body)}
table.grid th{font-weight:600;color:var(--ink-soft);padding:0;background:var(--surface-2)}

/* หัวตาราง — แถบเดือน + เลขสัปดาห์ ติดบนตอนเลื่อนแนวตั้ง */
table.grid thead th{position:sticky;z-index:3;border-bottom:1px solid var(--line)}
table.grid .mrow th{top:0;height:24px}
table.grid .wrow th{top:24px}
th.mh{font-family:var(--font-head);font-size:10.5px;color:var(--ink-soft);text-align:center;
  border-left:1px solid var(--sep);background:var(--surface-2)}
th.mh.alt{background:#f4ece4}
th.mh.cur{color:var(--brand-deep);background:var(--brand-soft)}

/* คอลัมน์ชื่อติดหนึบ — เลื่อนไปท้ายปีแล้วยังรู้ว่าแถวไหน */
table.grid th.nm{position:sticky;left:0;z-index:2;width:196px;min-width:196px;text-align:left;
  padding:6px 11px;font-family:var(--font-head);font-size:12.3px;color:var(--ink);background:var(--card);
  display:flex;align-items:center;gap:6px}
table.grid thead th.nm,table.grid thead th.fq,table.grid thead th.pc{z-index:4}
table.grid th.nm.mt,table.grid th.fq.mt,table.grid th.pc.mt{background:var(--surface-2)}
th.nm > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw{flex:none;width:19px;height:19px;border-radius:6px;border:1px solid var(--line);background:var(--surface-3);
  color:var(--ink-soft);font-size:9px;cursor:pointer;line-height:1;
  transition:transform .2s cubic-bezier(.34,1.56,.64,1)}
.tw:hover{border-color:var(--brand);color:var(--brand-deep)}
.tw:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(255,107,0,.28)}
.mach.open .tw{transform:rotate(90deg)}
.jn{flex:none;font-family:var(--font-body);font-size:10px;font-weight:700;color:var(--ink-soft);
  background:var(--surface-2);border-radius:999px;padding:0 6px}
table.grid th.fq{position:sticky;left:196px;z-index:2;width:92px;min-width:92px;text-align:left;
  padding:6px 9px;background:var(--card);color:var(--ink-soft);font-size:11.3px}
table.grid th.pc{position:sticky;left:288px;z-index:2;width:68px;min-width:68px;text-align:right;
  padding:5px 11px;background:var(--card);border-right:1px solid var(--line);
  box-shadow:1px 0 0 var(--line);font-variant-numeric:tabular-nums;font-size:11.5px}
.pcv{font-weight:700;line-height:1.3}
.pcv span{color:var(--muted);font-weight:500}
th.pc .bar{height:4px;border-radius:999px;background:var(--surface-2);overflow:hidden;margin-top:2px}
th.pc .bar span{display:block;height:100%;border-radius:999px}
table.grid th.wkh{font-size:9.5px;color:var(--muted);text-align:center;padding:5px 0;font-weight:500;
  border-left:1px solid #f6f1ec}
table.grid th.wkh.cur{color:var(--brand-deep);font-weight:700;background:var(--brand-soft)}

/* แถวเครื่อง / แถวงานย่อย */
tbody tr.alt th.nm,tbody tr.alt th.fq,tbody tr.alt th.pc{background:var(--surface-3)}
tbody tr.alt td.wk{background:rgba(251,247,243,.6)}
tbody tr:hover th.nm,tbody tr:hover th.fq,tbody tr:hover th.pc{background:var(--brand-soft)}
tbody tr:hover td.wk{background:#fdf4ec}
.jr{display:none}
.jr.on{display:table-row}
.jr th.nm{padding-left:26px;font-family:var(--font-body);font-size:11.8px;font-weight:500;color:var(--ink-soft)}
.jr th.fq,.jr th.pc{font-size:10.8px;color:var(--muted)}
.jr th.pc span{color:var(--muted)}
.tick{flex:none;color:var(--sep)}
.jr td.wk{background:rgba(251,247,243,.75)}

td.wk{height:32px;text-align:center;border-left:1px solid #f6f1ec;padding:0}
td.wk.cur{background:var(--brand-soft)}
.jr td.wk.cur{background:#ffeadb}
.d{width:100%;height:30px;border:none;background:transparent;padding:0;cursor:pointer;border-radius:6px;
  display:grid;place-items:center;transition:transform .18s cubic-bezier(.34,1.56,.64,1)}
.d i{width:11px;height:11px;border-radius:50%;display:block}
.d.sm i{width:7px;height:7px}
.d:hover{transform:scale(1.18)}
.d:focus-visible{outline:none;box-shadow:0 0 0 2px var(--card),0 0 0 4px var(--brand)}

/* ความกว้างช่องตามช่วงที่เลือก — ครึ่งปีหลังลงจอ 1440 ได้โดยไม่ต้องเลื่อน */
.rng-year .g{width:21px;min-width:21px}
.rng-half .g:not(.h),.rng-qtr .g:not(.q){display:none}
.rng-half .g{width:28px;min-width:28px}
.rng-qtr .g{width:50px;min-width:50px}
.rng-year .r-half,.rng-year .r-qtr,.rng-half .r-year,.rng-half .r-qtr,.rng-qtr .r-year,.rng-qtr .r-half{display:none}
`));
console.log('year2: legend', JSON.stringify(TALLY), '· Q' + QUARTER, '· รวมจุด',
  Object.values(TALLY).reduce((a, b) => a + b, 0));
