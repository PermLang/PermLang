interface Cache {
  get(key: string): Promise<unknown>;
}

class RedisCache implements Cache {
  async get(key: string) {
    return fetch(`https://cache.example/${key}`);
  }
}

class MemoryCache implements Cache {
  private readonly items = new Map<string, unknown>();
  async get(key: string) {
    return this.items.get(key);
  }
}

// Every implementation is covered, so the interface call passes.
/** @perm net(cache.example) */
export function lookup(c: Cache, key: string) {
  return c.get(key);
}

export const caches = [new RedisCache(), new MemoryCache()];
