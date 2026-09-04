// poll-helper: Firestore onSnapshot 等终态 + timeout
//
// 用 onSnapshot (推送) 不轮询 get() — 省 Firestore quota 50%+, 延迟更低.
// 默认终态 = status in ['completed', 'failed'] (runtimeQueries schema).
// 段 3 agentTriggerQueue 调用方传 terminalStatuses=['success','failed','cancelled'].
//
// 跟 PCG 段 2 plan §Task 2.2 + 段 3 plan §Task 3.1 对齐.

/**
 * 等 Firestore doc 状态达终态后 resolve 含 doc data.
 * 超时 reject. 自动 unsubscribe 不泄漏 onSnapshot 监听.
 *
 * @param {object} docRef — Firebase DocumentReference (compat / modular 都支持)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {string[]} [opts.terminalStatuses=['completed','failed']] — 终态枚举.
 *   runtimeQueries 默认 ['completed','failed']; agentTriggerQueue 应传
 *   ['success','failed','cancelled'].
 * @returns {Promise<object>} doc data
 */
export function pollFirestoreDoc(docRef, { timeoutMs = 30000, terminalStatuses = ['completed', 'failed'] } = {}) {
  const terminalSet = new Set(terminalStatuses);
  return new Promise((resolve, reject) => {
    let settled = false;
    let pendingTerminalEvent = null;

    // unsub 起手 noop, 防 onSnapshot 同步触发 (cached read) 时 cleanup 拿 null.
    // Firebase Web SDK 通常 async, 但官方契约没保证 — 用 placeholder 兜底.
    let unsub = () => {
      pendingTerminalEvent = 'pre-subscribed';
    };

    const cleanup = () => {
      try {
        unsub();
      } catch (e) {
        // unsub 第二次调可能抛, 忽略
      }
      unsub = () => {};
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`pollFirestoreDoc timeout ${timeoutMs}ms (docRef ${docRef.id})`));
    }, timeoutMs);

    const realUnsub = docRef.onSnapshot(
      (snap) => {
        if (settled) return;
        if (!snap.exists) return;
        const data = snap.data();
        if (terminalSet.has(data.status)) {
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve(data);
        }
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(err);
      },
    );

    // 接管真 unsub. 若 onSnapshot 已同步触发并 resolve, 现在补做 cleanup.
    unsub = realUnsub;
    if (settled || pendingTerminalEvent) {
      try { realUnsub(); } catch (e) { /* noop */ }
    }
  });
}
