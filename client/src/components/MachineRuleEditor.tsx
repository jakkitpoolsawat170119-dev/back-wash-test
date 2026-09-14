/* กฎเตือน — "ถ้าวันนี้เครื่องนี้ผลิตสินค้าตัวนี้ → ต้องทำอะไร ตอนไหน"
   ยกดีไซน์จาก mockup/machine-registry.html แท็บ ⚙️ กฎเตือน

   🔑 เงื่อนไขช่องไหนเว้นว่าง = "อะไรก็ได้" · ที่กรอกไว้ต้องตรงพร้อมกันทั้งหมด (AND)
   🔑 หลายกฎเข้าพร้อมกันได้ ไม่ใช่ผู้ชนะคนเดียว — ข้อของทุกกฎรวมเป็นใบเดียว ข้อชื่อซ้ำตัดทิ้ง
   🔑 ความจำเพาะ (สินค้า 8 · เครื่อง 4 · ไลน์ 2 · กะ 1) เซิร์ฟเวอร์คิดเอง หน้านี้แค่โชว์

   ⚠️ คอมโพเนนต์ย่อยอยู่นอกตัวหลักทุกตัว — ประกาศข้างในทำให้ React ถอด/ใส่ใหม่ทุก render
      แล้วข้อความที่พิมพ์ค้างในช่องหาย (บั๊กเดิมของไฟล์นี้ + AmSheetPage.tsx:43)        */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { wakeMessage, type WakeState } from '../lib/wakeFetch';
import { currentWorkDay } from '../shiftSchedule';
import {
  mcGet, mcPost, roleLabel, TIMING_META, TIMING_ORDER,
  type MachineRule, type NameRef, type PreviewData, type RuleItem, type RulesData,
} from '../lib/machines';

type Msg = { kind: 'ok' | 'warn' | 'err'; text: string } | null;
type Filter = '' | 'start' | 'during' | 'end' | 'off';

interface Draft {
  id: number; title: string; timing: string;
  lineName: string; packerName: string; productPattern: string; shift: string;
  ownerRole: string; note: string; items: RuleItem[];
}

const SHIFTS = ['กะเช้า', 'กะบ่าย', 'กะดึก'];
const ROLES = ['pd', 'mt', 'qc', 'op'];

const blankDraft = (): Draft => ({
  id: 0, title: '', timing: 'start', lineName: '', packerName: '',
  productPattern: '', shift: '', ownerRole: 'pd', note: '',
  items: [{ title: '', detail: '', needPhoto: false, needQc: false }],
});

const toDraft = (r: MachineRule): Draft => ({
  id: r.id, title: r.title, timing: r.timing || 'start',
  lineName: r.lineName, packerName: r.packerName, productPattern: r.productPattern,
  shift: r.shift, ownerRole: r.ownerRole || 'pd', note: r.note,
  items: r.items.length ? r.items.map(i => ({ ...i })) : [{ title: '' }],
});

/* ประโยคสรุปเงื่อนไข — ใช้ทั้งบนการ์ดและในกล่องสรุปท้ายฟอร์ม · ลำดับตาม mockup
   ⚠️ ห้ามเติมคำว่า "ไลน์"/"เครื่องบรรจุ" หน้าชื่อ — ชื่อที่โชว์มีคำนั้นอยู่ในตัวแล้ว
      ("ไลน์ Line ต้ม 1" · "เครื่อง เครื่องบรรจุ L2") · เครื่องบรรจุใช้รหัสในแผนสั้น ๆ แทน */
const condText = (d: { lineName: string; packerName: string; productPattern: string; shift: string },
  shortOf: (n: string) => string) => [
  d.packerName ? `เครื่อง ${shortOf(d.packerName)}` : 'ทุกเครื่อง',
  d.productPattern ? `สินค้ามีคำว่า “${d.productPattern}”` : 'สินค้าอะไรก็ได้',
  d.lineName ? shortOf(d.lineName) : 'ทุกไลน์',
  d.shift || 'ทุกกะ',
];

/* ── การ์ดกฎ 1 ใบในลิสต์ ───────────────────────────────────── */
const RuleCard: React.FC<{
  r: MachineRule; on: boolean; hits: number | null; canEdit: boolean; busy: boolean;
  labelOf: (n: string) => string;
  onPick: (r: MachineRule) => void;
  onToggle: (r: MachineRule) => void;
  onDelete: (r: MachineRule) => void;
}> = ({ r, on, hits, canEdit, busy, labelOf, onPick, onToggle, onDelete }) => {
  const t = TIMING_META[r.timing] || TIMING_META.start;
  return (
    <div className={`rl${on ? ' on' : ''}${r.active ? '' : ' off'}`}>
      <div className="t">
        <span>{t.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>{r.title}</div>
        {!r.active && <span className="chip mute">ปิดใช้อยู่</span>}
        {on && <span className="chip due">กำลังแก้</span>}
      </div>
      <div className="cond">
        <span className="chip mute">{t.label}</span>
        {condText(r, labelOf).map((c, i) => <span key={i} className="chip mute">{c}</span>)}
        <span className="chip freq">ความจำเพาะ {r.specificity}</span>
        {hits != null && (
          <span className={`chip ${hits ? 'km' : 'mute'}`}>{hits ? `วันนี้เข้า ${hits} รอบ` : 'วันนี้ไม่เข้ารอบไหน'}</span>
        )}
      </div>
      <div className="items">
        {r.items.map((it, i) => (
          <div key={it.key || i}>
            <span>•</span>
            <span>
              {it.title}
              {it.needPhoto && <>&nbsp;<span className="chip mute">📷 ต้องแนบรูป</span></>}
              {it.needQc && <>&nbsp;<span className="chip mute">🧪 ต้องมี QC ร่วม</span></>}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="ibtn xs" disabled={!canEdit || busy} onClick={() => onPick(r)}>✏️ แก้</button>
        <button className="ibtn xs" disabled={!canEdit || busy} onClick={() => onToggle(r)}>
          {r.active ? '⏸ ปิดใช้' : '▶︎ เปิดใช้'}
        </button>
        <button className="ibtn xs dgr" disabled={!canEdit || busy} onClick={() => onDelete(r)}>🗑</button>
        {r.ownerRole && <span className="chip mute" style={{ alignSelf: 'center' }}>👤 {roleLabel(r.ownerRole)}</span>}
      </div>
    </div>
  );
};

/* ── 1 รายการที่ต้องทำ ในฟอร์ม ─────────────────────────────── */
const ItemRow: React.FC<{
  it: RuleItem; canDelete: boolean;
  onChange: (patch: Partial<RuleItem>) => void; onDelete: () => void;
}> = ({ it, canDelete, onChange, onDelete }) => (
  <div className="itemrow">
    <div>
      <input className="ti" value={it.title} placeholder="สิ่งที่ต้องทำ เช่น ล้างหัวพิมพ์ Lot.no"
        onChange={e => onChange({ title: e.target.value })} />
      <input className="de" value={it.detail || ''} placeholder="รายละเอียด (ไม่บังคับ)"
        onChange={e => onChange({ detail: e.target.value })} />
      <div className="cbs">
        <label><input type="checkbox" checked={!!it.needPhoto} onChange={e => onChange({ needPhoto: e.target.checked })} /> 📷 ต้องแนบรูป</label>
        <label><input type="checkbox" checked={!!it.needQc} onChange={e => onChange({ needQc: e.target.checked })} /> 🧪 ต้องมี QC ร่วม</label>
      </div>
    </div>
    <button className="ibtn xs dgr" disabled={!canDelete} title="ลบรายการนี้" onClick={onDelete}>🗑</button>
  </div>
);

/* ── ฟอร์มแก้กฎ (คอลัมน์ขวา) ───────────────────────────────── */
const RuleForm: React.FC<{
  draft: Draft; lines: NameRef[]; packers: NameRef[]; busy: boolean;
  tryResult: PreviewData | null; labelOf: (n: string) => string;
  onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void; onTry: () => void;
}> = ({ draft, lines, packers, busy, tryResult, labelOf, onChange, onSave, onCancel, onTry }) => {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setItem = (i: number, patch: Partial<RuleItem>) =>
    set({ items: draft.items.map((it, n) => (n === i ? { ...it, ...patch } : it)) });
  const nItems = draft.items.filter(i => i.title.trim()).length;
  // รอบที่ร่างนี้เข้า — เซิร์ฟเวอร์ตอบกลับมาเป็น id -1 เมื่อเป็นกฎใหม่ / id เดิมเมื่อแก้ของเก่า
  const hitRuns = tryResult
    ? tryResult.runs.filter(r => Object.values(r.timings)
      .some(t => t.rules.some(x => x.id === (draft.id || -1))))
    : null;

  return (
    <div className="card rform">
      <h3 className="hd">{draft.id ? `✏️ แก้กฎ — “${draft.title || 'ไม่มีชื่อ'}”` : '＋ เพิ่มกฎใหม่'}</h3>

      <div className="fld">
        <label>ชื่อกฎ</label>
        <input autoFocus value={draft.title} onChange={e => set({ title: e.target.value })} placeholder="เช่น ล้างหัวพิมพ์ Lot.no" />
      </div>
      <div className="fld">
        <label>จังหวะที่เตือน</label>
        <select value={draft.timing} onChange={e => set({ timing: e.target.value })}>
          {TIMING_ORDER.map(k => <option key={k} value={k}>{TIMING_META[k].icon} {TIMING_META[k].label}</option>)}
        </select>
      </div>

      <div className="grouplabel">เงื่อนไข — เว้นว่าง = อะไรก็ได้</div>
      <div className="grid2">
        <div className="fld">
          <label>ไลน์ผลิต</label>
          <select value={draft.lineName} onChange={e => set({ lineName: e.target.value })}>
            <option value="">— ทุกไลน์ —</option>
            {lines.map(l => <option key={l.name} value={l.name}>{l.label}</option>)}
          </select>
        </div>
        <div className="fld">
          <label>เครื่องบรรจุ</label>
          <select value={draft.packerName} onChange={e => set({ packerName: e.target.value })}>
            <option value="">— ทุกเครื่อง —</option>
            {packers.map(p => <option key={p.name} value={p.name}>{p.label}{p.mkey ? ` · [${p.mkey.toUpperCase()}]` : ''}</option>)}
          </select>
        </div>
        <div className="fld">
          <label>สินค้ามีคำว่า</label>
          <input value={draft.productPattern} onChange={e => set({ productPattern: e.target.value })} placeholder="เว้นว่าง = ทุกสินค้า" />
        </div>
        <div className="fld">
          <label>กะ</label>
          <select value={draft.shift} onChange={e => set({ shift: e.target.value })}>
            <option value="">— ทุกกะ —</option>
            {SHIFTS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div className="fld">
        <label>ทีมที่รับผิดชอบ (ป้ายบนการ์ด)</label>
        <select value={draft.ownerRole} onChange={e => set({ ownerRole: e.target.value })}>
          {ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </select>
      </div>

      <div className="grouplabel">รายการที่ต้องทำ</div>
      {draft.items.map((it, i) => (
        <ItemRow
          key={it.key || `new${i}`} it={it} canDelete={draft.items.length > 1}
          onChange={patch => setItem(i, patch)}
          onDelete={() => set({ items: draft.items.filter((_, n) => n !== i) })}
        />
      ))}
      <button className="ibtn sm" onClick={() => set({ items: [...draft.items, { title: '', detail: '' }] })}>＋ เพิ่มรายการ</button>

      <div className="okbox" style={{ marginTop: 16 }}>
        <b>กฎนี้จะยิงเมื่อ:</b> {condText(draft, labelOf).join(' · ')} → <b>{nItems} ข้อ</b> {TIMING_META[draft.timing]?.label}
      </div>

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="ibtn" disabled={busy} onClick={onTry}>🧪 ลองกับแผนวันนี้</button>
        {hitRuns && (
          <span style={{ fontSize: 12.3, color: 'var(--ink-soft)' }}>
            {hitRuns.length
              ? <>→ เข้า <b>{hitRuns.length} รอบ</b>: {hitRuns.map(r => `${r.packerKey ? r.packerKey.toUpperCase() : '—'} · ${r.flavor} · ${r.shift}`).join(' / ')}</>
              : <>→ วันนี้<b>ไม่เข้ารอบไหนเลย</b> (จาก {tryResult?.totalRuns || 0} รอบ)</>}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 7, marginTop: 14 }}>
        <button className="ibtn pri" disabled={busy || !draft.title.trim() || !nItems} onClick={onSave}>บันทึกกฎ</button>
        <button className="ibtn" onClick={onCancel}>ยกเลิก</button>
      </div>
    </div>
  );
};

const MachineRuleEditor: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const [data, setData] = useState<RulesData | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [tryResult, setTryResult] = useState<PreviewData | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<Filter>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [wake, setWake] = useState<WakeState>('idle');

  const load = useCallback(async () => {
    try {
      const d = await mcGet<RulesData>('/api/machine-rules', setWake);
      setData(d);
      // ยิง preview ของวันนี้ครั้งเดียว แล้วเอา byRule ไปแปะบนการ์ดทุกใบ
      // (ตอบคำถาม "กฎนี้มีผลจริงไหม" ได้โดยไม่ต้องกดลองทีละตัว)
      try {
        setPreview(await mcPost<PreviewData>('/api/machine-rules/preview', { date: currentWorkDay() }));
      } catch { setPreview(null); }
    } catch (e) { setMsg({ kind: 'err', text: `โหลดกฎไม่สำเร็จ: ${(e as Error).message}` }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // ชื่อสั้นสำหรับป้ายเงื่อนไข: เครื่องบรรจุใช้รหัสในแผน ([L2] → L2) · ไลน์ใช้ชื่อที่โชว์
  const shortOf = useCallback((name: string) => {
    const p = (data?.packers || []).find(x => x.name === name);
    if (p) return p.mkey ? p.mkey.toUpperCase() : (p.label || name);
    return (data?.lines || []).find(x => x.name === name)?.label || name;
  }, [data]);

  const rules = useMemo(() => {
    const list = data?.rules || [];
    if (filter === 'off') return list.filter(r => !r.active);
    if (!filter) return list.filter(r => r.active);
    return list.filter(r => r.active && (r.timing || 'start') === filter);
  }, [data, filter]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await mcPost('/api/machine-rules', {
        id: draft.id || undefined, title: draft.title, timing: draft.timing,
        lineName: draft.lineName, packerName: draft.packerName,
        productPattern: draft.productPattern, shift: draft.shift,
        ownerRole: draft.ownerRole, note: draft.note,
        items: draft.items.filter(i => i.title.trim()),
      });
      setDraft(null); setTryResult(null);
      setMsg({ kind: 'ok', text: draft.id ? 'บันทึกกฎแล้ว' : 'เพิ่มกฎแล้ว' });
      await load();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const act = async (path: string, body: unknown, text: string) => {
    setBusy(true);
    try {
      await mcPost(path, body);
      setMsg({ kind: 'ok', text });
      await load();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const tryDraft = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setTryResult(await mcPost<PreviewData>('/api/machine-rules/preview', {
        date: currentWorkDay(),
        draft: { ...draft, items: draft.items.filter(i => i.title.trim()) },
      }));
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const pick = (r: MachineRule) => { setDraft(toDraft(r)); setTryResult(null); };
  const counts = data?.counts || { all: 0, start: 0, during: 0, end: 0, off: 0 };

  return (
    <>
      <div className="ifilters">
        <button className={`ipill${filter === '' ? ' on brand' : ''}`} onClick={() => setFilter('')}>ทั้งหมด {counts.all}</button>
        {TIMING_ORDER.map(k => (
          <button key={k} className={`ipill${filter === k ? ' on brand' : ''}`} onClick={() => setFilter(k as Filter)}>
            {TIMING_META[k].icon} {TIMING_META[k].short} {counts[k as 'start' | 'during' | 'end']}
          </button>
        ))}
        {!!counts.off && (
          <button className={`ipill${filter === 'off' ? ' on brand' : ''}`} onClick={() => setFilter('off')}>⏸ ปิดใช้ {counts.off}</button>
        )}
        <div className="sp" />
        <button className="ibtn pri" disabled={!canEdit} onClick={() => { setDraft(blankDraft()); setTryResult(null); }}>＋ เพิ่มกฎ</button>
      </div>

      {wake === 'waking' && <div className="infobox">{wakeMessage(wake)}</div>}
      {msg && (
        <div className={msg.kind === 'ok' ? 'okbox' : msg.kind === 'warn' ? 'warnbox' : 'errbox'}>
          {msg.kind === 'ok' ? '✅ ' : msg.kind === 'warn' ? '⚠️ ' : '❌ '}{msg.text}
        </div>
      )}

      <div className="rgrid">
        <div>
          {rules.map(r => (
            <RuleCard
              key={r.id} r={r} on={draft?.id === r.id} canEdit={canEdit} busy={busy} labelOf={shortOf}
              hits={preview ? Number(preview.byRule[String(r.id)] || 0) : null}
              onPick={pick}
              onToggle={x => act('/api/machine-rules/toggle', { id: x.id }, x.active ? `ปิดใช้ “${x.title}” แล้ว` : `เปิดใช้ “${x.title}” แล้ว`)}
              onDelete={x => {
                if (!window.confirm(`ลบกฎ “${x.title}” ?\nใบเช็กเก่าที่อ้างกฎนี้ยังอยู่เหมือนเดิม`)) return;
                if (draft?.id === x.id) setDraft(null);
                act('/api/machine-rules/delete', { id: x.id }, `ลบ “${x.title}” แล้ว`);
              }}
            />
          ))}
          {!rules.length && (
            <div className="card empty">
              {filter === 'off' ? 'ไม่มีกฎที่ปิดใช้อยู่' : 'ยังไม่มีกฎในหมวดนี้ — กด “＋ เพิ่มกฎ”'}
            </div>
          )}
          <div className="infobox" style={{ marginTop: 12 }}>
            กฎที่<b>จำเพาะกว่า</b>จะขึ้นก่อนในเช็กลิสต์ · ถ้าหลายกฎเข้าพร้อมกัน ข้อของทุกกฎจะถูกรวมเป็นใบเดียว (ข้อซ้ำตัดทิ้ง)
          </div>
        </div>

        {draft ? (
          <RuleForm
            draft={draft} lines={data?.lines || []} packers={data?.packers || []}
            busy={busy} tryResult={tryResult} labelOf={shortOf}
            onChange={setDraft} onSave={save} onTry={tryDraft}
            onCancel={() => { setDraft(null); setTryResult(null); }}
          />
        ) : (
          <div className="card rform">
            <h3 className="hd">🔔 กฎเตือนทำงานยังไง</h3>
            <div className="infobox">
              กฎอ่าน <b>รอบเดินเครื่องของวันนั้น</b> (แท็บ 📅 วันนี้) แล้วดูว่าเข้าเงื่อนไขไหม
              — เข้าแล้วจะกลายเป็น<b>เช็กลิสต์ให้ติ๊ก</b>และ<b>การ์ดเข้ากลุ่มช่าง</b> (ขั้นถัดไปของแผน)
            </div>
            {preview && (
              <dl className="kv">
                <dt>รอบวันนี้</dt><dd>{preview.totalRuns} รอบ</dd>
                <dt>เข้ากฎแล้ว</dt>
                <dd style={preview.hitRuns ? undefined : { color: 'var(--muted)' }}>{preview.hitRuns} รอบ</dd>
                <dt>กฎที่ใช้อยู่</dt><dd>{counts.all} กฎ{counts.off ? ` (ปิดใช้ ${counts.off})` : ''}</dd>
              </dl>
            )}
            <div style={{ marginTop: 12 }}>
              <button className="ibtn" disabled={!canEdit} onClick={() => setDraft(blankDraft())}>＋ เพิ่มกฎ</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default MachineRuleEditor;
