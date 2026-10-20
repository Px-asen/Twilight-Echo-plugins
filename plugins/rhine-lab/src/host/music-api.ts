import { callHost } from "./bridge";
import { readLibrarySnapshot } from "./library-pages";
import type { MusicAlbum, MusicLibrary, GenreRules } from "../music-types";

type Document = {
  revision: number;
  value: {
    albums?: Record<string, Partial<MusicAlbum>>;
    rules?: GenreRules;
    config?: Record<string, unknown>;
    [key: string]: unknown;
  };
};
async function document() {
  return callHost<Document>("music.metadata.read");
}
async function update(patch: Document["value"]) {
  const current = await document();
  return callHost<Document>("music.metadata.write", {
    revision: current.revision,
    value: { ...current.value, ...patch },
  });
}
let cachedLibrary:
  (MusicLibrary & { total: number; revision: number }) | undefined;
export async function library(): Promise<MusicLibrary> {
  const [first, saved, progress] = await Promise.all([
    readLibrarySnapshot<
      MusicAlbum,
      MusicLibrary & { total: number; revision: number; unchanged?: boolean }
    >(
      (offset, revision) =>
        callHost("music.library", { offset, limit: 100, revision }),
      cachedLibrary,
    ),
    document(),
    callHost("music.metadata.operate", { operation: "status" }),
  ]);
  const albums = first.albums;
  cachedLibrary = first;
  const rules = saved.value.rules;
  const merged = albums.map((album) => {
    const metadata = saved.value.albums?.[album.id];
    const genre =
      rules?.albumOverrides[album.id] ??
      rules?.genres.find(
        (g) => g.name === album.genreId || g.aliases?.includes(album.genreId),
      )?.id ??
      album.genreId;
    return {
      ...album,
      ...metadata,
      id: album.id,
      tracks: album.tracks,
      coverUrl: album.coverUrl,
      genreId: genre,
    };
  });
  const genres = [...(rules?.genres ?? first.genres)];
  for (const album of merged)
    if (!genres.some((genre) => genre.id === album.genreId))
      genres.push({ id: album.genreId, name: album.genreId });
  return {
    ...first,
    ...progress,
    albums: merged,
    genres,
    onlineEnabled: saved.value.config?.onlineEnabled === true,
  };
}
export async function musicRequest<T>(url: URL, body?: any): Promise<T> {
  const path = url.pathname;
  if (path === "/api/library") return (await library()) as T;
  if (path === "/api/library/scan") {
    await callHost("music.scan", { roots: body?.roots });
    return (await library()) as T;
  }
  if (path === "/api/config" || path === "/api/library/config") {
    if (body !== undefined) {
      const contact = body.musicBrainzContact;
      if (
        contact !== undefined &&
        (typeof contact !== "string" ||
          contact.length > 500 ||
          /[\r\n]/.test(contact))
      )
        throw new Error("资料库联系方式格式不正确");
      const saved = await document();
      await update({ config: { ...saved.value.config, ...body } });
    }
    const config = (await document()).value.config ?? {};
    return {
      ...config,
      musicBrainzConfigured: !!config.musicBrainzContact,
    } as T;
  }
  if (path === "/api/genre-rules") {
    if (body !== undefined) {
      if (
        body.version !== 1 ||
        !Array.isArray(body.genres) ||
        !body.albumOverrides ||
        typeof body.albumOverrides !== "object" ||
        body.genres.some(
          (genre: any) =>
            typeof genre.id !== "string" || typeof genre.name !== "string",
        )
      )
        throw new Error("流派规则格式不正确");
      await update({ rules: body });
    }
    const rules = (await document()).value.rules;
    return (rules ?? {
      version: 1,
      genres: (await library()).genres,
      albumOverrides: {},
    }) as T;
  }
  const operations: Record<string, string> = {
    "/api/library/introductions/task": "task",
    "/api/library/introductions/import-preview": "preview",
    "/api/library/introductions/import": "import",
    "/api/library/introductions/reconcile": "reconcile",
    "/api/library/introductions": "introductions",
    "/api/library/credits": "credits",
    "/api/library/enrich": "enrich",
  };
  const operation = operations[path];
  if (!operation) throw new Error(`未知音乐操作：${path}`);
  const result = await callHost("music.metadata.operate", {
    operation,
    body: body ?? Object.fromEntries(url.searchParams),
  });
  if (operation === "import")
    return { ...result, library: await library() } as T;
  if (["introductions", "credits", "enrich"].includes(operation))
    return (await library()) as T;
  return result as T;
}
