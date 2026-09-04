// ue-runtime: PCG 业务侧 engine RuntimeAdapter 实现
//
// 桥接 PCG 看板 (浏览器) → v8_framework daemon (UE Python). 看板侧 query 写
// Firestore `runtimeQueries` collection, daemon poll claim + 调 UE Python +
// 写 result. 看板侧 onSnapshot 等终态 (poll-helper.js).
//
// 注册到 engine: engine.registerRuntimeAdapter('ue_runtime', createUeRuntimeAdapter(fbDb, fbUser))
// declarative 安全: 4 query type 写死 whitelist, engine.queryRuntime 校验后才 dispatch.
//
// 跟 PCG 段 2 plan §Task 2.1 对齐. PCG 段 4 workflow.config.js 启动时调本工厂注册.

import { pollFirestoreDoc } from './poll-helper.js';

export const UE_RUNTIME_QUERY_TYPES = [
  'level_actor_count',
  'selected_assets',
  'asset_exists',
  'list_assets_in_folder',
];

/**
 * 工厂: 建 PCG ue_runtime adapter, 接入 engine.registerRuntimeAdapter.
 *
 * @param {object} fbDb — Firebase Firestore client (compat 或 modular 都支持, 需有 .collection())
 * @param {{uid: string} | null} fbUser — 登录用户 (审计 requested_by 字段)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000] — pollFirestoreDoc 超时
 * @param {() => any} [opts.serverTimestamp] — 返服务端时间戳哨兵的工厂. 默认走 compat
 *   全局 `firebase.firestore.FieldValue.serverTimestamp()`. modular SDK 应传
 *   `() => serverTimestamp()` (import from 'firebase/firestore').
 * @returns {{query_types_whitelist: string[], handler: (query: object, ctx: object) => Promise<any>}}
 */
export function createUeRuntimeAdapter(fbDb, fbUser, { timeoutMs = 30000, serverTimestamp } = {}) {
  if (!fbDb || typeof fbDb.collection !== 'function') {
    throw new Error('createUeRuntimeAdapter 需 firebase firestore client');
  }
  const tsFactory = serverTimestamp || (() => firebase.firestore.FieldValue.serverTimestamp());
  return {
    query_types_whitelist: UE_RUNTIME_QUERY_TYPES,
    handler: async (query, ctx) => {
      const docRef = await fbDb.collection('runtimeQueries').add({
        adapter: 'ue_runtime',
        query,
        ctx: ctx || {},
        requested_at: tsFactory(),
        requested_by: (fbUser && fbUser.uid) || 'anonymous',
        status: 'pending',
      });
      const final = await pollFirestoreDoc(docRef, { timeoutMs });
      if (final.status === 'failed') {
        throw new Error(`ue_runtime ${query.type} failed: ${final.error_message || '<no message>'}`);
      }
      return final.result;
    },
  };
}
