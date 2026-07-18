import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClientRegistry } from '../../src/clients/clientRegistry';

describe('ClientRegistry', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clients-'));
    file = path.join(dir, 'clients.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads and serves configs from the file', async () => {
    writeFileSync(file, JSON.stringify([{ clientId: 'a', limit: 100, windowSeconds: 60 }]));
    const registry = new ClientRegistry(file);

    expect(await registry.getConfig('a')).toEqual({ clientId: 'a', limit: 100, windowSeconds: 60 });
    expect(await registry.getConfig('nope')).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects an invalid config file at load time instead of serving garbage', () => {
    writeFileSync(file, JSON.stringify([{ clientId: 'a', limit: -5, windowSeconds: 60 }]));
    expect(() => new ClientRegistry(file)).toThrow();
  });

  it('reload() picks up file changes without recreating the registry', async () => {
    writeFileSync(file, JSON.stringify([{ clientId: 'a', limit: 100, windowSeconds: 60 }]));
    const registry = new ClientRegistry(file);

    writeFileSync(
      file,
      JSON.stringify([
        { clientId: 'a', limit: 250, windowSeconds: 60 },
        { clientId: 'b', limit: 10, windowSeconds: 1 },
      ]),
    );
    expect(registry.reload()).toBe(2);
    expect((await registry.getConfig('a'))?.limit).toBe(250);
    expect((await registry.getConfig('b'))?.limit).toBe(10);
  });

  it('keeps serving the previous configs when a reload fails to parse', async () => {
    writeFileSync(file, JSON.stringify([{ clientId: 'a', limit: 100, windowSeconds: 60 }]));
    const registry = new ClientRegistry(file);

    writeFileSync(file, 'not json at all');
    expect(() => registry.reload()).toThrow();
    expect((await registry.getConfig('a'))?.limit).toBe(100);
  });
});
