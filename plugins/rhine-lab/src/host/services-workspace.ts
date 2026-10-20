import { callHost } from "./bridge";

type Controls = {
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
};

export function createServicePages(ui: Controls) {
  const { button, section, row, select, toggle } = ui;
  function input(root: HTMLElement, label: string, value = "", type = "text") {
    const el = document.createElement("input");
    el.type = type;
    el.value = value;
    el.autocomplete = "off";
    row(root, label, el);
    return el;
  }
  function note(root: HTMLElement, text: string) {
    const p = document.createElement("p");
    p.className = "host-note";
    p.textContent = text;
    root.append(p);
    return p;
  }
  function disclosure(root: HTMLElement, title: string) {
    const el = document.createElement("details");
    el.className = "panel-section";
    const summary = document.createElement("summary");
    summary.textContent = title;
    el.append(summary);
    root.append(el);
    return el;
  }
  function empty(root: HTMLElement, message: string) {
    if (!root.childElementCount) note(root, message);
  }

  async function radio(root: HTMLElement) {
    const stations = await callHost<any[]>("radio.list");
    root.replaceChildren();
    const create = disclosure(root, "添加电台 / ADD STATION");
    const name = input(create, "电台名称"),
      url = input(create, "流媒体地址", "", "url");
    const insecure = toggle(false, () => {});
    row(create, "允许 HTTP 明文流", insecure);
    create.append(
      button("添加电台", async () => {
        await callHost("radio.add", {
          name: name.value,
          url: url.value,
          allowInsecureHttp: insecure.checked,
        });
        await radio(root);
      }),
    );
    const discover = disclosure(root, "搜索电台目录 / DISCOVER");
    const query = input(discover, "电台关键词");
    const results = document.createElement("div");
    discover.append(
      button("搜索电台", async () => {
        const found = await callHost<any[]>("radio.search", {
          query: query.value,
        });
        results.replaceChildren();
        for (const s of found) {
          const line = section(results, s.name);
          note(
            line,
            [s.countryCode, s.codec, s.bitrate ? s.bitrate + " kbps" : ""]
              .filter(Boolean)
              .join(" · "),
          );
          const allow = toggle(false, () => {});
          if ((s.urlResolved || s.url).startsWith("http:"))
            row(line, "允许 HTTP 明文流", allow);
          line.append(
            button("收藏电台", async () => {
              await callHost("radio.add", {
                name: s.name,
                url: s.urlResolved || s.url,
                allowInsecureHttp: allow.checked,
              });
              await radio(root);
            }),
          );
        }
        empty(results, "没有匹配的电台");
      }),
      results,
    );
    const imports = disclosure(root, "导入 M3U / PLS");
    const content = document.createElement("textarea");
    content.rows = 5;
    row(imports, "播放列表内容", content);
    const allow = toggle(false, () => {});
    row(imports, "允许 HTTP 明文流", allow);
    imports.append(
      button("导入电台", async () => {
        await callHost("radio.import", {
          content: content.value,
          allowInsecureHttp: allow.checked,
        });
        await radio(root);
      }),
    );
    const list = section(root, "我的电台 / STATIONS");
    if (!stations.length) note(list, "还没有收藏电台。添加地址或从目录搜索。");
    for (const s of stations) {
      const line = document.createElement("div");
      line.className = "host-track";
      const play = button(s.name, () => callHost("radio.play", { id: s.id }));
      play.className = "host-track-name";
      line.append(
        play,
        button("移除", async () => {
          await callHost("radio.remove", { id: s.id });
          await radio(root);
        }),
      );
      list.append(line);
    }
  }

  async function podcasts(root: HTMLElement) {
    const subscriptions = await callHost<any[]>("podcasts.list");
    root.replaceChildren();
    const create = section(root, "播客订阅 / PODCASTS");
    const url = input(create, "RSS 地址", "", "url");
    create.append(
      button("订阅", async () => {
        await callHost("podcasts.subscribe", { url: url.value });
        await podcasts(root);
      }),
    );
    if (!subscriptions.length)
      note(root, "订阅播客后，在这里浏览节目和继续收听。");
    for (const s of subscriptions) {
      const group = disclosure(root, `${s.title} · ${s.count} 期`);
      const episodes = document.createElement("div");
      let loaded = false;
      const load = async () => {
        const data = await callHost<any[]>("podcasts.episodes", { id: s.id });
        episodes.replaceChildren();
        for (const e of data) {
          const line = document.createElement("div");
          line.className = "host-track";
          const play = button(e.title, () =>
            callHost("podcasts.play", { id: s.id, guid: e.guid }),
          );
          play.className = "host-track-name";
          const progress = document.createElement("small");
          progress.textContent = e.progress
            ? `已收听 ${Math.floor(e.progress / 60)} 分钟`
            : "未收听";
          play.append(progress);
          line.append(play);
          episodes.append(line);
        }
        empty(episodes, "暂时没有节目");
        loaded = true;
      };
      group.append(
        button("加载节目", load),
        button("更新订阅", async () => {
          await callHost("podcasts.refresh", { id: s.id });
          await load();
        }),
        button("取消订阅", async () => {
          await callHost("podcasts.remove", { id: s.id });
          await podcasts(root);
        }),
        episodes,
      );
      group.addEventListener("toggle", () => {
        if (group.open && !loaded)
          group.querySelector<HTMLButtonElement>("button")?.click();
      });
    }
  }

  async function network(root: HTMLElement) {
    const profiles = await callHost<any[]>("network.profiles");
    root.replaceChildren();
    const create = disclosure(root, "添加网络音乐源 / CONNECT");
    const name = input(create, "连接名称");
    const protocol = select(
      "webdav",
      ["webdav", "ftp", "ftps", "sftp", "scp", "smb", "nfs", "dlna"].map(
        (p) => [p, p.toUpperCase()],
      ),
      () => {},
    );
    row(create, "协议", protocol);
    const host = input(create, "服务器地址"),
      path = input(create, "根目录", "/"),
      port = input(create, "端口（留空使用默认值）", "", "number");
    const auth = select(
      "anonymous",
      [
        ["anonymous", "匿名"],
        ["password", "用户名与密码"],
        ["privateKey", "私钥"],
      ],
      () => {
        passwordRow.hidden = auth.value !== "password";
        keyRow.hidden = auth.value !== "privateKey";
      },
    );
    row(create, "认证方式", auth);
    const username = input(create, "用户名");
    const password = input(create, "密码", "", "password"),
      passwordRow = password.parentElement!;
    const key = input(create, "私钥文件路径"),
      keyRow = key.parentElement!;
    passwordRow.hidden = true;
    keyRow.hidden = true;
    create.append(
      button("保存连接", async () => {
        await callHost("network.create", {
          profile: {
            name: name.value,
            protocol: protocol.value,
            host: host.value,
            rootPath: path.value,
            port: port.value ? Number(port.value) : null,
            username: username.value,
            auth:
              auth.value === "password"
                ? { kind: "password", password: password.value }
                : auth.value === "privateKey"
                  ? { kind: "privateKey", keyPath: key.value }
                  : { kind: "anonymous" },
          },
        });
        password.value = "";
        await network(root);
      }),
    );
    if (!profiles.length)
      note(root, "还没有网络音乐源。支持 NAS、WebDAV 和局域网媒体服务器。");
    for (const p of profiles) {
      const group = disclosure(root, `${p.name} / ${p.protocol.toUpperCase()}`);
      const path = input(group, "目录", p.rootPath || "/");
      const result = note(group, ""),
        list = document.createElement("div");
      let request = 0;
      const browse = async (library = false) => {
        const serial = ++request;
        const items = await callHost<any[]>(
          library ? "network.library" : "network.browse",
          { id: p.id, path: path.value },
        );
        if (serial !== request || !list.isConnected) return;
        list.replaceChildren();
        for (const entry of items) {
          if (!["directory", "audio"].includes(entry.kind)) continue;
          const b = button(
            (entry.kind === "directory" ? "↳ " : "") +
              (entry.metadata?.title || entry.name),
            async () => {
              if (entry.kind === "directory") {
                path.value = entry.path;
                await browse();
              } else await callHost("network.play", { id: entry.id });
            },
          );
          b.className = "host-track-name";
          const line = document.createElement("div");
          line.className = "host-track";
          line.append(b);
          list.append(line);
        }
        empty(list, "此目录没有可用的音乐或子目录");
      };
      group.append(
        button("测试连接", async () => {
          const r = await callHost("network.test", { id: p.id });
          result.textContent = r.ok
            ? "连接成功"
            : `连接失败：${r.errorCode || "未知错误"}`;
        }),
        button("打开目录", () => browse()),
        button("已扫描音乐", () => browse(true)),
        button("扫描目录", async () => {
          const r = await callHost("network.scan", {
            id: p.id,
            path: path.value,
          });
          result.textContent = `已添加 ${r.added} 首，共 ${r.total} 首`;
          await browse(true);
        }),
        button("移除连接", async () => {
          await callHost("network.remove", { id: p.id });
          await network(root);
        }),
        list,
      );
    }
  }

  async function stats(root: HTMLElement) {
    const data = await callHost("stats.read");
    root.replaceChildren();
    root.append(button("刷新统计", () => stats(root)));
    const totals = section(root, "聆听记录 / LISTENING");
    totals.classList.add("host-stats");
    const seconds = Object.values(data.days as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    note(totals, `${(seconds / 3600).toFixed(1)} 小时`);
    note(totals, `${Object.keys(data.days).length} 个聆听日`);
    const activity = section(root, "最近 30 天");
    const chart = document.createElement("div");
    chart.className = "host-activity";
    const days = Array.from({ length: 30 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - 29 + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return { key, seconds: data.days[key] || 0 };
    });
    const max = Math.max(1, ...days.map((d) => d.seconds));
    for (const d of days) {
      const bar = document.createElement("div");
      bar.title = `${d.key} · ${Math.round(d.seconds / 60)} 分钟`;
      bar.setAttribute("aria-label", bar.title);
      bar.style.height = `${Math.max(2, (d.seconds / max) * 100)}%`;
      chart.append(bar);
    }
    activity.append(chart);
    for (const [title, items] of [
      ["常听曲目", data.top],
      ["最近播放", data.recent],
    ] as const) {
      const list = section(root, title);
      if (!items.length) note(list, "开始播放后，这里会显示你的聆听记录。");
      for (const item of items)
        note(
          list,
          `${item.title} · ${item.artist} / ${item.plays} 次 · ${Math.round(item.seconds / 60)} 分钟`,
        );
    }
  }

  async function diagnostics(root: HTMLElement) {
    const data = await callHost("diagnostics.status");
    root.replaceChildren();
    const state = section(root, "运行诊断 / DIAGNOSTICS");
    note(
      state,
      `${data.files} 个日志文件 · ${(data.bytes / 1024 / 1024).toFixed(1)} MiB`,
    );
    note(
      state,
      data.error ||
        (data.lastWriteAt
          ? `最近写入：${new Date(data.lastWriteAt).toLocaleString()}`
          : "尚无日志"),
    );
    const issue = input(state, "问题描述");
    const result = note(state, "");
    state.append(
      button("标记问题", async () => {
        await callHost("diagnostics.mark", { note: issue.value });
        result.textContent = "问题已标记";
      }),
      button("导出诊断包", async () => {
        const r = await callHost("diagnostics.export");
        result.textContent = r.saved ? "诊断包已保存" : "已取消导出";
      }),
    );
  }
  async function themes(root: HTMLElement) {
    const data = await callHost("themes.list");
    root.replaceChildren();
    if (!data.enabled) {
      note(root, "请启用内置的“主题插件工坊”以创建和编辑主题。");
      root.append(
        button("启用主题插件工坊", async () => {
          await callHost("plugins.enable", {
            id: "com.twilightecho.tool.theme-workshop",
          });
          await themes(root);
        }),
      );
      return;
    }
    const create = section(root, "主题项目 / THEMES");
    note(
      create,
      "编辑宿主主题的配色与参数。莱茵三维场景的画面设置仍在首页的“画面与声音”中。",
    );
    const template = select(
      data.templates[0].id,
      data.templates.map((t: any) => [t.id, t.name]),
      () => {},
    );
    row(create, "模板", template);
    create.append(
      button("新建主题", async () => {
        await callHost("themes.create", { template: template.value });
        await themes(root);
      }),
      button("导入主题项目", async () => {
        await callHost("themes.import");
        await themes(root);
      }),
    );
    for (const p of data.projects) {
      const group = disclosure(root, p.name);
      const editor = document.createElement("div");
      group.append(
        button("编辑配色与参数", async () => {
          const project = await callHost("themes.read", { id: p.id });
          let revision = project.revision;
          let writes: Promise<unknown> = Promise.resolve();
          editor.replaceChildren();
          const fields = document.createElement("div");
          const tone = select(
            "pureWhite",
            [
              ["pureWhite", "浅色"],
              ["dark", "深色"],
            ],
            () => renderFields(),
          );
          row(editor, "编辑模式", tone);
          const result = note(editor, "");
          const update = (control: any, value: string) => {
            const selectedTone = tone.value;
            const task = writes.then(async () => {
              const saved = await callHost("themes.edit", {
                id: p.id,
                revision,
                control: control.id,
                tone: selectedTone,
                value,
              });
              revision = saved.revision;
              project.values[selectedTone][control.id] = value;
              result.textContent = "已保存";
            });
            writes = task.catch(() => {});
            return task;
          };
          const renderFields = () => {
            fields.replaceChildren();
            const groups = new Map<string, HTMLElement>();
            for (const c of project.controls) {
              let group = groups.get(c.group);
              if (!group) {
                group = section(fields, c.group);
                groups.set(c.group, group);
              }
              const value =
                project.values[tone.value][c.id] ?? c.defaults[tone.value];
              if (c.type === "boolean")
                row(
                  group!,
                  c.label,
                  toggle(value === (c.checkedValue || "1"), (checked) =>
                    update(
                      c,
                      checked ? c.checkedValue || "1" : c.uncheckedValue || "0",
                    ),
                  ),
                );
              else if (c.type === "select")
                row(
                  group!,
                  c.label,
                  select(
                    value,
                    c.options.map((v: string) => [v, v]),
                    (v) => update(c, v),
                  ),
                );
              else {
                const field = input(group!, c.label, value);
                if (c.type === "color" && /^#[0-9a-f]{6}$/i.test(value))
                  field.type = "color";
                if (c.type === "number") {
                  field.type = "number";
                  field.value = String(parseFloat(value));
                  field.min = String(c.min ?? 0);
                  field.max = String(c.max ?? 10000);
                  field.step = String(c.step ?? 1);
                }
                group!.append(
                  button(`保存${c.label}`, () => {
                    if (!field.reportValidity()) return;
                    return update(
                      c,
                      field.value + (c.type === "number" ? c.unit || "" : ""),
                    );
                  }),
                );
              }
            }
          };
          editor.append(
            button("应用到默认界面", async () => {
              await writes;
              await callHost("themes.apply", { id: p.id, revision });
              result.textContent = "已应用到默认界面";
            }),
            button("导出主题插件", async () => {
              await writes;
              const r = await callHost("themes.export", {
                id: p.id,
                revision,
                format: "tep",
              });
              result.textContent = r.saved ? "主题插件已保存" : "已取消导出";
            }),
            button("导出项目", async () => {
              await writes;
              const r = await callHost("themes.export", {
                id: p.id,
                revision,
                format: "project",
              });
              result.textContent = r.saved ? "项目已保存" : "已取消导出";
            }),
            fields,
          );
          renderFields();
        }),
        editor,
      );
    }
  }
  return { radio, podcasts, network, stats, diagnostics, themes };
}
