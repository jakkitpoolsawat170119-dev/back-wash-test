// ─── หน้าอ่านบทความสาธารณะ (เฟส 5) ───────────────────────────────────────────
// เสิร์ฟจากเซิร์ฟเวอร์เป็น HTML เต็มหน้า ไม่ใช่ SPA เพราะ
//   1. ต้องมี og: meta ตอนแชร์เข้า LINE/Telegram ถึงจะขึ้นการ์ดพรีวิว
//      (SPA ใส่ meta ตอน runtime ไม่ทัน — ตัวดูดพรีวิวอ่าน HTML ดิบอย่างเดียว)
//   2. คนอ่านไม่ต้องล็อกอิน ไม่ต้องโหลด bundle ของแอปทั้งก้อน
// เห็นเฉพาะบทความที่ status='published' — ร่างเปิดไม่ได้

const vault = require('./vault');
const chartSvg = require('./chartSvg');

const BRAND = '#ff6b00';

/* ══════════════ หมวดหมู่ ══════════════
   ต้องตรงกับ CATEGORIES ใน client/src/components/BlogEditor.tsx — แก้ที่ไหนต้องแก้อีกที่
   สี/สัญลักษณ์ใช้ทั้งจุดสีในเมนู ป้ายหมวด และ "พื้นวาดแทนรูปหน้าปก" ของบทความที่ไม่ได้ตั้งรูป
   (ยึดจากหมวด ไม่สุ่ม — บทความเดิมเปิดกี่ครั้งก็หน้าตาเดิม) */
const CATS = [
  { name: 'ระบบ CIP', color: '#ff6b00', g: 'g0', ic: '💧' },
  { name: 'Boiler', color: '#1565c0', g: 'g1', ic: '🔥' },
  { name: 'Evaporator', color: '#0f7a6c', g: 'g2', ic: '🧪' },
  { name: 'Mixing / Syrup', color: '#6a1b9a', g: 'g3', ic: '🍯' },
  { name: 'บรรจุ', color: '#1c8a4c', g: 'g4', ic: '📦' },
  { name: 'ความปลอดภัย', color: '#c77700', g: 'g5', ic: '🦺' },
  { name: 'ชีวิตและการทำงาน', color: '#c2185b', g: 'g6', ic: '🌱' },
  { name: 'หนังสือ', color: '#6d4c41', g: 'g7', ic: '📖' },
  { name: 'คู่มือ / SOP', color: '#0f7a6c', g: 'g8', ic: '📘' },
];
const catStyle = (name) => CATS.find(c => c.name === name) || { name, color: '#6d6259', g: 'g0', ic: '📄' };
const catHref = (name) => name ? `/บทความ?cat=${encodeURIComponent(name)}` : '/บทความ';

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
      ${b.hideSrc ? ''   /* คนเขียนสั่งให้ซ่อนโค้ด — เห็นแต่ผลลัพธ์ (โค้ดยังอยู่ใน data-code เพราะต้องใช้รัน) */
    : `<details class="jsrun-src"${b.draw ? '' : ' open'}><summary>ดูโค้ด</summary><pre><code>${esc(code)}</code></pre></details>`}
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
.top .tsub{color:var(--ink-soft);font-size:12.5px}
@media(max-width:560px){.top .tsub{display:none}}
/* เจาะจงลูกตรงเท่านั้น — ไม่งั้นลิงก์ในเมนูย่อยโดนดันไปชิดขวาตามไปด้วย */
.top .in>a{margin-left:auto;font-size:14px;text-decoration:none;font-family:'Kanit',sans-serif}
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

/* ══════ หน้ารายชื่อบทความ ══════ */
.wide{max-width:1120px !important}
/* เมนูบทความ + เมนูย่อยบนหัวหน้า */
.amenu{position:relative;margin-left:14px}
.ambtn{border:none;background:transparent;color:var(--ink-soft);font:inherit;font-family:'Kanit',sans-serif;
  font-size:14.5px;font-weight:600;padding:7px 14px;border-radius:999px;cursor:pointer;
  display:flex;align-items:center;gap:6px;transition:background-color .15s ease,color .15s ease}
.ambtn:hover{background:#f7f1ea;color:var(--ink)}
.ambtn .caret{font-size:10px;opacity:.6;transition:transform .18s ease}
.amenu.open .ambtn{background:var(--brand-soft);color:var(--brand-deep)}
.amenu.open .ambtn .caret{transform:rotate(180deg)}
.amdd{position:absolute;top:calc(100% + 9px);left:0;z-index:70;width:min(430px,calc(100vw - 28px));
  background:var(--card);border:1px solid var(--line);border-radius:18px;padding:8px;
  box-shadow:0 2px 4px rgba(63,37,10,.08),0 16px 40px -12px rgba(63,37,10,.22);
  display:none;opacity:0;transform:translateY(-6px);transition:opacity .16s ease,transform .16s ease}
.amenu.open .amdd{display:block;opacity:1;transform:translateY(0)}
.amhd{padding:8px 10px 6px;font-family:'Kanit',sans-serif;font-weight:600;font-size:13px}
.amhd span{font-family:'Sarabun',sans-serif;font-weight:400;font-size:11.5px;color:var(--ink-soft);margin-left:6px}
.amgrid{display:grid;grid-template-columns:1fr 1fr;gap:2px}
.amgrid a{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:11px;text-decoration:none;
  color:var(--ink);font-family:'Kanit',sans-serif;font-size:13.5px;font-weight:600;
  transition:background-color .15s ease,color .15s ease}
.amgrid a:hover{background:var(--brand-soft);color:var(--brand-deep)}
.amgrid .cdot{width:9px;height:9px;border-radius:3px;flex:none}
.amgrid .n{margin-left:auto;font-family:'Sarabun',sans-serif;font-size:11.5px;font-weight:400;color:var(--ink-soft)}
.amsep{height:1px;background:var(--line);margin:7px 6px}
.amfoot{padding:2px 6px 4px}
.amfoot a{display:block;text-align:center;padding:9px;border-radius:11px;text-decoration:none;
  font-family:'Kanit',sans-serif;font-size:13px;font-weight:600;background:var(--brand);color:#fff;
  transition:background-color .15s ease}
.amfoot a:hover{background:var(--brand-deep)}
@media(max-width:520px){.amgrid{grid-template-columns:1fr}}

.hero{border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fff8f2,transparent)}
.hero .in{max-width:1120px;margin:0 auto;padding:26px 20px 22px}
.hero h1{margin:9px 0 6px}
.hero p{font-size:15.5px;color:var(--ink-soft);margin:0;max-width:640px}
.shead{display:flex;align-items:flex-end;gap:12px;margin:30px 0 14px;flex-wrap:wrap}
.shead h2{margin:0;font-size:clamp(19px,2.6vw,23px)}
.shead .sub{font-size:13.5px;color:var(--ink-soft)}

/* คารูเซลบทความแนะนำ */
.car{position:relative}
.track{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;
  -webkit-overflow-scrolling:touch;padding:4px 0 6px}
.track::-webkit-scrollbar{display:none}
.slide{flex:0 0 100%;scroll-snap-align:center;min-width:0}
.feat{display:grid;grid-template-columns:1fr;background:var(--card);border:1px solid var(--line);
  border-radius:22px;overflow:hidden;box-shadow:var(--shadow);text-decoration:none;color:var(--ink);
  transition:transform .18s cubic-bezier(.2,.9,.3,1.3)}
.feat:hover{transform:translateY(-2px)}
@media(min-width:820px){.feat{grid-template-columns:1.15fr 1fr}}
.feat .shot{position:relative;min-height:210px;overflow:hidden}
@media(min-width:820px){.feat .shot{min-height:278px}}
.feat .acbody{padding:24px 26px 26px;display:flex;flex-direction:column;gap:11px;justify-content:center}
.feat h2{margin:0;font-size:clamp(20px,2.7vw,27px);letter-spacing:-.03em;line-height:1.32}
.feat p{margin:0;font-size:15px;color:var(--ink-soft);line-height:1.75}
.feat .ameta{margin-top:14px}
.rank{position:absolute;top:14px;left:14px;z-index:2;background:rgba(43,33,25,.72);color:#fff;
  font-family:'Kanit',sans-serif;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:999px}
.carbtn{position:absolute;top:50%;transform:translateY(-50%);z-index:5;width:42px;height:42px;border-radius:50%;
  border:1px solid var(--line);background:rgba(255,255,255,.94);box-shadow:var(--shadow);cursor:pointer;
  font-size:17px;color:var(--ink);display:grid;place-items:center;transition:transform .14s ease}
.carbtn:hover{transform:translateY(-50%) scale(1.06)}
.carbtn.prev{left:-8px}.carbtn.next{right:-8px}
@media(max-width:760px){.carbtn{display:none}}
.cardock{display:flex;align-items:center;gap:12px;margin-top:12px}
.dots{display:flex;gap:7px}
.dots button{width:8px;height:8px;padding:0;border:none;border-radius:999px;background:#e0d3c6;cursor:pointer;
  transition:width .2s ease,background-color .2s ease}
.dots button.on{width:26px;background:var(--brand)}
.bar{flex:1;max-width:180px;height:3px;border-radius:999px;background:#e9ddd1;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:var(--brand);border-radius:999px}
.playbtn{margin-left:auto;border:1px solid var(--line);background:var(--card);color:var(--ink-soft);
  font:inherit;font-family:'Kanit',sans-serif;font-size:12px;font-weight:600;padding:5px 12px;
  border-radius:999px;cursor:pointer;transition:background-color .15s ease,color .15s ease}
.playbtn:hover{background:#f7f1ea;color:var(--ink)}

/* ช่องค้นหา + แบ่งหน้า */
.asearch{display:flex;gap:8px;align-items:center;margin:0 0 12px;flex-wrap:wrap}
.asearch input[type=search]{flex:1 1 260px;min-width:0;border:1px solid var(--line);background:var(--card);
  border-radius:12px;padding:11px 14px;font-family:'Sarabun',sans-serif;font-size:14px;color:var(--ink)}
.asearch input[type=search]:focus{outline:2px solid #ffb877;outline-offset:1px}
.asearch button{border:1px solid var(--line);background:var(--ink);color:#fff;border-radius:12px;
  padding:11px 20px;font-family:'Kanit',sans-serif;font-size:14px;font-weight:600;cursor:pointer}
.asearch .clr{color:var(--ink-soft);text-decoration:none;font-size:13px;padding:6px 4px}
.pager{display:flex;gap:6px;justify-content:center;align-items:center;flex-wrap:wrap;margin:26px 0 4px}
.pg{border:1px solid var(--line);background:var(--card);color:var(--ink-soft);text-decoration:none;
  min-width:38px;text-align:center;border-radius:10px;padding:8px 12px;font-family:'Kanit',sans-serif;
  font-size:13.5px;font-weight:600}
.pg:hover{background:#f7f1ea;color:var(--ink)}
.pg.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.pgdot{color:var(--ink-soft);padding:0 2px}

/* แถบกรองหมวด */
.chips{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;padding:2px 0 6px}
.chips::-webkit-scrollbar{display:none}
.chip{border:1px solid var(--line);background:var(--card);color:var(--ink-soft);white-space:nowrap;
  text-decoration:none;font-family:'Kanit',sans-serif;font-size:13px;font-weight:600;padding:7px 15px;
  border-radius:999px;display:flex;align-items:center;gap:7px;transition:background-color .15s ease,color .15s ease}
.chip:hover{background:#f7f1ea;color:var(--ink)}
.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.chip .cdot{width:8px;height:8px;border-radius:3px;flex:none}
.chip .n{font-family:'Sarabun',sans-serif;font-weight:400;font-size:11.5px;opacity:.7}

/* การ์ดพรีวิว */
.agrid{display:grid;gap:16px;grid-template-columns:1fr;margin-top:14px}
@media(min-width:640px){.agrid{grid-template-columns:1fr 1fr}}
@media(min-width:1000px){.agrid{grid-template-columns:repeat(3,1fr)}}
.acard{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);
  border-radius:18px;overflow:hidden;box-shadow:var(--shadow);text-decoration:none;color:var(--ink);height:100%;
  transition:transform .18s cubic-bezier(.2,.9,.3,1.3),border-color .15s ease}
.acard:hover{transform:translateY(-3px);border-color:#e6d3c1}
.acard .shot{position:relative;aspect-ratio:16/9;overflow:hidden}
.acard .acbody{display:flex;flex-direction:column;gap:8px;padding:15px 17px 16px;flex:1}
.acard h2{margin:0;font-size:16.5px;font-weight:600;line-height:1.42;overflow-wrap:anywhere}
.acard p{margin:0;font-size:13.5px;color:var(--ink-soft);line-height:1.65;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* 🔴 รูปต้องเป็น absolute — ไม่งั้น height:100% ตกเป็น auto แล้วรูปกลายเป็นตัวกำหนดความสูงแถว
   (การ์ดใหญ่จะสูงตามอัตราส่วนรูปแทนที่จะสูงตามเนื้อหา) */
.shot img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;
  border-radius:0;box-shadow:none;transition:transform .5s cubic-bezier(.2,.9,.3,1)}
.acard:hover .shot img,.feat:hover .shot img{transform:scale(1.045)}
.shot::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(to top,rgba(43,33,25,.42),rgba(43,33,25,.06) 45%,transparent 70%)}
.shot .cat{position:absolute;left:12px;bottom:11px;z-index:2;font-family:'Kanit',sans-serif;font-size:11.5px;
  font-weight:600;color:#fff;background:rgba(43,33,25,.5);padding:4px 11px;border-radius:999px}
.feat .shot .cat{left:14px;bottom:14px;font-size:12.5px;padding:5px 13px}
/* ไม่มีรูปหน้าปก = วาดพื้นให้ตามหมวด */
.shot.gen{display:grid;place-items:center}
.shot.gen .art{position:absolute;inset:0}
.shot.gen .art::before{content:"";position:absolute;inset:0;
  background:radial-gradient(120% 90% at 12% 8%,rgba(255,255,255,.42),transparent 55%),
             radial-gradient(90% 70% at 92% 96%,rgba(0,0,0,.22),transparent 60%)}
.shot.gen .art::after{content:"";position:absolute;inset:0;opacity:.16;
  background-image:repeating-linear-gradient(115deg,rgba(255,255,255,.5) 0 1.5px,transparent 1.5px 13px)}
.shot.gen .glyph{position:relative;z-index:1;font-size:54px;line-height:1;
  filter:drop-shadow(0 6px 14px rgba(43,33,25,.32))}
.feat .shot.gen .glyph{font-size:80px}
.shot.gen.g0{background:linear-gradient(140deg,#ff8a2b,#e05e00 55%,#c24f00)}
.shot.gen.g1{background:linear-gradient(140deg,#3f8fdc,#1565c0 55%,#0d3f7d)}
.shot.gen.g2{background:linear-gradient(140deg,#22a894,#0f7a6c 55%,#0a5348)}
.shot.gen.g3{background:linear-gradient(140deg,#9a4fc4,#6a1b9a 55%,#48136a)}
.shot.gen.g4{background:linear-gradient(140deg,#37b06a,#1c8a4c 55%,#125c33)}
.shot.gen.g5{background:linear-gradient(140deg,#e0a52f,#c77700 55%,#8c5400)}
.shot.gen.g6{background:linear-gradient(140deg,#e0568f,#c2185b 55%,#7d0f3a)}
.shot.gen.g7{background:linear-gradient(140deg,#a1887f,#6d4c41 55%,#42291f)}
.shot.gen.g8{background:linear-gradient(140deg,#4db6a4,#0f7a6c 55%,#064a41)}
.tags{display:flex;flex-wrap:wrap;gap:5px}
.tg{font-size:11.5px;font-weight:600;color:var(--ink-soft);background:#f6f0e9;padding:2px 9px;border-radius:999px}
.ameta{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:11px;
  border-top:1px dashed var(--line);font-size:12.5px;color:var(--ink-soft)}
.ameta .av{width:24px;height:24px;border-radius:50%;flex:none;display:grid;place-items:center;
  font-family:'Kanit',sans-serif;font-size:11.5px;font-weight:600;color:#fff}
.ameta .who{font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ameta .when{margin-left:auto;white-space:nowrap}
@media(prefers-reduced-motion:reduce){*{animation-duration:.01ms !important;transition-duration:.01ms !important}}
`;

/* เมนูบทความ + เมนูย่อย 6 หมวด — อยู่บนหัวทุกหน้า (รายชื่อและตัวบทความ)
   counts ส่งมาเฉพาะหน้ารายชื่อที่รู้จำนวนจริง หน้าอื่นโชว์แค่ชื่อหมวด */
function articleMenu(counts) {
  const items = CATS.map(c => {
    const n = counts ? (counts[c.name] || 0) : null;
    return `<a href="${esc(catHref(c.name))}"><span class="cdot" style="background:${c.color}"></span>${esc(c.name)}${
      n === null ? '' : `<span class="n">${n}</span>`}</a>`;
  }).join('');
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  return `<div class="amenu" id="amenu">
    <button class="ambtn" id="ambtn" aria-expanded="false" aria-controls="amdd">📚 บทความ <span class="caret">▾</span></button>
    <div class="amdd" id="amdd">
      <div class="amhd">เลือกหมวดหมู่${total === null ? '' : `<span>${total} เรื่องที่เผยแพร่แล้ว</span>`}</div>
      <div class="amgrid">${items}</div>
      <div class="amsep"></div>
      <div class="amfoot"><a href="/บทความ">ดูบทความทั้งหมด →</a></div>
    </div>
  </div>`;
}

const MENU_SCRIPT = `<script>
(function(){
  var w=document.getElementById('amenu'),b=document.getElementById('ambtn');
  if(!w||!b)return;
  b.addEventListener('click',function(e){
    e.stopPropagation();
    var on=w.classList.toggle('open');
    b.setAttribute('aria-expanded',on?'true':'false');
  });
  document.addEventListener('click',function(e){
    if(!e.target.closest('#amenu')){w.classList.remove('open');b.setAttribute('aria-expanded','false');}
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){w.classList.remove('open');b.setAttribute('aria-expanded','false');}
  });
})();
</script>`;

function shell({ title, desc, image, url, body, noindex = true, script = '', wide = false, counts = null }) {
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
  <header class="top"><div class="in${wide ? ' wide' : ''}">
    <span class="logo"></span><b>SPP-MP</b><span class="tsub">· คลังความรู้ฝ่ายผลิต</span>
    ${articleMenu(counts)}
  </div></header>
  ${body}
  ${MENU_SCRIPT}
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

function renderArticle(post, baseUrl, opts = {}) {
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
  // ดูร่าง: บอกให้ชัดว่านี่ยังไม่เผยแพร่ คนที่ได้ลิงก์ไปจะได้ไม่เข้าใจผิดว่าขึ้นเว็บแล้ว
  const draftBar = opts.draft
    ? `<div style="background:#fff3ea;border:1px solid #f0d8c0;border-radius:12px;padding:10px 14px;
         margin-bottom:16px;font-size:14px;color:#a15c00">
         👀 <b>นี่คือฉบับร่าง</b> — ยังไม่ได้เผยแพร่ คนอื่นเปิดลิงก์ปกติจะยังไม่เห็นเรื่องนี้
       </div>` : '';
  const body = `<main>
    <a class="back" href="/บทความ">← บทความทั้งหมด</a>
    ${draftBar}
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

/* ══════════════ ชิ้นส่วนของหน้ารายชื่อ ══════════════ */

// ช่องรูปหน้าปก — มีรูปก็ใช้รูป ไม่มีก็วาดพื้นไล่สีตามหมวดให้ (ไม่ปล่อยให้เป็นช่องว่างโหว่)
function cover(p, rank = '') {
  const c = catStyle(p.category);
  const tag = rank ? `<span class="rank">${esc(rank)}</span>` : '';
  const badge = p.category ? `<span class="cat">${esc(p.category)}</span>` : '';
  const inner = p.coverUrl
    ? `<img src="${esc(p.coverUrl)}" alt="" loading="lazy">`
    : `<span class="art"></span><span class="glyph">${c.ic}</span>`;
  return `<div class="shot${p.coverUrl ? '' : ` gen ${c.g}`}">${tag}${inner}${badge}</div>`;
}

function metaLine(p) {
  const c = catStyle(p.category);
  const who = String(p.author || '').trim();
  const av = who ? `<span class="av" style="background:${c.color}">${esc(who.slice(0, 1))}</span>` : '';
  return `<div class="ameta">${av}<span class="who">${esc(who || 'ทีมผลิต')}</span>
    <span class="when">${thaiDate(p.publishedAt || p.updatedAt)}</span></div>`;
}

const tagRow = (p) => (p.tags || []).length
  ? `<div class="tags">${p.tags.slice(0, 3).map(t => `<span class="tg">#${esc(t)}</span>`).join('')}</div>`
  : '';

const articleCard = (p) => `<a class="acard" href="/บทความ/${encodeURIComponent(p.slug)}">
  ${cover(p)}
  <div class="acbody">
    <h2>${esc(p.title)}</h2>
    ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
    ${tagRow(p)}
    ${metaLine(p)}
  </div>
</a>`;

const featSlide = (p, i, n) => `<div class="slide"><a class="feat" href="/บทความ/${encodeURIComponent(p.slug)}">
  ${cover(p, i === 0 ? '⭐ ใหม่ล่าสุด' : `${i + 1} / ${n}`)}
  <div class="acbody">
    <h2>${esc(p.title)}</h2>
    ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
    ${tagRow(p)}
    ${metaLine(p)}
  </div>
</a></div>`;

// เลื่อนเองทุก 5 วิ · หยุดเมื่อเอาเมาส์วาง/แตะ แล้วเดินต่อเองหลัง 6 วิ · เครื่องที่ตั้งลดการเคลื่อนไหวไม่เลื่อนเอง
const CAR_SCRIPT = `<script>
(function(){
  var track=document.getElementById('track'),car=document.getElementById('car');
  if(!track||!car)return;
  var slides=[].slice.call(track.children),dotbox=document.getElementById('dots'),bar=document.getElementById('bar');
  var i=0,t0=performance.now(),paused=false,rt=null;
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches,playing=!reduce;
  slides.forEach(function(_,k){
    var d=document.createElement('button');
    d.type='button';d.setAttribute('aria-label','ไปเรื่องที่ '+(k+1));
    d.addEventListener('click',function(){go(k);nudge();});
    dotbox.appendChild(d);
  });
  var dots=[].slice.call(dotbox.children);
  function paint(){dots.forEach(function(d,k){d.classList.toggle('on',k===i);});}
  paint();                       // ต้องระบายรอบแรกเอง ไม่งั้นจุดแรกไม่ติดจนกว่าจะเลื่อนครั้งแรก
  function go(k){
    i=(k+slides.length)%slides.length;
    track.scrollTo({left:slides[i].offsetLeft-track.offsetLeft,behavior:'smooth'});
    t0=performance.now();paint();
  }
  var st;
  track.addEventListener('scroll',function(){
    clearTimeout(st);
    st=setTimeout(function(){
      var mid=track.scrollLeft+track.clientWidth/2,best=0,bd=1e9;
      slides.forEach(function(s,k){
        var c=s.offsetLeft-track.offsetLeft+s.clientWidth/2,d=Math.abs(c-mid);
        if(d<bd){bd=d;best=k;}
      });
      if(best!==i){i=best;t0=performance.now();paint();}
    },90);
  },{passive:true});
  function nudge(){paused=true;clearTimeout(rt);rt=setTimeout(function(){paused=false;t0=performance.now();},6000);}
  ['pointerdown','wheel','touchstart'].forEach(function(ev){track.addEventListener(ev,nudge,{passive:true});});
  car.addEventListener('mouseenter',function(){paused=true;clearTimeout(rt);});
  car.addEventListener('mouseleave',function(){paused=false;t0=performance.now();});
  car.addEventListener('focusin',function(){paused=true;clearTimeout(rt);});
  [].forEach.call(car.querySelectorAll('.carbtn'),function(b){
    b.addEventListener('click',function(){go(i+Number(b.dataset.dir));nudge();});
  });
  var pb=document.getElementById('playbtn');
  pb.addEventListener('click',function(){
    playing=!playing;t0=performance.now();
    pb.textContent=playing?'⏸ หยุดเลื่อนเอง':'▶ ให้เลื่อนเอง';
    if(!playing)bar.style.width='0%';
  });
  if(reduce)pb.textContent='▶ ให้เลื่อนเอง';
  (function tick(now){
    if(playing&&!paused&&!document.hidden){
      var p=(now-t0)/5000;
      bar.style.width=Math.min(p,1)*100+'%';
      if(p>=1)go(i+1);
    }
    requestAnimationFrame(tick);
  })(performance.now());
})();
</script>`;

const PER_PAGE = 12;   // การ์ดต่อหน้า — มากกว่านี้หน้าเริ่มยาวเกินไปบนมือถือ
// ค้นจากหัวข้อ/เกริ่น/หมวด/แท็ก/เครื่องจักร/ผู้เขียน — พิมพ์คำเดียวก็เจอ ไม่ต้องตรงเป๊ะ
function postMatches(p, q) {
  if (!q) return true;
  const hay = [p.title, p.excerpt, p.category, p.machine, p.author, (p.tags || []).join(' ')]
    .join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
const listHref = (o) => {
  const qs = [];
  if (o.cat) qs.push(`cat=${encodeURIComponent(o.cat)}`);
  if (o.q) qs.push(`q=${encodeURIComponent(o.q)}`);
  if (o.page && o.page > 1) qs.push(`p=${o.page}`);
  return `/บทความ${qs.length ? `?${qs.join('&')}` : ''}`;
};

function renderIndex(all, baseUrl, opts = '') {
  const o = typeof opts === 'string' ? { cat: opts } : (opts || {});
  const cat = o.cat || '', q = o.q || '';
  const counts = {};
  all.forEach(p => { if (p.category) counts[p.category] = (counts[p.category] || 0) + 1; });
  const filtered = all.filter(p => (!cat || p.category === cat) && postMatches(p, q));
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const page = Math.min(Math.max(1, Number(o.page) || 1), pages);
  const posts = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  // บทความแนะนำ = 5 เรื่องล่าสุด (รายการเรียงใหม่→เก่ามาแล้วจากคำสั่ง SQL)
  // โชว์เฉพาะตอนดูทั้งหมดและมีของให้เลื่อนจริง ๆ — กรองหมวดอยู่แล้วเอาการ์ดล้วนพอ
  const feat = (!cat && !q && page === 1 && all.length >= 2) ? all.slice(0, 5) : [];
  const carousel = feat.length ? `
    <div class="shead">
      <div><span class="eyebrow">⭐ แนะนำ</span><h2 style="margin-top:8px">${feat.length} เรื่องล่าสุด</h2></div>
    </div>
    <div class="car" id="car">
      <button class="carbtn prev" data-dir="-1" aria-label="ก่อนหน้า">‹</button>
      <button class="carbtn next" data-dir="1" aria-label="ถัดไป">›</button>
      <div class="track" id="track">${feat.map((p, i) => featSlide(p, i, feat.length)).join('')}</div>
      <div class="cardock">
        <div class="dots" id="dots"></div>
        <div class="bar"><i id="bar"></i></div>
        <button class="playbtn" id="playbtn">⏸ หยุดเลื่อนเอง</button>
      </div>
    </div>` : '';

  const chip = (name, n, color) => `<a class="chip${(cat === name || (!cat && !name)) ? ' on' : ''}" href="${esc(listHref({ cat: name, q }))}">${
    color ? `<span class="cdot" style="background:${color}"></span>` : ''}${esc(name || 'ทั้งหมด')} <span class="n">${n}</span></a>`;
  const chips = [chip('', all.length, '')]
    .concat(CATS.filter(c => counts[c.name]).map(c => chip(c.name, counts[c.name], c.color)))
    .join('');

  const heading = q ? `ผลการค้นหา “${esc(q)}”` : cat ? `หมวด “${esc(cat)}”` : 'ทุกบทความ';
  // กล่องค้นหาเป็นฟอร์ม GET ธรรมดา — ไม่ต้องพึ่ง JS หน้านี้เปิดอ่านเฉย ๆ ก็ทำงานได้
  const searchBox = `<form class="asearch" method="get" action="/บทความ">
    ${cat ? `<input type="hidden" name="cat" value="${esc(cat)}">` : ''}
    <input type="search" name="q" value="${esc(q)}" placeholder="🔎 ค้นหาบทความ — หัวข้อ · หมวด · เครื่องจักร · ผู้เขียน">
    <button type="submit">ค้นหา</button>
    ${q ? `<a class="clr" href="${esc(listHref({ cat }))}">✕ ล้าง</a>` : ''}
  </form>`;
  // แบ่งหน้า: โชว์เลขหน้ารอบ ๆ หน้าปัจจุบัน + ปุ่มก่อนหน้า/ถัดไป
  const pageLink = (n, label, on) =>
    `<a class="pg${on ? ' on' : ''}" href="${esc(listHref({ cat, q, page: n }))}">${esc(label == null ? String(n) : label)}</a>`;
  const nums = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(pageLink(n, null, n === page));
    else if (nums[nums.length - 1] !== '<span class="pgdot">…</span>') nums.push('<span class="pgdot">…</span>');
  }
  const pager = pages > 1 ? `<nav class="pager">
    ${page > 1 ? pageLink(page - 1, '‹ ก่อนหน้า') : ''}
    ${nums.join('')}
    ${page < pages ? pageLink(page + 1, 'ถัดไป ›') : ''}
  </nav>` : '';
  const body = `<div class="hero"><div class="in">
    <span class="eyebrow">📖 อ่านได้เลย ไม่ต้องล็อกอิน</span>
    <h1>บทความ / คู่มือระบบ</h1>
    <p>เรื่องที่ทีมผลิตเขียนอธิบายระบบและขั้นตอนการทำงาน — ส่งลิงก์ให้ใครก็เปิดอ่านได้</p>
  </div></div>
  <main class="wide">
    ${carousel}
    <div class="shead">
      <div><h2>${heading}</h2><div class="sub">${
        q || cat
          ? `พบ ${filtered.length} เรื่อง${pages > 1 ? ` · หน้า ${page}/${pages}` : ''}`
          : `ทั้งหมด ${all.length} เรื่อง${pages > 1 ? ` · หน้า ${page}/${pages}` : ''}`}</div></div>
    </div>
    ${searchBox}
    ${all.length > 1 ? `<div class="chips">${chips}</div>` : ''}
    ${posts.length
      ? `<div class="agrid">${posts.map(articleCard).join('')}</div>`
      : `<div class="empty">${q ? `ไม่พบบทความที่ตรงกับ “${esc(q)}”` : cat ? 'ยังไม่มีบทความในหมวดนี้' : 'ยังไม่มีบทความที่เผยแพร่'}</div>`}
    ${pager}
  </main>
  <div class="foot wide">เอกสารภายในของทีมผลิต SPP-MP</div>`;

  return shell({
    title: q ? `ค้นหา “${q}” — SPP-MP` : cat ? `บทความหมวด ${cat} — SPP-MP` : 'บทความ / คู่มือระบบ — SPP-MP',
    desc: 'คลังความรู้ของทีมผลิต SPP-MP',
    image: (all.find(p => p.coverUrl) || {}).coverUrl || '',
    url: `${baseUrl}/บทความ`,
    body,
    wide: true,
    counts,
    script: feat.length ? CAR_SCRIPT : '',
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
