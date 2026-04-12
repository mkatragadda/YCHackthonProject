/**
 * WiseQuoteService Tests
 * Critical tests for quote creation, validation, and PATCH operations
 */

import WiseQuoteService from '../../../services/wise/wiseQuoteService';

describe('WiseQuoteService', () => {
  let service;
  let mockClient;
  let mockSupabase;

  beforeEach(() => {
    // Mock WiseClient
    mockClient = {
      profileId: '12345',
      post: jest.fn(),
      patch: jest.fn(),
    };

    // Mock Supabase
    mockSupabase = {
      from: jest.fn(() => ({
        insert: jest.fn(() => ({
          select: jest.fn(() => ({
            single: jest.fn(() => ({ data: mockQuoteDbRecord, error: null })),
          })),
        })),
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({ data: mockQuoteDbRecord, error: null })),
          })),
        })),
        update: jest.fn(() => ({
          eq: jest.fn(() => ({ error: null })),
        })),
      })),
    };

    service = new WiseQuoteService(mockClient, mockSupabase);
  });

  const mockQuoteDbRecord = {
    id: 'db-quote-123',
    wise_quote_id: 'wise-quote-456',
    user_id: 'user-789',
    source_currency: 'USD',
    target_currency: 'INR',
    source_amount: 1.14,
    target_amount: 105,
    exchange_rate: 92.11,
    fee_total: 0.01,
    payment_type: 'BALANCE',
  };

  const mockWiseQuoteResponse = {
    id: 'wise-quote-456',
    rate: 92.11,
    sourceCurrency: 'USD',
    targetCurrency: 'INR',
    rateType: 'FIXED',
    expirationTime: '2026-04-18T07:00:00Z',
    paymentOptions: [
      {
        payIn: 'BALANCE',
        payOut: 'BANK_TRANSFER',
        sourceAmount: 1.14,
        targetAmount: 105,
        fee: {
          total: 0.01,
          transferwise: 0.01,
          payIn: 0,
          partner: 0,
        },
        disabled: false,
      },
      {
        payIn: 'BANK_TRANSFER',
        payOut: 'BANK_TRANSFER',
        sourceAmount: 7.25,
        targetAmount: 105,
        fee: {
          total: 6.12,
          transferwise: 0.01,
          payIn: 6.11,
          partner: 0,
        },
        disabled: false,
      },
    ],
  };

  describe('createQuote', () => {
    beforeEach(() => {
      mockClient.post.mockResolvedValue(mockWiseQuoteResponse);
    });

    describe('Quote mode validation', () => {
      it('should create quote with sourceAmount', async () => {
        await service.createQuote({
          userId: 'user-123',
          sourceAmount: 100,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        });

        expect(mockClient.post).toHaveBeenCalledWith(
          '/v3/profiles/12345/quotes',
          expect.objectContaining({
            sourceAmount: 100,
            sourceCurrency: 'USD',
            targetCurrency: 'INR',
            payOut: 'BANK_TRANSFER',
            preferredPayIn: 'BALANCE',
          })
        );
      });

      it('should create quote with targetAmount', async () => {
        await service.createQuote({
          userId: 'user-123',
          targetAmount: 105,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        });

        expect(mockClient.post).toHaveBeenCalledWith(
          '/v3/profiles/12345/quotes',
          expect.objectContaining({
            targetAmount: 105,
            sourceCurrency: 'USD',
            targetCurrency: 'INR',
          })
        );
      });

      it('should throw error if both sourceAmount and targetAmount provided', async () => {
        await expect(
          service.createQuote({
            userId: 'user-123',
            sourceAmount: 100,
            targetAmount: 105,
            sourceCurrency: 'USD',
            targetCurrency: 'INR',
          })
        ).rejects.toThrow('Provide either sourceAmount OR targetAmount, not both');
      });

      it('should throw error if neither sourceAmount nor targetAmount provided', async () => {
        await expect(
          service.createQuote({
            userId: 'user-123',
            sourceCurrency: 'USD',
            targetCurrency: 'INR',
          })
        ).rejects.toThrow('Must provide either sourceAmount or targetAmount');
      });
    });

    describe('Payment option validation', () => {
      it('should select BALANCE payment option', async () => {
        const result = await service.createQuote({
          userId: 'user-123',
          targetAmount: 105,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        });

        expect(result.payment_type).toBe('BALANCE');
        expect(result.fee_total).toBe(0.01);
        expect(result.source_amount).toBe(1.14);
      });

      it('should throw error if BALANCE option not available', async () => {
        const responseWithoutBalance = {
          ...mockWiseQuoteResponse,
          paymentOptions: mockWiseQuoteResponse.paymentOptions.filter(
            opt => opt.payIn !== 'BALANCE'
          ),
        };
        mockClient.post.mockResolvedValue(responseWithoutBalance);

        await expect(
          service.createQuote({
            userId: 'user-123',
            targetAmount: 105,
            sourceCurrency: 'USD',
            targetCurrency: 'INR',
          })
        ).rejects.toThrow('BALANCE payment option not available');
      });

      it('should skip disabled payment options', async () => {
        const responseWithDisabledBalance = {
          ...mockWiseQuoteResponse,
          paymentOptions: [
            { ...mockWiseQuoteResponse.paymentOptions[0], disabled: true },
            mockWiseQuoteResponse.paymentOptions[1],
          ],
        };
        mockClient.post.mockResolvedValue(responseWithDisabledBalance);

        await expect(
          service.createQuote({
            userId: 'user-123',
            targetAmount: 105,
            sourceCurrency: 'USD',
            targetCurrency: 'INR',
          })
        ).rejects.toThrow('BALANCE payment option not available');
      });
    });

    describe('Fee calculation validation', () => {
      it('should validate sourceAmount includes fee', async () => {
        const result = await service.createQuote({
          userId: 'user-123',
          targetAmount: 105,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        });

        // sourceAmount should equal (targetAmount / rate) + fee
        const expectedSource = (105 / 92.11) + 0.01;
        expect(result.source_amount).toBeCloseTo(expectedSource, 2);
      });

      it('should extract fee breakdown correctly', async () => {
        const result = await service.createQuote({
          userId: 'user-123',
          targetAmount: 105,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        });

        expect(result.fee_total).toBe(0.01);
        expect(result.fee_transferwise).toBe(0.01);
        expect(result.fee_partner).toBe(0);
      });
    });

    describe('Database operations', () => {
      it('should save quote to database', async () => {
        await service.createQuote({
          userId: 'user-123',
          targetAmount: 105,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
          upiScanId: 'scan-456',
        });

        expect(mockSupabase.from).toHaveBeenCalledWith('wise_quotes');
      });

      it('should handle database errors', async () => {
        mockSupabase.from = jest.fn(() => ({
          insert: jest.fn(() => ({
            select: jest.fn(() => ({
              single: jest.fn(() => ({ data: null, error: { message: 'DB error' } })),
            })),
          })),
        }));

        await expect(
          service.createQuote({
            userId: 'user-123',
            targetAmount: 105,
            sourceCurrency: 'USD',
            targetCurrency: 'INR',
          })
        ).rejects.toThrow();
      });
    });
  });

  describe('updateQuoteWithRecipient', () => {
    const mockRecipientDbRecord = {
      id: 'db-recipient-123',
      wise_account_id: 'wise-account-789',
      upi_id: '1234567890@upi',
      payee_name: 'Test User',
    };

    beforeEach(() => {
      mockClient.patch.mockResolvedValue({
        ...mockWiseQuoteResponse,
        targetAccount: 'wise-account-789',
      });

      // Mock database to return both quote and recipient
      mockSupabase.from = jest.fn((table) => {
        if (table === 'wise_quotes') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({ data: mockQuoteDbRecord, error: null })),
              })),
            })),
            update: jest.fn(() => ({
              eq: jest.fn(() => ({ error: null })),
            })),
          };
        } else if (table === 'wise_recipients') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({ data: mockRecipientDbRecord, error: null })),
              })),
            })),
          };
        }
      });
    });

    it('should PATCH quote with recipient account', async () => {
      await service.updateQuoteWithRecipient('db-quote-123', 'db-recipient-123');

      expect(mockClient.patch).toHaveBeenCalledWith(
        '/v3/profiles/12345/quotes/wise-quote-456',
        { targetAccount: 'wise-account-789' }
      );
    });

    it('should throw error if quote not found', async () => {
      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({ data: null, error: { message: 'Not found' } })),
          })),
        })),
      }));

      await expect(
        service.updateQuoteWithRecipient('invalid-quote', 'recipient-123')
      ).rejects.toThrow('Quote not found');
    });

    it('should throw error if recipient not found', async () => {
      mockSupabase.from = jest.fn((table) => {
        if (table === 'wise_quotes') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({ data: mockQuoteDbRecord, error: null })),
              })),
            })),
          };
        } else {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                single: jest.fn(() => ({ data: null, error: { message: 'Not found' } })),
              })),
            })),
          };
        }
      });

      await expect(
        service.updateQuoteWithRecipient('quote-123', 'invalid-recipient')
      ).rejects.toThrow('Recipient not found');
    });

    it('should update quote in database with new API response', async () => {
      await service.updateQuoteWithRecipient('db-quote-123', 'db-recipient-123');

      expect(mockSupabase.from).toHaveBeenCalledWith('wise_quotes');
    });

    it('should validate fee after PATCH', async () => {
      // Mock high fee after PATCH
      const highFeeResponse = {
        ...mockWiseQuoteResponse,
        paymentOptions: [
          {
            ...mockWiseQuoteResponse.paymentOptions[0],
            fee: { total: 0.6, transferwise: 0.6, payIn: 0, partner: 0 },
          },
        ],
      };
      mockClient.patch.mockResolvedValue(highFeeResponse);

      // Should not throw, but should log warning
      await service.updateQuoteWithRecipient('db-quote-123', 'db-recipient-123');

      expect(mockClient.patch).toHaveBeenCalled();
    });
  });

  describe('getQuote', () => {
    it('should return active quote', async () => {
      const activeQuote = {
        ...mockQuoteDbRecord,
        status: 'active',
        expires_at: new Date(Date.now() + 1000000).toISOString(),
      };

      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({ data: activeQuote, error: null })),
          })),
        })),
      }));

      const result = await service.getQuote('quote-123');
      expect(result.status).toBe('active');
    });

    it('should throw error if quote expired', async () => {
      const expiredQuote = {
        ...mockQuoteDbRecord,
        status: 'active',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      };

      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({ data: expiredQuote, error: null })),
          })),
        })),
        update: jest.fn(() => ({
          eq: jest.fn(() => ({ error: null })),
        })),
      }));

      await expect(service.getQuote('quote-123')).rejects.toThrow('expired');
    });

    it('should throw error if quote not active', async () => {
      const usedQuote = {
        ...mockQuoteDbRecord,
        status: 'used',
      };

      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({ data: usedQuote, error: null })),
          })),
        })),
      }));

      await expect(service.getQuote('quote-123')).rejects.toThrow('used');
    });
  });

  describe('markQuoteUsed', () => {
    it('should mark quote as used', async () => {
      const updateMock = jest.fn(() => ({
        eq: jest.fn(() => ({ error: null })),
      }));

      mockSupabase.from = jest.fn(() => ({
        update: updateMock,
      }));

      await service.markQuoteUsed('quote-123', 'transfer-456');

      expect(mockSupabase.from).toHaveBeenCalledWith('wise_quotes');
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'used',
          used_for_transfer_id: 'transfer-456',
        })
      );
    });
  });
});
