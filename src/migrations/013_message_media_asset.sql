ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_asset_id VARCHAR(50)
  REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_media_asset ON messages(media_asset_id)
  WHERE media_asset_id IS NOT NULL;
