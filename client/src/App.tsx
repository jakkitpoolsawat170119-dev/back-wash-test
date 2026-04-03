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
          <h1 className={styles.header}>ระบบบันทึก CIP - ส้ม ไลน์ 2</h1>
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