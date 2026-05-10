import React, { useState } from 'react';

interface Props {
  operatorName: string;
  onBackToMain: () => void;
}

const STEPS = [
  {
    id: 1,
    code: 'RM',
    title: 'วัตถุดิบ (Raw Materials)',
    color: '#4a7c59',
    bgLight: '#e8f5e9',
    icon: (
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="18" width="10" height="12" rx="1"/>
        <rect x="18" y="18" width="10" height="12" rx="1"/>
        <path d="M9 18 L9 12 L14 8 L14 3 L18 3 L18 8 L23 12 L23 18"/>
        <line x1="6" y1="24" x2="12" y2="24"/>
      </svg>
    ),
    items: [
      { name: 'Process Water', desc: 'น้ำกระบวนการผลิต — จ่ายจากระบบน้ำหลัก (W-1603, W-1813)', tag: 'น้ำ' },
      { name: 'Granulate Sugar', desc: 'น้ำตาลทราย — ป้อนเข้า GEA Formula Mini Mixer โดยตรง (QR08)', tag: 'น้ำตาล' },
      { name: 'IBC / Liquid Ingredients', desc: 'วัตถุดิบเหลวจาก IBC — ต่อเข้าระบบผสม (Syrup Conc. Level 3)', tag: 'เหลว' },
      { name: 'Seal Water', desc: 'น้ำซีล — ใช้กับปั๊ม GP21, GP11, P-3033 (W-1701, W-1702, W-1704)', tag: 'ซีล' },
    ],
    note: '',
  },
  {
    id: 2,
    code: 'MIX-S',
    title: 'Mixing Station (สถานีผสม)',
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
    items: [
      { name: 'GEA Formula Mini Mixer (CM01)', desc: 'เครื่องผสมสูตร — ผสมน้ำตาลทรายกับ Process Water ก่อนส่งเข้า Mixing Tank', tag: 'ผสม' },
      { name: 'Heater EG21', desc: 'ให้ความร้อนน้ำด้วยไอน้ำ (Steam H-1913) — เตรียมน้ำอุ่นก่อนผสม', tag: 'ร้อน' },
      { name: 'Pump GP11 (8,000 LPH)', desc: 'ปั๊มจ่ายจาก Mixing Station ไป Mixing Tank (P-3009)', tag: 'ปั๊ม' },
      { name: 'Pump GP21 (8,000 LPH)', desc: 'ปั๊มสำรอง/จ่ายทิศทางอื่น (P-3032)', tag: 'ปั๊ม' },
    ],
    note: 'Steam: H-1912-HEATING-STEA-DN85-SS07 / H-1913-HEATING-STEA-DN40-SS07',
  },
  {
    id: 3,
    code: 'MIX-T',
    title: 'Mixing Tanks (ถังผสม 2 × 3m³)',
    color: '#01579b',
    bgLight: '#e1f5fe',
    icon: (
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6" y="8" width="8" height="18" rx="1"/>
        <rect x="18" y="8" width="8" height="18" rx="1"/>
        <line x1="7" y1="12" x2="13" y2="12"/>
        <line x1="19" y1="12" x2="25" y2="12"/>
        <path d="M10 26 L10 29 M22 26 L22 29"/>
        <path d="M10 8 L10 5 M22 8 L22 5"/>
        <circle cx="10" cy="5" r="1.5" fill="currentColor" stroke="none" opacity="0.4"/>
        <circle cx="22" cy="5" r="1.5" fill="currentColor" stroke="none" opacity="0.4"/>
      </svg>
    ),
    items: [
      { name: 'Mixing Tank 1 (3m³) + HW01', desc: 'ถังผสมใบที่ 1 — มีระบบ Hot Water Jacket (HW01) ควบคุมอุณหภูมิ, Agitator RND01', tag: 'Tank 1' },
      { name: 'Mixing Tank 2 (3m³) + HW02', desc: 'ถังผสมใบที่ 2 — มีระบบ Hot Water Jacket (HW02) ควบคุมอุณหภูมิ, Agitator RND02', tag: 'Tank 2' },
      { name: 'Valve Matrix', desc: 'ชุดวาล์วกลาง — สลับทิศทางการไหลระหว่างถัง/ปั๊ม/CIP', tag: 'วาล์ว' },
      { name: 'Pump RM01 × 2', desc: 'ปั๊มหมุนเวียนภายในถัง (Recirculation)', tag: 'ปั๊ม' },
    ],
    note: 'ทั้ง 2 ถังสลับกันใช้งาน ถังหนึ่งผสม ถังหนึ่งรอส่งต่อ',
  },
  {
    id: 4,
    code: 'PAST',
    title: 'Pasteurizer (เครื่องพาสเจอไรซ์)',
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
    items: [
      { name: 'Balance Tank + Pump GP01 (2,500 LPH)', desc: 'ถังสมดุลก่อนเข้า PHE — ปั๊ม P-3034 จ่ายเข้า Pasteurizer (P-3035)', tag: 'บัฟเฟอร์' },
      { name: 'PHE Heating (Steam)', desc: 'แลกเปลี่ยนความร้อนด้วยไอน้ำ (H-1911-HEATING-STEA-DN85) — อุณหภูมิสูง', tag: 'ร้อน' },
      { name: 'Holding Tube (10 Length, 300 sec)', desc: 'ท่อ Holding ระยะทางเทียบเท่า 10 ช่วง เวลา 300 วินาที — รักษาอุณหภูมิเพื่อฆ่าเชื้อ', tag: 'ฆ่าเชื้อ' },
      { name: 'PHE Cooling (Chilled Water)', desc: 'ลดอุณหภูมิด้วยน้ำเย็น (V-2601-COOLING-CHWS-2 1/2") — Chilled Water Return/Supply', tag: 'เย็น' },
      { name: 'Condensate System', desc: 'รวบรวม Condensate จาก Steam กลับไปใช้ใหม่ (EG01)', tag: 'ไอน้ำ' },
    ],
    note: 'กระบวนการ: Heat → Hold (300s) → Cool → ส่งต่อ',
  },
  {
    id: 5,
    code: 'STOR',
    title: 'Storage Tank (ถังเก็บ 1 × 3m³)',
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
    items: [
      { name: 'Storage Tank (3m³)', desc: 'ถังเก็บผลิตภัณฑ์พาสเจอไรซ์แล้ว — รอส่งไปไลน์บรรจุ (RND01, RND02)', tag: 'เก็บ' },
      { name: 'Pump GP11 (8,000 LPH)', desc: 'ปั๊มจ่ายจาก Storage Tank ไปไลน์บรรจุ (P-3080)', tag: 'ปั๊ม' },
      { name: 'Level Control', desc: 'ตรวจวัดระดับในถัง — ควบคุมการจ่าย', tag: 'ระดับ' },
    ],
    note: 'Transfer to Filling Line (ลูกศรขวาล่างในแบบ)',
  },
  {
    id: 6,
    code: 'CIP',
    title: 'CIP Kitchen (ห้องเตรียมน้ำยาล้าง)',
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
    items: [
      { name: 'Acid Tank (3m³)', desc: 'ถังน้ำยากรด — Acid Concentrate (C-1001)', tag: 'กรด' },
      { name: 'Caustic Tank (3m³)', desc: 'ถังน้ำยาด่าง — Caustic Concentrate (C-1101)', tag: 'ด่าง' },
      { name: 'Recovery Tank (3m³)', desc: 'ถังรับน้ำยาล้างกลับ — นำกลับมาใช้ใหม่ (RN01)', tag: 'รีไซเคิล' },
      { name: 'CIP Pump GP01 (16,000–18,000 LPH)', desc: 'ปั๊มหลัก CIP — จ่ายน้ำยาแรงดันสูงล้างอุปกรณ์ทั้งระบบ', tag: 'ปั๊ม' },
      { name: 'Steam Heater (H-1901, DN50)', desc: 'ให้ความร้อนน้ำยา CIP ด้วยไอน้ำ', tag: 'ร้อน' },
    ],
    note: 'CIP ล้างทุก Equipment: Mixing Station → Mixing Tanks → Pasteurizer → Storage Tank',
  },
];

const TAG_COLORS: Record<string, { bg: string; color: string }> = {
  น้ำ: { bg: '#e3f2fd', color: '#0d47a1' },
  น้ำตาล: { bg: '#fff8e1', color: '#e65100' },
  เหลว: { bg: '#fce4ec', color: '#880e4f' },
  ซีล: { bg: '#f3e5f5', color: '#6a1b9a' },
  ผสม: { bg: '#e8f5e9', color: '#1b5e20' },
  ร้อน: { bg: '#fff3e0', color: '#bf360c' },
  ปั๊ม: { bg: '#eceff1', color: '#37474f' },
  วาล์ว: { bg: '#e0f2f1', color: '#004d40' },
  บัฟเฟอร์: { bg: '#ede7f6', color: '#4527a0' },
  ฆ่าเชื้อ: { bg: '#ffebee', color: '#b71c1c' },
  เย็น: { bg: '#e1f5fe', color: '#01579b' },
  ไอน้ำ: { bg: '#fafafa', color: '#424242' },
  เก็บ: { bg: '#e0f7fa', color: '#00695c' },
  ระดับ: { bg: '#f1f8e9', color: '#33691e' },
  กรด: { bg: '#fff9c4', color: '#f57f17' },
  ด่าง: { bg: '#e8eaf6', color: '#283593' },
  รีไซเคิล: { bg: '#e8f5e9', color: '#2e7d32' },
  'Tank 1': { bg: '#e3f2fd', color: '#1565c0' },
  'Tank 2': { bg: '#e8eaf6', color: '#1a237e' },
};

const Line4Manual: React.FC<Props> = ({ operatorName, onBackToMain }) => {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div style={{ background: '#f4f6f9', minHeight: '100vh', paddingBottom: '40px' }}>
      {/* Header */}
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
            <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>Mixing → Pasteurizer → Storage → Filling</div>
          </div>
        </div>
        <div style={{
          background: 'rgba(255,255,255,0.15)', borderRadius: '10px',
          padding: '8px 12px', fontSize: '0.72rem', opacity: 0.9,
        }}>
          ผู้ดู: {operatorName} · อ้างอิง P&amp;ID: MIXING TANKS / MIXING STATION / CIP KITCHEN / PASTEURIZER
        </div>
      </div>

      {/* Flow Overview */}
      <div style={{ padding: '16px 14px 0' }}>
        <div style={{ fontSize: '0.7rem', color: '#999', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>ภาพรวมกระบวนการผลิต</div>
        <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', gap: '0', paddingBottom: '6px', WebkitOverflowScrolling: 'touch' as any }}>
          {[
            { label: 'วัตถุดิบ', sub: 'RM', color: '#4a7c59' },
            { label: 'Mixing\nStation', sub: '2', color: '#1565c0' },
            { label: 'Mixing\nTanks', sub: '2×3m³', color: '#01579b' },
            { label: 'Pasteur-\nizer', sub: '4', color: '#b71c1c' },
            { label: 'Storage\nTank', sub: '1×3m³', color: '#004d40' },
            { label: 'Filling\nLine', sub: '→', color: '#37474f' },
          ].map((s, i) => (
            <React.Fragment key={i}>
              <div style={{
                flex: '0 0 auto', textAlign: 'center',
                background: s.color, color: 'white',
                borderRadius: '10px', padding: '8px 10px', minWidth: '58px',
                fontSize: '0.62rem', fontWeight: '700', lineHeight: '1.3',
                whiteSpace: 'pre-line',
              }}>
                {s.label}
                <div style={{ fontSize: '0.55rem', opacity: 0.75, marginTop: '2px' }}>{s.sub}</div>
              </div>
              {i < 5 && (
                <div style={{ color: '#aaa', fontSize: '1rem', flex: '0 0 auto', padding: '0 3px' }}>›</div>
              )}
            </React.Fragment>
          ))}
          <div style={{ flex: '0 0 8px' }}/>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#6a1b9a' }}/>
          <div style={{ fontSize: '0.65rem', color: '#888' }}>CIP Kitchen — ล้างทุกส่วนของระบบหลังเสร็จงาน</div>
        </div>
      </div>

      {/* Step Cards */}
      <div style={{ padding: '12px 14px 0' }}>
        <div style={{ fontSize: '0.7rem', color: '#999', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>รายละเอียดแต่ละขั้นตอน</div>
        {STEPS.map((step) => {
          const isOpen = expanded === step.id;
          return (
            <div key={step.id} style={{
              background: 'white', borderRadius: '14px', marginBottom: '10px',
              boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
              border: `1.5px solid ${isOpen ? step.color : '#eee'}`,
              overflow: 'hidden',
            }}>
              {/* Card Header */}
              <div
                onClick={() => setExpanded(isOpen ? null : step.id)}
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
                  <div style={{ fontSize: '0.65rem', color: '#999', marginTop: '2px' }}>
                    {step.items.length} รายการ · แตะเพื่อดูรายละเอียด
                  </div>
                </div>
                <div style={{
                  color: step.color, fontSize: '1rem', fontWeight: '700',
                  transition: 'transform 0.25s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                }}>▾</div>
              </div>

              {/* Expanded Details */}
              {isOpen && (
                <div style={{ borderTop: `1px solid ${step.bgLight}`, padding: '0 14px 14px' }}>
                  {step.items.map((item, idx) => {
                    const tagStyle = TAG_COLORS[item.tag] || { bg: '#f5f5f5', color: '#555' };
                    return (
                      <div key={idx} style={{
                        paddingTop: '12px',
                        borderTop: idx > 0 ? '1px solid #f0f0f0' : 'none',
                        marginTop: idx > 0 ? '0' : '12px',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                          <span style={{
                            flex: '0 0 auto', background: tagStyle.bg, color: tagStyle.color,
                            fontSize: '0.58rem', fontWeight: '700', padding: '2px 7px',
                            borderRadius: '6px', marginTop: '2px', letterSpacing: '0.04em',
                          }}>{item.tag}</span>
                          <div>
                            <div style={{ fontWeight: '600', fontSize: '0.82rem', color: '#333', lineHeight: 1.3 }}>{item.name}</div>
                            <div style={{ fontSize: '0.73rem', color: '#666', marginTop: '3px', lineHeight: 1.5 }}>{item.desc}</div>
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

      {/* Footer Note */}
      <div style={{ padding: '0 14px', marginTop: '8px' }}>
        <div style={{
          background: '#fff3e0', border: '1px solid #ffe0b2', borderRadius: '12px',
          padding: '12px 14px', fontSize: '0.72rem', color: '#e65100', lineHeight: '1.6',
        }}>
          <div style={{ fontWeight: '700', marginBottom: '4px' }}>⚠️ หน้านี้อยู่ระหว่างการเรียนรู้ระบบ</div>
          ข้อมูลอ้างอิงจาก P&amp;ID ของโรงงาน (Mitr Phol Thailand) — สามารถแก้ไขเพิ่มเติมได้เมื่อเข้าใจกระบวนการมากขึ้น
        </div>
      </div>
    </div>
  );
};

export default Line4Manual;
