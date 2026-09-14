import { writeFileSync } from 'node:fs';
import { page, head } from './shared.mjs';
import { ITEMS } from './gen-views.mjs';

/* ══════════ 5. จัดการแผน PM ประจำปี ══════════ */
const strip = (start, step) => {
  let s = '';
  for (let w = 1; w <= 52; w++) {
    const on = w >= start && (w - start) % step === 0;
    s += `<i class="${on ? 'on' : ''}"></i>`;
  }
  return `<div class="strip">${s}</div>`;
};
const tag = (i) => i === 12 ? '<span class="chip mute">เพิ่มเอง</span>'
  : i === 3 ? '<span class="chip due">แก้รอบแล้ว</span>' : '';
const prow = (it, i) => {
  const n = Math.floor((52 - it.start) / it.step) + 1;
  return `<tr>
  <td><div class="t">${it.name}</div><div class="s">🔩 ผูกกับทะเบียนเครื่องจักร · 👤 ${['จักรกฤษ','ณรินศ์','พัฒพริศ'][i%3]}</div></td>
  <td><span class="chip freq">${it.freq}</span></td>
  <td class="num">${n}</td>
  <td>${strip(it.start, it.step)}</td>
  <td>${tag(i)}</td>
  <td style="text-align:right;white-space:nowrap">
    <button class="ibtn sm">✏️ แก้ไข</button><button class="ibtn sm dgr">🗑</button>
  </td>
</tr>`;
};

writeFileSync('PlanManage.dc.html', page(`<div class="wrap">
<div class="eyebrow">🔧 งานซ่อมบำรุง · งาน PM</div>
<div class="phead">
  <h1>⚙️ จัดการแผน PM ประจำปี</h1>
  <div class="sub">กำหนดว่าแต่ละรายการต้องทำสัปดาห์ไหนบ้างตลอดปี</div>
  <div class="sp"></div>
  <span class="chip warn">🛠️ หัวหน้างานเท่านั้น</span>
</div>

<div class="okbox" style="margin:14px 0 12px">
  <b>แผนปี 2026 กรอกแล้ว 13 รายการ</b> — เพิ่มได้เรื่อย ๆ ระบบจะเริ่มออกงานให้ตั้งแต่สัปดาห์ที่ติ๊กไว้
  · คัดลอกทั้งแผนไปปีหน้าได้ในคลิกเดียว
</div>

<div class="ifilters" style="margin-top:0">
  <button class="ibtn pri">＋ เพิ่มรายการในแผน</button>
  <div class="divider"></div>
  <select class="isel"><option>ปี 2026</option></select>
  <select class="isel"><option>ทุกความถี่</option></select>
  <input class="isel srch" value="ค้นหาชื่อรายการ…">
  <div class="sp"></div>
  <button class="ibtn">📋 คัดลอกแผนไปปี 2027</button>
  <button class="ibtn">📊 Export Excel</button>
</div>

<div class="card" style="padding:4px 4px 8px">
  <table class="tb">
    <thead><tr>
      <th>รายการ PM</th><th>ความถี่</th><th style="text-align:right">รอบ/ปี</th>
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
.srch{min-width:200px}
`));

/* ══════════ 6. แผ่นแก้ไขรายการ (ตัวเลือก 52 สัปดาห์) ══════════ */
const sel = new Set(); for (let w = 3; w <= 52; w += 4) sel.add(w);
let weeks = '';
for (let w = 1; w <= 52; w++) {
  const on = sel.has(w);
  weeks += `<button class="wq${on ? ' on' : ''}${w === 37 ? ' cur' : ''}">${w}</button>`;
}

writeFileSync('PlanEdit.dc.html', page(`<div style="padding:22px;background:rgba(20,14,8,.62);min-height:100%">
<div class="sheet">
  <h3>✏️ แก้ไขรายการในแผน PM</h3>
  <div class="hint">ไลน์ต้ม 1 · แผนปี 2026</div>

  <div class="fld">
    <label>ชื่อรายการ PM <span class="req">*</span></label>
    <div class="combo">
      <input value="ไลน์ต้ม 1">
      <button class="cbtn">▾</button>
    </div>
    <div class="hintline">เลือกจากรายการที่มีอยู่ หรือพิมพ์ชื่อใหม่ได้เลย — ระบบจำไว้ให้เลือกครั้งหน้า</div>
  </div>

  <div class="grid2">
    <div class="fld">
      <label>ความถี่ (ป้ายกำกับ)</label>
      <div class="pills">
        <button class="ipill">ทุกสัปดาห์</button>
        <button class="ipill">ทุก 2 สัปดาห์</button>
        <button class="ipill on brand">ทุกเดือน</button>
        <button class="ipill">ทุก 3 เดือน</button>
        <button class="ipill">ทุก 6 เดือน</button>
        <button class="ipill">ทุกปี</button>
      </div>
    </div>
    <div class="fld">
      <label>ผูกกับเครื่องในทะเบียน</label>
      <select><option>ไลน์ต้ม 1</option></select>
    </div>
  </div>

  <div class="grid2">
    <div class="fld"><label>ผู้รับผิดชอบตั้งต้น</label><select><option>จักรกฤษ พูลสวัสดิ์</option></select></div>
    <div class="fld"><label>แจ้งเตือนเข้ากลุ่มช่าง</label><select><option>ล่วงหน้า 3 วันก่อนถึงสัปดาห์</option></select></div>
  </div>

  <div class="fld" style="margin-top:4px">
    <label>สร้างรูปแบบสัปดาห์อัตโนมัติ</label>
    <div class="autorow">
      <div><span class="al">เริ่มสัปดาห์ที่</span><input value="3"></div>
      <div><span class="al">ทำซ้ำทุก ๆ (สัปดาห์)</span><input value="4"></div>
      <button class="ibtn">⚡ สร้างตาราง</button>
    </div>
  </div>

  <div class="fld">
    <label>สัปดาห์ที่ต้องทำ PM — คลิกเพื่อเลือก / ยกเลิก ปรับเองได้อิสระ</label>
    <div class="wgrid">${weeks}</div>
    <div class="wcount">เลือกแล้ว <b>13</b> สัปดาห์ · <span style="color:var(--brand-deep)">W37 = สัปดาห์ปัจจุบัน</span></div>
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
.combo{position:relative}
.combo input{width:100%;border:1px solid var(--line);background:var(--surface-3);border-radius:10px;
  padding:8px 40px 8px 11px;font-size:13px;font-family:inherit;color:var(--ink)}
.cbtn{position:absolute;right:5px;top:5px;width:28px;height:28px;border-radius:8px;border:1px solid var(--line);
  background:var(--card);color:var(--ink-soft);font-size:12px;cursor:pointer}
.hintline{font-size:11.3px;color:var(--muted);margin-top:4px}
.pills{display:flex;gap:6px;flex-wrap:wrap}
.pills .ipill{padding:5px 11px;font-size:12px}
.autorow{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;background:var(--surface-2);
  border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.autorow > div{display:flex;flex-direction:column;gap:3px}
.al{font-size:11px;font-weight:700;color:var(--ink-soft)}
.autorow input{width:96px;border:1px solid var(--line);background:var(--card);border-radius:9px;
  padding:6px 10px;font-size:13px;font-family:inherit;font-variant-numeric:tabular-nums}
.wgrid{display:grid;grid-template-columns:repeat(13,1fr);gap:5px}
.wq{height:30px;border-radius:8px;border:1px solid var(--line);background:var(--surface-3);color:var(--ink-soft);
  font-size:11.5px;font-weight:600;font-family:var(--font-body);cursor:pointer;font-variant-numeric:tabular-nums}
.wq.on{background:var(--brand);border-color:var(--brand);color:#fff}
.wq.cur{box-shadow:0 0 0 2px var(--brand-soft),0 0 0 3px var(--brand-deep)}
.wcount{font-size:11.8px;color:var(--ink-soft);margin-top:7px}
`));
