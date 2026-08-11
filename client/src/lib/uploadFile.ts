import { supabase } from './supabase';

/**
 * อัปโหลดไฟล์ขึ้น Supabase Storage แล้วคืน public URL
 * ใช้ร่วมกันระหว่างคู่มือ Line 4 กับ editor บทความ — bucket เดียวกัน
 * คืน null เมื่อยังไม่ได้ตั้งค่า Supabase หรืออัปโหลดไม่สำเร็จ (ผู้เรียกต้องเช็คเอง)
 */
export async function uploadToStorage(file: File, bucket = 'learning-images'): Promise<string | null> {
  if (!supabase) return null;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) { console.error('Upload error:', error); return null; }
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

/** ขนาดไฟล์แบบอ่านง่าย เช่น "1.4 MB" */
export function humanSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
