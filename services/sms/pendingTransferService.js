/**
 * Pending Transfer Service
 *
 * Creates and retrieves pending_sms_transfers records.
 * Calls wiseQuoteService to lock in an exchange rate before the user confirms.
 */

const { createClient } = require('@supabase/supabase-js');
const WiseClient = require('../wise/wiseClient').default;
const WiseQuoteService = require('../wise/wiseQuoteService').default;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const environment = process.env.WISE_ENVIRONMENT || 'sandbox';
const isLive = environment === 'live' || environment === 'production';

const wiseClient = new WiseClient({
  apiKey: isLive ? process.env.WISE_API_TOKEN_LIVE : process.env.WISE_API_TOKEN_SANDBOX,
  profileId: isLive ? process.env.WISE_PROFILE_ID_LIVE : process.env.WISE_PROFILE_ID_SANDBOX,
  baseURL: isLive
    ? 'https://api.transferwise.com'
    : (process.env.WISE_BASE_URL || 'https://api.sandbox.transferwise.tech'),
  environment,
});

const wiseQuoteService = new WiseQuoteService(wiseClient, supabase);

const PENDING_TRANSFER_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Create a pending SMS transfer:
 *  1. Fetch wise_recipient to get target currency
 *  2. Create a WISE quote via wiseQuoteService
 *  3. Insert pending_sms_transfers row
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.phoneNumber - E.164 format
 * @param {Object} params.wiseRecipient - full wise_recipients row (already fetched by recipientMatcher)
 * @param {number} params.sourceAmount - USD amount
 * @param {string} params.rawMessage - original SMS body for audit
 * @returns {Promise<Object>} pending transfer row joined with wise_recipient
 */
async function createPendingTransfer({ userId, phoneNumber, wiseRecipient, transferAmount, rawMessage }) {
  const { value, currency: amountCurrency } = transferAmount;
  const targetCurrency = wiseRecipient.currency || 'INR';

  console.log(`[PendingTransferService] Creating pending transfer for ${phoneNumber} | ${value} ${amountCurrency} → ${targetCurrency}`);

  // If user specified INR amount, use targetAmount so Wise calculates the USD needed.
  // Otherwise treat the value as USD sourceAmount.
  const quoteParams = amountCurrency === 'INR'
    ? { userId, targetAmount: value, sourceCurrency: 'USD', targetCurrency }
    : { userId, sourceAmount: value, sourceCurrency: 'USD', targetCurrency };

  const quote = await wiseQuoteService.createQuote(quoteParams);

  const expiresAt = new Date(Date.now() + PENDING_TRANSFER_TTL_MS).toISOString();

  const { data: pendingTransfer, error } = await supabase
    .from('pending_sms_transfers')
    .insert({
      user_id: userId,
      phone_number: phoneNumber,
      wise_recipient_id: wiseRecipient.id,
      source_amount: sourceAmount,
      source_currency: 'USD',
      target_amount: quote.target_amount,
      target_currency: quote.target_currency,
      exchange_rate: quote.exchange_rate,
      wise_quote_id: quote.id,
      quote_expires_at: quote.expires_at,
      raw_message: rawMessage,
      status: 'pending',
      expires_at: expiresAt
    })
    .select()
    .single();

  if (error) {
    console.error('[PendingTransferService] DB insert error:', error.message);
    throw error;
  }

  console.log('[PendingTransferService] Created pending transfer:', pendingTransfer.id);

  return { ...pendingTransfer, wise_recipient: wiseRecipient };
}

/**
 * Fetch a pending transfer by ID, joined with its wise_recipient.
 *
 * @param {string} transferId
 * @returns {Promise<Object>}
 */
async function getPendingTransfer(transferId) {
  const { data, error } = await supabase
    .from('pending_sms_transfers')
    .select('*, wise_recipient:wise_recipients(*)')
    .eq('id', transferId)
    .single();

  if (error) {
    console.error('[PendingTransferService] Fetch error:', error.message);
    throw error;
  }

  return data;
}

/**
 * Mark a pending transfer as confirmed and link the completed WISE transfer.
 *
 * @param {string} transferId
 * @param {string} wiseTransferId
 */
async function confirmPendingTransfer(transferId, wiseTransferId) {
  const { error } = await supabase
    .from('pending_sms_transfers')
    .update({
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      completed_transfer_id: wiseTransferId,
      updated_at: new Date().toISOString()
    })
    .eq('id', transferId);

  if (error) {
    console.error('[PendingTransferService] Confirm error:', error.message);
    throw error;
  }
}

module.exports = { createPendingTransfer, getPendingTransfer, confirmPendingTransfer };
