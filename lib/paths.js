/**
 * 项目定位：BMad 的 `_bmad/` 装在**每个项目自己的根目录**里，和上游
 * `npx bmad-method install` 的语义一致。
 *
 * 上游假设「安装目录就是项目根」：`resolve_config.py --project-root <根>`
 * 去读 `<根>/_bmad/config.toml`，渲染器把 `{project-root}` 展开成同一个根，
 * 产物落 `<根>/_bmad-output`。所以这里必须找到真正的项目根，而不是插件自己的
 * 安装目录 —— 旧实现装在全局主目录，正是产品里 `{project-root}` 语义错位的根源。
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** `_bmad/` 目录名（上游常量）。 */
export const BMAD_DIRNAME = '_bmad'

// 默认值集中放在 defaults.js，这里再导出一次，避免几处各写一份而漂移。
export { DEFAULT_LANGUAGE, DEFAULT_OUTPUT_FOLDER } from './defaults.js'

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 规范化路径用于比较。
 *
 * 必须走 realpath：Windows 上同一个目录可以有多种写法（`C:\Users\ADMINI~1`
 * 的 8.3 短名、大小写差异、junction）。只比字符串会让"是否到达主目录"这类
 * 判断失效 —— 实测后果是主目录被判成项目根，产物全写进 `~/`。
 */
function canonical(path) {
  try {
    return realpathSync.native(path).toLowerCase()
  } catch {
    return resolve(path).toLowerCase()
  }
}

/**
 * 从 startDir 逐级向上找含 `_bmad/` 的目录；找不到返回 null。
 *
 * 上界是用户主目录：**向上找时不用主目录自己的 `_bmad/`**。
 * 理由（本机实测踩到的）：主目录下可能躺着一个历史遗留的 `_bmad/`，一旦把它
 * 当成项目根，任何临时目录、任何项目都会被解析成"主目录是这个项目"，
 * 产物于是全写进 `~/…` —— 上游 `{project-root}` 语义彻底错位。
 *
 * 但**显式点名**主目录时仍然认（用户真的想在主目录里装 BMad，那它就是项目根）。
 */
export function locateInstalled(startDir) {
  if (!startDir) return null
  const homeKey = canonical(homedir())
  const start = resolve(startDir)
  const startKey = canonical(start)
  let dir = start
  for (;;) {
    const key = canonical(dir)
    // 走到主目录这一层：除非调用方就是从主目录出发，否则不把它当项目根
    if (key === homeKey && startKey !== homeKey) return null
    const bmadDir = join(dir, BMAD_DIRNAME)
    if (isDir(bmadDir)) return { projectRoot: dir, bmadDir }
    if (key === homeKey) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 决定这次操作的项目根。
 *
 * 顺序：显式 `projectRoot`（允许直接指向 `_bmad/`）> 会话工作目录 > 进程 cwd。
 * 会话 cwd 是关键：一个 dsh 会话可能同时开着多个项目，只有会话知道用户此刻在哪个
 * 项目里干活。
 */
export function resolveProjectRoot({ projectRoot, cwd } = {}) {
  if (typeof projectRoot === 'string' && projectRoot.trim()) {
    const abs = isAbsolute(projectRoot.trim()) ? projectRoot.trim() : resolve(projectRoot.trim())
    // 允许直接给 `_bmad/` 路径
    if (abs.replace(/[\\/]+$/, '').endsWith(BMAD_DIRNAME) && isDir(abs)) {
      return { projectRoot: dirname(abs), bmadDir: abs }
    }
    const installed = locateInstalled(abs)
    if (installed) return installed
    return { projectRoot: abs, bmadDir: join(abs, BMAD_DIRNAME) }
  }
  const start = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd()
  const installed = locateInstalled(start)
  if (installed) return installed
  return { projectRoot: resolve(start), bmadDir: join(resolve(start), BMAD_DIRNAME) }
}

/** 项目里是否已有可用的 BMad 安装（`_bmad/config.toml` 是安装器的必产物）。 */
export function isInstalled(projectRoot) {
  return existsSync(join(projectRoot, BMAD_DIRNAME, 'config.toml'))
}

/** 插件自带的只读运行时模板（`<pkg>/bmad-home/_bmad`）。 */
export function templateRoot() {
  return new URL('../bmad-home/_bmad', import.meta.url)
}
