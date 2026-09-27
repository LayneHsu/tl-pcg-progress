import {
  canonicalizeModuleTargetBranch,
  canonicalJsonText,
  getModuleSpecFields,
} from './modules-templates.js';

const ACTIVE = 'active';
const LINKED = 'linked_synced';
const UNLINKED = 'unlinked';
const TEMPLATE_EXPORT_SCHEMA_VERSION = 1;
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TEMPLATE_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TEMPLATE_IMPORT_FIELDS = new Set([
  'schema_version', 'template_id', 'display_name', 'status', 'template_revision', 'specs',
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equal(left, right) {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function sortedUnique(values) {
  return [...new Set(values || [])].sort();
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validName(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function canonicalValue(value, label) {
  const text = canonicalJsonText(value);
  if (text === undefined || text === 'undefined') throw new Error(`${label} 必须是 JSON 值`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 必须是 JSON 值: ${String(error?.message || error)}`);
  }
}

export function canonicalizeTemplateItems(items, moduleSpecId) {
  if (!Array.isArray(items)) throw new Error('模板项目录必须是数组');
  if (!validName(moduleSpecId)) throw new Error('模板项 module_spec_id 必须是非空字符串');
  const seenIds = new Set();
  return items.map((item, index) => {
    if (!isObject(item)) throw new Error(`模板项 ${index} 必须是对象`);
    const itemId = String(item.item_id ?? '').trim();
    if (!TEMPLATE_ITEM_ID_RE.test(itemId)) throw new Error(`模板项 ${index} 的 item_id 无效`);
    if (seenIds.has(itemId)) throw new Error(`模板项 item_id 重复: ${itemId}`);
    seenIds.add(itemId);
    if (!validName(item.display_name)) throw new Error(`模板项 ${itemId} 的 display_name 无效`);
    const properties = item.properties === undefined ? {} : item.properties;
    if (!isObject(properties)) throw new Error(`模板项 ${itemId} 的 properties 必须是对象`);
    const expectedCount = Number(item.expected_count);
    if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
      throw new Error(`模板项 ${itemId} 的 expected_count 必须是正整数`);
    }
    if (!Array.isArray(item.target_refs) || item.target_refs.length === 0) {
      throw new Error(`模板项 ${itemId} 的 target_refs 不能为空`);
    }
    const refs = item.target_refs.map((ref, refIndex) => {
      if (!isObject(ref)) throw new Error(`模板项 ${itemId} 的 target_refs[${refIndex}] 必须是对象`);
      if (ref.spec_id !== undefined && ref.spec_id !== moduleSpecId) {
        throw new Error(`模板项 ${itemId} 的 target_refs 规格不匹配`);
      }
      return canonicalValue(ref, `模板项 ${itemId} 的 target_refs[${refIndex}]`);
    });
    const refKeys = refs.map(canonicalJsonText);
    if (new Set(refKeys).size !== refKeys.length) throw new Error(`模板项 ${itemId} 的 target_refs 重复`);
    if (expectedCount !== refs.length) {
      throw new Error(`模板项 ${itemId} 的 expected_count 必须等于 target_refs 数量`);
    }
    return {
      item_id: itemId,
      display_name: item.display_name.trim(),
      properties: canonicalValue(properties, `模板项 ${itemId} 的 properties`),
      expected_count: expectedCount,
      target_refs: refs.sort((left, right) => canonicalJsonText(left).localeCompare(canonicalJsonText(right))),
    };
  });
}

function errorResult(code, extra = {}) {
  return { code, ...extra };
}

function controlConflict(expected, actual) {
  return !isObject(expected) || expected.control_revision !== actual.control_revision;
}

function templateConflict(expected, template) {
  return !template || !isObject(expected) || expected.template_revision !== template.template_revision;
}

function themeRevisionConflict(expected, themeIds, themeGoals) {
  if (themeIds.length === 0) return false;
  if (!isObject(expected?.theme_revisions)) return true;
  return themeIds.some(themeId => {
    const theme = themeGoals[themeId];
    const revision = expected.theme_revisions[themeId];
    return !theme || !revision || revision.draft_revision !== theme.draft_revision
      || revision.effective_revision !== theme.effective_revision;
  });
}

function nextControlHead(controlHead) {
  return {
    ...clone(controlHead),
    control_revision: controlHead.control_revision + 1,
    status: 'materializing',
  };
}

function makeConflictDraft(base, local, remote) {
  return { status: 'conflict', base: clone(base), local: clone(local), remote: clone(remote) };
}

function branchRecord(selectedSpecId, value) {
  if (isObject(value) && Object.prototype.hasOwnProperty.call(value, 'module_spec_id')) {
    const moduleSpecId = value.module_spec_id;
    const targetIntent = value.target_intent ?? 'defined';
    const branch = {
      selected_spec_id: selectedSpecId,
      module_spec_id: moduleSpecId,
      target_intent: targetIntent,
      targets: canonicalizeModuleTargetBranch(moduleSpecId, value.targets, targetIntent),
      wrapped: true,
    };
    if (Object.prototype.hasOwnProperty.call(value, 'template_items')) {
      branch.template_items = canonicalizeTemplateItems(value.template_items, moduleSpecId);
    }
    return branch;
  }
  return {
    selected_spec_id: selectedSpecId,
    module_spec_id: selectedSpecId,
    target_intent: 'defined',
    targets: canonicalizeModuleTargetBranch(selectedSpecId, value, 'defined'),
    wrapped: false,
  };
}

function templateBranches(template) {
  if (!isObject(template?.specs) || Object.keys(template.specs).length === 0) {
    throw new Error('模板必须包含至少一个规格分支');
  }
  return Object.fromEntries(Object.entries(template.specs).map(([selectedSpecId, value]) => {
    if (!validName(selectedSpecId)) throw new Error('selected_spec_id 必须是非空字符串');
    return [selectedSpecId, branchRecord(selectedSpecId, value)];
  }));
}

function branchFor(template, selectedSpecId) {
  return templateBranches(template)[selectedSpecId] || null;
}

function branchStorage(branch, forceWrapped = false) {
  const hasTemplateItems = branch.template_items !== undefined;
  if (!forceWrapped && !hasTemplateItems && branch.selected_spec_id === branch.module_spec_id
    && branch.target_intent === 'defined') {
    return clone(branch.targets);
  }
  const result = {
    module_spec_id: branch.module_spec_id,
    target_intent: branch.target_intent,
    targets: clone(branch.targets),
  };
  if (hasTemplateItems) result.template_items = clone(branch.template_items);
  return result;
}

function normalizeSpecsForStorage(specs) {
  if (!isObject(specs) || Object.keys(specs).length === 0) throw new Error('模板必须包含至少一个规格分支');
  const result = {};
  for (const [selectedSpecId, value] of Object.entries(specs)) {
    const branch = branchRecord(selectedSpecId, value);
    result[selectedSpecId] = branchStorage(branch, branch.wrapped);
  }
  return result;
}

function normalizeSubmittedBranch(command, fallbackModuleSpecId = null) {
  const selectedSpecId = command.selected_spec_id;
  const moduleSpecId = command.module_spec_id || fallbackModuleSpecId || selectedSpecId;
  const targetIntent = command.target_intent ?? 'defined';
  if (targetIntent === 'explicit_empty' && command.explicit_empty_confirmed !== true) {
    return errorResult('explicit-empty-confirmation-required');
  }
  try {
    const result = {
      selected_spec_id: selectedSpecId,
      module_spec_id: moduleSpecId,
      target_intent: targetIntent,
      targets: canonicalizeModuleTargetBranch(moduleSpecId, command.targets, targetIntent),
    };
    if (Object.prototype.hasOwnProperty.call(command, 'template_items')) {
      result.template_items = canonicalizeTemplateItems(command.template_items, moduleSpecId);
    }
    return result;
  } catch (error) {
    const message = String(error?.message || error);
    if (targetIntent === 'defined' && (message.includes('不能为空') || message.includes('至少一个合法叶子'))) {
      return errorResult('theme-goal-incomplete');
    }
    return errorResult('theme-goal-invalid', { message });
  }
}

function themeBusinessValue(theme) {
  const value = {
    module_spec_id: theme.module_spec_id || theme.selected_spec_id,
    target_intent: theme.target_intent,
    targets: theme.targets,
  };
  if (Object.prototype.hasOwnProperty.call(theme, 'template_items')) value.template_items = theme.template_items;
  return value;
}

function branchBusinessValue(branch) {
  const value = {
    module_spec_id: branch.module_spec_id,
    target_intent: branch.target_intent,
    targets: branch.targets,
  };
  if (Object.prototype.hasOwnProperty.call(branch, 'template_items')) value.template_items = branch.template_items;
  return value;
}

function targetBusinessValue(value) {
  return {
    module_spec_id: value.module_spec_id || value.selected_spec_id,
    target_intent: value.target_intent,
    targets: value.targets,
  };
}

function linkedMemberIds(themeGoals, templateId, selectedSpecId = null) {
  return Object.values(themeGoals)
    .filter(theme => theme.association_state === LINKED && theme.template_id === templateId
      && (selectedSpecId === null || theme.selected_spec_id === selectedSpecId))
    .map(theme => theme.theme_id)
    .sort();
}

function checkMemberSet(expected, actualIds) {
  return equal(sortedUnique(expected?.member_theme_ids), sortedUnique(actualIds));
}

function capacityError(adapter, requiredWrites) {
  const maxWrites = Number.isSafeInteger(adapter.max_atomic_writes) ? adapter.max_atomic_writes : 500;
  if (requiredWrites <= maxWrites) return null;
  return errorResult('goal-template-atomic-write-limit', {
    required_writes: requiredWrites,
    max_atomic_writes: maxWrites,
  });
}

function normalizedRoomSize(value) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Room_Sizes 项必须包含两个尺寸');
  const dimensions = value.map(Number);
  if (dimensions.some(item => !Number.isSafeInteger(item) || item <= 0)) {
    throw new Error('Room_Sizes 尺寸必须是正整数');
  }
  return `${Math.min(...dimensions)}x${Math.max(...dimensions)}`;
}

export function buildThemeCompatibilityContext(themeConfig, themeId) {
  if (!isObject(themeConfig) || !validName(themeId)) throw new Error('Theme Config 或主题 ID 无效');
  const profiles = ['mixed', 'modular'].filter(profile => (
    isObject(themeConfig.Theme_Registry?.[profile]?.[themeId])
  ));
  if (profiles.length !== 1) throw new Error(`主题 ${themeId} 的 profile 无法唯一确定`);
  const [profile] = profiles;
  const mode = themeConfig.Mode_Configs?.[profile]?.themes?.[themeId];
  if (!isObject(mode)) throw new Error(`主题 ${themeId} 缺少 Mode_Configs`);
  const context = { profile, Unit_Size: Number(mode.Unit_Size) };
  if (profile === 'modular') {
    context.Tile_Size = Number(mode.Tile_Size);
    context.Road_Width = Number(mode.Road_Width);
    return context;
  }
  const roomSizeValues = Array.isArray(mode.Room_Sizes)
    ? mode.Room_Sizes
    : Object.values(mode.Room_Sizes || {});
  context.Room_Sizes = sortedUnique(roomSizeValues.map(normalizedRoomSize));
  const roomTypes = new Set();
  for (const rule of themeConfig.Format_Rules || []) {
    if (!Array.isArray(rule?.themes) || !rule.themes.includes(themeId)
      || !Array.isArray(rule.types) || !rule.types.includes('Room')) continue;
    const format = themeConfig.Asset_Name_Formats?.[rule.format];
    for (const step of format?.post_parse || []) {
      if (step?.hook !== 'map_string_to_id') continue;
      const inlineValues = step.values || step.args?.values;
      if (Array.isArray(inlineValues)) inlineValues.forEach(value => roomTypes.add(String(value)));
      const mapKey = step.args?.map_key;
      const mappedValues = mapKey ? themeConfig.Asset_Name_Maps?.[mapKey]?.[themeId] : null;
      if (Array.isArray(mappedValues)) mappedValues.forEach(value => roomTypes.add(String(value)));
    }
  }
  context.room_types = [...roomTypes].sort();
  return context;
}

function compatibleBranch(branch, context) {
  if (!isObject(context)) return false;
  let spec;
  try {
    spec = getModuleSpecFields(branch.module_spec_id);
  } catch {
    return false;
  }
  if (context.profile !== spec.specKind || Number(context.Unit_Size) !== spec.unitSize) return false;
  if (spec.specKind === 'modular') {
    return Number(context.Tile_Size) === spec.tileSize && Number(context.Road_Width) === spec.roadWidth;
  }
  const allowedSizes = new Set((context.Room_Sizes || []).map(String));
  const allowedRoomTypes = new Set((context.room_types || []).map(String));
  for (const [size, roomTypes] of Object.entries(branch.targets)) {
    if (!allowedSizes.has(size)) return false;
    for (const roomType of Object.keys(roomTypes)) if (!allowedRoomTypes.has(roomType)) return false;
  }
  return true;
}

function validateTemplateIdentity(template) {
  if (!isObject(template) || !STABLE_ID_RE.test(template.template_id || '') || !validName(template.display_name)) {
    throw new Error('模板身份无效');
  }
  if (template.status !== ACTIVE) throw new Error('模板状态必须是 active');
  return normalizeSpecsForStorage(template.specs);
}

function exportedTemplate(template) {
  return {
    schema_version: TEMPLATE_EXPORT_SCHEMA_VERSION,
    template_id: template.template_id,
    display_name: template.display_name,
    status: template.status,
    template_revision: template.template_revision,
    specs: clone(template.specs),
  };
}

function templateCanonicalContent(template) {
  const exported = exportedTemplate(template);
  delete exported.template_revision;
  delete exported.schema_version;
  return exported;
}

function createTemplateDocument(templateId, displayName, specs) {
  if (!STABLE_ID_RE.test(templateId || '') || !validName(displayName)) throw new Error('模板身份无效');
  return {
    template_id: templateId,
    display_name: displayName.trim(),
    status: ACTIVE,
    template_revision: 1,
    specs: normalizeSpecsForStorage(specs),
  };
}

function generateUniqueId(idGenerator, templates) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = idGenerator();
    if (!STABLE_ID_RE.test(value || '')) throw new Error('ID 生成器返回了非法稳定 ID');
    if (!templates[value]) return value;
  }
  throw new Error('无法生成未占用的稳定模板 ID');
}

async function readState(tx) {
  return {
    goalTemplates: await tx.listGoalTemplates(),
    themeGoals: await tx.listThemeGoals(),
    controlHead: await tx.getControlHead(),
  };
}

function ensureState(state) {
  if (!isObject(state.goalTemplates) || !isObject(state.themeGoals)
    || !isObject(state.controlHead) || !validRevision(state.controlHead.control_revision)) {
    throw new Error('控制面快照无效');
  }
}

function writeControl(tx, controlHead) {
  tx.setControlHead(nextControlHead(controlHead));
}

export function createGoalTemplateService(adapter, options = {}) {
  if (!adapter || typeof adapter.runTransaction !== 'function') throw new Error('adapter.runTransaction 必须存在');
  const idGenerator = options.idGenerator;
  if (typeof idGenerator !== 'function') throw new Error('options.idGenerator 必须存在');

  async function transact(handler) {
    return adapter.runTransaction(async tx => {
      const state = await readState(tx);
      ensureState(state);
      return handler(tx, state);
    });
  }

  async function saveUnlinkedTheme(command) {
    return transact(async (tx, state) => {
      const theme = state.themeGoals[command.theme_id];
      if (!theme) return errorResult('theme-goal-not-found');
      if (controlConflict(command.expected, state.controlHead)) return errorResult('control-revision-conflict');
      if (themeRevisionConflict(command.expected, [command.theme_id], state.themeGoals)) {
        return errorResult('theme-revision-conflict');
      }
      const branch = normalizeSubmittedBranch(command, command.selected_spec_id);
      if (branch.code) return branch;
      const nextTheme = {
        ...clone(theme),
        association_state: UNLINKED,
        template_id: null,
        selected_spec_id: branch.selected_spec_id,
        module_spec_id: branch.module_spec_id,
        target_intent: branch.target_intent,
        targets: branch.targets,
        ...(branch.template_items !== undefined ? { template_items: clone(branch.template_items) } : {}),
      };
      const changed = !equal(themeBusinessValue(theme), themeBusinessValue(nextTheme));
      const targetChanged = !equal(targetBusinessValue(theme), targetBusinessValue(nextTheme));
      const associationChanged = theme.association_state !== UNLINKED || theme.template_id !== null
        || theme.selected_spec_id !== branch.selected_spec_id;
      if (!changed && !associationChanged) return { code: 'ok', no_op: true, materialization_output_changed: false };
      const limit = capacityError(adapter, 2);
      if (limit) return limit;
      nextTheme.draft_revision = theme.draft_revision + 1;
      nextTheme.effective_revision = theme.effective_revision + (targetChanged ? 1 : 0);
      tx.setThemeGoal(command.theme_id, nextTheme);
      writeControl(tx, state.controlHead);
      return { code: 'ok', materialization_output_changed: targetChanged };
    });
  }

  async function applyTemplateToTheme(command) {
    return transact(async (tx, state) => {
      const template = state.goalTemplates[command.template_id];
      const theme = state.themeGoals[command.theme_id];
      if (!template || template.status !== ACTIVE) return errorResult('goal-template-not-found');
      if (!theme) return errorResult('theme-goal-not-found');
      if (controlConflict(command.expected, state.controlHead)) return errorResult('control-revision-conflict');
      if (themeRevisionConflict(command.expected, [command.theme_id], state.themeGoals)) {
        return errorResult('theme-revision-conflict');
      }
      let branches;
      try {
        branches = templateBranches(template);
      } catch (error) {
        return errorResult('goal-template-invalid', { message: String(error?.message || error) });
      }
      let themeContext = command.theme_context;
      if (!themeContext && command.theme_config) {
        try {
          themeContext = buildThemeCompatibilityContext(command.theme_config, command.theme_id);
        } catch (error) {
          return errorResult('goal-template-theme-config-invalid', { message: String(error?.message || error) });
        }
      }
      const compatibleIds = Object.values(branches).filter(branch => compatibleBranch(branch, themeContext))
        .map(branch => branch.selected_spec_id).sort();
      let selectedSpecId = command.selected_spec_id;
      if (selectedSpecId == null) {
        if (compatibleIds.length === 0) return errorResult('goal-template-no-compatible-spec');
        if (compatibleIds.length > 1) return errorResult('goal-template-spec-selection-required');
        [selectedSpecId] = compatibleIds;
      } else if (!compatibleIds.includes(selectedSpecId)) {
        return errorResult('goal-template-spec-incompatible');
      }
      const branch = branches[selectedSpecId];
      const nextTheme = {
        ...clone(theme),
        association_state: LINKED,
        template_id: template.template_id,
        selected_spec_id: selectedSpecId,
        module_spec_id: branch.module_spec_id,
        target_intent: branch.target_intent,
        targets: clone(branch.targets),
        ...(branch.template_items !== undefined ? { template_items: clone(branch.template_items) } : {}),
        draft_revision: theme.draft_revision + 1,
      };
      const changed = !equal(themeBusinessValue(theme), themeBusinessValue(nextTheme));
      const targetChanged = !equal(targetBusinessValue(theme), targetBusinessValue(nextTheme));
      const associationChanged = theme.association_state !== LINKED
        || theme.template_id !== template.template_id
        || theme.selected_spec_id !== selectedSpecId;
      if (!changed && !associationChanged) {
        return { code: 'ok', no_op: true, selected_spec_id: selectedSpecId, materialization_output_changed: false };
      }
      const limit = capacityError(adapter, 2);
      if (limit) return limit;
      nextTheme.effective_revision = theme.effective_revision + (targetChanged ? 1 : 0);
      tx.setThemeGoal(command.theme_id, nextTheme);
      writeControl(tx, state.controlHead);
      return { code: 'ok', selected_spec_id: selectedSpecId, materialization_output_changed: targetChanged };
    });
  }

  async function saveSynchronizedBranch(command) {
    return transact(async (tx, state) => {
      const sourceTheme = command.theme_id ? state.themeGoals[command.theme_id] : null;
      if (command.theme_id && (!sourceTheme || sourceTheme.association_state !== LINKED)) {
        return errorResult('theme-goal-not-linked');
      }
      const templateId = command.template_id || sourceTheme?.template_id;
      const selectedSpecId = command.selected_spec_id || sourceTheme?.selected_spec_id;
      const template = state.goalTemplates[templateId];
      if (!template) return errorResult('goal-template-not-found');
      if (sourceTheme && (sourceTheme.template_id !== templateId || sourceTheme.selected_spec_id !== selectedSpecId)) {
        return errorResult('goal-template-spec-incompatible');
      }
      const memberIds = linkedMemberIds(state.themeGoals, template.template_id, selectedSpecId);
      const remoteBranch = branchFor(template, selectedSpecId);
      if (!remoteBranch) return errorResult('goal-template-spec-incompatible');
      const conflict = code => errorResult(code, {
        local_draft: makeConflictDraft(command.base ?? remoteBranch.targets, command.targets, remoteBranch.targets),
      });
      if (controlConflict(command.expected, state.controlHead)) return conflict('control-revision-conflict');
      if (templateConflict(command.expected, template)) return conflict('template-revision-conflict');
      if (!checkMemberSet(command.expected, memberIds)) return conflict('goal-template-impact-scope-stale');
      if (themeRevisionConflict(command.expected, memberIds, state.themeGoals)) return conflict('theme-revision-conflict');
      const submittedCommand = {
        ...command,
        selected_spec_id: selectedSpecId,
      };
      if (!Object.prototype.hasOwnProperty.call(submittedCommand, 'template_items')
        && remoteBranch.template_items !== undefined) {
        submittedCommand.template_items = remoteBranch.template_items;
      }
      const submitted = normalizeSubmittedBranch(submittedCommand, remoteBranch.module_spec_id);
      if (submitted.code) return submitted;
      const changed = !equal(branchBusinessValue(remoteBranch), branchBusinessValue(submitted));
      const targetChanged = !equal(targetBusinessValue(remoteBranch), targetBusinessValue(submitted));
      if (!changed) {
        return { code: 'ok', no_op: true, materialization_output_changed: false };
      }
      const requiredWrites = memberIds.length + 2;
      const limit = capacityError(adapter, requiredWrites);
      if (limit) return limit;
      const nextTemplate = clone(template);
      nextTemplate.specs[selectedSpecId] = branchStorage(submitted, remoteBranch.wrapped);
      nextTemplate.template_revision = template.template_revision + 1;
      tx.setGoalTemplate(template.template_id, nextTemplate);
      for (const themeId of memberIds) {
        const theme = state.themeGoals[themeId];
        tx.setThemeGoal(themeId, {
          ...clone(theme),
          module_spec_id: submitted.module_spec_id,
          target_intent: submitted.target_intent,
          targets: clone(submitted.targets),
          ...(submitted.template_items !== undefined ? { template_items: clone(submitted.template_items) } : {}),
          draft_revision: theme.draft_revision + 1,
          effective_revision: theme.effective_revision + (targetChanged ? 1 : 0),
        });
      }
      writeControl(tx, state.controlHead);
      return {
        code: 'ok',
        materialization_output_changed: memberIds.length > 0 && targetChanged,
        required_writes: requiredWrites,
      };
    });
  }

  async function saveLinkedTheme(command) {
    return saveSynchronizedBranch(command);
  }

  async function saveTemplateBranch(command) {
    return saveSynchronizedBranch(command);
  }

  async function saveAsTemplate(command) {
    return transact(async (tx, state) => {
      const theme = state.themeGoals[command.theme_id];
      if (!theme) return errorResult('theme-goal-not-found');
      if (controlConflict(command.expected, state.controlHead)) return errorResult('control-revision-conflict');
      if (themeRevisionConflict(command.expected, [command.theme_id], state.themeGoals)) {
        return errorResult('theme-revision-conflict');
      }
      const submitted = normalizeSubmittedBranch(command, command.selected_spec_id);
      if (submitted.code) return submitted;
      let themeContext = command.theme_context;
      if (!themeContext && command.theme_config) {
        try {
          themeContext = buildThemeCompatibilityContext(command.theme_config, command.theme_id);
        } catch (error) {
          return errorResult('goal-template-theme-config-invalid', { message: String(error?.message || error) });
        }
      }
      if (!compatibleBranch(submitted, themeContext)) return errorResult('goal-template-spec-incompatible');
      const limit = capacityError(adapter, 3);
      if (limit) return limit;
      let templateId;
      try {
        templateId = generateUniqueId(idGenerator, state.goalTemplates);
      } catch (error) {
        return errorResult('goal-template-id-invalid', { message: String(error?.message || error) });
      }
      const nextTemplate = createTemplateDocument(templateId, command.display_name, {
        [submitted.selected_spec_id]: branchStorage(submitted, submitted.selected_spec_id !== submitted.module_spec_id),
      });
      const changed = !equal(themeBusinessValue(theme), branchBusinessValue(submitted));
      const targetChanged = !equal(targetBusinessValue(theme), targetBusinessValue(submitted));
      const nextTheme = {
        ...clone(theme),
        association_state: LINKED,
        template_id: templateId,
        selected_spec_id: submitted.selected_spec_id,
        module_spec_id: submitted.module_spec_id,
        target_intent: submitted.target_intent,
        targets: clone(submitted.targets),
        ...(submitted.template_items !== undefined ? { template_items: clone(submitted.template_items) } : {}),
        draft_revision: theme.draft_revision + 1,
        effective_revision: theme.effective_revision + (targetChanged ? 1 : 0),
      };
      tx.setGoalTemplate(templateId, nextTemplate);
      tx.setThemeGoal(command.theme_id, nextTheme);
      writeControl(tx, state.controlHead);
      return { code: 'ok', template_id: templateId, materialization_output_changed: targetChanged };
    });
  }

  async function createTemplate(command) {
    return transact(async (tx, state) => {
      if (controlConflict(command.expected, state.controlHead)) return errorResult('control-revision-conflict');
      let templateId;
      let template;
      try {
        templateId = generateUniqueId(idGenerator, state.goalTemplates);
        template = createTemplateDocument(templateId, command.display_name, command.specs);
      } catch (error) {
        return errorResult('goal-template-invalid', { message: String(error?.message || error) });
      }
      const limit = capacityError(adapter, 2);
      if (limit) return limit;
      tx.setGoalTemplate(templateId, template);
      writeControl(tx, state.controlHead);
      return { code: 'ok', template_id: templateId, materialization_output_changed: false };
    });
  }

  async function copyTemplate(command) {
    return transact(async (tx, state) => {
      const source = state.goalTemplates[command.template_id];
      if (!source) return errorResult('goal-template-not-found');
      if (controlConflict(command.expected, state.controlHead)) return errorResult('control-revision-conflict');
      if (templateConflict(command.expected, source)) return errorResult('template-revision-conflict');
      let templateId;
      let template;
      try {
        templateId = generateUniqueId(idGenerator, state.goalTemplates);
        template = createTemplateDocument(templateId, command.display_name || source.display_name, source.specs);
      } catch (error) {
        return errorResult('goal-template-invalid', { message: String(error?.message || error) });
      }
      const limit = capacityError(adapter, 2);
      if (limit) return limit;
      tx.setGoalTemplate(templateId, template);
      writeControl(tx, state.controlHead);
      return { code: 'ok', template_id: templateId, materialization_output_changed: false };
    });
  }

  async function renameTemplate(command) {
    return transact(async (tx, state) => {
      const template = state.goalTemplates[command.template_id];
      if (!template) return errorResult('goal-template-not-found');
      if (controlConflict(command.expected, state.controlHead)) return errorResult('control-revision-conflict');
      if (templateConflict(command.expected, template)) return errorResult('template-revision-conflict');
      if (!validName(command.display_name)) return errorResult('goal-template-invalid');
      const displayName = command.display_name.trim();
      if (displayName === template.display_name) return { code: 'ok', no_op: true, materialization_output_changed: false };
      const limit = capacityError(adapter, 2);
      if (limit) return limit;
      tx.setGoalTemplate(template.template_id, {
        ...clone(template), display_name: displayName, template_revision: template.template_revision + 1,
      });
      writeControl(tx, state.controlHead);
      return { code: 'ok', materialization_output_changed: false };
    });
  }

  async function exportTemplate(command) {
    return adapter.runTransaction(async tx => {
      const template = await tx.getGoalTemplate(command.template_id);
      if (!template) return errorResult('goal-template-not-found');
      return { code: 'ok', template: exportedTemplate(template) };
    });
  }

  async function importTemplate(command) {
    return transact(async (tx, state) => {
      if (controlConflict(command.expected, state.controlHead)) return errorResult('control-revision-conflict');
      let imported;
      try {
        if (!isObject(command.template) || command.template.schema_version !== TEMPLATE_EXPORT_SCHEMA_VERSION) {
          throw new Error('schema_version 无效');
        }
        const unknownFields = Object.keys(command.template).filter(key => !TEMPLATE_IMPORT_FIELDS.has(key));
        if (unknownFields.length > 0) throw new Error(`导入模板包含未知字段: ${unknownFields.sort().join(', ')}`);
        const specs = validateTemplateIdentity(command.template);
        imported = createTemplateDocument(command.template.template_id, command.template.display_name, specs);
      } catch (error) {
        return errorResult('goal-template-import-invalid', { message: String(error?.message || error) });
      }
      const existing = state.goalTemplates[imported.template_id];
      if (existing && equal(templateCanonicalContent(existing), templateCanonicalContent(imported))) {
        return errorResult('goal-template-import-no-op');
      }
      let templateId = imported.template_id;
      let idMapping;
      if (existing) {
        if (command.confirm_id_remap !== true) return errorResult('goal-template-import-id-conflict');
        try {
          templateId = generateUniqueId(idGenerator, state.goalTemplates);
        } catch (error) {
          return errorResult('goal-template-import-invalid', { message: String(error?.message || error) });
        }
        idMapping = { [imported.template_id]: templateId };
        imported.template_id = templateId;
      }
      const limit = capacityError(adapter, 2);
      if (limit) return limit;
      tx.setGoalTemplate(templateId, imported);
      writeControl(tx, state.controlHead);
      return { code: 'ok', id_mapping: idMapping, materialization_output_changed: false };
    });
  }

  async function deleteTemplate(command) {
    return transact(async (tx, state) => {
      const template = state.goalTemplates[command.template_id];
      if (!template) return errorResult('goal-template-not-found');
      const memberIds = linkedMemberIds(state.themeGoals, template.template_id);
      if (controlConflict(command.expected, state.controlHead)) return errorResult('control-revision-conflict');
      if (templateConflict(command.expected, template)) return errorResult('template-revision-conflict');
      if (!checkMemberSet(command.expected, memberIds)) return errorResult('goal-template-impact-scope-stale');
      if (themeRevisionConflict(command.expected, memberIds, state.themeGoals)) {
        return errorResult('theme-revision-conflict');
      }
      const requiredWrites = memberIds.length + 2;
      const limit = capacityError(adapter, requiredWrites);
      if (limit) return limit;
      tx.deleteGoalTemplate(template.template_id);
      for (const themeId of memberIds) {
        const theme = state.themeGoals[themeId];
        tx.setThemeGoal(themeId, {
          ...clone(theme),
          association_state: UNLINKED,
          template_id: null,
          draft_revision: theme.draft_revision + 1,
        });
      }
      writeControl(tx, state.controlHead);
      return { code: 'ok', materialization_output_changed: false, required_writes: requiredWrites };
    });
  }

  return {
    applyTemplateToTheme,
    copyTemplate,
    createTemplate,
    deleteTemplate,
    exportTemplate,
    importTemplate,
    renameTemplate,
    saveAsTemplate,
    saveLinkedTheme,
    saveTemplateBranch,
    saveUnlinkedTheme,
  };
}

export { TEMPLATE_EXPORT_SCHEMA_VERSION };
