/**
 * AgentPhone SMS Webhook Handler
 *
 * Receives incoming SMS messages from AgentPhone and processes them.
 *
 * Webhook payload example:
 * {
 *   "event": "message.received",
 *   "data": {
 *     "id": "msg_123",
 *     "conversation_id": "conv_abc",
 *     "from": "+1234567890",
 *     "to": "+0987654321",
 *     "body": "Send $500 to mom",
 *     "channel": "sms",
 *     "created_at": "2026-05-17T12:00:00Z"
 *   }
 * }
 */

const webhookVerifier = require('../../../services/agentphone/webhookVerifier');
const agentPhoneClient = require('../../../services/agentphone/agentphoneClient');
const { getRawBody } = require('../../../utils/rawBody');
const { parseIntent } = require('../../../services/sms/smsIntentParser');
const { matchRecipient } = require('../../../services/sms/recipientMatcher');
const {
  getConversation,
  setConversationState,
  resetConversation,
  updateConversationContext
} = require('../../../services/sms/conversationManager');
const { createPendingTransfer } = require('../../../services/sms/pendingTransferService');
const { generateToken, storeToken, buildConfirmationURL } = require('../../../services/sms/transferTokenService');
const {
  buildTransferReadyMessage,
  buildCancellationMessage,
  buildDisambiguationMessage,
  buildRecipientNotFoundMessage,
  buildHelpMessage,
  buildUnknownMessage
} = require('../../../services/sms/messageTemplates');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

/**
 * Main webhook handler
 */
export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log(`[SMS Webhook] ▶ Inbound request | method=${req.method} | ip=${req.socket?.remoteAddress}`);

  try {
    // Step 1: Read raw body (must happen before any parsing)
    const rawBody = await getRawBody(req);
    const rawBodyString = rawBody.toString('utf8');

    // Step 2: Verify HMAC-SHA256 signature from x-webhook-signature header
    const isValid = webhookVerifier.verifyRequest(req, rawBodyString);

    if (!isValid) {
      console.error('[SMS Webhook] ✗ Invalid signature — rejecting');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('[SMS Webhook] ✓ Signature verified');

    // Step 3: Parse JSON from raw body
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBodyString);
    } catch (parseError) {
      console.error('[SMS Webhook] Invalid JSON body:', parseError.message);
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Step 4: Parse webhook payload
    const { event, data } = parsedBody;

    if (!event || !data) {
      console.error('[SMS Webhook] Invalid payload structure');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Step 5: Handle different event types
    switch (event) {
      case 'message.received':
        console.log(`[SMS Webhook] ▶ message.received | from=${data.from} | msgId=${data.id}`);
        await handleIncomingMessage(data);
        break;

      case 'message.sent':
        console.log(`[SMS Webhook] ✓ message.sent | msgId=${data.id}`);
        break;

      case 'message.failed':
        console.error(`[SMS Webhook] ✗ message.failed | msgId=${data.id} | error=${data.error}`);
        break;

      default:
        console.log(`[SMS Webhook] ⚠ Unhandled event: ${event}`);
    }

    // Step 6: Log webhook to database
    await logWebhook(event, data, req.headers);

    // Always return 200 to acknowledge receipt
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('[SMS Webhook] Error processing webhook:', error);

    // Still return 200 to prevent AgentPhone retries
    // (we've logged the error for debugging)
    return res.status(200).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Handle incoming SMS message
 */
async function handleIncomingMessage(messageData) {
  const {
    id: messageId,
    conversation_id: conversationId,
    from: phoneNumber,
    body: messageBody,
    created_at: timestamp
  } = messageData;

  console.log(`[SMS Webhook] ▶ Processing | from=${phoneNumber} | convId=${conversationId}`);
  console.log(`[SMS Webhook]   Message: "${messageBody}"`);

  // Step 1: Find user by phone number
  const { data: phoneRecord, error: phoneError } = await supabase
    .from('user_phone_numbers')
    .select('user_id, is_verified')
    .eq('phone_number', phoneNumber)
    .eq('is_active', true)
    .single();

  if (phoneError || !phoneRecord) {
    console.log(`[SMS Webhook] ⚠ Unknown phone: ${phoneNumber} — sending welcome message`);
    await sendWelcomeMessage(phoneNumber, conversationId);
    return;
  }

  if (!phoneRecord.is_verified) {
    console.log(`[SMS Webhook] ⚠ Unverified phone: ${phoneNumber} — sending verification reminder`);
    await sendVerificationMessage(phoneNumber, conversationId);
    return;
  }

  const userId = phoneRecord.user_id;

  // Step 2: Log inbound message
  await logMessage({
    conversationId,
    userId,
    direction: 'inbound',
    phoneNumber,
    messageBody,
    agentphoneMessageId: messageId,
    agentphoneConversationId: conversationId,
    channel: 'sms'
  });

  // Step 3: Parse intent and respond
  const responseMessage = await processIntent({
    messageBody,
    phoneNumber,
    userId,
    conversationId
  });

  await agentPhoneClient.sendMessage(phoneNumber, responseMessage, conversationId);

  await logMessage({
    conversationId,
    userId,
    direction: 'outbound',
    phoneNumber,
    messageBody: responseMessage,
    agentphoneConversationId: conversationId,
    channel: 'sms',
    status: 'sent'
  });
}

/**
 * Core intent processing — returns the SMS reply string.
 */
async function processIntent({ messageBody, phoneNumber, userId, conversationId }) {
  const conversation = await getConversation(phoneNumber);
  const conversationState = conversation || { state: 'idle', context: {} };

  const { intent, entities } = parseIntent(messageBody, conversationState);

  console.log(`[SMS Webhook] ✓ Intent: ${intent} | State: ${conversationState.state}`);

  // --- Cancellation at any stage ---
  if (intent === 'cancellation') {
    await resetConversation(phoneNumber);
    return buildCancellationMessage();
  }

  // --- Disambiguation response ---
  if (intent === 'disambiguation_response' && conversationState.state === 'awaiting_disambiguation') {
    const { selection } = entities;
    const { matches, amount, currency } = conversationState.context;

    if (!matches || selection < 1 || selection > matches.length) {
      return `Please reply with a number between 1 and ${(matches || []).length}.`;
    }

    const chosen = matches[selection - 1];
    return await createTransferAndSendLink({
      phoneNumber, userId, conversationId,
      wiseRecipient: chosen,
      transferAmount: { value: amount, currency: currency || 'USD' },
      rawMessage: messageBody
    });
  }

  // --- New transfer intent ---
  if (intent === 'transfer_money') {
    const { amount, recipient } = entities;

    if (!amount || amount.value <= 0) {
      return '❌ Invalid amount. Try: "Send $50 to mom"';
    }

    const matchResult = await matchRecipient(recipient.value, userId);

    if (matchResult.status === 'not_found') {
      return buildRecipientNotFoundMessage(recipient.raw);
    }

    if (matchResult.status === 'multiple') {
      await setConversationState(phoneNumber, userId, 'awaiting_disambiguation', {
        matches: matchResult.matches,
        amount: amount.value,
        currency: amount.currency
      }, conversationId);

      return buildDisambiguationMessage(matchResult.matches, recipient.raw);
    }

    return await createTransferAndSendLink({
      phoneNumber, userId, conversationId,
      wiseRecipient: matchResult.recipient,
      transferAmount: amount,
      rawMessage: messageBody
    });
  }

  // --- Help ---
  if (intent === 'help') {
    return buildHelpMessage();
  }

  // --- Unknown ---
  await resetConversation(phoneNumber);
  return buildUnknownMessage();
}

/**
 * Creates a pending transfer + token and returns the confirmation SMS.
 * Extracted so both direct match and disambiguation resolution share the same path.
 */
async function createTransferAndSendLink({ phoneNumber, userId, conversationId, wiseRecipient, transferAmount, rawMessage }) {
  const { value, currency } = transferAmount;
  console.log(`[SMS Webhook] ▶ Creating pending transfer | user=${userId} | amount=${value} ${currency} | recipient=${wiseRecipient.account_holder_name}`);

  const pendingTransfer = await createPendingTransfer({
    userId,
    phoneNumber,
    wiseRecipient,
    transferAmount,
    rawMessage
  });

  console.log(`[SMS Webhook] ✓ Pending transfer created | id=${pendingTransfer.id} | quote=${pendingTransfer.wise_quote_id} | rate=${pendingTransfer.exchange_rate}`);

  const tokenData = generateToken(pendingTransfer);
  await storeToken(tokenData, pendingTransfer.id, phoneNumber, userId);

  const confirmURL = buildConfirmationURL(tokenData.shortToken);

  console.log(`[SMS Webhook] ✓ Token stored | shortToken=${tokenData.shortToken} | confirmURL=${confirmURL}`);

  await setConversationState(phoneNumber, userId, 'ready_for_confirmation', {
    pendingTransferId: pendingTransfer.id,
    shortToken: tokenData.shortToken
  }, conversationId);

  console.log(`[SMS Webhook] ✓ Conversation → ready_for_confirmation | pendingId=${pendingTransfer.id}`);

  return buildTransferReadyMessage(pendingTransfer, confirmURL);
}

/**
 * Send welcome message to unknown phone number
 */
async function sendWelcomeMessage(phoneNumber, conversationId) {
  const message =
    `👋 Welcome to Vitta!\n\n` +
    `This phone number is not linked to a Vitta account.\n\n` +
    `To use SMS transfers, please:\n` +
    `1. Sign in to Vitta web app\n` +
    `2. Go to Settings\n` +
    `3. Add and verify this phone number\n\n` +
    `Need help? Visit vitta.app`;

  await agentPhoneClient.sendMessage(phoneNumber, message, conversationId);

  await logMessage({
    direction: 'outbound',
    phoneNumber,
    messageBody: message,
    agentphoneConversationId: conversationId,
    channel: 'sms',
    status: 'sent'
  });
}

/**
 * Send verification reminder message
 */
async function sendVerificationMessage(phoneNumber, conversationId) {
  const message =
    `⚠️ Phone number not verified\n\n` +
    `Please verify your phone number in the Vitta app before using SMS transfers.\n\n` +
    `Settings → Phone Numbers → Verify`;

  await agentPhoneClient.sendMessage(phoneNumber, message, conversationId);
}

/**
 * Log message to database
 */
async function logMessage(messageData) {
  const {
    conversationId,
    userId,
    direction,
    phoneNumber,
    messageBody,
    agentphoneMessageId,
    agentphoneConversationId,
    channel,
    status,
    errorMessage
  } = messageData;

  try {
    const { error } = await supabase
      .from('sms_messages_log')
      .insert({
        conversation_id: conversationId || null,
        user_id: userId || null,
        direction,
        phone_number: phoneNumber,
        message_body: messageBody,
        agentphone_message_id: agentphoneMessageId || null,
        agentphone_conversation_id: agentphoneConversationId || null,
        channel: channel || 'sms',
        status: status || null,
        error_message: errorMessage || null
      });

    if (error) {
      console.error('[SMS Webhook] Failed to log message:', error);
    }
  } catch (err) {
    console.error('[SMS Webhook] Error logging message:', err);
  }
}

/**
 * Log webhook event to database
 */
async function logWebhook(event, data, headers) {
  try {
    // Extract relevant data for logging
    const logEntry = {
      direction: 'inbound',
      phone_number: data.from || data.to || 'unknown',
      message_body: `[Webhook Event: ${event}]`,
      agentphone_message_id: data.id || null,
      agentphone_conversation_id: data.conversation_id || null,
      channel: data.channel || 'sms',
      webhook_signature: headers['x-webhook-signature'] || null,
      webhook_timestamp: headers['x-webhook-timestamp']
        ? parseInt(headers['x-webhook-timestamp'], 10)
        : null
    };

    const { error } = await supabase
      .from('sms_messages_log')
      .insert(logEntry);

    if (error) {
      console.error('[SMS Webhook] Failed to log webhook:', error);
    }
  } catch (err) {
    console.error('[SMS Webhook] Error logging webhook:', err);
  }
}

// Disable Next.js body parsing — we read the raw body manually for signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};
