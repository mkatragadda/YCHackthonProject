/**
 * WiseTransferService Tests
 * Tests for transfer creation and validation
 */

import WiseTransferService from '../../../services/wise/wiseTransferService';

describe('WiseTransferService', () => {
  let service;
  let mockClient;
  let mockSupabase;

  const mockTransferResponse = {
    id: 2084071624,
    status: 'incoming_payment_waiting',
    sourceValue: 1.13,
    targetValue: 105,
    sourceCurrency: 'USD',
    targetCurrency: 'INR',
    rate: 92.6054,
    quoteUuid: 'quote-uuid-123',
    targetAccount: 1406051422,
    customerTransactionId: 'txn-123',
  };

  beforeEach(() => {
    mockClient = {
      profileId: '12345',
      post: jest.fn().mockResolvedValue(mockTransferResponse),
    };

    mockSupabase = {
      from: jest.fn((table) => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => {
              if (table === 'wise_quotes') {
                return {
                  data: {
                    id: 'quote-123',
                    wise_quote_id: 'quote-uuid-123',
                    payment_type: 'BALANCE',
                    source_amount: 1.14,
                    target_amount: 105,
                    exchange_rate: 92.6054,
                    source_currency: 'USD',
                    target_currency: 'INR',
                  },
                  error: null,
                };
              } else if (table === 'wise_recipients') {
                return {
                  data: {
                    id: 'recipient-123',
                    wise_account_id: 1406051422,
                    upi_id: '123@upi',
                  },
                  error: null,
                };
              }
            }),
          })),
        })),
        insert: jest.fn(() => ({
          select: jest.fn(() => ({
            single: jest.fn(() => ({
              data: { id: 'transfer-db-123' },
              error: null,
            })),
          })),
        })),
      })),
    };

    service = new WiseTransferService(mockClient, mockSupabase);
  });

  describe('createTransfer', () => {
    it('should validate quote uses BALANCE payment type', async () => {
      await service.createTransfer({
        userId: 'user-123',
        quoteId: 'quote-123',
        recipientId: 'recipient-123',
        reference: 'Test payment',
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('wise_quotes');
    });

    it('should throw error if quote does not use BALANCE', async () => {
      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: {
                id: 'quote-123',
                payment_type: 'BANK_TRANSFER', // Wrong payment type
              },
              error: null,
            })),
          })),
        })),
      }));

      await expect(
        service.createTransfer({
          userId: 'user-123',
          quoteId: 'quote-123',
          recipientId: 'recipient-123',
        })
      ).rejects.toThrow('Quote must use BALANCE payment type');
    });

    it('should create transfer with correct payload', async () => {
      await service.createTransfer({
        userId: 'user-123',
        quoteId: 'quote-123',
        recipientId: 'recipient-123',
        reference: 'Test payment',
      });

      expect(mockClient.post).toHaveBeenCalledWith(
        '/v1/transfers',
        expect.objectContaining({
          targetAccount: 1406051422,
          quoteUuid: 'quote-uuid-123',
          customerTransactionId: expect.any(String),
          details: expect.objectContaining({
            sourceOfFunds: 'balance',
            transferPurpose: 'Sending money to family',
          }),
        })
      );
    });

    it('should generate unique customer transaction ID', async () => {
      const result1 = await service.createTransfer({
        userId: 'user-123',
        quoteId: 'quote-123',
        recipientId: 'recipient-123',
      });

      const result2 = await service.createTransfer({
        userId: 'user-123',
        quoteId: 'quote-123',
        recipientId: 'recipient-123',
      });

      // Extract customerTransactionIds from calls
      const call1 = mockClient.post.mock.calls[0][1].customerTransactionId;
      const call2 = mockClient.post.mock.calls[1][1].customerTransactionId;

      expect(call1).not.toBe(call2);
    });

    it('should save transfer to database', async () => {
      await service.createTransfer({
        userId: 'user-123',
        quoteId: 'quote-123',
        recipientId: 'recipient-123',
        upiScanId: 'scan-456',
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('wise_transfers');
    });

    it('should throw error if quote not found', async () => {
      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: null,
              error: { message: 'Not found' },
            })),
          })),
        })),
      }));

      await expect(
        service.createTransfer({
          userId: 'user-123',
          quoteId: 'invalid-quote',
          recipientId: 'recipient-123',
        })
      ).rejects.toThrow('Quote not found');
    });

    it('should throw error if recipient not found', async () => {
      mockSupabase.from = jest.fn((table) => {
        if (table === 'wise_quotes') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: { id: 'quote-123', payment_type: 'BALANCE' },
                  error: null,
                })),
              })),
            })),
          };
        } else {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: null,
                  error: { message: 'Not found' },
                })),
              })),
            })),
          };
        }
      });

      await expect(
        service.createTransfer({
          userId: 'user-123',
          quoteId: 'quote-123',
          recipientId: 'invalid-recipient',
        })
      ).rejects.toThrow('Recipient not found');
    });

    it('should map Wise status to internal status', async () => {
      const result = await service.createTransfer({
        userId: 'user-123',
        quoteId: 'quote-123',
        recipientId: 'recipient-123',
      });

      // incoming_payment_waiting should map to 'pending'
      expect(result).toBeDefined();
    });

    it('should mark transfer as not funded', async () => {
      const insertMock = jest.fn(() => ({
        select: jest.fn(() => ({
          single: jest.fn(() => ({
            data: { id: 'transfer-db-123', is_funded: false },
            error: null,
          })),
        })),
      }));

      mockSupabase.from = jest.fn((table) => {
        if (table === 'wise_quotes') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: {
                    id: 'quote-123',
                    wise_quote_id: 'quote-uuid-123',
                    payment_type: 'BALANCE',
                    source_amount: 1.14,
                    target_amount: 105,
                    exchange_rate: 92.6054,
                    source_currency: 'USD',
                    target_currency: 'INR',
                  },
                  error: null,
                })),
              })),
            })),
          };
        } else if (table === 'wise_recipients') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: {
                    id: 'recipient-123',
                    wise_account_id: 1406051422,
                    upi_id: '123@upi',
                  },
                  error: null,
                })),
              })),
            })),
          };
        } else if (table === 'wise_transfers') {
          return { insert: insertMock };
        } else {
          return {
            insert: jest.fn(() => ({
              select: jest.fn(() => ({
                single: jest.fn(() => ({ data: null, error: null })),
              })),
            })),
          };
        }
      });

      await service.createTransfer({
        userId: 'user-123',
        quoteId: 'quote-123',
        recipientId: 'recipient-123',
      });

      const insertCall = insertMock.mock.calls[0][0];
      expect(insertCall.is_funded).toBe(false);
    });
  });

  describe('_mapWiseStatus', () => {
    it('should map incoming_payment_waiting to pending', () => {
      const result = service._mapWiseStatus('incoming_payment_waiting');
      expect(result).toBe('pending');
    });

    it('should map processing to processing', () => {
      const result = service._mapWiseStatus('processing');
      expect(result).toBe('processing');
    });

    it('should map bounced_back to failed', () => {
      const result = service._mapWiseStatus('bounced_back');
      expect(result).toBe('failed');
    });

    it('should map cancelled to cancelled', () => {
      const result = service._mapWiseStatus('cancelled');
      expect(result).toBe('cancelled');
    });

    it('should default unknown status to pending', () => {
      const result = service._mapWiseStatus('unknown_status');
      expect(result).toBe('pending');
    });
  });
});
