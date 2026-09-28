# 人工审核插件投稿

希望自动进入“社区插件”列表时，开发者只需给公开 GitHub 仓库添加 `twilight-echo-plugin` Topic，并在最新 Release 发布一个 `<插件 ID>-<版本>.tep`；包内 `plugin.json.repository` 必须为该仓库地址，Release 标签须为 `<版本>` 或 `v<版本>`。定时扫描会校验安装包并更新市场索引。自动发现条目显示“未验证”，无需提交本目录的 PR。

下述流程用于申请人工审核收录，审核记录优先于同 ID 的自动发现条目。

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

`repository` 必须与包内 `plugin.json` 一致。`sourceUrl` 的仓库、包名和版本必须与登记值一致。提交 Pull Request 前运行 `pnpm run index` 和 `pnpm run validate:index`，并提交生成的根目录 `plugins.json`。CI 会下载安装包并核对哈希与 manifest；维护者再审核 README、权限、基本功能与音源合规情况。既有插件更新须保持插件 ID 和发布仓库，换仓库需要单独由维护者处理。

收录意味着目录已经人工审核；未签名条目在应用里显示“索引声明”。“官方验证”仍由应用现有的有效签名规则决定。
