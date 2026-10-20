import test from "node:test";
import assert from "node:assert/strict";
import { readLibrarySnapshot } from "../src/host/library-pages.ts";

test("a thousand-album library is read completely and cached without duplicate rows", async () => {
  const all = Array.from({ length: 1000 }, (_, id) => ({ id }));
  const calls = [];
  const read = async (offset, revision) => {
    calls.push(offset);
    return revision === 4
      ? { unchanged: true, revision: 4 }
      : { albums: all.slice(offset, offset + 100), total: 1000, revision: 4 };
  };
  const result = await readLibrarySnapshot(read);
  assert.deepEqual(result.albums, all);
  assert.equal(calls.length, 10);
  assert.equal(await readLibrarySnapshot(read, result), result);
  assert.equal(calls.length, 11);
});

test("a concurrent scan retries the snapshot and discards stale pages", async () => {
  let scans = 0;
  const result = await readLibrarySnapshot(async (offset) => {
    if (offset === 0) scans++;
    const revision = scans === 1 && offset === 0 ? 1 : 2;
    return {
      albums: Array.from({ length: 100 }, (_, i) => ({
        id: offset + i,
        revision,
      })),
      total: 200,
      revision,
    };
  });
  assert.equal(scans, 2);
  assert.equal(result.albums.length, 200);
  assert.ok(result.albums.every((a) => a.revision === 2));
});

test("continually changing scans terminate instead of looping or publishing partial data", async () => {
  let revision = 0;
  await assert.rejects(
    () =>
      readLibrarySnapshot(async () => ({
        albums: [],
        total: 1000,
        revision: ++revision,
      })),
    /曲库正在变化/,
  );
  assert.equal(revision, 6);
});
