/**
 * E2E Integration Tests — SMS Transfer Flow
 *
 * Simulates the complete chain in sequence:
 *   SMS webhook → intent parse → pending transfer → confirmation link
 *   → verify token → execute via WISE → completion SMS
 *
 * Real implementations: smsIntentParser, messageTemplates, buildConfirmationURL
 * Mocked boundaries:   Supabase, WISE API, AgentPhone, recipientMatcher,
 *                      conversationManager, pendingTransferService, token storage
 */

// ── Environment ───────────────────────────────────────────────────────────────

process.env.NEXT_PUBLIC_SUPABASE_URL     = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test_anon_key';
process.env.TRANSFER_TOKEN_SECRET        = 'test_secret_min_32_chars_long_ok';
process.env.WISE_API_TOKEN_SANDBOX       = 'test_wise_key';
process.env.WISE_PROFILE_ID_SANDBOX      = 'profile_123';
process.env.WISE_ENVIRONMENT             = 'sandbox';
process.env.WISE_AUTO_FUND               = 'false';
process.env.NEXT_PUBLIC_APP_URL          = 'https://app.getvitta.com';

// ── AgentPhone mocks ──────────────────────────────────────────────────────────

jest.mock('../../services/agentphone/webhookVerifier', () => ({
  verifyRequest: jest.fn().mockReturnValue(true),
}));

const mockSendMessage = jest.fn().mockResolvedValue({ success: true });
jest.mock('../../services/agentphone/agentphoneClient', () => ({
  sendMessage: mockSendMessage,
}));

// ── Supabase mock (webhook direct calls: user lookup + log inserts) ───────────

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn((table) => {
      const chain = {
        select: jest.fn().mockReturnThis(),
        eq:     jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        upsert: jest.fn().mockReturnThis(),
        single: jest.fn(),
      };
      if (table === 'user_phone_numbers') {
        chain.single.mockResolvedValue({
          data: { user_id: 'user_abc', is_verified: true },
          error: null,
        });
      } else {
        chain.single.mockResolvedValue({ data: { id: 'auto_001' }, error: null });
      }
      return chain;
    }),
  })),
}));

// ── SMS service mocks (use real intent parser + message templates) ─────────────

const mockMatchRecipient = jest.fn();
jest.mock('../../services/sms/recipientMatcher', () => ({
  matchRecipient: mockMatchRecipient,
}));

const mockGetConversation      = jest.fn();
const mockSetConversationState = jest.fn();
const mockResetConversation    = jest.fn();
const mockUpdateConversationContext = jest.fn();
jest.mock('../../services/sms/conversationManager', () => ({
  getConversation:          mockGetConversation,
  setConversationState:     mockSetConversationState,
  resetConversation:        mockResetConversation,
  updateConversationContext: mockUpdateConversationContext,
}));

const mockCreatePendingTransfer  = jest.fn();
const mockConfirmPendingTransfer = jest.fn();
jest.mock('../../services/sms/pendingTransferService', () => ({
  createPendingTransfer:  mockCreatePendingTransfer,
  confirmPendingTransfer: mockConfirmPendingTransfer,
  getPendingTransfer:     jest.fn(),
}));

// Partial mock: keep real buildConfirmationURL so the URL uses NEXT_PUBLIC_APP_URL
const mockGenerateToken = jest.fn();
const mockStoreToken    = jest.fn().mockResolvedValue(undefined);
const mockValidateToken = jest.fn();
const mockMarkTokenUsed = jest.fn().mockResolvedValue(undefined);

jest.mock('../../services/sms/transferTokenService', () => {
  const real = jest.requireActual('../../services/sms/transferTokenService');
  return {
    ...real,
    generateToken:       mockGenerateToken,
    storeToken:          mockStoreToken,
    validateToken:       mockValidateToken,
    markTokenUsed:       mockMarkTokenUsed,
  };
});

// ── WISE service mocks ────────────────────────────────────────────────────────

const mockExecuteTransfer = jest.fn();

jest.mock('../../services/wise/wiseClient', () => ({
  __esModule: true, default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../services/wise/wiseQuoteService', () => ({
  __esModule: true, default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../services/wise/wiseRecipientService', () => ({
  __esModule: true, default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../services/wise/wiseTransferService', () => ({
  __esModule: true, default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../services/wise/wisePaymentService', () => ({
  __esModule: true, default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../services/wise/wiseOrchestrator', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ executeTransfer: mockExecuteTransfer })),
}));

// ── Load handlers ─────────────────────────────────────────────────────────────

const webhookHandler = require('../../pages/api/sms/webhook').default;
const verifyHandler  = require('../../pages/api/sms/transfer/verify').default;
const executeHandler = require('../../pages/api/sms/transfer/execute').default;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PHONE = '+1234567890';
const CONV_ID = 'conv_abc';

const mockRecipient = {
  id: 'rec_001',
  account_holder_name: 'Maria Garcia',
  currency: 'INR',
  upi_id: 'maria@paytm',
  type: 'upi',
};

const mockPendingTransfer = {
  id: 'pt_001',
  user_id: 'user_abc',
  phone_number: PHONE,
  source_amount: 500,
  source_currency: 'USD',
  target_amount: 41250,
  target_currency: 'INR',
  exchange_rate: 82.5,
  fee_total: 4.99,
  wise_quote_id: 'quote_001',
  wise_recipient: mockRecipient,
  expires_at: new Date(Date.now() + 900_000).toISOString(),
};

const mockTokenRecord = {
  short_token: 'xYz9K12A',
  expires_at: new Date(Date.now() + 900_000).toISOString(),
  status: 'active',
};

const mockWiseResult = {
  transfer: { id: 'wise_transfer_123', reference: 'SMS-PT001ABC', status: 'processing' },
  isFunded: false,
};

// ── Request helpers ───────────────────────────────────────────────────────────

function makeWebhookReq(body, phone = PHONE) {
  return {
    method: 'POST',
    headers: { 'x-webhook-signature': 'sha256=valid', 'x-webhook-timestamp': String(Date.now()) },
    body: {
      event: 'message.received',
      data: { id: 'msg_001', conversation_id: CONV_ID, from: phone, body, created_at: new Date().toISOString() },
    },
  };
}

function makeRes() {
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return res;
}

function makeVerifyReq(token) {
  return { method: 'GET', query: { token } };
}

function makeExecuteReq(token) {
  return { method: 'POST', body: { token }, socket: { remoteAddress: '127.0.0.1' }, headers: {} };
}

// ── Test setup helpers ────────────────────────────────────────────────────────

const SHORT_TOKEN = 'xYz9K12A';
const CONFIRM_URL = `https://app.getvitta.com/transfer/confirm/${SHORT_TOKEN}`;

function setupHappyPath() {
  mockGetConversation.mockResolvedValue(null);
  mockSetConversationState.mockResolvedValue(undefined);
  mockResetConversation.mockResolvedValue(undefined);
  mockMatchRecipient.mockResolvedValue({ status: 'matched', recipient: mockRecipient, matchType: 'nickname' });
  mockCreatePendingTransfer.mockResolvedValue(mockPendingTransfer);
  mockGenerateToken.mockReturnValue({
    shortToken: SHORT_TOKEN,
    fullToken: 'full.jwt.token',
    tokenHash: 'sha256hashvalue',
    expiresAt: mockTokenRecord.expires_at,
  });
  mockValidateToken.mockImplementation(async (token) => {
    if (token === SHORT_TOKEN) {
      return { valid: true, transfer: mockPendingTransfer, tokenRecord: mockTokenRecord };
    }
    return { valid: false, error: 'Token not found' };
  });
  mockExecuteTransfer.mockResolvedValue(mockWiseResult);
  mockConfirmPendingTransfer.mockResolvedValue(undefined);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SMS Transfer Flow — End to End', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMessage.mockResolvedValue({ success: true });
    mockStoreToken.mockResolvedValue(undefined);
    mockMarkTokenUsed.mockResolvedValue(undefined);
  });

  // ── Happy Path ──────────────────────────────────────────────────────────────

  describe('Happy Path: "Send $500 to mom"', () => {
    test('Step 1 — Webhook: returns 200 and sends confirmation link SMS', async () => {
      setupHappyPath();
      const res = makeRes();

      await webhookHandler(makeWebhookReq('Send $500 to mom'), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });

      const [sentPhone, sentMsg] = mockSendMessage.mock.calls[0];
      expect(sentPhone).toBe(PHONE);
      expect(sentMsg).toContain('app.getvitta.com/transfer/confirm/');
      expect(sentMsg).toContain('Transfer Ready');
      expect(sentMsg).toContain('$500.00');
      expect(sentMsg).toContain('Maria Garcia');
      expect(sentMsg).toContain('Link expires in 15 minutes');
    });

    test('Step 1 — Webhook: stores token and sets conversation to ready_for_confirmation', async () => {
      setupHappyPath();

      await webhookHandler(makeWebhookReq('Send $500 to mom'), makeRes());

      expect(mockStoreToken).toHaveBeenCalledWith(
        expect.objectContaining({ shortToken: SHORT_TOKEN }),
        'pt_001',
        PHONE,
        'user_abc'
      );
      expect(mockSetConversationState).toHaveBeenCalledWith(
        PHONE, 'user_abc', 'ready_for_confirmation',
        expect.objectContaining({ pendingTransferId: 'pt_001', shortToken: SHORT_TOKEN }),
        CONV_ID
      );
    });

    test('Step 2 — Verify: returns transfer details for the generated token', async () => {
      setupHappyPath();
      await webhookHandler(makeWebhookReq('Send $500 to mom'), makeRes());

      const res = makeRes();
      await verifyHandler(makeVerifyReq(SHORT_TOKEN), res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.valid).toBe(true);
      expect(body.transfer.id).toBe('pt_001');
      expect(body.transfer.source_amount).toBe(500);
      expect(body.transfer.wise_recipient.account_holder_name).toBe('Maria Garcia');
    });

    test('Step 3 — Execute: calls WISE with correct params and returns success', async () => {
      setupHappyPath();
      await webhookHandler(makeWebhookReq('Send $500 to mom'), makeRes());

      const res = makeRes();
      await executeHandler(makeExecuteReq(SHORT_TOKEN), res);

      expect(mockExecuteTransfer).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user_abc',
        quoteId: 'quote_001',
        upiId: 'maria@paytm',
        payeeName: 'Maria Garcia',
        autoFund: false,
      }));
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.transferId).toBe('wise_transfer_123');
      expect(body.reference).toBe('SMS-PT001ABC');
    });

    test('Step 3 — Execute: sends completion SMS fire-and-forget', async () => {
      setupHappyPath();
      await webhookHandler(makeWebhookReq('Send $500 to mom'), makeRes());
      await executeHandler(makeExecuteReq(SHORT_TOKEN), makeRes());
      await Promise.resolve(); // let fire-and-forget settle

      const completionCall = mockSendMessage.mock.calls.find(
        ([, msg]) => msg.includes('Transfer Complete')
      );
      expect(completionCall).toBeDefined();
      const [phone, msg] = completionCall;
      expect(phone).toBe(PHONE);
      expect(msg).toContain('Maria Garcia');
      expect(msg).toContain('SMS-PT001ABC');
    });

    test('Full chain — webhook → verify → execute produces correct sequence', async () => {
      setupHappyPath();

      // Step 1: webhook
      const webhookRes = makeRes();
      await webhookHandler(makeWebhookReq('Send $500 to mom'), webhookRes);
      expect(webhookRes.status).toHaveBeenCalledWith(200);

      // Step 2: verify
      const verifyRes = makeRes();
      await verifyHandler(makeVerifyReq(SHORT_TOKEN), verifyRes);
      expect(verifyRes.json.mock.calls[0][0].valid).toBe(true);

      // Step 3: execute
      const executeRes = makeRes();
      await executeHandler(makeExecuteReq(SHORT_TOKEN), executeRes);
      expect(executeRes.json.mock.calls[0][0].success).toBe(true);

      // Token marked used
      expect(mockMarkTokenUsed).toHaveBeenCalledWith(SHORT_TOKEN, '127.0.0.1', undefined);

      // Pending transfer confirmed
      expect(mockConfirmPendingTransfer).toHaveBeenCalledWith('pt_001', 'wise_transfer_123');

      // Two SMS messages: confirm link + completion
      await Promise.resolve();
      expect(mockSendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Disambiguation ──────────────────────────────────────────────────────────

  describe('Disambiguation: multiple recipients named "John"', () => {
    const john1 = { id: 'rec_j1', account_holder_name: 'John Smith', upi_id: 'j.smith@paytm', currency: 'INR' };
    const john2 = { id: 'rec_j2', account_holder_name: 'John Doe', upi_id: 'j.doe@upi', currency: 'INR' };

    test('webhook sends numbered list when multiple matches found', async () => {
      mockGetConversation.mockResolvedValue(null);
      mockMatchRecipient.mockResolvedValue({ status: 'multiple', matches: [john1, john2] });

      await webhookHandler(makeWebhookReq('Send $100 to John'), makeRes());

      const [, msg] = mockSendMessage.mock.calls[0];
      expect(msg).toContain('1. John Smith');
      expect(msg).toContain('2. John Doe');
      expect(msg).toContain('Reply with the number');
    });

    test('replying "1" selects first recipient and creates transfer link', async () => {
      mockGetConversation.mockResolvedValue({
        state: 'awaiting_disambiguation',
        context: { matches: [john1, john2], amount: 100, currency: 'USD' },
      });
      mockCreatePendingTransfer.mockResolvedValue({
        ...mockPendingTransfer,
        source_amount: 100,
        wise_recipient: john1,
      });
      mockGenerateToken.mockReturnValue({
        shortToken: SHORT_TOKEN,
        fullToken: 'jwt',
        tokenHash: 'hash',
        expiresAt: mockTokenRecord.expires_at,
      });

      await webhookHandler(makeWebhookReq('1'), makeRes());

      expect(mockCreatePendingTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ wiseRecipient: john1, sourceAmount: 100 })
      );
      const [, msg] = mockSendMessage.mock.calls[0];
      expect(msg).toContain('Transfer Ready');
      expect(msg).toContain('app.getvitta.com/transfer/confirm/');
    });
  });

  // ── Cancellation ────────────────────────────────────────────────────────────

  describe('Cancellation', () => {
    test('"cancel" resets conversation and sends cancellation message', async () => {
      mockGetConversation.mockResolvedValue({
        state: 'awaiting_disambiguation',
        context: { matches: [], amount: 200 },
      });
      mockResetConversation.mockResolvedValue(undefined);

      await webhookHandler(makeWebhookReq('cancel'), makeRes());

      expect(mockResetConversation).toHaveBeenCalledWith(PHONE);
      const [, msg] = mockSendMessage.mock.calls[0];
      expect(msg).toContain('cancelled');
    });

    test('"stop" also cancels mid-flow', async () => {
      mockGetConversation.mockResolvedValue({ state: 'ready_for_confirmation', context: {} });
      mockResetConversation.mockResolvedValue(undefined);

      await webhookHandler(makeWebhookReq('stop'), makeRes());

      expect(mockResetConversation).toHaveBeenCalledWith(PHONE);
    });
  });

  // ── Unknown phone ────────────────────────────────────────────────────────────
  // Detailed welcome-message behavior is covered in webhook unit tests.
  // Here we verify the webhook is resilient at the e2e level.

  describe('Unknown phone number', () => {
    test('webhook always returns 200 to prevent AgentPhone retries', async () => {
      mockGetConversation.mockRejectedValue(new Error('connection refused'));

      const res = makeRes();
      await webhookHandler(makeWebhookReq('Send $100 to mom'), res);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ── Token errors ─────────────────────────────────────────────────────────────

  describe('Token validation errors', () => {
    test('verify returns 400 for expired token', async () => {
      mockValidateToken.mockResolvedValue({ valid: false, error: 'Token expired' });

      const res = makeRes();
      await verifyHandler(makeVerifyReq('oldtoken'), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ valid: false, error: 'Token expired' });
    });

    test('execute returns 400 for already-used token', async () => {
      mockValidateToken.mockResolvedValue({ valid: false, error: 'Token already used' });

      const res = makeRes();
      await executeHandler(makeExecuteReq('usedtoken'), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Token already used' });
    });

    test('execute returns 500 when WISE throws', async () => {
      setupHappyPath();
      mockExecuteTransfer.mockRejectedValue(new Error('WISE balance insufficient'));

      const res = makeRes();
      await executeHandler(makeExecuteReq(SHORT_TOKEN), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'WISE balance insufficient' });
    });
  });

  // ── Help & unknown ────────────────────────────────────────────────────────────

  describe('Help and unknown messages', () => {
    test('"help" returns command list', async () => {
      mockGetConversation.mockResolvedValue(null);

      await webhookHandler(makeWebhookReq('help'), makeRes());

      const [, msg] = mockSendMessage.mock.calls[0];
      expect(msg).toContain('Send $500 to mom');
      expect(msg).toContain('Cancel');
    });

    test('gibberish message returns unknown message', async () => {
      mockGetConversation.mockResolvedValue(null);
      mockResetConversation.mockResolvedValue(undefined);

      await webhookHandler(makeWebhookReq('asdfghjkl qwerty'), makeRes());

      const [, msg] = mockSendMessage.mock.calls[0];
      expect(msg).toContain("didn't understand");
    });

    test('recipient not found returns actionable error', async () => {
      mockGetConversation.mockResolvedValue(null);
      mockMatchRecipient.mockResolvedValue({ status: 'not_found' });

      await webhookHandler(makeWebhookReq('Send $200 to nobody'), makeRes());

      const [, msg] = mockSendMessage.mock.calls[0];
      expect(msg).toContain("Couldn't find");
    });
  });

  // ── Webhook resilience ────────────────────────────────────────────────────────

  describe('Webhook resilience', () => {
    test('returns 200 even when intent processing throws (prevents AgentPhone retries)', async () => {
      mockGetConversation.mockRejectedValue(new Error('DB timeout'));

      const res = makeRes();
      await webhookHandler(makeWebhookReq('Send $100 to mom'), res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('returns 401 for invalid signature', async () => {
      const { verifyRequest } = require('../../services/agentphone/webhookVerifier');
      verifyRequest.mockReturnValueOnce(false);

      const res = makeRes();
      await webhookHandler(makeWebhookReq('Send $100 to mom'), res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('acknowledges message.sent and message.failed events without error', async () => {
      const res1 = makeRes();
      await webhookHandler(
        { method: 'POST', headers: {}, body: { event: 'message.sent', data: { id: 'msg_sent' } } },
        res1
      );
      expect(res1.status).toHaveBeenCalledWith(200);

      const res2 = makeRes();
      await webhookHandler(
        { method: 'POST', headers: {}, body: { event: 'message.failed', data: { id: 'msg_fail', error: 'timeout' } } },
        res2
      );
      expect(res2.status).toHaveBeenCalledWith(200);
    });
  });
});
