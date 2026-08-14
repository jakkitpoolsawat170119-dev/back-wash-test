/* ══════════════ ตัวรันโค้ดของบล็อก "โค้ดที่รันได้" ══════════════
 *
 * โค้ดในบทความถูกรันใน <iframe sandbox="allow-scripts"> ที่ไม่มี allow-same-origin
 * ⚠️ ห้ามเติม allow-same-origin เด็ดขาด — ใส่คู่กับ allow-scripts เมื่อไหร่ กล่องกันจะพังทันที
 *    (โค้ดจะเอื้อมมาถึง DOM/สตอเรจของหน้าจริงได้)
 * ในกล่องนี้โค้ดทำอะไรไม่ได้เลยนอกจากคำนวณและวาดรูปในกล่องตัวเอง:
 *   แตะหน้าเว็บจริงไม่ได้ · อ่าน sessionStorage ที่เก็บสิทธิ์แอดมินไม่ได้ · เปลี่ยนหน้าไม่ได้
 *   และ **ต่อเน็ตไม่ได้** — CSP default-src 'none' ปิด fetch/XHR/WebSocket/รูปจากภายนอกทั้งหมด
 *   (ทับด้วยการถอดฟังก์ชันเครือข่ายออกอีกชั้น เพื่อให้ error อ่านรู้เรื่องแทนที่จะเงียบ)
 *
 * ส่งโค้ดเข้าไปด้วย postMessage ไม่ใช่ฝังใน srcdoc — โค้ดที่มี </script> จะได้ไม่ทำ HTML พัง
 *
 * ⚠️ ตัวเดียวกันนี้ถูกคัดลอกไว้ใน server/articlePage.js (หน้าอ่านสาธารณะไม่ได้ผ่าน bundler)
 *    แก้ที่นี่ต้องแก้ที่นั่นด้วย — เหมือนคู่ toMarkdown() / postToMarkdown()
 */

/** หน้าตาผลลัพธ์ 1 บรรทัด — log/warn จากโค้ด, err ข้อผิดพลาด, ret ค่าที่ return กลับมา */
export interface RunLine { k: 'log' | 'warn' | 'err' | 'ret'; v: string }
export interface RunResult { lines: RunLine[]; error: string; ms: number }
/** draw = โหมดวาดภาพ: กล่องอยู่ต่อหลังรันจบเพื่อให้ภาพเคลื่อนไหวเดินต่อ */
export interface RunHandle extends RunResult { stop: () => void }

/** สคริปต์ที่วิ่งอยู่ในกล่อง — เก็บ console.* ปิดทางเครือข่าย แล้วส่งผลกลับออกมา */
export const sandboxHtml = (draw: boolean) => `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:${draw ? '#1b1410' : 'transparent'};
color:#e8ddd2;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}</style><body><script>
(function () {
  var out = [];
  function fmt(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message;
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  function push(k, args) { out.push({ k: k, v: [].map.call(args, fmt).join(' ') }); }
  console.log = function () { push('log', arguments); };
  console.info = function () { push('log', arguments); };
  console.warn = function () { push('warn', arguments); };
  console.error = function () { push('err', arguments); };

  // ปิดทางออกเน็ตให้อ่านรู้เรื่อง — ตัวกันจริงคือ CSP ข้างบน อันนี้ไว้บอกเหตุผลตอนเรียก
  var NO_NET = 'บล็อกนี้ต่อเน็ตไม่ได้ — โค้ดในบทความถูกตัดขาดจากเครือข่ายทั้งหมด';
  function blocked() { throw new Error(NO_NET); }
  try {
    window.fetch = blocked;
    window.XMLHttpRequest = blocked;
    window.WebSocket = blocked;
    window.EventSource = blocked;
    if (window.navigator && navigator.sendBeacon) navigator.sendBeacon = blocked;
    window.Worker = blocked;
    window.importScripts = blocked;
  } catch (e) { /* เบราว์เซอร์บางตัวห้ามเขียนทับ — CSP ยังกันอยู่ */ }

  function done(err) { parent.postMessage({ spp: 'js-result', out: out, err: err || '' }, '*'); }
  window.addEventListener('message', function (e) {
    var code = e.data && e.data.spp === 'js-run' ? e.data.code : null;
    if (typeof code !== 'string') return;
    var run;
    try {
      run = new Function('"use strict"; return (async function () {\\n' + code + '\\n})()');
    } catch (ex) { return done('โค้ดผิดไวยากรณ์ — ' + (ex && ex.message || ex)); }
    try {
      Promise.resolve(run()).then(
        function (v) { if (v !== undefined) push('ret', [v]); done(''); },
        function (ex) { done(String(ex && ex.message || ex)); }
      );
    } catch (ex) { done(String(ex && ex.message || ex)); }
  });
  parent.postMessage({ spp: 'js-ready' }, '*');
})();
<\/script>`;

/**
 * รันโค้ดแล้วคืนผล
 * - โหมดคำนวณ (ไม่ส่ง mount) — กล่องถูกทิ้งทันทีที่ได้ผล
 * - โหมดวาดภาพ (ส่ง mount) — กล่องโผล่ในหน้าและอยู่ต่อ ให้ requestAnimationFrame เดินได้
 *   เรียก stop() เพื่อเก็บกล่องทิ้ง (ปุ่มหยุด / เปลี่ยนโค้ด / ออกจากหน้า)
 * ยังคุมด้วยนาฬิกาจับเวลาเสมอ: โค้ดที่วนแบบไม่คืนค่าใน 3 วิ = โดนทิ้งทั้งกล่อง
 * ไม่ throw ออกมา ผู้เรียกอ่าน error จากผลลัพธ์ได้เลย
 */
export function runJs(
  code: string,
  opts: { timeoutMs?: number; mount?: HTMLElement | null } = {},
): Promise<RunHandle> {
  const { timeoutMs = 3000, mount = null } = opts;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');   // ⚠️ อย่าเติม allow-same-origin
    frame.setAttribute('title', 'กล่องรันโค้ดของบทความ');
    if (mount) {
      frame.className = 'jsrun-frame';
      mount.replaceChildren(frame);
    } else {
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px;top:-9999px';
      document.body.appendChild(frame);
    }
    frame.srcdoc = sandboxHtml(!!mount);

    let finished = false;
    const kill = () => { window.removeEventListener('message', onMsg); frame.remove(); };
    const finish = (r: RunResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // โหมดวาดภาพเก็บกล่องไว้ให้ภาพเดินต่อ — ที่เหลือเก็บทิ้งทันที
      if (!mount || r.error) kill();
      resolve({ ...r, stop: kill });
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;      // ข้อความจากกล่องใบนี้เท่านั้น
      const d = e.data || {};
      if (d.spp === 'js-ready') { frame.contentWindow?.postMessage({ spp: 'js-run', code }, '*'); return; }
      if (d.spp === 'js-result') {
        finish({ lines: d.out || [], error: d.err || '', ms: Math.round(performance.now() - t0) });
      }
    };
    const timer = setTimeout(() => finish({
      lines: [],
      error: `รันเกิน ${(timeoutMs / 1000).toFixed(0)} วินาที — หยุดให้แล้ว (โค้ดอาจวนไม่รู้จบ)`,
      ms: timeoutMs,
    }), timeoutMs);

    window.addEventListener('message', onMsg);
  });
}
