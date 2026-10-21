-- Businesses may sell through chat without operating a delivery fleet.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS fulfillment_modes JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE businesses
SET fulfillment_modes = CASE
  WHEN type = 'hotel' THEN '["appointment","chat_only"]'::jsonb
  WHEN type = 'service' THEN '["appointment","on_site_service","chat_only"]'::jsonb
  WHEN type IN ('restaurant','food_stall') THEN '["pickup","in_store","chat_only"]'::jsonb
  ELSE '["pickup","in_store","chat_only"]'::jsonb
END
WHERE fulfillment_modes = '[]'::jsonb;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fulfillment_type VARCHAR(30) NOT NULL DEFAULT 'merchant_delivery';
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_type_check
  CHECK (fulfillment_type IN ('pickup','in_store','merchant_delivery','customer_courier'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending','confirmed','preparing','ready','delivered','collected','cancelled'));

CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_status
  ON orders(fulfillment_type, status, created_at DESC);

