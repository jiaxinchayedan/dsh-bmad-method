/**
 * 模块发现 + 官方安装器调用。
 *
 * 原则：模块清单不硬编码。已装模块来自项目的 `_bmad/`；可装模块来自官方注册表
 * `bmad-modules.yaml`（优先用插件依赖里 bmad-method 自带的那份，找不到用包内快照）。
 * 真正的文件操作一律交给上游安装器 —— 我们不重写它的安装逻辑。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { DEFAULT_LANGUAGE, DEFAULT_OUTPUT_FOLDER } from './paths.js'

const requireFromHere = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))

/** 包内注册表快照（依赖没落地时兜底）。 */
export const BUNDLED_REGISTRY = join(HERE, 'registry', 'bmad-modules.yaml')

/**
 * 内置模块不在官方注册表里（注册表只管外部模块），这里补齐 core / bmm，
 * 保证"全部模块"清单不缺地基。
 */
const BUILTIN_MODULES = [
  {
    code: 'core',
    name: 'BMad Core',
    description: '所有模块共用的核心工作流与技能（每次安装都会带上，不可停用）',
    type: 'builtin',
    deprecated: false,
    aliases: [],
  },
  {
    code: 'bmm',
    name: 'BMad Method',
    description: '敏捷规划与交付主模块：分析 / 规划 / 架构 / 实施全流程',
    type: 'builtin',
    deprecated: false,
    aliases: [],
  },
]

/** 注册表 + 内置模块，按 code / 别名去重。 */
export function allRegistryModules(registryModules) {
  const known = new Set()
  for (const entry of registryModules) {
    known.add(entry.code)
    for (const alias of entry.aliases ?? []) known.add(alias)
  }
  return [...registryModules, ...BUILTIN_MODULES.filter((m) => !known.has(m.code))]
}

/** 官方注册表：优先插件依赖里的 bmad-method，其次包内快照。 */
export function loadRegistry({ registryPath } = {}) {
  const candidates = []
  if (registryPath) candidates.push({ path: registryPath, source: 'configured' })
  else {
    try {
      const pkg = requireFromHere.resolve('bmad-method/package.json')
      candidates.push({ path: join(dirname(pkg), 'bmad-modules.yaml'), source: 'bundled-package' })
    } catch {
      /* 依赖没落地，靠包内快照 */
    }
    candidates.push({ path: BUNDLED_REGISTRY, source: 'bundled-snapshot' })
  }

  for (const candidate of candidates) {
    let parsed
    try {
      if (!existsSync(candidate.path)) continue
      parsed = parseYaml(readFileSync(candidate.path, 'utf8'))
    } catch {
      continue
    }
    if (!parsed?.modules) continue
    const modules = Object.entries(parsed.modules).map(([key, value]) => ({
      code: value?.code ?? key,
      key,
      name: value?.name ?? value?.code ?? key,
      description: value?.description ?? '',
      type: value?.type ?? 'module',
      npmPackage: value?.npmPackage ?? null,
      deprecated: value?.deprecated === true,
      deprecationMessage: value?.['deprecation-message'] ?? '',
      aliases: Array.isArray(value?.aliases) ? value.aliases : [],
    }))
    return { modules, source: candidate.source, path: candidate.path }
  }
  return { modules: [], source: 'unavailable', path: null }
}

/** 读 `_bmad/<code>/config.yaml` 与 manifest，合并成已装模块清单。 */
export function readInstalledModules(bmadDir) {
  const fromManifest = new Map()
  try {
    const manifest = parseYaml(readFileSync(join(bmadDir, '_config', 'manifest.yaml'), 'utf8'))
    for (const item of Array.isArray(manifest?.modules) ? manifest.modules : []) {
      const code = item?.name ?? item?.code
      if (typeof code === 'string' && code) fromManifest.set(code, item)
    }
  } catch {
    /* 没有 manifest 就只靠目录扫描 */
  }

  const scanned = []
  try {
    for (const entry of readdirSync(bmadDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'custom') continue
      if (existsSync(join(bmadDir, entry.name, 'config.yaml'))) scanned.push(entry.name)
    }
  } catch {
    /* 目录读不到就返回 manifest 的部分 */
  }

  return [...new Set([...fromManifest.keys(), ...scanned])].sort().map((code) => {
    let config = {}
    try {
      config = parseYaml(readFileSync(join(bmadDir, code, 'config.yaml'), 'utf8')) ?? {}
    } catch {
      /* 配置坏了也照样报"已装"，坏在哪由工具输出说明 */
    }
    const meta = fromManifest.get(code) ?? {}
    return {
      code,
      name: typeof config.name === 'string' && config.name ? config.name : code,
      description: typeof config.description === 'string' ? config.description : '',
      version: config.version ?? meta.version ?? null,
      source: meta.source ?? 'unknown',
      lastUpdated: meta.lastUpdated ?? meta.installDate ?? null,
      dir: join(bmadDir, code),
    }
  })
}

/** 核心版本：`_bmad/core/config.yaml` 的 version，兜底用 manifest。 */
export function coreVersion(bmadDir) {
  try {
    const config = parseYaml(readFileSync(join(bmadDir, 'core', 'config.yaml'), 'utf8'))
    if (config?.version) return config.version
  } catch {
    /* 落到 manifest */
  }
  try {
    const manifest = parseYaml(readFileSync(join(bmadDir, '_config', 'manifest.yaml'), 'utf8'))
    return manifest?.installation?.version ?? null
  } catch {
    return null
  }
}

/** 插件依赖里携带的 bmad-method 版本（依赖没落地返回 null）。 */
export function bundledBmadVersion() {
  try {
    const pkg = requireFromHere.resolve('bmad-method/package.json')
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 找安装器入口：插件依赖 > 全局 npm > npx。
 * 插件把 bmad-method 作为依赖带着，所以正常情况下永远走第一条，不联网。
 */
export function resolveInstaller() {
  try {
    const cli = requireFromHere.resolve('bmad-method/tools/installer/bmad-cli.js')
    if (existsSync(cli)) return { command: process.execPath, args: [cli], via: 'bundled-package' }
  } catch {
    /* 继续往下找 */
  }
  const globalCandidates = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'bmad-method', 'tools', 'installer', 'bmad-cli.js'),
    '/usr/local/lib/node_modules/bmad-method/tools/installer/bmad-cli.js',
    '/usr/lib/node_modules/bmad-method/tools/installer/bmad-cli.js',
  ].filter(Boolean)
  for (const candidate of globalCandidates) {
    if (existsSync(candidate)) return { command: process.execPath, args: [candidate], via: 'global-package' }
  }
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', 'bmad-method@6.12.4'],
    via: 'npx',
    shell: process.platform === 'win32',
  }
}

/**
 * 组装安装器命令（不执行），便于 dryRun 与测试。
 *
 * `--modules` 是权威集合：不在列表里的模块会被卸载，所以模块开关不靠它，
 * 而是靠 skill provider 侧的过滤（开关不动文件）。
 */
export function buildInstallCommand({
  projectRoot,
  action = 'update',
  channel,
  modules,
  tools = 'claude-code',
  userName,
  language = DEFAULT_LANGUAGE,
  outputFolder = DEFAULT_OUTPUT_FOLDER,
}) {
  if (!projectRoot) throw new Error('缺少安装目标目录（--directory）')
  if (!['update', 'quick-update'].includes(action)) {
    throw new Error(`不支持的更新动作：${action}（上游 6.12.4 只接受 update / quick-update）`)
  }
  if (channel && !['stable', 'next'].includes(channel)) {
    throw new Error(`不支持的渠道：${channel}（可选 stable / next）`)
  }
  const installer = resolveInstaller()
  const args = [
    ...installer.args,
    'install',
    '--directory',
    projectRoot,
    '--action',
    action,
    '--yes',
    // 不铺任何 IDE 接入文件：skill 由本插件的 provider 提供，不需要 .claude/ 之类目录
    '--no-shims',
  ]
  const list = Array.isArray(modules) ? modules.filter((m) => typeof m === 'string' && m.trim()) : []
  if (list.length) args.push('--modules', list.join(','))
  if (tools) args.push('--tools', tools)
  if (channel) args.push('--channel', channel)
  if (userName) args.push('--user-name', userName)
  if (outputFolder) args.push('--output-folder', outputFolder)
  args.push('--communication-language', language, '--document-output-language', language)
  return { command: installer.command, args, via: installer.via, shell: installer.shell === true }
}

/** 跑安装器，抓有界输出。 */
export function runInstaller(invocation, { timeoutMs = 900_000, maxBytes = 60_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      shell: invocation.shell === true,
      env: process.env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
      done({ ok: false, timedOut: true, exitCode: null, stdout, stderr })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += String(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ ok: false, timedOut: false, exitCode: null, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ ok: code === 0, timedOut: false, exitCode: code, stdout, stderr })
    })
  })
}

/** 探测 `uv` 是否可用（skill 正文里的 `uv run` 依赖它）。 */
export function detectUv() {
  return new Promise((done) => {
    let child
    try {
      child = spawn('uv', ['--version'], { shell: process.platform === 'win32', windowsHide: true })
    } catch {
      done({ available: false, version: null })
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      done({ available: false, version: null })
    }, 5000)
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      done({ available: false, version: null })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ available: code === 0, version: out.trim() || null })
    })
  })
}
