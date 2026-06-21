import React from 'react';

interface LogoProps {
  size?: number;
}

const Logo: React.FC<LogoProps> = ({ size = 88 }) => (
  <div style={{
    width: size, height: size, borderRadius: size * 0.28, flexShrink: 0,
    background: 'linear-gradient(135deg, #ff6b00, #ff8c00)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: `0 ${size * 0.12}px ${size * 0.32}px -${size * 0.1}px rgba(230,81,0,0.5), 0 ${size * 0.03}px ${size * 0.08}px rgba(0,0,0,0.12)`,
    border: '1.5px solid rgba(255,255,255,0.35)',
  }}>
    <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
      <path d="M12 2.5C8.5 7 5.5 10.8 5.5 14.2C5.5 18.1 8.4 21 12 21C15.6 21 18.5 18.1 18.5 14.2C18.5 10.8 15.5 7 12 2.5Z" fill="white" />
      <path d="M9 14.3C9 16.4 10.5 18 12.4 17.96" stroke="#ff8c00" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
    </svg>
  </div>
);

export default Logo;
