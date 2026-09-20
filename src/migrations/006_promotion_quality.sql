-- P4: auditable promotion events and supported placement normalization.
UPDATE ads SET ad_type='explore' WHERE ad_type='banner';
UPDATE ads SET ad_type='card' WHERE ad_type NOT IN ('card','explore');

CREATE TABLE IF NOT EXISTS ad_events (
  id VARCHAR(100) PRIMARY KEY,
  ad_id VARCHAR(50) NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  user_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('impression','click')),
  placement VARCHAR(30) NOT NULL CHECK (placement IN ('chat_list','explore')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_events_ad_created ON ad_events(ad_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_events_user_created ON ad_events(user_id,created_at DESC);
