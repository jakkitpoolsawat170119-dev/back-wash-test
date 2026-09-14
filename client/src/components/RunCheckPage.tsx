/* เช็กลิสต์เดินเครื่อง — หน้าสาธารณะเปิดจากลิงก์ที่ปักหมุดในกลุ่ม (/?runcheck=<token>)
   mount เหนือ <App/> ที่ main.tsx (แบบเดียวกับ ?amsheet=) เพื่อข้าม Splash + เลือกผู้ปฏิบัติงาน
   + AdminGate PIN และข้าม filter:invert(1) ของโหมดมืด ที่จะกลับสีรูปถ่าย

   1 ใบ = 1 รอบเดินเครื่อง × 1 จังหวะ · ข้อในใบมาจากกฎเตือนที่เข้าเงื่อนไขของรอบนั้น
   token ผูกกับ "เครื่อง" ไม่ใช่รอบ — ลิงก์เดียวปักหมุดไว้ได้ตลอด เซิร์ฟเวอร์หารอบของวันให้เอง

   ⚠️ คอมโพเนนต์ย่อยอยู่ module scope ทั้งหมด — นิยามข้างในตัวแม่เมื่อไหร่ ทุก re-render
      React จะถือว่าเป็นคอมโพเนนต์คนละตัว → unmount → สาเหตุที่พิมพ์ค้างไว้หายเกลี้ยง       */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { wakeFetch, wakeMessage, type WakeState } from '../lib/wakeFetch';
import { uploadDutyImage, resizePhoto } from '../lib/dutyImages';
import { apiUrl } from '../lib/api';
import '../runcheck.css';

type Result = 'ok' | 'ng' | null;
type Item = {
  itemKey: string; ruleId: number; title: string; detail: string;
  needPhoto: boolean; needQc: boolean;
  result: Result; cause: string; hasPhoto: boolean; photoUrl: string | null;
  checkedBy: string; qcBy: string; updatedAt: string;
};
type Run = {
  id: number; workDay: string; shift: string;
  packerName: string; packerKey: string; packerLabel: string;
  lineName: string; lineLabel: string; flavor: string; targetBoxes: number | null; status: string;
};
type Timing = { key: string; label: string; nItems: number; status: string };
type Check = { id: number; status: string; submittedBy: string; submittedAt: string } | null;
type Summary = { total: number; ok: number; ng: number; left: number };
type Data = {
  token: string; machineName: string; machineLabel: string; workDay: string;
  runs: Run[]; run: Run | null; timing: string; timings: Timing[];
  check: Check; items: Item[]; summary: Summary; readonly: boolean; ruleCount: number;
  empty?: string;
};

const TIMING_ICON: Record<string, string> = { start: '⏱', during: '⚙️', end: '🏁' };
const TIMING_SHORT: Record<string, string> = { start: 'ก่อนเริ่ม', during: 'ระหว่างเดิน', end: 'หลังจบ' };

const thaiDay = (d: string) => {
  try {
    return new Date(`${d}T12:00:00Z`).toLocaleDateString('th-TH',
      { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return d; }
};

/* ── การ์ดข้อตรวจ 1 ข้อ ─────────────────────────────────────── */
const ItemCard: React.FC<{
  it: Item; locked: boolean; busy: boolean;
  onJudge: (it: Item, r: Result) => void;
  onPatch: (key: string, patch: Partial<Item>) => void;
  onCommit: (it: Item) => void;
  onPhoto: (it: Item, file: File) => void;
}> = ({ it, locked, busy, onJudge, onPatch, onCommit, onPhoto }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  // กฎสั่งให้ตรวจร่วม QC = ต้องมีชื่อ QC ก่อนถึงจะติ๊กได้ (เซิร์ฟเวอร์บังคับซ้ำอีกชั้น)
  const qcMissing = it.needQc && !it.qcBy.trim();
  const showPhoto = it.needPhoto || it.result === 'ng';
  return (
    <article className={`it ${it.result || ''}`}>
      <div className="t">{it.title}</div>
      {it.detail && <div className="d">{it.detail}</div>}
      {(it.needPhoto || it.needQc) && (
        <div className="tags">
          {it.needPhoto && <span className="tag">📷 ต้องแนบรูป</span>}
          {it.needQc && <span className="tag">🧪 ต้องมี QC ร่วม</span>}
        </div>
      )}

      {it.needQc && !locked && (
        <div className="qcbox">
          <div className="lbl">🧪 QC ที่ตรวจร่วม {qcMissing && <span style={{ color: 'var(--danger)' }}>*จำเป็น</span>}</div>
          <input value={it.qcBy} placeholder="ชื่อ QC ที่ตรวจด้วยกัน"
            onChange={e => onPatch(it.itemKey, { qcBy: e.target.value })}
            onBlur={() => onCommit(it)} />
        </div>
      )}

      <div className="judge">
        <button className={`jb good${it.result === 'ok' ? ' on' : ''}`} disabled={locked || busy || qcMissing}
          onClick={() => onJudge(it, it.result === 'ok' ? null : 'ok')}>ปกติ</button>
        <button className={`jb bad${it.result === 'ng' ? ' on' : ''}`} disabled={locked || busy || qcMissing}
          onClick={() => onJudge(it, it.result === 'ng' ? null : 'ng')}>ไม่ปกติ</button>
      </div>
      {qcMissing && !locked && (
        <div className="infobox" style={{ marginTop: 9 }}>ใส่ชื่อ QC ก่อน ถึงจะติ๊กข้อนี้ได้</div>
      )}

      {it.result === 'ng' && (
        <div className="ngbox">
          <div className="lbl">สาเหตุ / สิ่งที่พบ <span style={{ color: 'var(--danger)' }}>*จำเป็น</span></div>
          <textarea rows={2} value={it.cause} disabled={locked}
            placeholder="เห็นอะไร วัดได้เท่าไหร่"
            onChange={e => onPatch(it.itemKey, { cause: e.target.value })}
            onBlur={() => onCommit(it)} />
        </div>
      )}

      {showPhoto && (
        <div className="shot">
          {it.photoUrl && <img src={it.photoUrl} alt={`รูป ${it.title}`} />}
          {it.hasPhoto && !it.photoUrl && <span style={{ fontSize: 12, color: 'var(--muted)' }}>📷 มีรูปแนบแล้ว</span>}
          {!locked && (
            <button className={`camera${it.needPhoto && !it.hasPhoto ? ' need' : ''}`}
              onClick={() => fileRef.current?.click()} disabled={busy}>
              📷 {it.hasPhoto ? 'เปลี่ยนรูป' : 'แนบรูป'}
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) onPhoto(it, f); e.target.value = ''; }} />
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
const RunCheckPage: React.FC<{ token: string }> = ({ token }) => {
  // ใช้คีย์เดียวกับใบเช็ก AM — คนเดิมเครื่องเดิม ไม่ต้องถามชื่อซ้ำอีกใบ
  const [by, setBy] = useState(() => { try { return localStorage.getItem('am_by') || ''; } catch { return ''; } });
  const [data, setData] = useState<Data | null>(null);
  const [wake, setWake] = useState<WakeState>('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [fatal, setFatal] = useState('');

  const api = useCallback((path: string, init?: RequestInit) =>
    wakeFetch(`${apiUrl}${path}`, { ...init, onState: setWake, retries: 3, timeoutMs: 25000 }), []);

  const load = useCallback(async (runId?: number, timing?: string) => {
    const q = new URLSearchParams();
    if (runId) q.set('runId', String(runId));
    if (timing) q.set('timing', timing);
    const r = await api(`/api/run-check/open/${encodeURIComponent(token)}${q.toString() ? `?${q}` : ''}`);
    const d = await r.json();
    if (!r.ok) { setFatal(d?.error || 'เปิดใบไม่สำเร็จ'); return; }
    setData(d); setMsg(null);
  }, [api, token]);

  /* ลิงก์ที่ปักหมุดในกลุ่มเป็น token เปล่า — เซิร์ฟเวอร์เลือกรอบของกะปัจจุบันให้เอง
     ส่วนลิงก์ที่กดมาจากหน้า Admin จะพ่วง runId/timing มาด้วย เพื่อเปิดใบที่กดตรงตัว */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const rid = Number(q.get('runId') || 0) || undefined;
    load(rid, q.get('timing') || undefined)
      .catch(() => setFatal('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ลองใหม่อีกครั้ง'));
  }, [load]);

  const locked = data?.check?.status === 'submitted';

  const post = async (path: string, body: unknown) => {
    const r = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || 'บันทึกไม่สำเร็จ');
    return d;
  };

  // แก้ในหน้าไว้ก่อนแล้วค่อยยิงเซิร์ฟเวอร์ — ปุ่มต้องตอบสนองทันทีบนเน็ตโรงงาน
  const patch = (key: string, p: Partial<Item>) =>
    setData(d => (d ? { ...d, items: d.items.map(i => (i.itemKey === key ? { ...i, ...p } : i)) } : d));

  const recount = (items: Item[]): Summary => {
    const ok = items.filter(i => i.result === 'ok').length;
    const ng = items.filter(i => i.result === 'ng').length;
    return { total: items.length, ok, ng, left: items.length - ok - ng };
  };

  const saveItem = async (it: Item, over: Partial<Item>) => {
    if (!data?.check) return;
    const next = { ...it, ...over };
    try {
      const d = await post('/api/run-check/item', {
        checkId: data.check.id, itemKey: it.itemKey, by,
        result: next.result, cause: next.cause, qcBy: next.qcBy, photo: next.photoUrl || '',
      });
      if (d.summary) setData(x => (x ? { ...x, summary: d.summary } : x));
      setSavedAt(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }));
      setMsg(null);
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const judge = async (it: Item, r: Result) => {
    // เปลี่ยนกลับเป็น "ปกติ"/ยังไม่ตรวจ ต้องล้างสาเหตุทิ้ง ไม่งั้นเหลือสาเหตุค้างบนข้อที่บอกว่าปกติ
    const over: Partial<Item> = { result: r, ...(r === 'ng' ? {} : { cause: '' }) };
    patch(it.itemKey, over);
    setData(d => (d ? { ...d, summary: recount(d.items.map(i => (i.itemKey === it.itemKey ? { ...i, ...over } : i))) } : d));
    // "ไม่ปกติ" ยังไม่ยิงจนกว่าจะมีสาเหตุ — เซิร์ฟเวอร์บังคับ ยิงไปก็โดนปฏิเสธ
    if (r === 'ng') return;
    await saveItem(it, over);
  };

  const commit = async (it: Item) => {
    if (!it.result) return;                                  // ยังไม่ติ๊ก = ยังไม่มีอะไรให้บันทึก
    if (it.result === 'ng' && !it.cause.trim()) return;
    if (it.needQc && !it.qcBy.trim()) return;
    await saveItem(it, {});
  };

  const attach = async (it: Item, file: File) => {
    setBusy(true);
    try {
      const url = await uploadDutyImage((await resizePhoto(file)).preview);
      if (!url.startsWith('http')) { setMsg({ kind: 'err', text: 'อัปโหลดรูปไม่สำเร็จ — ลองใหม่อีกครั้ง' }); return; }
      patch(it.itemKey, { photoUrl: url, hasPhoto: true });
      // ยังไม่ติ๊กก็ยังไม่ยิง — เก็บรูปไว้ในหน้า แล้วส่งไปพร้อมตอนติ๊กครั้งแรก
      if (it.result && !(it.result === 'ng' && !it.cause.trim())) await saveItem(it, { photoUrl: url, hasPhoto: true });
    } catch { setMsg({ kind: 'err', text: 'อ่านรูปไม่สำเร็จ' }); } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!data?.check) return;
    const noCause = data.items.filter(i => i.result === 'ng' && !i.cause.trim());
    if (noCause.length) {
      setMsg({ kind: 'err', text: `ข้อที่ไม่ปกติต้องกรอกสาเหตุให้ครบก่อน (เหลือ ${noCause.length} ข้อ)` });
      return;
    }
    const noPhoto = data.items.filter(i => i.needPhoto && !i.hasPhoto);
    if (noPhoto.length && !window.confirm(`ยังไม่ได้แนบรูป ${noPhoto.length} ข้อที่กฎบอกว่าต้องแนบ\nส่งใบเลยไหม`)) return;
    setBusy(true);
    try {
      const d = await post('/api/run-check/submit', { checkId: data.check.id, by });
      setData(x => (x ? { ...x, check: d.check, summary: d.summary } : x));
      /* ข้อที่ไม่ปกติเปิดใบแจ้งซ่อมให้เอง — คนส่งใบต้องเห็นเลขใบตรงนี้เลย
         ไม่งั้นไม่มีทางรู้ว่าเรื่องวิ่งต่อไปหาช่างแล้วหรือยัง (การ์ดไปโผล่ในกลุ่ม ไม่ใช่ในหน้านี้) */
      const ids = (l: { id: number }[]) => l.map(x => `#${x.id}`).join(' ');
      const more = [
        d.opened?.length ? `🆘 เปิดใบแจ้งซ่อม ${d.opened.length} ใบ ${ids(d.opened)}` : '',
        d.repeated?.length ? `🔁 เจอซ้ำ ต่อในใบเดิม ${ids(d.repeated)}` : '',
      ].filter(Boolean).join(' · ');
      setMsg({ kind: 'ok', text: `✅ ส่งใบแล้ว · ปกติ ${d.summary.ok} · ไม่ปกติ ${d.summary.ng}${more ? ` · ${more}` : ''}` });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (fatal) return <div className="rcx"><div className="center">😕<br />{fatal}</div></div>;
  if (!by) {
    return (
      <div className="rcx">
        <NameGate onDone={n => { try { localStorage.setItem('am_by', n); } catch { /* โหมดส่วนตัว */ } setBy(n); }} />
      </div>
    );
  }
  if (!data) {
    return <div className="rcx"><div className="center">{wake === 'waking' ? wakeMessage('waking') : 'กำลังเปิดเช็กลิสต์…'}</div></div>;
  }

  const run = data.run;
  const s = data.summary;
  return (
    <div className="rcx">
      <header className={`top${data.timing === 'end' ? ' end' : ''}`}>
        <div className="eyebrow">SPP · เช็กลิสต์เดินเครื่อง</div>
        <h1>{data.machineLabel}</h1>
        {run ? (
          <>
            <div className="meta">{thaiDay(run.workDay)} · {run.shift} · {run.flavor}</div>
            <div className="meta">
              {run.lineLabel ? `ป้อนจาก ${run.lineLabel}` : '⚠️ ยังไม่ได้เลือกไลน์ต้นทางของรอบนี้'}
              {data.timing ? ` · ${TIMING_ICON[data.timing] || ''} ${TIMING_SHORT[data.timing] || ''}` : ''}
            </div>
          </>
        ) : <div className="meta">{thaiDay(data.workDay)}</div>}
        <button className="who" onClick={() => { try { localStorage.removeItem('am_by'); } catch { /* ok */ } setBy(''); }}>
          👤 {by}
        </button>
      </header>

      <div className="body">
        {wake === 'waking' && <div className="msg wake">{wakeMessage('waking')}</div>}
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

        {data.empty && <div className="infobox">{data.empty}</div>}

        {/* เครื่องเดียวเดินได้หลายรอบในวันเดียว (คนละกะ/คนละสินค้า) — ให้เลือกก่อนว่าใบของรอบไหน */}
        {data.runs.length > 1 && (
          <>
            <div className="lbl">รอบเดินเครื่องวันนี้</div>
            <div className="seg" style={{ flexWrap: 'wrap' }}>
              {data.runs.map(r => (
                <button key={r.id} className={`segbtn${run?.id === r.id ? ' on' : ''}`}
                  onClick={() => load(r.id, undefined)}>
                  {r.shift} · {r.flavor.slice(0, 14)}
                </button>
              ))}
            </div>
          </>
        )}

        {data.timings.length > 1 && (
          <div className="seg">
            {data.timings.map(t => (
              <button key={t.key} className={`segbtn${data.timing === t.key ? ' on' : ''}${t.status === 'submitted' ? ' done' : ''}`}
                onClick={() => load(run?.id, t.key)}>
                {TIMING_ICON[t.key]} {TIMING_SHORT[t.key]}
                {t.status === 'submitted' ? ' ✓' : <span className="n">{t.nItems}</span>}
              </button>
            ))}
          </div>
        )}

        {locked ? (
          <div className="done">
            <h2>✅ ส่งใบแล้ว</h2>
            <p>
              {TIMING_SHORT[data.timing]} · {run ? `${run.shift} · ${thaiDay(run.workDay)}` : ''}<br />
              โดย {data.check?.submittedBy || by}<br />
              ปกติ {s.ok} · ไม่ปกติ {s.ng} · รวม {s.total} ข้อ
            </p>
          </div>
        ) : !data.items.length ? (
          <div className="infobox">
            {data.readonly
              ? 'รอบนี้เป็นของวันก่อนหน้า — ดูได้อย่างเดียว ไม่มีใบเช็กที่บันทึกไว้'
              : 'ยังไม่มีกฎเตือนที่เข้ากับรอบนี้ — ไม่มีข้อให้ตรวจ (ตั้งกฎได้ที่หน้าทะเบียนเครื่องจักร → กฎเตือน)'}
          </div>
        ) : (
          <>
            <div className="progrow">
              <div className="prog">
                <i className="bok" style={{ width: s.total ? `${(s.ok / s.total) * 100}%` : 0 }} />
                <i className="bng" style={{ width: s.total ? `${(s.ng / s.total) * 100}%` : 0 }} />
              </div>
              <div className="progn">{s.ok + s.ng}/{s.total}</div>
            </div>

            <div className="items">
              {data.items.map(it => (
                <ItemCard key={it.itemKey} it={it} locked={!!locked || data.readonly} busy={busy}
                  onJudge={judge} onPatch={patch} onCommit={commit} onPhoto={attach} />
              ))}
            </div>

            <div className="infobox" style={{ marginTop: 12 }}>
              เลือก “ไม่ปกติ” ต้องกรอกสาเหตุ — ข้อที่ไม่ปกติจะถูกส่งต่อให้ทีมช่างตามไปดู
            </div>
          </>
        )}
      </div>

      {!locked && !data.readonly && !!data.items.length && (
        <div className="foot">
          <button className="send" disabled={busy || s.left > 0} onClick={submit}>
            {busy ? 'กำลังส่ง…' : s.left > 0 ? `ยังเหลืออีก ${s.left} ข้อ` : '📤 ส่งใบเช็ก'}
          </button>
          <div className="saved">{savedAt ? `บันทึกอัตโนมัติแล้ว ${savedAt} น.` : 'บันทึกอัตโนมัติทุกครั้งที่แตะ'}</div>
        </div>
      )}
    </div>
  );
};

export default RunCheckPage;
