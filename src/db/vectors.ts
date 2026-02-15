/** Claudex v2 — Vector Search Abstraction Layer */

import type Database from 'better-sqlite3';
import {
  searchAll,
  searchObservations,
  searchReasoning as searchReasoningFts,
  searchConsensus as searchConsensusFts,
} from './search.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('vectors');

// =============================================================================
// Types
// =============================================================================

export interface VectorSearchResult {
  id: number;
  table: 'observations' | 'reasoning_chains' | 'consensus_decisions';
  title: string;
  snippet: string;
  score: number;
}

export interface VectorStore {
  search(query: string, limit?: number): VectorSearchResult[];
  searchByTable(query: string, table: string, limit?: number): VectorSearchResult[];
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Determine the source table from the observation's tool_name.
 * Reasoning chains use tool_name 'Flow', consensus uses 'Consensus',
 * everything else maps to the observations table.
 */
function resolveTable(toolName: string): VectorSearchResult['table'] {
  if (toolName === 'Flow') return 'reasoning_chains';
  if (toolName === 'Consensus') return 'consensus_decisions';
  return 'observations';
}

/**
 * Map a SearchResult to a VectorSearchResult.
 * BM25 rank is negative (lower = more relevant); convert to positive score.
 */
function toVectorResult(result: {
  observation: { id?: number; tool_name: string; title: string };
  rank: number;
  snippet: string;
}): VectorSearchResult {
  return {
    id: result.observation.id ?? 0,
    table: resolveTable(result.observation.tool_name),
    title: result.observation.title,
    snippet: result.snippet,
    score: Math.abs(result.rank),
  };
}

// =============================================================================
// FTS5VectorStore
// =============================================================================

/**
 * FTS5-backed implementation of VectorStore.
 * Wraps the existing FTS5 search functions from search.ts behind a
 * uniform interface that can later be swapped for a real vector store
 * (OpenAI embeddings, local models, etc.).
 *
 * Never throws — returns empty arrays on error.
 */
export class FTS5VectorStore implements VectorStore {
  constructor(private db: Database.Database) {}

  /**
   * Search across all FTS5 tables (observations, reasoning_chains, consensus_decisions).
   * Results are ranked by BM25 relevance (higher score = more relevant).
   */
  search(query: string, limit?: number): VectorSearchResult[] {
    try {
      const results = searchAll(this.db, query, { limit });
      return results.map(toVectorResult);
    } catch (err) {
      log.error('VectorStore.search failed:', err);
      return [];
    }
  }

  /**
   * Search within a specific table.
   * Routes to the appropriate FTS5 search function based on table name.
   */
  searchByTable(query: string, table: string, limit?: number): VectorSearchResult[] {
    try {
      switch (table) {
        case 'observations': {
          const results = searchObservations(this.db, query, { limit });
          return results.map(toVectorResult);
        }
        case 'reasoning_chains': {
          const results = searchReasoningFts(this.db, query, { limit });
          return results.map(toVectorResult);
        }
        case 'consensus_decisions': {
          const results = searchConsensusFts(this.db, query, { limit });
          return results.map(toVectorResult);
        }
        default: {
          log.error(`VectorStore.searchByTable: unknown table '${table}'`);
          return [];
        }
      }
    } catch (err) {
      log.error('VectorStore.searchByTable failed:', err);
      return [];
    }
  }
}
