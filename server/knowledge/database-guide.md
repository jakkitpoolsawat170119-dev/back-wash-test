# คู่มือฐานข้อมูล (Database Guide)

## ตารางหลักและความหมาย
- **production_logs** — 1 แถว = 1 batch ที่ผลิตเสร็จ (timestamp, line_name, flavor, batch, operator_name, cip_count, brix, ph) นับยอดผลิตจริง = COUNT(*) ต่อวัน/รส/Line
- **production_plans** — แผนผลิตต่อวัน UNIQUE(plan_date, line_name, flavor), planned_batches = เป้า
- **daily_tasks** — งาน To-do รายวัน source='auto_plan' คืองานที่สร้างจากแผนอัตโนมัติ actual_count sync จาก production_logs
- **cip_line1_sessions / cip_line1_rows** — CIP Line 1: session ละหลายรอบ (row) ข้อมูลรอบเก็บเป็น JSON ในคอลัมน์ data
- **cip_line2_sessions / cip_line2_rows / cip_line2_back** — CIP Line 2 และ Line 3 (แยกด้วยคอลัมน์ line ใน sessions; NULL = Line 2) data ของ row เป็น JSON มี endTime และ backwash
- **cip_batches / cip_step_logs** — CIP ทดลอง (Logbook) ทีละ step
- **handover_notes** — โน้ตส่งเวร kind='out' = ส่งกะ, kind='in' = รับกะ/รายงานบรรจุ, คอลัมน์ data เก็บโครงสร้าง JSON
- **line_state** — สถานะเรียลไทม์ต่อ Line (producing/cip/idle)
- **operators** — ผู้ใช้ + PIN · **page_locks** — กันเปิดหน้าฟอร์มซ้อนกัน
- **routine_state** — เช็กลิสต์งานประจำตามหน้าที่รายคน/วัน · **task_templates** — เทมเพลตงานประจำ
- **report_config / report_once** — ตั้งเวลาส่งรายงานอัตโนมัติ
- **assistant_messages** — ประวัติแชทผู้ช่วย AI ต่อ session · **assistant_actions** — คิวการบันทึกที่รอผู้ใช้กดยืนยัน + audit log

## วิธีนับที่ถูกต้อง
- **ยอดผลิตจริง**: `SELECT COUNT(*) FROM production_logs WHERE substr(timestamp,1,10)='YYYY-MM-DD'` (แยก GROUP BY line_name, flavor ได้)
- **รอบ CIP**: นับ row ใน cip_line1_rows/cip_line2_rows ที่ data JSON มี endTime (รอบที่จบแล้ว) — Line 3 คือ sessions ที่ line='Line 3'
- **รอบ Backwash**: row ของ Line 2/3 ที่ data JSON มี backwash เป็นจริง
- **วันทำงาน**: ใช้หน้าต่าง 06:00 วันนี้ → 06:00 วันถัดไป ไม่ใช่เที่ยงคืน–เที่ยงคืน

## รูปแบบข้อมูล
- วันเวลาเก็บเป็น TEXT รูปแบบ 'YYYY-MM-DDTHH:MM:SS' เขตเวลา Asia/Bangkok
- Batch ตั้งชื่อ A-Z ยกเว้นรส Dilute W-Molass เป็นรอบ No.1–20
- ฐานข้อมูลจริงเป็น Postgres (บน Render ผ่าน DATABASE_URL) / SQLite ตอน dev — เขียน SQL ให้เข้ากันได้ทั้งคู่ (หลีกเลี่ยงฟังก์ชันเฉพาะค่าย ใช้ substr, COALESCE, LIKE ได้)
