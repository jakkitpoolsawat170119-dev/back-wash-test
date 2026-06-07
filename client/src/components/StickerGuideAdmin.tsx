import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Props {
  onBackToMain: () => void;
}

interface Guide {
  id: number;
  customer_name: string;
  steps: string;
  image_urls: string[] | null;
}

const ADMIN_USER = import.meta.env.VITE_STICKER_ADMIN_USER || 'admin';
const ADMIN_PASS = import.meta.env.VITE_STICKER_ADMIN_PASS || 'admin1234';
const AUTH_KEY = 'stickerGuideAdminAuthed';

const AdminLoginGate: React.FC<{ onBackToMain: () => void; onAuthed: () => void }> = ({ onBackToMain, onAuthed }) => {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
      sessionStorage.setItem(AUTH_KEY, '1');
      onAuthed();
    } else {
      setError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้องค่ะ');
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', borderRadius: '12px', border: '1.5px solid #e0e0e0',
    fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
  };

  return (
    <div style={{ background: '#f5f5f5', minHeight: '100vh' }}>
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
          <div style={{ fontWeight: '700', fontSize: '1.05rem', letterSpacing: '0.02em' }}>🔒 เข้าสู่ระบบแอดมิน</div>
          <div style={{ fontSize: '0.65rem', opacity: 0.8 }}>กรอกชื่อผู้ใช้และรหัสผ่านเพื่อจัดการคู่มือติดสติ๊กเกอร์</div>
        </div>
      </div>

      <form onSubmit={handleSubmit} style={{ margin: '16px 12px', background: '#fff', borderRadius: '16px', padding: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
        <label style={{ display: 'block', fontSize: '0.78rem', color: '#777', marginBottom: '4px' }}>ชื่อผู้ใช้</label>
        <input value={user} onChange={e => setUser(e.target.value)} style={{ ...inputStyle, marginBottom: '12px' }} autoFocus />

        <label style={{ display: 'block', fontSize: '0.78rem', color: '#777', marginBottom: '4px' }}>รหัสผ่าน</label>
        <input type="password" value={pass} onChange={e => setPass(e.target.value)} style={{ ...inputStyle, marginBottom: '12px' }} />

        {error && (
          <div style={{ marginBottom: '12px', padding: '10px 14px', borderRadius: '10px', fontSize: '0.82rem', background: '#ffebee', color: '#c62828' }}>
            {error}
          </div>
        )}

        <button type="submit" style={{
          width: '100%', background: 'linear-gradient(135deg, #ff6b00, #ff8c00)',
          color: 'white', border: 'none', borderRadius: '24px', padding: '12px 0',
          fontWeight: '700', fontSize: '0.9rem', cursor: 'pointer',
        }}>เข้าสู่ระบบ</button>
      </form>
    </div>
  );
};

async function uploadToStorage(file: File): Promise<string | null> {
  if (!supabase) return null;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await supabase.storage.from('sticker-references').upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) { console.error('Upload error:', error); return null; }
  return supabase.storage.from('sticker-references').getPublicUrl(path).data.publicUrl;
}

const StickerGuideAdmin: React.FC<Props> = ({ onBackToMain }) => {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem(AUTH_KEY) === '1');
  const [guides, setGuides] = useState<Guide[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [customerName, setCustomerName] = useState('');
  const [steps, setSteps] = useState('');
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadGuides = async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase.from('howtosticker').select('id,customer_name,steps,image_urls').order('id', { ascending: false });
    if (!error && data) setGuides(data as Guide[]);
    setLoading(false);
  };

  useEffect(() => { if (authed) loadGuides(); }, [authed]);

  const resetForm = () => {
    setEditingId(null);
    setCustomerName('');
    setSteps('');
    setImageUrls([]);
    setMessage(null);
  };

  const startEdit = (g: Guide) => {
    setEditingId(g.id);
    setCustomerName(g.customer_name);
    setSteps(g.steps || '');
    setImageUrls(Array.isArray(g.image_urls) ? g.image_urls : []);
    setMessage(null);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    const urls: string[] = [];
    for (const file of Array.from(files)) {
      const url = await uploadToStorage(file);
      if (url) urls.push(url);
    }
    setImageUrls(prev => [...prev, ...urls]);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const removeImage = (idx: number) => {
    setImageUrls(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    if (!supabase) return;
    const name = customerName.trim();
    if (!name || !steps.trim()) {
      setMessage({ text: 'กรุณากรอกชื่อลูกค้าและขั้นตอนให้ครบค่ะ', ok: false });
      return;
    }
    setSaving(true);
    setMessage(null);

    const payload = { customer_name: name, steps: steps.trim(), image_urls: imageUrls };
    const query = editingId
      ? supabase.from('howtosticker').update(payload).eq('id', editingId)
      : supabase.from('howtosticker').insert(payload);

    const { error } = await query;
    setSaving(false);

    if (error) {
      console.error('Save error:', error);
      setMessage({ text: `บันทึกไม่สำเร็จ: ${error.message}`, ok: false });
      return;
    }

    setMessage({ text: editingId ? 'แก้ไขข้อมูลเรียบร้อยค่ะ' : 'เพิ่มข้อมูลเรียบร้อยค่ะ', ok: true });
    resetForm();
    loadGuides();
  };

  const handleDelete = async (id: number) => {
    if (!supabase) return;
    if (!window.confirm('ลบคู่มือนี้ใช่หรือไม่?')) return;
    const { error } = await supabase.from('howtosticker').delete().eq('id', id);
    if (error) {
      console.error('Delete error:', error);
      setMessage({ text: `ลบไม่สำเร็จ: ${error.message}`, ok: false });
      return;
    }
    if (editingId === id) resetForm();
    loadGuides();
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', borderRadius: '12px', border: '1.5px solid #e0e0e0',
    fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
  };

  if (!authed) {
    return <AdminLoginGate onBackToMain={onBackToMain} onAuthed={() => setAuthed(true)} />;
  }

  return (
    <div style={{ background: '#f5f5f5', minHeight: '100vh', paddingBottom: '40px' }}>
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
          <div style={{ fontWeight: '700', fontSize: '1.05rem', letterSpacing: '0.02em' }}>🛠️ จัดการคู่มือติดสติ๊กเกอร์</div>
          <div style={{ fontSize: '0.65rem', opacity: 0.8 }}>เพิ่ม/แก้ไข/ลบ ขั้นตอน + รูปภาพของลูกค้าแต่ละราย</div>
        </div>
      </div>

      {!supabase && (
        <div style={{ margin: '16px 12px', padding: '12px 14px', borderRadius: '12px', background: '#fff3e0', color: '#e65100', fontSize: '0.85rem' }}>
          ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)
        </div>
      )}

      {/* Form */}
      <div style={{ margin: '16px 12px', background: '#fff', borderRadius: '16px', padding: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
        <div style={{ fontWeight: '700', fontSize: '0.95rem', marginBottom: '10px', color: '#333' }}>
          {editingId ? '✏️ แก้ไขคู่มือ' : '➕ เพิ่มคู่มือใหม่'}
        </div>

        <label style={{ display: 'block', fontSize: '0.78rem', color: '#777', marginBottom: '4px' }}>ชื่อลูกค้า</label>
        <input
          value={customerName}
          onChange={e => setCustomerName(e.target.value)}
          placeholder="เช่น Kaoshop"
          style={{ ...inputStyle, marginBottom: '12px' }}
        />

        <label style={{ display: 'block', fontSize: '0.78rem', color: '#777', marginBottom: '4px' }}>ขั้นตอนการติดสติ๊กเกอร์</label>
        <textarea
          value={steps}
          onChange={e => setSteps(e.target.value)}
          placeholder={'เช่น\n1. แกะสติ๊กเกอร์...\n2. วาง...'}
          rows={6}
          style={{ ...inputStyle, marginBottom: '12px', resize: 'vertical', lineHeight: 1.5 }}
        />

        <label style={{ display: 'block', fontSize: '0.78rem', color: '#777', marginBottom: '6px' }}>รูปภาพประกอบ</label>
        {imageUrls.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
            {imageUrls.map((url, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={url} alt={`รูปที่ ${i + 1}`} style={{ width: '84px', height: '84px', objectFit: 'cover', borderRadius: '10px', boxShadow: '0 2px 6px rgba(0,0,0,0.12)' }} />
                <button onClick={() => removeImage(i)} style={{
                  position: 'absolute', top: '-6px', right: '-6px', width: '22px', height: '22px',
                  borderRadius: '50%', border: 'none', background: '#e53935', color: 'white',
                  fontSize: '0.75rem', cursor: 'pointer', lineHeight: 1,
                }}>✕</button>
              </div>
            ))}
          </div>
        )}

        <input ref={fileRef} type="file" accept="image/*" multiple onChange={e => handleFiles(e.target.files)} style={{ display: 'none' }} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading || !supabase}
          style={{
            border: '1.5px dashed #ff8c00', background: '#fff8f0', color: '#ff6b00',
            borderRadius: '12px', padding: '10px 16px', fontSize: '0.85rem', fontWeight: '600',
            cursor: uploading || !supabase ? 'default' : 'pointer', width: '100%',
          }}
        >
          {uploading ? 'กำลังอัปโหลด...' : '📤 อัปโหลดรูปภาพ (เลือกได้หลายไฟล์)'}
        </button>

        {message && (
          <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '10px', fontSize: '0.82rem', background: message.ok ? '#e8f5e9' : '#ffebee', color: message.ok ? '#2e7d32' : '#c62828' }}>
            {message.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
          <button
            onClick={handleSave}
            disabled={saving || uploading || !supabase}
            style={{
              flex: 1, background: saving || uploading || !supabase ? '#e0e0e0' : 'linear-gradient(135deg, #ff6b00, #ff8c00)',
              color: 'white', border: 'none', borderRadius: '24px', padding: '12px 0',
              fontWeight: '700', fontSize: '0.9rem', cursor: saving || uploading || !supabase ? 'default' : 'pointer',
            }}
          >
            {saving ? 'กำลังบันทึก...' : editingId ? 'บันทึกการแก้ไข' : 'เพิ่มคู่มือ'}
          </button>
          {editingId && (
            <button onClick={resetForm} style={{
              background: '#f5f5f5', color: '#777', border: '1.5px solid #e0e0e0',
              borderRadius: '24px', padding: '12px 20px', fontSize: '0.85rem', cursor: 'pointer',
            }}>ยกเลิก</button>
          )}
        </div>
      </div>

      {/* List */}
      <div style={{ margin: '0 12px' }}>
        <div style={{ fontWeight: '700', fontSize: '0.95rem', margin: '4px 4px 10px', color: '#333' }}>
          📋 รายชื่อลูกค้าในระบบ {guides.length > 0 && `(${guides.length})`}
        </div>
        {loading && <div style={{ color: '#999', fontSize: '0.85rem', padding: '8px' }}>กำลังโหลด...</div>}
        {!loading && guides.length === 0 && <div style={{ color: '#999', fontSize: '0.85rem', padding: '8px' }}>ยังไม่มีข้อมูลคู่มือ</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {guides.map(g => (
            <div key={g.id} style={{ background: '#fff', borderRadius: '14px', padding: '12px 14px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: '700', fontSize: '0.9rem', color: '#333' }}>{g.customer_name}</div>
                <div style={{ fontSize: '0.75rem', color: '#999', marginTop: '2px' }}>
                  {Array.isArray(g.image_urls) ? g.image_urls.length : 0} รูปภาพ
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button onClick={() => startEdit(g)} style={{
                  background: '#fff8f0', color: '#ff6b00', border: '1px solid #ffd9b3',
                  borderRadius: '8px', padding: '6px 12px', fontSize: '0.78rem', cursor: 'pointer', fontWeight: '600',
                }}>แก้ไข</button>
                <button onClick={() => handleDelete(g.id)} style={{
                  background: '#ffebee', color: '#c62828', border: '1px solid #ffcdd2',
                  borderRadius: '8px', padding: '6px 12px', fontSize: '0.78rem', cursor: 'pointer', fontWeight: '600',
                }}>ลบ</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default StickerGuideAdmin;
