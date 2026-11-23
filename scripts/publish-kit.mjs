#!/usr/bin/env node
/**
 * 生成 awesome-dsh-plugin 的收录条目 + PR 描述。
 *
 * 用法：node scripts/publish-kit.mjs <github-owner>
 * 需要先建好 GitHub 仓库；owner 就是仓库所属账号。
 *
 * 生成后会自己解析一遍条目，解析失败直接非零退出 —— 榜单 CI 第一步就是这个。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { parse } from 'yaml'

const owner = (process.argv[2] ?? '').trim()
if (!owner) {
  console.error('用法: node scripts/publish-kit.mjs <github-owner>')
  process.exit(2)
}
if (!/^[A-Za-z0-9-]+$/.test(owner)) {
  console.error(`owner 不合法: ${owner}（只允许字母、数字、连字符）`)
  process.exit(2)
}

const repo = 'dsh-bmad-method'
const full = `${owner}/${repo}`

// YAML 单引号标量：内部的单引号要写成两个。不要用 shell 风格转义，那是 bug 来源。
const en =
  "Installs BMad Method 6.12.4 into a project as a dsh plugin: 90 skills across 7 modules " +
  '(planning, build, review, testing, game dev, creative, unattended loop), one _bmad/ per ' +
  "project, with per-module switches that hide a module's skills without deleting anything."
const zh =
  '把 BMad Method 6.12.4 装进项目的 dsh 插件：7 个模块共 90 个 skill（规划、实施、评审、测试、' +
  '游戏开发、创意、无人值守循环），每个项目各自一份 _bmad/，模块可逐个开关——只隐藏该模块的 ' +
  'skill，不删任何文件。'

const quote = (s) => `'${s.replaceAll("'", "''")}'`

const entry = `url: https://github.com/${full}
name: ${full}
category: skill
description:
  en: ${quote(en)}
  zh: ${quote(zh)}
`

// 先自检：解析不了就别写盘
const parsed = parse(entry)
const problems = []
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(parsed?.url ?? '')) problems.push('url 格式不对')
if (typeof parsed?.name !== 'string' || !parsed.name.includes('/')) problems.push('name 格式不对')
if (typeof parsed?.category !== 'string' || !parsed.category) problems.push('category 缺失')
if (typeof parsed?.description?.en !== 'string' || !parsed.description.en.trim()) problems.push('description.en 缺失')
if (!parsed?.description?.en?.trim().endsWith('.')) problems.push('description.en 必须以句号结尾')
if (problems.length > 0) {
  console.error('条目自检失败:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}

mkdirSync('data-plugins', { recursive: true })
writeFileSync(`data-plugins/${owner}__${repo}.yml`, entry)
console.log(`ok  data-plugins/${owner}__${repo}.yml`)

const pr = `## Adding ${full}

A dsh port of [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) (MIT, BMad Code, LLC).

**What it does.** Ships the method's 90 skills with the package and exposes them as a
dsh skill provider, so a project gets BMad without running \`npx bmad-method install\`.
The runtime is materialized into the project's own \`_bmad/\` on first use, matching what
the official installer produces; the official installer itself is invoked by the
\`bmad_project_install\` tool for module updates. Four tools: \`bmad_project_status\`,
\`bmad_project_install\`, \`bmad_project_modules_list\`, \`bmad_project_module_toggle\`.
A module switch only hides that module's skills — no files are deleted.

**Manifest.** \`package.json\` declares both \`dsh.bundle\` (patch: \`./cordis.patch.yml\`)
and \`dsh.client\` (web settings card). \`@deepseek-ai/schemastery\` is a peer dependency;
the host provides it.

**Numbers in the description, checkable:**

- 90 skills: \`ls skills | wc -l\` → 90; each directory has a \`SKILL.md\`.
- 7 modules, per \`skills/manifest.json\`: \`core\` 8, \`bmm\` 21, \`bmb\` 5, \`tea\` 10,
  \`cis\` 10, \`gds\` 33, \`bmad-loop\` 3 → 90.
- 4 tools, registered in \`index.js\` as \`bmad_project_*\`.
- Per-project \`_bmad/\`: \`lib/runtime.js\`, \`materializeProject()\`.
- Switch hides skills without touching files: \`lib/skills.js\` \`list()\` filters by
  \`disabledModules\`; there is no delete or serialize path for module files.

**Upstream licensing.** \`skills/\` and \`bmad-home/\` are redistributed verbatim under
BMad's MIT license; scope and our modifications are listed in \`THIRD-PARTY-NOTICES.md\`.
"BMad" is a trademark of BMad Code, LLC; this is an unofficial port, stated in the README.

**No telemetry.** No network at install or at run, except the upstream installer the user
invokes explicitly through \`bmad_project_install\`.
`

writeFileSync('data-plugins/PR.md', pr)
console.log('ok  data-plugins/PR.md')
