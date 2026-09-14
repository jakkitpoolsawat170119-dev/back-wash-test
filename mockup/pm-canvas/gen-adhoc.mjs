import { writeFileSync } from 'node:fs';
import { page, head } from './shared.mjs';

const opts = [
  ['เปลี่ยนถ่ายน้ำมันเกียร์มอเตอร์', 'ใช้ล่าสุด 2 ก.ย. · ใช้ไปแล้ว 14 ครั้ง'],
  ['ล้างไส้กรอง Pre-filter', 'ใช้ล่าสุด 30 ก.ค. · 9 ครั้ง'],
  ['อัดจาระบีแกนหมุน', 'ใช้ล่าสุด 1 ก.ย. · 12 ครั้ง'],
  ['ตรวจระดับน้ำยาและทำความสะอาดคอยล์', 'ใช้ล่าสุด 9 ก.ย. · 8 ครั้ง'],
  ['เปลี่ยนสายพานลำเลียง', 'ใช้ล่าสุด 18 ส.ค. · 5 ครั้ง'],
  ['เช็คแรงดันน้ำยา', 'ใช้ล่าสุด 8 ก.ย. · 7 ครั้ง'],
];
const list = opts.map(([t, s], i) => `<div class="opt${i === 4 ? ' hi' : ''}">
  <div><div class="ot">${t}</div><div class="os">${s}</div></div>
  ${i === 4 ? '<span class="chip due">↵ Enter</span>' : ''}
</div>`).join('');

const rowT = (st, t, m, who, date, chips, note) => `<article class="tk ${st}">
  <div class="r1"><h3${st === 'done' ? ' style="text-decoration:line-through;text-decoration-color:var(--sep)"' : ''}>${t}</h3>${chips}</div>
  <div class="meta"><span>🔩 ${m}</span><span class="dot">·</span><span>👤 ${who}</span><span class="dot">·</span><span>📅 ${date}</span>${note ? `<span class="dot">·</span><span>${note}</span>` : ''}</div>
  <div class="acts">
    ${st === 'done'
      ? '<button class="ibtn sm">↩ เปิดงานใหม่</button><button class="ibtn sm">🖼 ดูรูป</button>'
      : '<button class="ibtn sm ok">✅ ทำเสร็จแล้ว</button><button class="ibtn sm">📅 เลื่อนวัน</button><button class="ibtn sm">✏️ แก้</button><button class="ibtn sm dgr">🗑</button>'}
  </div>
</article>`;

writeFileSync('AdhocForm.dc.html', page(`<div class="wrap">
${head('adhoc', null)}

<div style="display:grid;grid-template-columns:1fr 330px;gap:14px;align-items:start;margin-top:14px">

  <div class="card" style="padding:16px 18px">
    <h3 class="hd">➕ ตั้งงาน PM (นอกแผนประจำปี)</h3>
    <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
      <div class="fld"><label>เครื่อง / ไลน์</label><select><option>ไลน์ L4</option></select></div>
      <div class="fld"><label>วันครบกำหนด <span class="req">*</span></label><input value="2026-09-11"></div>
      <div class="fld"><label>เวลา (ถ้ามี)</label><input value="09:00"></div>
    </div>

    <div class="fld">
      <label>รายการงาน PM <span class="req">*</span>
        <span class="tagnew">เลือกจากลิสต์ได้ · พิมพ์ชื่อใหม่ได้</span></label>
      <div class="combo open">
        <div class="cin"><span class="typed">เปลี่ยนสายพานลำเลียง</span><span class="caret">|</span></div>
        <button class="cbtn">▴</button>
        <div class="menu">
          <div class="mhead">รายการที่เคยใช้ <span>6</span></div>
          ${list}
          <div class="opt new">
            <div><div class="ot">＋ ใช้ชื่อใหม่ “<b>เปลี่ยนสายพานลำเลียงเส้นที่ 2</b>”</div>
            <div class="os">บันทึกเข้าทะเบียนรายการงาน PM ให้เลือกครั้งหน้าอัตโนมัติ</div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-top:392px">
      <div class="fld"><label>ประเภทงาน</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="ipill">🔧 บำรุงรักษา</button>
          <button class="ipill">⬆️ ปรับปรุง</button>
          <button class="ipill on brand">🛠 แก้ไข</button>
        </div>
      </div>
      <div class="fld"><label>ผู้รับผิดชอบ</label><select><option>พัฒพริศ อ่ำอยู่</option></select></div>
      <div class="fld"><label>แจ้งเตือนเข้ากลุ่มช่าง</label><select><option>ล่วงหน้า 1 วัน (08:00)</option></select></div>
    </div>

    <div class="fld"><label>หมายเหตุ (ถ้ามี)</label><input value="สายพานเส้นที่ 2 เริ่มมีเสียงดัง — ของอะไหล่มาถึงแล้ว"></div>

    <div class="fld"><label>ทำซ้ำหลังปิดงาน</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <button class="ipill on brand">ไม่ทำซ้ำ</button>
        <button class="ipill">ทุก 1 เดือน</button>
        <button class="ipill">ทุก 3 เดือน</button>
        <button class="ipill">ทุก 6 เดือน</button>
        <span class="hintline" style="margin-left:4px">ตั้งไว้แล้ว ตอนปิดงานระบบจะ<b>เสนอวันถัดไปให้ แต่เลือกวันเองได้เสมอ</b></span>
      </div>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
      <button class="ibtn">ยกเลิก</button>
      <button class="ibtn pri">💾 บันทึกงาน PM</button>
    </div>
  </div>

  <div class="card" style="padding:15px 16px">
    <h3 class="hd">⚙️ ทะเบียนรายการงาน PM</h3>
    <div class="infobox" style="margin-bottom:11px">
      ทุกชื่อที่พิมพ์ใหม่จะเข้ามาอยู่ตรงนี้ — แก้/รวมชื่อที่สะกดต่างกันได้ เพื่อไม่ให้กลายเป็นคนละงานตอนทำรายงาน
    </div>
    <div class="reg">
      ${[['เปลี่ยนถ่ายน้ำมันเกียร์มอเตอร์', 14], ['ล้างไส้กรอง Pre-filter', 9], ['อัดจาระบีแกนหมุน', 12],
         ['ตรวจระดับน้ำยาและทำความสะอาดคอยล์', 8], ['เปลี่ยนสายพานลำเลียง', 5], ['เช็คแรงดันน้ำยา', 7]]
        .map(([t, n]) => `<div class="rg"><div><div class="ot">${t}</div><div class="os">ใช้ไปแล้ว ${n} ครั้ง</div></div>
          <div style="display:flex;gap:5px"><button class="ibtn sm">✏️</button><button class="ibtn sm dgr">🗑</button></div></div>`).join('')}
      <div class="rg dup">
        <div><div class="ot">เช็คแรงดันน้ำยาน้ำ <span class="chip warn">คล้ายกับข้อบน</span></div>
        <div class="os">ใช้ไปแล้ว 1 ครั้ง — รวมเข้ากับ “เช็คแรงดันน้ำยา” ไหม</div></div>
        <button class="ibtn sm">🔗 รวม</button>
      </div>
    </div>
  </div>
</div>

<div class="ifilters" style="margin-top:16px">
  <h3 style="font-size:15px;margin-right:6px">งาน PM ที่ตั้งไว้เอง</h3>
  <select class="isel"><option>1 – 30 ก.ย. 2026</option></select>
  <select class="isel"><option>🔩 ทุกเครื่อง</option></select>
  <button class="ipill on">ทั้งหมด <span style="opacity:.7">4</span></button>
  <button class="ipill">ยังไม่เสร็จ</button>
  <button class="ipill">เลยกำหนด</button>
  <button class="ipill">เสร็จแล้ว</button>
  <div class="sp"></div>
  <button class="ibtn">📊 Export Excel</button>
</div>

<div class="ilist">
  ${rowT('late', 'ไลน์ A2 — เปลี่ยนชุดหัวจ่ายลม', 'ไลน์ A2', 'ณรินศ์', '4 ก.ย. 2026', '<span class="chip kind-fix">🛠 แก้ไข</span><span class="src adhoc">งานเพิ่มเอง</span><span class="chip stop">เกินกำหนด 5 วัน</span>', '')}
  ${rowT('due', 'ไลน์ L4 — เปลี่ยนสายพานลำเลียงเส้นที่ 2', 'ไลน์ L4', 'พัฒพริศ', '11 ก.ย. 2026 · 09:00', '<span class="chip kind-fix">🛠 แก้ไข</span><span class="src adhoc">งานเพิ่มเอง</span><span class="chip mute">🔔 เตือนล่วงหน้า 1 วัน</span>', '')}
  ${rowT('', 'ห้องเปลี่ยนชุด — ติดตั้งชั้นวางเพิ่ม', 'ห้องเปลี่ยนชุด', 'จักรกฤษ', '24 ก.ย. 2026', '<span class="chip kind-up">⬆️ ปรับปรุง</span><span class="src adhoc">งานเพิ่มเอง</span><span class="chip freq">ทำซ้ำทุก 6 เดือน</span>', '')}
  ${rowT('done', 'Air Shower — เปลี่ยนหลอด UV', 'Air Shower', 'ณรินศ์', '1 ก.ย. 2026', '<span class="chip kind-pm">🔧 บำรุงรักษา</span><span class="src adhoc">งานเพิ่มเอง</span>', '<span style="color:var(--ok);font-weight:600">✅ เสร็จ 1 ก.ย. โดย ณรินศ์ · รอบถัดไป 1 มี.ค. 2027</span>')}
</div>
</div>`, `
.tagnew{font-size:10.5px;font-weight:700;color:var(--brand-deep);background:var(--brand-soft);
  border-radius:999px;padding:1px 8px;margin-left:6px;font-family:var(--font-body)}
.combo{position:relative}
.cin{border:1px solid var(--brand);background:var(--card);border-radius:10px;padding:8px 40px 8px 11px;
  font-size:13px;box-shadow:0 0 0 3px rgba(255,107,0,.14)}
.typed{color:var(--ink)}
.caret{color:var(--brand);font-weight:300}
.cbtn{position:absolute;right:5px;top:5px;width:28px;height:28px;border-radius:8px;border:1px solid var(--line);
  background:var(--surface-2);color:var(--ink-soft);font-size:12px;cursor:pointer}
.menu{position:absolute;left:0;right:0;top:44px;background:var(--card);border:1px solid var(--line);
  border-radius:13px;box-shadow:var(--shadow-float);padding:6px;z-index:5}
.mhead{font-size:10.5px;font-weight:700;color:var(--muted);padding:5px 9px 6px;display:flex;justify-content:space-between}
.opt{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 9px;border-radius:9px;cursor:pointer}
.opt.hi{background:var(--brand-soft)}
.opt.new{background:var(--surface-2);border:1px dashed var(--sep);margin-top:5px}
.ot{font-size:12.8px;font-weight:600;line-height:1.4}
.os{font-size:11px;color:var(--muted);line-height:1.4}
.hintline{font-size:11.3px;color:var(--muted)}
.reg{display:flex;flex-direction:column}
.rg{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 2px;border-bottom:1px solid var(--row-line)}
.rg:last-child{border-bottom:none}
.rg.dup{background:var(--warn-soft-bg);border-radius:10px;padding:9px 10px;margin-top:6px;border-bottom:none}
`));
