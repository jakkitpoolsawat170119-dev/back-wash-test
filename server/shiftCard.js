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
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ประมาณความกว้างตัวอักษร (ไทย+ละติน) เพื่อ wrap เอง — SVG <text> ไม่ตัดบรรทัดให้
function charW(ch, size) {
  const c = ch.codePointAt(0);
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

module.exports = { renderShiftCardPNG, buildShiftCardSVG, canRenderCard };
