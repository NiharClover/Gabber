CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id           VARCHAR(50) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hide_sender_name  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS view_once_receipts (
  message_id  VARCHAR(50) REFERENCES messages(id) ON DELETE CASCADE,
  user_id     VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_view_once_receipts_user
  ON view_once_receipts(user_id, viewed_at DESC);
