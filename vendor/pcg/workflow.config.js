// workflow.config.js — PCG 业务侧 engine 5 扩展点 + RBAC 一站式注册
//
// 看板启动时调 configurePcgWorkflow(engine, opts), 把 PCG 业务概念
// (templates.json / sub_theme / 4 业务类型 / UE/Houdini 集成) 注册到 engine.
//
// 浏览器 + Node CLI 双环境兼容:
//   - 浏览器: 全 register 都跑, 但 node_local / hython_subprocess 跳过 (无 fs 跑不动)
//   - Node CLI: 全 register 跑, hython_subprocess 需 H21 Utils bridge/package/resolver 三项 opt
//
// 跟 PCG 段 4 plan §Task 4.2 对齐. 由 deploy/index.html 看板启动调.

import { registerPcgTypes } from './types.js';
import { templatesToWorkflows } from './adapters/templates-converter.js';
import { createUeRuntimeAdapter } from './runtime-adapters/ue-runtime.js';
import { createPythonDaemonRuntime } from './execution-runtimes/python-daemon.js';

// PCG sub_theme instance_data schema (跟看板 store.json sub_theme 字段对齐).
// 段 4 schema 仅必填字段 + 5_color_state, 段 8 真业务起按需扩.
//
// ⚠️ engine v0.4 当前不自动 validate instance_data 跟 schema (只 store registry, 见
// agentic-workflow-engine/ui/engine.ts:289 — instance_data 直接 pass-through 不校验).
// 段 6 UI 整合时应 caller 端用 PCG_INSTANCE_SCHEMA 校验后再 planTrigger;
// 或推动 engine v0.5+ 加 instance_data 校验 (新 deferred concern).
export const PCG_INSTANCE_SCHEMA = {
  type: 'object',
  required: ['theme_short', 'name'],
  properties: {
    theme_short: { type: 'string', pattern: '^[A-Z]{2,4}$' },
    name: { type: 'string' },
    abbreviation: { type: 'string' },
    parent_theme_id: { type: 'string' },
    sub_theme_id: { type: 'string' },
    five_color_state: { type: 'object' },
  },
};

/**
 * 检测当前环境是否 Node (含 fs / spawn).
 */
function isNodeRuntime() {
  return typeof process !== 'undefined' && !!(process.versions && process.versions.node);
}

/**
 * RBAC: viewer 不能跑, editor 不能跑 is_destructive=true, admin 全可.
 * 段 4 简版, 段 6 UI 整合可扩 (per-skill ACL / 时间窗 / 等).
 *
 * @param {string | (() => string)} roleOrGetter — 静态 role 字符串, 或返 role 的 getter.
 *   getter 形式让 RBAC 动态读 (例如 Vue ref / window.__fbRole) — 用户登录后角色变化也生效,
 *   不用重 configure engine. 段 4 deploy/index.html 用 getter 模式.
 * @returns {(triggeredBy: string, plan: object) => boolean}
 */
export function createPcgAuthorizationCheck(roleOrGetter) {
  const getRole = typeof roleOrGetter === 'function' ? roleOrGetter : () => roleOrGetter;
  return (triggeredBy, plan) => {
    const role = getRole();
    if (role === 'admin') return true;
    if (role === 'viewer') return false;
    // editor (跟其他非 admin/viewer): 拒绝任何 skill_prechecks 含 is_destructive 的 plan
    const prechecks = (plan && plan.skill_prechecks) || [];
    return !prechecks.some((p) => p && p.is_destructive);
  };
}

/**
 * 一站式注册 PCG 业务概念到 engine.
 *
 * @param {object} engine — agentic-workflow-engine Engine 实例
 * @param {object} opts
 * @param {object} opts.fbDb — Firebase Firestore client (UE runtime adapter / python_daemon 用)
 * @param {{uid: string}|null} opts.fbUser — 登录用户 (审计 + RBAC)
 * @param {string | (() => string)} opts.fbRole — 'viewer' | 'editor' | 'admin' 字符串,
 *   或返 role 的 getter (推荐 — 用户登录后角色变化无需重 configure)
 * @param {object} opts.templatesJson — data/templates.json 内容
 * @param {object} [opts.skillSchemas={}] — { skillId: schema } 预加载的 skills/&lt;id&gt;/schema.json
 * @param {Function} [opts.createHythonRuntimeFactory] — 仅 Node + Houdini 用. 调用方传
 *   `() => createHythonSubprocessRuntime({bridgeScript, h21PackagePath, resolverPythonPath})`.
 *   三项均为显式路径；浏览器忽略。
 * @returns {object} 注册统计 {workflowCount, skillCount, runtimes, types, schemas}.
 *   schemas.instance 是 PCG_INSTANCE_SCHEMA 引用, 段 6 UI 可拿去验数据.
 */
export function configurePcgWorkflow(engine, opts) {
  const {
    fbDb,
    fbUser,
    fbRole = 'viewer',
    templatesJson,
    skillSchemas = {},
    createHythonRuntimeFactory,
  } = opts || {};

  if (!engine || typeof engine.registerType !== 'function') {
    throw new Error('configurePcgWorkflow 需 agentic-workflow-engine Engine 实例');
  }
  if (!templatesJson) {
    throw new Error('configurePcgWorkflow 需 templatesJson');
  }

  // 1. 类型 (4 PCG type)
  registerPcgTypes(engine);

  // 2. workflow + instance_schema
  const workflows = templatesToWorkflows(templatesJson);
  for (const wf of workflows) {
    engine.registerWorkflow(wf.id, wf);
    engine.registerInstanceSchema(wf.id, PCG_INSTANCE_SCHEMA);
  }

  // 3. skill schemas (caller 预加载, 浏览器 fetch / Node fs)
  for (const [skillId, schema] of Object.entries(skillSchemas)) {
    engine.registerSkillSchema(skillId, schema);
  }

  // 4. runtime adapter — UE 数据查询 (浏览器 + Node 都需要, 走 Firestore 桥接)
  if (fbDb) {
    engine.registerRuntimeAdapter('ue_runtime', createUeRuntimeAdapter(fbDb, fbUser));
  }

  // 5. execution runtimes — 按环境 + 配置 注册.
  // node_local 不在这注册 — 浏览器 ESM 限制 (`if (...) await import(...)` 顶层不行).
  // Node CLI caller 显式 await attachNodeLocalRuntime(engine, skillsDir) 后加, 见 named export.
  const runtimes = [];
  if (fbDb) {
    engine.registerExecutionRuntime('python_daemon', createPythonDaemonRuntime(fbDb, fbUser));
    runtimes.push('python_daemon');
  }
  if (createHythonRuntimeFactory && isNodeRuntime()) {
    engine.registerExecutionRuntime('hython_subprocess', createHythonRuntimeFactory());
    runtimes.push('hython_subprocess');
  }

  // 6. RBAC (支持 role getter — 用户登录后角色变化自动生效, 不用 reconfigure)
  engine.setAuthorizationCheck(createPcgAuthorizationCheck(fbRole));

  return {
    workflowCount: workflows.length,
    skillCount: Object.keys(skillSchemas).length,
    runtimes,
    types: ['theme_short', 'ue_asset_path', '5_color_status', 'dt_row_path'],
    role: typeof fbRole === 'function' ? '<dynamic>' : fbRole,
    schemas: { instance: PCG_INSTANCE_SCHEMA },
  };
}

/**
 * Node-only helper: 异步加载 node_local runtime 并注册.
 *
 * 浏览器 ESM 不能 `if (...) await import(...)` 在顶层 — 提取到 named async export.
 * 浏览器 caller 不调本 helper. Node CLI caller 在 configurePcgWorkflow 之后:
 *   await attachNodeLocalRuntime(engine, skillsDir);
 *
 * @param {object} engine — Engine 实例
 * @param {string} skillsDir — PCG 仓 skills/ 绝对路径
 */
export async function attachNodeLocalRuntime(engine, skillsDir) {
  if (!isNodeRuntime()) {
    throw new Error('attachNodeLocalRuntime 仅 Node 环境可用 (浏览器没 fs/import file://)');
  }
  const { createNodeLocalRuntime } = await import('./execution-runtimes/node-local.js');
  engine.registerExecutionRuntime('node_local', createNodeLocalRuntime({ skillsDir }));
  return 'node_local';
}
