import React, { useCallback, useEffect, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

interface Task {
  id: number; title: string; category?: string; line_name?: string;
  status?: string; priority?: string; completed_at?: string | null;
  done_by?: string | null; created_at?: string; assignee?: string | null;
}

const bkkDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const shift = () => {
  const h = new Date().getHours();
  if (h >= 6 && h < 14) return 'กะเช้า (06:00–14:00)';
  if (h >= 14 && h < 22) return 'กะบ่าย (14:00–22:00)';
  return 'กะดึก (22:00–06:00)';
};
const isDone = (t: Task) => t.status === 'done' || !!t.completed_at;
const isUrgent = (t: Task) => !!t.priority && ['urgent', 'high', 'ด่วน', 'สูง'].includes(t.priority);

/* ── 4-g แดชบอร์ดรวม ────────────────────────────────────────────────────────
   GET /api/dashboard/summary?from&to — รวมตัวเลขหัวข้อจากทุกโมดูลมาไว้หน้าเดียว
   ทุกก้อนมี status: ok / thin (มีแต่น้อยเกินจะเชื่อ) / empty / error
   → ช่องที่ยังไม่มีข้อมูลจริงจะบอกว่า "ยังไม่มี" ไม่ใช่โชว์ 0 เฉย ๆ                */
type Status = 'ok' | 'thin' | 'empty' | 'error';
type Dash = {
  from: string; to: string;
  dataSince: { materials: string | null; incidents: string | null; production: string | null };
  production: { status: Status; actual: number; planned: number; pct: number | null; topLine: { name: string; n: number } | null; topFlavor: { name: string; n: number } | null; byDay: { workDay: string; actual: number; planned: number }[]; dataSince: string | null };
  quality: { status: Status; readings?: number; checked?: number; out?: number; rate?: number | null; worstFlavor?: { flavor: string; out: number } | null; noSpecFlavors?: number; noSpecReadings?: number };
  duty: { status: Status; pct?: number | null; done?: number; total?: number; countedDays?: number; people?: { name: string; pct: number; dot: string; trend: string | null }[] };
  shifts: { shift: string; batches: number; cipRounds: number; perDay: number | null; days: number }[];
  cip: { status: Status; count?: number; median?: number | null; openCount?: number; slowest?: { name: string; median: number | null } | null };
  downtime: { status: Status; totalMin?: number; totalCount?: number; missing?: number; openNow?: number; worstMachine?: { name: string; minutes: number; count: number } | null; dataSince?: string | null };
  cost: { status: Status; totalCost?: number; totalMaterial?: number; totalDowntime?: number; batches?: number; unassigned?: number; rateBase?: number; dataSince?: string | null };
  materials: { status: Status; items?: number; lowCount?: number; low?: { name: string; stock: number; unit: string; reorderPoint: number }[]; stockValue?: number; usedCost?: number | null; dataSince?: string | null };
  alerts: { level: 'crit' | 'warn' | 'info'; icon: string; text: string; pane: string }[];
};

type Pane = string;
interface Props {
  onOpen: (v: 'production' | 'cip' | 'today') => void;
  onPane?: (p: Pane) => void;                            // เปิดหน้าย่อยในโซน Admin
}

const soft = 'var(--ink-soft,#6d6259)';
const kanit = 'Kanit, sans-serif';
const money = (n?: number | null) => (n == null ? '—' : n.toLocaleString('th-TH', { maximumFractionDigits: 0 }));
const hours = (m?: number) => (m == null ? '—' : m >= 60 ? `${(m / 60).toFixed(1)} ชม.` : `${m} น.`);
const dayShort = (d?: string | null) => (d ? d.slice(5).replace('-', '/') : '');

const BADGE: Record<Status, { t: string; c: string; b: string } | null> = {
  ok: null,
  thin: { t: 'ข้อมูลยังน้อย', c: '#a15c00', b: '#fff3e0' },
  empty: { t: 'ยังไม่มีข้อมูล', c: '#78828a', b: '#f2ece6' },
  error: { t: 'โหลดไม่ได้', c: '#b3261e', b: '#fdecea' },
};

/* การ์ดหนึ่งโมดูล — กดแล้วเด้งไปหน้าที่เป็นเจ้าของตัวเลขนั้น */
const Card: React.FC<{
  title: string; icon: string; value: string; sub?: React.ReactNode;
  status: Status; note?: string; onClick?: () => void;
}> = ({ title, icon, value, sub, status, note, onClick }) => {
  const badge = BADGE[status];
  return (
    <button onClick={onClick} disabled={!onClick}
      style={{
        textAlign: 'left', cursor: onClick ? 'pointer' : 'default', font: 'inherit',
        background: 'var(--card,#fff)', border: '1px solid var(--line,#eee3d9)', borderRadius: 14,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 2,
        boxShadow: '0 1px 2px rgba(63,37,10,.06)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: soft, fontWeight: 600, minWidth: 0 }}>
        <span style={{ flex: 'none' }}>{icon}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {badge && (
          <span style={{ flex: 'none', marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: badge.c, background: badge.b, borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' }}>
            {badge.t}
          </span>
        )}
      </div>
      <div style={{ fontFamily: kanit, fontSize: 21, fontWeight: 600, color: status === 'empty' ? '#b6ada4' : '#c24f00', lineHeight: 1.3 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11.5, color: soft, lineHeight: 1.6 }}>{sub}</div>}
      {note && <div style={{ fontSize: 11, color: '#a15c00', marginTop: 2 }}>{note}</div>}
    </button>
  );
};

const AdminOverview: React.FC<Props> = ({ onOpen, onPane }) => {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [dash, setDash] = useState<Dash | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const date = bkkDate();

  useEffect(() => {
    let alive = true;
    fetch(`${apiUrl}/api/tasks?date=${date}`)
      .then(r => r.json())
      .then(d => { if (alive) setTasks(d.items || []); })
      .catch(() => { if (alive) setTasks([]); });
    return () => { alive = false; };
  }, [date]);

  const loadDash = useCallback(async () => {
    setLoading(true);
    const to = bkkDate(), from = shiftDay(to, -(days - 1));
    try {
      const d = await fetch(`${apiUrl}/api/dashboard/summary?from=${from}&to=${to}`).then(r => r.json());
      setDash(d && d.production ? d : null);
    } catch { setDash(null); } finally { setLoading(false); }
  }, [days]);
  useEffect(() => { loadDash(); }, [loadDash]);

  const total = tasks?.length ?? 0;
  const done = tasks ? tasks.filter(isDone).length : 0;
  const pending = total - done;
  const urgentPending = tasks ? tasks.filter(t => isUrgent(t) && !isDone(t)).length : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const recent = tasks
    ? [...tasks].sort((a, b) => String(b.completed_at || b.created_at || '').localeCompare(String(a.completed_at || a.created_at || ''))).slice(0, 6)
    : [];

  const go = (p: Pane) => { if (onPane) onPane(p); };
  // โมดูลที่เพิ่งเริ่มเก็บข้อมูลกลางช่วงที่ดู — เตือนว่าตัวเลขยังไม่เต็มช่วง
  const sinceNote = (d?: string | null) => (d && dash && d > dash.from ? `เริ่มเก็บ ${dayShort(d)}` : undefined);

  return (
    <div>
      <h2 className="htitle">ภาพรวมวันนี้</h2>
      <p className="hsub">{date} · {shift()}</p>

      <div className="stats">
        <div className="stat">
          <div className="glow" style={{ background: 'radial-gradient(circle,rgba(255,107,0,.25),transparent 70%)' }} />
          <div className="lb">งานวันนี้</div>
          <div className="v">{tasks ? done : '…'}<span style={{ fontSize: 15, color: 'var(--ink-soft)' }}>/{total}</span></div>
          <div className="d">เสร็จแล้ว {pct}%</div>
          <div className="prg"><i style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="stat">
          <div className="glow" style={{ background: 'radial-gradient(circle,rgba(198,40,40,.28),transparent 70%)' }} />
          <div className="lb">งานค้าง</div>
          <div className="v" style={{ color: pending ? 'var(--danger)' : 'var(--ink)' }}>{tasks ? pending : '…'}</div>
          <div className="d">{urgentPending > 0 ? <>ด่วนที่ยังค้าง <b className="down">{urgentPending}</b></> : 'ไม่มีงานด่วนค้าง'}</div>
        </div>
        <button className="stat" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onOpen('cip')}>
          <div className="glow" style={{ background: 'radial-gradient(circle,rgba(21,101,192,.3),transparent 70%)' }} />
          <div className="lb">CIP</div>
          <div className="v" style={{ fontSize: 19 }}>เปิดหน้า CIP →</div>
          <div className="d">Line 1 · 2 · 3 · ทดลอง</div>
        </button>
        <button className="stat" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onOpen('production')}>
          <div className="glow" style={{ background: 'radial-gradient(circle,rgba(28,138,76,.28),transparent 70%)' }} />
          <div className="lb">บันทึกการผลิต</div>
          <div className="v" style={{ fontSize: 19 }}>เปิดหน้าผลิต →</div>
          <div className="d">ลง batch · brix · pH · lot</div>
        </button>
      </div>

      {/* ── ต้องสนใจตอนนี้ (รวมข้ามโมดูล) ── */}
      {dash && dash.alerts.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>ต้องสนใจตอนนี้</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {dash.alerts.map((a, i) => (
              <button key={i} onClick={() => go(a.pane)}
                style={{
                  display: 'flex', gap: 9, alignItems: 'flex-start', textAlign: 'left', font: 'inherit', cursor: 'pointer',
                  background: a.level === 'crit' ? '#fdecea' : a.level === 'warn' ? '#fffaf0' : '#fbf7f3',
                  border: `1px solid ${a.level === 'crit' ? '#f2c4bc' : a.level === 'warn' ? '#f0dcc0' : 'var(--line,#eee3d9)'}`,
                  borderRadius: 10, padding: '9px 11px',
                }}>
                <span style={{ flex: 'none', fontSize: 14 }}>{a.icon}</span>
                <span style={{ flex: 1, fontSize: 13, lineHeight: 1.6, color: a.level === 'crit' ? '#b3261e' : 'var(--ink,#2b2119)' }}>{a.text}</span>
                <span style={{ flex: 'none', fontSize: 12, color: soft }}>→</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── ตัวเลขรวมทุกโมดูล ── */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h3>
          สรุปย้อนหลัง
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            {[7, 30, 90].map(d => (
              <button key={d} onClick={() => setDays(d)}
                style={{
                  font: 'inherit', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: '3px 10px', borderRadius: 999,
                  border: '1px solid var(--line,#eee3d9)',
                  background: days === d ? '#fff3ea' : '#fff', color: days === d ? '#c24f00' : soft,
                }}>{d} วัน</button>
            ))}
          </span>
        </h3>

        {!dash
          ? <p style={{ color: soft, fontSize: 13 }}>{loading ? 'กำลังโหลด…' : 'โหลดสรุปไม่สำเร็จ'}</p>
          : (
            <>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))' }}>
                <Card icon="🏭" title="ผลิตได้" status={dash.production.status}
                  value={dash.production.status === 'empty' ? '—' : `${dash.production.actual} batch`}
                  sub={dash.production.status === 'empty' ? 'ยังไม่มีการลงยอดผลิตในช่วงนี้' : <>
                    {dash.production.pct != null ? <>เทียบแผน {dash.production.pct}% ({dash.production.planned} batch)</> : 'ยังไม่ได้ลงแผนในช่วงนี้'}
                    {dash.production.topFlavor && <><br />มากสุด: {dash.production.topFlavor.name} ({dash.production.topFlavor.n})</>}
                  </>}
                  onClick={() => go('calendar')} />

                <Card icon="🔬" title="คุณภาพหลุดสเปก" status={dash.quality.status}
                  value={dash.quality.status === 'empty' ? '—' : `${dash.quality.out} ครั้ง`}
                  sub={dash.quality.status === 'empty'
                    ? 'ยังไม่มีค่าที่ตรวจเทียบสเปกได้'
                    : <>จาก {dash.quality.checked} ครั้งที่ตรวจได้ ({dash.quality.rate}%)
                        {dash.quality.worstFlavor && <><br />บ่อยสุด: {dash.quality.worstFlavor.flavor}</>}</>}
                  note={dash.quality.noSpecFlavors ? `อีก ${dash.quality.noSpecReadings} ค่ายังไม่ถูกตรวจ (${dash.quality.noSpecFlavors} รสไม่มีสเปก)` : undefined}
                  onClick={() => go('quality')} />

                <Card icon="👥" title="งานประจำทั้งทีม" status={dash.duty.status}
                  value={dash.duty.status === 'empty' || dash.duty.pct == null ? '—' : `${dash.duty.pct}%`}
                  sub={dash.duty.status === 'empty'
                    ? 'ยังไม่มีการติ๊กงานในช่วงนี้'
                    : <>{dash.duty.done}/{dash.duty.total} งาน · {dash.duty.countedDays} วันที่ใช้งานจริง
                        {dash.duty.people && dash.duty.people.length > 0 && (
                          <><br />{dash.duty.people.slice(0, 4).map(p => `${p.name} ${p.pct}%`).join(' · ')}</>
                        )}</>}
                  onClick={() => go('perf')} />

                <Card icon="🧼" title="เวลาต่อรอบ CIP" status={dash.cip.status}
                  value={dash.cip.status === 'empty' || dash.cip.median == null ? '—' : `${Math.round(dash.cip.median)} นาที`}
                  sub={dash.cip.status === 'empty'
                    ? 'ยังไม่มีรอบที่กดเริ่ม–จบครบ'
                    : <>ค่ากลางจาก {dash.cip.count} รอบ
                        {dash.cip.slowest && dash.cip.slowest.median != null && <><br />ช้าสุด: {dash.cip.slowest.name} ({Math.round(dash.cip.slowest.median)} น.)</>}</>}
                  note={dash.cip.openCount ? `ลืมกดจบ ${dash.cip.openCount} รอบ` : undefined}
                  onClick={() => go('perf')} />

                <Card icon="⏱" title="เวลาเครื่องหยุด" status={dash.downtime.status}
                  value={dash.downtime.status === 'empty' ? '—' : hours(dash.downtime.totalMin)}
                  sub={dash.downtime.status === 'empty'
                    ? 'ยังไม่มีเหตุการณ์ที่กรอกเวลาไว้'
                    : <>{dash.downtime.totalCount} ครั้ง
                        {dash.downtime.worstMachine && <><br />มากสุด: {dash.downtime.worstMachine.name}</>}</>}
                  note={dash.downtime.openNow ? `ยังหยุดอยู่ ${dash.downtime.openNow} รายการ` : sinceNote(dash.downtime.dataSince)}
                  onClick={() => go('downtime')} />

                <Card icon="💰" title="ต้นทุนต่อ batch" status={dash.cost.status}
                  value={dash.cost.status === 'empty' ? '—' : `${money(dash.cost.totalCost)} บาท`}
                  sub={dash.cost.status === 'empty'
                    ? 'ยังไม่มีการเบิกของที่ระบุ batch'
                    : <>{dash.cost.batches} batch · วัสดุ {money(dash.cost.totalMaterial)} + เวลา {money(dash.cost.totalDowntime)}</>}
                  note={dash.cost.rateBase != null && dash.cost.rateBase <= 0
                    ? 'ยังไม่ได้ตั้งค่าเสียโอกาส/ชม.'
                    : (dash.cost.unassigned ? `ไม่ระบุ batch ${money(dash.cost.unassigned)} บาท` : sinceNote(dash.cost.dataSince))}
                  onClick={() => go('cost')} />

                <Card icon="🧪" title="คลังวัสดุ" status={dash.materials.status}
                  value={dash.materials.status === 'empty' ? '—' : (dash.materials.lowCount ? `ใกล้หมด ${dash.materials.lowCount} รายการ` : `ครบ ${dash.materials.items} รายการ`)}
                  sub={dash.materials.status === 'empty'
                    ? 'ยังไม่ได้ใส่วัสดุเข้าคลัง'
                    : <>มูลค่าคงคลัง {money(dash.materials.stockValue)} บาท · เบิกใช้ {money(dash.materials.usedCost)} บาท
                        {dash.materials.low && dash.materials.low.length > 0 && <><br />{dash.materials.low.map(m => `${m.name} เหลือ ${m.stock} ${m.unit}`).join(' · ')}</>}</>}
                  onClick={() => go('materials')} />
              </div>

              {/* แยกรายกะสั้น ๆ — รายละเอียดอยู่หน้าเทียบประสิทธิภาพ */}
              {dash.shifts.length > 0 && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12, fontSize: 12.5, color: soft }}>
                  <span style={{ fontWeight: 700 }}>แยกตามกะ:</span>
                  {dash.shifts.map(s => (
                    <span key={s.shift}>
                      กะ{s.shift} <b style={{ color: '#c24f00' }}>{s.batches}</b> batch
                      {s.perDay != null && ` (${s.perDay}/วัน)`}
                      {s.cipRounds > 0 && ` · CIP ${s.cipRounds}`}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 11, color: soft, marginTop: 8 }}>
                ช่วง {dayShort(dash.from)}–{dayShort(dash.to)} · กดการ์ดเพื่อเปิดหน้ารายละเอียดของตัวเลขนั้น
              </div>
            </>
          )}
      </div>

      <div className="cols" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3>งานล่าสุด <button className="more" onClick={() => onOpen('today')}>ดูทั้งหมด →</button></h3>
          {tasks === null ? (
            <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>กำลังโหลด…</p>
          ) : recent.length === 0 ? (
            <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>ยังไม่มีงานของวันนี้</p>
          ) : (
            <ul className="feed">
              {recent.map(t => (
                <li key={t.id}>
                  <span className="fic">{isDone(t) ? '✅' : isUrgent(t) ? '⚠️' : '•'}</span>
                  <div className="fbody">
                    <b>{t.title || t.category || 'งาน'}</b>
                    <small>
                      {[t.line_name, t.category, isDone(t) ? `เสร็จ${t.done_by ? ' · ' + t.done_by : ''}` : (t.assignee ? 'มอบให้ ' + t.assignee : 'ค้างอยู่')]
                        .filter(Boolean).join(' · ')}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          <h3>ทางลัด</h3>
          <ul className="alist">
            <li className="alert" style={{ cursor: 'pointer' }} onClick={() => onOpen('today')}>
              ✅<div className="abd"><b>งานวันนี้</b><small>บอร์ดงาน · หน้าที่บุคคล · ปิดงาน</small></div>
            </li>
            <li className="alert" style={{ cursor: 'pointer' }} onClick={() => onOpen('production')}>
              🏭<div className="abd"><b>บันทึกการผลิต</b><small>ลง batch / brix / pH ของแต่ละ Line</small></div>
            </li>
            <li className="alert" style={{ cursor: 'pointer' }} onClick={() => onOpen('cip')}>
              💧<div className="abd"><b>CIP</b><small>ล้างระบบ Line 1–3 และ CIP ทดลอง</small></div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default AdminOverview;
