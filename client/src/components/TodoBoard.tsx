import React, { useState, useEffect, useCallback, useRef } from 'react';

// ใช้ Render เป็นค่าเริ่มต้น; override ด้วย VITE_API_BASE เวลาทดสอบ local
const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

type Task = {
  id: number; task_date: string; line_name: string; category: string; flavor?: string;
  title: string; detail?: string; target_count?: number | null; actual_count: number;
  status: string; source: string; created_by?: string; completed_at?: string | null;
};
type TimelineEvent = { time: string; type: string; line: string; text: string; operator?: string };
type Template = {
  id: number; title: string; line_name: string; category: string; cadence: string;
  weekday?: number | null; target_count?: number | null; active: number;
};
type ChatMsg = { role: 'user' | 'assistant'; text: string };

const CAT: Record<string, { icon: string; label: string }> = {
  production: { icon: '🏭', label: 'ผลิต' },
  cip: { icon: '💧', label: 'CIP' },
  backwash: { icon: '🧴', label: 'Backwash' },
  am: { icon: '🛠', label: 'AM' },
  maintenance: { icon: '🔧', label: 'ซ่อมบำรุง' },
  manual: { icon: '📌', label: 'ทั่วไป' },
};
// สีประจำตัวผู้รับผิดชอบ (duty board)
const DUTY_COLOR: Record<string, { c: string; wash: string; initial: string }> = {
  mam: { c: '#00897b', wash: '#e0f2f1', initial: 'ม' },
  nai: { c: '#3949ab', wash: '#e8eaf6', initial: 'น' },
  pluk: { c: '#c2185b', wash: '#fce4ec', initial: 'พ' },
};
const BYPASS_REASONS = ['ไม่มีการผลิต', 'เครื่องหยุด/ซ่อม', 'ทำล่วงหน้าแล้ว', 'ไม่ถึงรอบ', 'ให้คนอื่นทำแทน', 'อื่นๆ'];
const LOCATIONS = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'FVH', 'บรรจุ A1/A2/A3', 'L2', 'อื่นๆ'];

type DutyNode = { key: string; title: string; depth: number; mono: boolean; checked: boolean; bypassed: boolean; bypassReason: string | null; handoffTo: string | null; handoffToName: string | null };
type Received = { ownerKey: string; fromName: string; nodeKey: string; title: string; checked: boolean };
type AdhocTask = { id: number; title: string; category: string; location: string | null; priority: string; status: string; handoffFrom: string | null };
type DutyPerson = { key: string; name: string; role: string; nodes: DutyNode[]; received: Received[]; adhoc: AdhocTask[]; done: number; total: number; pct: number };
type Duty = { date: string; people: DutyPerson[]; team: { done: number; total: number; left: number; pct: number } };
const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  done: { bg: '#e8f5e9', fg: '#2e7d32', label: 'เสร็จ' },
  in_progress: { bg: '#fff3e0', fg: '#e65100', label: 'กำลังทำ' },
  pending: { bg: '#f5f5f5', fg: '#757575', label: 'รอทำ' },
  skipped: { bg: '#fafafa', fg: '#bdbdbd', label: 'ข้าม' },
};

interface Props { operatorName: string | null; onBackToMain: () => void; }

const TodoBoard: React.FC<Props> = ({ operatorName, onBackToMain }) => {
  const [tab, setTab] = useState<'today' | 'calendar' | 'timeline' | 'recurring' | 'ai'>('today');
  const [date, setDate] = useState(todayBKK());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  // ── data loaders ───────────────────────────────────────────────
  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/tasks?date=${date}`);
      const d = await r.json();
      setTasks(d.items || []);
    } catch { /* offline */ }
  }, [date]);

  const loadTimeline = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/timeline?date=${date}`);
      const d = await r.json();
      setEvents(d.events || []);
    } catch { /* offline */ }
  }, [date]);

  const loadTemplates = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/task-templates`);
      setTemplates(await r.json());
    } catch { /* offline */ }
  }, []);

  useEffect(() => { if (tab === 'timeline') loadTimeline(); }, [tab, loadTimeline]);
  useEffect(() => { if (tab === 'recurring') { loadTemplates(); loadTasks(); } }, [tab, loadTemplates, loadTasks]);

  // ── styles ─────────────────────────────────────────────────────
  const card: React.CSSProperties = {
    background: '#fff', borderRadius: '14px', border: '1px solid #eee',
    boxShadow: '0 2px 10px rgba(0,0,0,0.05)', padding: '14px', marginBottom: '12px',
  };

  return (
    <div style={{ maxWidth: '640px', margin: '0 auto', padding: '12px 12px 60px', fontFamily: 'Inter, sans-serif' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <button onClick={onBackToMain} style={{ border: '1px solid #eee', background: '#fff', borderRadius: '10px', padding: '6px 10px', cursor: 'pointer' }}>← กลับ</button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#37474f', flex: 1 }}>✅ To-do วันนี้</h2>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ border: '1px solid #ddd', borderRadius: '10px', padding: '6px 8px', fontSize: '0.85rem' }} />
      </div>

      {/* tabs */}
      <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', marginBottom: '14px' }}>
        {([
          ['today', '👥 หน้าที่'], ['calendar', '📅 ปฏิทิน'], ['timeline', '🕐 ไทม์ไลน์'], ['recurring', '🔁 งานประจำ'], ['ai', '🤖 ผู้ช่วย AI'],
        ] as [typeof tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            flex: '0 0 auto', padding: '7px 13px', borderRadius: '20px', border: '2px solid',
            borderColor: tab === k ? '#ff6b00' : '#e0e0e0', background: tab === k ? '#ff6b00' : '#f5f5f5',
            color: tab === k ? '#fff' : '#666', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
      </div>

      {/* ── TAB: duty (หน้าที่รับผิดชอบ) ───────────────────────── */}
      {tab === 'today' && <DutyBoard date={date} operatorName={operatorName} card={card} />}

      {/* ── TAB: calendar ─────────────────────────────────────── */}
      {tab === 'calendar' && (
        <CalendarTab
          operatorName={operatorName}
          card={card}
          onOpenDate={(d) => { setDate(d); setTab('today'); }}
        />
      )}

      {/* ── TAB: timeline + handover ──────────────────────────── */}
      {tab === 'timeline' && (
        <TimelineTab date={date} operatorName={operatorName} events={events} reload={loadTimeline} card={card} />
      )}

      {/* ── TAB: recurring ────────────────────────────────────── */}
      {tab === 'recurring' && (
        <RecurringTab templates={templates} tasks={tasks} reload={loadTemplates} card={card} />
      )}

      {/* ── TAB: AI ───────────────────────────────────────────── */}
      {tab === 'ai' && <AssistantTab operatorName={operatorName} onAfterAction={loadTasks} card={card} />}
    </div>
  );
};

// ─── Timeline + Handover ────────────────────────────────────────
const TimelineTab: React.FC<{ date: string; operatorName: string | null; events: TimelineEvent[]; reload: () => void; card: React.CSSProperties }> =
  ({ date, operatorName, events, reload, card }) => {
    const [note, setNote] = useState('');
    const [shift, setShift] = useState('กะเช้า');
    const timeOf = (iso: string) => { try { return new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
    const send = async () => {
      if (!note.trim()) return;
      await fetch(`${apiUrl}/api/handover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, shift, operator: operatorName, text: note.trim() }),
      });
      setNote(''); reload();
    };
    return (
      <div>
        <div style={{ ...card }}>
          <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#37474f', marginBottom: '8px' }}>📝 บันทึกส่งเวร</div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <select value={shift} onChange={e => setShift(e.target.value)} style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '10px' }}>
              <option>กะเช้า</option><option>กะบ่าย</option><option>กะดึก</option>
            </select>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="ค้างอะไรไว้ / ต้องสานต่ออะไร"
              style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '10px' }} />
            <button onClick={send} style={{ padding: '8px 14px', borderRadius: '10px', border: 'none', background: '#ff6b00', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>ส่ง</button>
          </div>
        </div>
        <div style={{ position: 'relative', paddingLeft: '18px', marginTop: '8px' }}>
          <div style={{ position: 'absolute', left: '6px', top: 0, bottom: 0, width: '2px', background: '#eee' }} />
          {events.map((e, i) => (
            <div key={i} style={{ position: 'relative', marginBottom: '14px' }}>
              <div style={{ position: 'absolute', left: '-15px', top: '4px', width: '10px', height: '10px', borderRadius: '50%', background: e.type === 'handover' ? '#ff6b00' : e.type === 'production' ? '#2e7d32' : e.type === 'task' ? '#43a047' : '#01579b' }} />
              <div style={{ fontSize: '0.7rem', color: '#9aa0a6' }}>{timeOf(e.time)}{e.operator ? ` · ${e.operator}` : ''}</div>
              <div style={{ fontSize: '0.85rem', color: '#37474f' }}>{e.text}</div>
            </div>
          ))}
          {events.length === 0 && <div style={{ color: '#bbb', fontSize: '0.85rem' }}>ยังไม่มีเหตุการณ์ในวันนี้</div>}
        </div>
      </div>
    );
  };

// ─── Recurring templates + compliance ──────────────────────────
const RecurringTab: React.FC<{ templates: Template[]; tasks: Task[]; reload: () => void; card: React.CSSProperties }> =
  ({ templates, tasks, reload, card }) => {
    const [title, setTitle] = useState('');
    const [cadence, setCadence] = useState('daily');
    const [line, setLine] = useState('');
    const recTasks = tasks.filter(t => t.source === 'recurring');
    const recDone = recTasks.filter(t => t.status === 'done').length;
    const pct = recTasks.length ? Math.round((recDone / recTasks.length) * 100) : 0;
    const add = async () => {
      if (!title.trim()) return;
      await fetch(`${apiUrl}/api/task-templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), line, category: 'maintenance', cadence }),
      });
      setTitle(''); reload();
    };
    const toggleActive = async (t: Template) => {
      await fetch(`${apiUrl}/api/task-templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...t, active: t.active ? 0 : 1 }),
      });
      reload();
    };
    const del = async (id: number) => {
      await fetch(`${apiUrl}/api/task-templates/delete-one`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      reload();
    };
    return (
      <div>
        <div style={{ ...card, textAlign: 'center', background: 'linear-gradient(135deg,#fff8f2,#fff)' }}>
          <div style={{ fontSize: '0.8rem', color: '#78828a' }}>ความครบถ้วนงานประจำวันนี้</div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: pct >= 100 ? '#2e7d32' : '#ff6b00' }}>{pct}%</div>
          <div style={{ fontSize: '0.75rem', color: '#9aa0a6' }}>{recDone}/{recTasks.length} งาน</div>
        </div>
        <div style={{ ...card }}>
          <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#37474f', marginBottom: '8px' }}>➕ เทมเพลตงานประจำ</div>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="เช่น Deep clean ถังผสม"
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid #ddd', borderRadius: '10px', marginBottom: '8px' }} />
          <div style={{ display: 'flex', gap: '8px' }}>
            <select value={line} onChange={e => setLine(e.target.value)} style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '10px' }}>
              <option value="">ทั่วไป</option><option>Line 1</option><option>Line 2</option><option>Line 3</option><option>Line 4</option>
            </select>
            <select value={cadence} onChange={e => setCadence(e.target.value)} style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '10px' }}>
              <option value="daily">ทุกวัน</option><option value="weekly">ทุกสัปดาห์</option><option value="monthly">ทุกเดือน</option>
            </select>
            <button onClick={add} style={{ padding: '8px 14px', borderRadius: '10px', border: 'none', background: '#ff6b00', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>เพิ่ม</button>
          </div>
        </div>
        {templates.map(t => (
          <div key={t.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: '10px', opacity: t.active ? 1 : 0.5 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: '#37474f' }}>🔧 {t.title}</div>
              <div style={{ fontSize: '0.72rem', color: '#9aa0a6' }}>{t.line_name || 'ทั่วไป'} · {t.cadence === 'daily' ? 'ทุกวัน' : t.cadence === 'weekly' ? 'ทุกสัปดาห์' : 'ทุกเดือน'}</div>
            </div>
            <button onClick={() => toggleActive(t)} style={{ border: '1px solid #eee', background: '#fff', borderRadius: '8px', padding: '4px 10px', cursor: 'pointer', fontSize: '0.75rem' }}>{t.active ? 'ปิด' : 'เปิด'}</button>
            <button onClick={() => del(t.id)} style={{ border: 'none', background: 'none', color: '#ccc', cursor: 'pointer', fontSize: '1.1rem' }}>×</button>
          </div>
        ))}
        {templates.length === 0 && <div style={{ textAlign: 'center', color: '#bbb', padding: '16px', fontSize: '0.85rem' }}>ยังไม่มีเทมเพลตงานประจำ</div>}
      </div>
    );
  };

// ─── Calendar (schedule future tasks) ──────────────────────────
const ymd = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const THAI_WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

type DayCount = { total: number; done: number };

const CalendarTab: React.FC<{ operatorName: string | null; card: React.CSSProperties; onOpenDate: (date: string) => void }> =
  ({ operatorName, card, onOpenDate }) => {
    const now = new Date(todayBKK() + 'T00:00:00');
    const [view, setView] = useState({ y: now.getFullYear(), m: now.getMonth() });
    const [counts, setCounts] = useState<Record<string, DayCount>>({});
    const [selected, setSelected] = useState<string>(todayBKK());
    const [dayTasks, setDayTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(false);
    const today = todayBKK();

    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    const startWeekday = new Date(view.y, view.m, 1).getDay();

    const loadCounts = useCallback(async () => {
      const from = ymd(view.y, view.m, 1);
      const to = ymd(view.y, view.m, daysInMonth);
      try {
        const r = await fetch(`${apiUrl}/api/tasks/calendar?from=${from}&to=${to}`);
        const d = await r.json();
        const map: Record<string, DayCount> = {};
        for (const day of d.days || []) map[day.date] = { total: day.total, done: day.done };
        setCounts(map);
      } catch { /* offline */ }
    }, [view.y, view.m, daysInMonth]);

    const loadDay = useCallback(async (date: string) => {
      setLoading(true);
      try {
        const r = await fetch(`${apiUrl}/api/tasks?date=${date}`);
        const d = await r.json();
        setDayTasks(d.items || []);
      } catch { setDayTasks([]); } finally { setLoading(false); }
    }, []);

    useEffect(() => { loadCounts(); }, [loadCounts]);
    useEffect(() => { loadDay(selected); }, [selected, loadDay]);

    const shiftMonth = (delta: number) => {
      setView(v => {
        const d = new Date(v.y, v.m + delta, 1);
        return { y: d.getFullYear(), m: d.getMonth() };
      });
    };

    // quick add for the selected day
    const [newTitle, setNewTitle] = useState('');
    const [newLine, setNewLine] = useState('');
    const [newCat, setNewCat] = useState('manual');
    const addTask = async () => {
      if (!newTitle.trim()) return;
      await fetch(`${apiUrl}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: selected, line: newLine, category: newCat, title: newTitle.trim(), operator: operatorName }),
      });
      setNewTitle('');
      await Promise.all([loadDay(selected), loadCounts()]);
    };
    const deleteTask = async (id: number) => {
      setDayTasks(ts => ts.filter(x => x.id !== id));
      await fetch(`${apiUrl}/api/tasks/delete-one`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      await loadCounts();
    };

    const cells: (number | null)[] = [
      ...Array(startWeekday).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ];

    const selDate = new Date(selected + 'T00:00:00');
    const selLabel = `${selDate.getDate()} ${THAI_MONTHS[selDate.getMonth()]} ${selDate.getFullYear() + 543}`;
    const isFuture = selected > today;

    return (
      <div>
        {/* month header */}
        <div style={{ ...card, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <button onClick={() => shiftMonth(-1)} style={{ border: '1px solid #eee', background: '#fff', borderRadius: '10px', padding: '6px 12px', cursor: 'pointer', fontSize: '1rem' }}>‹</button>
            <div style={{ fontWeight: 800, color: '#37474f', fontSize: '0.95rem' }}>{THAI_MONTHS[view.m]} {view.y + 543}</div>
            <button onClick={() => shiftMonth(1)} style={{ border: '1px solid #eee', background: '#fff', borderRadius: '10px', padding: '6px 12px', cursor: 'pointer', fontSize: '1rem' }}>›</button>
          </div>
          {/* weekday row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '4px' }}>
            {THAI_WEEKDAYS.map((w, i) => (
              <div key={w} style={{ textAlign: 'center', fontSize: '0.68rem', fontWeight: 700, color: i === 0 ? '#e53935' : '#9aa0a6', padding: '2px 0' }}>{w}</div>
            ))}
          </div>
          {/* day grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
            {cells.map((d, i) => {
              if (d === null) return <div key={`b${i}`} />;
              const ds = ymd(view.y, view.m, d);
              const c = counts[ds];
              const isToday = ds === today;
              const isSel = ds === selected;
              const isPast = ds < today;
              const allDone = c && c.done >= c.total && c.total > 0;
              return (
                <button key={ds} onClick={() => setSelected(ds)} style={{
                  position: 'relative', aspectRatio: '1', border: '2px solid',
                  borderColor: isSel ? '#ff6b00' : isToday ? '#ffd0a6' : 'transparent',
                  background: isSel ? '#fff3e9' : '#fafafa', borderRadius: '10px', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  color: isPast ? '#c5cbd0' : '#37474f', fontWeight: isToday ? 800 : 500, fontSize: '0.82rem', padding: 0,
                }}>
                  {d}
                  {c && c.total > 0 && (
                    <span style={{
                      marginTop: '2px', minWidth: '15px', height: '15px', lineHeight: '15px', padding: '0 3px',
                      borderRadius: '8px', fontSize: '0.58rem', fontWeight: 800, color: '#fff',
                      background: allDone ? '#2e7d32' : '#ff8c00',
                    }}>{c.done}/{c.total}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* selected day panel */}
        <div style={{ ...card }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div>
              <div style={{ fontWeight: 800, color: '#37474f', fontSize: '0.9rem' }}>
                {selected === today ? '📅 วันนี้' : isFuture ? '🔮 งานล่วงหน้า' : '📅 ย้อนหลัง'}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#9aa0a6' }}>{selLabel}</div>
            </div>
            <button onClick={() => onOpenDate(selected)} style={{ border: '1px solid #eee', background: '#fff', borderRadius: '10px', padding: '6px 12px', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700, color: '#ff6b00' }}>เปิดเต็ม →</button>
          </div>

          {loading && <div style={{ color: '#9aa0a6', fontSize: '0.8rem', padding: '4px 0' }}>กำลังโหลด…</div>}
          {!loading && dayTasks.length === 0 && (
            <div style={{ textAlign: 'center', color: '#bbb', padding: '14px', fontSize: '0.82rem' }}>ยังไม่มีงานในวันนี้ — เพิ่มด้านล่างได้เลย</div>
          )}
          {dayTasks.map(t => {
            const st = STATUS_STYLE[t.status] || STATUS_STYLE.pending;
            const cat = CAT[t.category] || CAT.manual;
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', borderBottom: '1px solid #f4f4f4' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: '#37474f', fontSize: '0.85rem', textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>
                    {cat.icon} {t.title}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: '#9aa0a6' }}>{t.line_name || 'ทั่วไป'}</div>
                </div>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '2px 7px', borderRadius: '8px', background: st.bg, color: st.fg, flexShrink: 0 }}>{st.label}</span>
                {t.source === 'manual' && (
                  <button onClick={() => deleteTask(t.id)} title="ลบ" style={{ border: 'none', background: 'none', color: '#ccc', cursor: 'pointer', fontSize: '1rem' }}>×</button>
                )}
              </div>
            );
          })}

          {/* quick add for this day */}
          <div style={{ marginTop: '12px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '0.82rem', color: '#37474f', marginBottom: '8px' }}>➕ นัดหมายงานวันนี้</div>
            <input value={newTitle} onChange={e => setNewTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()}
              placeholder="ชื่องาน เช่น Deep clean Line 3"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid #ddd', borderRadius: '10px', marginBottom: '8px' }} />
            <div style={{ display: 'flex', gap: '8px' }}>
              <select value={newLine} onChange={e => setNewLine(e.target.value)} style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '10px' }}>
                <option value="">ทั่วไป</option><option>Line 1</option><option>Line 2</option><option>Line 3</option><option>Line 4</option>
              </select>
              <select value={newCat} onChange={e => setNewCat(e.target.value)} style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: '10px' }}>
                {Object.entries(CAT).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
              </select>
              <button onClick={addTask} style={{ padding: '8px 16px', borderRadius: '10px', border: 'none', background: '#ff6b00', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>เพิ่ม</button>
            </div>
          </div>
        </div>
      </div>
    );
  };

// ─── Duty board (งานตามหน้าที่รับผิดชอบรายบุคคล) ─────────────────
const DutyBoard: React.FC<{ date: string; operatorName: string | null; card: React.CSSProperties }> =
  ({ date, operatorName, card }) => {
    const [duty, setDuty] = useState<Duty | null>(null);
    const [loading, setLoading] = useState(false);
    const [pick, setPick] = useState('');       // "personKey|nodeKey" ที่กำลังเลือกเหตุผลข้าม
    const [handoffKey, setHandoffKey] = useState(''); // key เดียวกันเมื่อเลือก "ให้คนอื่นทำแทน"
    const [tgMsg, setTgMsg] = useState('');

    const load = useCallback(async () => {
      setLoading(true);
      try { const r = await fetch(`${apiUrl}/api/duty?date=${date}`); setDuty(await r.json()); }
      catch { /* offline */ } finally { setLoading(false); }
    }, [date]);
    useEffect(() => { load(); }, [load]);

    const post = async (url: string, body: Record<string, unknown>) => {
      await fetch(`${apiUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await load();
    };
    const toggleNode = (pKey: string, n: DutyNode) => post('/api/routine/toggle', { date, assignee: pKey, nodeKey: n.key, title: n.title, checked: !n.checked });
    const toggleReceived = (r: Received) => post('/api/routine/toggle', { date, assignee: r.ownerKey, nodeKey: r.nodeKey, checked: !r.checked });
    const restore = (pKey: string, n: DutyNode) => post('/api/routine/restore', { date, assignee: pKey, nodeKey: n.key });
    const doBypass = (pKey: string, n: DutyNode, reason: string, handoffTo?: string) => {
      setPick(''); setHandoffKey('');
      return post('/api/routine/bypass', { date, assignee: pKey, nodeKey: n.key, title: n.title, reason, handoffTo });
    };
    const onReason = (pKey: string, n: DutyNode, val: string) => {
      if (!val) return;
      if (val === 'ให้คนอื่นทำแทน') setHandoffKey(`${pKey}|${n.key}`);
      else doBypass(pKey, n, val);
    };
    const toggleAdhoc = (t: AdhocTask) => post('/api/tasks/update', { id: t.id, status: t.status === 'done' ? 'pending' : 'done' });
    const delAdhoc = (id: number) => post('/api/tasks/delete-one', { id });

    // assign form
    const [assignTo, setAssignTo] = useState('mam');
    const [cat, setCat] = useState('production');
    const [title, setTitle] = useState('');
    const [loc, setLoc] = useState(LOCATIONS[0]);
    const [prio, setPrio] = useState('normal');
    const assign = async () => {
      if (!title.trim()) return;
      await post('/api/duty/assign', { date, assignTo, category: cat, title: title.trim(), location: loc, priority: prio, operator: operatorName });
      setTitle('');
    };

    const sendTg = async () => {
      setTgMsg('กำลังส่ง…');
      try {
        const r = await fetch(`${apiUrl}/api/duty/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) });
        const d = await r.json();
        setTgMsg(d.sent ? '✅ ส่งเข้า Telegram แล้ว' : '⚠️ ยังไม่ได้ตั้งค่า Telegram บนเซิร์ฟเวอร์');
      } catch { setTgMsg('❌ ส่งไม่สำเร็จ'); }
    };

    // shared styles
    const cb = (dis: boolean): React.CSSProperties => ({ width: 19, height: 19, flexShrink: 0, cursor: dis ? 'default' : 'pointer', opacity: dis ? 0.3 : 1, accentColor: '#2e7d32' });
    const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' };
    const badge: React.CSSProperties = { fontSize: '0.6rem', fontWeight: 800, borderRadius: 20, padding: '2px 8px', flexShrink: 0, whiteSpace: 'nowrap' };
    const bpBtn: React.CSSProperties = { border: 'none', background: 'none', color: '#b0b8bd', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', padding: '3px 7px', borderRadius: 7, flexShrink: 0 };
    const sel: React.CSSProperties = { fontFamily: 'inherit', fontSize: '0.72rem', fontWeight: 700, color: '#ff6b00', background: '#fff3e9', border: '1px dashed #ff8c00', borderRadius: 9, padding: '5px 7px', flexShrink: 0 };
    const subLbl: React.CSSProperties = { fontSize: '0.68rem', fontWeight: 800, letterSpacing: '.04em', color: '#9aa0a6', textTransform: 'uppercase', margin: '10px 0 2px' };
    const chip = (on: boolean, color = '#ff6b00'): React.CSSProperties => ({ border: '2px solid', borderColor: on ? 'transparent' : '#e0e0e0', background: on ? color : '#fff', color: on ? '#fff' : '#666', borderRadius: 22, padding: '7px 13px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer' });

    if (!duty) return <div style={{ textAlign: 'center', color: '#bbb', padding: 24 }}>{loading ? 'กำลังโหลด…' : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'}</div>;

    return (
      <div>
        {/* team overview */}
        <div style={{ ...card, background: 'linear-gradient(135deg,#fff,#fff8f2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <div><div style={subLbl}>ความคืบหน้าทีมวันนี้</div><div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#ff6b00' }}>{duty.team.pct}%<small style={{ fontSize: '0.8rem', color: '#9aa0a6', fontWeight: 600 }}> เสร็จ</small></div></div>
            <div style={{ textAlign: 'right' }}><div style={subLbl}>งานคงค้าง</div><div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#e65100' }}>{duty.team.left}<small style={{ fontSize: '0.8rem', color: '#9aa0a6', fontWeight: 600 }}> งาน</small></div></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
            {duty.people.map(p => { const col = DUTY_COLOR[p.key] || { c: '#607d8b', wash: '#eee', initial: p.name[0] }; return (
              <div key={p.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '9px 4px', border: '1px solid #eee', borderRadius: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 800, color: '#fff', fontSize: '0.85rem', background: col.c }}>{col.initial}</div>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: col.c }}>{p.name}</div>
                <div style={{ width: '100%', height: 5, borderRadius: 4, background: '#eceff1', overflow: 'hidden' }}><div style={{ height: '100%', width: `${p.pct}%`, background: col.c }} /></div>
                <div style={{ fontSize: '0.7rem', color: '#9aa0a6', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{p.done}/{p.total}</div>
              </div>
            ); })}
          </div>
        </div>

        {/* person cards */}
        {duty.people.map(p => { const col = DUTY_COLOR[p.key] || { c: '#607d8b', wash: '#eee', initial: p.name[0] }; return (
          <div key={p.key} style={{ ...card, padding: 0, overflow: 'hidden', borderTop: `3px solid ${col.c}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', background: col.wash }}>
              <div style={{ width: 38, height: 38, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 800, color: '#fff', background: col.c }}>{col.initial}</div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 800 }}>คุณ {p.name}</div><div style={{ fontSize: '0.72rem', color: '#78828a' }}>{p.role}</div></div>
              <div style={{ fontWeight: 800, color: col.c, fontVariantNumeric: 'tabular-nums' }}>{p.pct}%</div>
            </div>
            <div style={{ padding: '8px 15px 14px' }}>
              {p.nodes.map(n => { const gk = `${p.key}|${n.key}`; return (
                <div key={gk} style={{ ...row, marginLeft: n.depth * 22 }}>
                  <input type="checkbox" disabled={n.bypassed} checked={n.checked} onChange={() => toggleNode(p.key, n)} style={cb(n.bypassed)} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: '0.88rem', fontWeight: 500, fontFamily: n.mono ? 'ui-monospace, Menlo, monospace' : 'inherit', color: n.bypassed ? '#b0b8bd' : (n.checked ? '#9aa0a6' : '#37474f'), textDecoration: (n.checked || n.bypassed) ? 'line-through' : 'none' }}>{n.title}</span>
                  {n.bypassed ? (<>
                    <span style={{ ...badge, background: n.handoffTo ? col.c : '#eceff1', color: n.handoffTo ? '#fff' : '#607d8b' }}>{n.handoffTo ? `มอบให้ ${n.handoffToName}` : `ข้าม · ${n.bypassReason}`}</span>
                    <button onClick={() => restore(p.key, n)} style={{ ...bpBtn, color: '#ff6b00' }}>คืนงาน</button>
                  </>) : pick === gk ? (<>
                    <select value="" onChange={e => onReason(p.key, n, e.target.value)} style={sel}>
                      <option value="">เลือกเหตุผล…</option>
                      {BYPASS_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    {handoffKey === gk && (
                      <select value="" onChange={e => e.target.value && doBypass(p.key, n, 'ให้คนอื่นทำแทน', e.target.value)} style={sel}>
                        <option value="">เลือกคน…</option>
                        {duty.people.filter(x => x.key !== p.key).map(x => <option key={x.key} value={x.key}>{x.name}</option>)}
                      </select>
                    )}
                    <button onClick={() => { setPick(''); setHandoffKey(''); }} style={bpBtn}>✕</button>
                  </>) : (
                    <button onClick={() => { setPick(gk); setHandoffKey(''); }} style={bpBtn}>ข้าม</button>
                  )}
                </div>
              ); })}

              {p.received.length > 0 && <div style={subLbl}>🔁 รับมอบต่อ</div>}
              {p.received.map(r => (
                <div key={`${r.ownerKey}/${r.nodeKey}`} style={row}>
                  <input type="checkbox" checked={r.checked} onChange={() => toggleReceived(r)} style={cb(false)} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: '0.88rem', fontWeight: 500, color: r.checked ? '#9aa0a6' : '#37474f', textDecoration: r.checked ? 'line-through' : 'none' }}>{r.title}</span>
                  <span style={{ ...badge, background: '#e8eaf6', color: '#3949ab' }}>รับจาก {r.fromName}</span>
                </div>
              ))}

              {p.adhoc.length > 0 && <div style={subLbl}>📌 งานมอบหมาย</div>}
              {p.adhoc.map(t => { const c = CAT[t.category] || CAT.manual; return (
                <div key={t.id} style={row}>
                  <input type="checkbox" checked={t.status === 'done'} onChange={() => toggleAdhoc(t)} style={cb(false)} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: '0.88rem', fontWeight: 500, color: t.status === 'done' ? '#9aa0a6' : '#37474f', textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{c.icon} {t.title}{t.location ? <small style={{ color: '#9aa0a6' }}> · 📍{t.location}</small> : null}</span>
                  {t.priority === 'urgent' && <span style={{ ...badge, background: '#ffebee', color: '#c62828' }}>🔴 ด่วน</span>}
                  <button onClick={() => delAdhoc(t.id)} title="ลบ" style={{ ...bpBtn, fontSize: '1rem', color: '#ccc' }}>×</button>
                </div>
              ); })}
            </div>
          </div>
        ); })}

        {/* assign form */}
        <div style={{ ...card }}>
          <div style={{ fontWeight: 800, fontSize: '0.9rem', marginBottom: 12 }}>➕ มอบหมายงานระหว่างวัน</div>
          <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 7 }}>ส่งให้</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {duty.people.map(p => <button key={p.key} onClick={() => setAssignTo(p.key)} style={chip(assignTo === p.key, (DUTY_COLOR[p.key] || {}).c || '#ff6b00')}>{p.name}</button>)}
          </div>
          <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 7 }}>ประเภทงาน</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {['production', 'cip', 'am', 'manual'].map(k => <button key={k} onClick={() => setCat(k)} style={chip(cat === k)}>{CAT[k].icon} {CAT[k].label}</button>)}
          </div>
          <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && assign()} placeholder="ชื่องาน เช่น เปลี่ยนกรอง Line 3 ก่อนรอบบ่าย"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px', border: '1px solid #ddd', borderRadius: 11, marginBottom: 10 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <select value={loc} onChange={e => setLoc(e.target.value)} style={{ padding: 10, border: '1px solid #ddd', borderRadius: 11 }}>{LOCATIONS.map(l => <option key={l}>{l}</option>)}</select>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setPrio('normal')} style={{ ...chip(prio === 'normal', '#546e7a'), flex: 1, textAlign: 'center' }}>ปกติ</button>
              <button onClick={() => setPrio('urgent')} style={{ ...chip(prio === 'urgent', '#c62828'), flex: 1, textAlign: 'center' }}>🔴 ด่วน</button>
            </div>
          </div>
          <button onClick={assign} style={{ width: '100%', border: 'none', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '0.92rem', color: '#fff', background: 'linear-gradient(135deg,#ff6b00,#ff8c00)', cursor: 'pointer' }}>📨 มอบหมายงาน &amp; แจ้งเตือน</button>
        </div>

        {/* telegram summary */}
        <button onClick={sendTg} style={{ width: '100%', border: 'none', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '0.9rem', color: '#fff', background: '#229ed9', cursor: 'pointer' }}>✈ ส่งสรุปเข้า Telegram</button>
        {tgMsg && <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#78828a', marginTop: 8 }}>{tgMsg}</div>}
      </div>
    );
  };

// ─── Assistant chat ─────────────────────────────────────────────
const AssistantTab: React.FC<{ operatorName: string | null; onAfterAction: () => void; card: React.CSSProperties }> =
  ({ operatorName, onAfterAction, card }) => {
    const [msgs, setMsgs] = useState<ChatMsg[]>([{ role: 'assistant', text: 'สวัสดีครับ พิมพ์เล่าได้เลย เช่น "Line 1 ผลิต Amazon 5 batch แล้ว CIP" หรือถามว่า "วันนี้ Line 2 ทำอะไรไปแล้วบ้าง"' }]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const endRef = useRef<HTMLDivElement>(null);
    useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);
    const send = async () => {
      const text = input.trim();
      if (!text || busy) return;
      setMsgs(m => [...m, { role: 'user', text }]); setInput(''); setBusy(true);
      try {
        const r = await fetch(`${apiUrl}/api/assistant`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, operator: operatorName, session: `web-${operatorName || 'guest'}` }),
        });
        const d = await r.json();
        setMsgs(m => [...m, { role: 'assistant', text: d.reply || d.error || 'ขออภัย เกิดข้อผิดพลาด' }]);
        if (d.actions && d.actions.length) onAfterAction();
      } catch {
        setMsgs(m => [...m, { role: 'assistant', text: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' }]);
      } finally { setBusy(false); }
    };
    return (
      <div style={{ ...card, display: 'flex', flexDirection: 'column', height: '70vh', padding: '0', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: '10px' }}>
              <div style={{
                maxWidth: '80%', padding: '10px 14px', borderRadius: '16px', fontSize: '0.88rem', lineHeight: 1.5, whiteSpace: 'pre-wrap',
                background: m.role === 'user' ? 'linear-gradient(135deg,#ff6b00,#ff8c00)' : '#f4f5f6',
                color: m.role === 'user' ? '#fff' : '#37474f',
                borderBottomRightRadius: m.role === 'user' ? '4px' : '16px',
                borderBottomLeftRadius: m.role === 'user' ? '16px' : '4px',
              }}>{m.text}</div>
            </div>
          ))}
          {busy && <div style={{ color: '#9aa0a6', fontSize: '0.8rem' }}>กำลังคิด…</div>}
          <div ref={endRef} />
        </div>
        <div style={{ display: 'flex', gap: '8px', padding: '10px', borderTop: '1px solid #eee', background: '#fff' }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
            placeholder="พิมพ์ข้อความ…" style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: '12px' }} />
          <button onClick={send} disabled={busy} style={{ padding: '10px 18px', borderRadius: '12px', border: 'none', background: '#ff6b00', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>ส่ง</button>
        </div>
      </div>
    );
  };

export default TodoBoard;
