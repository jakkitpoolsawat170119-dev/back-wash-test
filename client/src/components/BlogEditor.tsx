import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppRoute } from '../hooks/useAppRoute';
import { wakeFetch } from '../lib/wakeFetch';
import { uploadFileDetailed, humanSize } from '../lib/uploadFile';
import MediaLibrary, { type MediaInsertOpt } from './MediaLibrary';
import { isDocFile, isImage, type MediaItem } from '../lib/media';
import { runJs, type RunHandle, type RunLine } from '../lib/runJs';
import { verifyJs } from '../lib/jsVerify';
import { ANIM_TEMPLATES } from '../lib/animTemplates';
import '../blog.css';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

/* ══════════════ ชนิดข้อมูล ══════════════ */

export type BlockType =
  | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'list' | 'olist' | 'todo' | 'quote' | 'code' | 'js'
  | 'table' | 'divider' | 'toggle' | 'cols'
  | 'image' | 'pdf' | 'video' | 'flow' | 'params' | 'alert' | 'chart';

interface FlowStep { t: string; c: string }
interface ParamRow { p: string; set: string; rng: string; u: string; pt: string; oor: boolean }
interface BlockStyle { text?: string; bg?: string; fs?: number; pad?: number; mar?: number; bw?: number; br?: number; bd?: string }

export interface Block {
  id: string;
  type: BlockType;
  html?: string;
  items?: string[];
  src?: string;
  cap?: string;
  name?: string;
  meta?: string;
  url?: string;
  mode?: 'button' | 'embed';
  title?: string;
  body?: string;
  level?: 'danger' | 'warn' | 'info';
  steps?: FlowStep[];
  rows?: ParamRow[];
  cells?: string[][];        // ตารางอิสระ / ข้อมูลกราฟแบบพิมพ์เอง — แถวแรกคือหัวตาราง
  checks?: boolean[];        // เช็กลิสต์ — ติ๊กคู่กับ items ทีละช่อง
  auto?: boolean;            // บล็อกโค้ดที่รันได้ — รันเองตอนคนเปิดหน้าอ่าน
  draw?: boolean;            // โหมดวาดภาพ/เคลื่อนไหว — กล่องโผล่ในหน้าและอยู่ต่อหลังรันจบ
  h?: number;                // ความสูงของกล่องวาดภาพ (px)
  chartKind?: 'bar' | 'line';
  chartSrc?: string;         // manual | production-daily | production-machine | tasks-daily
  days?: number;             // ย้อนหลังกี่วัน (เฉพาะกราฟที่ดึงข้อมูลจากระบบ)
  pid?: string;
  style?: BlockStyle;
  cls?: string;
  anchor?: string;
}

interface Post {
  id?: number;
  slug: string;
  title: string;
  blocks: Block[];
  status: 'draft' | 'review' | 'published';
  author: string;
  category: string;
  tags: string[];
  machine: string;
  excerpt: string;
  coverUrl: string;
  seoKeyword: string;
  seoDesc: string;
  scriptHead: string;
  scriptBody: string;
  obsFolder: string;
  updatedAt?: string;
  publishedAt?: string | null;
  vaultPath?: string;
  vaultSyncedAt?: string;
  vaultError?: string;
}

// ผล sync ที่ server ส่งกลับมาหลังบันทึก — enabled=false คือเซิร์ฟเวอร์ยังไม่ได้ตั้ง token
interface VaultResult {
  enabled: boolean;
  ok?: boolean;
  path?: string;
  error?: string;
  at?: string;
  skipped?: boolean;
  removed?: boolean;
}

interface PostSummary {
  id: number; title: string; status: Post['status']; category: string;
  tags: string[]; excerpt: string; author: string; updatedAt: string;
}

/* ══════════════ ค่าคงที่ ══════════════ */

const BLOCK_TYPES: { id: BlockType; ic: string; t: string; d: string; k: string; grp: string }[] = [
  { id: 'p',      ic: '¶',  t: 'ย่อหน้า',            d: 'เนื้อหาทั่วไป',                 k: '/p',     grp: 'พื้นฐาน' },
  { id: 'h1',     ic: 'H₁', t: 'หัวข้อใหญ่สุด',       d: 'แบ่งบทความเป็นตอนใหญ่',         k: '/h1',    grp: 'หัวข้อ' },
  { id: 'h2',     ic: 'H₂', t: 'หัวข้อใหญ่',          d: 'แบ่งบทเป็นตอน ๆ',              k: '/h2',    grp: 'หัวข้อ' },
  { id: 'h3',     ic: 'H₃', t: 'หัวข้อย่อย',          d: 'หัวข้อระดับรอง',               k: '/h3',    grp: 'หัวข้อ' },
  { id: 'h4',     ic: 'H₄', t: 'หัวข้อย่อยเล็ก',      d: 'ระดับล่างสุด',                 k: '/h4',    grp: 'หัวข้อ' },
  { id: 'list',   ic: '•',  t: 'รายการ',              d: 'ข้อ ๆ ไม่เรียงลำดับ',           k: '/list',  grp: 'พื้นฐาน' },
  { id: 'olist',  ic: '1.', t: 'รายการมีเลข',         d: 'ขั้นตอนที่ต้องทำตามลำดับ',      k: '/ol',    grp: 'พื้นฐาน' },
  { id: 'todo',   ic: '☑',  t: 'เช็กลิสต์',           d: 'รายการที่ติ๊กได้ตอนทำจริง',     k: '/todo',  grp: 'พื้นฐาน' },
  { id: 'table',  ic: '▦',  t: 'ตาราง',               d: 'ตารางอิสระ กำหนดหัวเอง',        k: '/table', grp: 'พื้นฐาน' },
  { id: 'quote',  ic: '❝',  t: 'ยกข้อความ',           d: 'อ้างคู่มือหรือมาตรฐาน',         k: '/quote', grp: 'พื้นฐาน' },
  { id: 'toggle', ic: '▸',  t: 'กล่องพับเก็บ',        d: 'ซ่อนรายละเอียดยาว ๆ กดแล้วกาง', k: '/toggle', grp: 'พื้นฐาน' },
  { id: 'divider',ic: '—',  t: 'เส้นคั่น',            d: 'คั่นระหว่างตอน',               k: '/hr',    grp: 'พื้นฐาน' },
  { id: 'code',   ic: '{}', t: 'บล็อกโค้ด',           d: 'สคริปต์ / ค่า config / log',    k: '/code',  grp: 'พื้นฐาน' },
  { id: 'js',     ic: '▶',  t: 'โค้ดที่รันได้',        d: 'คำนวณ process จริง กดแล้วได้ผลลัพธ์', k: '/run', grp: 'งานผลิต' },
  { id: 'cols',   ic: '◫',  t: 'แบ่งคอลัมน์',         d: 'วางเนื้อหาคู่กัน จอแคบยุบเป็นแถวเดียว', k: '/cols', grp: 'พื้นฐาน' },
  { id: 'image',  ic: '🖼', t: 'รูปภาพ',              d: 'ภาพจอ SCADA/HMI พร้อมคำบรรยาย', k: '/image', grp: 'สื่อ' },
  { id: 'video',  ic: '▶',  t: 'วิดีโอ',              d: 'YouTube / Google Drive / ไฟล์วิดีโอ', k: '/video', grp: 'สื่อ' },
  { id: 'pdf',    ic: '📕', t: 'เอกสาร PDF',          d: 'SOP, คู่มือเครื่อง, รายงาน',    k: '/pdf',   grp: 'สื่อ' },
  { id: 'chart',  ic: '📊', t: 'กราฟ',                d: 'ดึงยอดผลิตจริงมาวาด หรือพิมพ์เอง', k: '/chart', grp: 'งานผลิต' },
  { id: 'flow',   ic: '🔀', t: 'Process Flow / P&ID', d: 'ลำดับการไหลของกระบวนการ',       k: '/flow',  grp: 'งานผลิต' },
  { id: 'params', ic: '⊞',  t: 'ตารางพารามิเตอร์',    d: 'ค่าตั้ง / ช่วงปกติ / จุดวัด',   k: '/param', grp: 'งานผลิต' },
  { id: 'alert',  ic: '⚠️', t: 'กล่องแจ้งเตือน',      d: 'อันตราย / ระวัง / ข้อมูล',      k: '/alert', grp: 'งานผลิต' },
];
const BT = Object.fromEntries(BLOCK_TYPES.map(b => [b.id, b])) as Record<BlockType, typeof BLOCK_TYPES[number]>;

/** device = อัปจากเครื่อง · library = หยิบของที่มีอยู่แล้วในคลังไฟล์ */
type PickSource = 'device' | 'library';

// ตัวอย่างตั้งต้นของบล็อกโค้ดที่รันได้ — ตั้งใจให้เป็นงานผลิตจริง ไม่ใช่ hello world
const JS_SAMPLE = `// เวลาและน้ำที่ใช้ของ process ล้าง CIP
const ขั้นตอน = [
  { ชื่อ: 'Pre-rinse',      นาที: 5,  น้ำ: 300 },
  { ชื่อ: 'Caustic 2% 80C', นาที: 20, น้ำ: 1200 },
  { ชื่อ: 'Final rinse',    นาที: 5,  น้ำ: 300 },
];

const เวลารวม = ขั้นตอน.reduce((s, x) => s + x.นาที, 0);
const น้ำรวม = ขั้นตอน.reduce((s, x) => s + x.น้ำ, 0);

for (const x of ขั้นตอน) console.log(x.ชื่อ, '—', x.นาที, 'นาที', x.น้ำ, 'ลิตร');

return \`รวม \${เวลารวม} นาที · ใช้น้ำ \${น้ำรวม} ลิตร\`;`;

/** หยุดพิมพ์นานเกินนี้ (ms) = ขึ้นก้อนใหม่ให้ปุ่มย้อนกลับ */
const TYPING_SNAP_GAP = 1000;

const CATEGORIES = ['ระบบ CIP', 'Boiler', 'Evaporator', 'Mixing / Syrup', 'บรรจุ', 'ความปลอดภัย'];
const MACHINES = ['CIP Line 1', 'CIP Line 2', 'CIP Line 3', 'Boiler', 'Evaporator', 'Mixing Station'];
const OBS_FOLDERS = ['บทความ', 'คู่มือ', 'ส่งกะ'];
const STATUS_LABEL: Record<Post['status'], string> = { draft: 'ร่าง', review: 'รอตรวจ', published: 'เผยแพร่' };

let uid = 0;
const nid = () => 'b' + Date.now().toString(36) + (++uid).toString(36);
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function slugify(s: string): string {
  return (s || '').trim().toLowerCase()
    .replace(/[\s_/]+/g, '-')
    .replace(/[^฀-๿a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}
function stripHtml(h?: string): string {
  const d = document.createElement('div');
  d.innerHTML = h || '';
  return d.innerText;
}
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

/* ── วิดีโอ: อ่านลิงก์ที่วางมาแล้วแปลงเป็นที่อยู่สำหรับฝัง ──
   รับเฉพาะ YouTube / Google Drive / ไฟล์วิดีโอตรง ๆ — ลิงก์อื่นไม่ฝังให้ (กันฝังของแปลกปลอม)
   ตรรกะเดียวกันกับ videoEmbed() ใน server/articlePage.js ต้องแก้คู่กัน */
export function videoEmbed(raw: string): { src: string; kind: 'youtube' | 'drive' | 'file' } | null {
  const url = String(raw || '').trim();
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,20})/);
  if (yt) return { src: `https://www.youtube-nocookie.com/embed/${yt[1]}`, kind: 'youtube' };
  const gd = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([\w-]{10,})/);
  if (gd) return { src: `https://drive.google.com/file/d/${gd[1]}/preview`, kind: 'drive' };
  if (/^https?:\/\/[^\s]+\.(mp4|webm|ogg)(\?[^\s]*)?$/i.test(url)) return { src: url, kind: 'file' };
  return null;
}

const CHART_SOURCES: { id: string; t: string }[] = [
  { id: 'production-daily', t: 'ยอดผลิตรายวัน (ดึงจากระบบ)' },
  { id: 'production-machine', t: 'ยอดผลิตแยกตามเครื่อง (ดึงจากระบบ)' },
  { id: 'tasks-daily', t: 'งานที่ทำเสร็จรายวัน (ดึงจากระบบ)' },
  { id: 'manual', t: 'พิมพ์ตัวเลขเอง' },
];

const b64utf8 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach(x => { bin += String.fromCharCode(x); });
  return btoa(bin);
};

export function chartUrl(b: Block, base: string): string {
  const q = new URLSearchParams();
  q.set('k', b.chartKind || 'bar');
  q.set('s', b.chartSrc || 'manual');
  if (b.days) q.set('d', String(b.days));
  if (b.title) q.set('t', b.title);
  if ((b.chartSrc || 'manual') === 'manual') q.set('m', b64utf8(JSON.stringify(b.cells || [])));
  return `${base}/api/chart.svg?${q.toString()}`;
}

// ค่าใน frontmatter ที่มี : หรือ # จะทำให้ YAML พัง → ใส่ quote ให้เมื่อจำเป็น
// (ต้องให้ผลตรงกับ yamlStr() ใน server/vault.js ซึ่งเป็นตัวเขียนไฟล์จริง)
function yamlStr(v: string): string {
  const s = String(v || '');
  if (!s) return '""';
  if (/^[-?:,[\]{}#&*!|>'"%@`]|[:#]\s|\s#|: |^\s|\s$/.test(s)) return '"' + s.replace(/(["\\])/g, '\\$1') + '"';
  return s;
}

function newBlock(type: BlockType, extra?: Partial<Block>): Block {
  const b: Block = { id: nid(), type, style: {}, cls: '', anchor: '' };
  if (type === 'p') b.html = '';
  if (type === 'h1') b.html = 'หัวข้อใหญ่สุด';
  if (type === 'h2') b.html = 'หัวข้อใหม่';
  if (type === 'h3') b.html = 'หัวข้อย่อย';
  if (type === 'h4') b.html = 'หัวข้อย่อยเล็ก';
  if (type === 'list') b.items = ['ขั้นตอนแรก', 'ขั้นตอนถัดไป'];
  if (type === 'olist') b.items = ['ขั้นตอนที่หนึ่ง', 'ขั้นตอนที่สอง'];
  if (type === 'todo') { b.items = ['สิ่งที่ต้องตรวจ', 'สิ่งที่ต้องตรวจถัดไป']; b.checks = [false, false]; }
  if (type === 'table') b.cells = [['หัวข้อ', 'รายละเอียด'], ['', ''], ['', '']];
  if (type === 'toggle') { b.title = 'กดเพื่อดูรายละเอียด'; b.body = 'เนื้อหาที่ซ่อนไว้'; }
  if (type === 'quote') b.html = 'ข้อความที่ยกมาจากคู่มือ';
  if (type === 'code') b.html = '# ค่าที่ตั้งไว้บน HMI\nsupply_temp = 80';
  if (type === 'js') {
    b.html = JS_SAMPLE;
    b.auto = false;
  }
  if (type === 'cols') b.items = ['เนื้อหาคอลัมน์ซ้าย', 'เนื้อหาคอลัมน์ขวา'];
  if (type === 'image') { b.src = ''; b.cap = ''; b.name = ''; }
  if (type === 'video') { b.url = ''; b.cap = ''; }
  if (type === 'chart') {
    b.title = 'ยอดผลิตรายวัน';
    b.chartKind = 'bar';
    b.chartSrc = 'production-daily';
    b.days = 14;
    b.cells = [['เดือน', 'ยอดผลิต'], ['ม.ค.', '1200'], ['ก.พ.', '1450']];
  }
  if (type === 'pdf') { b.name = ''; b.meta = ''; b.url = ''; b.mode = 'button'; }
  if (type === 'flow') {
    b.title = 'ลำดับการไหล';
    b.steps = [
      { t: 'ถังน้ำยา\nCaustic', c: '#01579b' },
      { t: 'ปั๊มจ่าย', c: '#1565c0' },
      { t: 'Heat\nExchanger', c: '#b71c1c' },
      { t: 'ไลน์ผลิต', c: '#006064' },
      { t: 'ถังรับกลับ', c: '#4a7c59' },
    ];
  }
  if (type === 'params') {
    b.title = 'ค่าควบคุม';
    b.rows = [
      { p: 'อุณหภูมิน้ำยาจ่าย', set: '80', rng: '78 – 82', u: '°C', pt: 'TT-201', oor: false },
      { p: 'ความเข้มข้น Caustic', set: '2.0', rng: '1.8 – 2.2', u: '%', pt: 'CT-201', oor: false },
      { p: 'อัตราการไหล', set: '18', rng: '16 – 20', u: 'm³/h', pt: 'FT-201', oor: false },
    ];
  }
  if (type === 'alert') { b.level = 'warn'; b.title = 'ข้อควรระวัง'; b.body = 'ใส่ข้อความที่ต้องเน้น'; }
  return { ...b, ...extra };
}

/* ══════════════ ช่องข้อความที่แก้ได้ ══════════════
   เขียน html ลง DOM เฉพาะตอนค่าภายนอกต่างจากที่อยู่ใน DOM จริง
   ถ้าเขียนทับทุกครั้งที่ re-render เคอร์เซอร์จะเด้งไปท้ายบรรทัดตลอดเวลา            */

interface RichProps {
  html: string;
  onChange: (v: string) => void;
  className: string;
  ph?: string;
  plain?: boolean;              // true = เก็บเป็นข้อความล้วน (บล็อกโค้ด/กล่องเตือน)
  tag?: 'div' | 'h2' | 'h3';
  onKeyDown?: (e: React.KeyboardEvent) => void;
}
const Rich: React.FC<RichProps> = ({ html, onChange, className, ph, plain, tag = 'div', onKeyDown }) => {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cur = plain ? el.innerText : el.innerHTML;
    if (cur !== html) {
      if (plain) el.innerText = html || '';
      else el.innerHTML = html || '';
    }
  }, [html, plain]);
  const Tag = tag as React.ElementType;
  return (
    <Tag
      ref={ref}
      className={className}
      contentEditable
      suppressContentEditableWarning
      data-ph={ph}
      onKeyDown={onKeyDown}
      onInput={(e: React.FormEvent<HTMLElement>) =>
        onChange(plain ? e.currentTarget.innerText : e.currentTarget.innerHTML)}
    />
  );
};

/* ══════════════ หน้ารายการบทความ ══════════════ */

const PostList: React.FC<{ onOpen: (id: number | 'new') => void }> = ({ onOpen }) => {
  const [items, setItems] = useState<PostSummary[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // alive กันเซ็ต state ใส่ component ที่ผู้ใช้เปลี่ยนหน้าไปแล้วระหว่างรอ Render ตื่น
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await wakeFetch(`${apiUrl}/api/posts`);
        const j = await r.json();
        if (!alive) return;
        setItems(Array.isArray(j.items) ? j.items : []);
        setErr('');
      } catch (e) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ');
        setItems([]);
      }
    })();
    return () => { alive = false; };
  }, [reloadKey]);

  const shown = (items || []).filter(p => {
    const k = q.trim().toLowerCase();
    if (!k) return true;
    return (p.title || '').toLowerCase().includes(k)
      || (p.category || '').toLowerCase().includes(k)
      || (p.tags || []).some(t => t.toLowerCase().includes(k));
  });

  return (
    <div className="blogx">
      <div className="htitle">✍️ บทความ / คู่มือระบบ</div>
      <div className="hsub">เขียนอธิบายระบบผลิตให้ทีมอ่านเข้าใจ — เผยแพร่แล้วไหลไปเก็บใน Obsidian ให้เอง</div>

      <div className="bl-listhd">
        <div className="bl-search">
          🔎<input value={q} onChange={e => setQ(e.target.value)} placeholder="ค้นหาจากหัวข้อ หมวดหมู่ หรือแท็ก…" />
        </div>
        <span className="grow" />
        <a className="btn-o" href={`${apiUrl}/บทความ`} target="_blank" rel="noopener noreferrer">
          หน้าที่คนอ่านเห็น ↗
        </a>
        <button className="btn-o fill" onClick={() => onOpen('new')}>＋ เขียนบทความใหม่</button>
      </div>

      {items === null && <div className="bl-empty">กำลังโหลด…</div>}

      {err && (
        <div className="bl-empty" style={{ borderColor: '#f6d6d6', background: '#fff8f8', color: 'var(--danger)' }}>
          โหลดรายการไม่สำเร็จ — {err}
          <div style={{ marginTop: 10 }}><button className="btn-o" onClick={() => { setItems(null); setReloadKey(k => k + 1); }}>ลองใหม่</button></div>
        </div>
      )}

      {items !== null && !err && shown.length === 0 && (
        <div className="bl-empty">
          {q ? `ไม่พบบทความที่ตรงกับ "${q}"` : 'ยังไม่มีบทความ — กด “เขียนบทความใหม่” เพื่อเริ่มเรื่องแรก'}
        </div>
      )}

      {shown.length > 0 && (
        <div className="bl-grid">
          {shown.map(p => (
            <button key={p.id} className="bl-card" onClick={() => onOpen(p.id)}>
              <div className="t">{p.title || '(ยังไม่ตั้งชื่อ)'}</div>
              {p.excerpt && <div className="x">{p.excerpt.slice(0, 110)}</div>}
              <div className="m">
                <span className={`bl-badge ${p.status}`}>{STATUS_LABEL[p.status] || p.status}</span>
                {p.category && <span>{p.category}</span>}
                {p.author && <span>· {p.author}</span>}
                {p.updatedAt && <span>· แก้ล่าสุด {String(p.updatedAt).slice(0, 16).replace('T', ' ')}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/* ══════════════ ตัว editor ══════════════ */

interface EditorProps { postId: string; operatorName: string; onBack: () => void; onSaved: (id: number) => void }

const PostEditor: React.FC<EditorProps> = ({ postId, operatorName, onBack, onSaved }) => {
  const isNew = postId === 'new';
  const [post, setPost] = useState<Post | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<'post' | 'block'>('post');
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > 900);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [showMd, setShowMd] = useState(false);
  // คลังไฟล์ที่เปิดอยู่ — blockId=null คือเปิดจากแถบเครื่องมือ (ยังไม่รู้ว่าจะลงบล็อกไหน)
  const [lib, setLib] = useState<null | { blockId: string | null; kind: 'image' | 'pdf' | 'pid' | 'any' | 'cover' }>(null);
  const [tagIn, setTagIn] = useState('');
  const [uploading, setUploading] = useState('');
  const [vaultOn, setVaultOn] = useState<boolean | null>(null);   // null = ยังไม่รู้ (กำลังถาม server)
  const [syncing, setSyncing] = useState(false);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  // ตัวจับจังหวะพิมพ์: id = บล็อกที่กำลังแก้ (null = เพิ่งจดภาพไปแล้ว ไม่ต้องจดซ้ำ)
  const typing = useRef<{ id: string | null; at: number }>({ id: '', at: 0 });
  const [, forceTick] = useState(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const pendingUpload = useRef<{ blockId: string; kind: 'image' | 'pdf' | 'pid' } | null>(null);
  // n เพิ่มทุกครั้งที่กด เพื่อให้ effect ทำงานซ้ำได้แม้เลือกชนิดเดิม
  const pickerN = useRef(0);
  const [picker, setPicker] = useState<{ accept: string; n: number } | null>(null);
  // บล็อกที่เพิ่งแทรก — ต้องย้ายเคอร์เซอร์ไปให้ ไม่งั้นกด Enter แล้วพิมพ์ต่อไม่เข้า
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    const el = document.querySelector(`[data-blk="${id}"] [contenteditable]`) as HTMLElement | null;
    if (!el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  });

  /* ── เซิร์ฟเวอร์ต่อกับ vault อยู่หรือเปล่า ── */
  useEffect(() => {
    let alive = true;
    wakeFetch(`${apiUrl}/api/vault/status`)
      .then(r => r.json())
      .then(j => { if (alive) setVaultOn(!!j.enabled); })
      .catch(() => { if (alive) setVaultOn(false); });
    return () => { alive = false; };
  }, []);

  /* ── โหลดบทความ ── */
  useEffect(() => {
    let alive = true;
    if (isNew) {
      setPost({
        slug: '', title: '', blocks: [], status: 'draft', author: operatorName, category: CATEGORIES[0],
        tags: [], machine: MACHINES[1], excerpt: '', coverUrl: '', seoKeyword: '', seoDesc: '',
        scriptHead: '', scriptBody: '', obsFolder: 'บทความ',
      });
      setBlocks([newBlock('p')]);
      return;
    }
    (async () => {
      try {
        const r = await wakeFetch(`${apiUrl}/api/posts/${postId}`);
        if (!r.ok) throw new Error(r.status === 404 ? 'ไม่พบบทความนี้' : `HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        const p: Post = j.item;
        setPost(p);
        setBlocks(p.blocks?.length ? p.blocks : [newBlock('p')]);
        setNote(`แก้ล่าสุด ${String(p.updatedAt || '').slice(0, 16).replace('T', ' ')}`);
      } catch (e) {
        if (alive) setLoadErr(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ');
      }
    })();
    return () => { alive = false; };
  }, [postId, isNew, operatorName]);

  /* ── ประวัติ undo/redo ── */
  const pushPast = useCallback((state: Block[]) => {
    past.current.push(JSON.stringify(state));
    if (past.current.length > 60) past.current.shift();
    future.current.length = 0;
  }, []);

  // จดภาพก่อนลงมือ — ใช้กับงานที่เป็นก้อนเดียวจบ (เพิ่ม/ลบ/สลับ/เปลี่ยนชนิดบล็อก)
  // typing.id = null แปลว่าเพิ่งจดไปหมาด ๆ การพิมพ์ครั้งถัดไปจึงไม่ต้องจดซ้ำ
  const snap = useCallback(() => {
    pushPast(blocks);
    typing.current = { id: null, at: Date.now() };
    forceTick(n => n + 1);
  }, [blocks, pushPast]);

  const undo = () => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(JSON.stringify(blocks));
    setBlocks(JSON.parse(prev));
    typing.current = { id: '', at: 0 };   // พิมพ์ต่อหลัง undo = เริ่มจดก้อนใหม่
    setDirty(true); forceTick(n => n + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(JSON.stringify(blocks));
    setBlocks(JSON.parse(next));
    typing.current = { id: '', at: 0 };
    setDirty(true); forceTick(n => n + 1);
  };

  // แก้เนื้อในบล็อก — จดภาพให้เองเป็นช่วง ๆ เพื่อให้ปุ่มย้อนกลับใช้กับการพิมพ์ได้ด้วย
  // จดเมื่อ "เริ่มแก้บล็อกใหม่" หรือ "หยุดมือไปเกิน 1 วินาที" ไม่ใช่ทุกตัวอักษร
  // (ไม่งั้นกดย้อนกลับทีนึงได้คืนมาตัวเดียว และ 60 ช่องเต็มตั้งแต่ยังพิมพ์ไม่จบประโยค)
  const patch = (id: string, up: Partial<Block>) => {
    const now = Date.now();
    const t = typing.current;
    if (t.id !== null && (t.id !== id || now - t.at > TYPING_SNAP_GAP)) pushPast(blocks);
    typing.current = { id, at: now };
    setBlocks(bs => bs.map(b => (b.id === id ? { ...b, ...up } : b)));
    setDirty(true);
  };
  const setField = <K extends keyof Post>(k: K, v: Post[K]) => {
    setPost(p => (p ? { ...p, [k]: v } : p));
    setDirty(true);
  };

  const sel = blocks.find(b => b.id === selId) || null;

  /* ── แทรก / จัดการบล็อก ── */
  const insertAfter = (afterId: string | null, type: BlockType, extra?: Partial<Block>) => {
    snap();
    const b = newBlock(type, extra);
    setBlocks(bs => {
      const i = bs.findIndex(x => x.id === afterId);
      const next = [...bs];
      if (i >= 0) next.splice(i + 1, 0, b); else next.push(b);
      // บล็อกใหญ่ควรมีย่อหน้าต่อท้ายให้พิมพ์ต่อได้เลย
      if (['flow', 'params', 'alert', 'image', 'pdf', 'code'].includes(type) && i + 1 >= next.length - 1) {
        next.push(newBlock('p'));
      }
      return next;
    });
    setSelId(b.id);
    focusNext.current = b.id;
    setDirty(true);
    return b;
  };
  const replaceBlock = (id: string, type: BlockType) => {
    snap();
    const b = newBlock(type);
    setBlocks(bs => {
      const i = bs.findIndex(x => x.id === id);
      const next = [...bs];
      if (i >= 0) next.splice(i, 1, b); else next.push(b);
      if (['flow', 'params', 'alert', 'image', 'pdf', 'code'].includes(type) && i === next.length - 1) {
        next.push(newBlock('p'));
      }
      return next;
    });
    setSelId(b.id);
    focusNext.current = b.id;
    setDirty(true);
    return b;
  };
  const blockAct = (id: string, act: 'up' | 'dn' | 'dup' | 'del') => {
    snap();
    setBlocks(bs => {
      const i = bs.findIndex(b => b.id === id);
      if (i < 0) return bs;
      const next = [...bs];
      if (act === 'up' && i > 0) { [next[i - 1], next[i]] = [next[i], next[i - 1]]; }
      if (act === 'dn' && i < next.length - 1) { [next[i + 1], next[i]] = [next[i], next[i + 1]]; }
      if (act === 'dup') next.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(next[i])), id: nid() });
      if (act === 'del') { next.splice(i, 1); if (!next.length) next.push(newBlock('p')); }
      return next;
    });
    if (act === 'del') setSelId(null);
    setDirty(true);
  };

  /* ── สไตล์ของบล็อกที่เลือก ── */
  const styleSel = (k: keyof BlockStyle, v: string | number | '') => {
    if (!sel) return;
    const st: BlockStyle = { ...(sel.style || {}) };
    if (v === '' || v === null) delete st[k];
    else (st as Record<string, unknown>)[k] = v;
    patch(sel.id, { style: st });
  };
  const styleOf = (b: Block): React.CSSProperties => {
    const s = b.style || {};
    return {
      color: s.text || undefined,
      background: s.bg || undefined,
      fontSize: s.fs ? `${s.fs}px` : undefined,
      padding: s.pad !== undefined ? `${s.pad}px` : undefined,
      marginTop: s.mar !== undefined ? `${s.mar}px` : undefined,
      marginBottom: s.mar !== undefined ? `${s.mar}px` : undefined,
      borderWidth: s.bw !== undefined ? `${s.bw}px` : undefined,
      borderStyle: s.bw ? 'solid' : undefined,
      borderColor: s.bw ? (s.bd || '#eee3d9') : undefined,
      borderRadius: s.br !== undefined ? `${s.br}px` : undefined,
    };
  };

  /* ── อัปโหลดไฟล์ ── */
  // source='library' = ไม่อัปโหลดใหม่ แต่ไปหยิบของที่มีอยู่แล้วในคลังไฟล์
  // ⚠️ บล็อกเอกสาร "ไม่กรองชนิดไฟล์" — เครื่องของ user ทำไฟล์ PDF จางกดไม่ติดทั้งที่ส่ง
  //    .pdf กับ application/pdf ไปให้แล้ว (ทดสอบจริง 2026-08-14) ปล่อยไม่กรองจึงเลือกได้เสมอ
  //    ส่วนบล็อกรูปยังกรอง image/* ตามเดิมเพราะใช้งานได้ปกติ
  const pickFile = (blockId: string, kind: 'image' | 'pdf' | 'pid', source: PickSource = 'device') => {
    if (source === 'library') { setLib({ blockId, kind }); return; }
    pendingUpload.current = { blockId, kind };
    // ตั้ง accept ผ่าน state แล้วค่อยเปิดหน้าต่างใน effect — ถ้าตั้งใส่ DOM ตรง ๆ แล้วสั่ง
    // click() ในบรรทัดถัดไป บางเบราว์เซอร์ยังใช้ตัวกรองของครั้งก่อนอยู่
    setPicker({ accept: kind === 'pdf' ? '' : 'image/*', n: pickerN.current++ });
  };
  const doUpload = async (file: File, target: { blockId: string; kind: 'image' | 'pdf' | 'pid' }) => {
    setUploading(`กำลังอัปโหลด ${file.name} (${humanSize(file.size)})…`);
    const r = await uploadFileDetailed(file);
    setUploading('');
    // บอกเหตุผลจริงจากที่เก็บไฟล์ — ไม่งั้นแยกไม่ออกว่าติดชนิดไฟล์ ขนาด หรือสิทธิ์
    if (!r.url) { alert(r.error || 'อัปโหลดไม่สำเร็จ'); return; }
    if (target.kind === 'pid') patch(target.blockId, { pid: r.url });
    else if (target.kind === 'image') patch(target.blockId, { src: r.url, name: file.name });
    else patch(target.blockId, { url: r.url, name: file.name, meta: humanSize(file.size) });
  };
  // Cmd/Ctrl+Z ย้อนกลับ · เพิ่ม Shift = ทำซ้ำ
  // ต้องกันของเบราว์เซอร์ไว้ ไม่งั้นมันจะย้อนตัวหนังสือใน DOM เองโดยที่ข้อมูลในแอปไม่ตาม
  // ช่องกรอกธรรมดา (ชื่อบทความ/แท็ก/สรุปย่อ) ปล่อยให้เป็นของเบราว์เซอร์เหมือนเดิม
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // เปิดหน้าต่างเลือกไฟล์หลัง accept ลง DOM แล้วเท่านั้น
  useEffect(() => {
    if (!picker || !fileRef.current) return;
    fileRef.current.value = '';       // เลือกไฟล์เดิมซ้ำต้องได้
    fileRef.current.click();
  }, [picker]);

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    const t = pendingUpload.current;
    pendingUpload.current = null;
    if (f && t) await doUpload(f, t);
  };
  /* ── คลังไฟล์ ── */
  // blockId = null แปลว่ายังไม่มีบล็อกรองรับ → แทรกบล็อกใหม่ให้ตอนเลือกเสร็จ
  // kind 'cover' = เอาไปเป็นภาพหน้าปกของบทความ ไม่ใช่บล็อกในเนื้อหา
  const libAccept = lib?.kind === 'pdf' ? 'pdf' : lib && lib.kind !== 'any' ? 'image' : 'any';
  const libInsert = (m: MediaItem, opt: MediaInsertOpt) => {
    const t = lib;
    setLib(null);
    if (!t) return;
    const cap = opt.caption ? esc(opt.caption) : '';
    const asImage = (id: string, keepCap: boolean) =>
      patch(id, { src: m.url, name: m.name, ...(cap && !keepCap ? { cap } : {}) });
    const asFile = (id: string) =>
      patch(id, { url: m.url, name: m.name, meta: m.size ? humanSize(m.size) : '', mode: opt.mode });

    if (t.kind === 'cover') { setField('coverUrl', m.url); return; }
    if (t.blockId) {
      if (t.kind === 'pid') patch(t.blockId, { pid: m.url });
      else if (t.kind === 'image') asImage(t.blockId, !!blocks.find(b => b.id === t.blockId)?.cap);
      else asFile(t.blockId);
      setSelId(t.blockId);
      return;
    }
    const b = insertAfter(selId, isImage(m) ? 'image' : 'pdf');
    if (isImage(m)) asImage(b.id, false);
    else asFile(b.id);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    for (const f of files) {
      const isImg = f.type.startsWith('image/');
      // เอกสารดูจากนามสกุลด้วย — ลากไฟล์จาก Finder บางทีเบราว์เซอร์ไม่บอกชนิดมาเลย
      if (!isImg && !isDocFile(f)) continue;
      const b = insertAfter(selId, isImg ? 'image' : 'pdf');
      await doUpload(f, { blockId: b.id, kind: isImg ? 'image' : 'pdf' });
    }
  };

  /* ── บันทึก ── */
  // เอาผล sync ที่ server ส่งมาลงในบทความที่ถืออยู่ (ไม่ต้องโหลดใหม่ทั้งก้อน)
  const vaultFields = (p: Post, v?: VaultResult): Partial<Post> => {
    if (!v || !v.enabled) return {};
    return {
      vaultPath: v.ok ? (v.path || '') : (p.vaultPath || ''),
      vaultSyncedAt: v.at || '',
      vaultError: v.ok ? '' : (v.error || ''),
    };
  };

  const syncNow = async () => {
    if (!post?.id) { alert('บันทึกบทความก่อนถึงจะ sync ได้'); return; }
    setSyncing(true);
    try {
      const r = await wakeFetch(`${apiUrl}/api/posts/${post.id}/sync`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const v: VaultResult = j.vault;
      setPost(p => (p ? { ...p, ...vaultFields(p, v) } : p));
      setNote(v.ok ? (v.removed ? 'ถอนไฟล์ออกจาก vault แล้ว' : 'sync เข้า vault แล้ว') : 'sync ไม่ผ่าน — ' + (v.error || ''));
    } catch (e) {
      alert('sync ไม่สำเร็จ — ' + (e instanceof Error ? e.message : ''));
    } finally { setSyncing(false); }
  };

  const save = async (status?: Post['status']) => {
    if (!post) return;
    const title = post.title.trim();
    if (!title) { alert('ใส่หัวข้อบทความก่อนบันทึก'); return; }
    setSaving(true);
    try {
      const body = {
        ...post,
        id: post.id,
        title,
        slug: post.slug || slugify(title),
        blocks,
        status: status || post.status,
      };
      const r = await wakeFetch(`${apiUrl}/api/posts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const v: VaultResult | undefined = j.vault;
      setPost(p => (p ? { ...p, id: j.id, status: body.status, slug: body.slug, ...vaultFields(p, v) } : p));
      setDirty(false);
      // บันทึกลง DB สำเร็จแล้วเสมอถึงจะมาถึงบรรทัดนี้ — sync ที่ล้มเป็นเรื่องแยก บอกต่อท้ายพอ
      const base = status === 'published' ? 'เผยแพร่แล้ว' : 'บันทึกร่างแล้ว';
      setNote(base + (!v || !v.enabled ? ''
        : v.ok ? (v.removed ? ' · ถอนไฟล์ออกจาก vault แล้ว' : v.skipped ? ' · ไฟล์ใน vault เหมือนเดิม' : ' · เขียนลง vault แล้ว')
          : ' · แต่ sync เข้า vault ไม่ผ่าน'));
      if (isNew && j.id) onSaved(j.id);
    } catch (e) {
      alert('บันทึกไม่สำเร็จ — ' + (e instanceof Error ? e.message : ''));
    } finally { setSaving(false); }
  };

  const removePost = async () => {
    if (!post?.id) { onBack(); return; }
    if (!window.confirm(`ลบบทความ "${post.title}" ทิ้ง?`)) return;
    try {
      await wakeFetch(`${apiUrl}/api/posts/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: post.id }),
      });
      onBack();
    } catch { alert('ลบไม่สำเร็จ'); }
  };

  /* ── markdown สำหรับ Obsidian ── */
  const toMarkdown = (): string => {
    if (!post) return '';
    const mdInline = (h?: string) => {
      const s = (h || '')
        .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
        .replace(/<(b|strong)>(.*?)<\/\1>/gi, '**$2**')
        .replace(/<(i|em)>(.*?)<\/\1>/gi, '*$2*')
        .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      const d = document.createElement('textarea');
      d.innerHTML = s;
      return d.value.trim();
    };
    const title = post.title || 'ยังไม่ตั้งชื่อ';
    const L: string[] = [
      '---',
      `title: ${yamlStr(title)}`,
      // วันที่ยึดจากวันเผยแพร่ครั้งแรก — เผยแพร่ซ้ำแล้ววันที่ในไฟล์ต้องไม่เลื่อนตามวันนี้
      `date: ${String(post.publishedAt || post.updatedAt || '').slice(0, 10) || todayISO()}`,
      `tags: [${post.tags.join(', ')}]`,
      `หมวดหมู่: ${yamlStr(post.category)}`,
      `สถานะ: ${STATUS_LABEL[post.status]}`,
      `ผู้เขียน: ${yamlStr(post.author)}`,
    ];
    if (post.machine) L.push(`เครื่องจักร: "[[${post.machine}]]"`);
    L.push('ที่มา: SPP-MP editor', '---', '', `# ${title}`, '');
    blocks.forEach(b => {
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
        // ใส่ชื่อภาษาไว้ให้ Obsidian ไล่สีให้ — ใน Obsidian เป็นโค้ดอ่านอย่างเดียว รันไม่ได้
        case 'js': L.push('```js', b.html || '', '```', ''); break;
        case 'image': {
          // ยุบขึ้นบรรทัดในคำบรรยายให้เหลือเว้นวรรค ไม่งั้น ![alt](url) ขาดกลาง
          const cap = stripHtml(b.cap).replace(/\s+/g, ' ').trim();
          L.push(`![${cap || b.name || 'ภาพ'}](${b.src || ''})`);
          if (cap) L.push('*' + cap + '*');
          L.push('');
          break;
        }
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
          L.push(`![${b.title || 'กราฟ'}](${chartUrl(b, apiUrl)})`, '');
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
        case 'flow':
          L.push('### ' + (b.title || 'ลำดับการไหล'));
          L.push('```mermaid', 'graph LR');
          (b.steps || []).forEach((s, i) => {
            L.push(`  S${i}["${s.t.replace(/\n/g, ' ')}"]${i < (b.steps || []).length - 1 ? ` --> S${i + 1}` : ''}`);
          });
          L.push('```', '');
          break;
      }
    });
    return L.join('\n');
  };

  /* ── เนื้อบทความย่อ ๆ ส่งไปให้ AI ใช้ประกอบตอนเขียนโค้ด ──
   * ตัดบล็อกโค้ดออกให้หมดก่อน — ป้อนผลงานเก่าของ AI กลับเข้าไปเองคือทางลัดสู่
   * การได้ของหน้าตาเดิมซ้ำ ๆ (แถมโป่งเปล่า ๆ) · รูป/PDF/base64 ก็ไม่มีประโยชน์กับมัน
   */
  const articleContext = (): string => toMarkdown()
    .replace(/^---\n[\s\S]*?\n---\n/, '')            // frontmatter
    .replace(/```[\s\S]*?```/g, '')                   // บล็อกโค้ดทุกชนิด (js/code/mermaid)
    .replace(/!?\[[^\]]*\]\((?:data:|https?:)[^)]*\)/g, '')  // ลิงก์รูป/ไฟล์
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000);

  // ต้องตรงกับ postPath() ใน server/vault.js — ใช้ slug ล้วน ชื่อไฟล์จะได้คงที่ตอนแก้บทความซ้ำ
  const obsPath = () => `${post?.obsFolder || 'บทความ'}/${slugify(post?.slug || post?.title || '')}.md`;

  /* ── ลิงก์หน้าอ่านสาธารณะ ── */
  // หน้าอ่านเสิร์ฟจากเซิร์ฟเวอร์ (ไม่ใช่ Vercel) เพราะต้องมี og: meta ให้ LINE ทำการ์ดพรีวิว
  // ไม่ encode ตอนโชว์/คัดลอก — ลิงก์ภาษาไทยอ่านออกและแปะใน LINE/Telegram ได้ตรง ๆ
  // (เบราว์เซอร์แปลงเป็น %E0%B8… ให้เองตอนเปิด ฝั่งเซิร์ฟเวอร์ decode กลับอยู่แล้ว)
  const readerUrl = `${apiUrl}/บทความ/${slugify(post?.slug || post?.title || '')}`;
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard.writeText(readerUrl)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
      .catch(() => window.prompt('คัดลอกลิงก์นี้', readerUrl));
  };

  /* ── ตัวเลขอ่านง่าย (readability) ── */
  const plain = blocks.map(b => {
    if (['p', 'h1', 'h2', 'h3', 'h4', 'quote'].includes(b.type)) return stripHtml(b.html);
    if (['list', 'olist', 'todo'].includes(b.type)) return (b.items || []).map(stripHtml).join(' ');
    if (b.type === 'table') return (b.cells || []).flat().map(stripHtml).join(' ');
    if (b.type === 'alert' || b.type === 'toggle') return `${b.title} ${b.body}`;
    return '';
  }).join(' ').trim();
  const words = plain ? plain.split(/\s+/).length : 0;
  const sents = plain ? (plain.match(/[.!?ๆ]|\n/g) || []).length + 1 : 0;
  const avg = sents ? words / sents : 0;
  const rd = !words ? { s: 0, l: 'ยังไม่มีเนื้อหา', c: '#ccc' }
    : avg <= 14 ? { s: 92, l: 'อ่านง่ายมาก — ประโยคสั้น กระชับ', c: '#1c8a4c' }
    : avg <= 22 ? { s: 72, l: 'อ่านง่าย — พอดีกับเอกสารงานผลิต', c: '#1c8a4c' }
    : avg <= 32 ? { s: 48, l: 'ประโยคเริ่มยาว — ลองตัดเป็นข้อ ๆ', c: '#c77700' }
    : { s: 24, l: 'ประโยคยาวมาก — คนอ่านหน้างานจะจับใจความยาก', c: '#c62828' };

  if (loadErr) {
    return (
      <div className="blogx">
        <div className="bl-empty" style={{ borderColor: '#f6d6d6', background: '#fff8f8', color: 'var(--danger)' }}>
          {loadErr}
          <div style={{ marginTop: 12 }}><button className="btn-o" onClick={onBack}>← กลับไปรายการบทความ</button></div>
        </div>
      </div>
    );
  }
  if (!post) return <div className="blogx"><div className="bl-empty">กำลังโหลด…</div></div>;

  return (
    <div className="blogx" onDrop={onDrop} onDragOver={e => e.preventDefault()}>
      <input ref={fileRef} type="file" style={{ display: 'none' }}
        accept={picker?.accept || undefined} onChange={onFileChosen} />

      {/* แถบเครื่องมือ */}
      <div className="bl-toolbar">
        <button className="tbtn" title="กลับไปรายการบทความ" onClick={onBack}>←</button>
        <button className="tbtn add" title="เพิ่มบล็อก"
          onClick={() => insertAfter(selId, 'p')}>+</button>
        <button className="tbtn" title="คลังไฟล์ — หยิบรูป/เอกสารที่เคยอัปไว้มาใช้ซ้ำ"
          onClick={() => setLib({ blockId: null, kind: 'any' })}>🗂</button>
        <button className="tbtn" title="ย้อนกลับ" disabled={!past.current.length} onClick={undo}>↶</button>
        <button className="tbtn" title="ทำซ้ำ" disabled={!future.current.length} onClick={redo}>↷</button>
        <span className="tsep" />
        <button className="tbtn" title="ตัวหนา" onMouseDown={e => e.preventDefault()}
          onClick={() => document.execCommand('bold')}><b>B</b></button>
        <button className="tbtn" title="ตัวเอียง" onMouseDown={e => e.preventDefault()}
          onClick={() => document.execCommand('italic')}><i>I</i></button>
        <button className="tbtn" title="ลิงก์" onMouseDown={e => e.preventDefault()} onClick={() => {
          const u = prompt('ใส่ลิงก์', 'https://');
          if (u) document.execCommand('createLink', false, u);
        }}>🔗</button>
        <button className="tbtn" title="โค้ดในบรรทัด" onMouseDown={e => e.preventDefault()} onClick={() => {
          const s = window.getSelection();
          if (!s || s.isCollapsed) { alert('เลือกข้อความที่จะทำเป็นโค้ดก่อน'); return; }
          document.execCommand('insertHTML', false, `<code class="inl">${esc(s.toString())}</code>`);
        }}>&lt;/&gt;</button>
        <span className="tspace" />
        {uploading && <span className="saved-note">{uploading}</span>}
        {!uploading && <span className="saved-note">{dirty ? 'ยังไม่ได้บันทึก' : note}</span>}
        <button className="tlink" disabled={saving} onClick={() => save('draft')}>บันทึกร่าง</button>
        <button className="tbtn primary" disabled={saving} onClick={() => save('published')}>
          {saving ? 'กำลังบันทึก…' : 'เผยแพร่'}
        </button>
        <button className="tbtn" title="เปิด/ปิดแถบตั้งค่า" onClick={() => setSideOpen(o => !o)}>▤</button>
      </div>

      <div className="bl-main">
        <div className="bl-scroll">
          <div className="bl-canvas">
            <Rich
              className="doc-title"
              ph="เพิ่มหัวข้อบทความ"
              plain
              html={post.title}
              onChange={v => setField('title', v)}
            />
            <BlockList
              blocks={blocks}
              selId={selId}
              onSelect={setSelId}
              onPatch={patch}
              onAct={blockAct}
              onReplace={replaceBlock}
              onInsertAfter={insertAfter}
              onPick={pickFile}
              styleOf={styleOf}
            />
          </div>

          {/* meta boxes */}
          <div className="metas">
            <details className="metabox" open>
              <summary>
                🔍 SEO / อ่านง่ายแค่ไหน
                <span className="pill">{post.seoKeyword
                  ? ((post.title + ' ' + plain).toLowerCase().includes(post.seoKeyword.toLowerCase())
                    ? `พบ "${post.seoKeyword}" ในเนื้อหา` : `ยังไม่พบ "${post.seoKeyword}"`)
                  : 'ยังไม่ใส่ focus keyword'}</span>
                <span className="ar">▾</span>
              </summary>
              <div className="metabody">
                <div className="mrow">
                  <label>Focus keyword — ชื่อระบบ / กระบวนการ</label>
                  <input className="minput" value={post.seoKeyword}
                    onChange={e => setField('seoKeyword', e.target.value)}
                    placeholder="เช่น CIP Line 2, Evaporator" />
                </div>
                <div className="mrow">
                  <label>Meta description</label>
                  <textarea className="mtarea" rows={3} value={post.seoDesc}
                    onChange={e => setField('seoDesc', e.target.value)}
                    placeholder="สรุปสั้น ๆ ว่าบทความนี้อธิบายอะไร" />
                  <div className={`counter${post.seoDesc.length > 155 ? ' over' : ''}`}>
                    {post.seoDesc.length} / 155 ตัวอักษร
                  </div>
                </div>
                <div className="mrow">
                  <label>ความง่ายในการอ่าน (Readability)</label>
                  <div className="scorerow">
                    <span className="dotscore" style={{ background: rd.c }} />
                    <span>{rd.l}</span>
                  </div>
                  <div className="meter"><i style={{ width: `${rd.s}%`, background: rd.c }} /></div>
                  <div className="hintx">
                    {words ? `${words} คำ · ${blocks.length} บล็อก · ประโยคเฉลี่ย ~${avg.toFixed(0)} คำ`
                      : 'ประเมินจากความยาวประโยคเฉลี่ย'}
                  </div>
                </div>
              </div>
            </details>

            <details className="metabox">
              <summary>🧩 สคริปต์เฉพาะหน้านี้ <span className="ar">▾</span></summary>
              <div className="metabody">
                <div className="mrow">
                  <label>แทรกใน &lt;head&gt;</label>
                  <textarea className="mtarea mono" rows={3} value={post.scriptHead}
                    onChange={e => setField('scriptHead', e.target.value)} />
                </div>
                <div className="mrow">
                  <label>แทรกก่อนปิด &lt;/body&gt;</label>
                  <textarea className="mtarea mono" rows={3} value={post.scriptBody}
                    onChange={e => setField('scriptBody', e.target.value)} />
                </div>
                <div className="hintx">⚠️ สคริปต์รันเฉพาะหน้าบทความนี้ — ใส่เฉพาะของที่รู้ที่มา</div>
              </div>
            </details>

            <details className="metabox" open>
              <summary>🪨 Obsidian <span className="pill">สองทาง</span><span className="ar">▾</span></summary>
              <div className="metabody">
                <div className="obs-grid">
                  <div>
                    <div className="mrow">
                      <label>โฟลเดอร์ปลายทางใน vault</label>
                      <select className="mselect" value={post.obsFolder}
                        onChange={e => setField('obsFolder', e.target.value)}>
                        {OBS_FOLDERS.map(f => <option key={f}>{f}</option>)}
                      </select>
                    </div>
                    <div className="mrow">
                      <label>เชื่อมกับเครื่องจักร (wikilink)</label>
                      <select className="mselect" value={post.machine}
                        onChange={e => setField('machine', e.target.value)}>
                        {MACHINES.map(m => <option key={m}>{m}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <div className="mrow">
                      <label>ไฟล์ที่จะถูกเขียน</label>
                      <div className="obs-path">{obsPath()}</div>
                    </div>
                    <div className="mrow">
                      <label>แท็กที่จะติดไปกับไฟล์</label>
                      <div className="chips">
                        {post.tags.length === 0 && <span className="hintx" style={{ margin: 0 }}>ยังไม่มีแท็ก</span>}
                        {post.tags.map(t => <span className="chip" key={t}>#{t}</span>)}
                      </div>
                    </div>
                  </div>
                </div>
                <div className={`obs-status${post.vaultError ? ' bad' : post.vaultPath ? ' ok' : ''}`}>
                  {vaultOn === false ? (
                    <>⚪ เซิร์ฟเวอร์ยังไม่ได้ต่อกับ vault — ตั้ง <code>VAULT_GITHUB_TOKEN</code> ก่อนถึงจะเขียนไฟล์จริงได้</>
                  ) : post.vaultError ? (
                    <>🔴 sync ล่าสุดไม่ผ่าน — {post.vaultError}</>
                  ) : post.vaultPath ? (
                    <>🟢 อยู่ใน vault แล้ว: <b>{post.vaultPath}</b>
                      {post.vaultSyncedAt && <> · เมื่อ {String(post.vaultSyncedAt).slice(0, 16).replace('T', ' ')}</>}</>
                  ) : post.status === 'published' ? (
                    <>🟡 เผยแพร่แล้วแต่ยังไม่ได้เขียนลง vault — กด sync เดี๋ยวนี้</>
                  ) : (
                    <>⚪ ไฟล์จะถูกเขียนตอนกด "เผยแพร่"</>
                  )}
                </div>
                <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn-o" onClick={() => setShowMd(true)}>ดู markdown ที่จะถูกเขียน</button>
                  <button className="btn-o" onClick={syncNow}
                    disabled={syncing || !post.id || vaultOn === false}>
                    {syncing ? 'กำลัง sync…' : 'sync เดี๋ยวนี้'}
                  </button>
                  <button className="btn-o danger" onClick={removePost}>ลบบทความนี้</button>
                </div>
              </div>
            </details>
          </div>
        </div>

        {/* แถบตั้งค่า */}
        <aside className={`bl-side${sideOpen ? '' : ' hide'}`}>
          <div className="side-tabs">
            <button className={sideTab === 'post' ? 'on' : ''} onClick={() => setSideTab('post')}>บทความ</button>
            <button className={sideTab === 'block' ? 'on' : ''} onClick={() => setSideTab('block')}>บล็อก</button>
            <button className="x" onClick={() => setSideOpen(false)}>✕</button>
          </div>

          {sideTab === 'post' && (
            <div className="spanel">
              <div className="sgrp">
                <h4>สถานะและการเผยแพร่</h4>
                <div className="srow">
                  <label>สถานะ</label>
                  <select className="sselect" value={post.status}
                    onChange={e => setField('status', e.target.value as Post['status'])}>
                    {(Object.keys(STATUS_LABEL) as Post['status'][]).map(s =>
                      <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </div>
                <div className="srow">
                  <label>ผู้เขียน</label>
                  <input className="sinput" value={post.author} onChange={e => setField('author', e.target.value)} />
                </div>
                {post.publishedAt && (
                  <div className="hintx">เผยแพร่ครั้งแรก {String(post.publishedAt).slice(0, 16).replace('T', ' ')}</div>
                )}
              </div>
              <div className="sgrp">
                <h4>ลิงก์ถาวร</h4>
                <input className="sinput" style={{ width: '100%' }} value={post.slug}
                  placeholder={slugify(post.title)}
                  onChange={e => setField('slug', e.target.value)} />
                <div className="obs-path" style={{ marginTop: 8 }}>{readerUrl}</div>
                {post.status === 'published' ? (
                  <>
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn-o" onClick={copyLink}>{copied ? '✓ คัดลอกแล้ว' : 'คัดลอกลิงก์'}</button>
                      <a className="btn-o" href={readerUrl} target="_blank" rel="noopener noreferrer">เปิดหน้าอ่าน ↗</a>
                    </div>
                    <div className="hintx">ส่งลิงก์นี้ให้ใครก็ได้ เปิดอ่านได้เลยไม่ต้องล็อกอิน</div>
                  </>
                ) : (
                  <div className="hintx">ลิงก์นี้จะเปิดได้หลังกด "เผยแพร่" — ตอนนี้ยังเป็น{STATUS_LABEL[post.status]}</div>
                )}
              </div>
              <div className="sgrp">
                <h4>หมวดหมู่</h4>
                <select className="sselect" style={{ width: '100%' }} value={post.category}
                  onChange={e => setField('category', e.target.value)}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="sgrp">
                <h4>แท็ก</h4>
                <div className="chips" style={{ marginBottom: 8 }}>
                  {post.tags.length === 0 && <span className="hintx" style={{ margin: 0 }}>ยังไม่มีแท็ก</span>}
                  {post.tags.map((t, i) => (
                    <span className="chip" key={t}>#{t}
                      <button title="เอาออก" onClick={() =>
                        setField('tags', post.tags.filter((_, j) => j !== i))}>×</button>
                    </span>
                  ))}
                </div>
                <input className="sinput" style={{ width: '100%' }} value={tagIn}
                  placeholder="พิมพ์แล้วกด Enter"
                  onChange={e => setTagIn(e.target.value)}
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const v = tagIn.trim().replace(/^#/, '');
                    if (v && !post.tags.includes(v)) setField('tags', [...post.tags, v]);
                    setTagIn('');
                  }} />
              </div>
              <div className="sgrp">
                <h4>ภาพหน้าปก</h4>
                {post.coverUrl
                  ? <div className="cover-prev"><img src={post.coverUrl} alt="ภาพหน้าปก" /></div>
                  : <div className="hintx" style={{ marginTop: 0 }}>ยังไม่ได้ตั้ง — หน้าอ่านจะหยิบรูปแรกในบทความไปทำการ์ดตอนแชร์</div>}
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 8 }}>
                  <button className="btn-o" onClick={() => setLib({ blockId: null, kind: 'cover' })}>
                    {post.coverUrl ? 'เปลี่ยนภาพหน้าปก' : 'เลือกจากคลังไฟล์'}
                  </button>
                  {post.coverUrl && <button className="btn-o danger" onClick={() => setField('coverUrl', '')}>เอาออก</button>}
                </div>
              </div>
              <div className="sgrp">
                <h4>สรุปย่อ</h4>
                <textarea className="starea" rows={3} value={post.excerpt}
                  onChange={e => setField('excerpt', e.target.value)}
                  placeholder="สรุป 1-2 บรรทัด ใช้โชว์ในรายการบทความ" />
              </div>
            </div>
          )}

          {sideTab === 'block' && (
            <div className="spanel">
              <div className="sgrp blkinfo">
                <div className="bi-ic">{sel ? BT[sel.type].ic : '¶'}</div>
                <div>
                  <div className="bi-t">{sel ? BT[sel.type].t : 'ยังไม่ได้เลือกบล็อก'}</div>
                  <div className="bi-d">{sel ? BT[sel.type].d : 'คลิกบล็อกในหน้าเพื่อตั้งค่าเฉพาะบล็อกนั้น'}</div>
                </div>
              </div>

              {sel && <BlockSpecific b={sel} onPatch={patch} onPick={pickFile} onSnap={snap} onArticleText={articleContext} />}

              <div className="sgrp">
                <h4>สี</h4>
                <div className="colorline">
                  <span className="dot" style={{ background: sel?.style?.text || 'transparent' }} />
                  <span className="lb">ตัวอักษร</span>
                </div>
                <div className="swatches">
                  {['', '#2b2119', '#c62828', '#c77700', '#1c8a4c', '#1565c0', '#6a1b9a'].map(c => (
                    <button key={'t' + c} className={`sw${c ? '' : ' none'}${(sel?.style?.text || '') === c ? ' on' : ''}`}
                      style={c ? { background: c } : undefined} title={c || 'ไม่กำหนด'}
                      onClick={() => styleSel('text', c)} />
                  ))}
                </div>
                <div className="colorline" style={{ marginTop: 12 }}>
                  <span className="dot" style={{ background: sel?.style?.bg || 'transparent' }} />
                  <span className="lb">พื้นหลัง</span>
                </div>
                <div className="swatches">
                  {['', '#fff3ea', '#fdecec', '#fff6e6', '#e9f7ee', '#e8f1fb', '#f4ede6'].map(c => (
                    <button key={'b' + c} className={`sw${c ? '' : ' none'}${(sel?.style?.bg || '') === c ? ' on' : ''}`}
                      style={c ? { background: c } : undefined} title={c || 'ไม่กำหนด'}
                      onClick={() => styleSel('bg', c)} />
                  ))}
                </div>
                <div className="hintx">ใช้ไฮไลต์จุดวิกฤตของระบบ เช่น ค่าที่ห้ามเกิน</div>
              </div>

              <div className="sgrp">
                <h4>ตัวอักษร</h4>
                <div className="fsizes">
                  {[['', 'ปกติ'], ['14', 'S'], ['16.5', 'M'], ['19', 'L'], ['23', 'XL'], ['28', 'XXL']].map(([v, l]) => (
                    <button key={l} className={(sel?.style?.fs ? String(sel.style.fs) : '') === v ? 'on' : ''}
                      onClick={() => styleSel('fs', v ? Number(v) : '')}>{l}</button>
                  ))}
                </div>
              </div>

              <div className="sgrp">
                <h4>ระยะขอบ</h4>
                <div className="srow">
                  <label>ระยะใน</label>
                  <input className="rng" type="range" min={0} max={40}
                    value={sel?.style?.pad ?? 4} onChange={e => styleSel('pad', Number(e.target.value))} />
                  <span style={{ fontSize: 12, width: 34, textAlign: 'right' }}>{sel?.style?.pad ?? 4}px</span>
                </div>
                <div className="srow">
                  <label>ระยะนอก</label>
                  <input className="rng" type="range" min={0} max={48}
                    value={sel?.style?.mar ?? 0} onChange={e => styleSel('mar', Number(e.target.value))} />
                  <span style={{ fontSize: 12, width: 34, textAlign: 'right' }}>{sel?.style?.mar ?? 0}px</span>
                </div>
              </div>

              <div className="sgrp">
                <h4>เส้นขอบ</h4>
                <div className="srow">
                  <label>ความหนา</label>
                  <input className="rng" type="range" min={0} max={6}
                    value={sel?.style?.bw ?? 0} onChange={e => styleSel('bw', Number(e.target.value))} />
                  <span style={{ fontSize: 12, width: 34, textAlign: 'right' }}>{sel?.style?.bw ?? 0}px</span>
                </div>
                <div className="srow">
                  <label>ความมน</label>
                  <input className="rng" type="range" min={0} max={28}
                    value={sel?.style?.br ?? 10} onChange={e => styleSel('br', Number(e.target.value))} />
                  <span style={{ fontSize: 12, width: 34, textAlign: 'right' }}>{sel?.style?.br ?? 10}px</span>
                </div>
                <div className="srow">
                  <label>สีเส้น</label>
                  <input type="color" className="swcolor" value={sel?.style?.bd || '#eee3d9'}
                    onChange={e => styleSel('bd', e.target.value)} />
                  <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{sel?.style?.bd || '#eee3d9'}</span>
                </div>
              </div>

              <div className="sgrp">
                <h4>ขั้นสูง</h4>
                <div className="srow">
                  <label>CSS class</label>
                  <input className="sinput" value={sel?.cls || ''} disabled={!sel}
                    placeholder="เช่น critical-note"
                    onChange={e => sel && patch(sel.id, { cls: e.target.value })} />
                </div>
                <div className="srow">
                  <label>HTML anchor</label>
                  <input className="sinput" value={sel?.anchor || ''} disabled={!sel}
                    placeholder="เช่น cip-step-3"
                    onChange={e => sel && patch(sel.id, { anchor: e.target.value })} />
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {lib && (
        <MediaLibrary
          accept={libAccept}
          uploadedBy={post.author}
          insertLabel={lib.kind === 'cover' ? 'ตั้งเป็นภาพหน้าปก'
            : lib.blockId ? 'ใส่ในบล็อกนี้' : 'แทรกลงบทความ'}
          onInsert={libInsert}
          onClose={() => setLib(null)}
        />
      )}

      {showMd && (
        <>
          <div className="blogx-ov" onClick={() => setShowMd(false)} />
          <div className="blogx-modal">
            <div className="modal-hd">
              <h3>📄 markdown ที่จะถูกเขียนลง vault</h3>
              <button className="x" onClick={() => setShowMd(false)}>✕</button>
            </div>
            <pre className="mdview">{toMarkdown()}</pre>
            <div className="modal-ft">
              <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{obsPath()}</span>
              <span style={{ marginLeft: 'auto' }} />
              <button className="btn-o" onClick={() => {
                navigator.clipboard.writeText(toMarkdown()).catch(() => null);
              }}>คัดลอก</button>
              <button className="btn-o fill" onClick={() => setShowMd(false)}>ปิด</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/* ══════════════ รายการบล็อก + เมนู / ══════════════ */

interface BlockListProps {
  blocks: Block[];
  selId: string | null;
  onSelect: (id: string) => void;
  onPatch: (id: string, up: Partial<Block>) => void;
  onAct: (id: string, act: 'up' | 'dn' | 'dup' | 'del') => void;
  onReplace: (id: string, t: BlockType) => Block;
  onInsertAfter: (afterId: string | null, t: BlockType) => Block;
  onPick: (blockId: string, kind: 'image' | 'pdf' | 'pid', source?: PickSource) => void;
  styleOf: (b: Block) => React.CSSProperties;
}

const BlockList: React.FC<BlockListProps> = ({ blocks, selId, onSelect, onPatch, onAct, onReplace, onInsertAfter, onPick, styleOf }) => {
  const [slash, setSlash] = useState<{ forId: string; top: number; left: number; q: string; cur: number } | null>(null);

  const list = slash
    ? BLOCK_TYPES.filter(b => {
        const q = slash.q.toLowerCase().replace(/^\//, '');
        return !q || b.t.toLowerCase().includes(q) || b.k.toLowerCase().includes(q) || b.d.toLowerCase().includes(q);
      })
    : [];

  const pick = (t: BlockType) => {
    if (!slash) return;
    const forId = slash.forId;
    setSlash(null);
    onReplace(forId, t);
  };

  const keyDown = (b: Block) => (e: React.KeyboardEvent) => {
    if (slash && slash.forId === b.id) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlash(s => s && { ...s, cur: (s.cur + 1) % Math.max(1, list.length) }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlash(s => s && { ...s, cur: (s.cur - 1 + list.length) % Math.max(1, list.length) }); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (list[slash.cur]) pick(list[slash.cur].id); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return; }
      if (e.key === 'Backspace' && slash.q.length <= 1) { setSlash(null); return; }
      if (e.key.length === 1) { const ch = e.key; setSlash(s => s && { ...s, q: s.q + ch, cur: 0 }); return; }
      return;
    }
    if (e.key === '/' && b.type === 'p' && !e.currentTarget.textContent?.trim()) {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      onSelect(b.id);
      setSlash({ forId: b.id, top: r.bottom + window.scrollY + 6, left: r.left + window.scrollX, q: '', cur: 0 });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && ['p', 'h2', 'h3', 'quote'].includes(b.type)) {
      e.preventDefault();
      onInsertAfter(b.id, 'p');
    }
  };

  useEffect(() => {
    if (!slash) return;
    const close = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement).closest('.blogx-slash')) setSlash(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [slash]);

  return (
    <>
      <div className="blocks">
        {blocks.map(b => (
          <div
            key={b.id}
            id={b.anchor || undefined}
            data-blk={b.id}
            className={`blk${b.id === selId ? ' sel' : ''}${b.cls ? ' ' + b.cls : ''}`}
            style={styleOf(b)}
            onClick={e => { if (!(e.target as HTMLElement).closest('.blk-tools')) onSelect(b.id); }}
          >
            <span className="blk-kind">{BT[b.type].t}</span>
            <div className="blk-tools">
              <button title="เลื่อนขึ้น" onClick={() => onAct(b.id, 'up')}>▲</button>
              <button title="เลื่อนลง" onClick={() => onAct(b.id, 'dn')}>▼</button>
              <button title="ทำซ้ำ" onClick={() => onAct(b.id, 'dup')}>⧉</button>
              <button title="ลบ" className="del" onClick={() => onAct(b.id, 'del')}>🗑</button>
            </div>
            <BlockBody b={b} onPatch={onPatch} onPick={onPick} onKeyDown={keyDown(b)} />
          </div>
        ))}
      </div>

      {slash && (
        <div className="blogx-slash" style={{ top: slash.top, left: slash.left }}>
          {list.length === 0 && <div className="empty">ไม่พบบล็อกที่ตรงกับ "{slash.q}"</div>}
          {list.map((bt, i) => {
            const showHead = i === 0 || list[i - 1].grp !== bt.grp;
            return (
              <React.Fragment key={bt.id}>
                {showHead && <div className="sh">{bt.grp}</div>}
                <button className={i === slash.cur ? 'cur' : ''}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => pick(bt.id)}>
                  <span className="bic">{bt.ic}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="bt">{bt.t}</span><br />
                    <span className="bd">{bt.d}</span>
                  </span>
                  <span className="bk">{bt.k}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </>
  );
};

/* ══════════════ เนื้อในของแต่ละบล็อก ══════════════ */

const BlockBody: React.FC<{
  b: Block;
  onPatch: (id: string, up: Partial<Block>) => void;
  onPick: (blockId: string, kind: 'image' | 'pdf' | 'pid', source?: PickSource) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}> = ({ b, onPatch, onPick, onKeyDown }) => {
  const set = (up: Partial<Block>) => onPatch(b.id, up);

  switch (b.type) {
    case 'p':
      return <Rich className="ed-p" ph="พิมพ์ / เพื่อเลือกบล็อก" html={b.html || ''}
        onChange={v => set({ html: v })} onKeyDown={onKeyDown} />;
    case 'h1':
      return <Rich tag="h2" className="ed-h1" html={b.html || ''} onChange={v => set({ html: v })} onKeyDown={onKeyDown} />;
    case 'h2':
      return <Rich tag="h2" className="ed-h2" html={b.html || ''} onChange={v => set({ html: v })} onKeyDown={onKeyDown} />;
    case 'h3':
      return <Rich tag="h3" className="ed-h3" html={b.html || ''} onChange={v => set({ html: v })} onKeyDown={onKeyDown} />;
    case 'h4':
      return <Rich tag="h3" className="ed-h4" html={b.html || ''} onChange={v => set({ html: v })} onKeyDown={onKeyDown} />;
    case 'divider':
      return <hr className="ed-hr" />;
    case 'toggle':
      return (
        <details className="ed-toggle" open>
          <summary>
            <Rich className="ed-toggle-hd" html={b.title || ''} onChange={v => set({ title: v })} />
          </summary>
          <Rich className="ed-toggle-bd" plain ph="รายละเอียดที่ซ่อนไว้"
            html={b.body || ''} onChange={v => set({ body: v })} />
        </details>
      );
    case 'quote':
      return <Rich className="ed-quote" html={b.html || ''} onChange={v => set({ html: v })} onKeyDown={onKeyDown} />;
    case 'code':
      return <Rich className="ed-code" plain html={b.html || ''} onChange={v => set({ html: v })} />;
    case 'js':
      return <JsBlock b={b} onPatch={onPatch} />;
    case 'list':
    case 'olist': {
      const Tag = b.type === 'olist' ? 'ol' : 'ul';
      return (
        <Tag className={b.type === 'olist' ? 'ed-olist' : 'ed-list'}>
          {(b.items || []).map((it, i) => (
            <li key={i}>
              <Rich className="" html={it} onChange={v => {
                const next = [...(b.items || [])]; next[i] = v; set({ items: next });
              }} onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const next = [...(b.items || [])];
                  next.splice(i + 1, 0, '');
                  set({ items: next });
                }
              }} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'todo':
      return (
        <ul className="ed-todo">
          {(b.items || []).map((it, i) => (
            <li key={i}>
              <input type="checkbox" checked={!!(b.checks || [])[i]}
                onChange={e => {
                  const next = [...(b.checks || [])];
                  while (next.length < (b.items || []).length) next.push(false);
                  next[i] = e.target.checked;
                  set({ checks: next });
                }} />
              <Rich className="" html={it} onChange={v => {
                const next = [...(b.items || [])]; next[i] = v; set({ items: next });
              }} onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const items = [...(b.items || [])];
                  const checks = [...(b.checks || [])];
                  items.splice(i + 1, 0, '');
                  checks.splice(i + 1, 0, false);
                  set({ items, checks });
                }
              }} />
            </li>
          ))}
        </ul>
      );
    case 'table': {
      const cells = b.cells || [['', '']];
      const setCell = (r: number, c: number, v: string) => {
        const next = cells.map(row => [...row]);
        next[r][c] = v;
        set({ cells: next });
      };
      const cols = cells[0]?.length || 2;
      return (
        <div className="ed-tablewrap">
          <table className="ed-table">
            <tbody>
              {cells.map((row, r) => (
                <tr key={r} className={r === 0 ? 'hd' : ''}>
                  {row.map((cel, c) => (
                    <td key={c}>
                      <Rich className="" html={cel} onChange={v => setCell(r, c, v)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ed-tbtns">
            <button onClick={() => set({ cells: [...cells.map(r => [...r]), Array(cols).fill('')] })}>＋ แถว</button>
            <button onClick={() => set({ cells: cells.map(r => [...r, '']) })}>＋ คอลัมน์</button>
            <button disabled={cells.length <= 1}
              onClick={() => set({ cells: cells.slice(0, -1) })}>− แถว</button>
            <button disabled={cols <= 1}
              onClick={() => set({ cells: cells.map(r => r.slice(0, -1)) })}>− คอลัมน์</button>
          </div>
        </div>
      );
    }
    case 'cols': {
      const cols = b.items || ['', ''];
      return (
        <div>
          <div className={`ed-cols c${cols.length}`}>
            {cols.map((it, i) => (
              <div key={i} className="col">
                <Rich className="ed-p" ph={`คอลัมน์ที่ ${i + 1}`} html={it}
                  onChange={v => { const n = [...cols]; n[i] = v; set({ items: n }); }} />
              </div>
            ))}
          </div>
          <div className="ed-tbtns">
            <button disabled={cols.length >= 3} onClick={() => set({ items: [...cols, ''] })}>＋ คอลัมน์</button>
            <button disabled={cols.length <= 2} onClick={() => set({ items: cols.slice(0, -1) })}>− คอลัมน์</button>
          </div>
        </div>
      );
    }
    case 'video': {
      const emb = videoEmbed(b.url || '');
      return (
        <>
          <input className="sinput" style={{ width: '100%' }} value={b.url || ''}
            placeholder="วางลิงก์ YouTube หรือ Google Drive ตรงนี้"
            onChange={e => set({ url: e.target.value })} />
          {emb && (
            <div className="ed-video">
              {emb.kind === 'file'
                ? <video src={emb.src} controls />
                : <iframe src={emb.src} title="วิดีโอ" allowFullScreen
                  allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" />}
            </div>
          )}
          {!emb && b.url && (
            <div className="hintx">ลิงก์นี้ยังอ่านไม่ออก — รองรับ YouTube, Google Drive และไฟล์ .mp4/.webm</div>
          )}
          <Rich className="ed-cap" ph="คำบรรยายวิดีโอ" html={b.cap || ''} onChange={v => set({ cap: v })} />
        </>
      );
    }
    case 'chart': {
      const manual = (b.chartSrc || 'manual') === 'manual';
      const cells = b.cells || [['', '']];
      const setCell = (r: number, c: number, v: string) => {
        const next = cells.map(row => [...row]);
        next[r][c] = v;
        set({ cells: next });
      };
      return (
        <div className="ed-chart">
          <div className="ed-chartbar">
            <select className="sselect" value={b.chartSrc || 'manual'} onChange={e => set({ chartSrc: e.target.value })}>
              {CHART_SOURCES.map(s => <option key={s.id} value={s.id}>{s.t}</option>)}
            </select>
            <select className="sselect" value={b.chartKind || 'bar'}
              onChange={e => set({ chartKind: e.target.value as 'bar' | 'line' })}>
              <option value="bar">แท่ง</option>
              <option value="line">เส้น</option>
            </select>
            {!manual && (
              <select className="sselect" value={b.days || 14} onChange={e => set({ days: Number(e.target.value) })}>
                {[7, 14, 30, 90].map(d => <option key={d} value={d}>ย้อนหลัง {d} วัน</option>)}
              </select>
            )}
            <input className="sinput" style={{ flex: 1, minWidth: 140 }} value={b.title || ''}
              placeholder="ชื่อกราฟ" onChange={e => set({ title: e.target.value })} />
          </div>
          <img className="ed-chartimg" src={chartUrl(b, apiUrl)} alt={b.title || 'กราฟ'} />
          {manual && (
            <div className="ed-tablewrap">
              <table className="ed-table">
                <tbody>
                  {cells.map((row, r) => (
                    <tr key={r} className={r === 0 ? 'hd' : ''}>
                      {row.map((cel, c) => (
                        <td key={c}>
                          <Rich className="" html={cel} onChange={v => setCell(r, c, v)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="ed-tbtns">
                <button onClick={() => set({ cells: [...cells.map(r => [...r]), Array(cells[0].length).fill('')] })}>＋ แถว</button>
                <button onClick={() => set({ cells: cells.map(r => [...r, '']) })}>＋ ชุดข้อมูล</button>
                <button disabled={cells.length <= 2} onClick={() => set({ cells: cells.slice(0, -1) })}>− แถว</button>
                <button disabled={(cells[0]?.length || 0) <= 2} onClick={() => set({ cells: cells.map(r => r.slice(0, -1)) })}>− ชุดข้อมูล</button>
              </div>
              <div className="hintx">ช่องซ้ายสุด = ชื่อแกน · แถวบนสุด = ชื่อชุดข้อมูล · กราฟอัปเดตหลังบันทึก</div>
            </div>
          )}
          {!manual && <div className="hintx">ดึงตัวเลขจริงจากระบบตอนเปิดอ่าน — นับเฉพาะยอดที่อนุมัติแล้ว หน่วยกล่อง</div>}
        </div>
      );
    }
    case 'image':
      return (
        <>
          {b.src ? (
            <figure className="ed-fig"><img src={b.src} alt={stripHtml(b.cap)} /></figure>
          ) : (
            <div className="ph-pick">
              <button className="cover-ph" onClick={() => onPick(b.id, 'image')}>
                🖼 อัปโหลดรูปจากเครื่อง<small>หรือลากไฟล์มาวางบนหน้าก็ได้</small>
              </button>
              <button className="cover-ph" onClick={() => onPick(b.id, 'image', 'library')}>
                🗂 เลือกจากคลังไฟล์<small>รูปที่เคยอัปไว้แล้ว</small>
              </button>
            </div>
          )}
          <Rich className="ed-cap" ph="ใส่คำบรรยายภาพ เช่น จอแสดงค่า X ตอนสภาวะผิดปกติ"
            html={b.cap || ''} onChange={v => set({ cap: v })} />
        </>
      );
    case 'pdf':
      if (!b.url) {
        return (
          <div className="ph-pick">
            <button className="cover-ph" onClick={() => onPick(b.id, 'pdf')}>
              📕 อัปโหลดเอกสารจากเครื่อง<small>PDF, Word, Excel — SOP, คู่มือเครื่อง, รายงาน</small>
            </button>
            <button className="cover-ph" onClick={() => onPick(b.id, 'pdf', 'library')}>
              🗂 เลือกจากคลังไฟล์<small>ไฟล์ที่เคยอัปไว้แล้ว ไม่ต้องอัปซ้ำ</small>
            </button>
          </div>
        );
      }
      if (b.mode === 'embed') {
        return (
          <div className="ed-pdf-emb">
            <div className="bar"><span>📕</span><span>{b.name}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--ink-soft)', fontWeight: 400 }}>{b.meta}</span></div>
            <iframe src={b.url} title={b.name || 'PDF'} />
          </div>
        );
      }
      return (
        <div className="ed-pdf-btn">
          <div className="ic">📕</div>
          <div style={{ minWidth: 0 }}>
            <div className="nm">{b.name}</div>
            <div className="mt">{b.meta}</div>
          </div>
          <a className="dl" href={b.url} target="_blank" rel="noreferrer">ดาวน์โหลด</a>
        </div>
      );
    case 'flow':
      return (
        <div className="pflow">
          <div className="pflow-hd">
            <span className="b">PROCESS FLOW</span>
            <Rich className="t" plain html={b.title || ''} onChange={v => set({ title: v })} />
          </div>
          <div className="pflow-chain">
            {(b.steps || []).map((s, i) => (
              <React.Fragment key={i}>
                <Rich className="pstep" plain html={s.t} onChange={v => {
                  const next = [...(b.steps || [])]; next[i] = { ...next[i], t: v }; set({ steps: next });
                }} />
                {i < (b.steps || []).length - 1 && <span className="parrow">›</span>}
              </React.Fragment>
            ))}
          </div>
          {b.pid
            ? <div className="pflow-img"><img src={b.pid} alt="P&ID" /></div>
            : <div className="ph-pick">
                <button className="pflow-img" onClick={() => onPick(b.id, 'pid')}>🖼 แนบภาพ P&amp;ID ของช่วงนี้</button>
                <button className="pflow-img" onClick={() => onPick(b.id, 'pid', 'library')}>🗂 เลือกจากคลังไฟล์</button>
              </div>}
        </div>
      );
    case 'params':
      return (
        <div className="ptbl-wrap">
          <div className="ptbl-hd">
            <span>⊞</span>
            <Rich className="t" plain html={b.title || ''} onChange={v => set({ title: v })} />
          </div>
          <div className="ptbl-scroll">
            <table className="ptbl">
              <thead>
                <tr><th>พารามิเตอร์</th><th>ค่าตั้ง</th><th>ช่วงปกติ</th><th>หน่วย</th><th>จุดวัด</th></tr>
              </thead>
              <tbody>
                {(b.rows || []).map((r, i) => {
                  const cell = (k: keyof ParamRow, cls?: string) => (
                    <td className={cls}>
                      <Rich className="" plain html={String(r[k])} onChange={v => {
                        const next = [...(b.rows || [])];
                        next[i] = { ...next[i], [k]: v };
                        set({ rows: next });
                      }} />
                    </td>
                  );
                  return (
                    <tr key={i} className={r.oor ? 'oor' : ''}>
                      <td>
                        <Rich className="" plain html={r.p} onChange={v => {
                          const next = [...(b.rows || [])]; next[i] = { ...next[i], p: v }; set({ rows: next });
                        }} />
                        {r.oor && <span className="oor-flag">หลุดช่วง</span>}
                      </td>
                      {cell('set', 'num')}
                      {cell('rng')}
                      {cell('u')}
                      {cell('pt')}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    case 'alert': {
      const ic = b.level === 'danger' ? '🛑' : b.level === 'warn' ? '⚠️' : 'ℹ️';
      return (
        <div className={`alertb ${b.level}`}>
          <span className="ic">{ic}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Rich className="t" plain html={b.title || ''} onChange={v => set({ title: v })} />
            <Rich className="d" plain html={b.body || ''} onChange={v => set({ body: v })} />
          </div>
        </div>
      );
    }
    default:
      return null;
  }
};

/* ══════════════ ตั้งค่าที่มีเฉพาะบล็อกบางชนิด ══════════════ */

/* ══════════════ บล็อกโค้ดที่รันได้ ══════════════
   โค้ดรันในกล่องแยก (ดู lib/runJs.ts) แตะหน้าเว็บจริงไม่ได้
   แยกเป็นคอมโพเนนต์ต่างหากเพราะต้องเก็บสถานะ "ผลลัพธ์ล่าสุด" ของตัวเอง */

const JsOutput: React.FC<{ lines: RunLine[]; error: string; ms: number }> = ({ lines, error, ms }) => (
  <div className={`jsrun-out${error ? ' bad' : ''}`}>
    {lines.map((l, i) => (
      <div key={i} className={`ln ${l.k}`}>{l.k === 'ret' ? '⟶ ' : ''}{l.v}</div>
    ))}
    {error && <div className="ln err">✕ {error}</div>}
    {!error && !lines.length && <div className="ln muted">รันแล้วไม่มีผลลัพธ์ — ลอง console.log() หรือ return ค่ากลับมา</div>}
    <div className="ms">ใช้เวลา {ms} ms</div>
  </div>
);

const JsBlock: React.FC<{ b: Block; onPatch: (id: string, patch: Partial<Block>) => void }> = ({ b, onPatch }) => {
  const [res, setRes] = useState<{ lines: RunLine[]; error: string; ms: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState(false);          // โหมดวาดภาพ: กล่องยังเดินอยู่ไหม
  const stage = useRef<HTMLDivElement>(null);
  const handle = useRef<RunHandle | null>(null);

  const stop = useCallback(() => {
    handle.current?.stop();
    handle.current = null;
    setLive(false);
  }, []);
  // ออกจากบล็อก/ปิดหน้าแล้วต้องไม่ทิ้งกล่องที่ยังวิ่งอยู่
  useEffect(() => stop, [stop]);

  const run = async () => {
    stop();
    setRunning(true);
    const r = await runJs(b.html || '', { mount: b.draw ? stage.current : null });
    handle.current = r;
    setRes({ lines: r.lines, error: r.error, ms: r.ms });
    setLive(!!b.draw && !r.error);
    setRunning(false);
  };

  return (
    <div className="jsrun-ed">
      <div className="jsrun-bar">
        <span className="tag">{b.draw ? 'ภาพเคลื่อนไหว' : 'JavaScript'}</span>
        <span className="hint">รันในกล่องแยก แตะหน้าเว็บไม่ได้ · ต่อเน็ตไม่ได้</span>
        {live && <button className="go stop" onClick={stop}>■ หยุด</button>}
        <button className="go" disabled={running} onClick={run}>
          {running ? 'กำลังรัน…' : live ? '↻ เริ่มใหม่' : '▶ รัน'}
        </button>
      </div>
      {b.draw && (
        // กล่องถูกยัดเข้า .mount ด้วยมือ (นอกสายตา React) — จึงต้องเป็น div ที่ React
        // ไม่เคยวางลูกไว้เอง ไม่งั้น React จะไล่เก็บโหนดที่เราเปลี่ยนไปแล้วจนกล่องหาย
        <div className="jsrun-stage" style={{ height: (b.h || 320) + 'px' }}>
          <div className="mount" ref={stage} />
          {!live && <div className="ph">กด ▶ รัน เพื่อดูภาพเคลื่อนไหว</div>}
        </div>
      )}
      <Rich className="ed-code" plain html={b.html || ''} onChange={v => onPatch(b.id, { html: v })} />
      {res && (res.error || !b.draw || res.lines.length > 0) && <JsOutput {...res} />}
    </div>
  );
};

/* ══════════════ สั่ง AI เขียนโค้ดให้ ══════════════
 * เขียนลง b.html เฉย ๆ — ทั้ง 4 ที่ที่ต้อง sync กัน (BlockBody / renderBlock /
 * toMarkdown / postToMarkdown) อ่าน b.html ล้วน จึงไม่ต้องแตะ renderer สักตัว
 */
const CTX_KEY = 'spp-jsai-ctx';     // "ใช้บทความประกอบ" เป็นความชอบของคนใช้ ไม่ใช่เนื้อหาบทความ
const WEBGL_KEY = 'spp-jsai-webgl'; // "ลอง 3D ด้วย WebGL" — default ปิด (ต่างจาก useCtx) เพราะเสี่ยงกว่า
let lastOkAt = 0;                   // คุยกับ server ครั้งล่าสุด — ใช้ตัดสินว่าต้องปลุกก่อนไหม

type Phase = 'idle' | 'waking' | 'gen' | 'verify' | 'repair';

const JsAiPanel: React.FC<{
  b: Block;
  act: (up: Partial<Block>) => void;
  onArticleText: () => string;
}> = ({ b, act, onArticleText }) => {
  const [prompt, setPrompt] = useState('');
  const [useCtx, setUseCtx] = useState(() => localStorage.getItem(CTX_KEY) !== '0');
  const [useWebgl, setUseWebgl] = useState(() => localStorage.getItem(WEBGL_KEY) === '1');
  const [phase, setPhase] = useState<Phase>('idle');
  const [secs, setSecs] = useState(0);
  const [note, setNote] = useState('');
  const [warn, setWarn] = useState('');
  const [err, setErr] = useState('');
  const [prevHtml, setPrevHtml] = useState<string | null>(null);
  const [lastAi, setLastAi] = useState('');
  const [askSwap, setAskSwap] = useState('');   // โค้ดที่รอถามว่าจะสลับโหมดไหม
  const stage = useRef<HTMLDivElement>(null);
  const handle = useRef<{ stop: () => void } | null>(null);
  const alive = useRef(true);

  const busy = phase !== 'idle';
  const ctxLen = useCtx ? onArticleText().length : 0;

  // ⚠️ ต้องตั้ง true ในตัว effect ด้วย ไม่ใช่เขียนแต่ cleanup — StrictMode ตอน dev รัน
  // effect สองรอบ (mount → cleanup → mount) ถ้าตั้งแค่ตอน useRef ค่าจะค้างเป็น false
  // ตลอดกาล แล้วทุกงานจะหยุดเงียบ ๆ กลางคัน (สถานะค้างที่ "กำลังปลุกเซิร์ฟเวอร์")
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; handle.current?.stop(); };
  }, []);

  // ตัวนับวินาทีเดินจริง — สปินเนอร์นิ่ง 25 วินาทีคนอ่านว่าค้าง
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setSecs(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const ยิง = async (body: Record<string, unknown>) => {
    // ⚠️ retries: 0 บังคับ — ค่า default คือ 2 กับงบ 20 วิ จะ abort งานที่ใช้ 25 วิ
    //    แล้วยิง Sonnet ซ้ำสามครั้ง จ่ายสามเท่าและน่าจะไม่ได้คำตอบเลย
    // ⚠️ 300 วิไม่ใช่ 120 — คำสั่ง WebGL ที่รายละเอียดเยอะวัดได้จริง 136 วินาที
    //    (โมเดลคิดนานขึ้นตามความซับซ้อน + โค้ด 3 มิติยาวกว่า 2D มาก)
    //    ตั้ง 120 ไว้จะ abort ทิ้งทั้งที่เซิร์ฟเวอร์กำลังจะตอบ = จ่ายเงินแล้วไม่ได้ของ
    const r = await wakeFetch(`${apiUrl}/api/blog/js-gen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), retries: 0, timeoutMs: 300000,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    lastOkAt = Date.now();
    return j as { code: string; note?: string };
  };

  const ลง = (code: string, extra?: Partial<Block>) => {
    setPrevHtml(b.html || '');
    setLastAi(code);
    // ลงครั้งเดียวตอนจบ = undo หนึ่งก้าว (act เรียก onSnap ให้แล้ว)
    act({ html: code, ...(b.draw ? { auto: true } : {}), ...extra });
  };

  const สร้าง = async () => {
    const คำสั่ง = prompt.trim();
    if (!คำสั่ง || busy) return;
    // เงื่อนไขเดียวกับปุ่มตัวอย่างสำเร็จรูป + ไม่ถามซ้ำถ้าเพิ่งสร้างไปเอง
    const เขียนเอง = b.html && b.html !== JS_SAMPLE && b.html !== lastAi
      && !ANIM_TEMPLATES.some(x => x.code === b.html);
    if (เขียนเอง && !confirm('ทับโค้ดที่เขียนไว้ด้วยโค้ดจาก AI?')) return;

    setErr(''); setWarn(''); setNote(''); setAskSwap(''); setSecs(0);
    handle.current?.stop(); handle.current = null;
    const mode = b.draw ? 'draw' : 'calc';

    try {
      // Render หลับหลัง 15 นาที — ปลุกด้วย GET ถูก ๆ ก่อน ไม่งั้นเวลาตื่นไปกินงบของงานจริง
      if (Date.now() - lastOkAt > 10 * 60 * 1000) {
        setPhase('waking');
        try { await wakeFetch(`${apiUrl}/api/operators`, { retries: 1 }); lastOkAt = Date.now(); } catch { /* ปลุกไม่ติดก็ลองยิงงานจริงเลย */ }
        if (!alive.current) return;
      }

      setPhase('gen');
      const j = await ยิง({
        prompt: คำสั่ง, mode, h: b.h || 0, context: useCtx ? onArticleText() : '',
        webgl: mode === 'draw' && useWebgl,
      });
      if (!alive.current) return;

      // สั่งโหมดคำนวณแต่ได้โค้ดวาดภาพมา — เสนอให้สลับ อย่าสลับเอง
      if (mode === 'calc' && /requestAnimationFrame/.test(j.code)) {
        setPhase('idle'); setNote(j.note || ''); setAskSwap(j.code);
        return;
      }

      setPhase('verify');
      let v = await verifyJs(j.code, { draw: b.draw ?? false, mount: stage.current });
      if (!alive.current) { v.stop(); return; }
      handle.current = v;
      let code = j.code, note = j.note || '';

      // ซ่อมรอบเดียว — รอบสองยังพังแปลว่าต้องเขียนใหม่ ไม่ใช่แปะ patch
      if (v.level === 'error') {
        setPhase('repair');
        const j2 = await ยิง({
          prompt: คำสั่ง, mode, h: b.h || 0, context: useCtx ? onArticleText() : '',
          webgl: mode === 'draw' && useWebgl,
          previous: { code: j.code, error: v.repairHint },
        });
        if (!alive.current) return;
        setPhase('verify');
        v.stop();
        v = await verifyJs(j2.code, { draw: b.draw ?? false, mount: stage.current });
        if (!alive.current) { v.stop(); return; }
        handle.current = v;
        code = j2.code; note = j2.note || note;
      }

      setPhase('idle');
      setNote(note);
      if (v.level === 'error') { setErr(v.reason); setAskSwap(code); return; }  // ให้คนเลือกว่าจะเอาอยู่ดีไหม
      if (v.level === 'warn') setWarn(v.reason);
      ลง(code);
    } catch (e) {
      if (!alive.current) return;
      setPhase('idle');
      setErr(e instanceof Error ? e.message : 'สั่งไม่สำเร็จ');
    }
  };

  return (
    <div className="jsai">
      <h4>🪄 บอกความต้องการ แล้วให้ AI เขียนโค้ดให้</h4>
      <textarea className="starea" rows={3} value={prompt} disabled={busy}
        onChange={e => setPrompt(e.target.value)}
        placeholder="เช่น ช่วยสร้างระบบผลิตน้ำเชื่อมแต่งกลิ่นตามบทความที่ผมเขียน สไตล์มินิมอล" />
      <label className="chkline">
        <input type="checkbox" checked={useCtx} disabled={busy}
          onChange={e => { setUseCtx(e.target.checked); localStorage.setItem(CTX_KEY, e.target.checked ? '1' : '0'); }} />
        ใช้บทความนี้ประกอบ{useCtx ? ` (${ctxLen.toLocaleString()} ตัวอักษร)` : ''}
      </label>
      {b.draw && (
        <label className="chkline">
          <input type="checkbox" checked={useWebgl} disabled={busy}
            onChange={e => { setUseWebgl(e.target.checked); localStorage.setItem(WEBGL_KEY, e.target.checked ? '1' : '0'); }} />
          🧪 ลอง 3D จริงด้วย WebGL (ทดลอง — พังง่ายกว่าโหมด 2D ปกติ)
        </label>
      )}
      <button className="btn-o fill jsai-go" disabled={busy || !prompt.trim()} onClick={สร้าง}>
        ✨ เขียนโค้ดให้
      </button>

      {phase === 'waking' && <div className="jsai-st">⏳ กำลังปลุกเซิร์ฟเวอร์… · {secs}s</div>}
      {/* เวลาจริงต่างกันมากระหว่างสองโหมด — 3D วัดได้ถึง 136 วิ ถ้าบอก "15-30" คนจะนึกว่าค้าง */}
      {phase === 'gen' && (
        <div className="jsai-st">
          🪄 กำลังเขียนโค้ด… ({useWebgl && b.draw ? '3D ใช้เวลานาน 1-3 นาที' : 'ปกติ 15-30 วินาที'}) · {secs}s
        </div>
      )}
      {phase === 'verify' && <div className="jsai-st">🔍 กำลังลองรันดู… · {secs}s</div>}
      {phase === 'repair' && <div className="jsai-st">🔧 เจอปัญหา กำลังให้ AI แก้ให้ (รอบสุดท้าย)… · {secs}s</div>}

      {!busy && err && <div className="jsai-st bad">✕ {err}</div>}
      {!busy && !err && warn && <div className="jsai-st warn">⚠️ {warn}</div>}
      {!busy && !err && !warn && !askSwap && note && <div className="jsai-st ok">✅ ใส่โค้ดในบล็อกแล้ว — {note}</div>}

      {!busy && askSwap && (
        <div className="jsai-ask">
          {err
            ? 'ซ่อมแล้วยังไม่ผ่าน จะใส่โค้ดนี้ลงบล็อกอยู่ดีไหม?'
            : 'โค้ดที่ได้เป็นภาพเคลื่อนไหว แต่บล็อกนี้ตั้งเป็นโหมดคำนวณอยู่'}
          <div className="jsai-btns">
            {!err && (
              <button className="btn-o" onClick={() => { ลง(askSwap, { draw: true, h: b.h || 320, auto: true }); setAskSwap(''); setWarn(''); }}>
                สลับเป็นโหมด 🎞 แล้วใส่โค้ด
              </button>
            )}
            <button className="btn-o" onClick={() => { ลง(askSwap); setAskSwap(''); setErr(''); }}>
              ใส่โค้ดนี้อยู่ดี
            </button>
            <button className="btn-o" onClick={() => { setAskSwap(''); setErr(''); }}>ยกเลิก</button>
          </div>
        </div>
      )}

      {b.draw && (
        // ต้องมองเห็นจริง ๆ ไม่ใช่ซ่อนไว้นอกจอ — เบราว์เซอร์หรี่ rAF ของ iframe ที่ไม่อยู่ใน
        // viewport แล้วตัวตรวจจะนับได้ 0 เฟรมทั้งที่โค้ดไม่ผิด (mount แบบ .mount ที่ React ไม่แตะ)
        <div className="jsai-stage"><div className="mount" ref={stage} /></div>
      )}

      {prevHtml !== null && b.html === lastAi && (
        <button className="btn-o jsai-undo" onClick={() => { act({ html: prevHtml }); setNote(''); setWarn(''); }}>
          ↩︎ ย้อนกลับโค้ดเดิม
        </button>
      )}
    </div>
  );
};

const BlockSpecific: React.FC<{
  b: Block;
  onPatch: (id: string, up: Partial<Block>) => void;
  onPick: (blockId: string, kind: 'image' | 'pdf' | 'pid', source?: PickSource) => void;
  onSnap: () => void;
  onArticleText: () => string;
}> = ({ b, onPatch, onPick, onSnap, onArticleText }) => {
  if (!['alert', 'pdf', 'params', 'flow', 'image', 'js'].includes(b.type)) return null;
  const act = (up: Partial<Block>) => { onSnap(); onPatch(b.id, up); };

  return (
    <div className="sgrp">
      <h4>ตั้งค่า{BT[b.type].t}</h4>

      {b.type === 'js' && (
        <>
          <div className="fsizes col">
            {([[false, '🧮 คำนวณ — ได้ผลเป็นตัวหนังสือ'], [true, '🎞 วาดภาพ / เคลื่อนไหว']] as const).map(([v, l]) => (
              <button key={String(v)} className={!!b.draw === v ? 'on' : ''}
                onClick={() => act({
                  draw: v,
                  ...(v && !b.h ? { h: 320 } : {}),
                  // เปลี่ยนมาโหมดวาดภาพทั้งที่ยังเป็นโค้ดตัวอย่างคำนวณ = ใส่ตัวอย่างวาดภาพให้เลย
                  ...(v && (!b.html || b.html === JS_SAMPLE) ? { html: ANIM_TEMPLATES[0].code, auto: true } : {}),
                })}>{l}</button>
            ))}
          </div>
          {b.draw && (
            <>
              <div className="srow" style={{ marginTop: 10 }}>
                <label>สูง</label>
                <input className="sinput" type="number" min={120} max={800} step={20}
                  value={b.h || 320} onChange={e => act({ h: Math.max(120, Math.min(800, Number(e.target.value) || 320)) })} />
                <span className="hintx" style={{ margin: 0 }}>px</span>
              </div>
              <div className="tmpl-list">
                {ANIM_TEMPLATES.map(t => (
                  <button key={t.id} onClick={() => {
                    const เขียนเอง = b.html && b.html !== JS_SAMPLE
                      && !ANIM_TEMPLATES.some(x => x.code === b.html);
                    if (เขียนเอง && !confirm(`ทับโค้ดที่เขียนไว้ด้วยตัวอย่าง "${t.ชื่อ}"?`)) return;
                    act({ html: t.code, auto: true });
                  }}>
                    <span className="ic">{t.ic}</span>
                    <span>
                      <b>{t.ชื่อ}</b>
                      <small>{t.คำอธิบาย}</small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {/* key = b.id บังคับ — BlockSpecific ไม่เคยถูก remount ตอนเปลี่ยนบล็อก
              (element ชนิดเดิมตำแหน่งเดิม React reuse instance) ข้อความที่พิมพ์ค้างจะไหลข้ามบล็อก */}
          <JsAiPanel key={b.id} b={b} act={act} onArticleText={onArticleText} />
          <label className="chkline" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={!!b.auto} onChange={e => act({ auto: e.target.checked })} />
            รันเองตอนคนเปิดหน้าอ่าน
          </label>
          <div className="hintx">
            ไม่ติ๊ก = คนอ่านเห็นโค้ดกับปุ่ม "▶ กดเพื่อรัน" แล้วเลือกเองว่าจะรันไหม
            (ภาพเคลื่อนไหวควรติ๊กไว้)<br />
            โค้ดรันในกล่องแยกที่แตะหน้าเว็บจริงไม่ได้ และ<b>ต่อเน็ตไม่ได้</b> ·
            โค้ดที่ค้างเกิน 3 วินาทีระบบหยุดให้เอง<br />
            โหมดคำนวณ: ผลมาจาก <code className="inl">console.log()</code> และค่าที่ <code className="inl">return</code><br />
            โหมดวาดภาพ: วาดลงกล่องด้วย <code className="inl">document.body</code> / canvas ได้ตามใจ<br />
            เขียนโค้ดเองไม่เป็นก็ได้ — พิมพ์บอกในช่อง 🪄 ข้างบน แล้วให้ AI เขียนให้
          </div>
        </>
      )}

      {b.type === 'alert' && (
        <>
          <div className="fsizes col">
            {([['danger', '🛑 อันตราย — ห้ามพลาด'], ['warn', '⚠️ ระวัง — ควรรู้ก่อนทำ'], ['info', 'ℹ️ ข้อมูล — อธิบายเพิ่ม']] as const).map(([v, l]) => (
              <button key={v} className={b.level === v ? 'on' : ''} onClick={() => act({ level: v })}>{l}</button>
            ))}
          </div>
          <div className="hintx">ทั้ง 3 ระดับแปลงเป็น callout ของ Obsidian ได้ตรง ๆ</div>
        </>
      )}

      {b.type === 'pdf' && (
        <>
          <div className="fsizes col">
            {([['button', '📎 ปุ่มดาวน์โหลด'], ['embed', '📖 ฝังตัวอ่านในหน้า']] as const).map(([v, l]) => (
              <button key={v} className={b.mode === v ? 'on' : ''} onClick={() => act({ mode: v })}>{l}</button>
            ))}
          </div>
          <div className="minibtns" style={{ marginTop: 8 }}>
            <button onClick={() => onPick(b.id, 'pdf')}>📕 เปลี่ยนไฟล์</button>
            <button onClick={() => onPick(b.id, 'pdf', 'library')}>🗂 จากคลังไฟล์</button>
          </div>
          <div className="hintx">{b.name || 'ยังไม่ได้เลือกไฟล์'}{b.meta ? ` · ${b.meta}` : ''}</div>
        </>
      )}

      {b.type === 'image' && (
        <>
          <div className="minibtns">
            <button onClick={() => onPick(b.id, 'image')}>🖼 เปลี่ยนรูป</button>
            <button onClick={() => onPick(b.id, 'image', 'library')}>🗂 จากคลังไฟล์</button>
          </div>
          <div className="hintx">{b.name || 'ยังไม่ได้เลือกรูป'}</div>
        </>
      )}

      {b.type === 'flow' && (
        <>
          <div className="minibtns">
            <button onClick={() => act({ steps: [...(b.steps || []), { t: 'ขั้นตอนใหม่', c: '#6a1b9a' }] })}>＋ เพิ่มขั้นตอน</button>
            <button onClick={() => (b.steps || []).length > 2 && act({ steps: (b.steps || []).slice(0, -1) })}>− ลบขั้นตอนท้าย</button>
            <button onClick={() => onPick(b.id, 'pid')}>🖼 แนบภาพ P&amp;ID</button>
            <button onClick={() => onPick(b.id, 'pid', 'library')}>🗂 จากคลังไฟล์</button>
          </div>
          <div className="hintx">{(b.steps || []).length} ขั้นตอน · แก้ชื่อได้ที่กล่องในหน้า · ส่งออกเป็น mermaid</div>
        </>
      )}

      {b.type === 'params' && (
        <>
          <div className="oorlist">
            {(b.rows || []).map((r, i) => (
              <label key={i}>
                <input type="checkbox" checked={r.oor} onChange={() => {
                  const next = [...(b.rows || [])];
                  next[i] = { ...next[i], oor: !next[i].oor };
                  act({ rows: next });
                }} />
                {r.p || `แถวที่ ${i + 1}`}
              </label>
            ))}
          </div>
          <div className="minibtns">
            <button onClick={() => act({ rows: [...(b.rows || []), { p: 'พารามิเตอร์ใหม่', set: '', rng: '', u: '', pt: '', oor: false }] })}>
              ＋ เพิ่มแถว
            </button>
          </div>
          <div className="hintx">ติ๊กแถวที่ค่าหลุดช่วง — จะถูกไฮไลต์แดงและติด ⚠️ ไปใน markdown ด้วย</div>
        </>
      )}
    </div>
  );
};

/* ══════════════ ตัวห่อ: สลับระหว่างรายการกับ editor ตาม URL ══════════════ */

const BlogEditor: React.FC<{ operatorName: string }> = ({ operatorName }) => {
  const [route, navigate] = useAppRoute();
  const item = route.item;

  if (!item) return <PostList onOpen={id => navigate({ item: String(id) })} />;
  return (
    <PostEditor
      key={item}
      postId={item}
      operatorName={operatorName}
      onBack={() => navigate({ item: null })}
      onSaved={id => navigate({ item: String(id) }, true)}
    />
  );
};

export default BlogEditor;
