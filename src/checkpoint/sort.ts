/**
 * Claudex v2 — Checkpoint filename sort utility
 *
 * Shared between loader.ts and writer.ts to avoid duplication.
 */

/**
 * Sort checkpoint filenames numerically.
 * Handles YYYY-MM-DD_cpN.yaml where N can be any number (cp10 > cp9).
 */
export function numericCheckpointSort(a: string, b: string): number {
  const extractN = (f: string): number => {
    const match = f.match(/_cp(\d+)\.yaml$/);
    return match ? parseInt(match[1]!, 10) : 0;
  };
  const dateA = a.slice(0, 10);
  const dateB = b.slice(0, 10);
  if (dateA !== dateB) return dateA.localeCompare(dateB);
  return extractN(a) - extractN(b);
}
