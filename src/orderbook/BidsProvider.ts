import type { BidOrder, BidStreamWire } from "./types.js";

export interface BidsPullQuery {
  instrumentKey?: string;
  limit?: number;
  offset?: number;
  /** Optional marketplace filters (provider-specific honor). */
  tcg?: string;
  grader?: string;
  grade?: string;
  priceMin?: number;
  priceMax?: number;
  sort?: string;
  platform?: string;
  /** Multi-page harvest when supported. */
  pages?: number;
  fixturePath?: string;
  offline?: boolean;
}

/**
 * Modular bids source. traded.gg has no public unauthenticated bid book;
 * implement fixture / loan / external market adapters here.
 */
export interface BidsProvider {
  readonly id: string;
  pull(query?: BidsPullQuery): Promise<BidOrder[]>;
  /** Optional streaming; null if provider is poll-only. */
  openStream?(handlers: {
    onEvent: (wire: BidStreamWire) => void;
    onStatus?: (status: string) => void;
    onError?: (err: Error) => void;
    signal?: AbortSignal;
  }): Promise<{ stop: () => void }>;
}
