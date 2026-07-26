import React, { useEffect, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

interface Task {
  id: number; title: string; category?: string; line_name?: string;
  status?: string; priority?: string; completed_at?: string | null;
  done_by?: string | null; created_at?: string; assignee?: string | null;
}

const bkkDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const shift = () => {
  const h = new Date().getHours();
  if (h >= 6 && h < 14) return 'กะเช้า (06:00–14:00)';
  if (h >= 14 && h < 22) return 'กะบ่าย (14:00–22:00)';
  return 'กะดึก (22:00–06:00)';
};
const isDone = (t: Task) => t.status === 'done' || !!t.completed_at;
const isUrgent = (t: Task) => !!t.priority && ['urgent', 'high', 'ด่วน', 'สูง'].includes(t.priority);

interface Props {
  onOpen: (v: 'production' | 'cip' | 'today') => void;
}

const AdminOverview: React.FC<Props> = ({ onOpen }) => {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const date = bkkDate();

  useEffect(() => {
    let alive = true;
    fetch(`${apiUrl}/api/tasks?date=${date}`)
      .then(r => r.json())
      .then(d => { if (alive) setTasks(d.items || []); })
      .catch(() => { if (alive) setTasks([]); });
    return () => { alive = false; };
  }, [date]);

  const total = tasks?.length ?? 0;
  const done = tasks ? tasks.filter(isDone).length : 0;
  const pending = total - done;
  const urgentPending = tasks ? tasks.filter(t => isUrgent(t) && !isDone(t)).length : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const recent = tasks
    ? [...tasks].sort((a, b) => String(b.completed_at || b.created_at || '').localeCompare(String(a.completed_at || a.created_at || ''))).slice(0, 6)
    : [];

  return (
    <div>
      <h2 className="htitle">ภาพรวมวันนี้</h2>
      <p className="hsub">{date} · {shift()}</p>

      <div className="stats">
        <div className="stat">
          <div className="glow" style={{ background: 'radial-gradient(circle,rgba(255,107,0,.25),transparent 70%)' }} />
          <div className="lb">งานวันนี้</div>
          <div className="v">{tasks ? done : '…'}<span style={{ fontSize: 15, color: 'var(--a-ink-soft)' }}>/{total}</span></div>
          <div className="d">เสร็จแล้ว {pct}%</div>
          <div className="prg"><i style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="stat">
          <div className="glow" style={{ background: 'radial-gradient(circle,rgba(198,40,40,.28),transparent 70%)' }} />
          <div className="lb">งานค้าง</div>
          <div className="v" style={{ color: pending ? '#ff9d80' : 'var(--a-ink)' }}>{tasks ? pending : '…'}</div>
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

      <div className="cols">
        <div className="panel">
          <h3>งานล่าสุด <button className="more" onClick={() => onOpen('today')}>ดูทั้งหมด →</button></h3>
          {tasks === null ? (
            <p style={{ color: 'var(--a-ink-soft)', fontSize: 13 }}>กำลังโหลด…</p>
          ) : recent.length === 0 ? (
            <p style={{ color: 'var(--a-ink-soft)', fontSize: 13 }}>ยังไม่มีงานของวันนี้</p>
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
