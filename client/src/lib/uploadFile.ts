import { supabase } from './supabase';
import { registerMedia, MEDIA_BUCKET, type MediaItem } from './media';

/** ขนาดไฟล์แบบอ่านง่าย เช่น "1.4 MB" */
export function humanSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

export interface UploadOutcome {
  url?: string;
  path?: string;
  /** ข้อความบอกเหตุที่อัปไม่ขึ้น — พร้อมโชว์ให้คนใช้อ่านได้เลย */
  error?: string;
}

/**
 * แปล error ของ Supabase Storage เป็นภาษาที่บอกได้ว่าต้องไปแก้ตรงไหน
 * เดิมกลืนทิ้งแล้วขึ้นข้อความเดาเอา ("ยังไม่ได้ตั้งค่า Supabase หรือไฟล์ใหญ่เกิน")
 * ซึ่งแยกไม่ออกเลยว่า bucket ไม่รับชนิดไฟล์ ไฟล์ใหญ่เกิน หรือไม่มีสิทธิ์เขียน
 */
function explainUploadError(err: unknown, file: File): string {
  const raw = String((err as { message?: string })?.message || err || '').trim();
  const low = raw.toLowerCase();
  const kind = file.type || 'ไม่รู้ชนิด';
  if (low.includes('mime') || low.includes('not supported') || low.includes('invalid_mime'))
    return `ที่เก็บไฟล์ไม่รับชนิด "${kind}" — ต้องไปเปิดชนิดนี้ให้ bucket ${MEDIA_BUCKET} ใน Supabase `
      + `(Storage → bucket → Settings → Allowed MIME types) · ข้อความจริง: ${raw}`;
  if (low.includes('maximum allowed size') || low.includes('too large') || low.includes('entity too large') || low.includes('413'))
    return `ไฟล์ใหญ่เกินที่ที่เก็บยอมรับ (ไฟล์นี้ ${humanSize(file.size)}) — ขยายเพดานได้ที่ Supabase `
      + `(Storage → bucket → Settings → File size limit) · ข้อความจริง: ${raw}`;
  if (low.includes('row-level security') || low.includes('unauthorized') || low.includes('403') || low.includes('permission'))
    return `ไม่มีสิทธิ์เขียนลงที่เก็บไฟล์ — ต้องตั้ง policy ให้ bucket ${MEDIA_BUCKET} · ข้อความจริง: ${raw}`;
  if (low.includes('failed to fetch') || low.includes('network'))
    return `ต่อกับที่เก็บไฟล์ไม่ได้ — เช็คอินเทอร์เน็ต แล้วลองใหม่ · ข้อความจริง: ${raw}`;
  return raw ? `อัปโหลดไม่สำเร็จ — ${raw}` : 'อัปโหลดไม่สำเร็จ ไม่ทราบสาเหตุ';
}

/** ยัดไฟล์ขึ้น bucket แล้วคืน path + public URL — ไม่ยุ่งกับทะเบียนคลังไฟล์ */
async function putFile(file: File, bucket: string): Promise<UploadOutcome> {
  if (!supabase) {
    return { error: 'หน้าเว็บนี้ยังไม่ได้ตั้งค่าที่เก็บไฟล์ (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)' };
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  try {
    // ส่ง contentType ไปด้วย — บางเบราว์เซอร์ให้ file.type ว่างสำหรับไฟล์ที่ลากมาจาก Finder
    // แล้ว Supabase จะเดาเป็น application/octet-stream ซึ่ง bucket ที่จำกัดชนิดจะปฏิเสธ
    const { error } = await supabase.storage.from(bucket)
      .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type || guessMime(ext) });
    if (error) {
      console.error('Upload error:', error);
      return { error: explainUploadError(error, file) };
    }
  } catch (e) {
    console.error('Upload error:', e);
    return { error: explainUploadError(e, file) };
  }
  return { url: supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl, path };
}

/** เดาชนิดไฟล์จากนามสกุล ใช้เฉพาะตอนเบราว์เซอร์ไม่บอกชนิดมา */
function guessMime(ext: string): string {
  const map: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    heic: 'image/heic', mp4: 'video/mp4', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * อัปโหลดพร้อมเหตุผลตอนพลาด — ใช้กับหน้าที่ต้องบอกคนใช้ว่าติดตรงไหน
 * ไฟล์ที่ผ่านทางนี้ถูกจดเข้า "คลังไฟล์" ให้เองพร้อมชื่อไฟล์จริง (ชื่อใน storage เป็นตัวสุ่ม
 * ถ้าไม่จดตอนนี้ก็ไม่มีที่ไหนรู้ว่าไฟล์นี้คืออะไร)
 * จดแบบไม่รอผล: จดไม่สำเร็จไม่ควรทำให้คนที่แค่แทรกรูปต้องรอ
 */
export async function uploadFileDetailed(file: File, bucket = MEDIA_BUCKET): Promise<UploadOutcome> {
  const r = await putFile(file, bucket);
  if (r.url && bucket === MEDIA_BUCKET) {
    void registerMedia({ url: r.url, path: r.path, name: file.name, mime: file.type, size: file.size });
  }
  return r;
}

/**
 * อัปโหลดไฟล์ขึ้น Supabase Storage แล้วคืน public URL
 * ใช้ร่วมกันระหว่างคู่มือ Line 4 กับ editor บทความ — bucket เดียวกัน
 * คืน null เมื่ออัปโหลดไม่สำเร็จ (ผู้เรียกเก่าเช็คแค่ null/ไม่ null)
 */
export async function uploadToStorage(file: File, bucket = MEDIA_BUCKET): Promise<string | null> {
  const r = await uploadFileDetailed(file, bucket);
  return r.url || null;
}

/** อัปโหลดจากหน้าคลังไฟล์ — รอจนจดทะเบียนเสร็จ เพราะต้องเอาแถวที่ได้ไปโชว์ในคลังทันที */
export async function uploadAndRegister(
  file: File,
  meta: { folder?: string; uploadedBy?: string } = {},
): Promise<{ item?: MediaItem; error?: string }> {
  const r = await putFile(file, MEDIA_BUCKET);
  if (!r.url) return { error: r.error };
  const item = await registerMedia({
    url: r.url, path: r.path, name: file.name, mime: file.type, size: file.size, ...meta,
  });
  if (!item) return { error: 'ไฟล์ขึ้นที่เก็บแล้วแต่จดเข้าคลังไม่สำเร็จ — ลองกด "สแกนหาไฟล์เก่า" ดึงเข้าทะเบียน' };
  return { item };
}
