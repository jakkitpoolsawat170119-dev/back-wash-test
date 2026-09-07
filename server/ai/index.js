// ชั้นกลางคุยกับผู้ให้บริการ AI — Anthropic (เดิม) หรือ OpenRouter (Kimi ฯลฯ)
//
// 🔑 หลักการ: ชั้นนี้ "พูดภาษา Anthropic" ทั้งขาเข้าและขาออก
//    เพราะโค้ดเดิม 6 จุดอ่านผลลัพธ์เป็นทรง Anthropic อยู่แล้ว (resp.content[] / stop_reason / usage)
//    เวลาใช้ OpenRouter ชั้นนี้แปลงเป็นทรง OpenAI ตอนส่ง แล้วแปลงกลับตอนรับ
//    → จุดเรียกทั้ง 6 ไม่ต้องรู้เลยว่ากำลังคุยกับเจ้าไหน และสลับกลับได้ด้วยการแก้ env ตัวเดียว
//
// OpenRouter เป็น API ที่เข้ากันได้กับ OpenAI จึงใช้ SDK `openai` ตัวเดียวคุยได้ทั้งหมด
// (เปลี่ยนแค่ baseURL) — ไม่ต้องลง SDK แยกต่อเจ้า

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// ตั้ง env ทับได้ — ใช้ตอนทดสอบ (ชี้ไปเซิร์ฟเวอร์จำลอง) หรือถ้าวันหน้าต่อผ่าน gateway อื่น
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

// ค่าตั้งต้นต่อ "จุดที่เรียก AI" — เลือกรุ่นตามงาน ไม่ใช่ตัวเดียวใช้ทุกที่
// (Kimi K3 แพงกว่า Haiku ~2.5 เท่า จึงใช้เฉพาะจุดอ่านรูปเอกสารไทย ซึ่งของเดิมเป็น Opus 5 อยู่แล้ว)
const PURPOSES = {
  assist:  { env: 'AI_ASSIST',  openrouter: 'moonshotai/kimi-k2.6', anthropic: 'claude-haiku-4-5' },
  // งานแกะข้อความเป็นฟิลด์แบบบังคับเรียก tool (รับกะ / ลงแผนผลิต) — วันละไม่กี่ครั้งแต่ผิดไม่ได้
  // วัดจริง 7 ก.ย.: K2.6 ได้ 3/6 (ตก [L1]/[A3] และจำนวนคน) · K3 ได้ 6/6 → คุ้มที่จะจ่ายแพงเฉพาะจุดนี้
  assist_extract: { env: 'AI_ASSIST_EXTRACT', openrouter: 'moonshotai/kimi-k3', anthropic: 'claude-haiku-4-5' },
  sheet:   { env: 'AI_SHEET',   openrouter: 'moonshotai/kimi-k3',   anthropic: 'claude-opus-5'   },
  routine: { env: 'AI_ROUTINE', openrouter: 'moonshotai/kimi-k3',   anthropic: 'claude-opus-5'   },
  parse:   { env: 'AI_PARSE',   openrouter: 'moonshotai/kimi-k2.6', anthropic: 'claude-opus-5',  modelEnv: 'SPP_PARSE_MODEL' },
  assign:  { env: 'AI_ASSIGN',  openrouter: 'moonshotai/kimi-k2.6', anthropic: 'claude-haiku-4-5' },
  jsgen:   { env: 'AI_JS',      openrouter: 'moonshotai/kimi-k2.6', anthropic: 'claude-sonnet-5', modelEnv: 'SPP_JS_MODEL' },
};

// เลือกเจ้าให้จุดนี้ — ตั้ง env เจาะจงได้ ไม่ตั้งก็ดูว่ามีคีย์ของใคร
// ⚠️ ลำดับนี้สำคัญ: ยังไม่ได้ใส่คีย์ OpenRouter = ทุกอย่างทำงานเหมือนเดิมด้วย Anthropic
//    ใส่คีย์ OpenRouter เมื่อไหร่ถึงจะย้ายเอง (ไม่ต้องแก้โค้ด)
function providerFor(purpose) {
  const cfg = PURPOSES[purpose];
  if (!cfg) throw new Error(`ไม่รู้จักจุดเรียก AI: ${purpose}`);
  const forced = (process.env[`${cfg.env}_PROVIDER`] || '').trim().toLowerCase();
  if (forced === 'openrouter' || forced === 'anthropic') return forced;
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

function modelFor(purpose, provider) {
  const cfg = PURPOSES[purpose];
  // env เจาะจงรุ่นชนะเสมอ · คงชื่อ env เดิมไว้สำหรับจุดที่เคยมี (SPP_PARSE_MODEL / SPP_JS_MODEL)
  return (process.env[`${cfg.env}_MODEL`] || (cfg.modelEnv && process.env[cfg.modelEnv]) || cfg[provider]).trim();
}

let _anthropic = null;
let _openrouter = null;

function anthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) _anthropic = new Anthropic(); // อ่าน ANTHROPIC_API_KEY จาก env
  return _anthropic;
}

function openrouterClient() {
  if (!process.env.OPENROUTER_API_KEY) return null;
  if (!_openrouter) {
    _openrouter = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      // OpenRouter ใช้ 2 หัวนี้จัดอันดับ/แสดงที่มา — ไม่ใส่ก็ได้ แต่ใส่แล้วดูออกว่าเรียกมาจากแอปไหน
      defaultHeaders: {
        'HTTP-Referer': process.env.PUBLIC_WEB_URL || 'https://back-wash-test.onrender.com',
        'X-Title': 'SPP Production App',
      },
    });
  }
  return _openrouter;
}

// มี AI ให้ใช้ไหมสำหรับจุดนี้ — ใช้แทน getAnthropic() ในการ์ดกันหน้า endpoint
// คืน false = ต้องถอยไปโหมดสำรอง (กดปุ่มเอง / พิมพ์เอง) ห้ามปล่อยให้พัง
function available(purpose) {
  const p = providerFor(purpose);
  if (p === 'anthropic') return !!anthropicClient();
  if (p === 'openrouter') return !!openrouterClient();
  return false;
}

// ── ข้อผิดพลาดที่แปลว่า "ยังใช้ AI ไม่ได้" (ไม่ใช่บั๊ก) ────────────────────────
// 402 = เครดิตหมด ← นี่คือเหตุการณ์ 2 ก.ย. ถ้าไม่ดักไว้แอปจะพังเงียบซ้ำรอบสอง
// 401 = คีย์ผิด · 429 = ยิงถี่เกิน
function wrapProviderError(err, provider) {
  const status = err && (err.status || err.statusCode);
  // ⚠️ แต่ละเจ้าบอก "เงินหมด" คนละรหัส — OpenRouter ใช้ 402 แต่ **Anthropic ใช้ 400**
  //    (ยืนยันของจริง 7 ก.ย.: 400 invalid_request_error "credit balance is too low")
  //    ดักแค่ 402 ไม่พอ ไม่งั้นเครดิตหมดแล้วแอปพัง 500 แทนที่จะถอยอย่างสุภาพ
  const lowCredit = /credit balance is too low|insufficient[_ ]credit|quota/i.test(String(err && err.message || ''));
  let msg = null;
  if (status === 402 || lowCredit) msg = `เครดิต ${provider} หมด — เติมเงินแล้วใช้ได้ทันที (ระหว่างนี้ทำเองตามปกติได้)`;
  else if (status === 401) msg = `คีย์ ${provider} ไม่ถูกต้อง — ตรวจค่าใน environment variables`;
  else if (status === 429) msg = 'เรียก AI ถี่เกินไป รอสักครู่แล้วลองใหม่';
  if (!msg) return err;
  const e = new Error(msg);
  e.status = 503;      // ให้ endpoint ตอบ 503 (บริการยังไม่พร้อม) ไม่ใช่ 500 (แอปพัง)
  e.aiUnavailable = true;
  e.cause = err;
  return e;
}

// ── แปลงคำขอ: ทรง Anthropic → ทรง OpenAI ──────────────────────────────────────

function textOfSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  // ก้อน system หลายบล็อก (ก้อนคงที่ + ก้อนผันแปร) → ต่อกันเป็นข้อความเดียว
  // cache_control ตกไปตรงนี้เอง เพราะฝั่ง OpenRouter ทำ cache ให้เองที่ provider
  return system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
}

function blockToOpenAI(block) {
  if (typeof block === 'string') return { type: 'text', text: block };
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    const src = block.source || {};
    return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  return null;
}

function messagesToOpenAI(messages) {
  const out = [];
  for (const m of messages) {
    const content = m.content;
    if (typeof content === 'string') { out.push({ role: m.role, content }); continue; }
    const blocks = Array.isArray(content) ? content : [content];

    // ผลลัพธ์ tool: Anthropic ใส่รวมใน user message · OpenAI แยกเป็น message role 'tool' ทีละอัน
    const toolResults = blocks.filter(b => b && b.type === 'tool_result');
    if (toolResults.length) {
      for (const t of toolResults) {
        out.push({ role: 'tool', tool_call_id: t.tool_use_id, content: String(t.content ?? '') });
      }
      const rest = blocks.filter(b => b && b.type !== 'tool_result').map(blockToOpenAI).filter(Boolean);
      if (rest.length) out.push({ role: m.role, content: rest });
      continue;
    }

    // ที่โมเดลขอเรียก tool: Anthropic = tool_use block · OpenAI = tool_calls บน assistant message
    const toolUses = blocks.filter(b => b && b.type === 'tool_use');
    if (toolUses.length) {
      const texts = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
      out.push({
        role: 'assistant',
        content: texts || null,
        tool_calls: toolUses.map(t => ({
          id: t.id, type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
        })),
      });
      continue;
    }

    out.push({ role: m.role, content: blocks.map(blockToOpenAI).filter(Boolean) });
  }
  return out;
}

function toOpenAIRequest(params, model) {
  const req = { model, max_tokens: params.max_tokens };
  const sys = textOfSystem(params.system);
  const msgs = messagesToOpenAI(params.messages || []);
  req.messages = sys ? [{ role: 'system', content: sys }, ...msgs] : msgs;

  if (params.tools && params.tools.length) {
    req.tools = params.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (params.tool_choice) {
    const tc = params.tool_choice;
    if (tc.type === 'tool') req.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc.type === 'any') req.tool_choice = 'required';
    else if (tc.type === 'none') req.tool_choice = 'none';
    else req.tool_choice = 'auto';
  }

  const oc = params.output_config || {};
  // บังคับ JSON ตรงสเปก — schema เดิมใช้ตัวเดียวกันได้ แค่ห่อคนละชั้น
  if (oc.format && oc.format.type === 'json_schema') {
    req.response_format = {
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema: oc.format.schema },
    };
  }
  // thinking / effort เป็นของ Anthropic → ฝั่ง OpenRouter ใช้ reasoning แทน
  //
  // 🔴 ต้อง "ปิด" ให้ชัดเจนเมื่อฝั่ง Anthropic ไม่ได้เปิด thinking — ห้ามปล่อยว่าง
  //    Kimi เป็นโมเดลสายคิดก่อนตอบ และ max_tokens คุม "ความคิด + คำตอบ" รวมกัน
  //    ปล่อยว่างแล้วเจอจริง: จุดเดาผู้รับผิดชอบ (max_tokens 300) คิดจนหมดโควตา
  //    → ตอบกลับมาเป็นข้อความว่าง หรือพ่นความคิดออกมาแทนคำตอบ (2 ใน 3 เคสพัง)
  if (params.thinking && params.thinking.type === 'disabled') req.reasoning = { enabled: false }; // สั่งปิดชัดเจน ชนะทุกกรณี
  else if (params.thinking) req.reasoning = { effort: oc.effort || 'medium' };                     // adaptive = ให้คิด
  else if (oc.effort) req.reasoning = { effort: oc.effort };                                       // ระบุ effort มาเอง = เคารพ
  else req.reasoning = { enabled: false };                                                         // ไม่ระบุอะไรเลย = ไม่คิด (ตรงกับฝั่ง Anthropic)

  return req;
}

// ── แปลงผลลัพธ์: ทรง OpenAI → ทรง Anthropic ───────────────────────────────────

const STOP_REASON = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' };

function fromOpenAIResponse(resp) {
  const choice = (resp.choices && resp.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    // อาร์กิวเมนต์มาเป็นสตริง JSON — พังได้ถ้าโมเดลตอบไม่ครบ ต้องกันไว้ ไม่ใช่ปล่อย throw
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  const u = resp.usage || {};
  return {
    content,
    stop_reason: STOP_REASON[choice.finish_reason] || 'end_turn',
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      cache_read_input_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// ── ทางเข้าหลัก ───────────────────────────────────────────────────────────────
// params = ทรงเดียวกับ client.messages.create() ของ Anthropic เป๊ะ ๆ
// (ยกเว้น model — ชั้นนี้เลือกให้เองจาก purpose + env)
async function createMessage(purpose, params) {
  const provider = providerFor(purpose);
  if (!provider) throw Object.assign(new Error('ยังไม่ได้ตั้งค่าคีย์ AI บนเซิร์ฟเวอร์'), { status: 503, aiUnavailable: true });
  const model = modelFor(purpose, provider);

  try {
    if (provider === 'anthropic') {
      const client = anthropicClient();
      if (!client) throw Object.assign(new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY'), { status: 503, aiUnavailable: true });
      return await client.messages.create({ ...params, model });
    }
    const client = openrouterClient();
    if (!client) throw Object.assign(new Error('ยังไม่ได้ตั้งค่า OPENROUTER_API_KEY'), { status: 503, aiUnavailable: true });
    const resp = await client.chat.completions.create(toOpenAIRequest(params, model));
    return fromOpenAIResponse(resp);
  } catch (err) {
    if (err && err.aiUnavailable) throw err;
    throw wrapProviderError(err, provider);
  }
}

// ไว้ log ว่ารอบนี้วิ่งไปเจ้าไหน/รุ่นไหน — เวลาเทียบผลจะได้รู้ว่าเทียบอะไรกับอะไร
function describe(purpose) {
  const provider = providerFor(purpose);
  return provider ? `${provider}:${modelFor(purpose, provider)}` : 'ไม่มีคีย์';
}

module.exports = { createMessage, available, describe, providerFor, modelFor, PURPOSES,
  // เปิดตัวแปลงไว้ให้ทดสอบได้โดยไม่ต้องยิงเน็ตจริง (ส่วนที่พังง่ายสุดของชั้นนี้)
  __test: { toOpenAIRequest, fromOpenAIResponse, messagesToOpenAI, textOfSystem } };
