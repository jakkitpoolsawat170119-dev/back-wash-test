import React, { useState, useEffect } from 'react';
import Login from './components/Login';
import Splash from './components/Splash';
import ProductionRecord from './components/ProductionRecord';
import StickerGuideChat from './components/StickerGuideChat';
import ErrorBoundary from './components/ErrorBoundary';
import TopBar, { type AppView } from './components/TopBar';
import Home from './components/Home';
import CipHub from './components/CipHub';
import AdminShell from './components/AdminShell';
import styles from './App.module.css';

const App: React.FC = () => {
  const [operator, setOperator] = useState<string | null>(null);
  const [view, setView] = useState<AppView>('home');
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('darkMode') === '1');
  const [showSplash, setShowSplash] = useState(true);
  const [splashFadeOut, setSplashFadeOut] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('operator');
    if (saved) setOperator(saved);
    const fadeTimer = setTimeout(() => setSplashFadeOut(true), 1000);
    const removeTimer = setTimeout(() => setShowSplash(false), 1450);
    return () => { clearTimeout(fadeTimer); clearTimeout(removeTimer); };
  }, []);

  useEffect(() => { localStorage.setItem('darkMode', darkMode ? '1' : '0'); }, [darkMode]);

  const handleLogin = (name: string) => {
    localStorage.setItem('operator', name);
    setOperator(name);
    setView('home');
  };

  const toggleDark = () => setDarkMode(d => !d);
  const goHome = () => setView('home');

  return (
    <div className={darkMode ? 'app-dark-mode' : undefined}>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .app-dark-mode { filter: invert(1) hue-rotate(180deg); background: #ffffff; }
        .app-dark-mode img, .app-dark-mode video, .app-dark-mode svg, .app-dark-mode iframe {
          filter: invert(1) hue-rotate(180deg);
        }
      `}</style>

      {showSplash && <Splash fadeOut={splashFadeOut} />}

      {!operator ? (
        <div className={styles.container} style={{ animation: 'fadeIn 0.5s' }}>
          <h1 className={styles.header} style={{ width: '95%', maxWidth: '500px', margin: '0 auto 30px auto', background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', borderRadius: '15px', padding: '20px', color: '#ffffff', textAlign: 'center' }}>ระบบบันทึกข้อมูลการผลิต & CIP</h1>
          <Login onLogin={handleLogin} />
        </div>
      ) : view === 'admin' ? (
        <AdminShell operator={operator} onExit={goHome} onNavOut={(v) => setView(v)} darkMode={darkMode} onToggleDark={toggleDark} />
      ) : (
        <div className={`rd-shell${view === 'home' ? ' rd-home' : ''}`}>
          <TopBar active={view} onNav={setView} operator={operator} darkMode={darkMode} onToggleDark={toggleDark} />

          {view === 'home' && <Home onNav={setView} />}

          {view === 'production' && (
            <div className="rd-legacy">
              <ErrorBoundary label="production">
                <ProductionRecord operatorName={operator} onBack={goHome} onBackToMain={goHome} onHome={goHome} onStatusChange={() => {}} />
              </ErrorBoundary>
            </div>
          )}

          {view === 'cip' && (
            <ErrorBoundary label="cip-hub">
              <CipHub operatorName={operator} onBackToMain={goHome} />
            </ErrorBoundary>
          )}

          {view === 'stickerchat' && (
            <div className="rd-legacy">
              <ErrorBoundary label="stickerGuideChat">
                <StickerGuideChat onBackToMain={goHome} darkMode={darkMode} />
              </ErrorBoundary>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default App;
