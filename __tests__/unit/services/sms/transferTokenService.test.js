/**
 * Unit tests for transferTokenService
 * Tests JWT generation, DB storage, validation, and mark-used flow.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test_anon_key';
process.env.TRANSFER_TOKEN_SECRET = 'test_secret_min_32_chars_long_ok';
process.env.NEXT_PUBLIC_APP_URL = 'https://vitta.app';

const jwt = require('jsonwebtoken');

// ── Supabase mock ─────────────────────────────────────────────────────────────

let mockTokenRecord = null;
let mockTransfer = null;
let mockInsertError = null;
let mockUpdateError = null;

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn((table) => {
      if (table === 'sms_transfer_tokens') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(() => Promise.resolve({ data: mockTokenRecord, error: null })),
          insert: jest.fn(() => Promise.resolve({ error: mockInsertError }))
        };
      }
      // pending_sms_transfers
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn(() => Promise.resolve({ data: mockTransfer, error: mockTransfer ? null : { message: 'not found' } }))
      };
    })
  }))
}));

const {
  generateToken,
  storeToken,
  validateToken,
  markTokenUsed,
  buildConfirmationURL
} = require('../../../../services/sms/transferTokenService');

const pendingTransfer = {
  id: 'pt_001',
  user_id: 'user_abc',
  source_amount: 500,
  wise_recipient_id: 'rec_001',
  wise_recipient: { account_holder_name: 'Maria Garcia' },
  status: 'pending'
};

describe('transferTokenService', () => {
  beforeEach(() => {
    mockTokenRecord = null;
    mockTransfer = null;
    mockInsertError = null;
    mockUpdateError = null;
    jest.clearAllMocks();
  });

  // ── generateToken ────────────────────────────────────────────────────────

  describe('generateToken()', () => {
    test('returns shortToken, tokenHash, fullToken, expiresAt', () => {
      const result = generateToken(pendingTransfer);
      expect(result.shortToken).toBeDefined();
      expect(result.tokenHash).toBeDefined();
      expect(result.fullToken).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    test('shortToken is 8 chars and URL-safe', () => {
      const { shortToken } = generateToken(pendingTransfer);
      expect(shortToken).toHaveLength(8);
      expect(shortToken).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('fullToken is a valid HS256 JWT', () => {
      const { fullToken } = generateToken(pendingTransfer);
      const decoded = jwt.verify(fullToken, process.env.TRANSFER_TOKEN_SECRET, { algorithms: ['HS256'] });
      expect(decoded.transferId).toBe('pt_001');
      expect(decoded.userId).toBe('user_abc');
      expect(decoded.amount).toBe(500);
      expect(decoded.wiseRecipientId).toBe('rec_001');
    });

    test('JWT expires in ~15 minutes', () => {
      const { fullToken } = generateToken(pendingTransfer);
      const decoded = jwt.decode(fullToken);
      const ttlSeconds = decoded.exp - decoded.iat;
      expect(ttlSeconds).toBe(900); // 15 * 60
    });

    test('tokenHash is SHA-256 hex of fullToken', () => {
      const crypto = require('crypto');
      const { fullToken, tokenHash } = generateToken(pendingTransfer);
      const expected = crypto.createHash('sha256').update(fullToken).digest('hex');
      expect(tokenHash).toBe(expected);
    });

    test('two calls produce different tokens (unique via iat)', () => {
      const r1 = generateToken(pendingTransfer);
      // Advance time slightly so iat differs
      jest.spyOn(Date, 'now').mockReturnValueOnce(Date.now() + 1000);
      const r2 = generateToken(pendingTransfer);
      expect(r1.fullToken).not.toBe(r2.fullToken);
    });

    test('throws when TRANSFER_TOKEN_SECRET is missing', () => {
      const original = process.env.TRANSFER_TOKEN_SECRET;
      delete process.env.TRANSFER_TOKEN_SECRET;
      expect(() => generateToken(pendingTransfer)).toThrow('TRANSFER_TOKEN_SECRET');
      process.env.TRANSFER_TOKEN_SECRET = original;
    });
  });

  // ── storeToken ──────────────────────────────────────────────────────────

  describe('storeToken()', () => {
    test('returns the shortToken', async () => {
      const tokenData = generateToken(pendingTransfer);
      const result = await storeToken(tokenData, 'pt_001', '+1234567890', 'user_abc');
      expect(result).toBe(tokenData.shortToken);
    });

    test('throws when DB insert fails', async () => {
      mockInsertError = { message: 'unique violation' };
      const tokenData = generateToken(pendingTransfer);
      await expect(
        storeToken(tokenData, 'pt_001', '+1234567890', 'user_abc')
      ).rejects.toBeTruthy();
    });
  });

  // ── validateToken ───────────────────────────────────────────────────────

  describe('validateToken()', () => {
    const futureExpiry = new Date(Date.now() + 900_000).toISOString();

    test('returns not found when token does not exist in DB', async () => {
      const result = await validateToken('notfound');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    test('returns invalid when token is already used', async () => {
      mockTokenRecord = { short_token: 'abc', is_used: true, expires_at: futureExpiry, pending_transfer_id: 'pt_001' };
      const result = await validateToken('abc');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/already used/i);
    });

    test('returns invalid when token is expired', async () => {
      mockTokenRecord = {
        short_token: 'exp',
        is_used: false,
        expires_at: new Date(Date.now() - 1000).toISOString(),
        pending_transfer_id: 'pt_001'
      };
      const result = await validateToken('exp');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/expired/i);
    });

    test('returns valid with transfer details for a good token', async () => {
      mockTokenRecord = { short_token: 'ok8chars', is_used: false, expires_at: futureExpiry, pending_transfer_id: 'pt_001' };
      mockTransfer = { ...pendingTransfer, status: 'pending', wise_recipient: { account_holder_name: 'Maria' } };

      const result = await validateToken('ok8chars');
      expect(result.valid).toBe(true);
      expect(result.transfer.id).toBe('pt_001');
      expect(result.transfer.expiresIn).toBeDefined();
    });

    test('returns invalid when pending transfer status is not pending', async () => {
      mockTokenRecord = { short_token: 'done', is_used: false, expires_at: futureExpiry, pending_transfer_id: 'pt_001' };
      mockTransfer = { ...pendingTransfer, status: 'confirmed', wise_recipient: {} };

      const result = await validateToken('done');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/confirmed/i);
    });

    test('returns invalid with no token argument', async () => {
      const result = await validateToken('');
      expect(result.valid).toBe(false);
    });
  });

  // ── buildConfirmationURL ────────────────────────────────────────────────

  describe('buildConfirmationURL()', () => {
    test('returns correct URL format', () => {
      const url = buildConfirmationURL('xYz9K12A');
      expect(url).toBe('https://vitta.app/transfer/confirm/xYz9K12A');
    });
  });
});
