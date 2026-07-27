import React from 'react';

/**
 * SPP-MP brand mark — droplet tile + wordmark (design "แบบ 1" from the mockup).
 * The SVG droplet reuses the same path as the original Logo.tsx.
 */
const BrandLogo: React.FC<{ size?: number; showWord?: boolean; wordClass?: string }> = ({
  size = 28,
  showWord = true,
  wordClass = 'lg-word',
}) => {
  const gid = React.useId();
  return (
    <>
      <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff6b00" />
            <stop offset="1" stopColor="#ff8c00" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="32" height="32" rx="9.5" fill={`url(#${gid})`} stroke="rgba(255,255,255,.35)" strokeWidth="1.2" />
        <path transform="translate(5.5,5.5) scale(0.96)" d="M12 2.5C8.5 7 5.5 10.8 5.5 14.2C5.5 18.1 8.4 21 12 21C15.6 21 18.5 18.1 18.5 14.2C18.5 10.8 15.5 7 12 2.5Z" fill="#fff" />
        <path transform="translate(5.5,5.5) scale(0.96)" d="M9 14.3C9 16.4 10.5 18 12.4 17.96" stroke="#ff8c00" strokeWidth="1.6" strokeLinecap="round" opacity=".55" fill="none" />
      </svg>
      {showWord && <span className={wordClass}>SPP<em>-MP</em></span>}
    </>
  );
};

export default BrandLogo;
