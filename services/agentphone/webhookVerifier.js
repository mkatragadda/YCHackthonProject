/**
 * AgentPhone Webhook Signature Verifier
 *
 * AgentPhone sends:
 *   Header: x-webhook-signature: sha256=<hex>
 *   Header: x-webhook-timestamp: <unix seconds>
 *
 * Signing algorithm: HMAC-SHA256(secretKey, rawBody)
 *   where secretKey = base64-decode(AGENTPHONE_WEBHOOK_SECRET after stripping "whsec_" prefix)
 *
 * Set SKIP_WEBHOOK_SIGNATURE=true to bypass for demo/development.
 */

const crypto = require('crypto');

class WebhookVerifier {
  constructor() {
    const raw = process.env.AGENTPHONE_WEBHOOK_SECRET || '';
    this.skip = process.env.SKIP_WEBHOOK_SIGNATURE === 'true';

    if (this.skip) {
      console.warn('[WebhookVerifier] ⚠️  Signature verification DISABLED (SKIP_WEBHOOK_SIGNATURE=true)');
    }

    if (!raw) {
      console.warn('[WebhookVerifier] AGENTPHONE_WEBHOOK_SECRET not set');
      this.secretRaw    = null;
      this.secretBytes  = null;
      this.secretStripped = null;
      return;
    }

    // Variant 1: full raw secret as UTF-8 (e.g. "whsec_XOzx..." used as-is)
    this.secretRaw = raw;

    const b64 = raw.startsWith('whsec_') ? raw.slice(6) : raw;

    // Variant 2: part after "whsec_" prefix as plain UTF-8 (not decoded)
    this.secretStripped = Buffer.from(b64);

    // Variant 3: base64-decode the part after "whsec_" prefix
    try {
      this.secretBytes = Buffer.from(b64, 'base64');
    } catch {
      this.secretBytes = null;
    }
  }

  /**
   * Verify webhook from Next.js request.
   * @param {Object} req            - Next.js request
   * @param {string} rawBodyString  - Exact raw body string (bodyParser must be disabled)
   */
  verifyRequest(req, rawBodyString) {
    if (this.skip) {
      console.warn('[WebhookVerifier] ⚠️  Skipping — returning true for demo');
      return true;
    }

    const signatureHeader = req.headers['x-webhook-signature'];

    if (!signatureHeader) {
      console.error('[WebhookVerifier] Missing x-webhook-signature header');
      console.error('[WebhookVerifier] All headers:', JSON.stringify(Object.keys(req.headers)));
      return false;
    }

    // Extract hex digest — supports "sha256=<hex>" and plain "<hex>"
    let receivedDigest;
    if (signatureHeader.includes('=')) {
      const parts = signatureHeader.split('=');
      receivedDigest = parts[parts.length - 1];
    } else {
      receivedDigest = signatureHeader;
    }

    // Try all 3 key variants: raw UTF-8, stripped UTF-8 (no whsec_ prefix), base64-decoded
    const rawKey = this.secretRaw ? Buffer.from(this.secretRaw) : null;
    const matched = this._tryVerify(receivedDigest, rawBodyString, rawKey)
                 || this._tryVerify(receivedDigest, rawBodyString, this.secretStripped)
                 || this._tryVerify(receivedDigest, rawBodyString, this.secretBytes);

    if (!matched) {
      console.error('[WebhookVerifier] Signature mismatch');
      console.error('[WebhookVerifier] Received               :', receivedDigest);
      console.error('[WebhookVerifier] Computed (raw key)     :', rawKey ? this._hmac(rawBodyString, rawKey) : 'N/A');
      console.error('[WebhookVerifier] Computed (stripped key):', this.secretStripped ? this._hmac(rawBodyString, this.secretStripped) : 'N/A');
      console.error('[WebhookVerifier] Computed (decoded key) :', this.secretBytes ? this._hmac(rawBodyString, this.secretBytes) : 'N/A');
    } else {
      console.log('[WebhookVerifier] ✓ Signature verified');
    }

    return matched;
  }

  _hmac(body, keyBuffer) {
    return crypto.createHmac('sha256', keyBuffer).update(body).digest('hex');
  }

  _tryVerify(receivedHex, body, keyBuffer) {
    if (!keyBuffer) return false;
    try {
      const computed = this._hmac(body, keyBuffer);
      return crypto.timingSafeEqual(
        Buffer.from(receivedHex.toLowerCase(), 'hex'),
        Buffer.from(computed, 'hex')
      );
    } catch {
      return false;
    }
  }
}

module.exports = new WebhookVerifier();
