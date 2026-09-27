import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as modulesApi from './modules-templates.js';
import {
  addModuleDefinition, addModuleSize, addModuleTarget, buildModuleSpecId, changeModuleVariantCount, countTargets, createCloudSnapshotSequence, fingerprintDocument,
  listModuleDefinitions, listModuleSizes, listModuleTargets, buildModuleGoalDraft, validateModuleGoalDraft, moduleGoalDraftFromConfigBundle,
  moveModuleTarget, parseDocumentText, removeModuleDefinition, removeModuleSize, removeModuleTarget, summarize,
  setModuleVariantCount, updateModuleDefinition, updateModuleTarget, validateDocument
} from './modules-templates.js';

const sample = {
  schema: 'pcg-modules-templates', schema_version: 2,
  modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [1, 2] } } } } }
};

const themeConfigSample = {
  Theme_Registry: { modular: {}, mixed: {} },
  Mode_Configs: { modular: { themes: {} }, mixed: { themes: {} } },
};

const draftTimestamp = { toDate() { return new Date(0); } };
const require = createRequire(import.meta.url);
const firebase = require('firebase/compat/app').default;
require('firebase/compat/firestore');

test('validates and counts the direct target tree', () => {
  validateDocument(sample);
  assert.equal(countTargets(sample), 2);
  assert.deepEqual(summarize(sample), [{ spec: 'modular_m28_u4_r12', targetCount: 2 }]);
});

test('builds specification ids from the physical fields users edit', () => {
  assert.equal(buildModuleSpecId({
    specKind: 'modular', tileSize: '28', unitSize: '4', roadWidth: '12',
  }), 'modular_m28_u4_r12');
  assert.equal(buildModuleSpecId({
    specKind: 'mixed', unitSize: '4',
  }), 'mixed_u4');
  assert.throws(
    () => buildModuleSpecId({ specKind: 'modular', tileSize: '', unitSize: '4', roadWidth: '12' }),
    /地块尺寸.*正整数/,
  );
  assert.throws(
    () => buildModuleSpecId({ specKind: 'mixed', unitSize: '0' }),
    /单位尺寸.*正整数/,
  );
});

test('reads specification ids back into the physical fields users edit', () => {
  assert.deepEqual(modulesApi.getModuleSpecFields('modular_m28_u4_r12'), {
    specKind: 'modular', tileSize: 28, unitSize: 4, roadWidth: 12,
  });
  assert.deepEqual(modulesApi.getModuleSpecFields('mixed_u8'), {
    specKind: 'mixed', unitSize: 8,
  });
});

test('expands modular and mixed leaves to Scanner-compatible Module target names', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [1, 2] } } } },
      mixed_u4: { '12x12': { Book: { '01': ['01'] } } },
    },
  };
  assert.deepEqual(
    listModuleTargets(document, 'modular_m28_u4_r12').map(item => [item.group, item.name]),
    [
      ['Area', 'Module_Area_Base_1x1_3_01_01'],
      ['Area', 'Module_Area_Base_1x1_3_02_01'],
    ],
  );
  assert.deepEqual(
    listModuleTargets(document, 'mixed_u4').map(item => [item.group, item.name]),
    [['12x12', 'Module_Room_12x12_Book_01_01_01']],
  );
});

test('builds independent Map and BP presence for every scanner work item', () => {
  const status = {
    spec_id: 'modular_m28_u4_r12',
    asset_prefix: 'YWMD',
    target_count: 2,
    work_item_names: [
      'YWMD_Area_Base_1x1_3_01_01',
      'YWMD_Area_Base_1x1_3_02_01',
    ],
    missing_maps: ['Map_YWMD_Area_Base_1x1_3_02_01'],
    missing_blueprints: ['BP_YWMD_Area_Base_1x1_3_01_01'],
    map_bp_state: 'different',
  };
  assert.deepEqual(modulesApi.buildModuleWorkItemStatuses(sample, status), [
    {
      name: 'YWMD_Area_Base_1x1_3_01_01',
      mapExists: true, bpExists: false, skipped: false,
    },
    {
      name: 'YWMD_Area_Base_1x1_3_02_01',
      mapExists: false, bpExists: true, skipped: false,
    },
  ]);
});

test('theme-scoped scanner status uses the theme target tree as denominator', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: {
      '12x12': { Book: { '01': ['01', '02'] } },
      '16x16': { Book: { '01': ['01'] } },
    } },
  };
  const themeTargets = { '12x12': { Book: { '01': ['01'] } } };
  const status = {
    spec_id: 'mixed_u4', asset_prefix: 'JJGQ', target_count: 3,
    work_item_names: ['JJGQ_Room_12x12_Book_01_01_01'],
    missing_maps: [], missing_blueprints: [], map_bp_state: 'same',
  };
  const items = modulesApi.buildThemeModuleWorkItemStatuses(document, status, themeTargets);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'JJGQ_Room_12x12_Book_01_01_01');
  assert.deepEqual(modulesApi.summarizeModuleWorkItemStatuses(items), {
    mapPresent: 1, bpPresent: 1, bpApplicable: true, targetTotal: 1, total: 1, skipped: 0,
  });
});

test('module-only work items use map existence and old full-scope rows have a bounded fallback', () => {
  const status = {
    spec_id: 'modular_m28_u4_r12', asset_prefix: 'Module', target_count: 2,
    missing_maps: ['Map_Module_Area_Base_1x1_3_02_01'],
    missing_blueprints: [], map_bp_state: 'not_applicable',
  };
  assert.deepEqual(
    modulesApi.buildModuleWorkItemStatuses(sample, status).map(item => [item.mapExists, item.bpExists]),
    [[true, null], [false, null]],
  );
  assert.throws(
    () => modulesApi.buildModuleWorkItemStatuses(sample, { ...status, target_count: 1 }),
    /目标范围.*重新扫描/,
  );
  assert.throws(
    () => modulesApi.buildModuleWorkItemStatuses(sample, {
      ...status,
      target_count: 1,
      work_item_names: ['Module_Area_Base_1x1_3_01_01'],
      missing_maps: [],
    }),
    /目标范围.*重新扫描/,
  );
  assert.throws(
    () => modulesApi.buildModuleWorkItemStatuses(sample, {
      ...status,
      work_item_names: ['Module_Unknown_01', 'Module_Unknown_02'],
      missing_maps: [],
    }),
    /当前目标 JSON/,
  );
});

test('builds a strict independent module goal draft with a matching SHA-256', async () => {
  const draft = await buildModuleGoalDraft({
    moduleTemplates: sample,
    rootSource: 'current_workspace',
    draftRevision: 'draft-1',
    updatedAt: draftTimestamp,
    updatedBy: 'admin@example.com',
  });
  assert.deepEqual(Object.keys(draft).sort(), [
    'draft_revision', 'module_templates', 'module_templates_sha256', 'root_source',
    'schema', 'schema_version', 'updated_at', 'updated_by',
  ]);
  assert.equal(draft.schema, 'pcg-module-goal-draft');
  assert.equal(draft.schema_version, 1);
  assert.equal(draft.module_templates_sha256, await fingerprintDocument(sample));
  await validateModuleGoalDraft(draft);
});

test('builds a module goal draft with the real Firebase Compat server timestamp sentinel', async () => {
  const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp();
  const draft = await buildModuleGoalDraft({
    moduleTemplates: sample,
    rootSource: 'current_workspace',
    draftRevision: 'draft-server-time',
    updatedAt: serverTimestamp,
    updatedBy: 'admin@example.com',
  });
  assert.equal(draft.updated_at, serverTimestamp);
  assert.equal(draft.module_templates_sha256, await fingerprintDocument(sample));
});

test('rejects an empty module goal draft and a mismatched fingerprint', async () => {
  const valid = await buildModuleGoalDraft({
    moduleTemplates: sample,
    rootSource: 'current_workspace',
    draftRevision: 'draft-2',
    updatedAt: draftTimestamp,
    updatedBy: 'admin@example.com',
  });
  await assert.rejects(
    validateModuleGoalDraft({ ...valid, module_templates: { ...sample, modules: {} } }),
    /modules 必须包含至少一个规格/,
  );
  await assert.rejects(
    validateModuleGoalDraft({ ...valid, module_templates_sha256: `sha256:${'0'.repeat(64)}` }),
    /module_templates_sha256 与 module_templates 不一致/,
  );
  await assert.rejects(
    validateModuleGoalDraft({ ...valid, unexpected: true }),
    /模块目标草稿包含未知字段/,
  );
});

test('migrates module goals from an existing final bundle without carrying theme fields', async () => {
  const draft = await moduleGoalDraftFromConfigBundle({
    schema: 'pcg-modules-config-bundle',
    root_source: 'houdini_package',
    sync_revision: 'published-7',
    module_templates: sample,
    theme_config: themeConfigSample,
  }, {
    draftRevision: 'draft-migrated-7',
    updatedAt: draftTimestamp,
    updatedBy: 'admin@example.com',
  });
  assert.equal(draft.draft_revision, 'draft-migrated-7');
  assert.equal(draft.root_source, 'houdini_package');
  assert.deepEqual(draft.module_templates, sample);
  assert.equal('theme_config' in draft, false);
  await validateModuleGoalDraft(draft);
});

test('adds an unscanned saved theme as a grey status scope without writing scanner data', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: { '12x16': { Room: { '01': ['01'] } } } },
  };
  const result = modulesApi.mergeThemeStatusScopes(document, [], [{
    scope_id: 'theme-scjgb', asset_prefix: 'SCJGB', spec_id: 'mixed_u4',
  }]);

  assert.deepEqual(result, [{
    scope_id: 'theme-scjgb', asset_prefix: 'SCJGB', spec_id: 'mixed_u4',
    target_count: 1, status_source: 'theme_config',
  }]);
});

test('stale legacy full-scope rows preserve evidence only while target identities remain recoverable', () => {
  const legacyStatus = {
    spec_id: 'modular_m28_u4_r12',
    asset_prefix: 'YWMD',
    target_count: 2,
    missing_maps: ['Map_YWMD_Area_Base_1x1_3_02_01'],
    missing_blueprints: ['BP_YWMD_Area_Base_1x1_3_01_01'],
    map_bp_state: 'different',
  };

  assert.deepEqual(
    modulesApi.reconcileModuleWorkItemStatuses(sample, legacyStatus)
      .map(item => [item.name, item.scanned, item.mapExists, item.bpExists]),
    [
      ['YWMD_Area_Base_1x1_3_01_01', true, true, false],
      ['YWMD_Area_Base_1x1_3_02_01', true, false, true],
    ],
  );

  const expanded = structuredClone(sample);
  expanded.modules.modular_m28_u4_r12.Area['1x1'].Base['3'].push(3);
  assert.throws(
    () => modulesApi.reconcileModuleWorkItemStatuses(expanded, legacyStatus),
    /目标范围.*重新扫描/,
  );
});

test('summarizes independent Map and BP presence for scope and group headers', () => {
  assert.deepEqual(modulesApi.summarizeModuleWorkItemStatuses([
    { mapExists: true, bpExists: true },
    { mapExists: true, bpExists: false },
    { mapExists: false, bpExists: true },
    { mapExists: false, bpExists: false },
  ]), { mapPresent: 2, bpPresent: 2, bpApplicable: true, targetTotal: 4, total: 4, skipped: 0 });
  assert.deepEqual(modulesApi.summarizeModuleWorkItemStatuses([
    { mapExists: true, bpExists: null },
    { mapExists: false, bpExists: null },
  ]), { mapPresent: 1, bpPresent: 0, bpApplicable: false, targetTotal: 2, total: 2, skipped: 0 });
  assert.deepEqual(modulesApi.summarizeModuleWorkItemStatuses([
    { mapExists: false, bpExists: false, skipped: true },
  ]), { mapPresent: 0, bpPresent: 0, bpApplicable: true, targetTotal: 1, total: 0, skipped: 1 });
});

test('blue progress-detail targets skip every matching concrete variant and leave unmatched items active', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: {
        Area: { '1x1': { Base: { '7': [1, 2] } } },
        End: { '1x1': { Huge: { '1': [1] } } },
      },
    },
  };
  const status = {
    spec_id: 'modular_m28_u4_r12',
    asset_prefix: 'YWMD',
    target_count: 3,
    work_item_names: [
      'YWMD_Area_Base_1x1_7_01_01',
      'YWMD_Area_Base_1x1_7_02_01',
      'YWMD_End_Huge_1x1_1_01_01',
    ],
    missing_maps: [
      'Map_YWMD_Area_Base_1x1_7_02_01',
      'Map_YWMD_End_Huge_1x1_1_01_01',
    ],
    missing_blueprints: ['BP_YWMD_Area_Base_1x1_7_01_01'],
    map_bp_state: 'different',
  };
  const items = modulesApi.buildModuleWorkItemStatuses(document, status, ['Area_Base_1x1_7']);
  assert.deepEqual(items.map(item => [item.name, item.skipped]), [
    ['YWMD_Area_Base_1x1_7_01_01', true],
    ['YWMD_Area_Base_1x1_7_02_01', true],
    ['YWMD_End_Huge_1x1_1_01_01', false],
  ]);
  assert.deepEqual(modulesApi.summarizeModuleWorkItemStatuses(items), {
    mapPresent: 0,
    bpPresent: 1,
    bpApplicable: true,
    targetTotal: 3,
    total: 1,
    skipped: 2,
  });
});

test('groups modular scanner work items by the template tree module type', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: {
        Area: { '1x1': { Base: { '3': [1, 2] } } },
        End: { '1x1': { Base: { '1': [1] } } },
      },
    },
  };
  const status = {
    spec_id: 'modular_m28_u4_r12', asset_prefix: 'YWMD', target_count: 3,
    work_item_names: [
      'YWMD_End_Base_1x1_1_01_01',
      'YWMD_Area_Base_1x1_3_02_01',
      'YWMD_Area_Base_1x1_3_01_01',
    ],
    missing_maps: ['Map_YWMD_Area_Base_1x1_3_02_01'],
    missing_blueprints: ['BP_YWMD_End_Base_1x1_1_01_01'],
    map_bp_state: 'different',
  };
  const groups = modulesApi.buildModuleWorkItemGroups(document, status);
  assert.deepEqual(groups.map(group => [group.key, group.label, group.items.length]), [
    ['Area', 'Area', 2], ['End', 'End', 1],
  ]);
  assert.deepEqual(groups.map(group => group.summary), [
    { mapPresent: 1, bpPresent: 2, bpApplicable: true, targetTotal: 2, total: 2, skipped: 0 },
    { mapPresent: 1, bpPresent: 0, bpApplicable: true, targetTotal: 1, total: 1, skipped: 0 },
  ]);
});

test('groups modular work items by the selected three physical fields', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: {
        Area: { '1x1': { Base: { '3': [1], '7': [1] } }, '1x2': { Large: { '9': [1] } } },
        End: { '1x1': { Base: { '1': [1] } } },
      },
    },
  };
  const names = listModuleTargets(document, 'modular_m28_u4_r12').map(target => `YWMD_${target.name.slice('Module_'.length)}`);
  const groups = modulesApi.buildModuleWorkItemGroups(document, {
    spec_id: 'modular_m28_u4_r12', asset_prefix: 'YWMD', target_count: names.length,
    work_item_names: names, missing_maps: names.map(name => `Map_${name}`), missing_blueprints: [], map_bp_state: 'not_applicable',
  }, ['moduleType', 'size', 'areaLevel']);
  assert.deepEqual(groups.map(group => [group.key, group.label, group.level, group.parentKey]), [
    ['Area', 'Area', 1, null], ['Area/1x1', '1x1', 2, 'Area'], ['Area/1x1/Base', 'Base', 3, 'Area/1x1'],
    ['Area/1x2', '1x2', 2, 'Area'], ['Area/1x2/Large', 'Large', 3, 'Area/1x2'],
    ['End', 'End', 1, null], ['End/1x1', '1x1', 2, 'End'], ['End/1x1/Base', 'Base', 3, 'End/1x1'],
  ]);
  assert.equal(groups.find(group => group.key === 'Area/1x1/Base').items.length, 2);
});

test('supports one, two, and three physical grouping fields without duplicate levels', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: {
        Area: { '1x1': { Base: { '3': [1], '6': [1] } } },
      },
    },
  };
  const names = listModuleTargets(document, 'modular_m28_u4_r12').map(target => `YWMD_${target.name.slice('Module_'.length)}`);
  const status = {
    spec_id: 'modular_m28_u4_r12', asset_prefix: 'YWMD', target_count: names.length,
    work_item_names: names, missing_maps: [], missing_blueprints: [], map_bp_state: 'not_applicable',
  };
  assert.deepEqual(modulesApi.buildModuleWorkItemGroups(document, status, ['size']).map(group => group.key), ['1x1']);
  assert.deepEqual(modulesApi.buildModuleWorkItemGroups(document, status, []).map(group => group.key), ['__all__']);
  assert.deepEqual(modulesApi.buildModuleWorkItemGroups(document, status, ['moduleType']).map(group => group.key), ['Area']);
  assert.deepEqual(
    modulesApi.buildModuleWorkItemGroups(document, status, ['moduleType', 'opening']).map(group => group.key),
    ['Area', 'Area/3', 'Area/6'],
  );
  assert.equal(
    modulesApi.buildModuleWorkItemGroups(document, status, ['moduleType', 'opening'])
      .find(group => group.key === 'Area').summary.targetTotal,
    2,
  );
  assert.equal(
    modulesApi.buildModuleWorkItemGroups(document, status, ['moduleType', 'size', 'opening'])
      .find(group => group.key === 'Area/1x1').summary.targetTotal,
    2,
  );
  assert.deepEqual(
    modulesApi.buildModuleWorkItemGroups(document, status, ['moduleType', 'moduleType', 'opening']).map(group => group.key),
    ['Area', 'Area/3', 'Area/6'],
  );
  assert.deepEqual(
    modulesApi.buildModuleWorkItemGroups(document, status, ['unknown', 'opening']).map(group => group.key),
    ['3', '6'],
  );
});

test('groups mixed work items by all selected physical fields', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: { '12x12': { Book: { '01': ['01', '02'] } } } },
  };
  const names = listModuleTargets(document, 'mixed_u4').map(target => `XXGCB_${target.name.slice('Module_'.length)}`);
  const groups = modulesApi.buildModuleWorkItemGroups(document, {
    spec_id: 'mixed_u4', asset_prefix: 'XXGCB', target_count: names.length,
    work_item_names: names, missing_maps: [names[1].replace(/^/, 'Map_')], missing_blueprints: [], map_bp_state: 'not_applicable',
  }, ['size', 'roomType', 'ctg']);
  assert.deepEqual(groups.map(group => group.key), ['12x12', '12x12/Book', '12x12/Book/01']);
  assert.deepEqual(groups.at(-1).summary, { mapPresent: 1, bpPresent: 0, bpApplicable: false, targetTotal: 2, total: 2, skipped: 0 });
});

test('groups mixed scanner work items by their template size without using the theme prefix', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      mixed_u4: {
        '12x12': { Book: { '01': ['01', '02'] } },
        '16x16': { Bed: { '02': ['01'] } },
      },
    },
  };
  const status = {
    spec_id: 'mixed_u4', asset_prefix: 'XXGCB', target_count: 3,
    work_item_names: [
      'XXGCB_Room_12x12_Book_01_01_01',
      'XXGCB_Room_12x12_Book_01_02_01',
      'XXGCB_Room_16x16_Bed_02_01_01',
    ],
    missing_maps: ['Map_XXGCB_Room_16x16_Bed_02_01_01'],
    missing_blueprints: [],
    map_bp_state: 'not_applicable',
  };
  const groups = modulesApi.buildModuleWorkItemGroups(document, status);
  assert.deepEqual(groups.map(group => [group.key, group.label, group.items.length]), [
    ['12x12', '12x12', 2], ['16x16', '16x16', 1],
  ]);
  assert.equal(groups[0].items[0].name, 'XXGCB_Room_12x12_Book_01_01_01');
  assert.deepEqual(groups.reduce((sum, group) => sum + group.items.length, 0), 3);
});

test('sorts mixed work items and size groups by both numeric dimensions', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      mixed_u4: {
        '52x52': { Book: { '15': ['03', '01'] } },
        '12x16': { Book: { '06': ['01'] } },
        '12x12': { Book: { '01': ['01'] } },
        '8x16': { Book: { '02': ['01'] } },
      },
    },
  };
  const names = listModuleTargets(document, 'mixed_u4').map(target => `Module_${target.name.slice('Module_'.length)}`);
  const status = {
    spec_id: 'mixed_u4', asset_prefix: 'Module', target_count: names.length,
    work_item_names: [...names].reverse(), missing_maps: [], missing_blueprints: [], map_bp_state: 'not_applicable',
  };
  const groups = modulesApi.buildModuleWorkItemGroups(document, status, ['roomType', 'size']);
  assert.deepEqual(groups.filter(group => group.level === 2).map(group => group.label), [
    '8x16', '12x12', '12x16', '52x52',
  ]);
  assert.deepEqual(groups.find(group => group.key === 'Book/52x52').items.map(item => item.name), [
    'Module_Room_52x52_Book_15_01_01',
    'Module_Room_52x52_Book_15_03_01',
  ]);
});

test('reconciles a stale theme scan with current targets and marks new work items missing', () => {
  const oldDocument = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: { '12x12': { Book: { '01': ['01'] } } } },
  };
  const currentDocument = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: {
      '12x12': { Book: { '01': ['01'] } },
      '52x52': { Book: { '15': ['01', '02', '03'] } },
    } },
  };
  const oldNames = listModuleTargets(oldDocument, 'mixed_u4').map(target => `XXGCB_${target.name.slice('Module_'.length)}`);
  const status = {
    spec_id: 'mixed_u4', asset_prefix: 'XXGCB', target_count: oldNames.length,
    work_item_names: oldNames, missing_maps: [], missing_blueprints: [], map_bp_state: 'different',
  };
  const items = modulesApi.reconcileModuleWorkItemStatuses(currentDocument, status);
  assert.deepEqual(items.map(item => [item.name, item.mapExists, item.bpExists, item.scanned]), [
    ['XXGCB_Room_12x12_Book_01_01_01', true, true, true],
    ['XXGCB_Room_52x52_Book_15_01_01', false, false, false],
    ['XXGCB_Room_52x52_Book_15_02_01', false, false, false],
    ['XXGCB_Room_52x52_Book_15_03_01', false, false, false],
  ]);
});

test('lists one display definition per leaf with its variant count', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [1, 2, 4] } } } },
      mixed_u4: { '12x12': { Book: { '01': ['01', '03'] } } },
    },
  };
  assert.deepEqual(
    listModuleDefinitions(document, 'modular_m28_u4_r12').map(item => [item.group, item.name, item.variantCount]),
    [['Area', 'Module_Area_Base_1x1_3', 3]],
  );
  assert.deepEqual(
    listModuleDefinitions(document, 'mixed_u4').map(item => [item.group, item.name, item.variantCount]),
    [['12x12', 'Module_Room_12x12_Book_01', 2]],
  );
});

test('adds only a new definition and never appends to an existing leaf', () => {
  const added = addModuleDefinition(sample, 'modular_m28_u4_r12', {
    moduleType: 'Area', size: '1x1', areaLevel: 'Base', opening: '4',
  });
  assert.deepEqual(added.modules.modular_m28_u4_r12.Area['1x1'].Base['4'], [1]);

  const withoutOne = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [2] } } } } },
  };
  assert.throws(
    () => addModuleDefinition(withoutOne, 'modular_m28_u4_r12', {
      moduleType: 'Area', size: '1x1', areaLevel: 'Base', opening: '3',
    }),
    /模板定义已存在/,
  );
});

test('adds an empty modular or mixed size without creating a definition', () => {
  const modular = addModuleSize(sample, 'modular_m28_u4_r12', {
    moduleType: 'Area', size: '1x2',
  });
  assert.deepEqual(modular.modules.modular_m28_u4_r12.Area['1x2'], {});
  assert.equal(countTargets(modular), 2);

  const mixedSource = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: { '12x12': { Book: { '01': ['01'] } } } },
  };
  const mixed = addModuleSize(mixedSource, 'mixed_u4', { size: '12x16' });
  assert.deepEqual(mixed.modules.mixed_u4['12x16'], {});
  assert.equal(countTargets(mixed), 1);
  assert.doesNotThrow(() => validateDocument(mixed));
});

test('lists and removes sizes as their own data level', () => {
  const withEmpty = addModuleSize(sample, 'modular_m28_u4_r12', {
    moduleType: 'Start', size: '1x1',
  });
  assert.deepEqual(
    listModuleSizes(withEmpty, 'modular_m28_u4_r12').map(item => [item.group, item.size, item.variantCount]),
    [['Area', '1x1', 2], ['Start', '1x1', 0]],
  );
  const removed = removeModuleSize(withEmpty, 'modular_m28_u4_r12', {
    moduleType: 'Start', size: '1x1',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(removed.modules.modular_m28_u4_r12, 'Start'), false);
});

test('rejects adding a duplicate size only inside its actual parent level', () => {
  assert.throws(
    () => addModuleSize(sample, 'modular_m28_u4_r12', {
      moduleType: 'Area', size: '1x1',
    }),
    /尺寸 1x1 已存在/,
  );
  assert.doesNotThrow(() => addModuleSize(sample, 'modular_m28_u4_r12', {
    moduleType: 'Start', size: '1x1',
  }));
});

test('removing the last definition preserves its size until the size is explicitly removed', () => {
  const single = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [1] } } } } },
  };
  const removed = removeModuleDefinition(single, ['modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3']);
  assert.deepEqual(removed.modules.modular_m28_u4_r12.Area['1x1'], {});
  assert.doesNotThrow(() => validateDocument(removed));
});

test('changes the real variant array while keeping one as the minimum', () => {
  const leafPath = ['modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3'];
  const increased = changeModuleVariantCount(sample, leafPath, 1);
  assert.deepEqual(increased.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1, 2, 3]);
  assert.equal(countTargets(increased), 3);

  const decreased = changeModuleVariantCount(increased, leafPath, -1);
  assert.deepEqual(decreased.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1, 2]);
  const one = changeModuleVariantCount(decreased, leafPath, -1);
  const stillOne = changeModuleVariantCount(one, leafPath, -1);
  assert.deepEqual(one.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1]);
  assert.deepEqual(stillOne.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1]);
  assert.deepEqual(sample.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1, 2]);
});

test('sets the real variant array length from a numeric count input', () => {
  const leafPath = ['modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3'];
  const increased = setModuleVariantCount(sample, leafPath, 4);
  assert.deepEqual(increased.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1, 2, 3, 4]);
  const reduced = setModuleVariantCount(increased, leafPath, 1);
  assert.deepEqual(reduced.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1]);
  assert.throws(() => setModuleVariantCount(sample, leafPath, 0), /变体数量.*至少为 1/);
  assert.throws(() => setModuleVariantCount(sample, leafPath, 1.5), /变体数量.*整数/);
  const oneHundred = setModuleVariantCount(sample, leafPath, 100);
  assert.equal(oneHundred.modules.modular_m28_u4_r12.Area['1x1'].Base['3'].length, 100);
  assert.deepEqual(oneHundred.modules.modular_m28_u4_r12.Area['1x1'].Base['3'].slice(-3), [98, 99, 100]);
});

test('mixed variant count uses the next free two-digit value and respects 99', () => {
  const path = ['modules', 'mixed_u4', '12x12', 'Book', '01'];
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: { '12x12': { Book: { '01': ['01', '03'] } } } },
  };
  const increased = changeModuleVariantCount(document, path, 1);
  assert.deepEqual(increased.modules.mixed_u4['12x12'].Book['01'], ['01', '03', '02']);
  const full = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: { '12x12': { Book: { '01': Array.from({ length: 99 }, (_, index) => String(index + 1).padStart(2, '0')) } } } },
  };
  assert.throws(() => changeModuleVariantCount(full, path, 1), /变体数量.*不能超过 99/);
  assert.throws(() => setModuleVariantCount(document, path, 100), /变体数量.*不能超过 99/);
});

test('updates one complete definition without losing or merging its variants', () => {
  const leafPath = ['modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3'];
  const updated = updateModuleDefinition(sample, leafPath, {
    moduleType: 'Area', size: '1x2', areaLevel: 'Huge', opening: '6',
  });
  assert.deepEqual(updated.modules.modular_m28_u4_r12, {
    Area: { '1x1': {}, '1x2': { Huge: { '6': [1, 2] } } },
  });
  assert.deepEqual(sample.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1, 2]);

  const occupied = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [1], '4': [2] } } } } },
  };
  assert.throws(
    () => updateModuleDefinition(
      occupied,
      ['modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3'],
      { moduleType: 'Area', size: '1x1', areaLevel: 'Base', opening: '4' },
    ),
    /模板定义已存在/,
  );
});

test('removes one complete definition while preserving its size', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: {
        Area: { '1x1': { Base: { '3': [1, 2] } } },
        Start: { '1x1': { Base: { '1': [1] } } },
      },
    },
  };
  const removed = removeModuleDefinition(
    document,
    ['modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3'],
  );
  assert.deepEqual(removed.modules.modular_m28_u4_r12, {
    Area: { '1x1': {} },
    Start: { '1x1': { Base: { '1': [1] } } },
  });
  assert.equal(countTargets(removed), 1);
});

test('adds and updates complete targets while preserving obsolete size nodes', () => {
  const draft = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { modular_m28_u4_r12: {} },
  };
  const added = addModuleTarget(draft, 'modular_m28_u4_r12', {
    moduleType: 'Outer', size: '1x1', areaLevel: 'Base', opening: '0', variant: '2',
  });
  const [target] = listModuleTargets(added, 'modular_m28_u4_r12');
  assert.equal(target.name, 'Module_Outer_Base_1x1_0_02_01');

  const updated = updateModuleTarget(added, target.path, {
    moduleType: 'Area', size: '1x2', areaLevel: 'Huge', opening: '6', variant: '3',
  });
  assert.deepEqual(Object.keys(updated.modules.modular_m28_u4_r12), ['Outer', 'Area']);
  assert.deepEqual(updated.modules.modular_m28_u4_r12.Outer['1x1'], {});
  assert.equal(
    listModuleTargets(updated, 'modular_m28_u4_r12')[0].name,
    'Module_Area_Huge_1x2_6_03_01',
  );
});

test('editing a target in the same leaf preserves its position', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [1, 2, 3] } } } } },
  };
  const unchanged = updateModuleTarget(document, [
    'modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3', '0',
  ], { moduleType: 'Area', size: '1x1', areaLevel: 'Base', opening: '3', variant: '1' });
  assert.deepEqual(unchanged.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1, 2, 3]);

  const changed = updateModuleTarget(document, [
    'modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3', '0',
  ], { moduleType: 'Area', size: '1x1', areaLevel: 'Base', opening: '3', variant: '4' });
  assert.deepEqual(changed.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [4, 2, 3]);
});

test('removes a concrete target and only reorders variants in its actual leaf', () => {
  const moved = moveModuleTarget(sample, [
    'modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3', '1',
  ], -1);
  assert.deepEqual(moved.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [2, 1]);

  const removed = removeModuleTarget(moved, [
    'modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3', '0',
  ]);
  assert.deepEqual(removed.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1]);
  assert.deepEqual(sample.modules.modular_m28_u4_r12.Area['1x1'].Base['3'], [1, 2]);
});

test('rejects empty arrays and unsupported schema', () => {
  assert.throws(() => validateDocument({ ...sample, schema: 'registry' }), /schema/);
  assert.throws(() => validateDocument({ ...sample, modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [] } } } } } }), /非空数组/);
});

test('matches the ImportTool grammar for specs, sizes, levels, openings and variants', () => {
  const cases = [
    [{ ...sample, modules: { modular_m0_u4_r12: sample.modules.modular_m28_u4_r12 } }, /规格数值/],
    [{ ...sample, modules: { modular_m28_u4_r12: { Area: { '0x1': { Base: { '0': [1] } } } } } }, /尺寸格式/],
    [{ ...sample, modules: { modular_m28_u4_r12: { Area: { '1x1': { Tiny: { '0': [1] } } } } } }, /面积等级/],
    [{ ...sample, modules: { modular_m28_u4_r12: { Outer: { '1x1': { Small: { '0': [1] } } } } } }, /Outer.*Base\/Huge/],
    [{ ...sample, modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '16': [1] } } } } } }, /开口状态/],
    [{ ...sample, modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': ['1'] } } } } } }, /模块式变体/],
    [{ schema: 'pcg-modules-templates', schema_version: 2, modules: { mixed_u4: { '12x12': { Room: { '01': [''] } } } } }, /混合式变体/],
    [{ schema: 'pcg-modules-templates', schema_version: 2, modules: { mixed_u4: { '12x12': { Room: { '01': ['00'] } } } } }, /混合式变体/],
    [{ schema: 'pcg-modules-templates', schema_version: 2, modules: { mixed_u4: { '12x12': { Room: { '01': ['1'] } } } } }, /混合式变体/],
    [{ schema: 'pcg-modules-templates', schema_version: 2, modules: { mixed_u8: { '12x16': { Room: { '01': ['01'] } } } } }, /单位长度.*整除/],
    [{ schema: 'pcg-modules-templates', schema_version: 2, modules: { mixed_u4: { '12x12': { 'Book/Secret': { '01': ['01'] } } } } }, /英文字母和数字/],
    [{ schema: 'pcg-modules-templates', schema_version: 2, modules: { mixed_u4: { '12x12': { 'Book Name': { '01': ['01'] } } } } }, /英文字母和数字/],
  ];
  for (const [document, pattern] of cases) assert.throws(() => validateDocument(document), pattern);
});

test('module specification operations use direct business APIs', () => {
  for (const name of [
    'addModuleSpec', 'renameModuleSpec', 'removeModuleSpec',
    'moveModuleSpec', 'renameModuleGroup', 'removeModuleGroup',
    'moveModuleGroup', 'getDefaultModuleTarget', 'getNextModuleVariant',
    'listModuleDefinitions', 'changeModuleVariantCount',
  ]) assert.equal(typeof modulesApi[name], 'function', `缺少 ${name}`);

  let edited = modulesApi.addModuleSpec(sample, 'mixed_u4');
  assert.deepEqual(Object.keys(edited.modules), ['modular_m28_u4_r12', 'mixed_u4']);
  edited = modulesApi.renameModuleSpec(edited, 'mixed_u4', 'mixed_u8');
  assert.deepEqual(Object.keys(edited.modules), ['modular_m28_u4_r12', 'mixed_u8']);
  edited = modulesApi.moveModuleSpec(edited, 'mixed_u8', -1);
  assert.deepEqual(Object.keys(edited.modules), ['mixed_u8', 'modular_m28_u4_r12']);
  edited = modulesApi.removeModuleSpec(edited, 'mixed_u8');
  assert.deepEqual(edited, sample);

  const grouped = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { modular_m28_u4_r12: {
      Area: { '1x1': { Base: { '3': [1] } } },
      Start: { '1x1': { Base: { '3': [1] } } },
    } },
  };
  const movedGroup = modulesApi.moveModuleGroup(grouped, 'modular_m28_u4_r12', 'Start', -1);
  assert.deepEqual(Object.keys(movedGroup.modules.modular_m28_u4_r12), ['Start', 'Area']);
  assert.equal(modulesApi.getNextModuleVariant(grouped, [
    'modules', 'modular_m28_u4_r12', 'Area', '1x1', 'Base', '3', '0',
  ]), '2');
});

test('module groups can be renamed and removed without changing sibling order', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { modular_m28_u4_r12: {
      Area: { '1x1': { Base: { '3': [1] } } },
      Start: { '1x1': { Base: { '3': [1] } } },
    } },
  };
  const renamed = modulesApi.renameModuleGroup(document, 'modular_m28_u4_r12', 'Start', 'End');
  assert.deepEqual(Object.keys(renamed.modules.modular_m28_u4_r12), ['Area', 'End']);
  assert.throws(
    () => modulesApi.renameModuleGroup(document, 'modular_m28_u4_r12', 'Start', 'Area'),
    /分组已存在/,
  );
  const removed = modulesApi.removeModuleGroup(renamed, 'modular_m28_u4_r12', 'Area');
  assert.deepEqual(Object.keys(removed.modules.modular_m28_u4_r12), ['End']);
  assert.deepEqual(Object.keys(document.modules.modular_m28_u4_r12), ['Area', 'Start']);
});

test('empty mixed specifications receive a valid unit-aware first target', () => {
  for (const spec of ['mixed_u4', 'mixed_u6', 'mixed_u8']) {
    const fields = modulesApi.getDefaultModuleTarget(spec);
    const document = {
      schema: 'pcg-modules-templates', schema_version: 2, modules: { [spec]: {} },
    };
    const edited = modulesApi.addModuleTarget(document, spec, fields);
    assert.doesNotThrow(() => validateDocument(edited), `${spec} 默认目标必须合法`);
  }
  assert.equal(modulesApi.getDefaultModuleTarget('mixed_u8').size, '8x8');
  assert.equal(modulesApi.getDefaultModuleTarget('mixed_u6').size, '12x12');
});

test('non-empty specifications cannot be renamed across generation kinds', () => {
  assert.throws(
    () => modulesApi.renameModuleSpec(sample, 'modular_m28_u4_r12', 'mixed_u4'),
    /非空规格.*类型/,
  );
});

test('mixed variants report exhaustion instead of returning 100', () => {
  const variants = Array.from({ length: 99 }, (_, index) => String(index + 1).padStart(2, '0'));
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: { mixed_u4: { '12x12': { Room: { '01': variants } } } },
  };
  assert.throws(
    () => modulesApi.getNextModuleVariant(document, [
      'modules', 'mixed_u4', '12x12', 'Room', '01', '0',
    ]),
    /01-99.*用完/,
  );
});

test('legacy generic tree editor APIs are not part of the product contract', () => {
  for (const name of [
    'documentToTree', 'documentToTreeDraft', 'treeToDocument', 'createEmptyDocument',
    'addObjectChild', 'addArrayValue', 'setArrayValue', 'removeNode', 'renameNode', 'moveNode',
  ]) assert.equal(Object.hasOwn(modulesApi, name), false, `${name} 不应继续导出`);
});

test('accepts large opening masks without Number precision loss', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: {
        Area: { '14x14': { Huge: { '72057594037927935': [1] } } },
      },
    },
  };
  assert.doesNotThrow(() => validateDocument(document));
});

test('matches Python canonical numbers and rejects duplicate JSON keys', async () => {
  assert.throws(
    () => validateDocument({ ...sample, modules: { modular_m028_u4_r12: sample.modules.modular_m28_u4_r12 } }),
    /规范十进制/,
  );
  assert.throws(
    () => validateDocument({ ...sample, modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '03': [1] } } } } } }),
    /开口状态/,
  );
  assert.throws(
    () => validateDocument({ ...sample, modules: { modular_m28_u4_r12: { Area: { '1x1': { Base: { '3': [9007199254740992] } } } } } }),
    /模块式变体/,
  );
  assert.throws(
    () => parseDocumentText('{"schema":"pcg-modules-templates","schema_version":2,"modules":{},"modules":{}}'),
    /重复键/,
  );
  assert.equal(
    await fingerprintDocument(sample),
    'sha256:56e4b6731035414b75b58ff2bfe34b46b9ac13ed895381b3932134936b51ecda',
  );
});

test('rejects unknown document fields', () => {
  assert.throws(() => validateDocument({ ...sample, quantity: 2 }), /未知字段/);
});

test('rejects invalid target values during direct add and edit', () => {
  assert.throws(() => addModuleTarget(sample, 'modular_m28_u4_r12', {
    moduleType: 'Area', size: '1x1', areaLevel: 'Base', opening: '3', variant: '0',
  }), /模块式变体/);
  const mixed = { schema: 'pcg-modules-templates', schema_version: 2, modules: { mixed_u4: {} } };
  assert.throws(() => addModuleTarget(mixed, 'mixed_u4', {
    size: '12x12', roomType: 'Room', ctg: '01', variant: '1',
  }), /混合式变体/);
});

test('marks scanner rows stale when the target or latest theme config fingerprint changes', () => {
  const targetFingerprint = 'sha256:' + 'a'.repeat(64);
  const oldConfig = 'sha256:' + 'b'.repeat(64);
  const currentConfig = 'sha256:' + 'c'.repeat(64);
  const rows = [
    { template_fingerprint: targetFingerprint, theme_config_fingerprint: oldConfig, scanned_at: '2026-08-11T10:00:00Z' },
    { template_fingerprint: targetFingerprint, theme_config_fingerprint: currentConfig, scanned_at: '2026-08-11T11:00:00Z' },
    { template_fingerprint: 'sha256:' + 'd'.repeat(64), theme_config_fingerprint: 'sha256:' + 'e'.repeat(64), scanned_at: '2026-08-11T12:00:00Z' },
  ];
  assert.equal(modulesApi.latestThemeConfigFingerprint(rows, targetFingerprint), currentConfig);
  assert.equal(modulesApi.isScannerStatusStale(rows[0], targetFingerprint, currentConfig), true);
  assert.equal(modulesApi.isScannerStatusStale(rows[1], targetFingerprint, currentConfig), false);
  assert.equal(modulesApi.isScannerStatusStale(rows[2], targetFingerprint, currentConfig), true);
  assert.equal(modulesApi.isScannerStatusStale({}, targetFingerprint, currentConfig), true);
});

test('builds and validates the complete dual-authoritative Firestore bundle', async () => {
  assert.equal(typeof modulesApi.buildConfigBundle, 'function');
  assert.equal(typeof modulesApi.validateConfigBundle, 'function');
  assert.equal(typeof modulesApi.validateThemeConfig, 'function');
  const timestamp = { toDate() { return new Date('2026-08-20T00:00:00Z'); } };
  const record = await modulesApi.buildConfigBundle({
    themeConfig: themeConfigSample,
    moduleTemplates: sample,
    rootSource: 'houdini_package',
    syncRevision: 'revision-20260820',
    updatedAt: timestamp,
    updatedBy: 'admin@example.com',
  });
  assert.equal(record.schema, 'pcg-modules-config-bundle');
  assert.equal(record.schema_version, 1);
  assert.equal(record.root_source, 'houdini_package');
  assert.equal(record.sync_revision, 'revision-20260820');
  assert.equal(record.theme_config_sha256, 'sha256:4f93f7f31e8339511c4d872819f8eb676b687574d7f9acdfd680bb6f7078cf7a');
  assert.equal(record.module_templates_sha256, 'sha256:56e4b6731035414b75b58ff2bfe34b46b9ac13ed895381b3932134936b51ecda');
  assert.equal((await modulesApi.validateConfigBundle(record)).module_templates_sha256, record.module_templates_sha256);
  await assert.rejects(modulesApi.validateConfigBundle({ ...record, extra: true }), /未知字段/);
  await assert.rejects(modulesApi.validateConfigBundle({ ...record, theme_config_sha256: `sha256:${'0'.repeat(64)}` }), /theme_config_sha256/);
  await assert.rejects(modulesApi.validateConfigBundle({ ...record, module_templates_sha256: `sha256:${'0'.repeat(64)}` }), /module_templates_sha256/);
  await assert.rejects(modulesApi.validateConfigBundle({ ...record, sync_revision: '' }), /sync_revision/);
  await assert.rejects(modulesApi.validateConfigBundle({ ...record, root_source: 'invalid' }), /root_source/);
  const missingRoot = { ...record };
  delete missingRoot.root_source;
  await assert.rejects(modulesApi.validateConfigBundle(missingRoot), /未知字段|缺少字段/);
  await assert.rejects(modulesApi.validateConfigBundle({ ...record, theme_config: {} }), /Theme_Registry/);
});

test('repairs a legacy bundle that only lacks root_source without replacing either document', async () => {
  const timestamp = { toDate() { return new Date('2026-08-20T00:00:00Z'); } };
  const record = await modulesApi.buildConfigBundle({
    themeConfig: themeConfigSample,
    moduleTemplates: sample,
    rootSource: 'houdini_package',
    syncRevision: 'revision-20260820',
    updatedAt: timestamp,
    updatedBy: 'admin@example.com',
  });
  const legacy = { ...record };
  delete legacy.root_source;

  const normalized = await modulesApi.normalizeConfigBundleForRead(legacy, 'houdini_package');

  assert.equal(normalized.migrated, true);
  assert.equal(normalized.record.root_source, 'houdini_package');
  assert.strictEqual(normalized.record.theme_config, legacy.theme_config);
  assert.strictEqual(normalized.record.module_templates, legacy.module_templates);
  assert.equal((await modulesApi.validateConfigBundle(normalized.record)).sync_revision, record.sync_revision);
});

test('does not hide other bundle corruption behind the root_source migration', async () => {
  const timestamp = { toDate() { return new Date('2026-08-20T00:00:00Z'); } };
  const record = await modulesApi.buildConfigBundle({
    themeConfig: themeConfigSample,
    moduleTemplates: sample,
    rootSource: 'houdini_package',
    syncRevision: 'revision-20260820',
    updatedAt: timestamp,
    updatedBy: 'admin@example.com',
  });
  const corrupted = { ...record, module_templates_sha256: `sha256:${'0'.repeat(64)}` };
  delete corrupted.root_source;

  await assert.rejects(
    modulesApi.normalizeConfigBundleForRead(corrupted, 'houdini_package'),
    /module_templates_sha256/,
  );
});

test('rejects the removed single-template Firestore record contract', async () => {
  const record = {
    document: sample,
    content_sha256: await fingerprintDocument(sample),
    updated_at: { toDate() { return new Date('2026-08-18T00:00:00Z'); } },
    updated_by: 'admin@example.com',
  };
  await assert.rejects(modulesApi.validateConfigBundle(record), /未知字段|缺少字段/);
});

test('classifies cloud snapshots without losing an unsynced draft', async () => {
  const baseFingerprint = 'sha256:' + 'a'.repeat(64);
  const draftFingerprint = 'sha256:' + 'b'.repeat(64);
  const record = fingerprint => ({
    module_templates: sample,
    module_templates_sha256: fingerprint,
    updated_at: { toDate() { return new Date('2026-08-18T00:00:00Z'); } },
    updated_by: 'admin@example.com',
  });
  assert.equal(modulesApi.decideCloudSnapshotAction({
    record: record(draftFingerprint), dirty: true, hasPendingWrites: false,
    draftFingerprint, baseFingerprint,
  }), 'ack');
  assert.equal(modulesApi.decideCloudSnapshotAction({
    record: record(baseFingerprint), dirty: true, hasPendingWrites: false,
    draftFingerprint, baseFingerprint,
  }), 'retry');
  assert.equal(modulesApi.decideCloudSnapshotAction({
    record: record('sha256:' + 'c'.repeat(64)), dirty: true, hasPendingWrites: false,
    draftFingerprint, baseFingerprint,
  }), 'conflict');
  assert.equal(modulesApi.decideCloudSnapshotAction({
    record: record(draftFingerprint), dirty: true, hasPendingWrites: true,
    draftFingerprint, baseFingerprint,
  }), 'wait');
  assert.equal(modulesApi.decideCloudSnapshotAction({
    record: record(baseFingerprint), dirty: false, hasPendingWrites: false,
    draftFingerprint: '', baseFingerprint,
  }), 'apply');
});

test('older async cloud snapshot work cannot apply after a newer snapshot starts', async () => {
  const sequence = createCloudSnapshotSequence();
  let releaseOlder;
  const olderWait = new Promise(resolve => { releaseOlder = resolve; });
  const applied = [];
  async function processSnapshot(name, waitFor) {
    const id = sequence.begin();
    await waitFor;
    if (!sequence.isCurrent(id)) return false;
    applied.push(name);
    return true;
  }

  const older = processSnapshot('older', olderWait);
  const newer = processSnapshot('newer', Promise.resolve());
  assert.equal(await newer, true);
  releaseOlder();
  assert.equal(await older, false);
  assert.deepEqual(applied, ['newer']);
});

test('a save completion can detect that a newer cloud snapshot advanced the sequence', () => {
  const sequence = createCloudSnapshotSequence();
  const versionAtSaveStart = sequence.current();
  sequence.begin();
  assert.equal(sequence.isCurrent(versionAtSaveStart), false);
});

test('normalizes Firestore specification order against current module specifications', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m32_u4_r16: {},
      modular_m28_u4_r12: {},
      mixed_u4: {},
    },
  };
  assert.deepEqual(modulesApi.normalizeModuleSpecOrder(document, [
    'mixed_u4', 'removed_spec', 'mixed_u4', 'modular_m32_u4_r16', 42,
  ]), [
    'mixed_u4', 'modular_m32_u4_r16', 'modular_m28_u4_r12',
  ]);
});

test('moves all three module specifications to every valid position without changing template data', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m32_u4_r16: {},
      modular_m28_u4_r12: {},
      mixed_u4: {},
    },
  };
  const original = Object.keys(document.modules);
  const cases = [
    ['modular_m32_u4_r16', 1, ['modular_m28_u4_r12', 'modular_m32_u4_r16', 'mixed_u4']],
    ['modular_m32_u4_r16', 2, ['modular_m28_u4_r12', 'mixed_u4', 'modular_m32_u4_r16']],
    ['modular_m28_u4_r12', -1, ['modular_m28_u4_r12', 'modular_m32_u4_r16', 'mixed_u4']],
    ['modular_m28_u4_r12', 1, ['modular_m32_u4_r16', 'mixed_u4', 'modular_m28_u4_r12']],
    ['mixed_u4', -2, ['mixed_u4', 'modular_m32_u4_r16', 'modular_m28_u4_r12']],
    ['mixed_u4', -1, ['modular_m32_u4_r16', 'mixed_u4', 'modular_m28_u4_r12']],
  ];
  for (const [spec, offset, expected] of cases) {
    assert.deepEqual(modulesApi.moveModuleSpecOrder(document, original, spec, offset), expected);
  }
  const firstMove = modulesApi.moveModuleSpecOrder(document, original, 'modular_m32_u4_r16', 2);
  assert.deepEqual(
    modulesApi.moveModuleSpecOrder(document, firstMove, 'modular_m28_u4_r12', 1),
    ['mixed_u4', 'modular_m28_u4_r12', 'modular_m32_u4_r16'],
  );
  assert.deepEqual(Object.keys(document.modules), original);
});

test('renaming a module specification keeps its saved display position', () => {
  const before = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m32_u4_r16: {},
      modular_m28_u4_r12: {},
      mixed_u4: {},
    },
  };
  const after = modulesApi.renameModuleSpec(before, 'modular_m28_u4_r12', 'modular_m28_u4_r16');
  assert.deepEqual(modulesApi.renameModuleSpecOrder(
    after,
    ['mixed_u4', 'modular_m28_u4_r12', 'modular_m32_u4_r16'],
    'modular_m28_u4_r12',
    'modular_m28_u4_r16',
  ), ['mixed_u4', 'modular_m28_u4_r16', 'modular_m32_u4_r16']);
});

test('renaming a module specification keeps every saved size position', () => {
  const before = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: { Area: { '1x1': {}, '1x2': {}, '2x2': {} } },
      mixed_u4: { '12x12': {} },
    },
  };
  const after = modulesApi.renameModuleSpec(before, 'modular_m28_u4_r12', 'modular_m32_u4_r12');
  assert.deepEqual(modulesApi.renameModuleSizeOrderForSpec(
    after,
    [{ spec: 'modular_m28_u4_r12', module_type: 'Area', sizes: ['2x2', '1x1', '1x2'] }],
    'modular_m28_u4_r12',
    'modular_m32_u4_r12',
  ), [
    { spec: 'modular_m32_u4_r12', module_type: 'Area', sizes: ['2x2', '1x1', '1x2'] },
    { spec: 'mixed_u4', module_type: '', sizes: ['12x12'] },
  ]);
});

test('renaming a modular group keeps its saved size positions', () => {
  const before = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      modular_m28_u4_r12: { Area: { '1x1': {}, '1x2': {}, '2x2': {} } },
    },
  };
  const after = modulesApi.renameModuleGroup(before, 'modular_m28_u4_r12', 'Area', 'End');
  assert.deepEqual(modulesApi.renameModuleSizeOrderForGroup(
    after,
    [{ spec: 'modular_m28_u4_r12', module_type: 'Area', sizes: ['2x2', '1x1', '1x2'] }],
    'modular_m28_u4_r12',
    'Area',
    'End',
  ), [
    { spec: 'modular_m28_u4_r12', module_type: 'End', sizes: ['2x2', '1x1', '1x2'] },
  ]);
});

test('renaming a mixed size keeps its saved position', () => {
  const before = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      mixed_u4: { '12x12': {}, '16x16': {}, '16x24': {} },
    },
  };
  const after = modulesApi.renameModuleGroup(before, 'mixed_u4', '12x12', '20x20');
  assert.deepEqual(modulesApi.renameModuleSizeOrderForGroup(
    after,
    [{ spec: 'mixed_u4', module_type: '', sizes: ['16x16', '12x12', '16x24'] }],
    'mixed_u4',
    '12x12',
    '20x20',
  ), [
    { spec: 'mixed_u4', module_type: '', sizes: ['16x16', '20x20', '16x24'] },
  ]);
});

test('normalizes Firestore size order against current mixed and modular sizes', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      mixed_u4: { '12x12': {}, '16x24': {}, '24x24': {} },
      modular_m28_u4_r12: {
        Area: { '1x1': {}, '1x2': {}, '2x2': {} },
        End: { '1x1': {}, '2x1': {} },
      },
    },
  };
  assert.deepEqual(modulesApi.normalizeModuleSizeOrder(document, [
    { spec: 'mixed_u4', module_type: '', sizes: ['24x24', 'missing', '24x24', '12x12'] },
    { spec: 'modular_m28_u4_r12', module_type: 'Area', sizes: ['2x2', '1x1'] },
    { spec: 'removed_spec', module_type: '', sizes: ['4x4'] },
  ]), [
    { spec: 'mixed_u4', module_type: '', sizes: ['24x24', '12x12', '16x24'] },
    { spec: 'modular_m28_u4_r12', module_type: 'Area', sizes: ['2x2', '1x1', '1x2'] },
    { spec: 'modular_m28_u4_r12', module_type: 'End', sizes: ['1x1', '2x1'] },
  ]);
});

test('moves one size inside its real spec and module type without changing template data', () => {
  const document = {
    schema: 'pcg-modules-templates', schema_version: 2,
    modules: {
      mixed_u4: { '12x12': {}, '16x24': {}, '24x24': {} },
      modular_m28_u4_r12: { Area: { '1x1': {}, '1x2': {}, '2x2': {} } },
    },
  };
  const before = JSON.stringify(document);
  const mixedOrder = modulesApi.moveModuleSizeOrder(document, [], 'mixed_u4', '', '24x24', -2);
  assert.deepEqual(mixedOrder[0].sizes, ['24x24', '12x12', '16x24']);
  const modularOrder = modulesApi.moveModuleSizeOrder(
    document, mixedOrder, 'modular_m28_u4_r12', 'Area', '1x1', 2,
  );
  assert.deepEqual(modularOrder.find(item => item.module_type === 'Area').sizes, ['1x2', '2x2', '1x1']);
  assert.equal(JSON.stringify(document), before);
  assert.deepEqual(
    modulesApi.moveModuleSizeOrder(document, modularOrder, 'mixed_u4', '', '12x12', -99),
    modularOrder,
  );
});
