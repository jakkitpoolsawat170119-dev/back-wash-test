import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ═══════════ ดูใบเช็ก AM ย้อนหลัง — ตารางรายเดือนเหมือนใบกระดาษ ═══════════
   ใบกระดาษเดิมตอบคำถามนี้ได้ในแวบเดียว แต่ระบบยังตอบไม่ได้:
   **"เดือนนี้กะไหนไม่มีใครกรอกบ้าง"** — หน้านี้มีไว้ตอบข้อนั้นเป็นหลัก
   ไม่ใช่หน้าแก้ไข: อ่านอย่างเดียวล้วน ๆ (เส้น API ฝั่งเซิร์ฟเวอร์ก็อ่านอย่างเดียว
   ห้ามใช้ /api/am-sheet ธรรมดา — ตัวนั้นเปิดใบร่างให้ถ้ายังไม่มี)                */

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

type Cell = {
  shift: string; planned: boolean; state: 'none' | 'draft' | 'ok' | 'ng';
  id?: number; ok?: number; ng?: number; answered?: number; total?: number;
  lineStatus?: string; submittedBy?: string; submittedAt?: string;
};
type Day = { day: number; date: string; weekday: number; holiday: boolean; cells: Cell[] };
type Month = {
  month: string; line: string; lines: string[]; days: Day[];
  summary: { expected: number; filled: number; missing: number; ng: number; total: number };
};
type Item = {
  seq: number; nodeKey: string; title: string; result: string | null; cause: string;
  hasPhoto: boolean; photoUrl: string | null; checkedBy: string; updatedAt: string; gone: boolean;
};
type Sheet = {
  sheet: { id: number; workDay: string; shift: string; line: string; lineStatus: string;
    status: string; submittedBy: string; submittedAt: string };
  items: Item[]; summary: { total: number; ok: number; ng: number };
};

const WD = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const SHIFT_COLS = ['เช้า', 'บ่าย', 'ดึก'];
const LINE_STATUS: Record<string, string> = { inprocess: '🟢 เดินเครื่อง', cip: '💧 CIP', idle: '⚪ หยุด' };

/* สถานะช่อง — สื่อด้วย "สี + สัญลักษณ์ + คำ" ไม่ใช่สีอย่างเดียว
   ตารางนี้อ่านบนมือถือกลางไลน์ผลิต แสงจ้า และมีคนตาบอดสีอยู่จริงในทีม */
const CELL: Record<Cell['state'], { bg: string; bd: string; fg: string; mark: string; label: string }> = {
  none: { bg: '#fff', bd: '#e8ddd2', fg: '#c4b8ac', mark: '·', label: 'ไม่มีใครกรอก' },
  draft: { bg: '#fff6e8', bd: '#f0c98a', fg: '#a86a10', mark: '◔', label: 'ค้างไว้ ยังไม่ส่ง' },
  ok: { bg: '#e8f5ee', bd: '#9fd4b8', fg: '#1c7a4c', mark: '✓', label: 'ปกติทุกข้อ' },
  ng: { bg: '#fdece9', bd: '#eeb0a4', fg: '#b3261e', mark: '!', label: 'มีข้อไม่ปกติ' },
};

const card: React.CSSProperties = {
  background: '#fff', border: '1px solid var(--line,#eee3d9)', borderRadius: 14,
  boxShadow: '0 1px 2px rgba(63,37,10,.05)',
};
const btn: React.CSSProperties = {
  border: '1px solid var(--line,#eee3d9)', background: '#fff', borderRadius: 9,
  padding: '6px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  fontFamily: 'Sarabun, sans-serif', color: 'var(--ink,#2b2119)',
};

const thaiMonth = (m: string) => {
  const MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const [y, mm] = m.split('-').map(Number);
  return `${MON[mm - 1] || mm} ${y + 543}`;
};

const AmSheetHistory: React.FC<{ lines: string[]; onClose: () => void }> = ({ lines, onClose }) => {
  const thisMonth = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [line, setLine] = useState(lines[0] || '');
  const [data, setData] = useState<Month | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Sheet | null>(null);      // ใบที่กดเปิดดู
  const [openBusy, setOpenBusy] = useState(0);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const viewRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`${apiUrl}/api/am-sheet/month?month=${month}&line=${encodeURIComponent(line)}`);
      const d = await r.json();
      if (!r.ok) { setErr(d?.error || 'โหลดไม่สำเร็จ'); setData(null); return; }
      setData(d);
    } catch { setErr('โหลดไม่สำเร็จ — เช็คเน็ต'); setData(null); } finally { setBusy(false); }
  }, [month, line]);
  useEffect(() => { if (line) load(); }, [load, line]);

  const openSheet = async (id: number) => {
    setOpenBusy(id);
    try {
      const r = await fetch(`${apiUrl}/api/am-sheet/view?id=${id}`);
      const d = await r.json();
      if (!r.ok) { setErr(d?.error || 'เปิดใบไม่สำเร็จ'); return; }
      setOpen(d); setPhotos({});
      // ตารางสูง 31 แถว — ไม่เลื่อนจอไปหา คนกดช่องแถวล่าง ๆ จะนึกว่ากดแล้วไม่มีอะไรเกิดขึ้น
      requestAnimationFrame(() => viewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    } catch { setErr('เปิดใบไม่สำเร็จ — เช็คเน็ต'); } finally { setOpenBusy(0); }
  };

  // รูปโหลดตอนกดดูเท่านั้น — ใบหนึ่งมีได้ 15 รูป ลากมาพร้อมกันหมดคือ payload บวมฟรี ๆ
  const loadPhoto = async (sheetId: number, nodeKey: string) => {
    if (photos[nodeKey]) return;
    setPhotos(p => ({ ...p, [nodeKey]: 'loading' }));
    try {
      const r = await fetch(`${apiUrl}/api/am-sheet/image?sheetId=${sheetId}&nodeKey=${encodeURIComponent(nodeKey)}`);
      const d = await r.json();
      setPhotos(p => ({ ...p, [nodeKey]: d?.image || '' }));
    } catch { setPhotos(p => ({ ...p, [nodeKey]: '' })); }
  };

  // คอลัมน์กะที่ต้องมีในเดือนนี้ — เพิ่มคอลัมน์ OT ต่อท้ายเฉพาะเดือนที่มีคนทำ OT จริง
  const cols = useMemo(() => {
    const extra = new Set<string>();
    for (const d of data?.days || []) for (const c of d.cells) if (!SHIFT_COLS.includes(c.shift)) extra.add(c.shift);
    return [...SHIFT_COLS, ...Array.from(extra).sort()];
  }, [data]);

  const shiftMonth = (n: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
  };

  const s = data?.summary;
  return (
    <div style={{ ...card, padding: '14px 16px', marginBottom: 14, background: 'linear-gradient(180deg,#f4f0ea,#fff 60%)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 14.5, fontWeight: 600 }}>📅 ใบเช็ก AM ย้อนหลัง</div>
        {/* ช่องเลือกเดือนของเบราว์เซอร์เป็น ค.ศ. เสมอ — เขียน พ.ศ. กำกับไว้ ทั้งแอปใช้ พ.ศ. */}
        <span style={{ fontSize: 13, fontWeight: 600, color: '#c24f00' }}>{thaiMonth(month)}</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ ...btn, padding: '4px 12px', fontSize: 12 }}>✕ ปิด</button>
      </div>

      {/* เลือกไลน์ + เดือน */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {(data?.lines || lines).map(l => (
          <button key={l} onClick={() => setLine(l)} style={{
            ...btn, ...(l === line ? { background: '#2b2119', borderColor: '#2b2119', color: '#fff' } : {}),
          }}>{l}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={() => shiftMonth(-1)} style={{ ...btn, padding: '5px 11px' }}>‹</button>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)}
          style={{ ...btn, cursor: 'text', fontWeight: 500 }} />
        <button onClick={() => shiftMonth(1)} style={{ ...btn, padding: '5px 11px' }}>›</button>
      </div>

      {err && <div style={{ fontSize: 12.5, color: '#b3261e', marginBottom: 8 }}>⚠️ {err}</div>}

      {/* สรุปเดือน — "ขาดกี่กะ" คือตัวเลขที่คนเปิดหน้านี้มาหา ให้อยู่ตำแหน่งเด่นสุด */}
      {s && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 11 }}>
          {[
            { n: `${s.filled}/${s.expected}`, l: 'กะที่ส่งรายงานแล้ว', c: '#1c7a4c', bg: '#e8f5ee' },
            { n: String(s.missing), l: 'กะที่ยังไม่มีใครกรอก', c: s.missing ? '#b3261e' : '#6d6259', bg: s.missing ? '#fdece9' : '#f2ece6' },
            { n: String(s.ng), l: 'ข้อที่เจอไม่ปกติ', c: s.ng ? '#a86a10' : '#6d6259', bg: s.ng ? '#fff6e8' : '#f2ece6' },
          ].map(x => (
            <div key={x.l} style={{ background: x.bg, borderRadius: 11, padding: '7px 13px', minWidth: 108 }}>
              <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 17, fontWeight: 600, color: x.c, lineHeight: 1.2 }}>{x.n}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-soft,#6d6259)' }}>{x.l}</div>
            </div>
          ))}
        </div>
      )}

      {busy && <div style={{ fontSize: 12.5, color: 'var(--ink-soft,#6d6259)', padding: '8px 0' }}>กำลังโหลด…</div>}

      {/* ใบที่กดเปิด อยู่ "เหนือ" ตาราง — ตารางยาว 31 แถว ถ้าวางไว้ใต้ตารางจะตกจอไปไกลมาก */}
      <div ref={viewRef}>
        {open && <SheetView data={open} photos={photos} onPhoto={loadPhoto} onClose={() => setOpen(null)} />}
      </div>

      {/* ตาราง 1 แถว = 1 วัน · กว้างเกินจอให้เลื่อนในกล่องตัวเอง ไม่ดันทั้งหน้า */}
      {data && !busy && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line,#eee3d9)', borderRadius: 11, background: '#fff' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 340, fontFamily: 'Sarabun, sans-serif' }}>
            <thead>
              <tr>
                <th style={{ ...thBase, textAlign: 'left', paddingLeft: 11, width: 62 }}>วันที่</th>
                {cols.map(c => <th key={c} style={thBase}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.days.map(d => (
                <tr key={d.date} style={{ background: d.holiday ? '#faf7f4' : '#fff' }}>
                  <td style={{ ...tdBase, textAlign: 'left', paddingLeft: 11, whiteSpace: 'nowrap' }}>
                    <b style={{ fontSize: 13 }}>{d.day}</b>
                    <span style={{ fontSize: 11, color: d.weekday === 0 ? '#b3261e' : 'var(--ink-soft,#6d6259)', marginLeft: 5 }}>
                      {WD[d.weekday]}
                    </span>
                  </td>
                  {cols.map(col => {
                    const cell = d.cells.find(c => c.shift === col);
                    if (!cell) {
                      return (
                        <td key={col} style={{ ...tdBase, color: '#d8cec4', fontSize: 11 }}>
                          {d.holiday ? 'หยุด' : '—'}
                        </td>
                      );
                    }
                    const st = CELL[cell.state];
                    const clickable = !!cell.id;
                    const title = [
                      `${d.date} กะ${cell.shift}`, st.label,
                      cell.state !== 'none' ? `ปกติ ${cell.ok} · ไม่ปกติ ${cell.ng} จาก ${cell.total} ข้อ` : '',
                      cell.submittedBy ? `ส่งโดย ${cell.submittedBy}` : '',
                      cell.planned ? '' : 'กะนอกตาราง (OT)',
                    ].filter(Boolean).join('\n');
                    return (
                      <td key={col} style={{ ...tdBase, padding: 3 }}>
                        <button
                          onClick={() => clickable && openSheet(cell.id!)}
                          disabled={!clickable}
                          title={title}
                          style={{
                            width: '100%', minHeight: 30, border: `1px solid ${st.bd}`, borderRadius: 8,
                            background: st.bg, color: st.fg, cursor: clickable ? 'pointer' : 'default',
                            fontFamily: 'Sarabun, sans-serif', fontSize: 12, fontWeight: 700,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                            opacity: openBusy === cell.id ? 0.5 : 1,
                            borderStyle: cell.state === 'none' ? 'dashed' : 'solid',
                          }}>
                          <span>{st.mark}</span>
                          {cell.state === 'ng' && <span>{cell.ng}</span>}
                          {!cell.planned && <span style={{ fontSize: 9, fontWeight: 600 }}>OT</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* คำอธิบายสัญลักษณ์ — ตารางนี้ไม่มีทางเดาเองได้ว่า ◔ แปลว่าอะไร */}
      {data && !busy && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 9, fontSize: 11.5, color: 'var(--ink-soft,#6d6259)' }}>
          {(Object.keys(CELL) as Cell['state'][]).map(k => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <i style={{
                width: 17, height: 17, borderRadius: 5, background: CELL[k].bg, color: CELL[k].fg,
                border: `1px ${k === 'none' ? 'dashed' : 'solid'} ${CELL[k].bd}`,
                display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700,
              }}>{CELL[k].mark}</i>
              {CELL[k].label}
            </span>
          ))}
        </div>
      )}

    </div>
  );
};

const thBase: React.CSSProperties = {
  fontFamily: 'Kanit, sans-serif', fontSize: 11.5, fontWeight: 600, color: 'var(--ink-soft,#6d6259)',
  padding: '7px 4px', borderBottom: '1px solid var(--line,#eee3d9)', textAlign: 'center', background: '#faf7f4',
  position: 'sticky', top: 0,
};
const tdBase: React.CSSProperties = {
  padding: '2px 4px', borderBottom: '1px solid #f5efe9', textAlign: 'center', verticalAlign: 'middle',
};

/* ── ใบเดียวที่กดเปิดดู — อ่านอย่างเดียว ── */
const SheetView: React.FC<{
  data: Sheet; photos: Record<string, string>;
  onPhoto: (sheetId: number, nodeKey: string) => void; onClose: () => void;
}> = ({ data, photos, onPhoto, onClose }) => {
  const { sheet, items, summary } = data;
  return (
    <div style={{ margin: '4px 0 12px', border: '1px solid #cdbfae', borderRadius: 12, background: '#fffdfa', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap', marginBottom: 9 }}>
        <div style={{ fontFamily: 'Kanit, sans-serif', fontSize: 14, fontWeight: 600 }}>
          {sheet.line} · กะ{sheet.shift}
        </div>
        <span style={{ fontSize: 12.5, color: 'var(--ink-soft,#6d6259)' }}>{sheet.workDay}</span>
        {sheet.lineStatus && (
          <span style={{ fontSize: 11.5, background: '#f2ece6', borderRadius: 999, padding: '2px 9px' }}>
            {LINE_STATUS[sheet.lineStatus] || sheet.lineStatus}
          </span>
        )}
        <span style={{
          fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: '2px 9px',
          background: sheet.status === 'submitted' ? '#e8f5ee' : '#fff6e8',
          color: sheet.status === 'submitted' ? '#1c7a4c' : '#a86a10',
        }}>
          {sheet.status === 'submitted' ? `ส่งแล้ว · ${sheet.submittedBy || 'ไม่ระบุคน'}` : 'ค้างไว้ ยังไม่ส่ง'}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ ...btn, padding: '4px 12px', fontSize: 12 }}>✕ ปิดใบ</button>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--ink-soft,#6d6259)', marginBottom: 9 }}>
        ปกติ <b style={{ color: '#1c7a4c' }}>{summary.ok}</b> ·
        ไม่ปกติ <b style={{ color: '#b3261e' }}>{summary.ng}</b> · ทั้งหมด {summary.total} ข้อ
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map(it => {
          const ng = it.result === 'ng';
          const ph = photos[it.nodeKey];
          return (
            <div key={it.nodeKey} style={{
              borderRadius: 9, padding: '7px 10px',
              background: ng ? '#fdece9' : '#fff',
              border: `1px solid ${ng ? '#eeb0a4' : 'var(--line,#eee3d9)'}`,
            }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{
                  flex: 'none', width: 19, height: 19, borderRadius: 6, marginTop: 1,
                  display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
                  background: ng ? '#b3261e' : it.result === 'ok' ? '#1c7a4c' : '#e8ddd2',
                  color: ng || it.result === 'ok' ? '#fff' : '#a89e94',
                }}>{ng ? '!' : it.result === 'ok' ? '✓' : '·'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.45 }}>
                    {it.seq}. {it.title}
                    {it.gone && (
                      <span title="ข้อนี้ถูกเอาออกจากทะเบียนไปแล้ว แต่วันนั้นตรวจจริง"
                        style={{ fontSize: 10.5, fontWeight: 600, color: '#8a7f74', background: '#f2ece6', borderRadius: 999, padding: '1px 7px', marginLeft: 6 }}>
                        ไม่มีในทะเบียนแล้ว
                      </span>
                    )}
                  </div>
                  {it.cause && (
                    <div style={{ fontSize: 12.5, color: '#8a2b21', lineHeight: 1.5, marginTop: 2 }}>⚠️ {it.cause}</div>
                  )}
                  {it.checkedBy && (
                    <div style={{ fontSize: 11, color: 'var(--ink-soft,#6d6259)', marginTop: 2 }}>
                      โดย {it.checkedBy}{it.updatedAt ? ` · ${it.updatedAt.slice(11, 16)} น.` : ''}
                    </div>
                  )}
                </div>
                {it.hasPhoto && !it.photoUrl && !ph && (
                  <button onClick={() => onPhoto(sheet.id, it.nodeKey)}
                    style={{ ...btn, padding: '3px 9px', fontSize: 12, flex: 'none' }}>🖼</button>
                )}
                {ph === 'loading' && <span style={{ fontSize: 12, color: '#a89e94', flex: 'none' }}>⏳</span>}
              </div>
              {(it.photoUrl || (ph && ph !== 'loading')) && (
                <img src={it.photoUrl || ph} alt={`รูปข้อ ${it.seq}`}
                  style={{ marginTop: 7, maxWidth: 220, width: '100%', borderRadius: 9, border: '1px solid var(--line,#eee3d9)' }} />
              )}
            </div>
          );
        })}
        {items.length === 0 && (
          <div style={{ fontSize: 12.5, color: '#a89e94', padding: '10px 2px' }}>ใบนี้ยังไม่มีใครติ๊กสักข้อ</div>
        )}
      </div>
    </div>
  );
};

export default AmSheetHistory;
