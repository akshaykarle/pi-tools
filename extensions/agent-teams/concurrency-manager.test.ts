import { describe, it, expect, beforeEach } from "vitest";
import { ConcurrencyManager } from "./concurrency-manager.js";

describe("ConcurrencyManager", () => {
  describe("limit=1 (single slot)", () => {
    let cm: ConcurrencyManager;

    beforeEach(() => {
      cm = new ConcurrencyManager(1);
    });

    it("starts with count=0", () => {
      expect(cm.count).toBe(0);
    });

    it("canAcquire() returns true when count < limit", () => {
      expect(cm.canAcquire()).toBe(true);
    });

    it("acquire() increments count to 1", () => {
      cm.acquire();
      expect(cm.count).toBe(1);
    });

    it("canAcquire() returns false when count === limit", () => {
      cm.acquire();
      expect(cm.canAcquire()).toBe(false);
    });

    it("acquire() throws when already at limit", () => {
      cm.acquire();
      expect(() => cm.acquire()).toThrowError("Concurrency limit (1) already reached");
    });

    it("release() decrements count back to 0", () => {
      cm.acquire();
      cm.release();
      expect(cm.count).toBe(0);
    });

    it("canAcquire() returns true again after release", () => {
      cm.acquire();
      cm.release();
      expect(cm.canAcquire()).toBe(true);
    });

    it("release() does not go below 0 when count is already 0", () => {
      cm.release();
      expect(cm.count).toBe(0);
    });

    it("release() is safe to call multiple times when count is 0", () => {
      cm.release();
      cm.release();
      cm.release();
      expect(cm.count).toBe(0);
    });

    it("reset() sets count back to 0", () => {
      cm.acquire();
      expect(cm.count).toBe(1);
      cm.reset();
      expect(cm.count).toBe(0);
    });

    it("reset() on already-zero count is a no-op", () => {
      cm.reset();
      expect(cm.count).toBe(0);
    });

    it("acquire works again after reset", () => {
      cm.acquire();
      cm.reset();
      expect(cm.canAcquire()).toBe(true);
      cm.acquire();
      expect(cm.count).toBe(1);
    });
  });

  describe("limit=3 (multi-slot)", () => {
    let cm: ConcurrencyManager;

    beforeEach(() => {
      cm = new ConcurrencyManager(3);
    });

    it("starts with count=0", () => {
      expect(cm.count).toBe(0);
    });

    it("canAcquire() returns true for the first 3 acquires", () => {
      expect(cm.canAcquire()).toBe(true);
      cm.acquire();
      expect(cm.canAcquire()).toBe(true);
      cm.acquire();
      expect(cm.canAcquire()).toBe(true);
    });

    it("acquire() increments count correctly across 3 slots", () => {
      cm.acquire();
      expect(cm.count).toBe(1);
      cm.acquire();
      expect(cm.count).toBe(2);
      cm.acquire();
      expect(cm.count).toBe(3);
    });

    it("canAcquire() returns false after 3 acquires", () => {
      cm.acquire();
      cm.acquire();
      cm.acquire();
      expect(cm.canAcquire()).toBe(false);
    });

    it("4th acquire() throws when limit=3 is reached", () => {
      cm.acquire();
      cm.acquire();
      cm.acquire();
      expect(() => cm.acquire()).toThrowError("Concurrency limit (3) already reached");
    });

    it("release() allows re-acquire after all slots are taken", () => {
      cm.acquire();
      cm.acquire();
      cm.acquire();
      expect(cm.canAcquire()).toBe(false);

      cm.release();
      expect(cm.canAcquire()).toBe(true);
      expect(cm.count).toBe(2);

      cm.acquire(); // should not throw
      expect(cm.count).toBe(3);
    });

    it("release() decrements count correctly", () => {
      cm.acquire();
      cm.acquire();
      cm.acquire();
      cm.release();
      expect(cm.count).toBe(2);
      cm.release();
      expect(cm.count).toBe(1);
      cm.release();
      expect(cm.count).toBe(0);
    });

    it("release() does not go below 0", () => {
      cm.acquire();
      cm.release();
      cm.release(); // extra release — count must stay at 0
      expect(cm.count).toBe(0);
    });

    it("reset() sets count back to 0 from mid-state", () => {
      cm.acquire();
      cm.acquire();
      expect(cm.count).toBe(2);
      cm.reset();
      expect(cm.count).toBe(0);
    });

    it("after reset(), full 3 slots are available again", () => {
      cm.acquire();
      cm.acquire();
      cm.acquire();
      cm.reset();

      expect(cm.canAcquire()).toBe(true);
      cm.acquire();
      cm.acquire();
      cm.acquire();
      expect(cm.count).toBe(3);
      expect(() => cm.acquire()).toThrowError("Concurrency limit (3) already reached");
    });
  });

  describe("count getter", () => {
    it("reflects state at all times through a sequence of operations", () => {
      const cm = new ConcurrencyManager(2);
      expect(cm.count).toBe(0);

      cm.acquire();
      expect(cm.count).toBe(1);

      cm.acquire();
      expect(cm.count).toBe(2);

      cm.release();
      expect(cm.count).toBe(1);

      cm.reset();
      expect(cm.count).toBe(0);

      cm.acquire();
      expect(cm.count).toBe(1);
    });
  });

  describe("limit property", () => {
    it("exposes the configured limit as a readonly property", () => {
      const cm = new ConcurrencyManager(5);
      expect(cm.limit).toBe(5);
    });
  });

  describe("error messages", () => {
    it("throws with correct limit value in the message", () => {
      const cm = new ConcurrencyManager(7);
      for (let i = 0; i < 7; i++) cm.acquire();
      expect(() => cm.acquire()).toThrowError("Concurrency limit (7) already reached");
    });
  });
});
