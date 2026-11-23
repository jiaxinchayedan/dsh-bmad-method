/**
 * 修正模板里的产物路径。
 *
 * 为什么需要这一步：随包的运行时模板（`bmad-home/_bmad`）沿用了旧插件的写法，
 * 把 bmb / tea / gds 的产物指向 `{project-root}/skills/...`。而本插件在 dsh 里
 * 的项目根就是**用户项目**，`<项目>/skills` 既不是上游的约定，也可能与用户自己的
 * 目录撞车。上游官方安装器（6.12.4）对这些模块一律用
 * `{project-root}/_bmad-output/...`，这里对齐它。
 *
 * 只改「模板自带、且属于产物位置」的键；用户自己在 `_bmad/custom/` 里的覆盖不动。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/** 需要从 `{project-root}/skills` 迁到 `{project-root}/_bmad-output` 的键。 */
const ARTIFACT_KEYS = [
  'planning_artifacts',
  'implementation_artifacts',
  'project_knowledge',
  'bmad_builder_output_folder',
  'bmad_builder_reports',
  'test_artifacts',
  'test_design_output',
  'test_review_output',
  'trace_output',
]

/** 旧模板里 `{project-root}/skills` 的归宿。 */
const SKILLS_PREFIX = '{project-root}/skills'
const OUTPUT_PREFIX = '{project-root}/_bmad-output'

function normalizeValue(value) {
  const trimmed = value.trim()
  // 只动以 skills 开头的产物路径；`docs` 之类的用户自选目录不碰
  if (trimmed === SKILLS_PREFIX) return OUTPUT_PREFIX
  if (trimmed.startsWith(`${SKILLS_PREFIX}/`)) {
    return OUTPUT_PREFIX + trimmed.slice(SKILLS_PREFIX.length)
  }
  // 上游本来就写成裸 `skills/...` 的（test_design_output 等）
  if (trimmed === 'skills') return '_bmad-output'
  if (trimmed.startsWith('skills/')) return `_bmad-output/${trimmed.slice('skills/'.length)}`
  return null
}

/**
 * 把 bmad 目录里所有配置中的产物路径从 skills 迁到 _bmad-output。
 * 返回改动的行数（幂等）。
 */
export function relocateArtifactPaths(bmadDir) {
  const files = [join(bmadDir, 'config.toml')]
  for (const name of ['bmb', 'tea', 'gds', 'bmm', 'cis', 'core', 'bmad-loop']) {
    const file = join(bmadDir, name, 'config.yaml')
    if (existsSync(file)) files.push(file)
  }

  let changed = 0
  for (const file of files) {
    if (!existsSync(file)) continue
    const raw = readFileSync(file, 'utf8')
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const lines = raw.split(/\r?\n/)
    let touched = 0

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^\s*#/.test(line)) continue
      const match = line.match(/^(\s*)([A-Za-z_][\w-]*)(\s*[:=]\s*)"([^"]*)"(.*)$/)
      if (!match) continue
      if (!ARTIFACT_KEYS.includes(match[2])) continue
      const next = normalizeValue(match[4])
      if (next === null) continue
      lines[i] = `${match[1]}${match[2]}${match[3]}"${next}"${match[5]}`
      touched += 1
    }

    if (touched > 0) {
      writeFileSync(file, lines.join(eol), 'utf8')
      changed += touched
    }
  }
  return changed
}
