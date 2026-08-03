// Render free tier หลับหลังไม่มีคนใช้ ~15 นาที คำขอแรกหลังหลับต้องรอปลุกเครื่อง
// 50 วินาทีขึ้นไป — นานกว่าที่ fetch ปกติจะยอมรอ ผู้ใช้เลยเห็น "โหลดไม่สำเร็จ"
// ทั้งที่เซิร์ฟเวอร์ไม่ได้พัง แค่กำลังตื่น
//
// wakeFetch ลองใหม่ให้เองเงียบ ๆ และบอกผู้ใช้ว่ากำลังปลุกอยู่ ไม่ใช่ขึ้นว่าพัง
// ใช้แทน fetch ได้ตรง ๆ — signature เหมือนกัน

export type WakeState = 'idle' | 'waking' | 'ok' | 'error';

interface WakeOpts extends RequestInit {
  /** เรียกเมื่อสถานะเปลี่ยน — เอาไปโชว์ "กำลังปลุกเซิร์ฟเวอร์…" ได้ */
  onState?: (s: WakeState) => void;
  /** จำนวนครั้งที่ลองใหม่หลังครั้งแรกพลาด (ค่าเริ่มต้น 2 = ยิงรวม 3 ครั้ง) */
  retries?: number;
  /** timeout ต่อครั้ง (ms) — ครั้งแรกสั้น ครั้งถัดไปยาวขึ้นเพราะกำลังปลุก */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function wakeFetch(url: string, opts: WakeOpts = {}): Promise<Response> {
  const { onState, retries = 2, timeoutMs = 20000, ...init } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // ครั้งแรกรอไม่นาน ถ้าพลาดแปลว่าน่าจะกำลังตื่น ครั้งถัดไปให้เวลาเยอะขึ้น
    const budget = attempt === 0 ? timeoutMs : Math.min(timeoutMs * (attempt + 2), 90000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budget);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      // 5xx = เซิร์ฟเวอร์ตอบแต่พัง — ลองใหม่ช่วยได้ถ้าเป็นช่วงกำลังบูต
      if (res.status >= 500 && attempt < retries) { lastErr = new Error(`HTTP ${res.status}`); onState?.('waking'); await sleep(2000); continue; }
      onState?.('ok');
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { onState?.('waking'); await sleep(2000); continue; }
    }
  }
  onState?.('error');
  throw lastErr instanceof Error ? lastErr : new Error('เชื่อมต่อไม่สำเร็จ');
}

/** ข้อความให้ผู้ใช้อ่าน ตามสถานะที่ wakeFetch รายงานมา */
export const wakeMessage = (s: WakeState): string =>
  s === 'waking' ? '⏳ กำลังปลุกเซิร์ฟเวอร์ (ครั้งแรกของวันอาจใช้เวลาถึง 1 นาที)…'
  : s === 'error' ? '❌ เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ลองกดใหม่อีกครั้ง'
  : '';
