import React, { useCallback, useEffect, useState } from 'react';
import { wakeFetch, wakeMessage } from '../lib/wakeFetch';

// ค้นยอดผลิตย้อนหลังข้ามช่วงวัน + กางไทม์ไลน์ของแต่ละใบ
// หน้าอนุมัติดูได้ทีละวันเท่านั้น — หน้านี้ตอบคำถามแบบ "เดือนที่แล้ว Syrup800 ผลิตไปเท่าไร"

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

interface Report {
  report_id: string; batch_id: string | null; work_day: string; shift: string;
  product_name: string; sku_keyword: string; count_unit: string;
  plan_qty: number | null; prod_qty: number | null; wh_qty: number | null;
  approved_qty: number | null; variance_qty: number | null; variance_flag: string | null;
  reporter_name: string; wh_name: string | null; approver_name: string | null;
  status: string; prod_status: string | null; miss_reason: string | null;
  fix_count?: number | null; wh_ack_at?: string | null; wh_ack_by?: string | null;
  has_pallet_photo?: boolean; sheet_status?: string;
}
interface Summary {
  sku_keyword: string; product_name: string; count_unit: string;
  reports: number; total_prod: number; total_final: number;
}
interface Evt { event: string; actor: string; detail: string; created_at: string; channel?: string }

const bkkToday = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date(`${bkkToday()}T12:00:00`);
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
};

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  pending_warehouse: { label: 'รอคลังตรวจนับ', bg: '#fdf1de', fg: '#c77700' },
  pending_approval: { label: 'รอหัวหน้าอนุมัติ', bg: '#e8f1fb', fg: '#1565c0' },
  needs_fix: { label: 'ส่งกลับให้แก้', bg: '#fdeeea', fg: '#c24f00' },
  approved: { label: 'อนุมัติแล้ว', bg: '#e6f4ec', fg: '#1c8a4c' },
  rejected: { label: 'ปฏิเสธ', bg: '#fdeaea', fg: '#c62828' },
};

const EVENT_LABEL: Record<string, string> = {
  created: '📝 ฝ่ายผลิตลงยอด',
  link_sent: '🔗 ส่งลิงก์ให้คลัง',
  warehouse_submitted: '📦 คลังกรอกยอดที่นับได้',
  sent_back: '✏️ หัวหน้าส่งกลับให้แก้',
  resubmitted: '🔄 ฝ่ายผลิตแก้แล้วส่งใหม่',
  approved: '✅ หัวหน้าอนุมัติ',
  rejected: '❌ หัวหน้าปฏิเสธ',
  warehouse_ack: '🤝 คลังกดรับทราบ',
  sheet_synced: '📄 เขียนลงชีตแล้ว',
  sheet_failed: '⚠️ เขียนชีตไม่สำเร็จ',
};

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e0d8', borderRadius: 14, padding: 14, marginBottom: 12 };
const lb: React.CSSProperties = { display: 'block', fontSize: '0.72rem', color: '#666', marginBottom: 3, fontWeight: 'bold' };
const inp: React.CSSProperties = { padding: '7px 9px', border: '1px solid #ddd2c4', borderRadius: 8, fontSize: '0.85rem', boxSizing: 'border-box', width: '100%' };
const pill = (bg: string, fg: string): React.CSSProperties => ({ display: 'inline-block', fontSize: '0.7rem', fontWeight: 'bold', padding: '2px 9px', borderRadius: 999, background: bg, color: fg });

const ProductionTimeline: React.FC = () => {
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(bkkToday());
  const [q, setQ] = useState('');
  const [shift, setShift] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState<{ items: Report[]; summary: Summary[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, Evt[]>>({});

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const p = new URLSearchParams({ from, to });
      if (q.trim()) p.set('q', q.trim());
      if (shift) p.set('shift', shift);
      if (status) p.set('status', status);
      const res = await wakeFetch(`${apiUrl}/api/production/history?${p}`, {
        onState: s => setErr(wakeMessage(s)),   // ปลุกเครื่องอยู่ ไม่ใช่พัง
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.error || 'ค้นไม่สำเร็จ'); setData(null); }
      else { setData({ items: d.items || [], summary: d.summary || [], total: d.total || 0 }); setErr(''); }
    } catch { setErr(wakeMessage('error')); setData(null); }
    setLoading(false);
  }, [from, to, q, shift, status]);

  useEffect(() => { load(); }, []);   // โหลดครั้งแรก · หลังจากนั้นกดค้นเอง

  const openDetail = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (events[id]) return;
    try {
      const res = await fetch(`${apiUrl}/api/production/report/${id}`);
      const d = await res.json();
      setEvents(e => ({ ...e, [id]: d.events || [] }));
    } catch { /* ไทม์ไลน์โหลดไม่ได้ก็ยังดูรายการได้ */ }
  };

  const preset = (days: number) => { setFrom(daysAgo(days)); setTo(bkkToday()); };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 4px 40px' }}>
      <div style={{ ...card, background: 'linear-gradient(135deg,#fff8f0,#fff)' }}>
        <h2 style={{ margin: '0 0 10px', fontSize: '1.1rem' }}>🕘 ประวัติยอดผลิต</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10 }}>
          <div><label style={lb}>ตั้งแต่</label><input type="date" style={inp} value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div><label style={lb}>ถึง</label><input type="date" style={inp} value={to} onChange={e => setTo(e.target.value)} /></div>
          <div><label style={lb}>กะ</label>
            <select style={inp} value={shift} onChange={e => setShift(e.target.value)}>
              <option value="">ทุกกะ</option>{['กะ1', 'กะ2', 'กะ3'].map(s => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div><label style={lb}>สถานะ</label>
            <select style={inp} value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">ทุกสถานะ</option>
              {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select></div>
          <div><label style={lb}>ค้นหา</label><input style={inp} placeholder="ชื่อสินค้า / รหัส / ผู้รายงาน" value={q}
            onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={load} disabled={loading}
            style={{ border: 'none', borderRadius: 10, padding: '9px 18px', fontWeight: 'bold', cursor: 'pointer', color: '#fff', background: loading ? '#bdbdbd' : 'linear-gradient(135deg,#c98b4b,#a86b32)' }}>
            {loading ? '⏳ กำลังค้น…' : '🔍 ค้นหา'}
          </button>
          {[[7, '7 วัน'], [30, '30 วัน'], [90, '90 วัน']].map(([d, l]) => (
            <button key={String(d)} onClick={() => preset(Number(d))}
              style={{ background: '#fff', border: '1px solid #e5dbcf', color: '#8a7f72', borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontSize: '0.8rem' }}>{l}</button>
          ))}
        </div>
        {err && <div style={{ marginTop: 10, color: '#c62828', fontSize: '0.82rem' }}>❌ {err}</div>}
      </div>

      {data && !!data.summary.length && (
        <div style={card}>
          <div style={{ fontWeight: 'bold', marginBottom: 8, fontSize: '0.9rem' }}>📊 สรุปต่อสินค้า ({data.total} ใบ)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.82rem', minWidth: 460 }}>
              <thead><tr style={{ background: '#faf6f1', textAlign: 'left' }}>
                <th style={{ padding: '7px 9px' }}>สินค้า</th>
                <th style={{ padding: '7px 9px', textAlign: 'right' }}>ใบ</th>
                <th style={{ padding: '7px 9px', textAlign: 'right' }}>ผลิตแจ้ง</th>
                <th style={{ padding: '7px 9px', textAlign: 'right' }}>ยอดสุดท้าย</th>
              </tr></thead>
              <tbody>
                {data.summary.map(s => (
                  <tr key={s.sku_keyword} style={{ borderTop: '1px solid #f0eae2' }}>
                    <td style={{ padding: '7px 9px' }}>{s.product_name || s.sku_keyword}</td>
                    <td style={{ padding: '7px 9px', textAlign: 'right' }}>{s.reports}</td>
                    <td style={{ padding: '7px 9px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Number(s.total_prod || 0).toLocaleString()}</td>
                    <td style={{ padding: '7px 9px', textAlign: 'right', fontWeight: 'bold', fontVariantNumeric: 'tabular-nums' }}>
                      {Number(s.total_final || 0).toLocaleString()} <span style={{ color: '#8a7f72', fontWeight: 'normal' }}>{s.count_unit}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && !data.items.length && !loading && (
        <div style={{ ...card, textAlign: 'center', color: '#8a7f72' }}>ไม่พบรายการในช่วงที่เลือก</div>
      )}

      {data?.items.map(r => {
        const meta = STATUS_META[r.status] || { label: r.status, bg: '#eee', fg: '#555' };
        const isOpen = open === r.report_id;
        return (
          <div key={r.report_id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 'bold', fontSize: '0.92rem' }}>{r.product_name || r.sku_keyword}</div>
                <div style={{ fontSize: '0.74rem', color: '#a1968a', marginTop: 2 }}>
                  {r.work_day} · {r.shift} · {r.reporter_name}
                  {!!r.fix_count && <span style={{ color: '#c24f00' }}> · แก้ {r.fix_count} ครั้ง</span>}
                  {r.has_pallet_photo && <span> · 📸</span>}
                  {r.wh_ack_at && <span style={{ color: '#1c8a4c' }}> · ✓ คลังรับทราบ</span>}
                </div>
              </div>
              <span style={pill(meta.bg, meta.fg)}>{meta.label}</span>
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: '0.82rem', fontVariantNumeric: 'tabular-nums' }}>
              <span>แผน <b>{r.plan_qty ?? '-'}</b></span>
              <span>ผลิตแจ้ง <b>{r.prod_qty ?? '-'}</b></span>
              <span>คลังนับ <b>{r.wh_qty ?? '-'}</b></span>
              {r.variance_qty != null && r.variance_qty !== 0 && (
                <span style={{ color: '#c62828' }}>ต่าง <b>{r.variance_qty > 0 ? '+' : ''}{r.variance_qty}</b></span>
              )}
              {r.approved_qty != null && <span style={{ color: '#1c8a4c' }}>ยึด <b>{r.approved_qty}</b> {r.count_unit}</span>}
            </div>

            <button onClick={() => openDetail(r.report_id)}
              style={{ background: 'none', border: 'none', color: '#c24f00', cursor: 'pointer', fontSize: '0.8rem', padding: 0, marginTop: 8 }}>
              {isOpen ? '▲ ซ่อนไทม์ไลน์' : '▼ ดูไทม์ไลน์'}
            </button>
            {isOpen && (
              <div style={{ borderLeft: '2px solid #e5e0d8', margin: '8px 0 0 5px', paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(events[r.report_id] || []).map((e, i) => (
                  <div key={i} style={{ fontSize: '0.78rem', color: '#6d6259' }}>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: '#a1968a' }}>{e.created_at?.replace('T', ' ').slice(5, 16)}</span>{' '}
                    {EVENT_LABEL[e.event] || e.event} — <b>{e.actor || 'ระบบ'}</b>
                    {e.detail && <span style={{ color: '#8a7f72' }}> · {e.detail}</span>}
                    {e.channel === 'telegram' && <span title="ผ่าน Telegram"> 💬</span>}
                  </div>
                ))}
                {!events[r.report_id]?.length && <div style={{ fontSize: '0.78rem', color: '#8a7f72' }}>กำลังโหลด…</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ProductionTimeline;
