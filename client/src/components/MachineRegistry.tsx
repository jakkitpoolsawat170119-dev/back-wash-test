import React, { useCallback, useEffect, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

/* ทะเบียนเครื่องจักร — Master Data ของแผน ERP เฟส 1
   ชื่อเครื่องที่นี่คือ "ชื่อจริง" ที่ทะเบียนงานรูทีน และโน้ตเหตุการณ์ใน Obsidian อ้างถึง
   ([[ชื่อเครื่อง]]) — เปลี่ยนชื่อที่นี่แล้วต้องตามไปแก้ในทะเบียนงานรูทีน ด้วย        */
type Machine = {
  id: number; code: string; name: string; line: string;
  installedAt: string; lastPm: string; note: string; vaultPath: string;
  pmCount: number; openIncidents: number;
};

const card: React.CSSProperties = {
  background: '#fff', border: '1px solid var(--line,#eee3d9)', borderRadius: 16,
  boxShadow: '0 1px 2px rgba(63,37,10,.06),0 6px 18px -6px rgba(63,37,10,.12)',
};
const btn: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', color: 'var(--ink-soft,#6d6259)',
  padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
  fontFamily: 'Kanit, sans-serif', cursor: 'pointer',
};
const inp: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', borderRadius: 9,
  padding: '6px 9px', fontSize: 13, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
};
const lbl: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' };

const blank = (): Machine => ({ id: 0, code: '', name: '', line: '', installedAt: '', lastPm: '', note: '', vaultPath: '', pmCount: 0, openIncidents: 0 });

const MachineRegistry: React.FC = () => {
  const [list, setList] = useState<Machine[]>([]);
  const [edit, setEdit] = useState<Machine | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await fetch(`${apiUrl}/api/machines`).then(r => r.json());
      setList(Array.isArray(d?.machines) ? d.machines : []);
    } catch { setMsg('❌ โหลดทะเบียนเครื่องจักรไม่สำเร็จ'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (m: Machine) => {
    if (!m.name.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/machines`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: m.id || undefined, code: m.code, name: m.name.trim(), line: m.line, installedAt: m.installedAt, lastPm: m.lastPm, note: m.note }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'บันทึกไม่สำเร็จ'}`); return; }
      setEdit(null);
      setMsg(d.vaultPath ? `✅ บันทึกแล้ว · อัปเดตโน้ต ${d.vaultPath}`
        : d.vaultSkipped ? `✅ บันทึกแล้ว (${d.vaultSkipped} — โน้ตยังไม่ถูกเขียน)`
        : d.vaultError ? `✅ บันทึกแล้ว ⚠️ เขียนโน้ตไม่สำเร็จ: ${d.vaultError}` : '✅ บันทึกแล้ว');
      await load();
    } catch { setMsg('❌ บันทึกไม่สำเร็จ'); } finally { setBusy(false); }
  };
  // เขียนโน้ตของทุกเครื่องรอบเดียว — ใช้ตอนเริ่มใช้งาน หรือหลังแก้ทะเบียนงานรูทีนยกชุด
  const syncAll = async () => {
    setBusy(true); setMsg('กำลังเขียนโน้ตทุกเครื่อง…');
    try {
      const d = await fetch(`${apiUrl}/api/machines/sync-notes`, { method: 'POST' }).then(r => r.json());
      setMsg(d.skipped ? `⚠️ ${d.skipped}`
        : d.failed?.length ? `⚠️ เขียนได้ ${d.written}/${d.total} · พลาด: ${d.failed.map((f: { name: string }) => f.name).join(', ')}`
        : `✅ เขียนโน้ตครบ ${d.written}/${d.total} เครื่อง ลงโฟลเดอร์ เครื่องจักร`);
      await load();
    } catch { setMsg('❌ ซิงก์ไม่สำเร็จ'); } finally { setBusy(false); }
  };
  const del = async (m: Machine) => {
    if (!window.confirm(`เอา "${m.name}" ออกจากทะเบียน?\n(งาน PM ที่อ้างชื่อนี้ยังอยู่เหมือนเดิม)`)) return;
    setBusy(true);
    try {
      await fetch(`${apiUrl}/api/machines/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id }) });
      await load();
    } finally { setBusy(false); }
  };

  const Form: React.FC<{ draft: Machine }> = ({ draft }) => {
    const [d, setD] = useState(draft);
    const set = (patch: Partial<Machine>) => setD(v => ({ ...v, ...patch }));
    return (
      <div style={{ ...card, padding: 16, marginBottom: 14, background: '#fffaf5' }}>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
          <label style={lbl}>ชื่อเครื่อง (ใช้เป็น [[wikilink]])
            <input autoFocus value={d.name} onChange={e => set({ name: e.target.value })} style={{ ...inp, marginTop: 3 }} />
          </label>
          <label style={lbl}>รหัส
            <input value={d.code} onChange={e => set({ code: e.target.value })} placeholder="เช่น MC-014" style={{ ...inp, marginTop: 3 }} />
          </label>
          <label style={lbl}>ไลน์
            <input value={d.line} onChange={e => set({ line: e.target.value })} placeholder="เช่น Line 2" style={{ ...inp, marginTop: 3 }} />
          </label>
          <label style={lbl}>วันที่ติดตั้ง
            <input type="date" value={d.installedAt} onChange={e => set({ installedAt: e.target.value })} style={{ ...inp, marginTop: 3 }} />
          </label>
          <label style={lbl}>PM ล่าสุด
            <input type="date" value={d.lastPm} onChange={e => set({ lastPm: e.target.value })} style={{ ...inp, marginTop: 3 }} />
          </label>
        </div>
        <label style={{ ...lbl, display: 'block', marginTop: 10 }}>จุดที่มักมีปัญหา / หมายเหตุ
          <textarea value={d.note} onChange={e => set({ note: e.target.value })} rows={2} style={{ ...inp, marginTop: 3, resize: 'vertical' }} />
        </label>
        <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
          <button onClick={() => save(d)} disabled={busy || !d.name.trim()} style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>บันทึก</button>
          <button onClick={() => setEdit(null)} style={btn}>ยกเลิก</button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#0f7a6c',
        background: '#e8f6f3', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>📚 Knowledge management</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          ทะเบียนเครื่องจักร
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>{list.length} เครื่อง</span>
        <span style={{ flex: 1 }} />
        <button onClick={syncAll} disabled={busy} style={btn}>🔄 ซิงก์โน้ตเข้า Obsidian</button>
        <button onClick={() => setEdit(blank())} style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>＋ เพิ่มเครื่องจักร</button>
      </div>
      {msg && <div style={{ fontSize: 12.5, color: msg.startsWith('✅') ? '#1c8a4c' : msg.startsWith('⚠️') ? '#c77700' : '#c62828', marginBottom: 10, wordBreak: 'break-all' }}>{msg}</div>}
      {edit && edit.id === 0 && <Form draft={edit} />}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', alignItems: 'start' }}>
        {list.map(m => (edit && edit.id === m.id ? <Form key={m.id} draft={edit} /> : (
          <article key={m.id} style={{ ...card, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <h3 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, margin: 0, minWidth: 0, flex: 1 }}>
                🔩 {m.name}
              </h3>
              {m.openIncidents > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: '#c77700', background: '#fdf1de', borderRadius: 999, padding: '2px 9px', flex: 'none' }}>
                  เหตุการณ์ค้าง {m.openIncidents}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft,#6d6259)', marginTop: 4, lineHeight: 1.7 }}>
              {m.code && <>รหัส <b>{m.code}</b> · </>}
              {m.line && <>{m.line} · </>}
              งาน PM <b>{m.pmCount}</b> รายการ
              {m.installedAt && <><br />ติดตั้ง {m.installedAt}</>}
              {m.lastPm && <> · PM ล่าสุด {m.lastPm}</>}
            </div>
            {m.note && <div style={{ fontSize: 12.5, color: 'var(--ink,#2b2119)', marginTop: 8, background: '#fbf7f3', borderRadius: 10, padding: '8px 10px', lineHeight: 1.6 }}>{m.note}</div>}
            {m.vaultPath && (
              <div style={{ fontSize: 11, color: 'var(--ink-soft,#6d6259)', marginTop: 8, wordBreak: 'break-all' }}>📄 {m.vaultPath}</div>
            )}
            <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
              <button onClick={() => setEdit(m)} style={{ ...btn, padding: '4px 11px', fontSize: 12 }}>✏️ แก้ไข</button>
              <button onClick={() => del(m)} style={{ ...btn, padding: '4px 11px', fontSize: 12, color: '#c62828', background: '#fdecea', borderColor: '#f7d9d5' }}>🗑 เอาออก</button>
            </div>
          </article>
        )))}
      </div>
      {!list.length && (
        <div style={{ ...card, padding: 20, textAlign: 'center', color: 'var(--ink-soft,#6d6259)', fontSize: 13 }}>
          ยังไม่มีเครื่องจักรในทะเบียน — กด “＋ เพิ่มเครื่องจักร”
        </div>
      )}
    </div>
  );
};

export default MachineRegistry;
