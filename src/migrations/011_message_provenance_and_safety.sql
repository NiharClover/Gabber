CREATE TABLE IF NOT EXISTS media_assets (
  id                   VARCHAR(50) PRIMARY KEY,
  uploader_id          VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  origin_asset_id      VARCHAR(50) REFERENCES media_assets(id) ON DELETE SET NULL,
  media_type           VARCHAR(10) NOT NULL CHECK (media_type IN ('image','video')),
  url                  TEXT UNIQUE NOT NULL,
  filename             TEXT NOT NULL,
  sha256               VARCHAR(64) NOT NULL,
  perceptual_hash      VARCHAR(64),
  scan_status          VARCHAR(20) NOT NULL DEFAULT 'sanitized'
                       CHECK (scan_status IN ('sanitized','clean','pending','blocked')),
  scan_details         JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_sha256 ON media_assets(sha256);
CREATE INDEX IF NOT EXISTS idx_media_assets_perceptual_hash ON media_assets(perceptual_hash)
  WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_origin ON media_assets(origin_asset_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_message_id VARCHAR(50)
  REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provenance_root_message_id VARCHAR(50)
  REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provenance_origin_sender_id VARCHAR(50)
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provenance_kind VARCHAR(20) NOT NULL DEFAULT 'original';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forward_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_sha256 VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS safety_status VARCHAR(20) NOT NULL DEFAULT 'safe';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS safety_flags JSONB NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_messages_forwarded_from') THEN
    ALTER TABLE messages ADD CONSTRAINT fk_messages_forwarded_from
      FOREIGN KEY (forwarded_from_message_id) REFERENCES messages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_messages_provenance_root') THEN
    ALTER TABLE messages ADD CONSTRAINT fk_messages_provenance_root
      FOREIGN KEY (provenance_root_message_id) REFERENCES messages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_messages_provenance_origin_sender') THEN
    ALTER TABLE messages ADD CONSTRAINT fk_messages_provenance_origin_sender
      FOREIGN KEY (provenance_origin_sender_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_messages_forward_depth') THEN
    ALTER TABLE messages ADD CONSTRAINT ck_messages_forward_depth CHECK (forward_depth >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_messages_safety_status') THEN
    ALTER TABLE messages ADD CONSTRAINT ck_messages_safety_status
      CHECK (safety_status IN ('safe','caution','blocked','unscanned'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_messages_provenance_kind') THEN
    ALTER TABLE messages ADD CONSTRAINT ck_messages_provenance_kind
      CHECK (provenance_kind IN ('original','forwarded','copied_media','copied_text'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_messages_forwarded_from ON messages(forwarded_from_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_provenance_root ON messages(provenance_root_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_content_sha256 ON messages(content_sha256);
