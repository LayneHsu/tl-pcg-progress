// pcg/types.js — PCG 业务类型 validator (engine.registerType)
//
// engine 内置 BUILTIN_TYPES (string / int / bool / float / array / object) — 业务无关.
// 本文件加 4 个 PCG 特有类型, 不进 engine 仓 (engine 业务无关).
//
// 跟 PCG 段 4 plan §Task 4.0 对齐. 由 workflow.config.js 启动时调 registerPcgTypes.

/**
 * PCG 4 业务类型 validator map.
 * 跟看板 templates.json / store.json sub_theme 字段对齐.
 */
export const PCG_TYPES = {
  // UE asset 路径: '/Game/...' 或带 ClassType 前缀 (例 "StaticMesh'/Game/Foo/SM_Bar.SM_Bar'")
  ue_asset_path: (v) =>
    typeof v === 'string' &&
    (v.startsWith('/Game/') || /^[A-Za-z_][A-Za-z0-9_]*'/.test(v)),

  // 主题缩写 (2-4 大写字母, 例 'YWMD')
  theme_short: (v) => typeof v === 'string' && /^[A-Z]{2,4}$/.test(v),

  // PCG 5 色状态 (跟看板 status badge 对齐)
  // undetected = 灰, red = 红, yellow = 黄, green = 绿, blue = 蓝 (审核中)
  '5_color_status': (v) =>
    typeof v === 'string' &&
    ['undetected', 'red', 'yellow', 'green', 'blue'].includes(v),

  // DataTable 行路径 (例 '/Game/PCG/DT_Foo.DT_Foo:Row_1')
  // ue_asset_path 加 ':RowName' 后缀; 用 ':' 当分隔符校验最小特征
  dt_row_path: (v) =>
    typeof v === 'string' && v.includes(':') && (v.startsWith('/Game/') || /^[A-Za-z_]/.test(v)),
};

/**
 * 一站式注册全 4 类型到 engine.
 *
 * @param {object} engine — agentic-workflow-engine Engine 实例 (有 registerType API)
 */
export function registerPcgTypes(engine) {
  for (const [name, validator] of Object.entries(PCG_TYPES)) {
    engine.registerType(name, validator);
  }
}
