/* ─── ตารางกะโรงงาน (ฝั่งเซิร์ฟเวอร์) ─────────────────────────────────────
   🔴 นี่คือ mirror ของ client/src/shiftSchedule.ts ซึ่งเป็น "แหล่งความจริงเดียว"
      แก้ที่ไหนต้องแก้ให้ตรงกันทั้งสองไฟล์เสมอ — ตัวเลขกะถูกฝังอยู่ใน primary key
      ของตาราง am_sheets (work_day + shift + line) ถ้าสองฝั่งเพี้ยนกันจะเกิดใบซ้ำ

   จ–พฤ: เช้า 06-14 · บ่าย 14-22 · ดึก 22-06
   ศ, อา: เช้า 06-18 · ดึก 18-06 (ไม่มีบ่าย)
   เสาร์: หยุด
   "วันทำงาน" = 06:00 → 06:00 วันถัดไป (cutoff เดียวกับ workDayBKK ใน index.js)
   weekday: 0=อา .. 6=ส                                                        */

function shiftsForWeekday(wd) {
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

// วันในสัปดาห์ของ 'YYYY-MM-DD' — ตรึงเที่ยงวันเพื่อไม่ให้ timezone ของเครื่องดันข้ามวัน
const weekdayOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const inShift = (h, s) => (s.start < s.end ? (h >= s.start && h < s.end) : (h >= s.start || h < s.end));

// กะ + วันทำงาน ของเวลาที่ระบุ
function shiftInfo(dateStr, hour) {
  const workDay = hour < 6 ? addDays(dateStr, -1) : dateStr;
  const wd = weekdayOf(workDay);
  const shifts = shiftsForWeekday(wd);
  let shift = null;
  for (const s of shifts) if (inShift(hour, s)) shift = s.key;
  return { workDay, weekday: wd, shift, shifts, holiday: shifts.length === 0 };
}

/* กะที่รับได้ของวันทำงานนั้น
   เสาร์ไม่มีกะปกติ → รับได้เฉพาะ 'OT' (มีคนมาทำล่วงเวลาจริง ต้องบันทึกได้)
   ใช้ตรวจค่าที่ client ส่งมาเสมอ — client เลือก server ตรวจ                     */
const allowedShifts = (workDay) => {
  const list = shiftsForWeekday(weekdayOf(workDay)).map(s => s.key);
  return list.length ? list : ['OT'];
};
const isValidShift = (workDay, shift) => allowedShifts(workDay).includes(String(shift || ''));

module.exports = { shiftsForWeekday, weekdayOf, addDays, shiftInfo, allowedShifts, isValidShift };
