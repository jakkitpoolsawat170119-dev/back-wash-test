# Sticker Guide Chat Workflow

ลูกค้าพิมพ์คำถามในเว็บแชทของแอป เช่น `วิธีติดสติ๊กเกอร์ลูกค้า Kaoshop` แล้ว workflow นี้จะตอบกลับเป็นขั้นตอน + รูปภาพประกอบ โดยค้นข้อมูลจาก Supabase

## วิธีใช้งาน

1. นำเข้า `sticker-guide-chat.json` เข้า n8n (Import from File)
2. ตั้งค่า environment variables ใน n8n:
   - `SUPABASE_URL` — URL โปรเจกต์ Supabase (ตัวเดียวกับ `VITE_SUPABASE_URL` ของ client)
   - `SUPABASE_ANON_KEY` — anon/service key สำหรับเรียก REST API
3. สร้างตาราง `sticker_guides` ใน Supabase ด้วยคอลัมน์:
   - `customer_name` (text) — ชื่อลูกค้า เช่น `Kaoshop`
   - `steps` (text) — ขั้นตอนการติดสติ๊กเกอร์ (ข้อความหลายบรรทัด)
   - `image_urls` (jsonb หรือ text[]) — array ของ URL รูปตัวอย่างขั้นตอน
4. Activate workflow แล้วเรียก webhook ที่ path `/sticker-guide-chat` ด้วย POST body:
   ```json
   { "message": "วิธีติดสติ๊กเกอร์ลูกค้า Kaoshop", "sessionId": "optional" }
   ```

## การตอบกลับ

Workflow คืน JSON รูปแบบ:
```json
{
  "messages": [
    { "type": "text", "text": "📦 วิธีติดสติ๊กเกอร์สำหรับลูกค้า Kaoshop\n\n1. ...\n2. ..." },
    { "type": "image", "url": "https://.../step1.jpg" }
  ]
}
```

ฝั่งเว็บแชทใน client เพียงวนลูป `messages` แล้วเรนเดอร์ตาม `type` (text / image)

## เคสที่จัดการให้

- ไม่ระบุชื่อลูกค้าในคำถาม → ขอให้ลูกค้าระบุชื่อใหม่
- ระบุชื่อลูกค้าแต่ไม่พบข้อมูลใน Supabase → แจ้งว่ายังไม่มีข้อมูล พร้อมแนะนำให้ติดต่อแอดมิน
- พบข้อมูล → ส่งขั้นตอน + รูปภาพประกอบ
