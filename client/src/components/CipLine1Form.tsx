import React, { useState } from 'react';

const apiUrl = "https://back-wash-test.onrender.com";

interface MainRowData {
  batch: string; rounds: string; ph: string; brix: string;
  startTime: string; endTime: string; duration: number; done: boolean;
}
interface RinseData {
  rounds: string; ph: string; brix: string;
  startTime: string; endTime: string; duration: number;
}
interface BackSectionData {
  ph: string; brix: string;
  startTime: string; endTime: string; duration: number;
}
interface BackData { lin134: BackSectionData; ml300: BackSectionData; lin2: BackSectionData; }

const defaultMainRow = (): MainRowData => ({ batch: '', rounds: '', ph: '', brix: '', startTime: '', endTime: '', duration: 0, done: false });
const defaultRinse = (): RinseData => ({ rounds: '', ph: '', brix: '', startTime: '', endTime: '', duration: 0 });
const defaultBackSec = (): BackSectionData => ({ ph: '', brix: '', startTime: '', endTime: '', duration: 0 });
const defaultBack = (): BackData => ({ lin134: defaultBackSec(), ml300: defaultBackSec(), lin2: defaultBackSec() });

interface Props { operatorName: string; onBackToMain: () => void; onStatusChange: (active: boolean) => void; }

const CipLine1Form: React.FC<Props> = ({ operatorName, onBackToMain, onStatusChange }) => {
  const [tab, setTab] = useState<'front' | 'back'>('front');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionStartTime, setSessionStartTime] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [sku, setSku] = useState('');
  const [rows, setRows] = useState<Record<number, MainRowData>>({});
  const [rinse, setRinse] = useState<RinseData>(defaultRinse());
  const [back, setBack] = useState<BackData>(defaultBack());
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set());

  const accent = '#1565c0';
  const fmtTime = (iso?: string) => { if (!iso) return '-'; try { return new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
  const fmtDate = (iso?: string) => { if (!iso) return '-'; try { return new Date(iso).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: '2-digit' }); } catch { return iso; } };
  const calcDur = (s?: string, e?: string) => { if (!s || !e) return null; const d = Math.round((new Date(e).getTime() - new Date(s).getTime()) / 60000); return d > 0 ? d : null; };
  const phWarn = (v: string) => v !== '' && (parseFloat(v) < 6.5 || parseFloat(v) > 8.5);
  const sessionInfo = { date, sku, operatorName };

  const getOrCreateSession = async () => {
    if (sessionId) return sessionId;
    try {
      const res = await fetch(`${apiUrl}/api/cip-line1/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operatorName, date, sku }) });
      const data = await res.json();
      if (data.sessionId) { setSessionId(data.sessionId); onStatusChange(true); return data.sessionId; }
    } catch (e) { console.error(e); }
    return null;
  };

  const saveRow = async (rowNo: number, rowData: MainRowData) => {
    const sid = await getOrCreateSession();
    if (!sid) return;
    fetch(`${apiUrl}/api/cip-line1/row`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, rowNo, data: rowData, sessionInfo }) }).catch(console.error);
  };
  const saveExtra = async (section: string, data: object) => {
    const sid = await getOrCreateSession();
    if (!sid) return;
    fetch(`${apiUrl}/api/cip-line1/extra`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, section, data }) }).catch(console.error);
  };

  const markStart = (iso: string) => { if (!sessionStartTime) setSessionStartTime(iso); };

  // ── Main rows ──
  const handleRowStart = (no: number) => {
    const st = new Date().toISOString(); markStart(st);
    const nr = { ...(rows[no] || defaultMainRow()), startTime: st, endTime: '', duration: 0 };
    setRows(p => ({ ...p, [no]: nr })); saveRow(no, nr); setExpanded(no);
  };
  const handleRowStop = (no: number) => {
    const row = rows[no] || defaultMainRow(); if (!row.startTime) return;
    const et = new Date().toISOString();
    const dur = calcDur(row.startTime, et) || 0;
    const nr = { ...row, endTime: et, duration: dur };
    setRows(p => ({ ...p, [no]: nr })); saveRow(no, nr);
  };
  const updateRowField = (no: number, field: keyof MainRowData, value: string | boolean) => {
    setRows(p => ({ ...p, [no]: { ...(p[no] || defaultMainRow()), [field]: value } }));
  };
  const blurRow = (no: number) => { const r = rows[no]; if (r) saveRow(no, r); };
  const markRowDone = (no: number, done: boolean) => {
    const nr = { ...(rows[no] || defaultMainRow()), done };
    setRows(p => ({ ...p, [no]: nr })); saveRow(no, nr); if (done) setExpanded(null);
  };

  // ── Rinse ──
  const handleRinseStart = () => {
    const st = new Date().toISOString(); markStart(st);
    const nr = { ...rinse, startTime: st, endTime: '', duration: 0 };
    setRinse(nr); saveExtra('rinse', nr);
  };
  const handleRinseStop = () => {
    if (!rinse.startTime) return;
    const et = new Date().toISOString();
    const nr = { ...rinse, endTime: et, duration: calcDur(rinse.startTime, et) || 0 };
    setRinse(nr); saveExtra('rinse', nr);
  };
  const updateRinseField = (field: keyof RinseData, value: string) => setRinse(p => ({ ...p, [field]: value }));
  const blurRinse = () => saveExtra('rinse', rinse);

  // ── Back sections ──
  const handleBackStart = (key: keyof BackData) => {
    const st = new Date().toISOString(); markStart(st);
    const nb = { ...back, [key]: { ...back[key], startTime: st, endTime: '', duration: 0 } };
    setBack(nb); saveExtra('back', nb);
  };
  const handleBackStop = (key: keyof BackData) => {
    const sec = back[key]; if (!sec.startTime) return;
    const et = new Date().toISOString();
    const nb = { ...back, [key]: { ...sec, endTime: et, duration: calcDur(sec.startTime, et) || 0 } };
    setBack(nb); saveExtra('back', nb);
  };
  const updateBackField = (key: keyof BackData, field: keyof BackSectionData, value: string) => setBack(p => ({ ...p, [key]: { ...p[key], [field]: value } }));
  const blurBack = (key: keyof BackData) => saveExtra('back', back);

  const handleFinish = async () => {
    if (!window.confirm('ยืนยันจบงาน CIP Line 1?')) return;
    const sid = await getOrCreateSession(); if (!sid) return;
    const endTime = new Date().toISOString();
    const totalDuration = [
      ...Object.values(rows).map(r => r.duration || 0),
      rinse.duration || 0,
      ...Object.values(back).map(b => b.duration || 0),
    ].reduce((s, d) => s + d, 0);
    await fetch(`${apiUrl}/api/cip-line1/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, operatorName, date, sku, startTime: sessionStartTime, endTime, totalDuration }),
    });
    alert('บันทึก CIP Line 1 สำเร็จ!');
    onStatusChange(false); onBackToMain();
  };

  // ── History ──
  const loadHistory = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/cip-line1/sessions`);
      const data = await res.json();
      if (Array.isArray(data)) setHistory(data);
    } catch (e) { console.error(e); }
  };
  const toggleSession = (id: number) => setExpandedSessions(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const deleteSession = async (id: number) => {
    if (!window.confirm(`ลบ Session #${id}?`)) return;
    await fetch(`${apiUrl}/api/cip-line1/delete-one`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) });
    setHistory(p => p.filter(s => s.id !== id));
  };

  // ── UI helpers ──
  const inputStyle = (warn?: boolean): React.CSSProperties => ({ width: '100%', padding: '8px', borderRadius: '8px', border: `1px solid ${warn ? '#d32f2f' : '#ddd'}`, marginTop: '4px', fontSize: '0.9rem', boxSizing: 'border-box' });
  const labelStyle: React.CSSProperties = { fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: '2px' };
  const SectionCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: 'white', borderRadius: '15px', padding: '15px', marginBottom: '15px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
      <h4 style={{ margin: '0 0 12px 0', color: accent, borderBottom: `2px solid ${accent}`, paddingBottom: '8px', fontSize: '0.95rem' }}>{title}</h4>
      {children}
    </div>
  );
  const OptionPicker = ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) => (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {options.map(opt => (
        <button key={opt} onClick={() => onChange(opt === value ? '' : opt)} style={{ padding: '7px 14px', borderRadius: '15px', border: '2px solid', borderColor: value === opt ? accent : '#ddd', background: value === opt ? accent : 'white', color: value === opt ? 'white' : '#666', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 'bold' }}>{opt}</button>
      ))}
    </div>
  );

  const StartStopBar = ({ startTime, endTime, onStart, onStop }: { startTime?: string; endTime?: string; onStart: () => void; onStop: () => void }) => {
    const dur = calcDur(startTime, endTime);
    return (
      <div style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', gap: '8px', marginBottom: startTime ? '6px' : 0 }}>
          {!startTime ? (
            <button onClick={onStart} style={{ flex: 1, padding: '11px', borderRadius: '10px', border: 'none', background: 'linear-gradient(135deg, #4caf50, #66bb6a)', color: 'white', fontWeight: 'bold', cursor: 'pointer' }}>▶️ เริ่ม</button>
          ) : !endTime ? (
            <button onClick={onStop} style={{ flex: 1, padding: '11px', borderRadius: '10px', border: 'none', background: 'linear-gradient(135deg, #f44336, #ef5350)', color: 'white', fontWeight: 'bold', cursor: 'pointer' }}>⏹️ หยุด</button>
          ) : null}
        </div>
        {startTime && (
          <div style={{ background: '#f5f5f5', borderRadius: '8px', padding: '7px 12px', fontSize: '0.82rem', color: '#555' }}>
            ⏱ เริ่ม: {fmtTime(startTime)} → จบ: {fmtTime(endTime)}{dur ? ` | ${dur} นาที` : ''}
          </div>
        )}
      </div>
    );
  };

  // ── Front Page ──
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

      <div style={{ background: '#e3f2fd', borderRadius: '10px', padding: '8px 12px', marginBottom: '10px' }}>
        <span style={{ fontWeight: 'bold', color: accent, fontSize: '0.9rem' }}>รายการ CIP หลัก (NO.1–7)</span>
        <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '2px' }}>อุณหภูมิ 90-100°C / น้ำ RO 1.1 ถัน / MIS LIQUID 38.5 Kg</div>
      </div>

      {Array.from({ length: 7 }, (_, i) => i + 1).map(no => {
        const row = rows[no] || defaultMainRow();
        const isExp = expanded === no;
        const dur = calcDur(row.startTime, row.endTime);
        return (
          <div key={no} style={{ background: 'white', borderRadius: '15px', marginBottom: '8px', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', border: row.done ? `2px solid ${accent}` : '1px solid #eee' }}>
            <div onClick={() => setExpanded(isExp ? null : no)} style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', background: row.done ? '#e3f2fd' : 'white' }}>
              <div>
                <span style={{ fontWeight: 'bold', color: row.done ? accent : '#333', fontSize: '0.95rem' }}>
                  {row.done ? '✅ ' : '⬜ '}NO.{no}{row.batch ? ` — ${row.batch}` : ''}
                </span>
                {row.startTime && (
                  <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '2px' }}>
                    ⏱ {fmtTime(row.startTime)} → {fmtTime(row.endTime)}{dur ? ` (${dur} นาที)` : ''}
                  </div>
                )}
              </div>
              <span style={{ color: '#bbb', fontSize: '0.8rem' }}>{isExp ? '▲' : '▼'}</span>
            </div>

            {isExp && (
              <div style={{ padding: '15px', borderTop: '1px solid #f5f5f5' }}>
                <StartStopBar startTime={row.startTime} endTime={row.endTime} onStart={() => handleRowStart(no)} onStop={() => handleRowStop(no)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                  <div><label style={labelStyle}>กระวล (Batch)</label><input type="text" value={row.batch} onChange={e => updateRowField(no, 'batch', e.target.value)} onBlur={() => blurRow(no)} placeholder="Batch" style={inputStyle()} /></div>
                  <div><label style={labelStyle}>จำนวนรอบ</label><input type="number" value={row.rounds} onChange={e => updateRowField(no, 'rounds', e.target.value)} onBlur={() => blurRow(no)} placeholder="รอบ" style={inputStyle()} /></div>
                  <div>
                    <label style={labelStyle}>pH (6.5–8.5)</label>
                    <input type="number" step="0.1" value={row.ph} onChange={e => updateRowField(no, 'ph', e.target.value)} onBlur={() => blurRow(no)} placeholder="pH" style={inputStyle(phWarn(row.ph))} />
                    {phWarn(row.ph) && <div style={{ color: '#d32f2f', fontSize: '0.7rem' }}>⚠️ ค่า pH ผิดปกติ</div>}
                  </div>
                  <div><label style={labelStyle}>Brix (0)</label><input type="number" step="0.1" value={row.brix} onChange={e => updateRowField(no, 'brix', e.target.value)} onBlur={() => blurRow(no)} placeholder="Brix" style={inputStyle()} /></div>
                </div>
                <button onClick={() => markRowDone(no, !row.done)} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: 'none', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.9rem', background: row.done ? '#f5f5f5' : `linear-gradient(135deg, ${accent}, #0d47a1)`, color: row.done ? '#666' : 'white' }}>
                  {row.done ? '↩ ยกเลิก' : '✅ เสร็จสิ้นแถวนี้'}
                </button>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ background: '#fff3e0', borderRadius: '10px', padding: '8px 12px', margin: '15px 0 10px 0' }}>
        <span style={{ fontWeight: 'bold', color: '#e65100', fontSize: '0.9rem' }}>ล้างหลังการผลิต (60°C)</span>
        <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '2px' }}>หากรายที่ 4 ค่าดีแล้ว ให้ต้มน้ำต่อที่ 60°C</div>
      </div>
      <div style={{ background: 'white', borderRadius: '15px', padding: '15px', marginBottom: '15px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', border: '1px solid #ffe0b2' }}>
        <StartStopBar startTime={rinse.startTime} endTime={rinse.endTime} onStart={handleRinseStart} onStop={handleRinseStop} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <div><label style={labelStyle}>จำนวนรอบ</label><input type="number" value={rinse.rounds} onChange={e => updateRinseField('rounds', e.target.value)} onBlur={blurRinse} placeholder="รอบ" style={inputStyle()} /></div>
          <div>
            <label style={labelStyle}>pH (6.5–8.5)</label>
            <input type="number" step="0.1" value={rinse.ph} onChange={e => updateRinseField('ph', e.target.value)} onBlur={blurRinse} placeholder="pH" style={inputStyle(phWarn(rinse.ph))} />
          </div>
          <div><label style={labelStyle}>Brix (0)</label><input type="number" step="0.1" value={rinse.brix} onChange={e => updateRinseField('brix', e.target.value)} onBlur={blurRinse} placeholder="Brix" style={inputStyle()} /></div>
        </div>
      </div>
    </div>
  );

  // ── Back Page ──
  const backSections: { key: keyof BackData; title: string }[] = [
    { key: 'lin134', title: 'CIP เครื่องบรรจุ Linear 1 / 3 / 4 (RO 120L / Oxonia 240ml)' },
    { key: 'ml300',  title: 'CIP เครื่องบรรจุ 300 ml (RO 30L / Oxonia 60ml)' },
    { key: 'lin2',   title: 'CIP เครื่องบรรจุ Linear 2 (RO 80L / Oxonia 160ml)' },
  ];
  const renderBack = () => (
    <div>
      {backSections.map(({ key, title }) => {
        const sec = back[key];
        return (
          <div key={key} style={{ background: 'white', borderRadius: '15px', padding: '15px', marginBottom: '15px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
            <h4 style={{ margin: '0 0 12px 0', color: accent, borderBottom: `2px solid ${accent}`, paddingBottom: '8px', fontSize: '0.9rem' }}>{title}</h4>
            <StartStopBar startTime={sec.startTime} endTime={sec.endTime} onStart={() => handleBackStart(key)} onStop={() => handleBackStop(key)} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label style={labelStyle}>pH (6.5–8.5)</label>
                <input type="number" step="0.1" value={sec.ph} onChange={e => updateBackField(key, 'ph', e.target.value)} onBlur={() => blurBack(key)} placeholder="pH" style={inputStyle(phWarn(sec.ph))} />
                {phWarn(sec.ph) && <div style={{ color: '#d32f2f', fontSize: '0.7rem' }}>⚠️ pH ผิดปกติ</div>}
              </div>
              <div><label style={labelStyle}>Brix (0)</label><input type="number" step="0.1" value={sec.brix} onChange={e => updateBackField(key, 'brix', e.target.value)} onBlur={() => blurBack(key)} placeholder="Brix" style={inputStyle()} /></div>
            </div>
          </div>
        );
      })}
      <button onClick={handleFinish} style={{ width: '100%', padding: '16px', background: `linear-gradient(135deg, ${accent}, #0d47a1)`, color: 'white', border: 'none', borderRadius: '15px', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer', boxShadow: '0 6px 15px rgba(21,101,192,0.3)', marginBottom: '20px' }}>
        🏁 จบงาน CIP Line 1
      </button>
    </div>
  );

  const doneCount = Object.values(rows).filter(r => r.done).length;
  const totalDur = [
    ...Object.values(rows).map(r => r.duration || 0),
    rinse.duration || 0,
    ...Object.values(back).map(b => b.duration || 0),
  ].reduce((s, d) => s + d, 0);

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

      {totalDur > 0 && (
        <div style={{ margin: '0 0 15px 0', background: 'linear-gradient(135deg, #e3f2fd, #bbdefb)', borderRadius: '12px', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid #90caf9' }}>
          <span style={{ fontWeight: 'bold', color: accent, fontSize: '0.95rem' }}>⏱ เวลารวม CIP</span>
          <span style={{ fontWeight: 'bold', color: accent, fontSize: '1.1rem' }}>{totalDur} นาที</span>
        </div>
      )}

      {/* History button */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
        <button onClick={() => { loadHistory(); setShowHistory(true); }} style={{ background: `linear-gradient(135deg, ${accent}, #0d47a1)`, color: 'white', border: 'none', borderRadius: '15px', padding: '16px 30px', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer', boxShadow: '0 6px 15px rgba(21,101,192,0.2)', width: '100%', maxWidth: '400px' }}>
          📊 ดูประวัติ CIP Line 1 ({history.length} ครั้ง)
        </button>
      </div>

      {/* History modal */}
      {showHistory && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(10px)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '15px' }}>
          <div style={{ backgroundColor: 'white', width: '100%', maxWidth: '700px', maxHeight: '90vh', borderRadius: '25px', padding: '25px', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.15)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '2px solid #eee', paddingBottom: '15px' }}>
              <h3 style={{ margin: 0, color: accent }}>📊 ประวัติ CIP Line 1</h3>
              <button onClick={() => setShowHistory(false)} style={{ background: '#f5f5f5', color: '#666', border: '1px solid #ddd', borderRadius: '50%', width: '35px', height: '35px', cursor: 'pointer' }}>✕</button>
            </div>
            {history.length === 0 && <div style={{ textAlign: 'center', color: '#999', padding: '40px' }}>ยังไม่มีประวัติ</div>}
            {history.map((s: any) => {
              const doneRows = (s.rows || []).filter((r: any) => r.done).length;
              return (
                <div key={s.id} style={{ border: '1px solid #eee', borderRadius: '14px', marginBottom: '12px', overflow: 'hidden' }}>
                  <div onClick={() => toggleSession(s.id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: s.status === 'completed' ? '#e3f2fd' : '#fff3e0', cursor: 'pointer' }}>
                    <div>
                      <div style={{ fontWeight: 'bold', fontSize: '0.95rem', color: '#333' }}>{s.status === 'completed' ? '✅' : '🔄'} Session #{s.id} — {s.sku || '-'}</div>
                      <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '2px' }}>👤 {s.operator_name} | {fmtDate(s.created_at)} | {doneRows}/{s.rows?.length || 0} รอบ</div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <button onClick={e => { e.stopPropagation(); deleteSession(s.id); }} style={{ background: '#ffebee', color: '#d32f2f', border: '1px solid #ffcdd2', borderRadius: '8px', padding: '4px 10px', fontSize: '0.75rem', cursor: 'pointer' }}>🗑️</button>
                      <span style={{ color: '#999', fontSize: '0.9rem' }}>{expandedSessions.has(s.id) ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  {expandedSessions.has(s.id) && (
                    <div style={{ padding: '12px 16px', borderTop: '1px solid #eee' }}>
                      {(s.rows || []).map((r: any, i: number) => (
                        <div key={i} style={{ padding: '7px 0', borderBottom: i < s.rows.length - 1 ? '1px solid #f5f5f5' : 'none' }}>
                          <div style={{ fontWeight: '600', fontSize: '0.85rem', color: r.done ? '#1565c0' : '#e65100' }}>
                            {r.done ? '✅' : '⬜'} NO.{r.rowNo}{r.batch ? ` — ${r.batch}` : ''}
                          </div>
                          <div style={{ fontSize: '0.78rem', color: '#666', marginTop: '2px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {r.startTime && <span>⏱ {fmtTime(r.startTime)} → {fmtTime(r.endTime)}{r.duration ? ` (${r.duration} นาที)` : ''}</span>}
                            {r.ph && <span>🧪 pH: {r.ph}</span>}
                            {r.brix && <span>🍬 Brix: {r.brix}</span>}
                            {r.rounds && <span>🔄 {r.rounds} รอบ</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <button onClick={() => setShowHistory(false)} style={{ width: '100%', padding: '12px', background: '#424242', color: 'white', border: 'none', borderRadius: '10px', marginTop: '10px', cursor: 'pointer' }}>ปิดหน้าต่างนี้</button>
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'white', padding: '12px 15px', borderTop: `2px solid ${accent}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 100 }}>
        <button onClick={onBackToMain} style={{ background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '10px', padding: '10px 16px', fontSize: '0.85rem', cursor: 'pointer', color: '#666', fontWeight: 'bold' }}>🔙 เมนูหลัก</button>
        <div style={{ fontSize: '0.85rem', color: accent, fontWeight: 'bold' }}>✅ {doneCount}/7</div>
      </div>
    </div>
  );
};

export default CipLine1Form;
