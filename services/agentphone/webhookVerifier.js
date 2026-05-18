/**
 * AgentPhone Webhook Signature Verifier
 *
 * AgentPhone signs webhooks using HMAC-SHA256 over the concatenation:
 *   signedString = "{timestamp}.{rawBody}"
 *
 * Headers sent by AgentPhone:
 *   X-Webhook-Signature : sha256=<hex_digest>
 *   X-Webhook-Timestamp : <unix seconds>
 *   X-Webhook-ID        : <unique delivery id>
 *   X-Webhook-Event     : <event type>
 *
 * Set SKIP_WEBHOOK_SIGNATURE=true to bypass for local development.
 */

const crypto = require('crypto');

const REPLAY_WINDOW_SECONDS = 300; // 5 minutes

class WebhookVerifier {
  constructor() {
    const raw = process.env.AGENTPHONE_WEBHOOK_SECRET || '';
    this.skip = process.env.SKIP_WEBHOOK_SIGNATURE === 'true';

    if (this.skip) {
      console.warn('[WebhookVerifier] ⚠️  Signature verification DISABLED (SKIP_WEBHOOK_SIGNATURE=true)');
    }

    if (!raw) {
      console.warn('[WebhookVerifier] AGENTPHONE_WEBHOOK_SECRET not set');
      this.secret = null;
      return;
    }

    // Use secret as-is (plain UTF-8) — no base64 decoding
    this.secret = raw;
    console.log('[WebhookVerifier] Initialized: secret configured, length=' + raw.length);
  }

  /**
   * Verify an inbound AgentPhone webhook request.
   * @param {Object} req           - Next.js request object
   * @param {string} rawBodyString - Raw request body (bodyParser must be disabled)
   * @returns {boolean}
   */
  verifyRequest(req, rawBodyString) {
    if (this.skip) {
      console.warn('[WebhookVerifier] ⚠️  Skipping — returning true for demo');
      return true;
    }

    if (!this.secret) {
      console.error('[WebhookVerifier] Cannot verify — AGENTPHONE_WEBHOOK_SECRET not set');
      return false;
    }

    const signatureHeader = req.headers['x-webhook-signature'];
    const timestampHeader = req.headers['x-webhook-timestamp'];

    if (!signatureHeader) {
      console.error('[WebhookVerifier] Missing x-webhook-signature header');
      return false;
    }

    if (!timestampHeader) {
      console.error('[WebhookVerifier] Missing x-webhook-timestamp header');
      return false;
    }

    // Reject stale webhooks (replay attack protection)
    const timestamp = parseInt(timestampHeader, 10);
    const now = Math.floor(Date.now() / 1000);
    const age = now - timestamp;

    if (isNaN(timestamp) || age > REPLAY_WINDOW_SECONDS || age < -60) {
      console.error(`[WebhookVerifier] Timestamp rejected: age=${age}s (window=±${REPLAY_WINDOW_SECONDS}s)`);
      return false;
    }

    // Extract hex digest — supports "sha256=<hex>" and plain "<hex>"
    const receivedDigest = signatureHeader.includes('=')
      ? signatureHeader.split('=').slice(1).join('=')
      : signatureHeader;

    // Signed payload is: "{timestamp}.{rawBody}"
    const signedString = `${timestampHeader}.${rawBodyString}`;
    const computed = crypto
      .createHmac('sha256', this.secret)
      .update(signedString)
      .digest('hex');

    let matched = false;
    try {
      matched = crypto.timingSafeEqual(
        Buffer.from(receivedDigest.toLowerCase(), 'hex'),
        Buffer.from(computed, 'hex')
      );
    } catch {
      matched = false;
    }

    if (!matched) {
      console.error('[WebhookVerifier] Signature mismatch');
      console.error('[WebhookVerifier] Received :', receivedDigest);
      console.error('[WebhookVerifier] Computed :', computed);
      console.error('[WebhookVerifier] Timestamp:', timestampHeader);
    } else {
      console.log('[WebhookVerifier] ✓ Signature verified');
    }

    return matched;
  }
}

module.exports = new WebhookVerifier();
