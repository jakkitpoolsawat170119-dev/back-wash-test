# คู่มือติดตั้ง: หน้าแผนผลิต + Telegram ถามข้อมูลเป็นแผนภูมิ

ระบบนี้เพิ่ม 3 ส่วนเข้ากับของเดิม (React app → Express server → Telegram + n8n → Google Sheets):

1. **หน้าแผนผลิต** ฝังอยู่ในหน้า "บันทึกการผลิต" (Production Control)
2. **API แผนผลิต** ใน server ส่งแผนเข้า Telegram และ n8n → Google Sheet
3. **Telegram bot** พิมพ์ถาม เช่น `สรุป จำนวนผลิต Amazon` แล้วบอตตอบกลับเป็น **แผนภูมิแท่ง** (เทียบแผน vs ผลิตจริง)

---

## ส่วนที่ 1 — หน้าแผนผลิต (React) ✅ แก้ไฟล์ให้แล้ว

ไฟล์ที่แก้: `client/src/components/ProductionRecord.tsx`

ที่หน้า Production Control จะมีปุ่ม **"📋 แผนผลิตวันนี้"** ด้านบน กดแล้วจะเปิดแผงให้:

- เลือกวันที่ผลิต (ค่าเริ่มต้น = วันนี้)
- เพิ่มรายการแผน: เลือก Line (หรือ "รวม"), รสชาติ, จำนวน batch ที่วางแผน
- เห็นแถบความคืบหน้า **ผลิตจริง / แผน (%)** แบบเรียลไทม์ของแต่ละรายการ
- กด **💾 บันทึกแผน** เพื่อส่งเข้า server

ยอด "ผลิตจริง" นับจาก batch ที่กด Done ในหน้านี้ (ตามรสชาติ และ Line ถ้าระบุ)

**ดีพลอย:** commit + push ตามปกติ เพราะ client ดึงไป build ที่ Vercel/host เดิม
```bash
cd client && npm run build      # ตรวจ build ผ่าน (typecheck ผ่านแล้ว)
```

---

## ส่วนที่ 2 — API แผนผลิต (server) ✅ แก้ไฟล์ให้แล้ว

ไฟล์ที่แก้: `server/index.js` — เพิ่มตาราง `production_plans` และ 3 endpoint:

| Method | Path | หน้าที่ |
|--------|------|--------|
| POST | `/api/production/plan` | บันทึก/อัปเดตแผน → Telegram + n8n (`type: production_plan`) |
| GET | `/api/production/plan?date=YYYY-MM-DD` | ดึงแผนของวัน |
| GET | `/api/production/summary?date=YYYY-MM-DD` | นับยอดผลิตจริงจาก log |

ใช้ env เดิม (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `N8N_WEBHOOK_URL`) ไม่ต้องตั้งค่าใหม่
**ดีพลอย:** push ขึ้น Render (back-wash-test.onrender.com) ตามเดิม

---

## ส่วนที่ 3 — n8n + Google Sheet

### 3.1 เตรียม Google Sheet
เปิดสเปรดชีต **Log-CIP** เดิม → สร้างแท็บใหม่ชื่อ **`แผนผลิต`** แล้วใส่หัวคอลัมน์แถวแรก:
```
planDate | line | flavor | plannedBatches | operator | note | createdAt
```

### 3.2 อัปเดต workflow รับข้อมูล — `n8n-CIP-Report-with-plan.json`
เป็น workflow `CIP-Report` เดิม + เพิ่มสาขา `production_plan` (Switch output ที่ 5 → Google Sheets append แท็บ "แผนผลิต")

วิธีใช้:
1. n8n → Import from File → เลือก `n8n-CIP-Report-with-plan.json`
2. เปิดโหนด **"Production Plan"** → เลือกแท็บ **"แผนผลิต"** อีกครั้ง (n8n ต้องการ gid จริง)
3. ตรวจ Webhook path ยังเป็น `cip-report` (เหมือนเดิม) แล้ว Activate
   *(หรือจะไปเพิ่มสาขานี้ใน workflow เดิมด้วยมือก็ได้ ไม่ต้อง import ทับ)*

### 3.3 บอตตอบแผนภูมิ — `n8n-Telegram-Production-Chart.json`
โครงสร้าง: **Telegram Trigger → Parse Query → Read Actual → Read Plan → Build Chart → Send Chart**

- **Parse Query**: ดึงชื่อรสชาติ + วันที่จากข้อความ (ตอบเฉพาะข้อความที่มีคำว่า สรุป/ผลิต/แผน/กราฟ/chart)
- **Read Actual / Read Plan**: อ่านแท็บ "การผลิต" และ "แผนผลิต"
- **Build Chart**: รวมยอดต่อรสชาติ → สร้าง URL กราฟด้วย **QuickChart** (เทียบแผน vs จริง)
- **Send Chart**: ส่งรูป + สรุปตัวเลขกลับไปแชทที่ถาม

วิธีใช้:
1. n8n → Import from File → เลือก `n8n-Telegram-Production-Chart.json`
2. โหนด **Telegram Trigger** และ **Send Chart**: เลือก/สร้าง Credential ของ **Telegram Bot** (ใช้ token เดิมได้)
3. โหนด **Read Actual / Read Plan**: เลือก Credential Google เดิม (GoogleAuth) และเลือกแท็บให้ถูก ("การผลิต" / "แผนผลิต")
4. Activate

> ⚠️ ใช้ได้กับบอตเดียวเท่านั้นต่อ 1 โหมด: ถ้าบอตตัวที่ส่งแจ้งเตือน (จาก server) กับบอตที่ตอบกราฟเป็น **ตัวเดียวกัน** ให้ใช้ Telegram Trigger ใน n8n เป็นตัวรับข้อความ (อย่าตั้ง webhook ซ้อนกับที่อื่น)

---

## วิธีถามในกลุ่ม/แชท Telegram
```
สรุป จำนวนผลิต Amazon              → กราฟ Amazon แผน vs จริง (วันนี้)
สรุปผลิต                          → กราฟทุกรสชาติ (วันนี้)
สรุปผลิต Amazon 2026-06-11        → ระบุวันที่เจาะจง
สรุปผลิต ทั้งหมด                  → รวมทุกวัน (ไม่กรองวันที่)
```

## การไหลของข้อมูล (สรุป)
```
หน้าแผนผลิต (App)
   └─ POST /api/production/plan ─► server ─► Telegram (แจ้งแผน)
                                         └► n8n (type:production_plan) ─► Sheet "แผนผลิต"

หน้าบันทึกผลิต (กด Done)
   └─ POST /api/production/log  ─► server ─► n8n (type:production) ─► Sheet "การผลิต"

พิมพ์ถามใน Telegram ─► n8n Telegram Trigger ─► อ่าน 2 ชีต ─► QuickChart ─► ส่งรูปกลับ
```
