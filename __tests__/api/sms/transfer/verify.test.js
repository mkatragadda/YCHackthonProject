/**
 * Integration tests for GET /api/sms/transfer/verify
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test_anon_key';
process.env.TRANSFER_TOKEN_SECRET = 'test_secret_min_32_chars_long_ok';

const mockValidateToken = jest.fn();

jest.mock('../../../../services/sms/transferTokenService', () => ({
  validateToken: mockValidateToken,
  generateToken: jest.fn(),
  storeToken: jest.fn(),
  markTokenUsed: jest.fn(),
  buildConfirmationURL: jest.fn()
}));

const handler = require('../../../../pages/api/sms/transfer/verify').default;

function makeRes() {
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return res;
}

const validTransfer = {
  id: 'pt_001',
  source_amount: 500,
  source_currency: 'USD',
  target_amount: 41250,
  target_currency: 'INR',
  exchange_rate: 82.5,
  status: 'pending',
  expiresIn: '14 minutes',
  wise_recipient: {
    id: 'rec_001',
    account_holder_name: 'Maria Garcia',
    type: 'upi',
    upi_id: 'maria@paytm'
  }
};

const validTokenRecord = {
  short_token: 'xYz9K12A',
  expires_at: new Date(Date.now() + 840_000).toISOString()
};

describe('GET /api/sms/transfer/verify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects non-GET requests', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: { token: 'abc' } }, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  test('returns 400 when token query param is missing', async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ valid: false }));
  });

  test('returns 400 for invalid/expired/used token', async () => {
    mockValidateToken.mockResolvedValue({ valid: false, error: 'Token expired' });

    const res = makeRes();
    await handler({ method: 'GET', query: { token: 'badtoken' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ valid: false, error: 'Token expired' });
  });

  test('returns 200 with transfer details for valid token', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      tokenRecord: validTokenRecord,
      transfer: validTransfer
    });

    const res = makeRes();
    await handler({ method: 'GET', query: { token: 'xYz9K12A' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.valid).toBe(true);
    expect(body.transfer.id).toBe('pt_001');
    expect(body.transfer.source_amount).toBe(500);
    expect(body.transfer.wise_recipient.account_holder_name).toBe('Maria Garcia');
    expect(body.transfer.wise_recipient.last4).toBe('aytm'); // last 4 of 'maria@paytm'
    expect(body.transfer.expiresIn).toBe('14 minutes');
    expect(body.transfer.expires_at).toBe(validTokenRecord.expires_at);
  });

  test('computes last4 from account_number when upi_id is null', async () => {
    mockValidateToken.mockResolvedValue({
      valid: true,
      tokenRecord: validTokenRecord,
      transfer: {
        ...validTransfer,
        wise_recipient: {
          ...validTransfer.wise_recipient,
          upi_id: null,
          account_number: '987654321'
        }
      }
    });

    const res = makeRes();
    await handler({ method: 'GET', query: { token: 'xYz9K12A' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.transfer.wise_recipient.last4).toBe('4321');
  });

  test('returns 500 on unexpected error', async () => {
    mockValidateToken.mockRejectedValue(new Error('DB connection lost'));

    const res = makeRes();
    await handler({ method: 'GET', query: { token: 'xYz9K12A' } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ valid: false, error: 'Verification failed' });
  });
});
