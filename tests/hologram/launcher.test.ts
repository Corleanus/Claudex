import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

// Mock logger to prevent filesystem writes during tests
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock config to prevent reading from actual config file
vi.mock('../../src/shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    hologram: {
      python_path: 'python',
      sidecar_path: '/fake/sidecar.py',
    },
  })),
}));

// Mock paths to use temp directory (set in beforeEach)
let tempPidFile = '/fake/sidecar.pid';
let tempPortFile = '/fake/sidecar.port';
vi.mock('../../src/shared/paths.js', () => ({
  PATHS: {
    get hologramPid() { return tempPidFile; },
    get hologramPort() { return tempPortFile; },
    hookLogs: '/fake/logs',
    config: '/fake/config.json',
  },
}));

// We need vi.mock for child_process since ESM doesn't allow spyOn for module exports.
// Use a dynamic approach: mock the module, then import after.
const mockExecSync = vi.fn();
const mockSpawn = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

// Import isPythonSidecar and SidecarManager AFTER mocking child_process
const { isPythonSidecar, SidecarManager } = await import('../../src/hologram/launcher.js');

describe('isPythonSidecar — identity verification with fallback', () => {
  afterEach(() => {
    mockExecSync.mockReset();
  });

  if (process.platform === 'win32') {
    it('returns true when wmic succeeds and output contains python+sidecar', () => {
      mockExecSync.mockReturnValueOnce(
        'CommandLine\npython -m hologram.sidecar --port-file test\n\n'
      );
      expect(isPythonSidecar(12345)).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(mockExecSync.mock.calls[0]![0]).toContain('wmic');
    });

    it('falls back to PowerShell when wmic fails, succeeds', () => {
      // wmic throws
      mockExecSync.mockImplementationOnce(() => { throw new Error('wmic not found'); });
      // PowerShell succeeds
      mockExecSync.mockReturnValueOnce(
        'python -m hologram.sidecar --port-file test'
      );
      expect(isPythonSidecar(12345)).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
      expect(mockExecSync.mock.calls[1]![0]).toContain('powershell');
    });

    it('returns false when both wmic and PowerShell fail', () => {
      mockExecSync.mockImplementationOnce(() => { throw new Error('wmic not found'); });
      mockExecSync.mockImplementationOnce(() => { throw new Error('powershell failed'); });
      expect(isPythonSidecar(12345)).toBe(false);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it('returns false when wmic output does not contain python+sidecar', () => {
      mockExecSync.mockReturnValueOnce('CommandLine\nnotepad.exe\n\n');
      expect(isPythonSidecar(12345)).toBe(false);
    });
  } else {
    it('uses /proc or ps on Unix (no PowerShell path taken)', () => {
      // On Unix, isPythonSidecar reads /proc/PID/cmdline or falls back to ps
      // For a non-existent PID, it should return false
      mockExecSync.mockImplementation(() => { throw new Error('no such process'); });
      expect(isPythonSidecar(999999)).toBe(false);
    });
  }

  it('returns false when execSync always fails', () => {
    mockExecSync.mockImplementation(() => { throw new Error('command failed'); });
    expect(isPythonSidecar(999999)).toBe(false);
  });
});

describe('SidecarManager PID Identity Verification', () => {
  let tempDir: string;
  let pidFile: string;
  let portFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-launcher-test-'));
    pidFile = path.join(tempDir, 'sidecar.pid');
    portFile = path.join(tempDir, 'sidecar.port');
  });

  afterEach(() => {
    mockExecSync.mockReset();
    try {
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
      fs.rmdirSync(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should not kill a process if PID verification returns false', () => {
    const systemPid = process.platform === 'win32' ? 4 : 1;
    fs.writeFileSync(pidFile, String(systemPid), 'utf-8');
    // Mock execSync to simulate system process (not python sidecar)
    mockExecSync.mockReturnValue('System\n');
    expect(isPythonSidecar(systemPid)).toBe(false);
  });

  it('should return false for isPythonSidecar on non-existent process', () => {
    mockExecSync.mockImplementation(() => { throw new Error('no such process'); });
    expect(isPythonSidecar(999999)).toBe(false);
  });
});

describe('SidecarManager Spawn Error Handling', () => {
  let tempDir: string;

  /** Create a fake ChildProcess-like EventEmitter returned by mocked spawn() */
  function createFakeProc(pid: number | undefined = 12345): EventEmitter & { pid?: number; unref: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
    const proc = new EventEmitter() as EventEmitter & { pid?: number; unref: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
    proc.pid = pid;
    proc.unref = vi.fn();
    proc.kill = vi.fn();
    return proc;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-spawn-test-'));
    tempPidFile = path.join(tempDir, 'sidecar.pid');
    tempPortFile = path.join(tempDir, 'sidecar.port');

    // Ensure directories for PID/port files exist
    fs.mkdirSync(path.dirname(tempPidFile), { recursive: true });

    // Mock fs.openSync for stderr log (spawn uses it)
    mockExecSync.mockReset();
    mockSpawn.mockReset();
  });

  afterEach(() => {
    mockSpawn.mockReset();
    mockExecSync.mockReset();
    // Reset paths
    tempPidFile = '/fake/sidecar.pid';
    tempPortFile = '/fake/sidecar.port';
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should handle spawn errors gracefully (ENOENT)', async () => {
    // Create a fake ChildProcess that emits an error after a tick
    const fakeProc = createFakeProc(99999);
    mockSpawn.mockReturnValue(fakeProc);

    const manager = new SidecarManager();

    // Emit error asynchronously (simulating ENOENT from invalid Python path)
    const startPromise = manager.start();
    // Give the code time to register event handlers, then emit error
    await new Promise(r => setTimeout(r, 50));
    const spawnError = new Error('spawn python ENOENT');
    (spawnError as NodeJS.ErrnoException).code = 'ENOENT';
    fakeProc.emit('error', spawnError);

    // start() should reject with HologramUnavailableError
    await expect(startPromise).rejects.toThrow(/ENOENT/);
    await expect(startPromise).rejects.toThrow(/python/i);
  });

  it('should propagate spawn errors with diagnostic context including Python path', async () => {
    const fakeProc = createFakeProc(88888);
    mockSpawn.mockReturnValue(fakeProc);

    const manager = new SidecarManager();
    const startPromise = manager.start();

    await new Promise(r => setTimeout(r, 50));
    fakeProc.emit('error', new Error('spawn python ENOENT'));

    try {
      await startPromise;
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      // Error message should include the Python path for debugging
      expect(msg).toContain('python');
      // Should mention it's a spawn failure
      expect(msg.toLowerCase()).toContain('spawn');
    }
  });

  it('should clean up PID/port files on spawn error', async () => {
    const fakeProc = createFakeProc(77777);
    mockSpawn.mockReturnValue(fakeProc);

    // Pre-create port file to verify cleanup
    fs.writeFileSync(tempPortFile, '9999', 'utf-8');

    const manager = new SidecarManager();
    const startPromise = manager.start();

    await new Promise(r => setTimeout(r, 50));

    // At this point, PID file should have been written by start()
    const pidExists = fs.existsSync(tempPidFile);
    expect(pidExists).toBe(true);

    // Now emit error
    fakeProc.emit('error', new Error('spawn python EACCES'));

    try { await startPromise; } catch { /* expected */ }

    // After error, both PID and port files should be cleaned up
    expect(fs.existsSync(tempPidFile)).toBe(false);
    expect(fs.existsSync(tempPortFile)).toBe(false);
  });

  it('should register an error event listener on the spawned process', async () => {
    const fakeProc = createFakeProc(66666);
    mockSpawn.mockReturnValue(fakeProc);

    const manager = new SidecarManager();
    const startPromise = manager.start();

    // Wait for event handlers to be registered
    await new Promise(r => setTimeout(r, 50));

    // Verify that 'error' has at least one listener registered
    const errorListeners = fakeProc.listenerCount('error');
    expect(errorListeners).toBeGreaterThanOrEqual(1);

    // Cleanup: emit exit so the promise resolves
    fakeProc.emit('exit', 1, null);
    try { await startPromise; } catch { /* expected */ }
  });
});
