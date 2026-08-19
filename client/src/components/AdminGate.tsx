import React, { useEffect, useState } from 'react';
import BrandLogo from './BrandLogo';
import { saveAuth } from '../lib/auth';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

/* ประตูเข้าหน้าผู้ดูแล
   🔴 เดิมเทียบชื่อผู้ใช้/รหัสผ่าน "ในโค้ดหน้าเว็บ" — ใครเปิดดูโค้ดก็เห็นรหัส
   ตอนนี้ส่งไปให้เซิร์ฟเวอร์ตรวจ (POST /api/auth/admin) แล้วได้โทเคนกลับมา
   เข้าได้ 2 ทาง: ชื่อ+PIN ของตัวเอง (ต้องเป็น supervisor ขึ้นไป) หรือรหัสผู้ดูแลระบบ
   ทางที่สองเก็บไว้กันล็อกตัวเองออก ถ้าสิทธิ์ยังตั้งไม่เรียบร้อย                       */
interface Props {
  onExit: () => void;
  onAuthed: () => void;
}

const AdminGate: React.FC<Props> = ({ onExit, onAuthed }) => {
  const [mode, setMode] = useState<'pin' | 'pass'>('pin');
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState(localStorage.getItem('operator') || '');
  const [pin, setPin] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${apiUrl}/api/operators`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setNames(d); })
      .catch(() => setNames([]));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = mode === 'pin' ? { name, pin } : { pass };
      const r = await fetch(`${apiUrl}/api/auth/admin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'เข้าสู่ระบบไม่สำเร็จ'); return; }
      saveAuth(d);
      onAuthed();
    } catch { setError('ต่อเซิร์ฟเวอร์ไม่ได้ — เช็คเน็ตแล้วลองใหม่'); } finally { setBusy(false); }
  };

  const tab: React.CSSProperties = {
    flex: 1, border: 'none', borderRadius: 999, padding: '7px 10px', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
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

          <div style={{ display: 'flex', gap: 4, background: '#f2ece6', borderRadius: 999, padding: 3, marginBottom: 12 }}>
            {([['pin', 'PIN ของฉัน'], ['pass', 'รหัสผู้ดูแลระบบ']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => { setMode(k); setError(''); }}
                style={{ ...tab, background: mode === k ? '#fff' : 'transparent', color: mode === k ? '#2b2119' : '#6d6259' }}>
                {label}
              </button>
            ))}
          </div>

          {mode === 'pin' ? (<>
            <label htmlFor="au">ชื่อผู้ใช้</label>
            <input id="au" list="admin-names" value={name} onChange={e => setName(e.target.value)}
              autoComplete="username" autoFocus placeholder="เลือกชื่อของคุณ" />
            <datalist id="admin-names">{names.map(n => <option key={n} value={n} />)}</datalist>
            <label htmlFor="ap">PIN</label>
            <input id="ap" type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)}
              autoComplete="current-password" placeholder="PIN ที่ใช้เข้าแอป" />
          </>) : (<>
            <label htmlFor="ax">รหัสผู้ดูแลระบบ</label>
            <input id="ax" type="password" value={pass} onChange={e => setPass(e.target.value)}
              autoComplete="current-password" autoFocus />
          </>)}

          {error && <div className="err">{error}</div>}
          <button className="btn" type="submit" disabled={busy}>{busy ? 'กำลังตรวจสอบ…' : 'เข้าสู่ระบบ →'}</button>
          <button type="button" onClick={onExit} className="hint" style={{ background: 'none', border: 'none', width: '100%', cursor: 'pointer' }}>← กลับหน้าหลัก</button>
          <div className="hint" style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.6 }}>
            เข้าด้วย PIN ได้เฉพาะคนที่มีสิทธิ์ supervisor ขึ้นไป — ตั้งสิทธิ์ได้ที่เมนู “ผู้ใช้และสิทธิ์”
          </div>
        </form>
      </div>
    </div>
  );
};

export default AdminGate;
