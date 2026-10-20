import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as navidrome from "./index.mjs";

const manifest = JSON.parse(
  await readFile(new URL("./plugin.json", import.meta.url), "utf8"),
);

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function envelope(body = {}) {
  return { "subsonic-response": { status: "ok", version: "1.16.1", ...body } };
}

async function activateProvider(settings = new Map()) {
  let registered = null;
  await navidrome.activate({
    twilight: {
      providers: { register: async (provider) => (registered = provider) },
    },
    settings: {
      get: async (key) =>
        key == null ? Object.fromEntries(settings) : settings.get(key),
      set: async (key, value) => settings.set(key, value),
      delete: async (key) => settings.delete(key),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  assert.ok(registered);
  return registered;
}

test("Navidrome manifest declares the permissions required by its provider", async () => {
  try {
    const provider = await activateProvider();
    assert.equal(manifest.id, "com.twilightecho.provider.navidrome");
    assert.equal(provider.id, "navidrome");
    assert.ok(provider.capabilities.includes("library"));
    assert.equal(typeof provider.loginWithServer, "function");
    for (const permission of ["network", "settings", "library:read"]) {
      assert.ok(
        manifest.permissions.includes(permission),
        `Missing ${permission} permission`,
      );
    }
  } finally {
    navidrome.deactivate();
  }
});

test("Navidrome marketplace package and index match the source and checksum", async () => {
  const index = JSON.parse(
    await readFile(new URL("../../plugins.json", import.meta.url), "utf8"),
  );
  const entry = index.plugins.find((plugin) => plugin.id === manifest.id);
  assert.ok(entry);
  for (const [key, value] of Object.entries(manifest))
    assert.deepEqual(entry[key], value);
  assert.equal(
    entry.sourceUrl,
    `packages/${manifest.id}-${manifest.version}.tep`,
  );
  const archive = new URL(`../../${entry.sourceUrl}`, import.meta.url);
  assert.equal(
    entry.checksumSha256,
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
  );
  const executable =
    process.platform === "linux"
      ? "unzip"
      : process.platform === "win32"
        ? "C:/Windows/System32/tar.exe"
        : "tar";
  const execute = promisify(execFile);
  for (const name of ["plugin.json", manifest.main]) {
    const args =
      process.platform === "linux"
        ? ["-p", fileURLToPath(archive), name]
        : ["-xOf", fileURLToPath(archive), name];
    const { stdout } = await execute(executable, args);
    if (name === "plugin.json") assert.deepEqual(JSON.parse(stdout), manifest);
    else
      assert.equal(
        stdout,
        await readFile(new URL(name, import.meta.url), "utf8"),
      );
  }
  const args =
    process.platform === "linux"
      ? ["-Z", "-1", fileURLToPath(archive)]
      : ["-tf", fileURLToPath(archive)];
  const { stdout } = await execute(executable, args);
  assert.deepEqual(stdout.trim().split(/\r?\n/).sort(), [
    "index.mjs",
    "plugin.json",
  ]);
});

test("Navidrome login stores credentials and maps search results", async () => {
  const settings = new Map();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return response(
      envelope({
        user: { username: "alice" },
        searchResult3: {
          songCount: 1,
          song: [
            {
              id: "song-1",
              title: "夜航",
              artist: "歌手",
              album: "专辑",
              duration: 245,
            },
          ],
        },
      }),
    );
  };
  try {
    const provider = await activateProvider(settings);
    const login = await provider.loginWithServer(
      "https://music.example/rest/",
      "alice",
      "secret",
    );
    assert.equal(login.loggedIn, true);
    assert.equal(settings.get("serverUrl"), "https://music.example");
    assert.equal(settings.get("username"), "alice");
    assert.equal(settings.get("password"), "secret");

    const result = await provider.searchSongs("夜航", 10, 0);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, "navidrome:song-1");
    assert.equal(result.items[0].source, "navidrome");
    assert.equal(result.items[0].duration, 245);
    assert.equal(calls[0].pathname, "/rest/getUser.view");
    assert.equal(calls[1].pathname, "/rest/search3.view");
    assert.equal(calls[1].searchParams.get("query"), "夜航");
    assert.equal(calls[1].searchParams.get("songCount"), "11");
    assert.equal(calls[1].searchParams.get("albumCount"), "0");
    for (const call of calls) {
      const salt = call.searchParams.get("s");
      assert.equal(
        call.searchParams.get("t"),
        createHash("md5").update(`secret${salt}`).digest("hex"),
      );
      assert.equal(call.searchParams.has("p"), false);
      assert.equal(call.searchParams.get("u"), "alice");
    }
    assert.notEqual(
      calls[0].searchParams.get("s"),
      calls[1].searchParams.get("s"),
    );
    assert.equal((await provider.checkLogin()).loggedIn, true);
    assert.equal((await provider.getProfile()).nickname, "alice");
    await provider.logout();
    assert.equal(settings.size, 0);
    assert.deepEqual(await provider.checkLogin(), {
      loggedIn: false,
      profile: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
    navidrome.deactivate();
  }
});

test("Navidrome playback uses authenticated stream and playlist APIs", async () => {
  const settings = new Map([
    ["serverUrl", "https://music.example"],
    ["username", "alice"],
    ["password", "secret"],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/getPlaylist.view")) {
      return response(
        envelope({
          playlist: {
            id: "p1",
            entry: [
              {
                id: "song-1",
                title: "Track",
                artist: "Artist",
                album: "Album",
              },
            ],
          },
        }),
      );
    }
    return response(envelope());
  };
  try {
    const provider = await activateProvider(settings);
    const url = await provider.getPlaybackUrl({ id: "navidrome:song-1" });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/rest/stream.view");
    assert.equal(parsed.searchParams.get("id"), "song-1");
    assert.ok(parsed.searchParams.get("t"));

    const tracks = await provider.fetchPlaylistTracks("p1");
    assert.deepEqual(
      tracks.map((track) => track.id),
      ["navidrome:song-1"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    navidrome.deactivate();
  }
});

test("Navidrome lyrics maps structured lines and falls back to legacy lyrics", async () => {
  const settings = new Map([
    ["serverUrl", "https://music.example"],
    ["username", "alice"],
    ["password", "secret"],
  ]);
  const originalFetch = globalThis.fetch;
  let lyricsBySongIdCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/getLyricsBySongId.view")) {
      lyricsBySongIdCalls += 1;
      if (lyricsBySongIdCalls === 1) {
        return response(
          envelope({
            lyricsList: {
              structuredLyrics: [
                {
                  synced: true,
                  line: [{ value: "第一句" }, { value: "第二句" }],
                },
              ],
            },
          }),
        );
      }
      return response(
        envelope({ status: "failed", error: { message: "unsupported" } }),
      );
    }
    assert.ok(parsed.pathname.endsWith("/getLyrics.view"));
    return response(envelope({ lyrics: { value: "旧版歌词" } }));
  };
  try {
    const provider = await activateProvider(settings);
    const lyrics = await provider.getLyrics({ id: "navidrome:song-1" });
    assert.deepEqual(lyrics, {
      lyrics: "第一句\n第二句",
      translatedLyrics: null,
    });

    const fallback = await provider.getLyrics({
      id: "navidrome:song-2",
      artist: "歌手",
      title: "歌曲",
    });
    assert.deepEqual(fallback, { lyrics: "旧版歌词", translatedLyrics: null });
    assert.equal(lyricsBySongIdCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    navidrome.deactivate();
  }
});

test("Navidrome searches playlists and loads album tracks", async () => {
  const settings = new Map([
    ["serverUrl", "https://music.example"],
    ["username", "alice"],
    ["password", "secret"],
  ]);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname.endsWith("/getPlaylists.view")) {
      return response(
        envelope({
          playlists: {
            playlist: [
              { id: "p1", name: "夜航精选", songCount: 2 },
              { id: "p2", name: "晨光", songCount: 1 },
              { id: "p3", name: "夜航现场", songCount: 3 },
            ],
          },
        }),
      );
    }
    assert.ok(parsed.pathname.endsWith("/getAlbum.view"));
    assert.equal(parsed.searchParams.get("id"), "album-1");
    return response(
      envelope({
        album: {
          song: [
            { id: "song-1", title: "夜航", artist: "歌手", album: "专辑" },
          ],
        },
      }),
    );
  };
  try {
    const provider = await activateProvider(settings);
    const playlists = await provider.searchPlaylists("夜航", 1, 1);
    assert.equal(playlists.total, 2);
    assert.deepEqual(
      playlists.items.map((playlist) => playlist.id),
      ["p3"],
    );
    assert.equal(playlists.items[0].trackCount, 3);

    const tracks = await provider.fetchAlbumTracks("album-1");
    assert.deepEqual(
      tracks.map((track) => track.id),
      ["navidrome:song-1"],
    );
    assert.deepEqual(calls, ["/rest/getPlaylists.view", "/rest/getAlbum.view"]);
  } finally {
    globalThis.fetch = originalFetch;
    navidrome.deactivate();
  }
});

test("Navidrome synced lyrics preserves timestamps and offsets", async () => {
  const settings = new Map([
    ["serverUrl", "https://music.example"],
    ["username", "alice"],
    ["password", "secret"],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    response(
      envelope({
        lyricsList: {
          structuredLyrics: [
            { synced: false, line: [{ value: "无时间歌词" }] },
            {
              synced: true,
              offset: 100,
              line: [
                { start: 0, value: "开头" },
                { start: 2123, value: "下一句" },
                { start: 60123, value: "一分钟" },
              ],
            },
          ],
        },
      }),
    );
  try {
    const provider = await activateProvider(settings);
    assert.deepEqual(await provider.getLyrics({ id: "navidrome:song-1" }), {
      lyrics: "[00:00.000]开头\n[00:02.023]下一句\n[01:00.023]一分钟",
      translatedLyrics: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
    navidrome.deactivate();
  }
});

test("Navidrome cancelled lyrics request does not start a fallback request", async () => {
  const settings = new Map([
    ["serverUrl", "https://music.example"],
    ["username", "alice"],
    ["password", "secret"],
  ]);
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    assert.equal(options.signal, controller.signal);
    controller.abort();
    throw controller.signal.reason;
  };
  try {
    const provider = await activateProvider(settings);
    await assert.rejects(
      provider.getLyrics(
        { id: "navidrome:song-1" },
        { signal: controller.signal },
      ),
      {
        name: "AbortError",
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    navidrome.deactivate();
  }
});

test("Navidrome failed login keeps existing credentials and rejects unsafe server URLs", async () => {
  const settings = new Map([
    ["serverUrl", "https://music.example"],
    ["username", "alice"],
    ["password", "secret"],
  ]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(
      envelope({
        status: "failed",
        error: { code: 40, message: "Wrong username or password" },
      }),
    );
  };
  try {
    const provider = await activateProvider(settings);
    await assert.rejects(
      provider.loginWithServer("https://other.example", "bob", "wrong"),
      /Wrong username or password/,
    );
    assert.equal(settings.get("serverUrl"), "https://music.example");
    assert.equal(settings.get("username"), "alice");
    assert.equal(settings.get("password"), "secret");
    assert.deepEqual(await provider.checkLogin(), {
      loggedIn: false,
      profile: null,
    });
    for (const url of [
      "file:///music",
      "https://alice:secret@music.example",
      "https://music.example?token=x",
    ]) {
      await assert.rejects(provider.loginWithServer(url, "bob", "wrong"));
    }
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    navidrome.deactivate();
  }
});

test("Navidrome library preserves playlist ownership and pages tracks", async () => {
  const settings = new Map([
    ["serverUrl", "https://music.example"],
    ["username", "alice"],
    ["password", "secret"],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname.endsWith("/getPlaylists.view")) {
      return response(
        envelope({
          playlists: {
            playlist: [
              { id: "mine", name: "我的歌单", owner: "alice", songCount: 3 },
              { id: "shared", name: "共享歌单", owner: "bob", songCount: 1 },
            ],
          },
        }),
      );
    }
    return response(
      envelope({
        playlist: {
          entry: [
            { id: "s1", title: "第一首" },
            { id: "s2", title: "第二首" },
            { id: "s3", title: "第三首" },
          ],
        },
      }),
    );
  };
  try {
    const provider = await activateProvider(settings);
    const library = await provider.fetchUserLibrary(false);
    assert.equal(library.likedPlaylist, null);
    assert.deepEqual(
      library.playlists.map((item) => item.owned),
      [true, false],
    );
    const first = await provider.fetchPlaylistTracksPage("mine", 0, 2);
    assert.deepEqual(
      first.tracks.map((track) => track.id),
      ["navidrome:s1", "navidrome:s2"],
    );
    assert.equal(first.total, 3);
    assert.equal(first.nextOffset, 2);
    assert.equal(first.hasMore, true);
    const last = await provider.fetchPlaylistTracksPage(
      "mine",
      first.nextOffset,
      2,
    );
    assert.deepEqual(
      last.tracks.map((track) => track.id),
      ["navidrome:s3"],
    );
    assert.equal(last.nextOffset, 3);
    assert.equal(last.hasMore, false);
  } finally {
    globalThis.fetch = originalFetch;
    navidrome.deactivate();
  }
});

test("Navidrome connects through a reverse proxy path and searches without server totals", async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    calls.push(url);
    const salt = url.searchParams.get("s");
    const token = createHash("md5").update(`secret${salt}`).digest("hex");
    res.setHeader("Content-Type", "application/json");
    if (
      url.searchParams.get("u") !== "alice" ||
      url.searchParams.get("t") !== token
    ) {
      res.end(
        JSON.stringify(
          envelope({
            status: "failed",
            error: { code: 40, message: "Unauthorized" },
          }),
        ),
      );
      return;
    }
    let body;
    if (url.pathname === "/navidrome/rest/getUser.view") {
      body = { user: { username: "alice" } };
    } else if (url.pathname === "/navidrome/rest/search3.view") {
      const songs = [1, 2, 3].map((id) => ({
        id: String(id),
        title: `Song ${id}`,
      }));
      const albums = [1, 2, 3].map((id) => ({
        id: String(id),
        name: `Album ${id}`,
      }));
      const songOffset = Number(url.searchParams.get("songOffset") || 0);
      const albumOffset = Number(url.searchParams.get("albumOffset") || 0);
      body = {
        searchResult3: {
          song: songs.slice(
            songOffset,
            songOffset + Number(url.searchParams.get("songCount")),
          ),
          album: albums.slice(
            albumOffset,
            albumOffset + Number(url.searchParams.get("albumCount")),
          ),
        },
      };
    } else {
      res.statusCode = 404;
      body = {
        status: "failed",
        error: { code: 70, message: "Unknown endpoint" },
      };
    }
    res.end(JSON.stringify(envelope(body)));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const provider = await activateProvider();
    const serverUrl = `http://127.0.0.1:${server.address().port}/navidrome/rest/`;
    await provider.loginWithServer(serverUrl, "alice", "secret");
    const first = await provider.searchSongs("Song", 2, 0);
    assert.deepEqual(
      first.items.map((track) => track.id),
      ["navidrome:1", "navidrome:2"],
    );
    assert.equal(first.total, 3);
    const last = await provider.searchSongs("Song", 2, 2);
    assert.deepEqual(
      last.items.map((track) => track.id),
      ["navidrome:3"],
    );
    assert.equal(last.total, 3);
    const albums = await provider.searchAlbums("Album", 2, 0);
    assert.deepEqual(
      albums.items.map((album) => album.name),
      ["Album 1", "Album 2"],
    );
    assert.equal(albums.total, 3);
    assert.equal(calls.length, 4);
    assert.equal(
      new URL(first.items[0].cover).pathname,
      "/navidrome/rest/getCoverArt.view",
    );
    assert.equal(
      new URL(await provider.getPlaybackUrl(first.items[0])).pathname,
      "/navidrome/rest/stream.view",
    );
  } finally {
    navidrome.deactivate();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
