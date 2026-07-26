import React, { useEffect, useRef, useState } from 'react';
import BrandLogo from './BrandLogo';
import AdminGate, { isAdminAuthed } from './AdminGate';
import AdminOverview from './AdminOverview';
import TodoBoard from './TodoBoard';
import Line4Manual from './Line4Manual';
import StickerGuideAdmin from './StickerGuideAdmin';
import ErrorBoundary from './ErrorBoundary';

type TodoTab = 'today' | 'audit' | 'calendar' | 'report' | 'timeline' | 'recurring' | 'ai' | 'specs';
type Pane = 'overview' | TodoTab | 'line4' | 'stickeradmin';

const TODO_TABS: string[] = ['today', 'audit', 'calendar', 'report', 'timeline', 'recurring', 'ai', 'specs'];

const MENU: { pane: Pane; ic: string; label: string; sub?: boolean }[] = [
  { pane: 'overview', ic: '📊', label: 'ภาพรวม' },
  { pane: 'today', ic: '✅', label: 'งานวันนี้' },
  { pane: 'audit', ic: '🧭', label: 'พื้นที่รับผิดชอบ' },
  { pane: 'calendar', ic: '📅', label: 'ปฏิทิน' },
  { pane: 'report', ic: '📈', label: 'รายงาน' },
  { pane: 'timeline', ic: '🕒', label: 'Timeline รับ-ส่งกะ' },
  { pane: 'recurring', ic: '🔁', label: 'งานประจำ' },
  { pane: 'ai', ic: '🤖', label: 'AI ผู้ช่วย' },
  { pane: 'line4', ic: '📋', label: 'คู่มือ Line 4' },
  { pane: 'stickeradmin', ic: '🗂️', label: 'QC Record' },
  { pane: 'specs', ic: '📐', label: 'สเปคคุณภาพ', sub: true },
];

interface Props {
  operator: string;
  onExit: () => void;                                    // ออกจาก Admin → หน้าหลัก
  onNavOut: (v: 'production' | 'cip') => void;            // ทางลัดออกไปหน้าผลิต/CIP
}

const AdminShell: React.FC<Props> = ({ operator, onExit, onNavOut }) => {
  const [authed, setAuthed] = useState(isAdminAuthed);
  const [pane, setPane] = useState<Pane>('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const ddRef = useRef<HTMLDivElement>(null);
  const atopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menuOpen]);

  if (!authed) return <AdminGate onExit={onExit} onAuthed={() => setAuthed(true)} />;

  const go = (p: Pane) => { setPane(p); setMenuOpen(false); window.scrollTo({ top: 0 }); };

  const toggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const willOpen = !menuOpen;
    if (willOpen && window.innerWidth <= 480 && ddRef.current && atopRef.current) {
      ddRef.current.style.top = `${atopRef.current.getBoundingClientRect().bottom + 8}px`;
    } else if (ddRef.current) {
      ddRef.current.style.top = '';
    }
    setMenuOpen(willOpen);
  };

  const isTodo = TODO_TABS.includes(pane);
  const MenuButtons = ({ cls }: { cls: 'rsbtn' | 'menu' }) => (
    <>
      {MENU.map(m => (
        <button
          key={m.pane}
          className={`${cls === 'rsbtn' ? 'rsbtn' : ''}${m.sub ? ' sub' : ''}${pane === m.pane ? ' on' : ''}`}
          onClick={() => go(m.pane)}
        >
          <span className="ic">{m.ic}</span>{m.label}
        </button>
      ))}
    </>
  );

  return (
    <div className="rd-shell rd-admin">
      <div className="atop" ref={atopRef}>
        <button className="logo" onClick={onExit} aria-label="SPP-MP">
          <BrandLogo size={26} />
        </button>

        <div className="menuwrap" ref={menuWrapRef}>
          <button className="abtn" onClick={toggleMenu}><span className="ic">☰</span><span className="tx">เมนู</span></button>
          <div className={`menu-dd${menuOpen ? ' open' : ''}`} ref={ddRef}>
            <MenuButtons cls="menu" />
          </div>
        </div>

        <div className="search">🔎 ค้นหางาน, batch, คู่มือ…</div>
        <span className="sys"><span className="dot" />ระบบปกติ</span>
        <span className="achip"><span className="av">{(operator || 'A').slice(0, 1)}</span>{operator || 'ผู้ดูแล'}</span>
        <button className="abtn ghost" onClick={onExit}><span className="ic">↩</span><span className="tx">ออกจาก Admin</span></button>
      </div>

      <div className="amain">
        <aside className="aside-r">
          <MenuButtons cls="rsbtn" />
        </aside>

        <div className="abody">
          {pane === 'overview' && (
            <AdminOverview onOpen={(v) => {
              if (v === 'today') go('today');
              else onNavOut(v);
            }} />
          )}

          {/* TodoBoard stays mounted so AI chat / drafts survive pane switches */}
          <div className="rd-legacy" style={{ display: isTodo ? 'block' : 'none' }}>
            <ErrorBoundary label="admin-todo">
              <TodoBoard
                operatorName={operator}
                onBackToMain={onExit}
                onGoToProduction={() => onNavOut('production')}
                hideChrome
                externalTab={isTodo ? (pane as TodoTab) : undefined}
                onTabChange={(t) => setPane(prev => (TODO_TABS.includes(prev) ? t : prev))}
              />
            </ErrorBoundary>
          </div>

          {pane === 'line4' && (
            <div className="rd-legacy">
              <ErrorBoundary label="admin-line4"><Line4Manual operatorName={operator} onBackToMain={onExit} /></ErrorBoundary>
            </div>
          )}

          {pane === 'stickeradmin' && (
            <div className="rd-legacy">
              <ErrorBoundary label="admin-qc"><StickerGuideAdmin onBackToMain={onExit} /></ErrorBoundary>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminShell;
