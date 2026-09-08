// ═══════════════════════════════════════════════════════════════════════════
// shiftCard.js — เรนเดอร์ "การ์ดสรุปสิ้นกะ" เป็นรูป PNG (โทนเข้ม) ด้วย SVG → resvg
// ใช้กับวิเคราะห์สิ้นกะอัตโนมัติ: Claude คืน JSON โครงสร้าง → เราวาดการ์ดเอง (คุมหน้าตา+เลี่ยง OCR/มั่ว)
// ไม่พึ่ง emoji (resvg render emoji สีไม่ได้) — วาดไอคอนเป็นเวกเตอร์
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch { /* lib ไม่พร้อม → ผู้เรียกจะ fallback เป็นข้อความ */ }

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const FONT_FILES = ['Sarabun-Regular.ttf', 'Sarabun-Bold.ttf', 'Sarabun-Medium.ttf', 'Sarabun-SemiBold.ttf', 'Sarabun-ExtraBold.ttf']
  .map((f) => path.join(FONT_DIR, f)).filter((f) => fs.existsSync(f));

const canRenderCard = () => !!Resvg && FONT_FILES.length > 0;

// ── palette (dark) ──────────────────────────────────────────────────────────
const C = {
  bg: '#0f1519', surf: '#161e24', surf2: '#1c262d', line: '#28343b',
  ink: '#eaf0f3', dim: '#93a2ab', accent: '#37c2d0',
  good: '#39b57e', warn: '#eea23a', crit: '#ec5f5c',
};
const SEV = { good: C.good, warn: C.warn, crit: C.crit, mute: C.dim };
// สีประจำไลน์สำหรับโดนัท (categorical) — ผ่าน validate CVD ของ dataviz (blue→orange→violet→aqua…) เลี่ยงชนสีสถานะ
const LINE_COLORS = ['#3987e5', '#d95926', '#9085e9', '#199e70', '#d55181', '#c98500'];
const LINE_MORE = '#5a6b74';
const FONT = 'Sarabun';
const W = 452;      // ความกว้าง logical (px) — เรนเดอร์ 2x เป็น 904px
const PX = 20;      // padding ซ้าย/ขวา

// ── helpers ─────────────────────────────────────────────────────────────────
/* ⚠️ ำ (U+0E33) ต้องแตกเป็น นิคหิต+สระอา (U+0E4D U+0E32) ก่อนเสมอ
   resvg + Sarabun shape ำ ผิด: ตัวที่อยู่ถัดไปจะถูกวางทับจนอ่านไม่ออก
   ("ปั๊มน้ำดิบ" → ด ทับ ำ) เป็นทั้งกลางคำและข้ามคำ ไม่ใช่แค่ตรงตัวคั่น
   รูปแบบแตกร่างเรนเดอร์ถูกต้อง 100% และกินความกว้างเท่าเดิม (นิคหิต=สระบน ไม่กินที่)
   → measure()/wrap() ที่วัดจากสตริงต้นฉบับยังตรงอยู่ ไม่ต้องแก้ตาม            */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/\u0E33/g, '\u0E4D\u0E32');

// ประมาณความกว้างตัวอักษร (ไทย+ละติน) เพื่อ wrap เอง — SVG <text> ไม่ตัดบรรทัดให้
function charW(ch, size) {
  const c = ch.codePointAt(0);
  // า (0E32) และ ำ (0E33) อยู่ในช่วงสระบน/ล่างก็จริง แต่กินความกว้างเต็มตัว — ต้องแยกออกมาก่อน
  // ไม่งั้น measure/wrap จะคิดความกว้างขาด ทำให้ข้อความยาวเกินกรอบ
  if (c === 0x0e32 || c === 0x0e33) return 0.57 * size;
  if ((c >= 0x0e31 && c <= 0x0e3a) || (c >= 0x0e47 && c <= 0x0e4e)) return 0; // สระบน/ล่าง + วรรณยุกต์ = ไม่กินความกว้าง
  if (c >= 0x0e00 && c <= 0x0e7f) return 0.57 * size; // อักษรไทยฐาน
  if (ch === ' ') return 0.28 * size;
  if ('iIl.,:;\'|!ￂ·'.includes(ch)) return 0.3 * size;
  if ('mwMW'.includes(ch)) return 0.86 * size;
  if (/[A-Z]/.test(ch)) return 0.66 * size;
  if (/[0-9]/.test(ch)) return 0.56 * size;
  return 0.52 * size;
}
function measure(str, size) {
  let w = 0;
  for (const ch of String(str)) w += charW(ch, size);
  return w;
}
// wrap เป็นหลายบรรทัดตามความกว้าง maxW (ตัดที่ช่องว่างถ้ามี ไม่งั้นตัดตามตัวอักษร)
function wrap(str, maxW, size) {
  const out = [];
  let line = '';
  const flush = () => { if (line) { out.push(line); line = ''; } };
  for (const ch of String(str)) {
    const cand = line + ch;
    if (measure(cand, size) > maxW && line) {
      const sp = line.lastIndexOf(' ');
      if (sp > 0 && measure(line.slice(sp + 1) + ch, size) < maxW) {
        out.push(line.slice(0, sp));
        line = line.slice(sp + 1) + ch;
      } else { out.push(line); line = ch; }
    } else { line = cand; }
  }
  flush();
  return out.length ? out : [''];
}

function text(x, y, size, weight, fill, str, anchor = 'start') {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" xml:space="preserve">${esc(str)}</text>`;
}

// ── ไอคอนเวกเตอร์เล็กๆ (แทน emoji) — วาดในกรอบ size×size ที่มุมซ้ายบน (x,y) ──
function icon(name, x, y, s, color) {
  const g = (inner) => `<g transform="translate(${x} ${y})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  switch (name) {
    case 'flag': { // ธงตราหมากรุก (สิ้นกะ)
      const sq = s / 6, cells = [];
      for (let r = 0; r < 3; r++) for (let cc = 0; cc < 4; cc++) if ((r + cc) % 2 === 0) cells.push(`<rect x="${s * 0.28 + cc * sq}" y="${s * 0.12 + r * sq}" width="${sq}" height="${sq}" fill="${color}" stroke="none"/>`);
      return `<g transform="translate(${x} ${y})"><line x1="${s * 0.24}" y1="${s * 0.08}" x2="${s * 0.24}" y2="${s * 0.94}" stroke="${color}" stroke-width="1.7" stroke-linecap="round"/><rect x="${s * 0.28}" y="${s * 0.12}" width="${sq * 4}" height="${sq * 3}" fill="none" stroke="${color}" stroke-width="1.2"/>${cells.join('')}</g>`;
    }
    case 'box': return g(`<path d="M${s * 0.5} ${s * 0.1} L${s * 0.88} ${s * 0.3} V${s * 0.7} L${s * 0.5} ${s * 0.9} L${s * 0.12} ${s * 0.7} V${s * 0.3} Z"/><path d="M${s * 0.12} ${s * 0.3} L${s * 0.5} ${s * 0.5} L${s * 0.88} ${s * 0.3}"/><line x1="${s * 0.5}" y1="${s * 0.5}" x2="${s * 0.5}" y2="${s * 0.9}"/>`);
    case 'drop': return `<g transform="translate(${x} ${y})"><path d="M${s * 0.5} ${s * 0.12} C${s * 0.5} ${s * 0.12} ${s * 0.82} ${s * 0.5} ${s * 0.82} ${s * 0.66} A${s * 0.32} ${s * 0.32} 0 1 1 ${s * 0.18} ${s * 0.66} C${s * 0.18} ${s * 0.5} ${s * 0.5} ${s * 0.12} ${s * 0.5} ${s * 0.12} Z" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></g>`;
    case 'clip': return g(`<rect x="${s * 0.2}" y="${s * 0.16}" width="${s * 0.6}" height="${s * 0.72}" rx="${s * 0.08}"/><rect x="${s * 0.36}" y="${s * 0.1}" width="${s * 0.28}" height="${s * 0.14}" rx="${s * 0.04}" fill="${color}" stroke="none"/><line x1="${s * 0.34}" y1="${s * 0.46}" x2="${s * 0.66}" y2="${s * 0.46}"/><line x1="${s * 0.34}" y1="${s * 0.64}" x2="${s * 0.66}" y2="${s * 0.64}"/>`);
    case 'warn': return `<g transform="translate(${x} ${y})"><path d="M${s * 0.5} ${s * 0.12} L${s * 0.92} ${s * 0.84} L${s * 0.08} ${s * 0.84} Z" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/><line x1="${s * 0.5}" y1="${s * 0.4}" x2="${s * 0.5}" y2="${s * 0.62}" stroke="${color}" stroke-width="1.7" stroke-linecap="round"/><circle cx="${s * 0.5}" cy="${s * 0.73}" r="0.9" fill="${color}" stroke="${color}"/></g>`;
    case 'spark': return `<g transform="translate(${x} ${y})"><path d="M${s * 0.5} ${s * 0.1} L${s * 0.58} ${s * 0.42} L${s * 0.9} ${s * 0.5} L${s * 0.58} ${s * 0.58} L${s * 0.5} ${s * 0.9} L${s * 0.42} ${s * 0.58} L${s * 0.1} ${s * 0.5} L${s * 0.42} ${s * 0.42} Z" fill="${color}" stroke="none"/></g>`;
    case 'wrench': return g(`<path d="M${s * 0.263} ${s * 0.136} A${s * 0.18} ${s * 0.18} 0 1 1 ${s * 0.136} ${s * 0.263}"/><line x1="${s * 0.44}" y1="${s * 0.44}" x2="${s * 0.86}" y2="${s * 0.86}"/>`);
    case 'repeat': return g(`<path d="M${s * 0.14} ${s * 0.5} A${s * 0.36} ${s * 0.36} 0 0 1 ${s * 0.86} ${s * 0.5}"/><polyline points="${s * 0.7},${s * 0.42} ${s * 0.86},${s * 0.5} ${s * 0.92},${s * 0.33}"/><path d="M${s * 0.86} ${s * 0.5} A${s * 0.36} ${s * 0.36} 0 0 1 ${s * 0.14} ${s * 0.5}"/><polyline points="${s * 0.3},${s * 0.58} ${s * 0.14},${s * 0.5} ${s * 0.08},${s * 0.67}"/>`);
    case 'clock': return g(`<circle cx="${s * 0.5}" cy="${s * 0.5}" r="${s * 0.38}"/><polyline points="${s * 0.5},${s * 0.27} ${s * 0.5},${s * 0.53} ${s * 0.69},${s * 0.61}"/>`);
    case 'user': return g(`<circle cx="${s * 0.5}" cy="${s * 0.33}" r="${s * 0.17}"/><path d="M${s * 0.17} ${s * 0.9} A${s * 0.33} ${s * 0.33} 0 0 1 ${s * 0.83} ${s * 0.9}"/>`);
    case 'check': return g(`<polyline points="${s * 0.16},${s * 0.53} ${s * 0.4},${s * 0.76} ${s * 0.86},${s * 0.24}"/>`);
    default: return '';
  }
}

// วาดโดนัท (สัดส่วน) — slices=[{value,color}] ยอดรวมอยู่กลาง · ช่องว่าง 2px ระหว่างชิ้น
function donut(cx, cy, r, thick, slices) {
  const circ = 2 * Math.PI * r;
  const total = slices.reduce((s, x) => s + x.value, 0);
  let out = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.surf2}" stroke-width="${thick}"/>`;
  if (total <= 0) return out;
  const gap = slices.filter((s) => s.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  for (const s of slices) {
    if (s.value <= 0) continue;
    const frac = s.value / total;
    const dash = Math.max(0.5, frac * circ - gap);
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thick}" stroke-dasharray="${dash} ${circ - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += frac * circ;
  }
  return out;
}

// ── ตัวสร้าง SVG (layout engine แบบไล่ y ลงล่าง) ─────────────────────────────
function buildShiftCardSVG(d) {
  const el = [];       // element strings
  let y = 0;           // cursor แนวตั้ง
  const push = (s) => el.push(s);
  const divider = () => { push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`); };
  const sectionHead = (name, iconName, count) => {
    const iy = y + 14, ty = y + 25;
    push(icon(iconName, PX, iy, 15, C.dim));
    push(text(PX + 22, ty, 12.5, 700, C.dim, name));
    if (count) {
      const cw = measure(count, 12) + 18;
      push(`<rect x="${W - PX - cw}" y="${y + 11}" width="${cw}" height="19" rx="9.5" fill="${C.surf2}"/>`);
      push(text(W - PX - cw / 2, ty - 1, 12, 650, C.ink, count, 'middle'));
    }
    y += 40;
  };

  // 1) HEADER
  const headH = 76;
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.surf}"/>`);
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.accent}" opacity="0.06"/>`);
  push(`<rect x="0" y="0" width="4" height="${headH}" fill="${C.accent}"/>`);
  push(icon('flag', PX, 15, 15, C.accent));
  push(text(PX + 22, 27, 12.5, 600, C.dim, 'สรุปสิ้นกะ · อัตโนมัติ'));
  push(text(PX, 51, 20, 700, C.ink, d.shiftLabel || 'กะ'));
  if (d.shiftTime) push(text(PX + measure(d.shiftLabel || 'กะ', 20) + 10, 51, 14, 600, C.dim, d.shiftTime));
  push(text(PX, 69, 13, 500, C.dim, `วันทำงาน ${d.workDay || ''}`));
  y = headH;
  divider();

  // 2) HERO — โดนัทสัดส่วนยอดผลิต (ยอดรวมกลาง) + สถิติ KPI ด้านขวา
  const heroH = 132;
  const lines = d.lines || [];
  const sliceColor = (i) => (i < LINE_COLORS.length ? LINE_COLORS[i] : LINE_MORE);
  push(`<rect x="0" y="${y}" width="${W}" height="${heroH}" fill="${C.surf}"/>`);
  const dCx = PX + 58, dCy = y + heroH / 2, dR = 46, dThick = 14;
  const slices = lines.map((ln, i) => ({ value: Math.max(0, Number(ln.actual) || 0), color: sliceColor(i) }));
  const sliceTotal = slices.reduce((s, x) => s + x.value, 0);
  push(donut(dCx, dCy, dR, dThick, slices));
  push(text(dCx, dCy + 3, 25, 760, C.ink, `${sliceTotal}`, 'middle'));
  push(text(dCx, dCy + 20, 10.5, 500, C.dim, 'batch รวม', 'middle'));
  // ขวา: 3 สถิติจาก kpiCols (num + label)
  const kcols = d.kpiCols || [];
  const rx = PX + 128;
  const primaryColor = (c) => c.color || C.ink;
  kcols.slice(0, 3).forEach((c, i) => {
    const ry = y + 34 + i * 34;
    const numStr = `${c.num}${c.unit || ''}`;
    push(text(rx, ry, 20, 760, primaryColor(c), c.num));
    if (c.unit) push(text(rx + measure(c.num, 20) + 2, ry, 13, 600, C.dim, c.unit));
    push(text(rx + measure(numStr, 20) + 10, ry - 1, 12.5, 500, C.dim, c.label || ''));
  });
  y += heroH;
  divider();

  // 3) PRODUCTION lines — จุดสีตรงกับโดนัท + ค่าจริง/แผน + ป้ายสถานะ
  sectionHead('ยอดผลิต', 'box', lines.length ? `${lines.length} ไลน์` : null);
  if (!lines.length) { push(text(PX, y + 8, 13.5, 500, C.dim, 'ไม่มีการผลิตในกะนี้')); y += 22; }
  lines.forEach((ln, idx) => {
    if (idx > 0) { push(`<line x1="${PX}" y1="${y}" x2="${W - PX}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`); y += 1; }
    y += 10;
    push(`<circle cx="${PX + 5}" cy="${y + 6}" r="4.5" fill="${sliceColor(idx)}"/>`);
    const nm = `${ln.line || ''} · `;
    push(text(PX + 18, y + 11, 14, 620, C.ink, nm) + text(PX + 18 + measure(nm, 14), y + 11, 13.5, 500, C.dim, ln.flavor || ''));
    const val = `${ln.actual ?? '-'}`;
    const hasPlan = ln.plan != null;
    const valStr = hasPlan ? `${val} / ${ln.plan}` : `${val} batch`;
    push(text(W - PX, y + 11, hasPlan ? 14.5 : 13, hasPlan ? 700 : 600, hasPlan ? C.ink : C.dim, valStr, 'end'));
    const sev = SEV[ln.status] || C.dim;
    if (ln.statusLabel) {
      const py = y + 30;
      const pw = measure(ln.statusLabel, 11.5) + 26;
      push(`<rect x="${PX + 18}" y="${py - 13}" width="${pw}" height="18" rx="9" fill="${sev}" opacity="0.16"/>`);
      push(`<circle cx="${PX + 29}" cy="${py - 4}" r="3" fill="${sev}"/>`);
      push(text(PX + 37, py, 11.5, 650, sev, ln.statusLabel));
      if (ln.pct != null) push(text(W - PX, py, 12, 500, C.dim, `${ln.pct}%`, 'end'));
      y = py + 8;
    } else { y += 20; }
  });
  y += 8;
  divider();

  // helper: บล็อกรายการมี dot สี + ตัดบรรทัด
  const bulletBlock = (items, maxW) => {
    items.forEach((it) => {
      const lvl = it.level || 'mute';
      const lines = wrap(it.text, maxW, 13.5);
      push(`<circle cx="${PX + 4}" cy="${y + 6}" r="3.2" fill="${SEV[lvl] || C.dim}"/>`);
      lines.forEach((lstr, li) => { push(text(PX + 15, y + 10 + li * 17, 13.5, li === 0 ? 600 : 500, C.ink, lstr)); });
      y += lines.length * 17 + 3;
      if (it.sub) {
        const subLines = wrap(it.sub, maxW, 13);
        subLines.forEach((lstr, li) => push(text(PX + 15, y + 8 + li * 16, 13, 500, C.dim, lstr)));
        y += subLines.length * 16 + 2;
      }
      y += 6;
    });
  };
  const bodyMaxW = W - PX * 2 - 15;

  // 4) CIP / Backwash
  sectionHead('CIP / Backwash', 'drop', null);
  y -= 6;
  if (d.cip && d.cip.text) bulletBlock([{ level: d.cip.level || 'mute', text: d.cip.text }], bodyMaxW);
  else { push(text(PX + 15, y + 8, 13.5, 500, C.dim, 'ไม่มีข้อมูล')); y += 20; }
  y += 6;
  divider();

  // 5) งานค้าง
  const tk = d.tasks || {};
  sectionHead('งานค้าง', 'clip', tk.count != null ? `${tk.count} รายการ` : null);
  y -= 4;
  if (tk.items && tk.items.length) bulletBlock(tk.items.map((it) => ({ level: 'mute', text: it.text, sub: it.sub })), bodyMaxW);
  else { push(text(PX + 15, y + 8, 13.5, 600, C.good, 'ไม่มีงานค้าง')); y += 22; }
  y += 4;
  divider();

  // 6) จุดที่ต้องระวัง
  if (d.watch && d.watch.length) {
    sectionHead('จุดที่ต้องระวัง', 'warn', null);
    y -= 4;
    bulletBlock(d.watch.map((w) => ({ level: w.level || 'warn', text: w.text })), bodyMaxW);
    y += 4;
    divider();
  }

  // 7) FOOTER
  const footH = 40;
  push(`<rect x="0" y="${y}" width="${W}" height="${footH}" fill="${C.surf}"/>`);
  push(icon('spark', PX, y + 12, 15, C.accent));
  push(text(PX + 22, y + 25, 12, 500, C.dim, `วิเคราะห์อัตโนมัติ${d.team ? ' · ' + d.team : ''}`));
  if (d.sentTime) push(text(W - PX, y + 25, 12, 500, C.dim, `ส่ง ${d.sentTime}`, 'end'));
  y += footH;

  const H = y;
  // ประกอบ SVG: พื้นหลังโค้งมน + ตัดขอบมน
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><clipPath id="rc"><rect x="0" y="0" width="${W}" height="${H}" rx="22"/></clipPath></defs>
<g clip-path="url(#rc)">
<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
${el.join('\n')}
</g></svg>`;
  return svg;
}

// เรนเดอร์เป็น PNG buffer (2x = คมบนจอมือถือ) — คืน null ถ้า lib/ฟอนต์ไม่พร้อม
function renderShiftCardPNG(data) {
  if (!canRenderCard()) return null;
  const svg = buildShiftCardSVG(data);
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * 2 },
    font: { fontFiles: FONT_FILES, defaultFontFamily: FONT, loadSystemFonts: false },
    background: C.bg,
  });
  return r.render().asPng();
}

// ═══════════════════════════════════════════════════════════════════════════
// buildKpiCardSVG — การ์ดสรุป KPI รายสัปดาห์/รายเดือน (ใช้ primitives ชุดเดียวกับ
// การ์ดสิ้นกะ: header/hero โดนัท/รายการไลน์/CIP/footer แต่ไม่มี "งานค้าง"/"จุดต้องระวัง"
// เพราะเป็นมุมมองสรุปช่วงเวลา ไม่ใช่รายกะ)
// ═══════════════════════════════════════════════════════════════════════════
function buildKpiCardSVG(d) {
  const el = [];
  let y = 0;
  const push = (s) => el.push(s);
  const divider = () => { push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`); };
  const sectionHead = (name, iconName, count) => {
    const iy = y + 14, ty = y + 25;
    push(icon(iconName, PX, iy, 15, C.dim));
    push(text(PX + 22, ty, 12.5, 700, C.dim, name));
    if (count) {
      const cw = measure(count, 12) + 18;
      push(`<rect x="${W - PX - cw}" y="${y + 11}" width="${cw}" height="19" rx="9.5" fill="${C.surf2}"/>`);
      push(text(W - PX - cw / 2, ty - 1, 12, 650, C.ink, count, 'middle'));
    }
    y += 40;
  };

  // 1) HEADER
  const headH = 76;
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.surf}"/>`);
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.accent}" opacity="0.06"/>`);
  push(`<rect x="0" y="0" width="4" height="${headH}" fill="${C.accent}"/>`);
  push(icon('spark', PX, 15, 15, C.accent));
  push(text(PX + 22, 27, 12.5, 600, C.dim, 'สรุป KPI · อัตโนมัติ'));
  push(text(PX, 51, 20, 700, C.ink, d.periodLabel || 'สรุป KPI'));
  push(text(PX, 69, 13, 500, C.dim, d.periodRangeText || ''));
  y = headH;
  divider();

  // 2) HERO — โดนัทสัดส่วนยอดผลิต (ยอดรวมกลาง) + สถิติ KPI ด้านขวา
  const heroH = 132;
  const lines = d.lines || [];
  const sliceColor = (i) => (i < LINE_COLORS.length ? LINE_COLORS[i] : LINE_MORE);
  push(`<rect x="0" y="${y}" width="${W}" height="${heroH}" fill="${C.surf}"/>`);
  const dCx = PX + 58, dCy = y + heroH / 2, dR = 46, dThick = 14;
  const slices = lines.map((ln, i) => ({ value: Math.max(0, Number(ln.actual) || 0), color: sliceColor(i) }));
  const sliceTotal = slices.reduce((s, x) => s + x.value, 0);
  push(donut(dCx, dCy, dR, dThick, slices));
  push(text(dCx, dCy + 3, 25, 760, C.ink, `${sliceTotal}`, 'middle'));
  push(text(dCx, dCy + 20, 10.5, 500, C.dim, 'batch รวม', 'middle'));
  const kcols = d.kpiCols || [];
  const rx = PX + 128;
  const primaryColor = (c) => c.color || C.ink;
  kcols.slice(0, 3).forEach((c, i) => {
    const ry = y + 34 + i * 34;
    const numStr = `${c.num}${c.unit || ''}`;
    push(text(rx, ry, 20, 760, primaryColor(c), c.num));
    if (c.unit) push(text(rx + measure(c.num, 20) + 2, ry, 13, 600, C.dim, c.unit));
    push(text(rx + measure(numStr, 20) + 10, ry - 1, 12.5, 500, C.dim, c.label || ''));
  });
  y += heroH;
  divider();

  // 3) ไลน์ที่ควรจับตา (แย่สุดก่อน — reuse layout เดียวกับการ์ดสิ้นกะ)
  sectionHead('ไลน์ที่ควรจับตา', 'box', lines.length ? `${lines.length} รายการ` : null);
  if (!lines.length) { push(text(PX, y + 8, 13.5, 500, C.dim, 'ไม่มีข้อมูลผลิตในช่วงนี้')); y += 22; }
  lines.forEach((ln, idx) => {
    if (idx > 0) { push(`<line x1="${PX}" y1="${y}" x2="${W - PX}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`); y += 1; }
    y += 10;
    push(`<circle cx="${PX + 5}" cy="${y + 6}" r="4.5" fill="${sliceColor(idx)}"/>`);
    const nm = `${ln.line || ''} · `;
    push(text(PX + 18, y + 11, 14, 620, C.ink, nm) + text(PX + 18 + measure(nm, 14), y + 11, 13.5, 500, C.dim, ln.flavor || ''));
    const val = `${ln.actual ?? '-'}`;
    const hasPlan = ln.plan != null;
    const valStr = hasPlan ? `${val} / ${ln.plan}` : `${val} batch`;
    push(text(W - PX, y + 11, hasPlan ? 14.5 : 13, hasPlan ? 700 : 600, hasPlan ? C.ink : C.dim, valStr, 'end'));
    const sev = SEV[ln.status] || C.dim;
    if (ln.statusLabel) {
      const py = y + 30;
      const pw = measure(ln.statusLabel, 11.5) + 26;
      push(`<rect x="${PX + 18}" y="${py - 13}" width="${pw}" height="18" rx="9" fill="${sev}" opacity="0.16"/>`);
      push(`<circle cx="${PX + 29}" cy="${py - 4}" r="3" fill="${sev}"/>`);
      push(text(PX + 37, py, 11.5, 650, sev, ln.statusLabel));
      if (ln.pct != null) push(text(W - PX, py, 12, 500, C.dim, `${ln.pct}%`, 'end'));
      y = py + 8;
    } else { y += 20; }
  });
  y += 8;
  divider();

  // 4) CIP / Backwash (สรุปยอดรวมช่วง)
  sectionHead('CIP / Backwash', 'drop', null);
  y -= 6;
  const cipLvl = (d.cip && d.cip.level) || 'mute';
  const cipTxt = (d.cip && d.cip.text) || 'ไม่มีข้อมูล';
  push(`<circle cx="${PX + 4}" cy="${y + 6}" r="3.2" fill="${SEV[cipLvl] || C.dim}"/>`);
  wrap(cipTxt, W - PX * 2 - 15, 13.5).forEach((lstr, li) => push(text(PX + 15, y + 10 + li * 17, 13.5, li === 0 ? 600 : 500, C.ink, lstr)));
  y += 30;
  divider();

  // 5) FOOTER
  const footH = 40;
  push(`<rect x="0" y="${y}" width="${W}" height="${footH}" fill="${C.surf}"/>`);
  push(icon('spark', PX, y + 12, 15, C.accent));
  push(text(PX + 22, y + 25, 12, 500, C.dim, 'สรุปอัตโนมัติ'));
  if (d.sentTime) push(text(W - PX, y + 25, 12, 500, C.dim, `ส่ง ${d.sentTime}`, 'end'));
  y += footH;

  const H = y;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><clipPath id="rc"><rect x="0" y="0" width="${W}" height="${H}" rx="22"/></clipPath></defs>
<g clip-path="url(#rc)">
<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
${el.join('\n')}
</g></svg>`;
  return svg;
}

function renderKpiCardPNG(data) {
  if (!canRenderCard()) return null;
  const svg = buildKpiCardSVG(data);
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * 2 },
    font: { fontFiles: FONT_FILES, defaultFontFamily: FONT, loadSystemFonts: false },
    background: C.bg,
  });
  return r.render().asPng();
}

// ═══════════════════════════════════════════════════════════════════════════
// buildBeforeAfterSVG — การ์ด "ก่อนทำ | หลังทำ" ของงานประจำ (วางซ้าย-ขวา)
// เหตุผลที่ต้องวาดข้อความลงในรูป: Telegram album ผูก caption ไว้กับรูปแรกเท่านั้น
// พอ forward ต่อเข้ากลุ่ม Line รูปกับข้อความจะหลุดจากกัน → ยัดทุกอย่างไว้ในภาพเดียวจบ
//
// ⚠️ beforeUri/afterUri ต้องเป็น data: URI เท่านั้น — resvg ไม่ดาวน์โหลด URL ระยะไกลให้
//    ผู้เรียกต้อง fetch มาแปลงเป็น base64 ก่อน (ดู fetchAsDataUri ใน index.js)
// ═══════════════════════════════════════════════════════════════════════════
/* วางข้อความหลายชิ้นต่อกันแนวนอน โดยแยกเป็น <text> คนละชิ้น — ใช้ตอนต้องการ
   ขนาด/น้ำหนัก/สีต่างกันในบรรทัดเดียว (เช่น ตัวคั่นสีจาง คร่อมข้อความสีปกติ)
   ⚠️ ตำแหน่งแต่ละชิ้นมาจาก measure() ซึ่งเป็นค่าประมาณ — ระยะห่างตรงรอยต่อจะเพี้ยนได้เล็กน้อย
      ข้อความยาว ๆ ที่ไม่ต้องแยกสี ใช้ text() ชิ้นเดียวจะได้ระยะจากฟอนต์จริง แม่นกว่า
   (เดิมฟังก์ชันนี้มีไว้แก้อาการ ำ กลืนตัวถัดไปด้วย — ย้ายไปแก้ที่ esc() แล้ว ไม่ต้องแยกเพราะเหตุนั้นอีก) */
function textRun(x, y, parts, gap = 7) {
  const out = [];
  let cx = x;
  for (const p of parts) {
    if (p.t == null || p.t === '') continue;
    out.push(text(cx, y, p.size, p.weight, p.fill, p.t));
    cx += measure(p.t, p.size) + (p.gap == null ? gap : p.gap);
  }
  return out.join('');
}

function buildBeforeAfterSVG(d) {
  const el = [];
  const push = (s) => el.push(s);
  let y = 0;

  // 1) HEADER — ชื่องาน (wrap ได้ 2 บรรทัด) + คน/วันที่/เวลา
  const titleLines = wrap(d.title || 'งานประจำ', W - PX * 2 - 4, 17).slice(0, 2);
  const headH = 44 + titleLines.length * 22 + 26;
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.surf}"/>`);
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.good}" opacity="0.07"/>`);
  push(`<rect x="0" y="0" width="4" height="${headH}" fill="${C.good}"/>`);
  push(icon('clip', PX, 14, 15, C.good));
  push(text(PX + 22, 26, 12.5, 600, C.dim, d.kicker || 'บันทึกผลงานประจำ'));
  titleLines.forEach((ln, i) => push(text(PX, 52 + i * 22, 17, 700, C.ink, ln)));
  // ชื่อคน/วันที่/เวลา — แยกชิ้นเพื่อให้ตัวคั่น · จางกว่าตัวหนังสือ
  const metaY = 52 + titleLines.length * 22 + 4;
  const metaParts = [];
  [d.personName, d.dateLabel, d.timeLabel].filter(Boolean).forEach((t, i) => {
    if (i) metaParts.push({ t: '·', size: 12.5, weight: 500, fill: C.line });
    metaParts.push({ t, size: 12.5, weight: 500, fill: C.dim });
  });
  push(textRun(PX, metaY, metaParts));
  y = headH;
  push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);

  // 2) รูปก่อน-หลัง — ทุกอย่างต้องอยู่ในการ์ดใบเดียว (ห้ามแยกเป็นอัลบั้มตามหลัง)
  //    ไม่มีรูปก่อนทำ → ให้ฝั่งหลังทำกินเต็มความกว้าง แทนที่จะโชว์กล่องเปล่าครึ่งใบ
  const gap = 10;
  const afterList = (Array.isArray(d.afterUris) ? d.afterUris : [d.afterUri]).filter(Boolean);
  const hasBefore = !!d.beforeUri;
  const fullW = W - PX * 2;
  const halfW = Math.floor((fullW - gap) / 2);
  const ph = 148;
  y += 14;
  let cellSeq = 0;
  // วาดรูป 1 ใบลงกรอบที่กำหนด (ครอบแบบ slice ไม่ยืดผิดสัดส่วน)
  const cell = (x, top, w, h, uri) => {
    const cid = `bac${cellSeq++}`;
    push(`<defs><clipPath id="${cid}"><rect x="${x}" y="${top}" width="${w}" height="${h}" rx="8"/></clipPath></defs>`);
    push(`<rect x="${x}" y="${top}" width="${w}" height="${h}" rx="8" fill="${C.surf2}"/>`);
    if (uri) push(`<image href="${uri}" x="${x}" y="${top}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${cid})"/>`);
    else push(text(x + w / 2, top + h / 2 + 4, 12.5, 500, C.dim, 'ไม่มีรูป', 'middle'));
    push(`<rect x="${x}" y="${top}" width="${w}" height="${h}" rx="8" fill="none" stroke="${C.line}" stroke-width="1"/>`);
  };
  // ปิดท้ายการ์ด (footer + ประกอบ SVG) — ใช้ร่วมกันทั้งโหมดจับคู่ตามจุดและโหมดปกติ
  const finishCard = () => {
    const footH = 40;
    push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
    push(`<rect x="0" y="${y}" width="${W}" height="${footH}" fill="${C.surf}"/>`);
    if (d.footer) push(text(PX, y + 25, 12, 500, C.dim, d.footer));
    if (d.by) push(text(W - PX, y + 25, 12, 500, C.dim, `โดย ${d.by}`, 'end'));
    y += footH;
    const H = y;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><clipPath id="rcba"><rect x="0" y="0" width="${W}" height="${H}" rx="22"/></clipPath></defs>
<g clip-path="url(#rcba)">
<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
${el.join('\n')}
</g></svg>`;
  };
  const label = (x, main, sub, tint) => {
    // แยกชิ้นเพื่อให้คำขยาย (sub) จางกว่าหัวข้อ
    push(textRun(x, y + 11, [
      { t: main, size: 11.5, weight: 700, fill: tint },
      ...(sub ? [{ t: sub, size: 10.5, weight: 600, fill: C.line }] : []),
    ], 6));
  };
  // ฝั่งหลังทำ: 1 รูป = เต็มกรอบ · 2 = บน-ล่าง · 3-4 = ตาราง 2×2 · เกิน 4 = โชว์ 4 + ป้าย +N
  const afterGrid = (x, top, w, h, list) => {
    const g = 6;
    const shown = list.slice(0, 4);
    if (shown.length <= 1) { cell(x, top, w, h, shown[0] || null); }
    else if (shown.length === 2) {
      const hh = Math.floor((h - g) / 2);
      cell(x, top, w, hh, shown[0]);
      cell(x, top + hh + g, w, h - hh - g, shown[1]);
    } else {
      const hw = Math.floor((w - g) / 2), hh = Math.floor((h - g) / 2);
      cell(x, top, hw, hh, shown[0]);
      cell(x + hw + g, top, w - hw - g, hh, shown[1]);
      // 3 รูป → ใบล่างกินเต็มแถว ไม่งั้นเหลือช่องโหว่มุมขวาล่าง
      if (shown.length === 3) cell(x, top + hh + g, w, h - hh - g, shown[2]);
      else { cell(x, top + hh + g, hw, h - hh - g, shown[2]); cell(x + hw + g, top + hh + g, w - hw - g, h - hh - g, shown[3]); }
    }
    // afterTotal = จำนวนรูปจริงทั้งหมด (ผู้เรียกโหลดมาแค่ 4 ใบที่จะโชว์ ป้าย +N เลยต้องอิงค่านี้)
    const extra = Math.max(d.afterTotal || list.length, list.length) - shown.length;
    if (extra > 0) {
      const bw = measure(`+${extra}`, 12) + 16;
      push(`<rect x="${x + w - bw - 6}" y="${top + h - 26}" width="${bw}" height="20" rx="10" fill="${C.bg}" opacity="0.82"/>`);
      push(text(x + w - bw / 2 - 6, top + h - 11, 12, 800, C.ink, `+${extra}`, 'middle'));
    }
  };
  // โหมด "จับคู่ตามจุด": pairs = [{label, beforeUri, afterUri}] → เรียงเป็นแถว จุดละแถว
  // ให้เห็นชัดว่ารูปไหนคู่กับรูปไหน (พื้นที่เดียวแต่มีหลายจุด)
  const pairs = Array.isArray(d.pairs) ? d.pairs.filter(Boolean) : null;
  if (pairs && pairs.length) {
    const shown = pairs.slice(0, 4);
    const rowH = shown.length === 1 ? 148 : shown.length === 2 ? 116 : 90;
    // หัวคอลัมน์บอกครั้งเดียว — ไม่ต้องเขียน ก่อน/หลัง ซ้ำทุกแถว
    push(text(PX, y + 10, 11.5, 700, C.dim, 'ก่อนทำ'));
    push(text(PX + halfW + gap, y + 10, 11.5, 700, C.good, 'หลังทำ'));
    y += 18;
    for (const p of shown) {
      push(text(PX, y + 11, 11, 700, C.accent, p.label || ''));
      const top = y + 17;
      cell(PX, top, halfW, rowH, p.beforeUri);
      cell(PX + halfW + gap, top, halfW, rowH, p.afterUri);
      y += 17 + rowH + 10;
    }
    const extra = pairs.length - shown.length;
    if (extra > 0) { push(text(PX, y + 6, 11.5, 600, C.dim, `+ อีก ${extra} จุด`)); y += 16; }
    y += 4;
    return finishCard();
  }

  const nAfter = Math.max(d.afterTotal || afterList.length, afterList.length);
  const afterSub = nAfter > 1 ? `${nAfter} รูป` : (d.timeLabel || '');
  if (hasBefore) {
    label(PX, 'ก่อนทำ', d.beforeSub == null ? 'อ้างอิง' : d.beforeSub, C.dim);
    label(PX + halfW + gap, 'หลังทำ', afterSub, C.good);
    cell(PX, y + 20, halfW, ph, d.beforeUri);
    afterGrid(PX + halfW + gap, y + 20, halfW, ph, afterList);
  } else {
    label(PX, 'หลังทำ', afterSub, C.good);
    afterGrid(PX, y + 20, fullW, ph, afterList);
  }
  y += 20 + ph + 14;
  return finishCard();
}

function renderBeforeAfterCardPNG(data) {
  if (!canRenderCard()) return null;
  const svg = buildBeforeAfterSVG(data);
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * 2 },
    font: { fontFiles: FONT_FILES, defaultFontFamily: FONT, loadSystemFonts: false },
    background: C.bg,
  });
  return r.render().asPng();
}

// ═══════════════════════════════════════════════════════════════════════════
// buildRepairCardSVG — การ์ดใบแจ้งซ่อม 1 ใบ (ตัวที่ปักอยู่ในกลุ่มช่าง)
// การ์ดใบนี้ "แก้ทับตัวเอง" ทุกครั้งที่สถานะเปลี่ยน (รับงาน/ปิดงาน) → ต้องวาดได้ทุกสถานะ
// จากข้อมูลชุดเดียวกัน ไม่ใช่คนละแบบต่อสถานะ
//
// ⚠️ ห้ามใส่ emoji ลงใน SVG — resvg เรนเดอร์ emoji สีไม่ได้ ได้กล่องเปล่าหรือหาย
//    ทุกไอคอนต้องมาจาก icon() · ทุกสถานะ/ความเร่งด่วนสื่อด้วย "สี + คำ" ไม่ใช่สีอย่างเดียว
// ═══════════════════════════════════════════════════════════════════════════
const REPAIR_PRIO = {
  stop: { label: 'หยุดไลน์', color: C.crit },
  warn: { label: 'ยังเดินได้ แต่มีปัญหา', color: C.warn },
  low: { label: 'ไว้ทำตอนว่าง', color: C.good },
};
const REPAIR_STATUS = {
  open: { label: 'รอรับงาน', color: C.crit },
  wip: { label: 'กำลังซ่อม', color: C.accent },
  closed: { label: 'ปิดงานแล้ว', color: C.good },
};

/* วาดรูปถ่าย 1 ใบลงกรอบ (ครอบแบบ slice ไม่ยืดผิดสัดส่วน)
   ⚠️ uri ต้องเป็น data: URI เท่านั้น — resvg ไม่ดาวน์โหลด URL ระยะไกลให้ (ดู fetchAsDataUri ใน index.js) */
let photoSeq = 0;
function photoCell(x, y, w, h, uri) {
  const cid = `rcp${photoSeq++}`;
  return `<defs><clipPath id="${cid}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/></clipPath></defs>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${C.surf2}"/>`
    + `<image href="${uri}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${cid})"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="none" stroke="${C.line}" stroke-width="1"/>`;
}

// "2 ชม. 15 น." — แฝดกับ downLabel() ใน index.js แต่การ์ดต้องคำนวณเองจากนาทีของแต่ละแถบ
const fmtMin = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} ชม.${m ? ` ${m} น.` : ''}` : `${m} น.`;
};

function buildRepairCardSVG(d) {
  const el = [];
  const push = (s) => el.push(s);
  let y = 0;
  const prio = REPAIR_PRIO[d.priority] || REPAIR_PRIO.warn;
  const st = REPAIR_STATUS[d.status] || REPAIR_STATUS.open;
  const fullW = W - PX * 2;

  // ── 1) HEADER — แถบสีซ้ายบอกความเร่งด่วน · ป้ายสถานะมุมขวา ──
  const titleLines = wrap(d.title || 'ใบแจ้งซ่อม', fullW - 4, 17).slice(0, 2);
  const metaParts = [];
  [d.machine, d.operator ? `แจ้งโดย ${d.operator}` : '', d.dateLabel].filter(Boolean).forEach((t, i) => {
    if (i) metaParts.push({ t: '·', size: 12, weight: 500, fill: C.line });
    metaParts.push({ t, size: 12, weight: 500, fill: C.dim });
  });
  const headH = 44 + titleLines.length * 22 + (metaParts.length ? 24 : 6);
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.surf}"/>`);
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${prio.color}" opacity="0.07"/>`);
  push(`<rect x="0" y="0" width="4" height="${headH}" fill="${prio.color}"/>`);
  push(icon('wrench', PX, 14, 15, prio.color));
  push(text(PX + 22, 26, 12.5, 700, C.dim, d.kicker || 'ใบแจ้งซ่อม'));
  // ป้ายสถานะ — วาดขวาสุดของบรรทัด kicker
  {
    const pw = measure(st.label, 11.5) + 22;
    push(`<rect x="${W - PX - pw}" y="13" width="${pw}" height="20" rx="10" fill="${st.color}" opacity="0.16"/>`);
    push(`<circle cx="${W - PX - pw + 11}" cy="23" r="3.2" fill="${st.color}"/>`);
    push(text(W - PX - pw + 18, 27, 11.5, 700, st.color, st.label));
  }
  titleLines.forEach((ln, i) => push(text(PX, 52 + i * 22, 17, 700, C.ink, ln)));
  if (metaParts.length) push(textRun(PX, 52 + titleLines.length * 22 + 4, metaParts));
  y = headH;
  push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);

  /* ── 2) แถบ "เจออาการนี้ครั้งที่ N แล้ว" ────────────────────────────────
     เหตุผลที่ต้องเด่นกว่าแถวอื่น: ช่างที่กำลังจะรับงานต้องเห็นก่อนตัดสินใจว่า
     "นี่ไม่ใช่ครั้งแรก" — ซ่อมแบบเดิมซ้ำที่ 4 แปลว่าแก้ไม่ตรงสาเหตุ
     ครั้งแรก (times<2) ไม่ต้องขึ้นอะไรเลย ไม่งั้นการ์ดรกโดยไม่ได้ข้อมูลเพิ่ม */
  if (d.repeatTimes >= 2) {
    const bandH = d.repeatLastLabel ? 50 : 38;
    push(`<rect x="0" y="${y}" width="${W}" height="${bandH}" fill="${C.warn}" opacity="0.1"/>`);
    push(`<rect x="0" y="${y}" width="3" height="${bandH}" fill="${C.warn}"/>`);
    push(icon('repeat', PX, y + (d.repeatLastLabel ? 13 : 11), 16, C.warn));
    // แยก 3 ชิ้นเพื่อเน้นเฉพาะตัวเลขครั้งให้ใหญ่+สีส้ม ส่วนที่เหลือเป็นตัวหนังสือปกติ
    push(textRun(PX + 24, y + 24, [
      { t: 'เจออาการนี้', size: 13, weight: 600, fill: C.ink, gap: 5 },
      { t: `ครั้งที่ ${d.repeatTimes}`, size: 14, weight: 800, fill: C.warn, gap: 5 },
      { t: 'แล้ว', size: 13, weight: 600, fill: C.ink },
    ]));
    if (d.repeatLastLabel) push(text(PX + 24, y + 41, 11.5, 500, C.dim, d.repeatLastLabel));
    y += bandH;
    push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
  }

  // ── กล่องข้อความยาว (อาการ / วิธีแก้) ──
  const block = (label, body, tint, maxLines) => {
    const lines = wrap(body, fullW - 24, 13).slice(0, maxLines);
    y += 13;
    push(text(PX, y + 10, 11.5, 700, tint, label));
    y += 18;
    push(`<rect x="${PX}" y="${y}" width="${fullW}" height="${lines.length * 19 + 16}" rx="9" fill="${C.surf2}"/>`);
    push(`<rect x="${PX}" y="${y}" width="3" height="${lines.length * 19 + 16}" rx="1.5" fill="${tint}" opacity="0.55"/>`);
    lines.forEach((ln, i) => push(text(PX + 13, y + 22 + i * 19, 13, 500, C.ink, ln)));
    y += lines.length * 19 + 16;
  };
  /* ── แถวรูปถ่าย ────────────────────────────────────────────────────────
     ช่างที่เห็นการ์ดในกลุ่มต้องเห็นอาการได้ทันทีโดยไม่ต้องเปิดเว็บ
     ต้องอยู่ในการ์ดใบเดียวกัน ห้ามส่งเป็นอัลบั้มตามหลัง — อัลบั้มหลายรูป
     Telegram แก้ทับตัวเองไม่ได้ การ์ดจะค้างสถานะเก่าไปตลอดชีวิตใบงาน
     โชว์ได้มากสุด 3 ใบ เกินนั้นติดป้าย +N (การ์ดยาวเกินไปคนเลื่อนผ่าน) */
  const photoRow = (label, uris, total, tint) => {
    const list = (Array.isArray(uris) ? uris : []).filter(Boolean).slice(0, 3);
    if (!list.length) return;
    const g = 8;
    const h = list.length === 1 ? 172 : list.length === 2 ? 140 : 106;
    const cw = Math.floor((fullW - g * (list.length - 1)) / list.length);
    y += 13;
    push(text(PX, y + 10, 11.5, 700, tint, label));
    y += 18;
    list.forEach((uri, i) => {
      const x = PX + i * (cw + g);
      // ใบสุดท้ายกินที่ที่เหลือทั้งหมด — ปัดเศษของ cw ทำให้ขอบขวาไม่ตรงกับกล่องอื่นในการ์ด
      push(photoCell(x, y, i === list.length - 1 ? PX + fullW - x : cw, h, uri));
    });
    const extra = Math.max(total || list.length, list.length) - list.length;
    if (extra > 0) {
      const bw = measure(`+${extra}`, 12) + 16;
      push(`<rect x="${PX + fullW - bw - 6}" y="${y + h - 26}" width="${bw}" height="20" rx="10" fill="${C.bg}" opacity="0.82"/>`);
      push(text(PX + fullW - bw / 2 - 6, y + h - 11, 12, 800, C.ink, `+${extra}`, 'middle'));
    }
    y += h;
  };

  if (d.symptom) block('อาการที่แจ้ง', d.symptom, C.dim, 4);
  photoRow('รูปที่แนบมาตอนแจ้ง', d.photoUris, d.photoTotal, C.dim);

  /* ── แถบเวลาเครื่องหยุด — เทียบกับครั้งก่อน ๆ ของอาการเดียวกัน ────────────
     ตัวเลข "หยุด 1 ชม. 20 น." ลอย ๆ ไม่บอกว่ามากหรือน้อย ต้องมีอะไรให้เทียบ
     สเกลของแถบ = ครั้งที่นานที่สุดในกลุ่ม → แถบยาวเต็ม = สถิติแย่ที่สุดเท่าที่เคยเจอ
     ผู้เรียกส่ง downBars มาเฉพาะตอนมีครั้งก่อนให้เทียบจริง ไม่มีก็ตกไปใช้แถวตัวเลขข้างล่าง */
  const bars = Array.isArray(d.downBars) ? d.downBars.filter(b => b && b.mins != null) : [];
  if (bars.length >= 2) {
    const max = Math.max(...bars.map(b => b.mins)) || 1;
    y += 13;
    push(text(PX, y + 10, 11.5, 700, C.dim, 'เวลาเครื่องหยุด'));
    push(text(W - PX, y + 10, 10.5, 500, C.dim, 'เทียบครั้งก่อน ๆ', 'end'));
    y += 20;
    for (const b of bars) {
      const h = b.me ? 12 : 8;
      /* ⚠️ แถบครั้งก่อนห้ามใช้ C.line — เข้มเกือบเท่าราง (C.surf2) จนแถบที่ยาวเต็มดูเหมือนไม่มีแถบ
         (เจอตอนดูรูปที่เรนเดอร์จริง: ครั้งที่นานที่สุดกลับเป็นแถบที่มองไม่เห็นที่สุด) */
      const tint = b.me ? prio.color : C.dim;
      // ป้ายกับตัวเลขอยู่ "เหนือ" แถบของตัวเอง — วางใต้แถบแล้วอ่านเหมือนเป็นของแถบถัดไป
      push(text(PX, y + 9, 11, b.me ? 700 : 500, b.me ? C.ink : C.dim, b.label));
      push(text(W - PX, y + 9, b.me ? 13 : 11.5, b.me ? 800 : 600, b.me ? C.ink : C.dim, fmtMin(b.mins), 'end'));
      y += 14;
      const w = Math.max(3, Math.round((b.mins / max) * fullW));
      push(`<rect x="${PX}" y="${y}" width="${fullW}" height="${h}" rx="${h / 2}" fill="${C.surf2}"/>`);
      push(`<rect x="${PX}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${tint}"${b.me ? '' : ' opacity="0.6"'}/>`);
      y += h + 9;
    }
    y -= 4;
  }

  // ── แถวข้อมูลสั้น (ไอคอน + หัวข้อ + ค่า) ──
  const rows = [];
  rows.push({ ic: 'warn', label: 'ความเร่งด่วน', value: prio.label, color: prio.color });
  if (d.assigneeName) rows.push({ ic: 'user', label: 'ช่างที่รับงาน', value: d.assigneeName, color: C.ink });
  // มีแถบแล้วไม่ต้องมีแถวตัวเลขซ้ำอีก — แถบบอกตัวเลขเดียวกันอยู่แล้ว
  if (d.downLabel && bars.length < 2) rows.push({ ic: 'clock', label: d.downClosed ? 'เครื่องหยุดรวม' : 'เครื่องหยุดมาแล้ว',
    value: d.downLabel, color: d.downClosed ? C.ink : C.crit });
  if (rows.length) {
    y += 12;
    for (const r of rows) {
      push(icon(r.ic, PX + 1, y + 2, 14, C.dim));
      push(text(PX + 22, y + 13, 12.5, 500, C.dim, r.label));
      push(text(W - PX, y + 13, 12.5, 700, r.color, r.value, 'end'));
      y += 24;
    }
    y -= 2;
  }

  if (d.cause) block('สาเหตุที่แท้จริง', d.cause, C.warn, 3);
  if (d.fix) block('วิธีแก้', d.fix, C.good, 4);
  photoRow('รูปหลังซ่อม', d.afterUris, d.afterTotal, C.good);

  // ── FOOTER ──
  y += 14;
  const footH = 38;
  push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
  push(`<rect x="0" y="${y}" width="${W}" height="${footH}" fill="${C.surf}"/>`);
  if (d.footer) push(text(PX, y + 24, 11.5, 500, C.dim, d.footer));
  if (d.footerRight) push(text(W - PX, y + 24, 11.5, 500, C.dim, d.footerRight, 'end'));
  y += footH;

  const H = y;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><clipPath id="rcrp"><rect x="0" y="0" width="${W}" height="${H}" rx="22"/></clipPath></defs>
<g clip-path="url(#rcrp)">
<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
${el.join('\n')}
</g></svg>`;
}

function renderRepairCardPNG(data) {
  if (!canRenderCard()) return null;
  const svg = buildRepairCardSVG(data);
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * 2 },
    font: { fontFiles: FONT_FILES, defaultFontFamily: FONT, loadSystemFonts: false },
    background: C.bg,
  });
  return r.render().asPng();
}

// ═══════════════════════════════════════════════════════════════════════════
// buildAmSheetCardSVG — การ์ดสรุปใบเช็ก AM 1 ใบ (1 ไลน์ × 1 กะ) เข้ากลุ่มช่าง
// 45 ข้อใส่ในการ์ดกว้าง 452 ไม่ไหว → สรุปเป็นตัวเลข + ไล่เฉพาะข้อที่ไม่ปกติ (สูงสุด 4 ข้อ)
// คนอ่านในกลุ่มต้องการ 2 อย่างเท่านั้น: "กะนี้ตรวจครบไหม" กับ "เจออะไรผิดปกติบ้าง"
//
// ⚠️ ห้ามใส่ emoji ลงใน SVG — resvg เรนเดอร์ emoji สีไม่ได้ (ใช้ icon() แทน)
// ═══════════════════════════════════════════════════════════════════════════
const AM_LINE_STATUS = {
  inprocess: { label: 'Inprocess', color: C.good },
  cip: { label: 'CIP', color: '#4aa8e0' },
  idle: { label: 'ว่าง', color: C.dim },
};

function buildAmSheetCardSVG(d) {
  const el = [];
  const push = (s) => el.push(s);
  let y = 0;
  const fullW = W - PX * 2;
  const total = Math.max(0, Number(d.total) || 0);
  const ok = Math.max(0, Number(d.ok) || 0);
  const ng = Math.max(0, Number(d.ng) || 0);
  const left = Math.max(0, total - ok - ng);
  const stt = AM_LINE_STATUS[d.lineStatus] || null;

  // ── 1) HEADER — ชื่อไลน์ + ป้ายสถานะไลน์ + วัน/กะ ──
  const headH = 88;
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.surf}"/>`);
  push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${C.accent}" opacity="0.07"/>`);
  push(`<rect x="0" y="0" width="4" height="${headH}" fill="${C.accent}"/>`);
  push(icon('clip', PX, 14, 15, C.accent));
  push(text(PX + 22, 26, 12.5, 700, C.dim, 'ใบเช็ก AM LIST'));
  if (stt) {
    const pw = measure(stt.label, 11.5) + 22;
    push(`<rect x="${W - PX - pw}" y="13" width="${pw}" height="20" rx="10" fill="${stt.color}" opacity="0.16"/>`);
    push(`<circle cx="${W - PX - pw + 11}" cy="23" r="3.2" fill="${stt.color}"/>`);
    push(text(W - PX - pw + 18, 27, 11.5, 700, stt.color, stt.label));
  }
  push(text(PX, 56, 20, 700, C.ink, d.line || 'ใบเช็ก AM'));
  push(text(PX, 76, 12.5, 500, C.dim, [d.dateLabel, d.shiftLabel].filter(Boolean).join(' · ')));
  y = headH;
  push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);

  // ── 2) HERO — โดนัท ปกติ/ไม่ปกติ/ยังไม่ตรวจ + ตัวเลขข้าง ๆ ──
  const heroH = 116;
  push(`<rect x="0" y="${y}" width="${W}" height="${heroH}" fill="${C.surf}"/>`);
  const cx = PX + 50, cy = y + heroH / 2, r = 38, thick = 13;
  push(donut(cx, cy, r, thick, [
    { value: ok, color: C.good }, { value: ng, color: C.crit }, { value: left, color: C.line },
  ]));
  // "13/15" กลางวง — ตัวเลขที่ตรวจแล้วใหญ่ ตัวหารเล็กและจาง (แยกชิ้นเพื่อคุมขนาดคนละแบบ)
  {
    const big = String(ok), small = `/${total}`;
    const bw = measure(big, 23), sw = measure(small, 13);
    const sx = cx - (bw + sw) / 2;
    push(text(sx, cy + 3, 23, 760, C.ink, big));
    push(text(sx + bw, cy + 3, 13, 600, C.dim, small));
    push(text(cx, cy + 20, 10.5, 500, C.dim, 'ปกติ', 'middle'));
  }
  // ป้ายกำกับ 3 บรรทัด — สี + คำ + ตัวเลข (ห้ามสื่อด้วยสีอย่างเดียว อ่านกลางไลน์แสงจ้า)
  {
    const lx = PX + 108;
    let ly = y + 34;
    for (const s of [{ t: 'ปกติ', v: ok, c: C.good }, { t: 'ไม่ปกติ', v: ng, c: C.crit }, { t: 'ยังไม่ตรวจ', v: left, c: C.line }]) {
      push(`<circle cx="${lx + 5}" cy="${ly - 4}" r="4.5" fill="${s.c}"/>`);
      push(text(lx + 17, ly, 13, 500, C.ink, s.t));
      push(text(W - PX, ly, 14, 800, s.v > 0 ? C.ink : C.dim, String(s.v), 'end'));
      ly += 26;
    }
  }
  y += heroH;
  push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);

  // ── 3) ข้อที่ไม่ปกติ — หัวข้อ + รายการ (รูปของปัญหาอยู่ในแถวเดียวกับข้อ) ──
  const items = (Array.isArray(d.ngItems) ? d.ngItems : []).slice(0, 4);
  y += 14;
  if (ng > 0) {
    push(icon('warn', PX, y - 2, 15, C.crit));
    push(text(PX + 22, y + 10, 13, 700, C.crit, `พบผิดปกติ ${ng} รายการ`));
  } else {
    push(icon('check', PX, y - 2, 15, C.good));
    push(text(PX + 22, y + 10, 13, 700, C.good, 'ไม่พบสิ่งผิดปกติ'));
  }
  y += 20;

  for (const it of items) {
    const ph = it.uri ? 56 : 0;
    const tw = fullW - 24 - (ph ? ph + 10 : 0);
    const titleLines = wrap(`${it.seq ? `${it.seq}. ` : ''}${it.title || ''}`, tw, 12.5).slice(0, 2);
    const causeLines = wrap(`สาเหตุ: ${it.cause || '—'}`, tw, 11).slice(0, 2);
    const textH = titleLines.length * 17 + causeLines.length * 15;
    const boxH = Math.max(ph + 16, textH + 18);
    y += 8;
    push(`<rect x="${PX}" y="${y}" width="${fullW}" height="${boxH}" rx="9" fill="${C.surf2}"/>`);
    push(`<rect x="${PX}" y="${y}" width="3" height="${boxH}" rx="1.5" fill="${C.crit}" opacity="0.55"/>`);
    // จัดข้อความกลางกล่องแนวตั้ง — กล่องสูงตามรูป (56px) ข้อความ 2 บรรทัดจะลอยอยู่ข้างบนถ้าไม่จัด
    let ty = y + (boxH - textH) / 2;
    titleLines.forEach((ln, i) => push(text(PX + 13, ty + 12 + i * 17, 12.5, 700, C.ink, ln)));
    ty += titleLines.length * 17;
    causeLines.forEach((ln, i) => push(text(PX + 13, ty + 11 + i * 15, 11, 500, C.dim, ln)));
    if (it.uri) push(photoCell(PX + fullW - ph - 8, y + 8, ph, ph, it.uri));
    y += boxH;
  }
  if (ng > items.length) {
    y += 10;
    push(text(PX, y + 8, 12, 600, C.dim, `+ อีก ${ng - items.length} รายการ (ดูในแอป)`));
    y += 12;
  }
  if (items.length) y += 6;

  /* ── 4) ใบแจ้งซ่อมที่เกิดจากใบเช็กใบนี้ ──
     กดส่งครั้งเดียวเกิด 2 อย่าง (การ์ด + ใบซ่อม) — ถ้าการ์ดไม่บอก คนอ่านไม่รู้ว่าใบซ่อมเปิดให้แล้ว */
  if (d.openedCount || d.repeatedCount) {
    const parts = [];
    if (d.openedCount) parts.push(`เปิดใบแจ้งซ่อมใหม่ ${d.openedCount} ใบ`);
    if (d.repeatedCount) parts.push(`เจอซ้ำ ต่อในใบเดิม ${d.repeatedCount} ใบ`);
    y += 8;
    push(`<rect x="${PX}" y="${y}" width="${fullW}" height="34" rx="9" fill="${C.crit}" opacity="0.1"/>`);
    push(icon('wrench', PX + 11, y + 9, 15, C.crit));
    push(text(PX + 34, y + 22, 12.5, 700, C.ink, parts.join(' · ')));
    y += 34;
  }

  // ── FOOTER ──
  y += 14;
  const footH = 38;
  push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
  push(`<rect x="0" y="${y}" width="${W}" height="${footH}" fill="${C.surf}"/>`);
  if (d.by) push(text(PX, y + 24, 11.5, 500, C.dim, `ผู้รายงาน ${d.by}`));
  push(text(W - PX, y + 24, 11.5, 500, C.dim, 'ใบเช็ก AM List', 'end'));
  y += footH;

  const H = y;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><clipPath id="rcam"><rect x="0" y="0" width="${W}" height="${H}" rx="22"/></clipPath></defs>
<g clip-path="url(#rcam)">
<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
${el.join('\n')}
</g></svg>`;
}

function renderAmSheetCardPNG(data) {
  if (!canRenderCard()) return null;
  const r = new Resvg(buildAmSheetCardSVG(data), {
    fitTo: { mode: 'width', value: W * 2 },
    font: { fontFiles: FONT_FILES, defaultFontFamily: FONT, loadSystemFonts: false },
    background: C.bg,
  });
  return r.render().asPng();
}

module.exports = { renderShiftCardPNG, buildShiftCardSVG, renderKpiCardPNG, buildKpiCardSVG, canRenderCard,
  renderBeforeAfterCardPNG, buildBeforeAfterSVG, renderRepairCardPNG, buildRepairCardSVG,
  renderAmSheetCardPNG, buildAmSheetCardSVG };
