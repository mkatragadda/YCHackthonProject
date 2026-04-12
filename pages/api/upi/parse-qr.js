/**
 * POST /api/upi/parse-qr
 * Parse UPI QR code and save scan to database
 *
 * Body:
 * - qrData: string (required, raw QR code data)
 */

import { createClient } from '@supabase/supabase-js';
import { parseUPIQR } from '../../../utils/upiParser';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User ID required' });
    }

    const { qrData } = req.body;

    if (!qrData || typeof qrData !== 'string') {
      return res.status(400).json({ success: false, error: 'qrData is required' });
    }

    // Parse UPI QR code
    const parsed = parseUPIQR(qrData);

    if (!parsed) {
      return res.status(400).json({
        success: false,
        error: 'Invalid UPI QR code format',
      });
    }

    // Save scan to database
    const { data: scan, error: scanError } = await supabase
      .from('upi_scans')
      .insert({
        user_id: userId,
        upi_id: parsed.upiId,
        payee_name: parsed.payeeName || 'Unknown Merchant',
        amount: parsed.amount,
        currency: parsed.currency,
        merchant_code: parsed.merchantCode || null,
        transaction_note: parsed.note || null,
        raw_qr_data: qrData,
        status: 'scanned',
      })
      .select()
      .single();

    if (scanError) {
      console.error('[API/upi/parse-qr] Database error:', scanError);
      return res.status(500).json({
        success: false,
        error: 'Failed to save scan',
      });
    }

    // Return parsed QR data
    // Note: NO USD calculation here - let Wise API provide live rates via quote
    res.status(200).json({
      success: true,
      data: {
        scanId: scan.id,
        upiId: parsed.upiId,
        payeeName: parsed.payeeName,
        amount: parsed.amount, // INR amount from QR code
        currency: parsed.currency, // 'INR'
        note: parsed.note,
        merchantCode: parsed.merchantCode,
      },
    });

  } catch (error) {
    console.error('[API/upi/parse-qr] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to parse QR code',
    });
  }
}
