export {
  AlertEngine,
  alertMatches,
  filterAlerts,
  hasOriginUnderFmv,
  underFmvAlertIfAny,
  softFailAlert,
  alertsFromListingDiff,
} from "./alerts.js";

export {
  traderHealthSummary,
  formatHealthHud,
  type PollHealthSource,
  type ProviderHealthRow,
  type TraderHealthSummary,
  type TraderHealthOptions,
} from "./health.js";

/**
 * Listing deep-links (read-only open URL / CLI open hint).
 * No tx / private key / place-order.
 */
export {
  listingOpenUrl,
  formatOpenHint,
  type ListingOpenUrlInput,
} from "./deepLinks.js";

/** Listing age / grey-out after soft-fail (also exported from package root). */
export {
  withLastSeenAt,
  listingAgeMs,
  isStale,
} from "../listingAge.js";

export type {
  AlertKind,
  Alert,
  AlertBase,
  NewListingAlert,
  RepriceAlert,
  ClosedAlert,
  SoftFailAlert,
  UnderFmvAlert,
  AlertScopeRef,
  SoftFailAlertInput,
  AlertsFromSyncExtra,
} from "./types.js";
