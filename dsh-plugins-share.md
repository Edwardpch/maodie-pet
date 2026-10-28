# DSH 插件配置分享包（desktop profile）

- 导出时间：2026-10-27
- 本机 DSH：DeepSeek Harness 0.2.1-rc.3（注册表 DisplayVersion 核实）
- profile：`%USERPROFILE%/.dsh/profiles/desktop`
- 清单来源：`/dsh-market/installed` + profile 的 `package.json`；当前 12 个插件全部 `live`、`disabled: []`

## 一、最短路径（推荐）

1. 对方安装**同一条版本线**的 DSH 桌面端（本机为 0.2.1-rc.3）。
2. 打开 **插件 → 插件市场**，按下面的清单逐个搜索安装。
3. 全部装完重启 DSH（桌面端的组合由宿主重放，装完通常提示重启）。

> 桌面端 profile 由宿主管理，**不要**用 `dsh plugin` CLI 直接改桌面 profile（市场文档明确说明：桌面版只能用应用内插件页）。

## 二、插件清单（12 个）

| # | 市场里搜 | npm 包 | 版本 | 仓库 | 作用 |
|---|----------|--------|------|------|------|
| 1 | dsh-market | `dshmarket` | 1.69.0 | https://github.com/dsh-market/dsh-market | 插件市场本体（装/更/备份恢复） |
| 2 | dsh-ops | `dsh-ops` | 0.4.1 | https://github.com/t-auto/dsh-ops | Windows 原生文件/PTC 工具集 |
| 3 | dsh-skin-market | `dsh-skin-market` | 0.1.67 | https://github.com/kingofsoysauce/dsh-skin-market | 皮肤市场与生命周期管理 |
| 4 | liang-intensity-skin | `@leon___/dsh-client-liang-intensity-skin` | 0.1.12 | https://github.com/kingofsoysauce/dsh-liang-skin | 皮肤 + 自适应推理滑杆 |
| 5 | dsh-git-graph | `dsh-git-graph` | 0.1.8 | https://github.com/enoughpower/dsh-git-graph | Git 提交图 / 文件历史 / `/git` JSON API |
| 6 | dsh-skills-manager | `@michengai/dsh-skills-manager` | 1.2.19 | https://github.com/michengai/dsh-skills-manager | Agent Skills 统一管理 |
| 7 | DSH-better-sidebar | `dsh-better-sidebar` | 0.28.0 | https://github.com/omdsh-dev/dsh-better-sidebar | 文件树/编辑器/变更/任务/侧聊一列 |
| 8 | beauticode | `beauticode-dsh` | 1.0.30 | https://github.com/starsstreaming/beauticode/tree/main/integrations/deepseek-harness | 网页图片/视频背景、摸鱼模式 |
| 9 | dsh-pet | `dsh-pet` | 0.3.8 | https://github.com/pc2005-cloud/dsh-pet | 桌面宠物 |
| 10 | modlens | `@liustack/modlens` | 3.27.2 | https://github.com/liustack/modlens | 图像理解桥（给纯文本模型读图） |
| 11 | billion-context | `billion-context` | 0.1.208 | https://github.com/ranxianglei/billion-context | 上下文压缩（本轮对话正在用） |
| 12 | dsh-context | `dsh-context` | 0.77.0 | https://github.com/bowenliang123/dsh-context | 上下文仪表盘与压缩管理 |

## 三、命令行安装（仅 `dsh web` profile）

```bash
dsh plugin --profile web add \
  dshmarket@1.69.0 dsh-ops@0.4.1 dsh-skin-market@0.1.67 \
  @leon___/dsh-client-liang-intensity-skin@0.1.12 \
  dsh-git-graph@0.1.8 @michengai/dsh-skills-manager@1.2.19 \
  dsh-better-sidebar@0.28.0 beauticode-dsh@1.0.30 dsh-pet@0.3.8 \
  @liustack/modlens@3.27.2 billion-context@0.1.208 dsh-context@0.77.0
```

## 四、想连配置一起给：用市场的「备份与恢复」

入口：**插件 → 插件市场 → 备份与恢复**（导出备份 / 导入并预览，可「选择要导出的插件」）。

对方：同入口 → 导入并预览 → 确认。

⚠️ 这是**覆盖式克隆**，不是合并：恢复会逐个文件直接写入（`dshmarket/lib/backup.js:179-210`，临时文件后 `rename` 覆盖），包括 `package.json` 和 `cordis.patch.yml`。我这份 `cordis.patch.yml` 里有：

- `my-deepseek.baseURL: http://127.0.0.1:<cc-switch 代理端口>` —— 本机 cc-switch 代理；
- `http://<内网网关地址>:<端口>` —— 内网模型网关。

对方直接导入，模型会连不上。导入前把这两处改成对方自己的地址；或者干脆别用备份，只发清单。

导出前建议在 JSON 里搜一遍 `127.0.0.1`、`192.168.`、`sk-`、`token`、`apiKey`，确认没有不该外发的凭据（备份会带上 profile 根目录的配置文件，跳过 `node_modules`、`.dsh-market`、`.git`、`pnpm-lock.yaml`、`*.bak`）。

## 五、只想要最初那 6 个（最小集）

`dsh-better-sidebar`、`dsh-skills-manager`、`dsh-context`、`dsh-git-graph`、`billion-context`、`modlens`。

另外 6 个（市场、皮肤、宠物、背景、运维、liang 皮肤）属于锦上添花，可按需装。

## 六、直接转发的话（复制即用）

> 我这边 DSH 配了一套插件，清单和版本见附件 `dsh-plugins-share.md`。
> 你先装 DeepSeek Harness 0.2.1-rc.3（同一条版本线），然后在「插件 → 插件市场」里按清单搜装，装完重启。
> 最小集是这 6 个：dsh-better-sidebar、dsh-skills-manager、dsh-context、dsh-git-graph、billion-context、modlens。
> 如果想连配置一起复制，用市场的「备份与恢复」导出/导入，但导入前要把备份里的模型地址改成你自己的，不然连不上。

## 七、注意

- 这些是第三方插件，装前看一眼仓库的 capabilities/权限说明；`billion-context` 会额外调用 LLM 做摘要，`modlens` 需要配置图像引擎。
- 版本别乱跳：插件诊断会检查 DSH 版本范围，跨大版本可能出警告。
- 不要直接拷 `~/.dsh/profiles/desktop` 整个目录：`node_modules` 数百 MB、路径绑定，而且宿主可能拒绝外部写入的 profile。
- 更全的选型参考见 `dsh-plugins-recommended.md`（6565 个社区插件里按下载量和场景筛的）。

## 八、桌宠「耄耋」素材包（pets/maodie）

只装 `dsh-pet` 插件是看不到这只橘猫的，素材要单独放。这个文件夹里的 `pets/maodie/` 就是完整素材包：

```
pets/maodie/
├─ maodie-config.json          # 配置：名字「橘猫」、id maodie、size 400、位置右下角
└─ maodie-animation/           # 6 个动作，VP9-alpha webm，512×512
   ├─ 待机.webm  ├─ 睡觉.webm  ├─ 走路.webm
   ├─ 开心.webm  ├─ 被摸.webm  ├─ 哈气.webm
```

**安装**：把 `pets/maodie` 整个复制到

```
%USERPROFILE%/.dsh/dsh-pet/pet/
```

也就是最终变成 `~/.dsh/dsh-pet/pet/maodie/maodie-config.json`。然后刷新 DSH 页面（桌面端右键宠物 →「重载配置」）。

**改显示方式**：`maodie-config.json` 里 `display` 字段：`desktop`（只桌面）/ `web`（只网页）/ `both`（都显示）/ `none`（都不显示）。对方没开桌面模式就改成 `web` 或 `both`。

**想加新动作**：`extras/` 里有参考图 `maodie-ref.png`、20 条豆包提示词 `maodie-prompts-cat.md`，以及转码脚本 `maodie-import.mjs`（绿幕 mp4 → VP9-alpha webm 并自动登记）。脚本需要本机有 Node 和 ffmpeg。

> 注意：这只猫的素材是我按自己的审美生成的（写实 3D 风橘猫），不是 dsh-pet 自带素材；和插件升级无关，升级不会覆盖 `~/.dsh/dsh-pet/pet/` 下的自定义宠物。
