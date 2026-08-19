import React, { useCallback, useEffect, useMemo, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/* ── สรุปเวลาเครื่องหยุด (ERP เฟส 3 ในแผน) ──────────────────────────────────
   ข้อมูลมาจากเหตุการณ์ที่กรอก "เครื่องหยุดเมื่อ / กลับมาเดินเมื่อ" ไว้
   GET /api/maint/downtime?from&to → รวมยอดรายเครื่องมาให้แล้ว                */
type MachineRow = { name: string; count: number; minutes: number; openCount: number; lastAt: string; avgMin: number | null };
type IncRow = {
  id: number; title: string; machine: string; occurredAt: string; status: string;
  vaultPath: string; downFrom: string; downTo: string; minutes: number | null;
};
type Report = {
  from: string; to: string; rows: IncRow[]; machines: MachineRow[]; missing: number;
  totalCount: number; totalMin: number;
  openNow: { id: number; title: string; machine: string; downFrom: string }[];
};

const hhmm = (min: number) => (Math.floor(min / 60) ? `${Math.floor(min / 60)} ชม. ` : '') + `${min % 60} น.`;
const hours = (min: number) => (min / 60).toFixed(min < 600 ? 1 : 0);
const dt = (v: string) => (v || '').replace('T', ' ');
// นานแค่ไหนแล้วตั้งแต่เวลานั้นถึงตอนนี้ (ใช้กับเครื่องที่ยังหยุดอยู่)
const sinceNow = (from: string) => {
  const now = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);
  const m = Math.round((Date.parse(`${now}:00Z`) - Date.parse(`${from}:00Z`)) / 60000);
  return Number.isFinite(m) && m >= 0 ? hhmm(m) : '';
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

const DowntimeReport: React.FC = () => {
  const [to, setTo] = useState(todayBKK());
  const [from, setFrom] = useState(shiftDay(todayBKK(), -29));
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState('');            // ชื่อเครื่องที่กดเลือกไว้ (กรองรายการล่าง)

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch(`${apiUrl}/api/maint/downtime?from=${from}&to=${to}`).then(r => r.json());
      setData(d && Array.isArray(d.machines) ? d : null);
    } catch { setData(null); } finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const preset = (days: number) => { const t = todayBKK(); setTo(t); setFrom(shiftDay(t, -(days - 1))); setPick(''); };
  const thisMonth = () => { const t = todayBKK(); setTo(t); setFrom(`${t.slice(0, 7)}-01`); setPick(''); };

  const machines = data?.machines || [];
  const worst = machines[0];
  const shown = useMemo(
    () => (data?.rows || []).filter(r => !pick || (r.machine || 'ไม่ระบุเครื่อง') === pick),
    [data, pick]);

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#c24f00',
        background: '#fff3ea', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>🔧 งานซ่อมบำรุง</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          เวลาเครื่องหยุด
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>
          นับจากเหตุการณ์ที่กรอกเวลาเครื่องหยุด/กลับมาเดินไว้
        </span>
      </div>

      {/* ── ช่วงเวลา ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <button onClick={() => preset(30)} style={btn}>30 วันล่าสุด</button>
        <button onClick={() => preset(90)} style={btn}>90 วัน</button>
        <button onClick={thisMonth} style={btn}>เดือนนี้</button>
        <span style={{ width: 1, height: 22, background: 'var(--line,#eee3d9)' }} />
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>ถึง</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        <button onClick={load} style={btn}>{loading ? '⏳' : '🔄'} รีเฟรช</button>
      </div>

      {/* ── ตอนนี้ยังหยุดอยู่ ── */}
      {data && data.openNow.length > 0 && (
        <div style={{ ...card, borderColor: '#f2c4bc', background: '#fdecea', padding: '12px 16px', marginBottom: 14 }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 14, fontWeight: 600, color: '#b3261e', marginBottom: 6 }}>
            🔴 ตอนนี้ยังหยุดอยู่ {data.openNow.length} รายการ
          </div>
          {data.openNow.map(o => (
            <div key={o.id} style={{ fontSize: 13, lineHeight: 1.8 }}>
              <b>{o.machine || 'ไม่ระบุเครื่อง'}</b> · {o.title}{sinceNow(o.downFrom) && <> — หยุดมาแล้ว <b>{sinceNow(o.downFrom)}</b></>}
              <span style={{ color: 'var(--ink-soft,#6d6259)' }}> (ตั้งแต่ {dt(o.downFrom)} น.)</span>
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', marginTop: 6 }}>
            เครื่องกลับมาเดินแล้วอย่าลืมไปกรอก “กลับมาเดินเมื่อ” ในหน้าเหตุการณ์ — ยังไม่กรอกจะยังไม่ถูกนับเป็นชั่วโมงเสีย
          </div>
        </div>
      )}

      {/* ── ตัวเลขรวม ── */}
      {data && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', marginBottom: 14 }}>
          {([
            ['รวมเวลาที่เสีย', data.totalMin ? `${hours(data.totalMin)} ชม.` : '—', `${data.totalCount} ครั้งในช่วงนี้`],
            ['เครื่องที่เสียมากสุด', worst ? worst.name : '—', worst ? `${hhmm(worst.minutes)} · ${worst.count} ครั้ง` : ''],
            ['เฉลี่ยต่อครั้ง', data.totalCount && data.totalMin ? hhmm(Math.round(data.totalMin / Math.max(1, data.rows.filter(r => r.minutes != null).length))) : '—', 'เฉพาะครั้งที่กรอกครบ'],
          ] as [string, string, string][]).map(([k, v, sub]) => (
            <div key={k} style={{ ...card, padding: '12px 16px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', fontWeight: 600 }}>{k}</div>
              <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 20, fontWeight: 600, color: '#c24f00', lineHeight: 1.35, wordBreak: 'break-word' }}>{v}</div>
              {sub && <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>{sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* ── ตารางรายเครื่อง ── */}
      <div style={{ ...card, padding: '14px 16px', marginBottom: 14, overflowX: 'auto' }}>
        <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
          รายเครื่องจักร {pick && <button onClick={() => setPick('')} style={{ ...btn, padding: '3px 10px', fontSize: 12, marginLeft: 8 }}>✕ เลิกกรอง “{pick}”</button>}
        </div>
        {machines.length === 0
          ? <div style={{ fontSize: 13, color: '#a89e94', padding: '8px 0', lineHeight: 1.7 }}>
              ยังไม่มีเหตุการณ์ที่กรอกเวลาเครื่องหยุดในช่วงนี้
              <br />เปิดหน้า <b>เหตุการณ์</b> แล้วกรอกช่อง “เครื่องหยุดเมื่อ / กลับมาเดินเมื่อ” ตัวเลขจะมาโผล่ที่นี่
            </div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line,#eee3d9)' }}>
                  <th style={{ ...th, textAlign: 'left' }}>เครื่องจักร</th>
                  <th style={th}>ครั้ง</th>
                  <th style={th}>รวมเวลาที่เสีย</th>
                  <th style={th}>เฉลี่ย/ครั้ง</th>
                  <th style={th}>ครั้งล่าสุด</th>
                </tr>
              </thead>
              <tbody>
                {machines.map(m => {
                  const pctOfWorst = worst && worst.minutes ? Math.round(m.minutes / worst.minutes * 100) : 0;
                  const on = pick === m.name;
                  return (
                    <tr key={m.name} onClick={() => setPick(on ? '' : m.name)} title="กดเพื่อดูเฉพาะเครื่องนี้"
                      style={{ borderBottom: '1px solid #f6efe8', cursor: 'pointer', background: on ? '#fff3ea' : 'transparent' }}>
                      <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
                        <div style={{ fontWeight: 600 }}>{m.name}</div>
                        <div style={{ height: 5, borderRadius: 999, background: '#f2ece6', marginTop: 4, maxWidth: 220 }}>
                          <i style={{ display: 'block', height: '100%', width: `${pctOfWorst}%`, borderRadius: 999, background: 'linear-gradient(90deg,#ff6b00,#ffa34d)' }} />
                        </div>
                        {m.openCount > 0 && <div style={{ fontSize: 11.5, color: '#c62828', marginTop: 3 }}>🔴 ยังหยุดอยู่ {m.openCount}</div>}
                      </td>
                      <td style={td}>{m.count}</td>
                      <td style={{ ...td, fontWeight: 700, color: '#c24f00' }}>{m.minutes ? hhmm(m.minutes) : '—'}</td>
                      <td style={td}>{m.avgMin == null ? '—' : hhmm(m.avgMin)}</td>
                      <td style={{ ...td, color: 'var(--ink-soft,#6d6259)', fontSize: 12 }}>{dt(m.lastAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>

      {/* ── รายการครั้งที่เครื่องหยุด ── */}
      {shown.length > 0 && (
        <div style={{ ...card, padding: '14px 16px' }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            แต่ละครั้งที่หยุด ({shown.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {shown.map(r => (
              <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#fbf7f3', borderRadius: 10, padding: '9px 11px' }}>
                <span style={{ flex: 'none', fontSize: 14, marginTop: 1 }}>{r.minutes == null ? '🔴' : r.status === 'closed' ? '✅' : '🔸'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{r.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', lineHeight: 1.6 }}>
                    🔩 {r.machine || 'ไม่ระบุเครื่อง'} · {dt(r.downFrom)} น.
                    {r.downTo ? ` → ${dt(r.downTo)} น.` : ' → ยังไม่กลับมาเดิน'}
                  </div>
                </div>
                <span style={{
                  flex: 'none', fontFamily: 'Kanit, sans-serif', fontSize: 13, fontWeight: 600,
                  color: r.minutes == null ? '#c62828' : '#c24f00',
                }}>{r.minutes == null ? sinceNow(r.downFrom) || 'ยังหยุดอยู่' : hhmm(r.minutes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && data.missing > 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-soft,#6d6259)', marginTop: 12, lineHeight: 1.7 }}>
          ℹ️ ช่วงนี้มีเหตุการณ์อีก <b>{data.missing}</b> เรื่องที่ยังไม่ได้กรอกเวลาเครื่องหยุด — ตัวเลขข้างบนจึงยังไม่ครบทั้งหมด
        </div>
      )}
      {!data && !loading && (
        <div style={{ ...card, padding: 20, textAlign: 'center', color: 'var(--ink-soft,#6d6259)', fontSize: 13 }}>
          โหลดข้อมูลไม่สำเร็จ — กด 🔄 รีเฟรชอีกครั้ง
        </div>
      )}
    </div>
  );
};

export default DowntimeReport;
