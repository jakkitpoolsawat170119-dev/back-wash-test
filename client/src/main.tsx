import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './redesign.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import WarehouseVerifyPage from './components/WarehouseVerifyPage.tsx'
import AmSheetPage from './components/AmSheetPage.tsx'
import { normalizeLegacyLinks } from './hooks/useAppRoute.ts'

// ลิงก์คู่มือ Line 4 รุ่นเก่า (#block-<id> เฉย ๆ) ให้พาไปหน้าคู่มือแทนหน้าหลัก
normalizeLegacyLinks()

// หน้าคลังตรวจนับเปิดจากลิงก์ ?verify=<token> — สาธารณะ ไม่ต้อง login
// เช็คตรงนี้แทนใน App เพื่อข้าม Splash/Login และไม่ให้ติด filter:invert ของโหมดมืด
const verifyToken = new URLSearchParams(window.location.search).get('verify')
// ใบเช็ก AM รายกะเปิดจากลิงก์ ?amsheet=<token> — เหตุผลเดียวกับ ?verify= ข้างบน
// (ช่างกดจาก Telegram บนมือถือ ต้องไม่ติด Login/PIN และรูปถ่ายต้องไม่โดน filter:invert)
const amSheetToken = new URLSearchParams(window.location.search).get('amsheet')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {verifyToken ? (
      <ErrorBoundary label="warehouse-verify">
        <WarehouseVerifyPage token={verifyToken} />
      </ErrorBoundary>
    ) : amSheetToken ? (
      <ErrorBoundary label="am-sheet">
        <AmSheetPage token={amSheetToken} />
      </ErrorBoundary>
    ) : (
      <ErrorBoundary label="root">
        <App />
      </ErrorBoundary>
    )}
  </StrictMode>,
)
