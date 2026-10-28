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
  paperSystemPrompt,
  paperUserPrompt,
} from './prompts';

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  GRADE_QUEUE: Queue;
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

/**
 * 首页列表缩略图：客户端在上传时顺带生成一张 320px 小图，走「thumb」表单字段传上来。
 * 这里把它存成 thumb/* key 并返回；没传就返回 null（旧客户端 / 兼容），前端列表会退回用原图。
 */
async function storeThumb(env: Env, form: FormData, baseKey: string): Promise<string | null> {
  const thumb = form.get('thumb') as File | null;
  if (!thumb || !thumb.size) return null;
  try {
    const key = `thumb/${baseKey}.jpg`;
    await env.IMAGES.put(key, await thumb.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
    return key;
  } catch (e) {
    return null; // 缩略图失败不影响主流程，列表退回用原图
  }
}

/* --------------------------------------------------------------- settings */

interface Settings {
  base_url: string;
  api_key: string;
  model: string;
  grade: string;
  student_name: string;
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

/** 迁移前所有数据都属于它；库里一个人都没有时也回落到它 */
const DEFAULT_UID = 'u_xiaoqi';

/** 家庭口令是全局的：谁进来都要过这一道门，不随用户切换而变 */
async function getPasscode(env: Env): Promise<string> {
  const r = await env.DB.prepare('SELECT passcode FROM app_config WHERE id = 1').first<any>();
  return r?.passcode || '';
}

/** 新用户可能还没有设置行，写之前先补一行空的 */
async function ensureSettingsRow(env: Env, uid: string): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO user_settings (user_id, updated_at) VALUES (?, ?)').bind(uid, now()).run();
}

async function getSettings(env: Env, uid: string): Promise<Settings> {
  const row = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(uid).first<any>();
  return {
    base_url: row?.base_url || DEFAULT_BASE,
    api_key: row?.api_key || '',
    model: row?.model || DEFAULT_MODEL,
    grade: row?.grade || '一年级',
    student_name: row?.student_name || '',
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

async function listProfiles(env: Env, uid: string): Promise<Profile[]> {
  const r = await env.DB.prepare('SELECT * FROM llm_profiles WHERE user_id = ? ORDER BY created_at').bind(uid).all<any>();
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

async function getProfile(env: Env, id: string, uid: string): Promise<Profile | null> {
  if (!id) return null;
  const x = await env.DB.prepare('SELECT * FROM llm_profiles WHERE id = ? AND user_id = ?').bind(id, uid).first<any>();
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
  uid: string,
): Promise<void> {
  const cur = await getProfile(env, id, uid);
  if (!cur) throw new HttpError(404, '模型源不存在');
  await env.DB.prepare(
    `UPDATE llm_profiles SET
      name = ?, base_url = ?, api_key = ?, model = ?, kind = ?, note = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
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
      uid,
    )
    .run();
}

/** 老配置（settings 表里那一份）自动迁进模型源库，只迁一次（每个用户各迁各的） */
async function migrateLegacyProfile(env: Env, s: Settings, uid: string): Promise<void> {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS c FROM llm_profiles WHERE user_id = ?').bind(uid).first<any>();
  if (Number(existing?.c || 0) > 0) return;
  if (!s.api_key) return;
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO llm_profiles (id, user_id, name, base_url, api_key, model, kind, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(id, uid, '视觉模型（旧配置）', s.base_url, s.api_key, s.model || DEFAULT_MODEL, 'vision', '', now(), now())
    .run();
  await env.DB.prepare('UPDATE user_settings SET active_vision_profile = ? WHERE user_id = ?').bind(id, uid).run();
}

interface ActiveConfig {
  base_url: string;
  api_key: string;
  model: string;
}

/** 取当前生效的配置：优先「当前启用的模型源」，其次老写法（user_settings 那几列） */
async function getActiveConfig(env: Env, uid: string, useText: boolean, s?: Settings): Promise<ActiveConfig | null> {
  const st = s || (await getSettings(env, uid));
  await migrateLegacyProfile(env, st, uid);
  if (useText) {
    const p = await getProfile(env, st.active_text_profile, uid);
    if (p && p.api_key && p.model) return { base_url: p.base_url, api_key: p.api_key, model: p.model };
    if (st.text_api_key && st.text_model) {
      return { base_url: st.text_base_url || st.base_url, api_key: st.text_api_key, model: st.text_model };
    }
    return null;
  }
  const p = await getProfile(env, st.active_vision_profile, uid);
  if (p && p.api_key && p.model) return { base_url: p.base_url, api_key: p.api_key, model: p.model };
  if (st.api_key) return { base_url: st.base_url, api_key: st.api_key, model: st.model || DEFAULT_MODEL };
  return null;
}

/* -------------------------------------------------------------------- LLM */

interface LlmOptions {
  imageBase64?: string;
  imageType?: string;
  /** 多张图（一份作业有多页时一次全给模型）。传了它就用它，忽略上面的单图字段 */
  images?: { b64: string; type: string }[];
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

/** Fisher-Yates 洗牌，直接改原数组并返回（省一次拷贝） */
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 取一张属于当前用户的卷子，别人的 / 不存在的都当 404 */
async function ownPaper(env: Env, pid: string, uid: string): Promise<any> {
  const row = await env.DB.prepare('SELECT * FROM papers WHERE id = ? AND user_id = ?').bind(pid, uid).first<any>();
  if (!row) throw new HttpError(404, '卷子不存在');
  return row;
}

/** 删题后把 pos 重新收紧成 0,1,2…，避免出现跳号 */
async function renumberPaper(env: Env, paperId: string): Promise<void> {
  const rows = await env.DB.prepare('SELECT id FROM paper_items WHERE paper_id = ? ORDER BY pos ASC, created_at ASC')
    .bind(paperId)
    .all<any>();
  const list = rows.results || [];
  for (let i = 0; i < list.length; i++) {
    await env.DB.prepare('UPDATE paper_items SET pos = ? WHERE id = ?').bind(i, list[i].id).run();
  }
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
  uid: string,
  system: string,
  userText: string,
  opts: LlmOptions = {},
): Promise<string> {
  const s = await getSettings(env, uid);
  // 文本槽位单独配了才启用，否则自动回落到视觉模型
  let cfg = await getActiveConfig(env, uid, !!opts.text, s);
  if (!cfg) cfg = await getActiveConfig(env, uid, false, s);
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
  const pics: { b64: string; type: string }[] =
    opts.images && opts.images.length
      ? opts.images
      : opts.imageBase64
        ? [{ b64: opts.imageBase64, type: opts.imageType || 'image/jpeg' }]
        : [];
  if (pics.length && !canSeeImages(base, model)) {
    throw new HttpError(
      400,
      `当前模型源（${model}）看不了照片：这个槽位需要能读图的模型（名字里一般带 v / vision / vl）。请在「模型源库」里启用一个视觉模型源。`,
    );
  }

  const content: any[] = [];
  for (const p of pics) {
    content.push({
      type: 'image_url',
      image_url: { url: imageUrlFor(base, p.b64, p.type) },
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

/**
 * 给一批题（同一份作业的）一次性挂上举一反三 + 掌握度。
 * 详情页以前是 `Promise.all(list.map(questionWithMastery))`，每道题查一次变式题，
 * 24 题 = 24 次 D1 往返。这里改成一条 SQL 按 parent_id 全查、内存分组，只花一趟。
 * D1 单条语句绑定参数上限 100，题多时按 100 个一批分批查。
 */
async function attachMasteryBatch(env: Env, list: any[]): Promise<any[]> {
  if (!list.length) return [];
  const byParent = new Map<string, VariantRow[]>();
  const ids = list.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const vs = await env.DB.prepare(
      `SELECT * FROM variants WHERE parent_id IN (${chunk.map(() => '?').join(',')}) ORDER BY seq ASC, created_at ASC`,
    )
      .bind(...chunk)
      .all<VariantRow>();
    for (const v of vs.results || []) {
      const a = byParent.get(v.parent_id);
      if (a) a.push(v);
      else byParent.set(v.parent_id, [v]);
    }
  }
  return list.map((r) => {
    const variants = byParent.get(r.id) || [];
    return { ...r, variants, mastery: computeMastery(r, variants) };
  });
}

/* ------------------------------------------------------------------- auth */

function cookiePass(req: Request): string | null {
  const cookie = req.headers.get('Cookie') || '';
  const m = /(?:^|;\s*)mh_pass=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

async function requireAuth(req: Request, env: Env): Promise<Response | null> {
  const passcode = await getPasscode(env);
  if (!passcode) return null;
  const provided = req.headers.get('X-Passcode') || cookiePass(req) || '';
  if (provided !== passcode) return json({ error: '需要家庭口令' }, 401);
  return null;
}

/* ------------------------------------------------------------------ 用户 */

interface UserRow {
  id: string;
  name: string;
  avatar: string;
}

/** 当前请求说的是哪个用户：请求头没带 / 带了个不存在的，都回落到第一个用户 */
async function resolveUser(req: Request, env: Env): Promise<UserRow> {
  const want = (req.headers.get('X-User-Id') || '').trim();
  if (want) {
    const row = await env.DB.prepare('SELECT id, name, avatar FROM users WHERE id = ?').bind(want).first<any>();
    if (row) return { id: row.id, name: row.name, avatar: row.avatar || '' };
  }
  const def = await env.DB.prepare('SELECT id, name, avatar FROM users ORDER BY sort ASC, created_at ASC LIMIT 1').first<any>();
  return def ? { id: def.id, name: def.name, avatar: def.avatar || '' } : { id: DEFAULT_UID, name: '小七', avatar: '🐣' };
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
        const user = await resolveUser(req, env);
        return await handleApi(req, env, apiPath, url, user);
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

  // 批改队列 consumer：后台调模型批改，成功写 graded、失败写 error。
  // 这里不受 HTTP 请求墙钟限制（consumer 单次可跑 15 分钟），模型再慢也不会被杀死。
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const m of batch.messages) {
      const body = m.body as { type?: string; submissionId?: string; pageId?: string; uid?: string };
      const type = body?.type;
      const subId = String(body?.submissionId || '');
      const uid = String(body?.uid || '');
      const pageId = body?.pageId;
      if (!subId || !uid || (type !== 'homework' && type !== 'page')) {
        m.ack(); // 消息格式不对，直接确认丢弃（避免死循环重试）
        continue;
      }
      try {
        if (type === 'homework') {
          await gradeHomework(env, subId, uid);
        } else {
          await gradePage(env, subId, String(pageId || ''), uid);
        }
        m.ack();
      } catch (e: any) {
        // 批改失败：把状态标成 error，让前端轮询时能看到「批改失败」而不是永远「批改中」
        const msg = String(e?.message || e).slice(0, 500);
        await env.DB.prepare("UPDATE submissions SET status = 'error', error_msg = ? WHERE id = ? AND user_id = ?")
          .bind(msg, subId, uid)
          .run()
          .catch(() => {});
        m.ack(); // 已落 error 状态，确认掉（不再重试，重试也大概率同样失败）
      }
    }
  },
};

/* ------------------------------------------------- 教材大纲辅助函数 */

async function textbookTree(env: Env, uid: string, textbookId?: string): Promise<any[]> {
  let sql = 'SELECT * FROM units WHERE user_id = ?';
  const binds: any[] = [uid];
  if (textbookId) {
    sql += ' AND textbook_id = ?';
    binds.push(textbookId);
  }
  sql += ' ORDER BY sort, name';
  const us = await env.DB.prepare(sql).bind(...binds).all<any>();
  const ls = await env.DB.prepare('SELECT * FROM lessons WHERE user_id = ? ORDER BY sort, name').bind(uid).all<any>();
  const units = us.results || [];
  const lessons = ls.results || [];
  return units.map((u) => ({
    id: u.id,
    name: u.name,
    is_custom: !!Number(u.is_custom),
    lessons: lessons
      .filter((l) => l.unit_id === u.id)
      .map((l) => ({ id: l.id, name: l.name, is_custom: !!Number(l.is_custom), sort: Number(l.sort) || 0 })),
  }));
}

/** 当前默认教材（第一本），找不到返回 null */
async function defaultTextbookId(env: Env, uid: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT id FROM textbooks WHERE user_id = ? ORDER BY sort, name LIMIT 1')
    .bind(uid)
    .first<any>();
  return row ? row.id : null;
}

/** 没有归属单元的自定义课文，统一塞进「自定义」单元（没有就建一个） */
async function ensureCustomUnit(env: Env, uid: string, textbookId?: string): Promise<string> {
  const tbId = textbookId || (await defaultTextbookId(env, uid)) || '';
  if (tbId) {
    const own = await env.DB.prepare('SELECT id FROM textbooks WHERE id = ? AND user_id = ?').bind(tbId, uid).first<any>();
    if (!own) throw new HttpError(400, '所选教材不存在');
  }
  const row = await env.DB.prepare(
    "SELECT id FROM units WHERE user_id = ? AND name = '自定义' AND is_custom = 1 AND COALESCE(textbook_id,'') = ?",
  )
    .bind(uid, tbId)
    .first<any>();
  if (row) return row.id;
  const id = 'cu' + uuid();
  const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM units WHERE textbook_id = ?')
    .bind(tbId)
    .first<any>();
  await env.DB.prepare(
    'INSERT INTO units (id, user_id, textbook_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,?,1,?)',
  )
    .bind(id, uid, tbId, '自定义', Number(mx?.m || 0) + 1, now())
    .run();
  return id;
}

/** 删除单道错题（母题）：连带删它的举一反三记录和答案裁剪图，不留孤儿数据 */
async function deleteQuestion(env: Env, id: string): Promise<void> {
  const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first<any>();
  if (!q) return;
  const keys: string[] = [q.answer_image_key].filter(Boolean);
  const vs = await env.DB.prepare('SELECT attempt_image_key FROM variants WHERE parent_id = ?').bind(id).all<any>();
  (vs.results || []).forEach((r: any) => {
    if (r.attempt_image_key) keys.push(r.attempt_image_key);
  });
  await env.DB.prepare('DELETE FROM paper_queue WHERE variant_id IN (SELECT id FROM variants WHERE parent_id = ?)')
    .bind(id)
    .run();
  await env.DB.prepare('DELETE FROM variants WHERE parent_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(id).run();
  // 题没了，待组卷列表里的那条也得跟着走，否则会留下一条点开后 404 的空记录
  await env.DB.prepare('DELETE FROM paper_queue WHERE question_id = ?').bind(id).run();
  await Promise.all(keys.map((k) => env.IMAGES.delete(k).catch(() => {})));
}

/** 一份作业的题目被删光后，整份作业（含原图）也一起清掉，避免列表里出现「0 题」的空壳 */
async function pruneEmptySubmission(env: Env, submissionId: string): Promise<void> {
  if (!submissionId) return;
  const left = await env.DB.prepare('SELECT COUNT(*) AS c FROM questions WHERE submission_id = ?')
    .bind(submissionId)
    .first<any>();
  if (Number(left?.c || 0) > 0) return;
  // 组卷条目即使一道题都没有也要留着（它是「未作答」的卷子，不是空壳作业）
  const row = await env.DB.prepare('SELECT kind FROM submissions WHERE id = ?').bind(submissionId).first<any>();
  if (row?.kind === 'paper') {
    await env.DB.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?").bind(submissionId).run();
    return;
  }
  await deleteSubmission(env, submissionId);
}

/** 删除一份作业：级联删变式题、题目，并清掉 R2 上的图片 */
async function deleteSubmission(env: Env, id: string): Promise<void> {
  const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<any>();
  if (!sub) return;
  const qs = await env.DB.prepare('SELECT id, answer_image_key FROM questions WHERE submission_id = ?')
    .bind(id)
    .all<any>();
  const ids = (qs.results || []).map((r) => r.id);
  const keys: string[] = [sub.image_key, sub.thumb_key].filter(Boolean);
  const pgs = await env.DB.prepare('SELECT image_key, thumb_key FROM submission_pages WHERE submission_id = ?')
    .bind(id)
    .all<any>();
  (pgs.results || []).forEach((r: any) => {
    if (r.image_key) keys.push(r.image_key);
    if (r.thumb_key) keys.push(r.thumb_key);
  });
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
    // 待组卷里引用这些题（母题或它们的变式题）的条目一起清掉，否则会留下点开 404 的死记录
    await env.DB.prepare(
      `DELETE FROM paper_queue WHERE variant_id IN (
         SELECT id FROM variants WHERE parent_id IN (${ids.map(() => '?').join(',')})
       )`,
    )
      .bind(...ids)
      .run();
    await env.DB.prepare(`DELETE FROM paper_queue WHERE question_id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .run();
    await env.DB.prepare(
      `DELETE FROM variants WHERE parent_id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(...ids)
      .run();
    await env.DB.prepare('DELETE FROM questions WHERE submission_id = ?').bind(id).run();
  }
  await env.DB.prepare('DELETE FROM submission_pages WHERE submission_id = ?').bind(id).run();
  // 这是组卷生成的作业条目：连卷子本身一起删掉，否则作业列表里没了、卷子还留着变成孤儿
  if (sub.paper_id) {
    await env.DB.prepare('DELETE FROM paper_items WHERE paper_id = ?').bind(sub.paper_id).run();
    await env.DB.prepare('DELETE FROM papers WHERE id = ?').bind(sub.paper_id).run();
  }
  await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
  await Promise.all(keys.map((k) => env.IMAGES.delete(k).catch(() => {})));
}

/** 删掉一个用户的全部数据（作业、题目、变式、组卷、大纲、模型源、设置） */
async function deleteUserData(env: Env, uid: string): Promise<void> {
  const subs = await env.DB.prepare('SELECT id FROM submissions WHERE user_id = ?').bind(uid).all<any>();
  const subIds = (subs.results || []).map((r: any) => r.id);
  if (subIds.length) {
    const ph = subIds.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM submission_pages WHERE submission_id IN (${ph})`).bind(...subIds).run();
  }
  await env.DB.prepare('DELETE FROM paper_queue WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM paper_items WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM papers WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM variants WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM questions WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM submissions WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM lessons WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM units WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM textbooks WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM llm_profiles WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_id = ?').bind(uid).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
}

/** 批改任务入队：轻量消息（只放 id 和类型），批改时再读 R2 图 + DB 设置 */
async function enqueueGrade(env: Env, msg: { type: 'homework' | 'page'; submissionId: string; pageId?: string; uid: string }): Promise<void> {
  await env.GRADE_QUEUE.send(msg);
}

/** 批改一份作业：读图 → 让模型逐题识别/判对错/写错因 → 落库。失败由调用方统一标 error。 */
async function gradeHomework(env: Env, id: string, uid: string): Promise<Response> {
  const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND user_id = ?').bind(id, uid).first<any>();
  if (!sub) throw new HttpError(404, '提交不存在');
  if (sub.status === 'grading' && sub.error_msg) {
    // 上一次失败后重试：清掉旧标记
    await env.DB.prepare('UPDATE submissions SET error_msg = NULL WHERE id = ?').bind(id).run();
  }
  // 多页作业：把这门作业的每一页都取出来，一次交给模型
  const pageRows = await env.DB.prepare(
    'SELECT image_key FROM submission_pages WHERE submission_id = ? ORDER BY pos ASC',
  )
    .bind(id)
    .all<any>();
  let pageKeys = (pageRows.results || []).map((r: any) => r.image_key).filter(Boolean);
  if (!pageKeys.length && sub.image_key) pageKeys = [sub.image_key];
  if (!pageKeys.length) throw new HttpError(404, '图片不存在（可能没上传成功），请重新拍照上传。');

  const pics: { b64: string; type: string }[] = [];
  for (const k of pageKeys) {
    const obj = await env.IMAGES.get(k);
    if (!obj) continue;
    const buf = await obj.arrayBuffer();
    if (buf.byteLength > 9 * 1024 * 1024) {
      throw new HttpError(413, '这张照片太大了，大模型不接受。请截图或压缩后再传。');
    }
    pics.push({ b64: toBase64(buf), type: contentTypeOf(k) });
  }
  if (!pics.length) throw new HttpError(404, '图片不存在（可能没上传成功），请重新拍照上传。');
  const s = await getSettings(env, uid);

  // 批的是组卷答卷：把原卷题目和正确答案一并给模型当校对依据，判分更稳
  let userPrompt = gradeUserPrompt(s.grade);
  if (sub.paper_id) {
    const items = await env.DB.prepare('SELECT pos, stem, answer FROM paper_items WHERE paper_id = ? ORDER BY pos ASC')
      .bind(sub.paper_id)
      .all<any>();
    const rows = items.results || [];
    if (rows.length) {
      userPrompt +=
        '\n\n【这份卷子原本的题目和正确答案，供你校对（学生答案仍以图片上手写的为准，图片上没写的就是没作答）】\n' +
        rows.map((r: any, i: number) => `${i + 1}. ${r.stem} → ${r.answer}`).join('\n');
    }
  }

  if (pics.length > 1) {
    userPrompt =
      `这份作业一共 ${pics.length} 张照片，按顺序分别对应第 1 页到第 ${pics.length} 页，请全部批改。` +
      '每道题都要用 page 字段写明它在第几页（从 1 开始），answer_band 是相对该页的纵向百分比。\n\n' +
      userPrompt;
  }

  const text = await llm(env, uid, gradeSystemPrompt(s.grade), userPrompt, {
    images: pics,
    temperature: 0.1,
    maxTokens: Math.min(4000 + (pics.length - 1) * 2000, 9000),
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

  // 重新批改时先清掉上一轮的题，避免重复。
  // 用 deleteQuestion 而不是裸 DELETE：它会把举一反三记录和 R2 里的裁剪图一起清掉，
  // 否则 variants 变成指向不存在母题的孤儿，图和存储配额也一直漏。
  const oldQs = await env.DB.prepare('SELECT id FROM questions WHERE submission_id = ?').bind(id).all<any>();
  for (const r of oldQs.results || []) await deleteQuestion(env, r.id);

  const created: any[] = [];
  const insertStmts: any[] = [];
  let seq = 0;
  for (const q of list) {
    seq += 1;
    const qid = uuid();
    const pageNo = Math.min(Math.max(Number(q.page) || 1, 1), pics.length);
    let band: number[] | null = null;
    if (Array.isArray(q.answer_band) && q.answer_band.length >= 2) {
      const a = Number(q.answer_band[0]) / bandScale;
      const b2 = Number(q.answer_band[1]) / bandScale;
      if (Number.isFinite(a) && Number.isFinite(b2) && b2 > a) {
        band = [Math.max(0, Math.min(100, Math.round(a))), Math.max(0, Math.min(100, Math.round(b2)))];
      }
    }
    insertStmts.push(
      env.DB.prepare(
        `INSERT INTO questions
         (id, user_id, submission_id, seq, no, stem, student_answer, correct_answer, is_correct,
          error_reason, solution, knowledge, page, answer_band, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        qid,
        uid,
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
        pageNo,
        band ? JSON.stringify(band) : null,
        now(),
      ),
    );
    // page 必须回给前端：多页作业时前端要按页码取对应那张图来裁作答图，
    // 少了它前端会全部退回第 1 页，第 2 页起的题目就挂上第 1 页的截图。
    created.push({ id: qid, seq, band, page: pageNo });
  }
  // 一批写入，别逐题 INSERT（一次批 20+ 题就是 20+ 次 D1 往返）
  await env.DB.batch(insertStmts);
  await env.DB.prepare("UPDATE submissions SET status = 'graded', error_msg = NULL WHERE id = ? AND user_id = ?")
    .bind(id, uid)
    .run();
  return json({ submission_id: id, questions: created });
}

/** 读上传的表单图片，统一做 HEIC / 大小校验（图片编辑接口共用） */
async function readImageForm(req: Request): Promise<{ buf: ArrayBuffer; ext: string; thumb: File | null }> {
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
  const thumb = form.get('thumb') as File | null;
  return { buf: await file.arrayBuffer(), ext, thumb: thumb && thumb.size ? thumb : null };
}

/** 按「页 → 页内顺序」重排 seq（删页/加页后调用，保证题目按页顺序编号） */
async function renumberQuestionsByPage(env: Env, subId: string): Promise<void> {
  const rows = await env.DB.prepare(
    'SELECT id FROM questions WHERE submission_id = ? ORDER BY COALESCE(page, 9999) ASC, seq ASC',
  )
    .bind(subId)
    .all<any>();
  const list = rows.results || [];
  // 一条批量提交，别逐题 UPDATE（一份 24 题就是 24 次往返）
  if (list.length) {
    const stmts = list.map((r, i) => env.DB.prepare('UPDATE questions SET seq = ? WHERE id = ?').bind(i + 1, r.id));
    await env.DB.batch(stmts);
  }
}

/**
 * 只批改一页（换图后重批、或新增一页后补批）。
 *
 * 为什么不复用 gradeHomework：整份重批是「删光所有题再重建」，会把别的页上
 * 已经人工改判过、做过举一反三、有掌握度记录的题全清掉。家长只是换了第 2 页，
 * 不该动到第 1 页。所以这里只动这一页，新题 seq 接在现有题目后面。
 */
async function gradePage(env: Env, subId: string, pageId: string, uid: string): Promise<Response> {
  const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND user_id = ?').bind(subId, uid).first<any>();
  if (!sub) throw new HttpError(404, '提交不存在');
  const pgs = await env.DB.prepare('SELECT * FROM submission_pages WHERE submission_id = ? ORDER BY pos ASC')
    .bind(subId)
    .all<any>();
  const all = pgs.results || [];
  const idx = all.findIndex((r: any) => r.id === pageId);
  if (idx < 0) throw new HttpError(404, '这一页不存在，刷新一下再试');
  const pageKey = all[idx].image_key;
  if (!pageKey) throw new HttpError(404, '这一页还没有图片');
  const obj = await env.IMAGES.get(pageKey);
  if (!obj) throw new HttpError(404, '这张图找不到了，重新传一张');
  const buf = await obj.arrayBuffer();
  if (buf.byteLength > 9 * 1024 * 1024) {
    throw new HttpError(413, '这张照片太大了，大模型不接受。请截图或压缩后再传。');
  }
  const s = await getSettings(env, uid);
  const pageNo = idx + 1;

  let userPrompt =
    `这份作业一共 ${all.length} 页，下面这张照片是第 ${pageNo} 页。只批改这一页上出现的题目，不要臆测其它页。` +
    `每道题的 page 一律写 ${pageNo}，answer_band 按这一页自己的纵向百分比给。\n\n` +
    gradeUserPrompt(s.grade);

  // 组卷答卷：把原卷题目和正确答案一并给模型当校对依据
  if (sub.paper_id) {
    const items = await env.DB.prepare('SELECT pos, stem, answer FROM paper_items WHERE paper_id = ? ORDER BY pos ASC')
      .bind(sub.paper_id)
      .all<any>();
    const rows = items.results || [];
    if (rows.length) {
      userPrompt +=
        '\n\n【这份卷子原本的题目和正确答案，供你校对（学生答案仍以图片上手写的为准，图片上没写的就是没作答）】\n' +
        rows.map((r: any, i: number) => `${i + 1}. ${r.stem} → ${r.answer}`).join('\n');
    }
  }

  const text = await llm(env, uid, gradeSystemPrompt(s.grade), userPrompt, {
    imageBase64: toBase64(buf),
    imageType: contentTypeOf(pageKey),
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
  if (!list.length) throw new HttpError(502, '这一页没能识别出题目，换一张更清楚的再试一次。');

  // 模型常把 answer_band 给成像素坐标，取最大值等比归一（同 gradeHomework）
  let bandScale = 1;
  for (const q of list) {
    const b = Array.isArray(q.answer_band) ? q.answer_band : null;
    if (!b) continue;
    for (const v of b) if (typeof v === 'number' && v > bandScale) bandScale = v;
  }
  bandScale = bandScale > 100 ? bandScale / 100 : 1;

  // 这一页原有的题先清掉：要么调用方选了「删旧题重批」，要么这页本来就是新加的
  const old = await env.DB.prepare('SELECT id FROM questions WHERE submission_id = ? AND page = ?')
    .bind(subId, pageNo)
    .all<any>();
  for (const r of old.results || []) await deleteQuestion(env, r.id);

  const mx = await env.DB.prepare('SELECT MAX(seq) AS m FROM questions WHERE submission_id = ?').bind(subId).first<any>();
  let seq = Number(mx?.m || 0);
  const created: any[] = [];
  const insertStmts: any[] = [];
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
    insertStmts.push(
      env.DB.prepare(
        `INSERT INTO questions
         (id, user_id, submission_id, seq, no, stem, student_answer, correct_answer, is_correct,
          error_reason, solution, knowledge, page, answer_band, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        qid,
        uid,
        subId,
        seq,
        String(q.no ?? seq),
        String(q.stem ?? ''),
        String(q.student_answer ?? ''),
        String(q.correct_answer ?? ''),
        q.is_correct ? 1 : 0,
        String(q.error_reason ?? ''),
        String(q.solution ?? ''),
        String(q.knowledge ?? ''),
        pageNo,
        band ? JSON.stringify(band) : null,
        now(),
      ),
    );
    created.push({ id: qid, seq, band, page: pageNo });
  }
  await env.DB.batch(insertStmts);
  // 重批这一页后，本页的题 seq 会排在别的页后面（旧题删掉留下的空档），
  // 按「页 → 页内顺序」重排一次，题目列表才不会一页的题分成两段显示。
  await renumberQuestionsByPage(env, subId);
  await env.DB.prepare("UPDATE submissions SET status = 'graded', error_msg = NULL WHERE id = ? AND user_id = ?")
    .bind(subId, uid)
    .run();
  return json({ submission_id: subId, page: pageNo, questions: created });
}

async function handleApi(
  req: Request,
  env: Env,
  p: string,
  url: URL,
  user: UserRow,
): Promise<Response> {
  const method = req.method.toUpperCase();
  const uid = user.id;

  /* ------------------------------------------------------------ 用户管理 */
  if (p === '/users' && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT u.id, u.name, u.avatar, u.sort, u.created_at,
              (SELECT COUNT(*) FROM questions q WHERE q.user_id = u.id) AS question_count,
              (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id) AS submission_count
         FROM users u ORDER BY u.sort ASC, u.created_at ASC`,
    ).all<any>();
    return json({ users: rows.results || [], current: uid });
  }

  // 新建用户：可选把现有用户的「大纲结构」和「模型设置」复制一份，省得重新配
  if (p === '/users' && method === 'POST') {
    const body = await req.json<any>().catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) throw new HttpError(400, '给这个用户起个名字');
    const dup = await env.DB.prepare('SELECT id FROM users WHERE name = ?').bind(name).first<any>();
    if (dup) throw new HttpError(400, `已经有一个叫「${name}」的用户了`);
    const copyFrom = String(body.copy_from || '').trim(); // 空 = 全部空白
    const id = `u_${uuid().slice(0, 10)}`;
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<any>();
    await env.DB.prepare('INSERT INTO users (id, name, avatar, sort, created_at) VALUES (?,?,?,?,?)')
      .bind(id, name, String(body.avatar || '🙂').slice(0, 4), Number(cnt?.c || 0), now())
      .run();

    if (copyFrom) {
      const src = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(copyFrom).first<any>();
      if (src) {
        // 1) 模型设置整份复制（API Key 也带上，新用户开箱能用）
        if (body.copy_settings !== false) {
          await env.DB.prepare(
            `INSERT INTO user_settings
               (user_id, base_url, api_key, model, grade, student_name,
                text_base_url, text_api_key, text_model,
                active_vision_profile, active_text_profile, thinking_mode, updated_at)
             SELECT ?, base_url, api_key, model, grade, student_name,
                    text_base_url, text_api_key, text_model,
                    active_vision_profile, active_text_profile, thinking_mode, ?
               FROM user_settings WHERE user_id = ?`,
          )
            .bind(id, now(), copyFrom)
            .run();
          // 模型源也复制一份，指向新副本，避免两个用户改同一行
          const profs = await env.DB.prepare('SELECT * FROM llm_profiles WHERE user_id = ?').bind(copyFrom).all<any>();
          const map = new Map<string, string>();
          for (const pr of profs.results || []) {
            const nid = uuid();
            map.set(pr.id, nid);
            await env.DB.prepare(
              'INSERT INTO llm_profiles (id, user_id, name, base_url, api_key, model, kind, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            )
              .bind(nid, id, pr.name, pr.base_url, pr.api_key || '', pr.model, pr.kind || 'vision', pr.note || '', now(), now())
              .run();
          }
          const st = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(id).first<any>();
          const av = map.get(st?.active_vision_profile || '') || '';
          const at = map.get(st?.active_text_profile || '') || '';
          // 学生姓名跟着「这个人」走：抄设置只抄模型/年级，名字必须是新用户自己的
          await env.DB.prepare(
            'UPDATE user_settings SET active_vision_profile = ?, active_text_profile = ?, student_name = ? WHERE user_id = ?',
          )
            .bind(av, at, name, id)
            .run();
        }

        // 2) 大纲结构（教材 → 单元 → 课文），不带任何作业/题目
        if (body.copy_syllabus !== false) {
          const tbs = await env.DB.prepare('SELECT * FROM textbooks WHERE user_id = ? ORDER BY sort').bind(copyFrom).all<any>();
          for (const tb of tbs.results || []) {
            const ntb = uuid();
            await env.DB.prepare('INSERT INTO textbooks (id, user_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,?,?)')
              .bind(ntb, id, tb.name, tb.sort || 0, tb.is_custom || 0, now())
              .run();
            const us = await env.DB.prepare('SELECT * FROM units WHERE textbook_id = ? ORDER BY sort').bind(tb.id).all<any>();
            for (const un of us.results || []) {
              const nun = uuid();
              await env.DB.prepare('INSERT INTO units (id, user_id, textbook_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,?,?,?)')
                .bind(nun, id, ntb, un.name, un.sort || 0, un.is_custom || 0, now())
                .run();
              const ls = await env.DB.prepare('SELECT * FROM lessons WHERE unit_id = ? ORDER BY sort').bind(un.id).all<any>();
              for (const le of ls.results || []) {
                await env.DB.prepare('INSERT INTO lessons (id, user_id, unit_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,?,?,?)')
                  .bind(uuid(), id, nun, le.name, le.sort || 0, le.is_custom || 0, now())
                  .run();
              }
            }
          }
        }
      }
    }
    return json({ ok: true, id, name });
  }

  const um = /^\/users\/([^/]+)$/.exec(p);
  if (um && method === 'PATCH') {
    const body = await req.json<any>().catch(() => ({}));
    const target = um[1];
    const name = body.name === undefined ? null : String(body.name).trim().slice(0, 20);
    if (name === '') throw new HttpError(400, '名字不能为空');
    if (name) {
      const dup = await env.DB.prepare('SELECT id FROM users WHERE name = ? AND id <> ?').bind(name, target).first<any>();
      if (dup) throw new HttpError(400, `已经有一个叫「${name}」的用户了`);
    }
    const r = await env.DB.prepare('UPDATE users SET name = COALESCE(?, name), avatar = COALESCE(?, avatar) WHERE id = ?')
      .bind(name, body.avatar === undefined ? null : String(body.avatar).slice(0, 4), target)
      .run();
    if (!Number(r?.meta?.changes || 0)) throw new HttpError(404, '用户不存在');
    return json({ ok: true });
  }

  // 删除用户：连同这个人的全部数据一起删（照片文件留在 R2，不阻塞请求）
  if (um && method === 'DELETE') {
    const target = um[1];
    const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<any>();
    if (Number(total?.c || 0) <= 1) throw new HttpError(400, '至少要留一个用户');
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(target).first<any>();
    if (!u) throw new HttpError(404, '用户不存在');
    await deleteUserData(env, target);
    return json({ ok: true });
  }

  /* ---------------------------------------------------------- settings */
  if (p === '/settings' && method === 'GET') {
    const s = await getSettings(env, uid);
    await migrateLegacyProfile(env, s, uid);
    const st2 = await getSettings(env, uid);
    const profiles = (await listProfiles(env, uid)).map((x) => ({
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
        passcode: await getPasscode(env),
        api_key_set: !!st2.api_key,
        api_key: st2.api_key ? '******' : '',
        text_api_key_set: !!st2.text_api_key,
        text_api_key: st2.text_api_key ? '******' : '',
      },
      profiles,
      // 告诉前端「你正在改的是谁的设置」（设置页会显示出来，避免改错人）
      user: { id: user.id, name: user.name, avatar: user.avatar },
    });
  }

  if (p === '/settings' && method === 'POST') {
    const body = await req.json<any>();
    const s0 = await getSettings(env, uid);
    // 视觉 / 文本槽位的表单：如果当前有启用的模型源，就改那条源（而不是覆盖旧列），这样源库里的配置不会互相覆盖
    if (body.base_url !== undefined || body.model !== undefined || body.api_key !== undefined) {
      const p = await getProfile(env, s0.active_vision_profile, uid);
      if (p) await saveProfile(env, p.id, { base_url: body.base_url, api_key: body.api_key, model: body.model }, uid);
    }
    if (body.text_base_url !== undefined || body.text_model !== undefined || body.text_api_key !== undefined) {
      const p = await getProfile(env, s0.active_text_profile, uid);
      if (p) {
        await saveProfile(env, p.id, { base_url: body.text_base_url, api_key: body.text_api_key, model: body.text_model }, uid);
      }
    }
    // 设置行可能还不存在（新用户没复制设置时），用 UPSERT 保证写得进去
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, base_url, api_key, model, text_base_url, text_api_key, text_model,
                                  grade, student_name, thinking_mode, updated_at)
       VALUES (?, COALESCE(?, ?), COALESCE(?, ''), COALESCE(?, ?),
               COALESCE(?, ''), COALESCE(?, ''), COALESCE(?, ''),
               COALESCE(?, ?), COALESCE(?, ''), COALESCE(?, 'fast'), ?)
       ON CONFLICT(user_id) DO UPDATE SET
        base_url = COALESCE(?, base_url),
        api_key = COALESCE(?, api_key),
        model = COALESCE(?, model),
        text_base_url = COALESCE(?, text_base_url),
        text_api_key = COALESCE(?, text_api_key),
        text_model = COALESCE(?, text_model),
        grade = COALESCE(?, grade),
        student_name = COALESCE(?, student_name),
        thinking_mode = COALESCE(?, thinking_mode),
        updated_at = excluded.updated_at`,
    )
      .bind(
        uid,
        body.base_url ?? null,
        DEFAULT_BASE,
        body.api_key ?? null,
        body.model ?? null,
        DEFAULT_MODEL,
        body.text_base_url !== undefined ? body.text_base_url : null,
        body.text_api_key !== undefined ? body.text_api_key : null,
        body.text_model !== undefined ? body.text_model : null,
        body.grade ?? null,
        '一年级',
        body.student_name ?? null,
        body.thinking_mode ?? null,
        now(),
        // ON CONFLICT 部分
        body.base_url ?? null,
        body.api_key ?? null,
        body.model ?? null,
        body.text_base_url !== undefined ? body.text_base_url : null,
        body.text_api_key !== undefined ? body.text_api_key : null,
        body.text_model !== undefined ? body.text_model : null,
        body.grade ?? null,
        body.student_name ?? null,
        body.thinking_mode ?? null,
      )
      .run();
    // 家庭口令是全局的，单独存
    if (body.passcode !== undefined && body.passcode !== null) {
      await env.DB.prepare(
        `INSERT INTO app_config (id, passcode, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET passcode = excluded.passcode, updated_at = excluded.updated_at`,
      )
        .bind(String(body.passcode), now())
        .run();
    }
    const s = await getSettings(env, uid);
    return json({ ok: true, settings: { ...s, api_key: s.api_key ? '******' : '' } });
  }

  /* -------------------------------------------------------- 模型源库 CRUD */
  if (p === '/profiles' && method === 'GET') {
    const list = (await listProfiles(env, uid)).map((x) => ({
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
    if (body.id) {
      const old = await getProfile(env, body.id, uid);
      if (!old) throw new HttpError(404, '模型源不存在'); // 不能改别人的源
      if (!body.api_key) body.api_key = old.api_key;
    }
    await env.DB.prepare(
      `INSERT INTO llm_profiles (id, user_id, name, base_url, api_key, model, kind, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key,
         model = excluded.model, kind = excluded.kind, note = excluded.note, updated_at = excluded.updated_at`,
    )
      .bind(
        id,
        uid,
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
    const s = await getSettings(env, uid);
    // 还没有任何启用的源时，新建的源自动启用到对应槽位
    if (body.kind === 'text') {
      if (!s.active_text_profile) {
        await ensureSettingsRow(env, uid);
        await env.DB.prepare('UPDATE user_settings SET active_text_profile = ? WHERE user_id = ?').bind(id, uid).run();
      }
    } else if (!s.active_vision_profile) {
      await ensureSettingsRow(env, uid);
      await env.DB.prepare('UPDATE user_settings SET active_vision_profile = ? WHERE user_id = ?').bind(id, uid).run();
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
      const prof = await getProfile(env, id, uid);
      if (!prof) throw new HttpError(404, '模型源不存在');
      const col = kind === 'text' ? 'active_text_profile' : 'active_vision_profile';
      await ensureSettingsRow(env, uid);
      await env.DB.prepare(`UPDATE user_settings SET ${col} = ? WHERE user_id = ?`).bind(id, uid).run();
      return json({ ok: true, kind, id });
    }
    if (action === 'test') {
      const prof = await getProfile(env, id, uid);
      if (!prof) throw new HttpError(404, '模型源不存在');
      if (!prof.api_key) throw new HttpError(400, `「${prof.name}」还没有填 API Key，请点「编辑」补上。`);
      const override = { base: prof.base_url, key: prof.api_key, model: prof.model };
      const t0 = Date.now();
      const text = await llm(env, uid, '你是一个测试助手。', '请只回复两个字：正常', {
        maxTokens: 1024,
        override,
      });
      // 视觉源再补一次「真读图」自检：文字通 ≠ 能读图（有些套餐/模型屏蔽图片输入）
      let vision: any = null;
      if (prof.kind !== 'text') {
        try {
          const v = await llm(env, uid, '你是图片描述助手。', '这张图是什么颜色？只回答颜色词，两个字以内。', {
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
    await saveProfile(
      env,
      id,
      {
        name: body.name,
        base_url: body.base_url,
        api_key: body.api_key,
        model: body.model,
        kind: body.kind,
        note: body.note,
      },
      uid,
    );
    return json({ ok: true, id });
  }

  if (pm && !pm[2] && method === 'DELETE') {
    const id = pm[1];
    const s = await getSettings(env, uid);
    // 只能删自己的源
    const own = await getProfile(env, id, uid);
    if (!own) throw new HttpError(404, '模型源不存在');
    await env.DB.prepare('DELETE FROM llm_profiles WHERE id = ? AND user_id = ?').bind(id, uid).run();
    if (s.active_vision_profile === id) {
      await env.DB.prepare("UPDATE user_settings SET active_vision_profile = '' WHERE user_id = ?").bind(uid).run();
    }
    if (s.active_text_profile === id) {
      await env.DB.prepare("UPDATE user_settings SET active_text_profile = '' WHERE user_id = ?").bind(uid).run();
    }
    return json({ ok: true });
  }

  if (p === '/unlock' && method === 'POST') {
    const body = await req.json<any>();
    const passcode = await getPasscode(env);
    if (!passcode || body.passcode === passcode) {
      return json(
        { ok: true },
        200,
        { 'Set-Cookie': `mh_pass=${encodeURIComponent(body.passcode || '')}; Path=/; Max-Age=31536000; SameSite=Lax` },
      );
    }
    return json({ error: '口令不对' }, 401);
  }

  if (p === '/settings/need' && method === 'GET') {
    // 这个接口在口令校验之前就要能访问，所以配置情况只能看「当前用户」的
    const passcode = await getPasscode(env);
    const s = await getSettings(env, uid);
    return json({ need_passcode: !!passcode, configured: !!s.api_key });
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
    const text = await llm(env, uid, '你是一个测试助手。', '请只回复两个字：正常', {
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
      const ok = await env.DB.prepare('SELECT id FROM lessons WHERE id = ? AND user_id = ?').bind(lessonId, uid).first<any>();
      if (!ok) throw new HttpError(400, '所选课文不存在');
    }
    const buf = await file.arrayBuffer();

    // 多页作业：带 submission_id 就是往同一份作业上再加一页
    const appendTo = String(form.get('submission_id') || '').trim();
    if (appendTo) {
      const sub = await env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND user_id = ?')
        .bind(appendTo, uid)
        .first<any>();
      if (!sub) throw new HttpError(404, '这份作业不存在，重新拍一次');
      const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM submission_pages WHERE submission_id = ?')
        .bind(appendTo)
        .first<any>();
      if (Number(cnt?.c || 0) >= 8) throw new HttpError(400, '一份作业最多 8 页，多了分成两次交吧。');
      const pos = Number(cnt?.c || 0);
      const key = `page/${appendTo}-${pos}.${ext}`;
      await env.IMAGES.put(key, buf, { httpMetadata: { contentType: contentTypeOf(key) } });
      const thumbKey = await storeThumb(env, form, `${appendTo}-${pos}`);
      await env.DB.prepare(
        'INSERT INTO submission_pages (id, submission_id, pos, image_key, thumb_key, created_at) VALUES (?,?,?,?,?,?)',
      )
        .bind(uuid(), appendTo, pos, key, thumbKey, now())
        .run();
      return json({ id: appendTo, image_key: key, pos });
    }

    const id = uuid();
    const key = `orig/${id}.${ext}`;
    await env.IMAGES.put(key, buf, { httpMetadata: { contentType: contentTypeOf(key) } });
    const thumbKey = await storeThumb(env, form, id);
    await env.DB.prepare(
      "INSERT INTO submissions (id, user_id, kind, lesson_id, image_key, thumb_key, status, created_at) VALUES (?,?,'homework',?,?,?, 'grading', ?)",
    )
      .bind(id, uid, lessonId, key, thumbKey, now())
      .run();
    await env.DB.prepare(
      'INSERT INTO submission_pages (id, submission_id, pos, image_key, thumb_key, created_at) VALUES (?,?,0,?,?,?)',
    )
      .bind(uuid(), id, key, thumbKey, now())
      .run();
    return json({ id, image_key: key, pos: 0 });
  }

  // 批改（OCR + 判对错 + 分析）。改成后台任务：入队后立即返回，队列 consumer 后台调模型，
  // 前端轮询状态直到 graded/error。这样模型慢也不会撞 Worker 墙钟上限被杀死、卡在 grading。
  if (p.startsWith('/homework/') && p.endsWith('/grade') && method === 'POST') {
    const id = p.slice('/homework/'.length, -'/grade'.length);
    // 入队前做轻量校验：作业和图片都得在，别把必败的任务丢进队列白等一轮
    const sub = await env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND user_id = ?').bind(id, uid).first<any>();
    if (!sub) throw new HttpError(404, '提交不存在');
    const pgs = await env.DB.prepare('SELECT image_key FROM submission_pages WHERE submission_id = ? AND image_key IS NOT NULL')
      .bind(id)
      .all<any>();
    const hasImg = (pgs.results || []).length > 0;
    if (!hasImg) throw new HttpError(404, '图片不存在（可能没上传成功），请重新拍照上传。');
    await enqueueGrade(env, { type: 'homework', submissionId: id, uid });
    return json({ queued: true, submission_id: id });
  }

  // 上传某题答案裁剪图
  if (p.startsWith('/questions/') && p.endsWith('/answer-image') && method === 'POST') {
    const parts = p.split('/'); // ['', 'questions', id, 'answer-image']
    const qid = parts[2];
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) throw new HttpError(400, '没有收到图片');
    // 家长手动框的范围（相对整张图的比例 {x,y,w,h}），存下来供下次「重框」时预填
    let crop: string | null = null;
    const rawCrop = form.get('crop');
    if (typeof rawCrop === 'string' && rawCrop) {
      try {
        const r = JSON.parse(rawCrop);
        if (r && isFinite(Number(r.y)) && isFinite(Number(r.h)) && Number(r.h) > 0) crop = rawCrop;
      } catch {
        crop = null; // 格式不对就算了，图照存
      }
    }
    // 每次上传都换一个新文件名：图片地址带一年强缓存，用固定 key 覆盖会导致
    // 浏览器 / 边缘节点一直显示旧图（重裁后看不到变化）。换 key 天然破缓存。
    const key = `ans/${qid}-${uuid().slice(0, 8)}.${extOf(file.name)}`;
    const old = await env.DB.prepare('SELECT answer_image_key FROM questions WHERE id = ? AND user_id = ?')
      .bind(qid, uid)
      .first<any>();
    if (!old) throw new HttpError(404, '题目不存在');
    await env.IMAGES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: contentTypeOf(key) },
    });
    await env.DB.prepare(
      crop
        ? 'UPDATE questions SET answer_image_key = ?, answer_crop = ? WHERE id = ? AND user_id = ?'
        : 'UPDATE questions SET answer_image_key = ? WHERE id = ? AND user_id = ?',
    )
      .bind(...(crop ? [key, crop, qid, uid] : [key, qid, uid]))
      .run();
    if (old?.answer_image_key && old.answer_image_key !== key) {
      try {
        await env.IMAGES.delete(old.answer_image_key);
      } catch (e) {
        /* 删不掉旧图不影响结果 */
      }
    }
    return json({ ok: true, answer_image_key: key });
  }

  /* --------------------------------------------------------- 题目读写 */
  if (p === '/questions' && method === 'GET') {
    const filter = url.searchParams.get('filter'); // all | wrong | unpassed
    // 带上作业归属（教材 / 单元 / 课文），错题本才能按单元课文分组、并注明来源
    let sql =
      `SELECT q.*, s.created_at AS sub_created_at, s.image_key AS sub_image_key,
              s.lesson_id AS lesson_id, l.name AS lesson_name, l.sort AS lesson_sort,
              u.id AS unit_id, u.name AS unit_name, u.sort AS unit_sort,
              t.id AS textbook_id, t.name AS textbook_name
       FROM questions q
       LEFT JOIN submissions s ON s.id = q.submission_id
       LEFT JOIN lessons l ON l.id = s.lesson_id
       -- 组卷可能只挂了单元（没选课文），单元要从 submissions.unit_id 兜底
       LEFT JOIN units u ON u.id = COALESCE(l.unit_id, s.unit_id)
       LEFT JOIN textbooks t ON t.id = COALESCE(u.textbook_id, s.textbook_id)
       WHERE q.user_id = ?`;
    const binds: any[] = [uid];
    const qLesson = (url.searchParams.get('lesson') || '').trim();
    const qUnit = (url.searchParams.get('unit') || '').trim();
    const qTb = (url.searchParams.get('textbook') || '').trim();
    if (qLesson === '__none') {
      sql += ' AND s.lesson_id IS NULL';
    } else if (qLesson) {
      sql += ' AND s.lesson_id = ?';
      binds.push(qLesson);
    } else if (qUnit) {
      sql += ' AND u.id = ?';
      binds.push(qUnit);
    } else if (qTb) {
      // 同 submissions 列表：按教材筛时把未归类的也带上，否则会凭空少一批错题
      sql += ' AND (u.textbook_id = ? OR (s.lesson_id IS NULL AND s.unit_id IS NULL))';
      binds.push(qTb);
    }
    sql += ' ORDER BY s.created_at DESC, q.seq ASC';
    const rows = await env.DB.prepare(sql).bind(...binds).all<any>();
    const all = rows.results || [];
    // 以前是 Promise.all(all.map(questionWithMastery))，每道题查一次变式题（N+1），
    // 错题本拉全量几十上百题就是几十上百次串行 D1 往返。改成一次 IN 全查、内存分组。
    const withMastery = await attachMasteryBatch(env, all);
    const filtered = withMastery.filter((q) => {
      if (filter === 'wrong') return q.mastery.base_wrong;
      if (filter === 'unpassed') return !q.mastery.passed;
      return true;
    });
    return json({ questions: filtered });
  }

  // 批量删错题（错题本里勾选后一次删掉）。注意要排在 /questions/:id 之前，否则会被单题路由吃掉
  if (p === '/questions/batch-delete' && method === 'POST') {
    const body = await req.json<any>().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) throw new HttpError(400, '先勾选要删除的错题');
    const affected = new Set<string>();
    for (const id of ids) {
      const q = await env.DB.prepare('SELECT submission_id FROM questions WHERE id = ? AND user_id = ?')
        .bind(id, uid)
        .first<any>();
      if (!q) continue;
      if (q.submission_id) affected.add(q.submission_id);
      await deleteQuestion(env, id);
    }
    // 某份作业的题被删光了，整份作业也清掉
    for (const sid of affected) await pruneEmptySubmission(env, sid);
    return json({ ok: true, deleted: ids.length });
  }

  // 批量改判：作业详情页里勾一批题，整体判对 / 判错。
  // 只动 is_correct —— 家长手动翻判时不需要补错因和正确答案，
  // 而且刻意保留原有的 error_reason / solution，将来再翻回去还能看到 AI 原来写的分析。
  if (p === '/questions/batch-verify' && method === 'POST') {
    const body = await req.json<any>().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) throw new HttpError(400, '先勾选要改判的题目');
    if (body.is_correct !== true && body.is_correct !== false && body.is_correct !== 0 && body.is_correct !== 1) {
      throw new HttpError(400, 'is_correct 只能是 true / false');
    }
    const val = body.is_correct ? 1 : 0;
    let n = 0;
    for (const qid of ids) {
      const r = await env.DB.prepare('UPDATE questions SET is_correct = ? WHERE id = ? AND user_id = ?')
        .bind(val, qid, uid)
        .run();
      n += Number(r.meta?.changes || 0) > 0 ? 1 : 0;
    }
    return json({ ok: true, updated: n });
  }

  /* -------------------------------------------------- 待组卷题目（纸篓） */
  // 「作业详情」「错题本」里勾选后先加到这里，攒够了再统一组卷。
  // 加到队列里只是排队，不会立刻调模型，所以随时可以加、可以反悔。
  if (p === '/paper-queue' && method === 'GET') {
    // 队列里两种东西：母题（question_id）和举一反三的变式题（variant_id），
    // 统一成同一组字段给前端，前端靠 kind 区分怎么显示。
    const rows = await env.DB.prepare(
      `SELECT pq.id AS queue_id, pq.created_at AS queued_at, 'question' AS kind,
              q.id AS id, q.no AS no, q.stem AS stem, q.correct_answer AS answer,
              q.knowledge AS knowledge, q.is_correct AS is_correct, q.submission_id AS submission_id,
              s.created_at AS sub_created_at, l.name AS lesson_name, l.sort AS lesson_sort,
              u.id AS unit_id, u.name AS unit_name, t.id AS textbook_id, t.name AS textbook_name,
              NULL AS parent_no, NULL AS variant_seq, NULL AS difficulty
         FROM paper_queue pq
         JOIN questions q ON q.id = pq.question_id
         LEFT JOIN submissions s ON s.id = q.submission_id
         LEFT JOIN lessons l ON l.id = s.lesson_id
         LEFT JOIN units u ON u.id = l.unit_id
         LEFT JOIN textbooks t ON t.id = u.textbook_id
        WHERE pq.user_id = ? AND pq.question_id IS NOT NULL
        UNION ALL
       SELECT pq.id, pq.created_at, 'variant',
              v.id, v.seq, v.stem, v.answer,
              q2.knowledge, q2.is_correct, q2.submission_id,
              s.created_at, l.name, l.sort,
              u.id, u.name, t.id, t.name,
              q2.no, v.seq, v.difficulty
         FROM paper_queue pq
         JOIN variants v ON v.id = pq.variant_id
         JOIN questions q2 ON q2.id = v.parent_id
         LEFT JOIN submissions s ON s.id = q2.submission_id
         LEFT JOIN lessons l ON l.id = s.lesson_id
         LEFT JOIN units u ON u.id = l.unit_id
         LEFT JOIN textbooks t ON t.id = u.textbook_id
        WHERE pq.user_id = ? AND pq.variant_id IS NOT NULL
        ORDER BY queued_at ASC, queue_id ASC`,
    )
      .bind(uid, uid)
      .all<any>();
    return json({ items: rows.results || [] });
  }

  if (p === '/paper-queue' && method === 'POST') {
    const body = await req.json<any>().catch(() => ({}));
    const rawQ: string[] = Array.isArray(body.question_ids) ? body.question_ids.map(String) : [];
    const rawV: string[] = Array.isArray(body.variant_ids) ? body.variant_ids.map(String) : [];
    const qIds = [...new Set(rawQ)];
    const vIds = [...new Set(rawV)];
    if (!qIds.length && !vIds.length) throw new HttpError(400, '先勾选要加入的题目');
    if (qIds.length + vIds.length > 60) {
      throw new HttpError(400, `一次最多加入 60 道题（这次 ${qIds.length + vIds.length} 道），分批来吧。`);
    }
    let added = 0;
    for (const qid of qIds) {
      const q = await env.DB.prepare('SELECT id FROM questions WHERE id = ? AND user_id = ?').bind(qid, uid).first<any>();
      if (!q) continue;
      // 部分唯一索引：同一道题反复加也只排一次
      const r = await env.DB.prepare(
        'INSERT OR IGNORE INTO paper_queue (id, user_id, question_id, variant_id, created_at) VALUES (?,?,?,NULL,?)',
      )
        .bind(uuid(), uid, qid, now())
        .run();
      if (Number(r?.meta?.changes || 0) > 0) added += 1;
    }
    for (const vid of vIds) {
      const v = await env.DB.prepare('SELECT id FROM variants WHERE id = ? AND user_id = ?').bind(vid, uid).first<any>();
      if (!v) continue;
      const r = await env.DB.prepare(
        'INSERT OR IGNORE INTO paper_queue (id, user_id, question_id, variant_id, created_at) VALUES (?,?,NULL,?,?)',
      )
        .bind(uuid(), uid, vid, now())
        .run();
      if (Number(r?.meta?.changes || 0) > 0) added += 1;
    }
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM paper_queue WHERE user_id = ?').bind(uid).first<any>();
    return json({ ok: true, added, skipped: qIds.length + vIds.length - added, total: Number(cnt?.c || 0) });
  }

  // 移出待组卷：按母题 / 变式题 id 删；body.all = true 则清空
  if (p === '/paper-queue' && method === 'DELETE') {
    const body = await req.json<any>().catch(() => ({}));
    if (body.all) {
      const r = await env.DB.prepare('DELETE FROM paper_queue WHERE user_id = ?').bind(uid).run();
      return json({ ok: true, removed: Number(r?.meta?.changes || 0) });
    }
    const qIds: string[] = Array.isArray(body.question_ids) ? body.question_ids.map(String) : [];
    const vIds: string[] = Array.isArray(body.variant_ids) ? body.variant_ids.map(String) : [];
    if (!qIds.length && !vIds.length) throw new HttpError(400, '没有收到要移出的题目');
    let removed = 0;
    for (const qid of qIds) {
      const r = await env.DB.prepare('DELETE FROM paper_queue WHERE question_id = ? AND user_id = ?')
        .bind(qid, uid)
        .run();
      removed += Number(r?.meta?.changes || 0);
    }
    for (const vid of vIds) {
      const r = await env.DB.prepare('DELETE FROM paper_queue WHERE variant_id = ? AND user_id = ?')
        .bind(vid, uid)
        .run();
      removed += Number(r?.meta?.changes || 0);
    }
    return json({ ok: true, removed });
  }

  /* ------------------------------------------------------------ 组卷 */
  // 列出历史卷子（组卷板块 + 作业列表都靠它）
  if (p === '/papers' && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM paper_items i WHERE i.paper_id = p.id) AS item_count,
              t.name AS textbook_name, u.name AS unit_name, l.name AS lesson_name, l.sort AS lesson_sort,
              s.status AS sub_status, s.id AS sub_id
         FROM papers p
         LEFT JOIN textbooks t ON t.id = p.textbook_id
         LEFT JOIN units u ON u.id = p.unit_id
         LEFT JOIN lessons l ON l.id = p.lesson_id
         LEFT JOIN submissions s ON s.id = p.submission_id
        WHERE p.user_id = ?
        ORDER BY p.created_at DESC LIMIT 50`,
    )
      .bind(uid)
      .all<any>();
    return json({ papers: rows.results || [] });
  }

  // 组卷：两种方式
  //   mode=original → 直接把勾选的母题原题拼成一张卷（不调模型，秒出）
  //   mode=variant  → 每道母题举一反三出 per 道类似题（一次 LLM 调用，分多次会撞网关超时），
  //                   可选 include_original 把原题也排在它的类似题前面
  if (p === '/papers' && method === 'POST') {
    const body = await req.json<any>().catch(() => ({}));
    // 新的统一入参：items = [{kind:'question'|'variant', id}]；老参数 question_ids 继续兼容
    const itemsRaw: any[] = Array.isArray(body.items) ? body.items : [];
    const legacyQ: string[] = Array.isArray(body.question_ids) ? body.question_ids.map(String) : [];
    const seedsIn = itemsRaw.length
      ? itemsRaw
          .map((it) => ({ kind: it?.kind === 'variant' ? 'variant' : 'question', id: String(it?.id || '') }))
          .filter((it) => it.id)
      : legacyQ.map((id) => ({ kind: 'question' as const, id }));
    if (!seedsIn.length) throw new HttpError(400, '先勾选要组卷的题目');
    const mode: 'original' | 'variant' = body.mode === 'original' ? 'original' : 'variant';
    const per = Math.min(Math.max(Number(body.per) || 1, 1), 5);
    const withOriginal =
      mode === 'variant' && !(body.include_original === false || body.include_original === 0 || body.include_original === '0');
    const ordered = body.ordered === false || body.ordered === 0 ? 0 : 1;
    const s = await getSettings(env, uid);

    // 母题 / 变式题先统一成「出题种子」：后面不管是拼原题还是举一反三，都只认这组字段
    const qs: any[] = [];
    const seen = new Set<string>();
    for (const it of seedsIn) {
      const key = `${it.kind}:${it.id}`;
      if (seen.has(key)) continue; // 同一道题被重复勾上时只算一次
      seen.add(key);
      if (it.kind === 'variant') {
        const v = await env.DB.prepare(
          `SELECT v.*, q.no AS parent_no, q.knowledge AS parent_knowledge
             FROM variants v JOIN questions q ON q.id = v.parent_id
            WHERE v.id = ? AND v.user_id = ?`,
        )
          .bind(it.id, uid)
          .first<any>();
        if (!v) continue;
        qs.push({
          kind: 'variant',
          id: v.id,
          srcId: v.parent_id,
          no: `变式 ${v.seq ?? ''}`.trim(),
          srcNo: `${v.parent_no ?? ''} 变式${v.seq ?? ''}`.trim(),
          stem: String(v.stem || ''),
          correct_answer: String(v.answer ?? ''),
          solution: String(v.solution ?? ''),
          knowledge: String(v.parent_knowledge || ''),
          error_reason: '',
        });
      } else {
        const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').bind(it.id, uid).first<any>();
        if (!q) continue;
        qs.push({
          kind: 'question',
          id: q.id,
          srcId: q.id,
          no: String(q.no ?? ''),
          srcNo: String(q.no ?? ''),
          stem: String(q.stem || ''),
          correct_answer: String(q.correct_answer ?? ''),
          solution: String(q.solution ?? ''),
          knowledge: String(q.knowledge || ''),
          error_reason: String(q.error_reason || ''),
        });
      }
    }
    if (!qs.length) throw new HttpError(404, '这些题目找不到了，刷新一下再试');
    if (qs.length > 12) throw new HttpError(400, `一次最多选 12 道题组卷（当前选了 ${qs.length} 道），分两卷做效果更好。`);

    // 归属：教材必选，单元 / 课文可选（没选课文时单元也要落到 papers 上，否则会被归到「未指定单元」）
    const tbId = String(body.textbook_id || '').trim();
    if (!tbId) throw new HttpError(400, '先选这张卷子属于哪本教材');
    const tb = await env.DB.prepare('SELECT id FROM textbooks WHERE id = ? AND user_id = ?').bind(tbId, uid).first<any>();
    if (!tb) throw new HttpError(400, '所选教材不存在');
    let lessonId: string | null = String(body.lesson_id || '').trim() || null;
    let unitId: string | null = String(body.unit_id || '').trim() || null;
    if (lessonId) {
      const ls = await env.DB.prepare('SELECT id, unit_id FROM lessons WHERE id = ? AND user_id = ?')
        .bind(lessonId, uid)
        .first<any>();
      if (!ls) throw new HttpError(400, '所选课文不存在');
      if (!unitId) unitId = ls.unit_id || null;
    } else if (unitId) {
      const un = await env.DB.prepare('SELECT id, textbook_id FROM units WHERE id = ? AND user_id = ?')
        .bind(unitId, uid)
        .first<any>();
      if (!un) throw new HttpError(400, '所选单元不存在');
      if (String(un.textbook_id || '') !== tbId) throw new HttpError(400, '所选单元不属于这本教材');
    }

    const rows: any[] = [];
    if (mode === 'original') {
      // 只用原题：题干 → 答案直接用批改时的正确答案，不用等模型
      qs.forEach((q, i) => {
        rows.push({
          srcId: q.srcId,
          srcNo: q.srcNo || String(q.no || i + 1),
          stem: String(q.stem || ''),
          answer: String(q.correct_answer ?? ''),
          solution: String(q.solution ?? ''),
          difficulty: '原题',
          knowledge: String(q.knowledge || ''),
        });
      });
    } else {
      const expected = qs.length * per + (withOriginal ? qs.length : 0);
      if (expected > 60) {
        throw new HttpError(
          400,
          `这次会出 ${expected} 道题，太多了（一张卷最多 60 道）。少选几道母题，或把每道出的数量调小一点。`,
        );
      }
      const text = await llm(
        env,
        uid,
        paperSystemPrompt(s.grade),
        paperUserPrompt(
          qs.map((q, i) => ({
            index: i + 1,
            no: String(q.no ?? i + 1),
            stem: String(q.stem || ''),
            correctAnswer: String(q.correct_answer || ''),
            knowledge: String(q.knowledge || ''),
            errorReason: String(q.error_reason || ''),
          })),
          per,
        ),
        {
          temperature: 0.8,
          maxTokens: Math.min(8000, 1500 + qs.length * per * 140),
          text: true,
          thinking: (s.thinking_mode as any) || 'fast',
        },
      );

      let parsed: any;
      try {
        parsed = extractJson(text);
      } catch {
        throw new HttpError(502, `老师没出好题：${text.slice(0, 200)}`);
      }
      const rawItems: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
      if (!rawItems.length) throw new HttpError(502, '一道题都没出出来，再点一次「组卷」试试。');

      // 按 source_index 归拢；认不出来的丢进最后一组，保证出题结果不丢题
      const buckets = new Map<number, any[]>();
      rawItems.forEach((it) => {
        const idx = Number(it.source_index);
        const key = Number.isFinite(idx) && idx >= 1 && idx <= qs.length ? idx : qs.length;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(it);
      });

      for (let i = 1; i <= qs.length; i++) {
        const src = qs[i - 1];
        const srcNo = src.srcNo || String(src.no || i);
        // 带上原题：原题排在它自己的类似题前面，孩子先过一遍原题再练变式
        if (withOriginal) {
          rows.push({
            srcId: src.srcId,
            srcNo,
            stem: String(src.stem || ''),
            answer: String(src.correct_answer ?? ''),
            solution: String(src.solution ?? ''),
            difficulty: '原题',
            knowledge: String(src.knowledge || ''),
          });
        }
        for (const it of buckets.get(i) || []) {
          rows.push({
            srcId: src.srcId,
            srcNo,
            stem: String(it.stem || ''),
            answer: String(it.answer ?? ''),
            solution: String(it.solution ?? ''),
            difficulty: String(it.difficulty || '同等'),
            knowledge: String(it.knowledge || src.knowledge || ''),
          });
        }
      }
    }
    if (!rows.length) throw new HttpError(502, '一道题都没出出来，再点一次「组卷」试试。');
    if (ordered === 0) shuffleInPlace(rows);

    const nowIso = now();
    const paperId = uuid();
    const d = new Date();
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const title =
      String(body.title || '').trim() || (mode === 'original' ? `原题练习卷 ${md}` : `练习卷 ${md}`);
    await env.DB.prepare(
      `INSERT INTO papers (id, user_id, title, ordered, status, mode, include_original, per_question,
                           textbook_id, unit_id, lesson_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'final', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        paperId,
        uid,
        title.slice(0, 60),
        ordered,
        mode,
        withOriginal ? 1 : 0,
        per,
        tbId,
        unitId,
        lessonId,
        nowIso,
        nowIso,
      )
      .run();

    // 卷子本质也是一份作业：立刻建一条 status=pending（未作答）的记录，
    // 这样它同时出现在「组卷」板块和作业列表里，打印做完直接拍照交就能批改。
    const subId = uuid();
    await env.DB.prepare(
      `INSERT INTO submissions (id, user_id, kind, lesson_id, unit_id, textbook_id, paper_id, status, created_at)
       VALUES (?, ?, 'paper', ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(subId, uid, lessonId, unitId, tbId, paperId, nowIso)
      .run();
    await env.DB.prepare('UPDATE papers SET submission_id = ? WHERE id = ? AND user_id = ?').bind(subId, paperId, uid).run();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await env.DB.prepare(
        `INSERT INTO paper_items (id, user_id, paper_id, pos, stem, answer, solution, difficulty, knowledge, source_question_id, source_no, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(uuid(), uid, paperId, i, r.stem, r.answer, r.solution, r.difficulty, r.knowledge, r.srcId, r.srcNo, nowIso)
        .run();
    }

    // 组完就把用掉的题从「待组卷」里移走（默认移除，body.keep_queue=true 可保留）
    let removedFromQueue = 0;
    if (!body.keep_queue) {
      for (const q of qs) {
        const r =
          q.kind === 'variant'
            ? await env.DB.prepare('DELETE FROM paper_queue WHERE variant_id = ? AND user_id = ?').bind(q.id, uid).run()
            : await env.DB.prepare('DELETE FROM paper_queue WHERE question_id = ? AND user_id = ?').bind(q.id, uid).run();
        removedFromQueue += Number(r?.meta?.changes || 0);
      }
    }
    return json({ id: paperId, title, count: rows.length, submission_id: subId, removed_from_queue: removedFromQueue });
  }

  if (p.startsWith('/papers/') && method === 'GET') {
    const pid = p.slice('/papers/'.length);
    if (pid.includes('/')) return null;
    const paper = await ownPaper(env, pid, uid);
    const items = await env.DB.prepare('SELECT * FROM paper_items WHERE paper_id = ? ORDER BY pos ASC, created_at ASC')
      .bind(pid)
      .all<any>();
    const sub = paper?.submission_id
      ? await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(paper.submission_id).first<any>()
      : await env.DB.prepare('SELECT * FROM submissions WHERE paper_id = ?').bind(pid).first<any>();
    // 归属链：教材 → 单元 → 课文，页面上要显示归类到哪
    const tb = paper?.textbook_id
      ? await env.DB.prepare('SELECT id, name FROM textbooks WHERE id = ?').bind(paper.textbook_id).first<any>()
      : null;
    const ls = paper?.lesson_id
      ? await env.DB.prepare('SELECT id, name, unit_id FROM lessons WHERE id = ?').bind(paper.lesson_id).first<any>()
      : null;
    // 选了单元但没选课文时，单元直接存在 papers.unit_id 上
    const unId = ls?.unit_id || paper?.unit_id || '';
    const un = unId
      ? await env.DB.prepare('SELECT id, name FROM units WHERE id = ?').bind(unId).first<any>()
      : null;
    return json({
      paper,
      items: items.results || [],
      submission: sub || null,
      textbook: tb || null,
      unit: un || null,
      lesson: ls || null,
    });
  }

  // 删除卷子里的题目
  if (p.startsWith('/papers/') && p.endsWith('/items') && method === 'DELETE') {
    const pid = p.slice('/papers/'.length, -'/items'.length);
    const body = await req.json<any>().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) throw new HttpError(400, '先勾选要删掉的题');
    await ownPaper(env, pid, uid);
    for (const id of ids) {
      await env.DB.prepare('DELETE FROM paper_items WHERE id = ? AND paper_id = ? AND user_id = ?').bind(id, pid, uid).run();
    }
    await renumberPaper(env, pid);
    return json({ ok: true });
  }

  // 拖动排序：按传入的 id 顺序重写 pos
  if (p.startsWith('/papers/') && p.endsWith('/reorder') && method === 'POST') {
    const pid = p.slice('/papers/'.length, -'/reorder'.length);
    const body = await req.json<any>().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) throw new HttpError(400, '没有收到新顺序');
    await ownPaper(env, pid, uid);
    for (let i = 0; i < ids.length; i++) {
      await env.DB.prepare('UPDATE paper_items SET pos = ? WHERE id = ? AND paper_id = ? AND user_id = ?')
        .bind(i, ids[i], pid, uid)
        .run();
    }
    return json({ ok: true });
  }

  // 一键乱序
  if (p.startsWith('/papers/') && p.endsWith('/shuffle') && method === 'POST') {
    const pid = p.slice('/papers/'.length, -'/shuffle'.length);
    await ownPaper(env, pid, uid);
    const rows = await env.DB.prepare('SELECT id FROM paper_items WHERE paper_id = ? ORDER BY pos ASC').bind(pid).all<any>();
    const ids = shuffleInPlace((rows.results || []).map((r: any) => r.id));
    for (let i = 0; i < ids.length; i++) {
      await env.DB.prepare('UPDATE paper_items SET pos = ? WHERE id = ? AND paper_id = ?').bind(i, ids[i], pid).run();
    }
    await env.DB.prepare("UPDATE papers SET ordered = 0, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(now(), pid, uid)
      .run();
    return json({ ok: true });
  }

  // 确认组卷：卷子本质上也是一份作业，确认时要归到「教材（必选）→ 单元 → 课文（可选）」，
  // 并立刻生成一条作业记录（status=pending = 未作答），这样它马上出现在作业列表里。
  if (p.startsWith('/papers/') && p.endsWith('/finalize') && method === 'POST') {
    const pid = p.slice('/papers/'.length, -'/finalize'.length);
    const paper = await ownPaper(env, pid, uid);
    const body = await req.json<any>().catch(() => ({}));
    const title = String(body.title || '').trim();

    if (!paper.textbook_id) {
      // 第一次确认：教材必选
      const tbId = String(body.textbook_id || '').trim();
      if (!tbId) throw new HttpError(400, '先选这本卷子属于哪本教材');
      const tb = await env.DB.prepare('SELECT id FROM textbooks WHERE id = ? AND user_id = ?').bind(tbId, uid).first<any>();
      if (!tb) throw new HttpError(400, '所选教材不存在');
      let lessonId: string | null = String(body.lesson_id || '').trim() || null;
      let unitId: string | null = String(body.unit_id || '').trim() || null;
      if (lessonId) {
        const ls = await env.DB.prepare('SELECT id, unit_id FROM lessons WHERE id = ? AND user_id = ?')
          .bind(lessonId, uid)
          .first<any>();
        if (!ls) throw new HttpError(400, '所选课文不存在');
        if (!unitId) unitId = ls.unit_id || null;
      } else {
        lessonId = null;
      }
      // 幂等：已经建过作业条目就复用，别重复插入
      let subId: string = paper.submission_id || '';
      if (!subId) {
        const exist = await env.DB.prepare('SELECT id FROM submissions WHERE paper_id = ?').bind(pid).first<any>();
        subId = exist?.id || '';
      }
      if (!subId) {
        subId = uuid();
        await env.DB.prepare(
          `INSERT INTO submissions (id, user_id, kind, lesson_id, unit_id, textbook_id, paper_id, status, created_at)
           VALUES (?, ?, 'paper', ?, ?, ?, ?, 'pending', ?)`,
        )
          .bind(subId, uid, lessonId, unitId, tbId, pid, now())
          .run();
      } else {
        await env.DB.prepare('UPDATE submissions SET lesson_id = ?, unit_id = ?, textbook_id = ? WHERE id = ? AND user_id = ?')
          .bind(lessonId, unitId, tbId, subId, uid)
          .run();
      }
      await env.DB.prepare(
        'UPDATE papers SET status = ?, title = ?, textbook_id = ?, unit_id = ?, lesson_id = ?, submission_id = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      )
        .bind('final', title ? title.slice(0, 60) : paper.title, tbId, unitId, lessonId, subId, now(), pid, uid)
        .run();
      return json({ ok: true, submission_id: subId });
    }

    // 已经确认过：只允许改标题 / 改归类
    if (title) {
      await env.DB.prepare('UPDATE papers SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .bind(title.slice(0, 60), now(), pid, uid)
        .run();
    }
    if ('textbook_id' in body || 'lesson_id' in body || 'unit_id' in body) {
      const tbId = String(body.textbook_id || paper.textbook_id || '').trim();
      if (!tbId) throw new HttpError(400, '这本卷子还没选教材');
      let lessonId: string | null = String(body.lesson_id || '').trim() || null;
      let unitId: string | null = String(body.unit_id || '').trim() || null;
      if (lessonId) {
        const ls = await env.DB.prepare('SELECT id, unit_id FROM lessons WHERE id = ? AND user_id = ?')
          .bind(lessonId, uid)
          .first<any>();
        if (!ls) throw new HttpError(400, '所选课文不存在');
        if (!unitId) unitId = ls.unit_id || null;
      }
      await env.DB.prepare('UPDATE papers SET textbook_id = ?, unit_id = ?, lesson_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .bind(tbId, unitId, lessonId, now(), pid, uid)
        .run();
      if (paper.submission_id) {
        await env.DB.prepare('UPDATE submissions SET lesson_id = ?, unit_id = ?, textbook_id = ? WHERE id = ? AND user_id = ?')
          .bind(lessonId, unitId, tbId, paper.submission_id, uid)
          .run();
      }
    }
    return json({ ok: true, submission_id: paper.submission_id || '' });
  }

  if (p.startsWith('/papers/') && method === 'DELETE') {
    const pid = p.slice('/papers/'.length);
    const pp = await ownPaper(env, pid, uid);
    if (pp?.submission_id) await deleteSubmission(env, String(pp.submission_id));
    await env.DB.prepare('DELETE FROM submissions WHERE paper_id = ? AND user_id = ?').bind(pid, uid).run();
    await env.DB.prepare('DELETE FROM paper_items WHERE paper_id = ? AND user_id = ?').bind(pid, uid).run();
    await env.DB.prepare('DELETE FROM papers WHERE id = ? AND user_id = ?').bind(pid, uid).run();
    return json({ ok: true });
  }

  // 提交卷子答案：把拍下来的答卷挂到「确认组卷」时生成的那条作业记录上，再走正常批改
  if (p.startsWith('/papers/') && p.endsWith('/answer') && method === 'POST') {
    const pid = p.slice('/papers/'.length, -'/answer'.length);
    const paper = await ownPaper(env, pid, uid);
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) throw new HttpError(400, '没有收到图片');
    const ext = extOf(file.name);
    if (ext === 'heic' || ext === 'heif') {
      throw new HttpError(
        400,
        'HEIC 格式的照片大模型读不了。请在 iPhone「设置 → 相机 → 格式」里改成「兼容性最佳」，或者截图后再上传。',
      );
    }
    if (file.size > 10 * 1024 * 1024) throw new HttpError(400, '图片太大了（超过 10MB），请压缩或截图后再传。');

    let subId: string = paper.submission_id || '';
    if (!subId) {
      const exist = await env.DB.prepare('SELECT id FROM submissions WHERE paper_id = ?').bind(pid).first<any>();
      subId = exist?.id || '';
    }
    if (!subId) {
      // 兜底：万一卷子没走确认流程，这里补一条作业记录
      subId = uuid();
      await env.DB.prepare(
        `INSERT INTO submissions (id, user_id, kind, lesson_id, textbook_id, paper_id, status, created_at)
         VALUES (?, ?, 'paper', ?, ?, ?, 'grading', ?)`,
      )
        .bind(subId, uid, paper.lesson_id || null, paper.textbook_id || null, pid, now())
        .run();
      await env.DB.prepare('UPDATE papers SET submission_id = ? WHERE id = ? AND user_id = ?').bind(subId, pid, uid).run();
    }

    const key = `orig/${subId}.${ext}`;
    await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: contentTypeOf(key) } });
    const thumbKey = await storeThumb(env, form, subId);
    await env.DB.prepare(
      "UPDATE submissions SET image_key = ?, thumb_key = ?, status = 'grading', error_msg = NULL WHERE id = ? AND user_id = ?",
    )
      .bind(key, thumbKey, subId, uid)
      .run();
    await env.DB.prepare('DELETE FROM submission_pages WHERE submission_id = ?').bind(subId).run();
    await env.DB.prepare(
      'INSERT INTO submission_pages (id, submission_id, pos, image_key, thumb_key, created_at) VALUES (?,?,0,?,?,?)',
    )
      .bind(uuid(), subId, key, thumbKey, now())
      .run();
    return json({ id: subId, image_key: key });
  }

  if (p === '/submissions' && method === 'GET') {
    const lessonId = (url.searchParams.get('lesson') || '').trim();
    const unitId = (url.searchParams.get('unit') || '').trim();
    const tbId = (url.searchParams.get('textbook') || '').trim();
    // 组卷确认后生成的 kind='paper' 条目也算作业（未作答时 status='pending'）
    // 归属可能有两条路：作业/课文 → lessons.unit_id；组卷只选了单元没选课文时 → submissions.unit_id。
    // 用 eff_* 统一算出来，前端不用关心它属于哪种情况。
    let sql = `SELECT s.*, l.name AS lesson_name, l.sort AS lesson_sort,
        COALESCE(l.unit_id, s.unit_id) AS eff_unit_id,
        COALESCE(u.name, su.name) AS eff_unit_name,
        COALESCE(u.textbook_id, su.textbook_id, s.textbook_id) AS eff_textbook_id,
        COALESCE(t.name, st.name) AS eff_textbook_name,
        pt.name AS paper_textbook_name, pp.title AS paper_title
       FROM submissions s
       LEFT JOIN lessons l ON l.id = s.lesson_id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN textbooks t ON t.id = u.textbook_id
       LEFT JOIN units su ON su.id = s.unit_id
       LEFT JOIN textbooks st ON st.id = COALESCE(s.textbook_id, su.textbook_id)
       LEFT JOIN textbooks pt ON pt.id = s.textbook_id
       LEFT JOIN papers pp ON pp.id = s.paper_id
       WHERE s.user_id = ? AND s.kind IN ('homework','paper')`;
    const binds: any[] = [uid];
    if (lessonId === '__none') {
      // 只看「没归类」的作业
      sql += ' AND s.lesson_id IS NULL';
    } else if (lessonId) {
      sql += ' AND s.lesson_id = ?';
      binds.push(lessonId);
    } else if (unitId) {
      sql += ' AND COALESCE(l.unit_id, s.unit_id) = ?';
      binds.push(unitId);
    } else if (tbId) {
      // 关键：未归类的作业 lesson_id 是 NULL，LEFT JOIN 后 u.textbook_id 也是 NULL，
      // 只写 u.textbook_id = ? 会把它们全过滤掉，用户会以为作业丢了。
      // 按教材筛选时应当同时带上未归类的；组卷条目则可能只归到了教材（lesson_id 为空）。
      sql += ` AND (u.textbook_id = ? OR su.textbook_id = ? OR s.textbook_id = ?
                   OR (s.lesson_id IS NULL AND s.unit_id IS NULL AND s.textbook_id IS NULL))`;
      binds.push(tbId, tbId, tbId);
    }
    sql += ' ORDER BY s.created_at DESC LIMIT 200';
    const rows = await env.DB.prepare(sql).bind(...binds).all<any>();
    const subs = rows.results || [];

    /* 题目 / 变式题 / 页数 / 卷子题数 一次拿齐，在内存里分组。
       以前是「每份作业查一次题目、每道题再查一次变式题」——3 份作业 63 题就是 70 次 D1 往返，
       实测首页要 25 秒。现在固定 4 条查询（并行），只花一次往返的时间。
       注意：这两条 SQL 只取 computeMastery 真正用到的字段，别顺手改成 SELECT *
       （题目逐年累积，长文本会把首页请求拖大）。 */
    const [qRes, vRes, pgRes, piRes] = await Promise.all([
      env.DB.prepare('SELECT id, submission_id, is_correct, seq FROM questions WHERE user_id = ?')
        .bind(uid)
        .all<any>(),
      env.DB.prepare('SELECT parent_id, status, done_at FROM variants WHERE user_id = ?')
        .bind(uid)
        .all<any>(),
      env.DB.prepare(
        'SELECT submission_id, COUNT(*) AS c FROM submission_pages WHERE submission_id IN (SELECT id FROM submissions WHERE user_id = ?) GROUP BY submission_id',
      )
        .bind(uid)
        .all<any>(),
      env.DB.prepare('SELECT paper_id, COUNT(*) AS c FROM paper_items WHERE user_id = ? GROUP BY paper_id')
        .bind(uid)
        .all<any>(),
    ]);
    const qBySub = new Map<string, any[]>();
    for (const q of qRes.results || []) {
      const a = qBySub.get(q.submission_id);
      if (a) a.push(q);
      else qBySub.set(q.submission_id, [q]);
    }
    const vByParent = new Map<string, any[]>();
    for (const v of vRes.results || []) {
      const a = vByParent.get(v.parent_id);
      if (a) a.push(v);
      else vByParent.set(v.parent_id, [v]);
    }
    const pgCount = new Map<string, number>();
    for (const r of pgRes.results || []) pgCount.set(r.submission_id, Number(r.c || 0));
    const piCount = new Map<string, number>();
    for (const r of piRes.results || []) piCount.set(r.paper_id, Number(r.c || 0));

    const out = [];
    for (const s of subs) {
      const list = (qBySub.get(s.id) || []).sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
      let passed = 0;
      for (const q of list) {
        // computeMastery 只读 status / done_at（selected 只影响「选了 N 题」的显示，列表用不到）
        const vs = (vByParent.get(q.id) || []) as any as VariantRow[];
        const m = computeMastery(q, vs);
        if (m.passed) passed += 1;
      }
      const pgc = pgCount.get(s.id) || 0;
      // 卷子还没交答案时没有题目，题量按卷子本身的题目数显示
      let total = list.length;
      if (!total && s.paper_id) total = piCount.get(s.paper_id) || 0;
      out.push({
        ...s,
        // 统一成前端一直用的字段名（作业走课文、组卷走 submissions.unit_id，两条路都折算到这里）
        unit_id: s.eff_unit_id || '',
        unit_name: s.eff_unit_name || '',
        textbook_id: s.eff_textbook_id || s.textbook_id || '',
        textbook_name: s.eff_textbook_name || '',
        total,
        wrong: list.filter((q) => Number(q.is_correct) === 0).length,
        passed,
        paper_title: s.paper_title || '',
        pages: Number(pgc) || (s.image_key ? 1 : 0),
        // 作答状态按「有没有题目」判定，跟是不是组卷无关：
        // 组卷刚发出去、或任何一份还没做出来的作业，都是 pending（未作答）。
        state:
          s.status === 'error'
            ? 'error'
            : s.status === 'grading'
              ? 'grading'
              : list.length > 0
                ? 'answered'
                : 'pending',
      });
    }
    return json({ submissions: out });
  }

  /* ------------------- 作业图片编辑：加页 / 换图 / 删页 / 单页重批 ------------------- */

  const subPagesMatch = /^\/submissions\/([a-z0-9]+)\/pages$/.exec(p);
  const subPageMatch = /^\/submissions\/([a-z0-9]+)\/pages\/([a-z0-9]+)$/.exec(p);
  const subPageGradeMatch = /^\/submissions\/([a-z0-9]+)\/pages\/([a-z0-9]+)\/grade$/.exec(p);

  // 加一页（追加到末尾）
  if (subPagesMatch && method === 'POST') {
    const subId = subPagesMatch[1];
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND user_id = ?').bind(subId, uid).first<any>();
    if (!sub) throw new HttpError(404, '这份作业不存在，刷新一下再试');
    const { buf, ext, thumb } = await readImageForm(req);
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM submission_pages WHERE submission_id = ?')
      .bind(subId)
      .first<any>();
    const n = Number(cnt?.c || 0);
    if (n >= 8) throw new HttpError(400, '一份作业最多 8 页，多了分成两份交吧。');
    const pageId = uuid();
    const key = `page/${subId}-${pageId}.${ext}`;
    await env.IMAGES.put(key, buf, { httpMetadata: { contentType: contentTypeOf(key) } });
    let thumbKey: string | null = null;
    if (thumb) {
      thumbKey = `thumb/${subId}-${pageId}.jpg`;
      await env.IMAGES.put(thumbKey, await thumb.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } }).catch(() => { thumbKey = null; });
    }
    await env.DB.prepare('INSERT INTO submission_pages (id, submission_id, pos, image_key, thumb_key, created_at) VALUES (?,?,?,?,?,?)')
      .bind(pageId, subId, n, key, thumbKey, now())
      .run();
    // 组卷作业原本没有 image_key，列表缩略图要指到第一页
    if (!sub.image_key) {
      await env.DB.prepare('UPDATE submissions SET image_key = ?, thumb_key = ? WHERE id = ?').bind(key, thumbKey, subId).run();
    }
    return json({ page: { id: pageId, pos: n, image_key: key } });
  }

  // 换掉某一页的图片（不动已批改的题目，是否重批由前端决定）
  if (subPageMatch && method === 'PUT') {
    const subId = subPageMatch[1];
    const pageId = subPageMatch[2];
    const own = await env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND user_id = ?').bind(subId, uid).first<any>();
    if (!own) throw new HttpError(404, '这份作业不存在，刷新一下再试');
    const pg = await env.DB.prepare('SELECT * FROM submission_pages WHERE id = ? AND submission_id = ?')
      .bind(pageId, subId)
      .first<any>();
    if (!pg) throw new HttpError(404, '这一页不存在，刷新一下再试');
    const { buf, ext, thumb } = await readImageForm(req);
    // key 里带一段随机：图片 URL 是按 key 拼的，key 不变的话浏览器会一直放旧图（换完看不到新照片）
    const key = `page/${subId}-${pageId}-${uuid().slice(0, 6)}.${ext}`;
    await env.IMAGES.put(key, buf, { httpMetadata: { contentType: contentTypeOf(key) } });
    let thumbKey: string | null = null;
    if (thumb) {
      thumbKey = `thumb/${subId}-${pageId}-${uuid().slice(0, 6)}.jpg`;
      await env.IMAGES.put(thumbKey, await thumb.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } }).catch(() => { thumbKey = null; });
    }
    await env.DB.prepare('UPDATE submission_pages SET image_key = ?, thumb_key = ? WHERE id = ?').bind(key, thumbKey, pageId).run();
    if (pg.image_key && pg.image_key !== key) await env.IMAGES.delete(pg.image_key).catch(() => {});
    if (pg.thumb_key && pg.thumb_key !== thumbKey) await env.IMAGES.delete(pg.thumb_key).catch(() => {});
    if (Number(pg.pos) === 0) {
      await env.DB.prepare('UPDATE submissions SET image_key = ?, thumb_key = ? WHERE id = ?').bind(key, thumbKey, subId).run();
    }
    return json({ page: { id: pageId, pos: Number(pg.pos), image_key: key } });
  }

  // 删掉某一页。?keep=1 → 保留这一页已批改的题目（page 置空）；否则题目一起删
  if (subPageMatch && method === 'DELETE') {
    const subId = subPageMatch[1];
    const pageId = subPageMatch[2];
    const own = await env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND user_id = ?').bind(subId, uid).first<any>();
    if (!own) throw new HttpError(404, '这份作业不存在，刷新一下再试');
    const keepRaw = String(url.searchParams.get('keep') || '').toLowerCase();
    const keep = keepRaw === '1' || keepRaw === 'true' || keepRaw === 'yes';

    const pgs = await env.DB.prepare('SELECT * FROM submission_pages WHERE submission_id = ? ORDER BY pos ASC')
      .bind(subId)
      .all<any>();
    const all = pgs.results || [];
    const target = all.find((r: any) => r.id === pageId);
    if (!target) throw new HttpError(404, '这一页不存在，刷新一下再试');
    if (all.length <= 1) {
      throw new HttpError(400, '作业至少要留一页。想整份删掉，点下面的「删除这份作业」。');
    }

    const pageNo = Number(target.pos) + 1;
    const qs = await env.DB.prepare('SELECT id FROM questions WHERE submission_id = ? AND page = ?')
      .bind(subId, pageNo)
      .all<any>();
    const qids = (qs.results || []).map((r: any) => r.id);
    if (keep) {
      await env.DB.prepare('UPDATE questions SET page = NULL WHERE submission_id = ? AND page = ?')
        .bind(subId, pageNo)
        .run();
    } else {
      for (const qid of qids) await deleteQuestion(env, qid);
    }

    await env.DB.prepare('DELETE FROM submission_pages WHERE id = ?').bind(pageId).run();
    if (target.image_key) await env.IMAGES.delete(target.image_key).catch(() => {});
    if (target.thumb_key) await env.IMAGES.delete(target.thumb_key).catch(() => {});

    // 后面的页依次前移，并把它们名下题目的 page 一起改掉（要用旧值做映射，不能边改边查）
    const rest = all.filter((r: any) => r.id !== pageId);
    const map = new Map<number, number>();
    rest.forEach((r: any, i: number) => map.set(Number(r.pos) + 1, i + 1));
    for (let i = 0; i < rest.length; i++) {
      await env.DB.prepare('UPDATE submission_pages SET pos = ? WHERE id = ?').bind(i, rest[i].id).run();
    }
    const remaining = await env.DB.prepare('SELECT id, page FROM questions WHERE submission_id = ?')
      .bind(subId)
      .all<any>();
    for (const q of remaining.results || []) {
      if (q.page == null) continue;
      const np = map.get(Number(q.page));
      if (np && np !== Number(q.page)) {
        await env.DB.prepare('UPDATE questions SET page = ? WHERE id = ?').bind(np, q.id).run();
      }
    }
    await renumberQuestionsByPage(env, subId);
    await env.DB.prepare('UPDATE submissions SET image_key = ?, thumb_key = ? WHERE id = ?')
      .bind(rest[0]?.image_key || null, rest[0]?.thumb_key || null, subId)
      .run();
    return json({ ok: true, deleted_questions: keep ? 0 : qids.length, kept_questions: keep ? qids.length : 0 });
  }

  // 只重批某一页（同样改成后台队列，避免同步等模型超时）
  if (subPageGradeMatch && method === 'POST') {
    const subId = subPageGradeMatch[1];
    const pageId = subPageGradeMatch[2];
    const sub = await env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND user_id = ?').bind(subId, uid).first<any>();
    if (!sub) throw new HttpError(404, '提交不存在');
    await enqueueGrade(env, { type: 'page', submissionId: subId, pageId, uid });
    return json({ queued: true, submission_id: subId, page_id: pageId });
  }

  const subMatch = /^\/submissions\/([a-z0-9]+)$/.exec(p);
  if (subMatch && method === 'GET') {
    // 4 条查询互不依赖，一次并行发：作业、题目、页。变式题等拿到题目 id 后单独查一趟。
    const [sub, qs, pgs] = await Promise.all([
      env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND user_id = ?').bind(subMatch[1], uid).first<any>(),
      env.DB.prepare('SELECT * FROM questions WHERE submission_id = ? ORDER BY seq ASC').bind(subMatch[1]).all<any>(),
      env.DB.prepare('SELECT * FROM submission_pages WHERE submission_id = ? ORDER BY pos ASC').bind(subMatch[1]).all<any>(),
    ]);
    if (!sub) throw new HttpError(404, '提交不存在');
    const list = qs.results || [];
    // 详情页要返回每道题的举一反三 + 掌握度。以前是一道题查一次变式题（N+1），
    // 24 题就是 24 次串行 D1 往返，详情页光接口就要 1.7s。改成一次按 parent_id 全查、
    // 内存分组，跟首页列表一样只花一趟。
    const questions = await attachMasteryBatch(env, list);
    // 多页作业：把所有页按顺序返回，详情页要一张张显示
    let pages = (pgs.results || []).filter((r: any) => r.image_key);
    if (!pages.length && sub.image_key) {
      // 多页功能上线前的老作业没有页记录：补一条，这样它也能换图 / 加页
      const pid = uuid();
      await env.DB.prepare('INSERT INTO submission_pages (id, submission_id, pos, image_key, thumb_key, created_at) VALUES (?,?,0,?,?,?)')
        .bind(pid, sub.id, sub.image_key, sub.thumb_key, now())
        .run();
      pages = [{ id: pid, submission_id: sub.id, pos: 0, image_key: sub.image_key }];
    }
    return json({ submission: sub, questions, pages });
  }

  const qMatch = /^\/questions\/([a-z0-9]+)$/.exec(p);
  if (qMatch && method === 'GET') {
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').bind(qMatch[1], uid).first<any>();
    if (!q) throw new HttpError(404, '题目不存在');
    return json({ question: await questionWithMastery(env, q) });
  }

  // 手动改判母题（对错 / 内容）
  if (qMatch && method === 'PATCH') {
    const body = await req.json<any>();
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').bind(qMatch[1], uid).first<any>();
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
       WHERE id = ? AND user_id = ?`,
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
        uid,
      )
      .run();
    const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').bind(qMatch[1], uid).first<any>();
    return json({ question: await questionWithMastery(env, updated) });
  }

  if (qMatch && method === 'DELETE') {
    const row = await env.DB.prepare('SELECT submission_id FROM questions WHERE id = ? AND user_id = ?')
      .bind(qMatch[1], uid)
      .first<any>();
    if (row) await deleteQuestion(env, qMatch[1]);
    if (row?.submission_id) await pruneEmptySubmission(env, row.submission_id);
    return json({ ok: true });
  }

  /* ------------------------------------------------------- 举一反三 */
  // 生成
  if (/^\/questions\/([a-z0-9]+)\/variants\/generate$/.test(p) && method === 'POST') {
    const m = /^\/questions\/([a-z0-9]+)\/variants\/generate$/.exec(p)!;
    const parentId = m[1];
    const body = await req.json<any>().catch(() => ({}));
    const count = Math.min(Math.max(Number(body.count) || 6, 1), 12);
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').bind(parentId, uid).first<any>();
    if (!q) throw new HttpError(404, '题目不存在');
    const s = await getSettings(env, uid);

    const text = await llm(
      env,
      uid,
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
        `INSERT INTO variants (id, user_id, parent_id, seq, stem, answer, solution, difficulty, selected, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,0,'pending',?)`,
      )
        .bind(
          id,
          uid,
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
      await env.DB.prepare('UPDATE variants SET selected = 0 WHERE parent_id = ? AND user_id = ?').bind(parentId, uid).run();
    }
    for (const id of ids) {
      await env.DB.prepare('UPDATE variants SET selected = 1 WHERE id = ? AND user_id = ?').bind(id, uid).run();
    }
    return json({ ok: true });
  }

  // 手动改判变式题
  const vMatch = /^\/variants\/([a-z0-9]+)$/.exec(p);
  if (vMatch && method === 'PATCH') {
    const body = await req.json<any>();
    const v = await env.DB.prepare('SELECT * FROM variants WHERE id = ? AND user_id = ?').bind(vMatch[1], uid).first<any>();
    if (!v) throw new HttpError(404, '题目不存在');
    const status = body.status ?? v.status;
    await env.DB.prepare(
      `UPDATE variants SET status = ?, student_answer = COALESCE(?, student_answer),
       comment = COALESCE(?, comment), done_at = ? WHERE id = ? AND user_id = ?`,
    )
      .bind(
        status,
        body.student_answer ?? null,
        body.comment ?? null,
        status === 'pending' ? null : v.done_at || now(),
        vMatch[1],
        uid,
      )
      .run();
    return json({ ok: true });
  }

  if (vMatch && method === 'DELETE') {
    const own = await env.DB.prepare('SELECT id FROM variants WHERE id = ? AND user_id = ?').bind(vMatch[1], uid).first<any>();
    if (!own) throw new HttpError(404, '题目不存在');
    await env.DB.prepare('DELETE FROM paper_queue WHERE variant_id = ? AND user_id = ?').bind(vMatch[1], uid).run();
    await env.DB.prepare('DELETE FROM variants WHERE id = ? AND user_id = ?').bind(vMatch[1], uid).run();
    return json({ ok: true });
  }

  // 上传举一反三答案照片并批改
  if (/^\/questions\/([a-z0-9]+)\/variant-answer$/.test(p) && method === 'POST') {
    const m = /^\/questions\/([a-z0-9]+)\/variant-answer$/.exec(p)!;
    const parentId = m[1];
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').bind(parentId, uid).first<any>();
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

    const s = await getSettings(env, uid);
    const text = await llm(
      env,
      uid,
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
        `UPDATE variants SET status = ?, student_answer = ?, comment = ?, attempt_image_key = ?, done_at = ?, selected = 1 WHERE id = ? AND user_id = ?`,
      )
        .bind(ok ? 'correct' : 'wrong', String(r.student_answer ?? ''), String(r.comment ?? ''), key, now(), target.id, uid)
        .run();
      graded.push({ ...target, status: ok ? 'correct' : 'wrong', student_answer: String(r.student_answer ?? ''), comment: String(r.comment ?? ''), attempt_image_key: key });
    }
    if (!graded.length) {
      throw new HttpError(502, '照片里没有匹配到这道题的举一反三作答，可以拍得更清楚一点，或在下方手动标记。');
    }

    await env.DB.prepare(
      "INSERT INTO submissions (id, user_id, kind, parent_id, image_key, status, created_at) VALUES (?, ?, 'variant', ?, ?, 'graded', ?)",
    )
      .bind(subId, uid, parentId, key, now())
      .run();

    const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').bind(parentId, uid).first<any>();
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
    const rows = await env.DB.prepare('SELECT * FROM textbooks WHERE user_id = ? ORDER BY sort, name').bind(uid).all<any>();
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
    const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM textbooks WHERE user_id = ?').bind(uid).first<any>();
    await env.DB.prepare('INSERT INTO textbooks (id, user_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,1,?)')
      .bind(id, uid, name, Number(mx?.m || 0) + 1, now())
      .run();
    return json({ ok: true, id });
  }

  if (p === '/textbook' && method === 'GET') {
    const tb = url.searchParams.get('textbook');
    return json({ units: await textbookTree(env, uid, tb || undefined) });
  }

  if (p === '/units' && method === 'POST') {
    const body = await req.json<any>();
    const name = String(body?.name || '').trim();
    if (!name) throw new HttpError(400, '单元名称不能为空');
    const tbId = String(body?.textbook_id || (await defaultTextbookId(env, uid)) || '');
    if (tbId) {
      const own = await env.DB.prepare('SELECT id FROM textbooks WHERE id = ? AND user_id = ?').bind(tbId, uid).first<any>();
      if (!own) throw new HttpError(400, '所选教材不存在');
    }
    const id = 'cu' + uuid();
    const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM units WHERE textbook_id = ?')
      .bind(tbId)
      .first<any>();
    await env.DB.prepare(
      'INSERT INTO units (id, user_id, textbook_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,?,1,?)',
    )
      .bind(id, uid, tbId, name, Number(mx?.m || 0) + 1, now())
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
      unitId = await ensureCustomUnit(env, uid, String(body?.textbook_id || '') || undefined);
    } else {
      const own = await env.DB.prepare('SELECT id FROM units WHERE id = ? AND user_id = ?').bind(unitId, uid).first<any>();
      if (!own) throw new HttpError(400, '所选单元不存在');
    }
    const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM lessons WHERE unit_id = ?')
      .bind(unitId)
      .first<any>();
    const id = 'cl' + uuid();
    await env.DB.prepare('INSERT INTO lessons (id, user_id, unit_id, name, sort, is_custom, created_at) VALUES (?,?,?,?,?,1,?)')
      .bind(id, uid, unitId, name, Number(mx?.m || 0) + 1, now())
      .run();
    return json({ ok: true, id, unit_id: unitId });
  }

  const unitMatch = /^\/units\/([A-Za-z0-9_]+)$/.exec(p);
  if (unitMatch && method === 'DELETE') {
    const row = await env.DB.prepare('SELECT * FROM units WHERE id = ? AND user_id = ?').bind(unitMatch[1], uid).first<any>();
    if (!row) throw new HttpError(404, '单元不存在');
    if (!Number(row.is_custom)) throw new HttpError(400, '教材自带的单元不能删除。');
    await env.DB.prepare('UPDATE submissions SET lesson_id = NULL WHERE lesson_id IN (SELECT id FROM lessons WHERE unit_id = ?)')
      .bind(row.id)
      .run();
    // 只挂了单元、没挂课文的组卷条目，单元没了也要跟着清空
    await env.DB.prepare('UPDATE submissions SET unit_id = NULL WHERE unit_id = ? AND user_id = ?').bind(row.id, uid).run();
    await env.DB.prepare('UPDATE papers SET unit_id = NULL WHERE unit_id = ? AND user_id = ?').bind(row.id, uid).run();
    await env.DB.prepare('DELETE FROM lessons WHERE unit_id = ? AND user_id = ?').bind(row.id, uid).run();
    await env.DB.prepare('DELETE FROM units WHERE id = ? AND user_id = ?').bind(row.id, uid).run();
    return json({ ok: true });
  }

  const lessonMatch = /^\/lessons\/([A-Za-z0-9_]+)$/.exec(p);
  if (lessonMatch && method === 'DELETE') {
    const row = await env.DB.prepare('SELECT * FROM lessons WHERE id = ? AND user_id = ?').bind(lessonMatch[1], uid).first<any>();
    if (!row) throw new HttpError(404, '课文不存在');
    if (!Number(row.is_custom)) throw new HttpError(400, '教材自带的课文不能删除。');
    await env.DB.prepare('UPDATE submissions SET lesson_id = NULL WHERE lesson_id = ? AND user_id = ?').bind(row.id, uid).run();
    await env.DB.prepare('DELETE FROM lessons WHERE id = ? AND user_id = ?').bind(row.id, uid).run();
    return json({ ok: true });
  }

  if (lessonMatch && method === 'PATCH') {
    const body = await req.json<any>();
    const row = await env.DB.prepare('SELECT * FROM lessons WHERE id = ? AND user_id = ?').bind(lessonMatch[1], uid).first<any>();
    if (!row) throw new HttpError(404, '课文不存在');
    await env.DB.prepare('UPDATE lessons SET name = ?, unit_id = ? WHERE id = ? AND user_id = ?')
      .bind(String(body?.name ?? row.name).trim() || row.name, String(body?.unit_id ?? row.unit_id), row.id, uid)
      .run();
    return json({ ok: true });
  }

  /* ------------------------------------------------- 作业删除 / 归类 */
  if (p === '/submissions/batch-delete' && method === 'POST') {
    const body = await req.json<any>();
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
    if (!ids.length) throw new HttpError(400, '没有选中任何作业');
    for (const sid of ids) {
      const own = await env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND user_id = ?').bind(sid, uid).first<any>();
      if (own) await deleteSubmission(env, String(sid));
    }
    return json({ ok: true, deleted: ids.length });
  }

  if (subMatch && method === 'DELETE') {
    const own = await env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND user_id = ?')
      .bind(subMatch[1], uid)
      .first<any>();
    if (!own) throw new HttpError(404, '提交不存在');
    await deleteSubmission(env, subMatch[1]);
    return json({ ok: true });
  }

  if (subMatch && method === 'PATCH') {
    const body = await req.json<any>();
    const lessonId = body?.lesson_id === undefined ? undefined : body.lesson_id ? String(body.lesson_id) : null;
    if (lessonId === undefined) throw new HttpError(400, '缺少 lesson_id');
    if (lessonId) {
      const own = await env.DB.prepare('SELECT id FROM lessons WHERE id = ? AND user_id = ?').bind(lessonId, uid).first<any>();
      if (!own) throw new HttpError(400, '所选课文不存在');
    }
    const r = await env.DB.prepare('UPDATE submissions SET lesson_id = ? WHERE id = ? AND user_id = ?')
      .bind(lessonId, subMatch[1], uid)
      .run();
    if (!Number(r?.meta?.changes || 0)) throw new HttpError(404, '提交不存在');
    return json({ ok: true });
  }

  return json({ error: '接口不存在: ' + p }, 404);
}
