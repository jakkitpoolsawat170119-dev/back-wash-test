/* ══════════════ ตัวรันโค้ดของบล็อก "โค้ดที่รันได้" ══════════════
 *
 * โค้ดในบทความถูกรันใน <iframe sandbox="allow-scripts"> ที่ไม่มี allow-same-origin
 * ⚠️ ห้ามเติม allow-same-origin เด็ดขาด — ใส่คู่กับ allow-scripts เมื่อไหร่ กล่องกันจะพังทันที
 *    (โค้ดจะเอื้อมมาถึง DOM/สตอเรจของหน้าจริงได้)
 * ในกล่องนี้โค้ดทำอะไรไม่ได้เลยนอกจากคำนวณ: แตะหน้าเว็บจริงไม่ได้ · อ่าน sessionStorage
 * ที่เก็บสิทธิ์แอดมินไม่ได้ · เปลี่ยนหน้า/เปิดป็อปอัปไม่ได้ · ส่งฟอร์มไม่ได้
 *
 * ส่งโค้ดเข้าไปด้วย postMessage ไม่ใช่ฝังใน srcdoc — โค้ดที่มี </script> จะได้ไม่ทำ HTML พัง
 *
 * ⚠️ ตัวเดียวกันนี้ถูกคัดลอกไว้ใน server/articlePage.js (หน้าอ่านสาธารณะไม่ได้ผ่าน bundler)
 *    แก้ที่นี่ต้องแก้ที่นั่นด้วย — เหมือนคู่ toMarkdown() / postToMarkdown()
 */

/** หน้าตาผลลัพธ์ 1 บรรทัด — log/warn จากโค้ด, err ข้อผิดพลาด, ret ค่าที่ return กลับมา */
export interface RunLine { k: 'log' | 'warn' | 'err' | 'ret'; v: string }
export interface RunResult { lines: RunLine[]; error: string; ms: number }

/** สคริปต์ที่วิ่งอยู่ในกล่อง — เก็บ console.* แล้วส่งผลกลับออกมา */
export const SANDBOX_HTML = `<!doctype html><meta charset="utf-8"><body><script>
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
 * รันโค้ดแล้วคืนผล — เกินเวลาที่ให้ = ทิ้งกล่องทั้งใบ (โค้ดวนไม่รู้จบก็ไม่ค้างหน้าเว็บ)
 * ไม่ throw ออกมา ผู้เรียกอ่าน error จากผลลัพธ์ได้เลย
 */
export function runJs(code: string, timeoutMs = 3000): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');   // ⚠️ อย่าเติม allow-same-origin
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px;top:-9999px';
    frame.srcdoc = SANDBOX_HTML;

    let finished = false;
    const finish = (r: RunResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      frame.remove();
      resolve(r);
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
    document.body.appendChild(frame);
  });
}
