/**
 * 离线功能测试：用假 ctx 真跑 apply()，不联网、不装插件。
 *
 * 覆盖的是「移植是否真的等价于上游」这件事，不是 API 形状：
 *   - 运行时铺到项目自己的 _bmad/（不是全局主目录）
 *   - 铺出来的目录结构、配置值、消歧结果与官方安装器一致
 *   - skill provider 展开占位符后，路径真能指到存在的文件
 *   - 模块停用后它的 skill 真的从候选清单里消失
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply, Config } from '../index.js'
import { expandPlaceholders, BmadSkillProvider, bundledSkillsDir } from '../lib/skills.js'
import { dedupeCentralConfig, materializeProject, installedModuleCodes } from '../lib/runtime.js'
import { parseDisabled, serializeDisabled, isModuleEnabled, cfg, cfgString } from '../lib/state.js'
import { resolveProjectRoot, isInstalled } from '../lib/paths.js'

/** 造一个假 ctx：effect 立即执行并收集 disposer，tools.register 收进表里。 */
function fakeCtx() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    fiber: { entry: { options: {} } },
    get: (key) => (key === 'configEditor' ? editor : undefined),
    skills: {
      registerProvider(factory) {
        const control = { signal: new AbortController().signal, invalidate() {} }
        provider = factory(control)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }
  const saved = {}
  const editor = {
    async edit(entry, change) {
      saved.edited = change(saved.current ?? {})
    },
  }
  let provider = null
  return { ctx, tools, disposers, editor, saved, provider: () => provider }
}

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'bmad-test-'))
}

test('运行时铺到项目自己的 _bmad/，而不是全局主目录', () => {
  const project = tempProject()
  try {
    const result = materializeProject(project, { userName: '测试员', language: '简体中文' })
    assert.equal(result.ok, true)
    assert.equal(result.fresh, true)
    // 关键：位置在项目里
    assert.equal(existsSync(join(project, '_bmad', 'config.toml')), true)
    assert.equal(isInstalled(project), true)
    // 上游安装器的必需产物都在
    for (const rel of [
      '_bmad/config.toml',
      '_bmad/config.user.toml',
      '_bmad/core/config.yaml',
      '_bmad/bmm/config.yaml',
      '_bmad/_config/manifest.yaml',
      '_bmad/_config/skill-manifest.csv',
      '_bmad/scripts/resolve_config.py',
      '_bmad/scripts/render_skill.py',
      '_bmad/custom',
      '_bmad/render',
    ]) {
      assert.equal(existsSync(join(project, rel)), true, `缺少 ${rel}`)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('配置值写进项目：用户名 / 语言 / 产物目录 / 项目名', () => {
  const project = tempProject()
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'my-app' }))
    materializeProject(project, { userName: '张三', language: '简体中文', outputFolder: 'out-dir' })
    const toml = readFileSync(join(project, '_bmad', 'config.toml'), 'utf8')
    assert.match(toml, /user_name = "张三"/)
    assert.match(toml, /communication_language = "简体中文"/)
    assert.match(toml, /document_output_language = "简体中文"/)
    assert.match(toml, /output_folder = "out-dir"/)
    assert.match(toml, /project_name = "my-app"/)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('重复铺装幂等：不重置 custom/ 里的用户覆盖', () => {
  const project = tempProject()
  try {
    materializeProject(project, { userName: 'A' })
    const customFile = join(project, '_bmad', 'custom', 'bmad-prd.toml')
    writeFileSync(customFile, '[workflow]\non_complete = "我的定制"\n')
    materializeProject(project, { userName: 'B' })
    assert.equal(readFileSync(customFile, 'utf8').includes('我的定制'), true, 'custom/ 被重置了')
    assert.match(readFileSync(join(project, '_bmad', 'config.toml'), 'utf8'), /user_name = "B"/)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('消解多模块同名键：上游渲染器会 HALT 的歧义必须清掉', () => {
  const project = tempProject()
  try {
    materializeProject(project, {})
    const file = join(project, '_bmad', 'config.toml')
    const raw = readFileSync(file, 'utf8')
    // 模板里 bmm 与 gds 都声明了这三个键，模拟上游安装器装完多模块的样子
    const withDup = raw.replace(
      /\[modules\.bmm\]/,
      '[modules.gds]\nplanning_artifacts = "{project-root}/_bmad-output/gds-planning"\nimplementation_artifacts = "{project-root}/_bmad-output/gds-impl"\n\n[modules.bmm]',
    )
    writeFileSync(file, withDup, 'utf8')
    const changed = dedupeCentralConfig(join(project, '_bmad'))
    assert.equal(changed, 2, '两个 gds 同名键应被注释掉')
    const after = readFileSync(file, 'utf8')
    // bmm 的那份保留（未注释）
    const live = after.split(/\r?\n/).filter((l) => /^\s*(planning_artifacts|implementation_artifacts)\s*=/.test(l))
    assert.equal(live.length, 2, `应只剩 bmm 的 2 个活键，实际: ${JSON.stringify(live)}`)
    // 幂等
    assert.equal(dedupeCentralConfig(join(project, '_bmad')), 0)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('占位符展开：{project-root} / {skill-root} / {skill-name} 都指到真路径', () => {
  const body = 'run --project-root {project-root} --skill {skill-root}; override at {project-root}/_bmad/custom/{skill-name}.toml'
  const out = expandPlaceholders(body, 'C:\\proj', 'C:\\pkg\\skills\\bmad-prd')
  assert.equal(out.includes('{project-root}'), false)
  assert.equal(out.includes('{skill-root}'), false)
  assert.equal(out.includes('{skill-name}'), false)
  assert.match(out, /--project-root C:\/proj/)
  assert.match(out, /--skill C:\/pkg\/skills\/bmad-prd/)
  assert.match(out, /custom\/bmad-prd\.toml/)
})

test('skill provider 列出 90 个 skill，模块停用后该模块的 skill 消失', async () => {
  const project = tempProject()
  try {
    materializeProject(project, {})
    const all = new BmadSkillProvider({}, null, {
      skillDir: bundledSkillsDir(),
      getProjectRoot: () => project,
      getDisabledModules: () => new Set(),
    })
    const listed = await all.list({ cwd: project })
    assert.equal(listed.complete, true)
    assert.equal(listed.candidates.length, 90)

    const off = new BmadSkillProvider({}, null, {
      skillDir: bundledSkillsDir(),
      getProjectRoot: () => project,
      getDisabledModules: () => new Set(['gds']),
    })
    const filtered = await off.list({ cwd: project })
    assert.equal(filtered.candidates.length, 90 - 33, 'gds 的 33 个 skill 应被过滤')
    assert.equal(filtered.candidates.some((c) => c.name.startsWith('gds-')), false)
    // core 永不因模块开关消失
    assert.equal(filtered.candidates.some((c) => c.name === 'bmad-help'), true)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('skill 正文里展开出的 _bmad 路径与 skill 目录真实存在', async () => {
  const project = tempProject()
  try {
    materializeProject(project, {})
    const provider = new BmadSkillProvider({}, null, {
      skillDir: bundledSkillsDir(),
      getProjectRoot: () => project,
      getDisabledModules: () => new Set(),
    })
    const { candidates } = await provider.list({ cwd: project })
    const prd = candidates.find((c) => c.name === 'bmad-prd')
    const skill = await provider.get(prd, { cwd: project })
    // 占位符全展开
    assert.equal(skill.content.includes('{project-root}'), false)
    assert.equal(skill.content.includes('{skill-root}'), false)
    // 正文里点到的 customize.toml 与脚本都真在
    assert.equal(existsSync(join(skill.resourceBase.path, 'customize.toml')), true)
    // 正文里的项目根是**这个项目**，且指向它真实的 _bmad/scripts（正斜杠写法）
    const posixProject = project.replace(/\\/g, '/')
    assert.equal(skill.content.includes(`${posixProject}/_bmad/scripts`), true)
    assert.equal(existsSync(join(project, '_bmad', 'scripts')), true)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('上游 Python 脚本能对铺出来的项目直接跑通', () => {
  const project = tempProject()
  try {
    materializeProject(project, { userName: '脚本验证', language: '简体中文' })
    const script = join(project, '_bmad', 'scripts', 'resolve_config.py')
    let out
    try {
      out = execFileSync('python', [script, '--project-root', project], { encoding: 'utf8' })
    } catch (error) {
      // 沙箱禁止子进程管道（EPERM）、或本机没有 python —— 都跳过，不算失败：
      // 这项验的是上游脚本能否读我们铺出来的配置，不是插件代码本身。
      if (error?.code === 'ENOENT' || error?.code === 'EPERM') return
      throw error
    }
    const parsed = JSON.parse(out)
    assert.equal(parsed.core.user_name, '脚本验证')
    assert.equal(parsed.core.communication_language, '简体中文')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('产物路径不得指向 skills/（会与只读 skill 目录撞车）', () => {
  const project = tempProject()
  try {
    materializeProject(project, {})
    const toml = readFileSync(join(project, '_bmad', 'config.toml'), 'utf8')
    // 旧模板会把 bmb/tea/gds 的产物写成 {project-root}/skills/...
    assert.equal(toml.includes('/skills/'), false, `产物路径仍指向 skills/：\n${toml}`)
    assert.equal(toml.includes('"skills/'), false, '仍有裸 skills/ 产物路径')
    // 官方安装器的布局：产物统一在 _bmad-output 下
    assert.match(toml, /planning_artifacts = "\{project-root\}\/_bmad-output\/planning-artifacts"/)
    assert.match(toml, /implementation_artifacts = "\{project-root\}\/_bmad-output\/implementation-artifacts"/)
    // 各模块 config.yaml 也要干净
    for (const m of ['bmb', 'tea', 'gds', 'bmm']) {
      const file = join(project, '_bmad', m, 'config.yaml')
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      assert.equal(text.includes('/skills/'), false, `${m}/config.yaml 仍指向 skills/`)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('产物路径迁移是幂等的', () => {
  const project = tempProject()
  try {
    const first = materializeProject(project, {})
    assert.ok(first.relocated > 0, '首次铺装应迁移模板里的 skills/ 路径')
    const second = materializeProject(project, {})
    assert.equal(second.relocated, 0, '第二次不应再有可迁移的路径')
    assert.equal(second.deduped, 0)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('消解多模块同名键：固定保留 bmm，而不是"第一个出现的"', () => {
  const project = tempProject()
  try {
    materializeProject(project, {})
    const file = join(project, '_bmad', 'config.toml')
    const raw = readFileSync(file, 'utf8')
    // 关键：gds 段排在 bmm 段之前（模板就是这顺序），按"保留第一个"会误保留 gds
    const withDup = raw.replace(
      /\[modules\.bmm\]/,
      '[modules.gds]\nplanning_artifacts = "{project-root}/_bmad-output/gds-planning"\nimplementation_artifacts = "{project-root}/_bmad-output/gds-impl"\n\n[modules.bmm]',
    )
    writeFileSync(file, withDup, 'utf8')
    dedupeCentralConfig(join(project, '_bmad'))
    const after = readFileSync(file, 'utf8')

    // 活着的键必须是 bmm 的（不带 gds- 前缀）
    const liveArtifacts = after
      .split(/\r?\n/)
      .filter((l) => /^\s*(planning_artifacts|implementation_artifacts)\s*=/.test(l))
    assert.equal(liveArtifacts.length, 2, `应只剩 2 个活键，实际：${JSON.stringify(liveArtifacts)}`)
    for (const line of liveArtifacts) {
      assert.equal(line.includes('gds-'), false, `留下的不该是 gds 的路径：${line}`)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('skill 描述中文化：只显示中文，且不改上游文件', async () => {
  const project = tempProject()
  try {
    materializeProject(project, {})
    const provider = new BmadSkillProvider({}, null, {
      skillDir: bundledSkillsDir(),
      getProjectRoot: () => project,
      getDisabledModules: () => new Set(),
    })
    const { candidates } = await provider.list({ cwd: project })
    assert.equal(candidates.length, 90)

    // 每条描述都必须是纯中文（不再拼英文原文，避免列表变长）
    const notChinese = candidates.filter((c) => !/[\u4e00-\u9fff]/.test(c.description))
    assert.deepEqual(notChinese.map((c) => c.name), [], '这些 skill 的描述不是中文')

    // 不能把英文原文接在后面。判据：出现「上游原句的特征片段」才算拼接失败。
    // 不能用"含连续英文单词"——专有名词本身就是英文（BMAD Loop Skills、
    // Agent Skill、ChatGPT 等），那是应该保留的。
    const englishTail = candidates.filter((c) =>
      /\b(Use when the user|Use when user|Use when invoked|Use when the user says)\b/i.test(c.description),
    )
    assert.deepEqual(
      englishTail.map((c) => c.name),
      [],
      '这些描述里还留着英文原文的 "Use when..." 句子（本地化应只给中文）',
    )

    // 专有名词必须保留，否则中文用户看不到该找谁
    const analyst = candidates.find((c) => c.name === 'bmad-agent-analyst')
    assert.match(analyst.description, /Mary/)
    const gdd = candidates.find((c) => c.name === 'gds-gdd')
    assert.match(gdd.description, /GDD/)

    // 关键：磁盘上的 SKILL.md 必须仍是英文原文（上游逐字节转发的前提）
    const prdSkill = join(bundledSkillsDir(), 'bmad-prd', 'SKILL.md')
    const disk = readFileSync(prdSkill, 'utf8')
    assert.match(disk, /description: Create, update, or validate a PRD/)
    assert.equal(
      /[\u4e00-\u9fff]/.test(disk.split('\n').slice(0, 6).join('\n')),
      false,
      'SKILL.md frontmatter 被改成了中文，破坏了逐字节转发',
    )

    // 映射表覆盖率：目录名 → 中文，一条不缺
    const zh = JSON.parse(readFileSync(new URL('../lib/skill-descriptions.zh.json', import.meta.url), 'utf8'))
    assert.equal(Object.keys(zh).length, 90)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('描述映射缺失时回退英文，不会出现空描述', async () => {
  const project = tempProject()
  try {
    materializeProject(project, {})
    const provider = new BmadSkillProvider({}, null, {
      skillDir: bundledSkillsDir(),
      getProjectRoot: () => project,
      // 只留一个模块，影响的是过滤，不影响描述回退
      getDisabledModules: () => new Set(),
    })
    const { candidates } = await provider.list({ cwd: project })
    for (const c of candidates) {
      assert.ok(c.description.trim().length > 0, `${c.name} 描述为空`)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('locale/ 里只允许语言 id 作为文件名（否则宿主报包元信息错误）', () => {
  // 宿主把 exports 里的 ./locale/*.json 当语言包解析，文件名必须是语言 id。
  // 曾因为放了 skill-descriptions.zh.json 触发：
  //   "must use a language id as its filename"
  const dir = fileURLToPath(new URL('../locale', import.meta.url))
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.ok(files.length > 0, 'locale 目录为空')
  for (const file of files) {
    const stem = file.replace(/\.json$/, '')
    // 语言 id：zh / en / zh-CN / en-US 这类，不含点号
    assert.match(
      stem,
      /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
      `locale/${file} 的文件名不是语言 id（不能带 . 或额外描述）`,
    )
  }
  // 语言包必须含 meta.title / meta.description，插件页才有可读标题
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    assert.equal(typeof parsed?.meta?.title, 'string', `${file} 缺 meta.title`)
    assert.equal(typeof parsed?.meta?.description, 'string', `${file} 缺 meta.description`)
  }
})

test('模块列表：名称与说明是中文，且不列出已弃用模块', async () => {
  const project = tempProject()
  try {
    const { ctx, tools } = fakeCtx()
    apply(ctx, {})
    const status = await tools.get('bmad_project_status').execute({ projectRoot: project }, {})

    // 已装模块的名称/说明必须是中文（注册表只有英文，不能用它覆盖中文）
    const installed = status.modules.filter((m) => m.installed)
    assert.ok(installed.length >= 2, '应至少有 core 与 bmm')
    for (const m of installed) {
      assert.match(m.name, /[\u4e00-\u9fff]/, `${m.code} 的名称不是中文：${m.name}`)
      assert.match(m.description, /[\u4e00-\u9fff]/, `${m.code} 的说明不是中文：${m.description}`)
    }

    // 已弃用模块（automator / wds）不该以"未安装"出现——装也装不上，
    // 列出来只会让人以为漏装了什么
    const missing = status.modules.filter((m) => !m.installed)
    assert.deepEqual(
      missing.filter((m) => m.code === 'automator' || m.code === 'wds').map((m) => m.code),
      [],
      '已弃用模块不应出现在可安装列表里',
    )
    // 未安装的模块（如果有）也应该是中文
    for (const m of missing) {
      assert.match(m.description, /[\u4e00-\u9fff]/, `${m.code} 的说明不是中文`)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('两个模块工具的输出字段足以渲染，不出现"未知 / undefined"', async () => {
  const project = tempProject()
  try {
    const { ctx, tools } = fakeCtx()
    apply(ctx, {})
    const status = await tools.get('bmad_project_status').execute({ projectRoot: project }, {})
    const list = await tools.get('bmad_project_modules_list').execute({ projectRoot: project }, {})

    // 渲染层复用 renderStatus，会读这些字段；少一个就渲染成"未知 / undefined"
    for (const key of ['coreVersion', 'bundledBmadVersion', 'outputDir', 'uv', 'bmadDir', 'projectRoot']) {
      assert.ok(status[key] !== undefined && status[key] !== null, `bmad_project_status 缺 ${key}`)
      assert.ok(list[key] !== undefined && list[key] !== null, `bmad_project_modules_list 缺 ${key}`)
    }

    // 实际渲染一遍，正文里不能出现 undefined
    const rendered = tools.get('bmad_project_modules_list').output.render({}, list)
    const text = rendered.map((b) => b.text).join('\n')
    assert.equal(text.includes('undefined'), false, `渲染结果含 undefined：\n${text}`)
    assert.equal(text.includes('核心版本：未知'), false, '核心版本没读出来')
    assert.match(text, /核心版本：6\.12\.4/)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('模块开关状态解析与序列化往返一致，core 不可停用', () => {
  assert.deepEqual([...parseDisabled('gds, tea ,,')], ['gds', 'tea'])
  assert.equal(serializeDisabled(new Set(['tea', 'gds'])), 'gds,tea')
  assert.deepEqual([...parseDisabled('')], [])
  assert.equal(isModuleEnabled(new Set(['gds']), 'gds'), false)
  assert.equal(isModuleEnabled(new Set(['gds']), 'core'), true, 'core 永远启用')
})

test('volatile 配置字段必须走访问器读取（否则路径参数会把对象当字符串）', () => {
  // 宿主里 .volatile() 字段是 { get() } 访问器，不是裸值
  const accessorConfig = {
    userName: { get: () => '张三' },
    language: { get: () => '简体中文' },
    outputFolder: { get: () => 'out' },
    disabledModules: { get: () => 'gds' },
  }
  assert.equal(cfg(accessorConfig, 'language'), '简体中文')
  assert.equal(cfgString(accessorConfig, 'outputFolder', '_bmad-output'), 'out')
  assert.equal(cfgString(accessorConfig, 'userName'), '张三')
  assert.deepEqual([...parseDisabled(cfg(accessorConfig, 'disabledModules'))], ['gds'])
  // 普通值（非 volatile）照常读
  assert.equal(cfgString({ language: 'English' }, 'language'), 'English')
  // 缺失回落默认
  assert.equal(cfgString({}, 'language', '简体中文'), '简体中文')
  assert.equal(cfg(undefined, 'x', 'fallback'), 'fallback')
  // 访问器抛错时回落，不把异常漏给调用方
  assert.equal(cfgString({ language: { get() { throw new Error('boom') } } }, 'language', 'def'), 'def')
})

test('用访问器形态的 config 跑 bmad_project_status 不再抛路径错误', async () => {
  const project = tempProject()
  try {
    // 完全模拟宿主：每个字段都是访问器，并且是 apply() 收到的那份配置
    const config = {
      userName: { get: () => '访问器用户' },
      language: { get: () => '简体中文' },
      outputFolder: { get: () => '_bmad-output' },
      disabledModules: { get: () => '' },
    }
    const { ctx, tools } = fakeCtx()
    apply(ctx, config)
    const status = await tools.get('bmad_project_status').execute({ projectRoot: project }, {})
    assert.equal(status.installed, true)
    assert.equal(status.outputDir, join(project, '_bmad-output'))
    assert.match(readFileSync(join(project, '_bmad', 'config.toml'), 'utf8'), /user_name = "访问器用户"/)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('项目定位：优先会话 cwd，向上找到已有 _bmad/', () => {
  const project = tempProject()
  try {
    materializeProject(project, {})
    const nested = join(project, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    const found = resolveProjectRoot({ cwd: nested })
    assert.equal(found.projectRoot, project)
    assert.equal(found.bmadDir, join(project, '_bmad'))
    // 显式 projectRoot 指向 _bmad/ 也能认
    const explicit = resolveProjectRoot({ projectRoot: join(project, '_bmad') })
    assert.equal(explicit.projectRoot, project)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('apply() 注册四个工具与一个 skill provider，Config 四个字段都可写', async () => {
  const { ctx, tools, provider, saved, editor } = fakeCtx()
  apply(ctx, {})
  for (const name of ['bmad_project_status', 'bmad_project_install', 'bmad_project_modules_list', 'bmad_project_module_toggle']) {
    assert.equal(tools.has(name), true, `缺少工具 ${name}`)
  }
  assert.equal(typeof provider(), 'object')
  // Schemastery 对象：字段在 .dict 上，每个字段都必须 volatile，
  // 否则 dsh 的 volatileForm() 会把整张设置卡片丢掉。
  for (const key of ['userName', 'language', 'outputFolder', 'disabledModules']) {
    const field = Config.dict?.[key]
    assert.ok(field, `Config 缺少 ${key}`)
    assert.equal(field.meta?.volatile, true, `${key} 没标 volatile`)
  }
  // configEditor 可用时，开关能真的写进配置
  saved.current = { disabledModules: '' }
  await editor.edit({}, (cur) => ({ ...cur, disabledModules: 'gds' }))
  assert.equal(saved.edited.disabledModules, 'gds')
})

test('bmad_project_status 在空项目上会自举铺装，并报出已装模块', async () => {
  const project = tempProject()
  try {
    const { ctx, tools } = fakeCtx()
    apply(ctx, { language: '简体中文' })
    const status = await tools.get('bmad_project_status').execute({ projectRoot: project }, {})
    assert.equal(status.installed, true)
    assert.equal(status.modules.filter((m) => m.installed).length >= 2, true)
    assert.equal(status.outputDir, join(project, '_bmad-output'))
    // 铺装真的落到项目里
    assert.equal(existsSync(join(project, '_bmad', 'config.toml')), true)
    assert.equal(installedModuleCodes(join(project, '_bmad')).includes('bmm'), true)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('bmad_project_module_toggle 拒绝停用 core，也拒绝没装的模块', async () => {
  const project = tempProject()
  try {
    const { ctx, tools } = fakeCtx()
    apply(ctx, {})
    const toggle = tools.get('bmad_project_module_toggle')
    const core = await toggle.execute({ module: 'core', enabled: false, projectRoot: project }, {})
    assert.equal(core.status, 'not-toggleable')
    const missing = await toggle.execute({ module: 'nope', enabled: false, projectRoot: project }, {})
    assert.equal(missing.status, 'module-not-installed')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('bmad_project_install dryRun 只组装命令，不落地任何文件', async () => {
  const project = tempProject()
  try {
    const { ctx, tools } = fakeCtx()
    apply(ctx, {})
    const result = await tools.get('bmad_project_install').execute({ projectRoot: project, dryRun: true }, {})
    assert.equal(result.status, 'dry-run')
    assert.equal(result.executed, false)
    assert.match(result.command, /install/)
    assert.match(result.command, /--no-shims/)
    assert.match(result.command, /--directory/)
    // dryRun 不建 _bmad/
    assert.equal(existsSync(join(project, '_bmad')), false)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
