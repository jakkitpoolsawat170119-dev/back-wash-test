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

const apiUrl = import.meta.env.VITE_API_URL || "https://back-wash-test.onrender.com";
console.log("Current API URL:", apiUrl);

  useEffect(() => {
    fetch(`${apiUrl}/api/operators`)
      .then(res => res.json())
      .then(data => {
        setOperators(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to fetch operators', err);
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
      } catch (error) {
        alert('ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้');
      }
    } else {
      alert('กรุณาเลือกชื่อผู้ใช้งานและใส่ PIN 4 หลัก');
    }
  };

  if (loading) return <div className={styles.loginCard}>กำลังโหลดรายชื่อ...</div>;

  return (
    <div className={styles.loginCard}>
      <h2>เลือกผู้ปฏิบัติงาน (Operator)</h2>
      <div className={styles.operatorButtons}>
        {operators.map(op => (
          <button
            key={op}
            className={`${styles.btnOperator} ${selectedOp === op ? styles.active : ''}`}
            onClick={() => setSelectedOp(op)}
          >
            {op}
          </button>
        ))}
      </div>

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
