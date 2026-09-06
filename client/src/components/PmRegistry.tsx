import React, { useCallback, useEffect, useMemo, useState } from 'react';
import RoutineSheetImport from './RoutineSheetImport';

import AmSheetHistory from './AmSheetHistory';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

/* ทะเบียน "งานรูทีน" ฝั่งซ่อมบำรุง — ตารางแม่ของเช็กลิสต์ประจำ
   ⚠️ คนละอย่างกับ "งาน PM" (งานที่วางแผนว่าจะทำวันไหน — อยู่ในกระดานงานมอบหมาย/บอท)
      ตรงนี้คือรายการที่ทำซ้ำ ๆ ตามรอบ เช่นตอนตั้งไลน์ · ตั้ง "ความถี่" ได้ว่ารอบไหนถึงคิว
   ต่างจากกระดานเวร: ตรงนี้เห็น "ทุกแถว" รวมงานที่ทีมผลิตทำ และแก้ข้อมูลได้ทุกช่อง       */
type Role = '' | 'mt' | 'op' | 'qc' | 'pd';
type Freq = '' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'onuse' | 'onissue';
type Row = {
  id: number; personKey: string; nodeKey: string; title: string;
  machine: string; goal: string; method: string; ownerRole: Role; coOwnerRole: Role; sortOrder: number; freq: Freq;
  // 'am' = ข้อตรวจของใบเช็ก AM รายกะ — ไม่ผูกกับคน (person_key เป็น NULL) และไม่ขึ้นกระดานเวร
  sheet?: string;
};
type Person = { key: string; name: string; role: string; color?: string; initial?: string };

const ROLE: Record<Exclude<Role, ''>, { label: string; c: string; w: string }> = {
  mt: { label: 'Maintenance', c: '#c24f00', w: '#fff3ea' },
  op: { label: 'Operate', c: '#0d47a1', w: '#e8f1fb' },
  qc: { label: 'QC', c: '#14653a', w: '#e6f4ec' },
  pd: { label: 'พนักงานผลิต', c: '#4b433c', w: '#f2ede8' },
};
const ROLE_KEYS: Exclude<Role, ''>[] = ['mt', 'op', 'qc', 'pd'];
/* ความถี่ = ตัวบอกกระดานในบอทว่างานนี้ "ถึงคิว" วันไหน
   ว่างไว้ = ทุกวัน (ค่าเดิมของงานที่สร้างก่อนมีช่องนี้ — กระดานจะทำงานเหมือนเดิม)
   onuse/onissue ไม่ขึ้นกระดานเอง ต้องเปิดดูของเครื่องนั้นเอง                          */
const FREQ: Record<Exclude<Freq, ''>, string> = {
  daily: 'ทุกวัน', weekly: 'ทุกสัปดาห์', monthly: 'ทุกเดือน', quarterly: 'ทุก 3 เดือน',
  onuse: 'เมื่อใช้งานเครื่องนี้', onissue: 'เมื่อมีปัญหา',
};
const FREQ_KEYS = Object.keys(FREQ) as Exclude<Freq, ''>[];
const freqLabel = (f: Freq) => FREQ[(f || 'daily') as Exclude<Freq, ''>];
const NO_MACHINE = 'งานเปิดกะ (ไม่ผูกเครื่องจักร)';
const MACHINE_IC: Record<string, string> = {
  'เครื่องยิงวันที่': '🖨', 'เครื่องชั่ง Mettler1/2/Ishida': '⚖️', 'เครื่องจับโละ 900g/25kg/ปี๊บ': '📦',
  'เครื่องชั่งเล็กประจำไลน์': '🧮', 'ตั้งไลน์สำหรับผลิต': '🧰', 'เครื่องปิดลัง': '📮',
  'เครื่องซีลแนวตั้ง': '🔥', 'เครน': '🏗', [NO_MACHINE]: '🗒',
  'Line ต้ม 1': '1️⃣', 'Line ต้ม 2': '2️⃣', 'Line ต้ม 3': '3️⃣',
};
const icOf = (m: string) => MACHINE_IC[m] || '🔩';
/* สีหัวกลุ่มของ 3 ไลน์ต้ม — ยืมเฉดเดียวกับหน้า CIP ไว้ให้ดูเป็นชุดเดียวกัน แต่ ⚠️ "Line ต้ม 1/2/3"
   คนละอย่างกับ 'Line 1/2/3' ของ CIP (ไลน์บรรจุ) · เครื่องอื่นใช้สีส้มแบรนด์เหมือนเดิม        */
const LINE_C: Record<string, { c: string; w: string }> = {
  'Line ต้ม 1': { c: '#1565c0', w: '#e8f1fb' },
  'Line ต้ม 2': { c: '#01579b', w: '#e3f0f8' },
  'Line ต้ม 3': { c: '#006064', w: '#e0f4f4' },
};
const lineC = (m: string) => LINE_C[m] || { c: '#c24f00', w: '#fff3ea' };

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

const RoleChip: React.FC<{ r: Role; sec?: boolean }> = ({ r, sec }) => {
  if (!r) return <span style={{ color: '#c4bbb2', fontSize: 12 }}>—</span>;
  const m = ROLE[r];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700,
      fontFamily: 'Kanit, sans-serif', padding: '2px 9px', borderRadius: 999, whiteSpace: 'nowrap',
      color: m.c, background: sec ? 'transparent' : m.w,
      boxShadow: sec ? `inset 0 0 0 1px ${m.c}` : 'none', opacity: sec ? 0.62 : 1,
    }}>{m.label}</span>
  );
};

const PmRegistry: React.FC = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [machines, setMachines] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | Exclude<Role, ''>>('all');
  const [mFilter, setMFilter] = useState('all');           // กรองตามกลุ่มเครื่องจักร (all = ทุกกลุ่ม)
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Row | null>(null);     // แถวที่กำลังแก้ (ร่างในหน่วยความจำ)
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [amLink, setAmLink] = useState<{ line: string; url: string } | null>(null);
  const [amHistory, setAmHistory] = useState(false);   // เปิดตารางย้อนหลังรายเดือนอยู่ไหม

  const load = useCallback(async () => {
    try {
      const [r, m] = await Promise.all([
        fetch(`${apiUrl}/api/maint/routines`).then(x => x.json()),
        fetch(`${apiUrl}/api/machines`).then(x => x.json()).catch(() => ({ machines: [] })),
      ]);
      setRows(Array.isArray(r?.rows) ? r.rows : []);
      setPeople(Array.isArray(r?.people) ? r.people : []);
      setMachines(Array.isArray(m?.machines) ? m.machines.map((x: { name: string }) => x.name) : []);
    } catch { setMsg('❌ โหลดทะเบียนไม่สำเร็จ'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (url: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'บันทึกไม่สำเร็จ'}`); return false; }
      await load(); setMsg('');
      return true;
    } catch { setMsg('❌ บันทึกไม่สำเร็จ'); return false; } finally { setBusy(false); }
  };

  const saveRow = async (r: Row) => {
    if (!r.title.trim()) return;
    const ok = await post('/api/duty/routine', {
      id: r.id || undefined, personKey: r.personKey, assigneeKey: r.personKey,
      title: r.title.trim(), machine: r.machine.trim(), goal: r.goal.trim(), method: r.method.trim(),
      ownerRole: r.ownerRole || null, coOwnerRole: r.coOwnerRole || null,
      freq: r.freq || 'daily',
    });
    if (ok) { setEdit(null); setAdding(false); }
  };
  const delRow = (r: Row) => {
    if (window.confirm(`ลบงาน "${r.title}" ออกจากทะเบียน?\n(ประวัติการติ๊กของวันก่อน ๆ ยังอยู่)`))
      post('/api/duty/routine/delete', { id: r.id });
  };

  /* นำเข้าจากรูปเอกสาร: ยิงทีละแถวเข้า endpoint เดิม (ไม่มี bulk API — แถวเดียวกับที่ฟอร์มใช้)
     คืนจำนวนที่สำเร็จให้การ์ดไปบอกผล · โหลดตารางใหม่ครั้งเดียวตอนจบ ไม่ใช่ทุกแถว    */
  const importRows = useCallback(async (
    list: { title: string; goal: string; method: string; machine: string }[],
    opts: { ownerRole: Role; freq: Freq; personKey: string },
  ) => {
    let ok = 0;
    for (const r of list) {
      try {
        const resp = await fetch(`${apiUrl}/api/duty/routine`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personKey: opts.personKey, assigneeKey: opts.personKey,
            title: r.title, machine: r.machine, goal: r.goal, method: r.method,
            ownerRole: opts.ownerRole || null, coOwnerRole: null, freq: opts.freq || 'daily',
          }),
        });
        if (resp.ok) ok++;
      } catch { /* แถวไหนพลาดก็นับไม่สำเร็จ ให้ผู้ใช้กดซ้ำเฉพาะที่เหลือ */ }
    }
    await load();
    return ok;
  }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      if (filter !== 'all' && r.ownerRole !== filter && r.coOwnerRole !== filter) return false;
      if (mFilter !== 'all' && (r.machine || NO_MACHINE) !== mFilter) return false;
      if (!needle) return true;
      return `${r.title} ${r.machine} ${r.goal} ${r.method}`.toLowerCase().includes(needle);
    });
  }, [rows, filter, mFilter, q]);

  // รายชื่อกลุ่มทั้งหมด (ไม่ขึ้นกับตัวกรอง) — ใช้เป็นตัวเลือกใน dropdown กรองกลุ่ม
  const allGroups = useMemo(() => {
    const seen: string[] = [];
    for (const r of rows) { const n = r.machine || NO_MACHINE; if (!seen.includes(n)) seen.push(n); }
    return seen;
  }, [rows]);

  const groups = useMemo(() => {
    const out: { name: string; rows: Row[] }[] = [];
    for (const r of shown) {
      const name = r.machine || NO_MACHINE;
      const g = out.find(x => x.name === name);
      if (g) g.rows.push(r); else out.push({ name, rows: [r] });
    }
    return out;
  }, [shown]);

  const nOwner = (k: Role) => rows.filter(r => r.ownerRole === k).length;
  // ตัวกรองจับทั้งช่องหลักและช่อง 2 — ตัวเลขบนปุ่มต้องเท่ากับจำนวนแถวที่จะเห็นจริง
  // (ไม่งั้น QC จะขึ้น 0 ทั้งที่กดแล้วมี 4 แถว เพราะ QC โผล่เฉพาะช่อง "ผู้รับผิดชอบ 2")
  const nFilter = (k: Role) => rows.filter(r => r.ownerRole === k || r.coOwnerRole === k).length;

  // ไลน์ที่มีใบเช็ก AM = เครื่องที่มีข้อตรวจ sheet='am' ผูกอยู่ (ไม่ฮาร์ดโค้ดชื่อไลน์)
  const amLines = useMemo(
    () => Array.from(new Set(rows.filter(r => r.sheet === 'am' && r.machine).map(r => r.machine))).sort(),
    [rows]);

  const makeAmLink = async (line: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await fetch(`${apiUrl}/api/am-sheet/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line, by: localStorage.getItem('operator') || '', baseUrl: window.location.origin }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'ออกลิงก์ไม่สำเร็จ'}`); return; }
      // เซิร์ฟเวอร์คืน path เปล่าถ้าไม่ได้ตั้ง PUBLIC_WEB_URL — ต่อ origin ให้เอง
      setAmLink({ line, url: d.url.startsWith('http') ? d.url : `${window.location.origin}${d.url}` });
    } catch { setMsg('❌ ออกลิงก์ไม่สำเร็จ'); } finally { setBusy(false); }
  };
  const nameOf = (key: string) => people.find(p => p.key === key)?.name || key;

  /* ── ฟอร์มแก้/เพิ่ม 1 แถว ── */
  const RowForm: React.FC<{ draft: Row }> = ({ draft }) => {
    const [d, setD] = useState(draft);
    const set = (patch: Partial<Row>) => setD(v => ({ ...v, ...patch }));
    return (
      <tr>
        <td colSpan={8} style={{ padding: 12, background: '#fffaf5' }}>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>รายการที่ต้องทำ
              <input autoFocus value={d.title} onChange={e => set({ title: e.target.value })} style={{ ...inp, marginTop: 3 }} />
            </label>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>เป้าหมาย
              <input value={d.goal} onChange={e => set({ goal: e.target.value })} style={{ ...inp, marginTop: 3 }} />
            </label>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>วิธีการตรวจสอบ
              <input value={d.method} onChange={e => set({ method: e.target.value })} placeholder="เว้นว่างได้" style={{ ...inp, marginTop: 3 }} />
            </label>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>เครื่องจักร
              <input list="pm-machines" value={d.machine} onChange={e => set({ machine: e.target.value })}
                placeholder="เว้นว่าง = ไม่ผูกเครื่อง" style={{ ...inp, marginTop: 3 }} />
              <datalist id="pm-machines">{machines.map(m => <option key={m} value={m} />)}</datalist>
            </label>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>ผู้รับผิดชอบหลัก
              <select value={d.ownerRole} onChange={e => set({ ownerRole: e.target.value as Role })} style={{ ...inp, marginTop: 3 }}>
                <option value="">— ไม่ระบุ —</option>
                {ROLE_KEYS.map(k => <option key={k} value={k}>{ROLE[k].label}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>ผู้รับผิดชอบ 2
              <select value={d.coOwnerRole} onChange={e => set({ coOwnerRole: e.target.value as Role })} style={{ ...inp, marginTop: 3 }}>
                <option value="">— ไม่มี —</option>
                {ROLE_KEYS.map(k => <option key={k} value={k}>{ROLE[k].label}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>ความถี่ (ถึงคิวเมื่อไหร่)
              <select value={d.freq || 'daily'} onChange={e => set({ freq: e.target.value as Freq })} style={{ ...inp, marginTop: 3 }}>
                {FREQ_KEYS.map(k => <option key={k} value={k}>{FREQ[k]}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>คนในทีมที่รับงานนี้
              <select value={d.personKey} onChange={e => set({ personKey: e.target.value })} style={{ ...inp, marginTop: 3 }}>
                {people.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
            <button onClick={() => saveRow(d)} disabled={busy || !d.title.trim()}
              style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>บันทึก</button>
            <button onClick={() => { setEdit(null); setAdding(false); }} style={btn}>ยกเลิก</button>
            {d.ownerRole !== 'mt' && (
              <span style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', alignSelf: 'center' }}>
                ผู้รับผิดชอบหลักไม่ใช่ Maintenance → งานนี้จะไม่ขึ้นให้ติ๊กบนกระดานเวร
                {d.coOwnerRole === 'mt' ? ' (ขึ้นในแถบ “เราแค่ตามผล”)' : ''}
              </span>
            )}
          </div>
        </td>
      </tr>
    );
  };

  const emptyRow = (machine: string): Row => ({
    id: 0, personKey: people[0]?.key || '', nodeKey: '', title: '', machine,
    goal: '', method: '', ownerRole: 'mt', coOwnerRole: '', sortOrder: 0, freq: 'daily',
  });

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#c24f00',
        background: '#fff3ea', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>🔧 งานซ่อมบำรุง</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          ทะเบียนงานรูทีนรายเครื่องจักร
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>
          {/* กำลังกรองอยู่ ต้องบอกทั้งที่เห็นและทั้งหมด ไม่งั้นอ่านเป็น "79 รายการใน 1 กลุ่ม" */}
          {shown.length < rows.length ? `${shown.length} จาก ${rows.length} รายการ` : `${rows.length} รายการ`}
          {' · '}{groups.length} กลุ่ม · แก้ได้ทุกช่อง
        </span>
      </div>

      {/* สรุปจำนวนตามผู้รับผิดชอบหลัก */}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', marginBottom: 16 }}>
        {ROLE_KEYS.map(k => (
          <div key={k} style={{ ...card, padding: '12px 14px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-soft,#6d6259)' }}>{ROLE[k].label} · เป็นหลัก</div>
            <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 24, fontWeight: 600, lineHeight: 1.25, color: ROLE[k].c }}>{nOwner(k)}</div>
          </div>
        ))}
      </div>

      <RoutineSheetImport
        apiUrl={apiUrl} machines={machines} people={people}
        roleOptions={ROLE_KEYS.map(k => ({ key: k, label: ROLE[k].label }))}
        freqOptions={FREQ_KEYS.map(k => ({ key: k, label: FREQ[k] }))}
        onSave={importRows}
      />

      {/* ลิงก์ใบเช็ก AM รายกะ — 1 ลิงก์ต่อไลน์ ใช้ได้ทุกกะ ปักหมุดในกลุ่มช่างได้
          ⚠️ เป็นลิงก์สาธารณะแบบเดียวกับลิงก์ตรวจนับคลัง ใครมีลิงก์กรอกได้ */}
      {amLines.length > 0 && (
        <div style={{
          ...card, padding: '13px 16px', marginBottom: 14,
          background: 'linear-gradient(180deg,#e3f0f8,#fff 70%)', borderColor: '#b3d4e8',
        }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 14.5, fontWeight: 600, marginBottom: 3 }}>
            📋 ใบเช็ก AM รายกะ (มือถือ)
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-soft,#6d6259)', marginBottom: 10, maxWidth: 620 }}>
            ข้อตรวจ {rows.filter(r => r.sheet === 'am').length} ข้อด้านล่างไม่ขึ้นกระดานเวรแล้ว —
            ช่างกรอกผลตรวจ (ปกติ/ไม่ปกติ) ผ่านลิงก์นี้บนมือถือ ข้อที่ไม่ปกติจะเปิดใบแจ้งซ่อมให้อัตโนมัติตอนกดส่ง
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            {amLines.map(line => (
              <button key={line} onClick={() => makeAmLink(line)} disabled={busy}
                style={{ ...btn, background: lineC(line).w, color: lineC(line).c, borderColor: lineC(line).w }}>
                🔗 ลิงก์ {line}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button onClick={() => setAmHistory(v => !v)}
              style={{ ...btn, ...(amHistory ? { background: '#2b2119', borderColor: '#2b2119', color: '#fff' } : {}) }}>
              📅 ดูใบเช็กย้อนหลัง
            </button>
          </div>
          {amLink && (
            <div style={{ marginTop: 10, background: '#fff', border: '1px solid var(--line,#eee3d9)', borderRadius: 10, padding: '9px 12px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)', marginBottom: 4 }}>
                ลิงก์ของ {amLink.line}
              </div>
              <div style={{ fontSize: 12.5, wordBreak: 'break-all', fontFamily: 'ui-monospace, Menlo, monospace' }}>{amLink.url}</div>
              <div style={{ display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' }}>
                <button style={{ ...btn, padding: '4px 12px', fontSize: 12 }}
                  onClick={() => { navigator.clipboard?.writeText(amLink.url); setMsg('✅ คัดลอกลิงก์แล้ว'); }}>📋 คัดลอก</button>
                <button style={{ ...btn, padding: '4px 12px', fontSize: 12 }}
                  onClick={() => window.open(amLink.url, '_blank')}>👁 เปิดดู</button>
                <button style={{ ...btn, padding: '4px 12px', fontSize: 12 }} onClick={() => setAmLink(null)}>ปิด</button>
              </div>
            </div>
          )}
        </div>
      )}

      {amHistory && amLines.length > 0 && (
        <AmSheetHistory lines={amLines} onClose={() => setAmHistory(false)} />
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <button onClick={() => setFilter('all')} style={{ ...btn, ...(filter === 'all' ? { background: '#2b2119', borderColor: '#2b2119', color: '#fff' } : {}) }}>
          ทั้งหมด {rows.length}
        </button>
        {ROLE_KEYS.map(k => (
          <button key={k} onClick={() => setFilter(k)}
            style={{ ...btn, ...(filter === k ? { background: ROLE[k].c, borderColor: ROLE[k].c, color: '#fff' } : {}) }}>
            {ROLE[k].label} {nFilter(k)}
          </button>
        ))}
        {/* กรองตามกลุ่ม — ใช้ dropdown แทนปุ่มเรียงอย่างใน mockup เพราะของจริงมีสิบกว่ากลุ่ม */}
        <select value={mFilter} onChange={e => setMFilter(e.target.value)}
          style={{
            ...inp, width: 'auto', maxWidth: 230, borderRadius: 999, padding: '6px 12px',
            fontFamily: 'Kanit, sans-serif', fontSize: 12.5, fontWeight: 600,
            ...(mFilter !== 'all' ? { background: lineC(mFilter).w, color: lineC(mFilter).c, borderColor: lineC(mFilter).w } : {}),
          }}>
          <option value="all">🔩 ทุกกลุ่มเครื่องจักร</option>
          {allGroups.map(g => <option key={g} value={g}>{icOf(g)} {g}</option>)}
        </select>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔎 ค้นหางาน / เครื่องจักร…"
          style={{ ...inp, width: 'auto', flex: 1, minWidth: 160, maxWidth: 280, borderRadius: 999, padding: '7px 14px' }} />
        <span style={{ flex: 1 }} />
        <button onClick={() => { setAdding(true); setEdit(null); }} disabled={!people.length}
          style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>＋ เพิ่มรายการ</button>
      </div>
      {msg && <div style={{ fontSize: 12.5, color: '#c62828', marginBottom: 10 }}>{msg}</div>}

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1000, fontSize: 13.5 }}>
            <thead>
              <tr>
                {['', 'รายการที่ต้องทำ', 'เป้าหมาย (มาตรฐาน)', 'วิธีการตรวจสอบ', 'ความถี่', 'ผู้รับผิดชอบหลัก', 'ผู้รับผิดชอบ 2', ''].map((h, i) => (
                  <th key={i} style={{
                    fontFamily: 'Kanit, sans-serif', fontSize: 12, fontWeight: 600, color: 'var(--ink-soft,#6d6259)',
                    textAlign: 'left', padding: '10px 14px', background: '#fbf7f3', borderBottom: '1px solid var(--line,#eee3d9)',
                    width: ['34px', '23%', '17%', '17%', '11%', '11%', '10%', '8%'][i],
                    whiteSpace: 'nowrap',
                  }}>
                    {h}
                    {h === 'วิธีการตรวจสอบ' && (
                      <span style={{
                        fontSize: 9.5, fontWeight: 700, background: '#ff6b00', color: '#fff',
                        borderRadius: 999, padding: '1px 7px', marginLeft: 6, verticalAlign: 2,
                      }}>ใหม่</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {adding && <RowForm draft={emptyRow('')} />}
              {groups.map(g => (
                <React.Fragment key={g.name}>
                  <tr>
                    <td colSpan={8} style={{
                      background: `linear-gradient(90deg,${lineC(g.name).w},transparent)`, padding: '8px 14px',
                      fontFamily: 'Kanit, sans-serif', fontWeight: 600, fontSize: 13.5, color: lineC(g.name).c,
                      borderBottom: `1px solid ${lineC(g.name).w}`,
                    }}>
                      {icOf(g.name)} {g.name}
                      <span style={{ fontWeight: 500, fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', marginLeft: 8 }}>
                        {g.rows.length} รายการ · ซ่อมบำรุงทำเอง {g.rows.filter(r => r.ownerRole === 'mt').length}
                      </span>
                    </td>
                  </tr>
                  {g.rows.map((r, i) => (edit && edit.id === r.id ? <RowForm key={r.id} draft={edit} /> : (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f5efe9' }}>
                      {/* ลำดับในกลุ่ม — เดินตามเอกสารกระดาษที่ช่างใช้เทียบทีละข้อ */}
                      <td style={{ padding: '9px 6px 9px 14px', color: '#a49a90', fontWeight: 600, fontSize: 12.5, verticalAlign: 'top' }}>{i + 1}</td>
                      <td style={{ padding: '9px 14px', fontWeight: 600 }}>
                        {r.title}
                        {r.sheet === 'am' ? (
                          <div style={{ fontSize: 11, color: '#01579b', fontWeight: 600 }}>
                            📋 ใบเช็ก AM รายกะ · ไม่ผูกกับคน (ใครเข้ากะไลน์นี้กรอก)
                          </div>
                        ) : people.length > 1 && (
                          <div style={{ fontSize: 11, color: 'var(--ink-soft,#6d6259)', fontWeight: 500 }}>👤 {nameOf(r.personKey)}</div>
                        )}
                      </td>
                      <td style={{ padding: '9px 14px', color: 'var(--ink-soft,#6d6259)', fontSize: 12.5 }}>{r.goal}</td>
                      <td style={{ padding: '9px 14px', color: 'var(--ink-soft,#6d6259)', fontSize: 12.5 }}>{r.method}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{
                          fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                          color: r.freq === 'onissue' ? '#a49a90' : '#4b433c',
                          background: r.freq === 'onissue' ? '#f7f4f1' : '#f2ede8',
                          whiteSpace: 'nowrap',
                        }}>{freqLabel(r.freq)}</span>
                      </td>
                      <td style={{ padding: '9px 14px' }}><RoleChip r={r.ownerRole} /></td>
                      <td style={{ padding: '9px 14px' }}><RoleChip r={r.coOwnerRole} sec /></td>
                      <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                        <button onClick={() => { setEdit(r); setAdding(false); }} title="แก้ไข"
                          style={{ ...btn, padding: '4px 9px', fontSize: 12 }}>✏️</button>{' '}
                        <button onClick={() => delRow(r)} title="ลบ"
                          style={{ ...btn, padding: '4px 9px', fontSize: 12, color: '#c62828', background: '#fdecea', borderColor: '#f7d9d5' }}>🗑</button>
                      </td>
                    </tr>
                  )))}
                </React.Fragment>
              ))}
              {!groups.length && (
                <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'var(--ink-soft,#6d6259)', fontSize: 13 }}>
                  ไม่มีรายการที่ตรงกับตัวกรอง
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: '#a49a90', padding: '10px 14px', borderTop: '1px solid var(--line,#eee3d9)', background: '#fdfbf9', lineHeight: 1.6 }}>
          กระดานในบอทจะโชว์เฉพาะงานที่ <b>ถึงคิวตามความถี่</b> — “เมื่อมีปัญหา” ไม่ขึ้นเอง ·
          กระดานเวรจะโชว์ให้ติ๊กเฉพาะงานที่ <b>ผู้รับผิดชอบหลัก = Maintenance</b> ·
          งานที่เราเป็นผู้รับผิดชอบ 2 จะขึ้นในแถบ “ทีมผลิตทำ — เราแค่ตามผล” ·
          ย้ายงานให้สมาชิกคนอื่นได้จากช่อง “คนในทีมที่รับงานนี้” ตอนกดแก้ไข
        </div>
      </div>
    </div>
  );
};

export default PmRegistry;
