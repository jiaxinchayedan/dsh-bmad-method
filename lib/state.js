/**
 * 模块开关状态。
 *
 * 状态存在**插件自己的配置**里，不写 profile 的 `cordis.patch.yml`。
 * 原因：那份文件是用户自己的，里面有别的插件的行、注释和 `!!js` 表达式；
 * dsh 的插件契约（`references/host-plugin.md`）明确要求插件用 `configEditor`
 * 改自己的配置，而不是按行改写整个 profile 补丁。旧实现按行改 profile 补丁，
 * 一旦用户重排过文件或别的插件插了行就会错位。
 *
 * 语义：开关只决定这个模块的 skill 参不参与 dsh，**不动任何文件**。
 * 停用 = 它的 skill 从清单里消失；重新启用 = 又回来。
 */
import { DEFAULT_DISABLED_MODULES } from './defaults.js'

/** 把配置里的逗号串解析成 Set。 */
export function parseDisabled(value) {
  if (Array.isArray(value)) return new Set(value.filter((v) => typeof v === 'string' && v.trim()))
  if (typeof value === 'string') {
    return new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return new Set(DEFAULT_DISABLED_MODULES)
}

/** Set → 写回配置用的逗号串。 */
export function serializeDisabled(set) {
  return [...set].filter(Boolean).sort().join(',')
}

/**
 * 读一个配置值。
 *
 * `.volatile()` 字段在宿主侧是**访问器**，不是裸值：`config.language` 拿到的是
 * 一个对象，必须用 `config.language.get()` 才取到当前值（改完原地生效也是靠这个）。
 * 非 volatile 的字段则是普通值。这里统一两种情况，避免调用方直接 `join(path, config.x)`
 * 时把访问器当字符串用（实测报 `The "path" argument must be of type string`）。
 */
export function cfg(config, key, fallback = undefined) {
  if (config === undefined || config === null) return fallback
  const raw = config[key]
  if (raw === undefined || raw === null) return fallback
  // volatile 访问器：{ get(), ... }
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      const value = raw.get()
      return value === undefined || value === null ? fallback : value
    } catch {
      return fallback
    }
  }
  return raw
}

/** 读一个字符串配置值，并保证返回真字符串。 */
export function cfgString(config, key, fallback = '') {
  const value = cfg(config, key, fallback)
  return typeof value === 'string' ? value : fallback
}

/** 判断某个模块当前是否启用。`core` 是地基，永远启用。 */
export function isModuleEnabled(disabledSet, code) {
  if (code === 'core') return true
  return !disabledSet.has(code)
}

/**
 * 改插件自己的配置。
 *
 * `ctx.fiber.entry` 是当前 Loader 行；`configEditor.edit` 负责校验、串行化写盘、
 * 并让 dsh 走正常的重载路径。改 `.volatile()` 字段是原地生效，不重启插件。
 *
 * 拿不到 entry 或 editor 时抛出可读原因，让工具层如实报告，而不是假装成功。
 */
export async function updateOwnConfig(ctx, mutate) {
  const entry = ctx?.fiber?.entry
  const editor = ctx?.get?.('configEditor') ?? ctx?.configEditor
  if (entry === undefined) throw new Error('拿不到当前插件条目（ctx.fiber.entry），无法保存配置')
  if (editor === undefined || typeof editor.edit !== 'function') {
    throw new Error('当前 profile 没有 configEditor 服务，无法保存配置')
  }
  await editor.edit(entry, (current) => mutate({ ...current }))
}
