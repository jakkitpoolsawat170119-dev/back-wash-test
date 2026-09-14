import { readFileSync, writeFileSync } from 'node:fs';
import { ITEMS, status, weeksOfItem, CUR_WEEK as CUR, mondayOf, thDate } from './gen-views.mjs';

/* ══════════ v2: แถบสถิติหน้า "สัปดาห์นี้" ══════════
   ของเดิม 5 ช่องเท่ากันหมด แต่ 3 ช่องพูดเรื่องเดียวกัน (ต้องทำ 6 / ทำแล้ว 2 จาก 6 / ยังไม่ทำ 4)
   → เหลือแถบความคืบหน้า 1 แถบ + 2 ช่องที่เป็นคนละเรื่องจริง ๆ
   การ์ดงานด้านล่างยกมาทั้งดุ้น — อ่าน Main.dc.html แล้วสลับเฉพาะบล็อกนี้ จึงไม่มีทางเผลอแก้การ์ด */

const thisWeek = ITEMS.map((it, i) => ({ i, it, st: status(i, CUR) }))
  .filter(x => weeksOfItem(x.it).includes(CUR));
const doneCnt = thisWeek.filter(x => x.st === 'done').length;
const weekTotal = thisWeek.length + 1;            // +1 = งานเพิ่มเองของสัปดาห์นี้
const remain = weekTotal - doneCnt;
const pct = Math.round(doneCnt / weekTotal * 100);
const carry = ITEMS.reduce((a, it, i) =>
  a + weeksOfItem(it).filter(w => w < CUR && status(i, w) === 'over').length, 0);
const sun = mondayOf(CUR); sun.setUTCDate(sun.getUTCDate() + 6);

const BLOCK = `<div class="wkprog">
  <div class="wp-main">
    <div class="wp-top">
      <span class="wp-t">สัปดาห์ที่ ${CUR} · ทำแล้ว <b>${doneCnt}</b> จาก <b>${weekTotal}</b></span>
      <span class="wp-pct">${pct}%</span>
    </div>
    <div class="wp-bar"><span style="width:${pct}%"></span></div>
    <div class="wp-sub">เหลือ <b>${remain} รายการ</b> · ครบกำหนด อา. ${thDate(sun)}</div>
  </div>
  <div class="istat hot"><div class="l">⚠️ ค้างจากสัปดาห์ก่อน</div><div class="v">${carry}<span class="u">รายการ</span></div></div>
  <div class="istat"><div class="l">🚫 ปิดใช้งานรอบนี้</div><div class="v" style="color:var(--muted)">1</div></div>
</div>`;

const CSS2 = `
.wkprog{display:grid;gap:10px;grid-template-columns:minmax(300px,1fr) 210px 180px;margin:14px 0}
.wp-main{background:var(--card);border:1px solid var(--line);border-radius:16px;
  box-shadow:var(--shadow-card);padding:12px 16px 13px}
.wp-top{display:flex;align-items:baseline;gap:10px}
.wp-t{font-family:var(--font-head);font-size:15px;font-weight:600;color:var(--ink)}
.wp-t b{color:var(--brand-deep);font-variant-numeric:tabular-nums}
.wp-pct{margin-left:auto;font-family:var(--font-head);font-size:23px;font-weight:600;line-height:1;
  color:var(--brand-deep);font-variant-numeric:tabular-nums}
.wp-bar{height:10px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);
  overflow:hidden;margin:9px 0 6px}
.wp-bar span{display:block;height:100%;border-radius:999px;
  background:linear-gradient(90deg,var(--brand),var(--brand-deep))}
.wp-sub{font-size:12.3px;color:var(--ink-soft)}
.wp-sub b{color:var(--ink)}
@media(max-width:820px){.wkprog{grid-template-columns:1fr 1fr}.wp-main{grid-column:1/-1}}
`;

let s = readFileSync('Main.dc.html', 'utf8');
const i = s.indexOf('<div class="istats">');
const j = s.indexOf('</div>\n\n<div class="warnbox"', i);
if (i < 0 || j < 0) throw new Error('หาบล็อก istats ใน Main.dc.html ไม่เจอ — gen-views.mjs เปลี่ยนโครงหรือเปล่า');
s = s.slice(0, i) + BLOCK + s.slice(j + 6);
s = s.replace('</style>', CSS2 + '</style>');
writeFileSync('Main2.dc.html', s);
console.log('stats2: สัปดาห์', CUR, '· ทำแล้ว', doneCnt + '/' + weekTotal, '=', pct + '%',
  '· เหลือ', remain, '· ค้าง', carry, '· ครบกำหนด', thDate(sun));
