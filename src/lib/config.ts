/**
 * Application Configuration
 *
 * Centralized configuration module.
 * Yahoo Finance requires no API key, so price service is always available.
 */

export const config = {
  // Yahoo Finance requires no API key
};

/**
 * Check if price service is configured
 * @returns true - Yahoo Finance needs no API key
 */
export function isPriceServiceConfigured(): boolean {
  return true;
}

/**
 * @deprecated FMP is no longer used. Kept for backward compatibility.
 * @returns false
 */
export function isFmpConfigured(): boolean {
  return isPriceServiceConfigured();
}
