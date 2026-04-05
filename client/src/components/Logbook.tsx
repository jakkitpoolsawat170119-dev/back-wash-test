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

  const startBatchIfNeeded = async () => {
    if (batchId) return batchId;
    try {
      console.log("Starting batch for:", operatorName);
      const response = await fetch(`${apiUrl}/api/batches/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName })
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      setBatchId(data.batchId);
      return data.batchId;
    } catch (error) {
      console.error('Failed to start batch', error);
      alert('ไม่สามารถเริ่มงานได้: ' + (error instanceof Error ? error.message : 'Unknown error'));
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
          [stepId]: { 
            ...prev[stepId], 
            imagePath: result.imagePath,
            image: undefined 
          }
        }));
      }
    } catch (error) {
      console.error('Failed to save step data', error);
    }
  };

  const handleStart = async (stepId: number) => {
    const activeBatchId = await startBatchIfNeeded();
    if (activeBatchId) {
      setStepData(prev => ({
        ...prev,
        [stepId]: { 
          startTime: new Date().toISOString(), 
          status: 'active',
          pressure: '',
          brix: '',
          pH: '',
          remarks: '',
          image: undefined,
          imagePath: undefined 
        }
      }));
      setExpandedStep(stepId);

      const formData = new FormData();
      formData.append('batchId', activeBatchId.toString());
      formData.append('stepNumber', stepId.toString());
      formData.append('stepDescription', cipSteps.find(s => s.id === stepId)?.description || '');
      formData.append('startTime', new Date().toISOString());
      
      await fetch(`${apiUrl}/api/steps/log`, {
        method: 'POST',
        body: formData,
      });
    }
  };

  const handleStop = (stepId: number) => {
    if (batchId) {
      const endTime = new Date().toISOString();
      const currentData = stepData[stepId] || {};
      
      // Send the latest data along with endTime to ensure n8n gets the right values
      saveStepData(stepId, { 
        startTime: currentData.startTime, // Added this line
        endTime, 
        status: 'completed',
        pressure: currentData.pressure,
        brix: currentData.brix,
        pH: currentData.pH,
        remarks: currentData.remarks
      }, batchId);

      // Auto-expand next step
      if (stepId < cipSteps.length) {
        setExpandedStep(stepId + 1);
      }
    }
  };

  const handleFinishBatch = async () => {
    if (!batchId) return;
    if (!window.confirm('คุณมั่นใจหรือไม่ว่าต้องการจบการทำงาน (Finish Batch) ของไลน์นี้?')) return;

    try {
      setIsFinishing(true);
      const response = await fetch(`${apiUrl}/api/batches/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId })
      });
      const data = await response.json();
      if (data.success) {
        alert('บันทึกการทำงานเสร็จสมบูรณ์!');
        onLogout(); // Log out after finishing
      }
    } catch (error) {
      alert('เกิดข้อผิดพลาดในการบันทึกตอนจบ');
    } finally {
      setIsFinishing(false);
    }
  };

  const handleInputChange = (stepId: number, field: keyof StepData, value: string) => {
    setStepData(prev => ({
      ...prev,
      [stepId]: { ...prev[stepId], [field]: value }
    }));
  };

  const handleBlur = (stepId: number, field: keyof StepData, value: string) => {
    if (batchId) {
      saveStepData(stepId, { [field]: value }, batchId);
    }
  };

  const handleFileChange = (stepId: number, file: File) => {
    if (batchId) {
      saveStepData(stepId, { image: file }, batchId);
    }
  };

  const formatTime = (timeStr?: string) => {
    if (!timeStr) return '-';
    return new Date(timeStr).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  };

  const isPhInvalid = (ph?: string) => {
    if (!ph) return false;
    const phVal = parseFloat(ph);
    return phVal > 10 || phVal < 4; // Example validation
  };

  return (
    <div>
      <div className={styles.navHeader} style={{ 
        flexDirection: 'column', 
        gap: '10px', 
        padding: '15px',
        backgroundColor: '#ffffff',
        border: '2px solid #ff6b00',
        color: '#000000'
      }}>
        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#000000' }}>
          👤 ผู้ปฏิบัติงาน: <span style={{ color: '#ff6b00' }}>{operatorName}</span>
          {batchId && <div style={{ fontSize: '0.9rem', color: '#666' }}>Batch ID: #{batchId}</div>}
        </div>
        <button className={styles.btnLogout} onClick={onLogout} style={{ width: '100%', maxWidth: '200px' }}>
          🚪 ออกจากระบบ
        </button>
      </div>

      <h2 className={styles.header} style={{
        width: '95%',
        maxWidth: '500px',
        margin: '0 auto 30px auto',
        backgroundColor: '#fff9f5',
        border: '4px solid #ff6b00',
        borderRadius: '15px',
        padding: '15px',
        color: '#e65100',
        textAlign: 'center',
        boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
      }}>
        บันทึก CIP - ส้ม ไลน์ 2
      </h2>

      {cipSteps.map((step) => {
        const data = stepData[step.id] || { status: 'pending' };
        const isExpanded = expandedStep === step.id;
        
        return (
          <div key={step.id} className={`${styles.stepCard} ${styles[data.status]} ${!isExpanded ? styles.collapsed : styles.active}`}>
            <div className={styles.stepHeader} onClick={() => setExpandedStep(isExpanded ? null : step.id)}>
              <h3 className={styles.stepTitle}>
                {data.status === 'completed' && '✅ '}
                {data.status === 'active' && '⏳ '}
                {step.id}. {step.description}
              </h3>
              <div className={styles.timeContainer}>
                <span>{formatTime(data.startTime)} - {formatTime(data.endTime)}</span>
              </div>
            </div>

            <div className={styles.actionButtons}>
               {!data.startTime ? (
                 <button className={styles.btnStart} onClick={(e) => { e.stopPropagation(); handleStart(step.id); }}>
                   เริ่ม (Start)
                 </button>
               ) : data.status !== 'completed' && (
                 <button className={styles.btnStop} onClick={(e) => { e.stopPropagation(); handleStop(step.id); }}>
                   เสร็จสิ้น (Stop)
                 </button>
               )}
            </div>

            <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>แรงดัน (Pressure)</label>
                  <input
                    type="number"
                    className={styles.formInput}
                    value={data.pressure || ''}
                    onChange={(e) => handleInputChange(step.id, 'pressure', e.target.value)}
                    onBlur={(e) => handleBlur(step.id, 'pressure', e.target.value)}
                    placeholder="บาร์"
                    inputMode="decimal"
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>ค่า Brix</label>
                  <input
                    type="number"
                    className={styles.formInput}
                    value={data.brix || ''}
                    onChange={(e) => handleInputChange(step.id, 'brix', e.target.value)}
                    onBlur={(e) => handleBlur(step.id, 'brix', e.target.value)}
                    placeholder="% Brix"
                    inputMode="decimal"
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>ค่า pH</label>
                  <input
                    type="number"
                    className={`${styles.formInput} ${isPhInvalid(data.pH) ? styles.invalidInput : ''}`}
                    value={data.pH || ''}
                    onChange={(e) => handleInputChange(step.id, 'pH', e.target.value)}
                    onBlur={(e) => handleBlur(step.id, 'pH', e.target.value)}
                    placeholder="pH"
                    inputMode="decimal"
                  />
                  {isPhInvalid(data.pH) && <span className={styles.warningLabel}>⚠️ ค่า pH ผิดปกติ!</span>}
                </div>
                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                  <label className={styles.formLabel}>หมายเหตุ</label>
                  <input
                    type="text"
                    className={styles.formInput}
                    value={data.remarks || ''}
                    onChange={(e) => handleInputChange(step.id, 'remarks', e.target.value)}
                    onBlur={(e) => handleBlur(step.id, 'remarks', e.target.value)}
                    placeholder="พิมพ์หมายเหตุเพิ่มเติม..."
                  />
                </div>
                
                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                  <label className={styles.formLabel}>📷 รูปถ่ายหน้างาน</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFileChange(step.id, file);
                    }}
                    className={styles.formInput}
                  />
                  {(data.image || data.imagePath) && (
                    <div style={{ marginTop: '10px' }}>
                      <img 
                        src={data.image ? URL.createObjectURL(data.image) : `${apiUrl}${data.imagePath}`} 
                        alt="Preview" 
                        style={{ width: '100%', maxWidth: '200px', borderRadius: '8px' }} 
                      />
                    </div>
                  )}
                </div>
            </div>
          </div>
        );
      })}

      {batchId && (
        <div className={styles.finishSection}>
          <p>เมื่อทำครบทุกขั้นตอนแล้ว กรุณากดปุ่มเพื่อจบงาน</p>
          <button 
            className={styles.btnFinish} 
            onClick={handleFinishBatch}
            disabled={isFinishing}
          >
            {isFinishing ? 'กำลังบันทึก...' : '🏁 จบการทำงาน (Finish Batch)'}
          </button>
        </div>
      )}
    </div>
  );
};

export default Logbook;
