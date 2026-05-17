/**
 * Unit tests for recipientMatcher
 * Tests nickname lookup, fuzzy name match, and not-found handling.
 * Supabase is fully mocked — no DB connection required.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test_anon_key';

// ── Supabase mock factory ─────────────────────────────────────────────────────

const mockRecipient = {
  id: 'rec_001',
  user_id: 'user_123',
  account_holder_name: 'Maria Garcia',
  currency: 'INR',
  type: 'upi',
  upi_id: 'maria@paytm',
  is_active: true
};

const mockRecipient2 = {
  id: 'rec_002',
  user_id: 'user_123',
  account_holder_name: 'Maria Lopez',
  currency: 'INR',
  type: 'upi',
  upi_id: 'lopez@paytm',
  is_active: true
};

// Controls what the supabase chain returns — reset in each test
let supabaseMockState = {
  nicknameResult: { data: null, error: null },
  nameResult: { data: [], error: null }
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn((table) => {
      if (table === 'wise_recipient_nicknames') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          ilike: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(() => Promise.resolve(supabaseMockState.nicknameResult))
        };
      }
      // wise_recipients
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        ilike: jest.fn(() => Promise.resolve(supabaseMockState.nameResult))
      };
    })
  }))
}));

const { matchRecipient } = require('../../../../services/sms/recipientMatcher');

const USER_ID = 'user_123';

describe('recipientMatcher - matchRecipient()', () => {
  beforeEach(() => {
    supabaseMockState = {
      nicknameResult: { data: null, error: null },
      nameResult: { data: [], error: null }
    };
  });

  // ── Nickname match ──────────────────────────────────────────────────────

  describe('nickname match (priority 1)', () => {
    test('returns matched when exact nickname found', async () => {
      supabaseMockState.nicknameResult = {
        data: {
          wise_recipient_id: 'rec_001',
          nickname: 'mom',
          wise_recipients: mockRecipient
        },
        error: null
      };

      const result = await matchRecipient('mom', USER_ID);

      expect(result.status).toBe('matched');
      expect(result.matchType).toBe('nickname');
      expect(result.recipient).toEqual(mockRecipient);
    });

    test('nickname lookup is case-insensitive (ilike)', async () => {
      supabaseMockState.nicknameResult = {
        data: { wise_recipient_id: 'rec_001', nickname: 'Mom', wise_recipients: mockRecipient },
        error: null
      };

      const result = await matchRecipient('MOM', USER_ID);
      expect(result.status).toBe('matched');
      expect(result.matchType).toBe('nickname');
    });
  });

  // ── Name match (fallback) ───────────────────────────────────────────────

  describe('name match (priority 2, when no nickname)', () => {
    test('returns matched for single name match', async () => {
      supabaseMockState.nameResult = { data: [mockRecipient], error: null };

      const result = await matchRecipient('Maria Garcia', USER_ID);

      expect(result.status).toBe('matched');
      expect(result.matchType).toBe('name');
      expect(result.recipient).toEqual(mockRecipient);
    });

    test('returns multiple when more than one name matches', async () => {
      supabaseMockState.nameResult = { data: [mockRecipient, mockRecipient2], error: null };

      const result = await matchRecipient('Maria', USER_ID);

      expect(result.status).toBe('multiple');
      expect(result.matchType).toBe('name');
      expect(result.matches).toHaveLength(2);
    });
  });

  // ── Not found ───────────────────────────────────────────────────────────

  describe('not_found', () => {
    test('returns not_found when no nickname and no name match', async () => {
      const result = await matchRecipient('unknownperson', USER_ID);
      expect(result.status).toBe('not_found');
    });

    test('returns not_found on DB error for name lookup', async () => {
      supabaseMockState.nameResult = { data: null, error: { message: 'DB error' } };

      const result = await matchRecipient('someone', USER_ID);
      expect(result.status).toBe('not_found');
    });
  });

  // ── Input normalisation ─────────────────────────────────────────────────

  describe('input normalisation', () => {
    test('trims whitespace from recipient string', async () => {
      supabaseMockState.nicknameResult = {
        data: { wise_recipient_id: 'rec_001', nickname: 'mom', wise_recipients: mockRecipient },
        error: null
      };

      const result = await matchRecipient('  mom  ', USER_ID);
      expect(result.status).toBe('matched');
    });
  });
});
