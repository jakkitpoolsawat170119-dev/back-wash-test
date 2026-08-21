import React, { useCallback, useEffect, useState } from 'react';
import { authHeaders, authRole } from '../lib/auth';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

/* ── คู่มือ / SOP ที่รอตรวจ + เทียบเวอร์ชัน (แผน KM ข้อ 7 ส่วนที่ค้าง) ────────
   GET /api/sop/queue → อะไรบ้างที่ต้องทำ · GET /api/sop/diff?id → เทียบทีละบรรทัด
   อนุมัติ/ตีกลับใช้เส้นเดิม /api/posts/approve|reject (หัวหน้างานขึ้นไป)        */
type State = 'review' | 'never' | 'edited';
type Item = {
  id: number; title: string; slug: string; author: string; status: string;
  updatedAt: string; state: State; version: number;
  approvedBy: string; approvedAt: string; added: number; removed: number;
};
type Line = { t: 'same' | 'add' | 'del'; text: string };
type Side = { label: string; title: string; approvedBy?: string; approvedAt?: string; version?: number };
type Diff = {
  id: number; title: string; status: string; left: Side; right: Side;
  versions: { version: number; approvedBy: string; approvedAt: string }[];
  lines: Line[]; added: number; removed: number; same: number;
};

const STATE_INFO: Record<State, { label: string; c: string; b: string; what: string }> = {
  review: { label: 'รอตรวจ', c: '#b3261e', b: '#fdecea', what: 'คนเขียนกดส่งขออนุมัติแล้ว รอหัวหน้าตรวจ' },
  never: { label: 'ยังไม่เคยอนุมัติ', c: '#a15c00', b: '#fff3e0', what: 'ยังไม่เคยผ่านการอนุมัติสักรอบ คนอ่านจึงยังไม่เห็น' },
  edited: { label: 'มีของแก้ค้าง', c: '#6d6259', b: '#f2ece6', what: 'อนุมัติไปแล้ว แต่มีคนแก้เพิ่มหลังจากนั้น' },
};

const card: React.CSSProperties = {
  background: 'var(--card,#fff)', border: '1px solid var(--line,#eee3d9)', borderRadius: 16,
  boxShadow: '0 1px 2px rgba(63,37,10,.06),0 6px 18px -6px rgba(63,37,10,.12)',
};
const btn: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', color: 'var(--ink-soft,#6d6259)',
  padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
  fontFamily: 'Kanit, sans-serif', cursor: 'pointer',
};
const soft = 'var(--ink-soft,#6d6259)';
const kanit = 'Kanit, sans-serif';
const dt = (v: string) => (v || '').replace('T', ' ').slice(0, 16);

const SopQueue: React.FC<{ onOpenPost?: (id: number) => void }> = ({ onOpenPost }) => {
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [fromV, setFromV] = useState<string>('latest');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const canApprove = ['supervisor', 'admin'].includes(authRole());

  const load = useCallback(async () => {
    try {
      const d = await fetch(`${apiUrl}/api/sop/queue`).then(r => r.json());
      setItems(Array.isArray(d.items) ? d.items : []);
    } catch { setItems([]); setMsg('❌ โหลดรายการไม่สำเร็จ'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadDiff = useCallback(async (id: number, from: string) => {
    setDiff(null);
    try {
      const q = from === 'latest' ? '' : `&from=${from}`;
      setDiff(await fetch(`${apiUrl}/api/sop/diff?id=${id}${q}`).then(r => r.json()));
    } catch { setMsg('❌ เทียบเวอร์ชันไม่สำเร็จ'); }
  }, []);
  useEffect(() => { if (open != null) loadDiff(open, fromV); }, [open, fromV, loadDiff]);

  const act = async (path: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await fetch(`${apiUrl}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(`❌ ${d.error || 'ทำรายการไม่สำเร็จ'}`); return; }
      setMsg(`✅ ${okMsg}`); setOpen(null); await load();
    } catch { setMsg('❌ ต่อเซิร์ฟเวอร์ไม่ได้'); } finally { setBusy(false); }
  };
  const approve = (it: Item) => {
    const note = window.prompt(`อนุมัติ "${it.title}"\nจะกลายเป็นเวอร์ชัน ${it.version + 1} และคนอ่านจะเห็นฉบับนี้\n\nโน้ต (ไม่ใส่ก็ได้):`, '');
    if (note === null) return;
    return act('/api/posts/approve', { id: it.id, note }, `อนุมัติ "${it.title}" แล้ว`);
  };
  const reject = (it: Item) => {
    const reason = window.prompt(`ตีกลับ "${it.title}" — เหตุผลจะถูกส่งเข้า Telegram ให้คนเขียนเห็น:`, '');
    if (reason === null) return;
    return act('/api/posts/reject', { id: it.id, reason }, `ตีกลับ "${it.title}" แล้ว`);
  };

  const waiting = (items || []).filter(i => i.state === 'review').length;

  return (
    <div style={{ fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{
        fontFamily: kanit, fontSize: 11.5, fontWeight: 600, color: '#0d47a1',
        background: '#e8f1fb', display: 'inline-flex', gap: 6, padding: '4px 12px', borderRadius: 999, marginBottom: 10,
      }}>📚 Knowledge management</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ fontFamily: kanit, fontSize: 'clamp(20px,2.6vw,25px)', fontWeight: 600, margin: 0, letterSpacing: '-.02em' }}>
          คู่มือรออนุมัติ
        </h1>
        <span style={{ fontSize: 13, color: soft }}>
          {items === null ? 'กำลังโหลด…' : waiting ? `${waiting} เรื่องรอตรวจ` : 'ไม่มีเรื่องรอตรวจ'}
        </span>
        <button onClick={load} style={{ ...btn, marginLeft: 'auto' }}>🔄 รีเฟรช</button>
      </div>
      <div style={{ fontSize: 12.5, color: soft, lineHeight: 1.7, marginBottom: 12 }}>
        คนอ่านเห็น <b>เฉพาะฉบับที่อนุมัติล่าสุด</b> เสมอ — ที่แก้ระหว่างวันยังไม่ออกไปจนกว่าจะกดอนุมัติ
      </div>
      {!canApprove && (
        <div style={{ ...card, borderColor: '#f0dcc8', background: '#fdf6ee', padding: '11px 14px', marginBottom: 12, fontSize: 13, lineHeight: 1.7 }}>
          ℹ️ คุณดูและเทียบเวอร์ชันได้ แต่การอนุมัติ/ตีกลับต้องเป็น <b>หัวหน้างาน</b> ขึ้นไป
        </div>
      )}
      {msg && <div style={{ fontSize: 12.5, marginBottom: 10, color: msg.startsWith('✅') ? '#1c8a4c' : '#c62828' }}>{msg}</div>}

      {items && items.length === 0 && (
        <div style={{ ...card, padding: 20, textAlign: 'center', color: soft, fontSize: 13, lineHeight: 1.8 }}>
          ✅ ไม่มีคู่มือที่ต้องตรวจตอนนี้
          <br /><span style={{ fontSize: 12 }}>ทุกเรื่องในหมวด “คู่มือ / SOP” ตรงกับฉบับที่อนุมัติไว้แล้ว</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(items || []).map(it => {
          const si = STATE_INFO[it.state];
          const on = open === it.id;
          return (
            <div key={it.id} style={{ ...card, padding: '13px 15px', borderColor: it.state === 'review' ? '#f2c4bc' : 'var(--line,#eee3d9)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontFamily: kanit, fontSize: 15, fontWeight: 600 }}>{it.title || '(ไม่มีชื่อ)'}</div>
                  <div style={{ fontSize: 11.5, color: soft, lineHeight: 1.7 }}>
                    {it.author && <>โดย {it.author} · </>}แก้ล่าสุด {dt(it.updatedAt)}
                    {it.version > 0
                      ? <><br />อนุมัติล่าสุด เวอร์ชัน {it.version}{it.approvedBy && <> โดย {it.approvedBy}</>} {dt(it.approvedAt)}</>
                      : <><br />ยังไม่เคยมีเวอร์ชันที่อนุมัติ</>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {(it.added > 0 || it.removed > 0) && (
                    <span style={{ fontSize: 12, fontWeight: 700 }}>
                      <span style={{ color: '#1c8a4c' }}>+{it.added}</span>{' '}
                      <span style={{ color: '#c62828' }}>−{it.removed}</span>
                    </span>
                  )}
                  <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '3px 10px', color: si.c, background: si.b }}>
                    {si.label}
                  </span>
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: soft, marginTop: 4 }}>{si.what}</div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                <button onClick={() => { setOpen(on ? null : it.id); setFromV('latest'); }} style={btn}>
                  {on ? '✕ ปิดการเทียบ' : '🔍 ดูว่าต่างตรงไหน'}
                </button>
                {onOpenPost && <button onClick={() => onOpenPost(it.id)} style={btn}>✍️ เปิดในตัวแก้ไข</button>}
                {canApprove && (
                  <>
                    <button onClick={() => approve(it)} disabled={busy}
                      style={{ ...btn, background: '#1c8a4c', borderColor: '#1c8a4c', color: '#fff' }}>✅ อนุมัติ</button>
                    <button onClick={() => reject(it)} disabled={busy}
                      style={{ ...btn, color: '#c62828', background: '#fdecea', borderColor: '#f7d9d5' }}>↩️ ตีกลับ</button>
                  </>
                )}
              </div>

              {on && (
                <div style={{ marginTop: 12, borderTop: '1px solid var(--line,#eee3d9)', paddingTop: 10 }}>
                  {!diff ? <div style={{ fontSize: 13, color: soft }}>กำลังเทียบ…</div> : (
                    <>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, fontSize: 12.5, color: soft }}>
                        <span>เทียบ</span>
                        <select value={fromV} onChange={e => setFromV(e.target.value)}
                          style={{ ...btn, fontFamily: 'inherit', padding: '5px 9px' }}>
                          <option value="latest">ฉบับอนุมัติล่าสุด{diff.left.version ? ` (เวอร์ชัน ${diff.left.version})` : ''}</option>
                          {diff.versions.map(v => <option key={v.version} value={String(v.version)}>เวอร์ชัน {v.version} · {dt(v.approvedAt)}</option>)}
                        </select>
                        <span>→ <b>{diff.right.label}</b></span>
                        <span style={{ marginLeft: 'auto', fontWeight: 700 }}>
                          <span style={{ color: '#1c8a4c' }}>+{diff.added}</span>{' '}
                          <span style={{ color: '#c62828' }}>−{diff.removed}</span>{' '}
                          <span style={{ color: soft, fontWeight: 500 }}>เหมือนเดิม {diff.same} บรรทัด</span>
                        </span>
                      </div>
                      {diff.left.title !== diff.right.title && (
                        <div style={{ fontSize: 12.5, marginBottom: 8, background: '#fffaf0', border: '1px solid #f0dcc0', borderRadius: 8, padding: '7px 10px' }}>
                          ชื่อเรื่องเปลี่ยน: <s style={{ color: '#c62828' }}>{diff.left.title || '(ว่าง)'}</s> → <b>{diff.right.title}</b>
                        </div>
                      )}
                      {diff.added === 0 && diff.removed === 0
                        ? <div style={{ fontSize: 13, color: soft }}>เนื้อหาเหมือนกันทุกบรรทัด (ต่างแค่สถานะ)</div>
                        : (
                          <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid var(--line,#eee3d9)', borderRadius: 10 }}>
                            {diff.lines.map((l, i) => (
                              <div key={i} style={{
                                display: 'flex', gap: 8, padding: '4px 10px', fontSize: 12.5, lineHeight: 1.7,
                                fontFamily: 'Sarabun, sans-serif', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                background: l.t === 'add' ? '#eaf6ee' : l.t === 'del' ? '#fdecea' : 'transparent',
                                color: l.t === 'del' ? '#8a2b23' : l.t === 'add' ? '#175c33' : 'var(--ink,#2b2119)',
                                borderTop: i ? '1px solid #f6efe8' : 'none',
                              }}>
                                <span style={{ flex: 'none', width: 14, fontWeight: 700, color: l.t === 'add' ? '#1c8a4c' : l.t === 'del' ? '#c62828' : '#d8d0c8' }}>
                                  {l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}
                                </span>
                                <span style={{ flex: 1 }}>{l.text || ' '}</span>
                              </div>
                            ))}
                          </div>
                        )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SopQueue;
