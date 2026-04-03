import React, { useState, useEffect } from 'react';
import styles from '../App.module.css';

interface Batch {
  id: number;
  operator_name: string;
  start_time: string;
  end_time?: string;
}

const apiUrl = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:3001`;

const History: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<any | null>(null);

  const fetchBatches = () => {
    fetch(`${apiUrl}/api/batches`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setBatches(data);
      });
  };

  useEffect(() => {
    fetchBatches();
  }, []);

  const handleReset = async () => {
    if (window.confirm('คุณแน่ใจหรือไม่ว่าต้องการลบประวัติการบันทึกทั้งหมด? ข้อมูลที่ลบแล้วจะไม่สามารถกู้คืนได้')) {
      try {
        const response = await fetch(`${apiUrl}/api/batches/reset`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
          alert('ล้างประวัติเรียบร้อยแล้ว');
          fetchBatches();
        }
      } catch (error) {
        alert('เกิดข้อผิดพลาดในการล้างข้อมูล');
      }
    }
  };

  const fetchBatchDetail = (id: number) => {
    fetch(`${apiUrl}/api/batches/${id}`)
      .then(res => res.json())
      .then(data => setSelectedBatch(data));
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('th-TH');
  };

  if (selectedBatch) {
    return (
      <div>
        <button className={styles.backBtn} onClick={() => setSelectedBatch(null)}>← กลับไปหน้าประวัติ</button>
        <div className={styles.navHeader}>
          <h3>รายละเอียดการทำ CIP รอบที่ {selectedBatch.id}</h3>
          <div>โดย: {selectedBatch.operator_name}</div>
        </div>
        
        <table className={styles.historyTable}>
          <thead>
            <tr>
              <th>ขั้น</th>
              <th>รายละเอียด</th>
              <th>เวลาเริ่ม-จบ</th>
              <th>P (bar)</th>
              <th>Brix</th>
              <th>pH</th>
              <th>รูปถ่าย</th>
            </tr>
          </thead>
          <tbody>
            {selectedBatch.steps.map((step: any) => (
              <tr key={step.id}>
                <td>{step.step_number}</td>
                <td>{step.step_description}</td>
                <td>
                  {new Date(step.start_time).toLocaleTimeString('th-TH')} - 
                  {step.end_time ? new Date(step.end_time).toLocaleTimeString('th-TH') : '-'}
                </td>
                <td>{step.pressure || '-'}</td>
                <td>{step.brix || '-'}</td>
                <td>{step.ph || '-'}</td>
                <td>
                  {step.image_path ? (
                    <a href={`${apiUrl}${step.image_path}`} target="_blank" rel="noreferrer">
                      <img 
                        src={`${apiUrl}${step.image_path}`} 
                        alt="Step" 
                        style={{ width: '50px', height: '50px', objectFit: 'cover', borderRadius: '4px', border: '1px solid #ddd' }} 
                      />
                    </a>
                  ) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <button className={styles.backBtn} onClick={onBack} style={{margin: 0}}>← กลับหน้าหลัก</button>
        <button 
          onClick={handleReset}
          style={{ 
            backgroundColor: '#fff', 
            color: '#ff4d4d', 
            border: '1px solid #ff4d4d', 
            padding: '8px 16px', 
            borderRadius: '12px', 
            cursor: 'pointer',
            fontWeight: '600',
            fontSize: '0.9rem'
          }}
        >
          🗑️ ล้างประวัติ (Reset)
        </button>
      </div>
      <h2 className={styles.header}>ประวัติการทำ CIP ย้อนหลัง</h2>
      
      <table className={styles.historyTable}>
        <thead>
          <tr>
            <th>วันที่ / เวลาเริ่ม</th>
            <th>ผู้ปฏิบัติงาน</th>
            <th>รหัสรอบ</th>
            <th>รายละเอียด</th>
          </tr>
        </thead>
        <tbody>
          {batches.map(batch => (
            <tr key={batch.id} className={styles.historyRow} onClick={() => fetchBatchDetail(batch.id)}>
              <td>{formatDate(batch.start_time)}</td>
              <td>{batch.operator_name}</td>
              <td>Batch #{batch.id}</td>
              <td style={{color: '#ff6b00', fontWeight: 'bold'}}>คลิกดู</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default History;
