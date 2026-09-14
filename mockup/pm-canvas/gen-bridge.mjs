import { writeFileSync } from 'node:fs';
import { page } from './shared.mjs';

/* ══════════ 10. การ์ดแจ้งเตือนกลุ่มช่าง (Telegram) ══════════ */
const kb = (rows) => `<div class="kb">${rows.map(r=>`<div class="kr">${r.map(b=>`<button class="kbtn">${b}</button>`).join('')}</div>`).join('')}</div>`;
const bubble = (body, keys) => `<div class="bub">${body}${keys ? kb(keys) : ''}
  <div class="time">08:00 ✓✓</div></div>`;

writeFileSync('TelegramCards.dc.html', page(`<div class="tglayout">
<div class="tgwrap">
  <div class="tgbar">
    <div class="ava">🔧</div>
    <div><div class="gn">SPP ช่างซ่อมบำรุง</div><div class="gm">4 สมาชิก · บอท @spp_maint_bot</div></div>
  </div>
  <div class="chat">

    ${bubble(`<div class="t">🗓 <b>งาน PM สัปดาห์หน้า</b> — W38 · 14–20 ก.ย.</div>
      <div class="l">แจ้งล่วงหน้า 3 วัน · <b>4 รายการ</b></div>
      <div class="ls">
        <div>🔧 <b>ไลน์ L1</b> — อัดจาระบีชุดสายพาน · 👤 ณรินศ์</div>
        <div>🔧 <b>Robot Clear Packer</b> — อัดจาระบีแกนหมุน · 👤 ณรินศ์</div>
        <div>🔧 <b>ไลน์ไอซิ่ง</b> — ตรวจระดับน้ำยา · 👤 จักรกฤษ</div>
        <div>🔧 <b>RO 5,000</b> — ล้างไส้กรอง Pre-filter · 👤 พัฒพริศ</div>
      </div>
      <div class="warn">⚠️ งานค้างสะสมอีก 11 รายการ — เก่าสุด ไลน์ไอซิ่ง W29</div>`,
      [['📋 เปิดกระดาน PM'], ['✅ ปิดงาน', '👤 รับงานที่ยังไม่มีคน']])}

    ${bubble(`<div class="t">⏰ <b>ถึงกำหนดวันนี้</b></div>
      <div class="l"><b>RO 10,000</b> — ล้างเมมเบรนและตรวจค่าความนำไฟฟ้า</div>
      <div class="ls">
        <div>🔩 RO 10,000 · 🗓 W37/2026 · 👤 พัฒพริศ</div>
        <div>🔁 ทุกเดือน · PM ล่าสุด 10 ส.ค.</div>
      </div>`,
      [['✅ ทำเสร็จแล้ว', '📸 แนบรูป'], ['📅 เลื่อนวัน', '⛔ ปิดรอบนี้']])}

    ${bubble(`<div class="t">✅ <b>ปิดงาน PM แล้ว</b></div>
      <div class="l">RO 10,000 — ล้างเมมเบรนและตรวจค่าความนำไฟฟ้า</div>
      <div class="ls">
        <div>👤 พัฒพริศ · 🗓 ทำจริง 9 ก.ย. 2026</div>
        <div>📝 ค่าความนำไฟฟ้าสูงกว่าปกติ — อาจต้องร่นรอบเป็นทุก 3 สัปดาห์</div>
        <div>🔁 รอบถัดไป <b>5 ต.ค. (W41)</b></div>
      </div>
      <div class="ph"><span>รูปก่อนทำ</span><span>รูปหลังทำ</span></div>`,
      [['🗓 ดูงาน PM ทั้งหมด']])}
  </div>
</div>

<div class="side">
  <div class="card" style="padding:14px 16px">
    <h3 class="hd">🔑 กติกาที่การ์ดชุดนี้ยึด</h3>
    <ul class="rules">
      <li><b>เข้ากลุ่มช่างเท่านั้น</b> — routing ตัดสินจาก “ใครต้องทำ” ไม่ใช่ชื่อฟีเจอร์ งาน PM เป็นงานช่าง</li>
      <li><b>การ์ดแก้ทับตัวเอง</b> ไม่โพสต์ใหม่ทุกครั้ง เหมือนการ์ดใบแจ้งซ่อมที่ใช้อยู่</li>
      <li><b>ปุ่มเฉพาะช่าง</b> — คนที่ยังไม่ผูกบัญชีกดแล้วขึ้นข้อความให้กด “🔧 ผมเป็นช่าง” ก่อน</li>
      <li><b>ไม่โชว์ค่าเสียโอกาสเป็นเงินในกลุ่ม</b></li>
    </ul>
    <div class="infobox" style="margin-top:10px">
      🔎 <b>ยังต้องเคาะ:</b> เตือนล่วงหน้ากี่วัน (ตอนนี้วาดไว้ 3 วัน) และส่งวันไหน — เช้าวันศุกร์ก่อนสัปดาห์ใหม่ หรือเช้าวันจันทร์
    </div>
  </div>
</div>
</div>`, `
.tglayout{display:grid;grid-template-columns:1fr 300px;gap:14px;align-items:start}
.tgwrap{border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:var(--shadow-card);background:#dfe5ea}
.tgbar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#fff;border-bottom:1px solid #d7dee4}
.ava{width:34px;height:34px;border-radius:50%;background:var(--brand-soft);display:grid;place-items:center;font-size:16px}
.gn{font-family:var(--font-head);font-size:14px;font-weight:600}
.gm{font-size:11px;color:var(--ink-soft)}
.chat{padding:14px;display:flex;flex-direction:column;gap:12px;
  background-image:radial-gradient(circle at 20% 30%, rgba(255,255,255,.55), transparent 45%),
    radial-gradient(circle at 75% 70%, rgba(255,255,255,.4), transparent 40%)}
.bub{background:#fff;border-radius:14px 14px 14px 4px;padding:11px 13px 8px;max-width:560px;
  box-shadow:0 1px 2px rgba(20,30,40,.14);font-size:13px;line-height:1.65}
.bub .t{font-size:14px;margin-bottom:3px}
.bub .l{color:var(--ink);margin-bottom:5px}
.bub .ls{font-size:12.3px;color:var(--ink-soft);display:flex;flex-direction:column;gap:2px;
  border-left:2px solid var(--line);padding-left:9px;margin:4px 0 2px}
.bub .warn{margin-top:7px;font-size:12.2px;color:var(--p-warn);background:var(--p-warn-w);border-radius:9px;padding:6px 9px}
.bub .ph{display:flex;gap:6px;margin-top:8px}
.bub .ph span{flex:1;height:64px;border-radius:9px;background:#eceff2;border:1px solid #dde3e8;
  display:grid;place-items:center;font-size:10.5px;color:#8b949c}
.kb{margin-top:9px;display:flex;flex-direction:column;gap:5px}
.kr{display:flex;gap:5px}
.kbtn{flex:1;border:none;background:#f0f3f5;color:#2f6ea5;font-family:var(--font-head);font-size:12.5px;
  font-weight:600;padding:8px 10px;border-radius:9px;cursor:pointer}
.time{text-align:right;font-size:10px;color:#93a0aa;margin-top:4px}
.rules{list-style:none;display:flex;flex-direction:column;gap:8px;font-size:12.3px;line-height:1.6;color:var(--ink-soft)}
.rules li{padding-left:16px;position:relative}
.rules li::before{content:'·';position:absolute;left:5px;color:var(--brand);font-weight:700;font-size:16px;top:-3px}
`));

/* ══════════ 11. ใบเช็ก AM → ตั้งเป็นงาน PM ══════════ */
writeFileSync('AmToPm.dc.html', page(`<div class="wrap">
<div class="eyebrow">🔧 งานซ่อมบำรุง · เชื่อมกับของเดิม</div>
<div class="phead"><h1>ใบเช็ก AM → เปิดงานต่อ</h1>
  <div class="sub">ข้อที่ติ๊ก “ไม่ปกติ” เลือกปลายทางได้ 2 ทาง — ของเดิมมีทางเดียวคือใบแจ้งซ่อม</div></div>

<div class="flow">
  <div class="step">
    <div class="sn">1</div>
    <div class="card" style="padding:14px 15px">
      <div class="hd" style="margin-bottom:6px">📋 ใบเช็ก AM รายกะ · กะเช้า 9 ก.ย.</div>
      <div class="amrow ok"><span class="ck">✓</span><div><b>Line ต้ม 1</b> — ตรวจระดับน้ำมันเกียร์</div><span class="chip low">ปกติ</span></div>
      <div class="amrow bad"><span class="ck bad">!</span><div><b>Line ต้ม 1</b> — เสียงมอเตอร์ปั๊มจ่าย
        <div class="s">ดังผิดปกติตอนเดินเครื่องเกิน 2 ชม.</div></div><span class="chip stop">ไม่ปกติ</span></div>
      <div class="amrow ok"><span class="ck">✓</span><div><b>Line ต้ม 2</b> — ตรวจแรงดันไอน้ำ</div><span class="chip low">ปกติ</span></div>
    </div>
  </div>

  <div class="arrow">→</div>

  <div class="step">
    <div class="sn">2</div>
    <div class="sheet">
      <h3>เจอข้อผิดปกติ — จะเปิดงานแบบไหน</h3>
      <div class="hint">Line ต้ม 1 — เสียงมอเตอร์ปั๊มจ่าย</div>
      <button class="pick">
        <div class="pi">🛠</div>
        <div><div class="pt">เปิดใบแจ้งซ่อม</div>
        <div class="ps">ของเดิม — ต้องแก้เดี๋ยวนี้ เข้าคิวงานซ่อม มีเวลาเครื่องหยุด</div></div>
      </button>
      <button class="pick on">
        <div class="pi br">🗓</div>
        <div><div class="pt">ตั้งเป็นงาน PM <span class="chip due">ใหม่</span></div>
        <div class="ps">ยังเดินเครื่องได้ แต่ต้องเข้าไปทำตามแผน — เลือกวันหรือใส่เข้ารอบประจำปีก็ได้</div></div>
      </button>
      <div class="fld" style="margin-top:12px"><label>วันที่จะทำ</label><input value="2026-09-14"></div>
      <div class="fld"><label>เพิ่มเข้าแผนประจำปีด้วยไหม</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="ipill on brand">ครั้งเดียวพอ</button>
          <button class="ipill">เพิ่มเป็นรายการในแผน</button>
        </div></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button class="ibtn">ยกเลิก</button><button class="ibtn pri">🗓 ตั้งงาน PM</button>
      </div>
    </div>
  </div>

  <div class="arrow">→</div>

  <div class="step">
    <div class="sn">3</div>
    <article class="tk due" style="margin-bottom:12px">
      <div class="r1"><h3>ไลน์ต้ม 1 — ตรวจมอเตอร์ปั๊มจ่าย (เสียงดังผิดปกติ)</h3>
        <span class="chip kind-pm">🔧 บำรุงรักษา</span><span class="src am">มาจากใบเช็ก AM</span></div>
      <div class="meta"><span>🔩 ไลน์ต้ม 1</span><span class="dot">·</span><span>👤 จักรกฤษ</span>
        <span class="dot">·</span><span>📅 14 ก.ย. 2026</span><span class="dot">·</span>
        <span>📋 ใบเช็ก AM กะเช้า 9 ก.ย.</span></div>
      <div class="acts"><button class="ibtn sm ok">✅ ทำเสร็จแล้ว</button><button class="ibtn sm">📋 ดูใบเช็กต้นเรื่อง</button></div>
    </article>
    <div class="okbox">
      ผูกกลับไปที่ใบเช็กต้นเรื่องด้วย <b>ref_key</b> เหมือนที่ใบแจ้งซ่อมทำอยู่ — ติ๊กข้อเดิมซ้ำในกะถัดไป
      <b>ไม่เปิดงานซ้ำ</b> แต่ไปเพิ่มจำนวนครั้งในงานเดิมแทน
    </div>
    <div class="infobox" style="margin-top:10px">
      🔎 <b>ยังต้องเคาะ:</b> ให้ทีมผลิตที่กรอกใบเช็กตั้งงาน PM ได้เอง หรือให้เสนอเข้าคิวรอช่างยืนยันก่อน
    </div>
  </div>
</div>
</div>`, `
.flow{display:grid;grid-template-columns:1fr 26px 1fr 26px 1fr;gap:10px;align-items:start;margin-top:18px}
.step{position:relative}
.sn{position:absolute;left:-6px;top:-12px;width:26px;height:26px;border-radius:50%;background:var(--brand);
  color:#fff;font-family:var(--font-head);font-size:13px;font-weight:600;display:grid;place-items:center;
  box-shadow:var(--shadow-card);z-index:2}
.arrow{display:grid;place-items:center;color:var(--sep);font-size:20px;padding-top:60px}
.amrow{display:flex;align-items:flex-start;gap:9px;padding:9px 2px;border-bottom:1px solid var(--row-line);font-size:12.8px}
.amrow:last-child{border-bottom:none}
.amrow .s{font-size:11.3px;color:var(--muted)}
.amrow > div{flex:1}
.ck{width:20px;height:20px;border-radius:6px;background:var(--p-low-w);color:var(--ok);display:grid;place-items:center;
  font-size:12px;font-weight:700;flex:0 0 20px;margin-top:2px}
.ck.bad{background:var(--p-stop-w);color:var(--danger)}
.pick{display:flex;gap:11px;align-items:flex-start;width:100%;text-align:left;background:var(--card);
  border:1px solid var(--line);border-radius:13px;padding:11px 12px;cursor:pointer;margin-bottom:8px;font-family:inherit}
.pick.on{border-color:var(--brand);background:var(--brand-soft);box-shadow:0 0 0 3px rgba(255,107,0,.12)}
.pi{width:34px;height:34px;border-radius:10px;background:var(--surface-2);display:grid;place-items:center;font-size:16px;flex:0 0 34px}
.pi.br{background:#fff}
.pt{font-family:var(--font-head);font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:7px}
.ps{font-size:11.6px;color:var(--ink-soft);line-height:1.55}
`));
