import { useCallback, useEffect, useState } from 'react';

/**
 * เก็บ "หน้าที่เปิดอยู่" ไว้ใน URL เพื่อให้รีเฟรชแล้วยังอยู่หน้าเดิม ไม่เด้งกลับหน้าหลัก
 *
 *   ?page=cip&tab=2                    → หน้า CIP แท็บ Line 2
 *   ?page=admin&tab=timeline           → Admin เมนู Timeline รับ-ส่งกะ
 *   ?page=admin&tab=line4&item=<id>    → คู่มือ Line 4 เปิดหน้านั้นอยู่
 *
 * ใช้ query string (ไม่ใช่ path หรือ hash) เพราะ
 *  - path ต้องพึ่ง rewrite ของ host ถ้าตั้งไม่ครบจะกลายเป็น 404 ตอนรีเฟรช
 *  - hash ถูกใช้อยู่แล้วสำหรับลิงก์ไปบล็อกในคู่มือ Line 4 (#block-<id>)
 * และ param อื่น (เช่น ?verify=) จะถูกคงไว้เสมอ
 */

const PAGE = 'page';
const TAB = 'tab';
const ITEM = 'item';
const ROUTE_EVENT = 'spp:routechange';

export interface AppRoute {
  /** หน้าหลักระดับบนสุด — ค่าเริ่มต้น 'home' */
  page: string;
  /** แท็บ/เมนูย่อยของหน้านั้น — null ถ้ายังไม่ได้ระบุ */
  tab: string | null;
  /** รายการที่เปิดอยู่ในแท็บนั้น เช่น id ของหน้าในคู่มือ Line 4 — null ถ้าไม่ได้เปิดอะไร */
  item: string | null;
}

/** เปลี่ยนเฉพาะ field ที่ส่งมา — field ที่ไม่ส่ง (undefined) ถือว่าใช้ค่าเดิม, null คือล้างทิ้ง */
export type RoutePatch = { page?: string; tab?: string | null; item?: string | null };

export function readRoute(): AppRoute {
  const q = new URLSearchParams(window.location.search);
  return { page: q.get(PAGE) || 'home', tab: q.get(TAB), item: q.get(ITEM) };
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
  if (next.item) q.set(ITEM, next.item);
  else q.delete(ITEM);
  const qs = q.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
}

/**
 * URL เต็มของ route ที่ระบุ ไว้ใช้ทำลิงก์แชร์ — เอาเฉพาะ page/tab/item
 * ไม่ลาก param อื่นที่ติดอยู่ใน URL ปัจจุบันไปด้วย (เช่น ?verify= ของคนอื่น)
 */
export function routeHref(next: AppRoute): string {
  const q = new URLSearchParams();
  if (next.page && next.page !== 'home') q.set(PAGE, next.page);
  if (next.tab) q.set(TAB, next.tab);
  if (next.item) q.set(ITEM, next.item);
  const qs = q.toString();
  return `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
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
      // ค่าเดิม = ไม่ต้อง render ใหม่
      return prev.page === next.page && prev.tab === next.tab && prev.item === next.item ? prev : next;
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
        item: patch.item !== undefined ? patch.item : cur.item,
      },
      replace,
    );
  }, []);

  return [route, navigate];
}

/**
 * ลิงก์คู่มือ Line 4 ที่แชร์ออกไปก่อนหน้านี้เป็นแบบ #block-<id> ล้วน ๆ ไม่มี ?page=
 * เปิดมาจะไปโผล่หน้าหลัก — เติม page/tab ให้ก่อน แล้วปล่อยให้ Line4Manual
 * แปลง hash เป็น ?item= ต่อเอง (เรียกครั้งเดียวตอนบูตใน main.tsx)
 */
export function normalizeLegacyLinks(): void {
  if (!window.location.hash.startsWith('#block-')) return;
  const q = new URLSearchParams(window.location.search);
  if (q.get(PAGE)) return; // ลิงก์รุ่นใหม่มี page ครบอยู่แล้ว
  q.set(PAGE, 'admin');
  q.set(TAB, 'line4');
  window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}${window.location.hash}`);
}

/** เลือกค่าจาก URL ที่อยู่ในรายการที่รู้จักเท่านั้น — ค่าแปลก ๆ ให้ตกกลับไปที่ค่าเริ่มต้น */
export function pickRouteValue<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
