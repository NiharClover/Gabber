ALTER TABLE users ADD COLUMN IF NOT EXISTS can_access_forensics BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS forensic_access_logs (
  id             BIGSERIAL PRIMARY KEY,
  reviewer_id    VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  lookup_type    VARCHAR(30) NOT NULL,
  lookup_value   TEXT NOT NULL,
  result_found   BOOLEAN NOT NULL,
  requester_ip   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forensic_access_logs_reviewer
  ON forensic_access_logs(reviewer_id, created_at DESC);
