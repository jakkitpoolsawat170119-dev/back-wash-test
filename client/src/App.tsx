import React, { useState, useEffect, useCallback } from 'react';
import Login from './components/Login';
import Logbook from './components/Logbook';
import ProductionRecord from './components/ProductionRecord';
import styles from './App.module.css';

const App: React.FC = () => {
  const [operator, setOperator] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<'selection' | 'cip' | 'production'>('selection');
  const [isFlipping, setIsFlipping] = useState(false);
  
  const [isCipActive, setIsCipActive] = useState(false);
  const [isProdActive, setIsProdActive] = useState(false);

  useEffect(() => {
    const savedOperator = localStorage.getItem('operator');
    if (savedOperator) setOperator(savedOperator);
  }, []);

  const handleLogin = (name: string) => {
    localStorage.setItem('operator', name);
    setOperator(name);
    setAppMode('selection');
  };

  const handleLogout = () => {
    if (window.confirm("ออกจากระบบ? ข้อมูลที่ยังไม่ได้บันทึกจะหายไป")) {
      localStorage.removeItem('operator');
      setOperator(null);
      setAppMode('selection');
      setIsCipActive(false);
      setIsProdActive(false);
    }
  };

  // ใช้ useCallback เพื่อป้องกัน Infinite Loop
  const handleCipStatus = useCallback((active: boolean) => {
    setIsCipActive(active);
  }, []);

  const handleProdStatus = useCallback((active: boolean) => {
    setIsProdActive(active);
  }, []);

  const switchMode = (targetMode: 'cip' | 'production' | 'selection') => {
    setIsFlipping(true);
    setTimeout(() => {
      setAppMode(targetMode);
      setTimeout(() => setIsFlipping(false), 300);
    }, 300);
  };

  return (
    <div className={styles.container} style={{ perspective: '1000px', overflowX: 'hidden' }}>
      <style>{`
        @keyframes flipPaper { 0% { transform: rotateY(0deg); opacity: 1; } 50% { transform: rotateY(90deg); opacity: 0.5; scale: 0.9; } 100% { transform: rotateY(0deg); opacity: 1; } }
        .flip-active { animation: flipPaper 0.6s ease-in-out; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.1); opacity: 0.8; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {!operator ? (
        <div style={{ animation: 'fadeIn 0.5s ease-out' }}>
          <h1 className={styles.header} style={{
            width: '95%', maxWidth: '500px', margin: '0 auto 30px auto',
            background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', borderRadius: '15px',
            padding: '20px', color: '#ffffff', textAlign: 'center', boxShadow: '0 6px 15px rgba(255, 107, 0, 0.3)',
          }}>
            ระบบบันทึกข้อมูลการผลิต & CIP
          </h1>
          <Login onLogin={handleLogin} />
        </div>
      ) : (
        <div className={isFlipping ? 'flip-active' : ''}>
          {/* Dashboard Selection */}
          <div style={{ display: appMode === 'selection' ? 'block' : 'none', animation: 'fadeIn 0.5s ease-out' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '40px', textAlign: 'center' }}>
                <div style={{ width: '80px', height: '80px', backgroundColor: '#fff', borderRadius: '50%', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '2.5rem', boxShadow: '0 10px 25px rgba(255, 107, 0, 0.2)', marginBottom: '15px', border: '3px solid #ff6b00' }}>👤</div>
                <h2 style={{ margin: '0 0 5px 0', fontSize: '1.8rem', color: '#333' }}>ยินดีต้อนรับ</h2>
                <div style={{ color: '#ff6b00', fontSize: '1.3rem', fontWeight: '800', marginBottom: '15px' }}>คุณ {operator}</div>
                {(() => {
                  const hour = new Date().getHours();
                  let s = "🌙 กะดึก", c = "#303f9f";
                  if (hour >= 6 && hour < 14) { s = "☀️ กะเช้า"; c = "#fbc02d"; }
                  else if (hour >= 14 && hour < 22) { s = "⛅ กะบ่าย"; c = "#f57c00"; }
                  return <div style={{ background: c, color: 'white', padding: '8px 20px', borderRadius: '50px', fontSize: '0.9rem', fontWeight: 'bold' }}>{s}</div>;
                })()}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '20px', padding: '0 10px' }}>
                <div onClick={() => switchMode('cip')} style={{ background: 'linear-gradient(135deg, #ff6b00, #ff9800)', padding: '30px 20px', borderRadius: '25px', color: 'white', textAlign: 'center', cursor: 'pointer', boxShadow: '0 15px 30px rgba(255, 107, 0, 0.2)', position: 'relative', border: isCipActive ? '4px solid #fff' : 'none' }}>
                  {isCipActive && <div style={{ position: 'absolute', top: '10px', right: '10px', background: '#ff3b30', color: 'white', fontSize: '0.6rem', padding: '4px 8px', borderRadius: '10px', fontWeight: 'bold', animation: 'pulse 1.5s infinite' }}>🔴 กำลังทำงาน</div>}
                  <div style={{ fontSize: '3rem' }}>🧼</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>บันทึก CIP</div>
                </div>
                <div onClick={() => switchMode('production')} style={{ background: 'linear-gradient(135deg, #2e7d32, #4caf50)', padding: '30px 20px', borderRadius: '25px', color: 'white', textAlign: 'center', cursor: 'pointer', boxShadow: '0 15px 30px rgba(46, 125, 50, 0.2)', position: 'relative', border: isProdActive ? '4px solid #fff' : 'none' }}>
                  {isProdActive && <div style={{ position: 'absolute', top: '10px', right: '10px', background: '#ff3b30', color: 'white', fontSize: '0.6rem', padding: '4px 8px', borderRadius: '10px', fontWeight: 'bold', animation: 'pulse 1.5s infinite' }}>🔴 กำลังทำงาน</div>}
                  <div style={{ fontSize: '3rem' }}>🏭</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>บันทึกการผลิต</div>
                </div>
              </div>

              <div style={{ textAlign: 'center', marginTop: '50px' }}>
                <button onClick={handleLogout} style={{ background: 'rgba(0,0,0,0.05)', border: 'none', color: '#888', padding: '10px 25px', borderRadius: '15px', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 'bold' }}>🚪 ออกจากระบบ</button>
              </div>
          </div>

          <div style={{ display: appMode === 'cip' ? 'block' : 'none' }}>
            <Logbook 
              operatorName={operator} 
              onLogout={() => switchMode('production')} 
              onBackToMain={() => switchMode('selection')}
              onHome={handleLogout} 
              onStatusChange={handleCipStatus} 
            />
          </div>

          <div style={{ display: appMode === 'production' ? 'block' : 'none' }}>
            <ProductionRecord 
              operatorName={operator} 
              onBack={() => switchMode('cip')} 
              onBackToMain={() => switchMode('selection')}
              onHome={handleLogout} 
              onStatusChange={handleProdStatus} 
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
