import React, { useState, useRef, useEffect } from 'react';
import { supabase } from '../lib/supabase';

interface Props {
  onBackToMain: () => void;
  darkMode?: boolean;
}

type ChatMessage =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string };

interface ChatEntry {
  id: string;
  role: 'user' | 'bot';
  messages: ChatMessage[];
  time: string;
}

const WEBHOOK_URL = import.meta.env.VITE_STICKER_GUIDE_CHAT_WEBHOOK_URL
  || 'https://n8n.srv1267366.hstgr.cloud/webhook/sticker-guide-chat';

const BRAND_LIGHT = { from: '#ff6b00', to: '#ff8c00', deep: '#e65100' };
const BRAND_DARK = { from: '#ff8a1f', to: '#ffb648', deep: '#ffcd94' };

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowLabel() {
  return new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

const StickerGuideChat: React.FC<Props> = ({ onBackToMain, darkMode = false }) => {
  const [sessionId] = useState(() => makeId());
  const [entries, setEntries] = useState<ChatEntry[]>([
    {
      id: makeId(),
      role: 'bot',
      messages: [
        { type: 'text', text: 'สวัสดีค่ะ 👋 พิมพ์ชื่อลูกค้าเพื่อค้นหาวิธีติดสติ๊กเกอร์ได้เลย เช่น "วิธีติดสติ๊กเกอร์ลูกค้า Kaoshop"' },
      ],
      time: nowLabel(),
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const autoScrollPaused = useRef(false);
  const resumeTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const BRAND = darkMode ? BRAND_DARK : BRAND_LIGHT;
  const c = darkMode ? {
    pageBg: '#11151c',
    pageDot: 'rgba(255,138,31,0.10)',
    headerText: '#1a1206',
    botBubbleBg: '#1d232d',
    botBubbleText: '#eef1f5',
    botBubbleShadow: '0 2px 12px -2px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3)',
    userText: '#1a1206',
    userShadow: '0 6px 18px -6px rgba(255,138,31,0.55)',
    timeOnBot: 'rgba(238,241,245,0.45)',
    timeOnUser: 'rgba(26,18,6,0.55)',
    typingDot: '#4a5160',
    inputBarBg: '#161b23',
    inputBarBorder: '#262e3a',
    inputBg: '#1d232d',
    inputBorder: '#323c4a',
    inputText: '#eef1f5',
    placeholder: '#7a8392',
    chipBg: '#1d232d',
    chipBorder: '#323c4a',
    chipText: BRAND_DARK.deep,
    sendIdleBg: '#2a313c',
  } : {
    pageBg: '#efe9e1',
    pageDot: 'rgba(230,81,0,0.07)',
    headerText: '#ffffff',
    botBubbleBg: '#ffffff',
    botBubbleText: '#2c2c2c',
    botBubbleShadow: '0 2px 10px -2px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.04)',
    userText: '#ffffff',
    userShadow: '0 6px 16px -6px rgba(230,81,0,0.5)',
    timeOnBot: '#aaaaaa',
    timeOnUser: 'rgba(255,255,255,0.75)',
    typingDot: '#c9c2b6',
    inputBarBg: '#ffffff',
    inputBarBorder: '#efeae2',
    inputBg: '#ffffff',
    inputBorder: '#e8e2d8',
    inputText: '#2c2c2c',
    placeholder: '#9a9488',
    chipBg: '#ffffff',
    chipBorder: '#e8e2d8',
    chipText: BRAND_LIGHT.deep,
    sendIdleBg: '#e8e2d8',
  };

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries, sending]);

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('howtosticker')
      .select('customer_name')
      .order('id', { ascending: false })
      .limit(30)
      .then(({ data, error }) => {
        if (error || !data) return;
        setSuggestions(data.map(row => row.customer_name).filter(Boolean));
      });
  }, []);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el || suggestions.length < 2) return;
    const interval = setInterval(() => {
      if (autoScrollPaused.current) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      if (el.scrollLeft >= max - 1) {
        el.scrollLeft = 0;
      } else {
        el.scrollLeft += 0.6;
      }
    }, 30);
    return () => clearInterval(interval);
  }, [suggestions]);

  const pauseAutoScroll = () => {
    autoScrollPaused.current = true;
    if (resumeTimeout.current) clearTimeout(resumeTimeout.current);
    resumeTimeout.current = setTimeout(() => { autoScrollPaused.current = false; }, 3000);
  };

  const sendMessage = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;

    setEntries(prev => [...prev, { id: makeId(), role: 'user', messages: [{ type: 'text', text }], time: nowLabel() }]);
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
        time: nowLabel(),
      }]);
    } catch (err) {
      console.error('Sticker guide chat error:', err);
      setEntries(prev => [...prev, {
        id: makeId(),
        role: 'bot',
        messages: [{ type: 'text', text: 'เกิดข้อผิดพลาดในการเชื่อมต่อ กรุณาลองใหม่อีกครั้งค่ะ 🙏' }],
        time: nowLabel(),
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

  const showSuggestions = entries.length === 1 && !sending && suggestions.length > 0;

  return (
    <div className="sgc-root" style={{
      background: c.pageBg,
      backgroundImage: `radial-gradient(circle, ${c.pageDot} 1px, transparent 1.2px)`,
      backgroundSize: '18px 18px',
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      zIndex: 100,
    }}>
      <style>{`
        /* Neutralize the app-wide dark-mode invert filter so this screen's colors stay accurate. */
        .app-dark-mode .sgc-root { filter: invert(1) hue-rotate(180deg); }

        @keyframes chatBubbleIn { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes typingDot { 0%, 80%, 100% { transform: translateY(0); opacity: 0.4; } 40% { transform: translateY(-4px); opacity: 1; } }
        .sgc-bubble { animation: chatBubbleIn 0.28s cubic-bezier(0.22, 1, 0.36, 1); }
        .sgc-chip { transition: transform 0.15s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.15s, border-color 0.15s; }
        .sgc-chip:hover { transform: translateY(-1px); border-color: ${BRAND.from}; }
        .sgc-chip:active { transform: translateY(0) scale(0.97); }
        .sgc-send:focus-visible, .sgc-back:focus-visible, .sgc-chip:focus-visible {
          outline: 2px solid ${BRAND.from}; outline-offset: 2px;
        }
        .sgc-send:active { transform: scale(0.92); }
        .sgc-back:hover { background: rgba(255,255,255,0.32); }
        .sgc-input:focus { border-color: ${BRAND.from}; box-shadow: 0 0 0 3px ${darkMode ? 'rgba(255,138,31,0.22)' : 'rgba(255,107,0,0.12)'}; }
        .sgc-chips-row { scrollbar-width: none; }
        .sgc-chips-row::-webkit-scrollbar { display: none; }
        .sgc-input::placeholder { color: ${c.placeholder}; }
      `}</style>

      {/* Header */}
      <div style={{
        background: `linear-gradient(135deg, ${BRAND.from}, ${BRAND.to})`,
        color: c.headerText, padding: '16px 14px',
        borderBottomLeftRadius: '22px', borderBottomRightRadius: '22px',
        boxShadow: `0 8px 24px -6px ${darkMode ? 'rgba(255,138,31,0.35)' : 'rgba(230,81,0,0.45)'}, 0 2px 6px rgba(0,0,0,0.08)`,
        display: 'flex', alignItems: 'center', gap: '10px',
        flexShrink: 0, zIndex: 50,
      }}>
        <button
          onClick={onBackToMain}
          className="sgc-back"
          title="กลับหน้าหลัก"
          style={{
            background: 'rgba(255,255,255,0.18)', border: 'none', color: c.headerText,
            borderRadius: '50%', width: '34px', height: '34px', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: '1.1rem', transition: 'background-color 0.15s',
          }}
        >‹</button>

        <div style={{
          width: '38px', height: '38px', borderRadius: '50%', flexShrink: 0,
          background: 'rgba(255,255,255,0.22)', border: '1.5px solid rgba(255,255,255,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem',
        }}>🏷️</div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.01em' }}>ผู้ช่วยติดสติ๊กเกอร์</div>
          <div style={{ fontSize: '0.7rem', opacity: 0.9, display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#7CFFB2', display: 'inline-block', boxShadow: '0 0 0 2px rgba(124,255,178,0.25)' }} />
            ออนไลน์ · ตอบกลับไว
          </div>
        </div>
      </div>

      {/* Message list */}
      <div ref={listRef} style={{ flex: 1, minHeight: 0, padding: '16px 12px 12px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto' }}>
        {entries.map(entry => (
          <div key={entry.id} className="sgc-bubble" style={{ display: 'flex', flexDirection: 'column', alignItems: entry.role === 'user' ? 'flex-end' : 'flex-start', gap: '4px' }}>
            {entry.messages.map((msg, i) => {
              const isLast = i === entry.messages.length - 1;
              return msg.type === 'image' ? (
                <img key={i} src={msg.url} alt="ขั้นตอนการติดสติ๊กเกอร์" style={{
                  maxWidth: '72%', borderRadius: '16px',
                  boxShadow: '0 6px 16px -4px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.08)',
                  border: '1px solid rgba(0,0,0,0.04)',
                }} />
              ) : (
                <div key={i} style={{
                  position: 'relative',
                  maxWidth: '80%', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  padding: '10px 14px', paddingBottom: isLast ? '18px' : '10px',
                  borderRadius: '18px', fontSize: '0.9rem', lineHeight: 1.55,
                  background: entry.role === 'user' ? `linear-gradient(135deg, ${BRAND.from}, ${BRAND.to})` : c.botBubbleBg,
                  color: entry.role === 'user' ? c.userText : c.botBubbleText,
                  boxShadow: entry.role === 'user' ? c.userShadow : c.botBubbleShadow,
                  borderBottomRightRadius: entry.role === 'user' ? '5px' : '18px',
                  borderBottomLeftRadius: entry.role === 'user' ? '18px' : '5px',
                }}>
                  {msg.text}
                  {isLast && (
                    <span style={{
                      position: 'absolute', right: '14px', bottom: '5px',
                      fontSize: '0.6rem', letterSpacing: '0.01em',
                      color: entry.role === 'user' ? c.timeOnUser : c.timeOnBot,
                    }}>{entry.time}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {showSuggestions && (
          <div
            ref={chipsRef}
            className="sgc-bubble sgc-chips-row"
            onPointerDown={pauseAutoScroll}
            onWheel={pauseAutoScroll}
            onTouchStart={pauseAutoScroll}
            style={{
              display: 'flex', flexWrap: 'nowrap', gap: '8px', paddingLeft: '2px', paddingRight: '2px',
              overflowX: 'auto', scrollSnapType: 'x proximity', WebkitOverflowScrolling: 'touch',
              maskImage: 'linear-gradient(to right, transparent, black 16px, black calc(100% - 16px), transparent)',
              WebkitMaskImage: 'linear-gradient(to right, transparent, black 16px, black calc(100% - 16px), transparent)',
            }}
          >
            {suggestions.map(s => (
              <button
                key={s}
                className="sgc-chip"
                onClick={() => sendMessage(`วิธีติดสติ๊กเกอร์ลูกค้า ${s}`)}
                style={{
                  background: c.chipBg, border: `1.5px solid ${c.chipBorder}`, borderRadius: '16px',
                  padding: '7px 14px', fontSize: '0.8rem', fontWeight: 600, color: c.chipText,
                  cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.05)',
                  flexShrink: 0, scrollSnapAlign: 'start', whiteSpace: 'nowrap',
                }}
              >{s}</button>
            ))}
          </div>
        )}

        {sending && (
          <div className="sgc-bubble" style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '4px', padding: '13px 16px', borderRadius: '18px', borderBottomLeftRadius: '5px', background: c.botBubbleBg, boxShadow: c.botBubbleShadow }}>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: '6px', height: '6px', borderRadius: '50%', background: c.typingDot,
                animation: 'typingDot 1.2s infinite ease-in-out', animationDelay: `${i * 0.15}s`,
              }} />
            ))}
          </div>
        )}
      </div>

      {/* Input bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        background: c.inputBarBg, borderTop: `1px solid ${c.inputBarBorder}`,
        flexShrink: 0, zIndex: 50,
        boxShadow: '0 -4px 16px rgba(0,0,0,0.04)',
      }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          placeholder='พิมพ์ชื่อลูกค้า เช่น "Kaoshop"'
          disabled={sending}
          className="sgc-input"
          style={{
            flex: 1, padding: '12px 16px', borderRadius: '24px', border: `1.5px solid ${c.inputBorder}`,
            fontSize: '0.9rem', outline: 'none', transition: 'border-color 0.15s, box-shadow 0.15s',
            background: sending ? (darkMode ? '#171c24' : '#f7f5f1') : c.inputBg,
            color: c.inputText,
          }}
        />
        <button
          onClick={() => sendMessage()}
          disabled={sending || !input.trim()}
          className="sgc-send"
          title="ส่ง"
          style={{
            background: sending || !input.trim() ? c.sendIdleBg : `linear-gradient(135deg, ${BRAND.from}, ${BRAND.to})`,
            color: sending || !input.trim() ? c.placeholder : (darkMode ? '#1a1206' : '#ffffff'),
            border: 'none', borderRadius: '50%', width: '42px', height: '42px', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: sending || !input.trim() ? 'default' : 'pointer',
            boxShadow: sending || !input.trim() ? 'none' : `0 4px 12px -2px ${darkMode ? 'rgba(255,138,31,0.45)' : 'rgba(230,81,0,0.5)'}`,
            transition: 'transform 0.12s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.15s, background-color 0.15s',
            transform: inputFocused && input.trim() && !sending ? 'scale(1.04)' : 'scale(1)',
          }}
        >
          <span style={{ display: 'inline-block', transform: 'rotate(90deg) translateY(-1px)', fontSize: '1.1rem', lineHeight: 1 }}>➤</span>
        </button>
      </div>
    </div>
  );
};

export default StickerGuideChat;
