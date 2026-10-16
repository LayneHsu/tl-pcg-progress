// mock skill: echo input message (runtime=node_local)
//
// 由 PCG pcg/execution-runtimes/node-local.js dynamic import 加载.
// Node 环境, 浏览器跑不动.

export async function run(inputs, ctx) {
  const message = inputs?.message ?? '<empty>';
  return {
    outputs_summary: {
      echoed: '[node_local] ' + String(message),
      ctx_run_id: ctx?.run_id ?? '',
    },
  };
}
