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

// เครื่องบรรจุตามตัวเลือกในฟอร์ม Google หมวด 5 — สินค้าเดียวกันวิ่งได้หลายเครื่อง จึงต้องเลือกเองทุกครั้ง
// (ฟอร์มจริงมี 19 ตัว · 2 ตัวชื่ออ่านไม่ออกจากไฟล์ต้นทาง ดู GOOGLE_FORM_STRUCTURE.md)
const MACHINES = [
  'NGS',
  'Rotary (Hondok)',
  'Linear#1 (Lina Pack)', 'Linear#2 (Lina Pack)', 'Linear#3 (Lina Pack)', 'Linear#4 (Lina Pack)',
  '300 ml (Delmax)', 'Hygiene (Delmax)', 'Freshy (Delmax)',
  'Sachet (Thai M Pack)', 'Stick (Sanko)',
  'Paste 1-5 kg 454 g', 'ICING 10-25 Kg', 'Low Cal 105-500 g',
  'ต้มหัวเชื้อ', 'ถังน้ำเชื่อม ทำความสะอาด อื่นๆ', 'Manual', 'เครื่องบรรจุ#A3',
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

// 1 รายการในชุดของกะ (เก็บค่าที่คำนวณไว้ด้วยเพื่อโชว์ในตารางสรุปโดยไม่ต้องหา SKU ซ้ำ)
interface BatchItem {
  key: string;
  sku_keyword: string; product_name: string; machine: string;
  count_unit: string; pack_factor: number;
  prod_qty: number; plan_qty: number; plan_override: boolean; plan_source: string;
  counter: number; machine_cycle: number; bdown_time: number;
  lot_date: string; miss_reason: string; extra_note: string;
  wastes: { type: string; qty: number; reason: string }[];
  prod_status: string;
}

const draftKey = (d: string, s: string) => `spp_batch_draft_${d}_${s}`;

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
  const [machine, setMachine] = useState('');   // ตั้งต้นจาก SKU แต่เลือกเองได้ (Syrup วิ่งได้หลาย Linear)
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

  // รายการที่สะสมไว้ในชุดของกะนี้ — กะหนึ่งลง 8+ รายการ ส่งทีเดียวได้ลิงก์เดียว
  const [items, setItems] = useState<BatchItem[]>([]);
  const [editKey, setEditKey] = useState<string | null>(null);   // กำลังแก้รายการไหนอยู่

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ batch_id: string; item_count: number; verify_url: string; sent_via: string; expires: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // ⚠️ ปุ่ม "ดึงรายการล่าสุดจากชีต" ถูกถอดออก 2026-08-07 พร้อมชีตจับคู่ทำมือที่ยกเลิกไป
  //    ทางเดียวที่นำเข้าสินค้าตอนนี้คือแท็บ "SKU รอตรวจสอบ" → ปุ่ม "ดึงรายการสินค้าจากชีต"
  //    (อ่านชีตหลักตรงเป็น CSV ไม่ผ่าน n8n) เพื่อให้ของใหม่ผ่านสายตาคนก่อนเปิดใช้เสมอ

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
  // เปลี่ยนสินค้า → เติมเครื่องตั้งต้นให้ (แก้ทับได้)
  useEffect(() => { setMachine(sku?.machine || ''); }, [sku]);
  const unit = sku?.count_unit || 'กล่อง';
  const packFactor = sku?.pack_factor ?? 0;
  // งาน Manual ปกติไม่มี Counter/รอบเครื่อง จึงเติม 0 ให้ — แต่บาง Line มีเลขหน้าเครื่องจริง จึงต้องแก้ได้
  // ดูจากเครื่องที่เลือกจริง ไม่ใช่ค่าตั้งต้นของ SKU
  const isManual = machine === 'Manual' || machine === 'ต้มหัวเชื้อ' || machine === '';

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

  // เคลียร์เฉพาะช่องของ "รายการ" — ส่วนหัวของกะ (วันที่/กะ/ผู้ลงยอด/ทีม/เวลา) คงไว้
  const clearItemFields = () => {
    setSkuKey(''); setMachine(''); setPlanQty(''); setPlanSource('none'); setPlanEdit(false);
    setProdQty(''); setCounter(''); setMachineCycle(''); setBdown('0');
    setMissReason(''); setWastes([]); setExtraNote(''); setEditKey(null);
  };

  const resetAll = () => {
    clearItemFields();
    setItems([]); setSent(null); setCopied(false);
    setRunTime('480'); setSetupTime('30'); setBreakTime('60'); setCleanTime('30'); setStopAfter('30');
  };

  // ── กู้ draft ของกะนี้ (กรอก 8 รายการแล้วหน้า refresh ต้องไม่หาย) ──
  useEffect(() => {
    if (sent) return;
    try {
      const raw = localStorage.getItem(draftKey(date, shift));
      setItems(raw ? (JSON.parse(raw).items || []) : []);
    } catch { setItems([]); }
    clearItemFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, shift]);

  useEffect(() => {
    if (sent) return;
    try {
      if (items.length) localStorage.setItem(draftKey(date, shift), JSON.stringify({ items, savedAt: Date.now() }));
      else localStorage.removeItem(draftKey(date, shift));
    } catch { /* โควตาเต็ม — ข้าม ไม่ให้ล้มทั้งหน้า */ }
  }, [items, date, shift, sent]);

  // ตรวจช่องของรายการปัจจุบัน แล้วเก็บเข้าชุด (หรือบันทึกทับตัวที่กำลังแก้)
  const addItem = () => {
    if (!skuKey) { alert('กรุณาเลือกสินค้า'); return; }
    if (prodQty.trim() === '') { alert(`กรุณากรอกจำนวนที่ผลิตได้ (${unit})`); return; }
    if (missTarget && !missReason.trim()) { alert('ผลิตไม่ถึงแผน — กรุณาระบุสาเหตุ'); return; }
    const dup = items.find(i => i.sku_keyword === skuKey && i.machine === machine && i.key !== editKey);
    if (dup && !window.confirm(`มี "${skuKey}" เครื่องเดียวกันในชุดอยู่แล้ว — เพิ่มอีกรายการไหม?`)) return;

    const rec: BatchItem = {
      key: editKey || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sku_keyword: skuKey, product_name: sku?.product_name || skuKey, machine,
      count_unit: unit, pack_factor: packFactor,
      prod_qty: num(prodQty), plan_qty: planNum,
      plan_override: planEdit || planSource === 'none' || planSource === 'unit_mismatch',
      plan_source: planSource,
      counter: num(counter),
      machine_cycle: num(machineCycle),
      bdown_time: num(bdown),
      lot_date: lotDate, miss_reason: missReason.trim(), extra_note: extraNote.trim(),
      wastes: wastes.filter(w => num(w.qty) > 0).map(w => ({ type: w.type, qty: num(w.qty), reason: w.reason })),
      prod_status: status,
    };
    setItems(list => (editKey ? list.map(i => (i.key === editKey ? rec : i)) : [...list, rec]));
    clearItemFields();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ดึงรายการกลับขึ้นมาแก้ (ถอดออกจากชุดชั่วคราว แล้วกด "บันทึกรายการ" ใส่กลับ)
  const editItem = (it: BatchItem) => {
    setEditKey(it.key);
    setSkuKey(it.sku_keyword); setMachine(it.machine);
    setPlanQty(String(it.plan_qty)); setPlanSource(it.plan_source); setPlanEdit(it.plan_override);
    setProdQty(String(it.prod_qty)); setCounter(String(it.counter)); setMachineCycle(String(it.machine_cycle));
    setBdown(String(it.bdown_time)); setLotDate(it.lot_date); setMissReason(it.miss_reason); setExtraNote(it.extra_note);
    setWastes(it.wastes.map(w => ({ type: w.type, qty: String(w.qty), reason: w.reason })));
    window.scrollTo({ top: 9999, behavior: 'smooth' });
  };

  const submitBatch = async () => {
    if (!reporter.trim()) { alert('กรุณากรอกชื่อผู้ลงยอด'); return; }
    if (!items.length) { alert('ยังไม่มีรายการในชุด — กรอกแล้วกด "เพิ่มเข้าชุด" ก่อน'); return; }
    if (skuKey && prodQty.trim() !== '' &&
        !window.confirm('มีรายการที่กรอกค้างไว้แต่ยังไม่ได้กด "เพิ่มเข้าชุด" — ส่งโดยไม่รวมรายการนี้ไหม?')) return;

    setSending(true);
    try {
      const r = await fetch(`${apiUrl}/api/production/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          header: {
            date, shift, reporter: reporter.trim(), crew,
            run_time: num(runTime), setup_time: num(setupTime), break_time: num(breakTime),
            clean_time: num(cleanTime), stop_after_target: num(stopAfter),
          },
          items: items.map(i => ({
            sku_keyword: i.sku_keyword, machine: i.machine, prod_qty: i.prod_qty,
            plan_qty_override: i.plan_override ? i.plan_qty : undefined,
            counter: i.counter, machine_cycle: i.machine_cycle, bdown_time: i.bdown_time,
            lot_date: i.lot_date, miss_reason: i.miss_reason, extra_note: i.extra_note, wastes: i.wastes,
          })),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `ส่งไม่สำเร็จ (${r.status})`);
      try { localStorage.removeItem(draftKey(date, shift)); } catch { /* ไม่เป็นไร */ }
      setSent({ batch_id: d.batch_id, item_count: d.item_count, verify_url: d.verify_url, sent_via: d.sent_via, expires: d.verify_expires_at });
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
          <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: '#2e7d32' }}>
            ส่งแล้ว {sent.item_count} รายการ — รอคลังตรวจนับ
          </div>
          <div style={{ fontSize: '0.9rem', color: '#444', marginTop: 4 }}>
            ชุด <b style={{ fontFamily: 'monospace' }}>{sent.batch_id}</b> · {date} · {shift}
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
            <div style={{ color: '#8a7f72' }}>
              📱 วางลิงก์เดียวนี้ในกลุ่ม LINE ของคลัง — คลังเปิดครั้งเดียวเห็นครบทั้ง {sent.item_count} รายการ
            </div>
          </div>
        </div>

        <button onClick={resetAll} style={{ width: '100%', background: 'linear-gradient(135deg,#ff8a3c,#e65100)', color: '#fff', border: 'none', borderRadius: 12, padding: 13, fontWeight: 'bold', fontSize: '0.95rem', cursor: 'pointer' }}>
          ➕ ลงยอดชุดถัดไป
        </button>
      </div>
    );
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#8a7f72' }}>⏳ กำลังโหลดข้อมูลสินค้า…</div>;

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', paddingBottom: 80 }}>
      <h2 style={{ fontSize: '1.2rem', color: '#3d2c1e', margin: '4px 0 2px' }}>🏭 ลงยอดผลิต</h2>
      <p style={{ fontSize: '0.83rem', color: '#8a7f72', margin: '0 0 14px' }}>
        กรอกส่วนหัวของกะครั้งเดียว แล้วเพิ่มรายการทีละตัว — ส่งทั้งชุดทีเดียวได้ลิงก์เดียวให้คลัง
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

      {/* รายการในชุด */}
      {items.length > 0 && (
        <div style={{ ...card, borderColor: '#cfe8d8', background: '#f8fdfa' }}>
          <div style={{ ...secTitle, color: '#1c8a4c', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>📋 รายการในชุดนี้ ({items.length})</span>
            <span style={{ fontWeight: 'normal', fontSize: '0.72rem', color: '#8a7f72' }}>เก็บอัตโนมัติ — refresh แล้วไม่หาย</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ color: '#6d6259', textAlign: 'left' }}>
                  <th style={{ padding: '4px 6px', fontWeight: 600 }}>สินค้า</th>
                  <th style={{ padding: '4px 6px', fontWeight: 600 }}>เครื่อง</th>
                  <th style={{ padding: '4px 6px', fontWeight: 600, textAlign: 'right' }}>แผน</th>
                  <th style={{ padding: '4px 6px', fontWeight: 600, textAlign: 'right' }}>ผลิตได้</th>
                  <th style={{ padding: '4px 6px', fontWeight: 600 }}>สถานะ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.key} style={{ borderTop: '1px solid #e5e0d8', background: it.key === editKey ? '#fff3ea' : undefined }}>
                    <td style={{ padding: '6px', maxWidth: 190 }}>
                      <div style={{ fontWeight: 'bold' }}>{it.sku_keyword}</div>
                      <div style={{ fontSize: '0.72rem', color: '#8a7f72', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.product_name}</div>
                    </td>
                    <td style={{ padding: '6px', fontSize: '0.76rem', color: '#6d6259' }}>{it.machine || '—'}</td>
                    <td style={{ padding: '6px', textAlign: 'right', color: '#8a7f72' }}>{it.plan_qty || '—'}</td>
                    <td style={{ padding: '6px', textAlign: 'right', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                      {it.prod_qty} <span style={{ fontWeight: 'normal', fontSize: '0.72rem', color: '#8a7f72' }}>{it.count_unit}</span>
                    </td>
                    <td style={{ padding: '6px' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 'bold', padding: '2px 7px', borderRadius: 999,
                        background: it.prod_status === 'ได้ยอดผลิต' ? '#e6f4ec' : '#fdeaea',
                        color: it.prod_status === 'ได้ยอดผลิต' ? '#1c8a4c' : '#c62828' }}>
                        {it.prod_status === 'ได้ยอดผลิต' ? 'ได้ยอด' : 'ไม่ได้ยอด'}
                      </span>
                    </td>
                    <td style={{ padding: '6px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button onClick={() => editItem(it)} title="แก้ไข"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.95rem', padding: '2px 4px' }}>✏️</button>
                      <button onClick={() => { if (window.confirm(`ลบ "${it.sku_keyword}" ออกจากชุด?`)) setItems(l => l.filter(x => x.key !== it.key)); }} title="ลบ"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.95rem', padding: '2px 4px' }}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* สินค้า */}
      <div style={card}>
        <div style={secTitle}>
          📦 สินค้า {editKey ? <span style={{ ...autoChip, background: '#fff3ea', color: '#c24f00' }}>กำลังแก้รายการ</span>
                             : <span style={{ fontWeight: 'normal', fontSize: '0.75rem', color: '#8a7f72' }}>— รายการที่ {items.length + 1}</span>}
        </div>
        <div style={grid(200)}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ ...lb, flex: 1 }}>เลือกสินค้า * <span style={{ fontWeight: 'normal' }}>({skus.length} รายการ)</span></label>
            {/* โชว์ชื่อทางการ ไม่ใช่ keyword — หลังเลิกใช้ชีตจับคู่ทำมือ keyword ของเกือบทุกตัวคือรหัส SKU
                ("S71AEB0000") ซึ่งคนหน้างานอ่านแล้วไม่รู้ว่าคือสินค้าอะไร */}
            <select style={inp} value={skuKey} onChange={e => { setSkuKey(e.target.value); setPlanEdit(false); }}>
              <option value="">-- เลือกสินค้า --</option>
              {skus.map(s => (
                <option key={s.keyword} value={s.keyword}>
                  {s.product_name || s.keyword} — {s.group_name} · นับเป็น{s.count_unit}
                </option>
              ))}
            </select>
          </div>
          {sku && <>
            <div><label style={lb}>กลุ่ม Product<span style={autoChip}>อัตโนมัติ</span></label><input style={inpRO} value={sku.group_name || ''} readOnly /></div>
            <div><label style={lb}>เครื่องบรรจุ<span style={autoChip}>ตั้งต้นจากสินค้า · เลือกได้</span></label>
              <select style={inp} value={machine} onChange={e => {
                const m = e.target.value;
                setMachine(m);
                // เลือกเครื่อง Manual → เติม 0 ให้เฉพาะช่องที่ยังว่าง (ยังแก้เองได้ · ไม่ทับเลขที่พิมพ์ไว้แล้ว)
                if (m === 'Manual' || m === 'ต้มหัวเชื้อ') {
                  setCounter(c => (c.trim() === '' ? '0' : c));
                  setMachineCycle(c => (c.trim() === '' ? '0' : c));
                }
              }}>
                {machine && !MACHINES.includes(machine) && <option value={machine}>{machine}</option>}
                <option value="">-- ยังไม่ระบุเครื่อง --</option>
                {MACHINES.map(m => <option key={m} value={m}>{m}</option>)}
              </select></div>
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
          <div><label style={lb}>ยอดเลขหน้าเครื่อง (ชิ้น)</label><input type="number" min="0" style={inp} value={counter} onChange={e => setCounter(e.target.value)} /></div>
          <div><label style={lb}>เดินรอบเครื่อง</label><input type="number" min="0" style={inp} value={machineCycle} onChange={e => setMachineCycle(e.target.value)} /></div>
        </div>
        <div style={calcBox}>
          🧮 ชิ้นที่ผลิตได้ = {num(prodQty)} {unit} × {packFactor} = <b>{prodPcs.toLocaleString()} ชิ้น</b><span style={autoChip}>ระบบคำนวณ</span>
          {isManual && <span style={{ marginLeft: 8, color: '#a1887f' }}>(งาน Manual — ปกติ 0 · แก้ได้ถ้ามีเลขหน้าเครื่อง)</span>}
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

      {/* เก็บรายการเข้าชุด */}
      <button onClick={addItem}
        style={{ width: '100%', background: '#fff', color: '#c24f00', border: '2px dashed #f6b98a', borderRadius: 12, padding: 13, fontWeight: 'bold', fontSize: '0.95rem', cursor: 'pointer', marginBottom: 12 }}>
        {editKey ? '💾 บันทึกรายการที่แก้' : '➕ เพิ่มเข้าชุด แล้วกรอกรายการถัดไป'}
      </button>

      <button onClick={submitBatch} disabled={sending || !items.length}
        style={{ width: '100%', background: sending || !items.length ? '#d6d0c8' : 'linear-gradient(135deg,#ff8a3c,#e65100)', color: '#fff', border: 'none', borderRadius: 12, padding: 14, fontWeight: 'bold', fontSize: '1rem', cursor: sending ? 'wait' : items.length ? 'pointer' : 'not-allowed', boxShadow: items.length ? '0 6px 15px rgba(230,81,0,0.25)' : 'none' }}>
        {sending ? '⏳ กำลังส่ง…'
          : items.length ? `📤 ส่งทั้งชุดให้คลัง (${items.length} รายการ)`
          : '📤 ยังไม่มีรายการในชุด'}
      </button>
      {!!items.length && (
        <div style={{ fontSize: '0.78rem', color: '#8a7f72', textAlign: 'center', marginTop: 8 }}>
          ส่งครั้งเดียวได้ลิงก์เดียว — คลังเปิดหน้าเดียวกรอกครบทั้ง {items.length} รายการ
        </div>
      )}
    </div>
  );
};

export default SppReportForm;
