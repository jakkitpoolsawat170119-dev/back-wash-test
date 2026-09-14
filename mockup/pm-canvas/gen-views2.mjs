import { writeFileSync } from 'node:fs';
import { page, head } from './shared.mjs';
import { ITEMS, status, weeksOfItem, CUR_WEEK as CUR, mondayOf, thDate, thDateY } from './gen-views.mjs';

/* ══════════ 3. ตามเครื่องจักร ══════════ */
/* ทุกตัวเลขในตารางนี้คำนวณจากข้อมูลชุดเดียวกับตารางทั้งปีและหน้าสรุปผล */
const IC = { 'ไลน์ไอซิ่ง':'🧊','ไลน์ต้ม 1':'🍯','ไลน์ต้ม 2':'🍯','ไลน์ L1':'📦','ไลน์ L2':'📦',
  'Robot Clear Packer':'🤖','AHU & Chiller':'❄️','Cold Room':'❄️','RO 10,000':'💧','RO 5,000':'💧',
  'บ่อซีเมนต์':'🕳','ถุง AHU':'🌬','ไลน์ปี๊บ':'🫙' };
const M = ITEMS.map((it, i) => {
  const ws = weeksOfItem(it);
  let done = 0, over = 0, plan = 0, lastW = null;
  ws.forEach(w => {
    const st = status(i, w);
    if (st === 'skip') return;
    plan++;
    if (st === 'done') { done++; if (w <= CUR) lastW = w; }
    if (st === 'over') over++;
  });
  const nextW = ws.find(w => w >= CUR && status(i, w) !== 'skip' && status(i, w) !== 'done');
  const dueNow = ws.includes(CUR) && status(i, CUR) === 'due';
  return {
    ic: IC[it.name] || '🔩', n: it.name, f: it.freq,
    last: lastW ? thDateY(mondayOf(lastW)) : '—',
    next: nextW === undefined ? 'ครบทุกรอบของปีแล้ว'
        : nextW === CUR ? `W${CUR} · สัปดาห์นี้` : `W${nextW} · ${thDate(mondayOf(nextW))}`,
    nx: over > 0 ? 'late' : nextW === CUR ? 'due' : 'ok',
    dueNow, late: over, plan, done, pct: Math.round(done / (done + over) * 100),
  };
});
M.sort((a, b) => (b.late - a.late) || (a.pct - b.pct));
M.push({ ic:'🌀', n:'ไลน์ A3', f:'ทุก 2 สัปดาห์', last:'—', next:`W${CUR} · ปิดใช้งาน`, nx:'skip',
  dueNow:false, late:0, plan:0, done:0, pct:0 });
const totLate = M.filter(m => m.late > 0).length;
const totDue = M.filter(m => m.dueNow).length;
const totDone = M.reduce((a,m)=>a+m.done,0), totOver = M.reduce((a,m)=>a+m.late,0);
const totPct = Math.round(totDone / (totDone + totOver) * 100);

const nextChip = { due:'chip due', late:'chip stop', ok:'chip mute', skip:'chip mute' };
const bar = (p, tone) => `<div class="bar"><span style="width:${p}%;background:${tone}"></span></div>`;
const mrow = (m) => {
  const tone = m.pct>=95?'var(--ok)':m.pct>=80?'var(--warn)':'var(--danger)';
  return `<tr>
  <td><div class="mn"><span class="mic">${m.ic}</span><div><div class="t">${m.n}</div>
    <div class="s">${m.f}${m.nx==='skip'?' · 🚫 ปิดใช้งานอยู่':''}</div></div></div></td>
  <td style="color:var(--ink-soft)">${m.last}</td>
  <td><span class="${nextChip[m.nx]}">${m.next}</span></td>
  <td class="num">${m.late?`<span style="color:var(--danger);font-weight:700">${m.late}</span>`:'<span style="color:var(--muted)">—</span>'}</td>
  <td style="width:190px">${m.plan?`${bar(m.pct,tone)}<div class="bl">${m.done}/${m.done+m.late} รอบที่ถึงกำหนด · <b style="color:${tone}">${m.pct}%</b></div>`:'<div class="bl" style="color:var(--muted)">ยังไม่นับในแผน</div>'}</td>
  <td style="text-align:right;white-space:nowrap">
    <button class="ibtn sm">📋 ดูงาน</button>
    <button class="ibtn sm">✏️ แก้รอบ</button>
  </td>
</tr>`;
};

writeFileSync('ByMachine.dc.html', page(`<div class="wrap">
${head('plan','machine')}
<div class="istats" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
  <div class="istat"><div class="l">🔩 เครื่อง / พื้นที่ในแผน</div><div class="v">${M.length}</div></div>
  <div class="istat hot"><div class="l">⚠️ มีงานเกินกำหนด</div><div class="v">${totLate}</div></div>
  <div class="istat"><div class="l">🗓️ ครบกำหนดสัปดาห์นี้</div><div class="v" style="color:var(--brand-deep)">${totDue}</div></div>
  <div class="istat good"><div class="l">📈 ทำได้ตามแผน (ทั้งปี)</div><div class="v">${totPct}<span class="u">%</span></div></div>
</div>
<div class="card" style="padding:4px 4px 8px">
  <div style="display:flex;align-items:center;gap:10px;padding:12px 14px 6px;flex-wrap:wrap">
    <h3 style="font-size:15px">แผน PM รายเครื่อง / พื้นที่</h3>
    <span class="chip mute">เรียงตามงานที่ค้างก่อน</span>
    <div class="sp"></div>
    <select class="isel"><option>ทุกความถี่</option></select>
    <button class="ibtn">📊 Export Excel</button>
  </div>
  <table class="tb">
    <thead><tr>
      <th>เครื่อง / พื้นที่</th><th>PM ล่าสุด</th><th>ครบกำหนดถัดไป</th>
      <th style="text-align:right">ค้าง</th><th>ทำได้ตามแผน (ปี 2026)</th><th></th>
    </tr></thead>
    <tbody>${M.map(mrow).join('\n')}</tbody>
  </table>
</div>
<div class="infobox" style="margin-top:12px">
  <b>ช่อง “PM ล่าสุด”</b> ขยับเองทุกครั้งที่ปิดงาน PM (ที่ไหนก็ได้ — เว็บ ตารางทั้งปี หรือกลุ่ม Telegram)
  เหมือนที่ทะเบียนเครื่องจักรทำอยู่แล้ววันนี้
</div>
</div>`, `
.mn{display:flex;align-items:center;gap:10px}
.mic{width:30px;height:30px;border-radius:9px;background:var(--surface-2);border:1px solid var(--line);
  display:grid;place-items:center;font-size:15px}
.mn .t{font-family:var(--font-head);font-size:13.5px;font-weight:600;line-height:1.35}
.mn .s{font-size:11.3px;color:var(--muted);line-height:1.4}
.bar{height:7px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden}
.bar span{display:block;height:100%;border-radius:999px}
.bl{font-size:11px;color:var(--ink-soft);margin-top:3px;font-variant-numeric:tabular-nums}
`));

/* ══════════ 4. ปฏิทินเดือน ══════════ */
const DUE = {
  1:[['ไลน์ไอซิ่ง','done'],['บ่อซีเมนต์','done']],
  2:[['RO 5,000','over']],
  3:[['ไลน์ต้ม 1','done'],['AHU & Chiller','done']],
  5:[['ไลน์ L2','over']],
  8:[['AHU & Chiller','done'],['Cold Room','done']],
  9:[['ไลน์ไอซิ่ง','done'],['ไลน์ต้ม 1','due'],['Robot Clear Packer','due'],['บ่อซีเมนต์','due']],
  11:[['ไลน์ L4 (งานเพิ่มเอง)','due']],
  15:[['ไลน์ L1','future'],['Robot Clear Packer','future']],
  17:[['ไลน์ A3','skip']],
  22:[['ไลน์ไอซิ่ง','future'],['Cold Room','future'],['ไลน์ปี๊บ','future']],
  24:[['ไลน์ L2','future']],
  29:[['ไลน์ต้ม 2','future'],['RO 5,000','future']],
};
const TONE = { done:'var(--ok)', over:'var(--danger)', due:'var(--brand)', future:'var(--sep)', skip:'var(--muted)' };
const WKN = { 0:36, 1:37, 2:38, 3:39, 4:40 };
// ก.ย. 2026 เริ่มวันอังคาร → ช่องว่าง 1 ช่อง (จันทร์)
const cells = [];
cells.push('<div class="dc off"></div>');
for (let d=1; d<=30; d++) cells.push(d);
while (cells.length % 7) cells.push('<div class="dc off"></div>');
let html = '', idx = 0;
for (let r=0; r<cells.length/7; r++) {
  html += `<div class="wkn">W${WKN[r]}</div>`;
  for (let c=0; c<7; c++) {
    const v = cells[idx++];
    if (typeof v === 'string') { html += v; continue; }
    const list = DUE[v] || [];
    const today = v === 9;
    html += `<div class="dc${today?' today':''}">
      <div class="dn">${v}${today?'<span class="tdy">วันนี้</span>':''}</div>
      ${list.slice(0,3).map(([n,s])=>`<div class="ev"><i style="background:${TONE[s]}${s==='future'?';border:1px solid var(--sep)':''}"></i><span${s==='done'?' style="color:var(--muted);text-decoration:line-through"':''}>${n}</span></div>`).join('')}
      ${list.length>3?`<div class="more">+${list.length-3} รายการ</div>`:''}
    </div>`;
  }
}

writeFileSync('MonthCalendar.dc.html', page(`<div class="wrap">
${head('plan','month')}
<div style="display:grid;grid-template-columns:1fr 330px;gap:14px;align-items:start">
  <div class="card" style="padding:14px 16px 16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <button class="ibtn" style="padding:6px 12px">‹</button>
      <h3 style="font-size:16px">กันยายน 2026</h3>
      <button class="ibtn" style="padding:6px 12px">›</button>
      <button class="ibtn">วันนี้</button>
      <div class="sp"></div>
      <span class="chip mute">W36 – W40</span>
    </div>
    <div class="cal">
      <div class="wkh"></div>
      ${['จ','อ','พ','พฤ','ศ','ส','อา'].map(d=>`<div class="dh">${d}</div>`).join('')}
      ${html}
    </div>
    <div class="legend">
      <span><i style="background:var(--ok)"></i>ทำแล้ว</span>
      <span><i style="background:var(--brand)"></i>ครบกำหนด</span>
      <span><i style="background:var(--danger)"></i>เลยกำหนด</span>
      <span><i style="background:transparent;border:1px solid var(--sep)"></i>ยังไม่ถึงกำหนด</span>
      <span><i style="background:var(--muted)"></i>ปิดใช้งาน</span>
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:12px">
    <div class="card" style="padding:14px 16px">
      <h3 class="hd">📆 เดือนนี้</h3>
      <div class="istats" style="grid-template-columns:1fr 1fr;margin:0">
        <div class="istat" style="box-shadow:none"><div class="l">ทั้งเดือน</div><div class="v" style="font-size:22px">21</div></div>
        <div class="istat good" style="box-shadow:none"><div class="l">ทำแล้ว</div><div class="v" style="font-size:22px">9</div></div>
        <div class="istat gap" style="box-shadow:none"><div class="l">ยังไม่ทำ</div><div class="v" style="font-size:22px">10</div></div>
        <div class="istat hot" style="box-shadow:none"><div class="l">เลยกำหนด</div><div class="v" style="font-size:22px">2</div></div>
      </div>
    </div>
    <div class="card" style="padding:14px 16px">
      <h3 class="hd">⚠️ ต้องสนใจก่อน</h3>
      <div style="display:flex;flex-direction:column;gap:9px">
        <div class="mini"><span class="chip stop">เกิน 6 วัน</span><div><b>RO 5,000</b><div class="s">ล้างไส้กรอง Pre-filter · W36</div></div></div>
        <div class="mini"><span class="chip stop">เกิน 4 วัน</span><div><b>ไลน์ L2</b><div class="s">เปลี่ยนลูกยางหัวซีล · W36</div></div></div>
        <div class="mini"><span class="chip warn">ยังไม่มีคนรับ</span><div><b>บ่อซีเมนต์</b><div class="s">ตรวจปั๊มสูบ · W37</div></div></div>
      </div>
    </div>
    <div class="card" style="padding:14px 16px">
      <h3 class="hd">🖨 ส่งออก</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="ibtn">📊 Export Excel</button>
        <button class="ibtn">📸 ภาพ 16:9</button>
      </div>
      <div class="infobox" style="margin-top:10px">ปฏิทินเดือนใช้ดูภาระงานว่าวันไหนกระจุก — ตัวแผนจริงยังยึด <b>เลขสัปดาห์</b> เป็นหลัก</div>
    </div>
  </div>
</div>
</div>`, `
.cal{display:grid;grid-template-columns:44px repeat(7,1fr);gap:6px}
.dh{font-family:var(--font-head);font-size:11.5px;font-weight:600;color:var(--ink-soft);text-align:center;padding:2px 0 4px}
.wkn{font-size:10.5px;font-weight:700;color:var(--muted);display:grid;place-items:center;
  background:var(--surface-2);border:1px solid var(--line);border-radius:9px}
.dc{min-height:96px;border:1px solid var(--line);border-radius:11px;background:var(--card);padding:6px 7px}
.dc.off{background:transparent;border:none}
.dc.today{border-color:var(--brand);background:var(--brand-soft);box-shadow:var(--shadow-card)}
.dn{font-family:var(--font-head);font-size:12.5px;font-weight:600;color:var(--ink-soft);display:flex;align-items:center;gap:5px;margin-bottom:3px}
.tdy{font-size:9.5px;font-weight:700;color:#fff;background:var(--brand);border-radius:999px;padding:1px 7px;font-family:var(--font-body)}
.ev{font-size:10.5px;line-height:1.45;color:var(--ink);display:flex;align-items:flex-start;gap:4px;margin-bottom:2px}
.ev i{width:7px;height:7px;border-radius:50%;flex:0 0 7px;margin-top:4px}
.more{font-size:10px;color:var(--muted);font-weight:600}
.mini{display:flex;gap:9px;align-items:flex-start;font-size:12.5px}
.mini .s{font-size:11.3px;color:var(--ink-soft)}
`));
