import React, { useCallback, useEffect, useState } from 'react';
import { authHeaders, authName, authRole } from '../lib/auth';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

/* ── ผู้ใช้และสิทธิ์ (ERP เฟส 1 ในแผน) ───────────────────────────────────────
   operator = ใช้งานหน้างาน · supervisor = เข้าหน้าผู้ดูแล/อนุมัติได้ · admin = แก้สิทธิ์คนอื่นได้
   เซิร์ฟเวอร์บังคับสิทธิ์จริงด้วยโทเคนที่ได้ตอนเข้าหน้าผู้ดูแล (x-spp-token)          */
type Role = 'operator' | 'supervisor' | 'admin';
type User = { name: string; role: Role; hasPin: boolean };

const ROLE_INFO: Record<Role, { label: string; c: string; w: string; what: string }> = {
  operator: { label: 'ผู้ปฏิบัติงาน', c: '#4b433c', w: '#f2ede8', what: 'ใช้งานหน้างานตามปกติ เข้าหน้าผู้ดูแลไม่ได้' },
  supervisor: { label: 'หัวหน้างาน', c: '#0d47a1', w: '#e8f1fb', what: 'เข้าหน้าผู้ดูแลได้ด้วย PIN ตัวเอง · อนุมัติงาน/SOP' },
  admin: { label: 'ผู้ดูแลระบบ', c: '#c24f00', w: '#fff3ea', what: 'ทำได้ทุกอย่าง รวมถึงแก้สิทธิ์คนอื่น' },
};
const ROLES: Role[] = ['operator', 'supervisor', 'admin'];

const card: React.CSSProperties = {
  background: 'var(--card,#fff)', border: '1px solid var(--line,#eee3d9)', borderRadius: 16,
  boxShadow: '0 1px 2px rgba(63,37,10,.06),0 6px 18px -6px rgba(63,37,10,.12)',
};
const btn: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', color: 'var(--ink-soft,#6d6259)',
  padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
  fontFamily: 'Kanit, sans-serif', cursor: 'pointer',
};
const inp: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fdfbf9', borderRadius: 10,
  padding: '7px 12px', fontSize: 13.5, fontWeight: 500, color: 'var(--ink,#2b2119)', fontFamily: 'inherit',
};

const UsersAdmin: React.FC = () => {
  const [list, setList] = useState<User[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [newName, setNewName] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newRole, setNewRole] = useState<Role>('operator');
  const [pinFor, setPinFor] = useState('');      // ชื่อคนที่กำลังตั้ง PIN ใหม่
  const [pinValue, setPinValue] = useState('');
  const me = authName();
  const iAmAdmin = authRole() === 'admin';

  const load = useCallback(async () => {
    try {
      const d = await fetch(`${apiUrl}/api/operators?withRole=1`).then(r => r.json());
      setList(Array.isArray(d?.operators) ? d.operators : []);
    } catch { setMsg('❌ โหลดรายชื่อไม่สำเร็จ'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // ทุกการเขียนผ่านเส้นเดียว — เซิร์ฟเวอร์เป็นคนตัดสินว่าทำได้ไหม (401/403 ก็เอาข้อความมาโชว์)
  const post = async (url: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(String(body.name || '1')); setMsg('');
    try {
      const r = await fetch(`${apiUrl}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'ทำรายการไม่สำเร็จ'}`); return false; }
      setMsg(`✅ ${okMsg}`);
      await load();
      return true;
    } catch { setMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); return false; } finally { setBusy(''); }
  };

  const setRole = (u: User, role: Role) => post('/api/operators', { name: u.name, role }, `ตั้ง ${u.name} เป็น ${ROLE_INFO[role].label} แล้ว`);
  const savePin = async (u: User) => {
    if (!/^\d{4,6}$/.test(pinValue)) { setMsg('❌ PIN ต้องเป็นตัวเลข 4-6 หลัก'); return; }
    if (await post('/api/operators', { name: u.name, role: u.role, pin: pinValue }, `ตั้ง PIN ใหม่ให้ ${u.name} แล้ว`)) {
      setPinFor(''); setPinValue('');
    }
  };
  const addUser = async () => {
    if (!newName.trim()) return;
    if (newPin && !/^\d{4,6}$/.test(newPin)) { setMsg('❌ PIN ต้องเป็นตัวเลข 4-6 หลัก'); return; }
    if (await post('/api/operators', { name: newName.trim(), role: newRole, pin: newPin || undefined }, `เพิ่ม ${newName.trim()} แล้ว`)) {
      setNewName(''); setNewPin(''); setNewRole('operator');
    }
  };
  const del = (u: User) => {
    if (!window.confirm(`เอา "${u.name}" ออกจากระบบ?\nคนนี้จะล็อกอินเข้าแอปไม่ได้อีก (ข้อมูลงานเก่ายังอยู่ครบ)`)) return;
    return post('/api/operators/delete', { name: u.name }, `เอา ${u.name} ออกแล้ว`);
  };

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#0d47a1',
        background: '#e8f1fb', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>🔐 ตั้งค่าระบบ</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          ผู้ใช้และสิทธิ์
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>
          {list.length} คน · คุณเข้ามาในฐานะ <b>{me || '—'}</b> ({ROLE_INFO[(authRole() as Role)] ? ROLE_INFO[authRole() as Role].label : authRole() || '—'})
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-soft,#6d6259)', lineHeight: 1.7, marginBottom: 14 }}>
        {ROLES.map(r => (
          <div key={r}>
            <b style={{ color: ROLE_INFO[r].c }}>{ROLE_INFO[r].label}</b> — {ROLE_INFO[r].what}
          </div>
        ))}
      </div>

      {!iAmAdmin && (
        <div style={{ ...card, borderColor: '#f0dcc8', background: '#fdf6ee', padding: '11px 14px', marginBottom: 14, fontSize: 13, lineHeight: 1.7 }}>
          ℹ️ คุณดูได้อย่างเดียว — การแก้สิทธิ์ต้องเป็น <b>ผู้ดูแลระบบ</b>
          {authRole() === '' && <> (เข้าหน้านี้ด้วยรหัสผู้ดูแลระบบหรือ PIN ของ admin ก่อน)</>}
        </div>
      )}
      {msg && <div style={{ fontSize: 12.5, marginBottom: 10, color: msg.startsWith('✅') ? '#1c8a4c' : '#c62828' }}>{msg}</div>}

      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', alignItems: 'start' }}>
        {list.map(u => (
          <article key={u.name} style={{ ...card, padding: '13px 15px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{
                width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none',
                background: ROLE_INFO[u.role].w, color: ROLE_INFO[u.role].c, fontFamily: 'Kanit, sans-serif', fontWeight: 600,
              }}>{u.name.slice(0, 1)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 14.5, fontWeight: 600 }}>
                  {u.name}{u.name === me && <span style={{ fontSize: 11, color: '#c24f00', marginLeft: 6 }}>(คุณ)</span>}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
                  {u.hasPin ? 'ตั้ง PIN ไว้แล้ว' : '⚠️ ยังไม่มี PIN — ล็อกอินไม่ได้'}
                </div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '3px 10px', flex: 'none',
                color: ROLE_INFO[u.role].c, background: ROLE_INFO[u.role].w,
              }}>{ROLE_INFO[u.role].label}</span>
            </div>

            {iAmAdmin && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                <select value={u.role} onChange={e => setRole(u, e.target.value as Role)} disabled={busy === u.name}
                  style={{ ...inp, padding: '5px 9px', fontSize: 12.5 }}>
                  {ROLES.map(r => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
                </select>
                <button onClick={() => { setPinFor(pinFor === u.name ? '' : u.name); setPinValue(''); }}
                  style={{ ...btn, padding: '5px 11px', fontSize: 12 }}>🔑 ตั้ง PIN ใหม่</button>
                <button onClick={() => del(u)} disabled={busy === u.name}
                  style={{ ...btn, padding: '5px 11px', fontSize: 12, color: '#c62828', background: '#fdecea', borderColor: '#f7d9d5' }}>เอาออก</button>
              </div>
            )}
            {pinFor === u.name && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <input autoFocus type="text" inputMode="numeric" value={pinValue} onChange={e => setPinValue(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && savePin(u)} placeholder="PIN ใหม่ 4-6 หลัก"
                  style={{ ...inp, flex: 1, minWidth: 130 }} />
                <button onClick={() => savePin(u)} style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>บันทึก</button>
                <button onClick={() => { setPinFor(''); setPinValue(''); }} style={btn}>ยกเลิก</button>
              </div>
            )}
          </article>
        ))}
      </div>

      {iAmAdmin && (
        <div style={{ ...card, padding: '14px 16px', marginTop: 14 }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 10 }}>＋ เพิ่มผู้ใช้</div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="ชื่อ-นามสกุล"
              style={{ ...inp, flex: '2 1 200px' }} />
            <input value={newPin} onChange={e => setNewPin(e.target.value)} placeholder="PIN (ไม่ใส่ = 1234)"
              inputMode="numeric" style={{ ...inp, flex: '1 1 140px' }} />
            <select value={newRole} onChange={e => setNewRole(e.target.value as Role)} style={{ ...inp, flex: '1 1 140px' }}>
              {ROLES.map(r => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
            </select>
            <button onClick={addUser} disabled={!newName.trim() || !!busy}
              style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>เพิ่ม</button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', marginTop: 9, lineHeight: 1.7 }}>
            ชื่อที่เพิ่มตรงนี้จะไปโผล่ในหน้าเลือกผู้ปฏิบัติงานตอนเปิดแอป · PIN ใช้ล็อกอินเข้าแอปและเข้าหน้าผู้ดูแล (ถ้าสิทธิ์ถึง)
          </div>
        </div>
      )}
    </div>
  );
};

export default UsersAdmin;
