/**
 * SMS Intent Parser
 *
 * Parses natural language SMS messages into structured intents and entities.
 * Supports: transfer_money, confirmation, cancellation, disambiguation_response, unknown
 *
 * Amount parsing supports:
 *   USD: "$500", "500", "500 USD"
 *   INR: "₹500", "500INR", "500 INR", "500 inr"
 */

const CURRENCY_AMOUNT = '([$₹]?)(\\d+(?:\\.\\d{1,2})?)\\s*(usd|inr|eur|gbp)?';

const PATTERNS = {
  transfer_money: [
    // "send $500 to mom" / "send 100INR to mom" / "send ₹100 to mom"
    new RegExp(`^send\\s+${CURRENCY_AMOUNT}\\s+to\\s+(.+)$`, 'i'),
    // "pay mom $500" / "pay mom 100 INR"
    new RegExp(`^pay\\s+(.+?)\\s+${CURRENCY_AMOUNT}$`, 'i'),
    // "transfer $500 to mom" / "transfer 100INR to mom"
    new RegExp(`^transfer\\s+${CURRENCY_AMOUNT}\\s+(?:to\\s+)?(.+)$`, 'i'),
    // "send mom $500" / "send mom 100 INR"
    new RegExp(`^send\\s+(.+?)\\s+${CURRENCY_AMOUNT}$`, 'i'),
  ],

  // Single digit for disambiguation (reply "1", "2", etc.)
  number_selection: /^([1-9])\s*$/,

  confirmation: /^(yes|yeah|yep|ok|okay|confirm|proceed|sure|go ahead|do it)$/i,

  cancellation: /^(no|nope|cancel|stop|nevermind|never mind|abort|quit)$/i,

  help: /^(help|commands|what can you do|\?)$/i,
  balance: /^(balance|my balance|check balance|how much)$/i,
};

/**
 * Detect currency from symbol prefix or code suffix.
 * Priority: ₹ → INR, suffix code → use it, $ → USD, default → USD
 */
function detectCurrency(prefix, suffix) {
  if (prefix === '₹') return 'INR';
  if (suffix) return suffix.toUpperCase();
  if (prefix === '$') return 'USD';
  return 'USD';
}

/**
 * Parse an SMS message into a structured intent object.
 *
 * @param {string} message - Raw SMS message body
 * @param {Object} conversationState - Current conversation state from sms_conversations
 * @returns {{ intent: string, confidence: number, entities: Object }}
 */
function parseIntent(message, conversationState = {}) {
  const msg = message.trim();

  const [sendAmountTo, payRecipientAmount, transferAmountTo, sendRecipientAmount] = PATTERNS.transfer_money;

  let match;

  // "send [$|₹]500[INR] to mom"
  // Groups: [1]=prefix, [2]=amount, [3]=suffix, [4]=recipient
  match = msg.match(sendAmountTo);
  if (match) {
    return buildTransferIntent(match[2], match[4], match[1], match[3]);
  }

  // "pay mom [$|₹]500[INR]"
  // Groups: [1]=recipient, [2]=prefix, [3]=amount, [4]=suffix
  match = msg.match(payRecipientAmount);
  if (match) {
    return buildTransferIntent(match[3], match[1], match[2], match[4]);
  }

  // "transfer [$|₹]500[INR] [to] mom"
  // Groups: [1]=prefix, [2]=amount, [3]=suffix, [4]=recipient
  match = msg.match(transferAmountTo);
  if (match) {
    return buildTransferIntent(match[2], match[4], match[1], match[3]);
  }

  // "send mom [$|₹]500[INR]"
  // Groups: [1]=recipient, [2]=prefix, [3]=amount, [4]=suffix
  match = msg.match(sendRecipientAmount);
  if (match) {
    return buildTransferIntent(match[3], match[1], match[2], match[4]);
  }

  // --- Disambiguation response (only valid when awaiting) ---
  if (conversationState.state === 'awaiting_disambiguation') {
    match = msg.match(PATTERNS.number_selection);
    if (match) {
      return {
        intent: 'disambiguation_response',
        confidence: 1.0,
        entities: { selection: parseInt(match[1], 10) }
      };
    }
  }

  // --- Confirmation / Cancellation ---
  if (PATTERNS.confirmation.test(msg)) {
    return { intent: 'confirmation', confidence: 1.0, entities: {} };
  }

  if (PATTERNS.cancellation.test(msg)) {
    return { intent: 'cancellation', confidence: 1.0, entities: {} };
  }

  // --- Utility intents ---
  if (PATTERNS.help.test(msg)) {
    return { intent: 'help', confidence: 1.0, entities: {} };
  }

  if (PATTERNS.balance.test(msg)) {
    return { intent: 'balance', confidence: 1.0, entities: {} };
  }

  return { intent: 'unknown', confidence: 0.0, entities: {} };
}

function buildTransferIntent(rawAmount, rawRecipient, currencyPrefix = '', currencySuffix = '') {
  const value = parseFloat(rawAmount);
  const recipient = rawRecipient.trim().toLowerCase();
  const currency = detectCurrency(currencyPrefix || '', currencySuffix || '');

  if (isNaN(value) || value <= 0) {
    return { intent: 'unknown', confidence: 0.0, entities: {} };
  }

  return {
    intent: 'transfer_money',
    confidence: 0.95,
    entities: {
      amount: { value, currency, raw: rawAmount },
      recipient: { value: recipient, raw: rawRecipient.trim() }
    }
  };
}

module.exports = { parseIntent };
