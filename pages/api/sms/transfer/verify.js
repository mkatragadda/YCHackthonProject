/**
 * GET /api/sms/transfer/verify?token={shortToken}
 *
 * Validates a transfer confirmation token and returns transfer details.
 * Called by the Phase 4 web confirmation page on load.
 *
 * Response (valid):
 *   { valid: true, transfer: { id, source_amount, source_currency, target_amount,
 *     target_currency, exchange_rate, fee_total, wise_recipient, expiresIn, expires_at } }
 *
 * Response (invalid):
 *   { valid: false, error: "Token expired" }
 */

const { validateToken } = require('../../../../services/sms/transferTokenService');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ valid: false, error: 'Token is required' });
  }

  try {
    const result = await validateToken(token);

    if (!result.valid) {
      return res.status(400).json({ valid: false, error: result.error });
    }

    const { transfer } = result;
    const recipient = transfer.wise_recipient;

    return res.status(200).json({
      valid: true,
      transfer: {
        id: transfer.id,
        source_amount: transfer.source_amount,
        source_currency: transfer.source_currency,
        target_amount: transfer.target_amount,
        target_currency: transfer.target_currency,
        exchange_rate: transfer.exchange_rate,
        fee_total: transfer.wise_quote?.fee_total ?? null,
        wise_recipient: {
          id: recipient.id,
          account_holder_name: recipient.account_holder_name,
          type: recipient.type,
          upi_id: recipient.upi_id || null,
          last4: recipient.upi_id
            ? recipient.upi_id.slice(-4)
            : recipient.account_number
              ? String(recipient.account_number).slice(-4)
              : null
        },
        expiresIn: transfer.expiresIn,
        expires_at: result.tokenRecord.expires_at
      }
    });

  } catch (error) {
    console.error('[TransferVerify] Unexpected error:', error.message);
    return res.status(500).json({ valid: false, error: 'Verification failed' });
  }
}
