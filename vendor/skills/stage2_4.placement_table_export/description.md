# stage2_4.placement_table_export

PCG 段 5 第 1 个真业务 skill — 把 PCG DataTable (`DT_PCG_Assets_{theme}`) 导出为 JSON 文件, 落地到 XDVerse Project_Data 的 `Configs/{theme}/Json/DT_PCG_Assets_{theme}.json`.

## 运行时

`python_daemon` — 看板触发 → `agentTriggerQueue` (含 `workflow_id` + `skill_id` engine schema) → v8 daemon `skill_runner.run_from_trigger` 拾 → 加载本 skill 跑.

## 业务来源

Phase 2A `executor.export_pcg_dt_to_json` 业务函数 — `run_export_pcg_dt_to_json(theme_short, dt_type)`, 段 5 重构为模块级共用。原“段 7 老资产迁移”计划已归档为备选, 当前不再默认整体搬迁老资产。

## 输入

- `theme_short` (theme_short): 子主题 abbreviation, 4 chars `A-Z0-9`, 例 `'YWMD'`. 通常来自 instance_data.
- `dt_type` (string): DT 类型, Phase 2A 仅 `'pcg_assets'`. Phase 2C 加 `'excluded'` / `'nav_ground'`.

## 输出

- `row_count` (int): 导出的 DT 行数. success_criteria: `> 0`.
- `json_path` (string): JSON 文件绝对路径.

## 行为

1. 加载 DT 资产 `/Game/ArtTest/PCG/DataTables/DT_PCG_Assets_{theme}` (UE asset).
2. 派生输出 JSON 目录 (XDVerse Project_Data `Configs/{theme}/Json/`), 不存在则创建.
3. 调底层 `datatable_filler.run_export_to_json(dt, output_path)` 把 DT 行序列化为 JSON.
4. success → 返 outputs_summary; failed → raise RuntimeError (skill_runner mark_failed).

## 错误处理

业务函数返 `{success: false, error_message: ...}` 4 种 case:
- theme_short 缺
- dt_type 不在 _DT_TYPE_CONFIG (Phase 2A 仅 pcg_assets)
- `unreal.load_asset(dt_path)` 返 None (DT 不存在)
- 资产存在但不是 DataTable 类型
- 底层 run_export_to_json 失败

main.py 把 `{success: false}` 转 RuntimeError 抛, skill_runner catch → nodeRuns status=failed + error_message.

## RBAC

`is_destructive: true` + `requires_confirm: true` → engine `createPcgAuthorizationCheck` 强制:
- viewer: 拒
- editor: 拒 (因 is_destructive=true)
- admin: 允许 (TA 默认 admin)

## Rollback ⚠ 重要警告

`rollback_strategy: 'file_backup'`.

**已知 gap (当前 PCG engine path)**: engine path skill_runner **不调** ExecutorBase `_do_file_backup` 钩子 (Phase 2A 老路径专属). schema metadata 标 `file_backup` 反映**意图**, 但 engine path 实际**不跑** backup.

**操作影响**: 如果继续通过 PCG 看板旧 engine path 触发此 skill, 会**真覆盖** `<XDVerse>/Configs/<theme>/Json/DT_PCG_Assets_<theme>.json`, **不可回滚**. 触发前必须 **TA 手动 backup**:

```bash
cp <XDVerse>/Configs/<theme>/Json/DT_PCG_Assets_<theme>.json{,.bak}
```

**后续处理策略** (当前非默认路线):
1. skill_runner 加 backup 钩子调度
2. 或业务函数 `run_export_pcg_dt_to_json` 加 `backup_dir` 参数, skill main.py 显式调
3. 或看板 UI 触发前先调一个 backup helper skill

## 跟 Phase 2A executor 对照

| 维度 | Phase 2A `executor.export_pcg_dt_to_json` | engine skill (本) |
|------|-------------------------------------------|-------------------|
| 触发路径 | `agentTriggerQueue` 无 `workflow_id` → `_process_legacy_trigger` → `executors[agent_id]._wrapped_run` | `agentTriggerQueue` 含 `workflow_id` → `skill_runner.run_from_trigger` → 本 skill |
| 审计 collection | `agentRunLogs` | `nodeRuns` |
| RBAC | scanner/executor 框架自己控 | engine `setAuthorizationCheck` 控 |
| file_backup | ExecutorBase 钩子自动跑 | **当前不跑** (旧 engine path 不具备自动备份; 当前非默认路线) |
| 业务函数 | `run_export_pcg_dt_to_json` (同一函数) | 同左 |

## 测试

- 单元: `tests/skills/test_stage2_4_placement_table_export.py` (pytest mock unreal + mock v8 业务函数)
- 端到端: `scripts/dev_runner/seg_5_e2e.js` (firebase-admin 写 agentTriggerQueue + poll nodeRuns + Phase 2A 回归 + cleanup)
