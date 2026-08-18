/* ══════════════ บทความบนหน้าหลัก ══════════════
 * ดึงเฉพาะบทความที่เผยแพร่แล้วมาโชว์เป็นการ์ด · ตัวบทความอ่านที่หน้าสาธารณะซึ่งเสิร์ฟจาก
 * เซิร์ฟเวอร์ (ไม่ใช่ Vercel) เพราะต้องมี og: meta ให้ LINE ทำการ์ดพรีวิว — ดู server/articlePage.js
 */

import { wakeFetch, type WakeState } from './wakeFetch';

const apiUrl = (import.meta.env.VITE_API_BASE as string) || 'https://back-wash-test.onrender.com';

export interface ArticleCard {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  category: string;
  machine: string;
  tags: string[];
  coverUrl: string;
  publishedAt?: string | null;
  updatedAt?: string;
}

/** ต้องตรงกับ CATS ใน server/articlePage.js และ CATEGORIES ใน BlogEditor.tsx — แก้ที่ไหนต้องแก้ให้ครบ */
export const CATS: { name: string; color: string; g: string; ic: string }[] = [
  { name: 'ระบบ CIP', color: '#ff6b00', g: 'g0', ic: '💧' },
  { name: 'Boiler', color: '#1565c0', g: 'g1', ic: '🔥' },
  { name: 'Evaporator', color: '#0f7a6c', g: 'g2', ic: '🧪' },
  { name: 'Mixing / Syrup', color: '#6a1b9a', g: 'g3', ic: '🍯' },
  { name: 'บรรจุ', color: '#1c8a4c', g: 'g4', ic: '📦' },
  { name: 'ความปลอดภัย', color: '#c77700', g: 'g5', ic: '🦺' },
  { name: 'ชีวิตและการทำงาน', color: '#c2185b', g: 'g6', ic: '🌱' },
  { name: 'หนังสือ', color: '#6d4c41', g: 'g7', ic: '📖' },
];
export const catStyle = (name: string) =>
  CATS.find(c => c.name === name) || { name, color: '#6d6259', g: 'g0', ic: '📄' };

/** ลิงก์หน้าอ่านสาธารณะ — ไม่ encode ตอนโชว์ ลิงก์ไทยอ่านออกและแปะใน LINE ได้ตรง ๆ */
export const readerUrl = (slug: string) => `${apiUrl}/บทความ/${slug}`;
export const categoryUrl = (cat: string) => `${apiUrl}/บทความ?cat=${encodeURIComponent(cat)}`;
export const allArticlesUrl = `${apiUrl}/บทความ`;

/** "12 ส.ค. 2569" — รูปแบบเดียวกับ thaiDate() ในหน้าอ่านสาธารณะ */
export function thaiDate(iso?: string | null): string {
  const m = String(iso || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${Number(m[1]) + 543}`;
}

// ใช้ wakeFetch เพราะหน้าหลักคือคำขอแรกของวัน — Render หลับอยู่ fetch ธรรมดาจะแพ้เวลาปลุก
export async function fetchPublished(limit = 12, onState?: (s: WakeState) => void): Promise<ArticleCard[]> {
  const r = await wakeFetch(`${apiUrl}/api/posts?status=published&limit=${limit}`, { onState });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.items) ? j.items : [];
}
