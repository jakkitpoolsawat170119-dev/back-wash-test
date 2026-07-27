import React, { useState, useCallback } from 'react';
import CipLine1Form from './CipLine1Form';
import CipLine2Form from './CipLine2Form';
import Logbook from './Logbook';
import ErrorBoundary from './ErrorBoundary';

type CipTab = '1' | '2' | '3' | 'x';

interface Props {
  operatorName: string;
  onBackToMain: () => void;
}

const SEG: { key: CipTab; label: string; dot: string }[] = [
  { key: '1', label: 'Line 1', dot: 'var(--cip1)' },
  { key: '2', label: 'Line 2', dot: 'var(--cip2)' },
  { key: '3', label: 'Line 3', dot: 'var(--cip3)' },
  { key: 'x', label: '⚗️ ทดลอง', dot: 'var(--cipx)' },
];

/**
 * Unified CIP page. The four original forms stay mounted at once (toggled with
 * display:none) so their draft state and page-locks survive tab switches —
 * same behaviour as the old App.tsx multi-mode layout.
 */
const CipHub: React.FC<Props> = ({ operatorName, onBackToMain }) => {
  const [tab, setTab] = useState<CipTab>('1');
  const noop = useCallback(() => {}, []);

  return (
    <div className="wrap">
      <div className="pagehead">
        <div>
          <h2>💧 CIP — ทุก Line ในหน้าเดียว</h2>
          <div className="sub">เลือก Line ด้านล่าง · ฟอร์มของแต่ละ Line ยังเป็นชุดเดิม</div>
        </div>
      </div>

      <div className="seg">
        {SEG.map(({ key, label, dot }) => (
          <button key={key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
            <span className="ldot" style={{ background: dot }} />{label}
          </button>
        ))}
      </div>

      <div className="cip-pane">
        <div className="rd-legacy" style={{ display: tab === '1' ? 'block' : 'none' }}>
          <ErrorBoundary label="cipLine1">
            <CipLine1Form operatorName={operatorName} onBackToMain={onBackToMain} onStatusChange={noop} />
          </ErrorBoundary>
        </div>
        <div className="rd-legacy" style={{ display: tab === '2' ? 'block' : 'none' }}>
          <ErrorBoundary label="cipLine2">
            <CipLine2Form operatorName={operatorName} onBackToMain={onBackToMain} onStatusChange={noop} defaultLine="Line 2" />
          </ErrorBoundary>
        </div>
        <div className="rd-legacy" style={{ display: tab === '3' ? 'block' : 'none' }}>
          <ErrorBoundary label="cipLine3">
            <CipLine2Form operatorName={operatorName} onBackToMain={onBackToMain} onStatusChange={noop} defaultLine="Line 3" />
          </ErrorBoundary>
        </div>
        <div className="rd-legacy" style={{ display: tab === 'x' ? 'block' : 'none' }}>
          <ErrorBoundary label="cip">
            <Logbook operatorName={operatorName} onLogout={onBackToMain} onBackToMain={onBackToMain} onHome={onBackToMain} onStatusChange={noop} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
};

export default CipHub;
