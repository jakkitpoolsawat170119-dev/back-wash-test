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
  checked: boolean; bypassed: boolean; bypassReason: string | null;
  handoffTo: string | null; handoffToName: string | null;
  doneImage?: string | null; hasDoneImage?: boolean;
};
// งานที่คนอื่นข้ามแล้วมอบต่อมาให้คนนี้ (โครงเดียวกับบอร์ดกะ)
type Received = { ownerKey: string; fromName: string; nodeKey: string; title: string; checked: boolean };
// งานมอบหมายเฉพาะกิจ (daily_tasks source='assigned') — งานแทรกระหว่างวัน ไม่ใช่งาน PM ประจำ
type Adhoc = {
  id: number; title: string; category: string; location: string | null; machine: string | null;
  dueTime: string | null; priority: string; status: string; handoffFrom: string | null;
  hasImages?: boolean; hasDoneImages?: boolean;
};
type Person = {
  key: string; name: string; role: string; color?: string; wash?: string; initial?: string;
  nodes: Node[]; watch: Node[]; received: Received[]; adhoc: Adhoc[]; done: number; total: number; pct: number;
};
/* ความถี่ของงานรูทีน — ต้องตรงกับหน้า "ทะเบียนงานรูทีน" (PmRegistry) และ routineDue() ฝั่งเซิร์ฟเวอร์ */
const FREQ: Record<string, string> = {
  daily: 'ทุกวัน', weekly: 'ทุกสัปดาห์', monthly: 'ทุกเดือน', quarterly: 'ทุก 3 เดือน',
  onuse: 'เมื่อใช้งานเครื่องนี้', onissue: 'เมื่อมีปัญหา',
};
const BYPASS_REASONS = ['ไม่มีการผลิต', 'เครื่องหยุด/ซ่อม', 'ทำล่วงหน้าแล้ว', 'ไม่ถึงรอบ', 'ให้คนอื่นทำแทน', 'อื่นๆ'];
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
const ADHOC_NO_MACHINE = 'งานมอบหมาย (ไม่ระบุเครื่อง)';
const MACHINE_IC: Record<string, string> = {
  'เครื่องยิงวันที่': '🖨', 'เครื่องชั่ง Mettler1/2/Ishida': '⚖️', 'เครื่องจับโละ 900g/25kg/ปี๊บ': '📦',
  'เครื่องชั่งเล็กประจำไลน์': '🧮', 'ตั้งไลน์สำหรับผลิต': '🧰', 'เครื่องปิดลัง': '📮',
  'เครื่องซีลแนวตั้ง': '🔥', 'เครน': '🏗', [NO_MACHINE]: '🗒', [ADHOC_NO_MACHINE]: '📌',
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
const menuItem: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent',
  color: 'var(--ink,#2b2119)', fontFamily: 'inherit', fontSize: 13, padding: '7px 8px',
  borderRadius: 8, cursor: 'pointer',
};

const MaintenanceBoard: React.FC<{ operatorName: string | null }> = ({ operatorName }) => {
  const [date, setDate] = useState(todayBKK());
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'person' | 'machine'>('person');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');            // node key ที่กำลังอัปโหลดรูป
  const [zoom, setZoom] = useState<string | null>(null);
  const [menu, setMenu] = useState('');            // "personKey|nodeKey" ที่กางเมนู ⋯ อยู่
  // ลากได้ทั้งงานประจำ (มอบต่อเฉพาะวันนั้น) และงานมอบหมาย (ย้ายเจ้าของถาวร)
  type DragItem = { kind: 'node'; n: Node } | { kind: 'adhoc'; t: Adhoc };
  const [drag, setDrag] = useState<{ from: string; item: DragItem; title: string; x: number; y: number; over: string } | null>(null);
  const [machines, setMachines] = useState<string[]>([]);   // ทะเบียนเครื่องจักร — ใช้ในฟอร์มมอบงาน
  // รูปของงานมอบหมายโหลดตอนกดดู (ลด egress ของ DB) — เก็บต่อ task id
  const [taskImgs, setTaskImgs] = useState<Record<number, { images: string[]; doneImages: string[] } | 'loading'>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/duty?kind=maint&date=${date}`);
      const d = await r.json();
      setBoard(d && Array.isArray(d.people) ? d : null);   // กัน shape ผิด (DB ล่ม → {error}) ไม่ให้จอขาว
    } catch { setBoard(null); } finally { setLoading(false); }
  }, [date]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setTaskImgs({}); }, [date]);           // เปลี่ยนวัน = รูปเก่าคนละงาน
  useEffect(() => {
    fetch(`${apiUrl}/api/machines`).then(r => r.json())
      .then(d => setMachines(Array.isArray(d?.machines) ? d.machines.map((m: { name: string }) => m.name) : []))
      .catch(() => setMachines([]));
  }, []);

  const loadTaskImgs = async (id: number) => {
    if (taskImgs[id]) return;
    setTaskImgs(prev => ({ ...prev, [id]: 'loading' }));
    try {
      const d = await fetch(`${apiUrl}/api/tasks/images?id=${id}`).then(r => r.json());
      setTaskImgs(prev => ({ ...prev, [id]: { images: d.images || [], doneImages: d.doneImages || [] } }));
    } catch { setTaskImgs(prev => { const n = { ...prev }; delete n[id]; return n; }); }
  };

  const post = async (url: string, body: Record<string, unknown>) => {
    await fetch(`${apiUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await load();
  };
  const toggle = (pKey: string, n: Node) =>
    post('/api/routine/toggle', { date, assignee: pKey, nodeKey: n.key, title: n.title, checked: !n.checked });

  // ลากงาน → วางบนการ์ดคนอื่น
  //   งานประจำ = ข้ามงานพร้อมมอบต่อเฉพาะวันนั้น (เส้นทางเดียวกับเมนู ⋯ ให้คนอื่นทำแทน)
  //   งานมอบหมาย = ย้ายเจ้าของถาวร (/api/tasks/reassign — เส้นเดียวกับบอร์ดกะ)
  // ใช้ elementFromPoint หาการ์ดใต้นิ้ว เพราะเงาที่ลากอยู่ไม่รับ event (pointerEvents: none)
  const startDrag = (e: React.PointerEvent, from: string, item: DragItem) => {
    if (people.length < 2) return;
    e.preventDefault();
    const hit = (x: number, y: number) =>
      (document.elementFromPoint(x, y)?.closest('[data-person]') as HTMLElement | null)?.dataset.person || '';
    const title = item.kind === 'node' ? item.n.title : item.t.title;
    setDrag({ from, item, title, x: e.clientX, y: e.clientY, over: '' });
    const move = (ev: PointerEvent) =>
      setDrag(d => (d ? { ...d, x: ev.clientX, y: ev.clientY, over: hit(ev.clientX, ev.clientY) } : d));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const to = hit(ev.clientX, ev.clientY);
      setDrag(null);
      if (!to || to === from) return;
      if (item.kind === 'node') doBypass(from, item.n, 'ให้คนอื่นทำแทน', to);
      else reassign(item.t, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const dragging = (from: string, item: DragItem) =>
    !!drag && drag.from === from
    && (drag.item.kind === 'node' && item.kind === 'node' ? drag.item.n.key === item.n.key
      : drag.item.kind === 'adhoc' && item.kind === 'adhoc' ? drag.item.t.id === item.t.id : false);

  /* ── งานมอบหมายเฉพาะกิจ: ติ๊ก / ลบ / ย้ายเจ้าของ (ใช้เส้น /api/tasks เดิมทั้งหมด) ── */
  const toggleAdhoc = (t: Adhoc) => post('/api/tasks/update', { id: t.id, status: t.status === 'done' ? 'pending' : 'done', doneBy: operatorName || undefined });
  const delAdhoc = (t: Adhoc) => {
    if (!window.confirm(`ลบงาน "${t.title}" ทิ้ง?`)) return;
    return post('/api/tasks/delete-one', { id: t.id });
  };
  const reassign = async (t: Adhoc, to: string) => {
    try {
      const r = await fetch(`${apiUrl}/api/tasks/reassign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id, assignTo: to, operator: operatorName }),
      });
      if (!r.ok) { const d = await r.json().catch(() => null); setMsg(`⚠️ ${d?.message || 'ย้ายงานไม่สำเร็จ'}`); return; }
      await load();
    } catch { setMsg('❌ ย้ายงานไม่สำเร็จ — เช็คเน็ต'); }
  };

  /* ย้ายเจ้าของงานรูทีน "ถาวร" — คนละเรื่องกับ doBypass(...handoffTo) ที่มอบต่อเฉพาะวันนั้น
     ⚠️ ประวัติติ๊กของวันก่อน ๆ ไม่ตามไปด้วย (routine_state อ้าง วันที่ · คน · node_key) — ตั้งใจ
        ประวัติคือ "ใครทำวันนั้น" ซึ่งก็คือคนเดิมจริง ๆ · เซิร์ฟเวอร์ตอบ 409 ถ้าปลายทางมี node_key นี้อยู่แล้ว */
  const moveOwner = async (p: Person, n: Node, to: Person) => {
    setMenu('');
    if (!n.id) { setMsg('⚠️ งานนี้ไม่มีรหัสในทะเบียน — ย้ายเจ้าของไม่ได้'); return; }
    if (!window.confirm(
      `ย้าย “${n.title}” ให้ ${to.name} ถาวร?\n\n`
      + `ตั้งแต่พรุ่งนี้งานนี้จะขึ้นบนการ์ดของ ${to.name} แทน ${p.name}\n`
      + `ประวัติการติ๊กของวันก่อน ๆ ยังอยู่กับ ${p.name} ตามเดิม`)) return;
    try {
      const r = await fetch(`${apiUrl}/api/duty/routine`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: n.id, assigneeKey: to.key, title: n.title }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) { setMsg(`⚠️ ${d?.error || 'ย้ายเจ้าของไม่สำเร็จ'}`); return; }
      setMsg(`✅ ย้าย “${n.title}” ให้ ${to.name} ถาวรแล้ว`);
      await load();
    } catch { setMsg('❌ ย้ายเจ้าของไม่สำเร็จ — เช็คเน็ต'); }
  };

  const doBypass = (pKey: string, n: Node, reason: string, handoffTo?: string) => {
    setMenu('');
    return post('/api/routine/bypass', { date, assignee: pKey, nodeKey: n.key, title: n.title, reason, handoffTo });
  };
  const restore = (pKey: string, n: Node) => { setMenu(''); return post('/api/routine/restore', { date, assignee: pKey, nodeKey: n.key }); };
  const toggleReceived = (r: Received) => post('/api/routine/toggle', { date, assignee: r.ownerKey, nodeKey: r.nodeKey, checked: !r.checked });

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
        body: JSON.stringify({ date, kind: 'maint', by: operatorName || undefined }),
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
  const allAdhoc = useMemo(() => people.flatMap(p => (p.adhoc || []).map(t => ({ t, p }))), [people]);
  const adhocLeft = allAdhoc.filter(x => x.t.status !== 'done').length;

  /* ── การ์ดงาน 1 บรรทัด (ใช้ทั้งมุมมองตามคนและตามเครื่องจักร) ── */
  const TaskRow: React.FC<{ p: Person; n: Node; showWho?: boolean }> = ({ p, n, showWho }) => {
    const gk = `${p.key}|${n.key}`;
    const fileRef = useRef<HTMLInputElement>(null);
    const others = people.filter(x => x.key !== p.key);

    // งานที่ถูกข้าม/มอบต่อ — แสดงเป็นแถบจาง ๆ พร้อมเหตุผล กดเอากลับมาได้
    if (n.bypassed) return (
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '8px 9px', borderRadius: 10, background: '#f7f3ef' }}>
        <span style={{ width: 20, flex: 'none', marginTop: 2, textAlign: 'center', color: '#b6ada4' }}>↷</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#a89e94' }}>{n.title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
            {n.handoffToName ? `ให้ ${n.handoffToName} ทำแทน` : `ข้าม — ${n.bypassReason || 'ไม่ระบุเหตุผล'}`}
          </div>
        </div>
        <button onClick={() => restore(p.key, n)} style={{ ...btn, padding: '4px 9px', fontSize: 12, flex: 'none' }}>เอากลับมา</button>
      </div>
    );

    return (
      <div data-nodekey={n.key} style={{
        display: 'flex', gap: 9, alignItems: 'flex-start', padding: '8px 9px', borderRadius: 10,
        background: n.checked ? 'transparent' : '#fffaf5',
        opacity: dragging(p.key, { kind: 'node', n }) ? 0.4 : 1,
      }}>
        {others.length > 0 && (
          <span onPointerDown={e => startDrag(e, p.key, { kind: 'node', n })} title="ลากไปวางที่การ์ดของคนอื่นเพื่อมอบงานต่อ"
            style={{ flex: 'none', marginTop: 3, color: '#cfc4b8', fontSize: 13, cursor: 'grab', touchAction: 'none', userSelect: 'none' }}>⠿</span>
        )}
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
        <div style={{ position: 'relative', flex: 'none' }}>
          <button onClick={() => setMenu(menu === gk ? '' : gk)} title="ข้ามงาน / มอบต่อ"
            style={{ ...btn, padding: '4px 9px', fontSize: 12 }}>⋯</button>
          {menu === gk && (
            <div style={{
              position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 20, minWidth: 200,
              maxHeight: '68vh', overflowY: 'auto',   // เมนูยาวกว่าจอได้ตอนทีมมีหลายคน
              background: '#fff', border: '1px solid var(--line,#eee3d9)', borderRadius: 12, padding: 6,
              boxShadow: '0 2px 4px rgba(63,37,10,.08),0 16px 40px -12px rgba(63,37,10,.22)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-soft,#6d6259)', padding: '4px 8px' }}>ข้ามงานนี้ เพราะ…</div>
              {BYPASS_REASONS.filter(r => r !== 'ให้คนอื่นทำแทน').map(r => (
                <button key={r} onClick={() => doBypass(p.key, n, r)} style={menuItem}>{r}</button>
              ))}
              {others.length > 0 && <>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-soft,#6d6259)', padding: '8px 8px 4px', borderTop: '1px dashed #efe6dc', marginTop: 4 }}>
                  ให้คนอื่นทำแทน <span style={{ fontWeight: 500 }}>— เฉพาะวันนี้</span>
                </div>
                {others.map(o => (
                  <button key={o.key} onClick={() => doBypass(p.key, n, 'ให้คนอื่นทำแทน', o.key)} style={menuItem}>👤 {o.name}</button>
                ))}
                {/* คนละความหมายกับข้างบน — ห้ามปนกัน: อันบนคืนเจ้าของเดิมพรุ่งนี้ อันนี้ไม่คืน */}
                <div style={{ fontSize: 11, fontWeight: 700, color: '#c24f00', padding: '8px 8px 4px', borderTop: '1px dashed #efe6dc', marginTop: 4 }}>
                  ย้ายเจ้าของ <span style={{ fontWeight: 500 }}>— ถาวร</span>
                </div>
                {others.map(o => (
                  <button key={o.key} onClick={() => moveOwner(p, n, o)} style={{ ...menuItem, color: '#c24f00' }}>➡️ {o.name}</button>
                ))}
                <div style={{ fontSize: 10.5, color: '#a89e94', padding: '2px 8px 4px', lineHeight: 1.5 }}>
                  ย้ายแล้วงานนี้ขึ้นการ์ดของเขาทุกวัน · ประวัติติ๊กเก่ายังอยู่กับ {p.name}
                </div>
              </>}
            </div>
          )}
        </div>
      </div>
    );
  };

  /* ── งานมอบหมายเฉพาะกิจ 1 บรรทัด — งานแทรกระหว่างวัน (ไม่ใช่ PM ประจำ) ──
     ด่วน = ขีดแดงซ้าย · รูปโหลดตอนกดดู · ลากไปการ์ดคนอื่น = ย้ายเจ้าของถาวร        */
  const AdhocRow: React.FC<{ p: Person; t: Adhoc; showWho?: boolean; showMachine?: boolean }> = ({ p, t, showWho, showMachine }) => {
    const done = t.status === 'done';
    const urgent = t.priority === 'urgent' && !done;
    const others = people.filter(x => x.key !== p.key);
    const im = taskImgs[t.id];
    const meta = [
      showMachine && t.machine ? `📌 ${t.machine}` : '',
      t.location ? `📍 ${t.location}` : '',
      t.dueTime ? `⏰ ${t.dueTime} น.` : '',
      showWho ? `👤 ${p.name}` : '',
      t.handoffFrom ? `↩ จาก ${people.find(x => x.key === t.handoffFrom)?.name || t.handoffFrom}` : '',
    ].filter(Boolean).join('  ·  ');

    return (
      <div style={{
        borderRadius: 10, marginBottom: 2, opacity: dragging(p.key, { kind: 'adhoc', t }) ? 0.4 : 1,
        background: done ? 'transparent' : urgent ? '#fff5f2' : '#fffaf5',
        boxShadow: urgent ? 'inset 3px 0 0 #d93025' : 'none',
      }}>
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '8px 9px' }}>
          {others.length > 0 && (
            <span onPointerDown={e => startDrag(e, p.key, { kind: 'adhoc', t })} title="ลากไปวางที่การ์ดของคนอื่นเพื่อย้ายงานให้เขา"
              style={{ flex: 'none', marginTop: 3, color: '#cfc4b8', fontSize: 13, cursor: 'grab', touchAction: 'none', userSelect: 'none' }}>⠿</span>
          )}
          <button onClick={() => toggleAdhoc(t)} aria-label={done ? 'เอาเครื่องหมายออก' : 'ติ๊กว่าทำแล้ว'}
            style={{
              width: 20, height: 20, flex: 'none', marginTop: 3, borderRadius: 6, cursor: 'pointer',
              border: `1.5px solid ${done ? '#1c8a4c' : urgent ? '#e6a79c' : '#ddd0c3'}`, background: done ? '#1c8a4c' : '#fff',
              color: '#fff', fontSize: 11, lineHeight: 1, display: 'grid', placeItems: 'center',
            }}>{done ? '✓' : ''}</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13.5, fontWeight: 600, lineHeight: 1.45,
              color: done ? '#a89e94' : 'var(--ink,#2b2119)', textDecoration: done ? 'line-through' : 'none',
            }}>
              {urgent && <span style={{ fontSize: 11, fontWeight: 700, color: '#c62828', background: '#ffe9e5', borderRadius: 999, padding: '1px 7px', marginRight: 6 }}>🔴 ด่วน</span>}
              {t.title}
            </div>
            {meta && <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', lineHeight: 1.5 }}>{meta}</div>}
          </div>
          {(t.hasImages || t.hasDoneImages) && !im && (
            <button onClick={() => loadTaskImgs(t.id)} title="ดูรูปของงานนี้"
              style={{ ...btn, padding: '4px 9px', fontSize: 12, flex: 'none' }}>🖼</button>
          )}
          {im === 'loading' && <span style={{ fontSize: 12, color: '#a89e94', flex: 'none', marginTop: 5 }}>⏳</span>}
          <button onClick={() => delAdhoc(t)} title="ลบงานนี้"
            style={{ ...btn, padding: '4px 9px', fontSize: 12, flex: 'none', color: '#c0b6ac' }}>✕</button>
        </div>
        {typeof im === 'object' && (im.images.length > 0 || im.doneImages.length > 0) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 9px 9px 38px' }}>
            {im.images.map(src => (
              <img key={src} src={src} alt="รูปงาน" onClick={() => setZoom(src)}
                style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in', border: '1px solid var(--line,#eee3d9)' }} />
            ))}
            {im.doneImages.map(src => (
              <img key={src} src={src} alt="รูปหลังทำ" onClick={() => setZoom(src)} title="หลังทำ"
                style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in', border: '2px solid #1c8a4c' }} />
            ))}
          </div>
        )}
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
          {allAdhoc.length > 0 && (
            <div style={{
              fontSize: 12, fontWeight: 600, color: adhocLeft ? '#b3261e' : '#1c8a4c',
              background: adhocLeft ? '#fdece9' : '#e8f5ee', borderRadius: 999, padding: '4px 11px',
            }}>🛠 งานมอบหมาย {adhocLeft ? `${adhocLeft} ค้าง` : 'เสร็จครบ'} <span style={{ color: 'var(--ink-soft,#6d6259)', fontWeight: 500 }}>/ {allAdhoc.length}</span></div>
          )}
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
            <article key={p.key} data-person={p.key} style={{
              // ⚠️ ห้ามใส่ overflow:'hidden' — เมนู ⋯ ของแถวล่าง ๆ จะโดนตัดหายไปนอกการ์ด
              //    (เมนูยาวขึ้นมากตอนเพิ่มหัวข้อ "ย้ายเจ้าของ — ถาวร" · วัดแล้วล้นออกไป ~450px)
              ...card,
              outline: drag && drag.over === p.key && drag.from !== p.key ? '2px solid #ff6b00' : 'none',
              outlineOffset: 2,
            }}>
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
                {/* งานมอบหมายเฉพาะกิจมาก่อนงาน PM — งานแทรกมักด่วนกว่างานประจำ */}
                {(p.adhoc || []).length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{
                      fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#b3261e',
                      padding: '9px 8px 3px', display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      🛠 งานมอบหมายวันนี้
                      <span style={{ fontWeight: 500, color: 'var(--ink-soft,#6d6259)' }}>
                        ค้าง {p.adhoc.filter(t => t.status !== 'done').length} จาก {p.adhoc.length}
                      </span>
                      <i style={{ flex: 1, height: 1, background: '#f7e2dd' }} />
                    </div>
                    {[...p.adhoc].sort((a, b) =>
                      (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
                      || (b.priority === 'urgent' ? 1 : 0) - (a.priority === 'urgent' ? 1 : 0),
                    ).map(t => <AdhocRow key={t.id} p={p} t={t} showMachine />)}
                  </div>
                )}
                {p.nodes.length === 0
                  ? (p.adhoc || []).length === 0 && (
                      <div style={{ fontSize: 12.5, color: '#a89e94', padding: '10px 8px', lineHeight: 1.6 }}>
                        ยังไม่มีงานของคนนี้วันนี้
                        <br />กด <b>＋ เพิ่มงานรูทีน</b> ด้านล่าง หรือย้ายงานจากการ์ดคนอื่นด้วยเมนู ⋯ → <b>ย้ายเจ้าของ — ถาวร</b>
                      </div>
                    )
                  : groupByMachine(p.nodes).map(g => (
                    <div key={g.name}>
                      <MachineHead name={g.name} />
                      {g.rows.map(n => <TaskRow key={n.key} p={p} n={n} />)}
                    </div>
                  ))}
                {p.received.length > 0 && (
                  <div style={{ marginTop: 6, borderTop: '1px dashed #efe6dc', paddingTop: 4 }}>
                    <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#0d47a1', padding: '6px 8px 2px' }}>
                      📥 รับมาทำแทน
                    </div>
                    {p.received.map(r => (
                      <div key={`${r.ownerKey}|${r.nodeKey}`} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '8px 9px', borderRadius: 10, background: '#f4f8fd' }}>
                        <button onClick={() => toggleReceived(r)} aria-label={r.checked ? 'เอาเครื่องหมายออก' : 'ติ๊กว่าทำแล้ว'}
                          style={{
                            width: 20, height: 20, flex: 'none', marginTop: 3, borderRadius: 6, cursor: 'pointer',
                            border: `1.5px solid ${r.checked ? '#1c8a4c' : '#c3cddd'}`, background: r.checked ? '#1c8a4c' : '#fff',
                            color: '#fff', fontSize: 11, lineHeight: 1, display: 'grid', placeItems: 'center',
                          }}>{r.checked ? '✓' : ''}</button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: r.checked ? '#a89e94' : 'var(--ink,#2b2119)', textDecoration: r.checked ? 'line-through' : 'none' }}>{r.title}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>จาก {r.fromName}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <AddRoutine person={p} machines={machines} reload={load} onMsg={setMsg} />
              </div>
            </article>
          ))}
        </div>
      )}

      {/* ── มุมมองตามเครื่องจักร ── */}
      {board && view === 'machine' && (
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', alignItems: 'start' }}>
          {/* ชื่อกลุ่ม = เครื่องจากงานประจำ (คงลำดับตาราง) + เครื่องที่มีแต่งานมอบหมาย ต่อท้าย */}
          {(() => {
            const names = groupByMachine(allMine.map(x => x.n)).map(g => g.name);
            const adhocName = (t: Adhoc) => t.machine || ADHOC_NO_MACHINE;
            for (const { t } of allAdhoc) if (!names.includes(adhocName(t))) names.push(adhocName(t));
            return names;
          })().map(name => {
            const rows = allMine.filter(x => (x.n.machine || NO_MACHINE) === name);
            const tasks = allAdhoc.filter(x => (x.t.machine || ADHOC_NO_MACHINE) === name);
            const done = rows.filter(x => x.n.checked).length + tasks.filter(x => x.t.status === 'done').length;
            const manyOwners = new Set([...rows.map(x => x.p.key), ...tasks.map(x => x.p.key)]).size > 1;
            return (
              <article key={name} style={{ ...card, padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <h3 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, margin: 0, minWidth: 0 }}>
                    {icOf(name)} {name}
                  </h3>
                  <span style={{ marginLeft: 'auto', fontFamily: 'Kanit, sans-serif', fontSize: 13, fontWeight: 600, color: '#c24f00' }}>
                    {done}/{rows.length + tasks.length}
                  </span>
                </div>
                {tasks.map(({ t, p }) => <AdhocRow key={t.id} p={p} t={t} showWho={manyOwners} />)}
                {rows.map(({ n, p }) => <TaskRow key={`${p.key}|${n.key}`} p={p} n={n} showWho={manyOwners} />)}
              </article>
            );
          })}
        </div>
      )}

      {/* ── มอบงานเฉพาะกิจให้คนในทีม ── */}
      {board && people.length > 0 && (
        <AssignForm date={date} people={people} machines={machines} operatorName={operatorName}
          reload={load} onMsg={setMsg} />
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

      {drag && (
        <div style={{
          position: 'fixed', left: drag.x, top: drag.y, transform: 'translate(-50%, -140%)',
          zIndex: 1200, pointerEvents: 'none', maxWidth: 260, background: '#2b2119', color: '#fff',
          borderRadius: 10, padding: '7px 12px', fontSize: 13, fontWeight: 600,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{drag.over && drag.over !== drag.from ? '📥 ' : '✊ '}{drag.title}</div>
      )}

      {zoom && (
        <div onClick={() => setZoom(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20 }}>
          <img src={zoom} alt="ขยาย" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
};

/* ── ＋ เพิ่มงานรูทีนให้ "คนใบนี้" ────────────────────────────────────────────
   เดิมเพิ่มงานรูทีนได้ที่หน้าทะเบียนอย่างเดียว แล้วต้องเลือกคนจาก dropdown อีกที
   ปุ่มนี้อยู่บนการ์ดของใครก็ส่ง personKey ของคนนั้นไปเลย — `POST /api/duty/routine` รับอยู่แล้ว
   ⚠️ ต้องประกาศระดับบนสุด ไม่ใช่ซ้อนในตัวแม่ — ไม่งั้น setMsg/reload จะ unmount ฟอร์ม
      แล้วสิ่งที่พิมพ์ค้างไว้หายทั้งใบ (บทเรียนเดียวกับบั๊ก IncidentForm)                */
const AddRoutine: React.FC<{
  person: Person; machines: string[]; reload: () => Promise<void>; onMsg: (s: string) => void;
}> = ({ person, machines, reload, onMsg }) => {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [machine, setMachine] = useState('');
  const [freq, setFreq] = useState('daily');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/duty/routine`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // ownerRole='mt' เสมอ — งานที่เพิ่มจากกระดานช่างคืองานที่ช่างต้องติ๊กเอง
        body: JSON.stringify({ personKey: person.key, title: title.trim(), machine: machine.trim() || null, freq, ownerRole: 'mt' }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) { onMsg(`❌ ${d?.error || 'เพิ่มงานไม่สำเร็จ'}`); return; }
      setTitle(''); setOpen(false);
      onMsg(`✅ เพิ่ม “${title.trim()}” ให้ ${person.name} แล้ว`);
      await reload();
    } catch { onMsg('❌ เพิ่มงานไม่สำเร็จ — เช็คเน็ต'); } finally { setBusy(false); }
  };

  if (!open) return (
    <button onClick={() => setOpen(true)} style={{
      width: '100%', marginTop: 8, border: '1px dashed var(--line,#eee3d9)', background: '#fdfbf9',
      color: '#c24f00', borderRadius: 10, padding: '8px 10px', fontFamily: 'Kanit, sans-serif',
      fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    }}>＋ เพิ่มงานรูทีนให้ {person.name}</button>
  );

  return (
    <div style={{ marginTop: 8, border: '1px solid var(--line,#eee3d9)', background: '#fdfbf9', borderRadius: 12, padding: 10 }}>
      <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 12, fontWeight: 600, color: '#c24f00', marginBottom: 7 }}>
        ＋ งานรูทีนใหม่ของ {person.name}
      </div>
      {/* เครื่องจักรมาก่อนชื่องาน — เลือกเครื่องแล้วค่อยนึกว่าจะทำอะไรกับมัน (user เคาะ 28 ส.ค.)
          ใช้ input+datalist ไม่ใช่ select: เครื่องที่ยังไม่มีในทะเบียนก็พิมพ์เองได้เลย
          ⚠️ ชื่อต้องสะกดตรงกับทะเบียน ไม่งั้นกลุ่มบนกระดาน/ในบอทจะแตกเป็นคนละก้อน */}
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--ink-soft,#6d6259)', marginBottom: 3 }}>เครื่องจักร</label>
      <input list={`rt-mc-${person.key}`} autoFocus value={machine} onChange={e => setMachine(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()} placeholder="เลือกจากรายการ หรือพิมพ์เอง (เว้นว่าง = ไม่ผูกเครื่อง)"
        style={{ ...inp, width: '100%', boxSizing: 'border-box', fontSize: 13, fontWeight: 500, marginBottom: 7 }} />
      <datalist id={`rt-mc-${person.key}`}>{machines.map(m => <option key={m} value={m} />)}</datalist>

      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--ink-soft,#6d6259)', marginBottom: 3 }}>รายการที่ต้องทำ</label>
      <input value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()} placeholder="เช่น ตรวจระดับน้ำมันเครน"
        style={{ ...inp, width: '100%', boxSizing: 'border-box', fontSize: 13, fontWeight: 500, marginBottom: 7 }} />

      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--ink-soft,#6d6259)', marginBottom: 3 }}>ความถี่ (ถึงคิวเมื่อไหร่)</label>
      <select value={freq} onChange={e => setFreq(e.target.value)}
        style={{ ...inp, fontSize: 12.5, fontWeight: 500 }}>
        {Object.keys(FREQ).map(k => <option key={k} value={k}>{FREQ[k]}</option>)}
      </select>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button onClick={submit} disabled={busy || !title.trim()} style={{
          ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff', opacity: busy || !title.trim() ? 0.5 : 1,
        }}>{busy ? 'กำลังบันทึก…' : 'เพิ่มงาน'}</button>
        <button onClick={() => { setOpen(false); setTitle(''); }} style={btn}>ยกเลิก</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-soft,#6d6259)', marginTop: 7, lineHeight: 1.5 }}>
        เข้าทะเบียนงานรูทีนถาวร (ไม่ใช่งานเฉพาะวันนี้) · แก้/ลบทีหลังได้ที่หน้า “ทะเบียนงานรูทีน”
      </div>
    </div>
  );
};

/* ── มอบงานเฉพาะกิจ — งานแทรกระหว่างวันที่ไม่ได้อยู่ในทะเบียน PM ──
   ใช้ POST /api/duty/assign เส้นเดียวกับบอร์ดกะ (เก็บลง daily_tasks source='assigned'
   + ยิงแจ้งเข้า Telegram ให้อัตโนมัติ) ต่างแค่หมวดตั้งเป็น maintenance และเลือกเครื่องจักรได้  */
const AssignForm: React.FC<{
  date: string; people: Person[]; machines: string[]; operatorName: string | null;
  reload: () => Promise<void>; onMsg: (s: string) => void;
}> = ({ date, people, machines, operatorName, reload, onMsg }) => {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [who, setWho] = useState<string[]>([]);
  const [machine, setMachine] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [workDate, setWorkDate] = useState(date);
  const [dueTime, setDueTime] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setWorkDate(date); }, [date]);
  // ค่าเริ่มต้น = คนแรกในทีม (หัวหน้า) — เปิดฟอร์มแล้วกดส่งได้เลยโดยไม่ต้องเลือกคน
  useEffect(() => { setWho(w => (w.length || !people.length ? w : [people[0].key])); }, [people]);

  const toggleWho = (k: string) => setWho(w => (w.includes(k) ? w.filter(x => x !== k) : [...w, k]));
  const addPhotos = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      const urls: string[] = [];
      for (const f of Array.from(files).slice(0, 4 - images.length)) {
        urls.push(await uploadDutyImage((await resizePhoto(f)).preview));
      }
      setImages(prev => [...prev, ...urls].slice(0, 4));
    } catch { onMsg('❌ แนบรูปไม่สำเร็จ'); } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!title.trim() || !who.length) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/duty/assign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date, workDate, title: title.trim(), assignees: who, category: 'maintenance',
          machine: machine || null, priority: urgent ? 'urgent' : 'normal',
          dueTime: dueTime || null, images, operator: operatorName,
        }),
      });
      const d = await r.json();
      if (!r.ok) { onMsg(`❌ ${d.error || 'มอบงานไม่สำเร็จ'}`); return; }
      setTitle(''); setMachine(''); setUrgent(false); setDueTime(''); setImages([]);
      onMsg(workDate === date ? '✅ มอบงานแล้ว' : `✅ มอบงานแล้ว — งานไปอยู่ในกระดานวันที่ ${workDate}`);
      await reload();
    } catch { onMsg('❌ มอบงานไม่สำเร็จ — เช็คเน็ต'); } finally { setBusy(false); }
  };

  if (!open) return (
    <button onClick={() => setOpen(true)} style={{
      ...card, marginTop: 16, width: '100%', padding: '13px 16px', textAlign: 'left', cursor: 'pointer',
      fontFamily: 'Kanit, sans-serif', fontSize: 14, fontWeight: 600, color: '#c24f00',
    }}>＋ มอบงานเฉพาะกิจให้คนในทีม</button>
  );

  return (
    <div style={{ ...card, marginTop: 16, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h3 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 16, fontWeight: 600, margin: 0 }}>🛠 มอบงานเฉพาะกิจ</h3>
        <span style={{ flex: 1 }} />
        <button onClick={() => setOpen(false)} style={btn}>ปิด</button>
      </div>

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 10 }}>
        {people.map(p => {
          const on = who.includes(p.key);
          return (
            <button key={p.key} onClick={() => toggleWho(p.key)} style={{
              ...btn, background: on ? '#ff6b00' : '#fff', borderColor: on ? '#ff6b00' : 'var(--line,#eee3d9)',
              color: on ? '#fff' : 'var(--ink-soft,#6d6259)',
            }}>{on ? '✓ ' : ''}{p.name}</button>
          );
        })}
      </div>

      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="งานที่ต้องทำ เช่น เปลี่ยนสายพานเครื่องปิดลัง"
        onKeyDown={e => e.key === 'Enter' && submit()} style={{ ...inp, width: '100%', boxSizing: 'border-box', fontWeight: 500, marginBottom: 8 }} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <select value={machine} onChange={e => setMachine(e.target.value)} style={{ ...inp, fontWeight: 500, minWidth: 190 }}>
          <option value="">— เครื่องจักร (ไม่บังคับ) —</option>
          {machines.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input type="date" value={workDate} onChange={e => setWorkDate(e.target.value)} title="วันที่ต้องทำ"
          style={{ ...inp, fontSize: 13, fontWeight: 500 }} />
        <input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} title="เวลากำหนด (ไม่บังคับ)"
          style={{ ...inp, fontSize: 13, fontWeight: 500 }} />
        <button onClick={() => setUrgent(v => !v)} style={{
          ...btn, background: urgent ? '#c62828' : '#fff', borderColor: urgent ? '#c62828' : 'var(--line,#eee3d9)',
          color: urgent ? '#fff' : 'var(--ink-soft,#6d6259)',
        }}>🔴 ด่วน</button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {images.map(u => (
          <span key={u} style={{ position: 'relative', lineHeight: 0 }}>
            <img src={u} alt="รูปงาน" style={{ width: 46, height: 46, objectFit: 'cover', borderRadius: 9, border: '1px solid var(--line,#eee3d9)' }} />
            <button onClick={() => setImages(prev => prev.filter(x => x !== u))} aria-label="เอารูปออก"
              style={{ position: 'absolute', top: -6, right: -6, width: 19, height: 19, borderRadius: '50%', border: 'none', background: '#c62828', color: '#fff', fontSize: 11, lineHeight: 1, cursor: 'pointer' }}>×</button>
          </span>
        ))}
        {images.length < 4 && (
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            style={{ width: 46, height: 46, borderRadius: 9, border: '1px dashed var(--line,#eee3d9)', background: '#fdfbf9', color: 'var(--ink-soft,#6d6259)', fontSize: 16, cursor: 'pointer' }}>
            {busy ? '⏳' : '📷'}
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
          onChange={e => { addPhotos(e.target.files); e.target.value = ''; }} />
        <span style={{ flex: 1 }} />
        <button onClick={submit} disabled={busy || !title.trim() || !who.length} style={{
          ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff', padding: '8px 20px',
          opacity: busy || !title.trim() || !who.length ? 0.5 : 1,
        }}>{busy ? 'กำลังส่ง…' : 'มอบงาน'}</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', marginTop: 9, lineHeight: 1.6 }}>
        งานจะไปโผล่บนการ์ดของคนที่เลือกในวันที่กำหนด และแจ้งเข้า Telegram ให้อัตโนมัติ
      </div>
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
