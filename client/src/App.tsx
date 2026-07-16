import React, { useState, useEffect, useCallback } from 'react';
import Login from './components/Login';
import Splash from './components/Splash';
import Logbook from './components/Logbook';
import CipLine2Form from './components/CipLine2Form';
import CipLine1Form from './components/CipLine1Form';
import ProductionRecord from './components/ProductionRecord';
import Line4Manual from './components/Line4Manual';
import TodoBoard from './components/TodoBoard';
import StickerGuideChat from './components/StickerGuideChat';
import StickerGuideAdmin from './components/StickerGuideAdmin';
import styles from './App.module.css';

const App: React.FC = () => {
  const [operator, setOperator] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<'selection' | 'cip' | 'cipLine2' | 'cipLine3' | 'cipLine1' | 'production' | 'line4manual' | 'todo' | 'stickerGuideChat' | 'stickerGuideAdmin'>('selection');
  const [isFlipping, setIsFlipping] = useState(false);
  const [isCipLine2Active, setIsCipLine2Active] = useState(false);
  const [isCipLine3Active, setIsCipLine3Active] = useState(false);
  const [isCipLine1Active, setIsCipLine1Active] = useState(false);
  const [isCipLabActive, setIsCipLabActive] = useState(false);
  const [isProdActive, setIsProdActive] = useState(false);
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

  useEffect(() => {
    localStorage.setItem('darkMode', darkMode ? '1' : '0');
  }, [darkMode]);

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

  const switchMode = (targetMode: 'cip' | 'cipLine2' | 'cipLine3' | 'cipLine1' | 'production' | 'selection' | 'line4manual' | 'todo' | 'stickerGuideChat' | 'stickerGuideAdmin') => {
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

  const IconFactory = ({ size = 36, color = 'white' }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="22" width="36" height="16" rx="1.5"/>
      <path d="M2 22 L10 13 L10 22"/>
      <path d="M10 22 L20 13 L20 22"/>
      <path d="M20 22 L28 13 L28 22"/>
      <rect x="28" y="5" width="10" height="17" rx="1"/>
      <rect x="5" y="27" width="5" height="7"/>
      <rect x="14" y="27" width="5" height="7"/>
      <rect x="23" y="27" width="5" height="7"/>
      <line x1="30" y1="9" x2="36" y2="9"/>
    </svg>
  );
  const IconWater = ({ size = 34, color = 'white' }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 40 44" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 3 C20 3 4 18 4 28 C4 36 11.2 41 20 41 C28.8 41 36 36 36 28 C36 18 20 3 20 3Z"/>
      <path d="M12 31 C12 27 16 24 20 24" strokeOpacity="0.45"/>
    </svg>
  );
  const IconFlask = ({ size = 34, color = '#555' }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 40 44" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 5 L13 19 L3 34 C2 37 4 41 8 41 L32 41 C36 41 38 37 37 34 L27 19 L27 5"/>
      <line x1="9" y1="5" x2="31" y2="5" strokeWidth="2.2"/>
      <path d="M9 33 L24 33" strokeOpacity="0.35"/>
      <circle cx="28" cy="36" r="2" fill={color} stroke="none" opacity="0.4"/>
    </svg>
  );
  const IconChat = ({ size = 32, color = '#e65100' }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 9 C5 6.8 6.8 5 9 5 L31 5 C33.2 5 35 6.8 35 9 L35 23 C35 25.2 33.2 27 31 27 L15 27 L8 34 L8 27 L9 27 C6.8 27 5 25.2 5 23 Z"/>
      <line x1="13" y1="13" x2="27" y2="13" strokeOpacity="0.5"/>
      <line x1="13" y1="19" x2="23" y2="19" strokeOpacity="0.5"/>
    </svg>
  );
  const IconBook = ({ size = 32, color = '#4a7c59' }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 9 C17.5 6.5 13 5.5 6 6 L6 31 C13 30.5 17.5 31.5 20 34 C22.5 31.5 27 30.5 34 31 L34 6 C27 5.5 22.5 6.5 20 9 Z"/>
      <line x1="20" y1="9" x2="20" y2="34"/>
      <line x1="11" y1="13" x2="17" y2="12.4" strokeOpacity="0.5"/>
      <line x1="11" y1="19" x2="17" y2="18.6" strokeOpacity="0.5"/>
      <line x1="23" y1="12.4" x2="29" y2="13" strokeOpacity="0.5"/>
      <line x1="23" y1="18.6" x2="29" y2="19" strokeOpacity="0.5"/>
    </svg>
  );
  const IconWrench = ({ size = 22, color = '#e65100' }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M28 6 C24 6 21 9 21 13 C21 14.2 21.3 15.4 21.8 16.4 L8 30.2 C6.6 31.6 6.6 33.9 8 35.3 C9.4 36.7 11.7 36.7 13.1 35.3 L26.9 21.5 C27.9 22 29.1 22.3 30.3 22.3 C34.3 22.3 37.3 19.3 37.3 15.3 C37.3 14 37 12.8 36.4 11.7 L31.4 16.7 L27.6 12.9 L32.6 7.9 C31.2 6.7 29.6 6 28 6 Z"/>
    </svg>
  );

  const CategoryLabel = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: '0.72rem', color: '#9aa0a6', fontWeight: '700', letterSpacing: '0.1em', marginBottom: '8px', textTransform: 'uppercase', padding: '0 4px' }}>{children}</div>
  );

  const SoftCard = ({ onClick, bg, iconBg, icon, title, subtitle, badge }: {
    onClick: () => void; bg: string; iconBg: string; icon: React.ReactNode; title: string; subtitle: string; badge?: React.ReactNode;
  }) => (
    <div onClick={onClick} style={{
      background: bg, borderRadius: '18px', padding: '14px 16px', cursor: 'pointer', position: 'relative',
      display: 'flex', alignItems: 'center', gap: '14px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
      border: '1px solid rgba(0,0,0,0.04)',
    }}>
      {badge}
      <div style={{ width: '46px', height: '46px', flexShrink: 0, borderRadius: '14px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: '700', fontSize: '0.95rem', letterSpacing: '0.01em', color: '#37474f' }}>{title}</div>
        <div style={{ fontSize: '0.74rem', color: '#78828a', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>
      </div>
    </div>
  );

  return (
    <div className={`${styles.container}${darkMode ? ' app-dark-mode' : ''}`}>
      <style>{`
        @keyframes flipPaper { 0% { transform: rotateY(0deg); opacity: 1; } 50% { transform: rotateY(90deg); opacity: 0.5; } 100% { transform: rotateY(0deg); opacity: 1; } }
        .flip-active { animation: flipPaper 0.6s ease-in-out; }
        @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.05); } 100% { transform: scale(1); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .app-dark-mode { filter: invert(1) hue-rotate(180deg); background: #ffffff; }
        .app-dark-mode img, .app-dark-mode video, .app-dark-mode svg, .app-dark-mode iframe {
          filter: invert(1) hue-rotate(180deg);
        }
      `}</style>

      {showSplash && <Splash fadeOut={splashFadeOut} />}

      {(!operator || appMode === 'selection') && (
        <button
          onClick={() => setDarkMode(d => !d)}
          title={darkMode ? 'สลับเป็นหน้าจอสว่าง' : 'สลับเป็นหน้าจอมืด'}
          style={{
            position: 'fixed', top: '10px', left: '10px', zIndex: 500,
            width: '34px', height: '34px', borderRadius: '50%',
            border: '1px solid rgba(0,0,0,0.08)', background: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: '0.95rem', boxShadow: '0 2px 10px rgba(0,0,0,0.12)',
            filter: darkMode ? 'invert(1) hue-rotate(180deg)' : 'none',
          }}
        >
          {darkMode ? '☀️' : '🌙'}
        </button>
      )}

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
            display: 'flex', alignItems: 'center', gap: '8px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
          }}>
            <button
              onClick={() => setDarkMode(d => !d)}
              title={darkMode ? 'สลับเป็นหน้าจอสว่าง' : 'สลับเป็นหน้าจอมืด'}
              style={{
                flexShrink: 0, width: '30px', height: '30px', borderRadius: '50%',
                border: '1.5px solid #e0e0e0', background: '#f5f5f5',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', fontSize: '0.85rem',
                filter: darkMode ? 'invert(1) hue-rotate(180deg)' : 'none',
              }}
            >
              {darkMode ? '☀️' : '🌙'}
            </button>
            <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' as any }}>
            {([
              { mode: 'selection', icon: '🏠', label: 'หน้าหลัก', color: '#37474f' },
              { mode: 'cipLine1', icon: '💧', label: 'Line 1', color: '#0d47a1' },
              { mode: 'cipLine2', icon: '💧', label: 'Line 2', color: '#01579b' },
              { mode: 'cipLine3', icon: '💧', label: 'Line 3', color: '#006064' },
              { mode: 'cip',      icon: '⚗️', label: 'CIP ทดลอง', color: '#546e7a' },
              { mode: 'production', icon: '🏭', label: 'ผลิต', color: '#1b5e20' },
              { mode: 'todo', icon: '✅', label: 'To-do', color: '#ff6b00' },
              { mode: 'line4manual', icon: '📋', label: 'Line 4', color: '#4a7c59' },
              { mode: 'stickerGuideChat', icon: '💬', label: 'วิธีติดสติ๊กเกอร์', color: '#ff8c00' },
              { mode: 'stickerGuideAdmin', icon: '🛠️', label: 'จัดการคู่มือ', color: '#e65100' },
            ] as { mode: 'selection'|'cip'|'cipLine2'|'cipLine3'|'cipLine1'|'production'|'line4manual'|'todo'|'stickerGuideChat'|'stickerGuideAdmin'; icon: string; label: string; color: string }[]).map(({ mode, icon, label, color }) => (
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
          </div>
        )}
        <div className={isFlipping ? 'flip-active' : ''} style={{ paddingTop: appMode !== 'selection' ? '58px' : '0' }}>
          {appMode === 'selection' && (
            <div style={{ animation: 'fadeIn 0.5s', position: 'relative', minHeight: '100vh', overflow: 'hidden' }}>

              <svg viewBox="0 0 400 320" xmlns="http://www.w3.org/2000/svg"
                style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '110%', maxWidth: '600px', opacity: 0.055, pointerEvents: 'none', zIndex: 0 }}
                fill="none" stroke="#1a3a5c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="40" y="20" width="18" height="100"/>
                <rect x="36" y="16" width="26" height="8" rx="1"/>
                <rect x="80" y="50" width="14" height="70"/>
                <rect x="77" y="46" width="20" height="7" rx="1"/>
                <rect x="290" y="10" width="22" height="120"/>
                <rect x="286" y="6" width="30" height="9" rx="1"/>
                <rect x="330" y="40" width="16" height="90"/>
                <rect x="327" y="36" width="22" height="8" rx="1"/>
                <rect x="20" y="120" width="140" height="160"/>
                <line x1="20" y1="155" x2="160" y2="155"/>
                <rect x="30" y="165" width="22" height="18" rx="1"/>
                <rect x="62" y="165" width="22" height="18" rx="1"/>
                <rect x="94" y="165" width="22" height="18" rx="1"/>
                <rect x="126" y="165" width="22" height="18" rx="1"/>
                <rect x="30" y="195" width="22" height="18" rx="1"/>
                <rect x="62" y="195" width="22" height="18" rx="1"/>
                <rect x="94" y="195" width="22" height="18" rx="1"/>
                <rect x="126" y="195" width="22" height="18" rx="1"/>
                <rect x="30" y="225" width="22" height="18" rx="1"/>
                <rect x="62" y="225" width="22" height="18" rx="1"/>
                <rect x="94" y="225" width="22" height="18" rx="1"/>
                <rect x="126" y="225" width="22" height="18" rx="1"/>
                <rect x="72" y="252" width="36" height="28" rx="2"/>
                <rect x="160" y="80" width="80" height="200"/>
                <line x1="160" y1="120" x2="240" y2="120"/>
                <rect x="172" y="132" width="20" height="18" rx="1"/>
                <rect x="208" y="132" width="20" height="18" rx="1"/>
                <rect x="172" y="162" width="20" height="18" rx="1"/>
                <rect x="208" y="162" width="20" height="18" rx="1"/>
                <rect x="172" y="192" width="20" height="18" rx="1"/>
                <rect x="208" y="192" width="20" height="18" rx="1"/>
                <rect x="172" y="222" width="20" height="18" rx="1"/>
                <rect x="208" y="222" width="20" height="18" rx="1"/>
                <rect x="188" y="252" width="24" height="28" rx="2"/>
                <rect x="240" y="130" width="140" height="150"/>
                <line x1="240" y1="165" x2="380" y2="165"/>
                <rect x="250" y="175" width="22" height="18" rx="1"/>
                <rect x="282" y="175" width="22" height="18" rx="1"/>
                <rect x="314" y="175" width="22" height="18" rx="1"/>
                <rect x="346" y="175" width="22" height="18" rx="1"/>
                <rect x="250" y="205" width="22" height="18" rx="1"/>
                <rect x="282" y="205" width="22" height="18" rx="1"/>
                <rect x="314" y="205" width="22" height="18" rx="1"/>
                <rect x="346" y="205" width="22" height="18" rx="1"/>
                <rect x="250" y="235" width="22" height="18" rx="1"/>
                <rect x="282" y="235" width="22" height="18" rx="1"/>
                <rect x="314" y="235" width="22" height="18" rx="1"/>
                <rect x="346" y="235" width="22" height="18" rx="1"/>
                <rect x="292" y="255" width="36" height="25" rx="2"/>
                <line x1="0" y1="280" x2="400" y2="280" strokeWidth="3"/>
                <path d="M160 200 L130 200 L130 280" strokeWidth="4"/>
                <path d="M240 180 L270 180 L270 280" strokeWidth="4"/>
                <line x1="355" y1="130" x2="355" y2="60" strokeWidth="3"/>
                <line x1="320" y1="60" x2="380" y2="60" strokeWidth="3"/>
                <line x1="340" y1="60" x2="340" y2="80" strokeWidth="1.5" strokeDasharray="4 3"/>
              </svg>

              <div style={{ position: 'relative', zIndex: 1 }}>
                <button onClick={() => switchMode('stickerGuideAdmin')} title="จัดการคู่มือติดสติ๊กเกอร์ (แอดมิน)" style={{
                  position: 'absolute', top: 0, right: '14px', width: '38px', height: '38px',
                  borderRadius: '12px', border: '1px solid rgba(0,0,0,0.06)', background: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                }}>
                  <IconWrench size={20} color="#e65100" />
                </button>

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '28px' }}>
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

                {/* หมวดหมู่: Production */}
                <div style={{ padding: '0 14px', marginBottom: '18px' }}>
                  <CategoryLabel>การผลิต</CategoryLabel>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <SoftCard
                      onClick={() => switchMode('production')}
                      bg="#eaf6ec" iconBg="#cfead5"
                      icon={<IconFactory size={26} color="#2e7d32" />}
                      title="บันทึกการผลิต"
                      subtitle="Production Control"
                      badge={isProdActive && <div style={{ position: 'absolute', top: '10px', right: '12px', background: '#ff3b30', color: 'white', fontSize: '0.62rem', padding: '3px 8px', borderRadius: '8px', animation: 'pulse 1.5s infinite' }}>● กำลังทำงาน</div>}
                    />
                    <SoftCard
                      onClick={() => switchMode('todo')}
                      bg="#fff1e6" iconBg="#ffe0c2"
                      icon={<span style={{ fontSize: '1.5rem' }}>✅</span>}
                      title="To-do วันนี้"
                      subtitle="งานผลิต · CIP · ส่งเวร · ผู้ช่วย AI"
                    />
                    <SoftCard
                      onClick={() => switchMode('line4manual')}
                      bg="#eef3ec" iconBg="#d6e3d2"
                      icon={<IconBook size={24} color="#4a7c59" />}
                      title="คู่มือระบบผลิต Line 4"
                      subtitle="Mixing · Pasteurizer · Storage · CIP Kitchen"
                    />
                  </div>
                </div>

                {/* หมวดหมู่: CIP */}
                <div style={{ padding: '0 14px', marginBottom: '18px' }}>
                  <CategoryLabel>CIP — ทำความสะอาด</CategoryLabel>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                    <div onClick={() => switchMode('cipLine1')} style={{ background: '#e6eef9', border: '1px solid rgba(0,0,0,0.04)', borderRadius: '16px', padding: '16px 6px', color: '#0d47a1', textAlign: 'center', cursor: 'pointer', position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
                      {isCipLine1Active && <div style={{ position: 'absolute', top: '6px', right: '6px', width: '8px', height: '8px', background: '#ff3b30', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />}
                      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '6px' }}><IconWater size={28} color="#5b8fd6" /></div>
                      <div style={{ fontWeight: '700', fontSize: '0.8rem' }}>Line 1</div>
                      <div style={{ fontSize: '0.68rem', opacity: 0.65, marginTop: '2px' }}>Syrup</div>
                    </div>
                    <div onClick={() => switchMode('cipLine2')} style={{ background: '#e3eef8', border: '1px solid rgba(0,0,0,0.04)', borderRadius: '16px', padding: '16px 6px', color: '#01579b', textAlign: 'center', cursor: 'pointer', position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
                      {isCipLine2Active && <div style={{ position: 'absolute', top: '6px', right: '6px', width: '8px', height: '8px', background: '#ff3b30', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />}
                      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '6px' }}><IconWater size={28} color="#4f9bd1" /></div>
                      <div style={{ fontWeight: '700', fontSize: '0.8rem' }}>Line 2</div>
                      <div style={{ fontSize: '0.68rem', opacity: 0.65, marginTop: '2px' }}>Flavour</div>
                    </div>
                    <div onClick={() => switchMode('cipLine3')} style={{ background: '#e1f0ef', border: '1px solid rgba(0,0,0,0.04)', borderRadius: '16px', padding: '16px 6px', color: '#006064', textAlign: 'center', cursor: 'pointer', position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
                      {isCipLine3Active && <div style={{ position: 'absolute', top: '6px', right: '6px', width: '8px', height: '8px', background: '#ff3b30', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />}
                      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '6px' }}><IconWater size={28} color="#4ba6a4" /></div>
                      <div style={{ fontWeight: '700', fontSize: '0.8rem' }}>Line 3</div>
                      <div style={{ fontSize: '0.68rem', opacity: 0.65, marginTop: '2px' }}>Flavour</div>
                    </div>
                  </div>
                  <SoftCard
                    onClick={() => switchMode('cip')}
                    bg="#f4f5f6" iconBg="#e6e8ea"
                    icon={<IconFlask size={22} color="#78828a" />}
                    title="CIP ทดลอง"
                    subtitle="Line 2 (ใหม่)"
                    badge={isCipLabActive && <div style={{ position: 'absolute', top: '10px', right: '12px', width: '8px', height: '8px', background: '#ff3b30', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />}
                  />
                </div>

                {/* หมวดหมู่: Sticker how to */}
                <div style={{ padding: '0 14px', marginBottom: '10px' }}>
                  <CategoryLabel>Sticker how to</CategoryLabel>
                  <SoftCard
                    onClick={() => switchMode('stickerGuideChat')}
                    bg="#fff1e6" iconBg="#ffe0c2"
                    icon={<IconChat size={22} color="#e65100" />}
                    title="Sticker how to"
                    subtitle="แชทถามขั้นตอนติดสติ๊กเกอร์ตามชื่อลูกค้า"
                  />
                </div>

                <div style={{ textAlign: 'center', marginTop: '50px' }}><button onClick={handleLogout} style={{ background: 'none', border: 'none', color: '#bbb', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.85rem' }}>ออกจากระบบ</button></div>
              </div>
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

          <div style={{ display: appMode === 'line4manual' ? 'block' : 'none' }}>
            <Line4Manual operatorName={operator} onBackToMain={() => switchMode('selection')} />
          </div>

          <div style={{ display: appMode === 'todo' ? 'block' : 'none' }}>
            <TodoBoard operatorName={operator} onBackToMain={() => switchMode('selection')} onGoToProduction={() => switchMode('production')} />
          </div>

          <div style={{ display: appMode === 'stickerGuideChat' ? 'block' : 'none' }}>
            <StickerGuideChat onBackToMain={() => switchMode('selection')} darkMode={darkMode} />
          </div>

          <div style={{ display: appMode === 'stickerGuideAdmin' ? 'block' : 'none' }}>
            <StickerGuideAdmin onBackToMain={() => switchMode('selection')} />
          </div>
        </div>
        </>
      )}
    </div>
  );
};

export default App;
