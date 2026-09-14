import { writeFileSync } from 'node:fs';
import { page } from './shared.mjs';

const MCSS = `
body{background:var(--paper)}
.mw{padding:12px 12px 78px}
.mhead{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.mhead h1{font-size:19px;letter-spacing:-.03em}
.mhead .sub{font-size:11.5px;color:var(--ink-soft)}
.off{display:flex;align-items:center;gap:9px;background:#2b2119;color:#f7f1ea;border-radius:12px;
  padding:9px 12px;font-size:12px;line-height:1.5;margin-bottom:10px}
.off b{color:#ffc79a}
.off .badge{margin-left:auto;background:rgba(255,255,255,.14);border-radius:999px;padding:2px 9px;font-size:11px;font-weight:700;white-space:nowrap}
.wknav{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);
  border-radius:14px;padding:8px 10px;box-shadow:var(--shadow-card);margin-bottom:10px}
.wknav .t{font-family:var(--font-head);font-size:14.5px;font-weight:600}
.wknav .s{font-size:11px;color:var(--ink-soft)}
.nav{width:44px;height:44px;border-radius:12px;border:1px solid var(--line);background:var(--surface-3);
  color:var(--ink-soft);font-size:14px}
.mstats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:11px}
.ms{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 5px;text-align:center;box-shadow:var(--shadow-card)}
.ms .v{font-family:var(--font-head);font-size:19px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums}
.ms .l{font-size:11px;color:var(--ink-soft);line-height:1.3;margin-top:1px}
.mtk{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--sep);border-radius:14px;
  padding:11px 12px;box-shadow:var(--shadow-card);margin-bottom:9px}
.mtk.late{border-left-color:var(--p-stop);background:linear-gradient(180deg,#fffaf9,var(--card) 55%)}
.mtk.due{border-left-color:var(--brand)}
.mtk.done{border-left-color:var(--ok);opacity:.9}
.mtk h3{font-size:14px;line-height:1.4;margin-bottom:4px}
.mtk .meta{font-size:11.3px;color:var(--ink-soft);display:flex;flex-wrap:wrap;gap:3px 8px;margin-top:3px}
.mtk .chips{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:5px}
.big{display:flex;gap:7px;margin-top:10px}
.big button{flex:1;min-height:44px;border-radius:12px;border:1px solid var(--line);background:var(--surface-3);
  color:var(--ink-soft);font-family:var(--font-head);font-size:13px;font-weight:600;cursor:pointer}
.big button.ok{background:var(--p-low-w);color:var(--ok);border-color:transparent;flex:2}
.big button.q{flex:0 0 52px;font-size:15px}
.queued{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--warn);
  background:var(--warn-soft-bg);border-radius:999px;padding:3px 10px;font-weight:600;margin-top:8px;width:fit-content}
.tabbar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);border-top:1px solid var(--line);
  display:grid;grid-template-columns:repeat(4,1fr);padding:6px 6px calc(6px + env(safe-area-inset-bottom));gap:4px}
.tb{border:none;background:transparent;min-height:48px;border-radius:12px;font-family:var(--font-head);
  font-size:11px;font-weight:600;color:var(--ink-soft);display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:2px;cursor:pointer}
.tb .i{font-size:17px;line-height:1}
.tb.on{background:var(--brand-soft);color:var(--brand-deep)}
`;

/* ══════════ 12. มือถือ — สัปดาห์นี้ + ออฟไลน์ ══════════ */
writeFileSync('MobileWeek.dc.html', page(`<div class="mw">
  <div class="mhead">
    <div><h1>งาน PM</h1><div class="sub">แผนประจำปี · W37/2026</div></div>
    <div class="sp" style="flex:1"></div>
    <button class="nav">⋯</button>
  </div>

  <div class="off">
    <span style="font-size:15px">📴</span>
    <div><b>ไม่มีสัญญาณ</b><br>ติ๊กต่อได้เลย เดี๋ยวส่งให้เองเมื่อเน็ตกลับมา</div>
    <span class="badge">รอส่ง 3</span>
  </div>

  <div class="wknav">
    <button class="nav">‹</button>
    <div style="flex:1"><div class="t">สัปดาห์ที่ 37</div><div class="s">7 – 13 ก.ย. · สัปดาห์นี้</div></div>
    <button class="nav">›</button>
  </div>

  <div class="mstats">
    <div class="ms"><div class="v">6</div><div class="l">ต้องทำ</div></div>
    <div class="ms"><div class="v" style="color:var(--ok)">2</div><div class="l">ทำแล้ว</div></div>
    <div class="ms"><div class="v" style="color:var(--warn)">4</div><div class="l">ยังไม่ทำ</div></div>
    <div class="ms"><div class="v" style="color:var(--danger)">11</div><div class="l">ค้างเก่า</div></div>
  </div>

  <div class="mtk late">
    <div class="chips"><span class="chip stop">เกินกำหนด 17 วัน</span><span class="chip freq">ทุกเดือน</span></div>
    <h3>RO 5,000 — ล้างไส้กรอง Pre-filter</h3>
    <div class="meta"><span>🔩 RO 5,000</span><span>👤 พัฒพริศ</span><span>📅 W34 · 17 ส.ค.</span></div>
    <div class="big"><button class="ok">✅ ทำเสร็จแล้ว</button><button class="q">📸</button><button class="q">⋯</button></div>
  </div>

  <div class="mtk due">
    <div class="chips"><span class="chip due">W37 · สัปดาห์นี้</span><span class="chip kind-pm">🔧 บำรุงรักษา</span></div>
    <h3>RO 10,000 — ล้างเมมเบรนและตรวจค่าความนำไฟฟ้า</h3>
    <div class="meta"><span>🔩 RO 10,000</span><span>👤 พัฒพริศ</span><span>🔁 ทุกเดือน</span></div>
    <div class="big"><button class="ok">✅ ทำเสร็จแล้ว</button><button class="q">📸</button><button class="q">⋯</button></div>
  </div>

  <div class="mtk done">
    <div class="chips"><span class="chip low">✅ เสร็จ 8 ก.ย.</span></div>
    <h3 style="text-decoration:line-through;text-decoration-color:var(--sep)">ไลน์ไอซิ่ง — ตรวจระดับน้ำยาและทำความสะอาดคอยล์</h3>
    <div class="meta"><span>👤 จักรกฤษ</span><span>🖼 2 รูป</span></div>
    <div class="queued">⏳ รอส่งเมื่อเน็ตกลับมา</div>
  </div>

  <div class="mtk">
    <div class="chips"><span class="chip mute">🚫 ปิดรอบนี้</span></div>
    <h3 style="color:var(--muted)">ไลน์ A3 — ตรวจชุดเติมลมและหัวจ่าย</h3>
    <div class="meta"><span>เครื่องยังไม่ติดตั้ง · โดย จักรกฤษ</span></div>
  </div>
</div>

<div class="tabbar">
  <button class="tb on"><span class="i">🗓️</span>สัปดาห์นี้</button>
  <button class="tb"><span class="i">📊</span>ทั้งปี</button>
  <button class="tb"><span class="i">🔩</span>เครื่อง</button>
  <button class="tb"><span class="i">📆</span>ปฏิทิน</button>
</div>`, MCSS));

/* ══════════ 13. มือถือ — แผ่นปิดงานเต็มจอ ══════════ */
writeFileSync('MobileDone.dc.html', page(`<div class="mw" style="padding-bottom:96px">
  <div class="shhead">
    <button class="nav">✕</button>
    <div><div class="t">✅ ปิดงาน PM</div><div class="s">RO 10,000 · W37/2026</div></div>
  </div>

  <div class="card" style="padding:12px 13px;margin-bottom:11px">
    <div style="font-family:var(--font-head);font-size:14.5px;font-weight:600;line-height:1.4">ล้างเมมเบรนและตรวจค่าความนำไฟฟ้า</div>
    <div style="font-size:11.5px;color:var(--ink-soft);margin-top:3px">🔁 ทุกเดือน · PM ล่าสุด 10 ส.ค. 2026</div>
  </div>

  <div class="fld"><label>ผู้ทำ PM</label><select style="min-height:44px"><option>พัฒพริศ อ่ำอยู่</option></select></div>
  <div class="fld"><label>วันที่ทำจริง</label><input style="min-height:44px" value="2026-09-09">
    <div class="hintline">แก้ได้ ถ้าลงย้อนหลัง</div></div>
  <div class="fld"><label>หมายเหตุ / สิ่งที่เจอ</label><textarea rows="2" style="min-height:64px">ค่าความนำไฟฟ้าสูงกว่าปกติเล็กน้อย</textarea></div>

  <div class="fld">
    <label>รูปหลังทำ</label>
    <div class="mth">
      <div class="th b">รูปก่อนทำ</div>
      <button class="th cam">📷<br>ถ่ายรูป</button>
    </div>
  </div>

  <div class="nextbox">
    <div class="nhead">🔁 ตั้งรอบถัดไป</div>
    <div class="nopt on"><span class="rd on"></span><div><b>ตามรอบ · 5 ต.ค. (W41)</b><div class="s">ตามความถี่ “ทุกเดือน”</div></div></div>
    <div class="nopt"><span class="rd"></span><div><b>เลือกวันเอง</b><div class="s">เลื่อนได้ตามสภาพหน้างาน</div></div></div>
    <div class="nopt"><span class="rd"></span><div><b>ไม่ต้องตั้ง</b><div class="s">ปิดจบรอบนี้อย่างเดียว</div></div></div>
  </div>

  <div class="okbox" style="margin-top:11px">ปิดแล้วส่งการ์ดเข้ากลุ่มช่างให้อัตโนมัติ พร้อมรูปหลังทำ</div>
</div>

<div class="bottombar">
  <button class="cancel">ยกเลิก</button>
  <button class="confirm">✔ ยืนยันบันทึก</button>
</div>`, MCSS + `
.shhead{display:flex;align-items:center;gap:11px;margin-bottom:12px}
.shhead .t{font-family:var(--font-head);font-size:17px;font-weight:600}
.shhead .s{font-size:11.5px;color:var(--ink-soft)}
.hintline{font-size:11px;color:var(--muted);margin-top:3px;display:block}
.mth{display:flex;gap:8px}
.mth .th{width:84px;height:84px;font-size:11px}
.mth .cam{border-style:dashed;background:var(--surface-3);color:var(--ink-soft);font-family:var(--font-head);
  font-weight:600;line-height:1.5;cursor:pointer}
.nextbox{background:var(--surface-2);border:1px solid var(--line);border-radius:14px;padding:12px 13px}
.nhead{font-family:var(--font-head);font-size:13.5px;font-weight:600;margin-bottom:9px}
.nopt{display:flex;gap:10px;align-items:flex-start;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:10px 11px;margin-bottom:7px;font-size:13px;min-height:48px}
.nopt.on{border-color:var(--brand);background:var(--brand-soft)}
.nopt .s{font-size:11.2px;color:var(--ink-soft)}
.rd{width:17px;height:17px;border-radius:50%;border:2px solid var(--sep);flex:0 0 17px;margin-top:3px}
.rd.on{border-color:var(--brand);background:radial-gradient(circle,var(--brand) 42%,#fff 46%)}
.bottombar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:9px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));
  background:rgba(255,255,255,.97);border-top:1px solid var(--line)}
.bottombar button{min-height:48px;border-radius:13px;font-family:var(--font-head);font-size:14px;font-weight:600;cursor:pointer}
.cancel{flex:1;border:1px solid var(--line);background:var(--card);color:var(--ink-soft)}
.confirm{flex:2;border:1px solid var(--brand);background:var(--brand);color:#fff}
`));
