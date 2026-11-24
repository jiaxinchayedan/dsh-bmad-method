/**
 * dsh-BMad-Method（项目级）—— BMad Method 在 dsh 里的完整移植。
 *
 * 与上游 `bmad-code-org/BMAD-METHOD` 6.12.4 的对应关系：
 *
 *   上游 `npx bmad-method install`  →  本插件的 `bmad_project_install` 工具 / 设置卡片「安装」
 *   上游 `<项目>/_bmad/`            →  同样的位置（每个项目自己一份）
 *   上游 `.claude/skills/<name>/`   →  本插件的 SkillProvider（不往磁盘铺任何 IDE 目录）
 *   上游 `<项目>/_bmad-output/`     →  同样由 skill 自身写入
 *
 * 模块开关只决定 skill 参不参与 dsh，不动文件；状态存在插件自己的配置里
 * （`configEditor`），不碰 profile 的 `cordis.patch.yml`。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import {
  allRegistryModules,
  buildInstallCommand,
  bundledBmadVersion,
  coreVersion,
  detectUv,
  loadRegistry,
  readInstalledModules,
  runInstaller,
} from './lib/bmad.js'
import {
  DEFAULT_DISABLED_MODULES,
  DEFAULT_LANGUAGE,
  DEFAULT_OUTPUT_FOLDER,
  INSTALLER_TOOLS,
  MODULE_LABELS,
  moduleRank,
} from './lib/defaults.js'
import { isInstalled, resolveProjectRoot } from './lib/paths.js'
import {
  dedupeCentralConfig,
  installedModuleCodes,
  materializeProject,
  templateVersion,
} from './lib/runtime.js'
import { BmadSkillProvider, bundledSkillsDir } from './lib/skills.js'
import { cfg, cfgString, isModuleEnabled, parseDisabled, serializeDisabled, updateOwnConfig } from './lib/state.js'

export const name = 'dsh-bmad-method-project'
export const inject = ['tools', 'skills']
// webServer 可选：没有它时只是设置卡片读不到状态，工具与 skill 照常工作
export const optional = ['webServer']

/**
 * 设置页表单。
 *
 * dsh 的 `volatileForm()` 只把标了 `.volatile()` 的字段放进设置页 —— 一个都没有时
 * 整个条目会被丢掉，卡片就不出现。所以每项都必须 volatile。
 * volatile 字段改完原地生效，不重启插件。
 */
export const Config = z.object({
  userName: z.string().default('').description('写入 BMad 核心配置的 user_name，留空用 BMad').volatile(),
  language: z.string().default(DEFAULT_LANGUAGE).description('沟通与文档输出语言').volatile(),
  outputFolder: z.string().default(DEFAULT_OUTPUT_FOLDER).description('产物目录名，相对项目根').volatile(),
  disabledModules: z
    .string()
    .default(serializeDisabled(new Set(DEFAULT_DISABLED_MODULES)))
    .description('停用的模块 code，逗号分隔；开关只隐藏 skill，不删文件')
    .volatile(),
})

const text = (value) => [{ type: 'text', text: value }]

/** 会话工作目录：决定这次操作落在哪个项目里。 */
function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

function locate(args, exec) {
  return resolveProjectRoot({ projectRoot: args?.projectRoot, cwd: sessionCwd(exec) })
}

/* ------------------------------------------------------------------ 状态 */

/** 每次现读，不缓存 —— 开关改完立刻生效。 */
function disabledSet(config) {
  return parseDisabled(cfg(config, 'disabledModules'))
}

let providerControl = null

/** 让宿主重扫 skill 清单（开关变化、重新安装后）。 */
function refreshSkills() {
  try {
    providerControl?.invalidate?.()
  } catch {
    /* 宿主没有该能力时静默 */
  }
}

/** uv 探一次就够，失败也不阻塞主流程。 */
let uvProbe = null
/** 探测结论：undefined = 未知/还没探完，true/false = 已探明。 */
let uvKnown
function uvAvailable() {
  if (uvProbe === null) {
    uvProbe = detectUv()
      .then((r) => {
        uvKnown = r.available
        return r.available
      })
      // 探不到就当"未知"，不要谎报不可用
      .catch(() => undefined)
  }
  return uvProbe
}

/* ---------------------------------------------------------------- 安装 */

/**
 * 首次使用时把运行时铺到项目里（幂等，毫秒级，不联网）。
 *
 * 与旧实现的关键差别：铺到 `<项目>/_bmad` 而不是全局主目录，这样上游
 * `{project-root}` / `--project-root` 的语义才成立。
 */
function bootstrap(projectRoot, config, { force = false } = {}) {
  try {
    return materializeProject(projectRoot, {
      userName: cfgString(config, 'userName'),
      language: cfgString(config, 'language', DEFAULT_LANGUAGE),
      outputFolder: cfgString(config, 'outputFolder', DEFAULT_OUTPUT_FOLDER),
      force,
    })
  } catch (error) {
    return { ok: false, reason: 'materialize-failed', error: String(error?.message ?? error), projectRoot }
  }
}

/** 项目里已装模块 + 注册表模块的合并视图。 */
function moduleView({ bmadDir, config, registryPath }) {
  const disabled = disabledSet(config)
  const registry = loadRegistry({ registryPath })
  const registryModules = allRegistryModules(registry.modules)
  const installed = readInstalledModules(bmadDir)
  const installedByCode = new Map(installed.map((m) => [m.code, m]))
  const registryByCode = new Map()
  for (const entry of registryModules) {
    registryByCode.set(entry.code, entry)
    for (const alias of entry.aliases ?? []) registryByCode.set(alias, entry)
  }

  const rows = installed.map((m) => {
    const reg = registryByCode.get(m.code)
    const label = MODULE_LABELS[m.code]
    return {
      code: m.code,
      // 中文名优先：注册表只有英文，直接用会让卡片中英混杂
      name: label?.name || reg?.name || m.name || m.code,
      description: label?.description || reg?.description || m.description || '',
      version: m.version,
      source: m.source,
      installed: true,
      enabled: isModuleEnabled(disabled, m.code),
      // core 是地基：装了就一定启用，不给开关
      toggleable: m.code !== 'core',
      deprecated: reg?.deprecated === true,
    }
  })

  // 只列「可装的」：注册表里的已弃用模块（automator / wds）不再展示。
  // 以前会把它们列成「未安装」，让人以为漏装了什么 —— 其实上游已经不再提供，
  // 装也装不上。已装但被上游标为弃用的模块仍然列出（带 [已弃用] 标记），
  // 这样老用户还能管理自己装过的模块。
  for (const entry of registryModules) {
    if (installedByCode.has(entry.code)) continue
    if ((entry.aliases ?? []).some((alias) => installedByCode.has(alias))) continue
    if (entry.deprecated === true) continue
    const label = MODULE_LABELS[entry.code]
    rows.push({
      code: entry.code,
      name: label?.name || entry.name,
      description: label?.description || entry.description || '',
      version: null,
      source: entry.type ?? 'module',
      installed: false,
      enabled: false,
      toggleable: false,
      deprecated: false,
    })
  }

  rows.sort(
    (a, b) =>
      Number(b.installed) - Number(a.installed) ||
      moduleRank(a.code) - moduleRank(b.code) ||
      a.code.localeCompare(b.code),
  )

  return { rows, registry }
}

/* ------------------------------------------------------------------ 工具 */

async function runStatus(args, exec, config) {
  const { projectRoot, bmadDir } = locate(args, exec)
  const boot = isInstalled(projectRoot) ? { ok: true, fresh: false } : bootstrap(projectRoot, config)
  const installed = isInstalled(projectRoot)
  const { rows, registry } = installed
    ? moduleView({ bmadDir, config, registryPath: args?.registryPath })
    : { rows: [], registry: { source: 'skip' } }
  const uv = await uvAvailable()

  const notes = []
  if (boot.ok && boot.fresh) notes.push(`首次使用：已把 BMad 运行时铺到 ${bmadDir}（随包模板，不联网）。`)
  if (boot.ok === false) notes.push(`铺装失败：${boot.error ?? boot.reason}`)
  if (boot.deduped > 0) {
    notes.push(`已消解 ${boot.deduped} 处配置键重名：上游渲染器见到同名键会 HALT，只保留 bmm 的那份。`)
  }
  if (uv === false) {
    notes.push('本机 uv 不可用。BMad 的 Python 脚本只依赖标准库（3.11+），把命令里的 uv run 换成 python 即可。')
  }
  if (registry.source === 'bundled-snapshot') {
    notes.push('可安装模块来自包内注册表快照（未找到 bmad-method 依赖）。')
  }

  const outputFolder = cfgString(config, 'outputFolder', DEFAULT_OUTPUT_FOLDER)
  return {
    installed,
    projectRoot,
    bmadDir,
    coreVersion: installed ? coreVersion(bmadDir) : null,
    bundledBmadVersion: bundledBmadVersion(),
    templateVersion: templateVersion(),
    outputFolder,
    outputDir: join(projectRoot, outputFolder),
    uv: uv ?? false,
    modules: rows,
    counts: {
      enabled: rows.filter((m) => m.installed && m.enabled).length,
      disabled: rows.filter((m) => m.installed && !m.enabled).length,
      missing: rows.filter((m) => !m.installed).length,
    },
    registrySource: registry.source,
    notes,
  }
}

async function runInstall(args, exec, config) {
  const { projectRoot, bmadDir } = locate(args, exec)
  const { rows } = moduleView({ bmadDir, config, registryPath: args?.registryPath })

  // 默认按注册表把所有未废弃模块装齐（插件要"全部封装"）；显式传 modules 才按指定的装
  const explicit = typeof args?.modules === 'string' ? args.modules.trim() : ''
  const wanted = explicit
    ? explicit.split(',').map((s) => s.trim()).filter(Boolean)
    : rows.filter((m) => !m.deprecated).map((m) => m.code)

  let invocation
  try {
    invocation = buildInstallCommand({
      projectRoot,
      action: args?.action ?? 'update',
      channel: args?.channel,
      modules: wanted,
      tools: INSTALLER_TOOLS,
      userName: (args?.userName ?? cfgString(config, 'userName') ?? '').trim() || undefined,
      language: args?.language ?? cfgString(config, 'language', DEFAULT_LANGUAGE),
      outputFolder: cfgString(config, 'outputFolder', DEFAULT_OUTPUT_FOLDER),
    })
  } catch (error) {
    return { status: 'invalid', executed: false, command: '', projectRoot, notes: [String(error?.message ?? error)] }
  }

  const commandLine = [invocation.command, ...invocation.args].join(' ')
  if (args?.dryRun === true) {
    return {
      status: 'dry-run',
      executed: false,
      via: invocation.via,
      command: commandLine,
      projectRoot,
      modules: wanted,
      notes: ['dryRun：只组装了命令，没有执行。'],
    }
  }

  const result = await runInstaller({ ...invocation, cwd: projectRoot })
  const notes = []
  if (result.timedOut) notes.push('安装器超时，已终止；输出可能不完整。')
  if (!result.ok && !result.timedOut) notes.push(`安装器退出码 ${result.exitCode}，看 stderr 定位原因。`)

  // 装完立刻做两件上游没做对的事：消歧 + 清掉安装器铺的 IDE 目录
  let deduped = 0
  let removedIde = false
  if (result.ok) {
    deduped = dedupeCentralConfig(bmadDir)
    if (deduped > 0) notes.push(`已消解 ${deduped} 处配置键重名（上游渲染器会因此 HALT）。`)
    // 安装器会把 skill 铺成 <项目>/.claude/skills；本插件自带 skill，不需要这些目录
    const claudeDir = join(projectRoot, '.claude')
    if (existsSync(claudeDir)) {
      try {
        rmSync(claudeDir, { recursive: true, force: true })
        removedIde = true
        notes.push('已清掉安装器铺的 .claude/skills（skill 由插件自带，不落 IDE 目录）。')
      } catch (error) {
        notes.push(`清 .claude/ 失败（不影响使用）：${String(error?.message ?? error)}`)
      }
    }
    refreshSkills()
  }

  const after = readInstalledModules(bmadDir).map((m) => `${m.code}${m.version ? `@${m.version}` : ''}`)
  return {
    status: result.timedOut ? 'timeout' : result.ok ? 'ok' : 'failed',
    executed: true,
    via: invocation.via,
    command: commandLine,
    exitCode: result.exitCode,
    projectRoot,
    deduped,
    removedIde,
    modules: after,
    stdoutTail: tail(result.stdout, 4000),
    stderrTail: tail(result.stderr, 2000),
    notes,
  }
}

async function runToggle(args, exec, config, ctx = hostCtx) {
  const code = typeof args?.module === 'string' ? args.module.trim() : ''
  const wanted = args?.enabled
  if (!code) return { status: 'invalid', notes: ['缺少 module 参数'] }
  if (typeof wanted !== 'boolean') return { status: 'invalid', notes: ['enabled 必须是布尔值'] }
  if (code === 'core') {
    return {
      status: 'not-toggleable',
      module: code,
      enabled: true,
      changed: false,
      notes: ['core 是所有模块的地基，不参与启用/停用。'],
    }
  }

  const { bmadDir } = locate(args, exec)
  const installed = installedModuleCodes(bmadDir)
  if (!installed.includes(code)) {
    return {
      status: 'module-not-installed',
      module: code,
      enabled: false,
      changed: false,
      notes: [
        `已装模块里没有 ${code}。当前已装：${installed.join(', ') || '（无）'}`,
        '先跑一次 bmad_project_install 把模块装齐。',
      ],
    }
  }

  const current = parseDisabled(cfg(config, 'disabledModules'))
  const alreadyOn = !current.has(code)
  if (alreadyOn === wanted) {
    return {
      status: 'noop',
      module: code,
      enabled: wanted,
      changed: false,
      notes: ['配置里已经是目标状态，未改动。'],
    }
  }

  if (wanted) current.delete(code)
  else current.add(code)

  try {
    await updateOwnConfig(ctx, (cfg) => ({ ...cfg, disabledModules: serializeDisabled(current) }))
  } catch (error) {
    return {
      status: 'write-failed',
      module: code,
      enabled: !wanted,
      changed: false,
      notes: [String(error?.message ?? error), '配置未改动，状态保持原样。'],
    }
  }

  refreshSkills()
  return {
    status: 'ok',
    module: code,
    enabled: wanted,
    changed: true,
    restartRequired: false,
    notes: [
      wanted
        ? '已启用：该模块的 skill 下一轮对话重新出现在清单里。'
        : '已停用：该模块的 skill 下一轮对话不再出现在清单里。模块文件一个都没删。',
    ],
  }
}

/** 由 apply() 注入的最小宿主句柄，供 runToggle 保存配置用。 */
let hostCtx = null

/* ------------------------------------------------- 卡片用的同源 HTTP 通道 */

/**
 * 设置卡片是浏览器端，调不了 Host 工具，所以开一条同源 HTTP 通道。
 *
 * 只做三件事：读状态、写一个模块开关、跑一次安装。
 * 写开关仍然走 `configEditor`（插件自己的配置），与 `bmad_project_module_toggle` 工具
 * 共用同一份状态，不会出现"两套状态互不同步"。
 */
const API_PREFIX = '/api/bmad-method-project'

/** 只认本机同源：跨站网页拿不到响应，也挡掉 DNS rebinding。 */
function sameOriginOk(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers?.host
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        resolve('')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/** 卡片要的状态数据（与 bmad_project_status 共用同一份计算）。 */
async function cardStatus(config) {
  const located = resolveProjectRoot({ cwd: process.cwd() })
  const status = await runStatus({ projectRoot: located.projectRoot }, {}, config)
  return {
    ok: true,
    installed: status.installed,
    projectRoot: status.projectRoot,
    bmadDir: status.bmadDir,
    coreVersion: status.coreVersion,
    outputDir: status.outputDir,
    uv: status.uv,
    modules: status.modules.map((m) => ({
      code: m.code,
      name: m.name,
      version: m.version,
      description: m.description,
      installed: m.installed,
      enabled: m.enabled,
      toggleable: m.toggleable,
    })),
    notes: status.notes,
  }
}

async function handleApi(req, res, config) {
  try {
    if (!sameOriginOk(req)) {
      sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
      return
    }
    const url = String(req.url ?? '')
    const action = url.replace(API_PREFIX, '').split('?')[0].replace(/^\//, '')

    if (req.method === 'GET' && (action === 'status' || action === '')) {
      sendJson(res, 200, await cardStatus(config))
      return
    }

    if (req.method === 'POST' && action === 'toggle') {
      const raw = await readRequestBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      const result = await runToggle({ module: body.module, enabled: body.enabled }, {}, config, hostCtx)
      const status = await cardStatus(config)
      const ok = result.status === 'ok' || result.status === 'noop'
      sendJson(res, ok ? 200 : 409, {
        ...status,
        ok,
        toggleStatus: result.status,
        enabled: result.enabled,
        notes: result.notes,
      })
      return
    }

    if (req.method === 'POST' && action === 'install') {
      const located = resolveProjectRoot({ cwd: process.cwd() })
      const result = await runInstall({ projectRoot: located.projectRoot }, {}, config)
      const status = await cardStatus(config)
      sendJson(res, result.status === 'ok' ? 200 : 409, {
        ...status,
        ok: result.status === 'ok',
        installStatus: result.status,
        notes: result.notes,
      })
      return
    }

    sendJson(res, 404, { ok: false, error: `未知接口：${req.method} ${url}` })
  } catch (error) {
    try {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    } catch {
      /* 连接可能已断 */
    }
  }
}

/* ------------------------------------------------------------------ 注册 */

export function apply(ctx, config = {}) {
  // configEditor 是可选服务：用 ctx.get 取，拿不到时工具会如实报错而不是假装成功
  hostCtx = { fiber: ctx.fiber, get: (key) => ctx.get(key) }

  // 尽早开始探 uv（skill 正文要据此决定是否提示改用 python）
  void uvAvailable()

  // ── 设置卡片的数据通道（webServer 可选：没有就只是卡片读不到状态）──
  ctx.effect(() => {
    const server = ctx.get('webServer')
    if (typeof server?.register !== 'function') return
    return server.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => handleApi(req, res, config),
    })
  }, 'dsh-BMad-Method: card api')

  // ── skill provider：90 个 BMad skill 随插件包走，不落用户目录 ──
  ctx.effect(() => {
    const skills = ctx.skills
    if (typeof skills?.registerProvider !== 'function') return
    return skills.registerProvider((control) => {
      providerControl = control
      return new BmadSkillProvider(ctx, control, {
        skillDir: bundledSkillsDir(),
        // cwd 由宿主按调用方会话传入；拿不到才退回进程目录
        getProjectRoot: (cwd) => resolveProjectRoot({ cwd: cwd ?? process.cwd() }).projectRoot,
        getDisabledModules: () => disabledSet(config),
        // 启动时还没探完就先给 undefined（正文不加 uv 警告）
        getUvAvailable: () => uvKnown,
      })
    })
  }, 'dsh-BMad-Method: skill provider')

  // ── 工具：模型也能主动调用 ──
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bmad_project_status',
      description:
        '查看当前项目的 BMad 安装状态：装了哪些模块、哪些被停用、核心版本、产物目录、uv 是否可用。首次调用会把随包的 BMad 运行时铺到本项目的 _bmad/（幂等、不联网）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectRoot: { type: 'string', description: '项目根或 _bmad/ 路径；缺省用会话工作目录' },
          registryPath: { type: 'string', description: '覆盖 bmad-modules.yaml 路径，一般不需要' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            installed: { type: 'boolean' },
            projectRoot: { type: 'string' },
            bmadDir: { type: 'string' },
            coreVersion: { type: 'string' },
            outputDir: { type: 'string' },
            uv: { type: 'boolean' },
            modules: { type: 'array', items: { type: 'object', additionalProperties: true } },
            counts: { type: 'object', additionalProperties: true },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (args, value) => text(renderStatus(value)),
      },
      execute: async (args, exec) => runStatus(args, exec, config),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bmad_project_install',
      description:
        '调用 BMad 官方安装器把模块装进本项目的 _bmad/（npx bmad-method install 的等价封装）。默认按官方注册表装齐全部未废弃模块；完成后自动消解上游的多模块配置键重名问题（否则 bmad-build 会 HALT）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectRoot: { type: 'string', description: '项目根；缺省用会话工作目录' },
          action: {
            type: 'string',
            enum: ['update', 'quick-update'],
            description: '交给安装器的 --action，默认 update',
          },
          channel: { type: 'string', enum: ['stable', 'next'], description: '安装渠道，默认沿用注册表' },
          modules: { type: 'string', description: '只装这几个模块（逗号分隔）；不传 = 全部未废弃模块' },
          userName: { type: 'string', description: '写进 BMad 核心配置的用户名' },
          language: { type: 'string', description: '沟通与文档输出语言' },
          dryRun: { type: 'boolean', description: '只返回将要执行的命令，不真正运行' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            status: { type: 'string' },
            executed: { type: 'boolean' },
            via: { type: 'string' },
            command: { type: 'string' },
            exitCode: { type: 'number' },
            projectRoot: { type: 'string' },
            modules: { type: 'array', items: { type: 'string' } },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (args, value) => text(renderInstall(value)),
      },
      execute: async (args, exec) => runInstall(args, exec, config),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bmad_project_modules_list',
      description:
        '列出 BMad 模块：已装模块来自本项目 _bmad/（manifest.yaml + 各模块 config.yaml），可装模块来自官方 bmad-modules.yaml 注册表，并标出每个模块当前是启用还是停用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectRoot: { type: 'string', description: '项目根或 _bmad/ 路径；缺省用会话工作目录' },
          registryPath: { type: 'string', description: '覆盖 bmad-modules.yaml 路径，一般不需要' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            installed: { type: 'boolean' },
            projectRoot: { type: 'string' },
            bmadDir: { type: 'string' },
            modules: { type: 'array', items: { type: 'object', additionalProperties: true } },
            counts: { type: 'object', additionalProperties: true },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (args, value) => text(renderModules(value)),
      },
      execute: async (args, exec) => {
        const status = await runStatus(args, exec, config)
        // 渲染层（renderModules）复用 renderStatus，所以这些字段一个都不能少：
        // 少一个就会显示成「核心版本：未知 / 产物目录：undefined」。
        return {
          installed: status.installed,
          projectRoot: status.projectRoot,
          bmadDir: status.bmadDir,
          coreVersion: status.coreVersion,
          bundledBmadVersion: status.bundledBmadVersion,
          outputDir: status.outputDir,
          uv: status.uv,
          modules: status.modules,
          counts: status.counts,
          notes: status.notes,
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bmad_project_module_toggle',
      description:
        '启用或停用一个 BMad 模块。开关只决定这个模块的 skill 参不参与 dsh（下一轮对话生效，不用重启），模块文件一个都不动。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['module', 'enabled'],
        properties: {
          module: { type: 'string', description: 'BMad 模块 code，如 bmm / bmb / cis / tea / gds / bmad-loop' },
          enabled: { type: 'boolean', description: 'true 启用，false 停用（只隐藏 skill，不删文件）' },
          projectRoot: { type: 'string', description: '项目根；缺省用会话工作目录' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            status: { type: 'string' },
            module: { type: 'string' },
            enabled: { type: 'boolean' },
            changed: { type: 'boolean' },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (args, value) => text(renderToggle(value)),
      },
      execute: async (args, exec) => runToggle(args, exec, config),
    }),
  )
}

/* ------------------------------------------------------------------ 渲染 */

function tail(value, limit) {
  const content = (value ?? '').trim()
  return content.length > limit ? `…${content.slice(-limit)}` : content
}

function moduleLine(m) {
  const state = m.installed ? (m.enabled ? '[x]' : '[ ]') : ' + '
  const version = m.version ? ` ${m.version}` : ''
  const dep = m.deprecated ? '  [已弃用]' : ''
  return `  ${state} ${m.code.padEnd(10)} ${m.name}${version}${dep}`
}

function renderStatus(value) {
  const lines = []
  if (!value.installed) {
    lines.push(`BMad：未安装（${value.projectRoot} 下没有 _bmad/）`)
    lines.push('首次安装：调一次 bmad_project_install（可先 dryRun 看命令）。')
  } else {
    lines.push(`BMad 安装位置：${value.bmadDir}`)
    lines.push(`核心版本：${value.coreVersion ?? '未知'}    随包版本：${value.bundledBmadVersion ?? '未知'}`)
    lines.push(`产物目录：${value.outputDir}`)
    lines.push(`uv：${value.uv ? '可用' : '不可用（Python 脚本改用 python 直接跑）'}`)
  }
  const on = value.modules.filter((m) => m.installed && m.enabled)
  const off = value.modules.filter((m) => m.installed && !m.enabled)
  const miss = value.modules.filter((m) => !m.installed)
  if (on.length) {
    lines.push('', `已安装·启用（${on.length}）：`)
    for (const m of on) lines.push(moduleLine(m))
  }
  if (off.length) {
    lines.push('', `已安装·停用（${off.length}，其 skill 不参与 dsh）：`)
    for (const m of off) lines.push(moduleLine(m))
  }
  if (miss.length) {
    lines.push('', `可安装未安装（${miss.length}）：`)
    for (const m of miss) lines.push(moduleLine(m))
  }
  for (const note of value.notes ?? []) lines.push('', `注：${note}`)
  return lines.join('\n')
}

function renderModules(value) {
  return renderStatus(value)
}

function renderInstall(value) {
  const lines = [`安装状态：${value.status}（${value.via || '未执行'}）`, `命令：${value.command}`]
  if (value.projectRoot) lines.push(`项目：${value.projectRoot}`)
  if (value.modules?.length) lines.push(`模块：${value.modules.join(', ')}`)
  if (value.stdoutTail) lines.push('', '--- stdout ---', value.stdoutTail)
  if (value.stderrTail) lines.push('', '--- stderr ---', value.stderrTail)
  for (const note of value.notes ?? []) lines.push('', `注：${note}`)
  return lines.join('\n')
}

function renderToggle(value) {
  if (value.status !== 'ok' && value.status !== 'noop') {
    return [`模块开关未完成：${value.status}`, ...(value.notes ?? [])].join('\n')
  }
  const state = value.enabled ? '启用' : '停用'
  const lines = [`模块 ${value.module} 已${state}${value.changed ? '' : '（本来就是该状态）'}`]
  lines.push(value.restartRequired ? '需要重启 dsh 才生效。' : '不用重启 dsh：下一轮对话就生效。')
  for (const note of value.notes ?? []) lines.push(`注：${note}`)
  return lines.join('\n')
}
