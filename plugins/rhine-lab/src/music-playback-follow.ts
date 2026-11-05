/** How the archive follows playback when the next track is on another album. */
export type PlaybackFollowView = {
  /** Not booting, no panel, not rebuilding the library or restoring lyrics. */
  interactive: boolean;
  /** Interactive, and the shelf itself is showing with nothing in flight. */
  shelfIdle: boolean;
  lyricsOpen: boolean;
  openingOrDetail: boolean;
  /** The album the shelf or detail currently shows. */
  shownAlbumId: string | undefined;
};
/**
 * - lyrics: the lyrics CD follows already; return to the new album on close.
 * - shelf: select the new album on the shelf.
 * - detail: the detail shows the previous album; switch it to the new one.
 * - defer: a panel, overview or transition is in the way; follow when idle.
 * - none: another album is being browsed; leave it alone.
 */
export type PlaybackFollowAction = "lyrics" | "shelf" | "detail" | "defer" | "none";

export function playbackFollowAction(
  view: PlaybackFollowView,
  previousAlbumId: string | undefined,
): PlaybackFollowAction {
  if (view.lyricsOpen) return "lyrics";
  if (view.shelfIdle) return "shelf";
  if (view.openingOrDetail)
    return view.interactive && view.shownAlbumId === previousAlbumId ? "detail" : "none";
  return "defer";
}

type PlayingTrack = { id: string; albumId: string };
/** Reports moves to another album; the first observed track is the baseline. */
export class PlayingAlbumTracker {
  private started = false;
  private trackId: string | undefined;
  private albumId: string | undefined;
  /** The previous album when playback moved to another album, else nothing. */
  observe(track: PlayingTrack | null | undefined): { previousAlbumId: string | undefined } | undefined {
    if (this.started && track?.id === this.trackId) return;
    const first = !this.started;
    const previousAlbumId = this.albumId;
    this.started = true;
    this.trackId = track?.id;
    this.albumId = track?.albumId;
    if (first || !track || track.albumId === previousAlbumId) return;
    return { previousAlbumId };
  }
}
