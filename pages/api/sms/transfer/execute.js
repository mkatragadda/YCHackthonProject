/**
 * POST /api/sms/transfer/execute
 *
 * Executes a pending SMS transfer after the user confirms on the web page.
 *
 * Request body: { token: "xYz9K12A" }
 *
 * Flow:
 *  1. Validate token (not expired, not used)
 *  2. Execute transfer via WiseOrchestrator (reuses the pre-created quote)
 *  3. Mark token as used
 *  4. Update pending transfer status → confirmed
 *  5. Send confirmation SMS
 *
 * Response (success):
 *   { success: true, transferId, reference, status }
 *
 * Response (error):
 *   { success: false, error: "..." }
 */

import { createClient } from '@supabase/supabase-js';
import WiseClient from '../../../../services/wise/wiseClient.js';
import WiseQuoteService from '../../../../services/wise/wiseQuoteService.js';
import WiseRecipientService from '../../../../services/wise/wiseRecipientService.js';
import WiseTransferService from '../../../../services/wise/wiseTransferService.js';
import WisePaymentService from '../../../../services/wise/wisePaymentService.js';
import WiseOrchestrator from '../../../../services/wise/wiseOrchestrator.js';

const { validateToken, markTokenUsed } = require('../../../../services/sms/transferTokenService');
const { confirmPendingTransfer } = require('../../../../services/sms/pendingTransferService');
const { buildTransferCompleteMessage } = require('../../../../services/sms/messageTemplates');
const agentPhoneClient = require('../../../../services/agentphone/agentphoneClient');
const spongeWallet = require('../../../../services/sponge/spongeWalletService');

const environment = process.env.WISE_ENVIRONMENT || 'sandbox';
const isLive = environment === 'live' || environment === 'production';

const wiseConfig = {
  apiKey: isLive ? process.env.WISE_API_TOKEN_LIVE : process.env.WISE_API_TOKEN_SANDBOX,
  profileId: isLive ? process.env.WISE_PROFILE_ID_LIVE : process.env.WISE_PROFILE_ID_SANDBOX,
  baseURL: isLive
    ? 'https://api.transferwise.com'
    : (process.env.WISE_BASE_URL || 'https://api.sandbox.transferwise.tech'),
  environment,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { token } = req.body || {};

  if (!token) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  console.log(`[SMSExecute] ▶ Executing transfer for token: ${token.substring(0, 4)}****`);

  try {
    // Step 1: Validate token
    const validation = await validateToken(token);

    if (!validation.valid) {
      console.warn('[SMSExecute] ✗ Invalid token:', validation.error);
      return res.status(400).json({ success: false, error: validation.error });
    }

    const { transfer, tokenRecord } = validation;
    const recipient = transfer.wise_recipient;

    console.log(`[SMSExecute] ✓ Token valid | transfer=${transfer.id} | user=${transfer.user_id} | amount=$${transfer.source_amount} → ${recipient.account_holder_name}`);

    // ── Step 2: Sponge Wallet — on-chain USDC authorization ──────────────────
    // Transfer USD-equivalent USDC from the AI agent wallet to the founder's
    // Coinbase address. This is the "on-chain green light" that proves agentic
    // spending power before the Wise payout fires.
    if (!spongeWallet.isConfigured()) {
      console.error('[SMSExecute] ✗ Sponge Wallet not configured (SPONGE_API_KEY / SPONGE_COINBASE_DESTINATION_ADDRESS missing)');
      return res.status(500).json({ success: false, error: 'On-chain authorization service not configured' });
    }

    console.log(`[SMSExecute] ▶ Sponge: transferring $${transfer.source_amount} USDC on Base`);
    const spongeResult = await spongeWallet.transferUSDC({
      amountUSD:  transfer.source_amount,
      upiId:      recipient.upi_id,
      transferId: transfer.id,
    });
    console.log(`[SMSExecute] ✓ Sponge on-chain auth | txHash=${spongeResult.txHash}`);

    // ── Step 3: Wise — INR payout to UPI ─────────────────────────────────────
    if (!wiseConfig.apiKey || !wiseConfig.profileId) {
      console.error('[SMSExecute] ✗ WISE API not configured');
      return res.status(500).json({ success: false, error: 'WISE API not configured' });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );

    const wiseClient = new WiseClient(wiseConfig);
    const quoteService = new WiseQuoteService(wiseClient, supabase);
    const recipientService = new WiseRecipientService(wiseClient, supabase);
    const transferService = new WiseTransferService(wiseClient, supabase);
    const paymentService = new WisePaymentService(wiseClient, supabase);

    const orchestrator = new WiseOrchestrator({
      quoteService, recipientService, transferService, paymentService, supabase
    });

    const reference = `SMS-${transfer.id.substring(0, 8).toUpperCase()}`;
    console.log(`[SMSExecute] ▶ Wise: INR payout | quoteId=${transfer.wise_quote_id} | ref=${reference}`);

    const result = await orchestrator.executeTransfer({
      userId:    transfer.user_id,
      quoteId:   transfer.wise_quote_id,
      upiId:     recipient.upi_id,
      payeeName: recipient.account_holder_name,
      reference,
      autoFund:  process.env.WISE_AUTO_FUND !== 'false',
    });

    console.log(`[SMSExecute] ✓ Wise transfer created | wiseId=${result.transfer.id} | status=${result.transfer.status} | funded=${result.isFunded}`);

    // ── Step 4: Mark token as one-time used ───────────────────────────────────
    await markTokenUsed(token, req.socket?.remoteAddress, req.headers['user-agent']);
    console.log(`[SMSExecute] ✓ Token marked used`);

    // ── Step 5: Update pending transfer record ────────────────────────────────
    await confirmPendingTransfer(transfer.id, result.transfer.id);
    console.log(`[SMSExecute] ✓ Pending transfer confirmed | pendingId=${transfer.id}`);

    // ── Step 6: Log to DB (fire-and-forget) ──────────────────────────────────
    logExecutionToDb(supabase, transfer, result, spongeResult).catch(err =>
      console.error('[SMSExecute] Log write failed:', err.message)
    );

    // ── Step 7: Send confirmation SMS ────────────────────────────────────────
    const completionMsg = buildTransferCompleteMessage(transfer, result.transfer.reference, spongeResult.txHash);
    agentPhoneClient
      .sendMessage(transfer.phone_number, completionMsg, null)
      .then(() => console.log(`[SMSExecute] ✓ Completion SMS sent to ${transfer.phone_number}`))
      .catch(err => console.error('[SMSExecute] ✗ Confirmation SMS failed:', err.message));

    console.log(`[SMSExecute] ✅ Complete | txHash=${spongeResult.txHash} | wiseRef=${result.transfer.reference}`);

    return res.status(200).json({
      success:    true,
      txHash:     spongeResult.txHash,
      transferId: result.transfer.id,
      reference:  result.transfer.reference,
      status:     result.transfer.status,
      isFunded:   result.isFunded,
    });

  } catch (error) {
    console.error('[SMSExecute] ✗ Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function logExecutionToDb(supabase, transfer, result, spongeResult) {
  await supabase.from('sms_messages_log').insert({
    user_id:      transfer.user_id,
    phone_number: transfer.phone_number,
    direction:    'outbound',
    message_body: `[Transfer executed] Sponge txHash: ${spongeResult.txHash} | WISE ID: ${result.transfer.id} | Ref: ${result.transfer.reference} | Status: ${result.transfer.status}`,
    channel:      'sms',
    status:       'executed',
  });
}
