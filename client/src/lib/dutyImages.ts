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

// ย่อรูปแบบง่าย (ไม่มี auto-tiling) — ขอบยาว ≤1568 → JPEG q0.85 · คืน data URL + base64 สำหรับส่ง
// อยู่ที่นี่เพราะทั้งกระดานงานประจำและกระดานซ่อมบำรุงใช้ตัวเดียวกัน
export type PhotoAttach = { preview: string; data: string; mediaType: string };
export const resizePhoto = (file: File): Promise<PhotoAttach> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const el = new Image();
    el.onload = () => {
      const scale = Math.min(1, 1568 / Math.max(el.width, el.height));
      const w = Math.max(1, Math.round(el.width * scale)), h = Math.max(1, Math.round(el.height * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
      cx.drawImage(el, 0, 0, w, h);
      const dataUrl = cv.toDataURL('image/jpeg', 0.85);
      resolve({ preview: dataUrl, data: dataUrl.split(',')[1] || '', mediaType: 'image/jpeg' });
    };
    el.onerror = reject; el.src = String(reader.result);
  };
  reader.onerror = reject; reader.readAsDataURL(file);
});
