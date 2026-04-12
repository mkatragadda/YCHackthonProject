/**
 * WiseClient Tests
 * Tests for the low-level HTTP client for Wise API
 */

import WiseClient from '../../../services/wise/wiseClient';

// Mock fetch
global.fetch = jest.fn();

// Helper to create proper mock response
const createMockResponse = (config) => ({
  ok: config.ok !== undefined ? config.ok : true,
  status: config.status || 200,
  statusText: config.statusText || 'OK',
  text: async () => config.text || JSON.stringify(config.json || {}),
  json: async () => config.json || {},
  headers: {
    get: (key) => (config.headers && config.headers[key]) || null,
  },
});

describe('WiseClient', () => {
  let client;
  const mockApiKey = 'test-api-key';
  const mockProfileId = '12345';

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();

    // Create client instance
    client = new WiseClient({
      apiKey: mockApiKey,
      profileId: mockProfileId,
      baseURL: 'https://api.sandbox.transferwise.tech',
      environment: 'sandbox',
    });
  });

  describe('Constructor', () => {
    it('should initialize with sandbox environment', () => {
      const sandboxClient = new WiseClient({
        apiKey: mockApiKey,
        profileId: mockProfileId,
        baseURL: 'https://api.sandbox.transferwise.tech',
        environment: 'sandbox',
      });
      expect(sandboxClient.baseURL).toBe('https://api.sandbox.transferwise.tech');
    });

    it('should initialize with live environment', () => {
      const liveClient = new WiseClient({
        apiKey: mockApiKey,
        profileId: mockProfileId,
        baseURL: 'https://api.transferwise.com',
        environment: 'live',
      });
      expect(liveClient.baseURL).toBe('https://api.transferwise.com');
    });

    it('should store apiKey correctly', () => {
      const testClient = new WiseClient({
        apiKey: mockApiKey,
        profileId: mockProfileId,
        baseURL: 'https://api.sandbox.transferwise.tech',
        environment: 'sandbox',
      });
      expect(testClient.apiKey).toBe(mockApiKey);
    });

    it('should store profileId correctly', () => {
      const testClient = new WiseClient({
        apiKey: mockApiKey,
        profileId: mockProfileId,
        baseURL: 'https://api.sandbox.transferwise.tech',
        environment: 'sandbox',
      });
      expect(testClient.profileId).toBe(mockProfileId);
    });
  });

  describe('GET requests', () => {
    it('should make successful GET request', async () => {
      const mockResponse = { id: 1, name: 'Test' };
      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(mockResponse),
        json: async () => mockResponse,
        headers: {
          get: (key) => key === 'content-type' ? 'application/json' : null,
        },
      });

      const result = await client.get('/test-endpoint');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/test-endpoint'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${mockApiKey}`,
          }),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle 404 errors', async () => {
      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: { error: 'Not found' },
        headers: { 'content-type': 'application/json' },
      }));

      await expect(client.get('/not-found')).rejects.toThrow('404');
    });

    it('should handle 401 unauthorized errors', async () => {
      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: { error: 'Invalid token' },
        headers: { 'content-type': 'application/json' },
      }));

      await expect(client.get('/protected')).rejects.toThrow('401');
    });
  });

  describe('POST requests', () => {
    it('should make successful POST request with body', async () => {
      const requestBody = { amount: 100, currency: 'USD' };
      const mockResponse = { id: 'quote-123', ...requestBody };

      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Map([['content-type', 'application/json']]),
      });

      const result = await client.post('/quotes', requestBody);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/quotes'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(requestBody),
          headers: expect.objectContaining({
            'Authorization': `Bearer ${mockApiToken}`,
            'Content-Type': 'application/json',
          }),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle validation errors (400)', async () => {
      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          errors: [{ code: 'INVALID_AMOUNT', message: 'Amount too small' }]
        }),
      });

      await expect(client.post('/quotes', { amount: 0 })).rejects.toThrow('400');
    });
  });

  describe('PATCH requests', () => {
    it('should make successful PATCH request', async () => {
      const updateData = { targetAccount: '123456' };
      const mockResponse = { id: 'quote-123', ...updateData };

      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Map([['content-type', 'application/json']]),
      });

      const result = await client.patch('/quotes/quote-123', updateData);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/quotes/quote-123'),
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify(updateData),
        })
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('Retry logic', () => {
    it('should retry on network error', async () => {
      // First call fails, second succeeds
      global.fetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
          headers: new Map([['content-type', 'application/json']]),
        });

      const result = await client.get('/test');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ success: true });
    });

    it('should retry on 429 rate limit', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: async () => ({ error: 'Rate limited' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
          headers: new Map([['content-type', 'application/json']]),
        });

      const result = await client.get('/test');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ success: true });
    });

    it('should fail after max retries', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));

      await expect(client.get('/test')).rejects.toThrow();
      expect(global.fetch).toHaveBeenCalledTimes(3); // Max retries
    });

    it('should NOT retry on 400 Bad Request', async () => {
      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Invalid input' }),
      });

      await expect(client.get('/test')).rejects.toThrow();
      expect(global.fetch).toHaveBeenCalledTimes(1); // No retry
    });
  });

  describe('Error handling', () => {
    it('should throw error with response details', async () => {
      const errorResponse = {
        errors: [
          { code: 'INSUFFICIENT_BALANCE', message: 'Not enough funds' }
        ]
      };

      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => errorResponse,
      });

      try {
        await client.post('/transfers', {});
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).toContain('422');
        expect(error.details).toEqual(errorResponse);
      }
    });

    it('should handle non-JSON error responses', async () => {
      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Not JSON');
        },
        text: async () => 'Internal server error',
      });

      await expect(client.get('/test')).rejects.toThrow();
    });
  });

  describe('Headers', () => {
    it('should include authorization header', async () => {
      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Map([['content-type', 'application/json']]),
      });

      await client.get('/test');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${mockApiKey}`,
          }),
        })
      );
    });

    it('should include content-type for POST requests', async () => {
      global.fetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Map([['content-type', 'application/json']]),
      });

      await client.post('/test', { data: 'test' });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });
  });
});
