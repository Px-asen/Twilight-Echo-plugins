import { callHost, initialPlayer } from "./bridge";

type UI = {
  button: (
    label: string,
    run: () => unknown,
    title?: string,
  ) => HTMLButtonElement;
  section: (root: HTMLElement, title: string) => HTMLElement;
  row: (
    root: HTMLElement,
    label: string,
    control: HTMLElement,
    note?: string,
  ) => HTMLElement;
  select: (
    value: unknown,
    values: [string, string][],
    save: (value: string) => unknown,
  ) => HTMLSelectElement;
  toggle: (
    value: boolean,
    save: (value: boolean) => unknown,
  ) => HTMLInputElement;
  number: (
    value: number,
    min: number,
    max: number,
    step: number,
    save: (value: number) => unknown,
  ) => HTMLInputElement;
};

export function appendSettings(root: HTMLElement, settings: any, ui: UI) {
  const { button, section, row, select, toggle, number } = ui;
  const save = async (key: string, value: unknown) => {
    await callHost("settings.update", { patch: { [key]: value } });
    settings[key] = value;
  };
  let writing: Promise<unknown> = Promise.resolve();
  const nested = (key: string, field: string, value: unknown) => {
    const next = writing.then(() =>
      save(key, { ...settings[key], [field]: value }),
    );
    writing = next.catch(() => {});
    return next;
  };
  const selectSetting = (
    group: HTMLElement,
    key: string,
    label: string,
    options: [string, string][],
  ) =>
    row(
      group,
      label,
      select(settings[key], options, (v) => save(key, v)),
    );
  const display = section(root, "启动与交互 / INTERFACE");
  const startup = settings.startupExperience;
  const isRhine =
    startup?.pluginId === "com.twilightecho.experience.rhine-lab" &&
    startup?.experienceId === "rhine-lab";
  const startupOptions: [string, string][] = [
    ["rhine", "莱茵生命"],
    ["default", "Twilight Echo 默认界面"],
  ];
  if (startup && !isRhine)
    startupOptions.unshift(["other", "其他已选完整界面（保留）"]);
  const startupControl = select(
    startup ? (isRhine ? "rhine" : "other") : "default",
    startupOptions,
    (value) =>
      value === "other"
        ? Promise.resolve()
        : save(
            "startupExperience",
            value === "rhine"
              ? {
                  pluginId: "com.twilightecho.experience.rhine-lab",
                  experienceId: "rhine-lab",
                }
              : null,
          ),
  );
  const otherStartup = startupControl.querySelector<HTMLOptionElement>(
    'option[value="other"]',
  );
  if (otherStartup) otherStartup.disabled = true;
  row(display, "启动界面", startupControl, "下次启动生效");
  selectSetting(display, "language", "宿主语言", [
    ["system", "跟随系统"],
    ["zh-CN", "简体中文"],
    ["en-US", "English"],
  ]);
  selectSetting(display, "motionPreference", "宿主动效", [
    ["system", "跟随系统"],
    ["full", "完整"],
    ["reduced", "减少动态效果"],
    ["off", "关闭"],
  ]);
  selectSetting(display, "trackActivationMode", "曲目操作", [
    ["singleClick", "单击播放"],
    ["doubleClick", "双击播放"],
  ]);
  for (const [key, label] of [
    ["hardwareAcceleration", "硬件加速（重启生效）"],
    ["taskbarThumbarButtonsEnabled", "任务栏播放按钮"],
    ["autoCheckLogin", "启动时检查登录状态"],
  ])
    row(
      display,
      label,
      toggle(settings[key], (v) => save(key, v)),
    );

  const playback = section(root, "播放偏好 / PLAYBACK");
  selectSetting(playback, "ncmPlaybackQuality", "网易云播放音质", [
    ["auto", "自动"],
    ["standard", "标准"],
    ["exhigh", "极高"],
    ["lossless", "无损"],
    ["hires", "Hi-Res"],
  ]);
  selectSetting(playback, "autoMixMode", "AutoMix", [
    ["off", "关闭"],
    ["natural", "自然过渡"],
    ["dj", "DJ 混音"],
  ]);
  row(
    playback,
    "独占输出",
    toggle(settings.audioExclusiveMode, (v) => save("audioExclusiveMode", v)),
  );
  row(
    playback,
    "暂停时释放独占设备",
    toggle(settings.audioExclusiveAutoRelease, (v) =>
      save("audioExclusiveAutoRelease", v),
    ),
  );
  row(
    playback,
    "默认定时分钟",
    number(settings.sleepTimer.defaultMinutes, 1, 720, 1, (v) =>
      nested("sleepTimer", "defaultMinutes", v),
    ),
  );
  row(
    playback,
    "停止前淡出（秒）",
    number(settings.sleepTimer.fadeSeconds, 0, 120, 1, (v) =>
      nested("sleepTimer", "fadeSeconds", v),
    ),
  );
  const timerMode = select(
    "minutes",
    [
      ["minutes", "指定时长"],
      ["trackEnd", "当前曲目结束"],
      ["queueEnd", "队列结束"],
    ],
    () => {},
  );
  row(playback, "本次定时模式", timerMode);
  const minutes = number(
    settings.sleepTimer.defaultMinutes,
    1,
    720,
    1,
    () => {},
  );
  row(playback, "本次分钟数", minutes);
  const timerStatus = document.createElement("p");
  timerStatus.className = "host-note";
  const showTimer = (state: any) => {
    timerStatus.textContent = state.sleepTimer?.active
      ? "定时已开启" +
        (state.sleepTimer.endsAt
          ? " · " + new Date(state.sleepTimer.endsAt).toLocaleTimeString()
          : "")
      : "定时已关闭";
  };
  playback.append(
    button("开启定时", async () =>
      showTimer(
        await callHost("player.sleep", {
          mode: timerMode.value,
          minutes: Number(minutes.value),
        }),
      ),
    ),
    button("取消定时", async () =>
      showTimer(await callHost("player.sleep", { mode: null })),
    ),
    timerStatus,
  );
  row(
    playback,
    "播放速度",
    number(initialPlayer?.playbackRate || 1, 0.5, 2, 0.05, (v) =>
      callHost("player.rate", { value: v }),
    ),
  );

  const downloads = section(root, "下载与缓存 / STORAGE");
  const folder = document.createElement("input");
  folder.value = settings.downloadFolder || "";
  row(downloads, "下载目录", folder, "留空使用曲库目录");
  downloads.append(
    button("保存下载目录", () => save("downloadFolder", folder.value)),
  );
  row(
    downloads,
    "文件命名",
    select(
      settings.downloadPreferences.naming,
      [
        ["provider", "音源默认"],
        ["artist-title", "歌手 - 标题"],
        ["title-artist", "标题 - 歌手"],
        ["title", "标题"],
      ],
      (v) => nested("downloadPreferences", "naming", v),
    ),
  );
  for (const [key, label] of [
    ["embedMetadata", "写入歌曲标签"],
    ["saveLyrics", "保存歌词"],
  ])
    row(
      downloads,
      label,
      toggle(settings.downloadPreferences[key], (v) =>
        nested("downloadPreferences", key, v),
      ),
    );
  for (const [key, label] of [
    ["cover", "缓存封面"],
    ["lyrics", "缓存歌词"],
    ["metadata", "缓存歌曲信息"],
  ])
    row(
      downloads,
      label,
      toggle(settings.cachePolicy[key], (v) => nested("cachePolicy", key, v)),
    );
  row(
    downloads,
    "流媒体音频缓存",
    select(
      settings.cachePolicy.streamingAudio,
      [
        ["off", "关闭"],
        ["provider", "按音源缓存"],
      ],
      (v) => nested("cachePolicy", "streamingAudio", v),
    ),
  );

  const shortcuts = section(root, "全局快捷键 / SHORTCUTS");
  for (const [key, label] of [
    ["playPause", "播放 / 暂停"],
    ["previous", "上一首"],
    ["next", "下一首"],
    ["volumeUp", "增大音量"],
    ["volumeDown", "减小音量"],
    ["toggleDesktopLyrics", "显示桌面歌词"],
    ["toggleDesktopLyricsLock", "锁定桌面歌词"],
  ]) {
    const field = document.createElement("input");
    field.value = settings.globalShortcutBindings[key] || "";
    row(shortcuts, label, field);
    shortcuts.append(
      button(`保存${label}快捷键`, () =>
        nested("globalShortcutBindings", key, field.value),
      ),
    );
  }
}
