/* ชนิดข้อมูล + ตัวยิง API ของหน้า "ทะเบียนเครื่องจักร" (Machine Hub)
   แยกออกมาเพราะใช้ร่วมกัน 3 คอมโพเนนต์ (ทะเบียน · รายละเอียด · ผังเชื่อมโยง)

   🔑 ชื่อเครื่อง 2 ชั้น — อย่าสับสน
      name  = ชื่อจริงในระบบ ("ไลน์ L2") เป็นคีย์ที่ทะเบียนงานรูทีน/เหตุการณ์/โน้ต vault อ้างถึง
              ทุกครั้งที่ส่งขึ้นเซิร์ฟเวอร์ต้องใช้ตัวนี้
      label = ชื่อที่โชว์ ("เครื่องบรรจุ L2") ใช้กับสายตาคนอย่างเดียว                      */
import { apiUrl } from './api';
import { authHeaders, authRole } from './auth';
import { wakeFetch, type WakeState } from './wakeFetch';

export type Grp = 'line' | 'packer' | 'central' | 'tool';

export const GRP_META: Record<Grp, { icon: string; label: string; desc: string }> = {
  line: { icon: '🏭', label: 'ไลน์ผลิต', desc: 'ไลน์ต้ม/ไลน์ผลิตน้ำตาล — ต้นทางที่ป้อนเข้าเครื่องบรรจุ' },
  packer: { icon: '📦', label: 'เครื่องบรรจุ', desc: 'ปลายทาง — ตรงกับรหัส [L1]/[A3] ที่อยู่ในแผนบรรจุรายกะ' },
  central: { icon: '🏢', label: 'อุปกรณ์ส่วนกลาง', desc: 'มีแผน PM แต่ไม่ผูกกับสินค้า/รอบผลิต' },
  tool: { icon: '🔩', label: 'อื่น ๆ · เครื่องประจำไลน์', desc: 'มาจากทะเบียนงานรูทีน — ไม่มีแผน PM รายปี' },
};
export const GRP_ORDER: Grp[] = ['line', 'packer', 'central', 'tool'];

export interface Machine {
  id: number; code: string; name: string; line: string;
  installedAt: string; lastPm: string; note: string; vaultPath: string;
  pmCount: number; openIncidents: number;
  grp: Grp; mkey: string; label: string; spec: string; pmNetId: string;
  linkCount: number; ruleCount: number;
  pmNextWeek: number | null; pmFreq: string; pmRollover: boolean;
}

export interface LinkProduct { id?: number; flavor: string; skuCode?: string; note?: string }
export interface LinkRow {
  id: number;
  lineName: string; lineLabel: string;
  packerName: string; packerLabel: string;
  note: string; products: LinkProduct[];
}
export interface SideRef { name: string; label: string; mkey: string }

export interface PmCycle { week: number; monday: string; status: string; doneBy: string; doneDate: string; jobs: string[] }
export interface PmBlock {
  netId: string; name: string; machine: string; freq: string; freqLabel: string;
  weeks: number[]; cycles: PmCycle[]; owner: string;
  jobs: { id: number; title: string; every: number; freqLabel: string }[];
  stat: { planned: number; done: number; due: number; over: number; skip: number; pct: number | null; lastDone: string; nextWeek: number | null; nextMonday: string };
  year: number; cur: { year: number; week: number };
}
export interface MachineDetailData {
  machine: Machine & { downtimeCost: number | null };
  pm: PmBlock | null;
  routines: { id: number; nodeKey: string; title: string; goal: string; method: string; ownerRole: string; sheet: string; freq: string; shared: boolean }[];
  incidents: { id: number; title: string; occurredAt: string; status: string; priority: string; assignee: string; source: string; cause: string; fix: string; downFrom: string; downTo: string; minutes: number | null; vaultPath: string }[];
  downtime: { count: number; minutes: number; openCount: number };
  links: LinkRow[];
  rules: { id: number; title: string; timing: string; lineName: string; packerName: string; productPattern: string; shift: string; ownerRole: string; items: { title?: string; needPhoto?: boolean; needQc?: boolean }[] }[];
  runs: { id: number; workDay: string; shift: string; packer: string; line: string; flavor: string; status: string; source: string }[];
  netlifyUrl: string;
  aliases: string[];
}

export interface NameRef { name: string; label: string; mkey?: string }

/* รอบเดินเครื่อง 1 แถว = "วันนี้ กะนี้ เครื่องนี้ ผลิตสินค้าตัวนี้ ป้อนจากไลน์ไหน"
   source = plan | manual  → manual คือแถวที่คนแก้เนื้อในแล้ว ดึงแผนใหม่จะไม่ทับ
   lineSource = product | guess | manual → ที่มาของ "ไลน์" ช่องเดียว (คนละเรื่องกับ source ของทั้งแถว) */
export interface MachineRun {
  id: number; workDay: string; shift: string;
  packerName: string; packerKey: string; packerLabel: string;
  lineName: string; lineLabel: string;
  flavor: string; flavorNorm: string; skuCode: string;
  targetBoxes: number | null;
  source: string; lineSource: string;
  status: string; confirmedBy: string; confirmedAt: string; note: string;
}
export interface RunsData {
  date: string; shift: string;
  canSeed: boolean;                       // false = วันย้อนหลัง ห้ามดึงแผนมาสร้างรอบใหม่
  seedSkipped?: string;                   // 'past' | 'role' — ขอ seed มาแล้วเซิร์ฟเวอร์ไม่ทำให้ (บอกเหตุผล)
  seeded: { planRows: number; rows: number; noMachine: number; unknownKey: string[]; conflicts: string[];
    dropped: string[]; staleConfirmed: string[]; filled: number } | null;
  shifts: string[];
  byShift: Record<string, number>;        // นับรอบทุกกะของวันนั้น — ใช้บอกว่า "แผนไปอยู่กะอื่น"
  runs: MachineRun[];
  lines: NameRef[]; packers: NameRef[];
  candidates: Record<string, string[]>;   // เครื่องบรรจุ → ไลน์ที่ผูกคู่ไว้ (ดันขึ้นหัว dropdown)
}

/* กฎเตือน — เงื่อนไขช่องไหนเว้นว่าง = "อะไรก็ได้" · ที่กรอกไว้ต้องตรงพร้อมกันทั้งหมด
   🔑 specificity + packerKey เซิร์ฟเวอร์คิดเองเสมอ ส่งขึ้นไปก็ไม่มีผล (กันปลอมลำดับข้อในเช็กลิสต์) */
export interface RuleItem { key?: string; title: string; detail?: string; needPhoto?: boolean; needQc?: boolean }
export interface MachineRule {
  id: number; code: string; title: string; timing: string;
  lineName: string; packerName: string; packerKey: string;
  productPattern: string; shift: string; ownerRole: string; note: string;
  specificity: number; notify: number; active: number; items: RuleItem[];
}
export interface RulesData {
  rules: MachineRule[];
  counts: { all: number; start: number; during: number; end: number; off: number };
  timings: { key: string; label: string }[];
  lines: NameRef[]; packers: NameRef[];
}
export interface PreviewItem extends RuleItem { ruleId: number; ruleTitle: string }
export interface PreviewTiming {
  rules: { id: number; title: string; ownerRole: string; specificity: number }[];
  items: PreviewItem[];
}
export interface PreviewRun {
  runId: number; shift: string; packerName: string; packerKey: string;
  lineName: string; flavor: string; status: string; hitCount: number;
  timings: Record<string, PreviewTiming>;
}
export interface PreviewData {
  date: string; shift: string; runs: PreviewRun[];
  byRule: Record<string, number>;          // id กฎ → จำนวนรอบที่เข้าในวันนั้น
  totalRuns: number; hitRuns: number;
  timingLabel: Record<string, string>;
}

export const TIMING_META: Record<string, { icon: string; label: string; short: string }> = {
  start: { icon: '⏱', label: 'ก่อนเริ่มบรรจุ', short: 'ก่อนเริ่ม' },
  during: { icon: '⚙️', label: 'ระหว่างเดินเครื่อง', short: 'ระหว่างเดิน' },
  end: { icon: '🏁', label: 'หลังบรรจุจบ', short: 'หลังจบ' },
};
export const TIMING_ORDER = ['start', 'during', 'end'];

export const RUN_STATUS_META: Record<string, { label: string; chip: string }> = {
  draft: { label: 'รอยืนยัน', chip: 'mute' },
  confirmed: { label: 'ยืนยันแล้ว', chip: 'low' },
  done: { label: 'ปิดงานแล้ว', chip: 'km' },
  cancelled: { label: 'ยกเลิกแล้ว', chip: 'stop' },
};
export const LINE_SOURCE_LABEL: Record<string, string> = {
  product: 'เดาจากสินค้าประจำคู่',
  guess: 'เครื่องนี้มีคู่เดียว',
  manual: 'คนเลือกเอง',
};

/** เขียนทะเบียน/คู่/กฎ ได้เฉพาะหัวหน้าขึ้นไป — เซิร์ฟเวอร์บังคับซ้ำอีกชั้นด้วย requireRole */
export const canEditRegistry = () => ['supervisor', 'admin'].includes(authRole());

const ROLE_LABEL: Record<string, string> = { mt: 'Maintenance', op: 'Operate', qc: 'QC', pd: 'พนักงานผลิต' };
export const roleLabel = (r: string) => ROLE_LABEL[r] || r || '';

/** ตัดวงเล็บรหัสเครื่องออกจากชื่อสินค้า — แผนบรรจุเก็บ "Amazon 850×12 [L2]" ไว้ทั้งก้อน */
export const cleanFlavor = (s: string) => String(s || '').replace(/\s*\[[^\]]*\]\s*/g, ' ').trim();

async function call<T>(path: string, init: RequestInit | undefined, onState?: (s: WakeState) => void): Promise<T> {
  const r = await wakeFetch(`${apiUrl}${path}`, { ...init, onState });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string })?.error || `ทำรายการไม่สำเร็จ (${r.status})`);
  return d as T;
}

/* อ่านก็แนบโทเคนด้วย — เส้น /api/machine-runs?seed=1 มีการ "เขียน" ห้อยอยู่บนเส้นอ่าน
   และเซิร์ฟเวอร์ตัดสินจากโทเคนว่าจะดึงแผนให้หรือไม่ (ไม่มีโทเคน = อ่านได้ แต่ไม่ดึงแผน) */
export const mcGet = <T>(path: string, onState?: (s: WakeState) => void) =>
  call<T>(path, { headers: { ...authHeaders() } }, onState);

/** ทุก write แนบ token เสมอ — เส้นที่ requireRole จะตอบ 401 ถ้าไม่มี */
export const mcPost = <T>(path: string, body: unknown, onState?: (s: WakeState) => void) =>
  call<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }, onState);
