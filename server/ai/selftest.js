// ทดสอบชั้นกลาง AI โดยไม่ยิงเน็ตจริง — รันด้วย `npm run test:ai`
// ครอบเฉพาะส่วนที่พังง่ายสุด: การเลือกเจ้า/รุ่น + ตัวแปลงคำขอ/ผลลัพธ์
const assert = require('assert');
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✅ ' + name); };

const reload = (env) => {
  for (const k of Object.keys(process.env)) if (k.startsWith('AI_') || k.startsWith('SPP_') || k.endsWith('_API_KEY')) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./index.js')];
  return require('./index.js');
};

console.log('── เลือกเจ้า/รุ่นต่อจุด ──');
t('ไม่มีคีย์ OpenRouter = ทำงานเหมือนเดิมด้วย Anthropic ทุกจุด', () => {
  const ai = reload({ ANTHROPIC_API_KEY: 'x' });
  assert.strictEqual(ai.describe('assist'), 'anthropic:claude-haiku-4-5');
  assert.strictEqual(ai.describe('parse'), 'anthropic:claude-opus-5');
  assert.strictEqual(ai.describe('jsgen'), 'anthropic:claude-sonnet-5');
});
t('ใส่คีย์ OpenRouter = ย้ายเอง · จุดอ่านรูปได้ K3 · ที่เหลือ K2.6', () => {
  const ai = reload({ ANTHROPIC_API_KEY: 'x', OPENROUTER_API_KEY: 'y' });
  assert.strictEqual(ai.describe('sheet'), 'openrouter:moonshotai/kimi-k3');
  assert.strictEqual(ai.describe('routine'), 'openrouter:moonshotai/kimi-k3');
  assert.strictEqual(ai.describe('assist'), 'openrouter:moonshotai/kimi-k2.6');
});
t('ดึงกลับ Anthropic รายจุดได้ (ทางถอยตอนอ่านไทยพลาด)', () => {
  const ai = reload({ ANTHROPIC_API_KEY: 'x', OPENROUTER_API_KEY: 'y', AI_SHEET_PROVIDER: 'anthropic' });
  assert.strictEqual(ai.describe('sheet'), 'anthropic:claude-opus-5');
  assert.strictEqual(ai.describe('routine'), 'openrouter:moonshotai/kimi-k3');
});
t('ไม่มีคีย์เลย = ทุกจุดปิดตัวเอง (ต้องถอย ไม่ใช่พัง)', () => {
  const ai = reload({});
  for (const k of Object.keys(ai.PURPOSES)) assert.strictEqual(ai.available(k), false);
});

const { __test } = reload({ OPENROUTER_API_KEY: 'y' });
const { toOpenAIRequest, fromOpenAIResponse } = __test;

console.log('── แปลงคำขอ: Anthropic → OpenAI ──');
t('system หลายก้อนต่อกัน + ตัด cache_control ทิ้ง', () => {
  const r = toOpenAIRequest({ max_tokens: 10, system: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }], messages: [] }, 'm');
  assert.strictEqual(r.messages[0].content, 'A\nB');
  assert.ok(!JSON.stringify(r).includes('cache_control'));
});
t('รูป base64 → image_url data URI', () => {
  const r = toOpenAIRequest({ max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { media_type: 'image/png', data: 'Q' } }] }] }, 'm');
  assert.strictEqual(r.messages[0].content[0].image_url.url, 'data:image/png;base64,Q');
});
t('tools + บังคับ tool เทิร์นแรก แปลงครบ (ห้ามตัดทิ้ง)', () => {
  const r = toOpenAIRequest({ max_tokens: 10, tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'f' }, messages: [] }, 'm');
  assert.strictEqual(r.tools[0].function.name, 'f');
  assert.deepStrictEqual(r.tool_choice, { type: 'function', function: { name: 'f' } });
});
t('json_schema → response_format · effort → reasoning', () => {
  const r = toOpenAIRequest({ max_tokens: 10, thinking: { type: 'adaptive' }, output_config: { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object' } } }, messages: [] }, 'm');
  assert.strictEqual(r.response_format.type, 'json_schema');
  assert.strictEqual(r.reasoning.effort, 'medium');
  assert.ok(!('thinking' in r));
});
t('thinking disabled → ปิด reasoning (จุดแกะแผนผลิตต้องเร็ว)', () => {
  const r = toOpenAIRequest({ max_tokens: 10, thinking: { type: 'disabled' }, messages: [] }, 'm');
  assert.deepStrictEqual(r.reasoning, { enabled: false });
});
// 🔴 กันบั๊กที่เจอจริง 7 ก.ย.: ไม่ส่ง thinking มาเลย = ฝั่ง Anthropic ไม่คิด
// ถ้าไม่สั่งปิดให้ชัด Kimi จะคิดจนหมด max_tokens แล้วตอบข้อความว่าง/พ่นความคิดออกมาแทนคำตอบ
t('ไม่ส่ง thinking มาเลย → ต้องปิด reasoning ไม่ใช่ปล่อยว่าง', () => {
  const r = toOpenAIRequest({ max_tokens: 300, messages: [{ role: 'user', content: 'x' }] }, 'm');
  assert.deepStrictEqual(r.reasoning, { enabled: false });
});
t('thinking adaptive แต่ไม่ระบุ effort → คิดระดับกลาง', () => {
  const r = toOpenAIRequest({ max_tokens: 10, thinking: { type: 'adaptive' }, messages: [] }, 'm');
  assert.strictEqual(r.reasoning.effort, 'medium');
});
t('วงวน tool ไป-กลับ: tool_use → tool_calls · tool_result → role tool', () => {
  const r = toOpenAIRequest({ max_tokens: 10, messages: [
    { role: 'assistant', content: [{ type: 'text', text: 'ขอดู' }, { type: 'tool_use', id: 'c1', name: 'g', input: { d: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"n":1}' }] },
  ] }, 'm');
  assert.strictEqual(r.messages[0].tool_calls[0].id, 'c1');
  assert.strictEqual(r.messages[0].tool_calls[0].function.arguments, '{"d":1}');
  assert.strictEqual(r.messages[1].role, 'tool');
  assert.strictEqual(r.messages[1].tool_call_id, 'c1');
});

console.log('── แปลงผลลัพธ์: OpenAI → Anthropic ──');
t('tool_calls → stop_reason tool_use + tool_use block', () => {
  const a = fromOpenAIResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: 'x', tool_calls: [{ id: 'c', function: { name: 'g', arguments: '{"d":2}' } }] } }], usage: {} });
  assert.strictEqual(a.stop_reason, 'tool_use');
  assert.strictEqual(a.content[1].input.d, 2);
});
t('usage แปลงครบ รวม cache_read', () => {
  const a = fromOpenAIResponse({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 7 } } });
  assert.strictEqual(a.usage.input_tokens, 9);
  assert.strictEqual(a.usage.cache_read_input_tokens, 7);
});
t('arguments เป็น JSON พัง → ไม่ throw', () => {
  const a = fromOpenAIResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'g', arguments: '{ พัง' } }] } }], usage: {} });
  assert.deepStrictEqual(a.content[0].input, {});
});

// ── วิ่งจริงกับเซิร์ฟเวอร์จำลอง (ไม่ยิงเน็ตออกนอกเครื่อง) ──────────────────────
const http = require('http');

const withStub = (handler, fn) => new Promise((resolve, reject) => {
  const stub = http.createServer(handler);
  stub.listen(0, async () => {
    process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:' + stub.address().port + '/api/v1';
    process.env.OPENROUTER_API_KEY = 'fake';
    delete process.env.ANTHROPIC_API_KEY;
    delete require.cache[require.resolve('./index.js')];
    try { await fn(require('./index.js')); resolve(); } catch (e) { reject(e); } finally { stub.close(); }
  });
});

(async () => {
  console.log('── วิ่งครบวงจรกับเซิร์ฟเวอร์จำลอง ──');

  let seen = null;
  await withStub((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      seen = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: 'ขอดูก่อน',
        tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_prod', arguments: '{"date":"2026-09-07"}' } }] } }],
        usage: { prompt_tokens: 1200, completion_tokens: 45, prompt_tokens_details: { cached_tokens: 1000 } } }));
    });
  }, async (ai) => {
    const resp = await ai.createMessage('assist', {
      max_tokens: 4096,
      system: [{ type: 'text', text: 'คำสั่ง', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'วันนี้คือ x' }],
      tools: [{ name: 'get_prod', description: 'ยอด', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_prod' },
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: [{ type: 'image', source: { media_type: 'image/jpeg', data: 'A' } }, { type: 'text', text: 'ยอด?' }] }],
    });
    t('ส่งรุ่นตามค่าตั้งต้นของจุดนั้น', () => assert.strictEqual(seen.model, 'moonshotai/kimi-k2.6'));
    t('SDK ยอมรับ reasoning.effort (พารามิเตอร์นอกมาตรฐาน OpenAI)', () => assert.strictEqual(seen.reasoning.effort, 'low'));
    t('ไม่มี cache_control/thinking หลุดออกไป', () => {
      const j = JSON.stringify(seen);
      assert.ok(!j.includes('cache_control') && !j.includes('thinking'));
    });
    t('ผลลัพธ์กลับมาเป็นทรง Anthropic ที่โค้ดเดิมอ่านได้', () => {
      assert.strictEqual(resp.stop_reason, 'tool_use');
      assert.strictEqual(resp.content[1].input.date, '2026-09-07');
      assert.strictEqual(resp.usage.cache_read_input_tokens, 1000);
    });
  });

  await withStub((req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient credits' } }));
  }, async (ai) => {
    // นี่คือสถานการณ์ 2 ก.ย. — เครดิตหมดต้องถอยอย่างสุภาพ ไม่ใช่แอปพัง
    let caught = null;
    try { await ai.createMessage('assist', { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { caught = e; }
    t('เครดิตหมด OpenRouter (402) → 503 + aiUnavailable ไม่ใช่ 500', () => {
      assert.ok(caught, 'ต้อง throw');
      assert.strictEqual(caught.status, 503);
      assert.strictEqual(caught.aiUnavailable, true);
    });
  });

  // Anthropic บอกเงินหมดด้วย 400 ไม่ใช่ 402 — ต้องถอยอย่างสุภาพเหมือนกัน (ของจริง 7 ก.ย.)
  await withStub((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Your credit balance is too low to access the Anthropic API.' } }));
  }, async (ai) => {
    let caught = null;
    try { await ai.createMessage('assist', { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { caught = e; }
    t('เครดิตหมดแบบ Anthropic (400 + ข้อความ) → 503 ด้วย', () => {
      assert.ok(caught, 'ต้อง throw');
      assert.strictEqual(caught.status, 503);
      assert.strictEqual(caught.aiUnavailable, true);
    });
  });

  // เจอจริง 7 ก.ย.: kimi-k2.6 อ่านรูปค้าง 533 วินาทีแล้วหลุดเอง → เคยได้ 500 (เหมือนแอปพัง)
  await withStub((req, res) => { /* ไม่ตอบเลย ปล่อยให้ค้างจนหมดเวลา */ }, async (ai) => {
    process.env.AI_TIMEOUT_MS = '1200';
    delete require.cache[require.resolve('./index.js')];
    const fresh = require('./index.js');
    let caught = null;
    try { await fresh.createMessage('assist', { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { caught = e; }
    delete process.env.AI_TIMEOUT_MS;
    t('AI ตอบช้าจนหมดเวลา → 503 บอกให้ลองใหม่ ไม่ใช่ 500', () => {
      assert.ok(caught, 'ต้อง throw');
      assert.strictEqual(caught.status, 503);
      assert.ok(/ช้าเกินไป/.test(caught.message), 'ข้อความต้องบอกว่าช้าเกินไป: ' + caught.message);
    });
  });

  console.log('\n✅ ผ่านหมด ' + pass + ' ข้อ');
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
