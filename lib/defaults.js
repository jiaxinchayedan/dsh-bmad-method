/** 默认值与常量。 */

/** 默认语言：沟通 + 文档输出。上游默认英文，这里按中文用户默认简体中文。 */
export const DEFAULT_LANGUAGE = '简体中文'

/** 默认产物目录名（安装器 `--output-folder` 默认值）。 */
export const DEFAULT_OUTPUT_FOLDER = '_bmad-output'

/**
 * 默认停用的模块：空。
 *
 * 上游 `default_selected` 只影响安装器的勾选默认值，不影响"已装即可用"。
 * 本插件把 7 个模块全都装齐、默认全开，用户用不到的去设置页关掉即可。
 */
export const DEFAULT_DISABLED_MODULES = []

/** 首次非交互安装必须给 `--tools`；本插件不铺 IDE 文件，只是让安装器过校验。 */
export const INSTALLER_TOOLS = 'claude-code'

/** 模块展示顺序（设置卡片用）：地基在前，主题模块在后。 */
export const MODULE_ORDER = ['core', 'bmm', 'bmb', 'tea', 'cis', 'gds', 'bmad-loop']

/**
 * 各模块的中文名与说明。
 *
 * 设置卡片里显示的是这份，**优先于**官方注册表里的英文 `name`/`description`。
 * 注册表（bmad-modules.yaml）只有英文，直接用它会让卡片一半中文一半英文；
 * 所以这里按 code 覆盖。注册表里没有的新模块仍回退英文，不会显示为空。
 */
export const MODULE_LABELS = {
  core: {
    name: 'BMad 核心',
    description: '公共地基：帮助、头脑风暴、定制、调研、评审',
  },
  bmm: {
    name: 'BMad 方法',
    description: '敏捷规划与交付主模块：分析、规划、架构、实施全流程',
  },
  bmb: {
    name: 'BMad 构建器',
    description: '造 skill、造工作流、造 agent',
  },
  tea: {
    name: 'BMad 测试架构',
    description: '企业级测试：测试设计、ATDD、CI 流水线、可追溯',
  },
  cis: {
    name: 'BMad 创意套件',
    description: '创意伙伴：设计思维、创新策略、故事叙述、问题解决',
  },
  gds: {
    name: 'BMad 游戏开发工作室',
    description: '构思、设计并开发游戏：GDD、游戏架构、试玩计划、游戏测试',
  },
  'bmad-loop': {
    name: 'BMad 循环',
    description: '无人值守开发循环：建、验、复盘一整条史诗',
  },
  automator: {
    name: 'BMad 自动化构建器（实验）',
    description: '已弃用，由 BMad Loop 取代',
  },
  wds: {
    name: 'Whiteport 设计工作室',
    description: '已弃用，能力正并入 BMad 方法（bmm）的 UX 功能',
  },
}

/** 旧名兼容：代码里仍按 MODULE_BLURB 取一句话说明。 */
export const MODULE_BLURB = Object.fromEntries(
  Object.entries(MODULE_LABELS).map(([code, label]) => [code, label.description]),
)

/** 排序：已知模块按 MODULE_ORDER，未知的排在后面按字母。 */
export function moduleRank(code) {
  const index = MODULE_ORDER.indexOf(code)
  return index === -1 ? MODULE_ORDER.length : index
}
