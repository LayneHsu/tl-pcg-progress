import { canonicalizeSchema3Targets } from './config-migration.js';
import { canonicalJsonText } from './modules-templates.js';

const READY_SCHEMA = 'pcg-module-ready-config';
const MODULE_TEMPLATE_SCHEMA = 'pcg-modules-templates';
const encoder = new TextEncoder();

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function equal(left, right) {
  return canonicalJsonText(left) === canonicalJsonText(right);
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

function normalizedThemeGoals(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    return Object.entries(value).map(([themeId, goal]) => ({ ...clone(goal), theme_id: themeId }));
  }
  return [];
}

function previousBundle(previousReady) {
  return previousReady?.bundle || null;
}

function previousPointer(previousReady) {
  return previousReady?.pointer || null;
}

function previousThemeSpecs(previousReady, themeId) {
  return clone(previousBundle(previousReady)?.module_templates?.theme_modules?.[themeId]);
}

function recordFromCurrentGoal(goal) {
  const specId = goal.module_spec_id || goal.selected_spec_id;
  if (typeof specId !== 'string' || !specId) throw new Error('theme-goal-incomplete');
  const record = {
    theme_id: goal.theme_id,
    target_intent: goal.target_intent,
    specs: { [specId]: clone(goal.targets) },
  };
  if (Object.prototype.hasOwnProperty.call(goal, 'template_items')) {
    record.template_items = { [specId]: clone(goal.template_items) };
  }
  return record;
}

function recordFromPrevious(themeId, specs) {
  const values = Object.values(specs || {});
  const explicitEmpty = values.length > 0 && values.every(value => (
    isObject(value) && Object.keys(value).length === 0
  ));
  return {
    theme_id: themeId,
    target_intent: explicitEmpty ? 'explicit_empty' : 'defined',
    specs: clone(specs),
  };
}

function templateItemsFromCurrentGoal(goal) {
  const specId = goal.module_spec_id || goal.selected_spec_id;
  if (typeof specId !== 'string' || !specId
      || !Object.prototype.hasOwnProperty.call(goal, 'template_items')) return null;
  return { [specId]: clone(goal.template_items) };
}

function normalizePatch(value) {
  const patch = isObject(value) ? value : {};
  const upserts = Array.isArray(patch.upserts) ? patch.upserts.map(clone) : [];
  const deletes = Array.isArray(patch.deletes) ? [...patch.deletes] : [];
  const membership = Array.isArray(patch.format_rule_membership)
    ? patch.format_rule_membership.map(item => ({
      format: item?.format,
      theme_ids: [...new Set(Array.isArray(item?.theme_ids) ? item.theme_ids : [])],
    })) : [];
  const paths = [];
  for (const item of upserts) {
    if (!isObject(item) || typeof item.path !== 'string' || !item.path.startsWith('/')) {
      throw new Error('managed-theme-config-invalid');
    }
    paths.push(item.path);
  }
  for (const path of deletes) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('managed-theme-config-invalid');
    paths.push(path);
  }
  if (new Set(paths).size !== paths.length) throw new Error('managed-theme-config-invalid');
  const sortedPaths = [...paths].sort();
  for (let index = 0; index < sortedPaths.length; index += 1) {
    for (let other = index + 1; other < sortedPaths.length; other += 1) {
      if (sortedPaths[other].startsWith(`${sortedPaths[index]}/`)) {
        throw new Error('managed-theme-config-invalid');
      }
    }
  }
  for (const item of membership) {
    if (typeof item.format !== 'string' || !item.format || item.theme_ids.some(themeId => (
      typeof themeId !== 'string' || !themeId
    ))) throw new Error('managed-theme-config-invalid');
  }
  return {
    upserts: upserts.sort((left, right) => compareUtf8(left.path, right.path)),
    deletes: deletes.sort(compareUtf8),
    format_rule_membership: membership,
  };
}

function pointerFor(status, controlRevision, syncRevision, pendingThemeIds, errorCode = null) {
  return {
    status,
    source_control_revision: controlRevision,
    bundle_id: status === 'ready' ? `control-r${controlRevision}` : null,
    sync_revision: syncRevision,
    error_code: errorCode,
    pending_theme_ids: [...pendingThemeIds],
  };
}

function nonReadyPointer(status, controlRevision, syncRevision, pendingThemeIds, previousReady, errorCode = null) {
  const pointer = pointerFor(status, controlRevision, syncRevision, pendingThemeIds, errorCode);
  pointer.previous_bundle_id = previousBundle(previousReady)?.bundle_id || null;
  return pointer;
}

function businessOutput(bundle) {
  if (!bundle) return null;
  return {
    managed_theme_config_patch: bundle.managed_theme_config_patch,
    module_templates: bundle.module_templates,
  };
}

function errorDecision(code, controlRevision, previousReady) {
  return {
    code,
    control_revision: controlRevision,
    pointer: clone(previousPointer(previousReady)),
    bundle: null,
    control_head: null,
    output_changed: false,
  };
}

export function materializeControlRevision(snapshot, previousReady = null, options = {}) {
  const controlRevision = snapshot?.controlHead?.control_revision;
  if (!validRevision(controlRevision)) return errorDecision('materialization-control-invalid', controlRevision, previousReady);
  const priorSyncRevision = previousPointer(previousReady)?.sync_revision ?? 0;
  if (!validRevision(priorSyncRevision)) {
    return errorDecision('materialization-revision-invalid', controlRevision, previousReady);
  }
  if (options.phase === 'building') {
    const pointer = nonReadyPointer('building', controlRevision, priorSyncRevision, [], previousReady);
    return {
      code: 'ok',
      control_revision: controlRevision,
      pointer,
      bundle: null,
      control_head: { ...clone(snapshot.controlHead), status: 'materializing' },
      output_changed: false,
    };
  }

  const goals = normalizedThemeGoals(snapshot.themeGoals);
  const themeIds = goals.map(goal => goal?.theme_id);
  const duplicateId = themeIds.find((themeId, index) => (
    typeof themeId === 'string' && themeIds.indexOf(themeId) !== index
  ));
  const snapshotConflicts = Array.isArray(snapshot.conflicts) ? snapshot.conflicts : [];
  const conflictCode = duplicateId ? 'config-duplicate-theme-id' : snapshotConflicts[0]?.code;
  if (conflictCode) {
    return {
      code: 'ok',
      control_revision: controlRevision,
      pointer: nonReadyPointer('conflict', controlRevision, priorSyncRevision, [], previousReady, conflictCode),
      bundle: null,
      control_head: { ...clone(snapshot.controlHead), status: 'current' },
      output_changed: false,
      conflicts: clone(snapshotConflicts),
    };
  }

  const effectiveRecords = [];
  const themeTemplateItems = {};
  const pendingThemeIds = [];
  for (const goal of goals.sort((left, right) => compareUtf8(left?.theme_id, right?.theme_id))) {
    let currentRecord;
    try {
      if (!isObject(goal) || typeof goal.theme_id !== 'string' || !goal.theme_id) throw new Error('theme-goal-incomplete');
      if (goal.association_state === 'conflict') throw new Error('goal-template-link-invalid');
      currentRecord = recordFromCurrentGoal(goal);
      canonicalizeSchema3Targets([currentRecord]);
      effectiveRecords.push(currentRecord);
      const items = templateItemsFromCurrentGoal(goal);
      if (items) themeTemplateItems[goal.theme_id] = items;
      continue;
    } catch {
      if (typeof goal?.theme_id !== 'string' || !goal.theme_id) continue;
      pendingThemeIds.push(goal.theme_id);
      const fallback = previousThemeSpecs(previousReady, goal.theme_id);
      if (isObject(fallback) && Object.keys(fallback).length > 0) {
        effectiveRecords.push(recordFromPrevious(goal.theme_id, fallback));
      }
    }
  }
  pendingThemeIds.sort(compareUtf8);

  if (effectiveRecords.length === 0) {
    return {
      code: 'ok',
      control_revision: controlRevision,
      pointer: nonReadyPointer(
        'incomplete', controlRevision, priorSyncRevision, pendingThemeIds, previousReady,
        'config-no-effective-theme',
      ),
      bundle: null,
      control_head: { ...clone(snapshot.controlHead), status: 'current' },
      output_changed: false,
    };
  }

  let moduleTargets;
  let managedPatch;
  try {
    moduleTargets = canonicalizeSchema3Targets(effectiveRecords);
    managedPatch = normalizePatch(snapshot.managed_theme_config_patch);
  } catch (error) {
    const code = String(error?.message || error).includes('managed-theme-config-invalid')
      ? 'managed-theme-config-invalid'
      : (error?.code || 'config-global-identity-conflict');
    return {
      code: 'ok',
      control_revision: controlRevision,
      pointer: nonReadyPointer(
        'conflict', controlRevision, priorSyncRevision, pendingThemeIds, previousReady, code,
      ),
      bundle: null,
      control_head: { ...clone(snapshot.controlHead), status: 'current' },
      output_changed: false,
    };
  }
  const candidateOutput = {
    managed_theme_config_patch: managedPatch,
    module_templates: {
      schema: MODULE_TEMPLATE_SCHEMA,
      schema_version: 3,
      modules: moduleTargets.modules,
      theme_modules: moduleTargets.theme_modules,
    },
  };
  if (Object.keys(themeTemplateItems).length > 0) {
    candidateOutput.theme_template_items = Object.fromEntries(
      Object.entries(themeTemplateItems).sort(([left], [right]) => compareUtf8(left, right)),
    );
  }
  const runtimeOutput = {
    managed_theme_config_patch: candidateOutput.managed_theme_config_patch,
    module_templates: candidateOutput.module_templates,
  };
  const outputChanged = !equal(runtimeOutput, businessOutput(previousBundle(previousReady)));
  const syncRevision = priorSyncRevision + (outputChanged ? 1 : 0);
  if (options.proposed_sync_revision !== undefined && options.proposed_sync_revision !== syncRevision) {
    return errorDecision('materialization-revision-invalid', controlRevision, previousReady);
  }
  const bundleId = `control-r${controlRevision}`;
  const bundle = {
    schema: READY_SCHEMA,
    schema_version: 1,
    bundle_id: bundleId,
    source_control_revision: controlRevision,
    sync_revision: syncRevision,
    pending_theme_ids: pendingThemeIds,
    ...candidateOutput,
  };
  return {
    code: 'ok',
    control_revision: controlRevision,
    pointer: pointerFor('ready', controlRevision, syncRevision, pendingThemeIds),
    bundle,
    control_head: { ...clone(snapshot.controlHead), status: 'current' },
    output_changed: outputChanged,
  };
}

export async function commitMaterialization(adminAdapter, decision) {
  if (!adminAdapter || typeof adminAdapter.runTransaction !== 'function') {
    throw new Error('adminAdapter.runTransaction 必须存在');
  }
  if (!decision || decision.code !== 'ok' || !validRevision(decision.control_revision)) {
    return { code: decision?.code || 'materialization-decision-invalid' };
  }
  return adminAdapter.runTransaction(async tx => {
    const controlHead = await tx.getControlHead();
    if (!validRevision(controlHead?.control_revision)) return { code: 'materialization-control-invalid' };
    if (controlHead.control_revision > decision.control_revision) return { code: 'materialization-superseded' };
    if (controlHead.control_revision !== decision.control_revision) return { code: 'materialization-revision-invalid' };

    const currentPointer = await tx.getReadyPointer();
    if (controlHead.status === 'current') {
      const samePointer = equal(currentPointer, decision.pointer);
      const sameBundle = !decision.bundle || equal(
        await tx.getReadyBundle(decision.bundle.bundle_id), decision.bundle,
      );
      return samePointer && sameBundle
        ? { code: 'ok', no_op: true }
        : { code: 'materialization-revision-invalid' };
    }
    if (controlHead.status !== 'materializing') return { code: 'materialization-control-invalid' };

    if (decision.pointer?.status === 'building') {
      const currentSyncRevision = currentPointer?.sync_revision ?? 0;
      if (!validRevision(currentSyncRevision)
          || decision.pointer.sync_revision !== currentSyncRevision) {
        return { code: 'materialization-revision-invalid' };
      }
      if (equal(currentPointer, decision.pointer)) return { code: 'ok', no_op: true };
      tx.setReadyPointer(clone(decision.pointer));
      return { code: 'ok' };
    }

    if (decision.bundle) {
      const priorBundleId = currentPointer?.status === 'ready'
        ? currentPointer.bundle_id : currentPointer?.previous_bundle_id;
      const priorBundle = priorBundleId ? await tx.getReadyBundle(priorBundleId) : null;
      const priorSyncRevision = currentPointer?.sync_revision ?? 0;
      if (!validRevision(priorSyncRevision)) return { code: 'materialization-revision-invalid' };
      const changed = !equal(businessOutput(priorBundle), businessOutput(decision.bundle));
      const expectedSyncRevision = priorSyncRevision + (changed ? 1 : 0);
      if (decision.pointer.sync_revision !== expectedSyncRevision
          || decision.bundle.sync_revision !== expectedSyncRevision) {
        return { code: 'materialization-revision-invalid' };
      }
      const existing = await tx.getReadyBundle(decision.bundle.bundle_id);
      if (existing && !equal(existing, decision.bundle)) return { code: 'materialization-bundle-conflict' };
      if (!existing) tx.createReadyBundle(decision.bundle.bundle_id, clone(decision.bundle));
    }
    tx.setReadyPointer(clone(decision.pointer));
    tx.setControlHead({ ...clone(controlHead), status: 'current' });
    return { code: 'ok' };
  });
}

export { MODULE_TEMPLATE_SCHEMA, READY_SCHEMA };
