/**
 * WisePaymentService Tests
 * CRITICAL: Tests for funding transfers with real money
 */

import WisePaymentService from '../../../services/wise/wisePaymentService';

describe('WisePaymentService', () => {
  let service;
  let mockClient;
  let mockSupabase;

  const mockPaymentResponse = {
    status: 'COMPLETED',
    type: 'BALANCE',
    balanceTransactionId: 5138694865,
    errorCode: null,
    errorMessage: null,
  };

  beforeEach(() => {
    mockClient = {
      profileId: '12345',
      post: jest.fn().mockResolvedValue(mockPaymentResponse),
    };

    mockSupabase = {
      from: jest.fn((table) => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => {
              if (table === 'wise_transfers') {
                return {
                  data: {
                    id: 'transfer-123',
                    wise_transfer_id: 2084071624,
                    user_id: 'user-123',
                    source_amount: 1.14,
                    source_currency: 'USD',
                    target_amount: 105,
                    target_currency: 'INR',
                    is_funded: false,
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
              data: { id: 'payment-123' },
              error: null,
            })),
          })),
        })),
        update: jest.fn(() => ({
          eq: jest.fn(() => ({ error: null })),
        })),
      })),
    };

    service = new WisePaymentService(mockClient, mockSupabase);
  });

  describe('fundTransfer - Critical Safety Tests', () => {
    it('should ONLY accept BALANCE payment type', async () => {
      await expect(
        service.fundTransfer({
          transferId: 'transfer-123',
          paymentType: 'BANK_TRANSFER',
        })
      ).rejects.toThrow('Payment type must be BALANCE');
    });

    it('should reject if transfer not found', async () => {
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
        service.fundTransfer({
          transferId: 'invalid-transfer',
          paymentType: 'BALANCE',
        })
      ).rejects.toThrow('Transfer not found');
    });

    it('should reject if transfer already funded', async () => {
      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: {
                id: 'transfer-123',
                wise_transfer_id: 2084071624,
                is_funded: true, // Already funded!
              },
              error: null,
            })),
          })),
        })),
      }));

      await expect(
        service.fundTransfer({
          transferId: 'transfer-123',
          paymentType: 'BALANCE',
        })
      ).rejects.toThrow('Transfer already funded');
    });

    it('should call Wise API with BALANCE type', async () => {
      await service.fundTransfer({
        transferId: 'transfer-123',
        paymentType: 'BALANCE',
      });

      expect(mockClient.post).toHaveBeenCalledWith(
        '/v3/profiles/12345/transfers/2084071624/payments',
        { type: 'BALANCE' }
      );
    });

    it('should save payment to database', async () => {
      await service.fundTransfer({
        transferId: 'transfer-123',
        paymentType: 'BALANCE',
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('wise_payments');
    });

    it('should update transfer as funded', async () => {
      const updateMock = jest.fn(() => ({
        eq: jest.fn(() => ({ error: null })),
      }));

      mockSupabase.from = jest.fn((table) => {
        if (table === 'wise_transfers' && mockSupabase.from.mock.calls.length === 1) {
          // First call - select transfer
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: {
                    id: 'transfer-123',
                    wise_transfer_id: 2084071624,
                    user_id: 'user-123',
                    source_amount: 1.14,
                    source_currency: 'USD',
                    target_amount: 105,
                    target_currency: 'INR',
                    is_funded: false,
                  },
                  error: null,
                })),
              })),
            })),
          };
        } else if (table === 'wise_payments') {
          return {
            insert: jest.fn(() => ({
              select: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: { id: 'payment-123' },
                  error: null,
                })),
              })),
            })),
          };
        } else if (table === 'wise_transfers') {
          // Second call - update transfer
          return { update: updateMock };
        } else {
          return {
            insert: jest.fn(() => ({
              select: jest.fn(() => ({
                single: jest.fn(() => ({ data: {}, error: null })),
              })),
            })),
          };
        }
      });

      await service.fundTransfer({
        transferId: 'transfer-123',
        paymentType: 'BALANCE',
      });

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          is_funded: true,
          status: 'processing',
        })
      );
    });

    it('should handle payment failures', async () => {
      mockClient.post.mockRejectedValue(new Error('Insufficient balance'));

      await expect(
        service.fundTransfer({
          transferId: 'transfer-123',
          paymentType: 'BALANCE',
        })
      ).rejects.toThrow('Payment funding failed');
    });

    it('should log event after payment', async () => {
      await service.fundTransfer({
        transferId: 'transfer-123',
        paymentType: 'BALANCE',
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('wise_transfer_events');
    });
  });

  describe('Payment validation', () => {
    it('should validate payment type is string', async () => {
      await expect(
        service.fundTransfer({
          transferId: 'transfer-123',
          paymentType: 123, // Invalid type
        })
      ).rejects.toThrow();
    });

    it('should handle missing transferId', async () => {
      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: null,
              error: { message: 'Transfer not found' },
            })),
          })),
        })),
      }));

      await expect(
        service.fundTransfer({
          transferId: undefined,
          paymentType: 'BALANCE',
        })
      ).rejects.toThrow('Transfer not found');
    });
  });

  describe('Database error handling', () => {
    it('should handle database insert errors', async () => {
      mockSupabase.from = jest.fn((table) => {
        if (table === 'wise_transfers') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: { id: 'transfer-123', wise_transfer_id: 123, is_funded: false },
                  error: null,
                })),
              })),
            })),
          };
        } else if (table === 'wise_payments') {
          return {
            insert: jest.fn(() => ({
              select: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: null,
                  error: { message: 'DB error' },
                })),
              })),
            })),
          };
        }
      });

      await expect(
        service.fundTransfer({
          transferId: 'transfer-123',
          paymentType: 'BALANCE',
        })
      ).rejects.toThrow();
    });
  });
});
