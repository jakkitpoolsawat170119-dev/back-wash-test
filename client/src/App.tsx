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
  };

  return (
    <div className={styles.container}>
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
          {appMode === 'selection' && (
            <div style={{ animation: 'fadeIn 0.5s ease-out' }}>
              {/* --- Header Section --- */}
              <div style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center', 
                marginBottom: '40px',
                textAlign: 'center'
              }}>
                <div style={{ 
                  width: '80px', 
                  height: '80px', 
                  backgroundColor: '#fff', 
                  borderRadius: '50%', 
                  display: 'flex', 
                  justifyContent: 'center', 
                  alignItems: 'center',
                  fontSize: '2.5rem',
                  boxShadow: '0 10px 25px rgba(255, 107, 0, 0.2)',
                  marginBottom: '15px',
                  border: '3px solid #ff6b00'
                }}>
                  👤
                </div>
                <h2 style={{ margin: '0 0 5px 0', fontSize: '1.8rem', color: '#333' }}>ยินดีต้อนรับ</h2>
                <div style={{ color: '#ff6b00', fontSize: '1.3rem', fontWeight: '800', marginBottom: '15px' }}>
                  คุณ {operator}
                </div>

                {/* Badge แสดงกะแบบใหม่ */}
                {(() => {
                  const hour = new Date().getHours();
                  let shiftText = "";
                  let shiftColor = "";
                  let icon = "";
                  
                  if (hour >= 6 && hour < 14) {
                    shiftText = "กะเช้า (06:00 - 14:00)";
                    shiftColor = "#fbc02d";
                    icon = "☀️";
                  } else if (hour >= 14 && hour < 22) {
                    shiftText = "กะบ่าย (14:00 - 22:00)";
                    shiftColor = "#f57c00";
                    icon = "⛅";
                  } else {
                    shiftText = "กะดึก (22:00 - 06:00)";
                    shiftColor = "#303f9f";
                    icon = "🌙";
                  }

                  return (
                    <div style={{ 
                      background: shiftColor, 
                      color: 'white', 
                      padding: '8px 20px', 
                      borderRadius: '50px',
                      fontSize: '0.9rem',
                      fontWeight: 'bold',
                      boxShadow: '0 4px 10px rgba(0,0,0,0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}>
                      {icon} {shiftText}
                    </div>
                  );
                })()}
              </div>

              <p style={{ textAlign: 'center', color: '#666', marginBottom: '25px', fontSize: '1rem' }}>เลือกรายการที่ต้องการดำเนินการ:</p>
              
              {/* --- Dashboard Tiles --- */}
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', 
                gap: '20px',
                padding: '0 10px'
              }}>
                {/* Tile 1: CIP */}
                <div 
                  onClick={() => setAppMode('cip')}
                  style={{ 
                    background: 'linear-gradient(135deg, #ff6b00, #ff9800)',
                    padding: '30px 20px',
                    borderRadius: '25px',
                    color: 'white',
                    textAlign: 'center',
                    cursor: 'pointer',
                    boxShadow: '0 15px 30px rgba(255, 107, 0, 0.2)',
                    transition: 'transform 0.2s, box-shadow 0.2s',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '15px'
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-5px)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
                >
                  <div style={{ fontSize: '3rem' }}>🧼</div>
                  <div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>บันทึก CIP</div>
                    <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>ขั้นตอนการล้างถัง</div>
                  </div>
                </div>
                
                {/* Tile 2: Production */}
                <div 
                  onClick={() => setAppMode('production')}
                  style={{ 
                    background: 'linear-gradient(135deg, #2e7d32, #4caf50)',
                    padding: '30px 20px',
                    borderRadius: '25px',
                    color: 'white',
                    textAlign: 'center',
                    cursor: 'pointer',
                    boxShadow: '0 15px 30px rgba(46, 125, 50, 0.2)',
                    transition: 'transform 0.2s, box-shadow 0.2s',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '15px'
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-5px)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
                >
                  <div style={{ fontSize: '3rem' }}>🏭</div>
                  <div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>บันทึกการผลิต</div>
                    <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>คุมยอด Batch & Lab</div>
                  </div>
                </div>
              </div>

              {/* --- Footer Logout --- */}
              <div style={{ textAlign: 'center', marginTop: '50px' }}>
                <button 
                  onClick={handleLogout}
                  style={{ 
                    background: 'rgba(0,0,0,0.05)', 
                    border: 'none', 
                    color: '#888', 
                    padding: '10px 25px', 
                    borderRadius: '15px',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    fontWeight: 'bold',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                >
                  🚪 ออกจากระบบ
                </button>
              </div>
            </div>
          )}

          {appMode === 'cip' && (
            <Logbook 
              operatorName={operator} 
              onLogout={() => setAppMode('selection')} 
              onViewHistory={() => setView('history')}
              onHome={handleLogout}
            />
          )}

          {appMode === 'production' && (
            <ProductionRecord 
              operatorName={operator} 
              onBack={() => setAppMode('selection')} 
              onHome={handleLogout}
            />
          )}
        </>
      )}
    </div>
  );

};

export default App;