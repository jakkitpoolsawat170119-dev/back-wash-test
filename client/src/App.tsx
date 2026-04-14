import React, { useState, useEffect, useCallback } from 'react';
import Login from './components/Login';
import Logbook from './components/Logbook';
import CipLine2Form from './components/CipLine2Form';
import CipLine1Form from './components/CipLine1Form';
import ProductionRecord from './components/ProductionRecord';
import styles from './App.module.css';

const App: React.FC = () => {
  const [operator, setOperator] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<'selection' | 'cip' | 'cipLine2' | 'cipLine1' | 'production'>('selection');
  const [isFlipping, setIsFlipping] = useState(false);
  const [isCipActive, setIsCipActive] = useState(false);
  const [isProdActive, setIsProdActive] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('operator');
    if (saved) setOperator(saved);
  }, []);

  const handleLogin = (name: string) => {
    localStorage.setItem('operator', name);
    setOperator(name);
    setAppMode('selection');
  };

  const handleLogout = () => {
    if (window.confirm("ยืนยันออกจากระบบ?")) {
      localStorage.removeItem('operator');
      setOperator(null);
      setAppMode('selection');
      setIsCipActive(false);
      setIsProdActive(false);
    }
  };

  const switchMode = (targetMode: 'cip' | 'cipLine2' | 'cipLine1' | 'production' | 'selection') => {
    setIsFlipping(true);
    setTimeout(() => {
      setAppMode(targetMode);
      setTimeout(() => setIsFlipping(false), 300);
    }, 300);
  };

  const handleCipStatus = useCallback((active: boolean) => setIsCipActive(active), []);
  const handleProdStatus = useCallback((active: boolean) => setIsProdActive(active), []);

  return (
    <div className={styles.container} style={{ perspective: '1000px' }}>
      <style>{`
        @keyframes flipPaper { 0% { transform: rotateY(0deg); opacity: 1; } 50% { transform: rotateY(90deg); opacity: 0.5; } 100% { transform: rotateY(0deg); opacity: 1; } }
        .flip-active { animation: flipPaper 0.6s ease-in-out; }
        @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.05); } 100% { transform: scale(1); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {!operator ? (
        <div style={{ animation: 'fadeIn 0.5s' }}>
          <h1 className={styles.header} style={{ width: '95%', maxWidth: '500px', margin: '0 auto 30px auto', background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', borderRadius: '15px', padding: '20px', color: '#ffffff', textAlign: 'center' }}>ระบบบันทึกข้อมูลการผลิต & CIP</h1>
          <Login onLogin={handleLogin} />
        </div>
      ) : (
        <div className={isFlipping ? 'flip-active' : ''}>
          {appMode === 'selection' && (
            <div style={{ animation: 'fadeIn 0.5s' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '40px' }}>
                <div style={{ width: '80px', height: '80px', backgroundColor: '#fff', borderRadius: '50%', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '2.5rem', boxShadow: '0 10px 25px rgba(0,0,0,0.1)', marginBottom: '15px', border: '3px solid #ff6b00' }}>👤</div>
                <h2 style={{ margin: '0 0 5px 0' }}>ยินดีต้อนรับ</h2>
                <div style={{ color: '#ff6b00', fontSize: '1.3rem', fontWeight: 'bold', marginBottom: '15px' }}>คุณ {operator}</div>
                {(() => {
                  const hour = new Date().getHours();
                  let s = "🌙 กะดึก", c = "#303f9f";
                  if (hour >= 6 && hour < 14) { s = "☀️ กะเช้า"; c = "#fbc02d"; }
                  else if (hour >= 14 && hour < 22) { s = "⛅ กะบ่าย"; c = "#f57c00"; }
                  return <div style={{ background: c, color: 'white', padding: '8px 20px', borderRadius: '50px', fontWeight: 'bold' }}>{s}</div>;
                })()}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', padding: '0 10px' }}>
                <div onClick={() => switchMode('cipLine2')} style={{ background: 'linear-gradient(135deg, #ff6b00, #ff9800)', padding: '25px 10px', borderRadius: '25px', color: 'white', textAlign: 'center', cursor: 'pointer', position: 'relative' }}>
                  <div style={{ fontSize: '2rem' }}>📋</div>
                  <div style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>บันทึก CIP</div>
                  <div style={{ fontSize: '0.7rem', opacity: 0.85, marginTop: '3px' }}>Line 2&3</div>
                </div>
                <div onClick={() => switchMode('cipLine1')} style={{ background: 'linear-gradient(135deg, #1565c0, #1976d2)', padding: '25px 10px', borderRadius: '25px', color: 'white', textAlign: 'center', cursor: 'pointer', position: 'relative' }}>
                  <div style={{ fontSize: '2rem' }}>📋</div>
                  <div style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>CIP Line 1</div>
                  <div style={{ fontSize: '0.7rem', opacity: 0.85, marginTop: '3px' }}>Syrup</div>
                </div>
                <div onClick={() => switchMode('cip')} style={{ background: 'linear-gradient(135deg, #6a1b9a, #8e24aa)', padding: '25px 10px', borderRadius: '25px', color: 'white', textAlign: 'center', cursor: 'pointer', position: 'relative' }}>
                  {isCipActive && <div style={{ position: 'absolute', top: '5px', right: '5px', background: '#ff3b30', color: 'white', fontSize: '0.6rem', padding: '4px 8px', borderRadius: '10px', animation: 'pulse 1.5s infinite' }}>🔴 กำลังทำงาน</div>}
                  <div style={{ fontSize: '2rem' }}>🧼</div>
                  <div style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>CIP ทดลอง</div>
                  <div style={{ fontSize: '0.7rem', opacity: 0.85, marginTop: '3px' }}>Line 2 (ใหม่)</div>
                </div>
                <div onClick={() => switchMode('production')} style={{ background: 'linear-gradient(135deg, #2e7d32, #4caf50)', padding: '25px 10px', borderRadius: '25px', color: 'white', textAlign: 'center', cursor: 'pointer', position: 'relative' }}>
                  {isProdActive && <div style={{ position: 'absolute', top: '5px', right: '5px', background: '#ff3b30', color: 'white', fontSize: '0.6rem', padding: '4px 8px', borderRadius: '10px', animation: 'pulse 1.5s infinite' }}>🔴 กำลังทำงาน</div>}
                  <div style={{ fontSize: '2rem' }}>🏭</div>
                  <div style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>บันทึกการผลิต</div>
                </div>
              </div>
              <div style={{ textAlign: 'center', marginTop: '50px' }}><button onClick={handleLogout} style={{ background: 'none', border: 'none', color: '#888', textDecoration: 'underline', cursor: 'pointer' }}>ออกจากระบบ</button></div>
            </div>
          )}

          <div style={{ display: appMode === 'cip' ? 'block' : 'none' }}>
            <Logbook operatorName={operator} onLogout={() => switchMode('production')} onBackToMain={() => switchMode('selection')} onHome={handleLogout} onStatusChange={handleCipStatus} />
          </div>

          <div style={{ display: appMode === 'cipLine2' ? 'block' : 'none' }}>
            <CipLine2Form operatorName={operator} onBackToMain={() => switchMode('selection')} onStatusChange={handleCipStatus} />
          </div>

          <div style={{ display: appMode === 'cipLine1' ? 'block' : 'none' }}>
            <CipLine1Form operatorName={operator} onBackToMain={() => switchMode('selection')} onStatusChange={handleCipStatus} />
          </div>

          <div style={{ display: appMode === 'production' ? 'block' : 'none' }}>
            <ProductionRecord operatorName={operator} onBack={() => switchMode('cip')} onBackToMain={() => switchMode('selection')} onHome={handleLogout} onStatusChange={handleProdStatus} />
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
