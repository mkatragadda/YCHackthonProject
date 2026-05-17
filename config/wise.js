/**
 * Wise API Configuration
 * Loads appropriate credentials based on environment (development/production)
 *
 * Environment Variables Required:
 * - Development/Sandbox:
 *   WISE_API_TOKEN_SANDBOX
 *   WISE_PROFILE_ID_SANDBOX
 *
 * - Production:
 *   WISE_API_TOKEN_LIVE
 *   WISE_PROFILE_ID_LIVE
 */

const getWiseConfig = () => {
  const env = process.env.NODE_ENV || 'development';

  console.log('[WiseConfig] Initializing for environment:', env);

  // ============================================================================
  // SANDBOX CONFIGURATION (Development/Staging)
  // ============================================================================
  if (env === 'development' || env === 'staging') {
    const apiToken = process.env.WISE_API_TOKEN_SANDBOX;
    const profileId = process.env.WISE_PROFILE_ID_SANDBOX;

    if (!apiToken || !profileId) {
      console.warn(
        '[WiseConfig] Wise sandbox credentials not configured. ' +
        'Add WISE_API_TOKEN_SANDBOX and WISE_PROFILE_ID_SANDBOX to .env.local'
      );

      // Return a placeholder config for development without throwing error
      // This allows the app to run even if Wise isn't configured yet
      return {
        apiKey: '',
        profileId: '',
        environment: 'sandbox',
        baseURL: 'https://api.sandbox.transferwise.tech',
        isSandbox: true,
        isConfigured: false,
      };
    }

    return {
      apiKey: apiToken,
      profileId: profileId,
      environment: 'sandbox',
      baseURL: 'https://api.wise-sandbox.com',
      isSandbox: true,
      isConfigured: true,
    };
  }

  // ============================================================================
  // PRODUCTION CONFIGURATION
  // ============================================================================
  if (env === 'production') {
    const apiToken = process.env.WISE_API_TOKEN_LIVE;
    const profileId = process.env.WISE_PROFILE_ID_LIVE;

    if (!apiToken || !profileId) {
      throw new Error(
        'Wise production credentials not configured. ' +
        'Add WISE_API_TOKEN_LIVE and WISE_PROFILE_ID_LIVE to environment variables. ' +
        'This is required for production deployments.'
      );
    }

    return {
      apiKey: apiToken,
      profileId: profileId,
      environment: 'live',
      baseURL: 'https://api.wise.com',
      isSandbox: false,
      isConfigured: true,
    };
  }

  // ============================================================================
  // UNKNOWN ENVIRONMENT
  // ============================================================================
  throw new Error(`Unknown NODE_ENV: ${env}. Expected 'development', 'staging', or 'production'.`);
};

/**
 * Check if Wise is configured
 * @returns {boolean}
 */
export const isWiseConfigured = () => {
  try {
    const config = getWiseConfig();
    return config.isConfigured === true;
  } catch (error) {
    return false;
  }
};

export default getWiseConfig;
