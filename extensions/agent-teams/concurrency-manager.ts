// Agent Teams — concurrency slot manager.
//
// Single Responsibility: track a count of in-use slots against a fixed upper-bound limit.
// No I/O, no side-effects — purely in-memory arithmetic.

/**
 * Tracks how many concurrent slots are in use against a fixed upper-bound limit.
 *
 * Designed for the agent-teams concurrency gate:
 *   - The limit is the `maxConcurrency` value from the active team's config.
 *   - Each "slot" corresponds to one team instance (not one agent process).
 *   - Multiple agents within the same instance share the slot.
 */
export class ConcurrencyManager {
  private _count = 0;

  constructor(readonly limit: number) {}

  /** True when another slot can be acquired without exceeding `limit`. */
  canAcquire(): boolean {
    return this._count < this.limit;
  }

  /**
   * Claim a slot.
   * @throws if already at `limit` — callers must check `canAcquire()` first.
   */
  acquire(): void {
    if (!this.canAcquire()) {
      throw new Error(`Concurrency limit (${this.limit}) already reached`);
    }
    this._count++;
  }

  /** Release a previously acquired slot. Count never goes below 0. */
  release(): void {
    if (this._count > 0) this._count--;
  }

  /** Number of slots currently in use. */
  get count(): number {
    return this._count;
  }

  /** Reset count to zero (used on team switch / run reset). */
  reset(): void {
    this._count = 0;
  }
}
