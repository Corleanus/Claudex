/**
 * Claudex v2 — FTS5 Query Utilities
 *
 * Normalizes FTS5 queries to avoid special character issues.
 * FTS5 treats hyphens as the NOT operator, which causes queries like
 * "tree-shaking" or "error-handling" to produce wrong or empty results.
 *
 * This utility strips problematic characters to make queries safe for FTS5 MATCH.
 */

/**
 * Normalize a query string for safe FTS5 MATCH usage.
 *
 * FTS5 special characters that need handling:
 * - Hyphen (-): interpreted as NOT operator
 * - Quotes ("): phrase delimiter (we preserve for intentional phrase searches)
 * - Parentheses ( ): grouping (we strip to avoid malformed syntax)
 * - Asterisk (*): prefix search (we preserve for intentional prefix searches)
 * - Colon (:): column filter (we preserve for intentional column searches)
 *
 * Strategy: Replace hyphens with spaces (split hyphenated words into separate terms).
 * Strip parentheses to avoid syntax errors. Preserve quotes, asterisk, colon for
 * power users who know FTS5 syntax.
 *
 * @param query - Raw user query string
 * @returns Normalized query safe for FTS5 MATCH
 */
export function normalizeFts5Query(query: string): string {
  return query
    .replace(/-/g, ' ')       // Replace hyphens with spaces
    .replace(/[()]/g, '')     // Strip parentheses
    .replace(/\s+/g, ' ')     // Collapse multiple spaces
    .trim();
}
