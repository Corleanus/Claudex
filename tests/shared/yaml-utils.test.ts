import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { normalizeYaml, safeLoadYaml, safeWriteYaml } from '../../src/shared/yaml-utils.js';

describe('normalizeYaml', () => {
  it('strips UTF-8 BOM from start of string', () => {
    const withBom = '\uFEFFkey: value';
    expect(normalizeYaml(withBom)).toBe('key: value');
  });

  it('normalizes CRLF to LF', () => {
    expect(normalizeYaml('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('normalizes standalone CR to LF', () => {
    expect(normalizeYaml('a\rb\rc')).toBe('a\nb\nc');
  });

  it('handles mixed line endings', () => {
    expect(normalizeYaml('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('returns unchanged string if no BOM or CRLF', () => {
    const clean = 'key: value\nother: stuff';
    expect(normalizeYaml(clean)).toBe(clean);
  });

  it('handles BOM + CRLF together', () => {
    expect(normalizeYaml('\uFEFFa\r\nb')).toBe('a\nb');
  });

  it('handles empty string', () => {
    expect(normalizeYaml('')).toBe('');
  });
});

describe('safeLoadYaml', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-yaml-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null for non-existent file', () => {
    expect(safeLoadYaml(path.join(tempDir, 'nope.yaml'))).toBeNull();
  });

  it('returns null for empty file', () => {
    const fp = path.join(tempDir, 'empty.yaml');
    fs.writeFileSync(fp, '', 'utf-8');
    expect(safeLoadYaml(fp)).toBeNull();
  });

  it('returns null for whitespace-only file', () => {
    const fp = path.join(tempDir, 'ws.yaml');
    fs.writeFileSync(fp, '   \n  \n', 'utf-8');
    expect(safeLoadYaml(fp)).toBeNull();
  });

  it('parses valid YAML with JSON_SCHEMA', () => {
    const fp = path.join(tempDir, 'valid.yaml');
    fs.writeFileSync(fp, 'key: value\ncount: 42\n', 'utf-8');
    const result = safeLoadYaml(fp) as Record<string, unknown>;
    expect(result).toEqual({ key: 'value', count: 42 });
  });

  it('does not coerce yes/no to boolean (JSON_SCHEMA)', () => {
    const fp = path.join(tempDir, 'coerce.yaml');
    fs.writeFileSync(fp, 'flag: yes\n', 'utf-8');
    const result = safeLoadYaml(fp) as Record<string, unknown>;
    // JSON_SCHEMA treats 'yes' as string, not boolean
    expect(result.flag).toBe('yes');
  });

  it('handles BOM-prefixed YAML files', () => {
    const fp = path.join(tempDir, 'bom.yaml');
    fs.writeFileSync(fp, '\uFEFFkey: bomvalue\n', 'utf-8');
    const result = safeLoadYaml(fp) as Record<string, unknown>;
    expect(result.key).toBe('bomvalue');
  });

  it('handles CRLF line endings', () => {
    const fp = path.join(tempDir, 'crlf.yaml');
    fs.writeFileSync(fp, 'a: 1\r\nb: 2\r\n', 'utf-8');
    const result = safeLoadYaml(fp) as Record<string, unknown>;
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('returns null for corrupt YAML', () => {
    const fp = path.join(tempDir, 'corrupt.yaml');
    fs.writeFileSync(fp, '{ invalid yaml: [unclosed', 'utf-8');
    expect(safeLoadYaml(fp)).toBeNull();
  });
});

describe('safeWriteYaml', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-yaml-write-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes YAML that can be read back', () => {
    const fp = path.join(tempDir, 'roundtrip.yaml');
    const data = { name: 'test', count: 5, items: ['a', 'b'] };
    safeWriteYaml(fp, data);

    const loaded = safeLoadYaml(fp);
    expect(loaded).toEqual(data);
  });

  it('creates parent directories if needed', () => {
    const fp = path.join(tempDir, 'deep', 'nested', 'file.yaml');
    safeWriteYaml(fp, { key: 'val' });
    expect(fs.existsSync(fp)).toBe(true);
    expect(safeLoadYaml(fp)).toEqual({ key: 'val' });
  });

  it('overwrites existing file atomically', () => {
    const fp = path.join(tempDir, 'overwrite.yaml');
    safeWriteYaml(fp, { version: 1 });
    safeWriteYaml(fp, { version: 2 });
    expect(safeLoadYaml(fp)).toEqual({ version: 2 });
  });

  it('does not leave temp files on success', () => {
    const fp = path.join(tempDir, 'clean.yaml');
    safeWriteYaml(fp, { ok: true });
    expect(fs.existsSync(fp + '.tmp')).toBe(false);
  });
});
