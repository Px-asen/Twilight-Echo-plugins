import { assetUrl } from "./asset-url.ts";
import type { MusicAlbum } from "./music-types";

const defaultCovers = {
  day: assetUrl("demo-covers/square.png"),
  night: assetUrl("demo-covers/portrait.png"),
};
let useDefaultCovers = false;
let coverTheme: "day" | "night" = "day";

/** A display preference only: never replace artwork in the library or player. */
export function setUseDefaultCovers(value: boolean) {
  useDefaultCovers = value;
}

export function setCoverTheme(theme: "day" | "night") {
  coverTheme = theme;
}

export const getThemeDefaultCoverUrl = () => defaultCovers[coverTheme];

export const usesDefaultCovers = () => useDefaultCovers;

export function getAlbumCoverUrl(album?: Pick<MusicAlbum, "id" | "coverUrl">) {
  if (!useDefaultCovers || !album) return album?.coverUrl;
  return defaultCovers[coverTheme];
}
