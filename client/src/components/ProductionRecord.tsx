import React, { useState, useEffect } from 'react';
import styles from '../App.module.css';

interface ProductionRecordProps {
  operatorName: string;
  onBack: () => void;
  onBackToMain: () => void;
  onHome: () => void;
  onStatusChange: (active: boolean) => void;
}

interface CompletedBatch {
  line: number;
  batch: string;
  flavor: string;
  startTime: string;
  doneTime: string;
  duration: number;
  brix: string;
  ph: string;
  lotNo: string;
}

interface LineState {
  lotNo: string;
  flavor: string;
  shiftMode: 'new' | 'handover' | null;
  shiftBatch: string;
  cookingBatch: string;
  startTime: string | null;
  startRaw: Date | null;
  doneTime: string | null;
  brix: string;
  ph: string;
  history: CompletedBatch[];
  totalCompleted: number;
  cipCount: number;
  isProcessing: boolean;
  showInputs: boolean;
}

const apiUrl = "https://back-wash-test.onrender.com";

const ProductionRecord: React.FC<ProductionRecordProps> = ({ operatorName, onHome, onStatusChange }) => {
  const batchOptions = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const [showSummaryModal, setShowSummaryModal] = useState(false);

  const initialLineState: LineState = {
    lotNo: '',
    flavor: '',
    shiftMode: null,
    shiftBatch: '',
    cookingBatch: '',
    startTime: null,
    startRaw: null,
    doneTime: null,
    brix: '',
    ph: '',
    history: [],
    totalCompleted: 0,
    cipCount: 0,
    isProcessing: false,
    showInputs: true
  };

  const [lines, setLines] = useState<Record<number, LineState>>({
    1: { ...initialLineState },
    2: { ...initialLineState },
    3: { ...initialLineState },
    4: { ...initialLineState },
  });

  useEffect(() => {
    const anyProcessing = Object.values(lines).some(line => line.isProcessing);
    onStatusChange(anyProcessing);
  }, [lines, onStatusChange]);

  const flavorList = [
    "Amazon", "FDS", "Golden", "Freshy Lychee", "Freshy Strawberry",
    "Senorita Coconut", "Senorita Caramel", "Freshy Blue Hawaii", "Freshy Lime",
     "Freshy Green Apple", "Freshy Sala", "Senorita Yuzu",
    "MLH 02", "Freshy Pineapple", "Operator Name", "Freshy Grape",
    "Freshy Punch", "Freshy blue Lemon", "Senorita Fres Mint",
    "Freshy Orange", "Signature Rose", "Freshy Shine Muscat Grape"
  ];

  const flavorColors: Record<string, { bg: string; border: string }> = {
    "Amazon":            { bg: '#efebe9', border: '#795548' },
    "FDS":               { bg: '#eceff1', border: '#607d8b' },
    "Golden":            { bg: '#fff8e1', border: '#ffc107' },
    "Freshy Lychee":     { bg: '#fce4ec', border: '#e91e63' },
    "Freshy Strawberry": { bg: '#ffebee', border: '#f44336' },
    "Senorita Coconut":  { bg: '#fafafa', border: '#bdbdbd' },
    "Senorita Caramel":  { bg: '#efebe9', border: '#a1887f' },
    "Freshy Blue Hawaii":{ bg: '#e1f5fe', border: '#03a9f4' },
    "Freshy Lime":       { bg: '#f9fbe7', border: '#8bc34a' },
    "CIP":               { bg: '#f5f5f5', border: '#9e9e9e' },
    "ว่าง":              { bg: '#eeeeee', border: '#bdbdbd' },
    "Freshy Green Apple":{ bg: '#e8f5e9', border: '#43a047' },
    "Freshy Sala":       { bg: '#fce4ec', border: '#e91e63' },
    "Senorita Yuzu":     { bg: '#fffde7', border: '#f9a825' },
    "MLH 02":            { bg: '#e0f2f1', border: '#009688' },
    "Freshy Pineapple":  { bg: '#fff9c4', border: '#f9a825' },
    "Operator Name":     { bg: '#f3f3f3', border: '#9e9e9e' },
    "Freshy Grape":      { bg: '#f3e5f5', border: '#9c27b0' },
    "Freshy Punch":      { bg: '#fce4ec', border: '#ff4081' },
    "Freshy blue Lemon": { bg: '#e3f2fd', border: '#42a5f5' },
    "Senorita Fres Mint":{ bg: '#e0f7fa', border: '#00bcd4' },
    "Freshy Orange":     { bg: '#fff3e0', border: '#ff9800' },
    "Signature Rose":    { bg: '#fce4ec', border: '#f06292' },
  };

  const getNextBatch = (currentBatch: string) => {
    const index = batchOptions.indexOf(currentBatch);
    if (index === -1 || index === batchOptions.length - 1) return "";
    return batchOptions[index + 1];
  };

  const handleCookingBatchChange = (lineId: number, selectedBatch: string) => {
    const line = lines[lineId];
    // กะเริ่ม: Batch แรกเลือกได้อิสระ ไม่ต้องตรวจลำดับ
    if (line.shiftMode === 'new' && line.history.length === 0) {
      setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], cookingBatch: selectedBatch } }));
      return;
    }
    const lastBatch = line.history.length > 0 ? line.history[line.history.length - 1].batch : line.shiftBatch;
    if (!lastBatch) { alert("กรุณาเลือก 'รับช่วงต่อจาก Batch' ก่อนครับ"); return; }
    const expectedBatch = getNextBatch(lastBatch);
    if (selectedBatch !== expectedBatch) { alert(`ลำดับ Batch ไม่ถูกต้อง! ลำดับที่ต้องทำคือ Batch ${expectedBatch}`); return; }
    setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], cookingBatch: selectedBatch } }));
  };

  const fmtLotNo = (dateStr: string) => {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    if (!y || !m || !d) return dateStr;
    return `${d}${m}${y.slice(2)}`;
  };

  const handleStart = (lineId: number) => {
    const line = lines[lineId];
    if (!line.flavor || !line.cookingBatch) { alert("กรุณาเลือก รสชาติ และ Batch เริ่มต้ม ก่อนกด Start"); return; }
    const now = new Date();
    const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], startTime: timeStr, startRaw: now, doneTime: null, isProcessing: true } }));
  };

  const handleDone = async (lineId: number) => {
    const line = lines[lineId];
    if (!line.startTime || !line.startRaw) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    const diffMs = now.getTime() - line.startRaw.getTime();
    const diffMins = Math.round(diffMs / 60000);
    const isCip = line.flavor === "CIP";
    const formattedLotNo = fmtLotNo(line.lotNo);
    const newCompletedBatch: CompletedBatch = { line: lineId, batch: line.cookingBatch, flavor: line.flavor, startTime: line.startTime, doneTime: timeStr, duration: diffMins, brix: line.brix, ph: line.ph, lotNo: formattedLotNo };
    const newHistory = [...line.history, newCompletedBatch];
    const newTotalCompleted = line.totalCompleted + 1;
    const newCipCount = isCip ? line.cipCount + 1 : line.cipCount;
    setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], doneTime: timeStr, history: newHistory, totalCompleted: newTotalCompleted, cipCount: newCipCount, isProcessing: false, showInputs: false, cookingBatch: '', startTime: null, startRaw: null, brix: '', ph: '' } }));
    try {
      await fetch(`${apiUrl}/api/production/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: `Line ${lineId}`, flavor: line.flavor, batch: line.cookingBatch, operator: operatorName, timestamp: new Date().toISOString(), duration: diffMins, brix: line.brix, ph: line.ph, cipCount: isCip ? "1 Batch" : "-", lotNo: formattedLotNo, startTime: line.startTime, endTime: timeStr }) });
    } catch (error) { console.error("Failed to log:", error); }
  };

  const resetLine = (lineId: number) => {
    if (window.confirm(`ล้างข้อมูลทั้งหมดของ Line ${lineId} ใช่หรือไม่?`)) { setLines(prev => ({ ...prev, [lineId]: { ...initialLineState } })); }
  };

  const finishSession = () => {
    if (window.confirm("🏁 ยืนยันสิ้นสุดการทำงานทั้งหมดหรือไม่? ข้อมูลทุก Line ในหน้านี้จะถูกล้างค่าใหม่")) {
      setLines({ 1: { ...initialLineState }, 2: { ...initialLineState }, 3: { ...initialLineState }, 4: { ...initialLineState } });
      onStatusChange(false);
      alert("ล้างข้อมูลการผลิตเรียบร้อยแล้ว");
    }
  };

  const allHistory = Object.values(lines).flatMap(l => l.history).sort((a, b) => b.line - a.line);

  return (
    <div style={{ paddingBottom: '120px' }}>
      {/* 1. หัวข้อหลักบนสุด */}
      <h2 className={styles.header} style={{ width: '95%', maxWidth: '500px', margin: '20px auto 15px auto', background: 'linear-gradient(135deg, #4caf50, #2e7d32)', borderRadius: '15px', padding: '15px', color: '#ffffff', textAlign: 'center', boxShadow: '0 6px 15px rgba(76, 175, 80, 0.3)' }}>
        Production Control
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px', padding: '10px' }}>
        {[1, 2, 3, 4].map(lineId => {
          const line = lines[lineId];
          const lastBatch = line.history.length > 0 ? line.history[line.history.length - 1].batch : line.shiftBatch;
          const nextExpectedBatch = getNextBatch(lastBatch);
          const flavorTheme = line.isProcessing && line.flavor ? flavorColors[line.flavor] : null;
          return (
            <div key={lineId} className={styles.stepCard} style={{ borderColor: flavorTheme ? flavorTheme.border : '#4caf50', borderWidth: flavorTheme ? '3px' : undefined, background: flavorTheme ? flavorTheme.bg : (line.showInputs ? '#ffffff' : '#f1f8e9'), padding: '20px', transition: 'background 0.5s ease, border-color 0.5s ease' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: '#2e7d32' }}>Line {lineId}</h3>
                <button onClick={() => resetLine(lineId)} style={{ background: '#ffebee', color: '#d32f2f', border: '1px solid #ffcdd2', borderRadius: '8px', padding: '4px 12px', fontSize: '0.7rem', cursor: 'pointer' }}>ล้างค่า</button>
              </div>
              {line.showInputs ? (
                <>
                  <div className={styles.formGroup} style={{ marginBottom: '10px' }}>
                    <label className={styles.formLabel}>รสชาติ/แบรนด์ (Flavor)</label>
                    <select className={styles.formInput} value={line.flavor} onChange={(e) => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], flavor: e.target.value } }))} disabled={line.isProcessing}>
                      <option value="">-- เลือกกลิ่น --</option>
                      {flavorList.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div className={styles.formGroup} style={{ marginBottom: '10px' }}>
                    <label className={styles.formLabel}>🏷️ Lot No. (วันที่ผลิต)</label>
                    <input
                      type="date"
                      className={styles.formInput}
                      value={line.lotNo}
                      onChange={e => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], lotNo: e.target.value } }))}
                      disabled={line.isProcessing}
                      style={{ fontWeight: 'bold' }}
                    />
                    {line.lotNo && <div style={{ marginTop: '5px', fontWeight: 'bold', fontSize: '1.1rem', color: '#2e7d32', letterSpacing: '2px' }}>→ {fmtLotNo(line.lotNo)}</div>}
                  </div>

                  {/* ปุ่มเลือกโหมดกะ */}
                  {!line.isProcessing && (
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                      <button
                        onClick={() => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], shiftMode: 'new', shiftBatch: '', cookingBatch: '' } }))}
                        style={{ flex: 1, padding: '12px', background: line.shiftMode === 'new' ? '#1565c0' : '#e3f2fd', color: line.shiftMode === 'new' ? 'white' : '#1565c0', border: '2px solid #1565c0', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.95rem' }}
                      >
                        🌅 กะเริ่ม
                      </button>
                      <button
                        onClick={() => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], shiftMode: 'handover', shiftBatch: '', cookingBatch: '' } }))}
                        style={{ flex: 1, padding: '12px', background: line.shiftMode === 'handover' ? '#e65100' : '#fff3e0', color: line.shiftMode === 'handover' ? 'white' : '#e65100', border: '2px solid #e65100', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.95rem' }}
                      >
                        🔄 รับช่วง
                      </button>
                    </div>
                  )}

                  {/* Batch selector — แสดงเมื่อเลือกโหมดแล้ว */}
                  {line.shiftMode !== null && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '20px', background: 'linear-gradient(90deg, #fff9c4 0%, #e3f2fd 50%, #e8f5e9 100%)', padding: '12px', borderRadius: '18px', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.05)', position: 'relative' }}>
                      {line.shiftMode === 'handover' && (
                        <div className={styles.formGroup} style={{ flex: 1 }}>
                          <label className={styles.formLabel} style={{ fontSize: '0.6rem', textAlign: 'center', display: 'block', color: '#8d6e63', fontWeight: 'bold' }}>📥 รับช่วงต่อ</label>
                          <select className={styles.formInput} value={line.shiftBatch} onChange={(e) => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], shiftBatch: e.target.value, cookingBatch: '' } }))} disabled={line.history.length > 0 || line.isProcessing} style={{ backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '8px', fontSize: '0.9rem', textAlign: 'center', borderRadius: '10px', border: '1px solid #fbc02d' }}>
                            <option value="">--</option>
                            {batchOptions.map(b => <option key={b} value={b}>{b}</option>)}
                          </select>
                        </div>
                      )}
                      {(line.shiftMode === 'handover' || line.history.length > 0) && (
                        <div style={{ flex: 1, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                          <div style={{ fontSize: '0.6rem', color: '#1565c0', marginBottom: '4px', fontWeight: 'bold' }}>📍 ล่าสุด</div>
                          <div style={{ background: lastBatch ? 'linear-gradient(135deg, #1565c0, #1e88e5)' : '#fff', padding: '6px 0', borderRadius: '10px', width: '100%', fontWeight: '800', color: lastBatch ? '#ffffff' : '#90caf9', fontSize: '1rem', minHeight: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{lastBatch || '--'}</div>
                          <div style={{ fontSize: '1rem', marginTop: '2px', color: '#1e88e5' }}>➜</div>
                        </div>
                      )}
                      <div className={styles.formGroup} style={{ flex: 1 }}>
                        <label className={styles.formLabel} style={{ fontSize: '0.6rem', textAlign: 'center', display: 'block', color: '#2e7d32', fontWeight: 'bold' }}>🔥 เริ่มต้ม</label>
                        <select className={styles.formInput} value={line.cookingBatch} onChange={(e) => handleCookingBatchChange(lineId, e.target.value)} disabled={line.isProcessing || (line.shiftMode === 'handover' && !line.shiftBatch && line.history.length === 0)} style={{ background: 'rgba(255, 255, 255, 0.9)', border: '2px solid #4caf50', padding: '8px', fontSize: '0.9rem', textAlign: 'center', borderRadius: '10px', fontWeight: 'bold' }}>
                          <option value="">--</option>
                          {batchOptions.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
                    <button onClick={() => handleStart(lineId)} disabled={line.isProcessing || !line.cookingBatch} style={{ flex: 1.5, padding: '12px', background: line.isProcessing ? '#ccc' : '#4caf50', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>▶️ Start Batch {line.cookingBatch}</button>
                    <div style={{ flex: 1, textAlign: 'center', background: '#f5f5f5', padding: '10px', borderRadius: '10px', border: '1px solid #ddd' }}>
                      <small style={{ display: 'block', fontSize: '0.6rem', color: '#888' }}>เวลาเริ่ม</small>
                      <strong>{line.startTime || '--:--'}</strong>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '15px' }}>
                    <div className={styles.formGroup}><label className={styles.formLabel}>ค่า Brix</label><input type="number" className={styles.formInput} placeholder="Brix" value={line.brix} onChange={(e) => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], brix: e.target.value } }))} disabled={!line.isProcessing} /></div>
                    <div className={styles.formGroup}><label className={styles.formLabel}>ค่า PH</label><input type="number" className={styles.formInput} placeholder="PH" value={line.ph} onChange={(e) => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], ph: e.target.value } }))} disabled={!line.isProcessing} /></div>
                  </div>
                  <button onClick={() => { if (!line.brix || !line.ph) { alert("⚠️ กรุณากรอกค่า Brix และ PH ให้ครบถ้วนก่อนกด Done ครับ!"); return; } handleDone(lineId); }} disabled={!line.isProcessing || !line.brix || !line.ph} style={{ width: '100%', padding: '15px', background: (!line.isProcessing || !line.brix || !line.ph) ? '#ccc' : '#f44336', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>{(!line.brix || !line.ph) ? '📝 กรุณากรอก Brix & PH' : '⏹️ Done (เสร็จสิ้น)'}</button>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '10px 0' }}>
                  <div style={{ fontSize: '1.2rem', color: '#2e7d32', fontWeight: 'bold', marginBottom: '10px' }}>✅ บันทึกสำเร็จ!</div>
                  {line.lotNo && (
                    <div style={{ background: '#e8f5e9', padding: '8px 12px', borderRadius: '10px', marginBottom: '10px', border: '1px solid #a5d6a7', display: 'inline-block' }}>
                      <span style={{ fontWeight: 'bold', color: '#2e7d32', fontSize: '0.95rem' }}>🏷️ Lot No. {line.lotNo}</span>
                    </div>
                  )}
                  <div style={{ background: '#fff9c4', padding: '12px', borderRadius: '10px', marginBottom: '20px', border: '1px solid #fbc02d' }}><div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#f57f17' }}>Batch ต่อไปที่คุณต้องผลิตคือ: {nextExpectedBatch || 'จบเซ็ต A-Z'}</div></div>
                  <button onClick={() => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], showInputs: true } }))} style={{ width: '100%', padding: '15px', background: '#2e7d32', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>➕ เตรียมผลิต Batch ถัดไป</button>
                </div>
              )}
              <div style={{ marginTop: '15px', display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ color: '#1565c0', fontWeight: 'bold', fontSize: '0.9rem' }}>✅ ผลิตเสร็จแล้ว: {line.totalCompleted} Batch</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '40px', marginBottom: '20px', padding: '0 15px' }}>
        <button onClick={() => setShowSummaryModal(true)} style={{ background: 'linear-gradient(135deg, #1565c0, #0d47a1)', color: 'white', border: 'none', borderRadius: '15px', padding: '18px 30px', fontWeight: 'bold', fontSize: '1.1rem', cursor: 'pointer', boxShadow: '0 8px 20px rgba(21, 101, 192, 0.3)', width: '100%', maxWidth: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>📊 ดูสรุปการผลิตทั้งหมด ({allHistory.length} รายการ)</button>
      </div>

      {showSummaryModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '15px' }}>
            <div style={{ backgroundColor: 'white', width: '100%', maxWidth: '800px', maxHeight: '90vh', borderRadius: '25px', padding: '25px', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.15)', border: '1px solid #eee' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '2px solid #eee', paddingBottom: '15px' }}>
                    <h3 style={{ margin: 0, color: '#1565c0' }}>📊 สรุปรายการผลิตทั้งหมด</h3>
                    <button onClick={() => setShowSummaryModal(false)} style={{ background: '#f5f5f5', color: '#666', border: '1px solid #ddd', borderRadius: '50%', width: '35px', height: '35px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1rem' }}>X</button>
                </div>
                <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}><thead><tr style={{ backgroundColor: '#f5f5f5' }}><th style={{ padding: '10px', border: '1px solid #ddd' }}>Line</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>Lot No.</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>Batch</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>รสชาติ</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>เวลา Start-Done</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>Brix</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>PH</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>รวมเวลา</th></tr></thead><tbody>{allHistory.length > 0 ? allHistory.map((h, i) => (<tr key={i} style={{ textAlign: 'center' }}><td style={{ padding: '10px', border: '1px solid #ddd' }}>Line {h.line}</td><td style={{ padding: '10px', border: '1px solid #ddd', fontWeight: 'bold', color: '#2e7d32' }}>{h.lotNo || '-'}</td><td style={{ padding: '10px', border: '1px solid #ddd', fontWeight: 'bold' }}>{h.batch}</td><td style={{ padding: '10px', border: '1px solid #ddd' }}>{h.flavor}</td><td style={{ padding: '10px', border: '1px solid #ddd' }}>{h.startTime} - {h.doneTime}</td><td style={{ padding: '10px', border: '1px solid #ddd', color: '#1b5e20', fontWeight: 'bold' }}>{h.brix}</td><td style={{ padding: '10px', border: '1px solid #ddd', color: '#1b5e20', fontWeight: 'bold' }}>{h.ph}</td><td style={{ padding: '10px', border: '1px solid #ddd', color: '#d84315', fontWeight: 'bold' }}>{h.duration} นาที</td></tr>)) : (<tr><td colSpan={8} style={{ padding: '20px', textAlign: 'center', color: '#888' }}>ยังไม่มีรายการที่ผลิตเสร็จ</td></tr>)}</tbody></table></div>
                <button onClick={() => setShowSummaryModal(false)} style={{ width: '100%', padding: '12px', background: '#424242', color: 'white', border: 'none', borderRadius: '10px', marginTop: '20px', fontWeight: 'bold', cursor: 'pointer' }}>ปิดหน้าต่างนี้</button>
            </div>
        </div>
      )}

      {/* Footer Menu */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#fff', padding: '15px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #4caf50', boxShadow: '0 -4px 15px rgba(0,0,0,0.1)', zIndex: 100 }}>
        <button onClick={() => { const pin = window.prompt("กรุณาใส่รหัสผ่านเพื่อกลับหน้าแรก:"); if (pin === "1234") onHome(); else if (pin !== null) alert("รหัสผ่านไม่ถูกต้อง!"); }} style={{ background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '10px', padding: '10px 20px', fontSize: '0.9rem', cursor: 'pointer', color: '#333', fontWeight: 'bold' }}>🏠 Home</button>
        <button onClick={finishSession} style={{ background: '#d32f2f', color: 'white', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 10px rgba(211, 47, 47, 0.3)' }}>🏁 สิ้นสุดการทำงาน</button>
        <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#333' }}>👤 <span style={{ color: '#2e7d32' }}>{operatorName}</span></div>
      </div>
    </div>
  );
};

export default ProductionRecord;
