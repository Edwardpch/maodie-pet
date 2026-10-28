# 耄耋（maodie）· 橘猫桌宠 + DSH 插件清单

一只用 AI 视频生成的橘猫桌宠，跑在 [DeepSeek Harness](https://github.com/PC2005-cloud/dsh-pet) 的 `dsh-pet` 插件上：**30 个动作、带透明通道的 VP9-alpha webm、512×512 / 12fps**。

顺带附上一份我在用的 DSH 插件清单，以及把「绿幕视频 → 透明桌宠动画」的整条工具链。

![preview](docs/preview.png)

## 里面有什么

| 路径 | 内容 |
| --- | --- |
| `pets/maodie/` | 桌宠素材包：`maodie-config.json` + 30 个动作 webm |
| `lib/index.js` | 插件宿主半侧：安装时把 `pets/maodie` 幂等落盘到 `$DSH_HOME/dsh-pet/pet/` |
| `package.json` / `cordis.patch.yml` | 插件清单：`dsh.bundle.patch` 指向挂载行 |
| `docs/preview.png` | 30 个动作的总览图（每格取该动作的第 0.6 秒） |
| `docs/maodie-prompts-cat.md` | 20 条猫动作的视频生成提示词（绿幕、10 秒、首尾同姿态） |
| `docs/橘猫后续动作提示词.docx` | 其中 08–20 共 13 条的 Word 版，方便直接发给生成工具 |
| `docs/竖中指参考视频拆解.md` | 「竖中指」梗图参考视频的逐秒拆解 + 绿幕改写版提示词 |
| `tools/maodie-matte.py` | 按色相抠图：把豆包/即梦的灰绿影棚背景抠成 alpha |
| `tools/maodie-check.py` | 体检：尺寸、fps、alpha 通道、绿边残留、循环接缝 |
| `tools/maodie-import.mjs` / `.cmd` | 批量转码 + 自动登记到 config |
| `tools/maodie-ref.png` | 白底参考图，用图生视频时当首帧参考 |
| `dsh-plugins-share.md` / `.json` | 我在用的 12 个 DSH 插件、装法、避坑 |

### 30 个动作

- **待机 / 移动**：待机（10 秒长循环；`animations.idle` 里实际挂了 23 条——基础待机 + 22 条小动作，空闲时轮播）、走路
- **点击回应**：开心、被摸、我真的特别爱你
- **小动作（22）**：睡觉、开心、被摸、舔毛、踩奶、追尾巴、揣手手、打哈欠伸懒腰、东张西望、扒拉杯子、钻进纸箱、打滚晒太阳、抓激光笔、偷吃被抓住、蹭头撒娇、洗脸、扑蝴蝶、看鸟、踩键盘、伸爪拍屏幕、翻肚皮、小猫抖毛
- **生气（5）**：哈气、炸毛、飞机耳、耄耋哆嗦毛、竖中指

## 安装

### 方式一：当插件装（推荐）

本仓库同时是一个 DSH 插件（`package.json` 里声明了 `dsh.bundle`，`lib/index.js` 是宿主半侧）。装上它，素材会自动就位：

```bash
dsh plugin add https://github.com/Edwardpch/maodie-pet
```

或者在插件市场的「发现」页搜 `maodie`。插件加载时做且只做一件事：把 `pets/maodie` 复制到 `%USERPROFILE%/.dsh/dsh-pet/pet/maodie/`。

- 已经存在的 `maodie-config.json` 和 `*.webm` **不会被覆盖**——你手改过的配置、替换过的动作会保留；只补缺失的文件。
- 想强制用仓库版本重刷：`node node_modules/maodie-pet/lib/index.js --install --force`。
- 需要换安装位置（比如自定义了 `DSH_HOME`）：`node node_modules/maodie-pet/lib/index.js --install --home D:\somewhere\.dsh`。

前提仍然是先装 `dsh-pet` 本体（市场里搜 `dsh-pet`）。

### 方式二：手动拷贝

1. 装 DeepSeek Harness 桌面端，并在插件市场里装 `dsh-pet`。
2. 把 `pets/maodie` 整个复制到：

   ```
   %USERPROFILE%/.dsh/dsh-pet/pet/
   ```

   也就是最终得到 `~/.dsh/dsh-pet/pet/maodie/maodie-config.json` 和 `maodie-animation/*.webm`。
3. 刷新页面。默认是桌面宠物（`display: desktop`）；想在网页里显示，把 `maodie-config.json` 里的 `display` 改成 `web` 或 `both`。

只想换掉某几个动作？直接往 `maodie-animation/` 里加同名 webm，再在 `animations` 里登记即可——规则见下。

## 自己做动作

整条链路是：**提示词 → 图生视频（绿幕）→ 按色相抠图 → 体检 → 登记**。

```bash
# 1. 抠图：绿幕/灰绿影棚视频 → 512×512、12fps、VP9-alpha
python tools/maodie-matte.py 输入.mp4 输出.webm

# 可选参数
#   --ss 1.0 --to 6.0        截取片段
#   --fit                    保持整只猫入画，两侧用透明补齐
#   --erase 0,0,512,26       把某个矩形区域的 alpha 清零（去水印）
#   --hi 205 --ramp 8        背景色相带上界/过渡宽度（青绿背景会用到）

# 2. 体检
python tools/maodie-check.py pets/maodie/maodie-animation

# 3. 批量导入 + 自动登记（需要 ffmpeg、python、node）
node tools/maodie-import.mjs ./我的视频 --register --category 小动作
```

### 写 config 的坑

动作挂在 `animations.categories` 里，**不是** `animations` 的顶层键：

```json
"categories": [
  { "id": "小动作", "weight": 20, "actions": ["睡觉", "舔毛"] },
  { "id": "生气",   "weight": 10, "actions": ["哈气"] }
]
```

另外 `clicks` 是点击宠物时播的，`events.whisper` / `events.workStatus` 分别对应「悄悄话」和「工作状态」触发。改完刷新页面（桌面端右键宠物 →「重载配置」）。

## 已知问题

- **道具会半透明**：`踩键盘`、`扒拉杯子`、`钻进纸箱` 里的键盘/杯子/纸箱在源视频里本身就是半透明生成的，抠图只是如实保留，不是抠像失败。
- **首尾接缝**：`打哈欠伸懒腰` 的首尾帧差 12.9（其余多在 4–7），循环播放时可能有轻微跳变。
- **猫的大小不统一**：各片段是独立生成的，猫在画面里的占比略有差别；介意的话可以按不透明像素包围盒统一缩放后再贴底。

## 工具链依赖

- `ffmpeg`（需要 `libvpx-vp9`；读 alpha 时把 `-c:v libvpx-vp9` 放在 `-i` 之前）
- Python 3 + `numpy` + `Pillow`
- Node.js 18+（只有 `maodie-import.mjs` 用到）

## 致谢与许可

- 桌宠运行时：[`dsh-pet`](https://github.com/PC2005-cloud/dsh-pet)（动作提示词库也来自这个仓库的 `prompts/`）
- 素材由 AI 视频模型生成，再经本项目脚本抠像、裁切、转码
- 代码与素材以 [MIT](LICENSE) 许可发布；如果要用在自己的项目里，保留出处即可
