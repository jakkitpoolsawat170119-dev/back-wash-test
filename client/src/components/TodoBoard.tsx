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
  maintenance: { icon: '🔧', label: 'ซ่อมบำรุง' },
  manual: { icon: '📌', label: 'อื่นๆ' },
};
const LINE_COLOR: Record<string, string> = {
  'Line 1': '#0d47a1', 'Line 2': '#01579b', 'Line 3': '#006064', 'Line 4': '#4a7c59',
};
const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  done: { bg: '#e8f5e9', fg: '#2e7d32', label: 'เสร็จ' },
  in_progress: { bg: '#fff3e0', fg: '#e65100', label: 'กำลังทำ' },
  pending: { bg: '#f5f5f5', fg: '#757575', label: 'รอทำ' },
  skipped: { bg: '#fafafa', fg: '#bdbdbd', label: 'ข้าม' },
};
const LINE_ORDER = ['Line 1', 'Line 2', 'Line 3', 'Line 4', ''];

interface Props { operatorName: string | null; onBackToMain: () => void; }

const TodoBoard: React.FC<Props> = ({ operatorName, onBackToMain }) => {
  const [tab, setTab] = useState<'today' | 'timeline' | 'recurring' | 'ai'>('today');
  const [date, setDate] = useState(todayBKK());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);

  // ── data loaders ───────────────────────────────────────────────
  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/tasks?date=${date}`);
      const d = await r.json();
      setTasks(d.items || []);
    } catch { /* offline */ } finally { setLoading(false); }
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

  useEffect(() => { if (tab === 'today') loadTasks(); }, [tab, loadTasks]);
  useEffect(() => { if (tab === 'timeline') loadTimeline(); }, [tab, loadTimeline]);
  useEffect(() => { if (tab === 'recurring') { loadTemplates(); loadTasks(); } }, [tab, loadTemplates, loadTasks]);

  // ── actions ────────────────────────────────────────────────────
  const generateFromPlan = async () => {
    setLoading(true);
    try {
      await fetch(`${apiUrl}/api/tasks/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, operator: operatorName }),
      });
      await loadTasks();
    } finally { setLoading(false); }
  };

  const toggleTask = async (t: Task) => {
    const next = t.status === 'done' ? 'pending' : 'done';
    setTasks(ts => ts.map(x => x.id === t.id ? { ...x, status: next } : x)); // optimistic
    await fetch(`${apiUrl}/api/tasks/update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: t.id, status: next }),
    });
  };

  const deleteTask = async (id: number) => {
    setTasks(ts => ts.filter(x => x.id !== id));
    await fetch(`${apiUrl}/api/tasks/delete-one`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
  };

  // ── manual add task ────────────────────────────────────────────
  const [newTitle, setNewTitle] = useState('');
  const [newLine, setNewLine] = useState('');
  const [newCat, setNewCat] = useState('manual');
  const addTask = async () => {
    if (!newTitle.trim()) return;
    await fetch(`${apiUrl}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, line: newLine, category: newCat, title: newTitle.trim(), operator: operatorName }),
    });
    setNewTitle('');
    await loadTasks();
  };

  // group tasks by line
  const byLine: Record<string, Task[]> = {};
  for (const t of tasks) { (byLine[t.line_name] ||= []).push(t); }
  const lineKeys = Object.keys(byLine).sort((a, b) => {
    const ia = LINE_ORDER.indexOf(a), ib = LINE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const doneCount = tasks.filter(t => t.status === 'done').length;

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
          ['today', '📋 งานวันนี้'], ['timeline', '🕐 ไทม์ไลน์'], ['recurring', '🔁 งานประจำ'], ['ai', '🤖 ผู้ช่วย AI'],
        ] as [typeof tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            flex: '0 0 auto', padding: '7px 13px', borderRadius: '20px', border: '2px solid',
            borderColor: tab === k ? '#ff6b00' : '#e0e0e0', background: tab === k ? '#ff6b00' : '#f5f5f5',
            color: tab === k ? '#fff' : '#666', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
      </div>

      {/* ── TAB: today ─────────────────────────────────────────── */}
      {tab === 'today' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <button onClick={generateFromPlan} disabled={loading} style={{
              flex: 1, padding: '10px', borderRadius: '12px', border: 'none', cursor: 'pointer', color: '#fff',
              background: 'linear-gradient(135deg, #ff6b00, #ff8c00)', fontWeight: 700, fontSize: '0.9rem',
            }}>⚡ สร้างงานจากแผนผลิต</button>
            <button onClick={loadTasks} style={{ padding: '10px 12px', borderRadius: '12px', border: '1px solid #eee', background: '#fff', cursor: 'pointer' }}>↻</button>
          </div>
          <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#78828a', marginBottom: '12px' }}>
            เสร็จแล้ว <b style={{ color: '#2e7d32' }}>{doneCount}</b> / {tasks.length} งาน
          </div>

          {lineKeys.map(line => (
            <div key={line || 'misc'} style={{ marginBottom: '6px' }}>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', color: LINE_COLOR[line] || '#607d8b', margin: '4px 2px 6px' }}>
                {line || '🗂 ทั่วไป'}
              </div>
              {byLine[line].map(t => {
                const st = STATUS_STYLE[t.status] || STATUS_STYLE.pending;
                const cat = CAT[t.category] || CAT.manual;
                const pct = t.target_count ? Math.min(100, Math.round((t.actual_count / t.target_count) * 100)) : (t.status === 'done' ? 100 : 0);
                return (
                  <div key={t.id} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    <input type="checkbox" checked={t.status === 'done'} onChange={() => toggleTask(t)}
                      style={{ width: '20px', height: '20px', marginTop: '2px', cursor: 'pointer', flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, color: '#37474f', textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>
                        {cat.icon} {t.title}
                      </div>
                      {t.detail && <div style={{ fontSize: '0.74rem', color: '#9aa0a6', marginTop: '2px' }}>{t.detail}</div>}
                      {t.target_count ? (
                        <div style={{ marginTop: '6px' }}>
                          <div style={{ height: '6px', background: '#eee', borderRadius: '4px', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: pct >= 100 ? '#2e7d32' : '#ff8c00', transition: 'width 0.3s' }} />
                          </div>
                          <div style={{ fontSize: '0.68rem', color: '#9aa0a6', marginTop: '2px' }}>{t.actual_count}/{t.target_count}</div>
                        </div>
                      ) : null}
                    </div>
                    <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '3px 8px', borderRadius: '8px', background: st.bg, color: st.fg, flexShrink: 0 }}>{st.label}</span>
                    {t.source === 'manual' && (
                      <button onClick={() => deleteTask(t.id)} title="ลบ" style={{ border: 'none', background: 'none', color: '#ccc', cursor: 'pointer', fontSize: '1rem' }}>×</button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {tasks.length === 0 && <div style={{ textAlign: 'center', color: '#bbb', padding: '24px', fontSize: '0.85rem' }}>ยังไม่มีงาน — กด "สร้างงานจากแผนผลิต" หรือเพิ่มงานเองด้านล่าง</div>}

          {/* manual add */}
          <div style={{ ...card, marginTop: '14px' }}>
            <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#37474f', marginBottom: '8px' }}>➕ เพิ่มงานเอง</div>
            <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="ชื่องาน เช่น ตรวจน้ำยา CIP"
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
