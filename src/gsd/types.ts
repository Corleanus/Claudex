/**
 * Claudex v2 -- GSD Integration Types
 *
 * Type definitions for the GSD (Get Shit Done) state reader.
 * These types represent the parsed state of a .planning/ directory
 * and are consumed by all downstream GSD integration modules (Phases 2-8).
 */

// =============================================================================
// GSD Current Position (from STATE.md)
// =============================================================================

/** Parsed current position from .planning/STATE.md */
export interface GsdCurrentPosition {
  /** Current phase number (e.g., 1, 2.1) */
  phase: number;
  /** Total phases count (e.g., 8) */
  totalPhases: number;
  /** Phase name from STATE.md (e.g., "GSD State Reader") */
  phaseName: string | null;
  /** Current plan number within phase (e.g., 0) */
  plan: number;
  /** Total plans in current phase (null if "TBD") */
  totalPlans: number | null;
  /** Status text (e.g., "Ready to plan") */
  status: string | null;
}

// =============================================================================
// GSD Plan Summary (from disk)
// =============================================================================

/** Count of plan and summary files in a phase directory */
export interface GsdPlanSummary {
  /** Total plan files found (matching *-PLAN.md or PLAN.md) */
  total: number;
  /** Plan files with matching SUMMARY files */
  complete: number;
}

// =============================================================================
// GSD Phase (from ROADMAP.md + disk)
// =============================================================================

/** A single phase parsed from ROADMAP.md, enriched with disk state */
export interface GsdPhase {
  /** Phase number (1, 2, 2.1, etc.) */
  number: number;
  /** Phase name from ROADMAP.md */
  name: string;
  /** Goal text (null if not specified) */
  goal: string | null;
  /** Raw depends-on text (null if not specified) */
  dependsOn: string | null;
  /** Requirement IDs (e.g., ["PCTX-01"]) */
  requirements: string[];
  /** Numbered success criteria */
  successCriteria: string[];
  /** Checkbox status in roadmap (true = [x]) */
  roadmapComplete: boolean;
  /** Plan count from disk (null if no directory found) */
  plans: GsdPlanSummary | null;
}

// =============================================================================
// GSD State (top-level composite)
// =============================================================================

/** Complete GSD state for a project directory */
export interface GsdState {
  /** false if no .planning/ directory or unparseable */
  active: boolean;
  /** Current position from STATE.md (null if unparseable) */
  position: GsdCurrentPosition | null;
  /** All phases from ROADMAP.md, sorted by number */
  phases: GsdPhase[];
  /** Cross-reference inconsistencies between STATE.md and filesystem */
  warnings: string[];
}

// =============================================================================
// Phase Relevance (for phase-weighted scoring)
// =============================================================================

/** Tiered set of files relevant to the current GSD phase */
export interface PhaseRelevanceSet {
  /** Active plan files get full boost (1.4x) */
  activePlanFiles: Set<string>;
  /** Other plans in the same phase get partial boost (1.2x) */
  otherPlanFiles: Set<string>;
}

// =============================================================================
// Constants
// =============================================================================

/** Empty state returned when no .planning/ directory exists or parsing fails */
export const EMPTY_GSD_STATE: Readonly<GsdState> = Object.freeze({
  active: false,
  position: null,
  phases: [],
  warnings: [],
});
