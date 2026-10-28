# 提交到 DSH 插件市场

市场「发现」页的数据来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库的
`data/plugins/*.yml`，一个插件一个文件。收录靠 PR，不靠发布 npm 包。

贡献指南（PR 模板里的检查项都出自这里）：
<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

## 提交用的条目

复制成 `data/plugins/Edwardpch__maodie-pet.yml`：

```yaml
url: https://github.com/Edwardpch/maodie-pet
name: Edwardpch/maodie-pet
category: fun
description:
  en: An orange-tabby desktop pet for dsh-pet — 30 transparent VP9-alpha actions, 512×512 @ 12fps, with the matte/QA toolchain that produced them.
  zh: 橘猫桌宠「耄耋」——30 个透明动作（512×512 / 12fps / VP9-alpha），附抠像与体检工具链。
icon: https://raw.githubusercontent.com/Edwardpch/maodie-pet/main/assets/icon-180.png
```

## 会被 CI 挡掉的点（按 CI 顺序）

1. **条目数**：一个 PR 最多加 3 个 YAML。
2. **`dsh.bundle`**：`package.json` 必须声明可安装的 bundle（本仓库已满足）：

   ```json
   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
   ```

   只有 `dsh.client` 不算插件，这是最常见的被拒原因。
3. **仓库年龄**：仓库要创建满 1 天（CI 自动检查 `created_at`）。
4. **awesome-lint / 站点构建**：字段拼写、分类取值（`fun` 合法）、链接可访问。

另外建议在仓库设置里加 topic：`dsh-plugin`、`deepseek-harness`、`dsh-pet`。

## 提交前自检

```bash
# 1. 素材能装进一个空 DSH_HOME
node lib/index.js --install --home /tmp/maodie-check

# 2. 再跑一次应当是 up-to-date（幂等）
node lib/index.js --install --home /tmp/maodie-check
```

## 提 PR 之后

PR 合并即出现在市场的「发现」页，索引里 `install` 字段会指向本仓库；
用户点安装等价于 `dsh plugin add https://github.com/Edwardpch/maodie-pet`。
