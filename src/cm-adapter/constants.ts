/**
 * CM Adapter — Shared Constants
 *
 * Centralized constants used across cm-adapter modules.
 * Prevents duplication of paths, caps, and identifiers.
 */

import * as path from 'node:path';
import * as os from 'node:os';

export const ECHO_HOME = path.join(os.homedir(), '.echo');
export const AGENT_ID = 'echo';

// State file caps
export const MAX_DECISIONS = 50;
export const MAX_OPEN_ITEMS = 50;
export const MAX_LEARNINGS = 10;
export const MAX_TOOLS = 100;
export const MAX_FILES = 100;
export const MAX_CROSS_SESSION_LEARNINGS = 50;
