# 发布到插件市场

市场（[DSH Plugin Market](https://github.com/realguan/dsh-plugin-market) 与
[dsh-market](https://github.com/dsh-market/dsh-market)）**不托管插件代码**。它的索引只记录
「从哪装」：一个 npm 包，或一个 GitHub 仓库 + 钉死的 commit。所以"发布"分两步：

1. **把插件托管到 GitHub**（本仓库）——让它在技术上可安装
2. **向榜单提一个 PR**——让它出现在市场里

索引的数据来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
两份市场都从那里转。**没有"往市场里投稿"这个动作，只有往榜单提 PR。**

---

## 第 0 步：前置检查（已全部通过）

| 要求 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ `{ "bundle": { "patch": "./cordis.patch.yml" } }` |
| 版本是精确 SemVer | ✅ `1.0.0` |
| `private` 已去掉 | ✅ |
| `@deepseek-ai/*` 作 peer 依赖 | ✅ `schemastery` |
| `keywords` 含 `dsh-plugin` | ✅ |
| 真实可跑的代码 | ✅ 19 个测试 |
| 许可证与三方声明 | ✅ `LICENSE` + `THIRD-PARTY-NOTICES.md` |
| 能打包 | ✅ `pnpm pack` → 2.3 MB / 1400 条目 |

仓库还需要**创建满 1 天**才会通过 CI 的年龄检查。今天建、今天提 PR 会被自动挡下——
CI 会在几小时后自动重跑，不需要推空提交。

---

## 第 1 步：建仓并推送

```powershell
# 变量换成你自己的
$owner = "你的GitHub用户名"
$token = "ghp_xxxxxxxx"      # 需要 repo 权限（classic）或 Contents+PR 权限（fine-grained）

cd "$env:USERPROFILE\Documents\deepseek-harness\default-workspace\dsh-bmad-method"

# 建远端仓库（私有改成 "private": false 即公开；市场要求公开）
$body = '{"name":"dsh-bmad-method","description":"BMad Method 6.12.4 for dsh: 90 skills, one _bmad/ per project","private":false,"has_issues":true}'
Invoke-RestMethod -Method Post "https://api.github.com/user/repos" `
  -Headers @{ Authorization = "Bearer $token"; "User-Agent" = "dsh" } `
  -ContentType "application/json" -Body $body

# 推送（把 token 放进 URL，只此一次，不写进 config）
git remote add origin "https://$token@github.com/$owner/dsh-bmad-method.git"
git branch -M main
git push -u origin main

# 清掉 remote 里的 token
git remote set-url origin "https://github.com/$owner/dsh-bmad-method.git"
```

### 建完立刻做两件事

1. **加 topic `dsh-plugin`**（榜单要求）：
   ```powershell
   Invoke-RestMethod -Method Put "https://api.github.com/repos/$owner/dsh-bmad-method/topics" `
     -Headers @{ Authorization = "Bearer $token"; "User-Agent" = "dsh"; Accept = "application/vnd.github+json" } `
     -ContentType "application/json" -Body '{"names":["dsh-plugin","dsh","deepseek-harness","bmad","skills"]}'
   ```
2. **填 `repository` 字段**（发布到 npm 时用于关联；现在先填上）：
   ```powershell
   # package.json 里加
   # "repository": { "type": "git", "url": "git+https://github.com/$owner/dsh-bmad-method.git" },
   # "homepage": "https://github.com/$owner/dsh-bmad-method#readme",
   ```

---

## 第 2 步：提收录 PR

条目文件已经能自动生成：

```powershell
node scripts/publish-kit.mjs $owner
```

它会写出两个文件：

- `data-plugins/<owner>__dsh-bmad-method.yml` —— 要放进榜单仓库的条目
- `data-plugins/PR.md` —— PR 描述

然后：

```powershell
# fork + clone 榜单仓库
$gh = "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"
Invoke-RestMethod -Method Post "https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/forks" `
  -Headers @{ Authorization = "Bearer $token"; "User-Agent" = "dsh" }

git clone "https://$token@github.com/$owner/awesome-dsh-plugin.git" "$env:TEMP\awesome"
cd "$env:TEMP\awesome"
git checkout -b add-dsh-bmad-method

# 只加这一个文件 —— 不要动 README（它是生成的）
node scripts/publish-kit.mjs $owner     # 在插件目录里再跑一次，取输出
Copy-Item "<插件目录>\data-plugins\${owner}__dsh-bmad-method.yml" "data/plugins/"

git add "data/plugins/${owner}__dsh-bmad-method.yml"
git commit -m "Add ${owner}/dsh-bmad-method"
git push origin add-dsh-bmad-method

# 开 PR
$pr = @{
  title = "Add ${owner}/dsh-bmad-method"
  head  = "${owner}:add-dsh-bmad-method"
  base  = "main"
  body  = (Get-Content "<插件目录>\data-plugins\PR.md" -Raw)
} | ConvertTo-Json
Invoke-RestMethod -Method Post "https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls" `
  -Headers @{ Authorization = "Bearer $token"; "User-Agent" = "dsh" } `
  -ContentType "application/json" -Body $pr
```

---

## 第 3 步：等索引重建

| 来源 | 生效时间 |
| --- | --- |
| GitHub Pages（`realguan.github.io/dsh-plugin-market/dsh-index.json`） | 约 10 分钟 |
| jsDelivr（`cdn.jsdelivr.net/gh/realguan/dsh-plugin-market@dist/...`） | 最长 12 小时 |
| 榜单 README / 网站 | 合并后自动重建 |

索引每天 03:17 UTC 重建。之后在 dsh 里 **插件 → 发现** 就能搜到。

---

## 可选：同时发 npm（拿到下载量统计）

收录**不依赖** npm。但发了 npm 之后，卡片会显示下载量并可按下量排序。

```powershell
# 登录一次（走浏览器）
npm login

# 发版
npm publish --access public
```

npm 包的 `repository` 必须指回同一个 GitHub 仓库，否则两者不会关联（这是榜单的防冒充规则）。

---

## 注意事项

- **一天最多提 3 条**条目；这里只有 1 条。
- **只改自己那一个文件**。README 是生成物，手改会撞别人的行。
- **描述必须属实**。上面 PR 描述里每个数字都标了在哪能核出来（`ls skills`、
  `skills/manifest.json`、`index.js`）。夸大是被打回的主因。
- **仓库要活跃维护**。长期停更会被扫描标记并移除。
- 首次 PR 可能被要求改描述措辞，那是常态，不是拒绝。

---

## 当前状态

| 项 | 状态 |
| --- | --- |
| 代码、测试、许可证、三方声明 | ✅ 完成 |
| git 仓库与首次提交 | ✅ 完成 |
| 发布清单修正（private / peer / keywords / files） | ✅ 完成 |
| 条目 YAML 与 PR 描述生成脚本 | ✅ 完成 |
| **GitHub 仓库** | ✅ https://github.com/jiaxinchayedan/dsh-bmad-method |
| **收录 PR** | ✅ https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18075 |

### 已经做过的验证

- 从 GitHub **全新克隆**后 `pnpm install` + 跑测试：19/19 通过
- 克隆后 90 个 skill 齐全，`.gitattributes` 生效（SKILL.md 仍是 LF，未被改写成 CRLF）
- 公开访问：仓库页与 PR 页均 HTTP 200（不带 token）
- 条目自检 17 项全过：`dsh.bundle` 就位、版本精确 SemVer、非 private、`dsh-plugin` topic、
  描述里"90 skills / 7 modules / 4 tools"逐个对着代码核过
- PR 只改 1 个文件（+6 行），符合"只改自己那一条"的规则
- 榜单 CI 前 15 步（含 `awesome-lint`、README 一致性、路径与 npm 身份检查）全部 success

### 剩下的就是等

CI 的 `Build (locale parity, date derivation, templates)` 一步在重建整个榜单站点
（上万个条目），耗时较长；之后由维护者人工评审合并。合并后索引每天 03:17 UTC 重建，
GitHub Pages 约 10 分钟生效，jsDelivr 最长 12 小时。

**被要求改描述措辞是常态，不是拒绝。** 改完推到同一分支，留一条评论说明改了什么即可。

