// node-local: PCG 业务侧 engine ExecutionRuntime 实现 (node_local)
//
// dynamic import skills/{skill_id}/main.mjs 直接跑 run(inputs, ctx).
// 仅 Node 环境 (Electron / Node CLI), 浏览器跑不动 (无 import file://).
//
// 注册到 engine: engine.registerExecutionRuntime('node_local', createNodeLocalRuntime({skillsDir}))
// 跟 engine ExecutionRuntime interface 对齐: { run_skill: async (skillId, inputs, ctx) => result }
//
// 跟 PCG 段 3 plan §Task 3.3 对齐. 段 5 真 skill 起需该 runtime.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 工厂: 建 PCG node_local execution runtime.
 *
 * @param {object} opts
 * @param {string} opts.skillsDir — PCG 仓 skills/ 绝对路径
 * @returns {{run_skill: (skillId: string, inputs: object, ctx: object) => Promise<object>}}
 */
export function createNodeLocalRuntime({ skillsDir } = {}) {
  if (!skillsDir || typeof skillsDir !== 'string') {
    throw new Error('createNodeLocalRuntime 需 skillsDir 绝对路径');
  }
  return {
    run_skill: async (skillId, inputs, ctx) => {
      const mainPath = path.join(skillsDir, skillId, 'main.mjs');
      const mod = await import(pathToFileURL(mainPath).href);
      if (typeof mod.run !== 'function') {
        throw new Error(`node_local ${skillId}: main.mjs 必须 export run(inputs, ctx)`);
      }
      const result = await mod.run(inputs, ctx);
      // engine ExecutionRuntime contract: 返 Record (outputs_summary 字段直接在 result 内)
      if (result && typeof result === 'object') {
        return result;
      }
      return {};
    },
  };
}
