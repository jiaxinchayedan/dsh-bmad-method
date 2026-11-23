/**
 * 把 BMad 运行时铺到**项目自己的** `_bmad/` 里，与上游安装器的产物同构。
 *
 * 为什么不做"全局共享一份"：上游把 `_bmad/` 当作项目根的兄弟目录，
 *   - `resolve_config.py --project-root <根>` 会去读 `<根>/_bmad/config.toml`
 *   - `render_skill.py` 把 `{project-root}` 展开成同一个根，产物落 `<根>/_bmad-output`
 *   - `_bmad/custom/*.toml` 是**项目级**定制覆盖层（团队共享 / 个人 gitignore）
 * 装在全局主目录会让这三条语义全部错位：产物跑到家目录，定制覆盖变成全局的。
 *
 * 铺装是幂等的，且只碰配置层：`_bmad/custom/` 用户自己写的东西永远保留。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'

import { relocateArtifactPaths } from './artifacts.js'
import { BMAD_DIRNAME, DEFAULT_LANGUAGE, DEFAULT_OUTPUT_FOLDER } from './paths.js'

/** 插件包内的只读模板根（`<pkg>/bmad-home/_bmad`）。 */
export const TEMPLATE_BMAD_DIR = fileURLToPath(new URL('../bmad-home/_bmad', import.meta.url))

/** 上游渲染器在整棵配置里按短名找键，同名即 HALT 的键。 */
const AMBIGUOUS_KEYS = ['planning_artifacts', 'implementation_artifacts', 'project_knowledge']

/** 模板里被 `_bmad/_config/manifest.yaml` 记录的 BMad 版本。 */
export function templateVersion() {
  try {
    const text = readFileSync(join(TEMPLATE_BMAD_DIR, '_config', 'manifest.yaml'), 'utf8')
    const block = text.split(/^installation:/m)[1] ?? ''
    return block.match(/^\s+version:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null
  } catch {
    return null
  }
}

/** 项目名：优先 package.json 的 name，否则目录名。 */
function projectName(projectRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
    if (typeof pkg?.name === 'string' && pkg.name.trim()) return pkg.name.trim()
  } catch {
    /* 没有 package.json 或不是 JSON */
  }
  return basename(projectRoot) || 'project'
}

/**
 * 按行改写 `key: value`（yaml）或 `key = "value"`（toml）。
 * 收尾不用 `.*`，否则会把 CRLF 文件的行尾 `\r` 一起吃掉再写回去。
 */
function patchConfigFile(file, values) {
  if (!existsSync(file)) return false
  const isToml = file.endsWith('.toml')
  const original = readFileSync(file, 'utf8')
  let text = original
  for (const [key, value] of values) {
    const pattern = isToml
      ? new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"\\r\\n]*"`, 'gm')
      : new RegExp(`^(\\s*${key}\\s*:\\s*)[^\\r\\n]*`, 'gm')
    text = text.replace(pattern, isToml ? `$1"${value}"` : `$1${value}`)
  }
  if (text === original) return false
  writeFileSync(file, text, 'utf8')
  return true
}

/**
 * 上游 6.12.4 的真实缺陷：装 bmm + gds（或任何同时声明这三个键的模块）时，
 * 安装器会把它们同时写进 `_bmad/config.toml` 的不同 `[modules.*]` 段。
 * 而 `render_skill.py` 的 `_resolve_short_config` 在整个 TOML 里按短名收集，
 * 收到两个就报
 *   HALT: ambiguous config value `implementation_artifacts` found at: ...
 * 于是 bmad-build / bmad-build-auto 的第一步就停住。
 *
 * 处理：**固定保留 `modules.bmm` 的那份**（这三个键是 bmm 的产物布局），
 * 把其它模块里的同名行注释掉。注意不能"保留第一个出现"——模板里 `[modules.gds]`
 * 排在 `[modules.bmm]` 前面，按顺序取舍会把 bmm（也就是 bmad-build 真正用的那份）
 * 注掉，反而让 gds 的路径生效。
 *
 * 只碰这三个已知会撞车的键，别的键各模块可以合法各执一份。
 */
export function dedupeCentralConfig(bmadDir) {
  const file = join(bmadDir, 'config.toml')
  if (!existsSync(file)) return 0
  const raw = readFileSync(file, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)

  const sections = []
  lines.forEach((line, index) => {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) sections.push({ name: header[1].trim(), start: index })
  })
  sections.forEach((section, index) => {
    section.end = index + 1 < sections.length ? sections[index + 1].start : lines.length
  })

  // 收集每个键在哪些段里出现
  const occurrences = new Map()
  for (const section of sections) {
    if (!section.name.startsWith('modules.')) continue
    for (let i = section.start + 1; i < section.end; i += 1) {
      if (/^\s*#/.test(lines[i])) continue
      const match = lines[i].match(/^\s*([A-Za-z_][\w-]*)\s*=\s*\S/)
      if (match === null || !AMBIGUOUS_KEYS.includes(match[1])) continue
      const list = occurrences.get(match[1]) ?? []
      list.push({ section: section.name, line: i })
      occurrences.set(match[1], list)
    }
  }

  let changed = 0
  for (const [key, list] of occurrences) {
    if (list.length < 2) continue
    // 固定保留 bmm；万一没有 bmm 段才退回第一个
    const keep = list.find((item) => item.section === 'modules.bmm') ?? list[0]
    for (const item of list) {
      if (item === keep) continue
      const original = lines[item.line].trim()
      lines[item.line] = `# ${original}  # 与 ${keep.section} 的 ${key} 重名；上游渲染器见到两个同名键会 HALT`
      changed += 1
    }
  }
  if (changed > 0) writeFileSync(file, lines.join(eol), 'utf8')
  return changed
}

/** 首次铺装时从模板复制过去的目录/文件清单说明（供 UI 与工具输出复述）。 */
export function templateSummary() {
  return {
    version: templateVersion(),
    root: TEMPLATE_BMAD_DIR,
    source: 'bundled-template',
  }
}

/**
 * 把模板铺到项目的 `_bmad/`。
 *
 * 幂等：已装则只做配置对齐（用户名/语言/产物目录/去歧义），不重置 `custom/`。
 *
 * @param {string} projectRoot 项目根（`_bmad/` 会成为它的子目录）
 * @param {{ userName?: string, language?: string, outputFolder?: string, force?: boolean }} options
 */
export function materializeProject(projectRoot, options = {}) {
  if (!existsSync(join(TEMPLATE_BMAD_DIR, 'core', 'config.yaml'))) {
    return { ok: false, reason: 'template-missing', projectRoot }
  }
  const target = join(projectRoot, BMAD_DIRNAME)
  const fresh = !existsSync(join(target, 'config.toml'))

  // `custom/` 是用户自己的团队/个人覆盖层，重铺前先护住。
  const customDir = join(target, 'custom')
  const stash = join(projectRoot, '.bmad-custom-stash')
  const hadCustom = existsSync(customDir)
  if (hadCustom) {
    rmSync(stash, { recursive: true, force: true })
    cpSync(customDir, stash, { recursive: true, force: true })
  }

  if (options.force === true || fresh) {
    // 整棵树重建。不删 `render/` 以外的运行结果：`render/` 是可丢弃的快照缓存。
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(TEMPLATE_BMAD_DIR, { withFileTypes: true })) {
      if (entry.name === 'custom') continue
      const from = join(TEMPLATE_BMAD_DIR, entry.name)
      const to = join(target, entry.name)
      cpSync(from, to, { recursive: true, force: true })
    }
  } else {
    // 已装：只补模板里有、项目里缺的配置层文件（scripts/_config 随插件升级而更新）。
    for (const name of ['scripts', '_config']) {
      const from = join(TEMPLATE_BMAD_DIR, name)
      if (existsSync(from)) cpSync(from, join(target, name), { recursive: true, force: true })
    }
  }

  if (hadCustom) {
    cpSync(stash, customDir, { recursive: true, force: true })
    rmSync(stash, { recursive: true, force: true })
  } else {
    mkdirSync(customDir, { recursive: true })
  }
  mkdirSync(join(target, 'render'), { recursive: true })

  const language = (options.language ?? '').trim() || DEFAULT_LANGUAGE
  const values = [
    ['user_name', (options.userName ?? '').trim() || 'BMad'],
    ['project_name', projectName(projectRoot)],
    ['communication_language', language],
    ['document_output_language', language],
    ['output_folder', (options.outputFolder ?? '').trim() || DEFAULT_OUTPUT_FOLDER],
  ]

  const touched = []
  const files = ['config.toml', 'config.user.toml']
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(target, entry.name, 'config.yaml'))) files.push(join(entry.name, 'config.yaml'))
  }
  for (const relative of files) {
    if (patchConfigFile(join(target, relative), values)) touched.push(relative)
  }

  // 顺序很重要：先归一产物路径（把旧模板的 `{project-root}/skills` 挪到
  // `_bmad-output`），再去歧义。反过来的话，被留下的那份可能还带着旧路径。
  const relocated = relocateArtifactPaths(target)
  const deduped = dedupeCentralConfig(target)
  return {
    ok: true,
    fresh,
    projectRoot,
    bmadDir: target,
    version: templateVersion(),
    configured: touched.length,
    deduped,
    relocated,
  }
}

/** 项目里已装模块的 code（读 manifest + 目录扫描，互为兜底）。 */
export function installedModuleCodes(bmadDir) {
  const codes = new Set()
  try {
    const manifest = readFileSync(join(bmadDir, '_config', 'manifest.yaml'), 'utf8')
    for (const match of manifest.matchAll(/^\s*-\s*name:\s*(\S+)/gm)) codes.add(match[1])
  } catch {
    /* 没有 manifest 就只靠目录扫描 */
  }
  try {
    for (const entry of readdirSync(bmadDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'custom') continue
      if (existsSync(join(bmadDir, entry.name, 'config.yaml'))) codes.add(entry.name)
    }
  } catch {
    /* 目录读不到就返回已收集的 */
  }
  return [...codes].sort()
}
