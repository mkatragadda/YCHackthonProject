/**
 * Wise Payment Service
 * Funds transfers (Step 4 of Wise flow)
 *
 * API Reference: https://docs.wise.com/api-reference/transfer
 */

class WisePaymentService {
  constructor(wiseClient, supabase) {
    this.client = wiseClient;
    this.db = supabase;
    this.profileId = wiseClient.profileId;
  }

  /**
   * Fund a transfer (execute payment)
   *
   * Wise API: POST /v3/profiles/{profileId}/transfers/{transferId}/payments
   *
   * IMPORTANT: This is the step that actually sends the money!
   * Transfer must be created first (Step 3).
   */
  async fundTransfer({ transferId, paymentType = 'BALANCE' }) {
    console.log('[WisePaymentService] Funding transfer:', { transferId, paymentType });

    try {
      // Get transfer from database
      const { data: transfer, error: transferError } = await this.db
        .from('wise_transfers')
        .select('*')
        .eq('id', transferId)
        .single();

      if (transferError || !transfer) {
        throw new Error('Transfer not found');
      }

      if (transfer.is_funded) {
        throw new Error('Transfer already funded');
      }

      // CRITICAL: Validate that we're funding with BALANCE type
      if (paymentType !== 'BALANCE') {
        console.error('[WisePaymentService] ❌ Payment type must be BALANCE!');
        console.error('[WisePaymentService] Requested payment type:', paymentType);
        throw new Error(`Payment type must be BALANCE. Got: ${paymentType}`);
      }

      console.log('[WisePaymentService] ✅ Payment type validated: BALANCE');

      // Prepare payment payload
      // CRITICAL: This must match the payment method from the quote (BALANCE)
      const paymentPayload = {
        type: paymentType, // Must be 'BALANCE' to match the quote
      };

      // Call Wise API to fund transfer
      const endpoint = `/v3/profiles/${this.profileId}/transfers/${transfer.wise_transfer_id}/payments`;

      console.log('\n========== WISE PAYMENT SERVICE - FUNDING ==========');
      console.log('[WisePaymentService] Transfer ID:', transfer.wise_transfer_id);
      console.log('[WisePaymentService] Payment Payload:', JSON.stringify(paymentPayload, null, 2));
      console.log('[WisePaymentService] Endpoint:', endpoint);
      console.log('[WisePaymentService] Transfer source amount:', transfer.source_amount);
      console.log('[WisePaymentService] Transfer target amount:', transfer.target_amount);
      console.log('====================================================\n');

      const wisePayment = await this.client.post(endpoint, paymentPayload);

      console.log('\n========== WISE PAYMENT API RESPONSE ==========');
      console.log('[WisePaymentService] Payment Status:', wisePayment.status);
      console.log('[WisePaymentService] Full Response:', JSON.stringify(wisePayment, null, 2));
      console.log('===============================================\n');

      // Save payment record
      const paymentData = {
        user_id: transfer.user_id,
        wise_transfer_id: transferId,
        payment_type: paymentType,
        wise_payment_status: wisePayment.status,
        balance_transaction_id: wisePayment.balanceTransactionId,
        amount: transfer.source_amount,
        currency: transfer.source_currency,
        payment_completed_at: wisePayment.status === 'COMPLETED' ? new Date().toISOString() : null,
        wise_api_response: wisePayment,
      };

      const { data: savedPayment, error: paymentDbError } = await this.db
        .from('wise_payments')
        .insert(paymentData)
        .select()
        .single();

      if (paymentDbError) {
        console.error('[WisePaymentService] Database error:', paymentDbError);
        throw paymentDbError;
      }

      // Update transfer as funded
      await this.db
        .from('wise_transfers')
        .update({
          is_funded: true,
          funded_at: new Date().toISOString(),
          wise_payment_id: savedPayment.id,
          status: 'processing',
          wise_status: 'processing',
        })
        .eq('id', transferId);

      // Log event
      await this._logPaymentEvent({
        userId: transfer.user_id,
        transferId,
        eventType: 'payment_completed',
        paymentStatus: wisePayment.status,
      });

      console.log('[WisePaymentService] Payment saved to DB:', savedPayment.id);

      return savedPayment;

    } catch (error) {
      console.error('[WisePaymentService] Failed to fund transfer:', error);
      throw new Error(`Payment funding failed: ${error.message}`);
    }
  }

  /**
   * Private: Log payment event
   */
  async _logPaymentEvent({ userId, transferId, eventType, paymentStatus }) {
    await this.db
      .from('wise_transfer_events')
      .insert({
        user_id: userId, // Required by Phase 2 schema
        wise_transfer_id: transferId,
        event_type: eventType,
        new_status: paymentStatus,
        source: 'payment_api',
      });
  }
}

export default WisePaymentService;
