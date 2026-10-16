# -*- coding: utf-8 -*-
"""stage2_4.placement_table_export — engine skill (PCG 段 5, 第 1 个真业务 skill)

runtime: python_daemon (UE Python daemon 内跑)
业务: PCG DataTable (DT_PCG_Assets_{theme}) → JSON 文件导出到
XDVerse Project_Data/.../Configs/{theme}/Json/.

策略 A (跟段 7 老资产迁移对齐): 复用 v8_framework Phase 2A 业务函数
v8_framework.core.agent_runtime.executors.export_pcg_dt_to_json.run_export_pcg_dt_to_json,
不复制业务逻辑. 段 7 老资产迁移时 v8 executor 整体废, 业务函数搬到本仓 skills/.

skill_runner 调用契约:
    run(inputs, ctx) -> dict
    inputs: {theme_short: str, dt_type: 'pcg_assets'}
    ctx: {queue_id, workflow_id, instance_id, node_id, run_id, triggered_by}
    返:
        {
            'outputs_summary': {'row_count': int, 'json_path': str},
            'outputs_local_path': str,
            'affected_paths': [...],
        }
    失败时 raise RuntimeError, engine skill_runner catch → nodeRuns status=failed.
"""

import sys

# v8_framework sys.path: 优先 try import (UE init_unreal.py 通常已加), 缺再 fallback 硬路径
try:
    from v8_framework.core.agent_runtime.executors.export_pcg_dt_to_json import (
        run_export_pcg_dt_to_json,
    )
except ImportError:
    _V8_PATH = r"E:\P4_WorkSpace\TorchLight_MainLineWithUGS\frontend\trunk\Editor\UE_game\Plugins\ImportTool\PythonFile"
    if _V8_PATH not in sys.path:
        sys.path.insert(0, _V8_PATH)
    from v8_framework.core.agent_runtime.executors.export_pcg_dt_to_json import (
        run_export_pcg_dt_to_json,
    )


def run(inputs, ctx):
    # 严格 [] 不用 .get() default — KeyError 暴露 caller bug (per coding/code-integrity §5).
    # schema.json `required: true` 是 advisory, 段 6 ManualNodeForm 应注入 source.default.
    theme_short = inputs["theme_short"]
    dt_type = inputs["dt_type"]

    result = run_export_pcg_dt_to_json(theme_short, dt_type)

    if not result["success"]:
        raise RuntimeError(result["error_message"])

    # 业务规则跟 Phase 2A executor.run() evaluations 对齐: row_count > 0 才算 success.
    # 空 DT 在 Phase 2A 走 evaluations.value=false → workItemStatus red. engine path
    # 这里 raise → nodeRuns failed, 让段 6 看板 + audit 一致.
    if result["row_count"] <= 0:
        raise RuntimeError(
            "success_criteria failed: row_count={} (期望 > 0, DT 可能为空表)".format(
                result["row_count"]
            )
        )

    return {
        "outputs_summary": {
            "row_count": result["row_count"],
            "json_path": result["json_path"],
            "success_criteria_value": True,  # row_count > 0 已校验 (P0-1 review fix)
        },
        "outputs_local_path": result["json_path"],
        "affected_paths": result["affected_paths"],
    }
