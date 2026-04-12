import React, { useState, useEffect } from 'react';
import styles from '../App.module.css';
import { cipSteps } from '../data/steps';

interface LogbookProps {
  operatorName: string;
  onLogout: () => void;
  onBackToMain: () => void;
  onHome: () => void;
  onStatusChange: (active: boolean) => void;
  onViewHistory?: () => void;
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

const Logbook: React.FC<LogbookProps> = ({ operatorName, onLogout, onBackToMain, onHome, onStatusChange }) => {
  const [batchId, setBatchId] = useState<number | null>(null);
  const [stepData, setStepData] = useState<Record<number, StepData>>({});
  const [expandedStep, setExpandedStep] = useState<number | null>(1);
  const [isFinishing, setIsFinishing] = useState(false);
  const [uploadingStep, setUploadingStep] = useState<number | null>(null);
  
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [stepHistory, setStepHistory] = useState<any[]>([]);

  const loadHistory = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/steps`);
      const data = await res.json();
      if (Array.isArray(data)) setStepHistory(data);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { loadHistory(); }, []);

  const handleOpenHistory = () => { loadHistory(); setShowHistoryModal(true); };

  const startBatchIfNeeded = async () => {
    if (batchId) return batchId;
    try {
      const res = await fetch(`${apiUrl}/api/batches/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName })
      });
      const data = await res.json();
      if (data.batchId) {
        setBatchId(data.batchId);
        if (onStatusChange) onStatusChange(true);
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
    if (update.startTime) formData.append('startTime', update.startTime);
    if (update.endTime) formData.append('endTime', update.endTime);
    if (update.pressure) formData.append('pressure', update.pressure);
    if (update.brix) formData.append('brix', update.brix);
    if (update.pH) formData.append('ph', update.pH);
    if (update.remarks) formData.append('remarks', update.remarks);
    if (update.image instanceof File) {
      formData.append('image', update.image);
      setUploadingStep(stepId);
    }
    setStepData(prev => ({
      ...prev,
      [stepId]: { ...(prev[stepId] || { status: 'pending' }), ...update }
    }));
    try {
      const response = await fetch(`${apiUrl}/api/steps/log`, { method: 'POST', body: formData });
      const result = await response.json();
      if (result.success && result.imagePath) {
        setStepData(prev => ({ ...prev, [stepId]: { ...prev[stepId], imagePath: result.imagePath, image: undefined } }));
      }
      loadHistory();
    } catch (error) { console.error('Save error', error);
    } finally { setUploadingStep(null); }
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
      await saveStepData(stepId, { endTime, status: 'completed' }, batchId);
      if (stepId < cipSteps.length) setExpandedStep(stepId + 1);
    }
  };

  const handleFinishBatch = async () => {
    if (!batchId) return;
    if (!window.confirm('🏁 ยืนยันจบการทำงาน (Finish Batch) หรือไม่?')) return;
    try {
      setIsFinishing(true);
      await fetch(`${apiUrl}/api/batches/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId })
      });
      alert('บันทึก CIP สมบูรณ์เรียบร้อยแล้ว!');
      if (onStatusChange) onStatusChange(false);
      setBatchId(null);
      setStepData({});
      setExpandedStep(1);
      onBackToMain();
    } catch (error) {
      alert('เกิดข้อผิดพลาดในการบันทึก');
    } finally {
      setIsFinishing(false);
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
      setStepData({});
      setExpandedStep(1);
      if (onStatusChange) onStatusChange(false);
    }
  };

  const clearHistory = async () => {
    const pin = window.prompt("รหัสผ่านล้างประวัติ:");
    if (pin === "1234") {
      try {
        await fetch(`${apiUrl}/api/batches/reset`, { method: 'POST' });
        setStepHistory([]);
        alert("ล้างประวัติเรียบร้อย");
      } catch (e) { console.error(e); }
    }
  };

  return (
    <div style={{ paddingBottom: '150px' }}>
      <h2 className={styles.header} style={{ width: '95%', maxWidth: '500px', margin: '20px auto 15px auto', background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', borderRadius: '15px', padding: '15px', color: '#ffffff', textAlign: 'center', boxShadow: '0 6px 15px rgba(255, 107, 0, 0.3)' }}>
        ระบบบันทึก CIP
      </h2>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '95%', maxWidth: '500px', margin: '0 auto 25px auto', gap: '10px' }}>
        <button onClick={onBackToMain} style={{ background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '10px', padding: '10px 15px', fontSize: '0.8rem', cursor: 'pointer', color: '#666', fontWeight: 'bold' }}>🔙 เมนูหลัก</button>
        <button onClick={onLogout} style={{ padding: '10px 20px', fontSize: '0.85rem', fontWeight: 'bold', background: 'linear-gradient(135deg, #2e7d32, #4caf50)', color: 'white', border: 'none', borderRadius: '10px', boxShadow: '0 4px 10px rgba(46, 125, 50, 0.2)', cursor: 'pointer' }}>🔄 ไปหน้าผลิต</button>
      </div>

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
                  {(data.image || data.imagePath) && <div style={{ marginTop: '10px' }}><img src={data.image ? URL.createObjectURL(data.image) : `${apiUrl}${data.imagePath}`} alt="Preview" style={{ width: '100%', maxWidth: '250px', borderRadius: '12px', border: '2px solid #ff6b00' }} /></div>}
                </div>
            </div>
          </div>
        );
      })}

      {/* --- ส่วนปุ่ม Finish: ปรับให้โชว์ตลอดถ้ามีการเริ่มงานแล้ว และดีไซน์ให้ใหญ่ขึ้น --- */}
      {batchId && (
        <div style={{ padding: '20px 15px', textAlign: 'center', background: '#fff9f5', borderRadius: '20px', margin: '20px 10px', border: '2px dashed #ff6b00' }}>
          <p style={{ color: '#e65100', fontWeight: 'bold', marginBottom: '15px' }}>✨ เมื่อทำครบทุกขั้นตอนแล้ว กรุณากดปุ่มด้านล่างเพื่อบันทึก Batch นี้</p>
          <button 
            onClick={handleFinishBatch} 
            disabled={isFinishing}
            style={{ width: '100%', maxWidth: '400px', padding: '20px', background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', color: 'white', border: 'none', borderRadius: '15px', fontSize: '1.2rem', fontWeight: '800', cursor: 'pointer', boxShadow: '0 10px 25px rgba(255, 107, 0, 0.3)' }}
          >
            {isFinishing ? '⏳ กำลังบันทึก...' : '🏁 จบการทำงาน (Finish Batch)'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '40px', marginBottom: '20px', padding: '0 15px' }}>
        <button onClick={handleOpenHistory} style={{ background: 'linear-gradient(135deg, #1565c0, #0d47a1)', color: 'white', border: 'none', borderRadius: '15px', padding: '18px 30px', fontWeight: 'bold', fontSize: '1.1rem', cursor: 'pointer', boxShadow: '0 8px 20px rgba(21, 101, 192, 0.3)', width: '100%', maxWidth: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          📊 ดูสรุปประวัติ CIP ทั้งหมด ({stepHistory.length} รายการ)
        </button>
      </div>

      {showHistoryModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '15px' }}>
            <div style={{ backgroundColor: 'white', width: '100%', maxWidth: '900px', maxHeight: '90vh', borderRadius: '25px', padding: '25px', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.15)', border: '1px solid #eee' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '2px solid #eee', paddingBottom: '15px' }}>
                    <h3 style={{ margin: 0, color: '#1565c0' }}>📊 ประวัติการทำ CIP</h3>
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <button onClick={clearHistory} style={{ background: '#ffebee', color: '#d32f2f', border: '1px solid #ffcdd2', borderRadius: '10px', padding: '8px 15px' }}>🗑️ ล้างประวัติ</button>
                        <button onClick={() => setShowHistoryModal(false)} style={{ background: '#f5f5f5', color: '#666', border: '1px solid #ddd', borderRadius: '50%', width: '35px', height: '35px' }}>X</button>
                    </div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                        <thead><tr style={{ backgroundColor: '#f5f5f5' }}><th>Batch</th><th>ขั้นตอน</th><th>แรงดัน</th><th>Brix</th><th>PH</th><th>ผู้บันทึก</th></tr></thead>
                        <tbody>
                            {stepHistory.map((s, i) => (
                                <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                                    <td>#{s.batch_id}</td><td>{s.step_description}</td><td>{s.pressure}</td><td>{s.brix}</td><td>{s.ph}</td><td>{s.operator_name}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <button onClick={() => setShowHistoryModal(false)} style={{ width: '100%', padding: '12px', background: '#424242', color: 'white', border: 'none', borderRadius: '10px', marginTop: '20px', fontWeight: 'bold', cursor: 'pointer' }}>ปิดหน้าต่างนี้</button>
            </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#fff', padding: '15px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #ff6b00', boxShadow: '0 -4px 15px rgba(0,0,0,0.1)', zIndex: 100 }}>
        <button onClick={() => { const p = window.prompt("รหัส:"); if (p === "1234") onHome(); }} style={{ background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '10px', padding: '10px 15px', fontSize: '0.85rem', cursor: 'pointer', color: '#333', fontWeight: 'bold' }}>🏠 Home</button>
        <button onClick={finishSession} style={{ background: '#d32f2f', color: 'white', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 10px rgba(211, 47, 47, 0.3)' }}>🏁 สิ้นสุดการทำงาน</button>
        <div style={{ fontSize: '0.9rem', fontWeight: 'bold', color: '#333' }}>👤 <span style={{ color: '#ff6b00' }}>{operatorName}</span></div>
      </div>
    </div>
  );
};

export default Logbook;
