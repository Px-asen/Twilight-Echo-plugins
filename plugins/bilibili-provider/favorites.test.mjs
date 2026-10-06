import assert from "node:assert/strict";
import test from "node:test";
import { activate, biliJson, deactivate } from "./index.mjs";

test("opening a 3000-video folder loads one page, with no hidden prefetch or page cap", async (t) => {
  const { provider, calls } = await harness(t, (url) => {
    assert.equal(url.pathname, "/x/v3/fav/resource/list");
    assert.equal(url.searchParams.get("ps"), "20");
    const pn = Number(url.searchParams.get("pn"));
    const response = page(
      Array.from({ length: 20 }, (_, i) => media((pn - 1) * 20 + i + 1)),
      pn < 150,
    );
    response.data.info.media_count = 3000;
    return json(response);
  });
  const first = await provider.fetchPlaylistTracksPage("123");
  assert.equal(first.tracks.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.total, null);
  assert.equal(first.hasMore, true);
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/resource/list")).length,
    1,
  );
  const last = await provider.fetchPlaylistTracksPage("123", 2980, 20);
  assert.equal(last.tracks.at(-1).id, "bili:BV3000:3000");
  assert.equal(last.hasMore, false);
  assert.deepEqual(
    calls
      .filter((url) => url.pathname.endsWith("/resource/list"))
      .map((url) => url.searchParams.get("pn")),
    ["1", "150"],
  );
});

test("a 250-video folder is read completely one requested page at a time", async (t) => {
  const { provider, calls } = await harness(t, (url) => {
    const pn = Number(url.searchParams.get("pn"));
    const start = (pn - 1) * 20;
    return json(
      page(
        Array.from({ length: Math.min(20, 250 - start) }, (_, i) =>
          media(start + i + 1),
        ),
        pn < 13,
      ),
    );
  });
  let offset = 0;
  const tracks = [];
  for (let i = 0; i < 13; i++) {
    const result = await provider.fetchPlaylistTracksPage("123", offset);
    tracks.push(...result.tracks);
    offset = result.nextOffset;
    assert.equal(result.hasMore, i < 12);
    assert.equal(
      calls.filter((url) => url.pathname.endsWith("/resource/list")).length,
      i + 1,
    );
  }
  assert.deepEqual(
    tracks.map((track) => track.id),
    Array.from({ length: 250 }, (_, i) => `bili:BV${i + 1}:${i + 1}`),
  );
});

test("filtered and multi-part videos advance by source page, not returned track count", async (t) => {
  const { provider } = await harness(t, (url) => {
    if (url.pathname.endsWith("/view"))
      return json({
        code: 0,
        data: {
          pages: [
            { cid: 11, part: "A" },
            { cid: 12, part: "B" },
          ],
        },
      });
    const pn = Number(url.searchParams.get("pn"));
    if (pn === 1) return json(page([{ ...media(1), attr: 1 }], true));
    const multi = media(2);
    delete multi.ugc;
    return json(page([multi, media(3)]));
  });
  const first = await provider.fetchPlaylistTracksPage("123");
  assert.deepEqual(first.tracks, []);
  assert.equal(first.hasMore, true);
  const second = await provider.fetchPlaylistTracksPage(
    "123",
    first.nextOffset,
  );
  assert.deepEqual(
    second.tracks.map((track) => track.id),
    ["bili:BV2:11", "bili:BV2:12", "bili:BV3:3"],
  );
  assert.equal(second.nextOffset, 40);
});

test("shares and caches page loads, and refresh invalidates later pages only in that folder", async (t) => {
  let generation = 1;
  const { provider, calls } = await harness(t, async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return json(
      page(
        [media(generation * 100 + Number(url.searchParams.get("pn")))],
        true,
      ),
    );
  });
  await Promise.all([
    provider.fetchPlaylistTracksPage("123", 0, 20, true),
    provider.fetchPlaylistTracksPage("123", 0, 20, true),
  ]);
  await provider.fetchPlaylistTracksPage("123");
  await provider.fetchPlaylistTracksPage("123", 20);
  await provider.fetchPlaylistTracksPage("456", 20);
  generation = 2;
  await provider.fetchPlaylistTracksPage("123", 0, 20, true);
  assert.equal(
    (await provider.fetchPlaylistTracksPage("123", 20)).tracks[0].id,
    "bili:BV202:202",
  );
  assert.equal(
    (await provider.fetchPlaylistTracksPage("456", 20)).tracks[0].id,
    "bili:BV102:102",
  );
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/resource/list")).length,
    5,
  );
});

test("a rejected page is not cached or retried automatically and cannot erase a successful page", async (t) => {
  let rejectPage = true;
  const { provider, calls, warnings } = await harness(t, (url) => {
    const pn = Number(url.searchParams.get("pn"));
    if (pn === 2 && rejectPage)
      return json({ code: -352, message: "请求被拒绝" });
    return json(page([media(pn)], pn === 1));
  });
  const first = await provider.fetchPlaylistTracksPage("123");
  await assert.rejects(
    provider.fetchPlaylistTracksPage("123", first.nextOffset),
    /-352/,
  );
  assert.deepEqual(await provider.fetchPlaylistTracksPage("123"), first);
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/resource/list")).length,
    2,
  );
  assert.ok(
    warnings.some(
      (message) => message.includes("page 2") && message.includes("-352"),
    ),
  );
  rejectPage = false;
  assert.equal(
    (await provider.fetchPlaylistTracksPage("123", first.nextOffset)).tracks[0]
      .id,
    "bili:BV2:2",
  );
});

test("video-detail API rejections do not masquerade as an empty page", async (t) => {
  const { provider } = await harness(t, (url) => {
    if (url.pathname.endsWith("/view"))
      return json({ code: -352, message: "请求被拒绝" });
    const entry = media(1);
    delete entry.ugc;
    return json(page([entry]));
  });
  await assert.rejects(provider.fetchPlaylistTracksPage("123"), /-352/);
});

test("page caches stay isolated between sessions and clear at logout", async (t) => {
  const { provider, values, calls } = await harness(t, () =>
    json(page([media(1)])),
  );
  await provider.fetchPlaylistTracksPage("123");
  values.set("auth", { cookie: "SESSDATA=another-session; DedeUserID=42" });
  await provider.fetchPlaylistTracksPage("123");
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/resource/list")).length,
    2,
  );
  await provider.logout();
  await assert.rejects(provider.fetchPlaylistTracksPage("123"), /请先登录/);
});

test("a late page response from before refresh cannot repopulate the new folder cache", async (t) => {
  let resolveOld;
  let hold = true;
  let secondPageCalls = 0;
  const { provider } = await harness(t, (url) => {
    if (url.searchParams.get("pn") === "2") {
      secondPageCalls++;
      if (hold)
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      return json(page([media(22)]));
    }
    return json(page([media(1)], true));
  });
  await provider.fetchPlaylistTracksPage("123");
  const old = provider.fetchPlaylistTracksPage("123", 20);
  while (!resolveOld) await new Promise((resolve) => setImmediate(resolve));
  await provider.fetchPlaylistTracksPage("123", 0, 20, true);
  hold = false;
  resolveOld(json(page([media(2)])));
  await old;
  assert.equal(
    (await provider.fetchPlaylistTracksPage("123", 20)).tracks[0].id,
    "bili:BV22:22",
  );
  assert.equal(secondPageCalls, 2);
});

const cookie = "SESSDATA=test-session; DedeUserID=42; buvid3=test-device";
const media = (id) => ({
  bvid: `BV${id}`,
  type: 2,
  attr: 0,
  title: `Video ${id}`,
  duration: 60,
  ugc: { first_cid: id },
  upper: { name: "Creator" },
});
const page = (medias, hasMore = false) => ({
  code: 0,
  data: { info: { title: "Favorites" }, medias, has_more: hasMore },
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

async function harness(t, handler, navHandler) {
  await deactivate();
  const values = new Map([["auth", { cookie }]]);
  const calls = [];
  const warnings = [];
  let provider;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/x/web-interface/nav") {
      if (navHandler) return navHandler(url, options);
      return json({ code: 0, data: { isLogin: true, mid: 42, uname: "User" } });
    }
    if (url.pathname === "/x/space/myinfo")
      return json({ code: 0, data: { mid: 42 } });
    return handler(url, options);
  };
  t.after(async () => {
    await deactivate();
    globalThis.fetch = originalFetch;
  });
  await activate({
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    },
    settings: {
      get: async (key) => values.get(key),
      set: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    },
    twilight: {
      providers: {
        register: async (value) => {
          provider = value;
        },
      },
      ui: { register: async () => {}, onCommand() {} },
    },
  });
  return { provider, calls, values, warnings };
}

test("recovers a transient first-page network failure without losing playlist tracks", async (t) => {
  let attempts = 0;
  const { provider } = await harness(t, () => {
    if (++attempts === 1) throw new TypeError("fetch failed");
    return json(page([media(1)]));
  });
  const tracks = await provider.fetchPlaylistTracks("123");
  assert.deepEqual(
    tracks.map((track) => track.id),
    ["bili:BV1:1"],
  );
  assert.equal(attempts, 2);
});

test("retries only the failed page and preserves playlist ordering", async (t) => {
  const pages = [];
  const { provider } = await harness(t, (url) => {
    const pn = Number(url.searchParams.get("pn"));
    pages.push(pn);
    if (pages.length === 2) return json({}, 503);
    return json(page([media(pn)], pn === 1));
  });
  const tracks = await provider.fetchPlaylistTracks("123");
  assert.deepEqual(
    tracks.map((track) => track.id),
    ["bili:BV1:1", "bili:BV2:2"],
  );
  assert.deepEqual(pages, [1, 2, 2]);
});

test("concurrent forced playlist requests share one load and login check", async (t) => {
  let attempts = 0;
  const { provider, calls } = await harness(t, async () => {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return json(page([media(1)]));
  });
  const results = await Promise.all([
    provider.fetchPlaylistTracks("123", true),
    provider.fetchPlaylistTracks("123", true),
  ]);
  assert.equal(attempts, 1);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/nav")).length, 1);
  assert.deepEqual(results[0], results[1]);
});

test("uses recent tracks during a temporary refresh failure and retries the next refresh", async (t) => {
  let fail = false;
  let attempts = 0;
  const { provider, warnings } = await harness(t, () => {
    attempts++;
    if (fail) return json({}, 503);
    return json(page([media(attempts)]));
  });
  const first = await provider.fetchPlaylistTracks("123");
  fail = true;
  assert.deepEqual(await provider.fetchPlaylistTracks("123", true), first);
  assert.equal(attempts, 3);
  assert.ok(warnings.some((message) => /cached|cache/i.test(message)));
  fail = false;
  const refreshed = await provider.fetchPlaylistTracks("123", true);
  assert.equal(refreshed[0].id, "bili:BV4:4");
});

test("does not cache an incomplete playlist after a failed later page", async (t) => {
  let fail = true;
  const pages = [];
  const { provider } = await harness(t, (url) => {
    const pn = Number(url.searchParams.get("pn"));
    pages.push(pn);
    if (fail && pn === 2) return json({}, 503);
    return json(page([media(pn)], pn === 1));
  });
  await assert.rejects(provider.fetchPlaylistTracks("123"), /HTTP 503/);
  fail = false;
  const tracks = await provider.fetchPlaylistTracks("123");
  assert.equal(tracks.length, 2);
  assert.deepEqual(pages, [1, 2, 2, 1, 2]);
});

test("does not retry authorization failures or hide them behind cached tracks", async (t) => {
  let code = 0;
  let attempts = 0;
  const { provider } = await harness(t, () => {
    attempts++;
    return code
      ? json({ code, message: "账号未登录" })
      : json(page([media(1)]));
  });
  await provider.fetchPlaylistTracks("123");
  code = -101;
  await assert.rejects(provider.fetchPlaylistTracks("123", true), /账号未登录/);
  assert.equal(attempts, 2);
  await provider.logout();
  await assert.rejects(provider.fetchPlaylistTracks("123"), /请先登录/);
});

test("concurrent library requests share the folder list without preloading folder contents", async (t) => {
  let folderCalls = 0;
  let coverCalls = 0;
  const { provider } = await harness(t, (url) => {
    if (url.pathname.endsWith("/list-all")) {
      folderCalls++;
      return json({
        code: 0,
        data: {
          list: Array.from({ length: 120 }, (_, id) => ({
            id,
            title: "Favorites",
            media_count: 3000,
          })),
        },
      });
    }
    coverCalls++;
    return json(page([media(1)]));
  });
  await Promise.all([provider.fetchUserLibrary(), provider.fetchUserLibrary()]);
  assert.equal(folderCalls, 1);
  assert.equal(coverCalls, 0);
});

test("rejects missing playlist data instead of caching a false empty playlist", async (t) => {
  let attempts = 0;
  const { provider } = await harness(t, () => {
    attempts++;
    return json({ code: 0, data: null });
  });
  await assert.rejects(provider.fetchPlaylistTracks("123"), /数据/);
  assert.equal(attempts, 2);
});

test("legacy full loads request pages sequentially in the original order", async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { provider, calls } = await harness(t, async (url) => {
    assert.equal(url.pathname, "/x/v3/fav/resource/list");
    const pn = Number(url.searchParams.get("pn"));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, (4 - (pn % 3)) * 2));
    inFlight--;
    const response = page(
      Array.from({ length: 20 }, (_, i) => media((pn - 1) * 20 + i + 1)),
      pn < 50,
    );
    response.data.info.media_count = 1000;
    return json(response);
  });
  const tracks = await provider.fetchPlaylistTracks("123");
  assert.equal(tracks.length, 1000);
  assert.deepEqual(
    tracks.map((track) => track.id),
    Array.from({ length: 1000 }, (_, i) => `bili:BV${i + 1}:${i + 1}`),
  );
  assert.equal(maxInFlight, 1);
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/resource/list")).length,
    50,
  );
  assert.equal(calls.filter((url) => url.pathname.endsWith("/view")).length, 0);
});

test("keeps multi-part videos expanded when favorites require video details", async (t) => {
  const { provider } = await harness(t, (url) => {
    if (url.pathname.endsWith("/resource/list")) {
      const entry = media(1);
      delete entry.ugc;
      return json(page([entry, media(2)]));
    }
    assert.equal(url.pathname, "/x/web-interface/view");
    return json({
      code: 0,
      data: {
        pages: [
          { cid: 11, part: "First", page: 1, duration: 10 },
          { cid: 12, part: "Second", page: 2, duration: 20 },
        ],
      },
    });
  });
  const tracks = await provider.fetchPlaylistTracks("123");
  assert.deepEqual(
    tracks.map((track) => track.id),
    ["bili:BV1:11", "bili:BV1:12", "bili:BV2:2"],
  );
});

test("a cold login network failure remains a network error instead of an expired-session error", async (t) => {
  const { provider } = await harness(
    t,
    () => json(page([media(1)])),
    () => {
      throw new TypeError("fetch failed");
    },
  );
  await assert.rejects(provider.fetchPlaylistTracks("123"), /fetch failed/);
});

test("a recent confirmed login survives a transient probe failure but explicit rejection logs out", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let fail = false;
  let rejectSession = false;
  const { provider } = await harness(
    t,
    () => json(page([media(1)])),
    () => {
      if (fail) throw new TypeError("fetch failed");
      return json({
        code: rejectSession ? -101 : 0,
        data: { isLogin: true, mid: 42, uname: "User" },
      });
    },
  );
  assert.equal((await provider.checkLogin()).loggedIn, true);
  now += 61000;
  fail = true;
  assert.equal((await provider.checkLogin()).loggedIn, true);
  assert.equal((await provider.fetchPlaylistTracks("123"))[0].id, "bili:BV1:1");
  fail = false;
  rejectSession = true;
  assert.deepEqual(await provider.checkLogin(), {
    loggedIn: false,
    profile: null,
  });
});

test("does not reuse another account's playlist cache", async (t) => {
  let attempts = 0;
  const { provider, values } = await harness(t, () =>
    json(page([media(++attempts)])),
  );
  await provider.fetchPlaylistTracks("123");
  values.set("auth", {
    cookie: "SESSDATA=other-session; DedeUserID=43; buvid3=device",
  });
  assert.equal((await provider.fetchPlaylistTracks("123"))[0].id, "bili:BV2:2");
});

test("JSON response body is covered by the request timeout after headers arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let readingBody;
  const bodyRead = new Promise((resolve) => {
    readingBody = resolve;
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, { signal }) => ({
    ok: true,
    json: () => {
      readingBody();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const pending = biliJson("https://api.bilibili.com/test", {}, 50);
  const rejected = assert.rejects(pending, /请求超时/);
  await bodyRead;
  t.mock.timers.tick(50);
  await rejected;
});

test("the complete load deadline bounds retries before the host RPC timeout", async (t) => {
  let attempts = 0;
  t.mock.method(Date, "now", () => 1000);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    attempts++;
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    biliJson("https://api.bilibili.com/test", { retries: 1, deadline: 1100 }),
    /fetch failed/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    biliJson("https://api.bilibili.com/test", { deadline: 1000 }),
    /加载超时/,
  );
  assert.equal(attempts, 1);
});

test("does not cache an empty playlist when video detail resolution temporarily fails", async (t) => {
  let fail = true;
  const { provider } = await harness(t, (url) => {
    if (url.pathname.endsWith("/resource/list")) {
      const entry = media(1);
      delete entry.ugc;
      return json(page([entry]));
    }
    if (fail) throw new TypeError("fetch failed");
    return json({ code: 0, data: { cid: 1 } });
  });
  await assert.rejects(provider.fetchPlaylistTracks("123"), /fetch failed/);
  fail = false;
  assert.equal((await provider.fetchPlaylistTracks("123"))[0].id, "bili:BV1:1");
});

test("cold login retries a temporary connection failure and still loads favorites", async (t) => {
  let attempts = 0;
  const { provider } = await harness(
    t,
    () => json(page([media(1)])),
    () => {
      if (++attempts === 1) throw new TypeError("fetch failed");
      return json({ code: 0, data: { isLogin: true, mid: 42 } });
    },
  );
  assert.equal((await provider.fetchPlaylistTracks("123"))[0].id, "bili:BV1:1");
  assert.equal(attempts, 2);
});

test("long Retry-After does not trigger an immediate retry against a rate-limited server", async (t) => {
  let attempts = 0;
  const { provider } = await harness(t, () => {
    attempts++;
    return new Response("", { status: 429, headers: { "Retry-After": "60" } });
  });
  await assert.rejects(provider.fetchPlaylistTracks("123"), /HTTP 429/);
  assert.equal(attempts, 1);
});

test("short Retry-After is respected before retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let attempts = 0;
  let firstReturned;
  const first = new Promise((resolve) => {
    firstReturned = resolve;
  });
  globalThis.fetch = async () => {
    if (++attempts === 1) {
      firstReturned();
      return new Response("", { status: 503, headers: { "Retry-After": "1" } });
    }
    return json(page([media(1)]));
  };
  const pending = biliJson("https://api.bilibili.com/test", { retries: 1 });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(999);
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(attempts, 2);
});

test("playback fallback chain stops before the host 30s RPC timeout", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let playbackCalls = 0;
  const { provider } = await harness(
    t,
    (url) => {
      assert.equal(url.pathname, "/x/player/wbi/playurl");
      playbackCalls++;
      now += 27001;
      throw new TypeError("fetch failed");
    },
    () =>
      json({
        code: 0,
        data: {
          isLogin: true,
          mid: 42,
          wbi_img: {
            img_url:
              "https://bilibili.com/7cd084941338484aae1ad9425b84077c.png",
            sub_url:
              "https://bilibili.com/4932caff0ff746eab6f01bf08b70ac45.png",
          },
        },
      }),
  );
  await assert.rejects(
    provider.getPlaybackUrl({ id: "bili:BV1:1" }),
    /加载超时/,
  );
  assert.equal(playbackCalls, 1);
});
