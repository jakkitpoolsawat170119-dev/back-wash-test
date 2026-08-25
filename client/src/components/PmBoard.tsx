import React, { useCallback, useEffect, useMemo, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const shiftDay = (d: string, days: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/* ── หน้ารวมงาน PM ─────────────────────────────────────────────────────────
   งาน PM = งานที่วางแผนไว้ว่าจะทำวันไหน (บำรุงรักษา / ปรับปรุง / แก้ไข)
   ⚠️ คนละอย่างกับ "งานรูทีน" (ทะเบียนงานรูทีน) ที่เป็นเช็กลิสต์ทำซ้ำตามรอบ
   ตั้งจากบอทได้อยู่แล้ว แต่บอทเห็นทีละหน้าจอและแก้วันที่ไม่ได้ —
   หน้านี้เห็นทั้งก้อนล่วงหน้า (เกินกำหนด / วันนี้ / กำลังจะถึง) และเลื่อนวันได้ */
type Kind = '' | 'pm' | 'up' | 'fix';
type Remind = 'none' | 'day' | 'prev';
type Row = {
  id: number; date: string; title: string; kind: Kind; kindLabel: string; what: string;
  machine: string; assignee: string; assigneeName: string; status: string; dueTime: string; remind: Remind;
  createdBy: string; createdAt: string; completedAt: string; doneBy: string;
  hasImages: boolean; hasDoneImages: boolean; lateDays: number;
};
type Report = {
  today: string; soonDays: number;
  late: Row[]; todayList: Row[]; soon: Row[]; later: Row[]; done: Row[];
  machines: string[]; people: { key: string; name: string }[];
};
type Draft = {
  id?: number; what: string; kind: Kind; machine: string; date: string;
  dueTime: string; remind: Remind; assignee: string;
  custom?: boolean;                 // เลือก "พิมพ์ชื่อเอง" อยู่ (เครื่องที่ยังไม่มีในทะเบียน)
};

const KIND: Record<Exclude<Kind, ''>, { label: string; ic: string; c: string; w: string }> = {
  pm: { label: 'บำรุงรักษา', ic: '🔧', c: '#0d47a1', w: '#e8f1fb' },
  up: { label: 'ปรับปรุง', ic: '⬆️', c: '#14653a', w: '#e6f4ec' },
  fix: { label: 'แก้ไข', ic: '🛠', c: '#c24f00', w: '#fff3ea' },
};
const KIND_KEYS: Exclude<Kind, ''>[] = ['pm', 'up', 'fix'];
const REMIND: Record<Remind, string> = {
  day: 'เตือนเช้าวันงาน 08:00', prev: 'เตือนล่วงหน้า 1 วัน', none: 'ไม่ต้องเตือน',
};
const REMIND_KEYS: Remind[] = ['day', 'prev', 'none'];

const fmtDate = (d: string) => {
  if (!d) return '—';
  try {
    return new Date(`${d}T00:00:00Z`).toLocaleDateString('th-TH',
      { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return d; }
};
// ป้ายบอกระยะห่างจากวันนี้ — ตัวเลขวันอ่านง่ายกว่าวันที่ดิบตอนกวาดสายตา
const dayLabel = (d: string, today: string) => {
  if (!d) return 'ไม่ระบุวัน';
  const n = daysBetween(today, d);
  if (n === 0) return 'วันนี้';
  if (n === 1) return 'พรุ่งนี้';
  if (n === -1) return 'เมื่อวาน';
  return n > 0 ? `อีก ${n} วัน` : `เกินกำหนด ${-n} วัน`;
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
const btnMain: React.CSSProperties = { ...btn, background: '#c24f00', borderColor: '#c24f00', color: '#fff' };
const inp: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', borderRadius: 9,
  padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
  color: 'var(--ink,#2b2119)',
};
const lbl: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)', display: 'block', marginBottom: 4,
};

const newDraft = (today: string, people: { key: string }[]): Draft => ({
  what: '', kind: 'pm', machine: '', date: today, dueTime: '', remind: 'day',
  assignee: people[0]?.key || '',
});

/* ฟอร์มตั้ง/แก้งาน — ประกาศระดับบนสุดเสมอ
   (ถ้าซ้อนไว้ในตัวแม่ React จะ unmount ทุกครั้งที่ state ตัวแม่ขยับ = ที่กรอกไว้หายทั้งฟอร์ม) */
const PmForm: React.FC<{
  draft: Draft; machines: string[]; people: { key: string; name: string }[]; busy: boolean;
  onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void;
}> = ({ draft, machines, people, busy, onChange, onSave, onCancel }) => {
  const set = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  // พิมพ์ชื่อเอง = กดเลือกเอง หรือชื่อเครื่องเดิมไม่มีในทะเบียน (เช่นงานที่ตั้งจากบอท)
  const custom = !!draft.custom || (draft.machine !== '' && !machines.includes(draft.machine));
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))' }}>
        <div style={{ gridColumn: '1/-1' }}>
          <label style={lbl}>จะทำอะไร</label>
          <input style={inp} value={draft.what} autoFocus placeholder="เช่น เปลี่ยนลูกยางหัวซีล"
            onChange={e => set({ what: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter' && draft.what.trim()) onSave(); }} />
        </div>
        <div>
          <label style={lbl}>ประเภทงาน</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {KIND_KEYS.map(k => (
              <button key={k} onClick={() => set({ kind: k })} style={{
                ...btn, padding: '6px 11px',
                background: draft.kind === k ? KIND[k].w : '#fff',
                color: draft.kind === k ? KIND[k].c : 'var(--ink-soft,#6d6259)',
                borderColor: draft.kind === k ? KIND[k].c : 'var(--line,#eee3d9)',
              }}>{KIND[k].ic} {KIND[k].label}</button>
            ))}
          </div>
        </div>
        <div>
          <label style={lbl}>เครื่องจักร</label>
          <select style={inp} value={custom ? '__other' : draft.machine}
            onChange={e => set(e.target.value === '__other'
              ? { custom: true }
              : { machine: e.target.value, custom: false })}>
            <option value="">— ไม่ระบุเครื่อง —</option>
            {machines.map(m => <option key={m} value={m}>{m}</option>)}
            <option value="__other">✏️ พิมพ์ชื่อเอง…</option>
          </select>
          {custom && (
            <input style={{ ...inp, marginTop: 6 }} value={draft.machine} placeholder="ชื่อเครื่อง"
              onChange={e => set({ machine: e.target.value })} />
          )}
        </div>
        <div>
          <label style={lbl}>วันที่จะทำ</label>
          <input type="date" style={inp} value={draft.date} onChange={e => set({ date: e.target.value })} />
        </div>
        <div>
          <label style={lbl}>เวลา (ไม่ใส่ก็ได้)</label>
          <input type="time" style={inp} value={draft.dueTime} onChange={e => set({ dueTime: e.target.value })} />
        </div>
        <div>
          <label style={lbl}>ผู้รับผิดชอบ</label>
          <select style={inp} value={draft.assignee} onChange={e => set({ assignee: e.target.value })}>
            {people.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
            {!people.length && <option value="">— ยังไม่มีทีมซ่อมบำรุง —</option>}
          </select>
        </div>
        <div>
          <label style={lbl}>แจ้งเตือนเข้ากลุ่ม</label>
          <select style={inp} value={draft.remind} onChange={e => set({ remind: e.target.value as Remind })}>
            {REMIND_KEYS.map(r => <option key={r} value={r}>{REMIND[r]}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnMain} disabled={busy || !draft.what.trim()} onClick={onSave}>
          {busy ? '⏳ กำลังบันทึก…' : '💾 บันทึก'}
        </button>
        <button style={btn} onClick={onCancel}>ยกเลิก</button>
      </div>
    </div>
  );
};

const PmBoard: React.FC<{ operatorName?: string }> = ({ operatorName }) => {
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [soonDays, setSoonDays] = useState(7);
  const [pick, setPick] = useState('');                 // กรองเฉพาะเครื่องนี้
  const [draft, setDraft] = useState<Draft | null>(null); // ฟอร์มที่เปิดอยู่ (ตั้งใหม่ = ไม่มี id)
  const [dateOpen, setDateOpen] = useState(0);          // แถวที่กางช่องเลื่อนวันอยู่
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch(`${apiUrl}/api/maint/pm?soon=${soonDays}`).then(r => r.json());
      setData(d && Array.isArray(d.late) ? d : null);
    } catch { setData(null); } finally { setLoading(false); }
  }, [soonDays]);
  useEffect(() => { load(); }, [load]);

  const post = async (url: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, operator: operatorName || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(`❌ ${d.message || d.error || 'บันทึกไม่สำเร็จ'}`); return false; }
      setMsg('');
      await load();
      return true;
    } catch { setMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); return false; } finally { setBusy(false); }
  };

  const today = data?.today || todayBKK();
  const save = async () => {
    if (!draft || !draft.what.trim()) return;
    const body = {
      what: draft.what.trim(), kind: draft.kind || 'pm', machine: draft.machine.trim(),
      date: draft.date, dueTime: draft.dueTime, remind: draft.remind, assignee: draft.assignee,
    };
    const ok = draft.id
      ? await post('/api/maint/pm/update', { id: draft.id, ...body })
      : await post('/api/maint/pm', body);
    if (ok) setDraft(null);
  };
  const move = (r: Row, date: string) => post('/api/maint/pm/update', { id: r.id, date })
    .then(ok => { if (ok) setDateOpen(0); });
  const done = (r: Row) => post('/api/maint/pm/update', { id: r.id, status: 'done' });
  const undo = (r: Row) => post('/api/maint/pm/update', { id: r.id, status: 'pending' });
  const del = (r: Row) => {
    if (window.confirm(`ลบงาน "${r.title}" ทิ้ง?\n(ถ้าแค่ยังไม่ได้ทำ ให้กด 📅 เลื่อนวันแทน)`))
      post('/api/maint/pm/delete', { id: r.id });
  };

  const machinesInUse = useMemo(() => {
    if (!data) return [];
    const all = [...data.late, ...data.todayList, ...data.soon, ...data.later];
    return Array.from(new Set(all.map(r => r.machine || 'ไม่ระบุเครื่อง'))).sort();
  }, [data]);
  const filt = useCallback((rows: Row[]) =>
    rows.filter(r => !pick || (r.machine || 'ไม่ระบุเครื่อง') === pick), [pick]);

  const openCount = data ? data.late.length + data.todayList.length + data.soon.length + data.later.length : 0;

  /* ── การ์ดงาน 1 ใบ ── */
  const rowCard = (r: Row, tone: 'late' | 'today' | 'soon' | 'later' | 'done') => {
    const k = r.kind ? KIND[r.kind] : null;
    const edge = tone === 'late' ? '#c62828' : tone === 'today' ? '#c24f00' : tone === 'done' ? '#1c8a4c' : '#d9cec3';
    return (
      <div key={r.id} style={{
        ...card, padding: '11px 13px', borderLeft: `4px solid ${edge}`,
        background: tone === 'late' ? '#fffaf9' : tone === 'done' ? '#fbfdfb' : '#fff',
        opacity: tone === 'done' ? 0.85 : 1,
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 230px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 3 }}>
              {k && (
                <span style={{
                  fontFamily: 'Kanit, sans-serif', fontSize: 11, fontWeight: 700, color: k.c, background: k.w,
                  padding: '2px 9px', borderRadius: 999, whiteSpace: 'nowrap',
                }}>{k.ic} {k.label}</span>
              )}
              <span style={{
                fontFamily: 'Kanit, sans-serif', fontSize: 14.5, fontWeight: 600,
                textDecoration: tone === 'done' ? 'line-through' : 'none',
              }}>{r.what || r.title}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft,#6d6259)', lineHeight: 1.75 }}>
              🔩 {r.machine || 'ไม่ระบุเครื่อง'}
              {r.assigneeName && <> · 👤 {r.assigneeName}</>}
              {r.dueTime && <> · ⏰ {r.dueTime} น.</>}
              {r.remind === 'none' && tone !== 'done' && <> · 🔕 ไม่เตือน</>}
              {tone === 'done' && r.completedAt && <> · ✅ ปิดงาน {r.completedAt.slice(0, 16).replace('T', ' ')}
                {r.doneBy ? ` โดย ${r.doneBy}` : ''}</>}
            </div>
          </div>
          <div style={{ flex: 'none', textAlign: 'right' }}>
            <div style={{
              fontFamily: 'Kanit, sans-serif', fontSize: 13, fontWeight: 700,
              color: tone === 'late' ? '#c62828' : tone === 'today' ? '#c24f00' : 'var(--ink,#2b2119)',
            }}>{fmtDate(r.date)}</div>
            <div style={{ fontSize: 11.5, color: tone === 'late' ? '#c62828' : 'var(--ink-soft,#6d6259)' }}>
              {tone === 'done' ? 'ทำเสร็จแล้ว' : dayLabel(r.date, today)}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
          {tone === 'done' ? (
            <button style={{ ...btn, padding: '4px 11px', fontSize: 12 }} disabled={busy} onClick={() => undo(r)}>
              ↩ เปิดงานใหม่
            </button>
          ) : (
            <>
              <button style={{ ...btn, padding: '4px 11px', fontSize: 12, color: '#1c8a4c', borderColor: '#bfe3cd' }}
                disabled={busy} onClick={() => done(r)}>✅ ทำเสร็จแล้ว</button>
              <button style={{ ...btn, padding: '4px 11px', fontSize: 12 }}
                onClick={() => setDateOpen(dateOpen === r.id ? 0 : r.id)}>📅 เลื่อนวัน</button>
              <button style={{ ...btn, padding: '4px 11px', fontSize: 12 }}
                onClick={() => { setDateOpen(0); setDraft({
                  id: r.id, what: r.what, kind: r.kind, machine: r.machine, date: r.date,
                  dueTime: r.dueTime, remind: r.remind, assignee: r.assignee,
                }); }}>✏️ แก้</button>
              <button style={{ ...btn, padding: '4px 11px', fontSize: 12, color: '#b3261e', borderColor: '#f2c4bc' }}
                disabled={busy} onClick={() => del(r)}>🗑</button>
            </>
          )}
        </div>

        {dateOpen === r.id && (
          <div style={{
            display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
            marginTop: 9, paddingTop: 9, borderTop: '1px dashed var(--line,#eee3d9)',
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' }}>เลื่อนไป</span>
            <button style={{ ...btn, padding: '4px 11px', fontSize: 12 }} disabled={busy}
              onClick={() => move(r, today)}>วันนี้</button>
            <button style={{ ...btn, padding: '4px 11px', fontSize: 12 }} disabled={busy}
              onClick={() => move(r, shiftDay(today, 1))}>พรุ่งนี้</button>
            <button style={{ ...btn, padding: '4px 11px', fontSize: 12 }} disabled={busy}
              onClick={() => move(r, shiftDay(r.date || today, 7))}>+7 วัน</button>
            <button style={{ ...btn, padding: '4px 11px', fontSize: 12 }} disabled={busy}
              onClick={() => move(r, shiftDay(r.date || today, 30))}>+30 วัน</button>
            <input type="date" defaultValue={r.date} style={{ ...inp, width: 160, padding: '5px 9px' }}
              onChange={e => { if (e.target.value) move(r, e.target.value); }} />
          </div>
        )}
      </div>
    );
  };

  const section = (title: string, rows: Row[], tone: 'late' | 'today' | 'soon' | 'later' | 'done', empty: string) => {
    const shown = tone === 'done' ? rows : filt(rows);
    return (
      <div style={{ marginBottom: 18 }}>
        <div style={{
          fontFamily: 'Kanit, sans-serif', fontSize: 14.5, fontWeight: 600, marginBottom: 8,
          color: tone === 'late' ? '#c62828' : 'var(--ink,#2b2119)',
        }}>{title} <span style={{ color: 'var(--ink-soft,#6d6259)', fontWeight: 500 }}>({shown.length})</span></div>
        {shown.length === 0
          ? <div style={{ fontSize: 12.5, color: '#a89e94', padding: '2px 0 6px' }}>{empty}</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{shown.map(r => rowCard(r, tone))}</div>}
      </div>
    );
  };

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#c24f00',
        background: '#fff3ea', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>🔧 งานซ่อมบำรุง</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          งาน PM ที่วางแผนไว้
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>
          งานที่ตั้งไว้ว่าจะทำวันไหน — ตั้งจากบอทหรือจากที่นี่ก็ได้ · เลื่อนวันได้เฉพาะที่นี่
        </span>
      </div>

      {/* ── ตัวเลขรวม ── */}
      {data && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', marginBottom: 14 }}>
          {([
            ['เกินกำหนด', data.late.length, data.late.length ? '#c62828' : '#1c8a4c', data.late.length ? 'ต้องเคลียร์ก่อน' : 'ไม่มีค้าง'],
            ['วันนี้', data.todayList.length, '#c24f00', fmtDate(today)],
            [`ใน ${soonDays} วันข้างหน้า`, data.soon.length, 'var(--ink,#2b2119)', 'เตรียมของล่วงหน้าได้'],
            ['ค้างทั้งหมด', openCount, 'var(--ink,#2b2119)', `เสร็จแล้ว ${data.done.length} ใน 30 วัน`],
          ] as [string, number, string, string][]).map(([k, v, c, sub]) => (
            <div key={k} style={{ ...card, padding: '12px 16px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', fontWeight: 600 }}>{k}</div>
              <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 22, fontWeight: 600, color: c, lineHeight: 1.3 }}>{v}</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── แถบเครื่องมือ ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <button style={btnMain} onClick={() => { setDateOpen(0); setDraft(newDraft(today, data?.people || [])); }}>
          ➕ ตั้งงาน PM ใหม่
        </button>
        <span style={{ width: 1, height: 22, background: 'var(--line,#eee3d9)' }} />
        <span style={{ fontSize: 12.5, color: 'var(--ink-soft,#6d6259)', fontWeight: 600 }}>กำลังจะถึงใน</span>
        {[7, 14, 30].map(d => (
          <button key={d} onClick={() => setSoonDays(d)} style={{
            ...btn, padding: '5px 12px',
            background: soonDays === d ? '#fff3ea' : '#fff',
            color: soonDays === d ? '#c24f00' : 'var(--ink-soft,#6d6259)',
            borderColor: soonDays === d ? '#f0c9ac' : 'var(--line,#eee3d9)',
          }}>{d} วัน</button>
        ))}
        {machinesInUse.length > 1 && (
          <select value={pick} onChange={e => setPick(e.target.value)} style={{ ...inp, width: 'auto', padding: '6px 10px' }}>
            <option value="">🔩 ทุกเครื่อง</option>
            {machinesInUse.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <button onClick={load} style={btn}>{loading ? '⏳' : '🔄'} รีเฟรช</button>
      </div>

      {msg && (
        <div style={{
          ...card, borderColor: '#f2c4bc', background: '#fdecea', color: '#b3261e',
          padding: '10px 14px', fontSize: 13, marginBottom: 12,
        }}>{msg}</div>
      )}

      {/* ── ฟอร์มตั้ง/แก้งาน ── */}
      {draft && (
        <div style={{ ...card, padding: '14px 16px', marginBottom: 16, borderColor: '#f0c9ac' }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
            {draft.id ? `✏️ แก้งาน PM #${draft.id}` : '➕ ตั้งงาน PM ใหม่'}
          </div>
          <PmForm
            draft={draft} machines={data?.machines || []} people={data?.people || []} busy={busy}
            onChange={setDraft} onSave={save} onCancel={() => setDraft(null)}
          />
        </div>
      )}

      {/* ── รายการ ── */}
      {data ? (
        <>
          {section('⚠️ เกินกำหนด', data.late, 'late', 'ไม่มีงานเกินกำหนด 👍')}
          {section('🗓 วันนี้', data.todayList, 'today', 'วันนี้ไม่มีงาน PM ที่วางแผนไว้')}
          {section(`📅 กำลังจะถึง (${soonDays} วัน)`, data.soon, 'soon', `ยังไม่มีงานใน ${soonDays} วันข้างหน้า`)}
          {data.later.length > 0 && section('🗂 หลังจากนั้น', data.later, 'later', '')}

          <div style={{ marginTop: 6 }}>
            <button style={btn} onClick={() => setShowDone(!showDone)}>
              {showDone ? '▾' : '▸'} งานที่ทำเสร็จแล้ว ({data.done.length}) — 30 วันล่าสุด
            </button>
            {showDone && (
              <div style={{ marginTop: 10 }}>
                {section('✅ ทำเสร็จแล้ว', data.done, 'done', 'ยังไม่มีงาน PM ที่ปิดใน 30 วันนี้')}
              </div>
            )}
          </div>

          {openCount === 0 && (
            <div style={{ ...card, padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--ink-soft,#6d6259)', lineHeight: 1.8 }}>
              ยังไม่มีงาน PM ที่วางแผนไว้เลย
              <br />กด <b>➕ ตั้งงาน PM ใหม่</b> ข้างบน หรือตั้งจากบอทซ่อมบำรุง (เมนู 🗓 งาน PM)
            </div>
          )}
        </>
      ) : !loading && (
        <div style={{ ...card, padding: 20, textAlign: 'center', color: 'var(--ink-soft,#6d6259)', fontSize: 13 }}>
          โหลดข้อมูลไม่สำเร็จ — กด 🔄 รีเฟรชอีกครั้ง
        </div>
      )}
    </div>
  );
};

export default PmBoard;
