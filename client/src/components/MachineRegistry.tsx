/* ทะเบียนเครื่องจักร (Machine Hub) — เปลือก 4 แท็บ + แท็บ "ทะเบียน"
   ยกดีไซน์จาก mockup/machine-registry.html · สไตล์อยู่ใน ../machines.css (prefix .mcx)

   🔑 ชื่อเครื่องมี 2 ชั้น: name = คีย์จริงที่ของเดิมอ้างถึง · label = ชื่อที่โชว์
      หน้านี้โชว์ label ตัวใหญ่ แล้วต่อ name ตัวเล็กไว้ข้างล่าง เพื่อให้คนโยงกับของเดิมถูก

   ⚠️ คอมโพเนนต์ย่อยทุกตัวต้องอยู่ "นอก" ตัวหลัก — ประกาศข้างในทำให้ React ถอด/ใส่ใหม่
      ทุก render แล้วข้อความที่พิมพ์ค้างไว้หาย (บั๊กเดิมของไฟล์นี้ + ที่ AmSheetPage.tsx:43) */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppRoute } from '../hooks/useAppRoute';
import { wakeMessage, type WakeState } from '../lib/wakeFetch';
import ErrorBoundary from './ErrorBoundary';
import MachineDetail from './MachineDetail';
import MachineLinkMap from './MachineLinkMap';
import MachineRunsToday from './MachineRunsToday';
import MachineRuleEditor from './MachineRuleEditor';
import {
  GRP_META, GRP_ORDER, canEditRegistry, mcGet, mcPost,
  type Grp, type Machine,
} from '../lib/machines';
import '../machines.css';

type Tab = 'reg' | 'map' | 'today' | 'rules';
type Msg = { kind: 'ok' | 'warn' | 'err'; text: string } | null;

const blank = (): Partial<Machine> => ({ id: 0, name: '', label: '', code: '', grp: 'packer', mkey: '', spec: '', line: '', installedAt: '', lastPm: '', note: '' });

/* ── การ์ดเครื่อง 1 ใบ ─────────────────────────────────────── */
const MachineCard: React.FC<{ m: Machine; onOpen: (m: Machine) => void }> = ({ m, onOpen }) => (
  <button type="button" className={`mc ${m.grp}`} onClick={() => onOpen(m)}>
    <div className="r1">
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3>{m.label || m.name}</h3>
        <div className="key">
          ชื่อในระบบ · {m.name}
          {m.code ? ` · ${m.code}` : ''}
          {m.mkey && m.grp === 'packer' ? ` · รหัสในแผน [${m.mkey.toUpperCase()}]` : ''}
        </div>
      </div>
      {m.openIncidents > 0 && <span className="chip warn">ค้าง {m.openIncidents}</span>}
    </div>
    <div className="badges">
      {m.pmNextWeek != null && (
        <span className="chip freq">
          {m.pmFreq ? `PM ${m.pmFreq} · ` : 'PM '}รอบหน้า W{m.pmNextWeek}{m.pmRollover ? ' (ปีหน้า)' : ''}
        </span>
      )}
      {m.pmCount > 0 && <span className="chip km">งานรูทีน {m.pmCount}</span>}
      {m.ruleCount > 0 && <span className="chip due">กฎเตือน {m.ruleCount}</span>}
      {(m.grp === 'line' || m.grp === 'packer') && (
        m.linkCount > 0
          ? <span className="chip mute">{m.grp === 'line' ? 'คู่เครื่องบรรจุ' : 'คู่ไลน์'} {m.linkCount}</span>
          : <span className="chip warn">ยังไม่ผูกคู่</span>
      )}
    </div>
    {m.vaultPath && <div className="lnk">📄 {m.vaultPath}</div>}
  </button>
);

/* ── ฟอร์มเพิ่ม/แก้เครื่อง (modal) ─────────────────────────── */
const MachineForm: React.FC<{
  draft: Partial<Machine>;
  busy: boolean;
  onSave: (m: Partial<Machine>) => void;
  onClose: () => void;
}> = ({ draft, busy, onSave, onClose }) => {
  const [d, setD] = useState<Partial<Machine>>(draft);
  const set = (patch: Partial<Machine>) => setD(v => ({ ...v, ...patch }));
  const isNew = !d.id;
  return (
    <div className="mcx-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="box mcx">
        <h3>{isNew ? '＋ เพิ่มเข้าทะเบียนเครื่องจักร' : '✏️ แก้ไขข้อมูลเครื่อง'}</h3>
        <div className="hint">
          {isNew
            ? 'เพิ่มแล้วจะโผล่ในผังเชื่อมโยงและในตัวเลือกของฟอร์มผูกคู่ทันที'
            : 'ชื่อที่โชว์แก้ได้อิสระ — ส่วน “ชื่อในระบบ” คือคีย์ที่ของเดิมอ้างถึง เปลี่ยนแล้วระบบจะตามไปแก้ให้'}
        </div>
        <div className="fld">
          <label>ชื่อที่โชว์</label>
          <input autoFocus value={d.label || ''} onChange={e => set({ label: e.target.value })} placeholder="เช่น เครื่องบรรจุ L2" />
        </div>
        <div className="fld">
          <label>ชื่อในระบบ (คีย์ — ทะเบียนงานรูทีน/เหตุการณ์/โน้ต vault อ้างชื่อนี้)</label>
          <input value={d.name || ''} onChange={e => set({ name: e.target.value })} placeholder="เช่น ไลน์ L2" />
        </div>
        <div className="grid2">
          <div className="fld">
            <label>หมวด</label>
            <select value={d.grp || 'packer'} onChange={e => set({ grp: e.target.value as Grp })}>
              {GRP_ORDER.map(g => <option key={g} value={g}>{GRP_META[g].icon} {GRP_META[g].label}</option>)}
            </select>
          </div>
          <div className="fld">
            <label>รหัสในแผนบรรจุ (เฉพาะเครื่องบรรจุ)</label>
            <input value={d.mkey || ''} onChange={e => set({ mkey: e.target.value.trim().toLowerCase() })} placeholder="เช่น l2 / a1" />
          </div>
          <div className="fld"><label>รหัสเครื่อง</label><input value={d.code || ''} onChange={e => set({ code: e.target.value })} placeholder="เช่น MC-014" /></div>
          <div className="fld"><label>ยี่ห้อ/รุ่น</label><input value={d.spec || ''} onChange={e => set({ spec: e.target.value })} placeholder="เช่น Lina Pack — Linear#2" /></div>
          <div className="fld"><label>วันที่ติดตั้ง</label><input type="date" value={d.installedAt || ''} onChange={e => set({ installedAt: e.target.value })} /></div>
          <div className="fld"><label>PM ล่าสุด</label><input type="date" value={d.lastPm || ''} onChange={e => set({ lastPm: e.target.value })} /></div>
        </div>
        <div className="fld">
          <label>จุดที่มักมีปัญหา / หมายเหตุ</label>
          <textarea rows={2} value={d.note || ''} onChange={e => set({ note: e.target.value })} style={{ resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          <button className="ibtn pri" disabled={busy || !String(d.label || d.name || '').trim()} onClick={() => onSave(d)}>บันทึก</button>
          <button className="ibtn" onClick={onClose}>ยกเลิก</button>
        </div>
      </div>
    </div>
  );
};

const MachineRegistry: React.FC = () => {
  const [route, navigate] = useAppRoute();
  const [tab, setTab] = useState<Tab>('reg');
  const [list, setList] = useState<Machine[]>([]);
  const [q, setQ] = useState('');
  const [grpFilter, setGrpFilter] = useState<Grp | ''>('');
  const [showTool, setShowTool] = useState(false);
  const [edit, setEdit] = useState<Partial<Machine> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [wake, setWake] = useState<WakeState>('idle');
  const canEdit = canEditRegistry();

  const openId = route.item && /^\d+$/.test(route.item) ? Number(route.item) : 0;

  const load = useCallback(async () => {
    try {
      const d = await mcGet<{ machines: Machine[] }>('/api/machines', setWake);
      setList(Array.isArray(d.machines) ? d.machines : []);
    } catch (e) { setMsg({ kind: 'err', text: `โหลดทะเบียนไม่สำเร็จ: ${(e as Error).message}` }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (m: Partial<Machine>) => {
    const name = String(m.name || m.label || '').trim();
    if (!name) return;
    setBusy(true);
    try {
      const d = await mcPost<{ vaultPath?: string; vaultSkipped?: string; vaultError?: string }>('/api/machines', {
        id: m.id || undefined, name, label: m.label || name, code: m.code || '', grp: m.grp || 'tool',
        mkey: m.mkey || '', spec: m.spec || '', line: m.line || '',
        installedAt: m.installedAt || '', lastPm: m.lastPm || '', note: m.note || '',
      });
      setEdit(null);
      setMsg({
        kind: d.vaultError ? 'warn' : 'ok',
        text: d.vaultPath ? `บันทึกแล้ว · อัปเดตโน้ต ${d.vaultPath}`
          : d.vaultSkipped ? `บันทึกแล้ว (${d.vaultSkipped} — โน้ตยังไม่ถูกเขียน)`
            : d.vaultError ? `บันทึกแล้ว แต่เขียนโน้ตไม่สำเร็จ: ${d.vaultError}` : 'บันทึกแล้ว',
      });
      await load();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const syncAll = async () => {
    setBusy(true); setMsg({ kind: 'ok', text: 'กำลังเขียนโน้ตทุกเครื่อง…' });
    try {
      const d = await mcPost<{ written: number; total: number; skipped?: string; failed?: { name: string }[] }>('/api/machines/sync-notes', {});
      setMsg(d.skipped ? { kind: 'warn', text: d.skipped }
        : d.failed?.length ? { kind: 'warn', text: `เขียนได้ ${d.written}/${d.total} · พลาด: ${d.failed.map(f => f.name).join(', ')}` }
          : { kind: 'ok', text: `เขียนโน้ตครบ ${d.written}/${d.total} เครื่อง ลงโฟลเดอร์ เครื่องจักร` });
      await load();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (m: Machine) => !needle
      || m.name.toLowerCase().includes(needle)
      || (m.label || '').toLowerCase().includes(needle)
      || (m.code || '').toLowerCase().includes(needle)
      || (m.mkey || '').toLowerCase().includes(needle);
    const out = {} as Record<Grp, Machine[]>;
    for (const g of GRP_ORDER) out[g] = [];
    for (const m of list) if (hit(m)) (out[m.grp] || out.tool).push(m);
    return out;
  }, [list, q]);

  const stat = useMemo(() => ({
    lines: list.filter(m => m.grp === 'line').length,
    packers: list.filter(m => m.grp === 'packer').length,
    unlinked: list.filter(m => (m.grp === 'line' || m.grp === 'packer') && !m.linkCount).length,
    openInc: list.reduce((n, m) => n + (m.openIncidents || 0), 0),
    pairs: 0,
  }), [list]);

  const openMachine = (m: Machine) => navigate({ item: String(m.id) });
  const closeDetail = () => { navigate({ item: null }); load(); };

  if (openId) {
    return (
      <div className="mcx">
        <ErrorBoundary label="machine-detail">
          <MachineDetail id={openId} canEdit={canEdit} onBack={closeDetail} onEdit={m => setEdit(m)} />
        </ErrorBoundary>
        {edit && <MachineForm draft={edit} busy={busy} onSave={save} onClose={() => setEdit(null)} />}
      </div>
    );
  }

  return (
    <div className="mcx">
      <div className="eyebrow">📚 Knowledge management</div>
      <div className="phead">
        <h1>ทะเบียนเครื่องจักร</h1>
        <div className="sub">
          {list.length} เครื่อง · ไลน์ผลิต {stat.lines} · เครื่องบรรจุ {stat.packers}
        </div>
        <div className="sp" />
        <button className="ibtn" onClick={syncAll} disabled={busy || !canEdit}>🔄 ซิงก์โน้ตเข้า Obsidian</button>
        <button className="ibtn pri" onClick={() => setEdit(blank())} disabled={!canEdit}>＋ เพิ่มเครื่องจักร</button>
      </div>

      <div className="itabs">
        <button className={`itab${tab === 'reg' ? ' on' : ''}`} onClick={() => setTab('reg')}>🗂 ทะเบียน<span className="n">{list.length}</span></button>
        <button className={`itab${tab === 'map' ? ' on' : ''}`} onClick={() => setTab('map')}>🔗 ผังเชื่อมโยง</button>
        <button className={`itab${tab === 'today' ? ' on' : ''}`} onClick={() => setTab('today')}>📅 วันนี้</button>
        <button className={`itab${tab === 'rules' ? ' on' : ''}`} onClick={() => setTab('rules')}>⚙️ กฎเตือน</button>
      </div>

      {wake === 'waking' && <div className="infobox" style={{ marginTop: 12 }}>{wakeMessage(wake)}</div>}
      {!canEdit && <div className="infobox" style={{ marginTop: 12 }}>👀 โหมดดูอย่างเดียว — แก้ทะเบียน/ผูกคู่ได้เฉพาะหัวหน้าขึ้นไป</div>}
      {msg && (
        <div className={msg.kind === 'ok' ? 'okbox' : msg.kind === 'warn' ? 'warnbox' : 'errbox'} style={{ marginTop: 12 }}>
          {msg.kind === 'ok' ? '✅ ' : msg.kind === 'warn' ? '⚠️ ' : '❌ '}{msg.text}
        </div>
      )}

      {tab === 'reg' && (
        <>
          <div className="ifilters">
            <input className="iinp" placeholder="🔎 ค้นหาชื่อเครื่อง / รหัส" value={q} onChange={e => setQ(e.target.value)} />
            <div className="divider" />
            <button className={`ipill${grpFilter === '' ? ' on brand' : ''}`} onClick={() => setGrpFilter('')}>ทั้งหมด {list.length}</button>
            {GRP_ORDER.map(g => (
              <button key={g} className={`ipill${grpFilter === g ? ' on brand' : ''}`} onClick={() => setGrpFilter(g)}>
                {GRP_META[g].icon} {GRP_META[g].label} {list.filter(m => m.grp === g).length}
              </button>
            ))}
          </div>

          <div className="istats">
            <div className="istat"><div className="l">🏭 ไลน์ผลิต</div><div className="v">{stat.lines}<span className="u">ไลน์</span></div></div>
            <div className="istat"><div className="l">📦 เครื่องบรรจุ</div><div className="v">{stat.packers}<span className="u">เครื่อง</span></div></div>
            <div className={`istat${stat.unlinked ? ' gap' : ''}`}><div className="l">🔗 ยังไม่ผูกคู่</div><div className="v">{stat.unlinked}<span className="u">เครื่อง</span></div></div>
            <div className={`istat${stat.openInc ? ' hot' : ''}`}><div className="l">⚡ เหตุการณ์ค้าง</div><div className="v">{stat.openInc}<span className="u">ใบ</span></div></div>
          </div>

          {GRP_ORDER.filter(g => !grpFilter || g === grpFilter).map(g => {
            const rows = groups[g];
            if (!rows.length) return null;
            const folded = g === 'tool' && !showTool && !grpFilter && !q.trim();
            return (
              <div className="gsec" key={g}>
                <div className="ghead">
                  <h2>{GRP_META[g].icon} {GRP_META[g].label}</h2>
                  <span className="gc">{rows.length}</span>
                  <span className="gd">{GRP_META[g].desc}</span>
                  {g === 'tool' && !grpFilter && !q.trim() && (
                    <>
                      <div className="sp" />
                      <button className="ibtn sm" onClick={() => setShowTool(v => !v)}>
                        {showTool ? '▴ ซ่อน' : `▾ แสดง ${rows.length} รายการ`}
                      </button>
                    </>
                  )}
                </div>
                {!folded && (
                  <div className="mgrid">
                    {rows.map(m => <MachineCard key={m.id} m={m} onOpen={openMachine} />)}
                  </div>
                )}
              </div>
            );
          })}

          {!list.length && <div className="card empty">ยังไม่มีเครื่องจักรในทะเบียน — กด “＋ เพิ่มเครื่องจักร”</div>}
          {!!list.length && !GRP_ORDER.some(g => groups[g].length) && (
            <div className="card empty">ไม่พบเครื่องที่ตรงกับ “{q}”</div>
          )}
        </>
      )}

      {tab === 'map' && (
        <ErrorBoundary label="machine-linkmap">
          <MachineLinkMap canEdit={canEdit} machines={list} onChanged={load} />
        </ErrorBoundary>
      )}

      {tab === 'today' && (
        <ErrorBoundary label="machine-runs">
          <MachineRunsToday canEdit={canEdit} />
        </ErrorBoundary>
      )}
      {tab === 'rules' && (
        <ErrorBoundary label="machine-rules">
          <MachineRuleEditor canEdit={canEdit} />
        </ErrorBoundary>
      )}

      {edit && <MachineForm draft={edit} busy={busy} onSave={save} onClose={() => setEdit(null)} />}
    </div>
  );
};

export default MachineRegistry;
