import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ClientLimitLookup } from '../rateLimiter/RedisTokenBucketLimiter';
import type { ClientLimitConfig } from '../types';

/**
 * In-memory client -> limit registry, seeded from clients.json.
 *
 * This is intentionally the simplest thing that could work for a
 * qualification task: swap this for a Postgres-backed lookup (with a
 * short-lived in-memory cache in front of it) if clients need to be
 * managed at runtime instead of via a config file deploy.
 */
export class ClientRegistry implements ClientLimitLookup {
  private readonly configs = new Map<string, ClientLimitConfig>();

  constructor(configPath: string = path.join(__dirname, 'clients.json')) {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as ClientLimitConfig[];
    for (const entry of parsed) {
      this.configs.set(entry.clientId, entry);
    }
  }

  async getConfig(clientId: string): Promise<ClientLimitConfig | undefined> {
    return this.configs.get(clientId);
  }

  list(): ClientLimitConfig[] {
    return [...this.configs.values()];
  }
}
