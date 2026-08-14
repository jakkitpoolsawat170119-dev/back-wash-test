import { supabase } from './supabase';
import { registerMedia, MEDIA_BUCKET, type MediaItem } from './media';

/** ยัดไฟล์ขึ้น bucket แล้วคืน path + public URL — ไม่ยุ่งกับทะเบียนคลังไฟล์ */
async function putFile(file: File, bucket: string): Promise<{ url: string; path: string } | null> {
  if (!supabase) return null;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) { console.error('Upload error:', error); return null; }
  return { url: supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl, path };
}

/**
 * อัปโหลดไฟล์ขึ้น Supabase Storage แล้วคืน public URL
 * ใช้ร่วมกันระหว่างคู่มือ Line 4 กับ editor บทความ — bucket เดียวกัน
 * คืน null เมื่อยังไม่ได้ตั้งค่า Supabase หรืออัปโหลดไม่สำเร็จ (ผู้เรียกต้องเช็คเอง)
 *
 * ไฟล์ที่ผ่านทางนี้ถูกจดเข้า "คลังไฟล์" ให้เองพร้อมชื่อไฟล์จริง — ชื่อใน storage เป็น
 * ตัวสุ่ม ถ้าไม่จดตอนนี้ก็ไม่มีที่ไหนรู้ว่าไฟล์นี้คืออะไร
 * จดแบบไม่รอผล: จดไม่สำเร็จไม่ควรทำให้คนที่แค่แทรกรูปต้องรอหรือเห็น error
 */
export async function uploadToStorage(file: File, bucket = MEDIA_BUCKET): Promise<string | null> {
  const r = await putFile(file, bucket);
  if (!r) return null;
  if (bucket === MEDIA_BUCKET) {
    void registerMedia({ url: r.url, path: r.path, name: file.name, mime: file.type, size: file.size });
  }
  return r.url;
}

/** อัปโหลดจากหน้าคลังไฟล์ — รอจนจดทะเบียนเสร็จ เพราะต้องเอาแถวที่ได้ไปโชว์ในคลังทันที */
export async function uploadAndRegister(
  file: File,
  meta: { folder?: string; uploadedBy?: string } = {},
): Promise<MediaItem | null> {
  const r = await putFile(file, MEDIA_BUCKET);
  if (!r) return null;
  return registerMedia({
    url: r.url, path: r.path, name: file.name, mime: file.type, size: file.size, ...meta,
  });
}

/** ขนาดไฟล์แบบอ่านง่าย เช่น "1.4 MB" */
export function humanSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
