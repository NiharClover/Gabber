-- P0/P1: message idempotency, per-user visibility/receipts, and
-- race-safe canonical direct-chat creation.

ALTER TABLE chats ADD COLUMN IF NOT EXISTS direct_key VARCHAR(101);

-- Retire the legacy verification boolean as an independent source of truth.
UPDATE businesses
SET verified = (verification_status = 'verified')
WHERE verified IS DISTINCT FROM (verification_status = 'verified');

WITH direct_pairs AS (
  SELECT c.id,
         string_agg(cm.user_id, ':' ORDER BY cm.user_id) AS pair_key
  FROM chats c
  JOIN chat_members cm ON cm.chat_id = c.id
  WHERE c.type = 'direct'
  GROUP BY c.id
  HAVING COUNT(*) = 2
), ranked_pairs AS (
  SELECT id, pair_key,
         row_number() OVER (PARTITION BY pair_key ORDER BY id) AS pair_rank
  FROM direct_pairs
)
UPDATE chats c
SET direct_key = rp.pair_key
FROM ranked_pairs rp
WHERE c.id = rp.id
  AND rp.pair_rank = 1
  AND c.direct_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chats_direct_key
  ON chats(direct_key)
  WHERE type = 'direct' AND direct_key IS NOT NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_sender_client_id
  ON messages(sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_user_deletions (
  message_id  VARCHAR(50) REFERENCES messages(id) ON DELETE CASCADE,
  user_id     VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

INSERT INTO message_user_deletions (message_id, user_id, deleted_at)
SELECT id, sender_id, COALESCE(created_at, NOW())
FROM messages
WHERE deleted_for_sender=TRUE AND sender_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id    VARCHAR(50) REFERENCES messages(id) ON DELETE CASCADE,
  user_id       VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(10) NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'delivered', 'read')),
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_receipts_user_status
  ON message_receipts(user_id, status);

INSERT INTO message_receipts (message_id, user_id, status, delivered_at, read_at)
SELECT m.id,
       cm.user_id,
       m.status,
       CASE WHEN m.status IN ('delivered','read') THEN m.created_at ELSE NULL END,
       CASE WHEN m.status = 'read' THEN m.created_at ELSE NULL END
FROM messages m
JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id!=m.sender_id
ON CONFLICT (message_id, user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_message_user_deletions_user
  ON message_user_deletions(user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND confrelid = 'chats'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (chat_id)%'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_chat
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;
