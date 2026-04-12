/**
 * Wise Quote Service
 * Creates and manages transfer quotes using official Wise API
 *
 * API Reference: https://docs.wise.com/api-reference/quote
 */

class WiseQuoteService {
  constructor(wiseClient, supabase) {
    this.client = wiseClient;
    this.db = supabase;
    this.profileId = wiseClient.profileId; // Get from config
  }

  /**
   * Create a new transfer quote
   *
   * Wise API: POST /v3/profiles/{profileId}/quotes
   *
   * Supports TWO modes:
   * 1. sourceAmount: "I want to send X USD, how much INR will recipient get?"
   * 2. targetAmount: "I want recipient to get X INR, how much USD do I need?"
   *
   * IMPORTANT: Provide EITHER sourceAmount OR targetAmount, never both!
   */
  async createQuote({ userId, sourceAmount, targetAmount, sourceCurrency, targetCurrency, upiScanId }) {
    console.log('\n========== WISE QUOTE SERVICE - CREATE ==========');
    console.log('[WiseQuoteService] Creating quote for user:', userId);

    // Determine quote mode
    const isSourceMode = sourceAmount !== undefined && sourceAmount !== null;
    const isTargetMode = targetAmount !== undefined && targetAmount !== null;

    if (isSourceMode && isTargetMode) {
      throw new Error('Provide either sourceAmount OR targetAmount, not both');
    }

    if (!isSourceMode && !isTargetMode) {
      throw new Error('Must provide either sourceAmount or targetAmount');
    }

    const quoteMode = isSourceMode ? 'SOURCE' : 'TARGET';

    console.log('[WiseQuoteService] Mode:', quoteMode);
    console.log('[WiseQuoteService] Amount:', quoteMode === 'SOURCE' ? `${sourceAmount} ${sourceCurrency}` : `${targetAmount} ${targetCurrency}`);
    console.log('[WiseQuoteService] Source Currency:', sourceCurrency);
    console.log('[WiseQuoteService] Target Currency:', targetCurrency);
    console.log('[WiseQuoteService] UPI Scan ID:', upiScanId || 'N/A');
    console.log('=================================================\n');

    // Build quote payload
    const quotePayload = {
      sourceCurrency,
      targetCurrency,
      payOut: 'BANK_TRANSFER', // How recipient receives money (UPI is a bank transfer type)
      preferredPayIn: 'BALANCE', // How we pay Wise (from our balance)
    };

    // Add EITHER sourceAmount OR targetAmount
    if (isSourceMode) {
      quotePayload.sourceAmount = sourceAmount;
    } else {
      quotePayload.targetAmount = targetAmount;
    }

    try {
      // Call Wise API to create quote
      // IMPORTANT: Endpoint requires profileId in path!
      console.log('[WiseQuoteService] Calling Wise API to create quote...');
      console.log('[WiseQuoteService] Payload:', JSON.stringify(quotePayload, null, 2));

      const wiseQuote = await this.client.post(
        `/v3/profiles/${this.profileId}/quotes`,
        quotePayload
      );

      console.log('[WiseQuoteService] ✅ Wise quote created successfully');
      console.log('[WiseQuoteService] Quote ID:', wiseQuote.id);
      console.log('[WiseQuoteService] Rate:', wiseQuote.rate);
      console.log('[WiseQuoteService] Wise Response Keys:', Object.keys(wiseQuote));

      // Wise API v3 returns paymentOptions array
      // CRITICAL: We MUST select the BALANCE payment option to ensure low fees
      const availableOptions = wiseQuote.paymentOptions?.filter(opt => !opt.disabled) || [];

      console.log('[WiseQuoteService] Available Payment Options:', availableOptions.length);
      availableOptions.forEach(opt => {
        console.log(`  - ${opt.payIn}: fee ${opt.fee?.total || 0} ${sourceCurrency}`);
      });

      // Find BALANCE option (REQUIRED for low-fee transfers)
      const balanceOption = availableOptions.find(opt => opt.payIn === 'BALANCE');

      // CRITICAL: Enforce BALANCE option - do NOT fall back to other payment methods
      if (!balanceOption) {
        console.error('[WiseQuoteService] ❌ CRITICAL ERROR: BALANCE payment option not available!');
        console.error('[WiseQuoteService] Available options:', availableOptions.map(o => o.payIn).join(', '));
        console.error('[WiseQuoteService] This will result in high fees. Aborting quote creation.');
        throw new Error('BALANCE payment option not available. Cannot proceed with low-fee transfer.');
      }

      const paymentOption = balanceOption;

      console.log('[WiseQuoteService] ✅ BALANCE payment option selected');
      console.log('[WiseQuoteService] Payment Method:', paymentOption.payIn);
      console.log('[WiseQuoteService] This ensures the quote will use BALANCE funding (low fees)');

      // CRITICAL: Validate that we have the required data from the selected option
      // DO NOT fall back to wiseQuote top-level data - it may have different fees!
      if (!paymentOption.sourceAmount || !paymentOption.targetAmount || !paymentOption.fee) {
        console.error('[WiseQuoteService] ⚠️  WARNING: Selected payment option missing required data!');
        console.error('[WiseQuoteService] paymentOption:', JSON.stringify(paymentOption, null, 2));
        throw new Error('Selected payment option is missing required fields (sourceAmount, targetAmount, or fee)');
      }

      // Extract amounts and fees ONLY from the selected payment option
      // NEVER fall back to wiseQuote top-level data!
      const finalSourceAmount = paymentOption.sourceAmount;
      const finalTargetAmount = paymentOption.targetAmount;
      const fee = paymentOption.fee;

      console.log('\n========== SELECTED PAYMENT OPTION DETAILS ==========');
      console.log('[WiseQuoteService] Selected Option Object:', JSON.stringify(paymentOption, null, 2));
      console.log('=====================================================');

      console.log('\n========== EXTRACTED VALUES ==========');
      console.log('[WiseQuoteService] ✅ Using BALANCE option data (NOT top-level wiseQuote data!)');
      console.log('[WiseQuoteService] finalSourceAmount (paymentOption.sourceAmount):', finalSourceAmount, sourceCurrency);
      console.log('[WiseQuoteService] finalTargetAmount (paymentOption.targetAmount):', finalTargetAmount, targetCurrency);
      console.log('[WiseQuoteService] fee.total:', fee.total, sourceCurrency);
      console.log('[WiseQuoteService] fee.transferwise:', fee.transferwise, sourceCurrency);
      console.log('[WiseQuoteService] fee.payIn:', fee.payIn, sourceCurrency);
      console.log('[WiseQuoteService] fee.partner:', fee.partner, sourceCurrency);
      console.log('[WiseQuoteService] Exchange Rate (wiseQuote.rate):', wiseQuote.rate);

      // Verify the math: sourceAmount should equal (targetAmount / rate) + fee.total
      const expectedSourceFromTarget = (finalTargetAmount / wiseQuote.rate) + fee.total;
      const matchesMath = Math.abs(finalSourceAmount - expectedSourceFromTarget) < 0.01;
      console.log('[WiseQuoteService] Math verification:', matchesMath ? '✅ PASS' : '❌ FAIL');
      console.log('[WiseQuoteService] Expected source:', expectedSourceFromTarget.toFixed(2), 'Actual:', finalSourceAmount.toFixed(2));
      console.log('======================================');

      console.log('\n========== CALCULATION ==========');
      console.log('[WiseQuoteService] IMPORTANT: Wise sourceAmount ALREADY includes all fees!');
      console.log('[WiseQuoteService] Base conversion amount:', (finalSourceAmount - (fee.total || 0)).toFixed(2), sourceCurrency, '→', finalTargetAmount, targetCurrency);
      console.log('[WiseQuoteService] Fee total:', (fee.total || 0).toFixed(2), sourceCurrency);
      console.log('[WiseQuoteService] Total to debit:', finalSourceAmount.toFixed(2), sourceCurrency, '(sourceAmount, fees included)');
      console.log('=================================\n');

      // Build quote object for database
      const quote = {
        wise_quote_id: wiseQuote.id, // This is the UUID string, not numeric ID
        user_id: userId,
        upi_scan_id: upiScanId || null,
        source_currency: sourceCurrency,
        target_currency: targetCurrency,
        source_amount: finalSourceAmount, // Amount from BALANCE payment option
        target_amount: finalTargetAmount, // Amount from BALANCE payment option
        exchange_rate: wiseQuote.rate,

        // Fee breakdown from BALANCE payment option (matches Phase 2 schema)
        fee_total: fee.total || 0,
        fee_transferwise: fee.transferwise || 0,
        fee_partner: fee.partner || 0,
        // IMPORTANT: Wise's sourceAmount ALREADY includes fees! Don't add them again!
        total_debit: finalSourceAmount,

        // Quote validity
        rate_type: wiseQuote.rateType || 'FIXED',
        payment_type: 'BALANCE', // CRITICAL: Store that this quote uses BALANCE payment
        expires_at: wiseQuote.expirationTime,
        rate_expiry_time: wiseQuote.rateExpiryTime || null,

        status: 'active',
        wise_api_response: wiseQuote, // Store full response for debugging
      };

      // Save to database
      const { data, error } = await this.db
        .from('wise_quotes')
        .insert(quote)
        .select()
        .single();

      if (error) {
        console.error('[WiseQuoteService] Database error:', error);
        throw error;
      }

      console.log('[WiseQuoteService] ✅ Quote saved to database');
      console.log('[WiseQuoteService] Database ID:', data.id);
      console.log('[WiseQuoteService] Total Debit:', data.total_debit, sourceCurrency);
      console.log('=================================================\n');

      return data;

    } catch (error) {
      console.log('\n========== WISE QUOTE SERVICE - ERROR ==========');
      console.error('[WiseQuoteService] ❌ Failed to create quote');
      console.error('[WiseQuoteService] Error:', error.message);
      console.error('[WiseQuoteService] Stack:', error.stack);
      console.log('================================================\n');
      throw new Error(`Quote creation failed: ${error.message}`);
    }
  }

  /**
   * Update quote with recipient (targetAccount)
   *
   * Wise API: PATCH /v3/profiles/{profileId}/quotes/{quoteId}
   *
   * IMPORTANT: Updates quote with recipient ID which may trigger fee recalculation.
   * Wise docs show this is the primary use of PATCH for quotes.
   */
  async updateQuoteWithRecipient(quoteId, recipientId) {
    console.log('\n========== WISE QUOTE SERVICE - UPDATE WITH RECIPIENT ==========');
    console.log('[WiseQuoteService] Updating quote with recipient');
    console.log('[WiseQuoteService] Quote ID (DB):', quoteId);
    console.log('[WiseQuoteService] Recipient ID (DB):', recipientId);

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

      // Get recipient from database
      const { data: recipient, error: recipientError } = await this.db
        .from('wise_recipients')
        .select('*')
        .eq('id', recipientId)
        .single();

      if (recipientError || !recipient) {
        throw new Error('Recipient not found');
      }

      console.log('[WiseQuoteService] Wise Quote UUID:', quote.wise_quote_id);
      console.log('[WiseQuoteService] Wise Account ID (targetAccount):', recipient.wise_account_id);

      // Call Wise API to update quote with recipient
      const endpoint = `/v3/profiles/${this.profileId}/quotes/${quote.wise_quote_id}`;
      const payload = {
        targetAccount: recipient.wise_account_id  // Documented parameter
      };

      console.log('[WiseQuoteService] Calling PATCH:', endpoint);
      console.log('[WiseQuoteService] Payload:', JSON.stringify(payload, null, 2));

      const updatedQuote = await this.client.patch(endpoint, payload);

      console.log('[WiseQuoteService] ✅ Quote updated with recipient successfully');
      console.log('[WiseQuoteService] Updated Quote ID:', updatedQuote.id);
      console.log('[WiseQuoteService] Target Account:', recipient.wise_account_id);

      // Check the fee in the updated quote response
      if (updatedQuote.paymentOptions) {
        const balanceOption = updatedQuote.paymentOptions.find(opt => opt.payIn === 'BALANCE');
        if (balanceOption) {
          console.log('[WiseQuoteService] 💰 BALANCE option fee after PATCH:', balanceOption.fee?.total || 'N/A');
          if (balanceOption.fee?.total > 0.02) {
            console.error('[WiseQuoteService] ❌ WARNING: Fee high after adding recipient!');
            console.error('[WiseQuoteService] Fee:', balanceOption.fee?.total);
          } else {
            console.log('[WiseQuoteService] ✅ BALANCE fee still low ($0.01-$0.02)');
          }
        } else {
          console.warn('[WiseQuoteService] ⚠️  BALANCE option not found in updated quote!');
        }
      }

      console.log('[WiseQuoteService] Full Updated Response:', JSON.stringify(updatedQuote, null, 2));
      console.log('================================================================\n');

      // Update database with new quote data
      await this.db
        .from('wise_quotes')
        .update({
          wise_api_response: updatedQuote,
          updated_at: new Date().toISOString(),
        })
        .eq('id', quoteId);

      return updatedQuote;

    } catch (error) {
      console.log('\n========== WISE QUOTE SERVICE - UPDATE ERROR ==========');
      console.error('[WiseQuoteService] ❌ Failed to update quote');
      console.error('[WiseQuoteService] Error:', error.message);
      if (error.response) {
        console.error('[WiseQuoteService] Response Status:', error.response.status);
        console.error('[WiseQuoteService] Response Data:', JSON.stringify(error.response.data, null, 2));
      }
      console.error('[WiseQuoteService] Stack:', error.stack);
      console.log('=======================================================\n');
      throw new Error(`Quote update failed: ${error.message}`);
    }
  }

  /**
   * Get quote by ID and validate it's still valid
   */
  async getQuote(quoteId) {
    const { data: quote, error } = await this.db
      .from('wise_quotes')
      .select('*')
      .eq('id', quoteId)
      .single();

    if (error || !quote) {
      throw new Error('Quote not found');
    }

    // Check if expired
    const now = new Date();
    const expiresAt = new Date(quote.expires_at);

    if (now > expiresAt) {
      // Mark as expired
      await this.db
        .from('wise_quotes')
        .update({ status: 'expired' })
        .eq('id', quoteId);

      throw new Error('Quote has expired. Please create a new quote.');
    }

    if (quote.status !== 'active') {
      throw new Error(`Quote is ${quote.status}`);
    }

    return quote;
  }

  /**
   * Mark quote as used after transfer
   */
  async markQuoteUsed(quoteId, transferId) {
    const { error } = await this.db
      .from('wise_quotes')
      .update({
        status: 'used',
        used_for_transfer_id: transferId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', quoteId);

    if (error) {
      console.error('[WiseQuoteService] Failed to mark quote as used:', error);
    }
  }
}

export default WiseQuoteService;
