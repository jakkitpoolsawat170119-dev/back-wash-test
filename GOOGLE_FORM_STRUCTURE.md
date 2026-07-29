# Google Form Structure — รายงานการบันทึกข้อมูลยอดการผลิตประจำวัน SPP

**Form URL:** https://docs.google.com/forms/d/e/1FAIpQLSeOT76aF1RLVKTQ2rRo7xjc3RXMoTthD-0M3mj5Cgv6QCIWRg/viewform

**จำนวนช่องรวม:** 75 (รวม section headers) — **บังคับกรอกทุกช่อง**

> **ที่มาของไฟล์นี้:** ถอดโครงสร้างจากฟอร์มจริง · entry ID และรหัส SKU คัดมาตรงตัว
> ข้อความไทยบางส่วนเสียหายตอนส่งไฟล์ จึงกู้กลับจากคำศัพท์ที่ใช้ในระบบเดิม (FILS.md + n8n workflow)
> จุดที่กู้ไม่ได้มาร์ก `⚠️ TODO` ไว้ — **ห้ามเดา ต้องเปิดฟอร์มจริงเช็คก่อนใช้**

**ชนิดช่อง:** `date` · `checkbox` (เลือกได้หลายตัว) · `short_text` · `section` (หัวข้อ ไม่ใช่ field จริง)

---

## หมวดที่ 1 — วันที่และกะ

| Field | Type | entry_id |
|---|---|---|
| วันที่การผลิต | date | `entry.762110457` |
| กะ | checkbox | `entry.944802563` |

**กะ options:** `กะ1` · `กะ2` · `กะ3`

---

## หมวดที่ 2 — รายชื่อพนักงานตามกะ

ช่องนี้เป็น conditional — กรอกเฉพาะกะที่เลือกในหมวด 1

| Field | Type | entry_id | รายชื่อ |
|---|---|---|---|
| กะ 1 | checkbox | `entry.1652181929` | อนุวัตร สุวรรณวงศ์ · ดำรงค์ มีแก้ว · รัตนะ ธงเพ็ง · นพพร พิมพ์ทอง |
| กะ 2 | checkbox | `entry.69112525` | จักรกฤษ พูลสวัสดิ์ · สุรศักดิ์ สรหงษ์ · ศราวุธ เกษประทุม · เกรียงไกร ศรีนิล |
| กะ 3 | checkbox | `entry.1167301636` | พัฒน์พริศร์ อ่ำอยู่ · ไพรวรรณ ย้อนเพชร · รัชพล รัตนานนท์ · สมเจตน์ การภักดี |

```javascript
const SHIFT_MEMBER_MAP = {
  'กะ1': 'entry.1652181929',
  'กะ2': 'entry.69112525',
  'กะ3': 'entry.1167301636',
};
```

---

## หมวดที่ 3 — กลุ่ม Product

| Field | Type | entry_id |
|---|---|---|
| กลุ่ม Product | checkbox | `entry.1219371981` |

**options (11 ตัว):**
```
Syrup | Freshy | Senorita | Amazon-NGS | Hygiene | Icing | Coconut -Paste |
Stick | Coffee & Sachet | Low Cal. | ถังน้ำเชื่อม ทำความสะอาด งานแปะสติ๊กเกอร์ และอื่นๆ
```

> ⚠️ **ต้องตรงทุกตัวอักษร:** `Coffee & Sachet` มี `&` · `Coconut -Paste` มีเว้นวรรค**หน้า** `-` · `Low Cal.` มีจุดท้าย

---

## หมวดที่ 4 — ชื่อ Product (แยก field ตามกลุ่ม)

แต่ละกลุ่มมี field ของตัวเอง — ต้อง map กลุ่ม → entry_id ให้ถูก

```javascript
const SKU_ENTRY_MAP = {
  'Syrup':           'entry.419019991',
  'Freshy':          'entry.343536751',
  'Senorita':        'entry.1031807853',
  'Amazon-NGS':      'entry.1289646646',
  'Hygiene':         'entry.678287255',
  'Coconut -Paste':  'entry.1236692555',
  'Stick':           'entry.1284848105',
  'Icing':           'entry.1652381833',
  'Coffee & Sachet': 'entry.303921656',
  'Low Cal.':        'entry.25393149',
};
```

### Syrup — `entry.419019991`
```
S71AHM0000  น้ำเชื่อมมิตรผล Syrup 4.5KGx4 (3.2Ltrx4)
S71AEB0000  น้ำเชื่อมมิตรผล 20KG (BIB)
S76AQU0000  น้ำเชื่อมมิตรผล (300ml*24) 417 g/bottle
S76ARU0000  Mitr phol Natural Cane Syrup(300ml*4*6)
S76S9Z0000  Mitr Phol Syrup (800ml*12)Stand pouch
S76U3Z0000  Mitr Phol Syrup (800ml*3*4) Stand pouch
S76U4Z0000  Mitr Phol Syrup (800ml*20) Stand pouch
S76U3ZBY00  Mitr Phol Syrup (800ml*3*4) Makro
S76V6Z0000  น้ำเชื่อม มิตรผล (1.8L*8)
S76S9Z000M  Mitr Phol Syrup (800ml*12)Stand pouch MT
S76S9Z000T  Mitr Phol Syrup(800ml*12)Stand pouch TT
S76S9ZTP00  น้ำเชื่อม มิตรผล (800ml*12) ถุงตั้ง-TCC
S76S9Z000P  Mitr Phol Syrup(800ml*12)Stand pouch + Premium
S76S9ZTC000 Mitr Phol Syrup (800ml*12)Stand pouch
S71AHM0020  NATURAL CANE SYRUP(3.2 LITERSx4) REG-ENG
S76S9Z4900  น้ำเชื่อม ตรา เอโอะ ชั้น ฟ้า (800ml*12)   ⚠️ TODO ตรวจชื่อแบรนด์
S76S9ZNC00  Syrup Nobi Cha Brand (800ml*12)
[+ ตัวเลือกอื่นๆ]
```

### Freshy — `entry.343536751`
```
S7IFRU4200  น้ำเชื่อมกีวี (เฟรชชี่)(710ml*12)
S7EFRU4200  น้ำเชื่อมสตรอเบอร์รี่(เฟรชชี่)(710ml*12)
S7HFRU4200  น้ำเชื่อมส้ม (เฟรชชี่)(710ml*12)
S7FFRU4200  น้ำเชื่อมมะม่วง (เฟรชชี่)(710ml*12)
S7DFRU4200  น้ำเชื่อมลิ้นจี่ (เฟรชชี่)(710ml*12)
S7YFRU4200  น้ำเชื่อมแอปเปิ้ลเขียว(เฟรชชี่)(710ml*12)
S7CFRU4200  น้ำเชื่อมบลูเลมอน (เฟรชชี่)(710ml*12)   ⚠️ TODO ตรวจชื่อรส
S7JFRU4200  น้ำเชื่อมมะนาว (เฟรชชี่)(710ml*12)
S7L88U4400  Sala Syrup (Freshy Pro) (750ml*12)
S7LFRU4200  Sala Flavoured Syrup(Freshy) (710ml*12)
[+ ตัวเลือกอื่นๆ]
```

### Senorita — `entry.1031807853`
```
S79U5UTM00  น้ำเชื่อมวานิลลา ตราเซนญอริตา 750ml*6 TH
S79U5USN00  Vanilla Flavoured Syrup (Senorita)
S78U5UTM00  น้ำเชื่อมฮาเซลนัท ตราเซนญอริตา 750ml*6TH
S78U5USN00  Hazelnut Flavoured Syrup (Senorita)
S7EU5USN00  Strawberry Flavoured Syrup (Senorita)
S7GU5USN00  Japanese Melon Flavoured Syrup(Senorita)
S7DU5USN00  Lychee Flavoured Syrup (Senorita)
S7KU5USN00  Coconut Flavoured Syrup (Senorita)
SFBU5USN00  น้ำเชื่อม บลูคูราเซา ตรา เซนญอริตา
SFMU5USN00  Fresh Mint Flavoured Syrup (Senorita)
SFPU5USN00  Passion Fruit Flavoured Syrup (Senorita)
S77U5USN00  Caramel Flavoured Syrup (Senorita)
S77U5UTM00  น้ำเชื่อมคาราเมล ตราเซนญอริตา 750ml*6 TH
SPUMP4000A  SYRUP PUMP SENORITA (1*12)(FOR SALE)
S77CA4SN02  น้ำเชื่อมคาราเมล เซนญอริตา (2700ml*4)
[+ ตัวเลือกอื่นๆ]
```

### Amazon-NGS — `entry.1289646646`
```
S77S743200  น้ำเชื่อมมิตรผลคาราเมล อเมซอน 850 ml *12
S7OS9Z0000  น้ำเชื่อมละลายเร็ว มิตรผล (800ml*12)
S7OS9Z000T  Fast Dissolving Syrup (800ml*12) TT
S7NS9Z0000  Golden Syrup (800ml*12)
S7NARU0000  Golden Syrup (300ml*4*6)
S76S44TM00  Simply Syrup Tim Hortons Brand (1.3Kg.*12)
```

### Stick — `entry.1284848105`
```
S148081300  น้ำตาลทรายขาว JWMarriot Stick (4G*200*20)   ⚠️ TODO ตรวจชื่อ
S403180050  MITR PHOL STICK SUGAR (6G*100*20)REG-CAN
S406780000  น้ำตาลบริสุทธิ์ STICK (6G.*100*5*4)
S143181900  น้ำตาลทรายขาว NOVOTEL Stick (6G*100*20)     ⚠️ TODO ตรวจชื่อ
S403181900  บรรจุซองยาว 6 กรัม x100 x 20 Novotel ทรายขาว
S143182200  น้ำตาลทราย THE CAMPUS STICK(6G.*100*20)
S143181400  น้ำตาลทรายขาวโอราวัน Stick (6G*100*20)      ⚠️ TODO ตรวจชื่อ
S409380000  น้ำตาลบริสุทธิ์มิตรผล STICK (6G.*50*40)
S409580000  น้ำตาลบริสุทธิ์มิตรผล STICK(6G.*50*4*10)
S403180000  MP SUPER REFINED STICK (6G.*100*20)
S146780000  น้ำตาลอ้อยธรรมชาติ Stick (6G*100*5*4)
S409080000  น้ำตาลบริสุทธิ์พิเศษ MP STICK (6G*400*5)
S143180000  น้ำตาลอ้อยธรรมชาติ Stick (6G.*100*20)
S149780000  น้ำตาลอ้อยธรรมชาติ STICK(6G.*400*5)
S143182800  น้ำตาลอ้อยธรรมชาติ Stick ถอยถุง                ⚠️ TODO ตรวจคำท้าย
[+ ตัวเลือกอื่นๆ]
```

### Hygiene — `entry.678287255`
*(ยังไม่ได้ดึงรายการ — ต้องเปิดฟอร์มดู)*

### Coconut -Paste — `entry.1236692555`
*(ชื่อ field ในฟอร์ม: "ชื่อ Product ชีส")*

### Icing — `entry.1652381833`
*(ยังไม่ได้ดึงรายการ)*

### Coffee & Sachet — `entry.303921656`
*(ยังไม่ได้ดึงรายการ)*

### Low Cal. — `entry.25393149`
*(ยังไม่ได้ดึงรายการ)*

---

## หมวดที่ 5 — เครื่องบรรจุ

| Field | Type | entry_id |
|---|---|---|
| เครื่องบรรจุและเลขที่ผลิต | checkbox | `entry.284110877` |

**options (19 ตัว):**
```
Rotary (Hondok)
Linear#1 (Lina Pack)
Linear#2 (Lina Pack)
Linear#3 (Lina Pack)
Linear#4 (Lina Pack)
300 ml (Delmax)
Hygiene (Delmax)
Freshy (Delmax)
เครื่องบรรจุ??????            ⚠️ TODO กู้ไม่ได้ — เปิดฟอร์มเช็ค
Sachet (Thai M Pack)
Stick (Sanko)
Paste 1-5 kg 454 g
ICING 10-25 Kg
Low Cal 105-500 g
ต้มหัวเชื้อ
ถังน้ำเชื่อม ทำความสะอาด อื่นๆ
Manual
เครื่องบรรจุ???? (Thai M Pack)   ⚠️ TODO กู้ไม่ได้ — เปิดฟอร์มเช็ค
เครื่องบรรจุ#A3
```

---

## หมวดที่ 6 — Lot น้ำเชื่อม

| Field | Type | entry_id |
|---|---|---|
| ระบุ Lot น้ำเชื่อมที่บรรจุ | **date** | `entry.937663612` |

> Lot ระบุด้วย**วันที่** ไม่ใช่ข้อความ

---

## หมวดที่ 7 — งานพิเศษ / ถังน้ำเชื่อม

| Field | Type | entry_id |
|---|---|---|
| ข้อมูล ถังน้ำเชื่อม ทำความสะอาด อื่นๆ | short_text | `entry.94913550` |

---

## หมวดที่ 8 — ข้อมูลการผลิต (ส่วนหลัก)

| Field | Type | entry_id |
|---|---|---|
| จำนวนแผนผลิต (กล่อง/หม้อ) | short_text | `entry.2019026982` |
| ผลิตเกิดจริง (กล่อง/หม้อ) | short_text | `entry.1580955376` |
| จำนวนคนผลิต | short_text | `entry.956550082` |
| จำนวนชิ้น/กล่อง | short_text | `entry.503607673` |
| เวลารวมผลิต 480/720 (นาที) | short_text | `entry.1416973656` |
| ยอดเลขหน้าเครื่อง (ชิ้น) | short_text | `entry.1908975209` |
| เดินรอบเครื่อง | short_text | `entry.1939644821` |
| เวลา setup 0:30 | short_text | `entry.171545098` |
| เวลาพัก 0:60/0:90 | short_text | `entry.696883618` |
| เวลา Clean 0:30 | short_text | `entry.1787932261` |
| เวลาหยุดเครื่องหลังจากได้ยอดแล้วหลังล้างเครื่อง | short_text | `entry.307258811` |
| เวลา B-down (ใส่เฉพาะตัวเลข ไม่มีใส่ 0) | short_text | `entry.568440442` |
| รวมเวลาเดินเครื่อง | short_text | `entry.337583622` |
| สถานะการผลิต | checkbox | `entry.1147889469` |
| สาเหตุที่ไม่ได้ยอดผลิต | short_text | `entry.1365440571` |
| ยอดส่งคลัง(ชิ้น) | short_text | `entry.76060507` |

**สถานะการผลิต options:** `ได้ยอดผลิต` · `ไม่ได้ยอดผลิต`

> **หน่วย:** แผน/ผลิตจริง = **กล่อง/หม้อ** (+ กระสอบ สำหรับ Icing) แต่ **ยอดส่งคลัง = ชิ้น**
> "หม้อ" ใช้กับงานต้มหัวเชื้อ/เพสต์

---

## หมวดที่ 9 — ของเสีย / ภาชนะบรรจุชำรุด

| Field | Type | entry_id |
|---|---|---|
| กรอกข้อมูลภาชนะบรรจุชำรุด | checkbox | `entry.1331777363` |

**options:** `กริ๊ป` · `ฝา` · `ถุง Pack` · `ขวด/กระปุก` · `กล่อง` · `ถุง`

**sub-fields แยกตามประเภท** — แต่ละประเภทมี 2 ช่อง:

| ประเภท | จำนวนของเสีย | สาเหตุการชำรุด |
|---|---|---|
| ถุง | `entry.2018044109` | `entry.1219932698` |
| ถุง Pack | `entry.2135984994` | `entry.728894702` |
| ขวด/กระปุก | `entry.1886023640` | `entry.1809259802` |
| ฝา | `entry.1998227044` | `entry.1701353183` |
| กริ๊ป | `entry.506818073` | `entry.47250003` |
| กล่อง | `entry.496973750` | `entry.1234198940` |

> รวม 12 ช่อง **บังคับกรอกทั้งหมด** แม้ไม่มีของเสีย

---

## ข้อสังเกตสำหรับการพัฒนาระบบใหม่

1. **ทุก field เป็น required** → หัวหน้างานต้องกรอกครบ 75 ช่องทุกรายการทุกวัน
2. **กะ 1/2/3 เป็น conditional** — กรอกเฉพาะกะที่เลือก
3. **ชื่อ Product แยก field ตามกลุ่ม 10 ช่อง** — ต้อง map กลุ่ม → entry_id ให้ถูก
4. **`Coffee & Sachet` / `Coconut -Paste` / `Low Cal.`** ต้องตรงกับ option ทุกตัวอักษร
5. **เครื่องบรรจุ 19 ตัวเลือก** — ค่าที่ระบบส่งต้องเป็นหนึ่งใน 19 นี้ ไม่ใช่ free text
6. **ของเสียมี sub-fields** — ต้องเลือก entry_id ตามประเภทที่มี

### แผนลดจำนวนช่องที่ต้องพิมพ์ (75 → ~8)

| ที่มา | ช่อง |
|---|---|
| เติมจากระบบ | วันที่ · กะ · รายชื่อพนักงาน · จำนวนแผนผลิต · จำนวนคนผลิต |
| ได้จากเลือก SKU ครั้งเดียว | กลุ่ม Product · ชื่อ Product · เครื่องบรรจุ · จำนวนชิ้น/กล่อง · หน่วยนับ |
| ค่ามาตรฐาน | เวลารวมผลิต · setup · พัก · Clean · หยุดหลังได้ยอด |
| ระบบคำนวณ | รวมเวลาเดินเครื่อง · สถานะการผลิต |
| มาจากคลังสินค้า | ยอดส่งคลัง(ชิ้น) |
| **ยังต้องพิมพ์เอง** | **ผลิตเกิดจริง · ยอดเลขหน้าเครื่อง · เดินรอบเครื่อง · B-down · Lot น้ำเชื่อม · สาเหตุที่ไม่ได้ยอด · ของเสียเฉพาะที่มี · งานพิเศษถ้ามี** |

---

## ⚠️ หมายเหตุสำคัญ: entry ID ใน n8n ไม่ตรงกับฟอร์มนี้

โหนด `Build Form Body` ใน `n8n-workflows/SPP-Production-Auto-Submit-v2.json` มีตาราง `ENTRY`
ที่ใช้ entry ID ชุดเก่า (เช่น `entry.1576360786` สำหรับวันที่) — **ไม่ตรงกับฟอร์มนี้สักตัว**

ตรวจแล้วว่าตัวแปร `formBody` ที่โหนดนั้นสร้าง **ไม่ถูกใช้ต่อที่ไหนเลยใน workflow**
(ปรากฏครั้งเดียวคือตอนประกาศ) จึงเป็นโค้ดตายที่ไม่กระทบการทำงาน แต่**ห้ามใช้อ้างอิง** และควรลบทิ้ง
