// ─── วาดกราฟเป็น SVG ฝั่งเซิร์ฟเวอร์ ─────────────────────────────────────────
// วาดที่เดียวใช้ได้ 3 ที่: หน้าอ่านบทความ (ฝัง SVG ตรง ๆ) · ตัวอย่างใน editor
// และใน Obsidian (มาร์กดาวน์ ![](…/api/chart.svg?…) — Obsidian โหลดรูปมาแสดงเอง)
//
// เป็นรูปนิ่งจึงไม่มี tooltip แบบเลื่อนเมาส์ — ชดเชยด้วยตัวเลขกำกับบนแท่ง
// และตาราง "ดูตัวเลข" ใต้กราฟในหน้าอ่าน (บนมือถือไม่มีเมาส์อยู่แล้ว)

// ลำดับสีคงที่ ห้ามวนใช้ซ้ำ — ผ่านเครื่องตรวจ: อยู่ในช่วงความสว่างเดียวกัน,
// สีไม่จืดจนดูเป็นเทา, คนตาบอดสีแยกคู่ที่อยู่ติดกันออก (ΔE 14.1) และตัดกับพื้นหลังพอ
const SERIES = ['#1565c0', '#e05e00', '#00969b', '#8e44c8', '#1c8a4c'];
const INK = '#2b2119';
const INK_SOFT = '#6d6259';
const GRID = '#e7ded6';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 12500 → "12.5k" · 1250 → "1,250" — แกนตัวเลขต้องอ่านเร็ว ไม่ใช่อ่านครบ
function fmt(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(v * 100) / 100 === Math.round(v)
    ? String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : String(Math.round(v * 100) / 100);
}

// หา "ขั้นแกน" ที่ลงตัวสวย ๆ (1/2/5 × 10^n) แล้วปัดเพดานขึ้นให้พอดี
function niceScale(max) {
  if (!(max > 0)) return { top: 1, step: 1 };
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { top: Math.ceil(max / step) * step, step };
}

const FONT = "'Sarabun','Noto Sans Thai',system-ui,-apple-system,'Helvetica Neue',sans-serif";

/**
 * data = { title, kind: 'bar'|'line', labels: string[], series: [{ name, values: number[] }], unit }
 * คืน SVG เป็นสตริง (responsive ด้วย viewBox — ไม่ล็อกความกว้างเป็นพิกเซล)
 */
function renderChart(data) {
  const kind = data.kind === 'line' ? 'line' : 'bar';
  const labels = (data.labels || []).slice(0, 40);
  const series = (data.series || []).slice(0, SERIES.length)
    .map((s, i) => ({ name: s.name || `ชุดที่ ${i + 1}`, values: (s.values || []).slice(0, 40).map(v => Number(v) || 0) }));
  const unit = data.unit || '';

  const W = 760;
  const legendH = series.length >= 2 ? 26 : 0;   // ชุดเดียวไม่ต้องมีคำอธิบายสี ชื่อกราฟบอกอยู่แล้ว
  const titleH = data.title ? 30 : 0;
  const PL = 58, PR = 16, PT = titleH + legendH + 10, PB = 46;
  const H = 330;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  const allVals = series.flatMap(s => s.values);
  const { top, step } = niceScale(Math.max(0, ...allVals));
  const y = (v) => PT + plotH - (v / top) * plotH;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img"`
    + ` aria-label="${esc(data.title || 'กราฟ')}" style="max-width:100%;height:auto;font-family:${FONT}">`);
  out.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);

  // หน่วยไปอยู่ท้ายชื่อกราฟ — เคยวางไว้มุมล่างซ้ายแล้วดูเหมือนคำหลงมา
  const heading = data.title
    ? (unit && !String(data.title).includes(unit) ? `${data.title} (${unit})` : data.title)
    : '';
  if (heading) {
    out.push(`<text x="0" y="19" font-size="16" font-weight="700" fill="${INK}">${esc(heading)}</text>`);
  }
  if (legendH) {
    let lx = 0;
    series.forEach((s, i) => {
      out.push(`<rect x="${lx}" y="${titleH + 4}" width="11" height="11" rx="3" fill="${SERIES[i]}"/>`);
      out.push(`<text x="${lx + 16}" y="${titleH + 14}" font-size="12.5" fill="${INK_SOFT}">${esc(s.name)}</text>`);
      lx += 26 + String(s.name).length * 7.2;
    });
  }

  // เส้นกริดแนวนอน — จาง ๆ พอให้กวาดตาได้ ไม่แย่งความสนใจจากข้อมูล
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = y(v);
    out.push(`<line x1="${PL}" y1="${yy}" x2="${W - PR}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`);
    out.push(`<text x="${PL - 8}" y="${yy + 4}" font-size="12.5" text-anchor="end" fill="${INK_SOFT}">${esc(fmt(v))}</text>`);
  }

  const n = Math.max(labels.length, 1);
  const slot = plotW / n;

  // ป้ายแกนล่าง — เยอะเกินก็เว้นระยะ ไม่ให้ตัวอักษรทับกัน
  const everyN = Math.ceil((n * 58) / plotW);
  labels.forEach((lb, i) => {
    if (i % everyN !== 0) return;
    const cx = PL + slot * (i + 0.5);
    out.push(`<text x="${cx}" y="${H - PB + 20}" font-size="12.5" text-anchor="middle" fill="${INK_SOFT}">${esc(lb)}</text>`);
  });

  if (kind === 'bar') {
    const gap = 2;                                   // ช่องว่าง 2px ให้แท่งไม่เชื่อมติดกัน
    const groupW = Math.max(6, slot * 0.62);
    const barW = Math.max(3, (groupW - gap * (series.length - 1)) / series.length);
    const showVal = labels.length * series.length <= 14;   // ป้ายตัวเลขเฉพาะตอนไม่แน่นเกิน
    labels.forEach((lb, i) => {
      series.forEach((s, si) => {
        const v = s.values[i] || 0;
        const x = PL + slot * (i + 0.5) - groupW / 2 + si * (barW + gap);
        const yy = y(v);
        const h = Math.max(0, PT + plotH - yy);
        const r = Math.min(4, barW / 2, h);           // มุมบนมน 4px ฐานยังอยู่ติดเส้นศูนย์
        out.push(`<path d="M${x} ${yy + h} L${x} ${yy + r} Q${x} ${yy} ${x + r} ${yy}`
          + ` L${x + barW - r} ${yy} Q${x + barW} ${yy} ${x + barW} ${yy + r} L${x + barW} ${yy + h} Z"`
          + ` fill="${SERIES[si]}"><title>${esc(lb)} · ${esc(s.name)} ${esc(fmt(v))}${esc(unit)}</title></path>`);
        if (showVal && v > 0) {
          out.push(`<text x="${x + barW / 2}" y="${yy - 6}" font-size="12.5" text-anchor="middle"`
            + ` fill="${INK}">${esc(fmt(v))}</text>`);
        }
      });
    });
  } else {
    series.forEach((s, si) => {
      const pts = labels.map((_, i) => [PL + slot * (i + 0.5), y(s.values[i] || 0)]);
      out.push(`<polyline fill="none" stroke="${SERIES[si]}" stroke-width="2" stroke-linejoin="round"`
        + ` stroke-linecap="round" points="${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}"/>`);
      if (pts.length <= 14) {
        pts.forEach((p, i) => {
          out.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="${SERIES[si]}"`
            + ` stroke="#fff" stroke-width="2"><title>${esc(labels[i])} ${esc(fmt(s.values[i] || 0))}${esc(unit)}</title></circle>`);
        });
      }
    });
  }

  // เส้นฐาน — เข้มกว่ากริดนิดเดียว ให้รู้ว่าศูนย์อยู่ตรงไหน
  out.push(`<line x1="${PL}" y1="${y(0)}" x2="${W - PR}" y2="${y(0)}" stroke="#cdbfb2" stroke-width="1"/>`);
  out.push('</svg>');
  return out.join('');
}

// ตารางตัวเลขใต้กราฟ — ทางเข้าถึงข้อมูลสำหรับคนที่อ่านกราฟไม่ได้ และคนที่อยากได้ตัวเลขเป๊ะ
function renderDataTable(data) {
  const labels = data.labels || [];
  const series = data.series || [];
  const head = `<tr><th>รายการ</th>${series.map(s => `<th>${esc(s.name)}</th>`).join('')}</tr>`;
  const rows = labels.map((lb, i) =>
    `<tr><td>${esc(lb)}</td>${series.map(s => `<td>${esc(fmt(s.values[i] || 0))}</td>`).join('')}</tr>`).join('');
  return `<details class="fold"><summary>ดูตัวเลข</summary><div class="tbl-wrap"><table>`
    + `<thead>${head}</thead><tbody>${rows}</tbody></table></div></details>`;
}

module.exports = { renderChart, renderDataTable, SERIES };
