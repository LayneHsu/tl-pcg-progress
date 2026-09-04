// PCG firebase RunStore — engine.runStore 11 方法 contract 实装
//
// 设计文档: agentic-workflow-engine docs/api.md §7 RunStore 接口
// 段 6 review P0-1 fix (2026-05-19): 段 4 spike runStore 是 in-memory mock (4 方法
// create/update/get/list), engine.confirmAndRun.executeNode 调 11 方法必抛 TypeError.
// 本文件提供完整 firebase Firestore 实装 (浏览器 firebase JS SDK).
//
// Collection: nodeRuns (engine path 审计, 跟 Phase 2A agentRunLogs 平行).
// Schema (跟 v8 skill_runner._write_node_run 协同, set merge=True 双写):
//   run_id (Firestore doc id) / workflow_id / instance_id / node_id / skill_id /
//   inputs / triggered_by / triggered_at / template_version / node_schema_snapshot /
//   upstream_runs / status (pending|running|success|failed|cancelled) /
//   outputs / outputs_summary / duration_sec / backup_path /
//   error_message / traceback / cancel_requested_at / finished_at
//
// 双写注意: engine.runStore.writePending 写 doc 时 v8 skill_runner.run_from_trigger
// 后续会 set(merge=True) 同 doc — 字段 contract 须一致 (per cross-lang-schema-consistency rule).
//
// 用法: import { createFirebaseRunStore } from './run-store/firebase-run-store.js';
//       const runStore = createFirebaseRunStore({ db: window.__fbDb });
//       const engine = new AgenticWorkflowEngine.Engine({ runStore });

export function createFirebaseRunStore(opts) {
  const db = opts?.db;
  if (!db) throw new Error('createFirebaseRunStore: opts.db (Firestore) 必填');

  const coll = db.collection('nodeRuns');

  // Firestore Timestamp 跟 SDK 平台不同, 用 db.app firestore namespace 拿 FieldValue
  function _serverTs() {
    // Web SDK v8: firebase.firestore.FieldValue.serverTimestamp()
    // Web SDK v9+ modular: serverTimestamp() — PCG 用 v8 (deploy/index.html line ~1590)
    const fbNs = db.app?.firebase_?.firestore || window.firebase?.firestore;
    return fbNs?.FieldValue?.serverTimestamp?.() || new Date();
  }

  function _genRunId() {
    // 生成 run_id (crypto.randomUUID 浏览器原生, 跟 engine 端一致)
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'rid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  async function writePending(args) {
    // engine 调时已校验 triggered_by 非空, 但 RunStore 实装应再检 (5 铁律 #1)
    if (!args.triggered_by) {
      throw new Error('writePending: triggered_by 必填 (5 铁律 #1 双重防御)');
    }
    const runId = _genRunId();
    const payload = {
      run_id: runId,
      workflow_id: args.workflow_id,
      instance_id: args.instance_id,
      node_id: args.node_id,
      skill_id: args.skill_id,
      inputs: args.inputs || {},
      triggered_by: args.triggered_by,
      triggered_at: _serverTs(),
      template_version: args.template_version || 'v1',
      node_schema_snapshot: args.node_schema_snapshot || {},
      upstream_runs: args.upstream_runs || [],
      status: 'pending',
    };
    await coll.doc(runId).set(payload);
    return runId;
  }

  async function writeRunning(runId) {
    await coll.doc(runId).set({ status: 'running' }, { merge: true });
  }

  async function writeSuccess(runId, args) {
    const payload = {
      status: 'success',
      outputs: args.outputs || {},
      outputs_summary: args.outputs_summary || {},
      duration_sec: args.duration_sec || 0,
      finished_at: _serverTs(),
    };
    if (args.backup_path !== undefined) payload.backup_path = args.backup_path;
    await coll.doc(runId).set(payload, { merge: true });
  }

  async function writeFailed(runId, args) {
    const payload = {
      status: 'failed',
      error_message: String(args.error_message || '').slice(0, 500),
      finished_at: _serverTs(),
    };
    if (args.traceback) payload.traceback = String(args.traceback).slice(0, 2000);
    await coll.doc(runId).set(payload, { merge: true });
  }

  async function writeCancelled(runId) {
    await coll.doc(runId).set({
      status: 'cancelled',
      finished_at: _serverTs(),
    }, { merge: true });
  }

  async function getRecord(runId) {
    const snap = await coll.doc(runId).get();
    if (!snap.exists) return null;
    return _normalize(snap.data(), snap.id);
  }

  async function queryLatestSuccess(args) {
    const snap = await coll
      .where('workflow_id', '==', args.workflow_id)
      .where('instance_id', '==', args.instance_id)
      .where('node_id', '==', args.node_id)
      .where('status', '==', 'success')
      .orderBy('finished_at', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return _normalize(d.data(), d.id);
  }

  async function queryRunning(args) {
    const snap = await coll
      .where('workflow_id', '==', args.workflow_id)
      .where('instance_id', '==', args.instance_id)
      .where('node_id', '==', args.node_id)
      .where('status', 'in', ['pending', 'running'])
      .limit(1)
      .get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return _normalize(d.data(), d.id);
  }

  async function requestCancel(runId) {
    await coll.doc(runId).set({
      cancel_requested_at: _serverTs(),
    }, { merge: true });
  }

  async function isCancelRequested(runId) {
    const snap = await coll.doc(runId).get();
    if (!snap.exists) return false;
    return !!snap.data().cancel_requested_at;
  }

  function _normalize(data, docId) {
    // Firestore Timestamp → ISO string (engine RunRecord schema 期望 string)
    // 跟 deploy/index.html nodeRuns LIVE 订阅 _subscribeNodeRuns 字段映射同模式
    const triggeredAt = data.triggered_at?.toDate?.()?.toISOString() || data.triggered_at || null;
    const finishedAt = data.finished_at?.toDate?.()?.toISOString() || data.finished_at || null;
    return {
      run_id: data.run_id || docId,
      workflow_id: data.workflow_id,
      instance_id: data.instance_id,
      node_id: data.node_id,
      skill_id: data.skill_id,
      inputs: data.inputs || {},
      triggered_by: data.triggered_by,
      triggered_at: triggeredAt,
      template_version: data.template_version,
      node_schema_snapshot: data.node_schema_snapshot || {},
      upstream_runs: data.upstream_runs || [],
      status: data.status || 'pending',
      outputs: data.outputs || {},
      outputs_summary: data.outputs_summary || {},
      duration_sec: data.duration_sec || null,
      backup_path: data.backup_path || null,
      error_message: data.error_message || null,
      traceback: data.traceback || null,
      cancel_requested_at: data.cancel_requested_at?.toDate?.()?.toISOString() || null,
      finished_at: finishedAt,
    };
  }

  return {
    writePending,
    writeRunning,
    writeSuccess,
    writeFailed,
    writeCancelled,
    getRecord,
    queryLatestSuccess,
    queryRunning,
    requestCancel,
    isCancelRequested,
  };
}
