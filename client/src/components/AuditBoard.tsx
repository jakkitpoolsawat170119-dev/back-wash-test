import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { uploadDutyImage } from '../lib/dutyImages';

// ใช้ Render เป็นค่าเริ่มต้น; override ด้วย VITE_API_BASE เวลาทดสอบ local (เหมือน TodoBoard)
const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

// ── ประเภทงาน (ตรงกับหมวดใน To-do) ───────────────────────────────────────────
const CAT_META: Record<string, { c: string; bg: string; ic: string; label: string }> = {
  cleaning:    { c: '#00838f', bg: '#e0f7fa', ic: '🧽', label: 'ทำความสะอาด' },
  maintenance: { c: '#546e7a', bg: '#eceff1', ic: '🔧', label: 'ซ่อมบำรุง' },
};
const catMeta = (k: string) => CAT_META[k] || CAT_META.cleaning;

// ที่มาของการเดา
const SRC_META: Record<string, { label: string; c: string; bg: string }> = {
  sheet:  { label: '📄 จากเอกสาร', c: '#00695c', bg: '#e0f2f1' },
  rule:   { label: '🔒 กฎ',        c: '#2e7d32', bg: '#e8f5e9' },
  ai:     { label: '🤖 AI',        c: '#6a1b9a', bg: '#f3e5f5' },
  review: { label: '⚠️ เลือกเอง',  c: '#b26a00', bg: '#fff4e0' },
};

// โซนที่พบบ่อย — ช่วยกรอกเร็ว (datalist)
const ZONE_HINTS = [
  'ชั้น 1', 'ชั้น 2', 'ชั้น 3', 'ห้องต้ม ชั้น 2',
  'ชั้น 3 ห้องเก็บ Ingredient', 'ห้องเก็บ Ingredient ชั้น 2',
  'ชั้น 3 หน้าไลน์ Icing', 'Icing', 'ห้องแต่งตัวผู้ชาย',
];

// ── ย่อรูปก่อนแนบ — คืน data URL + base64 (เหมือน TodoBoard) ────────────────
type PhotoAttach = { preview: string; data: string; mediaType: string };
const resizeTo = (file: File, maxEdge: number, quality: number): Promise<PhotoAttach> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const el = new Image();
    el.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(el.width, el.height));
      const w = Math.max(1, Math.round(el.width * scale)), h = Math.max(1, Math.round(el.height * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
      cx.drawImage(el, 0, 0, w, h);
      const dataUrl = cv.toDataURL('image/jpeg', quality);
      resolve({ preview: dataUrl, data: dataUrl.split(',')[1] || '', mediaType: 'image/jpeg' });
    };
    el.onerror = reject; el.src = String(reader.result);
  };
  reader.onerror = reject; reader.readAsDataURL(file);
});
// รูปหน้างาน (ก่อน/หลังทำ) — พอแค่ 1568px
const resizePhoto = (file: File) => resizeTo(file, 1568, 0.85);
// รูปเอกสาร — ส่งคมกว่า (2576px = ขนาดสูงสุดที่โมเดลรับ) เพราะตัวหนังสือในตารางเล็ก
const resizeSheet = (file: File) => resizeTo(file, 2576, 0.9);

type Person = { key: string; name: string; role?: string; color?: string; dot?: string; kind?: string };
type Row = {
  id: number;
  issue: string;
  location: string;
  priority: 'normal' | 'urgent';
  photo: PhotoAttach | null;      // ภาพก่อนทำ (ตอนพบ)
  donePhoto: PhotoAttach | null;  // ภาพหลังทำ (ถ้าแก้เสร็จหน้างานเลย → ปิดงานทันที)
  category: string;
  assignees: string[];      // person keys
  source: string | null;    // 'rule' | 'ai' | 'review' | null(ยังไม่แบ่ง)
  confidence: number;
  lowConfidence: boolean;
  matchedRule: string | null;
};

let _seq = 1;
const blankRow = (): Row => ({
  id: _seq++, issue: '', location: '', priority: 'normal', photo: null, donePhoto: null,
  category: 'cleaning', assignees: [], source: null, confidence: 0, lowConfidence: false, matchedRule: null,
});

// embedded = ฝังเป็นแท็บในหน้าอื่น (To-do) → ไม่ต้องมีหัวข้อ/ปุ่มกลับของตัวเอง
interface Props { operatorName: string | null; onBackToMain: () => void; embedded?: boolean; }

const AuditBoard: React.FC<Props> = ({ operatorName, onBackToMain, embedded }) => {
  const [tab, setTab] = useState<'form' | 'track' | 'rules'>('form');
  const [date, setDate] = useState(todayBKK());
  const [rows, setRows] = useState<Row[]>([blankRow(), blankRow(), blankRow()]);
  const [people, setPeople] = useState<Person[]>([]);
  const [routing, setRouting] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiUrl}/api/audit/people`)
      .then(r => r.json()).then(d => setPeople(d.people || []))
      .catch(() => setPeople([]));
  }, []);

  const peopleMap = useMemo(() => {
    const m: Record<string, Person> = {};
    for (const p of people) m[p.key] = p;
    return m;
  }, [people]);
  const nameOf = (k: string) => peopleMap[k]?.name || k;
  const dotOf = (k: string) => peopleMap[k]?.dot || '👤';
  const colorOf = (k: string) => peopleMap[k]?.color || '#607d8b';

  const patchRow = (id: number, patch: Partial<Row>) =>
    setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  const addRow = () => setRows(rs => [...rs, blankRow()]);
  const removeRow = (id: number) => setRows(rs => rs.filter(r => r.id !== id));

  const onPhoto = async (id: number, file?: File) => {
    if (!file) return;
    try { patchRow(id, { photo: await resizePhoto(file) }); } catch { /* ข้ามถ้าอ่านรูปไม่ได้ */ }
  };
  const onDonePhoto = async (id: number, file?: File) => {
    if (!file) return;
    try { patchRow(id, { donePhoto: await resizePhoto(file) }); } catch { /* ข้ามถ้าอ่านรูปไม่ได้ */ }
  };

  // ── แบ่งงานอัตโนมัติ: ส่งทุกแถวที่กรอกครบ → รับ suggestion กลับมาเติม ─────────
  // รับ target มาตรงๆ เพื่อให้เรียกต่อจาก "อ่านเอกสาร" ได้ทันที (ไม่ต้องรอ state รอบถัดไป)
  const routeInto = useCallback(async (target: Row[]) => {
    const filled = target.filter(r => r.issue.trim() && r.location.trim());
    if (!filled.length) { setSentMsg('กรอกประเด็น + สถานที่ก่อนอย่างน้อย 1 แถว'); return; }
    setRouting(true); setSentMsg(null);
    try {
      const r = await fetch(`${apiUrl}/api/audit/route`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: filled.map(f => ({ issue: f.issue, location: f.location })) }),
      });
      const d = await r.json();
      const byIdx = d.suggestions || [];
      let i = 0;
      setRows(rs => rs.map(row => {
        if (!(row.issue.trim() && row.location.trim())) return row;
        const s = byIdx[i++]; if (!s) return row;
        // ชื่อคนที่อ่านมาจากเอกสารชนะกฎ — คงผู้รับ + ป้าย 📄 ไว้ แต่ยังรับหมวด/ความด่วนจากกฎได้
        const fromSheet = row.source === 'sheet' && row.assignees.length > 0;
        return {
          ...row,
          assignees: fromSheet ? row.assignees : (s.assignees && s.assignees.length ? s.assignees : row.assignees),
          category: s.category || row.category,
          priority: s.priority === 'urgent' ? 'urgent' : row.priority,
          source: fromSheet ? 'sheet' : s.source,
          confidence: fromSheet ? 1 : (s.confidence || 0),
          lowConfidence: fromSheet ? false : !!s.lowConfidence,
          matchedRule: fromSheet ? 'ชื่อในเอกสาร' : (s.matchedRule || null),
        };
      }));
    } catch { setSentMsg('แบ่งงานไม่สำเร็จ — เช็คว่าเซิร์ฟเวอร์ทำงานอยู่'); }
    finally { setRouting(false); }
  }, []);
  const routeAll = useCallback(() => routeInto(rows), [routeInto, rows]);

  // ── อ่านเอกสารจากรูป (AI) → เติมแถวต่อท้าย แล้วแบ่งคนให้ต่อทันที ────────────
  const [reading, setReading] = useState(false);
  const [sheetMsg, setSheetMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const sheetFileRef = useRef<HTMLInputElement>(null);

  const readSheet = useCallback(async (files: File[]) => {
    const pics = files.filter(f => f.type.startsWith('image/')).slice(0, 6);
    if (!pics.length || reading) return;
    setReading(true); setSheetMsg(null); setSentMsg(null);
    try {
      const shots: PhotoAttach[] = [];
      for (const f of pics) { try { shots.push(await resizeSheet(f)); } catch { /* ข้ามไฟล์เสีย */ } }
      if (!shots.length) { setSheetMsg({ kind: 'err', text: 'อ่านไฟล์รูปไม่ได้ ลองใหม่อีกครั้ง' }); return; }
      const resp = await fetch(`${apiUrl}/api/audit/read-sheet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: shots.map(s => ({ data: s.data, media_type: s.mediaType })) }),
      });
      const d = await resp.json();
      if (!resp.ok) { setSheetMsg({ kind: 'err', text: d.error || 'อ่านเอกสารไม่สำเร็จ' }); return; }
      const got: { issue: string; location: string; priority: string; assigneeKey: string | null }[] = d.rows || [];
      if (!got.length) { setSheetMsg({ kind: 'err', text: 'อ่านไม่เจอแถวไหนเลย — ลองครอปเฉพาะตาราง หรือถ่ายให้ชัดขึ้น' }); return; }
      // เติมต่อท้ายของเดิม (แถวว่างที่ยังไม่ได้พิมพ์อะไรใช้เป็นที่ว่างก่อน) — ไม่ทับที่พิมพ์ไว้
      const keep = rows.filter(r => r.issue.trim() || r.location.trim() || r.photo || r.donePhoto);
      const added: Row[] = got.map(g => ({
        ...blankRow(),
        issue: g.issue, location: g.location,
        priority: g.priority === 'urgent' ? 'urgent' : 'normal',
        assignees: g.assigneeKey ? [g.assigneeKey] : [],
        source: g.assigneeKey ? 'sheet' : null,
      }));
      const next = [...keep, ...added];
      setRows(next);
      setSheetMsg({ kind: 'ok', text: `อ่านได้ ${got.length} ข้อ — เติมให้แล้ว` });
      await routeInto(next);
    } catch {
      setSheetMsg({ kind: 'err', text: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ — เช็คเน็ตแล้วลองใหม่' });
    } finally { setReading(false); }
  }, [reading, routeInto, rows]);

  const addAssignee = (id: number, key: string) => {
    if (!key) return;
    setRows(rs => rs.map(r => r.id === id
      ? { ...r, assignees: r.assignees.includes(key) ? r.assignees : [...r.assignees, key], source: r.source || 'review' }
      : r));
  };
  const removeAssignee = (id: number, key: string) =>
    setRows(rs => rs.map(r => r.id === id ? { ...r, assignees: r.assignees.filter(a => a !== key) } : r));

  // ── ส่งทั้งหมด → วน /api/duty/assign ต่อแถว (เข้าบอร์ดแต่ละคน + Telegram) ──────
  const sendAll = useCallback(async () => {
    const ready = rows.filter(r => r.issue.trim() && r.assignees.length);
    if (!ready.length) { setSentMsg('ยังไม่มีแถวที่พร้อมส่ง (ต้องมีประเด็น + ผู้รับผิดชอบ)'); return; }
    setSending(true); setSentMsg(null);
    // 1 ครั้งที่กดส่ง = 1 batch → ใช้จัดกลุ่ม "ใบตรวจ 1 ใบ" ในหน้าติดตามผล
    const batch = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T').slice(0, 16);
    let ok = 0;
    try {
      for (const r of ready) {
        // อัปโหลดขึ้น Supabase Storage ก่อน → เก็บแค่ URL ใน DB (ลด egress ของ Neon)
        // ไม่มี Supabase → helper คืน base64 เดิมให้ ใช้งานได้เหมือนเดิม
        const images = r.photo ? [await uploadDutyImage(r.photo.preview)] : [];
        const doneImages = r.donePhoto ? [await uploadDutyImage(r.donePhoto.preview)] : [];
        const resp = await fetch(`${apiUrl}/api/duty/assign`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workDate: date, title: r.issue.trim(), location: r.location.trim() || null,
            category: r.category, priority: r.priority, assignees: r.assignees,
            images,
            doneImages, // แนบรูปหลังทำ = ปิดงานทันที
            photoSpecs: ['หลังทำ'], // 1 จุด: images[0]=ก่อน คู่กับ done_images[0]=หลัง (บอทถามใบเดียว)
            auditBatch: batch, // ทำเครื่องหมายว่ามาจากใบตรวจ → โผล่ในหน้าติดตามผล
            operator: operatorName || 'จักรกฤษ',
          }),
        });
        if (resp.ok) ok++;
      }
      const skipped = rows.filter(r => r.issue.trim()).length - ok;
      setSentMsg(`✅ ส่งเข้าบอร์ด + แจ้ง Telegram แล้ว ${ok} งาน${skipped > 0 ? ` · ข้าม ${skipped} แถว (ยังไม่มีผู้รับ)` : ''}`);
    } catch { setSentMsg('ส่งไม่สำเร็จบางส่วน — ลองใหม่อีกครั้ง'); }
    finally { setSending(false); }
  }, [rows, date, operatorName]);

  const routedCount = rows.filter(r => r.source).length;
  const readyCount = rows.filter(r => r.issue.trim() && r.assignees.length).length;
  const needReview = rows.filter(r => r.source && (r.source === 'review' || (r.source === 'rule' && r.lowConfidence))).length;

  // ── styles ─────────────────────────────────────────────────────────────────
  const inp: React.CSSProperties = { border: '1px solid #dde3e7', borderRadius: 9, padding: '8px 10px', fontSize: '0.82rem', fontFamily: 'inherit', color: '#37474f', background: '#fff', width: '100%', boxSizing: 'border-box' };
  const card: React.CSSProperties = { background: '#fff', borderRadius: 14, border: '1px solid #eceff1', padding: 12, marginBottom: 12, boxShadow: '0 1px 2px rgba(38,50,56,.05), 0 6px 18px -8px rgba(38,50,56,.12)' };

  return (
    <div style={embedded
      ? { fontFamily: 'Inter, sans-serif' }  // หน้าแม่ (To-do) คุม layout/padding ให้แล้ว
      : { maxWidth: 640, margin: '0 auto', padding: '12px 12px 80px', fontFamily: 'Inter, sans-serif' }}>
      {/* hover/focus states (guardrail: animate transform เท่านั้น) */}
      <style>{`
        .ab-btn{transition:transform .12s ease, box-shadow .12s ease;}
        .ab-btn:hover:not(:disabled){transform:translateY(-1px);}
        .ab-btn:active:not(:disabled){transform:translateY(0);}
        .ab-btn:focus-visible{outline:2px solid #ff6b00;outline-offset:2px;}
        .ab-chip{transition:transform .1s ease;}
        .ab-chip:hover{transform:translateY(-1px);}
        .ab-bar{animation:abSlide 1.1s ease-in-out infinite;}
        @keyframes abSlide{from{transform:translateX(-110%)}to{transform:translateX(240%)}}
      `}</style>

      {/* header — ซ่อนตอนฝังเป็นแท็บ (หน้าแม่มีหัวข้อ/ปุ่มกลับอยู่แล้ว) */}
      {!embedded && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <button className="ab-btn" onClick={onBackToMain} style={{ border: '1px solid #eee', background: '#fff', borderRadius: 10, padding: '6px 10px', cursor: 'pointer' }}>← กลับ</button>
          <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#37474f', flex: 1 }}>📋 พื้นที่รับผิดชอบ</h2>
        </div>
      )}

      {/* แท็บ: กรอก / ติดตามผล / กฎ */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, background: '#eceff1', borderRadius: 12, padding: 4 }}>
        {([['form', '📝 กรอกประเด็น'], ['track', '📊 ติดตามผล'], ['rules', '⚙️ กฎแบ่งงาน']] as const).map(([k, label]) => (
          <button key={k} className="ab-btn" onClick={() => setTab(k)}
            style={{ flex: 1, border: 'none', background: tab === k ? '#fff' : 'transparent', color: tab === k ? '#e65100' : '#607d8b', borderRadius: 9, padding: '9px 4px', fontSize: '0.78rem', fontWeight: 800, cursor: 'pointer', boxShadow: tab === k ? '0 2px 6px -2px rgba(38,50,56,.25)' : 'none' }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'track' && <TrackPanel people={people} operatorName={operatorName} card={card} />}
      {tab === 'rules' && <RulesPanel people={people} card={card} inp={inp} />}

      {tab === 'form' && (<>
      {/* ── อ่านจากรูปเอกสาร: วาง/เลือกรูป → AI เติมแถวให้ → ตรวจแล้วค่อยส่ง ──── */}
      <div style={card}
        onPaste={e => {
          const fs = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean) as File[];
          if (fs.length) { e.preventDefault(); readSheet(fs); }
        }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 800, color: '#00838f', marginBottom: 8 }}>📷 อ่านจากรูปเอกสาร</div>
        <input ref={sheetFileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
          onChange={e => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) readSheet(fs); }} />

        {reading ? (
          /* กำลังอ่าน */
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div style={{ width: 46, height: 58, borderRadius: 6, flexShrink: 0, background: '#eef3f5', border: '1px solid #dde3e7', padding: 7, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              {[0, 1, 2, 3, 4, 5].map(i => <div key={i} style={{ height: 2, borderRadius: 2, background: '#b0bec5', width: i === 5 ? '55%' : '100%' }} />)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#37474f' }}>⏳ กำลังอ่านเอกสาร…</div>
              <div style={{ height: 5, borderRadius: 99, background: '#eef3f5', overflow: 'hidden', marginTop: 7 }}>
                <div className="ab-bar" style={{ height: '100%', width: '45%', background: '#00838f', borderRadius: 99 }} />
              </div>
              <div style={{ fontSize: '0.68rem', color: '#90a4ae', marginTop: 6 }}>เอกสารยาวอาจใช้เวลาถึงครึ่งนาที</div>
            </div>
          </div>
        ) : sheetMsg?.kind === 'ok' ? (
          /* อ่านเสร็จ */
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#eaf5eb', border: '1px solid #c3e2c6', borderRadius: 11, padding: '11px 12px' }}>
              <span style={{ fontSize: '0.95rem', lineHeight: 1.3 }}>✅</span>
              <div>
                <div style={{ fontSize: '0.82rem', fontWeight: 800, color: '#2e7d32' }}>{sheetMsg.text}</div>
                <div style={{ fontSize: '0.72rem', color: '#546e7a' }}>ตรวจสอบก่อนกดส่ง แล้วแนบรูปก่อนทำของแต่ละข้อ</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 9 }}>
              <button className="ab-btn" onClick={() => { setSheetMsg(null); sheetFileRef.current?.click(); }}
                style={{ border: '1px solid #dde3e7', background: '#fff', color: '#546e7a', borderRadius: 9, padding: '7px 13px', fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer' }}>📎 อ่านรูปเพิ่ม</button>
              <button className="ab-btn" onClick={addRow}
                style={{ border: '1px solid #dde3e7', background: '#fff', color: '#546e7a', borderRadius: 9, padding: '7px 13px', fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer' }}>+ เพิ่มแถวเอง</button>
            </div>
            <div style={{ fontSize: '0.68rem', color: '#90a4ae', marginTop: 8 }}>แบ่งคนรับผิดชอบให้อัตโนมัติแล้วด้วย (กฎ + AI) · ชื่อที่เขียนมาในเอกสารขึ้นก่อนกฎเสมอ</div>
          </>
        ) : (
          /* ก่อนวางรูป */
          <>
            <div style={{ border: '1.5px dashed #b2ebf2', background: '#e0f7fa', borderRadius: 12, padding: '20px 14px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 9, alignItems: 'center' }}>
              <span style={{ fontSize: '0.84rem', fontWeight: 800, color: '#00838f' }}>วางรูปเอกสารจาก Line ที่นี่</span>
              <span style={{ fontSize: '0.72rem', color: '#546e7a' }}>คัดลอกรูปมาแล้วกด Ctrl+V ได้เลย</span>
              <button className="ab-btn" onClick={() => sheetFileRef.current?.click()}
                style={{ border: '1px solid #b2ebf2', background: '#fff', color: '#00838f', borderRadius: 9, padding: '7px 14px', fontSize: '0.78rem', fontWeight: 800, cursor: 'pointer' }}>📎 เลือกรูป</button>
            </div>
            <div style={{ fontSize: '0.68rem', color: '#90a4ae', marginTop: 8 }}>ใบยาว/ตัวหนังสือเล็ก → ครอปส่งหลายรูปได้ (สูงสุด 6 รูป)</div>
          </>
        )}

        {sheetMsg?.kind === 'err' && (
          <div style={{ marginTop: 9, background: '#fff3e9', border: '1px solid #ffcfa3', borderRadius: 10, padding: '9px 11px', fontSize: '0.76rem', color: '#b26a00' }}>
            ⚠️ {sheetMsg.text} — พิมพ์แถวเองได้ตามปกติ
          </div>
        )}
      </div>

      {/* วันที่ + สรุป */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: '0.8rem', color: '#546e7a', fontWeight: 700 }}>วันที่ตรวจ</label>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...inp, width: 'auto' }} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, fontSize: '0.72rem', color: '#78909c' }}>
          <span>ทั้งหมด {rows.filter(r => r.issue.trim()).length}</span>
          <span>· แบ่งแล้ว {routedCount}</span>
          {needReview > 0 && <span style={{ color: '#b26a00', fontWeight: 700 }}>· ตรวจซ้ำ {needReview}</span>}
        </div>
      </div>

      {/* รายการประเด็น */}
      {rows.map((r, idx) => {
        const cm = catMeta(r.category);
        const sm = r.source ? SRC_META[r.source] : null;
        return (
          <div key={r.id} style={card}>
            {/* หัวแถว: ลำดับ + ที่มา + ลบ */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ width: 24, height: 24, borderRadius: 7, background: '#f5f7f8', color: '#607d8b', fontSize: '0.78rem', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{idx + 1}</span>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: cm.c, background: cm.bg, padding: '2px 8px', borderRadius: 20 }}>{cm.ic} {cm.label}</span>
              {sm && <span style={{ fontSize: '0.68rem', fontWeight: 700, color: sm.c, background: sm.bg, padding: '2px 8px', borderRadius: 20 }}>{sm.label}</span>}
              {r.source === 'rule' && r.lowConfidence && <span style={{ fontSize: '0.66rem', color: '#b26a00' }} title={r.matchedRule || ''}>โซนกว้าง</span>}
              <button className="ab-btn" onClick={() => removeRow(r.id)} title="ลบแถว" style={{ marginLeft: 'auto', border: 'none', background: 'none', color: '#b0bec5', cursor: 'pointer', fontSize: '1.1rem' }}>×</button>
            </div>

            {/* ประเด็น */}
            <input value={r.issue} onChange={e => patchRow(r.id, { issue: e.target.value })}
              placeholder="ประเด็นที่พบ เช่น พบถุงดำ / คราบน้ำตาล / ประตูชำรุด" style={{ ...inp, marginBottom: 8 }} />

            {/* สถานที่ + ความด่วน */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <input value={r.location} onChange={e => patchRow(r.id, { location: e.target.value })}
                list="ab-zones" placeholder="📍 สถานที่ / โซน" style={{ ...inp, flex: 1, minWidth: 160 }} />
              <button className="ab-btn" onClick={() => patchRow(r.id, { priority: r.priority === 'urgent' ? 'normal' : 'urgent' })}
                style={{ border: `1px solid ${r.priority === 'urgent' ? '#e53935' : '#dde3e7'}`, background: r.priority === 'urgent' ? '#ffebee' : '#fff', color: r.priority === 'urgent' ? '#c62828' : '#78909c', borderRadius: 9, padding: '8px 12px', fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {r.priority === 'urgent' ? '🔴 ด่วน' : 'ปกติ'}
              </button>
            </div>

            {/* ผู้รับผิดชอบ (ชิป + เพิ่มคน) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', background: '#fafbfc', border: '1px solid #eef1f3', borderRadius: 10, padding: '8px 10px', marginBottom: 9 }}>
              <span style={{ fontSize: '0.74rem', color: '#90a4ae', fontWeight: 700 }}>ผู้รับ:</span>
              {r.assignees.length === 0 && <span style={{ fontSize: '0.76rem', color: '#b0bec5' }}>— ยังไม่ได้เลือก —</span>}
              {r.assignees.map(k => (
                <span key={k} className="ab-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fff', border: `1px solid ${colorOf(k)}55`, borderRadius: 20, padding: '3px 6px 3px 9px', fontSize: '0.78rem', fontWeight: 700, color: colorOf(k) }}>
                  <span>{dotOf(k)}</span>{nameOf(k)}
                  <button className="ab-btn" onClick={() => removeAssignee(r.id, k)} style={{ border: 'none', background: 'none', color: '#b0bec5', cursor: 'pointer', fontSize: '0.95rem', lineHeight: 1, padding: '0 2px' }}>×</button>
                </span>
              ))}
              <select value="" onChange={e => { addAssignee(r.id, e.target.value); e.target.value = ''; }}
                style={{ border: '1px dashed #cfd8dc', background: '#fff', borderRadius: 20, padding: '4px 8px', fontSize: '0.74rem', color: '#607d8b', cursor: 'pointer' }}>
                <option value="">+ เพิ่มคน</option>
                {people.filter(p => !r.assignees.includes(p.key)).map(p => (
                  <option key={p.key} value={p.key}>{p.dot} {p.name}{p.kind === 'audit' ? '' : ' (ทีมกะ)'}</option>
                ))}
              </select>
            </div>

            {/* รูปเทียบ ก่อน–หลัง: ซ้าย = คุณแนบตอนนี้ · ขวา = คนทำถ่ายส่งกลับผ่านบอท */}
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.63rem', fontWeight: 800, color: '#607d8b', marginBottom: 4 }}>📎 ก่อน · คุณแนบ</div>
                {r.photo ? (
                  <div style={{ position: 'relative' }}>
                    <img src={r.photo.preview} alt="ก่อนทำ" style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 9, display: 'block' }} />
                    <button className="ab-btn" onClick={() => patchRow(r.id, { photo: null })} title="ลบรูป"
                      style={{ position: 'absolute', top: -5, right: -5, width: 18, height: 18, borderRadius: '50%', border: 'none', background: '#546e7a', color: '#fff', fontSize: '0.7rem', lineHeight: 1, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>×</button>
                  </div>
                ) : (
                  <label className="ab-btn" style={{ display: 'grid', placeItems: 'center', width: '100%', height: 60, border: '1.5px dashed #c4cdd3', background: '#fff', color: '#8a949c', borderRadius: 9, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', boxSizing: 'border-box' }}>
                    + แนบรูป
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => onPhoto(r.id, e.target.files?.[0])} />
                  </label>
                )}
              </div>
              <span style={{ alignSelf: 'center', color: '#b0bec5', fontWeight: 800, flexShrink: 0, paddingTop: 15 }}>→</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.63rem', fontWeight: 800, color: '#2e7d32', marginBottom: 4 }}>📸 หลัง · คนทำถ่าย</div>
                {r.donePhoto ? (
                  <div style={{ position: 'relative' }}>
                    <img src={r.donePhoto.preview} alt="หลังทำ" style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 9, display: 'block' }} />
                    <button className="ab-btn" onClick={() => patchRow(r.id, { donePhoto: null })} title="ลบรูป"
                      style={{ position: 'absolute', top: -5, right: -5, width: 18, height: 18, borderRadius: '50%', border: 'none', background: '#546e7a', color: '#fff', fontSize: '0.7rem', lineHeight: 1, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>×</button>
                  </div>
                ) : (
                  <label className="ab-btn" title="ถ้าแก้เสร็จหน้างานแล้ว แตะเพื่อแนบรูปหลังทำเอง → ระบบปิดงานให้เลย"
                    style={{ display: 'grid', placeItems: 'center', width: '100%', height: 60, border: '1.5px dashed #bfd8c4', background: '#fff', color: '#6aa77c', borderRadius: 9, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', boxSizing: 'border-box' }}>
                    คนทำถ่าย
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => onDonePhoto(r.id, e.target.files?.[0])} />
                  </label>
                )}
              </div>
            </div>
            {r.donePhoto && <div style={{ fontSize: '0.66rem', color: '#2e7d32', marginTop: 5 }}>✅ แนบรูปหลังทำแล้ว — ส่งแล้วระบบจะปิดงานให้ทันที</div>}
          </div>
        );
      })}

      <datalist id="ab-zones">{ZONE_HINTS.map(z => <option key={z} value={z} />)}</datalist>

      {/* เพิ่มแถว */}
      <button className="ab-btn" onClick={addRow} style={{ width: '100%', border: '1px dashed #cfd8dc', background: '#fff', borderRadius: 12, padding: 11, fontSize: '0.85rem', fontWeight: 700, color: '#607d8b', cursor: 'pointer', marginBottom: 14 }}>+ เพิ่มประเด็น</button>

      {/* ปุ่มการทำงาน */}
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="ab-btn" onClick={routeAll} disabled={routing} style={{ flex: 1, border: '1px solid #ffcfa3', background: '#fff3e9', color: '#e65100', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '0.86rem', cursor: 'pointer', opacity: routing ? 0.6 : 1 }}>
          {routing ? 'กำลังแบ่ง…' : '🔎 แบ่งงานอัตโนมัติ'}
        </button>
        <button className="ab-btn" onClick={sendAll} disabled={sending || readyCount === 0} style={{ flex: 1, border: 'none', background: readyCount === 0 ? '#cfd8dc' : '#ff6b00', color: '#fff', borderRadius: 12, padding: 13, fontWeight: 800, fontSize: '0.86rem', cursor: readyCount === 0 ? 'default' : 'pointer', opacity: sending ? 0.6 : 1, boxShadow: readyCount === 0 ? 'none' : '0 6px 16px -6px rgba(255,107,0,.6)' }}>
          {sending ? 'กำลังส่ง…' : `ส่งทั้งหมด (${readyCount}) →`}
        </button>
      </div>

      {sentMsg && <div style={{ marginTop: 12, background: '#f1f8f2', border: '1px solid #cde9d2', borderRadius: 10, padding: '10px 12px', fontSize: '0.8rem', color: '#2e7d32' }}>{sentMsg}</div>}
      </>)}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// ติดตามผล — ประเด็นที่ส่งไปแล้ว: ค้าง (สะสมข้ามวัน) / ปิดแล้ว + ปิดงานจากหน้านี้
// ═══════════════════════════════════════════════════════════════════════════
type TrackItem = {
  id: number; date: string; title: string; location: string | null; category: string;
  priority: string; status: string; assignee: string; assigneeName: string;
  completedAt: string | null; doneBy: string | null;
  hasImages: boolean; hasDoneImages: boolean; ageDays: number;
};
type TrackData = { pending: TrackItem[]; done: TrackItem[]; summary: { open: number; closed: number; overdue3: number } };

const TrackPanel: React.FC<{ people: Person[]; operatorName: string | null; card: React.CSSProperties }> =
  ({ people, operatorName, card }) => {
    const [data, setData] = useState<TrackData | null>(null);
    const [loading, setLoading] = useState(true);
    const [imgs, setImgs] = useState<Record<number, { images: string[]; doneImages: string[] } | 'loading'>>({});
    const [busy, setBusy] = useState<number | null>(null);
    const [showDone, setShowDone] = useState(false);

    const load = useCallback(async () => {
      setLoading(true);
      try { setData(await (await fetch(`${apiUrl}/api/audit/tracking?days=7`)).json()); }
      catch { setData(null); }
      finally { setLoading(false); }
    }, []);
    useEffect(() => { load(); }, [load]);

    // รูปโหลดตอนกดดูเท่านั้น (เหมือน DutyBoard) — ลด egress ของ Neon
    const loadImgs = async (id: number) => {
      setImgs(p => ({ ...p, [id]: 'loading' }));
      try {
        const d = await (await fetch(`${apiUrl}/api/tasks/images?id=${id}`)).json();
        setImgs(p => ({ ...p, [id]: { images: d.images || [], doneImages: d.doneImages || [] } }));
      } catch { setImgs(p => { const n = { ...p }; delete n[id]; return n; }); }
    };

    const closeTask = async (t: TrackItem, file?: File) => {
      setBusy(t.id);
      try {
        const body: Record<string, unknown> = { id: t.id, status: 'done', doneBy: operatorName || 'จักรกฤษ' };
        if (file) { try { body.doneImages = [(await resizePhoto(file)).preview]; } catch { /* อ่านรูปไม่ได้ → ปิดงานเฉยๆ */ } }
        await fetch(`${apiUrl}/api/tasks/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        setImgs(p => { const n = { ...p }; delete n[t.id]; return n; });
        await load();
      } catch { /* ปล่อยให้ผู้ใช้กดใหม่ */ }
      finally { setBusy(null); }
    };
    const reopen = async (t: TrackItem) => {
      setBusy(t.id);
      try { await fetch(`${apiUrl}/api/tasks/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id, status: 'pending' }) }); await load(); }
      catch { /* ignore */ } finally { setBusy(null); }
    };

    const pm: Record<string, Person> = {};
    for (const p of people) pm[p.key] = p;
    const colorOf = (k: string) => pm[k]?.color || '#607d8b';
    const dotOf = (k: string) => pm[k]?.dot || '👤';

    if (loading) return <div style={{ ...card, textAlign: 'center', color: '#90a4ae', fontSize: '0.85rem' }}>กำลังโหลด…</div>;
    if (!data) return <div style={{ ...card, textAlign: 'center', color: '#c62828', fontSize: '0.85rem' }}>โหลดไม่สำเร็จ — เช็คว่าเซิร์ฟเวอร์ทำงานอยู่</div>;

    // จัดกลุ่มงานค้างตามผู้รับผิดชอบ (ค้างนานสุดขึ้นก่อน)
    const groups: { key: string; name: string; items: TrackItem[] }[] = [];
    for (const t of [...data.pending].sort((a, b) => b.ageDays - a.ageDays)) {
      let g = groups.find(x => x.key === t.assignee);
      if (!g) { g = { key: t.assignee, name: t.assigneeName, items: [] }; groups.push(g); }
      g.items.push(t);
    }

    const photoBlock = (id: number) => {
      const im = imgs[id];
      if (im === 'loading') return <div style={{ fontSize: '0.72rem', color: '#90a4ae', marginTop: 6 }}>กำลังโหลดรูป…</div>;
      if (!im || typeof im !== 'object') return null;
      return (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {im.images.map((src, i) => (
            <div key={`b${i}`}><div style={{ fontSize: '0.62rem', color: '#78909c', marginBottom: 2 }}>ก่อนทำ</div>
              <img src={src} alt="ก่อนทำ" style={{ maxHeight: 88, borderRadius: 8, border: '1px solid #eceff1' }} /></div>
          ))}
          {im.doneImages.map((src, i) => (
            <div key={`a${i}`}><div style={{ fontSize: '0.62rem', color: '#2e7d32', marginBottom: 2 }}>หลังทำ ✅</div>
              <img src={src} alt="หลังทำ" style={{ maxHeight: 88, borderRadius: 8, border: '1px solid #cde9d2' }} /></div>
          ))}
          {im.images.length === 0 && im.doneImages.length === 0 && <div style={{ fontSize: '0.72rem', color: '#b0bec5' }}>— ไม่มีรูป —</div>}
        </div>
      );
    };

    return (
      <>
        {/* สรุป */}
        <div style={{ ...card, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { n: data.summary.open, label: 'ค้าง', c: '#e65100', bg: '#fff3e9' },
            { n: data.summary.closed, label: 'ปิดแล้ว (7 วัน)', c: '#2e7d32', bg: '#e8f5e9' },
            { n: data.summary.overdue3, label: 'ค้างเกิน 3 วัน', c: '#c62828', bg: '#ffebee' },
          ].map(s => (
            <div key={s.label} style={{ flex: '1 1 92px', background: s.bg, borderRadius: 10, padding: '9px 10px' }}>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: s.c, lineHeight: 1.1 }}>{s.n}</div>
              <div style={{ fontSize: '0.68rem', color: s.c, opacity: .85 }}>{s.label}</div>
            </div>
          ))}
          <button className="ab-btn" onClick={load} title="รีเฟรช"
            style={{ border: '1px solid #dde3e7', background: '#fff', borderRadius: 10, padding: '9px 12px', cursor: 'pointer', fontSize: '0.9rem' }}>🔄</button>
        </div>

        {/* งานค้าง */}
        {groups.length === 0 && (
          <div style={{ ...card, textAlign: 'center', color: '#2e7d32', fontSize: '0.86rem', fontWeight: 700 }}>🎉 ไม่มีประเด็นค้าง</div>
        )}
        {groups.map(g => (
          <div key={g.key} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9 }}>
              <span>{dotOf(g.key)}</span>
              <span style={{ fontWeight: 800, fontSize: '0.88rem', color: colorOf(g.key) }}>{g.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: '0.72rem', fontWeight: 700, color: '#e65100', background: '#fff3e9', borderRadius: 20, padding: '2px 9px' }}>ค้าง {g.items.length}</span>
            </div>
            {g.items.map(t => {
              const cm = catMeta(t.category);
              const late = t.ageDays >= 3;
              return (
                <div key={t.id} style={{ borderTop: '1px solid #f0f3f4', paddingTop: 9, marginTop: 9 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 5 }}>
                    <span style={{ fontSize: '0.72rem' }}>{cm.ic}</span>
                    <div style={{ flex: 1, fontSize: '0.84rem', fontWeight: 700, color: '#37474f', lineHeight: 1.35 }}>
                      {t.priority === 'urgent' && <span style={{ color: '#c62828' }}>🔴 </span>}{t.title}
                    </div>
                    <span title={`ลงวันที่ ${t.date}`} style={{ fontSize: '0.66rem', fontWeight: 800, whiteSpace: 'nowrap', color: late ? '#c62828' : '#90a4ae', background: late ? '#ffebee' : '#f5f7f8', borderRadius: 20, padding: '2px 8px' }}>
                      {t.ageDays === 0 ? 'วันนี้' : `ค้าง ${t.ageDays} วัน`}
                    </span>
                  </div>
                  {t.location && <div style={{ fontSize: '0.74rem', color: '#78909c', marginBottom: 6 }}>📍 {t.location}</div>}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(t.hasImages || t.hasDoneImages) && !imgs[t.id] && (
                      <button className="ab-btn" onClick={() => loadImgs(t.id)}
                        style={{ border: '1px solid #dde3e7', background: '#fff', color: '#607d8b', borderRadius: 8, padding: '5px 10px', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer' }}>📷 ดูรูป</button>
                    )}
                    <label className="ab-btn" style={{ border: '1px solid #b6dcc0', background: '#f1f8f2', color: '#2e7d32', borderRadius: 8, padding: '5px 10px', fontSize: '0.72rem', fontWeight: 800, cursor: busy === t.id ? 'wait' : 'pointer', opacity: busy === t.id ? .5 : 1 }}>
                      📷 ปิดงาน + แนบรูปหลังทำ
                      <input type="file" accept="image/*" style={{ display: 'none' }} disabled={busy === t.id}
                        onChange={e => { const f = e.target.files?.[0]; if (f) closeTask(t, f); e.currentTarget.value = ''; }} />
                    </label>
                    <button className="ab-btn" onClick={() => closeTask(t)} disabled={busy === t.id}
                      style={{ border: '1px solid #dde3e7', background: '#fff', color: '#607d8b', borderRadius: 8, padding: '5px 10px', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', opacity: busy === t.id ? .5 : 1 }}>
                      ✅ ปิดเลย
                    </button>
                  </div>
                  {photoBlock(t.id)}
                </div>
              );
            })}
          </div>
        ))}

        {/* ปิดแล้ว (ย่อ/ขยาย) */}
        {data.done.length > 0 && (
          <div style={card}>
            <button className="ab-btn" onClick={() => setShowDone(s => !s)}
              style={{ width: '100%', border: 'none', background: 'none', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
              <span style={{ fontWeight: 800, fontSize: '0.86rem', color: '#2e7d32' }}>✅ ปิดแล้ว {data.done.length} ประเด็น</span>
              <span style={{ marginLeft: 'auto', color: '#90a4ae', fontSize: '0.78rem' }}>{showDone ? 'ซ่อน ▲' : 'ดู ▼'}</span>
            </button>
            {showDone && data.done.map(t => (
              <div key={t.id} style={{ borderTop: '1px solid #f0f3f4', paddingTop: 8, marginTop: 8 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                  <span style={{ fontSize: '0.72rem' }}>{catMeta(t.category).ic}</span>
                  <div style={{ flex: 1, fontSize: '0.8rem', color: '#607d8b', textDecoration: 'line-through', lineHeight: 1.35 }}>{t.title}</div>
                  <span style={{ fontSize: '0.66rem', color: '#90a4ae', whiteSpace: 'nowrap' }}>{t.assigneeName}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                  {t.doneBy && <span style={{ fontSize: '0.68rem', color: '#2e7d32' }}>ปิดโดย {t.doneBy}</span>}
                  {(t.hasImages || t.hasDoneImages) && !imgs[t.id] && (
                    <button className="ab-btn" onClick={() => loadImgs(t.id)}
                      style={{ border: '1px solid #dde3e7', background: '#fff', color: '#607d8b', borderRadius: 8, padding: '4px 9px', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer' }}>
                      📷 ดูรูป{t.hasDoneImages ? ' (มีหลังทำ)' : ''}
                    </button>
                  )}
                  <button className="ab-btn" onClick={() => reopen(t)} disabled={busy === t.id}
                    style={{ border: 'none', background: 'none', color: '#b0bec5', fontSize: '0.7rem', cursor: 'pointer', textDecoration: 'underline' }}>เปิดใหม่</button>
                </div>
                {photoBlock(t.id)}
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

// ═══════════════════════════════════════════════════════════════════════════
// กฎแบ่งงาน — เพิ่ม/แก้/ลบเองได้ (specificity มาก = จำเพาะ = แมตช์ก่อน)
// ═══════════════════════════════════════════════════════════════════════════
type Rule = {
  id: number; rule_type: string; pattern: string; owner_key: string;
  co_owner_key: string | null; category: string; priority: string; specificity: number; active?: number;
};

const RulesPanel: React.FC<{ people: Person[]; card: React.CSSProperties; inp: React.CSSProperties }> =
  ({ people, card, inp }) => {
    const [rules, setRules] = useState<Rule[]>([]);
    const [loading, setLoading] = useState(true);
    const [msg, setMsg] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState<{ rule_type: string; pattern: string; owner_key: string; category: string; specificity: number }>(
      { rule_type: 'zone', pattern: '', owner_key: '', category: 'cleaning', specificity: 50 });

    const load = useCallback(async () => {
      setLoading(true);
      try { const d = await (await fetch(`${apiUrl}/api/audit/rules`)).json(); setRules(d.rules || []); }
      catch { setRules([]); }
      finally { setLoading(false); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const save = async (body: Record<string, unknown>, note: string) => {
      try {
        const r = await (await fetch(`${apiUrl}/api/audit/rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
        if (r.error) { setMsg(`❌ ${r.error}`); return false; }
        setMsg(note); await load(); return true;
      } catch { setMsg('❌ บันทึกไม่สำเร็จ'); return false; }
    };
    const del = async (id: number, pattern: string) => {
      if (!window.confirm(`ลบกฎ "${pattern}" ?`)) return;
      try {
        await fetch(`${apiUrl}/api/audit/rules/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        setMsg('🗑 ลบกฎแล้ว'); await load();
      } catch { setMsg('❌ ลบไม่สำเร็จ'); }
    };
    const addRule = async () => {
      if (!draft.pattern.trim() || !draft.owner_key) { setMsg('❌ ต้องกรอกคำ/โซน และเลือกผู้รับผิดชอบ'); return; }
      if (await save({ ...draft, pattern: draft.pattern.trim() }, '✅ เพิ่มกฎแล้ว')) {
        setDraft({ rule_type: 'zone', pattern: '', owner_key: '', category: 'cleaning', specificity: 50 });
        setAdding(false);
      }
    };

    const sel: React.CSSProperties = { border: '1px solid #dde3e7', borderRadius: 8, padding: '5px 7px', fontSize: '0.74rem', fontFamily: 'inherit', color: '#37474f', background: '#fff' };
    if (loading) return <div style={{ ...card, textAlign: 'center', color: '#90a4ae', fontSize: '0.85rem' }}>กำลังโหลด…</div>;

    return (
      <>
        <div style={{ ...card, fontSize: '0.76rem', color: '#546e7a', lineHeight: 1.6 }}>
          กฎใช้เดาผู้รับผิดชอบตอนกด "แบ่งงานอัตโนมัติ" — <b>คำในประเด็น (keyword) ชนะโซน (zone)</b> เสมอ
          และตัวเลข <b>ความจำเพาะ</b> มาก = ตรวจก่อน (เช่น "ห้องเก็บ Ingredient" 90 ต้องมาก่อน "ชั้น 3" 30)
        </div>

        {msg && <div style={{ ...card, padding: '9px 12px', fontSize: '0.78rem', color: msg.startsWith('❌') ? '#c62828' : '#2e7d32', background: msg.startsWith('❌') ? '#ffebee' : '#f1f8f2' }}>{msg}</div>}

        {(['keyword', 'zone'] as const).map(type => {
          const list = rules.filter(r => r.rule_type === type).sort((a, b) => b.specificity - a.specificity);
          return (
            <div key={type} style={card}>
              <div style={{ fontWeight: 800, fontSize: '0.82rem', color: '#37474f', marginBottom: 3 }}>
                {type === 'keyword' ? '🔑 คำในประเด็น' : '📍 โซน/สถานที่'}
                <span style={{ fontWeight: 500, color: '#90a4ae', fontSize: '0.72rem' }}> · {list.length} กฎ</span>
              </div>
              <div style={{ fontSize: '0.7rem', color: '#90a4ae', marginBottom: 9 }}>
                {type === 'keyword' ? 'เจอคำนี้ในช่อง "ประเด็น" → บังคับผู้รับ + หมวด (ข้ามโซน)' : 'ช่อง "สถานที่" มีคำนี้ → เจ้าของโซนรับงาน'}
              </div>
              {list.length === 0 && <div style={{ fontSize: '0.76rem', color: '#b0bec5' }}>— ยังไม่มีกฎ —</div>}
              {list.map(r => (
                <div key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid #f0f3f4', paddingTop: 8, marginTop: 8 }}>
                  <input defaultValue={r.pattern} title="คำที่ใช้จับคู่"
                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== r.pattern) save({ id: r.id, pattern: v }, '✅ แก้คำแล้ว'); }}
                    style={{ ...inp, flex: '1 1 130px', width: 'auto', padding: '5px 8px', fontSize: '0.78rem', fontWeight: 700 }} />
                  <span style={{ color: '#b0bec5', fontSize: '0.8rem' }}>→</span>
                  <select value={r.owner_key} onChange={e => save({ id: r.id, owner_key: e.target.value }, '✅ เปลี่ยนผู้รับแล้ว')} style={sel}>
                    {people.map(p => <option key={p.key} value={p.key}>{p.dot} {p.name}</option>)}
                    {!people.some(p => p.key === r.owner_key) && <option value={r.owner_key}>{r.owner_key}</option>}
                  </select>
                  <select value={r.category} onChange={e => save({ id: r.id, category: e.target.value }, '✅ เปลี่ยนหมวดแล้ว')} style={sel}>
                    <option value="cleaning">🧽 สะอาด</option>
                    <option value="maintenance">🔧 ซ่อม</option>
                  </select>
                  <input type="number" defaultValue={r.specificity} title="ความจำเพาะ — มาก = ตรวจก่อน" min={0} max={100}
                    onBlur={e => { const v = Number(e.target.value); if (!Number.isNaN(v) && v !== r.specificity) save({ id: r.id, specificity: v }, '✅ แก้ลำดับแล้ว'); }}
                    style={{ ...sel, width: 54, textAlign: 'center' }} />
                  <button className="ab-btn" onClick={() => del(r.id, r.pattern)} title="ลบกฎ"
                    style={{ border: 'none', background: 'none', color: '#cfd8dc', cursor: 'pointer', fontSize: '1.05rem', padding: '0 2px' }}>🗑</button>
                </div>
              ))}
            </div>
          );
        })}

        {/* เพิ่มกฎใหม่ */}
        {!adding && (
          <button className="ab-btn" onClick={() => setAdding(true)}
            style={{ width: '100%', border: '1px dashed #cfd8dc', background: '#fff', borderRadius: 12, padding: 11, fontSize: '0.85rem', fontWeight: 700, color: '#607d8b', cursor: 'pointer' }}>+ เพิ่มกฎใหม่</button>
        )}
        {adding && (
          <div style={card}>
            <div style={{ fontWeight: 800, fontSize: '0.82rem', color: '#37474f', marginBottom: 9 }}>เพิ่มกฎใหม่</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 9 }}>
              <select value={draft.rule_type} onChange={e => setDraft(d => ({ ...d, rule_type: e.target.value, specificity: e.target.value === 'keyword' ? 95 : 50 }))} style={sel}>
                <option value="zone">📍 โซน/สถานที่</option>
                <option value="keyword">🔑 คำในประเด็น</option>
              </select>
              <input value={draft.pattern} onChange={e => setDraft(d => ({ ...d, pattern: e.target.value }))}
                placeholder={draft.rule_type === 'keyword' ? 'เช่น ประตูชำรุด' : 'เช่น ห้องเก็บ Ingredient'}
                style={{ ...inp, flex: '1 1 150px', width: 'auto', padding: '6px 9px', fontSize: '0.8rem' }} />
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={draft.owner_key} onChange={e => setDraft(d => ({ ...d, owner_key: e.target.value }))} style={sel}>
                <option value="">— เลือกผู้รับผิดชอบ —</option>
                {people.map(p => <option key={p.key} value={p.key}>{p.dot} {p.name}</option>)}
              </select>
              <select value={draft.category} onChange={e => setDraft(d => ({ ...d, category: e.target.value }))} style={sel}>
                <option value="cleaning">🧽 สะอาด</option>
                <option value="maintenance">🔧 ซ่อม</option>
              </select>
              <input type="number" value={draft.specificity} onChange={e => setDraft(d => ({ ...d, specificity: Number(e.target.value) }))}
                title="ความจำเพาะ" min={0} max={100} style={{ ...sel, width: 54, textAlign: 'center' }} />
              <button className="ab-btn" onClick={addRule}
                style={{ marginLeft: 'auto', border: 'none', background: '#ff6b00', color: '#fff', borderRadius: 9, padding: '7px 14px', fontSize: '0.78rem', fontWeight: 800, cursor: 'pointer' }}>บันทึก</button>
              <button className="ab-btn" onClick={() => setAdding(false)}
                style={{ border: '1px solid #dde3e7', background: '#fff', color: '#78909c', borderRadius: 9, padding: '7px 12px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer' }}>ยกเลิก</button>
            </div>
          </div>
        )}
      </>
    );
  };

export default AuditBoard;
