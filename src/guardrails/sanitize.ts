/**
 * Secret Sanitization
 *
 * Prevents credentials from leaking into learned workflow patterns.
 * Inspired by RepoMemory v2's 4-layer sanitization.
 *
 * - Layer 1: Known secrets → {{PLACEHOLDER}}
 * - Layer 2: URL auth params (apikey, token, access_token)
 * - Layer 3: JSON credential fields (authorization, api_key, bearer)
 * - Layer 4: Known prefixes (Bearer, sk-, ghp_, xoxb-, eyJ)
 */

/** Well-known sensitive parameter names */
const SENSITIVE_PARAMS = new Set([
  'apikey', 'api_key', 'apiKey',
  'token', 'access_token', 'accessToken',
  'secret', 'client_secret', 'clientSecret',
  'password', 'passwd',
  'authorization', 'auth',
  'bearer',
  'private_key', 'privateKey',
  'webhook_secret', 'webhookSecret',
]);

/** Known credential prefixes with minimum lengths */
const CREDENTIAL_PREFIXES = [
  { prefix: 'Bearer ', minLen: 20 },
  { prefix: 'sk-', minLen: 20 },
  { prefix: 'sk-ant-', minLen: 20 },
  { prefix: 'ghp_', minLen: 20 },
  { prefix: 'gho_', minLen: 20 },
  { prefix: 'xoxb-', minLen: 15 },
  { prefix: 'xoxp-', minLen: 15 },
  { prefix: 'eyJ', minLen: 30 },    // JWT
];

/**
 * Replace known secret values with {{PLACEHOLDER}} syntax.
 */
export function sanitizeSecrets(
  text: string,
  secrets?: Map<string, string>
): string {
  let result = text;

  // Layer 1: Known secrets map
  if (secrets) {
    for (const [name, value] of secrets) {
      if (value && value.length >= 4) {
        result = result.replaceAll(value, `{{${name}}}`);
      }
    }
  }

  // Layer 2: URL auth parameters
  result = result.replace(
    /([?&])(apikey|api_key|token|access_token|secret|key|password)=([^&\s"']{4,})/gi,
    (_, sep, param, _value) => `${sep}${param}={{${param.toUpperCase()}}}`
  );

  // Layer 3: JSON credential fields
  result = result.replace(
    /"(authorization|api_key|apiKey|token|secret|password|bearer|access_token)":\s*"([^"]{4,})"/gi,
    (_, key, _value) => `"${key}": "{{${key.toUpperCase()}}}"`
  );

  // Layer 4: Known credential prefixes
  for (const { prefix, minLen } of CREDENTIAL_PREFIXES) {
    const regex = new RegExp(
      `${escapeRegex(prefix)}[A-Za-z0-9_\\-/.+]{${minLen},}`,
      'g'
    );
    result = result.replace(regex, `{{REDACTED_${prefix.replace(/[^A-Za-z]/g, '').toUpperCase()}}}`);
  }

  return result;
}

/**
 * Resolve {{PLACEHOLDER}} back to actual values.
 */
export function resolveSecrets(
  text: string,
  secrets: Map<string, string>
): string {
  let result = text;
  for (const [name, value] of secrets) {
    result = result.replaceAll(`{{${name}}}`, value);
  }
  return result;
}

/**
 * Check if a parameter name is likely sensitive.
 */
export function isSensitiveParam(name: string): boolean {
  return SENSITIVE_PARAMS.has(name) || SENSITIVE_PARAMS.has(name.toLowerCase());
}

/**
 * Sanitize parameters object, replacing sensitive values.
 */
export function sanitizeParameters(
  params: Record<string, unknown>,
  secrets?: Map<string, string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (isSensitiveParam(key) && typeof value === 'string') {
      result[key] = `{{${key.toUpperCase()}}}`;
    } else if (typeof value === 'string') {
      result[key] = sanitizeSecrets(value, secrets);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeParameters(value as Record<string, unknown>, secrets);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
