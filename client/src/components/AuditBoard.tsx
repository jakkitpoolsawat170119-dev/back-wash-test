import React, { useState, useEffect, useCallback, useMemo } from 'react';

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

// ── ย่อรูปก่อนแนบ (ขอบยาว ≤1568 → JPEG q0.85) — คืน data URL + base64 (เหมือน TodoBoard) ──
type PhotoAttach = { preview: string; data: string; mediaType: string };
const resizePhoto = (file: File): Promise<PhotoAttach> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const el = new Image();
    el.onload = () => {
      const scale = Math.min(1, 1568 / Math.max(el.width, el.height));
      const w = Math.max(1, Math.round(el.width * scale)), h = Math.max(1, Math.round(el.height * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
      cx.drawImage(el, 0, 0, w, h);
      const dataUrl = cv.toDataURL('image/jpeg', 0.85);
      resolve({ preview: dataUrl, data: dataUrl.split(',')[1] || '', mediaType: 'image/jpeg' });
    };
    el.onerror = reject; el.src = String(reader.result);
  };
  reader.onerror = reject; reader.readAsDataURL(file);
});

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

interface Props { operatorName: string | null; onBackToMain: () => void; }

const AuditBoard: React.FC<Props> = ({ operatorName, onBackToMain }) => {
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
  const routeAll = useCallback(async () => {
    const filled = rows.filter(r => r.issue.trim() && r.location.trim());
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
        return {
          ...row,
          assignees: s.assignees && s.assignees.length ? s.assignees : row.assignees,
          category: s.category || row.category,
          priority: s.priority === 'urgent' ? 'urgent' : row.priority,
          source: s.source, confidence: s.confidence || 0,
          lowConfidence: !!s.lowConfidence, matchedRule: s.matchedRule || null,
        };
      }));
    } catch { setSentMsg('แบ่งงานไม่สำเร็จ — เช็คว่าเซิร์ฟเวอร์ทำงานอยู่'); }
    finally { setRouting(false); }
  }, [rows]);

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
    let ok = 0;
    try {
      for (const r of ready) {
        const resp = await fetch(`${apiUrl}/api/duty/assign`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workDate: date, title: r.issue.trim(), location: r.location.trim() || null,
            category: r.category, priority: r.priority, assignees: r.assignees,
            images: r.photo ? [r.photo.preview] : [],
            doneImages: r.donePhoto ? [r.donePhoto.preview] : [], // แนบรูปหลังทำ = ปิดงานทันที
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
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '12px 12px 80px', fontFamily: 'Inter, sans-serif' }}>
      {/* hover/focus states (guardrail: animate transform เท่านั้น) */}
      <style>{`
        .ab-btn{transition:transform .12s ease, box-shadow .12s ease;}
        .ab-btn:hover:not(:disabled){transform:translateY(-1px);}
        .ab-btn:active:not(:disabled){transform:translateY(0);}
        .ab-btn:focus-visible{outline:2px solid #ff6b00;outline-offset:2px;}
        .ab-chip{transition:transform .1s ease;}
        .ab-chip:hover{transform:translateY(-1px);}
      `}</style>

      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <button className="ab-btn" onClick={onBackToMain} style={{ border: '1px solid #eee', background: '#fff', borderRadius: 10, padding: '6px 10px', cursor: 'pointer' }}>← กลับ</button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#37474f', flex: 1 }}>📋 ใบตรวจ — แบ่งงานอัตโนมัติ</h2>
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
                list="ab-zones" placeholder="สถานที่ / โซน" style={{ ...inp, flex: 1, minWidth: 160 }} />
              <button className="ab-btn" onClick={() => patchRow(r.id, { priority: r.priority === 'urgent' ? 'normal' : 'urgent' })}
                style={{ border: `1px solid ${r.priority === 'urgent' ? '#e53935' : '#dde3e7'}`, background: r.priority === 'urgent' ? '#ffebee' : '#fff', color: r.priority === 'urgent' ? '#c62828' : '#78909c', borderRadius: 9, padding: '8px 12px', fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {r.priority === 'urgent' ? '🔴 ด่วน' : 'ปกติ'}
              </button>
              <label className="ab-btn" style={{ border: '1px solid #dde3e7', background: r.photo ? '#e8f5e9' : '#fff', borderRadius: 9, padding: '8px 12px', fontSize: '0.76rem', fontWeight: 700, color: r.photo ? '#2e7d32' : '#78909c', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {r.photo ? '📷 ก่อนทำ ✓' : '📷 รูปก่อนทำ'}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => onPhoto(r.id, e.target.files?.[0])} />
              </label>
              <label className="ab-btn" style={{ border: '1px solid #dde3e7', background: r.donePhoto ? '#e3f2fd' : '#fff', borderRadius: 9, padding: '8px 12px', fontSize: '0.76rem', fontWeight: 700, color: r.donePhoto ? '#1565c0' : '#78909c', cursor: 'pointer', whiteSpace: 'nowrap' }} title="ถ้าแก้เสร็จหน้างานแล้ว แนบรูปหลังทำ → ระบบจะปิดงานให้เลย">
                {r.donePhoto ? '✅ หลังทำ ✓' : '📷 รูปหลังทำ'}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => onDonePhoto(r.id, e.target.files?.[0])} />
              </label>
            </div>
            {(r.photo || r.donePhoto) && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                {r.photo && <div><div style={{ fontSize: '0.64rem', color: '#78909c', marginBottom: 2 }}>ก่อนทำ</div><img src={r.photo.preview} alt="ก่อนทำ" style={{ maxHeight: 90, borderRadius: 8, border: '1px solid #eceff1' }} /></div>}
                {r.donePhoto && <div><div style={{ fontSize: '0.64rem', color: '#1565c0', marginBottom: 2 }}>หลังทำ ✅</div><img src={r.donePhoto.preview} alt="หลังทำ" style={{ maxHeight: 90, borderRadius: 8, border: '1px solid #cfe4fb' }} /></div>}
              </div>
            )}

            {/* ผู้รับผิดชอบ (ชิป + เพิ่มคน) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', background: '#fafbfc', border: '1px solid #eef1f3', borderRadius: 10, padding: '8px 10px' }}>
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
    </div>
  );
};

export default AuditBoard;
