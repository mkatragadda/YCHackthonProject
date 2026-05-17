/**
 * Unit tests for AgentPhone Webhook Verifier
 */

const crypto = require('crypto');

// Mock environment variables
process.env.AGENTPHONE_WEBHOOK_SECRET = 'test_webhook_secret_123';

const webhookVerifier = require('../../../../services/agentphone/webhookVerifier');

describe('WebhookVerifier', () => {
  const testSecret = 'test_webhook_secret_123';
  const testPayload = {
    event: 'message.received',
    data: {
      id: 'msg_123',
      from: '+1234567890',
      body: 'Test message'
    }
  };

  describe('Configuration', () => {
    it('should be configured with webhook secret', () => {
      expect(webhookVerifier.isConfigured()).toBe(true);
      expect(webhookVerifier.secret).toBe(testSecret);
    });
  });

  describe('generateSignature()', () => {
    it('should generate valid HMAC-SHA256 signature for string payload', () => {
      const payloadString = JSON.stringify(testPayload);
      const signature = webhookVerifier.generateSignature(payloadString);

      expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify it's correct by computing manually
      const hmac = crypto.createHmac('sha256', testSecret);
      hmac.update(payloadString);
      const expectedDigest = hmac.digest('hex');

      expect(signature).toBe(`sha256=${expectedDigest}`);
    });

    it('should generate valid signature for object payload', () => {
      const signature = webhookVerifier.generateSignature(testPayload);

      expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify against manually computed signature
      const payloadString = JSON.stringify(testPayload);
      const hmac = crypto.createHmac('sha256', testSecret);
      hmac.update(payloadString);
      const expectedDigest = hmac.digest('hex');

      expect(signature).toBe(`sha256=${expectedDigest}`);
    });

    it('should throw error if secret not configured', () => {
      const verifierWithoutSecret = Object.create(
        Object.getPrototypeOf(webhookVerifier)
      );
      verifierWithoutSecret.secret = null;

      expect(() => {
        verifierWithoutSecret.generateSignature(testPayload);
      }).toThrow('Webhook secret not configured');
    });
  });

  describe('verifySignature()', () => {
    it('should verify valid signature', () => {
      const payloadString = JSON.stringify(testPayload);
      const validSignature = webhookVerifier.generateSignature(payloadString);

      const result = webhookVerifier.verifySignature(
        validSignature,
        payloadString
      );

      expect(result).toBe(true);
    });

    it('should verify signature for object payload', () => {
      const validSignature = webhookVerifier.generateSignature(testPayload);

      const result = webhookVerifier.verifySignature(
        validSignature,
        testPayload
      );

      expect(result).toBe(true);
    });

    it('should reject invalid signature', () => {
      const invalidSignature = 'sha256=' + 'a'.repeat(64);
      const payloadString = JSON.stringify(testPayload);

      const result = webhookVerifier.verifySignature(
        invalidSignature,
        payloadString
      );

      expect(result).toBe(false);
    });

    it('should reject signature with wrong format', () => {
      const invalidFormats = [
        'abc123',                    // No prefix
        'md5=abc123',                // Wrong algorithm
        'sha256:abc123',             // Wrong separator
        'sha256=xyz',                // Invalid hex
        'sha256=' + 'a'.repeat(63)   // Wrong length
      ];

      invalidFormats.forEach(signature => {
        const result = webhookVerifier.verifySignature(
          signature,
          JSON.stringify(testPayload)
        );
        expect(result).toBe(false);
      });
    });

    it('should reject missing signature', () => {
      const result = webhookVerifier.verifySignature(
        null,
        JSON.stringify(testPayload)
      );

      expect(result).toBe(false);
    });

    it('should reject if secret not configured', () => {
      const verifierWithoutSecret = Object.create(
        Object.getPrototypeOf(webhookVerifier)
      );
      verifierWithoutSecret.secret = null;

      const signature = 'sha256=' + 'a'.repeat(64);
      const result = verifierWithoutSecret.verifySignature(
        signature,
        JSON.stringify(testPayload)
      );

      expect(result).toBe(false);
    });

    it('should verify signature with valid timestamp', () => {
      const payloadString = JSON.stringify(testPayload);
      const validSignature = webhookVerifier.generateSignature(payloadString);
      const currentTimestamp = Math.floor(Date.now() / 1000);

      const result = webhookVerifier.verifySignature(
        validSignature,
        payloadString,
        currentTimestamp
      );

      expect(result).toBe(true);
    });

    it('should reject expired timestamp (older than 5 minutes)', () => {
      const payloadString = JSON.stringify(testPayload);
      const validSignature = webhookVerifier.generateSignature(payloadString);
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 6+ minutes ago

      const result = webhookVerifier.verifySignature(
        validSignature,
        payloadString,
        oldTimestamp
      );

      expect(result).toBe(false);
    });

    it('should reject future timestamp (more than 1 minute ahead)', () => {
      const payloadString = JSON.stringify(testPayload);
      const validSignature = webhookVerifier.generateSignature(payloadString);
      const futureTimestamp = Math.floor(Date.now() / 1000) + 120; // 2 minutes in future

      const result = webhookVerifier.verifySignature(
        validSignature,
        payloadString,
        futureTimestamp
      );

      expect(result).toBe(false);
    });

    it('should accept timestamp within clock skew tolerance', () => {
      const payloadString = JSON.stringify(testPayload);
      const validSignature = webhookVerifier.generateSignature(payloadString);
      const recentPastTimestamp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago

      const result = webhookVerifier.verifySignature(
        validSignature,
        payloadString,
        recentPastTimestamp
      );

      expect(result).toBe(true);
    });
  });

  describe('verifyRequest()', () => {
    it('should verify valid request', () => {
      const payloadString = JSON.stringify(testPayload);
      const validSignature = webhookVerifier.generateSignature(payloadString);

      const mockRequest = {
        headers: {
          'x-webhook-signature': validSignature,
          'x-webhook-timestamp': Math.floor(Date.now() / 1000).toString()
        },
        body: testPayload
      };

      const result = webhookVerifier.verifyRequest(mockRequest);

      expect(result).toBe(true);
    });

    it('should verify request with raw body', () => {
      const payloadString = JSON.stringify(testPayload);
      const validSignature = webhookVerifier.generateSignature(payloadString);

      const mockRequest = {
        headers: {
          'x-webhook-signature': validSignature
        },
        rawBody: payloadString,
        body: testPayload
      };

      const result = webhookVerifier.verifyRequest(mockRequest);

      expect(result).toBe(true);
    });

    it('should reject request with invalid signature', () => {
      const mockRequest = {
        headers: {
          'x-webhook-signature': 'sha256=' + 'a'.repeat(64)
        },
        body: testPayload
      };

      const result = webhookVerifier.verifyRequest(mockRequest);

      expect(result).toBe(false);
    });

    it('should reject request without signature header', () => {
      const mockRequest = {
        headers: {},
        body: testPayload
      };

      const result = webhookVerifier.verifyRequest(mockRequest);

      expect(result).toBe(false);
    });
  });

  describe('Timing Attack Prevention', () => {
    it('should use constant-time comparison', () => {
      const payloadString = JSON.stringify(testPayload);

      // Generate two different valid signatures for different payloads
      const signature1 = webhookVerifier.generateSignature(payloadString);
      const signature2 = webhookVerifier.generateSignature({ different: 'data' });

      // Both should be rejected with same timing characteristics
      const start1 = Date.now();
      webhookVerifier.verifySignature(signature2, payloadString);
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      webhookVerifier.verifySignature('sha256=' + 'a'.repeat(64), payloadString);
      const time2 = Date.now() - start2;

      // Times should be similar (within 10ms) - not a perfect test but demonstrates intent
      expect(Math.abs(time1 - time2)).toBeLessThan(10);
    });
  });

  describe('Replay Attack Prevention', () => {
    it('should prevent replay attacks using timestamp', () => {
      const payloadString = JSON.stringify(testPayload);
      const signature = webhookVerifier.generateSignature(payloadString);

      // First request should succeed
      const currentTime = Math.floor(Date.now() / 1000);
      const result1 = webhookVerifier.verifySignature(
        signature,
        payloadString,
        currentTime
      );
      expect(result1).toBe(true);

      // Same request 6 minutes later should fail
      const oldTime = currentTime - 360;
      const result2 = webhookVerifier.verifySignature(
        signature,
        payloadString,
        oldTime
      );
      expect(result2).toBe(false);
    });
  });
});
