/**
 * Wise Balance Service
 * Retrieves account balances using official Wise API
 *
 * API Reference: https://docs.wise.com/api-reference/balance
 */

class WiseBalanceService {
  constructor(wiseClient, supabase) {
    this.client = wiseClient;
    this.db = supabase;
    this.profileId = wiseClient.profileId;
  }

  /**
   * Get all balances for the profile
   *
   * Wise API: GET /v4/profiles/{profileId}/balances?types=STANDARD
   *
   * Returns all available balances (USD, EUR, GBP, etc.)
   */
  async getBalances({ userId }) {
    console.log('\n========== WISE BALANCE SERVICE - GET ALL ==========');
    console.log('[WiseBalanceService] Fetching balances for user:', userId);
    console.log('[WiseBalanceService] Profile ID:', this.profileId);
    console.log('===================================================\n');

    try {
      // Call Wise API to get balances
      const balances = await this.client.get(`/v4/profiles/${this.profileId}/balances?types=STANDARD`);

      console.log('[WiseBalanceService] ✅ Balances retrieved:', balances.length, 'currencies');

      // Log balances to database for tracking
      if (this.db && userId) {
        await this._logBalanceCheck(userId, balances);
      }

      return balances;

    } catch (error) {
      console.error('[WiseBalanceService] ❌ Error fetching balances:', error.message);
      throw new Error(`Failed to fetch balances: ${error.message}`);
    }
  }

  /**
   * Get balance for a specific currency
   *
   * @param {string} currency - Currency code (e.g., 'USD', 'EUR')
   * @returns {object} Balance object with amount and currency
   */
  async getBalanceByCurrency({ userId, currency = 'USD' }) {
    console.log('\n========== WISE BALANCE SERVICE - GET BY CURRENCY ==========');
    console.log('[WiseBalanceService] Fetching balance for currency:', currency);
    console.log('[WiseBalanceService] User ID:', userId);
    console.log('===========================================================\n');

    const balances = await this.getBalances({ userId });

    // Find the balance for the requested currency
    const balance = balances.find(b => b.currency === currency);

    if (!balance) {
      console.log(`[WiseBalanceService] ⚠️ No ${currency} balance found`);
      return {
        currency,
        amount: 0,
        available: 0,
        reserved: 0,
      };
    }

    console.log('[WiseBalanceService] ✅ Balance found:', {
      currency: balance.currency,
      amount: balance.amount.value,
      available: balance.amount.value,
    });

    return {
      currency: balance.currency,
      amount: balance.amount.value,
      available: balance.amount.value,
      reserved: balance.amount.reserved || 0,
    };
  }

  /**
   * Log balance check to database for audit trail
   */
  async _logBalanceCheck(userId, balances) {
    try {
      const { error } = await this.db
        .from('wise_balance_checks')
        .insert({
          user_id: userId,
          profile_id: this.profileId,
          balances: balances,
          checked_at: new Date().toISOString(),
        });

      if (error) {
        console.warn('[WiseBalanceService] Failed to log balance check:', error.message);
      }
    } catch (err) {
      // Non-critical, just log the error
      console.warn('[WiseBalanceService] Balance check logging error:', err.message);
    }
  }
}

export default WiseBalanceService;
