-- P3: indexed nearby discovery and conflict-safe booking lifecycle.
CREATE INDEX IF NOT EXISTS idx_businesses_discovery
  ON businesses(verification_status, type, lat, lng)
  WHERE verification_status='verified' AND lat IS NOT NULL AND lng IS NOT NULL;

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

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_active_slot
  ON bookings(slot_id) WHERE status IN ('pending','confirmed');
CREATE INDEX IF NOT EXISTS idx_booking_slots_business_start ON booking_slots(business_id,start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer_created ON bookings(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_business_created ON bookings(business_id,created_at DESC);
