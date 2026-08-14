// คลังไฟล์ (เฟส 2) — ไฟล์จริงอยู่บน Supabase Storage ส่วน "ทะเบียน" อยู่ที่เซิร์ฟเวอร์เรา
// เหตุผลที่ต้องมีทะเบียน: ชื่อไฟล์ในที่เก็บถูกสุ่มเป็น <timestamp>-<สุ่ม>.<ext>
// เปิดดูย้อนหลังแล้วไม่รู้เลยว่าอันไหนคืออะไร — ทะเบียนเก็บชื่อจริง โฟลเดอร์ แท็ก คำบรรยาย
import { supabase } from './supabase';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

export const MEDIA_BUCKET = 'learning-images';

export interface MediaItem {
  id: number;
  url: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  folder: string;
  tags: string[];
  caption: string;
  uploadedBy: string;
  createdAt: string;
}

/** โฟลเดอร์ตามพื้นที่ผลิต — ตรงกับหมวดหมู่บทความเพื่อให้เดาที่อยู่ของไฟล์ได้ */
export const MEDIA_FOLDERS = ['ระบบ CIP', 'Boiler', 'Evaporator', 'Mixing / Syrup', 'บรรจุ', 'SCADA / HMI', 'SOP / เอกสาร'];

export const isImage = (m: Pick<MediaItem, 'mime' | 'name'>) =>
  m.mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(m.name);
export const isPdf = (m: Pick<MediaItem, 'mime' | 'name'>) =>
  m.mime.includes('pdf') || /\.pdf$/i.test(m.name);

export interface MediaList {
  items: MediaItem[];
  folders: { folder: string; n: number }[];
}

export async function listMedia(opts: { q?: string; folder?: string; kind?: string } = {}): Promise<MediaList> {
  const p = new URLSearchParams();
  if (opts.q) p.set('q', opts.q);
  if (opts.folder) p.set('folder', opts.folder);
  if (opts.kind) p.set('kind', opts.kind);
  const r = await fetch(`${apiUrl}/api/media?${p.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return { items: j.items || [], folders: j.folders || [] };
}

export interface MediaDraft {
  url: string;
  path?: string;
  name?: string;
  mime?: string;
  size?: number;
  folder?: string;
  tags?: string[];
  caption?: string;
  uploadedBy?: string;
  createdAt?: string;
}

/** ลงทะเบียนไฟล์เข้าคลัง — ล้มเหลวแล้วคืน null เฉย ๆ ไฟล์ที่อัปไปแล้วยังใช้ได้ตามปกติ */
export async function registerMedia(draft: MediaDraft): Promise<MediaItem | null> {
  try {
    const r = await fetch(`${apiUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (!r.ok) return null;
    return (await r.json()).item as MediaItem;
  } catch { return null; }
}

export async function patchMedia(id: number, body: Partial<Pick<MediaItem, 'name' | 'folder' | 'caption' | 'tags'>>): Promise<MediaItem> {
  const r = await fetch(`${apiUrl}/api/media/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.item as MediaItem;
}

/** เอาออกจากทะเบียนเท่านั้น — ไฟล์ยังอยู่ในที่เก็บ (หน้าเว็บไม่มีสิทธิ์ลบของจริง) */
export async function deleteMedia(id: number): Promise<void> {
  const r = await fetch(`${apiUrl}/api/media/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
}

/**
 * สแกนไฟล์เก่าใน bucket เข้าทะเบียน — ของที่ลงทะเบียนแล้วจะไม่ถูกแตะ
 * ไฟล์เก่าไม่มีชื่อจริงเหลืออยู่ (ตอนอัปโหลดสมัยนั้นไม่ได้จด) จึงใช้ path เป็นชื่อไปก่อน
 */
export async function scanStorage(): Promise<{ added: number; skipped: number }> {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase ในหน้าเว็บนี้');
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET)
    .list('', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) throw new Error(error.message);
  const pub = (p: string) => supabase!.storage.from(MEDIA_BUCKET).getPublicUrl(p).data.publicUrl;
  const items: MediaDraft[] = (data || [])
    .filter(o => o.name && !o.name.startsWith('.'))   // .emptyFolderPlaceholder ของ Supabase
    .map(o => ({
      url: pub(o.name),
      path: o.name,
      name: o.name,
      mime: (o.metadata?.mimetype as string) || '',
      size: Number(o.metadata?.size || 0),
      createdAt: String(o.created_at || '').replace('Z', '').slice(0, 19),
    }));
  if (!items.length) return { added: 0, skipped: 0 };
  const r = await fetch(`${apiUrl}/api/media/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return { added: j.added || 0, skipped: j.skipped || 0 };
}
