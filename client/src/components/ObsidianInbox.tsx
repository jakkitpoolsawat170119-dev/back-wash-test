import React, { useCallback, useEffect, useState } from 'react';
import { wakeFetch } from '../lib/wakeFetch';
import '../obsidian.css';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

type Kind = 'reopen' | 'edit' | 'new';

interface InboxItem {
  id: number;
  kind: Kind;
  task_id: number;
  file_path: string;
  line_text: string;
  proposed_title: string;
  task_date: string;
  author: string;
  created_at: string;
}
interface ClosedItem { id: number; title: string; completed_at: string; done_by: string }

const BADGE: Record<Kind, { label: string; hint: string }> = {
  reopen: { label: 'ขอเปิดใหม่', hint: 'งานนี้ปิดไปแล้ว แต่มีคนปลดติ๊กใน Obsidian' },
  edit: { label: 'แก้ข้อความ', hint: 'มีคนแก้ชื่องานในไฟล์ — รับแล้วชื่อในแอปจะเปลี่ยนตาม' },
  new: { label: 'งานใหม่', hint: 'มีคนจดงานเองในไฟล์ — รับแล้วจะกลายเป็นงานในแอป' },
};

const when = (s?: string) => String(s || '').slice(0, 16).replace('T', ' ');

const ObsidianInbox: React.FC<{ operatorName: string }> = ({ operatorName }) => {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [closed, setClosed] = useState<ClosedItem[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await wakeFetch(`${apiUrl}/api/obsidian/inbox`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setItems(j.items || []);
      setClosed(j.closedFromVault || []);
      setEnabled(!!j.enabled);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (id: number, accept: boolean) => {
    setBusy(id);
    try {
      const r = await wakeFetch(`${apiUrl}/api/obsidian/inbox/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, accept, operator: operatorName }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setNote(accept ? 'รับเข้าระบบแล้ว' : 'ไม่รับรายการนี้');
      await load();
    } catch (e) {
      alert('ทำรายการไม่สำเร็จ — ' + (e instanceof Error ? e.message : ''));
    } finally { setBusy(null); }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await wakeFetch(`${apiUrl}/api/obsidian/sync-tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const closedNow = (j.inbound && j.inbound.closed && j.inbound.closed.length) || 0;
      setNote(closedNow ? `อ่านจาก Obsidian แล้ว — ปิดงานให้ ${closedNow} งาน` : 'อ่านจาก Obsidian แล้ว — ไม่มีอะไรใหม่');
      await load();
    } catch (e) {
      alert('sync ไม่สำเร็จ — ' + (e instanceof Error ? e.message : ''));
    } finally { setSyncing(false); }
  };

  return (
    <div className="obsx">
      <div className="ohead">
        <div>
          <h2>📥 จาก Obsidian</h2>
          <p>
            ติ๊กปิดงานใน Obsidian แล้วงานในแอปปิดตามให้เอง · ส่วนที่กำกวม (ปลดติ๊ก / แก้ข้อความ / งานที่จดเอง)
            จะมารอให้กดยืนยันตรงนี้ก่อน ไม่เปลี่ยนเงียบ ๆ
          </p>
        </div>
        <div className="spacer" />
        <button className="obtn" onClick={syncNow} disabled={syncing || enabled === false}>
          {syncing ? 'กำลังอ่าน…' : 'อ่านจาก Obsidian เดี๋ยวนี้'}
        </button>
      </div>

      {enabled === false && (
        <div className="obanner warn">
          ⚠️ เซิร์ฟเวอร์ยังไม่ได้ต่อกับ vault — ต้องตั้ง <code>VAULT_GITHUB_TOKEN</code> ก่อน
          ตอนนี้งานจะยังไม่ไหลไป-กลับกับ Obsidian
        </div>
      )}
      {err && <div className="obanner warn">โหลดข้อมูลไม่สำเร็จ — {err}</div>}
      {note && <div className="obanner">{note}</div>}

      <div className="osec">
        <h3>
          ⏳ รอคุณยืนยัน
          {items.length > 0 && <span className="ocount">{items.length}</span>}
        </h3>
        {loading ? (
          <div className="oempty">กำลังโหลด…</div>
        ) : items.length === 0 ? (
          <div className="oempty">ไม่มีอะไรค้างรอ — ของที่เปลี่ยนใน Obsidian ถูกจัดการครบแล้ว</div>
        ) : items.map(it => (
          <div className="ocard" key={it.id}>
            <div className="grow">
              <span className={`obadge ${it.kind}`}>{BADGE[it.kind]?.label || it.kind}</span>
              <div className="otitle">{it.proposed_title || it.line_text}</div>
              <div className="ometa">
                {BADGE[it.kind]?.hint}
                <br />
                📄 {it.file_path}
                {it.author && <> · ✍️ {it.author}</>}
                {it.created_at && <> · {when(it.created_at)}</>}
              </div>
            </div>
            <div className="oacts">
              <button className="obtn yes" disabled={busy === it.id} onClick={() => decide(it.id, true)}>รับ</button>
              <button className="obtn no" disabled={busy === it.id} onClick={() => decide(it.id, false)}>ไม่รับ</button>
            </div>
          </div>
        ))}
      </div>

      <div className="osec">
        <h3>✅ ปิดให้อัตโนมัติแล้ว</h3>
        {closed.length === 0 ? (
          <div className="oempty">ยังไม่มีงานที่ถูกติ๊กปิดจาก Obsidian วันนี้</div>
        ) : closed.map(c => (
          <div className="ocard odone" key={c.id}>
            <div className="grow">
              <div className="otitle">{c.title}</div>
              <div className="ometa">ติ๊กโดย {c.done_by || 'Obsidian'} · {when(c.completed_at)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ObsidianInbox;
