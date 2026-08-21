import React, { useCallback, useEffect, useMemo, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/* ── 4-e วิเคราะห์คุณภาพย้อนหลัง ────────────────────────────────────────────
   ค่า Brix/pH ที่กรอกตอนกด Done ทุก batch (production_logs) เทียบสเปกต่อรส
   GET /api/quality/history?from&to → สรุปมาให้ครบแล้ว หน้านี้แค่วาด
   หมายเหตุ: ค่าใน CIP ไม่ถูกเอามาปน — นั่นคือค่าน้ำล้าง ไม่ใช่ค่าสินค้า      */

type Side = 'ok' | 'low' | 'high' | null;
type Trend = { first: number; last: number; delta: number; dir: 'up' | 'down' | 'flat' } | null;
type Metric = {
  n: number; avg: number | null; min: number | null; max: number | null;
  low: number; high: number; pos: number | null; trend: Trend;
};
type Spec = { brixMin: number | null; brixMax: number | null; phMin: number | null; phMax: number | null } | null;
type FlavorRow = {
  flavor: string; n: number; checked: number; out: number; rate: number | null;
  spec: Spec; brix: Metric; ph: Metric;
};
type LineRow = {
  line: string; n: number; checked: number; out: number; rate: number | null;
  topFlavor: { flavor: string; out: number } | null;
};
type OutRow = {
  at: string; day: string; line: string; flavor: string; batch: string; operator: string;
  brix: number | null; ph: number | null; brixSide: Side; phSide: Side;
  off: number; brixOff: number; phOff: number;
};
type Drift = { flavor: string; metric: string; first: number; last: number; delta: number; dir: string; pos: number | null; n: number };
type Report = {
  from: string; to: string; readings: number; checked: number; out: number; rate: number | null;
  flavors: FlavorRow[]; lines: LineRow[];
  byDay: { day: string; n: number; checked: number; out: number }[];
  rows: OutRow[];
  worstFlavor: { flavor: string; out: number; rate: number | null } | null;
  worstLine: { line: string; out: number; rate: number | null } | null;
  drifting: Drift[];
  noSpec: { flavor: string; n: number }[];
  specCount: number;
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

const dt = (v: string) => (v || '').replace('T', ' ').slice(0, 16);
const nz = (v: number | null | undefined) => (v == null ? '—' : String(v));
const range = (lo: number | null, hi: number | null) => {
  if (lo == null && hi == null) return 'ยังไม่ตั้ง';
  if (lo == null) return `ไม่เกิน ${hi}`;      // ตั้งสเปกด้านเดียว — อย่าโชว์เป็นช่วงว่าง
  if (hi == null) return `ตั้งแต่ ${lo}`;
  return `${lo}–${hi}`;
};
const ARROW: Record<string, string> = { up: '↗', down: '↘', flat: '→' };
const trendColor = (dir: string) => (dir === 'flat' ? soft : '#c24f00');

/* แถบบอกว่าค่าเฉลี่ยอยู่ตรงไหนในช่วงสเปก — 0 ขอบล่าง / 1 ขอบบน (เกินช่วง = ล้นออกนอกแถบ) */
const BandBar: React.FC<{ pos: number | null }> = ({ pos }) => {
  if (pos == null) return null;
  const clamped = Math.max(-0.12, Math.min(1.12, pos));
  const outside = pos < 0 || pos > 1;
  return (
    <div style={{ position: 'relative', height: 6, borderRadius: 999, background: '#f2ece6', marginTop: 4, minWidth: 64 }}>
      <i style={{
        position: 'absolute', top: -2, left: `calc(${clamped * 100}% - 5px)`, width: 10, height: 10,
        borderRadius: '50%', background: outside ? '#c62828' : '#ff6b00', border: '2px solid #fff',
        boxShadow: '0 1px 3px rgba(63,37,10,.3)',
      }} />
    </div>
  );
};

const MetricCell: React.FC<{ m: Metric; lo: number | null; hi: number | null }> = ({ m, lo, hi }) => {
  if (!m.n) return <td style={{ ...td, color: '#bdb5ad' }}>—</td>;
  return (
    <td style={{ ...td, textAlign: 'left', minWidth: 130 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <b style={{ fontFamily: 'Kanit, sans-serif' }}>{nz(m.avg)}</b>
        <span style={{ fontSize: 11.5, color: soft }}>({range(lo, hi)})</span>
        {m.trend && (
          <span style={{ fontSize: 12, fontWeight: 700, color: trendColor(m.trend.dir) }}
            title={`ครึ่งแรกเฉลี่ย ${m.trend.first} → ครึ่งหลัง ${m.trend.last}`}>
            {ARROW[m.trend.dir]}{m.trend.dir !== 'flat' ? ` ${m.trend.delta > 0 ? '+' : ''}${m.trend.delta}` : ''}
          </span>
        )}
      </div>
      <BandBar pos={m.pos} />
      {(m.low > 0 || m.high > 0) && (
        <div style={{ fontSize: 11, color: '#c62828', marginTop: 3 }}>
          {m.low > 0 && <>ต่ำกว่าสเปก {m.low} </>}{m.high > 0 && <>สูงกว่าสเปก {m.high}</>}
        </div>
      )}
    </td>
  );
};

const QualityReport: React.FC = () => {
  const [to, setTo] = useState(todayBKK());
  const [from, setFrom] = useState(shiftDay(todayBKK(), -29));
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState('');            // รสที่กดเลือก (กรองรายการล่าง)

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch(`${apiUrl}/api/quality/history?from=${from}&to=${to}`).then(r => r.json());
      setData(d && Array.isArray(d.flavors) ? d : null);
    } catch { setData(null); } finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const preset = (days: number) => { const t = todayBKK(); setTo(t); setFrom(shiftDay(t, -(days - 1))); setPick(''); };
  const thisMonth = () => { const t = todayBKK(); setTo(t); setFrom(`${t.slice(0, 7)}-01`); setPick(''); };

  const shown = useMemo(() => (data?.rows || []).filter(r => !pick || r.flavor === pick), [data, pick]);
  const maxDay = Math.max(1, ...(data?.byDay || []).map(d => d.n));
  const noSpecTotal = (data?.noSpec || []).reduce((n, s) => n + s.n, 0);

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#c24f00',
        background: '#fff3ea', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>🔬 คุณภาพ</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          วิเคราะห์คุณภาพย้อนหลัง
        </h1>
        <span style={{ fontSize: 13, color: soft }}>
          ค่า Brix / pH ที่กรอกตอนกด Done ทุก batch เทียบกับสเปกของรสนั้น
        </span>
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
            ['หลุดสเปก', `${data.out} ครั้ง`, data.checked ? `${data.rate}% ของ ${data.checked} ครั้งที่ตรวจได้` : 'ยังไม่มีค่าที่ตรวจได้'],
            ['รสที่หลุดบ่อยสุด', data.worstFlavor ? data.worstFlavor.flavor : '—',
              data.worstFlavor ? `${data.worstFlavor.out} ครั้ง · ${data.worstFlavor.rate}% ของรสนี้` : 'ไม่มีรสไหนหลุดเลย'],
            ['ไลน์ที่หลุดบ่อยสุด', data.worstLine ? data.worstLine.line : '—',
              data.worstLine ? `${data.worstLine.out} ครั้ง · ${data.worstLine.rate}% ของไลน์นี้` : ''],
            ['ค่าที่บันทึกไว้', `${data.readings} ครั้ง`, `ตรวจเทียบสเปกได้ ${data.checked} ครั้ง`],
          ] as [string, string, string][]).map(([k, v, sub]) => (
            <div key={k} style={{ ...card, padding: '12px 16px' }}>
              <div style={{ fontSize: 11.5, color: soft, fontWeight: 600 }}>{k}</div>
              <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 20, fontWeight: 600, color: '#c24f00', lineHeight: 1.35, wordBreak: 'break-word' }}>{v}</div>
              {sub && <div style={{ fontSize: 11.5, color: soft }}>{sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* ── รสที่ยังไม่ได้ตั้งสเปก = ยังไม่ถูกตรวจ ── */}
      {data && data.noSpec.length > 0 && (
        <div style={{ ...card, borderColor: '#f0dcc0', background: '#fffaf0', padding: '12px 16px', marginBottom: 14 }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 14, fontWeight: 600, color: '#a15c00', marginBottom: 4 }}>
            ⚠️ อีก {noSpecTotal} ค่ายังไม่ถูกตรวจ — {data.noSpec.length} รสนี้ยังไม่ได้ตั้งสเปก
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            {data.noSpec.slice(0, 12).map(s => `${s.flavor} (${s.n})`).join(' · ')}
            {data.noSpec.length > 12 && ` … อีก ${data.noSpec.length - 12} รส`}
          </div>
          <div style={{ fontSize: 11.5, color: soft, marginTop: 6 }}>
            ไปตั้งช่วง Brix / pH ที่หน้า <b>สเปคคุณภาพ</b> แล้วค่าย้อนหลังของรสนั้นจะถูกนำมาตรวจให้ทันที (ไม่ต้องกรอกใหม่)
          </div>
        </div>
      )}

      {/* ── ค่าเลื่อนไปทางไหน ── */}
      {data && data.drifting.length > 0 && (
        <div style={{ ...card, padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 2 }}>ค่าเลื่อนไปทางไหน</div>
          <div style={{ fontSize: 11.5, color: soft, marginBottom: 8 }}>
            เทียบค่าเฉลี่ยครึ่งแรกกับครึ่งหลังของช่วงที่เลือก (เฉพาะรสที่มีค่าอย่างน้อย 6 ครั้ง)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {data.drifting.map((d, i) => (
              <div key={`${d.flavor}-${d.metric}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#fbf7f3', borderRadius: 10, padding: '9px 11px' }}>
                <span style={{ flex: 'none', fontSize: 16, color: '#c24f00' }}>{ARROW[d.dir]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{d.flavor} · {d.metric}</div>
                  <div style={{ fontSize: 11.5, color: soft }}>
                    {d.first} → {d.last} (จาก {d.n} ครั้ง)
                    {d.pos != null && (d.pos > 0.75 ? ' · ตอนนี้ชิดขอบบนของสเปก' : d.pos < 0.25 ? ' · ตอนนี้ชิดขอบล่างของสเปก' : ' · ยังอยู่กลางสเปก')}
                  </div>
                </div>
                <span style={{ flex: 'none', fontFamily: 'Kanit, sans-serif', fontSize: 13, fontWeight: 600, color: '#c24f00' }}>
                  {d.delta > 0 ? '+' : ''}{d.delta}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── รายวัน ── */}
      {data && data.byDay.length > 1 && (
        <div style={{ ...card, padding: '14px 16px', marginBottom: 14, overflowX: 'auto' }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>รายวัน (แดง = ครั้งที่หลุดสเปก)</div>
          <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 84, minWidth: data.byDay.length * 12 }}>
            {data.byDay.map(d => (
              <div key={d.day} title={`${d.day} · วัด ${d.n} ครั้ง · หลุด ${d.out}`}
                style={{ flex: '1 0 8px', minWidth: 8, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                <div style={{ height: `${(d.out / maxDay) * 100}%`, background: '#e05252', borderRadius: '3px 3px 0 0' }} />
                <div style={{ height: `${((d.n - d.out) / maxDay) * 100}%`, background: '#ffcda1', borderRadius: d.out ? 0 : '3px 3px 0 0' }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: soft, marginTop: 4 }}>
            <span>{data.byDay[0].day}</span><span>{data.byDay[data.byDay.length - 1].day}</span>
          </div>
        </div>
      )}

      {/* ── รายรส ── */}
      <div style={{ ...card, padding: '14px 16px', marginBottom: 14, overflowX: 'auto' }}>
        <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
          รายรสชาติ {pick && <button onClick={() => setPick('')} style={{ ...btn, padding: '3px 10px', fontSize: 12, marginLeft: 8 }}>✕ เลิกกรอง “{pick}”</button>}
        </div>
        {!data || data.flavors.length === 0
          ? <div style={{ fontSize: 13, color: '#a89e94', padding: '8px 0', lineHeight: 1.7 }}>
              ยังไม่มีค่า Brix / pH ที่บันทึกไว้ในช่วงนี้
              <br />ค่าจะมาจากหน้า <b>ลงยอดผลิต</b> ตอนกด Done (กรอก Brix กับ pH ทุกครั้ง)
            </div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line,#eee3d9)' }}>
                  <th style={{ ...th, textAlign: 'left' }}>รสชาติ</th>
                  <th style={th}>วัด</th>
                  <th style={th}>หลุด</th>
                  <th style={{ ...th, textAlign: 'left' }}>Brix เฉลี่ย (สเปก)</th>
                  <th style={{ ...th, textAlign: 'left' }}>pH เฉลี่ย (สเปก)</th>
                </tr>
              </thead>
              <tbody>
                {data.flavors.map(f => {
                  const on = pick === f.flavor;
                  return (
                    <tr key={f.flavor} onClick={() => setPick(on ? '' : f.flavor)} title="กดเพื่อดูเฉพาะรสนี้"
                      style={{ borderBottom: '1px solid #f6efe8', cursor: 'pointer', background: on ? '#fff3ea' : 'transparent' }}>
                      <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
                        <div style={{ fontWeight: 600 }}>{f.flavor}</div>
                        {!f.spec && <div style={{ fontSize: 11, color: '#a15c00' }}>ยังไม่ได้ตั้งสเปก</div>}
                      </td>
                      <td style={td}>{f.n}</td>
                      <td style={{ ...td, fontWeight: 700, color: f.out ? '#c62828' : '#7a9b6e' }}>
                        {f.checked ? <>{f.out}<span style={{ fontSize: 11, fontWeight: 500, color: soft }}> ({f.rate}%)</span></> : '—'}
                      </td>
                      <MetricCell m={f.brix} lo={f.spec?.brixMin ?? null} hi={f.spec?.brixMax ?? null} />
                      <MetricCell m={f.ph} lo={f.spec?.phMin ?? null} hi={f.spec?.phMax ?? null} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>

      {/* ── รายไลน์ ── */}
      {data && data.lines.length > 0 && (
        <div style={{ ...card, padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>รายไลน์</div>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))' }}>
            {data.lines.map(l => (
              <div key={l.line} style={{ background: '#fbf7f3', borderRadius: 12, padding: '10px 12px' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{l.line}</div>
                <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 18, fontWeight: 600, color: l.out ? '#c62828' : '#7a9b6e' }}>
                  {l.checked ? `${l.out} ครั้ง` : '—'}
                  {l.checked ? <span style={{ fontSize: 12, color: soft, fontWeight: 500 }}> ({l.rate}%)</span> : null}
                </div>
                <div style={{ fontSize: 11.5, color: soft }}>
                  วัด {l.n} ครั้ง · ตรวจได้ {l.checked}
                  {l.topFlavor && <><br />บ่อยสุด: {l.topFlavor.flavor} ({l.topFlavor.out})</>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── แต่ละครั้งที่หลุดสเปก ── */}
      {shown.length > 0 && (
        <div style={{ ...card, padding: '14px 16px' }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            แต่ละครั้งที่หลุดสเปก ({shown.length}{data && data.out > data.rows.length ? ` จาก ${data.out}` : ''})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {shown.map((r, i) => (
              <div key={`${r.at}-${r.line}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#fbf7f3', borderRadius: 10, padding: '9px 11px' }}>
                <span style={{ flex: 'none', fontSize: 14, marginTop: 1 }}>🔻</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                    {r.flavor} · {r.line}{r.batch && <span style={{ color: soft, fontWeight: 500 }}> · Batch {r.batch}</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: soft, lineHeight: 1.6 }}>
                    {dt(r.at)} น.{r.operator && ` · ${r.operator}`}
                  </div>
                </div>
                <div style={{ flex: 'none', textAlign: 'right', fontSize: 12.5, lineHeight: 1.6 }}>
                  {(r.brixSide === 'low' || r.brixSide === 'high') && (
                    <div style={{ color: '#c62828', fontWeight: 600 }}>
                      Brix {r.brix} {r.brixSide === 'low' ? '▼' : '▲'} {r.brixOff}
                    </div>
                  )}
                  {(r.phSide === 'low' || r.phSide === 'high') && (
                    <div style={{ color: '#c62828', fontWeight: 600 }}>
                      pH {r.ph} {r.phSide === 'low' ? '▼' : '▲'} {r.phOff}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && data.out === 0 && data.checked > 0 && (
        <div style={{ ...card, padding: 18, textAlign: 'center', fontSize: 13.5, color: '#5d7a52' }}>
          ✅ ช่วงนี้ไม่มีค่าไหนหลุดสเปกเลย (ตรวจได้ {data.checked} ครั้ง จาก {data.readings} ค่าที่บันทึกไว้)
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

export default QualityReport;
