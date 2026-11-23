/**
 * 把随包的 90 个 BMad skill 作为 dsh 原生 SkillProvider 提供。
 *
 * 三个必须做对的点（每一条都是实测出来的）：
 *
 * 1. **`{project-root}` 必须展开成项目根**，且下发的正文里 `--project-root`
 *    必须就是它。上游 skill 拿它去跑 `<根>/_bmad/scripts/*.py` 并把产物写进
 *    `<根>/_bmad-output`；给错根，产物就跑到别处。
 *
 * 2. **`{skill-root}` 必须展开成 skill 的真实目录**。上游把 skill 材料（assets/
 *    references/customize.toml）和 SKILL.md 放在一起，`resolve_customization.py
 *    --skill <目录>` 要读 `<目录>/customize.toml`。不展开的话脚本直接报
 *    `required TOML file not found`。
 *
 * 3. **`{skill-name}` 是 skill 目录名**（上游 `bmad-customize` 自己写的：`{skill-name}`
 *    resolves to the skill directory's basename），要展开，否则用户看到字面量。
 *
 * `{date}` 之类**不展开**：那些是运行时由模型填的（`{date}` 在上游也是模型自己
 * 解析当前日期），提前替换成固定值反而错。
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

/** 随包 skill 目录。 */
export function bundledSkillsDir() {
  return fileURLToPath(new URL('../skills', import.meta.url))
}

/** dsh 的 skill 名约束。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 同一个 provider 名，宿主按它认领候选（candidate.provider 必须一字不差）。 */
export const PROVIDER_NAME = 'bmad-project'

/** 排序权重：BMad skill 走自己的 provider，和别的 skill 不争。 */
const RANK = 500

/** 拆 frontmatter 与正文。行尾 `\r` 必须先去掉，否则 yaml 会把 CRLF 当标量内容。 */
function splitFrontmatter(raw) {
  const clean = raw.replace(/^\uFEFF/, '')
  const lines = clean.split('\n')
  if (lines[0]?.replace(/\r$/, '').trimEnd() !== '---') return undefined
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].replace(/\r$/, '').trimEnd() !== '---') continue
    try {
      const header = lines.slice(1, i).map((line) => line.replace(/\r$/, '')).join('\n')
      const data = parseYaml(header)
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
      return { data, body: lines.slice(i + 1).join('\n') }
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 路径统一成正斜杠、去掉尾部分隔符（正文里的路径都是给人/给 shell 看的）。 */
function toPosix(path) {
  return String(path).replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 展开正文里的上游占位符。
 *
 * @param {string} body         SKILL.md 正文
 * @param {string} projectRoot  项目根（`_bmad/` 的父目录）
 * @param {string} skillDir     当前 skill 目录
 */
export function expandPlaceholders(body, projectRoot, skillDir) {
  const root = toPosix(projectRoot)
  const dir = toPosix(skillDir)
  const skillName = dir.split('/').pop() ?? ''
  return body
    .split('{project-root}').join(root)
    .split('{skill-root}').join(dir)
    .split('{skill-name}').join(skillName)
}

/**
 * 正文开头的运行环境提示。
 *
 * 上游假设「模型就在项目里跑，相对路径自然对」。dsh 里工作区和 `_bmad/` 可能
 * 不在同一个目录树里（会话 cwd 是子目录、或用户点名了另一个项目），所以把两个根
 * 明确写清楚，避免模型自己猜 `_bmad-output` 落在哪。
 */
export function environmentHint(projectRoot, skillDir, { uvOk } = {}) {
  const root = toPosix(projectRoot)
  const lines = [
    `> 运行环境：BMad 安装在 \`${root}/_bmad\`（配置、脚本、渲染快照都在这里）；` +
      `本 skill 的材料目录是 \`${toPosix(skillDir)}\`；所有相对路径（含 \`_bmad-output\`）以 \`${root}\` 为根。`,
  ]
  if (uvOk === false) {
    lines.push(
      '> 注意：本机 `uv` 不可用。BMad 的 Python 脚本只依赖标准库（3.11+ `tomllib`），' +
        '把命令里的 `uv run` 换成 `python` 直接跑即可，例如 `python <根>/_bmad/scripts/resolve_config.py --project-root <根>`。',
    )
  }
  return `${lines.join('\n')}\n\n`
}

export class BmadSkillProvider {
  /**
   * @param {{ logger?: any }} ctx
   * @param {import('node:sqlite').DatabaseSync extends never ? any : any} control
   * @param {{
   *   skillDir: string,
   *   getProjectRoot: () => string,
   *   getDisabledModules: () => Set<string> | null,
   *   getUvAvailable?: () => boolean | undefined,
   *   providerName?: string,
   * }} options
   */
  constructor(ctx, control, options) {
    this.ctx = ctx
    this.control = control
    this.name = options.providerName ?? PROVIDER_NAME
    this.skillDir = options.skillDir
    this.getProjectRoot = options.getProjectRoot
    this.getDisabledModules = options.getDisabledModules
    this.getUvAvailable = options.getUvAvailable
  }

  /** 让宿主重扫清单（模块开关、重新安装后调用）。 */
  invalidate() {
    try {
      this.control?.invalidate()
    } catch {
      /* 宿主没有该能力时静默 */
    }
  }

  /**
   * skill → 模块归属表。
   *
   * ① 包内 `skills/manifest.json` 是权威表（随包发行，用户机器上装没装某个模块都在）。
   * ② 项目里的 `_bmad/_config/skill-manifest.csv` 覆盖它：用户在项目里装了别的版本时以本机为准。
   * 表拿不到就返回空 Map —— 此时不做模块过滤，宁可多给也不误杀。
   */
  async #moduleTable(cwd) {
    const table = new Map()
    try {
      const raw = await readFile(join(this.skillDir, 'manifest.json'), 'utf8')
      for (const [name, module] of Object.entries(JSON.parse(raw))) table.set(name, module)
    } catch {
      /* 没有包内表就靠项目清单 */
    }
    const projectRoot = this.getProjectRoot?.(cwd)
    if (projectRoot) {
      try {
        const csv = await readFile(join(projectRoot, '_bmad', '_config', 'skill-manifest.csv'), 'utf8')
        for (const row of csv.split('\n').slice(1)) {
          if (!row.trim()) continue
          // description 里带逗号，只能按字段边界 `","` 拆
          const cols = row.trim().split('","')
          const name = cols[1]?.replace(/^"|"$/g, '').trim()
          const module = cols[3]?.replace(/^"|"$/g, '').trim()
          if (name && module) table.set(name, module)
        }
      } catch {
        /* 项目没装就只用包内表 */
      }
    }
    return table
  }

  async list(options = {}) {
    options.signal?.throwIfAborted()
    let entries
    try {
      entries = await readdir(this.skillDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        this.ctx?.logger?.warn?.(`[bmad] 未找到 skill 目录：${this.skillDir}`)
        return { candidates: [], complete: false }
      }
      throw error
    }

    const moduleOf = await this.#moduleTable(options.cwd)
    const disabled = this.getDisabledModules?.() ?? null
    const candidates = []

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      options.signal?.throwIfAborted()
      if (!entry.isDirectory()) continue
      const owner = moduleOf.get(entry.name)
      if (moduleOf.size > 0 ? owner === undefined : !entry.name.startsWith('bmad-')) continue
      // 补丁里标了停用的模块 → 它的 skill 不再列出；`core` 是地基，永远可用
      if (disabled && owner && owner !== 'core' && disabled.has(owner)) continue

      const skillPath = join(this.skillDir, entry.name, 'SKILL.md')
      const parsed = await this.#read(skillPath, options.signal)
      if (!parsed) continue
      const name = typeof parsed.data.name === 'string' ? parsed.data.name : entry.name
      const description = typeof parsed.data.description === 'string' ? parsed.data.description : ''
      if (!description || !SKILL_NAME_RE.test(name)) {
        this.ctx?.logger?.warn?.(`[bmad] 跳过 ${skillPath}：frontmatter 缺 name/description`)
        continue
      }
      candidates.push({
        name,
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: this.name,
        resourceBase: { kind: 'directory', path: dirname(skillPath) },
        path: skillPath,
        rank: RANK,
        locator: { path: skillPath, directory: dirname(skillPath) },
      })
    }
    return { candidates, complete: true }
  }

  async get(candidate, options = {}) {
    options.signal?.throwIfAborted()
    const skillPath = candidate?.locator?.path ?? candidate?.path
    const skillDir = candidate?.locator?.directory ?? candidate?.resourceBase?.path
    if (!skillPath) return undefined
    const parsed = await this.#read(skillPath, options.signal)
    if (!parsed) return undefined
    // 项目根按**调用方给的 cwd** 解析：一个会话可能同时开着多个项目，
    // 用进程 cwd 会把 `{project-root}` 展开成 dsh 自己的目录。
    const projectRoot = this.getProjectRoot?.(options.cwd) ?? options.cwd ?? process.cwd()
    const uvOk = this.getUvAvailable?.()
    const dir = skillDir ?? dirname(skillPath)
    return {
      ...candidate,
      content: environmentHint(projectRoot, dir, { uvOk }) + expandPlaceholders(parsed.body.trim(), projectRoot, dir),
    }
  }

  async #read(skillPath, signal) {
    try {
      return splitFrontmatter(await readFile(skillPath, { encoding: 'utf8', signal }))
    } catch (error) {
      if (signal?.aborted) throw error
      return undefined
    }
  }
}
