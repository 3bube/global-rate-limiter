import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ClientLimitConfig, ClientDirectory } from '../types';
import { clientsFileSchema } from '../schemas';

/**
 * In-memory client -> limit registry, seeded from clients.json.
 *
 * The file is validated on load (a typo like a negative limit fails fast at
 * boot instead of silently misconfiguring a client), and can be re-read at
 * runtime via reload() — docker-compose bind-mounts clients.json into the
 * container precisely so limits can change without an image rebuild.
 */
export class ClientRegistry implements ClientDirectory {
  private configs = new Map<string, ClientLimitConfig>();

  constructor(private readonly configPath: string = path.join(__dirname, 'clients.json')) {
    this.reload();
  }

  /** Re-reads and validates the config file. Returns the client count. */
  reload(): number {
    const raw = readFileSync(this.configPath, 'utf8');
    const parsed = clientsFileSchema.parse(JSON.parse(raw));
    const next = new Map<string, ClientLimitConfig>();
    for (const entry of parsed) {
      next.set(entry.clientId, entry);
    }
    // Swap atomically only after the whole file parsed, so a broken edit
    // can never leave the registry half-updated.
    this.configs = next;
    return next.size;
  }

  async getConfig(clientId: string): Promise<ClientLimitConfig | undefined> {
    return this.configs.get(clientId);
  }

  list(): ClientLimitConfig[] {
    return [...this.configs.values()];
  }
}
