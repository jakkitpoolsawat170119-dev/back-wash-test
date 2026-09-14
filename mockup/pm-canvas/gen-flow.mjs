import { writeFileSync } from 'node:fs';
import { page, head } from './shared.mjs';

/* ══════════ 7. แผ่นปิดงาน PM ══════════ */
writeFileSync('DoneSheet.dc.html', page(`<div style="padding:22px;background:rgba(20,14,8,.62);min-height:100%">
<div class="sheet">
  <h3>✅ บันทึกว่าทำ PM เสร็จแล้ว</h3>
  <div class="hint">RO 10,000 · W37/2026 — ล้างเมมเบรนและตรวจค่าความนำไฟฟ้า</div>

  <div class="grid2">
    <div class="fld"><label>ผู้ทำ PM <span class="req">*</span></label><select><option>พัฒพริศ อ่ำอยู่</option></select></div>
    <div class="fld"><label>วันที่ทำจริง</label><input value="2026-09-09">
      <div class="hintline">แก้ได้ ถ้าลงข้อมูลย้อนหลัง — วันนี้คือ 9 ก.ย. 2026</div></div>
  </div>

  <div class="fld"><label>หมายเหตุ / สิ่งที่เจอ</label>
    <textarea rows="2">ค่าความนำไฟฟ้าสูงกว่าปกติเล็กน้อย ครั้งหน้าอาจต้องร่นรอบเป็นทุก 3 สัปดาห์</textarea></div>

  <div class="fld">
    <label>รูปหลังทำ</label>
    <div class="thumbs">
      <div class="th b">รูปก่อนทำ<br>(แนบไว้แล้ว)</div>
      <div class="th">รูปหลังทำ</div>
      <div class="th" style="border-style:dashed;background:transparent">＋ ถ่ายรูป</div>
    </div>
  </div>

  <div class="nextbox">
    <div class="nhead">🔁 ตั้งรอบถัดไป</div>
    <div class="nrow">
      <button class="ipill on brand">ตามรอบ · 5 ต.ค. (W41)</button>
      <button class="ipill">เลือกวันเอง</button>
      <button class="ipill">ไม่ต้องตั้ง</button>
    </div>
    <div class="ndate">
      <span class="al">วันที่ของรอบถัดไป</span>
      <input value="2026-10-05">
      <span class="hintline">ระบบเสนอให้ตามรอบ “ทุกเดือน” (W41) — เลื่อนเองได้ทุกครั้ง วันที่ที่เลือกคือวันที่ระบบจะออกใบถัดไป</span>
    </div>
  </div>

  <div class="okbox" style="margin-top:12px">
    ปิดงานแล้วระบบทำให้อีก 3 อย่างอัตโนมัติ: ขยับ <b>“PM ล่าสุด”</b> ของ RO 10,000 ·
    ติ๊กจุด W37 ในตารางทั้งปีให้เป็นสีเขียว · ส่ง<b>การ์ดสรุปเข้ากลุ่มช่าง</b>พร้อมรูปหลังทำ
  </div>

  <div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="ibtn">ยกเลิก</button>
    <button class="ibtn pri">✔ ยืนยันบันทึก</button>
  </div>
</div>
</div>`, `
.hintline{font-size:11.3px;color:var(--muted);margin-top:4px;display:block}
.fld textarea{resize:vertical}
.nextbox{background:var(--surface-2);border:1px solid var(--line);border-radius:13px;padding:12px 13px;margin-top:4px}
.nhead{font-family:var(--font-head);font-size:13px;font-weight:600;margin-bottom:8px}
.nrow{display:flex;gap:6px;flex-wrap:wrap}
.ndate{display:flex;flex-direction:column;gap:3px;margin-top:10px}
.ndate .al{font-size:11px;font-weight:700;color:var(--ink-soft)}
.ndate input{width:170px;border:1px solid var(--line);background:var(--card);border-radius:9px;
  padding:7px 10px;font-size:13px;font-family:inherit;font-variant-numeric:tabular-nums}
`));

/* ══════════ 8. สิทธิ์ + ปิดใช้งานรายรอบ ══════════ */
const roleCard = (sup) => `<div class="card" style="padding:15px 16px">
  <div style="display:flex;align-items:center;gap:9px;margin-bottom:11px">
    <span class="rb ${sup ? 'sup' : ''}">${sup ? '🛠️ หัวหน้างาน' : '👷 ช่างทั่วไป'}</span>
    <span class="hintline">${sup ? 'จักรกฤษ พูลสวัสดิ์' : 'ณรินศ์ · พัฒพริศ'}</span>
  </div>
  <article class="tk done" style="box-shadow:none">
    <div class="r1"><h3 style="font-size:14.5px;text-decoration:line-through;text-decoration-color:var(--sep)">AHU &amp; Chiller — เช็คแรงดันน้ำยาและล้างฟิลเตอร์</h3>
      <span class="chip freq">ทุกเดือน</span></div>
    <div class="meta"><span>👤 ณรินศ์</span><span class="dot">·</span><span style="color:var(--ok);font-weight:600">✅ เสร็จ 8 ก.ย.</span></div>
    <div class="acts">
      ${sup
        ? '<button class="ibtn sm">↩ ยกเลิกสถานะเสร็จ</button><button class="ibtn sm dgr">🗑 ลบ</button>'
        : '<span class="lock-note">🔒 ยกเลิก/ลบได้เฉพาะหัวหน้างาน</span>'}
      <button class="ibtn sm">🖼 ดูรูป</button>
    </div>
  </article>
  <article class="tk due" style="box-shadow:none;margin-top:10px">
    <div class="r1"><h3 style="font-size:14.5px">บ่อซีเมนต์ — ตรวจปั๊มสูบและวาล์วกันกลับ</h3><span class="chip due">W37</span></div>
    <div class="acts">
      <button class="ibtn sm ok">✅ ทำเสร็จแล้ว</button>
      ${sup
        ? '<button class="ibtn sm">⛔ ปิดรอบนี้</button><button class="ibtn sm">✏️ แก้แผน</button>'
        : '<button class="ibtn sm lock">⛔ ปิดรอบนี้ 🔒</button><button class="ibtn sm lock">✏️ แก้แผน 🔒</button>'}
    </div>
  </article>
  <div class="${sup ? 'okbox' : 'infobox'}" style="margin-top:11px;margin-bottom:0">
    ${sup
      ? 'แก้แผนรายปี · ยกเลิกสถานะเสร็จ · ลบงาน · ปิด/เปิดรอบ — <b>ทำได้ทั้งหมด</b>'
      : 'ติ๊กเสร็จ · แนบรูป · เขียนหมายเหตุ — <b>ทำได้</b> · ส่วนที่กระทบตัวเลขในรายงานถูกล็อกไว้'}
  </div>
</div>`;

writeFileSync('Permissions.dc.html', page(`<div class="wrap">
<div class="eyebrow">🔧 งานซ่อมบำรุง · งาน PM</div>
<div class="phead"><h1>สิทธิ์การใช้งาน &amp; การปิดรอบ</h1>
  <div class="sub">หน้าจอเดียวกัน เห็นไม่เหมือนกันตามบทบาท</div></div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px">
  ${roleCard(false)}
  ${roleCard(true)}
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;align-items:start">
  <div class="sheet">
    <h3>⛔ ปิดใช้งานรอบนี้</h3>
    <div class="hint">ไลน์ A3 — ตรวจชุดเติมลมและหัวจ่าย · W37/2026</div>
    <div class="fld"><label>เหตุผล <span class="req">*</span></label>
      <select><option>เครื่องยังไม่ติดตั้ง</option></select></div>
    <div class="fld"><label>รายละเอียด (ถ้ามี)</label><input value="รอผู้ขายเข้าติดตั้ง คาดว่าปลาย ต.ค."></div>
    <div class="fld"><label>ปิดถึงเมื่อไหร่</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="ipill on brand">เฉพาะรอบนี้</button>
        <button class="ipill">ถึงสิ้นปี</button>
        <button class="ipill">จนกว่าจะเปิดเอง</button>
      </div></div>
    <div class="warnbox">
      รอบที่ปิดไว้ <b>ไม่นับทั้งตัวตั้งและตัวหาร</b> — ไม่ขึ้นว่าเลยกำหนด และไม่ทำให้ % ในหน้าสรุปผลเพี้ยน
      ต่างจากการลบรายการทิ้งซึ่งทำให้ประวัติหาย
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="ibtn">ยกเลิก</button><button class="ibtn pri">⛔ ปิดรอบนี้</button>
    </div>
  </div>

  <div class="card" style="padding:15px 16px">
    <h3 class="hd">🚫 รอบที่ถูกปิดไว้ตอนนี้</h3>
    <table class="tb">
      <thead><tr><th>รายการ</th><th>รอบ</th><th>เหตุผล</th><th></th></tr></thead>
      <tbody>
        <tr><td>ไลน์ A3</td><td>W37</td><td>เครื่องยังไม่ติดตั้ง</td><td style="text-align:right"><button class="ibtn sm">▶️ เปิด</button></td></tr>
        <tr><td>ถุง AHU</td><td>W11</td><td>ถุงกรองยังไม่เข้า</td><td style="text-align:right"><button class="ibtn sm">▶️ เปิด</button></td></tr>
      </tbody>
    </table>
    <div class="infobox" style="margin-top:11px">
      🔎 <b>คำถามที่ยังต้องเคาะ:</b> ในแอปหลักยังไม่มีระบบบทบาท — จะรู้ว่าใครเป็น “หัวหน้างาน” จากอะไร
      (ชื่อผู้ใช้ที่เลือกไว้ · รหัสผ่านหน้า Admin · หรือธงในตารางทีมช่าง)
    </div>
  </div>
</div>
</div>`, `
.rb{font-family:var(--font-head);font-size:12px;font-weight:600;border-radius:999px;padding:3px 12px;
  background:var(--surface-2);border:1px solid var(--line);color:var(--ink-soft)}
.rb.sup{background:var(--brand-soft);border-color:var(--brand-soft);color:var(--brand-deep)}
.hintline{font-size:11.5px;color:var(--muted)}
`));
