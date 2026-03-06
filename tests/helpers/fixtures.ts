import { expect } from 'vitest';

/**
 * Substantial Read output that passes the MIN_READ_CONTENT_LENGTH noise filter.
 * Use this in any test that needs a non-trivial Read observation.
 */
export const SUBSTANTIAL_READ_OUTPUT = 'import { something } from "./module";\nexport function doWork(input: string): boolean {\n  const result = process(input);\n  return result.success;\n}\n\nexport default doWork;';

/**
 * Assert that assembled markdown does not contain a warm section.
 * Use after warm context was removed from context assembly.
 */
export function expectNoWarmSection(markdown: string): void {
  expect(markdown).not.toContain('Warm Context');
}
