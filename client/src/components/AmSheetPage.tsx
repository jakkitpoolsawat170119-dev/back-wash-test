import React, { useCallback, useEffect, useRef, useState } from 'react';
import { wakeFetch, wakeMessage, type WakeState } from '../lib/wakeFetch';
import { uploadDutyImage, resizePhoto } from '../lib/dutyImages';
import { apiUrl } from '../lib/api';
import '../amsheet.css';

/* ใบเช็ก AM รายกะ — หน้าสาธารณะเปิดจากลิงก์ใน Telegram บนมือถือ
   mount เหนือ <App/> ที่ main.tsx (แบบเดียวกับ ?verify=) เพื่อข้าม Splash + เลือกผู้ปฏิบัติงาน
   + AdminGate PIN และข้าม filter:invert(1) ของโหมดมืด ที่จะกลับสีรูปถ่ายของช่าง

   1 ใบ = 1 Line ต้ม × 1 กะ × 1 วันทำงาน — ข้อตรวจยกมาจากทะเบียนงานรูทีน (sheet='am')
   ต่างจากกระดานเวรตรงที่บันทึก "ผลตรวจ" ไม่ใช่แค่ "ทำแล้ว"                                  */

type Result = 'ok' | 'ng' | null;
type Item = {
  seq: number; nodeKey: string; routineId: number;
  title: string; goal: string; method: string;
  result: Result; cause: string; hasPhoto: boolean; photoUrl: string | null;
  checkedBy: string; updatedAt: string;
};
type Sheet = {
  id: number; workDay: string; shift: string; line: string;
  lineStatus: string; status: 'draft' | 'submitted'; submittedBy: string; submittedAt: string;
};
type Summary = { total: number; ok: number; ng: number; left: number };
type Data = { sheet: Sheet; shifts: string[]; items: Item[]; summary: Summary; holiday?: boolean };

const LINE_STATUS = [
  { key: 'inprocess', cls: 'run', label: 'Inprocess' },
  { key: 'cip', cls: 'cip', label: 'CIP' },
  { key: 'idle', cls: 'idle', label: 'ว่าง' },
] as const;

const lineCls = (line: string) => (line.includes('2') ? 'l2' : line.includes('3') ? 'l3' : '');
const thaiDay = (d: string) => {
  try {
    return new Date(`${d}T12:00:00Z`).toLocaleDateString('th-TH',
      { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return d; }
};

/* ══ คอมโพเนนต์ย่อย — ต้องอยู่ module scope ทั้งหมด ══
   นิยามไว้ข้างใน AmSheetPage เมื่อไหร่ ทุก re-render ของตัวแม่ (เช่นตอนบันทึกผลสำเร็จ)
   React จะถือว่าเป็นคอมโพเนนต์คนละตัว → unmount → สาเหตุที่ช่างพิมพ์ค้างไว้หายเกลี้ยง */

const ProgressBar: React.FC<{ s: Summary }> = ({ s }) => {
  const pct = (n: number) => (s.total ? `${(n / s.total) * 100}%` : '0%');
  return (
    <>
      <div className="prog">
        <span className="ok">✅ ปกติ {s.ok}</span>
        <span className="ng">⚠️ ไม่ปกติ {s.ng}</span>
        <span className="left">ยังไม่ตรวจ {s.left}</span>
      </div>
      <div className="bar" aria-hidden="true">
        <i className="bok" style={{ width: pct(s.ok) }} />
        <i className="bng" style={{ width: pct(s.ng) }} />
      </div>
    </>
  );
};

const ItemCard: React.FC<{
  it: Item; locked: boolean; busy: boolean;
  onJudge: (it: Item, r: Result) => void;
  onCause: (nodeKey: string, cause: string) => void;
  onCauseCommit: (it: Item) => void;
  onPhoto: (it: Item, file: File) => void;
}> = ({ it, locked, busy, onJudge, onCause, onCauseCommit, onPhoto }) => {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <article className={`it ${it.result || ''}`}>
      <div className="ithead">
        <span className="seq">{it.seq}</span>
        <h3 className="ittitle">{it.title}</h3>
      </div>
      {(it.goal || it.method) && (
        <>
          <button className="more" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? 'ซ่อนเกณฑ์ ▴' : 'ดูเกณฑ์ ▾'}
          </button>
          {open && (
            <div className="crit">
              {it.goal && <div><b>มาตรฐาน</b> — {it.goal}</div>}
              {it.method && <div><b>วิธีตรวจ</b> — {it.method}</div>}
            </div>
          )}
        </>
      )}
      <div className="judge">
        <button className={`jb good${it.result === 'ok' ? ' on' : ''}`} disabled={locked || busy}
          onClick={() => onJudge(it, it.result === 'ok' ? null : 'ok')}>ปกติ</button>
        <button className={`jb bad${it.result === 'ng' ? ' on' : ''}`} disabled={locked || busy}
          onClick={() => onJudge(it, it.result === 'ng' ? null : 'ng')}>ไม่ปกติ</button>
      </div>
      {it.result === 'ng' && (
        <div className="ngbox">
          <div className="lbl">สาเหตุ / สิ่งที่พบ <span style={{ color: 'var(--danger)' }}>*จำเป็น</span></div>
          <textarea rows={2} value={it.cause} disabled={locked}
            placeholder="เห็นอะไร วัดได้เท่าไหร่"
            onChange={e => onCause(it.nodeKey, e.target.value)}
            onBlur={() => onCauseCommit(it)} />
          <div className="shot">
            {it.photoUrl && <img src={it.photoUrl} alt={`รูป ${it.title}`} />}
            {it.hasPhoto && !it.photoUrl && <span style={{ fontSize: 12, color: 'var(--muted)' }}>📷 มีรูปแนบแล้ว</span>}
            {!locked && (
              <button className="camera" onClick={() => fileRef.current?.click()} disabled={busy}>
                📷 {it.hasPhoto ? 'เปลี่ยนรูป' : 'แนบรูป'}
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) onPhoto(it, f); e.target.value = ''; }} />
          </div>
        </div>
      )}
    </article>
  );
};

const NameGate: React.FC<{ onDone: (n: string) => void }> = ({ onDone }) => {
  const [v, setV] = useState('');
  return (
    <div className="namebox">
      <div className="lbl">ก่อนเริ่ม — คุณชื่ออะไรครับ</div>
      <input value={v} onChange={e => setV(e.target.value)} placeholder="ชื่อผู้ตรวจ" autoFocus
        onKeyDown={e => { if (e.key === 'Enter' && v.trim()) onDone(v.trim()); }} />
      <button className="send" disabled={!v.trim()} onClick={() => onDone(v.trim())}>เริ่มตรวจ</button>
      <div className="saved">ถามครั้งเดียว เครื่องนี้จะจำไว้ให้</div>
    </div>
  );
};

/* ══ ตัวแม่ ══ */

const AmSheetPage: React.FC<{ token: string }> = ({ token }) => {
  const [by, setBy] = useState(() => { try { return localStorage.getItem('am_by') || ''; } catch { return ''; } });
  const [data, setData] = useState<Data | null>(null);
  const [shift, setShift] = useState<string>('');
  const [wake, setWake] = useState<WakeState>('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [fatal, setFatal] = useState('');

  const api = useCallback((path: string, init?: RequestInit) =>
    wakeFetch(`${apiUrl}${path}`, { ...init, onState: setWake, retries: 3, timeoutMs: 25000 }), []);

  // โหลดครั้งแรกจาก token — เซิร์ฟเวอร์หาวันทำงาน+กะปัจจุบันให้เอง
  const loadByToken = useCallback(async () => {
    const r = await api(`/api/am-sheet/open/${encodeURIComponent(token)}`);
    const d = await r.json();
    if (!r.ok) { setFatal(d?.error || 'เปิดใบไม่สำเร็จ'); return; }
    setData(d); setShift(d.sheet.shift);
  }, [api, token]);

  // เปลี่ยนกะเอง (ช่างเปิดย้อนดูกะที่แล้วได้)
  const loadShift = useCallback(async (sh: string, line: string, day: string) => {
    const q = new URLSearchParams({ date: day, shift: sh, line });
    const r = await api(`/api/am-sheet?${q}`);
    const d = await r.json();
    if (!r.ok) { setMsg({ kind: 'err', text: d?.error || 'โหลดกะนี้ไม่สำเร็จ' }); return; }
    setData(d); setShift(sh);
  }, [api]);

  useEffect(() => { loadByToken().catch(() => setFatal('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ลองใหม่อีกครั้ง')); }, [loadByToken]);

  const locked = data?.sheet.status === 'submitted';
  const arg = data ? { date: data.sheet.workDay, shift: data.sheet.shift, line: data.sheet.line, by } : null;

  const post = async (path: string, body: unknown) => {
    const r = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || 'บันทึกไม่สำเร็จ');
    return d;
  };

  // แก้ในหน้าไว้ก่อน แล้วค่อยยิงเซิร์ฟเวอร์ — ปุ่มต้องตอบสนองทันทีบนเน็ตโรงงาน
  const patchItem = (nodeKey: string, patch: Partial<Item>) =>
    setData(d => (d ? { ...d, items: d.items.map(i => (i.nodeKey === nodeKey ? { ...i, ...patch } : i)) } : d));

  const recount = (items: Item[]): Summary => {
    const ok = items.filter(i => i.result === 'ok').length;
    const ng = items.filter(i => i.result === 'ng').length;
    return { total: items.length, ok, ng, left: items.length - ok - ng };
  };

  const saveItem = async (nodeKey: string, body: Record<string, unknown>) => {
    if (!arg) return;
    try {
      const d = await post('/api/am-sheet/item', { ...arg, nodeKey, ...body });
      if (d.summary) setData(x => (x ? { ...x, summary: d.summary } : x));
      setSavedAt(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }));
      setMsg(null);
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const judge = async (it: Item, r: Result) => {
    patchItem(it.nodeKey, { result: r, ...(r === 'ng' ? {} : { cause: '', hasPhoto: false, photoUrl: null }) });
    setData(d => (d ? { ...d, summary: recount(d.items.map(i => (i.nodeKey === it.nodeKey ? { ...i, result: r } : i))) } : d));
    // "ไม่ปกติ" ยังไม่ยิงจนกว่าจะมีสาเหตุ — เซิร์ฟเวอร์บังคับ ยิงไปก็โดนปฏิเสธ
    if (r === 'ng') return;
    await saveItem(it.nodeKey, { result: r });
  };

  const commitCause = async (it: Item) => {
    if (it.result !== 'ng' || !it.cause.trim()) return;
    await saveItem(it.nodeKey, { result: 'ng', cause: it.cause.trim(), photo: it.photoUrl || '' });
  };

  const attach = async (it: Item, file: File) => {
    setBusy(true);
    try {
      const url = await uploadDutyImage((await resizePhoto(file)).preview);
      if (!url.startsWith('http')) { setMsg({ kind: 'err', text: 'อัปโหลดรูปไม่สำเร็จ — ลองใหม่อีกครั้ง' }); return; }
      patchItem(it.nodeKey, { photoUrl: url, hasPhoto: true });
      if (it.cause.trim()) await saveItem(it.nodeKey, { result: 'ng', cause: it.cause.trim(), photo: url });
    } catch { setMsg({ kind: 'err', text: 'อ่านรูปไม่สำเร็จ' }); } finally { setBusy(false); }
  };

  const setLineStatus = async (st: string) => {
    if (!arg) return;
    setData(d => (d ? { ...d, sheet: { ...d.sheet, lineStatus: st } } : d));
    try { await post('/api/am-sheet/line-status', { ...arg, status: st }); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const submit = async () => {
    if (!arg || !data) return;
    const missingCause = data.items.filter(i => i.result === 'ng' && !i.cause.trim());
    if (missingCause.length) {
      setMsg({ kind: 'err', text: `ข้อที่ไม่ปกติต้องกรอกสาเหตุให้ครบก่อน (เหลือ ${missingCause.length} ข้อ)` });
      return;
    }
    setBusy(true);
    try {
      const d = await post('/api/am-sheet/submit', arg);
      setData(x => (x ? { ...x, ...d, sheet: d.sheet || x.sheet } : x));
      const parts = ['ส่งรายงานเข้ากลุ่มช่างแล้ว'];
      if (d.opened?.length) parts.push(`เปิดใบแจ้งซ่อมใหม่ ${d.opened.length} ใบ`);
      if (d.repeated?.length) parts.push(`เจอซ้ำ ต่อในใบเดิม ${d.repeated.length} ใบ`);
      setMsg({ kind: 'ok', text: '✅ ' + parts.join(' · ') });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (fatal) return <div className="amx"><div className="center">😕<br />{fatal}</div></div>;
  if (!by) {
    return (
      <div className="amx">
        <NameGate onDone={n => { try { localStorage.setItem('am_by', n); } catch { /* โหมดส่วนตัว */ } setBy(n); }} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="amx">
        <div className="center">
          {wake === 'waking' ? wakeMessage('waking') : 'กำลังเปิดใบเช็ก…'}
        </div>
      </div>
    );
  }

  const s = data.summary;
  return (
    <div className="amx">
      <header className="top">
        <span className={`linepill ${lineCls(data.sheet.line)}`}>📋 {data.sheet.line}</span>
        <div className="topmeta">
          <span>{thaiDay(data.sheet.workDay)}</span>
          <span>·</span>
          <span>กะ{data.sheet.shift}</span>
          <button className="who" onClick={() => { try { localStorage.removeItem('am_by'); } catch { /* ok */ } setBy(''); }}>
            👤 {by}
          </button>
        </div>
      </header>

      {wake === 'waking' && <div className="msg wake">{wakeMessage('waking')}</div>}
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      {locked ? (
        <div className="done">
          <h2>✅ ส่งรายงานแล้ว</h2>
          <p>
            กะ{data.sheet.shift} · {thaiDay(data.sheet.workDay)}<br />
            โดย {data.sheet.submittedBy || by}<br />
            ปกติ {s.ok} · ไม่ปกติ {s.ng} · รวม {s.total} ข้อ
          </p>
        </div>
      ) : (
        <>
          {data.shifts.length > 1 && (
            <div className="sec">
              <div className="lbl">กะ</div>
              <div className="row">
                {data.shifts.map(sh => (
                  <button key={sh} className={`shiftbtn${shift === sh ? ' on' : ''}`}
                    onClick={() => loadShift(sh, data.sheet.line, data.sheet.workDay)}>{sh}</button>
                ))}
              </div>
            </div>
          )}

          <div className="sec">
            <div className="lbl">สถานะไลน์ตอนนี้</div>
            <div className="row">
              {LINE_STATUS.map(st => (
                <button key={st.key} className={`stbtn ${st.cls}${data.sheet.lineStatus === st.key ? ' on' : ''}`}
                  onClick={() => setLineStatus(st.key)}>{st.label}</button>
              ))}
            </div>
            <div className="hint">บันทึกไว้เท่านั้น — ไม่ซ่อนข้อตรวจ</div>
          </div>
        </>
      )}

      <ProgressBar s={s} />

      <div className="items">
        {data.items.map(it => (
          <ItemCard key={it.nodeKey} it={it} locked={!!locked} busy={busy}
            onJudge={judge} onCause={(k, c) => patchItem(k, { cause: c })}
            onCauseCommit={commitCause} onPhoto={attach} />
        ))}
      </div>

      {!locked && (
        <div className="foot">
          <button className="send" disabled={busy || s.left > 0} onClick={submit}>
            {busy ? 'กำลังส่ง…' : s.left > 0 ? `ยังเหลืออีก ${s.left} ข้อ` : 'ส่งรายงานเข้ากลุ่ม'}
          </button>
          <div className="saved">{savedAt ? `บันทึกอัตโนมัติแล้ว ${savedAt} น.` : 'บันทึกอัตโนมัติทุกครั้งที่แตะ'}</div>
        </div>
      )}
    </div>
  );
};

export default AmSheetPage;
