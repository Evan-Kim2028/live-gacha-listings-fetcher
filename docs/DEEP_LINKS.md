# Public listing deep-links (`externalUrl`)

**Scope:** read-only library. `Listing.externalUrl` and open helpers open the origin marketplace public listing page in a browser. No buy/sell tx builders, no wallet signing, no marketplace write APIs, no private keys, no place-order.

**Low-level helpers** in [`src/externalUrl.ts`](../src/externalUrl.ts): `ccListingUrl`, `meListingUrl`, `phygitalsListingUrl`, `courtyardListingUrl`, `renaissListingUrl`, `dyliListingUrl`, `originProvidedUrl`, `formatOpenCommand`.

**Trader helpers** in [`src/trader/deepLinks.ts`](../src/trader/deepLinks.ts): `listingOpenUrl(listing)`, `formatOpenHint(listing)`.

**Model field:** `Listing.externalUrl: string | null` ([`src/types.ts`](../src/types.ts)).

## `listingOpenUrl` / `formatOpenHint`

```ts
import { listingOpenUrl, formatOpenHint } from "traded-listings";

// Use listing.externalUrl when http(s); otherwise rebuild from provider/platform + ids.
const url = listingOpenUrl(listing); // string | null

// CLI/shell open hint (platform-aware via formatOpenCommand):
//   darwin → open 'https://…'
//   linux  → xdg-open 'https://…'
//   win32  → cmd /c start "" 'https://…'
const hint = formatOpenHint(listing); // string | null
```

| Step | Behavior |
|------|----------|
| 1 | Use `listing.externalUrl` if trimmed value matches `^https?://` |
| 2 | Else construct from `platform` (then `provider`): cc/collectorcrypt → `ccListingUrl(tokenId ?? nativeId)`; me/magiceden → mint page; courtyard / phygitals / renaiss / dyli → documented public paths |
| 3 | Else `null` (beezie, fixture, unknown without origin URL) |

**CLI:** `traded-listings radar … --urls` prints `id\topenUrl` lines after the radar JSON (deep-link only).

## Audit table (provider → URL pattern → set? → null when)

| Provider / platform | Normalize path | URL pattern | Currently set? | Null only when |
|---------------------|----------------|-------------|----------------|----------------|
| **collectorcrypt** (`cc`) | `normalizeCcCard` → `ccListingUrl(nftAddress ?? card.id)` | `https://collectorcrypt.com/cards/{nftAddress\|id}` | **Yes** (mint preferred; catalog id fallback) | both mint and catalog id missing |
| **magiceden** (`me`) | `normalizeMeListing` → origin `token.externalUrl` **or** `meListingUrl(mint)` | Prefer `token.externalUrl` (http/s); fallback `https://magiceden.io/item-details/{mint}` | **Yes** when mint or origin URL present | both mint empty and no valid origin URL |
| **courtyard** | `normalizeCourtyardAlgoliaHit` / `normalizeCourtyardRow` → origin **or** `courtyardListingUrl(tokenId)` | Prefer origin http(s); else `https://courtyard.io/asset/{tokenId}` | **Yes** when `tokenId` present | token id missing (row dropped earlier if empty) |
| **phygitals** (longtail) | `normalizePhygitalsRow` → `phygitalsListingUrl(slug ?? nativeId)` | `https://www.phygitals.com/card/{slug\|address}` | **Yes** (slug preferred, mint/address fallback) | never for listed rows with id |
| **renaiss** (longtail) | `normalizeRenaissRow` → origin **or** `renaissListingUrl(tokenId)` | Prefer origin; else `https://www.renaiss.xyz/card/{tokenId}` (on-chain token id, not UUID `id`) | **Yes** when `tokenId` or origin URL present | no `tokenId` and origin omits URL |
| **dyli** (longtail) | `normalizeDyliRow` → origin **or** `dyliListingUrl(id)` | Prefer origin; else `https://www.dyli.io/p/{id}` (Next `/p/[slug]`) | **Yes** when product `id` present | never for rows that normalize (id required) |
| **beezie** (longtail) | `normalizeBeezieRow` → `originProvidedUrl(row)` only | No library construct from `id`/`tokenId` | **Only if origin supplies URL** | **Documented gap:** Beezie SPA has no stable public item path verified from dropItem ids (marketplace category pages only); leave `null` when origin omits URL fields |
| **longtail generic** | `normalizeLongtailRow` fallback → `originProvidedUrl(row)` | Same field scan as above | **Only if origin supplies URL** | unknown catalog; no invented paths |
| **fixture** | `normalizeFixtureRow` → `row.external_url ?? null` | Whatever the fixture JSON puts in `external_url` | **Pass-through only** | fixtures must include URL if tests/UI need one |

## `originProvidedUrl` field order

Used by courtyard / beezie / renaiss / dyli / generic longtail (prefer origin URL before construct where a helper exists):

1. `external_url`
2. `externalUrl`
3. `url`
4. `href`

Only values matching `^https?://` (trimmed) are accepted. Relative paths and non-URL strings become `null`.

## Shell open helper

```ts
import { formatOpenCommand, listingOpenUrl, formatOpenHint } from "traded-listings";
// formatOpenCommand(url) → `xdg-open '…'` | `open '…'` | `cmd /c start "" '…'`
// formatOpenHint(listing) === formatOpenCommand(listingOpenUrl(listing))
// Returns null when URL missing or not http(s). Never signs or submits txs.
```

## Gaps (construct vs pass-through)

| Constructed by lib (mint/token/slug/id) | Pass-through only (null without origin URL field) |
|-----------------------------------------|-----------------------------------------------------|
| collectorcrypt, magiceden, courtyard, phygitals, renaiss, dyli | **beezie**, fixture, longtail generic |

**Beezie null policy:** live dropItem rows expose numeric `id`/`tokenId`, but the public site only exposes category browse (`/marketplace/pokemon`, etc.). Probed item paths (`/item/{id}`, `/nft/{tokenId}`, …) 404. Until Beezie documents a stable item deep-link, `externalUrl` stays `null` unless the origin row includes an http(s) URL field.
