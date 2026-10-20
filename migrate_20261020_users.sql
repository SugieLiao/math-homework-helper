-- 多用户改造：每个用户的数据（作业、题目、变式、组卷、大纲、模型设置）彼此隔离。
-- 迁移前已经存在的所有数据，统一归到第一个用户「小七」。
-- 只执行一次（ALTER TABLE ADD COLUMN 重复执行会报错）。

-- ---------------------------------------------------------------- 用户
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  avatar     TEXT DEFAULT '',      -- emoji，界面上好区分
  sort       INTEGER DEFAULT 0,
  created_at TEXT
);

INSERT OR IGNORE INTO users (id, name, avatar, sort, created_at)
VALUES ('u_xiaoqi', '小七', '🐣', 0, datetime('now'));

-- ------------------------------------------------- 全局配置（家庭口令，只有一份）
CREATE TABLE IF NOT EXISTS app_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  passcode   TEXT DEFAULT '',
  updated_at TEXT
);

INSERT OR IGNORE INTO app_config (id, passcode, updated_at)
SELECT 1, IFNULL((SELECT passcode FROM settings WHERE id = 1), ''), datetime('now');

-- ------------------------------------------------- 每个用户一份 AI / 年级设置
CREATE TABLE IF NOT EXISTS user_settings (
  user_id              TEXT PRIMARY KEY,
  base_url             TEXT DEFAULT 'https://ark.cn-beijing.volces.com/api/v3',
  api_key              TEXT DEFAULT '',
  model                TEXT DEFAULT 'doubao-seed-2-0-mini-260428',
  grade                TEXT DEFAULT '一年级',
  student_name         TEXT DEFAULT '',
  text_base_url        TEXT DEFAULT '',
  text_api_key         TEXT DEFAULT '',
  text_model           TEXT DEFAULT '',
  active_vision_profile TEXT DEFAULT '',
  active_text_profile   TEXT DEFAULT '',
  thinking_mode        TEXT DEFAULT 'fast',
  updated_at           TEXT
);

INSERT OR IGNORE INTO user_settings
  (user_id, base_url, api_key, model, grade, student_name,
   text_base_url, text_api_key, text_model,
   active_vision_profile, active_text_profile, thinking_mode, updated_at)
SELECT 'u_xiaoqi', base_url, api_key, model, grade, student_name,
       text_base_url, text_api_key, text_model,
       active_vision_profile, active_text_profile, thinking_mode, updated_at
FROM settings WHERE id = 1;

-- --------------------------------------------- 各数据表补 user_id（老数据归小七）
ALTER TABLE textbooks      ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE units          ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE lessons        ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE submissions    ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE questions      ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE variants       ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE paper_queue    ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE papers         ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE paper_items    ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';
ALTER TABLE llm_profiles   ADD COLUMN user_id TEXT DEFAULT 'u_xiaoqi';

CREATE INDEX IF NOT EXISTS idx_textbooks_user  ON textbooks (user_id);
CREATE INDEX IF NOT EXISTS idx_units_user      ON units (user_id);
CREATE INDEX IF NOT EXISTS idx_lessons_user    ON lessons (user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_questions_user  ON questions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_variants_user   ON variants (user_id);
CREATE INDEX IF NOT EXISTS idx_paper_queue_user ON paper_queue (user_id);
CREATE INDEX IF NOT EXISTS idx_papers_user     ON papers (user_id);
CREATE INDEX IF NOT EXISTS idx_paper_items_user ON paper_items (user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_user   ON llm_profiles (user_id);
