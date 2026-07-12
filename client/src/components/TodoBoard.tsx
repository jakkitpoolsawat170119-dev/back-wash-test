import React, { useState, useEffect, useCallback, useRef } from 'react';
import { currentWorkDay, shiftInfo, shiftsForWeekday, weekdayOf, nextShiftName } from '../shiftSchedule';

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
type PendingAction = { id: number; tool: string; summary: string; status?: 'pending' | 'approved' | 'rejected' | 'error'; result?: string };
type ChatMsg = { role: 'user' | 'assistant'; text: string; pending?: PendingAction[]; images?: string[] };

const CAT: Record<string, { icon: string; label: string }> = {
  production: { icon: '🏭', label: 'ผลิต' },
  cip: { icon: '💧', label: 'CIP' },
  backwash: { icon: '🧴', label: 'Backwash' },
  mixing: { icon: '🥤', label: 'ส่วนผสม' },
  packing: { icon: '📦', label: 'บรรจุ' },
  maintenance: { icon: '🔧', label: 'ซ่อมบำรุง' },
  manual: { icon: '📌', label: 'ทั่วไป' },
  am: { icon: '🔧', label: 'ซ่อมบำรุง' }, // legacy alias — ข้อมูลเก่าที่บันทึกเป็น 'am' ให้แสดงเป็นซ่อมบำรุง
};
// ลำดับหมวดที่ใช้เลือกใน UI (ไม่รวม alias 'am')
const CAT_KEYS = ['production', 'cip', 'backwash', 'mixing', 'packing', 'maintenance', 'manual'];
// สีประจำหมวด (ยังไม่เลือก = tint อ่อน, เลือกแล้ว = ส้ม)
const CAT_COLOR: Record<string, { c: string; w: string }> = {
  production: { c: '#2e7d32', w: '#e8f5e9' },
  cip: { c: '#0277bd', w: '#e1f2fb' },
  backwash: { c: '#00897b', w: '#e0f2f1' },
  mixing: { c: '#8e24aa', w: '#f5e9fa' },
  packing: { c: '#8d5524', w: '#f3ead9' },
  maintenance: { c: '#546e7a', w: '#eceff1' },
  manual: { c: '#90a4ae', w: '#f0f3f5' },
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
type Duty = { date: string; holiday?: boolean; people: DutyPerson[]; team: { done: number; total: number; left: number; pct: number } };

// ─── Timeline: type + shift metadata ───────────────────────────
const TL_TYPE: Record<string, { c: string; w: string; ic: string; lb: string }> = {
  production: { c: '#2e7d32', w: '#e7f5e8', ic: '🏭', lb: 'ผลิต' },
  cip: { c: '#0277bd', w: '#e1f2fb', ic: '💧', lb: 'CIP' },
  handover: { c: '#ff6b00', w: '#fff3e9', ic: '📤', lb: 'ส่งกะ' },
  'handover-in': { c: '#00897b', w: '#e0f2f1', ic: '📥', lb: 'รับกะ' },
  task: { c: '#43a047', w: '#e8f5e9', ic: '✅', lb: 'ปิดงาน' },
};
const TL_SHIFT: Record<string, { ic: string; c: string }> = {
  'เช้า': { ic: '🌅', c: '#ef8f00' }, 'บ่าย': { ic: '🌆', c: '#c2185b' }, 'ดึก': { ic: '🌙', c: '#3949ab' },
};
// ดึง HH:MM จาก string เวลาแบบ robust (กัน 'Invalid Date' จาก endTime เพี้ยน)
const parseHM = (s?: string): { h: number; hm: string } | null => {
  const m = String(s || '').match(/(?:T|\s|^)(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  return { h, hm: `${String(h).padStart(2, '0')}:${m[2]}` };
};
interface Props { operatorName: string | null; onBackToMain: () => void; }

const TodoBoard: React.FC<Props> = ({ operatorName, onBackToMain }) => {
  const [tab, setTab] = useState<'today' | 'calendar' | 'report' | 'timeline' | 'recurring' | 'ai' | 'specs'>('today');
  const [date, setDate] = useState(currentWorkDay());
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
          ['today', '✅ งานวันนี้'], ['recurring', '🔁 งานประจำ'], ['timeline', '🕐 ไทม์ไลน์'], ['calendar', '📊 สรุป & KPI'], ['report', '📤 ส่งรายงาน'], ['ai', '🤖 ผู้ช่วย AI'], ['specs', '🧪 สเปกคุณภาพ'],
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
        <CalendarTab card={card} onOpenDate={(d) => { setDate(d); setTab('today'); }} />
      )}

      {/* ── TAB: report ───────────────────────────────────────── */}
      {tab === 'report' && <ReportTab card={card} />}

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

      {/* ── TAB: สเปกคุณภาพ (baseline Brix/pH) ─────────────────── */}
      {tab === 'specs' && <SpecsTab card={card} />}
    </div>
  );
};

// ─── Timeline + Handover ────────────────────────────────────────
// ─── Structured shift-handover form ────────────────────────────
const HO_L4_STAGES = ['Mixing 1', 'Mixer', 'Pasteurizer', 'Mixing 2', 'Storage', 'Filling'];
const HO_SHIFT: Record<string, { ic: string }> = {
  'กะเช้า': { ic: '🌅' }, 'กะบ่าย': { ic: '🌆' }, 'กะดึก': { ic: '🌙' },
};
const HO_LINES = [
  { line: 'Line 1', sub: 'Syrup', c: '#0d47a1' },
  { line: 'Line 2', sub: 'Flavour', c: '#00838f' },
  { line: 'Line 3', sub: 'Flavour', c: '#6a1b9a' },
];
type HoLine = { line: string; flavor: string; batch: string; tanks: string[]; note: string; lotNo: string };
type HoState = { shift: string; lines: HoLine[]; line4: { flavor: string; stages: string[]; lotNo: string }; note: string };
const HO_BATCHES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const initHo = (): HoState => ({
  shift: 'กะเช้า',
  lines: HO_LINES.map(l => ({ line: l.line, flavor: '', batch: '', tanks: ['', '', ''], note: '', lotNo: '' })),
  line4: { flavor: '', stages: ['', '', '', '', '', ''], lotNo: '' },
  note: '',
});
function hoPreview(h: HoState, op: string | null, date: string, kind: 'in' | 'out' = 'out'): string {
  const sm = HO_SHIFT[h.shift] || { ic: '📝' };
  const next = nextShiftName(h.shift, date);
  const head = kind === 'in' ? '📥 รับกะ' : '📋 ส่งกะ';
  const shiftLine = kind === 'in'
    ? `${sm.ic} ${h.shift} · 👤 ${op || '-'}`
    : `${sm.ic} ${h.shift}${next ? ` → ${next}` : ''} · 👤 ${op || '-'}`;
  const L = [head, shiftLine, ''];
  for (const ln of h.lines) {
    L.push(`▶️ ${ln.line} ${ln.flavor}${ln.batch ? ` (Batch ${ln.batch})` : ''}`.trimEnd());
    ln.tanks.forEach((tk, i) => L.push(`   ถัง ${i + 1} ${tk.trim() || 'ว่าง'}`));
    if (ln.note.trim()) L.push(`   (${ln.note.trim()})`);
    if ((ln.lotNo || '').trim()) L.push(`   (Lot no ${ln.lotNo.trim()})`);
    L.push('  ————————————');
  }
  L.push(`▶️ Line 4 ${h.line4.flavor}`.trimEnd());
  HO_L4_STAGES.forEach((nm, i) => L.push(`   ${nm} — ${(h.line4.stages[i] || '').trim() || 'ว่าง'}`));
  if ((h.line4.lotNo || '').trim()) L.push(`   (Lot no ${h.line4.lotNo.trim()})`);
  L.push('  ————————————');
  if (h.note.trim()) L.push('', `📌 ${h.note.trim()}`);
  if (kind === 'in') L.push('', '✅ รับทราบสถานะครบ');
  return L.join('\n');
}
// map ผลจาก /api/handover/prefill (รส/batch ล่าสุดต่อไลน์) → HoState สำหรับโหมดส่งกะ
type PrefillLine = { flavor?: string; batch?: string; cipTime?: string };
function hoFromPrefill(prefill: Record<string, PrefillLine>, carry?: HoState | null): HoState {
  const base = carry || initHo();
  return {
    ...base,
    lines: HO_LINES.map((l, i) => {
      const pf = prefill[l.line] || {};
      const prev = base.lines[i] || { line: l.line, flavor: '', batch: '', tanks: ['', '', ''], note: '', lotNo: '' };
      return { ...prev, line: l.line, flavor: pf.flavor || prev.flavor || '', batch: pf.batch || prev.batch || '' };
    }),
  };
}
// เติม Lot No. รายไลน์ให้เป็นค่าเริ่มต้น (ddmmyy) ถ้ายังว่าง + กัน field undefined จากข้อมูลเก่า
const fillLot = (h: HoState, lot: string): HoState => ({
  ...h,
  lines: h.lines.map(l => ({ ...l, lotNo: l.lotNo || lot })),
  line4: { ...h.line4, lotNo: h.line4.lotNo || lot },
});

const HandoverForm: React.FC<{ date: string; operatorName: string | null; reload: () => void; card: React.CSSProperties; onLiveChange?: (ho: HoState) => void }> =
  ({ date, operatorName, reload, card, onLiveChange }) => {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<'in' | 'out'>('out'); // 📥 รับกะ · 📤 ส่งกะ
    const [ho, setHo] = useState<HoState>(initHo);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');
    const lastRef = useRef<HoState | null>(null);                 // สถานะกะก่อน (สำหรับ รับกะ)
    const prefillRef = useRef<Record<string, PrefillLine>>({});   // รส/batch ล่าสุด (สำหรับ ส่งกะ)

    // เปิดหน้ามา: เดากะปัจจุบัน + โหลดกะก่อน (รับกะ) และรส/batch ล่าสุด (ส่งกะ) พร้อมกัน
    useEffect(() => {
      const bkk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
      const cs = shiftInfo(currentWorkDay(), bkk.getHours()).shift;
      const shift = cs ? 'กะ' + cs : 'กะเช้า';
      (async () => {
        let last: HoState | null = null;
        let prefill: Record<string, PrefillLine> = {};
        try { const d = await (await fetch(`${apiUrl}/api/handover/last`)).json(); if (d.data) last = fillLot({ shift, lines: d.data.lines || initHo().lines, line4: d.data.line4 || initHo().line4, note: '' }, ''); } catch { /* offline */ }
        try { const d = await (await fetch(`${apiUrl}/api/handover/prefill?date=${date}`)).json(); prefill = d.lines || {}; } catch { /* offline */ }
        lastRef.current = last; prefillRef.current = prefill;
        setHo(fillLot({ ...hoFromPrefill(prefill, last), shift }, pkLot(date))); // เริ่มโหมดส่งกะ
      })();
    }, [date]);

    // ส่งสถานะรับกะสดๆ ขึ้นไปให้ฟอร์มบรรจุใช้ (real-time, ไม่ต้องกดส่ง)
    useEffect(() => { onLiveChange?.(ho); }, [ho, onLiveChange]);

    // สลับโหมด: รับกะ = สถานะกะก่อน · ส่งกะ = รส/batch ล่าสุด + ยกถังจากกะก่อน
    const applyMode = (m: 'in' | 'out') => {
      setMode(m); setMsg('');
      setHo(h => fillLot(m === 'in'
        ? (lastRef.current ? { ...lastRef.current, shift: h.shift } : initHo())
        : { ...hoFromPrefill(prefillRef.current, lastRef.current), shift: h.shift }, pkLot(date)));
    };

    const setLine = (i: number, patch: Partial<HoLine>) => setHo(h => ({ ...h, lines: h.lines.map((l, j) => j === i ? { ...l, ...patch } : l) }));
    const setTank = (i: number, t: number, v: string) => setHo(h => ({ ...h, lines: h.lines.map((l, j) => j === i ? { ...l, tanks: l.tanks.map((x, k) => k === t ? v : x) } : l) }));
    const setStage = (i: number, v: string) => setHo(h => ({ ...h, line4: { ...h.line4, stages: h.line4.stages.map((x, k) => k === i ? v : x) } }));

    const send = async () => {
      setBusy(true); setMsg('');
      try {
        await fetch(`${apiUrl}/api/handover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, operator: operatorName, kind: mode, ...ho }) });
        setMsg(mode === 'in' ? '✅ รับกะ & แจ้งกลุ่มแล้ว' : '✅ ส่งกะเข้า Telegram แล้ว'); reload(); setTimeout(() => setOpen(false), 900);
      } catch { setMsg('❌ ส่งไม่สำเร็จ'); } finally { setBusy(false); }
    };

    const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #dde3e7', borderRadius: 10, padding: '9px 11px', fontSize: '0.88rem', fontFamily: 'inherit', color: '#263238' };
    const flavIn: React.CSSProperties = { marginLeft: 'auto', width: '48%', border: 'none', borderRadius: 8, padding: '7px 9px', fontSize: '0.82rem', fontWeight: 700, fontFamily: 'inherit', boxSizing: 'border-box' };
    const tag: React.CSSProperties = { fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: 'rgba(255,255,255,.25)', padding: '2px 8px', borderRadius: 20 };

    if (!open) return (
      <button onClick={() => setOpen(true)} style={{ ...card, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, fontSize: '0.9rem', color: '#37474f' }}>
        📋 บันทึกกะ <span style={{ marginLeft: 'auto', fontSize: '0.74rem', color: '#90a4ae', fontWeight: 600 }}>แตะเพื่อ รับกะ / ส่งกะ ›</span>
      </button>
    );

    const modeC = mode === 'in' ? '#00897b' : '#ff6b00';
    return (
      <div style={{ ...card }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>📋 บันทึกกะ</div>
          <button onClick={() => setOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', color: '#90a4ae', cursor: 'pointer', fontSize: '1.1rem' }}>×</button>
        </div>
        {/* segmented: รับกะ / ส่งกะ */}
        <div style={{ display: 'flex', gap: 5, background: '#eef1f4', borderRadius: 12, padding: 4, marginBottom: 10 }}>
          {([['in', '📥 รับกะ'], ['out', '📤 ส่งกะ']] as ['in' | 'out', string][]).map(([m, lb]) => (
            <button key={m} onClick={() => applyMode(m)} style={{ flex: 1, border: 'none', borderRadius: 9, padding: '8px 6px', fontSize: '0.82rem', fontWeight: 800, cursor: 'pointer', background: mode === m ? '#fff' : 'transparent', color: mode === m ? (m === 'in' ? '#00897b' : '#ff6b00') : '#78828a', boxShadow: mode === m ? '0 1px 4px rgba(0,0,0,.1)' : 'none' }}>{lb}</button>
          ))}
        </div>
        <div style={{ fontSize: '0.72rem', color: '#78828a', marginBottom: 10 }}>
          {mode === 'in' ? '📥 สถานะจากกะก่อน — ตรวจ/แก้ แล้วกดรับทราบ' : '📤 เติมรส/Batch ล่าสุดให้อัตโนมัติ — แก้ได้ตามจริง'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <select value={ho.shift} onChange={e => setHo(h => ({ ...h, shift: e.target.value }))} style={{ ...inp, width: 'auto' }}>
            {(() => { const s = shiftsForWeekday(weekdayOf(date)).map(x => x.key); return (s.length ? s : ['เช้า', 'บ่าย', 'ดึก']); })().map(k => <option key={k} value={'กะ' + k}>กะ{k}</option>)}
          </select>
        </div>

        {ho.lines.map((ln, i) => { const meta = HO_LINES[i]; return (
          <div key={ln.line} style={{ border: '1px solid #e8edf0', borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: meta.c }}>
              <span style={{ color: '#fff', fontWeight: 800, fontSize: '0.85rem' }}>▶️ {ln.line}</span>
              <span style={tag}>{meta.sub}</span>
              <input value={ln.flavor} onChange={e => setLine(i, { flavor: e.target.value })} placeholder="รส / สถานะ (เช่น CIP ต่อ)" style={flavIn} />
            </div>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#546e7a' }}>Batch</label>
                <select value={ln.batch || ''} onChange={e => setLine(i, { batch: e.target.value })} style={inp}>
                  <option value="">— Batch ล่าสุดที่ค้าง (ส่งต่อหน้าผลิต) —</option>
                  {HO_BATCHES.map(b => <option key={b} value={b}>Batch {b}</option>)}
                </select>
              </div>
              {ln.tanks.map((tk, t) => (
                <div key={t} style={{ display: 'grid', gridTemplateColumns: '58px 1fr', alignItems: 'center', gap: 10, marginBottom: 7 }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#546e7a' }}>ถัง {t + 1}</label>
                  <input value={tk} onChange={e => setTank(i, t, e.target.value)} placeholder="ว่าง" style={inp} />
                </div>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr', alignItems: 'center', gap: 10, marginBottom: 7 }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#546e7a' }}>Lot No.</label>
                <input value={ln.lotNo || ''} onChange={e => setLine(i, { lotNo: e.target.value })} placeholder="เช่น 080726" style={inp} />
              </div>
              <input value={ln.note} onChange={e => setLine(i, { note: e.target.value })} placeholder="หมายเหตุ (เช่น หลังเปลี่ยนกรอง Batch 2)" style={{ ...inp, border: '1px dashed #d3dae0', marginTop: 2 }} />
            </div>
          </div>
        ); })}

        <div style={{ border: '1px solid #e8edf0', borderRadius: 12, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#4a7c59' }}>
            <span style={{ color: '#fff', fontWeight: 800, fontSize: '0.85rem' }}>▶️ Line 4</span>
            <span style={tag}>Mixing / Pasteurizer</span>
            <input value={ho.line4.flavor} onChange={e => setHo(h => ({ ...h, line4: { ...h.line4, flavor: e.target.value } }))} placeholder="รส / สถานะ" style={flavIn} />
          </div>
          <div style={{ padding: '10px 12px' }}>
            {HO_L4_STAGES.map((nm, i) => (
              <div key={nm} style={{ display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', gap: 10, marginBottom: 7 }}>
                <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#546e7a' }}>{nm}</label>
                <input value={ho.line4.stages[i]} onChange={e => setStage(i, e.target.value)} placeholder="ว่าง / สถานะ" style={inp} />
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', gap: 10, marginBottom: 7 }}>
              <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#546e7a' }}>Lot No.</label>
              <input value={ho.line4.lotNo || ''} onChange={e => setHo(h => ({ ...h, line4: { ...h.line4, lotNo: e.target.value } }))} placeholder="เช่น 080726" style={inp} />
            </div>
          </div>
        </div>

        <input value={ho.note} onChange={e => setHo(h => ({ ...h, note: e.target.value }))} placeholder="📌 หมายเหตุรวม (ถ้ามี)" style={{ ...inp, marginBottom: 12 }} />

        <div style={{ background: '#0e1621', borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ color: '#8fa6bd', fontSize: '0.64rem', fontWeight: 800, letterSpacing: '.04em', marginBottom: 6 }}>✈ พรีวิวข้อความ</div>
          <div style={{ color: '#e6edf3', fontSize: '0.8rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{hoPreview(ho, operatorName, date, mode)}</div>
        </div>
        <button onClick={send} disabled={busy} style={{ width: '100%', border: 'none', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '0.9rem', color: '#fff', background: mode === 'in' ? modeC : '#229ed9', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{mode === 'in' ? '✅ รับทราบ & เริ่มกะ · ส่งกลุ่ม' : '✈ ส่งกะเข้ากลุ่ม'}</button>
        {msg && <div style={{ textAlign: 'center', fontSize: '0.78rem', color: '#546e7a', marginTop: 8 }}>{msg}</div>}
      </div>
    );
  };

// ─── Packing-staff report (แปลงสถานะถัง %/kg → Boxes, แอปคำนวณล้วน) ─────────
const PK_LINES = [
  { line: 1, unit: '%', c: '#0d47a1' },
  { line: 2, unit: 'kg', c: '#00838f' },
  { line: 3, unit: 'kg', c: '#6a1b9a' },
  { line: 4, unit: '%', c: '#4a7c59' },
];
const PK_BATCHES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const PK_NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
type PkRow = { batch: string; amount: string };
type PkLineState = { flavor: string; rows: PkRow[]; lotNo: string };
const pkInit = (): PkLineState[] => PK_LINES.map(() => ({ flavor: '', rows: [{ batch: '', amount: '' }], lotNo: '' }));
const isCipFlavor = (f: string) => /^\s*cip\b/i.test((f || '').trim());
// สูตร: L1 %×1 · L2 Freshy kg÷12 / Senorita kg×0.15 · L3 Freshy kg×0.08 / Senorita kg×0.16 · L4 Freshy %×2.5 / Senorita %×5
const pkFactor = (line: number, flavor: string): number => {
  const sen = /senorita/i.test(flavor);
  if (line === 1) return 1;
  if (line === 2) return sen ? 0.15 : 1 / 12;
  if (line === 3) return sen ? 0.16 : 0.08;
  if (line === 4) return sen ? 5 : 2.5;
  return 0;
};
const pkBoxes = (line: number, flavor: string, amount: string): number => {
  const a = parseFloat(amount);
  if (!isFinite(a) || a <= 0) return 0;
  return Math.floor(a * pkFactor(line, flavor)); // ปัดลงเสมอ
};
const pkLot = (d: string): string => { const p = (d || '').split('-'); return p.length === 3 ? `${p[2]}${p[1]}${p[0].slice(2)}` : ''; };
// แกะ "Batch B 100%" / "Batch A 50%" / "Batch I 1200kg" → { batch, amount }
const pkParse = (s: string): PkRow | null => {
  const str = String(s || '');
  const bm = str.match(/Batch\s*([A-Za-z])/i);
  if (!bm) return null;
  const am = str.match(/(\d+(?:\.\d+)?)/);
  return { batch: bm[1].toUpperCase(), amount: am ? am[1] : '' };
};
// แปลงข้อมูลรับกะล่าสุด (lines[].tanks + line4.stages) → แถวของฟอร์มบรรจุ + Lot รายไลน์
type HoData = { lines?: { flavor?: string; tanks?: string[]; lotNo?: string }[]; line4?: { flavor?: string; stages?: string[]; lotNo?: string } };
const pkFromHandover = (d: HoData): PkLineState[] => PK_LINES.map((_, i) => {
  const src = i < 3 ? (d.lines?.[i] || {}) : (d.line4 || {});
  const cells: string[] = i < 3 ? ((d.lines?.[i]?.tanks) || []) : ((d.line4?.stages) || []);
  const rows = cells.map(pkParse).filter((r): r is PkRow => !!r);
  return { flavor: src.flavor || '', rows: rows.length ? rows : [{ batch: '', amount: '' }], lotNo: src.lotNo || '' };
});
const PK_DIV = '────────────';
const pkBuild = (lines: PkLineState[]): { text: string; total: number } => {
  const L = ['📦 รายงานพนักงานบรรจุ'];
  let total = 0;
  lines.forEach((ls, i) => {
    const cip = isCipFlavor(ls.flavor);
    const valid = ls.rows.filter(r => r.batch && parseFloat(r.amount) > 0);
    if (!ls.flavor.trim() && !valid.length && !cip) return; // ข้ามไลน์ที่ไม่มีข้อมูล
    L.push(PK_DIV, ls.flavor.trim() || '-');
    if (cip) return; // CIP: ไม่คิด Boxes / ไม่มี Lot
    for (const r of valid) { const b = pkBoxes(i + 1, ls.flavor, r.amount); total += b; L.push(`Batch ${r.batch} ${b} Boxes`); }
    if ((ls.lotNo || '').trim()) L.push(`(Lot no ${ls.lotNo.trim()})`);
  });
  L.push(PK_DIV, `รวม ${total} Boxes`);
  return { text: L.join('\n'), total };
};

const PackingReportForm: React.FC<{ date: string; operatorName: string | null; reload: () => void; card: React.CSSProperties; source: HoState | null }> =
  ({ date, operatorName, reload, card, source }) => {
    const [open, setOpen] = useState(false);
    const [lines, setLines] = useState<PkLineState[]>(pkInit);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');

    // ซิงค์สดจากฟอร์มรับกะ: รส + แกะ Batch/จำนวน + Lot รายไลน์ จากสถานะถัง (แก้ด้วยมือได้ · รีเซ็ตเมื่อรับกะเปลี่ยนอีก)
    const applySource = useCallback((): boolean => {
      if (!source) return false;
      setLines(pkFromHandover(source).map(l => ({ ...l, lotNo: l.lotNo || pkLot(date) })));
      return true;
    }, [source, date]);

    // เด้งอัตโนมัติทุกครั้งที่รับกะเปลี่ยน (ไม่ต้องกดส่งก่อน)
    useEffect(() => { applySource(); }, [applySource]);

    const setFlavor = (i: number, v: string) => setLines(ls => ls.map((l, j) => j === i ? { ...l, flavor: v } : l));
    const setLot = (i: number, v: string) => setLines(ls => ls.map((l, j) => j === i ? { ...l, lotNo: v } : l));
    const setRow = (i: number, r: number, patch: Partial<PkRow>) => setLines(ls => ls.map((l, j) => j === i ? { ...l, rows: l.rows.map((x, k) => k === r ? { ...x, ...patch } : x) } : l));
    const addRow = (i: number) => setLines(ls => ls.map((l, j) => j === i ? { ...l, rows: [...l.rows, { batch: '', amount: '' }] } : l));
    const delRow = (i: number, r: number) => setLines(ls => ls.map((l, j) => j === i ? { ...l, rows: l.rows.filter((_, k) => k !== r) } : l));

    const { text, total } = pkBuild(lines);

    const send = async () => {
      setBusy(true); setMsg('');
      try {
        const bkk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
        const cs = shiftInfo(currentWorkDay(), bkk.getHours()).shift;
        await fetch(`${apiUrl}/api/packing-report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, operator: operatorName, shift: cs ? 'กะ' + cs : '', text }) });
        setMsg('✅ ส่งรายงานเข้ากลุ่มแล้ว'); reload(); setTimeout(() => setOpen(false), 900);
      } catch { setMsg('❌ ส่งไม่สำเร็จ'); } finally { setBusy(false); }
    };

    const inp: React.CSSProperties = { border: '1px solid #dde3e7', borderRadius: 9, padding: '7px 9px', fontSize: '0.8rem', fontFamily: 'inherit', color: '#37474f', background: '#fff' };

    if (!open) return (
      <button onClick={() => setOpen(true)} style={{ ...card, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, fontSize: '0.9rem', color: '#37474f' }}>
        📦 รายงานพนักงานบรรจุ <span style={{ marginLeft: 'auto', fontSize: '0.74rem', color: '#90a4ae', fontWeight: 600 }}>แปลง %/kg → Boxes ›</span>
      </button>
    );

    return (
      <div style={{ ...card }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>📦 รายงานพนักงานบรรจุ</div>
          <button onClick={() => setOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', color: '#90a4ae', cursor: 'pointer', fontSize: '1.1rem' }}>×</button>
        </div>
        <div style={{ fontSize: '0.72rem', color: '#78828a', marginBottom: 8 }}>แอปคำนวณ Boxes ให้อัตโนมัติ (ปัดลง) · เติมจากรับกะให้ แก้ด้วยมือได้</div>
        <button onClick={() => setMsg(applySource() ? '📥 ดึงจากรับกะแล้ว' : 'ยังไม่มีข้อมูลรับกะ')}
          style={{ border: '1px solid #e8edf0', background: '#fff', borderRadius: 10, padding: '8px 12px', fontSize: '0.78rem', fontWeight: 700, color: '#546e7a', cursor: 'pointer', marginBottom: 10 }}>📥 ดึงจากรับกะ</button>

        {PK_LINES.map((meta, i) => { const ls = lines[i]; const cip = isCipFlavor(ls.flavor); return (
          <div key={meta.line} style={{ border: '1px solid #e8edf0', borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', background: meta.c }}>
              <span style={{ color: '#fff', fontWeight: 800, fontSize: '0.82rem' }}>{PK_NUM[i]} Line {meta.line}</span>
              <span style={{ fontSize: '0.56rem', fontWeight: 800, color: '#fff', background: 'rgba(255,255,255,.28)', borderRadius: 20, padding: '2px 7px' }}>{meta.unit}</span>
              <input value={ls.flavor} onChange={e => setFlavor(i, e.target.value)} placeholder="รส / CIP" style={{ marginLeft: 'auto', width: '52%', border: 'none', borderRadius: 7, padding: '6px 9px', fontSize: '0.8rem', fontWeight: 700, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            </div>
            <div style={{ padding: '9px 11px' }}>
              {cip ? <div style={{ fontSize: '0.76rem', color: '#78828a' }}>🧼 CIP — ไม่คิด Boxes</div> : (<>
                {ls.rows.map((r, ri) => { const boxes = pkBoxes(meta.line, ls.flavor, r.amount); return (
                  <div key={ri} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 76px 26px', gap: 7, alignItems: 'center', marginBottom: 7 }}>
                    <select value={r.batch} onChange={e => setRow(i, ri, { batch: e.target.value })} style={{ ...inp, fontWeight: 700 }}>
                      <option value="">Batch</option>
                      {PK_BATCHES.map(b => <option key={b} value={b}>Batch {b}</option>)}
                    </select>
                    <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #dde3e7', borderRadius: 9, overflow: 'hidden' }}>
                      <input type="number" value={r.amount} onChange={e => setRow(i, ri, { amount: e.target.value })} placeholder="จำนวน" style={{ border: 'none', padding: '7px 9px', fontSize: '0.8rem', width: '100%', fontFamily: 'inherit', color: '#37474f', minWidth: 0 }} />
                      <span style={{ fontSize: '0.66rem', fontWeight: 800, color: '#9aa4ad', padding: '0 8px', background: '#f4f6f8', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>{meta.unit}</span>
                    </div>
                    <div style={{ textAlign: 'center', fontWeight: 800, fontSize: '0.8rem', color: '#8d5524', background: '#f3ead9', borderRadius: 9, padding: '5px 2px' }}>{boxes}<div style={{ fontSize: '0.5rem', color: '#9aa4ad', fontWeight: 700 }}>Boxes</div></div>
                    <button onClick={() => delRow(i, ri)} disabled={ls.rows.length <= 1} style={{ border: 'none', background: 'none', color: ls.rows.length <= 1 ? '#e5e5e5' : '#ccc', cursor: ls.rows.length <= 1 ? 'default' : 'pointer', fontSize: '1.05rem' }}>×</button>
                  </div>
                ); })}
                <button onClick={() => addRow(i)} style={{ border: '1px dashed #cbd3d9', background: '#fff', color: '#78828a', borderRadius: 9, padding: '6px', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', width: '100%' }}>+ เพิ่ม Batch</button>
                <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr', alignItems: 'center', gap: 7, marginTop: 8 }}>
                  <label style={{ fontSize: '0.74rem', fontWeight: 700, color: '#546e7a' }}>Lot No.</label>
                  <input value={ls.lotNo || ''} onChange={e => setLot(i, e.target.value)} placeholder="เช่น 080726" style={inp} />
                </div>
              </>)}
            </div>
          </div>
        ); })}

        <div style={{ background: '#0e1621', borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ color: '#8fa6bd', fontSize: '0.64rem', fontWeight: 800, letterSpacing: '.04em', marginBottom: 6 }}>✈ พรีวิว · รวม {total} Boxes</div>
          <div style={{ color: '#e6edf3', fontSize: '0.8rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{text}</div>
        </div>
        <button onClick={send} disabled={busy} style={{ width: '100%', border: 'none', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '0.9rem', color: '#fff', background: '#229ed9', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>✈ ส่งรายงานเข้ากลุ่ม + timeline</button>
        {msg && <div style={{ textAlign: 'center', fontSize: '0.78rem', color: '#546e7a', marginTop: 8 }}>{msg}</div>}
      </div>
    );
  };

const TimelineTab: React.FC<{ date: string; operatorName: string | null; events: TimelineEvent[]; reload: () => void; card: React.CSSProperties }> =
  ({ date, operatorName, events, reload, card }) => {
    const [filter, setFilter] = useState('all');
    const [hoData, setHoData] = useState<HoState | null>(null); // สถานะรับกะสด → ป้อนฟอร์มบรรจุ

    // auto-refresh ไทม์ไลน์ทุก 20 วิ ระหว่างเปิดแท็บนี้ (ล้าง interval ตอนออก)
    useEffect(() => { const id = setInterval(reload, 20000); return () => clearInterval(id); }, [reload]);

    // กะของวันนี้ (ตามตารางจริง — จ-พฤ 3 กะ, ศ/อา 2 กะ, เสาร์หยุด)
    const dayShifts = shiftsForWeekday(weekdayOf(date));
    const shiftKeys = dayShifts.map(s => s.key);
    const isHoliday = dayShifts.length === 0;
    // derive: parse time → hour/shift; sort; group
    const evs = events.map(e => { const tm = parseHM(e.time); return { ...e, hm: tm?.hm || '—:—', hour: tm?.h ?? null }; })
      .sort((a, b) => ((a.hour ?? 99) * 60) - ((b.hour ?? 99) * 60));
    // จัดเหตุการณ์เข้ากะของ "วันทำงาน" ที่เลือก (เหตุการณ์ทั้งหมดอยู่ในหน้าต่าง 06:00→06:00 แล้ว)
    const shifted = (h: number | null) => {
      const hr = h ?? 3;
      for (const s of dayShifts) { const inIt = s.start < s.end ? (hr >= s.start && hr < s.end) : (hr >= s.start || hr < s.end); if (inIt) return s.key; }
      return shiftKeys[shiftKeys.length - 1] || 'ดึก';
    };

    // shift summary counts
    const sc: Record<string, { prod: number; cip: number; other: number }> = {};
    for (const k of shiftKeys) sc[k] = { prod: 0, cip: 0, other: 0 };
    const hourCnt = Array(24).fill(0);
    for (const e of evs) {
      const s = shifted(e.hour);
      if (sc[s]) { if (e.type === 'production') sc[s].prod++; else if (e.type === 'cip') sc[s].cip++; else sc[s].other++; }
      if (e.hour != null) hourCnt[e.hour]++;
    }
    const maxCnt = Math.max(1, ...hourCnt);
    const stripEmoji = (t: string) => t.replace(/^\S+\s/, '');

    const filtered = evs.filter(e => filter === 'all' || (filter === 'handover' ? e.type.startsWith('handover') : e.type === filter));
    const byShift: Record<string, typeof filtered> = {};
    for (const e of filtered) (byShift[shifted(e.hour)] ||= []).push(e);

    return (
      <div>
        {/* handover form (รับกะ/ส่งกะ, collapsible) — เผยแพร่สถานะสดให้ฟอร์มบรรจุ */}
        <HandoverForm date={date} operatorName={operatorName} reload={reload} card={card} onLiveChange={setHoData} />

        {/* packing-staff report (แปลง %/kg → Boxes) — ซิงค์สดจากรับกะ */}
        <PackingReportForm date={date} operatorName={operatorName} reload={reload} card={card} source={hoData} />

        {/* live status board (สด, auto-refresh) */}
        {!isHoliday && <LiveBoard date={date} card={card} />}

        {/* shift summary cards (ตามตารางจริงของวันนั้น) */}
        {isHoliday && <div style={{ ...card, textAlign: 'center', color: '#90a4ae', fontWeight: 700 }}>🚫 วันเสาร์ — วันหยุด (ไม่มีกะทำงาน)</div>}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, shiftKeys.length)},1fr)`, gap: '10px', marginBottom: '12px' }}>
          {shiftKeys.map(s => { const st = sc[s]; const tot = st.prod + st.cip + st.other; const m = TL_SHIFT[s]; return (
            <div key={s} style={{ ...card, marginBottom: 0, padding: '12px', position: 'relative', overflow: 'hidden', textAlign: 'center' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '4px', background: m.c }} />
              <div style={{ fontSize: '1.1rem' }}>{m.ic}</div>
              <div style={{ fontSize: '0.78rem', fontWeight: 800, margin: '3px 0' }}>กะ{s}</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: m.c }}>{tot}</div>
              <div style={{ fontSize: '0.66rem', color: '#546e7a', fontWeight: 600 }}>🏭 {st.prod} · 💧 {st.cip}{st.other ? ` · 📝 ${st.other}` : ''}</div>
            </div>
          ); })}
        </div>

        {/* view segmented (filters) */}
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', marginBottom: '12px' }}>
          {([['all', 'ทั้งหมด'], ['production', '🏭 ผลิต'], ['cip', '💧 CIP'], ['handover', '📋 กะ']] as [string, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} style={{
              flex: '0 0 auto', border: '2px solid', borderColor: filter === k ? 'transparent' : '#e0e0e0',
              background: filter === k ? '#37474f' : '#fff', color: filter === k ? '#fff' : '#666',
              borderRadius: '20px', padding: '7px 14px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}>{l}</button>
          ))}
        </div>

        {/* card feed grouped by shift (เรียงตามกะของวันนั้น) */}
        {shiftKeys.filter(s => byShift[s]?.length).map(s => { const m = TL_SHIFT[s]; return (
          <div key={s}>
            <div style={{ position: 'sticky', top: 0, background: 'linear-gradient(#f7f8fa,#f7f8fa 70%,transparent)', padding: '8px 4px', fontSize: '0.78rem', fontWeight: 800, color: '#546e7a', zIndex: 2, display: 'flex', alignItems: 'center', gap: '8px' }}>
              {m.ic} กะ{s}<span style={{ marginLeft: 'auto', fontSize: '0.66rem', fontWeight: 700, color: '#90a4ae' }}>{byShift[s].length} รายการ</span>
            </div>
            {byShift[s].map((e, i) => { const T = TL_TYPE[e.type] || TL_TYPE.task; return (
              <div key={i} style={{ display: 'flex', background: '#fff', border: '1px solid #e8edf0', borderRadius: '14px', boxShadow: '0 2px 10px rgba(0,0,0,0.04)', marginBottom: '10px', overflow: 'hidden' }}>
                <div style={{ width: '5px', flexShrink: 0, background: T.c }} />
                <div style={{ padding: '12px 14px', flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                    <span style={{ fontSize: '0.82rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{e.hm}</span>
                    <span style={{ fontSize: '0.6rem', fontWeight: 800, padding: '2px 8px', borderRadius: '20px', background: T.w, color: T.c }}>{T.ic} {T.lb}</span>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#37474f' }}>{stripEmoji(e.text)}</div>
                  {e.operator && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '7px', fontSize: '0.68rem', color: '#90a4ae', fontWeight: 600 }}>
                      <span style={{ width: '22px', height: '22px', borderRadius: '50%', background: '#546e7a', color: '#fff', display: 'grid', placeItems: 'center', fontSize: '0.64rem', fontWeight: 800 }}>{e.operator[0]}</span>
                      {e.operator}
                    </div>
                  )}
                </div>
              </div>
            ); })}
          </div>
        ); })}
        {evs.length === 0 && <div style={{ textAlign: 'center', color: '#bbb', fontSize: '0.85rem', padding: '24px' }}>ยังไม่มีเหตุการณ์ในวันนี้</div>}

        {/* hourly heatmap (analytics — ท้ายหน้า) */}
        <div style={{ ...card, marginTop: 12 }}>
          <div style={{ fontSize: '0.76rem', fontWeight: 800, marginBottom: '10px' }}>🔥 ความถี่กิจกรรมรายชั่วโมง</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24,1fr)', gap: '3px' }}>
            {hourCnt.map((c, h) => (
              <div key={h} title={`${String(h).padStart(2, '0')}:00 · ${c} รายการ`}
                style={{ aspectRatio: '1', borderRadius: '3px', background: c ? `rgba(255,107,0,${0.22 + (c / maxCnt) * 0.78})` : '#eef1f4' }} />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24,1fr)', gap: '3px', marginTop: '4px', fontSize: '0.5rem', color: '#90a4ae', textAlign: 'center' }}>
            {Array.from({ length: 24 }, (_, h) => <div key={h}>{h % 6 === 0 ? h : ''}</div>)}
          </div>
        </div>
      </div>
    );
  };

// ─── Live status board (สถานะสดต่อไลน์, auto-refresh) ─────────────
const LIVE_LINES = ['Line 1', 'Line 2', 'Line 3', 'Line 4'];
type LiveLine = { flavor?: string; batch?: string; prodTime?: string; cipTime?: string };
type LineState = { status?: string; flavor?: string; batch?: string; since?: string };
const LIVE_STALE_MS = 8 * 3600 * 1000; // Start ที่ค้างเกิน 8 ชม. (ลืมกด Done) → ถือว่าไม่สด
// since/nowBKK เป็นเวลา "นาฬิกา" ของกรุงเทพทั้งคู่ → parse แบบเดียวกัน ผลต่างจึงถูกไม่ว่า viewer อยู่โซนไหน
const freshMs = (since?: string): number => {
  if (!since) return Infinity;
  const s = Date.parse(since), n = Date.parse(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T'));
  return (isNaN(s) || isNaN(n)) ? Infinity : n - s;
};

const LiveBoard: React.FC<{ date: string; card: React.CSSProperties }> = ({ date, card }) => {
  const [prefill, setPrefill] = useState<Record<string, LiveLine>>({});
  const [state, setState] = useState<Record<string, LineState>>({});
  const [updated, setUpdated] = useState('');
  const load = useCallback(async () => {
    const [pf, ls] = await Promise.all([
      fetch(`${apiUrl}/api/handover/prefill?date=${date}`).then(r => r.json()).catch(() => ({})),
      fetch(`${apiUrl}/api/line-state`).then(r => r.json()).catch(() => ({})),
    ]);
    setPrefill(pf.lines || {});
    setState(ls.lines || {});
    setUpdated(new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }));
  }, [date]);
  useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id); }, [load]);

  const S = {
    producing: { c: '#2e7d32', w: '#e8f5e9', lb: '🟢 กำลังผลิต' },
    cip: { c: '#0277bd', w: '#e1f2fb', lb: '💧 กำลัง CIP' },
    idle: { c: '#90a4ae', w: '#eef1f4', lb: '⚪ ว่าง' },
  } as const;

  // สถานะสด: ใช้ line_state (Start/Done) ถ้ายังสด; ไม่งั้น = ว่าง + โน้ตกิจกรรมล่าสุดจาก prefill
  const viewOf = (ln: string) => {
    const st = state[ln];
    if (st && (st.status === 'producing' || st.status === 'cip') && freshMs(st.since) < LIVE_STALE_MS) {
      return { kind: st.status as 'producing' | 'cip', flavor: st.flavor || '', batch: st.batch || '', sinceHM: parseHM(st.since)?.hm || '', note: '' };
    }
    const pf = prefill[ln];
    let note = 'ยังไม่มีบันทึกวันนี้';
    if (pf) {
      const prodHM = pf.prodTime ? (parseHM(pf.prodTime)?.hm || '') : '';
      const cipHM = pf.cipTime ? (parseHM(pf.cipTime)?.hm || '') : '';
      if (pf.cipTime && (!pf.prodTime || pf.cipTime >= pf.prodTime)) note = `CIP ล่าสุด ${cipHM}`;
      else if (pf.prodTime) note = `ผลิตล่าสุด ${pf.flavor || ''}${pf.batch ? ` · Batch ${pf.batch}` : ''}${prodHM ? ` · ${prodHM}` : ''}`.trim();
    }
    return { kind: 'idle' as const, flavor: '', batch: '', sinceHM: '', note };
  };

  return (
    <div style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#e53935', boxShadow: '0 0 0 3px rgba(229,57,53,.18)' }} />
        <span style={{ fontSize: '0.68rem', fontWeight: 800, letterSpacing: '.05em', color: '#e53935' }}>LIVE · สถานะสด</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.66rem', color: '#90a4ae', fontWeight: 600 }}>{updated ? `อัปเดต ${updated}` : 'กำลังโหลด…'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {LIVE_LINES.map(ln => {
          const v = viewOf(ln); const meta = S[v.kind];
          return (
            <div key={ln} style={{ border: '1px solid #eee', borderRadius: 11, padding: '9px 10px', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: meta.c }} />
              <div style={{ fontSize: '0.74rem', fontWeight: 800, color: '#37474f' }}>{ln}</div>
              <span style={{ display: 'inline-block', fontSize: '0.6rem', fontWeight: 800, borderRadius: 20, padding: '2px 8px', marginTop: 4, background: meta.w, color: meta.c }}>{meta.lb}</span>
              <div style={{ fontSize: '0.68rem', color: '#546e7a', marginTop: 5 }}>
                {v.kind === 'producing' ? `${v.flavor || '-'}${v.batch ? ` · Batch ${v.batch}` : ''}${v.sinceHM ? ` · เริ่ม ${v.sinceHM}` : ''}`
                  : v.kind === 'cip' ? <>CIP{v.sinceHM ? <small style={{ color: '#90a4ae' }}> · เริ่ม {v.sinceHM}</small> : null}</>
                    : <small style={{ color: '#90a4ae' }}>{v.note}</small>}
              </div>
            </div>
          );
        })}
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
    const [rcat, setRcat] = useState('maintenance');
    const recTasks = tasks.filter(t => t.source === 'recurring');
    const recDone = recTasks.filter(t => t.status === 'done').length;
    const pct = recTasks.length ? Math.round((recDone / recTasks.length) * 100) : 0;
    const add = async () => {
      if (!title.trim()) return;
      await fetch(`${apiUrl}/api/task-templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), line, category: rcat, cadence }),
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
          <select value={rcat} onChange={e => setRcat(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid #ddd', borderRadius: '10px', marginBottom: '8px' }}>
            {CAT_KEYS.map(k => <option key={k} value={k}>{CAT[k].icon} {CAT[k].label}</option>)}
          </select>
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
              <div style={{ fontWeight: 600, color: '#37474f' }}>{(CAT[t.category] || CAT.maintenance).icon} {t.title}</div>
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

const heatColor = (pct: number) => pct >= 80 ? '#2e7d32' : pct >= 65 ? '#5fa03a' : pct >= 50 ? '#ff8c00' : '#ff9a52';
type HistDay = { date: string; pct: number; done: number; total: number; active: boolean };

// วงแหวนแสดง % ใช้ซ้ำ (hero + รายคน)
const Ring: React.FC<{ pct: number; color: string; size: number; stroke: number; children?: React.ReactNode }> = ({ pct, color, size, stroke, children }) => {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef1f3" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ strokeDasharray: c, strokeDashoffset: off, transition: 'stroke-dashoffset .4s' }} />
      </svg>
      {children != null && <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{children}</div>}
    </div>
  );
};

const CalendarTab: React.FC<{ card: React.CSSProperties; onOpenDate: (date: string) => void }> = ({ card, onOpenDate }) => {
  const nowD = new Date(todayBKK() + 'T00:00:00');
  const [view, setView] = useState({ y: nowD.getFullYear(), m: nowD.getMonth() });
  const [hist, setHist] = useState<Record<string, HistDay>>({});
  const [selected, setSelected] = useState(todayBKK());
  const [duty, setDuty] = useState<Duty | null>(null);
  const [loading, setLoading] = useState(false);
  const today = todayBKK();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const startWeekday = new Date(view.y, view.m, 1).getDay();

  const loadHist = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/duty/history?from=${ymd(view.y, view.m, 1)}&to=${ymd(view.y, view.m, daysInMonth)}`);
      const d = await r.json();
      const map: Record<string, HistDay> = {};
      for (const x of d.days || []) map[x.date] = x;
      setHist(map);
    } catch { /* offline */ }
  }, [view.y, view.m, daysInMonth]);
  const loadDay = useCallback(async (date: string) => {
    setLoading(true);
    try { const r = await fetch(`${apiUrl}/api/duty?date=${date}`); setDuty(await r.json()); }
    catch { setDuty(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { loadHist(); }, [loadHist]);
  useEffect(() => { loadDay(selected); }, [selected, loadDay]);

  const shiftMonth = (delta: number) => setView(v => { const d = new Date(v.y, v.m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const cells: (number | null)[] = [...Array(startWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const selD = new Date(selected + 'T00:00:00');
  const selLabel = `${selD.getDate()} ${THAI_MONTHS[selD.getMonth()]} ${selD.getFullYear() + 543}`;

  const stats = duty ? (() => {
    let byp = 0, hand = 0, adhoc = 0;
    for (const p of duty.people) { byp += p.nodes.filter(n => n.bypassed && !n.handoffTo).length; hand += p.nodes.filter(n => n.bypassed && n.handoffTo).length; adhoc += p.adhoc.length; }
    return { byp, hand, adhoc };
  })() : null;
  const yKey = (() => { const d = new Date(selD); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const diff = duty && hist[yKey] ? duty.team.pct - hist[yKey].pct : null;
  const trend = Array.from({ length: 7 }, (_, i) => { const d = new Date(selD); d.setDate(d.getDate() - (6 - i)); const ds = d.toISOString().slice(0, 10); return { ds, pct: hist[ds]?.pct ?? 0 }; });

  const eyebrow = (t: string, r?: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 2px 10px' }}>
      <span style={{ width: 4, height: 15, borderRadius: 3, background: '#ff6b00' }} /><h3 style={{ fontSize: '.9rem', fontWeight: 800, margin: 0 }}>{t}</h3>
      {r && <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: '#9aa0a6', fontWeight: 600 }}>{r}</span>}
    </div>
  );

  return (
    <div>
      {/* month heatmap */}
      <div style={{ ...card, padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <button onClick={() => shiftMonth(-1)} style={{ border: '1px solid #eee', background: '#fff', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontSize: '1rem' }}>‹</button>
          <div style={{ fontWeight: 800, color: '#37474f' }}>{THAI_MONTHS[view.m]} {view.y + 543}</div>
          <button onClick={() => shiftMonth(1)} style={{ border: '1px solid #eee', background: '#fff', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontSize: '1rem' }}>›</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, marginBottom: 4 }}>
          {THAI_WEEKDAYS.map((w, i) => <div key={w} style={{ textAlign: 'center', fontSize: '.66rem', fontWeight: 700, color: i === 0 ? '#e53935' : '#9aa0a6' }}>{w}</div>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
          {cells.map((d, i) => {
            if (d === null) return <div key={`b${i}`} />;
            const ds = ymd(view.y, view.m, d);
            const h = hist[ds];
            const show = h && h.active && h.total > 0;
            const isSel = ds === selected, isToday = ds === today;
            return (
              <button key={ds} onClick={() => setSelected(ds)} style={{
                position: 'relative', aspectRatio: '1', border: '2px solid', borderColor: isSel ? '#ff6b00' : isToday ? '#ffd0a6' : 'transparent',
                background: '#fafbfc', borderRadius: 10, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                color: ds < today ? '#9aa0a6' : '#37474f', fontWeight: isToday ? 800 : 500, fontSize: '.8rem', padding: 0,
              }}>
                {d}
                {show && <span style={{ marginTop: 1, fontSize: '.54rem', fontWeight: 800, color: '#fff', background: heatColor(h.pct), borderRadius: 6, padding: '0 4px' }}>{h.pct}%</span>}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 10, fontSize: '.64rem', color: '#9aa0a6', alignItems: 'center' }}>
          <span>น้อย</span>
          {['#ff9a52', '#ff8c00', '#5fa03a', '#2e7d32'].map(c => <i key={c} style={{ width: 12, height: 12, borderRadius: 3, background: c }} />)}
          <span>เสร็จมาก</span>
        </div>
      </div>

      {/* day header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 2px 10px' }}>
        <span style={{ width: 4, height: 15, borderRadius: 3, background: '#ff6b00' }} />
        <h3 style={{ fontSize: '.92rem', fontWeight: 800, margin: 0 }}>สรุปวันที่ {selLabel}</h3>
        <button onClick={() => onOpenDate(selected)} style={{ marginLeft: 'auto', border: '1px solid #eee', background: '#fff', borderRadius: 10, padding: '5px 11px', cursor: 'pointer', fontSize: '.76rem', fontWeight: 700, color: '#ff6b00' }}>เปิดเต็ม →</button>
      </div>

      {loading && <div style={{ textAlign: 'center', color: '#bbb', padding: 20 }}>กำลังโหลด…</div>}
      {!loading && duty && (<>
        {/* hero KPI */}
        <div style={{ ...card }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Ring pct={duty.team.pct} color="#ff6b00" size={92} stroke={9}>
              <div style={{ fontSize: '1.5rem', fontWeight: 800, lineHeight: 1 }} className="tnum">{duty.team.pct}%</div>
              <div style={{ fontSize: '.58rem', color: '#9aa0a6', fontWeight: 700 }}>KPI ทีม</div>
            </Ring>
            <div>
              <div style={{ fontWeight: 800, fontSize: '.95rem' }}>คะแนนความคืบหน้าทีม</div>
              <div style={{ fontSize: '.76rem', color: '#546e7a', marginTop: 2 }}>ทำเสร็จ {duty.team.done} / {duty.team.total} งาน</div>
              {diff != null && <span style={{ display: 'inline-block', marginTop: 8, fontSize: '.68rem', fontWeight: 700, padding: '4px 10px', borderRadius: 20, background: diff >= 0 ? '#e7f5e8' : '#ffebee', color: diff >= 0 ? '#2e7d32' : '#c62828' }}>{diff >= 0 ? '▲ +' : '▼ '}{diff}% จากเมื่อวาน</span>}
            </div>
          </div>
        </div>

        {/* per-person KPI */}
        {eyebrow('KPI รายบุคคล')}
        <div style={{ ...card }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
            {duty.people.map(p => { const col = DUTY_COLOR[p.key]?.c || '#607d8b'; const lvl = p.pct >= 80 ? ['ดีเยี่ยม', '#e7f5e8', '#2e7d32'] : p.pct >= 50 ? ['กำลังไป', '#fff3e0', '#e65100'] : ['ต้องเร่ง', '#ffebee', '#c62828']; return (
              <div key={p.key} style={{ border: '1px solid #eee', borderRadius: 12, padding: '12px 6px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: col }} />
                <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 6px' }}>
                  <Ring pct={p.pct} color={col} size={56} stroke={7}><span style={{ fontSize: '.8rem', fontWeight: 800, color: col }}>{p.pct}%</span></Ring>
                </div>
                <div style={{ fontSize: '.8rem', fontWeight: 800 }}>{p.name}</div>
                <div style={{ fontSize: '.64rem', color: '#9aa0a6', fontWeight: 600 }}>{p.done}/{p.total} งาน</div>
                <span style={{ display: 'inline-block', marginTop: 5, fontSize: '.58rem', fontWeight: 800, padding: '2px 8px', borderRadius: 20, background: lvl[1], color: lvl[2] }}>{lvl[0]}</span>
              </div>
            ); })}
          </div>
        </div>

        {/* bar chart */}
        {eyebrow('เปรียบเทียบรายคน')}
        <div style={{ ...card }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {duty.people.map(p => { const col = DUTY_COLOR[p.key]?.c || '#607d8b'; return (
              <div key={p.key} style={{ display: 'grid', gridTemplateColumns: '46px 1fr 40px', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: '.78rem', fontWeight: 700, color: col }}>{p.name}</span>
                <div style={{ height: 12, background: '#eef1f3', borderRadius: 7, overflow: 'hidden' }}><div style={{ height: '100%', width: `${p.pct}%`, background: col, borderRadius: 7, transition: 'width .4s' }} /></div>
                <span style={{ fontSize: '.76rem', fontWeight: 800, textAlign: 'right' }} className="tnum">{p.pct}%</span>
              </div>
            ); })}
          </div>
        </div>

        {/* donut status */}
        {stats && (<>
          {eyebrow('สัดส่วนสถานะงาน')}
          <div style={{ ...card }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
              {(() => {
                const done = duty.team.done, pend = duty.team.left, byp = stats.byp + stats.hand, tot = done + pend + byp || 1;
                const C = 2 * Math.PI * 52; const seg = (v: number) => C * v / tot;
                return (
                  <svg width={128} height={128} viewBox="0 0 132 132" style={{ flexShrink: 0 }}>
                    <circle cx={66} cy={66} r={52} fill="none" stroke="#eef1f3" strokeWidth={16} />
                    <circle cx={66} cy={66} r={52} fill="none" stroke="#2e7d32" strokeWidth={16} strokeLinecap="round" transform="rotate(-90 66 66)" style={{ strokeDasharray: `${seg(done)} ${C}` }} />
                    <circle cx={66} cy={66} r={52} fill="none" stroke="#cfd8dc" strokeWidth={16} transform="rotate(-90 66 66)" style={{ strokeDasharray: `${seg(pend)} ${C}`, strokeDashoffset: -seg(done) }} />
                    <circle cx={66} cy={66} r={52} fill="none" stroke="#f0a020" strokeWidth={16} transform="rotate(-90 66 66)" style={{ strokeDasharray: `${seg(byp)} ${C}`, strokeDashoffset: -(seg(done) + seg(pend)) }} />
                    <text x={66} y={62} textAnchor="middle" fontSize={20} fontWeight={800} fill="#263238">{done}</text>
                    <text x={66} y={80} textAnchor="middle" fontSize={9} fill="#90a4ae" fontWeight={700}>เสร็จ</text>
                  </svg>
                );
              })()}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                {[['เสร็จแล้ว', '#2e7d32', duty.team.done], ['คงค้าง', '#cfd8dc', duty.team.left], ['ข้าม/มอบต่อ', '#f0a020', stats.byp + stats.hand]].map(([l, c, n]) => (
                  <div key={l as string} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.78rem', fontWeight: 600 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 4, background: c as string }} />{l}
                    <span style={{ marginLeft: 'auto', fontWeight: 800, color: '#546e7a' }} className="tnum">{n as number}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>)}

        {/* trend */}
        {eyebrow('แนวโน้ม KPI ทีม', '7 วันล่าสุด')}
        <div style={{ ...card }}>
          <svg width="100%" viewBox="0 0 320 110" preserveAspectRatio="none" style={{ display: 'block' }}>
            <line x1={28} y1={12} x2={28} y2={90} stroke="#eef1f3" /><line x1={28} y1={90} x2={314} y2={90} stroke="#eef1f3" />
            {(() => {
              const xs = (i: number) => 28 + (286 * i / 6); const ys = (p: number) => 90 - (78 * p / 100);
              const pts = trend.map((t, i) => `${xs(i)},${ys(t.pct)}`).join(' ');
              return (<>
                <polygon points={`28,90 ${pts} 314,90`} fill="rgba(255,107,0,.10)" />
                <polyline points={pts} fill="none" stroke="#ff6b00" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
                <circle cx={xs(6)} cy={ys(trend[6].pct)} r={4} fill="#ff6b00" stroke="#fff" strokeWidth={2} />
                <text x={xs(6)} y={ys(trend[6].pct) - 8} textAnchor="end" fontSize={10} fontWeight={800} fill="#ff6b00">{trend[6].pct}%</text>
                {trend.map((t, i) => <text key={t.ds} x={xs(i)} y={104} textAnchor="middle" fontSize={8} fill="#90a4ae" fontWeight={600}>{Number(t.ds.slice(8))}</text>)}
              </>);
            })()}
          </svg>
        </div>

        {/* stat chips */}
        {stats && (
          <div style={{ ...card }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              {[['งานข้าม', stats.byp, '#f0a020'], ['มอบต่อ', stats.hand, '#3949ab'], ['งานมอบหมาย', stats.adhoc, '#ff6b00']].map(([l, n, c]) => (
                <div key={l as string} style={{ border: '1px solid #eee', borderRadius: 12, padding: 11, textAlign: 'center' }}>
                  <div style={{ fontSize: '1.3rem', fontWeight: 800, color: c as string }} className="tnum">{n as number}</div>
                  <div style={{ fontSize: '.64rem', color: '#9aa0a6', fontWeight: 700 }}>{l}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </>)}
    </div>
  );
};

// ─── Report scheduling ─────────────────────────────────────────
type ReportCfg = { autoEnabled: boolean; times: string[]; weekdays: number[]; onlyIfPending: boolean; autoAtShiftEnd: boolean; once: { id: number; run_at: string }[] };
const SHIFT_TIMES: [string, string][] = [['14:00', '14:00'], ['18:00', '18:00'], ['22:00', '22:00'], ['06:00', '06:00']];
const WEEKDAY_OPTS: [number, string][] = [[1, 'จ'], [2, 'อ'], [3, 'พ'], [4, 'พฤ'], [5, 'ศ'], [6, 'ส'], [0, 'อา']];

// ── สเปกคุณภาพ (baseline Brix/pH ต่อรส) — ตั้งเองเพื่อให้เตือนสิ้นกะแม่น ไม่ false alarm ──
type QSpec = { brix_min: number | null; brix_max: number | null; ph_min: number | null; ph_max: number | null };
const SPEC_FIELDS: (keyof QSpec)[] = ['brix_min', 'brix_max', 'ph_min', 'ph_max'];
const SpecsTab: React.FC<{ card: React.CSSProperties }> = ({ card }) => {
  const [flavors, setFlavors] = useState<string[]>([]);
  const [specs, setSpecs] = useState<Record<string, QSpec>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/quality-specs`);
      const d = await r.json();
      setFlavors(d.flavors || []);
      setSpecs(d.specs || {});
      setDirty(new Set());
    } catch { setMsg('❌ โหลดสเปกไม่สำเร็จ'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const hasAny = (s?: QSpec) => !!s && SPEC_FIELDS.some(f => s[f] != null);
  const val = (fl: string, f: keyof QSpec) => { const v = specs[fl]?.[f]; return v == null ? '' : String(v); };
  const setField = (fl: string, f: keyof QSpec, raw: string) => {
    const num = raw.trim() === '' ? null : Number(raw);
    setSpecs(prev => {
      const cur: QSpec = prev[fl] || { brix_min: null, brix_max: null, ph_min: null, ph_max: null };
      return { ...prev, [fl]: { ...cur, [f]: (num == null || isNaN(num)) ? null : num } };
    });
    setDirty(prev => new Set(prev).add(fl));
  };
  const save = async () => {
    if (!dirty.size) return;
    setSaving(true); setMsg('กำลังบันทึก…');
    try {
      const items = Array.from(dirty).map(fl => ({ flavor: fl, ...specs[fl] }));
      const r = await fetch(`${apiUrl}/api/quality-specs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
      if (!r.ok) throw new Error();
      setDirty(new Set()); setMsg(`✅ บันทึกแล้ว ${items.length} รส`);
    } catch { setMsg('❌ บันทึกไม่สำเร็จ'); }
    finally { setSaving(false); }
  };

  const shown = flavors.filter(f => f.toLowerCase().includes(filter.toLowerCase().trim()));
  const setCount = flavors.filter(f => hasAny(specs[f])).length;
  const inp: React.CSSProperties = { width: '100%', border: '1px solid #dde3e7', borderRadius: 8, padding: '7px 6px', fontSize: '.82rem', textAlign: 'center', boxSizing: 'border-box' };
  const hcell: React.CSSProperties = { fontSize: '.62rem', fontWeight: 800, color: '#90a4ae', textAlign: 'center', letterSpacing: '.02em' };
  const gridCols = 'minmax(0,1.5fr) repeat(4, minmax(0,1fr))';

  return (
    <div>
      <div style={{ ...card }}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>🧪 สเปกคุณภาพต่อรส (baseline)</div>
        <div style={{ fontSize: '.76rem', color: '#9aa0a6', lineHeight: 1.5 }}>
          ตั้งช่วง Brix / pH ที่ปกติของแต่ละรส — ระบบจะเตือน “ผิดปกติ” ในสรุปสิ้นกะ <b>เฉพาะรสที่ตั้งไว้และค่าออกนอกช่วง</b> เท่านั้น (รสที่ยังไม่ตั้ง = ไม่เตือน) · เว้นว่างช่องไหน = ไม่เช็กด้านนั้น
        </div>
        <div style={{ fontSize: '.72rem', color: '#546e7a', marginTop: 8 }}>ตั้งแล้ว <b style={{ color: '#2e7d32' }}>{setCount}</b> / {flavors.length} รส</div>
      </div>

      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="🔍 ค้นหารสชาติ…"
        style={{ width: '100%', border: '1px solid #dde3e7', borderRadius: 11, padding: '10px 12px', fontSize: '.85rem', marginBottom: 10, boxSizing: 'border-box' }} />

      <div style={{ ...card, padding: '10px 12px' }}>
        {/* header */}
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 6, alignItems: 'end', paddingBottom: 8, borderBottom: '1px solid #eee' }}>
          <div style={{ ...hcell, textAlign: 'left' }}>รสชาติ</div>
          <div style={hcell}>Brix ต่ำ</div><div style={hcell}>Brix สูง</div>
          <div style={hcell}>pH ต่ำ</div><div style={hcell}>pH สูง</div>
        </div>
        {shown.length === 0 && <div style={{ textAlign: 'center', color: '#bbb', padding: 16, fontSize: '.82rem' }}>ไม่พบรสชาติ</div>}
        {shown.map(fl => (
          <div key={fl} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 6, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #f4f4f4' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: hasAny(specs[fl]) ? '#2e7d32' : '#d3dae0' }} />
              <span style={{ fontSize: '.8rem', fontWeight: 600, color: '#37474f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fl}>{fl}</span>
            </div>
            {SPEC_FIELDS.map(f => (
              <input key={f} type="number" step="0.01" inputMode="decimal" value={val(fl, f)} placeholder="–"
                onChange={e => setField(fl, f, e.target.value)} style={inp} />
            ))}
          </div>
        ))}
      </div>

      <div style={{ position: 'sticky', bottom: 8, marginTop: 12 }}>
        <button onClick={save} disabled={!dirty.size || saving}
          style={{ width: '100%', border: 'none', borderRadius: 12, padding: 14, fontWeight: 800, fontSize: '.92rem', color: '#fff', cursor: dirty.size ? 'pointer' : 'default', background: dirty.size ? 'linear-gradient(135deg,#ff6b00,#ff8c00)' : '#cfd8dc', boxShadow: dirty.size ? '0 4px 14px rgba(255,107,0,.3)' : 'none' }}>
          {saving ? 'กำลังบันทึก…' : dirty.size ? `💾 บันทึก ${dirty.size} รส` : '💾 บันทึก'}
        </button>
        {msg && <div style={{ textAlign: 'center', fontSize: '.8rem', color: '#78828a', marginTop: 8 }}>{msg}</div>}
      </div>
    </div>
  );
};

const ReportTab: React.FC<{ card: React.CSSProperties }> = ({ card }) => {
  const [cfg, setCfg] = useState<ReportCfg | null>(null);
  const [msg, setMsg] = useState('');
  const [oDate, setODate] = useState(todayBKK());
  const [oTime, setOTime] = useState('14:00');

  const load = useCallback(async () => { try { const r = await fetch(`${apiUrl}/api/report/config`); setCfg(await r.json()); } catch { /* offline */ } }, []);
  useEffect(() => { load(); }, [load]);

  const saveCfg = async (patch: Partial<ReportCfg>) => {
    if (!cfg) return; const next = { ...cfg, ...patch }; setCfg(next);
    await fetch(`${apiUrl}/api/report/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoEnabled: next.autoEnabled, times: next.times, weekdays: next.weekdays, onlyIfPending: next.onlyIfPending, autoAtShiftEnd: next.autoAtShiftEnd }) });
  };
  const sendNow = async () => { setMsg('กำลังส่ง…'); try { const r = await fetch(`${apiUrl}/api/duty/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: todayBKK() }) }); const d = await r.json(); setMsg(d.sent ? '✅ ส่งเข้า Telegram แล้ว' : '⚠️ ยังไม่ได้ตั้งค่า Telegram บนเซิร์ฟเวอร์'); } catch { setMsg('❌ ส่งไม่สำเร็จ'); } };
  const addOnce = async () => { await fetch(`${apiUrl}/api/report/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runAt: `${oDate}T${oTime}` }) }); await load(); };
  const delOnce = async (id: number) => { await fetch(`${apiUrl}/api/report/schedule/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); await load(); };

  if (!cfg) return <div style={{ textAlign: 'center', color: '#bbb', padding: 24 }}>กำลังโหลด…</div>;
  const eyebrow = (t: string) => <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 2px 10px' }}><span style={{ width: 4, height: 15, borderRadius: 3, background: '#ff6b00' }} /><h3 style={{ fontSize: '.9rem', fontWeight: 800, margin: 0 }}>{t}</h3></div>;
  const Toggle = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <div onClick={onClick} style={{ width: 46, height: 26, borderRadius: 20, background: on ? '#2e7d32' : '#d3dae0', position: 'relative', cursor: 'pointer', flexShrink: 0, transition: 'background .2s' }}>
      <div style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)', transition: 'left .2s' }} />
    </div>
  );

  return (
    <div>
      <div style={{ ...card }}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>📤 ส่งสรุปงานเข้า Telegram</div>
        <div style={{ fontSize: '.76rem', color: '#9aa0a6', marginBottom: 14 }}>กลุ่ม “Production report”</div>
        <button onClick={sendNow} style={{ width: '100%', border: 'none', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '.92rem', color: '#fff', background: 'linear-gradient(135deg,#ff6b00,#ff8c00)', cursor: 'pointer' }}>⚡ ส่งเดี๋ยวนี้</button>
        {msg && <div style={{ textAlign: 'center', fontSize: '.8rem', color: '#78828a', marginTop: 8 }}>{msg}</div>}
      </div>

      {eyebrow('ตั้งเวลาส่งครั้งเดียว')}
      <div style={{ ...card }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div><label style={{ display: 'block', fontSize: '.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 6 }}>วันที่</label><input type="date" value={oDate} onChange={e => setODate(e.target.value)} style={{ width: '100%', border: '1px solid #dde3e7', borderRadius: 11, padding: 10 }} /></div>
          <div><label style={{ display: 'block', fontSize: '.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 6 }}>เวลา</label><input type="time" value={oTime} onChange={e => setOTime(e.target.value)} style={{ width: '100%', border: '1px solid #dde3e7', borderRadius: 11, padding: 10 }} /></div>
        </div>
        <button onClick={addOnce} style={{ width: '100%', border: '1px solid #eee', background: '#fff', borderRadius: 12, padding: 12, fontWeight: 800, color: '#546e7a', cursor: 'pointer' }}>🕒 ตั้งเวลาส่ง</button>
        {cfg.once.length > 0 && <div style={{ marginTop: 12 }}>
          {cfg.once.map(o => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px', borderBottom: '1px solid #f4f4f4', fontSize: '.82rem' }}>
              <span style={{ flex: 1 }}>🕒 {o.run_at.replace('T', ' · ')} น.</span>
              <button onClick={() => delOnce(o.id)} style={{ border: 'none', background: 'none', color: '#ccc', cursor: 'pointer', fontSize: '1rem' }}>×</button>
            </div>
          ))}
        </div>}
      </div>

      {eyebrow('ส่งอัตโนมัติ (Auto)')}
      <div style={{ ...card }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12 }}>
          <span style={{ fontWeight: 800, fontSize: '.88rem' }}>เปิดส่งอัตโนมัติ</span>
          <Toggle on={cfg.autoEnabled} onClick={() => saveCfg({ autoEnabled: !cfg.autoEnabled })} />
        </div>
        <div style={{ borderTop: '1px solid #eee', paddingTop: 12, opacity: cfg.autoEnabled ? 1 : 0.5, pointerEvents: cfg.autoEnabled ? 'auto' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div><div style={{ fontSize: '.82rem', fontWeight: 800, color: '#37474f' }}>⏰ ส่งตอนสิ้นกะอัตโนมัติ</div><div style={{ fontSize: '.68rem', color: '#9aa0a6' }}>ตามตารางจริง (จ–พฤ 14/22/06 · ศ-อา 18/06 · เสาร์หยุด)</div></div>
            <Toggle on={cfg.autoAtShiftEnd} onClick={() => saveCfg({ autoAtShiftEnd: !cfg.autoAtShiftEnd })} />
          </div>
          <label style={{ display: 'block', fontSize: '.74rem', fontWeight: 700, color: '#546e7a', margin: '14px 0 7px' }}>หรือกำหนดเวลาเพิ่มเอง</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {SHIFT_TIMES.map(([t, l]) => { const on = cfg.times.includes(t); return (
              <button key={t} onClick={() => saveCfg({ times: on ? cfg.times.filter(x => x !== t) : [...cfg.times, t] })}
                style={{ border: '2px solid', borderColor: on ? 'transparent' : '#e0e0e0', background: on ? '#ff6b00' : '#fff', color: on ? '#fff' : '#666', borderRadius: 22, padding: '8px 13px', fontSize: '.8rem', fontWeight: 700, cursor: 'pointer' }}>{l}</button>
            ); })}
          </div>
          <label style={{ display: 'block', fontSize: '.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 7 }}>วันที่ส่ง (เฉพาะเวลากำหนดเอง)</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {WEEKDAY_OPTS.map(([w, l]) => { const on = cfg.weekdays.includes(w); return (
              <div key={w} onClick={() => saveCfg({ weekdays: on ? cfg.weekdays.filter(x => x !== w) : [...cfg.weekdays, w] })}
                style={{ flex: 1, textAlign: 'center', padding: '8px 0', border: '2px solid', borderColor: on ? 'transparent' : '#e0e0e0', background: on ? '#3949ab' : '#fff', color: on ? '#fff' : '#546e7a', borderRadius: 10, fontSize: '.74rem', fontWeight: 700, cursor: 'pointer' }}>{l}</div>
            ); })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #eee', paddingTop: 12 }}>
            <span style={{ fontSize: '.82rem', fontWeight: 700, color: '#546e7a' }}>ส่งเฉพาะเมื่อมีงานค้าง</span>
            <Toggle on={cfg.onlyIfPending} onClick={() => saveCfg({ onlyIfPending: !cfg.onlyIfPending })} />
          </div>
        </div>
      </div>
      <div style={{ fontSize: '.72rem', color: '#9aa0a6', textAlign: 'center', marginTop: 4, lineHeight: 1.6 }}>บันทึกอัตโนมัติเมื่อแก้ไข · เซิร์ฟเวอร์เช็กทุกนาที</div>
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
    if (duty.holiday) return <div style={{ ...card, textAlign: 'center', padding: 40 }}><div style={{ fontSize: '2rem' }}>🚫</div><div style={{ fontWeight: 800, marginTop: 8 }}>วันเสาร์ — วันหยุด</div><div style={{ fontSize: '0.8rem', color: '#90a4ae', marginTop: 4 }}>ไม่มีกะทำงาน</div></div>;

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
            {CAT_KEYS.map(k => { const cc = CAT_COLOR[k] || { c: '#ff6b00', w: '#fff3e9' }; const on = cat === k; return (
              <button key={k} onClick={() => setCat(k)} style={{ border: '2px solid', borderColor: on ? 'transparent' : '#e0e0e0', background: on ? '#ff6b00' : cc.w, color: on ? '#fff' : cc.c, borderRadius: 22, padding: '7px 13px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer' }}>{CAT[k].icon} {CAT[k].label}</button>
            ); })}
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
    const [msgs, setMsgs] = useState<ChatMsg[]>([{ role: 'assistant', text: 'สวัสดีครับ ถามหรือสั่งได้เลย เช่น\n• "วันนี้ Line 2 ทำอะไรไปแล้วบ้าง" / "สัปดาห์นี้รสไหนผลิตเยอะสุด"\n• "บันทึกผลิต Amazon batch C Line 2 brix 12.4" (มีการ์ดให้กดยืนยันก่อนบันทึกจริง)\n• "บันทึกรอบ CIP Line 3 มี backwash" / "วางแผนพรุ่งนี้ Amazon 6 batch"\n• 📎 แนบรูปแผนผลิตรายสัปดาห์ แล้วถาม "วันนี้กะผมผลิตอะไรบ้าง"\n• ถามเรื่องระบบ/กะทำงาน/วิธีใช้แอปได้ด้วย' }]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    // รูปที่แนบ (หลายรูป/หลายส่วน) — data = base64 ไม่รวม prefix, preview = data URL สำหรับแสดง
    type Attach = { preview: string; data: string; mediaType: string };
    const [imgs, setImgs] = useState<Attach[]>([]);
    const fileRef = useRef<HTMLInputElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);
    // แปลงไฟล์ → HTMLImageElement
    const fileToEl = (file: File) => new Promise<HTMLImageElement>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const el = new Image(); el.onload = () => resolve(el); el.onerror = reject; el.src = String(reader.result); };
      reader.onerror = reject; reader.readAsDataURL(file);
    });
    // วาดพื้นที่ [sx..sx+sw] เต็มความสูง เป็น JPEG (ย่อขอบยาว ≤1568) · labelW>0 = แปะแถบคอลัมน์ชื่อซ้ายสุดไว้ข้างหน้า
    const regionToJpeg = (el: HTMLImageElement, sx: number, sw: number, labelW: number): Attach => {
      const outW = labelW + sw, outH = el.height;
      const scale = Math.min(1, 1568 / Math.max(outW, outH));
      const w = Math.max(1, Math.round(outW * scale)), h = Math.max(1, Math.round(outH * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
      if (labelW > 0) cx.drawImage(el, 0, 0, labelW, el.height, 0, 0, Math.round(labelW * scale), h);
      cx.drawImage(el, sx, 0, sw, el.height, Math.round(labelW * scale), 0, Math.round(sw * scale), h);
      const dataUrl = cv.toDataURL('image/jpeg', 0.85);
      return { preview: dataUrl, data: dataUrl.split(',')[1] || '', mediaType: 'image/jpeg' };
    };
    // เพิ่มไฟล์: ถ้ารูปกว้าง+แน่น → หั่นเป็นหลายส่วนความละเอียดเต็ม (แต่ละส่วนมีคอลัมน์ชื่อซ้ายสุดติดไปด้วย)
    const addFiles = async (files: FileList | File[]) => {
      const list = Array.from(files).filter(f => f.type.startsWith('image/'));
      for (const f of list) {
        try {
          const el = await fileToEl(f);
          const wide = el.width > 2000 && el.width / el.height > 1.5; // ตารางแผนกว้างๆ
          if (wide) {
            const n = Math.min(4, Math.ceil(el.width / 1400));
            const stripW = Math.ceil(el.width / n);
            const labelW = Math.round(el.width * 0.22); // ~คอลัมน์ Group/Code/Name ซ้ายสุด
            const tiles: Attach[] = [];
            for (let i = 0; i < n; i++) {
              const sx = i * stripW, sw = Math.min(stripW, el.width - sx);
              tiles.push(regionToJpeg(el, sx, sw, i === 0 ? 0 : labelW)); // ส่วนแรกมีคอลัมน์ชื่ออยู่แล้ว
            }
            setImgs(prev => [...prev, ...tiles].slice(0, 6));
          } else {
            setImgs(prev => [...prev, regionToJpeg(el, 0, el.width, 0)].slice(0, 6));
          }
        } catch { /* ข้ามไฟล์ที่โหลดไม่ได้ */ }
      }
    };
    const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; };
    const onPaste = (e: React.ClipboardEvent) => { const fs = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean) as File[]; if (fs.length) addFiles(fs); };
    const send = async () => {
      const text = input.trim();
      if ((!text && !imgs.length) || busy) return;
      const staged = imgs;
      setMsgs(m => [...m, { role: 'user', text: text || (staged.length ? '(แนบรูป)' : ''), images: staged.length ? staged.map(a => a.preview) : undefined }]);
      setInput(''); setImgs([]); setBusy(true);
      try {
        const r = await fetch(`${apiUrl}/api/assistant`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, operator: operatorName, session: `web-${operatorName || 'guest'}`,
            images: staged.length ? staged.map(a => ({ data: a.data, media_type: a.mediaType })) : undefined }),
        });
        const d = await r.json();
        setMsgs(m => [...m, { role: 'assistant', text: d.reply || d.error || 'ขออภัย เกิดข้อผิดพลาด', pending: d.pending && d.pending.length ? d.pending.map((p: PendingAction) => ({ ...p, status: 'pending' as const })) : undefined }]);
        if (d.actions && d.actions.length) onAfterAction();
      } catch {
        setMsgs(m => [...m, { role: 'assistant', text: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' }]);
      } finally { setBusy(false); }
    };
    // กด ✅/❌ บนการ์ดยืนยัน → เขียนข้อมูลจริง (หรือยกเลิก) แล้วอัปเดตสถานะการ์ด
    const decide = async (actionId: number, approve: boolean) => {
      setMsgs(m => m.map(msg => !msg.pending ? msg : ({ ...msg, pending: msg.pending.map(p => p.id === actionId ? { ...p, status: (approve ? 'approved' : 'rejected') as PendingAction['status'], result: 'กำลังบันทึก…' } : p) })));
      try {
        const r = await fetch(`${apiUrl}/api/assistant/confirm`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_id: actionId, approve, operator: operatorName }),
        });
        const d = await r.json();
        const ok = d.ok && (!approve || d.status === 'approved');
        setMsgs(m => m.map(msg => !msg.pending ? msg : ({ ...msg, pending: msg.pending.map(p => p.id === actionId ? { ...p, status: (ok ? (approve ? 'approved' : 'rejected') : 'error') as PendingAction['status'], result: d.message || d.error || '' } : p) })));
        // เฟส 3: ผู้ช่วยทำขั้นตอนถัดไปต่อหลังยืนยัน — แสดงข้อความ/การ์ดใหม่ที่ตอบกลับมา
        if (ok && d.followUp) {
          setMsgs(m => [...m, { role: 'assistant', text: d.followUp, pending: d.pending && d.pending.length ? d.pending.map((p: PendingAction) => ({ ...p, status: 'pending' as const })) : undefined }]);
        }
        if (ok && approve) onAfterAction();
      } catch {
        setMsgs(m => m.map(msg => !msg.pending ? msg : ({ ...msg, pending: msg.pending.map(p => p.id === actionId ? { ...p, status: 'error' as const, result: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' } : p) })));
      }
    };
    return (
      <div style={{ ...card, display: 'flex', flexDirection: 'column', height: '70vh', padding: '0', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ marginBottom: '10px' }}>
              <div style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '80%', padding: '10px 14px', borderRadius: '16px', fontSize: '0.88rem', lineHeight: 1.5, whiteSpace: 'pre-wrap',
                  background: m.role === 'user' ? 'linear-gradient(135deg,#ff6b00,#ff8c00)' : '#f4f5f6',
                  color: m.role === 'user' ? '#fff' : '#37474f',
                  borderBottomRightRadius: m.role === 'user' ? '4px' : '16px',
                  borderBottomLeftRadius: m.role === 'user' ? '16px' : '4px',
                }}>
                  {m.images && m.images.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: m.text ? 8 : 0 }}>
                      {m.images.map((src, ii) => <img key={ii} src={src} alt="แนบ" style={{ display: 'block', maxWidth: m.images!.length > 1 ? '48%' : '100%', maxHeight: 200, borderRadius: 10 }} />)}
                    </div>
                  )}
                  {m.text}
                </div>
              </div>
              {/* การ์ดยืนยันการบันทึก — AI เตรียมข้อมูลไว้ ผู้ใช้ต้องกดยืนยันก่อนเขียนจริง */}
              {m.pending?.map(p => (
                <div key={p.id} style={{
                  maxWidth: '80%', marginTop: '6px', padding: '12px 14px', borderRadius: '14px', fontSize: '0.86rem',
                  background: '#fff7f0', border: '1.5px solid #ffd0a8', boxShadow: '0 2px 10px rgba(255,107,0,0.08)',
                }}>
                  <div style={{ fontWeight: 700, color: '#b34700', marginBottom: '4px' }}>⏳ รอยืนยันการบันทึก</div>
                  <div style={{ color: '#5d4037', whiteSpace: 'pre-wrap', marginBottom: '10px' }}>{p.summary}</div>
                  {p.status === 'pending' ? (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={() => decide(p.id, true)} style={{ flex: 1, padding: '8px 0', borderRadius: '10px', border: 'none', background: '#2e7d32', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>✅ ยืนยันบันทึก</button>
                      <button onClick={() => decide(p.id, false)} style={{ flex: 1, padding: '8px 0', borderRadius: '10px', border: '1px solid #ddd', background: '#fff', color: '#78828a', fontWeight: 600, cursor: 'pointer' }}>❌ ยกเลิก</button>
                    </div>
                  ) : (
                    <div style={{ fontWeight: 600, color: p.status === 'approved' ? '#2e7d32' : p.status === 'rejected' ? '#78828a' : '#c62828' }}>
                      {p.status === 'approved' ? '✅ ' : p.status === 'rejected' ? '🚫 ' : '⚠️ '}{p.result || (p.status === 'approved' ? 'บันทึกแล้ว' : 'ยกเลิกแล้ว')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {busy && <div style={{ color: '#9aa0a6', fontSize: '0.8rem' }}>กำลังคิด…</div>}
          <div ref={endRef} />
        </div>
        <div style={{ borderTop: '1px solid #eee', background: '#fff' }}>
          {/* รูปที่แนบไว้ รอส่ง — thumbnail หลายรูป + ปุ่มเอาออกทีละรูป */}
          {imgs.length > 0 && (
            <div style={{ padding: '10px 10px 0' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                {imgs.map((a, ii) => (
                  <div key={ii} style={{ position: 'relative' }}>
                    <img src={a.preview} alt="แนบ" style={{ height: 54, width: 54, objectFit: 'cover', borderRadius: 8, border: '1px solid #ffd0a8' }} />
                    <button onClick={() => setImgs(prev => prev.filter((_, j) => j !== ii))} title="เอารูปออก" style={{ position: 'absolute', top: -7, right: -7, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#37474f', color: '#fff', fontSize: 12, lineHeight: '20px', cursor: 'pointer', padding: 0 }}>✕</button>
                  </div>
                ))}
              </div>
              <span style={{ fontSize: '0.78rem', color: '#78828a' }}>📎 แนบ {imgs.length} รูป (รูปแผนกว้างจะถูกหั่นเป็นส่วนๆ ให้อ่านชัดอัตโนมัติ) — พิมพ์คำถามแล้วกดส่ง</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px', padding: '10px' }}>
            <input ref={fileRef} type="file" accept="image/*" multiple onChange={onPickFile} style={{ display: 'none' }} />
            <button onClick={() => fileRef.current?.click()} disabled={busy} title="แนบรูป (แผนผลิต ฯลฯ) — เลือกได้หลายรูป"
              style={{ padding: '10px 12px', borderRadius: '12px', border: '1px solid #ddd', background: '#fff', color: '#546e7a', fontSize: '1.05rem', cursor: 'pointer' }}>📎</button>
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} onPaste={onPaste}
              placeholder={imgs.length ? 'ถามเกี่ยวกับรูปนี้…' : 'พิมพ์ข้อความ… (แนบรูปแผนได้ด้วย 📎)'} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: '12px' }} />
            <button onClick={send} disabled={busy} style={{ padding: '10px 18px', borderRadius: '12px', border: 'none', background: '#ff6b00', color: '#fff', fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>ส่ง</button>
          </div>
        </div>
      </div>
    );
  };

export default TodoBoard;
