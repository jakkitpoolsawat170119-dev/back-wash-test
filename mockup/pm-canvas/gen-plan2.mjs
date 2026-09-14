import { writeFileSync } from 'node:fs';
import { page } from './shared.mjs';
import { ITEMS, weeksOfItem, jobWeeks, jobFreqLabel } from './gen-views.mjs';

/* ══════════ v2: จัดการแผน PM + แผ่นแก้ไข (ลิสต์งานย่อยต่อเครื่อง) ══════════ */

// ทะเบียนรายการงาน PM = ชื่องานย่อยทั้งหมดที่ถูกใช้ + จำนวนเครื่องที่ใช้ชื่อนี้
const REG = new Map();
ITEMS.forEach(it => it.jobs.forEach(j => REG.set(j.t, (REG.get(j.t) || 0) + 1)));
const REG_LIST = [...REG.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'th'));

/* ── 1. ตารางจัดการแผน — เพิ่มบรรทัด "งานย่อย N ข้อ" ───────── */
const strip = (start, step) => {
  let s = '';
  for (let w = 1; w <= 52; w++) s += `<i class="${w >= start && (w - start) % step === 0 ? 'on' : ''}"></i>`;
  return `<div class="strip">${s}</div>`;
};
const tag = (i) => i === 12 ? '<span class="chip mute">เพิ่มเอง</span>'
  : i === 3 ? '<span class="chip due">แก้รอบแล้ว</span>' : '';
const prow = (it, i) => `<tr>
  <td><div class="t">${it.name}</div>
      <div class="s">📋 งานย่อย ${it.jobs.length} ข้อ · 👤 ${['จักรกฤษ','ณรินศ์','พัฒพริศ'][i%3]}</div></td>
  <td><span class="chip freq">${it.freq}</span></td>
  <td class="num">${Math.floor((52 - it.start) / it.step) + 1}</td>
  <td>${strip(it.start, it.step)}</td>
  <td>${tag(i)}</td>
  <td style="text-align:right;white-space:nowrap">
    <button class="ibtn sm">✏️ แก้ไข</button><button class="ibtn sm dgr">🗑</button>
  </td>
</tr>`;

writeFileSync('PlanManage2.dc.html', page(`<div class="wrap">
<div class="eyebrow">🔧 งานซ่อมบำรุง · งาน PM</div>
<div class="phead">
  <h1>⚙️ จัดการแผน PM ประจำปี</h1>
  <div class="sub">กำหนดว่าแต่ละเครื่องต้องทำสัปดาห์ไหนบ้าง และครั้งหนึ่งต้องทำงานอะไรบ้าง</div>
  <div class="sp"></div>
  <span class="chip warn">🛠️ หัวหน้างานเท่านั้น</span>
</div>

<div class="okbox" style="margin:14px 0 12px">
  <b>แผนปี 2026 กรอกแล้ว ${ITEMS.length} เครื่อง · งานย่อยรวม ${ITEMS.reduce((a,x)=>a+x.jobs.length,0)} ข้อ</b> —
  เพิ่มได้เรื่อย ๆ ระบบจะเริ่มออกงานให้ตั้งแต่สัปดาห์ที่ติ๊กไว้ · คัดลอกทั้งแผนไปปีหน้าได้ในคลิกเดียว
</div>

<div class="ifilters" style="margin-top:0">
  <button class="ibtn pri">＋ เพิ่มเครื่องในแผน</button>
  <div class="divider"></div>
  <select class="isel"><option>ปี 2026</option></select>
  <select class="isel"><option>ทุกความถี่</option></select>
  <input class="isel srch" value="ค้นหาชื่อเครื่อง / ชื่องาน…">
  <div class="sp"></div>
  <button class="ibtn">📋 คัดลอกแผนไปปี 2027</button>
  <button class="ibtn">📊 Export Excel</button>
</div>

<div class="card" style="padding:4px 4px 8px">
  <table class="tb">
    <thead><tr>
      <th>เครื่อง / พื้นที่</th><th>ความถี่</th><th style="text-align:right">รอบ/ปี</th>
      <th style="width:280px">สัปดาห์ที่ต้องทำ (W1 → W52)</th><th>สถานะ</th><th></th>
    </tr></thead>
    <tbody>${ITEMS.map(prow).join('\n')}</tbody>
  </table>
</div>

<div class="infobox" style="margin-top:12px">
  ⚠️ <b>ตั้งชื่อให้ชี้เฉพาะเจาะจง</b> — เช่น “ไลน์ต้ม 1” ไม่ใช่ “Line 1” เปล่า ๆ เพราะชนกับชื่อไลน์ CIP ที่ใช้อยู่ในระบบเดิม
</div>
</div>`, `
.tb .t{font-family:var(--font-head);font-size:13.5px;font-weight:600}
.tb .s{font-size:11.2px;color:var(--muted)}
.strip{display:flex;gap:1px;align-items:center}
.strip i{width:4px;height:14px;border-radius:1px;background:var(--surface-2);border:1px solid #f0e8e0}
.strip i.on{background:var(--brand);border-color:var(--brand)}
.srch{min-width:220px}
table.tb .num{text-align:right}
`));

/* ── 2. แผ่นแก้ไข — ช่องลิสต์งานย่อยที่ user ขอ ─────────────── */
const IT = ITEMS[1];                       // ไลน์ต้ม 1 · ทุกเดือน
const rounds = weeksOfItem(IT).length;
const FREQ_OPTS = ['ทุกครั้ง', 'ทุก 3 เดือน', 'ทุก 6 เดือน', 'ปีละครั้ง'];

const jobRow = (j, k) => {
  const label = jobFreqLabel(IT, k);
  const times = jobWeeks(IT, k).length;
  return `<div class="jrow">
    <span class="grip" title="ลากเพื่อสลับลำดับ">⠿</span>
    <input class="jname" value="${j.t}">
    <select class="jfreq">${FREQ_OPTS.map(o => `<option${o === label ? ' selected' : ''}>${o}</option>`).join('')}</select>
    <span class="jtimes">ปีละ ${times} ครั้ง</span>
    <button class="jdel" title="ลบรายการนี้">🗑</button>
  </div>`;
};

const everyTime = IT.jobs.filter((_, k) => jobFreqLabel(IT, k) === 'ทุกครั้ง').length;
const rare = IT.jobs.map((j, k) => ({ j, k })).filter(x => jobFreqLabel(IT, x.k) !== 'ทุกครั้ง')
  .map(x => `“${x.j.t}” ปีละ ${jobWeeks(IT, x.k).length} ครั้ง`).join(' · ');

const TYPED = 'ตรวจชุดกรองน้ำมันไฮดรอลิก';
const optList = REG_LIST.slice(0, 6).map(([t, n], i) => `<div class="opt${i === 1 ? ' hi' : ''}">
    <div><div class="ot">${t}</div><div class="os">ใช้อยู่ ${n} เครื่อง</div></div>
    ${i === 1 ? '<span class="os">↵ Enter</span>' : ''}
  </div>`).join('');

const sel = new Set(weeksOfItem(IT));
let weeks = '';
for (let w = 1; w <= 52; w++)
  weeks += `<button class="wq${sel.has(w) ? ' on' : ''}${w === 37 ? ' cur' : ''}">${w}</button>`;

writeFileSync('PlanEdit2.dc.html', page(`<div style="padding:22px;background:rgba(20,14,8,.62);min-height:100%">
<div class="sheet">
  <h3>✏️ แก้ไขรายการในแผน PM</h3>
  <div class="hint">${IT.name} · แผนปี 2026</div>

  <div class="grid2">
    <div class="fld">
      <label>เครื่อง / พื้นที่ <span class="req">*</span></label>
      <select><option>${IT.name}</option></select>
      <div class="hintline">เลือกจากทะเบียนเครื่องจักร — ชื่อนี้จะเป็นชื่อแถวในตารางทั้งปี</div>
    </div>
    <div class="fld">
      <label>ความถี่ของเครื่อง (ป้ายกำกับ)</label>
      <div class="pills">
        ${['ทุกสัปดาห์','ทุก 2 สัปดาห์','ทุกเดือน','ทุก 3 เดือน','ทุก 6 เดือน','ทุกปี']
          .map(f => `<button class="ipill${f === IT.freq ? ' on brand' : ''}">${f}</button>`).join('')}
      </div>
    </div>
  </div>

  <div class="fld jbox">
    <label>รายการงานที่ต้องทำของเครื่องนี้ (${IT.jobs.length})
      <span class="tagnew">เลือกจากลิสต์ได้ · พิมพ์ชื่อใหม่ได้</span></label>
    <div class="jhead"><span>ชื่องาน</span><span>ทำบ่อยแค่ไหน</span></div>
    <div class="jlist">${IT.jobs.map(jobRow).join('\n')}</div>

    <div class="combo open">
      <div class="cin"><span class="ph">＋ เพิ่มรายการงาน — </span><span class="typed">${TYPED}</span><span class="caret">|</span></div>
      <button class="cbtn">▴</button>
      <div class="menu">
        <div class="mhead">ทะเบียนรายการงาน PM <span>${REG_LIST.length}</span></div>
        ${optList}
        <div class="opt new">
          <div><div class="ot">＋ ใช้ชื่อใหม่ “<b>${TYPED}</b>”</div>
          <div class="os">บันทึกเข้าทะเบียนรายการงาน PM ให้เลือกครั้งหน้าอัตโนมัติ</div></div>
        </div>
      </div>
    </div>
    <div class="cspacer"></div>

    <div class="infobox" style="margin-top:0">
      เครื่องนี้ทำ <b>${rounds} รอบ/ปี</b> — ไปครั้งหนึ่งช่างได้ <b>${everyTime} ข้อที่ทำทุกครั้ง</b> ·
      ส่วน ${rare}
      <div style="margin-top:3px;color:var(--muted)">ตั้งให้ถี่กว่ารอบของเครื่องไม่ได้ — ถ้าต้องทำถี่กว่านี้ ให้ปรับความถี่ของเครื่องแทน</div>
    </div>
  </div>

  <div class="fld" style="margin-top:4px">
    <label>สร้างรูปแบบสัปดาห์อัตโนมัติ</label>
    <div class="autorow">
      <div><span class="al">เริ่มสัปดาห์ที่</span><input value="${IT.start}"></div>
      <div><span class="al">ทำซ้ำทุก ๆ (สัปดาห์)</span><input value="${IT.step}"></div>
      <button class="ibtn">⚡ สร้างตาราง</button>
    </div>
  </div>

  <div class="fld">
    <label>สัปดาห์ที่ต้องทำ PM — คลิกเพื่อเลือก / ยกเลิก ปรับเองได้อิสระ</label>
    <div class="wgrid">${weeks}</div>
    <div class="wcount">เลือกแล้ว <b>${rounds}</b> สัปดาห์ · <span style="color:var(--brand-deep)">W37 = สัปดาห์ปัจจุบัน</span></div>
  </div>

  <div class="grid2">
    <div class="fld"><label>ผู้รับผิดชอบตั้งต้น</label><select><option>จักรกฤษ พูลสวัสดิ์</option></select></div>
    <div class="fld"><label>แจ้งเตือนเข้ากลุ่มช่าง</label><select><option>ล่วงหน้า 3 วันก่อนถึงสัปดาห์</option></select></div>
  </div>

  <div class="warnbox">
    การแก้สัปดาห์มีผลกับ <b>รอบที่ยังไม่ถึงกำหนด</b> เท่านั้น — ประวัติที่ทำไปแล้วและรอบที่เลยกำหนดยังอยู่ครบ
    ไม่ถูกล้างทิ้งและไม่ถูกนับใหม่
  </div>

  <div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="ibtn">ยกเลิก</button>
    <button class="ibtn pri">✔ บันทึก</button>
  </div>
</div>
</div>`, `
.hintline{font-size:11.3px;color:var(--muted);margin-top:4px}
.pills{display:flex;gap:6px;flex-wrap:wrap}
.pills .ipill{padding:5px 11px;font-size:12px}
.tagnew{font-size:10.5px;font-weight:700;color:var(--brand-deep);background:var(--brand-soft);
  border-radius:999px;padding:1px 8px;margin-left:6px;font-family:var(--font-body)}

/* ลิสต์งานย่อย */
.jbox{background:var(--surface-2);border:1px solid var(--line);border-radius:14px;padding:12px 13px 13px}
.jhead{display:grid;grid-template-columns:22px 1fr 148px 88px 34px;gap:8px;font-size:10.5px;font-weight:700;
  color:var(--muted);padding:0 2px 5px}
.jhead span:first-child{grid-column:2}
.jlist{display:flex;flex-direction:column;gap:6px}
.jrow{display:grid;grid-template-columns:22px 1fr 148px 88px 34px;gap:8px;align-items:center;
  background:var(--card);border:1px solid var(--line);border-radius:11px;padding:6px 8px;box-shadow:var(--shadow-card)}
.grip{color:var(--muted);font-size:14px;text-align:center;cursor:grab;line-height:1}
.jname{width:100%;border:1px solid transparent;background:transparent;border-radius:8px;padding:5px 8px;
  font-size:13px;font-family:inherit;color:var(--ink);font-weight:600}
.jname:hover{border-color:var(--line);background:var(--surface-3)}
.jname:focus-visible{outline:none;border-color:var(--brand);background:var(--card);box-shadow:0 0 0 3px rgba(255,107,0,.14)}
.jfreq{width:100%;border:1px solid var(--line);background:var(--surface-3);border-radius:9px;padding:5px 8px;
  font-size:12.3px;font-family:var(--font-head);font-weight:600;color:var(--ink-soft)}
.jtimes{font-size:11.3px;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.jdel{width:30px;height:30px;border-radius:9px;border:1px solid transparent;background:transparent;
  color:var(--muted);font-size:13px;cursor:pointer;transition:transform .18s cubic-bezier(.34,1.56,.64,1),opacity .18s}
.jdel:hover{background:var(--danger-soft-bg);border-color:var(--danger-soft-line);transform:scale(1.08)}
.jdel:active{transform:scale(.94)}
.jdel:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(198,40,40,.22)}

/* combo เพิ่มงาน — กางลิสต์จริง ไม่ใช่ปุ่มเปล่า */
.combo{position:relative;margin-top:9px}
.cin{border:1px solid var(--brand);background:var(--card);border-radius:10px;padding:8px 40px 8px 11px;
  font-size:13px;box-shadow:0 0 0 3px rgba(255,107,0,.14)}
.ph{color:var(--muted)}
.typed{color:var(--ink);font-weight:600}
.caret{color:var(--brand);font-weight:300}
.cbtn{position:absolute;right:5px;top:5px;width:28px;height:28px;border-radius:8px;border:1px solid var(--line);
  background:var(--surface-2);color:var(--ink-soft);font-size:12px;cursor:pointer}
.menu{position:absolute;left:0;right:0;top:44px;background:var(--card);border:1px solid var(--line);
  border-radius:13px;box-shadow:var(--shadow-float);padding:6px;z-index:5}
.mhead{font-size:10.5px;font-weight:700;color:var(--muted);padding:5px 9px 6px;display:flex;justify-content:space-between}
.opt{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 9px;border-radius:9px;cursor:pointer}
.opt:hover{background:var(--surface-2)}
.opt.hi{background:var(--brand-soft)}
.opt.new{background:var(--surface-2);border:1px dashed var(--sep);margin-top:5px}
.ot{font-size:12.8px;font-weight:600;line-height:1.4}
.os{font-size:11px;color:var(--muted);line-height:1.4;white-space:nowrap}
.cspacer{height:392px}

.autorow{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;background:var(--surface-2);
  border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.autorow > div{display:flex;flex-direction:column;gap:3px}
.al{font-size:11px;font-weight:700;color:var(--ink-soft)}
.autorow input{width:96px;border:1px solid var(--line);background:var(--card);border-radius:9px;
  padding:6px 10px;font-size:13px;font-family:inherit;font-variant-numeric:tabular-nums}
.wgrid{display:grid;grid-template-columns:repeat(13,1fr);gap:5px}
.wq{height:30px;border-radius:8px;border:1px solid var(--line);background:var(--surface-3);color:var(--ink-soft);
  font-size:11.5px;font-weight:600;font-family:var(--font-body);cursor:pointer;font-variant-numeric:tabular-nums;
  transition:transform .18s cubic-bezier(.34,1.56,.64,1)}
.wq:hover{transform:translateY(-1px);border-color:var(--brand)}
.wq:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(255,107,0,.28)}
.wq.on{background:var(--brand);border-color:var(--brand);color:#fff}
.wq.cur{box-shadow:0 0 0 2px var(--brand-soft),0 0 0 3px var(--brand-deep)}
.wcount{font-size:11.8px;color:var(--ink-soft);margin-top:7px}
`));
console.log('plan2: เครื่อง', ITEMS.length, '· งานย่อยรวม', ITEMS.reduce((a,x)=>a+x.jobs.length,0),
  '· ทะเบียน', REG_LIST.length, 'ชื่อ ·', IT.name, 'รอบ/ปี', rounds);
