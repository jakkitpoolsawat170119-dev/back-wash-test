/* สิทธิ์/โทเคนของคนที่ผ่านประตูหน้าผู้ดูแล (AdminGate เป็นคนเซ็ตค่าพวกนี้)
   แยกไฟล์ออกจากคอมโพเนนต์ เพราะไฟล์ที่ export ทั้งคอมโพเนนต์และฟังก์ชันทำให้ hot-reload เพี้ยน */
export const ADMIN_AUTH_KEY = 'stickerGuideAdminAuthed';   // คีย์เดิม — QC Record ที่ฝังอยู่ข้างในจะได้ไม่ถามซ้ำ
export const TOKEN_KEY = 'sppAuthToken';
export const ROLE_KEY = 'sppAuthRole';
export const NAME_KEY = 'sppAuthName';

export const isAdminAuthed = () => sessionStorage.getItem(ADMIN_AUTH_KEY) === '1';
export const authToken = () => sessionStorage.getItem(TOKEN_KEY) || '';
export const authRole = () => sessionStorage.getItem(ROLE_KEY) || '';
export const authName = () => sessionStorage.getItem(NAME_KEY) || '';
export const isAdmin = () => authRole() === 'admin';

/** header สำหรับเส้นที่เซิร์ฟเวอร์บังคับสิทธิ์ (requireRole ใน server/index.js) */
export const authHeaders = (): Record<string, string> =>
  (authToken() ? { 'x-spp-token': authToken() } : {});

export const saveAuth = (d: { token?: string; role?: string; name?: string }) => {
  sessionStorage.setItem(ADMIN_AUTH_KEY, '1');
  sessionStorage.setItem(TOKEN_KEY, d.token || '');
  sessionStorage.setItem(ROLE_KEY, d.role || '');
  sessionStorage.setItem(NAME_KEY, d.name || '');
};
