import React, { useState } from 'react';

const apiUrl = "https://back-wash-test.onrender.com";

interface MainRowData {
  batch: string;
  rounds: string;
  roOk: boolean;
  misOk: boolean;
  temp90Ok: boolean;
  time15Ok: boolean;
  weightOk: boolean;
  circ30Ok: boolean;
  spray10Ok: boolean;
  ph: string;
  brix: string;
  done: boolean;
}

interface RinseData {
  rounds: string;
  roOk: boolean;
  temp60Ok: boolean;
  time15Ok: boolean;
  circ30Ok: boolean;
  spray10Ok: boolean;
  feed5Ok: boolean;
  ph: string;
  brix: string;
}

interface MixingData {
  roOk: boolean;
  oxoniaOk: boolean;
  time15Ok: boolean;
  circ30Ok: boolean;
  feed5Ok: boolean;
  normal: boolean;
}

interface BackSectionData {
  shift: string;
  roOk: boolean;
  oxoniaOk: boolean;
  feedOk: boolean;
  ph: string;
  brix: string;
}

interface BackData {
  lin134: BackSectionData;
  ml300: BackSectionData;
  lin2: BackSectionData;
}

const defaultMainRow = (): MainRowData => ({
  batch: '', rounds: '', roOk: false, misOk: false, temp90Ok: false,
  time15Ok: false, weightOk: false, circ30Ok: false, spray10Ok: false,
  ph: '', brix: '', done: false,
});

const defaultRinse = (): RinseData => ({
  rounds: '', roOk: false, temp60Ok: false, time15Ok: false,
  circ30Ok: false, spray10Ok: false, feed5Ok: false, ph: '', brix: '',
});

const defaultMixing = (): MixingData => ({
  roOk: false, oxoniaOk: false, time15Ok: false,
  circ30Ok: false, feed5Ok: false, normal: true,
});

const defaultBackSection = (): BackSectionData => ({
  shift: '', roOk: false, oxoniaOk: false, feedOk: false, ph: '', brix: '',
});

const defaultBack = (): BackData => ({
  lin134: defaultBackSection(),
  ml300: defaultBackSection(),
  lin2: defaultBackSection(),
});

interface Props {
  operatorName: string;
  onBackToMain: () => void;
  onStatusChange: (active: boolean) => void;
}

const CipLine1Form: React.FC<Props> = ({ operatorName, onBackToMain, onStatusChange }) => {
  const [tab, setTab] = useState<'front' | 'back'>('front');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [sku, setSku] = useState('');
  const [rows, setRows] = useState<Record<number, MainRowData>>({});
  const [rinse, setRinse] = useState<RinseData>(defaultRinse());
  const [mixing, setMixing] = useState<MixingData>(defaultMixing());
  const [back, setBack] = useState<BackData>(defaultBack());
  const [expanded, setExpanded] = useState<number | null>(null);

  const getOrCreateSession = async () => {
    if (sessionId) return sessionId;
    try {
      const res = await fetch(`${apiUrl}/api/cip-line1/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName, date, sku }),
      });
      const data = await res.json();
      if (data.sessionId) {
        setSessionId(data.sessionId);
        onStatusChange(true);
        return data.sessionId;
      }
    } catch (e) { console.error(e); }
    return null;
  };

  const saveRow = async (rowNo: number, rowData: MainRowData) => {
    const sid = await getOrCreateSession();
    if (!sid) return;
    fetch(`${apiUrl}/api/cip-line1/row`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, rowNo, data: rowData }),
    }).catch(console.error);
  };

  const saveExtra = async (section: string, data: object) => {
    const sid = await getOrCreateSession();
    if (!sid) return;
    fetch(`${apiUrl}/api/cip-line1/extra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, section, data }),
    }).catch(console.error);
  };

  const updateRow = (rowNo: number, field: keyof MainRowData, value: string | boolean) => {
    const newRow = { ...(rows[rowNo] || defaultMainRow()), [field]: value };
    setRows(prev => ({ ...prev, [rowNo]: newRow }));
    saveRow(rowNo, newRow);
  };

  const updateRinse = (field: keyof RinseData, value: string | boolean) => {
    const newRinse = { ...rinse, [field]: value };
    setRinse(newRinse);
    saveExtra('rinse', newRinse);
  };

  const updateMixing = (field: keyof MixingData, value: boolean) => {
    const newMixing = { ...mixing, [field]: value };
    setMixing(newMixing);
    saveExtra('mixing', newMixing);
  };

  const updateBack = (section: keyof BackData, field: keyof BackSectionData, value: string | boolean) => {
    const newBack = { ...back, [section]: { ...back[section], [field]: value } };
    setBack(newBack);
    saveExtra('back', newBack);
  };

  const handleFinish = async () => {
    if (!window.confirm('ยืนยันจบงาน CIP Line 1?')) return;
    const sid = await getOrCreateSession();
    if (!sid) return;
    await fetch(`${apiUrl}/api/cip-line1/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    });
    alert('บันทึก CIP Line 1 สำเร็จ!');
    onStatusChange(false);
    onBackToMain();
  };

  // ── UI helpers ──────────────────────────────────────────────────────────────
  const Toggle = ({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) => (
    <button onClick={onToggle} style={{
      padding: '8px 12px', borderRadius: '20px', border: 'none', cursor: 'pointer',
      fontWeight: 'bold', fontSize: '0.75rem', transition: 'all 0.2s',
      background: checked ? '#1565c0' : '#f0f0f0', color: checked ? 'white' : '#666',
    }}>
      {checked ? '✓ ' : '— '}{label}
    </button>
  );

  const OptionPicker = ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) => (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {options.map(opt => (
        <button key={opt} onClick={() => onChange(opt === value ? '' : opt)} style={{
          padding: '7px 14px', borderRadius: '15px', border: '2px solid',
          borderColor: value === opt ? '#1565c0' : '#ddd',
          background: value === opt ? '#1565c0' : 'white',
          color: value === opt ? 'white' : '#666',
          cursor: 'pointer', fontSize: '0.8rem', fontWeight: 'bold',
        }}>{opt}</button>
      ))}
    </div>
  );

  const inputStyle = (warn?: boolean): React.CSSProperties => ({
    width: '100%', padding: '8px', borderRadius: '8px',
    border: `1px solid ${warn ? '#d32f2f' : '#ddd'}`,
    marginTop: '4px', fontSize: '0.9rem', boxSizing: 'border-box',
  });

  const labelStyle: React.CSSProperties = { fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: '2px' };
  const accent = '#1565c0';

  const SectionCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: 'white', borderRadius: '15px', padding: '15px', marginBottom: '15px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
      <h4 style={{ margin: '0 0 12px 0', color: accent, borderBottom: `2px solid ${accent}`, paddingBottom: '8px', fontSize: '0.95rem' }}>{title}</h4>
      {children}
    </div>
  );

  // ── Front Page ───────────────────────────────────────────────────────────────
  const renderFront = () => (
    <div>
      <SectionCard title="ข้อมูลทั่วไป">
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>วันที่ตรวจสอบ</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle()} />
        </div>
        <div>
          <label style={labelStyle}>SKU</label>
          <OptionPicker value={sku} onChange={setSku} options={['Golden syrup', 'Amazon syrup', 'FDS']} />
        </div>
      </SectionCard>

      {/* Main rows NO.1–7 */}
      <div style={{ background: '#e3f2fd', borderRadius: '10px', padding: '8px 12px', marginBottom: '10px' }}>
        <span style={{ fontWeight: 'bold', color: accent, fontSize: '0.9rem' }}>รายการ CIP หลัก (NO.1–7)</span>
        <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '2px' }}>อุณหภูมิ 90-100°C / น้ำ RO 1.1 ถัน / MIS LIQUID 38.5 Kg</div>
      </div>

      {Array.from({ length: 7 }, (_, i) => i + 1).map(no => {
        const row = rows[no] || defaultMainRow();
        const isExp = expanded === no;
        const phWarn = row.ph !== '' && (parseFloat(row.ph) < 6.5 || parseFloat(row.ph) > 8.5);
        return (
          <div key={no} style={{ background: 'white', borderRadius: '15px', marginBottom: '8px', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', border: row.done ? `2px solid ${accent}` : '1px solid #eee' }}>
            <div onClick={() => setExpanded(isExp ? null : no)} style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', background: row.done ? '#e3f2fd' : 'white' }}>
              <span style={{ fontWeight: 'bold', color: row.done ? accent : '#333', fontSize: '0.95rem' }}>
                {row.done ? '✅ ' : '⬜ '}NO.{no}{row.batch ? ` — ${row.batch}` : ''}
              </span>
              <span style={{ color: '#bbb', fontSize: '0.8rem' }}>{isExp ? '▲' : '▼'}</span>
            </div>

            {isExp && (
              <div style={{ padding: '15px', borderTop: '1px solid #f5f5f5' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                  <div><label style={labelStyle}>กระวล (Batch)</label><input type="text" value={row.batch} onChange={e => updateRow(no, 'batch', e.target.value)} placeholder="Batch" style={inputStyle()} /></div>
                  <div><label style={labelStyle}>จำนวนรอบ</label><input type="number" value={row.rounds} onChange={e => updateRow(no, 'rounds', e.target.value)} placeholder="รอบ" style={inputStyle()} /></div>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                  <Toggle checked={row.roOk} onToggle={() => updateRow(no, 'roOk', !row.roOk)} label="น้ำ RO 1.1 ถัน" />
                  <Toggle checked={row.misOk} onToggle={() => updateRow(no, 'misOk', !row.misOk)} label="MIS LIQUID 38.5 Kg" />
                  <Toggle checked={row.temp90Ok} onToggle={() => updateRow(no, 'temp90Ok', !row.temp90Ok)} label="อุณหภูมิ 90-100°C" />
                  <Toggle checked={row.time15Ok} onToggle={() => updateRow(no, 'time15Ok', !row.time15Ok)} label="เวลา 15 นาที" />
                  <Toggle checked={row.weightOk} onToggle={() => updateRow(no, 'weightOk', !row.weightOk)} label="Weight tank 10 นาที × 3 ครั้ง" />
                  <Toggle checked={row.circ30Ok} onToggle={() => updateRow(no, 'circ30Ok', !row.circ30Ok)} label="Circulate ถัง 2 + Plate cooling 30 นาที" />
                  <Toggle checked={row.spray10Ok} onToggle={() => updateRow(no, 'spray10Ok', !row.spray10Ok)} label="Spray ถัง Storage 10 นาที" />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '15px' }}>
                  <div>
                    <label style={labelStyle}>pH (6.5–8.5)</label>
                    <input type="number" step="0.1" value={row.ph} onChange={e => updateRow(no, 'ph', e.target.value)} placeholder="pH" style={inputStyle(phWarn)} />
                    {phWarn && <div style={{ color: '#d32f2f', fontSize: '0.7rem' }}>⚠️ ค่า pH ผิดปกติ</div>}
                  </div>
                  <div>
                    <label style={labelStyle}>Brix (0)</label>
                    <input type="number" step="0.1" value={row.brix} onChange={e => updateRow(no, 'brix', e.target.value)} placeholder="Brix" style={inputStyle()} />
                  </div>
                </div>

                <button onClick={() => { updateRow(no, 'done', !row.done); setExpanded(null); }} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: 'none', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.9rem', background: row.done ? '#f5f5f5' : `linear-gradient(135deg, ${accent}, #0d47a1)`, color: row.done ? '#666' : 'white' }}>
                  {row.done ? '↩ ยกเลิก' : '✅ เสร็จสิ้นแถวนี้'}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* ล้างหลังการผลิต (60°C) */}
      <div style={{ background: '#fff3e0', borderRadius: '10px', padding: '8px 12px', margin: '15px 0 10px 0' }}>
        <span style={{ fontWeight: 'bold', color: '#e65100', fontSize: '0.9rem' }}>ล้างหลังการผลิต (60°C)</span>
        <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '2px' }}>หากรายที่ 4 ค่าดีแล้ว ให้ต้มน้ำต่อที่ 60°C</div>
      </div>
      <div style={{ background: 'white', borderRadius: '15px', padding: '15px', marginBottom: '15px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', border: '1px solid #ffe0b2' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
          <div><label style={labelStyle}>จำนวนรอบ</label><input type="number" value={rinse.rounds} onChange={e => updateRinse('rounds', e.target.value)} placeholder="รอบ" style={inputStyle()} /></div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          <Toggle checked={rinse.roOk} onToggle={() => updateRinse('roOk', !rinse.roOk)} label="น้ำ RO 1.1 ถัน" />
          <Toggle checked={rinse.temp60Ok} onToggle={() => updateRinse('temp60Ok', !rinse.temp60Ok)} label="อุณหภูมิ 60°C" />
          <Toggle checked={rinse.time15Ok} onToggle={() => updateRinse('time15Ok', !rinse.time15Ok)} label="เวลา Circulate Mixing 15 นาที" />
          <Toggle checked={rinse.circ30Ok} onToggle={() => updateRinse('circ30Ok', !rinse.circ30Ok)} label="Circulate ถัง 2 + Plate cooling 30 นาที" />
          <Toggle checked={rinse.spray10Ok} onToggle={() => updateRinse('spray10Ok', !rinse.spray10Ok)} label="Spray ถัง Storage 10 นาที" />
          <Toggle checked={rinse.feed5Ok} onToggle={() => updateRinse('feed5Ok', !rinse.feed5Ok)} label="ผ่านหัวบรรจุ 5 นาที" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={labelStyle}>pH (6.5–8.5)</label>
            <input type="number" step="0.1" value={rinse.ph} onChange={e => updateRinse('ph', e.target.value)} placeholder="pH" style={inputStyle(rinse.ph !== '' && (parseFloat(rinse.ph) < 6.5 || parseFloat(rinse.ph) > 8.5))} />
          </div>
          <div>
            <label style={labelStyle}>Brix (0)</label>
            <input type="number" step="0.1" value={rinse.brix} onChange={e => updateRinse('brix', e.target.value)} placeholder="Brix" style={inputStyle()} />
          </div>
        </div>
      </div>

      {/* ถัง Mixing */}
      <div style={{ background: '#f3e5f5', borderRadius: '10px', padding: '8px 12px', marginBottom: '10px' }}>
        <span style={{ fontWeight: 'bold', color: '#6a1b9a', fontSize: '0.9rem' }}>CIP ถัง Mixing (น้ำ RO 500L / Oxonia 1000ml)</span>
      </div>
      <div style={{ background: 'white', borderRadius: '15px', padding: '15px', marginBottom: '15px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', border: '1px solid #e1bee7' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          <Toggle checked={mixing.roOk} onToggle={() => updateMixing('roOk', !mixing.roOk)} label="น้ำ RO 500L" />
          <Toggle checked={mixing.oxoniaOk} onToggle={() => updateMixing('oxoniaOk', !mixing.oxoniaOk)} label="Oxonia 1000ml" />
          <Toggle checked={mixing.time15Ok} onToggle={() => updateMixing('time15Ok', !mixing.time15Ok)} label="เวลา Circulate Mixing 15 นาที" />
          <Toggle checked={mixing.circ30Ok} onToggle={() => updateMixing('circ30Ok', !mixing.circ30Ok)} label="Circulate ถัง 2 + Plate cooling 30 นาที" />
          <Toggle checked={mixing.feed5Ok} onToggle={() => updateMixing('feed5Ok', !mixing.feed5Ok)} label="Feed หัวบรรจุ 5 นาที" />
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => updateMixing('normal', true)} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '2px solid', borderColor: mixing.normal ? '#4caf50' : '#ddd', background: mixing.normal ? '#e8f5e9' : 'white', fontWeight: 'bold', color: mixing.normal ? '#2e7d32' : '#666', cursor: 'pointer' }}>✓ ตรวจตอบปกติ</button>
          <button onClick={() => updateMixing('normal', false)} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '2px solid', borderColor: !mixing.normal ? '#d32f2f' : '#ddd', background: !mixing.normal ? '#ffebee' : 'white', fontWeight: 'bold', color: !mixing.normal ? '#d32f2f' : '#666', cursor: 'pointer' }}>✗ ไม่ปกติ</button>
        </div>
      </div>
    </div>
  );

  // ── Back Page ────────────────────────────────────────────────────────────────
  const renderBack = () => {
    const sections: { key: keyof BackData; title: string; roLabel: string; oxoniaLabel: string }[] = [
      { key: 'lin134', title: 'CIP เครื่องบรรจุ Linear 1 / Linear 3 / Linear 4', roLabel: 'น้ำ RO 120L', oxoniaLabel: 'Oxonia 240ml (0.2%)' },
      { key: 'ml300', title: 'CIP เครื่องบรรจุ 300 ml', roLabel: 'น้ำ RO 30L', oxoniaLabel: 'Oxonia 60ml (0.2%)' },
      { key: 'lin2', title: 'CIP เครื่องบรรจุ Linear 2', roLabel: 'น้ำ RO 80L', oxoniaLabel: 'Oxonia 160ml (0.2%)' },
    ];

    return (
      <div>
        {sections.map(({ key, title, roLabel, oxoniaLabel }) => {
          const sec = back[key];
          const phWarn = sec.ph !== '' && (parseFloat(sec.ph) < 6.5 || parseFloat(sec.ph) > 8.5);
          return (
            <div key={key} style={{ background: 'white', borderRadius: '15px', padding: '15px', marginBottom: '15px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
              <h4 style={{ margin: '0 0 12px 0', color: accent, borderBottom: `2px solid ${accent}`, paddingBottom: '8px', fontSize: '0.9rem' }}>{title}</h4>
              <div style={{ marginBottom: '10px' }}>
                <label style={labelStyle}>กะ/เวลา</label>
                <input type="text" value={sec.shift} onChange={e => updateBack(key, 'shift', e.target.value)} placeholder="กะ/เวลา" style={inputStyle()} />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                <Toggle checked={sec.roOk} onToggle={() => updateBack(key, 'roOk', !sec.roOk)} label={roLabel} />
                <Toggle checked={sec.oxoniaOk} onToggle={() => updateBack(key, 'oxoniaOk', !sec.oxoniaOk)} label={oxoniaLabel} />
                <Toggle checked={sec.feedOk} onToggle={() => updateBack(key, 'feedOk', !sec.feedOk)} label="Feeding ผ่านหัวบรรจุ 15 นาที" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={labelStyle}>pH (6.5–8.5)</label>
                  <input type="number" step="0.1" value={sec.ph} onChange={e => updateBack(key, 'ph', e.target.value)} placeholder="pH" style={inputStyle(phWarn)} />
                  {phWarn && <div style={{ color: '#d32f2f', fontSize: '0.7rem' }}>⚠️ pH ผิดปกติ</div>}
                </div>
                <div>
                  <label style={labelStyle}>Brix (0)</label>
                  <input type="number" step="0.1" value={sec.brix} onChange={e => updateBack(key, 'brix', e.target.value)} placeholder="Brix" style={inputStyle()} />
                </div>
              </div>
            </div>
          );
        })}

        <button onClick={handleFinish} style={{ width: '100%', padding: '16px', background: `linear-gradient(135deg, ${accent}, #0d47a1)`, color: 'white', border: 'none', borderRadius: '15px', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer', boxShadow: '0 6px 15px rgba(21,101,192,0.3)', marginBottom: '20px' }}>
          🏁 จบงาน CIP Line 1
        </button>
      </div>
    );
  };

  const doneCount = Object.values(rows).filter(r => r.done).length;

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', padding: '15px 15px 100px 15px' }}>
      <div style={{ background: `linear-gradient(135deg, ${accent}, #0d47a1)`, borderRadius: '15px', padding: '15px', marginBottom: '15px', color: 'white', textAlign: 'center' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>📋 CIP Line 1 Syrup</h2>
        <div style={{ fontSize: '0.85rem', opacity: 0.9, marginTop: '4px' }}>ผู้บันทึก: {operatorName}</div>
      </div>

      <div style={{ display: 'flex', marginBottom: '15px', background: '#f5f5f5', borderRadius: '12px', padding: '4px' }}>
        <button onClick={() => setTab('front')} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: tab === 'front' ? 'white' : 'transparent', color: tab === 'front' ? accent : '#888', boxShadow: tab === 'front' ? '0 2px 6px rgba(0,0,0,0.1)' : 'none' }}>
          หน้าแรก ({doneCount}/7)
        </button>
        <button onClick={() => setTab('back')} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: tab === 'back' ? 'white' : 'transparent', color: tab === 'back' ? accent : '#888', boxShadow: tab === 'back' ? '0 2px 6px rgba(0,0,0,0.1)' : 'none' }}>
          หน้าหลัง (เครื่องบรรจุ)
        </button>
      </div>

      {tab === 'front' ? renderFront() : renderBack()}

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'white', padding: '12px 15px', borderTop: `2px solid ${accent}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 100 }}>
        <button onClick={onBackToMain} style={{ background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '10px', padding: '10px 16px', fontSize: '0.85rem', cursor: 'pointer', color: '#666', fontWeight: 'bold' }}>🔙 เมนูหลัก</button>
        <div style={{ fontSize: '0.85rem', color: accent, fontWeight: 'bold' }}>✅ {doneCount}/7</div>
      </div>
    </div>
  );
};

export default CipLine1Form;
