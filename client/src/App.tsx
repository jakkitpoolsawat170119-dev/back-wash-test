import React, { useState, useEffect } from 'react';
import Login from './components/Login';
import Logbook from './components/Logbook';
import History from './components/History';
import ProductionRecord from './components/ProductionRecord';
import styles from './App.module.css';

const App: React.FC = () => {
  const [operator, setOperator] = useState<string | null>(null);
  const [view, setView] = useState<'main' | 'history'>('main');
  const [appMode, setAppMode] = useState<'selection' | 'cip' | 'production'>('selection');
  
  // สถานะเพื่อเช็คว่าแต่ละระบบมีงานค้างอยู่ไหม
  const [isCipActive, setIsCipActive] = useState(false);
  const [isProdActive, setIsProdActive] = useState(false);

  // Check if user is already logged in on load
  useEffect(() => {
    const savedOperator = localStorage.getItem('operator');
    if (savedOperator) {
      setOperator(savedOperator);
    }
  }, []);

  const handleLogin = (name: string) => {
    localStorage.setItem('operator', name);
    setOperator(name);
    setAppMode('selection');
  };

  const handleLogout = () => {
    localStorage.removeItem('operator');
    setOperator(null);
    setAppMode('selection');
    setView('main');
    setIsCipActive(false);
    setIsProdActive(false);
  };

  return (
    <div className={styles.container}>
      {/* Animation Styles */}
      <style>{`
        @keyframes pulse {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.1); opacity: 0.8; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {view === 'history' ? (
        <History onBack={() => setView('main')} />
      ) : !operator ? (
        <>
          <h1 className={styles.header} style={{
            width: '95%',
            maxWidth: '500px',
            margin: '0 auto 30px auto',
            background: 'linear-gradient(135deg, #ff6b00, #ff8c00)',
            border: 'none',
            borderRadius: '15px',
            padding: '20px',
            color: '#ffffff',
            textAlign: 'center',
            boxShadow: '0 6px 15px rgba(255, 107, 0, 0.3)',
            marginBottom: '30px',
          }}>
            ระบบบันทึกข้อมูลการผลิต & CIP
          </h1>
          <Login onLogin={handleLogin} />
        </>
      ) : (
        <>
          {/* --- หน้า Dashboard Selection --- */}
          <div style={{ display: appMode === 'selection' ? 'block' : 'none', animation: 'fadeIn 0.5s ease-out' }}>
              <div style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center', 
                marginBottom: '40px',
                textAlign: 'center'
              }}>
                <div style={{ 
                  width: '80px', height: '80px', backgroundColor: '#fff', borderRadius: '50%', 
                  display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '2.5rem',
                  boxShadow: '0 10px 25px rgba(255, 107, 0, 0.2)', marginBottom: '15px', border: '3px solid #ff6b00'
                }}>👤</div>
                <h2 style={{ margin: '0 0 5px 0', fontSize: '1.8rem', color: '#333' }}>ยินดีต้อนรับ</h2>
                <div style={{ color: '#ff6b00', fontSize: '1.3rem', fontWeight: '800', marginBottom: '15px' }}>คุณ {operator}</div>

                {(() => {
                  const hour = new Date().getHours();
                  let shiftText = ""; let shiftColor = ""; let icon = "";
                  if (hour >= 6 && hour < 14) { shiftText = "กะเช้า (06:00 - 14:00)"; shiftColor = "#fbc02d"; icon = "☀️"; }
                  else if (hour >= 14 && hour < 22) { shiftText = "กะบ่าย (14:00 - 22:00)"; shiftColor = "#f57c00"; icon = "⛅"; }
                  else { shiftText = "กะดึก (22:00 - 06:00)"; shiftColor = "#303f9f"; icon = "🌙"; }
                  return (
                    <div style={{ background: shiftColor, color: 'white', padding: '8px 20px', borderRadius: '50px', fontSize: '0.9rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {icon} {shiftText}
                    </div>
                  );
                })()}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '20px', padding: '0 10px' }}>
                {/* Tile 1: CIP */}
                <div 
                  onClick={() => setAppMode('cip')}
                  style={{ 
                    background: 'linear-gradient(135deg, #ff6b00, #ff9800)', padding: '30px 20px', borderRadius: '25px', color: 'white', textAlign: 'center', cursor: 'pointer',
                    boxShadow: '0 15px 30px rgba(255, 107, 0, 0.2)', transition: 'transform 0.2s', position: 'relative', border: isCipActive ? '4px solid #fff' : 'none'
                  }}
                >
                  {isCipActive && <div style={{ position: 'absolute', top: '10px', right: '10px', background: '#ff3b30', color: 'white', fontSize: '0.6rem', padding: '4px 8px', borderRadius: '10px', fontWeight: 'bold', animation: 'pulse 1.5s infinite' }}>🔴 กำลังทำงาน</div>}
                  <div style={{ fontSize: '3rem' }}>🧼</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>บันทึก CIP</div>
                </div>
                
                {/* Tile 2: Production */}
                <div 
                  onClick={() => setAppMode('production')}
                  style={{ 
                    background: 'linear-gradient(135deg, #2e7d32, #4caf50)', padding: '30px 20px', borderRadius: '25px', color: 'white', textAlign: 'center', cursor: 'pointer',
                    boxShadow: '0 15px 30px rgba(46, 125, 50, 0.2)', transition: 'transform 0.2s', position: 'relative', border: isProdActive ? '4px solid #fff' : 'none'
                  }}
                >
                  {isProdActive && <div style={{ position: 'absolute', top: '10px', right: '10px', background: '#ff3b30', color: 'white', fontSize: '0.6rem', padding: '4px 8px', borderRadius: '10px', fontWeight: 'bold', animation: 'pulse 1.5s infinite' }}>🔴 กำลังทำงาน</div>}
                  <div style={{ fontSize: '3rem' }}>🏭</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>บันทึกการผลิต</div>
                </div>
              </div>

              <div style={{ textAlign: 'center', marginTop: '50px' }}>
                <button onClick={handleLogout} style={{ background: 'rgba(0,0,0,0.05)', border: 'none', color: '#888', padding: '10px 25px', borderRadius: '15px', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 'bold' }}>🚪 ออกจากระบบ</button>
              </div>
          </div>

          {/* --- หน้าบันทึก CIP (Mounted Background) --- */}
          <div style={{ display: appMode === 'cip' ? 'block' : 'none' }}>
            <Logbook 
              operatorName={operator} 
              onLogout={() => setAppMode('selection')} 
              onViewHistory={() => setView('history')}
              onHome={handleLogout}
              onStatusChange={(active) => setIsCipActive(active)}
            />
          </div>

          {/* --- หน้าบันทึกการผลิต (Mounted Background) --- */}
          <div style={{ display: appMode === 'production' ? 'block' : 'none' }}>
            <ProductionRecord 
              operatorName={operator} 
              onBack={() => setAppMode('selection')} 
              onHome={handleLogout}
              onStatusChange={(active) => setIsProdActive(active)}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default App;
