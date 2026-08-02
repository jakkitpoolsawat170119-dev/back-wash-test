import React, { useCallback, useEffect, useState } from 'react';

// คิวตรวจ SKU หลังนำเข้าชีต "รายการสินค้าทั้งหมด" (~200 ตัว)
// ชีตให้แค่รหัส/ชื่อ/เครื่อง — จำนวนชิ้นต่อหน่วยกับหน่วยนับต้องให้หน้างานยืนยัน
// จนกว่าจะเติมครบ SKU จะ active=0 (ไม่โผล่ในฟอร์มลงยอด) เพื่อไม่ให้ยอดชิ้นเพี้ยน

const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface SkuRow {
  keyword: string;
  sku_code: string | null;
  product_name: string | null;
  group_name: string | null;
  machine: string | null;
  count_unit: string | null;
  pack_factor: number | null;
  pallet_route: number | null;
  active: number;
  review_note: string | null;
}

const UNITS = ['กล่อง', 'กระสอบ', 'หม้อ'];

const card: React.CSSProperties = { background: '#fff', border: '1px solid #ece4da', borderRadius: 12, padding: 14, marginBottom: 12 };
const lb: React.CSSProperties = { display: 'block', fontSize: '0.72rem', color: '#666', marginBottom: 3, fontWeight: 'bold' };
const inp: React.CSSProperties = { width: '100%', padding: '7px 9px', border: '1px solid #ddd2c4', borderRadius: 8, fontSize: '0.85rem', boxSizing: 'border-box' };
const btn: React.CSSProperties = { padding: '8px 14px', border: 'none', borderRadius: 9, color: '#fff', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.85rem' };

const SkuReviewPanel: React.FC = () => {
  const [rows, setRows] = useState<SkuRow[]>([]);
  const [edits, setEdits] = useState<Record<string, Partial<SkuRow>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/sku/review`);
      const d = await r.json();
      setRows(Array.isArray(d.items) ? d.items : []);
      setEdits({});
    } catch { setMsg('โหลดรายการไม่สำเร็จ'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const runImport = async () => {
    if (!window.confirm('ดึงรายการสินค้าทั้งหมดจากชีตเข้ามาใหม่?\n\nของที่ตั้งค่าไว้แล้ว (หน่วยนับ / จำนวนชิ้น / เครื่อง) จะไม่ถูกทับ')) return;
    setImporting(true); setMsg('');
    try {
      const r = await fetch(`${apiUrl}/api/sku/import-all`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'นำเข้าไม่สำเร็จ'}`); }
      else {
        setMsg(`✅ อ่านจากชีต ${d.total} รายการ · เพิ่มใหม่ ${d.created.length} · อัปเดต ${d.updated.length}`
          + `${d.duplicates?.length ? ` · รหัสซ้ำในชีต ${d.duplicates.length}` : ''} · รอตรวจ ${d.needsReview.length}`);
        await load();
      }
    } catch { setMsg('❌ เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); }
    setImporting(false);
  };

  const setField = (kw: string, patch: Partial<SkuRow>) =>
    setEdits(e => ({ ...e, [kw]: { ...e[kw], ...patch } }));

  const valOf = <K extends keyof SkuRow>(row: SkuRow, key: K): SkuRow[K] =>
    (edits[row.keyword]?.[key] ?? row[key]) as SkuRow[K];

  const save = async (row: SkuRow, activate: boolean) => {
    const pf = Number(valOf(row, 'pack_factor')) || 0;
    if (activate && pf <= 0) { alert('ต้องกรอกจำนวนชิ้นต่อหน่วยก่อนเปิดใช้ (ไม่งั้นยอดชิ้นจะเป็น 0)'); return; }
    setBusy(row.keyword);
    try {
      const r = await fetch(`${apiUrl}/api/sku`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            keyword: row.keyword,
            sku_code: valOf(row, 'sku_code') || '',
            product_name: valOf(row, 'product_name') || '',
            group_name: valOf(row, 'group_name') || '',
            machine: valOf(row, 'machine') || '',
            count_unit: valOf(row, 'count_unit') || 'กล่อง',
            pack_factor: pf,
            pallet_route: Number(valOf(row, 'pallet_route')) === 2 ? 2 : 1,
            active: activate ? 1 : 0,
            review_note: activate ? null : row.review_note,
          }],
        }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'บันทึกไม่สำเร็จ'); }
      else await load();
    } catch { alert('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); }
    setBusy(null);
  };

  const term = q.trim().toLowerCase();
  const shown = term
    ? rows.filter(r => `${r.keyword} ${r.sku_code || ''} ${r.product_name || ''} ${r.group_name || ''}`.toLowerCase().includes(term))
    : rows;

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 4px 40px' }}>
      <div style={{ ...card, background: 'linear-gradient(135deg,#fff8f0,#fff)' }}>
        <h2 style={{ margin: '0 0 6px', fontSize: '1.1rem' }}>🗃️ SKU รอตรวจสอบ</h2>
        <div style={{ fontSize: '0.8rem', color: '#7a726a', lineHeight: 1.6 }}>
          สินค้าที่นำเข้าจากชีตแล้วยัง <b>เปิดใช้ไม่ได้</b> เพราะระบบเดา "จำนวนชิ้นต่อหน่วย" ไม่ได้<br />
          เติมจำนวนชิ้น + หน่วยนับ แล้วกด <b>บันทึก + เปิดใช้</b> สินค้าจะไปโผล่ในฟอร์มลงยอดผลิต
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button onClick={runImport} disabled={importing}
            style={{ ...btn, background: importing ? '#bdbdbd' : 'linear-gradient(135deg,#c98b4b,#a86b32)' }}>
            {importing ? '⏳ กำลังดึง…' : '⬇️ ดึงรายการสินค้าจากชีต'}
          </button>
          <button onClick={load} disabled={loading} style={{ ...btn, background: '#fff', color: '#8a7f72', border: '1px solid #e5dbcf' }}>
            🔄 รีเฟรช
          </button>
          <input placeholder="ค้นหา รหัส / ชื่อสินค้า" value={q} onChange={e => setQ(e.target.value)}
            style={{ ...inp, width: 240, flex: '0 1 240px' }} />
        </div>
        {msg && <div style={{ marginTop: 10, fontSize: '0.82rem', color: msg.startsWith('❌') ? '#c62828' : '#1c8a4c' }}>{msg}</div>}
      </div>

      <div style={{ fontSize: '0.8rem', color: '#8a7f72', margin: '4px 2px 10px' }}>
        {loading ? 'กำลังโหลด…' : `รอตรวจ ${shown.length} รายการ${term ? ` (จากทั้งหมด ${rows.length})` : ''}`}
      </div>

      {!loading && !shown.length && (
        <div style={{ ...card, textAlign: 'center', color: '#8a7f72' }}>
          ไม่มีรายการรอตรวจ 🎉
        </div>
      )}

      {shown.map(row => {
        const pf = Number(valOf(row, 'pack_factor')) || 0;
        const dirty = !!edits[row.keyword];
        return (
          <div key={row.keyword} style={{ ...card, borderLeft: `4px solid ${row.active ? '#e0a458' : '#c96b6b'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 'bold', fontSize: '0.92rem', wordBreak: 'break-word' }}>{row.product_name || row.keyword}</div>
                <div style={{ fontSize: '0.72rem', color: '#a1968a', marginTop: 2 }}>
                  {row.sku_code || '(ไม่มีรหัส)'} · keyword: <code>{row.keyword}</code>
                  {row.pallet_route === 2 && <span style={{ marginLeft: 6, color: '#c24f00' }}>📦 จัดพาเลทเอง</span>}
                </div>
              </div>
              <span style={{
                alignSelf: 'flex-start', fontSize: '0.7rem', padding: '3px 9px', borderRadius: 99, whiteSpace: 'nowrap',
                background: row.active ? '#fdf3e3' : '#fdeaea', color: row.active ? '#a86a1c' : '#c62828',
              }}>{row.active ? 'เปิดใช้ · ยังไม่ครบ' : 'ปิดอยู่'}</span>
            </div>

            {row.review_note && (
              <div style={{ fontSize: '0.75rem', color: '#a1968a', marginBottom: 8 }}>📝 {row.review_note}</div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10 }}>
              <div>
                <label style={lb}>จำนวนชิ้น/หน่วย *</label>
                <input type="number" min="0" style={inp} value={pf || ''}
                  onChange={e => setField(row.keyword, { pack_factor: Number(e.target.value) })} />
              </div>
              <div>
                <label style={lb}>หน่วยนับ</label>
                <select style={inp} value={valOf(row, 'count_unit') || 'กล่อง'}
                  onChange={e => setField(row.keyword, { count_unit: e.target.value })}>
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label style={lb}>เครื่องบรรจุ</label>
                <input style={inp} value={valOf(row, 'machine') || ''}
                  onChange={e => setField(row.keyword, { machine: e.target.value })} />
              </div>
              <div>
                <label style={lb}>กลุ่ม Product</label>
                <input style={inp} value={valOf(row, 'group_name') || ''}
                  onChange={e => setField(row.keyword, { group_name: e.target.value })} />
              </div>
              <div>
                <label style={lb}>ทางเข้าคลัง</label>
                <select style={inp} value={String(Number(valOf(row, 'pallet_route')) === 2 ? 2 : 1)}
                  onChange={e => setField(row.keyword, { pallet_route: Number(e.target.value) })}>
                  <option value="1">สายพาน → robot (คลังเห็นเอง)</option>
                  <option value="2">จัดพาเลทเอง (ต้องแนบรูป)</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <button disabled={busy === row.keyword} onClick={() => save(row, true)}
                style={{ ...btn, background: busy === row.keyword ? '#bdbdbd' : 'linear-gradient(135deg,#3cb371,#1c8a4c)' }}>
                ✅ บันทึก + เปิดใช้
              </button>
              <button disabled={busy === row.keyword} onClick={() => save(row, false)}
                style={{ ...btn, background: '#fff', color: '#8a7f72', border: '1px solid #e5dbcf' }}>
                💾 บันทึกไว้ก่อน (ยังปิด)
              </button>
              {dirty && <span style={{ fontSize: '0.72rem', color: '#c24f00' }}>● ยังไม่ได้บันทึก</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default SkuReviewPanel;
