import React, { useEffect, useMemo, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

// 1 รายการที่คลังต้องนับ (ลิงก์แบบชุดมีหลายตัว · ลิงก์เก่าแบบรายการเดียวมีตัวเดียว)
interface Item {
  report_id: string; product_name: string; group_name?: string;
  machine?: string; count_unit: string; prod_qty: number;
}
interface Head {
  type: 'batch' | 'single';
  batch_id?: string; report_id?: string;
  date: string; shift: string; reporter_name: string; expires_at: string;
}
interface Diff { report_id: string; product_name: string; count_unit: string; prod_qty: number; wh_qty: number; variance_qty: number }
type Phase = 'loading' | 'form' | 'confirm' | 'done' | 'gone';

const wrap: React.CSSProperties = {
  minHeight: '100vh', background: '#faf7f4', color: '#2b2119',
  fontFamily: "'Sarabun', -apple-system, BlinkMacSystemFont, sans-serif",
  padding: '18px 14px 120px',
};
const card: React.CSSProperties = { maxWidth: 440, margin: '0 auto', background: '#fff', border: '1px solid #eee3d9', borderRadius: 18, padding: 20, boxShadow: '0 6px 18px -6px rgba(63,37,10,.12)' };
const lb: React.CSSProperties = { display: 'block', fontSize: '0.78rem', color: '#6d6259', fontWeight: 'bold', marginBottom: 4 };
const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '11px 12px', borderRadius: 11, border: '1px solid #ddd4c9', fontSize: '1rem', background: '#fffdfa', color: '#2b2119' };
const btn: React.CSSProperties = { width: '100%', border: 'none', borderRadius: 12, padding: 14, fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer', color: '#fff', background: 'linear-gradient(135deg,#ff8a3c,#c24f00)' };
const kv: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', padding: '5px 0', borderBottom: '1px dashed #eee3d9' };

const WarehouseVerifyPage: React.FC<{ token: string }> = ({ token }) => {
  const [phase, setPhase] = useState<Phase>('loading');
  const [head, setHead] = useState<Head | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [msg, setMsg] = useState('');
  const [slow, setSlow] = useState(false);

  const draftKey = `wh_draft_${token}`;
  // เลขที่กรอก เก็บเป็น map report_id → ค่า (เก็บลงเครื่องก่อนส่ง กัน wifi คลังหลุด)
  const [qty, setQty] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(draftKey) || '{}'); } catch { return {}; }
  });
  const [name, setName] = useState(() => localStorage.getItem('wh_name') || '');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [diffs, setDiffs] = useState<Diff[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ matched: number; diff_count: number } | null>(null);

  // โหลดรายการ — Render free tier อาจหลับอยู่ จึงลองซ้ำได้ถึง ~40 วิ
  useEffect(() => {
    let alive = true, tries = 0;
    const slowTimer = setTimeout(() => alive && setSlow(true), 4000);
    const load = async () => {
      try {
        const r = await fetch(`${apiUrl}/api/production/verify/${token}`);
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.ok) {
          if (d.type === 'batch') {
            setHead({ type: 'batch', batch_id: d.batch_id, date: d.date, shift: d.shift, reporter_name: d.reporter_name, expires_at: d.expires_at });
            setItems(d.items || []);
          } else {
            // ลิงก์เก่าแบบรายการเดียว — ทำให้เป็นชุดที่มีสมาชิกตัวเดียว จะได้ใช้จอเดียวกัน
            setHead({ type: 'single', report_id: d.report_id, date: d.date, shift: d.shift, reporter_name: d.reporter_name, expires_at: d.expires_at });
            setItems([{ report_id: d.report_id, product_name: d.product_name, group_name: d.group_name, count_unit: d.count_unit, prod_qty: d.prod_qty }]);
          }
          setPhase('form'); return;
        }
        if (r.status === 409) { setMsg(`ยืนยันไปแล้ว${d.wh_name ? ` โดย ${d.wh_name}` : ''}${d.submitted_at ? ` เมื่อ ${String(d.submitted_at).replace('T', ' ')}` : ''}`); setPhase('gone'); return; }
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

  const setOne = (id: string, v: string) => setQty(q => {
    const next = { ...q, [id]: v };
    try { localStorage.setItem(draftKey, JSON.stringify(next)); } catch { /* ข้าม */ }
    return next;
  });

  // สรุปความคืบหน้า — กรอกครบไหม ตรงกี่รายการ ต่างกี่รายการ
  const stat = useMemo(() => {
    let filled = 0, match = 0, diff = 0;
    for (const it of items) {
      const v = qty[it.report_id];
      if (v == null || String(v).trim() === '') continue;
      filled++;
      (Number(v) === Number(it.prod_qty) ? match++ : diff++);
    }
    return { filled, match, diff, total: items.length, complete: filled === items.length && items.length > 0 };
  }, [items, qty]);

  const send = async (confirmVariance: boolean) => {
    if (!name.trim()) { alert('กรุณาระบุชื่อผู้ตรวจนับ'); return; }
    if (!stat.complete) { alert(`ยังกรอกไม่ครบ (${stat.filled}/${stat.total} รายการ)`); return; }
    localStorage.setItem('wh_name', name.trim());
    setSending(true);
    try {
      const body = head?.type === 'batch'
        ? {
            wh_name: name.trim(), confirm_variance: confirmVariance,
            items: items.map(it => ({
              report_id: it.report_id, wh_qty: Number(qty[it.report_id]),
              wh_note: note.trim(), variance_reason: reason.trim(),
            })),
          }
        : {
            wh_qty: Number(qty[items[0].report_id]), wh_name: name.trim(), wh_note: note.trim(),
            confirm_variance: confirmVariance, variance_reason: reason.trim(),
          };
      const r = await fetch(`${apiUrl}/api/production/verify/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.needs_confirm) {
        // แบบชุดคืน diffs[] · แบบรายการเดียวคืน variance_qty ตัวเดียว
        setDiffs(d.diffs || [{
          report_id: items[0].report_id, product_name: items[0].product_name, count_unit: items[0].count_unit,
          prod_qty: items[0].prod_qty, wh_qty: Number(qty[items[0].report_id]), variance_qty: d.variance_qty,
        }]);
        setPhase('confirm'); return;
      }
      if (!r.ok) {
        alert(`❌ ${d.error || 'ส่งไม่สำเร็จ'}`);
        if (r.status === 409 || r.status === 410) { setMsg(d.error); setPhase('gone'); }
        return;
      }
      try { localStorage.removeItem(draftKey); } catch { /* ข้าม */ }
      setResult({ matched: d.matched ?? (d.variance_qty === 0 ? 1 : 0), diff_count: d.diff_count ?? (d.variance_qty === 0 ? 0 : 1) });
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
      <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: '#1c8a4c', marginTop: 4 }}>
        บันทึกยอดของคลังแล้ว {items.length} รายการ
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 12 }}>
        <div style={{ background: '#e6f4ec', color: '#1c8a4c', borderRadius: 12, padding: '8px 16px' }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{result?.matched ?? 0}</div>
          <div style={{ fontSize: '0.75rem' }}>ตรงกัน</div>
        </div>
        <div style={{ background: (result?.diff_count ?? 0) ? '#fdeaea' : '#f4efe9', color: (result?.diff_count ?? 0) ? '#c62828' : '#8a8078', borderRadius: 12, padding: '8px 16px' }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{result?.diff_count ?? 0}</div>
          <div style={{ fontSize: '0.75rem' }}>ไม่ตรง</div>
        </div>
      </div>
      <div style={{ fontSize: '0.82rem', color: '#6d6259', marginTop: 14 }}>ส่งให้หัวหน้างานอนุมัติแล้ว — ปิดหน้านี้ได้เลย</div>
    </div></div>
  );

  // ── จอยืนยันส่วนต่าง ──
  if (phase === 'confirm') return (
    <div style={wrap}>
      <div style={{ ...card, border: '1px solid #f2c9c9', background: '#fff7f7' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem' }}>⚠️</div>
          <div style={{ fontWeight: 'bold', fontSize: '1.05rem', color: '#c62828' }}>
            มี {diffs.length} รายการที่ตัวเลขไม่ตรง
          </div>
          <div style={{ fontSize: '0.8rem', color: '#6d6259', marginTop: 2 }}>
            อีก {items.length - diffs.length} รายการตรงกับที่ฝ่ายผลิตแจ้ง
          </div>
        </div>

        <div style={{ margin: '14px 0' }}>
          {diffs.map(d => (
            <div key={d.report_id} style={{ background: '#fff', border: '1px solid #f2c9c9', borderRadius: 12, padding: 10, marginBottom: 8 }}>
              <div style={{ fontWeight: 'bold', fontSize: '0.88rem', marginBottom: 4 }}>{d.product_name}</div>
              <div style={kv}><span>ฝ่ายผลิตแจ้ง</span><b>{d.prod_qty} {d.count_unit}</b></div>
              <div style={{ ...kv, borderBottom: 'none' }}><span>คลังนับได้</span><b style={{ color: '#1565c0' }}>{d.wh_qty} {d.count_unit}</b></div>
              <div style={{ textAlign: 'center', fontSize: '1.3rem', fontWeight: 'bold', color: '#c62828', marginTop: 4 }}>
                {d.variance_qty > 0 ? '+' : ''}{d.variance_qty} {d.count_unit}
              </div>
            </div>
          ))}
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
          {sending ? '⏳ กำลังส่ง…' : `ยืนยันยอดของคลังทั้ง ${items.length} รายการ`}
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
      <div style={{ maxWidth: 440, margin: '0 auto' }}>
        <div style={{ ...card, marginBottom: 12, textAlign: 'center' }}>
          <div style={{ fontSize: '1.8rem' }}>📦</div>
          <h1 style={{ fontSize: '1.15rem', margin: '4px 0 2px' }}>ยืนยันยอดรับเข้าคลัง</h1>
          <div style={{ fontSize: '0.82rem', color: '#6d6259' }}>
            {head?.date} · {head?.shift} · <b>{items.length} รายการ</b>
          </div>
          <div style={{ fontSize: '0.78rem', color: '#8a8078', marginTop: 2 }}>ผู้ลงยอด: {head?.reporter_name}</div>
        </div>

        {items.map((it, n) => {
          const v = qty[it.report_id] ?? '';
          const filled = String(v).trim() !== '';
          const same = filled && Number(v) === Number(it.prod_qty);
          return (
            <div key={it.report_id} style={{
              ...card, marginBottom: 10, padding: 14,
              borderColor: !filled ? '#eee3d9' : same ? '#cfe8d8' : '#f2c9c9',
              background: !filled ? '#fff' : same ? '#f8fdfa' : '#fff7f7',
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: '0.75rem', color: '#8a8078', fontWeight: 'bold' }}>{n + 1}.</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 'bold', fontSize: '0.92rem', lineHeight: 1.35 }}>{it.product_name}</div>
                  {it.machine && <div style={{ fontSize: '0.72rem', color: '#8a8078' }}>{it.machine}</div>}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: '0 0 auto', background: '#fff3ea', border: '1px solid #f6dcc4', borderRadius: 11, padding: '7px 11px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.68rem', color: '#c24f00', fontWeight: 'bold' }}>ผลิตแจ้ง</div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 'bold', color: '#c24f00', lineHeight: 1.2 }}>{it.prod_qty}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ ...lb, marginBottom: 2 }}>คลังนับได้ ({it.count_unit})</label>
                  <input
                    inputMode="numeric" value={v} onChange={e => setOne(it.report_id, e.target.value)}
                    placeholder="—"
                    style={{ ...inp, textAlign: 'center', fontSize: '1.5rem', fontWeight: 'bold', padding: 8,
                      border: `2px solid ${!filled ? '#ddd4c9' : same ? '#1c8a4c' : '#c62828'}`, borderRadius: 12 }}
                  />
                </div>
              </div>
              {filled && !same && (
                <div style={{ fontSize: '0.78rem', color: '#c62828', fontWeight: 'bold', textAlign: 'right', marginTop: 5 }}>
                  ต่าง {Number(v) - Number(it.prod_qty) > 0 ? '+' : ''}{Number(v) - Number(it.prod_qty)} {it.count_unit}
                </div>
              )}
            </div>
          );
        })}

        <div style={{ ...card, marginBottom: 12 }}>
          <label style={lb}>ผู้ตรวจนับ *</label>
          <input style={{ ...inp, marginBottom: 10 }} value={name} onChange={e => setName(e.target.value)} placeholder="ชื่อผู้นับ" />
          <label style={lb}>หมายเหตุ (ถ้ามี)</label>
          <input style={inp} value={note} onChange={e => setNote(e.target.value)} placeholder="เช่น รับเข้า 2 รอบ" />
        </div>

        <p style={{ textAlign: 'center', fontSize: '0.74rem', color: '#8a8078' }}>
          กรอกจำนวนที่นับได้จริง ไม่ต้องกรอกให้ตรงกับที่ผลิตแจ้ง · ฝ่ายผลิตแก้เลขนี้ไม่ได้
        </p>
      </div>

      {/* แถบสรุปติดล่างจอ — เห็นความคืบหน้าตลอดเวลาที่ไล่กรอก */}
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, background: 'rgba(255,255,255,.97)',
        borderTop: '1px solid #eee3d9', padding: '10px 14px', boxShadow: '0 -4px 16px -8px rgba(63,37,10,.3)',
      }}>
        <div style={{ maxWidth: 440, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: 7 }}>
            <span style={{ fontWeight: 'bold' }}>กรอกแล้ว {stat.filled}/{stat.total}</span>
            <span>
              <span style={{ color: '#1c8a4c', fontWeight: 'bold' }}>ตรง {stat.match}</span>
              {' · '}
              <span style={{ color: stat.diff ? '#c62828' : '#8a8078', fontWeight: 'bold' }}>ต่าง {stat.diff}</span>
            </span>
          </div>
          <button onClick={() => send(false)} disabled={sending || !stat.complete}
            style={{ ...btn, background: sending || !stat.complete ? '#d6d0c8' : btn.background, cursor: stat.complete ? 'pointer' : 'not-allowed', padding: 13 }}>
            {sending ? '⏳ กำลังส่ง…' : stat.complete ? `✅ ยืนยันยอดของคลัง (${stat.total} รายการ)` : `ยังกรอกไม่ครบ (เหลือ ${stat.total - stat.filled})`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WarehouseVerifyPage;
