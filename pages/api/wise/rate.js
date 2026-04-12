/**
 * GET /api/wise/rate
 * Get live exchange rate from Wise API
 *
 * Uses unauthenticated quote endpoint (no auth required, just for display)
 *
 * Query params:
 * - source: Source currency (default: 'USD')
 * - target: Target currency (default: 'INR')
 */

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { source = 'USD', target = 'INR' } = req.query;

    console.log('[API /wise/rate] Fetching live rate:', `${source} → ${target}`);

    const baseURL = process.env.WISE_ENVIRONMENT === 'sandbox'
      ? 'https://api.sandbox.transferwise.tech'
      : 'https://api.transferwise.com';

    // Use unauthenticated quote endpoint
    // This endpoint doesn't require auth and is perfect for displaying rates
    const url = `${baseURL}/v3/quotes`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // No Authorization header needed for unauthenticated quotes
      },
      body: JSON.stringify({
        sourceCurrency: source,
        targetCurrency: target,
        sourceAmount: 1, // Get rate for 1 unit
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[API /wise/rate] Wise API error:', response.status, errorText);
      throw new Error(`Wise API error: ${response.status}`);
    }

    const quoteData = await response.json();

    console.log('[API /wise/rate] ✅ Rate fetched:', quoteData.rate);

    return res.status(200).json({
      success: true,
      data: {
        rate: quoteData.rate,
        source: quoteData.sourceCurrency,
        target: quoteData.targetCurrency,
        timestamp: new Date().toISOString(),
      },
    });

  } catch (error) {
    console.error('[API /wise/rate] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch exchange rate',
    });
  }
}
