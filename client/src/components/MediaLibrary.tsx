import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MEDIA_FOLDERS, deleteMedia, isImage, isPdf, listMedia, patchMedia, scanStorage,
  type MediaItem,
} from '../lib/media';
import { humanSize, uploadAndRegister } from '../lib/uploadFile';

/* ══════════════ คลังไฟล์ (เฟส 2) ══════════════
   modal 3 ช่อง — ซ้าย: โฟลเดอร์ตามพื้นที่ผลิต · กลาง: ค้นหา + ตารางไฟล์ + โซนลากวาง
   ขวา: รายละเอียดไฟล์ + ตัวเลือกตอนแทรก
   ไฟล์อยู่บน Supabase Storage เหมือนเดิม ที่นี่คุยกับ "ทะเบียน" ที่เซิร์ฟเวอร์เรา */

/** สิ่งที่ผู้เรียกได้กลับไปตอนกดแทรก — mode ใช้เฉพาะ PDF/ไฟล์เอกสาร */
export interface MediaInsertOpt {
  mode: 'button' | 'embed';
  caption: string;
}

interface Props {
  /** จำกัดชนิดไฟล์ที่เลือกได้ — เปิดจากบล็อกรูปก็ควรเห็นแต่รูป */
  accept?: 'any' | 'image' | 'pdf';
  /** ข้อความบนปุ่มแทรก เช่น "ใส่ในบล็อกนี้" / "ตั้งเป็นภาพหน้าปก" */
  insertLabel?: string;
  uploadedBy?: string;
  onInsert: (item: MediaItem, opt: MediaInsertOpt) => void;
  onClose: () => void;
}

const UNFILED = '— ยังไม่จัดหมวด —';
const shortDate = (s: string) => (s || '').slice(0, 16).replace('T', ' ');

const MediaLibrary: React.FC<Props> = ({ accept = 'any', insertLabel = 'แทรกลงบทความ', uploadedBy = '', onInsert, onClose }) => {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('');            // '' = ทุกโฟลเดอร์
  const [kind, setKind] = useState<'any' | 'image' | 'pdf' | 'other'>(accept === 'any' ? 'any' : accept);
  const [selId, setSelId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tagIn, setTagIn] = useState('');
  const [pdfMode, setPdfMode] = useState<'button' | 'embed'>('button');

  const sel = items.find(i => i.id === selId) || null;

  const load = useCallback(async (keep?: number) => {
    setLoading(true);
    setErr('');
    try {
      const r = await listMedia({ q, folder: folder === UNFILED ? '' : folder, kind: kind === 'any' ? '' : kind });
      // กรอง "ยังไม่จัดหมวด" ฝั่งนี้ — ส่ง folder='' ไปเซิร์ฟเวอร์แปลว่า "ทุกโฟลเดอร์"
      const list = folder === UNFILED ? r.items.filter(i => !i.folder) : r.items;
      setItems(list);
      setCounts(Object.fromEntries(r.folders.map(f => [f.folder || UNFILED, f.n])));
      setSelId(prev => (keep !== undefined ? keep : (list.some(i => i.id === prev) ? prev : null)));
    } catch (e) {
      setErr('โหลดคลังไฟล์ไม่สำเร็จ — ' + (e instanceof Error ? e.message : ''));
    } finally { setLoading(false); }
  }, [q, folder, kind]);

  // หน่วงตอนพิมพ์ค้นหา ไม่ให้ยิงทุกตัวอักษร
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* ── อัปโหลดเข้าคลัง ── */
  const takeFiles = async (files: File[]) => {
    const ok = files.filter(f => (accept === 'image' ? f.type.startsWith('image/')
      : accept === 'pdf' ? f.type === 'application/pdf' : true));
    if (!ok.length) { setNote('ไฟล์ที่ลากมาไม่ตรงชนิดที่ต้องการ'); return; }
    let last: number | undefined;
    for (let i = 0; i < ok.length; i++) {
      setBusy(`กำลังอัปโหลด ${ok[i].name} (${i + 1}/${ok.length})…`);
      const m = await uploadAndRegister(ok[i], {
        folder: folder && folder !== UNFILED ? folder : '',
        uploadedBy,
      });
      if (!m) { setBusy(''); setErr('อัปโหลดไม่สำเร็จ — ยังไม่ได้ตั้งค่า Supabase หรือไฟล์ใหญ่เกิน'); return; }
      last = m.id;
    }
    setBusy('');
    setNote(`เพิ่มเข้าคลังแล้ว ${ok.length} ไฟล์`);
    await load(last);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) await takeFiles(files);
  };

  const scan = async () => {
    setBusy('กำลังสแกนไฟล์เก่าในที่เก็บ…');
    setErr('');
    try {
      const r = await scanStorage();
      setNote(r.added ? `พบไฟล์เก่าเพิ่ม ${r.added} ไฟล์ (มีอยู่แล้ว ${r.skipped})` : `ไม่มีไฟล์ใหม่ — ในคลังครบแล้ว ${r.skipped} ไฟล์`);
      await load();
    } catch (e) {
      setErr('สแกนไม่สำเร็จ — ' + (e instanceof Error ? e.message : ''));
    } finally { setBusy(''); }
  };

  /* ── แก้ทะเบียนไฟล์ที่เลือก ── */
  const edit = async (patch: Partial<Pick<MediaItem, 'name' | 'folder' | 'caption' | 'tags'>>) => {
    if (!sel) return;
    const before = items;
    setItems(list => list.map(i => (i.id === sel.id ? { ...i, ...patch } : i)));   // ตอบสนองทันที
    try { await patchMedia(sel.id, patch); }
    catch (e) { setItems(before); setErr('บันทึกไม่สำเร็จ — ' + (e instanceof Error ? e.message : '')); }
  };

  const removeSel = async () => {
    if (!sel) return;
    if (!confirm(`เอา "${sel.name}" ออกจากคลัง?\n(ไฟล์ยังอยู่ในที่เก็บ บทความที่ใช้ไฟล์นี้อยู่ไม่พัง)`)) return;
    try { await deleteMedia(sel.id); setSelId(null); await load(); setNote('เอาออกจากคลังแล้ว'); }
    catch (e) { setErr('เอาออกไม่สำเร็จ — ' + (e instanceof Error ? e.message : '')); }
  };

  const folderList = [
    { key: '', label: 'ไฟล์ทั้งหมด' },
    ...MEDIA_FOLDERS.map(f => ({ key: f, label: f })),
    { key: UNFILED, label: UNFILED },
  ];
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="blogx-ov" onClick={onClose} />
      <div className="blogx-modal media-modal">
        <div className="modal-hd">
          <h3>🗂 คลังไฟล์</h3>
          <span className="mlib-hdnote">{busy || note || `${items.length} ไฟล์`}</span>
          <button className="x" onClick={onClose}>✕</button>
        </div>

        <div className="mlib">
          {/* ซ้าย — โฟลเดอร์ */}
          <div className="mlib-side">
            {folderList.map(f => (
              <button key={f.key || 'all'} className={`mlib-folder${folder === f.key ? ' on' : ''}`}
                onClick={() => setFolder(f.key)}>
                <span className="ic">{f.key === '' ? '📁' : f.key === UNFILED ? '🗃' : '📂'}</span>
                <span className="t">{f.label}</span>
                <span className="n">{f.key === '' ? totalCount : (counts[f.key] || 0)}</span>
              </button>
            ))}
            <div className="mlib-sidefoot">
              <button className="btn-o" onClick={scan} disabled={!!busy}>สแกนหาไฟล์เก่า</button>
              <div className="hintx">ไฟล์ที่อัปไว้ก่อนมีคลัง จะถูกดึงเข้าทะเบียนให้</div>
            </div>
          </div>

          {/* กลาง — ค้นหา + ตารางไฟล์ */}
          <div className="mlib-mid"
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}>
            <div className="mlib-bar">
              <div className="bl-search">
                <span>🔍</span>
                <input value={q} onChange={e => setQ(e.target.value)}
                  placeholder="ค้นชื่อไฟล์ / แท็ก / คำบรรยาย" />
              </div>
              {accept === 'any' && (
                <div className="mlib-kinds">
                  {([['any', 'ทั้งหมด'], ['image', 'รูป'], ['pdf', 'PDF'], ['other', 'อื่น ๆ']] as const).map(([k, t]) => (
                    <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{t}</button>
                  ))}
                </div>
              )}
              <button className="btn-o fill" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                ＋ อัปโหลด
              </button>
              <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
                accept={accept === 'image' ? 'image/*' : accept === 'pdf' ? '.pdf,application/pdf' : undefined}
                onChange={async e => {
                  const fs = Array.from(e.target.files || []);
                  e.target.value = '';
                  if (fs.length) await takeFiles(fs);
                }} />
            </div>

            {err && <div className="mlib-err">{err}</div>}

            <div className={`mlib-grid${dragOver ? ' drop' : ''}`}>
              {loading && <div className="mlib-empty">กำลังโหลด…</div>}
              {!loading && !items.length && (
                <div className="mlib-empty">
                  {q || folder || kind !== 'any'
                    ? 'ไม่มีไฟล์ที่ตรงกับที่กรองไว้'
                    : 'ยังไม่มีไฟล์ในคลัง — ลากไฟล์มาวางตรงนี้ หรือกด "สแกนหาไฟล์เก่า" ถ้าเคยอัปไว้แล้ว'}
                </div>
              )}
              {items.map(m => (
                <button key={m.id} className={`mlib-card${selId === m.id ? ' on' : ''}`}
                  onClick={() => setSelId(m.id)}
                  onDoubleClick={() => onInsert(m, { mode: pdfMode, caption: m.caption })}>
                  <div className="th">
                    {isImage(m) ? <img src={m.url} alt={m.name} loading="lazy" />
                      : <span className="ph">{isPdf(m) ? '📕' : '📄'}</span>}
                  </div>
                  <div className="nm" title={m.name}>{m.name}</div>
                  <div className="mt">{m.size ? humanSize(m.size) : ''}{m.folder ? ` · ${m.folder}` : ''}</div>
                </button>
              ))}
              {dragOver && <div className="mlib-dropmsg">วางไฟล์เพื่ออัปโหลดเข้าคลัง</div>}
            </div>
          </div>

          {/* ขวา — รายละเอียด + ตัวเลือกตอนแทรก */}
          <div className="mlib-detail">
            {!sel && <div className="mlib-empty sm">เลือกไฟล์ทางซ้ายเพื่อดูรายละเอียด</div>}
            {sel && (
              <>
                <div className="mlib-prev">
                  {isImage(sel) ? <img src={sel.url} alt={sel.name} />
                    : <span className="ph">{isPdf(sel) ? '📕' : '📄'}</span>}
                </div>
                <div className="srow">
                  <label>ชื่อไฟล์</label>
                  <input className="sinput" value={sel.name}
                    onChange={e => setItems(l => l.map(i => (i.id === sel.id ? { ...i, name: e.target.value } : i)))}
                    onBlur={e => edit({ name: e.target.value })} />
                </div>
                <div className="srow">
                  <label>โฟลเดอร์</label>
                  <select className="sselect" value={sel.folder} onChange={e => edit({ folder: e.target.value })}>
                    <option value="">— ยังไม่จัดหมวด —</option>
                    {MEDIA_FOLDERS.map(f => <option key={f}>{f}</option>)}
                  </select>
                </div>
                <div className="srow">
                  <label>คำบรรยาย (ใช้เป็นคำบรรยายภาพตอนแทรก)</label>
                  <textarea className="starea" rows={2} value={sel.caption}
                    onChange={e => setItems(l => l.map(i => (i.id === sel.id ? { ...i, caption: e.target.value } : i)))}
                    onBlur={e => edit({ caption: e.target.value })} />
                </div>
                <div className="srow">
                  <label>แท็ก</label>
                  <div className="chips" style={{ marginBottom: 6 }}>
                    {!sel.tags.length && <span className="hintx" style={{ margin: 0 }}>ยังไม่มีแท็ก</span>}
                    {sel.tags.map((t, i) => (
                      <span className="chip" key={t}>#{t}
                        <button title="เอาออก" onClick={() => edit({ tags: sel.tags.filter((_, j) => j !== i) })}>×</button>
                      </span>
                    ))}
                  </div>
                  <input className="sinput" value={tagIn} placeholder="พิมพ์แล้วกด Enter"
                    onChange={e => setTagIn(e.target.value)}
                    onKeyDown={e => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      const v = tagIn.trim().replace(/^#/, '');
                      if (v && !sel.tags.includes(v)) void edit({ tags: [...sel.tags, v] });
                      setTagIn('');
                    }} />
                </div>
                <div className="mlib-meta">
                  {sel.size ? humanSize(sel.size) : 'ไม่รู้ขนาด'} · {sel.mime || 'ไม่รู้ชนิด'}
                  {sel.createdAt && <> · เข้าคลัง {shortDate(sel.createdAt)}</>}
                  {sel.uploadedBy && <> · โดย {sel.uploadedBy}</>}
                </div>

                {!isImage(sel) && (
                  <div className="srow">
                    <label>แทรกแบบไหน</label>
                    <div className="mlib-modes">
                      <button className={pdfMode === 'button' ? 'on' : ''} onClick={() => setPdfMode('button')}>ปุ่มดาวน์โหลด</button>
                      <button className={pdfMode === 'embed' ? 'on' : ''} onClick={() => setPdfMode('embed')}>ฝังตัวอ่านในหน้า</button>
                    </div>
                  </div>
                )}

                <div className="mlib-acts">
                  <button className="btn-o fill" onClick={() => onInsert(sel, { mode: pdfMode, caption: sel.caption })}>
                    {insertLabel}
                  </button>
                  <button className="btn-o" onClick={() => { navigator.clipboard.writeText(sel.url).catch(() => null); setNote('คัดลอกลิงก์ไฟล์แล้ว'); }}>
                    คัดลอกลิงก์
                  </button>
                  <a className="btn-o" href={sel.url} target="_blank" rel="noreferrer">เปิดไฟล์ ↗</a>
                  <button className="btn-o danger" onClick={removeSel}>เอาออกจากคลัง</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default MediaLibrary;
