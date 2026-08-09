import { useCallback, useEffect, useState } from 'react';

/**
 * เก็บ "หน้าที่เปิดอยู่" ไว้ใน URL เพื่อให้รีเฟรชแล้วยังอยู่หน้าเดิม ไม่เด้งกลับหน้าหลัก
 *
 *   ?page=cip&tab=2          → หน้า CIP แท็บ Line 2
 *   ?page=admin&tab=timeline → Admin เมนู Timeline รับ-ส่งกะ
 *
 * ใช้ query string (ไม่ใช่ path หรือ hash) เพราะ
 *  - path ต้องพึ่ง rewrite ของ host ถ้าตั้งไม่ครบจะกลายเป็น 404 ตอนรีเฟรช
 *  - hash ถูกใช้อยู่แล้วสำหรับลิงก์ไปบล็อกในคู่มือ Line 4 (#block-<id>)
 * และ param อื่น (เช่น ?verify=) จะถูกคงไว้เสมอ
 */

const PAGE = 'page';
const TAB = 'tab';
const ROUTE_EVENT = 'spp:routechange';

export interface AppRoute {
  /** หน้าหลักระดับบนสุด — ค่าเริ่มต้น 'home' */
  page: string;
  /** แท็บ/เมนูย่อยของหน้านั้น — null ถ้ายังไม่ได้ระบุ */
  tab: string | null;
}

/** เปลี่ยนเฉพาะ field ที่ส่งมา — field ที่ไม่ส่ง (undefined) ถือว่าใช้ค่าเดิม, null คือล้างทิ้ง */
export type RoutePatch = { page?: string; tab?: string | null };

export function readRoute(): AppRoute {
  const q = new URLSearchParams(window.location.search);
  return { page: q.get(PAGE) || 'home', tab: q.get(TAB) };
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function buildUrl(next: AppRoute): string {
  const q = new URLSearchParams(window.location.search);
  if (next.page && next.page !== 'home') q.set(PAGE, next.page);
  else q.delete(PAGE);
  if (next.tab) q.set(TAB, next.tab);
  else q.delete(TAB);
  const qs = q.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
}

/**
 * เขียน route ลง URL — replace = true คือแทนที่รายการเดิมในประวัติ (ไม่เพิ่มขั้นให้ปุ่ม back)
 * ถ้า URL ไม่เปลี่ยนจะไม่ทำอะไรเลย กัน history บวมจาก re-render
 */
export function writeRoute(next: AppRoute, replace = false): void {
  const url = buildUrl(next);
  if (url === currentUrl()) return;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

/** อ่าน route ปัจจุบัน + ฟังก์ชันเปลี่ยนหน้า ที่ sync กับปุ่ม back/forward ของเบราว์เซอร์ */
export function useAppRoute(): [AppRoute, (patch: RoutePatch, replace?: boolean) => void] {
  const [route, setRoute] = useState<AppRoute>(readRoute);

  useEffect(() => {
    const sync = () => setRoute(prev => {
      const next = readRoute();
      return prev.page === next.page && prev.tab === next.tab ? prev : next; // ค่าเดิม = ไม่ต้อง render ใหม่
    });
    window.addEventListener('popstate', sync);
    window.addEventListener(ROUTE_EVENT, sync);
    sync(); // เผื่อ URL เปลี่ยนไปแล้วก่อน effect นี้จะติด listener
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(ROUTE_EVENT, sync);
    };
  }, []);

  const navigate = useCallback((patch: RoutePatch, replace = false) => {
    const cur = readRoute();
    writeRoute(
      {
        page: patch.page ?? cur.page,
        tab: patch.tab !== undefined ? patch.tab : cur.tab,
      },
      replace,
    );
  }, []);

  return [route, navigate];
}

/** เลือกค่าจาก URL ที่อยู่ในรายการที่รู้จักเท่านั้น — ค่าแปลก ๆ ให้ตกกลับไปที่ค่าเริ่มต้น */
export function pickRouteValue<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
