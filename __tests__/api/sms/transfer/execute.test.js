/**
 * Integration tests for POST /api/sms/transfer/execute
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test_anon_key';
process.env.TRANSFER_TOKEN_SECRET = 'test_secret_min_32_chars_long_ok';
process.env.WISE_API_TOKEN_SANDBOX = 'test_wise_key';
process.env.WISE_PROFILE_ID_SANDBOX = 'profile_123';
process.env.WISE_ENVIRONMENT = 'sandbox';
process.env.WISE_AUTO_FUND = 'false';

// ── Mock service dependencies ──────────────────────────────────────────────────

const mockValidateToken = jest.fn();
const mockMarkTokenUsed = jest.fn();
const mockBuildConfirmationURL = jest.fn();

jest.mock('../../../../services/sms/transferTokenService', () => ({
  validateToken: mockValidateToken,
  generateToken: jest.fn(),
  storeToken: jest.fn(),
  markTokenUsed: mockMarkTokenUsed,
  buildConfirmationURL: mockBuildConfirmationURL,
}));

const mockConfirmPendingTransfer = jest.fn();

jest.mock('../../../../services/sms/pendingTransferService', () => ({
  confirmPendingTransfer: mockConfirmPendingTransfer,
  createPendingTransfer: jest.fn(),
  getPendingTransfer: jest.fn(),
}));

const mockBuildTransferCompleteMessage = jest.fn(() => 'Transfer complete SMS text');

jest.mock('../../../../services/sms/messageTemplates', () => ({
  buildTransferCompleteMessage: mockBuildTransferCompleteMessage,
  buildTransferReadyMessage: jest.fn(),
  buildDisambiguationMessage: jest.fn(),
  buildRecipientNotFoundMessage: jest.fn(),
  buildCancellationMessage: jest.fn(),
  buildUnknownMessage: jest.fn(),
  buildHelpMessage: jest.fn(),
}));

const mockSendMessage = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../../../services/agentphone/agentphoneClient', () => ({
  sendMessage: mockSendMessage,
}));

// ── Mock WISE services ────────────────────────────────────────────────────────

const mockExecuteTransfer = jest.fn();

jest.mock('../../../../services/wise/wiseClient', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../../services/wise/wiseQuoteService', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../../services/wise/wiseRecipientService', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../../services/wise/wiseTransferService', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../../services/wise/wisePaymentService', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../../services/wise/wiseOrchestrator', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    executeTransfer: mockExecuteTransfer,
  })),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({})),
}));

// ── Load handler ───────────────────────────────────────────────────────────────

const handler = require('../../../../pages/api/sms/transfer/execute').default;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRes() {
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return res;
}

function makeReq(body = {}, method = 'POST') {
  return { method, body, socket: { remoteAddress: '127.0.0.1' }, headers: {} };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const validTransfer = {
  id: 'pt_001',
  user_id: 'user_abc',
  phone_number: '+1234567890',
  source_amount: 500,
  source_currency: 'USD',
  target_amount: 41250,
  target_currency: 'INR',
  exchange_rate: 82.5,
  wise_quote_id: 'quote_001',
  wise_recipient: {
    id: 'rec_001',
    account_holder_name: 'Maria Garcia',
    upi_id: 'maria@paytm',
  },
};

const validTokenRecord = {
  short_token: 'xYz9K12A',
  expires_at: new Date(Date.now() + 840_000).toISOString(),
};

const wiseResult = {
  transfer: {
    id: 'wise_transfer_123',
    reference: 'REF-ABC',
    status: 'processing',
  },
  isFunded: false,
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/sms/transfer/execute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteTransfer.mockResolvedValue(wiseResult);
    mockConfirmPendingTransfer.mockResolvedValue(undefined);
    mockMarkTokenUsed.mockResolvedValue(undefined);
  });

  test('rejects non-POST requests', async () => {
    const res = makeRes();
    await handler(makeReq({}, 'GET'), res);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test('returns 400 when token is missing', async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'Token is required' }));
  });

  test('returns 400 when token is invalid or expired', async () => {
    mockValidateToken.mockResolvedValue({ valid: false, error: 'Token expired' });

    const res = makeRes();
    await handler(makeReq({ token: 'badtoken' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Token expired' });
  });

  test('calls WiseOrchestrator with correct params from transfer', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      transfer: validTransfer,
      tokenRecord: validTokenRecord,
    });

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    expect(mockExecuteTransfer).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_abc',
      quoteId: 'quote_001',
      upiId: 'maria@paytm',
      payeeName: 'Maria Garcia',
      reference: expect.stringMatching(/^SMS-/),
      autoFund: false,
    }));
  });

  test('marks token as used after successful execution', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      transfer: validTransfer,
      tokenRecord: validTokenRecord,
    });

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    expect(mockMarkTokenUsed).toHaveBeenCalledWith('xYz9K12A', '127.0.0.1', undefined);
  });

  test('confirms pending transfer after WISE execution', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      transfer: validTransfer,
      tokenRecord: validTokenRecord,
    });

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    expect(mockConfirmPendingTransfer).toHaveBeenCalledWith('pt_001', 'wise_transfer_123');
  });

  test('returns 200 with transfer details on success', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      transfer: validTransfer,
      tokenRecord: validTokenRecord,
    });

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      transferId: 'wise_transfer_123',
      reference: 'REF-ABC',
      status: 'processing',
      isFunded: false,
    });
  });

  test('sends confirmation SMS fire-and-forget', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      transfer: validTransfer,
      tokenRecord: validTokenRecord,
    });

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    // Allow fire-and-forget to settle
    await Promise.resolve();

    expect(mockBuildTransferCompleteMessage).toHaveBeenCalledWith(validTransfer, 'REF-ABC');
    expect(mockSendMessage).toHaveBeenCalledWith(
      '+1234567890',
      'Transfer complete SMS text',
      null
    );
  });

  test('returns 200 even if confirmation SMS fails (fire-and-forget)', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      transfer: validTransfer,
      tokenRecord: validTokenRecord,
    });
    mockSendMessage.mockRejectedValueOnce(new Error('SMS gateway down'));

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('returns 500 when WiseOrchestrator throws', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      transfer: validTransfer,
      tokenRecord: validTokenRecord,
    });
    mockExecuteTransfer.mockRejectedValue(new Error('WISE API error'));

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'WISE API error' });
  });

  test('returns 500 when validateToken throws unexpectedly', async () => {
    mockValidateToken.mockRejectedValue(new Error('DB connection lost'));

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test('uses bank account last4 recipient when upi_id is null', async () => {
    const transferWithBank = {
      ...validTransfer,
      wise_recipient: {
        ...validTransfer.wise_recipient,
        upi_id: null,
        account_number: '987654321',
      },
    };

    mockValidateToken.mockResolvedValue({
      valid: true,
      transfer: transferWithBank,
      tokenRecord: validTokenRecord,
    });

    const res = makeRes();
    await handler(makeReq({ token: 'xYz9K12A' }), res);

    expect(mockExecuteTransfer).toHaveBeenCalledWith(expect.objectContaining({
      upiId: null,
      payeeName: 'Maria Garcia',
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
