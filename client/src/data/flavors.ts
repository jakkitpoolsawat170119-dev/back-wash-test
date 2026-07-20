export interface FlavorDef {
  name: string;
  bg: string;
  border: string;
}

// รายชื่อกลิ่นจริง — เพิ่มกลิ่นใหม่ที่นี่ที่เดียว แล้วทั้งแอปเห็นพร้อมกัน
export const FLAVORS: FlavorDef[] = [
  { name: "Amazon",                    bg: '#efebe9', border: '#795548' },
  { name: "FDS",                       bg: '#eceff1', border: '#607d8b' },
  { name: "Golden",                    bg: '#fff8e1', border: '#ffc107' },
  { name: "Freshy Lychee",             bg: '#fce4ec', border: '#e91e63' },
  { name: "Freshy Strawberry",         bg: '#ffebee', border: '#f44336' },
  { name: "Senorita Coconut",          bg: '#fafafa', border: '#bdbdbd' },
  { name: "Senorita Caramel",          bg: '#efebe9', border: '#a1887f' },
  { name: "Freshy Blue Hawaii",        bg: '#e1f5fe', border: '#03a9f4' },
  { name: "Freshy Lime",               bg: '#f9fbe7', border: '#8bc34a' },
  { name: "Freshy Green Apple",        bg: '#e8f5e9', border: '#43a047' },
  { name: "Freshy Sala",               bg: '#fce4ec', border: '#e91e63' },
  { name: "Senorita Yuzu",             bg: '#fffde7', border: '#f9a825' },
  { name: "MLH 02",                    bg: '#e0f2f1', border: '#009688' },
  { name: "Freshy Pineapple",          bg: '#fff9c4', border: '#f9a825' },
  { name: "Operator Name",             bg: '#f3f3f3', border: '#9e9e9e' },
  { name: "Freshy Grape",              bg: '#f3e5f5', border: '#9c27b0' },
  { name: "Freshy Punch",              bg: '#fce4ec', border: '#ff4081' },
  { name: "Freshy blue Lemon",         bg: '#e3f2fd', border: '#42a5f5' },
  { name: "Senorita Fres Mint",        bg: '#e0f7fa', border: '#00bcd4' },
  { name: "Freshy Orange",             bg: '#fff3e0', border: '#ff9800' },
  { name: "Signature Rose",            bg: '#fce4ec', border: '#f06292' },
  { name: "Freshy Shine Muscat Grape", bg: '#f0fce4', border: '#76b82a' },
];

// ค่าพิเศษเฉพาะ CIP Line 2/3 (ไม่ใช่กลิ่นจริง)
export const SPECIAL_FLAVOR_OPTIONS: FlavorDef[] = [
  { name: "CIP",  bg: '#f5f5f5', border: '#9e9e9e' },
  { name: "ว่าง", bg: '#eeeeee', border: '#bdbdbd' },
];

// dropdown ของ CipLine2/3 = กลิ่นจริง + special
export const CIP_LINE2_FLAVOR_OPTIONS: FlavorDef[] = [...FLAVORS, ...SPECIAL_FLAVOR_OPTIONS];

const COLOR_MAP: Record<string, { bg: string; border: string }> = Object.fromEntries(
  [...FLAVORS, ...SPECIAL_FLAVOR_OPTIONS].map(f => [f.name, { bg: f.bg, border: f.border }])
);

const DEFAULT_COLOR = { bg: '#f5f5f5', border: '#bdbdbd' };

export const getFlavorColor = (name: string) => COLOR_MAP[name] ?? DEFAULT_COLOR;
