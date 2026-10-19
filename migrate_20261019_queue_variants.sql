-- 待组卷支持「举一反三的变式题」：question_id 允许为空，另加 variant_id。
-- 一行要么是母题、要么是变式题，两者互斥；各自用部分唯一索引去重。
-- 注意：本脚本只能执行一次（DROP/RENAME 不是幂等的）。
CREATE TABLE IF NOT EXISTS paper_queue_new (
  id          TEXT PRIMARY KEY,
  question_id TEXT,
  variant_id  TEXT,
  created_at  TEXT
);

INSERT INTO paper_queue_new (id, question_id, variant_id, created_at)
  SELECT id, question_id, NULL, created_at FROM paper_queue;

DROP TABLE paper_queue;
ALTER TABLE paper_queue_new RENAME TO paper_queue;

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_queue_q ON paper_queue (question_id) WHERE question_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_queue_v ON paper_queue (variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paper_queue_created ON paper_queue (created_at);
