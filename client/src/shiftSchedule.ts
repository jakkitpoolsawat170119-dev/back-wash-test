// ─── ตารางกะโรงงาน (แหล่งความจริงเดียว) ───────────────────────────────
// จ–พฤ: เช้า 06-14 · บ่าย 14-22 · ดึก 22-06
// ศ, อา: เช้า 06-18 · ดึก 18-06 (ไม่มีบ่าย)
// เสาร์: หยุด
// "วันทำงาน" = 06:00 → 06:00 วันถัดไป (กะดึกข้ามเที่ยงคืน) — cutoff 06:00 เหมือน production
// weekday: 0=อา .. 6=ส (ตาม Date.getDay)

export type Shift = { key: string; start: number; end: number }; // ชั่วโมง 0-24 (end < start = ข้ามเที่ยงคืน)

export function shiftsForWeekday(wd: number): Shift[] {
  if (wd === 6) return [];                                   // เสาร์หยุด
  if (wd === 5 || wd === 0) return [                         // ศุกร์, อาทิตย์
    { key: 'เช้า', start: 6, end: 18 },
    { key: 'ดึก', start: 18, end: 6 },
  ];
  return [                                                    // จันทร์–พฤหัส
    { key: 'เช้า', start: 6, end: 14 },
    { key: 'บ่าย', start: 14, end: 22 },
    { key: 'ดึก', start: 22, end: 6 },
  ];
}

const dstr = (d: Date) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD (local)
export const weekdayOf = (dateStr: string): number => new Date(`${dateStr}T12:00:00`).getDay();
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00`); d.setDate(d.getDate() + n); return dstr(d);
}

// วันที่ "วันทำงาน" ปัจจุบัน (ก่อน 06:00 = วันก่อนหน้า)
export function currentWorkDay(): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const today = dstr(now);
  return now.getHours() < 6 ? addDays(today, -1) : today;
}

const inShift = (h: number, s: Shift) => (s.start < s.end ? (h >= s.start && h < s.end) : (h >= s.start || h < s.end));

// กะ + วันทำงาน ของ timestamp (ระบุเป็นวันที่ปฏิทิน + ชั่วโมง)
export function shiftInfo(dateStr: string, hour: number) {
  const workDay = hour < 6 ? addDays(dateStr, -1) : dateStr;
  const wd = weekdayOf(workDay);
  const shifts = shiftsForWeekday(wd);
  let shift: string | null = null;
  for (const s of shifts) if (inShift(hour, s)) shift = s.key;
  return { workDay, weekday: wd, shift, shifts, holiday: shifts.length === 0 };
}

// กะที่รับช่วงต่อ (ตามลำดับกะของวันนั้น)
export function nextShiftName(shiftThai: string, dateStr: string): string {
  const key = shiftThai.replace('กะ', '');
  const shifts = shiftsForWeekday(weekdayOf(dateStr));
  if (!shifts.length) return '';
  const idx = shifts.findIndex(s => s.key === key);
  if (idx < 0) return '';
  return 'กะ' + shifts[(idx + 1) % shifts.length].key;
}

// เวลาสิ้นกะของวันนั้น (สำหรับส่งรายงานอัตโนมัติ) เช่น จ-พฤ = 14:00/22:00/06:00
export function shiftEndsForWeekday(wd: number): string[] {
  return shiftsForWeekday(wd).map(s => `${String(s.end).padStart(2, '0')}:00`);
}

export const SHIFT_META: Record<string, { ic: string }> = {
  'เช้า': { ic: '🌅' }, 'บ่าย': { ic: '🌆' }, 'ดึก': { ic: '🌙' },
};
