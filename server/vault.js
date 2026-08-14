// ─── เขียนไฟล์เข้า Obsidian vault (GitHub Contents API) ──────────────────────
// vault ของ Obsidian = GitHub repo ส่วนตัว · ฝั่งคนใช้ลงปลั๊กอิน Obsidian Git ตั้ง auto-pull
// ฝั่งนี้เขียนไฟล์ผ่าน REST API ไม่ clone — Render จึงไม่ต้องมี git binary / working copy
//
// ไม่มี VAULT_GITHUB_TOKEN = ปิดตัวเองเงียบ ๆ (local dev ยังบันทึกบทความได้ปกติ แค่ไม่ sync)
//
// ⚠️ ห้ามใส่คอมเมนต์อธิบายลงในไฟล์ .md ที่สร้างจากที่นี่ — Obsidian ซ่อน <!-- --> เฉพาะ
//    Reading view แต่โชว์ให้เห็นใน Live Preview (บทเรียนจากเฟส 0)

const axios = require('axios');

// .trim() ทุกตัว — ช่องกรอกบนแดชบอร์ด (Render/Vercel) ติด enter หรือช่องว่างท้ายมาง่ายมาก
// ค่าที่ดูด้วยตาเหมือนถูกทุกอย่างแต่ใช้ไม่ได้ ส่วนใหญ่เป็นเพราะเรื่องนี้
const envStr = (k, dflt = '') => String(process.env[k] || dflt).trim();
const cfg = () => ({
  token: envStr('VAULT_GITHUB_TOKEN'),
  repo: envStr('VAULT_REPO', 'jakkitpoolsawat170119-dev/knowledge-vault'),
  branch: envStr('VAULT_BRANCH', 'main'),
  webhookSecret: envStr('VAULT_WEBHOOK_SECRET'),
});
const vaultEnabled = () => !!cfg().token;

/* ══════════════ ชั้นคุยกับ GitHub ══════════════ */

// path มีอักษรไทย → encode ทีละส่วน ไม่ใช่ทั้งเส้น (ไม่งั้น "/" โดน encode แล้วได้ 404 แบบงง ๆ)
const encPath = (p) => String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');

async function gh(method, path, body) {
  const { token, repo, branch } = cfg();
  if (!token) throw new Error('ยังไม่ได้ตั้ง VAULT_GITHUB_TOKEN');
  const r = await axios({
    method,
    url: `https://api.github.com/repos/${repo}/contents/${encPath(path)}`,
    params: method === 'get' ? { ref: branch } : undefined,
    data: body,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'spp-mp',
    },
    timeout: 20000,
    validateStatus: () => true,
  });
  return r;
}

const ghMessage = (r) => (r.data && r.data.message) || `HTTP ${r.status}`;

// อ่านไฟล์เดิม — null ถ้ายังไม่มี (404)
async function vaultRead(path) {
  const r = await gh('get', path);
  if (r.status === 404) return null;
  if (r.status >= 400) throw new Error(`อ่าน ${path} ไม่ได้ — ${ghMessage(r)}`);
  const text = r.data.encoding === 'base64'
    ? Buffer.from(r.data.content || '', 'base64').toString('utf8')
    : String(r.data.content || '');
  return { sha: r.data.sha, text };
}

// เขียนทับไฟล์ — อ่าน sha ของไฟล์เดิมก่อนเสมอ
// sha ไม่ตรง (มีคน push แทรกระหว่างทาง) GitHub คืน 409 → อ่านใหม่แล้วลองอีกครั้ง
async function vaultWrite(path, content, message) {
  const { branch } = cfg();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const cur = await vaultRead(path);
    // เนื้อหาเหมือนเดิมเป๊ะ → ไม่ต้อง commit เปล่า ๆ (เผยแพร่ซ้ำโดยไม่ได้แก้อะไร)
    if (cur && cur.text === content) return { path, sha: cur.sha, skipped: true };
    const r = await gh('put', path, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(cur ? { sha: cur.sha } : {}),
    });
    if (r.status === 409 || r.status === 422) continue;
    if (r.status >= 400) throw new Error(`เขียน ${path} ไม่สำเร็จ — ${ghMessage(r)}`);
    return { path, sha: r.data.content && r.data.content.sha, skipped: false };
  }
  throw new Error(`เขียน ${path} ไม่สำเร็จ — ไฟล์ถูกแก้ระหว่างทางติดกัน 3 ครั้ง`);
}

// ลบไฟล์ — เงียบถ้าไม่มีไฟล์อยู่แล้ว
async function vaultDelete(path, message) {
  const { branch } = cfg();
  const cur = await vaultRead(path);
  if (!cur) return { path, missing: true };
  const r = await gh('delete', path, { message, sha: cur.sha, branch });
  if (r.status >= 400) throw new Error(`ลบ ${path} ไม่สำเร็จ — ${ghMessage(r)}`);
  return { path };
}

/* ══════════════ เขียนเฉพาะในเขต marker ══════════════ */
// ใช้กับไฟล์ที่คนเขียนแทรกเองได้ (บันทึกประจำวัน / ส่งกะ) — ข้อความนอก marker ไม่โดนแตะ
// ไฟล์บทความไม่ต้องใช้ เพราะระบบเป็นเจ้าของทั้งไฟล์

const markOpen = (name) => `<!-- spp:start:${name} -->`;
const markClose = (name) => `<!-- spp:end:${name} -->`;
const hasMarker = (text, name) => String(text || '').includes(markOpen(name));

// prefix ใช้ตอนเขตอยู่ในกล่อง callout ของ Obsidian — ทุกบรรทัดในกล่องต้องขึ้นต้นด้วย "> "
// รวมถึงบรรทัดปิดเขตด้วย ไม่งั้นกล่องจะขาดกลาง
function replaceMarked(existing, name, body, opts = {}) {
  const pre = opts.prefix || '';
  const open = markOpen(name);
  const close = markClose(name);
  const lines = String(body).split('\n').map(l => (pre + l).replace(/\s+$/, ''));
  const region = [open, ...lines, pre + close].join('\n');
  const i = String(existing || '').indexOf(open);
  const j = String(existing || '').indexOf(close);
  if (i === -1 || j === -1 || j < i) {
    const head = String(existing || '').replace(/\s+$/, '');
    return (head ? head + '\n\n' : '') + region + '\n';
  }
  return existing.slice(0, i) + region + existing.slice(j + close.length);
}

/* ══════════════ บทความ → markdown ══════════════ */
// ต้องให้ผลตรงกับ toMarkdown() ใน client/src/components/BlogEditor.tsx
// (ฝั่งนั้นใช้ดู preview ตอนพิมพ์ ฝั่งนี้ใช้เขียนไฟล์จริงตอนไม่มีเบราว์เซอร์)

const STATUS_LABEL = { draft: 'ร่าง', review: 'รอตรวจ', published: 'เผยแพร่' };

// ลิงก์รูปกราฟกับตัวอ่านลิงก์วิดีโอ — ต้องให้ผลตรงกับฝั่ง client (BlogEditor.tsx)
const PUBLIC_BASE = (process.env.PUBLIC_URL || 'https://back-wash-test.onrender.com').replace(/\/+$/, '');

function videoEmbed(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,20})/);
  if (yt) return { src: `https://www.youtube-nocookie.com/embed/${yt[1]}`, kind: 'youtube' };
  const gd = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([\w-]{10,})/);
  if (gd) return { src: `https://drive.google.com/file/d/${gd[1]}/preview`, kind: 'drive' };
  if (/^https?:\/\/[^\s]+\.(mp4|webm|ogg)(\?[^\s]*)?$/i.test(url)) return { src: url, kind: 'file' };
  return null;
}

function chartUrl(b, base = PUBLIC_BASE) {
  const q = new URLSearchParams();
  q.set('k', b.chartKind || 'bar');
  q.set('s', b.chartSrc || 'manual');
  if (b.days) q.set('d', String(b.days));
  if (b.title) q.set('t', b.title);
  if ((b.chartSrc || 'manual') === 'manual') {
    q.set('m', Buffer.from(JSON.stringify(b.cells || []), 'utf8').toString('base64'));
  }
  return `${base}/api/chart.svg?${q.toString()}`;
}

function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[\s_/]+/g, '-')
    .replace(/[^฀-๿a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

// ฝั่ง client ถอดโค้ด HTML ด้วย DOM — ฝั่งนี้ไม่มี DOM ต้องถอดเอง (& ไว้ท้ายสุดเสมอ)
const decodeEntities = (s) => String(s)
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

function mdInline(h) {
  const s = String(h || '')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<(b|strong)>(.*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>(.*?)<\/\1>/gi, '*$2*')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s).trim();
}
// ใช้กับคำบรรยายรูป — ยุบช่องว่าง/ขึ้นบรรทัดให้เหลือเว้นวรรคเดียว ไม่งั้น ![alt](url) ขาดกลาง
const stripHtml = (h) => decodeEntities(
  String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li)>/gi, ' ').replace(/<[^>]+>/g, ''),
).replace(/\s+/g, ' ').trim();

// ค่าใน frontmatter ที่มี : หรือ # จะทำให้ YAML พัง → ใส่ quote ให้เมื่อจำเป็น
function yamlStr(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '""';
  if (/^[-?:,[\]{}#&*!|>'"%@`]|[:#]\s|\s#|: |^\s|\s$/.test(s)) return '"' + s.replace(/(["\\])/g, '\\$1') + '"';
  return s;
}

function postToMarkdown(post) {
  const p = post || {};
  const title = p.title || 'ยังไม่ตั้งชื่อ';
  const date = String(p.publishedAt || p.updatedAt || p.createdAt || '').slice(0, 10)
    || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const L = [
    '---',
    `title: ${yamlStr(title)}`,
    `date: ${date}`,
    `tags: [${(p.tags || []).join(', ')}]`,
    `หมวดหมู่: ${yamlStr(p.category || '')}`,
    `สถานะ: ${STATUS_LABEL[p.status] || 'ร่าง'}`,
    `ผู้เขียน: ${yamlStr(p.author || '')}`,
  ];
  if (p.machine) L.push(`เครื่องจักร: "[[${p.machine}]]"`);
  L.push('ที่มา: SPP-MP editor', '---', '', `# ${title}`, '');

  (p.blocks || []).forEach((b) => {
    switch (b.type) {
      case 'p': { const t = mdInline(b.html); if (t) L.push(t, ''); break; }
      case 'h1': L.push('# ' + mdInline(b.html), ''); break;
      case 'h2': L.push('## ' + mdInline(b.html), ''); break;
      case 'h3': L.push('### ' + mdInline(b.html), ''); break;
      case 'h4': L.push('#### ' + mdInline(b.html), ''); break;
      case 'quote': L.push('> ' + mdInline(b.html), ''); break;
      case 'list': (b.items || []).forEach(i => L.push('- ' + mdInline(i))); L.push(''); break;
      case 'olist': (b.items || []).forEach((i, n) => L.push(`${n + 1}. ` + mdInline(i))); L.push(''); break;
      case 'todo':
        (b.items || []).forEach((i, n) => L.push(`- [${(b.checks || [])[n] ? 'x' : ' '}] ` + mdInline(i)));
        L.push('');
        break;
      case 'divider': L.push('---', ''); break;
      case 'toggle':
        // callout แบบพับได้ของ Obsidian — เครื่องหมาย - ท้าย [!note] คือ "เริ่มมาแบบพับอยู่"
        L.push(`> [!note]- ${mdInline(b.title)}`);
        String(b.body || '').split('\n').forEach(l => L.push('> ' + l));
        L.push('');
        break;
      case 'table': {
        const cells = b.cells || [];
        if (!cells.length) break;
        L.push('| ' + cells[0].map(c => mdInline(c) || ' ').join(' | ') + ' |');
        L.push('| ' + cells[0].map(() => '---').join(' | ') + ' |');
        cells.slice(1).forEach(r => L.push('| ' + r.map(c => mdInline(c) || ' ').join(' | ') + ' |'));
        L.push('');
        break;
      }
      case 'code': L.push('```', b.html || '', '```', ''); break;
      // ใส่ชื่อภาษาให้ Obsidian ไล่สี — ใน Obsidian อ่านอย่างเดียว รันไม่ได้
      case 'js': L.push('```js', b.html || '', '```', ''); break;
      case 'image':
        L.push(`![${stripHtml(b.cap) || b.name || 'ภาพ'}](${b.src || ''})`);
        if (stripHtml(b.cap)) L.push('*' + stripHtml(b.cap) + '*');
        L.push('');
        break;
      case 'pdf':
        L.push(`[📕 ${b.name || 'เอกสาร'}](${b.url || ''})${b.meta ? ' — ' + b.meta : ''}`, '');
        break;
      case 'cols':
        // markdown ไม่มีคอลัมน์ — วางต่อกันลงมาแทน เนื้อหาไม่หาย
        (b.items || []).forEach(c => { const t = mdInline(c); if (t) L.push(t, ''); });
        break;
      case 'video': {
        const emb = videoEmbed(b.url || '');
        // Obsidian ฝัง YouTube ให้เองถ้าเขียนเป็น ![](ลิงก์) — อย่างอื่นใส่เป็นลิงก์ธรรมดา
        if (emb && emb.kind === 'youtube') L.push(`![](${b.url})`);
        else if (b.url) L.push(`[▶️ ${stripHtml(b.cap) || 'ดูวิดีโอ'}](${b.url})`);
        if (stripHtml(b.cap)) L.push('*' + stripHtml(b.cap) + '*');
        L.push('');
        break;
      }
      case 'chart':
        // รูปกราฟดึงจากเซิร์ฟเวอร์ — เปิดใน Obsidian แล้วเห็นกราฟจริง และอัปเดตตามข้อมูลล่าสุด
        L.push(`![${b.title || 'กราฟ'}](${chartUrl(b)})`, '');
        break;
      case 'alert': {
        const kind = b.level === 'danger' ? 'danger' : b.level === 'warn' ? 'warning' : 'info';
        L.push(`> [!${kind}] ${b.title || ''}`);
        String(b.body || '').split('\n').forEach(l => L.push('> ' + l));
        L.push('');
        break;
      }
      case 'params':
        L.push('### ' + (b.title || 'ค่าควบคุม'));
        L.push('| พารามิเตอร์ | ค่าตั้ง | ช่วงปกติ | หน่วย | จุดวัด |');
        L.push('| --- | --- | --- | --- | --- |');
        (b.rows || []).forEach(r =>
          L.push(`| ${r.oor ? '⚠️ ' : ''}${r.p} | ${r.set} | ${r.rng} | ${r.u} | ${r.pt} |`));
        L.push('');
        break;
      case 'flow': {
        const steps = b.steps || [];
        L.push('### ' + (b.title || 'ลำดับการไหล'));
        L.push('```mermaid', 'graph LR');
        steps.forEach((s, i) => {
          L.push(`  S${i}["${String(s.t || '').replace(/\n/g, ' ')}"]${i < steps.length - 1 ? ` --> S${i + 1}` : ''}`);
        });
        L.push('```', '');
        break;
      }
      default: break;
    }
  });
  return L.join('\n');
}

// ที่อยู่ไฟล์ในvault — ใช้ slug ล้วน ไม่เติมวันที่ ชื่อไฟล์จะได้คงที่ตอนแก้บทความซ้ำ
const postPath = (post) =>
  `${(post && post.obsFolder) || 'บทความ'}/${slugify((post && post.slug) || (post && post.title))}.md`;

/* ══════════════ งานระดับบทความ ══════════════ */

// เขียนบทความลง vault · ย้ายไฟล์ให้ถ้าเปลี่ยน slug/โฟลเดอร์ (กันไฟล์เก่าค้างเป็นผี)
// คืน { path, skipped } — โยน error ออกไปให้คนเรียกตัดสินใจว่าจะกลืนหรือส่งต่อ
async function syncPost(post, prevPath) {
  const path = postPath(post);
  const res = await vaultWrite(path, postToMarkdown(post), `บทความ: ${post.title || path}`);
  if (prevPath && prevPath !== path) {
    try { await vaultDelete(prevPath, `ย้ายชื่อไฟล์บทความ: ${prevPath} → ${path}`); }
    catch (e) { console.error('[vault] ลบไฟล์เก่าไม่สำเร็จ', prevPath, e.message); }
  }
  return res;
}

// ถอนบทความออกจาก vault (ลบบทความ / เปลี่ยนจากเผยแพร่กลับเป็นร่าง)
async function unsyncPost(path, why) {
  if (!path) return { missing: true };
  return vaultDelete(path, `ถอนบทความออกจาก vault: ${path}${why ? ` (${why})` : ''}`);
}

/* ══════════════ งานค้างในบันทึกประจำวัน (สองทาง) ══════════════ */
// รูปแบบบรรทัดเป็นไวยากรณ์ของปลั๊กอิน Tasks + block-ref ของ Obsidian เอง:
//   - [ ] ผลิต Freshy Sala #production [[Line 4]] 📅 2026-08-12 ^spp-158
// `^spp-<id>` คือตัวจับคู่กลับมาที่งานในแอป — คนแก้ข้อความหน้ารหัสได้ ระบบยังรู้ว่าเป็นงานเดิม

const TASK_MARK = 'งานค้าง';
const dailyNotePath = (date) => `บันทึกประจำวัน/${date}.md`;

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function taskLine(t) {
  const done = t.status === 'done';
  const bits = [`- [${done ? 'x' : ' '}]`, oneLine(t.title)];
  if (t.category) bits.push('#' + String(t.category).replace(/\s+/g, '-'));
  const place = t.machine || t.location || t.line_name;
  if (place) bits.push(`[[${oneLine(place)}]]`);
  if (t.task_date) bits.push('📅 ' + t.task_date);
  if (done && t.completed_at) bits.push('✅ ' + String(t.completed_at).slice(0, 10));
  bits.push('^spp-' + t.id);
  return bits.join(' ');
}

// อ่านบรรทัดกลับ — ตัด "> " ของ callout ออกก่อน แล้วตัดข้อมูลท้ายบรรทัดเพื่อเหลือแต่ชื่องาน
// ตัดจากเครื่องหมายตัวแรกที่เจอ ไม่ตัดทีละโทเคน เพราะชื่อคน/เครื่องมีช่องว่างได้
function parseTaskLine(raw) {
  const line = String(raw || '').replace(/^\s*>\s?/, '');
  const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s*(.*)$/);
  if (!m) return null;
  let rest = m[2];
  const idm = rest.match(/\s*\^spp-(\d+)\s*$/);
  const id = idm ? Number(idm[1]) : null;
  if (idm) rest = rest.slice(0, idm.index);
  const cut = rest.search(/\s(?:#\S|\[\[|👤|📅|✅)/u);
  return {
    done: m[1].toLowerCase() === 'x',
    id,
    title: oneLine(cut >= 0 ? rest.slice(0, cut) : rest),
    raw: String(raw || ''),
  };
}

// เนื้อในเขตที่ระบบเป็นเจ้าของ — งานค้างขึ้นก่อน งานที่ทำแล้วอยู่ล่าง
function taskBlock(tasks) {
  const open = tasks.filter(t => t.status !== 'done');
  const done = tasks.filter(t => t.status === 'done');
  const L = [];
  if (!open.length && !done.length) L.push('_ยังไม่มีงานของวันนี้_');
  open.forEach(t => L.push(taskLine(t)));
  if (done.length) {
    if (open.length) L.push('');
    done.forEach(t => L.push(taskLine(t)));
  }
  return L.join('\n');
}

// กล่อง callout ครอบเขต — ให้คนเห็นชัดว่าตรงนี้ระบบเขียนเอง และติ๊กได้
// (ข้อความในกล่องเป็นข้อความปกติ ไม่ใช่คอมเมนต์ HTML จึงไม่ผิดบทเรียนเฟส 0)
const CALLOUT_HEAD = '> [!note] ส่วนนี้ระบบเขียนอัตโนมัติ — ติ๊กในนี้ได้เลย แอปจะปิดงานตาม';

function dailyNoteSkeleton(date, body) {
  return [
    '---',
    `title: บันทึกประจำวัน ${date}`,
    `date: ${date}`,
    'tags: [บันทึกประจำวัน]',
    'ที่มา: SPP-MP',
    '---',
    '',
    `# บันทึกประจำวัน ${date}`,
    '',
    CALLOUT_HEAD,
    '> ' + markOpen(TASK_MARK),
    ...body.split('\n').map(l => ('> ' + l).replace(/\s+$/, '')),
    '> ' + markClose(TASK_MARK),
    '',
  ].join('\n');
}

// เขียนรายการงานของวันนั้นลงบันทึกประจำวัน — แตะเฉพาะในเขต marker
// ข้อความที่คนเขียนเองนอกเขตไม่โดนแตะ
function buildDailyNote(existing, date, tasks) {
  const body = taskBlock(tasks);
  if (existing && hasMarker(existing, TASK_MARK)) {
    return replaceMarked(existing, TASK_MARK, body, { prefix: '> ' });
  }
  if (existing) {
    return existing.replace(/\s+$/, '') + '\n\n' + [
      CALLOUT_HEAD,
      '> ' + markOpen(TASK_MARK),
      ...body.split('\n').map(l => ('> ' + l).replace(/\s+$/, '')),
      '> ' + markClose(TASK_MARK),
    ].join('\n') + '\n';
  }
  return dailyNoteSkeleton(date, body);
}

// ลบบรรทัดที่คนจดเองออกจากไฟล์ หลังกด "รับ" เข้าระบบแล้ว
// (งานนั้นจะไปโผล่ในเขตที่ระบบดูแลพร้อมรหัส ^spp- แทน ไม่งั้นจะเห็นซ้ำสองที่)
function removeLine(text, rawLine) {
  const target = oneLine(rawLine);
  if (!target) return text;
  const out = String(text).split('\n').filter(l => oneLine(l) !== target);
  return out.join('\n');
}

module.exports = {
  vaultEnabled, vaultConfig: cfg,
  vaultRead, vaultWrite, vaultDelete,
  replaceMarked, hasMarker,
  postToMarkdown, postPath, slugify, videoEmbed, chartUrl,
  syncPost, unsyncPost,
  TASK_MARK, dailyNotePath, taskLine, parseTaskLine, buildDailyNote, removeLine,
};
