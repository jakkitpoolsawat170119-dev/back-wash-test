import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { authHeaders, authRole } from '../lib/auth';
import '../pm.css';

/* ── แผน PM ประจำปี 52 สัปดาห์ — กระจกอ่านอย่างเดียวของแอปทีมช่าง ─────────────
   เจ้าของแผนและผลปิดงานคือแอปทีมช่าง (Netlify + Firebase spp-am)
   หน้านี้ "ไม่มีปุ่มเขียนกลับ" — ปิดงาน / เลื่อนวัน / แก้แผน ทำที่นั่นที่เดียว
   ยกเว้น 2 อย่างที่ Netlify ไม่มีช่องเก็บ จึงเป็นของแอปนี้เองและแก้ได้:
     ① ลิสต์งานย่อยต่อเครื่อง (+ ความถี่รายข้อ)   ② ผู้รับผิดชอบตั้งต้น
   🔑 หน่วยนับคือ "เครื่อง × สัปดาห์" งานย่อยเป็นรายละเอียดข้างใน ไม่ใช่หน่วยนับ  */

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

export type Cycle = {
  week: number; monday: string; sunday: string;
  status: 'done' | 'over' | 'due' | 'future' | 'skip';
  doneBy: string; doneDate: string; note: string; reason: string; jobs: string[];
};
export type Job = { id: number; title: string; every: number; freqLabel: string; weeks: number[] };
export type Item = {
  netId: string; name: string; machine: string; freq: string; freqLabel: string; step: number;
  isCustom: boolean; owner: string; weeks: number[]; cycles: Cycle[]; jobs: Job[];
  stat: {
    planned: number; active: number; due: number; done: number; over: number; skip: number;
    thisWeek: number; pct: number | null; lastDone: string; nextWeek: number | null; nextMonday: string;
  };
};
type MonthSpan = { month: number; weeks: number; from: number };
export type Plan = {
  year: number; weeksInYear: number; curYear: number; curWeek: number;
  months: MonthSpan[]; items: Item[];
  jobRegistry: { title: string; uses: number }[];
  people: { key: string; name: string }[];
  syncedAt: string | null; syncOk: boolean | null; netlifyUrl: string;
};
type WeekRow = {
  netId: string; name: string; machine: string; freqLabel: string; owner: string;
  week: number; monday: string; sunday: string; status: Cycle['status'];
  doneBy: string; doneDate: string; note: string; reason: string; jobs: string[]; lateWeeks: number;
};
export type WeekData = {
  year: number; week: number; weeksInYear: number; monday: string; sunday: string;
  curYear: number; curWeek: number; isCurrent: boolean;
  thisWeek: WeekRow[]; late: WeekRow[]; lateTotal: number;
  stat: { total: number; done: number; left: number; pct: number | null; late: number; skip: number };
  syncedAt: string | null; netlifyUrl: string;
};
export type Summary = {
  year: number; curMonth: number;
  total: {
    planned: number; active: number; due: number; done: number; over: number; skip: number;
    pctDue: number | null; machines: number; machinesOver: number;
  };
  curve: { month: number; plan: number; actual: number | null }[];
  gap: number | null;
  rows: {
    netId: string; name: string; freqLabel: string; planned: number; active: number; due: number;
    done: number; over: number; skip: number; pct: number | null; lastDone: string; nextWeek: number | null;
  }[];
};

const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MON_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const DAY_TH = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];

const dayNum = (d: string) => Number(String(d).slice(8, 10));
const monNum = (d: string) => Number(String(d).slice(5, 7)) - 1;
const shortDate = (d: string) => (d ? `${dayNum(d)} ${TH_MON[monNum(d)]}` : '—');
const stampTime = (iso: string | null) => {
  if (!iso) return 'ยังไม่เคยดึง';
  try {
    const d = new Date(iso);
    return `${d.getDate()} ${TH_MON[d.getMonth()]} ${d.getFullYear()} · ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return iso; }
};

const STATUS_COLOR: Record<Cycle['status'], string> = {
  done: 'var(--ok)', over: 'var(--danger)', due: 'var(--brand)',
  future: 'transparent', skip: 'var(--muted)',
};
const STATUS_TH: Record<Cycle['status'], string> = {
  done: 'ทำแล้ว', over: 'เลยกำหนด ยังไม่ทำ', due: 'ครบกำหนดสัปดาห์นี้',
  future: 'ยังไม่ถึงกำหนด', skip: 'ปิดใช้งานรอบนี้',
};
// ไอคอนของเครื่อง — เดาจากชื่อ ไม่ต้องมีทะเบียนแยก (ผิดบ้างไม่เสียหาย)
const iconOf = (n: string) => {
  if (/RO|น้ำ|น้ำเชื่อม|บ่อ/.test(n)) return '💧';
  if (/AHU|Chiller|แอร์|Cold|หลอดไฟ|ถุง/.test(n)) return '❄️';
  if (/ต้ม|ไอซิ่ง|น้ำตาล/.test(n)) return '🔥';
  if (/Lift|Robot|สายพาน/.test(n)) return '🤖';
  if (/ห้อง|Air Shower/.test(n)) return '🚪';
  return '📦';
};
const pctColor = (p: number | null) => (p == null ? 'var(--muted)'
  : p >= 95 ? 'var(--ok)' : p >= 90 ? 'var(--warn)' : 'var(--danger)');

/* ── แถบ "ข้อมูลมาจากไหน" — โผล่ทุกมุมมอง กันคนเข้าใจผิดว่าปิดงานที่นี่ได้ ── */
const SyncBar: React.FC<{ text: React.ReactNode; at: string | null; url: string; label?: string }> =
  ({ text, at, url, label }) => (
    <div className="syncbar">
      <span className={`dot2${at ? '' : ' bad'}`} />
      <div className="sb-t">{text}</div>
      <span className="sb-time">อัปเดตล่าสุด {stampTime(at)}</span>
      <a className="ibtn sm ext" href={url} target="_blank" rel="noopener noreferrer">
        ↗ {label || 'เปิดแอปทีมช่าง'}
      </a>
    </div>
  );

/* ══════════════ ① สัปดาห์นี้ ══════════════ */
const WeekCard: React.FC<{ r: WeekRow; url: string; tone: string }> = ({ r, url, tone }) => (
  <article className={`tk ${tone}`}>
    <div className="r1">
      <h3>{r.name}</h3>
      <span className="chip freq">{r.freqLabel}</span>
      <span className="src plan">แผนประจำปี</span>
      {r.status === 'over' && <span className="chip stop">เกินกำหนด {r.lateWeeks} สัปดาห์</span>}
      {r.status === 'due' && <span className="chip due">ครบกำหนดสัปดาห์นี้</span>}
      {r.status !== 'skip' && !r.owner && <span className="chip warn">ยังไม่มีคนรับ</span>}
    </div>
    <div className="meta">
      <span>🔩 {r.machine}</span><span className="dot">·</span>
      <span>👤 {r.owner || 'ยังไม่มอบหมาย'}</span><span className="dot">·</span>
      <span>📅 ครบกำหนด W{r.week} · {shortDate(r.monday)}–{shortDate(r.sunday)}</span>
      {r.status === 'done' && (
        <>
          <span className="dot">·</span>
          <span style={{ color: 'var(--ok)', fontWeight: 600 }}>
            ✅ เสร็จเมื่อ {shortDate(r.doneDate)}{r.doneBy ? ` โดย ${r.doneBy}` : ''}
          </span>
        </>
      )}
      {r.status === 'skip' && (
        <>
          <span className="dot">·</span>
          <span style={{ color: 'var(--muted)' }}>🚫 ปิดรอบนี้{r.reason ? ` — ${r.reason}` : ''}</span>
        </>
      )}
    </div>
    {r.note && <div className="jobline">📝 {r.note}</div>}
    {r.jobs.length > 0 && (
      <div className="jobline"><b>งานที่ต้องทำรอบนี้:</b> {r.jobs.join(' · ')}</div>
    )}
    <div className="acts ro">
      <span className="ro-note">🔒 ปิดงาน / เลื่อนวัน / มอบหมาย ทำที่แอปทีมช่าง</span>
      <a className="ibtn sm ext" href={url} target="_blank" rel="noopener noreferrer">↗ เปิดแอปทีมช่าง</a>
    </div>
  </article>
);

const toneOf = (s: Cycle['status']) => (s === 'done' ? 'done' : s === 'over' ? 'late' : s === 'skip' ? 'skip' : 'due');

const WeekView: React.FC<{
  d: WeekData | null; loading: boolean; onWeek: (w: number) => void; onToday: () => void;
  onNewAdhoc: () => void;
}> = ({ d, loading, onWeek, onToday, onNewAdhoc }) => {
  const [allLate, setAllLate] = useState(false);
  const [pick, setPick] = useState('');            // กรองเฉพาะเครื่อง/พื้นที่นี้
  if (!d) {
    return <div className="pcard empty">{loading ? '⏳ กำลังโหลด…' : 'โหลดข้อมูลสัปดาห์ไม่สำเร็จ — กด 🔄 รีเฟรช'}</div>;
  }
  const machines = Array.from(new Set([...d.thisWeek, ...d.late].map((r) => r.machine))).sort();
  const keep = (r: WeekRow) => !pick || r.machine === pick;
  const lateAll = d.late.filter(keep);
  const late = allLate ? lateAll : lateAll.slice(0, 3);
  const order: Cycle['status'][] = ['due', 'done', 'skip'];
  const rows = d.thisWeek.filter(keep).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <>
      <div className="pcard" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px' }}>
        <button className="ibtn" style={{ padding: '6px 12px' }} disabled={d.week <= 1}
          onClick={() => onWeek(d.week - 1)}>‹</button>
        <div>
          <div style={{ fontFamily: 'var(--font-head)', fontSize: 17, fontWeight: 600, letterSpacing: '-.02em' }}>
            สัปดาห์ที่ {d.week} / {d.year}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
            จ. {shortDate(d.monday)} – อา. {shortDate(d.sunday)} {d.year}
            {d.isCurrent ? ' · สัปดาห์ปัจจุบัน' : ''}
          </div>
        </div>
        <button className="ibtn" style={{ padding: '6px 12px' }} disabled={d.week >= d.weeksInYear}
          onClick={() => onWeek(d.week + 1)}>›</button>
        {!d.isCurrent && <button className="ibtn" onClick={onToday}>สัปดาห์นี้</button>}
        <div className="sp" />
        {loading && <span style={{ fontSize: 12, color: 'var(--muted)' }}>⏳ กำลังโหลด…</span>}
        <select className="isel" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">🔩 ทุกเครื่อง / พื้นที่</option>
          {machines.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button className="ibtn pri" onClick={onNewAdhoc}>➕ ตั้งงาน PM</button>
      </div>

      <div className="wkprog">
        <div className="wp-main">
          <div className="wp-top">
            <span className="wp-t">สัปดาห์ที่ {d.week} · ทำแล้ว <b>{d.stat.done}</b> จาก <b>{d.stat.total}</b></span>
            <span className="wp-pct">{d.stat.pct == null ? '—' : `${d.stat.pct}%`}</span>
          </div>
          <div className="wp-bar"><span style={{ width: `${d.stat.pct || 0}%` }} /></div>
          <div className="wp-sub">
            {d.stat.total === 0 ? 'สัปดาห์นี้ไม่มีรอบตามแผน'
              : <>เหลือ <b>{d.stat.left} รายการ</b> · ครบกำหนด อา. {shortDate(d.sunday)}</>}
          </div>
        </div>
        <div className={`istat${d.stat.late ? ' hot' : ''}`}>
          <div className="l">⚠️ ค้างจากสัปดาห์ก่อน</div>
          <div className="v">{d.stat.late}<span className="u">รายการ</span></div>
        </div>
        <div className="istat">
          <div className="l">🚫 ปิดใช้งานรอบนี้</div>
          <div className="v" style={{ color: 'var(--muted)' }}>{d.stat.skip}</div>
        </div>
      </div>

      {lateAll.length > 0 && (
        <>
          <div className="warnbox">
            <b>ค้างจากสัปดาห์ก่อน {lateAll.length} รายการ</b>{pick ? ` (เฉพาะ ${pick})` : ''} —
            ยกมาไว้บนสุดจนกว่าจะปิดงานหรือปิดรอบที่แอปทีมช่าง
            ไม่ปล่อยให้ตกหล่นไปกับสัปดาห์เก่า{allLate ? '' : ` (แสดง ${late.length} รอบที่ใกล้ปัจจุบันที่สุด)`}
          </div>
          <div className="ilist">
            {late.map((r) => <WeekCard key={`${r.netId}_${r.week}`} r={r} url={d.netlifyUrl} tone="late" />)}
          </div>
          {lateAll.length > 3 && (
            <div style={{ margin: '11px 0 16px' }}>
              <button className="ibtn" onClick={() => setAllLate(!allLate)}>
                {allLate ? '▴ ย่องานค้าง' : `📋 ดูงานค้างทั้งหมด ${lateAll.length} รายการ`}
              </button>
            </div>
          )}
        </>
      )}

      <div className="ilist" style={{ marginTop: 14 }}>
        {rows.map((r) => <WeekCard key={`${r.netId}_${r.week}`} r={r} url={d.netlifyUrl} tone={toneOf(r.status)} />)}
        {rows.length === 0 && (
          <div className="pcard empty">
            สัปดาห์ที่ {d.week} ไม่มีรอบ PM ตามแผน{pick ? ` ของ ${pick}` : ''}
          </div>
        )}
      </div>
    </>
  );
};

/* ══════════════ ② ตารางทั้งปี (dot matrix) ══════════════ */
type Range = 'year' | 'half' | 'qtr';

const YearGrid: React.FC<{ p: Plan; onPick: (netId: string) => void }> = ({ p, onPick }) => {
  // จอมือถือเปิดมาที่ไตรมาสเลย — 27 คอลัมน์บนจอ 390px ต้องเลื่อนหาสัปดาห์ปัจจุบันทุกครั้ง
  const [range, setRange] = useState<Range>(() =>
    (typeof window !== 'undefined' && window.innerWidth < 760 ? 'qtr' : 'half'));
  const [sortLate, setSortLate] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const half = Math.floor(p.weeksInYear / 2) + 1;          // ครึ่งปีหลังเริ่มที่นี่
  const qFrom = Math.floor((p.curWeek - 1) / 13) * 13 + 1; // ไตรมาสของสัปดาห์ปัจจุบัน
  const weeks = useMemo(() => {
    const all = Array.from({ length: p.weeksInYear }, (_, i) => i + 1);
    if (range === 'half') return all.filter((w) => w >= half);
    if (range === 'qtr') return all.filter((w) => w >= qFrom && w < qFrom + 13);
    return all;
  }, [range, p.weeksInYear, half, qFrom]);

  // แถบเดือน — สัปดาห์ ISO สังกัดเดือนของ "วันพฤหัส" (เซิร์ฟเวอร์คิดมาให้แล้ว)
  const monthOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of p.months) for (let i = 0; i < s.weeks; i += 1) m.set(s.from + i, s.month);
    return m;
  }, [p.months]);
  const spans = useMemo(() => {
    const out: { month: number; n: number }[] = [];
    for (const w of weeks) {
      const mo = monthOf.get(w) ?? 0;
      if (out.length && out[out.length - 1].month === mo) out[out.length - 1].n += 1;
      else out.push({ month: mo, n: 1 });
    }
    return out;
  }, [weeks, monthOf]);

  const items = useMemo(() => (sortLate
    ? [...p.items].sort((a, b) => b.stat.over - a.stat.over || (a.stat.pct ?? 101) - (b.stat.pct ?? 101))
    : p.items), [p.items, sortLate]);

  const dot = (c: Cycle | undefined, small: boolean) => {
    if (!c) return null;
    const st = c.status;
    return (
      <span className={`d${small ? ' sm' : ''}`} title={`W${c.week} · ${STATUS_TH[st]}`}>
        <i className={st === 'future' ? 'fut' : ''} style={st === 'future' ? undefined : { background: STATUS_COLOR[st] }} />
      </span>
    );
  };

  return (
    <div className="pcard" style={{ padding: '14px 16px' }}>
      <div className="ybar">
        <h3 style={{ fontSize: 15 }}>ตารางแผน PM ทั้งปี</h3>
        <div className="rngs">
          {([['year', 'ทั้งปี'], ['half', 'ครึ่งปีหลัง'], ['qtr', `ไตรมาสนี้ (W${qFrom}–W${qFrom + 12})`]] as [Range, string][])
            .map(([k, t]) => (
              <button key={k} className={`rng${range === k ? ' on' : ''}`} onClick={() => setRange(k)}>{t}</button>
            ))}
        </div>
        <button className="ibtn" onClick={() => setSortLate(!sortLate)}>
          {sortLate ? '↕ เรียงตามรหัสแผน' : '↕ เรียงงานค้างขึ้นก่อน'}
        </button>
        <div className="sp" />
        <span className="chip mute">แผน {p.items.length} รายการ</span>
      </div>

      <SyncBar url={p.netlifyUrl} at={p.syncedAt} label="แก้แผนที่แอปทีมช่าง"
        text={<>ตารางนี้คือ <b>ภาพสะท้อนของแผนบนแอปทีมช่าง</b> · กดที่ชื่อเพื่อดู/แก้ลิสต์งานย่อยของเครื่องนั้น</>} />

      <div className={`mx rng-${range}`} style={{ marginTop: 11 }}>
        <table className="grid">
          <thead>
            <tr className="mrow">
              <th className="nm mt" /><th className="fq mt" /><th className="pc mt" />
              {spans.map((s, i) => (
                <th key={`${s.month}_${i}`} colSpan={s.n}
                  className={`mh${i % 2 ? ' alt' : ''}${p.curYear === p.year && s.month === monthOf.get(p.curWeek) ? ' cur' : ''}`}>
                  {TH_MON[s.month]}</th>
              ))}
            </tr>
            <tr className="wrow">
              <th className="nm">รายการ PM</th><th className="fq">ความถี่</th><th className="pc">ทำแล้ว</th>
              {weeks.map((w) => (
                <th key={w} className={`wkh g${w === p.curWeek && p.curYear === p.year ? ' cur' : ''}`}>{w}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const byWeek = new Map(it.cycles.map((c) => [c.week, c]));
              const isOpen = !!open[it.netId];
              const cur = p.curYear === p.year ? p.curWeek : -1;
              return (
                <React.Fragment key={it.netId}>
                  <tr className={`mach${isOpen ? ' open' : ''}${idx % 2 ? ' alt' : ''}`}>
                    <th className="nm">
                      <button className="tw" aria-expanded={isOpen} title="กาง/พับลิสต์งานย่อย"
                        onClick={() => setOpen({ ...open, [it.netId]: !isOpen })}>▸</button>
                      <span title={it.name} style={{ cursor: 'pointer' }} onClick={() => onPick(it.netId)}>{it.name}</span>
                      {it.jobs.length > 0 && <span className="jn">{it.jobs.length}</span>}
                    </th>
                    <th className="fq">{it.freqLabel}</th>
                    <th className="pc">
                      <div className="pcv" style={{ color: pctColor(it.stat.pct) }}>
                        {it.stat.done}<span>/{it.stat.due}</span>
                      </div>
                      <div className="bar">
                        <span style={{ width: `${it.stat.pct || 0}%`, background: pctColor(it.stat.pct) }} />
                      </div>
                    </th>
                    {weeks.map((w) => (
                      <td key={w} className={`wk g${w === cur ? ' cur' : ''}`}>{dot(byWeek.get(w), false)}</td>
                    ))}
                  </tr>
                  {isOpen && it.jobs.map((j) => {
                    const jw = new Set(j.weeks);
                    return (
                      <tr className="jr" key={`${it.netId}_${j.id}`}>
                        <th className="nm"><span className="tick">└</span><span title={j.title}>{j.title}</span></th>
                        <th className="fq">{j.freqLabel}</th>
                        <th className="pc">{j.weeks.length}<span> ครั้ง</span></th>
                        {weeks.map((w) => (
                          <td key={w} className={`wk g${w === cur ? ' cur' : ''}`}>
                            {jw.has(w) ? dot(byWeek.get(w), true) : null}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  {isOpen && it.jobs.length === 0 && (
                    <tr className="jr">
                      <th className="nm" style={{ color: 'var(--muted)' }}>
                        <span className="tick">└</span>
                        <span>ยังไม่ได้ใส่ลิสต์งานย่อย — กดที่ชื่อเครื่องเพื่อเพิ่ม</span>
                      </th>
                      <th className="fq" /><th className="pc" />
                      {weeks.map((w) => <td key={w} className="wk g" />)}
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--ok)' }} />ทำแล้ว</span>
        <span><i style={{ background: 'var(--danger)' }} />เลยกำหนด ยังไม่ทำ</span>
        <span><i style={{ background: 'var(--brand)' }} />ครบกำหนดสัปดาห์นี้</span>
        <span><i style={{ background: 'transparent', border: '1.5px solid var(--sep)' }} />ยังไม่ถึงกำหนด</span>
        <span><i style={{ background: 'var(--muted)' }} />ปิดใช้งานรอบนี้ (ไม่นับทั้งแผนและผล)</span>
      </div>
    </div>
  );
};

/* ══════════════ ③ ตามเครื่องจักร ══════════════ */
const ByMachine: React.FC<{ p: Plan; onPick: (netId: string) => void }> = ({ p, onPick }) => {
  const [freq, setFreq] = useState('');
  const freqs = useMemo(() => Array.from(new Set(p.items.map((i) => i.freqLabel))), [p.items]);
  const rows = useMemo(() => p.items
    .filter((i) => !freq || i.freqLabel === freq)
    .sort((a, b) => b.stat.over - a.stat.over || (a.stat.pct ?? 101) - (b.stat.pct ?? 101)), [p.items, freq]);
  const dueThisWeek = p.items.reduce((s, i) => s + i.stat.thisWeek, 0);
  const overall = p.items.reduce((s, i) => s + i.stat.done, 0);
  const overallDue = p.items.reduce((s, i) => s + i.stat.due, 0);

  return (
    <>
      <div className="istats" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
        <div className="istat"><div className="l">🔩 เครื่อง / พื้นที่ในแผน</div><div className="v">{p.items.length}</div></div>
        <div className={`istat${p.items.some((i) => i.stat.over) ? ' hot' : ''}`}>
          <div className="l">⚠️ มีงานเกินกำหนด</div>
          <div className="v">{p.items.filter((i) => i.stat.over > 0).length}</div>
        </div>
        <div className="istat"><div className="l">🗓️ ครบกำหนดสัปดาห์นี้</div>
          <div className="v" style={{ color: 'var(--brand-deep)' }}>{dueThisWeek}</div></div>
        <div className="istat good"><div className="l">📈 ทำได้ตามแผน (ถึงวันนี้)</div>
          <div className="v">{overallDue ? Math.round((overall / overallDue) * 100) : '—'}<span className="u">%</span></div>
          <div className="den">{overall} จาก {overallDue} รอบที่ถึงกำหนด</div></div>
      </div>

      <div className="pcard" style={{ padding: '4px 4px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px 6px', flexWrap: 'wrap' }}>
          <h3 style={{ fontSize: 15 }}>แผน PM รายเครื่อง / พื้นที่</h3>
          <span className="chip mute">เรียงตามงานที่ค้างก่อน</span>
          <div className="sp" />
          <select className="isel" value={freq} onChange={(e) => setFreq(e.target.value)}>
            <option value="">ทุกความถี่</option>
            {freqs.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="tw2">
          <table className="tb">
            <thead>
              <tr>
                <th>เครื่อง / พื้นที่</th><th>PM ล่าสุด</th><th>ครบกำหนดถัดไป</th>
                <th className="num">ค้าง</th><th>ทำได้ตามแผน (ปี {p.year})</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => (
                <tr key={it.netId}>
                  <td>
                    <div className="mn">
                      <span className="mic">{iconOf(it.name)}</span>
                      <div>
                        <div className="t">{it.name}</div>
                        <div className="s">{it.freqLabel}{it.machine !== it.name ? ` · ทะเบียน: ${it.machine}` : ''}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ color: 'var(--ink-soft)' }}>{it.stat.lastDone ? shortDate(it.stat.lastDone) : '— ยังไม่เคยปิด'}</td>
                  <td>
                    {it.stat.nextWeek == null ? <span className="chip mute">หมดรอบปีนี้</span> : (
                      <span className={`chip ${it.stat.over ? 'stop' : 'due'}`}>
                        W{it.stat.nextWeek} · {it.stat.nextWeek === p.curWeek ? 'สัปดาห์นี้' : shortDate(it.stat.nextMonday)}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {it.stat.over
                      ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{it.stat.over}</span>
                      : <span style={{ color: 'var(--muted)' }}>0</span>}
                  </td>
                  <td style={{ width: 190 }}>
                    <div className="bar"><span style={{ width: `${it.stat.pct || 0}%`, background: pctColor(it.stat.pct) }} /></div>
                    <div className="bl">
                      {it.stat.done}/{it.stat.due} รอบที่ถึงกำหนด ·{' '}
                      <b style={{ color: pctColor(it.stat.pct) }}>{it.stat.pct == null ? '—' : `${it.stat.pct}%`}</b>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="ibtn sm" onClick={() => onPick(it.netId)}>🔧 งานย่อย ({it.jobs.length})</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

/* ══════════════ ④ ปฏิทินเดือน ══════════════ */
const MonthCalendar: React.FC<{ p: Plan; today: string }> = ({ p, today }) => {
  const [month, setMonth] = useState(() => (p.curYear === p.year ? monNum(today) : 0));
  const [openDay, setOpenDay] = useState('');   // วันที่กางดูครบทุกรายการอยู่
  // รอบที่ปิดแล้วลงตามวันที่ทำจริง · รอบที่ยังไม่ทำลงวันจันทร์ของสัปดาห์นั้น (แผนคิดเป็นสัปดาห์ ไม่ใช่วัน)
  const byDay = useMemo(() => {
    const m = new Map<string, { name: string; status: Cycle['status'] }[]>();
    for (const it of p.items) {
      for (const c of it.cycles) {
        const day = c.status === 'done' && c.doneDate ? c.doneDate : c.monday;
        if (!m.has(day)) m.set(day, []);
        m.get(day)!.push({ name: it.name, status: c.status });
      }
    }
    return m;
  }, [p.items]);

  const first = new Date(Date.UTC(p.year, month, 1));
  const daysInMonth = new Date(Date.UTC(p.year, month + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;                    // ช่องว่างก่อนวันที่ 1 (จ.=0)
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const key = (d: number) => `${p.year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  return (
    <div className="pcard" style={{ padding: '14px 16px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="ibtn" style={{ padding: '6px 12px' }} disabled={month === 0}
          onClick={() => setMonth(month - 1)}>‹</button>
        <h3 style={{ fontSize: 16 }}>{TH_MON_FULL[month]} {p.year}</h3>
        <button className="ibtn" style={{ padding: '6px 12px' }} disabled={month === 11}
          onClick={() => setMonth(month + 1)}>›</button>
        {p.curYear === p.year && month !== monNum(today) && (
          <button className="ibtn" onClick={() => setMonth(monNum(today))}>เดือนนี้</button>
        )}
        <div className="sp" />
        <span className="chip mute">รอบที่ยังไม่ปิด = วางไว้วันจันทร์ของสัปดาห์นั้น</span>
      </div>
      <div className="cal">
        <div className="dh" />
        {DAY_TH.map((d) => <div key={d} className="dh">{d}</div>)}
        {Array.from({ length: cells.length / 7 }, (_, row) => {
          const week = cells.slice(row * 7, row * 7 + 7);
          const firstDay = week.find((x) => x != null);
          return (
            <React.Fragment key={row}>
              <div className="wkn">{firstDay ? `W${weekNumOf(p, key(firstDay))}` : ''}</div>
              {week.map((d, i) => {
                if (d == null) return <div key={i} className="dc off" />;
                const evs = byDay.get(key(d)) || [];
                return (
                  <div key={i} className={`dc${key(d) === today ? ' today' : ''}`}>
                    <div className="dn">{d}{key(d) === today && <span className="tdy">วันนี้</span>}</div>
                    {(openDay === key(d) ? evs : evs.slice(0, 3)).map((e, j) => (
                      <div key={j} className={`ev${e.status === 'done' || e.status === 'skip' ? ' off' : ''}`}>
                        <i className={e.status === 'future' ? 'fut' : ''}
                          style={e.status === 'future' ? { border: '1.5px solid var(--sep)' } : { background: STATUS_COLOR[e.status] }} />
                        <span>{e.name}</span>
                      </div>
                    ))}
                    {evs.length > 3 && (
                      <button className="more" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={() => setOpenDay(openDay === key(d) ? '' : key(d))}>
                        {openDay === key(d) ? '▴ ย่อ' : `+${evs.length - 3} รายการ`}
                      </button>
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
// เลขสัปดาห์ ISO ของวันนั้น — หาจากรอบที่เซิร์ฟเวอร์ส่งมา (monday–sunday) ไม่ต้องคำนวณซ้ำฝั่งนี้
function weekNumOf(p: Plan, day: string): number | string {
  for (const it of p.items) {
    for (const c of it.cycles) if (day >= c.monday && day <= c.sunday) return c.week;
  }
  const d = new Date(`${day}T00:00:00Z`);
  const th = new Date(d); th.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan1 = new Date(Date.UTC(th.getUTCFullYear(), 0, 1));
  return Math.ceil((((th.getTime() - jan1.getTime()) / 86400000) + 1) / 7);
}

/* ══════════════ ⑤ สรุปผล — S-Curve + ตารางรายเครื่อง ══════════════ */
const SCurve: React.FC<{ s: Summary }> = ({ s }) => {
  const W = 1060; const H = 288; const L = 46; const R = 932; const TOP = 26; const BOT = 254;
  const x = (m: number) => L + ((R - L) * m) / 11;
  const y = (p: number) => BOT - ((BOT - TOP) * p) / 100;
  const plan = s.curve.map((c) => `${x(c.month).toFixed(1)},${y(c.plan).toFixed(1)}`).join(' ');
  const act = s.curve.filter((c) => c.actual != null);
  const actual = act.map((c) => `${x(c.month).toFixed(1)},${y(c.actual as number).toFixed(1)}`).join(' ');
  const gapPoly = act.length
    ? `${act.map((c) => `${x(c.month).toFixed(1)},${y(c.plan).toFixed(1)}`).join(' ')} ` +
      `${[...act].reverse().map((c) => `${x(c.month).toFixed(1)},${y(c.actual as number).toFixed(1)}`).join(' ')}`
    : '';
  const cm = s.curve[s.curMonth];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
      aria-label={`กราฟ S-Curve เทียบ % แผน PM สะสมกับผลจริงสะสมรายเดือน ปี ${s.year} คิดจากรอบทั้งปี ${s.total.active} รอบ`}>
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={L} y1={y(g)} x2={R} y2={y(g)} stroke="#eee3d9" strokeWidth="1" />
          <text x={L - 9} y={y(g) + 4} textAnchor="end" fontSize="10.5" fill="#a49a90">{g}%</text>
        </g>
      ))}
      {TH_MON.map((m, i) => (
        <text key={m} x={x(i)} y={276} textAnchor="middle" fontSize="10.5"
          fill={i === s.curMonth ? '#c24f00' : '#a49a90'} fontWeight={i === s.curMonth ? 700 : 400}>{m}</text>
      ))}
      {gapPoly && <polygon fill="rgba(255,107,0,.13)" points={gapPoly} />}
      {cm && (
        <line x1={x(s.curMonth)} y1={TOP} x2={x(s.curMonth)} y2={BOT} stroke="#c24f00"
          strokeWidth="1" strokeDasharray="3 4" opacity=".45" />
      )}
      <polyline points={plan} fill="none" stroke="#c24f00" strokeWidth="2" strokeDasharray="7 5" />
      {actual && <polyline points={actual} fill="none" stroke="#1565c0" strokeWidth="2" />}
      {s.curve.map((c) => <circle key={`p${c.month}`} cx={x(c.month)} cy={y(c.plan)} r="4" fill="#fff" stroke="#c24f00" strokeWidth="2" />)}
      {act.map((c) => <circle key={`a${c.month}`} cx={x(c.month)} cy={y(c.actual as number)} r="4" fill="#fff" stroke="#1565c0" strokeWidth="2" />)}
      {cm && cm.actual != null && (
        <g paintOrder="stroke" stroke="#faf7f4" strokeWidth="3.5" strokeLinejoin="round">
          <text x={x(s.curMonth) - 9} y={y(cm.plan) - 10} textAnchor="end" fontSize="11.5" fontWeight="700" fill="#c24f00">
            แผนถึงสิ้น {TH_MON[s.curMonth]} {Math.round(cm.plan)}%
          </text>
          <text x={x(s.curMonth) - 9} y={y(cm.actual) + 17} textAnchor="end" fontSize="11.5" fontWeight="700" fill="#1565c0">
            ทำจริง {Math.round(cm.actual)}%
          </text>
          {s.gap != null && (
            <text x={x(s.curMonth) + 9} y={(y(cm.plan) + y(cm.actual)) / 2} fontSize="11" fontWeight="700" fill="#c24f00">
              ตามหลัง {Math.round(s.gap)} จุด
            </text>
          )}
        </g>
      )}
      <text x={L} y={18} fontSize="10.5" fill="#a49a90">ทั้งสองเส้นคิดจากรอบทั้งปี {s.total.active} รอบ</text>
    </svg>
  );
};

const SummaryView: React.FC<{ s: Summary | null; p: Plan | null; loading: boolean }> = ({ s, p, loading }) => {
  if (!s) return <div className="pcard empty">{loading ? '⏳ กำลังโหลด…' : 'โหลดสรุปผลไม่สำเร็จ'}</div>;
  const t = s.total;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 0', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: 'var(--muted)', maxWidth: 620, lineHeight: 1.55 }}>
          แผนงาน PM ปี {s.year} · นับผลถึงสัปดาห์ที่ {p?.curWeek ?? '—'} ({TH_MON[s.curMonth] || '—'})
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 12, alignItems: 'start', margin: '14px 0' }}>
        <section>
          <h4 style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>แผนทั้งปี</h4>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div className="istat" style={{ minWidth: 132 }}>
              <div className="l">🗓️ รอบที่วางแผนไว้</div><div className="v">{t.active}<span className="u">รอบ</span></div>
            </div>
            <div className="istat" style={{ minWidth: 132 }}>
              <div className="l">🚫 ปิดใช้งาน (ไม่นับทั้งแผนและผล)</div>
              <div className="v" style={{ color: 'var(--muted)' }}>{t.skip}<span className="u">รอบ</span></div>
            </div>
          </div>
        </section>
        <section>
          <h4 style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
            ถึงวันนี้ (สัปดาห์ที่ {p?.curWeek ?? '—'})
          </h4>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div className="istat" style={{ minWidth: 132, flex: 1 }}>
              <div className="l">📆 ถึงกำหนดแล้ว</div><div className="v">{t.due}<span className="u">รอบ</span></div>
            </div>
            <div className="istat good" style={{ minWidth: 132, flex: 1 }}>
              <div className="l">✅ ทำเสร็จแล้ว</div><div className="v">{t.done}<span className="u">รอบ</span></div>
            </div>
            <div className={`istat${t.over ? ' hot' : ''}`} style={{ minWidth: 132, flex: 1 }}>
              <div className="l">⚠️ เลยกำหนด ยังไม่ทำ</div><div className="v">{t.over}<span className="u">รอบ</span></div>
            </div>
            <div className="istat big" style={{ flex: 1 }}>
              <div className="l">📈 ทำได้ตามแผนที่ถึงกำหนด</div>
              <div className="v" style={{ color: 'var(--cip1)' }}>
                {t.pctDue == null ? '—' : t.pctDue}<span className="u">%</span>
              </div>
              <div className="den">{t.done} จาก {t.due} รอบ</div>
            </div>
          </div>
        </section>
      </div>

      <div className="pcard" style={{ padding: '15px 18px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
          <div>
            <h3 style={{ fontSize: 15 }}>S-Curve — % แผน PM สะสม เทียบผลจริงสะสม</h3>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', maxWidth: 620, lineHeight: 1.55 }}>
              คนละตัวหารกับช่อง “ทำได้ตามแผนที่ถึงกำหนด” ข้างบน — กราฟนี้คิดจาก
              <b style={{ color: 'var(--ink-soft)' }}> รอบทั้งปี {t.active} รอบ</b> ส่วนช่องนั้นคิดจาก
              <b style={{ color: 'var(--ink-soft)' }}> รอบที่ถึงกำหนดแล้ว {t.due} รอบ</b>
            </div>
          </div>
          <div className="sp" />
          <div className="legend" style={{ margin: 0 }}>
            <span><i style={{ background: '#c24f00' }} />แผน (สะสม)</span>
            <span><i style={{ background: '#1565c0' }} />ผลจริง (สะสม)</span>
            <span><i style={{ background: 'rgba(255,107,0,.32)' }} />ช่องว่าง</span>
          </div>
        </div>
        <SCurve s={s} />
      </div>

      <div className="pcard" style={{ padding: '4px 4px 8px', marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px 4px', flexWrap: 'wrap' }}>
          <h3 style={{ fontSize: 15 }}>สรุปผล PM รายเครื่อง (ปี {s.year})</h3>
          <span className="chip mute">เรียงตัวที่ตกแผนมากสุดขึ้นก่อน</span>
        </div>
        <div className="tw2">
          <table className="tb">
            <thead>
              <tr>
                <th>เครื่อง / พื้นที่</th><th className="num">แผนทั้งปี</th><th className="num">ถึงกำหนดแล้ว</th>
                <th className="num">เสร็จ</th><th className="num">ค้าง</th><th>ความคืบหน้าถึงวันนี้</th><th className="num">%</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <tr key={r.netId} className={r.pct != null && r.pct < 90 ? 'bad' : ''}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td className="num">{r.active}</td>
                  <td className="num">{r.due}</td>
                  <td className="num" style={{ color: 'var(--ok)', fontWeight: 600 }}>{r.done}</td>
                  <td className="num">
                    {r.over ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{r.over}</span>
                      : <span style={{ color: 'var(--muted)' }}>0</span>}
                  </td>
                  <td style={{ width: 170 }}>
                    <div className="bar"><span style={{ width: `${r.pct || 0}%`, background: pctColor(r.pct) }} /></div>
                    <div className="bcap">{r.done} จาก {r.due} รอบที่ถึงกำหนด</div>
                  </td>
                  <td className="num" style={{ color: pctColor(r.pct), fontWeight: 700 }}>
                    {r.pct == null ? '—' : `${r.pct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

/* ══════════════ แผ่นรายละเอียดรายการ — ส่วนที่แก้ได้ ══════════════ */
const EVERY_OPTS = (step: number, cycles: number) => {
  const mk = (wk: number) => Math.min(Math.max(1, Math.round(wk / step)), Math.max(1, cycles));
  const out: { label: string; every: number }[] = [{ label: 'ทุกครั้ง', every: 1 }];
  for (const [label, wk] of [['ทุก 3 เดือน', 13], ['ทุก 6 เดือน', 26], ['ปีละครั้ง', 52]] as [string, number][]) {
    const e = mk(wk);
    if (e > 1 && !out.some((o) => o.every === e)) out.push({ label, every: e });
  }
  return out;
};

const JobSheet: React.FC<{
  it: Item; plan: Plan; canEdit: boolean; busy: boolean; onClose: () => void;
  onJobs: (body: Record<string, unknown>) => Promise<boolean>;
  onOwner: (owner: string) => Promise<boolean>;
}> = ({ it, plan, canEdit, busy, onClose, onJobs, onOwner }) => {
  const [typed, setTyped] = useState('');
  const [openMenu, setOpenMenu] = useState(false);
  const opts = EVERY_OPTS(it.step, it.weeks.length);
  const suggest = plan.jobRegistry
    .filter((r) => !it.jobs.some((j) => j.title === r.title))
    .filter((r) => !typed.trim() || r.title.includes(typed.trim()))
    .slice(0, 8);
  const add = async (title: string) => {
    if (!title.trim()) return;
    if (await onJobs({ action: 'add', netId: it.netId, title: title.trim(), every: 1 })) {
      setTyped(''); setOpenMenu(false);
    }
  };
  const everyCount = it.jobs.filter((j) => j.every === 1).length;
  // เลื่อนงานย่อยขึ้น 1 ขั้น แล้วส่งลำดับใหม่ทั้งชุดไปให้เซิร์ฟเวอร์เขียน sort_order
  const moveUp = (i: number) => {
    const ids = it.jobs.map((x) => x.id);
    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
    return onJobs({ action: 'reorder', netId: it.netId, ids });
  };

  return (
    <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <h3>🔧 รายละเอียดรายการ PM</h3>
            <div className="hint">{it.name} · แผนปี {plan.year}</div>
          </div>
          <button className="ibtn sm" onClick={onClose}>✕ ปิด</button>
        </div>

        <div className="rohead">
          <div className="rh-row">
            <div><span className="rh-l">เครื่อง / พื้นที่</span><div className="rh-v">{it.name}</div></div>
            <div><span className="rh-l">ความถี่</span><div className="rh-v">{it.freqLabel}</div></div>
            <div><span className="rh-l">รอบต่อปี</span><div className="rh-v">{it.weeks.length} รอบ</div></div>
            <div><span className="rh-l">รหัสในแอปทีมช่าง</span><div className="rh-v mono">{it.netId}</div></div>
            <div style={{ flex: 1 }} />
            <a className="ibtn sm ext" href={plan.netlifyUrl} target="_blank" rel="noopener noreferrer">
              ↗ แก้แผนที่แอปทีมช่าง
            </a>
          </div>
          <div className="rh-note">🔒 ชื่อ · ความถี่ · สัปดาห์ที่ครบกำหนด ดึงมาจากแอปทีมช่าง — แก้ที่นี่ไม่ได้</div>
        </div>

        <div className="fld">
          <label>ผู้รับผิดชอบตั้งต้น<span className="tagedit">✏️ แก้ได้ในแอปนี้</span></label>
          <select className="isel" style={{ width: '100%' }} value={it.owner} disabled={!canEdit || busy}
            onChange={(e) => onOwner(e.target.value)}>
            <option value="">— ยังไม่มอบหมาย —</option>
            {plan.people.map((p) => <option key={p.key} value={p.name}>{p.name}</option>)}
            {it.owner && !plan.people.some((p) => p.name === it.owner) && <option value={it.owner}>{it.owner}</option>}
          </select>
        </div>

        <div className="fld jbox">
          <label>
            รายการงานที่ต้องทำของเครื่องนี้ ({it.jobs.length})
            <span className="tagedit">✏️ แก้ได้ในแอปนี้</span>
            {canEdit && <span className="tagnew">เลือกจากลิสต์ได้ · พิมพ์ชื่อใหม่ได้</span>}
          </label>
          <div className="jhead"><span>ชื่องาน</span><span>ทำบ่อยแค่ไหน</span><span /><span /></div>
          <div className="jlist">
            {it.jobs.map((j, i) => (
              <div className="jrow" key={j.id}>
                <button className="grip" title="เลื่อนขึ้น" disabled={!canEdit || busy || i === 0}
                  onClick={() => moveUp(i)}>⠿</button>
                <input className="jname" defaultValue={j.title} readOnly={!canEdit} disabled={busy}
                  onBlur={(e) => { if (canEdit && e.target.value.trim() !== j.title) onJobs({ action: 'update', id: j.id, title: e.target.value }); }} />
                <select className="jfreq" value={j.every} disabled={!canEdit || busy}
                  onChange={(e) => onJobs({ action: 'update', id: j.id, every: Number(e.target.value) })}>
                  {opts.map((o) => <option key={o.every} value={o.every}>{o.label}</option>)}
                  {!opts.some((o) => o.every === j.every) && <option value={j.every}>{j.freqLabel}</option>}
                </select>
                <span className="jtimes">ปีละ {j.weeks.length} ครั้ง</span>
                <button className="jdel" title="ลบรายการนี้" disabled={!canEdit || busy}
                  onClick={() => { if (window.confirm(`ลบ "${j.title}" ออกจาก ${it.name}?`)) onJobs({ action: 'delete', id: j.id }); }}>🗑</button>
              </div>
            ))}
            {it.jobs.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '4px 2px' }}>
                ยังไม่มีลิสต์งานย่อย — ช่างไปถึงเครื่องแล้วจะไม่รู้ว่าต้องทำอะไรบ้าง
              </div>
            )}
          </div>

          {canEdit && (
            <div className="combo">
              <input className="cin" value={typed} placeholder="＋ เพิ่มรายการงาน — พิมพ์ชื่อใหม่ หรือเลือกจากทะเบียน"
                disabled={busy} onFocus={() => setOpenMenu(true)} onChange={(e) => { setTyped(e.target.value); setOpenMenu(true); }}
                onKeyDown={(e) => { if (e.key === 'Enter') add(typed); if (e.key === 'Escape') setOpenMenu(false); }} />
              <button className="cbtn" onClick={() => setOpenMenu(!openMenu)}>{openMenu ? '▴' : '▾'}</button>
              {openMenu && (suggest.length > 0 || typed.trim()) && (
                <div className="menu">
                  <div className="mhead"><span>ทะเบียนรายการงาน PM</span><span>{plan.jobRegistry.length}</span></div>
                  {suggest.map((r) => (
                    <button className="opt" key={r.title} onClick={() => add(r.title)}>
                      <span className="ot">{r.title}</span>
                      <span className="os">ใช้อยู่ {r.uses} เครื่อง</span>
                    </button>
                  ))}
                  {typed.trim() && !suggest.some((r) => r.title === typed.trim()) && (
                    <button className="opt new" onClick={() => add(typed)}>
                      <span>
                        <span className="ot">＋ ใช้ชื่อใหม่ “{typed.trim()}”</span>
                        <span className="os" style={{ display: 'block' }}>บันทึกเข้าทะเบียนรายการงาน PM ให้เลือกครั้งหน้าอัตโนมัติ</span>
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="infobox" style={{ marginTop: 10 }}>
            เครื่องนี้ทำ <b>{it.weeks.length} รอบ/ปี</b> — ไปครั้งหนึ่งช่างได้ <b>{everyCount} ข้อที่ทำทุกครั้ง</b>
            {it.jobs.filter((j) => j.every > 1).map((j) => ` · “${j.title}” ปีละ ${j.weeks.length} ครั้ง`).join('')}
            <div style={{ marginTop: 3, color: 'var(--muted)' }}>
              ตั้งให้ถี่กว่ารอบของเครื่องไม่ได้ — ถ้าต้องทำถี่กว่านี้ ให้ปรับความถี่ของเครื่องที่แอปทีมช่างแทน
            </div>
          </div>
        </div>

        {!canEdit && (
          <div className="warnbox" style={{ marginBottom: 0 }}>
            🔒 แก้ลิสต์งานย่อยและผู้รับผิดชอบได้เฉพาะหัวหน้างานขึ้นไป — เข้าหน้าผู้ดูแลด้วยบัญชีที่มีสิทธิ์ก่อน
          </div>
        )}
      </div>
    </div>
  );
};

/* ══════════════ ตัวอย่างข้อความที่จะเข้ากลุ่มช่าง ══════════════
   ดูก่อนได้ว่าจันทร์เช้า/ศุกร์บ่ายกลุ่มจะเห็นอะไร แล้วค่อยกดส่งจริง
   (กดดูไม่ส่ง — ปุ่มส่งแยกต่างหาก จะได้ไม่เผลอยิงเข้ากลุ่มตอนลองเล่น) */
const NotifySheet: React.FC<{
  busy: boolean; onClose: () => void;
  onLoad: (kind: 'open' | 'chase') => Promise<{ preview?: string; message?: string } | null>;
  onSend: (kind: 'open' | 'chase') => Promise<boolean>;
}> = ({ busy, onClose, onLoad, onSend }) => {
  const [kind, setKind] = useState<'open' | 'chase'>('open');
  const [res, setRes] = useState<{ kind: string; text: string; note: string } | null>(null);
  const [sent, setSent] = useState('');
  useEffect(() => {
    let alive = true;
    onLoad(kind).then((r) => {
      if (alive) {
        setRes({ kind, text: r?.preview || '', note: r?.preview ? '' : (r?.message || 'โหลดตัวอย่างไม่สำเร็จ') });
      }
    });
    return () => { alive = false; };
  }, [kind, onLoad]);
  const cur = res && res.kind === kind ? res : null;   // ผลของ kind อื่น = ยังไม่ใช่ของรอบนี้
  const text = cur?.text || '';
  return (
    <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <h3>📮 ข้อความที่จะเข้ากลุ่มช่าง</h3>
            <div className="hint">ส่งอัตโนมัติ จันทร์ 08:00 และ ศุกร์ 16:00 · เปิด/ปิดสวิตช์ได้ที่ตั้งค่ารายงาน</div>
          </div>
          <button className="ibtn sm" onClick={onClose}>✕ ปิด</button>
        </div>
        <div className="rngs" style={{ marginBottom: 10 }}>
          <button className={`rng${kind === 'open' ? ' on' : ''}`}
            onClick={() => { setKind('open'); setSent(''); }}>จันทร์เช้า — เปิดสัปดาห์</button>
          <button className={`rng${kind === 'chase' ? ' on' : ''}`}
            onClick={() => { setKind('chase'); setSent(''); }}>ศุกร์บ่าย — ตามที่ยังไม่ปิด</button>
        </div>
        {text
          ? <div className="notifyprev" dangerouslySetInnerHTML={{ __html: text.replace(/\n/g, '<br/>') }} />
          : <div className="infobox">{cur ? cur.note : '⏳ กำลังโหลด…'}</div>}
        <div className="acts">
          <button className="ibtn pri" disabled={busy || !text}
            onClick={() => onSend(kind).then((ok) => setSent(ok ? '✅ ส่งเข้ากลุ่มช่างแล้ว' : ''))}>
            📤 ส่งเข้ากลุ่มจริงเดี๋ยวนี้
          </button>
          {sent && <span style={{ fontSize: 12.5, color: 'var(--ok)', fontWeight: 600 }}>{sent}</span>}
          <div className="sp" />
          <span className="ro-note">กดดูเฉย ๆ ไม่ส่ง · การส่งทดสอบไม่กระทบรอบส่งอัตโนมัติ</span>
        </div>
      </div>
    </div>
  );
};

/* ══════════════ ตัวหลัก ══════════════ */
type View = 'week' | 'year' | 'machine' | 'month';

const PmPlan: React.FC<{
  tab: 'plan' | 'sum'; today: string; onCounts?: (n: number) => void; onNewAdhoc?: () => void;
}> = ({ tab, today, onCounts, onNewAdhoc }) => {
    const [year, setYear] = useState(() => Number(today.slice(0, 4)));
    const [view, setView] = useState<View>('week');
    const [plan, setPlan] = useState<Plan | null>(null);
    const [weekNo, setWeekNo] = useState<number | null>(null);
    const [weekData, setWeekData] = useState<WeekData | null>(null);
    const [summary, setSummary] = useState<Summary | null>(null);
    const [loading, setLoading] = useState(false);
    const [wkLoading, setWkLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');
    const [sheet, setSheet] = useState('');
    const [notifyOpen, setNotifyOpen] = useState(false);
    const canEdit = authRole() === 'supervisor' || authRole() === 'admin';

    const loadPlan = useCallback(async () => {
      setLoading(true);
      try {
        const d = await fetch(`${apiUrl}/api/maint/pm/plan?year=${year}`).then((r) => r.json());
        setPlan(Array.isArray(d?.items) ? d : null);
      } catch { setPlan(null); } finally { setLoading(false); }
    }, [year]);

    const loadWeek = useCallback(async () => {
      setWkLoading(true);
      try {
        const q = weekNo ? `&week=${weekNo}` : '';
        const d = await fetch(`${apiUrl}/api/maint/pm/week?year=${year}${q}`).then((r) => r.json());
        setWeekData(Array.isArray(d?.thisWeek) ? d : null);
      } catch { setWeekData(null); } finally { setWkLoading(false); }
    }, [year, weekNo]);

    const loadSummary = useCallback(async () => {
      try {
        const d = await fetch(`${apiUrl}/api/maint/pm/summary?year=${year}`).then((r) => r.json());
        setSummary(d?.total ? d : null);
      } catch { setSummary(null); }
    }, [year]);

    useEffect(() => { loadPlan(); }, [loadPlan]);
    useEffect(() => { loadWeek(); }, [loadWeek]);
    useEffect(() => { if (tab === 'sum') loadSummary(); }, [tab, loadSummary]);
    useEffect(() => {
      if (weekData && onCounts) onCounts(weekData.stat.left + weekData.stat.late);
    }, [weekData, onCounts]);

    const post = async (url: string, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const r = await fetch(`${apiUrl}${url}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setMsg(`❌ ${d.error || 'บันทึกไม่สำเร็จ'}`); return false; }
        setMsg('');
        await loadPlan();
        return true;
      } catch { setMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); return false; } finally { setBusy(false); }
    };

    const loadNotify = useCallback(async (kind: 'open' | 'chase') => {
      try {
        const r = await fetch(`${apiUrl}/api/maint/pm/notify-test`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ kind, preview: true }),
        });
        return await r.json();
      } catch { return null; }
    }, []);

    const doSync = async () => {
      setBusy(true); setMsg('');
      try {
        const r = await fetch(`${apiUrl}/api/maint/pm/sync`, { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) setMsg(`❌ ${d.error || 'ดึงข้อมูลไม่สำเร็จ'}`);
        else setMsg(`✅ ดึงจากแอปทีมช่างแล้ว — แผน ${d.items} รายการ · ปิดงาน ${d.done} · ปิดรอบ ${d.skip}`);
        await Promise.all([loadPlan(), loadWeek(), tab === 'sum' ? loadSummary() : Promise.resolve()]);
      } catch { setMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); } finally { setBusy(false); }
    };

    const item = plan?.items.find((i) => i.netId === sheet) || null;
    const years = Array.from(new Set([year, Number(today.slice(0, 4)), Number(today.slice(0, 4)) - 1])).sort((a, b) => b - a);

    if (tab === 'sum') {
      return (
        <div>
          {msg && <div className={msg.startsWith('✅') ? 'infobox' : 'errbox'}>{msg}</div>}
          <SummaryView s={summary} p={plan} loading={loading} />
        </div>
      );
    }

    return (
      <div>
        <div className="ifilters">
          {([['week', '🗓️ สัปดาห์นี้'], ['year', '📊 ตารางทั้งปี'], ['machine', '🔩 ตามเครื่องจักร'], ['month', '📆 ปฏิทินเดือน']] as [View, string][])
            .map(([k, t]) => (
              <button key={k} className={`ipill${view === k ? ' on brand' : ''}`} onClick={() => setView(k)}>{t}</button>
            ))}
          <div className="divider" />
          <select className="isel" value={year} onChange={(e) => { setYear(Number(e.target.value)); setWeekNo(null); }}>
            {years.map((y) => <option key={y} value={y}>ปี {y} (ISO Week)</option>)}
          </select>
          <button className="ibtn" onClick={doSync} disabled={busy}>
            {busy ? '⏳ กำลังดึง…' : '🔄 ดึงจากแอปทีมช่างเดี๋ยวนี้'}
          </button>
          {canEdit && (
            <button className="ibtn" onClick={() => setNotifyOpen(true)}>📮 ข้อความแจ้งเตือนกลุ่มช่าง</button>
          )}
        </div>

        {msg && <div className={msg.startsWith('✅') ? 'infobox' : 'errbox'} style={{ marginBottom: 12 }}>{msg}</div>}

        {!plan && !loading && (
          <div className="pcard empty">
            ยังไม่มีแผน PM ในระบบ — กด <b>🔄 ดึงจากแอปทีมช่างเดี๋ยวนี้</b> ข้างบน
            <br />(ปกติระบบดึงเองชั่วโมงละครั้ง)
          </div>
        )}

        {plan && (
          <>
            {view === 'week' && (
              <>
                <SyncBar url={plan.netlifyUrl} at={plan.syncedAt}
                  text={<>แผนและผลปิดงาน <b>ดึงมาจากแอปทีมช่าง (Netlify)</b> — หน้านี้อ่านอย่างเดียว</>} />
                <div style={{ height: 2 }} />
                <WeekView d={weekData} loading={wkLoading} onNewAdhoc={() => onNewAdhoc?.()}
                  onWeek={(w) => setWeekNo(w)} onToday={() => setWeekNo(null)} />
              </>
            )}
            {view === 'year' && <YearGrid p={plan} onPick={setSheet} />}
            {view === 'machine' && <ByMachine p={plan} onPick={setSheet} />}
            {view === 'month' && <MonthCalendar p={plan} today={today} />}
          </>
        )}

        {notifyOpen && (
          <NotifySheet busy={busy} onClose={() => setNotifyOpen(false)} onLoad={loadNotify}
            onSend={async (kind) => {
              const ok = await post('/api/maint/pm/notify-test', { kind });
              if (ok) setMsg('✅ ส่งข้อความแจ้งเตือนเข้ากลุ่มช่างแล้ว');
              return ok;
            }} />
        )}

        {item && plan && (
          <JobSheet it={item} plan={plan} canEdit={canEdit} busy={busy} onClose={() => setSheet('')}
            onJobs={(b) => post('/api/maint/pm/jobs', b)}
            onOwner={(o) => post('/api/maint/pm/owner', { netId: item.netId, owner: o })} />
        )}
      </div>
    );
  };

export default PmPlan;
