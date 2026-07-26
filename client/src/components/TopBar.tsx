import React from 'react';
import BrandLogo from './BrandLogo';

export type AppView = 'home' | 'production' | 'cip' | 'stickerchat' | 'admin';

interface Props {
  active: AppView;
  onNav: (v: AppView) => void;
  operator: string | null;
  darkMode: boolean;
  onToggleDark: () => void;
}

const NAV: { view: AppView; icon: string; label: string }[] = [
  { view: 'home', icon: '🏠', label: 'หน้าหลัก' },
  { view: 'production', icon: '🏭', label: 'ผลิต' },
  { view: 'cip', icon: '💧', label: 'CIP' },
  { view: 'admin', icon: '🔐', label: 'Admin' },
];

const TopBar: React.FC<Props> = ({ active, onNav, operator, darkMode, onToggleDark }) => {
  const isOn = (v: AppView) => v === active;

  return (
    <header className="topbar">
      <button className="logo" onClick={() => onNav('home')} aria-label="SPP-MP หน้าหลัก">
        <BrandLogo size={28} />
      </button>
      <nav className="nav">
        {NAV.map(({ view, icon, label }) => (
          <button
            key={view}
            className={`navbtn${view === 'admin' ? ' admin' : ''}${isOn(view) ? ' on' : ''}`}
            onClick={() => onNav(view)}
          >
            <span className="nic">{icon} </span>{label}
          </button>
        ))}
      </nav>
      <span className="chip-op"><span className="dot" /><span className="opname">{operator || '—'}</span></span>
      <button className="iconbtn" onClick={onToggleDark} aria-label="สลับโหมดมืด">
        {darkMode ? '☀️' : '🌙'}
      </button>
    </header>
  );
};

export default TopBar;
