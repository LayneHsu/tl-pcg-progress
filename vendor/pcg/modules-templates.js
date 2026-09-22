// PCG_Modules_Templates.json 的浏览器侧最小数据合同。
// 目标树是唯一期望来源；扫描状态和主题工作项模板不进入这里。
const MODULES_SCHEMA = 'pcg-modules-templates';
const CONFIG_BUNDLE_SCHEMA = 'pcg-modules-config-bundle';
const CONFIG_ROOT_SOURCES = new Set(['houdini_package', 'current_workspace']);
const DOCUMENT_FIELDS = new Set(['schema', 'schema_version', 'modules']);
const CONFIG_BUNDLE_FIELDS = new Set([
  'schema', 'schema_version', 'root_source', 'sync_revision', 'updated_at', 'updated_by',
  'theme_config', 'module_templates', 'theme_config_sha256', 'module_templates_sha256',
]);
const MODULE_GOAL_DRAFT_SCHEMA = 'pcg-module-goal-draft';
const MODULE_GOAL_DRAFT_FIELDS = new Set([
  'schema', 'schema_version', 'root_source', 'draft_revision', 'updated_at', 'updated_by',
  'module_templates', 'module_templates_sha256',
]);
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const MODULAR_SPEC_RE = /^modular_m([0-9]+)_u([0-9]+)_r([0-9]+)$/;
const MIXED_SPEC_RE = /^mixed_u([0-9]+)$/;
const SIZE_RE = /^([1-9][0-9]*)x([1-9][0-9]*)$/;
const SAFE_NAME_SEGMENT_RE = /^[A-Za-z0-9]+$/;
const MODULE_TYPES = new Set(['Start', 'End', 'Area', 'Outer']);
const AREA_LEVELS = new Set(['Base', 'Small', 'Middle', 'Large', 'Huge']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createCloudSnapshotSequence() {
  let value = 0;
  return {
    begin() { value += 1; return value; },
    current() { return value; },
    isCurrent(candidate) { return candidate === value; },
  };
}

function assertNoDuplicateJsonKeys(text) {
  let index = 0;
  const whitespace = /\s/;
  function skipWhitespace() { while (whitespace.test(text[index] || '')) index += 1; }
  function readString() {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index] === '"') { index += 1; return JSON.parse(text.slice(start, index)); }
      index += 1;
    }
    throw new Error('JSON 字符串未结束');
  }
  function readValue() {
    skipWhitespace();
    if (text[index] === '{') return readObject();
    if (text[index] === '[') return readArray();
    if (text[index] === '"') { readString(); return; }
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index += 1;
  }
  function readObject() {
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (text[index] === '}') { index += 1; return; }
    while (index < text.length) {
      skipWhitespace();
      if (text[index] !== '"') throw new Error('JSON 对象键必须是字符串');
      const key = readString();
      if (keys.has(key)) throw new Error(`JSON 包含重复键: ${key}`);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') throw new Error('JSON 对象键后缺少冒号');
      index += 1;
      readValue();
      skipWhitespace();
      if (text[index] === '}') { index += 1; return; }
      if (text[index] !== ',') throw new Error('JSON 对象项之间缺少逗号');
      index += 1;
    }
  }
  function readArray() {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') { index += 1; return; }
    while (index < text.length) {
      readValue();
      skipWhitespace();
      if (text[index] === ']') { index += 1; return; }
      if (text[index] !== ',') throw new Error('JSON 数组项之间缺少逗号');
      index += 1;
    }
  }
  readValue();
  skipWhitespace();
  if (index !== text.length) throw new Error('JSON 末尾包含多余内容');
}

function canonicalText(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(
    key => `${JSON.stringify(key)}:${canonicalText(value[key])}`
  ).join(',')}}`;
}

export function canonicalJsonText(value) {
  return canonicalText(value);
}

function assertName(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串`);
  }
}

function parseSpec(spec) {
  let match = MODULAR_SPEC_RE.exec(spec);
  if (match) {
    if (match.slice(1).some(value => Number(value) <= 0)) throw new Error(`规格数值必须大于 0: ${spec}`);
    if (spec !== `modular_m${Number(match[1])}_u${Number(match[2])}_r${Number(match[3])}`) throw new Error(`规格名称必须使用规范十进制: ${spec}`);
    return 'modular';
  }
  match = MIXED_SPEC_RE.exec(spec);
  if (match) {
    if (Number(match[1]) <= 0) throw new Error(`规格数值必须大于 0: ${spec}`);
    if (spec !== `mixed_u${Number(match[1])}`) throw new Error(`规格名称必须使用规范十进制: ${spec}`);
    return 'mixed';
  }
  throw new Error(`模板规格名称无效: ${spec}`);
}

function positiveIntegerField(value, label) {
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${label}必须是正整数`);
  }
  return Number(text);
}

export function buildModuleSpecId(fields) {
  if (!isPlainObject(fields)) throw new Error('规格参数必须是对象');
  const unitSize = positiveIntegerField(fields.unitSize, '单位尺寸');
  if (fields.specKind === 'mixed') return `mixed_u${unitSize}`;
  if (fields.specKind !== 'modular') throw new Error('规格类型必须是模块式或混合式');
  const tileSize = positiveIntegerField(fields.tileSize, '地块尺寸');
  const roadWidth = positiveIntegerField(fields.roadWidth, '开口宽度');
  return `modular_m${tileSize}_u${unitSize}_r${roadWidth}`;
}

export function getModuleSpecFields(spec) {
  const specKind = parseSpec(spec);
  if (specKind === 'mixed') {
    const match = MIXED_SPEC_RE.exec(spec);
    return { specKind, unitSize: Number(match[1]) };
  }
  const match = MODULAR_SPEC_RE.exec(spec);
  return {
    specKind,
    tileSize: Number(match[1]),
    unitSize: Number(match[2]),
    roadWidth: Number(match[3]),
  };
}

function parseSize(value, path) {
  if (typeof value !== 'string') throw new Error(`模板尺寸格式无效: ${path}/${String(value)}`);
  const match = SIZE_RE.exec(value);
  if (!match) throw new Error(`模板尺寸格式无效: ${path}/${value}`);
  return [Number(match[1]), Number(match[2])];
}

function validateLeaf(value, path, specKind) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} 必须是非空数组`);
  const seen = new Set();
  value.forEach((item, index) => {
    let identity;
    if (specKind === 'modular' && Number.isSafeInteger(item) && item > 0) {
      identity = `number:${item}`;
    } else if (specKind === 'mixed' && typeof item === 'string' && /^[0-9]{2}$/.test(item) && Number(item) > 0) {
      identity = `string:${item}`;
    } else {
      throw new Error(`${specKind === 'modular' ? '模块式' : '混合式'}变体类型无效: ${path}[${index}]`);
    }
    if (seen.has(identity)) throw new Error(`${path} 存在重复变体`);
    seen.add(identity);
  });
}

function validateModularTree(value, spec, path) {
  if (!isPlainObject(value)) throw new Error(`${path} 必须是对象`);
  if (Object.keys(value).length === 0) throw new Error(`${path} 不能为空`);
  Object.entries(value).forEach(([moduleType, sizes]) => {
    assertName(moduleType, `${path} 的键`);
    if (!MODULE_TYPES.has(moduleType)) throw new Error(`模块类型无效: ${spec}/${moduleType}`);
    if (!isPlainObject(sizes) || Object.keys(sizes).length === 0) throw new Error(`${path}.${moduleType} 不能为空`);
    Object.entries(sizes).forEach(([size, areaLevels]) => {
      const [xCount, yCount] = parseSize(size, `${path}.${moduleType}`);
      if (!isPlainObject(areaLevels)) throw new Error(`${path}.${moduleType}.${size} 必须是对象`);
      if (Object.keys(areaLevels).length === 0) return;
      Object.entries(areaLevels).forEach(([areaLevel, openings]) => {
        if (!AREA_LEVELS.has(areaLevel)) throw new Error(`面积等级无效: ${spec}/${moduleType}/${size}/${areaLevel}`);
        if (moduleType === 'Outer' && !['Base', 'Huge'].includes(areaLevel)) throw new Error(`Outer 面积等级只允许 Base/Huge: ${spec}/${size}/${areaLevel}`);
        if (!isPlainObject(openings) || Object.keys(openings).length === 0) throw new Error(`${path}.${moduleType}.${size}.${areaLevel} 不能为空`);
        Object.entries(openings).forEach(([opening, variants]) => {
          if (!/^(?:0|[1-9][0-9]*)$/.test(opening) || BigInt(opening) >= (1n << BigInt(2 * (xCount + yCount)))) throw new Error(`开口状态超出尺寸边界位数: ${spec}/${moduleType}/${size}/${areaLevel}/${opening}`);
          validateLeaf(variants, `${path}.${moduleType}.${size}.${areaLevel}.${opening}`, 'modular');
        });
      });
    });
  });
}

function validateMixedTree(value, spec, path) {
  if (!isPlainObject(value)) throw new Error(`${path} 必须是对象`);
  if (Object.keys(value).length === 0) throw new Error(`${path} 不能为空`);
  Object.entries(value).forEach(([size, roomTypes]) => {
    const [width, roomDepth] = parseSize(size, path);
    if (width > roomDepth || width % 4 !== 0 || roomDepth % 4 !== 0) throw new Error(`混合式尺寸必须规范化且宽深为 4 的倍数: ${spec}/${size}`);
    const unit = Number(MIXED_SPEC_RE.exec(spec)[1]);
    if (width % unit !== 0 || roomDepth % unit !== 0) throw new Error(`混合式尺寸必须能被单位长度 ${unit} 整除: ${spec}/${size}`);
    if (!isPlainObject(roomTypes)) throw new Error(`${path}.${size} 必须是对象`);
    if (Object.keys(roomTypes).length === 0) return;
    Object.entries(roomTypes).forEach(([roomType, ctgs]) => {
      if (!SAFE_NAME_SEGMENT_RE.test(roomType)) throw new Error(`房间类型只能包含英文字母和数字: ${spec}/${size}/${roomType}`);
      if (!isPlainObject(ctgs) || Object.keys(ctgs).length === 0) throw new Error(`${path}.${size}.${roomType} 不能为空`);
      Object.entries(ctgs).forEach(([ctg, variants]) => {
        if (!/^[0-9]{2}$/.test(ctg) || Number(ctg) <= 0) throw new Error(`CTG 必须是大于 00 的两位数字字符串: ${spec}/${size}/${roomType}/${ctg}`);
        validateLeaf(variants, `${path}.${size}.${roomType}.${ctg}`, 'mixed');
      });
    });
  });
}

export function validateDocument(document) {
  if (!isPlainObject(document)) throw new Error('目标 JSON 必须是对象');
  const unknownFields = Object.keys(document).filter(key => !DOCUMENT_FIELDS.has(key));
  if (unknownFields.length) throw new Error(`模板文档包含未知字段: ${unknownFields.sort().join(', ')}`);
  if (document.schema !== MODULES_SCHEMA) throw new Error('schema 必须是 pcg-modules-templates');
  if (document.schema_version !== 2) throw new Error('schema_version 必须是 2');
  if (!isPlainObject(document.modules) || Object.keys(document.modules).length === 0) {
    throw new Error('modules 必须包含至少一个规格');
  }
  Object.entries(document.modules).forEach(([spec, tree]) => {
    const specKind = parseSpec(spec);
    if (specKind === 'modular') validateModularTree(tree, spec, `modules.${spec}`);
    else validateMixedTree(tree, spec, `modules.${spec}`);
  });
  return document;
}

export function canonicalizeModuleTargetBranch(spec, targets, targetIntent = 'defined') {
  if (targetIntent === 'explicit_empty') {
    if (!isPlainObject(targets) || Object.keys(targets).length !== 0) {
      throw new Error('explicit_empty 目标必须是空对象');
    }
    parseSpec(spec);
    return {};
  }
  if (targetIntent !== 'defined') throw new Error('target_intent 必须是 defined 或 explicit_empty');
  const document = {
    schema: MODULES_SCHEMA,
    schema_version: 2,
    modules: { [spec]: clone(targets) },
  };
  validateDocument(document);
  if (countTargets(document) === 0) throw new Error('defined 目标必须包含至少一个合法叶子');
  return JSON.parse(canonicalText(targets));
}

export function parseDocumentText(text) {
  if (typeof text !== 'string') throw new Error('目标 JSON 文本必须是字符串');
  JSON.parse(text);
  assertNoDuplicateJsonKeys(text);
  return validateDocument(JSON.parse(text));
}

async function fingerprintJsonDocument(document) {
  const canonical = canonicalText(document);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonical)
  );
  return `sha256:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`;
}

export async function fingerprintDocument(document) {
  return fingerprintJsonDocument(validateDocument(document));
}

export async function buildModuleGoalDraft({
  moduleTemplates, rootSource, draftRevision, updatedAt, updatedBy,
}) {
  validateDocument(moduleTemplates);
  if (!CONFIG_ROOT_SOURCES.has(rootSource)) throw new Error('root_source 无效');
  assertName(draftRevision, 'draft_revision');
  assertName(updatedBy, 'updated_by');
  const serverTimestampMethod = updatedAt?._methodName || updatedAt?._delegate?._methodName;
  const isServerTimestampSentinel = serverTimestampMethod === 'serverTimestamp' ||
    serverTimestampMethod === 'FieldValue.serverTimestamp';
  if (!updatedAt || (typeof updatedAt.toDate !== 'function' && !isServerTimestampSentinel)) {
    throw new Error('updated_at 必须是 Firestore Timestamp');
  }
  return {
    schema: MODULE_GOAL_DRAFT_SCHEMA,
    schema_version: 1,
    root_source: rootSource,
    draft_revision: draftRevision,
    updated_at: updatedAt,
    updated_by: updatedBy,
    module_templates: clone(moduleTemplates),
    module_templates_sha256: await fingerprintDocument(moduleTemplates),
  };
}

export async function validateModuleGoalDraft(record) {
  if (!isPlainObject(record)) throw new Error('模块目标草稿必须是对象');
  const unknownFields = Object.keys(record).filter(key => !MODULE_GOAL_DRAFT_FIELDS.has(key));
  if (unknownFields.length) throw new Error(`模块目标草稿包含未知字段: ${unknownFields.sort().join(', ')}`);
  const missingFields = [...MODULE_GOAL_DRAFT_FIELDS].filter(
    key => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (missingFields.length) throw new Error(`模块目标草稿缺少字段: ${missingFields.sort().join(', ')}`);
  if (record.schema !== MODULE_GOAL_DRAFT_SCHEMA) throw new Error('模块目标草稿 schema 无效');
  if (record.schema_version !== 1) throw new Error('模块目标草稿 schema_version 必须是 1');
  if (!CONFIG_ROOT_SOURCES.has(record.root_source)) throw new Error('root_source 无效');
  assertName(record.draft_revision, 'draft_revision');
  assertName(record.updated_by, 'updated_by');
  if (!record.updated_at || typeof record.updated_at.toDate !== 'function') {
    throw new Error('updated_at 必须是 Firestore Timestamp');
  }
  validateDocument(record.module_templates);
  if (typeof record.module_templates_sha256 !== 'string' || !SHA256_RE.test(record.module_templates_sha256)) {
    throw new Error('module_templates_sha256 必须是 SHA-256 指纹');
  }
  if (record.module_templates_sha256 !== await fingerprintDocument(record.module_templates)) {
    throw new Error('module_templates_sha256 与 module_templates 不一致');
  }
  return record;
}

export async function moduleGoalDraftFromConfigBundle(bundle, metadata = {}) {
  if (!isPlainObject(bundle) || !isPlainObject(bundle.module_templates)) {
    throw new Error('最终配置 Bundle 缺少 module_templates');
  }
  return buildModuleGoalDraft({
    moduleTemplates: bundle.module_templates,
    rootSource: bundle.root_source,
    draftRevision: metadata.draftRevision || bundle.sync_revision,
    updatedAt: metadata.updatedAt || bundle.updated_at,
    updatedBy: metadata.updatedBy || bundle.updated_by,
  });
}

export function validateThemeConfig(document) {
  if (!isPlainObject(document)) throw new Error('theme_config 必须是 JSON object');
  if (!isPlainObject(document.Theme_Registry)) throw new Error('theme_config 缺少 Theme_Registry');
  if (!isPlainObject(document.Mode_Configs)) throw new Error('theme_config 缺少 Mode_Configs');
  for (const profile of ['modular', 'mixed']) {
    const profileConfig = document.Mode_Configs[profile];
    if (!isPlainObject(profileConfig)) throw new Error(`theme_config 缺少 Mode_Configs/${profile}`);
    if (!isPlainObject(profileConfig.themes)) throw new Error(`theme_config 缺少 Mode_Configs/${profile}/themes`);
  }
  return document;
}

export async function buildConfigBundle({
  themeConfig, moduleTemplates, rootSource, syncRevision, updatedAt, updatedBy,
}) {
  validateThemeConfig(themeConfig);
  validateDocument(moduleTemplates);
  if (!CONFIG_ROOT_SOURCES.has(rootSource)) throw new Error('root_source 无效');
  assertName(syncRevision, 'sync_revision');
  assertName(updatedBy, 'updated_by');
  if (!updatedAt) throw new Error('updated_at 不能为空');
  return {
    schema: CONFIG_BUNDLE_SCHEMA,
    schema_version: 1,
    root_source: rootSource,
    sync_revision: syncRevision,
    updated_at: updatedAt,
    updated_by: updatedBy,
    theme_config: clone(themeConfig),
    module_templates: clone(moduleTemplates),
    theme_config_sha256: await fingerprintJsonDocument(themeConfig),
    module_templates_sha256: await fingerprintDocument(moduleTemplates),
  };
}

export async function validateConfigBundle(record) {
  if (!isPlainObject(record)) throw new Error('云端配置 bundle 必须是对象');
  const unknownFields = Object.keys(record).filter(key => !CONFIG_BUNDLE_FIELDS.has(key));
  if (unknownFields.length) throw new Error(`云端配置 bundle 包含未知字段: ${unknownFields.sort().join(', ')}`);
  const missingFields = [...CONFIG_BUNDLE_FIELDS].filter(key => !Object.prototype.hasOwnProperty.call(record, key));
  if (missingFields.length) throw new Error(`云端配置 bundle 缺少字段: ${missingFields.sort().join(', ')}`);
  if (record.schema !== CONFIG_BUNDLE_SCHEMA) throw new Error('bundle schema 必须是 pcg-modules-config-bundle');
  if (record.schema_version !== 1) throw new Error('bundle schema_version 必须是 1');
  if (!CONFIG_ROOT_SOURCES.has(record.root_source)) throw new Error('root_source 无效');
  assertName(record.sync_revision, 'sync_revision');
  validateThemeConfig(record.theme_config);
  validateDocument(record.module_templates);
  if (typeof record.theme_config_sha256 !== 'string' || !SHA256_RE.test(record.theme_config_sha256)) {
    throw new Error('theme_config_sha256 必须是 SHA-256 指纹');
  }
  if (typeof record.module_templates_sha256 !== 'string' || !SHA256_RE.test(record.module_templates_sha256)) {
    throw new Error('module_templates_sha256 必须是 SHA-256 指纹');
  }
  if (record.theme_config_sha256 !== await fingerprintJsonDocument(record.theme_config)) {
    throw new Error('theme_config_sha256 与 theme_config 不一致');
  }
  if (record.module_templates_sha256 !== await fingerprintDocument(record.module_templates)) {
    throw new Error('module_templates_sha256 与 module_templates 不一致');
  }
  if (typeof record.updated_by !== 'string' || !record.updated_by.trim()) {
    throw new Error('updated_by 必须是非空字符串');
  }
  if (!record.updated_at || typeof record.updated_at.toDate !== 'function') {
    throw new Error('updated_at 必须是 Firestore Timestamp');
  }
  return record;
}

export async function normalizeConfigBundleForRead(record, rootSource) {
  try {
    await validateConfigBundle(record);
    return { record, migrated: false };
  } catch (originalError) {
    if (!isPlainObject(record) || Object.prototype.hasOwnProperty.call(record, 'root_source')) {
      throw originalError;
    }
    const patchedRecord = { ...record, root_source: rootSource };
    await validateConfigBundle(patchedRecord);
    return { record: patchedRecord, migrated: true };
  }
}

export function decideCloudSnapshotAction({
  record, dirty, hasPendingWrites, draftFingerprint, baseFingerprint,
}) {
  if (hasPendingWrites) return 'wait';
  if (!dirty) return 'apply';
  if (record.module_templates_sha256 === draftFingerprint) return 'ack';
  if (record.module_templates_sha256 === baseFingerprint) return 'retry';
  return 'conflict';
}

export function assertCloudWriteBase(record, expectedBaseFingerprint) {
  const actual = record ? record.module_templates_sha256 : '';
  if (actual === expectedBaseFingerprint) return;
  const error = new Error('云端模板已由其他用户更新，本地草稿未覆盖云端');
  error.code = 'pcg-modules-template-conflict';
  throw error;
}

export function latestThemeConfigFingerprint(rows, templateFingerprint) {
  if (!Array.isArray(rows) || !templateFingerprint) return '';
  let latestTime = '';
  const fingerprints = new Set();
  rows.forEach(row => {
    if (!isPlainObject(row) || row.template_fingerprint !== templateFingerprint) return;
    if (typeof row.theme_config_fingerprint !== 'string' || !row.theme_config_fingerprint) return;
    if (typeof row.scanned_at !== 'string' || !row.scanned_at) return;
    if (row.scanned_at > latestTime) {
      latestTime = row.scanned_at;
      fingerprints.clear();
      fingerprints.add(row.theme_config_fingerprint);
    } else if (row.scanned_at === latestTime) {
      fingerprints.add(row.theme_config_fingerprint);
    }
  });
  return fingerprints.size === 1 ? fingerprints.values().next().value : '';
}

export function isScannerStatusStale(row, templateFingerprint, themeConfigFingerprint) {
  return !isPlainObject(row)
    || !templateFingerprint
    || !themeConfigFingerprint
    || row.template_fingerprint !== templateFingerprint
    || row.theme_config_fingerprint !== themeConfigFingerprint;
}

// 进度详情已保存但尚未完成首次扫描的主题，仍需要在资产页显示为灰点占位。
// 该合并只构造只读视图数据，不向 pcgAssetStatus 写入任何内容；真实扫描文档按 asset_prefix 优先保留。
export function mergeThemeStatusScopes(document, scannerStatuses, themeScopes = []) {
  validateDocument(document);
  const result = Array.isArray(scannerStatuses) ? scannerStatuses.map(row => ({ ...row })) : [];
  const existingPrefixes = new Set(result.map(row => String(row?.asset_prefix || '').trim()).filter(Boolean));
  (Array.isArray(themeScopes) ? themeScopes : []).forEach(scope => {
    if (!isPlainObject(scope)) return;
    const assetPrefix = String(scope.asset_prefix || '').trim();
    const specId = String(scope.spec_id || '').trim();
    if (!assetPrefix || !specId || existingPrefixes.has(assetPrefix)) return;
    const targetCount = listModuleTargets(document, specId).length;
    result.push({
      scope_id: String(scope.scope_id || `theme_${assetPrefix}`),
      asset_prefix: assetPrefix,
      spec_id: specId,
      target_count: targetCount,
      status_source: 'theme_config',
    });
    existingPrefixes.add(assetPrefix);
  });
  return result;
}

export function countTargets(document) {
  validateDocument(document);
  let count = 0;
  function visit(value) {
    if (Array.isArray(value)) { count += value.length; return; }
    Object.values(value).forEach(visit);
  }
  Object.values(document.modules).forEach(visit);
  return count;
}

export function summarize(document) {
  validateDocument(document);
  return Object.entries(document.modules).map(([spec, tree]) => {
    const one = { spec, targetCount: 0 };
    function visit(value) {
      if (Array.isArray(value)) { one.targetCount += value.length; return; }
      Object.values(value).forEach(visit);
    }
    visit(tree);
    return one;
  });
}

function requireModuleSpec(document, spec) {
  if (!isPlainObject(document) || !isPlainObject(document.modules)) throw new Error('目标 JSON 必须包含 modules 对象');
  if (!Object.prototype.hasOwnProperty.call(document.modules, spec)) throw new Error(`模板规格不存在: ${spec}`);
  parseSpec(spec);
  if (!isPlainObject(document.modules[spec])) throw new Error(`模板规格必须是对象: ${spec}`);
  return document.modules[spec];
}

function reorderObject(parent, key, nextIndex, replacementKey = key) {
  const keys = Object.keys(parent);
  const currentIndex = keys.indexOf(key);
  if (currentIndex < 0) throw new Error(`节点不存在: ${key}`);
  if (nextIndex < 0 || nextIndex >= keys.length) return;
  const value = parent[key];
  keys.splice(currentIndex, 1);
  keys.splice(nextIndex, 0, replacementKey);
  const reordered = {};
  keys.forEach(entryKey => { reordered[entryKey] = entryKey === replacementKey ? value : parent[entryKey]; });
  Object.keys(parent).forEach(entryKey => delete parent[entryKey]);
  Object.assign(parent, reordered);
}

export function addModuleSpec(document, spec) {
  parseSpec(spec);
  if (!isPlainObject(document) || !isPlainObject(document.modules)) throw new Error('目标 JSON 必须包含 modules 对象');
  if (Object.prototype.hasOwnProperty.call(document.modules, spec)) throw new Error(`模板规格已存在: ${spec}`);
  const edited = cloneForEdit(document);
  edited.modules[spec] = {};
  return edited;
}

export function renameModuleSpec(document, spec, newSpec) {
  const oldKind = parseSpec(spec);
  const newKind = parseSpec(newSpec);
  const tree = requireModuleSpec(document, spec);
  if (spec !== newSpec && Object.prototype.hasOwnProperty.call(document.modules, newSpec)) throw new Error(`模板规格已存在: ${newSpec}`);
  if (Object.keys(tree).length > 0 && oldKind !== newKind) throw new Error('非空规格不能跨模块式/混合式类型重命名');
  if (spec === newSpec) return cloneForEdit(document);
  const edited = cloneForEdit(document);
  const index = Object.keys(edited.modules).indexOf(spec);
  reorderObject(edited.modules, spec, index, newSpec);
  return edited;
}

export function removeModuleSpec(document, spec) {
  requireModuleSpec(document, spec);
  const edited = cloneForEdit(document);
  delete edited.modules[spec];
  return edited;
}

export function moveModuleSpec(document, spec, offset) {
  requireModuleSpec(document, spec);
  if (!Number.isInteger(offset) || offset === 0) return cloneForEdit(document);
  const edited = cloneForEdit(document);
  const index = Object.keys(edited.modules).indexOf(spec);
  reorderObject(edited.modules, spec, index + offset);
  return edited;
}

export function moveModuleGroup(document, spec, group, offset) {
  const tree = requireModuleSpec(document, spec);
  if (!Object.prototype.hasOwnProperty.call(tree, group)) throw new Error(`模块分组不存在: ${spec}/${group}`);
  if (!Number.isInteger(offset) || offset === 0) return cloneForEdit(document);
  const edited = cloneForEdit(document);
  const editedTree = edited.modules[spec];
  const index = Object.keys(editedTree).indexOf(group);
  reorderObject(editedTree, group, index + offset);
  return edited;
}

export function renameModuleGroup(document, spec, group, newGroup) {
  const tree = requireModuleSpec(document, spec);
  if (!Object.prototype.hasOwnProperty.call(tree, group)) throw new Error(`模块分组不存在: ${spec}/${group}`);
  const normalizedGroup = String(newGroup ?? '').trim();
  if (group === normalizedGroup) return cloneForEdit(document);
  if (Object.prototype.hasOwnProperty.call(tree, normalizedGroup)) throw new Error(`模块分组已存在: ${spec}/${normalizedGroup}`);
  const edited = cloneForEdit(document);
  const editedTree = edited.modules[spec];
  const index = Object.keys(editedTree).indexOf(group);
  reorderObject(editedTree, group, index, normalizedGroup);
  if (parseSpec(spec) === 'modular') validateModularTree(editedTree, spec, `modules.${spec}`);
  else validateMixedTree(editedTree, spec, `modules.${spec}`);
  return edited;
}

export function removeModuleGroup(document, spec, group) {
  const tree = requireModuleSpec(document, spec);
  if (!Object.prototype.hasOwnProperty.call(tree, group)) throw new Error(`模块分组不存在: ${spec}/${group}`);
  const edited = cloneForEdit(document);
  delete edited.modules[spec][group];
  return edited;
}

function greatestCommonDivisor(left, right) {
  let a = left;
  let b = right;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function getDefaultModuleTarget(spec) {
  if (parseSpec(spec) === 'modular') {
    return { moduleType: 'Area', size: '1x1', areaLevel: 'Base', opening: '0', variant: '1' };
  }
  const unit = Number(MIXED_SPEC_RE.exec(spec)[1]);
  const size = (4 * unit) / greatestCommonDivisor(4, unit);
  return { size: `${size}x${size}`, roomType: 'Room', ctg: '01', variant: '01' };
}

function normalizeModuleTarget(spec, target) {
  if (!isPlainObject(target)) throw new Error('目标配置必须是对象');
  const specKind = parseSpec(spec);
  if (specKind === 'modular') {
    const moduleType = String(target.moduleType ?? '').trim();
    const size = String(target.size ?? '').trim();
    const areaLevel = String(target.areaLevel ?? '').trim();
    const opening = String(target.opening ?? '').trim();
    const variantText = String(target.variant ?? '').trim();
    const variant = /^[1-9][0-9]*$/.test(variantText) ? Number(variantText) : null;
    const tree = { [moduleType]: { [size]: { [areaLevel]: { [opening]: [variant] } } } };
    validateModularTree(tree, spec, `modules.${spec}`);
    return {
      specKind, group: moduleType, pathParts: [moduleType, size, areaLevel, opening],
      value: variant,
      fields: { moduleType, size, areaLevel, opening, variant: String(variant) },
      name: `Module_${moduleType}_${areaLevel}_${size}_${opening}_${String(variant).padStart(2, '0')}_01`,
    };
  }
  const size = String(target.size ?? '').trim();
  const roomType = String(target.roomType ?? '').trim();
  const ctg = String(target.ctg ?? '').trim();
  const variant = String(target.variant ?? '').trim();
  const tree = { [size]: { [roomType]: { [ctg]: [variant] } } };
  validateMixedTree(tree, spec, `modules.${spec}`);
  return {
    specKind, group: size, pathParts: [size, roomType, ctg], value: variant,
    fields: { size, roomType, ctg, variant },
    name: `Module_Room_${size}_${roomType}_${String(Number(ctg)).padStart(2, '0')}_${String(Number(variant)).padStart(2, '0')}_01`,
  };
}

export function listModuleTargets(document, spec) {
  if (!isPlainObject(document) || !isPlainObject(document.modules)) throw new Error('目标 JSON 必须包含 modules 对象');
  if (!Object.prototype.hasOwnProperty.call(document.modules, spec)) throw new Error(`模板规格不存在: ${spec}`);
  const specKind = parseSpec(spec);
  const tree = document.modules[spec];
  if (!isPlainObject(tree)) throw new Error(`模板规格必须是对象: ${spec}`);
  const targets = [];
  if (specKind === 'modular') {
    Object.entries(tree).forEach(([moduleType, sizes]) => {
      Object.entries(sizes || {}).forEach(([size, areaLevels]) => {
        Object.entries(areaLevels || {}).forEach(([areaLevel, openings]) => {
          Object.entries(openings || {}).forEach(([opening, variants]) => {
            if (!Array.isArray(variants)) return;
            variants.forEach((variant, index) => {
              const normalized = normalizeModuleTarget(spec, { moduleType, size, areaLevel, opening, variant });
              const path = ['modules', spec, moduleType, size, areaLevel, opening, String(index)];
              targets.push({ ...normalized, path, key: path.join('/'), index, countInLeaf: variants.length });
            });
          });
        });
      });
    });
  } else {
    Object.entries(tree).forEach(([size, roomTypes]) => {
      Object.entries(roomTypes || {}).forEach(([roomType, ctgs]) => {
        Object.entries(ctgs || {}).forEach(([ctg, variants]) => {
          if (!Array.isArray(variants)) return;
          variants.forEach((variant, index) => {
            const normalized = normalizeModuleTarget(spec, { size, roomType, ctg, variant });
            const path = ['modules', spec, size, roomType, ctg, String(index)];
            targets.push({ ...normalized, path, key: path.join('/'), index, countInLeaf: variants.length });
          });
        });
      });
    });
  }
  return targets;
}

function scannerWorkItemNames(document, status) {
  if (!isPlainObject(status)) throw new Error('Scanner 状态必须是对象');
  assertName(status.spec_id, 'Scanner spec_id');
  assertName(status.asset_prefix, 'Scanner asset_prefix');
  const expectedNames = listModuleTargets(document, status.spec_id).map(target =>
    target.name.replace(/^Module_/, `${status.asset_prefix}_`)
  );
  const expectedNameSet = new Set(expectedNames);
  let names;
  if (Array.isArray(status.work_item_names)) {
    names = status.work_item_names.map(value => String(value));
  } else {
    names = expectedNames;
  }
  if (names.length !== status.target_count) {
    throw new Error('Scanner 目标范围无法与当前目标 JSON 一一对应，请重新扫描');
  }
  if (new Set(names).size !== names.length) throw new Error('Scanner work item 名称重复');
  const prefix = `${status.asset_prefix}_`;
  if (names.some(name => !name.startsWith(prefix))) {
    throw new Error('Scanner work item 主题前缀与当前范围不一致');
  }
  if (names.some(name => !expectedNameSet.has(name))) {
    throw new Error('Scanner work item 不属于当前目标 JSON，请重新扫描');
  }
  if (names.length !== expectedNames.length) {
    throw new Error('Scanner 目标范围无法与当前目标 JSON 一一对应，请重新扫描');
  }
  return names;
}

export function buildModuleWorkItemStatuses(document, status, skippedTargetKeys = []) {
  const names = scannerWorkItemNames(document, status);
  const nameSet = new Set(names);
  const missingMaps = new Set((status.missing_maps || []).map(name => String(name).replace(/^Map_/, '')));
  const missingBlueprints = new Set((status.missing_blueprints || []).map(name => String(name).replace(/^BP_/, '')));
  if ([...missingMaps, ...missingBlueprints].some(name => !nameSet.has(name))) {
    throw new Error('Scanner 缺失资产与 work item 范围不一致，请重新扫描');
  }
  const mapOnly = status.map_bp_state === 'not_applicable';
  const assetPrefix = `${status.asset_prefix}_`;
  const skippedKeys = [...new Set((skippedTargetKeys || []).map(value => String(value).trim()).filter(Boolean))];
  return names.map(name => {
    const mapExists = !missingMaps.has(name);
    const bpExists = mapOnly ? null : !missingBlueprints.has(name);
    const targetName = name.startsWith(assetPrefix) ? name.slice(assetPrefix.length) : name;
    const skipped = skippedKeys.some(key => targetName === key || targetName.startsWith(`${key}_`));
    return { name, mapExists, bpExists, skipped };
  });
}

// 主题最终目标是 Scanner 分母的唯一来源；复用规格级状态逻辑但把目标树限定到该主题。
export function buildThemeModuleWorkItemStatuses(document, status, themeTargets, skippedTargetKeys = []) {
  validateDocument(document);
  if (!isPlainObject(status)) throw new Error('Scanner 状态必须是对象');
  assertName(status.spec_id, 'Scanner spec_id');
  const spec = status.spec_id;
  if (!isPlainObject(themeTargets) || Object.keys(themeTargets).length === 0) {
    if (status.target_intent === 'explicit_empty') return [];
    throw new Error('主题最终目标必须是非空对象');
  }
  const scoped = {
    schema: MODULES_SCHEMA,
    schema_version: 2,
    modules: { [spec]: clone(themeTargets) },
  };
  validateDocument(scoped);
  const targetCount = listModuleTargets(scoped, spec).length;
  return buildModuleWorkItemStatuses(scoped, { ...status, target_count: targetCount }, skippedTargetKeys);
}

export function reconcileThemeModuleWorkItemStatuses(document, status, themeTargets, skippedTargetKeys = []) {
  validateDocument(document);
  if (!isPlainObject(status)) throw new Error('Scanner 状态必须是对象');
  assertName(status.spec_id, 'Scanner spec_id');
  if (!isPlainObject(themeTargets) || Object.keys(themeTargets).length === 0) {
    if (status.target_intent === 'explicit_empty') return [];
    throw new Error('主题最终目标必须是非空对象');
  }
  const scoped = {
    schema: MODULES_SCHEMA,
    schema_version: 2,
    modules: { [status.spec_id]: clone(themeTargets) },
  };
  validateDocument(scoped);
  return reconcileModuleWorkItemStatuses(scoped, status, skippedTargetKeys);
}

export function reconcileModuleWorkItemStatuses(document, status, skippedTargetKeys = []) {
  if (!isPlainObject(status)) throw new Error('Scanner 状态必须是对象');
  assertName(status.spec_id, 'Scanner spec_id');
  assertName(status.asset_prefix, 'Scanner asset_prefix');
  const assetPrefix = `${status.asset_prefix}_`;
  const expectedNames = listModuleTargets(document, status.spec_id).map(target =>
    target.name.replace(/^Module_/, assetPrefix)
  );
  const hasExplicitNames = Array.isArray(status.work_item_names);
  if (!hasExplicitNames && expectedNames.length !== status.target_count) {
    throw new Error('Scanner 目标范围无法与当前目标 JSON 一一对应，请重新扫描');
  }
  const scannedNames = new Set(hasExplicitNames
    ? status.work_item_names.map(value => String(value))
    : expectedNames);
  const missingMaps = new Set((status.missing_maps || []).map(name => String(name).replace(/^Map_/, '')));
  const missingBlueprints = new Set((status.missing_blueprints || []).map(name => String(name).replace(/^BP_/, '')));
  const mapOnly = status.map_bp_state === 'not_applicable';
  const skippedKeys = [...new Set((skippedTargetKeys || []).map(value => String(value).trim()).filter(Boolean))];
  return expectedNames.map(name => {
    const scanned = scannedNames.has(name);
    const targetName = name.slice(assetPrefix.length);
    const skipped = skippedKeys.some(key => targetName === key || targetName.startsWith(`${key}_`));
    return {
      name,
      mapExists: scanned && !missingMaps.has(name),
      bpExists: mapOnly ? null : scanned && !missingBlueprints.has(name),
      skipped,
      scanned,
    };
  });
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
}

export function summarizeModuleWorkItemStatuses(items) {
  const summary = { mapPresent: 0, bpPresent: 0, bpApplicable: false, targetTotal: 0, total: 0, skipped: 0 };
  (items || []).forEach(item => {
    summary.targetTotal += 1;
    if (item.bpExists !== null) summary.bpApplicable = true;
    if (item.skipped === true) {
      summary.skipped += 1;
      return;
    }
    if (item.mapExists === true) summary.mapPresent += 1;
    if (item.bpExists === true) summary.bpPresent += 1;
    summary.total += 1;
  });
  return summary;
}

export function buildModuleWorkItemGroups(document, status, groupFields = null, skippedTargetKeys = [], providedItems = null) {
  const items = providedItems || buildModuleWorkItemStatuses(document, status, skippedTargetKeys);
  const targets = listModuleTargets(document, status.spec_id);
  const prefix = `${status.asset_prefix}_`;
  const targetByName = new Map(targets.map(target => [target.name.replace(/^Module_/, prefix), target]));
  const itemByName = new Map(items.map(item => [item.name, item]));
  const availableFields = parseSpec(status.spec_id) === 'modular'
    ? ['moduleType', 'size', 'areaLevel', 'opening']
    : ['size', 'roomType', 'ctg'];
  const selectedFields = Array.isArray(groupFields)
    ? groupFields.filter(field => availableFields.includes(field)).filter((field, index, fields) => fields.indexOf(field) === index).slice(0, 3)
    : [availableFields[0]];
  const targetFields = target => target.fields;
  if (Array.isArray(groupFields)) {
    if (selectedFields.length === 0) {
      return [{ key: '__all__', label: '全部', level: 1, parentKey: null, isLeaf: true, items, summary: summarizeModuleWorkItemStatuses(items) }];
    }
    const groups = [];
    const groupsByKey = new Map();
    const ensureGroup = (target, depth, parentKey) => {
      const field = selectedFields[depth];
      const value = String(targetFields(target)[field] ?? '');
      const key = parentKey ? `${parentKey}/${value}` : value;
      let group = groupsByKey.get(key);
      if (!group) {
        group = { key, label: value, level: depth + 1, parentKey: parentKey || null, items: [], isLeaf: depth === selectedFields.length - 1 };
        groupsByKey.set(key, group);
        groups.push(group);
      }
      return group;
    };
    targets.forEach(target => {
      let parentKey = null;
      let leaf = null;
      selectedFields.forEach((field, depth) => { leaf = ensureGroup(target, depth, parentKey); parentKey = leaf.key; });
      const namePrefix = target.name.replace(/^Module_/, prefix);
      const item = targetByName.has(namePrefix) ? itemByName.get(namePrefix) : null;
      if (item && leaf) leaf.items.push(item);
    });
    groups.sort((left, right) => naturalCompare(left.key, right.key));
    groups.forEach(group => {
      group.items.sort((left, right) => naturalCompare(left.name, right.name));
      const descendants = groups.filter(candidate => candidate.key === group.key || candidate.key.startsWith(`${group.key}/`));
      const itemsForSummary = descendants.flatMap(candidate => candidate.items);
      group.summary = summarizeModuleWorkItemStatuses(itemsForSummary);
    });
    return groups;
  }
  const groups = new Map();
  targets.forEach(target => {
    if (!groups.has(target.group)) groups.set(target.group, { key: target.group, label: target.group, level: 1, parentKey: null, isLeaf: true, items: [] });
  });
  items.forEach(item => {
    const target = targetByName.get(item.name);
    if (!target) throw new Error(`Scanner work item 无法映射到模板分组: ${item.name}`);
    const key = target.group;
    groups.get(key).items.push(item);
  });
  return [...groups.values()].sort((left, right) => naturalCompare(left.key, right.key)).map(group => ({
    ...group,
    items: group.items.sort((left, right) => naturalCompare(left.name, right.name)),
    summary: summarizeModuleWorkItemStatuses(group.items),
  }));
}

export function listModuleDefinitions(document, spec) {
  const tree = requireModuleSpec(document, spec);
  const specKind = parseSpec(spec);
  const definitions = [];
  if (specKind === 'modular') {
    Object.entries(tree).forEach(([moduleType, sizes]) => {
      Object.entries(sizes || {}).forEach(([size, areaLevels]) => {
        Object.entries(areaLevels || {}).forEach(([areaLevel, openings]) => {
          Object.entries(openings || {}).forEach(([opening, variants]) => {
            if (!Array.isArray(variants) || variants.length === 0) return;
            const path = ['modules', spec, moduleType, size, areaLevel, opening];
            definitions.push({
              specKind, group: moduleType, path, key: path.join('/'),
              variantCount: variants.length,
              fields: { moduleType, size, areaLevel, opening },
              name: `Module_${moduleType}_${areaLevel}_${size}_${opening}`,
            });
          });
        });
      });
    });
  } else {
    Object.entries(tree).forEach(([size, roomTypes]) => {
      Object.entries(roomTypes || {}).forEach(([roomType, ctgs]) => {
        Object.entries(ctgs || {}).forEach(([ctg, variants]) => {
          if (!Array.isArray(variants) || variants.length === 0) return;
          const path = ['modules', spec, size, roomType, ctg];
          definitions.push({
            specKind, group: size, path, key: path.join('/'),
            variantCount: variants.length,
            fields: { size, roomType, ctg },
            name: `Module_Room_${size}_${roomType}_${ctg}`,
          });
        });
      });
    });
  }
  return definitions;
}

export function listModuleSizes(document, spec) {
  const tree = requireModuleSpec(document, spec);
  const specKind = parseSpec(spec);
  const definitions = listModuleDefinitions(document, spec);
  const sizes = [];
  if (specKind === 'modular') {
    Object.entries(tree).forEach(([moduleType, sizeTree]) => {
      Object.keys(sizeTree || {}).forEach(size => {
        const matches = definitions.filter(item => item.group === moduleType && item.fields.size === size);
        sizes.push({
          key: `${spec}/${moduleType}/${size}`,
          specKind,
          group: moduleType,
          size,
          path: ['modules', spec, moduleType, size],
          definitions: matches,
          variantCount: matches.reduce((sum, item) => sum + item.variantCount, 0),
        });
      });
    });
  } else {
    Object.keys(tree).forEach(size => {
      const matches = definitions.filter(item => item.fields.size === size);
      sizes.push({
        key: `${spec}/${size}`,
        specKind,
        group: size,
        size,
        path: ['modules', spec, size],
        definitions: matches,
        variantCount: matches.reduce((sum, item) => sum + item.variantCount, 0),
      });
    });
  }
  return sizes;
}

function moduleSizeOrderParents(document) {
  if (!isPlainObject(document) || !isPlainObject(document.modules)) throw new Error('目标 JSON 必须包含 modules 对象');
  const parents = [];
  Object.entries(document.modules).forEach(([spec, tree]) => {
    if (parseSpec(spec) === 'modular') {
      Object.entries(tree || {}).forEach(([moduleType, sizeTree]) => {
        parents.push({ spec, module_type: moduleType, sizes: Object.keys(sizeTree || {}) });
      });
    } else {
      parents.push({ spec, module_type: '', sizes: Object.keys(tree || {}) });
    }
  });
  return parents;
}

export function normalizeModuleSpecOrder(document, specOrder) {
  if (!isPlainObject(document) || !isPlainObject(document.modules)) throw new Error('目标 JSON 必须包含 modules 对象');
  const available = Object.keys(document.modules);
  const availableSet = new Set(available);
  const normalized = [];
  if (Array.isArray(specOrder)) {
    specOrder.forEach(spec => {
      if (typeof spec === 'string' && availableSet.has(spec) && !normalized.includes(spec)) normalized.push(spec);
    });
  }
  available.forEach(spec => { if (!normalized.includes(spec)) normalized.push(spec); });
  return normalized;
}

export function moveModuleSpecOrder(document, specOrder, spec, offset) {
  const normalized = normalizeModuleSpecOrder(document, specOrder);
  if (!Number.isInteger(offset) || offset === 0) return normalized;
  const index = normalized.indexOf(spec);
  if (index < 0) throw new Error(`模板规格不存在: ${spec}`);
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= normalized.length) return normalized;
  normalized.splice(nextIndex, 0, normalized.splice(index, 1)[0]);
  return normalized;
}

export function renameModuleSpecOrder(document, specOrder, spec, newSpec) {
  const renamed = Array.isArray(specOrder)
    ? specOrder.map(item => item === spec ? newSpec : item)
    : specOrder;
  return normalizeModuleSpecOrder(document, renamed);
}

export function renameModuleSizeOrderForSpec(document, sizeOrder, spec, newSpec) {
  const renamed = Array.isArray(sizeOrder)
    ? sizeOrder.map(item => isPlainObject(item) && item.spec === spec ? { ...item, spec: newSpec } : item)
    : sizeOrder;
  return normalizeModuleSizeOrder(document, renamed);
}

export function renameModuleSizeOrderForGroup(document, sizeOrder, spec, group, newGroup) {
  const specKind = parseSpec(spec);
  const renamed = Array.isArray(sizeOrder)
    ? sizeOrder.map(item => {
      if (!isPlainObject(item) || item.spec !== spec) return item;
      if (specKind === 'modular' && item.module_type === group) return { ...item, module_type: newGroup };
      if (specKind === 'mixed' && item.module_type === '' && Array.isArray(item.sizes)) {
        return { ...item, sizes: item.sizes.map(size => size === group ? newGroup : size) };
      }
      return item;
    })
    : sizeOrder;
  return normalizeModuleSizeOrder(document, renamed);
}

export function normalizeModuleSizeOrder(document, sizeOrder) {
  const saved = new Map();
  if (Array.isArray(sizeOrder)) {
    sizeOrder.forEach(item => {
      if (!isPlainObject(item) || typeof item.spec !== 'string' || typeof item.module_type !== 'string' || !Array.isArray(item.sizes)) return;
      saved.set(`${item.spec}\n${item.module_type}`, item.sizes);
    });
  }
  return moduleSizeOrderParents(document).map(parent => {
    const available = new Set(parent.sizes);
    const sizes = [];
    (saved.get(`${parent.spec}\n${parent.module_type}`) || []).forEach(size => {
      if (typeof size === 'string' && available.has(size) && !sizes.includes(size)) sizes.push(size);
    });
    parent.sizes.forEach(size => { if (!sizes.includes(size)) sizes.push(size); });
    return { spec: parent.spec, module_type: parent.module_type, sizes };
  });
}

export function moveModuleSizeOrder(document, sizeOrder, spec, moduleType, size, offset) {
  const normalized = normalizeModuleSizeOrder(document, sizeOrder);
  if (!Number.isInteger(offset) || offset === 0) return normalized;
  const entry = normalized.find(item => item.spec === spec && item.module_type === moduleType);
  if (!entry) throw new Error(`尺寸分组不存在: ${spec}/${moduleType}`);
  const index = entry.sizes.indexOf(size);
  if (index < 0) throw new Error(`尺寸不存在: ${spec}/${moduleType}/${size}`);
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= entry.sizes.length) return normalized;
  entry.sizes.splice(nextIndex, 0, entry.sizes.splice(index, 1)[0]);
  return normalized;
}

function nextFreeVariantValue(specKind, variants) {
  const used = new Set(variants.map(value => Number(value)));
  const limit = specKind === 'modular' ? Number.MAX_SAFE_INTEGER : 99;
  let next = 1;
  while (next <= limit && used.has(next)) next += 1;
  if (next > limit) throw new Error('混合式目标序号 01-99 已用完');
  return specKind === 'modular' ? next : String(next).padStart(2, '0');
}

export function setModuleVariantCount(document, leafPath, variantCount) {
  if (!Array.isArray(leafPath) || leafPath.length < 5 || leafPath[0] !== 'modules') throw new Error('模板定义路径无效');
  if (!Number.isSafeInteger(variantCount)) throw new Error('变体数量必须是安全整数');
  if (variantCount < 1) throw new Error('变体数量至少为 1');
  const specKind = parseSpec(leafPath[1]);
  if (specKind === 'mixed' && variantCount > 99) throw new Error('混合式变体数量不能超过 99');
  const edited = cloneForEdit(document);
  const variants = resolvePath(edited, leafPath);
  if (!Array.isArray(variants) || variants.length === 0) throw new Error('模板定义路径必须指向非空变体数组');
  while (variants.length > variantCount) variants.pop();
  while (variants.length < variantCount) variants.push(nextFreeVariantValue(specKind, variants));
  return edited;
}

export function changeModuleVariantCount(document, leafPath, delta) {
  if (delta !== 1 && delta !== -1) throw new Error('变体数量每次只能增加或减少 1');
  const variants = resolvePath(document, leafPath);
  if (!Array.isArray(variants) || variants.length === 0) throw new Error('模板定义路径必须指向非空变体数组');
  return setModuleVariantCount(document, leafPath, Math.max(1, variants.length + delta));
}

function normalizeModuleDefinition(spec, fields, firstVariant) {
  const normalized = normalizeModuleTarget(spec, { ...fields, variant: firstVariant });
  const { variant, ...definitionFields } = normalized.fields;
  return { ...normalized, fields: definitionFields };
}

export function addModuleDefinition(document, spec, fields) {
  const firstVariant = parseSpec(spec) === 'modular' ? 1 : '01';
  const normalized = normalizeModuleDefinition(spec, fields, firstVariant);
  const leafPath = ['modules', spec].concat(normalized.pathParts);
  try {
    resolvePath(document, leafPath);
    throw new Error(`模板定义已存在: ${leafPath.join('/')}`);
  } catch (error) {
    if (!String(error.message || error).startsWith('路径不存在:')) throw error;
  }
  return addModuleTarget(document, spec, { ...normalized.fields, variant: firstVariant });
}

export function addModuleSize(document, spec, fields) {
  if (!isPlainObject(fields)) throw new Error('尺寸配置必须是对象');
  const specKind = parseSpec(spec);
  const size = String(fields.size ?? '').trim();
  const tree = document?.modules?.[spec];
  if (!isPlainObject(tree)) throw new Error(`模板规格不存在: ${spec}`);
  let group = size;
  if (specKind === 'modular') {
    group = String(fields.moduleType ?? '').trim();
    validateModularTree({ [group]: { [size]: {} } }, spec, `modules.${spec}`);
  } else {
    validateMixedTree({ [size]: {} }, spec, `modules.${spec}`);
  }
  const exists = specKind === 'modular'
    ? isPlainObject(tree[group]) && Object.prototype.hasOwnProperty.call(tree[group], size)
    : Object.prototype.hasOwnProperty.call(tree, size);
  if (exists) throw new Error(`尺寸 ${size} 已存在，请在对应分组中新增模板`);
  const edited = cloneForEdit(document);
  if (specKind === 'modular') {
    if (!Object.prototype.hasOwnProperty.call(edited.modules[spec], group)) edited.modules[spec][group] = {};
    edited.modules[spec][group][size] = {};
  } else {
    edited.modules[spec][size] = {};
  }
  validateDocument(edited);
  return edited;
}

export function removeModuleSize(document, spec, fields) {
  if (!isPlainObject(fields)) throw new Error('尺寸配置必须是对象');
  const specKind = parseSpec(spec);
  const size = String(fields.size ?? '').trim();
  const tree = requireModuleSpec(document, spec);
  const edited = cloneForEdit(document);
  if (specKind === 'modular') {
    const moduleType = String(fields.moduleType ?? '').trim();
    if (!isPlainObject(tree[moduleType]) || !Object.prototype.hasOwnProperty.call(tree[moduleType], size)) {
      throw new Error(`模块尺寸不存在: ${spec}/${moduleType}/${size}`);
    }
    delete edited.modules[spec][moduleType][size];
    if (Object.keys(edited.modules[spec][moduleType]).length === 0) delete edited.modules[spec][moduleType];
  } else {
    if (!Object.prototype.hasOwnProperty.call(tree, size)) throw new Error(`房间尺寸不存在: ${spec}/${size}`);
    delete edited.modules[spec][size];
  }
  if (Object.keys(edited.modules[spec]).length === 0) throw new Error('规格至少保留一个尺寸；如不再需要请删除规格');
  validateDocument(edited);
  return edited;
}

export function updateModuleDefinition(document, leafPath, fields) {
  if (!Array.isArray(leafPath) || leafPath.length < 5 || leafPath[0] !== 'modules') throw new Error('模板定义路径无效');
  const variants = resolvePath(document, leafPath);
  if (!Array.isArray(variants) || variants.length === 0) throw new Error('模板定义路径必须指向非空变体数组');
  const spec = leafPath[1];
  const normalized = normalizeModuleDefinition(spec, fields, variants[0]);
  const nextPath = ['modules', spec].concat(normalized.pathParts);
  if (leafPath.join('/') === nextPath.join('/')) return cloneForEdit(document);

  try {
    resolvePath(document, nextPath);
    throw new Error(`模板定义已存在: ${nextPath.join('/')}`);
  } catch (error) {
    if (!String(error.message || error).startsWith('路径不存在:')) throw error;
  }

  const edited = cloneForEdit(document);
  const oldParentPath = leafPath.slice(0, -1);
  const nextParentPath = nextPath.slice(0, -1);
  if (oldParentPath.join('/') === nextParentPath.join('/')) {
    const parent = resolvePath(edited, oldParentPath);
    const index = Object.keys(parent).indexOf(leafPath[leafPath.length - 1]);
    reorderObject(parent, leafPath[leafPath.length - 1], index, nextPath[nextPath.length - 1]);
    return edited;
  }

  const preservedVariants = clone(variants);
  resolvePath(edited, leafPath).splice(0);
  pruneEmptyTargetPath(edited, leafPath);
  let current = edited.modules[spec];
  normalized.pathParts.slice(0, -1).forEach(part => {
    if (!Object.prototype.hasOwnProperty.call(current, part)) current[part] = {};
    if (!isPlainObject(current[part])) throw new Error(`模板定义路径已被非对象节点占用: ${part}`);
    current = current[part];
  });
  current[normalized.pathParts[normalized.pathParts.length - 1]] = preservedVariants;
  return edited;
}

export function removeModuleDefinition(document, leafPath) {
  if (!Array.isArray(leafPath) || leafPath.length < 5 || leafPath[0] !== 'modules') throw new Error('模板定义路径无效');
  const edited = cloneForEdit(document);
  const variants = resolvePath(edited, leafPath);
  if (!Array.isArray(variants) || variants.length === 0) throw new Error('模板定义路径必须指向非空变体数组');
  variants.splice(0);
  pruneEmptyTargetPath(edited, leafPath);
  return edited;
}

export function addModuleTarget(document, spec, target) {
  if (!isPlainObject(document) || !isPlainObject(document.modules)) throw new Error('目标 JSON 必须包含 modules 对象');
  if (!Object.prototype.hasOwnProperty.call(document.modules, spec)) throw new Error(`模板规格不存在: ${spec}`);
  const normalized = normalizeModuleTarget(spec, target);
  const edited = cloneForEdit(document);
  let current = edited.modules[spec];
  if (!isPlainObject(current)) throw new Error(`模板规格必须是对象: ${spec}`);
  normalized.pathParts.slice(0, -1).forEach(part => {
    if (!Object.prototype.hasOwnProperty.call(current, part)) current[part] = {};
    if (!isPlainObject(current[part])) throw new Error(`目标路径已被非对象节点占用: ${part}`);
    current = current[part];
  });
  const leafName = normalized.pathParts[normalized.pathParts.length - 1];
  const leafParent = resolvePath(edited, ['modules', spec].concat(normalized.pathParts.slice(0, -1)));
  if (!Object.prototype.hasOwnProperty.call(leafParent, leafName)) leafParent[leafName] = [];
  const variants = leafParent[leafName];
  if (!Array.isArray(variants)) throw new Error(`目标路径已被非数组节点占用: ${leafName}`);
  const identity = `${typeof normalized.value}:${String(normalized.value)}`;
  if (variants.some(value => `${typeof value}:${String(value)}` === identity)) throw new Error(`目标已存在: ${normalized.name}`);
  variants.push(normalized.value);
  return edited;
}

function pruneEmptyTargetPath(document, leafPath) {
  const preservedSizeDepth = parseSpec(leafPath[1]) === 'modular' ? 4 : 3;
  for (let depth = leafPath.length; depth > preservedSizeDepth; depth -= 1) {
    const current = resolvePath(document, leafPath.slice(0, depth));
    const empty = Array.isArray(current) ? current.length === 0 : isPlainObject(current) && Object.keys(current).length === 0;
    if (!empty) break;
    const parent = resolvePath(document, leafPath.slice(0, depth - 1));
    delete parent[leafPath[depth - 1]];
  }
}

export function removeModuleTarget(document, path) {
  const edited = cloneForEdit(document);
  const { parent, key } = resolveParent(edited, path);
  const index = Number(key);
  if (!Array.isArray(parent) || !Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error('目标路径必须指向实际目标');
  parent.splice(index, 1);
  pruneEmptyTargetPath(edited, path.slice(0, -1));
  return edited;
}

export function updateModuleTarget(document, path, target) {
  if (!Array.isArray(path) || path.length < 6 || path[0] !== 'modules') throw new Error('目标路径无效');
  const spec = path[1];
  const normalized = normalizeModuleTarget(spec, target);
  const oldLeafPath = path.slice(0, -1);
  const newLeafPath = ['modules', spec].concat(normalized.pathParts);
  if (oldLeafPath.join('/') === newLeafPath.join('/')) {
    const edited = cloneForEdit(document);
    const variants = resolvePath(edited, oldLeafPath);
    const index = Number(path[path.length - 1]);
    if (!Array.isArray(variants) || !Number.isInteger(index) || index < 0 || index >= variants.length) throw new Error('目标路径必须指向实际目标');
    const identity = `${typeof normalized.value}:${String(normalized.value)}`;
    if (variants.some((value, valueIndex) => valueIndex !== index && `${typeof value}:${String(value)}` === identity)) throw new Error(`目标已存在: ${normalized.name}`);
    variants[index] = normalized.value;
    return edited;
  }
  const withoutOld = removeModuleTarget(document, path);
  return addModuleTarget(withoutOld, spec, normalized.fields);
}

export function getNextModuleVariant(document, path) {
  if (!Array.isArray(path) || path.length < 6 || path[0] !== 'modules') throw new Error('目标路径无效');
  const specKind = parseSpec(path[1]);
  const variants = resolvePath(document, path.slice(0, -1));
  if (!Array.isArray(variants)) throw new Error('目标路径必须指向实际目标');
  return String(nextFreeVariantValue(specKind, variants));
}

export function moveModuleTarget(document, path, offset) {
  const edited = cloneForEdit(document);
  const { parent, key } = resolveParent(edited, path);
  const index = Number(key);
  const next = index + offset;
  if (!Array.isArray(parent) || !Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error('目标路径必须指向实际目标');
  if (next < 0 || next >= parent.length) return edited;
  const [item] = parent.splice(index, 1);
  parent.splice(next, 0, item);
  return edited;
}

export function cloneDocument(document) {
  return clone(validateDocument(document));
}

function resolvePath(document, path) {
  if (!Array.isArray(path) || path.length === 0) throw new Error('路径不能为空');
  let current = document;
  path.forEach(segment => {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) throw new Error(`路径不存在: ${path.join('/')}`);
      current = current[index];
    } else if (isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`路径不存在: ${path.join('/')}`);
    }
  });
  return current;
}

function resolveParent(document, path) {
  if (!Array.isArray(path) || path.length < 1) throw new Error('路径不能为空');
  return { parent: resolvePath(document, path.slice(0, -1)), key: path[path.length - 1] };
}

function cloneForEdit(document) {
  return clone(document);
}

export { CONFIG_BUNDLE_SCHEMA, MODULES_SCHEMA };
