import { randomBytes } from "node:crypto";

export interface PendingReview {
  /** Fingerprint of exactly what the user saw. */
  fingerprint: string;
  /** Epoch milliseconds after which place_order refuses the code. */
  until: number;
}

/**
 * Reviews awaiting the user's yes: confirmationCode -> what they saw. Kept by
 * the runtime, not by one MCP server, because an app may connect a new server
 * per request (local HTTP) or per connection, and the Order press must find the
 * review made a moment earlier. Memory only: a restart asks for a new review.
 */
export class OrderReviews {
  /** Mixed into every fingerprint, so a fingerprint can't be guessed from the order alone. */
  readonly secret = randomBytes(16).toString("hex");
  private readonly pending = new Map<string, PendingReview>();

  add(review: PendingReview, now: number): string {
    for (const [code, r] of this.pending) if (r.until < now) this.pending.delete(code);
    const code = randomBytes(6).toString("hex");
    this.pending.set(code, review);
    return code;
  }

  /** Returns the review and forgets it at once: a double-pressed Order button must not place two orders. */
  take(code: string): PendingReview | undefined {
    const review = this.pending.get(code);
    this.pending.delete(code);
    return review;
  }

  /** Forgets every review (on log out: they were made for that account). */
  clear(): void {
    this.pending.clear();
  }
}
