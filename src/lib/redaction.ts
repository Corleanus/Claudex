/**
 * Claudex v2 — Centralized Redaction Engine (Module 8.1)
 *
 * PII/secret/entropy-based redaction. Two public entry points:
 * - redactSensitive(): Full redaction (secrets + PII + entropy) — for ingestion
 * - redactAssemblyOutput(): Light redaction (secrets + entropy) — for assembly safety-net
 */

// =============================================================================
// Pattern-based: Secrets
// =============================================================================

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|token|secret|password|credential)[s]?\s*[:=]\s*['"]?[^\s'"]+/gi,
  /(?:sk|pk|ak|rk)[-_][a-zA-Z0-9]{20,}/g,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
  /(?:eyJ)[A-Za-z0-9_-]+\.(?:eyJ)[A-Za-z0-9_-]+/g,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
];

// =============================================================================
// Pattern-based: PII
// =============================================================================

const PII_PATTERNS: RegExp[] = [
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // Phone numbers (international formats)
  /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  // SSN-like patterns
  /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
  // Credit card numbers (basic)
  /\b(?:\d{4}[-.\s]?){3}\d{4}\b/g,
  // IP addresses — private ranges preserved, public redacted
  /\b(?!(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.)(?:\d{1,3}\.){3}\d{1,3}\b/g,
];

// UUID pattern — protected from PII false positives (digit groups in UUIDs match phone/SSN)
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// =============================================================================
// Entropy-based detection
// =============================================================================

function shannonEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  const len = str.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// High-entropy candidate strings — at least 20 chars of alphanumeric + common token chars
const HIGH_ENTROPY_PATTERN = /[a-zA-Z0-9+/=_-]{20,}/g;

// Allowlist: high-entropy but NOT secrets
const ENTROPY_ALLOWLIST: RegExp[] = [
  /^[0-9a-f]{32,}$/i,                                     // SHA hashes (hex-only)
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,        // UUIDs
  /^[A-Za-z]:\\|^\/[a-z]/,                                 // File paths (Windows or Unix)
  /^https?:\/\//,                                          // URLs (http:// or https:// prefixed)
  /https?:\/\/[^\s]+/,                                     // URLs anywhere in string
  /^[A-Za-z_][A-Za-z0-9_]*$/,                              // Identifiers (camelCase, snake_case)
  /^[A-Za-z0-9+/]+=*$/,                                    // Base64-encoded data (ends with 0-2 '=')
  /\.[a-zA-Z]{2,}$/,                                       // File paths with extensions
];

function isAllowlisted(match: string): boolean {
  return ENTROPY_ALLOWLIST.some(pattern => pattern.test(match));
}

function redactHighEntropy(text: string, threshold = 4.5, minLength = 20): string {
  return text.replace(HIGH_ENTROPY_PATTERN, (match) => {
    if (match.length >= minLength && shannonEntropy(match) >= threshold && !isAllowlisted(match)) {
      return '[REDACTED-ENTROPY]';
    }
    return match;
  });
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Full redaction: secrets + PII + entropy.
 * Use at ingestion (PostToolUse hook, before SQLite write).
 */
export function redactSensitive(text: string): string {
  let result = text;

  // Layer 1: Pattern-based secrets
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }

  // Layer 2: PII patterns — protect UUIDs first (their digit groups trigger phone/SSN)
  const uuidPlaceholders: string[] = [];
  UUID_PATTERN.lastIndex = 0;
  result = result.replace(UUID_PATTERN, (match) => {
    const idx = uuidPlaceholders.length;
    uuidPlaceholders.push(match);
    return `__UUID_PLACEHOLDER_${idx}__`;
  });

  for (const pattern of PII_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED-PII]');
  }

  // Restore UUIDs
  for (let i = 0; i < uuidPlaceholders.length; i++) {
    result = result.replace(`__UUID_PLACEHOLDER_${i}__`, uuidPlaceholders[i]!);
  }

  // Layer 3: Entropy-based detection
  result = redactHighEntropy(result);

  return result;
}

/**
 * Safety-net for context assembly output (FULL redaction — secrets + PII + entropy).
 * Even though PII should be redacted at ingestion, the assembly safety-net must catch any leaks.
 */
export function redactAssemblyOutput(text: string): string {
  // Use the full redactSensitive() to ensure PII patterns are caught
  return redactSensitive(text);
}

/**
 * Sanitize file paths to remove usernames and PII.
 * Converts absolute paths to project-relative where possible.
 * Example: C:\Users\John\Projects\myapp\src\file.ts -> <project>/src/file.ts
 */
export function sanitizePath(path: string, projectRoot?: string): string {
  if (!path) return path;

  // If we have a project root, make the path relative to it
  if (projectRoot) {
    const normalized = path.replace(/\\/g, '/');
    const rootNormalized = projectRoot.replace(/\\/g, '/');
    if (normalized.startsWith(rootNormalized)) {
      const relative = normalized.slice(rootNormalized.length).replace(/^\/+/, '');
      return `<project>/${relative}`;
    }
  }

  // Otherwise, redact username patterns in absolute paths
  // Windows: C:\Users\USERNAME\... -> C:\Users\[USER]\...
  let sanitized = path.replace(
    /([A-Za-z]:\\Users\\)[^\\]+/g,
    '$1[USER]'
  );

  // Unix: /home/USERNAME/... -> /home/[USER]/...
  sanitized = sanitized.replace(
    /(\/home\/)[^\/]+/g,
    '$1[USER]'
  );

  // Unix: /Users/USERNAME/... (macOS) -> /Users/[USER]/...
  sanitized = sanitized.replace(
    /(\/Users\/)[^\/]+/g,
    '$1[USER]'
  );

  return sanitized;
}

// Export shannonEntropy for testing
export { shannonEntropy as _shannonEntropy };
