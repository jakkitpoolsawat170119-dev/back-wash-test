import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadDutyImage, resizePhoto } from '../lib/dutyImages';
import { wakeFetch, wakeMessage, type WakeState } from '../lib/wakeFetch';
import { apiUrl } from '../lib/api';
import '../incidents.css';

/* เหตุการณ์ — ตาราง incidents ทำ 2 บทบาทพร้อมกัน หน้านี้จึงแยกเป็น 2 แท็บให้คนละคนใช้คนละงาน
     🔧 คิวงานซ่อม   = ใบที่ยังไม่ปิด เรียงตามความเร่งด่วนแบบเดียวกับกระดานในบอท
     📚 คลังความรู้  = ใบที่ปิดแล้ว จัดกลุ่มตามเครื่องจักร ไว้ค้นว่า "เครื่องนี้เคยเป็นแบบนี้ไหม"
   ทุกครั้งที่บันทึก เซิร์ฟเวอร์เขียนโน้ต .md ลงโฟลเดอร์ "เหตุการณ์" ใน vault ให้ด้วย
   และเด้งแก้การ์ดใบงานในกลุ่ม Telegram ให้เอง (ฟิลด์ card ใน response บอกว่าสำเร็จไหม) */

const todayBKK = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
// เวลาปัจจุบันแบบไทยในรูปแบบที่ <input type="datetime-local"> รับได้
const nowLocal = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);
const hhmm = (min: number) => (Math.floor(min / 60) ? `${Math.floor(min / 60)} ชม. ` : '') + `${min % 60} น.`;
// นาทีที่เสีย — คิดบน wall clock เหมือนฝั่งเซิร์ฟเวอร์ (ใส่ Z เข้า-ออก) ไม่พึ่ง timezone ของเครื่อง
const minsBetween = (a: string, b: string) => {
  if (!a || !b) return null;
  const m = Math.round((Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000);
  return Number.isFinite(m) && m >= 0 ? m : null;
};

type Prio = '' | 'stop' | 'warn' | 'low';
type Status = 'open' | 'wip' | 'closed';
type Source = '' | 'web' | 'bot' | 'ai' | 'amsheet';

type Incident = {
  id: number; title: string; machine: string; line: string; batchId: string; operator: string;
  occurredAt: string; symptom: string; cause: string; fix: string; result: string;
  images: string[]; resultImages: string[];
  // เวลาเครื่องหยุด — 'YYYY-MM-DDTHH:MM' · downFrom มีแต่ downTo ว่าง = ยังหยุดอยู่
  downFrom: string; downTo: string; downtimeMin?: number | null;
  status: Status; vaultPath: string;
  priority: Prio; assignee: string; assigneeName: string;
  source: Source; refKey: string;
  downSoFarMin?: number | null;   // นับจากเซิร์ฟเวอร์ ไม่ใช่นาฬิกาเครื่องผู้ใช้
  hasCard: boolean;               // ใบนี้มีการ์ดอยู่ในกลุ่ม Telegram ไหม
};
type Summary = {
  queue: { stop: number; warn: number; low: number; open: number; wip: number; total: number; downNowCount: number; downNowMin: number };
  km: { closed: number; gaps: number; machines: number };
};
type MaintPerson = { key: string; name: string; bound: boolean };

/* ค่าคงที่ 3 ชุดนี้ต้องตรงกับฝั่งเซิร์ฟเวอร์เสมอ —
   SR_PRIO / SR_STATUS (server/index.js) และ INC_SOURCES · แก้ที่ไหนต้องแก้ให้ครบทั้งสองฝั่ง */
const PRIO: Record<Exclude<Prio, ''>, { ic: string; label: string; short: string }> = {
  stop: { ic: '🔴', label: 'หยุดไลน์', short: 'หยุดไลน์' },
  warn: { ic: '🟡', label: 'ยังเดินได้ แต่มีปัญหา', short: 'มีปัญหา' },
  low: { ic: '🟢', label: 'ไว้ทำตอนว่าง', short: 'ไม่ด่วน' },
};
const prioKey = (p: Prio): Exclude<Prio, ''> => (PRIO[p as Exclude<Prio, ''>] ? (p as Exclude<Prio, ''>) : 'warn');

const STAT: Record<Status, { ic: string; label: string }> = {
  open: { ic: '🔴', label: 'รอรับงาน' },
  wip: { ic: '🔧', label: 'กำลังซ่อม' },
  closed: { ic: '✅', label: 'ปิดงานแล้ว' },
};
const SRC: Record<Exclude<Source, ''>, { cls: string; label: string }> = {
  web: { cls: '', label: '🌐 หน้าเว็บ' },
  bot: { cls: 'bot', label: '💬 บอทแจ้งซ่อม' },
  ai: { cls: 'ai', label: '🤖 AI ผู้ช่วย' },
  amsheet: { cls: 'am', label: '📋 ใบเช็ก AM' },
};

// ไอคอนเครื่องจักร — แฝดกับ MACHINE_IC ใน MaintenanceBoard.tsx/PmRegistry.tsx แก้ต้องแก้พร้อมกัน
const MACHINE_IC: [RegExp, string][] = [
  [/ต้ม|หม้อ/, '🫕'], [/ซีล|seal/i, '🔥'], [/บรรจุ|filling/i, '🧴'], [/ปั๊ม|pump/i, '🌀'],
  [/สายพาน|conveyor/i, '🎢'], [/ไฟฟ้า|มอเตอร์|motor/i, '⚡'], [/ลม|air/i, '💨'],
];
const icOf = (m: string) => (MACHINE_IC.find(([re]) => re.test(m || ''))?.[1] || '🔩');

const blank = (operator: string): Incident => ({
  id: 0, title: '', machine: '', line: '', batchId: '', operator,
  occurredAt: todayBKK(), symptom: '', cause: '', fix: '', result: '',
  images: [], resultImages: [], downFrom: '', downTo: '', status: 'open', vaultPath: '',
  priority: 'warn', assignee: '', assigneeName: '', source: 'web', refKey: '',
  downSoFarMin: null, hasCard: false,
});

/* ══════════ คอมโพเนนต์ย่อย ══════════
   🔴 ทุกตัวต้องนิยามไว้ตรงนี้ (module scope) ห้ามย้ายเข้าไปใน IncidentBoard
   เดิม IncidentForm เคยอยู่ข้างใน แล้วทุกครั้งที่ตัวแม่ re-render (เช่นตอน setMsg)
   React มองว่าเป็นคอมโพเนนต์คนละตัว → unmount ของเดิม → ที่พิมพ์ไว้ในฟอร์มหายเกลี้ยง */

const PrioChip: React.FC<{ p: Prio }> = ({ p }) => {
  const k = prioKey(p);
  return <span className={`chip ${k}`}>{PRIO[k].ic} {PRIO[k].label}</span>;
};
const StatusChip: React.FC<{ s: Status }> = ({ s }) => (
  <span className={`chip st-${s}`}>{STAT[s].ic} {STAT[s].label}</span>
);
const SourceChip: React.FC<{ s: Source }> = ({ s }) => {
  if (!s || !SRC[s as Exclude<Source, ''>]) return null;   // ใบเก่าที่เดาที่มาไม่ได้ = ไม่โชว์ ดีกว่าโชว์ผิด
  const m = SRC[s as Exclude<Source, ''>];
  return <span className={`src ${m.cls}`}>{m.label}</span>;
};

/* เวลาที่เครื่องหยุด — เริ่มนับจากตัวเลขที่เซิร์ฟเวอร์ส่งมา แล้วเดินต่อเองนาทีละครั้ง
   (ไม่คำนวณจาก Date.now() ของเครื่องผู้ใช้ เพราะนาฬิกาเครื่องอาจไม่ตรงกับเซิร์ฟเวอร์) */
const DownBadge: React.FC<{ inc: Incident }> = ({ inc }) => {
  const live = !!inc.downFrom && !inc.downTo;
  const [mins, setMins] = useState(inc.downSoFarMin ?? 0);
  useEffect(() => {
    setMins(inc.downSoFarMin ?? 0);
    if (!live) return;
    const t = setInterval(() => setMins(m => m + 1), 60000);
    return () => clearInterval(t);
  }, [inc.downSoFarMin, live]);
  if (live) return <span className="down"><span className="live" />หยุดมาแล้ว {hhmm(mins)}</span>;
  if (inc.downtimeMin != null) return <span className="down done">⏱ หยุดรวม {hhmm(inc.downtimeMin)}</span>;
  return null;
};

/* แถบรูปแนบ — อัปขึ้น Supabase Storage แล้วเก็บแต่ URL (ห้ามเก็บ base64 ลง DB)
   ถ้าอัปไม่สำเร็จ uploadDutyImage จะคืน data URL กลับมา → ไม่รับ แล้วบอกผู้ใช้ตรง ๆ */
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
    <div className="thumbs">
      {urls.map((u, i) => (
        <span key={u} className="thwrap">
          <img className="th" src={u} alt={`${label} ${i + 1}`} onClick={() => onZoom(u)} />
          <button className="thx" onClick={() => onChange(urls.filter(x => x !== u))} aria-label="เอารูปออก">×</button>
        </span>
      ))}
      {urls.length < 8 && (
        <button className="thadd" onClick={() => fileRef.current?.click()} disabled={busy} aria-label={`แนบรูป${label}`}>
          {busy ? '⏳' : '📷'}
        </button>
      )}
      <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
        onChange={e => { add(e.target.files); e.target.value = ''; }} />
    </div>
  );
};

const StatBar: React.FC<{ tab: 'queue' | 'km'; s: Summary | null }> = ({ tab, s }) => {
  if (!s) return null;
  if (tab === 'queue') return (
    <div className="istats">
      <div className={`istat${s.queue.stop ? ' hot' : ''}`}>
        <div className="l">🔴 หยุดไลน์</div>
        <div className="v">{s.queue.stop}<span className="u">ใบ</span></div>
      </div>
      <div className="istat">
        <div className="l">🟡 ยังเดินได้ แต่มีปัญหา</div>
        <div className="v">{s.queue.warn}<span className="u">ใบ</span></div>
      </div>
      <div className="istat">
        <div className="l">🟢 ไว้ทำตอนว่าง</div>
        <div className="v">{s.queue.low}<span className="u">ใบ</span></div>
      </div>
      <div className="istat">
        <div className="l">⏱ เครื่องยังหยุดอยู่ตอนนี้</div>
        <div className="v">{s.queue.downNowCount}
          <span className="u">{s.queue.downNowCount ? `เครื่อง · ${hhmm(s.queue.downNowMin)}` : 'เครื่อง'}</span>
        </div>
      </div>
    </div>
  );
  return (
    <div className="istats">
      <div className="istat">
        <div className="l">📚 เรื่องที่ปิดแล้ว</div>
        <div className="v">{s.km.closed}<span className="u">เรื่อง</span></div>
      </div>
      <div className={`istat${s.km.gaps ? ' gap' : ''}`}>
        <div className="l">⚠️ ปิดแล้วแต่ยังไม่มีสาเหตุ/วิธีแก้</div>
        <div className="v">{s.km.gaps}<span className="u">เรื่อง</span></div>
      </div>
      <div className="istat">
        <div className="l">🔩 เครื่องที่มีประวัติ</div>
        <div className="v">{s.km.machines}<span className="u">เครื่อง</span></div>
      </div>
    </div>
  );
};

const TicketCard: React.FC<{
  inc: Incident; people: MaintPerson[]; busy: boolean;
  onAssign: (inc: Incident, key: string) => void;
  onClose: (inc: Incident) => void;
  onEdit: (inc: Incident) => void;
  onZoom: (u: string) => void;
}> = ({ inc, people, busy, onAssign, onClose, onEdit, onZoom }) => (
  <article className={`tk p-${prioKey(inc.priority)}`}>
    <div className="r1">
      <PrioChip p={inc.priority} />
      <h3>{inc.title}</h3>
      <StatusChip s={inc.status} />
    </div>
    <div className="meta">
      <span>#{inc.id}</span><span className="dot">·</span>
      <span>{icOf(inc.machine)} {inc.machine || 'ไม่ระบุเครื่อง'}</span>
      <span className="dot">·</span><span>{inc.occurredAt}</span>
      {inc.operator && <><span className="dot">·</span><span>🙋 {inc.operator}</span></>}
      {inc.assigneeName && <><span className="dot">·</span><span>🔧 ช่าง: <b>{inc.assigneeName}</b></span></>}
      <SourceChip s={inc.source} />
      <DownBadge inc={inc} />
    </div>
    {inc.symptom && <div className="sym"><b>อาการ</b> — {inc.symptom}</div>}
    {inc.images.length > 0 && (
      <div className="thumbs">
        {inc.images.map((u, i) => (
          <img key={u} className="th" src={u} alt={`รูปอาการ ${i + 1}`} onClick={() => onZoom(u)} />
        ))}
      </div>
    )}
    <div className="acts">
      <select className="isel" value={inc.assignee} disabled={busy}
        onChange={e => onAssign(inc, e.target.value)} aria-label="มอบหมายช่าง">
        <option value="">🙋 ยังไม่มอบหมาย</option>
        {people.map(p => <option key={p.key} value={p.key}>🔧 {p.name}</option>)}
      </select>
      <button className="ibtn sm ok" onClick={() => onClose(inc)} disabled={busy}>✅ ปิดงาน</button>
      <button className="ibtn sm" onClick={() => onEdit(inc)} disabled={busy}>✏️ แก้ไข</button>
      <span className="sp" />
      {inc.hasCard && <span className="vp">💬 มีการ์ดในกลุ่มช่าง</span>}
    </div>
  </article>
);

/* แผ่นปิดงาน — บังคับกรอก "วิธีแก้" เพราะใบที่ปิดโดยไม่มีวิธีแก้ ค้นเจอแล้วก็ไม่ได้คำตอบ */
const CloseSheet: React.FC<{
  inc: Incident; busy: boolean;
  onGo: (v: { fix: string; cause: string; result: string; resultImages: string[]; downTo: string }) => void;
  onCancel: () => void; onZoom: (u: string) => void; onError: (m: string) => void;
}> = ({ inc, busy, onGo, onCancel, onZoom, onError }) => {
  const [fix, setFix] = useState(inc.fix || '');
  const [cause, setCause] = useState(inc.cause || '');
  const [result, setResult] = useState(inc.result || '');
  const [imgs, setImgs] = useState<string[]>(inc.resultImages || []);
  const [downTo, setDownTo] = useState(inc.downTo || (inc.downFrom ? nowLocal() : ''));
  const bad = !!inc.downFrom && !!downTo && minsBetween(inc.downFrom, downTo) == null;
  return (
    <div className="sheet" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="box">
        <h3>✅ ปิดงาน — {inc.title}</h3>
        <div className="hint">ปิดใบนี้แล้วจะกลายเป็นบทเรียนในคลังความรู้ทันที</div>
        <div className="warnbox">
          ที่ต้องกรอก <b>“วิธีแก้”</b> เพราะครั้งหน้าที่เครื่องนี้เป็นอีก คนที่มาค้นต้องได้คำตอบ ไม่ใช่แค่รู้ว่า “เคยเป็น”
        </div>
        <div className="fld">
          <label htmlFor="cs-fix">วิธีแก้ที่ใช้ <span className="req">*จำเป็น</span></label>
          <textarea id="cs-fix" rows={3} value={fix} onChange={e => setFix(e.target.value)}
            placeholder="ทำอะไรไปบ้าง เปลี่ยนอะไร ตั้งค่าเท่าไหร่" autoFocus />
        </div>
        <div className="fld">
          <label htmlFor="cs-cause">สาเหตุที่แท้จริง <span style={{ fontWeight: 500, color: 'var(--muted)' }}>(ไม่บังคับ — เติมทีหลังได้)</span></label>
          <textarea id="cs-cause" rows={2} value={cause} onChange={e => setCause(e.target.value)}
            placeholder="เว้นว่างได้ ระบบจะขึ้นป้าย ⚠️ ยังไม่ได้เติมสาเหตุ ไว้ให้กลับมาเก็บ" />
        </div>
        <div className="fld">
          <label htmlFor="cs-res">ผลหลังแก้</label>
          <textarea id="cs-res" rows={2} value={result} onChange={e => setResult(e.target.value)} placeholder="หายไหม กลับมาอีกไหม" />
        </div>
        {inc.downFrom && (
          <div className="fld">
            <label htmlFor="cs-dt">เครื่องกลับมาเดินเมื่อ <span style={{ fontWeight: 500, color: 'var(--muted)' }}>(หยุดตั้งแต่ {inc.downFrom.replace('T', ' ')} น.)</span></label>
            <input id="cs-dt" type="datetime-local" value={downTo} onChange={e => setDownTo(e.target.value)} />
            {bad && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>⚠️ เวลากลับมาเดินอยู่ก่อนเวลาที่เครื่องหยุด</div>}
          </div>
        )}
        <div className="fld">
          <label>📷 รูปหลังซ่อม</label>
          <PhotoStrip label="หลังซ่อม" urls={imgs} onChange={setImgs} onZoom={onZoom} onError={onError} />
        </div>
        <div className="acts">
          <button className="ibtn pri" disabled={busy || !fix.trim() || bad}
            onClick={() => onGo({ fix: fix.trim(), cause: cause.trim(), result: result.trim(), resultImages: imgs, downTo })}>
            {busy ? 'กำลังปิด…' : 'ปิดงาน + แก้การ์ดในกลุ่ม'}
          </button>
          <button className="ibtn" onClick={onCancel} disabled={busy}>ยกเลิก</button>
        </div>
      </div>
    </div>
  );
};

const IncidentForm: React.FC<{
  draft: Incident; machines: string[]; people: MaintPerson[]; busy: boolean;
  onSave: (d: Incident) => void; onCancel: () => void;
  onZoom: (u: string) => void; onError: (m: string) => void;
}> = ({ draft, machines, people, busy, onSave, onCancel, onZoom, onError }) => {
  const [d, setD] = useState(draft);
  const set = (patch: Partial<Incident>) => setD(v => ({ ...v, ...patch }));
  const area = (k: 'symptom' | 'cause' | 'fix' | 'result', label: string, hint: string, photoKey?: 'images' | 'resultImages') => (
    <div className="fld">
      <label htmlFor={`if-${k}`}>{label}</label>
      <textarea id={`if-${k}`} rows={2} value={d[k]} placeholder={hint}
        onChange={e => set({ [k]: e.target.value } as Partial<Incident>)} />
      {photoKey && (
        <PhotoStrip label={label} urls={d[photoKey]} onZoom={onZoom} onError={onError}
          onChange={v => set({ [photoKey]: v } as Partial<Incident>)} />
      )}
    </div>
  );
  const mins = minsBetween(d.downFrom, d.downTo);
  return (
    <div className="sheet" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="box" style={{ maxWidth: 680 }}>
        <h3>{d.id ? `✏️ แก้ไขใบ #${d.id}` : '＋ บันทึกเหตุการณ์'}</h3>
        <div className="hint">บันทึกแล้วระบบเขียนโน้ตลง Obsidian และแก้การ์ดในกลุ่มช่างให้เอง</div>
        <div className="fld">
          <label htmlFor="if-title">หัวข้อเหตุการณ์ <span className="req">*</span></label>
          <input id="if-title" autoFocus value={d.title} onChange={e => set({ title: e.target.value })}
            placeholder="เช่น เครื่องซีลแนวตั้งอุณหภูมิตก รอยซีลรั่ว" style={{ fontWeight: 600 }} />
        </div>
        <div className="grid2">
          <div className="fld">
            <label htmlFor="if-machine">เครื่องจักร</label>
            <input id="if-machine" list="inc-machines" value={d.machine} onChange={e => set({ machine: e.target.value })} />
            <datalist id="inc-machines">{machines.map(m => <option key={m} value={m} />)}</datalist>
          </div>
          <div className="fld">
            <label htmlFor="if-prio">ความเร่งด่วน</label>
            <select id="if-prio" value={d.priority || 'warn'} onChange={e => set({ priority: e.target.value as Prio })}>
              {(Object.keys(PRIO) as Exclude<Prio, ''>[]).map(k => (
                <option key={k} value={k}>{PRIO[k].ic} {PRIO[k].label}</option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="if-assignee">ช่างที่รับงาน</label>
            <select id="if-assignee" value={d.assignee} onChange={e => set({ assignee: e.target.value })}>
              <option value="">— ยังไม่มอบหมาย —</option>
              {people.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="if-line">ไลน์</label>
            <input id="if-line" value={d.line} onChange={e => set({ line: e.target.value })} placeholder="เช่น Line ต้ม 2" />
          </div>
          <div className="fld">
            <label htmlFor="if-batch">Batch</label>
            <input id="if-batch" value={d.batchId} onChange={e => set({ batchId: e.target.value })} />
          </div>
          <div className="fld">
            <label htmlFor="if-date">วันที่เกิด</label>
            <input id="if-date" type="date" value={d.occurredAt} onChange={e => set({ occurredAt: e.target.value })} />
          </div>
          <div className="fld">
            <label htmlFor="if-op">ผู้บันทึก</label>
            <input id="if-op" value={d.operator} onChange={e => set({ operator: e.target.value })} />
          </div>
        </div>

        {/* เวลาเครื่องหยุด — ไม่บังคับ แต่ถ้ากรอกจะไปรวมในหน้า "เวลาเครื่องหยุด" และโน้ตเครื่องจักร */}
        <div className="warnbox" style={{ borderLeftColor: 'var(--brand)' }}>
          <b>⏱ เวลาที่เครื่องหยุด</b> — ไม่บังคับ กรอกแล้วได้สรุปชั่วโมงเสียรายเครื่อง
          <div className="grid2" style={{ marginTop: 8 }}>
            <div className="fld" style={{ marginBottom: 0 }}>
              <label htmlFor="if-df">เครื่องหยุดเมื่อ</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <input id="if-df" type="datetime-local" value={d.downFrom} onChange={e => set({ downFrom: e.target.value })} />
                <button className="ibtn sm" style={{ flex: 'none' }} onClick={() => set({ downFrom: nowLocal() })}>ตอนนี้</button>
              </div>
            </div>
            <div className="fld" style={{ marginBottom: 0 }}>
              <label htmlFor="if-dt">กลับมาเดินเมื่อ</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <input id="if-dt" type="datetime-local" value={d.downTo} onChange={e => set({ downTo: e.target.value })} />
                <button className="ibtn sm" style={{ flex: 'none' }} onClick={() => set({ downTo: nowLocal() })}>ตอนนี้</button>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand-deep)', marginTop: 7 }}>
            {mins != null ? `= เสียไป ${hhmm(mins)}`
              : d.downFrom && d.downTo ? '⚠️ เวลากลับมาเดินอยู่ก่อนเวลาหยุด'
              : d.downFrom ? '🔴 ยังหยุดอยู่ — กรอกเวลากลับมาเดินทีหลังได้' : ''}
          </div>
        </div>

        {area('symptom', 'อาการ', 'เห็นอะไร วัดค่าได้เท่าไหร่', 'images')}
        {area('cause', 'สาเหตุที่คาดว่าเป็น', 'เว้นว่างไว้ก่อนได้ ค่อยมาเติมทีหลัง')}
        {area('fix', 'วิธีแก้ที่ใช้', 'ทำอะไรไปบ้าง')}
        {area('result', 'ผลหลังแก้', 'หายไหม กลับมาอีกไหม', 'resultImages')}

        <div className="acts">
          <button className="ibtn pri" onClick={() => onSave(d)} disabled={busy || !d.title.trim()}>
            {busy ? 'กำลังบันทึก…' : 'บันทึก + เขียนโน้ตลง Obsidian'}
          </button>
          <button className="ibtn" onClick={onCancel} disabled={busy}>ยกเลิก</button>
        </div>
      </div>
    </div>
  );
};

const KmItem: React.FC<{
  inc: Incident; onEdit: (i: Incident) => void; onReopen: (i: Incident) => void;
  onDelete: (i: Incident) => void; onZoom: (u: string) => void; busy: boolean;
}> = ({ inc, onEdit, onReopen, onDelete, onZoom, busy }) => {
  const gapLabel = !inc.cause && !inc.fix ? 'สาเหตุ/วิธีแก้' : !inc.cause ? 'สาเหตุ' : !inc.fix ? 'วิธีแก้' : '';
  const box = (label: string, v: string, photos?: string[]) => (
    <div className={`b${v ? '' : ' empty'}`} key={label}>
      <div className="l">{label}</div>
      <div className="v">{v || 'ยังไม่ได้เติม'}</div>
      {photos && photos.length > 0 && (
        <div className="thumbs">
          {photos.map(u => <img key={u} className="th" src={u} alt={label} onClick={() => onZoom(u)} />)}
        </div>
      )}
    </div>
  );
  return (
    <div className="km">
      <div className="t">
        <span>{inc.title}</span>
        {gapLabel && <span className="gapflag">⚠️ ยังไม่ได้เติม{gapLabel}</span>}
      </div>
      <div className="d">
        <span>#{inc.id} · {inc.occurredAt}{inc.operator ? ` · โดย ${inc.operator}` : ''}</span>
        <SourceChip s={inc.source} />
        {inc.downtimeMin != null && <span>⏱ เสีย {hhmm(inc.downtimeMin)}</span>}
      </div>
      <div className="qa">
        {box('อาการ', inc.symptom, inc.images)}
        {box('สาเหตุ', inc.cause)}
        {box('วิธีแก้', inc.fix)}
        {box('ผลหลังแก้', inc.result, inc.resultImages)}
      </div>
      <div className="acts">
        <button className="ibtn sm" onClick={() => onEdit(inc)} disabled={busy}>✏️ เติมความรู้</button>
        <button className="ibtn sm" onClick={() => onReopen(inc)} disabled={busy}>↩ เปิดใหม่</button>
        <button className="ibtn sm dgr" onClick={() => onDelete(inc)} disabled={busy}>🗑 ลบ</button>
        <span className="sp" />
        {inc.vaultPath && <span className="vp">📄 {inc.vaultPath}</span>}
      </div>
    </div>
  );
};

const KmMachineGroup: React.FC<{
  name: string; items: Incident[]; open: boolean; onToggle: () => void;
  onEdit: (i: Incident) => void; onReopen: (i: Incident) => void;
  onDelete: (i: Incident) => void; onZoom: (u: string) => void; busy: boolean;
}> = ({ name, items, open, onToggle, onEdit, onReopen, onDelete, onZoom, busy }) => {
  const mins = items.reduce((n, i) => n + (i.downtimeMin || 0), 0);
  const gaps = items.filter(i => !i.cause || !i.fix).length;
  return (
    <div className="mgroup">
      <button className="mhead" onClick={onToggle} aria-expanded={open}>
        <span>{icOf(name)} {name}</span>
        <span className="m">
          <span>{items.length} เรื่อง</span>
          {mins > 0 && <span style={{ color: 'var(--brand-deep)' }}>⏱ เสียรวม {hhmm(mins)}</span>}
          {gaps > 0 && <span style={{ color: 'var(--warn)' }}>⚠️ ยังไม่ครบ {gaps}</span>}
          <span className="caret">{open ? '▲ ย่อ' : '▼ กาง'}</span>
        </span>
      </button>
      {open && (
        <div className="mbody">
          {items.map(i => (
            <KmItem key={i.id} inc={i} onEdit={onEdit} onReopen={onReopen}
              onDelete={onDelete} onZoom={onZoom} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
};

/* ══════════ ตัวแม่ ══════════ */

const IncidentBoard: React.FC<{ operatorName: string | null }> = ({ operatorName }) => {
  // แท็บเก็บใน sessionStorage เพราะ AdminShell unmount หน้านี้ทุกครั้งที่สลับเมนู
  const [tab, setTab] = useState<'queue' | 'km'>(() => {
    try { return sessionStorage.getItem('inc.tab') === 'km' ? 'km' : 'queue'; } catch { return 'queue'; }
  });
  const [queue, setQueue] = useState<Incident[]>([]);
  const [km, setKm] = useState<Incident[]>([]);
  const [kmLoaded, setKmLoaded] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [machines, setMachines] = useState<string[]>([]);
  const [people, setPeople] = useState<MaintPerson[]>([]);
  const [prio, setPrio] = useState<'all' | 'stop' | 'warn' | 'low'>('all');
  const [fMachine, setFMachine] = useState('');
  const [fSource, setFSource] = useState('');
  const [q, setQ] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<Incident | null>(null);
  const [closing, setClosing] = useState<Incident | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [wake, setWake] = useState<WakeState>('idle');

  useEffect(() => { try { sessionStorage.setItem('inc.tab', tab); } catch { /* โหมดส่วนตัว */ } }, [tab]);

  const api = useCallback((path: string, init?: RequestInit) =>
    wakeFetch(`${apiUrl}${path}`, { ...init, onState: setWake }), []);

  const loadQueue = useCallback(async () => {
    const d = await api('/api/incidents?scope=queue').then(r => r.json());
    setQueue(Array.isArray(d?.incidents) ? d.incidents : []);
    if (d?.summary) setSummary(d.summary);
  }, [api]);

  const loadKm = useCallback(async () => {
    const d = await api('/api/incidents?scope=km&limit=300').then(r => r.json());
    setKm(Array.isArray(d?.incidents) ? d.incidents : []);
    if (d?.summary) setSummary(d.summary);
    setKmLoaded(true);
  }, [api]);

  useEffect(() => {
    (async () => {
      try {
        await loadQueue();
        const [m, p] = await Promise.all([
          api('/api/machines').then(r => r.json()).catch(() => ({ machines: [] })),
          api('/api/maint/people').then(r => r.json()).catch(() => ({ people: [] })),
        ]);
        setMachines(Array.isArray(m?.machines) ? m.machines.map((x: { name: string }) => x.name) : []);
        setPeople(Array.isArray(p?.people) ? p.people : []);
      } catch { setMsg({ kind: 'err', text: 'โหลดรายการเหตุการณ์ไม่สำเร็จ' }); }
    })();
  }, [api, loadQueue]);

  // คลังความรู้โหลดตอนเปิดแท็บครั้งแรกเท่านั้น — ไม่ลากทั้งคลังมาตั้งแต่เข้าหน้า
  useEffect(() => {
    if (tab === 'km' && !kmLoaded) loadKm().catch(() => setMsg({ kind: 'err', text: 'โหลดคลังความรู้ไม่สำเร็จ' }));
  }, [tab, kmLoaded, loadKm]);

  // ผลของทุกคำสั่ง: บอกให้ชัดว่ากลุ่ม Telegram เห็นแล้วหรือยัง (เป็นสิ่งเดียวที่มองจากหน้าเว็บไม่เห็น)
  const cardNote = (card?: string) =>
    card === 'edited' ? ' · แก้การ์ดในกลุ่มช่างให้แล้ว'
      : card === 'failed' ? ' ⚠️ แก้การ์ดในกลุ่มไม่สำเร็จ' : '';

  const post = async (path: string, body: unknown) => {
    const r = await api(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || 'ทำรายการไม่สำเร็จ');
    return d;
  };

  const refreshAfter = async (alsoKm: boolean) => {
    await loadQueue();
    if (alsoKm && kmLoaded) await loadKm();
  };

  const assign = async (inc: Incident, key: string) => {
    setBusy(true);
    try {
      const d = await post('/api/incidents/assign', { id: inc.id, assignee: key });
      const who = people.find(p => p.key === key);
      setMsg({ kind: 'ok', text: `✅ ${key ? `มอบหมายให้ ${who?.name || key} แล้ว` : 'ถอนมอบหมายแล้ว'}${cardNote(d.card)}` });
      await refreshAfter(false);
    } catch (e) { setMsg({ kind: 'err', text: `❌ ${(e as Error).message}` }); } finally { setBusy(false); }
  };

  const closeJob = async (v: { fix: string; cause: string; result: string; resultImages: string[]; downTo: string }) => {
    if (!closing) return;
    setBusy(true);
    try {
      const d = await post('/api/incidents/close', { id: closing.id, ...v });
      setClosing(null);
      setMsg({ kind: 'ok', text: `✅ ปิดงานแล้ว — ย้ายเข้าคลังความรู้${cardNote(d.card)}` });
      setKmLoaded(false);
      await refreshAfter(false);
    } catch (e) { setMsg({ kind: 'err', text: `❌ ${(e as Error).message}` }); } finally { setBusy(false); }
  };

  const reopen = async (inc: Incident) => {
    setBusy(true);
    try {
      const d = await post('/api/incidents/reopen', { id: inc.id });
      setMsg({ kind: 'ok', text: `✅ เปิดใบ #${inc.id} ใหม่แล้ว${cardNote(d.card)}` });
      setKm(list => list.filter(x => x.id !== inc.id));
      await refreshAfter(false);
      setTab('queue');
    } catch (e) { setMsg({ kind: 'err', text: `❌ ${(e as Error).message}` }); } finally { setBusy(false); }
  };

  const save = async (d: Incident) => {
    if (!d.title.trim()) return;
    setBusy(true);
    try {
      const res = await post('/api/incidents', { ...d, id: d.id || undefined, title: d.title.trim() });
      setEdit(null);
      setMsg({
        kind: 'ok',
        text: (res.vaultPath ? `✅ บันทึกแล้ว · เขียนโน้ตลง vault: ${res.vaultPath}`
          : res.vaultSkipped ? `✅ บันทึกแล้ว (${res.vaultSkipped} — โน้ตยังไม่ถูกเขียน)`
          : `✅ บันทึกแล้ว ⚠️ เขียนโน้ตไม่สำเร็จ: ${res.vaultError || 'ไม่ทราบสาเหตุ'}`) + cardNote(res.card),
      });
      setKmLoaded(false);
      await refreshAfter(false);
    } catch (e) { setMsg({ kind: 'err', text: `❌ ${(e as Error).message}` }); } finally { setBusy(false); }
  };

  const del = async (inc: Incident) => {
    if (!window.confirm(`ลบเหตุการณ์ "${inc.title}" ทิ้ง?\n${inc.vaultPath ? `โน้ต ${inc.vaultPath} ใน Obsidian จะถูกลบด้วย` : ''}`)) return;
    setBusy(true);
    try {
      const d = await post('/api/incidents/delete', { id: inc.id });
      setMsg({ kind: 'ok', text: d.vaultError ? `✅ ลบแล้ว ⚠️ ลบโน้ตในวอลต์ไม่สำเร็จ: ${d.vaultError}` : '✅ ลบแล้ว' });
      setKm(list => list.filter(x => x.id !== inc.id));
      await refreshAfter(false);
    } catch (e) { setMsg({ kind: 'err', text: `❌ ${(e as Error).message}` }); } finally { setBusy(false); }
  };

  /* กรองฝั่ง client เท่านั้น — ห้าม sort ซ้ำ ลำดับคิวต้องมาจากเซิร์ฟเวอร์ที่เดียว
     ไม่งั้นลำดับในเว็บกับในกระดานบอทจะไม่ตรงกัน ซึ่งเป็นเรื่องที่หน้านี้ตั้งใจแก้ */
  const shownQueue = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return queue.filter(i =>
      (prio === 'all' || prioKey(i.priority) === prio)
      && (!fMachine || i.machine === fMachine)
      && (!fSource || i.source === fSource)
      && (!needle || `${i.title} ${i.symptom} ${i.machine} ${i.operator}`.toLowerCase().includes(needle)));
  }, [queue, prio, fMachine, fSource, q]);

  const kmGroups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = km.filter(i =>
      (!fMachine || i.machine === fMachine)
      && (!needle || `${i.title} ${i.symptom} ${i.cause} ${i.fix} ${i.machine}`.toLowerCase().includes(needle)));
    // คงลำดับเดิมของตาราง (ใหม่สุดก่อน) ไม่ sort ชื่อกลุ่ม — เหมือน groupByMachine ในหน้าอื่น
    const out: { name: string; items: Incident[] }[] = [];
    for (const r of rows) {
      const name = r.machine || 'ไม่ระบุเครื่อง';
      const g = out.find(x => x.name === name);
      if (g) g.items.push(r); else out.push({ name, items: [r] });
    }
    return out;
  }, [km, fMachine, q]);

  const queueMachines = useMemo(
    () => Array.from(new Set(queue.map(i => i.machine).filter(Boolean))).sort(), [queue]);
  const kmMachineNames = useMemo(
    () => Array.from(new Set(km.map(i => i.machine).filter(Boolean))).sort(), [km]);

  const count = (k: 'stop' | 'warn' | 'low') => queue.filter(i => prioKey(i.priority) === k).length;
  const toggleGroup = (name: string) => setOpenGroups(s => {
    const n = new Set(s);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  });

  return (
    <div className="incx">
      <div className="eyebrow">⚡ ศูนย์รวมงานซ่อม + คลังความรู้</div>
      <div className="phead">
        <h1>เหตุการณ์</h1>
        <span className="sub">
          ค้างอยู่ <b>{summary?.queue.total ?? queue.length}</b> ใบ
          {summary && <> · ปิดแล้วสะสม <b>{summary.km.closed}</b> เรื่อง</>}
        </span>
        <span className="sp" />
        <button className="ibtn pri" onClick={() => setEdit(blank(operatorName || ''))}>＋ บันทึกเหตุการณ์</button>
      </div>

      <div className="itabs" role="tablist">
        <button className={`itab${tab === 'queue' ? ' on' : ''}`} role="tab" aria-selected={tab === 'queue'}
          onClick={() => setTab('queue')}>
          🔧 คิวงานซ่อม <span className="n">{summary?.queue.total ?? queue.length}</span>
        </button>
        <button className={`itab${tab === 'km' ? ' on' : ''}`} role="tab" aria-selected={tab === 'km'}
          onClick={() => setTab('km')}>
          📚 คลังความรู้ <span className="n">{summary?.km.closed ?? '—'}</span>
        </button>
      </div>

      {wake === 'waking' && <div className="msg wake">{wakeMessage('waking')}</div>}
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      <StatBar tab={tab} s={summary} />

      {tab === 'queue' ? (
        <>
          <div className="ifilters">
            <button className={`ipill${prio === 'all' ? ' on' : ''}`} onClick={() => setPrio('all')}>
              ทั้งหมด <span className="n">{queue.length}</span>
            </button>
            {(['stop', 'warn', 'low'] as const).map(k => (
              <button key={k} className={`ipill ${k}${prio === k ? ' on' : ''}`} onClick={() => setPrio(k)}>
                {PRIO[k].ic} {PRIO[k].short} <span className="n">{count(k)}</span>
              </button>
            ))}
            <span className="divider" />
            <select className="isel" value={fMachine} onChange={e => setFMachine(e.target.value)} aria-label="กรองตามเครื่อง">
              <option value="">ทุกเครื่อง</option>
              {queueMachines.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <select className="isel" value={fSource} onChange={e => setFSource(e.target.value)} aria-label="กรองตามที่มา">
              <option value="">ทุกที่มา</option>
              {(Object.keys(SRC) as Exclude<Source, ''>[]).map(k => (
                <option key={k} value={k}>{SRC[k].label}</option>
              ))}
            </select>
            <input className="isrch" value={q} onChange={e => setQ(e.target.value)} placeholder="🔎 ค้นหัวข้อ / อาการ / เครื่อง" />
          </div>

          <div className="ilist">
            {shownQueue.map(i => (
              <TicketCard key={i.id} inc={i} people={people} busy={busy}
                onAssign={assign} onClose={setClosing} onEdit={setEdit} onZoom={setZoom} />
            ))}
            {!shownQueue.length && (
              <div className="empty">
                {queue.length ? 'ไม่มีใบที่ตรงกับตัวกรอง' : 'ไม่มีงานซ่อมค้าง — เครื่องเดินครบทุกตัว 🎉'}
                <br />
                <span style={{ fontSize: 12 }}>เจอปัญหาหน้างานแล้วกด “＋ บันทึกเหตุการณ์” — สาเหตุ/วิธีแก้ค่อยมาเติมทีหลังได้</span>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {!!summary?.km.gaps && (
            <div className="warnbox">
              <b>⚠️ มี {summary.km.gaps} เรื่องที่ปิดแล้วแต่ยังไม่มีสาเหตุหรือวิธีแก้</b> — ค้นเจอแต่ไม่ได้คำตอบ
              กด “✏️ เติมความรู้” ในเรื่องที่มีป้ายเหลืองเพื่อไล่เก็บ
            </div>
          )}
          <div className="ifilters">
            <input className="isrch" style={{ maxWidth: 340 }} value={q} onChange={e => setQ(e.target.value)}
              placeholder="🔎 ค้นอาการ เช่น “แรงดันตก” “ซีลรั่ว”" />
            <select className="isel" value={fMachine} onChange={e => setFMachine(e.target.value)} aria-label="กรองตามเครื่อง">
              <option value="">ทุกเครื่อง</option>
              {kmMachineNames.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="sp" />
            <button className="ipill" onClick={() => setOpenGroups(new Set(kmGroups.map(g => g.name)))}>▼ กางทั้งหมด</button>
            <button className="ipill" onClick={() => setOpenGroups(new Set())}>▲ ย่อทั้งหมด</button>
          </div>

          {kmGroups.map(g => (
            <KmMachineGroup key={g.name} name={g.name} items={g.items}
              open={openGroups.has(g.name)} onToggle={() => toggleGroup(g.name)}
              onEdit={setEdit} onReopen={reopen} onDelete={del} onZoom={setZoom} busy={busy} />
          ))}
          {!kmGroups.length && (
            <div className="empty">
              {kmLoaded ? 'ยังไม่มีเรื่องที่ปิดแล้วในคลังความรู้' : 'กำลังโหลด…'}
            </div>
          )}
        </>
      )}

      {edit && (
        <IncidentForm draft={edit} machines={machines} people={people} busy={busy}
          onSave={save} onCancel={() => setEdit(null)} onZoom={setZoom}
          onError={m => setMsg({ kind: 'err', text: m })} />
      )}
      {closing && (
        <CloseSheet inc={closing} busy={busy} onGo={closeJob} onCancel={() => setClosing(null)}
          onZoom={setZoom} onError={m => setMsg({ kind: 'err', text: m })} />
      )}
      {zoom && (
        <div className="zoom" onClick={() => setZoom(null)}>
          <img src={zoom} alt="ขยาย" />
        </div>
      )}
    </div>
  );
};

export default IncidentBoard;
