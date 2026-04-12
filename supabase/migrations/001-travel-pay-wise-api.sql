-- ============================================================================
-- VITTA TRAVEL PAY - DATABASE MIGRATION (Revised for Wise API)
-- Version: 2.0
-- Date: 2026-04-10
-- Description: Complete schema for Wise API integration matching official API flow
--
-- Wise API Flow:
--   1. Create Quote         → wise_quotes table
--   2. Create/Get Recipient → wise_recipients table (NEW!)
--   3. Create Transfer      → wise_transfers table
--   4. Fund Transfer        → wise_payments table (NEW!)
--   5. Poll Status          → wise_transfer_events table (NEW!)
-- ============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. UPI_SCANS TABLE
-- ============================================================================
-- Purpose: Store QR code scans and extracted UPI payment details
-- Wise API: None (pre-Wise step)
-- Links to: wise_quotes, wise_recipients, wise_transfers
-- ============================================================================

CREATE TABLE IF NOT EXISTS upi_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- QR Code Data
  raw_qr_data TEXT NOT NULL,
  upi_id VARCHAR(255) NOT NULL,                    -- merchant@paytm
  payee_name VARCHAR(255),
  amount NUMERIC(12,2),
  currency VARCHAR(3) DEFAULT 'INR',
  transaction_note TEXT,
  merchant_code VARCHAR(100),

  -- Scan Metadata
  scan_location JSONB,                             -- {lat, lng, city, country}
  device_info JSONB,                               -- {device, browser, os}
  scan_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Processing Status (tracks progress through Wise API flow)
  status VARCHAR(50) DEFAULT 'scanned',
  -- Status values:
  --   'scanned'            → QR code scanned
  --   'quoted'             → Quote created
  --   'recipient_created'  → Recipient account created/retrieved
  --   'transfer_initiated' → Transfer created but not funded
  --   'paid'               → Transfer funded and processing
  --   'failed'             → Error occurred
  --   'cancelled'          → User cancelled

  -- Foreign Keys (populated as flow progresses)
  wise_quote_id UUID,                              -- Set after quote creation
  wise_recipient_id UUID,                          -- Set after recipient creation
  wise_transfer_id UUID,                           -- Set after transfer creation

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT check_scan_status CHECK (
    status IN ('scanned', 'quoted', 'recipient_created', 'transfer_initiated', 'paid', 'failed', 'cancelled')
  )
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_upi_scans_user_id ON upi_scans(user_id);
CREATE INDEX IF NOT EXISTS idx_upi_scans_status ON upi_scans(status);
CREATE INDEX IF NOT EXISTS idx_upi_scans_upi_id ON upi_scans(upi_id);
CREATE INDEX IF NOT EXISTS idx_upi_scans_created_at ON upi_scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upi_scans_wise_quote_id ON upi_scans(wise_quote_id);
CREATE INDEX IF NOT EXISTS idx_upi_scans_wise_recipient_id ON upi_scans(wise_recipient_id);
CREATE INDEX IF NOT EXISTS idx_upi_scans_wise_transfer_id ON upi_scans(wise_transfer_id);

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_upi_scans_updated_at
  BEFORE UPDATE ON upi_scans
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 2. WISE_QUOTES TABLE
-- ============================================================================
-- Purpose: Store quotes from Wise Quote API
-- Wise API: POST /v3/quotes
-- Response: {id, rate, sourceAmount, targetAmount, fee, expirationTime, rateType}
-- ============================================================================

CREATE TABLE IF NOT EXISTS wise_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upi_scan_id UUID REFERENCES upi_scans(id),

  -- Wise Quote API Response
  wise_quote_id VARCHAR(255) UNIQUE NOT NULL,       -- Wise's quote.id (UUID string format, VARCHAR for API compatibility)
  source_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  target_currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  source_amount NUMERIC(10,2) NOT NULL,
  target_amount NUMERIC(12,2) NOT NULL,
  exchange_rate NUMERIC(18,8) NOT NULL,             -- quote.rate (high precision for large transfers)

  -- Fee Structure (from quote.paymentOptions[0].fee)
  fee_total NUMERIC(10,2) DEFAULT 0,                -- quote.fee.total (total fees charged to user)
  fee_transferwise NUMERIC(10,2) DEFAULT 0,         -- quote.fee.transferwise (Wise's cut)
  fee_partner NUMERIC(10,2) DEFAULT 0,              -- Vitta's markup/profit (use this for internal accounting)
  total_debit NUMERIC(10,2) NOT NULL,               -- sourceAmount + fee_total (what user actually pays)

  -- Quote Type & Validity
  rate_type VARCHAR(50) DEFAULT 'FIXED',            -- quote.rateType: FIXED or FLOATING
  payment_type VARCHAR(50) DEFAULT 'BALANCE',       -- quote.paymentType
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,     -- quote.expirationTime
  rate_expiry_time TIMESTAMP WITH TIME ZONE,        -- quote.rateExpiryTime (for FLOATING)

  -- Status Tracking
  status VARCHAR(50) DEFAULT 'active',
  used_for_transfer_id UUID,                        -- Set when used in transfer

  -- Full API Response (for debugging/audit)
  wise_api_response JSONB,

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT check_quote_status CHECK (status IN ('active', 'used', 'expired', 'cancelled'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wise_quotes_user_id ON wise_quotes(user_id);
CREATE INDEX IF NOT EXISTS idx_wise_quotes_wise_id ON wise_quotes(wise_quote_id);
CREATE INDEX IF NOT EXISTS idx_wise_quotes_expires_at ON wise_quotes(expires_at);
CREATE INDEX IF NOT EXISTS idx_wise_quotes_status ON wise_quotes(status);
CREATE INDEX IF NOT EXISTS idx_wise_quotes_upi_scan_id ON wise_quotes(upi_scan_id);

CREATE TRIGGER trg_wise_quotes_updated_at
  BEFORE UPDATE ON wise_quotes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 3. WISE_RECIPIENTS TABLE (NEW!)
-- ============================================================================
-- Purpose: Store Wise recipient accounts (reusable across transfers)
-- Wise API: POST /v1/accounts (create) or GET /v1/accounts (retrieve)
-- Response: {id, currency, type, details}
--
-- KEY BENEFIT: Recipients are reusable!
-- - First payment to merchant@paytm → Create recipient account (Wise ID: 789)
-- - Second payment to same UPI ID → Reuse existing recipient (Wise ID: 789)
-- - Avoids API calls and speeds up transfers
-- ============================================================================

CREATE TABLE IF NOT EXISTS wise_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Wise Recipient API Response
  wise_account_id BIGINT UNIQUE NOT NULL,           -- Wise's account.id (numeric)
  wise_profile_id BIGINT NOT NULL,                  -- Wise profile that owns this recipient

  -- Recipient Basic Info
  account_holder_name VARCHAR(255) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  type VARCHAR(50) NOT NULL,                        -- 'indian_upi' for UPI payments

  -- UPI-Specific Details (from details field)
  legal_type VARCHAR(50),                           -- 'PRIVATE' or 'BUSINESS'
  upi_id VARCHAR(255) NOT NULL,                     -- details.vpa (e.g., merchant@paytm)

  -- Business/Merchant Details (optional)
  business_type VARCHAR(100),                       -- If legal_type='BUSINESS'
  business_name VARCHAR(255),

  -- Recipient Status
  is_active BOOLEAN DEFAULT true,
  is_verified BOOLEAN DEFAULT false,                -- Set to true after first successful transfer

  -- Usage Tracking
  total_transfers INT DEFAULT 0,                    -- Incremented on each use
  last_used_at TIMESTAMP WITH TIME ZONE,

  -- Full API Response
  wise_api_response JSONB,

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Unique constraint: One UPI ID per user per Wise profile
  CONSTRAINT unique_user_upi UNIQUE (user_id, upi_id, wise_profile_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wise_recipients_user_id ON wise_recipients(user_id);
CREATE INDEX IF NOT EXISTS idx_wise_recipients_wise_account_id ON wise_recipients(wise_account_id);
CREATE INDEX IF NOT EXISTS idx_wise_recipients_upi_id ON wise_recipients(upi_id);
CREATE INDEX IF NOT EXISTS idx_wise_recipients_is_active ON wise_recipients(is_active);
CREATE INDEX IF NOT EXISTS idx_wise_recipients_profile_id ON wise_recipients(wise_profile_id);

CREATE TRIGGER trg_wise_recipients_updated_at
  BEFORE UPDATE ON wise_recipients
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 4. WISE_TRANSFERS TABLE
-- ============================================================================
-- Purpose: Store transfer records from Wise Transfer API
-- Wise API: POST /v1/transfers
-- Response: {id, status, sourceAmount, targetAmount, rate, reference}
-- ============================================================================

CREATE TABLE IF NOT EXISTS wise_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upi_scan_id UUID REFERENCES upi_scans(id),

  -- Wise Transfer API Response
  wise_transfer_id BIGINT UNIQUE NOT NULL,          -- Wise's transfer.id (numeric)

  -- Foreign Keys to Quote & Recipient
  wise_quote_id UUID NOT NULL REFERENCES wise_quotes(id),
  wise_recipient_id UUID NOT NULL REFERENCES wise_recipients(id),

  -- Transfer Amounts (from Transfer API response)
  source_amount NUMERIC(10,2) NOT NULL,
  source_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  target_amount NUMERIC(12,2) NOT NULL,
  target_currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  exchange_rate NUMERIC(18,8) NOT NULL,             -- High precision for accurate calculations

  -- Transfer Details
  reference VARCHAR(255),                           -- transfer.reference (user-visible)
  customer_transaction_id UUID UNIQUE NOT NULL,     -- Our idempotency key (prevents duplicate transfers)

  -- Transfer Status (from Wise API)
  wise_status VARCHAR(100) NOT NULL,                -- Wise's detailed status
  -- Wise status values:
  --   'incoming_payment_waiting' → Waiting for funding
  --   'processing'               → Transfer in progress
  --   'outgoing_payment_sent'    → Money sent to recipient
  --   'funds_converted'          → Currency converted
  --   'bounced_back'             → Transfer failed
  --   'charged_back'             → Reversed

  status VARCHAR(50) NOT NULL DEFAULT 'pending',    -- Our simplified status
  -- Our status values: pending, processing, completed, failed, cancelled

  -- Delivery Estimates
  estimated_delivery_at TIMESTAMP WITH TIME ZONE,
  actual_delivery_at TIMESTAMP WITH TIME ZONE,

  -- Polling Optimization (prevents API rate limit hits)
  next_poll_at TIMESTAMP WITH TIME ZONE,            -- Next scheduled status poll (exponential backoff)

  -- Payment Information (populated after funding)
  is_funded BOOLEAN DEFAULT false,
  funded_at TIMESTAMP WITH TIME ZONE,
  wise_payment_id UUID,                             -- Links to wise_payments table

  -- Error Handling
  error_code VARCHAR(100),
  error_message TEXT,

  -- Full API Response
  wise_api_response JSONB,

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT check_transfer_status CHECK (
    status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')
  )
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wise_transfers_user_id ON wise_transfers(user_id);
CREATE INDEX IF NOT EXISTS idx_wise_transfers_wise_id ON wise_transfers(wise_transfer_id);
CREATE INDEX IF NOT EXISTS idx_wise_transfers_quote_id ON wise_transfers(wise_quote_id);
CREATE INDEX IF NOT EXISTS idx_wise_transfers_recipient_id ON wise_transfers(wise_recipient_id);
CREATE INDEX IF NOT EXISTS idx_wise_transfers_status ON wise_transfers(status);
CREATE INDEX IF NOT EXISTS idx_wise_transfers_wise_status ON wise_transfers(wise_status);
CREATE INDEX IF NOT EXISTS idx_wise_transfers_created_at ON wise_transfers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wise_transfers_upi_scan_id ON wise_transfers(upi_scan_id);
CREATE INDEX IF NOT EXISTS idx_wise_transfers_customer_tx_id ON wise_transfers(customer_transaction_id);

CREATE TRIGGER trg_wise_transfers_updated_at
  BEFORE UPDATE ON wise_transfers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 5. WISE_PAYMENTS TABLE (NEW!)
-- ============================================================================
-- Purpose: Store payment/funding records (Step 4 of Wise API flow)
-- Wise API: POST /v3/profiles/{profileId}/transfers/{transferId}/payments
-- Response: {status, type, balanceTransactionId}
--
-- WHY SEPARATE TABLE?
-- - Transfer creation (step 3) ≠ Payment/funding (step 4)
-- - Wise requires explicit funding step
-- - Enables payment retry logic if funding fails
-- ============================================================================

CREATE TABLE IF NOT EXISTS wise_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Link to Transfer
  wise_transfer_id UUID NOT NULL REFERENCES wise_transfers(id) ON DELETE CASCADE,

  -- Payment Method
  payment_type VARCHAR(50) NOT NULL,                -- 'BALANCE', 'BANK_TRANSFER', 'CARD', etc.
  funding_source VARCHAR(255),                      -- e.g., 'Wise Balance', 'Plaid Account: *1234'

  -- Payment Status (from Wise Payment API)
  wise_payment_status VARCHAR(100),                 -- 'COMPLETED', 'PENDING', 'FAILED'
  balance_transaction_id BIGINT,                    -- Wise's internal transaction ID

  -- Amount Details
  amount NUMERIC(10,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',

  -- Timing
  payment_initiated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  payment_completed_at TIMESTAMP WITH TIME ZONE,

  -- Error Handling
  error_code VARCHAR(100),
  error_message TEXT,

  -- Full API Response
  wise_api_response JSONB,

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wise_payments_user_id ON wise_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_wise_payments_transfer_id ON wise_payments(wise_transfer_id);
CREATE INDEX IF NOT EXISTS idx_wise_payments_status ON wise_payments(wise_payment_status);
CREATE INDEX IF NOT EXISTS idx_wise_payments_created_at ON wise_payments(created_at DESC);

CREATE TRIGGER trg_wise_payments_updated_at
  BEFORE UPDATE ON wise_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 6. WISE_TRANSFER_EVENTS TABLE (NEW!)
-- ============================================================================
-- Purpose: Audit trail of all transfer status changes and events
-- Wise API: GET /v1/transfers/{id} (polling) or Webhooks
--
-- WHY THIS TABLE?
-- - Complete audit trail of every status change
-- - Enables debugging transfer issues
-- - Powers webhook integration
-- - Tracks timeline of transfer lifecycle
-- ============================================================================

CREATE TABLE IF NOT EXISTS wise_transfer_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wise_transfer_id UUID NOT NULL REFERENCES wise_transfers(id) ON DELETE CASCADE,

  -- Event Details
  event_type VARCHAR(100) NOT NULL,                 -- 'status_change', 'webhook', 'poll_update', 'error', 'manual'
  old_status VARCHAR(100),                          -- Previous wise_status
  new_status VARCHAR(100) NOT NULL,                 -- New wise_status

  -- Wise API Data
  wise_event_data JSONB,                            -- Full event payload

  -- Source of Event
  source VARCHAR(50) NOT NULL,                      -- 'api_poll', 'webhook', 'manual', 'system'

  -- Event Metadata
  event_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  notes TEXT,                                       -- Human-readable notes

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wise_transfer_events_transfer_id ON wise_transfer_events(wise_transfer_id);
CREATE INDEX IF NOT EXISTS idx_wise_transfer_events_event_type ON wise_transfer_events(event_type);
CREATE INDEX IF NOT EXISTS idx_wise_transfer_events_source ON wise_transfer_events(source);
CREATE INDEX IF NOT EXISTS idx_wise_transfer_events_created_at ON wise_transfer_events(created_at DESC);

-- ============================================================================
-- 7. TRAVEL_PAY_SETTINGS TABLE
-- ============================================================================
-- Purpose: User preferences and settings for Travel Pay features
-- Wise API: None (app-specific)
-- ============================================================================

CREATE TABLE IF NOT EXISTS travel_pay_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Notification Preferences
  notify_on_scan BOOLEAN DEFAULT true,
  notify_on_quote_expiry BOOLEAN DEFAULT true,
  notify_on_transfer_complete BOOLEAN DEFAULT true,
  notify_on_status_change BOOLEAN DEFAULT true,

  -- Auto-behavior
  auto_approve_under_amount NUMERIC(10,2),          -- Auto-approve if amount < $X
  require_biometric BOOLEAN DEFAULT true,

  -- Wise Profile Settings
  default_wise_profile_id BIGINT,                   -- User's Wise profile ID
  preferred_funding_source VARCHAR(50) DEFAULT 'BALANCE',

  -- Transaction Limits
  daily_limit_usd NUMERIC(10,2) DEFAULT 1000,
  per_transaction_limit_usd NUMERIC(10,2) DEFAULT 500,
  monthly_limit_usd NUMERIC(12,2) DEFAULT 5000,

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TRIGGER trg_travel_pay_settings_updated_at
  BEFORE UPDATE ON travel_pay_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 8. ADD FOREIGN KEY CONSTRAINTS TO UPI_SCANS
-- ============================================================================
-- Add foreign key constraints AFTER all tables are created
-- ============================================================================

ALTER TABLE upi_scans
  ADD CONSTRAINT fk_upi_scans_wise_quote
  FOREIGN KEY (wise_quote_id)
  REFERENCES wise_quotes(id)
  ON DELETE SET NULL;

ALTER TABLE upi_scans
  ADD CONSTRAINT fk_upi_scans_wise_recipient
  FOREIGN KEY (wise_recipient_id)
  REFERENCES wise_recipients(id)
  ON DELETE SET NULL;

ALTER TABLE upi_scans
  ADD CONSTRAINT fk_upi_scans_wise_transfer
  FOREIGN KEY (wise_transfer_id)
  REFERENCES wise_transfers(id)
  ON DELETE SET NULL;

-- ============================================================================
-- 9. ADD FOREIGN KEY CONSTRAINT TO WISE_TRANSFERS
-- ============================================================================

ALTER TABLE wise_transfers
  ADD CONSTRAINT fk_wise_transfers_payment
  FOREIGN KEY (wise_payment_id)
  REFERENCES wise_payments(id)
  ON DELETE SET NULL;

-- ============================================================================
-- 10. UPDATE EXISTING TRANSFERS TABLE (for backward compatibility)
-- ============================================================================
-- Add Wise-specific columns to existing transfers table
-- This allows legacy Chimoney transfers to coexist with new Wise transfers
-- ============================================================================

ALTER TABLE transfers
  ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50) DEFAULT 'chimoney';

ALTER TABLE transfers
  ADD COLUMN IF NOT EXISTS provider_transfer_id VARCHAR(255);

ALTER TABLE transfers
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'bank_transfer';

-- Add constraints
ALTER TABLE transfers
  DROP CONSTRAINT IF EXISTS check_payment_provider;

ALTER TABLE transfers
  ADD CONSTRAINT check_payment_provider
  CHECK (payment_provider IN ('chimoney', 'wise'));

ALTER TABLE transfers
  DROP CONSTRAINT IF EXISTS check_payment_method;

ALTER TABLE transfers
  ADD CONSTRAINT check_payment_method
  CHECK (payment_method IN ('bank_transfer', 'upi', 'card'));

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_transfers_provider ON transfers(payment_provider);
CREATE INDEX IF NOT EXISTS idx_transfers_provider_id ON transfers(provider_transfer_id);

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- Verify all tables created
DO $$
DECLARE
  table_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN (
    'upi_scans',
    'wise_quotes',
    'wise_recipients',
    'wise_transfers',
    'wise_payments',
    'wise_transfer_events',
    'travel_pay_settings'
  );

  RAISE NOTICE 'Travel Pay migration complete. Created/verified % tables.', table_count;
END $$;
