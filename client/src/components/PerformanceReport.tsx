import React, { useCallback, useEffect, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/* ── 4-f เทียบประสิทธิภาพรายคน / รายกะ ──────────────────────────────────────
   GET /api/perf/summary?from&to → สรุปมาให้ครบแล้ว หน้านี้แค่วาด
   3 มุม: งานประจำรายคน · ยอดผลิต-CIP แยกตามกะ · เวลาต่อรอบ CIP เทียบค่ากลาง   */

type Trend = { first: number; last: number; delta: number; dir: 'up' | 'down' | 'flat' } | null;
type DayRow = { date: string; done: number; total: number; pct: number | null; bypassed: number; adhoc: number };
type Person = {
  key: string; name: string; role: string; dot: string; color: string;
  done: number; total: number; pct: number | null;
  daysCounted: number; daysWorked: number; full: number; zero: number;
  bypassed: number; received: number; receivedDone: number;
  adhoc: number; adhocDone: number; routineNodes: number;
  trend: Trend; days: DayRow[];
  best: { date: string; pct: number } | null;
  worst: { date: string; pct: number } | null;
};
type ShiftRow = {
  shift: string; batches: number; cipRounds: number; ticks: number; days: number; perDay: number | null;
  topLine: { line: string; n: number } | null;
  topFlavor: { flavor: string; n: number } | null;
};
type Grp = { name: string; n: number; median: number | null; avg: number; min: number; max: number; vsMedian: number | null };
type Round = { line: string; operator: string; item: string; day: string; at: string; shift: string; minutes: number; backwash: boolean };
type OpRow = { name: string; batches: number; days: number; perDay: number | null; shifts: Record<string, number>; cipRounds: number; crew: string };
type CrewRow = { crew: string; batches: number; cipRounds: number; days: number; perDay: number | null; people: { name: string; n: number }[] };
type Report = {
  from: string; to: string; countedDays: number; firstDay: string; lastDay: string;
  people: Person[]; team: { done: number; total: number; pct: number | null };
  shifts: ShiftRow[]; operators: OpRow[];
  crews: CrewRow[]; crewUnlinked: { batches: number; people: { name: string; n: number }[] };
  cip: {
    rounds: Round[]; count: number; sessions: number; openCount: number;
    open: { line: string; operator: string; day: string; at: string }[];
    median: number | null; avg: number | null; byOperator: Grp[]; byLine: Grp[]; thin: boolean;
  };
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
  padding: '6px 10px', fontSize: 13, fontWeight: 500, color: 'var(--ink,#2b2119)', fontFamily: 'inherit',
};
const th: React.CSSProperties = {
  textAlign: 'right', fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)',
  padding: '6px 8px', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { textAlign: 'right', fontSize: 13, padding: '8px', whiteSpace: 'nowrap' };
const soft = 'var(--ink-soft,#6d6259)';
const kanit = 'Kanit, sans-serif';
const ARROW: Record<string, string> = { up: '↗', down: '↘', flat: '→' };

const pctColor = (p: number | null) => (p == null ? soft : p >= 90 ? '#3f7d3a' : p >= 70 ? '#c24f00' : '#c62828');
const mins = (m: number | null) => {
  if (m == null) return '—';
  const r = Math.round(m);                                   // นาทีเศษ ๆ ไม่ต้องโชว์ทศนิยม
  return r >= 60 ? `${Math.floor(r / 60)} ชม. ${r % 60 ? `${r % 60} น.` : ''}`.trim() : `${r} น.`;
};
const dayShort = (d: string) => (d || '').slice(5).replace('-', '/');

/* แถบเล็ก ๆ รายวันของคนหนึ่ง — สูงตาม % ของวันนั้น (เทาจาง = วันที่ไม่มีงานให้ทำ) */
const Spark: React.FC<{ days: DayRow[] }> = ({ days }) => (
  <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 30 }}>
    {days.map(d => (
      <div key={d.date} title={`${d.date} · ${d.pct == null ? 'ไม่มีงาน' : `${d.pct}%`} (${d.done}/${d.total})`}
        style={{
          flex: '1 0 4px', minWidth: 4, height: `${d.pct == null ? 6 : Math.max(6, d.pct)}%`,
          borderRadius: '2px 2px 0 0', background: d.pct == null ? '#eee3d9' : pctColor(d.pct), opacity: d.pct == null ? 1 : .85,
        }} />
    ))}
  </div>
);

const PerformanceReport: React.FC = () => {
  const [to, setTo] = useState(todayBKK());
  const [from, setFrom] = useState(shiftDay(todayBKK(), -29));
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch(`${apiUrl}/api/perf/summary?from=${from}&to=${to}`).then(r => r.json());
      setData(d && Array.isArray(d.people) ? d : null);
    } catch { setData(null); } finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const preset = (days: number) => { const t = todayBKK(); setTo(t); setFrom(shiftDay(t, -(days - 1))); };
  const thisMonth = () => { const t = todayBKK(); setTo(t); setFrom(`${t.slice(0, 7)}-01`); };

  const cip = data?.cip;
  const topShift = (data?.shifts || []).slice().sort((a, b) => b.batches - a.batches)[0];
  const bestPerson = (data?.people || []).find(p => p.pct != null);

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: kanit, fontSize: 11.5, fontWeight: 600, color: '#c24f00',
        background: '#fff3ea', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>👥 ประสิทธิภาพ</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: kanit, fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          เทียบประสิทธิภาพ รายคน / รายกะ
        </h1>
        <span style={{ fontSize: 13, color: soft }}>งานประจำรายคน · ยอดผลิตแยกกะ · เวลาที่ใช้ต่อรอบ CIP</span>
      </div>

      {/* ── ช่วงเวลา ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <button onClick={() => preset(30)} style={btn}>30 วันล่าสุด</button>
        <button onClick={() => preset(90)} style={btn}>90 วัน</button>
        <button onClick={thisMonth} style={btn}>เดือนนี้</button>
        <span style={{ width: 1, height: 22, background: 'var(--line,#eee3d9)' }} />
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        <span style={{ fontSize: 13, color: soft }}>ถึง</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        <button onClick={load} style={btn}>{loading ? '⏳' : '🔄'} รีเฟรช</button>
      </div>

      {/* ── ตัวเลขรวม ── */}
      {data && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', marginBottom: 14 }}>
          {([
            ['งานประจำทั้งทีม', data.team.pct == null ? '—' : `${data.team.pct}%`,
              `${data.team.done}/${data.team.total} งาน · ${data.countedDays} วันที่มีการใช้งาน`],
            ['ทำได้ดีสุด', bestPerson ? bestPerson.name : '—',
              bestPerson ? `${bestPerson.pct}% · ปิดครบ ${bestPerson.full} วัน` : 'ยังไม่มีข้อมูลงานประจำ'],
            ['กะที่ผลิตมากสุด', topShift && topShift.batches ? `กะ${topShift.shift}` : '—',
              topShift && topShift.batches ? `${topShift.batches} batch · เฉลี่ย ${topShift.perDay}/วัน` : ''],
            ['เวลาต่อรอบ CIP (ค่ากลาง)', cip && cip.median != null ? mins(cip.median) : '—',
              cip && cip.count ? `จาก ${cip.count} รอบที่กดจบครบ` : 'ยังไม่มีรอบที่กดจบครบ'],
          ] as [string, string, string][]).map(([k, v, sub]) => (
            <div key={k} style={{ ...card, padding: '12px 16px' }}>
              <div style={{ fontSize: 11.5, color: soft, fontWeight: 600 }}>{k}</div>
              <div style={{ fontFamily: kanit, fontSize: 20, fontWeight: 600, color: '#c24f00', lineHeight: 1.35, wordBreak: 'break-word' }}>{v}</div>
              {sub && <div style={{ fontSize: 11.5, color: soft }}>{sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* ── รายคน ── */}
      <div style={{ ...card, padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ fontFamily: kanit, fontSize: 15, fontWeight: 600, marginBottom: 2 }}>งานประจำรายคน</div>
        <div style={{ fontSize: 11.5, color: soft, marginBottom: 10 }}>
          นับเฉพาะ <b>วันที่มีคนใช้ระบบจริง</b> ({data ? data.countedDays : 0} วัน{data && data.firstDay ? ` · ${dayShort(data.firstDay)}–${dayShort(data.lastDay)}` : ''})
          — วันที่ไม่มีใครแตะเลยไม่ถูกนับเป็น 0% · งานที่ <b>ข้าม</b> ไว้ถูกตัดออกจากตัวหาร งานที่ <b>รับมาจากคนอื่น</b> บวกเพิ่มให้คนรับ
        </div>
        {!data || data.people.length === 0
          ? <div style={{ fontSize: 13, color: '#a89e94', padding: '8px 0' }}>ยังไม่มีคนในกระดานงานประจำ</div>
          : (
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
              {data.people.map(p => (
                <div key={p.key} style={{ background: '#fbf7f3', borderRadius: 12, padding: '11px 13px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                    <span style={{ fontSize: 14 }}>{p.dot}</span>
                    <b style={{ fontFamily: kanit, fontSize: 15 }}>{p.name}</b>
                    <span style={{ marginLeft: 'auto', fontFamily: kanit, fontSize: 19, fontWeight: 700, color: pctColor(p.pct) }}>
                      {p.pct == null ? '—' : `${p.pct}%`}
                    </span>
                    {p.trend && p.trend.dir !== 'flat' && (
                      <span title={`ครึ่งแรก ${p.trend.first}% → ครึ่งหลัง ${p.trend.last}%`}
                        style={{ fontSize: 12.5, fontWeight: 700, color: p.trend.dir === 'up' ? '#3f7d3a' : '#c62828' }}>
                        {ARROW[p.trend.dir]}{p.trend.delta > 0 ? '+' : ''}{p.trend.delta}
                      </span>
                    )}
                  </div>
                  {p.role && <div style={{ fontSize: 11, color: soft, marginBottom: 6 }}>{p.role}</div>}
                  <div style={{ height: 7, borderRadius: 999, background: '#f2ece6', marginBottom: 8 }}>
                    <i style={{ display: 'block', height: '100%', width: `${p.pct || 0}%`, borderRadius: 999, background: `linear-gradient(90deg,${pctColor(p.pct)},#ffa34d)` }} />
                  </div>
                  <Spark days={p.days} />
                  <div style={{ fontSize: 11.5, color: soft, lineHeight: 1.75, marginTop: 6 }}>
                    {p.total > 0
                      ? <>ทำได้ <b style={{ color: 'var(--ink,#2b2119)' }}>{p.done}/{p.total}</b> งาน · ปิดครบ {p.full} วัน{p.zero > 0 && <> · ไม่ได้ติ๊กเลย {p.zero} วัน</>}</>
                      : <>ไม่มีงานประจำในเช็กลิสต์ (รับเฉพาะงานมอบหมาย)</>}
                    {(p.bypassed > 0 || p.received > 0) && (
                      <><br />{[
                        p.bypassed > 0 ? `ข้าม/มอบต่อ ${p.bypassed}` : '',
                        p.received > 0 ? `รับมาจากคนอื่น ${p.receivedDone}/${p.received}` : '',
                      ].filter(Boolean).join(' · ')}</>
                    )}
                    {p.adhoc > 0 && <><br />งานมอบหมาย {p.adhocDone}/{p.adhoc}</>}
                    {p.worst && <><br />วันที่ตกสุด {dayShort(p.worst.date)} ({p.worst.pct}%)</>}
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>

      {/* ── รายกะ ── */}
      <div style={{ ...card, padding: '14px 16px', marginBottom: 14, overflowX: 'auto' }}>
        <div style={{ fontFamily: kanit, fontSize: 15, fontWeight: 600, marginBottom: 2 }}>รายกะ</div>
        <div style={{ fontSize: 11.5, color: soft, marginBottom: 10 }}>
          แบ่งตาม <b>เวลาที่เกิดเรื่อง</b> (ตามตารางกะโรงงาน จ–พฤ 3 กะ · ศ–อา 2 กะ) —
          ไม่ใช่ว่าทีมกะไหนเป็นคนทำ เพราะระบบยังไม่ได้เก็บว่าใครอยู่กะไหนในแต่ละวัน
        </div>
        {!data || data.shifts.length === 0
          ? <div style={{ fontSize: 13, color: '#a89e94', padding: '8px 0' }}>ยังไม่มีความเคลื่อนไหวในช่วงนี้</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line,#eee3d9)' }}>
                  <th style={{ ...th, textAlign: 'left' }}>กะ</th>
                  <th style={th}>ผลิต (batch)</th>
                  <th style={th}>เฉลี่ย/วัน</th>
                  <th style={th}>รอบ CIP</th>
                  <th style={th}>ติ๊กงานประจำ</th>
                  <th style={{ ...th, textAlign: 'left' }}>ไลน์ / รสที่มากสุด</th>
                </tr>
              </thead>
              <tbody>
                {data.shifts.map(s => (
                  <tr key={s.shift} style={{ borderBottom: '1px solid #f6efe8' }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>กะ{s.shift}
                      <div style={{ fontSize: 11, color: soft, fontWeight: 400 }}>{s.days} วันที่มีงาน</div>
                    </td>
                    <td style={{ ...td, fontWeight: 700, color: '#c24f00' }}>{s.batches}</td>
                    <td style={td}>{s.perDay ?? '—'}</td>
                    <td style={td}>{s.cipRounds || '—'}</td>
                    <td style={td}>{s.ticks || '—'}</td>
                    <td style={{ ...td, textAlign: 'left', fontSize: 12, color: soft, whiteSpace: 'normal' }}>
                      {s.topLine ? `${s.topLine.line} (${s.topLine.n})` : '—'}
                      {s.topFlavor && <> · {s.topFlavor.flavor} ({s.topFlavor.n})</>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* ── ผลงานรายทีมกะจริง (ผูกจากบัญชีผู้ใช้ ไม่ใช่เวลา) ── */}
      {data && (data.crews.length > 0 || data.crewUnlinked.batches > 0) && (
        <div style={{ ...card, padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ fontFamily: kanit, fontSize: 15, fontWeight: 600, marginBottom: 2 }}>ผลงานรายทีมกะ</div>
          <div style={{ fontSize: 11.5, color: soft, marginBottom: 10 }}>
            อันนี้คือ <b>ทีมกะไหนเป็นคนทำจริง</b> — ดูจากทีมของคนที่ลงยอด (ผูกไว้ที่หน้า <b>ผู้ใช้และสิทธิ์</b>)
            ไม่ใช่เวลาที่ลงเหมือนตารางข้างบน
          </div>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))' }}>
            {data.crews.map(c => (
              <div key={c.crew} style={{ background: '#fbf7f3', borderRadius: 12, padding: '10px 12px' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.crew}</div>
                <div style={{ fontFamily: kanit, fontSize: 18, fontWeight: 600, color: '#c24f00' }}>
                  {c.batches} batch
                  {c.perDay != null && <span style={{ fontSize: 12, color: soft, fontWeight: 500 }}> ({c.perDay}/วัน)</span>}
                </div>
                <div style={{ fontSize: 11.5, color: soft, lineHeight: 1.6 }}>
                  {c.days} วันที่มีงาน{c.cipRounds > 0 && <> · CIP {c.cipRounds} รอบ</>}
                  <br />{c.people.map(p => `${p.name} (${p.n})`).join(' · ')}
                </div>
              </div>
            ))}
          </div>
          {data.crewUnlinked.batches > 0 && (
            <div style={{ fontSize: 12, color: '#a15c00', marginTop: 10, lineHeight: 1.7 }}>
              ⚠️ อีก {data.crewUnlinked.batches} batch ยังไม่รู้ว่าเป็นของทีมไหน เพราะคนที่ลงยังไม่ได้ผูกทีมกะ:
              {' '}{data.crewUnlinked.people.map(p => `${p.name} (${p.n})`).join(' · ')}
              <br />ไปผูกได้ที่หน้า <b>ผู้ใช้และสิทธิ์</b> → เลือกทีมกะให้คนนั้น
            </div>
          )}
        </div>
      )}

      {/* ── เวลาต่อรอบ CIP ── */}
      <div style={{ ...card, padding: '14px 16px', marginBottom: 14, overflowX: 'auto' }}>
        <div style={{ fontFamily: kanit, fontSize: 15, fontWeight: 600, marginBottom: 2 }}>เวลาที่ใช้ต่อรอบ CIP</div>
        <div style={{ fontSize: 11.5, color: soft, marginBottom: 10 }}>
          เทียบกับ <b>ค่ากลาง (median)</b> ของทุกรอบในช่วงนี้ ไม่ใช่ค่าเฉลี่ย — รอบที่ทิ้งไว้นานผิดปกติจะดึงค่าเฉลี่ยเพี้ยน
          {cip && cip.median != null && <> · ค่ากลางตอนนี้ = <b>{mins(cip.median)}</b> (เฉลี่ย {mins(cip.avg)})</>}
        </div>

        {cip && cip.thin && cip.count > 0 && (
          <div style={{ background: '#fffaf0', border: '1px solid #f0dcc0', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, color: '#a15c00', marginBottom: 10 }}>
            ⚠️ มีแค่ {cip.count} รอบในช่วงนี้ — <b>ยังน้อยเกินกว่าจะสรุปว่าใครเร็วใครช้า</b> ดูเป็นแนวโน้มคร่าว ๆ พอ
          </div>
        )}
        {cip && cip.openCount > 0 && (
          <div style={{ background: '#fdecea', border: '1px solid #f2c4bc', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, color: '#b3261e', marginBottom: 10 }}>
            🔴 มี {cip.openCount} รอบที่กดเริ่มแล้วไม่ได้กดจบ — รอบพวกนี้คิดเวลาไม่ได้ จึงไม่ถูกนับในตัวเลขข้างบน
            <div style={{ fontSize: 11.5, color: soft, marginTop: 3 }}>
              {cip.open.slice(0, 4).map((o, i) => <span key={i}>{i ? ' · ' : ''}{o.line} {o.day} {o.operator}</span>)}
            </div>
          </div>
        )}

        {!cip || cip.count === 0
          ? <div style={{ fontSize: 13, color: '#a89e94', padding: '8px 0', lineHeight: 1.7 }}>
              ยังไม่มีรอบ CIP ที่กดเริ่ม–จบครบในช่วงนี้
              <br />เวลาต่อรอบมาจากหน้า <b>CIP Line 1/2/3</b> ตอนกดเริ่มและกดจบแต่ละแถว
            </div>
          : (
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
              {([['รายคน', cip.byOperator], ['รายไลน์', cip.byLine]] as [string, Grp[]][]).map(([label, list]) => (
                <div key={label}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: soft, marginBottom: 6 }}>{label}</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--line,#eee3d9)' }}>
                        <th style={{ ...th, textAlign: 'left' }}>{label === 'รายคน' ? 'ผู้ล้าง' : 'ไลน์'}</th>
                        <th style={th}>รอบ</th>
                        <th style={th}>ค่ากลาง</th>
                        <th style={th}>ช่วง</th>
                        <th style={th}>เทียบกลาง</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map(g => (
                        <tr key={g.name} style={{ borderBottom: '1px solid #f6efe8' }}>
                          <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>{g.name}</td>
                          <td style={td}>{g.n}</td>
                          <td style={{ ...td, fontWeight: 700 }}>{mins(g.median)}</td>
                          <td style={{ ...td, fontSize: 12, color: soft }}>{g.min}–{g.max} น.</td>
                          <td style={{ ...td, fontWeight: 700, color: g.vsMedian == null ? soft : g.vsMedian > 10 ? '#c62828' : g.vsMedian < -10 ? '#3f7d3a' : soft }}>
                            {g.vsMedian == null ? '—' : `${g.vsMedian > 0 ? '+' : ''}${g.vsMedian}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

        {cip && cip.rounds.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: soft, fontWeight: 600 }}>
              ดูรายรอบ ({cip.count} รอบ)
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {cip.rounds.map((r, i) => (
                <div key={`${r.at}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#fbf7f3', borderRadius: 10, padding: '8px 11px' }}>
                  <span style={{ flex: 'none', fontSize: 13 }}>{r.backwash ? '🔁' : '🧼'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{r.line}{r.item && <span style={{ color: soft, fontWeight: 400 }}> · {r.item}</span>}</div>
                    <div style={{ fontSize: 11.5, color: soft }}>
                      {(r.at || r.day).replace('T', ' ')}{r.shift && ` · กะ${r.shift}`} · {r.operator}
                    </div>
                  </div>
                  <span style={{
                    flex: 'none', fontFamily: kanit, fontSize: 13, fontWeight: 600,
                    color: cip.median != null && r.minutes > cip.median * 1.5 ? '#c62828' : '#c24f00',
                  }}>{mins(r.minutes)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* ── ผู้บันทึกยอดผลิต ── */}
      {data && data.operators.length > 0 && (
        <div style={{ ...card, padding: '14px 16px', overflowX: 'auto' }}>
          <div style={{ fontFamily: kanit, fontSize: 15, fontWeight: 600, marginBottom: 2 }}>ผู้บันทึกยอดผลิต</div>
          <div style={{ fontSize: 11.5, color: soft, marginBottom: 10 }}>
            นับจากชื่อที่ล็อกอินตอนกด Done — คือ <b>คนที่บันทึก</b> ไม่ใช่จำนวนคนที่ลงมือทำทั้งกะ
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line,#eee3d9)' }}>
                <th style={{ ...th, textAlign: 'left' }}>ชื่อ</th>
                <th style={th}>batch</th>
                <th style={th}>วันที่ลง</th>
                <th style={th}>เฉลี่ย/วัน</th>
                <th style={th}>รอบ CIP</th>
                <th style={{ ...th, textAlign: 'left' }}>ทีมกะ</th>
                <th style={{ ...th, textAlign: 'left' }}>ลงในกะ</th>
              </tr>
            </thead>
            <tbody>
              {data.operators.map(o => (
                <tr key={o.name} style={{ borderBottom: '1px solid #f6efe8' }}>
                  <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', fontWeight: 600 }}>{o.name}</td>
                  <td style={{ ...td, fontWeight: 700, color: '#c24f00' }}>{o.batches}</td>
                  <td style={td}>{o.days}</td>
                  <td style={td}>{o.perDay ?? '—'}</td>
                  <td style={td}>{o.cipRounds || '—'}</td>
                  <td style={{ ...td, textAlign: 'left', fontSize: 12, color: o.crew ? '#c24f00' : '#a15c00', fontWeight: 600 }}>
                    {o.crew || 'ยังไม่ผูก'}
                  </td>
                  <td style={{ ...td, textAlign: 'left', fontSize: 12, color: soft, whiteSpace: 'normal' }}>
                    {Object.entries(o.shifts).map(([k, n]) => `กะ${k} ${n}`).join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!data && !loading && (
        <div style={{ ...card, padding: 20, textAlign: 'center', color: soft, fontSize: 13 }}>
          โหลดข้อมูลไม่สำเร็จ — กด 🔄 รีเฟรชอีกครั้ง
        </div>
      )}
    </div>
  );
};

export default PerformanceReport;
