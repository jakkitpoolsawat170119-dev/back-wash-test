import React, { useState, useEffect, useCallback, useRef } from 'react';
import { currentWorkDay, shiftInfo, shiftsForWeekday, weekdayOf, nextShiftName } from '../shiftSchedule';
import { uploadDutyImage } from '../lib/dutyImages';
import AuditBoard from './AuditBoard';

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
type ChatMsg = { role: 'user' | 'assistant'; text: string; pending?: PendingAction[]; images?: string[]; handoverReady?: boolean };
// แผนผลิตรายกะที่ AI แกะมา (material balance Phase 1) — รอผู้ใช้ตรวจ/แก้/บันทึก
type PlanItem = { flavor: string; target_boxes: number; staff: number | null; machine_code?: string; spec?: string };

const CAT: Record<string, { icon: string; label: string }> = {
  production: { icon: '🏭', label: 'ผลิต' },
  cip: { icon: '💧', label: 'CIP' },
  backwash: { icon: '🧴', label: 'Backwash' },
  cleaning: { icon: '🧽', label: 'ทำความสะอาด' },
  mixing: { icon: '🥤', label: 'ส่วนผสม' },
  packing: { icon: '📦', label: 'บรรจุ' },
  maintenance: { icon: '🔧', label: 'ซ่อมบำรุง' },
  manual: { icon: '📌', label: 'ทั่วไป' },
  am: { icon: '🔧', label: 'ซ่อมบำรุง' }, // legacy alias — ข้อมูลเก่าที่บันทึกเป็น 'am' ให้แสดงเป็นซ่อมบำรุง
};
// ลำดับหมวดที่ใช้เลือกใน UI (ไม่รวม alias 'am')
const CAT_KEYS = ['production', 'cip', 'backwash', 'cleaning', 'mixing', 'packing', 'maintenance', 'manual'];
// สีประจำหมวด (ยังไม่เลือก = tint อ่อน, เลือกแล้ว = ส้ม)
const CAT_COLOR: Record<string, { c: string; w: string }> = {
  production: { c: '#2e7d32', w: '#e8f5e9' },
  cip: { c: '#0277bd', w: '#e1f2fb' },
  backwash: { c: '#00897b', w: '#e0f2f1' },
  cleaning: { c: '#00838f', w: '#e0f7fa' },
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
// ตัวเลือกแจ้งเตือนล่วงหน้า (ค่า = ส่งให้ backend, label = แสดงผล)
const REMIND_OPTIONS: [string, string][] = [
  ['none', 'ไม่เตือน'], ['30m', 'ล่วงหน้า 30 นาที'], ['1h', 'ล่วงหน้า 1 ชม.'],
  ['2h', 'ล่วงหน้า 2 ชม.'], ['1d', 'ล่วงหน้า 1 วัน'], ['morning', 'เช้าวันงาน 08:00'],
];

// refImage = รูปอ้างอิงของหัวข้อ (ตั้งครั้งเดียว ใช้ทุกวัน) · doneImage = รูปหลังทำของวันนั้น (เปลี่ยนได้ตลอด)
// ถ้าเก็บเป็น base64 (ตอนไม่มี Supabase) server จะส่งมาแค่ hasRefImage/hasDoneImage แล้วค่อยโหลดตอนกดดู
type DutyNode = { key: string; title: string; depth: number; mono: boolean; id?: number; parentId?: number | null; checked: boolean; bypassed: boolean; bypassReason: string | null; handoffTo: string | null; handoffToName: string | null; refImage?: string | null; hasRefImage?: boolean; doneImage?: string | null; hasDoneImage?: boolean };
type Received = { ownerKey: string; fromName: string; nodeKey: string; title: string; checked: boolean };
type AdhocTask = { id: number; title: string; category: string; location: string | null; priority: string; status: string; handoffFrom: string | null; hasImages?: boolean; hasDoneImages?: boolean; images?: string[]; doneImages?: string[] };

// ย่อรูปแบบง่าย (ไม่มี auto-tiling) — ขอบยาว ≤1568 → JPEG q0.85 · คืน data URL + base64 สำหรับส่ง
type PhotoAttach = { preview: string; data: string; mediaType: string };
const resizePhoto = (file: File): Promise<PhotoAttach> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const el = new Image();
    el.onload = () => {
      const scale = Math.min(1, 1568 / Math.max(el.width, el.height));
      const w = Math.max(1, Math.round(el.width * scale)), h = Math.max(1, Math.round(el.height * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
      cx.drawImage(el, 0, 0, w, h);
      const dataUrl = cv.toDataURL('image/jpeg', 0.85);
      resolve({ preview: dataUrl, data: dataUrl.split(',')[1] || '', mediaType: 'image/jpeg' });
    };
    el.onerror = reject; el.src = String(reader.result);
  };
  reader.onerror = reject; reader.readAsDataURL(file);
});
type DutyPerson = { key: string; name: string; role: string; color?: string; wash?: string; initial?: string; dot?: string; nodes: DutyNode[]; received: Received[]; adhoc: AdhocTask[]; done: number; total: number; pct: number };
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
interface Props { operatorName: string | null; onBackToMain: () => void; onGoToProduction?: () => void; }

const TodoBoard: React.FC<Props> = ({ operatorName, onBackToMain, onGoToProduction }) => {
  const [tab, setTab] = useState<'today' | 'audit' | 'calendar' | 'report' | 'timeline' | 'recurring' | 'ai' | 'specs'>('today');
  const [date, setDate] = useState(currentWorkDay());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [aiHandoverDraft, setAiHandoverDraft] = useState<HoState | null>(null); // ร่างฟอร์มรับกะจากผู้ช่วย AI → รอ HandoverForm มาเก็บไปใช้
  const [aiPlanSignal, setAiPlanSignal] = useState(0); // stepper "ลงแผนผลิต" → เด้งไปแท็บ AI + เข้าโหมดลงแผน
  const [aiHandoverSignal, setAiHandoverSignal] = useState(0); // stepper "รับกะ → ให้ AI ช่วย" → เด้งไปแท็บ AI + โหมดกรอกรับกะ

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
      {tab === 'today' && <DutyBoard date={date} operatorName={operatorName} card={card} onGoToAudit={() => setTab('audit')} />}

      {/* ── ใบตรวจ — ไม่มีแท็บของตัวเอง เข้าทางปุ่ม "พื้นที่รับผิดชอบ" ในงานวันนี้ ── */}
      {tab === 'audit' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <button onClick={() => setTab('today')} style={{
              border: '1px solid #e0e0e0', background: '#fff', borderRadius: '10px',
              padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, color: '#666', cursor: 'pointer',
            }}>← งานวันนี้</button>
            <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#37474f' }}>🧾 พื้นที่รับผิดชอบ</span>
          </div>
          <AuditBoard operatorName={operatorName} onBackToMain={onBackToMain} embedded />
        </>
      )}

      {/* ── TAB: calendar ─────────────────────────────────────── */}
      {tab === 'calendar' && (
        <CalendarTab card={card} onOpenDate={(d) => { setDate(d); setTab('today'); }} />
      )}

      {/* ── TAB: report ───────────────────────────────────────── */}
      {tab === 'report' && <ReportTab card={card} />}

      {/* ── TAB: timeline + handover ──────────────────────────── */}
      {tab === 'timeline' && (
        <TimelineTab date={date} operatorName={operatorName} events={events} reload={loadTimeline} card={card}
          aiDraft={aiHandoverDraft} onDraftConsumed={() => setAiHandoverDraft(null)}
          onGoToPlan={() => { setAiPlanSignal(n => n + 1); setTab('ai'); }}
          onGoToHandoverAI={() => { setAiHandoverSignal(n => n + 1); setTab('ai'); }}
          onGoToProduction={onGoToProduction} />
      )}

      {/* ── TAB: recurring ────────────────────────────────────── */}
      {tab === 'recurring' && (
        <RecurringTab templates={templates} tasks={tasks} reload={loadTemplates} card={card} />
      )}

      {/* ── TAB: AI — คงไว้ตลอด (ซ่อนด้วย CSS) เพื่อไม่ให้บทสนทนาหายเมื่อสลับแท็บ ── */}
      <div style={{ display: tab === 'ai' ? 'block' : 'none' }}>
        <AssistantTab operatorName={operatorName} onAfterAction={loadTasks} card={card}
          onHandoverDraft={(draft) => setAiHandoverDraft(draft)} onGoToHandoverForm={() => setTab('timeline')} planSignal={aiPlanSignal} handoverSignal={aiHandoverSignal} />
      </div>

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
// map ผลจาก /api/handover/prefill → HoState สำหรับโหมดส่งกะ
// รส/Batch/ถัง มาจาก "การผลิตจริงวันนี้": ถัง 3 = batch สุดท้าย, ถัง 2 = รองสุดท้าย (เว้น % ให้คนกรอก)
// ไลน์ที่ไม่มีการผลิต (เช่น CIP) → ถังว่าง · Line 4 ยกจากกะก่อน · CIP ล่าสุด/งานค้าง → หมายเหตุ
type PrefillLine = { flavor?: string; batch?: string; cipTime?: string; recentBatches?: string[] };
type BacklogItem = { line_name?: string; category?: string; title?: string };
// material balance (Phase 2) — ข้อมูลดิบต่อไลน์จาก /api/handover/balance (client คำนวณ boxes เอง)
type BalLine = { line: string; receivedFlavor: string; receivedTanks: string[]; producedBatches: string[]; producedCount: number };
function hoFromPrefill(prefill: Record<string, PrefillLine>, carry?: HoState | null, backlog?: BacklogItem[]): HoState {
  const base = carry || initHo();
  const lines = HO_LINES.map((l, i) => {
    const pf = prefill[l.line] || {};
    const prev = base.lines[i] || { line: l.line, flavor: '', batch: '', tanks: ['', '', ''], note: '', lotNo: '' };
    // ถังจาก batch ที่ผลิตจริงวันนี้ (ใหม่สุด = ถังเลขมาก) — เว้น % ให้ผู้ใช้กรอก · ไม่มีผลิต = ว่าง
    const rb = Array.isArray(pf.recentBatches) ? pf.recentBatches.filter(Boolean) : [];
    const tanks = ['', '', ''];
    if (rb.length >= 1) tanks[2] = `Batch ${rb[rb.length - 1]}`;   // สุดท้าย → ถัง 3
    if (rb.length >= 2) tanks[1] = `Batch ${rb[rb.length - 2]}`;   // รองสุดท้าย → ถัง 2
    const cipHM = pf.cipTime ? parseHM(pf.cipTime)?.hm : null;      // CIP ล่าสุด → หมายเหตุไลน์
    return { ...prev, line: l.line, flavor: pf.flavor || '', batch: pf.batch || '', tanks, note: cipHM ? `CIP ล่าสุด ${cipHM}` : '' };
  });
  // งานค้าง → หมายเหตุรวม "ส่งต่อ"
  const note = (backlog && backlog.length)
    ? 'งานค้างส่งต่อ: ' + backlog.map(b => `${b.title || ''}${b.line_name ? ` (${b.line_name})` : ''}`.trim()).filter(Boolean).join(' · ')
    : '';
  return { ...base, lines, note };
}
// เติม Lot No. รายไลน์ให้เป็นค่าเริ่มต้น (ddmmyy) ถ้ายังว่าง + กัน field undefined จากข้อมูลเก่า
const fillLot = (h: HoState, lot: string): HoState => ({
  ...h,
  lines: h.lines.map(l => ({ ...l, lotNo: l.lotNo || lot })),
  line4: { ...h.line4, lotNo: h.line4.lotNo || lot },
});
// หา key ของทุกฟิลด์ที่ AI เติมค่ามาให้ (ไม่ว่าง) — ใช้ไฮไลต์ในฟอร์มจนกว่าผู้ใช้จะแก้เอง
function hoFilledKeys(h: HoState): Set<string> {
  const s = new Set<string>();
  h.lines.forEach((l, i) => {
    if (l.flavor.trim()) s.add(`line${i}.flavor`);
    if (l.batch.trim()) s.add(`line${i}.batch`);
    l.tanks.forEach((t, k) => { if (t.trim()) s.add(`line${i}.tank${k}`); });
    if ((l.lotNo || '').trim()) s.add(`line${i}.lotNo`);
    if (l.note.trim()) s.add(`line${i}.note`);
  });
  if (h.line4.flavor.trim()) s.add('line4.flavor');
  h.line4.stages.forEach((v, k) => { if (v.trim()) s.add(`line4.stage${k}`); });
  if ((h.line4.lotNo || '').trim()) s.add('line4.lotNo');
  if (h.note.trim()) s.add('note');
  return s;
}

const HandoverForm: React.FC<{ date: string; operatorName: string | null; reload: () => void; card: React.CSSProperties; onLiveChange?: (ho: HoState) => void; aiDraft?: HoState | null; onDraftConsumed?: () => void; openCmd?: { mode: 'in' | 'out'; n: number }; onReceiveActive?: (active: boolean) => void }> =
  ({ date, operatorName, reload, card, onLiveChange, aiDraft, onDraftConsumed, openCmd, onReceiveActive }) => {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<'in' | 'out'>('out'); // 📥 รับกะ · 📤 ส่งกะ
    const [ho, setHo] = useState<HoState>(initHo);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');
    const [aiFilledKeys, setAiFilledKeys] = useState<Set<string>>(new Set()); // ฟิลด์ที่เติมอัตโนมัติ → ไฮไลต์จนกว่าจะแก้เอง
    const [fillSource, setFillSource] = useState<'ai' | 'live' | null>(null);  // ที่มาของไฮไลต์: AI(รับกะ) / ข้อมูลสด(ส่งกะ) — คุมป้ายแบนเนอร์
    const [balOpen, setBalOpen] = useState(false);                 // แผงคำนวณ material balance (โหมดส่งกะ)
    const [balData, setBalData] = useState<BalLine[] | null>(null);
    const [balPacked, setBalPacked] = useState<Record<string, string>>({}); // ยอดบรรจุออก (กรอกเอง) ต่อไลน์
    const [balBusy, setBalBusy] = useState(false);
    const lastRef = useRef<HoState | null>(null);                 // สถานะกะก่อน (สำหรับ รับกะ)
    const prefillRef = useRef<Record<string, PrefillLine>>({});   // รส/batch/เวลา CIP ล่าสุด (สำหรับ ส่งกะ)
    const backlogRef = useRef<BacklogItem[]>([]);                 // งานค้าง → หมายเหตุส่งต่อ (ส่งกะ)
    const aiDraftAppliedRef = useRef(false);                      // กันโหลดสถานะกะก่อน (async) มาทับร่างที่ AI เพิ่งกรอก
    const aiDraftRef = useRef<HoState | null>(null);              // เก็บร่าง AI ไว้ → สลับโหมดไป-กลับแล้วยังกู้คืนได้
    const openCmdRef = useRef(0);                                 // กันสั่งเปิดจาก stepper ซ้ำ (เทียบ openCmd.n)

    // เปิดหน้ามา: เดากะปัจจุบัน + โหลดกะก่อน (รับกะ) และรส/batch ล่าสุด (ส่งกะ) พร้อมกัน
    useEffect(() => {
      aiDraftAppliedRef.current = false; aiDraftRef.current = null; // วันเปลี่ยน = ตั้งใจโหลดสถานะใหม่ (ล้างร่าง AI รอบก่อน)
      const bkk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
      const cs = shiftInfo(currentWorkDay(), bkk.getHours()).shift;
      const shift = cs ? 'กะ' + cs : 'กะเช้า';
      (async () => {
        let last: HoState | null = null;
        let prefill: Record<string, PrefillLine> = {};
        let backlog: BacklogItem[] = [];
        try { const d = await (await fetch(`${apiUrl}/api/handover/last`)).json(); if (d.data) last = fillLot({ shift, lines: d.data.lines || initHo().lines, line4: d.data.line4 || initHo().line4, note: '' }, ''); } catch { /* offline */ }
        try { const d = await (await fetch(`${apiUrl}/api/handover/prefill?date=${date}`)).json(); prefill = d.lines || {}; backlog = d.backlog || []; } catch { /* offline */ }
        lastRef.current = last; prefillRef.current = prefill; backlogRef.current = backlog;
        // ถ้าร่าง AI ถูกใส่ไปแล้วระหว่างรอ fetch ห้ามทับ (แต่ refs ด้านบนยังเซ็ตไว้ให้ปุ่มสลับโหมดใช้)
        if (!aiDraftAppliedRef.current) {
          const draft = fillLot({ ...hoFromPrefill(prefill, last, backlog), shift }, pkLot(date)); // ร่างส่งกะเติมจากข้อมูลสด
          setHo(draft); setAiFilledKeys(hoFilledKeys(draft)); setFillSource('live'); // ไฮไลต์ให้ตรวจก่อนส่ง
        }
      })();
    }, [date]);

    // ส่งสถานะรับกะสดๆ ขึ้นไปให้ฟอร์มบรรจุใช้ (real-time, ไม่ต้องกดส่ง)
    useEffect(() => { onLiveChange?.(ho); }, [ho, onLiveChange]);
    // บอก parent ว่าอยู่ "โหมดรับกะ" (เปิด + mode in) ไหม → คุมการโชว์รายงานบรรจุ (ส่งกะ = ซ่อน)
    useEffect(() => { onReceiveActive?.(open && mode === 'in'); }, [open, mode, onReceiveActive]);

    // ร่างจากผู้ช่วย AI มาถึง → เปิดฟอร์ม โหมดรับกะ เติมค่า + ไฮไลต์ฟิลด์ที่ AI กรอกให้ ผู้ใช้ต้องตรวจสอบ/กดส่งเอง
    useEffect(() => {
      if (!aiDraft) return;
      aiDraftAppliedRef.current = true; // กันการโหลดสถานะกะก่อน (async) ที่อาจ resolve ทีหลังมาทับ
      const withLineNames: HoState = { ...aiDraft, lines: aiDraft.lines.map((l, i) => ({ ...l, line: HO_LINES[i]?.line || l.line })) };
      setOpen(true); setMode('in'); setMsg('');
      const filled = fillLot(withLineNames, pkLot(date));
      aiDraftRef.current = filled; // เก็บไว้ให้ applyMode('in') คืนค่าได้แม้ผู้ใช้สลับไปโหมดส่งกะแล้วกลับมา
      setHo(filled);
      setAiFilledKeys(hoFilledKeys(filled)); setFillSource('ai');
      onDraftConsumed?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [aiDraft]);

    const clearAiKey = (k: string) => setAiFilledKeys(prev => (prev.has(k) ? (() => { const n = new Set(prev); n.delete(k); return n; })() : prev));

    // สลับโหมด: รับกะ = สถานะกะก่อน (หรือร่าง AI ถ้ามี) · ส่งกะ = เติมจากข้อมูลสด + ไฮไลต์ให้ตรวจ
    const applyMode = (m: 'in' | 'out') => {
      if (m === mode) return; // แตะโหมดที่เลือกอยู่แล้ว = ไม่ต้องโหลดใหม่ (กันทับข้อมูลที่กำลังตรวจ/ร่าง)
      setMode(m); setMsg('');
      // กลับมาโหมดรับกะทั้งที่มีร่าง AI ค้างอยู่ → คืนร่าง AI + ไฮไลต์ (ไม่ใช่ทับด้วยสถานะกะก่อนจาก DB)
      if (m === 'in' && aiDraftRef.current) {
        setHo(aiDraftRef.current);
        setAiFilledKeys(hoFilledKeys(aiDraftRef.current)); setFillSource('ai');
        return;
      }
      if (m === 'out') { // ส่งกะ: เติมร่างจากข้อมูลสด + ไฮไลต์ให้ตรวจก่อนส่ง
        const draft = fillLot({ ...hoFromPrefill(prefillRef.current, lastRef.current, backlogRef.current), shift: ho.shift }, pkLot(date));
        setHo(draft); setAiFilledKeys(hoFilledKeys(draft)); setFillSource('live');
        return;
      }
      // รับกะที่ไม่มีร่าง AI → สถานะกะก่อนจาก DB ล้วน ไม่ต้องไฮไลต์
      setAiFilledKeys(new Set()); setFillSource(null);
      setHo(h => fillLot(lastRef.current ? { ...lastRef.current, shift: h.shift } : initHo(), pkLot(date)));
    };
    // ล้างไฮไลต์ — โหมดส่งกะ (live): แค่เอาสีอำพันออก ข้อมูลอยู่ครบ · โหมดรับกะ (ai): ทิ้งร่าง AI กลับไปสถานะกะก่อน
    const clearHighlights = () => {
      if (fillSource === 'live') { setAiFilledKeys(new Set()); setFillSource(null); return; }
      aiDraftRef.current = null; aiDraftAppliedRef.current = false;
      setAiFilledKeys(new Set()); setFillSource(null); setMode('in'); setMsg('');
      setHo(h => fillLot(lastRef.current ? { ...lastRef.current, shift: h.shift } : initHo(), pkLot(date)));
    };
    // ดึงข้อมูลสดล่าสุดมาเติมร่างส่งกะใหม่ (เผื่อผลิต/CIP เพิ่มหลังเปิดฟอร์มไว้)
    const refreshOut = async () => {
      setMsg('');
      let last: HoState | null = null, prefill: Record<string, PrefillLine> = {}, backlog: BacklogItem[] = [];
      try { const d = await (await fetch(`${apiUrl}/api/handover/last`)).json(); if (d.data) last = fillLot({ shift: ho.shift, lines: d.data.lines || initHo().lines, line4: d.data.line4 || initHo().line4, note: '' }, ''); } catch { /* offline */ }
      try { const d = await (await fetch(`${apiUrl}/api/handover/prefill?date=${date}`)).json(); prefill = d.lines || {}; backlog = d.backlog || []; } catch { /* offline */ }
      lastRef.current = last; prefillRef.current = prefill; backlogRef.current = backlog;
      const draft = fillLot({ ...hoFromPrefill(prefill, last, backlog), shift: ho.shift }, pkLot(date));
      setHo(draft); setAiFilledKeys(hoFilledKeys(draft)); setFillSource('live');
    };
    // material balance — ดึง รับกะ(boxes)+ผลิตเข้า ของกะนี้มาให้ client คำนวณ (บรรจุออกผู้ใช้กรอกเอง)
    const loadBalance = async () => {
      setBalBusy(true);
      try {
        const d = await (await fetch(`${apiUrl}/api/handover/balance?date=${date}&shift=${encodeURIComponent(ho.shift)}`)).json();
        setBalData(Array.isArray(d.lines) ? d.lines : []);
      } catch { setBalData([]); } finally { setBalBusy(false); }
    };
    // สั่งเปิดฟอร์มจากแถบขั้นตอน (stepper) — เปิด + สลับโหมดตามที่สั่ง
    useEffect(() => {
      if (!openCmd || openCmd.n === openCmdRef.current) return;
      openCmdRef.current = openCmd.n;
      setOpen(true); applyMode(openCmd.mode);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openCmd]);

    const setLine = (i: number, patch: Partial<HoLine>) => {
      setHo(h => ({ ...h, lines: h.lines.map((l, j) => j === i ? { ...l, ...patch } : l) }));
      Object.keys(patch).forEach(k => clearAiKey(`line${i}.${k}`));
    };
    const setTank = (i: number, t: number, v: string) => {
      setHo(h => ({ ...h, lines: h.lines.map((l, j) => j === i ? { ...l, tanks: l.tanks.map((x, k) => k === t ? v : x) } : l) }));
      clearAiKey(`line${i}.tank${t}`);
    };
    const setStage = (i: number, v: string) => {
      setHo(h => ({ ...h, line4: { ...h.line4, stages: h.line4.stages.map((x, k) => k === i ? v : x) } }));
      clearAiKey(`line4.stage${i}`);
    };

    const send = async () => {
      setBusy(true); setMsg('');
      try {
        await fetch(`${apiUrl}/api/handover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, operator: operatorName, kind: mode, ...ho }) });
        setMsg(mode === 'in' ? '✅ รับกะ & แจ้งกลุ่มแล้ว' : '✅ ส่งกะเข้า Telegram แล้ว'); setAiFilledKeys(new Set()); setFillSource(null); aiDraftRef.current = null; reload(); setTimeout(() => setOpen(false), 900);
      } catch { setMsg('❌ ส่งไม่สำเร็จ'); } finally { setBusy(false); }
    };

    const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #dde3e7', borderRadius: 10, padding: '9px 11px', fontSize: '0.88rem', fontFamily: 'inherit', color: '#263238' };
    const flavIn: React.CSSProperties = { marginLeft: 'auto', width: '48%', border: 'none', borderRadius: 8, padding: '7px 9px', fontSize: '0.82rem', fontWeight: 700, fontFamily: 'inherit', boxSizing: 'border-box' };
    const tag: React.CSSProperties = { fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: 'rgba(255,255,255,.25)', padding: '2px 8px', borderRadius: 20 };
    // ฟิลด์ที่ AI เติมให้ (ยังไม่ถูกแก้) → ไฮไลต์อำพันอ่อน ให้เห็นชัดว่าอันไหนต้องตรวจสอบ
    const aiStyle = (key: string): React.CSSProperties => aiFilledKeys.has(key) ? { background: '#fff8e1', borderColor: '#f0b429' } : {};

    // เมื่อปิด: ไม่แสดงการ์ด "บันทึกกะ" (ซ้ำกับแถบขั้นตอน ①/④) — เปิดผ่าน stepper เท่านั้น
    if (!open) return null;

    const modeC = mode === 'in' ? '#00897b' : '#ff6b00';
    return (
      <div style={{ ...card }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>📋 บันทึกกะ</div>
          <button onClick={() => setOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', color: '#90a4ae', cursor: 'pointer', fontSize: '1.1rem' }}>×</button>
        </div>
        {/* แบนเนอร์: เตือนว่ามีข้อมูลเติมอัตโนมัติรอตรวจ (AI สำหรับรับกะ / ข้อมูลสดสำหรับส่งกะ) */}
        {aiFilledKeys.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff8e1', border: '1px solid #f0d68a', borderRadius: 10, padding: '9px 11px', marginBottom: 10, fontSize: '0.78rem', color: '#8a6100' }}>
            <span style={{ flex: 1 }}>{fillSource === 'live' ? '🔄 เติมจากข้อมูลสด — ตรวจก่อนส่ง' : '🤖 ข้อมูลนี้มาจากผู้ช่วย AI — ตรวจสอบก่อนส่ง'}</span>
            <button onClick={clearHighlights} style={{ border: 'none', background: 'none', color: '#8a6100', fontWeight: 700, cursor: 'pointer', fontSize: '0.76rem', textDecoration: 'underline', flexShrink: 0 }}>{fillSource === 'live' ? 'ล้างไฮไลต์' : 'ล้างข้อมูล AI'}</button>
          </div>
        )}
        {/* หัวโหมด — คงที่ตามที่เปิดจากแถบขั้นตอน (รับกะ = รับกะเท่านั้น · ส่งกะ = ส่งกะเท่านั้น ไม่มีปุ่มสลับ) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: mode === 'in' ? '#00897b' : '#ff6b00', color: '#fff', borderRadius: 12, padding: '11px 14px', marginBottom: 10 }}>
          <span style={{ fontWeight: 800, fontSize: '0.95rem' }}>{mode === 'in' ? '📥 รับกะ' : '📤 ส่งกะ'}</span>
          <span style={{ fontSize: '0.68rem', opacity: 0.9, flex: 1 }}>{mode === 'in' ? 'ทบทวนสถานะจากกะก่อน/AI แล้วกดรับทราบ' : 'เติมจากข้อมูลสด ตรวจ/แก้ แล้วกดส่ง'}</span>
          {mode === 'out' && (
            <button onClick={refreshOut} title="ดึงยอดผลิต/CIP/งานค้างล่าสุดมาเติมใหม่" style={{ flexShrink: 0, border: '1px solid rgba(255,255,255,.6)', background: 'rgba(255,255,255,.18)', color: '#fff', borderRadius: 20, padding: '5px 11px', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer' }}>🔄 ดึงข้อมูลสด</button>
          )}
        </div>

        {/* แผงคำนวณ material balance (โหมดส่งกะ) — รับกะ + ผลิตเข้า อัตโนมัติ · บรรจุออกกรอกเอง · โชว์ควรเหลือ */}
        {mode === 'out' && (
          <div style={{ border: '1px solid #cfe8ff', background: '#f4faff', borderRadius: 12, marginBottom: 12, overflow: 'hidden' }}>
            <button onClick={() => { const open = !balOpen; setBalOpen(open); if (open && !balData) loadBalance(); }}
              style={{ width: '100%', border: 'none', background: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', cursor: 'pointer', fontWeight: 800, fontSize: '0.82rem', color: '#0369a1' }}>
              🧮 คำนวณถังที่ควรเหลือ (material balance)
              <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: '#7aa7c7' }}>{balOpen ? '▲ ซ่อน' : '▼ ช่วยคำนวณ'}</span>
            </button>
            {balOpen && (
              <div style={{ padding: '0 12px 12px' }}>
                <div style={{ fontSize: '0.68rem', color: '#5f7d92', marginBottom: 8 }}>รับกะ + ผลิตเข้า ดึงให้อัตโนมัติ · กรอก “บรรจุออก (Boxes)” เอง · 1 batch = 100 boxes (เอาไว้อ้างอิงกรอกถัง)</div>
                {balBusy && <div style={{ fontSize: '0.78rem', color: '#9aa0a6' }}>กำลังคำนวณ…</div>}
                {balData && balData.length === 0 && <div style={{ fontSize: '0.78rem', color: '#9aa0a6' }}>ยังไม่มีข้อมูลรับกะ/ผลิตของกะนี้</div>}
                {balData && balData.map((bl, i) => {
                  const lineNum = i + 1;
                  const received = bl.receivedTanks.reduce((s, t) => { const p = pkParse(t); return s + (p ? pkBoxes(lineNum, bl.receivedFlavor, p.amount) : 0); }, 0);
                  const produced = bl.producedCount * 100;
                  const packed = Number(balPacked[bl.line] || 0);
                  const remaining = Math.max(0, received + produced - packed);
                  const remBatch = Math.round((remaining / 100) * 10) / 10;
                  return (
                    <div key={bl.line} style={{ background: '#fff', border: '1px solid #dcebf7', borderRadius: 10, padding: '8px 10px', marginBottom: 7 }}>
                      <div style={{ fontWeight: 800, fontSize: '0.78rem', color: '#0d47a1', marginBottom: 5 }}>▶️ {bl.line} {bl.receivedFlavor && <span style={{ color: '#546e7a', fontWeight: 600 }}>· {bl.receivedFlavor}</span>}{bl.producedBatches.length > 0 && <span style={{ color: '#00897b', fontWeight: 600, fontSize: '0.72rem' }}> · ผลิต {bl.producedBatches.join(',')}</span>}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: '0.76rem', color: '#455a64' }}>
                        <span title="รับกะ (แปลงจากถัง)">รับ <b>{received}</b></span>
                        <span>+ ผลิต <b>{produced}</b></span>
                        <span>− บรรจุ</span>
                        <input type="number" value={balPacked[bl.line] || ''} onChange={e => setBalPacked(p => ({ ...p, [bl.line]: e.target.value }))} placeholder="0"
                          style={{ width: 62, border: '1px solid #cbd5db', borderRadius: 7, padding: '4px 6px', fontSize: '0.76rem' }} />
                        <span style={{ marginLeft: 'auto', fontWeight: 800, color: remaining > 0 ? '#00695c' : '#90a4ae' }}>= เหลือ {remaining} <span style={{ fontWeight: 600, fontSize: '0.68rem' }}>boxes ({remBatch} batch)</span></span>
                      </div>
                    </div>
                  );
                })}
                <button onClick={loadBalance} disabled={balBusy} style={{ border: '1px solid #b3d4ea', background: '#eaf4fc', color: '#0369a1', borderRadius: 20, padding: '5px 12px', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', marginTop: 2 }}>🔄 คำนวณใหม่</button>
              </div>
            )}
          </div>
        )}
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
              <input value={ln.flavor} onChange={e => setLine(i, { flavor: e.target.value })} placeholder="รส / สถานะ (เช่น CIP ต่อ)" style={{ ...flavIn, ...aiStyle(`line${i}.flavor`) }} />
            </div>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#546e7a' }}>Batch</label>
                <select value={ln.batch || ''} onChange={e => setLine(i, { batch: e.target.value })} style={{ ...inp, ...aiStyle(`line${i}.batch`) }}>
                  <option value="">— Batch ล่าสุดที่ค้าง (ส่งต่อหน้าผลิต) —</option>
                  {HO_BATCHES.map(b => <option key={b} value={b}>Batch {b}</option>)}
                </select>
              </div>
              {ln.tanks.map((tk, t) => (
                <div key={t} style={{ display: 'grid', gridTemplateColumns: '58px 1fr', alignItems: 'center', gap: 10, marginBottom: 7 }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#546e7a' }}>ถัง {t + 1}</label>
                  <input value={tk} onChange={e => setTank(i, t, e.target.value)} placeholder="ว่าง" style={{ ...inp, ...aiStyle(`line${i}.tank${t}`) }} />
                </div>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr', alignItems: 'center', gap: 10, marginBottom: 7 }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#546e7a' }}>Lot No.</label>
                <input value={ln.lotNo || ''} onChange={e => setLine(i, { lotNo: e.target.value })} placeholder="เช่น 080726" style={{ ...inp, ...aiStyle(`line${i}.lotNo`) }} />
              </div>
              <input value={ln.note} onChange={e => setLine(i, { note: e.target.value })} placeholder="หมายเหตุ (เช่น หลังเปลี่ยนกรอง Batch 2)" style={{ ...inp, border: '1px dashed #d3dae0', marginTop: 2, ...aiStyle(`line${i}.note`) }} />
            </div>
          </div>
        ); })}

        <div style={{ border: '1px solid #e8edf0', borderRadius: 12, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#4a7c59' }}>
            <span style={{ color: '#fff', fontWeight: 800, fontSize: '0.85rem' }}>▶️ Line 4</span>
            <span style={tag}>Mixing / Pasteurizer</span>
            <input value={ho.line4.flavor} onChange={e => { setHo(h => ({ ...h, line4: { ...h.line4, flavor: e.target.value } })); clearAiKey('line4.flavor'); }} placeholder="รส / สถานะ" style={{ ...flavIn, ...aiStyle('line4.flavor') }} />
          </div>
          <div style={{ padding: '10px 12px' }}>
            {HO_L4_STAGES.map((nm, i) => (
              <div key={nm} style={{ display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', gap: 10, marginBottom: 7 }}>
                <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#546e7a' }}>{nm}</label>
                <input value={ho.line4.stages[i]} onChange={e => setStage(i, e.target.value)} placeholder="ว่าง / สถานะ" style={{ ...inp, ...aiStyle(`line4.stage${i}`) }} />
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', gap: 10, marginBottom: 7 }}>
              <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#546e7a' }}>Lot No.</label>
              <input value={ho.line4.lotNo || ''} onChange={e => { setHo(h => ({ ...h, line4: { ...h.line4, lotNo: e.target.value } })); clearAiKey('line4.lotNo'); }} placeholder="เช่น 080726" style={{ ...inp, ...aiStyle('line4.lotNo') }} />
            </div>
          </div>
        </div>

        <input value={ho.note} onChange={e => { setHo(h => ({ ...h, note: e.target.value })); clearAiKey('note'); }} placeholder="📌 หมายเหตุรวม (ถ้ามี)" style={{ ...inp, marginBottom: 12, ...aiStyle('note') }} />

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

const PackingReportForm: React.FC<{ date: string; operatorName: string | null; reload: () => void; card: React.CSSProperties; source: HoState | null; openCmd?: number }> =
  ({ date, operatorName, reload, card, source, openCmd }) => {
    const [open, setOpen] = useState(false);
    const [lines, setLines] = useState<PkLineState[]>(pkInit);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');
    const openCmdRef = useRef(0);
    useEffect(() => { if (openCmd && openCmd !== openCmdRef.current) { openCmdRef.current = openCmd; setOpen(true); } }, [openCmd]); // สั่งเปิดจาก stepper

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

const TimelineTab: React.FC<{ date: string; operatorName: string | null; events: TimelineEvent[]; reload: () => void; card: React.CSSProperties; aiDraft?: HoState | null; onDraftConsumed?: () => void; onGoToPlan?: () => void; onGoToHandoverAI?: () => void; onGoToProduction?: () => void }> =
  ({ date, operatorName, events, reload, card, aiDraft, onDraftConsumed, onGoToPlan, onGoToHandoverAI, onGoToProduction }) => {
    const [filter, setFilter] = useState('all');
    const [hoData, setHoData] = useState<HoState | null>(null); // สถานะรับกะสด → ป้อนฟอร์มบรรจุ
    const [receiveActive, setReceiveActive] = useState(false); // ฟอร์มรับกะเปิดอยู่ (mode in) → โชว์รายงานบรรจุ · ส่งกะ = ซ่อน
    // แถบขั้นตอนงาน (stepper): สั่งเปิดฟอร์ม + เลื่อนไปหา
    const [hoCmd, setHoCmd] = useState<{ mode: 'in' | 'out'; n: number }>({ mode: 'in', n: 0 });
    const [receiveChoice, setReceiveChoice] = useState(false); // ① รับกะ กด → ให้เลือก กรอกเอง / ให้ AI ช่วย
    const handoverRef = useRef<HTMLDivElement>(null);
    const scrollTo = (r: React.RefObject<HTMLDivElement | null>, delay = 50) => setTimeout(() => r.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), delay);
    const goHandover = (mode: 'in' | 'out') => { setHoCmd(c => ({ mode, n: c.n + 1 })); scrollTo(handoverRef); };
    const STEPS: { ic: string; label: string; sub: string; c: string; on: () => void }[] = [
      { ic: '📥', label: 'รับกะ', sub: 'กรอกเอง / ให้ AI ช่วย', c: '#00897b', on: () => setReceiveChoice(v => !v) },
      { ic: '🏭', label: 'ลงแผนผลิต', sub: 'วางแผน → AI แกะ', c: '#5e35b1', on: () => { setReceiveChoice(false); onGoToPlan?.(); } },
      { ic: '📋', label: 'แผนผลิตวันนี้', sub: 'ตั้ง Line/กลิ่น/Batch (หน้าผลิต)', c: '#8d5524', on: () => { setReceiveChoice(false); onGoToProduction?.(); } },
      { ic: '📤', label: 'ส่งกะ', sub: 'สรุป + คำนวณถัง', c: '#ff6b00', on: () => { setReceiveChoice(false); goHandover('out'); } },
    ];

    // auto-refresh ไทม์ไลน์ทุก 60 วิ + หยุดเมื่อสลับแท็บ/ย่อจอ (ลด egress + กัน DB ตื่นค้าง)
    useEffect(() => { const tick = () => { if (!document.hidden) reload(); }; const id = setInterval(tick, 60000); return () => clearInterval(id); }, [reload]);

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
        {/* แถบขั้นตอนงาน (workflow stepper) — เรียงตามวงจรกะ ซ้าย→ขวา เลื่อนแนวนอนได้ กดพาไปทำแต่ละขั้น */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6, marginBottom: 12, WebkitOverflowScrolling: 'touch' }}>
          {STEPS.map((s, i) => (
            <React.Fragment key={s.label}>
              <button onClick={s.on} style={{
                flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer',
                border: `1.5px solid ${s.c}33`, background: '#fff', borderRadius: 14, padding: '9px 13px 9px 9px',
                boxShadow: `0 2px 8px ${s.c}22`,
              }}>
                <span style={{ flexShrink: 0, width: 30, height: 30, borderRadius: '50%', background: s.c, color: '#fff', fontWeight: 800, fontSize: '0.9rem', display: 'grid', placeItems: 'center' }}>{i + 1}</span>
                <span style={{ textAlign: 'left', lineHeight: 1.15 }}>
                  <span style={{ display: 'block', fontWeight: 800, fontSize: '0.82rem', color: s.c, whiteSpace: 'nowrap' }}>{s.ic} {s.label}</span>
                  <span style={{ display: 'block', fontSize: '0.62rem', color: '#90a4ae', fontWeight: 600, whiteSpace: 'nowrap' }}>{s.sub}</span>
                </span>
              </button>
              {i < STEPS.length - 1 && <span style={{ flexShrink: 0, alignSelf: 'center', color: '#cfd8dc', fontWeight: 800, fontSize: '1rem' }}>›</span>}
            </React.Fragment>
          ))}
        </div>

        {/* ① รับกะ — เลือกวิธี: กรอกเอง หรือ ให้ AI ช่วย */}
        {receiveChoice && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.74rem', color: '#00695c', fontWeight: 700 }}>📥 รับกะ —</span>
            <button onClick={() => { setReceiveChoice(false); goHandover('in'); }} style={{ border: '1.5px solid #00897b', background: '#00897b', color: '#fff', borderRadius: 20, padding: '7px 14px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer' }}>✍️ กรอกเอง</button>
            <button onClick={() => { setReceiveChoice(false); onGoToHandoverAI?.(); }} style={{ border: '1.5px solid #00897b', background: '#e0f2f1', color: '#00695c', borderRadius: 20, padding: '7px 14px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer' }}>🤖 ให้ AI ช่วย</button>
            <button onClick={() => setReceiveChoice(false)} style={{ border: 'none', background: 'none', color: '#90a4ae', cursor: 'pointer', fontSize: '0.9rem' }}>×</button>
          </div>
        )}

        {/* handover form (รับกะ/ส่งกะ, collapsible) — เผยแพร่สถานะสดให้ฟอร์มบรรจุ + บอกว่าอยู่โหมดรับกะไหม */}
        <div ref={handoverRef}>
          <HandoverForm date={date} operatorName={operatorName} reload={reload} card={card} onLiveChange={setHoData}
            aiDraft={aiDraft} onDraftConsumed={onDraftConsumed} openCmd={hoCmd} onReceiveActive={setReceiveActive} />
        </div>

        {/* packing-staff report (Batch + Boxes ให้พนักงานบรรจุ) — อยู่คู่กับรับกะ (โชว์เฉพาะตอนรับกะ ซ่อนตอนส่งกะ) */}
        <div style={{ display: receiveActive ? 'block' : 'none' }}>
          <PackingReportForm date={date} operatorName={operatorName} reload={reload} card={card} source={hoData} />
        </div>

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
  useEffect(() => { load(); const tick = () => { if (!document.hidden) load(); }; const id = setInterval(tick, 60000); return () => clearInterval(id); }, [load]);

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

type KpiSummary = {
  from: string; to: string;
  production: { total: number; planned: number; pct: number | null; byDay: { workDay: string; actual: number; planned: number }[]; byLineFlavor: { line_name: string; flavor: string; actual: number; planned: number }[] };
  cip: { totalRounds: number; byLine: Record<string, number> };
};
const kpiPctColor = (p: number | null) => (p == null ? '#9aa0a6' : p >= 95 ? '#2e7d32' : p >= 70 ? '#e65100' : '#c62828');

const CalendarTab: React.FC<{ card: React.CSSProperties; onOpenDate: (date: string) => void }> = ({ card, onOpenDate }) => {
  const nowD = new Date(todayBKK() + 'T00:00:00');
  const [view, setView] = useState({ y: nowD.getFullYear(), m: nowD.getMonth() });
  const [hist, setHist] = useState<Record<string, HistDay>>({});
  const [selected, setSelected] = useState(todayBKK());
  const [duty, setDuty] = useState<Duty | null>(null);
  const [loading, setLoading] = useState(false);
  const [kpiRange, setKpiRange] = useState<'7' | '30'>('7');
  const [kpiSummary, setKpiSummary] = useState<KpiSummary | null>(null);
  const [kpiLoading, setKpiLoading] = useState(false);
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

  const loadKpiSummary = useCallback(async () => {
    setKpiLoading(true);
    const n = kpiRange === '7' ? 7 : 30;
    const toD = new Date(today + 'T00:00:00'); const fromD = new Date(toD); fromD.setDate(fromD.getDate() - (n - 1));
    const from = fromD.toISOString().slice(0, 10);
    try {
      const r = await fetch(`${apiUrl}/api/kpi/summary?from=${from}&to=${today}`);
      const d = await r.json();
      setKpiSummary(r.ok && d && d.production && d.cip ? d : null); // กัน response error/รูปแบบผิดพลาดทำให้ทั้งแอป crash
    } catch { setKpiSummary(null); } finally { setKpiLoading(false); }
  }, [kpiRange, today]);
  useEffect(() => { loadKpiSummary(); }, [loadKpiSummary]);

  const kpiTrendDays = kpiSummary ? (() => {
    const map: Record<string, { actual: number; planned: number }> = {};
    for (const d of kpiSummary.production.byDay) map[d.workDay] = d;
    const n = kpiRange === '7' ? 7 : 30;
    const toD = new Date(kpiSummary.to + 'T00:00:00');
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(toD); d.setDate(d.getDate() - (n - 1 - i));
      const ds = d.toISOString().slice(0, 10);
      const e = map[ds];
      const pct = e && e.planned > 0 ? Math.round((e.actual / e.planned) * 100) : (e && e.actual > 0 ? 100 : 0);
      return { ds, actual: e?.actual || 0, planned: e?.planned || 0, pct };
    });
  })() : [];

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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
            {duty.people.map(p => { const col = p.color || DUTY_COLOR[p.key]?.c || '#607d8b'; const lvl = p.pct >= 80 ? ['ดีเยี่ยม', '#e7f5e8', '#2e7d32'] : p.pct >= 50 ? ['กำลังไป', '#fff3e0', '#e65100'] : ['ต้องเร่ง', '#ffebee', '#c62828']; return (
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
            {duty.people.map(p => { const col = p.color || DUTY_COLOR[p.key]?.c || '#607d8b'; return (
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

      {/* KPI การผลิต — เจาะลึกข้ามช่วงวันที่ (Phase 3) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 2px 10px' }}>
        <span style={{ width: 4, height: 15, borderRadius: 3, background: '#ff6b00' }} />
        <h3 style={{ fontSize: '.9rem', fontWeight: 800, margin: 0 }}>KPI การผลิต</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {(['7', '30'] as const).map(r => (
            <button key={r} onClick={() => setKpiRange(r)} style={{ border: '2px solid', borderColor: kpiRange === r ? 'transparent' : '#e0e0e0', background: kpiRange === r ? '#ff6b00' : '#fff', color: kpiRange === r ? '#fff' : '#666', borderRadius: 16, padding: '5px 12px', fontSize: '.72rem', fontWeight: 700, cursor: 'pointer' }}>{r} วัน</button>
          ))}
        </div>
      </div>

      {kpiLoading && <div style={{ textAlign: 'center', color: '#bbb', padding: 20 }}>กำลังโหลด…</div>}
      {!kpiLoading && kpiSummary && (<>
        <div style={{ ...card }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Ring pct={kpiSummary.production.pct ?? 0} color={kpiPctColor(kpiSummary.production.pct)} size={92} stroke={9}>
              <div style={{ fontSize: '1.2rem', fontWeight: 800, lineHeight: 1 }} className="tnum">{kpiSummary.production.pct != null ? `${kpiSummary.production.pct}%` : '–'}</div>
              <div style={{ fontSize: '.56rem', color: '#9aa0a6', fontWeight: 700 }}>ตามแผน</div>
            </Ring>
            <div>
              <div style={{ fontWeight: 800, fontSize: '.95rem' }}>ผลิตจริง {kpiSummary.production.total} / แผน {kpiSummary.production.planned} batch</div>
              <div style={{ fontSize: '.76rem', color: '#546e7a', marginTop: 2 }}>CIP/Backwash รวม {kpiSummary.cip.totalRounds} รอบ</div>
            </div>
          </div>
        </div>

        {eyebrow('แนวโน้มผลิตตามแผน', `${kpiRange} วันล่าสุด`)}
        <div style={{ ...card }}>
          <svg width="100%" viewBox="0 0 320 110" preserveAspectRatio="none" style={{ display: 'block' }}>
            <line x1={28} y1={12} x2={28} y2={90} stroke="#eef1f3" /><line x1={28} y1={90} x2={314} y2={90} stroke="#eef1f3" />
            {(() => {
              const n = kpiTrendDays.length;
              const step = 286 / Math.max(1, n - 1);
              const xs = (i: number) => 28 + step * i;
              const ys = (p: number) => 90 - (78 * Math.min(100, p) / 100);
              const pts = kpiTrendDays.map((t, i) => `${xs(i)},${ys(t.pct)}`).join(' ');
              const last = kpiTrendDays[n - 1];
              return (<>
                <polygon points={`28,90 ${pts} 314,90`} fill="rgba(255,107,0,.10)" />
                <polyline points={pts} fill="none" stroke="#ff6b00" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
                {last && <circle cx={xs(n - 1)} cy={ys(last.pct)} r={4} fill="#ff6b00" stroke="#fff" strokeWidth={2} />}
                {kpiTrendDays.map((t, i) => (
                  <rect key={t.ds} x={xs(i) - step / 2} y={0} width={step} height={100} fill="transparent" style={{ cursor: 'pointer' }} onClick={() => onOpenDate(t.ds)}>
                    <title>{t.ds}: {t.pct}% ({t.actual}/{t.planned})</title>
                  </rect>
                ))}
                {n <= 7 ? kpiTrendDays.map((t, i) => <text key={t.ds} x={xs(i)} y={104} textAnchor="middle" fontSize={8} fill="#90a4ae" fontWeight={600}>{Number(t.ds.slice(8))}</text>)
                  : (<>
                    <text x={xs(0)} y={104} textAnchor="start" fontSize={8} fill="#90a4ae" fontWeight={600}>{kpiTrendDays[0].ds.slice(5)}</text>
                    <text x={xs(n - 1)} y={104} textAnchor="end" fontSize={8} fill="#90a4ae" fontWeight={600}>{kpiTrendDays[n - 1].ds.slice(5)}</text>
                  </>)}
              </>);
            })()}
          </svg>
        </div>

        {eyebrow('CIP/Backwash ต่อไลน์')}
        <div style={{ ...card }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Object.entries(kpiSummary.cip.byLine).map(([line, n]) => {
              const max = Math.max(1, ...Object.values(kpiSummary.cip.byLine));
              return (
                <div key={line} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 30px', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: '.78rem', fontWeight: 700, color: '#546e7a' }}>{line}</span>
                  <div style={{ height: 12, background: '#eef1f3', borderRadius: 7, overflow: 'hidden' }}><div style={{ height: '100%', width: `${(n / max) * 100}%`, background: '#37c2d0', borderRadius: 7, transition: 'width .4s' }} /></div>
                  <span style={{ fontSize: '.76rem', fontWeight: 800, textAlign: 'right' }} className="tnum">{n}</span>
                </div>
              );
            })}
          </div>
        </div>

        {eyebrow('ไลน์ที่ควรจับตา')}
        <div style={{ ...card }}>
          {(() => {
            const lines = kpiSummary.production.byLineFlavor
              .filter(l => l.planned > 0 || l.actual > 0)
              .map(l => ({ ...l, pct: l.planned > 0 ? Math.round((l.actual / l.planned) * 100) : null }))
              .sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999))
              .slice(0, 8);
            if (!lines.length) return <div style={{ textAlign: 'center', color: '#9aa0a6', fontSize: '.8rem', padding: 8 }}>ไม่มีข้อมูลผลิตในช่วงนี้</div>;
            return lines.map((l, i) => (
              <div key={`${l.line_name}-${l.flavor}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px', borderBottom: i < lines.length - 1 ? '1px solid #f4f4f4' : 'none' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '.82rem', fontWeight: 700 }}>{l.line_name} · {l.flavor}</div>
                  <div style={{ fontSize: '.68rem', color: '#9aa0a6' }}>{l.actual}{l.planned ? ` / ${l.planned}` : ''} batch</div>
                </div>
                {l.pct != null && <span style={{ fontSize: '.76rem', fontWeight: 800, color: kpiPctColor(l.pct) }} className="tnum">{l.pct}%</span>}
              </div>
            ));
          })()}
        </div>
      </>)}
      {!kpiLoading && !kpiSummary && <div style={{ textAlign: 'center', color: '#bbb', padding: 20 }}>โหลดข้อมูลไม่สำเร็จ</div>}
    </div>
  );
};

// ─── Report scheduling ─────────────────────────────────────────
type ReportCfg = { autoEnabled: boolean; times: string[]; weekdays: number[]; onlyIfPending: boolean; autoAtShiftEnd: boolean; kpiWeeklyEnabled: boolean; kpiMonthlyEnabled: boolean; kpiAlertEnabled: boolean; kpiAlertStreakDays: number; kpiAlertCipStaleHours: number; once: { id: number; run_at: string }[] };
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

  const [kpiMsg, setKpiMsg] = useState('');
  const saveCfg = async (patch: Partial<ReportCfg>) => {
    if (!cfg) return; const next = { ...cfg, ...patch }; setCfg(next);
    await fetch(`${apiUrl}/api/report/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoEnabled: next.autoEnabled, times: next.times, weekdays: next.weekdays, onlyIfPending: next.onlyIfPending, autoAtShiftEnd: next.autoAtShiftEnd, kpiWeeklyEnabled: next.kpiWeeklyEnabled, kpiMonthlyEnabled: next.kpiMonthlyEnabled, kpiAlertEnabled: next.kpiAlertEnabled, kpiAlertStreakDays: next.kpiAlertStreakDays, kpiAlertCipStaleHours: next.kpiAlertCipStaleHours }) });
  };
  const sendNow = async () => { setMsg('กำลังส่ง…'); try { const r = await fetch(`${apiUrl}/api/duty/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: todayBKK() }) }); const d = await r.json(); setMsg(d.sent ? '✅ ส่งเข้า Telegram แล้ว' : '⚠️ ยังไม่ได้ตั้งค่า Telegram บนเซิร์ฟเวอร์'); } catch { setMsg('❌ ส่งไม่สำเร็จ'); } };
  const sendKpiNow = async (period: 'weekly' | 'monthly') => {
    setKpiMsg('กำลังส่ง…');
    try { const r = await fetch(`${apiUrl}/api/kpi/report/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period }) }); const d = await r.json(); setKpiMsg(d.sent ? '✅ ส่งเข้า Telegram แล้ว' : '⚠️ ยังไม่มีข้อมูลในช่วงนี้ หรือยังไม่ได้ตั้งค่า Telegram'); }
    catch { setKpiMsg('❌ ส่งไม่สำเร็จ'); }
  };
  const [alertMsg, setAlertMsg] = useState('');
  const testAlert = async () => {
    setAlertMsg('กำลังตรวจสอบ…');
    try {
      const r = await fetch(`${apiUrl}/api/kpi/alert/run`, { method: 'POST' });
      const d = await r.json();
      const n = (d.streaks?.length || 0) + (d.cipStale?.length || 0) + (d.backlogCount || 0);
      setAlertMsg(n ? `⚠️ พบ ${n} จุด (ตกแผน ${d.streaks?.length || 0} · CIP ค้าง ${d.cipStale?.length || 0} · งานค้าง ${d.backlogCount || 0}) — นี่เป็นแค่การตรวจสอบ ยังไม่ส่งเข้า Telegram` : '✅ ไม่พบจุดต้องระวัง');
    } catch { setAlertMsg('❌ ตรวจสอบไม่สำเร็จ'); }
  };
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
      {eyebrow('สรุป KPI (รายสัปดาห์/รายเดือน)')}
      <div style={{ ...card }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12 }}>
          <div><div style={{ fontSize: '.88rem', fontWeight: 800 }}>📅 ส่งสรุป KPI รายสัปดาห์</div><div style={{ fontSize: '.68rem', color: '#9aa0a6' }}>ทุกวันจันทร์ 06:05 น. (สรุปสัปดาห์ก่อนหน้า)</div></div>
          <Toggle on={cfg.kpiWeeklyEnabled} onClick={() => saveCfg({ kpiWeeklyEnabled: !cfg.kpiWeeklyEnabled })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #eee', paddingTop: 12, paddingBottom: 12 }}>
          <div><div style={{ fontSize: '.88rem', fontWeight: 800 }}>🗓️ ส่งสรุป KPI รายเดือน</div><div style={{ fontSize: '.68rem', color: '#9aa0a6' }}>ทุกวันที่ 1 เวลา 06:05 น. (สรุปเดือนก่อนหน้า)</div></div>
          <Toggle on={cfg.kpiMonthlyEnabled} onClick={() => saveCfg({ kpiMonthlyEnabled: !cfg.kpiMonthlyEnabled })} />
        </div>
        <div style={{ display: 'flex', gap: 8, borderTop: '1px solid #eee', paddingTop: 12 }}>
          <button onClick={() => sendKpiNow('weekly')} style={{ flex: 1, border: '1px solid #eee', background: '#fff', borderRadius: 12, padding: 11, fontWeight: 800, fontSize: '.8rem', color: '#546e7a', cursor: 'pointer' }}>⚡ ส่งสัปดาห์นี้เดี๋ยวนี้</button>
          <button onClick={() => sendKpiNow('monthly')} style={{ flex: 1, border: '1px solid #eee', background: '#fff', borderRadius: 12, padding: 11, fontWeight: 800, fontSize: '.8rem', color: '#546e7a', cursor: 'pointer' }}>⚡ ส่งเดือนนี้เดี๋ยวนี้</button>
        </div>
        {kpiMsg && <div style={{ textAlign: 'center', fontSize: '.8rem', color: '#78828a', marginTop: 8 }}>{kpiMsg}</div>}
      </div>

      {eyebrow('แจ้งเตือนเฉพาะจุดต้องระวัง')}
      <div style={{ ...card }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12 }}>
          <div><div style={{ fontSize: '.88rem', fontWeight: 800 }}>🚨 เปิดแจ้งเตือน</div><div style={{ fontSize: '.68rem', color: '#9aa0a6' }}>ตรวจทุกวัน 06:10 น. — ส่งเฉพาะเมื่อพบจุดผิดปกติ</div></div>
          <Toggle on={cfg.kpiAlertEnabled} onClick={() => saveCfg({ kpiAlertEnabled: !cfg.kpiAlertEnabled })} />
        </div>
        <div style={{ borderTop: '1px solid #eee', paddingTop: 12, opacity: cfg.kpiAlertEnabled ? 1 : 0.5, pointerEvents: cfg.kpiAlertEnabled ? 'auto' : 'none' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 4 }}>
            <div>
              <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 700, color: '#546e7a', marginBottom: 6 }}>ตกแผนติดต่อกัน (วัน)</label>
              <input type="number" min={1} value={cfg.kpiAlertStreakDays} onChange={e => saveCfg({ kpiAlertStreakDays: Math.max(1, Number(e.target.value) || 2) })} style={{ width: '100%', border: '1px solid #dde3e7', borderRadius: 11, padding: 10 }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 700, color: '#546e7a', marginBottom: 6 }}>CIP ค้างเกิน (ชม.)</label>
              <input type="number" min={1} value={cfg.kpiAlertCipStaleHours} onChange={e => saveCfg({ kpiAlertCipStaleHours: Math.max(1, Number(e.target.value) || 30) })} style={{ width: '100%', border: '1px solid #dde3e7', borderRadius: 11, padding: 10 }} />
            </div>
          </div>
        </div>
        <button onClick={testAlert} style={{ width: '100%', border: '1px solid #eee', background: '#fff', borderRadius: 12, padding: 11, fontWeight: 800, fontSize: '.8rem', color: '#546e7a', cursor: 'pointer', marginTop: 12 }}>🔍 ตรวจสอบตอนนี้ (ไม่ส่ง Telegram)</button>
        {alertMsg && <div style={{ textAlign: 'center', fontSize: '.8rem', color: '#78828a', marginTop: 8 }}>{alertMsg}</div>}
      </div>

      <div style={{ fontSize: '.72rem', color: '#9aa0a6', textAlign: 'center', marginTop: 4, lineHeight: 1.6 }}>บันทึกอัตโนมัติเมื่อแก้ไข · เซิร์ฟเวอร์เช็กทุกนาที</div>
    </div>
  );
};

// ─── Panel จัดการคน/งาน ของ Duty board (เพิ่ม/แก้/ลบ ได้เอง ไม่ต้องแก้โค้ด) ──
const ManagePanel: React.FC<{ people: DutyPerson[]; onClose: () => void; reload: () => Promise<void> }> =
  ({ people, onClose, reload }) => {
    const [tab, setTab] = useState<'people' | 'tasks'>('people');
    const [busy, setBusy] = useState(false);
    const [selKey, setSelKey] = useState(people[0]?.key || '');
    // draft แก้ชื่อ/role รายคน (เริ่มจากค่าปัจจุบัน)
    const [edits, setEdits] = useState<Record<string, { name: string; role: string }>>({});
    const [newName, setNewName] = useState(''); const [newRole, setNewRole] = useState('');
    // เพิ่มงาน: text ต่อ parent (คีย์ = parentId หรือ 'root'); แก้งาน: id + text
    const [addText, setAddText] = useState<Record<string, string>>({});
    const [editId, setEditId] = useState<number | null>(null); const [editText, setEditText] = useState('');

    const api = async (url: string, body: Record<string, unknown>) => {
      setBusy(true);
      try { await fetch(`${apiUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await reload(); }
      finally { setBusy(false); }
    };
    const draft = (p: DutyPerson) => edits[p.key] || { name: p.name, role: p.role || '' };
    const setDraft = (k: string, patch: Partial<{ name: string; role: string }>) =>
      setEdits(prev => ({ ...prev, [k]: { ...(prev[k] || { name: people.find(x => x.key === k)?.name || '', role: people.find(x => x.key === k)?.role || '' }), ...patch } }));
    const savePerson = (p: DutyPerson) => { const d = draft(p); if (!d.name.trim()) return; return api('/api/duty/person', { key: p.key, name: d.name.trim(), role: d.role }); };
    const addPerson = async () => { if (!newName.trim()) return; await api('/api/duty/person', { name: newName.trim(), role: newRole }); setNewName(''); setNewRole(''); };
    const delPerson = (p: DutyPerson) => { if (window.confirm(`เอา "${p.name}" ออกจากรายการงานหลัก?`)) api('/api/duty/person/delete', { key: p.key }); };
    const addTask = async (parentId: number | null) => {
      const k = parentId == null ? 'root' : String(parentId);
      const t = (addText[k] || '').trim(); if (!t) return;
      await api('/api/duty/routine', { personKey: selKey, parentId, title: t });
      setAddText(prev => ({ ...prev, [k]: '' }));
    };
    const saveTask = async (id: number) => { if (!editText.trim()) return; await api('/api/duty/routine', { id, title: editText.trim() }); setEditId(null); setEditText(''); };
    const delTask = (n: DutyNode) => { if (n.id && window.confirm(`ลบงาน "${n.title}" (รวมงานย่อย)?`)) api('/api/duty/routine/delete', { id: n.id }); };

    const sel = people.find(p => p.key === selKey);
    const inp: React.CSSProperties = { boxSizing: 'border-box', padding: '7px 9px', border: '1px solid #ddd', borderRadius: 9, fontSize: '0.82rem', fontFamily: 'inherit' };
    const btn = (bg: string): React.CSSProperties => ({ border: 'none', background: bg, color: '#fff', borderRadius: 9, padding: '7px 11px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', flexShrink: 0 });
    const tabBtn = (on: boolean): React.CSSProperties => ({ flex: 1, border: 'none', background: on ? '#37474f' : '#eceff1', color: on ? '#fff' : '#607d8b', borderRadius: 10, padding: '9px 0', fontSize: '0.85rem', fontWeight: 800, cursor: 'pointer' });

    return (
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1100, display: 'grid', placeItems: 'center', padding: 16 }}>
        <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 520, maxHeight: '88vh', overflow: 'auto', padding: 18, boxShadow: '0 12px 48px rgba(0,0,0,.3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: '1rem' }}>⚙️ จัดการคน / งาน</div>
            <button onClick={onClose} style={{ border: 'none', background: '#eceff1', borderRadius: '50%', width: 30, height: 30, fontSize: '1rem', cursor: 'pointer', color: '#546e7a' }}>×</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={() => setTab('people')} style={tabBtn(tab === 'people')}>👤 คน</button>
            <button onClick={() => setTab('tasks')} style={tabBtn(tab === 'tasks')}>✅ งาน</button>
          </div>

          {tab === 'people' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {people.map(p => { const d = draft(p); const c = p.color || '#607d8b'; return (
                <div key={p.key} style={{ display: 'flex', gap: 7, alignItems: 'center', borderLeft: `3px solid ${c}`, paddingLeft: 9 }}>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: '0.8rem', background: c }}>{p.initial || p.name[0]}</div>
                  <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
                    <input value={d.name} onChange={e => setDraft(p.key, { name: e.target.value })} style={{ ...inp, fontWeight: 700 }} />
                    <input value={d.role} onChange={e => setDraft(p.key, { role: e.target.value })} placeholder="หน้าที่/บทบาท" style={{ ...inp, fontSize: '0.74rem', color: '#78828a' }} />
                  </div>
                  <button onClick={() => savePerson(p)} disabled={busy} style={btn('#2e7d32')}>บันทึก</button>
                  <button onClick={() => delPerson(p)} disabled={busy} style={btn('#c62828')}>ลบ</button>
                </div>
              ); })}
              <div style={{ borderTop: '1px dashed #e0e0e0', paddingTop: 12, marginTop: 4 }}>
                <div style={{ fontSize: '0.74rem', fontWeight: 800, color: '#546e7a', marginBottom: 7 }}>➕ เพิ่มคนใหม่</div>
                <div style={{ display: 'flex', gap: 7 }}>
                  <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="ชื่อ" style={{ ...inp, flex: 1, minWidth: 0 }} />
                  <input value={newRole} onChange={e => setNewRole(e.target.value)} placeholder="หน้าที่ (ไม่บังคับ)" style={{ ...inp, flex: 1, minWidth: 0 }} />
                  <button onClick={addPerson} disabled={busy || !newName.trim()} style={btn('#37474f')}>เพิ่ม</button>
                </div>
              </div>
            </div>
          )}

          {tab === 'tasks' && (
            <div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 }}>
                {people.map(p => (
                  <button key={p.key} onClick={() => setSelKey(p.key)} style={{ border: '2px solid', borderColor: selKey === p.key ? 'transparent' : '#e0e0e0', background: selKey === p.key ? (p.color || '#37474f') : '#fff', color: selKey === p.key ? '#fff' : '#666', borderRadius: 20, padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}>{p.name}</button>
                ))}
              </div>
              {sel && (<>
                {sel.nodes.length === 0 && <div style={{ color: '#9aa0a6', fontSize: '0.82rem', padding: '4px 0 10px' }}>ยังไม่มีงาน — เพิ่มด้านล่างได้เลย</div>}
                {sel.nodes.map(n => (
                  <div key={n.key} style={{ marginLeft: n.depth * 18 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 0' }}>
                      <span style={{ color: '#cfd8dc', flexShrink: 0 }}>{n.depth > 0 ? '└' : '•'}</span>
                      {editId === n.id ? (<>
                        <input value={editText} autoFocus onChange={e => setEditText(e.target.value)} onKeyDown={e => e.key === 'Enter' && n.id && saveTask(n.id)} style={{ ...inp, flex: 1, minWidth: 0 }} />
                        <button onClick={() => n.id && saveTask(n.id)} disabled={busy} style={btn('#2e7d32')}>✓</button>
                        <button onClick={() => { setEditId(null); setEditText(''); }} style={btn('#90a4ae')}>✕</button>
                      </>) : (<>
                        <span style={{ flex: 1, minWidth: 0, fontSize: '0.86rem', fontFamily: n.mono ? 'ui-monospace, Menlo, monospace' : 'inherit', color: '#37474f' }}>{n.title}</span>
                        <button onClick={() => { setEditId(n.id ?? null); setEditText(n.title); }} title="แก้ไข" style={{ ...btn('#eceff1'), color: '#546e7a' }}>✏️</button>
                        <button onClick={() => { const k = String(n.id); setAddText(prev => ({ ...prev, [k]: prev[k] ?? '' })); document.getElementById(`add-${n.id}`)?.focus(); }} title="เพิ่มงานย่อย" style={{ ...btn('#eceff1'), color: '#546e7a' }}>＋ย่อย</button>
                        <button onClick={() => delTask(n)} title="ลบ" style={{ ...btn('#fdecea'), color: '#c62828' }}>🗑</button>
                      </>)}
                    </div>
                    {/* ช่องเพิ่มงานย่อยใต้ node นี้ */}
                    <div style={{ display: 'flex', gap: 6, marginLeft: 18, padding: '2px 0 6px' }}>
                      <input id={`add-${n.id}`} value={addText[String(n.id)] || ''} onChange={e => setAddText(prev => ({ ...prev, [String(n.id)]: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addTask(n.id ?? null)} placeholder="＋ งานย่อย…" style={{ ...inp, flex: 1, minWidth: 0, fontSize: '0.78rem', borderStyle: 'dashed' }} />
                      {(addText[String(n.id)] || '').trim() && <button onClick={() => addTask(n.id ?? null)} disabled={busy} style={btn('#37474f')}>เพิ่ม</button>}
                    </div>
                  </div>
                ))}
                <div style={{ borderTop: '1px dashed #e0e0e0', paddingTop: 12, marginTop: 8 }}>
                  <div style={{ fontSize: '0.74rem', fontWeight: 800, color: '#546e7a', marginBottom: 7 }}>➕ เพิ่มงานหลัก (ของ {sel.name})</div>
                  <div style={{ display: 'flex', gap: 7 }}>
                    <input value={addText.root || ''} onChange={e => setAddText(prev => ({ ...prev, root: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addTask(null)} placeholder="ชื่องาน" style={{ ...inp, flex: 1, minWidth: 0 }} />
                    <button onClick={() => addTask(null)} disabled={busy || !(addText.root || '').trim()} style={btn('#37474f')}>เพิ่ม</button>
                  </div>
                </div>
              </>)}
            </div>
          )}
        </div>
      </div>
    );
  };

// ─── Duty board (งานตามหน้าที่รับผิดชอบรายบุคคล) ─────────────────
const DutyBoard: React.FC<{ date: string; operatorName: string | null; card: React.CSSProperties; onGoToAudit?: () => void }> =
  ({ date, operatorName, card, onGoToAudit }) => {
    const [duty, setDuty] = useState<Duty | null>(null);
    const [loading, setLoading] = useState(false);
    const [pick, setPick] = useState('');       // "personKey|nodeKey" ที่กำลังเลือกเหตุผลข้าม
    const [handoffKey, setHandoffKey] = useState(''); // key เดียวกันเมื่อเลือก "ให้คนอื่นทำแทน"
    const [tgMsg, setTgMsg] = useState('');
    // การ์ดรายคน: งานเสร็จพับไว้ (กดกางต่อคน) · คนเสร็จครบ 100% พับทั้งการ์ด (กดกางได้)
    const [showDone, setShowDone] = useState<Set<string>>(new Set());   // person key ที่กาง "เสร็จแล้ว"
    const [expandDone, setExpandDone] = useState<Set<string>>(new Set()); // person key ที่ 100% แล้วกดกางการ์ด
    const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, k: string) =>
      setter(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

    const load = useCallback(async () => {
      setLoading(true);
      // กัน shape ผิด (เช่น DB ล่ม/quota หมด → {error}) ไม่ให้ duty.people undefined แล้ว .map จอขาว
      try { const r = await fetch(`${apiUrl}/api/duty?date=${date}`); const d = await r.json(); setDuty(d && Array.isArray(d.people) ? d : null); }
      catch { setDuty(null); } finally { setLoading(false); }
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
    // ── รูปงานประจำ ────────────────────────────────────────────────
    const [busyPhoto, setBusyPhoto] = useState('');   // gk ที่กำลังอัปโหลด (กันกดซ้ำ)
    // รูปอ้างอิง (ก่อนทำ) — ผูกกับหัวข้อ ใช้ร่วมทุกวัน · มีอยู่แล้วต้องยืนยันก่อนทับ
    const setRefImage = async (gk: string, n: DutyNode, file?: File) => {
      if (!file || !n.id) return;
      setBusyPhoto(gk);
      try {
        const url = await uploadDutyImage((await resizePhoto(file)).preview);
        const send = (replace: boolean) => fetch(`${apiUrl}/api/duty/routine/ref-image`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: n.id, image: url, operator: operatorName, replace }),
        });
        let r = await send(false);
        if (r.status === 409) {   // มีรูปอ้างอิงอยู่แล้ว → ถามก่อนทับ
          if (!window.confirm(`"${n.title}" มีรูปอ้างอิงอยู่แล้ว\nต้องการเปลี่ยนเป็นรูปใหม่ไหม?`)) return;
          r = await send(true);
        }
        if (!r.ok) { alert('บันทึกรูปอ้างอิงไม่สำเร็จ'); return; }
        await load();
      } catch { alert('อ่านรูปไม่ได้ ลองใหม่อีกครั้ง'); }
      finally { setBusyPhoto(''); }
    };
    // รูปหลังทำ — รายวัน เปลี่ยนทับได้ตลอด · แนบแล้วระบบติ๊กเสร็จ + ส่งการ์ดเข้า Telegram ให้เอง
    const setDonePhoto = async (gk: string, pKey: string, n: DutyNode, file?: File) => {
      if (!file) return;
      setBusyPhoto(gk);
      try {
        const url = await uploadDutyImage((await resizePhoto(file)).preview);
        await post('/api/routine/photo', { date, assignee: pKey, nodeKey: n.key, title: n.title, image: url, operator: operatorName, routineId: n.id });
      } catch { alert('อ่านรูปไม่ได้ ลองใหม่อีกครั้ง'); }
      finally { setBusyPhoto(''); }
    };
    // โหลดรูปที่เก็บเป็น base64 (ไม่มี URL ใน list) ตอนกดดู
    const zoomLazy = async (which: 'ref' | 'done', n: DutyNode, pKey: string) => {
      const q = which === 'ref' ? `which=ref&id=${n.id}` : `which=done&date=${date}&assignee=${pKey}&nodeKey=${encodeURIComponent(n.key)}`;
      try {
        const d = await (await fetch(`${apiUrl}/api/routine/image?${q}`)).json();
        if (d.image) setZoom(d.image);
      } catch { /* ดูรูปไม่ได้ก็ข้าม */ }
    };

    // ── ลากงานมอบหมายข้ามการ์ด = เปลี่ยนคนทำ ────────────────────────
    // ใช้ Pointer Events ตัวเดียวคุมทั้งเมาส์และนิ้ว:
    //   เมาส์ = กดแล้วลากเกิน 6px เริ่มลากเลย · นิ้ว = ต้องแตะค้าง 380ms ก่อน
    //   (ถ้าลากทันทีบนมือถือจะไปชนกับการเลื่อนหน้าจอ)
    // งานมอบหมาย = ย้ายเจ้าของถาวร · งานประจำ = มอบต่อเฉพาะวันนั้น (ใช้กลไก handoff เดิม ย้อนกลับได้)
    type DragItem = { kind: 'adhoc'; task: AdhocTask } | { kind: 'routine'; node: DutyNode };
    const [drag, setDrag] = useState<{ title: string; x: number; y: number; over: string | null; from: string } | null>(null);
    const dragRef = useRef<(DragItem & { from: string; sx: number; sy: number; active: boolean; timer: number | null; over: string | null }) | null>(null);

    const reassign = async (t: AdhocTask, to: string) => {
      try {
        const r = await fetch(`${apiUrl}/api/tasks/reassign`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: t.id, assignTo: to, operator: operatorName }),
        });
        if (!r.ok) { const d = await r.json().catch(() => null); alert(d?.message || 'ย้ายงานไม่สำเร็จ'); return; }
        await load();
      } catch { alert('ย้ายงานไม่สำเร็จ — เช็คเน็ต'); }
    };

    const itemTitle = (it: DragItem) => (it.kind === 'adhoc' ? it.task.title : it.node.title);
    const onTaskPointerDown = (e: React.PointerEvent, item: DragItem, from: string) => {
      if (e.button > 0) return;                                            // เมาส์: เฉพาะปุ่มซ้าย
      if ((e.target as HTMLElement).closest('input,button,label,select,a,img')) return; // ติ๊ก/ลบ/ดูรูป ต้องกดได้ปกติ
      const touch = e.pointerType !== 'mouse';
      dragRef.current = { ...item, from, sx: e.clientX, sy: e.clientY, active: false, timer: null, over: from };
      if (touch) {
        dragRef.current.timer = window.setTimeout(() => {
          const d = dragRef.current; if (!d) return;
          d.active = true;
          setDrag({ title: itemTitle(d), x: d.sx, y: d.sy, over: from, from });
          navigator.vibrate?.(30);                                          // บอกด้วยการสั่นว่าจับงานขึ้นมาแล้ว
        }, 380);
      }
    };

    // ปล่อยงานลงการ์ดปลายทาง — งานมอบหมายย้ายเจ้าของ / งานประจำมอบต่อเฉพาะวันนั้น
    const dropOn = (d: NonNullable<typeof dragRef.current>, to: string) => {
      if (d.kind === 'adhoc') return reassign(d.task, to);
      return doBypass(d.from, d.node, 'ให้คนอื่นทำแทน', to);
    };
    // เก็บตัวล่าสุดไว้ใน ref เพื่อให้ effect ข้างล่างผูก listener ครั้งเดียว ([] deps)
    // ไม่งั้นต้อง re-register ทุกเฟรมระหว่างลาก (setDrag ยิงทุก pointermove)
    const dropRef = useRef(dropOn);
    dropRef.current = dropOn;

    useEffect(() => {
      const start = (d: NonNullable<typeof dragRef.current>, x: number, y: number) => {
        d.active = true;
        setDrag({ title: d.kind === 'adhoc' ? d.task.title : d.node.title, x, y, over: d.from, from: d.from });
      };
      const move = (e: PointerEvent) => {
        const d = dragRef.current; if (!d) return;
        const far = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
        if (!d.active) {
          if (e.pointerType === 'mouse') { if (far > 6) start(d, e.clientX, e.clientY); }
          else if (far > 10 && d.timer) { clearTimeout(d.timer); dragRef.current = null; } // นิ้วขยับก่อนครบเวลา = ตั้งใจเลื่อนจอ
          return;
        }
        e.preventDefault();                                                 // กันหน้าจอเลื่อนตามนิ้วระหว่างลาก
        const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
          ?.closest('[data-person-key]')?.getAttribute('data-person-key') || null;
        d.over = over;
        setDrag(prev => (prev ? { ...prev, x: e.clientX, y: e.clientY, over } : prev));
      };
      const end = () => {
        const d = dragRef.current;
        dragRef.current = null;
        if (d?.timer) clearTimeout(d.timer);
        setDrag(null);
        if (d?.active && d.over && d.over !== d.from) dropRef.current(d, d.over);
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      return () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
    }, []);

    // ระหว่างลาก ล็อก touch-action ทั้งหน้าไว้ ไม่ให้เบราว์เซอร์แย่ง gesture ไปเลื่อนจอ
    useEffect(() => {
      if (!drag) return;
      const prev = document.body.style.touchAction;
      document.body.style.touchAction = 'none';
      return () => { document.body.style.touchAction = prev; };
    }, [drag]);

    const toggleAdhoc = (t: AdhocTask) => post('/api/tasks/update', { id: t.id, status: t.status === 'done' ? 'pending' : 'done' });
    const delAdhoc = (id: number) => post('/api/tasks/delete-one', { id });

    // assign form — เลือกได้หลายคน (มอบงานเดียวให้หลายคนพร้อมกัน)
    const [assignees, setAssignees] = useState<string[]>(['mam']);
    const [cat, setCat] = useState('production');
    const [title, setTitle] = useState('');
    const [loc, setLoc] = useState(LOCATIONS[0]);
    const [prio, setPrio] = useState('normal');
    const [machine, setMachine] = useState('');    // พื้นที่/เครื่องจักร (พิมพ์เอง)
    const [reporter, setReporter] = useState('');  // คนแจ้ง (key จากรายชื่อทีม)
    const [moreOpen, setMoreOpen] = useState(false); // ตัวเลือกรอง (ประเภท/ด่วน/วันเวลา/เตือน) พับไว้
    // จุดเทียบ — 1 จุด = 1 คู่รูป (ก่อนที่แนบตอนจ่ายงาน ↔ หลังที่คนทำถ่ายส่งกลับ)
    // บอทจะถามทีละจุดตามลำดับนี้ และการ์ดรายงานจะจับคู่ให้ตรงจุด
    type Spot = { label: string; photo: PhotoAttach | null };
    const [spots, setSpots] = useState<Spot[]>([{ label: 'หลังทำ', photo: null }]);
    const [spotPicking, setSpotPicking] = useState(-1);   // index ของจุดที่กำลังเลือกรูป
    const patchSpot = (i: number, v: Partial<Spot>) => setSpots(prev => prev.map((s, j) => j === i ? { ...s, ...v } : s));
    const addSpot = (label: string) => setSpots(prev => prev.length >= 6 ? prev : [...prev, { label, photo: null }]);
    const delSpot = (i: number) => setSpots(prev => prev.length <= 1 ? prev : prev.filter((_, j) => j !== i));
    const [zoom, setZoom] = useState<string | null>(null);           // รูปที่กดขยาย (lightbox)
    // รูปงานโหลดแบบ lazy (กดดูค่อยดึง) เพื่อลด egress ของ DB — เก็บต่อ task id
    const [taskImgs, setTaskImgs] = useState<Record<number, { images: string[]; doneImages: string[] } | 'loading'>>({});
    const loadTaskImgs = async (id: number) => {
      if (taskImgs[id]) return;
      setTaskImgs(prev => ({ ...prev, [id]: 'loading' }));
      try {
        const r = await fetch(`${apiUrl}/api/tasks/images?id=${id}`);
        const d = await r.json();
        setTaskImgs(prev => ({ ...prev, [id]: { images: d.images || [], doneImages: d.doneImages || [] } }));
      } catch { setTaskImgs(prev => { const n = { ...prev }; delete n[id]; return n; }); }
    };
    const [workDate, setWorkDate] = useState(date);                  // วันที่ทำงาน (default = วันที่บอร์ด)
    const [dueTime, setDueTime] = useState('');                      // เวลากำหนด (ไม่บังคับ)
    const [remindLead, setRemindLead] = useState('none');            // แจ้งเตือนล่วงหน้า
    const [newName, setNewName] = useState('');                      // ช่องเพิ่มชื่อคนใหม่
    const [addingName, setAddingName] = useState(false);
    const [manageOpen, setManageOpen] = useState(false);            // เปิด panel จัดการคน/งาน
    const assignFileRef = useRef<HTMLInputElement>(null);
    useEffect(() => { setWorkDate(date); }, [date]);                 // เปลี่ยนวันบอร์ด → sync วันที่ทำ
    const toggleAssignee = (key: string) => setAssignees(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    // เพิ่มชื่อคนใหม่ (บันทึกถาวรลง DB) → เลือกเป็นผู้รับให้เลย
    const addPerson = async () => {
      const nm = newName.trim();
      if (!nm || addingName) return;
      setAddingName(true);
      try {
        const r = await fetch(`${apiUrl}/api/duty/person`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) });
        const d = await r.json();
        setNewName('');
        await load();
        if (d.key) setAssignees(prev => prev.includes(d.key) ? prev : [...prev, d.key]);
      } catch { /* offline */ } finally { setAddingName(false); }
    };
    // วางรูป (paste) หรือเลือกหลายไฟล์ → เติมให้จุดที่ยังไม่มีรูปตามลำดับ
    const addAssignImgs = async (files: FileList | File[]) => {
      const list = Array.from(files).filter(f => f.type.startsWith('image/'));
      const attaches: PhotoAttach[] = [];
      for (const f of list) { try { attaches.push(await resizePhoto(f)); } catch { /* ข้ามไฟล์เสีย */ } }
      if (!attaches.length) return;
      setSpots(prev => {
        const next = [...prev];
        let k = 0;
        for (let i = 0; i < next.length && k < attaches.length; i++) if (!next[i].photo) next[i] = { ...next[i], photo: attaches[k++] };
        while (k < attaches.length && next.length < 6) next.push({ label: `จุดที่ ${next.length + 1}`, photo: attaches[k++] });
        return next;
      });
    };
    const [assigning, setAssigning] = useState(false);
    const assign = async () => {
      if (!title.trim() || assignees.length === 0 || assigning) return;
      setAssigning(true);
      try {
        // อัปโหลดรูปขึ้น Supabase Storage ก่อน → ส่งเป็น URL (ไม่เก็บ base64 ใน DB อีก)
        // ต้องส่งเป็น array ที่ index ตรงกับ photoSpecs — จุดที่ไม่มีรูปส่ง '' ไว้กันลำดับเลื่อน
        const valid = spots.filter(s => s.label.trim());
        const images: string[] = [];
        for (const s of valid) images.push(s.photo ? await uploadDutyImage(s.photo.preview) : '');
        const photoSpecs = valid.map(s => s.label.trim());
        await post('/api/duty/assign', { date, assignees, category: cat, title: title.trim(), location: loc, priority: prio, operator: operatorName, images, workDate, dueTime, remindLead, photoSpecs, machine: machine.trim(), reporter });
        // คงคน+วันที่+โครงจุดไว้ เผื่อจ่ายงานถัดไป แต่ล้างเนื้องานกับรูป
        setTitle(''); setMachine(''); setSpots(prev => prev.map(s => ({ ...s, photo: null }))); setRemindLead('none'); setDueTime('');
      } finally { setAssigning(false); }
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
    // แถบรูปใต้ชื่องาน — เล็กไว้ ไม่ให้แถวสูงจนไล่อ่านยาก
    const photoChip: React.CSSProperties = { border: '1px solid #e0e6ea', background: '#fff', color: '#78909c', fontSize: '0.66rem', fontWeight: 700, borderRadius: 14, padding: '3px 9px', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap', lineHeight: 1.6 };
    const thumb = (border: string): React.CSSProperties => ({ width: 34, height: 34, objectFit: 'cover', borderRadius: 7, border: `2px solid ${border}`, cursor: 'zoom-in', display: 'block', flexShrink: 0 });
    const subLbl: React.CSSProperties = { fontSize: '0.68rem', fontWeight: 800, letterSpacing: '.04em', color: '#9aa0a6', textTransform: 'uppercase', margin: '10px 0 2px' };
    const chip = (on: boolean, color = '#ff6b00'): React.CSSProperties => ({ border: '2px solid', borderColor: on ? 'transparent' : '#e0e0e0', background: on ? color : '#fff', color: on ? '#fff' : '#666', borderRadius: 22, padding: '7px 13px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer' });
    // สี/ตัวย่อของคน: ใช้ค่าจาก API ก่อน (เก็บใน DB) แล้วค่อย fallback DUTY_COLOR เดิม
    const colOf = (p: DutyPerson) => ({ c: p.color || (DUTY_COLOR[p.key] || {}).c || '#607d8b', wash: p.wash || (DUTY_COLOR[p.key] || {}).wash || '#eceff1', initial: p.initial || (DUTY_COLOR[p.key] || {}).initial || (p.name || '?')[0] });

    if (!duty) return <div style={{ textAlign: 'center', color: '#bbb', padding: 24 }}>{loading ? 'กำลังโหลด…' : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'}</div>;
    if (duty.holiday) return <div style={{ ...card, textAlign: 'center', padding: 40 }}><div style={{ fontSize: '2rem' }}>🚫</div><div style={{ fontWeight: 800, marginTop: 8 }}>วันเสาร์ — วันหยุด</div><div style={{ fontSize: '0.8rem', color: '#90a4ae', marginTop: 4 }}>ไม่มีกะทำงาน</div></div>;

    // การ์ดของคนที่เปิดหน้านี้ (operator) ดันขึ้นบนสุด — ที่เหลือคงลำดับเดิม
    const myName = (operatorName || '').trim();
    const orderedPeople = [...duty.people].sort((a, b) => {
      const am = !!myName && a.name.trim() === myName, bm = !!myName && b.name.trim() === myName;
      return am === bm ? 0 : am ? -1 : 1;
    });

    return (
      <div>
        {/* team overview */}
        <div style={{ ...card, background: 'linear-gradient(135deg,#fff,#fff8f2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <div><div style={subLbl}>ความคืบหน้าทีมวันนี้</div><div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#ff6b00' }}>{duty.team.pct}%<small style={{ fontSize: '0.8rem', color: '#9aa0a6', fontWeight: 600 }}> เสร็จ</small></div></div>
            <div style={{ textAlign: 'right' }}><div style={subLbl}>งานคงค้าง</div><div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#e65100' }}>{duty.team.left}<small style={{ fontSize: '0.8rem', color: '#9aa0a6', fontWeight: 600 }}> งาน</small></div></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 10 }}>
            {duty.people.map(p => { const col = colOf(p); return (
              <div key={p.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '9px 4px', border: '1px solid #eee', borderRadius: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 800, color: '#fff', fontSize: '0.85rem', background: col.c }}>{col.initial}</div>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: col.c }}>{p.name}</div>
                <div style={{ width: '100%', height: 5, borderRadius: 4, background: '#eceff1', overflow: 'hidden' }}><div style={{ height: '100%', width: `${p.pct}%`, background: col.c }} /></div>
                <div style={{ fontSize: '0.7rem', color: '#9aa0a6', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{p.done}/{p.total}</div>
              </div>
            ); })}
          </div>
        </div>

        <div style={{ ...subLbl, margin: '2px 2px 8px' }}>หน้าที่บุคคล</div>

        {orderedPeople.map(p => { const col = colOf(p);
          const mine = !!myName && p.name.trim() === myName;
          const remaining = p.total - p.done;
          const full = p.total > 0 && p.done >= p.total;      // เสร็จครบทุกงาน
          const collapsed = full && !expandDone.has(p.key);   // 100% → พับการ์ด (กดกางได้)
          const rNodes = p.nodes.filter(n => !n.bypassed);
          const byNodes = p.nodes.filter(n => n.bypassed);    // งานที่ข้าม/มอบต่อ → ไปอยู่ส่วน "เสร็จแล้ว/ข้าม"
          const todoN = rNodes.filter(n => !n.checked), doneN = rNodes.filter(n => n.checked);
          const todoR = p.received.filter(r => !r.checked), doneR = p.received.filter(r => r.checked);
          const todoA = p.adhoc.filter(t => t.status !== 'done'), doneA = p.adhoc.filter(t => t.status === 'done');
          const doneCount = doneN.length + doneR.length + doneA.length + byNodes.length;
          const todoTotal = todoN.length + todoR.length + todoA.length;
          const openDone = showDone.has(p.key);

          // ── งานประจำ 1 แถว: ลากมอบต่อได้ + ติ๊ก + ข้าม/คืน + รูปคู่ ก่อน→หลัง (reuse handler เดิม) ──
          const nodeRow = (n: DutyNode) => { const gk = `${p.key}|${n.key}`; return (
            <div key={gk} style={{ marginLeft: n.depth * 20 }}>
              <div style={{ ...row, ...(n.bypassed ? {} : { cursor: 'grab', touchAction: 'pan-y', userSelect: 'none' }) }}
                onPointerDown={e => { if (!n.bypassed) onTaskPointerDown(e, { kind: 'routine', node: n }, p.key); }}
                title={n.bypassed ? undefined : 'ลากไปวางที่การ์ดคนอื่นเพื่อมอบงานให้เขาทำแทนวันนี้'}>
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
              {!n.bypassed && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', margin: '0 0 9px 29px' }}>
                  {n.refImage
                    ? <img src={n.refImage} alt="อ้างอิง" title="รูปอ้างอิง (ก่อนทำ)" onClick={() => setZoom(n.refImage!)} style={thumb('#cfd8dc')} />
                    : n.hasRefImage ? <button onClick={() => zoomLazy('ref', n, p.key)} style={photoChip}>🖼 อ้างอิง</button> : null}
                  {n.id != null && (
                    <label style={{ ...photoChip, ...(n.refImage || n.hasRefImage ? {} : { borderStyle: 'dashed', color: '#90a4ae' }) }}
                      title={n.refImage || n.hasRefImage ? 'เปลี่ยนรูปอ้างอิง (ต้องยืนยัน)' : 'ตั้งรูปอ้างอิง — ใช้เป็นมาตรฐานทุกวัน'}>
                      {n.refImage || n.hasRefImage ? 'เปลี่ยนอ้างอิง' : '＋ รูปก่อนทำ'}
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { setRefImage(gk, n, e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                  )}
                  <span style={{ color: '#cfd8dc', fontSize: '0.7rem', flexShrink: 0 }}>→</span>
                  {n.doneImage
                    ? <img src={n.doneImage} alt="หลังทำ" title="รูปหลังทำ" onClick={() => setZoom(n.doneImage!)} style={thumb('#a5d6a7')} />
                    : n.hasDoneImage ? <button onClick={() => zoomLazy('done', n, p.key)} style={photoChip}>🖼 หลังทำ</button> : null}
                  <label style={{ ...photoChip, ...(n.doneImage || n.hasDoneImage ? {} : { borderColor: '#c8e6c9', color: '#2e7d32', background: '#f1f8f2' }) }}
                    title="แนบรูปหลังทำ → ติ๊กเสร็จ + ส่งการ์ดก่อน/หลังเข้า Telegram">
                    {busyPhoto === gk ? '⏳ กำลังส่ง…' : (n.doneImage || n.hasDoneImage ? 'เปลี่ยนหลังทำ' : '📷 หลังทำ')}
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { setDonePhoto(gk, p.key, n, e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                </div>
              )}
            </div>
          ); };

          // ── งานรับมอบต่อ ──
          const recvRow = (r: Received) => (
            <div key={`${r.ownerKey}/${r.nodeKey}`} style={row}>
              <input type="checkbox" checked={r.checked} onChange={() => toggleReceived(r)} style={cb(false)} />
              <span style={{ flex: 1, minWidth: 0, fontSize: '0.88rem', fontWeight: 500, color: r.checked ? '#9aa0a6' : '#37474f', textDecoration: r.checked ? 'line-through' : 'none' }}>{r.title}</span>
              <span style={{ ...badge, background: '#e8eaf6', color: '#3949ab' }}>รับจาก {r.fromName}</span>
            </div>
          );

          // ── งานมอบหมาย: ด่วน = ขีดแดงซ้าย + รูปงาน (lazy) ──
          const adhocRow = (t: AdhocTask) => { const c = CAT[t.category] || CAT.manual; const urg = t.priority === 'urgent' && t.status !== 'done'; return (
            <div key={t.id} style={urg ? { borderLeft: '4px solid #e53935', background: '#fff8f8', borderRadius: 8, margin: '2px -6px', paddingLeft: 8 } : undefined}>
              <div style={{ ...row, cursor: 'grab', touchAction: 'pan-y', userSelect: 'none' }}
                onPointerDown={e => onTaskPointerDown(e, { kind: 'adhoc', task: t }, p.key)} title="ลากไปวางที่การ์ดคนอื่นเพื่อย้ายงาน">
                <input type="checkbox" checked={t.status === 'done'} onChange={() => toggleAdhoc(t)} style={cb(false)} />
                <span style={{ flex: 1, minWidth: 0, fontSize: '0.88rem', fontWeight: 500, color: t.status === 'done' ? '#9aa0a6' : '#37474f', textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{c.icon} {t.title}{t.location ? <small style={{ color: '#9aa0a6' }}> · 📍{t.location}</small> : null}</span>
                {urg && <span style={{ ...badge, background: '#ffebee', color: '#c62828' }}>🔴 ด่วน</span>}
                <button onClick={() => delAdhoc(t.id)} title="ลบ" style={{ ...bpBtn, fontSize: '1rem', color: '#ccc' }}>×</button>
              </div>
              {(t.hasImages || t.hasDoneImages) && !taskImgs[t.id] && (
                <button onClick={() => loadTaskImgs(t.id)}
                  style={{ margin: '0 0 6px 29px', border: '1px solid #e0e0e0', background: '#f7f9fa', color: '#546e7a', borderRadius: 9, padding: '4px 10px', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer' }}>
                  📷 ดูรูป{t.hasImages && t.hasDoneImages ? ' (แนบ + หลังทำ)' : t.hasDoneImages ? ' หลังทำ' : ''}
                </button>
              )}
              {taskImgs[t.id] === 'loading' && <div style={{ margin: '0 0 6px 29px', fontSize: '0.72rem', color: '#9aa0a6' }}>กำลังโหลดรูป…</div>}
              {typeof taskImgs[t.id] === 'object' && (() => { const im = taskImgs[t.id] as { images: string[]; doneImages: string[] }; return (<>
                {im.images.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0 0 6px 29px' }}>
                    {im.images.map((src, ii) => <img key={ii} src={src} alt="รูปงาน" onClick={() => setZoom(src)} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, border: '1px solid #e0e0e0', cursor: 'zoom-in', display: 'block' }} />)}
                  </div>
                )}
                {im.doneImages.length > 0 && (
                  <div style={{ margin: '0 0 6px 29px' }}>
                    <div style={{ fontSize: '0.66rem', fontWeight: 800, color: '#2e7d32', marginBottom: 4 }}>📸 หลังทำ ({im.doneImages.length})</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {im.doneImages.map((src, ii) => <img key={ii} src={src} alt="รูปหลังทำ" onClick={() => setZoom(src)} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, border: '2px solid #a5d6a7', cursor: 'zoom-in', display: 'block' }} />)}
                    </div>
                  </div>
                )}
              </>); })()}
            </div>
          ); };

          return (
            <div key={p.key} data-person-key={p.key}
              style={{
                ...card, padding: 0, overflow: 'hidden',
                ...(drag && drag.over === p.key && drag.from !== p.key ? { outline: `2px dashed ${col.c}`, outlineOffset: 2, background: col.wash } : {}),
                ...(drag && drag.from === p.key ? { opacity: 0.75 } : {}),
                ...(collapsed ? { opacity: 0.72 } : {}),
              }}>
              {/* หัวการ์ด: วงแหวน% · ชื่อ+⭐ · role · เลข "เหลือ" (100% กดที่หัวเพื่อกาง) */}
              <div onClick={full ? () => toggleSet(setExpandDone, p.key) : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', background: mine ? col.wash : '#fafbfc', borderTop: `3px solid ${col.c}`, cursor: full ? 'pointer' : 'default' }}>
                <div style={{ width: 46, height: 46, borderRadius: '50%', flexShrink: 0, background: `conic-gradient(${col.c} ${p.pct}%, #eceff1 0)`, display: 'grid', placeItems: 'center' }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: '0.72rem', color: col.c }}>{p.pct}%</div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, color: '#263238', display: 'flex', alignItems: 'center', gap: 6 }}>คุณ {p.name}
                    {mine && <span style={{ fontSize: '0.62rem', fontWeight: 800, color: '#e65100', background: '#fff', borderRadius: 20, padding: '1px 7px' }}>⭐ คุณ</span>}</div>
                  <div style={{ fontSize: '0.72rem', color: '#78828a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.role}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  {full
                    ? <div style={{ fontWeight: 800, color: '#2e7d32', fontSize: '0.9rem' }}>✓ เสร็จครบ <span style={{ color: '#90a4ae', fontWeight: 600, fontSize: '0.75rem' }}>{collapsed ? '▸' : '▾'}</span></div>
                    : <><div style={{ fontWeight: 800, fontSize: '1.2rem', color: col.c, lineHeight: 1 }}>{remaining}</div><div style={{ fontSize: '0.62rem', color: '#78909c' }}>เหลือ</div></>}
                </div>
              </div>

              {!collapsed && (
                <div style={{ padding: '6px 15px 14px' }}>
                  {todoN.map(nodeRow)}
                  {todoR.map(recvRow)}
                  {todoA.map(adhocRow)}
                  {todoTotal === 0 && doneCount > 0 && <div style={{ textAlign: 'center', color: '#2e7d32', fontWeight: 700, fontSize: '0.82rem', padding: '6px 0' }}>🎉 เคลียร์งานที่ต้องทำครบแล้ว</div>}

                  {doneCount > 0 && (
                    <button onClick={() => toggleSet(setShowDone, p.key)}
                      style={{ width: '100%', marginTop: 8, border: 'none', background: '#f1f8f2', borderRadius: 9, padding: '8px 11px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: 'inherit' }}>
                      <span style={{ fontSize: '0.76rem', fontWeight: 800, color: '#2e7d32' }}>✅ เสร็จแล้ว {doneCount} งาน</span>
                      <span style={{ marginLeft: 'auto', color: '#90a4ae', fontSize: '0.74rem' }}>{openDone ? 'ซ่อน ▲' : 'ดู ▼'}</span>
                    </button>
                  )}
                  {openDone && (
                    <div style={{ marginTop: 6 }}>
                      {doneN.map(nodeRow)}
                      {doneR.map(recvRow)}
                      {doneA.map(adhocRow)}
                      {byNodes.map(nodeRow)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* assign form */}
        <div style={{ ...card }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>📋 จ่ายงาน</div>
            <button onClick={() => setManageOpen(true)} style={{ border: '1px solid #e0e0e0', background: '#fff', color: '#546e7a', borderRadius: 9, padding: '5px 10px', fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer' }}>⚙️ จัดการคน/งาน</button>
          </div>
          <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 7 }}>ส่งให้ <span style={{ fontWeight: 600, color: '#9aa0a6' }}>(เลือกได้หลายคน)</span></div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            {duty.people.map(p => <button key={p.key} onClick={() => toggleAssignee(p.key)} style={chip(assignees.includes(p.key), colOf(p).c)}>{p.name}</button>)}
            {(() => { const all = duty.people.length > 0 && duty.people.every(p => assignees.includes(p.key)); return (
              <button onClick={() => setAssignees(all ? [] : duty.people.map(p => p.key))} style={chip(all, '#37474f')}>👥 ทั้งหมด</button>
            ); })()}
          </div>
          {/* เพิ่มชื่อคนใหม่เอง (บันทึกถาวร) */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addPerson()}
              placeholder="➕ เพิ่มชื่อคนใหม่…"
              style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '8px 10px', border: '1px dashed #cbd5db', borderRadius: 10, fontSize: '0.82rem' }} />
            <button onClick={addPerson} disabled={!newName.trim() || addingName}
              style={{ border: 'none', background: newName.trim() ? '#37474f' : '#cfd8dc', color: '#fff', borderRadius: 10, padding: '8px 14px', fontSize: '0.82rem', fontWeight: 700, cursor: newName.trim() ? 'pointer' : 'default', flexShrink: 0 }}>{addingName ? '…' : 'เพิ่ม'}</button>
          </div>
          {/* ── แก่นงาน: พื้นที่ · ปัญหา · สถานที่ · คนแจ้ง (เห็นครบในจอเดียว) ────── */}
          <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 5 }}>📌 พื้นที่</div>
          <input value={machine} onChange={e => setMachine(e.target.value)}
            placeholder="เช่น เครื่องบรรจุ Line 3 / โซนไซรัป"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px', border: '1px solid #ddd', borderRadius: 11, marginBottom: 10 }} />

          <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 5 }}>⚠️ ปัญหาที่เจอ</div>
          <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && assign()}
            onPaste={e => { const fs = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean) as File[]; if (fs.length) addAssignImgs(fs); }}
            placeholder="เช่น สายพานหลุด / น้ำหยดจากหัวฉีด"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px', border: '1px solid #ddd', borderRadius: 11, marginBottom: 10 }} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <label style={{ fontSize: '0.7rem', fontWeight: 700, color: '#546e7a' }}>📍 สถานที่
              <select value={loc} onChange={e => setLoc(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 10, border: '1px solid #ddd', borderRadius: 11, fontFamily: 'inherit', fontSize: '0.85rem' }}>{LOCATIONS.map(l => <option key={l}>{l}</option>)}</select>
            </label>
            <label style={{ fontSize: '0.7rem', fontWeight: 700, color: '#546e7a' }}>🙋 คนแจ้ง
              <select value={reporter} onChange={e => setReporter(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 10, border: '1px solid #ddd', borderRadius: 11, fontFamily: 'inherit', fontSize: '0.85rem' }}>
                <option value="">— ไม่ระบุ —</option>
                {duty.people.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
            </label>
          </div>
          {/* รายการรูปที่ต้องถ่ายส่งกลับ — บอทถามทีละใบตามลำดับนี้ ครบแล้วปิดงาน + ส่งการ์ดเอง */}
          {/* ── รูปเทียบ ก่อน–หลัง: 1 แถว = 1 จุด · ซ้าย=คุณแนบ ขวา=คนทำถ่าย ─────── */}
          <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#546e7a', marginBottom: 6 }}>
            📸 รูปเทียบ ก่อน–หลัง <span style={{ fontWeight: 600, color: '#9aa0a6' }}>(จับคู่ให้เห็นว่าจุดไหนก่อน จุดไหนหลัง)</span>
          </div>
          <input ref={assignFileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0];
              if (spotPicking >= 0 && f) { resizePhoto(f).then(p => patchSpot(spotPicking, { photo: p })).catch(() => {}); }
              else if (e.target.files?.length) addAssignImgs(e.target.files);
              e.target.value = ''; setSpotPicking(-1);
            }} />
          <div style={{ border: '1px solid #e6ebee', borderRadius: 13, background: '#fbfcfd', overflow: 'hidden', marginBottom: 6 }}>
            {spots.map((s, i) => (
              <div key={i} style={{ padding: '11px 12px', borderTop: i ? '1px solid #eef2f4' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ flexShrink: 0, fontSize: '0.68rem', fontWeight: 800, color: '#00838f', background: '#e0f7fa', border: '1px solid #b2ebf2', borderRadius: 7, padding: '3px 8px', whiteSpace: 'nowrap' }}>จุดที่ {i + 1}</span>
                  <input value={s.label} onChange={e => patchSpot(i, { label: e.target.value })} placeholder="ชื่อจุด เช่น ประตูหน้า" maxLength={24}
                    style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '7px 9px', border: '1px solid #e0e6ea', borderRadius: 9, fontSize: '0.8rem' }} />
                  {spots.length > 1 && <button onClick={() => delSpot(i)} title="ลบจุดนี้"
                    style={{ border: 'none', background: 'none', color: '#cfd8dc', fontSize: '0.9rem', cursor: 'pointer', padding: 0, flexShrink: 0 }}>🗑</button>}
                </div>
                <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.63rem', fontWeight: 800, color: '#607d8b', marginBottom: 4 }}>📎 ก่อน · คุณแนบ</div>
                    {s.photo
                      ? <div style={{ position: 'relative' }}>
                          <img src={s.photo.preview} alt="ก่อน" onClick={() => setZoom(s.photo!.preview)}
                            style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 9, cursor: 'zoom-in', display: 'block' }} />
                          <button onClick={() => patchSpot(i, { photo: null })} title="ลบรูป"
                            style={{ position: 'absolute', top: -5, right: -5, width: 18, height: 18, borderRadius: '50%', border: 'none', background: '#546e7a', color: '#fff', fontSize: '0.7rem', lineHeight: 1, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>×</button>
                        </div>
                      : <button onClick={() => { setSpotPicking(i); assignFileRef.current?.click(); }}
                          style={{ width: '100%', height: 60, border: '1.5px dashed #c4cdd3', background: '#fff', color: '#8a949c', borderRadius: 9, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer' }}>+ แนบรูป</button>}
                  </div>
                  <span style={{ alignSelf: 'center', color: '#b0bec5', fontWeight: 800, flexShrink: 0, paddingTop: 15 }}>→</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.63rem', fontWeight: 800, color: '#2e7d32', marginBottom: 4 }}>📸 หลัง</div>
                    <div style={{ height: 60, border: '1.5px dashed #bfd8c4', background: '#fff', color: '#6aa77c', borderRadius: 9, fontSize: '0.72rem', fontWeight: 700, display: 'grid', placeItems: 'center' }}>คนทำถ่าย</div>
                  </div>
                </div>
              </div>
            ))}
            <button onClick={() => addSpot(`จุดที่ ${spots.length + 1}`)} disabled={spots.length >= 6}
              style={{ display: 'block', width: '100%', border: 'none', borderTop: '1px dashed #dbe3e7', background: '#f5fafb', color: spots.length >= 6 ? '#cfd8dc' : '#00838f', fontSize: '0.78rem', fontWeight: 800, padding: 11, cursor: spots.length >= 6 ? 'default' : 'pointer' }}>+ เพิ่มจุดเทียบ</button>
          </div>
          <div style={{ fontSize: '0.7rem', color: '#9aa0a6', marginBottom: 12 }}>
            บอทถามคนทำ <b style={{ color: '#607d8b' }}>ทีละจุด</b> · การ์ดสรุปเรียง <b style={{ color: '#607d8b' }}>ก่อน | หลัง เป็นคู่</b> ให้อัตโนมัติ
          </div>

          {/* ── ตัวเลือกเพิ่มเติม (พับไว้ — ไม่ได้ใช้ทุกวัน) ─────────────────────── */}
          <button onClick={() => setMoreOpen(o => !o)}
            style={{ width: '100%', textAlign: 'left', border: '1px solid #e6ebee', background: '#fff', color: '#546e7a', borderRadius: 11, padding: '9px 12px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', marginBottom: moreOpen ? 10 : 12 }}>
            {moreOpen ? '▾' : '▸'} ตัวเลือกเพิ่มเติม <span style={{ fontWeight: 600, color: '#9aa0a6' }}>· ประเภทงาน · ด่วน · วันที่/เวลา · แจ้งเตือน</span>
          </button>
          {moreOpen && (<>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
              <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#546e7a' }}>ประเภทงาน</div>
              {onGoToAudit && (
                <button onClick={onGoToAudit} title="เปิดพื้นที่รับผิดชอบ — แบ่งงานอัตโนมัติ / ติดตามผล / แก้กฎ"
                  style={{ border: '1px solid #b2ebf2', background: '#e0f7fa', color: '#00838f', borderRadius: 20, padding: '5px 12px', fontSize: '0.74rem', fontWeight: 800, cursor: 'pointer' }}>
                  🧾 พื้นที่รับผิดชอบ →
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {CAT_KEYS.map(k => { const cc = CAT_COLOR[k] || { c: '#ff6b00', w: '#fff3e9' }; const on = cat === k; return (
                <button key={k} onClick={() => setCat(k)} style={{ border: '2px solid', borderColor: on ? 'transparent' : '#e0e0e0', background: on ? '#ff6b00' : cc.w, color: on ? '#fff' : cc.c, borderRadius: 22, padding: '7px 13px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer' }}>{CAT[k].icon} {CAT[k].label}</button>
              ); })}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button onClick={() => setPrio('normal')} style={{ ...chip(prio === 'normal', '#546e7a'), flex: 1, textAlign: 'center' }}>ปกติ</button>
              <button onClick={() => setPrio('urgent')} style={{ ...chip(prio === 'urgent', '#c62828'), flex: 1, textAlign: 'center' }}>🔴 ด่วน</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
              <label style={{ fontSize: '0.7rem', fontWeight: 700, color: '#546e7a' }}>🗓 วันที่ทำ
                <input type="date" value={workDate} onChange={e => setWorkDate(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 9, border: '1px solid #ddd', borderRadius: 11, fontFamily: 'inherit', fontSize: '0.85rem' }} />
              </label>
              <label style={{ fontSize: '0.7rem', fontWeight: 700, color: '#546e7a' }}>⏰ เวลา (ไม่บังคับ)
                <input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 9, border: '1px solid #ddd', borderRadius: 11, fontFamily: 'inherit', fontSize: '0.85rem' }} />
              </label>
            </div>
            <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: '#546e7a', marginBottom: 12 }}>🔔 แจ้งเตือนล่วงหน้า (เข้า Telegram)
              <select value={remindLead} onChange={e => setRemindLead(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 10, border: '1px solid #ddd', borderRadius: 11, fontFamily: 'inherit', fontSize: '0.85rem', background: remindLead !== 'none' ? '#fff8e1' : '#fff' }}>
                {REMIND_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </>)}
          <button onClick={assign} disabled={assigning} style={{ width: '100%', border: 'none', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '0.92rem', color: '#fff', background: assigning ? '#f0a868' : 'linear-gradient(135deg,#ff6b00,#ff8c00)', cursor: assigning ? 'default' : 'pointer' }}>{assigning ? '⏳ กำลังส่ง…' : '📨 มอบหมายงาน & แจ้งเตือน'}</button>
        </div>

        {/* panel จัดการคน/งาน */}
        {manageOpen && <ManagePanel people={duty.people} onClose={() => setManageOpen(false)} reload={load} />}

        {/* lightbox ขยายรูป */}
        {zoom && (
          <div onClick={() => setZoom(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20 }}>
            <img src={zoom} alt="ขยาย" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12, boxShadow: '0 8px 40px rgba(0,0,0,.5)' }} />
          </div>
        )}

        {/* เงางานที่กำลังลาก — ลอยตามนิ้ว/เมาส์ ไม่รับ event เพื่อให้ elementFromPoint เจอการ์ดข้างล่าง */}
        {drag && (
          <div style={{
            position: 'fixed', left: drag.x, top: drag.y, transform: 'translate(-50%, -140%)',
            zIndex: 1200, pointerEvents: 'none', maxWidth: 260,
            background: '#37474f', color: '#fff', borderRadius: 10, padding: '7px 12px',
            fontSize: '0.8rem', fontWeight: 700, boxShadow: '0 10px 28px rgba(0,0,0,.32)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {drag.over && drag.over !== drag.from ? '📥 ' : '✊ '}{drag.title}
          </div>
        )}

        {/* telegram summary */}
        <button onClick={sendTg} style={{ width: '100%', border: 'none', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '0.9rem', color: '#fff', background: '#229ed9', cursor: 'pointer' }}>✈ ส่งสรุปเข้า Telegram</button>
        {tgMsg && <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#78828a', marginTop: 8 }}>{tgMsg}</div>}
      </div>
    );
  };

// ─── Assistant chat ─────────────────────────────────────────────
const AI_GREETING: ChatMsg = { role: 'assistant', text: 'สวัสดีครับ ถามหรือสั่งได้เลย เช่น\n• "วันนี้ Line 2 ทำอะไรไปแล้วบ้าง" / "สัปดาห์นี้รสไหนผลิตเยอะสุด"\n• "บันทึกผลิต Amazon batch C Line 2 brix 12.4" (มีการ์ดให้กดยืนยันก่อนบันทึกจริง)\n• "บันทึกรอบ CIP Line 3 มี backwash" / "วางแผนพรุ่งนี้ Amazon 6 batch"\n• 📎 แนบรูปแผนผลิตรายสัปดาห์ แล้วถาม "วันนี้กะผมผลิตอะไรบ้าง"\n• ถามเรื่องระบบ/กะทำงาน/วิธีใช้แอปได้ด้วย' };

const AssistantTab: React.FC<{ operatorName: string | null; onAfterAction: () => void; card: React.CSSProperties; onHandoverDraft?: (draft: HoState) => void; onGoToHandoverForm?: () => void; planSignal?: number; handoverSignal?: number }> =
  ({ operatorName, onAfterAction, card, onHandoverDraft, onGoToHandoverForm, planSignal, handoverSignal }) => {
    const [msgs, setMsgs] = useState<ChatMsg[]>([AI_GREETING]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [handoverMode, setHandoverMode] = useState(false); // โหมด "กรอกฟอร์มรับกะด้วย AI" — ข้อความถัดไปจะถูกส่งพร้อม intent พิเศษ
    const [planMode, setPlanMode] = useState(false);          // โหมด "ลงแผนผลิตด้วย AI"
    const [planReview, setPlanReview] = useState<{ shift: string; items: PlanItem[] } | null>(null); // ร่างแผนที่ AI แกะ รอตรวจ/บันทึก
    const [planDay, setPlanDay] = useState(currentWorkDay()); // วันทำงานของแผนที่จะบันทึก
    const [planBusy, setPlanBusy] = useState(false);
    const [sessionN, setSessionN] = useState(0);              // เปลี่ยนเลขนี้ = เริ่ม session ใหม่ (ปุ่ม "แชทใหม่")
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
      const intent = handoverMode ? 'fill_handover' : planMode ? 'fill_plan' : undefined; // เทิร์นนี้ยิง intent พิเศษไหม — จับค่าไว้ก่อน setState
      setMsgs(m => [...m, { role: 'user', text: text || (staged.length ? '(แนบรูป)' : ''), images: staged.length ? staged.map(a => a.preview) : undefined }]);
      setInput(''); setImgs([]); setBusy(true);
      try {
        const r = await fetch(`${apiUrl}/api/assistant`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, operator: operatorName, session: `web-${operatorName || 'guest'}-${sessionN}`,
            intent,
            images: staged.length ? staged.map(a => ({ data: a.data, media_type: a.mediaType })) : undefined }),
        });
        const d = await r.json();
        setMsgs(m => [...m, { role: 'assistant', text: d.reply || d.error || 'ขออภัย เกิดข้อผิดพลาด', pending: d.pending && d.pending.length ? d.pending.map((p: PendingAction) => ({ ...p, status: 'pending' as const })) : undefined, handoverReady: !!d.handoverDraft }]);
        if (d.actions && d.actions.length) onAfterAction();
        if (d.handoverDraft) { onHandoverDraft?.(d.handoverDraft as HoState); setHandoverMode(false); }
        if (d.planDraft && Array.isArray(d.planDraft.items) && d.planDraft.items.length) { // AI แกะแผนได้ → เปิดการ์ดตรวจ
          setPlanReview({ shift: d.planDraft.shift || 'กะเช้า', items: d.planDraft.items as PlanItem[] }); setPlanMode(false);
        }
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
    // เริ่มโหมดกรอกฟอร์มรับกะด้วย AI — ข้อความถัดไปที่พิมพ์จะถูกแกะเป็นฟิลด์แทนที่จะตอบคำถามทั่วไป
    const startHandoverMode = () => {
      setHandoverMode(true); setPlanMode(false);
      setMsgs(m => [...m, { role: 'assistant', text: 'วางข้อความข้อมูลกะที่ได้รับมาได้เลยครับ เช่น ไลน์ไหนรสอะไร batch อะไร ถังเหลือเท่าไหร่ lot อะไร มีหมายเหตุอะไรบ้าง' }]);
    };
    // เริ่มโหมดลงแผนผลิตด้วย AI — วางข้อความแผนทั้งก้อน ระบบจะแกะเป็นรายการเป้าผลิต
    const startPlanMode = () => {
      setPlanMode(true); setHandoverMode(false);
      setMsgs(m => [...m, { role: 'assistant', text: 'วางข้อความแผนผลิตทั้งก้อนได้เลยครับ (คัดลอกมาทั้งหมด) — ผมจะแกะเฉพาะรายการผลิตที่มีเป้า Boxes ให้ตรวจ/แก้/บันทึกเอง' }]);
    };
    // สั่งเข้าโหมดลงแผน/กรอกรับกะด้วย AI จากแถบขั้นตอน (stepper ในแท็บไทม์ไลน์ → เด้งมาแท็บนี้)
    const planSigRef = useRef(0);
    useEffect(() => { if (planSignal && planSignal !== planSigRef.current) { planSigRef.current = planSignal; startPlanMode(); } // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [planSignal]);
    const hoSigRef = useRef(0);
    useEffect(() => { if (handoverSignal && handoverSignal !== hoSigRef.current) { hoSigRef.current = handoverSignal; startHandoverMode(); } // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handoverSignal]);
    // แก้ค่าในการ์ดตรวจแผน (ต่อรายการ)
    const setPlanItem = (i: number, patch: Partial<PlanItem>) => setPlanReview(p => p ? { ...p, items: p.items.map((it, j) => j === i ? { ...it, ...patch } : it) } : p);
    const removePlanItem = (i: number) => setPlanReview(p => p ? { ...p, items: p.items.filter((_, j) => j !== i) } : p);
    // บันทึกแผน → POST /api/shift-plan แล้วปิดการ์ด + ขึ้นข้อความยืนยัน
    const savePlan = async () => {
      if (!planReview || planBusy) return;
      const items = planReview.items.filter(it => it.flavor.trim() && Number(it.target_boxes) > 0);
      if (!items.length) { setMsgs(m => [...m, { role: 'assistant', text: 'ยังไม่มีรายการที่มีรส + เป้า Boxes ให้บันทึกครับ' }]); return; }
      setPlanBusy(true);
      try {
        const body = { workDay: planDay, shift: planReview.shift, operator: operatorName,
          items: items.map(it => ({ flavor: it.flavor.trim(), target_boxes: Math.round(Number(it.target_boxes)), target_batches: Math.round((Number(it.target_boxes) / 100) * 10) / 10, staff: it.staff, machine_code: it.machine_code || '', spec: it.spec || '' })) };
        const r = await fetch(`${apiUrl}/api/shift-plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json();
        if (r.ok && d.success) { setMsgs(m => [...m, { role: 'assistant', text: `✅ บันทึกแผนแล้ว ${d.saved} รายการ (${planReview.shift} · ${planDay})` }]); setPlanReview(null); onAfterAction(); }
        else setMsgs(m => [...m, { role: 'assistant', text: `❌ บันทึกไม่สำเร็จ: ${d.error || 'ไม่ทราบสาเหตุ'}` }]);
      } catch { setMsgs(m => [...m, { role: 'assistant', text: '❌ เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' }]); }
      finally { setPlanBusy(false); }
    };
    // แชทใหม่ — ล้างบทสนทนา + เริ่ม session ใหม่ (server จะไม่ดึงประวัติเก่ามาต่อ)
    const newChat = () => {
      if (busy) return;
      setMsgs([AI_GREETING]); setInput(''); setImgs([]); setHandoverMode(false); setPlanMode(false); setPlanReview(null);
      setSessionN(n => n + 1);
    };
    return (
      <div style={{ ...card, display: 'flex', flexDirection: 'column', height: '70vh', padding: '0', overflow: 'hidden' }}>
        {/* header: ชื่อ + ปุ่มแชทใหม่ */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid #eee', flexShrink: 0 }}>
          <span style={{ fontWeight: 800, fontSize: '0.9rem', color: '#37474f' }}>🤖 ผู้ช่วย AI</span>
          <button onClick={newChat} disabled={busy} title="เริ่มบทสนทนาใหม่" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, border: '1px solid #ffd0a8', background: '#fff7f0', color: '#b34700', borderRadius: 20, padding: '6px 12px', fontSize: '0.76rem', fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}>✏️ แชทใหม่</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
          {!handoverMode && !planMode && !planReview && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px', background: '#fff7f0', border: '1.5px solid #ffd0a8', borderRadius: 14, padding: '12px 14px' }}>
                <div style={{ fontWeight: 800, fontSize: '0.86rem', color: '#b34700', marginBottom: 4 }}>📋 กรอกฟอร์มรับกะด้วย AI</div>
                <div style={{ fontSize: '0.76rem', color: '#5d4037', lineHeight: 1.5, marginBottom: 10 }}>วางข้อความข้อมูลกะที่ได้รับมา ให้ AI ช่วยกรอกฟอร์มให้ — ตรวจ/แก้/กดส่งเองที่ฟอร์ม</div>
                <button onClick={startHandoverMode} style={{ border: 'none', borderRadius: 10, padding: '8px 14px', background: '#ff6b00', color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}>เริ่มกรอกด้วย AI</button>
              </div>
              <div style={{ flex: '1 1 200px', background: '#eef7f3', border: '1.5px solid #b2dfdb', borderRadius: 14, padding: '12px 14px' }}>
                <div style={{ fontWeight: 800, fontSize: '0.86rem', color: '#00695c', marginBottom: 4 }}>🏭 ลงแผนผลิตด้วย AI</div>
                <div style={{ fontSize: '0.76rem', color: '#37474f', lineHeight: 1.5, marginBottom: 10 }}>วางข้อความแผนผลิตทั้งก้อน ให้ AI แกะเป็นรายการเป้าผลิต — ตรวจ/แก้/กดบันทึกเอง</div>
                <button onClick={startPlanMode} style={{ border: 'none', borderRadius: 10, padding: '8px 14px', background: '#00897b', color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}>เริ่มลงแผนด้วย AI</button>
              </div>
            </div>
          )}
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
              {/* กรอกฟอร์มรับกะให้แล้ว — ไม่ auto-jump ให้ผู้ใช้กดเองไปตรวจสอบ/แก้ไข/ส่งที่ฟอร์มจริง */}
              {m.handoverReady && (
                <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 6 }}>
                  <button onClick={() => onGoToHandoverForm?.()} style={{ border: 'none', borderRadius: 10, padding: '9px 14px', background: '#00897b', color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}>👉 ไปตรวจสอบในฟอร์มรับกะ</button>
                </div>
              )}
            </div>
          ))}
          {/* การ์ดตรวจแผนผลิต — AI แกะแล้ว รอผู้ใช้ตรวจ/แก้/บันทึก (batch คำนวณอัตโนมัติ = boxes/100) */}
          {planReview && (
            <div style={{ background: '#eef7f3', border: '1.5px solid #b2dfdb', borderRadius: 14, padding: '12px 14px', marginTop: 4 }}>
              <div style={{ fontWeight: 800, fontSize: '0.86rem', color: '#00695c', marginBottom: 8 }}>🏭 ตรวจแผนผลิต — แก้ได้ แล้วกดบันทึก</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input type="date" value={planDay} onChange={e => setPlanDay(e.target.value)} style={{ border: '1px solid #cbd5db', borderRadius: 9, padding: '6px 9px', fontSize: '0.8rem' }} />
                <select value={planReview.shift} onChange={e => setPlanReview(p => p ? { ...p, shift: e.target.value } : p)} style={{ border: '1px solid #cbd5db', borderRadius: 9, padding: '6px 9px', fontSize: '0.8rem' }}>
                  {['กะเช้า', 'กะบ่าย', 'กะดึก'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {planReview.items.map((it, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 74px 54px 30px', gap: 6, alignItems: 'center', background: '#fff', border: '1px solid #d7ece6', borderRadius: 9, padding: '6px 8px' }}>
                    <input value={it.flavor} onChange={e => setPlanItem(i, { flavor: e.target.value })} placeholder="รส/สินค้า" style={{ border: '1px solid #e0e6ea', borderRadius: 7, padding: '5px 7px', fontSize: '0.8rem', minWidth: 0 }} />
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <input type="number" value={it.target_boxes} onChange={e => setPlanItem(i, { target_boxes: Number(e.target.value) })} placeholder="Boxes" style={{ border: '1px solid #e0e6ea', borderRadius: 7, padding: '5px 7px', fontSize: '0.8rem', width: '100%', boxSizing: 'border-box' }} />
                      <span style={{ fontSize: '0.6rem', color: '#00897b', fontWeight: 700, textAlign: 'center' }}>{Math.round((Number(it.target_boxes) / 100) * 10) / 10} batch</span>
                    </div>
                    <input type="number" value={it.staff ?? ''} onChange={e => setPlanItem(i, { staff: e.target.value === '' ? null : Number(e.target.value) })} placeholder="คน" title="จำนวนคน" style={{ border: '1px solid #e0e6ea', borderRadius: 7, padding: '5px 7px', fontSize: '0.8rem', width: '100%', boxSizing: 'border-box' }} />
                    <button onClick={() => removePlanItem(i)} title="ลบรายการ" style={{ border: 'none', background: 'none', color: '#c62828', cursor: 'pointer', fontSize: '1rem' }}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={savePlan} disabled={planBusy} style={{ flex: 1, border: 'none', borderRadius: 10, padding: '10px 0', background: '#00897b', color: '#fff', fontWeight: 800, fontSize: '0.84rem', cursor: planBusy ? 'default' : 'pointer', opacity: planBusy ? 0.6 : 1 }}>💾 บันทึกแผน ({planReview.items.length})</button>
                <button onClick={() => setPlanReview(null)} disabled={planBusy} style={{ border: '1px solid #cbd5db', borderRadius: 10, padding: '10px 14px', background: '#fff', color: '#78828a', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' }}>ยกเลิก</button>
              </div>
            </div>
          )}
          {busy && <div style={{ color: '#9aa0a6', fontSize: '0.8rem' }}>กำลังคิด…</div>}
          <div ref={endRef} />
        </div>
        <div style={{ borderTop: '1px solid #eee', background: '#fff' }}>
          {/* แถบสถานะโหมดกรอกฟอร์มรับกะด้วย AI — ค้างอยู่บนแชทจนกว่าจะยกเลิกหรือได้ร่างฟอร์มแล้ว */}
          {handoverMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#fff3e0', borderBottom: '1px solid #ffd0a8', fontSize: '0.76rem', color: '#b34700', fontWeight: 700 }}>
              <span style={{ flex: 1 }}>🟠 โหมด: กรอกฟอร์มรับกะ</span>
              <button onClick={() => setHandoverMode(false)} style={{ border: 'none', background: 'none', color: '#b34700', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', fontSize: '0.74rem' }}>ยกเลิกโหมดนี้</button>
            </div>
          )}
          {planMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#e0f2f1', borderBottom: '1px solid #b2dfdb', fontSize: '0.76rem', color: '#00695c', fontWeight: 700 }}>
              <span style={{ flex: 1 }}>🟢 โหมด: ลงแผนผลิต</span>
              <button onClick={() => setPlanMode(false)} style={{ border: 'none', background: 'none', color: '#00695c', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', fontSize: '0.74rem' }}>ยกเลิกโหมดนี้</button>
            </div>
          )}
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
              placeholder={handoverMode ? 'วางข้อความข้อมูลกะที่ได้รับมา…' : planMode ? 'วางข้อความแผนผลิตทั้งก้อน…' : imgs.length ? 'ถามเกี่ยวกับรูปนี้…' : 'พิมพ์ข้อความ… (แนบรูปแผนได้ด้วย 📎)'} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: '12px' }} />
            <button onClick={send} disabled={busy} style={{ padding: '10px 18px', borderRadius: '12px', border: 'none', background: '#ff6b00', color: '#fff', fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>ส่ง</button>
          </div>
        </div>
      </div>
    );
  };

export default TodoBoard;
