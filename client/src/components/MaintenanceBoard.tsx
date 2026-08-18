import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadDutyImage, resizePhoto } from '../lib/dutyImages';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

/* ── โครงข้อมูลจาก GET /api/duty?kind=maint (โครงเดียวกับบอร์ดกะ + watch/shiftName) ──
   nodes = งานที่ผู้รับผิดชอบหลักเป็น Maintenance → ติ๊กได้
   watch = งานที่ทีมผลิตทำ แต่เราเป็นผู้รับผิดชอบ 2 → แค่ตามผล ไม่ต้องติ๊ก           */
type Role = 'mt' | 'op' | 'qc' | 'pd';
type Node = {
  key: string; title: string; id?: number; machine: string | null; goal: string | null;
  ownerRole: Role | null; coOwnerRole: Role | null;
  checked: boolean; bypassed: boolean; doneImage?: string | null; hasDoneImage?: boolean;
};
type Person = {
  key: string; name: string; role: string; color?: string; wash?: string; initial?: string;
  nodes: Node[]; watch: Node[]; done: number; total: number; pct: number;
};
type Board = {
  date: string; maint: boolean; shiftName: string | null; people: Person[];
  team: { done: number; total: number; left: number; pct: number };
};

const ROLE: Record<Role, { label: string; c: string; w: string }> = {
  mt: { label: 'Maintenance', c: '#c24f00', w: '#fff3ea' },
  op: { label: 'Operate', c: '#0d47a1', w: '#e8f1fb' },
  qc: { label: 'QC', c: '#14653a', w: '#e6f4ec' },
  pd: { label: 'พนักงานผลิต', c: '#4b433c', w: '#f2ede8' },
};
const NO_MACHINE = 'งานเปิดกะ (ไม่ผูกเครื่องจักร)';
const MACHINE_IC: Record<string, string> = {
  'เครื่องยิงวันที่': '🖨', 'เครื่องชั่ง Mettler1/2/Ishida': '⚖️', 'เครื่องจับโละ 900g/25kg/ปี๊บ': '📦',
  'เครื่องชั่งเล็กประจำไลน์': '🧮', 'ตั้งไลน์สำหรับผลิต': '🧰', 'เครื่องปิดลัง': '📮',
  'เครื่องซีลแนวตั้ง': '🔥', 'เครน': '🏗', [NO_MACHINE]: '🗒',
};
const icOf = (m: string) => MACHINE_IC[m] || '🔩';

// จัดกลุ่มงานตามเครื่องจักร โดยคงลำดับเดิมของตาราง
const groupByMachine = (nodes: Node[]) => {
  const out: { name: string; rows: Node[] }[] = [];
  for (const n of nodes) {
    const name = n.machine || NO_MACHINE;
    const g = out.find(x => x.name === name);
    if (g) g.rows.push(n); else out.push({ name, rows: [n] });
  }
  return out;
};

// "พุธ 19 ส.ค. 2569" — th-TH ตรง ๆ จะได้ "วันพุธที่ …" ซึ่งยาวเกินไปสำหรับหัวเรื่อง
const WEEKDAY_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const thaiDate = (d: string) => {
  const dt = new Date(`${d}T12:00:00`);
  return `${WEEKDAY_TH[dt.getDay()]} ${dt.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

const RoleChip: React.FC<{ r: Role; sec?: boolean }> = ({ r, sec }) => {
  const m = ROLE[r];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700,
      fontFamily: 'Kanit, sans-serif', padding: '2px 9px', borderRadius: 999, whiteSpace: 'nowrap',
      color: m.c, background: sec ? 'transparent' : m.w, boxShadow: sec ? `inset 0 0 0 1px ${m.c}` : 'none',
      opacity: sec ? 0.62 : 1,
    }}>
      <i style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', opacity: 0.75 }} />
      {m.label}
    </span>
  );
};

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
  padding: '7px 12px', fontSize: 14, fontWeight: 600, color: 'var(--ink,#2b2119)', fontFamily: 'inherit',
};

const MaintenanceBoard: React.FC<{ operatorName: string | null }> = ({ operatorName }) => {
  const [date, setDate] = useState(todayBKK());
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'person' | 'machine'>('person');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');            // node key ที่กำลังอัปโหลดรูป
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/duty?kind=maint&date=${date}`);
      const d = await r.json();
      setBoard(d && Array.isArray(d.people) ? d : null);   // กัน shape ผิด (DB ล่ม → {error}) ไม่ให้จอขาว
    } catch { setBoard(null); } finally { setLoading(false); }
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const post = async (url: string, body: Record<string, unknown>) => {
    await fetch(`${apiUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await load();
  };
  const toggle = (pKey: string, n: Node) =>
    post('/api/routine/toggle', { date, assignee: pKey, nodeKey: n.key, title: n.title, checked: !n.checked });

  const attachPhoto = async (pKey: string, n: Node, file?: File) => {
    if (!file) return;
    setBusy(`${pKey}|${n.key}`);
    try {
      const url = await uploadDutyImage((await resizePhoto(file)).preview);
      await post('/api/routine/photo', { date, assignee: pKey, nodeKey: n.key, title: n.title, image: url, operator: operatorName, routineId: n.id });
    } catch { setMsg('❌ แนบรูปไม่สำเร็จ'); } finally { setBusy(''); }
  };

  const sendTelegram = async () => {
    setMsg('กำลังส่ง…');
    try {
      const r = await fetch(`${apiUrl}/api/duty/telegram`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, kind: 'maint' }),
      });
      const d = await r.json();
      setMsg(d.sent ? '✅ ส่งเข้า Telegram แล้ว' : '⚠️ ยังไม่ได้ตั้งค่า Telegram บนเซิร์ฟเวอร์');
    } catch { setMsg('❌ ส่งไม่สำเร็จ'); }
  };

  const team = board?.team;
  const people = board?.people || [];
  // แถบ "ตามผล" รวมของทุกคน (งานเดียวกันไม่ควรโผล่ซ้ำ)
  const watch = useMemo(() => {
    const seen = new Set<string>(); const out: Node[] = [];
    for (const p of people) for (const w of p.watch || []) if (!seen.has(w.key)) { seen.add(w.key); out.push(w); }
    return out;
  }, [people]);
  const allMine = useMemo(() => people.flatMap(p => p.nodes.map(n => ({ n, p }))), [people]);

  /* ── การ์ดงาน 1 บรรทัด (ใช้ทั้งมุมมองตามคนและตามเครื่องจักร) ── */
  const TaskRow: React.FC<{ p: Person; n: Node; showWho?: boolean }> = ({ p, n, showWho }) => {
    const gk = `${p.key}|${n.key}`;
    const fileRef = useRef<HTMLInputElement>(null);
    return (
      <div style={{
        display: 'flex', gap: 9, alignItems: 'flex-start', padding: '8px 9px', borderRadius: 10,
        background: n.checked ? 'transparent' : '#fffaf5',
      }}>
        <button onClick={() => toggle(p.key, n)} aria-label={n.checked ? 'เอาเครื่องหมายออก' : 'ติ๊กว่าทำแล้ว'}
          style={{
            width: 20, height: 20, flex: 'none', marginTop: 3, borderRadius: 6, cursor: 'pointer',
            border: `1.5px solid ${n.checked ? '#1c8a4c' : '#ddd0c3'}`, background: n.checked ? '#1c8a4c' : '#fff',
            color: '#fff', fontSize: 11, lineHeight: 1, display: 'grid', placeItems: 'center',
          }}>{n.checked ? '✓' : ''}</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13.5, fontWeight: 600, lineHeight: 1.45,
            color: n.checked ? '#a89e94' : 'var(--ink,#2b2119)', textDecoration: n.checked ? 'line-through' : 'none',
          }}>{n.title}</div>
          {n.goal && <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', lineHeight: 1.5 }}>🎯 {n.goal}</div>}
          {(showWho || n.coOwnerRole) && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
              {showWho && <span style={{ fontSize: 11, color: 'var(--ink-soft,#6d6259)' }}>👤 {p.name}</span>}
              {n.coOwnerRole && <RoleChip r={n.coOwnerRole} sec />}
            </div>
          )}
        </div>
        {n.doneImage && (
          <img src={n.doneImage} alt="รูปหลังทำ" onClick={() => setZoom(n.doneImage!)}
            style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in', flex: 'none' }} />
        )}
        <button onClick={() => fileRef.current?.click()} disabled={busy === gk} title="แนบรูปหลังทำ"
          style={{ ...btn, padding: '4px 9px', fontSize: 12, flex: 'none', opacity: busy === gk ? 0.5 : 1 }}>
          {busy === gk ? '⏳' : n.hasDoneImage || n.doneImage ? '🔁' : '📷'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => { attachPhoto(p.key, n, e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    );
  };

  const MachineHead: React.FC<{ name: string }> = ({ name }) => (
    <div style={{
      fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#c24f00',
      padding: '9px 8px 3px', display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {icOf(name)} {name}
      <i style={{ flex: 1, height: 1, background: '#f2e6da' }} />
    </div>
  );

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      {/* ── หัวเรื่อง ── */}
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#c24f00',
        background: '#fff3ea', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>🔧 งานซ่อมบำรุง</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          กระดานเวรวันนี้ — ทีมซ่อมบำรุง
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>
          {thaiDate(date)}{board?.shiftName ? ` · ${board.shiftName}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ ...inp, fontSize: 13, fontWeight: 500 }} />
      </div>

      <TeamCard board={board} reload={load} />

      {/* ── แถบเครื่องมือ ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '16px 0 14px' }}>
        <span style={{ display: 'inline-flex', background: '#f2ece6', borderRadius: 999, padding: 3, gap: 3 }}>
          {([['person', '👤 ตามคน'], ['machine', '🔩 ตามเครื่องจักร']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)} style={{
              border: 'none', borderRadius: 999, padding: '6px 15px', cursor: 'pointer',
              fontFamily: 'Kanit, sans-serif', fontSize: 12.5, fontWeight: 600,
              background: view === k ? '#fff' : 'transparent', color: view === k ? 'var(--ink,#2b2119)' : 'var(--ink-soft,#6d6259)',
              boxShadow: view === k ? '0 1px 3px rgba(63,37,10,.14)' : 'none',
            }}>{label}</button>
          ))}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={sendTelegram} style={btn}>📨 ส่งเข้า Telegram</button>
        <button onClick={load} style={btn}>{loading ? '⏳' : '🔄'} รีเฟรช</button>
      </div>
      {msg && <div style={{ fontSize: 12.5, color: 'var(--ink-soft,#6d6259)', marginBottom: 10 }}>{msg}</div>}

      {/* ── ความคืบหน้าทั้งทีม ── */}
      {team && (
        <div style={{ ...card, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', fontWeight: 600 }}>ทั้งทีมวันนี้</div>
            <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 26, fontWeight: 600, color: '#c24f00', lineHeight: 1 }}>
              {team.done}<span style={{ fontSize: 15, color: 'var(--ink-soft,#6d6259)' }}>/{team.total}</span>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 150, height: 9, borderRadius: 999, background: '#f2ece6', overflow: 'hidden' }}>
            <i style={{ display: 'block', height: '100%', width: `${team.pct}%`, borderRadius: 999, background: 'linear-gradient(90deg,#ff6b00,#ffa34d)' }} />
          </div>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontWeight: 600, fontSize: 15, color: '#c24f00' }}>{team.pct}%</div>
        </div>
      )}

      {!board && !loading && (
        <div style={{ ...card, padding: 20, textAlign: 'center', color: 'var(--ink-soft,#6d6259)', fontSize: 13 }}>
          โหลดกระดานไม่สำเร็จ — กด 🔄 รีเฟรชอีกครั้ง
        </div>
      )}

      {/* ── มุมมองตามคน ── */}
      {board && view === 'person' && (
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', alignItems: 'start' }}>
          {people.map(p => (
            <article key={p.key} style={{ ...card, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', borderBottom: '1px solid var(--line,#eee3d9)' }}>
                <span style={{
                  width: 38, height: 38, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none',
                  background: p.color || '#ff6b00', color: '#fff', fontFamily: 'Kanit, sans-serif', fontWeight: 600, fontSize: 16,
                }}>{p.initial || p.name.slice(0, 1)}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>{p.role}</div>
                </div>
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <b style={{ fontFamily: 'Kanit, sans-serif', fontSize: 18, fontWeight: 600 }}>{p.done}/{p.total}</b>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-soft,#6d6259)' }}>ทำแล้ว</span>
                </div>
              </div>
              <div style={{ padding: '8px 10px 12px' }}>
                {p.nodes.length === 0
                  ? <div style={{ fontSize: 12.5, color: '#a89e94', padding: '10px 8px', lineHeight: 1.6 }}>
                      ยังไม่มีงานประจำของคนนี้ — ตอนนี้งาน PM ทั้งหมดอยู่ที่หัวหน้าทีม
                      <br />(หน้าทะเบียนงานสำหรับย้ายงานให้สมาชิกจะมาในรอบถัดไป)
                    </div>
                  : groupByMachine(p.nodes).map(g => (
                    <div key={g.name}>
                      <MachineHead name={g.name} />
                      {g.rows.map(n => <TaskRow key={n.key} p={p} n={n} />)}
                    </div>
                  ))}
              </div>
            </article>
          ))}
        </div>
      )}

      {/* ── มุมมองตามเครื่องจักร ── */}
      {board && view === 'machine' && (
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', alignItems: 'start' }}>
          {groupByMachine(allMine.map(x => x.n)).map(g => {
            const rows = allMine.filter(x => (x.n.machine || NO_MACHINE) === g.name);
            const done = rows.filter(x => x.n.checked).length;
            const manyOwners = new Set(rows.map(x => x.p.key)).size > 1;
            return (
              <article key={g.name} style={{ ...card, padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <h3 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, margin: 0, minWidth: 0 }}>
                    {icOf(g.name)} {g.name}
                  </h3>
                  <span style={{ marginLeft: 'auto', fontFamily: 'Kanit, sans-serif', fontSize: 13, fontWeight: 600, color: '#c24f00' }}>
                    {done}/{rows.length}
                  </span>
                </div>
                {rows.map(({ n, p }) => <TaskRow key={`${p.key}|${n.key}`} p={p} n={n} showWho={manyOwners} />)}
              </article>
            );
          })}
        </div>
      )}

      {/* ── ทีมผลิตทำ เราแค่ตามผล ── */}
      {watch.length > 0 && (
        <div style={{ marginTop: 16, background: '#fbf7f3', border: '1px dashed #e6d8c9', borderRadius: 12, padding: '11px 13px' }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 12, fontWeight: 600, color: 'var(--ink-soft,#6d6259)', marginBottom: 7 }}>
            👀 ทีมผลิตทำ — เราแค่ตามผล ({watch.length} รายการ)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {watch.map(w => (
              <div key={w.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--ink-soft,#6d6259)' }}>
                <i style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', marginTop: 7, background: w.ownerRole ? ROLE[w.ownerRole].c : '#d8cec4' }} />
                <span>
                  <b style={{ color: 'var(--ink,#2b2119)', fontWeight: 600 }}>{w.title}</b>
                  {' · '}{w.machine || NO_MACHINE}
                  {w.ownerRole && <> — หลัก {ROLE[w.ownerRole].label}</>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {zoom && (
        <div onClick={() => setZoom(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20 }}>
          <img src={zoom} alt="ขยาย" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
};

/* ── การ์ดทีม: ชื่อกะ + สมาชิก (ตามหัวข้อ 4 ในโน้ต) ──
   สมาชิกใช้ /api/duty/person เดียวกับทีมกะ ต่างแค่ kind='maint'                  */
const TeamCard: React.FC<{ board: Board | null; reload: () => Promise<void> }> = ({ board, reload }) => {
  const [shift, setShift] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const saved = board?.shiftName || '';
  useEffect(() => { setShift(saved); }, [saved]);

  const people = board?.people || [];
  const saveShift = async () => {
    const v = shift.trim();
    if (!v || v === saved) return;
    setBusy(true);
    try {
      await fetch(`${apiUrl}/api/maint/team`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shiftName: v }) });
      await reload();
    } finally { setBusy(false); }
  };
  const addMate = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await fetch(`${apiUrl}/api/duty/person`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), role: newRole.trim() || 'ทีมซ่อมบำรุง', kind: 'maint' }),
      });
      setNewName(''); setNewRole(''); setAdding(false);
      await reload();
    } finally { setBusy(false); }
  };
  const delMate = async (p: Person) => {
    if (!window.confirm(`เอา "${p.name}" ออกจากทีมซ่อมบำรุง?`)) return;
    setBusy(true);
    try {
      await fetch(`${apiUrl}/api/duty/person/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: p.key }) });
      await reload();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, padding: '16px 18px' }}>
      <h3 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 16, fontWeight: 600, margin: 0 }}>👷 ทีมซ่อมบำรุง</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '12px 0 14px' }}>
        <label htmlFor="mt-shift" style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-soft,#6d6259)' }}>ชื่อกะ</label>
        <input id="mt-shift" value={shift} onChange={e => setShift(e.target.value)} onBlur={saveShift}
          onKeyDown={e => e.key === 'Enter' && saveShift()} placeholder="เช่น กะ 1" disabled={busy}
          style={{ ...inp, minWidth: 130 }} />
        <span style={{ fontSize: 12, color: 'var(--ink-soft,#6d6259)' }}>· สมาชิก <b>{people.length}</b> คน</span>
      </div>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))' }}>
        {people.map((p, i) => (
          <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 9, background: '#fdfbf9', border: '1px solid var(--line,#eee3d9)', borderRadius: 12, padding: '8px 10px' }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#fff3ea', color: '#c24f00', display: 'grid', placeItems: 'center', fontSize: 11.5, fontWeight: 700, flex: 'none' }}>{i + 1}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.role}>{p.name}</span>
            {i === 0 && <span style={{ fontSize: 10, fontWeight: 700, background: '#ff6b00', color: '#fff', borderRadius: 999, padding: '1px 7px', flex: 'none' }}>หัวหน้า</span>}
            <button onClick={() => delMate(p)} disabled={busy} title="เอาออกจากทีม"
              style={{ border: 'none', background: 'transparent', color: '#c0b6ac', fontSize: 14, cursor: 'pointer', flex: 'none' }}>✕</button>
          </div>
        ))}
        {!adding && (
          <button onClick={() => setAdding(true)} style={{
            border: '1px dashed var(--line,#eee3d9)', background: '#fdfbf9', color: 'var(--ink-soft,#6d6259)',
            borderRadius: 12, padding: '8px 10px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>＋ เพิ่มสมาชิก</button>
        )}
      </div>
      {adding && (
        <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
          <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="ชื่อ-นามสกุล"
            onKeyDown={e => e.key === 'Enter' && addMate()} style={{ ...inp, flex: 1, minWidth: 150, fontWeight: 500 }} />
          <input value={newRole} onChange={e => setNewRole(e.target.value)} placeholder="หน้าที่ (ไม่บังคับ)"
            onKeyDown={e => e.key === 'Enter' && addMate()} style={{ ...inp, flex: 1, minWidth: 150, fontWeight: 500 }} />
          <button onClick={addMate} disabled={busy || !newName.trim()} style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>เพิ่ม</button>
          <button onClick={() => { setAdding(false); setNewName(''); setNewRole(''); }} style={btn}>ยกเลิก</button>
        </div>
      )}
    </div>
  );
};

export default MaintenanceBoard;
