import React, { useEffect, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

interface Report {
  report_id: string; date: string; shift: string;
  product_name: string; group_name?: string;
  count_unit: string; prod_qty: number; reporter_name: string; expires_at: string;
}
type Phase = 'loading' | 'form' | 'confirm' | 'done' | 'gone';

const wrap: React.CSSProperties = {
  minHeight: '100vh', background: '#faf7f4', color: '#2b2119',
  fontFamily: "'Sarabun', -apple-system, BlinkMacSystemFont, sans-serif",
  padding: '18px 14px 40px',
};
const card: React.CSSProperties = { maxWidth: 420, margin: '0 auto', background: '#fff', border: '1px solid #eee3d9', borderRadius: 18, padding: 20, boxShadow: '0 6px 18px -6px rgba(63,37,10,.12)' };
const lb: React.CSSProperties = { display: 'block', fontSize: '0.78rem', color: '#6d6259', fontWeight: 'bold', marginBottom: 4 };
const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '11px 12px', borderRadius: 11, border: '1px solid #ddd4c9', fontSize: '1rem', background: '#fffdfa', color: '#2b2119' };
const btn: React.CSSProperties = { width: '100%', border: 'none', borderRadius: 12, padding: 14, fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer', color: '#fff', background: 'linear-gradient(135deg,#ff8a3c,#c24f00)' };
const kv: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', padding: '5px 0', borderBottom: '1px dashed #eee3d9' };

const WarehouseVerifyPage: React.FC<{ token: string }> = ({ token }) => {
  const [phase, setPhase] = useState<Phase>('loading');
  const [rep, setRep] = useState<Report | null>(null);
  const [msg, setMsg] = useState('');
  const [slow, setSlow] = useState(false);

  const draftKey = `wh_draft_${token}`;
  const [qty, setQty] = useState(() => localStorage.getItem(draftKey) || '');
  const [name, setName] = useState(() => localStorage.getItem('wh_name') || '');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [diff, setDiff] = useState(0);
  const [sending, setSending] = useState(false);

  // โหลดรายการ — Render free tier อาจหลับอยู่ จึงลองซ้ำได้ถึง ~40 วิ
  useEffect(() => {
    let alive = true, tries = 0;
    const slowTimer = setTimeout(() => alive && setSlow(true), 4000);
    const load = async () => {
      try {
        const r = await fetch(`${apiUrl}/api/production/verify/${token}`);
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.ok) { setRep(d); setPhase('form'); return; }
        if (r.status === 409) { setMsg(`รายการนี้ยืนยันไปแล้ว${d.wh_name ? ` โดย ${d.wh_name}` : ''}${d.wh_qty != null ? ` (${d.wh_qty})` : ''}`); setPhase('gone'); return; }
        if (r.status === 410) { setMsg('ลิงก์หมดอายุแล้ว — ขอลิงก์ใหม่จากฝ่ายผลิต'); setPhase('gone'); return; }
        if (r.status === 404) { setMsg('ไม่พบลิงก์นี้ (อาจถูกออกใหม่ไปแล้ว)'); setPhase('gone'); return; }
        throw new Error(d.error || 'โหลดไม่สำเร็จ');
      } catch {
        if (!alive) return;
        if (++tries < 8) setTimeout(load, 5000);   // ~40 วินาที
        else { setMsg('เชื่อมต่อระบบไม่ได้ — ลองรีเฟรชอีกครั้ง'); setPhase('gone'); }
      }
    };
    load();
    return () => { alive = false; clearTimeout(slowTimer); };
  }, [token]);

  const send = async (confirmVariance: boolean) => {
    if (qty.trim() === '') { alert('กรุณากรอกจำนวนที่นับได้'); return; }
    if (!name.trim()) { alert('กรุณาระบุชื่อผู้ตรวจนับ'); return; }
    // เก็บก่อนยิง — เน็ตคลังหลุดแล้วไม่ต้องพิมพ์ใหม่
    localStorage.setItem(draftKey, qty);
    localStorage.setItem('wh_name', name.trim());
    setSending(true);
    try {
      const r = await fetch(`${apiUrl}/api/production/verify/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wh_qty: Number(qty), wh_name: name.trim(), wh_note: note.trim(),
          confirm_variance: confirmVariance, variance_reason: reason.trim(),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.needs_confirm) { setDiff(d.variance_qty); setPhase('confirm'); return; }
      if (!r.ok) { alert(`❌ ${d.error || 'ส่งไม่สำเร็จ'}`); if (r.status === 409 || r.status === 410) { setMsg(d.error); setPhase('gone'); } return; }
      localStorage.removeItem(draftKey);
      setDiff(d.variance_qty ?? 0);
      setPhase('done');
    } catch {
      alert('❌ ส่งไม่สำเร็จ — ตรวจสัญญาณแล้วลองใหม่ (ตัวเลขที่กรอกถูกเก็บไว้แล้ว)');
    } finally { setSending(false); }
  };

  if (phase === 'loading') return (
    <div style={wrap}><div style={{ ...card, textAlign: 'center' }}>
      <div style={{ fontSize: '2rem' }}>⏳</div>
      <div style={{ fontWeight: 'bold', marginTop: 6 }}>กำลังโหลด…</div>
      {slow && <div style={{ fontSize: '0.82rem', color: '#6d6259', marginTop: 6 }}>กำลังปลุกระบบ อาจใช้เวลาสักครู่ (ไม่เกิน 40 วินาที)</div>}
    </div></div>
  );

  if (phase === 'gone') return (
    <div style={wrap}><div style={{ ...card, textAlign: 'center' }}>
      <div style={{ fontSize: '2.2rem' }}>🔒</div>
      <div style={{ fontWeight: 'bold', fontSize: '1.05rem', marginTop: 6 }}>{msg}</div>
      <div style={{ fontSize: '0.82rem', color: '#6d6259', marginTop: 8 }}>ถ้าคิดว่าผิดพลาด แจ้งฝ่ายผลิตให้ส่งลิงก์ใหม่ได้เลย</div>
    </div></div>
  );

  if (phase === 'done') return (
    <div style={wrap}><div style={{ ...card, textAlign: 'center', border: '2px solid #a5d6a7' }}>
      <div style={{ fontSize: '2.4rem' }}>✅</div>
      <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: '#1c8a4c', marginTop: 4 }}>บันทึกยอดของคลังแล้ว</div>
      <div style={{ fontSize: '0.9rem', marginTop: 8 }}>{rep?.product_name} · <b>{qty} {rep?.count_unit}</b></div>
      <div style={{ fontSize: '0.85rem', color: diff === 0 ? '#1c8a4c' : '#c62828', fontWeight: 'bold', marginTop: 4 }}>
        {diff === 0 ? 'ตรงกับที่ฝ่ายผลิตแจ้ง' : `ต่างจากที่ฝ่ายผลิตแจ้ง ${diff > 0 ? '+' : ''}${diff} ${rep?.count_unit}`}
      </div>
      <div style={{ fontSize: '0.82rem', color: '#6d6259', marginTop: 10 }}>ส่งให้หัวหน้างานอนุมัติแล้ว — ปิดหน้านี้ได้เลย</div>
    </div></div>
  );

  // ── จอยืนยันส่วนต่าง ──
  if (phase === 'confirm') return (
    <div style={wrap}>
      <div style={{ ...card, border: '1px solid #f2c9c9', background: '#fff7f7' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem' }}>⚠️</div>
          <div style={{ fontWeight: 'bold', fontSize: '1.05rem', color: '#c62828' }}>ตัวเลขไม่ตรงกัน</div>
        </div>
        <div style={{ margin: '14px 0' }}>
          <div style={kv}><span>ฝ่ายผลิตแจ้ง</span><b>{rep?.prod_qty} {rep?.count_unit}</b></div>
          <div style={{ ...kv, borderBottom: 'none' }}><span>คลังนับได้</span><b style={{ color: '#1565c0' }}>{qty} {rep?.count_unit}</b></div>
        </div>
        <div style={{ textAlign: 'center', fontSize: '1.8rem', fontWeight: 'bold', color: '#c62828', marginBottom: 12 }}>
          {diff > 0 ? '+' : ''}{diff} {rep?.count_unit}
        </div>
        <label style={lb}>สาเหตุส่วนต่าง</label>
        <select style={{ ...inp, marginBottom: 8 }} value={reason} onChange={e => setReason(e.target.value)}>
          <option value="">-- เลือกสาเหตุ --</option>
          <option value="ยังส่งไม่ครบ / ค้างที่ไลน์">ยังส่งไม่ครบ / ค้างที่ไลน์</option>
          <option value="สินค้าชำรุดระหว่างขนย้าย">สินค้าชำรุดระหว่างขนย้าย</option>
          <option value="นับรวมรอบถัดไป">นับรวมรอบถัดไป</option>
          <option value="อื่น ๆ">อื่น ๆ</option>
        </select>
        <input style={{ ...inp, marginBottom: 14 }} placeholder="รายละเอียดเพิ่มเติม (ถ้ามี)" value={note} onChange={e => setNote(e.target.value)} />
        <button onClick={() => send(true)} disabled={sending} style={{ ...btn, background: sending ? '#bdbdbd' : 'linear-gradient(135deg,#e57373,#c62828)' }}>
          {sending ? '⏳ กำลังส่ง…' : `ยืนยันยอดของคลัง ${qty} ${rep?.count_unit}`}
        </button>
        <button onClick={() => setPhase('form')} style={{ ...btn, background: '#fff', color: '#2b2119', border: '1px solid #ddd4c9', marginTop: 8 }}>
          ← กลับไปแก้ตัวเลข
        </button>
      </div>
    </div>
  );

  // ── จอกรอกหลัก ──
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: '1.8rem' }}>📦</div>
          <h1 style={{ fontSize: '1.15rem', margin: '4px 0 2px' }}>ยืนยันยอดรับเข้าคลัง</h1>
          <div style={{ fontSize: '0.78rem', color: '#6d6259' }}>{rep?.report_id} · {rep?.date} · {rep?.shift}</div>
        </div>

        <div style={{ background: '#fff3ea', border: '1px solid #f6dcc4', borderRadius: 14, padding: 14, textAlign: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: '0.8rem', color: '#c24f00', fontWeight: 'bold' }}>ฝ่ายผลิตแจ้งว่าส่งมา</div>
          <div style={{ fontSize: '2.2rem', fontWeight: 'bold', color: '#c24f00', lineHeight: 1.1 }}>
            {rep?.prod_qty} <span style={{ fontSize: '1rem' }}>{rep?.count_unit}</span>
          </div>
          <div style={{ fontSize: '0.78rem', color: '#6d6259', marginTop: 2 }}>{rep?.product_name} · โดย {rep?.reporter_name}</div>
        </div>

        <label style={{ ...lb, textAlign: 'center', fontSize: '0.9rem', color: '#2b2119' }}>คลังนับได้กี่{rep?.count_unit}?</label>
        <input
          inputMode="numeric" value={qty} onChange={e => setQty(e.target.value)}
          style={{ ...inp, textAlign: 'center', fontSize: '2rem', fontWeight: 'bold', padding: 10, border: '2px solid #ff6b00', borderRadius: 14 }}
        />
        <p style={{ textAlign: 'center', fontSize: '0.76rem', color: '#6d6259', margin: '6px 0 14px' }}>
          กรอกจำนวนที่นับได้จริง ไม่ต้องกรอกให้ตรงกับที่ผลิตแจ้ง
        </p>

        <label style={lb}>ผู้ตรวจนับ *</label>
        <input style={{ ...inp, marginBottom: 10 }} value={name} onChange={e => setName(e.target.value)} placeholder="ชื่อผู้นับ" />
        <label style={lb}>หมายเหตุ (ถ้ามี)</label>
        <input style={{ ...inp, marginBottom: 16 }} value={note} onChange={e => setNote(e.target.value)} placeholder="เช่น รับเข้า 2 รอบ" />

        <button onClick={() => send(false)} disabled={sending} style={{ ...btn, background: sending ? '#bdbdbd' : btn.background }}>
          {sending ? '⏳ กำลังส่ง…' : '✅ ยืนยันยอดของคลัง'}
        </button>
        <p style={{ textAlign: 'center', fontSize: '0.72rem', color: '#8a8078', marginTop: 10 }}>
          กดแล้วเลขจะถูกบันทึกทันที · ฝ่ายผลิตแก้เลขนี้ไม่ได้
        </p>
      </div>
    </div>
  );
};

export default WarehouseVerifyPage;
