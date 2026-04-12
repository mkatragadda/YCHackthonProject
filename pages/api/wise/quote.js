/**
 * API Route: Create Wise Quote
 * POST /api/wise/quote
 *
 * Creates a quote for international transfer
 */

import { createClient } from '@supabase/supabase-js';
import WiseClient from '../../../services/wise/wiseClient.js';
import WiseQuoteService from '../../../services/wise/wiseQuoteService.js';

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
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Get user ID from header
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User ID required' });
    }

    // Validate Wise configuration
    if (!wiseConfig.apiKey || !wiseConfig.profileId) {
      return res.status(500).json({
        success: false,
        error: 'Wise API not configured. Please contact support.',
      });
    }

    // Extract and validate request body
    const { sourceAmount, targetAmount, sourceCurrency, targetCurrency, upiScanId } = req.body;

    console.log('[API /wise/quote] Request body:', JSON.stringify(req.body, null, 2));
    console.log('[API /wise/quote] sourceAmount:', sourceAmount, 'targetAmount:', targetAmount);

    // Validate required fields
    if (!sourceCurrency || !targetCurrency) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sourceCurrency, targetCurrency',
      });
    }

    // Validate that EITHER sourceAmount OR targetAmount is provided (never both)
    if (!sourceAmount && !targetAmount) {
      return res.status(400).json({
        success: false,
        error: 'Must provide either sourceAmount or targetAmount',
      });
    }

    if (sourceAmount && targetAmount) {
      return res.status(400).json({
        success: false,
        error: 'Cannot provide both sourceAmount and targetAmount',
      });
    }

    // Validate types
    if (sourceAmount !== undefined && typeof sourceAmount !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'sourceAmount must be a number',
      });
    }

    if (targetAmount !== undefined && typeof targetAmount !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'targetAmount must be a number',
      });
    }

    if (typeof sourceCurrency !== 'string' || typeof targetCurrency !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'sourceCurrency and targetCurrency must be strings',
      });
    }

    // Validate amount range
    // Minimum: ~$1 USD or ₹100 INR based on Wise requirements
    if (sourceAmount !== undefined && sourceAmount !== null) {
      if (sourceAmount < 1) {
        return res.status(400).json({
          success: false,
          error: 'Minimum transfer amount is $1 USD',
        });
      }
      if (sourceAmount > 10000) {
        return res.status(400).json({
          success: false,
          error: 'Maximum transfer amount is $10,000',
        });
      }
    }

    if (targetAmount !== undefined && targetAmount !== null) {
      if (targetCurrency === 'INR' && targetAmount < 100) {
        return res.status(400).json({
          success: false,
          error: 'Minimum transfer amount is ₹100 INR',
        });
      }
      if (targetAmount > 1000000) {
        return res.status(400).json({
          success: false,
          error: 'Maximum transfer amount exceeded',
        });
      }
    }

    // Initialize services
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );

    const wiseClient = new WiseClient(wiseConfig);
    const quoteService = new WiseQuoteService(wiseClient, supabase);

    // Create quote (pass both, service will use whichever is provided)
    const quote = await quoteService.createQuote({
      userId,
      sourceAmount,
      targetAmount,
      sourceCurrency,
      targetCurrency,
      upiScanId: upiScanId || null,
    });

    // Return quote details
    return res.status(200).json({
      success: true,
      data: {
        quoteId: quote.id,
        sourceAmount: quote.source_amount,
        sourceCurrency: quote.source_currency,
        targetAmount: quote.target_amount,
        targetCurrency: quote.target_currency,
        exchangeRate: quote.exchange_rate,
        feeTotal: quote.fee_total,
        feeTransferwise: quote.fee_transferwise,
        feePartner: quote.fee_partner,
        totalDebit: quote.total_debit,
        rateType: quote.rate_type,
        expiresAt: quote.expires_at,
        rateExpiryTime: quote.rate_expiry_time,
      },
    });

  } catch (error) {
    console.error('[API /wise/quote] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to create quote',
    });
  }
}
