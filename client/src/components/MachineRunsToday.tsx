/* รอบเดินเครื่องวันนี้ — แผนบรรจุรายกะ → "เครื่องไหน ผลิตอะไร ป้อนจากไลน์ไหน"
   ยกดีไซน์จาก mockup/machine-registry.html แท็บ 📅 วันนี้

   🔴 ที่เดียวในแอปที่ยิง ?seed=1 ได้ — เส้นนี้เท่านั้นที่สร้างรอบจากแผน
      หน้าอื่น/วันย้อนหลังต้องอ่านอย่างเดียว ไม่งั้นเปิดดูปฏิทินย้อนหลังแล้วได้รอบเปล่าเป็นร้อย
      (บทเรียนจากใบเช็ก AM) · ปุ่มดึงแผนจึงหายไปเองเมื่อเลือกวันย้อนหลัง (canSeed=false)

   🔑 ของที่คนแก้ชนะแผนเสมอ — เลือกไลน์เองแล้วตัวเดาจะไม่ทับ · แก้สินค้า/เป้าแล้วทั้งแถวถูกล็อก

   ⚠️ คอมโพเนนต์ย่อยต้องอยู่นอกตัวหลัก (ประกาศข้างใน = React ถอด/ใส่ใหม่ทุก render
      แล้วข้อความที่พิมพ์ค้างในฟอร์มหาย — บั๊กเดิมของ MachineRegistry.tsx)            */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { wakeMessage, type WakeState } from '../lib/wakeFetch';
import { currentWorkDay, shiftInfo } from '../shiftSchedule';
import {
  mcGet, mcPost, roleLabel, LINE_SOURCE_LABEL, RUN_STATUS_META, TIMING_META, TIMING_ORDER,
  type MachineRun, type NameRef, type PreviewData, type RunsData,
} from '../lib/machines';

type Msg = { kind: 'ok' | 'warn' | 'err'; text: string } | null;
interface Draft {
  id: number; workDay: string; shift: string;
  packerName: string; lineName: string; flavor: string; targetBoxes: string; note: string;
}

const num = (n: number | null) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

// กะปัจจุบันในรูปเดียวกับ shift_plans ('กะเช้า/กะบ่าย/กะดึก') — เสาร์ไม่มีกะปกติ คืน ''
function nowShift(): string {
  const bkk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const info = shiftInfo(bkk.toLocaleDateString('sv-SE'), bkk.getHours());
  return info.shift ? `กะ${info.shift}` : '';
}

/* ── ฟอร์มเพิ่ม/แก้รอบ (modal) ─────────────────────────────── */
const RunForm: React.FC<{
  draft: Draft; packers: NameRef[]; lines: NameRef[]; shifts: string[];
  busy: boolean; onSave: (d: Draft) => void; onClose: () => void;
}> = ({ draft, packers, lines, shifts, busy, onSave, onClose }) => {
  const [d, setD] = useState<Draft>(draft);
  const set = (patch: Partial<Draft>) => setD(v => ({ ...v, ...patch }));
  const isNew = !d.id;
  return (
    <div className="mcx-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="box mcx">
        <h3>{isNew ? '＋ เพิ่มรอบเดินเครื่องเอง' : '✏️ แก้ไขรอบเดินเครื่อง'}</h3>
        <div className="hint">
          {isNew
            ? 'สำหรับรอบที่ไม่ได้อยู่ในแผนบรรจุ — เพิ่มแล้วจะไม่ถูกแผนทับ'
            : 'แก้สินค้า / เป้า / เครื่อง แล้วแถวนี้จะถูกล็อกจากการดึงแผนใหม่ถาวร'}
        </div>
        {isNew && (
          <div className="grid2">
            <div className="fld"><label>วันทำงาน</label>
              <input type="date" value={d.workDay} onChange={e => set({ workDay: e.target.value })} /></div>
            <div className="fld"><label>กะ</label>
              <select value={d.shift} onChange={e => set({ shift: e.target.value })}>
                {shifts.map(s => <option key={s} value={s}>{s}</option>)}
              </select></div>
          </div>
        )}
        <div className="fld">
          <label>เครื่องบรรจุ</label>
          <select value={d.packerName} onChange={e => set({ packerName: e.target.value })}>
            <option value="">— เลือกเครื่องบรรจุ —</option>
            {packers.map(p => <option key={p.name} value={p.name}>{p.label}{p.mkey ? ` · [${p.mkey.toUpperCase()}]` : ''}</option>)}
          </select>
        </div>
        <div className="fld">
          <label>สินค้า</label>
          <input autoFocus value={d.flavor} onChange={e => set({ flavor: e.target.value })} placeholder="เช่น Amazon 850×12" />
        </div>
        <div className="grid2">
          <div className="fld">
            <label>ไลน์ต้มที่ป้อน</label>
            <select value={d.lineName} onChange={e => set({ lineName: e.target.value })}>
              <option value="">— ยังไม่เลือก —</option>
              {lines.map(l => <option key={l.name} value={l.name}>{l.label}</option>)}
            </select>
          </div>
          <div className="fld">
            <label>เป้า (กล่อง)</label>
            <input inputMode="numeric" value={d.targetBoxes} onChange={e => set({ targetBoxes: e.target.value.replace(/[^\d]/g, '') })} />
          </div>
        </div>
        <div className="fld">
          <label>หมายเหตุ</label>
          <input value={d.note} onChange={e => set({ note: e.target.value })} placeholder="เช่น เดินครึ่งกะ" />
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          <button className="ibtn pri" disabled={busy || !d.flavor.trim() || (isNew && !d.packerName)} onClick={() => onSave(d)}>บันทึก</button>
          <button className="ibtn" onClick={onClose}>ยกเลิก</button>
        </div>
      </div>
    </div>
  );
};

/* ── 1 แถวในตาราง ──────────────────────────────────────────── */
const RunRow: React.FC<{
  r: MachineRun; lines: NameRef[]; candidates: string[]; canEdit: boolean; busy: boolean;
  split: number;                                    // >1 = แผนบรรจุบรรทัดเดียวกันลงหลายเครื่อง
  onLine: (r: MachineRun, line: string) => void;
  onStatus: (r: MachineRun, to: string) => void;
  onEdit: (r: MachineRun) => void;
}> = ({ r, lines, candidates, canEdit, busy, split, onLine, onStatus, onEdit }) => {
  const st = RUN_STATUS_META[r.status] || RUN_STATUS_META.draft;
  const dead = r.status === 'cancelled';
  // ไลน์ที่ผูกคู่ไว้กับเครื่องนี้ขึ้นก่อน แล้วค่อยไลน์ที่เหลือ — เลือกไลน์นอกคู่ได้ แต่ต้องตั้งใจเลื่อนหา
  const near = lines.filter(l => candidates.includes(l.name));
  const far = lines.filter(l => !candidates.includes(l.name));
  return (
    <tr style={dead ? { opacity: .55 } : undefined}>
      <td>
        <b>{r.packerKey ? r.packerKey.toUpperCase() : (r.packerLabel || '—')}</b>
        <div className="rsub">{r.packerName || '⚠️ ยังไม่รู้ว่าเครื่องไหน'}</div>
      </td>
      <td>
        {r.flavor || '—'}
        <div className="rsub">
          {r.skuCode ? `SKU ${r.skuCode}` : 'ยังจับคู่ SKU ไม่ได้'}
          {split > 1 ? ` · แผนเดียวกันลง ${split} เครื่อง` : ''}
        </div>
      </td>
      <td>
        <select
          className={`lsel${r.lineName ? '' : ' needpick'}`}
          value={r.lineName} disabled={!canEdit || busy || dead}
          onChange={e => onLine(r, e.target.value)}
        >
          <option value="">{r.lineName ? '— ล้างไลน์ —' : '— ต้องเลือกไลน์ —'}</option>
          {near.map(l => <option key={l.name} value={l.name}>{l.label}</option>)}
          {!!far.length && <option disabled value="__">──────────</option>}
          {far.map(l => <option key={l.name} value={l.name}>{l.label} (นอกคู่ที่ผูกไว้)</option>)}
        </select>
        <div style={{ marginTop: 3 }}>
          <span className={`src${r.lineSource === 'manual' ? ' manual' : r.lineSource === 'product' ? ' prod' : ''}`}>
            {LINE_SOURCE_LABEL[r.lineSource] || (candidates.length ? `เครื่องนี้มี ${candidates.length} คู่ ระบบไม่เดา` : 'ยังไม่ผูกคู่ในผังเชื่อมโยง')}
          </span>
        </div>
      </td>
      <td className="num">{num(r.targetBoxes)}</td>
      <td><span className={`src ${r.source === 'manual' ? 'manual' : 'plan'}`}>{r.source === 'manual' ? 'เพิ่ม/แก้เอง' : 'จากแผน'}</span></td>
      <td>
        <span className={`chip ${st.chip}`}>{st.label}</span>
        {r.confirmedBy && r.status !== 'cancelled' && <div className="rsub">โดย {r.confirmedBy}</div>}
      </td>
      <td>
        <div className="rowacts">
          {canEdit && !dead && r.status === 'draft' && (
            <button className="ibtn xs ok" disabled={busy} title="ยืนยันรอบนี้" onClick={() => onStatus(r, 'confirm')}>✅</button>
          )}
          {canEdit && !dead && r.status === 'confirmed' && (
            <button className="ibtn xs" disabled={busy} title="ปิดงานบรรจุ" onClick={() => onStatus(r, 'done')}>🏁</button>
          )}
          {canEdit && !dead && <button className="ibtn xs" disabled={busy} title="แก้ไข" onClick={() => onEdit(r)}>✏️</button>}
          {canEdit && !dead && (
            <button className="ibtn xs dgr" disabled={busy} title="ยกเลิกรอบนี้" onClick={() => onStatus(r, 'cancel')}>🚫</button>
          )}
          {canEdit && dead && (
            <button className="ibtn xs" disabled={busy} title="คืนค่ารอบนี้" onClick={() => onStatus(r, 'reopen')}>↩︎</button>
          )}
        </div>
      </td>
    </tr>
  );
};

const MachineRunsToday: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const [date, setDate] = useState(currentWorkDay());
  const [shift, setShift] = useState(nowShift());
  const [data, setData] = useState<RunsData | null>(null);
  const [rulePv, setRulePv] = useState<PreviewData | null>(null);
  const [notifyOn, setNotifyOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [wake, setWake] = useState<WakeState>('idle');
  const [edit, setEdit] = useState<Draft | null>(null);

  /* seed = "ขอดึงแผนมาตั้งรอบให้ด้วย" — ส่งเฉพาะตอนคนกดปุ่มเท่านั้น
     เปลี่ยนวัน/กะ = อ่านอย่างเดียวเสมอ ไม่มีทางเผลอสร้างรอบจากการกดดูไปมา */
  const load = useCallback(async (seed = false) => {
    try {
      const qs = `date=${date}${shift ? `&shift=${encodeURIComponent(shift)}` : ''}${seed ? '&seed=1' : ''}`;
      const d = await mcGet<RunsData>(`/api/machine-runs?${qs}`, setWake);
      setData(d);
      if (seed) {
        const s = d.seeded;
        if (d.seedSkipped) {
          setMsg({ kind: 'warn', text: d.seedSkipped === 'role'
            ? 'ดึงแผนได้เฉพาะหัวหน้าขึ้นไป — ตารางด้านล่างยังดูได้ตามปกติ'
            : 'ดึงแผนได้เฉพาะวันทำงานปัจจุบันหรือล่วงหน้าเท่านั้น' });
          return;
        }
        setMsg(!s || !s.planRows
          ? { kind: 'warn', text: `วันที่ ${date} ยังไม่มีแผนบรรจุในระบบ — ลงแผนก่อนที่หน้า “แผนผลิตวันนี้” หรือกด “＋ เพิ่มรอบเอง”` }
          : {
            kind: s.unknownKey.length || s.noMachine || s.conflicts.length || s.staleConfirmed.length ? 'warn' : 'ok',
            text: `ดึงแผนแล้ว ${s.planRows} รายการ → ${s.rows} รอบ · เติมไลน์ให้อัตโนมัติ ${s.filled} รอบ`
              + (s.noMachine ? ` · ⚠️ ${s.noMachine} รายการในแผนไม่ได้ระบุเครื่อง` : '')
              + (s.unknownKey.length ? ` · ⚠️ รหัสเครื่องที่ไม่มีในทะเบียน: ${s.unknownKey.map(k => k.toUpperCase()).join(', ')}` : '')
              + (s.conflicts.length ? ` · ⚠️ ตั้งรอบไม่ได้เพราะซ้ำกับรอบที่มีอยู่: ${s.conflicts.join(' · ')}` : '')
              + (s.dropped.length ? ` · พับรอบที่หายไปจากแผนแล้ว ${s.dropped.length} รอบ` : '')
              + (s.staleConfirmed.length ? ` · ⚠️ ยืนยันไปแล้วแต่ไม่มีในแผนแล้ว: ${s.staleConfirmed.join(' · ')}` : ''),
          });
      }
      // กฎที่จะยิงวันนี้ — อ่านอย่างเดียว ไม่ส่งการ์ด · พังก็แค่ไม่โชว์การ์ด ไม่ทำให้ตารางรอบล่ม
      try {
        setRulePv(await mcPost<PreviewData>('/api/machine-rules/preview', { date, shift }));
      } catch { setRulePv(null); }
      try {
        setNotifyOn((await mcGet<{ enabled: boolean }>('/api/machine-runs/notify-switch')).enabled);
      } catch { setNotifyOn(null); }
    } catch (e) { setMsg({ kind: 'err', text: `โหลดรอบเดินเครื่องไม่สำเร็จ: ${(e as Error).message}` }); }
  }, [date, shift]);
  useEffect(() => { load(); }, [load]);

  const runs = data?.runs || [];
  const lines = data?.lines || [];

  // แผนบรรจุบรรทัดเดียวลง 2 เครื่องได้ (เช่น "[L3+L4]") — เป้าในแผนไม่ได้บอกว่าเครื่องไหนกี่กล่อง
  // เลยใส่เป้าเต็มทั้งคู่แล้วติดป้ายเตือนแทน ไม่หารตัวเลขเอง
  const splitOf = useMemo(() => {
    const n: Record<string, number> = {};
    for (const r of runs) if (r.source === 'plan') n[r.flavorNorm] = (n[r.flavorNorm] || 0) + 1;
    return n;
  }, [runs]);

  const stat = useMemo(() => {
    const live = runs.filter(r => r.status !== 'cancelled');
    return {
      total: live.length,
      needLine: live.filter(r => !r.lineName).length,
      confirmed: live.filter(r => r.status === 'confirmed' || r.status === 'done').length,
      done: live.filter(r => r.status === 'done').length,
      boxes: live.reduce((s, r) => s + (r.targetBoxes || 0), 0),
    };
  }, [runs]);

  /* กฎที่เข้ากับรอบของวันนี้ — 1 บรรทัด = 1 ใบเช็กที่จะเกิด (รอบ × จังหวะ)
     รวมชื่อกฎที่เข้าพร้อมกันไว้บรรทัดเดียว เพราะปลายทางเป็น "ใบเดียว" อยู่แล้ว ไม่ใช่การ์ดแยกใบ */
  const ruleHits = useMemo(() => {
    const out: {
      runId: number; timing: string; packer: string; packerFull: string; flavor: string; status: string;
      ruleTitles: string; roles: string; nItems: number; needPhoto: boolean; needQc: boolean;
    }[] = [];
    for (const r of (rulePv?.runs || [])) {
      for (const t of TIMING_ORDER) {
        const hit = r.timings[t];
        if (!hit) continue;
        out.push({
          runId: r.runId, timing: t,
          packer: r.packerKey ? r.packerKey.toUpperCase() : (r.packerName || '—'),
          packerFull: r.packerName,
          flavor: r.flavor, status: r.status,
          ruleTitles: hit.rules.map(x => x.title).join(' + '),
          roles: [...new Set(hit.rules.map(x => roleLabel(x.ownerRole)).filter(Boolean))].join(' + '),
          nItems: hit.items.length,
          needPhoto: hit.items.some(i => i.needPhoto),
          needQc: hit.items.some(i => i.needQc),
        });
      }
    }
    return out;
  }, [rulePv]);

  const otherShifts = useMemo(
    () => Object.entries(data?.byShift || {}).filter(([s, n]) => s !== shift && n > 0),
    [data, shift]);

  const act = async (path: string, body: unknown, okText: (d: { changed: number; skipped: string[] }) => string) => {
    setBusy(true);
    try {
      const d = await mcPost<{ changed: number; skipped: string[] }>(path, body);
      const skipped = d.skipped || [];
      setMsg(skipped.length
        ? { kind: 'warn', text: `${okText(d)} · ข้าม ${skipped.length} รอบที่ยังไม่ได้เลือกไลน์: ${skipped.join(' · ')}` }
        : { kind: 'ok', text: okText(d) });
      await load();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const onLine = async (r: MachineRun, line: string) => {
    setBusy(true);
    try {
      await mcPost('/api/machine-runs', { id: r.id, lineName: line });
      await load();
      setMsg(null);
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const onStatus = (r: MachineRun, to: string) => act(
    `/api/machine-runs/${to}`, { id: r.id },
    () => ({ confirm: 'ยืนยันรอบแล้ว', done: 'ปิดงานบรรจุแล้ว', cancel: 'ยกเลิกรอบแล้ว', reopen: 'คืนค่ารอบแล้ว' }[to] || 'บันทึกแล้ว'));

  const confirmAll = () => act('/api/machine-runs/confirm', { workDay: date, shift },
    d => `ยืนยันแล้ว ${d.changed} รอบ`);

  /* เช็กลิสต์เป็นหน้าสาธารณะที่เปิดด้วย token ของ "เครื่อง" (ลิงก์เดียวปักหมุดในกลุ่มได้ตลอด)
     กดจากหน้านี้จะพ่วง runId/timing ไปด้วย เพื่อเปิดใบของรอบที่กดตรงตัว ไม่ต้องเลือกซ้ำ */
  const linkFor = async (machineName: string) => {
    const d = await mcPost<{ url: string }>('/api/run-check/link', { machineName, baseUrl: window.location.origin });
    return d.url;
  };
  const openCheck = async (runId: number, timing: string, machineName: string) => {
    if (!machineName) { setMsg({ kind: 'err', text: 'รอบนี้ยังไม่รู้ว่าเครื่องไหน — เลือกเครื่องให้รอบก่อน' }); return; }
    setBusy(true);
    try {
      const url = await linkFor(machineName);
      window.open(`${url}&runId=${runId}&timing=${timing}`, '_blank', 'noopener');
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };
  /* การ์ดเตือนอัตโนมัติ — ค่าเริ่มต้นปิด ตั้งกฎให้เสร็จก่อนแล้วค่อยเปิดเอง
     (ยิงรายกะ ถี่กว่าทุกตัวในระบบ เปิดทิ้งไว้ตั้งแต่แรกจะกลายเป็นเสียงรบกวน) */
  const toggleNotify = async () => {
    setBusy(true);
    try {
      const d = await mcPost<{ enabled: boolean }>('/api/machine-runs/notify-switch', { enabled: !notifyOn });
      setNotifyOn(d.enabled);
      setMsg({ kind: 'ok', text: d.enabled
        ? 'เปิดการ์ดเตือนอัตโนมัติแล้ว — บอทจะยิงเข้ากลุ่มช่างตามจังหวะของกฎ'
        : 'ปิดการ์ดเตือนอัตโนมัติแล้ว — เช็กลิสต์ยังเปิดจากลิงก์ได้ตามปกติ' });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const notifyTest = async (runId: number, timing: string, preview: boolean) => {
    setBusy(true);
    try {
      const d = await mcPost<{ skipped?: boolean; message?: string; preview?: string; sent?: boolean }>(
        '/api/machine-runs/notify-test', { runId, timing, preview });
      if (d.skipped) setMsg({ kind: 'warn', text: d.message || 'ไม่มีอะไรต้องส่ง' });
      else if (preview) window.alert(d.preview?.replace(/<[^>]+>/g, '') || '');
      else setMsg({ kind: 'ok', text: 'ส่งการ์ดเข้ากลุ่มช่างแล้ว' });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const pinLink = async (machineName: string) => {
    setBusy(true);
    try {
      const url = await linkFor(machineName);
      try { await navigator.clipboard.writeText(url); setMsg({ kind: 'ok', text: `คัดลอกลิงก์ของ ${machineName} แล้ว — เอาไปปักหมุดในกลุ่มได้เลย` }); }
      catch { setMsg({ kind: 'ok', text: `ลิงก์ของ ${machineName}: ${url}` }); }
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const saveRun = async (d: Draft) => {
    setBusy(true);
    try {
      await mcPost('/api/machine-runs', {
        id: d.id || undefined,
        workDay: d.workDay, shift: d.shift,
        packerName: d.packerName, lineName: d.lineName, flavor: d.flavor,
        targetBoxes: d.targetBoxes === '' ? null : Number(d.targetBoxes),
        note: d.note,
      });
      setEdit(null);
      setMsg({ kind: 'ok', text: d.id ? 'แก้ไขรอบแล้ว' : 'เพิ่มรอบแล้ว' });
      await load();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const blank = (): Draft => ({
    id: 0, workDay: date, shift: shift || (data?.shifts || [])[0] || 'กะเช้า',
    packerName: '', lineName: '', flavor: '', targetBoxes: '', note: '',
  });
  const toDraft = (r: MachineRun): Draft => ({
    id: r.id, workDay: r.workDay, shift: r.shift, packerName: r.packerName,
    lineName: r.lineName, flavor: r.flavor, targetBoxes: r.targetBoxes == null ? '' : String(r.targetBoxes),
    note: r.note,
  });

  return (
    <>
      <div className="ifilters">
        <input className="isel" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <select className="isel" value={shift} onChange={e => setShift(e.target.value)}>
          <option value="">ทั้งวัน</option>
          {(data?.shifts || []).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="divider" />
        {data?.canSeed && canEdit && (
          <button className="ibtn" disabled={busy} onClick={() => load(true)}>🔄 ดึงแผนบรรจุมาตั้งรอบ</button>
        )}
        <button className="ibtn" disabled={!canEdit} onClick={() => setEdit(blank())}>➕ เพิ่มรอบเอง</button>
        <button className="ibtn pri" disabled={busy || !canEdit || !stat.total} onClick={confirmAll}>
          ✅ ยืนยัน{shift ? 'ทั้งกะ' : 'ทั้งวัน'}
        </button>
      </div>

      {wake === 'waking' && <div className="infobox">{wakeMessage(wake)}</div>}
      {msg && (
        <div className={msg.kind === 'ok' ? 'okbox' : msg.kind === 'warn' ? 'warnbox' : 'errbox'}>
          {msg.kind === 'ok' ? '✅ ' : msg.kind === 'warn' ? '⚠️ ' : '❌ '}{msg.text}
        </div>
      )}
      {!data?.canSeed && (
        <div className="infobox">
          📖 วันย้อนหลัง — ดูได้อย่างเดียว ระบบจะไม่ดึงแผนมาสร้างรอบใหม่ให้ (รอบที่เห็นคือของที่เคยตั้งไว้จริงเท่านั้น)
        </div>
      )}

      <div className="warnbox">
        📋 รอบด้านล่าง <b>ดึงมาจากแผนบรรจุรายกะ</b> ที่ลงไว้แล้ว — ช่อง “ไลน์ต้มที่ป้อน” ที่เป็น<b>สีส้ม</b> คือระบบยังเดาไม่ได้ ต้องเลือกเอง
        <br />แก้ช่องไหนก็ได้ · ค่าที่แก้เองจะ<b>ไม่ถูกแผนทับ</b>เมื่อดึงแผนใหม่
      </div>

      <div className="tgrid">
        <div className="card scrollx">
          <table className="tb runs">
            <thead><tr>
              <th>เครื่องบรรจุ</th><th>สินค้า (จากแผน)</th><th>ไลน์ต้มที่ป้อน</th>
              <th className="num">เป้า</th><th>ที่มา</th><th>สถานะ</th><th aria-label="จัดการ" />
            </tr></thead>
            <tbody>
              {runs.map(r => (
                <RunRow
                  key={r.id} r={r} lines={lines} canEdit={canEdit} busy={busy}
                  candidates={(data?.candidates || {})[r.packerName] || []}
                  split={r.source === 'plan' ? (splitOf[r.flavorNorm] || 1) : 1}
                  onLine={onLine} onStatus={onStatus} onEdit={r2 => setEdit(toDraft(r2))}
                />
              ))}
              {!runs.length && (
                <tr><td colSpan={7} className="empty">
                  {data?.canSeed
                    ? 'ยังไม่มีรอบเดินเครื่องของกะนี้ — กด “🔄 ดึงแผนบรรจุมาตั้งรอบ”'
                    : 'ไม่มีรอบเดินเครื่องที่บันทึกไว้ในวันนี้'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <div className="card blk">
            <h3 className="hd">📊 สรุปรอบ{shift ? shift : 'ทั้งวัน'}</h3>
            <dl className="kv">
              <dt>รอบทั้งหมด</dt><dd>{stat.total} รอบ</dd>
              <dt>ยืนยันแล้ว</dt><dd>{stat.confirmed} รอบ{stat.done ? ` (ปิดงาน ${stat.done})` : ''}</dd>
              <dt>ยังไม่เลือกไลน์</dt>
              <dd style={stat.needLine ? { color: 'var(--p-warn)', fontWeight: 700 } : undefined}>{stat.needLine} รอบ</dd>
              <dt>เป้ารวม</dt><dd>{num(stat.boxes)} กล่อง</dd>
            </dl>
            {!!stat.needLine && (
              <div className="warnbox" style={{ marginTop: 11, marginBottom: 0 }}>
                รอบที่ยังไม่รู้ไลน์ต้นทาง <b>ยืนยันไม่ได้</b> — เลือกไลน์ในช่องสีส้มก่อน
                หรือไปผูกคู่ถาวรที่แท็บ 🔗 ผังเชื่อมโยง แล้วกดดึงแผนใหม่
              </div>
            )}
          </div>

          {!!otherShifts.length && (
            <div className="card blk">
              <h3 className="hd">🕑 กะอื่นของวันนี้</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {otherShifts.map(([s, n]) => (
                  <button key={s} className="ibtn sm" onClick={() => setShift(s)}>{s || 'ไม่ระบุกะ'} · {n} รอบ</button>
                ))}
              </div>
            </div>
          )}

          <div className="card blk" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 className="hd" style={{ margin: 0 }}>🔔 กฎที่จะยิง{shift ? shift : 'วันนี้'}</h3>
              {rulePv && <span className={`chip ${rulePv.hitRuns ? 'due' : 'mute'}`}>{rulePv.hitRuns}</span>}
              <div className="sp" />
              {notifyOn != null && (
                <button className={`ibtn xs${notifyOn ? ' ok' : ''}`} disabled={busy || !canEdit} onClick={toggleNotify}
                  title="เปิด/ปิดการ์ดเตือนอัตโนมัติเข้ากลุ่มช่าง">
                  {notifyOn ? '🔔 เตือนอัตโนมัติ: เปิด' : '🔕 เตือนอัตโนมัติ: ปิด'}
                </button>
              )}
            </div>
            <div style={{ marginTop: 11 }}>
              {ruleHits.map(h => (
                <div className="rule" key={`${h.runId}-${h.timing}`}>
                  <div className="t">{TIMING_META[h.timing]?.icon} {h.ruleTitles}</div>
                  <div className="c">
                    {TIMING_META[h.timing]?.label} · เครื่อง <b>{h.packer}</b> · สินค้า <b>{h.flavor || 'อะไรก็ได้'}</b>
                  </div>
                  <div className="c" style={{ marginTop: 4 }}>
                    👤 {h.roles || '—'}{h.needPhoto ? ' · 📷 ต้องแนบรูป' : ''}{h.needQc ? ' · 🧪 ต้องมี QC ร่วม' : ''}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="chip mute">{h.nItems} ข้อ</span>
                    {h.status !== 'confirmed' && h.status !== 'done' && <span className="chip warn">รอยืนยันรอบก่อน</span>}
                    {canEdit && (
                      <>
                        <button className="ibtn xs" disabled={busy} onClick={() => openCheck(h.runId, h.timing, h.packerFull)}>
                          📋 เปิดเช็กลิสต์
                        </button>
                        <button className="ibtn xs" disabled={busy} onClick={() => notifyTest(h.runId, h.timing, true)}>👁 ดูตัวอย่าง</button>
                        <button className="ibtn xs" disabled={busy} onClick={() => notifyTest(h.runId, h.timing, false)}>📮 ส่งเข้ากลุ่ม</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {!ruleHits.length && (
                <div className="infobox" style={{ marginBottom: 0 }}>
                  ไม่มีกฎเข้ากับรอบของวันนี้ = ไม่ยิงอะไรเลย (เงียบดีกว่าส่งการ์ดเปล่า)
                  · ตั้งกฎได้ที่แท็บ ⚙️ กฎเตือน
                </div>
              )}
              {canEdit && !!ruleHits.length && (
                <div style={{ marginTop: 11, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[...new Set(ruleHits.map(h => h.packerFull).filter(Boolean))].map(m => (
                    <button key={m} className="ibtn sm" disabled={busy} onClick={() => pinLink(m)}>🔗 ลิงก์ {m}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {edit && (
        <RunForm
          draft={edit} packers={data?.packers || []} lines={lines}
          shifts={data?.shifts || []} busy={busy} onSave={saveRun} onClose={() => setEdit(null)}
        />
      )}
    </>
  );
};

export default MachineRunsToday;
