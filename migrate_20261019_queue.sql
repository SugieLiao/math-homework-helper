-- 2026-10-19：新增「待组卷题目」纸篓 + 组卷支持单元/原题模式
-- 只对已有库执行一次；ALTER 重复执行会报 duplicate column，可忽略

CREATE TABLE IF NOT EXISTS paper_queue (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL UNIQUE,
  created_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_queue_created ON paper_queue (created_at);

ALTER TABLE papers ADD COLUMN unit_id TEXT;
ALTER TABLE papers ADD COLUMN mode TEXT DEFAULT 'variant';
ALTER TABLE papers ADD COLUMN include_original INTEGER DEFAULT 0;
ALTER TABLE submissions ADD COLUMN unit_id TEXT;
