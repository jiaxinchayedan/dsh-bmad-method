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

/** 各模块的一句话说明，注册表没给时兜底。 */
export const MODULE_BLURB = {
  core: '公共地基：帮助、头脑风暴、定制、调研、评审',
  bmm: '主力：PRD、架构、故事、代码审查、回顾',
  bmb: '造模块：造 agent、造工作流、造模块',
  tea: '测试架构：测试设计、ATDD、CI 流水线、可追溯',
  cis: '创意：设计思维、创新策略、故事叙述、问题解决',
  gds: '游戏开发：GDD、游戏架构、试玩计划、游戏测试',
  'bmad-loop': '无人值守开发循环：建、验、复盘一整条史诗',
}

/** 排序：已知模块按 MODULE_ORDER，未知的排在后面按字母。 */
export function moduleRank(code) {
  const index = MODULE_ORDER.indexOf(code)
  return index === -1 ? MODULE_ORDER.length : index
}
