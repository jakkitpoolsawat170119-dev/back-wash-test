import React, { useRef, useState } from 'react';

/* การ์ด "นำเข้าจากรูปเอกสาร" ของทะเบียนงานรูทีน
   วางรูปเช็คลิสต์กระดาษ → AI อ่านตาราง → ตรวจทานในหน้าเว็บ → กดนำเข้าทีเดียว
   ตั้งใจให้ "ตรวจก่อนเขียน" เสมอ: endpoint อ่านอย่างเดียว ไม่เขียน DB เอง
   ค่าตั้งต้น (ผู้รับผิดชอบ/ความถี่/คนในทีม) ใช้ร่วมทุกแถว แก้รายแถวทีหลังในทะเบียนได้ */

type Role = '' | 'mt' | 'op' | 'qc' | 'pd';
type Freq = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'onuse' | 'onissue';
type Person = { key: string; name: string };
type Draft = { group: string; seq: number; title: string; goal: string; method: string; unclear: boolean };

type Props = {
  apiUrl: string;
  machines: string[];
  people: Person[];
  roleOptions: { key: Exclude<Role, ''>; label: string }[];
  freqOptions: { key: Freq; label: string }[];
  onSave: (rows: { title: string; goal: string; method: string; machine: string }[],
           opts: { ownerRole: Role; freq: Freq; personKey: string }) => Promise<number>;
};

// ย่อรูปเอกสารก่อนส่ง — 2576px คือขนาดสูงสุดที่โมเดลใช้จริง ตัวหนังสือในตารางเล็กจึงส่งคมไว้
const loadImage = (file: File): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject; el.src = String(reader.result);
  };
  reader.onerror = reject; reader.readAsDataURL(file);
});
const resizeSheet = async (file: File) => {
  const el = await loadImage(file);
  const scale = Math.min(1, 2576 / Math.max(el.width, el.height));
  const w = Math.max(1, Math.round(el.width * scale)), h = Math.max(1, Math.round(el.height * scale));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d')!;
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
  cx.drawImage(el, 0, 0, w, h);
  const dataUrl = cv.toDataURL('image/jpeg', 0.9);
  return { preview: dataUrl, data: dataUrl.split(',')[1] || '', mediaType: 'image/jpeg' };
};

const card: React.CSSProperties = {
  background: '#fff', border: '1px solid var(--line,#eee3d9)', borderRadius: 16,
  boxShadow: '0 1px 2px rgba(63,37,10,.06),0 6px 18px -6px rgba(63,37,10,.12)',
};
const btn: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', color: 'var(--ink-soft,#6d6259)',
  padding: '7px 15px', borderRadius: 999, fontSize: 12.8, fontWeight: 600,
  fontFamily: 'Kanit, sans-serif', cursor: 'pointer',
};
const priBtn: React.CSSProperties = { ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' };
const inp: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', borderRadius: 8,
  padding: '5px 8px', fontSize: 12.5, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
};
const lbl: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' };

const RoutineSheetImport: React.FC<Props> = ({ apiUrl, machines, people, roleOptions, freqOptions, onSave }) => {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shots, setShots] = useState<string[]>([]);        // รูปที่ส่งไปอ่าน (โชว์เป็นภาพเล็ก)
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [ownerRole, setOwnerRole] = useState<Role>('mt');
  const [freq, setFreq] = useState<Freq>('daily');
  const [personKey, setPersonKey] = useState(people[0]?.key || '');
  const fileRef = useRef<HTMLInputElement>(null);

  const readSheets = async (files: File[]) => {
    const pics = files.filter(f => f.type.startsWith('image/')).slice(0, 6);
    if (!pics.length || reading) return;
    setReading(true); setMsg(null);
    try {
      const imgs: { preview: string; data: string; mediaType: string }[] = [];
      for (const f of pics) { try { imgs.push(await resizeSheet(f)); } catch { /* ข้ามไฟล์เสีย */ } }
      if (!imgs.length) { setMsg({ kind: 'err', text: 'อ่านไฟล์รูปไม่ได้ ลองใหม่อีกครั้ง' }); return; }
      setShots(imgs.map(i => i.preview));
      const resp = await fetch(`${apiUrl}/api/routine/read-sheet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: imgs.map(i => ({ data: i.data, media_type: i.mediaType })) }),
      });
      const d = await resp.json();
      if (!resp.ok) { setMsg({ kind: 'err', text: d.error || 'อ่านเอกสารไม่สำเร็จ' }); return; }
      const got: Draft[] = Array.isArray(d.rows) ? d.rows : [];
      if (!got.length) { setMsg({ kind: 'err', text: 'อ่านไม่เจอแถวไหนเลย — ลองครอปเฉพาะตาราง หรือถ่ายให้ชัดขึ้น' }); return; }
      setDrafts(got);
      const n = got.filter(r => r.unclear).length;
      setMsg({ kind: 'ok', text: `อ่านได้ ${got.length} รายการ${n ? ` · ${n} รายการต้องตรวจทาน (⚠️)` : ''} — ตรวจแล้วกดนำเข้า` });
    } catch {
      setMsg({ kind: 'err', text: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ — เช็คเน็ตแล้วลองใหม่' });
    } finally { setReading(false); }
  };

  const patch = (i: number, p: Partial<Draft>) =>
    setDrafts(ds => ds ? ds.map((d, j) => (j === i ? { ...d, ...p } : d)) : ds);
  const drop = (i: number) => setDrafts(ds => ds ? ds.filter((_, j) => j !== i) : ds);
  const reset = () => { setDrafts(null); setShots([]); setMsg(null); if (fileRef.current) fileRef.current.value = ''; };

  const saveAll = async () => {
    if (!drafts) return;
    const ready = drafts.filter(d => d.title.trim());
    if (!ready.length) { setMsg({ kind: 'err', text: 'ไม่มีแถวที่มีหัวข้อการตรวจสอบ' }); return; }
    setSaving(true);
    try {
      const n = await onSave(
        ready.map(d => ({ title: d.title.trim(), goal: d.goal.trim(), method: d.method.trim(), machine: d.group.trim() })),
        { ownerRole, freq, personKey },
      );
      if (n === ready.length) { reset(); setOpen(false); setMsg({ kind: 'ok', text: `นำเข้าแล้ว ${n} รายการ` }); }
      else setMsg({ kind: 'err', text: `นำเข้าได้ ${n} จาก ${ready.length} รายการ — ที่เหลือลองกดใหม่อีกครั้ง` });
    } finally { setSaving(false); }
  };

  // กลุ่มที่อ่านได้ + จำนวนแถว (ใช้โชว์สรุปเหนือตารางตรวจทาน)
  const groupCount = (drafts || []).reduce<Record<string, number>>((a, d) => {
    const g = d.group.trim() || '(ไม่ระบุกลุ่ม)';
    a[g] = (a[g] || 0) + 1; return a;
  }, {});

  return (
    <div style={{ ...card, padding: '16px 18px', marginBottom: 16, position: 'relative', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', right: -50, bottom: -70, width: 200, height: 200, borderRadius: '50%',
        background: 'radial-gradient(circle,rgba(255,107,0,.12),transparent 70%)', pointerEvents: 'none',
      }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', position: 'relative' }}>
        <h3 style={{
          fontFamily: 'Kanit, sans-serif', fontSize: 15.5, fontWeight: 600, margin: 0,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>📄 นำเข้าจากรูปเอกสาร</h3>
        <button onClick={() => setOpen(o => !o)} style={{ ...btn, marginLeft: 'auto' }}>
          {open ? 'ซ่อน' : 'เปิดใช้'}
        </button>
      </div>
      <div style={{ fontSize: 12.8, color: 'var(--ink-soft,#6d6259)', maxWidth: 660, marginTop: 4, position: 'relative' }}>
        ถ่ายรูปเช็คลิสต์กระดาษ (ลำดับ / หัวข้อ / มาตรฐาน / วิธีการ) แล้ว AI อ่านตารางมาให้ — <b>ตรวจทานได้ก่อนบันทึกเสมอ</b> ไม่ต้องพิมพ์เองทีละแถว
      </div>

      {open && (
        <div style={{ marginTop: 14, position: 'relative' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden
              onChange={e => readSheets(Array.from(e.target.files || []))} />
            <button onClick={() => fileRef.current?.click()} disabled={reading || saving} style={priBtn}>
              {reading ? '⏳ กำลังอ่านเอกสาร…' : '📷 เลือกรูปเอกสาร (ได้ถึง 6 รูป)'}
            </button>
            {drafts && <button onClick={reset} disabled={saving} style={btn}>เริ่มใหม่</button>}
            {shots.map((s, i) => (
              <img key={i} src={s} alt={`หน้า ${i + 1}`} style={{
                width: 40, height: 52, objectFit: 'cover', borderRadius: 7,
                border: '1px solid var(--line,#eee3d9)',
              }} />
            ))}
          </div>
          {msg && (
            <div style={{
              fontSize: 12.5, marginTop: 9, fontWeight: 600,
              color: msg.kind === 'ok' ? '#1c8a4c' : '#c62828',
            }}>{msg.text}</div>
          )}

          {drafts && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0 10px' }}>
                {Object.entries(groupCount).map(([g, n]) => (
                  <span key={g} style={{
                    fontSize: 11.5, fontWeight: 600, fontFamily: 'Kanit, sans-serif',
                    background: '#fff3ea', color: '#c24f00', borderRadius: 999, padding: '3px 11px',
                  }}>{g} · {n} รายการ</span>
                ))}
              </div>

              {/* ค่าตั้งต้นของทั้งชุด — เอกสารกระดาษไม่มีข้อมูลพวกนี้ ต้องให้คนเลือก */}
              <div style={{
                display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))',
                background: '#fbf7f3', border: '1px solid var(--line,#eee3d9)', borderRadius: 12, padding: 12,
              }}>
                <label style={lbl}>ผู้รับผิดชอบหลัก (ทุกแถว)
                  <select value={ownerRole} onChange={e => setOwnerRole(e.target.value as Role)} style={{ ...inp, marginTop: 3 }}>
                    <option value="">— ไม่ระบุ —</option>
                    {roleOptions.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </label>
                <label style={lbl}>ความถี่ (ทุกแถว)
                  <select value={freq} onChange={e => setFreq(e.target.value as Freq)} style={{ ...inp, marginTop: 3 }}>
                    {freqOptions.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </label>
                <label style={lbl}>คนในทีมที่รับงาน (ทุกแถว)
                  <select value={personKey} onChange={e => setPersonKey(e.target.value)} style={{ ...inp, marginTop: 3 }}>
                    {people.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                  </select>
                </label>
              </div>
              {ownerRole !== 'mt' && (
                <div style={{ fontSize: 11.5, color: '#c77700', marginTop: 7 }}>
                  ผู้รับผิดชอบหลักไม่ใช่ Maintenance → งานชุดนี้จะเข้าทะเบียนอย่างเดียว ยังไม่ขึ้นให้ติ๊กบนกระดานเวร
                </div>
              )}

              <div style={{ overflowX: 'auto', marginTop: 12, border: '1px solid var(--line,#eee3d9)', borderRadius: 12 }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 860, fontSize: 12.8 }}>
                  <thead>
                    <tr>
                      {['#', 'กลุ่ม / เครื่องจักร', 'หัวข้อการตรวจสอบ', 'มาตรฐานการตรวจสอบ', 'วิธีการตรวจสอบ', ''].map((h, i) => (
                        <th key={i} style={{
                          fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: 'var(--ink-soft,#6d6259)',
                          textAlign: 'left', padding: '9px 10px', background: '#fbf7f3',
                          borderBottom: '1px solid var(--line,#eee3d9)', whiteSpace: 'nowrap',
                          width: ['36px', '16%', '28%', '26%', '26%', '44px'][i],
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {drafts.map((d, i) => (
                      <tr key={i} style={{ background: d.unclear ? '#fff6e6' : undefined }}>
                        <td style={{ padding: '6px 10px', color: '#a49a90', fontWeight: 600 }}>
                          {d.seq || i + 1}
                          {d.unclear && <div title="AI อ่านไม่ชัด — ตรวจทานก่อน" style={{ fontSize: 13 }}>⚠️</div>}
                        </td>
                        <td style={{ padding: '6px 10px' }}>
                          <input list="rsi-machines" value={d.group} onChange={e => patch(i, { group: e.target.value })} style={inp} />
                        </td>
                        <td style={{ padding: '6px 10px' }}>
                          <input value={d.title} onChange={e => patch(i, { title: e.target.value })} style={inp} />
                        </td>
                        <td style={{ padding: '6px 10px' }}>
                          <input value={d.goal} onChange={e => patch(i, { goal: e.target.value })} style={inp} />
                        </td>
                        <td style={{ padding: '6px 10px' }}>
                          <input value={d.method} onChange={e => patch(i, { method: e.target.value })} style={inp} />
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <button onClick={() => drop(i)} title="ไม่เอาแถวนี้" style={{
                            ...btn, padding: '3px 8px', fontSize: 12,
                            color: '#c62828', background: '#fdecea', borderColor: '#f7d9d5',
                          }}>🗑</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <datalist id="rsi-machines">{machines.map(m => <option key={m} value={m} />)}</datalist>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
                <button onClick={saveAll} disabled={saving || !drafts.length || !personKey} style={priBtn}>
                  {saving ? '⏳ กำลังนำเข้า…' : `✓ ตรวจทานแล้ว นำเข้าทั้งหมด ${drafts.length} รายการ`}
                </button>
                <span style={{ fontSize: 11.5, color: '#a49a90' }}>
                  นำเข้าแล้วยังแก้รายแถวในทะเบียนด้านล่างได้ตามปกติ
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default RoutineSheetImport;
