# 插件目录投稿

**自动发现无需提交 PR。**开发者在自己的公开 GitHub 仓库保留源码和 README，在最新 Release 附带唯一的 `<插件 ID>-<版本>.tep`（不超过 50 MiB），并添加 `twilight-echo-plugin` Topic。包内 `plugin.json.repository` 必须精确等于该仓库 URL，Release 标签须为 `<版本>` 或 `v<版本>`。定时扫描更新市场索引，条目显示“社区插件 / 未验证”。完整发布步骤见[仓库 README](../README.md#publish-an-independent-plugin)。

本目录用于**申请人工审核收录**。审核记录优先于同 ID 的自动发现条目；`community.json` 由工作流维护，不接受手工投稿。

每款外部插件用一个 `<插件 ID>.json` 文件登记。插件源码、README 和 `.tep` 安装包保留在开发者自己的公开仓库；`.tep` 作为 GitHub Release 资产发布。示例：

```json
{
  "id": "com.example.lyrics",
  "version": "1.0.0",
  "repository": "https://github.com/example/twilight-lyrics",
  "sourceUrl": "https://github.com/example/twilight-lyrics/releases/download/v1.0.0/com.example.lyrics-1.0.0.tep",
  "checksumSha256": "<64 位十六进制 SHA-256>",
  "tags": ["lyrics", "tool"]
}
```

先确保 GitHub Release 资产可公开下载。`repository` 必须与包内 `plugin.json` 一致；`sourceUrl` 的仓库、包名和版本必须与登记值一致；`checksumSha256` 是实际 `.tep` 文件的 SHA-256。可在插件仓库运行 `sha256sum dist/<插件 ID>-<版本>.tep`，Windows PowerShell 则运行 `Get-FileHash dist\<插件 ID>-<版本>.tep -Algorithm SHA256`，将输出的 64 位哈希填入记录。

向目录仓库提交 Pull Request 前，安装其锁定依赖并生成、验证索引：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run index
pnpm run validate:index
```

把新增的 `catalog/<插件 ID>.json` 和生成的根目录 `plugins.json` 一起提交。CI 会下载安装包并核对哈希与 manifest；维护者再审核 README、权限、基本功能与音源合规情况。既有插件更新须保持插件 ID 和发布仓库，换仓库需要单独由维护者处理。

收录意味着目录已经人工审核；未签名条目在应用里显示“索引声明”。“官方验证”仍由应用现有的有效签名规则决定。更新已审核插件时，发布新版本 `.tep` 并更新同一个 `catalog/<插件 ID>.json`，再次提交 PR。
