import React, { useEffect, useMemo, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

// ── ชนิดข้อมูลจาก /api/sku ──
interface Sku {
  keyword: string;
  sku_code?: string;
  product_name?: string;
  group_name?: string;
  machine?: string;
  count_unit: string;
  pack_factor: number;
  plan_flavor?: string;
}

// สำรองไว้ใช้ตอน API ล่ม/Render ยังไม่ตื่น — ค่าจริงอยู่ในตาราง sku_master
const FALLBACK_SKUS: Sku[] = [
  { keyword: 'Amazon850', group_name: 'Amazon-NGS', machine: 'NGS', count_unit: 'กล่อง', pack_factor: 12 },
  { keyword: 'Syrup800', group_name: 'Syrup', machine: 'Linear#1 (Lina Pack)', count_unit: 'กล่อง', pack_factor: 12 },
  { keyword: 'Icing900', group_name: 'Icing', machine: 'ICING 10-25 Kg', count_unit: 'กล่อง', pack_factor: 12 },
  { keyword: 'ต้มหัวเชื้อ', group_name: 'ถังน้ำเชื่อม ทำความสะอาด อื่นๆ', machine: 'ต้มหัวเชื้อ', count_unit: 'หม้อ', pack_factor: 0 },
];

// ประเภทของเสียตามฟอร์ม Google หมวด 9 (แต่ละประเภทมี จำนวน + สาเหตุการชำรุด)
const WASTE_TYPES = ['ถุง', 'ถุง Pack', 'ขวด/กระปุก', 'ฝา', 'กริ๊ป', 'กล่อง'];

const SHIFTS = ['กะ1', 'กะ2', 'กะ3'];

const bkkDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
// วันทำงาน: ก่อน 06:00 นับเป็นวันก่อนหน้า (ตรงกับ workDayBKK ฝั่ง server)
const workDay = () => {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
  if (Number(s.slice(11, 13)) >= 6) return s.slice(0, 10);
  const d = new Date(`${s.slice(0, 10)}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE');
};
const guessShift = () => {
  const h = Number(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(11, 13));
  if (h >= 6 && h < 14) return 'กะ1';
  if (h >= 14 && h < 22) return 'กะ2';
  return 'กะ3';
};
const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

interface WasteRow { type: string; qty: string; reason: string }
interface Props { operatorName?: string }

const card: React.CSSProperties = { background: '#ffffff', border: '1px solid #e5e0d8', borderRadius: '14px', padding: '16px', marginBottom: '14px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' };
const secTitle: React.CSSProperties = { fontWeight: 'bold', fontSize: '0.95rem', color: '#7a4510', marginBottom: '10px' };
const lb: React.CSSProperties = { display: 'block', fontSize: '0.78rem', color: '#666', marginBottom: '4px', fontWeight: 'bold' };
const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: '9px', border: '1px solid #d9d2c7', fontSize: '0.9rem', background: '#fffdf9' };
const inpRO: React.CSSProperties = { ...inp, background: '#f4efe9', color: '#7a726a' };
const grid = (min: number): React.CSSProperties => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: '10px' });
const autoChip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', fontWeight: 'bold', background: '#e6f4ec', color: '#1c8a4c', padding: '1px 8px', borderRadius: 999, marginLeft: 6 };
const chip = (on: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', fontWeight: 'bold',
  border: `1px solid ${on ? '#f6dcc4' : '#e5e0d8'}`, background: on ? '#fff3ea' : '#fffdf9',
  color: on ? '#c24f00' : '#8a8078', padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
});
const calcBox: React.CSSProperties = { marginTop: 10, fontSize: '0.85rem', color: '#555', background: '#fdf6ec', border: '1px solid #f0e3cd', borderRadius: 9, padding: '9px 12px' };

const SppReportForm: React.FC<Props> = ({ operatorName }) => {
  // master data
  const [skus, setSkus] = useState<Sku[]>([]);
  const [crewByShift, setCrewByShift] = useState<Record<string, string[]>>({});
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);

  // หัวรายงาน
  const [date, setDate] = useState(workDay());
  const [shift, setShift] = useState(guessShift());
  const [reporter, setReporter] = useState(operatorName || '');
  const [crew, setCrew] = useState<string[]>([]);

  // สินค้า
  const [skuKey, setSkuKey] = useState('');
  const [lotDate, setLotDate] = useState(bkkDate());

  // ยอดผลิต
  const [planQty, setPlanQty] = useState('');
  const [planSource, setPlanSource] = useState('none');
  const [planEdit, setPlanEdit] = useState(false);
  const [prodQty, setProdQty] = useState('');
  const [counter, setCounter] = useState('');
  const [machineCycle, setMachineCycle] = useState('');

  // เวลา (ค่ามาตรฐาน)
  const [runTime, setRunTime] = useState('480');
  const [setupTime, setSetupTime] = useState('30');
  const [breakTime, setBreakTime] = useState('60');
  const [cleanTime, setCleanTime] = useState('30');
  const [stopAfter, setStopAfter] = useState('30');
  const [bdown, setBdown] = useState('0');
  const [showTimes, setShowTimes] = useState(false);

  // สถานะ / ของเสีย
  const [missReason, setMissReason] = useState('');
  const [wastes, setWastes] = useState<WasteRow[]>([]);
  const [extraNote, setExtraNote] = useState('');

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ report_id: string; verify_url: string; sent_via: string; expires: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // ดึงรายการ SKU ล่าสุดจากชีต (keyword ในชีตคือตัวที่ n8n ใช้ resolve — ต้องตรงกัน)
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const syncSku = async () => {
    setSyncing(true); setSyncMsg('');
    try {
      const r = await fetch(`${apiUrl}/api/sku/sync`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `ดึงไม่สำเร็จ (${r.status})`);
      const fresh = await fetch(`${apiUrl}/api/sku`).then(x => x.json());
      if (Array.isArray(fresh.items) && fresh.items.length) { setSkus(fresh.items); setOffline(false); }
      const review = (d.needsReview || []) as { keyword: string; reason: string }[];
      setSyncMsg(
        `✅ ดึงจากชีตแล้ว ${d.total} รายการ — เพิ่มใหม่ ${d.created?.length || 0} · อัปเดต ${d.updated?.length || 0}` +
        (review.length ? `\n⚠️ ต้องตั้งค่าเพิ่ม ${review.length} รายการ: ${review.slice(0, 5).map(x => x.keyword).join(', ')}${review.length > 5 ? ' …' : ''}` : '')
      );
    } catch (e) {
      setSyncMsg(`❌ ${e instanceof Error ? e.message : 'ดึงรายการไม่สำเร็จ'}`);
    } finally { setSyncing(false); }
  };

  // โหลด master data
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(`${apiUrl}/api/sku`).then(r => r.json()),
      fetch(`${apiUrl}/api/shift-crew`).then(r => r.json()),
    ])
      .then(([s, c]) => {
        if (!alive) return;
        setSkus(Array.isArray(s.items) && s.items.length ? s.items : FALLBACK_SKUS);
        setOffline(!(Array.isArray(s.items) && s.items.length));
        setCrewByShift(c.shifts || {});
      })
      .catch(() => { if (alive) { setSkus(FALLBACK_SKUS); setOffline(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const sku = useMemo(() => skus.find(s => s.keyword === skuKey), [skus, skuKey]);
  const unit = sku?.count_unit || 'กล่อง';
  const packFactor = sku?.pack_factor ?? 0;
  const isManual = !!sku && (sku.machine === 'Manual' || sku.machine === 'ต้มหัวเชื้อ');

  // ทีมงานของกะที่เลือก — เปลี่ยนกะแล้วติ๊กทุกคนให้ใหม่
  const teamList = crewByShift[shift] || [];
  useEffect(() => { setCrew(crewByShift[shift] || []); }, [shift, crewByShift]);

  // ดึงแผนของ SKU+วัน+กะ มาเติมให้เอง
  useEffect(() => {
    if (!skuKey) { setPlanQty(''); setPlanSource('none'); return; }
    if (planEdit) return;                       // ผู้ใช้กดแก้เองแล้ว — อย่าทับ
    let alive = true;
    const q = new URLSearchParams({ date, shift, sku: skuKey });
    fetch(`${apiUrl}/api/production/plan-hint?${q}`)
      .then(r => r.json())
      .then(d => { if (!alive) return; setPlanQty(d.plan_qty != null ? String(d.plan_qty) : ''); setPlanSource(d.plan_source || 'none'); })
      .catch(() => { if (alive) setPlanSource('none'); });
    return () => { alive = false; };
  }, [skuKey, date, shift, planEdit]);

  const prodPcs = num(prodQty) * packFactor;
  const machineRun = num(runTime) - num(setupTime) - num(breakTime) - num(cleanTime) - num(stopAfter) - num(bdown);
  const planNum = num(planQty);
  const missTarget = planNum > 0 && num(prodQty) < planNum;
  const status = missTarget ? 'ไม่ได้ยอดผลิต' : 'ได้ยอดผลิต';

  const planNote = {
    shift_plans: 'จากแผนกะนี้',
    shift_plans_other_shift: '⚠️ จากแผนของกะอื่นในวันเดียวกัน',
    production_plans: 'จากแผนผลิตรายวัน (batch × 100)',
    unit_mismatch: `⚠️ แผนเก็บเป็นกล่อง แต่สินค้านี้นับเป็น "${unit}" — กรอกเอง`,
    manual: 'กรอกเอง',
    none: 'ไม่พบแผน — กรอกเอง',
  }[planSource] || '';

  const toggleCrew = (n: string) => setCrew(c => (c.includes(n) ? c.filter(x => x !== n) : [...c, n]));
  const toggleWaste = (t: string) =>
    setWastes(w => (w.some(x => x.type === t) ? w.filter(x => x.type !== t) : [...w, { type: t, qty: '', reason: '' }]));
  const updWaste = (t: string, k: 'qty' | 'reason', v: string) =>
    setWastes(w => w.map(x => (x.type === t ? { ...x, [k]: v } : x)));

  const reset = () => {
    setSkuKey(''); setPlanQty(''); setPlanSource('none'); setPlanEdit(false);
    setProdQty(''); setCounter(''); setMachineCycle('');
    setRunTime('480'); setSetupTime('30'); setBreakTime('60'); setCleanTime('30'); setStopAfter('30'); setBdown('0');
    setMissReason(''); setWastes([]); setExtraNote(''); setSent(null); setCopied(false);
  };

  const submit = async () => {
    if (!reporter.trim()) { alert('กรุณากรอกชื่อผู้รายงาน'); return; }
    if (!skuKey) { alert('กรุณาเลือกสินค้า'); return; }
    if (prodQty.trim() === '') { alert(`กรุณากรอกจำนวนที่ผลิตได้ (${unit})`); return; }
    if (missTarget && !missReason.trim()) { alert('ผลิตไม่ถึงแผน — กรุณาระบุสาเหตุ'); return; }

    setSending(true);
    try {
      const r = await fetch(`${apiUrl}/api/production/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reporter: reporter.trim(), sku_keyword: skuKey, date, shift, crew,
          prod_qty: num(prodQty),
          plan_qty_override: planEdit || planSource === 'none' || planSource === 'unit_mismatch' ? num(planQty) : undefined,
          miss_reason: missReason.trim(), lot_date: lotDate,
          counter: isManual ? 0 : num(counter),
          machine_cycle: isManual ? 0 : num(machineCycle),
          run_time: num(runTime), setup_time: num(setupTime), break_time: num(breakTime),
          clean_time: num(cleanTime), stop_after_target: num(stopAfter), bdown_time: num(bdown),
          wastes: wastes.filter(w => num(w.qty) > 0).map(w => ({ type: w.type, qty: num(w.qty), reason: w.reason })),
          extra_note: extraNote.trim(),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `ส่งไม่สำเร็จ (${r.status})`);
      setSent({ report_id: d.report_id, verify_url: d.verify_url, sent_via: d.sent_via, expires: d.verify_expires_at });
      window.scrollTo({ top: 0 });
    } catch (e) {
      alert(`❌ ${e instanceof Error ? e.message : 'ส่งรายงานไม่สำเร็จ'}`);
    } finally { setSending(false); }
  };

  const copyLink = async () => {
    if (!sent) return;
    try { await navigator.clipboard.writeText(sent.verify_url); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch { window.prompt('คัดลอกลิงก์นี้ไปวางในกลุ่ม LINE', sent.verify_url); }
  };

  // ── จอสำเร็จ ──
  if (sent) {
    return (
      <div style={{ maxWidth: 620, margin: '20px auto' }}>
        <div style={{ ...card, textAlign: 'center', border: '2px solid #a5d6a7', background: '#f8fdfa' }}>
          <div style={{ fontSize: '2.4rem' }}>✅</div>
          <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: '#2e7d32' }}>บันทึกแล้ว — รอคลังตรวจนับ</div>
          <div style={{ fontSize: '0.9rem', color: '#444', marginTop: 4 }}>
            รหัส <b style={{ fontFamily: 'monospace' }}>{sent.report_id}</b>
          </div>
          <div style={{ fontSize: '0.8rem', color: '#2e7d32', marginTop: 6, fontWeight: 'bold' }}>
            ข้อมูลถูกบันทึกลงฐานข้อมูลแล้ว — ต่อให้ส่งข้อความไม่สำเร็จ ตัวเลขก็ไม่หาย
          </div>
        </div>

        <div style={card}>
          <div style={secTitle}>🔗 ลิงก์สำหรับคลังตรวจนับ</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#f7f2ec', border: '1px solid #e5e0d8', borderRadius: 10, padding: '9px 11px' }}>
            <code style={{ flex: 1, fontSize: '0.72rem', wordBreak: 'break-all', color: '#c24f00' }}>{sent.verify_url}</code>
            <button onClick={copyLink} style={{ flex: '0 0 auto', background: copied ? '#e6f4ec' : '#fff', color: copied ? '#1c8a4c' : '#3d2c1e', border: '1px solid #d9d2c7', borderRadius: 9, padding: '7px 12px', fontWeight: 'bold', fontSize: '0.8rem', cursor: 'pointer' }}>
              {copied ? '✓ คัดลอกแล้ว' : '📋 คัดลอก'}
            </button>
          </div>
          <div style={{ fontSize: '0.78rem', color: '#8a7f72', marginTop: 8 }}>
            ใช้ได้ครั้งเดียว · หมดอายุ {sent.expires?.replace('T', ' ')}
          </div>

          <div style={{ marginTop: 12, fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div>
              {sent.sent_via === 'telegram'
                ? <><span style={{ ...autoChip, marginLeft: 0 }}>✓ ส่งแล้ว</span> เข้ากลุ่ม Telegram อัตโนมัติ</>
                : <><span style={{ ...autoChip, marginLeft: 0, background: '#fdf1de', color: '#c77700' }}>รอวาง</span> ยังไม่ได้ส่งอัตโนมัติ — กดคัดลอกแล้ววางในกลุ่ม</>}
            </div>
            <div style={{ color: '#8a7f72' }}>📱 วางลิงก์นี้ในกลุ่ม LINE ของคลัง — คลังกดเปิดแล้วกรอกยอดที่นับได้</div>
          </div>
        </div>

        <button onClick={reset} style={{ width: '100%', background: 'linear-gradient(135deg,#ff8a3c,#e65100)', color: '#fff', border: 'none', borderRadius: 12, padding: 13, fontWeight: 'bold', fontSize: '0.95rem', cursor: 'pointer' }}>
          ➕ ลงยอดรายการถัดไป
        </button>
      </div>
    );
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#8a7f72' }}>⏳ กำลังโหลดข้อมูลสินค้า…</div>;

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', paddingBottom: 80 }}>
      <h2 style={{ fontSize: '1.2rem', color: '#3d2c1e', margin: '4px 0 2px' }}>🏭 ลงยอดผลิต</h2>
      <p style={{ fontSize: '0.83rem', color: '#8a7f72', margin: '0 0 14px' }}>
        กรอกเฉพาะตัวเลขที่ฝ่ายผลิตรู้ — แผนผลิต ทีมงาน และค่าคำนวณ ระบบเติมให้ · ยอดคลังมาจากคลังเท่านั้น
      </p>
      {offline && (
        <div style={{ ...card, background: '#fff8e1', border: '1px solid #ffe0a3', fontSize: '0.83rem', color: '#8a6d3b' }}>
          ⚠️ โหลดรายการสินค้าจากระบบไม่ได้ — ใช้รายการสำรอง {FALLBACK_SKUS.length} รายการชั่วคราว (อาจไม่ครบ)
        </div>
      )}

      {/* หัวรายงาน */}
      <div style={card}>
        <div style={secTitle}>📌 ข้อมูลรายงาน</div>
        <div style={grid(160)}>
          <div><label style={lb}>วันที่การผลิต</label><input type="date" style={inp} value={date} onChange={e => setDate(e.target.value)} /></div>
          <div><label style={lb}>กะ</label>
            <select style={inp} value={shift} onChange={e => setShift(e.target.value)}>
              {SHIFTS.map(s => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div><label style={lb}>ผู้รายงาน *</label><input style={inp} value={reporter} onChange={e => setReporter(e.target.value)} placeholder="ชื่อ-นามสกุล" /></div>
        </div>
        {teamList.length > 0 && (
          <>
            <label style={{ ...lb, marginTop: 12 }}>ทีมงานใน{shift}<span style={autoChip}>ติ๊กแก้ได้</span></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {teamList.map(n => (
                <button key={n} onClick={() => toggleCrew(n)} style={chip(crew.includes(n))}>
                  {crew.includes(n) ? '✓' : '＋'} {n}
                </button>
              ))}
            </div>
            <div style={calcBox}>👥 จำนวนคนผลิต = <b>{crew.length} คน</b><span style={autoChip}>นับจากที่ติ๊ก</span></div>
          </>
        )}
      </div>

      {/* สินค้า */}
      <div style={card}>
        <div style={secTitle}>📦 สินค้า</div>
        <div style={grid(200)}>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <label style={{ ...lb, flex: 1 }}>เลือกสินค้า * <span style={{ fontWeight: 'normal' }}>({skus.length} รายการ)</span></label>
              <button onClick={syncSku} disabled={syncing}
                style={{ background: 'none', border: 'none', color: syncing ? '#aaa' : '#1565c0', fontSize: '0.78rem', fontWeight: 'bold', cursor: syncing ? 'wait' : 'pointer', padding: 0 }}>
                {syncing ? '⏳ กำลังดึง…' : '🔄 ดึงรายการล่าสุดจากชีต'}
              </button>
            </div>
            <select style={inp} value={skuKey} onChange={e => { setSkuKey(e.target.value); setPlanEdit(false); }}>
              <option value="">-- เลือกสินค้า --</option>
              {skus.map(s => (
                <option key={s.keyword} value={s.keyword}>
                  {s.keyword} — {s.group_name} · นับเป็น{s.count_unit}
                </option>
              ))}
            </select>
            {syncMsg && (
              <div style={{ fontSize: '0.78rem', marginTop: 6, padding: '7px 10px', borderRadius: 8,
                background: syncMsg.startsWith('❌') ? '#fdeaea' : '#e6f4ec',
                color: syncMsg.startsWith('❌') ? '#c62828' : '#1c8a4c', whiteSpace: 'pre-line' }}>
                {syncMsg}
              </div>
            )}
          </div>
          {sku && <>
            <div><label style={lb}>กลุ่ม Product<span style={autoChip}>อัตโนมัติ</span></label><input style={inpRO} value={sku.group_name || ''} readOnly /></div>
            <div><label style={lb}>เครื่องบรรจุ<span style={autoChip}>อัตโนมัติ</span></label><input style={inpRO} value={sku.machine || ''} readOnly /></div>
            <div><label style={lb}>หน่วยนับ<span style={autoChip}>อัตโนมัติ</span></label><input style={inpRO} value={unit} readOnly /></div>
            <div><label style={lb}>จำนวนชิ้น/{unit}<span style={autoChip}>อัตโนมัติ</span></label><input style={inpRO} value={packFactor} readOnly /></div>
          </>}
          <div style={{ gridColumn: '1 / -1' }}><label style={lb}>ระบุ Lot น้ำเชื่อมที่บรรจุ</label><input type="date" style={inp} value={lotDate} onChange={e => setLotDate(e.target.value)} /></div>
        </div>
      </div>

      {/* ยอดผลิต */}
      <div style={card}>
        <div style={secTitle}>📊 ยอดผลิต</div>
        <div style={grid(150)}>
          <div>
            <label style={lb}>
              จำนวนแผนผลิต ({unit})
              {!planEdit && planSource !== 'none' && planSource !== 'unit_mismatch' && <span style={autoChip}>อัตโนมัติ</span>}
            </label>
            <input type="number" min="0" style={planEdit || planSource === 'none' || planSource === 'unit_mismatch' ? inp : inpRO}
              value={planQty} onChange={e => setPlanQty(e.target.value)}
              readOnly={!planEdit && planSource !== 'none' && planSource !== 'unit_mismatch'} />
            <div style={{ fontSize: '0.7rem', color: planSource.startsWith('⚠') ? '#c62828' : '#8a7f72', marginTop: 3 }}>
              {planNote}
              {!planEdit && planSource !== 'none' && planSource !== 'unit_mismatch' && (
                <button onClick={() => setPlanEdit(true)} style={{ marginLeft: 6, background: 'none', border: 'none', color: '#c24f00', cursor: 'pointer', fontSize: '0.7rem', textDecoration: 'underline', padding: 0 }}>✏️ แก้เอง</button>
              )}
            </div>
          </div>
          <div><label style={lb}>ผลิตเกิดจริง ({unit}) *</label><input type="number" min="0" style={inp} value={prodQty} onChange={e => setProdQty(e.target.value)} /></div>
          <div><label style={lb}>ยอดเลขหน้าเครื่อง (ชิ้น)</label><input type="number" min="0" style={isManual ? inpRO : inp} value={isManual ? '0' : counter} onChange={e => setCounter(e.target.value)} readOnly={isManual} /></div>
          <div><label style={lb}>เดินรอบเครื่อง</label><input type="number" min="0" style={isManual ? inpRO : inp} value={isManual ? '0' : machineCycle} onChange={e => setMachineCycle(e.target.value)} readOnly={isManual} /></div>
        </div>
        <div style={calcBox}>
          🧮 ชิ้นที่ผลิตได้ = {num(prodQty)} {unit} × {packFactor} = <b>{prodPcs.toLocaleString()} ชิ้น</b><span style={autoChip}>ระบบคำนวณ</span>
          {isManual && <span style={{ marginLeft: 8, color: '#a1887f' }}>(งาน Manual — Counter/รอบเครื่อง = 0)</span>}
        </div>
        <div style={{ ...calcBox, background: missTarget ? '#fdeaea' : '#e6f4ec', borderColor: missTarget ? '#f2c9c9' : '#cfe8d8' }}>
          🎯 สถานะการผลิต: <b style={{ color: missTarget ? '#c62828' : '#1c8a4c' }}>{status}</b>
          {planNum > 0 && <span style={{ color: '#8a7f72' }}> ({num(prodQty)} / {planNum} {unit})</span>}
        </div>
        {missTarget && (
          <div style={{ marginTop: 10 }}>
            <label style={lb}>สาเหตุที่ไม่ได้ยอดผลิต *</label>
            <input style={inp} value={missReason} onChange={e => setMissReason(e.target.value)} placeholder="เช่น เครื่องขัดข้อง 40 นาที" />
          </div>
        )}
      </div>

      {/* เวลา */}
      <div style={card}>
        <button onClick={() => setShowTimes(s => !s)} style={{ ...secTitle, background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}>
          ⏱ เวลา (นาที) — ค่ามาตรฐานเติมให้แล้ว {showTimes ? '▲' : '▼'}
        </button>
        {showTimes && (
          <div style={grid(120)}>
            <div><label style={lb}>เวลารวมผลิต</label><input type="number" min="0" style={inp} value={runTime} onChange={e => setRunTime(e.target.value)} /></div>
            <div><label style={lb}>Setup</label><input type="number" min="0" style={inp} value={setupTime} onChange={e => setSetupTime(e.target.value)} /></div>
            <div><label style={lb}>พัก</label><input type="number" min="0" style={inp} value={breakTime} onChange={e => setBreakTime(e.target.value)} /></div>
            <div><label style={lb}>Clean</label><input type="number" min="0" style={inp} value={cleanTime} onChange={e => setCleanTime(e.target.value)} /></div>
            <div><label style={lb}>หยุดหลังได้ยอด</label><input type="number" min="0" style={inp} value={stopAfter} onChange={e => setStopAfter(e.target.value)} /></div>
            <div><label style={lb}>B-down</label><input type="number" min="0" style={inp} value={bdown} onChange={e => setBdown(e.target.value)} /></div>
          </div>
        )}
        <div style={calcBox}>
          ⚙️ รวมเวลาเดินเครื่อง = <b style={{ color: machineRun < 0 ? '#c62828' : '#1c8a4c' }}>{machineRun}</b> นาที<span style={autoChip}>ระบบคำนวณ</span>
        </div>
      </div>

      {/* ของเสีย */}
      <div style={card}>
        <div style={secTitle}>🗑 ภาชนะบรรจุชำรุด — ติ๊กเฉพาะประเภทที่มีของเสีย</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {WASTE_TYPES.map(t => (
            <button key={t} onClick={() => toggleWaste(t)} style={chip(wastes.some(w => w.type === t))}>
              {wastes.some(w => w.type === t) ? '✓' : '＋'} {t}
            </button>
          ))}
        </div>
        {wastes.map(w => (
          <div key={w.type} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ flex: '0 0 92px', fontSize: '0.85rem', fontWeight: 'bold' }}>{w.type}</span>
            <input type="number" min="0" style={{ ...inp, flex: '0 0 100px' }} placeholder="จำนวน" value={w.qty} onChange={e => updWaste(w.type, 'qty', e.target.value)} />
            <input style={{ ...inp, flex: '1 1 180px' }} placeholder="สาเหตุการชำรุด" value={w.reason} onChange={e => updWaste(w.type, 'reason', e.target.value)} />
          </div>
        ))}
        {wastes.length === 0 && <div style={{ fontSize: '0.8rem', color: '#8a7f72' }}>ไม่มีของเสีย — ไม่ต้องกรอกอะไร</div>}
      </div>

      {/* งานพิเศษ */}
      <div style={card}>
        <div style={secTitle}>🧪 ถังน้ำเชื่อม / ทำความสะอาด / อื่น ๆ</div>
        <input style={inp} value={extraNote} onChange={e => setExtraNote(e.target.value)} placeholder="กรอกเฉพาะกรณีมีงานสนับสนุน — ไม่มีเว้นว่างได้" />
      </div>

      <button onClick={submit} disabled={sending}
        style={{ width: '100%', background: sending ? '#bdbdbd' : 'linear-gradient(135deg,#ff8a3c,#e65100)', color: '#fff', border: 'none', borderRadius: 12, padding: 14, fontWeight: 'bold', fontSize: '1rem', cursor: sending ? 'wait' : 'pointer', boxShadow: '0 6px 15px rgba(230,81,0,0.25)' }}>
        {sending ? '⏳ กำลังส่ง…' : '📤 ส่งให้คลังตรวจนับ'}
      </button>
    </div>
  );
};

export default SppReportForm;
