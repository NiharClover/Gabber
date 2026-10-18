ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_trade_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_registry_status VARCHAR(30);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_reference_id VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_registration_date DATE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_name_match BOOLEAN;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_checked_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_provider VARCHAR(30);

CREATE INDEX IF NOT EXISTS idx_businesses_gstin_reference_id
  ON businesses(gstin_reference_id)
  WHERE gstin_reference_id IS NOT NULL;
