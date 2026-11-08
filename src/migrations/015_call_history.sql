CREATE TABLE IF NOT EXISTS call_history (
  id              VARCHAR(64) PRIMARY KEY,
  caller_id       VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id       VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_type       VARCHAR(10) NOT NULL CHECK (call_type IN ('voice', 'video')),
  status          VARCHAR(12) NOT NULL DEFAULT 'ringing'
                  CHECK (status IN ('ringing', 'connected', 'completed', 'missed', 'rejected', 'cancelled')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at     TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  missed_seen_at  TIMESTAMPTZ,
  CHECK (caller_id <> callee_id)
);

CREATE INDEX IF NOT EXISTS idx_call_history_caller_started
  ON call_history(caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_history_callee_started
  ON call_history(callee_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_history_unseen_missed
  ON call_history(callee_id, started_at DESC)
  WHERE status='missed' AND missed_seen_at IS NULL;
