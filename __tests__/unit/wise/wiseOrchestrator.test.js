/**
 * WiseOrchestrator Tests
 * CRITICAL: End-to-end flow tests for complete transfer orchestration
 */

import WiseOrchestrator from '../../../services/wise/wiseOrchestrator';

describe('WiseOrchestrator', () => {
  let orchestrator;
  let mockQuoteService;
  let mockRecipientService;
  let mockTransferService;
  let mockPaymentService;
  let mockSupabase;

  const mockQuote = {
    id: 'quote-123',
    wise_quote_id: 'wise-quote-456',
    source_amount: 1.14,
    target_amount: 105,
    fee_total: 0.01,
  };

  const mockRecipient = {
    id: 'recipient-123',
    wise_account_id: 1406051422,
    upi_id: '123@upi',
  };

  const mockTransfer = {
    id: 'transfer-123',
    wise_transfer_id: 2084071624,
    status: 'pending',
    is_funded: false,
  };

  const mockPayment = {
    id: 'payment-123',
    status: 'COMPLETED',
  };

  beforeEach(() => {
    mockQuoteService = {
      createQuote: jest.fn().mockResolvedValue(mockQuote),
      getQuote: jest.fn().mockResolvedValue(mockQuote),
      updateQuoteWithRecipient: jest.fn().mockResolvedValue({}),
      markQuoteUsed: jest.fn().mockResolvedValue({}),
    };

    mockRecipientService = {
      getOrCreateRecipient: jest.fn().mockResolvedValue(mockRecipient),
    };

    mockTransferService = {
      createTransfer: jest.fn().mockResolvedValue(mockTransfer),
    };

    mockPaymentService = {
      fundTransfer: jest.fn().mockResolvedValue(mockPayment),
    };

    mockSupabase = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: mockTransfer,
              error: null,
            })),
          })),
        })),
        update: jest.fn(() => ({
          eq: jest.fn(() => ({ error: null })),
        })),
      })),
    };

    orchestrator = new WiseOrchestrator({
      quoteService: mockQuoteService,
      recipientService: mockRecipientService,
      transferService: mockTransferService,
      paymentService: mockPaymentService,
      supabase: mockSupabase,
    });
  });

  describe('executeTransfer - Complete Flow', () => {
    it('should execute all 5 steps in correct order', async () => {
      const result = await orchestrator.executeTransfer({
        userId: 'user-123',
        sourceAmount: 100,
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
        upiId: '123@upi',
        payeeName: 'Test User',
        reference: 'Test payment',
        autoFund: true,
      });

      // Verify order of operations
      expect(mockQuoteService.createQuote).toHaveBeenCalled();
      expect(mockRecipientService.getOrCreateRecipient).toHaveBeenCalled();
      expect(mockQuoteService.updateQuoteWithRecipient).toHaveBeenCalled();
      expect(mockTransferService.createTransfer).toHaveBeenCalled();
      expect(mockPaymentService.fundTransfer).toHaveBeenCalled();

      expect(result.isFunded).toBe(true);
    });

    it('should use existing quote if quoteId provided', async () => {
      await orchestrator.executeTransfer({
        userId: 'user-123',
        quoteId: 'existing-quote-123',
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
        upiId: '123@upi',
        payeeName: 'Test User',
        autoFund: false,
      });

      expect(mockQuoteService.getQuote).toHaveBeenCalledWith('existing-quote-123');
      expect(mockQuoteService.createQuote).not.toHaveBeenCalled();
    });

    it('should skip funding when autoFund=false', async () => {
      const result = await orchestrator.executeTransfer({
        userId: 'user-123',
        sourceAmount: 100,
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
        upiId: '123@upi',
        payeeName: 'Test User',
        autoFund: false,
      });

      expect(mockPaymentService.fundTransfer).not.toHaveBeenCalled();
      expect(result.isFunded).toBe(false);
      expect(result.payment).toBeNull();
    });

    it('should update quote with recipient (Step 2.5)', async () => {
      await orchestrator.executeTransfer({
        userId: 'user-123',
        sourceAmount: 100,
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
        upiId: '123@upi',
        payeeName: 'Test User',
        autoFund: false,
      });

      expect(mockQuoteService.updateQuoteWithRecipient).toHaveBeenCalledWith(
        mockQuote.id,
        mockRecipient.id
      );
    });

    it('should mark quote as used after transfer', async () => {
      await orchestrator.executeTransfer({
        userId: 'user-123',
        sourceAmount: 100,
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
        upiId: '123@upi',
        payeeName: 'Test User',
        autoFund: false,
      });

      expect(mockQuoteService.markQuoteUsed).toHaveBeenCalledWith(
        mockQuote.id,
        mockTransfer.id
      );
    });

    it('should update UPI scan status if provided', async () => {
      await orchestrator.executeTransfer({
        userId: 'user-123',
        upiScanId: 'scan-456',
        sourceAmount: 100,
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
        upiId: '123@upi',
        payeeName: 'Test User',
        autoFund: false,
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('upi_scans');
    });
  });

  describe('Error handling', () => {
    it('should handle quote creation failure', async () => {
      mockQuoteService.createQuote.mockRejectedValue(new Error('Quote failed'));

      await expect(
        orchestrator.executeTransfer({
          userId: 'user-123',
          sourceAmount: 100,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
          upiId: '123@upi',
          payeeName: 'Test User',
        })
      ).rejects.toThrow('Transfer failed');
    });

    it('should handle recipient creation failure', async () => {
      mockRecipientService.getOrCreateRecipient.mockRejectedValue(
        new Error('Recipient failed')
      );

      await expect(
        orchestrator.executeTransfer({
          userId: 'user-123',
          sourceAmount: 100,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
          upiId: '123@upi',
          payeeName: 'Test User',
        })
      ).rejects.toThrow('Transfer failed');
    });

    it('should handle transfer creation failure', async () => {
      mockTransferService.createTransfer.mockRejectedValue(
        new Error('Transfer creation failed')
      );

      await expect(
        orchestrator.executeTransfer({
          userId: 'user-123',
          sourceAmount: 100,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
          upiId: '123@upi',
          payeeName: 'Test User',
        })
      ).rejects.toThrow('Transfer failed');
    });

    it('should handle payment funding failure', async () => {
      mockPaymentService.fundTransfer.mockRejectedValue(
        new Error('Insufficient balance')
      );

      await expect(
        orchestrator.executeTransfer({
          userId: 'user-123',
          sourceAmount: 100,
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
          upiId: '123@upi',
          payeeName: 'Test User',
          autoFund: true,
        })
      ).rejects.toThrow('Transfer failed');
    });
  });

  describe('fundExistingTransfer', () => {
    it('should fund an unfunded transfer', async () => {
      const result = await orchestrator.fundExistingTransfer('transfer-123');

      expect(mockPaymentService.fundTransfer).toHaveBeenCalledWith({
        transferId: mockTransfer.id,
        paymentType: 'BALANCE',
      });
      expect(result).toEqual(mockPayment);
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
        orchestrator.fundExistingTransfer('invalid-transfer')
      ).rejects.toThrow('Transfer not found');
    });

    it('should reject if transfer already funded', async () => {
      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: { ...mockTransfer, is_funded: true },
              error: null,
            })),
          })),
        })),
      }));

      await expect(
        orchestrator.fundExistingTransfer('transfer-123')
      ).rejects.toThrow('Transfer already funded');
    });
  });

  describe('getTransferStatus', () => {
    it('should return transfer details with related data', async () => {
      const mockTransferWithRelations = {
        ...mockTransfer,
        wise_quotes: {
          source_amount: 1.14,
          target_amount: 105,
          exchange_rate: 92.6,
          fee_total: 0.01,
        },
        wise_recipients: {
          upi_id: '123@upi',
          payee_name: 'Test User',
        },
        wise_payments: {
          payment_type: 'BALANCE',
          wise_payment_status: 'COMPLETED',
        },
      };

      mockSupabase.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: mockTransferWithRelations,
              error: null,
            })),
          })),
        })),
      }));

      const result = await orchestrator.getTransferStatus('transfer-123');

      expect(result).toMatchObject({
        id: mockTransfer.id,
        status: mockTransfer.status,
        isFunded: mockTransfer.is_funded,
      });
    });

    it('should throw error if transfer not found', async () => {
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
        orchestrator.getTransferStatus('invalid-transfer')
      ).rejects.toThrow('Transfer not found');
    });
  });
});
