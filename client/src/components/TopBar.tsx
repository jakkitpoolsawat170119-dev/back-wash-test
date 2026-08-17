import React, { useEffect, useRef, useState } from 'react';
import BrandLogo from './BrandLogo';
import { CATS, categoryUrl, allArticlesUrl } from '../lib/articles';

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

/* เมนูบทความ + เมนูย่อย 6 หมวด — ทุกอันพาไปหน้าอ่านสาธารณะ (ตัวอ่านบทความอยู่ฝั่งเซิร์ฟเวอร์)
   🔴 เมนูต้องเป็น position:fixed ไม่ใช่ absolute — .nav เป็นแถบเลื่อนแนวนอน (overflow-x:auto)
      ของที่เป็น absolute จะโดนกล่องเลื่อนตัดหายทั้งอัน (เจอมาแล้วตอนทำ mockup) */
const ArticleMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(430, window.innerWidth - 28);
    setPos({ top: r.bottom + 9, left: Math.max(14, Math.min(r.left, window.innerWidth - w - 14)) });
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.amenu')) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place);
    };
  }, [open]);

  return (
    <span className={`amenu${open ? ' open' : ''}`} ref={wrapRef}>
      <button
        ref={btnRef}
        className="navbtn"
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); if (!open) place(); setOpen(o => !o); }}
      >
        <span className="nic">📚 </span>บทความ<span className="caret">▾</span>
      </button>
      {open && (
        <div className="amdd" style={{ top: pos.top, left: pos.left }}>
          <div className="amhd">เลือกหมวดหมู่</div>
          <div className="amgrid">
            {CATS.map(c => (
              <a key={c.name} href={categoryUrl(c.name)} target="_blank" rel="noopener noreferrer">
                <span className="cdot" style={{ background: c.color }} />{c.name}
              </a>
            ))}
          </div>
          <div className="amsep" />
          <div className="amfoot">
            <a href={allArticlesUrl} target="_blank" rel="noopener noreferrer">ดูบทความทั้งหมด →</a>
          </div>
        </div>
      )}
    </span>
  );
};

const TopBar: React.FC<Props> = ({ active, onNav, operator, darkMode, onToggleDark }) => {
  const isOn = (v: AppView) => v === active;

  return (
    <header className="topbar">
      <button className="logo" onClick={() => onNav('home')} aria-label="SPP-MP หน้าหลัก">
        <BrandLogo size={28} />
      </button>
      <nav className="nav">
        {NAV.map(({ view, icon, label }) => (
          <React.Fragment key={view}>
            {/* เมนูบทความแทรกก่อน Admin — เป็นของที่คนทั่วไปใช้ ไม่ใช่ของแอดมิน */}
            {view === 'admin' && <ArticleMenu />}
            <button
              className={`navbtn${view === 'admin' ? ' admin' : ''}${isOn(view) ? ' on' : ''}`}
              onClick={() => onNav(view)}
            >
              <span className="nic">{icon} </span>{label}
            </button>
          </React.Fragment>
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
