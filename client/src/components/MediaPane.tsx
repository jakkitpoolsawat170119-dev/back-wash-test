import React, { useState } from 'react';
import MediaLibrary from './MediaLibrary';
import type { MediaItem } from '../lib/media';

/* ── คลังไฟล์แบบเปิดตรงจากเมนู Admin ────────────────────────────────────────
   เดิมเข้าได้จากในหน้าเขียนบทความเท่านั้น (เปิดเป็น modal เพื่อ "แทรกลงบทความ")
   หน้านี้ใช้ตัวเดียวกันทั้งดุ้น แค่เปลี่ยนปุ่มแทรก → คัดลอกลิงก์ไฟล์
   ปิดแล้วเด้งกลับหน้าที่เรียกมา (ส่ง onExit เข้ามา)                          */
interface Props {
  operatorName?: string;
  onExit: () => void;
}

const MediaPane: React.FC<Props> = ({ operatorName = '', onExit }) => {
  const [copied, setCopied] = useState('');

  const copyLink = async (item: MediaItem) => {
    const url = item.url || '';
    try {
      await navigator.clipboard.writeText(url);
      setCopied(`คัดลอกลิงก์ของ "${item.caption || item.name}" แล้ว`);
    } catch {
      // เบราว์เซอร์บางตัวไม่ให้เขียนคลิปบอร์ดถ้าไม่ได้กดจากท่าที่มันยอม — โชว์ลิงก์ให้ก๊อปเอง
      setCopied(url);
    }
  };

  return (
    <div>
      {copied && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 3000,
          background: '#2b2119', color: '#fff', borderRadius: 999, padding: '9px 16px',
          fontSize: 13, fontFamily: 'Sarabun, sans-serif', maxWidth: '90vw', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', boxShadow: '0 6px 20px rgba(0,0,0,.25)',
        }} onClick={() => setCopied('')}>📋 {copied}</div>
      )}
      <MediaLibrary
        accept="any"
        uploadedBy={operatorName}
        insertLabel="คัดลอกลิงก์"
        onInsert={copyLink}
        onClose={onExit}
      />
    </div>
  );
};

export default MediaPane;
