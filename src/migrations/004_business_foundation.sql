-- P2: coherent business, catalogue, verification and order lifecycle.

CREATE UNIQUE INDEX IF NOT EXISTS uq_businesses_user_id ON businesses(user_id);

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- verification_status is authoritative. `verified` remains only as a
-- compatibility mirror for old code/data and cannot drift independently.
CREATE OR REPLACE FUNCTION sync_business_verified_flag()
RETURNS TRIGGER AS $$
BEGIN
  NEW.verified := (NEW.verification_status = 'verified');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_business_verified ON businesses;
CREATE TRIGGER trg_sync_business_verified
BEFORE INSERT OR UPDATE OF verification_status, verified ON businesses
FOR EACH ROW EXECUTE FUNCTION sync_business_verified_flag();

UPDATE businesses SET verified = (verification_status = 'verified');

CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_business_created ON orders(business_id, created_at DESC);
