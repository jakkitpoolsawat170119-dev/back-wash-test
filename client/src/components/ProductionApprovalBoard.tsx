import React, { useCallback, useEffect, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

interface Report {
  report_id: string; work_day: string; shift: string;
  product_name: string; sku_keyword: string; group_name?: string; machine?: string;
  count_unit: string; pack_factor: number;
  plan_qty: number | null; plan_source: string;
  prod_qty: number | null; prod_pcs: number | null; reporter_name: string; crew_count: number;
  wh_qty: number | null; wh_name: string | null; wh_note: string | null;
  variance_qty: number | null; variance_flag: string | null; variance_reason: string | null;
  status: string; prod_status: string | null; miss_reason: string | null;
  approver_name: string | null; approved_qty: number | null; approved_source: string | null; decided_at: string | null;
  sheet_status: string; sheet_error: string | null; verify_expires_at: string | null;
}
interface Evt { event: string; actor: string; detail: string; created_at: string }

const workDay = () => {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
  if (Number(s.slice(11, 13)) >= 6) return s.slice(0, 10);
  const d = new Date(`${s.slice(0, 10)}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE');
};

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e0d8', borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' };
const pill = (bg: string, fg: string): React.CSSProperties => ({ display: 'inline-block', fontSize: '0.72rem', fontWeight: 'bold', padding: '3px 10px', borderRadius: 999, background: bg, color: fg });
const numBox = (bg: string, bd: string): React.CSSProperties => ({ border: `1px solid ${bd}`, background: bg, borderRadius: 11, padding: '9px 10px', textAlign: 'center' });
const numV: React.CSSProperties = { fontSize: '1.35rem', fontWeight: 'bold', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' };
const numL: React.CSSProperties = { fontSize: '0.7rem', color: '#8a7f72', fontWeight: 'bold' };
const btn: React.CSSProperties = { border: 'none', borderRadius: 10, padding: '9px 16px', fontWeight: 'bold', fontSize: '0.88rem', cursor: 'pointer', color: '#fff' };

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  pending_warehouse: { label: 'รอคลังตรวจนับ', bg: '#fdf1de', fg: '#c77700' },
  pending_approval: { label: 'รอหัวหน้าอนุมัติ', bg: '#e8f1fb', fg: '#1565c0' },
  approved: { label: 'อนุมัติแล้ว', bg: '#e6f4ec', fg: '#1c8a4c' },
  rejected: { label: 'ปฏิเสธ', bg: '#fdeaea', fg: '#c62828' },
};

const ProductionApprovalBoard: React.FC<{ operator?: string }> = ({ operator }) => {
  const [date, setDate] = useState(workDay());
  const [items, setItems] = useState<Report[] | null>(null);
  const [events, setEvents] = useState<Record<string, Evt[]>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, 'warehouse' | 'production'>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [approver, setApprover] = useState(operator || '');

  const load = useCallback(() => {
    fetch(`${apiUrl}/api/production/reports?date=${date}`)
      .then(r => r.json())
      .then(d => setItems(d.items || []))
      .catch(() => setItems([]));
  }, [date]);
  useEffect(() => { setItems(null); load(); }, [load]);

  const openDetail = async (id: string) => {
    setOpen(o => (o === id ? null : id));
    if (events[id]) return;
    try {
      const d = await fetch(`${apiUrl}/api/production/report/${id}`).then(r => r.json());
      setEvents(e => ({ ...e, [id]: d.events || [] }));
    } catch { /* timeline โหลดไม่ได้ก็ยังใช้หน้านี้ได้ */ }
  };

  const decide = async (r: Report, approve: boolean) => {
    if (!approver.trim()) { alert('กรุณากรอกชื่อผู้อนุมัติก่อน'); return; }
    let note = '';
    if (!approve) {
      note = window.prompt('เหตุผลที่ปฏิเสธ (บังคับ)') || '';
      if (!note.trim()) return;
    }
    setBusy(r.report_id);
    try {
      const res = await fetch(`${apiUrl}/api/production/report/${r.report_id}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve, approver: approver.trim(), approved_source: pick[r.report_id] || 'warehouse', note }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { alert(`❌ ${d.error || d.message || 'ไม่สำเร็จ'}`); return; }
      setEvents(e => { const n = { ...e }; delete n[r.report_id]; return n; });
      load();
    } catch { alert('❌ เชื่อมต่อไม่ได้'); }
    finally { setBusy(null); }
  };

  const resend = async (r: Report) => {
    setBusy(r.report_id);
    try {
      const res = await fetch(`${apiUrl}/api/production/report/${r.report_id}/resend-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: approver.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { alert(`❌ ${d.error || 'ไม่สำเร็จ'}`); return; }
      try { await navigator.clipboard.writeText(d.verify_url); alert('ออกลิงก์ใหม่และคัดลอกแล้ว — วางในกลุ่ม LINE ได้เลย'); }
      catch { window.prompt('ลิงก์ใหม่สำหรับคลัง', d.verify_url); }
      load();
    } catch { alert('❌ เชื่อมต่อไม่ได้'); }
    finally { setBusy(null); }
  };

  const groups: [string, string][] = [
    ['pending_approval', '⏳ รอหัวหน้าอนุมัติ'],
    ['pending_warehouse', '📦 รอคลังตรวจนับ'],
    ['approved', '✅ อนุมัติแล้ว'],
    ['rejected', '❌ ปฏิเสธ'],
  ];

  const renderCard = (r: Report) => {
    const meta = STATUS_META[r.status] || { label: r.status, bg: '#f0ebe5', fg: '#6d6259' };
    const diff = r.variance_qty;
    const hasDiff = r.variance_flag === 'diff';
    const isOpen = open === r.report_id;
    return (
      <div key={r.report_id} style={{ ...card, ...(hasDiff && r.status === 'pending_approval' ? { borderColor: '#f2c9c9', background: '#fffafa' } : {}) }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <b style={{ fontSize: '1rem', flex: '1 1 180px' }}>{r.product_name || r.sku_keyword}
            <span style={{ fontWeight: 'normal', fontSize: '0.8rem', color: '#8a7f72' }}> · {r.shift}{r.machine ? ` · ${r.machine}` : ''}</span>
          </b>
          <span style={pill(meta.bg, meta.fg)}>{meta.label}</span>
          {hasDiff && <span style={pill('#fdeaea', '#c62828')}>ต่าง {diff! > 0 ? '+' : ''}{diff}</span>}
          {r.sheet_status === 'sent' && <span style={pill('#e6f4ec', '#1c8a4c')}>✓ ลง Sheet</span>}
          {r.sheet_status === 'error' && <span style={pill('#fdeaea', '#c62828')}>Sheet ไม่ผ่าน · กำลังลองใหม่</span>}
          <code style={{ fontSize: '0.68rem', color: '#8a7f72' }}>{r.report_id}</code>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(95px, 1fr))', gap: 8, marginBottom: 12 }}>
          <div style={numBox('#fdfbf9', '#e5e0d8')}><div style={numL}>แผน</div><div style={numV}>{r.plan_qty ?? '—'}</div><div style={numL}>{r.count_unit}</div></div>
          <div style={numBox('#fff3ea', '#f6dcc4')}><div style={numL}>ผลิตแจ้ง</div><div style={{ ...numV, color: '#c24f00' }}>{r.prod_qty ?? '—'}</div><div style={numL}>{r.count_unit}</div></div>
          <div style={numBox('#e8f1fb', '#cfe0f5')}><div style={numL}>คลังนับได้</div><div style={{ ...numV, color: '#1565c0' }}>{r.wh_qty ?? '—'}</div><div style={numL}>{r.count_unit}</div></div>
          <div style={numBox(hasDiff ? '#fdeaea' : '#e6f4ec', hasDiff ? '#f2c9c9' : '#cfe8d8')}>
            <div style={numL}>ส่วนต่าง</div>
            <div style={{ ...numV, color: hasDiff ? '#c62828' : '#1c8a4c' }}>{diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff}`}</div>
            <div style={numL}>{diff == null ? '' : hasDiff ? 'ไม่ตรง' : 'ตรงกัน'}</div>
          </div>
          <div style={numBox('#fdfbf9', '#e5e0d8')}><div style={numL}>คิดเป็นชิ้น</div>
            <div style={numV}>{((r.wh_qty ?? r.prod_qty ?? 0) * (r.pack_factor || 0)).toLocaleString()}</div><div style={numL}>ชิ้น</div></div>
        </div>

        <div style={{ fontSize: '0.8rem', color: '#6d6259', marginBottom: 10 }}>
          ผู้รายงาน <b>{r.reporter_name}</b> ({r.crew_count} คน)
          {r.wh_name && <> · ผู้ตรวจนับ <b>{r.wh_name}</b></>}
          {r.prod_status === 'ไม่ได้ยอดผลิต' && <> · <span style={{ color: '#c62828' }}>ไม่ได้ยอด: {r.miss_reason}</span></>}
        </div>
        {r.variance_reason && (
          <div style={{ fontSize: '0.82rem', background: '#fff', border: '1px solid #e5e0d8', borderRadius: 9, padding: '8px 11px', marginBottom: 10 }}>
            📝 <b>เหตุผลจากคลัง:</b> {r.variance_reason}{r.wh_note ? ` — ${r.wh_note}` : ''}
          </div>
        )}

        <button onClick={() => openDetail(r.report_id)} style={{ background: 'none', border: 'none', color: '#c24f00', cursor: 'pointer', fontSize: '0.8rem', padding: 0, marginBottom: isOpen ? 8 : 0 }}>
          {isOpen ? '▲ ซ่อนประวัติ' : '▼ ดูประวัติการทำรายการ'}
        </button>
        {isOpen && (
          <div style={{ borderLeft: '2px solid #e5e0d8', margin: '4px 0 12px 5px', paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {(events[r.report_id] || []).map((e, i) => (
              <div key={i} style={{ fontSize: '0.78rem', color: '#6d6259' }}>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{e.created_at?.slice(11, 16)}</span>{' '}
                <b>{e.actor || 'ระบบ'}</b> — {e.detail || e.event}
              </div>
            ))}
            {!events[r.report_id]?.length && <div style={{ fontSize: '0.78rem', color: '#8a7f72' }}>กำลังโหลด…</div>}
          </div>
        )}

        {r.status === 'pending_approval' && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', background: '#f7f2ec', borderRadius: 10, padding: '9px 12px', margin: '10px 0', fontSize: '0.85rem' }}>
              <span style={{ fontWeight: 'bold' }}>ยึดตัวเลขไหนลง Sheet?</span>
              {(['warehouse', 'production'] as const).map(k => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                  <input type="radio" name={`pick-${r.report_id}`} checked={(pick[r.report_id] || 'warehouse') === k}
                    onChange={() => setPick(p => ({ ...p, [r.report_id]: k }))} />
                  {k === 'warehouse' ? 'คลังนับได้' : 'ผลิตแจ้ง'} <b>{k === 'warehouse' ? r.wh_qty : r.prod_qty}</b>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button disabled={busy === r.report_id} onClick={() => decide(r, true)} style={{ ...btn, background: busy === r.report_id ? '#bdbdbd' : 'linear-gradient(135deg,#3cb371,#1c8a4c)' }}>✅ อนุมัติ</button>
              <button disabled={busy === r.report_id} onClick={() => decide(r, false)} style={{ ...btn, background: '#fff', color: '#c62828', border: '1px solid #f2c9c9' }}>❌ ปฏิเสธ</button>
            </div>
          </>
        )}

        {r.status === 'pending_warehouse' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <button disabled={busy === r.report_id} onClick={() => resend(r)} style={{ ...btn, background: '#fff', color: '#c24f00', border: '1px solid #f6dcc4' }}>🔄 ออกลิงก์ใหม่ + คัดลอก</button>
            <span style={{ fontSize: '0.76rem', color: '#8a7f72' }}>ลิงก์เดิมหมดอายุ {r.verify_expires_at?.replace('T', ' ')}</span>
          </div>
        )}

        {r.status === 'approved' && (
          <div style={{ fontSize: '0.8rem', color: '#6d6259', marginTop: 4 }}>
            อนุมัติโดย <b>{r.approver_name}</b> · ยึดยอด{r.approved_source === 'production' ? 'ฝ่ายผลิต' : 'คลัง'} <b>{r.approved_qty}</b> {r.count_unit}
            {' '}({((r.approved_qty || 0) * (r.pack_factor || 0)).toLocaleString()} ชิ้น) · {r.decided_at?.replace('T', ' ')}
            {r.sheet_status === 'error' && <div style={{ color: '#c62828', marginTop: 4 }}>⚠️ เขียน Sheet ไม่สำเร็จ: {r.sheet_error} — ระบบจะลองใหม่อัตโนมัติทุกนาที</div>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', paddingBottom: 80 }}>
      <h2 style={{ fontSize: '1.2rem', color: '#3d2c1e', margin: '4px 0 2px' }}>✔️ อนุมัติยอดผลิต</h2>
      <p style={{ fontSize: '0.83rem', color: '#8a7f72', margin: '0 0 14px' }}>
        หัวหน้างานตรวจตัวเลขทั้งสองฝ่ายแล้วกดอนุมัติ — ระบบเขียนลง Google Sheet ให้เอง ไม่ต้องพิมพ์ซ้ำ
      </p>

      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <div>
          <label style={{ fontSize: '0.75rem', color: '#8a7f72', fontWeight: 'bold', display: 'block' }}>วันทำงาน</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 9, border: '1px solid #d9d2c7', fontSize: '0.9rem' }} />
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <label style={{ fontSize: '0.75rem', color: '#8a7f72', fontWeight: 'bold', display: 'block' }}>ชื่อผู้อนุมัติ *</label>
          <input value={approver} onChange={e => setApprover(e.target.value)} placeholder="ชื่อหัวหน้างาน"
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1px solid #d9d2c7', fontSize: '0.9rem' }} />
        </div>
        <button onClick={load} style={{ ...btn, background: '#fff', color: '#3d2c1e', border: '1px solid #d9d2c7', alignSelf: 'flex-end' }}>🔄 รีเฟรช</button>
      </div>

      {items === null && <div style={{ textAlign: 'center', color: '#8a7f72', padding: 30 }}>⏳ กำลังโหลด…</div>}
      {items?.length === 0 && <div style={{ ...card, textAlign: 'center', color: '#8a7f72' }}>ยังไม่มีรายงานของวันนี้</div>}

      {items && groups.map(([key, title]) => {
        const list = items.filter(r => r.status === key);
        if (!list.length) return null;
        return (
          <div key={key}>
            <h3 style={{ fontSize: '1rem', margin: '20px 0 10px', color: '#3d2c1e' }}>{title} <span style={{ color: '#8a7f72', fontWeight: 'normal' }}>({list.length})</span></h3>
            {list.map(renderCard)}
          </div>
        );
      })}
    </div>
  );
};

export default ProductionApprovalBoard;
