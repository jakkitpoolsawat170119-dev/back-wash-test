---
name: back-wash-app-expert
description: เชี่ยวชาญแอปบันทึก CIP ส้ม ไลน์ 2 (back-wash-test) ดูแลระบบหน้าเว็บ Vercel หลังบ้าน Render และแจ้งเตือน Line ผ่าน n8n
---

# คู่มือแอปบันทึก CIP - ส้ม ไลน์ 2

ใช้เมื่อผู้ใช้ต้องการความช่วยเหลือเกี่ยวกับโปรเจกต์ **back-wash-test** ไม่ว่าจะเป็นการแก้ไขโค้ด, ตรวจสอบเซิร์ฟเวอร์ หรือปรับแต่งระบบแจ้งเตือน Line

## 🔗 ข้อมูลลิงก์สำคัญ
- **Frontend (หน้าเว็บ):** https://back-wash-test.vercel.app
- **Backend (API/Database):** https://back-wash-test.onrender.com
- **Source Code (GitHub):** https://github.com/jakkitpoolsawat170119-dev/back-wash-test

## 🛠️ โครงสร้างเทคนิคที่ต้องจำ
- **Frontend:** พัฒนาด้วย React (Vite) วางที่ Vercel
- **Backend:** Node.js Express วางที่ Render
- **Database:** SQLite (อยู่ใน Render) *หมายเหตุ: ข้อมูลจะ Reset ทุกครั้งที่ Redeploy*
- **Line Notification:** ส่งผ่าน n8n Webhook โดยใช้โหนด HTTP Request

## ⚠️ วิธีแก้ปัญหาที่พบบ่อย (ที่แก้ไขมาแล้ว)
1. **เวลาไม่ตรง:** ใน `server/index.js` ต้องใช้ `.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' })`
2. **รูปภาพใน Line เปิดไม่ได้:** ต้องส่ง URL เต็มรูปแบบที่มี `https://` (ใช้ `req.get('host')`)
3. **JSON Error ใน n8n:** โครงสร้าง JSON ในโหนด HTTP Request ต้องใช้รูปแบบ String Concatenation (เครื่องหมาย `+`) และใช้ `\n` แทนการขึ้นบรรทัดใหม่

## 🚀 ขั้นตอนการอัปเดตแอป (Deployment)
1. แก้ไขโค้ดในเครื่อง
2. ใช้ **GitHub Desktop** เพื่อ Commit และ Push ขึ้น GitHub
3. **Render** และ **Vercel** จะอัปเดตให้อัตโนมัติ (รอประมาณ 2-3 นาที)
