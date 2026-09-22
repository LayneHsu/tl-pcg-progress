import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitMaterialization,
  materializeControlRevision,
} from './config-materializer.js';

const mixedBook = { '4x4': { Book: { '01': ['01'] } } };
const mixedBookExtra = { '4x4': { Book: { '01': ['01', '02'] } } };
const mixedCollection = { '4x4': { Collection: { '02': ['01'] } } };

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function goal(themeId, targets, revision = 1, extra = {}) {
  return {
    theme_id: themeId,
    association_state: 'unlinked',
    template_id: null,
    selected_spec_id: 'mixed_u4',
    module_spec_id: 'mixed_u4',
    target_intent: 'defined',
    targets: clone(targets),
    draft_revision: revision,
    effective_revision: revision,
    ...extra,
  };
}

function patch(value = 'CB') {
  return {
    upserts: [{ path: '/Theme_Registry/mixed/XXGCB', value: { parent: value } }],
    deletes: [],
    format_rule_membership: [{ format: 'Room_CB', theme_ids: ['XXGCB'] }],
  };
}

function bundleFor(revision, syncRevision, themeTargets, managedPatch = patch()) {
  const themeModules = {};
  const modules = {};
  for (const [themeId, targets] of Object.entries(themeTargets)) {
    themeModules[themeId] = { mixed_u4: clone(targets) };
    for (const [size, roomTypes] of Object.entries(targets)) {
      modules[size] ??= {};
      for (const [roomType, ctgs] of Object.entries(roomTypes)) {
        modules[size][roomType] ??= {};
        for (const [ctg, variants] of Object.entries(ctgs)) {
          modules[size][roomType][ctg] = [...new Set([
            ...(modules[size][roomType][ctg] || []), ...variants,
          ])].sort();
        }
      }
    }
  }
  return {
    schema: 'pcg-module-ready-config',
    schema_version: 1,
    bundle_id: `control-r${revision}`,
    source_control_revision: revision,
    sync_revision: syncRevision,
    pending_theme_ids: [],
    managed_theme_config_patch: clone(managedPatch),
    module_templates: {
      schema: 'pcg-modules-templates',
      schema_version: 3,
      modules: { mixed_u4: modules },
      theme_modules: themeModules,
    },
  };
}

function previousReady(bundle) {
  return {
    pointer: {
      status: 'ready', error_code: null,
      source_control_revision: bundle.source_control_revision,
      bundle_id: bundle.bundle_id,
      sync_revision: bundle.sync_revision,
    },
    bundle,
  };
}

function snapshot(themeGoals, revision = 13, managedPatch = patch(), conflicts = []) {
  return {
    controlHead: { control_revision: revision, status: 'materializing' },
    themeGoals,
    managed_theme_config_patch: managedPatch,
    conflicts,
  };
}

function adminMemoryAdapter(initial) {
  let state = clone(initial);
  const adapter = {
    createdBundles: [],
    pointerWrites: [],
    controlWrites: [],
    snapshot: () => clone(state),
    async runTransaction(handler) {
      const writes = [];
      const tx = {
        getControlHead: () => clone(state.controlHead),
        getReadyPointer: () => clone(state.pointer),
        getReadyBundle: id => clone(state.bundles?.[id]),
        createReadyBundle: (id, value) => writes.push(['createBundle', id, clone(value)]),
        setReadyPointer: value => writes.push(['setPointer', clone(value)]),
        setControlHead: value => writes.push(['setControl', clone(value)]),
      };
      const result = await handler(tx);
      if (result.code !== 'ok') return result;
      for (const write of writes) {
        if (write[0] === 'createBundle') {
          state.bundles ??= {};
          state.bundles[write[1]] = write[2];
          adapter.createdBundles.push(write[1]);
        }
        if (write[0] === 'setPointer') {
          state.pointer = write[1];
          adapter.pointerWrites.push(clone(write[1]));
        }
        if (write[0] === 'setControl') {
          state.controlHead = write[1];
          adapter.controlWrites.push(clone(write[1]));
        }
      }
      return result;
    },
  };
  return adapter;
}

test('same canonical output keeps sync_revision while closing the new control revision', () => {
  const oldBundle = bundleFor(12, 7, { XXGCB: mixedBook });
  const result = materializeControlRevision(
    snapshot([goal('XXGCB', mixedBook)]),
    previousReady(oldBundle),
  );
  assert.equal(result.code, 'ok');
  assert.equal(result.pointer.sync_revision, 7);
  assert.equal(result.pointer.source_control_revision, 13);
  assert.equal(result.bundle.bundle_id, 'control-r13');
  assert.equal(result.output_changed, false);
});

test('building is observable without creating a bundle or closing the control head', async () => {
  const oldBundle = bundleFor(12, 7, { XXGCB: mixedBook });
  const decision = materializeControlRevision(
    snapshot([goal('XXGCB', mixedBook)]),
    previousReady(oldBundle),
    { phase: 'building' },
  );
  assert.equal(decision.pointer.status, 'building');
  assert.equal(decision.pointer.bundle_id, null);
  assert.equal(decision.bundle, null);
  assert.equal(decision.control_head.status, 'materializing');

  const adapter = adminMemoryAdapter({
    controlHead: { control_revision: 13, status: 'materializing' },
    pointer: previousReady(oldBundle).pointer,
    bundles: { 'control-r12': oldBundle },
  });
  const result = await commitMaterialization(adapter, decision);
  assert.equal(result.code, 'ok');
  assert.equal(adapter.pointerWrites[0].status, 'building');
  assert.deepEqual(adapter.createdBundles, []);
  assert.deepEqual(adapter.controlWrites, []);
  assert.equal(adapter.snapshot().controlHead.status, 'materializing');
});

test('changed canonical output advances sync_revision exactly once', () => {
  const oldBundle = bundleFor(12, 7, { XXGCB: mixedBook });
  const result = materializeControlRevision(
    snapshot([goal('XXGCB', mixedBookExtra)]),
    previousReady(oldBundle),
  );
  assert.equal(result.pointer.sync_revision, 8);
  assert.equal(result.bundle.sync_revision, 8);
  assert.equal(result.output_changed, true);
});

test('theme template item metadata is projected separately without changing runtime sync revision', () => {
  const item = {
    item_id: 'item-001', display_name: '东侧大厅', properties: { owner: 'TA-01' },
    expected_count: 1, target_refs: [{
      spec_id: 'mixed_u4', size: '4x4', roomType: 'Book', ctg: '01', variant: '01',
    }],
  };
  const oldBundle = bundleFor(12, 7, { XXGCB: mixedBook });
  const result = materializeControlRevision(
    snapshot([{ ...goal('XXGCB', mixedBook), template_items: [item] }]),
    previousReady(oldBundle),
  );
  assert.equal(result.code, 'ok');
  assert.equal(result.output_changed, false);
  assert.equal(result.bundle.sync_revision, 7);
  assert.deepEqual(result.bundle.module_templates.theme_modules.XXGCB, { mixed_u4: mixedBook });
  assert.deepEqual(result.bundle.theme_template_items.XXGCB.mixed_u4, [item]);
});

test('an incomplete current draft falls back to the previous effective theme only', () => {
  const oldBundle = bundleFor(12, 7, { XXGCB: mixedBook, SCJGB: mixedCollection });
  const incomplete = goal('SCJGB', {}, 2, { target_intent: null, effective_revision: 1 });
  const result = materializeControlRevision(
    snapshot([goal('XXGCB', mixedBook), incomplete]),
    previousReady(oldBundle),
  );
  assert.equal(result.pointer.status, 'ready');
  assert.deepEqual(result.bundle.pending_theme_ids, ['SCJGB']);
  assert.deepEqual(result.bundle.module_templates.theme_modules.SCJGB, { mixed_u4: mixedCollection });
  assert.equal(result.pointer.sync_revision, 7);
});

test('no effective theme produces incomplete without a ready bundle', () => {
  const oldBundle = bundleFor(12, 7, { XXGCB: mixedBook });
  const result = materializeControlRevision(snapshot([
    goal('SCJGB', {}, 0, { target_intent: null, effective_revision: 0 }),
  ], 13), previousReady(oldBundle));
  assert.equal(result.code, 'ok');
  assert.equal(result.pointer.status, 'incomplete');
  assert.equal(result.pointer.error_code, 'config-no-effective-theme');
  assert.equal(result.pointer.bundle_id, null);
  assert.equal(result.pointer.previous_bundle_id, 'control-r12');
  assert.equal(result.bundle, null);
});

test('duplicate theme ids and global identity conflicts produce conflict without a bundle', () => {
  const oldBundle = bundleFor(12, 7, { XXGCB: mixedBook });
  const duplicate = materializeControlRevision(snapshot([
    goal('XXGCB', mixedBook), goal('XXGCB', mixedCollection),
  ]), previousReady(oldBundle));
  assert.equal(duplicate.pointer.status, 'conflict');
  assert.equal(duplicate.pointer.error_code, 'config-duplicate-theme-id');
  assert.equal(duplicate.pointer.previous_bundle_id, 'control-r12');
  assert.equal(duplicate.bundle, null);

  const globalConflict = materializeControlRevision(snapshot(
    [goal('XXGCB', mixedBook)], 13, patch(),
    [{ code: 'config-global-identity-conflict', path: '/modules/shared' }],
  ), previousReady(oldBundle));
  assert.equal(globalConflict.pointer.status, 'conflict');
  assert.equal(globalConflict.pointer.error_code, 'config-global-identity-conflict');
  assert.equal(globalConflict.pointer.previous_bundle_id, 'control-r12');
  assert.equal(globalConflict.bundle, null);
});

test('only effective theme goals enter the shared union and unused templates are irrelevant', () => {
  const result = materializeControlRevision({
    ...snapshot([goal('XXGCB', mixedBook), goal('SCJGB', mixedCollection)]),
    goalTemplates: {
      UNUSED: { specs: { mixed_u4: mixedBookExtra } },
    },
  }, null);
  assert.deepEqual(Object.keys(result.bundle.module_templates.theme_modules), ['SCJGB', 'XXGCB']);
  assert.deepEqual(result.bundle.module_templates.modules.mixed_u4, {
    '4x4': {
      Book: { '01': ['01'] },
      Collection: { '02': ['01'] },
    },
  });
});

test('an object theme goal uses its registry key as the stable theme identity', () => {
  const result = materializeControlRevision(snapshot({
    XXGCB: goal('SCJGB', mixedBook),
  }), null);
  assert.deepEqual(Object.keys(result.bundle.module_templates.theme_modules), ['XXGCB']);
});

test('managed patch paths use deterministic UTF-8 byte ordering', () => {
  const managedPatch = {
    upserts: [
      { path: '/é', value: 1 },
      { path: '/z', value: 2 },
    ],
    deletes: [],
    format_rule_membership: [],
  };
  const result = materializeControlRevision(
    snapshot([goal('XXGCB', mixedBook)], 13, managedPatch),
    null,
  );
  assert.deepEqual(
    result.bundle.managed_theme_config_patch.upserts.map(item => item.path),
    ['/z', '/é'],
  );
});

test('the caller cannot submit a stale or skipped sync_revision', () => {
  const oldBundle = bundleFor(12, 7, { XXGCB: mixedBook });
  for (const [targets, submitted] of [[mixedBook, 8], [mixedBookExtra, 7], [mixedBookExtra, 9]]) {
    const result = materializeControlRevision(
      snapshot([goal('XXGCB', targets)]),
      previousReady(oldBundle),
      { proposed_sync_revision: submitted },
    );
    assert.equal(result.code, 'materialization-revision-invalid');
    assert.equal(result.bundle, null);
  }
});

test('superseded materialization cannot create a bundle or move the pointer', async () => {
  const decision = materializeControlRevision(snapshot([goal('XXGCB', mixedBook)]), null);
  const adapter = adminMemoryAdapter({
    controlHead: { control_revision: 14, status: 'current' },
    pointer: { status: 'ready', source_control_revision: 14, bundle_id: 'control-r14', sync_revision: 9 },
    bundles: { 'control-r14': bundleFor(14, 9, { XXGCB: mixedBookExtra }) },
  });
  const result = await commitMaterialization(adapter, decision);
  assert.equal(result.code, 'materialization-superseded');
  assert.equal(adapter.createdBundles.length, 0);
  assert.equal(adapter.pointerWrites.length, 0);
  assert.equal(adapter.controlWrites.length, 0);
});

test('ready commit creates one immutable bundle and closes the same control revision', async () => {
  const decision = materializeControlRevision(snapshot([goal('XXGCB', mixedBook)], 7), null);
  const adapter = adminMemoryAdapter({
    controlHead: { control_revision: 7, status: 'materializing' },
    pointer: null,
    bundles: {},
  });
  const result = await commitMaterialization(adapter, decision);
  assert.equal(result.code, 'ok');
  assert.deepEqual(adapter.createdBundles, ['control-r7']);
  assert.equal(adapter.pointerWrites[0].status, 'ready');
  assert.deepEqual(adapter.controlWrites[0], { control_revision: 7, status: 'current' });
});

test('non-ready commit moves only the pointer and closes the control head', async () => {
  const decision = materializeControlRevision(snapshot([
    goal('SCJGB', {}, 0, { target_intent: null, effective_revision: 0 }),
  ], 7), null);
  const adapter = adminMemoryAdapter({
    controlHead: { control_revision: 7, status: 'materializing' },
    pointer: null,
    bundles: {},
  });
  const result = await commitMaterialization(adapter, decision);
  assert.equal(result.code, 'ok');
  assert.deepEqual(adapter.createdBundles, []);
  assert.equal(adapter.pointerWrites[0].status, 'incomplete');
  assert.equal(adapter.controlWrites[0].status, 'current');
});
