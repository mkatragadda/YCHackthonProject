/**
 * Wise Transfer Service
 * Creates transfers (combines quote + recipient)
 *
 * API Reference: https://docs.wise.com/api-reference/transfer
 */

import { randomUUID } from 'crypto';
import { detectPaymentType } from '../../utils/upiTypeDetector.js';

class WiseTransferService {
  constructor(wiseClient, supabase) {
    this.client = wiseClient;
    this.db = supabase;
    this.profileId = wiseClient.profileId;
  }

  /**
   * Create transfer in Wise (NOT YET FUNDED)
   *
   * Wise API: POST /v1/transfers
   *
   * IMPORTANT: This creates the transfer but does NOT fund it.
   * You must call fundTransfer() separately (Step 4).
   */
  async createTransfer({ userId, quoteId, recipientId, upiScanId, reference }) {
    console.log('[WiseTransferService] Creating transfer:', {
      quoteId,
      recipientId,
    });

    try {
      // Get quote from database
      const { data: quote, error: quoteError } = await this.db
        .from('wise_quotes')
        .select('*')
        .eq('id', quoteId)
        .single();

      if (quoteError || !quote) {
        throw new Error('Quote not found');
      }

      // CRITICAL: Validate that the quote uses BALANCE payment type
      if (quote.payment_type !== 'BALANCE') {
        console.error('[WiseTransferService] ❌ Quote does not use BALANCE payment!');
        console.error('[WiseTransferService] Quote payment type:', quote.payment_type);
        throw new Error(`Quote must use BALANCE payment type. Current: ${quote.payment_type}`);
      }

      console.log('[WiseTransferService] ✅ Quote validated: Uses BALANCE payment type');

      // Get recipient from database
      const { data: recipient, error: recipientError } = await this.db
        .from('wise_recipients')
        .select('*')
        .eq('id', recipientId)
        .single();

      if (recipientError || !recipient) {
        throw new Error('Recipient not found');
      }

      // Generate idempotency key (prevents duplicate transfers on retry)
      const customerTransactionId = randomUUID();

      // Detect payment type (P2P vs P2M) for optimal transfer purpose
      let transferPurpose = 'Sending money to family or friends'; // Default to P2P

      if (upiScanId) {
        // Fetch UPI scan data to get merchant code
        const { data: upiScan } = await this.db
          .from('upi_scans')
          .select('merchant_code, amount, raw_qr_data')
          .eq('id', upiScanId)
          .single();

        if (upiScan) {
          // Detect if this is a merchant or personal payment
          const detection = detectPaymentType({
            merchantCode: upiScan.merchant_code,
            amount: upiScan.amount,
          });

          transferPurpose = detection.transferPurpose;

          console.log('[WiseTransferService] Payment type detected:', detection.paymentType);
          console.log('[WiseTransferService] Transfer purpose:', transferPurpose);
          if (detection.merchantCategory) {
            console.log('[WiseTransferService] Merchant category:', detection.merchantCategory);
          }
        }
      }

      // Prepare transfer payload
      // CRITICAL: We use the quoteUuid which was created with BALANCE payment option.
      // This ensures Wise uses the BALANCE payment method (low fees) from the quote.
      // DO NOT add fields that override the payment method!
      const transferPayload = {
        targetAccount: recipient.wise_account_id, // Wise recipient ID
        quoteUuid: quote.wise_quote_id, // Links to quote with BALANCE payment locked in
        customerTransactionId, // Our idempotency key
        details: {
          // NOTE: sourceOfFunds is for compliance reporting only, NOT for selecting payment method.
          // The payment method is determined by the quote (which has BALANCE baked in).
          // We set this to 'balance' to indicate funds come from Wise balance.
          sourceOfFunds: 'balance',
          reference: '', // Empty reference for UPI (reference field has very strict limits)
          transferPurpose, // Dynamically determined based on P2P vs P2M detection
        },
      };

      console.log('\n========== WISE TRANSFER SERVICE - CREATE ==========');
      console.log('[WiseTransferService] Creating transfer in Wise API...');
      console.log('[WiseTransferService] Endpoint: POST /v1/transfers');
      console.log('[WiseTransferService] Transfer Payload:', JSON.stringify(transferPayload, null, 2));
      console.log('====================================================\n');

      // Call Wise API to create transfer
      const wiseTransfer = await this.client.post('/v1/transfers', transferPayload);

      console.log('\n========== WISE TRANSFER API RESPONSE ==========');
      console.log('[WiseTransferService] Transfer created in Wise:', wiseTransfer.id);
      console.log('[WiseTransferService] Wise Status:', wiseTransfer.status);
      console.log('[WiseTransferService] ⚠️  CRITICAL: Check fees in response:');
      console.log('[WiseTransferService] Source Amount:', wiseTransfer.sourceAmount || wiseTransfer.sourceCurrency);
      console.log('[WiseTransferService] Target Amount:', wiseTransfer.targetAmount || wiseTransfer.targetCurrency);

      // Check if transfer response contains fee information
      if (wiseTransfer.fee) {
        console.log('[WiseTransferService] 💰 Fee in Transfer Response:', wiseTransfer.fee);
        if (wiseTransfer.fee > 0.02) {
          console.error('[WiseTransferService] ❌ WARNING: High fee detected in transfer response!');
          console.error('[WiseTransferService] Expected: $0.01, Got:', wiseTransfer.fee);
          console.error('[WiseTransferService] This means Wise rejected the BALANCE payment option!');
        } else {
          console.log('[WiseTransferService] ✅ Fee looks correct ($0.01-$0.02)');
        }
      }

      console.log('[WiseTransferService] Full Response:', JSON.stringify(wiseTransfer, null, 2));
      console.log('=================================================\n');

      // Save to database
      const transferData = {
        user_id: userId,
        upi_scan_id: upiScanId || null,
        wise_transfer_id: wiseTransfer.id,
        wise_quote_id: quoteId,
        wise_recipient_id: recipientId,
        source_amount: quote.source_amount,
        source_currency: quote.source_currency,
        target_amount: quote.target_amount,
        target_currency: quote.target_currency,
        exchange_rate: quote.exchange_rate,
        reference: transferPayload.details.reference,
        customer_transaction_id: customerTransactionId,
        wise_status: wiseTransfer.status,
        status: this._mapWiseStatus(wiseTransfer.status),
        is_funded: false, // Not yet funded!
        wise_api_response: wiseTransfer,
      };

      const { data: savedTransfer, error: dbError } = await this.db
        .from('wise_transfers')
        .insert(transferData)
        .select()
        .single();

      if (dbError) {
        console.error('[WiseTransferService] Database error:', dbError);
        throw dbError;
      }

      console.log('[WiseTransferService] Transfer saved to DB:', savedTransfer.id);

      // Log event
      await this._logTransferEvent({
        userId,
        transferId: savedTransfer.id,
        eventType: 'status_change',
        newStatus: wiseTransfer.status,
        source: 'api',
      });

      return savedTransfer;

    } catch (error) {
      console.error('[WiseTransferService] Failed to create transfer:', error);
      if (error.details) {
        console.error('[WiseTransferService] Error details:', JSON.stringify(error.details, null, 2));
      }
      throw new Error(`Transfer creation failed: ${error.message}`);
    }
  }

  /**
   * Private: Map Wise status to our simplified status
   */
  _mapWiseStatus(wiseStatus) {
    const statusMap = {
      'incoming_payment_waiting': 'pending',
      'processing': 'processing',
      'funds_converted': 'processing',
      'outgoing_payment_sent': 'processing',
      'bounced_back': 'failed',
      'funds_refunded': 'failed',
      'cancelled': 'cancelled',
    };

    return statusMap[wiseStatus] || 'pending';
  }

  /**
   * Private: Log transfer event to audit trail
   */
  async _logTransferEvent({ userId, transferId, eventType, oldStatus, newStatus, source }) {
    await this.db
      .from('wise_transfer_events')
      .insert({
        user_id: userId, // Required by Phase 2 schema
        wise_transfer_id: transferId,
        event_type: eventType,
        old_status: oldStatus || null,
        new_status: newStatus,
        source: source,
      });
  }
}

export default WiseTransferService;
