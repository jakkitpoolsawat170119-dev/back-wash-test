/* หน้ารายละเอียดเครื่องจักร 1 ตัว — รวมทุกอย่างที่ระบบรู้เกี่ยวกับเครื่องนี้ไว้ที่เดียว
   ① สเปค ② แผน PM (กระจกจากแอปทีมช่าง) ③ งานรูทีน/AM ④ เหตุการณ์+เวลาหยุด
   ⑤ ไลน์ที่ป้อนเข้า + สินค้าประจำคู่ ⑥ กฎเตือน

   เปิดจาก ?page=admin&tab=machines&item=<id> — แชร์ลิงก์ตรงเข้าเครื่องได้ */
import React, { useCallback, useEffect, useState } from 'react';
import { wakeMessage, type WakeState } from '../lib/wakeFetch';
import { mcGet, roleLabel, cleanFlavor, type MachineDetailData, type Machine } from '../lib/machines';

const TIMING_LABEL: Record<string, string> = { start: 'ก่อนเริ่มบรรจุ', during: 'ระหว่างเดินเครื่อง', end: 'หลังบรรจุจบ' };
const STATUS_LABEL: Record<string, string> = { open: 'เปิดค้าง', wip: 'กำลังซ่อม', closed: 'ปิดแล้ว' };
const STATUS_ICON: Record<string, string> = { open: '🔴', wip: '🔵', closed: '🟢' };

const minutesText = (n: number) => {
  const h = Math.floor(n / 60); const m = n % 60;
  return h ? `${h} ชม.${m ? ` ${m} น.` : ''}` : `${m} น.`;
};

/* แถบ 52 สัปดาห์ — 2 แถว แถวละ 26 · สีตามสถานะรอบที่เซิร์ฟเวอร์คำนวณมาแล้ว */
const WeekStrip: React.FC<{ pm: NonNullable<MachineDetailData['pm']> }> = ({ pm }) => {
  const byWeek = new Map(pm.cycles.map(c => [c.week, c]));
  const cls = (w: number) => {
    const c = byWeek.get(w);
    const now = pm.cur.year === pm.year && pm.cur.week === w ? ' now' : '';
    if (!c) return now.trim();
    if (c.status === 'done') return `done${now}`;
    if (c.status === 'over') return `over${now}`;
    if (c.status === 'skip') return `skip${now}`;
    return `plan${now}`;
  };
  const row = (from: number, to: number) => (
    <div className="wk">
      {Array.from({ length: to - from + 1 }, (_, i) => from + i).map(w => (
        <i key={w} className={cls(w)} title={`สัปดาห์ ${w}${byWeek.get(w) ? ` · ${byWeek.get(w)!.status}` : ''}`} />
      ))}
    </div>
  );
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 12 }}>สัปดาห์ที่ 1–26 ของปี {pm.year}</div>
      {row(1, 26)}
      <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 10 }}>สัปดาห์ที่ 27–52</div>
      {row(27, 52)}
      <div className="legend">
        <span><i style={{ background: 'var(--p-low-w)', border: '1px solid var(--ok)' }} />ทำแล้ว</span>
        <span><i style={{ background: 'var(--p-stop-w)', border: '1px solid var(--p-stop)' }} />เลยกำหนด</span>
        <span><i style={{ background: 'var(--brand-soft)', border: '1px solid var(--brand)' }} />ตามแผน</span>
        <span><i style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }} />ไม่มีแผน</span>
        <span>▪︎ กรอบดำ = สัปดาห์นี้ (W{pm.cur.week})</span>
      </div>
    </>
  );
};

const MachineDetail: React.FC<{
  id: number;
  canEdit: boolean;
  onBack: () => void;
  onEdit: (m: Partial<Machine>) => void;
}> = ({ id, canEdit, onBack, onEdit }) => {
  const [d, setD] = useState<MachineDetailData | null>(null);
  const [err, setErr] = useState('');
  const [wake, setWake] = useState<WakeState>('idle');

  const load = useCallback(async () => {
    setErr('');
    try { setD(await mcGet<MachineDetailData>(`/api/machines/detail?id=${id}`, setWake)); }
    catch (e) { setErr((e as Error).message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <>
        <button className="ibtn" onClick={onBack}>‹ กลับหน้าทะเบียน</button>
        <div className="errbox" style={{ marginTop: 14 }}>❌ {err}</div>
      </>
    );
  }
  if (!d) {
    return (
      <>
        <button className="ibtn" onClick={onBack}>‹ กลับหน้าทะเบียน</button>
        <div className="infobox" style={{ marginTop: 14 }}>{wake === 'waking' ? wakeMessage(wake) : 'กำลังโหลด…'}</div>
      </>
    );
  }

  const m = d.machine;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <button className="ibtn" onClick={onBack}>‹ กลับหน้าทะเบียน</button>
        <div className="sp" />
        {d.netlifyUrl && <a className="ibtn ext" href={d.netlifyUrl} target="_blank" rel="noreferrer">🔗 เปิดในแอปทีมช่าง</a>}
        <button className="ibtn pri" disabled={!canEdit} onClick={() => onEdit(m)}>✏️ แก้ไขข้อมูลเครื่อง</button>
      </div>

      <div className="phead" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 23 }}>{m.label || m.name}</h1>
          <div className="sub">
            ชื่อในระบบ · <b>{m.name}</b>
            {m.mkey && m.grp === 'packer' && <> &nbsp;·&nbsp; รหัสในแผนบรรจุ <b>[{m.mkey.toUpperCase()}]</b></>}
          </div>
        </div>
        <div className="sp" />
        {d.downtime.openCount > 0 && <span className="chip stop">ยังหยุดอยู่ {d.downtime.openCount}</span>}
        {m.pmNextWeek != null && <span className="chip freq">PM รอบหน้า W{m.pmNextWeek}</span>}
      </div>

      <div className="dgrid">
        <div>
          {/* ① สเปค */}
          <div className="card blk">
            <h3 className="hd">① ข้อมูลเครื่อง</h3>
            <dl className="kv">
              {m.code && <><dt>รหัส</dt><dd>{m.code}</dd></>}
              {m.spec && <><dt>ยี่ห้อ/รุ่น</dt><dd>{m.spec}</dd></>}
              {m.installedAt && <><dt>วันที่ติดตั้ง</dt><dd>{m.installedAt}</dd></>}
              {m.lastPm && <><dt>PM ล่าสุด</dt><dd>{m.lastPm}</dd></>}
              {m.downtimeCost != null && <><dt>ค่าเครื่องหยุด</dt><dd>{m.downtimeCost.toLocaleString()} บาท/ชม.</dd></>}
              {!!d.aliases.length && (
                <><dt>ชื่อที่ใช้จับ</dt><dd className="pchips">{d.aliases.map(a => <span className="pchip" key={a}>{a}</span>)}</dd></>
              )}
            </dl>
            {m.note && <div className="infobox" style={{ marginTop: 11, marginBottom: 0 }}>{m.note}</div>}
          </div>

          {/* ② แผน PM */}
          <div className="card blk">
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <h3 className="hd" style={{ margin: 0 }}>② แผน PM รายปี</h3>
              {d.pm && <span className="chip freq">{d.pm.freqLabel}</span>}
            </div>
            {d.pm ? (
              <>
                <div className="warnbox" style={{ margin: '10px 0 0' }}>
                  🪞 ส่วนนี้เป็น <b>กระจกอ่านอย่างเดียว</b> จากแอปทีมช่าง — แก้แผน/ติ๊กปิดงานต้องทำในแอปนั้น
                </div>
                <WeekStrip pm={d.pm} />
                <div style={{ fontSize: 12.8, marginTop: 12, color: 'var(--ink-soft)' }}>
                  ทำแล้ว {d.pm.stat.done}/{d.pm.stat.due} รอบที่ถึงกำหนด
                  {d.pm.stat.pct != null && <> · {d.pm.stat.pct}%</>}
                  {d.pm.stat.lastDone && <> · ครั้งล่าสุด {d.pm.stat.lastDone}</>}
                </div>
                {!!d.pm.jobs.length && (
                  <div style={{ marginTop: 12 }}>
                    <div className="hd" style={{ fontSize: 13 }}>งานย่อยของเครื่องนี้</div>
                    {d.pm.jobs.map(j => (
                      <div className="li" key={j.id}>
                        <span className="ic">🔧</span>
                        <div><b>{j.title}</b><div className="meta">{j.freqLabel}</div></div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="infobox" style={{ marginTop: 10, marginBottom: 0 }}>
                เครื่องนี้ไม่มีแผน PM ในแอปทีมช่าง — ถ้าควรมี ให้ไปเพิ่มที่แอปนั้นแล้วผูก net_id ในหน้าแก้ไข
              </div>
            )}
          </div>

          {/* ③ งานรูทีน */}
          <div className="card blk">
            <h3 className="hd">③ งานรูทีน / ใบเช็ก AM ที่ผูกกับเครื่องนี้ <span className="chip mute">{d.routines.length}</span></h3>
            {d.routines.length ? d.routines.map(r => (
              <div className="li" key={r.id}>
                <span className="ic">{r.sheet === 'am' ? '📋' : '✅'}</span>
                <div>
                  <b>{r.title}</b>
                  <div className="meta">
                    {roleLabel(r.ownerRole)}
                    {r.freq && <><span className="dot">·</span>{r.freq}</>}
                    {r.sheet === 'am' && <><span className="dot">·</span>ใบเช็ก AM</>}
                    {r.nodeKey && <><span className="dot">·</span>{r.nodeKey}</>}
                  </div>
                  {r.goal && <div className="meta">🎯 {r.goal}</div>}
                </div>
              </div>
            )) : <div className="empty">ยังไม่มีงานรูทีนที่ผูกกับเครื่องนี้</div>}
          </div>

          {/* ④ เหตุการณ์ */}
          <div className="card blk">
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <h3 className="hd" style={{ margin: 0 }}>④ เหตุการณ์ย้อนหลัง</h3>
              <div className="sp" />
              {d.downtime.minutes > 0 && <span className="chip mute">เวลาเครื่องหยุดรวม {minutesText(d.downtime.minutes)}</span>}
            </div>
            <div style={{ marginTop: 9 }}>
              {d.incidents.length ? d.incidents.map(i => (
                <div className="li" key={i.id}>
                  <span className="ic">{STATUS_ICON[i.status] || '⚪'}</span>
                  <div>
                    <b>{i.title}</b>
                    <div className="meta">
                      {i.occurredAt ? i.occurredAt.slice(0, 16).replace('T', ' ') : '—'}
                      <span className="dot">·</span>{STATUS_LABEL[i.status] || i.status}
                      {i.assignee && <><span className="dot">·</span>ช่าง: {i.assignee}</>}
                      {i.minutes != null && <><span className="dot">·</span>หยุด {minutesText(i.minutes)}</>}
                      {i.source && <><span className="dot">·</span><span className="src">{i.source}</span></>}
                    </div>
                    {i.cause && <div className="meta">สาเหตุ: {i.cause}</div>}
                  </div>
                </div>
              )) : <div className="empty">ยังไม่มีเหตุการณ์ของเครื่องนี้</div>}
            </div>
          </div>
        </div>

        <div>
          {/* ⑤ คู่ไลน์ */}
          <div className="card blk">
            <h3 className="hd">⑤ {m.grp === 'line' ? 'เครื่องบรรจุที่รับจากไลน์นี้' : 'ไลน์ที่ป้อนเข้าเครื่องนี้'}</h3>
            {d.links.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {d.links.map(l => {
                  const other = m.grp === 'line' ? l.packerLabel : l.lineLabel;
                  return (
                    <div className="pairbox" key={l.id}>
                      <div style={{ fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 13.5 }}>
                        {m.grp === 'line' ? '📦' : '🏭'} {other}
                      </div>
                      {l.products.length ? (
                        <>
                          <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 3 }}>สินค้าประจำคู่</div>
                          <div className="pchips" style={{ marginTop: 4 }}>
                            {l.products.map((p, i) => <span className="pchip on" key={p.id ?? i}>{cleanFlavor(p.flavor)}</span>)}
                          </div>
                        </>
                      ) : <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>ยังไม่ระบุสินค้าประจำคู่</div>}
                      {l.note && <div style={{ fontSize: 11.8, color: 'var(--ink-soft)', marginTop: 5 }}>📝 {l.note}</div>}
                    </div>
                  );
                })}
              </div>
            ) : <div className="empty">ยังไม่ได้ผูกคู่ — ไปผูกที่แท็บ 🔗 ผังเชื่อมโยง</div>}
          </div>

          {/* ⑥ กฎเตือน */}
          <div className="card blk">
            <h3 className="hd">⑥ กฎเตือนของเครื่องนี้ <span className="chip mute">{d.rules.length}</span></h3>
            {d.rules.length ? d.rules.map(r => (
              <div className="pairbox" key={r.id} style={{ marginBottom: 9, borderLeft: '4px solid var(--brand)' }}>
                <div style={{ fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 13.5 }}>{r.title}</div>
                <div style={{ fontSize: 11.8, color: 'var(--ink-soft)', marginTop: 3 }}>
                  {TIMING_LABEL[r.timing] || r.timing}
                  {r.productPattern && <> · สินค้ามีคำว่า <b>{r.productPattern}</b></>}
                  {r.shift && <> · {r.shift}</>}
                </div>
                {r.items.map((it, i) => <div style={{ fontSize: 12.3, marginTop: 5 }} key={i}>• {it.title}{it.needPhoto ? ' 📷' : ''}{it.needQc ? ' 🧪' : ''}</div>)}
              </div>
            )) : <div className="empty">ยังไม่มีกฎเตือน</div>}
          </div>

          {/* รอบล่าสุด */}
          {!!d.runs.length && (
            <div className="card blk">
              <h3 className="hd">🕘 รอบเดินเครื่องล่าสุด</h3>
              {d.runs.map(r => (
                <div className="li" key={r.id}>
                  <span className="ic">📅</span>
                  <div>
                    <b>{cleanFlavor(r.flavor)}</b>
                    <div className="meta">{r.workDay} · {r.shift} · {r.line || 'ยังไม่ระบุไลน์'}<span className="dot">·</span><span className="src">{r.source}</span></div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {m.vaultPath && (
            <div className="card blk">
              <h3 className="hd">📄 โน้ตใน Obsidian</h3>
              <div style={{ fontSize: 12.3, color: 'var(--ink-soft)', wordBreak: 'break-all' }}>{m.vaultPath}</div>
              <div className="infobox" style={{ marginTop: 9, marginBottom: 0 }}>
                ระบบเขียนทับเฉพาะในเขต <b>“ข้อมูลเครื่องจักร”</b> — ส่วนที่ช่างเขียนเองนอกเขตนั้นไม่โดนแตะ
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default MachineDetail;
