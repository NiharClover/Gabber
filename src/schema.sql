-- Gabber — Corrected Full Schema
--
-- schema.sql previously only defined users/chats/chat_members/messages, while
-- the route code (business.js, orders.js, ads.js, safety.js, status.js,
-- stickers.js, devices.js, groups.js, chats.js search, media.js view-once)
-- references many more tables/columns. This file is the single source of
-- truth going forward and is safe to re-run (CREATE TABLE IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS throughout).

-- ─── Users ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          VARCHAR(50) PRIMARY KEY,
  phone       VARCHAR(20) UNIQUE NOT NULL,
  username    VARCHAR(100) NOT NULL,
  avatar_url  TEXT,
  about       TEXT DEFAULT 'Hey there! I am using Gabber.',
  email       VARCHAR(100),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS about TEXT DEFAULT 'Hey there! I am using Gabber.';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100);

-- ─── Chats (direct or group) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id              VARCHAR(50) PRIMARY KEY,
  type            VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
  direct_key      VARCHAR(101),
  name            VARCHAR(100),
  description     TEXT,
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS direct_key VARCHAR(101);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chats_direct_key
  ON chats(direct_key) WHERE type = 'direct' AND direct_key IS NOT NULL;

-- ─── Chat membership ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    VARCHAR(50) REFERENCES chats(id) ON DELETE CASCADE,
  user_id    VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(10) DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

-- ─── Messages ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id                    VARCHAR(50) PRIMARY KEY,
  chat_id               VARCHAR(50) REFERENCES chats(id) ON DELETE CASCADE,
  sender_id             VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  client_message_id     VARCHAR(100),
  text                  TEXT,
  status                VARCHAR(10) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
  reply_to_id           VARCHAR(50),
  reply_to_text         TEXT,
  reply_to_sender       VARCHAR(100),
  deleted_for_everyone  BOOLEAN DEFAULT FALSE,
  deleted_for_sender    BOOLEAN DEFAULT FALSE,
  viewed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id VARCHAR(50);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_text TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_sender VARCHAR(100);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for_sender BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_sender_client_id
  ON messages(sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_user_deletions (
  message_id  VARCHAR(50) REFERENCES messages(id) ON DELETE CASCADE,
  user_id     VARCHAR(50) UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id    VARCHAR(50) REFERENCES messages(id) ON DELETE CASCADE,
  user_id       VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(10) NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'delivered', 'read')),
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_message_receipts_user_status ON message_receipts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_message_user_deletions_user ON message_user_deletions(user_id);

-- ─── Blocking & reporting (safety.js) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id  VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id           VARCHAR(50) PRIMARY KEY,
  reporter_id  VARCHAR(50) REFERENCES users(id),
  reported_id  VARCHAR(50) REFERENCES users(id),
  reason       VARCHAR(100),
  details      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Push notification tokens (devices.js) ─────────────────────────────
CREATE TABLE IF NOT EXISTS device_tokens (
  user_id      VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  push_token   TEXT NOT NULL,
  provider     VARCHAR(10) NOT NULL DEFAULT 'expo' CHECK (provider IN ('expo', 'fcm', 'apns')),
  platform     VARCHAR(10) CHECK (platform IN ('android', 'ios')),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, push_token)
);

-- ─── Stories / status (status.js) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS statuses (
  id          VARCHAR(50) PRIMARY KEY,
  user_id     VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(10) DEFAULT 'text' CHECK (type IN ('text', 'image')),
  content     TEXT NOT NULL,
  bg_color    VARCHAR(10) DEFAULT '#ff6b35',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE TABLE IF NOT EXISTS status_views (
  status_id   VARCHAR(50) REFERENCES statuses(id) ON DELETE CASCADE,
  viewer_id   VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (status_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS idx_statuses_expires_at ON statuses(expires_at);

-- ─── Businesses (business.js) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
  id          VARCHAR(50) PRIMARY KEY,
  user_id     VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  type        VARCHAR(50) DEFAULT 'general',
  phone       VARCHAR(20),
  address     TEXT,
  city        VARCHAR(50),
  pincode     VARCHAR(10),
  lat         DECIMAL(10,6),
  lng         DECIMAL(10,6),
  gst_number  VARCHAR(20),
  verified    BOOLEAN DEFAULT FALSE,
  verification_status VARCHAR(20) DEFAULT 'unverified'
              CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  verification_docs JSONB DEFAULT '[]',
  gstin_verified BOOLEAN DEFAULT FALSE,
  gstin_legal_name TEXT,
  gstin_trade_name TEXT,
  gstin_registry_status VARCHAR(30),
  gstin_reference_id VARCHAR(100),
  gstin_registration_date DATE,
  gstin_name_match BOOLEAN,
  gstin_checked_at TIMESTAMPTZ,
  gstin_provider VARCHAR(30),
  verified_at TIMESTAMPTZ,
  verified_by VARCHAR(50),
  rejection_reason TEXT,
  plan VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free','pro')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_trade_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_registry_status VARCHAR(30);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_reference_id VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_registration_date DATE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_name_match BOOLEAN;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_checked_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_provider VARCHAR(30);

-- ─── Menu / catalog items (business.js) ────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id            VARCHAR(50) PRIMARY KEY,
  business_id   VARCHAR(50) REFERENCES businesses(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  description   TEXT,
  price         DECIMAL(10,2) NOT NULL,
  category      VARCHAR(50) DEFAULT 'General',
  available     BOOLEAN DEFAULT TRUE,
  image_url     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Orders (orders.js) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id           VARCHAR(50) PRIMARY KEY,
  business_id  VARCHAR(50) REFERENCES businesses(id),
  customer_id  VARCHAR(50) REFERENCES users(id),
  chat_id      VARCHAR(50) REFERENCES chats(id) ON DELETE SET NULL,
  items        JSONB,
  total        DECIMAL(10,2),
  status       VARCHAR(20) DEFAULT 'pending'
               CHECK (status IN ('pending','confirmed','preparing','ready','delivered','cancelled')),
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT
);

CREATE TABLE IF NOT EXISTS booking_slots (
  id VARCHAR(50) PRIMARY KEY,
  business_id VARCHAR(50) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_at > start_at),
  UNIQUE (business_id, start_at)
);

CREATE TABLE IF NOT EXISTS bookings (
  id VARCHAR(50) PRIMARY KEY,
  business_id VARCHAR(50) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_id VARCHAR(50) NOT NULL REFERENCES booking_slots(id) ON DELETE RESTRICT,
  service_item_id VARCHAR(50) REFERENCES menu_items(id) ON DELETE SET NULL,
  chat_id VARCHAR(50) REFERENCES chats(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','completed','rejected','cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT
);

-- ─── Ads (ads.js) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  id                 VARCHAR(50) PRIMARY KEY,
  business_id        VARCHAR(50) REFERENCES businesses(id) ON DELETE CASCADE,
  title              VARCHAR(100),
  description        TEXT,
  image_url          TEXT,
  cta_text           VARCHAR(50) DEFAULT 'Learn More',
  cta_url            TEXT,
  ad_type            VARCHAR(20) DEFAULT 'card',
  target_city        VARCHAR(50),
  target_pincode     VARCHAR(10),
  target_lat         DECIMAL(10,6),
  target_lng         DECIMAL(10,6),
  target_radius_km   INTEGER DEFAULT 5,
  bid_amount         DECIMAL(10,2) DEFAULT 1.00,
  budget_total       DECIMAL(10,2) DEFAULT 1000.00,
  budget_remaining   DECIMAL(10,2) DEFAULT 1000.00,
  impressions        INTEGER DEFAULT 0,
  clicks             INTEGER DEFAULT 0,
  active             BOOLEAN DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ad_clicks (
  ad_id       VARCHAR(50) REFERENCES ads(id) ON DELETE CASCADE,
  user_id     VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  clicked_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ad_id, user_id)
);

CREATE TABLE IF NOT EXISTS ad_events (
  id VARCHAR(100) PRIMARY KEY,
  ad_id VARCHAR(50) NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  user_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('impression','click')),
  placement VARCHAR(30) NOT NULL CHECK (placement IN ('chat_list','explore')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── AI Stickers (stickers.js) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sticker_collections (
  id           VARCHAR(50) PRIMARY KEY,
  user_id      VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  svg          TEXT,
  description  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id         VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
  plan            VARCHAR(20) DEFAULT 'free',
  stickers_used   INTEGER DEFAULT 0,
  stickers_reset  TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ
);

-- ─── Indexes worth having at any real scale ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_businesses_user_id ON businesses(user_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_business_id ON menu_items(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_businesses_discovery ON businesses(verification_status, type, lat, lng)
  WHERE verification_status='verified' AND lat IS NOT NULL AND lng IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_active_slot ON bookings(slot_id)
  WHERE status IN ('pending','confirmed');
CREATE INDEX IF NOT EXISTS idx_booking_slots_business_start ON booking_slots(business_id,start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer_created ON bookings(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_business_created ON bookings(business_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_ad_events_ad_created ON ad_events(ad_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_id ON reports(reported_id);
