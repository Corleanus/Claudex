import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  transcriptDir,
  completionMarkerPath,
  globalSessionLogPath,
  sessionDir,
  PATHS,
} from '../../src/shared/paths.js';

describe('paths - path traversal protection', () => {
  const CLAUDEX_HOME = path.join(os.homedir(), '.claudex');

  describe('transcriptDir', () => {
    it('handles normal session_id', () => {
      const result = transcriptDir('session-123-abc');
      expect(result).toBe(path.join(CLAUDEX_HOME, 'transcripts', 'session-123-abc'));
    });

    it('sanitizes path traversal attempts with ../', () => {
      const result = transcriptDir('../../etc/passwd');
      // All path separators and dots should be stripped
      expect(result).toBe(path.join(CLAUDEX_HOME, 'transcripts', 'etcpasswd'));
      expect(result).not.toContain('..');
      expect(result).not.toContain('/etc/');
    });

    it('sanitizes path traversal with backslashes', () => {
      const result = transcriptDir('..\\..\\windows\\system32');
      expect(result).toBe(path.join(CLAUDEX_HOME, 'transcripts', 'windowssystem32'));
      // Note: path.join() may add platform-appropriate separators (backslashes on Windows)
      // What matters is that the malicious sequences are removed from the session_id itself
      expect(result).not.toContain('windows\\system32'); // No backslash in the sanitized session_id part
      expect(result).not.toContain('..');
    });

    it('strips special characters', () => {
      const result = transcriptDir('session<>:"|?*123');
      expect(result).toBe(path.join(CLAUDEX_HOME, 'transcripts', 'session123'));
    });

    it('preserves valid characters (alphanumeric, hyphens, underscores)', () => {
      const result = transcriptDir('valid_session-ID-123');
      expect(result).toBe(path.join(CLAUDEX_HOME, 'transcripts', 'valid_session-ID-123'));
    });

    it('handles empty string after sanitization', () => {
      const result = transcriptDir('../../../');
      expect(result).toBe(path.join(CLAUDEX_HOME, 'transcripts', ''));
    });
  });

  describe('completionMarkerPath', () => {
    it('handles normal session_id', () => {
      const result = completionMarkerPath('session-456');
      expect(result).toBe(path.join(PATHS.sessions, '.completed-session-456'));
    });

    it('sanitizes path traversal attempts', () => {
      const result = completionMarkerPath('../../etc/shadow');
      expect(result).toBe(path.join(PATHS.sessions, '.completed-etcshadow'));
      expect(result).not.toContain('..');
    });

    it('strips slashes from session_id', () => {
      const result = completionMarkerPath('session/with/slashes');
      expect(result).toBe(path.join(PATHS.sessions, '.completed-sessionwithslashes'));
    });
  });

  describe('globalSessionLogPath', () => {
    it('handles normal session_id', () => {
      const result = globalSessionLogPath('session-789');
      expect(result).toBe(path.join(PATHS.sessions, 'session-789.md'));
    });

    it('sanitizes path traversal attempts', () => {
      const result = globalSessionLogPath('../../../tmp/exploit');
      expect(result).toBe(path.join(PATHS.sessions, 'tmpexploit.md'));
      expect(result).not.toContain('..');
    });
  });

  describe('sessionDir', () => {
    it('handles normal session_id', () => {
      const result = sessionDir('session-abc-123');
      expect(result).toBe(path.join(PATHS.sessions, 'session-abc-123'));
    });

    it('sanitizes path traversal attempts', () => {
      const result = sessionDir('../../var/log');
      expect(result).toBe(path.join(PATHS.sessions, 'varlog'));
      expect(result).not.toContain('..');
    });

    it('strips all invalid characters', () => {
      const result = sessionDir('session@#$%^&*()[]{}');
      expect(result).toBe(path.join(PATHS.sessions, 'session'));
    });
  });

  describe('edge cases', () => {
    it('handles session_id with null bytes', () => {
      const result = transcriptDir('session\x00malicious');
      // Null bytes should be stripped
      expect(result).not.toContain('\x00');
      expect(result).toBe(path.join(CLAUDEX_HOME, 'transcripts', 'sessionmalicious'));
    });

    it('handles very long session_id with traversal attempts', () => {
      const longId = '../'.repeat(100) + 'etc/passwd';
      const result = transcriptDir(longId);
      expect(result).not.toContain('..');
      expect(result).toBe(path.join(CLAUDEX_HOME, 'transcripts', 'etcpasswd'));
    });

    it('handles mixed valid and invalid characters', () => {
      const result = sessionDir('session-123_abc/../../etc');
      expect(result).toBe(path.join(PATHS.sessions, 'session-123_abcetc'));
    });
  });
});
