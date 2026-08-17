import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchPublished, catStyle, thaiDate, readerUrl, allArticlesUrl,
  type ArticleCard as Article,
} from '../lib/articles';

/* ══════════════ ชั้นบทความบนหน้าหลัก ══════════════
 * บทความแนะนำ = 5 เรื่องล่าสุด เลื่อนเองทุก 5 วิ (หยุดเมื่อเอาเมาส์วาง/แตะ) + การ์ดล่าสุดอีก 6 เรื่อง
 * กดการ์ดแล้วไปหน้าอ่านสาธารณะที่เสิร์ฟจากเซิร์ฟเวอร์ — ในแอปไม่มีตัวอ่านบทความของตัวเอง
 * ยังไม่มีบทความเผยแพร่ = ไม่ต้องโชว์อะไรเลย (ไม่ขึ้นกล่องว่างให้เกะกะหน้าหลัก)
 */

const SLIDE_MS = 5000;
const RESUME_MS = 6000;

/** รูปหน้าปก — ไม่มีก็วาดพื้นไล่สีตามหมวดให้ เหมือนหน้าอ่านสาธารณะเป๊ะ */
const Cover: React.FC<{ p: Article; rank?: string }> = ({ p, rank }) => {
  const c = catStyle(p.category);
  const [broken, setBroken] = useState(false);
  const gen = !p.coverUrl || broken;
  return (
    <div className={`shot${gen ? ` gen ${c.g}` : ''}`}>
      {rank && <span className="rank">{rank}</span>}
      {gen
        ? <><span className="art" /><span className="glyph">{c.ic}</span></>
        : <img src={p.coverUrl} alt="" loading="lazy" onError={() => setBroken(true)} />}
      {p.category && <span className="cat">{p.category}</span>}
    </div>
  );
};

const Meta: React.FC<{ p: Article }> = ({ p }) => {
  const who = (p.author || '').trim();
  return (
    <div className="ameta">
      {who && <span className="av" style={{ background: catStyle(p.category).color }}>{who.slice(0, 1)}</span>}
      <span className="who">{who || 'ทีมผลิต'}</span>
      <span className="when">{thaiDate(p.publishedAt || p.updatedAt)}</span>
    </div>
  );
};

const Tags: React.FC<{ p: Article }> = ({ p }) => (
  (p.tags || []).length
    ? <div className="tags">{p.tags.slice(0, 3).map(t => <span className="tg" key={t}>#{t}</span>)}</div>
    : null
);

const ArticleShelf: React.FC = () => {
  const [posts, setPosts] = useState<Article[] | null>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const trackRef = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  const resume = useRef<number | null>(null);
  const t0 = useRef(0);              // ตั้งค่าจริงใน effect — เรียก performance.now() ตอน render ไม่ได้
  const barRef = useRef<HTMLSpanElement>(null);
  const reduce = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    let alive = true;
    fetchPublished(12)
      .then(items => { if (alive) setPosts(items); })
      .catch(() => { if (alive) setPosts([]); });   // ดึงไม่ได้ = ไม่โชว์ชั้นนี้ ไม่ต้องขึ้น error กลางหน้าหลัก
    return () => { alive = false; };
  }, []);

  const feat = (posts || []).slice(0, 5);

  const go = useCallback((k: number) => {
    const track = trackRef.current;
    if (!track || !feat.length) return;
    const n = (k + feat.length) % feat.length;
    const slide = track.children[n] as HTMLElement | undefined;
    if (slide) track.scrollTo({ left: slide.offsetLeft - track.offsetLeft, behavior: 'smooth' });
    t0.current = performance.now();
    setI(n);
  }, [feat.length]);

  const nudge = useCallback(() => {
    paused.current = true;
    if (resume.current) window.clearTimeout(resume.current);
    resume.current = window.setTimeout(() => { paused.current = false; t0.current = performance.now(); }, RESUME_MS);
  }, []);

  // เลื่อนเอง — เดินด้วย rAF ตัวเดียว ทั้งขยับสไลด์และวาดแถบเวลา
  useEffect(() => {
    if (!playing || reduce || feat.length < 2) {
      if (barRef.current) barRef.current.style.width = '0%';
      return;
    }
    let raf = 0;
    t0.current = performance.now();   // เปลี่ยนสไลด์/กดเล่น = เริ่มจับเวลาใหม่ทุกครั้ง
    const tick = (now: number) => {
      if (!paused.current && !document.hidden) {
        const p = (now - t0.current) / SLIDE_MS;
        if (barRef.current) barRef.current.style.width = `${Math.min(p, 1) * 100}%`;
        if (p >= 1) go(i + 1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, reduce, feat.length, i, go]);

  // คนลาก/สกอร์ลเอง → จุดต้องตามไปด้วย
  const onScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = 0, bd = Infinity;
    Array.from(track.children).forEach((el, k) => {
      const s = el as HTMLElement;
      const d = Math.abs(s.offsetLeft - track.offsetLeft + s.clientWidth / 2 - mid);
      if (d < bd) { bd = d; best = k; }
    });
    if (best !== i) { t0.current = performance.now(); setI(best); }
  };

  if (posts === null || posts.length === 0) return null;

  return (
    <section className="ashelf">
      {feat.length > 1 && (
        <>
          <div className="shead">
            <div>
              <span className="eyebrow">⭐ บทความแนะนำ</span>
              <h2>เรื่องล่าสุดจากหน้างาน</h2>
              <div className="sub">หยิบ {feat.length} เรื่องที่เผยแพร่ล่าสุดมาหมุนให้เอง — แตะหรือลากเพื่อเลื่อนเองได้</div>
            </div>
          </div>

          <div
            className="car"
            onMouseEnter={() => { paused.current = true; if (resume.current) window.clearTimeout(resume.current); }}
            onMouseLeave={() => { paused.current = false; t0.current = performance.now(); }}
            onFocus={() => { paused.current = true; }}
          >
            <button className="carbtn prev" aria-label="ก่อนหน้า" onClick={() => { go(i - 1); nudge(); }}>‹</button>
            <button className="carbtn next" aria-label="ถัดไป" onClick={() => { go(i + 1); nudge(); }}>›</button>
            <div
              className="track" ref={trackRef} onScroll={onScroll}
              onPointerDown={nudge} onWheel={nudge} onTouchStart={nudge}
            >
              {feat.map((p, k) => (
                <div className="slide" key={p.id}>
                  <a className="feat" href={readerUrl(p.slug)} target="_blank" rel="noopener noreferrer">
                    <Cover p={p} rank={k === 0 ? '⭐ ใหม่ล่าสุด' : `${k + 1} / ${feat.length}`} />
                    <div className="acbody">
                      <h3>{p.title}</h3>
                      {p.excerpt && <p>{p.excerpt}</p>}
                      <Tags p={p} />
                      <Meta p={p} />
                    </div>
                  </a>
                </div>
              ))}
            </div>
            <div className="cardock">
              <div className="dots">
                {feat.map((p, k) => (
                  <button key={p.id} className={k === i ? 'on' : ''} aria-label={`ไปเรื่องที่ ${k + 1}`}
                    onClick={() => { go(k); nudge(); }} />
                ))}
              </div>
              <span className="bar"><i ref={barRef} /></span>
              <button className="playbtn" onClick={() => { setPlaying(v => !v); t0.current = performance.now(); }}>
                {playing && !reduce ? '⏸ หยุดเลื่อนเอง' : '▶ ให้เลื่อนเอง'}
              </button>
            </div>
          </div>
        </>
      )}

      <div className="shead">
        <div>
          <h2>บทความล่าสุด</h2>
          <div className="sub">คู่มือและบันทึกจากหน้างานที่ทีมเขียนไว้</div>
        </div>
        <a className="more" href={allArticlesUrl} target="_blank" rel="noopener noreferrer">
          ดูทั้งหมด {posts.length} เรื่อง →
        </a>
      </div>

      <div className="agrid">
        {posts.slice(0, 6).map(p => (
          <a className="acard" key={p.id} href={readerUrl(p.slug)} target="_blank" rel="noopener noreferrer">
            <Cover p={p} />
            <div className="acbody">
              <h3>{p.title}</h3>
              {p.excerpt && <p>{p.excerpt}</p>}
              <Tags p={p} />
              <Meta p={p} />
            </div>
          </a>
        ))}
      </div>
    </section>
  );
};

export default ArticleShelf;
