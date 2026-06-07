import React, { useState, useRef, useEffect } from 'react';

interface Props {
  onBackToMain: () => void;
}

type ChatMessage =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string };

interface ChatEntry {
  id: string;
  role: 'user' | 'bot';
  messages: ChatMessage[];
}

const WEBHOOK_URL = import.meta.env.VITE_STICKER_GUIDE_CHAT_WEBHOOK_URL
  || 'https://n8n.srv1267366.hstgr.cloud/webhook/sticker-guide-chat';

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const StickerGuideChat: React.FC<Props> = ({ onBackToMain }) => {
  const [sessionId] = useState(() => makeId());
  const [entries, setEntries] = useState<ChatEntry[]>([
    {
      id: makeId(),
      role: 'bot',
      messages: [
        { type: 'text', text: 'สวัสดีค่ะ 👋 พิมพ์ถามวิธีติดสติ๊กเกอร์ได้เลย เช่น "วิธีติดสติ๊กเกอร์ลูกค้า Kaoshop"' },
      ],
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries, sending]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setEntries(prev => [...prev, { id: makeId(), role: 'user', messages: [{ type: 'text', text }] }]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const messages: ChatMessage[] = Array.isArray(data?.messages) ? data.messages : [];

      setEntries(prev => [...prev, {
        id: makeId(),
        role: 'bot',
        messages: messages.length ? messages : [{ type: 'text', text: 'ขออภัยค่ะ ไม่สามารถดึงคำตอบได้ในขณะนี้ 🙏' }],
      }]);
    } catch (err) {
      console.error('Sticker guide chat error:', err);
      setEntries(prev => [...prev, {
        id: makeId(),
        role: 'bot',
        messages: [{ type: 'text', text: 'เกิดข้อผิดพลาดในการเชื่อมต่อ กรุณาลองใหม่อีกครั้งค่ะ 🙏' }],
      }]);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={{ background: '#f5f5f5', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #ff6b00, #ff8c00)',
        color: 'white', padding: '20px 16px 16px',
        borderBottomLeftRadius: '20px', borderBottomRightRadius: '20px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        display: 'flex', alignItems: 'center', gap: '8px',
      }}>
        <button onClick={onBackToMain} style={{
          background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white',
          borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', fontSize: '0.8rem', flexShrink: 0,
        }}>← หลัก</button>
        <div>
          <div style={{ fontWeight: '700', fontSize: '1.05rem', letterSpacing: '0.02em' }}>💬 วิธีติดสติ๊กเกอร์</div>
          <div style={{ fontSize: '0.65rem', opacity: 0.8 }}>ถามชื่อลูกค้า แล้วระบบจะแนะนำขั้นตอนให้ค่ะ</div>
        </div>
      </div>

      {/* Message list */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 12px 8px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {entries.map(entry => (
          <div key={entry.id} style={{ display: 'flex', flexDirection: 'column', alignItems: entry.role === 'user' ? 'flex-end' : 'flex-start', gap: '6px' }}>
            {entry.messages.map((msg, i) => (
              msg.type === 'image' ? (
                <img key={i} src={msg.url} alt="ขั้นตอนการติดสติ๊กเกอร์" style={{
                  maxWidth: '75%', borderRadius: '14px', boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                }} />
              ) : (
                <div key={i} style={{
                  maxWidth: '80%', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  padding: '10px 14px', borderRadius: '16px', fontSize: '0.88rem', lineHeight: 1.5,
                  background: entry.role === 'user' ? 'linear-gradient(135deg, #ff6b00, #ff8c00)' : '#ffffff',
                  color: entry.role === 'user' ? '#ffffff' : '#333',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  borderBottomRightRadius: entry.role === 'user' ? '4px' : '16px',
                  borderBottomLeftRadius: entry.role === 'user' ? '16px' : '4px',
                }}>
                  {msg.text}
                </div>
              )
            ))}
          </div>
        ))}

        {sending && (
          <div style={{ alignSelf: 'flex-start', padding: '10px 14px', borderRadius: '16px', background: '#ffffff', color: '#999', fontSize: '0.8rem', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
            กำลังค้นหาขั้นตอน...
          </div>
        )}
      </div>

      {/* Input bar */}
      <div style={{
        display: 'flex', gap: '8px', padding: '10px 12px',
        background: '#ffffff', borderTop: '1px solid #eee',
        position: 'sticky', bottom: 0,
      }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='เช่น "วิธีติดสติ๊กเกอร์ลูกค้า Kaoshop"'
          disabled={sending}
          style={{
            flex: 1, padding: '12px 16px', borderRadius: '24px', border: '1.5px solid #e0e0e0',
            fontSize: '0.9rem', outline: 'none',
          }}
        />
        <button
          onClick={sendMessage}
          disabled={sending || !input.trim()}
          style={{
            background: sending || !input.trim() ? '#e0e0e0' : 'linear-gradient(135deg, #ff6b00, #ff8c00)',
            color: 'white', border: 'none', borderRadius: '24px', padding: '0 22px',
            fontWeight: '700', fontSize: '0.9rem', cursor: sending || !input.trim() ? 'default' : 'pointer',
          }}
        >
          ส่ง
        </button>
      </div>
    </div>
  );
};

export default StickerGuideChat;
