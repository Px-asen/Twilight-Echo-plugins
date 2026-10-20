export interface LibraryPage<T> {
  albums: T[];
  total: number;
  revision: number;
  unchanged?: boolean;
}

/** Retry a scan that changes during pagination; never publish a mixed-revision library. */
export async function readLibrarySnapshot<T, P extends LibraryPage<T>>(
  read: (offset: number, revision?: number) => Promise<P>,
  cached?: P,
): Promise<P> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await read(0, cached?.revision);
    if (first.unchanged && cached) return cached;
    const albums = [...first.albums];
    let consistent = true;
    for (let offset = 100; offset < first.total; offset += 100) {
      const page = await read(offset);
      if (page.revision !== first.revision || page.total !== first.total) {
        consistent = false;
        break;
      }
      albums.push(...page.albums);
    }
    if (consistent && albums.length === first.total)
      return { ...first, albums };
    cached = undefined;
  }
  throw new Error("曲库正在变化，请稍后刷新。当前列表已保留。");
}
