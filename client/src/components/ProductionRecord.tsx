import React, { useState, useEffect } from 'react';
import styles from '../App.module.css';
import FooterBar, { OperatorBadge } from './FooterBar';

interface ProductionRecordProps {
  operatorName: string;
  onBack: () => void;
  onBackToMain: () => void;
  onHome: () => void;
  onStatusChange: (active: boolean) => void;
}

interface CompletedBatch {
  line: number;
  batch: string;
  flavor: string;
  startTime: string;
  doneTime: string;
  duration: number;
  brix: string;
  ph: string;
  lotNo: string;
}

interface LineState {
  lotNo: string;
  flavor: string;
  shiftMode: 'new' | 'handover' | null;
  shiftBatch: string;
  cookingBatch: string;
  startTime: string | null;
  startRaw: Date | null;
  doneTime: string | null;
  brix: string;
  ph: string;
  history: CompletedBatch[];
  totalCompleted: number;
  cipCount: number;
  isProcessing: boolean;
  showInputs: boolean;
}

const apiUrl = "https://back-wash-test.onrender.com";
const DRAFT_KEY_PREFIX = 'production_draft_v1';

const lockKeyForLine = (lineId: number) => `production-line-${lineId}`;

const ProductionRecord: React.FC<ProductionRecordProps> = ({ operatorName, onHome, onStatusChange }) => {
  // แยก draft ตามชื่อผู้ใช้ กันข้อมูลค้างของคนหนึ่งไปโผล่ในเซสชันของอีกคนเมื่อใช้เครื่อง/เบราว์เซอร์เดียวกัน
  const DRAFT_KEY = `${DRAFT_KEY_PREFIX}_${operatorName}`;
  const batchOptions = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  // รสที่บันทึกเป็น No.1–20 (น้ำเชื่อม/เบส ผลิตเป็นรอบ) แทน Batch A-Z
  const NUMBERED_FLAVORS = ["Dilute W-Molass"];
  const isNumberedFlavor = (flavor: string) => NUMBERED_FLAVORS.includes(flavor);
  const getSeq = (flavor: string) => (isNumberedFlavor(flavor)
    ? Array.from({ length: 20 }, (_, i) => `No.${i + 1}`)
    : batchOptions);
  const unitWord = (flavor: string) => (isNumberedFlavor(flavor) ? 'รอบ' : 'Batch');
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [filterFlavorP, setFilterFlavorP] = useState('');
  const [filterLineP, setFilterLineP] = useState('');
  const [restoredNotice, setRestoredNotice] = useState(false);
  const [lockHolders, setLockHolders] = useState<Record<number, string | null>>({ 1: null, 2: null, 3: null, 4: null });

  // ── แผนผลิตวันนี้ ──────────────────────────────
  interface PlanItem { line: string; flavor: string; plannedBatches: string; }
  const todayStr = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
  const [showPlan, setShowPlan] = useState(false);
  const [planDate, setPlanDate] = useState(todayStr);
  const [planItems, setPlanItems] = useState<PlanItem[]>([]);
  const [planSaving, setPlanSaving] = useState(false);
  const [planLoaded, setPlanLoaded] = useState(false);

  const initialLineState: LineState = {
    lotNo: '',
    flavor: '',
    shiftMode: null,
    shiftBatch: '',
    cookingBatch: '',
    startTime: null,
    startRaw: null,
    doneTime: null,
    brix: '',
    ph: '',
    history: [],
    totalCompleted: 0,
    cipCount: 0,
    isProcessing: false,
    showInputs: true
  };

  const loadDraft = (): Record<number, LineState> | null => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const result: Record<number, LineState> = {} as Record<number, LineState>;
      [1, 2, 3, 4].forEach(id => {
        const saved = parsed[id];
        result[id] = saved
          ? { ...initialLineState, ...saved, startRaw: saved.startRaw ? new Date(saved.startRaw) : null }
          : { ...initialLineState };
      });
      return result;
    } catch {
      return null;
    }
  };

  const [lines, setLines] = useState<Record<number, LineState>>(() => {
    const draft = loadDraft();
    if (draft && Object.values(draft).some(l => l.isProcessing || l.history.length > 0 || l.flavor || l.cookingBatch)) {
      return draft;
    }
    return {
      1: { ...initialLineState },
      2: { ...initialLineState },
      3: { ...initialLineState },
      4: { ...initialLineState },
    };
  });

  useEffect(() => {
    const draft = loadDraft();
    if (draft && Object.values(draft).some(l => l.isProcessing)) {
      setRestoredNotice(true);
    }
  }, []);

  // บันทึกร่างข้อมูลลง localStorage ทุกครั้งที่มีการเปลี่ยนแปลง (กันข้อมูลหายตอน Reload/ล็อคหน้าจอ)
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(lines));
    } catch { /* ignore quota errors */ }
  }, [lines]);

  useEffect(() => {
    const anyProcessing = Object.values(lines).some(line => line.isProcessing);
    onStatusChange(anyProcessing);
  }, [lines, onStatusChange]);

  // ─── ระบบล็อคการทำงานซ้ำ (กันคนอื่นบันทึกข้อมูลซ้ำในเวลาเดียวกัน) ───
  const acquireLock = async (lineId: number): Promise<boolean> => {
    try {
      const res = await fetch(`${apiUrl}/api/locks/acquire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageKey: lockKeyForLine(lineId), operatorName })
      });
      if (!res.ok) throw new Error('lock check failed');
      const data = await res.json();
      if (data.locked) {
        setLockHolders(prev => ({ ...prev, [lineId]: data.operatorName }));
        alert(`🔒 Line ${lineId} กำลังถูกใช้งานโดยคุณ ${data.operatorName} อยู่ในขณะนี้\nกรุณารอสักครู่แล้วลองใหม่อีกครั้งครับ`);
        return false;
      }
      setLockHolders(prev => ({ ...prev, [lineId]: null }));
      return true;
    } catch {
      // เช็คสถานะการใช้งานไม่ได้ (เช่น เซิร์ฟเวอร์กำลังตื่น/เน็ตหลุด) — ห้ามเริ่มงานไว้ก่อนเพื่อกันบันทึกซ้ำ
      alert("⚠️ ไม่สามารถตรวจสอบสถานะการใช้งานได้ในขณะนี้ (เซิร์ฟเวอร์อาจกำลังเริ่มทำงาน)\nกรุณารอสักครู่ แล้วลองกด Start ใหม่อีกครั้งครับ");
      return false;
    }
  };

  const releaseLock = (lineId: number) => {
    fetch(`${apiUrl}/api/locks/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageKey: lockKeyForLine(lineId), operatorName })
    }).catch(() => {});
  };

  // ส่ง heartbeat ทุก 20 วินาที สำหรับทุก Line ที่กำลังประมวลผลอยู่ เพื่อรักษาล็อคไว้
  useEffect(() => {
    const interval = setInterval(() => {
      Object.entries(lines).forEach(([lineIdStr, line]) => {
        if (line.isProcessing) {
          const lineId = Number(lineIdStr);
          fetch(`${apiUrl}/api/locks/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pageKey: lockKeyForLine(lineId), operatorName })
          }).catch(() => {});
        }
      });
    }, 20000);
    return () => clearInterval(interval);
  }, [lines, operatorName]);

  // ตรวจสอบสถานะล็อคของแต่ละ Line เป็นระยะ เพื่อโชว์ข้อความ "กำลังใช้งาน"
  useEffect(() => {
    const checkLocks = () => {
      [1, 2, 3, 4].forEach(lineId => {
        if (lines[lineId].isProcessing) return; // ถ้าเรากำลังใช้งานอยู่ ไม่ต้องเช็ค
        fetch(`${apiUrl}/api/locks/status?pageKey=${encodeURIComponent(lockKeyForLine(lineId))}`)
          .then(r => r.json())
          .then(data => {
            setLockHolders(prev => ({ ...prev, [lineId]: (data.locked && data.operatorName !== operatorName) ? data.operatorName : null }));
          })
          .catch(() => {});
      });
    };
    checkLocks();
    const interval = setInterval(checkLocks, 15000);
    return () => clearInterval(interval);
  }, [lines, operatorName]);

  const flavorList = [
    "Amazon", "FDS", "Golden", "Freshy Lychee", "Freshy Strawberry",
    "Senorita Coconut", "Senorita Caramel","Senorita Lychee", "Freshy Blue Hawaii", "Freshy Lime",
    "Freshy Green Apple", "Freshy Passion fruit", "Freshy Sala", "Senorita Yuzu", "Senorita Peach",
    "MLH 02", "Freshy Pineapple", "Operator Name", "Freshy Grape",
    "Freshy Punch", "Freshy blue Lemon", "Senorita Fres Mint","Senorita Strawberry",
    "Freshy Orange", "Signature Rose", "Freshy Shine Muscat Grape", "Freshy Peach",
    "Freshy Mango", "Dilute W-Molass", "Freshy Brownsugar", "CIP",
  ];

  const flavorColors: Record<string, { bg: string; border: string }> = {
    "Amazon":            { bg: '#efebe9', border: '#795548' },
    "FDS":               { bg: '#eceff1', border: '#607d8b' },
    "Golden":            { bg: '#fff8e1', border: '#ffc107' },
    "Freshy Brownsugar":{ bg: '#fff8e1', border: '#ffc107' },
    "Freshy Lychee":     { bg: '#fce4ec', border: '#e91e63' },
    "Freshy Strawberry": { bg: '#ffebee', border: '#f44336' },
    "Senorita Strawberry": { bg: '#ffebee', border: '#f44336' },
    "Freshy Mango":      { bg: '#fffde7', border: '#f9a825' },
    "Senorita Coconut":  { bg: '#fafafa', border: '#bdbdbd' },
    "Senorita Peach":     { bg: '#fce4ec', border: '#e91e63' },
    "Senorita Caramel":  { bg: '#efebe9', border: '#a1887f' },
    "Freshy Blue Hawaii":{ bg: '#e1f5fe', border: '#03a9f4' },
    "Freshy Lime":       { bg: '#f9fbe7', border: '#8bc34a' },
    "CIP":               { bg: '#f5f5f5', border: '#9e9e9e' },
    "ว่าง":              { bg: '#eeeeee', border: '#bdbdbd' },
    "Freshy Green Apple":{ bg: '#e8f5e9', border: '#43a047' },
    "Freshy Sala":       { bg: '#fce4ec', border: '#e91e63' },
    "Senorita Yuzu":     { bg: '#fffde7', border: '#f9a825' },
    "MLH 02":            { bg: '#e0f2f1', border: '#009688' },
    "Freshy Pineapple":  { bg: '#fff9c4', border: '#f9a825' },
    "Operator Name":     { bg: '#f3f3f3', border: '#9e9e9e' },
    "Freshy Grape":      { bg: '#f3e5f5', border: '#9c27b0' },
    "Freshy Punch":      { bg: '#fce4ec', border: '#ff4081' },
    "Freshy blue Lemon": { bg: '#e3f2fd', border: '#42a5f5' },
    "Senorita Fres Mint":{ bg: '#e0f7fa', border: '#00bcd4' },
    "Freshy Orange":          { bg: '#fff3e0', border: '#ff9800' },
    "Signature Rose":         { bg: '#fce4ec', border: '#f06292' },
    "Freshy Shine Muscat Grape": { bg: '#f0fce4', border: '#76b82a' },
  };

  const getNextBatch = (currentBatch: string, flavor: string) => {
    const seq = getSeq(flavor);
    const index = seq.indexOf(currentBatch);
    if (index === -1 || index === seq.length - 1) return "";
    return seq[index + 1];
  };

  const handleCookingBatchChange = (lineId: number, selectedBatch: string) => {
    const line = lines[lineId];
    // กะเริ่ม: Batch แรกเลือกได้อิสระ ไม่ต้องตรวจลำดับ
    if (line.shiftMode === 'new' && line.history.length === 0) {
      setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], cookingBatch: selectedBatch } }));
      return;
    }
    const lastBatch = line.history.length > 0 ? line.history[line.history.length - 1].batch : line.shiftBatch;
    if (!lastBatch) { alert("กรุณาเลือก 'รับช่วงต่อจาก Batch' ก่อนครับ"); return; }
    const expectedBatch = getNextBatch(lastBatch, line.flavor);
    if (selectedBatch !== expectedBatch) { alert(`ลำดับไม่ถูกต้อง! ลำดับที่ต้องทำคือ ${unitWord(line.flavor)} ${expectedBatch}`); return; }
    setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], cookingBatch: selectedBatch } }));
  };

  const fmtLotNo = (dateStr: string) => {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    if (!y || !m || !d) return dateStr;
    return `${d}${m}${y.slice(2)}`;
  };

  const handleStart = async (lineId: number) => {
    const line = lines[lineId];
    if (!line.flavor || !line.cookingBatch) { alert("กรุณาเลือก รสชาติ และ Batch เริ่มต้ม ก่อนกด Start"); return; }
    const gotLock = await acquireLock(lineId);
    if (!gotLock) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], startTime: timeStr, startRaw: now, doneTime: null, isProcessing: true } }));
    // ทิ้งสถานะ "กำลังเดินเครื่อง" ไว้ที่ server ให้ Live board เห็นแบบ real-time (best-effort)
    fetch(`${apiUrl}/api/line-state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: `Line ${lineId}`, status: line.flavor === 'CIP' ? 'cip' : 'producing', flavor: line.flavor, batch: line.cookingBatch, operator: operatorName }) }).catch(() => {});
  };

  const handleDone = async (lineId: number) => {
    const line = lines[lineId];
    if (!line.startTime || !line.startRaw) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    const diffMs = now.getTime() - line.startRaw.getTime();
    const diffMins = Math.round(diffMs / 60000);
    const isCip = line.flavor === "CIP";
    const formattedLotNo = fmtLotNo(line.lotNo);
    const newCompletedBatch: CompletedBatch = { line: lineId, batch: line.cookingBatch, flavor: line.flavor, startTime: line.startTime, doneTime: timeStr, duration: diffMins, brix: line.brix, ph: line.ph, lotNo: formattedLotNo };
    const newHistory = [...line.history, newCompletedBatch];
    const newTotalCompleted = line.totalCompleted + 1;
    const newCipCount = isCip ? line.cipCount + 1 : line.cipCount;
    setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], doneTime: timeStr, history: newHistory, totalCompleted: newTotalCompleted, cipCount: newCipCount, isProcessing: false, showInputs: false, cookingBatch: '', startTime: null, startRaw: null, brix: '', ph: '' } }));
    releaseLock(lineId);
    try {
      await fetch(`${apiUrl}/api/production/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: `Line ${lineId}`, flavor: line.flavor, batch: line.cookingBatch, operator: operatorName, timestamp: new Date().toISOString(), duration: diffMins, brix: line.brix, ph: line.ph, cipCount: isCip ? "1 Batch" : "-", lotNo: formattedLotNo, startTime: line.startTime, endTime: timeStr }) });
      // เคลียร์สถานะ "กำลังเดินเครื่อง" → ว่าง เมื่อ Done (best-effort)
      fetch(`${apiUrl}/api/line-state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: `Line ${lineId}`, status: 'idle', flavor: line.flavor, batch: line.cookingBatch, operator: operatorName }) }).catch(() => {});
    } catch (error) { console.error("Failed to log:", error); }
  };

  const resetLine = (lineId: number) => {
    if (window.confirm(`ล้างข้อมูลทั้งหมดของ Line ${lineId} ใช่หรือไม่?`)) {
      setLines(prev => ({ ...prev, [lineId]: { ...initialLineState } }));
      releaseLock(lineId);
    }
  };

  const finishSession = () => {
    if (window.confirm("🏁 ยืนยันสิ้นสุดการทำงานทั้งหมดหรือไม่? ข้อมูลทุก Line ในหน้านี้จะถูกล้างค่าใหม่")) {
      setLines({ 1: { ...initialLineState }, 2: { ...initialLineState }, 3: { ...initialLineState }, 4: { ...initialLineState } });
      [1, 2, 3, 4].forEach(releaseLock);
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      onStatusChange(false);
      alert("ล้างข้อมูลการผลิตเรียบร้อยแล้ว");
    }
  };

  const allHistory = Object.values(lines).flatMap(l => l.history).sort((a, b) => b.line - a.line);

  // โหลดแผนผลิตของวันที่เลือก
  const loadPlan = async (date: string) => {
    try {
      const res = await fetch(`${apiUrl}/api/production/plan?date=${date}`);
      const data = await res.json();
      const items: PlanItem[] = (data.items || []).map((r: { line_name: string; flavor: string; planned_batches: number }) => ({
        line: r.line_name || 'รวม', flavor: r.flavor || '', plannedBatches: String(r.planned_batches ?? 0),
      }));
      setPlanItems(items);
    } catch (e) { console.error('load plan failed', e); }
    finally { setPlanLoaded(true); }
  };

  useEffect(() => { loadPlan(todayStr); /* eslint-disable-next-line */ }, []);

  const addPlanRow = () => setPlanItems(prev => [...prev, { line: 'รวม', flavor: '', plannedBatches: '' }]);
  const updatePlanRow = (i: number, field: keyof PlanItem, value: string) =>
    setPlanItems(prev => prev.map((it, idx) => idx === i ? { ...it, [field]: value } : it));
  const removePlanRow = (i: number) => setPlanItems(prev => prev.filter((_, idx) => idx !== i));

  // นับยอดผลิตจริง (batch) ตามรสชาติ — ถ้าแผนระบุ Line เจาะจง ก็กรองตาม Line ด้วย
  const actualFor = (item: PlanItem) => {
    return allHistory.filter(h => {
      if (item.flavor && h.flavor !== item.flavor) return false;
      if (item.line && item.line !== 'รวม' && `Line ${h.line}` !== item.line && String(h.line) !== item.line.replace(/\D/g, '')) return false;
      return true;
    }).length;
  };

  const savePlan = async () => {
    const valid = planItems.filter(it => it.flavor && Number(it.plannedBatches) > 0);
    if (valid.length === 0) { alert('กรุณากรอกอย่างน้อย 1 รายการ (เลือกรสชาติ และจำนวน batch มากกว่า 0)'); return; }
    setPlanSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/production/plan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planDate, operator: operatorName, items: valid }),
      });
      const data = await res.json();
      if (data.success) alert(`✅ บันทึกแผนผลิตสำเร็จ (${data.saved} รายการ รวม ${data.total} batch)`);
      else alert('บันทึกไม่สำเร็จ: ' + (data.error || 'unknown'));
    } catch (e) { alert('เชื่อมต่อ server ไม่สำเร็จ'); console.error(e); }
    finally { setPlanSaving(false); }
  };

  const planTotal = planItems.reduce((s, it) => s + (Number(it.plannedBatches) || 0), 0);
  const actualTotal = allHistory.length;

  // ดึงจากบันทึกส่งกะล่าสุด → เติมรส/CIP + ตั้ง "รับช่วงต่อจาก Batch" ให้ทุกไลน์ (แก้เองได้)
  const pullFromHandover = async () => {
    try {
      const r = await fetch(`${apiUrl}/api/handover/last`);
      const d = await r.json();
      const data = d?.data;
      if (!data) { alert('ยังไม่มีข้อมูลส่งกะให้ดึง'); return; }
      let n = 0;
      setLines(prev => {
        const next = { ...prev };
        const seed = (id: number, flavor: string, batch: string, mode: 'new' | 'handover') => {
          const cur = next[id];
          if (!cur || cur.isProcessing || cur.history.length > 0) return; // ไม่ทับไลน์ที่เริ่มผลิตแล้ว
          next[id] = { ...cur, shiftMode: mode, flavor: flavor || cur.flavor, shiftBatch: batch, cookingBatch: '' };
          n++;
        };
        // Line 1-3 (batch จากช่อง "Batch ล่าสุด")
        for (const ln of (data.lines || [])) {
          const m = String(ln.line || '').match(/(\d)/);
          if (!m) continue;
          const id = Number(m[1]);
          if (id < 1 || id > 3) continue;
          const isCip = /cip/i.test(ln.flavor || '');
          if (isCip) seed(id, 'CIP', '', 'new');
          else seed(id, ln.flavor || '', ln.batch || '', 'handover');
        }
        // Line 4 (batch อยู่ที่ Storage · CIP = ทุก stage ว่าง)
        const l4 = data.line4;
        if (l4) {
          const stages: string[] = l4.stages || [];
          const allEmpty = stages.every(s => !s || !String(s).trim());
          const isCip4 = /cip/i.test(l4.flavor || '') || allEmpty;
          // batch ของ Line 4 อาจอยู่สเตชั่นไหนก็ได้ (ไหลจาก Mixing→…→Storage→Filling) — สแกนทุกช่อง
          let l4batch = '';
          for (const s of stages) { const bm = String(s || '').match(/Batch\s*([A-Za-z])/i); if (bm) l4batch = bm[1].toUpperCase(); }
          if (isCip4) seed(4, 'CIP', '', 'new');
          else seed(4, l4.flavor || '', l4batch, 'handover');
        }
        return next;
      });
      alert(n ? `📥 ดึงจากส่งกะแล้ว (${n} ไลน์) — ตรวจ/แก้ได้ตามต้องการ` : 'ไม่มีไลน์ที่ต้องอัปเดต (อาจเริ่มผลิตไปแล้ว)');
    } catch { alert('ดึงข้อมูลส่งกะไม่สำเร็จ'); }
  };

  return (
    <div style={{ paddingBottom: '120px' }}>
      {/* 1. หัวข้อหลักบนสุด */}
      <h2 className={styles.header} style={{ width: '95%', maxWidth: '500px', margin: '20px auto 15px auto', background: 'linear-gradient(135deg, #4caf50, #2e7d32)', borderRadius: '15px', padding: '15px', color: '#ffffff', textAlign: 'center', boxShadow: '0 6px 15px rgba(76, 175, 80, 0.3)' }}>
        Production Control
      </h2>

      {restoredNotice && (
        <div style={{ width: '95%', maxWidth: '500px', margin: '0 auto 15px auto', background: '#fff3e0', border: '1px solid #ffb74d', borderRadius: '12px', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
          <span style={{ color: '#e65100', fontSize: '0.85rem', fontWeight: 'bold' }}>📌 กู้คืนข้อมูลที่ค้างไว้ก่อนหน้านี้แล้ว (กันข้อมูลหายตอน Reload/ล็อคหน้าจอ)</span>
          <button onClick={() => setRestoredNotice(false)} style={{ background: 'transparent', border: 'none', color: '#e65100', fontWeight: 'bold', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
        </div>
      )}

      {/* ── แผนผลิตวันนี้ ── */}
      <div style={{ width: '95%', maxWidth: '900px', margin: '0 auto 20px auto' }}>
        <button
          onClick={() => setShowPlan(s => !s)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'linear-gradient(135deg, #1565c0, #0d47a1)', color: 'white', border: 'none', borderRadius: '15px', padding: '14px 20px', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer', boxShadow: '0 6px 15px rgba(21,101,192,0.25)' }}
        >
          <span>📋 แผนผลิตวันนี้ {planLoaded && planItems.length > 0 ? `(${planItems.length} รายการ • ${actualTotal}/${planTotal} batch)` : ''}</span>
          <span style={{ fontSize: '1.2rem' }}>{showPlan ? '▲' : '▼'}</span>
        </button>

        {showPlan && (
          <div style={{ background: '#ffffff', border: '2px solid #1565c0', borderTop: 'none', borderRadius: '0 0 15px 15px', padding: '18px', boxShadow: '0 6px 15px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
              <label className={styles.formLabel} style={{ fontWeight: 'bold', color: '#0d47a1' }}>🗓 วันที่ผลิต</label>
              <input type="date" className={styles.formInput} value={planDate} onChange={e => { setPlanDate(e.target.value); loadPlan(e.target.value); }} style={{ maxWidth: '180px', fontWeight: 'bold' }} />
              <div style={{ marginLeft: 'auto', fontSize: '0.9rem', color: '#555' }}>รวมแผน: <b style={{ color: '#0d47a1' }}>{planTotal}</b> batch • ผลิตจริง: <b style={{ color: '#2e7d32' }}>{actualTotal}</b> batch</div>
            </div>

            {planItems.length === 0 && (
              <div style={{ textAlign: 'center', color: '#999', padding: '15px', background: '#f9f9f9', borderRadius: '10px', marginBottom: '12px' }}>ยังไม่มีรายการแผน — กด "➕ เพิ่มรายการ" เพื่อวางแผนผลิตของวันนี้</div>
            )}

            {planItems.map((it, i) => {
              const done = actualFor(it);
              const target = Number(it.plannedBatches) || 0;
              const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
              const theme = flavorColors[it.flavor];
              return (
                <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '10px', marginBottom: '8px', borderRadius: '12px', background: theme ? theme.bg : '#f5f7fa', border: `1px solid ${theme ? theme.border : '#e0e0e0'}` }}>
                  <select className={styles.formInput} value={it.line} onChange={e => updatePlanRow(i, 'line', e.target.value)} style={{ flex: '0 0 90px', padding: '8px', borderRadius: '8px' }}>
                    <option value="รวม">รวม</option>
                    {[1, 2, 3, 4].map(l => <option key={l} value={`Line ${l}`}>Line {l}</option>)}
                  </select>
                  <select className={styles.formInput} value={it.flavor} onChange={e => updatePlanRow(i, 'flavor', e.target.value)} style={{ flex: '1 1 150px', padding: '8px', borderRadius: '8px' }}>
                    <option value="">-- เลือกรสชาติ --</option>
                    {flavorList.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <input type="number" min="0" className={styles.formInput} placeholder="แผน" value={it.plannedBatches} onChange={e => updatePlanRow(i, 'plannedBatches', e.target.value)} style={{ flex: '0 0 80px', padding: '8px', borderRadius: '8px', textAlign: 'center' }} />
                  <div style={{ flex: '1 1 160px', minWidth: '140px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#444', marginBottom: '3px' }}>
                      <span>จริง {done}/{target}</span><span style={{ fontWeight: 'bold', color: pct >= 100 ? '#2e7d32' : '#1565c0' }}>{pct}%</span>
                    </div>
                    <div style={{ height: '10px', background: '#e0e0e0', borderRadius: '6px', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'linear-gradient(90deg,#43a047,#2e7d32)' : 'linear-gradient(90deg,#42a5f5,#1565c0)', transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                  <button onClick={() => removePlanRow(i)} style={{ flex: '0 0 auto', background: '#ffebee', color: '#d32f2f', border: '1px solid #ffcdd2', borderRadius: '8px', padding: '6px 10px', cursor: 'pointer', fontSize: '0.8rem' }}>✕</button>
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
              <button onClick={addPlanRow} style={{ flex: 1, padding: '12px', background: '#e3f2fd', color: '#1565c0', border: '2px dashed #1565c0', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>➕ เพิ่มรายการ</button>
              <button onClick={savePlan} disabled={planSaving} style={{ flex: 1, padding: '12px', background: planSaving ? '#ccc' : 'linear-gradient(135deg,#1565c0,#0d47a1)', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: planSaving ? 'default' : 'pointer' }}>{planSaving ? 'กำลังบันทึก...' : '💾 บันทึกแผน'}</button>
            </div>
          </div>
        )}
      </div>

      {/* ดึงจากบันทึกส่งกะ */}
      <div style={{ width: '95%', maxWidth: '900px', margin: '0 auto 16px auto' }}>
        <button onClick={pullFromHandover}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: '#fff', color: '#0277bd', border: '2px solid #0277bd', borderRadius: '12px', padding: '12px', fontWeight: 'bold', fontSize: '0.95rem', cursor: 'pointer' }}>
          📥 ดึงจากส่งกะ (เติมรส + รับช่วง Batch อัตโนมัติ)
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px', padding: '10px' }}>
        {[1, 2, 3, 4].map(lineId => {
          const line = lines[lineId];
          const lastBatch = line.history.length > 0 ? line.history[line.history.length - 1].batch : line.shiftBatch;
          const nextExpectedBatch = getNextBatch(lastBatch, line.flavor);
          const flavorTheme = line.isProcessing && line.flavor ? flavorColors[line.flavor] : null;
          return (
            <div key={lineId} className={styles.stepCard} style={{ borderColor: flavorTheme ? flavorTheme.border : '#4caf50', borderWidth: flavorTheme ? '3px' : undefined, background: flavorTheme ? flavorTheme.bg : (line.showInputs ? '#ffffff' : '#f1f8e9'), padding: '20px', transition: 'background 0.5s ease, border-color 0.5s ease' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: '#2e7d32' }}>Line {lineId}</h3>
                <button onClick={() => resetLine(lineId)} style={{ background: '#ffebee', color: '#d32f2f', border: '1px solid #ffcdd2', borderRadius: '8px', padding: '4px 12px', fontSize: '0.7rem', cursor: 'pointer' }}>ล้างค่า</button>
              </div>
              {lockHolders[lineId] && !line.isProcessing && (
                <div style={{ background: '#fce4ec', border: '1px solid #f48fb1', borderRadius: '10px', padding: '10px 14px', marginBottom: '15px', textAlign: 'center' }}>
                  <span style={{ color: '#ad1457', fontWeight: 'bold', fontSize: '0.85rem' }}>🔒 กำลังใช้งานโดยคุณ {lockHolders[lineId]} อยู่ในขณะนี้ — กรุณารอสักครู่</span>
                </div>
              )}
              {line.showInputs ? (
                <>
                  <div className={styles.formGroup} style={{ marginBottom: '10px' }}>
                    <label className={styles.formLabel}>รสชาติ/แบรนด์ (Flavor)</label>
                    <select className={styles.formInput} value={line.flavor} onChange={(e) => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], flavor: e.target.value, shiftBatch: '', cookingBatch: '' } }))} disabled={line.isProcessing}>
                      <option value="">-- เลือกกลิ่น --</option>
                      {flavorList.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div className={styles.formGroup} style={{ marginBottom: '10px' }}>
                    <label className={styles.formLabel}>🏷️ Lot No. (วันที่ผลิต)</label>
                    <input
                      type="date"
                      className={styles.formInput}
                      value={line.lotNo}
                      onChange={e => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], lotNo: e.target.value } }))}
                      disabled={line.isProcessing}
                      style={{ fontWeight: 'bold' }}
                    />
                    {line.lotNo && <div style={{ marginTop: '5px', fontWeight: 'bold', fontSize: '1.1rem', color: '#2e7d32', letterSpacing: '2px' }}>→ {fmtLotNo(line.lotNo)}</div>}
                  </div>

                  {/* ปุ่มเลือกโหมดกะ */}
                  {!line.isProcessing && (
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                      <button
                        onClick={() => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], shiftMode: 'new', shiftBatch: '', cookingBatch: '' } }))}
                        style={{ flex: 1, padding: '12px', background: line.shiftMode === 'new' ? '#1565c0' : '#e3f2fd', color: line.shiftMode === 'new' ? 'white' : '#1565c0', border: '2px solid #1565c0', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.95rem' }}
                      >
                        🌅 กะเริ่ม
                      </button>
                      <button
                        onClick={() => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], shiftMode: 'handover', shiftBatch: '', cookingBatch: '' } }))}
                        style={{ flex: 1, padding: '12px', background: line.shiftMode === 'handover' ? '#e65100' : '#fff3e0', color: line.shiftMode === 'handover' ? 'white' : '#e65100', border: '2px solid #e65100', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.95rem' }}
                      >
                        🔄 รับช่วง
                      </button>
                    </div>
                  )}

                  {/* Batch selector — แสดงเมื่อเลือกโหมดแล้ว */}
                  {line.shiftMode !== null && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '20px', background: 'linear-gradient(90deg, #fff9c4 0%, #e3f2fd 50%, #e8f5e9 100%)', padding: '12px', borderRadius: '18px', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.05)', position: 'relative' }}>
                      {line.shiftMode === 'handover' && (
                        <div className={styles.formGroup} style={{ flex: 1 }}>
                          <label className={styles.formLabel} style={{ fontSize: '0.68rem', textAlign: 'center', display: 'block', color: '#8d6e63', fontWeight: 'bold' }}>📥 รับช่วงต่อ</label>
                          <select className={styles.formInput} value={line.shiftBatch} onChange={(e) => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], shiftBatch: e.target.value, cookingBatch: '' } }))} disabled={line.history.length > 0 || line.isProcessing} style={{ backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '8px', fontSize: '0.9rem', textAlign: 'center', borderRadius: '10px', border: '1px solid #fbc02d' }}>
                            <option value="">--</option>
                            {getSeq(line.flavor).map(b => <option key={b} value={b}>{b}</option>)}
                          </select>
                        </div>
                      )}
                      {(line.shiftMode === 'handover' || line.history.length > 0) && (
                        <div style={{ flex: 1, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                          <div style={{ fontSize: '0.68rem', color: '#1565c0', marginBottom: '4px', fontWeight: 'bold' }}>📍 ล่าสุด</div>
                          <div style={{ background: lastBatch ? 'linear-gradient(135deg, #1565c0, #1e88e5)' : '#fff', padding: '6px 0', borderRadius: '10px', width: '100%', fontWeight: '800', color: lastBatch ? '#ffffff' : '#90caf9', fontSize: '1rem', minHeight: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{lastBatch || '--'}</div>
                          <div style={{ fontSize: '1rem', marginTop: '2px', color: '#1e88e5' }}>➜</div>
                        </div>
                      )}
                      <div className={styles.formGroup} style={{ flex: 1 }}>
                        <label className={styles.formLabel} style={{ fontSize: '0.68rem', textAlign: 'center', display: 'block', color: '#2e7d32', fontWeight: 'bold' }}>🔥 เริ่มต้ม</label>
                        <select className={styles.formInput} value={line.cookingBatch} onChange={(e) => handleCookingBatchChange(lineId, e.target.value)} disabled={line.isProcessing || (line.shiftMode === 'handover' && !line.shiftBatch && line.history.length === 0)} style={{ background: 'rgba(255, 255, 255, 0.9)', border: '2px solid #4caf50', padding: '8px', fontSize: '0.9rem', textAlign: 'center', borderRadius: '10px', fontWeight: 'bold' }}>
                          <option value="">--</option>
                          {getSeq(line.flavor).map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
                    <button onClick={() => handleStart(lineId)} disabled={line.isProcessing || !line.cookingBatch || !!lockHolders[lineId]} style={{ flex: 1.5, padding: '12px', background: (line.isProcessing || lockHolders[lineId]) ? '#ccc' : '#4caf50', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>▶️ Start {isNumberedFlavor(line.flavor) ? line.cookingBatch : `Batch ${line.cookingBatch}`}</button>
                    <div style={{ flex: 1, textAlign: 'center', background: '#f5f5f5', padding: '10px', borderRadius: '10px', border: '1px solid #ddd' }}>
                      <small style={{ display: 'block', fontSize: '0.68rem', color: '#888' }}>เวลาเริ่ม</small>
                      <strong>{line.startTime || '--:--'}</strong>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '15px' }}>
                    <div className={styles.formGroup}><label className={styles.formLabel}>ค่า Brix</label><input type="number" className={styles.formInput} placeholder="Brix" value={line.brix} onChange={(e) => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], brix: e.target.value } }))} disabled={!line.isProcessing} /></div>
                    <div className={styles.formGroup}><label className={styles.formLabel}>ค่า PH</label><input type="number" className={styles.formInput} placeholder="PH" value={line.ph} onChange={(e) => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], ph: e.target.value } }))} disabled={!line.isProcessing} /></div>
                  </div>
                  <button onClick={() => { if (!line.brix || !line.ph) { alert("⚠️ กรุณากรอกค่า Brix และ PH ให้ครบถ้วนก่อนกด Done ครับ!"); return; } handleDone(lineId); }} disabled={!line.isProcessing || !line.brix || !line.ph} style={{ width: '100%', padding: '15px', background: (!line.isProcessing || !line.brix || !line.ph) ? '#ccc' : '#f44336', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>{(!line.brix || !line.ph) ? '📝 กรุณากรอก Brix & PH' : '⏹️ Done (เสร็จสิ้น)'}</button>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '10px 0' }}>
                  <div style={{ fontSize: '1.2rem', color: '#2e7d32', fontWeight: 'bold', marginBottom: '10px' }}>✅ บันทึกสำเร็จ!</div>
                  {line.lotNo && (
                    <div style={{ background: '#e8f5e9', padding: '8px 12px', borderRadius: '10px', marginBottom: '10px', border: '1px solid #a5d6a7', display: 'inline-block' }}>
                      <span style={{ fontWeight: 'bold', color: '#2e7d32', fontSize: '0.95rem' }}>🏷️ Lot No. {line.lotNo}</span>
                    </div>
                  )}
                  <div style={{ background: '#fff9c4', padding: '12px', borderRadius: '10px', marginBottom: '20px', border: '1px solid #fbc02d' }}><div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#f57f17' }}>{unitWord(line.flavor)} ต่อไปที่คุณต้องผลิตคือ: {nextExpectedBatch || 'จบเซ็ตแล้ว'}</div></div>
                  <button onClick={() => setLines(prev => ({ ...prev, [lineId]: { ...prev[lineId], showInputs: true } }))} style={{ width: '100%', padding: '15px', background: '#2e7d32', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>➕ เตรียมผลิต Batch ถัดไป</button>
                </div>
              )}
              <div style={{ marginTop: '15px', display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ color: '#1565c0', fontWeight: 'bold', fontSize: '0.9rem' }}>✅ ผลิตเสร็จแล้ว: {line.totalCompleted} {unitWord(line.flavor)}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '40px', marginBottom: '20px', padding: '0 15px' }}>
        <button onClick={() => setShowSummaryModal(true)} style={{ background: 'linear-gradient(135deg, #1565c0, #0d47a1)', color: 'white', border: 'none', borderRadius: '15px', padding: '18px 30px', fontWeight: 'bold', fontSize: '1.1rem', cursor: 'pointer', boxShadow: '0 8px 20px rgba(21, 101, 192, 0.3)', width: '100%', maxWidth: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>📊 ดูสรุปการผลิตทั้งหมด ({allHistory.length} รายการ)</button>
      </div>

      {showSummaryModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '15px' }}>
            <div style={{ backgroundColor: 'white', width: '100%', maxWidth: '800px', maxHeight: '90vh', borderRadius: '25px', padding: '25px', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.15)', border: '1px solid #eee' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', borderBottom: '2px solid #eee', paddingBottom: '15px' }}>
                    <h3 style={{ margin: 0, color: '#1565c0' }}>📊 สรุปรายการผลิตทั้งหมด</h3>
                    <button onClick={() => setShowSummaryModal(false)} style={{ background: '#f5f5f5', color: '#666', border: '1px solid #ddd', borderRadius: '50%', width: '35px', height: '35px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1rem' }}>X</button>
                </div>
                {/* ตัวกรอง */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '15px', flexWrap: 'wrap' }}>
                  <input type="text" placeholder="🔍 กลิ่น" value={filterFlavorP} onChange={e => setFilterFlavorP(e.target.value)} style={{ padding: '8px 12px', borderRadius: '10px', border: '1px solid #ddd', fontSize: '0.85rem', flex: 1, minWidth: '120px' }} />
                  <select value={filterLineP} onChange={e => setFilterLineP(e.target.value)} style={{ padding: '8px 12px', borderRadius: '10px', border: '1px solid #ddd', fontSize: '0.85rem', flex: 1, minWidth: '100px' }}>
                    <option value="">ทุก Line</option>
                    {[1,2,3,4].map(l => <option key={l} value={String(l)}>Line {l}</option>)}
                  </select>
                  {(filterFlavorP || filterLineP) && <button onClick={() => { setFilterFlavorP(''); setFilterLineP(''); }} style={{ padding: '8px 12px', borderRadius: '10px', border: '1px solid #ddd', background: '#f5f5f5', cursor: 'pointer', fontSize: '0.85rem' }}>✕ ล้าง</button>}
                </div>
                <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}><thead><tr style={{ backgroundColor: '#f5f5f5' }}><th style={{ padding: '10px', border: '1px solid #ddd' }}>Line</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>Lot No.</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>Batch</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>รสชาติ</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>เวลา Start-Done</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>Brix</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>PH</th><th style={{ padding: '10px', border: '1px solid #ddd' }}>รวมเวลา</th></tr></thead><tbody>{allHistory.filter(h => {
                  if (filterFlavorP && !(h.flavor || '').toLowerCase().includes(filterFlavorP.toLowerCase())) return false;
                  if (filterLineP && String(h.line) !== filterLineP) return false;
                  return true;
                }).length > 0 ? allHistory.filter(h => {
                  if (filterFlavorP && !(h.flavor || '').toLowerCase().includes(filterFlavorP.toLowerCase())) return false;
                  if (filterLineP && String(h.line) !== filterLineP) return false;
                  return true;
                }).map((h, i) => (<tr key={i} style={{ textAlign: 'center' }}><td style={{ padding: '10px', border: '1px solid #ddd' }}>Line {h.line}</td><td style={{ padding: '10px', border: '1px solid #ddd', fontWeight: 'bold', color: '#2e7d32' }}>{h.lotNo || '-'}</td><td style={{ padding: '10px', border: '1px solid #ddd', fontWeight: 'bold' }}>{h.batch}</td><td style={{ padding: '10px', border: '1px solid #ddd' }}>{h.flavor}</td><td style={{ padding: '10px', border: '1px solid #ddd' }}>{h.startTime} - {h.doneTime}</td><td style={{ padding: '10px', border: '1px solid #ddd', color: '#1b5e20', fontWeight: 'bold' }}>{h.brix}</td><td style={{ padding: '10px', border: '1px solid #ddd', color: '#1b5e20', fontWeight: 'bold' }}>{h.ph}</td><td style={{ padding: '10px', border: '1px solid #ddd', color: '#d84315', fontWeight: 'bold' }}>{h.duration} นาที</td></tr>)) : (<tr><td colSpan={8} style={{ padding: '20px', textAlign: 'center', color: '#888' }}>ไม่พบรายการที่ตรงกับตัวกรอง</td></tr>)}</tbody></table></div>
                <button onClick={() => setShowSummaryModal(false)} style={{ width: '100%', padding: '12px', background: '#424242', color: 'white', border: 'none', borderRadius: '10px', marginTop: '20px', fontWeight: 'bold', cursor: 'pointer' }}>ปิดหน้าต่างนี้</button>
            </div>
        </div>
      )}

      <FooterBar
        accentColor="#4caf50"
        homeLabel="Home"
        onHome={() => { const pin = window.prompt("กรุณาใส่รหัสผ่านเพื่อกลับหน้าแรก:"); if (pin === "1234") onHome(); else if (pin !== null) alert("รหัสผ่านไม่ถูกต้อง!"); }}
        finishLabel="สิ้นสุดการทำงาน"
        onFinish={finishSession}
        right={<OperatorBadge name={operatorName} color="#2e7d32" />}
      />
    </div>
  );
};

export default ProductionRecord;
