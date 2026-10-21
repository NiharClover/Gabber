-- Store whether a booking happens at the business or at the customer's address.
-- This is separate from migration 009 so already-upgraded servers receive it safely.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS fulfillment_type VARCHAR(30) NOT NULL DEFAULT 'appointment';
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS service_address TEXT;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_fulfillment_type_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_fulfillment_type_check
  CHECK (fulfillment_type IN ('appointment','on_site_service'));
