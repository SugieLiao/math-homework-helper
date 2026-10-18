-- 数学家 · 数据库结构（Cloudflare D1 / SQLite）

CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  base_url      TEXT DEFAULT 'https://ark.cn-beijing.volces.com/api/v3',
  api_key       TEXT DEFAULT '',
  model         TEXT DEFAULT 'doubao-seed-2-0-mini-260428',
  grade         TEXT DEFAULT '一年级',
  student_name  TEXT DEFAULT '',
  passcode      TEXT DEFAULT '',
  -- 文本 / 推理模型槽位（出题、讲解，不用看图）。留空则自动回落用上面的视觉模型
  text_base_url TEXT DEFAULT '',
  text_api_key  TEXT DEFAULT '',
  text_model    TEXT DEFAULT '',
  -- 当前启用的「模型源」id（见 llm_profiles）。优先于上面 base_url/api_key/model 的旧写法
  active_vision_profile TEXT DEFAULT '',
  active_text_profile   TEXT DEFAULT '',
  -- 思考强度：fast = 关/低思考（一页 15~30 秒）；deep = 用模型默认（90~120 秒，可能超时）
  thinking_mode TEXT DEFAULT 'fast',
  updated_at    TEXT
);

INSERT OR IGNORE INTO settings (id, updated_at) VALUES (1, datetime('now'));

-- 教材（如「北师大版 四年级上册」）
CREATE TABLE IF NOT EXISTS textbooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort        INTEGER DEFAULT 0,
  is_custom   INTEGER DEFAULT 0,
  created_at  TEXT
);

-- 教材单元（如「一 认识更大的数」）
CREATE TABLE IF NOT EXISTS units (
  id          TEXT PRIMARY KEY,
  textbook_id TEXT,                  -- 属于哪本教材
  name        TEXT NOT NULL,
  sort        INTEGER DEFAULT 0,
  is_custom   INTEGER DEFAULT 0,   -- 1 = 家长自己建的，可删；0 = 教材自带
  created_at  TEXT
);

-- 课文 / 一课（如「数一数」「一单元复习」「邓老师题单二单元」）
CREATE TABLE IF NOT EXISTS lessons (
  id          TEXT PRIMARY KEY,
  unit_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  sort        INTEGER DEFAULT 0,
  is_custom   INTEGER DEFAULT 0,
  created_at  TEXT
);

-- 模型源库：可以同时保存多家配置（智谱 / 百炼 / 火山 / 硅基流动…），随时切换，互不覆盖
CREATE TABLE IF NOT EXISTS llm_profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,          -- 自定义名字，如「智谱免费视觉」
  base_url    TEXT NOT NULL,
  api_key     TEXT DEFAULT '',
  model       TEXT NOT NULL,
  -- vision = 能读照片（读题批改）；text = 纯文本（出题、讲解）
  kind        TEXT DEFAULT 'vision',
  note        TEXT DEFAULT '',
  created_at  TEXT,
  updated_at  TEXT
);

-- 一次拍照提交（作业 / 举一反三答案）
CREATE TABLE IF NOT EXISTS submissions (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- homework | variant
  parent_id   TEXT,                   -- kind=variant 时的母题 id
  lesson_id   TEXT,                   -- 归属课文（units/lessons），用于按单元复习
  image_key   TEXT,                   -- R2 原图
  status      TEXT DEFAULT 'graded',  -- grading | graded | error
  error_msg   TEXT,
  note        TEXT,
  created_at  TEXT
);

-- 母题（作业里识别出来的每一道题）
CREATE TABLE IF NOT EXISTS questions (
  id              TEXT PRIMARY KEY,
  submission_id   TEXT,
  seq             INTEGER,
  no              TEXT,               -- 题号
  stem            TEXT,               -- 题干
  student_answer  TEXT,               -- 学生作答（OCR 文本）
  correct_answer  TEXT,               -- 正确答案
  is_correct      INTEGER,            -- 1 对 / 0 错
  error_reason    TEXT,               -- 错因分析
  solution        TEXT,               -- 正确推导过程
  knowledge       TEXT,               -- 知识点
  answer_band     TEXT,               -- 答案区域纵向百分比 [y1,y2]（供前端裁剪）
  answer_image_key TEXT,              -- 答案区域裁剪图（R2）
  created_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_questions_sub ON questions (submission_id);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions (created_at);

-- 举一反三（变式题）
CREATE TABLE IF NOT EXISTS variants (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT NOT NULL,
  seq            INTEGER,
  stem           TEXT,
  answer         TEXT,
  solution       TEXT,
  difficulty     TEXT,                -- 略易 / 同等 / 略难
  selected       INTEGER DEFAULT 0,   -- 是否被用户选中练习
  status         TEXT DEFAULT 'pending', -- pending | correct | wrong
  student_answer TEXT,
  comment        TEXT,
  attempt_image_key TEXT,
  done_at        TEXT,
  created_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_variants_parent ON variants (parent_id);
