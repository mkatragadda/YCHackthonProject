/**
 * Unit tests for conversationManager
 * Tests state machine transitions: get, set, reset, and context updates.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test_anon_key';

// ── Supabase mock ─────────────────────────────────────────────────────────────

let supabaseMockState = {
  conversation: null,
  upsertError: null,
  updateError: null,
  contextFetch: null
};

const mockChain = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  neq: jest.fn().mockReturnThis(),
  gt: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  single: jest.fn(),
  maybeSingle: jest.fn()
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(() => Promise.resolve({
        data: supabaseMockState.conversation,
        error: null
      })),
      single: jest.fn(() => Promise.resolve({
        data: supabaseMockState.upsertResult || { id: 'conv_001', state: 'idle' },
        error: supabaseMockState.upsertError || null
      }))
    }))
  }))
}));

const {
  getConversation,
  setConversationState,
  resetConversation,
  updateConversationContext
} = require('../../../../services/sms/conversationManager');

const PHONE = '+12345678901';
const USER_ID = 'user_abc';

describe('conversationManager', () => {
  beforeEach(() => {
    supabaseMockState = {
      conversation: null,
      upsertError: null,
      upsertResult: null,
      contextFetch: null
    };
    jest.clearAllMocks();
  });

  // ── getConversation ───────────────────────────────────────────────────────

  describe('getConversation()', () => {
    test('returns null when no active conversation exists', async () => {
      supabaseMockState.conversation = null;
      const result = await getConversation(PHONE);
      expect(result).toBeNull();
    });

    test('returns conversation record when active state exists', async () => {
      supabaseMockState.conversation = {
        id: 'conv_001',
        phone_number: PHONE,
        state: 'awaiting_disambiguation',
        context: { matches: [], amount: 100 }
      };

      const result = await getConversation(PHONE);
      expect(result).not.toBeNull();
      expect(result.state).toBe('awaiting_disambiguation');
    });
  });

  // ── setConversationState ──────────────────────────────────────────────────

  describe('setConversationState()', () => {
    test('returns the upserted record', async () => {
      supabaseMockState.upsertResult = {
        id: 'conv_001',
        phone_number: PHONE,
        user_id: USER_ID,
        state: 'awaiting_disambiguation',
        context: { matches: [] }
      };

      const result = await setConversationState(
        PHONE, USER_ID, 'awaiting_disambiguation', { matches: [] }
      );

      expect(result.state).toBe('awaiting_disambiguation');
      expect(result.id).toBe('conv_001');
    });

    test('throws when supabase upsert returns an error', async () => {
      supabaseMockState.upsertError = { message: 'unique violation' };

      await expect(
        setConversationState(PHONE, USER_ID, 'idle', {})
      ).rejects.toBeTruthy();
    });
  });

  // ── resetConversation ─────────────────────────────────────────────────────

  describe('resetConversation()', () => {
    test('resolves without throwing', async () => {
      await expect(resetConversation(PHONE)).resolves.toBeUndefined();
    });
  });

  // ── updateConversationContext ─────────────────────────────────────────────

  describe('updateConversationContext()', () => {
    test('resolves without throwing when record exists', async () => {
      supabaseMockState.conversation = { context: { amount: 100 } };
      await expect(
        updateConversationContext(PHONE, { recipient: { id: 'rec_1' } })
      ).resolves.toBeUndefined();
    });

    test('resolves gracefully when record not found', async () => {
      supabaseMockState.conversation = null;
      await expect(
        updateConversationContext(PHONE, { recipient: {} })
      ).resolves.toBeUndefined();
    });
  });

  // ── valid state values ────────────────────────────────────────────────────

  describe('valid state transitions', () => {
    const validStates = [
      'idle',
      'awaiting_disambiguation',
      'awaiting_amount',
      'awaiting_recipient',
      'ready_for_confirmation'
    ];

    test.each(validStates)('accepts state "%s"', async (state) => {
      supabaseMockState.upsertResult = { id: 'conv_x', state };
      const result = await setConversationState(PHONE, USER_ID, state, {});
      expect(result.state).toBe(state);
    });
  });
});
