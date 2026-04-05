import React, { useState, useEffect } from 'react';
import styles from '../App.module.css';
import confetti from 'canvas-confetti';

const greetings = [
  "สวัสดีครับ พร้อมลุยงานหรือยังครับ? ✌️",
  "ขอให้เป็นกะที่ราบรื่นนะครับ! 😊",
  "สุดยอดพนักงานดีเด่นมาแล้ว! 🏆",
  "สู้ๆ ครับ วันนี้ทำได้แน่นอน! 🚀",
  "ยินดีต้อนรับกลับมาครับ! 🌟"
];

interface LoginProps {
  onLogin: (operatorName: string) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [operators, setOperators] = useState<string[]>([]);
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const [welcomeNote, setWelcomeNote] = useState('');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectOperator = (name: string) => {
    if (selectedOp !== name) {
      setSelectedOp(name);
      setWelcomeNote(greetings[Math.floor(Math.random() * greetings.length)]);
      
      // 🧨 Trigger Confetti!
      confetti({
        particleCount: 150,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#ff6b00', '#ffd700', '#ffffff']
      });
    }
  };

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
        background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', 
        border: 'none', 
        borderRadius: '15px', 
        padding: '12px',
        color: '#ffffff',
        textAlign: 'center',
        width: '95%',
        maxWidth: '450px',
        margin: '0 auto 20px auto',
        boxShadow: '0 4px 10px rgba(255, 107, 0, 0.2)',
        fontSize: '1.4rem'
      }}>
        เลือกผู้ปฏิบัติงาน
      </h2>

      {loading ? (
        <div style={{ padding: '30px', color: '#ff6b00', fontWeight: 'bold', textAlign: 'center' }}>
          ⏳ กำลังโหลดรายชื่อ...
        </div>
      ) : (
        <>
          {error && <div style={{ color: 'red', marginBottom: '10px', fontSize: '0.8rem', backgroundColor: '#fee', padding: '10px', borderRadius: '8px' }}>{error}</div>}
          <div className={styles.operatorButtons} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
            {operators.map(op => (
              <button
                key={op}
                className={`${styles.btnOperator} ${selectedOp === op ? styles.active : ''}`}
                style={{
                  width: '100%',
                  maxWidth: '380px',
                  margin: '0 auto 10px auto',     
                  boxShadow: '0 4px 8px rgba(0,0,0,0.06)',
                  backgroundColor: selectedOp === op ? '#ff6b00' : '#ffffff',
                  color: selectedOp === op ? '#ffffff' : '#000000',
                  border: '2px solid ' + (selectedOp === op ? '#ff6b00' : '#eeeeee'),
                  padding: '16px 10px',
                  borderRadius: '16px',
                  cursor: 'pointer',
                  fontWeight: '700',
                  fontSize: '1.2rem',
                  display: 'block',
                  textAlign: 'center',
                  transition: 'all 0.2s ease'
                }}
                onClick={() => selectOperator(op)}
              >
                {op}
              </button>
            ))}
          </div>
        </>
      )}

      {selectedOp && (
        <div className={styles.pinInput}>
          <div className={styles.welcomeMsg}>
            ✨ {welcomeNote}
          </div>
          <label style={{ fontWeight: '600', color: '#666', marginBottom: '8px' }}>
            ยินดีต้อนรับคุณ {selectedOp}! กรุณาใส่รหัส PIN
          </label>
          <input
            type="password"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className={styles.inputField}
            placeholder="****"
            pattern="[0-9]*"
            inputMode="numeric"
            style={{ marginBottom: '20px' }}
          />
          <button className={styles.btnPrimary} onClick={handleLogin}>
            🚀 เข้าสู่ระบบ (Login)
          </button>
        </div>
      )}
    </div>
  );
};

export default Login;
