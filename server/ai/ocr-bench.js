// วัดผล "อ่านเอกสารไทยจากรูป" เทียบข้ามรุ่น — จุดเสี่ยงสุดของการย้ายเจ้า
//
//   node ai/ocr-bench.js                          ← ใช้เอกสารสังเคราะห์ (มีเฉลยในตัว)
//   node ai/ocr-bench.js รูป1.jpg รูป2.jpg          ← ใช้รูปจริง (ไม่มีเฉลย = ดูด้วยตา)
//   MODELS=moonshotai/kimi-k3,moonshotai/kimi-k2.6 node ai/ocr-bench.js
//
// ⚠️ เอกสารสังเคราะห์เป็นตัวพิมพ์คมกริบ = โจทย์ง่ายกว่ารูปถ่ายลายมือมาก
//    ผ่านตรงนี้ไม่ได้แปลว่าผ่านของจริง — แต่ถ้าตกตรงนี้ ของจริงไม่ต้องลอง
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_FILES = fs.readdirSync(FONT_DIR).filter(f => f.endsWith('.ttf')).map(f => path.join(FONT_DIR, f));
// ำ (U+0E33) ต้องแตกเป็น นิคหิต+สระอา ก่อนเสมอ ไม่งั้น resvg วางตัวถัดไปทับจนอ่านไม่ออก
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ำ/g, 'ํา');

// เฉลย — จงใจใส่คำที่มีสระบน/ล่าง/วรรณยุกต์เยอะ ซึ่งเป็นจุดที่โมเดลอ่านพลาดบ่อยที่สุด
const TRUTH = [
  { seq: 1, title: 'ตรวจสอบปั๊มน้ำดิบ',        goal: 'ไม่มีเสียงดังผิดปกติ',      method: 'ฟังเสียงและจับอุณหภูมิ' },
  { seq: 2, title: 'ตรวจท่อน้ำดีรั่วซึม',       goal: 'ไม่มีน้ำหยดที่ข้อต่อ',      method: 'ดูด้วยตาและใช้มือลูบ' },
  { seq: 3, title: 'เช็คระดับน้ำตาลในถังผสม',   goal: 'อยู่ระหว่าง 60-80%',        method: 'อ่านจากเกจวัด' },
  { seq: 4, title: 'ตรวจสายพานลำเลียง',        goal: 'ไม่หย่อนและไม่มีรอยฉีก',    method: 'กดทดสอบความตึง' },
  { seq: 5, title: 'ทำความสะอาดหัวฉีดล้าง',     goal: 'ไม่มีคราบตะกรันอุดตัน',     method: 'ถอดล้างด้วยน้ำอุ่น' },
  { seq: 6, title: 'ตรวจมอเตอร์เครื่องบรรจุ',   goal: 'อุณหภูมิไม่เกิน 70 องศา',   method: 'ใช้เทอร์โมมิเตอร์อินฟราเรด' },
];
const GROUP = 'Line ต้ม 1';

function renderSheet() {
  const W = 1240, RH = 74, TOP = 150;
  const col = [40, 110, 470, 830];
  const head = ['ลำดับ', 'หัวข้อการตรวจสอบ', 'มาตรฐานการตรวจสอบ', 'วิธีการตรวจสอบ'];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TOP + RH * (TRUTH.length + 1) + 40}">`
    + `<rect width="100%" height="100%" fill="#ffffff"/>`
    + `<text x="40" y="60" font-family="Sarabun" font-size="34" font-weight="700" fill="#111">เช็คลิสต์ตรวจสอบประจำวัน — ${esc(GROUP)}</text>`
    + `<text x="40" y="100" font-family="Sarabun" font-size="22" fill="#444">ประจำเดือน กันยายน 2569</text>`;
  const row = (cells, y, bold, bg) => {
    let s = bg ? `<rect x="30" y="${y - RH + 20}" width="${W - 60}" height="${RH}" fill="${bg}"/>` : '';
    cells.forEach((c, i) => {
      s += `<text x="${col[i]}" y="${y}" font-family="Sarabun" font-size="24" font-weight="${bold ? 700 : 400}" fill="#111" xml:space="preserve">${esc(c)}</text>`;
    });
    return s;
  };
  svg += row(head, TOP, true, '#e8eef2');
  TRUTH.forEach((r, i) => {
    const y = TOP + RH * (i + 1);
    svg += `<line x1="30" y1="${y - RH + 20}" x2="${W - 30}" y2="${y - RH + 20}" stroke="#c8d2d8"/>`;
    svg += row([String(r.seq), r.title, r.goal, r.method], y, false, null);
  });
  svg += `<rect x="30" y="${TOP - RH + 20}" width="${W - 60}" height="${RH * (TRUTH.length + 1)}" fill="none" stroke="#8fa0aa" stroke-width="2"/>`;
  svg += '</svg>';
  return new Resvg(svg, { font: { fontFiles: FONT_FILES, defaultFontFamily: 'Sarabun', loadSystemFonts: false } })
    .render().asPng();
}

// เทียบแบบ "ตรงทุกตัวอักษร" — ใกล้เคียงไม่นับ เพราะสระหาย 1 ตัวก็คนละคำแล้ว
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
function score(rows) {
  let exact = 0, near = 0;
  const misses = [];
  for (const t of TRUTH) {
    const got = rows.find(r => Number(r.seq) === t.seq) || rows[t.seq - 1] || {};
    for (const f of ['title', 'goal', 'method']) {
      const a = norm(t[f]), b = norm(got[f]);
      if (a === b) exact++;
      else { near++; misses.push(`ข้อ ${t.seq} ${f}:  ต้องได้ "${a}"   แต่ได้ "${b}"`); }
    }
  }
  return { exact, total: TRUTH.length * 3, misses };
}

(async () => {
  const args = process.argv.slice(2);
  const models = (process.env.MODELS || 'moonshotai/kimi-k3,moonshotai/kimi-k2.6').split(',').map(s => s.trim());
  let imgs, synthetic = false;
  if (args.length) {
    imgs = args.map(p => ({ media_type: /\.png$/i.test(p) ? 'image/png' : 'image/jpeg', data: fs.readFileSync(p).toString('base64') }));
    console.log(`▶ ใช้รูปจริง ${imgs.length} ใบ (ไม่มีเฉลย — ต้องดูผลด้วยตา)\n`);
  } else {
    synthetic = true;
    const png = renderSheet();
    const out = path.join(require('os').tmpdir(), 'ocr-bench-sheet.png');
    fs.writeFileSync(out, png);
    imgs = [{ media_type: 'image/png', data: png.toString('base64') }];
    console.log(`▶ เอกสารสังเคราะห์ ${TRUTH.length} แถว (${TRUTH.length * 3} ช่องที่ต้องอ่านให้ตรงทุกตัวอักษร)`);
    console.log(`  รูปที่ใช้: ${out}\n`);
  }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  delete process.env.VAULT_GITHUB_TOKEN; delete process.env.N8N_WEBHOOK_URL;
  delete process.env.SPP_BOT_TOKEN; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.MAINT_BOT_TOKEN;
  const m = require('../index.js');
  await m.initDb();
  const srv = m.app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  for (const model of models) {
    process.env.AI_ROUTINE_MODEL = model;
    const t0 = Date.now();
    const res = await fetch(base + '/api/routine/read-sheet', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: imgs }), signal: AbortSignal.timeout(600000),
    });
    const j = await res.json();
    console.log('── ' + model + '   (' + res.status + ', ' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
    if (res.status !== 200) { console.log('   ❌ ' + j.error + '\n'); continue; }
    const rows = j.rows || [];
    console.log('   อ่านได้ ' + rows.length + ' แถว' + (synthetic ? ' (ควรได้ ' + TRUTH.length + ')' : ''));
    if (!synthetic) { rows.forEach(r => console.log('   ' + r.seq + '. ' + r.title + ' | ' + r.goal + ' | ' + r.method + (r.unclear ? '  ⚠️อ่านไม่ชัด' : ''))); console.log(); continue; }
    const s = score(rows);
    const pct = Math.round(s.exact / s.total * 100);
    console.log('   ตรงทุกตัวอักษร ' + s.exact + '/' + s.total + '  (' + pct + '%)' + (pct === 100 ? '  ✅' : ''));
    s.misses.forEach(x => console.log('     ❌ ' + x));
    console.log();
  }
  srv.close(); process.exit(0);
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
