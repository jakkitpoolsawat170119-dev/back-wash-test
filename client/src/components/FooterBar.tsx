import React from 'react';

export const HomeIcon: React.FC<{ size?: number; color?: string }> = ({ size = 16, color = '#5b6b73' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9" />
    <path d="M10 20v-5.5h4V20" />
  </svg>
);

export const FlagIcon: React.FC<{ size?: number; color?: string }> = ({ size = 16, color = '#ffffff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 21V4" />
    <path d="M5 4.5h13l-3 3.5 3 3.5H5" />
  </svg>
);

export const UserIcon: React.FC<{ size?: number; color?: string }> = ({ size = 13, color = '#ffffff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-3.6 3.6-6 8-6s8 2.4 8 6" />
  </svg>
);

export const CheckIcon: React.FC<{ size?: number; color?: string }> = ({ size = 13, color = '#ffffff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const OperatorBadge: React.FC<{ name: string; color: string }> = ({ name, color }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
    <div style={{
      width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
      background: color, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <UserIcon size={11} />
    </div>
    <span style={{ fontSize: '0.74rem', fontWeight: 700, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '90px' }}>
      {name}
    </span>
  </div>
);

export const ProgressBadge: React.FC<{ done: number; total: number; color: string }> = ({ done, total, color }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
    <div style={{ width: '18px', height: '18px', borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <CheckIcon size={10} />
    </div>
    <span style={{ fontSize: '0.74rem', fontWeight: 700, color }}>{done}/{total}</span>
  </div>
);

interface FooterBarProps {
  accentColor: string;
  homeLabel?: string;
  onHome: () => void;
  finishLabel?: string;
  onFinish?: () => void;
  right?: React.ReactNode;
}

const FooterBar: React.FC<FooterBarProps> = ({ accentColor, homeLabel = 'เมนูหลัก', onHome, finishLabel, onFinish, right }) => (
  <div style={{
    position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
    background: '#ffffff', borderTop: `2px solid ${accentColor}`,
    boxShadow: '0 -4px 14px rgba(0,0,0,0.06)',
    padding: '9px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
  }}>
    <button
      onClick={onHome}
      style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0,
        background: '#f6f7f8', border: '1px solid #e3e5e7', borderRadius: '10px',
        padding: '8px 13px', fontSize: '0.76rem', fontWeight: 700, color: '#5b6b73', cursor: 'pointer',
      }}
    >
      <HomeIcon />
      {homeLabel}
    </button>

    {onFinish && (
      <button
        onClick={onFinish}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0,
          background: '#b3413a', border: 'none', borderRadius: '10px',
          padding: '8px 13px', fontSize: '0.76rem', fontWeight: 700, color: 'white', cursor: 'pointer',
          boxShadow: '0 3px 8px rgba(179,65,58,0.3)',
        }}
      >
        <FlagIcon />
        {finishLabel ?? 'สิ้นสุดงาน'}
      </button>
    )}

    {right && <div style={{ marginLeft: 'auto', flexShrink: 0 }}>{right}</div>}
  </div>
);

export default FooterBar;
