/* ที่อยู่ API ที่เดียวของทั้งแอป
   เดิมบรรทัดนี้ถูก copy-paste ไว้ 20+ ไฟล์ ซึ่งอันตรายตรงที่ค่า default ชี้ prod จริง —
   ลืมตั้ง VITE_API_BASE ตอน dev = ยิงใส่ฐานข้อมูลจริงและเด้งการ์ดเข้ากลุ่มจริง
   ไฟล์อื่นทยอยย้ายมาใช้ตัวนี้ตอนที่แตะมันด้วยเหตุผลอื่นอยู่แล้ว ไม่ต้องไล่แก้รวดเดียว */
export const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
