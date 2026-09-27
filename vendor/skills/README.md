# PCG skills/

PCG 业务侧 engine skill 目录。每个 skill 一个子目录:

```
skills/
├── README.md                              (本文)
├── _mock.echo_python_daemon/              runtime=python_daemon (v8 skill_runner 加载 main.py)
│   ├── schema.json
│   └── main.py
├── _mock.echo_hython/                     runtime=hython_subprocess (Utils H21 bridge 加载)
│   ├── schema.json
│   └── main.py
├── _mock.echo_node_local/                 runtime=node_local (PCG Node CLI dynamic import main.mjs)
│   ├── schema.json
│   └── main.mjs
└── (真业务 skill 段 5+ 起逐个迁入)
```

**skill_id ↔ 目录名**: 一对一. skill_id 内的句号是目录名 literal (跟 Phase 2A `executor.export_pcg_dt_to_json` 同模式), 不当文件系统分隔符. 即 `_mock.echo_node_local` → `skills/_mock.echo_node_local/`.

## schema.json 字段

跟 `agentic-workflow-engine/schema/skill.schema.json` (v0.4.0-secure) 对齐:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | 全局唯一, 跟目录名一致 (例 `stage2_4.placement_table_export`) |
| `kind` | `'automated'` \| `'manual'` | ✓ | manual 跳过 runtime 调度, 走表单填写 |
| `runtime` | string | automated 必填 | engine 注册的 ExecutionRuntime id (PCG 段 3 提供 `python_daemon` / `hython_subprocess` / `node_local`) |
| `inputs_schema` | array of `{name, type, ...}` | optional | engine NodeEditor 渲染表单 |
| `outputs_schema` | array of `{name, type, ...}` | optional | engine 解析 outputs_summary 字段 |
| `metadata.is_destructive` | bool | optional | true 时 engine confirmAndRun 要求 RBAC ≥ admin |
| `metadata.requires_confirm` | bool | optional | 触发前需 UI 显式确认 |
| `metadata.rollback_strategy` | enum | optional | `none` / `file_backup` / `asset_backup` / `git_revert` |
| `metadata.estimated_duration_sec` | int | optional | UI 进度估算 |

## main.{py,mjs} 接口

### Python (runtime=python_daemon | hython_subprocess)
```python
def run(inputs: dict, ctx: dict) -> dict:
    """
    inputs: schema.json inputs_schema 渲染表单填写的值
    ctx: {queue_id, workflow_id, instance_id, node_id, run_id, triggered_by}
    返:
        {
            'outputs_summary': dict,        # 必填, 写 nodeRuns.outputs_summary
            'outputs_local_path': str,      # 可选, 大输出落盘路径
            'work_items': list[str],        # 可选, 用 status_writer 写老看板 (兼容 Phase 2A)
            'affected_paths': list[str],    # 可选, audit
            'backup_path': str,             # 可选, rollback 用
        }
    抛异常: skill_runner 包装为 status=failed + traceback
    """
```

### Node (runtime=node_local)
```js
export async function run(inputs, ctx) {
  return {
    outputs_summary: {...},
    // ... 同 Python 字段
  };
}
```

## runtime 路由 (段 3 实现)

| `schema.runtime` | 加载方 | 入口 |
|------------------|--------|------|
| `python_daemon` | v8_framework `skill_runner.py` | `importlib` 加载 `skills/{id}/main.py` |
| `hython_subprocess` | PCG Node `pcg/execution-runtimes/hython-subprocess.js` → 显式 H21 package CLI → Utils `houdini_bridge/h21/pcg_subprocess/bridge.py` | hython 内 importlib 加载 |
| `node_local` | PCG Node `pcg/execution-runtimes/node-local.js` | `import()` 加载 `skills/{id}/main.mjs` |

## skill_id 命名规范

- snake_case + 句号 literal (例 `stage2_4.placement_table_export`, `_mock.echo_python_daemon`)
- 句号**不**当目录分隔符, 是目录名 literal 一部分 (`skills/stage2_4.placement_table_export/`)
- 跟 templates.json leaf `skill_id` 字段对齐 (段 4 起)
- 跟 Phase 2A `agent_registry.json` agent_id 同模式 (`executor.export_pcg_dt_to_json`)

## 不做的

- skill_id 字段未来加 `version` (`@1.0.0`) — 暂走 git history
- 跨 skill 调用 — engine 用 inputs source `from_upstream_node` 链接, skill 内不互调
