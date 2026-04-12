/**
 * Wise Orchestrator Service
 * Coordinates the complete 4-step Wise transfer flow
 *
 * Flow: Quote → Recipient → Transfer → Fund Transfer
 */

class WiseOrchestrator {
  constructor({ quoteService, recipientService, transferService, paymentService, supabase }) {
    this.quoteService = quoteService;
    this.recipientService = recipientService;
    this.transferService = transferService;
    this.paymentService = paymentService;
    this.db = supabase;
  }

  /**
   * Execute complete transfer flow (all 5 steps)
   * ⚠️ WARNING: This IMMEDIATELY funds the transfer with REAL MONEY!
   *
   * Step 1: Create Quote
   * Step 2: Get/Create Recipient
   * Step 2.5: Update Quote with Recipient (locks in BALANCE fee)
   * Step 3: Create Transfer
   * Step 4: Fund Transfer (REAL MONEY MOVED)
   *
   * @param {boolean} autoFund - If false, stops before funding (default: controlled by env)
   */
  async executeTransfer({
    userId,
    upiScanId,
    quoteId, // NEW: Optional existing quote ID to reuse
    sourceAmount,
    targetAmount,
    sourceCurrency,
    targetCurrency,
    upiId,
    payeeName,
    reference,
    autoFund = process.env.WISE_AUTO_FUND !== 'false', // Default to env variable
  }) {
    console.log('\n========== WISE ORCHESTRATOR - EXECUTE TRANSFER ==========');
    console.log('[WiseOrchestrator] ⚠️  AUTO-FUND:', autoFund ? 'YES (REAL MONEY)' : 'NO (SAFE MODE)');
    console.log('[WiseOrchestrator] User ID:', userId);
    console.log('[WiseOrchestrator] Quote ID:', quoteId || 'Will create new');
    console.log('[WiseOrchestrator] Amount:', sourceAmount || targetAmount, sourceCurrency, '→', targetCurrency);
    console.log('[WiseOrchestrator] Recipient:', upiId, '-', payeeName);
    console.log('==========================================================\n');

    try {
      // Step 1: Get or Create Quote
      let quote;

      if (quoteId) {
        // Reuse existing quote from UI
        console.log('[WiseOrchestrator] Step 1/4: Fetching existing quote...');
        quote = await this.quoteService.getQuote(quoteId);
        console.log('[WiseOrchestrator] ✅ Using existing quote:', quote.id);
      } else {
        // Create new quote
        console.log('[WiseOrchestrator] Step 1/4: Creating new quote...');
        quote = await this.quoteService.createQuote({
          userId,
          sourceAmount,
          targetAmount,
          sourceCurrency,
          targetCurrency,
          upiScanId,
        });
        console.log('[WiseOrchestrator] ✅ Quote created:', quote.id);
      }

      // Step 2: Get/Create Recipient
      console.log('[WiseOrchestrator] Step 2/4: Getting/creating recipient...');
      const recipient = await this.recipientService.getOrCreateRecipient({
        userId,
        upiId,
        payeeName,
      });

      console.log('[WiseOrchestrator] ✅ Recipient ready:', recipient.id);

      // Step 2.5: Update quote with recipient (CRITICAL for fee lock-in)
      console.log('[WiseOrchestrator] Step 2.5/4: Updating quote with recipient...');
      await this.quoteService.updateQuoteWithRecipient(quote.id, recipient.id);
      console.log('[WiseOrchestrator] ✅ Quote updated with recipient (fee locked in)');

      // Step 3: Create Transfer
      console.log('[WiseOrchestrator] Step 3/4: Creating transfer...');
      const transfer = await this.transferService.createTransfer({
        userId,
        quoteId: quote.id,
        recipientId: recipient.id,
        upiScanId,
        reference,
      });

      console.log('[WiseOrchestrator] ✅ Transfer created:', transfer.id);

      // Step 4: Fund Transfer (OPTIONAL - controlled by autoFund parameter)
      let payment = null;

      if (autoFund) {
        console.log('[WiseOrchestrator] Step 4/5: 💰 FUNDING TRANSFER (REAL MONEY)...');
        console.log('[WiseOrchestrator] ⚠️  WARNING: About to move REAL MONEY via Wise API!');

        payment = await this.paymentService.fundTransfer({
          transferId: transfer.id,
          paymentType: 'BALANCE',
        });

        console.log('[WiseOrchestrator] ✅ Transfer funded successfully!');
        console.log('[WiseOrchestrator] Payment ID:', payment.id);
      } else {
        console.log('[WiseOrchestrator] Step 4/5: ⏸️  SKIPPED (Safe Mode - No Funding)');
        console.log('[WiseOrchestrator] Transfer created but NOT funded');
        console.log('[WiseOrchestrator] Use fundExistingTransfer() to fund later');
      }

      // Update UPI scan status if provided
      if (upiScanId) {
        await this._updateUpiScanStatus(upiScanId, transfer.id);
      }

      // Mark quote as used
      await this.quoteService.markQuoteUsed(quote.id, transfer.id);

      console.log('\n========== TRANSFER EXECUTION COMPLETE ==========');
      console.log('[WiseOrchestrator] Transfer ID:', transfer.id);
      console.log('[WiseOrchestrator] Funded:', autoFund ? 'YES' : 'NO');
      console.log('[WiseOrchestrator] Status:', transfer.status);
      console.log('=================================================\n');

      // Return complete transfer details
      return {
        transfer,
        payment,
        quote,
        recipient,
        isFunded: autoFund,
      };

    } catch (error) {
      console.log('\n========== TRANSFER EXECUTION FAILED ==========');
      console.error('[WiseOrchestrator] ❌ Error:', error.message);
      console.error('[WiseOrchestrator] Stack:', error.stack);
      console.log('===============================================\n');
      throw new Error(`Transfer failed: ${error.message}`);
    }
  }

  /**
   * Fund an existing transfer that was created without funding
   * ⚠️ WARNING: This moves REAL MONEY!
   *
   * @param {string} transferId - The transfer ID to fund
   */
  async fundExistingTransfer(transferId) {
    console.log('\n========== WISE ORCHESTRATOR - FUND TRANSFER ==========');
    console.log('[WiseOrchestrator] ⚠️  WARNING: About to FUND transfer with REAL MONEY!');
    console.log('[WiseOrchestrator] Transfer ID:', transferId);
    console.log('=======================================================\n');

    try {
      // Get transfer details
      const { data: transfer, error } = await this.db
        .from('wise_transfers')
        .select('*')
        .eq('id', transferId)
        .single();

      if (error || !transfer) {
        throw new Error('Transfer not found');
      }

      if (transfer.is_funded) {
        throw new Error('Transfer already funded');
      }

      // Fund the transfer
      console.log('[WiseOrchestrator] 💰 Funding transfer...');
      const payment = await this.paymentService.fundTransfer({
        transferId: transfer.id,
        paymentType: 'BALANCE',
      });

      console.log('[WiseOrchestrator] ✅ Transfer funded successfully!');
      console.log('[WiseOrchestrator] Payment ID:', payment.id);
      console.log('=======================================================\n');

      return payment;

    } catch (error) {
      console.log('\n========== FUNDING FAILED ==========');
      console.error('[WiseOrchestrator] ❌ Error:', error.message);
      console.log('====================================\n');
      throw new Error(`Funding failed: ${error.message}`);
    }
  }

  /**
   * Get transfer status and details
   */
  async getTransferStatus(transferId) {
    console.log('[WiseOrchestrator] Getting transfer status:', transferId);

    try {
      const { data: transfer, error } = await this.db
        .from('wise_transfers')
        .select(`
          *,
          wise_quotes (
            source_amount,
            target_amount,
            exchange_rate,
            fee_total,
            fee_transferwise,
            fee_partner
          ),
          wise_recipients (
            upi_id,
            payee_name
          ),
          wise_payments (
            payment_type,
            wise_payment_status,
            payment_completed_at
          )
        `)
        .eq('id', transferId)
        .single();

      if (error || !transfer) {
        throw new Error('Transfer not found');
      }

      return {
        id: transfer.id,
        status: transfer.status,
        wiseStatus: transfer.wise_status,
        sourceAmount: transfer.source_amount,
        sourceCurrency: transfer.source_currency,
        targetAmount: transfer.target_amount,
        targetCurrency: transfer.target_currency,
        exchangeRate: transfer.exchange_rate,
        feeTotal: transfer.wise_quotes?.fee_total || 0,
        feeTransferwise: transfer.wise_quotes?.fee_transferwise || 0,
        feePartner: transfer.wise_quotes?.fee_partner || 0,
        totalDebit: transfer.source_amount + (transfer.wise_quotes?.fee_total || 0),
        reference: transfer.reference,
        isFunded: transfer.is_funded,
        fundedAt: transfer.funded_at,
        createdAt: transfer.created_at,
        recipient: {
          upiId: transfer.wise_recipients?.upi_id,
          payeeName: transfer.wise_recipients?.payee_name,
        },
        payment: transfer.wise_payments ? {
          type: transfer.wise_payments.payment_type,
          status: transfer.wise_payments.wise_payment_status,
          completedAt: transfer.wise_payments.payment_completed_at,
        } : null,
      };

    } catch (error) {
      console.error('[WiseOrchestrator] Failed to get transfer status:', error);
      throw new Error(`Failed to get transfer status: ${error.message}`);
    }
  }

  /**
   * Private: Update UPI scan status
   */
  async _updateUpiScanStatus(upiScanId, transferId) {
    try {
      await this.db
        .from('upi_scans')
        .update({
          transfer_status: 'processing',
          wise_transfer_id: transferId,
        })
        .eq('id', upiScanId);

      console.log('[WiseOrchestrator] Updated UPI scan status:', upiScanId);
    } catch (error) {
      console.error('[WiseOrchestrator] Failed to update UPI scan status:', error);
      // Non-critical error, don't throw
    }
  }
}

export default WiseOrchestrator;
