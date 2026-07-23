import { supabase } from './supabase';

// bucket เก็บรูปงานมอบหมายบน Supabase Storage (ต้องสร้าง bucket นี้แบบ public ใน Supabase)
export const DUTY_BUCKET = 'duty-images';

const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

// แปลง data URL (base64) → Blob เพื่ออัปโหลด
export const dataUrlToBlob = (dataUrl: string): Blob => {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/data:(.*?);/)?.[1] || 'image/jpeg';
  const bin = atob(b64 || '');
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
};

// อัปโหลดรูปขึ้น Supabase Storage → คืน public URL · ถ้าไม่มี Supabase/พลาด → คืน base64 เดิม (fallback)
export const uploadDutyImage = async (dataUrl: string): Promise<string> => {
  if (!supabase || !dataUrl.startsWith('data:')) return dataUrl;
  try {
    const blob = dataUrlToBlob(dataUrl);
    const path = `${todayBKK()}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
    const { error } = await supabase.storage.from(DUTY_BUCKET).upload(path, blob, { cacheControl: '3600', upsert: false, contentType: 'image/jpeg' });
    if (error) { console.error('[duty upload]', error.message); return dataUrl; }
    return supabase.storage.from(DUTY_BUCKET).getPublicUrl(path).data.publicUrl;
  } catch (e) { console.error('[duty upload]', e); return dataUrl; }
};
