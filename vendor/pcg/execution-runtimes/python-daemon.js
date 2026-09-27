// python-daemon: PCG 业务侧 engine ExecutionRuntime 实现 (python_daemon)
//
// 桥接 PCG 看板 (浏览器) → v8_framework daemon (UE Python) skill_runner.
// 看板侧 run_skill 写 agentTriggerQueue (加 workflow_id 字段做 engine path 标记),
// daemon _process_pending_queue 双轨 dispatcher 路由到 skill_runner.run_from_trigger
// → 跑 skills/{skill_id}/main.py → 写 nodeRuns. 看板侧 onSnapshot 等终态.
//
// 注册到 engine: engine.registerExecutionRuntime('python_daemon', createPythonDaemonRuntime(fbDb, fbUser))
// 跟 engine ExecutionRuntime interface 对齐: { run_skill: async (skillId, inputs, ctx) => result }
//
// 跟 PCG 段 3 plan §Task 3.1 对齐.

import { pollFirestoreDoc } from '../runtime-adapters/poll-helper.js';

// agentTriggerQueue 终态枚举 (跟 v8 queue_writer STATUS_SUCCESS/FAILED/CANCELLED 对齐)
const TERMINAL_STATUSES = ['success', 'failed', 'cancelled'];

/**
 * 工厂: 建 PCG python_daemon execution runtime.
 *
 * @param {object} fbDb — Firebase Firestore client
 * @param {{uid: string} | null} fbUser — 登录用户 (审计 triggered_by)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=300000] — agentTriggerQueue poll 超时 (默认 5 min, executor 可能慢)
 * @param {() => any} [opts.serverTimestamp] — 默认走 compat 全局, modular SDK 传 callback
 * @returns {{run_skill: (skillId: string, inputs: object, ctx: object) => Promise<object>}}
 */
export function createPythonDaemonRuntime(fbDb, fbUser, { timeoutMs = 300000, serverTimestamp } = {}) {
  if (!fbDb || typeof fbDb.collection !== 'function') {
    throw new Error('createPythonDaemonRuntime 需 firebase firestore client');
  }
  const tsFactory = serverTimestamp || (() => firebase.firestore.FieldValue.serverTimestamp());
  return {
    run_skill: async (skillId, inputs, ctx) => {
      const docRef = await fbDb.collection('agentTriggerQueue').add({
        // engine path 标记字段 (daemon 双轨 dispatcher 路由 key)
        workflow_id: ctx.workflow_id,
        skill_id: skillId,
        instance_id: ctx.instance_id,
        node_id: ctx.node_id,
        run_id: ctx.run_id,
        inputs,
        // Phase 2A schema alias — firestore/rules.rules agentTriggerQueue.create
        // 强制 agent_id/work_item/sub_theme_id/params 四字段存在; engine path
        // 这里复写一份指向同值 (daemon 路由仍按 workflow_id 字段, alias 不影响逻辑).
        // 段 7 Phase 2A 老资产迁完后可考虑 rules 加分支按 workflow_id 区分 schema.
        agent_id: skillId,
        work_item: skillId,
        sub_theme_id: ctx.instance_id,
        params: inputs,
        triggered_by: ctx.triggered_by || (fbUser && fbUser.uid) || 'anonymous',
        triggered_at: tsFactory(),
        status: 'pending',
      });
      const final = await pollFirestoreDoc(docRef, {
        timeoutMs,
        terminalStatuses: TERMINAL_STATUSES,
      });
      if (final.status === 'failed') {
        throw new Error(`python_daemon ${skillId} failed: ${final.error_message || '<no message>'}`);
      }
      if (final.status === 'cancelled') {
        throw new Error(`python_daemon ${skillId} cancelled`);
      }
      // engine ExecutionRuntime contract: 返 Record 顶层=outputs map (按 node schema outputs name
      // 直接放, e.g. {row_count, json_path}). engine.summarizeOutputs(y, node.outputs) 从 y 顶层抽.
      // v8 mark_success 写 agentTriggerQueue.result_summary = skill main return 的 outputs_summary
      // (e.g. {row_count, json_path, success_criteria_value}) — 这就是顶层 outputs map.
      // 不能再 wrap {outputs_summary: ...} (段 6.2.2 P2 fix, 否则 engine summarize 抽不到字段 → audit
      // modal 显 outputs_summary={} 空, 数据丢在嵌套).
      return final.result_summary || {};
    },
  };
}
