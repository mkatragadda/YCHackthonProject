/**
 * Wise Recipient Service
 * Manages recipient accounts (reusable for repeated payments)
 *
 * API Reference: https://docs.wise.com/api-reference/recipient
 */

class WiseRecipientService {
  constructor(wiseClient, supabase) {
    this.client = wiseClient;
    this.db = supabase;
    this.profileId = wiseClient.profileId;
  }

  /**
   * Get or create recipient for UPI ID
   *
   * FLOW:
   * 1. Check local database for existing recipient
   * 2. If not found, check Wise API
   * 3. If still not found, create new recipient
   */
  async getOrCreateRecipient({ userId, upiId, payeeName }) {
    console.log('[WiseRecipientService] Getting/creating recipient for UPI:', upiId);

    // Step 1: Check local database first
    const { data: existingRecipient } = await this.db
      .from('wise_recipients')
      .select('*')
      .eq('user_id', userId)
      .eq('upi_id', upiId)
      .eq('wise_profile_id', this.profileId)
      .eq('is_active', true)
      .single();

    if (existingRecipient) {
      console.log('[WiseRecipientService] Found existing recipient in DB:', existingRecipient.wise_account_id);

      // Update usage tracking
      await this.db
        .from('wise_recipients')
        .update({
          total_transfers: existingRecipient.total_transfers + 1,
          last_used_at: new Date().toISOString(),
        })
        .eq('id', existingRecipient.id);

      return existingRecipient;
    }

    // Step 2: Check Wise API for existing recipients (in case DB is out of sync)
    console.log('[WiseRecipientService] Not in local DB, checking Wise API...');

    const wiseRecipients = await this.client.get('/v1/accounts', {
      profile: this.profileId,
      currency: 'INR',
    });

    // Look for matching UPI ID in Wise recipients
    // UPI recipients have type 'indian_upi' with 'accountNumber' field in details
    const matchingWiseRecipient = wiseRecipients.find(
      r => r.type === 'indian_upi' && r.details?.accountNumber === upiId
    );

    if (matchingWiseRecipient) {
      console.log('[WiseRecipientService] Found in Wise API, saving to DB:', matchingWiseRecipient.id);

      // Save to local DB for future lookups
      const savedRecipient = await this._saveRecipientToDB({
        userId,
        wiseRecipient: matchingWiseRecipient,
      });

      return savedRecipient;
    }

    // Step 3: Create new recipient
    console.log('[WiseRecipientService] Not found anywhere, creating new recipient');
    return await this.createRecipient({ userId, upiId, payeeName });
  }

  /**
   * Create new recipient account in Wise
   *
   * Wise API: POST /v1/accounts
   */
  async createRecipient({ userId, upiId, payeeName }) {
    console.log('[WiseRecipientService] Creating new recipient:', { upiId, payeeName });

    try {
      // Prepare recipient payload for UPI
      // Based on Wise API: use type "indian_upi" for UPI recipients
      // UPI ID goes in details.accountNumber (not vpa)
      const recipientPayload = {
        currency: 'INR',
        type: 'indian_upi', // Type for UPI recipients
        profile: parseInt(this.profileId), // Ensure profile is a number, not string
        accountHolderName: payeeName || 'Recipient',
        ownedByCustomer: false, // Required field for recipient accounts
        details: {
          address: {
            city: "Gannavaram",
            countryCode: "IN",
            postCode: "521101",
            firstLine: "123 Marine Drive"
          },
          legalType: 'PRIVATE', // or 'BUSINESS'
          accountNumber: upiId, // UPI Virtual Payment Address (e.g., 7780664712@ybl)
        },
      };

      console.log('[WiseRecipientService] Recipient payload:', JSON.stringify(recipientPayload, null, 2));

      // Call Wise API
      const wiseRecipient = await this.client.post('/v1/accounts', recipientPayload);

      console.log('[WiseRecipientService] Recipient created in Wise:', wiseRecipient.id);

      // Save to local database
      const savedRecipient = await this._saveRecipientToDB({
        userId,
        wiseRecipient,
      });

      return savedRecipient;

    } catch (error) {
      console.error('[WiseRecipientService] Failed to create recipient:', error);
      throw new Error(`Recipient creation failed: ${error.message}`);
    }
  }

  /**
   * Private: Save Wise recipient to local database
   */
  async _saveRecipientToDB({ userId, wiseRecipient }) {
    const recipientData = {
      user_id: userId,
      wise_account_id: wiseRecipient.id,
      wise_profile_id: this.profileId,
      account_holder_name: wiseRecipient.accountHolderName,
      currency: wiseRecipient.currency,
      type: wiseRecipient.type,
      legal_type: wiseRecipient.details?.legalType,
      upi_id: wiseRecipient.details?.accountNumber || wiseRecipient.details?.vpa, // Support both fields
      business_type: wiseRecipient.details?.businessType,
      business_name: wiseRecipient.details?.businessName,
      is_active: true,
      is_verified: false,
      total_transfers: 0,
      wise_api_response: wiseRecipient,
    };

    const { data, error } = await this.db
      .from('wise_recipients')
      .insert(recipientData)
      .select()
      .single();

    if (error) {
      console.error('[WiseRecipientService] Database error:', error);
      throw error;
    }

    console.log('[WiseRecipientService] Recipient saved to DB:', data.id);
    return data;
  }
}

export default WiseRecipientService;
