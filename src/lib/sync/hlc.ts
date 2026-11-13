/**
 * Hybrid logical clock. Stamps sort lexicographically in causal order and stay
 * monotonic even if the device's wall clock jumps backwards. Format:
 *   <wall ms, base36, 11 chars>:<counter, base36, 5 chars>:<nodeId>
 * The nodeId suffix makes stamps from different devices unique, so merges are
 * deterministic.
 */
export class HybridLogicalClock {
  private wall = 0;
  private counter = 0;

  constructor(
    private readonly nodeId: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[A-Za-z0-9_-]+$/.test(nodeId)) throw new Error('Invalid HLC node id');
  }

  tick(): string {
    const physical = this.now();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return this.format();
  }

  /** Advance past a stamp seen from another device. */
  receive(stamp: string): void {
    const parsed = parseStamp(stamp);
    if (!parsed) return;
    const physical = this.now();
    const maxWall = Math.max(this.wall, parsed.wall, physical);
    if (maxWall === this.wall && maxWall === parsed.wall) {
      this.counter = Math.max(this.counter, parsed.counter) + 1;
    } else if (maxWall === this.wall) {
      this.counter++;
    } else if (maxWall === parsed.wall) {
      this.counter = parsed.counter + 1;
    } else {
      this.counter = 0;
    }
    this.wall = maxWall;
  }

  private format(): string {
    return `${this.wall.toString(36).padStart(11, '0')}:${this.counter.toString(36).padStart(5, '0')}:${this.nodeId}`;
  }
}

function parseStamp(stamp: string): { wall: number; counter: number } | null {
  const [wall, counter] = stamp.split(':');
  if (!wall || !counter) return null;
  const w = parseInt(wall, 36);
  const c = parseInt(counter, 36);
  return Number.isFinite(w) && Number.isFinite(c) ? { wall: w, counter: c } : null;
}
