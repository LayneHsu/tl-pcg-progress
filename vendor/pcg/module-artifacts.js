const SCHEMA = 'pcg-module-artifacts';
const SCHEMA_VERSION = 1;
const MAX_STYLE_VARIANTS = 4;

export const BASE_ARTIFACTS = Object.freeze([
  Object.freeze({ key: 'template_map', label: '模版 Map', kind: 'map', group: 'base' }),
  Object.freeze({ key: 'boxed_map', label: '彩盒 Map', kind: 'map', group: 'base' }),
  Object.freeze({ key: 'boxed_bp', label: '彩盒 BP', kind: 'bp', group: 'base' }),
  Object.freeze({ key: 'production_map', label: '正式资产 Map', kind: 'map', group: 'base' }),
  Object.freeze({ key: 'production_bp', label: '正式资产 BP', kind: 'bp', group: 'base' }),
]);

const BASE_KEYS = new Set(BASE_ARTIFACTS.map(item => item.key));
const STATUS_VALUES = new Set(['planned', 'present', 'missing', 'skipped', 'not_applicable', 'stale', 'error']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} 不能为空`);
  return text;
}

function normalizeStatus(value, fallback = 'planned') {
  const status = String(value ?? fallback).trim() || fallback;
  if (!STATUS_VALUES.has(status)) throw new Error(`不支持的产物状态: ${status}`);
  return status;
}

function normalizeArtifactEntry(raw, definition, context) {
  const value = isPlainObject(raw) ? raw : {};
  const required = value.required === undefined ? definition.group === 'base' : Boolean(value.required);
  return {
    artifact_key: definition.key,
    artifact_kind: definition.kind,
    artifact_group: definition.group,
    variant_id: value.variant_id ?? null,
    label: value.label ? String(value.label) : definition.label,
    required,
    status: normalizeStatus(value.status, required ? 'planned' : 'not_applicable'),
    source: value.source ? String(value.source) : 'manual',
    work_item_id: value.work_item_id ? String(value.work_item_id) : null,
    work_item_path: Array.isArray(value.work_item_path) ? value.work_item_path.map(String) : null,
    scanner_key: value.scanner_key ? String(value.scanner_key) : null,
    note: value.note ? String(value.note) : '',
    ...Object.fromEntries(Object.entries(value).filter(([key]) => ![
      'artifact_key', 'artifact_kind', 'artifact_group', 'variant_id', 'label', 'required',
      'status', 'source', 'work_item_id', 'work_item_path', 'scanner_key', 'note',
    ].includes(key))),
  };
}

function normalizeVariant(raw, index, moduleKey) {
  const value = isPlainObject(raw) ? raw : {};
  const variantId = requireText(value.variant_id || `style_${String(index + 1).padStart(2, '0')}`, `modules.${moduleKey}.variants[${index}].variant_id`);
  const artifacts = isPlainObject(value.artifacts) ? value.artifacts : {};
  const map = normalizeArtifactEntry(artifacts.map, { key: 'map', label: 'Map', kind: 'map', group: 'style_variant' }, `modules.${moduleKey}.variants[${index}].artifacts.map`);
  const bp = normalizeArtifactEntry(artifacts.bp, { key: 'bp', label: 'BP', kind: 'bp', group: 'style_variant' }, `modules.${moduleKey}.variants[${index}].artifacts.bp`);
  map.required = artifacts.map?.required === undefined ? true : Boolean(artifacts.map.required);
  bp.required = artifacts.bp?.required === undefined ? true : Boolean(artifacts.bp.required);
  if (!artifacts.map?.status) map.status = 'planned';
  if (!artifacts.bp?.status) bp.status = 'planned';
  map.variant_id = variantId;
  bp.variant_id = variantId;
  return {
    variant_id: variantId,
    label: value.label ? String(value.label) : `风格 ${index + 1}`,
    artifacts: { map, bp },
  };
}

function moduleEntries(rawModules) {
  if (Array.isArray(rawModules)) return rawModules;
  if (isPlainObject(rawModules)) {
    return Object.entries(rawModules).map(([moduleKey, value]) => ({ module_key: moduleKey, ...(isPlainObject(value) ? value : {}) }));
  }
  return [];
}

export function normalizeModuleArtifactPlan(document) {
  if (!isPlainObject(document)) throw new Error('模块产物计划必须是对象');
  if (document.schema !== SCHEMA) throw new Error(`模块产物计划 schema 必须是 ${SCHEMA}`);
  if (Number(document.schema_version) !== SCHEMA_VERSION) throw new Error(`模块产物计划 schema_version 必须是 ${SCHEMA_VERSION}`);
  const themeId = requireText(document.theme_id, 'theme_id');
  const modules = moduleEntries(document.modules);
  const seen = new Set();
  const normalizedModules = modules.map((raw, index) => {
    const moduleKey = requireText(raw?.module_key, `modules[${index}].module_key`);
    if (seen.has(moduleKey)) throw new Error(`模块重复: ${moduleKey}`);
    seen.add(moduleKey);
    const base = isPlainObject(raw.base) ? raw.base : (isPlainObject(raw.artifacts) ? raw.artifacts : {});
    const artifacts = {};
    BASE_ARTIFACTS.forEach(definition => {
      artifacts[definition.key] = normalizeArtifactEntry(base[definition.key], definition, `modules.${moduleKey}.${definition.key}`);
    });
    const variants = Array.isArray(raw.variants) ? raw.variants : [];
    if (variants.length > MAX_STYLE_VARIANTS) throw new Error(`模块 ${moduleKey} 的风格变体不能超过 ${MAX_STYLE_VARIANTS} 组`);
    const variantIds = new Set();
    const normalizedVariants = variants.map((variant, variantIndex) => {
      const normalized = normalizeVariant(variant, variantIndex, moduleKey);
      if (variantIds.has(normalized.variant_id)) throw new Error(`模块 ${moduleKey} 的风格变体重复: ${normalized.variant_id}`);
      variantIds.add(normalized.variant_id);
      return normalized;
    });
    return {
      module_key: moduleKey,
      label: raw.label ? String(raw.label) : moduleKey,
      artifacts,
      variants: normalizedVariants,
      source: raw.source ? String(raw.source) : 'manual',
      confirmed: raw.confirmed === true,
      note: raw.note ? String(raw.note) : '',
    };
  });
  return {
    schema: SCHEMA,
    schema_version: SCHEMA_VERSION,
    theme_id: themeId,
    modules: normalizedModules,
  };
}

function observedStatus(value, fallback = 'missing') {
  if (isPlainObject(value)) return normalizeStatus(value.status, fallback);
  if (typeof value === 'string') return normalizeStatus(value, fallback);
  if (typeof value === 'boolean') return value ? 'present' : 'missing';
  return fallback;
}

function observedEntry(value, definition, variantId = null) {
  const raw = isPlainObject(value) ? value : {};
  return {
    artifact_key: definition.key,
    artifact_kind: definition.kind,
    artifact_group: definition.group,
    variant_id: variantId,
    status: observedStatus(raw, 'missing'),
    source: raw.source ? String(raw.source) : 'scanner',
    scanner_key: raw.scanner_key ? String(raw.scanner_key) : null,
    note: raw.note ? String(raw.note) : '',
  };
}

function statusIsCounted(entry) {
  return entry.required && entry.status !== 'not_applicable';
}

export function summarizeModuleArtifactStatuses(artifacts) {
  const summary = {
    required: 0,
    present: 0,
    missing: 0,
    pending: 0,
    skipped: 0,
    stale: 0,
    error: 0,
    by_group: {
      base: { required: 0, present: 0, missing: 0 },
      style_variant: { required: 0, present: 0, missing: 0 },
    },
  };
  (artifacts || []).forEach(entry => {
    if (!statusIsCounted(entry)) return;
    summary.required += 1;
    const group = summary.by_group[entry.artifact_group] || (summary.by_group[entry.artifact_group] = { required: 0, present: 0, missing: 0 });
    group.required += 1;
    if (entry.status === 'present') {
      summary.present += 1;
      group.present += 1;
    } else if (entry.status === 'missing') {
      summary.missing += 1;
      group.missing += 1;
    } else if (entry.status === 'planned') {
      summary.pending += 1;
    } else if (entry.status === 'skipped') {
      summary.skipped += 1;
    } else if (entry.status === 'stale') {
      summary.stale += 1;
    } else if (entry.status === 'error') {
      summary.error += 1;
    }
  });
  summary.completion_pct = summary.required ? Math.round(summary.present * 1000 / summary.required) / 10 : null;
  summary.base_completion_pct = summary.by_group.base.required
    ? Math.round(summary.by_group.base.present * 1000 / summary.by_group.base.required) / 10
    : null;
  summary.variant_completion_pct = summary.by_group.style_variant.required
    ? Math.round(summary.by_group.style_variant.present * 1000 / summary.by_group.style_variant.required) / 10
    : null;
  return summary;
}

export function resolveModuleArtifactStatuses(planInput, observed = {}) {
  const plan = normalizeModuleArtifactPlan(planInput);
  const observedModules = isPlainObject(observed.modules) ? observed.modules : observed;
  const modules = plan.modules.map(module => {
    const observedModule = isPlainObject(observedModules?.[module.module_key]) ? observedModules[module.module_key] : {};
    const artifacts = BASE_ARTIFACTS.map(definition => {
      const planned = module.artifacts[definition.key];
      const actual = observedModule.artifacts?.[definition.key] ?? observedModule[definition.key];
      return { ...planned, status: observedStatus(actual, planned.status === 'planned' ? 'missing' : planned.status), source: isPlainObject(actual) && actual.source ? String(actual.source) : planned.source };
    });
    const variants = module.variants.map(variant => ({
      ...variant,
      artifacts: {
        map: { ...variant.artifacts.map, status: observedStatus(observedModule.variants?.[variant.variant_id]?.map, variant.artifacts.map.status === 'planned' ? 'missing' : variant.artifacts.map.status) },
        bp: { ...variant.artifacts.bp, status: observedStatus(observedModule.variants?.[variant.variant_id]?.bp, variant.artifacts.bp.status === 'planned' ? 'missing' : variant.artifacts.bp.status) },
      },
    }));
    const allArtifacts = artifacts.concat(variants.flatMap(variant => Object.values(variant.artifacts)));
    return {
      ...module,
      artifacts,
      variants,
      summary: summarizeModuleArtifactStatuses(allArtifacts),
    };
  });
  const allArtifacts = modules.flatMap(module => module.artifacts.concat(module.variants.flatMap(variant => Object.values(variant.artifacts))));
  return {
    schema: SCHEMA,
    schema_version: SCHEMA_VERSION,
    theme_id: plan.theme_id,
    modules,
    summary: summarizeModuleArtifactStatuses(allArtifacts),
  };
}

function walkNodes(nodes, path = [], output = []) {
  (nodes || []).forEach(node => {
    const nextPath = path.concat(String(node.name ?? ''));
    if (Array.isArray(node.children) && node.children.length) walkNodes(node.children, nextPath, output);
    else output.push({ id: node.id ? String(node.id) : null, name: String(node.name ?? ''), status: node.status || 'grey', path: nextPath });
  });
  return output;
}

function findSubTheme(store, abbreviation) {
  for (const parent of store?.parentThemes || []) {
    for (const subTheme of parent.subThemes || []) {
      if (String(subTheme.abbreviation || '').trim() === abbreviation) return subTheme;
    }
  }
  return null;
}

function collectNamedGroups(subTheme) {
  const groups = new Map();
  const visit = nodes => {
    (nodes || []).forEach(node => {
      const name = String(node.name || '');
      if (
        name === '目标尺寸模板空关卡'
        || name === '彩盒模块关卡'
        || name === '每模块临时BP'
        || name === '每模块碰撞Maps'
        || /^每模块美术资产(关卡|BP)\s*\(([^)]+)\)\s*$/.test(name)
      ) {
        groups.set(name, { name, leaves: walkNodes(node.children || [], ['资产准备', name]) });
      }
      visit(node.children);
    });
  };
  visit(subTheme?.nodes);
  return groups;
}

function candidateEntry(group, moduleKey, confidence = 'candidate') {
  const leaf = group?.leaves?.find(item => item.name === moduleKey) || null;
  return {
    status: leaf ? (leaf.status === 'green' ? 'present' : leaf.status === 'blue' ? 'skipped' : 'missing') : 'missing',
    source: 'legacy_work_item',
    work_item_id: leaf?.id || null,
    work_item_path: leaf?.path || null,
    legacy_group: group?.name || null,
    confidence,
    confirmed: false,
  };
}

export function buildLegacyModuleArtifactMapping(store, abbreviation = 'SCJGB') {
  const subTheme = findSubTheme(store, abbreviation);
  if (!subTheme) throw new Error(`找不到子主题: ${abbreviation}`);
  const groups = collectNamedGroups(subTheme);
  const fixedGroups = {
    template_map: groups.get('目标尺寸模板空关卡'),
    boxed_map: groups.get('彩盒模块关卡'),
    boxed_bp: groups.get('每模块临时BP'),
  };
  const variantGroups = [...groups.values()]
    .map(group => {
      const match = /^每模块美术资产(关卡|BP)\s*\(([^)]+)\)\s*$/.exec(group.name);
      return match ? { group, kind: match[1] === '关卡' ? 'map' : 'bp', label: match[2] } : null;
    })
    .filter(Boolean);
  const moduleKeys = new Set();
  Object.values(fixedGroups).forEach(group => group?.leaves?.forEach(item => moduleKeys.add(item.name)));
  variantGroups.forEach(item => item.group.leaves.forEach(leaf => moduleKeys.add(leaf.name)));
  const variantLabels = [...new Set(variantGroups.map(item => item.label))];
  const modules = [...moduleKeys].sort((left, right) => left.localeCompare(right, 'en', { numeric: true })).map(moduleKey => {
    const variants = variantLabels.map((label, index) => {
      const mapGroup = variantGroups.find(item => item.label === label && item.kind === 'map')?.group;
      const bpGroup = variantGroups.find(item => item.label === label && item.kind === 'bp')?.group;
      return {
        variant_id: `style_${String(index + 1).padStart(2, '0')}`,
        label,
        artifacts: {
          map: candidateEntry(mapGroup, moduleKey),
          bp: candidateEntry(bpGroup, moduleKey),
        },
      };
    });
    const base = {};
    Object.entries(fixedGroups).forEach(([key, group]) => { base[key] = candidateEntry(group, moduleKey); });
    return {
      module_key: moduleKey,
      label: moduleKey,
      base,
      variants,
      collision_map: candidateEntry(groups.get('每模块碰撞Maps'), moduleKey),
    };
  });
  return {
    schema: SCHEMA,
    schema_version: SCHEMA_VERSION,
    theme_id: abbreviation,
    source: 'legacy_work_item_candidate_mapping',
    confirmed: false,
    assumptions: [
      '目标尺寸模板空关卡可能对应模版 Map',
      '彩盒模块关卡可能对应彩盒 Map',
      '每模块临时BP可能对应彩盒 BP',
      '藏品区、图书区、军备区、标本区可能对应四组风格变体',
      '每模块碰撞Maps保留为独立技术产物，不并入正式资产 Map',
    ],
    groups: [...groups.keys()],
    variant_labels: variantLabels,
    modules,
  };
}

export function summarizeLegacyMapping(mapping) {
  const modules = mapping?.modules || [];
  const countLeaves = key => modules.reduce((total, module) => total + (module.base?.[key]?.work_item_id ? 1 : 0), 0);
  const variantCount = modules.reduce((total, module) => total + (module.variants || []).length, 0);
  return {
    theme_id: mapping?.theme_id || null,
    module_count: modules.length,
    fixed_candidate_counts: Object.fromEntries(BASE_ARTIFACTS.map(definition => [definition.key, countLeaves(definition.key)])),
    variant_group_count: mapping?.variant_labels?.length || 0,
    variant_slot_count: variantCount * 2,
    collision_candidate_count: modules.filter(module => module.collision_map?.work_item_id).length,
    confirmed: mapping?.confirmed === true,
  };
}

export function buildLegacyModuleArtifactPlan(mapping) {
  if (!isPlainObject(mapping) || mapping.schema !== SCHEMA) throw new Error('旧工作项映射报告 schema 不正确');
  const modules = (mapping.modules || []).map(module => ({
    module_key: requireText(module.module_key, 'module_key'),
    label: module.label || module.module_key,
    source: 'legacy_work_item_confirmed_mapping',
    confirmed: true,
    note: '固定产物与风格变体语义已由业务确认；正式资产来源仍需 Scanner 或后续资产合同补齐。',
    base: {
      template_map: { ...(module.base?.template_map || {}), required: true, source: 'legacy_work_item', confirmed: true },
      boxed_map: { ...(module.base?.boxed_map || {}), required: true, source: 'legacy_work_item', confirmed: true },
      boxed_bp: { ...(module.base?.boxed_bp || {}), required: true, source: 'legacy_work_item', confirmed: true },
      production_map: {
        required: true,
        status: 'planned',
        source: 'manual',
        confirmed: false,
        note: '旧工作项未提供独立正式资产 Map 来源，等待 Scanner/资产合同绑定。',
      },
      production_bp: {
        required: true,
        status: 'planned',
        source: 'manual',
        confirmed: false,
        note: '旧工作项未提供独立正式资产 BP 来源，等待 Scanner/资产合同绑定。',
      },
    },
    variants: (module.variants || []).map(variant => ({
      variant_id: variant.variant_id,
      label: variant.label,
      artifacts: {
        map: { ...(variant.artifacts?.map || {}), required: true, source: 'legacy_work_item', confirmed: true },
        bp: { ...(variant.artifacts?.bp || {}), required: true, source: 'legacy_work_item', confirmed: true },
      },
    })),
    collision_map: module.collision_map || null,
  }));
  return {
    schema: SCHEMA,
    schema_version: SCHEMA_VERSION,
    theme_id: requireText(mapping.theme_id, 'theme_id'),
    confirmed: true,
    mapping_state: 'confirmed_partial',
    modules,
    notes: [
      '模版 Map、彩盒 Map、彩盒 BP 的旧工作项映射已确认。',
      '四个区域分别作为四组风格变体，且每组包含 Map 与 BP。',
      '“关卡”统一按 Map 处理。',
      '正式资产 Map/BP 保留为必需产物，但旧工作项没有独立来源时显示为待绑定/待扫描。',
      '碰撞 Maps 作为独立技术产物保留，不并入正式资产 Map。',
    ],
  };
}

export { SCHEMA as MODULE_ARTIFACT_SCHEMA, SCHEMA_VERSION as MODULE_ARTIFACT_SCHEMA_VERSION, MAX_STYLE_VARIANTS };
