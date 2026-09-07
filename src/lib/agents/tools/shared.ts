/**
 * Shared by every business tool: the pagination clamp and the predictable
 * { data, count, summary, metadata } result shape every tool returns, so an
 * LLM (or a human reading a log) sees the same envelope regardless of which
 * tool answered.
 */
import { z } from 'zod';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Never trust a caller-supplied limit — clamp to a sane, bounded range. */
export function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export const paginationInput = {
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).default(0),
};

export function resultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    count: z.number(),
    summary: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
}

export function toolResult<T>(data: T, count: number, summary: string, metadata?: Record<string, unknown>) {
  return { data, count, summary, metadata };
}
