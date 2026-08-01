import type { Listing, ProviderWatermark, SyncResult } from "../types.js";

/** Trader-facing alert kinds (decision surface, not capture wire). */
export type AlertKind =
  | "new_listing"
  | "reprice"
  | "closed"
  | "soft_fail"
  | "under_fmv";

export interface AlertBase {
  ts: string;
  kind: AlertKind;
  provider: string;
  /** Query signature for the scope that produced the alert, when known. */
  qsig?: string;
}

export interface NewListingAlert extends AlertBase {
  kind: "new_listing";
  listing: Listing;
}

export interface RepriceAlert extends AlertBase {
  kind: "reprice";
  listing: Listing;
  prevPrice: number;
}

export interface ClosedAlert extends AlertBase {
  kind: "closed";
  id: string;
  /** Last known listing when still in the alert engine map. */
  listing?: Listing;
}

export interface SoftFailAlert extends AlertBase {
  kind: "soft_fail";
  error: string;
  lastSuccessfulPullAt?: string | null;
  lastRowCount?: number;
}

/**
 * Deal alert: listing already has origin-normalized `fmv` and `delta`.
 * Never invented by the library (no external price oracle).
 */
export interface UnderFmvAlert extends AlertBase {
  kind: "under_fmv";
  listing: Listing;
  fmv: number;
  delta: number;
}

export type Alert =
  | NewListingAlert
  | RepriceAlert
  | ClosedAlert
  | SoftFailAlert
  | UnderFmvAlert;

export interface AlertScopeRef {
  provider: string;
  querySignature?: string;
}

export interface SoftFailAlertInput {
  provider: string;
  error: string;
  lastSuccessfulPullAt?: string | null;
  lastRowCount?: number;
  qsig?: string;
  ts?: string;
  watermark?: ProviderWatermark | null;
}

/** Extra flags when applying a SyncResult (soft-fail path). */
export interface AlertsFromSyncExtra {
  softFail?: boolean;
  lastError?: string | null;
  watermark?: ProviderWatermark | null;
  ts?: string;
}

export type { Listing, SyncResult, ProviderWatermark };
