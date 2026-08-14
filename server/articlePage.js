// ─── หน้าอ่านบทความสาธารณะ (เฟส 5) ───────────────────────────────────────────
// เสิร์ฟจากเซิร์ฟเวอร์เป็น HTML เต็มหน้า ไม่ใช่ SPA เพราะ
//   1. ต้องมี og: meta ตอนแชร์เข้า LINE/Telegram ถึงจะขึ้นการ์ดพรีวิว
//      (SPA ใส่ meta ตอน runtime ไม่ทัน — ตัวดูดพรีวิวอ่าน HTML ดิบอย่างเดียว)
//   2. คนอ่านไม่ต้องล็อกอิน ไม่ต้องโหลด bundle ของแอปทั้งก้อน
// เห็นเฉพาะบทความที่ status='published' — ร่างเปิดไม่ได้

const vault = require('./vault');
const chartSvg = require('./chartSvg');

const BRAND = '#ff6b00';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// เนื้อในบล็อกเป็น HTML ที่พิมพ์มาจาก editor — ปล่อยผ่านเฉพาะแท็กจัดรูปแบบพื้นฐาน
// ตัด <script>/<style> ทั้งก้อน · ตัด on* handler · ตัด href ที่เป็น javascript:
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'code', 'br', 'a', 'span', 'mark', 'sub', 'sup']);
function safeInline(html) {
  let s = String(html || '')
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed)[^>]*>/gi, '');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (full, tag, attrs) => {
    const t = String(tag).toLowerCase();
    if (!ALLOWED.has(t)) return '';
    if (full.startsWith('</')) return `</${t}>`;
    if (t === 'a') {
      const m = String(attrs).match(/href\s*=\s*["']([^"']*)["']/i);
      const href = m ? m[1].trim() : '';
      if (!/^(https?:|mailto:|#|\/)/i.test(href)) return '<a>';
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">`;
    }
    return `<${t}>`;
  });
  return s;
}

const plain = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const thaiDate = (iso) => {
  const s = String(iso || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${Number(m[1]) + 543}`;
};

/* ══════════════ บล็อก → HTML ══════════════ */

// สี/ขนาด/กรอบที่คนเขียนตั้งไว้ในแถบขวาของ editor — ต้องเอามาใช้ที่หน้าอ่านด้วย
// ไม่งั้นสิ่งที่เห็นตอนเขียนกับสิ่งที่คนอ่านเห็นจะคนละอย่าง (ตรงกับ styleOf() ใน BlogEditor.tsx)
const CSS_COLOR = /^#[0-9a-f]{3,8}$/i;
function styleAttr(b) {
  const s = (b && b.style) || {};
  const out = [];
  if (CSS_COLOR.test(String(s.text || ''))) out.push(`color:${s.text}`);
  if (CSS_COLOR.test(String(s.bg || ''))) out.push(`background:${s.bg}`);
  if (Number.isFinite(s.fs)) out.push(`font-size:${Math.min(Math.max(s.fs, 8), 96)}px`);
  if (Number.isFinite(s.pad)) out.push(`padding:${Math.min(Math.max(s.pad, 0), 80)}px`);
  if (Number.isFinite(s.mar)) out.push(`margin:${Math.min(Math.max(s.mar, 0), 80)}px 0`);
  if (Number.isFinite(s.bw) && s.bw > 0) {
    out.push(`border:${Math.min(s.bw, 20)}px solid ${CSS_COLOR.test(String(s.bd || '')) ? s.bd : '#eee3d9'}`);
  }
  if (Number.isFinite(s.br)) out.push(`border-radius:${Math.min(Math.max(s.br, 0), 60)}px`);
  const cls = String((b && b.cls) || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  const id = String((b && b.anchor) || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
  return (out.length ? ` style="${out.join(';')}"` : '')
    + (cls ? ` class="${esc(cls)}"` : '') + (id ? ` id="${esc(id)}"` : '');
}

function renderBlock(b) {
  const at = styleAttr(b);
  switch (b.type) {
    case 'p': { const t = safeInline(b.html); return t.trim() ? `<p${at}>${t}</p>` : ''; }
    case 'h1': return `<h2 class="lv1"${at}>${safeInline(b.html)}</h2>`;
    case 'h2': return `<h2${at}>${safeInline(b.html)}</h2>`;
    case 'h3': return `<h3${at}>${safeInline(b.html)}</h3>`;
    case 'h4': return `<h4${at}>${safeInline(b.html)}</h4>`;
    case 'divider': return '<hr>';
    case 'quote': return `<blockquote${at}>${safeInline(b.html)}</blockquote>`;
    case 'list':
      return `<ul${at}>${(b.items || []).map(i => `<li>${safeInline(i)}</li>`).join('')}</ul>`;
    case 'olist':
      return `<ol${at}>${(b.items || []).map(i => `<li>${safeInline(i)}</li>`).join('')}</ol>`;
    case 'todo':
      return `<ul class="todo"${at}>${(b.items || []).map((i, n) =>
        `<li>${(b.checks || [])[n] ? '<span class="bx on">✓</span>' : '<span class="bx"></span>'}`
        + `<span>${safeInline(i)}</span></li>`).join('')}</ul>`;
    case 'toggle':
      return `<details class="fold"${at}><summary>${safeInline(b.title)}</summary>`
        + `<div>${String(b.body || '').split('\n').map(l => esc(l)).join('<br>')}</div></details>`;
    case 'table': {
      const cells = b.cells || [];
      if (!cells.length) return '';
      const head = `<thead><tr>${cells[0].map(c => `<th>${safeInline(c)}</th>`).join('')}</tr></thead>`;
      const rows = cells.slice(1).map(r => `<tr>${r.map(c => `<td>${safeInline(c)}</td>`).join('')}</tr>`).join('');
      return `<div class="tbl-wrap"${at}><table>${head}<tbody>${rows}</tbody></table></div>`;
    }
    case 'cols': {
      const cols = b.items || [];
      return `<div class="cols c${Math.min(cols.length, 3)}"${at}>`
        + cols.map(c => `<div>${safeInline(c)}</div>`).join('') + '</div>';
    }
    case 'video': {
      const emb = vault.videoEmbed(b.url || '');
      if (!emb) return '';
      const cap = plain(b.cap);
      const player = emb.kind === 'file'
        ? `<video src="${esc(emb.src)}" controls playsinline></video>`
        : `<iframe src="${esc(emb.src)}" title="วิดีโอ" loading="lazy" allowfullscreen`
          + ` allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"></iframe>`;
      return `<figure class="vid"${at}><div class="frame">${player}</div>`
        + (cap ? `<figcaption>${esc(cap)}</figcaption>` : '') + '</figure>';
    }
    case 'chart': {
      // ข้อมูลถูกดึงมาแปะไว้ที่ b._chart ก่อนเรนเดอร์ (ดู resolveCharts ใน index.js)
      const d = b._chart;
      if (!d) return '';
      // ห่อด้วยกล่องเลื่อนแนวนอน — จอมือถือถ้าปล่อยให้ย่อเต็มความกว้าง ตัวหนังสือในกราฟจะเล็กจนอ่านไม่ออก
      return `<figure class="chart"${at}><div class="chart-scroll">${chartSvg.renderChart(d)}</div>`
        + `${chartSvg.renderDataTable(d)}</figure>`;
    }
    case 'code':
      return `<pre${at}><code>${esc(b.html || '')}</code></pre>`;
    // โค้ดที่รันได้ — โชว์โค้ดให้คนอ่านเห็นก่อนเสมอ แล้วค่อยกดรัน (หรือรันเองถ้าคนเขียนตั้งไว้)
    // โค้ดส่งเข้ากล่องผ่าน data-code ไม่ใช่ฝังในสคริปต์ของหน้า — หน้านี้จึงไม่มีทางรันมันเอง
    case 'js': {
      const code = b.html || '';
      const h = Math.max(120, Math.min(800, Number(b.h) || 320));
      return `<figure class="jsrun"${at} data-code="${esc(JSON.stringify(code))}"${b.auto ? ' data-auto="1"' : ''}>
      <div class="jsrun-hd"><span class="tag">${b.draw ? 'ภาพเคลื่อนไหว' : 'JavaScript'}</span>
        <span class="note">รันในกล่องแยก ไม่แตะหน้านี้ · ต่อเน็ตไม่ได้</span>
        <button type="button" class="jsrun-stop" hidden>■ หยุด</button>
        <button type="button" class="jsrun-go">▶ กดเพื่อรัน</button></div>
      ${b.draw ? `<div class="jsrun-stage" style="height:${h}px"><div class="ph">กด ▶ เพื่อดูภาพเคลื่อนไหว</div></div>` : ''}
      <details class="jsrun-src"${b.draw ? '' : ' open'}><summary>ดูโค้ด</summary><pre><code>${esc(code)}</code></pre></details>
      <div class="jsrun-out" hidden></div>
    </figure>`;
    }
    case 'image': {
      if (!b.src) return '';
      const cap = plain(b.cap);
      return `<figure><img src="${esc(b.src)}" alt="${esc(cap || b.name || 'ภาพประกอบ')}" loading="lazy">`
        + (cap ? `<figcaption>${esc(cap)}</figcaption>` : '') + '</figure>';
    }
    case 'pdf': {
      if (!b.url) return '';
      return `<a class="doc" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">`
        + `<span class="doc-ic">📕</span><span><b>${esc(b.name || 'เอกสาร')}</b>`
        + (b.meta ? `<small>${esc(b.meta)}</small>` : '') + '</span></a>';
    }
    case 'alert': {
      const lv = b.level === 'danger' ? 'danger' : b.level === 'warn' ? 'warn' : 'info';
      const ic = lv === 'danger' ? '🔴' : lv === 'warn' ? '🟡' : '🔵';
      const body = String(b.body || '').split('\n').map(l => esc(l)).join('<br>');
      return `<div class="callout ${lv}"><div class="callout-hd">${ic} ${esc(b.title || '')}</div>`
        + (body ? `<div class="callout-bd">${body}</div>` : '') + '</div>';
    }
    case 'params': {
      const rows = (b.rows || []).map(r =>
        `<tr class="${r.oor ? 'oor' : ''}"><td>${r.oor ? '⚠️ ' : ''}${esc(r.p)}</td><td>${esc(r.set)}</td>`
        + `<td>${esc(r.rng)}</td><td>${esc(r.u)}</td><td>${esc(r.pt)}</td></tr>`).join('');
      return `<section class="pblock"><h3>${esc(b.title || 'ค่าควบคุม')}</h3>`
        + '<div class="tbl-wrap"><table><thead><tr><th>พารามิเตอร์</th><th>ค่าตั้ง</th>'
        + '<th>ช่วงปกติ</th><th>หน่วย</th><th>จุดวัด</th></tr></thead>'
        + `<tbody>${rows}</tbody></table></div></section>`;
    }
    case 'flow': {
      // วาดเป็นลูกโซ่ด้วย CSS แทน mermaid — ไม่ต้องโหลดไลบรารีภายนอกมาเรนเดอร์ให้คนอ่าน
      const steps = (b.steps || []).map((s, i, arr) =>
        `<li style="--c:${esc(s.c || BRAND)}"><span>${esc(String(s.t || '')).replace(/\n/g, '<br>')}</span>`
        + (i < arr.length - 1 ? '<i class="arw">→</i>' : '') + '</li>').join('');
      return `<section class="pblock"><h3>${esc(b.title || 'ลำดับการไหล')}</h3>`
        + `<ol class="flow">${steps}</ol></section>`;
    }
    default: return '';
  }
}

/* ══════════════ โครงหน้า ══════════════ */

const FONTS = 'https://fonts.googleapis.com/css2?family=Kanit:wght@500;600;700&family=Sarabun:wght@400;600&display=swap';

const CSS = `
:root{
  --brand:${BRAND};--brand-deep:#c24f00;--brand-soft:#fff3ea;
  --ink:#2b2119;--ink-soft:#6d6259;--paper:#faf7f4;--card:#fff;--line:#eee3d9;
  --danger:#c62828;--warn:#c77700;--info:#1565c0;--ok:#1c8a4c;
  --shadow:0 1px 2px rgba(63,37,10,.05),0 8px 24px -10px rgba(63,37,10,.16);
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:'Sarabun',system-ui,sans-serif;font-size:17px;line-height:1.85;
  -webkit-text-size-adjust:100%}
img{max-width:100%;height:auto;display:block}
a{color:var(--brand-deep)}
.top{background:var(--card);border-bottom:1px solid var(--line)}
.top .in{max-width:760px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:10px}
.logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--brand),#ff9d4d);flex:none}
.top b{font-family:'Kanit',sans-serif;font-size:16px;letter-spacing:-.01em}
.top a{margin-left:auto;font-size:14px;text-decoration:none;font-family:'Kanit',sans-serif}
main{max-width:760px;margin:0 auto;padding:34px 20px 80px}
.eyebrow{font-family:'Kanit',sans-serif;font-size:13px;color:var(--brand-deep);
  background:var(--brand-soft);display:inline-block;padding:3px 12px;border-radius:999px}
h1{font-family:'Kanit',sans-serif;font-size:clamp(27px,5.4vw,40px);line-height:1.25;
  letter-spacing:-.03em;margin:16px 0 12px}
h2{font-family:'Kanit',sans-serif;font-size:clamp(21px,3.6vw,27px);letter-spacing:-.02em;
  line-height:1.35;margin:44px 0 12px}
h2.lv1{font-size:clamp(24px,4.4vw,32px);margin-top:52px}
h3{font-family:'Kanit',sans-serif;font-size:19px;letter-spacing:-.01em;margin:32px 0 10px}
h4{font-family:'Kanit',sans-serif;font-size:16.5px;letter-spacing:-.01em;margin:26px 0 8px;
  color:var(--ink-soft)}
p{margin:0 0 18px}
ul,ol{margin:0 0 18px;padding-left:22px}li{margin-bottom:7px}
ol li::marker{font-family:'Kanit',sans-serif;color:var(--brand-deep);font-weight:600}
hr{border:0;border-top:1px solid var(--line);margin:38px 0}
ul.todo{list-style:none;padding-left:0}
ul.todo li{display:flex;gap:10px;align-items:flex-start}
ul.todo .bx{flex:none;width:19px;height:19px;border:2px solid var(--line);border-radius:6px;
  margin-top:5px;display:flex;align-items:center;justify-content:center;font-size:13px;line-height:1}
ul.todo .bx.on{background:var(--ok);border-color:var(--ok);color:#fff}
details.fold{background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:12px 16px;margin:0 0 20px;box-shadow:var(--shadow)}
details.fold summary{font-family:'Kanit',sans-serif;cursor:pointer;list-style:none}
details.fold summary::-webkit-details-marker{display:none}
details.fold summary::before{content:'▸';color:var(--brand);display:inline-block;
  margin-right:8px;transition:transform .18s ease}
details.fold[open] summary::before{transform:rotate(90deg)}
details.fold>div{padding-top:10px;color:var(--ink-soft);font-size:16px}
.meta{color:var(--ink-soft);font-size:14.5px;border-bottom:1px solid var(--line);
  padding-bottom:20px;margin-bottom:30px}
.meta .dot{opacity:.5;margin:0 7px}
.excerpt{font-size:18.5px;color:var(--ink-soft);margin:0 0 26px;line-height:1.8}
blockquote{margin:0 0 20px;padding:6px 0 6px 18px;border-left:3px solid var(--brand);
  color:var(--ink-soft)}
pre{background:#2b2119;color:#ffd9b8;padding:16px 18px;border-radius:12px;overflow-x:auto;
  font-size:14px;line-height:1.7;margin:0 0 20px}
pre code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:none;padding:0;color:inherit}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;
  background:var(--brand-soft);color:var(--brand-deep);padding:1px 6px;border-radius:6px}
.jsrun{margin:0 0 24px;border:1px solid var(--line);border-radius:14px;overflow:hidden;
  background:var(--card);box-shadow:var(--shadow)}
.jsrun-hd{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);
  flex-wrap:wrap}
.jsrun-hd .tag{font-size:11px;font-weight:700;letter-spacing:.04em;background:var(--brand-soft);
  color:var(--brand-deep);border-radius:999px;padding:3px 10px}
.jsrun-hd .note{font-size:12.5px;color:var(--ink-soft)}
.jsrun-go{margin-left:auto;border:1px solid var(--brand);background:var(--brand);color:#fff;
  border-radius:9px;padding:7px 15px;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;
  transition:transform .12s cubic-bezier(.34,1.4,.64,1)}
.jsrun-go:hover{transform:translateY(-1px)}
.jsrun-go:disabled{opacity:.55;cursor:default;transform:none}
.jsrun pre{margin:0;border-radius:0}
.jsrun-stage{background:#1b1410;border-top:1px solid var(--line);position:relative}
.jsrun-stage .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  color:#9c8f83;font-size:13px}
.jsrun-frame{display:block;width:100%;height:100%;border:0;background:#1b1410}
.jsrun-src{border-top:1px solid var(--line)}
.jsrun-src summary{cursor:pointer;padding:9px 14px;font-size:12.5px;color:var(--ink-soft);
  list-style:none}
.jsrun-src summary::-webkit-details-marker{display:none}
.jsrun-src summary::before{content:'▸ ';color:var(--brand)}
.jsrun-src[open] summary::before{content:'▾ '}
.jsrun-stop{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:9px;
  padding:7px 13px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;margin-left:auto}
.jsrun-stop + .jsrun-go{margin-left:0}
.jsrun-out{background:#1b1410;color:#e8ddd2;padding:12px 16px;font-size:13.5px;line-height:1.75;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border-top:2px solid var(--brand);
  overflow-x:auto}
.jsrun-out.bad{border-top-color:#e05e00}
.jsrun-out .ln{white-space:pre-wrap;overflow-wrap:anywhere}
.jsrun-out .ln.ret{color:#8ee6a1;font-weight:700}
.jsrun-out .ln.err{color:#ff9b8a}
.jsrun-out .ln.warn{color:#ffd166}
.jsrun-out .ln.muted{color:#9c8f83}
.jsrun-out .ms{color:#9c8f83;font-size:11.5px;margin-top:8px}
figure{margin:0 0 24px}
figure img{border-radius:14px;box-shadow:var(--shadow)}
figcaption{font-size:14px;color:var(--ink-soft);margin-top:9px;text-align:center}
.doc{display:flex;gap:12px;align-items:center;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:14px 16px;margin:0 0 20px;text-decoration:none;color:var(--ink);
  box-shadow:var(--shadow);transition:transform .16s cubic-bezier(.34,1.4,.64,1)}
.doc:hover{transform:translateY(-2px)}
.doc-ic{font-size:24px}.doc small{display:block;color:var(--ink-soft);font-size:13px}
.callout{border-radius:14px;padding:14px 18px;margin:0 0 22px;border:1px solid;
  background:var(--card);box-shadow:var(--shadow)}
.callout-hd{font-family:'Kanit',sans-serif;margin-bottom:4px}
.callout-bd{font-size:16px;line-height:1.8}
.callout.danger{border-color:#f0c2b6;background:#fdefec;color:#8c2f18}
.callout.warn{border-color:#f0dcb6;background:#fff8ec;color:#7a5300}
.callout.info{border-color:#c3d4f2;background:#eef4ff;color:#24467e}
.toc{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--brand);
  border-radius:12px;padding:14px 20px 14px 22px;margin:0 0 32px;box-shadow:var(--shadow)}
.toc b{font-family:'Kanit',sans-serif;font-size:14px;color:var(--ink-soft)}
.toc ol{margin:8px 0 0;padding-left:20px}
.toc li{margin-bottom:4px;font-size:15.5px}
.toc a{text-decoration:none}
.toc a:hover{text-decoration:underline}
html{scroll-behavior:smooth}
h2[id],h3[id]{scroll-margin-top:20px}
.pblock{margin:0 0 26px}
.tbl-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--card);
  box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;font-size:15px;min-width:480px}
th,td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--line)}
th{font-family:'Kanit',sans-serif;font-weight:600;background:#fdfbf9;font-size:14px}
tbody tr:last-child td{border-bottom:0}
tr.oor td{background:#fdefec;color:#8c2f18}
.flow{list-style:none;display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;padding:0;margin:0}
.flow li{display:flex;align-items:center;gap:10px}
.flow li>span{background:var(--c);color:#fff;border-radius:12px;padding:11px 16px;
  font-family:'Kanit',sans-serif;font-size:14.5px;line-height:1.45;box-shadow:var(--shadow)}
.flow .arw{color:var(--ink-soft);font-style:normal;font-size:19px}
/* คอลัมน์ — จอแคบยุบเป็นแถวเดียวเสมอ อ่านบนมือถือได้ */
.cols{display:grid;gap:18px;grid-template-columns:1fr;margin:0 0 20px}
@media(min-width:620px){.cols.c2{grid-template-columns:1fr 1fr}
  .cols.c3{grid-template-columns:1fr 1fr 1fr}}
.vid{margin:0 0 24px}
.vid .frame{position:relative;padding-top:56.25%;border-radius:14px;overflow:hidden;
  background:#2b2119;box-shadow:var(--shadow)}
.vid iframe,.vid video{position:absolute;inset:0;width:100%;height:100%;border:0}
figure.chart{margin:0 0 26px;background:var(--card);border:1px solid var(--line);
  border-radius:14px;padding:16px;box-shadow:var(--shadow)}
figure.chart details.fold{margin:12px 0 0;box-shadow:none;background:transparent}
figure.chart .chart-scroll{overflow-x:auto}
figure.chart .chart-scroll svg{min-width:600px}
.cards{display:grid;gap:14px;grid-template-columns:1fr}
@media(min-width:680px){.cards{grid-template-columns:1fr 1fr}}
.card{display:flex;flex-direction:column;align-items:flex-start;background:var(--card);
  border:1px solid var(--line);border-radius:16px;
  padding:18px 20px;text-decoration:none;color:var(--ink);box-shadow:var(--shadow);
  transition:transform .16s cubic-bezier(.34,1.4,.64,1)}
.card:hover{transform:translateY(-3px)}
.card h2{font-size:19px;margin:9px 0 7px;letter-spacing:-.01em}
.card p{font-size:15px;color:var(--ink-soft);margin:0 0 14px;line-height:1.7}
.card .when{font-size:13px;color:var(--ink-soft);margin-top:auto;padding-top:4px}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:16px;padding:34px;
  text-align:center;color:var(--ink-soft)}
.foot{max-width:760px;margin:0 auto;padding:0 20px 60px;color:var(--ink-soft);font-size:13.5px}
.back{display:block;width:fit-content;margin-bottom:20px;font-family:'Kanit',sans-serif;
  font-size:14px;text-decoration:none}
.back:hover{text-decoration:underline}
:focus-visible{outline:3px solid var(--brand);outline-offset:2px;border-radius:6px}
`;

function shell({ title, desc, image, url, body, noindex = true, script = '' }) {
  const og = [
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${esc(title)}">`,
    desc ? `<meta property="og:description" content="${esc(desc)}">` : '',
    url ? `<meta property="og:url" content="${esc(url)}">` : '',
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    `<meta property="og:site_name" content="SPP-MP คลังความรู้ฝ่ายผลิต">`,
    image ? `<meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`,
  ].filter(Boolean).join('\n  ');
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  ${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
  ${noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
  ${og}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${FONTS}">
  <style>${CSS}</style>
</head>
<body>
  <header class="top"><div class="in">
    <span class="logo"></span><b>SPP-MP</b>
    <a href="/บทความ">บทความทั้งหมด</a>
  </div></header>
  ${body}
  ${script}
</body>
</html>`;
}

/* ══════════════ ตัวรันโค้ดของหน้าอ่าน ══════════════
   ⚠️ ต้องเหมือนกับ client/src/lib/runJs.ts — หน้าอ่านไม่ได้ผ่าน bundler เลยต้องมีสำเนา
      แก้ที่ไหนต้องแก้อีกที่ (กติกาเดียวกับคู่ toMarkdown() / postToMarkdown())
   โค้ดของคนเขียนรันใน <iframe sandbox="allow-scripts"> ที่ไม่มี allow-same-origin
   ⚠️ ห้ามเติม allow-same-origin — ใส่คู่กับ allow-scripts เมื่อไหร่กล่องกันพังทันที */
const sandboxHtml = (draw) => `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:${draw ? '#1b1410' : 'transparent'};
color:#e8ddd2;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}</style><body><script>
(function () {
  var out = [];
  function fmt(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message;
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  function push(k, args) { out.push({ k: k, v: [].map.call(args, fmt).join(' ') }); }
  console.log = function () { push('log', arguments); };
  console.info = function () { push('log', arguments); };
  console.warn = function () { push('warn', arguments); };
  console.error = function () { push('err', arguments); };

  // ปิดทางออกเน็ตให้อ่านรู้เรื่อง — ตัวกันจริงคือ CSP ข้างบน อันนี้ไว้บอกเหตุผลตอนเรียก
  var NO_NET = 'บล็อกนี้ต่อเน็ตไม่ได้ — โค้ดในบทความถูกตัดขาดจากเครือข่ายทั้งหมด';
  function blocked() { throw new Error(NO_NET); }
  try {
    window.fetch = blocked;
    window.XMLHttpRequest = blocked;
    window.WebSocket = blocked;
    window.EventSource = blocked;
    if (window.navigator && navigator.sendBeacon) navigator.sendBeacon = blocked;
    window.Worker = blocked;
    window.importScripts = blocked;
  } catch (e) { /* เบราว์เซอร์บางตัวห้ามเขียนทับ — CSP ยังกันอยู่ */ }

  function done(err) { parent.postMessage({ spp: 'js-result', out: out, err: err || '' }, '*'); }
  window.addEventListener('message', function (e) {
    var code = e.data && e.data.spp === 'js-run' ? e.data.code : null;
    if (typeof code !== 'string') return;
    var run;
    try {
      run = new Function('"use strict"; return (async function () {\\n' + code + '\\n})()');
    } catch (ex) { return done('โค้ดผิดไวยากรณ์ — ' + (ex && ex.message || ex)); }
    try {
      Promise.resolve(run()).then(
        function (v) { if (v !== undefined) push('ret', [v]); done(''); },
        function (ex) { done(String(ex && ex.message || ex)); }
      );
    } catch (ex) { done(String(ex && ex.message || ex)); }
  });
  parent.postMessage({ spp: 'js-ready' }, '*');
})();
</script>`;

// ฝังสตริงลงในสคริปต์ของหน้า — ต้องหนี "</" เป็น "<\/" ไม่งั้น </script> ข้างในไปปิดแท็กของหน้า
const bootLiteral = (draw) => JSON.stringify(sandboxHtml(draw)).replace(/<\//g, '<\\/');

const JS_RUNTIME = () => `<script>
(function () {
  var BOOT = { calc: ${bootLiteral(false)}, draw: ${bootLiteral(true)} };
  var TIMEOUT = 3000;

  // mount = ช่องที่จะให้กล่องโผล่ (โหมดวาดภาพ) · ไม่ส่ง = ซ่อนแล้วเก็บทิ้งหลังได้ผล
  function run(code, mount, cb) {
    var t0 = Date.now();
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'กล่องรันโค้ดของบทความ');
    if (mount) {
      frame.className = 'jsrun-frame';
      mount.innerHTML = '';
      mount.appendChild(frame);
    } else {
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px;top:-9999px';
      document.body.appendChild(frame);
    }
    frame.srcdoc = mount ? BOOT.draw : BOOT.calc;
    var done = false;
    function kill() {
      window.removeEventListener('message', onMsg);
      frame.parentNode && frame.parentNode.removeChild(frame);
    }
    function finish(r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!mount || r.error) kill();
      r.stop = kill;
      cb(r);
    }
    function onMsg(e) {
      if (e.source !== frame.contentWindow) return;
      var d = e.data || {};
      if (d.spp === 'js-ready') { frame.contentWindow.postMessage({ spp: 'js-run', code: code }, '*'); return; }
      if (d.spp === 'js-result') finish({ lines: d.out || [], error: d.err || '', ms: Date.now() - t0 });
    }
    var timer = setTimeout(function () {
      finish({ lines: [], error: 'รันเกิน 3 วินาที — หยุดให้แล้ว (โค้ดอาจวนไม่รู้จบ)', ms: TIMEOUT });
    }, TIMEOUT);
    window.addEventListener('message', onMsg);
  }

  function show(box, r) {
    var html = r.lines.map(function (l) {
      var t = document.createElement('div');
      t.className = 'ln ' + l.k;
      t.textContent = (l.k === 'ret' ? '⟶ ' : '') + l.v;
      return t.outerHTML;
    }).join('');
    if (r.error) {
      var e = document.createElement('div');
      e.className = 'ln err';
      e.textContent = '✕ ' + r.error;
      html += e.outerHTML;
    } else if (!r.lines.length) {
      box.hidden = true;
      return;
    }
    box.innerHTML = html + '<div class="ms">ใช้เวลา ' + r.ms + ' ms</div>';
    box.className = 'jsrun-out' + (r.error ? ' bad' : '');
    box.hidden = false;
  }

  [].forEach.call(document.querySelectorAll('.jsrun'), function (fig) {
    var btn = fig.querySelector('.jsrun-go');
    var stopBtn = fig.querySelector('.jsrun-stop');
    var box = fig.querySelector('.jsrun-out');
    var stage = fig.querySelector('.jsrun-stage');
    var live = null;
    var code;
    try { code = JSON.parse(fig.getAttribute('data-code') || '""'); } catch (e) { code = ''; }

    function stop() {
      if (live) { live(); live = null; }
      if (stage) stage.innerHTML = '<div class="ph">กด ▶ เพื่อดูภาพเคลื่อนไหวอีกครั้ง</div>';
      if (stopBtn) stopBtn.hidden = true;
      btn.textContent = '▶ กดเพื่อรัน';
    }
    function go() {
      if (live) { live(); live = null; }
      btn.disabled = true;
      btn.textContent = 'กำลังรัน…';
      run(code, stage, function (r) {
        show(box, r);
        btn.disabled = false;
        if (stage && !r.error) {
          live = r.stop;
          if (stopBtn) stopBtn.hidden = false;
          btn.textContent = '↻ เริ่มใหม่';
        } else {
          btn.textContent = '▶ รันอีกครั้ง';
        }
      });
    }
    btn.addEventListener('click', go);
    if (stopBtn) stopBtn.addEventListener('click', stop);
    if (fig.getAttribute('data-auto') === '1') go();
  });
})();
</script>`;

/* ══════════════ หน้าต่าง ๆ ══════════════ */

function renderArticle(post, baseUrl) {
  // ติดจุดยึดให้หัวข้อทุกอันก่อน แล้วค่อยทำสารบัญชี้มา (คนเขียนตั้ง anchor เองไว้ก็ใช้ของเขา)
  const src = (post.blocks || []).map((b, i) =>
    (['h1', 'h2', 'h3'].includes(b.type) && !b.anchor) ? { ...b, anchor: `sec-${i}` } : b);
  const heads = src.filter(b => b.type === 'h1' || b.type === 'h2');
  const toc = heads.length >= 3
    ? `<nav class="toc"><b>ในบทความนี้</b><ol>${heads.map(h =>
      `<li><a href="#${esc(String(h.anchor).replace(/[^a-zA-Z0-9_-]/g, ''))}">${esc(plain(h.html))}</a></li>`).join('')}</ol></nav>`
    : '';
  const blocks = toc + '\n' + src.map(renderBlock).join('\n');
  const firstImg = (post.blocks || []).find(b => b.type === 'image' && b.src);
  const desc = post.excerpt || plain((post.blocks || []).find(b => b.type === 'p')?.html).slice(0, 180);
  const when = thaiDate(post.publishedAt || post.updatedAt);
  const body = `<main>
    <a class="back" href="/บทความ">← บทความทั้งหมด</a>
    ${post.category ? `<div class="eyebrow">${esc(post.category)}</div>` : ''}
    <h1>${esc(post.title)}</h1>
    <div class="meta">${post.author ? `โดย ${esc(post.author)}` : ''}${post.author && when ? '<span class="dot">·</span>' : ''}${when || ''}${post.machine ? `<span class="dot">·</span>${esc(post.machine)}` : ''}</div>
    ${post.excerpt ? `<p class="excerpt">${esc(post.excerpt)}</p>` : ''}
    ${post.coverUrl ? `<figure><img src="${esc(post.coverUrl)}" alt="${esc(post.title)}"></figure>` : ''}
    ${blocks}
  </main>
  <div class="foot">เอกสารภายในของทีมผลิต SPP-MP · เขียนจากระบบบันทึกการผลิต &amp; CIP</div>`;
  return shell({
    title: post.title,
    desc,
    image: post.coverUrl || (firstImg && firstImg.src) || '',
    url: `${baseUrl}/บทความ/${encodeURIComponent(post.slug)}`,
    body,
    // ใส่ตัวรันเฉพาะบทความที่มีบล็อกรันได้จริง บทความอื่นไม่ต้องแบกสคริปต์นี้
    script: src.some(b => b.type === 'js') ? JS_RUNTIME() : '',
  });
}

function renderIndex(posts, baseUrl) {
  const cards = posts.map(p => `<a class="card" href="/บทความ/${encodeURIComponent(p.slug)}">
      ${p.category ? `<span class="eyebrow">${esc(p.category)}</span>` : ''}
      <h2>${esc(p.title)}</h2>
      ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
      <div class="when">${[p.author ? `โดย ${esc(p.author)}` : '', thaiDate(p.publishedAt || p.updatedAt)].filter(Boolean).join(' · ')}</div>
    </a>`).join('\n');
  const body = `<main>
    <h1>บทความ / คู่มือระบบ</h1>
    <p class="excerpt">เรื่องที่ทีมผลิตเขียนอธิบายระบบและขั้นตอนการทำงาน</p>
    ${posts.length ? `<div class="cards">${cards}</div>` : '<div class="empty">ยังไม่มีบทความที่เผยแพร่</div>'}
  </main>
  <div class="foot">เอกสารภายในของทีมผลิต SPP-MP</div>`;
  return shell({
    title: 'บทความ / คู่มือระบบ — SPP-MP',
    desc: 'คลังความรู้ของทีมผลิต SPP-MP',
    url: `${baseUrl}/บทความ`,
    body,
  });
}

function renderNotFound() {
  return shell({
    title: 'ไม่พบบทความนี้ — SPP-MP',
    body: `<main><h1>ไม่พบบทความนี้</h1>
      <p class="excerpt">อาจถูกลบไปแล้ว หรือยังไม่ได้เผยแพร่</p>
      <a class="back" href="/บทความ">← ดูบทความทั้งหมด</a></main>`,
  });
}

module.exports = { renderArticle, renderIndex, renderNotFound };
