/* ══════════════ ชุดตัวอย่างภาพเคลื่อนไหวสำเร็จรูป ══════════════
 * โค้ดพวกนี้ถูกโยนเข้าบล็อก "โค้ดที่รันได้" โหมดวาดภาพ แล้วรันในกล่องแยก
 * (ดู lib/runJs.ts — แตะหน้าเว็บไม่ได้ ต่อเน็ตไม่ได้)
 *
 * กติกาเวลาเขียนตัวอย่างใหม่
 * - ห้ามใช้ template literal (backtick) กับ ${} ในโค้ดตัวอย่าง เพราะตัวไฟล์นี้ใช้ backtick ครอบอยู่
 * - จับเวลาจาก "เฟรมแรกที่วาดจริง" เสมอ อย่าใช้ performance.now() ตอนเริ่ม
 *   เวลาของเฟรมแรกย้อนหลังกว่ากันได้ แล้วค่าติดลบจะทำให้ index หลุดจนลูปตายเงียบ ๆ
 * - วาดจากค่า innerWidth/innerHeight เสมอ กล่องถูกย่อ-ขยายตามจอคนอ่าน
 */

export interface AnimTemplate {
  id: string;
  ic: string;
  ชื่อ: string;
  คำอธิบาย: string;
  code: string;
}

export const ANIM_TEMPLATES: AnimTemplate[] = [
  {
    id: 'flow',
    ic: '🍯',
    ชื่อ: 'กระบวนการผลิตน้ำเชื่อมแต่งกลิ่น',
    คำอธิบาย: 'ผังขั้นตอน 6 ขั้น ไล่ไฟทีละขั้น มีของเหลววิ่งตามท่อ',
    code: `// ── ตัวอย่างภาพเคลื่อนไหว: กระบวนการผลิตน้ำเชื่อมแต่งกลิ่น ──
const ขั้นตอน = [
  { ชื่อ: 'น้ำ RO',       ย่อ: 'RO',   สี: '#4aa3df' },
  { ชื่อ: 'ละลายน้ำตาล',  ย่อ: '80°C', สี: '#e0a021' },
  { ชื่อ: 'กรอง',         ย่อ: 'FIL',  สี: '#8fd3a0' },
  { ชื่อ: 'เติมกลิ่น',    ย่อ: 'FLV',  สี: '#c86bd8' },
  { ชื่อ: 'พักเย็น',      ย่อ: '25°C', สี: '#5ec8c8' },
  { ชื่อ: 'บรรจุ',        ย่อ: 'PACK', สี: '#ff8c3c' },
];
const วินาทีต่อขั้น = 2;

const จอ = document.createElement('canvas');
document.body.appendChild(จอ);
const g = จอ.getContext('2d');
let W, H;

function ปรับขนาด() {
  const dpr = window.devicePixelRatio || 1;
  W = innerWidth; H = innerHeight;
  จอ.width = W * dpr; จอ.height = H * dpr;
  จอ.style.width = W + 'px'; จอ.style.height = H + 'px';
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
ปรับขนาด();
addEventListener('resize', ปรับขนาด);

function กล่องมน(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// จับเวลาจากเฟรมแรกที่วาดจริง ไม่ใช่ performance.now() ตอนเริ่ม
// (เวลาของเฟรมแรกอาจย้อนหลังกว่าตอนเริ่มเล็กน้อย ทำให้เวลาติดลบแล้วคำนวณขั้นตอนเพี้ยน)
let เริ่ม = null;

function วาด(now) {
  if (เริ่ม === null) เริ่ม = now;
  const t = Math.max(0, (now - เริ่ม) / 1000);
  const ตำแหน่ง = (t % (ขั้นตอน.length * วินาทีต่อขั้น)) / วินาทีต่อขั้น;
  const ที่ทำอยู่ = Math.floor(ตำแหน่ง);
  const เศษ = ตำแหน่ง - ที่ทำอยู่;

  g.clearRect(0, 0, W, H);

  const ขอบ = 14;
  const ช่อง = 12;
  const กว้าง = (W - ขอบ * 2 - ช่อง * (ขั้นตอน.length - 1)) / ขั้นตอน.length;
  const สูง = Math.min(74, H * 0.3);
  const บน = H * 0.34;

  g.font = '600 13px system-ui, sans-serif';
  g.fillStyle = '#e8ddd2';
  g.textAlign = 'left';
  g.fillText('กระบวนการผลิตน้ำเชื่อมแต่งกลิ่น', ขอบ, 26);

  for (let i = 0; i < ขั้นตอน.length; i++) {
    const s = ขั้นตอน[i];
    const x = ขอบ + i * (กว้าง + ช่อง);
    const ทำอยู่ = i === ที่ทำอยู่;
    const เต้น = ทำอยู่ ? Math.sin(t * 6) * 1.5 : 0;

    // ท่อเชื่อมไปกล่องถัดไป + หยดของเหลวที่วิ่งอยู่
    if (i < ขั้นตอน.length - 1) {
      const x1 = x + กว้าง, x2 = x1 + ช่อง, กลาง = บน + สูง / 2;
      g.strokeStyle = 'rgba(232,221,210,.25)';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(x1, กลาง); g.lineTo(x2, กลาง); g.stroke();
      if (i === ที่ทำอยู่) {
        g.fillStyle = s.สี;
        g.beginPath(); g.arc(x1 + ช่อง * เศษ, กลาง, 3.2, 0, Math.PI * 2); g.fill();
      }
    }

    if (ทำอยู่) {
      g.shadowColor = s.สี;
      g.shadowBlur = 18;
    }
    กล่องมน(x, บน - เต้น, กว้าง, สูง + เต้น * 2, 12);
    g.fillStyle = ทำอยู่ ? s.สี : 'rgba(232,221,210,.10)';
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = ทำอยู่ ? 0 : 1;
    g.strokeStyle = 'rgba(232,221,210,.22)';
    if (!ทำอยู่) g.stroke();

    // ระดับของเหลวในกล่องที่กำลังทำ
    if (ทำอยู่) {
      g.save();
      กล่องมน(x, บน, กว้าง, สูง, 12);
      g.clip();
      g.fillStyle = 'rgba(27,20,16,.30)';
      g.fillRect(x, บน, กว้าง, สูง * (1 - เศษ));
      g.restore();
    }

    g.textAlign = 'center';
    g.fillStyle = ทำอยู่ ? '#1b1410' : '#e8ddd2';
    g.font = '700 12px system-ui, sans-serif';
    g.fillText(s.ย่อ, x + กว้าง / 2, บน + สูง / 2 + 4);

    g.fillStyle = ทำอยู่ ? s.สี : 'rgba(232,221,210,.55)';
    g.font = (ทำอยู่ ? '700 ' : '400 ') + '11px system-ui, sans-serif';
    g.fillText(s.ชื่อ, x + กว้าง / 2, บน + สูง + 18);
  }

  // แถบความคืบหน้าของรอบ + ป้ายบอกว่าอยู่ขั้นไหน
  const ล่าง = H - 26;
  g.fillStyle = 'rgba(232,221,210,.14)';
  g.fillRect(ขอบ, ล่าง, W - ขอบ * 2, 5);
  g.fillStyle = ขั้นตอน[ที่ทำอยู่].สี;
  g.fillRect(ขอบ, ล่าง, (W - ขอบ * 2) * (ตำแหน่ง / ขั้นตอน.length), 5);
  g.textAlign = 'left';
  g.fillStyle = '#9c8f83';
  g.font = '400 11px system-ui, sans-serif';
  g.fillText('กำลังทำ: ' + ขั้นตอน[ที่ทำอยู่].ชื่อ + '  ·  ขั้นที่ ' + (ที่ทำอยู่ + 1) + '/' + ขั้นตอน.length, ขอบ, ล่าง - 8);

  requestAnimationFrame(วาด);
}
requestAnimationFrame(วาด);`,
  },
  {
    id: 'cip',
    ic: '🧼',
    ชื่อ: 'CIP timeline',
    คำอธิบาย: 'แถบเวลาแต่ละขั้นพร้อมอุณหภูมิ + เส้นเวลาปัจจุบันเดินจริง',
    code: `// ── CIP timeline: แถบเวลาแต่ละขั้น + นาฬิกานับเดินหน้า ──
const ขั้นตอน = [
  { ชื่อ: 'Pre-rinse',   นาที: 5,  อุณหภูมิ: 25, สี: '#4aa3df' },
  { ชื่อ: 'Caustic 2%',  นาที: 20, อุณหภูมิ: 80, สี: '#e0a021' },
  { ชื่อ: 'Inter-rinse', นาที: 5,  อุณหภูมิ: 25, สี: '#5ec8c8' },
  { ชื่อ: 'Acid 1%',     นาที: 10, อุณหภูมิ: 65, สี: '#c86bd8' },
  { ชื่อ: 'Final rinse', นาที: 5,  อุณหภูมิ: 25, สี: '#8fd3a0' },
];
const เร่งเวลา = 60;   // 1 วินาทีจริง = 60 วินาทีในกระบวนการ

const จอ = document.createElement('canvas');
document.body.appendChild(จอ);
const g = จอ.getContext('2d');
let W, H;
function ปรับขนาด() {
  const dpr = window.devicePixelRatio || 1;
  W = innerWidth; H = innerHeight;
  จอ.width = W * dpr; จอ.height = H * dpr;
  จอ.style.width = W + 'px'; จอ.style.height = H + 'px';
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
ปรับขนาด();
addEventListener('resize', ปรับขนาด);

const นาทีรวม = ขั้นตอน.reduce((s, x) => s + x.นาที, 0);
let เริ่ม = null;

function เวลาอ่านง่าย(นาที) {
  const m = Math.floor(นาที);
  const s = Math.floor((นาที - m) * 60);
  return m + ':' + String(s).padStart(2, '0');
}

function วาด(now) {
  if (เริ่ม === null) เริ่ม = now;
  const วินาที = Math.max(0, (now - เริ่ม) / 1000);
  const นาทีที่เดิน = (วินาที * เร่งเวลา / 60) % นาทีรวม;

  g.clearRect(0, 0, W, H);
  const ขอบ = 16;
  const แถบซ้าย = Math.min(120, W * 0.3);
  const กว้างแถบ = W - ขอบ * 2 - แถบซ้าย;
  const สูงแถว = Math.min(30, (H - 76) / ขั้นตอน.length);
  const บนสุด = 52;

  g.textAlign = 'left';
  g.fillStyle = '#e8ddd2';
  g.font = '600 13px system-ui, sans-serif';
  g.fillText('CIP timeline — รวม ' + นาทีรวม + ' นาที', ขอบ, 24);

  let สะสม = 0;
  let ขั้นปัจจุบัน = ขั้นตอน[0];
  for (let i = 0; i < ขั้นตอน.length; i++) {
    const s = ขั้นตอน[i];
    const y = บนสุด + i * สูงแถว;
    const x = ขอบ + แถบซ้าย;
    const w = กว้างแถบ * (s.นาที / นาทีรวม);
    const xเริ่ม = x + กว้างแถบ * (สะสม / นาทีรวม);
    const เดินอยู่ = นาทีที่เดิน >= สะสม && นาทีที่เดิน < สะสม + s.นาที;
    if (เดินอยู่) ขั้นปัจจุบัน = s;

    g.textAlign = 'right';
    g.fillStyle = เดินอยู่ ? s.สี : 'rgba(232,221,210,.6)';
    g.font = (เดินอยู่ ? '700 ' : '400 ') + '11.5px system-ui, sans-serif';
    g.fillText(s.ชื่อ, ขอบ + แถบซ้าย - 10, y + สูงแถว / 2 + 4);

    g.fillStyle = 'rgba(232,221,210,.12)';
    g.fillRect(xเริ่ม, y + 4, w - 2, สูงแถว - 10);
    const เต็ม = Math.min(1, Math.max(0, (นาทีที่เดิน - สะสม) / s.นาที));
    g.fillStyle = s.สี;
    g.globalAlpha = เดินอยู่ ? 1 : 0.55;
    g.fillRect(xเริ่ม, y + 4, (w - 2) * เต็ม, สูงแถว - 10);
    g.globalAlpha = 1;

    // ใส่ป้ายอุณหภูมิเฉพาะตอนแถบกว้างพอ ไม่งั้นตัวหนังสือล้นออกนอกแถบ
    if (เต็ม > 0.25 && w > 46) {
      g.textAlign = 'left';
      g.fillStyle = '#1b1410';
      g.font = '700 10.5px system-ui, sans-serif';
      g.fillText(s.อุณหภูมิ + '°C', xเริ่ม + 6, y + สูงแถว / 2 + 4);
    }
    สะสม += s.นาที;
  }

  // เส้นเวลาปัจจุบัน
  const xเส้น = ขอบ + แถบซ้าย + กว้างแถบ * (นาทีที่เดิน / นาทีรวม);
  g.strokeStyle = '#fff';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(xเส้น, บนสุด);
  g.lineTo(xเส้น, บนสุด + ขั้นตอน.length * สูงแถว);
  g.stroke();

  g.textAlign = 'left';
  g.fillStyle = ขั้นปัจจุบัน.สี;
  g.font = '700 12px system-ui, sans-serif';
  g.fillText(เวลาอ่านง่าย(นาทีที่เดิน) + ' / ' + นาทีรวม + ':00  ·  ' + ขั้นปัจจุบัน.ชื่อ, ขอบ, H - 14);

  requestAnimationFrame(วาด);
}
requestAnimationFrame(วาด);`,
  },
  {
    id: 'tank',
    ic: '🛢',
    ชื่อ: 'ถังผสม + ปั๊ม',
    คำอธิบาย: 'ระดับของเหลวขึ้น-ลง ใบกวนหมุน ท่อเข้า-ออกสลับกันทำงาน',
    code: `// ── ถังผสม + ปั๊ม: ระดับของเหลว ใบพัดหมุน วาล์วเปิด-ปิด ──
const รอบถัง = 14;      // วินาทีต่อรอบ (เติม → กวน → จ่ายออก)
const ชื่อถัง = 'ถังผสมน้ำเชื่อม T-101';

const จอ = document.createElement('canvas');
document.body.appendChild(จอ);
const g = จอ.getContext('2d');
let W, H;
function ปรับขนาด() {
  const dpr = window.devicePixelRatio || 1;
  W = innerWidth; H = innerHeight;
  จอ.width = W * dpr; จอ.height = H * dpr;
  จอ.style.width = W + 'px'; จอ.style.height = H + 'px';
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
ปรับขนาด();
addEventListener('resize', ปรับขนาด);

let เริ่ม = null;

function วาดปั๊ม(x, y, r, มุม, ทำงาน) {
  g.save();
  g.translate(x, y);
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fillStyle = ทำงาน ? '#e0a021' : 'rgba(232,221,210,.15)';
  g.fill();
  g.rotate(มุม);
  g.strokeStyle = ทำงาน ? '#1b1410' : 'rgba(232,221,210,.4)';
  g.lineWidth = 2.5;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -r * 0.72);
    g.stroke();
    g.rotate((Math.PI * 2) / 3);
  }
  g.restore();
}

function วาด(now) {
  if (เริ่ม === null) เริ่ม = now;
  const t = Math.max(0, (now - เริ่ม) / 1000);
  const เฟส = (t % รอบถัง) / รอบถัง;          // 0..1
  const เติม = เฟส < 0.35;
  const กวน = เฟส >= 0.35 && เฟส < 0.7;
  const จ่าย = เฟส >= 0.7;
  const ระดับ = เติม ? เฟส / 0.35 : จ่าย ? 1 - (เฟส - 0.7) / 0.3 : 1;

  g.clearRect(0, 0, W, H);
  g.textAlign = 'left';
  g.fillStyle = '#e8ddd2';
  g.font = '600 13px system-ui, sans-serif';
  g.fillText(ชื่อถัง, 16, 24);

  const กลางX = W / 2;
  const ถังW = Math.min(150, W * 0.34);
  const ถังH = Math.min(150, H - 110);
  const ถังX = กลางX - ถังW / 2;
  const ถังY = 46;

  // ท่อเข้า (ซ้าย) + ท่อออก (ขวา)
  g.lineWidth = 6;
  g.strokeStyle = เติม ? '#4aa3df' : 'rgba(232,221,210,.18)';
  g.beginPath(); g.moveTo(24, ถังY + 18); g.lineTo(ถังX, ถังY + 18); g.stroke();
  g.strokeStyle = จ่าย ? '#ff8c3c' : 'rgba(232,221,210,.18)';
  g.beginPath(); g.moveTo(ถังX + ถังW, ถังY + ถังH - 14); g.lineTo(W - 24, ถังY + ถังH - 14); g.stroke();

  // หยดของเหลววิ่งในท่อที่กำลังทำงาน
  const หยด = (t * 90) % 60;
  if (เติม) {
    g.fillStyle = '#4aa3df';
    for (let i = -1; i < 4; i++) {
      const x = 24 + ((หยด + i * 30) % (ถังX - 24));
      g.beginPath(); g.arc(x, ถังY + 18, 3, 0, Math.PI * 2); g.fill();
    }
  }
  if (จ่าย) {
    g.fillStyle = '#ff8c3c';
    for (let i = -1; i < 4; i++) {
      const x = ถังX + ถังW + ((หยด + i * 30) % (W - 24 - ถังX - ถังW));
      g.beginPath(); g.arc(x, ถังY + ถังH - 14, 3, 0, Math.PI * 2); g.fill();
    }
  }

  // ตัวถัง + ของเหลวข้างใน
  g.save();
  g.beginPath();
  g.roundRect ? g.roundRect(ถังX, ถังY, ถังW, ถังH, 14) : g.rect(ถังX, ถังY, ถังW, ถังH);
  g.clip();
  const สูงน้ำ = ถังH * ระดับ;
  const คลื่น = Math.sin(t * 3) * 3;
  g.fillStyle = 'rgba(224,160,33,.85)';
  g.beginPath();
  g.moveTo(ถังX, ถังY + ถังH - สูงน้ำ + คลื่น);
  g.quadraticCurveTo(ถังX + ถังW / 2, ถังY + ถังH - สูงน้ำ - คลื่น * 2, ถังX + ถังW, ถังY + ถังH - สูงน้ำ + คลื่น);
  g.lineTo(ถังX + ถังW, ถังY + ถังH);
  g.lineTo(ถังX, ถังY + ถังH);
  g.closePath();
  g.fill();
  g.restore();

  g.lineWidth = 2;
  g.strokeStyle = 'rgba(232,221,210,.5)';
  g.beginPath();
  g.roundRect ? g.roundRect(ถังX, ถังY, ถังW, ถังH, 14) : g.rect(ถังX, ถังY, ถังW, ถังH);
  g.stroke();

  // ใบกวนกลางถัง — รองด้วยวงมืดก่อน ไม่งั้นจมหายไปในสีของเหลว
  const รัศมีใบ = Math.min(22, ถังW * 0.18);
  g.fillStyle = 'rgba(27,20,16,.45)';
  g.beginPath(); g.arc(กลางX, ถังY + ถังH * 0.55, รัศมีใบ + 5, 0, Math.PI * 2); g.fill();
  วาดปั๊ม(กลางX, ถังY + ถังH * 0.55, รัศมีใบ, กวน ? t * 7 : t * 0.6, กวน);

  // ป้ายบอกสถานะ
  g.textAlign = 'center';
  g.fillStyle = '#e8ddd2';
  g.font = '700 12px system-ui, sans-serif';
  g.fillText(Math.round(ระดับ * 100) + '%', กลางX, ถังY + ถังH + 20);
  const สถานะ = เติม ? 'กำลังเติมวัตถุดิบ' : กวน ? 'กำลังกวนผสม' : 'กำลังจ่ายออกไปบรรจุ';
  const สีสถานะ = เติม ? '#4aa3df' : กวน ? '#e0a021' : '#ff8c3c';
  g.fillStyle = สีสถานะ;
  g.font = '700 12.5px system-ui, sans-serif';
  g.fillText(สถานะ, กลางX, H - 14);

  requestAnimationFrame(วาด);
}
requestAnimationFrame(วาด);`,
  },
  {
    id: 'chart',
    ic: '📈',
    ชื่อ: 'กราฟค่าเดินสด',
    คำอธิบาย: 'เส้นค่าวิ่งพร้อมช่วงปกติ เตือนสีแดงเมื่อหลุดช่วง',
    code: `// ── กราฟเดินสด: เส้นวิ่งพร้อมตัวเลขล่าสุด (จำลองค่าจากหน้างาน) ──
const ชื่อค่า = 'อุณหภูมิขาจ่าย CIP';
const หน่วย = '°C';
const ค่าตั้ง = 80;      // เส้นเป้าหมาย
const ช่วงบน = 84, ช่วงล่าง = 76;
const จำนวนจุด = 90;

const จอ = document.createElement('canvas');
document.body.appendChild(จอ);
const g = จอ.getContext('2d');
let W, H;
function ปรับขนาด() {
  const dpr = window.devicePixelRatio || 1;
  W = innerWidth; H = innerHeight;
  จอ.width = W * dpr; จอ.height = H * dpr;
  จอ.style.width = W + 'px'; จอ.style.height = H + 'px';
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
ปรับขนาด();
addEventListener('resize', ปรับขนาด);

const จุด = [];
const ทุกกี่วินาที = 0.12;   // เก็บค่าเป็นจังหวะ ไม่ใช่ทุกเฟรม
let เริ่ม = null;
let เก็บล่าสุด = -1;

function วาด(now) {
  if (เริ่ม === null) เริ่ม = now;
  const t = Math.max(0, (now - เริ่ม) / 1000);

  // ค่าใหม่: แกว่งรอบค่าตั้ง + สั่นเล็กน้อย
  const ค่า = ค่าตั้ง + Math.sin(t * 0.7) * 2.6 + Math.sin(t * 4.1) * 0.6;
  // เก็บทุกเฟรมจะได้ประวัติแค่ 1-2 วินาที เส้นเลยดูแบนจนไม่เห็นการแกว่ง
  if (t - เก็บล่าสุด >= ทุกกี่วินาที) {
    เก็บล่าสุด = t;
    จุด.push(ค่า);
    if (จุด.length > จำนวนจุด) จุด.shift();
  }

  g.clearRect(0, 0, W, H);
  const ขอบซ้าย = 40, ขอบขวา = 14, ขอบบน = 40, ขอบล่าง = 26;
  const กว้าง = W - ขอบซ้าย - ขอบขวา;
  const สูง = H - ขอบบน - ขอบล่าง;
  const ต่ำสุด = ช่วงล่าง - 3, สูงสุด = ช่วงบน + 3;
  const yของ = (v) => ขอบบน + สูง * (1 - (v - ต่ำสุด) / (สูงสุด - ต่ำสุด));

  g.textAlign = 'left';
  g.fillStyle = '#e8ddd2';
  g.font = '600 13px system-ui, sans-serif';
  g.fillText(ชื่อค่า, ขอบซ้าย, 22);

  // แถบช่วงปกติ
  g.fillStyle = 'rgba(143,211,160,.13)';
  g.fillRect(ขอบซ้าย, yของ(ช่วงบน), กว้าง, yของ(ช่วงล่าง) - yของ(ช่วงบน));

  // เส้นแกน + ตัวเลขกำกับ
  g.strokeStyle = 'rgba(232,221,210,.18)';
  g.lineWidth = 1;
  g.font = '400 10px system-ui, sans-serif';
  g.fillStyle = 'rgba(232,221,210,.55)';
  g.textAlign = 'right';
  [ช่วงล่าง, ค่าตั้ง, ช่วงบน].forEach(v => {
    const y = yของ(v);
    g.beginPath(); g.moveTo(ขอบซ้าย, y); g.lineTo(W - ขอบขวา, y); g.stroke();
    g.fillText(v + '', ขอบซ้าย - 6, y + 3);
  });

  // เส้นกราฟ
  if (จุด.length > 1) {
    g.beginPath();
    จุด.forEach((v, i) => {
      const x = ขอบซ้าย + กว้าง * (i / (จำนวนจุด - 1));
      const y = yของ(v);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    });
    g.strokeStyle = '#5ec8c8';
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.stroke();

    // จุดหัวเส้น + ค่าล่าสุด
    const xท้าย = ขอบซ้าย + กว้าง * ((จุด.length - 1) / (จำนวนจุด - 1));
    const yท้าย = yของ(จุด[จุด.length - 1]);
    const นอกช่วง = ค่า > ช่วงบน || ค่า < ช่วงล่าง;
    g.fillStyle = นอกช่วง ? '#ff9b8a' : '#5ec8c8';
    g.beginPath(); g.arc(xท้าย, yท้าย, 4, 0, Math.PI * 2); g.fill();

    g.textAlign = 'right';
    g.font = '700 20px system-ui, sans-serif';
    g.fillText(ค่า.toFixed(1) + หน่วย, W - ขอบขวา, 26);
    g.font = '400 11px system-ui, sans-serif';
    g.fillStyle = นอกช่วง ? '#ff9b8a' : 'rgba(232,221,210,.6)';
    g.textAlign = 'left';
    g.fillText(นอกช่วง ? 'หลุดช่วงปกติ' : 'อยู่ในช่วงปกติ ' + ช่วงล่าง + '-' + ช่วงบน + หน่วย, ขอบซ้าย, H - 8);
  }

  requestAnimationFrame(วาด);
}
requestAnimationFrame(วาด);`,
  },
];

/** ตัวตั้งต้นตอนแทรกบล็อกโหมดวาดภาพ */
export const DEFAULT_ANIM = ANIM_TEMPLATES[0].code;
