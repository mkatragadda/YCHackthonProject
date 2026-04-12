/**
 * Wise API HTTP Client
 * Low-level HTTP communication with retry logic
 */

class WiseClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.profileId = config.profileId;
    this.baseURL = config.baseURL;
    this.environment = config.environment;

    console.log('[WiseClient] Initialized:', {
      environment: this.environment,
      baseURL: this.baseURL,
      profileId: this.profileId,
    });
  }

  /**
   * GET request with retry logic
   */
  async get(path, params = {}) {
    const url = new URL(path, this.baseURL);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

    return this._fetchWithRetry(url.toString(), {
      method: 'GET',
      headers: this._getHeaders(),
    });
  }

  /**
   * POST request with retry logic
   */
  async post(path, data = {}) {
    const url = `${this.baseURL}${path}`;

    return this._fetchWithRetry(url, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify(data),
    });
  }

  /**
   * PATCH request with retry logic
   */
  async patch(path, data = {}) {
    const url = `${this.baseURL}${path}`;

    return this._fetchWithRetry(url, {
      method: 'PATCH',
      headers: this._getHeaders(),
      body: JSON.stringify(data),
    });
  }

  /**
   * Private: Build headers
   */
  _getHeaders() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Private: Fetch with exponential backoff retry
   */
  async _fetchWithRetry(url, options, attempt = 1, maxAttempts = 3) {
    const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    try {
      // Log detailed request
      console.log('\n========== WISE API REQUEST ==========');
      console.log(`[WiseClient] Request ID: ${requestId}`);
      console.log(`[WiseClient] Attempt: ${attempt}/${maxAttempts}`);
      console.log(`[WiseClient] Method: ${options.method}`);
      console.log(`[WiseClient] URL: ${url}`);
      console.log(`[WiseClient] Environment: ${this.environment}`);
      console.log(`[WiseClient] Profile ID: ${this.profileId}`);

      // Log headers (hide sensitive data)
      const logHeaders = { ...options.headers };
      if (logHeaders.Authorization) {
        logHeaders.Authorization = `Bearer ${this.apiKey.substring(0, 8)}...${this.apiKey.substring(this.apiKey.length - 4)}`;
      }
      console.log('[WiseClient] Headers:', JSON.stringify(logHeaders, null, 2));

      // Log request body if present
      if (options.body) {
        try {
          const bodyData = JSON.parse(options.body);
          console.log('[WiseClient] Request Body:', JSON.stringify(bodyData, null, 2));
        } catch (e) {
          console.log('[WiseClient] Request Body (raw):', options.body);
        }
      }
      console.log('======================================\n');

      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000), // 30s timeout
      });

      // Parse response
      let data;
      const responseText = await response.text();
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        console.error('[WiseClient] Failed to parse response as JSON:', responseText);
        data = { rawResponse: responseText };
      }

      // Log detailed response
      console.log('\n========== WISE API RESPONSE ==========');
      console.log(`[WiseClient] Request ID: ${requestId}`);
      console.log(`[WiseClient] Status: ${response.status} ${response.statusText}`);
      console.log(`[WiseClient] Headers:`, {
        'content-type': response.headers.get('content-type'),
        'x-request-id': response.headers.get('x-request-id'),
        'x-2fa-approval': response.headers.get('x-2fa-approval'),
      });
      console.log('[WiseClient] Response Body:', JSON.stringify(data, null, 2));
      console.log('=======================================\n');

      if (!response.ok) {
        throw this._mapError(response.status, data);
      }

      console.log(`[WiseClient] ✅ Request ${requestId} completed successfully`);
      return data;

    } catch (error) {
      console.log('\n========== WISE API ERROR ==========');
      console.log(`[WiseClient] Request ID: ${requestId}`);
      console.log(`[WiseClient] Attempt: ${attempt}/${maxAttempts}`);
      console.log(`[WiseClient] Error Type: ${error.name}`);
      console.log(`[WiseClient] Error Code: ${error.code || 'N/A'}`);
      console.log(`[WiseClient] Error Status: ${error.status || 'N/A'}`);
      console.log(`[WiseClient] Error Message: ${error.message}`);
      if (error.details) {
        // Use util.inspect for deep object inspection
        const util = require('util');
        console.log('[WiseClient] Error Details (FULL):');
        console.log(util.inspect(error.details, { depth: 10, colors: false }));

        // If there's an errors array, log each error in detail
        if (error.details.errors && Array.isArray(error.details.errors)) {
          console.log(`[WiseClient] Validation Errors Count: ${error.details.errors.length}`);
          error.details.errors.forEach((err, index) => {
            console.log(`\n  ========== Validation Error #${index + 1} ==========`);
            console.log(util.inspect(err, { depth: 10, colors: false }));
          });
        }
      }
      console.log('====================================\n');

      // Retry on network errors or 5xx (but not 4xx)
      const isRetryable = error.name === 'AbortError' ||
                          error.code?.startsWith('5') ||
                          error.message?.includes('fetch');

      if (isRetryable && attempt < maxAttempts) {
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.log(`[WiseClient] ⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this._fetchWithRetry(url, options, attempt + 1, maxAttempts);
      }

      console.log(`[WiseClient] ❌ Request ${requestId} failed after ${attempt} attempts`);
      throw error;
    }
  }

  /**
   * Private: Map Wise API errors to friendly messages
   */
  _mapError(status, data) {
    const errorCode = data.error?.code || 'UNKNOWN_ERROR';
    const errorMessage = data.error?.message || data.message || 'Unknown error';

    const errorMap = {
      'INSUFFICIENT_FUNDS': 'Your Wise balance is too low',
      'INVALID_QUOTE': 'Quote has expired, please refresh',
      'DUPLICATE_TRANSFER': 'This transfer was already processed',
      'RECIPIENT_NOT_FOUND': 'Recipient not configured',
      'RATE_LIMIT_EXCEEDED': 'Too many requests, please wait',
    };

    const friendlyMessage = errorMap[errorCode] || errorMessage;

    const error = new Error(friendlyMessage);
    error.code = errorCode;
    error.status = status;
    error.details = data;

    return error;
  }
}

export default WiseClient;
