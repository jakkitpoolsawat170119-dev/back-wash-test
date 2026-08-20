import React, { useCallback, useEffect, useState } from 'react';
import { authHeaders, authRole } from '../lib/auth';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/* ── ต้นทุนรวมต่อ batch (ERP เฟส 3) ─────────────────────────────────────────
   ต้นทุน 1 batch = ค่าวัสดุที่เบิกไปใช้ (คลังวัสดุ) + ค่าเสียโอกาสจากเวลาเครื่องหยุด (เหตุการณ์)
   ผูกกันด้วยเลข batch ที่คนกรอกไว้ทั้งสองที่ — พิมพ์ตัวใหญ่/เล็กต่างกันถือเป็นก้อนเดียวกัน  */
type Batch = {
  batchRef: string; materialCost: number; materialItems: number;
  downtimeMin: number; downtimeCost: number; incidents: number; openDowntime: number;
  machines: string[]; firstAt: string; total: number;
};
type Report = {
  from: string; to: string; batches: Batch[];
  totalMaterial: number; totalDowntime: number; totalCost: number; unassignedMaterialCost: number;
};
type Detail = {
  batchRef: string; materialCost: number; downtimeCost: number; downtimeMin: number; total: number;
  moves: { id: number; name: string; unit: string; qty: number; unitCost: number; cost: number; operator: string; movedAt: string }[];
  incidents: { id: number; title: string; machine: string; minutes: number | null; ratePerHour: number; cost: number; downFrom: string; downTo: string }[];
};
type Cfg = { downtimePerHour: number; machines: { id: number; name: string; downtimeCost: number | null }[] };

const baht = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 2 });
const hhmm = (min: number) => (Math.floor(min / 60) ? `${Math.floor(min / 60)} ชม. ` : '') + `${min % 60} น.`;

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
const lbl: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' };
const th: React.CSSProperties = { textAlign: 'right', fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)', padding: '6px 8px', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { textAlign: 'right', fontSize: 13, padding: '8px', whiteSpace: 'nowrap' };

const CostBoard: React.FC = () => {
  const [to, setTo] = useState(todayBKK());
  const [from, setFrom] = useState(shiftDay(todayBKK(), -29));
  const [data, setData] = useState<Report | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [open, setOpen] = useState('');              // batchRef ที่กางรายละเอียดอยู่
  const [detail, setDetail] = useState<Detail | null>(null);
  const [rateOpen, setRateOpen] = useState(false);
  const [rateInput, setRateInput] = useState('');
  const [msg, setMsg] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const canEdit = ['supervisor', 'admin'].includes(authRole());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [d, c] = await Promise.all([
          fetch(`${apiUrl}/api/cost/batches?from=${from}&to=${to}`).then(r => r.json()),
          fetch(`${apiUrl}/api/cost/config`).then(r => r.json()),
        ]);
        if (!alive) return;
        setData(d && Array.isArray(d.batches) ? d : null);
        if (c && Array.isArray(c.machines)) { setCfg(c); setRateInput(String(c.downtimePerHour || '')); }
      } catch { if (alive) setData(null); }
    })();
    return () => { alive = false; };
  }, [from, to, refreshKey]);

  const openBatch = useCallback((ref: string) => {
    setDetail(null);
    setOpen(cur => (cur === ref ? '' : ref));
  }, []);

  // รายละเอียดของ batch ที่กางอยู่ — โหลดใหม่เมื่อเปลี่ยนอัตราด้วย (refreshKey)
  // ไม่งั้นตารางข้างบนอัปเดตตามอัตราใหม่ แต่ตัวเลขในกล่องที่กางอยู่ยังเป็นของเก่า
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const d = await fetch(`${apiUrl}/api/cost/batch?ref=${encodeURIComponent(open)}`).then(r => r.json());
        if (alive) setDetail(d && Array.isArray(d.moves) ? d : null);
      } catch { if (alive) setDetail(null); }
    })();
    return () => { alive = false; };
  }, [open, refreshKey]);

  const saveRate = async (body: Record<string, unknown>, ok: string) => {
    try {
      const r = await fetch(`${apiUrl}/api/cost/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'บันทึกไม่สำเร็จ'}`); return; }
      setMsg(`✅ ${ok}`);
      setRefreshKey(k => k + 1);
    } catch { setMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); }
  };

  const noRate = !cfg || !cfg.downtimePerHour;
  const worst = data?.batches[0];

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#0d47a1',
        background: '#e8f1fb', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>💰 ต้นทุน</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          ต้นทุนต่อ batch
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>ค่าวัสดุที่เบิก + ค่าเวลาที่เครื่องหยุด</span>
        <span style={{ flex: 1 }} />
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>ถึง</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        <button onClick={() => setRefreshKey(k => k + 1)} style={btn}>🔄</button>
      </div>
      {msg && <div style={{ fontSize: 12.5, marginBottom: 10, color: msg.startsWith('✅') ? '#1c8a4c' : '#c62828' }}>{msg}</div>}

      {/* ── อัตราค่าเสียโอกาส ── */}
      <div style={{ ...card, padding: '12px 16px', marginBottom: 14, ...(noRate ? { borderColor: '#f0dcc8', background: '#fdf6ee' } : {}) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ ...lbl }}>ค่าเสียโอกาสเมื่อเครื่องหยุด</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
              {noRate
                ? <>⚠️ ยังไม่ได้ตั้งอัตรา — ค่าเวลาเสียจะถูกคิดเป็น 0 ทุก batch</>
                : <>ค่ากลาง <b>{baht(cfg!.downtimePerHour)} บาท/ชม.</b>
                    {cfg!.machines.some(m => m.downtimeCost != null) && <> · มีเครื่องที่ตั้งเฉพาะตัวไว้ {cfg!.machines.filter(m => m.downtimeCost != null).length} เครื่อง</>}</>}
            </div>
          </div>
          {canEdit && <button onClick={() => setRateOpen(v => !v)} style={btn}>{rateOpen ? 'ปิด' : '⚙️ ตั้งอัตรา'}</button>}
        </div>
        {rateOpen && canEdit && cfg && (
          <div style={{ marginTop: 12, borderTop: '1px dashed var(--line,#eee3d9)', paddingTop: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={lbl}>ค่ากลาง (บาท/ชม.)</span>
              <input type="number" value={rateInput} onChange={e => setRateInput(e.target.value)}
                style={{ ...inp, width: 130 }} />
              <button onClick={() => saveRate({ downtimePerHour: Number(rateInput) }, 'บันทึกค่ากลางแล้ว')}
                style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>บันทึก</button>
              <span style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
                ใช้กับทุกเครื่องที่ไม่ได้ตั้งเฉพาะตัวไว้
              </span>
            </div>
            <div style={{ ...lbl, marginBottom: 6 }}>ตั้งเฉพาะเครื่อง (เว้นว่าง = ใช้ค่ากลาง)</div>
            <div style={{ display: 'grid', gap: 7, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
              {cfg.machines.map(m => (
                <div key={m.id} style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                  <input type="number" defaultValue={m.downtimeCost ?? ''} placeholder="ค่ากลาง"
                    onBlur={e => {
                      const v = e.target.value.trim();
                      const cur = m.downtimeCost == null ? '' : String(m.downtimeCost);
                      if (v !== cur) saveRate({ machineId: m.id, downtimeCost: v === '' ? null : Number(v) }, `ตั้งอัตราของ ${m.name} แล้ว`);
                    }}
                    style={{ ...inp, width: 110 }} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── ตัวเลขรวม ── */}
      {data && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', marginBottom: 14 }}>
          {([
            ['ต้นทุนรวมทั้งช่วง', `${baht(data.totalCost)} บาท`, `${data.batches.length} batch`],
            ['ค่าวัสดุ', `${baht(data.totalMaterial)} บาท`, data.unassignedMaterialCost ? `+ ${baht(data.unassignedMaterialCost)} ที่ไม่ระบุ batch` : 'ระบุ batch ครบทุกใบ'],
            ['ค่าเวลาที่เครื่องหยุด', `${baht(data.totalDowntime)} บาท`, worst ? `แพงสุด: ${worst.batchRef}` : ''],
          ] as [string, string, string][]).map(([k, v, sub]) => (
            <div key={k} style={{ ...card, padding: '12px 16px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', fontWeight: 600 }}>{k}</div>
              <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 20, fontWeight: 600, color: '#c24f00', lineHeight: 1.35 }}>{v}</div>
              {sub && <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>{sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* ── ตาราง batch ── */}
      <div style={{ ...card, padding: '14px 16px', overflowX: 'auto' }}>
        {!data || data.batches.length === 0 ? (
          <div style={{ fontSize: 13, color: '#a89e94', lineHeight: 1.8 }}>
            ยังไม่มี batch ที่คิดต้นทุนได้ในช่วงนี้
            <br />ต้องมีอย่างน้อยหนึ่งอย่าง: <b>เบิกวัสดุแล้วใส่เลข batch</b> (หน้าคลังวัสดุ)
            หรือ <b>บันทึกเหตุการณ์ที่ใส่ทั้ง Batch และเวลาเครื่องหยุด</b> (หน้าเหตุการณ์)
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line,#eee3d9)' }}>
                <th style={{ ...th, textAlign: 'left' }}>Batch</th>
                <th style={th}>ค่าวัสดุ</th>
                <th style={th}>เวลาที่หยุด</th>
                <th style={th}>ค่าเวลาเสีย</th>
                <th style={th}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {data.batches.map(b => (
                <React.Fragment key={b.batchRef}>
                  <tr onClick={() => openBatch(b.batchRef)} title="กดดูรายละเอียด"
                    style={{ borderBottom: '1px solid #f6efe8', cursor: 'pointer', background: open === b.batchRef ? '#fff3ea' : 'transparent' }}>
                    <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
                      <div style={{ fontWeight: 700 }}>🧾 {b.batchRef}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
                        {b.materialItems > 0 && <>เบิก {b.materialItems} รายการ</>}
                        {b.incidents > 0 && <>{b.materialItems > 0 ? ' · ' : ''}{b.incidents} เหตุการณ์</>}
                        {b.machines.length > 0 && <> · {b.machines.join(', ')}</>}
                        {b.openDowntime > 0 && <span style={{ color: '#c62828' }}> · 🔴 ยังหยุดอยู่ {b.openDowntime}</span>}
                      </div>
                    </td>
                    <td style={td}>{b.materialCost ? baht(b.materialCost) : '—'}</td>
                    <td style={td}>{b.downtimeMin ? hhmm(b.downtimeMin) : '—'}</td>
                    <td style={td}>{b.downtimeCost ? baht(b.downtimeCost) : '—'}</td>
                    <td style={{ ...td, fontWeight: 700, color: '#c24f00' }}>{baht(b.total)}</td>
                  </tr>
                  {open === b.batchRef && (
                    <tr>
                      <td colSpan={5} style={{ padding: '4px 8px 14px' }}>
                        {!detail ? <div style={{ fontSize: 12.5, color: '#a89e94' }}>กำลังโหลด…</div> : (
                          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
                            <div style={{ background: '#fbf7f3', borderRadius: 10, padding: '9px 11px' }}>
                              <div style={{ ...lbl, marginBottom: 5 }}>📤 วัสดุที่เบิก ({detail.moves.length})</div>
                              {detail.moves.length === 0 && <div style={{ fontSize: 12.5, color: '#a89e94' }}>ไม่มี</div>}
                              {detail.moves.map(m => (
                                <div key={m.id} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '3px 0' }}>
                                  <span style={{ flex: 1, minWidth: 0 }}>{m.name} {m.qty} {m.unit}</span>
                                  <span style={{ color: 'var(--ink-soft,#6d6259)' }}>{String(m.movedAt).slice(5, 16).replace('T', ' ')}</span>
                                  <b>{baht(m.cost)}</b>
                                </div>
                              ))}
                            </div>
                            <div style={{ background: '#fbf7f3', borderRadius: 10, padding: '9px 11px' }}>
                              <div style={{ ...lbl, marginBottom: 5 }}>⏱ เวลาที่เครื่องหยุด ({detail.incidents.length})</div>
                              {detail.incidents.length === 0 && <div style={{ fontSize: 12.5, color: '#a89e94' }}>ไม่มี</div>}
                              {detail.incidents.map(i => (
                                <div key={i.id} style={{ fontSize: 12.5, padding: '3px 0' }}>
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <span style={{ flex: 1, minWidth: 0 }}>{i.title}</span>
                                    <b>{i.minutes == null ? '—' : baht(i.cost)}</b>
                                  </div>
                                  <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
                                    🔩 {i.machine || 'ไม่ระบุเครื่อง'}
                                    {i.minutes == null ? ' · ยังไม่ได้กรอกเวลากลับมาเดิน' : ` · ${hhmm(i.minutes)} @ ${baht(i.ratePerHour)} บ./ชม.`}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.unassignedMaterialCost > 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-soft,#6d6259)', marginTop: 12, lineHeight: 1.7 }}>
          ℹ️ ช่วงนี้มีวัสดุที่เบิกโดย<b>ไม่ระบุเลข batch</b> อีก {baht(data.unassignedMaterialCost)} บาท — ยังไม่ถูกคิดเข้า batch ไหน
          <br />ถ้าอยากให้ต้นทุนครบ ตอนเบิกของให้ใส่ช่อง “เบิกใช้กับ batch ไหน” ทุกครั้ง
        </div>
      )}
    </div>
  );
};

export default CostBoard;
