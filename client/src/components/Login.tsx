import React, { useState, useEffect, useRef } from 'react';
import styles from '../App.module.css';
import confetti from 'canvas-confetti';
import Logo from './Logo';

const greetings = [
  "สวัสดีครับ พร้อมลุยงานหรือยังครับ? ✌️",
  "ขอให้เป็นกะที่ราบรื่นนะครับ! 😊",
  "สุดยอดพนักงานดีเด่นมาแล้ว! 🏆",
  "สู้ๆ ครับ วันนี้ทำได้แน่นอน! 🚀",
  "ยินดีต้อนรับกลับมาครับ! 🌟"
];

const AVATAR_COLORS = ['#0d47a1', '#01579b', '#006064', '#1b5e20', '#6a1b9a', '#b71c1c', '#e65100', '#37474f'];

function avatarColor(name: string): string {
  const sum = name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

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
  const [loggingIn, setLoggingIn] = useState(false);
  const pinInputRef = useRef<HTMLInputElement>(null);
  const autoSubmitted = useRef(false);

  const selectOperator = (name: string) => {
    if (selectedOp !== name) {
      setSelectedOp(name);
      setPin('');
      autoSubmitted.current = false;
      setWelcomeNote(greetings[Math.floor(Math.random() * greetings.length)]);

      // 🧨 Trigger Confetti!
      confetti({
        particleCount: 150,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#ff6b00', '#ffd700', '#ffffff']
      });

      setTimeout(() => pinInputRef.current?.focus(), 350);
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
      setLoggingIn(true);
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
          setPin('');
          autoSubmitted.current = false;
        }
      } catch (err) {
        alert('ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้');
      } finally {
        setLoggingIn(false);
      }
    } else {
      alert('กรุณาเลือกชื่อผู้ใช้งานและใส่ PIN 4 หลัก');
    }
  };

  // Auto-submit once the 4th digit is entered
  useEffect(() => {
    if (pin.length === 4 && !autoSubmitted.current) {
      autoSubmitted.current = true;
      handleLogin();
    }
  }, [pin]);

  return (
    <div className={styles.loginCard}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', marginBottom: '26px' }}>
        <Logo size={72} />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: '1.05rem', color: '#37474f', letterSpacing: '-0.01em' }}>เลือกผู้ปฏิบัติงาน</div>
          <div style={{ fontSize: '0.68rem', color: '#9aa3a8', marginTop: '3px' }}>ระบบบันทึกข้อมูลการผลิต & CIP</div>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '30px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <style>{`@keyframes loginSpin { to { transform: rotate(360deg); } }`}</style>
          <div style={{
            width: '26px', height: '26px', borderRadius: '50%',
            border: '3px solid #ffe0c2', borderTopColor: '#ff6b00',
            animation: 'loginSpin 0.7s linear infinite',
          }} />
          <span style={{ color: '#ff8c00', fontWeight: 700, fontSize: '0.85rem' }}>กำลังโหลดรายชื่อ...</span>
        </div>
      ) : (
        <>
          {error && <div style={{ color: '#c62828', marginBottom: '10px', fontSize: '0.8rem', backgroundColor: '#fee', padding: '10px', borderRadius: '8px' }}>{error}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
            {operators.map(op => {
              const active = selectedOp === op;
              return (
                <button
                  key={op}
                  onClick={() => selectOperator(op)}
                  className="login-op-card"
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
                    padding: '16px 8px', borderRadius: '18px', cursor: 'pointer',
                    border: `2px solid ${active ? '#ff6b00' : 'rgba(0,0,0,0.06)'}`,
                    background: active ? 'linear-gradient(135deg, rgba(255,107,0,0.10), rgba(255,140,0,0.04))' : 'rgba(255,255,255,0.7)',
                    boxShadow: active ? '0 6px 18px -4px rgba(255,107,0,0.35)' : '0 2px 8px rgba(0,0,0,0.04)',
                    transform: active ? 'translateY(-2px)' : 'translateY(0)',
                    transition: 'transform 0.16s cubic-bezier(0.22,1,0.36,1), box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease',
                  }}
                >
                  <div style={{
                    width: '46px', height: '46px', borderRadius: '50%', flexShrink: 0,
                    background: active ? 'linear-gradient(135deg, #ff6b00, #ff8c00)' : avatarColor(op),
                    color: 'white', fontWeight: 800, fontSize: '1.05rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: active ? '0 4px 12px -2px rgba(255,107,0,0.5)' : '0 2px 6px rgba(0,0,0,0.15)',
                  }}>
                    {op.trim().charAt(0).toUpperCase()}
                  </div>
                  <span style={{ fontWeight: 700, fontSize: '0.82rem', color: active ? '#e65100' : '#37474f', textAlign: 'center', lineHeight: 1.25 }}>
                    {op}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {selectedOp && (
        <div className={styles.pinInput}>
          <div className={styles.welcomeMsg}>
            ✨ {welcomeNote}
          </div>
          <label style={{ fontWeight: '600', color: '#666', marginBottom: '4px', fontSize: '0.85rem' }}>
            ยินดีต้อนรับคุณ {selectedOp}! กรุณาใส่รหัส PIN
          </label>

          <div style={{ position: 'relative', display: 'inline-block', marginTop: '6px' }}>
            <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} style={{
                  width: '20px', height: '20px', borderRadius: '50%',
                  border: `2px solid ${pin.length > i ? '#ff6b00' : '#ffd2ad'}`,
                  background: pin.length > i ? 'linear-gradient(135deg, #ff6b00, #ff8c00)' : 'transparent',
                  transform: pin.length === i + 1 ? 'scale(1.18)' : 'scale(1)',
                  transition: 'transform 0.15s cubic-bezier(0.22,1,0.36,1), background-color 0.15s, border-color 0.15s',
                }} />
              ))}
            </div>
            <input
              ref={pinInputRef}
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', border: 'none' }}
            />
          </div>

          <button className={styles.btnPrimary} onClick={handleLogin} disabled={loggingIn} style={{ marginTop: '24px', opacity: loggingIn ? 0.7 : 1 }}>
            {loggingIn ? '⏳ กำลังเข้าสู่ระบบ...' : '🚀 เข้าสู่ระบบ (Login)'}
          </button>
        </div>
      )}

      <style>{`
        .login-op-card:active { transform: scale(0.96) !important; }
        .login-op-card:focus-visible { outline: 2px solid #ff6b00; outline-offset: 2px; }
      `}</style>
    </div>
  );
};

export default Login;
