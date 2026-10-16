// templates-converter: PCG data/templates.json → engine Workflow + Node[]
//
// 输入: PCG 看板 templates.json (nested tree, leaf 有 work_item_id +
// automation_pattern + 段 4 加 skill_id/inputs/outputs)
// 输出: engine workflow.schema.json + node.schema.json 数组
//
// 跟 PCG 段 4 plan §Task 4.1 对齐. 由 workflow.config.js 调.

/**
 * automation_pattern → engine node.kind 映射
 * - 'human'  → 'manual'    (engine ManualNodeForm 渲染表单填写)
 * - 'agent'  → 'automated' (engine 调 runtime.run_skill)
 * - 'mixed'  → 'automated' (段 8 起拆分 manual 子任务, 当前归 automated)
 */
function automationPatternToKind(pattern) {
  return pattern === 'human' ? 'manual' : 'automated';
}

/**
 * 递归走一棵 templates.json node tree, 收集所有 leaf (含 work_item_id 的节点).
 * @param {object} node — templates.json node
 * @param {Array} acc — 累积 leaf 数组
 */
function collectLeaves(node, acc) {
  if (node && typeof node === 'object' && 'work_item_id' in node) {
    acc.push(node);
  }
  for (const child of (node && node.children) || []) {
    collectLeaves(child, acc);
  }
}

/**
 * 把 1 个 templates.json leaf 转 engine Node.
 * 段 4 leaf 字段默认: skill_id = work_item_id, inputs/outputs = []
 * (段 5/8 起 leaf 真填后 override).
 */
function leafToNode(leaf) {
  return {
    id: leaf.work_item_id,
    name: leaf.name || leaf.work_item_id,
    kind: automationPatternToKind(leaf.automation_pattern),
    skill_id: leaf.skill_id || leaf.work_item_id,
    inputs: Array.isArray(leaf.inputs) ? leaf.inputs : [],
    outputs: Array.isArray(leaf.outputs) ? leaf.outputs : [],
    metadata: {
      automation_pattern: leaf.automation_pattern,
    },
  };
}

/**
 * 推导 workflow 名: 用第一棵 nodes 树的 root.name (或 fallback workflow id).
 */
function inferWorkflowName(workflowEntry) {
  const firstRoot = (workflowEntry.nodes || [])[0];
  if (firstRoot && firstRoot.name) return firstRoot.name;
  return workflowEntry.id;
}

/**
 * 主函数: 把 PCG templates.json (`{list: [{id, nodes: [...]}]}`) 转
 * engine workflow 数组.
 *
 * @param {object} templatesJson — data/templates.json 内容
 * @returns {Array<{id, name, nodes, tree_structure}>}
 */
export function templatesToWorkflows(templatesJson) {
  if (!templatesJson || !Array.isArray(templatesJson.list)) {
    throw new Error('templatesToWorkflows 需 {list: [...]} 结构');
  }
  return templatesJson.list.map((entry) => {
    const leaves = [];
    for (const root of entry.nodes || []) {
      collectLeaves(root, leaves);
    }
    // 检测 duplicate work_item_id (跨 entry 也算重复, engine node id 全局唯一)
    const seen = new Set();
    const dups = [];
    for (const leaf of leaves) {
      if (seen.has(leaf.work_item_id)) dups.push(leaf.work_item_id);
      seen.add(leaf.work_item_id);
    }
    if (dups.length) {
      throw new Error(
        `templatesToWorkflows: workflow ${entry.id} 含 duplicate work_item_id: ${dups.join(', ')}`,
      );
    }
    return {
      id: entry.id,
      name: inferWorkflowName(entry),
      nodes: leaves.map(leafToNode),
      // tree_structure 保留原嵌套结构, engine NodeEditor 显示用
      tree_structure: { nodes: entry.nodes },
    };
  });
}

// 测试用 export (内部 helpers)
export const _internal = {
  collectLeaves,
  leafToNode,
  automationPatternToKind,
};
