import { z } from 'zod';

export const checkRequestSchema = z.object({
  clientId: z.string().min(1),
  cost: z.number().int().positive().optional(),
});
export type CheckRequestBody = z.infer<typeof checkRequestSchema>;

export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).optional().default(7),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;
