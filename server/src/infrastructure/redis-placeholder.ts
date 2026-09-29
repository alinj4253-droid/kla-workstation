export class RedisPlaceholder {
  readonly configured: boolean;

  constructor(url: string) {
    this.configured = Boolean(url);
  }

  get connected(): false { return false; }
}
