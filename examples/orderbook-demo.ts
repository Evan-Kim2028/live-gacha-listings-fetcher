/**
 * Orderbook demo: filtered asks from listings + fixture bids.
 * npx tsx examples/orderbook-demo.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ListingStore,
  OrderbookFeed,
  FixtureBidsProvider,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const listingStore = new ListingStore();
  const feed = new OrderbookFeed({
    listingStore,
    listingFilter: { tcg: "pokemon" },
    offline: true,
    listingsFeed: {
      store: listingStore,
      offline: true,
      snapshotQuery: {
        fixturePath: join(root, "fixtures", "radar-sample.json"),
        tcg: "pokemon",
        limit: 20,
      },
    },
    bidsProvider: new FixtureBidsProvider(
      join(root, "fixtures", "bids-sample.json"),
    ),
  });
  await feed.start();
  const book = feed.getOrderbookStore();
  const keys = book.instrumentKeys().slice(0, 5);
  const sample = keys.map((k) => {
    const b = book.book(k);
    return {
      instrumentKey: k,
      bestBid: b.bestBid,
      bestAsk: b.bestAsk,
      spread: b.spread,
      bidLevels: b.bids.length,
      askLevels: b.asks.length,
    };
  });
  console.log(
    JSON.stringify(
      {
        ok: book.allAsks().length > 0 && book.allBids().length > 0,
        asks: book.allAsks().length,
        bids: book.allBids().length,
        instruments: book.instrumentKeys().length,
        sample,
      },
      null,
      2,
    ),
  );
  feed.stop();
  if (book.allAsks().length < 1) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
