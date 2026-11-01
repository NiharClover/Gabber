CREATE TABLE IF NOT EXISTS message_trace_deliveries (
  message_id       VARCHAR(50) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_id     VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trace_code       VARCHAR(24) NOT NULL UNIQUE,
  delivered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_message_trace_recipient
  ON message_trace_deliveries(recipient_id, delivered_at DESC);
