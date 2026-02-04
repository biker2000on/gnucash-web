/**
 * Application Configuration
 *
 * Centralized configuration module for external API keys and service URLs.
 */

export const config = {
  fmpApiKey: process.env.FMP_API_KEY || '',
  fmpBaseUrl: 'https://financialmodelingprep.com',
};

/**
 * Check if FMP API is configured
 * @returns true if FMP_API_KEY environment variable is set
 */
export function isFmpConfigured(): boolean {
  return config.fmpApiKey.length > 0;
}
