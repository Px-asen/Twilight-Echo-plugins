import test from "node:test";
import assert from "node:assert/strict";
import {
  PlayingAlbumTracker,
  playbackFollowAction,
} from "../src/music-playback-follow.ts";

const shelf = {
  interactive: true,
  shelfIdle: true,
  lyricsOpen: false,
  openingOrDetail: false,
  shownAlbumId: "a",
};

test("only a move to another album is reported, never the first track", () => {
  const tracker = new PlayingAlbumTracker();
  assert.equal(tracker.observe({ id: "a1", albumId: "a" }), undefined);
  assert.equal(tracker.observe({ id: "a1", albumId: "a" }), undefined);
  assert.equal(tracker.observe({ id: "a2", albumId: "a" }), undefined);
  assert.deepEqual(tracker.observe({ id: "b1", albumId: "b" }), { previousAlbumId: "a" });
  assert.equal(tracker.observe(null), undefined);
  assert.deepEqual(tracker.observe({ id: "c1", albumId: "c" }), { previousAlbumId: undefined });

  const stopped = new PlayingAlbumTracker();
  assert.equal(stopped.observe(null), undefined);
  assert.deepEqual(stopped.observe({ id: "a1", albumId: "a" }), { previousAlbumId: undefined });
});

test("the view that still shows the previous album follows; other albums are left alone", () => {
  assert.equal(playbackFollowAction(shelf, "a"), "shelf");
  assert.equal(
    playbackFollowAction({ ...shelf, shelfIdle: false, lyricsOpen: true, openingOrDetail: true }, "a"),
    "lyrics",
  );
  const detail = { ...shelf, shelfIdle: false, openingOrDetail: true };
  assert.equal(playbackFollowAction(detail, "a"), "detail");
  assert.equal(playbackFollowAction({ ...detail, shownAlbumId: "x" }, "a"), "none");
  assert.equal(playbackFollowAction({ ...detail, interactive: false }, "a"), "none");
  // A panel, the overview or a shelf transition only postpones the move.
  assert.equal(playbackFollowAction({ ...shelf, shelfIdle: false }, "a"), "defer");
  assert.equal(
    playbackFollowAction({ ...shelf, interactive: false, shelfIdle: false }, "a"),
    "defer",
  );
});
