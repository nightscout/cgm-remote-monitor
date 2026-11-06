'use strict';

// Short-lived computed profile values are references, not cloned documents.
// FIFO eviction bounds retained values; a miss recomputes from profile data.
// The default accommodates a 31-day minute-resolution profile working set.
class ReferenceCache {
  constructor(maxEntries = 524288) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid cache capacity');
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.timer = null;
    this.nextExpiry = Infinity;
  }

  put(key, value, ttl) {
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('Invalid cache lifetime');
    const expires = Date.now() + ttl;
    const deadline = performance.now() + ttl;
    this.entries.delete(key);
    if (this.entries.size === this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, {value, expires, deadline});
    this.arm(deadline);
    return value;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Match reads at the exact boundary before an expiry timer is dispatched.
    if (entry.expires >= Date.now()) return entry.value;
    this.entries.delete(key);
    if (!this.entries.size) this.clear();
    return null;
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextExpiry = Infinity;
    this.entries.clear();
  }

  arm(deadline) {
    if (this.timer !== null && deadline >= this.nextExpiry) return;
    clearTimeout(this.timer);
    this.nextExpiry = deadline;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextExpiry = Infinity;
      const now = performance.now();
      let next = Infinity;
      for (const [key, entry] of this.entries) {
        if (entry.deadline <= now) this.entries.delete(key);
        else next = Math.min(next, entry.deadline);
      }
      if (Number.isFinite(next)) this.arm(next);
    }, Math.max(0, Math.ceil(deadline - performance.now())));
    this.timer.unref?.();
  }
}

module.exports = ReferenceCache;
