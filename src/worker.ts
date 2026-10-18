/**
 * 数学家 · Cloudflare Worker
 * 静态资源 /math/*  +  API /math/api/*
 * 存储：D1（结构化数据） + R2（图片）
 * 大模型：OpenAI 兼容接口（默认火山方舟 豆包视觉模型）
 */

import {
  gradeSystemPrompt,
  gradeUserPrompt,
  variantsSystemPrompt,
  variantsUserPrompt,
  variantGradeSystemPrompt,
  variantGradeUserPrompt,
} from './prompts';

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
}

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
// 预置推理接入点：拿到 API Key 即可直接用，无需自己创建接入点
const DEFAULT_MODEL = 'doubao-seed-2-0-mini-260428';

/* ------------------------------------------------------------------ utils */

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

function now(): string {
  return new Date().toISOString();
}

function joinUrl(base: string, path: string): string {
  const b = (base || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return b.endsWith('/api/v3') || b.endsWith('/v1') ? `${b}/${path}` : `${b}/${path}`;
}

/** 从大模型回复里尽量稳健地抠出 JSON */
function extractJson(text: string): any {
  let s = text.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(binary);
}

function extOf(name: string, fallback = 'jpg'): string {
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(name || '');
  return (m ? m[1] : fallback).toLowerCase();
}

function contentTypeOf(key: string): string {
  const e = extOf(key);
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  if (e === 'heic' || e === 'heif') return 'image/heic';
  return 'image/jpeg';
}

/* --------------------------------------------------------------- settings */

interface Settings {
  base_url: string;
  api_key: string;
  model: string;
  grade: string;
  student_name: string;
  passcode: string;
  /** 文本 / 推理模型槽位（出题、讲解）。留空则自动回落用视觉模型 */
  text_base_url: string;
  text_api_key: string;
  text_model: string;
  /** 当前启用的模型源 id（llm_profiles），优先于上面几列 */
  active_vision_profile: string;
  active_text_profile: string;
  /** fast = 关/低思考（快）；deep = 模型默认长思考（慢，可能超时） */
  thinking_mode: string;
}

async function getSettings(env: Env): Promise<Settings> {
  const row = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first<any>();
  return {
    base_url: row?.base_url || DEFAULT_BASE,
    api_key: row?.api_key || '',
    model: row?.model || DEFAULT_MODEL,
    grade: row?.grade || '一年级',
    student_name: row?.student_name || '',
    passcode: row?.passcode || '',
    text_base_url: row?.text_base_url || '',
    text_api_key: row?.text_api_key || '',
    text_model: row?.text_model || '',
    active_vision_profile: row?.active_vision_profile || '',
    active_text_profile: row?.active_text_profile || '',
    thinking_mode: row?.thinking_mode === 'deep' ? 'deep' : 'fast',
  };
}

/* ------------------------------------------------------ 模型源库 llm_profiles */

interface Profile {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  kind: string;
  note: string;
}

async function listProfiles(env: Env): Promise<Profile[]> {
  const r = await env.DB.prepare('SELECT * FROM llm_profiles ORDER BY created_at').all<any>();
  return (r.results || []).map((x) => ({
    id: x.id,
    name: x.name,
    base_url: x.base_url,
    api_key: x.api_key || '',
    model: x.model,
    kind: x.kind || 'vision',
    note: x.note || '',
  }));
}

async function getProfile(env: Env, id: string): Promise<Profile | null> {
  if (!id) return null;
  const x = await env.DB.prepare('SELECT * FROM llm_profiles WHERE id = ?').bind(id).first<any>();
  if (!x) return null;
  return {
    id: x.id,
    name: x.name,
    base_url: x.base_url,
    api_key: x.api_key || '',
    model: x.model,
    kind: x.kind || 'vision',
    note: x.note || '',
  };
}

/** 只更新传进来的字段（undefined = 不动） */
async function saveProfile(
  env: Env,
  id: string,
  patch: { name?: string; base_url?: string; api_key?: string; model?: string; kind?: string; note?: string },
): Promise<void> {
  const cur = await getProfile(env, id);
  if (!cur) throw new HttpError(404, '模型源不存在');
  await env.DB.prepare(
    `UPDATE llm_profiles SET
      name = ?, base_url = ?, api_key = ?, model = ?, kind = ?, note = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      patch.name ?? cur.name,
      patch.base_url ?? cur.base_url,
      patch.api_key ?? cur.api_key,
      patch.model ?? cur.model,
      patch.kind ?? cur.kind,
      patch.note ?? cur.note,
      now(),
      id,
    )
    .run();
}

/** 老配置（settings 表里那一份）自动迁进模型源库，只迁一次 */
async function migrateLegacyProfile(env: Env, s: Settings): Promise<void> {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS c FROM llm_profiles').first<any>();
  if (Number(existing?.c || 0) > 0) return;
  if (!s.api_key) return;
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO llm_profiles (id, name, base_url, api_key, model, kind, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(id, '视觉模型（旧配置）', s.base_url, s.api_key, s.model || DEFAULT_MODEL, 'vision', '', now(), now())
    .run();
  await env.DB.prepare('UPDATE settings SET active_vision_profile = ? WHERE id = 1').bind(id).run();
}

interface ActiveConfig {
  base_url: string;
  api_key: string;
  model: string;
}

/** 取当前生效的配置：优先「当前启用的模型源」，其次老写法（settings 那几列） */
async function getActiveConfig(env: Env, useText: boolean, s?: Settings): Promise<ActiveConfig | null> {
  const st = s || (await getSettings(env));
  await migrateLegacyProfile(env, st);
  if (useText) {
    const p = await getProfile(env, st.active_text_profile);
    if (p && p.api_key && p.model) return { base_url: p.base_url, api_key: p.api_key, model: p.model };
    if (st.text_api_key && st.text_model) {
      return { base_url: st.text_base_url || st.base_url, api_key: st.text_api_key, model: st.text_model };
    }
    return null;
  }
  const p = await getProfile(env, st.active_vision_profile);
  if (p && p.api_key && p.model) return { base_url: p.base_url, api_key: p.api_key, model: p.model };
  if (st.api_key) return { base_url: st.base_url, api_key: st.api_key, model: st.model || DEFAULT_MODEL };
  return null;
}

/* -------------------------------------------------------------------- LLM */

interface LlmOptions {
  imageBase64?: string;
  imageType?: string;
  temperature?: number;
  maxTokens?: number;
  /** true = 走「文本 / 推理模型」槽位（出题、讲解这类不用看图的活） */
  text?: boolean;
  /** 测试连接时用的临时配置（表单里还没保存的值），非空字段覆盖数据库里的设置 */
  override?: { base?: string; key?: string; model?: string };
  /**
   * 思考强度：'fast' = 关思考/低思考（快 3~6 倍，批改一页约 15~30 秒）；
   * 'deep' = 用模型默认（思考链很长，一页常要 90~120 秒，容易撞网关超时）。
   * 默认 fast —— 小学数学批改不需要长链推理，慢还会超时失败。
   */
  thinking?: 'fast' | 'deep';
}

/**
 * 给不同厂商下发「少思考」参数。
 * 实测（1200x1600 作业图 / 17 题）：
 *   豆包 doubao-seed-2-1-lite 默认(思考) 119s → 关思考 18.7s
 *   智谱 glm-5.3-flash        默认(思考) 41s 且正文被思考链吃空 → reasoning_effort=low 30s
 * 各家参数名不一样，写错会被 400 拒绝，所以外面还有一层「400 就去掉参数重试」的兜底。
 */
function applyThinkingParam(body: any, base: string, mode: string): boolean {
  if (mode !== 'fast') return false;
  const b = (base || '').toLowerCase();
  if (b.includes('volces.com') || b.includes('volcengine')) {
    body.thinking = { type: 'disabled' };
    return true;
  }
  if (b.includes('bigmodel.cn') || b.includes('zhipu') || b.includes('z.ai')) {
    body.reasoning_effort = 'low';
    return true;
  }
  if (b.includes('dashscope') || b.includes('aliyuncs.com') || b.includes('bailian')) {
    body.enable_thinking = false;
    return true;
  }
  return false;
}

/**
 * 各家传图片的格式不统一：
 * - 多数（OpenAI 兼容默认）：data:image/jpeg;base64,xxxx
 * - 智谱 bigmodel.cn：只吃裸 base64，带 data: 前缀会报错
 * - 商汤 SenseNova：只吃公网 URL，不过本应用传的是本地图片，暂不支持
 */
function imageUrlFor(base: string, b64: string, mime?: string): string {
  const host = (base || '').toLowerCase();
  if (host.includes('bigmodel.cn') || host.includes('zhipu') || host.includes('z.ai')) {
    return b64;
  }
  return `data:${mime || 'image/jpeg'};base64,${b64}`;
}

/** 16x16 纯红 PNG，用于测试模型能否真的读图（很小，几乎不花钱） */
const TINY_RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4o6FBEmIY1TCqYfhqAAAyBCwQhvh37QAAAABJRU5ErkJggg==';

/**
 * 判断这个模型能不能读照片。只拦我们有把握的纯文本模型，拿不准的一律放行
 * （误拦会让正确配置也跑不起来，代价更大）。
 */
function canSeeImages(base: string, model: string): boolean {
  const m = (model || '').toLowerCase().trim();
  const b = (base || '').toLowerCase();
  if (/api\.deepseek\.com/.test(b) || m.includes('deepseek')) return false;
  if (/^glm-/.test(m)) {
    // 实测：glm-5.3-flash 能读图（2026-10 用 16x16 纯红图验证，答「红色」）；
    // glm-5.3 不行（接口直接报 content.type 只支持 text）。所以这里改成「黑名单」——
    // 只拦有把握的纯文本型号，其余一律放行，免得把能用的配置误拦掉。
    const textOnly = ['glm-5.3', 'glm-4-plus', 'glm-4-flash', 'glm-4-air', 'glm-4-airx', 'glm-4-long', 'glm-4-9b', 'glm-3-turbo'];
    if (textOnly.includes(m)) return false;
    return true;
  }
  if (/^qwen/.test(m)) return m.includes('vl');
  return true;
}

async function llm(
  env: Env,
  system: string,
  userText: string,
  opts: LlmOptions = {},
): Promise<string> {
  const s = await getSettings(env);
  // 文本槽位单独配了才启用，否则自动回落到视觉模型
  let cfg = await getActiveConfig(env, !!opts.text, s);
  if (!cfg) cfg = await getActiveConfig(env, false, s);
  if (!cfg) {
    throw new HttpError(400, '还没有配置大模型 API Key，请先到「设置」里添加模型源。');
  }
  let base = cfg.base_url;
  let key = cfg.api_key;
  let model = cfg.model || DEFAULT_MODEL;
  if (opts.override) {
    if (opts.override.base) base = opts.override.base;
    if (opts.override.key) key = opts.override.key;
    if (opts.override.model) model = opts.override.model;
  }

  if (!key) {
    throw new HttpError(400, '当前模型源没有填 API Key，请到「设置 → 模型源库」里补上。');
  }
  if (opts.imageBase64 && !canSeeImages(base, model)) {
    throw new HttpError(
      400,
      `当前模型源（${model}）看不了照片：这个槽位需要能读图的模型（名字里一般带 v / vision / vl）。请在「模型源库」里启用一个视觉模型源。`,
    );
  }

  const content: any[] = [];
  if (opts.imageBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: imageUrlFor(base, opts.imageBase64, opts.imageType) },
    });
  }
  content.push({ type: 'text', text: userText });

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4000,
  };
  const usedThinkingParam = applyThinkingParam(body, base, opts.thinking || 'fast');

  const url = joinUrl(base, 'chat/completions');
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150000),
    });
  } catch (e: any) {
    throw new HttpError(502, `调用大模型失败：${e?.message || e}`);
  }

  let raw = await resp.text();
  // 兜底：某些模型/网关不认我们的「少思考」参数，直接 400 拒绝。去掉参数重发一次。
  if (resp.status === 400 && usedThinkingParam) {
    delete body.thinking;
    delete body.reasoning_effort;
    delete body.enable_thinking;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(150000),
      });
      raw = await resp.text();
    } catch (e: any) {
      throw new HttpError(502, `调用大模型失败：${e?.message || e}`);
    }
  }
  if (!resp.ok) {
    if (resp.status === 524) {
      throw new HttpError(
        504,
        '大模型那边超时了（一页题太多/照片太大，思考链太长）。可以去「设置 → 速度」确认是「快速」，或者换一个更快的模型源后点「重新批改」。',
      );
    }
    throw new HttpError(502, `大模型接口返回 ${resp.status}：${raw.slice(0, 300)}`);
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(502, `大模型返回无法解析：${raw.slice(0, 200)}`);
  }
  const msg = data?.choices?.[0]?.message ?? {};
  // 注意坑：思考型模型在 max_tokens 被 reasoning 吃完时，content 是空字符串 "" 而不是 null，
  // 不能用 ?? 兜底（"" ?? x 不会触发），要用真值判断
  let text = '';
  if (typeof msg.content === 'string' && msg.content) {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    // 有的平台 content 是分块数组 [{type:'text',text:'...'}]
    text = msg.content
      .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (!text && typeof msg.reasoning_content === 'string') text = msg.reasoning_content;
  if (!text) throw new HttpError(502, `大模型没有返回内容：${raw.slice(0, 200)}`);
  return text;
}

/* --------------------------------------------------------------- mastery */

interface VariantRow {
  id: string;
  parent_id: string;
  seq: number;
  stem: string;
  answer: string;
  solution: string;
  difficulty: string;
  selected: number;
  status: string;
  student_answer: string | null;
  comment: string | null;
  attempt_image_key: string | null;
  done_at: string | null;
  created_at: string;
}

const PASS_RULE = 2; // 需要做对的变式题数量

function computeMastery(question: any, variants: VariantRow[]) {
  const baseWrong = Number(question.is_correct) === 0;
  const done = variants.filter((v) => v.status === 'correct' || v.status === 'wrong');
  const selected = variants.filter((v) => Number(v.selected) === 1);
  const correctCount = variants.filter((v) => v.status === 'correct').length;
  const wrongRows = variants
    .filter((v) => v.status === 'wrong')
    .sort((a, b) => String(a.done_at || '').localeCompare(String(b.done_at || '')));
  const lastWrongAt = wrongRows.length ? String(wrongRows[wrongRows.length - 1].done_at || '') : null;
  const correctAfterLastWrong = lastWrongAt
    ? variants.filter((v) => v.status === 'correct' && String(v.done_at || '') > lastWrongAt).length
    : correctCount;

  let passed: boolean;
  if (baseWrong) {
    passed = correctAfterLastWrong >= PASS_RULE;
  } else {
    passed = wrongRows.length === 0 ? true : correctAfterLastWrong >= PASS_RULE;
  }

  // 状态标签
  let label: string;
  let tone: 'pass' | 'wrong' | 'partial' | 'none';
  if (baseWrong) {
    if (passed) {
      label = '已过关（错题攻克）';
      tone = 'pass';
    } else {
      label = '待攻克';
      tone = 'wrong';
    }
  } else {
    if (passed && wrongRows.length === 0) {
      label = '已过关';
      tone = 'pass';
    } else if (passed) {
      label = '已过关（举一反三补做达标）';
      tone = 'pass';
    } else {
      label = '母题过关 · 举一反三未过关';
      tone = 'partial';
    }
  }

  return {
    base_wrong: baseWrong,
    passed,
    label,
    tone,
    need: PASS_RULE,
    variant_selected: selected.length,
    variant_done: done.length,
    variant_correct: correctCount,
    variant_wrong: wrongRows.length,
    correct_after_last_wrong: correctAfterLastWrong,
  };
}

async function questionWithMastery(env: Env, row: any) {
  const vs = await env.DB.prepare(
    'SELECT * FROM variants WHERE parent_id = ? ORDER BY seq ASC, created_at ASC',
  )
    .bind(row.id)
    .all<VariantRow>();
  const variants = vs.results || [];
  return { ...row, variants, mastery: computeMastery(row, variants) };
}

/* ------------------------------------------------------------------- auth */

function cookiePass(req: Request): string | null {
  const cookie = req.headers.get('Cookie') || '';
  const m = /(?:^|;\s*)mh_pass=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

async function requireAuth(req: Request, env: Env): Promise<Response | null> {
  const s = await getSettings(env);
  if (!s.passcode) return null;
  const provided = req.headers.get('X-Passcode') || cookiePass(req) || '';
  if (provided !== s.passcode) return json({ error: '需要家庭口令' }, 401);
  return null;
}

/* ------------------------------------------------------------------ router */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // 自定义域根路径直接进入应用
      if (path === '/' || path === '') {
        return Response.redirect(`${url.origin}/math/index.html`, 302);
      }
      // 静态资源入口重写
      if (path === '/math' || path === '/math/') {
        return Response.redirect(`${url.origin}/math/index.html`, 302);
      }

      if (path.startsWith('/math/api/')) {
        const apiPath = path.slice('/math/api'.length); // e.g. /questions/xxx
        const denied = await requireAuth(req, env);
        if (denied && !apiPath.startsWith('/unlock') && !apiPath.startsWith('/settings/need')) {
          return denied;
        }
        return await handleApi(req, env, apiPath, url);
      }

      if (path.startsWith('/math')) {
        return await env.ASSETS.fetch(req);
      }

      return new Response('Not found', { status: 404 });
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      const msg = e?.message || '服务器内部错误';
      return json({ error: msg }, status);
    }
  },
};

/* ------------------------------------------------- 教材大纲辅助函数 */

async function textbookTree(env: Env, textbookId?: string): Promise<any[]> {
  let sql = 'SELECT * FROM units';
  const binds: any[] = [];
  if (textbookId) {
    sql += ' WHERE textbook_id = ?';
    binds.push(textbookId);
  }
  sql += ' ORDER BY sort, name';
  const us = await env.DB.prepare(sql).bind(...binds).all<any>();
  const ls = await env.DB.prepare('SELECT * FROM lessons ORDER BY sort, name').all<any>();
  const units = us.results || [];
  const lessons = ls.results || [];
  return units.map((u) => ({
    id: u.id,
    name: u.name,
    is_custom: !!Number(u.is_custom),
    lessons: lessons
      .filter((l) => l.unit_id === u.id)
      .map((l) => ({ id: l.id, name: l.name, is_custom: !!Number(l.is_custom) })),
  }));
}

/** 当前默认教材（第一本），找不到返回 null */
async function defaultTextbookId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare('SELECT id FROM textbooks ORDER BY sort, name LIMIT 1').first<any>();
  return row ? row.id : null;
}

/** 没有归属单元的自定义课文，统一塞进「自定义」单元（没有就建一个） */
async function ensureCustomUnit(env: Env, textbookId?: string): Promise<string> {
  const tbId = textbookId || (await defaultTextbookId(env)) || '';
  const row = await env.DB.prepare(
    "SELECT id FROM units WHERE name = '自定义' AND is_custom = 1 AND COALESCE(textbook_id,'') = ?",
  )
    .bind(tbId)
    .first<any>();
  if (row) return row.id;
  const id = 'cu' + uuid();
  const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM units WHERE textbook_id = ?')
    .bind(tbId)
    .first<any>();
  await env.DB.prepare(
    'INSERT INTO units (id, textbook_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,1,?)',
  )
    .bind(id, tbId, '自定义', Number(mx?.m || 0) + 1, now())
    .run();
  return id;
}

/** 删除一份作业：级联删变式题、题目，并清掉 R2 上的图片 */
async function deleteSubmission(env: Env, id: string): Promise<void> {
  const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<any>();
  if (!sub) return;
  const qs = await env.DB.prepare('SELECT id, answer_image_key FROM questions WHERE submission_id = ?')
    .bind(id)
    .all<any>();
  const ids = (qs.results || []).map((r) => r.id);
  const keys: string[] = [sub.image_key].filter(Boolean);
  (qs.results || []).forEach((r) => {
    if (r.answer_image_key) keys.push(r.answer_image_key);
  });
  if (ids.length) {
    const vs = await env.DB.prepare(
      `SELECT attempt_image_key FROM variants WHERE parent_id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(...ids)
      .all<any>();
    (vs.results || []).forEach((r) => {
      if (r.attempt_image_key) keys.push(r.attempt_image_key);
    });
    await env.DB.prepare(
      `DELETE FROM variants WHERE parent_id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(...ids)
      .run();
    await env.DB.prepare('DELETE FROM questions WHERE submission_id = ?').bind(id).run();
  }
  await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
  await Promise.all(keys.map((k) => env.IMAGES.delete(k).catch(() => {})));
}

/** 批改一份作业：读图 → 让模型逐题识别/判对错/写错因 → 落库。失败由调用方统一标 error。 */
async function gradeHomework(env: Env, id: string): Promise<Response> {
  const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<any>();
  if (!sub) throw new HttpError(404, '提交不存在');
  if (sub.status === 'grading' && sub.error_msg) {
    // 上一次失败后重试：清掉旧标记
    await env.DB.prepare('UPDATE submissions SET error_msg = NULL WHERE id = ?').bind(id).run();
  }
  const obj = await env.IMAGES.get(sub.image_key);
  if (!obj) throw new HttpError(404, '图片不存在（可能没上传成功），请重新拍照上传。');
  const buf = await obj.arrayBuffer();
  if (buf.byteLength > 9 * 1024 * 1024) {
    throw new HttpError(413, '这张照片太大了，大模型不接受。请截图或压缩后再传。');
  }
  const b64 = toBase64(buf);
  const s = await getSettings(env);

  const text = await llm(env, gradeSystemPrompt(s.grade), gradeUserPrompt(s.grade), {
    imageBase64: b64,
    imageType: contentTypeOf(sub.image_key),
    temperature: 0.1,
    maxTokens: 4000,
    thinking: (s.thinking_mode as any) || 'fast',
  });

  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch {
    throw new HttpError(502, `大模型没有返回可解析的内容（可能是题目太小/图片太糊）。原始回复：${text.slice(0, 160)}`);
  }
  const list: any[] = Array.isArray(parsed?.questions) ? parsed.questions : [];
  if (!list.length) throw new HttpError(502, '没能从照片里识别出题目，换一张更清楚的再试一次。');

  // 模型经常把 answer_band 给成像素坐标（几百上千）而不是约定的 0-100 百分比。
  // 取全场最大值做个等比归一，至少保证「相对上下位置」是对的，前端裁剪才不会跑偏。
  let bandScale = 1;
  for (const q of list) {
    const b = Array.isArray(q.answer_band) ? q.answer_band : null;
    if (!b) continue;
    for (const v of b) if (typeof v === 'number' && v > bandScale) bandScale = v;
  }
  bandScale = bandScale > 100 ? bandScale / 100 : 1;

  // 重新批改时先清掉上一轮的题，避免重复
  await env.DB.prepare('DELETE FROM questions WHERE submission_id = ?').bind(id).run();

  const created: any[] = [];
  let seq = 0;
  for (const q of list) {
    seq += 1;
    const qid = uuid();
    let band: number[] | null = null;
    if (Array.isArray(q.answer_band) && q.answer_band.length >= 2) {
      const a = Number(q.answer_band[0]) / bandScale;
      const b2 = Number(q.answer_band[1]) / bandScale;
      if (Number.isFinite(a) && Number.isFinite(b2) && b2 > a) {
        band = [Math.max(0, Math.min(100, Math.round(a))), Math.max(0, Math.min(100, Math.round(b2)))];
      }
    }
    await env.DB.prepare(
      `INSERT INTO questions
       (id, submission_id, seq, no, stem, student_answer, correct_answer, is_correct,
        error_reason, solution, knowledge, answer_band, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        qid,
        id,
        seq,
        String(q.no ?? seq),
        String(q.stem ?? ''),
        String(q.student_answer ?? ''),
        String(q.correct_answer ?? ''),
        q.is_correct ? 1 : 0,
        String(q.error_reason ?? ''),
        String(q.solution ?? ''),
        String(q.knowledge ?? ''),
        band ? JSON.stringify(band) : null,
        now(),
      )
      .run();
    created.push({ id: qid, seq, band });
  }
  await env.DB.prepare("UPDATE submissions SET status = 'graded', error_msg = NULL WHERE id = ?").bind(id).run();
  return json({ submission_id: id, questions: created });
}

async function handleApi(
  req: Request,
  env: Env,
  p: string,
  url: URL,
): Promise<Response> {
  const method = req.method.toUpperCase();

  /* ---------------------------------------------------------- settings */
  if (p === '/settings' && method === 'GET') {
    const s = await getSettings(env);
    await migrateLegacyProfile(env, s);
    const st2 = await getSettings(env);
    const profiles = (await listProfiles(env)).map((x) => ({
      id: x.id,
      name: x.name,
      base_url: x.base_url,
      model: x.model,
      kind: x.kind,
      note: x.note,
      api_key_set: !!x.api_key,
    }));
    return json({
      settings: {
        ...st2,
        api_key_set: !!st2.api_key,
        api_key: st2.api_key ? '******' : '',
        text_api_key_set: !!st2.text_api_key,
        text_api_key: st2.text_api_key ? '******' : '',
      },
      profiles,
    });
  }

  if (p === '/settings' && method === 'POST') {
    const body = await req.json<any>();
    const s0 = await getSettings(env);
    // 视觉 / 文本槽位的表单：如果当前有启用的模型源，就改那条源（而不是覆盖旧列），这样源库里的配置不会互相覆盖
    if (body.base_url !== undefined || body.model !== undefined || body.api_key !== undefined) {
      const p = await getProfile(env, s0.active_vision_profile);
      if (p) await saveProfile(env, p.id, { base_url: body.base_url, api_key: body.api_key, model: body.model });
    }
    if (body.text_base_url !== undefined || body.text_model !== undefined || body.text_api_key !== undefined) {
      const p = await getProfile(env, s0.active_text_profile);
      if (p) await saveProfile(env, p.id, { base_url: body.text_base_url, api_key: body.text_api_key, model: body.text_model });
    }
    await env.DB.prepare(
      `UPDATE settings SET
        base_url = COALESCE(?, base_url),
        api_key = COALESCE(?, api_key),
        model = COALESCE(?, model),
        text_base_url = COALESCE(?, text_base_url),
        text_api_key = COALESCE(?, text_api_key),
        text_model = COALESCE(?, text_model),
        grade = COALESCE(?, grade),
        student_name = COALESCE(?, student_name),
        passcode = COALESCE(?, passcode),
        thinking_mode = COALESCE(?, thinking_mode),
        updated_at = ?
       WHERE id = 1`,
    )
      .bind(
        body.base_url ?? null,
        body.api_key ?? null,
        body.model ?? null,
        body.text_base_url !== undefined ? body.text_base_url : null,
        body.text_api_key !== undefined ? body.text_api_key : null,
        body.text_model !== undefined ? body.text_model : null,
        body.grade ?? null,
        body.student_name ?? null,
        body.passcode ?? null,
        body.thinking_mode ?? null,
        now(),
      )
      .run();
    const s = await getSettings(env);
    return json({ ok: true, settings: { ...s, api_key: s.api_key ? '******' : '' } });
  }

  /* -------------------------------------------------------- 模型源库 CRUD */
  if (p === '/profiles' && method === 'GET') {
    const list = (await listProfiles(env)).map((x) => ({
      id: x.id,
      name: x.name,
      base_url: x.base_url,
      model: x.model,
      kind: x.kind,
      note: x.note,
      api_key_set: !!x.api_key,
    }));
    return json({ profiles: list });
  }

  if (p === '/profiles' && method === 'POST') {
    const body = await req.json<any>();
    if (!body?.base_url || !body?.model) throw new HttpError(400, '接口地址和模型名必填');
    const id = body.id || uuid();
    // 更新已有源时 Key 留空 = 不覆盖旧 Key
    if (body.id && !body.api_key) {
      const old = await getProfile(env, body.id);
      if (old) body.api_key = old.api_key;
    }
    await env.DB.prepare(
      `INSERT INTO llm_profiles (id, name, base_url, api_key, model, kind, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key,
         model = excluded.model, kind = excluded.kind, note = excluded.note, updated_at = excluded.updated_at`,
    )
      .bind(
        id,
        body.name || '未命名模型源',
        body.base_url,
        body.api_key || '',
        body.model,
        body.kind || 'vision',
        body.note || '',
        now(),
        now(),
      )
      .run();
    const s = await getSettings(env);
    // 还没有任何启用的源时，新建的源自动启用到对应槽位
    if (body.kind === 'text') {
      if (!s.active_text_profile) {
        await env.DB.prepare('UPDATE settings SET active_text_profile = ? WHERE id = 1').bind(id).run();
      }
    } else if (!s.active_vision_profile) {
      await env.DB.prepare('UPDATE settings SET active_vision_profile = ? WHERE id = 1').bind(id).run();
    }
    return json({ ok: true, id });
  }

  const pm = /^\/profiles\/([^/]+)(\/(activate|test))?$/.exec(p);
  if (pm && method === 'POST') {
    const id = pm[1];
    const action = pm[3];
    if (action === 'activate') {
      const body = await req.json<any>().catch(() => ({}) as any);
      const kind = body.kind === 'text' ? 'text' : 'vision';
      const prof = await getProfile(env, id);
      if (!prof) throw new HttpError(404, '模型源不存在');
      const col = kind === 'text' ? 'active_text_profile' : 'active_vision_profile';
      await env.DB.prepare(`UPDATE settings SET ${col} = ? WHERE id = 1`).bind(id).run();
      return json({ ok: true, kind, id });
    }
    if (action === 'test') {
      const prof = await getProfile(env, id);
      if (!prof) throw new HttpError(404, '模型源不存在');
      if (!prof.api_key) throw new HttpError(400, `「${prof.name}」还没有填 API Key，请点「编辑」补上。`);
      const override = { base: prof.base_url, key: prof.api_key, model: prof.model };
      const t0 = Date.now();
      const text = await llm(env, '你是一个测试助手。', '请只回复两个字：正常', {
        maxTokens: 1024,
        override,
      });
      // 视觉源再补一次「真读图」自检：文字通 ≠ 能读图（有些套餐/模型屏蔽图片输入）
      let vision: any = null;
      if (prof.kind !== 'text') {
        try {
          const v = await llm(env, '你是图片描述助手。', '这张图是什么颜色？只回答颜色词，两个字以内。', {
            maxTokens: 1024,
            override,
            imageBase64: TINY_RED_PNG,
            imageType: 'image/png',
          });
          vision = { ok: true, reply: v.slice(0, 20) };
        } catch (e: any) {
          vision = { ok: false, error: String(e?.message || e).slice(0, 200) };
        }
      }
      return json({ ok: true, reply: text.slice(0, 50), ms: Date.now() - t0, vision });
    }
    // 改某一条源
    const body = await req.json<any>();
    await saveProfile(env, id, {
      name: body.name,
      base_url: body.base_url,
      api_key: body.api_key,
      model: body.model,
      kind: body.kind,
      note: body.note,
    });
    return json({ ok: true, id });
  }

  if (pm && !pm[2] && method === 'DELETE') {
    const id = pm[1];
    const s = await getSettings(env);
    await env.DB.prepare('DELETE FROM llm_profiles WHERE id = ?').bind(id).run();
    if (s.active_vision_profile === id) {
      await env.DB.prepare("UPDATE settings SET active_vision_profile = '' WHERE id = 1").run();
    }
    if (s.active_text_profile === id) {
      await env.DB.prepare("UPDATE settings SET active_text_profile = '' WHERE id = 1").run();
    }
    return json({ ok: true });
  }

  if (p === '/unlock' && method === 'POST') {
    const body = await req.json<any>();
    const s = await getSettings(env);
    if (!s.passcode || body.passcode === s.passcode) {
      return json(
        { ok: true },
        200,
        { 'Set-Cookie': `mh_pass=${encodeURIComponent(body.passcode || '')}; Path=/; Max-Age=31536000; SameSite=Lax` },
      );
    }
    return json({ error: '口令不对' }, 401);
  }

  if (p === '/settings/need' && method === 'GET') {
    const s = await getSettings(env);
    return json({ need_passcode: !!s.passcode, configured: !!s.api_key });
  }

  const testModel = async (useText: boolean) => {
    // 支持用表单里「还没保存」的值直接测试：body 里带 base_url/api_key/model，留空的字段回落到已保存配置
    const body = await req.json<any>().catch(() => ({}) as any);
    const override =
      body && (body.base_url || body.api_key || body.model)
        ? {
            base: (body.base_url || '').trim() || undefined,
            key: (body.api_key || '').trim() || undefined,
            model: (body.model || '').trim() || undefined,
          }
        : undefined;
    const t0 = Date.now();
    // maxTokens 不能太小：思考型模型（智谱 GLM 等）会先输出 reasoning，额度太小会被截断、正文为空
    const text = await llm(env, '你是一个测试助手。', '请只回复两个字：正常', {
      maxTokens: 1024,
      text: useText,
      override,
    });
    return json({ ok: true, reply: text.slice(0, 50), ms: Date.now() - t0 });
  };
  if (p === '/test-model' && method === 'POST') return await testModel(false);
  if (p === '/test-text-model' && method === 'POST') return await testModel(true);

  /* ------------------------------------------------------- 作业提交 */
  // 上传作业照片
  if (p === '/homework/upload' && method === 'POST') {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) throw new HttpError(400, '没有收到图片');
    const ext = extOf(file.name);
    if (ext === 'heic' || ext === 'heif') {
      throw new HttpError(
        400,
        'HEIC 格式的照片大模型读不了。请在 iPhone「设置 → 相机 → 格式」里改成「兼容性最佳」（以后拍照就是 JPG），或者把照片截图后再上传。',
      );
    }
    if (file.size > 10 * 1024 * 1024) throw new HttpError(400, '图片太大了（超过 10MB），请压缩或截图后再传。');
    const lessonRaw = form.get('lesson_id');
    const lessonId = lessonRaw ? String(lessonRaw) : null;
    if (lessonId) {
      const ok = await env.DB.prepare('SELECT id FROM lessons WHERE id = ?').bind(lessonId).first<any>();
      if (!ok) throw new HttpError(400, '所选课文不存在');
    }
    const id = uuid();
    const key = `orig/${id}.${ext}`;
    const buf = await file.arrayBuffer();
    await env.IMAGES.put(key, buf, { httpMetadata: { contentType: contentTypeOf(key) } });
    await env.DB.prepare(
      "INSERT INTO submissions (id, kind, lesson_id, image_key, status, created_at) VALUES (?, 'homework', ?, ?, 'grading', ?)",
    )
      .bind(id, lessonId, key, now())
      .run();
    return json({ id, image_key: key });
  }

  // 批改（OCR + 判对错 + 分析）
  if (p.startsWith('/homework/') && p.endsWith('/grade') && method === 'POST') {
    const id = p.slice('/homework/'.length, -'/grade'.length);
    // 失败时把状态标成 error（否则界面上会永远停在「老师正在批改…」）
    try {
      return await gradeHomework(env, id);
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      await env.DB.prepare("UPDATE submissions SET status = 'error', error_msg = ? WHERE id = ?")
        .bind(msg, id)
        .run()
        .catch(() => {});
      throw e;
    }
  }

  // 上传某题答案裁剪图
  if (p.startsWith('/questions/') && p.endsWith('/answer-image') && method === 'POST') {
    const parts = p.split('/'); // ['', 'questions', id, 'answer-image']
    const qid = parts[2];
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) throw new HttpError(400, '没有收到图片');
    const key = `ans/${qid}.${extOf(file.name)}`;
    await env.IMAGES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: contentTypeOf(key) },
    });
    await env.DB.prepare('UPDATE questions SET answer_image_key = ? WHERE id = ?').bind(key, qid).run();
    return json({ ok: true, answer_image_key: key });
  }

  /* --------------------------------------------------------- 题目读写 */
  if (p === '/questions' && method === 'GET') {
    const filter = url.searchParams.get('filter'); // all | wrong | unpassed
    let sql =
      `SELECT q.*, s.created_at AS sub_created_at, s.image_key AS sub_image_key
       FROM questions q LEFT JOIN submissions s ON s.id = q.submission_id
       ORDER BY s.created_at DESC, q.seq ASC`;
    const rows = await env.DB.prepare(sql).all<any>();
    const all = rows.results || [];
    const withMastery = await Promise.all(all.map((r) => questionWithMastery(env, r)));
    const filtered = withMastery.filter((q) => {
      if (filter === 'wrong') return q.mastery.base_wrong;
      if (filter === 'unpassed') return !q.mastery.passed;
      return true;
    });
    return json({ questions: filtered });
  }

  if (p === '/submissions' && method === 'GET') {
    const lessonId = (url.searchParams.get('lesson') || '').trim();
    const unitId = (url.searchParams.get('unit') || '').trim();
    const tbId = (url.searchParams.get('textbook') || '').trim();
    let sql = `SELECT s.*, l.name AS lesson_name, l.unit_id AS unit_id,
        u.name AS unit_name, u.textbook_id AS textbook_id, t.name AS textbook_name
       FROM submissions s
       LEFT JOIN lessons l ON l.id = s.lesson_id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN textbooks t ON t.id = u.textbook_id
       WHERE s.kind='homework'`;
    const binds: any[] = [];
    if (lessonId === '__none') {
      // 只看「没归类」的作业
      sql += ' AND s.lesson_id IS NULL';
    } else if (lessonId) {
      sql += ' AND s.lesson_id = ?';
      binds.push(lessonId);
    } else if (unitId) {
      sql += ' AND l.unit_id = ?';
      binds.push(unitId);
    } else if (tbId) {
      // 关键：未归类的作业 lesson_id 是 NULL，LEFT JOIN 后 u.textbook_id 也是 NULL，
      // 只写 u.textbook_id = ? 会把它们全过滤掉，用户会以为作业丢了。
      // 按教材筛选时应当同时带上未归类的。
      sql += ' AND (u.textbook_id = ? OR s.lesson_id IS NULL)';
      binds.push(tbId);
    }
    sql += ' ORDER BY s.created_at DESC LIMIT 200';
    const rows = await env.DB.prepare(sql).bind(...binds).all<any>();
    const subs = rows.results || [];
    const out = [];
    for (const s of subs) {
      const qs = await env.DB.prepare('SELECT * FROM questions WHERE submission_id = ? ORDER BY seq ASC')
        .bind(s.id)
        .all<any>();
      const list = qs.results || [];
      let passed = 0;
      for (const q of list) {
        const vs = await env.DB.prepare('SELECT * FROM variants WHERE parent_id = ?').bind(q.id).all<VariantRow>();
        const m = computeMastery(q, vs.results || []);
        if (m.passed) passed += 1;
      }
      out.push({
        ...s,
        total: list.length,
        wrong: list.filter((q) => Number(q.is_correct) === 0).length,
        passed,
      });
    }
    return json({ submissions: out });
  }

  const subMatch = /^\/submissions\/([a-z0-9]+)$/.exec(p);
  if (subMatch && method === 'GET') {
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(subMatch[1]).first<any>();
    if (!sub) throw new HttpError(404, '提交不存在');
    const qs = await env.DB.prepare('SELECT * FROM questions WHERE submission_id = ? ORDER BY seq ASC')
      .bind(sub.id)
      .all<any>();
    const list = qs.results || [];
    const questions = await Promise.all(list.map((r) => questionWithMastery(env, r)));
    return json({ submission: sub, questions });
  }

  const qMatch = /^\/questions\/([a-z0-9]+)$/.exec(p);
  if (qMatch && method === 'GET') {
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(qMatch[1]).first<any>();
    if (!q) throw new HttpError(404, '题目不存在');
    return json({ question: await questionWithMastery(env, q) });
  }

  // 手动改判母题（对错 / 内容）
  if (qMatch && method === 'PATCH') {
    const body = await req.json<any>();
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(qMatch[1]).first<any>();
    if (!q) throw new HttpError(404, '题目不存在');
    await env.DB.prepare(
      `UPDATE questions SET
        is_correct = COALESCE(?, is_correct),
        stem = COALESCE(?, stem),
        student_answer = COALESCE(?, student_answer),
        correct_answer = COALESCE(?, correct_answer),
        error_reason = COALESCE(?, error_reason),
        solution = COALESCE(?, solution),
        knowledge = COALESCE(?, knowledge)
       WHERE id = ?`,
    )
      .bind(
        body.is_correct === undefined ? null : body.is_correct ? 1 : 0,
        body.stem ?? null,
        body.student_answer ?? null,
        body.correct_answer ?? null,
        body.error_reason ?? null,
        body.solution ?? null,
        body.knowledge ?? null,
        qMatch[1],
      )
      .run();
    const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(qMatch[1]).first<any>();
    return json({ question: await questionWithMastery(env, updated) });
  }

  if (qMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM variants WHERE parent_id = ?').bind(qMatch[1]).run();
    await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(qMatch[1]).run();
    return json({ ok: true });
  }

  /* ------------------------------------------------------- 举一反三 */
  // 生成
  if (/^\/questions\/([a-z0-9]+)\/variants\/generate$/.test(p) && method === 'POST') {
    const m = /^\/questions\/([a-z0-9]+)\/variants\/generate$/.exec(p)!;
    const parentId = m[1];
    const body = await req.json<any>().catch(() => ({}));
    const count = Math.min(Math.max(Number(body.count) || 6, 1), 12);
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(parentId).first<any>();
    if (!q) throw new HttpError(404, '题目不存在');
    const s = await getSettings(env);

    const text = await llm(
      env,
      variantsSystemPrompt(s.grade),
      variantsUserPrompt(
        q.stem,
        q.correct_answer,
        q.knowledge,
        Number(q.is_correct) === 0,
        q.error_reason,
        count,
      ),
      { temperature: 0.8, maxTokens: 3000, text: true, thinking: (s.thinking_mode as any) || 'fast' },
    );
    let parsed: any;
    try {
      parsed = extractJson(text);
    } catch {
      throw new HttpError(502, `没能生成出题目：${text.slice(0, 200)}`);
    }
    const list: any[] = Array.isArray(parsed?.variants) ? parsed.variants : [];
    if (!list.length) throw new HttpError(502, '没有生成出举一反三的题目，请再试一次。');

    const prev = await env.DB.prepare('SELECT COUNT(*) AS c FROM variants WHERE parent_id = ?')
      .bind(parentId)
      .first<any>();
    let seq = Number(prev?.c || 0);
    const created: VariantRow[] = [];
    for (const v of list) {
      seq += 1;
      const id = uuid();
      await env.DB.prepare(
        `INSERT INTO variants (id, parent_id, seq, stem, answer, solution, difficulty, selected, status, created_at)
         VALUES (?,?,?,?,?,?,?,0,'pending',?)`,
      )
        .bind(
          id,
          parentId,
          seq,
          String(v.stem ?? ''),
          String(v.answer ?? ''),
          String(v.solution ?? ''),
          String(v.difficulty ?? '同等'),
          now(),
        )
        .run();
      created.push({
        id,
        parent_id: parentId,
        seq,
        stem: String(v.stem ?? ''),
        answer: String(v.answer ?? ''),
        solution: String(v.solution ?? ''),
        difficulty: String(v.difficulty ?? '同等'),
        selected: 0,
        status: 'pending',
        student_answer: null,
        comment: null,
        attempt_image_key: null,
        done_at: null,
        created_at: now(),
      });
    }
    return json({ variants: created });
  }

  // 选择/取消选择
  if (p === '/variants/select' && method === 'POST') {
    const body = await req.json<any>();
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    const parentId = body.parent_id;
    if (parentId) {
      await env.DB.prepare('UPDATE variants SET selected = 0 WHERE parent_id = ?').bind(parentId).run();
    }
    for (const id of ids) {
      await env.DB.prepare('UPDATE variants SET selected = 1 WHERE id = ?').bind(id).run();
    }
    return json({ ok: true });
  }

  // 手动改判变式题
  const vMatch = /^\/variants\/([a-z0-9]+)$/.exec(p);
  if (vMatch && method === 'PATCH') {
    const body = await req.json<any>();
    const v = await env.DB.prepare('SELECT * FROM variants WHERE id = ?').bind(vMatch[1]).first<any>();
    if (!v) throw new HttpError(404, '题目不存在');
    const status = body.status ?? v.status;
    await env.DB.prepare(
      `UPDATE variants SET status = ?, student_answer = COALESCE(?, student_answer),
       comment = COALESCE(?, comment), done_at = ? WHERE id = ?`,
    )
      .bind(
        status,
        body.student_answer ?? null,
        body.comment ?? null,
        status === 'pending' ? null : v.done_at || now(),
        vMatch[1],
      )
      .run();
    return json({ ok: true });
  }

  if (vMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM variants WHERE id = ?').bind(vMatch[1]).run();
    return json({ ok: true });
  }

  // 上传举一反三答案照片并批改
  if (/^\/questions\/([a-z0-9]+)\/variant-answer$/.test(p) && method === 'POST') {
    const m = /^\/questions\/([a-z0-9]+)\/variant-answer$/.exec(p)!;
    const parentId = m[1];
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(parentId).first<any>();
    if (!q) throw new HttpError(404, '母题不存在');
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) throw new HttpError(400, '没有收到图片');

    const vs = await env.DB.prepare(
      'SELECT * FROM variants WHERE parent_id = ? ORDER BY seq ASC',
    )
      .bind(parentId)
      .all<VariantRow>();
    const all = vs.results || [];
    const candidates = all.filter((v) => Number(v.selected) === 1 || v.status === 'pending');
    const pool = candidates.length ? candidates : all;
    if (!pool.length) throw new HttpError(400, '这道母题还没有举一反三的题目，先生成几道吧。');

    const subId = uuid();
    const key = `vans/${subId}.${extOf(file.name)}`;
    const buf = await file.arrayBuffer();
    await env.IMAGES.put(key, buf, { httpMetadata: { contentType: contentTypeOf(key) } });

    const s = await getSettings(env);
    const text = await llm(
      env,
      variantGradeSystemPrompt(s.grade),
      variantGradeUserPrompt(
        pool.map((v) => ({ id: v.id, label: `${v.seq}`, stem: v.stem })),
      ),
      {
        imageBase64: toBase64(buf),
        imageType: contentTypeOf(key),
        temperature: 0.1,
        maxTokens: 3000,
        thinking: (s.thinking_mode as any) || 'fast',
      },
    );

    let parsed: any;
    try {
      parsed = extractJson(text);
    } catch {
      throw new HttpError(502, `没能识别答案：${text.slice(0, 200)}`);
    }
    const results: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
    const graded: any[] = [];
    for (const r of results) {
      const vid = String(r.variant_id || '');
      const target = pool.find((v) => v.id === vid);
      if (!target) continue;
      const ok = !!r.is_correct;
      await env.DB.prepare(
        `UPDATE variants SET status = ?, student_answer = ?, comment = ?, attempt_image_key = ?, done_at = ?, selected = 1 WHERE id = ?`,
      )
        .bind(ok ? 'correct' : 'wrong', String(r.student_answer ?? ''), String(r.comment ?? ''), key, now(), target.id)
        .run();
      graded.push({ ...target, status: ok ? 'correct' : 'wrong', student_answer: String(r.student_answer ?? ''), comment: String(r.comment ?? ''), attempt_image_key: key });
    }
    if (!graded.length) {
      throw new HttpError(502, '照片里没有匹配到这道题的举一反三作答，可以拍得更清楚一点，或在下方手动标记。');
    }

    await env.DB.prepare(
      "INSERT INTO submissions (id, kind, parent_id, image_key, status, created_at) VALUES (?, 'variant', ?, ?, 'graded', ?)",
    )
      .bind(subId, parentId, key, now())
      .run();

    const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(parentId).first<any>();
    return json({ question: await questionWithMastery(env, updated), graded });
  }

  /* ------------------------------------------------------------ 图片 */
  if (p === '/img' && method === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!key) throw new HttpError(400, '缺少 key');
    const obj = await env.IMAGES.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, {
      headers: {
        'Content-Type': contentTypeOf(key),
        'Cache-Control': 'public, max-age=31536000',
      },
    });
  }

  /* ------------------------------------------------- 教材大纲（教材 / 单元 / 课文） */
  if (p === '/textbooks' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM textbooks ORDER BY sort, name').all<any>();
    const list = rows.results || [];
    const withCount = await Promise.all(
      list.map(async (t) => {
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM units WHERE textbook_id = ?')
          .bind(t.id)
          .first<any>();
        return { id: t.id, name: t.name, is_custom: !!Number(t.is_custom), units: Number(c?.n || 0) };
      }),
    );
    return json({ textbooks: withCount });
  }

  if (p === '/textbooks' && method === 'POST') {
    const body = await req.json<any>();
    const name = String(body?.name || '').trim();
    if (!name) throw new HttpError(400, '教材名称不能为空');
    const id = 'ct' + uuid();
    const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM textbooks').first<any>();
    await env.DB.prepare('INSERT INTO textbooks (id, name, sort, is_custom, created_at) VALUES (?,?,?,1,?)')
      .bind(id, name, Number(mx?.m || 0) + 1, now())
      .run();
    return json({ ok: true, id });
  }

  if (p === '/textbook' && method === 'GET') {
    const tb = url.searchParams.get('textbook');
    return json({ units: await textbookTree(env, tb || undefined) });
  }

  if (p === '/units' && method === 'POST') {
    const body = await req.json<any>();
    const name = String(body?.name || '').trim();
    if (!name) throw new HttpError(400, '单元名称不能为空');
    const tbId = String(body?.textbook_id || (await defaultTextbookId(env)) || '');
    const id = 'cu' + uuid();
    const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM units WHERE textbook_id = ?')
      .bind(tbId)
      .first<any>();
    await env.DB.prepare(
      'INSERT INTO units (id, textbook_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,1,?)',
    )
      .bind(id, tbId, name, Number(mx?.m || 0) + 1, now())
      .run();
    return json({ ok: true, id, textbook_id: tbId });
  }

  if (p === '/lessons' && method === 'POST') {
    const body = await req.json<any>();
    const name = String(body?.name || '').trim();
    if (!name) throw new HttpError(400, '课文名称不能为空');
    let unitId = String(body?.unit_id || '').trim();
    if (!unitId) {
      // 没选单元就放进「自定义」这个自建单元
      unitId = await ensureCustomUnit(env, String(body?.textbook_id || '') || undefined);
    }
    const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM lessons WHERE unit_id = ?')
      .bind(unitId)
      .first<any>();
    const id = 'cl' + uuid();
    await env.DB.prepare('INSERT INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,1,?)')
      .bind(id, unitId, name, Number(mx?.m || 0) + 1, now())
      .run();
    return json({ ok: true, id, unit_id: unitId });
  }

  const unitMatch = /^\/units\/([A-Za-z0-9_]+)$/.exec(p);
  if (unitMatch && method === 'DELETE') {
    const row = await env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(unitMatch[1]).first<any>();
    if (!row) throw new HttpError(404, '单元不存在');
    if (!Number(row.is_custom)) throw new HttpError(400, '教材自带的单元不能删除。');
    await env.DB.prepare('UPDATE submissions SET lesson_id = NULL WHERE lesson_id IN (SELECT id FROM lessons WHERE unit_id = ?)')
      .bind(row.id)
      .run();
    await env.DB.prepare('DELETE FROM lessons WHERE unit_id = ?').bind(row.id).run();
    await env.DB.prepare('DELETE FROM units WHERE id = ?').bind(row.id).run();
    return json({ ok: true });
  }

  const lessonMatch = /^\/lessons\/([A-Za-z0-9_]+)$/.exec(p);
  if (lessonMatch && method === 'DELETE') {
    const row = await env.DB.prepare('SELECT * FROM lessons WHERE id = ?').bind(lessonMatch[1]).first<any>();
    if (!row) throw new HttpError(404, '课文不存在');
    if (!Number(row.is_custom)) throw new HttpError(400, '教材自带的课文不能删除。');
    await env.DB.prepare('UPDATE submissions SET lesson_id = NULL WHERE lesson_id = ?').bind(row.id).run();
    await env.DB.prepare('DELETE FROM lessons WHERE id = ?').bind(row.id).run();
    return json({ ok: true });
  }

  if (lessonMatch && method === 'PATCH') {
    const body = await req.json<any>();
    const row = await env.DB.prepare('SELECT * FROM lessons WHERE id = ?').bind(lessonMatch[1]).first<any>();
    if (!row) throw new HttpError(404, '课文不存在');
    await env.DB.prepare('UPDATE lessons SET name = ?, unit_id = ? WHERE id = ?')
      .bind(String(body?.name ?? row.name).trim() || row.name, String(body?.unit_id ?? row.unit_id), row.id)
      .run();
    return json({ ok: true });
  }

  /* ------------------------------------------------- 作业删除 / 归类 */
  if (p === '/submissions/batch-delete' && method === 'POST') {
    const body = await req.json<any>();
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
    if (!ids.length) throw new HttpError(400, '没有选中任何作业');
    for (const sid of ids) await deleteSubmission(env, String(sid));
    return json({ ok: true, deleted: ids.length });
  }

  if (subMatch && method === 'DELETE') {
    await deleteSubmission(env, subMatch[1]);
    return json({ ok: true });
  }

  if (subMatch && method === 'PATCH') {
    const body = await req.json<any>();
    const lessonId = body?.lesson_id === undefined ? undefined : body.lesson_id ? String(body.lesson_id) : null;
    if (lessonId === undefined) throw new HttpError(400, '缺少 lesson_id');
    await env.DB.prepare('UPDATE submissions SET lesson_id = ? WHERE id = ?').bind(lessonId, subMatch[1]).run();
    return json({ ok: true });
  }

  return json({ error: '接口不存在: ' + p }, 404);
}
