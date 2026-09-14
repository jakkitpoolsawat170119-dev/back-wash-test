import { readFileSync, writeFileSync } from 'node:fs';
import { page } from './shared.mjs';
import { ITEMS, status, weeksOfItem, CUR_WEEK as CUR } from './gen-views.mjs';

/* ══════════ v3: โหมด "กระจกอ่านอย่างเดียว" ══════════
   เจ้าของแผนและผลปิดงาน = แอปทีมช่างบน Netlify (Firebase spp-am)
   แอปหลักดึงมาแสดงทางเดียว → ปุ่มที่เขียนข้อมูลกลับต้องหายหมด
   ยกเว้นแท็บ "งานเพิ่มเอง" ที่เป็นข้อมูลของแอปหลักเอง Netlify ไม่มีช่องนี้
   ทำด้วยการแปลง artboard ของ v2 ไม่ก็อปโครงมาเขียนใหม่ ของเดิมจึงยัง build ได้ปกติ */

const NETLIFY = 'https://sppmaintennceteam.netlify.app/';
const LAST_SYNC = '10 ก.ย. 2026 · 04:12';
const ext = (t = '↗ เปิดแอปทีมช่าง') =>
  `<a class="ibtn sm ext" href="${NETLIFY}" target="_blank" rel="noopener">${t}</a>`;

const RO_CSS = `
.syncbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  background:linear-gradient(90deg,#eef5fb,var(--card) 72%);border:1px solid #cfe3f3;border-radius:14px;
  padding:9px 13px;margin:12px 0 0;font-size:12.8px;color:var(--ink-soft)}
.syncbar .sb-t{flex:1;min-width:230px}
.syncbar .sb-t b{color:var(--cip1)}
.sb-time{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.dot2{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none;
  box-shadow:0 0 0 3px rgba(28,138,76,.16)}
.acts.ro{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px}
.ro-note{font-size:11.5px;color:var(--muted)}
.ibtn.ext{color:var(--cip1);border-color:#cfe3f3;background:#eef5fb;text-decoration:none}
.ibtn.ext:hover{background:#e2eefa;color:#0d4a80}
.ibtn.ext:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(21,101,192,.28)}
`;
const addCss = (s, css) => s.replace('</style>', css + '</style>');

/* ── 1. สัปดาห์นี้ — การ์ดจากแผนเป็นอ่านอย่างเดียว การ์ดงานเพิ่มเองคงปุ่มไว้ ── */
let wk = readFileSync('Main2.dc.html', 'utf8');
wk = wk.replace('<div class="wkprog">', `<div class="syncbar">
  <span class="dot2"></span>
  <div class="sb-t">แผนและผลปิดงาน <b>ดึงมาจากแอปทีมช่าง (Netlify)</b> — หน้านี้อ่านอย่างเดียว</div>
  <span class="sb-time">อัปเดตล่าสุด ${LAST_SYNC}</span>
  ${ext()}
</div>

<div class="wkprog">`);

let roCards = 0, adhocCards = 0;
wk = wk.replace(/<article class="tk[^"]*">[\s\S]*?<\/article>/g, (art) => {
  if (!art.includes('class="src plan"')) {
    // งานเพิ่มเอง = ตารางของแอปนี้เอง ยังกดได้ — แต่ "ปิดรอบนี้" เป็นแนวคิดของแผนรายปี ไม่ใช่งานนอกแผน
    // ใช้ชุดปุ่มเดียวกับแท็บงานเพิ่มเองเพื่อไม่ให้สองที่ทำไม่เหมือนกัน
    adhocCards++;
    return art.replace('<button class="ibtn sm">⛔ ปิดรอบนี้</button>', '<button class="ibtn sm dgr">🗑</button>');
  }
  roCards++;
  const hasPhoto = art.includes('class="thumbs"') || art.includes('🖼 ดูรูป');
  art = art.replace(/<div class="th" style="border-style:dashed[^"]*">[^<]*<\/div>/g, '');
  return art.replace(/<div class="acts">[\s\S]*?<\/div>(?=\s*<\/article>)/,
    `<div class="acts ro">${hasPhoto ? '<button class="ibtn sm">🖼 ดูรูป</button>' : ''}` +
    `<span class="ro-note">🔒 ปิดงาน / เลื่อนวัน / มอบหมาย ทำที่แอปทีมช่าง</span>${ext()}</div>`);
});
writeFileSync('Main3.dc.html', addCss(wk, RO_CSS));

/* ── 2. ตารางทั้งปี — จุดกดไม่ได้ (ผลปิดงานเป็นของ Netlify)
       แต่ "แถวงานย่อย" คงไว้: Netlify ไม่มีช่องนี้เลย งานย่อยจึงเป็นข้อมูลของแอปนี้เอง ── */
let yr = readFileSync('YearGrid2.dc.html', 'utf8');
const jrKept = (yr.match(/<tr class="jr /g) || []).length;
yr = yr.replace(/<button class="d( sm)?" title="([^"]*)"><i style="([^"]*)"><\/i><\/button>/g,
  (_m, sm, t, st) => `<span class="d${sm || ''}" title="${t}"><i style="${st}"></i></span>`);
yr = yr.replace('<button class="ibtn">⛔ เปิด/ปิดรายการ</button>', '');
yr = yr.replace('คลิกที่จุดเพื่อบันทึกว่าทำแล้ว · กด ▸ เพื่อกางดูงานย่อยของเครื่องนั้น',
  'กด ▸ กางดูงานย่อยของเครื่องนั้น (แก้ได้ในแอปนี้) · จุดคือผลปิดงานจากแอปทีมช่าง แก้ที่นั่น');
yr = addCss(yr, RO_CSS + `
#yg2 .d{cursor:default}
#yg2 .d:hover{transform:none}
#yg2 .ybar{gap:9px}
`);
yr = yr.replace('<div class="mx rng-half" id="mx">', `<div class="syncbar" style="margin:0 0 11px">
  <span class="dot2"></span>
  <div class="sb-t">ตารางนี้คือ <b>ภาพสะท้อนของแผนบนแอปทีมช่าง</b> · แผน 30 รายการ · อัปเดตล่าสุด ${LAST_SYNC}</div>
  ${ext('↗ แก้แผนที่แอปทีมช่าง')}
</div>
<div class="mx rng-half" id="mx">`);
writeFileSync('YearGrid3.dc.html', yr);

/* ── 3. ตามเครื่องจักร — เอาปุ่มแก้รอบออก เหลือแค่ดูงาน ── */
let bm = readFileSync('ByMachine.dc.html', 'utf8');
const editBtn = (bm.match(/✏️ แก้รอบ/g) || []).length;
bm = bm.replace(/<button class="ibtn sm">✏️ แก้รอบ<\/button>/g, '');
writeFileSync('ByMachine3.dc.html', addCss(bm, RO_CSS));

/* ── 4. มือถือ — ตัดปุ่มปิดงานออก บอกทางไปปิดที่แอปทีมช่างแทน ── */
let mw = readFileSync('MobileWeek.dc.html', 'utf8');
const bigBtns = (mw.match(/<div class="big">/g) || []).length;
mw = mw.replace(/<div class="big">[\s\S]*?<\/div>\s*<\/div>/g,
  '<div class="mro">🔒 ปิดงานที่แอปทีมช่าง</div></div>');
// แถบออฟไลน์ "ติ๊กต่อได้เลย" ใช้ไม่ได้แล้ว เพราะหน้านี้ติ๊กอะไรไม่ได้ — ตัดทิ้งทั้งบล็อก
mw = mw.replace(/<div class="off">[\s\S]*?<span class="badge">[\s\S]*?<\/span>\s*<\/div>/,
  '<div class="mnote">📡 ดึงจากแอปทีมช่าง · อ่านอย่างเดียว</div>');
mw = mw.replace(/<div class="queued">[\s\S]*?<\/div>/g, '');
// แถบล่างให้ตรงกับอีก 2 จอ (สัปดาห์นี้ · ทั้งปี · เครื่อง · สรุปผล)
mw = mw.replace('<button class="tb"><span class="i">📆</span>ปฏิทิน</button>',
                '<button class="tb"><span class="i">📈</span>สรุปผล</button>');
mw = addCss(mw, `
.mro{margin-top:9px;font-size:12px;font-weight:600;color:var(--cip1);background:#eef5fb;
  border:1px solid #cfe3f3;border-radius:11px;padding:9px 12px;text-align:center}
.mnote{background:#eef5fb;border:1px solid #cfe3f3;border-radius:12px;padding:8px 12px;
  font-size:12px;color:var(--cip1);font-weight:600;margin-bottom:10px}
`);
writeFileSync('MobileWeek3.dc.html', mw);

let my = readFileSync('MobileYear.dc.html', 'utf8');
my = my.replace(/<button class="wc([^"]*)" aria-label="([^"]*)"><i style="([^"]*)"><\/i><\/button>/g,
  (_m, c, a, st) => `<span class="wc${c}" role="img" aria-label="${a}"><i style="${st}"></i></span>`);
writeFileSync('MobileYear3.dc.html', my);

/* ── 4b. แผ่นรายละเอียดรายการ — ส่วนแผนอ่านอย่างเดียว แต่ลิสต์งานย่อยแก้ได้เต็มที่
       งานย่อยเป็นข้อมูลของแอปนี้เอง ผูกกับรหัสรายการของแอปทีมช่าง (w01–w30) ── */
const IT = ITEMS[1];                        // ไลน์ต้ม 1 = w03 ในแผนของแอปทีมช่าง
const NET_ID = 'w03';
const rounds = weeksOfItem(IT).length;

let pi = readFileSync('PlanEdit2.dc.html', 'utf8');
pi = pi.replace('<h3>✏️ แก้ไขรายการในแผน PM</h3>', '<h3>🔧 รายละเอียดรายการ PM</h3>');
pi = pi.replace(/<div class="hint">([^<]*)<\/div>/,
  (_m, t) => `<div class="hint">${t}</div>`);

// หัวแผ่น: ค่าที่มาจากแอปทีมช่าง แสดงอย่างเดียว — แทน select เครื่อง + pills ความถี่ ของเดิม
const roHead = `<div class="rohead">
  <div class="rh-row">
    <div><span class="rh-l">เครื่อง / พื้นที่</span><div class="rh-v">${IT.name}</div></div>
    <div><span class="rh-l">ความถี่</span><div class="rh-v">${IT.freq}</div></div>
    <div><span class="rh-l">รอบต่อปี</span><div class="rh-v">${rounds} รอบ</div></div>
    <div><span class="rh-l">รหัสในแอปทีมช่าง</span><div class="rh-v mono">${NET_ID}</div></div>
    <div style="flex:1"></div>
    ${ext('↗ แก้แผนที่แอปทีมช่าง')}
  </div>
  <div class="rh-note">🔒 ชื่อ · ความถี่ · สัปดาห์ที่ครบกำหนด ดึงมาจากแอปทีมช่าง — แก้ที่นี่ไม่ได้</div>
</div>

`;
{ const a = pi.indexOf('<div class="grid2">'), b = pi.indexOf('<div class="fld jbox">');
  if (a < 0 || b < 0) throw new Error('หาหัวแผ่น PlanEdit2 ไม่เจอ');
  pi = pi.slice(0, a) + roHead + pi.slice(b); }

// บล็อก "สร้างรูปแบบสัปดาห์อัตโนมัติ" ใช้ไม่ได้แล้ว — สัปดาห์มาจากแอปทีมช่าง
{ const c = pi.indexOf('<div class="fld" style="margin-top:4px">');
  const d = pi.lastIndexOf('<div class="fld">', pi.indexOf('สัปดาห์ที่ต้องทำ PM'));
  if (c < 0 || d < 0) throw new Error('หาบล็อกสร้างรูปแบบสัปดาห์ไม่เจอ');
  pi = pi.slice(0, c) + pi.slice(d); }

// ตาราง 52 สัปดาห์ = ผลลัพธ์จากแผน ไม่ใช่ช่องให้กด
pi = pi.replace(/<button class="wq([^"]*)">(\d+)<\/button>/g, (_m, c, n) => `<span class="wq${c}">${n}</span>`);
pi = pi.replace('<label>สัปดาห์ที่ต้องทำ PM — คลิกเพื่อเลือก / ยกเลิก ปรับเองได้อิสระ</label>',
  '<label>สัปดาห์ที่ต้องทำ PM <span class="tagro">🔒 อ่านอย่างเดียว</span></label>');

// ลิสต์งานย่อย = ส่วนเดียวที่แก้ได้ ทำป้ายให้ชัด
pi = pi.replace('<span class="tagnew">เลือกจากลิสต์ได้ · พิมพ์ชื่อใหม่ได้</span>',
  '<span class="tagedit">✏️ แก้ได้ในแอปนี้</span><span class="tagnew">เลือกจากลิสต์ได้ · พิมพ์ชื่อใหม่ได้</span>');

// เรื่องแจ้งเตือนพักไว้ก่อน — ตัดช่องออก
pi = pi.replace(/<div class="fld"><label>แจ้งเตือนเข้ากลุ่มช่าง<\/label>[\s\S]*?<\/div>/, '');
pi = pi.replace('<label>ผู้รับผิดชอบตั้งต้น</label>',
  '<label>ผู้รับผิดชอบตั้งต้น <span class="tagedit">✏️ แก้ได้ในแอปนี้</span></label>');

pi = pi.replace(/<div class="warnbox">[\s\S]*?<\/div>/,
  `<div class="warnbox">แผ่นนี้บันทึกได้เฉพาะ <b>ลิสต์งานย่อยและผู้รับผิดชอบ</b> ซึ่งเก็บอยู่ในแอปนี้ ·
   ส่วนสัปดาห์และความถี่ต้องไปแก้ที่แอปทีมช่าง แล้วรอบถัดไปที่ดึงข้อมูลจะอัปเดตให้เอง</div>`);
pi = pi.replace('<button class="ibtn pri">✔ บันทึก</button>',
  '<button class="ibtn pri">✔ บันทึกลิสต์งาน</button>');

writeFileSync('PlanItem3.dc.html', addCss(pi, RO_CSS + `
.rohead{background:var(--surface-2);border:1px solid var(--line);border-radius:14px;padding:11px 14px;margin-bottom:12px}
.rh-row{display:flex;align-items:flex-end;gap:22px;flex-wrap:wrap}
.rh-l{font-size:10.5px;font-weight:700;color:var(--muted);display:block}
.rh-v{font-family:var(--font-head);font-size:14.5px;font-weight:600;color:var(--ink);line-height:1.35}
.rh-v.mono{font-family:ui-monospace,monospace;font-size:13px;color:var(--cip1)}
.rh-note{font-size:11.3px;color:var(--muted);margin-top:8px;padding-top:8px;border-top:1px solid var(--row-line)}
.tagro{font-size:10.5px;font-weight:700;color:var(--muted);background:var(--surface-2);
  border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:6px;font-family:var(--font-body)}
.tagedit{font-size:10.5px;font-weight:700;color:var(--ok);background:var(--p-low-w);
  border-radius:999px;padding:1px 8px;margin-left:6px;font-family:var(--font-body)}
.wq{display:grid;place-items:center;cursor:default}
.wq:hover{transform:none;border-color:var(--line)}
`));

/* ── 5. บล็อกใหม่: อธิบายว่าข้อมูลเชื่อมกันยังไง ── */
const totals = ITEMS.reduce((a, it, i) => {
  weeksOfItem(it).forEach(w => { const s = status(i, w); if (s !== 'skip') a.plan++; if (s === 'done') a.done++; });
  return a;
}, { plan: 0, done: 0 });

const row = (path, what, where) =>
  `<tr><td><code>${path}</code></td><td>${what}</td><td>${where}</td></tr>`;

writeFileSync('SyncInfo.dc.html', page(`<div class="wrap">
<div class="syncbar" style="margin:0 0 14px">
  <span class="dot2"></span>
  <div class="sb-t">เชื่อมกับ <b>Firebase ของแอปทีมช่าง (spp-am)</b> · ดึงทางเดียว · อัปเดตล่าสุด ${LAST_SYNC}</div>
  <button class="ibtn sm">🔄 ดึงเดี๋ยวนี้</button>
  ${ext()}
</div>

<div style="display:grid;grid-template-columns:1fr 340px;gap:14px;align-items:start" class="sy2">
  <div class="card" style="padding:4px 4px 8px">
    <div style="padding:12px 14px 4px"><h3 style="font-size:15px">อะไรมาจากไหน</h3></div>
    <table class="tb">
      <thead><tr><th style="width:190px">ที่เก็บบน Firebase</th><th>คือข้อมูลอะไร</th><th style="width:150px">แก้ได้ที่ไหน</th></tr></thead>
      <tbody>
        ${row('— (ฝังในแอป)', 'แผนตั้งต้น 30 รายการ · ชื่อ / ความถี่ / สัปดาห์ที่ครบกำหนด', '<span class="chip mute">คัดลอกมาครั้งเดียว</span>')}
        ${row('pm_plan_overrides', 'รายการที่ถูกแก้ / เพิ่มใหม่ / ลบทิ้ง ทับแผนตั้งต้น', '<span class="chip due">แอปทีมช่าง</span>')}
        ${row('pm_weekly_done', 'ผลปิดงานรายสัปดาห์ · ใครทำ วันไหน หมายเหตุ', '<span class="chip due">แอปทีมช่าง</span>')}
        ${row('pm_weekly_skip', 'รอบที่ปิดใช้งาน + เหตุผล (ไม่นับทั้งตัวตั้งและตัวหาร)', '<span class="chip due">แอปทีมช่าง</span>')}
        ${row('— (ตารางของแอปนี้)', '<b>ลิสต์งานย่อยต่อเครื่อง</b> + ความถี่รายข้อ · ผูกกับรหัส w01–w30 ที่ดึงมา', '<span class="chip low">แอปนี้</span>')}
        ${row('— (ตารางของแอปนี้)', 'ผู้รับผิดชอบตั้งต้น (แอปทีมช่างมีแต่ “ใครทำ” หลังปิดงาน)', '<span class="chip low">แอปนี้</span>')}
        ${row('— (ตารางของแอปนี้)', 'งานเพิ่มเองนอกแผนประจำปี', '<span class="chip low">แอปนี้</span>')}
      </tbody>
    </table>
    <div class="infobox" style="margin:10px 14px 6px">
      แผนตั้งต้นไม่ได้อยู่บน Firebase — ของจริงฝังอยู่ในไฟล์ของแอปทีมช่าง จึง <b>คัดลอกมาเก็บในแอปนี้ครั้งเดียว</b>
      แล้วทับด้วย <code>pm_plan_overrides</code> ทุกครั้งที่ดึง · รายการที่เพิ่มใหม่หรือลบทีหลังมาทาง overrides อยู่แล้ว
    </div>
  </div>

  <div style="display:flex;flex-direction:column;gap:12px">
    <div class="card" style="padding:14px 16px">
      <h3 style="font-size:14px;margin-bottom:9px">🔒 สิ่งที่ทำที่แอปทีมช่างเท่านั้น</h3>
      <ul class="rolist">
        <li>ปิดงาน / ยกเลิกการปิดงาน</li>
        <li>แก้สัปดาห์ที่ต้องทำ · เพิ่ม / ลบรายการในแผน</li>
        <li>ปิดใช้งานรอบ (เครื่องยังไม่ติดตั้ง)</li>
      </ul>
      <div class="hint2">การ์ดทุกใบในหน้านี้มีปุ่มเด้งไปที่นั่นให้แล้ว</div>
    </div>
    <div class="card" style="padding:14px 16px">
      <h3 style="font-size:14px;margin-bottom:9px">✅ สิ่งที่แอปนี้ทำได้เอง</h3>
      <ul class="rolist">
        <li>ดูตารางทั้งปี · ปฏิทินเดือน · รายเครื่อง</li>
        <li>สรุปผล S-Curve และรายงานส่งออก</li>
        <li>ตั้ง “งานเพิ่มเอง” นอกแผนประจำปี</li>
        <li><b>แก้ลิสต์งานย่อยของแต่ละเครื่อง</b> + ผู้รับผิดชอบ</li>
      </ul>
      <div class="stat2">ดึงมาแล้ว <b>${totals.plan}</b> รอบ · ปิดแล้ว <b>${totals.done}</b> รอบ</div>
    </div>
    <div class="warnbox">
      ⚠️ ฐานข้อมูลของแอปทีมช่าง <b>เปิดให้อ่านสาธารณะ</b> — ใครมีลิงก์ก็ดึงได้โดยไม่ต้องล็อกอิน
      ควรตั้ง Rules ก่อนใช้งานยาว
    </div>
  </div>
</div>
</div>`, RO_CSS + `
table.tb code{font-size:11.5px;background:var(--surface-2);border-radius:6px;padding:1px 6px;color:var(--ink-soft)}
.rolist{list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12.8px;color:var(--ink-soft)}
.rolist li{padding-left:16px;position:relative;line-height:1.5}
.rolist li::before{content:'·';position:absolute;left:5px;color:var(--sep);font-weight:700}
.hint2{font-size:11.3px;color:var(--muted);margin-top:9px}
.stat2{font-size:12.3px;color:var(--ink-soft);margin-top:10px;padding-top:9px;border-top:1px solid var(--row-line)}
.stat2 b{font-family:var(--font-head);font-size:15px;color:var(--ink);font-variant-numeric:tabular-nums}
@media(max-width:980px){.sy2{grid-template-columns:1fr!important}}
`));

console.log('v3: การ์ดแผนอ่านอย่างเดียว', roCards, 'ใบ · การ์ดงานเพิ่มเองคงปุ่มไว้', adhocCards, 'ใบ · คงแถวงานย่อย', jrKept,
  '· ตัดปุ่มแก้รอบ', editBtn, '· ตัดปุ่มปิดงานมือถือ', bigBtns, '· แผน', totals.plan, 'รอบ ปิดแล้ว', totals.done);
