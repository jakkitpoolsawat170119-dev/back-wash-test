import React from 'react';
import BrandLogo from './BrandLogo';
import ArticleShelf from './ArticleShelf';
import type { AppView } from './TopBar';

interface Props {
  onNav: (v: AppView) => void;
}

/**
 * Home launcher — 3 primary cards + sticky footer.
 * Status pills are static, true descriptors (not fabricated live data);
 * wire real status later if desired.
 */
const Home: React.FC<Props> = ({ onNav }) => (
  <>
    <div className="rd-home-body">
      <div className="wrap">
        <div className="launch">
          <button className="lcard prod" onClick={() => onNav('production')}>
            <span className="ic">🏭</span>
            <h3>บันทึกการผลิต</h3>
            <p>ลงบันทึก batch, brix, pH, lot และเวลาเริ่ม–จบ ของแต่ละ Line</p>
            <span className="status">
              <span className="pill">Line 1 · 2 · 3</span>
            </span>
          </button>

          <button className="lcard cip" onClick={() => onNav('cip')}>
            <span className="ic">💧</span>
            <h3>CIP</h3>
            <p>ล้างระบบ Line 1 · Line 2 · Line 3 และ CIP ทดลอง — รวมอยู่หน้าเดียว</p>
            <span className="status">
              <span className="pill blue">4 โหมดในหน้าเดียว</span>
            </span>
          </button>

          <button className="lcard stick" onClick={() => onNav('stickerchat')}>
            <span className="ic">💬</span>
            <h3>วิธีติดสติ๊กเกอร์</h3>
            <p>ถาม AI หาวิธีติดสติ๊กเกอร์ตามลูกค้าแต่ละเจ้า พร้อมรูปประกอบ</p>
            <span className="status">
              <span className="pill teal">ค้นด้วยชื่อลูกค้า</span>
            </span>
          </button>
        </div>

        {/* ชั้นบทความ — ไม่มีบทความเผยแพร่ก็ไม่ขึ้นอะไรเลย หน้าหลักจะได้ไม่มีกล่องว่าง */}
        <ArticleShelf />
      </div>
    </div>

    <footer className="home-foot">
      <div className="foot-in">
        <div className="flogo">
          <BrandLogo size={26} />
        </div>
      </div>
    </footer>
  </>
);

export default Home;
