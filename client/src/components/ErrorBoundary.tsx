import React from 'react';

// กันจอขาวทั้งแอป: ถ้าคอมโพเนนต์ลูก throw (เช่น API คืน shape ผิดตอน DB ล่ม/quota หมด)
// ให้โชว์การ์ดแจ้งเตือน + ปุ่มลองใหม่ แทนที่จะ crash ทั้งหน้า (แอปไม่มี boundary มาก่อน)
type Props = { children: React.ReactNode; label?: string };
type State = { error: Error | null };

class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // log ไว้ดูใน console (ไม่ให้เงียบหาย)
    console.error('[ErrorBoundary]', this.props.label || '', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 480, margin: '40px auto', padding: 24, textAlign: 'center', background: '#fff', borderRadius: 18, boxShadow: '0 2px 14px rgba(0,0,0,0.08)', border: '1px solid #f0d9d9' }}>
          <div style={{ fontSize: '2.2rem', marginBottom: 8 }}>⚠️</div>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: '#37474f', marginBottom: 6 }}>ส่วนนี้แสดงผลไม่ได้ชั่วคราว</div>
          <div style={{ fontSize: '0.85rem', color: '#78828a', lineHeight: 1.6, marginBottom: 16 }}>
            มักเกิดจากเชื่อมต่อฐานข้อมูล/เซิร์ฟเวอร์ไม่ได้ (เช่น โควตาหมด หรือเซิร์ฟเวอร์กำลังรีสตาร์ต) —
            ส่วนอื่นของแอปยังใช้งานได้ ลองใหม่อีกครั้งได้เลย
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ border: 'none', background: 'linear-gradient(135deg,#ff6b00,#ff8c00)', color: '#fff', borderRadius: 12, padding: '10px 22px', fontWeight: 800, fontSize: '0.9rem', cursor: 'pointer' }}>
            🔄 ลองใหม่
          </button>
          <div style={{ marginTop: 12 }}>
            <button onClick={() => window.location.reload()} style={{ background: 'none', border: 'none', color: '#b0b8bd', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.78rem' }}>
              โหลดแอปใหม่ทั้งหมด
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
