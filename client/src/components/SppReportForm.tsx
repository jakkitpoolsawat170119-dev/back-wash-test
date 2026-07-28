import React, { useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

// ── SKU preset ตามตาราง mapping ใน n8n system prompt (SPP Production Auto-Submit) ──
// เลือกแล้ว auto-fill กลุ่ม/เครื่อง/ชิ้นต่อลัง — keyword ต้องตรงกับที่ SKU Sheet ใน n8n ใช้ resolve ต่อ
interface SkuPreset { keyword: string; group: string; machine: string; packFactor: number }
const SKU_PRESETS: SkuPreset[] = [
  { keyword: 'Amazon850', group: 'Amazon-NGS', machine: 'NGS', packFactor: 12 },
  { keyword: 'Coffee 500g×4×10', group: 'Amazon-NGS', machine: 'NGS', packFactor: 40 },
  { keyword: 'กาแฟ 8g×30×4×10', group: 'Coffee & Sachet', machine: 'NGS', packFactor: 1200 },
  { keyword: 'Syrup800', group: 'Syrup', machine: 'Linear#1 (Lina Pack)', packFactor: 12 },
  { keyword: 'Syrup 1.8', group: 'Syrup', machine: 'Linear#1 (Lina Pack)', packFactor: 8 },
  { keyword: 'Syrup300', group: 'Syrup', machine: 'Linear#1 (Lina Pack)', packFactor: 24 },
  { keyword: 'Easy Dissolving800', group: 'Syrup', machine: 'Linear#1 (Lina Pack)', packFactor: 12 },
  { keyword: 'Blue Hawaii 710×3×4', group: 'Freshy', machine: 'Freshy (Delmax)', packFactor: 12 },
  { keyword: 'Sala Freshy 710×3×4', group: 'Freshy', machine: 'Freshy (Delmax)', packFactor: 12 },
  { keyword: 'Pineapple Freshy', group: 'Freshy', machine: 'Freshy (Delmax)', packFactor: 12 },
  { keyword: 'Kiwi Freshy', group: 'Freshy', machine: 'Freshy (Delmax)', packFactor: 12 },
  { keyword: 'Icing900', group: 'Icing', machine: 'ICING 10-25 Kg', packFactor: 12 },
  { keyword: 'Caramel Senorita 1.9×4', group: 'Senorita', machine: 'Freshy (Delmax)', packFactor: 4 },
  { keyword: 'Caramel Senorita 750×6', group: 'Senorita', machine: 'Freshy (Delmax)', packFactor: 6 },
  { keyword: 'ชีส 1×20', group: 'Coconut-Paste', machine: 'Manual', packFactor: 20 },
  { keyword: 'ต้มหัวเชื้อ', group: 'ถังน้ำเชื่อม ทำความสะอาด อื่นๆ', machine: 'ต้มหัวเชื้อ', packFactor: 0 },
];

const MACHINE_OPTIONS = [
  'NGS', 'Linear#1 (Lina Pack)', 'Linear#2 (Lina Pack)', 'Linear#3 (Lina Pack)', 'Linear#4 (Lina Pack)',
  'Freshy (Delmax)', 'ICING 10-25 Kg', 'Manual', 'ต้มหัวเชื้อ',
];

const WASTE_TYPES = ['ลังเสีย', 'ถุงเสียตั้งหมด', 'ถุงเบลอ', 'ถุงรีด', 'ฝาเสีย', 'ขวดเสีย', 'อื่นๆ'];

const bkkDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

interface WasteRow { type: string; qty: string }

interface Props { operatorName?: string }

// สไตล์กลางของฟอร์ม (ธีมสว่างตามหน้า Admin)
const card: React.CSSProperties = { background: '#ffffff', border: '1px solid #e5e0d8', borderRadius: '14px', padding: '16px', marginBottom: '14px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' };
const secTitle: React.CSSProperties = { fontWeight: 'bold', fontSize: '0.95rem', color: '#7a4510', marginBottom: '10px' };
const lb: React.CSSProperties = { display: 'block', fontSize: '0.78rem', color: '#666', marginBottom: '4px', fontWeight: 'bold' };
const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: '9px', border: '1px solid #d9d2c7', fontSize: '0.9rem', background: '#fffdf9' };
const grid = (min: number): React.CSSProperties => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: '10px' });

const SppReportForm: React.FC<Props> = ({ operatorName }) => {
  // หัวรายงาน
  const [date, setDate] = useState(bkkDate());
  const [shift, setShift] = useState('กะ1');
  const [reporter, setReporter] = useState(operatorName || '');
  // SKU
  const [skuChoice, setSkuChoice] = useState('');       // ค่าจาก dropdown ('' = ยังไม่เลือก, '__other__' = พิมพ์เอง)
  const [skuCustom, setSkuCustom] = useState('');
  const [group, setGroup] = useState('');
  const [machine, setMachine] = useState('');
  const [packFactor, setPackFactor] = useState('');
  // ยอดผลิต
  const [planBox, setPlanBox] = useState('');
  const [actualBox, setActualBox] = useState('');
  const [workers, setWorkers] = useState('');
  const [counter, setCounter] = useState('');
  const [machineCycle, setMachineCycle] = useState('');
  const [warehousePcs, setWarehousePcs] = useState('');  // ว่าง = ใช้ค่าอัตโนมัติ (ชิ้นที่ผลิตได้)
  // เวลา (นาที) — ค่ามาตรฐานวันธรรมดาตาม n8n prompt
  const [runTime, setRunTime] = useState('480');
  const [setupTime, setSetupTime] = useState('30');
  const [breakTime, setBreakTime] = useState('60');
  const [cleanTime, setCleanTime] = useState('30');
  const [stopAfterTarget, setStopAfterTarget] = useState('30');
  const [bdownTime, setBdownTime] = useState('0');
  // สถานะ/ของเสีย
  const [statusOverride, setStatusOverride] = useState('');  // '' = อัตโนมัติจากแผนเทียบผลิตจริง
  const [missReason, setMissReason] = useState('');
  const [wastes, setWastes] = useState<WasteRow[]>([]);
  const [damageReason, setDamageReason] = useState('');
  // ส่งข้อมูล
  const [sending, setSending] = useState(false);
  const [sentReport, setSentReport] = useState<string | null>(null);

  const sku = skuChoice === '__other__' ? skuCustom.trim() : skuChoice;
  const isManual = machine === 'Manual' || machine === 'ต้มหัวเชื้อ';

  const actualPcs = num(actualBox) * num(packFactor);
  const machineRunTime = num(runTime) - num(setupTime) - num(breakTime) - num(cleanTime) - num(stopAfterTarget) - num(bdownTime);
  const autoStatus = num(planBox) > 0 && num(actualBox) < num(planBox) ? 'ไม่ได้ยอดผลิต' : 'ได้ยอดผลิต';
  const status = statusOverride || autoStatus;
  const warehouseFinal = warehousePcs.trim() === '' ? actualPcs : num(warehousePcs);

  const pickSku = (v: string) => {
    setSkuChoice(v);
    const p = SKU_PRESETS.find(s => s.keyword === v);
    if (p) {
      setGroup(p.group);
      setMachine(p.machine);
      setPackFactor(String(p.packFactor));
    } else if (v === '__other__') {
      setGroup(''); setMachine(''); setPackFactor('');
    }
  };

  const updateWaste = (i: number, k: keyof WasteRow, v: string) =>
    setWastes(prev => prev.map((w, j) => (j === i ? { ...w, [k]: v } : w)));

  const wasteDetail = wastes.filter(w => w.type && num(w.qty) > 0)
    .map(w => `${w.type}: ${num(w.qty)} ใบ`)
    .join(' | ') || '-';
  const wastePcsTotal = wastes.reduce((s, w) => s + num(w.qty), 0);
  const wasteMainType = wastes.find(w => w.type && num(w.qty) > 0)?.type || '';

  const resetForm = () => {
    setSkuChoice(''); setSkuCustom(''); setGroup(''); setMachine(''); setPackFactor('');
    setPlanBox(''); setActualBox(''); setWorkers(''); setCounter(''); setMachineCycle(''); setWarehousePcs('');
    setRunTime('480'); setSetupTime('30'); setBreakTime('60'); setCleanTime('30'); setStopAfterTarget('30'); setBdownTime('0');
    setStatusOverride(''); setMissReason(''); setWastes([]); setDamageReason('');
    setSentReport(null);
  };

  const submit = async () => {
    if (!reporter.trim()) { alert('กรุณากรอกชื่อผู้รายงาน'); return; }
    if (!sku) { alert('กรุณาเลือกหรือกรอก SKU'); return; }
    if (actualBox.trim() === '') { alert('กรุณากรอกจำนวนผลิตจริง (ลัง)'); return; }
    if (status === 'ไม่ได้ยอดผลิต' && !missReason.trim()) { alert('ไม่ได้ยอดผลิต — กรุณาระบุสาเหตุ'); return; }

    const payload = {
      date, shift,
      ชื่อ: reporter.trim(),
      sku, group, machine,
      plan_box: num(planBox),
      actual_box: num(actualBox),
      pack_factor: num(packFactor),
      workers: num(workers),
      actual_pcs: actualPcs,
      run_time: num(runTime),
      counter: isManual ? 0 : num(counter),
      machine_cycle: isManual ? 0 : num(machineCycle),
      setup_time: num(setupTime),
      break_time: num(breakTime),
      clean_time: num(cleanTime),
      stop_after_target: num(stopAfterTarget),
      bdown_time: num(bdownTime),
      machine_run_time: machineRunTime,
      status,
      miss_reason: status === 'ไม่ได้ยอดผลิต' ? missReason.trim() : '-',
      warehouse_pcs: warehouseFinal,
      waste_type: wasteMainType,
      waste_pcs: wastePcsTotal,
      waste_detail: wasteDetail,
      damage_reason: damageReason.trim(),
    };

    setSending(true);
    try {
      const r = await fetch(`${apiUrl}/api/production/spp-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `ส่งไม่สำเร็จ (${r.status})`);
      setSentReport(d.report_id || '(ไม่ทราบรหัส)');
      window.scrollTo({ top: 0 });
    } catch (e) {
      alert(`❌ ${e instanceof Error ? e.message : 'ส่งรายงานไม่สำเร็จ'}`);
    } finally {
      setSending(false);
    }
  };

  // ── หน้าจอสำเร็จ ──
  if (sentReport) {
    return (
      <div style={{ maxWidth: '560px', margin: '30px auto', textAlign: 'center' }}>
        <div style={{ ...card, padding: '30px 20px', border: '2px solid #a5d6a7' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>✅</div>
          <div style={{ fontWeight: 'bold', fontSize: '1.1rem', color: '#2e7d32', marginBottom: '6px' }}>ส่งรายงานยอดผลิตแล้ว</div>
          <div style={{ fontSize: '0.95rem', color: '#444', marginBottom: '4px' }}>รหัสรายงาน: <b>{sentReport}</b></div>
          <div style={{ fontSize: '0.85rem', color: '#777' }}>เข้าคิวรออนุมัติแล้ว — ผู้ตรวจสอบจะเห็นปุ่ม ✅ อนุมัติ / ❌ ปฏิเสธ ในกลุ่ม Telegram</div>
          <button onClick={resetForm} style={{ marginTop: '18px', background: 'linear-gradient(135deg,#ff8a3c,#e65100)', color: '#fff', border: 'none', borderRadius: '10px', padding: '11px 22px', fontWeight: 'bold', fontSize: '0.95rem', cursor: 'pointer' }}>
            ➕ ลงยอดรายการถัดไป
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', paddingBottom: '80px' }}>
      <h2 style={{ fontSize: '1.2rem', color: '#3d2c1e', margin: '4px 0 2px' }}>🏭 ลงยอดผลิต</h2>
      <p style={{ fontSize: '0.83rem', color: '#8a7f72', margin: '0 0 14px' }}>
        กรอกยอดผลิตส่งเข้าคิวอนุมัติ (Pending) — ผู้ตรวจสอบกดอนุมัติในกลุ่ม Telegram แล้วข้อมูลจึงลง Production Sheet
      </p>

      {/* ── หัวรายงาน ── */}
      <div style={card}>
        <div style={secTitle}>📌 ข้อมูลรายงาน</div>
        <div style={grid(160)}>
          <div><label style={lb}>วันที่ผลิต</label>
            <input type="date" style={inp} value={date} onChange={e => setDate(e.target.value)} /></div>
          <div><label style={lb}>กะ</label>
            <select style={inp} value={shift} onChange={e => setShift(e.target.value)}>
              {['กะ1', 'กะ2', 'กะ3'].map(s => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div><label style={lb}>ชื่อผู้รายงาน *</label>
            <input style={inp} value={reporter} onChange={e => setReporter(e.target.value)} placeholder="ชื่อ-นามสกุล" /></div>
        </div>
      </div>

      {/* ── SKU ── */}
      <div style={card}>
        <div style={secTitle}>📦 สินค้า (SKU)</div>
        <div style={grid(200)}>
          <div style={{ gridColumn: '1 / -1' }}><label style={lb}>SKU *</label>
            <select style={inp} value={skuChoice} onChange={e => pickSku(e.target.value)}>
              <option value="">-- เลือก SKU --</option>
              {SKU_PRESETS.map(s => <option key={s.keyword} value={s.keyword}>{s.keyword} ({s.group})</option>)}
              <option value="__other__">อื่น ๆ (พิมพ์เอง)</option>
            </select></div>
          {skuChoice === '__other__' && (
            <div style={{ gridColumn: '1 / -1' }}><label style={lb}>พิมพ์ keyword SKU (ตามที่ระบบรู้จัก เช่น Amazon850, Icing25kg)</label>
              <input style={inp} value={skuCustom} onChange={e => setSkuCustom(e.target.value)} placeholder="keyword SKU" /></div>
          )}
          <div><label style={lb}>กลุ่มสินค้า</label>
            <input style={inp} value={group} onChange={e => setGroup(e.target.value)} placeholder="เช่น Syrup" /></div>
          <div><label style={lb}>เครื่อง</label>
            <input style={inp} list="spp-machines" value={machine} onChange={e => setMachine(e.target.value)} placeholder="เช่น NGS" />
            <datalist id="spp-machines">{MACHINE_OPTIONS.map(m => <option key={m} value={m} />)}</datalist></div>
          <div><label style={lb}>ชิ้น/ลัง (pack factor)</label>
            <input type="number" min="0" style={inp} value={packFactor} onChange={e => setPackFactor(e.target.value)} /></div>
        </div>
      </div>

      {/* ── ยอดผลิต ── */}
      <div style={card}>
        <div style={secTitle}>📊 ยอดผลิต</div>
        <div style={grid(150)}>
          <div><label style={lb}>แผนผลิต (ลัง)</label>
            <input type="number" min="0" style={inp} value={planBox} onChange={e => setPlanBox(e.target.value)} /></div>
          <div><label style={lb}>ผลิตจริง (ลัง) *</label>
            <input type="number" min="0" style={inp} value={actualBox} onChange={e => setActualBox(e.target.value)} /></div>
          <div><label style={lb}>จำนวนคนผลิต</label>
            <input type="number" min="0" style={inp} value={workers} onChange={e => setWorkers(e.target.value)} /></div>
          <div><label style={lb}>เลขหน้าเครื่อง (Counter)</label>
            <input type="number" min="0" style={inp} value={isManual ? '0' : counter} onChange={e => setCounter(e.target.value)} disabled={isManual} /></div>
          <div><label style={lb}>รอบเดินเครื่อง</label>
            <input type="number" min="0" style={inp} value={isManual ? '0' : machineCycle} onChange={e => setMachineCycle(e.target.value)} disabled={isManual} /></div>
          <div><label style={lb}>ยอดส่งคลัง (ชิ้น)</label>
            <input type="number" min="0" style={inp} value={warehousePcs} onChange={e => setWarehousePcs(e.target.value)} placeholder={`อัตโนมัติ = ${actualPcs}`} /></div>
        </div>
        <div style={{ marginTop: '10px', fontSize: '0.85rem', color: '#555', background: '#fdf6ec', border: '1px solid #f0e3cd', borderRadius: '9px', padding: '9px 12px' }}>
          🧮 ชิ้นที่ผลิตได้ = {num(actualBox)} ลัง × {num(packFactor)} ชิ้น/ลัง = <b>{actualPcs.toLocaleString()}</b> ชิ้น
          {isManual && <span style={{ marginLeft: '8px', color: '#a1887f' }}>(Manual line — Counter/รอบเครื่อง = 0)</span>}
        </div>
      </div>

      {/* ── เวลา ── */}
      <div style={card}>
        <div style={secTitle}>⏱ เวลา (นาที)</div>
        <div style={grid(120)}>
          <div><label style={lb}>เวลารวมผลิต</label>
            <input type="number" min="0" style={inp} value={runTime} onChange={e => setRunTime(e.target.value)} /></div>
          <div><label style={lb}>Setup</label>
            <input type="number" min="0" style={inp} value={setupTime} onChange={e => setSetupTime(e.target.value)} /></div>
          <div><label style={lb}>พัก</label>
            <input type="number" min="0" style={inp} value={breakTime} onChange={e => setBreakTime(e.target.value)} /></div>
          <div><label style={lb}>Clean</label>
            <input type="number" min="0" style={inp} value={cleanTime} onChange={e => setCleanTime(e.target.value)} /></div>
          <div><label style={lb}>หยุดหลังได้ยอด</label>
            <input type="number" min="0" style={inp} value={stopAfterTarget} onChange={e => setStopAfterTarget(e.target.value)} /></div>
          <div><label style={lb}>B-down</label>
            <input type="number" min="0" style={inp} value={bdownTime} onChange={e => setBdownTime(e.target.value)} /></div>
        </div>
        <div style={{ marginTop: '10px', fontSize: '0.85rem', color: '#555', background: '#fdf6ec', border: '1px solid #f0e3cd', borderRadius: '9px', padding: '9px 12px' }}>
          ⚙️ เวลาเดินเครื่อง = {num(runTime)} − {num(setupTime)} − {num(breakTime)} − {num(cleanTime)} − {num(stopAfterTarget)} − {num(bdownTime)} = <b style={{ color: machineRunTime < 0 ? '#d32f2f' : '#2e7d32' }}>{machineRunTime}</b> นาที
        </div>
      </div>

      {/* ── สถานะ ── */}
      <div style={card}>
        <div style={secTitle}>🎯 สถานะการผลิต</div>
        <div style={grid(200)}>
          <div><label style={lb}>สถานะ (อัตโนมัติจากแผนเทียบผลิตจริง)</label>
            <select style={inp} value={statusOverride} onChange={e => setStatusOverride(e.target.value)}>
              <option value="">อัตโนมัติ: {autoStatus}</option>
              <option value="ได้ยอดผลิต">ได้ยอดผลิต</option>
              <option value="ไม่ได้ยอดผลิต">ไม่ได้ยอดผลิต</option>
            </select></div>
          {status === 'ไม่ได้ยอดผลิต' && (
            <div style={{ gridColumn: '1 / -1' }}><label style={lb}>สาเหตุที่ไม่ได้ยอดผลิต *</label>
              <input style={inp} value={missReason} onChange={e => setMissReason(e.target.value)} placeholder="เช่น เครื่องเสีย 40 นาที" /></div>
          )}
        </div>
      </div>

      {/* ── ของเสีย ── */}
      <div style={card}>
        <div style={secTitle}>🗑 ของเสีย</div>
        {wastes.map((w, i) => (
          <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <select style={{ ...inp, flex: '1 1 160px' }} value={w.type} onChange={e => updateWaste(i, 'type', e.target.value)}>
              <option value="">-- ประเภท --</option>
              {WASTE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input type="number" min="0" style={{ ...inp, flex: '0 0 110px' }} placeholder="จำนวน (ใบ)" value={w.qty} onChange={e => updateWaste(i, 'qty', e.target.value)} />
            <button onClick={() => setWastes(prev => prev.filter((_, j) => j !== i))}
              style={{ flex: '0 0 auto', background: '#ffebee', color: '#d32f2f', border: '1px solid #ffcdd2', borderRadius: '9px', padding: '0 12px', cursor: 'pointer' }}>✕</button>
          </div>
        ))}
        <button onClick={() => setWastes(prev => [...prev, { type: '', qty: '' }])}
          style={{ background: '#fff3e0', color: '#e65100', border: '1px dashed #ffb74d', borderRadius: '9px', padding: '8px 14px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold' }}>
          ➕ เพิ่มรายการของเสีย
        </button>
        {wastes.length > 0 && (
          <div style={{ marginTop: '10px', fontSize: '0.85rem', color: '#555' }}>สรุป: {wasteDetail} (รวม {wastePcsTotal} ใบ)</div>
        )}
        <div style={{ marginTop: '10px' }}>
          <label style={lb}>สาเหตุชำรุด (ถ้ามี)</label>
          <input style={inp} value={damageReason} onChange={e => setDamageReason(e.target.value)} placeholder="เช่น ฟิล์มย่น เครื่องซีลไม่สนิท" />
        </div>
      </div>

      <button onClick={submit} disabled={sending}
        style={{ width: '100%', background: sending ? '#bdbdbd' : 'linear-gradient(135deg,#ff8a3c,#e65100)', color: '#fff', border: 'none', borderRadius: '12px', padding: '14px', fontWeight: 'bold', fontSize: '1rem', cursor: sending ? 'wait' : 'pointer', boxShadow: '0 6px 15px rgba(230,81,0,0.25)' }}>
        {sending ? '⏳ กำลังส่ง…' : '📤 ส่งรายงานเข้าคิวอนุมัติ'}
      </button>
    </div>
  );
};

export default SppReportForm;
