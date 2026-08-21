import React, { useEffect, useRef, useState } from 'react';
import { useAppRoute, pickRouteValue } from '../hooks/useAppRoute';
import BrandLogo from './BrandLogo';
import AdminGate from './AdminGate';
import { isAdminAuthed } from '../lib/auth';
import AdminOverview from './AdminOverview';
import TodoBoard from './TodoBoard';
import Line4Manual from './Line4Manual';
import StickerGuideAdmin from './StickerGuideAdmin';
import SppReportForm from './SppReportForm';
import ProductionApprovalBoard from './ProductionApprovalBoard';
import SkuReviewPanel from './SkuReviewPanel';
import ProductionTimeline from './ProductionTimeline';
import BlogEditor from './BlogEditor';
import ObsidianInbox from './ObsidianInbox';
import MaintenanceBoard from './MaintenanceBoard';
import PmRegistry from './PmRegistry';
import MachineRegistry from './MachineRegistry';
import IncidentBoard from './IncidentBoard';
import DowntimeReport from './DowntimeReport';
import UsersAdmin from './UsersAdmin';
import MaterialsBoard from './MaterialsBoard';
import CostBoard from './CostBoard';
import QualityReport from './QualityReport';
import PerformanceReport from './PerformanceReport';
import MediaPane from './MediaPane';
import ErrorBoundary from './ErrorBoundary';

type TodoTab = 'today' | 'audit' | 'calendar' | 'report' | 'timeline' | 'recurring' | 'ai' | 'specs';
type Pane = 'overview' | TodoTab | 'line4' | 'stickeradmin' | 'sppreport' | 'sppapprove' | 'skureview' | 'spptimeline' | 'blog' | 'obsidian' | 'maint' | 'pmreg' | 'downtime' | 'machines' | 'incidents' | 'users' | 'materials' | 'cost' | 'quality' | 'perf' | 'media';

const TODO_TABS: string[] = ['today', 'audit', 'calendar', 'report', 'timeline', 'recurring', 'ai', 'specs'];

// เมนูเดียวใช้ทั้งแถบซ้ายและ dropdown · แถวที่มี head = หัวข้อกลุ่ม (ไม่ใช่ปุ่ม)
type MenuRow = { pane: Pane; ic: string; label: string; sub?: boolean } | { head: string; ic: string; km?: boolean };
const isHead = (m: MenuRow): m is { head: string; ic: string; km?: boolean } => 'head' in m;

const MENU: MenuRow[] = [
  { pane: 'overview', ic: '📊', label: 'ภาพรวม' },
  { pane: 'timeline', ic: '🕒', label: 'Timeline รับ-ส่งกะ' },
  { pane: 'sppreport', ic: '🏭', label: 'ลงยอดผลิต' },
  { pane: 'sppapprove', ic: '✔️', label: 'อนุมัติยอดผลิต', sub: true },
  { pane: 'spptimeline', ic: '🕘', label: 'ประวัติยอดผลิต', sub: true },
  { pane: 'skureview', ic: '🗃️', label: 'SKU รอตรวจสอบ', sub: true },
  { pane: 'today', ic: '✅', label: 'งานวันนี้' },
  { pane: 'audit', ic: '🧭', label: 'พื้นที่รับผิดชอบ' },
  { pane: 'calendar', ic: '📅', label: 'ปฏิทิน' },
  { pane: 'report', ic: '📈', label: 'รายงาน' },
  { pane: 'perf', ic: '👥', label: 'เทียบประสิทธิภาพ', sub: true },
  { pane: 'recurring', ic: '🔁', label: 'งานประจำ' },
  { pane: 'ai', ic: '🤖', label: 'AI ผู้ช่วย' },
  { pane: 'materials', ic: '🧪', label: 'คลังวัสดุ / สารเคมี' },
  { pane: 'cost', ic: '💰', label: 'ต้นทุนต่อ batch', sub: true },
  { head: 'งานซ่อมบำรุง', ic: '🔧' },
  { pane: 'maint', ic: '👷', label: 'กระดานทีมซ่อมบำรุง', sub: true },
  { pane: 'pmreg', ic: '🛠', label: 'ทะเบียนงาน PM', sub: true },
  { pane: 'downtime', ic: '⏱', label: 'เวลาเครื่องหยุด', sub: true },
  { head: 'Knowledge management', ic: '📚', km: true },
  { pane: 'blog', ic: '✍️', label: 'บทความ / คู่มือ / SOP', sub: true },
  { pane: 'media', ic: '🗂', label: 'คลังไฟล์', sub: true },
  { pane: 'machines', ic: '⚙️', label: 'ทะเบียนเครื่องจักร', sub: true },
  { pane: 'incidents', ic: '⚡', label: 'เหตุการณ์', sub: true },
  { pane: 'obsidian', ic: '📥', label: 'จาก Obsidian', sub: true },
  { pane: 'line4', ic: '📋', label: 'คู่มือ Line 4' },
  { pane: 'stickeradmin', ic: '🗂️', label: 'QC Record' },
  { pane: 'specs', ic: '📐', label: 'สเปคคุณภาพ', sub: true },
  { pane: 'quality', ic: '🔬', label: 'วิเคราะห์คุณภาพ', sub: true },
  { pane: 'users', ic: '🔐', label: 'ผู้ใช้และสิทธิ์' },
];

const PANES: Pane[] = MENU.filter(m => !isHead(m)).map(m => (m as { pane: Pane }).pane);

interface Props {
  operator: string;
  onExit: () => void;                                    // ออกจาก Admin → หน้าหลัก
  onNavOut: (v: 'production' | 'cip') => void;            // ทางลัดออกไปหน้าผลิต/CIP
}

const AdminShell: React.FC<Props> = ({ operator, onExit, onNavOut }) => {
  const [authed, setAuthed] = useState(isAdminAuthed);
  // เมนูที่เปิดอยู่เก็บใน URL (?page=admin&tab=timeline) รีเฟรชแล้วยังอยู่เมนูเดิม
  const [route, navigate] = useAppRoute();
  const pane = pickRouteValue<Pane>(route.tab, PANES, 'overview');
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

  /* ── ความสูงจริงของแถบบน → ตัวแปร --admin-top ──
   * ทุกอย่างที่ต้องเกาะจอ (เมนูซ้าย, แถบเครื่องมือบทความ, แถบตั้งค่า) เกาะต่อจากแถบนี้
   * ฮาร์ดโค้ด 57px ไม่พอ เพราะพอจอแคบลงแถบบนขึ้นเป็นสองแถวแล้วของที่เกาะจะมุดหายไปใต้มัน
   */
  useEffect(() => {
    const el = atopRef.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty(
      '--admin-top', `${Math.round(el.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty('--admin-top'); };
  }, [authed]);

  if (!authed) return <AdminGate onExit={onExit} onAuthed={() => setAuthed(true)} />;

  const go = (p: Pane) => { navigate({ tab: p, item: null }); setMenuOpen(false); window.scrollTo({ top: 0 }); };

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
      {MENU.map(m => (isHead(m) ? (
        <div key={m.head} className={`rsgroup${m.km ? ' km' : ''}`}>
          <span className="ic">{m.ic}</span>{m.head}
        </div>
      ) : (
        <button
          key={m.pane}
          className={`${cls === 'rsbtn' ? 'rsbtn' : ''}${m.sub ? ' sub' : ''}${pane === m.pane ? ' on' : ''}`}
          onClick={() => go(m.pane)}
        >
          <span className="ic">{m.ic}</span>{m.label}
        </button>
      )))}
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
            <AdminOverview
              onOpen={(v) => {
                if (v === 'today') go('today');
                else onNavOut(v);
              }}
              onPane={(p) => { if ((PANES as string[]).includes(p)) go(p as Pane); }}
            />
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
                onTabChange={(t) => { if (isTodo) navigate({ tab: t, item: null }); }}
              />
            </ErrorBoundary>
          </div>

          {pane === 'blog' && (
            <ErrorBoundary label="admin-blog"><BlogEditor operatorName={operator} /></ErrorBoundary>
          )}

          {pane === 'cost' && (
            <ErrorBoundary label="admin-cost"><CostBoard /></ErrorBoundary>
          )}
          {pane === 'materials' && (
            <ErrorBoundary label="admin-materials"><MaterialsBoard operatorName={operator} /></ErrorBoundary>
          )}
          {pane === 'users' && (
            <ErrorBoundary label="admin-users"><UsersAdmin /></ErrorBoundary>
          )}
          {pane === 'media' && (
            <ErrorBoundary label="admin-media"><MediaPane operatorName={operator} onExit={() => go('overview')} /></ErrorBoundary>
          )}
          {pane === 'perf' && (
            <ErrorBoundary label="admin-perf"><PerformanceReport /></ErrorBoundary>
          )}
          {pane === 'quality' && (
            <ErrorBoundary label="admin-quality"><QualityReport /></ErrorBoundary>
          )}
          {pane === 'downtime' && (
            <ErrorBoundary label="admin-downtime"><DowntimeReport /></ErrorBoundary>
          )}
          {pane === 'maint' && (
            <ErrorBoundary label="admin-maint"><MaintenanceBoard operatorName={operator} /></ErrorBoundary>
          )}

          {pane === 'pmreg' && (
            <ErrorBoundary label="admin-pmreg"><PmRegistry /></ErrorBoundary>
          )}

          {pane === 'machines' && (
            <ErrorBoundary label="admin-machines"><MachineRegistry /></ErrorBoundary>
          )}

          {pane === 'incidents' && (
            <ErrorBoundary label="admin-incidents"><IncidentBoard operatorName={operator} /></ErrorBoundary>
          )}

          {pane === 'obsidian' && (
            <ErrorBoundary label="admin-obsidian"><ObsidianInbox operatorName={operator} /></ErrorBoundary>
          )}

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

          {pane === 'sppreport' && (
            <div className="rd-legacy">
              <ErrorBoundary label="admin-sppreport"><SppReportForm operatorName={operator} /></ErrorBoundary>
            </div>
          )}

          {pane === 'sppapprove' && (
            <div className="rd-legacy">
              <ErrorBoundary label="admin-sppapprove"><ProductionApprovalBoard operator={operator} /></ErrorBoundary>
            </div>
          )}

          {pane === 'spptimeline' && (
            <div className="rd-legacy">
              <ErrorBoundary label="admin-spptimeline"><ProductionTimeline /></ErrorBoundary>
            </div>
          )}

          {pane === 'skureview' && (
            <div className="rd-legacy">
              <ErrorBoundary label="admin-skureview"><SkuReviewPanel /></ErrorBoundary>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminShell;
