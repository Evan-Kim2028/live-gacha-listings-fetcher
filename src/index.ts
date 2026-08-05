export type {
  CanonicalCard,
  Listing,
  ListingEvent,
  ProviderWatermark,
  SnapshotMeta,
  SyncResult,
} from "./types.js";

export {
  listingId,
  parseListingId,
  sameListing,
  type IdentityParts,
} from "./identity.js";

/**
 * Public listing deep-links (read-only).
 * `formatOpenCommand` opens the URL in a browser. No buy/list/tx.
 */
export {
  ccListingUrl,
  meListingUrl,
  phygitalsListingUrl,
  courtyardListingUrl,
  renaissListingUrl,
  dyliListingUrl,
  originProvidedUrl,
  formatOpenCommand,
} from "./externalUrl.js";

export { ListingStore, trimListing, type UpsertStats } from "./store.js";
export {
  withLastSeenAt,
  listingAgeMs,
  isStale,
} from "./listingAge.js";
export {
  syncOnce,
  syncIncremental,
  pullListings,
  type SyncOptions,
} from "./sync.js";
export { querySignature, scopeKey } from "./querySignature.js";

/** Poll-diff / SSE delist lifecycle (prunedIds → orderbook clear + capture). */
export {
  applyDelistsFromSync,
  type DelistReason,
  type SoldReason,
  type DelistSource,
  type DelistEvent,
} from "./lifecycle/index.js";
export type {
  ListingsProvider,
  PullPage,
  PullQuery,
} from "./providers/types.js";

export {
  CollectorCryptProvider,
  CollectorCryptBidsProvider,
  createCollectorCryptProvider,
  createCollectorCryptBidsProvider,
  normalizeCcCard,
  normalizeCcOffer,
  normalizeCcOffers,
  countOfferRefs,
  bidderFromCcOffer,
  fetchCcCardOffers,
  buildMarketplaceUrl,
  pageFromQuery,
  resolveBlockchainParam,
  instrumentKeyFromCcCard,
  CC_BLOCKCHAINS,
  type CollectorCryptOptions,
  type CollectorCryptBidsOptions,
  type CollectorCryptBidsQuery,
  type CcCard,
  type CcOfferRef,
  type CcPullMeta,
  type CcBidsPullMeta,
  type CcBlockchain,
} from "./providers/collectorcrypt.js";

export {
  MagicEdenProvider,
  MagicEdenBidsProvider,
  createMagicEdenProvider,
  createMagicEdenBidsProvider,
  normalizeMeListing,
  mePriceToSol,
  solToUsd,
  fetchSolPriceUsd,
  clearSolPriceCache,
  DEFAULT_SAMPLE_MINTS,
  ME_MAX_PAGE_LIMIT,
  ME_DEFAULT_MAX_PAGES,
  ME_BOOTSTRAP_MAX_PAGES,
  type MagicEdenOptions,
  type MagicEdenBidsOptions,
  type MeBidsPullMeta,
  type MeListingsPullMeta,
  type MeListing,
} from "./providers/magiceden.js";

export {
  CourtyardProvider,
  CourtyardBidsProvider,
  createCourtyardProvider,
  createCourtyardBidsProvider,
  normalizeCourtyardRow,
  normalizeCourtyardAlgoliaHit,
  normalizeCourtyardAssetBids,
  fetchCourtyardOrderbookConfig,
  instrumentKeyFromCyAsset,
  COURTYARD_ONCHAIN,
  type CourtyardOptions,
  type CourtyardBidsOptions,
  type CourtyardOrderbookConfig,
  type CyBidsBudgetMeta,
  type CyAssetOrderbook,
  type CyOfferData,
  type CyOrderbookBidRow,
} from "./providers/courtyard.js";

export {
  LongtailProvider,
  createBeezieProvider,
  createRenaissProvider,
  createDyliProvider,
  createPhygitalsProvider,
  buildPhygitalsParamAttempts,
  normalizeLongtailRow,
  normalizeBeezieRow,
  normalizeRenaissRow,
  normalizeDyliRow,
  normalizePhygitalsRow,
  phygitalsPriceToUsd,
  detectAddressChain,
  detectBeezieChain,
  BEEZIE_PAGE_SIZE,
  PHYGITALS_MAX_ITEMS_PER_PAGE,
  PHYGITALS_DEFAULT_PAGE_SIZE,
  LONGTAIL_MAX_PAGES_CAP,
  LONGTAIL_DEFAULT_MAX_PAGES,
  type LongtailOptions,
  type LongtailId,
  type BeezieChain,
  type BeeziePullMeta,
} from "./providers/longtail.js";

export {
  MultiSourceRadar,
  type MultiSourceRadarOptions,
  type MultiSourceListOptions,
  type MultiSourceSyncResult,
  type BootstrapAllOptions,
} from "./aggregate/MultiSourceRadar.js";

export {
  saveBook,
  loadBook,
  bookExists,
  bookPaths,
  bookScopeId,
  resolveBookDir,
  decisionFilter,
  DEFAULT_BOOKS_ROOT,
  DEFAULT_BOOK_MAX_AGE_MS,
  type BookMeta,
  type BookProviderMeta,
  type SaveBookOptions,
  type LoadBookOptions,
  type LoadBookResult,
} from "./book.js";

export {
  PollEngine,
  PollScheduler,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_PROVIDER_MIN_INTERVAL_MS,
  minConfiguredIntervalMs,
  type PollEngineOptions,
  type PollSchedulerOptions,
  type MinIntervalMs,
  type ProviderPollStats,
  type PollStatsSnapshot,
} from "./aggregate/PollEngine.js";

export {
  fetchWithRetry,
  computeRetryDelayMs,
  isRetryableStatus,
  isNotModifiedStatus,
  getResponseEtag,
  withIfNoneMatch,
  recordPull,
  getMetrics,
  getProviderMetrics,
  resetMetrics,
  AdaptiveConcurrency,
  mapLimitAdaptive,
  paginateConcurrent,
  isThrottleError,
  DEFAULT_PAGE_CONCURRENCY,
  type FetchWithRetryOptions,
  type ProviderMetricCounters,
  type MetricsSnapshot,
  type AdaptiveConcurrencyOptions,
  type MapLimitAdaptiveStats,
  type PaginateConcurrentResult,
} from "./http/index.js";

export {
  contentFingerprint,
  type FingerprintRow,
} from "./contentFingerprint.js";

export {
  FixtureProvider,
  createFixtureProvider,
  type FixtureProviderOptions,
  type FixtureRow,
} from "./providers/fixture.js";

export {
  registerProvider,
  getProvider,
  listProviders,
  registerBuiltins,
  createDefaultProviders,
  createSolanaProviders,
  DEFAULT_NATIVE_PROVIDER_IDS,
  NATIVE_PROVIDER_IDS,
  SOLANA_PROVIDER_IDS,
  type ProviderFactory,
  type DefaultProvidersOptions,
  type SolanaProvidersOptions,
} from "./providers/registry.js";

export { listingMatchesFilter, filterListings } from "./filter.js";

export {
  listingMatchesWatchlist,
  isWatchlistEmpty,
  mergeWatchlists,
  parseWatchlistString,
  loadWatchlistFile,
  watchlistSignature,
  type Watchlist,
} from "./watchlist.js";

export {
  AlertEngine,
  alertMatches,
  filterAlerts,
  hasOriginUnderFmv,
  underFmvAlertIfAny,
  softFailAlert,
  alertsFromListingDiff,
  traderHealthSummary,
  formatHealthHud,
  listingOpenUrl,
  formatOpenHint,
  type AlertKind,
  type Alert,
  type AlertBase,
  type NewListingAlert,
  type RepriceAlert,
  type ClosedAlert,
  type SoftFailAlert,
  type UnderFmvAlert,
  type AlertScopeRef,
  type SoftFailAlertInput,
  type AlertsFromSyncExtra,
  type PollHealthSource,
  type ProviderHealthRow,
  type TraderHealthSummary,
  type TraderHealthOptions,
  type ListingOpenUrlInput,
} from "./trader/index.js";

export {
  RunCapture,
  ListingChangeLog,
  type ListingDeltaFields,
  type ListingChangeKind,
  type ListingChangeEvent,
  type ListingNewEvent,
  type ListingRepriceEvent,
  type ListingClosedEvent,
  type SoftFailEvent,
  type ScopeRef,
  type HealthRecord,
  type BookChangeRecord,
  type BookChangeInput,
  type OnSyncExtra,
  type SoldRecord,
  type RunCaptureMode,
  type RunCaptureOptions,
  type SnapshotFileBody,
  type ListingChangeLogOptions,
} from "./capture/index.js";

export {
  OrderbookStore,
  OrderbookFeed,
  type OrderbookFeedOptions,
  FixtureBidsProvider,
  listingToAsk,
  listingsToAsks,
  instrumentKeyFromListing,
  TtlCache,
  bidCacheKey,
  mapLimit,
  mapWithBidBudget,
  resolveBidBudgetOptions,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TTL_MS,
  type BidBudgetOptions,
  type BidBudgetRunResult,
  type MapWithBidBudgetOptions,
  type BidsProvider,
  type BidsPullQuery,
  type BidOrder,
  type AskOrder,
  type InstrumentBook,
  type InstrumentSoldEvent,
  type OrderbookEvent,
  type BidStreamWire,
} from "./orderbook/index.js";

/**
 * Optional FMV enrichment after normalize. Core sync stays origin-only.
 * No default network oracle; use FixtureFmvProvider in tests or host adapters.
 */
export {
  applyFmvPlugins,
  deltaFromListing,
  deltaFromPriceAndFmv,
  isUsdEquivalentCurrency,
  FixtureFmvProvider,
  type FmvProvider,
  type FixtureFmvLookup,
} from "./fmv/index.js";
