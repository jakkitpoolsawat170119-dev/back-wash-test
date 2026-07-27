import React, { useState } from 'react';
import BrandLogo from './BrandLogo';

/** Reuses the SAME credentials + sessionStorage key as StickerGuideAdmin,
 *  so once you pass this gate the embedded QC Record editor never re-prompts. */
export const ADMIN_USER = import.meta.env.VITE_STICKER_ADMIN_USER || 'admin';
export const ADMIN_PASS = import.meta.env.VITE_STICKER_ADMIN_PASS || 'admin1234';
export const ADMIN_AUTH_KEY = 'stickerGuideAdminAuthed';

export const isAdminAuthed = () => sessionStorage.getItem(ADMIN_AUTH_KEY) === '1';

interface Props {
  onExit: () => void;
  onAuthed: () => void;
}

const AdminGate: React.FC<Props> = ({ onExit, onAuthed }) => {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
      sessionStorage.setItem(ADMIN_AUTH_KEY, '1');
      onAuthed();
    } else {
      setError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
  };

  return (
    <div className="rd-shell">
      <div className="adminlogin-wrap">
        <form className="logincard" onSubmit={submit}>
          <div style={{ marginBottom: 14, filter: 'drop-shadow(0 6px 14px rgba(255,107,0,.45))', display: 'inline-block' }}>
            <BrandLogo size={52} showWord={false} />
          </div>
          <h2>SPP-MP Admin</h2>
          <p className="sub">พื้นที่ผู้ดูแล — จัดการงาน ทีม รายงาน และคู่มือทั้งหมด</p>
          <label htmlFor="au">ชื่อผู้ใช้</label>
          <input id="au" type="text" value={user} onChange={e => setUser(e.target.value)} autoComplete="username" autoFocus />
          <label htmlFor="ap">รหัสผ่าน</label>
          <input id="ap" type="password" value={pass} onChange={e => setPass(e.target.value)} autoComplete="current-password" />
          {error && <div className="err">{error}</div>}
          <button className="btn" type="submit">เข้าสู่ระบบ →</button>
          <button type="button" onClick={onExit} className="hint" style={{ background: 'none', border: 'none', width: '100%', cursor: 'pointer' }}>← กลับหน้าหลัก</button>
        </form>
      </div>
    </div>
  );
};

export default AdminGate;
