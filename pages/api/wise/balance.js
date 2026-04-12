/**
 * API Route: Get Wise Account Balance
 * GET /api/wise/balance
 *
 * Retrieves account balances for the authenticated user
 *
 * Query params:
 * - currency: Optional currency filter (e.g., 'USD', 'EUR')
 *
 * Headers:
 * - x-user-id: User ID (required for audit logging)
 */

import { createClient } from '@supabase/supabase-js';
import WiseClient from '../../../services/wise/wiseClient.js';
import WiseBalanceService from '../../../services/wise/wiseBalanceService.js';

// Determine environment (default to sandbox for testing)
const environment = process.env.WISE_ENVIRONMENT || 'sandbox';
const isLive = environment === 'live' || environment === 'production';

const wiseConfig = {
  apiKey: isLive ? process.env.WISE_API_TOKEN_LIVE : process.env.WISE_API_TOKEN_SANDBOX,
  profileId: isLive ? process.env.WISE_PROFILE_ID_LIVE : process.env.WISE_PROFILE_ID_SANDBOX,
  baseURL: isLive
    ? 'https://api.transferwise.com'
    : (process.env.WISE_BASE_URL || 'https://api.sandbox.transferwise.tech'),
  environment: environment,
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Get user ID from header (optional for balance check)
    const userId = req.headers['x-user-id'] || null;

    // Validate Wise configuration
    if (!wiseConfig.apiKey || !wiseConfig.profileId) {
      return res.status(500).json({
        success: false,
        error: 'Wise API not configured. Please contact support.',
      });
    }

    console.log('[API /wise/balance] Fetching balance for user:', userId || 'anonymous');

    // Get currency filter from query params
    const { currency } = req.query;

    // Initialize Supabase (optional, for logging)
    let supabase = null;
    if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      );
    }

    // Initialize Wise client and service
    const wiseClient = new WiseClient(wiseConfig);
    const balanceService = new WiseBalanceService(wiseClient, supabase);

    // Fetch balance(s)
    let result;
    if (currency) {
      // Get balance for specific currency
      result = await balanceService.getBalanceByCurrency({ userId, currency });
      console.log('[API /wise/balance] ✅ Balance retrieved for', currency, ':', result.amount);
    } else {
      // Get all balances
      result = await balanceService.getBalances({ userId });
      console.log('[API /wise/balance] ✅ All balances retrieved:', result.length, 'currencies');
    }

    return res.status(200).json({
      success: true,
      data: result,
    });

  } catch (error) {
    console.error('[API /wise/balance] ❌ Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch balance',
    });
  }
}
