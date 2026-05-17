/**
 * Unit tests for pendingTransferService
 * Verifies quote creation, DB insert, and fetch behaviour.
 * Both Supabase and WiseQuoteService are mocked.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test_anon_key';

// ── Mock WiseQuoteService ─────────────────────────────────────────────────────

const mockCreateQuote = jest.fn();

jest.mock('../../../../services/wise/wiseQuoteService', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    createQuote: mockCreateQuote
  }))
}));

// ── Mock Supabase ─────────────────────────────────────────────────────────────

let mockInsertResult = null;
let mockInsertError = null;
let mockFetchResult = null;
let mockFetchError = null;
let mockUpdateError = null;

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      single: jest.fn(() => {
        if (mockInsertResult !== null) {
          const res = { data: mockInsertResult, error: mockInsertError };
          mockInsertResult = null; // consume once for insert
          return Promise.resolve(res);
        }
        return Promise.resolve({ data: mockFetchResult, error: mockFetchError });
      })
    }))
  }))
}));

const { createPendingTransfer, getPendingTransfer, confirmPendingTransfer } =
  require('../../../../services/sms/pendingTransferService');

const wiseRecipient = {
  id: 'rec_001',
  account_holder_name: 'Maria Garcia',
  currency: 'INR',
  upi_id: 'maria@paytm'
};

const mockQuote = {
  id: 'quote_001',
  target_amount: 41250,
  target_currency: 'INR',
  exchange_rate: 82.5,
  expires_at: new Date(Date.now() + 300_000).toISOString()
};

describe('pendingTransferService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsertResult = null;
    mockInsertError = null;
    mockFetchResult = null;
    mockFetchError = null;
    mockCreateQuote.mockResolvedValue(mockQuote);
  });

  // ── createPendingTransfer ─────────────────────────────────────────────────

  describe('createPendingTransfer()', () => {
    const params = {
      userId: 'user_abc',
      phoneNumber: '+1234567890',
      wiseRecipient,
      sourceAmount: 500,
      rawMessage: 'Send $500 to mom'
    };

    test('calls wiseQuoteService with correct currencies', async () => {
      mockInsertResult = { id: 'pt_001', source_amount: 500, wise_recipient_id: 'rec_001', status: 'pending', user_id: 'user_abc' };

      await createPendingTransfer(params);

      expect(mockCreateQuote).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user_abc',
        sourceAmount: 500,
        sourceCurrency: 'USD',
        targetCurrency: 'INR'
      }));
    });

    test('returns pending transfer joined with wise_recipient', async () => {
      mockInsertResult = { id: 'pt_001', source_amount: 500, wise_recipient_id: 'rec_001', status: 'pending', user_id: 'user_abc' };

      const result = await createPendingTransfer(params);

      expect(result.id).toBe('pt_001');
      expect(result.wise_recipient).toEqual(wiseRecipient);
    });

    test('defaults target currency to INR when recipient.currency is missing', async () => {
      mockInsertResult = { id: 'pt_002', source_amount: 100, wise_recipient_id: 'rec_001', status: 'pending', user_id: 'user_abc' };

      await createPendingTransfer({ ...params, wiseRecipient: { ...wiseRecipient, currency: undefined } });

      expect(mockCreateQuote).toHaveBeenCalledWith(expect.objectContaining({ targetCurrency: 'INR' }));
    });

    test('throws when wiseQuoteService fails', async () => {
      mockCreateQuote.mockRejectedValue(new Error('Quote creation failed: WISE API down'));

      await expect(createPendingTransfer(params)).rejects.toThrow('WISE API down');
    });

    test('throws when DB insert fails', async () => {
      mockInsertResult = null;
      mockInsertError = { message: 'DB constraint violation' };

      await expect(createPendingTransfer(params)).rejects.toBeTruthy();
    });
  });

  // ── getPendingTransfer ────────────────────────────────────────────────────

  describe('getPendingTransfer()', () => {
    test('returns transfer with joined wise_recipient', async () => {
      mockFetchResult = { id: 'pt_001', status: 'pending', wise_recipient: wiseRecipient };

      const result = await getPendingTransfer('pt_001');
      expect(result.id).toBe('pt_001');
      expect(result.wise_recipient).toBeDefined();
    });

    test('throws when transfer not found', async () => {
      mockFetchError = { message: 'Not found' };
      await expect(getPendingTransfer('bad_id')).rejects.toBeTruthy();
    });
  });

  // ── confirmPendingTransfer ────────────────────────────────────────────────

  describe('confirmPendingTransfer()', () => {
    test('resolves without throwing on success', async () => {
      await expect(
        confirmPendingTransfer('pt_001', 'wise_transfer_123')
      ).resolves.toBeUndefined();
    });
  });
});
