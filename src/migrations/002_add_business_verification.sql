-- 002_add_business_verification.sql
--
-- Adds an identity-verification system for businesses that is completely
-- independent from monetization. `verification_status` and `plan` must
-- never be coupled by any application code path — see business.js and
-- routes/admin.js for the enforcement of that rule.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'unverified';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verification_docs JSONB DEFAULT '[]';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin_legal_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verified_by VARCHAR(50);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'free';

-- Constrain to known values. Wrapped in DO blocks so this is safe to re-run
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_verification_status') THEN
    ALTER TABLE businesses
      ADD CONSTRAINT chk_verification_status
      CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plan') THEN
    ALTER TABLE businesses
      ADD CONSTRAINT chk_plan
      CHECK (plan IN ('free', 'pro'));
  END IF;
END $$;

-- One-time backfill from the legacy boolean `verified` column, if it has
-- data already. Does not run again on subsequent migrate.js runs since it
-- only touches rows still at the default 'unverified' status.
UPDATE businesses
SET verification_status = 'verified'
WHERE verified = TRUE AND verification_status = 'unverified';

-- Admin flag for the manual review queue (routes/admin.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_businesses_verification_status ON businesses(verification_status);
CREATE INDEX IF NOT EXISTS idx_businesses_gst_number ON businesses(gst_number);