import React, { useState } from 'react';

interface Props {
  operatorName: string;
  onBackToMain: () => void;
}

const STEPS = [
  {
    id: 1,
    code: 'MIX-T',
    title: 'Mixing Tanks (ถังผสม 2 × 3m³)',
    subtitle: 'Syrup Processing → Mixing Tanks',
    color: '#01579b',
    bgLight: '#e1f5fe',
    icon: (
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6" y="8" width="8" height="18" rx="1"/>
        <rect x="18" y="8" width="8" height="18" rx="1"/>
        <line x1="7" y1="12" x2="13" y2="12"/>
        <line x1="19" y1="12" x2="25" y2="12"/>
        <path d="M10 26 L10 29 M22 26 L22 29"/>
        <circle cx="10" cy="5" r="1.5" fill="currentColor" stroke="none" opacity="0.4"/>
        <circle cx="22" cy="5" r="1.5" fill="currentColor" stroke="none" opacity="0.4"/>
      </svg>
    ),
    params: [
      { label: 'Mixing Tank 1 Temp', value: '~38.8 °C', note: 'ค่าจาก SCADA (ขณะ Empty)' },
      { label: 'Mixing Tank 2 Temp', value: '~34.8 °C', note: '' },
      { label: 'MIS Setpoint', value: '1,165 ltr', note: 'Main Ingredient Supply' },
      { label: 'WIS Setpoint', value: '1,470 ltr', note: 'Water/Wash Ingredient Supply' },
    ],
    items: [
      { name: 'Mixing Tank 1 & 2 (3m³ each)', desc: 'ถังผสมหลัก 2 ใบ — สลับกันใช้งาน ใบหนึ่งผสม อีกใบรอส่งต่อ มี Hot Water Jacket และ Agitator', tag: 'ถัง' },
      { name: 'Recipe System', desc: 'ระบบสูตรการผลิต — แต่ละ batch มีชื่อสูตร (Recipe) กำกับ ควบคุมปริมาณส่วนผสมอัตโนมัติ', tag: 'สูตร' },
      { name: 'Ingredient Quantity', desc: 'วัดปริมาณส่วนผสม 4 ประเภท: MIS (Main Ingredient), IBC (จาก IBC Tank), LS (Liquid Sugar), WIS (Water)', tag: 'ส่วนผสม' },
      { name: 'Pump: Mixing Tank 1/2', desc: 'ปั๊มประจำถังแต่ละใบ — จ่ายผลิตภัณฑ์ออกไป Pasteurizer Transfer Line', tag: 'ปั๊ม' },
      { name: 'Circulation Line with Mixer (P)', desc: 'ท่อหมุนเวียนพร้อม Inline Mixer — ใช้เมื่อต้องการ Homogenize ส่วนผสมในถัง', tag: 'หมุนเวียน' },
      { name: 'Pasteurizer Transfer Line (P)', desc: 'ปั๊มส่งต่อไป Pasteurizer — ผ่าน Source Tank ก่อนเข้าสาย Pasteurizer หลัก', tag: 'ส่งต่อ' },
      { name: 'Storage Tk (บนหน้าจอซ้าย)', desc: 'แสดงสถานะ Storage Tank ที่เชื่อมกับ Mixing Tanks ด้านซ้าย (CIP return loop)', tag: 'เก็บ' },
    ],
    note: 'Process Water เข้า 3 สาย (บนซ้าย) / CIP Kitchen เชื่อมทั้งด้านบนและล่าง / Air + Seal Water สำหรับปั๊ม',
  },
  {
    id: 2,
    code: 'MIX-S',
    title: 'Mixing Station (สถานีผสม)',
    subtitle: 'Syrup Processing → Mixing Station',
    color: '#1565c0',
    bgLight: '#e3f2fd',
    icon: (
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="16" cy="16" r="11"/>
        <path d="M16 5 L16 16"/>
        <path d="M16 16 L22 22"/>
        <path d="M16 16 L10 22"/>
        <circle cx="16" cy="16" r="2.5" fill="currentColor" stroke="none" opacity="0.4"/>
      </svg>
    ),
    params: [
      { label: 'IBC Sugar Weight', value: '393.20 kg', note: 'ตัวอย่างค่าจาก SCADA' },
      { label: 'Mixer Temp', value: '31.1 °C', note: 'ขณะ Empty' },
      { label: 'Flow Setpoint', value: '8.0 m³/h', note: 'อัตราการไหลหลัก' },
      { label: 'Process Water Flow', value: '100 ltr SP', note: '' },
    ],
    items: [
      { name: 'IBC Sugar (วัดน้ำหนัก kg)', desc: 'น้ำตาล IBC — แสดงน้ำหนักเป็น kg บนหน้าจอ (เช่น 393.20 kg) จ่ายเข้า Mixer โดยตรง', tag: 'น้ำตาล' },
      { name: 'Mixer (GEA Formula Mini Mixer)', desc: 'เครื่องผสมสูตร — ผสม IBC Sugar กับ Process Water ก่อนส่งเข้า Mixing Tank, แสดง Level% และ Temp°C', tag: 'ผสม' },
      { name: 'Heater EG21', desc: 'เครื่องทำความร้อนน้ำด้วยไอน้ำ — อยู่ใน Mixing Station ใช้เตรียมน้ำอุ่นก่อนผสม, มี Condensate return', tag: 'ร้อน' },
      { name: 'Steam + Condensate', desc: 'ไอน้ำเข้า Heater EG21 → Condensate กลับไปใช้ใหม่', tag: 'ไอน้ำ' },
      { name: 'Process Water (ทางขวา)', desc: 'น้ำกระบวนการผลิตเข้า Mixing Station — ควบคุมอัตราการไหล SP 8.0 m³/h', tag: 'น้ำ' },
      { name: 'Seal Water + Air', desc: 'น้ำซีลและอากาศอัด — ใช้กับปั๊มและวาล์วใน Mixing Station', tag: 'ซีล' },
    ],
    note: 'Mixing Station เชื่อมกับ Mixing Tanks ด้วยหลายสาย — ส่วนผสมจาก Mixer ไหลลงสู่ถังผสมหลัก',
  },
  {
    id: 3,
    code: 'PAST',
    title: 'Pasteurizer and Storage',
    subtitle: 'Syrup Processing → Pasteurizer and Storage',
    color: '#b71c1c',
    bgLight: '#ffebee',
    icon: (
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="10" width="24" height="16" rx="2"/>
        <path d="M8 10 L8 6 M16 10 L16 4 M24 10 L24 6"/>
        <line x1="4" y1="18" x2="28" y2="18"/>
        <path d="M10 22 L22 22" opacity="0.4"/>
      </svg>
    ),
    params: [
      { label: 'Pasteurizer Temp SP', value: '70.0 °C', note: 'อุณหภูมิพาสเจอไรซ์' },
      { label: 'Flow Rate SP', value: '2.5 m³/h', note: 'อัตราการไหลผ่าน PHE' },
      { label: 'Chilled Water SP', value: '40.0 °C', note: 'อุณหภูมิน้ำเย็น' },
      { label: 'Chilled Water Return', value: '30.3 °C', note: 'ค่าจาก SCADA' },
      { label: 'Balance Tank Level', value: '11.6 %', note: 'ตัวอย่างขณะ Standby' },
    ],
    items: [
      { name: 'Balance Tank (Bal. Tank)', desc: 'ถังสมดุลก่อน Pasteurizer — มี LSL (Low Switch Level) คุม, Level แสดงเป็น % บนหน้าจอ', tag: 'บัฟเฟอร์' },
      { name: 'Pasteurizer Main (P)', desc: 'ปั๊มหลักของ Pasteurizer — ใช้ในโหมด Production, แยกจาก Pasteurizer CIP', tag: 'ปั๊ม' },
      { name: 'Pasteurizer Production (P)', desc: 'โปรแกรมผลิตหลัก — ควบคุม sequence การ Heat, Hold, Cool อัตโนมัติ', tag: 'โปรแกรม' },
      { name: 'Heater EG51 (Pasteurizer)', desc: 'เครื่องทำความร้อนของ Pasteurizer (ไม่ใช่ EG21 ของ Mixing Station) — ใช้ Steam ให้ความร้อน PHE', tag: 'ร้อน' },
      { name: 'Holding Section (PHE)', desc: 'แผ่น PHE สำหรับ Hold อุณหภูมิ — SP 70.0°C, ผลิตภัณฑ์อยู่ที่อุณหภูมินี้ก่อน Cool', tag: 'ฆ่าเชื้อ' },
      { name: 'Chilled Water Cooling', desc: 'ระบบน้ำเย็น — Chilled Water S (Supply) SP 40.0°C, Return 30.3°C ลดอุณหภูมิหลัง Hold', tag: 'เย็น' },
      { name: 'Pasteurizer Recirculation (P)', desc: 'โหมด Standby/Recirculate — เมื่อไม่มีการผลิต ผลิตภัณฑ์หมุนเวียนกลับ', tag: 'หมุนเวียน' },
      { name: 'Dosing Unit (P)', desc: 'หน่วย Dosing — อยู่ที่ Standby ระหว่างรอคำสั่งจาก Filler', tag: 'โดส' },
      { name: 'Acid / Lye Inputs', desc: 'น้ำยากรดและด่างสำหรับ CIP ของ Pasteurizer — เชื่อมจาก CIP Kitchen', tag: 'CIP' },
    ],
    note: 'Current Recipe แสดงบนหน้าจอ (เช่น "CIP Bypass Homo") · E-Stop สีเขียว = ปกติ · ปริมาณ Product Quantity = 2918 ltr ที่ผ่านมาแล้ว',
  },
  {
    id: 4,
    code: 'STOR',
    title: 'Storage Tank (ถังเก็บ 1 × 3m³)',
    subtitle: 'อยู่ในหน้า Pasteurizer and Storage (ด้านขวา)',
    color: '#004d40',
    bgLight: '#e0f2f1',
    icon: (
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="8" y="6" width="16" height="22" rx="2"/>
        <line x1="8" y1="13" x2="24" y2="13"/>
        <line x1="8" y1="20" x2="24" y2="20"/>
        <path d="M16 28 L16 31"/>
        <circle cx="16" cy="5" r="1.5" fill="currentColor" stroke="none" opacity="0.35"/>
      </svg>
    ),
    params: [
      { label: 'Storage Tank Temp', value: '34.1 °C', note: 'ตัวอย่างค่าขณะรอ Filler' },
      { label: 'Level (SL)', value: '36.6 %', note: '' },
      { label: 'Level (M)', value: '42.4 %', note: 'เซ็นเซอร์ระดับที่ 2' },
      { label: 'State', value: 'Wait For Filler Request', note: 'State 150 — รอสัญญาณจากเครื่องบรรจุ' },
    ],
    items: [
      { name: 'Storage Tank (3m³)', desc: 'ถังเก็บผลิตภัณฑ์ที่ผ่านพาสเจอไรซ์แล้ว — แสดง Temp, Level (SL), Level (M) และ State', tag: 'เก็บ' },
      { name: 'State: "Wait For Filler Request"', desc: 'State 150 — ถังพร้อม รอสัญญาณ (Filler Signal) จากเครื่องบรรจุก่อนจ่ายออก', tag: 'รอ' },
      { name: 'Filler Signal', desc: 'สัญญาณจากเครื่องบรรจุ — เมื่อ Filler พร้อม จะส่งสัญญาณให้ Storage Tank จ่ายผลิตภัณฑ์', tag: 'สัญญาณ' },
      { name: 'SL + M Level Sensors', desc: 'เซ็นเซอร์วัดระดับ 2 ชุด (SL = Switch Level, M = Measurement) — ใช้ cross-check', tag: 'ระดับ' },
    ],
    note: 'ผลิตภัณฑ์ใน Storage Tank = "Product" · ต่อตรงไปไลน์บรรจุ (Filling Line)',
  },
  {
    id: 5,
    code: 'CIP-K',
    title: 'CIP Kitchen (ห้องเตรียมน้ำยาล้าง)',
    subtitle: 'CIP Station → CIP Kitchen',
    color: '#6a1b9a',
    bgLight: '#f3e5f5',
    icon: (
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 26 L8 10 C8 8 10 6 12 6 L20 6 C22 6 24 8 24 10 L24 26"/>
        <line x1="5" y1="26" x2="27" y2="26"/>
        <path d="M14 6 L14 2 M18 6 L18 2"/>
        <line x1="10" y1="15" x2="22" y2="15" opacity="0.4"/>
      </svg>
    ),
    params: [
      { label: 'Acid Tank Temp', value: '58.9 °C', note: 'Ready' },
      { label: 'Acid Tank Level', value: '59.2 %', note: '' },
      { label: 'Caustic Tank Temp', value: '71.2 °C', note: 'Ready' },
      { label: 'Caustic Tank Level', value: '58.8 %', note: '' },
      { label: 'Recovery Tank Temp', value: '36.9 °C', note: 'Ready' },
      { label: 'CIP Pump SP', value: '17.5 m³/h', note: 'อัตราการไหล CIP' },
    ],
    items: [
      { name: 'Water Tank', desc: 'ถังน้ำ CIP — มี LSH (High Level) และ LSL (Low Level) ควบคุม, State: "30. Stop Fill" เมื่อเต็ม', tag: 'น้ำ' },
      { name: 'Acid Tank (3m³) — Ready', desc: 'ถังน้ำยากรด — Acid Concentrate (C-1001), Temp ~58.9°C, Level ~59%, Status: Ready', tag: 'กรด' },
      { name: 'Caustic Tank (3m³) — Ready', desc: 'ถังน้ำยาด่าง — Caustic Concentrate (C-1101), Temp ~71.2°C (ร้อนกว่ากรด), Level ~59%, Status: Ready', tag: 'ด่าง' },
      { name: 'Recovery Tank (3m³) — Ready', desc: 'ถังรับน้ำยาล้างกลับ — Temp ~36.9°C, Level อาจเกิน 100% เมื่อเต็ม, นำกลับใช้ใหม่', tag: 'รีไซเคิล' },
      { name: 'CIP Master (P)', desc: 'โปรแกรม CIP หลัก — ควบคุม sequence ทั้งหมด, แสดง "CIP Object" ที่กำลังล้างอยู่', tag: 'โปรแกรม' },
      { name: 'CIP Programs', desc: 'โปรแกรมแยกต่างหาก: CIP Caustic Tank / CIP Acid Tank / CIP Recovery Tank — ล้างถัง CIP เอง', tag: 'CIP' },
      { name: 'CIP Pump (17.5 m³/h)', desc: 'ปั๊มหลัก CIP — จ่ายน้ำยาแรงดันสูงล้างอุปกรณ์ทั้งระบบ (Mixing → Pasteurizer → Storage)', tag: 'ปั๊ม' },
      { name: 'Steam S + Caustic/Acid Concentrate', desc: 'ไอน้ำให้ความร้อนน้ำยา / น้ำยาเข้มข้นจ่ายเพิ่มอัตโนมัติ', tag: 'ร้อน' },
    ],
    note: 'CIP Object แสดงว่ากำลังล้างอุปกรณ์ใดอยู่ · Compressed Air + Process Water ใช้ผสมทำความเข้มข้น',
  },
];

const TAG_COLORS: Record<string, { bg: string; color: string }> = {
  ถัง: { bg: '#e3f2fd', color: '#0d47a1' },
  สูตร: { bg: '#fff8e1', color: '#e65100' },
  ส่วนผสม: { bg: '#fce4ec', color: '#880e4f' },
  ปั๊ม: { bg: '#eceff1', color: '#37474f' },
  หมุนเวียน: { bg: '#e8f5e9', color: '#1b5e20' },
  ส่งต่อ: { bg: '#e0f2f1', color: '#004d40' },
  เก็บ: { bg: '#e0f7fa', color: '#00695c' },
  น้ำตาล: { bg: '#fff8e1', color: '#e65100' },
  ผสม: { bg: '#e8f5e9', color: '#2e7d32' },
  ร้อน: { bg: '#fff3e0', color: '#bf360c' },
  ไอน้ำ: { bg: '#f5f5f5', color: '#424242' },
  น้ำ: { bg: '#e3f2fd', color: '#01579b' },
  ซีล: { bg: '#f3e5f5', color: '#6a1b9a' },
  บัฟเฟอร์: { bg: '#ede7f6', color: '#4527a0' },
  โปรแกรม: { bg: '#e8eaf6', color: '#283593' },
  ฆ่าเชื้อ: { bg: '#ffebee', color: '#b71c1c' },
  เย็น: { bg: '#e1f5fe', color: '#01579b' },
  CIP: { bg: '#f3e5f5', color: '#6a1b9a' },
  โดส: { bg: '#fce4ec', color: '#880e4f' },
  รอ: { bg: '#fff9c4', color: '#f57f17' },
  สัญญาณ: { bg: '#e8f5e9', color: '#2e7d32' },
  ระดับ: { bg: '#f1f8e9', color: '#33691e' },
  กรด: { bg: '#fff9c4', color: '#f57f17' },
  ด่าง: { bg: '#e8eaf6', color: '#283593' },
  รีไซเคิล: { bg: '#e8f5e9', color: '#2e7d32' },
};

const Line4Manual: React.FC<Props> = ({ operatorName, onBackToMain }) => {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showParams, setShowParams] = useState<number | null>(null);

  return (
    <div style={{ background: '#f4f6f9', minHeight: '100vh', paddingBottom: '40px' }}>
      <div style={{
        background: 'linear-gradient(135deg, #1b5e20, #2e7d32)',
        color: 'white', padding: '20px 16px 16px',
        borderBottomLeftRadius: '20px', borderBottomRightRadius: '20px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <button onClick={onBackToMain} style={{
            background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white',
            borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', fontSize: '0.8rem',
          }}>← หลัก</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: '700', fontSize: '1.1rem', letterSpacing: '0.02em' }}>คู่มือระบบผลิต Line 4</div>
            <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>GEA Syrup Processing · Mitr Phol Thailand</div>
          </div>
        </div>
        <div style={{
          background: 'rgba(255,255,255,0.15)', borderRadius: '10px',
          padding: '8px 12px', fontSize: '0.72rem', opacity: 0.9,
        }}>
          ผู้ดู: {operatorName} · อ้างอิง GEA HMI — Mixing Tanks / Mixing Station / Pasteurizer and Storage / CIP Kitchen
        </div>
      </div>

      <div style={{ padding: '16px 14px 0' }}>
        <div style={{ fontSize: '0.7rem', color: '#999', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>แผนผังระบบผลิต (Syrup Processing)</div>

        <div style={{ background: '#263238', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px' }}>
          <div style={{ fontSize: '0.6rem', color: '#78909c', marginBottom: '6px', letterSpacing: '0.06em' }}>GEA HMI TABS</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {[
              { tab: 'Mixing Tanks', color: '#01579b' },
              { tab: 'Mixing Station', color: '#1565c0' },
              { tab: 'Pasteurizer and Storage', color: '#b71c1c' },
              { tab: 'CIP Kitchen', color: '#6a1b9a', note: '(CIP Station)' },
            ].map((t) => (
              <div key={t.tab} style={{
                background: t.color, color: 'white', borderRadius: '6px',
                padding: '4px 10px', fontSize: '0.62rem', fontWeight: '600',
              }}>
                {t.tab}{t.note ? <span style={{ opacity: 0.7, marginLeft: '3px' }}>{t.note}</span> : ''}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', gap: '0', paddingBottom: '6px', WebkitOverflowScrolling: 'touch' as any }}>
          {[
            { label: 'IBC Sugar\n+ Process\nWater', color: '#4a7c59' },
            { label: 'Mixing\nStation', color: '#1565c0' },
            { label: 'Mixing\nTanks\n2×3m³', color: '#01579b' },
            { label: 'Bal.\nTank', color: '#7b1fa2' },
            { label: 'Pasteur-\nizer\n70°C', color: '#b71c1c' },
            { label: 'Storage\nTank\n3m³', color: '#004d40' },
            { label: 'Filling\nLine', color: '#37474f' },
          ].map((s, i) => (
            <React.Fragment key={i}>
              <div style={{
                flex: '0 0 auto', textAlign: 'center',
                background: s.color, color: 'white',
                borderRadius: '8px', padding: '6px 8px', minWidth: '52px',
                fontSize: '0.58rem', fontWeight: '700', lineHeight: '1.4',
                whiteSpace: 'pre-line',
              }}>
                {s.label}
              </div>
              {i < 6 && <div style={{ color: '#aaa', fontSize: '0.9rem', flex: '0 0 auto', padding: '0 2px' }}>›</div>}
            </React.Fragment>
          ))}
          <div style={{ flex: '0 0 8px' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#6a1b9a' }} />
          <div style={{ fontSize: '0.63rem', color: '#888' }}>CIP Kitchen (CIP Station) — ล้างทุกส่วนหลังเสร็จงาน: Mixing → Pasteurizer → Storage</div>
        </div>
      </div>

      <div style={{ padding: '12px 14px 0' }}>
        <div style={{ fontSize: '0.7rem', color: '#999', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>รายละเอียดแต่ละส่วน</div>
        {STEPS.map((step) => {
          const isOpen = expanded === step.id;
          const isParam = showParams === step.id;
          return (
            <div key={step.id} style={{
              background: 'white', borderRadius: '14px', marginBottom: '10px',
              boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
              border: `1.5px solid ${isOpen ? step.color : '#eee'}`,
              overflow: 'hidden',
            }}>
              <div
                onClick={() => { setExpanded(isOpen ? null : step.id); if (!isOpen) setShowParams(null); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '13px 14px', cursor: 'pointer',
                  background: isOpen ? step.bgLight : 'white',
                }}
              >
                <div style={{
                  width: '40px', height: '40px', borderRadius: '10px',
                  background: step.color, color: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flex: '0 0 auto',
                }}>
                  {step.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: '700', fontSize: '0.88rem', color: '#222' }}>{step.title}</div>
                  <div style={{ fontSize: '0.6rem', color: '#999', marginTop: '2px' }}>{step.subtitle}</div>
                </div>
                <div style={{
                  color: step.color, fontSize: '1rem', fontWeight: '700',
                  transition: 'transform 0.25s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                }}>▾</div>
              </div>

              {isOpen && (
                <div style={{ borderTop: `1px solid ${step.bgLight}`, padding: '12px 14px 14px' }}>
                  <div
                    onClick={() => setShowParams(isParam ? null : step.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      background: isParam ? step.color : step.bgLight,
                      color: isParam ? 'white' : step.color,
                      borderRadius: '8px', padding: '5px 12px', marginBottom: '12px',
                      cursor: 'pointer', fontSize: '0.7rem', fontWeight: '600',
                    }}
                  >
                    📊 ค่า Setpoint จาก SCADA {isParam ? '▴' : '▾'}
                  </div>

                  {isParam && (
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px',
                      marginBottom: '14px', padding: '10px', background: step.bgLight, borderRadius: '10px',
                    }}>
                      {step.params.map((p, i) => (
                        <div key={i} style={{ background: 'white', borderRadius: '8px', padding: '8px 10px' }}>
                          <div style={{ fontSize: '0.6rem', color: '#999', marginBottom: '2px' }}>{p.label}</div>
                          <div style={{ fontWeight: '700', fontSize: '0.85rem', color: step.color }}>{p.value}</div>
                          {p.note && <div style={{ fontSize: '0.58rem', color: '#aaa', marginTop: '2px' }}>{p.note}</div>}
                        </div>
                      ))}
                    </div>
                  )}

                  {step.items.map((item, idx) => {
                    const tagStyle = TAG_COLORS[item.tag] || { bg: '#f5f5f5', color: '#555' };
                    return (
                      <div key={idx} style={{
                        paddingTop: '10px',
                        borderTop: idx > 0 ? '1px solid #f0f0f0' : 'none',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                          <span style={{
                            flex: '0 0 auto', background: tagStyle.bg, color: tagStyle.color,
                            fontSize: '0.58rem', fontWeight: '700', padding: '2px 7px',
                            borderRadius: '6px', marginTop: '2px',
                          }}>{item.tag}</span>
                          <div>
                            <div style={{ fontWeight: '600', fontSize: '0.82rem', color: '#333', lineHeight: 1.3 }}>{item.name}</div>
                            <div style={{ fontSize: '0.72rem', color: '#666', marginTop: '3px', lineHeight: 1.5 }}>{item.desc}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {step.note && (
                    <div style={{
                      marginTop: '12px', background: '#fffde7', borderLeft: `3px solid ${step.color}`,
                      padding: '8px 10px', borderRadius: '4px', fontSize: '0.7rem', color: '#555',
                    }}>
                      <span style={{ fontWeight: '700', color: step.color }}>หมายเหตุ: </span>
                      {step.note}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ padding: '0 14px', marginTop: '8px' }}>
        <div style={{
          background: '#fff3e0', border: '1px solid #ffe0b2', borderRadius: '12px',
          padding: '12px 14px', fontSize: '0.72rem', color: '#e65100', lineHeight: '1.6',
        }}>
          <div style={{ fontWeight: '700', marginBottom: '4px' }}>⚠️ หน้านี้อยู่ระหว่างการเรียนรู้ระบบ</div>
          ค่าที่แสดงอ้างอิงจาก GEA HMI จริง (Mitr Phol, 10/05/2026) — สามารถแก้ไขเพิ่มเติมได้เมื่อเข้าใจกระบวนการมากขึ้น
        </div>
      </div>
    </div>
  );
};

export default Line4Manual;
