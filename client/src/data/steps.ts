export interface CIPStep {
  id: number;
  description: string;
}

export const cipSteps: CIPStep[] = [
  { id: 1, description: "สเปรย์ น้ำ ทุกถัง ทิ้งน้ำ" },
  { id: 2, description: "ขัด 1 รอบ ทิ้งน้ำ ขัดทุกถัง" },
  { id: 3, description: "MIP ก่อน น้ำ RO Heat 80 กวนด้วย + ใส่ ex ที่ถัง 1 กวน 30 นาที" },
  { id: 4, description: "ปั๊มไปถัง 2 เดิม Ex อีก Cir shell&tube 30 นาที" },
  { id: 5, description: "ปั๊มไปแช่ที่ถัง 3 เปิดใบกวน 30 นาที" },
  { id: 6, description: "สเปรย์ทุกถัง อีก 1 รอบ เพื่อไล่สารเคมี" },
  { id: 7, description: "Horn ไล่ต้ม น้ำ แช่ กวน 30 นาที" },
  { id: 8, description: "ปั๊มไปถัง 2 Cir shell&tube 30 นาที" },
  { id: 9, description: "ปั๊มไปแช่ที่ถัง 3 เปิดใบกวน 30 นาที" },
  { id: 10, description: "Backwash ครั้งที่ 1 (ถัง 2 > Shearpump > ท่อ From.. > shell&tub > ท่อ inlet ...) > stainer ทิ้งดูถ้าใบบัว" },
  { id: 11, description: "Backwash ครั้งที่ 2" },
  { id: 12, description: "ระหว่าง Back wash ขัดเครื่อง" },
  { id: 13, description: "Backwash ครั้งที่ 3" },
  { id: 14, description: "Backwash ครั้งที่ 4" },
  { id: 15, description: "Backwash ครั้งที่ 5" },
  { id: 16, description: "Backwash ครั้งที่ 6" },
  { id: 17, description: "Backwash ครั้งที่ 7" },
  { id: 18, description: "Backwash ครั้งที่ 8" },
  { id: 19, description: "Backwash ครั้งที่ 9" },
  { id: 20, description: "Backwash ครั้งที่ 10" },
  { id: 21, description: "น้ำ ถัง 1>2>Tub>3> บรรจุ" },
  { id: 22, description: "น้ำ ถัง 1>2>Tub>3> บรรจุ" },
  { id: 23, description: "น้ำ ถัง 1>2>Tub>3> บรรจุ" },
  { id: 24, description: "น้ำ ถัง 1>2>Tub>3> บรรจุ" },
  { id: 25, description: "น้ำ ถัง 1>2>Tub>3> บรรจุ" },
  { id: 26, description: "น้ำ ถัง 1>2>Tub>3> บรรจุ" },
  { id: 27, description: "น้ำ ถัง 1>2>Tub>3> บรรจุ" }
];
