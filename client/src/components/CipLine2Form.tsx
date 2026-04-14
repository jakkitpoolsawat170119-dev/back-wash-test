import React, { useState } from 'react';

const apiUrl = "https://back-wash-test.onrender.com";

interface RowData {
  mipLiquid: string;
  pump1Pressure: string;
  pump2Pressure: string;
  excelerate1: string;
  ph: string;
  brix: string;
  startTime: string;
  startRaw: number;
  endTime: string;
  duration: number;
  done: boolean;
}

interface BackData {
  a1_shift: string; a1_ro: boolean; a1_oxonia: boolean; a1_time: boolean; a1_ph: string; a1_normal: boolean;
  a2_shift: string; a2_ro: boolean; a2_oxonia: boolean; a2_time: boolean; a2_ph: string; a2_normal: boolean;
  mix_shift: string; mix_temp: boolean; mix_time: boolean; mix_pump1: string; mix_circ: boolean;
  mix_pump2: string; mix_spray: boolean; mix_feed: boolean; mix_ph: string; mix_brix: string;
  hard_boil_shift: string; hard_boil_val: string;
  hard_cool_shift: string; hard_cool_val: string;
  hard_stor_shift: string; hard_stor_val: string;
}

const defaultRow = (): RowData => ({
  mipLiquid: '', pump1Pressure: '', pump2Pressure: '',
  excelerate1: '', ph: '', brix: '',
  startTime: '', startRaw: 0, endTime: '', duration: 0,
  done: false,
});

const defaultBack = (): BackData => ({
  a1_shift: '', a1_ro: false, a1_oxonia: false, a1_time: false, a1_ph: '', a1_normal: true,
  a2_shift: '', a2_ro: false, a2_oxonia: false, a2_time: false, a2_ph: '', a2_normal: true,
  mix_shift: '', mix_temp: false, mix_time: false, mix_pump1: '', mix_circ: false,
  mix_pump2: '', mix_spray: false, mix_feed: false, mix_ph: '', mix_brix: '',
  hard_boil_shift: '', hard_boil_val: '',
  hard_cool_shift: '', hard_cool_val: '',
  hard_stor_shift: '', hard_stor_val: '',
});

interface Props {
  operatorName: string;
  onBackToMain: () => void;
  onStatusChange: (active: boolean) => void;
}

const CipLine2Form: React.FC<Props> = ({ operatorName, onBackToMain, onStatusChange }) => {
  const [tab, setTab] = useState<'front' | 'back'>('front');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [sku, setSku] = useState('');
  const [line, setLine] = useState('');
  const [flavor, setFlavor] = useState('');
  const [rows, setRows] = useState<Record<number, RowData>>({});
  const [back, setBack] = useState<BackData>(defaultBack());
  const [currentNo, setCurrentNo] = useState(1);

  const getOrCreateSession = async () => {
    if (sessionId) return sessionId;
    try {
      const res = await fetch(`${apiUrl}/api/cip-line2/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName, date, sku, line, flavor }),
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

  const saveRow = async (rowNo: number, rowData: RowData) => {
    const sid = await getOrCreateSession();
    if (!sid) return;
    fetch(`${apiUrl}/api/cip-line2/row`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, rowNo, data: rowData }),
    }).catch(console.error);
  };

  const saveBack = async (backData: BackData) => {
    const sid = await getOrCreateSession();
    if (!sid) return;
    fetch(`${apiUrl}/api/cip-line2/back`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, data: backData }),
    }).catch(console.error);
  };

  const updateRow = (rowNo: number, field: keyof RowData, value: string | boolean | number) => {
    const newRow = { ...(rows[rowNo] || defaultRow()), [field]: value };
    setRows(prev => ({ ...prev, [rowNo]: newRow }));
    saveRow(rowNo, newRow);
  };

  const handleRowStart = (rowNo: number) => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    const newRow = { ...(rows[rowNo] || defaultRow()), startTime: timeStr, startRaw: now.getTime(), endTime: '', duration: 0 };
    setRows(prev => ({ ...prev, [rowNo]: newRow }));
    saveRow(rowNo, newRow);
  };

  const handleRowStop = (rowNo: number) => {
    const row = rows[rowNo] || defaultRow();
    if (!row.startRaw) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    const duration = Math.round((now.getTime() - row.startRaw) / 60000);
    const newRow = { ...row, endTime: timeStr, duration };
    setRows(prev => ({ ...prev, [rowNo]: newRow }));
    saveRow(rowNo, newRow);
  };

  const updateBack = (field: keyof BackData, value: string | boolean) => {
    const newBack = { ...back, [field]: value };
    setBack(newBack);
    saveBack(newBack);
  };

  const handleFinish = async () => {
    if (!window.confirm('ยืนยันจบงาน CIP Line 2?')) return;
    const sid = await getOrCreateSession();
    if (!sid) return;
    await fetch(`${apiUrl}/api/cip-line2/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    });
    alert('บันทึก CIP Line 2 สำเร็จ!');
    onStatusChange(false);
    onBackToMain();
  };

  // ── UI helpers ──────────────────────────────────────────────────────────────
  const Toggle = ({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) => (
    <button onClick={onToggle} style={{
      padding: '8px 12px', borderRadius: '20px', border: 'none', cursor: 'pointer',
      fontWeight: 'bold', fontSize: '0.75rem', transition: 'all 0.2s',
      background: checked ? '#4caf50' : '#f0f0f0', color: checked ? 'white' : '#666',
    }}>
      {checked ? '✓ ' : '— '}{label}
    </button>
  );

  const OptionPicker = ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) => (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {options.map(opt => (
        <button key={opt} onClick={() => onChange(opt === value ? '' : opt)} style={{
          padding: '7px 14px', borderRadius: '15px', border: '2px solid',
          borderColor: value === opt ? '#ff6b00' : '#ddd',
          background: value === opt ? '#ff6b00' : 'white',
          color: value === opt ? 'white' : '#666',
          cursor: 'pointer', fontSize: '0.8rem', fontWeight: 'bold',
        }}>{opt}</button>
      ))}
    </div>
  );

  const inputStyle = (warn?: boolean): React.CSSProperties => ({
    width: '100%', padding: '8px', borderRadius: '8px', border: `1px solid ${warn ? '#d32f2f' : '#ddd'}`,
    marginTop: '4px', fontSize: '0.9rem', boxSizing: 'border-box',
  });

  const labelStyle: React.CSSProperties = { fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: '2px' };

  const SectionCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: 'white', borderRadius: '15px', padding: '15px', marginBottom: '15px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
      <h4 style={{ margin: '0 0 12px 0', color: '#ff6b00', borderBottom: '2px solid #ff6b00', paddingBottom: '8px', fontSize: '0.95rem' }}>{title}</h4>
      {children}
    </div>
  );

  const NormalToggle = ({ normal, onChange }: { normal: boolean; onChange: (v: boolean) => void }) => (
    <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
      <button onClick={() => onChange(true)} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '2px solid', borderColor: normal ? '#4caf50' : '#ddd', background: normal ? '#e8f5e9' : 'white', fontWeight: 'bold', color: normal ? '#2e7d32' : '#666', cursor: 'pointer' }}>✓ ปกติ</button>
      <button onClick={() => onChange(false)} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '2px solid', borderColor: !normal ? '#d32f2f' : '#ddd', background: !normal ? '#ffebee' : 'white', fontWeight: 'bold', color: !normal ? '#d32f2f' : '#666', cursor: 'pointer' }}>✗ ไม่ปกติ</button>
    </div>
  );

  // ── Front Page ───────────────────────────────────────────────────────────────
  const renderFront = () => {
    const row = rows[currentNo] || defaultRow();
    const phWarn = row.ph !== '' && (parseFloat(row.ph) < 6.5 || parseFloat(row.ph) > 8.5);
    const totalBatches = 20;
    const doneCount = Object.values(rows).filter(r => r.done).length;

    return (
      <div>
        {/* ── ข้อมูลทั่วไป ── */}
        <SectionCard title="ข้อมูลทั่วไป">
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>วันที่ตรวจสอบ</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle()} />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>SKU</label>
            <OptionPicker value={sku} onChange={setSku} options={['Freshy', 'Senorita', 'Senorita Signature']} />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Line</label>
            <OptionPicker value={line} onChange={setLine} options={['Line 2', 'Line 3']} />
          </div>
          <div>
            <label style={labelStyle}>กลิ่นที่ผลิต</label>
            <select value={flavor} onChange={e => setFlavor(e.target.value)} style={inputStyle()}>
              <option value="">-- เลือกกลิ่น --</option>
              {[
                "Amazon", "FDS", "Golden", "Freshy Lychee", "Freshy Strawberry",
                "Senorita Coconut", "Senorita Caramel", "Freshy Blue Hawaii", "Freshy Lime",
                "CIP", "ว่าง", "Freshy Green Apple", "Freshy Sala", "Senorita Yuzu",
                "MLH 02", "Freshy Pineapple", "Operator Name", "Freshy Grape",
                "Freshy Punch", "Freshy blue Lemon", "Senorita Fres Mint",
                "Freshy Orange", "Signature Rose",
              ].map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </SectionCard>

        {/* ── Progress bar ── */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#888', marginBottom: '6px' }}>
            <span>เสร็จแล้ว {doneCount}/{totalBatches} Batch</span>
            <span>{Math.round((doneCount / totalBatches) * 100)}%</span>
          </div>
          <div style={{ background: '#eee', borderRadius: '10px', height: '8px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(doneCount / totalBatches) * 100}%`, background: 'linear-gradient(90deg, #ff6b00, #ff9800)', borderRadius: '10px', transition: 'width 0.4s' }} />
          </div>
          {/* Batch dots */}
          <div style={{ display: 'flex', gap: '4px', marginTop: '8px', flexWrap: 'wrap' }}>
            {Array.from({ length: totalBatches }, (_, i) => i + 1).map(no => (
              <div
                key={no}
                onClick={() => setCurrentNo(no)}
                style={{
                  width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.65rem', fontWeight: 'bold', transition: 'all 0.2s',
                  background: no === currentNo ? '#ff6b00' : (rows[no]?.done ? '#4caf50' : '#f0f0f0'),
                  color: no === currentNo || rows[no]?.done ? 'white' : '#999',
                  border: no === currentNo ? '2px solid #e65100' : '2px solid transparent',
                  boxShadow: no === currentNo ? '0 2px 8px rgba(255,107,0,0.4)' : 'none',
                }}
              >
                {no}
              </div>
            ))}
          </div>
        </div>

        {/* ── Batch card ── */}
        {(() => {
          const isComplete = row.mipLiquid !== '' &&
            row.pump1Pressure !== '' && row.pump2Pressure !== '' &&
            row.excelerate1 !== '' && row.ph !== '' && row.brix !== '' &&
            row.startTime !== '' && row.endTime !== '';
          const missingFields = [
            !row.startTime && 'เวลาเริ่ม',
            !row.endTime && 'เวลาเสร็จ',
            !row.mipLiquid && 'MIP Liquid',
            !row.pump1Pressure && 'แรงดัน Pump 1',
            !row.pump2Pressure && 'แรงดัน Pump 2',
            !row.excelerate1 && 'Excelerate',
            !row.ph && 'pH',
            !row.brix && 'Brix',
          ].filter(Boolean);

          return (
            <div style={{ background: 'white', borderRadius: '18px', padding: '18px', boxShadow: '0 4px 15px rgba(0,0,0,0.08)', border: row.done ? '2px solid #4caf50' : '2px solid #ff6b00', marginBottom: '16px' }}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div style={{ background: row.done ? '#4caf50' : '#ff6b00', color: 'white', borderRadius: '12px', padding: '6px 16px', fontWeight: 'bold', fontSize: '1rem' }}>
                  {row.done ? '✅' : '🔥'} NO.{currentNo}
                </div>
                <div style={{ fontSize: '0.8rem', color: '#aaa' }}>{currentNo} / {totalBatches}</div>
              </div>

              {/* ── Start / Stop ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '14px' }}>
                <button
                  onClick={() => handleRowStart(currentNo)}
                  disabled={!!row.startTime}
                  style={{ padding: '12px 8px', borderRadius: '12px', border: 'none', fontWeight: 'bold', fontSize: '0.85rem', cursor: row.startTime ? 'default' : 'pointer', background: row.startTime ? '#e8f5e9' : 'linear-gradient(135deg, #4caf50, #2e7d32)', color: row.startTime ? '#2e7d32' : 'white' }}
                >
                  {row.startTime ? `▶ ${row.startTime}` : '▶ Start'}
                </button>
                <button
                  onClick={() => handleRowStop(currentNo)}
                  disabled={!row.startTime || !!row.endTime}
                  style={{ padding: '12px 8px', borderRadius: '12px', border: 'none', fontWeight: 'bold', fontSize: '0.85rem', cursor: (!row.startTime || row.endTime) ? 'default' : 'pointer', background: row.endTime ? '#ffebee' : !row.startTime ? '#f5f5f5' : 'linear-gradient(135deg, #f44336, #c62828)', color: row.endTime ? '#c62828' : !row.startTime ? '#ccc' : 'white' }}
                >
                  {row.endTime ? `⏹ ${row.endTime}` : '⏹ Stop'}
                </button>
              </div>

              {/* รวมเวลา */}
              {row.duration > 0 && (
                <div style={{ textAlign: 'center', background: '#fff3e0', borderRadius: '10px', padding: '8px', marginBottom: '12px', fontWeight: 'bold', color: '#e65100', fontSize: '0.9rem' }}>
                  ⏱ รวมเวลา: {row.duration} นาที
                </div>
              )}

              {/* MIP Liquid */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>MIP LIQUID (kg)</label>
                <OptionPicker value={row.mipLiquid} onChange={v => updateRow(currentNo, 'mipLiquid', v)} options={['17.5', '38.5']} />
              </div>

              {/* แรงดันปั๊ม */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <label style={labelStyle}>แรงดัน Pump No.1 (Bar)</label>
                  <input type="number" value={row.pump1Pressure} onChange={e => updateRow(currentNo, 'pump1Pressure', e.target.value)} placeholder="Bar" style={inputStyle()} />
                </div>
                <div>
                  <label style={labelStyle}>แรงดัน Pump No.2 (Bar)</label>
                  <input type="number" value={row.pump2Pressure} onChange={e => updateRow(currentNo, 'pump2Pressure', e.target.value)} placeholder="Bar" style={inputStyle()} />
                </div>
              </div>

              {/* Excelerate */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>EXCELERATE HS-1 (kg)</label>
                <OptionPicker value={row.excelerate1} onChange={v => updateRow(currentNo, 'excelerate1', v)} options={['5', '11']} />
              </div>

              {/* Brix & pH */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
                <div>
                  <label style={labelStyle}>pH (6.5–8.5)</label>
                  <input type="number" step="0.1" value={row.ph} onChange={e => updateRow(currentNo, 'ph', e.target.value)} placeholder="pH" style={inputStyle(phWarn)} />
                  {phWarn && <div style={{ color: '#d32f2f', fontSize: '0.7rem' }}>⚠️ ผิดปกติ</div>}
                </div>
                <div>
                  <label style={labelStyle}>Brix</label>
                  <input type="number" step="0.1" value={row.brix} onChange={e => updateRow(currentNo, 'brix', e.target.value)} placeholder="Brix" style={inputStyle()} />
                </div>
              </div>

              {/* แสดง field ที่ยังไม่กรอก */}
              {!isComplete && !row.done && (
                <div style={{ background: '#fff8e1', border: '1px solid #ffe082', borderRadius: '10px', padding: '10px 12px', marginBottom: '12px', fontSize: '0.78rem', color: '#f57f17' }}>
                  ⚠️ กรุณากรอกให้ครบ: <strong>{missingFields.join(', ')}</strong>
                </div>
              )}

              {/* Done button */}
              <button
                disabled={!isComplete && !row.done}
                onClick={() => {
                  updateRow(currentNo, 'done', !row.done);
                  if (!row.done && currentNo < totalBatches) setCurrentNo(currentNo + 1);
                }}
                style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', fontWeight: 'bold', fontSize: '0.95rem', cursor: isComplete || row.done ? 'pointer' : 'not-allowed', background: row.done ? '#f5f5f5' : isComplete ? 'linear-gradient(135deg, #4caf50, #2e7d32)' : '#e0e0e0', color: row.done ? '#666' : isComplete ? 'white' : '#aaa' }}
              >
                {row.done ? '↩ ยกเลิก' : isComplete ? '✅ เสร็จสิ้น Batch นี้ →' : '🔒 กรอกข้อมูลให้ครบก่อน'}
              </button>
            </div>
          );
        })()}

        {/* ── Prev / Next ── */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
          <button
            onClick={() => setCurrentNo(prev => Math.max(1, prev - 1))}
            disabled={currentNo === 1}
            style={{ flex: 1, padding: '12px', borderRadius: '12px', border: '2px solid #eee', background: currentNo === 1 ? '#f9f9f9' : 'white', color: currentNo === 1 ? '#ccc' : '#ff6b00', fontWeight: 'bold', cursor: currentNo === 1 ? 'default' : 'pointer', fontSize: '0.9rem' }}
          >
            ◀ Batch ก่อนหน้า
          </button>
          <button
            onClick={() => setCurrentNo(prev => Math.min(totalBatches, prev + 1))}
            disabled={currentNo === totalBatches}
            style={{ flex: 1, padding: '12px', borderRadius: '12px', border: '2px solid #eee', background: currentNo === totalBatches ? '#f9f9f9' : 'white', color: currentNo === totalBatches ? '#ccc' : '#ff6b00', fontWeight: 'bold', cursor: currentNo === totalBatches ? 'default' : 'pointer', fontSize: '0.9rem' }}
          >
            Batch ถัดไป ▶
          </button>
        </div>
      </div>
    );
  };

  // ── Back Page ────────────────────────────────────────────────────────────────
  const renderBack = () => (
    <div>
      <SectionCard title="เครื่องบรรจุแต่งชิ้น A1 (น้ำ RO 200L / Oxonia 400ml)">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
          <div><label style={labelStyle}>กะ/เวลา</label><input type="text" value={back.a1_shift} onChange={e => updateBack('a1_shift', e.target.value)} placeholder="กะ/เวลา" style={inputStyle()} /></div>
          <div><label style={labelStyle}>pH</label><input type="number" step="0.1" value={back.a1_ph} onChange={e => updateBack('a1_ph', e.target.value)} placeholder="pH" style={inputStyle()} /></div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
          <Toggle checked={back.a1_ro} onToggle={() => updateBack('a1_ro', !back.a1_ro)} label="น้ำ RO 200L" />
          <Toggle checked={back.a1_oxonia} onToggle={() => updateBack('a1_oxonia', !back.a1_oxonia)} label="Oxonia 400ml" />
          <Toggle checked={back.a1_time} onToggle={() => updateBack('a1_time', !back.a1_time)} label="เวลา 1.5 นาที" />
        </div>
        <NormalToggle normal={back.a1_normal} onChange={v => updateBack('a1_normal', v)} />
      </SectionCard>

      <SectionCard title="เครื่องบรรจุแต่งชิ้น A2 (น้ำ RO 100L / Oxonia 200ml)">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
          <div><label style={labelStyle}>กะ/เวลา</label><input type="text" value={back.a2_shift} onChange={e => updateBack('a2_shift', e.target.value)} placeholder="กะ/เวลา" style={inputStyle()} /></div>
          <div><label style={labelStyle}>pH</label><input type="number" step="0.1" value={back.a2_ph} onChange={e => updateBack('a2_ph', e.target.value)} placeholder="pH" style={inputStyle()} /></div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
          <Toggle checked={back.a2_ro} onToggle={() => updateBack('a2_ro', !back.a2_ro)} label="น้ำ RO 100L" />
          <Toggle checked={back.a2_oxonia} onToggle={() => updateBack('a2_oxonia', !back.a2_oxonia)} label="Oxonia 200ml" />
          <Toggle checked={back.a2_time} onToggle={() => updateBack('a2_time', !back.a2_time)} label="เวลา 1.5 นาที" />
        </div>
        <NormalToggle normal={back.a2_normal} onChange={v => updateBack('a2_normal', v)} />
      </SectionCard>

      <SectionCard title="อุณหภูมิและเวลาถัง Mixing (น้ำ RO 1 ถัน / 60°C)">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
          <div><label style={labelStyle}>กะ/เวลา</label><input type="text" value={back.mix_shift} onChange={e => updateBack('mix_shift', e.target.value)} placeholder="กะ/เวลา" style={inputStyle()} /></div>
          <div><label style={labelStyle}>แรงดัน Pump 1</label><input type="number" value={back.mix_pump1} onChange={e => updateBack('mix_pump1', e.target.value)} placeholder="Bar" style={inputStyle()} /></div>
          <div><label style={labelStyle}>แรงดัน Pump 2</label><input type="number" value={back.mix_pump2} onChange={e => updateBack('mix_pump2', e.target.value)} placeholder="Bar" style={inputStyle()} /></div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
          <Toggle checked={back.mix_temp} onToggle={() => updateBack('mix_temp', !back.mix_temp)} label="อุณหภูมิ 60°C" />
          <Toggle checked={back.mix_time} onToggle={() => updateBack('mix_time', !back.mix_time)} label="เวลา 10 นาที" />
          <Toggle checked={back.mix_circ} onToggle={() => updateBack('mix_circ', !back.mix_circ)} label="Circulate + Plate cooling 30 นาที" />
          <Toggle checked={back.mix_spray} onToggle={() => updateBack('mix_spray', !back.mix_spray)} label="Spray ถัง 3 — 10 นาที" />
          <Toggle checked={back.mix_feed} onToggle={() => updateBack('mix_feed', !back.mix_feed)} label="ผ่านหัวบรรจุ 5 นาที" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={labelStyle}>pH (6.5–8.5)</label>
            <input type="number" step="0.1" value={back.mix_ph} onChange={e => updateBack('mix_ph', e.target.value)} placeholder="pH" style={inputStyle(back.mix_ph !== '' && (parseFloat(back.mix_ph) < 6.5 || parseFloat(back.mix_ph) > 8.5))} />
          </div>
          <div>
            <label style={labelStyle}>Brix (0)</label>
            <input type="number" step="0.1" value={back.mix_brix} onChange={e => updateBack('mix_brix', e.target.value)} placeholder="Brix" style={inputStyle()} />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Hardness น้ำ RO (ต้องน้อยกว่า 50 mg/L)">
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', gap: '8px', marginBottom: '6px' }}>
          <span style={{ fontSize: '0.75rem', color: '#888', fontWeight: 'bold', alignSelf: 'center' }}>จุด</span>
          <span style={{ fontSize: '0.75rem', color: '#888' }}>กะ/เวลา</span>
          <span style={{ fontSize: '0.75rem', color: '#888' }}>Hardness (mg/L)</span>
        </div>
        {([['hard_boil', 'ถังต้ม'], ['hard_cool', 'ถัง Cooling'], ['hard_stor', 'ถัง Storage']] as const).map(([key, label]) => (
          <div key={key} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#555' }}>{label}</span>
            <input type="text" value={(back as any)[`${key}_shift`]} onChange={e => updateBack(`${key}_shift` as keyof BackData, e.target.value)} placeholder="กะ/เวลา" style={{ padding: '7px', borderRadius: '8px', border: '1px solid #ddd', fontSize: '0.8rem' }} />
            <input type="number" step="0.1" value={(back as any)[`${key}_val`]} onChange={e => updateBack(`${key}_val` as keyof BackData, e.target.value)} placeholder="mg/L" style={{ padding: '7px', borderRadius: '8px', border: `1px solid ${(back as any)[`${key}_val`] && parseFloat((back as any)[`${key}_val`]) > 50 ? '#d32f2f' : '#ddd'}`, fontSize: '0.8rem' }} />
          </div>
        ))}
      </SectionCard>

      <button onClick={handleFinish} style={{ width: '100%', padding: '16px', background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', color: 'white', border: 'none', borderRadius: '15px', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer', boxShadow: '0 6px 15px rgba(255,107,0,0.3)', marginBottom: '20px' }}>
        🏁 จบงาน CIP Line 2
      </button>
    </div>
  );

  const doneCount = Object.values(rows).filter(r => r.done).length;

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', padding: '15px 15px 100px 15px' }}>
      <div style={{ background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', borderRadius: '15px', padding: '15px', marginBottom: '15px', color: 'white', textAlign: 'center' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>📋 CIP Line Flavour Syrup (Line 2)</h2>
        <div style={{ fontSize: '0.85rem', opacity: 0.9, marginTop: '4px' }}>ผู้บันทึก: {operatorName}</div>
      </div>

      <div style={{ display: 'flex', marginBottom: '15px', background: '#f5f5f5', borderRadius: '12px', padding: '4px' }}>
        <button onClick={() => setTab('front')} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: tab === 'front' ? 'white' : 'transparent', color: tab === 'front' ? '#ff6b00' : '#888', boxShadow: tab === 'front' ? '0 2px 6px rgba(0,0,0,0.1)' : 'none' }}>
          หน้าแรก ({doneCount}/20)
        </button>
        <button onClick={() => setTab('back')} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: tab === 'back' ? 'white' : 'transparent', color: tab === 'back' ? '#ff6b00' : '#888', boxShadow: tab === 'back' ? '0 2px 6px rgba(0,0,0,0.1)' : 'none' }}>
          หน้าหลัง
        </button>
      </div>

      {tab === 'front' ? renderFront() : renderBack()}

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'white', padding: '12px 15px', borderTop: '2px solid #ff6b00', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 100 }}>
        <button onClick={onBackToMain} style={{ background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '10px', padding: '10px 16px', fontSize: '0.85rem', cursor: 'pointer', color: '#666', fontWeight: 'bold' }}>🔙 เมนูหลัก</button>
        <div style={{ fontSize: '0.85rem', color: '#ff6b00', fontWeight: 'bold' }}>✅ {doneCount}/20</div>
      </div>
    </div>
  );
};

export default CipLine2Form;
