/* ══════════════ ร่างกันงานหาย ══════════════
 * เก็บสิ่งที่กำลังเขียนอยู่ไว้ในเครื่อง (localStorage) ทุกครั้งที่หยุดมือ
 * เพื่อให้ปิดแท็บ / รีเฟรช / เน็ตหลุด / เซิร์ฟเวอร์หลับตอนกดบันทึก แล้วยังได้งานคืน
 *
 * มี 2 ช่องต่อบทความ:
 *   spp-blog-draft-<id>          = ร่างที่กำลังพิมพ์อยู่ตอนนี้
 *   spp-blog-draft-<id>:rescued  = ร่างที่เจอค้างไว้ตอนเปิดหน้า รอคนกดกู้คืนหรือทิ้ง
 *
 * ที่ต้องแยกสองช่อง เพราะถ้าเปิดหน้าแล้วเจอร่างค้าง คนอาจไม่กดอะไรเลยแล้วพิมพ์ต่อ —
 * ถ้าใช้ช่องเดียว การพิมพ์ครั้งแรกจะทับร่างเก่าทิ้งทันทีทั้งที่ยังไม่ได้ถามใคร
 */

export interface BlogDraft<P = unknown, B = unknown> {
  v: 1;
  at: string;          // เวลาที่เก็บ (ISO)
  base?: string;       // updatedAt ของฝั่งเซิร์ฟเวอร์ตอนที่เริ่มแก้ — ไว้เทียบว่าใครใหม่กว่า
  title?: string;      // ไว้โชว์ในข้อความถามกู้คืน โดยไม่ต้องแกะ post ทั้งก้อน
  post: P;
  blocks: B[];
}

const PREFIX = 'spp-blog-draft-';
const RESCUE = ':rescued';
/** ร่างที่เก่ากว่านี้ถือว่าเลิกสนใจแล้ว — เก็บไว้รกเปล่า ๆ และกินโควตาที่เก็บ */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** ใหญ่กว่านี้ไม่เก็บ (ตัวอักษร) — localStorage ให้มาราว 5MB ทั้งโดเมน ต้องเผื่อของคนอื่นด้วย */
const MAX_CHARS = 1_500_000;

export type WriteResult = 'ok' | 'too-big' | 'full';

const mainKey = (postId: string) => PREFIX + postId;
const rescueKey = (postId: string) => PREFIX + postId + RESCUE;

function read(key: string): BlogDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as BlogDraft;
    return d && d.v === 1 && d.at ? d : null;
  } catch { return null; }
}

function remove(key: string) {
  try { localStorage.removeItem(key); } catch { /* โหมดส่วนตัวบางเบราว์เซอร์ห้ามแตะ */ }
}

/** ลบร่างที่เก่าเกิน 7 วัน และของที่พังจนอ่านไม่ออก — เรียกตอนเปิด editor */
export function pruneDrafts(now = Date.now()): number {
  let n = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const d = read(k);
      const t = d ? Date.parse(d.at) : NaN;
      if (!d || !Number.isFinite(t) || now - t > MAX_AGE_MS) { remove(k); n++; }
    }
  } catch { /* ไม่มี localStorage ก็ไม่ต้องเก็บกวาด */ }
  return n;
}

/** เก็บร่างลงเครื่อง — คืนเหตุผลกลับไปให้ UI บอกคนเขียนได้ว่าทำไมไม่ได้เก็บ */
export function writeDraft<P, B>(postId: string, draft: BlogDraft<P, B>): WriteResult {
  let s: string;
  try { s = JSON.stringify(draft); } catch { return 'too-big'; }
  // บทความที่มีรูป base64 ฝังในเนื้อหาโป่งเกินโควตาได้ง่าย ๆ — กันไว้ก่อนจะโดนเบราว์เซอร์ปฏิเสธ
  if (s.length > MAX_CHARS) return 'too-big';
  try {
    localStorage.setItem(mainKey(postId), s);
    return 'ok';
  } catch {
    // เต็ม — เก็บกวาดของเก่าแล้วลองอีกครั้งเดียว
    pruneDrafts();
    try { localStorage.setItem(mainKey(postId), s); return 'ok'; } catch { return 'full'; }
  }
}

/**
 * เอาร่างที่ค้างอยู่ออกมาถาม แล้ว "ย้าย" ไปไว้ช่องรอกู้คืน
 * ทั้งสองช่องถูกล้างเสมอ เหลือแค่ตัวที่ใหม่ที่สุดในช่องรอกู้คืน — ช่องหลักจึงว่างให้พิมพ์ต่อได้เลย
 */
export function takeDraft<P, B>(postId: string): BlogDraft<P, B> | null {
  const a = read(mainKey(postId));
  const b = read(rescueKey(postId));
  const pick = !a ? b : !b ? a : (Date.parse(a.at) >= Date.parse(b.at) ? a : b);
  remove(mainKey(postId));
  remove(rescueKey(postId));
  if (!pick) return null;
  try { localStorage.setItem(rescueKey(postId), JSON.stringify(pick)); } catch { /* เก็บไม่ได้ก็ยังถามจากในหน่วยความจำได้ */ }
  return pick as BlogDraft<P, B>;
}

/** คนตัดสินใจแล้ว (กู้คืนหรือทิ้ง) — ช่องรอกู้คืนหมดหน้าที่ */
export function dropRescued(postId: string) { remove(rescueKey(postId)); }

/** บันทึกขึ้นเซิร์ฟเวอร์สำเร็จแล้ว = ไม่มีอะไรค้างอีก */
export function clearDrafts(postId: string) {
  remove(mainKey(postId));
  remove(rescueKey(postId));
}

/** id ของบทความที่ยังมีร่างค้างอยู่ในเครื่อง — ให้หน้ารายการติดป้ายบอกได้ว่าอันไหนมีของค้าง */
export function draftIds(): Set<string> {
  const out = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      out.add(k.slice(PREFIX.length).replace(new RegExp(RESCUE + '$'), ''));
    }
  } catch { /* อ่านไม่ได้ก็ไม่ต้องติดป้าย */ }
  return out;
}
