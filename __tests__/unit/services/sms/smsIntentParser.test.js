/**
 * Unit tests for smsIntentParser
 * Tests intent detection and entity extraction from raw SMS messages.
 */

const { parseIntent } = require('../../../../services/sms/smsIntentParser');

describe('smsIntentParser - parseIntent()', () => {
  // ── transfer_money ────────────────────────────────────────────────────────

  describe('transfer_money intent', () => {
    const cases = [
      { msg: 'Send $500 to mom',       amount: 500,   recipient: 'mom' },
      { msg: 'send 100 to dad',        amount: 100,   recipient: 'dad' },
      { msg: 'Send $50.00 to sister',  amount: 50,    recipient: 'sister' },
      { msg: 'transfer $200 to john',  amount: 200,   recipient: 'john' },
      { msg: 'transfer 75 to Alice',   amount: 75,    recipient: 'alice' },
      { msg: 'transfer $300 john',     amount: 300,   recipient: 'john' },
      { msg: 'pay mom $150',           amount: 150,   recipient: 'mom' },
      { msg: 'pay dad 250',            amount: 250,   recipient: 'dad' },
      { msg: 'send mom $80',           amount: 80,    recipient: 'mom' },
    ];

    test.each(cases)('parses "$msg"', ({ msg, amount, recipient }) => {
      const result = parseIntent(msg);
      expect(result.intent).toBe('transfer_money');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.entities.amount.value).toBe(amount);
      expect(result.entities.amount.currency).toBe('USD');
      expect(result.entities.recipient.value).toBe(recipient);
    });

    test('is case-insensitive', () => {
      const result = parseIntent('SEND $100 TO MOM');
      expect(result.intent).toBe('transfer_money');
      expect(result.entities.amount.value).toBe(100);
      expect(result.entities.recipient.value).toBe('mom');
    });

    test('trims extra whitespace', () => {
      const result = parseIntent('  send $50 to mom  ');
      expect(result.intent).toBe('transfer_money');
      expect(result.entities.amount.value).toBe(50);
    });

    test('rejects zero amount', () => {
      const result = parseIntent('send $0 to mom');
      expect(result.intent).toBe('unknown');
    });

    test('extracts raw recipient string', () => {
      const result = parseIntent('Send $100 to Maria Garcia');
      expect(result.entities.recipient.raw).toBe('Maria Garcia');
      expect(result.entities.recipient.value).toBe('maria garcia');
    });
  });

  // ── confirmation ──────────────────────────────────────────────────────────

  describe('confirmation intent', () => {
    const words = ['yes', 'yeah', 'yep', 'ok', 'okay', 'confirm', 'proceed', 'sure', 'go ahead', 'do it'];

    test.each(words)('recognises "%s"', (word) => {
      expect(parseIntent(word).intent).toBe('confirmation');
      expect(parseIntent(word.toUpperCase()).intent).toBe('confirmation');
    });
  });

  // ── cancellation ──────────────────────────────────────────────────────────

  describe('cancellation intent', () => {
    const words = ['no', 'nope', 'cancel', 'stop', 'nevermind', 'never mind', 'abort', 'quit'];

    test.each(words)('recognises "%s"', (word) => {
      expect(parseIntent(word).intent).toBe('cancellation');
    });
  });

  // ── disambiguation_response ───────────────────────────────────────────────

  describe('disambiguation_response intent', () => {
    test('parses digit selection when state is awaiting_disambiguation', () => {
      const state = { state: 'awaiting_disambiguation' };
      const result = parseIntent('2', state);
      expect(result.intent).toBe('disambiguation_response');
      expect(result.entities.selection).toBe(2);
      expect(result.confidence).toBe(1.0);
    });

    test('does NOT parse digit when state is idle', () => {
      const result = parseIntent('2', { state: 'idle' });
      expect(result.intent).toBe('unknown');
    });

    test('does NOT parse digit without conversation state', () => {
      const result = parseIntent('3');
      expect(result.intent).toBe('unknown');
    });

    test('rejects multi-digit input', () => {
      const state = { state: 'awaiting_disambiguation' };
      const result = parseIntent('12', state);
      expect(result.intent).toBe('unknown');
    });
  });

  // ── help ──────────────────────────────────────────────────────────────────

  describe('help intent', () => {
    test.each(['help', 'Help', 'HELP', '?', 'commands'])('recognises "%s"', (msg) => {
      expect(parseIntent(msg).intent).toBe('help');
    });
  });

  // ── unknown ───────────────────────────────────────────────────────────────

  describe('unknown intent', () => {
    test.each([
      'hello there',
      'what is my balance',  // handled by balance intent
      'random text',
      '',
    ])('returns unknown for "%s"', (msg) => {
      const result = parseIntent(msg);
      // either 'unknown' or another defined intent — never crashes
      expect(result.intent).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    test('returns confidence 0 for truly unknown messages', () => {
      const result = parseIntent('jkahsdkjahsd random gibberish 1234');
      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe(0);
    });
  });

  // ── entity structure ──────────────────────────────────────────────────────

  describe('entity structure', () => {
    test('transfer intent always returns entities object', () => {
      const result = parseIntent('Send $50 to mom');
      expect(result.entities).toBeDefined();
      expect(result.entities.amount).toBeDefined();
      expect(result.entities.recipient).toBeDefined();
    });

    test('non-transfer intents return empty entities', () => {
      const result = parseIntent('yes');
      expect(result.entities).toEqual({});
    });
  });
});
