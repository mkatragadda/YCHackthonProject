/**
 * Unit tests for messageTemplates
 * Pure functions — no mocks required.
 */

process.env.NEXT_PUBLIC_APP_URL = 'https://vitta.app';

const {
  buildTransferReadyMessage,
  buildTransferCompleteMessage,
  buildDisambiguationMessage,
  buildRecipientNotFoundMessage,
  buildCancellationMessage,
  buildUnknownMessage,
  buildHelpMessage
} = require('../../../../services/sms/messageTemplates');

const mockRecipient = {
  id: 'rec_001',
  account_holder_name: 'Maria Garcia',
  type: 'upi',
  upi_id: 'maria@paytm',
  currency: 'INR'
};

const mockTransfer = {
  id: 'pt_001',
  source_amount: 500,
  source_currency: 'USD',
  target_amount: 41250,
  target_currency: 'INR',
  wise_recipient: mockRecipient
};

describe('messageTemplates', () => {

  describe('buildTransferReadyMessage()', () => {
    const confirmURL = 'https://vitta.app/transfer/confirm/xYz9K12';

    test('includes amount', () => {
      const msg = buildTransferReadyMessage(mockTransfer, confirmURL);
      expect(msg).toContain('500.00');
      expect(msg).toContain('USD');
    });

    test('includes recipient name', () => {
      const msg = buildTransferReadyMessage(mockTransfer, confirmURL);
      expect(msg).toContain('Maria Garcia');
    });

    test('includes last 4 chars of UPI ID', () => {
      const msg = buildTransferReadyMessage(mockTransfer, confirmURL);
      expect(msg).toContain('paytm'.slice(-4));
    });

    test('includes confirmation URL', () => {
      const msg = buildTransferReadyMessage(mockTransfer, confirmURL);
      expect(msg).toContain(confirmURL);
    });

    test('mentions 15 minutes expiry', () => {
      const msg = buildTransferReadyMessage(mockTransfer, confirmURL);
      expect(msg).toMatch(/15 minutes/i);
    });

    test('uses account_number hint when no upi_id', () => {
      const transfer = {
        ...mockTransfer,
        wise_recipient: { ...mockRecipient, upi_id: null, account_number: '987654321' }
      };
      const msg = buildTransferReadyMessage(transfer, confirmURL);
      expect(msg).toContain('4321');
    });

    test('falls back to type label when no upi_id or account_number', () => {
      const transfer = {
        ...mockTransfer,
        wise_recipient: { ...mockRecipient, upi_id: null, account_number: null, type: 'bank_transfer' }
      };
      const msg = buildTransferReadyMessage(transfer, confirmURL);
      expect(msg).toContain('bank_transfer');
    });
  });

  describe('buildTransferCompleteMessage()', () => {
    test('includes amount and recipient name', () => {
      const msg = buildTransferCompleteMessage(mockTransfer, 'REF123456');
      expect(msg).toContain('500.00');
      expect(msg).toContain('Maria Garcia');
    });

    test('includes reference number', () => {
      const msg = buildTransferCompleteMessage(mockTransfer, 'REF123456');
      expect(msg).toContain('REF123456');
    });

    test('includes receipt link', () => {
      const msg = buildTransferCompleteMessage(mockTransfer, 'REF123456');
      expect(msg).toContain('https://vitta.app/receipt/pt_001');
    });

    test('includes checkmark emoji', () => {
      const msg = buildTransferCompleteMessage(mockTransfer, 'REF123456');
      expect(msg).toContain('✅');
    });
  });

  describe('buildDisambiguationMessage()', () => {
    const matches = [
      { account_holder_name: 'Maria Garcia' },
      { account_holder_name: 'Maria Lopez' }
    ];

    test('lists all matches with numbers', () => {
      const msg = buildDisambiguationMessage(matches, 'Maria');
      expect(msg).toContain('1. Maria Garcia');
      expect(msg).toContain('2. Maria Lopez');
    });

    test('includes the original query', () => {
      const msg = buildDisambiguationMessage(matches, 'Maria');
      expect(msg).toContain('"Maria"');
    });

    test('tells user how many contacts were found', () => {
      const msg = buildDisambiguationMessage(matches, 'Maria');
      expect(msg).toContain('2 contacts');
    });

    test('prompts user to reply with number', () => {
      const msg = buildDisambiguationMessage(matches, 'Maria');
      expect(msg).toMatch(/reply with the number/i);
    });
  });

  describe('buildRecipientNotFoundMessage()', () => {
    test('includes the searched name', () => {
      const msg = buildRecipientNotFoundMessage('stranger');
      expect(msg).toContain('"stranger"');
    });

    test('includes add recipients link', () => {
      const msg = buildRecipientNotFoundMessage('stranger');
      expect(msg).toContain('https://vitta.app/recipients');
    });
  });

  describe('buildCancellationMessage()', () => {
    test('contains cancellation confirmation', () => {
      expect(buildCancellationMessage()).toMatch(/cancelled/i);
    });
  });

  describe('buildUnknownMessage()', () => {
    test('shows example command', () => {
      expect(buildUnknownMessage()).toMatch(/Send \$100 to mom/i);
    });

    test('offers help command', () => {
      expect(buildUnknownMessage()).toMatch(/help/i);
    });
  });

  describe('buildHelpMessage()', () => {
    test('includes transfer example', () => {
      expect(buildHelpMessage()).toMatch(/Send \$500 to mom/i);
    });

    test('includes cancel command', () => {
      expect(buildHelpMessage()).toMatch(/cancel/i);
    });
  });
});
