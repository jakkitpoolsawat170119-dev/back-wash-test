import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

interface Props {
  operatorName: string;
  onBackToMain: () => void;
}

interface LearningBlock {
  id: string;
  stepId: number | null;
  type: 'text' | 'image' | 'video';
  title: string;
  content: string;
}

function fromDb(row: Record<string, unknown>): LearningBlock {
  return {
    id: row.id as string,
    stepId: row.step_id as number | null,
    type: row.type as LearningBlock['type'],
    title: (row.title as string) ?? '',
    content: row.content as string,
  };
}

function toDb(block: LearningBlock): Record<string, unknown> {
  return {
    id: block.id,
    step_id: block.stepId,
    type: block.type,
    title: block.title,
    content: block.content,
  };
}

async function uploadToStorage(file: File): Promise<string | null> {
  if (!supabase) return null;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await supabase.storage.from('learning-images').upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) { console.error('Upload error:', error); return null; }
  return supabase.storage.from('learning-images').getPublicUrl(path).data.publicUrl;
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

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getYouTubeId(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^&?\s]{11})/);
  return m ? m[1] : null;
}

// ---- Toast System ----

interface Toast { id: string; msg: string; type: 'success' | 'info' | 'warning'; }

function ToastContainer({ toasts }: { toasts: Toast[] }) {
  return (
    <div style={{
      position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 400, display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '8px', pointerEvents: 'none', width: '92%', maxWidth: '340px',
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          width: '100%',
          background: t.type === 'success' ? '#1b5e20' : t.type === 'warning' ? '#b71c1c' : '#1a237e',
          color: 'white', borderRadius: '14px', padding: '12px 16px',
          fontSize: '0.8rem', fontWeight: '600',
          boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
          animation: 'toastIn 0.35s cubic-bezier(0.34,1.56,0.64,1)',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <span style={{ fontSize: '1rem', flexShrink: 0 }}>
            {t.type === 'success' ? '✅' : t.type === 'warning' ? '⚠️' : '🔔'}
          </span>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ---- EditForm (bottom sheet) ----

interface EditFormProps {
  initial: LearningBlock | null;
  stepId: number | null;
  onSave: (block: LearningBlock) => void;
  onClose: () => void;
}

const TYPE_CONFIG = {
  text: {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
    ),
    label: 'ข้อความ',
    desc: 'บันทึกขั้นตอน',
    color: '#1565c0',
    bg: '#e3f2fd',
    border: '#90caf9',
  },
  image: {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    ),
    label: 'รูปภาพ',
    desc: 'ภาพหน้าจอ / อุปกรณ์',
    color: '#6a1b9a',
    bg: '#f3e5f5',
    border: '#ce93d8',
  },
  video: {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="23 7 16 12 23 17 23 7"/>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
    ),
    label: 'วีดีโอ',
    desc: 'YouTube / คลิป',
    color: '#b71c1c',
    bg: '#ffebee',
    border: '#ef9a9a',
  },
} as const;

const EMOJI_CATEGORIES = [
  {
    label: '😀', name: 'หน้า',
    emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🥴','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥺','😱','😲','😤','😠','😡','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'],
  },
  {
    label: '👋', name: 'มือ/คน',
    emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦵','🦶','👂','👃','👁️','👀','🫶','🫵','🫰','🫱','🫲','🧠','🦷','🦴','👅','👄','🫦'],
  },
  {
    label: '❤️', name: 'ใจ',
    emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','❤️‍🔥','❤️‍🩹','💔','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☯️','🕉️','🛐','🔯','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','🆚','🆕','🆓','🆙','🆒','🆗','🆖','🅰️','🅱️','🆎','🆑'],
  },
  {
    label: '🐶', name: 'สัตว์',
    emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔'],
  },
  {
    label: '🍎', name: 'อาหาร',
    emojis: ['🍎','🍊','🍋','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🍆','🥔','🥕','🌽','🌶️','🥦','🥬','🥒','🧄','🧅','🍄','🥜','🌰','🍞','🥐','🥖','🫓','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🫔','🌮','🌯','🥙','🧆','🥚','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🦪','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🫖','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾'],
  },
  {
    label: '⚽', name: 'กีฬา',
    emojis: ['⚽','🏀','🏈','⚾','🥎','🏐','🏉','🎾','🥏','🎱','🪀','🏓','🏸','🥊','🥅','⛳','🪁','🏹','🎣','🤿','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🏇','🧘','🏄','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🎪','🤹','🎭','🎨','🎬','🎤','🎧','🎼','🎵','🎶','🎷','🎸','🎹','🎺','🎻','🥁','🪘','🎮','🕹️','🎲','♟️'],
  },
  {
    label: '🌍', name: 'สถานที่',
    emojis: ['🌍','🌎','🌏','🌐','🗺️','🧭','🌋','⛰️','🏔️','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🏛️','🏗️','🧱','🏘️','🏚️','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕋','⛲','⛺','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','🎠','🎡','🎢','💈','🎪','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚋','🚌','🚍','🚎','🚐','🚑','🚒','🚓','🚔','🚕','🚖','🚗','🚘','🚙','🛻','🚚','🚛','🚜','🏎️','🏍️','🛵','🛺','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','✈️','🛩️','🚁','🛸','🚀','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢'],
  },
  {
    label: '💡', name: 'วัตถุ',
    emojis: ['💡','🔦','🕯️','🪔','🧯','💰','💴','💵','💶','💷','💸','💳','🪙','💎','⚖️','🧰','🔧','🪛','🔩','⚙️','🗜️','🔗','⛓️','🪝','🧲','🪜','🧪','🧫','🧬','🔬','🔭','📡','💊','🩺','🩻','🩹','🩼','🩺','🩸','🧴','🧷','🧹','🧺','🧻','🪣','🧼','🫧','🪥','🧽','🧯','🛒','🚪','🪞','🪟','🛏️','🛋️','🪑','🚽','🚿','🛁','🪠','🪤','🧸','🪆','🖼️','🪄','🎩','👑','💍','👜','👛','👓','🕶️','🥽','☂️','🧵','🧶','📱','💻','⌨️','🖥️','🖨️','🖱️','🗜️','💾','💿','📀','📷','📸','📹','📼','📞','☎️','📟','📠','📺','📻','🧭','⏱️','⏲️','⏰','🕰️','📡','🔋','🔌','💡','🔦','🕯️','🗑️','🧲','🪜'],
  },
  {
    label: '🌟', name: 'สัญลักษณ์',
    emojis: ['⭐','🌟','✨','💫','🌠','🔥','💥','❄️','🌈','☁️','⛅','🌤️','🌥️','🌦️','🌧️','⛈️','🌩️','🌨️','🌪️','🌫️','🌬️','🌀','🌊','💧','💦','☔','⚡','🌙','☀️','🌤️','🌈','⛱️','✅','❎','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔲','🔳','▪️','▫️','◾','◽','◼️','◻️','⬛','⬜','🟥','🟧','🟨','🟩','🟦','🟪','🟫','⁉️','‼️','❓','❔','❕','❗','🔅','🔆','🔱','⚜️','🔰','♻️','✅','🈴','🈵','🈹','🈲','🉐','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💯','🈹','📵','🔞','🔃','🔄','🔙','🔚','🔛','🔜','🔝'],
  },
];

function EditForm({ initial, stepId, onSave, onClose }: EditFormProps) {
  const [type, setType] = useState<LearningBlock['type']>(initial?.type ?? 'text');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadMsg, setUploadMsg] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState(0);
  const [showBlockMenu, setShowBlockMenu] = useState(false);
  const [blockMenuSearch, setBlockMenuSearch] = useState('');
  const [insertPanel, setInsertPanel] = useState<'image' | 'video' | null>(null);
  const slashTriggered = useRef(false);
  const [insertUrl, setInsertUrl] = useState('');
  const [insertUploading, setInsertUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoFileRef = useRef<HTMLInputElement>(null);
  const inlineFileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const editorInitialized = useRef(false);
  const savedRange = useRef<Range | null>(null);

  const cfg = TYPE_CONFIG[type];
  const ytId = type === 'video' ? getYouTubeId(content) : null;
  const charCount = content.length;

  // Initialize contentEditable from content state (run once per type switch)
  useEffect(() => {
    if (type === 'text' && editorRef.current && !editorInitialized.current) {
      editorRef.current.innerHTML = content;
      editorInitialized.current = true;
    }
    if (type !== 'text') editorInitialized.current = false;
  });

  const execCmd = (cmd: string, val?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, val ?? undefined);
    setTimeout(() => {
      if (editorRef.current) setContent(editorRef.current.innerHTML);
    }, 0);
  };

  const saveRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) savedRange.current = sel.getRangeAt(0).cloneRange();
  };

  const restoreRange = () => {
    if (!savedRange.current) return;
    editorRef.current?.focus();
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(savedRange.current); }
  };

  const openInsertPanel = (kind: 'image' | 'video') => {
    saveRange();
    setInsertUrl('');
    setInsertPanel(kind);
    setShowEmojiPicker(false);
    setShowBlockMenu(false);
    setBlockMenuSearch('');
  };

  const closeInsertPanel = () => { setInsertPanel(null); setInsertUrl(''); };

  const toggleEmojiPicker = () => {
    if (!showEmojiPicker) saveRange();
    setShowEmojiPicker(v => !v);
    setInsertPanel(null);
    setInsertUrl('');
    setShowBlockMenu(false);
    setBlockMenuSearch('');
  };

  const insertEmoji = (emoji: string) => {
    restoreRange();
    execCmd('insertText', emoji);
    editorRef.current?.focus();
  };

  const BLOCK_TYPES = [
    { id: 'todo',    icon: '☑️',  label: 'To-do list',      desc: 'รายการงาน checkbox',       shortcut: '/todo' },
    { id: 'toggle',  icon: '▶',   label: 'Toggle list',     desc: 'รายการซ่อน/แสดงได้',       shortcut: '/toggle' },
    { id: 'callout', icon: '💡',  label: 'Callout',         desc: 'กล่องเน้นข้อความ',          shortcut: '/callout' },
    { id: 'table',   icon: '⊞',   label: 'Table',           desc: 'ตาราง 3×3',                 shortcut: '/table' },
    { id: 'h1tog',   icon: '▶H₁', label: 'Toggle heading 1',desc: 'หัวข้อใหญ่ ซ่อน/แสดงได้',  shortcut: '/h1>' },
    { id: 'h2tog',   icon: '▶H₂', label: 'Toggle heading 2',desc: 'หัวข้อกลาง ซ่อน/แสดงได้', shortcut: '/h2>' },
    { id: 'cols2',   icon: '⬜⬜', label: '2 columns',       desc: 'แบ่ง 2 คอลัมน์',           shortcut: '/2col' },
    { id: 'cols3',   icon: '⬜⬜⬜',label: '3 columns',       desc: 'แบ่ง 3 คอลัมน์',           shortcut: '/3col' },
  ];

  const insertBlockType = (blockId: string) => {
    const htmlMap: Record<string, string> = {
      todo:    `<ul class="l4-todo"><li class="l4-todo-item"><input type="checkbox"><span class="l4-todo-text"> งานที่ต้องทำ</span></li><li class="l4-todo-item"><input type="checkbox"><span class="l4-todo-text"> อีกรายการ</span></li></ul><p><br></p>`,
      toggle:  `<details class="l4-toggle"><summary class="l4-toggle-sum">คลิกเพื่อขยาย...</summary><div class="l4-toggle-body"><p>เนื้อหาภายใน</p></div></details><p><br></p>`,
      callout: `<div class="l4-callout"><span class="l4-callout-ico">💡</span><span class="l4-callout-txt">ใส่ข้อความที่ต้องการเน้น</span></div><p><br></p>`,
      table:   `<table class="l4-tbl"><thead><tr><th>หัวคอลัมน์ 1</th><th>หัวคอลัมน์ 2</th><th>หัวคอลัมน์ 3</th></tr></thead><tbody><tr><td></td><td></td><td></td></tr><tr><td></td><td></td><td></td></tr><tr><td></td><td></td><td></td></tr></tbody></table><p><br></p>`,
      h1tog:   `<details class="l4-toggle l4-toggle-h1"><summary class="l4-toggle-sum"><h1>Toggle Heading 1</h1></summary><div class="l4-toggle-body"><p>เนื้อหาภายใน</p></div></details><p><br></p>`,
      h2tog:   `<details class="l4-toggle l4-toggle-h2"><summary class="l4-toggle-sum"><h2>Toggle Heading 2</h2></summary><div class="l4-toggle-body"><p>เนื้อหาภายใน</p></div></details><p><br></p>`,
      cols2:   `<div class="l4-cols l4-cols-2"><div class="l4-col"><p>คอลัมน์ 1</p></div><div class="l4-col"><p>คอลัมน์ 2</p></div></div><p><br></p>`,
      cols3:   `<div class="l4-cols l4-cols-3"><div class="l4-col"><p>คอลัมน์ 1</p></div><div class="l4-col"><p>คอลัมน์ 2</p></div><div class="l4-col"><p>คอลัมน์ 3</p></div></div><p><br></p>`,
    };
    const html = htmlMap[blockId];
    if (!html) return;
    if (slashTriggered.current) {
      // delete the '/' char that opened the menu
      document.execCommand('delete', false);
      slashTriggered.current = false;
    } else {
      restoreRange();
    }
    execCmd('insertHTML', html);
    setShowBlockMenu(false);
    setBlockMenuSearch('');
  };

  const openBlockMenu = (fromSlash = false) => {
    if (!fromSlash) saveRange();
    slashTriggered.current = fromSlash;
    setBlockMenuSearch('');
    setShowBlockMenu(true);
    setShowEmojiPicker(false);
    setInsertPanel(null);
    setInsertUrl('');
  };

  const insertImageHtml = (src: string) => {
    const html = `<img src="${src}" style="max-width:100%;border-radius:8px;margin:8px 0;display:block;" alt="" /><p><br></p>`;
    restoreRange();
    execCmd('insertHTML', html);
    closeInsertPanel();
  };

  const insertVideoHtml = (url: string) => {
    const ytId = getYouTubeId(url);
    let html: string;
    if (ytId) {
      html = `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:10px;margin:8px 0;"><iframe src="https://www.youtube.com/embed/${ytId}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" allowfullscreen></iframe></div><p><br></p>`;
    } else {
      html = `<video src="${url}" controls style="max-width:100%;border-radius:8px;margin:8px 0;display:block;"></video><p><br></p>`;
    }
    restoreRange();
    execCmd('insertHTML', html);
    closeInsertPanel();
  };

  const handleInlineImageFile = async (file: File) => {
    setInsertUploading(true);
    let src: string | null = null;
    if (supabase) {
      src = await uploadToStorage(file);
    } else {
      src = await new Promise((res) => {
        const reader = new FileReader();
        reader.onload = (ev) => res(ev.target?.result as string);
        reader.readAsDataURL(file);
      });
    }
    setInsertUploading(false);
    if (src) insertImageHtml(src);
    else alert('อัปโหลดรูปไม่สำเร็จ');
  };

  const startFakeProgress = (msg: string) => {
    setUploadMsg(msg);
    setUploadPct(0);
    let pct = 0;
    const iv = setInterval(() => {
      pct += Math.random() * 12;
      if (pct >= 88) { clearInterval(iv); pct = 88; }
      setUploadPct(Math.round(pct));
    }, 200);
    return iv;
  };

  const finishProgress = (iv: ReturnType<typeof setInterval>) => {
    clearInterval(iv);
    setUploadPct(100);
    setTimeout(() => { setUploading(false); setUploadPct(0); setUploadMsg(''); }, 600);
  };

  const handleFileUpload = async (file: File) => {
    if (supabase) {
      setUploading(true);
      const iv = startFakeProgress('กำลังอัปโหลดรูปภาพ...');
      const url = await uploadToStorage(file);
      finishProgress(iv);
      if (url) setContent(url);
      else alert('อัปโหลดไม่สำเร็จ กรุณาลองใหม่หรือใช้ URL แทน');
    } else {
      if (file.size > 3 * 1024 * 1024) { alert('รูปขนาดใหญ่เกิน 3MB — กรุณาใช้ URL แทน'); return; }
      const reader = new FileReader();
      reader.onload = (ev) => setContent(ev.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleVideoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!supabase) { alert('ต้องเชื่อมต่อ Supabase ก่อนอัปโหลดวีดีโอ'); return; }
    if (file.size > 100 * 1024 * 1024) {
      alert('วีดีโอขนาดใหญ่เกิน 100MB\nกรุณาตัดให้สั้นลง หรืออัปโหลดไป YouTube แล้วใช้ URL แทน');
      return;
    }
    setUploading(true);
    const mb = (file.size / 1024 / 1024).toFixed(1);
    const iv = startFakeProgress(`อัปโหลดวีดีโอ (${mb} MB)...`);
    const url = await uploadToStorage(file);
    finishProgress(iv);
    if (url) setContent(url);
    else alert('อัปโหลดวีดีโอไม่สำเร็จ กรุณาลองใหม่');
  };

  const handleSave = () => {
    const textContent = type === 'text'
      ? (editorRef.current?.textContent ?? content).trim()
      : content.trim();
    if (!textContent) { alert('กรุณาใส่เนื้อหา'); return; }
    const finalContent = type === 'text'
      ? (editorRef.current?.innerHTML ?? content).trim()
      : content.trim();
    setSaved(true);
    setTimeout(() => {
      onSave({ id: initial?.id ?? genId(), stepId, type, title: title.trim(), content: finalContent });
    }, 300);
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 200, backdropFilter: 'blur(2px)' }} />
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 201,
        background: 'white', borderTopLeftRadius: '24px', borderTopRightRadius: '24px',
        padding: '0 0 env(safe-area-inset-bottom, 24px)', maxHeight: '92vh', overflowY: 'auto',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.22)',
        animation: 'slideUp 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}>
        <style>{`
          @keyframes slideUp {
            from { transform: translateY(100%); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          @keyframes fadeIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
          @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
          .ef-type-btn:active { transform: scale(0.96); }
          .ef-save:active { transform: scale(0.98); }
          .ef-toolbar-btn:hover { background: #e8f5e9 !important; }
          .ef-toolbar-btn:active { transform: scale(0.9); }
        `}</style>

        {/* Handle bar */}
        <div style={{ padding: '12px 16px 0', textAlign: 'center' }}>
          <div style={{ width: '36px', height: '4px', background: '#e0e0e0', borderRadius: '2px', margin: '0 auto' }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '32px', height: '32px', borderRadius: '8px',
              background: cfg.bg, color: cfg.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {cfg.icon}
            </div>
            <div>
              <div style={{ fontWeight: '700', fontSize: '1rem', color: '#111', lineHeight: 1.2 }}>
                {initial ? 'แก้ไขเนื้อหา' : 'เพิ่มเนื้อหา'}
              </div>
              {stepId && <div style={{ fontSize: '0.62rem', color: '#aaa', marginTop: '1px' }}>แนบกับขั้นตอน #{stepId}</div>}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: '#f5f5f5', border: 'none', borderRadius: '20px',
            padding: '7px 16px', cursor: 'pointer', color: '#555', fontSize: '0.78rem', fontWeight: '600',
          }}>ยกเลิก</button>
        </div>

        <div style={{ padding: '0 14px 28px' }}>

          {/* Type selector — card grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '16px' }}>
            {(Object.entries(TYPE_CONFIG) as [LearningBlock['type'], typeof TYPE_CONFIG.text][]).map(([t, c]) => (
              <button
                key={t}
                className="ef-type-btn"
                onClick={() => { setType(t); if (t !== initial?.type) setContent(''); }}
                style={{
                  padding: '12px 6px', borderRadius: '14px',
                  border: `2px solid ${type === t ? c.color : '#eee'}`,
                  background: type === t ? c.bg : '#fafafa',
                  color: type === t ? c.color : '#999',
                  cursor: 'pointer', transition: 'all 0.18s ease',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px',
                  boxShadow: type === t ? `0 2px 10px ${c.color}22` : 'none',
                }}
              >
                <div style={{ color: type === t ? c.color : '#bbb', transition: 'color 0.18s' }}>{c.icon}</div>
                <div style={{ fontWeight: '700', fontSize: '0.78rem' }}>{c.label}</div>
                <div style={{ fontSize: '0.6rem', opacity: 0.7, lineHeight: 1.2, textAlign: 'center' }}>{c.desc}</div>
                {type === t && (
                  <div style={{
                    width: '20px', height: '3px', borderRadius: '2px',
                    background: c.color, marginTop: '2px',
                  }} />
                )}
              </button>
            ))}
          </div>

          {/* Title input — hidden for text type (integrated into doc editor) */}
          {type !== 'text' && (
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '0.7rem', color: '#888', fontWeight: '700', letterSpacing: '0.05em', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
                หัวข้อ <span style={{ fontWeight: '400', textTransform: 'none', letterSpacing: 0 }}>(ไม่บังคับ)</span>
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="เช่น ขั้นตอนการ CIP, ตำแหน่งวาล์ว..."
                style={{
                  width: '100%', padding: '11px 13px', borderRadius: '12px',
                  border: `1.5px solid ${title ? cfg.border : '#e8e8e8'}`,
                  fontSize: '0.88rem', boxSizing: 'border-box', outline: 'none',
                  fontFamily: 'inherit', transition: 'border-color 0.18s',
                  background: title ? cfg.bg + '55' : 'white',
                }}
              />
            </div>
          )}

          {/* Content area */}
          <div style={{ marginBottom: '16px' }}>
            {type !== 'text' && (
              <label style={{ fontSize: '0.7rem', color: '#888', fontWeight: '700', letterSpacing: '0.05em', textTransform: 'uppercase', display: 'block', marginBottom: '6px' }}>
                {type === 'image' ? 'รูปภาพ' : 'วีดีโอ'}
              </label>
            )}

            {type === 'text' && (
              <div style={{
                border: '1.5px solid #e8e8e8', borderRadius: '16px', overflow: 'hidden',
                background: 'white', boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
              }}>
                <style>{`
                  .l4-doc-title::placeholder { color: #ccc; }
                  .l4-doc-body:empty::before { content: attr(data-placeholder); color: #ccc; pointer-events: none; }
                  .l4-doc-body:focus { outline: none; }
                  .l4-doc-body h1 { font-size: 1.35rem; font-weight: 700; margin: 6px 0 2px; line-height: 1.3; }
                  .l4-doc-body h2 { font-size: 1.05rem; font-weight: 700; margin: 6px 0 2px; line-height: 1.3; }
                  .l4-doc-body h3 { font-size: 0.92rem; font-weight: 700; margin: 4px 0 2px; }
                  .l4-doc-body ul { padding-left: 1.4em; margin: 4px 0; }
                  .l4-doc-body ol { padding-left: 1.4em; margin: 4px 0; }
                  .l4-doc-body li { margin: 3px 0; line-height: 1.65; }
                  .l4-doc-body blockquote { border-left: 3px solid #4caf50; padding: 4px 0 4px 12px; color: #666; margin: 8px 0; }
                  .l4-doc-body b, .l4-doc-body strong { font-weight: 700; }
                  .l4-doc-body i, .l4-doc-body em { font-style: italic; }
                  .l4-doc-body p { margin: 0 0 6px; }
                  .l4-doc-body p:last-child { margin-bottom: 0; }
                  .l4-tb-btn { background: none; border: none; cursor: pointer; padding: 6px 8px; border-radius: 6px; font-size: 0.78rem; color: #555; transition: background 0.12s; display: flex; align-items: center; gap: 3px; }
                  .l4-tb-btn:hover { background: #f0f0f0; }
                  .l4-tb-btn:active { background: #e0e0e0; }
                  .l4-tb-btn.active { background: #e8f5e9; color: #2e7d32; }
                  .l4-tb-divider { width: 1px; height: 20px; background: #e8e8e8; margin: 0 2px; flex-shrink: 0; align-self: center; }
                  .l4-doc-body img { max-width: 100%; border-radius: 8px; margin: 8px 0; display: block; }
                  .l4-doc-body video { max-width: 100%; border-radius: 8px; margin: 8px 0; display: block; }
                  .l4-doc-body iframe { border: none; border-radius: 10px; }
                  /* Callout */
                  .l4-callout { background: #f0fdf4; border-left: 3px solid #4caf50; border-radius: 8px; padding: 10px 14px; margin: 8px 0; display: flex; gap: 8px; align-items: flex-start; }
                  .l4-callout-ico { font-size: 1rem; flex-shrink: 0; margin-top: 1px; }
                  .l4-callout-txt { flex: 1; line-height: 1.65; }
                  /* Table */
                  .l4-tbl { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 0.83rem; }
                  .l4-tbl th { background: #f5f5f5; font-weight: 700; padding: 7px 10px; border: 1px solid #ddd; text-align: left; }
                  .l4-tbl td { padding: 6px 10px; border: 1px solid #ddd; min-width: 70px; }
                  /* To-do */
                  .l4-todo { list-style: none; padding-left: 0; margin: 4px 0; }
                  .l4-todo-item { display: flex; align-items: baseline; gap: 7px; padding: 3px 0; }
                  .l4-todo-item input[type="checkbox"] { cursor: pointer; flex-shrink: 0; }
                  .l4-todo-text { line-height: 1.6; }
                  /* Toggle */
                  .l4-toggle { margin: 6px 0; }
                  .l4-toggle-sum { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 5px; padding: 4px 0; font-weight: 600; }
                  .l4-toggle-sum::-webkit-details-marker { display: none; }
                  .l4-toggle-sum::before { content: "▶"; font-size: 0.6rem; color: #4caf50; transition: transform 0.15s; flex-shrink: 0; }
                  .l4-toggle[open] .l4-toggle-sum::before { transform: rotate(90deg); }
                  .l4-toggle-body { padding: 4px 0 4px 18px; border-left: 2px solid #e8f5e9; margin-left: 5px; }
                  .l4-toggle-h1 .l4-toggle-sum { font-size: 1.1rem; }
                  .l4-toggle-h2 .l4-toggle-sum { font-size: 0.95rem; }
                  /* Columns */
                  .l4-cols { display: flex; gap: 10px; margin: 8px 0; }
                  .l4-col { flex: 1; min-width: 0; padding: 8px 10px; border: 1.5px dashed #ddd; border-radius: 8px; min-height: 44px; }
                  .l4-cols-3 .l4-col { font-size: 0.85rem; }
                  /* Block menu */
                  .l4-block-menu { background: #fff; border-top: 1px solid #e8e8e8; max-height: 280px; overflow-y: auto; }
                  .l4-bm-item { display: flex; align-items: center; gap: 10px; padding: 8px 14px; cursor: pointer; border: none; background: none; width: 100%; text-align: left; transition: background 0.1s; }
                  .l4-bm-item:hover { background: #f5f5f5; }
                  .l4-bm-icon { width: 30px; height: 30px; border-radius: 7px; background: #f0f0f0; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; flex-shrink: 0; font-weight: 700; color: #444; }
                  .l4-bm-label { font-size: 0.82rem; font-weight: 600; color: #222; }
                  .l4-bm-desc { font-size: 0.68rem; color: #999; margin-top: 1px; }
                  .l4-bm-shortcut { margin-left: auto; font-size: 0.62rem; color: #bbb; font-family: monospace; flex-shrink: 0; }
                  .l4-insert-panel { background: #f8faf8; border-top: 1px solid #e8e8e8; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }
                  .l4-insert-input { border: 1.5px solid #ddd; border-radius: 8px; padding: 8px 10px; font-size: 0.82rem; font-family: inherit; width: 100%; box-sizing: border-box; outline: none; }
                  .l4-insert-input:focus { border-color: #4caf50; }
                  .l4-insert-confirm { background: #4caf50; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 0.82rem; font-weight: 700; cursor: pointer; }
                  .l4-insert-confirm:hover { background: #388e3c; }
                  .l4-insert-cancel { background: none; border: none; color: #999; font-size: 0.78rem; cursor: pointer; padding: 4px 8px; }
                  .l4-emoji-panel { background: #fff; border-top: 1px solid #e8e8e8; }
                  .l4-emoji-cats { display: flex; gap: 0; overflow-x: auto; background: #f5f5f5; border-bottom: 1px solid #e8e8e8; }
                  .l4-emoji-cat-btn { background: none; border: none; padding: 7px 10px; cursor: pointer; font-size: 1rem; opacity: 0.5; border-bottom: 2px solid transparent; transition: all 0.12s; flex-shrink: 0; }
                  .l4-emoji-cat-btn.active { opacity: 1; border-bottom-color: #4caf50; }
                  .l4-emoji-cat-btn:hover { opacity: 0.85; background: #ececec; }
                  .l4-emoji-grid { display: flex; flex-wrap: wrap; gap: 2px; padding: 8px 10px; max-height: 160px; overflow-y: auto; }
                  .l4-emoji-item { background: none; border: none; font-size: 1.25rem; padding: 4px 5px; cursor: pointer; border-radius: 6px; line-height: 1; transition: background 0.1s; }
                  .l4-emoji-item:hover { background: #f0f0f0; }
                  .l4-emoji-item:active { background: #e0e0e0; transform: scale(0.9); }
                `}</style>

                {/* Document title */}
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="ชื่อหัวข้อ..."
                  className="l4-doc-title"
                  style={{
                    width: '100%', padding: '18px 18px 8px', border: 'none', outline: 'none',
                    fontSize: '1.3rem', fontWeight: '700', fontFamily: 'inherit',
                    boxSizing: 'border-box', background: 'transparent', color: '#111',
                    letterSpacing: '-0.01em',
                  }}
                />

                {/* Toolbar */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '2px',
                  padding: '4px 10px', borderTop: '1px solid #f0f0f0', borderBottom: '1px solid #f0f0f0',
                  background: '#fafafa', overflowX: 'auto', WebkitOverflowScrolling: 'touch' as React.CSSProperties['WebkitOverflowScrolling'],
                }}>
                  {/* Heading */}
                  <button className="l4-tb-btn" title="หัวข้อใหญ่ (H1)" onClick={() => execCmd('formatBlock', 'h1')}>
                    <span style={{ fontWeight: '800', fontSize: '0.85rem' }}>H1</span>
                  </button>
                  <button className="l4-tb-btn" title="หัวข้อ (H2)" onClick={() => execCmd('formatBlock', 'h2')}>
                    <span style={{ fontWeight: '700', fontSize: '0.75rem' }}>H2</span>
                  </button>
                  <button className="l4-tb-btn" title="ย่อหน้าปกติ" onClick={() => execCmd('formatBlock', 'p')}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M13 4v16"/><path d="M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/></svg>
                  </button>
                  <div className="l4-tb-divider" />
                  {/* Inline */}
                  <button className="l4-tb-btn" title="ตัวหนา" onClick={() => execCmd('bold')}>
                    <span style={{ fontWeight: '800' }}>B</span>
                  </button>
                  <button className="l4-tb-btn" title="ตัวเอียง" onClick={() => execCmd('italic')}>
                    <span style={{ fontStyle: 'italic', fontWeight: '600' }}>I</span>
                  </button>
                  <button className="l4-tb-btn" title="ขีดเส้นใต้" onClick={() => execCmd('underline')}>
                    <span style={{ textDecoration: 'underline', fontWeight: '600' }}>U</span>
                  </button>
                  <div className="l4-tb-divider" />
                  {/* Lists */}
                  <button className="l4-tb-btn" title="รายการ bullet" onClick={() => execCmd('insertUnorderedList')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
                  </button>
                  <button className="l4-tb-btn" title="รายการลำดับ" onClick={() => execCmd('insertOrderedList')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>
                  </button>
                  <div className="l4-tb-divider" />
                  {/* Quote */}
                  <button className="l4-tb-btn" title="blockquote" onClick={() => execCmd('formatBlock', 'blockquote')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity="0.6"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1zm12 0c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
                  </button>
                  <div className="l4-tb-divider" />
                  {/* Emoji */}
                  <button
                    className={`l4-tb-btn${showEmojiPicker ? ' active' : ''}`}
                    title="แทรกอิโมจิ"
                    onClick={toggleEmojiPicker}
                  >
                    <span style={{ fontSize: '0.95rem', lineHeight: 1 }}>😊</span>
                  </button>
                  <div className="l4-tb-divider" />
                  {/* Insert image */}
                  <button
                    className={`l4-tb-btn${insertPanel === 'image' ? ' active' : ''}`}
                    title="แทรกรูปภาพ"
                    onClick={() => insertPanel === 'image' ? closeInsertPanel() : openInsertPanel('image')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  </button>
                  {/* Insert video */}
                  <button
                    className={`l4-tb-btn${insertPanel === 'video' ? ' active' : ''}`}
                    title="แทรกวีดีโอ"
                    onClick={() => insertPanel === 'video' ? closeInsertPanel() : openInsertPanel('video')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  </button>
                  <div className="l4-tb-divider" />
                  {/* Block menu */}
                  <button
                    className={`l4-tb-btn${showBlockMenu ? ' active' : ''}`}
                    title="เพิ่มบล็อก (หรือพิมพ์ /)"
                    onClick={() => showBlockMenu ? (setShowBlockMenu(false), setBlockMenuSearch('')) : openBlockMenu()}
                    style={{ fontWeight: '800', fontSize: '1rem', color: showBlockMenu ? '#2e7d32' : '#555' }}
                  >+</button>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: '0.6rem', color: '#bbb', flexShrink: 0 }}>
                    {editorRef.current?.textContent?.length ?? charCount} ตัว
                  </span>
                </div>

                {/* Emoji picker panel */}
                {showEmojiPicker && (
                  <div className="l4-emoji-panel">
                    <div className="l4-emoji-cats">
                      {EMOJI_CATEGORIES.map((cat, i) => (
                        <button
                          key={i}
                          className={`l4-emoji-cat-btn${emojiCategory === i ? ' active' : ''}`}
                          title={cat.name}
                          onClick={() => setEmojiCategory(i)}
                        >{cat.label}</button>
                      ))}
                    </div>
                    <div style={{ padding: '4px 10px 2px', fontSize: '0.65rem', color: '#aaa', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {EMOJI_CATEGORIES[emojiCategory].name}
                    </div>
                    <div className="l4-emoji-grid">
                      {EMOJI_CATEGORIES[emojiCategory].emojis.map((em, i) => (
                        <button
                          key={i}
                          className="l4-emoji-item"
                          onClick={() => insertEmoji(em)}
                        >{em}</button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Block menu panel */}
                {showBlockMenu && (
                  <div className="l4-block-menu">
                    <div style={{ padding: '8px 14px 4px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #f0f0f0' }}>
                      <span style={{ fontSize: '0.65rem', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>เพิ่มบล็อก</span>
                      <input
                        autoFocus
                        value={blockMenuSearch}
                        onChange={e => setBlockMenuSearch(e.target.value)}
                        placeholder="ค้นหา..."
                        style={{ flex: 1, border: 'none', outline: 'none', fontSize: '0.8rem', fontFamily: 'inherit', background: 'transparent', color: '#333' }}
                        onKeyDown={e => {
                          if (e.key === 'Escape') { setShowBlockMenu(false); setBlockMenuSearch(''); }
                        }}
                      />
                      <button onClick={() => { setShowBlockMenu(false); setBlockMenuSearch(''); }} style={{ background: 'none', border: 'none', color: '#bbb', cursor: 'pointer', fontSize: '0.8rem', padding: '2px' }}>✕</button>
                    </div>
                    {BLOCK_TYPES.filter(bt =>
                      !blockMenuSearch || bt.label.toLowerCase().includes(blockMenuSearch.toLowerCase()) || bt.desc.toLowerCase().includes(blockMenuSearch.toLowerCase())
                    ).map(bt => (
                      <button key={bt.id} className="l4-bm-item" onClick={() => insertBlockType(bt.id)}>
                        <div className="l4-bm-icon">{bt.icon}</div>
                        <div>
                          <div className="l4-bm-label">{bt.label}</div>
                          <div className="l4-bm-desc">{bt.desc}</div>
                        </div>
                        <span className="l4-bm-shortcut">{bt.shortcut}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Insert panel */}
                {insertPanel && (
                  <div className="l4-insert-panel">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: '700', color: '#555' }}>
                        {insertPanel === 'image' ? 'แทรกรูปภาพ' : 'แทรกวีดีโอ'}
                      </span>
                      <button className="l4-insert-cancel" onClick={closeInsertPanel}>ยกเลิก</button>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input
                        className="l4-insert-input"
                        placeholder={insertPanel === 'image' ? 'URL รูปภาพ (https://...)' : 'URL วีดีโอ YouTube หรือลิงก์วีดีโอ'}
                        value={insertUrl}
                        onChange={e => setInsertUrl(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && insertUrl.trim()) {
                            e.preventDefault();
                            insertPanel === 'image' ? insertImageHtml(insertUrl.trim()) : insertVideoHtml(insertUrl.trim());
                          }
                        }}
                      />
                      <button
                        className="l4-insert-confirm"
                        disabled={!insertUrl.trim() || insertUploading}
                        onClick={() => insertPanel === 'image' ? insertImageHtml(insertUrl.trim()) : insertVideoHtml(insertUrl.trim())}
                      >
                        แทรก
                      </button>
                    </div>
                    {insertPanel === 'image' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '0.7rem', color: '#aaa' }}>หรือ</span>
                        <button
                          onClick={() => inlineFileRef.current?.click()}
                          disabled={insertUploading}
                          style={{ background: 'none', border: '1.5px dashed #bbb', borderRadius: '8px', padding: '5px 12px', fontSize: '0.75rem', color: '#666', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                          {insertUploading ? 'กำลังอัปโหลด...' : 'อัปโหลดจากเครื่อง'}
                        </button>
                        <input
                          ref={inlineFileRef}
                          type="file"
                          accept="image/*"
                          style={{ display: 'none' }}
                          onChange={async e => {
                            const file = e.target.files?.[0];
                            if (file) await handleInlineImageFile(file);
                            e.target.value = '';
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* ContentEditable body */}
                <div
                  ref={editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  className="l4-doc-body"
                  data-placeholder="เริ่มเขียนที่นี่... กด Enter เพื่อขึ้นบรรทัดใหม่"
                  onInput={() => { if (editorRef.current) setContent(editorRef.current.innerHTML); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Tab') { e.preventDefault(); execCmd('insertHTML', '&nbsp;&nbsp;&nbsp;&nbsp;'); }
                    if (e.key === '/' && !showBlockMenu) { openBlockMenu(true); }
                    if (e.key === 'Escape' && showBlockMenu) { setShowBlockMenu(false); setBlockMenuSearch(''); slashTriggered.current = false; }
                  }}
                  style={{
                    minHeight: '180px', padding: '12px 18px 18px',
                    fontSize: '0.9rem', lineHeight: '1.78',
                    fontFamily: 'inherit', color: '#222',
                    wordBreak: 'break-word',
                  }}
                />
              </div>
            )}

            {type === 'image' && (
              <div>
                {/* Drag & drop zone */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={async (e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files[0];
                    if (file && file.type.startsWith('image/')) handleFileUpload(file);
                  }}
                  onClick={() => fileRef.current?.click()}
                  style={{
                    border: `2px dashed ${dragOver ? cfg.color : content ? cfg.border : '#ddd'}`,
                    borderRadius: '14px', padding: '20px 16px', textAlign: 'center',
                    cursor: 'pointer', background: dragOver ? cfg.bg : content ? cfg.bg + '44' : '#fafafa',
                    transition: 'all 0.18s ease', marginBottom: '10px',
                  }}
                >
                  {content ? (
                    <div style={{ animation: 'fadeIn 0.3s ease' }}>
                      <img
                        src={content}
                        alt="preview"
                        style={{ maxWidth: '100%', maxHeight: '200px', borderRadius: '10px', objectFit: 'contain' }}
                      />
                      <div style={{ fontSize: '0.7rem', color: cfg.color, marginTop: '8px', fontWeight: '600' }}>
                        กดเพื่อเปลี่ยนรูป
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ color: dragOver ? cfg.color : '#ccc', marginBottom: '8px' }}>
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                          <circle cx="8.5" cy="8.5" r="1.5"/>
                          <polyline points="21 15 16 10 5 21"/>
                        </svg>
                      </div>
                      <div style={{ fontWeight: '700', fontSize: '0.82rem', color: dragOver ? cfg.color : '#666' }}>
                        {dragOver ? 'ปล่อยเพื่ออัปโหลด' : 'ลากรูปมาวางที่นี่'}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: '#aaa', marginTop: '4px' }}>หรือกดเพื่อเลือกจากเครื่อง</div>
                    </>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }} style={{ display: 'none' }} />

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <div style={{ flex: 1, height: '1px', background: '#eee' }} />
                  <span style={{ fontSize: '0.68rem', color: '#bbb' }}>หรือใช้ URL</span>
                  <div style={{ flex: 1, height: '1px', background: '#eee' }} />
                </div>
                <input
                  value={content.startsWith('data:') ? '' : content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="https://example.com/image.jpg"
                  style={{
                    width: '100%', padding: '10px 13px', borderRadius: '10px',
                    border: '1.5px solid #e8e8e8', fontSize: '0.82rem',
                    boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit', color: '#555',
                  }}
                />
              </div>
            )}

            {type === 'video' && (
              <div>
                <div style={{ position: 'relative' }}>
                  <input
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="https://youtube.com/watch?v=... หรือ URL วีดีโอตรง"
                    style={{
                      width: '100%', padding: '12px 13px', paddingRight: ytId ? '44px' : '13px',
                      borderRadius: '12px', border: `1.5px solid ${ytId ? '#ef9a9a' : '#e8e8e8'}`,
                      fontSize: '0.86rem', boxSizing: 'border-box', outline: 'none',
                      fontFamily: 'inherit', transition: 'border-color 0.18s',
                      background: ytId ? '#fff5f5' : 'white',
                    }}
                  />
                  {ytId && (
                    <div style={{
                      position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                      background: '#ff0000', color: 'white', borderRadius: '4px',
                      padding: '2px 5px', fontSize: '0.55rem', fontWeight: '700',
                    }}>YT</div>
                  )}
                </div>

                {ytId && (
                  <div style={{ marginTop: '10px', borderRadius: '12px', overflow: 'hidden', animation: 'fadeIn 0.3s ease', position: 'relative' }}>
                    <img
                      src={`https://img.youtube.com/vi/${ytId}/mqdefault.jpg`}
                      alt="YouTube thumbnail"
                      style={{ width: '100%', display: 'block', borderRadius: '12px' }}
                    />
                    <div style={{
                      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'rgba(0,0,0,0.3)', borderRadius: '12px',
                    }}>
                      <div style={{
                        width: '44px', height: '44px', background: '#ff0000', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
                      }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      </div>
                    </div>
                    <div style={{
                      position: 'absolute', bottom: '8px', left: '8px',
                      background: 'rgba(0,0,0,0.7)', color: 'white', borderRadius: '6px',
                      padding: '3px 8px', fontSize: '0.65rem', fontWeight: '600',
                    }}>ID: {ytId}</div>
                  </div>
                )}

                {content && !ytId && content.startsWith('http') && (
                  <div style={{
                    marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px',
                    background: '#f1f8e9', borderRadius: '8px', padding: '7px 10px',
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    <span style={{ fontSize: '0.72rem', color: '#2e7d32', fontWeight: '600' }}>direct video link</span>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0 8px' }}>
                  <div style={{ flex: 1, height: '1px', background: '#eee' }} />
                  <span style={{ fontSize: '0.68rem', color: '#bbb' }}>หรืออัปโหลดจากเครื่อง</span>
                  <div style={{ flex: 1, height: '1px', background: '#eee' }} />
                </div>
                <button
                  onClick={() => videoFileRef.current?.click()}
                  disabled={uploading}
                  style={{
                    width: '100%', padding: '13px', borderRadius: '12px',
                    border: '2px dashed #ffcdd2', background: uploading ? '#fff5f5' : '#fafafa',
                    color: '#c62828', fontSize: '0.8rem', cursor: uploading ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    transition: 'all 0.18s',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                  </svg>
                  อัปโหลดวีดีโอจากเครื่อง (สูงสุด 100MB)
                </button>
                <input ref={videoFileRef} type="file" accept="video/*" onChange={handleVideoFile} style={{ display: 'none' }} />
              </div>
            )}
          </div>

          {/* Upload progress bar */}
          {uploading && (
            <div style={{ marginBottom: '14px', animation: 'fadeIn 0.2s ease' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                <span style={{ fontSize: '0.72rem', color: '#e65100', fontWeight: '600' }}>{uploadMsg}</span>
                <span style={{ fontSize: '0.72rem', color: '#e65100', fontWeight: '700' }}>{uploadPct}%</span>
              </div>
              <div style={{ height: '6px', background: '#fff3e0', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '3px',
                  background: 'linear-gradient(90deg, #ff9800, #ef6c00)',
                  width: `${uploadPct}%`,
                  transition: 'width 0.2s ease',
                  boxShadow: '0 0 8px rgba(255,152,0,0.5)',
                }} />
              </div>
            </div>
          )}

          {/* Save button */}
          <button
            className="ef-save"
            onClick={handleSave}
            disabled={uploading || !content.trim()}
            style={{
              width: '100%', padding: '15px', borderRadius: '14px',
              background: saved ? '#4caf50' : (uploading || !content.trim()) ? '#e0e0e0' : `linear-gradient(135deg, #2e7d32, #43a047)`,
              color: (uploading || !content.trim()) ? '#aaa' : 'white',
              border: 'none', fontSize: '0.95rem', fontWeight: '700',
              cursor: (uploading || !content.trim()) ? 'not-allowed' : 'pointer',
              boxShadow: (!uploading && content.trim()) ? '0 4px 16px rgba(46,125,50,0.35)' : 'none',
              transition: 'all 0.2s ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            }}
          >
            {saved ? (
              <>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                บันทึกแล้ว!
              </>
            ) : uploading ? (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'pulse 1s infinite' }}><circle cx="12" cy="12" r="10"/></svg>
                กำลังอัปโหลด...
              </>
            ) : (
              <>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                  <polyline points="17 21 17 13 7 13 7 21"/>
                  <polyline points="7 3 7 8 15 8"/>
                </svg>
                บันทึก{type === 'text' ? 'ข้อความ' : type === 'image' ? 'รูปภาพ' : 'วีดีโอ'}
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}

// ---- BlockDisplay ----

interface BlockDisplayProps {
  block: LearningBlock;
  editMode: boolean;
  dark: boolean;
  reactions: Record<string, number>;
  myReactions: string[];
  emoji?: string;
  onChangeEmoji: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onReact: (emoji: string) => void;
  onShare: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

const REACTION_EMOJIS = ['👍', '✅', '🔥'];

function BlockDisplay({ block, editMode, dark, reactions, myReactions, emoji, onChangeEmoji, onEdit, onDelete, onReact, onShare, onMoveUp, onMoveDown }: BlockDisplayProps) {
  const ytId = block.type === 'video' ? getYouTubeId(block.content) : null;
  const [textExpanded, setTextExpanded] = useState(false);
  const isLongText = block.type === 'text' && block.content.length > 220;
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [iconPickerCat, setIconPickerCat] = useState(0);

  // Swipe-to-delete
  const touchStartX = useRef(0);
  const [swipeX, setSwipeX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);

  const bg = dark ? '#1e293b' : 'white';
  const headerBg = dark ? '#0f172a' : '#f8fafb';
  const dividerColor = dark ? '#0f172a' : '#f0f0f0';
  const textColor = dark ? '#e2e8f0' : '#333';
  const bodyColor = dark ? '#cbd5e1' : '#444';
  const mutedColor = dark ? '#64748b' : '#aaa';
  const borderColor = dark ? '#334155' : '#e8f5e9';

  return (
    <div
      id={`block-${block.id}`}
      style={{ position: 'relative', marginBottom: '8px' }}
      onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; setIsSwiping(true); }}
      onTouchMove={(e) => {
        if (!isSwiping) return;
        const dx = e.touches[0].clientX - touchStartX.current;
        if (dx < 0) setSwipeX(Math.max(dx, -76));
      }}
      onTouchEnd={() => {
        setIsSwiping(false);
        if (swipeX < -38) setSwipeX(-76); else setSwipeX(0);
      }}
    >
      {/* Red delete layer revealed on swipe */}
      <div
        onClick={onDelete}
        style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: '76px',
          background: 'linear-gradient(135deg,#c62828,#b71c1c)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          borderRadius: '12px', cursor: 'pointer', gap: '3px',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        <span style={{ color: 'white', fontSize: '0.6rem', fontWeight: '700' }}>ลบ</span>
      </div>

      {/* Main card */}
      <div style={{
        background: bg, borderRadius: '12px', overflow: 'hidden',
        border: `1.5px solid ${borderColor}`,
        boxShadow: dark ? '0 2px 14px rgba(0,0,0,0.4)' : '0 2px 10px rgba(0,0,0,0.06)',
        transform: `translateX(${swipeX}px)`,
        transition: isSwiping ? 'none' : 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '9px 12px', background: headerBg, borderBottom: showIconPicker ? 'none' : `1px solid ${dividerColor}`,
        }}>
          {/* Icon — click to change emoji in edit mode */}
          <button
            onClick={() => { if (editMode) setShowIconPicker(v => !v); }}
            title={editMode ? 'คลิกเพื่อเปลี่ยนอิโมจิ' : undefined}
            style={{
              width: '26px', height: '26px', borderRadius: '7px', flexShrink: 0,
              background: emoji ? 'transparent' : (block.type === 'text' ? '#e3f2fd' : block.type === 'image' ? '#f3e5f5' : '#ffebee'),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: editMode ? `1.5px dashed ${showIconPicker ? '#4caf50' : '#ccc'}` : 'none',
              cursor: editMode ? 'pointer' : 'default',
              fontSize: '1rem', lineHeight: 1, padding: 0,
              transition: 'border-color 0.15s',
            }}
          >
            {emoji ? (
              <span style={{ fontSize: '1rem', lineHeight: 1 }}>{emoji}</span>
            ) : block.type === 'text'
              ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1565c0" strokeWidth="2.5" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              : block.type === 'image'
              ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#6a1b9a" strokeWidth="2.5" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="21 15 16 10 5 21"/></svg>
              : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#b71c1c" strokeWidth="2.5" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            }
          </button>
          <span style={{ fontWeight: '700', fontSize: '0.8rem', color: textColor, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {block.title || (block.type === 'text' ? 'บันทึก' : block.type === 'image' ? 'รูปภาพ' : 'วีดีโอ')}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
            {/* Move up/down in edit mode */}
            {editMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginRight: '2px' }}>
                <button
                  onClick={onMoveUp}
                  disabled={!onMoveUp}
                  title="ขึ้น"
                  style={{ background: onMoveUp ? '#f0f0f0' : 'transparent', border: 'none', borderRadius: '4px', padding: '2px 5px', cursor: onMoveUp ? 'pointer' : 'default', color: onMoveUp ? '#555' : '#ccc', fontSize: '0.6rem', lineHeight: 1 }}
                >▲</button>
                <button
                  onClick={onMoveDown}
                  disabled={!onMoveDown}
                  title="ลง"
                  style={{ background: onMoveDown ? '#f0f0f0' : 'transparent', border: 'none', borderRadius: '4px', padding: '2px 5px', cursor: onMoveDown ? 'pointer' : 'default', color: onMoveDown ? '#555' : '#ccc', fontSize: '0.6rem', lineHeight: 1 }}
                >▼</button>
              </div>
            )}
            <button
              onClick={onShare}
              title="แชร์ / คัดลอก link"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 5px', color: mutedColor, display: 'flex', alignItems: 'center', borderRadius: '6px' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
            </button>
            {editMode && (
              <>
                <button onClick={onEdit} style={{ background: '#e3f2fd', color: '#1565c0', border: 'none', borderRadius: '6px', padding: '4px 10px', fontSize: '0.7rem', cursor: 'pointer', fontWeight: '700' }}>แก้ไข</button>
                <button onClick={onDelete} style={{ background: '#ffebee', color: '#c62828', border: 'none', borderRadius: '6px', padding: '4px 10px', fontSize: '0.7rem', cursor: 'pointer', fontWeight: '700' }}>ลบ</button>
              </>
            )}
          </div>
        </div>

        {/* Icon emoji picker */}
        {showIconPicker && (
          <div style={{ borderBottom: `1px solid ${dividerColor}`, background: dark ? '#0f172a' : '#fafafa' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px 0', gap: '0', overflowX: 'auto' }}>
              {EMOJI_CATEGORIES.map((cat, i) => (
                <button
                  key={i}
                  onClick={() => setIconPickerCat(i)}
                  style={{ background: 'none', border: 'none', padding: '5px 8px', cursor: 'pointer', fontSize: '0.9rem', opacity: iconPickerCat === i ? 1 : 0.45, borderBottom: `2px solid ${iconPickerCat === i ? '#4caf50' : 'transparent'}`, flexShrink: 0, transition: 'all 0.1s' }}
                >{cat.label}</button>
              ))}
              <div style={{ flex: 1 }} />
              <button
                onClick={() => { onChangeEmoji(''); setShowIconPicker(false); }}
                style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '0.65rem', cursor: 'pointer', padding: '4px 8px', flexShrink: 0 }}
              >รีเซ็ต</button>
              <button
                onClick={() => setShowIconPicker(false)}
                style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '0.75rem', cursor: 'pointer', padding: '4px 6px', flexShrink: 0 }}
              >✕</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1px', padding: '4px 8px 8px', maxHeight: '130px', overflowY: 'auto' }}>
              {EMOJI_CATEGORIES[iconPickerCat].emojis.map((em, i) => (
                <button
                  key={i}
                  onClick={() => { onChangeEmoji(em); setShowIconPicker(false); }}
                  style={{ background: 'none', border: 'none', fontSize: '1.15rem', padding: '4px 5px', cursor: 'pointer', borderRadius: '6px', lineHeight: 1, transition: 'background 0.1s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f0f0f0')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >{em}</button>
              ))}
            </div>
          </div>
        )}

        {/* Content */}
        {block.type === 'text' && (() => {
          const isHtml = /<[a-z][\s\S]*>/i.test(block.content);
          const plainText = block.content;
          const shortPlain = isLongText && !textExpanded ? plainText.slice(0, 220) + '…' : plainText;
          return (
            <div style={{ padding: '10px 14px 12px' }}>
              <style>{`
                .l4-rc h1{font-size:1.2rem;font-weight:700;margin:6px 0 4px;line-height:1.3}
                .l4-rc h2{font-size:1rem;font-weight:700;margin:5px 0 3px}
                .l4-rc h3{font-size:0.9rem;font-weight:700;margin:4px 0 2px}
                .l4-rc ul,.l4-rc ol{padding-left:1.4em;margin:4px 0}
                .l4-rc li{margin:3px 0;line-height:1.65}
                .l4-rc blockquote{border-left:3px solid #4caf50;padding:3px 0 3px 10px;color:#666;margin:6px 0;font-style:italic}
                .l4-rc b,.l4-rc strong{font-weight:700}
                .l4-rc i,.l4-rc em{font-style:italic}
                .l4-rc p{margin:0 0 5px}
                .l4-rc p:last-child{margin-bottom:0}
                .l4-rc img{max-width:100%;border-radius:8px;margin:6px 0;display:block;}
                .l4-rc video{max-width:100%;border-radius:8px;margin:6px 0;display:block;}
                .l4-rc iframe{border:none;border-radius:10px;width:100%;}
                .l4-rc div[style*="padding-bottom"]{margin:6px 0;border-radius:10px;overflow:hidden;}
                .l4-rc .l4-callout{background:#f0fdf4;border-left:3px solid #4caf50;border-radius:8px;padding:9px 12px;margin:6px 0;display:flex;gap:7px;align-items:flex-start;}
                .l4-rc .l4-callout-ico{font-size:0.95rem;flex-shrink:0;}
                .l4-rc .l4-callout-txt{flex:1;line-height:1.6;}
                .l4-rc .l4-tbl{width:100%;border-collapse:collapse;margin:6px 0;font-size:0.82rem;}
                .l4-rc .l4-tbl th{background:#f5f5f5;font-weight:700;padding:6px 9px;border:1px solid #ddd;text-align:left;}
                .l4-rc .l4-tbl td{padding:5px 9px;border:1px solid #ddd;}
                .l4-rc .l4-todo{list-style:none;padding-left:0;margin:3px 0;}
                .l4-rc .l4-todo-item{display:flex;align-items:baseline;gap:6px;padding:2px 0;}
                .l4-rc .l4-todo-item input{cursor:pointer;}
                .l4-rc .l4-toggle{margin:5px 0;}
                .l4-rc .l4-toggle-sum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:5px;padding:3px 0;font-weight:600;}
                .l4-rc .l4-toggle-sum::-webkit-details-marker{display:none;}
                .l4-rc .l4-toggle-sum::before{content:"▶";font-size:0.6rem;color:#4caf50;transition:transform 0.15s;flex-shrink:0;}
                .l4-rc .l4-toggle[open] .l4-toggle-sum::before{transform:rotate(90deg);}
                .l4-rc .l4-toggle-body{padding:3px 0 3px 16px;border-left:2px solid #e8f5e9;margin-left:4px;}
                .l4-rc .l4-cols{display:flex;gap:8px;margin:6px 0;}
                .l4-rc .l4-col{flex:1;min-width:0;padding:6px 8px;border:1px solid #e8e8e8;border-radius:7px;}
                .l4-rc-dark .l4-callout{background:#134e2a;border-color:#4caf50;}
                .l4-rc-dark .l4-tbl th{background:#1e293b;color:#e2e8f0;border-color:#334155;}
                .l4-rc-dark .l4-tbl td{border-color:#334155;color:#cbd5e1;}
                .l4-rc-dark .l4-col{border-color:#334155;}
                .l4-rc-dark h1,.l4-rc-dark h2,.l4-rc-dark h3{color:#f1f5f9}
                .l4-rc-dark blockquote{color:#94a3b8}
              `}</style>
              {isHtml ? (
                <div
                  className={`l4-rc${dark ? ' l4-rc-dark' : ''}`}
                  dangerouslySetInnerHTML={{ __html: block.content }}
                  style={{ fontSize: '0.85rem', color: bodyColor, lineHeight: '1.75', wordBreak: 'break-word' }}
                />
              ) : (
                <>
                  <div style={{ fontSize: '0.83rem', color: bodyColor, lineHeight: '1.72', whiteSpace: 'pre-wrap' }}>
                    {shortPlain}
                  </div>
                  {isLongText && (
                    <button onClick={() => setTextExpanded(e => !e)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '5px 0 0', color: '#2e7d32', fontSize: '0.72rem', fontWeight: '700', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      {textExpanded
                        ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="18 15 12 9 6 15"/></svg>ย่อ</>
                        : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>อ่านต่อ</>
                      }
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {block.type === 'image' && (
          <img src={block.content} alt={block.title}
            style={{ width: '100%', display: 'block', maxHeight: '320px', objectFit: 'contain', background: dark ? '#0f172a' : '#f5f5f5' }}
          />
        )}

        {block.type === 'video' && ytId && (
          <div style={{ position: 'relative', paddingTop: '56.25%' }}>
            <iframe
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
              src={`https://www.youtube.com/embed/${ytId}`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen title={block.title || 'Video'}
            />
          </div>
        )}

        {block.type === 'video' && !ytId && (
          <video controls style={{ width: '100%', display: 'block', background: '#000' }}>
            <source src={block.content} />
          </video>
        )}

        {/* Reactions bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          padding: '7px 12px', borderTop: `1px solid ${dividerColor}`,
        }}>
          {REACTION_EMOJIS.map(emoji => {
            const count = reactions[emoji] ?? 0;
            const mine = myReactions.includes(emoji);
            return (
              <button
                key={emoji}
                onClick={() => onReact(emoji)}
                style={{
                  background: mine ? (dark ? '#14532d' : '#e8f5e9') : 'transparent',
                  border: `1.5px solid ${mine ? '#4caf50' : (dark ? '#334155' : '#e8e8e8')}`,
                  borderRadius: '20px', padding: '3px 10px', cursor: 'pointer',
                  fontSize: '0.72rem', fontWeight: '700',
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                  color: mine ? '#2e7d32' : mutedColor,
                  transition: 'all 0.15s ease',
                  transform: mine ? 'scale(1.05)' : 'scale(1)',
                }}
              >
                {emoji}
                {count > 0 && <span style={{ fontSize: '0.65rem' }}>{count}</span>}
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          {block.type === 'text' && (
            <span style={{ fontSize: '0.6rem', color: mutedColor }}>{block.content.length} ตัว</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Main Component ----

const Line4Manual: React.FC<Props> = ({ operatorName, onBackToMain }) => {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showParams, setShowParams] = useState<number | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [blocks, setBlocks] = useState<LearningBlock[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [editForm, setEditForm] = useState<{ stepId: number | null; block: LearningBlock | null } | null>(null);
  const [showGlobal, setShowGlobal] = useState(true);

  // New feature states
  const [dark, setDark] = useState(() => localStorage.getItem('l4-dark') === '1');
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [reactions, setReactions] = useState<Record<string, Record<string, number>>>(() => {
    try { return JSON.parse(localStorage.getItem('l4-reactions') ?? '{}'); } catch { return {}; }
  });
  const [myReactions, setMyReactions] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem('l4-my-reactions') ?? '{}'); } catch { return {}; }
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [blockEmojis, setBlockEmojis] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('l4-block-emojis') ?? '{}'); } catch { return {}; }
  });
  const localIds = useRef<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  // Helpers
  const addToast = (msg: string, type: Toast['type'] = 'info') => {
    const id = genId();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3200);
  };

  const toggleDark = () => {
    setDark(d => { localStorage.setItem('l4-dark', d ? '0' : '1'); return !d; });
  };

  const handleReact = (blockId: string, emoji: string) => {
    const mine = myReactions[blockId]?.includes(emoji) ?? false;
    setReactions(prev => {
      const blockR = { ...(prev[blockId] ?? {}) };
      blockR[emoji] = Math.max((blockR[emoji] ?? 0) + (mine ? -1 : 1), 0);
      const next = { ...prev, [blockId]: blockR };
      localStorage.setItem('l4-reactions', JSON.stringify(next));
      return next;
    });
    setMyReactions(prev => {
      const cur = prev[blockId] ?? [];
      const next = { ...prev, [blockId]: mine ? cur.filter(e => e !== emoji) : [...cur, emoji] };
      localStorage.setItem('l4-my-reactions', JSON.stringify(next));
      return next;
    });
  };

  const handleShare = (block: LearningBlock) => {
    const url = `${window.location.href.split('#')[0]}#block-${block.id}`;
    if (navigator.share) {
      navigator.share({ title: block.title || 'เนื้อหาการเรียนรู้', url }).catch(() => null);
    } else {
      navigator.clipboard.writeText(url).then(() => addToast('คัดลอก link แล้ว!', 'success'));
    }
  };

  const handleChangeEmoji = (blockId: string, emoji: string) => {
    setBlockEmojis(prev => {
      const next = { ...prev };
      if (emoji) next[blockId] = emoji; else delete next[blockId];
      localStorage.setItem('l4-block-emojis', JSON.stringify(next));
      return next;
    });
  };

  const moveBlock = (id: string, dir: 'up' | 'down') => {
    setBlocks(prev => {
      const block = prev.find(b => b.id === id);
      if (!block) return prev;
      const peers = prev.filter(b => b.stepId === block.stepId);
      const peerIdx = peers.findIndex(b => b.id === id);
      if (dir === 'up' && peerIdx === 0) return prev;
      if (dir === 'down' && peerIdx === peers.length - 1) return prev;
      const swapWith = dir === 'up' ? peers[peerIdx - 1] : peers[peerIdx + 1];
      const idx = prev.findIndex(b => b.id === id);
      const swapIdx = prev.findIndex(b => b.id === swapWith.id);
      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      localStorage.setItem('l4-block-order', JSON.stringify(next.map(b => b.id)));
      return next;
    });
  };

  // Supabase / localStorage
  useEffect(() => {
    if (!supabase) {
      try { setBlocks(JSON.parse(localStorage.getItem('line4-blocks') ?? '[]')); } catch { setBlocks([]); }
      return;
    }
    supabase.from('learning_blocks').select('*').order('created_at').then(({ data }) => {
      if (data) {
        let loaded = data.map(fromDb);
        try {
          const savedOrder: string[] = JSON.parse(localStorage.getItem('l4-block-order') ?? '[]');
          if (savedOrder.length > 0) {
            const orderMap = new Map(savedOrder.map((id, i) => [id, i]));
            loaded = [...loaded].sort((a, b) => (orderMap.get(a.id) ?? 9999) - (orderMap.get(b.id) ?? 9999));
          }
        } catch { /* ignore */ }
        setBlocks(loaded);
      }
    });
    const channel = supabase
      .channel('line4_blocks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'learning_blocks' }, (payload) => {
        const newId = (payload.new as Record<string, unknown>)?.id as string;
        if (payload.eventType === 'INSERT') {
          if (!localIds.current.has(newId)) {
            addToast('มีเนื้อหาใหม่จากผู้ใช้อื่น!', 'info');
          }
          setBlocks(prev => prev.find(b => b.id === newId) ? prev : [...prev, fromDb(payload.new as Record<string, unknown>)]);
        } else if (payload.eventType === 'UPDATE') {
          setBlocks(prev => prev.map(b => b.id === newId ? fromDb(payload.new as Record<string, unknown>) : b));
        } else if (payload.eventType === 'DELETE') {
          setBlocks(prev => prev.filter(b => b.id !== (payload.old as Record<string, unknown>).id as string));
        }
      })
      .subscribe();
    return () => { supabase!.removeChannel(channel); };
  }, []);

  // Scroll to block from URL hash
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#block-')) {
      const id = hash.slice(7);
      setTimeout(() => document.getElementById(`block-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 600);
    }
  }, []);

  const saveBlock = async (block: LearningBlock) => {
    localIds.current.add(block.id);
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === block.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = block; return next; }
      return [...prev, block];
    });
    setEditForm(null);
    addToast('บันทึกแล้ว!', 'success');
    if (supabase) {
      setSyncing(true);
      await supabase.from('learning_blocks').upsert(toDb(block));
      setSyncing(false);
    } else {
      setBlocks(prev => { localStorage.setItem('line4-blocks', JSON.stringify(prev)); return prev; });
    }
  };

  const deleteBlock = async (id: string) => {
    if (!window.confirm('ลบเนื้อหานี้?')) return;
    setBlocks(prev => {
      const next = prev.filter(b => b.id !== id);
      if (!supabase) localStorage.setItem('line4-blocks', JSON.stringify(next));
      return next;
    });
    if (supabase) {
      setSyncing(true);
      await supabase.from('learning_blocks').delete().eq('id', id);
      setSyncing(false);
    }
  };

  // Computed
  const stepBlocks = (stepId: number) => blocks.filter(b => b.stepId === stepId);
  const globalBlocks = blocks.filter(b => b.stepId === null);
  const q = search.trim().toLowerCase();
  const searchResults = q
    ? blocks.filter(b => b.title.toLowerCase().includes(q) || b.content.toLowerCase().includes(q))
    : null;

  // Dark mode colors
  const pageBg = dark ? '#0f172a' : '#f4f6f9';
  const cardBg = dark ? '#1e293b' : 'white';
  const cardBorder = dark ? '#334155' : '#eee';
  const headingColor = dark ? '#f1f5f9' : '#222';
  const mutedColor = dark ? '#64748b' : '#999';
  const sectionLabelColor = dark ? '#475569' : '#999';

  const blockDisplayProps = (block: LearningBlock, stepId: number | null) => ({
    block,
    editMode,
    dark,
    reactions: reactions[block.id] ?? {},
    myReactions: myReactions[block.id] ?? [],
    emoji: blockEmojis[block.id],
    onChangeEmoji: (e: string) => handleChangeEmoji(block.id, e),
    onEdit: () => setEditForm({ stepId, block }),
    onDelete: () => deleteBlock(block.id),
    onReact: (emoji: string) => handleReact(block.id, emoji),
    onShare: () => handleShare(block),
  });

  return (
    <div style={{ background: pageBg, minHeight: '100vh', paddingBottom: '80px', transition: 'background 0.3s' }}>
      <style>{`
        @keyframes toastIn { from { transform: translateY(-20px) scale(0.92); opacity: 0; } to { transform: none; opacity: 1; } }
        @media print {
          body * { visibility: hidden; }
          #l4-print-area, #l4-print-area * { visibility: visible; }
          #l4-print-area { position: fixed; inset: 0; padding: 20px; background: white; font-family: sans-serif; }
        }
      `}</style>

      <ToastContainer toasts={toasts} />

      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #1b5e20, #2e7d32)',
        color: 'white', padding: '20px 16px 16px',
        borderBottomLeftRadius: '20px', borderBottomRightRadius: '20px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <button onClick={onBackToMain} style={{
            background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white',
            borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', fontSize: '0.8rem', flexShrink: 0,
          }}>← หลัก</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: '700', fontSize: '1.05rem', letterSpacing: '0.02em' }}>คู่มือระบบผลิต Line 4</div>
            <div style={{ fontSize: '0.65rem', opacity: 0.75 }}>GEA Syrup Processing · Mitr Phol Thailand</div>
          </div>
          {syncing && <span style={{ fontSize: '0.65rem', opacity: 0.8, flexShrink: 0 }}>⏳</span>}
          {supabase && !syncing && <span style={{ fontSize: '0.65rem', opacity: 0.7, flexShrink: 0 }}>☁️</span>}
          {/* Search toggle */}
          <button onClick={() => { setShowSearch(s => !s); setTimeout(() => searchRef.current?.focus(), 80); }} style={{
            background: showSearch ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.2)',
            border: 'none', color: 'white', borderRadius: '8px', padding: '6px 8px',
            cursor: 'pointer', display: 'flex', alignItems: 'center', flexShrink: 0,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
          {/* Dark mode toggle */}
          <button onClick={toggleDark} style={{
            background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white',
            borderRadius: '8px', padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', flexShrink: 0,
          }} title={dark ? 'โหมดสว่าง' : 'โหมดมืด'}>
            {dark
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="1.5"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="1.5"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            }
          </button>
          {/* Edit mode */}
          <button onClick={() => setEditMode(e => !e)} style={{
            background: editMode ? '#fff3e0' : 'rgba(255,255,255,0.2)',
            border: 'none', color: editMode ? '#e65100' : 'white',
            borderRadius: '8px', padding: '5px 10px', cursor: 'pointer',
            fontSize: '0.78rem', fontWeight: editMode ? '700' : '400', flexShrink: 0,
          }}>
            {editMode ? '✏️ แก้ไข' : '✏️'}
          </button>
        </div>
        {/* Search bar */}
        {showSearch && (
          <div style={{ animation: 'fadeIn 0.2s ease' }}>
            <div style={{ position: 'relative' }}>
              <input
                ref={searchRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="ค้นหาเนื้อหา, หัวข้อ..."
                style={{
                  width: '100%', padding: '10px 14px 10px 36px', borderRadius: '12px',
                  border: 'none', fontSize: '0.88rem', boxSizing: 'border-box',
                  background: 'rgba(255,255,255,0.18)', color: 'white', outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2.5" strokeLinecap="round" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              {search && (
                <button onClick={() => setSearch('')} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '0.9rem' }}>✕</button>
              )}
            </div>
          </div>
        )}
        {!showSearch && (
          <div style={{ background: 'rgba(255,255,255,0.12)', borderRadius: '10px', padding: '8px 12px', fontSize: '0.7rem', opacity: 0.85 }}>
            ผู้ดู: {operatorName} · {blocks.length} เนื้อหา · GEA HMI Line 4
          </div>
        )}
      </div>

      {editMode && (
        <div style={{
          background: '#fff3e0', borderBottom: '2px solid #ffb74d',
          padding: '8px 16px', fontSize: '0.75rem', color: '#e65100',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          <span>✏️</span>
          <span>โหมดแก้ไข — กด <strong>+ เพิ่ม</strong> ใต้แต่ละหัวข้อ หรือที่ "แหล่งเรียนรู้" ด้านล่าง</span>
        </div>
      )}

      {/* Search results mode */}
      {searchResults !== null && (
        <div style={{ padding: '12px 14px 0' }}>
          <div style={{ fontSize: '0.7rem', color: sectionLabelColor, fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '10px' }}>
            ผลการค้นหา "{search}" — {searchResults.length} รายการ
          </div>
          {searchResults.length === 0 && (
            <div style={{ textAlign: 'center', color: mutedColor, fontSize: '0.8rem', padding: '32px 16px', background: cardBg, borderRadius: '14px', border: `1.5px dashed ${cardBorder}` }}>
              ไม่พบเนื้อหาที่ตรงกัน
            </div>
          )}
          {searchResults.map(block => (
            <BlockDisplay key={block.id} {...blockDisplayProps(block, block.stepId)} />
          ))}

        </div>
      )}

      {/* Normal view (hidden when searching) */}
      {searchResults === null && (
        <>
          {/* Flow diagram */}
          <div style={{ padding: '14px 14px 0' }}>
            <div style={{ fontSize: '0.7rem', color: sectionLabelColor, fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>แผนผังระบบผลิต</div>
            <div style={{ background: dark ? '#1e293b' : '#263238', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px' }}>
              <div style={{ fontSize: '0.6rem', color: '#78909c', marginBottom: '6px', letterSpacing: '0.06em' }}>GEA HMI TABS</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {[
                  { tab: 'Mixing Tanks', color: '#01579b' },
                  { tab: 'Mixing Station', color: '#1565c0' },
                  { tab: 'Pasteurizer and Storage', color: '#b71c1c' },
                  { tab: 'CIP Kitchen', color: '#6a1b9a', note: '(CIP Station)' },
                ].map((t) => (
                  <div key={t.tab} style={{ background: t.color, color: 'white', borderRadius: '6px', padding: '4px 10px', fontSize: '0.62rem', fontWeight: '600' }}>
                    {t.tab}{t.note ? <span style={{ opacity: 0.7, marginLeft: '3px' }}>{t.note}</span> : ''}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', gap: '0', paddingBottom: '6px', WebkitOverflowScrolling: 'touch' as React.CSSProperties['WebkitOverflowScrolling'] }}>
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
                  <div style={{ flex: '0 0 auto', textAlign: 'center', background: s.color, color: 'white', borderRadius: '8px', padding: '6px 8px', minWidth: '52px', fontSize: '0.58rem', fontWeight: '700', lineHeight: '1.4', whiteSpace: 'pre-line' }}>
                    {s.label}
                  </div>
                  {i < 6 && <div style={{ color: '#aaa', fontSize: '0.9rem', flex: '0 0 auto', padding: '0 2px' }}>›</div>}
                </React.Fragment>
              ))}
              <div style={{ flex: '0 0 8px' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
              <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#6a1b9a', flexShrink: 0 }} />
              <div style={{ fontSize: '0.62rem', color: mutedColor }}>CIP Kitchen — ล้างทุกส่วนหลังเสร็จงาน: Mixing → Pasteurizer → Storage</div>
            </div>
          </div>

          {/* Step cards */}
          <div style={{ padding: '12px 14px 0' }}>
            <div style={{ fontSize: '0.7rem', color: sectionLabelColor, fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>รายละเอียดแต่ละส่วน</div>
            {STEPS.map((step) => {
              const isOpen = expanded === step.id;
              const isParam = showParams === step.id;
              const sBlocks = stepBlocks(step.id);
              return (
                <div key={step.id} style={{
                  background: cardBg, borderRadius: '14px', marginBottom: '10px',
                  boxShadow: dark ? '0 2px 12px rgba(0,0,0,0.3)' : '0 1px 6px rgba(0,0,0,0.07)',
                  border: `1.5px solid ${isOpen ? step.color : cardBorder}`,
                  overflow: 'hidden', transition: 'border-color 0.2s',
                }}>
                  <div
                    onClick={() => { setExpanded(isOpen ? null : step.id); if (!isOpen) setShowParams(null); }}
                    style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 14px', cursor: 'pointer', background: isOpen ? (dark ? step.color + '22' : step.bgLight) : cardBg }}
                  >
                    <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: step.color, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
                      {step.icon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: '700', fontSize: '0.88rem', color: headingColor }}>{step.title}</div>
                      <div style={{ fontSize: '0.6rem', color: mutedColor, marginTop: '2px' }}>{step.subtitle}</div>
                      {sBlocks.length > 0 && !isOpen && (
                        <div style={{ fontSize: '0.6rem', color: '#4caf50', marginTop: '3px' }}>📌 {sBlocks.length} บันทึก</div>
                      )}
                    </div>
                    <div style={{ color: step.color, fontSize: '1rem', fontWeight: '700', transition: 'transform 0.25s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</div>
                  </div>

                  {isOpen && (
                    <div style={{ borderTop: `1px solid ${dark ? step.color + '33' : step.bgLight}`, padding: '12px 14px 14px' }}>
                      <div
                        onClick={() => setShowParams(isParam ? null : step.id)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '5px',
                          background: isParam ? step.color : (dark ? step.color + '22' : step.bgLight),
                          color: isParam ? 'white' : step.color,
                          borderRadius: '8px', padding: '5px 12px', marginBottom: '12px',
                          cursor: 'pointer', fontSize: '0.7rem', fontWeight: '600',
                        }}
                      >
                        📊 ค่า Setpoint จาก SCADA {isParam ? '▴' : '▾'}
                      </div>
                      {isParam && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '14px', padding: '10px', background: dark ? step.color + '18' : step.bgLight, borderRadius: '10px' }}>
                          {step.params.map((p, i) => (
                            <div key={i} style={{ background: cardBg, borderRadius: '8px', padding: '8px 10px' }}>
                              <div style={{ fontSize: '0.6rem', color: mutedColor, marginBottom: '2px' }}>{p.label}</div>
                              <div style={{ fontWeight: '700', fontSize: '0.85rem', color: step.color }}>{p.value}</div>
                              {p.note && <div style={{ fontSize: '0.58rem', color: mutedColor, marginTop: '2px' }}>{p.note}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                      {step.items.map((item, idx) => {
                        const tagStyle = TAG_COLORS[item.tag] || { bg: '#f5f5f5', color: '#555' };
                        return (
                          <div key={idx} style={{ paddingTop: '10px', borderTop: idx > 0 ? `1px solid ${dark ? '#1e293b' : '#f0f0f0'}` : 'none' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                              <span style={{ flex: '0 0 auto', background: tagStyle.bg, color: tagStyle.color, fontSize: '0.58rem', fontWeight: '700', padding: '2px 7px', borderRadius: '6px', marginTop: '2px' }}>{item.tag}</span>
                              <div>
                                <div style={{ fontWeight: '600', fontSize: '0.82rem', color: headingColor, lineHeight: 1.3 }}>{item.name}</div>
                                <div style={{ fontSize: '0.72rem', color: dark ? '#94a3b8' : '#666', marginTop: '3px', lineHeight: 1.5 }}>{item.desc}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {step.note && (
                        <div style={{ marginTop: '12px', background: dark ? '#1e293b' : '#fffde7', borderLeft: `3px solid ${step.color}`, padding: '8px 10px', borderRadius: '4px', fontSize: '0.7rem', color: dark ? '#94a3b8' : '#555' }}>
                          <span style={{ fontWeight: '700', color: step.color }}>หมายเหตุ: </span>{step.note}
                        </div>
                      )}
                      {sBlocks.length > 0 && (
                        <div style={{ marginTop: '16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: cardBg, border: `1.5px solid ${dark ? '#1e3a1e' : '#c8e6c9'}`, borderRadius: '10px', padding: '9px 12px', marginBottom: '10px', boxShadow: '0 1px 3px rgba(46,125,50,0.06)' }}>
                            <div style={{ width: '24px', height: '24px', borderRadius: '6px', background: '#388e3c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                            </div>
                            <span style={{ fontWeight: '700', fontSize: '0.88rem', color: '#1b5e20' }}>บันทึกการเรียนรู้</span>
                            <span style={{ marginLeft: 'auto', background: '#e8f5e9', color: '#2e7d32', fontSize: '0.65rem', fontWeight: '700', borderRadius: '20px', padding: '2px 8px', border: '1px solid #a5d6a7' }}>{sBlocks.length}</span>
                          </div>
                          {sBlocks.map((block, idx) => (
                            <BlockDisplay
                              key={block.id}
                              {...blockDisplayProps(block, step.id)}
                              onMoveUp={idx > 0 ? () => moveBlock(block.id, 'up') : undefined}
                              onMoveDown={idx < sBlocks.length - 1 ? () => moveBlock(block.id, 'down') : undefined}
                            />
                          ))}
                        </div>
                      )}
                      {editMode && (
                        <button onClick={() => setEditForm({ stepId: step.id, block: null })} style={{ width: '100%', marginTop: '10px', padding: '10px', borderRadius: '10px', border: '2px dashed #a5d6a7', background: dark ? '#0f172a' : '#f1f8e9', color: '#2e7d32', fontSize: '0.78rem', fontWeight: '600', cursor: 'pointer' }}>
                          + เพิ่มบันทึก / รูป / วีดีโอ ใน {step.code}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Global learning section */}
          <div style={{ padding: '4px 14px 0' }}>
            <button
              onClick={() => setShowGlobal(v => !v)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', background: cardBg, border: `1.5px solid ${dark ? '#1e3a1e' : '#c8e6c9'}`, borderRadius: '12px', padding: '11px 14px', marginBottom: '12px', cursor: 'pointer', textAlign: 'left', boxShadow: dark ? '0 2px 10px rgba(0,0,0,0.3)' : '0 1px 4px rgba(46,125,50,0.07)' }}
            >
              <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: '#2e7d32', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              </div>
              <span style={{ fontWeight: '700', fontSize: '0.95rem', color: dark ? '#86efac' : '#1b5e20', flex: 1 }}>แหล่งเรียนรู้เพิ่มเติม</span>
              {globalBlocks.length > 0 && (
                <span style={{ background: '#e8f5e9', color: '#2e7d32', fontSize: '0.65rem', fontWeight: '700', borderRadius: '20px', padding: '2px 8px', border: '1px solid #a5d6a7' }}>{globalBlocks.length}</span>
              )}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: showGlobal ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s ease' }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            {showGlobal && (
              <>
                {globalBlocks.length === 0 && !editMode && (
                  <div style={{ textAlign: 'center', color: mutedColor, fontSize: '0.75rem', padding: '24px 16px', background: cardBg, borderRadius: '12px', border: `1.5px dashed ${cardBorder}` }}>
                    กด ✏️ ที่มุมขวาบน เพื่อเพิ่มรูป วีดีโอ หรือบันทึกสำหรับเรียนรู้
                  </div>
                )}
                {globalBlocks.map((block, idx) => (
                  <BlockDisplay
                    key={block.id}
                    {...blockDisplayProps(block, null)}
                    onMoveUp={idx > 0 ? () => moveBlock(block.id, 'up') : undefined}
                    onMoveDown={idx < globalBlocks.length - 1 ? () => moveBlock(block.id, 'down') : undefined}
                  />
                ))}
                {editMode && (
                  <button onClick={() => setEditForm({ stepId: null, block: null })} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: '2px dashed #a5d6a7', background: dark ? '#0f172a' : '#f1f8e9', color: '#2e7d32', fontSize: '0.82rem', fontWeight: '600', cursor: 'pointer', marginBottom: '4px' }}>
                    + เพิ่มเนื้อหา / รูปภาพ / วีดีโอ สำหรับเรียนรู้
                  </button>
                )}
              </>
            )}
          </div>

          <div style={{ padding: '12px 14px 0' }}>
            <div style={{ background: dark ? '#1c1500' : '#fff3e0', border: `1px solid ${dark ? '#92400e' : '#ffe0b2'}`, borderRadius: '12px', padding: '12px 14px', fontSize: '0.72rem', color: dark ? '#fbbf24' : '#e65100', lineHeight: '1.6' }}>
              <div style={{ fontWeight: '700', marginBottom: '4px' }}>⚠️ หน้านี้อยู่ระหว่างการเรียนรู้ระบบ</div>
              ค่าที่แสดงอ้างอิงจาก GEA HMI จริง (Mitr Phol, 10/05/2026) — สามารถแก้ไขเพิ่มเติมได้เมื่อเข้าใจกระบวนการมากขึ้น
            </div>
          </div>
        </>
      )}

      {/* Floating action buttons */}
      <div style={{ position: 'fixed', bottom: '20px', right: '16px', display: 'flex', flexDirection: 'column', gap: '10px', zIndex: 100 }}>
        {/* Print / Save PDF */}
        <button
          onClick={() => window.print()}
          title="พิมพ์ / บันทึก PDF"
          style={{
            width: '48px', height: '48px', borderRadius: '50%',
            background: dark ? '#1e293b' : 'white', border: `1.5px solid ${dark ? '#334155' : '#e0e0e0'}`,
            boxShadow: dark ? '0 4px 16px rgba(0,0,0,0.4)' : '0 4px 16px rgba(0,0,0,0.12)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: dark ? '#94a3b8' : '#666', transition: 'all 0.18s',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
            <rect x="6" y="14" width="12" height="8"/>
          </svg>
        </button>
        {/* Add content shortcut */}
        {editMode && (
          <button
            onClick={() => setEditForm({ stepId: null, block: null })}
            style={{
              width: '52px', height: '52px', borderRadius: '50%',
              background: 'linear-gradient(135deg,#2e7d32,#43a047)', border: 'none',
              boxShadow: '0 4px 20px rgba(46,125,50,0.4)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', fontSize: '1.4rem', fontWeight: '300', transition: 'all 0.18s',
            }}
          >+</button>
        )}
      </div>

      {editForm !== null && (
        <EditForm
          initial={editForm.block}
          stepId={editForm.stepId}
          onSave={saveBlock}
          onClose={() => setEditForm(null)}
        />
      )}
    </div>
  );
};

export default Line4Manual;
