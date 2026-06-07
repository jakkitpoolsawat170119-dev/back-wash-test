import React from 'react';

const LockBanner: React.FC<{ holderName: string }> = ({ holderName }) => (
  <div style={{ background: '#fce4ec', border: '1px solid #f48fb1', borderRadius: '12px', padding: '12px 16px', margin: '0 auto 15px auto', maxWidth: '500px', textAlign: 'center' }}>
    <span style={{ color: '#ad1457', fontWeight: 'bold', fontSize: '0.9rem' }}>🔒 หน้านี้กำลังถูกใช้งานโดยคุณ {holderName} อยู่ในขณะนี้ — กรุณารอสักครู่</span>
  </div>
);

export default LockBanner;
