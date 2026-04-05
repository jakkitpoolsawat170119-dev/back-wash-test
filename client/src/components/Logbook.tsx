import React, { useState } from 'react';
import styles from '../App.module.css';
import { cipSteps } from '../data/steps';

interface LogbookProps {
  operatorName: string;
  onLogout: () => void;
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

const Logbook: React.FC<LogbookProps> = ({ operatorName, onLogout }) => {
  const [batchId, setBatchId] = useState<number | null>(null);
  const [stepData, setStepData] = useState<Record<number, StepData>>({});
  const [expandedStep, setExpandedStep] = useState<number | null>(1);
  const [isFinishing, setIsFinishing] = useState(false);
  const [uploadingStep, setUploadingStep] = useState<number | null>(null);

  const startBatchIfNeeded = async () => {
    if (batchId) return batchId;
    try {
      const response = await fetch(`${apiUrl}/api/batches/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName })
      });
      const data = await response.json();
      setBatchId(data.batchId);
      return data.batchId;
    } catch (error) {
      alert('ไม่สามารถเริ่มงานได้');
      return null;
    }
  };

  const saveStepData = async (stepId: number, update: Partial<StepData>, currentBatchId: number) => {
    const step = cipSteps.find(s => s.id === stepId);
    const formData = new FormData();
    formData.append('batchId', currentBatchId.toString());
    formData.append('stepNumber', stepId.toString());
    formData.append('stepDescription', step?.description || '');
    
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
      const response = await fetch(`${apiUrl}/api/steps/log`, {
        method: 'POST',
        body: formData,
      });
      const result = await response.json();
      if (result.success && result.imagePath) {
        setStepData(prev => ({
          ...prev,
          [stepId]: { ...prev[stepId], imagePath: result.imagePath, image: undefined }
        }));
      }
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
      setStepData(prev => ({
        ...prev,
        [stepId]: { startTime, status: 'active', pressure: '', brix: '', pH: '', remarks: '' }
      }));
      setExpandedStep(stepId);
      saveStepData(stepId, { startTime }, activeBatchId);
    }
  };

  const handleStop = (stepId: number) => {
    if (batchId) {
      const endTime = new Date().toISOString();
      const currentData = stepData[stepId] || {};
      saveStepData(stepId, { ...currentData, endTime, status: 'completed' }, batchId);
      if (stepId < cipSteps.length) setExpandedStep(stepId + 1);
    }
  };

  const handleFinishBatch = async () => {
    if (!batchId) return;
    if (!window.confirm('ยืนยันจบการทำงาน?')) return;
    try {
      setIsFinishing(true);
      await fetch(`${apiUrl}/api/batches/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId })
      });
      alert('บันทึกสมบูรณ์!');
      onLogout();
    } catch (error) {
      alert('เกิดข้อผิดพลาด');
    } finally {
      setIsFinishing(false);
    }
  };

  const handleInputChange = (stepId: number, field: keyof StepData, value: string) => {
    setStepData(prev => ({ ...prev, [stepId]: { ...prev[stepId], [field]: value } }));
  };

  const handleBlur = (stepId: number, field: keyof StepData, value: string) => {
    if (batchId) saveStepData(stepId, { [field]: value }, batchId);
  };

  const handleFileChange = (stepId: number, file: File) => {
    if (batchId) saveStepData(stepId, { image: file }, batchId);
  };

  return (
    <div style={{ paddingBottom: '50px' }}>
      <div className={styles.navHeader} style={{ 
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 20px', backgroundColor: '#ffffff', borderBottom: '4px solid #ff6b00',
        borderRadius: '0 0 20px 20px', marginBottom: '20px', boxShadow: '0 4px 10px rgba(0,0,0,0.05)'
      }}>
        <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#000000' }}>
          👤 <span style={{ color: '#ff6b00' }}>{operatorName}</span>
          {batchId && <div style={{ fontSize: '0.75rem', color: '#888' }}>Batch: #{batchId}</div>}
        </div>
        <button className={styles.btnLogout} onClick={onLogout} style={{ padding: '8px 15px', fontSize: '0.8rem' }}>
          🚪 ออกจากระบบ
        </button>
      </div>

      <h2 className={styles.header} style={{
        width: '95%', maxWidth: '500px', margin: '0 auto 30px auto',
        background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', borderRadius: '15px',
        padding: '15px', color: '#ffffff', textAlign: 'center', boxShadow: '0 6px 15px rgba(255, 107, 0, 0.3)'
      }}>
        ระบบบันทึก CIP
      </h2>

      {cipSteps.map((step) => {
        const data = stepData[step.id] || { status: 'pending' };
        const isExpanded = expandedStep === step.id;
        
        return (
          <div key={step.id} className={`${styles.stepCard} ${styles[data.status]} ${!isExpanded ? styles.collapsed : styles.active}`}>
            <div className={styles.stepHeader} onClick={() => setExpandedStep(isExpanded ? null : step.id)}>
              <h3 className={styles.stepTitle}>
                {data.status === 'completed' && '✅ '}{data.status === 'active' && '⏳ '}{step.id}. {step.description}
              </h3>
            </div>

            <div className={styles.actionButtons}>
               {!data.startTime ? (
                 <button className={styles.btnStart} onClick={(e) => { e.stopPropagation(); handleStart(step.id); }}>▶️ เริ่ม (Start)</button>
               ) : data.status !== 'completed' && (
                 <button className={styles.btnStop} onClick={(e) => { e.stopPropagation(); handleStop(step.id); }}>⏹️ เสร็จสิ้น (Stop)</button>
               )}
            </div>

            <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>แรงดัน (Pressure)</label>
                  <input type="number" className={styles.formInput} value={data.pressure || ''} onChange={(e) => handleInputChange(step.id, 'pressure', e.target.value)} onBlur={(e) => handleBlur(step.id, 'pressure', e.target.value)} placeholder="บาร์" inputMode="decimal" />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>ค่า Brix</label>
                  <input type="number" className={styles.formInput} value={data.brix || ''} onChange={(e) => handleInputChange(step.id, 'brix', e.target.value)} onBlur={(e) => handleBlur(step.id, 'brix', e.target.value)} placeholder="% Brix" inputMode="decimal" />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>ค่า pH</label>
                  <input type="number" className={styles.formInput} value={data.pH || ''} onChange={(e) => handleInputChange(step.id, 'pH', e.target.value)} onBlur={(e) => handleBlur(step.id, 'pH', e.target.value)} placeholder="pH" inputMode="decimal" />
                </div>
                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                  <label className={styles.formLabel}>หมายเหตุ</label>
                  <input type="text" className={styles.formInput} value={data.remarks || ''} onChange={(e) => handleInputChange(step.id, 'remarks', e.target.value)} onBlur={(e) => handleBlur(step.id, 'remarks', e.target.value)} placeholder="พิมพ์หมายเหตุเพิ่มเติม..." />
                </div>
                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                  <label className={styles.formLabel}>📷 รูปถ่ายหน้างาน</label>
                  <input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFileChange(step.id, file); }} className={styles.formInput} style={{ border: uploadingStep === step.id ? '2px solid #ff6b00' : '1px solid #ddd' }} />
                  {uploadingStep === step.id && <div style={{ color: '#ff6b00', fontSize: '0.8rem', marginTop: '5px', fontWeight: 'bold' }}>⏳ กำลังอัปโหลดรูปภาพ...</div>}
                  {(data.image || data.imagePath) && (
                    <div style={{ marginTop: '10px' }}>
                      <img src={data.image ? URL.createObjectURL(data.image) : `${apiUrl}${data.imagePath}`} alt="Preview" style={{ width: '100%', maxWidth: '250px', borderRadius: '12px', border: '2px solid #ff6b00' }} />
                    </div>
                  )}
                </div>
            </div>
          </div>
        );
      })}

      {batchId && (
        <div className={styles.finishSection}>
          <button className={styles.btnFinish} onClick={handleFinishBatch} disabled={isFinishing}>
            {isFinishing ? 'กำลังบันทึก...' : '🏁 จบการทำงาน (Finish Batch)'}
          </button>
        </div>
      )}
    </div>
  );
};

export default Logbook;
