# 📤 วิธีแก้โค้ด แล้วขึ้นเว็บจริง (Push → main)

คู่มือส่วนตัว — เปิดดูเวลาลืม

---

## 🔁 ลูปมาตรฐาน 7 สเต็ป

```bash
# 1) เข้า client แล้วเช็คว่า build ไม่พัง
cd "/Users/myjakkit/Downloads/back wash test/client"
npm run build
#    → ต้องเห็น "✓ built" ก่อน ถึงไปต่อ
#    → ถ้าขึ้น error สีแดง = หยุด แก้ก่อน อย่า push

# 2) ถอยกลับโฟลเดอร์หลัก
cd ..

# 3) ดูว่าแก้ไฟล์อะไรบ้าง
git status

# 4) เพิ่มไฟล์ที่แก้
git add -A

# 5) บันทึก (เขียนสั้นๆ ว่าแก้อะไร)
git commit -m "แก้..."

# 6) ดึงของล่าสุดจาก GitHub มารวมก่อน (กัน push โดน rejected)
git pull

# 7) ส่งขึ้นเว็บจริง
git push origin main
```

เสร็จแล้ว → **Vercel build เว็บจริงเองอัตโนมัติ ~1–2 นาที**
→ เปิดเว็บจริง กด `Cmd` + `Shift` + `R` (ล้าง cache) จะเห็นของใหม่

---

## ✅ จำ 3 หลักนี้พอ

1. **`npm run build` ก่อนเสมอ** — เห็น `✓ built` ค่อย push (กันเว็บจริงพัง)
2. **`git pull` ก่อน `git push` เสมอ** — กันปัญหา rejected / divergent
3. **ดูตรงหน้า `$` ว่าอยู่โฟลเดอร์ไหน** — `build` รันใน `client`, `git` รันในโฟลเดอร์หลัก

---

## 🆘 เจอปัญหาแก้ยังไง

| อาการ | สาเหตุ | วิธีแก้ |
|---|---|---|
| `fatal: not a git repository` | อยู่ผิดโฟลเดอร์ (เห็น `~` หน้า `$`) | `cd "/Users/myjakkit/Downloads/back wash test"` |
| `push rejected (non-fast-forward)` / `behind` | GitHub มีของใหม่กว่าเครื่อง | `git pull` แล้ว `git push origin main` อีกที |
| `error` ตอน `npm run build` | โค้ดพิมพ์ผิด (มักลืม `;` `}` `px`) | อ่านว่าไฟล์ไหนบรรทัดอะไร → แก้ → build ใหม่ |
| ไม่รู้อยู่โฟลเดอร์ไหน | — | พิมพ์ `pwd` (บอกตำแหน่งปัจจุบัน) |

> ⚠️ คำเตือนสีเหลือง `chunks larger than 500 kB` ตอน build = **ไม่เป็นไร ข้ามได้** ไม่ใช่ error

---

## 📍 ที่อยู่ไฟล์ที่แก้บ่อย

| อยากแก้ | ไฟล์ |
|---|---|
| เมนู sidebar Admin (ชื่อ/ไอคอน/ลำดับ) | `client/src/components/AdminShell.tsx` (ตัวแปร `MENU`) |
| หน้าตา/สี/ขนาด/ระยะ ของ Admin + redesign | `client/src/redesign.css` |
| หน้าหลัก 3 การ์ด | `client/src/components/Home.tsx` |
| หน้า CIP (รวม Line) | `client/src/components/CipHub.tsx` |

---

## ⚙️ ค่าที่ตั้งไว้แล้ว (ไม่ต้องทำซ้ำ)

- `git config pull.rebase false` → ตั้งแล้ว ทำให้ `git pull` ใช้ merge เสมอ (ไม่ถาม divergent)

---

_อัปเดตล่าสุด: 2026-07-28_
