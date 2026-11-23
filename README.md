# dsh-BMad-Method（项目级）

把 [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) **6.12.4** 完整移植进 DeepSeek Harness。
装完即用，不需要自己跑 `npx bmad-method install`。

- **90 个 skill**，7 个模块，随插件包提供，不落你的 skills 目录
- **每个项目自己的 `_bmad/`**，与上游安装器的产物同构
- **模块逐个开关**，关掉的模块其 skill 立刻从清单消失，文件一个都不删
- 锁定 **6.12.4 stable**（上游 V7 还是 preview alpha，等它正式发布再跟）

---

## 与上游的对应关系

| 上游 `npx bmad-method install` 做的事情 | 本插件 |
| --- | --- |
| 把运行时铺到 `<项目>/_bmad/` | 同样位置（`bmad_project_status` 首次调用即铺，幂等、不联网） |
| 把 skill 铺到 `.claude/skills/<name>/` | 改用 dsh 原生 SkillProvider，**不往磁盘铺任何 IDE 目录** |
| `<项目>/_bmad-output/` 放产物 | 同样由 skill 自身写入 |
| `_bmad/custom/*.toml` 是项目级定制覆盖层 | 原样保留，重铺时不会被覆盖 |
| 装齐/更新模块 | `bmad_project_install`（官方安装器的非交互封装） |

---

## 四个工具

| 工具 | 用途 |
| --- | --- |
| `bmad_project_status` | 看装了哪些模块、哪些停用、核心版本、产物目录、uv 是否可用；首次调用自动铺运行时 |
| `bmad_project_install` | 调官方安装器装/更新模块，默认按注册表装齐全部未废弃模块；支持 `dryRun` 先看命令 |
| `bmad_project_modules_list` | 只列模块清单与启用状态 |
| `bmad_project_module_toggle` | 开关一个模块：只影响 skill 是否参与 dsh，不动文件，不用重启 |

设置卡片里也能做同样的事（状态、三个配置项、模块开关、安装按钮）。

---

## 移植过程中修掉的上游/继承缺陷

这几条都是实测出来的，不是理论推演。每条都有测试守着。

### 1. 多模块配置键重名 → `bmad-build` 第一步就 HALT

上游 6.12.4 装 `bmm + gds`（或任何同时声明 `planning_artifacts` /
`implementation_artifacts` / `project_knowledge` 的模块）时，安装器会把这些键同时
写进 `_bmad/config.toml` 的不同 `[modules.*]` 段。而渲染器 `render_skill.py` 的
`_resolve_short_config` 在整份 TOML 里按短名收集，收到两个就报：

```
HALT: ambiguous config value `implementation_artifacts` found at:
  modules.bmm.implementation_artifacts, modules.gds.implementation_artifacts
```

`bmad-build` / `bmad-build-auto` 的激活第一步就是跑这个渲染器，于是整个 skill 直接停住。

**修法**：铺装与安装后都做一次消歧，**固定保留 `modules.bmm` 那份**，其它模块的同名行注释掉。
注意不能"保留第一个出现的"——模板里 `[modules.gds]` 排在 `[modules.bmm]` 前面，
按顺序取舍会留下 gds 的路径，把 bmad-build 真正要用的 bmm 注掉。

### 2. 产物路径指向 `skills/` → 会覆盖只读 skill 目录

继承来的运行时模板把 bmb / tea / gds 的产物写成了 `{project-root}/skills/...`。
本项目根是**用户项目**，那个位置既不是上游约定，又会和插件的只读 skill 目录撞车。

**修法**：铺装时把这些键统一挪到上游的 `{project-root}/_bmad-output/...`（13 处），
并且**先迁移再去歧义**——反过来的话，被留下的那份可能还带着旧路径。

### 3. `{project-root}` 语义错位

旧做法把 BMad 装在全局主目录（`~/.dsh/bmad-method`）。上游的约定是
"安装目录就是项目根"：

- `resolve_config.py --project-root <根>` 去读 `<根>/_bmad/config.toml`
- 渲染器把 `{project-root}` 展开成同一个根，产物落 `<根>/_bmad-output`

装在全局主目录会让这两条同时失效：产物跑到家目录，`_bmad/custom/` 的团队/个人
覆盖层变成全局的。

**修法**：运行时铺到每个项目自己的 `_bmad/`，skill 下发时按**调用方会话的 cwd**
解析项目根（不是进程 cwd —— 一个会话可能同时开着多个项目）。

### 4. 主目录下的历史 `_bmad/` 会被误认成项目根

本机 `C:\Users\Administrator\_bmad` 里躺着一份历史遗留安装。向上查找 `_bmad/` 时
如果不设上界，任何临时目录、任何项目都会被解析成"主目录是这个项目"，产物全写进 `~/`。

**修法**：向上查找**停在用户主目录**，不用主目录自己的 `_bmad/` 当项目根
（但用户显式点名主目录时仍然认）。路径比较走 `realpath` 规范化，否则 Windows 的
8.3 短名（`ADMINI~1`）和大小写差异会让这个判断失效。

### 5. `volatile()` 配置字段是访问器，不是裸值

dsh 里标了 `.volatile()` 的字段，`config.language` 拿到的是 `{ get() }` 访问器。
直接 `join(projectRoot, config.outputFolder)` 会抛
`The "path" argument must be of type string`。
而 volatile 又必须加——`volatileForm()` 只把 volatile 字段放进设置页，一个都没有时
整张卡片会被丢掉。

**修法**：统一用 `cfg()` / `cfgString()` 读取，兼容访问器与裸值两种情况。

### 6. 环境里 `uv run` 可能直接失败

这台机器上 `uv run` 默认缓存目录（`%LOCALAPPDATA%\uv\cache`）不可写，直接报
`Failed to initialize cache`。上游 skill 正文里有 280 处 `uv run`。

**修法**：探测 uv 可用性。不可用时，下发的 skill 正文会多一行提示——BMad 的 Python
脚本只依赖标准库（3.11+ `tomllib`），把 `uv run` 换成 `python` 直接跑即可。
（`bmad-build` / `bmad-build-auto` 用的是 `uv run --no-cache`，不受影响。）

### 7. skill 重复来源会互相遮蔽

本机 `~/.agents/skills/` 里有 120 个 `bmad-*` / `gds-*` / `wds-*`，是早先用
`npx skills add BMAD-METHOD`（V7 预览结构）装的，**优先级高于插件**，`{project-root}`
不展开。移植要生效必须让插件成为唯一来源。

**处理**：已移到 `~/.agents/skills.disabled-bmad-backup/`（未删除，可随时挪回）。

---

## 安装位置与产物

| 路径 | 内容 |
| --- | --- |
| `<项目>/_bmad/` | 运行时：`config.toml`、各模块 `config.yaml`、`scripts/`、`_config/` |
| `<项目>/_bmad/custom/` | **你的**定制覆盖层（团队 / 个人），重铺与更新都不会碰 |
| `<项目>/_bmad/render/` | 渲染快照缓存，可丢弃 |
| `<项目>/_bmad-output/` | 产物：PRD、故事、回顾、测试计划…… |
| `<项目>/docs/` | `project_knowledge` 默认位置（安装器创建） |

插件包本身（`skills/`、`bmad-home/`）是只读的，不会被写入。

---

## 配置项

| 项 | 说明 |
| --- | --- |
| 用户名 | 写进 BMad 核心配置的 `user_name`，留空用 `BMad` |
| 语言 | 沟通 + 文档输出语言，默认简体中文 |
| 产物目录 | 相对项目根，默认 `_bmad-output` |
| 停用模块 | 逗号分隔的模块 code；开关只隐藏 skill，不删文件 |

改完保存立即生效（volatile 字段原地生效，不重启插件）。

---

## 开发

```bash
node test/plugin.test.js     # 19 个用例，覆盖上面每一条缺陷
```

测试用假 ctx 真跑 `apply()`，不联网：运行时铺装、配置写值、消歧优先级、
产物路径迁移、占位符展开、模块开关过滤、访问器配置读取、工具 dryRun。

> `node --test` 在本机沙箱下会因 `spawn EPERM`（禁止子进程管道）失败，
> 直接用 `node <file>` 跑同一个文件即可。

### 目录

```
index.js              插件入口：4 个工具 + skill provider + 设置卡片通道
client.js             浏览器半端：设置卡片 + 模块开关 + 安装按钮
lib/paths.js          项目定位（主目录上界、realpath 规范化）
lib/runtime.js        运行时铺装、配置写值、消歧
lib/artifacts.js      产物路径从 skills/ 迁到 _bmad-output/
lib/skills.js         SkillProvider：占位符展开 + 模块过滤
lib/bmad.js           注册表发现、官方安装器调用、uv 探测
lib/state.js          模块开关状态、volatile 配置读取、configEditor 写入
lib/defaults.js       默认值与模块顺序
bmad-home/_bmad/      运行时模板（31 文件，6.12.4）
skills/               90 个 skill + manifest.json（skill → 模块归属）
```

### 换 BMad 版本

1. 改 `package.json` 里 `bmad-method` 的版本
2. 用官方安装器铺一份新版本到临时项目，拿它的 `_bmad/` 覆盖 `bmad-home/_bmad/`
3. 从它的 `_config/skill-manifest.csv` 重新生成 `skills/manifest.json`
4. 跑 `node test/plugin.test.js`

模板版本与本包 `bmad-method` 依赖不一致时，`bmad_project_status` 会报出来。

---

## 许可

本插件代码以 MIT 发布。随包分发的 BMad Method 内容（`bmad-home/`、`skills/`）版权归
**BMad Code, LLC**，同样按 MIT 分发。

本项目是**非官方**移植，与 BMad Code, LLC 无隶属或背书关系。
