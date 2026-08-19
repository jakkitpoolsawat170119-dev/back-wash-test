import React, { useCallback, useEffect, useRef, useState } from 'react';
import { uploadDutyImage, resizePhoto } from '../lib/dutyImages';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';
const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

/* เหตุการณ์ — หัวใจของ KM ตาม "แผนพัฒนา ERP และ KM" ข้อ 4.2
   1 แถว = 1 ปัญหา (อาการ / สาเหตุ / วิธีแก้ / ผลหลังแก้) และทุกครั้งที่บันทึก
   ระบบเขียนโน้ต .md ลงโฟลเดอร์ "เหตุการณ์" ใน vault ให้ด้วย พร้อม [[ลิงก์เครื่องจักร]] */
type Incident = {
  id: number; title: string; machine: string; line: string; batchId: string; operator: string;
  occurredAt: string; symptom: string; cause: string; fix: string; result: string;
  images: string[]; resultImages: string[];
  status: 'open' | 'closed'; vaultPath: string;
};

const card: React.CSSProperties = {
  background: '#fff', border: '1px solid var(--line,#eee3d9)', borderRadius: 16,
  boxShadow: '0 1px 2px rgba(63,37,10,.06),0 6px 18px -6px rgba(63,37,10,.12)',
};
const btn: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', color: 'var(--ink-soft,#6d6259)',
  padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
  fontFamily: 'Kanit, sans-serif', cursor: 'pointer',
};
const inp: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', borderRadius: 9,
  padding: '6px 9px', fontSize: 13, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
};
const lbl: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft,#6d6259)' };

const blank = (operator: string): Incident => ({
  id: 0, title: '', machine: '', line: '', batchId: '', operator,
  occurredAt: todayBKK(), symptom: '', cause: '', fix: '', result: '',
  images: [], resultImages: [], status: 'open', vaultPath: '',
});

/* แถบรูปแนบ — อัปขึ้น Supabase Storage แล้วเก็บแต่ URL (ห้ามเก็บ base64 ลง DB)
   ถ้าอัปไม่สำเร็จ uploadDutyImage จะคืน data URL กลับมา → ไม่รับ แล้วบอกผู้ใช้ตรง ๆ    */
const PhotoStrip: React.FC<{
  label: string; urls: string[]; onChange: (v: string[]) => void; onZoom: (u: string) => void; onError: (m: string) => void;
}> = ({ label, urls, onChange, onZoom, onError }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      const out: string[] = [];
      for (const f of Array.from(files).slice(0, 8 - urls.length)) {
        const url = await uploadDutyImage((await resizePhoto(f)).preview);
        if (url.startsWith('http')) out.push(url);
        else onError('อัปโหลดรูปขึ้นที่เก็บไฟล์ไม่สำเร็จ — ยังบันทึกรูปไม่ได้');
      }
      if (out.length) onChange([...urls, ...out]);
    } catch { onError('อ่านรูปไม่สำเร็จ'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
      {urls.map((u, i) => (
        <span key={u} style={{ position: 'relative', lineHeight: 0 }}>
          <img src={u} alt={`${label} ${i + 1}`} onClick={() => onZoom(u)}
            style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 9, cursor: 'zoom-in', border: '1px solid var(--line,#eee3d9)' }} />
          <button onClick={() => onChange(urls.filter(x => x !== u))} aria-label="เอารูปออก"
            style={{
              position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%',
              border: 'none', background: '#c62828', color: '#fff', fontSize: 12, lineHeight: 1, cursor: 'pointer',
            }}>×</button>
        </span>
      ))}
      {urls.length < 8 && (
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          style={{
            width: 54, height: 54, borderRadius: 9, border: '1px dashed var(--line,#eee3d9)',
            background: '#fdfbf9', color: 'var(--ink-soft,#6d6259)', fontSize: 18, cursor: 'pointer',
          }}>{busy ? '⏳' : '📷'}</button>
      )}
      <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
        onChange={e => { add(e.target.files); e.target.value = ''; }} />
    </div>
  );
};

const IncidentBoard: React.FC<{ operatorName: string | null }> = ({ operatorName }) => {
  const [list, setList] = useState<Incident[]>([]);
  const [machines, setMachines] = useState<string[]>([]);
  const [tab, setTab] = useState<'open' | 'all'>('open');
  const [edit, setEdit] = useState<Incident | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, m] = await Promise.all([
        fetch(`${apiUrl}/api/incidents`).then(r => r.json()),
        fetch(`${apiUrl}/api/machines`).then(r => r.json()).catch(() => ({ machines: [] })),
      ]);
      setList(Array.isArray(d?.incidents) ? d.incidents : []);
      setMachines(Array.isArray(m?.machines) ? m.machines.map((x: { name: string }) => x.name) : []);
    } catch { setMsg('❌ โหลดรายการเหตุการณ์ไม่สำเร็จ'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (d: Incident) => {
    if (!d.title.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/incidents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...d, id: d.id || undefined, title: d.title.trim(), images: d.images, resultImages: d.resultImages }),
      });
      const res = await r.json();
      if (!r.ok) { setMsg(`❌ ${res.error || 'บันทึกไม่สำเร็จ'}`); return; }
      setEdit(null);
      setMsg(res.vaultPath ? `✅ บันทึกแล้ว · เขียนโน้ตลง vault: ${res.vaultPath}`
        : res.vaultSkipped ? `✅ บันทึกแล้ว (${res.vaultSkipped} — โน้ตยังไม่ถูกเขียน)`
        : `✅ บันทึกแล้ว ⚠️ เขียนโน้ตไม่สำเร็จ: ${res.vaultError || 'ไม่ทราบสาเหตุ'}`);
      await load();
    } catch { setMsg('❌ บันทึกไม่สำเร็จ'); } finally { setBusy(false); }
  };
  const setStatus = (i: Incident, status: 'open' | 'closed') => save({ ...i, status });
  const del = async (i: Incident) => {
    if (!window.confirm(`ลบเหตุการณ์ "${i.title}" ทิ้ง?\n${i.vaultPath ? `โน้ต ${i.vaultPath} ใน Obsidian จะถูกลบด้วย` : ''}`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/incidents/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i.id }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'ลบไม่สำเร็จ'}`); return; }
      setMsg(d.vaultError ? `✅ ลบแล้ว ⚠️ ลบโน้ตในวอลต์ไม่สำเร็จ: ${d.vaultError}` : '✅ ลบแล้ว');
      await load();
    } catch { setMsg('❌ ลบไม่สำเร็จ'); } finally { setBusy(false); }
  };

  const shown = list.filter(i => (tab === 'open' ? i.status !== 'closed' : true));
  const openCount = list.filter(i => i.status !== 'closed').length;

  const Form: React.FC<{ draft: Incident }> = ({ draft }) => {
    const [d, setD] = useState(draft);
    const set = (patch: Partial<Incident>) => setD(v => ({ ...v, ...patch }));
    const area = (k: 'symptom' | 'cause' | 'fix' | 'result', label: string, hint: string,
      photoKey?: 'images' | 'resultImages') => (
      <div>
        <label style={{ ...lbl, display: 'block' }}>{label}
          <textarea value={d[k]} onChange={e => set({ [k]: e.target.value } as Partial<Incident>)} rows={2} placeholder={hint}
            style={{ ...inp, marginTop: 3, resize: 'vertical', fontWeight: 400 }} />
        </label>
        {photoKey && (
          <PhotoStrip label={label} urls={d[photoKey]} onZoom={setZoom} onError={setMsg}
            onChange={v => set({ [photoKey]: v } as Partial<Incident>)} />
        )}
      </div>
    );
    return (
      <div style={{ ...card, padding: 16, marginBottom: 14, background: '#fffaf5' }}>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
          <label style={{ ...lbl, gridColumn: '1/-1' }}>หัวข้อเหตุการณ์
            <input autoFocus value={d.title} onChange={e => set({ title: e.target.value })}
              placeholder="เช่น เครื่องซีลแนวตั้งอุณหภูมิตก รอยซีลรั่ว" style={{ ...inp, marginTop: 3, fontWeight: 600 }} />
          </label>
          <label style={lbl}>เครื่องจักร
            <input list="inc-machines" value={d.machine} onChange={e => set({ machine: e.target.value })} style={{ ...inp, marginTop: 3 }} />
            <datalist id="inc-machines">{machines.map(m => <option key={m} value={m} />)}</datalist>
          </label>
          <label style={lbl}>ไลน์
            <input value={d.line} onChange={e => set({ line: e.target.value })} placeholder="เช่น Line 2" style={{ ...inp, marginTop: 3 }} />
          </label>
          <label style={lbl}>Batch
            <input value={d.batchId} onChange={e => set({ batchId: e.target.value })} style={{ ...inp, marginTop: 3 }} />
          </label>
          <label style={lbl}>วันที่เกิด
            <input type="date" value={d.occurredAt} onChange={e => set({ occurredAt: e.target.value })} style={{ ...inp, marginTop: 3 }} />
          </label>
          <label style={lbl}>ผู้บันทึก
            <input value={d.operator} onChange={e => set({ operator: e.target.value })} style={{ ...inp, marginTop: 3 }} />
          </label>
        </div>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', marginTop: 10 }}>
          {area('symptom', 'อาการ', 'เห็นอะไร วัดค่าได้เท่าไหร่', 'images')}
          {area('cause', 'สาเหตุที่คาดว่าเป็น', 'เว้นว่างไว้ก่อนได้ ค่อยมาเติมทีหลัง')}
          {area('fix', 'วิธีแก้ที่ใช้', 'ทำอะไรไปบ้าง')}
          {area('result', 'ผลหลังแก้', 'หายไหม กลับมาอีกไหม', 'resultImages')}
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => save(d)} disabled={busy || !d.title.trim()} style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>
            {busy ? 'กำลังบันทึก…' : 'บันทึก + เขียนโน้ตลง Obsidian'}
          </button>
          <button onClick={() => setEdit(null)} style={btn}>ยกเลิก</button>
          <span style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
            หนึ่งบรรทัด = หนึ่งข้อในโน้ต · เขียนทับไฟล์เดิมทุกครั้งที่บันทึก
          </span>
        </div>
      </div>
    );
  };

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#0f7a6c',
        background: '#e8f6f3', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>📚 Knowledge management</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          เหตุการณ์
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-soft,#6d6259)' }}>ยังไม่ปิด {openCount} เรื่อง · ทั้งหมด {list.length}</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', background: '#f2ece6', borderRadius: 999, padding: 3, gap: 3 }}>
          {([['open', 'ยังไม่ปิด'], ['all', 'ทั้งหมด']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              border: 'none', borderRadius: 999, padding: '6px 15px', cursor: 'pointer',
              fontFamily: 'Kanit, sans-serif', fontSize: 12.5, fontWeight: 600,
              background: tab === k ? '#fff' : 'transparent', color: tab === k ? 'var(--ink,#2b2119)' : 'var(--ink-soft,#6d6259)',
            }}>{label}</button>
          ))}
        </span>
        <button onClick={() => setEdit(blank(operatorName || ''))} style={{ ...btn, background: '#ff6b00', borderColor: '#ff6b00', color: '#fff' }}>＋ บันทึกเหตุการณ์</button>
      </div>
      {msg && <div style={{ fontSize: 12.5, color: msg.startsWith('✅') ? '#1c8a4c' : '#c62828', marginBottom: 10, wordBreak: 'break-all' }}>{msg}</div>}
      {edit && edit.id === 0 && <Form draft={edit} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {shown.map(i => (edit && edit.id === i.id ? <Form key={i.id} draft={edit} /> : (
          <article key={i.id} style={{ ...card, padding: '14px 16px', borderLeft: `3px solid ${i.status === 'closed' ? '#1c8a4c' : '#c77700'}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <h3 style={{ fontFamily: 'Kanit, sans-serif', fontSize: 15, fontWeight: 600, margin: 0, flex: 1, minWidth: 180 }}>{i.title}</h3>
              <span style={{
                fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 10px', flex: 'none',
                color: i.status === 'closed' ? '#14653a' : '#c77700', background: i.status === 'closed' ? '#e6f4ec' : '#fdf1de',
              }}>{i.status === 'closed' ? 'ปิดแล้ว' : 'เปิดอยู่'}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft,#6d6259)', marginTop: 4, lineHeight: 1.7 }}>
              {i.occurredAt}{i.machine && <> · 🔩 {i.machine}</>}{i.line && <> · {i.line}</>}
              {i.batchId && <> · batch {i.batchId}</>}{i.operator && <> · โดย {i.operator}</>}
            </div>
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', marginTop: 10 }}>
              {([['อาการ', i.symptom, i.images], ['สาเหตุ', i.cause, []], ['วิธีแก้', i.fix, []],
                 ['ผลหลังแก้', i.result, i.resultImages]] as [string, string, string[]][])
                .filter(([, v, ph]) => v || ph.length)
                .map(([k, v, ph]) => (
                  <div key={k} style={{ background: '#fbf7f3', borderRadius: 10, padding: '8px 10px' }}>
                    <div style={{ ...lbl, marginBottom: 2 }}>{k}</div>
                    {v && <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{v}</div>}
                    {ph.length > 0 && (
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                        {ph.map(u => (
                          <img key={u} src={u} alt={k} onClick={() => setZoom(u)}
                            style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in' }} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={() => setEdit(i)} style={{ ...btn, padding: '4px 11px', fontSize: 12 }}>✏️ แก้ไข / เติมสาเหตุ</button>
              {i.status === 'closed'
                ? <button onClick={() => setStatus(i, 'open')} style={{ ...btn, padding: '4px 11px', fontSize: 12 }}>↩ เปิดใหม่</button>
                : <button onClick={() => setStatus(i, 'closed')} style={{ ...btn, padding: '4px 11px', fontSize: 12, color: '#14653a', background: '#e6f4ec', borderColor: '#c9e6d5' }}>✓ ปิดเรื่อง</button>}
              <button onClick={() => del(i)} disabled={busy} title="ลบทิ้ง (ลบโน้ตในวอลต์ด้วย)"
                style={{ ...btn, padding: '4px 11px', fontSize: 12, color: '#c62828', background: '#fdecea', borderColor: '#f7d9d5' }}>🗑 ลบ</button>
              {i.vaultPath && <span style={{ fontSize: 11.5, color: 'var(--ink-soft,#6d6259)', wordBreak: 'break-all' }}>📄 {i.vaultPath}</span>}
            </div>
          </article>
        )))}
        {zoom && (
          <div onClick={() => setZoom(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20 }}>
            <img src={zoom} alt="ขยาย" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12 }} />
          </div>
        )}
        {!shown.length && (
          <div style={{ ...card, padding: 20, textAlign: 'center', color: 'var(--ink-soft,#6d6259)', fontSize: 13, lineHeight: 1.7 }}>
            {tab === 'open' ? 'ไม่มีเหตุการณ์ที่ยังไม่ปิด 🎉' : 'ยังไม่มีเหตุการณ์ที่บันทึกไว้'}
            <br />
            <span style={{ fontSize: 12 }}>เจอปัญหาหน้างานแล้วกด “＋ บันทึกเหตุการณ์” — สาเหตุ/วิธีแก้ค่อยมาเติมทีหลังได้</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default IncidentBoard;
