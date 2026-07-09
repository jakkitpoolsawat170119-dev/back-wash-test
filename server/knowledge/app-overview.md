# ภาพรวมแอป (App Overview)

## แอปนี้คืออะไร
แอปบันทึกการผลิตและ CIP ของโรงงานน้ำเชื่อม/น้ำหวาน ประกอบด้วย React client (Vercel) + Express server (Render, back-wash-test.onrender.com) + Telegram แจ้งเตือน + n8n → Google Sheets (สเปรดชีต Log-CIP)
ผู้ใช้หลัก 3 คน: จักรกฤษ พูลสวัสดิ์, พัฒพริศ อ่ำอยู่, อนุวัตร สุวรรณวงค์ — ล็อกอินด้วยชื่อ + PIN
โครงสร้างทีม: จักรกฤษ เป็นหัวหน้าของ ม้ำ, นาย, พลุ๊ก ส่วน พัฒพริศ และ อนุวัตร ยังไม่มีลูกน้อง

## หน้าต่างๆ ในแอป
- **ผลิต (Production Control)** — กด Start/Done บันทึกการผลิตทีละ batch ต่อ Line มีปุ่ม "📋 แผนผลิตวันนี้" สำหรับวางแผน (Line, รสชาติ, จำนวน batch) เห็นแถบผลิตจริง/แผนแบบเรียลไทม์
- **CIP Line 1** — ฟอร์ม CIP สาย Syrup บันทึกเป็นรอบ (row) ต่อ session
- **CIP Line 2 / Line 3** — ฟอร์ม CIP สาย Flavour ใช้ฟอร์มเดียวกัน (ตาราง cip_line2_*) แยกด้วยคอลัมน์ line มี Backwash ในแต่ละรอบได้
- **CIP ทดลอง (Logbook)** — บันทึก batch ทดลองทีละ step (cip_batches + cip_step_logs)
- **Line 4 (Manual)** — หน้าบันทึก Mixing/Pasteurizer + รายงานพนักงานบรรจุ (แปลงถัง %/kg → กล่อง) ส่งรายงานเข้า Telegram
- **To-do** — งานรายวันต่อ Line (สร้างอัตโนมัติจากแผนผลิต) แท็บ: งานวันนี้ / งานประจำ / ไทม์ไลน์ / สรุป&KPI / ส่งรายงาน / 🤖 ผู้ช่วย AI
- **ส่งกะ/รับกะ (Handover)** — ฟอร์มส่งเวรแบบมีโครงสร้าง (รส/batch/CIP ต่อ Line + Lot No.) ระบบ prefill จากข้อมูลจริงของวัน

## การไหลของข้อมูล
- บันทึกผลิต (กด Done) → POST /api/production/log → ตาราง production_logs + แจ้ง Telegram + n8n → Sheet "การผลิต"
- บันทึกแผน → POST /api/production/plan → production_plans + สร้าง To-do อัตโนมัติ + Telegram + n8n → Sheet "แผนผลิต"
- ถามกราฟใน Telegram: พิมพ์ "สรุปผลิต [รส] [วันที่]" → n8n อ่าน 2 ชีต → ตอบกราฟ QuickChart เทียบแผน vs จริง

## Deployment
push ขึ้น branch main → Vercel build client อัตโนมัติ, Render build server อัตโนมัติ ตัวแปรลับ (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, N8N_WEBHOOK_URL, ANTHROPIC_API_KEY, DATABASE_URL) ตั้งบน Render เท่านั้น — แก้โค้ดในเครื่องแล้วยังไม่ push = โปรดักชันยังไม่เปลี่ยน
