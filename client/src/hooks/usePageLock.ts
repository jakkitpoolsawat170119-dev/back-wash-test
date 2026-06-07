import { useCallback, useEffect, useRef, useState } from 'react';

const apiUrl = "https://back-wash-test.onrender.com";

interface UsePageLockResult {
  /** ชื่อผู้ที่กำลังใช้งานหน้านี้อยู่ (ถ้าไม่ใช่เรา) หรือ null ถ้าว่าง */
  lockedBy: string | null;
  /** ขอครองหน้านี้ — เรียกตอนเริ่มงาน คืนค่า true ถ้าได้ครอง / false ถ้ามีคนอื่นใช้อยู่หรือเช็คไม่ได้ */
  acquire: () => Promise<boolean>;
  /** ปล่อยหน้านี้ — เรียกตอนจบงาน/กลับเมนู */
  release: () => void;
}

/**
 * ระบบล็อคกันบันทึกข้อมูลซ้ำซ้อน — ใช้ pageKey แยกแต่ละหน้า/เครื่อง (เช่น "cip-line-1")
 * acquire() จะ fail-closed: ถ้าตรวจสอบสถานะไม่สำเร็จ จะถือว่ายังเริ่มงานไม่ได้ เพื่อกันบันทึกซ้ำ
 */
export function usePageLock(pageKey: string, operatorName: string, isActive: boolean): UsePageLockResult {
  const [lockedBy, setLockedBy] = useState<string | null>(null);
  const heldRef = useRef(false);

  const acquire = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${apiUrl}/api/locks/acquire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageKey, operatorName })
      });
      if (!res.ok) throw new Error('lock check failed');
      const data = await res.json();
      if (data.locked) {
        setLockedBy(data.operatorName);
        alert(`🔒 หน้านี้กำลังถูกใช้งานโดยคุณ ${data.operatorName} อยู่ในขณะนี้\nกรุณารอสักครู่แล้วลองใหม่อีกครั้งครับ`);
        return false;
      }
      heldRef.current = true;
      setLockedBy(null);
      return true;
    } catch {
      alert("⚠️ ไม่สามารถตรวจสอบสถานะการใช้งานได้ในขณะนี้ (เซิร์ฟเวอร์อาจกำลังเริ่มทำงาน)\nกรุณารอสักครู่ แล้วลองใหม่อีกครั้งครับ");
      return false;
    }
  }, [pageKey, operatorName]);

  const release = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    fetch(`${apiUrl}/api/locks/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageKey, operatorName })
    }).catch(() => {});
  }, [pageKey, operatorName]);

  // ส่ง heartbeat เป็นระยะระหว่างที่กำลังทำงานอยู่ เพื่อรักษาล็อคไว้ไม่ให้หมดอายุ
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      fetch(`${apiUrl}/api/locks/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageKey, operatorName })
      }).catch(() => {});
    }, 20000);
    return () => clearInterval(interval);
  }, [isActive, pageKey, operatorName]);

  // ตรวจสอบสถานะล็อคเป็นระยะ เพื่อโชว์ข้อความ "กำลังใช้งาน" เมื่อมีคนอื่นถือล็อคอยู่ (และเราไม่ได้ครองอยู่)
  useEffect(() => {
    if (isActive) return;
    const checkLock = () => {
      fetch(`${apiUrl}/api/locks/status?pageKey=${encodeURIComponent(pageKey)}`)
        .then(r => r.json())
        .then(data => setLockedBy((data.locked && data.operatorName !== operatorName) ? data.operatorName : null))
        .catch(() => {});
    };
    checkLock();
    const interval = setInterval(checkLock, 15000);
    return () => clearInterval(interval);
  }, [isActive, pageKey, operatorName]);

  // ปล่อยล็อคอัตโนมัติเมื่อ component ถูก unmount (เช่น กลับเมนู/ปิดแท็บ)
  useEffect(() => {
    return () => { release(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { lockedBy, acquire, release };
}
