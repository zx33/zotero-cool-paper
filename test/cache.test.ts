import { assert } from "chai";
import {
  applyCacheTTL,
  CACHE_TTL_MS,
  clearPapersCoolCache,
  getCache,
  saveCachePatch,
} from "../src/modules/cache";
import type { CacheEntry } from "../src/modules/types";

const fetchedAt = 1_700_000_000_000;

describe("papers.cool cache policy", function () {
  it("expires metadata and REL before the more expensive KIMI reading", function () {
    const cache = applyCacheTTL(
      fullCache(),
      fetchedAt + CACHE_TTL_MS.metadata + 1,
    );

    assert.isUndefined(cache.metadata);
    assert.isUndefined(cache.related);
    assert.equal(cache.kimiHTML, "KIMI content");
  });

  it("expires KIMI content after its longer TTL", function () {
    const cache = applyCacheTTL(fullCache(), fetchedAt + CACHE_TTL_MS.kimi + 1);

    assert.isUndefined(cache.metadata);
    assert.isUndefined(cache.related);
    assert.isUndefined(cache.kimiHTML);
  });

  it("treats payloads without fetch timestamps as stale", function () {
    const cache = fullCache();
    delete cache.metadataFetchedAt;
    delete cache.kimiFetchedAt;
    delete cache.relatedFetchedAt;

    const fresh = applyCacheTTL(cache, fetchedAt);
    assert.isUndefined(fresh.metadata);
    assert.isUndefined(fresh.related);
    assert.isUndefined(fresh.kimiHTML);
  });

  it("preserves concurrent cache patches and supports clearing", async function () {
    const reference = { branch: "arxiv" as const, key: "cache-policy-test" };
    const now = Date.now();
    await clearPapersCoolCache();

    await Promise.all([
      saveCachePatch(reference, {
        metadata: fullCache().metadata,
        metadataFetchedAt: now,
      }),
      saveCachePatch(reference, {
        kimiHTML: "concurrent KIMI",
        kimiFetchedAt: now,
      }),
      saveCachePatch(reference, {
        related: fullCache().related,
        relatedFetchedAt: now,
      }),
    ]);

    const cache = await getCache(reference);
    assert.equal(cache?.metadata?.title, "Example");
    assert.equal(cache?.kimiHTML, "concurrent KIMI");
    assert.deepEqual(cache?.related?.papers, []);

    await clearPapersCoolCache();
    assert.isUndefined(await getCache(reference));
  });
});

function fullCache(): CacheEntry {
  return {
    cacheKey: "arxiv:2301.12345",
    branch: "arxiv",
    key: "2301.12345",
    metadata: {
      branch: "arxiv",
      key: "2301.12345",
      title: "Example",
      paperURL: "https://papers.cool/arxiv/2301.12345",
    },
    kimiHTML: "KIMI content",
    related: {
      url: "https://papers.cool/arxiv/search?query=example",
      papers: [],
    },
    metadataFetchedAt: fetchedAt,
    kimiFetchedAt: fetchedAt,
    relatedFetchedAt: fetchedAt,
    updatedAt: fetchedAt,
  };
}
