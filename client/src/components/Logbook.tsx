import React, { useState, useEffect } from 'react';
import styles from '../App.module.css';
import { cipSteps } from '../data/steps';
import { usePageLock } from '../hooks/usePageLock';
import LockBanner from './LockBanner';
import FooterBar, { OperatorBadge } from './FooterBar';

interface LogbookProps {
  operatorName: string;
  onLogout: () => void;
  onBackToMain: () => void;
  onHome: () => void;
  onStatusChange: (active: boolean) => void;
}

interface StepData {
  startTime?: string;
  endTime?: string;
  pressure?: string;
  brix?: string;
  pH?: string;
  remarks?: string;
  status: 'pending' | 'active' | 'completed';
  image?: File;
  imagePath?: string;
}

const apiUrl = "https://back-wash-test.onrender.com";

const Logbook: React.FC<LogbookProps> = ({ operatorName, onBackToMain, onHome, onStatusChange }) => {
  const [batchId, setBatchId] = useState<number | null>(null);
  const [batchStartTime, setBatchStartTime] = useState<string>('');
  const [stepData, setStepData] = useState<Record<number, StepData>>({});
  const [expandedStep, setExpandedStep] = useState<number | null>(1);
  const [isFinishing, setIsFinishing] = useState(false);
  const [uploadingStep, setUploadingStep] = useState<number | null>(null);
  
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [stepHistory, setStepHistory] = useState<any[]>([]);
  const [expandedBatches, setExpandedBatches] = useState<Set<number>>(new Set());

  const loadHistory = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/steps`);
      const data = await res.json();
      if (Array.isArray(data)) setStepHistory(data);
    } catch (e) { console.error("History fetch error", e); }
  };

  useEffect(() => { loadHistory(); }, []);

  const handleOpenHistory = () => { loadHistory(); setShowHistoryModal(true); };

  const { lockedBy, acquire, release } = usePageLock('cip-logbook', operatorName, batchId !== null);

  const startBatchIfNeeded = async () => {
    if (batchId) return batchId;
    const gotLock = await acquire();
    if (!gotLock) return null;
    try {
      const res = await fetch(`${apiUrl}/api/batches/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName })
      });
      const data = await res.json();
      if (data.batchId) {
        setBatchId(data.batchId);
        setBatchStartTime(new Date().toISOString());
        onStatusChange(true);
        return data.batchId;
      }
      return null;
    } catch (e) { return null; }
  };

  const saveStepData = async (stepId: number, update: Partial<StepData>, currentBatchId: number) => {
    const step = cipSteps.find(s => s.id === stepId);
    const formData = new FormData();
    formData.append('batchId', currentBatchId.toString());
    formData.append('stepNumber', stepId.toString());
    formData.append('stepDescription', step?.description || '');
    formData.append('operatorName', operatorName);
    
    if (update.startTime) formData.append('startTime', update.startTime);
    if (update.endTime) formData.append('endTime', update.endTime);
    if (update.pressure !== undefined) formData.append('pressure', update.pressure);
    if (update.brix !== undefined) formData.append('brix', update.brix);
    if (update.pH !== undefined) formData.append('ph', update.pH);
    if (update.remarks !== undefined) formData.append('remarks', update.remarks);
    
    if (update.image instanceof File) {
      formData.append('image', update.image);
      setUploadingStep(stepId);
    }

    setStepData(prev => ({
      ...prev,
      [stepId]: { ...(prev[stepId] || { status: 'pending' }), ...update }
    }));

    try {
      const res = await fetch(`${apiUrl}/api/steps/log`, { method: 'POST', body: formData });
      const result = await res.json();
      if (result.success && result.imagePath) {
        setStepData(prev => ({ ...prev, [stepId]: { ...prev[stepId], imagePath: result.imagePath, image: undefined } }));
      }
      loadHistory();
    } catch (error) {
      console.error('Save error', error);
    } finally {
      setUploadingStep(null);
    }
  };

  const handleStart = async (stepId: number) => {
    const activeBatchId = await startBatchIfNeeded();
    if (activeBatchId) {
      const startTime = new Date().toISOString();
      await saveStepData(stepId, { startTime, status: 'active' }, activeBatchId);
      setExpandedStep(stepId);
    }
  };

  const handleStop = async (stepId: number) => {
    if (batchId) {
      const endTime = new Date().toISOString();
      const current = stepData[stepId] || {};
      await saveStepData(stepId, {
        startTime: current.startTime,
        endTime,
        status: 'completed',
        pressure: current.pressure,
        brix: current.brix,
        pH: current.pH,
        remarks: current.remarks,
      }, batchId);
      if (stepId < cipSteps.length) setExpandedStep(stepId + 1);
    }
  };

  const handleInputChange = (stepId: number, field: keyof StepData, value: string) => {
    setStepData(prev => ({
      ...prev,
      [stepId]: { ...(prev[stepId] || { status: 'pending' }), [field]: value }
    }));
  };

  const handleBlur = (stepId: number, field: keyof StepData, value: string) => {
    if (batchId) saveStepData(stepId, { [field]: value }, batchId);
  };

  const handleFileChange = (stepId: number, file: File) => {
    if (batchId) saveStepData(stepId, { image: file }, batchId);
  };

  const finishSession = () => {
    if (window.confirm("🏁 สิ้นสุดการทำงานและล้างข้อมูลใหม่?")) {
      setBatchId(null);
      setBatchStartTime('');
      setStepData({});
      setExpandedStep(1);
      onStatusChange(false);
    }
  };

  const handleFinishBatch = async () => {
    if (!batchId) return;
    if (!window.confirm('🏁 ยืนยันจบงาน Batch นี้?')) return;
    try {
      setIsFinishing(true);
      const endTime = new Date().toISOString();
      await fetch(`${apiUrl}/api/batches/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, operatorName, startTime: batchStartTime, endTime })
      });
      alert('บันทึก CIP สำเร็จ!');
      onStatusChange(false);
      release();
      setBatchId(null);
      setBatchStartTime('');
      setStepData({});
      onBackToMain();
    } catch (e) { alert("Error"); } finally { setIsFinishing(false); }
  };

  const fmtTime = (iso?: string) => {
    if (!iso) return '-';
    try { return new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
  };

  const fmtDate = (iso?: string) => {
    if (!iso) return '-';
    try { return new Date(iso).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: '2-digit' }); } catch { return iso; }
  };

  const toggleBatch = (id: number) => {
    setExpandedBatches(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const deleteBatch = async (id: number) => {
    if (!window.confirm(`ลบ Batch #${id} ออกจากประวัติ?`)) return;
    try {
      await fetch(`${apiUrl}/api/batches/delete-one`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: id }) });
      setStepHistory(prev => prev.filter(s => s.batch_id !== id));
    } catch (e) { console.error(e); }
  };

  const clearHistory = async () => {
    const pin = window.prompt("รหัสล้างประวัติทั้งหมด:");
    if (pin === "1234") {
      try {
        await fetch(`${apiUrl}/api/batches/reset`, { method: 'POST' });
        setStepHistory([]);
      } catch (e) { console.error(e); }
    }
  };

  return (
    <div style={{ paddingBottom: '120px' }}>
      <h2 className={styles.header} style={{ width: '95%', maxWidth: '500px', margin: '20px auto 15px auto', background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', borderRadius: '15px', padding: '15px', color: '#ffffff', textAlign: 'center', boxShadow: '0 6px 15px rgba(255, 107, 0, 0.3)' }}>
        ระบบบันทึก CIP
      </h2>

      {lockedBy && <LockBanner holderName={lockedBy} />}


      {cipSteps.map((step) => {
        const data = stepData[step.id] || { status: 'pending' };
        const isExpanded = expandedStep === step.id;
        return (
          <div key={step.id} className={`${styles.stepCard} ${styles[data.status]} ${!isExpanded ? styles.collapsed : styles.active}`}>
            <div className={styles.stepHeader} onClick={() => setExpandedStep(isExpanded ? null : step.id)}>
              <h3 className={styles.stepTitle}>{data.status === 'completed' && '✅ '}{step.id}. {step.description}</h3>
            </div>
            <div className={styles.actionButtons}>
               {!data.startTime ? (
                 <button className={styles.btnStart} onClick={(e) => { e.stopPropagation(); handleStart(step.id); }}>▶️ เริ่ม</button>
               ) : data.status !== 'completed' && (
                 <button className={styles.btnStop} onClick={(e) => { e.stopPropagation(); handleStop(step.id); }}>⏹️ หยุด</button>
               )}
            </div>
            <div className={styles.formGrid}>
                <div className={styles.formGroup}><label className={styles.formLabel}>แรงดัน</label><input type="number" className={styles.formInput} value={data.pressure || ''} onChange={(e) => handleInputChange(step.id, 'pressure', e.target.value)} onBlur={(e) => handleBlur(step.id, 'pressure', e.target.value)} placeholder="บาร์" /></div>
                <div className={styles.formGroup}><label className={styles.formLabel}>ค่า Brix</label><input type="number" className={styles.formInput} value={data.brix || ''} onChange={(e) => handleInputChange(step.id, 'brix', e.target.value)} onBlur={(e) => handleBlur(step.id, 'brix', e.target.value)} placeholder="% Brix" /></div>
                <div className={styles.formGroup}><label className={styles.formLabel}>ค่า pH</label><input type="number" className={styles.formInput} value={data.pH || ''} onChange={(e) => handleInputChange(step.id, 'pH', e.target.value)} onBlur={(e) => handleBlur(step.id, 'pH', e.target.value)} placeholder="pH" /></div>
                <div className={`${styles.formGroup} ${styles.fullWidth}`}><label className={styles.formLabel}>หมายเหตุ</label><input type="text" className={styles.formInput} value={data.remarks || ''} onChange={(e) => handleInputChange(step.id, 'remarks', e.target.value)} onBlur={(e) => handleBlur(step.id, 'remarks', e.target.value)} placeholder="..." /></div>
                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                  <label className={styles.formLabel}>📷 รูปถ่ายหน้างาน</label>
                  <input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFileChange(step.id, file); }} className={styles.formInput} />
                  {uploadingStep === step.id && <div style={{ color: '#ff6b00', fontSize: '0.8rem', marginTop: '5px' }}>⏳ กำลังอัปโหลด...</div>}
                  {(data.image || data.imagePath) && <div style={{ marginTop: '10px' }}><img src={data.image ? URL.createObjectURL(data.image) : (data.imagePath!.startsWith('data:') ? data.imagePath : `${apiUrl}${data.imagePath}`)} alt="Preview" style={{ width: '100%', maxWidth: '250px', borderRadius: '12px', border: '2px solid #ff6b00' }} /></div>}
                </div>
            </div>
          </div>
        );
      })}

      {batchId && <div style={{ padding: '20px', textAlign: 'center' }}><button onClick={handleFinishBatch} disabled={isFinishing} style={{ width: '100%', maxWidth: '400px', padding: '15px', background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', color: 'white', border: 'none', borderRadius: '15px', fontWeight: 'bold', boxShadow: '0 10px 25px rgba(255, 107, 0, 0.3)' }}>🏁 จบการทำงาน (Finish Batch)</button></div>}

      {(() => {
        const batchMap: Record<number, any> = {};
        stepHistory.forEach(s => {
          if (!batchMap[s.batch_id]) batchMap[s.batch_id] = { batchId: s.batch_id, operatorName: s.operator_name, batchStart: s.batch_start, batchEnd: s.batch_end, batchStatus: s.batch_status, steps: [] };
          batchMap[s.batch_id].steps.push(s);
        });
        const batchList = Object.values(batchMap).sort((a: any, b: any) => b.batchId - a.batchId);
        return (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '40px', marginBottom: '20px', padding: '0 15px' }}>
              <button onClick={handleOpenHistory} style={{ background: 'linear-gradient(135deg, #1565c0, #0d47a1)', color: 'white', border: 'none', borderRadius: '15px', padding: '18px 30px', fontWeight: 'bold', fontSize: '1.1rem', cursor: 'pointer', boxShadow: '0 8px 20px rgba(21, 101, 192, 0.3)', width: '100%', maxWidth: '400px' }}>
                📊 ดูประวัติ CIP ({batchList.length} ครั้ง)
              </button>
            </div>

            {showHistoryModal && (
              <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '15px' }}>
                <div style={{ backgroundColor: 'white', width: '100%', maxWidth: '700px', maxHeight: '90vh', borderRadius: '25px', padding: '25px', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.15)', border: '1px solid #eee' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '2px solid #eee', paddingBottom: '15px' }}>
                    <h3 style={{ margin: 0, color: '#1565c0' }}>📊 ประวัติ CIP ({batchList.length} ครั้ง)</h3>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button onClick={clearHistory} style={{ background: '#ffebee', color: '#d32f2f', border: '1px solid #ffcdd2', borderRadius: '10px', padding: '8px 12px', fontSize: '0.8rem' }}>🗑️ ล้างทั้งหมด</button>
                      <button onClick={() => setShowHistoryModal(false)} style={{ background: '#f5f5f5', color: '#666', border: '1px solid #ddd', borderRadius: '50%', width: '35px', height: '35px' }}>✕</button>
                    </div>
                  </div>

                  {batchList.length === 0 && <div style={{ textAlign: 'center', color: '#999', padding: '40px' }}>ยังไม่มีประวัติ CIP</div>}

                  {batchList.map((batch: any) => (
                    <div key={batch.batchId} style={{ border: '1px solid #eee', borderRadius: '14px', marginBottom: '12px', overflow: 'hidden' }}>
                      <div onClick={() => toggleBatch(batch.batchId)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: batch.batchStatus === 'completed' ? '#f1f8e9' : '#fff3e0', cursor: 'pointer' }}>
                        <div>
                          <div style={{ fontWeight: 'bold', fontSize: '0.95rem', color: '#333' }}>
                            {batch.batchStatus === 'completed' ? '✅' : '🔄'} CIP ครั้งที่ #{batch.batchId}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '2px' }}>
                            👤 {batch.operatorName || '-'} &nbsp;|&nbsp; {fmtDate(batch.batchStart)} &nbsp;|&nbsp; {batch.steps.length} ขั้นตอน
                          </div>
                          {batch.batchStart && (
                            <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '2px' }}>
                              🕐 {fmtTime(batch.batchStart)} → {fmtTime(batch.batchEnd)}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <button onClick={(e) => { e.stopPropagation(); deleteBatch(batch.batchId); }} style={{ background: '#ffebee', color: '#d32f2f', border: '1px solid #ffcdd2', borderRadius: '8px', padding: '4px 10px', fontSize: '0.75rem' }}>🗑️</button>
                          <span style={{ color: '#999', fontSize: '0.9rem' }}>{expandedBatches.has(batch.batchId) ? '▲' : '▼'}</span>
                        </div>
                      </div>

                      {expandedBatches.has(batch.batchId) && (
                        <div style={{ padding: '12px 16px', borderTop: '1px solid #eee' }}>
                          {batch.steps.map((s: any, i: number) => (
                            <div key={i} style={{ padding: '8px 0', borderBottom: i < batch.steps.length - 1 ? '1px solid #f5f5f5' : 'none' }}>
                              <div style={{ fontWeight: '600', fontSize: '0.85rem', color: s.end_time ? '#2e7d32' : '#e65100' }}>
                                {s.end_time ? '✅' : '▶️'} {s.step_number}. {s.step_description}
                              </div>
                              <div style={{ fontSize: '0.78rem', color: '#666', marginTop: '3px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                <span>⏱ {fmtTime(s.start_time)} → {fmtTime(s.end_time)}</span>
                                {s.pressure && <span>💨 {s.pressure} Bar</span>}
                                {s.brix && <span>🍬 {s.brix}</span>}
                                {s.ph && <span>🧪 {s.ph}</span>}
                                {s.remarks && <span>💬 {s.remarks}</span>}
                              </div>
                              {s.image_path && <img src={s.image_path.startsWith('data:') ? s.image_path : `${apiUrl}${s.image_path}`} alt="step" style={{ marginTop: '6px', width: '100%', maxWidth: '200px', borderRadius: '8px', border: '1px solid #ffcc80' }} />}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                  <button onClick={() => setShowHistoryModal(false)} style={{ width: '100%', padding: '12px', background: '#424242', color: 'white', border: 'none', borderRadius: '10px', marginTop: '10px' }}>ปิดหน้าต่างนี้</button>
                </div>
              </div>
            )}
          </>
        );
      })()}

      <FooterBar
        accentColor="#ff6b00"
        homeLabel="Home"
        onHome={() => { const p = window.prompt("รหัส:"); if (p === "1234") onHome(); }}
        finishLabel="สิ้นสุดการทำงาน"
        onFinish={finishSession}
        right={<OperatorBadge name={operatorName} color="#ff6b00" />}
      />
    </div>
  );
};

export default Logbook;
