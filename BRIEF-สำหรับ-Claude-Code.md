# บรีฟงานต่อ — ระบบแผนผลิต + Telegram ถามข้อมูลเป็นกราฟ

วาง prompt นี้ให้ Claude Code เป็นจุดเริ่ม แล้วสั่งงานต่อทีละข้อได้เลย

---

## บริบทโปรเจกต์
แอปบันทึกการผลิต/CIP โรงงานน้ำตาล สถาปัตยกรรม:
```
React client (Vite/TS)  →  Express server (SQLite)  →  Telegram + n8n  →  Google Sheets
```
- `client/` — React + TypeScript (Vite) ดีพลอยที่ host เดิม (ดู vercel.json)
- `server/` — Express + sqlite3 (`cip_database.sqlite`) ดีพลอยที่ Render → `https://back-wash-test.onrender.com`
- n8n: `https://n8n.srv1267366.hstgr.cloud/webhook/cip-report` → Google Sheet "Log-CIP"
  (id: `1Tm9UibL5o9assdK7L-MbM27H8KDB7gysd0g2b4X5gA8`, แท็บ "การผลิต" = gid 0)
- env ที่ server ใช้: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `N8N_WEBHOOK_URL`, `PORT`

## ฟีเจอร์ที่เพิ่งทำเสร็จ (อยู่ใน working tree แล้ว ยังไม่ commit)
1. **หน้าแผนผลิต** ฝังในหน้า Production Control — แก้ `client/src/components/ProductionRecord.tsx`
   - ปุ่ม "📋 แผนผลิตวันนี้" → กรอกแผน (Line/รสชาติ/จำนวน batch) + แถบ % ผลิตจริงเทียบแผน
   - เรียก `POST /api/production/plan`, `GET /api/production/plan`
2. **API แผนผลิต** — แก้ `server/index.js`
   - ตาราง `production_plans` (UNIQUE: plan_date+line_name+flavor, upsert)
   - `POST /api/production/plan`, `GET /api/production/plan`, `GET /api/production/summary`
   - ส่ง Telegram + `sendToN8n({type:'production_plan', ...})`
3. **n8n workflow 2 ไฟล์** (ที่ root)
   - `n8n-CIP-Report-with-plan.json` — CIP-Report เดิม + Switch สาขา 5 (`production_plan`) → append แท็บ "แผนผลิต"
   - `n8n-Telegram-Production-Chart.json` — Telegram Trigger → Parse → อ่าน 2 ชีต → QuickChart → ส่งรูปกลับ

> สถานะตรวจแล้ว: React typecheck ผ่าน, `node -c server/index.js` ผ่าน, n8n JSON valid

## งานที่ต้องทำต่อ (เรียงลำดับ)
1. `cd client && npm run build` ให้ผ่าน แล้ว commit + push (deploy client)
2. ทดสอบ server local: `cd server && node index.js` แล้วยิง `POST /api/production/plan` ด้วย curl ดูว่า DB + Telegram ทำงาน
3. commit + push `server/` ขึ้น Render
4. สร้างแท็บ Google Sheet ชื่อ `แผนผลิต` หัวคอลัมน์: `planDate, line, flavor, plannedBatches, operator, note, createdAt`
5. Import n8n ทั้งสองไฟล์ → เปิดโหนด "Production Plan" และ "Read Plan" เลือกแท็บ "แผนผลิต" ใหม่ (ต้องการ gid จริง) → ใส่ Telegram credential ที่โหนด Trigger/Send → Activate
6. ทดสอบ end-to-end: บันทึกแผนจากแอป → เช็คชีต → พิมพ์ใน Telegram `สรุป จำนวนผลิต Amazon` → ต้องได้กราฟกลับ

## คำสั่งทดสอบ API (ตัวอย่าง)
```bash
curl -X POST https://back-wash-test.onrender.com/api/production/plan \
  -H 'Content-Type: application/json' \
  -d '{"planDate":"2026-06-11","operator":"จักรกฤษ","items":[{"line":"Line 1","flavor":"Amazon","plannedBatches":4}]}'
```

## ข้อควรระวัง
- อย่าให้ Telegram webhook ของบอตซ้อนกัน: ถ้าบอตแจ้งเตือน (จาก server) กับบอตตอบกราฟเป็นตัวเดียวกัน ต้องใช้ Telegram Trigger ใน n8n เป็นตัวรับ
- ยอด "ผลิตจริง" ในหน้าแอปนับจาก batch ที่กด Done ใน session ปัจจุบัน; ส่วนกราฟใน Telegram นับจากชีต "การผลิต"
- รายละเอียดติดตั้งเต็มอยู่ใน `คู่มือ-แผนผลิต-และ-Telegram-Chart.md`
