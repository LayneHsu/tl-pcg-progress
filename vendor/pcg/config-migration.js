import { canonicalizeModuleTargetBranch } from './modules-templates.js';
import { canonicalizeTemplateItems } from './goal-template-control.js';

const encoder = new TextEncoder();

function migrationError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function compareUtf8(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function sortedEntries(value) {
  return Object.entries(value || {}).sort(([left], [right]) => compareUtf8(left, right));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(sortedEntries(value).map(([key, item]) => [key, canonicalValue(item)]));
}

function canonicalText(value) {
  return JSON.stringify(canonicalValue(value));
}

function valuesEqual(left, right) {
  return canonicalText(left) === canonicalText(right);
}

async function sha256Text(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function assertRecord(value, code, label) {
  if (!isObject(value)) throw migrationError(code, `${label} 必须是对象`);
}

function assertName(value, code, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw migrationError(code, `${label} 必须是非空字符串`);
  }
}

function assertSize(value) {
  if (!/^[1-9]\d*x[1-9]\d*$/.test(value)) {
    throw migrationError('target-size-invalid', `目标尺寸无效: ${value}`);
  }
}

function insertLeaf(root, identity) {
  const [specId, ...segments] = identity;
  let cursor = root;
  for (const segment of [specId, ...segments.slice(0, -1)]) {
    cursor[segment] ??= {};
    cursor = cursor[segment];
  }
  const variant = segments.at(-1);
  const leafKey = specId.startsWith('mixed_') ? String(variant) : Number(variant);
  if (!Array.isArray(cursor.__variants)) cursor.__variants = [];
  if (!cursor.__variants.some(value => valuesEqual(value, leafKey))) cursor.__variants.push(leafKey);
}

function finalizeTargetTree(value) {
  if (!isObject(value)) return value;
  const result = {};
  for (const [key, child] of sortedEntries(value)) {
    if (key === '__variants') continue;
    result[key] = finalizeTargetTree(child);
  }
  if (Array.isArray(value.__variants)) {
    return [...value.__variants].sort((left, right) => compareUtf8(canonicalText(left), canonicalText(right)));
  }
  return result;
}

function collectMixedIdentities(specId, targets) {
  if (!/^mixed_u[1-9]\d*$/.test(specId)) {
    throw migrationError('module-spec-invalid', `mixed 规格无效: ${specId}`);
  }
  assertRecord(targets, 'theme-goal-incomplete', specId);
  const identities = [];
  for (const [size, roomTypes] of sortedEntries(targets)) {
    assertSize(size);
    assertRecord(roomTypes, 'theme-goal-incomplete', `${specId}.${size}`);
    for (const [roomType, categories] of sortedEntries(roomTypes)) {
      assertName(roomType, 'mixed-room-type-invalid', 'roomType');
      assertRecord(categories, 'theme-goal-incomplete', `${specId}.${size}.${roomType}`);
      for (const [ctg, variants] of sortedEntries(categories)) {
        if (!/^(?!00)\d{2}$/.test(ctg)) {
          throw migrationError('mixed-ctg-invalid', `mixed ctg 无效: ${ctg}`);
        }
        if (!Array.isArray(variants) || variants.length === 0) {
          throw migrationError('theme-goal-incomplete', `${specId}.${size}.${roomType}.${ctg} 必须有变体`);
        }
        for (const variant of variants) {
          if (typeof variant !== 'string' || !/^(?!00)\d{2}$/.test(variant)) {
            throw migrationError('mixed-variant-invalid', `mixed variant 无效: ${variant}`);
          }
          identities.push([specId, size, roomType, ctg, variant]);
        }
      }
    }
  }
  return identities;
}

function collectModularIdentities(specId, targets) {
  if (!/^modular_m[1-9]\d*_u[1-9]\d*_r[1-9]\d*$/.test(specId)) {
    throw migrationError('module-spec-invalid', `modular 规格无效: ${specId}`);
  }
  assertRecord(targets, 'theme-goal-incomplete', specId);
  const identities = [];
  for (const [moduleType, sizes] of sortedEntries(targets)) {
    assertName(moduleType, 'modular-module-type-invalid', 'moduleType');
    assertRecord(sizes, 'theme-goal-incomplete', `${specId}.${moduleType}`);
    for (const [size, areaLevels] of sortedEntries(sizes)) {
      assertSize(size);
      assertRecord(areaLevels, 'theme-goal-incomplete', `${specId}.${moduleType}.${size}`);
      for (const [areaLevel, openings] of sortedEntries(areaLevels)) {
        assertName(areaLevel, 'modular-area-level-invalid', 'areaLevel');
        assertRecord(openings, 'theme-goal-incomplete', `${specId}.${moduleType}.${size}.${areaLevel}`);
        for (const [opening, variants] of sortedEntries(openings)) {
          if (!/^(0|[1-9]\d*)$/.test(opening)) {
            throw migrationError('modular-opening-invalid', `modular opening 无效: ${opening}`);
          }
          if (!Array.isArray(variants) || variants.length === 0) {
            throw migrationError('theme-goal-incomplete', `${specId}.${moduleType}.${size}.${areaLevel}.${opening} 必须有变体`);
          }
          for (const variant of variants) {
            if (!Number.isSafeInteger(variant) || variant < 1) {
              throw migrationError('modular-variant-invalid', `modular variant 无效: ${variant}`);
            }
            identities.push([specId, moduleType, size, areaLevel, opening, variant]);
          }
        }
      }
    }
  }
  return identities;
}

function collectIdentities(specs) {
  assertRecord(specs, 'theme-goal-incomplete', 'specs');
  const identities = [];
  for (const [specId, targets] of sortedEntries(specs)) {
    if (specId.startsWith('mixed_')) identities.push(...collectMixedIdentities(specId, targets));
    else if (specId.startsWith('modular_')) identities.push(...collectModularIdentities(specId, targets));
    else throw migrationError('module-spec-invalid', `未知模块规格: ${specId}`);
  }
  const unique = new Map();
  for (const identity of identities) unique.set(canonicalText(identity), identity);
  return [...unique.values()].sort((left, right) => compareUtf8(canonicalText(left), canonicalText(right)));
}

function normalizeThemeGoalRecords(themeGoals) {
  if (Array.isArray(themeGoals)) return themeGoals.map(clone);
  if (isObject(themeGoals)) {
    return sortedEntries(themeGoals).map(([themeId, value]) => ({ theme_id: themeId, ...clone(value) }));
  }
  throw migrationError('theme-goal-incomplete', 'themeGoals 必须是数组或对象');
}

export function canonicalizeSchema3Targets(themeGoals) {
  const records = normalizeThemeGoalRecords(themeGoals)
    .sort((left, right) => compareUtf8(left.theme_id, right.theme_id));
  const seenThemes = new Set();
  const themeIdentityMap = new Map();
  const unionIdentityMap = new Map();
  const emptySpecs = new Map();

  for (const record of records) {
    assertName(record.theme_id, 'theme-id-invalid', 'theme_id');
    if (seenThemes.has(record.theme_id)) {
      throw migrationError('config-duplicate-theme', `主题重复: ${record.theme_id}`);
    }
    seenThemes.add(record.theme_id);
    const specs = record.specs;
    if (!isObject(specs) || Object.keys(specs).length === 0) {
      throw migrationError('theme-goal-incomplete', `${record.theme_id} 缺少规格目标`);
    }
    const identities = collectIdentities(specs);
    if (record.target_intent === 'defined' && identities.length === 0) {
      throw migrationError('theme-goal-incomplete', `${record.theme_id} 的 defined 目标不能为空`);
    }
    if (record.target_intent === 'explicit_empty') {
      if (identities.length !== 0) {
        throw migrationError('theme-goal-incomplete', `${record.theme_id} 的 explicit_empty 不能包含目标`);
      }
      emptySpecs.set(record.theme_id, Object.keys(specs).sort(compareUtf8));
    } else if (record.target_intent !== 'defined') {
      throw migrationError('theme-goal-incomplete', `${record.theme_id} 缺少 target_intent`);
    }
    themeIdentityMap.set(record.theme_id, identities);
    for (const identity of identities) unionIdentityMap.set(canonicalText(identity), identity);
  }

  const themeModules = {};
  for (const themeId of [...themeIdentityMap.keys()].sort(compareUtf8)) {
    const tree = {};
    for (const specId of emptySpecs.get(themeId) || []) tree[specId] = {};
    for (const identity of themeIdentityMap.get(themeId)) insertLeaf(tree, identity);
    themeModules[themeId] = finalizeTargetTree(tree);
  }
  const modulesTree = {};
  for (const identity of [...unionIdentityMap.values()]
    .sort((left, right) => compareUtf8(canonicalText(left), canonicalText(right)))) {
    insertLeaf(modulesTree, identity);
  }
  return canonicalValue({ modules: finalizeTargetTree(modulesTree), theme_modules: themeModules });
}

function validStableId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

async function buildStableIdMapping(sources, hashCanonical) {
  const records = (Array.isArray(sources) ? sources : []).map(clone).sort((left, right) => (
    compareUtf8(left.source_kind, right.source_kind) || compareUtf8(left.source_key, right.source_key)
  ));
  const usedIds = new Set(records.filter(item => validStableId(item.stable_id)).map(item => item.stable_id));
  const generatedContentById = new Map();
  for (const record of records) {
    if (!validStableId(record.stable_id) || generatedContentById.has(record.stable_id)) continue;
    generatedContentById.set(record.stable_id, canonicalText(record.content));
  }
  const result = [];
  for (const record of records) {
    assertName(record.source_kind, 'migration-source-invalid', 'source_kind');
    assertName(record.source_key, 'migration-source-invalid', 'source_key');
    let stableId = record.stable_id;
    if (!validStableId(stableId)) {
      const contentText = canonicalText(record.content);
      const digest = await hashCanonical(contentText);
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw migrationError('migration-hash-invalid', 'hashCanonical 必须返回 64 位小写 SHA-256');
      }
      const baseId = `goal-${digest.slice(0, 16)}`;
      stableId = baseId;
      let suffix = 2;
      while (usedIds.has(stableId) && generatedContentById.get(stableId) !== contentText) {
        stableId = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(stableId);
      generatedContentById.set(stableId, contentText);
    }
    result.push({
      source_kind: record.source_kind,
      source_key: record.source_key,
      stable_id: stableId,
    });
  }
  return result;
}

function findExistingStableIdConflicts(sources) {
  const records = (Array.isArray(sources) ? sources : []).filter(item => validStableId(item?.stable_id))
    .map(clone).sort((left, right) => (
      compareUtf8(left.source_kind, right.source_kind) || compareUtf8(left.source_key, right.source_key)
    ));
  const firstById = new Map();
  const conflicts = [];
  for (const record of records) {
    const content = canonicalValue(record.content);
    const first = firstById.get(record.stable_id);
    if (!first) {
      firstById.set(record.stable_id, content);
      continue;
    }
    if (!valuesEqual(first, content)) {
      conflicts.push({
        code: 'goal-template-id-conflict',
        path: `/goal_templates/${pointerEscape(record.stable_id)}`,
        base: clone(first),
        local: clone(content),
        remote: null,
        resolution: 'unresolved',
      });
    }
  }
  return conflicts;
}

function pointerEscape(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function getManagedEntries(themeConfig) {
  const entries = new Map();
  for (const profile of ['freeform', 'mixed', 'modular']) {
    for (const [themeId, value] of sortedEntries(themeConfig?.Theme_Registry?.[profile])) {
      entries.set(`/Theme_Registry/${profile}/${pointerEscape(themeId)}`, clone(value));
    }
    for (const [themeId, value] of sortedEntries(themeConfig?.Mode_Configs?.[profile]?.themes)) {
      entries.set(`/Mode_Configs/${profile}/themes/${pointerEscape(themeId)}`, clone(value));
    }
  }
  return entries;
}

function chooseManagedValue(path, base, local, remote, conflicts) {
  const localChanged = !valuesEqual(local, base);
  const remoteChanged = !valuesEqual(remote, base);
  if (localChanged && remoteChanged && !valuesEqual(local, remote)) {
    conflicts.push({
      code: 'managed-theme-config-conflict',
      path,
      base: clone(base),
      local: clone(local),
      remote: clone(remote),
      resolution: 'unresolved',
    });
    return local;
  }
  if (localChanged) return local;
  if (remoteChanged) return remote;
  return base;
}

function buildFormatMembership(themeConfig) {
  if (!Array.isArray(themeConfig?.Format_Rules)) return [];
  return themeConfig.Format_Rules.map(rule => ({
    format: typeof rule?.format === 'string' ? rule.format : '',
    theme_ids: [...new Set(Array.isArray(rule?.themes)
      ? rule.themes.filter(themeId => typeof themeId === 'string' && themeId !== '')
      : [])],
  })).filter(item => item.format !== '');
}

function buildManagedPatch(baseConfig, localConfig, remoteConfig, conflicts) {
  const baseEntries = getManagedEntries(baseConfig);
  const localEntries = getManagedEntries(localConfig);
  const remoteEntries = getManagedEntries(remoteConfig);
  const paths = [...new Set([...baseEntries.keys(), ...localEntries.keys(), ...remoteEntries.keys()])]
    .sort(compareUtf8);
  const upserts = [];
  const deletes = [];
  const managedKeyDiff = [];
  for (const path of paths) {
    const base = baseEntries.get(path);
    const local = localEntries.get(path);
    const remote = remoteEntries.get(path);
    const desired = chooseManagedValue(path, base, local, remote, conflicts);
    if (valuesEqual(desired, base)) continue;
    if (desired === undefined) deletes.push(path);
    else upserts.push({ path, value: canonicalValue(desired) });
    managedKeyDiff.push({
      path,
      before: canonicalValue(base),
      after: canonicalValue(desired),
      source: !valuesEqual(local, base) ? 'local' : 'remote',
    });
  }

  const baseMembership = buildFormatMembership(baseConfig);
  const localMembership = localConfig?.Format_Rules === undefined
    ? baseMembership : buildFormatMembership(localConfig);
  const remoteMembership = remoteConfig?.Format_Rules === undefined
    ? baseMembership : buildFormatMembership(remoteConfig);
  const formatRuleMembership = chooseManagedValue(
    '/Format_Rules',
    baseMembership,
    localMembership,
    remoteMembership,
    conflicts,
  );
  if (!valuesEqual(formatRuleMembership, baseMembership)) {
    managedKeyDiff.push({
      path: '/Format_Rules',
      before: baseMembership,
      after: clone(formatRuleMembership),
      source: !valuesEqual(localMembership, baseMembership) ? 'local' : 'remote',
    });
  }
  managedKeyDiff.sort((left, right) => compareUtf8(left.path, right.path));
  return {
    patch: {
      upserts,
      deletes,
      format_rule_membership: formatRuleMembership,
    },
    managedKeyDiff,
  };
}

function isAbsolutePath(value) {
  if (typeof value !== 'string') return false;
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith('/');
}

function withoutRuntimeNoise(value, field = '', preserveBusinessPaths = false) {
  if (Array.isArray(value)) {
    return value
      .filter(item => preserveBusinessPaths || !isAbsolutePath(item) || field === 'deletes')
      .map(item => withoutRuntimeNoise(item, field, preserveBusinessPaths));
  }
  if (!isObject(value)) return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const childPreservesBusinessPaths = preserveBusinessPaths || key === 'migration_documents' ||
      key === 'expected_ready_bundle' || key === 'managed_key_diff' || key === 'conflicts';
    const isManagedJsonPointer = key === 'path' && (
      Object.hasOwn(value, 'code') || Object.hasOwn(value, 'source') || Object.hasOwn(value, 'value')
    );
    if (key === 'report_fingerprint' || key === 'run_id' || key === 'migration_run_id' ||
        /timestamp/i.test(key) || /_at$/.test(key) ||
        (isAbsolutePath(item) && !isManagedJsonPointer && !childPreservesBusinessPaths)) continue;
    result[key] = withoutRuntimeNoise(item, key, childPreservesBusinessPaths);
  }
  return result;
}

export async function fingerprintMigrationReport(report) {
  assertRecord(report, 'migration-report-invalid', 'report');
  return `sha256:${await sha256Text(canonicalText(withoutRuntimeNoise(report)))}`;
}

function sortConflicts(conflicts) {
  return conflicts.sort((left, right) => (
    compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code)
  ));
}

function normalizeMigrationTemplateSpecs(source) {
  const specs = source?.content?.specs;
  assertRecord(specs, 'goal-template-source-invalid', 'goal_template_sources[].content.specs');
  if (Object.keys(specs).length === 0) {
    throw migrationError('goal-template-source-invalid', '目标模板源必须包含至少一个规格分支');
  }
  const normalized = {};
  for (const [selectedSpecId, rawBranch] of sortedEntries(specs)) {
    assertName(selectedSpecId, 'goal-template-source-invalid', 'selected_spec_id');
    if (isObject(rawBranch) && Object.hasOwn(rawBranch, 'module_spec_id')) {
      const moduleSpecId = rawBranch.module_spec_id;
      const targetIntent = rawBranch.target_intent ?? 'defined';
      assertName(moduleSpecId, 'goal-template-source-invalid', 'module_spec_id');
      normalized[selectedSpecId] = {
        module_spec_id: moduleSpecId,
        target_intent: targetIntent,
        targets: canonicalizeModuleTargetBranch(moduleSpecId, rawBranch.targets, targetIntent),
      };
      if (Object.hasOwn(rawBranch, 'template_items')) {
        normalized[selectedSpecId].template_items = canonicalizeTemplateItems(
          rawBranch.template_items, moduleSpecId,
        );
      }
    } else {
      normalized[selectedSpecId] = canonicalizeModuleTargetBranch(selectedSpecId, rawBranch, 'defined');
    }
  }
  return canonicalValue(normalized);
}

function projectionConflict(code, path, local) {
  return {
    code,
    path,
    base: null,
    local: clone(local),
    remote: null,
    resolution: 'unresolved',
  };
}

function buildTemplateMigrationDocuments(sources, stableIdMapping, conflicts) {
  const mappingBySource = new Map(stableIdMapping.map(item => [
    canonicalText([item.source_kind, item.source_key]), item.stable_id,
  ]));
  const documentsByPath = new Map();
  const sortedSources = (Array.isArray(sources) ? sources : []).map(clone).sort((left, right) => (
    compareUtf8(left.source_kind, right.source_kind) || compareUtf8(left.source_key, right.source_key)
  ));
  for (const source of sortedSources) {
    const sourcePointer = `/goal_template_sources/${pointerEscape(source.source_kind || '')}/${pointerEscape(source.source_key || '')}`;
    try {
      assertName(source?.content?.display_name, 'goal-template-source-invalid', 'display_name');
      const stableId = mappingBySource.get(canonicalText([source.source_kind, source.source_key]));
      assertName(stableId, 'goal-template-source-invalid', 'template_id');
      const path = `pcgModuleGoalTemplates/${stableId}`;
      const value = canonicalValue({
        template_id: stableId,
        display_name: source.content.display_name.trim(),
        status: 'active',
        template_revision: 1,
        specs: normalizeMigrationTemplateSpecs(source),
      });
      const existing = documentsByPath.get(path);
      if (existing && canonicalText(existing) !== canonicalText(value)) {
        conflicts.push(projectionConflict('goal-template-id-conflict', sourcePointer, source));
      } else if (!existing) {
        documentsByPath.set(path, value);
      }
    } catch (error) {
      conflicts.push(projectionConflict(error?.code || 'goal-template-source-invalid', sourcePointer, source));
    }
  }
  return documentsByPath;
}

function buildMigrationDocuments(input, stableIdMapping, validThemeGoals, expectedReadyBundle, conflicts) {
  const documentsByPath = buildTemplateMigrationDocuments(
    input.goal_template_sources, stableIdMapping, conflicts,
  );
  for (const goal of validThemeGoals) {
    const [selectedSpecId] = Object.keys(goal.specs);
    const targets = expectedReadyBundle.module_templates.theme_modules[goal.theme_id][selectedSpecId];
    const themeDocument = {
      theme_id: goal.theme_id,
      association_state: 'unlinked',
      template_id: null,
      selected_spec_id: selectedSpecId,
      module_spec_id: selectedSpecId,
      target_intent: goal.target_intent,
      targets,
      draft_revision: 1,
      effective_revision: 1,
    };
    if (Array.isArray(goal.template_items)) themeDocument.template_items = clone(goal.template_items);
    else if (isObject(goal.template_items)) themeDocument.template_items = clone(goal.template_items[selectedSpecId]);
    documentsByPath.set(`pcgModuleThemeGoals/${goal.theme_id}`, canonicalValue(themeDocument));
  }
  const writerEpoch = Number.isSafeInteger(input.writer_epoch) && input.writer_epoch >= 0
    ? input.writer_epoch : 0;
  documentsByPath.set('pcgModuleControl/current', canonicalValue({
    control_revision: expectedReadyBundle.source_control_revision,
    status: 'current',
    managed_theme_config_patch: expectedReadyBundle.managed_theme_config_patch,
    conflicts: sortConflicts(conflicts.map(clone)),
    writer_state: 'legacy_enabled',
    writer_epoch: writerEpoch,
  }));
  documentsByPath.set(
    `pcgModuleReadyConfigs/${expectedReadyBundle.bundle_id}`,
    canonicalValue(expectedReadyBundle),
  );
  documentsByPath.set('pcgModulesConfig/current', canonicalValue({
    status: 'ready',
    source_control_revision: expectedReadyBundle.source_control_revision,
    bundle_id: expectedReadyBundle.bundle_id,
    sync_revision: expectedReadyBundle.sync_revision,
    error_code: null,
    pending_theme_ids: expectedReadyBundle.pending_theme_ids,
  }));
  return [...documentsByPath.entries()]
    .map(([path, value]) => ({ path, value }))
    .sort((left, right) => compareUtf8(left.path, right.path));
}

export async function buildConfigMigrationDryRun(input, options = {}) {
  assertRecord(input, 'migration-input-invalid', 'input');
  const hashCanonical = typeof options.hashCanonical === 'function'
    ? options.hashCanonical
    : sha256Text;
  const stableIdMapping = await buildStableIdMapping(input.goal_template_sources, hashCanonical);
  const conflicts = findExistingStableIdConflicts(input.goal_template_sources);
  const pendingThemeIds = [];
  const validThemeGoals = [];
  const rawGoals = normalizeThemeGoalRecords(input.theme_goals || []);
  const seenThemes = new Set();
  for (const goal of rawGoals.sort((left, right) => compareUtf8(left.theme_id, right.theme_id))) {
    if (seenThemes.has(goal.theme_id)) {
      conflicts.push({
        code: 'config-duplicate-theme',
        path: `/theme_modules/${pointerEscape(goal.theme_id)}`,
        base: null,
        local: clone(goal),
        remote: null,
        resolution: 'unresolved',
      });
      pendingThemeIds.push(goal.theme_id);
      continue;
    }
    seenThemes.add(goal.theme_id);
    try {
      canonicalizeSchema3Targets([goal]);
      if (Object.keys(goal.specs || {}).length !== 1) {
        throw migrationError('theme-goal-multiple-specs', `${goal.theme_id} 必须只有一个规格分支`);
      }
      validThemeGoals.push(goal);
    } catch (error) {
      pendingThemeIds.push(goal.theme_id);
      if (error.code !== 'theme-goal-incomplete') {
        conflicts.push({
          code: error.code || 'theme-goal-invalid',
          path: `/theme_modules/${pointerEscape(goal.theme_id)}`,
          base: null,
          local: clone(goal),
          remote: null,
          resolution: 'unresolved',
        });
      }
    }
  }
  const canonicalTargets = canonicalizeSchema3Targets(validThemeGoals);

  const baseThemeConfig = input.legacy_ready_bundle?.theme_config || {};
  const localThemeConfig = input.local_theme_config || baseThemeConfig;
  const remoteThemeConfig = input.remote_theme_config || baseThemeConfig;
  const { patch, managedKeyDiff } = buildManagedPatch(
    baseThemeConfig,
    localThemeConfig,
    remoteThemeConfig,
    conflicts,
  );
  const sourceFingerprints = canonicalValue(input.source_fingerprints || {});
  const controlRevision = Number.isSafeInteger(input.control_revision) && input.control_revision >= 0
    ? input.control_revision : 0;
  const syncRevision = Number.isSafeInteger(input.sync_revision) && input.sync_revision >= 0
    ? input.sync_revision : 0;
  const sortedPendingThemeIds = [...new Set(pendingThemeIds)].sort(compareUtf8);
  const expectedReadyBundle = canonicalValue({
    schema: 'pcg-module-ready-config',
    schema_version: 1,
    bundle_id: `control-r${controlRevision}`,
    source_control_revision: controlRevision,
    sync_revision: syncRevision,
    pending_theme_ids: sortedPendingThemeIds,
    managed_theme_config_patch: patch,
    module_templates: {
      schema: 'pcg-modules-templates',
      schema_version: 3,
      modules: canonicalTargets.modules,
      theme_modules: canonicalTargets.theme_modules,
    },
  });
  const themeTemplateItems = {};
  for (const goal of validThemeGoals) {
    const [selectedSpecId] = Object.keys(goal.specs);
    const items = Array.isArray(goal.template_items)
      ? goal.template_items
      : (isObject(goal.template_items) ? goal.template_items[selectedSpecId] : undefined);
    if (items !== undefined) {
      themeTemplateItems[goal.theme_id] = { [selectedSpecId]: clone(items) };
    }
  }
  if (Object.keys(themeTemplateItems).length > 0) {
    expectedReadyBundle.theme_template_items = canonicalValue(themeTemplateItems);
  }
  const migrationDocuments = buildMigrationDocuments(
    input, stableIdMapping, validThemeGoals, expectedReadyBundle, conflicts,
  );
  const sortedConflictList = sortConflicts(conflicts);
  const report = canonicalValue({
    schema_version: 1,
    source_fingerprints: sourceFingerprints,
    stable_id_mapping: stableIdMapping,
    migration_documents: migrationDocuments,
    managed_key_diff: managedKeyDiff,
    conflicts: sortedConflictList,
    pending_theme_ids: sortedPendingThemeIds,
    expected_ready_bundle: expectedReadyBundle,
    writer_cutover_eligible: sortedConflictList.length === 0 && validThemeGoals.length > 0,
  });
  const reportFingerprint = await fingerprintMigrationReport(report);
  return canonicalValue({ ...report, report_fingerprint: reportFingerprint });
}
