import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { authHeaders, authRole } from '../lib/auth';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/* ── คลังวัสดุ/สารเคมี (ERP เฟส 2 ในแผน) ─────────────────────────────────────
   ทะเบียนของ + เบิกใช้ต่อ batch + เตือนใกล้หมด + ต้นทุนวัสดุต่อช่วงเวลา
   ยอดคงเหลือเปลี่ยนได้ทางเดียวคือผ่านรายการเบิก/รับเข้า/ปรับยอด (ประวัติจะได้ไม่ขาด)  */
type Material = {
  id: number; code: string; name: string; unit: string; stock: number;
  reorderPoint: number; costPerUnit: number; supplier: string; note: string;
  low: boolean; value: number;
};
type Move = {
  id: number; materialId: number; name: string; unit: string; kind: 'in' | 'out' | 'adjust';
  qty: number; unitCost: number; balanceAfter: number; cost: number;
  batchRef: string; note: string; operator: string; movedAt: string;
};
type Summary = {
  from: string; to: string; totalCost: number; totalMoves: number;
  materials: { name: string; unit: string; qty: number; cost: number; times: number }[];
  byDay: { date: string; cost: number }[];
  byBatch: { batchRef: string; cost: number; items: number }[];
};

const KIND: Record<Move['kind'], { label: string; ic: string; c: string; w: string }> = {
  out: { label: 'เบิกใช้', ic: '📤', c: '#b3261e', w: '#fdecea' },
  in: { label: 'รับเข้า', ic: '📥', c: '#14653a', w: '#e6f4ec' },
  adjust: { label: 'ปรับยอด', ic: '⚖️', c: '#0d47a1', w: '#e8f1fb' },
};
const baht = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 2 });

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
  padding: '7px 11px', fontSize: 13.5, fontWeight: 500, color: 'var(--ink,#2b2119)', fontFamily: 'inherit',
};
const lbl: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' };

/* ── ฟอร์มเบิก/รับเข้า/ปรับยอดของวัสดุหนึ่งตัว (กางอยู่ในการ์ด) ── */
const MoveForm: React.FC<{
  m: Material; kind: Move['kind']; operatorName: string | null;
  onDone: () => void; onClose: () => void; onMsg: (s: string) => void;
}> = ({ m, kind, operatorName, onDone, onClose, onMsg }) => {
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState(kind === 'in' ? String(m.costPerUnit || '') : '');
  const [batchRef, setBatchRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const k = KIND[kind];
  const n = Number(qty);
  const after = !Number.isFinite(n) ? m.stock
    : kind === 'in' ? m.stock + n : kind === 'out' ? m.stock - n : n;

  const submit = async () => {
    if (!Number.isFinite(n) || (kind !== 'adjust' && n <= 0)) { onMsg('❌ ใส่จำนวนก่อน'); return; }
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/materials/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialId: m.id, kind, qty: n, operator: operatorName,
          unitCost: kind === 'in' && unitCost ? Number(unitCost) : undefined,
          batchRef: batchRef || undefined, note: note || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) { onMsg(`❌ ${d.error || 'บันทึกไม่สำเร็จ'}`); return; }
      onMsg(`✅ ${k.label} ${m.name} แล้ว — คงเหลือ ${d.material.stock} ${m.unit}`
        + (d.alerted ? ' · ⚠️ ถึงจุดสั่งซื้อแล้ว ส่งเตือนเข้า Telegram ให้แล้ว' : '')
        + (d.negative ? ' · ⚠️ ยอดติดลบ ลองปรับยอดตามที่นับได้จริง' : ''));
      onDone(); onClose();
    } catch { onMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 10, background: k.w, borderRadius: 12, padding: '10px 12px' }}>
      <div style={{ ...lbl, color: k.c, marginBottom: 7 }}>{k.ic} {k.label}</div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <input autoFocus type="number" inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder={kind === 'adjust' ? `ยอดที่นับได้ (${m.unit})` : `จำนวน (${m.unit})`}
          style={{ ...inp, flex: '1 1 130px' }} />
        {kind === 'in' && (
          <input type="number" inputMode="decimal" value={unitCost} onChange={e => setUnitCost(e.target.value)}
            placeholder="ราคา/หน่วย" style={{ ...inp, flex: '1 1 110px' }} />
        )}
        {kind === 'out' && (
          <input value={batchRef} onChange={e => setBatchRef(e.target.value)}
            placeholder="เบิกใช้กับ batch ไหน" style={{ ...inp, flex: '1 1 150px' }} />
        )}
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="หมายเหตุ (ไม่บังคับ)"
          style={{ ...inp, flex: '1 1 150px' }} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--ink-soft,#6d6259)' }}>
          คงเหลือ {m.stock} → <b style={{ color: after < 0 ? '#c62828' : k.c }}>{Math.round(after * 100) / 100}</b> {m.unit}
          {kind === 'out' && Number.isFinite(n) && n > 0 && m.costPerUnit > 0 && (
            <> · ต้นทุน ~{baht(Math.round(n * m.costPerUnit * 100) / 100)} บาท</>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={submit} disabled={busy}
          style={{ ...btn, background: k.c, borderColor: k.c, color: '#fff' }}>{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
        <button onClick={onClose} style={btn}>ยกเลิก</button>
      </div>
    </div>
  );
};

/* ── ฟอร์มทะเบียนวัสดุ (เพิ่ม/แก้) ──
   🔴 ต้องอยู่นอกคอมโพเนนต์แม่ — ประกาศไว้ข้างในเมื่อไหร่ React จะทิ้ง state ทุกครั้งที่แม่ re-render
   (เจอมาแล้วกับฟอร์มเหตุการณ์: พิมพ์ค้างไว้แล้วขึ้นข้อความ error → ข้อมูลหายทั้งฟอร์ม)     */
const MasterForm: React.FC<{
  init: Partial<Material>; onSave: (m: Partial<Material>) => void; onCancel: () => void;
}> = ({ init, onSave, onCancel }) => {
  const [f, setF] = useState<Partial<Material>>(init);
  const set = (k: keyof Material, v: string) =>
    setF(p => ({ ...p, [k]: ['reorderPoint', 'costPerUnit'].includes(k) ? Number(v) : v }));
  return (
    <div style={{ ...card, padding: '14px 16px', marginBottom: 14, background: '#fffaf5' }}>
      <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
        {init.id ? `แก้ทะเบียน — ${init.name}` : '＋ เพิ่มวัสดุใหม่'}
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <input value={f.name || ''} onChange={e => set('name', e.target.value)} disabled={!!init.id}
          placeholder="ชื่อวัสดุ เช่น โซดาไฟ (NaOH)" style={{ ...inp, flex: '2 1 200px' }} />
        <input value={f.code || ''} onChange={e => set('code', e.target.value)} placeholder="รหัส (ไม่บังคับ)"
          style={{ ...inp, flex: '1 1 110px' }} />
        <input value={f.unit || ''} onChange={e => set('unit', e.target.value)} placeholder="หน่วย เช่น kg"
          style={{ ...inp, flex: '1 1 90px' }} />
        <input type="number" value={f.reorderPoint ?? ''} onChange={e => set('reorderPoint', e.target.value)}
          placeholder="จุดสั่งซื้อ" title="เหลือถึงเท่านี้ให้เตือน" style={{ ...inp, flex: '1 1 110px' }} />
        <input type="number" value={f.costPerUnit ?? ''} onChange={e => set('costPerUnit', e.target.value)}
          placeholder="ราคา/หน่วย" style={{ ...inp, flex: '1 1 110px' }} />
        <input value={f.supplier || ''} onChange={e => set('supplier', e.target.value)} placeholder="ผู้ขาย (ไม่บังคับ)"
          style={{ ...inp, flex: '1 1 150px' }} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => onSave(f)} style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>บันทึก</button>
        <button onClick={onCancel} style={btn}>ยกเลิก</button>
        <span style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
          ยอดคงเหลือแก้ที่นี่ไม่ได้ — ใช้ปุ่มรับเข้า/ปรับยอดในการ์ด เพื่อให้ประวัติครบ
        </span>
      </div>
    </div>
  );
};

const MaterialsBoard: React.FC<{ operatorName: string | null }> = ({ operatorName }) => {
  const [list, setList] = useState<Material[]>([]);
  const [lowCount, setLowCount] = useState(0);
  const [totalValue, setTotalValue] = useState(0);
  const [moves, setMoves] = useState<Move[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [to, setTo] = useState(todayBKK());
  const [from, setFrom] = useState(shiftDay(todayBKK(), -29));
  const [open, setOpen] = useState('');          // "materialId|kind" ที่กางฟอร์มอยู่
  const [pick, setPick] = useState(0);           // กรองประวัติเฉพาะวัสดุนี้
  const [msg, setMsg] = useState('');
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Partial<Material> | null>(null);
  const canEdit = ['supervisor', 'admin'].includes(authRole());

  // โหลดข้อมูลด้วย effect ที่มีธง alive — ปิดหน้าไปกลางคันแล้วไม่ต้อง setState ใส่ของที่ถูกถอดไปแล้ว
  // (บวก refreshKey เพื่อสั่งโหลดใหม่หลังเบิก/รับของ)
  const [refreshKey, setRefreshKey] = useState(0);
  const reload = useCallback(() => setRefreshKey(k => k + 1), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await fetch(`${apiUrl}/api/materials`).then(r => r.json());
        if (!alive) return;
        setList(Array.isArray(d?.materials) ? d.materials : []);
        setLowCount(d?.lowCount || 0);
        setTotalValue(d?.totalValue || 0);
      } catch { if (alive) setMsg('❌ โหลดคลังวัสดุไม่สำเร็จ'); }
    })();
    return () => { alive = false; };
  }, [refreshKey]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [mv, sm] = await Promise.all([
          fetch(`${apiUrl}/api/materials/moves?from=${from}&to=${to}`).then(r => r.json()),
          fetch(`${apiUrl}/api/materials/summary?from=${from}&to=${to}`).then(r => r.json()),
        ]);
        if (!alive) return;
        setMoves(Array.isArray(mv?.moves) ? mv.moves : []);
        setSummary(sm && Array.isArray(sm.materials) ? sm : null);
      } catch { /* ไม่ได้ก็แค่ไม่มีประวัติให้ดู */ }
    })();
    return () => { alive = false; };
  }, [from, to, refreshKey]);

  const saveMaterial = async (m: Partial<Material>) => {
    if (!m.name?.trim()) { setMsg('❌ ต้องมีชื่อวัสดุ'); return; }
    try {
      const r = await fetch(`${apiUrl}/api/materials`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(m),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'บันทึกไม่สำเร็จ'}`); return; }
      setMsg(`✅ บันทึก ${m.name} แล้ว`);
      setAdding(false); setEdit(null);
      reload();
    } catch { setMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); }
  };
  const removeMaterial = async (m: Material) => {
    if (!window.confirm(`เอา "${m.name}" ออกจากทะเบียน?\nประวัติการเบิกยังอยู่ครบ แค่ไม่ขึ้นในรายการแล้ว`)) return;
    try {
      const r = await fetch(`${apiUrl}/api/materials/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id: m.id }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'เอาออกไม่สำเร็จ'}`); return; }
      setMsg(`✅ เอา ${m.name} ออกแล้ว`);
      reload();
    } catch { setMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); }
  };

  const lows = useMemo(() => list.filter(m => m.low), [list]);
  const shownMoves = useMemo(() => moves.filter(m => !pick || m.materialId === pick), [moves, pick]);

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#0f7a6c',
        background: '#e8f6f3', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>🧪 คลังวัสดุ</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          คลังวัสดุ / สารเคมี
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>{list.length} รายการในทะเบียน</span>
        <span style={{ flex: 1 }} />
        {canEdit && !adding && !edit && (
          <button onClick={() => setAdding(true)} style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>
            ＋ เพิ่มวัสดุ
          </button>
        )}
        <button onClick={reload} style={btn}>🔄 รีเฟรช</button>
      </div>
      {msg && <div style={{ fontSize: 12.5, marginBottom: 10, color: msg.startsWith('✅') ? '#1c8a4c' : '#c62828' }}>{msg}</div>}
      {!canEdit && (
        <div style={{ ...card, borderColor: '#f0dcc8', background: '#fdf6ee', padding: '10px 14px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.7 }}>
          ℹ️ เบิก/รับเข้า/ปรับยอดได้ตามปกติ — ส่วนการเพิ่มหรือแก้ทะเบียน (ราคา จุดสั่งซื้อ) ต้องเป็นหัวหน้างานขึ้นไป
        </div>
      )}

      {adding && <MasterForm init={{ unit: 'kg' }} onSave={saveMaterial} onCancel={() => setAdding(false)} />}
      {edit && <MasterForm init={edit} onSave={saveMaterial} onCancel={() => setEdit(null)} />}

      {/* ── ตัวเลขรวม ── */}
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', marginBottom: 14 }}>
        {([
          ['มูลค่าของในคลัง', `${baht(totalValue)} บาท`, `${list.length} รายการ`],
          ['ใกล้หมด', lowCount ? `${lowCount} รายการ` : 'ไม่มี', lowCount ? 'ถึงจุดสั่งซื้อแล้ว' : 'ของยังพอ'],
          ['ต้นทุนที่เบิกใช้', summary ? `${baht(summary.totalCost)} บาท` : '—', summary ? `${summary.totalMoves} ครั้ง · ${from} → ${to}` : ''],
        ] as [string, string, string][]).map(([k, v, sub]) => (
          <div key={k} style={{ ...card, padding: '12px 16px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', fontWeight: 600 }}>{k}</div>
            <div style={{
              fontFamily: 'Kanit, sans-serif', fontSize: 20, fontWeight: 600, lineHeight: 1.35,
              color: k === 'ใกล้หมด' && lowCount ? '#b3261e' : '#c24f00',
            }}>{v}</div>
            {sub && <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>{sub}</div>}
          </div>
        ))}
      </div>

      {/* ── เตือนใกล้หมด ── */}
      {lows.length > 0 && (
        <div style={{ ...card, borderColor: '#f2c4bc', background: '#fdecea', padding: '12px 16px', marginBottom: 14 }}>
          <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 14, fontWeight: 600, color: '#b3261e', marginBottom: 6 }}>
            ⚠️ ถึงจุดสั่งซื้อแล้ว {lows.length} รายการ
          </div>
          {lows.map(m => (
            <div key={m.id} style={{ fontSize: 13, lineHeight: 1.8 }}>
              <b>{m.name}</b> — เหลือ {m.stock} {m.unit} (จุดสั่งซื้อ {m.reorderPoint} {m.unit})
              {m.supplier && <span style={{ color: 'var(--ink-soft,#6d6259)' }}> · ผู้ขาย {m.supplier}</span>}
            </div>
          ))}
        </div>
      )}

      {/* ── การ์ดวัสดุ ── */}
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', alignItems: 'start' }}>
        {list.map(m => {
          const pct = m.reorderPoint > 0 ? Math.min(100, Math.round(m.stock / (m.reorderPoint * 2) * 100)) : 100;
          return (
            <article key={m.id} style={{ ...card, padding: '13px 15px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600 }}>
                    {m.name} {m.code && <span style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>· {m.code}</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
                    จุดสั่งซื้อ {m.reorderPoint} {m.unit}
                    {m.costPerUnit > 0 && <> · {baht(m.costPerUnit)} บาท/{m.unit}</>}
                    {m.supplier && <> · {m.supplier}</>}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 21, fontWeight: 600, lineHeight: 1, color: m.low ? '#b3261e' : '#1c8a4c' }}>
                    {m.stock}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-soft,#6d6259)' }}>{m.unit}</div>
                </div>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: '#f2ece6', margin: '9px 0 4px' }}>
                <i style={{
                  display: 'block', height: '100%', width: `${pct}%`, borderRadius: 999,
                  background: m.low ? 'linear-gradient(90deg,#d93025,#f0855b)' : 'linear-gradient(90deg,#1c8a4c,#6fc38b)',
                }} />
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {(['out', 'in', 'adjust'] as Move['kind'][]).map(k => (
                  <button key={k} onClick={() => setOpen(open === `${m.id}|${k}` ? '' : `${m.id}|${k}`)}
                    style={{ ...btn, padding: '5px 11px', fontSize: 12, color: KIND[k].c, borderColor: open === `${m.id}|${k}` ? KIND[k].c : 'var(--line,#eee3d9)' }}>
                    {KIND[k].ic} {KIND[k].label}
                  </button>
                ))}
                <span style={{ flex: 1 }} />
                <button onClick={() => setPick(pick === m.id ? 0 : m.id)} title="ดูประวัติเฉพาะตัวนี้"
                  style={{ ...btn, padding: '5px 11px', fontSize: 12 }}>{pick === m.id ? '✕ เลิกกรอง' : '🕘 ประวัติ'}</button>
                {canEdit && (<>
                  <button onClick={() => setEdit(m)} style={{ ...btn, padding: '5px 11px', fontSize: 12 }}>✏️</button>
                  <button onClick={() => removeMaterial(m)}
                    style={{ ...btn, padding: '5px 11px', fontSize: 12, color: '#c62828' }}>✕</button>
                </>)}
              </div>
              {open.startsWith(`${m.id}|`) && (
                <MoveForm m={m} kind={open.split('|')[1] as Move['kind']} operatorName={operatorName}
                  onDone={reload} onClose={() => setOpen('')} onMsg={setMsg} />
              )}
            </article>
          );
        })}
        {list.length === 0 && (
          <div style={{ ...card, padding: 20, textAlign: 'center', color: 'var(--ink-soft,#6d6259)', fontSize: 13, lineHeight: 1.7 }}>
            ยังไม่มีวัสดุในทะเบียน
            <br />{canEdit ? 'กด “＋ เพิ่มวัสดุ” เพื่อเริ่ม — ใส่ชื่อ หน่วย จุดสั่งซื้อ และราคา/หน่วย'
              : 'ให้หัวหน้างานเพิ่มวัสดุเข้าทะเบียนก่อน'}
          </div>
        )}
      </div>

      {/* ── ช่วงเวลาของประวัติ/ต้นทุน ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '20px 0 12px' }}>
        <span style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600 }}>ประวัติและต้นทุน</span>
        <span style={{ flex: 1 }} />
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>ถึง</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', alignItems: 'start' }}>
        {/* ต้นทุนรายวัสดุ */}
        {summary && summary.materials.length > 0 && (
          <div style={{ ...card, padding: '14px 16px' }}>
            <div style={{ ...lbl, marginBottom: 8 }}>ต้นทุนวัสดุที่เบิกใช้</div>
            {summary.materials.map(m => (
              <div key={m.name} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #f6efe8' }}>
                <span style={{ flex: 1, minWidth: 0 }}>{m.name}</span>
                <span style={{ color: 'var(--ink-soft,#6d6259)', fontSize: 12 }}>{m.qty} {m.unit} · {m.times} ครั้ง</span>
                <b style={{ color: '#c24f00' }}>{baht(m.cost)}</b>
              </div>
            ))}
          </div>
        )}
        {/* ต้นทุนราย batch */}
        {summary && summary.byBatch.length > 0 && (
          <div style={{ ...card, padding: '14px 16px' }}>
            <div style={{ ...lbl, marginBottom: 8 }}>ต้นทุนวัสดุต่อ batch</div>
            {summary.byBatch.map(b => (
              <div key={b.batchRef} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #f6efe8' }}>
                <span style={{ flex: 1, minWidth: 0 }}>🧾 {b.batchRef}</span>
                <span style={{ color: 'var(--ink-soft,#6d6259)', fontSize: 12 }}>{b.items} รายการ</span>
                <b style={{ color: '#c24f00' }}>{baht(b.cost)}</b>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── รายการเคลื่อนไหว ── */}
      <div style={{ ...card, padding: '14px 16px', marginTop: 12 }}>
        <div style={{ ...lbl, marginBottom: 8 }}>
          ความเคลื่อนไหว ({shownMoves.length}{pick ? ` · เฉพาะ ${list.find(m => m.id === pick)?.name || ''}` : ''})
        </div>
        {shownMoves.length === 0
          ? <div style={{ fontSize: 12.5, color: '#a89e94' }}>ยังไม่มีการเบิกหรือรับของในช่วงนี้</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shownMoves.slice(0, 60).map(mv => (
                <div key={mv.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', background: '#fbf7f3', borderRadius: 10, padding: '8px 10px' }}>
                  <span style={{ flex: 'none' }}>{KIND[mv.kind].ic}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                      {mv.name}{' '}
                      <span style={{ color: KIND[mv.kind].c }}>
                        {mv.kind === 'adjust'
                          // ปรับยอด: ตัวเลขที่จดไว้คือ "ส่วนต่าง" — โชว์ยอดใหม่ให้อ่านง่ายกว่า
                          ? `ปรับยอดเป็น ${mv.balanceAfter} ${mv.unit} (${mv.qty >= 0 ? '+' : ''}${mv.qty})`
                          : `${mv.kind === 'in' ? '+' : '−'}${Math.abs(mv.qty)} ${mv.unit}`}
                      </span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', lineHeight: 1.6 }}>
                      {String(mv.movedAt).slice(0, 16).replace('T', ' ')} น. · คงเหลือ {mv.balanceAfter} {mv.unit}
                      {mv.batchRef && <> · 🧾 {mv.batchRef}</>}
                      {mv.operator && <> · {mv.operator}</>}
                      {mv.note && <> · {mv.note}</>}
                    </div>
                  </div>
                  {mv.cost > 0 && <b style={{ flex: 'none', fontSize: 13, color: '#c24f00' }}>{baht(mv.cost)}</b>}
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
};

export default MaterialsBoard;
