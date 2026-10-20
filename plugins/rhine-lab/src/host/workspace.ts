import { callHost, onHost, reportHostError, initialPlayer } from "./bridge";
import "./workspace.css";
import { createServicePages } from "./services-workspace";
import { appendSettings } from "./settings-workspace";

type Track = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  favorite?: boolean;
  queueEntryId?: string;
  duration: number;
};
const stage = document.querySelector<HTMLElement>("#stage")!;
stage.classList.add("hosted-music");
const launcher = document.createElement("button");
launcher.type = "button";
launcher.className = "host-workspace-launcher";
launcher.innerHTML =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/></svg><span>工作台</span>';
launcher.setAttribute("aria-label", "打开音乐工作台");
document.querySelector(".music-topnav")!.prepend(launcher);
const dialog = document.createElement("dialog");
dialog.className = "music-panel host-workspace";
dialog.setAttribute("aria-labelledby", "host-workspace-title");
dialog.innerHTML = `<header class="panel-heading"><div><small>TWILIGHT ECHO / MUSIC WORKSPACE</small><h2 id="host-workspace-title">音乐工作台</h2></div><button type="button" aria-label="关闭工作台">×</button></header><nav class="host-tabs" aria-label="工作台页面"></nav><p class="host-status" role="status" aria-live="polite"></p><main class="host-pages"></main>`;
stage.append(dialog);
const status = dialog.querySelector<HTMLElement>(".host-status")!;
const pages = new Map<string, HTMLElement>();
let active = "queue",
  player = initialPlayer,
  revision = 0;
const names: Record<string, string> = {
  queue: "队列",
  playlists: "收藏与歌单",
  lyrics: "歌词",
  online: "在线音乐",
  radio: "电台",
  podcasts: "播客",
  network: "网络音乐源",
  stats: "聆听统计",
  downloads: "下载",
  audio: "声音与设备",
  dsp: "DSP",
  settings: "应用设置",
  plugins: "插件",
  diagnostics: "诊断",
  themes: "主题工具",
};
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const time = (seconds: number) =>
  `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, "0")}`;
function button(label: string, run: () => unknown, title = label) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "text-button";
  b.textContent = label;
  b.title = title;
  b.onclick = () => void action(run, b);
  return b;
}
async function action(run: () => unknown, control?: HTMLButtonElement) {
  if (control) control.disabled = true;
  status.textContent = "";
  try {
    await run();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (control?.isConnected) control.disabled = false;
  }
}
function section(root: HTMLElement, title: string) {
  const item = document.createElement("section");
  item.className = "panel-section";
  const h = document.createElement("h3");
  h.textContent = title;
  item.append(h);
  root.append(item);
  return item;
}
function row(
  root: HTMLElement,
  label: string,
  control: HTMLElement,
  note = "",
) {
  const item = document.createElement("label");
  item.className = "settings-row";
  const text = document.createElement("span");
  text.textContent = label;
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    text.append(small);
  }
  item.append(text, control);
  if (!control.hasAttribute("aria-label"))
    control.setAttribute("aria-label", label);
  root.append(item);
  return item;
}
function select(
  value: unknown,
  values: [string, string][],
  save: (value: string) => unknown,
) {
  const el = document.createElement("select");
  values.forEach(([v, label]) => {
    const opt = new Option(label, v);
    el.add(opt);
  });
  el.value = String(value);
  el.onchange = () =>
    void action(async () => {
      el.disabled = true;
      try {
        await save(el.value);
        value = el.value;
      } catch (e) {
        el.value = String(value);
        throw e;
      } finally {
        el.disabled = false;
      }
    });
  return el;
}
function toggle(value: boolean, save: (value: boolean) => unknown) {
  const el = document.createElement("input");
  el.type = "checkbox";
  el.checked = value;
  el.onchange = () =>
    void action(async () => {
      el.disabled = true;
      try {
        await save(el.checked);
      } catch (e) {
        el.checked = !el.checked;
        throw e;
      } finally {
        el.disabled = false;
      }
    });
  return el;
}
function number(
  value: number,
  min: number,
  max: number,
  step: number,
  save: (value: number) => unknown,
) {
  const el = document.createElement("input");
  el.type = "number";
  el.value = String(value);
  el.min = String(min);
  el.max = String(max);
  el.step = String(step);
  el.required = true;
  el.onchange = () => {
    if (!el.reportValidity()) return;
    void action(async () => {
      el.disabled = true;
      try {
        const next = Number(el.value);
        await save(next);
        value = next;
      } catch (error) {
        el.value = String(value);
        throw error;
      } finally {
        el.disabled = false;
      }
    });
  };
  return el;
}
function trackRow(track: Track, play: () => unknown) {
  const row = document.createElement("div");
  row.className = "host-track";
  const main = button(track.title || "未命名曲目", play);
  main.classList.add("host-track-name");
  const detail = document.createElement("small");
  detail.textContent = `${track.artist} · ${time(track.duration)}`;
  main.append(detail);
  row.append(main);
  return row;
}
function nowPlaying(root: HTMLElement) {
  const line = document.createElement("p");
  line.className = "host-now";
  root.append(line);
  line.textContent = player?.currentTrack
    ? `${player.currentTrack.title} · ${time(player.currentTime)} / ${time(player.duration)}`
    : "尚未播放";
}
async function renderQueue(root: HTMLElement) {
  const [queue, state] = await Promise.all([
    callHost<Track[]>("player.queue"),
    callHost("player.state"),
  ]);
  player = state;
  root.replaceChildren();
  nowPlaying(root);
  const controls = section(root, `${queue.length} 首曲目`);
  controls.append(
    select(
      state.playMode,
      [
        ["sequential", "顺序播放"],
        ["listLoop", "列表循环"],
        ["repeat", "单曲循环"],
        ["shuffle", "随机播放"],
      ],
      (value) => callHost("player.mode", { value }),
    ),
    button("上一首", () => callHost("player.previous")),
    button("播放 / 暂停", () => callHost("player.toggle")),
    button("下一首", () => callHost("player.next")),
  );
  row(
    controls,
    "音量",
    number(Math.round(state.volume * 100), 0, 100, 1, (value) =>
      callHost("player.volume", { value: value / 100 }),
    ),
  );
  if (!queue.length) {
    controls.append(document.createTextNode("队列为空，请从专辑中选择歌曲。"));
    return;
  }
  const list = document.createElement("div");
  list.className = "host-track-list";
  root.append(list);
  queue.forEach((track, index) => {
    const item = trackRow(track, () =>
      callHost("player.playQueue", { entryId: track.queueEntryId }),
    );
    item.dataset.entryId = track.queueEntryId ?? "";
    item.append(
      button(
        track.favorite ? "♥" : "♡",
        async () => {
          await callHost("library.favorite", { id: track.id });
          await renderQueue(root);
        },
        "切换收藏",
      ),
      button(
        "↑",
        async () => {
          await callHost("player.reorderQueue", { from: index, to: index - 1 });
          await renderQueue(root);
        },
        "上移",
      ),
      button("移除", async () => {
        await callHost("player.removeQueue", { entryId: track.queueEntryId });
        await renderQueue(root);
      }),
    );
    (item.children[2] as HTMLButtonElement).disabled = index === 0;
    if (track.queueEntryId === state.currentTrack?.queueEntryId)
      item.classList.add("current");
    list.append(item);
  });
  const footer = section(root, "保存队列");
  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "新歌单名称";
  name.setAttribute("aria-label", "队列保存为歌单的名称");
  footer.append(
    name,
    button("保存为歌单", async () => {
      if (!name.value.trim()) throw Error("请输入歌单名称");
      const p = await callHost("library.createPlaylist", {
        name: name.value.trim(),
      });
      for (const t of queue)
        await callHost("library.addToPlaylist", { playlistId: p, id: t.id });
      status.textContent = "歌单已保存";
    }),
    button("清空队列", async () => {
      await callHost("player.clearQueue");
      await renderQueue(root);
    }),
  );
}
async function renderPlaylists(root: HTMLElement) {
  const playlists = await callHost<any[]>("library.playlists");
  root.replaceChildren();
  const create = section(root, "新建歌单");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "歌单名称";
  input.setAttribute("aria-label", "歌单名称");
  create.append(
    input,
    button("创建", async () => {
      if (!input.value.trim()) throw Error("请输入歌单名称");
      await callHost("library.createPlaylist", { name: input.value.trim() });
      await renderPlaylists(root);
    }),
  );
  for (const playlist of playlists) {
    const group = document.createElement("details");
    group.className = "panel-section";
    const summary = document.createElement("summary");
    summary.textContent = `${playlist.name} / ${playlist.tracks.length}`;
    group.append(summary);
    root.append(group);
    if (!playlist.isDefault)
      group.append(
        button("删除歌单", async () => {
          await callHost("library.deletePlaylist", { id: playlist.id });
          await renderPlaylists(root);
        }),
      );
    if (player?.currentTrack)
      group.append(
        button("加入正在播放的歌曲", async () => {
          await callHost("library.addToPlaylist", {
            playlistId: playlist.id,
            id: player.currentTrack.id,
          });
          await renderPlaylists(root);
        }),
      );
    for (const track of playlist.tracks) {
      const item = trackRow(track, () =>
        callHost("player.play", {
          id: track.id,
          ids: playlist.tracks.map((t: Track) => t.id),
        }),
      );
      item.append(
        button("移除", async () => {
          await callHost("library.removeFromPlaylist", {
            playlistId: playlist.id,
            id: track.id,
          });
          await renderPlaylists(root);
        }),
      );
      group.append(item);
    }
  }
}
async function renderAudio(root: HTMLElement) {
  const audio = await callHost("audio.read");
  root.replaceChildren();
  const output = section(root, "音频输出");
  row(
    output,
    "后端",
    select(
      audio.output,
      audio.outputs.map((x: any) => [x.id, x.label]),
      async (value) => {
        await callHost("audio.output", { output: value });
        await renderAudio(root);
      },
    ),
  );
  row(
    output,
    "设备",
    select(
      audio.device,
      audio.devices.map((x: any) => [x.id, x.label]),
      async (value) => {
        await callHost("audio.output", { device: value });
        await renderAudio(root);
      },
    ),
  );
  const processing = audio.processing;
  const save = (patch: any) => callHost("audio.processing", { patch });
  const dsp = section(root, "信号处理");
  for (const [key, label] of [
    ["dspEnabled", "启用 DSP"],
    ["directMode", "直通模式"],
    ["clipGuard", "削波保护"],
    ["gapless", "无缝播放"],
    ["crossfeedEnabled", "耳机串音混合"],
    ["eqEnabled", "启用均衡器"],
  ])
    row(
      dsp,
      label,
      toggle(processing[key], (value) => save({ [key]: value })),
    );
  row(
    dsp,
    "交叉淡化（秒）",
    number(processing.crossfadeSeconds, 0, 12, 0.1, (value) =>
      save({ crossfadeSeconds: value }),
    ),
  );
  row(
    dsp,
    "响度归一化",
    select(
      processing.volumeNormalization,
      [
        ["off", "关闭"],
        ["track", "按曲目"],
        ["album", "按专辑"],
      ],
      (value) => save({ volumeNormalization: value }),
    ),
  );
  const eq = section(root, "均衡器 / EQUALIZER");
  row(
    eq,
    "前级增益（dB）",
    number(processing.eqPreamp, -24, 24, 0.1, (value) =>
      save({ eqPreamp: value }),
    ),
  );
  row(
    eq,
    "模式",
    select(
      processing.eqMode,
      [
        ["graphic", "图示均衡器"],
        ["parametric", "参数均衡器"],
      ],
      (value) => save({ eqMode: value }),
    ),
  );
  const bands = processing.eqBands.map((b: any) => ({ ...b }));
  bands.forEach((band: any, index: number) => {
    const line = document.createElement("div");
    line.className = "host-eq-band";
    const heading = document.createElement("b");
    heading.textContent = String(index + 1).padStart(2, "0");
    line.append(heading);
    eq.append(line);
    for (const [key, label, min, max, step] of [
      ["frequency", "频率 Hz", 10, 24000, 1],
      ["gain", "增益 dB", -24, 24, 0.1],
      ["q", "Q", 0.1, 30, 0.1],
    ] as const)
      row(
        line,
        label,
        number(band[key], min, max, step, (value) => {
          band[key] = value;
          return save({ eqBands: bands });
        }),
      );
    row(
      line,
      "滤波器",
      select(
        band.filterType,
        [
          ["peak", "峰值"],
          ["lowShelf", "低架"],
          ["highShelf", "高架"],
          ["lowPass", "低通"],
          ["highPass", "高通"],
          ["notch", "陷波"],
          ["bandPass", "带通"],
          ["allPass", "全通"],
        ],
        (value) => {
          band.filterType = value;
          return save({ eqBands: bands });
        },
      ),
    );
  });
}
async function renderSettings(root: HTMLElement) {
  const { settings: s, appVersion } = await callHost("settings.read");
  root.replaceChildren();
  const save = (key: string, value: unknown) =>
    callHost("settings.update", { patch: { [key]: value } });
  const windows = section(root, "独立播放窗口 / WINDOWS");
  windows.append(
    button("迷你播放器", () => callHost("window.mini")),
    button("桌面歌词", () => callHost("window.lyrics")),
    button("托盘播放器", () => callHost("window.tray")),
  );
  const general = section(root, `Twilight Echo / ${appVersion}`);
  for (const [key, label] of [
    ["launchAtLogin", "登录系统时启动"],
    ["minimizeToTray", "最小化到托盘"],
    ["globalShortcuts", "全局快捷键"],
    ["smtcEnabled", "系统媒体控制"],
    ["discordRpcEnabled", "Discord 正在播放"],
    ["watchLibrary", "自动监控音乐文件夹"],
    ["onlineLyricsFallback", "在线补充歌词"],
    ["autoAnalyzeBpm", "自动分析 BPM"],
  ])
    row(
      general,
      label,
      toggle(s[key], (value) => save(key, value)),
    );
  row(
    general,
    "关闭窗口",
    select(
      s.closeWindowBehavior,
      [
        ["quit", "退出"],
        ["tray", "托盘"],
        ["miniPlayer", "迷你播放器"],
      ],
      (value) => save("closeWindowBehavior", value),
    ),
  );
  row(
    general,
    "恢复播放",
    select(
      s.playbackResumeMode,
      [
        ["off", "关闭"],
        ["trackAndPosition", "恢复进度"],
        ["track", "恢复歌曲"],
      ],
      (value) => save("playbackResumeMode", value),
    ),
  );
  row(
    general,
    "上一首按钮",
    select(
      s.previousButtonAction,
      [
        ["restart", "先重播当前曲目"],
        ["previous", "切换上一首"],
      ],
      (value) => save("previousButtonAction", value),
    ),
  );
  const network = section(root, "网络代理");
  row(
    network,
    "模式",
    select(
      s.proxyMode,
      [
        ["auto", "跟随系统"],
        ["off", "直连"],
        ["custom", "手动"],
      ],
      (value) => save("proxyMode", value),
    ),
  );
  const host = document.createElement("input");
  host.type = "text";
  host.value = s.proxyHost;
  row(network, "服务器", host);
  const port = number(s.proxyPort, 1, 65535, 1, () => {});
  row(network, "端口", port);
  network.append(
    button("保存代理", () =>
      callHost("settings.update", {
        patch: { proxyHost: host.value, proxyPort: Number(port.value) },
      }),
    ),
  );
  row(
    network,
    "允许直连回退",
    toggle(s.proxyAllowDirectFallback, (value) =>
      save("proxyAllowDirectFallback", value),
    ),
  );
  appendSettings(root, s, { button, section, row, select, toggle, number });
}
async function renderPlugins(root: HTMLElement) {
  const plugins = await callHost<any[]>("plugins.list");
  root.replaceChildren();
  root.append(
    button("安装插件包", async () => {
      await callHost("plugins.install");
      await renderPlugins(root);
    }),
  );
  const catalog = document.createElement("div");
  root.append(
    button("浏览插件目录 / 检查更新", async () => {
      const entries = await callHost<any[]>("plugins.catalog");
      catalog.replaceChildren();
      for (const entry of entries) {
        const installed = plugins.find((p) => p.id === entry.id);
        if (installed?.version === entry.version) continue;
        const item = section(catalog, `${entry.name} / ${entry.version}`);
        const description = document.createElement("p");
        description.textContent = entry.description;
        item.append(description);
        item.append(
          button(installed ? "安装目录版本" : "安装", async () => {
            await callHost("plugins.update", { id: entry.id });
            await renderPlugins(root);
          }),
        );
      }
      if (!catalog.childElementCount)
        catalog.textContent = "已安装插件与目录版本一致。";
    }),
    catalog,
  );
  for (const plugin of plugins) {
    const group = section(root, `${plugin.name} / ${plugin.version}`);
    const desc = document.createElement("p");
    desc.textContent =
      (plugin.description || plugin.id) + " · " + plugin.status;
    group.append(desc);
    const permissions = document.createElement("p");
    permissions.className = "host-note";
    permissions.textContent = "权限：" + (plugin.permissions || []).join(" / ");
    group.append(permissions);
    if (plugin.error) {
      const p = document.createElement("p");
      p.textContent = plugin.error;
      group.append(p);
    }
    group.append(
      button(plugin.enabled ? "禁用" : "启用", async () => {
        await callHost(plugin.enabled ? "plugins.disable" : "plugins.enable", {
          id: plugin.id,
        });
        await renderPlugins(root);
      }),
    );
    if (!plugin.builtIn)
      group.append(
        button("卸载", async () => {
          await callHost("plugins.uninstall", { id: plugin.id });
          await renderPlugins(root);
        }),
      );
  }
}

async function renderDownloads(root: HTMLElement) {
  const tasks = await callHost<any[]>("downloads.list");
  root.replaceChildren();
  root.append(button("刷新", () => renderDownloads(root)));
  if (!tasks.length) {
    const p = document.createElement("p");
    p.textContent = "暂无下载任务";
    root.append(p);
  }
  for (const task of tasks) {
    const group = section(root, task.title);
    const p = document.createElement("p");
    p.textContent =
      task.artist +
      " · " +
      task.status +
      " · " +
      Math.round(task.progress * 100) +
      "%";
    group.append(p);
    if (task.error) {
      const error = document.createElement("p");
      error.textContent = task.error;
      group.append(error);
    }
    if (["failed", "cancelled"].includes(task.status))
      group.append(
        button("重试", async () => {
          await callHost("downloads.retry", { id: task.id });
          await renderDownloads(root);
        }),
      );
    if (["queued", "preparing", "downloading"].includes(task.status))
      group.append(
        button("取消", async () => {
          await callHost("downloads.cancel", { id: task.id });
          await renderDownloads(root);
        }),
      );
  }
}
async function renderOnline(root: HTMLElement) {
  const providers = await callHost<any[]>("online.providers");
  root.replaceChildren();
  if (!providers.length) {
    root.textContent = "暂无在线音源，请先启用音源插件。";
    return;
  }
  const source = select(
    providers[0].id,
    providers.map((p) => [p.id, p.name]),
    () => choose(),
  );
  row(root, "音源", source);
  const account = section(root, "账号");
  const actions = section(root, "浏览与搜索");
  const content = section(root, "曲目");
  let sourceRevision = 0;
  const showTracks = (tracks: Track[], providerId: string) => {
    content.replaceChildren();
    if (!tracks.length) content.textContent = "没有找到曲目";
    for (const track of tracks) {
      const item = trackRow(track, () =>
        callHost("player.play", { id: track.id, ids: tracks.map((t) => t.id) }),
      );
      item.append(
        button(
          "♡",
          () => callHost("library.favorite", { id: track.id }),
          "收藏",
        ),
        button("下载", () =>
          callHost("downloads.create", {
            providerId,
            id: track.id,
            quality: "lossless",
          }),
        ),
      );
      content.append(item);
    }
  };
  async function choose() {
    const current = ++sourceRevision,
      id = source.value,
      provider = providers.find((p) => p.id === id);
    account.replaceChildren();
    actions.replaceChildren();
    content.replaceChildren();
    const supports = (method: string) => provider.methods.includes(method);
    if (supports("checkLogin")) {
      const login = await callHost("online.login", { providerId: id });
      if (current !== sourceRevision) return;
      const text = document.createElement("p");
      text.textContent = login.loggedIn
        ? "已登录 · " + login.nickname
        : "尚未登录";
      account.append(text);
      if (login.loggedIn)
        account.append(
          button("退出账号", async () => {
            await callHost("online.logout", { providerId: id });
            await choose();
          }),
        );
      else if (supports("getQrLogin"))
        account.append(
          button("扫码登录", async () => {
            const qr = await callHost("online.qr", { providerId: id });
            if (!qr) throw Error("音源未提供二维码");
            if (current !== sourceRevision) return;
            const image = document.createElement("img");
            image.alt = "登录二维码";
            image.width = 180;
            image.height = 180;
            if (qr.imageDataUrl?.startsWith("data:image/"))
              image.src = qr.imageDataUrl;
            else throw Error("音源未提供可显示的二维码，请更新音源插件");
            account.append(
              image,
              button("检查扫码状态", async () => {
                const check = await callHost("online.qrStatus", {
                  providerId: id,
                  key: qr.key,
                });
                status.textContent = check.message || String(check.code);
                if (check.code === provider.qrStatusCodes?.success)
                  await choose();
              }),
            );
          }),
        );
    }
    if (supports("searchSongs")) {
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.type = "search";
      input.placeholder = "歌曲、歌手、专辑";
      input.setAttribute("aria-label", "在线音乐搜索");
      let offset = 0,
        query = "";
      const search = async (next = false) => {
        if (!next) {
          query = input.value.trim();
          offset = 0;
        }
        if (!query) return;
        const result = await callHost("online.search", {
          providerId: id,
          query,
          offset,
        });
        if (current !== sourceRevision) return;
        showTracks(result.items, id);
        if (offset + result.items.length < result.total)
          content.append(
            button("下一页", () => {
              offset += 50;
              return search(true);
            }),
          );
      };
      form.append(
        input,
        button("搜索", () => search()),
      );
      form.onsubmit = (e) => {
        e.preventDefault();
        void action(() => search());
      };
      actions.append(form);
    }
    if (supports("fetchRecommendSongs"))
      actions.append(
        button("每日推荐", async () => {
          const tracks = await callHost<Track[]>("online.recommendations", {
            providerId: id,
          });
          if (current === sourceRevision) showTracks(tracks, id);
        }),
      );
    if (supports("fetchUserLibrary"))
      actions.append(
        button("我的歌单", async () => {
          const playlists = await callHost<any[]>("online.library", {
            providerId: id,
          });
          if (current !== sourceRevision) return;
          content.replaceChildren();
          for (const p of playlists)
            content.append(
              button(p.name + " / " + p.trackCount, async () => {
                const load = async (offset = 0) => {
                  const page = await callHost("online.playlist", {
                    providerId: id,
                    id: p.id,
                    offset,
                  });
                  if (current !== sourceRevision) return;
                  showTracks(page.items, id);
                  if (page.hasMore)
                    content.append(
                      button("下一页", () => load(page.nextOffset)),
                    );
                };
                await load();
              }),
            );
        }),
      );
    if (supports("fetchCloudSongsPage"))
      actions.append(
        button("云盘", async () => {
          const load = async (offset = 0) => {
            const page = await callHost("online.cloud", {
              providerId: id,
              offset,
            });
            if (current !== sourceRevision) return;
            showTracks(page.items, id);
            if (offset + page.items.length < page.total)
              content.append(
                button("下一页", () => load(offset + page.items.length)),
              );
          };
          await load();
        }),
      );
  }
  await choose();
}

async function renderDsp(root: HTMLElement) {
  const {
    state,
    status: engine,
    catalog,
    templates,
  } = await callHost("dsp.read");
  root.replaceChildren();
  const controls = section(root, "处理场景 / SIGNAL PROCESSING");
  const report = document.createElement("p");
  report.textContent =
    (engine.applyError ||
      engine.compileError ||
      state.effectiveBypassReason ||
      "音频图已加载") +
    " · " +
    engine.totalLatencyFrames +
    " samples";
  controls.append(report);
  const selected = select(
    state.pinnedSceneId || "",
    [["", "自动选择"], ...state.scenes.map((s: any) => [s.id, s.name])],
    async (value) => {
      await callHost("dsp.apply", { id: value || null });
      await renderDsp(root);
    },
  );
  row(controls, "当前场景", selected);
  controls.append(
    button("导入处理预设", async () => {
      await callHost("dsp.import");
      await renderDsp(root);
    }),
    button("导出处理预设", () => callHost("dsp.export")),
  );
  const create = section(root, "新建场景");
  const template = select(
    templates[0].id,
    templates.map((t: any) => [t.id, t.name]),
    () => {},
  );
  create.append(
    template,
    button("创建", async () => {
      await callHost("dsp.create", { template: template.value });
      await renderDsp(root);
    }),
  );
  const labels: Record<string, string> = {
    thresholdDb: "阈值 dB",
    ratio: "压缩比",
    attackMs: "启动 ms",
    releaseMs: "释放 ms",
    makeupDb: "补偿 dB",
    preampDb: "前级 dB",
    fallbackDb: "回退增益 dB",
    clip: "防止削波",
    strength: "强度",
    delayMs: "延迟 ms",
    cutoffHz: "截止频率 Hz",
    crossoverHz: "分频 Hz",
    lfeGainDb: "LFE 增益 dB",
    ceilingDb: "上限 dB",
    lookaheadMs: "前视 ms",
    width: "宽度",
    wet: "湿声",
    dry: "干声",
    amount: "强度",
    enabled: "启用",
  };
  const ranges: Record<string, [number, number, number]> = {
    thresholdDb: [-100, 0, 0.1],
    ratio: [1, 40, 0.1],
    attackMs: [0.01, 1000, 0.1],
    releaseMs: [1, 10000, 1],
    makeupDb: [-24, 24, 0.1],
    preampDb: [-24, 24, 0.1],
    fallbackDb: [-24, 24, 0.1],
    strength: [0, 1, 0.01],
    delayMs: [0, 1000, 0.01],
    cutoffHz: [10, 24000, 1],
    crossoverHz: [10, 24000, 1],
    lfeGainDb: [-24, 24, 0.1],
    ceilingDb: [-24, 0, 0.1],
    lookaheadMs: [0, 100, 0.1],
    width: [0, 2, 0.01],
    wet: [0, 1, 0.01],
    dry: [0, 1, 0.01],
    amount: [0, 1, 0.01],
  };
  const enums: Record<string, [string, string][]> = {
    mode: [
      ["off", "关闭"],
      ["track", "曲目"],
      ["album", "专辑"],
    ],
    algorithm: [
      ["custom", "自定义"],
      ["bs2b", "BS2B"],
    ],
  };
  for (const scene of state.scenes) {
    const group = document.createElement("details");
    group.className = "panel-section";
    group.open = scene.id === state.activeSceneId;
    const title = document.createElement("summary");
    title.textContent =
      scene.name + " / " + scene.graph.nodes.length + " MODULES";
    group.append(title);
    root.append(group);
    const update = async (node: any, patch: any) => {
      await callHost("dsp.node", {
        sceneId: scene.id,
        nodeId: node.id,
        action: "update",
        ...patch,
      });
    };
    for (const [index, node] of scene.graph.nodes.entries()) {
      const item = section(
        group,
        String(index + 1).padStart(2, "0") +
          " / " +
          (catalog.find((n: any) => n.type === node.type)?.label || node.type),
      );
      row(
        item,
        "启用模块",
        toggle(node.enabled, (value) => update(node, { enabled: value })),
      );
      for (const [key, value] of Object.entries(node.params)) {
        const label = labels[key];
        if (label && typeof value === "boolean")
          row(
            item,
            label,
            toggle(value, (v) => update(node, { params: { [key]: v } })),
          );
        else if (label && typeof value === "number" && ranges[key]) {
          const [min, max, step] = ranges[key];
          row(
            item,
            label,
            number(value, min, max, step, (v) =>
              update(node, { params: { [key]: v } }),
            ),
          );
        } else if (
          enums[key] &&
          typeof value === "string" &&
          enums[key].some(([v]) => v === value)
        )
          row(
            item,
            key === "algorithm" ? "算法" : "模式",
            select(value, enums[key], (v) =>
              update(node, { params: { [key]: v } }),
            ),
          );
      }
      if (index > 0)
        item.append(
          button("上移", async () => {
            await callHost("dsp.node", {
              sceneId: scene.id,
              nodeId: node.id,
              action: "move",
              to: index - 1,
            });
            await renderDsp(root);
          }),
        );
      item.append(
        button("移除模块", async () => {
          await callHost("dsp.node", {
            sceneId: scene.id,
            nodeId: node.id,
            action: "remove",
          });
          await renderDsp(root);
        }),
      );
    }
    const available = catalog.filter(
      (n: any) => !["nativePlugin", "vst3Plugin"].includes(n.type),
    );
    const type = select(
      available[0].type,
      available.map((n: any) => [n.type, n.label]),
      () => {},
    );
    group.append(
      type,
      button("添加模块", async () => {
        await callHost("dsp.node", {
          sceneId: scene.id,
          action: "add",
          type: type.value,
        });
        await renderDsp(root);
      }),
    );
  }
}
const renderers: Record<string, (root: HTMLElement) => Promise<void>> = {
  ...createServicePages({ button, section, row, select, toggle }),
  queue: renderQueue,
  playlists: renderPlaylists,
  online: renderOnline,
  downloads: renderDownloads,
  audio: renderAudio,
  dsp: renderDsp,
  settings: renderSettings,
  plugins: renderPlugins,
};
async function activate(name: string, refresh = false) {
  if (name === "lyrics") {
    dialog.close();
    window.dispatchEvent(new Event("rhine-open-lyrics"));
    return;
  }
  active = name;
  const request = ++revision;
  status.textContent = "";
  dialog
    .querySelectorAll<HTMLButtonElement>(".host-tabs button")
    .forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.page === name));
      b.tabIndex = b.dataset.page === name ? 0 : -1;
    });
  for (const [key, page] of pages) page.hidden = key !== name;
  let page = pages.get(name);
  if (!page) {
    page = document.createElement("section");
    page.className = "host-page";
    page.id = `host-page-${name}`;
    page.setAttribute("role", "tabpanel");
    page.setAttribute("aria-labelledby", `host-tab-${name}`);
    pages.set(name, page);
    dialog.querySelector(".host-pages")!.append(page);
  }
  if (!page.childElementCount || refresh) {
    page.setAttribute("aria-busy", "true");
    status.textContent = "正在读取…";
    try {
      await renderers[name](page);
      if (request === revision) status.textContent = "";
    } catch (e) {
      if (request === revision) status.textContent = String(e);
      if (!page.childElementCount)
        page.append(button("重试加载", () => activate(name, true)));
    } finally {
      page.removeAttribute("aria-busy");
    }
  }
}
for (const [name, label] of Object.entries(names)) {
  const b = button(label, () => activate(name));
  b.dataset.page = name;
  b.id = `host-tab-${name}`;
  b.setAttribute("role", "tab");
  b.setAttribute("aria-controls", `host-page-${name}`);
  dialog.querySelector(".host-tabs")!.append(b);
}
dialog.querySelector(".host-tabs")!.setAttribute("role", "tablist");
dialog.querySelector(".host-tabs")!.addEventListener("keydown", (event) => {
  const e = event as KeyboardEvent;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const tabs = [
    ...dialog.querySelectorAll<HTMLButtonElement>(".host-tabs button"),
  ];
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tabs.length - 1
        : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next].focus();
  tabs[next].click();
});
launcher.onclick = () => {
  dialog.showModal();
  void activate(
    active,
    ["queue", "playlists", "plugins"].includes(active),
  );
};
dialog.querySelector<HTMLButtonElement>(".panel-heading button")!.onclick =
  () => dialog.close();
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const { clientX: x, clientY: y } = event as MouseEvent;
  const box = dialog.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom)
    dialog.close();
});
dialog.addEventListener("keydown", (event) => event.stopPropagation());
function updateClock() {
  for (const el of dialog.querySelectorAll<HTMLElement>(".host-now"))
    el.textContent = player?.currentTrack
      ? `${player.currentTrack.title} · ${time(player.currentTime)} / ${time(player.duration)}`
      : "尚未播放";
}
onHost("player", (state) => {
  player = state;
  updateClock();
});
onHost("queue", () => {
  if (dialog.open && active === "queue") void activate("queue", true);
});
const themeObserver = new MutationObserver(() =>
  window.parent.postMessage(
    { type: "twilight-experience-tone", tone: stage.dataset.theme },
    "*",
  ),
);
themeObserver.observe(stage, {
  attributes: true,
  attributeFilter: ["data-theme"],
});
window.addEventListener("pagehide", () => themeObserver.disconnect(), {
  once: true,
});
window.addEventListener("rhine-host-error", ((event: CustomEvent<string>) => {
  status.textContent = event.detail;
  const toast = document.querySelector<HTMLElement>("#music-toast");
  if (toast) {
    toast.textContent = event.detail;
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 5000);
  }
}) as EventListener);
window.addEventListener("unhandledrejection", (event) =>
  reportHostError(event.reason),
);
document.addEventListener("click", (event) => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
    "a[href]",
  );
  if (link?.href.startsWith("https://")) {
    event.preventDefault();
    void callHost("host.openLink", { url: link.href }).catch(reportHostError);
  }
});
