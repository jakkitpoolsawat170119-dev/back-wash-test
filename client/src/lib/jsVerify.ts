/* ══════════════ ตรวจโค้ดที่ AI เขียนมา ก่อนใส่ลงบล็อก ══════════════
 *
 * กล่องรันโค้ด (lib/runJs.ts) บอกเราได้อยู่แล้วว่าโค้ดผิดไวยากรณ์หรือพังตอน setup
 * เพราะ sandbox ครอบด้วย async function แล้ว resolve ทันทีที่ setup คืนค่า
 * ที่มันมองไม่เห็นมีสองอย่าง:
 *   1. error ที่โยนอยู่ใน callback ของ requestAnimationFrame (หลัง setup จบไปแล้ว)
 *   2. อาการ "ภาพนิ่งเงียบ ๆ" ของกติกาจับเวลาเฟรมแรก — ไม่มี error สักตัว
 *
 * วิธีจับสองอย่างนี้: **ห่อโค้ดเฉพาะตอนตรวจ** แล้วส่งผลออกทาง console.log ที่มีอยู่แล้ว
 * — ไม่แตะ sandbox ไม่แตะ runJs.ts จึงไม่ลามไปถึงสำเนาใน server/articlePage.js
 *
 * ⚠️ ตัวห่อนี้ห้ามหลุดลงไปอยู่ใน b.html เด็ดขาด ใช้ตอนตรวจอย่างเดียว
 */
import { runJs, type RunLine } from './runJs';

export type VerifyLevel = 'ok' | 'warn' | 'error';

export interface VerifyResult {
  level: VerifyLevel;
  /** ข้อความอธิบายปัญหา — ว่างเมื่อ level = 'ok' */
  reason: string;
  /** ข้อความที่ส่งให้ AI ตอนขอให้ซ่อม (มีเฉพาะ level = 'error') */
  repairHint: string;
  /** ผลลัพธ์ที่โค้ดพิมพ์ออกมา — ตัดบรรทัดของตัวตรวจทิ้งแล้ว */
  lines: RunLine[];
  ms: number;
  /** เก็บกล่องทิ้ง — โหมดวาดภาพกล่องยังอยู่ให้ดูพรีวิว ผู้เรียกต้องเรียกเอง */
  stop: () => void;
}

const เครื่องหมาย = '__ตรวจ__';

/* ── ตัวห่อ ──────────────────────────────────────────────────────────────
 * ชื่อทุกตัวขึ้นต้น __spp กัน const ชนกับโค้ดที่ AI เขียน (sandbox เป็น strict mode
 * ประกาศชื่อซ้ำ = SyntaxError ทั้งไฟล์)
 */
const หัว = `
let __sppFrames = 0, __sppErr = '';
{
  // .bind(window) บังคับ — เรียก rAF ที่หลุดจาก window แล้วจะได้ Illegal invocation
  const __sppRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return __sppRaf(function (ts) {
      __sppFrames++;
      try { cb(ts); } catch (e) { if (!__sppErr) __sppErr = String((e && e.message) || e); }
    });
  };
}
`;

const ท้าย = `
function __sppSnap() {
  const c = document.querySelector('canvas');
  if (!c || !c.width || !c.height) return null;
  // canvas ล็อกชนิด context ตั้งแต่เรียก getContext ครั้งแรกตาม spec — เรียกผิดชนิดแล้วคืน
  // null เฉย ๆ ไม่มีผลข้างเคียง จึงไล่ลองได้ปลอดภัย: 2d ก่อน แล้วค่อย webgl2/webgl
  let d, ชนิด = null;
  try {
    const ctx2d = c.getContext('2d');
    if (ctx2d) { d = ctx2d.getImageData(0, 0, c.width, c.height).data; ชนิด = '2d'; }
  } catch (e) { /* ลอง webgl ต่อ */ }
  if (!d) {
    try {
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) {
        const buf = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        d = buf; ชนิด = 'webgl';
      }
    } catch (e) { return null; }
  }
  if (!d) return null;
  // สุ่มพิกเซลเป็นตาราง 24x14 พอให้รู้ว่า "มีอะไรวาด" กับ "ภาพขยับไหม"
  // (WebGL อ่านจากมุมล่างซ้าย 2D อ่านจากมุมบนซ้าย — สลับแนวตั้งกันแต่ไม่กระทบผล เพราะแค่
  // เทียบสองภาพจาก context เดียวกันว่าขยับไหม ไม่ได้สนใจตำแหน่งจริงของพิกเซล)
  let ลาย = 0, ทึบ = 0;
  for (let iy = 0; iy < 14; iy++) {
    for (let ix = 0; ix < 24; ix++) {
      const x = Math.floor((ix + 0.5) / 24 * c.width);
      const y = Math.floor((iy + 0.5) / 14 * c.height);
      const p = (y * c.width + x) * 4;
      const r = d[p], gg = d[p + 1], b = d[p + 2], a = d[p + 3];
      if (a > 8) ทึบ++;
      ลาย = (ลาย * 31 + r * 3 + gg * 5 + b * 7 + a * 11) % 2147483647;
    }
  }
  return { ว่าง: ทึบ === 0, ลาย: ลาย, ชนิด: ชนิด };
}
await new Promise(function (r) { setTimeout(r, 300); });
const __sppA = __sppSnap();
await new Promise(function (r) { setTimeout(r, 600); });
const __sppB = __sppSnap();
console.log(${JSON.stringify(เครื่องหมาย)} + JSON.stringify({
  เฟรม: __sppFrames,
  ผิด: __sppErr,
  มีจอ: !!__sppB,
  ชนิด: __sppB ? __sppB.ชนิด : null,
  ว่าง: !!(__sppB && __sppB.ว่าง),
  นิ่ง: !!(__sppA && __sppB && __sppA.ลาย === __sppB.ลาย),
}));
`;

interface ผลตรวจดิบ {
  เฟรม: number;
  ผิด: string;
  มีจอ: boolean;
  ชนิด: '2d' | 'webgl' | null;
  ว่าง: boolean;
  นิ่ง: boolean;
}

/**
 * รันโค้ดหนึ่งรอบแล้วบอกว่าใช้ได้ไหม
 *
 * โหมดวาดภาพ **ต้องส่ง mount ที่มองเห็นอยู่บนจอจริง** — กล่องที่อยู่นอกจอจะโดน
 * เบราว์เซอร์หรี่ requestAnimationFrame ทิ้ง แล้วเราจะนับได้ 0 เฟรมทั้งที่โค้ดไม่ผิด
 * (และ mount: null ทำให้ canvas กว้าง 0 → getImageData พัง)
 */
export async function verifyJs(
  code: string,
  opts: { draw: boolean; mount?: HTMLElement | null },
): Promise<VerifyResult> {
  const { draw, mount = null } = opts;

  // โหมดคำนวณไม่ต้องห่อ — รันตรง ๆ แล้วดู error กับผลลัพธ์พอ
  if (!draw) {
    const r = await runJs(code, { timeoutMs: 4000 });
    if (r.error) {
      return {
        level: 'error', reason: r.error, repairHint: 'รันแล้วขึ้น error: ' + r.error,
        lines: r.lines, ms: r.ms, stop: r.stop,
      };
    }
    if (!r.lines.length) {
      return {
        level: 'warn', reason: 'โค้ดรันผ่านแต่ไม่มีผลลัพธ์ — ไม่ได้เรียก console.log() และไม่ได้ return ค่า',
        repairHint: '', lines: r.lines, ms: r.ms, stop: r.stop,
      };
    }
    return { level: 'ok', reason: '', repairHint: '', lines: r.lines, ms: r.ms, stop: r.stop };
  }

  // ⚠️ 4000 ไม่ใช่ 3000 — ตัวตรวจกินเวลาไปแล้วเกือบ 1 วินาที (300 + 600)
  //    ปล่อยเป็นค่า default ของ runJs เมื่อไหร่ จะได้ "รันเกิน 3 วินาที" ทุกครั้ง
  const r = await runJs(หัว + '\n' + code + '\n' + ท้าย, { timeoutMs: 4000, mount });

  const บรรทัดตรวจ = r.lines.find(l => l.v.startsWith(เครื่องหมาย));
  const lines = r.lines.filter(l => l !== บรรทัดตรวจ);
  const ฐาน = { lines, ms: r.ms, stop: r.stop };

  if (r.error) {
    return { level: 'error', reason: r.error, repairHint: 'รันแล้วขึ้น error: ' + r.error, ...ฐาน };
  }

  let p: ผลตรวจดิบ | null = null;
  if (บรรทัดตรวจ) {
    try { p = JSON.parse(บรรทัดตรวจ.v.slice(เครื่องหมาย.length)); } catch { p = null; }
  }
  // โค้ด return ออกไปก่อนถึงตัวตรวจ (เช่นเขียนแบบโหมดคำนวณมา) — ตรวจต่อไม่ได้ แต่ก็ไม่ได้แปลว่าพัง
  if (!p) {
    return { level: 'warn', reason: 'ตรวจอัตโนมัติไม่ได้ — ลองกดดูในกล่องพรีวิวเอง', repairHint: '', ...ฐาน };
  }

  if (p.ผิด) {
    return {
      level: 'error', reason: 'error ระหว่างวาดภาพ: ' + p.ผิด,
      repairHint: 'โค้ดรัน setup ผ่าน แต่โยน error ทุกเฟรมในลูปวาดภาพ: ' + p.ผิด, ...ฐาน,
    };
  }
  if (!p.เฟรม) {
    return {
      level: 'error', reason: 'ไม่มีการวาดเลย — ไม่ได้เรียก requestAnimationFrame',
      repairHint: 'โค้ดไม่เคยเรียก requestAnimationFrame เลย ภาพจึงไม่ขยับ', ...ฐาน,
    };
  }
  if (!p.มีจอ) {
    return {
      level: 'error', reason: 'ไม่พบ canvas ที่วาดด้วย 2D หรือ WebGL ในกล่อง',
      repairHint: 'โค้ดไม่ได้สร้าง canvas แล้ว appendChild เข้า document.body '
        + '(หรือสร้าง context ไม่สำเร็จ — เช็ก getContext ว่าคืนค่าไม่ null)', ...ฐาน,
    };
  }
  // ว่าง/นิ่ง เป็นการ "เดา" ไม่ใช่การพิสูจน์ — มี false positive จริง (ภาพที่ตั้งใจนิ่ง, ภาพค่อย ๆ จาง)
  // ซ่อมอัตโนมัติจากการเดา = เอาภาพที่ใช้ได้อยู่แล้วไปเขียนใหม่ทิ้ง → เตือนแล้วให้คนตัดสินเอง
  if (p.ว่าง) {
    return { level: 'warn', reason: 'รันได้แต่ยังไม่เห็นอะไรบนจอเลย — ลองดูในกล่องพรีวิวก่อน', repairHint: '', ...ฐาน };
  }
  if (p.นิ่ง) {
    return {
      level: 'warn',
      reason: 'ภาพไม่ขยับเลยใน 1 วินาที — อาจเป็นกับดักจับเวลาเฟรมแรก ลองดูในกล่องพรีวิว',
      repairHint: '', ...ฐาน,
    };
  }
  return { level: 'ok', reason: '', repairHint: '', ...ฐาน };
}
