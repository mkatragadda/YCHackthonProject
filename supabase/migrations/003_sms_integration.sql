-- ============================================================================
-- SMS INTEGRATION MIGRATION
-- Version: 2.0 (WISE Compatible)
-- Date: 2026-05-17
-- ============================================================================

BEGIN;

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. USER PHONE NUMBERS
-- ============================================================================
CREATE TABLE user_phone_numbers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) NOT NULL,
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  is_verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  verification_code VARCHAR(6),
  verification_code_expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT phone_e164_format CHECK (phone_number ~ '^\+[1-9]\d{1,14}$')
);

CREATE UNIQUE INDEX idx_user_phones_number ON user_phone_numbers(phone_number)
  WHERE is_active = TRUE;
CREATE INDEX idx_user_phones_user ON user_phone_numbers(user_id);

-- ============================================================================
-- 2. SMS CONVERSATIONS
-- ============================================================================
CREATE TABLE sms_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  agentphone_conversation_id VARCHAR(255),
  state VARCHAR(50) NOT NULL DEFAULT 'idle',
  context JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes'),
  CONSTRAINT valid_state CHECK (
    state IN ('idle', 'awaiting_disambiguation', 'awaiting_amount',
              'awaiting_recipient', 'ready_for_confirmation')
  )
);

-- Create partial unique index AFTER table creation (fixes the syntax error)
CREATE UNIQUE INDEX idx_sms_conv_phone_active ON sms_conversations(phone_number)
  WHERE state != 'idle';

CREATE INDEX idx_sms_conv_phone ON sms_conversations(phone_number);
CREATE INDEX idx_sms_conv_user ON sms_conversations(user_id);
CREATE INDEX idx_sms_conv_state ON sms_conversations(state);

-- ============================================================================
-- 3. PENDING SMS TRANSFERS
-- ============================================================================
CREATE TABLE pending_sms_transfers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  conversation_id UUID REFERENCES sms_conversations(id),
  wise_recipient_id UUID REFERENCES wise_recipients(id) NOT NULL,
  source_amount DECIMAL(12, 2) NOT NULL,
  source_currency VARCHAR(3) DEFAULT 'USD',
  target_amount DECIMAL(12, 2),
  target_currency VARCHAR(3),
  exchange_rate DECIMAL(12, 6),
  wise_quote_id UUID REFERENCES wise_quotes(id),
  quote_expires_at TIMESTAMPTZ,
  raw_message TEXT NOT NULL,
  parsed_intent JSONB,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '15 minutes'),
  confirmed_at TIMESTAMPTZ,
  completed_transfer_id UUID REFERENCES wise_transfers(id),
  CONSTRAINT valid_status CHECK (
    status IN ('pending', 'confirmed', 'expired', 'cancelled', 'failed')
  ),
  CONSTRAINT valid_amount CHECK (source_amount > 0),
  CONSTRAINT valid_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_pending_sms_user ON pending_sms_transfers(user_id);
CREATE INDEX idx_pending_sms_status ON pending_sms_transfers(status)
  WHERE status = 'pending';
CREATE INDEX idx_pending_sms_wise_recipient ON pending_sms_transfers(wise_recipient_id);

-- ============================================================================
-- 4. SMS TRANSFER TOKENS
-- ============================================================================
CREATE TABLE sms_transfer_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) NOT NULL,
  pending_transfer_id UUID REFERENCES pending_sms_transfers(id) NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  short_token VARCHAR(10) NOT NULL UNIQUE,
  phone_number VARCHAR(20) NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  used_ip INET,
  used_user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT token_valid_expiry CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX idx_sms_tokens_short ON sms_transfer_tokens(short_token)
  WHERE is_used = FALSE;
CREATE INDEX idx_sms_tokens_pending ON sms_transfer_tokens(pending_transfer_id);

-- ============================================================================
-- 5. WISE RECIPIENT NICKNAMES
-- ============================================================================
CREATE TABLE wise_recipient_nicknames (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) NOT NULL,
  wise_recipient_id UUID REFERENCES wise_recipients(id) ON DELETE CASCADE NOT NULL,
  nickname VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT nickname_not_empty CHECK (LENGTH(TRIM(nickname)) > 0),
  UNIQUE(user_id, nickname),
  UNIQUE(user_id, wise_recipient_id, nickname)
);

CREATE INDEX idx_wise_recipient_nicknames_user ON wise_recipient_nicknames(user_id);
CREATE INDEX idx_wise_recipient_nicknames_recipient ON wise_recipient_nicknames(wise_recipient_id);

-- ============================================================================
-- 6. SMS MESSAGES LOG
-- ============================================================================
CREATE TABLE sms_messages_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES sms_conversations(id),
  user_id UUID REFERENCES users(id),
  direction VARCHAR(10) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  message_body TEXT NOT NULL,
  agentphone_message_id VARCHAR(255),
  agentphone_conversation_id VARCHAR(255),
  channel VARCHAR(20),
  status VARCHAR(50),
  error_message TEXT,
  webhook_signature VARCHAR(255),
  webhook_timestamp BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_direction CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT valid_channel CHECK (channel IN ('sms', 'mms'))
);

CREATE INDEX idx_sms_log_user ON sms_messages_log(user_id);
CREATE INDEX idx_sms_log_phone ON sms_messages_log(phone_number);
CREATE INDEX idx_sms_log_time ON sms_messages_log(created_at DESC);

-- ============================================================================
-- AUTO-CLEANUP FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_expired_sms_data()
RETURNS void AS $$
BEGIN
  -- Mark expired pending transfers
  UPDATE pending_sms_transfers
  SET status = 'expired', updated_at = NOW()
  WHERE status = 'pending' AND expires_at < NOW();

  -- Clean up expired conversations
  UPDATE sms_conversations
  SET state = 'idle', context = '{}'::jsonb, updated_at = NOW()
  WHERE state != 'idle' AND expires_at < NOW();

  -- Delete old message logs (keep 30 days)
  DELETE FROM sms_messages_log
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- VERIFY TABLES CREATED
-- ============================================================================
DO $$
DECLARE
  table_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN (
    'user_phone_numbers',
    'sms_conversations',
    'pending_sms_transfers',
    'sms_transfer_tokens',
    'wise_recipient_nicknames',
    'sms_messages_log'
  );

  RAISE NOTICE 'SMS Integration migration complete. Created/verified % tables.', table_count;
END $$;

COMMIT;
