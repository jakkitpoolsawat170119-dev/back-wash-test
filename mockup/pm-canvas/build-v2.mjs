import { readFileSync, writeFileSync } from 'node:fs';
import { CSS } from './shared.mjs';

const src = (f) => readFileSync(f, 'utf8');
function parts(file) {
  const s = src(file);
  const style = s.slice(s.indexOf('<style>') + 7, s.indexOf('</style>'));
  const extra = style.replace(CSS, '').trim();
  let body = s.slice(s.indexOf('</helmet>') + 9, s.lastIndexOf('</x-dc>')).trim();
  const m = body.indexOf('<!--HEAD-END-->');
  // head() ถูกฝังอยู่ใน <div class="wrap"> — ตัดหัวออกแล้วต้องคืน div เปิดให้ด้วย
  if (m >= 0) body = '<div class="wrap">\n' + body.slice(m + 15).trim();
  return { body, extra };
}
// เติม prefix ให้ทุกกฎ CSS เพื่อไม่ให้คลาสชื่อซ้ำข้ามส่วนชนกัน
function scope(css, sel) {
  if (!css) return '';
  return css.replace(/(^|\})\s*([^{}@]+)\{/g, (all, close, selector) => {
    const list = selector.split(',').map(x => {
      const t = x.trim();
      if (!t) return t;
      return t === 'body' ? sel : `${sel} ${t}`;
    }).join(',');
    return `${close}\n${list}{`;
  });
}

const VIEWS = [
  ['v-week',    'Main2.dc.html'],
  ['v-year',    'YearGrid2.dc.html'],
  ['v-machine', 'ByMachine.dc.html'],
  ['v-month',   'MonthCalendar.dc.html'],
  ['v-adhoc',   'AdhocForm.dc.html'],
  ['v-sum',     'Summary2.dc.html'],
];
const SECTIONS = [
  ['s-planmanage', 'PlanManage2.dc.html',    '⚙️ จัดการแผน PM ประจำปี', 'ที่ที่กรอกแผนทั้งปีเข้าไป — ระบบออกงานให้เองตามสัปดาห์ที่ติ๊กไว้'],
  ['s-planedit',   'PlanEdit2.dc.html',      '✏️ แผ่นแก้ไขรายการในแผน', 'ใส่ลิสต์งานที่ต้องทำของเครื่องนั้น — เลือกจากทะเบียนหรือพิมพ์ชื่อใหม่ · ตั้งความถี่แยกรายข้อได้'],
  ['s-done',       'DoneSheet.dc.html',     '✅ แผ่นปิดงาน PM', 'วันที่ทำจริงแก้ได้ · รอบถัดไปเลือกวันเองได้'],
  ['s-perm',       'Permissions.dc.html',   '🔒 สิทธิ์หัวหน้างาน &amp; การปิดใช้งานรายรอบ', 'หน้าจอเดียวกัน เห็นไม่เหมือนกันตามบทบาท'],
  ['s-tg',         'TelegramCards.dc.html', '📮 การ์ดในกลุ่มช่าง (Telegram)', 'แจ้งเตือนล่วงหน้า · ถึงกำหนดวันนี้ · ปิดงานแล้ว'],
  ['s-am',         'AmToPm.dc.html',        '📋 ใบเช็ก AM → ตั้งเป็นงาน PM', 'ข้อที่ติ๊ก “ไม่ปกติ” เลือกปลายทางได้ 2 ทาง'],
];
const PHONES = [
  ['p-week', 'MobileWeek.dc.html', 'สัปดาห์นี้ (ตอนเน็ตหลุด)'],
  ['p-done', 'MobileDone.dc.html', 'ปิดงานเต็มจอ'],
  ['p-year', 'MobileYear.dc.html', 'ตารางทั้งปี — ทีละไตรมาส'],
  ['p-sum',  'MobileSummary.dc.html', 'สรุปผล'],
];

let extras = '';
const viewHtml = VIEWS.map(([id, f], i) => {
  const p = parts(f); extras += scope(p.extra, `#${id}`) + '\n';
  return `<section class="view${i === 0 ? ' on' : ''}" id="${id}">\n${p.body}\n</section>`;
}).join('\n\n');

const secHtml = SECTIONS.map(([id, f, title, sub]) => {
  const p = parts(f); extras += scope(p.extra, `#${id}`) + '\n';
  return `<section class="chunk" id="${id}">
  <div class="chead"><h2>${title}</h2><p>${sub}</p></div>
  <div class="cbody">${p.body}</div>
</section>`;
}).join('\n\n');

const phoneHtml = PHONES.map(([id, f, cap]) => {
  const p = parts(f); extras += scope(p.extra, `#${id}`) + '\n';
  return `<figure class="phonewrap"><div class="phone" id="${id}">${p.body}</div><figcaption>${cap}</figcaption></figure>`;
}).join('\n');

const CHROME = `
/* ── เปลือกของ mockup (ไม่ใช่ส่วนหนึ่งของหน้าจริง) ─────────── */
.ribbon{position:sticky;top:0;z-index:90;background:#1c1917;color:#f3ede6;padding:9px 16px;
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;font-weight:600;
  font-family:var(--font-head);box-shadow:0 8px 24px -12px rgba(0,0,0,.6)}
.ribbon b{color:var(--brand)}
.ribbon .tag{margin-left:auto;background:#312b23;color:#a89e92;border-radius:999px;padding:3px 10px;font-size:11px}
.atop{display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:8px;
  background:rgba(248,245,240,.92);border-bottom:1px solid var(--line);padding:10px 18px}
.atop .logo{margin-right:auto;display:flex;align-items:center;gap:8px}
.lg-mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(145deg,var(--brand),var(--brand-deep));
  display:grid;place-items:center;color:#fff;font-family:var(--font-head);font-weight:700;font-size:13px;
  box-shadow:0 2px 6px -1px rgba(194,79,0,.5)}
.lg-word{font-family:var(--font-head);font-weight:700;font-size:17px;letter-spacing:-.02em;color:var(--brand)}
.atop .search{flex:1;min-width:150px;max-width:340px;background:var(--card);border:1px solid var(--line);
  border-radius:10px;padding:7px 12px;font-size:13px;color:var(--muted)}
.achip{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;background:var(--card);
  border:1px solid var(--line);padding:4px 12px 4px 4px;border-radius:999px;white-space:nowrap}
.achip .av{width:24px;height:24px;border-radius:50%;background:var(--brand);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700}
.amain{display:flex;align-items:stretch}
.aside{width:230px;flex:none;border-right:1px solid var(--line);padding:16px 12px 40px;
  display:flex;flex-direction:column;gap:1px;background:var(--card)}
.ahead{font-family:var(--font-head);font-size:11.5px;font-weight:700;color:var(--muted);
  padding:14px 10px 5px;display:flex;align-items:center;gap:7px}
.rsbtn{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:none;background:transparent;
  color:var(--ink);font-size:13.5px;font-weight:600;padding:7px 10px;border-radius:10px;font-family:var(--font-head)}
.rsbtn.sub{font-size:13px;padding-left:16px;color:var(--ink-soft)}
.rsbtn.on{background:var(--brand-soft);color:var(--brand-deep)}
.acontent{flex:1;min-width:0}
.view{display:none}
.view.on{display:block}
.view > .wrap{padding-top:2px}
.pagehead{padding:22px 30px 0}
.tabjs{cursor:pointer}
.chunk{border-top:1px dashed var(--sep);margin-top:22px;padding:22px 30px 8px;max-width:1440px}
.chead{margin-bottom:14px}
.chead h2{font-family:var(--font-head);font-size:18px;font-weight:600;letter-spacing:-.02em}
.chead p{font-size:12.8px;color:var(--ink-soft);margin-top:2px}
.cbody > .wrap{padding:0}
#s-tg .side{max-width:320px}
.phones{display:flex;gap:26px;flex-wrap:wrap;padding:4px 0 10px}
.phonewrap{margin:0}
.phonewrap figcaption{font-family:var(--font-head);font-size:12.5px;font-weight:600;color:var(--ink-soft);
  text-align:center;margin-top:9px}
.phone{position:relative;width:390px;height:812px;overflow:hidden;border:9px solid #1c1917;border-radius:34px;
  background:var(--paper);box-shadow:var(--shadow-float)}
.phone .tabbar,.phone .bottombar{position:absolute!important;left:0!important;right:0!important;bottom:0!important}
.phone > .mw{height:100%;overflow-y:auto}
.foot{padding:22px 30px 40px;font-size:12.5px;color:var(--ink-soft);line-height:1.8;max-width:900px}
.foot h3{font-family:var(--font-head);font-size:15px;margin-bottom:6px}
.foot ol{padding-left:20px;display:flex;flex-direction:column;gap:5px}
@media(max-width:900px){
  .aside{display:none}
  .wrap,.pagehead,.chunk{padding-left:14px;padding-right:14px}
  .card:has(table.tb){overflow-x:auto}
  table.tb{min-width:600px}
  .ifilters .isel,.ifilters input,.ifilters select{min-width:0;max-width:100%}
  .phones{gap:16px;overflow-x:auto;padding-bottom:14px}
  #s-planedit .wgrid{grid-template-columns:repeat(7,1fr)!important}
  #s-perm div[style*="grid-template-columns:1fr 1fr"]{grid-template-columns:1fr!important}
  #v-month div[style*="grid-template-columns:1fr 330px"],
  #v-adhoc div[style*="grid-template-columns:1fr 330px"]{grid-template-columns:1fr!important}
  #s-tg .tglayout{grid-template-columns:1fr!important}
  #s-am .flow{grid-template-columns:1fr!important}
  #s-am .arrow{display:none}
  #s-am .step{margin-bottom:16px}
}
`;

const MENU = `
  <button class="rsbtn">📊 ภาพรวม</button>
  <button class="rsbtn">🕒 Timeline รับ-ส่งกะ</button>
  <button class="rsbtn">🏭 ลงยอดผลิต</button>
  <button class="rsbtn">✅ งานวันนี้</button>
  <button class="rsbtn">🧭 พื้นที่รับผิดชอบ</button>
  <button class="rsbtn">📅 ปฏิทิน</button>
  <button class="rsbtn">📈 รายงาน</button>
  <div class="ahead">🔧 งานซ่อมบำรุง</div>
  <button class="rsbtn sub">👷 กระดานทีมซ่อมบำรุง</button>
  <button class="rsbtn sub on">🗓 งาน PM</button>
  <button class="rsbtn sub">🔁 ทะเบียนงานรูทีน</button>
  <button class="rsbtn sub">⏱ เวลาเครื่องหยุด</button>
  <div class="ahead">📚 Knowledge management</div>
  <button class="rsbtn sub">⚙️ ทะเบียนเครื่องจักร</button>
  <button class="rsbtn sub">⚡ เหตุการณ์</button>`;

const HEADER = `<div class="pagehead">
  <div class="eyebrow">🔧 งานซ่อมบำรุง</div>
  <div class="phead">
    <h1>งาน PM</h1>
    <div class="sub">แผนบำรุงรักษาเชิงป้องกัน · ปีแผน 2026</div>
    <div class="sp"></div>
    <button class="ibtn">🔄 รีเฟรช</button>
  </div>
  <div class="itabs">
    <button class="itab on tabjs" data-tab="plan">📅 แผนประจำปี<span class="n">9</span></button>
    <button class="itab tabjs" data-tab="adhoc">📋 งานเพิ่มเอง<span class="n">4</span></button>
    <button class="itab tabjs" data-tab="sum">📈 สรุปผล</button>
  </div>
  <div class="ifilters" id="modes">
    <button class="ipill on brand tabjs" data-view="v-week">🗓️ สัปดาห์นี้</button>
    <button class="ipill tabjs" data-view="v-year">📊 ตารางทั้งปี</button>
    <button class="ipill tabjs" data-view="v-machine">🔩 ตามเครื่องจักร</button>
    <button class="ipill tabjs" data-view="v-month">📆 ปฏิทินเดือน</button>
    <div class="divider"></div>
    <a class="ibtn" href="#s-planmanage">⚙️ จัดการแผน PM</a>
  </div>
</div>`;

const JS = `
const views = {plan:['v-week','v-year','v-machine','v-month'], adhoc:['v-adhoc'], sum:['v-sum']};
function show(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('on', v.id===id));
  document.querySelectorAll('#modes .ipill').forEach(p=>p.classList.toggle('on', p.dataset.view===id));
  document.querySelectorAll('#modes .ipill').forEach(p=>p.classList.toggle('brand', p.dataset.view===id));
}
document.querySelectorAll('.itab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('.itab').forEach(x=>x.classList.toggle('on', x===t));
  const tab = t.dataset.tab;
  document.getElementById('modes').style.display = tab==='plan' ? '' : 'none';
  show(views[tab][0]);
}));
document.querySelectorAll('#modes .ipill').forEach(p=>p.addEventListener('click',()=>show(p.dataset.view)));
`;

const out = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mockup v2 — หน้า “งาน PM” (ลิสต์งานย่อย · ตารางทั้งปี · สรุปผล)</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;500;600;700&family=Sarabun:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${CSS}
${CHROME}
/* ── สไตล์เฉพาะของแต่ละส่วน (ตีกรอบด้วย id กันชนกัน) ─────── */
${extras}
/* แถบล่างของจอมือถือต้องอยู่ในกรอบโทรศัพท์ ไม่ใช่ลอยทับทั้งหน้า */
#p-week .tabbar,#p-done .bottombar{position:absolute}
</style>
</head>
<body>

<div class="ribbon">
  🎨 <b>MOCKUP</b> — หน้า “งาน PM” ออกแบบใหม่ · แผนประจำปี 52 สัปดาห์ + งานเพิ่มเอง
  <span class="tag">ยังไม่ต่อฐานข้อมูลจริง — ตัวเลขและชื่องานในหน้าเป็นตัวอย่าง</span>
</div>

<div class="atop">
  <div class="logo"><div class="lg-mark">S</div><div class="lg-word">SPP-MP</div></div>
  <div class="search">🔎 ค้นหา…</div>
  <div class="achip"><div class="av">J</div>จักรกฤษ</div>
</div>

<div class="amain">
  <aside class="aside">${MENU}</aside>
  <div class="acontent">
    ${HEADER}
    ${viewHtml}
  </div>
</div>

${secHtml}

<section class="chunk" id="s-mobile">
  <div class="chead"><h2>📱 บนมือถือหน้างาน (390px)</h2>
  <p>ปุ่มใหญ่กดด้วยนิ้วได้ · ติ๊กต่อได้ตอนเน็ตหลุด แล้วค่อยส่งขึ้นทีหลัง · ตาราง 52 ช่องยัดจอมือถือไม่ได้ จึงตัดเป็นไตรมาสละ 13 สัปดาห์</p></div>
  <div class="phones">${phoneHtml}</div>
</section>

<div class="foot">
  <h3>✅ เคาะแล้ว 10 ก.ย. — ขอบเขตตอนลงโค้ดจริง</h3>
  <ol>
    <li><b>เจ้าของแผน = แอป Netlify</b> (Firebase <code>spp-am</code>) — แอปหลักดึงมา <b>อ่านอย่างเดียวทางเดียว</b> แก้แผนต้องไปแก้ที่ Netlify</li>
    <li><b>แผนตั้งต้น 30 รายการ</b> คัดลอกมาฝังครั้งเดียว (ของจริง hardcode ในไฟล์ HTML ไม่ได้อยู่ใน Firebase) ·
        ที่แก้/เพิ่ม/ลบ → <code>pm_plan_overrides</code> · ผลปิดงาน → <code>pm_weekly_done</code> · ข้ามรอบ → <code>pm_weekly_skip</code></li>
    <li><b>ชื่อเครื่อง</b> ผูกกับทะเบียน <code>machines</code> เดิม + <b>ตารางชื่อพ้อง</b> — Netlify ใช้ “ไลน์ต้ม 1” แต่ทะเบียนใช้ “Line ต้ม 1”</li>
    <li><b>สิทธิ์หัวหน้างาน</b> ใช้ของเดิม <code>operators.role ≥ supervisor</code> ไม่สร้างระบบบทบาทใหม่</li>
    <li><b>ใบเช็ก AM ไม่เกี่ยวกับงาน PM</b> — ใบเช็ก AM เปิดใบแจ้งซ่อมต่อไปเหมือนเดิม</li>
    <li><b>แจ้งเตือนเข้ากลุ่มช่าง</b> — ข้ามไปก่อน ยังไม่เคาะ (ตัวตั้งเวลามีพร้อมอยู่แล้วที่ <code>/api/report/tick</code>)</li>
  </ol>
  <h3 style="margin-top:14px">✏️ ส่วนที่เป็นภาพร่างเฉย ๆ — ยังไม่ลงโค้ดรอบนี้</h3>
  <ol>
    <li>⚙️ จัดการแผน PM ประจำปี · ✏️ แผ่นแก้ไขรายการ (รวมลิสต์งานย่อยต่อเครื่อง) — เพราะแก้แผนที่ Netlify ที่เดียว</li>
    <li>📋 ใบเช็ก AM → ตั้งเป็นงาน PM</li>
  </ol>
  <h3 style="margin-top:14px">⚠️ ข้อควรระวัง</h3>
  <ol>
    <li>Firebase <code>spp-am</code> <b>เปิดอ่านสาธารณะ</b> — ใครมี URL ก็ดึงข้อมูลได้ทั้งหมดโดยไม่ต้องล็อกอิน (ดีกับการ sync แต่ควรไปดู Rules)</li>
  </ol>
</div>

<script>${JS}</script>
</body>
</html>
`;
writeFileSync('../pm-redesign-v2.html', out);
console.log('wrote ../pm-redesign-v2.html', (out.length/1024).toFixed(0)+'KB');
