import React, { useState, useEffect, useCallback } from 'react';
import Login from './components/Login';
import Logbook from './components/Logbook';
import CipLine2Form from './components/CipLine2Form';
import CipLine1Form from './components/CipLine1Form';
import ProductionRecord from './components/ProductionRecord';
import styles from './App.module.css';

const App: React.FC = () => {
  const [operator, setOperator] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<'selection' | 'cip' | 'cipLine2' | 'cipLine3' | 'cipLine1' | 'production'>('selection');
  const [isFlipping, setIsFlipping] = useState(false);
  const [isCipLine2Active, setIsCipLine2Active] = useState(false);
  const [isCipLine3Active, setIsCipLine3Active] = useState(false);
  const [isCipLine1Active, setIsCipLine1Active] = useState(false);
  const [isCipLabActive, setIsCipLabActive] = useState(false);
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
      setIsCipLine2Active(false);
      setIsCipLine3Active(false);
      setIsCipLine1Active(false);
      setIsCipLabActive(false);
      setIsProdActive(false);
    }
  };

  const switchMode = (targetMode: 'cip' | 'cipLine2' | 'cipLine3' | 'cipLine1' | 'production' | 'selection') => {
    setIsFlipping(true);
    setTimeout(() => {
      setAppMode(targetMode);
      setTimeout(() => setIsFlipping(false), 300);
    }, 300);
  };

  const handleCipLine2Status = useCallback((active: boolean) => setIsCipLine2Active(active), []);
  const handleCipLine3Status = useCallback((active: boolean) => setIsCipLine3Active(active), []);
  const handleCipLine1Status = useCallback((active: boolean) => setIsCipLine1Active(active), []);
  const handleCipLabStatus = useCallback((active: boolean) => setIsCipLabActive(active), []);
  const handleProdStatus = useCallback((active: boolean) => setIsProdActive(active), []);

  return (
    <div className={styles.container}>
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
        <>
        {appMode !== 'selection' && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200,
            background: 'white', borderBottom: '2px solid #eee',
            padding: '8px 10px',
            display: 'flex', gap: '6px', overflowX: 'auto',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
            WebkitOverflowScrolling: 'touch' as any,
          }}>
            {([
              { mode: 'selection', icon: '🏠', label: 'หน้าหลัก', color: '#37474f' },
              { mode: 'cipLine1', icon: '💧', label: 'Line 1', color: '#0d47a1' },
              { mode: 'cipLine2', icon: '💧', label: 'Line 2', color: '#01579b' },
              { mode: 'cipLine3', icon: '💧', label: 'Line 3', color: '#006064' },
              { mode: 'cip',      icon: '🔬', label: 'CIP ทดลอง', color: '#546e7a' },
              { mode: 'production', icon: '🏭', label: 'ผลิต', color: '#1b5e20' },
            ] as { mode: 'selection'|'cip'|'cipLine2'|'cipLine3'|'cipLine1'|'production'; icon: string; label: string; color: string }[]).map(({ mode, icon, label, color }) => (
              <button
                key={mode}
                onClick={() => switchMode(mode)}
                style={{
                  flex: '0 0 auto', padding: '7px 13px', borderRadius: '20px', border: '2px solid',
                  borderColor: appMode === mode ? color : '#e0e0e0',
                  background: appMode === mode ? color : '#f5f5f5',
                  color: appMode === mode ? 'white' : '#666',
                  fontWeight: 'bold', fontSize: '0.75rem', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {icon} {label}
              </button>
            ))}
          </div>
        )}
        <div className={isFlipping ? 'flip-active' : ''} style={{ paddingTop: appMode !== 'selection' ? '58px' : '0' }}>
          {appMode === 'selection' && (
            <div style={{ animation: 'fadeIn 0.5s' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '32px' }}>
                <div style={{ width: '72px', height: '72px', backgroundColor: '#fff', borderRadius: '50%', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '2.2rem', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginBottom: '12px', border: '2px solid #e0e0e0' }}>👤</div>
                <h2 style={{ margin: '0 0 4px 0', fontSize: '1rem', color: '#333' }}>ยินดีต้อนรับ, คุณ {operator}</h2>
                {(() => {
                  const hour = new Date().getHours();
                  let s = "🌙 กะดึก", c = "#455a64";
                  if (hour >= 6 && hour < 14) { s = "☀️ กะเช้า"; c = "#e65100"; }
                  else if (hour >= 14 && hour < 22) { s = "⛅ กะบ่าย"; c = "#1565c0"; }
                  return <div style={{ background: c, color: 'white', padding: '6px 18px', borderRadius: '50px', fontWeight: '600', fontSize: '0.85rem' }}>{s}</div>;
                })()}
              </div>

              {/* บันทึกการผลิต */}
              <div style={{ padding: '0 14px', marginBottom: '10px' }}>
                <div onClick={() => switchMode('production')} style={{ background: '#1b5e20', borderRadius: '18px', padding: '18px 16px', color: 'white', cursor: 'pointer', position: 'relative', display: 'flex', alignItems: 'center', gap: '14px', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
                  {isProdActive && <div style={{ position: 'absolute', top: '8px', right: '10px', background: '#ff3b30', color: 'white', fontSize: '0.6rem', padding: '3px 8px', borderRadius: '8px', animation: 'pulse 1.5s infinite' }}>● กำลังทำงาน</div>}
                  <div style={{ fontSize: '2.2rem', lineHeight: 1 }}>🏭</div>
                  <div>
                    <div style={{ fontWeight: '700', fontSize: '1rem', letterSpacing: '0.02em' }}>บันทึกการผลิต</div>
                    <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: '2px' }}>Production Control</div>
                  </div>
                </div>
              </div>

              {/* CIP Lines — น้ำ = ล้าง = น้ำเงิน */}
              <div style={{ padding: '0 14px', marginBottom: '10px' }}>
                <div style={{ fontSize: '0.7rem', color: '#999', fontWeight: '600', letterSpacing: '0.08em', marginBottom: '6px', textTransform: 'uppercase' }}>CIP — ทำความสะอาด</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                  <div onClick={() => switchMode('cipLine1')} style={{ background: '#0d47a1', borderRadius: '16px', padding: '18px 6px', color: 'white', textAlign: 'center', cursor: 'pointer', position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}>
                    {isCipLine1Active && <div style={{ position: 'absolute', top: '6px', right: '6px', width: '8px', height: '8px', background: '#ff3b30', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />}
                    <div style={{ fontSize: '1.5rem', lineHeight: 1, marginBottom: '6px' }}>💧</div>
                    <div style={{ fontWeight: '700', fontSize: '0.8rem' }}>Line 1</div>
                    <div style={{ fontSize: '0.6rem', opacity: 0.7, marginTop: '2px' }}>Syrup</div>
                  </div>
                  <div onClick={() => switchMode('cipLine2')} style={{ background: '#01579b', borderRadius: '16px', padding: '18px 6px', color: 'white', textAlign: 'center', cursor: 'pointer', position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}>
                    {isCipLine2Active && <div style={{ position: 'absolute', top: '6px', right: '6px', width: '8px', height: '8px', background: '#ff3b30', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />}
                    <div style={{ fontSize: '1.5rem', lineHeight: 1, marginBottom: '6px' }}>💧</div>
                    <div style={{ fontWeight: '700', fontSize: '0.8rem' }}>Line 2</div>
                    <div style={{ fontSize: '0.6rem', opacity: 0.7, marginTop: '2px' }}>Flavour</div>
                  </div>
                  <div onClick={() => switchMode('cipLine3')} style={{ background: '#006064', borderRadius: '16px', padding: '18px 6px', color: 'white', textAlign: 'center', cursor: 'pointer', position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}>
                    {isCipLine3Active && <div style={{ position: 'absolute', top: '6px', right: '6px', width: '8px', height: '8px', background: '#ff3b30', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />}
                    <div style={{ fontSize: '1.5rem', lineHeight: 1, marginBottom: '6px' }}>💧</div>
                    <div style={{ fontWeight: '700', fontSize: '0.8rem' }}>Line 3</div>
                    <div style={{ fontSize: '0.6rem', opacity: 0.7, marginTop: '2px' }}>Flavour</div>
                  </div>
                </div>
              </div>

              {/* CIP ทดลอง */}
              <div style={{ padding: '0 14px' }}>
                <div onClick={() => switchMode('cip')} style={{ background: '#f5f5f5', border: '1.5px solid #e0e0e0', borderRadius: '14px', padding: '12px 16px', color: '#555', cursor: 'pointer', position: 'relative', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {isCipLabActive && <div style={{ position: 'absolute', top: '8px', right: '10px', width: '8px', height: '8px', background: '#ff3b30', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />}
                  <div style={{ fontSize: '1.3rem', lineHeight: 1 }}>🔬</div>
                  <div>
                    <div style={{ fontWeight: '600', fontSize: '0.85rem' }}>CIP ทดลอง</div>
                    <div style={{ fontSize: '0.65rem', color: '#999', marginTop: '1px' }}>Line 2 (ใหม่)</div>
                  </div>
                </div>
              </div>

              <div style={{ textAlign: 'center', marginTop: '50px' }}><button onClick={handleLogout} style={{ background: 'none', border: 'none', color: '#bbb', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.85rem' }}>ออกจากระบบ</button></div>
            </div>
          )}

          <div style={{ display: appMode === 'cip' ? 'block' : 'none' }}>
            <Logbook operatorName={operator} onLogout={() => switchMode('production')} onBackToMain={() => switchMode('selection')} onHome={handleLogout} onStatusChange={handleCipLabStatus} />
          </div>

          <div style={{ display: appMode === 'cipLine2' ? 'block' : 'none' }}>
            <CipLine2Form operatorName={operator} onBackToMain={() => switchMode('selection')} onStatusChange={handleCipLine2Status} defaultLine="Line 2" />
          </div>

          <div style={{ display: appMode === 'cipLine3' ? 'block' : 'none' }}>
            <CipLine2Form operatorName={operator} onBackToMain={() => switchMode('selection')} onStatusChange={handleCipLine3Status} defaultLine="Line 3" />
          </div>

          <div style={{ display: appMode === 'cipLine1' ? 'block' : 'none' }}>
            <CipLine1Form operatorName={operator} onBackToMain={() => switchMode('selection')} onStatusChange={handleCipLine1Status} />
          </div>

          <div style={{ display: appMode === 'production' ? 'block' : 'none' }}>
            <ProductionRecord operatorName={operator} onBack={() => switchMode('cip')} onBackToMain={() => switchMode('selection')} onHome={handleLogout} onStatusChange={handleProdStatus} />
          </div>
        </div>
        </>
      )}
    </div>
  );
};

export default App;
