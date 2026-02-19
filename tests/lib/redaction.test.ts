import { describe, it, expect } from 'vitest';
import {
  redactSensitive,
  redactAssemblyOutput,
  sanitizePath,
  _shannonEntropy as shannonEntropy,
} from '../../src/lib/redaction.js';

// Backward-compatible alias
import { redactSecrets } from '../../src/lib/observation-extractor.js';

// =============================================================================
// Secret pattern tests (moved from observation-extractor)
// =============================================================================

describe('redactSensitive — secret patterns', () => {
  it('redacts API keys', () => {
    const input = 'Config: api_key = sk-abc123xyz456789012345';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-abc123xyz456789012345');
  });

  it('redacts GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)', () => {
    const ghToken = 'token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const result = redactSensitive(ghToken);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('redacts JWT tokens (full 3-segment)', () => {
    const jwt = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactSensitive(jwt);
    expect(result).toContain('[REDACTED]');
    // Entire JWT including signature must be redacted
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).not.toContain('dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
  });

  it('redacts JWT signature segment (not just header.payload)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Sfl_K4eK8tkq9X6Wc1pM';
    const result = redactSensitive(jwt);
    expect(result).toBe('[REDACTED]');
  });

  it('redacts AWS credentials', () => {
    const awsKey = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = redactSensitive(awsKey);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts password= assignments', () => {
    const input = 'password = "hunter2"';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('hunter2');
  });

  it('does not redact normal text', () => {
    const normal = 'This is a perfectly normal sentence about coding.';
    expect(redactSensitive(normal)).toBe(normal);
  });
});

// =============================================================================
// PII pattern tests
// =============================================================================

describe('redactSensitive — PII patterns', () => {
  it('redacts email addresses', () => {
    const input = 'Contact: user@example.com for details';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('user@example.com');
  });

  it('redacts phone numbers (US format)', () => {
    const input = 'Call me at (555) 123-4567';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('(555) 123-4567');
  });

  it('redacts phone numbers with +1 prefix', () => {
    const input = 'Phone: +1-555-123-4567';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('+1-555-123-4567');
  });

  it('redacts SSN-like patterns', () => {
    const input = 'SSN: 123-45-6789';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('123-45-6789');
  });

  it('redacts credit card numbers', () => {
    const input = 'Card: 4111-1111-1111-1111';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('4111-1111-1111-1111');
  });

  it('redacts public IP addresses', () => {
    const input = 'Server at 203.0.113.42';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('203.0.113.42');
  });

  it('does NOT redact private IP 10.x.x.x', () => {
    const input = 'Local: 10.0.0.1';
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact private IP 127.x.x.x', () => {
    const input = 'Localhost: 127.0.0.1';
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact private IP 192.168.x.x', () => {
    const input = 'LAN: 192.168.1.100';
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact private IP 172.16-31.x.x', () => {
    const input = 'Docker: 172.17.0.2';
    expect(redactSensitive(input)).toBe(input);
  });
});

// =============================================================================
// Entropy-based detection tests
// =============================================================================

describe('redactSensitive — entropy detection', () => {
  it('redacts high-entropy random strings (>= 4.5 bits, >= 20 chars)', () => {
    // Random string with high entropy — includes _ and - which are in HIGH_ENTROPY_PATTERN but NOT valid base64
    const randomStr = 'aB3d_5fG7-J9kL1mN3pQ5rS7tU9vW1xYz';
    const input = `Value is ${randomStr} here`;
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED-ENTROPY]');
    expect(result).not.toContain(randomStr);
  });

  it('does NOT redact low-entropy strings (repeated chars)', () => {
    const input = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 'a's, entropy = 0
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact strings shorter than 20 chars', () => {
    const shortToken = 'aB3dE5fG7hJ9kL1mN'; // 18 chars
    const input = `Short: ${shortToken}`;
    expect(redactSensitive(input)).toBe(input);
  });

  it('shannonEntropy returns 0 for single-char strings', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
  });

  it('shannonEntropy returns ~1.0 for two equally distributed chars', () => {
    const e = shannonEntropy('abab');
    expect(e).toBeCloseTo(1.0, 1);
  });

  it('shannonEntropy returns high value for diverse chars', () => {
    // All unique chars -> high entropy
    const e = shannonEntropy('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(e).toBeGreaterThan(4.5);
  });
});

// =============================================================================
// Allowlist tests (high-entropy but NOT secrets)
// =============================================================================

describe('redactSensitive — entropy allowlist', () => {
  it('does NOT redact SHA-256 hashes (hex-only)', () => {
    const sha = 'da893891a2b3c4d5e6f708192a3b4c5d';
    const input = `Commit: ${sha}`;
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact UUIDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const input = `ID: ${uuid}`;
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact identifier-like strings (camelCase/snake_case)', () => {
    const ident = 'myFunctionNameThatIsVeryLong';
    const input = `Function: ${ident}`;
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact identifier-like strings (snake_case)', () => {
    const ident = 'my_function_name_that_is_long';
    const input = `Function: ${ident}`;
    expect(redactSensitive(input)).toBe(input);
  });

  // H23 fix: URL/path fragments should not be redacted
  it('does NOT redact URLs with https:// prefix', () => {
    const url = 'https://api.example.com/v1/users/abc123def456ghi789jkl';
    const input = `Fetching from ${url}`;
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact URLs with http:// prefix', () => {
    const url = 'http://localhost:3000/api/test/abc123def456ghi789';
    const input = `Local API: ${url}`;
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact file paths with extensions', () => {
    const path = 'C:\\Users\\Test\\Projects\\myapp\\src\\components\\LongComponentName.tsx';
    const input = `File: ${path}`;
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact Unix file paths with extensions', () => {
    const path = '/home/user/projects/myapp/src/lib/VeryLongUtilityFunctionName.ts';
    const input = `Source: ${path}`;
    expect(redactSensitive(input)).toBe(input);
  });

  it('does NOT redact base64-encoded legitimate content', () => {
    const base64 = 'SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0IHN0cmluZyB3aXRoIGJhc2U2NCBlbmNvZGluZw==';
    const input = `Data: ${base64}`;
    expect(redactSensitive(input)).toBe(input);
  });
});

// =============================================================================
// Assembly safety-net tests
// =============================================================================

describe('redactAssemblyOutput', () => {
  it('redacts secrets in assembly output', () => {
    const input = 'Config: api_key = sk-abc123xyz456789012345';
    const result = redactAssemblyOutput(input);
    expect(result).toContain('[REDACTED]');
  });

  it('redacts high-entropy strings in assembly output', () => {
    const randomStr = 'aB3d_5fG7-J9kL1mN3pQ5rS7tU9vW1xYz';
    const result = redactAssemblyOutput(`Value is ${randomStr} here`);
    expect(result).toContain('[REDACTED-ENTROPY]');
  });

  it('redacts PII in assembly output (FULL redaction safety-net)', () => {
    const input = 'Contact: user@example.com';
    const result = redactAssemblyOutput(input);
    // Assembly safety-net NOW applies PII patterns (C1 fix)
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('user@example.com');
  });

  it('redacts phone numbers in assembly output', () => {
    const input = 'Call me at (555) 123-4567';
    const result = redactAssemblyOutput(input);
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('(555) 123-4567');
  });

  it('preserves normal text in assembly output', () => {
    const normal = 'This is normal assembly output with code context.';
    expect(redactAssemblyOutput(normal)).toBe(normal);
  });
});

// =============================================================================
// Backward compatibility
// =============================================================================

describe('backward compatibility — redactSecrets alias', () => {
  it('redactSecrets (from observation-extractor) works as alias for redactSensitive', () => {
    const input = 'Config: api_key = sk-abc123xyz456789012345';
    const fromAlias = redactSecrets(input);
    const fromDirect = redactSensitive(input);
    expect(fromAlias).toBe(fromDirect);
  });

  it('redactSecrets alias redacts PII too (full redaction)', () => {
    const input = 'Email: user@example.com';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('user@example.com');
  });
});

// =============================================================================
// Multiple patterns in one string
// =============================================================================

describe('redactSensitive — combined patterns', () => {
  it('redacts multiple types in one string', () => {
    const input = 'api_key = mysecretkey123 and email is test@example.com and IP is 203.0.113.1';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('[REDACTED-PII]');
    expect(result).not.toContain('mysecretkey123');
    expect(result).not.toContain('test@example.com');
    expect(result).not.toContain('203.0.113.1');
  });
});

// =============================================================================
// Path sanitization (C2 fix)
// =============================================================================

describe('sanitizePath', () => {
  it('converts absolute Windows path to project-relative', () => {
    const result = sanitizePath(
      'C:\\Users\\John\\Projects\\myapp\\src\\file.ts',
      'C:\\Users\\John\\Projects\\myapp'
    );
    expect(result).toBe('<project>/src/file.ts');
  });

  it('converts absolute Unix path to project-relative', () => {
    const result = sanitizePath(
      '/home/john/projects/myapp/src/file.ts',
      '/home/john/projects/myapp'
    );
    expect(result).toBe('<project>/src/file.ts');
  });

  it('converts absolute macOS path to project-relative', () => {
    const result = sanitizePath(
      '/Users/john/projects/myapp/src/file.ts',
      '/Users/john/projects/myapp'
    );
    expect(result).toBe('<project>/src/file.ts');
  });

  it('redacts Windows username when no project root given', () => {
    const result = sanitizePath('C:\\Users\\John\\Desktop\\file.txt');
    expect(result).toBe('C:\\Users\\[USER]\\Desktop\\file.txt');
    expect(result).not.toContain('John');
  });

  it('redacts Unix /home username when no project root given', () => {
    const result = sanitizePath('/home/john/Desktop/file.txt');
    expect(result).toBe('/home/[USER]/Desktop/file.txt');
    expect(result).not.toContain('john');
  });

  it('redacts macOS /Users username when no project root given', () => {
    const result = sanitizePath('/Users/jane/Documents/file.txt');
    expect(result).toBe('/Users/[USER]/Documents/file.txt');
    expect(result).not.toContain('jane');
  });

  it('handles empty or null paths gracefully', () => {
    expect(sanitizePath('')).toBe('');
  });

  it('handles paths outside project root', () => {
    const result = sanitizePath(
      'C:\\Users\\John\\OtherProject\\file.ts',
      'C:\\Users\\John\\Projects\\myapp'
    );
    // Falls back to username redaction
    expect(result).toBe('C:\\Users\\[USER]\\OtherProject\\file.ts');
  });
});
