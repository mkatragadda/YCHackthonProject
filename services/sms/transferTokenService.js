/**
 * Transfer Token Service
 *
 * Generates JWT-backed secure tokens for SMS transfer confirmation links.
 *
 * Security model:
 *  - Full JWT signed with HS256 carries transferId, userId, amount
 *  - SHA-256 hash of the JWT stored in sms_transfer_tokens (never the raw JWT)
 *  - 8-char base64url short token stored separately for URL-safe use
 *  - Tokens are one-time use and expire in 15 minutes
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const TOKEN_EXPIRY_SECONDS = 15 * 60; // 15 minutes
const APP_URL = () => process.env.NEXT_PUBLIC_APP_URL || 'https://app.getvitta.com';

function getSecret() {
  const secret = process.env.TRANSFER_TOKEN_SECRET;
  if (!secret) throw new Error('TRANSFER_TOKEN_SECRET env var is not set');
  return secret;
}

/**
 * Generate a JWT + short token pair for a pending transfer.
 *
 * @param {Object} pendingTransfer - pending_sms_transfers row
 * @returns {{ fullToken: string, shortToken: string, tokenHash: string, expiresAt: Date }}
 */
function generateToken(pendingTransfer) {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    transferId: pendingTransfer.id,
    userId: pendingTransfer.user_id,
    amount: pendingTransfer.source_amount,
    wiseRecipientId: pendingTransfer.wise_recipient_id,
    iat: now,
    exp: now + TOKEN_EXPIRY_SECONDS
  };

  const fullToken = jwt.sign(payload, getSecret(), { algorithm: 'HS256' });

  // Short token: first 8 chars of base64url(sha256(fullToken)) — URL-safe, unguessable
  const tokenHash = crypto.createHash('sha256').update(fullToken).digest('hex');
  const shortToken = crypto.createHash('sha256').update(fullToken).digest('base64url').substring(0, 8);

  return {
    fullToken,
    shortToken,
    tokenHash,
    expiresAt: new Date((now + TOKEN_EXPIRY_SECONDS) * 1000)
  };
}

/**
 * Persist the token record in sms_transfer_tokens.
 * Only the hash (never the raw JWT) is stored.
 *
 * @param {Object} tokenData - result of generateToken()
 * @param {string} pendingTransferId
 * @param {string} phoneNumber
 * @param {string} userId
 * @returns {Promise<string>} the shortToken
 */
async function storeToken(tokenData, pendingTransferId, phoneNumber, userId) {
  const { error } = await supabase
    .from('sms_transfer_tokens')
    .insert({
      user_id: userId,
      pending_transfer_id: pendingTransferId,
      token_hash: tokenData.tokenHash,
      short_token: tokenData.shortToken,
      phone_number: phoneNumber,
      expires_at: tokenData.expiresAt.toISOString(),
      is_used: false
    });

  if (error) {
    console.error('[TransferTokenService] storeToken error:', error.message);
    throw error;
  }

  return tokenData.shortToken;
}

/**
 * Validate a short token:
 *  1. Lookup token record in DB
 *  2. Check not used, not expired
 *  3. Fetch the associated pending transfer
 *
 * @param {string} shortToken
 * @returns {Promise<{ valid: boolean, error?: string, tokenRecord?: Object, transfer?: Object }>}
 */
async function validateToken(shortToken) {
  if (!shortToken) return { valid: false, error: 'Token is required' };

  const { data: tokenRecord, error: tokenError } = await supabase
    .from('sms_transfer_tokens')
    .select('*')
    .eq('short_token', shortToken)
    .maybeSingle();

  if (tokenError) {
    console.error('[TransferTokenService] validateToken DB error:', tokenError.message);
    return { valid: false, error: 'Token lookup failed' };
  }

  if (!tokenRecord) return { valid: false, error: 'Token not found' };
  if (tokenRecord.is_used) return { valid: false, error: 'Token already used' };
  if (new Date() > new Date(tokenRecord.expires_at)) return { valid: false, error: 'Token expired' };

  const { data: transfer, error: transferError } = await supabase
    .from('pending_sms_transfers')
    .select('*, wise_recipient:wise_recipients(*)')
    .eq('id', tokenRecord.pending_transfer_id)
    .single();

  if (transferError || !transfer) {
    return { valid: false, error: 'Transfer not found' };
  }

  if (transfer.status !== 'pending') {
    return { valid: false, error: `Transfer is ${transfer.status}` };
  }

  // Compute human-readable time remaining
  const msLeft = new Date(tokenRecord.expires_at) - new Date();
  const minsLeft = Math.max(0, Math.floor(msLeft / 60000));
  const expiresIn = minsLeft === 1 ? '1 minute' : `${minsLeft} minutes`;

  return { valid: true, tokenRecord, transfer: { ...transfer, expiresIn } };
}

/**
 * Mark a token as used after a successful transfer execution.
 *
 * @param {string} shortToken
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 */
async function markTokenUsed(shortToken, ipAddress, userAgent) {
  const { error } = await supabase
    .from('sms_transfer_tokens')
    .update({
      is_used: true,
      used_at: new Date().toISOString(),
      used_ip: ipAddress || null,
      used_user_agent: userAgent || null
    })
    .eq('short_token', shortToken);

  if (error) {
    console.error('[TransferTokenService] markTokenUsed error:', error.message);
    throw error;
  }
}

/**
 * Build the full confirmation URL from a short token.
 *
 * @param {string} shortToken
 * @returns {string}
 */
function buildConfirmationURL(shortToken) {
  return `${APP_URL()}/transfer/confirm/${shortToken}`;
}

module.exports = {
  generateToken,
  storeToken,
  validateToken,
  markTokenUsed,
  buildConfirmationURL
};
