import React, { useState, useEffect } from 'react';
import styles from '../App.module.css';

interface LoginProps {
  onLogin: (operatorName: string) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [operators, setOperators] = useState<string[]>([]);
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiUrl = "https://back-wash-test.onrender.com";
  console.log("Current API URL:", apiUrl);

  useEffect(() => {
    fetch(`${apiUrl}/api/operators`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json();
      })
      .then(data => {
        // Deduplicate names just in case backend has duplicates
        const uniqueOperators = Array.isArray(data) ? [...new Set(data)] : [];
        setOperators(uniqueOperators);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to fetch operators', err);
        setError(`เชื่อมต่อไม่ได้: ${err.message} (พยายามเรียกไปที่: ${apiUrl})`);
        setLoading(false);
      });
  }, [apiUrl]);

  const handleLogin = async () => {
    if (selectedOp && pin.length >= 4) {
      try {
        const response = await fetch(`${apiUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: selectedOp, pin })
        });
        const data = await response.json();
        if (data.success) {
          onLogin(selectedOp);
        } else {
          alert('รหัส PIN ไม่ถูกต้อง');
        }
      } catch (err) {
        alert('ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้');
      }
    } else {
      alert('กรุณาเลือกชื่อผู้ใช้งานและใส่ PIN 4 หลัก');
    }
  };

  return (
    <div className={styles.loginCard}>
      <h2 style={{ 
        backgroundColor: '#fff9f5', 
        border: '3px solid #ff6b00', 
        borderRadius: '15px', 
        padding: '12px',
        color: '#e65100',
        textAlign: 'center',
        width: '90%',
        maxWidth: '450px',
        margin: '0 auto 20px auto',
        boxShadow: '0 4px 10px rgba(0,0,0,0.1)'
      }}>
        เลือกผู้ปฏิบัติงาน
      </h2>

      {loading ? (
        <div style={{ padding: '30px', color: '#666', fontStyle: 'italic', textAlign: 'center' }}>
          ⏳ กำลังโหลดรายชื่อ...
        </div>
      ) : (
        <>
          {error && <div style={{ color: 'red', marginBottom: '10px', fontSize: '0.8rem', backgroundColor: '#fee', padding: '10px', borderRadius: '8px' }}>{error}</div>}
          <div className={styles.operatorButtons}>
            {operators.map(op => (
              <button
                key={op}
                className={`${styles.btnOperator} ${selectedOp === op ? styles.active : ''}`}
                style={{
                  width: '90%',
                  maxWidth: '350px',
                  margin: '0 auto 12px auto',     
                  boxShadow: '0 4px 8px rgba(0,0,0,0.1)',
                  backgroundColor: selectedOp === op ? '#ff6b00' : '#ffffff',
                  color: selectedOp === op ? '#ffffff' : '#333333',
                  border: '1px solid #ddd',
                  padding: '18px 20px',
                  borderRadius: '16px',
                  cursor: 'pointer',
                  fontWeight: '600',
                  fontSize: '1.2rem',
                  display: 'block',
                  transition: 'all 0.3s ease'
                }}
                onClick={() => setSelectedOp(op)}
              >
                {op}
              </button>
            ))}
          </div>
        </>
      )}

      {selectedOp && (
        <div className={styles.pinInput}>
          <label>กรุณาใส่รหัส PIN 4 หลัก</label>
          <input
            type="password"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className={styles.inputField}
            placeholder="****"
            pattern="[0-9]*"
            inputMode="numeric"
          />
          <button className={styles.btnPrimary} onClick={handleLogin}>
            เข้าสู่ระบบ
          </button>
        </div>
      )}
    </div>
  );
};

export default Login;
