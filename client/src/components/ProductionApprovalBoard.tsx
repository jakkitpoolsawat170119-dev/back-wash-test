import React, { useCallback, useEffect, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

interface Report {
  report_id: string; batch_id: string | null; work_day: string; shift: string;
  product_name: string; sku_keyword: string; group_name?: string; machine?: string;
  count_unit: string; pack_factor: number;
  plan_qty: number | null; plan_source: string;
  prod_qty: number | null; prod_pcs: number | null; reporter_name: string; crew_count: number;
  wh_qty: number | null; wh_name: string | null; wh_note: string | null;
  variance_qty: number | null; variance_flag: string | null; variance_reason: string | null;
  status: string; prod_status: string | null; miss_reason: string | null;
  approver_name: string | null; approved_qty: number | null; approved_source: string | null; decided_at: string | null;
  sheet_status: string; sheet_error: string | null; verify_expires_at: string | null;
  fix_note?: string | null; fix_count?: number | null;          // เฟส 2: ประวัติการถูกส่งกลับให้แก้
  wh_ack_at?: string | null; wh_ack_by?: string | null;         // เฟส 2: คลังกดรับทราบในการ์ด LINE
  has_pallet_photo?: boolean;                                   // รูปโหลดแยกตอนกดดู (ไม่ติดมากับลิสต์)
  payload?: { ai_flags?: { level: string; text: string }[] };    // ป้ายเตือนจากการตรวจเชิงกฎ (ไม่ตัดสินแทนหัวหน้า)
  counter?: number | null; machine_cycle?: number | null;        // เฟส 3: หัวหน้าแก้ได้ก่อนส่งคลัง
  reviewed_at?: string | null; reviewed_by?: string | null;      // เฟส 3: หัวหน้ากด "ตรวจแล้ว" รายตัว
  edited_by?: string | null; edit_count?: number | null;         // เฟส 3: ร่องรอยการแก้ของหัวหน้า
}
// ช่องที่หัวหน้าแก้ได้ตอน pending_review — ต้องตรงกับ REVIEW_EDITABLE ฝั่ง server
type EditDraft = { prod_qty: string; counter: string; machine_cycle: string; machine: string; reporter_name: string };
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
  pending_review: { label: 'รอหัวหน้าตรวจ', bg: '#fff3ea', fg: '#c24f00' },
  pending_warehouse: { label: 'รอคลังตรวจนับ', bg: '#fdf1de', fg: '#c77700' },
  pending_approval: { label: 'รอหัวหน้าอนุมัติ', bg: '#e8f1fb', fg: '#1565c0' },
  approved: { label: 'อนุมัติแล้ว', bg: '#e6f4ec', fg: '#1c8a4c' },
  rejected: { label: 'ปฏิเสธ', bg: '#fdeaea', fg: '#c62828' },
  needs_fix: { label: 'ส่งกลับให้แก้', bg: '#fdeeea', fg: '#c24f00' },
};

const ProductionApprovalBoard: React.FC<{ operator?: string }> = ({ operator }) => {
  const [date, setDate] = useState(workDay());
  const [items, setItems] = useState<Report[] | null>(null);
  const [events, setEvents] = useState<Record<string, Evt[]>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, 'warehouse' | 'production'>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [approver, setApprover] = useState(operator || '');
  const [photos, setPhotos] = useState<Record<string, string>>({});   // report_id → data URL | 'loading' | ''
  const [edit, setEdit] = useState<Record<string, EditDraft>>({});    // report_id → ร่างที่กำลังแก้ (มีคีย์ = กำลังแก้อยู่)

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

  // ── ขั้นที่ 4: หัวหน้าตรวจก่อนส่งคลัง ──────────────────────────────────
  const startEdit = (r: Report) => setEdit(e => ({
    ...e,
    [r.report_id]: {
      prod_qty: String(r.prod_qty ?? ''), counter: String(r.counter ?? ''),
      machine_cycle: String(r.machine_cycle ?? ''), machine: r.machine || '', reporter_name: r.reporter_name || '',
    },
  }));
  const cancelEdit = (id: string) => setEdit(({ [id]: _drop, ...rest }) => rest);

  const saveEdit = async (r: Report) => {
    const d = edit[r.report_id];
    if (!d) return;
    if (!approver.trim()) { alert('กรุณากรอกชื่อผู้ตรวจก่อน'); return; }
    // ส่งเฉพาะช่องที่เปลี่ยนจริง — server เก็บ log ทุกการแก้ ไม่อยากให้มีแถวขยะ
    const fields: Record<string, string | number> = {};
    if (Number(d.prod_qty) !== Number(r.prod_qty ?? 0)) fields.prod_qty = Number(d.prod_qty);
    if (Number(d.counter) !== Number(r.counter ?? 0)) fields.counter = Number(d.counter);
    if (Number(d.machine_cycle) !== Number(r.machine_cycle ?? 0)) fields.machine_cycle = Number(d.machine_cycle);
    if (d.machine.trim() !== (r.machine || '')) fields.machine = d.machine.trim();
    if (d.reporter_name.trim() !== (r.reporter_name || '')) fields.reporter_name = d.reporter_name.trim();
    if (!Object.keys(fields).length) { cancelEdit(r.report_id); return; }

    setBusy(r.report_id);
    try {
      const res = await fetch(`${apiUrl}/api/production/report/${r.report_id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: approver.trim(), fields }),
      });
      const j = await res.json();
      if (!res.ok) { alert(j.error || 'แก้ไม่สำเร็จ'); return; }
      cancelEdit(r.report_id);
      setEvents(e => ({ ...e, [r.report_id]: [] }));   // ประวัติเปลี่ยนแล้ว ให้โหลดใหม่ตอนกางครั้งหน้า
      load();
    } catch { alert('เชื่อมต่อไม่ได้'); }
    finally { setBusy(null); }
  };

  const toggleReview = async (r: Report) => {
    if (!approver.trim()) { alert('กรุณากรอกชื่อผู้ตรวจก่อน'); return; }
    setBusy(r.report_id);
    try {
      const res = await fetch(`${apiUrl}/api/production/report/${r.report_id}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: approver.trim(), undo: !!r.reviewed_at }),
      });
      const j = await res.json();
      if (!res.ok) alert(j.error || 'ไม่สำเร็จ'); else load();
    } catch { alert('เชื่อมต่อไม่ได้'); }
    finally { setBusy(null); }
  };

  // ทางเดียวที่ข้อมูลจะถึงคลัง — server บล็อกถ้ายังตรวจไม่ครบ
  const sendToWarehouse = async (batchId: string, group: Report[]) => {
    if (!approver.trim()) { alert('กรุณากรอกชื่อผู้ตรวจก่อน'); return; }
    const left = group.filter(r => !r.reviewed_at).length;
    if (left) { alert(`ยังตรวจไม่ครบ — เหลืออีก ${left} รายการ`); return; }
    if (!window.confirm(`ส่ง ${group.length} รายการให้คลังนับ?\n\nหลังส่งแล้วจะแก้ตัวเลขไม่ได้ เพราะคลังจะนับเทียบกับเลขชุดนี้`)) return;
    setBusy(batchId);
    try {
      const res = await fetch(`${apiUrl}/api/production/batch/${batchId}/send-to-warehouse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: approver.trim() }),
      });
      const j = await res.json();
      if (!res.ok) { alert(j.error || 'ส่งไม่สำเร็จ'); return; }
      alert(j.sent_via === 'telegram'
        ? `ส่งให้คลังแล้ว ${j.sent} รายการ ✅\nลิงก์เข้ากลุ่ม Telegram แล้ว`
        : `ส่งแล้ว ${j.sent} รายการ — แต่ยังส่งลิงก์เข้ากลุ่มไม่ได้\n\nลิงก์: ${j.verify_url}`);
      load();
    } catch { alert('เชื่อมต่อไม่ได้'); }
    finally { setBusy(null); }
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

  // อนุมัติ/ปฏิเสธทั้งชุด — ปกติกะหนึ่งมี 8+ รายการ กดทีละใบไม่ไหว
  const decideBatch = async (batchId: string, list: Report[], approve: boolean) => {
    if (!approver.trim()) { alert('กรุณากรอกชื่อผู้อนุมัติก่อน'); return; }
    let note = '';
    if (!approve) {
      note = window.prompt(`เหตุผลที่ปฏิเสธทั้งชุด ${list.length} รายการ (บังคับ)`) || '';
      if (!note.trim()) return;
    } else {
      const nDiff = list.filter(r => r.variance_flag === 'diff').length;
      const warn = nDiff ? `\n\n⚠️ มี ${nDiff} รายการที่ตัวเลขไม่ตรงกัน` : '';
      if (!window.confirm(`อนุมัติทั้งชุด ${list.length} รายการ?${warn}`)) return;
    }
    setBusy(batchId);
    try {
      const res = await fetch(`${apiUrl}/api/production/batch/${batchId}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve, approver: approver.trim(), approved_source: 'warehouse', note }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { alert(`❌ ${d.error || 'ไม่สำเร็จ'}`); return; }
      if (d.failed) alert(`สำเร็จ ${d.decided} · ไม่สำเร็จ ${d.failed} รายการ`);
      setEvents({});
      load();
    } catch { alert('❌ เชื่อมต่อไม่ได้'); }
    finally { setBusy(null); }
  };

  // รูปค้างพาเลทเป็น base64 ก้อนใหญ่ — โหลดเฉพาะใบที่กดดู แล้วจำไว้ในหน่วยความจำ
  const showPhoto = async (id: string) => {
    if (photos[id]) { setPhotos(p => ({ ...p, [id]: p[id] === 'loading' ? 'loading' : p[id] })); return; }
    setPhotos(p => ({ ...p, [id]: 'loading' }));
    try {
      const res = await fetch(`${apiUrl}/api/production/report/${id}/pallet-photo`);
      const d = await res.json().catch(() => ({}));
      setPhotos(p => ({ ...p, [id]: res.ok && d.image ? d.image : '' }));
    } catch { setPhotos(p => ({ ...p, [id]: '' })); }
  };

  // ส่งกลับให้แก้ — ต่างจากปฏิเสธ: เด้งไปหาคนลงยอดใน Telegram แล้วรอเขาส่งใหม่ที่แถวเดิม
  const sendBack = async (r: Report) => {
    if (!approver.trim()) { alert('กรุณากรอกชื่อผู้อนุมัติก่อน'); return; }
    const note = window.prompt(`ให้ "${r.reporter_name}" แก้อะไร? (บังคับ)`) || '';
    if (!note.trim()) return;
    setBusy(r.report_id);
    try {
      const res = await fetch(`${apiUrl}/api/production/report/${r.report_id}/send-back`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: approver.trim(), note: note.trim() }),
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
    ['pending_review', '🔎 รอหัวหน้าตรวจ — ยังไม่ถึงคลัง'],
    ['pending_approval', '⏳ รอหัวหน้าอนุมัติ'],
    ['needs_fix', '✏️ ส่งกลับให้แก้ — รอฝ่ายผลิตส่งใหม่'],
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
          {/* ก่อนส่งคลัง ยังไม่มีเลขคลัง — โชว์ช่องว่างจะชวนสับสน สลับไปโชว์ข้อมูลเครื่องแทน */}
          {r.status === 'pending_review' ? (
            <>
              <div style={numBox('#fdfbf9', '#e5e0d8')}><div style={numL}>เลขหน้าเครื่อง</div>
                <div style={numV}>{r.counter ?? '—'}</div><div style={numL}>ชิ้น</div></div>
              <div style={numBox('#fdfbf9', '#e5e0d8')}><div style={numL}>เดินรอบเครื่อง</div>
                <div style={numV}>{r.machine_cycle ?? '—'}</div><div style={numL}>รอบ</div></div>
            </>
          ) : (
            <>
              <div style={numBox('#e8f1fb', '#cfe0f5')}><div style={numL}>คลังนับได้</div><div style={{ ...numV, color: '#1565c0' }}>{r.wh_qty ?? '—'}</div><div style={numL}>{r.count_unit}</div></div>
              <div style={numBox(hasDiff ? '#fdeaea' : '#e6f4ec', hasDiff ? '#f2c9c9' : '#cfe8d8')}>
                <div style={numL}>ส่วนต่าง</div>
                <div style={{ ...numV, color: hasDiff ? '#c62828' : '#1c8a4c' }}>{diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff}`}</div>
                <div style={numL}>{diff == null ? '' : hasDiff ? 'ไม่ตรง' : 'ตรงกัน'}</div>
              </div>
            </>
          )}
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

        {!!r.payload?.ai_flags?.length && (
          <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {r.payload.ai_flags.map((f, i) => (
              <div key={i} style={{
                fontSize: '0.79rem', borderRadius: 9, padding: '7px 11px',
                background: f.level === 'warn' ? '#fdf1de' : '#f2f5f8',
                border: `1px solid ${f.level === 'warn' ? '#f3ddb8' : '#e2e8ee'}`,
                color: f.level === 'warn' ? '#8a5a00' : '#4a5967',
              }}>
                {f.level === 'warn' ? '⚠️' : 'ℹ️'} {f.text}
              </div>
            ))}
          </div>
        )}

        {!!r.fix_count && (
          <div style={{ fontSize: '0.78rem', color: '#c24f00', marginBottom: 8 }}>
            ✏️ ถูกส่งกลับให้แก้มาแล้ว {r.fix_count} ครั้ง — ตัวเลขนี้แก้หลังคลังนับ ตรวจก่อนอนุมัติ
          </div>
        )}

        {r.has_pallet_photo && (
          <div style={{ marginBottom: 10 }}>
            {!photos[r.report_id] ? (
              <button onClick={() => showPhoto(r.report_id)} style={{ background: 'none', border: 'none', color: '#c24f00', cursor: 'pointer', fontSize: '0.8rem', padding: 0 }}>
                📸 ดูรูปค้างพาเลท
              </button>
            ) : photos[r.report_id] === 'loading' ? (
              <span style={{ fontSize: '0.8rem', color: '#8a7f72' }}>กำลังโหลดรูป…</span>
            ) : (
              <img src={photos[r.report_id]} alt="รูปค้างพาเลท"
                style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 10, border: '1px solid #e5e0d8', display: 'block' }} />
            )}
          </div>
        )}

        {r.wh_ack_at && (
          <div style={{ fontSize: '0.78rem', color: '#1c8a4c', marginBottom: 8 }}>
            ✓ คลังรับทราบแล้ว{r.wh_ack_by ? ` โดย ${r.wh_ack_by}` : ''} · {r.wh_ack_at.replace('T', ' ').slice(0, 16)}
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

        {r.status === 'pending_review' && (
          <>
            {edit[r.report_id] ? (
              <div style={{ border: '1px dashed #d9c9b4', background: '#fffdfa', borderRadius: 11, padding: '11px 12px', margin: '10px 0' }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 'bold', color: '#c24f00', marginBottom: 8 }}>
                  ✏️ แก้ได้เฉพาะก่อนส่งให้คลัง
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 9 }}>
                  {([
                    ['prod_qty', `ผลิตได้ (${r.count_unit})`, 'number'],
                    ['counter', 'เลขหน้าเครื่อง', 'number'],
                    ['machine_cycle', 'เดินรอบเครื่อง', 'number'],
                    ['machine', 'เครื่องบรรจุ', 'text'],
                    ['reporter_name', 'ชื่อผู้รายงาน', 'text'],
                  ] as [keyof EditDraft, string, string][]).map(([k, label, type]) => (
                    <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ fontSize: '0.68rem', color: '#a1968a', fontWeight: 'bold' }}>{label}</label>
                      <input type={type} min={type === 'number' ? 0 : undefined} value={edit[r.report_id][k]}
                        onChange={e => setEdit(s => ({ ...s, [r.report_id]: { ...s[r.report_id], [k]: e.target.value } }))}
                        style={{ padding: '6px 8px', border: '1px solid #e2d6c6', borderRadius: 8, fontSize: '0.85rem', width: '100%', boxSizing: 'border-box' }} />
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: '0.72rem', color: '#8a7f72', marginTop: 8 }}>
                  🧮 ชิ้นที่ได้ = {(Number(edit[r.report_id].prod_qty) || 0) * (r.pack_factor || 0)} ชิ้น (ระบบคิดให้ตอนบันทึก)
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button disabled={busy === r.report_id} onClick={() => saveEdit(r)}
                    style={{ ...btn, background: busy === r.report_id ? '#bdbdbd' : '#ff6b00' }}>💾 บันทึกที่แก้</button>
                  <button onClick={() => cancelEdit(r.report_id)}
                    style={{ ...btn, background: '#fff', color: '#6d6259', border: '1px solid #d9d2c7' }}>ยกเลิก</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 10 }}>
                <button disabled={busy === r.report_id} onClick={() => toggleReview(r)}
                  style={{ ...btn, background: r.reviewed_at ? '#fff' : 'linear-gradient(135deg,#3cb371,#1c8a4c)',
                    color: r.reviewed_at ? '#1c8a4c' : '#fff', border: r.reviewed_at ? '1px solid #cfe8d8' : 'none' }}>
                  {r.reviewed_at ? '✅ ตรวจแล้ว — กดเพื่อยกเลิก' : '✅ ตรวจแล้ว'}
                </button>
                <button disabled={busy === r.report_id} onClick={() => startEdit(r)}
                  style={{ ...btn, background: '#fff', color: '#c24f00', border: '1px solid #f6dcc4' }}>✏️ แก้ไข</button>
                <button disabled={busy === r.report_id} onClick={() => sendBack(r)}
                  style={{ ...btn, background: '#fff', color: '#c62828', border: '1px solid #f2c9c9' }}>↩️ ส่งกลับให้พนักงานแก้</button>
                {r.reviewed_at && <span style={{ fontSize: '0.74rem', color: '#1c8a4c' }}>ตรวจโดย {r.reviewed_by}</span>}
              </div>
            )}
            {!!r.edit_count && (
              <div style={{ fontSize: '0.74rem', color: '#8a7f72', marginTop: 7 }}>
                ✏️ หัวหน้าแก้มาแล้ว {r.edit_count} ครั้ง (ล่าสุดโดย {r.edited_by}) — ดูรายละเอียดในประวัติ
              </div>
            )}
          </>
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
              <button disabled={busy === r.report_id} onClick={() => sendBack(r)} style={{ ...btn, background: '#fff', color: '#c24f00', border: '1px solid #f6dcc4' }}>✏️ ส่งกลับแก้ไข</button>
              <button disabled={busy === r.report_id} onClick={() => decide(r, false)} style={{ ...btn, background: '#fff', color: '#c62828', border: '1px solid #f2c9c9' }}>❌ ปฏิเสธ</button>
            </div>
          </>
        )}

        {r.status === 'needs_fix' && (
          <div style={{ background: '#fdeeea', border: '1px solid #f6d5c4', borderRadius: 10, padding: '9px 12px', marginTop: 8, fontSize: '0.82rem', color: '#8a4a1c' }}>
            ✏️ ส่งกลับให้ <b>{r.reporter_name}</b> แก้แล้ว — รอส่งกลับมาใหม่
            {r.fix_note && <div style={{ marginTop: 4 }}>📝 {r.fix_note}</div>}
          </div>
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
      <h2 style={{ fontSize: '1.2rem', color: '#3d2c1e', margin: '4px 0 2px' }}>✔️ ตรวจ / อนุมัติยอดผลิต</h2>
      <p style={{ fontSize: '0.83rem', color: '#8a7f72', margin: '0 0 10px' }}>
        หัวหน้าดู 2 จังหวะ — <b>รอบแรก</b> ตรวจเลขฝ่ายผลิตก่อนส่งคลัง (แก้ได้) · <b>รอบสอง</b> เทียบกับเลขคลังแล้วอนุมัติ → ระบบเขียนลง Google Sheet ให้เอง
      </p>
      <div style={{ fontSize: '0.78rem', background: '#fff3ea', border: '1px solid #f6dcc4', color: '#8a4a1c', borderRadius: 10, padding: '8px 12px', marginBottom: 14 }}>
        🚫 ข้อมูลไม่ไหลไปคลังเอง — คลังจะได้ลิงก์ก็ต่อเมื่อหัวหน้ากด “ส่งให้คลังนับ” ที่หน้านี้เท่านั้น
      </div>

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

        // จัดกลุ่มตามชุดของกะ — รายการที่ไม่มี batch_id (ของเก่า) แสดงเดี่ยวตามเดิม
        const order: string[] = [];
        const byBatch: Record<string, Report[]> = {};
        for (const r of list) {
          const k = r.batch_id || `__solo_${r.report_id}`;
          if (!byBatch[k]) { byBatch[k] = []; order.push(k); }
          byBatch[k].push(r);
        }

        return (
          <div key={key}>
            <h3 style={{ fontSize: '1rem', margin: '20px 0 10px', color: '#3d2c1e' }}>{title} <span style={{ color: '#8a7f72', fontWeight: 'normal' }}>({list.length})</span></h3>
            {order.map(bk => {
              const group = byBatch[bk];
              const isBatch = !bk.startsWith('__solo_');
              if (!isBatch) return group.map(renderCard);
              const first = group[0];
              const nDiff = group.filter(r => r.variance_flag === 'diff').length;
              const selfApprove = approver.trim() !== '' && approver.trim() === first.reporter_name?.trim();
              return (
                <div key={bk} style={{ border: '1px solid #e5e0d8', borderRadius: 16, padding: 12, marginBottom: 16, background: '#faf7f4' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <b style={{ fontSize: '0.95rem', flex: '1 1 200px' }}>
                      📋 ชุด {first.shift} · {first.work_day}
                      <span style={{ fontWeight: 'normal', fontSize: '0.8rem', color: '#8a7f72' }}> · ลงยอดโดย {first.reporter_name}</span>
                    </b>
                    <span style={pill('#f0ebe5', '#6d6259')}>{group.length} รายการ</span>
                    {/* ยังไม่ผ่านคลัง = ยังไม่มีอะไรให้เทียบ — โชว์ความคืบหน้าการตรวจแทน */}
                    {key === 'pending_review'
                      ? <span style={pill('#fff3ea', '#c24f00')}>ตรวจแล้ว {group.filter(r => r.reviewed_at).length}/{group.length}</span>
                      : nDiff > 0
                        ? <span style={pill('#fdeaea', '#c62828')}>ไม่ตรง {nDiff}</span>
                        : <span style={pill('#e6f4ec', '#1c8a4c')}>ตรงกันทั้งหมด</span>}
                    <code style={{ fontSize: '0.68rem', color: '#8a7f72' }}>{bk}</code>
                  </div>

                  {key === 'pending_review' && (() => {
                    const doneN = group.filter(r => r.reviewed_at).length;
                    const allDone = doneN === group.length;
                    return (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: '0.8rem', color: '#6d6259', marginBottom: 8 }}>
                          ตรวจแล้ว <b style={{ color: allDone ? '#1c8a4c' : '#c24f00' }}>{doneN}</b> จาก {group.length} รายการ
                          {!allDone && <> · เหลืออีก {group.length - doneN} รายการถึงจะส่งได้</>}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                          <button disabled={!allDone || busy === bk} onClick={() => sendToWarehouse(bk, group)}
                            style={{
                              ...btn,
                              background: allDone && busy !== bk ? 'linear-gradient(135deg,#ff9a4d,#e05500)' : '#ded4c8',
                              cursor: allDone ? 'pointer' : 'not-allowed',
                            }}>
                            📤 ส่งให้คลังนับ ({group.length} รายการ · 1 ลิงก์)
                          </button>
                          <span style={{ fontSize: '0.76rem', color: '#8a7f72' }}>
                            ยังไม่ถึงคลัง — ส่งแล้วจะแก้ตัวเลขไม่ได้
                          </span>
                        </div>
                      </div>
                    );
                  })()}

                  {key === 'pending_approval' && (
                    <>
                      {selfApprove && (
                        <div style={{ fontSize: '0.8rem', background: '#fdf1de', border: '1px solid #f0d9b0', color: '#8a6d3b', borderRadius: 9, padding: '8px 11px', marginBottom: 10 }}>
                          ⚠️ ชื่อผู้อนุมัติเป็นคนเดียวกับผู้ลงยอด — ควรให้หัวหน้ากะเป็นคนอนุมัติ เพื่อให้ขั้นตรวจสอบมีความหมาย
                        </div>
                      )}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                        <button disabled={busy === bk} onClick={() => decideBatch(bk, group, true)}
                          style={{ ...btn, background: busy === bk ? '#bdbdbd' : 'linear-gradient(135deg,#3cb371,#1c8a4c)' }}>
                          ✅ อนุมัติทั้งชุด ({group.length})
                        </button>
                        <button disabled={busy === bk} onClick={() => decideBatch(bk, group, false)}
                          style={{ ...btn, background: '#fff', color: '#c62828', border: '1px solid #f2c9c9' }}>
                          ❌ ปฏิเสธทั้งชุด
                        </button>
                        <span style={{ fontSize: '0.76rem', color: '#8a7f72', alignSelf: 'center' }}>หรือกดทีละรายการด้านล่าง</span>
                      </div>
                    </>
                  )}

                  {group.map(renderCard)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

export default ProductionApprovalBoard;
