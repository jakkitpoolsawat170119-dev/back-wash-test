/* ผังเชื่อมโยง — ไลน์ผลิต ↔ เครื่องบรรจุ ↔ สินค้าประจำคู่
   คู่ที่ผูกไว้ = "เป็นไปได้" ไม่ใช่ของตายตัว · ของจริงรายวันเลือกที่แท็บ "วันนี้" (ขั้นถัดไป)

   🔑 สินค้าประจำคู่คือหัวใจ — เป็นตัวที่ทำให้ระบบเดาได้ว่า "วันนี้ L2 ผลิต Amazon → ป้อนจากไลน์ไหน"
      โดยไม่ต้องถามคน แม้เครื่องบรรจุตัวนั้นจะรับได้หลายไลน์                                */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { wakeMessage, type WakeState } from '../lib/wakeFetch';
import { mcGet, mcPost, cleanFlavor, type LinkRow, type LinkProduct, type Machine, type SideRef } from '../lib/machines';

interface Suggestion { packerName: string; packerLabel: string; flavor: string; skuCode: string; count: number; lastDay: string }
interface Draft { id: number; lineName: string; packerName: string; note: string; products: LinkProduct[] }

/* ── ผัง SVG — วาดใหม่จากข้อมูลทุกครั้ง · เส้นส้ม = คู่ที่ระบุสินค้าแล้ว ── */
const LinkSvg: React.FC<{ lines: SideRef[]; packers: SideRef[]; links: LinkRow[] }> = ({ lines, packers, links }) => {
  const LH = 46, LG = 24, PH = 32, PG = 6, TOP = 32, X1 = 20, W1 = 210, X2 = 560, W2 = 300;
  if (!lines.length || !packers.length) return null;
  const totalL = lines.length * LH + (lines.length - 1) * LG;
  const totalP = packers.length * PH + (packers.length - 1) * PG;
  const maxT = Math.max(totalL, totalP);
  const H = TOP + maxT + 18;
  const ly = (i: number) => TOP + (maxT - totalL) / 2 + i * (LH + LG);
  const py = (j: number) => TOP + (maxT - totalP) / 2 + j * (PH + PG);

  const prodOfLine = (name: string) => {
    const all = links.filter(l => l.lineName === name).flatMap(l => l.products.map(p => cleanFlavor(p.flavor)));
    const uniq = [...new Set(all)].filter(Boolean);
    return uniq.length ? uniq.slice(0, 2).join(' · ') + (uniq.length > 2 ? ' …' : '') : 'ยังไม่ระบุสินค้า';
  };

  return (
    <svg viewBox={`0 0 880 ${H}`} width="100%" height={H} role="img" aria-label="ผังไลน์ผลิตเชื่อมกับเครื่องบรรจุ">
      <text className="colhead" x={20} y={16}>🏭 ไลน์ผลิต ({lines.length})</text>
      <text className="colhead" x={X2} y={16}>📦 เครื่องบรรจุ ({packers.length})</text>
      {links.map(l => {
        const i = lines.findIndex(x => x.name === l.lineName);
        const j = packers.findIndex(x => x.name === l.packerName);
        if (i < 0 || j < 0) return null;
        const y1 = ly(i) + LH / 2, y2 = py(j) + PH / 2;
        return (
          <path key={l.id} className={`edge${l.products.length ? ' hot' : ''}`}
            d={`M${X1 + W1},${y1} C${X1 + W1 + 150},${y1} ${X2 - 150},${y2} ${X2},${y2}`} />
        );
      })}
      {lines.map((l, i) => (
        <g key={l.name}>
          <rect className="nodebox line" x={X1} y={ly(i)} width={W1} height={LH} rx={11} />
          <text x={X1 + 16} y={ly(i) + 20}>{l.label}</text>
          <text className="sm" x={X1 + 16} y={ly(i) + 36}>{prodOfLine(l.name)}</text>
        </g>
      ))}
      {packers.map((p, j) => {
        const on = links.some(l => l.packerName === p.name);
        return (
          <g key={p.name}>
            <rect className={`nodebox ${on ? 'packer' : 'off'}`} x={X2} y={py(j)} width={W2} height={PH} rx={9} />
            <text className={on ? '' : 'off'} x={X2 + 16} y={py(j) + 21}>
              {p.label}{on && p.mkey ? ` · [${p.mkey.toUpperCase()}]` : ''}{on ? '' : ' — ยังไม่ผูกคู่'}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

/* ── ฟอร์มผูก/แก้คู่ (แทรกเป็นแถวในตาราง) ─────────────────── */
const LinkForm: React.FC<{
  draft: Draft; lines: SideRef[]; packers: SideRef[]; busy: boolean; err: string;
  onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void;
}> = ({ draft, lines, packers, busy, err, onChange, onSave, onCancel }) => {
  const [text, setText] = useState('');
  const addProduct = () => {
    const v = text.trim();
    if (!v) return;
    if (!draft.products.some(p => p.flavor.toLowerCase() === v.toLowerCase())) {
      onChange({ ...draft, products: [...draft.products, { flavor: v }] });
    }
    setText('');
  };
  return (
    <tr className="editrow">
      <td colSpan={5} style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <b style={{ fontFamily: 'var(--font-head)', fontSize: 13.5 }}>{draft.id ? '✏️ แก้ไขคู่' : '＋ ผูกคู่ใหม่'}</b>
        </div>
        <div className="grid2">
          <div className="fld">
            <label>ไลน์ผลิต</label>
            <select value={draft.lineName} onChange={e => onChange({ ...draft, lineName: e.target.value })}>
              {lines.map(l => <option key={l.name} value={l.name}>{l.label}</option>)}
            </select>
          </div>
          <div className="fld">
            <label>เครื่องบรรจุ</label>
            <select value={draft.packerName} onChange={e => onChange({ ...draft, packerName: e.target.value })}>
              {packers.map(p => <option key={p.name} value={p.name}>{p.label}</option>)}
            </select>
          </div>
        </div>
        <div className="fld">
          <label>สินค้าประจำคู่ — พิมพ์แล้วกด Enter · กดที่ชิปเพื่อลบ</label>
          <div className="prodbox">
            {draft.products.map((p, i) => (
              <button type="button" className="pchip on" key={i}
                onClick={() => onChange({ ...draft, products: draft.products.filter((_, k) => k !== i) })}>
                {p.flavor} ✕
              </button>
            ))}
            <input
              value={text} placeholder="เพิ่มสินค้า…"
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addProduct(); } }}
              onBlur={addProduct}
            />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>
            ใช้ตัดสินว่า “วันนี้เครื่องนี้ผลิตสินค้าตัวนี้ → ป้อนจากไลน์ไหน” โดยไม่ต้องถามคน
          </div>
        </div>
        <div className="fld">
          <label>หมายเหตุ</label>
          <input value={draft.note} onChange={e => onChange({ ...draft, note: e.target.value })} />
        </div>
        {err && <div className="errbox">⚠️ {err}</div>}
        <div style={{ display: 'flex', gap: 7 }}>
          <button className="ibtn pri sm" disabled={busy} onClick={onSave}>บันทึก</button>
          <button className="ibtn sm" onClick={onCancel}>ยกเลิก</button>
        </div>
      </td>
    </tr>
  );
};

const MachineLinkMap: React.FC<{ canEdit: boolean; machines: Machine[]; onChanged: () => void }> = ({ canEdit, machines, onChanged }) => {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [lines, setLines] = useState<SideRef[]>([]);
  const [packers, setPackers] = useState<SideRef[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [wake, setWake] = useState<WakeState>('idle');
  const [sugg, setSugg] = useState<Suggestion[] | null>(null);
  const [suggNote, setSuggNote] = useState('');
  const [suggLine, setSuggLine] = useState<Record<number, string>>({});
  const [needPick, setNeedPick] = useState<number | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const d = await mcGet<{ links: LinkRow[]; lines: SideRef[]; packers: SideRef[] }>('/api/machine-links', setWake);
      setLinks(d.links || []); setLines(d.lines || []); setPackers(d.packers || []);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load, machines.length]);

  const openNew = () => {
    if (!lines.length || !packers.length) { setErr('ต้องมีทั้งไลน์ผลิตและเครื่องบรรจุในทะเบียนก่อนถึงจะผูกคู่ได้'); return; }
    setFormErr('');
    setDraft({ id: 0, lineName: lines[0].name, packerName: packers[0].name, note: '', products: [] });
  };
  const openEdit = (l: LinkRow) => {
    setFormErr('');
    setDraft({ id: l.id, lineName: l.lineName, packerName: l.packerName, note: l.note, products: l.products.map(p => ({ ...p })) });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true); setFormErr('');
    try {
      await mcPost('/api/machine-links', {
        id: draft.id || undefined, lineName: draft.lineName, packerName: draft.packerName,
        note: draft.note, products: draft.products.map(p => ({ flavor: p.flavor, skuCode: p.skuCode || '' })),
      });
      setDraft(null);
      await load(); onChanged();
    } catch (e) { setFormErr((e as Error).message); } finally { setBusy(false); }
  };

  const del = async (l: LinkRow) => {
    if (!window.confirm(`เอาคู่ "${l.lineLabel} ↔ ${l.packerLabel}" ออก?\n(สินค้าประจำคู่จะถูกปิดไปด้วย แต่ไม่ได้ลบทิ้ง)`)) return;
    setBusy(true);
    try { await mcPost('/api/machine-links/delete', { id: l.id }); await load(); onChanged(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const loadSuggest = async () => {
    setBusy(true); setErr('');
    try {
      const d = await mcGet<{ suggestions: Suggestion[]; note: string }>('/api/machine-links/suggest');
      setSugg(d.suggestions || []); setSuggNote(d.note || '');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /* รับข้อเสนอ → ต้องเลือกไลน์เองก่อน
     ใบลงยอดผลิตไม่มีข้อมูลไลน์ต้ม ระบบจึงเดาให้ไม่ได้ ห้ามเติมมั่ว */
  const takeSuggest = async (s: Suggestion, i: number) => {
    const lineName = suggLine[i] || '';
    if (!lineName) { setNeedPick(i); return; }
    setBusy(true); setNeedPick(null);
    try {
      const exist = links.find(l => l.lineName === lineName && l.packerName === s.packerName);
      const products = exist ? [...exist.products.map(p => ({ flavor: p.flavor })), { flavor: s.flavor }] : [{ flavor: s.flavor }];
      await mcPost('/api/machine-links', { id: exist?.id, lineName, packerName: s.packerName, products });
      setSugg(prev => (prev || []).filter((_, k) => k !== i));
      await load(); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const unlinkedPackers = useMemo(() => packers.filter(p => !links.some(l => l.packerName === p.name)).length, [packers, links]);

  return (
    <>
      <div className="ifilters">
        <button className="ibtn pri" onClick={openNew} disabled={!canEdit || busy}>＋ ผูกคู่ใหม่</button>
        <div className="divider" />
        <button className="ibtn ext" onClick={loadSuggest} disabled={busy}>🔍 หาสินค้าจากประวัติการผลิต</button>
      </div>

      <div className="okbox">
        🔗 <b>คู่ที่ผูกไว้ = “เป็นไปได้”</b> ไม่ใช่ของตายตัว — วันจริงระบบจะเลือกให้จากแผนบรรจุ แล้วคนยืนยัน/แก้ได้
        <br />ถ้าใส่ <b>สินค้าประจำคู่</b> ไว้ ระบบจะเดาไลน์ถูกทันทีแม้เครื่องบรรจุตัวนั้นรับได้หลายไลน์ — คู่ที่มีสินค้าแล้วจะเป็น<b>เส้นสีส้ม</b>ในผัง
      </div>

      {wake === 'waking' && <div className="infobox">{wakeMessage(wake)}</div>}
      {err && <div className="errbox">❌ {err}</div>}

      <div className="card mapcard" style={{ marginBottom: 14 }}>
        {lines.length && packers.length
          ? <LinkSvg lines={lines} packers={packers} links={links} />
          : <div className="empty">ยังไม่มีไลน์ผลิตหรือเครื่องบรรจุในทะเบียน</div>}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 16px 0', flexWrap: 'wrap' }}>
          <h3 className="hd" style={{ margin: 0 }}>รายการคู่ที่ผูกไว้</h3>
          <span className="chip mute">{links.length} คู่</span>
          {unlinkedPackers > 0 && <span className="chip warn">เครื่องบรรจุที่ยังไม่ผูกคู่ {unlinkedPackers}</span>}
          <div className="sp" />
          <button className="ibtn sm pri" onClick={openNew} disabled={!canEdit || busy}>＋ ผูกคู่ใหม่</button>
        </div>
        <div className="scrollx" style={{ padding: '10px 4px 6px' }}>
          <table className="tb">
            <thead>
              <tr>
                <th>ไลน์ผลิต</th><th>เครื่องบรรจุ</th><th>สินค้าประจำคู่</th><th>หมายเหตุ</th>
                <th style={{ textAlign: 'right' }}>จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {draft && !draft.id && (
                <LinkForm draft={draft} lines={lines} packers={packers} busy={busy} err={formErr}
                  onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />
              )}
              {links.map(l => (draft && draft.id === l.id ? (
                <LinkForm key={l.id} draft={draft} lines={lines} packers={packers} busy={busy} err={formErr}
                  onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />
              ) : (
                <tr key={l.id}>
                  <td><b>{l.lineLabel}</b></td>
                  <td>{l.packerLabel}</td>
                  <td>
                    <div className="pchips">
                      {l.products.length
                        ? l.products.map((p, i) => <span className="pchip on" key={p.id ?? i}>{cleanFlavor(p.flavor)}</span>)
                        : <span className="pchip">ยังไม่ระบุ</span>}
                    </div>
                  </td>
                  <td style={{ color: 'var(--ink-soft)' }}>{l.note || '—'}</td>
                  <td>
                    <div className="rowacts">
                      <button className="ibtn xs" disabled={!canEdit || busy} onClick={() => openEdit(l)}>✏️ แก้</button>
                      <button className="ibtn xs dgr" disabled={!canEdit || busy} onClick={() => del(l)}>🗑</button>
                    </div>
                  </td>
                </tr>
              )))}
              {!links.length && !draft && (
                <tr><td colSpan={5}><div className="empty">ยังไม่ได้ผูกคู่เลย — กด “＋ ผูกคู่ใหม่”</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {sugg && (
        <div className="card" style={{ marginTop: 14, padding: '15px 17px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <h3 className="hd" style={{ margin: 0 }}>🔍 สินค้าที่เคยวิ่งบนเครื่องจริง — กดรับทีละรายการ</h3>
            <div className="sp" />
            <button className="ibtn xs" onClick={() => setSugg(null)}>ปิด</button>
          </div>
          <div className="warnbox" style={{ margin: '11px 0' }}>
            {suggNote || 'อ่านจากใบลงยอดผลิตย้อนหลัง 90 วัน'} · <b>คนเป็นคนเลือกไลน์เอง</b> · ระบบไม่บันทึกอะไรจนกว่าจะกดรับ
          </div>
          <div className="scrollx">
            <table className="tb">
              <thead>
                <tr><th>เครื่องบรรจุ</th><th>สินค้าที่เคยวิ่ง</th><th className="num">เจอกี่ครั้ง</th><th>ป้อนจากไลน์</th><th /></tr>
              </thead>
              <tbody>
                {sugg.length ? sugg.map((s, i) => (
                  <tr key={`${s.packerName}|${s.flavor}`}>
                    <td><b>{s.packerLabel}</b></td>
                    <td><span className="pchip">{cleanFlavor(s.flavor)}</span></td>
                    <td className="num">{s.count}</td>
                    <td>
                      <select
                        className={`lsel${needPick === i ? ' needpick' : ''}`}
                        value={suggLine[i] || ''}
                        onChange={e => { setSuggLine(v => ({ ...v, [i]: e.target.value })); setNeedPick(null); }}
                      >
                        <option value="">— เลือกไลน์ —</option>
                        {lines.map(l => <option key={l.name} value={l.name}>{l.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <div className="rowacts">
                        <button className="ibtn xs ok" disabled={!canEdit || busy} onClick={() => takeSuggest(s, i)}>✓ รับ</button>
                        <button className="ibtn xs" onClick={() => setSugg(prev => (prev || []).filter((_, k) => k !== i))}>ข้าม</button>
                      </div>
                    </td>
                  </tr>
                )) : <tr><td colSpan={5}><div className="empty">ไม่มีสินค้าใหม่ให้เสนอ</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
};

export default MachineLinkMap;
