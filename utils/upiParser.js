/**
 * UPI QR Code Parser
 * Parses UPI payment strings and extracts data
 */

/**
 * Parse UPI QR code string
 * @param {string} qrText - Raw QR code data
 * @returns {object|null} Parsed UPI data or null if invalid
 */
export function parseUPIQR(qrText) {
  try {
    // UPI format: upi://pay?pa=merchant@bank&pn=Name&am=500&cu=INR
    const url = new URL(qrText);

    if (url.protocol !== 'upi:') {
      console.warn('[parseUPIQR] Invalid protocol:', url.protocol);
      return null;
    }

    const params = new URLSearchParams(url.search);

    const parsed = {
      upiId: params.get('pa'),                              // Payee Address
      payeeName: decodeURIComponent(params.get('pn') || ''), // Payee Name
      amount: parseFloat(params.get('am') || 0),            // Amount
      currency: params.get('cu') || 'INR',                  // Currency
      note: params.get('tn') || '',                         // Transaction Note
      merchantCode: params.get('mc') || '',                 // Merchant Code
    };

    // Validate required fields
    if (!parsed.upiId) {
      console.warn('[parseUPIQR] Missing UPI ID (pa parameter)');
      return null;
    }

    // Validate UPI ID format: something@bank
    const upiRegex = /^[\w.-]+@[\w]+$/;
    if (!upiRegex.test(parsed.upiId)) {
      console.warn('[parseUPIQR] Invalid UPI ID format:', parsed.upiId);
      return null;
    }

    console.log('[parseUPIQR] Parsed successfully:', parsed);
    return parsed;

  } catch (error) {
    console.error('[parseUPIQR] Parse error:', error);
    return null;
  }
}

/**
 * Validate UPI ID format
 */
export function isValidUPI(upiId) {
  const upiRegex = /^[\w.-]+@[\w]+$/;
  return upiRegex.test(upiId);
}

export default {
  parseUPIQR,
  isValidUPI,
};
