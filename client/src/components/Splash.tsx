import React from 'react';
import Logo from './Logo';

interface SplashProps {
  fadeOut: boolean;
}

const Splash: React.FC<SplashProps> = ({ fadeOut }) => (
  <div style={{
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'linear-gradient(135deg, #fff5eb 0%, #ffffff 55%, #fff0e0 100%)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '18px',
    opacity: fadeOut ? 0 : 1,
    transition: 'opacity 0.45s cubic-bezier(0.4,0,0.2,1)',
    pointerEvents: fadeOut ? 'none' : 'auto',
  }}>
    <style>{`
      @keyframes splashIn { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }
      @keyframes splashPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
      @keyframes splashDot { 0%, 80%, 100% { opacity: 0.25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
      .splash-logo { animation: splashIn 0.5s cubic-bezier(0.22,1,0.36,1), splashPulse 1.8s ease-in-out 0.5s infinite; }
    `}</style>
    <div className="splash-logo"><Logo size={96} /></div>
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#37474f', letterSpacing: '-0.01em' }}>ระบบบันทึกข้อมูลการผลิต & CIP</div>
      <div style={{ fontSize: '0.7rem', color: '#9aa3a8', marginTop: '4px', letterSpacing: '0.02em' }}>Mitr Phol Thailand</div>
    </div>
    <div style={{ display: 'flex', gap: '5px', marginTop: '6px' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: '7px', height: '7px', borderRadius: '50%', background: '#ff8c00',
          animation: 'splashDot 1.1s infinite ease-in-out', animationDelay: `${i * 0.15}s`,
        }} />
      ))}
    </div>
  </div>
);

export default Splash;
