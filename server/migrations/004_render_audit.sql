-- 渲染审计：记录每次单份/批量 Docx 生成的运行时元数据，供出问题时回溯。
-- 只存元数据（模板、状态、变量计数、下载位置、调用方），不存变量值本身（隐私）。
CREATE TABLE IF NOT EXISTS render_audit (
  id             BIGSERIAL PRIMARY KEY,
  request_id     TEXT NOT NULL,
  template_id    TEXT,
  version_id     TEXT,
  source         TEXT NOT NULL,          -- single | batch
  status         TEXT NOT NULL,          -- success | failed
  error_message  TEXT,
  variable_count INTEGER,
  missing_count  INTEGER,
  storage        TEXT,                   -- local | oss | tos
  download_path  TEXT,
  size_bytes     BIGINT,
  caller         TEXT,                   -- api-key | session
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_render_audit_request_id ON render_audit (request_id);
CREATE INDEX IF NOT EXISTS idx_render_audit_template_created ON render_audit (template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_render_audit_created ON render_audit (created_at DESC);
