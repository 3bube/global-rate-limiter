import { z } from 'zod';

export const checkRequestSchema = z.object({
  clientId: z.string().min(1),
  cost: z.number().int().positive().optional(),
});
export type CheckRequestBody = z.infer<typeof checkRequestSchema>;

export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).optional().default(7),
  // 'hour' exists so the dashboard can zoom into a single day's shape
  // instead of only seeing daily totals.
  granularity: z.enum(['day', 'hour']).optional().default('day'),
  outcome: z.enum(['all', 'allowed', 'denied']).optional().default('all'),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

export const clientLimitConfigSchema = z.object({
  clientId: z.string().min(1),
  limit: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
});
export const clientsFileSchema = z.array(clientLimitConfigSchema);
