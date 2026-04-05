import React, { useState, useEffect } from 'react';
import Login from './components/Login';
import Logbook from './components/Logbook';
import History from './components/History';
import styles from './App.module.css';

const App: React.FC = () => {
  const [operator, setOperator] = useState<string | null>(null);
  const [view, setView] = useState<'main' | 'history'>('main');

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
  };

  const handleLogout = () => {
    localStorage.removeItem('operator');
    setOperator(null);
  };

  return (
    <div className={styles.container}>
      {!operator ? (
        <>
          <h1 className={styles.header} style={{
            width: '95%',
            maxWidth: '500px',
            margin: '0 auto 30px auto',
            backgroundColor: '#fff9f5',
            border: '4px solid #ff6b00',
            borderRadius: '15px',
            padding: '20px',
            color: '#e65100',
            textAlign: 'center',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            marginBottom: '30px',
          }}>
            ระบบบันทึก CIP
          </h1>
          {view === 'main' ? (
            <>
              <Login onLogin={handleLogin} />
              <div style={{ textAlign: 'center' }}>
                <button className={styles.historyBtn} onClick={() => setView('history')}>
                  📜 ดูประวัติการบันทึก (History)
                </button>
              </div>
            </>
          ) : (
            <History onBack={() => setView('main')} />
          )}
        </>
      ) : (
        <Logbook operatorName={operator} onLogout={handleLogout} />
      )}
    </div>
  );
};

export default App;