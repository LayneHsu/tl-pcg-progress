import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConfigMigrationDryRun,
  canonicalizeSchema3Targets,
  fingerprintMigrationReport,
} from './config-migration.js';

const FP = value => `sha256:${value.repeat(64)}`;

function mixedTargets(entries) {
  const result = {};
  for (const [size, roomType, ctg, variants] of entries) {
    result[size] ??= {};
    result[size][roomType] ??= {};
    result[size][roomType][ctg] = variants;
  }
  return result;
}

function baseThemeConfig() {
  return {
    Format_Rules: [{ format: 'Room_XXGCB', themes: ['XXGCB'], types: ['Room'] }],
    Theme_Registry: {
      modular: {},
      mixed: {
        XXGCB: { parent: 'ChengBao', display_name: 'XiXueGuiChengBao', sub_theme: 'XXGCB' },
      },
      freeform: {},
    },
    Mode_Configs: {
      modular: { themes: {} },
      mixed: {
        themes: {
          XXGCB: { Unit_Size: 4, Room_Sizes: { 0: [12, 16] } },
        },
      },
      freeform: { themes: {} },
    },
  };
}

function fixture() {
  const legacyThemeConfig = baseThemeConfig();
  const localThemeConfig = structuredClone(legacyThemeConfig);
  localThemeConfig.Theme_Registry.mixed.SCJGB = {
    parent: 'ChengBao',
    display_name: 'ShouCangJiaGuBao',
    sub_theme: 'SCJGB',
  };
  localThemeConfig.Mode_Configs.mixed.themes.SCJGB = {
    Unit_Size: 4,
    Room_Sizes: { 0: [12, 16] },
  };
  localThemeConfig.Format_Rules[0].themes.push('SCJGB');

  return {
    source_fingerprints: {
      projects_main: FP('1'),
      goal_templates: FP('2'),
      module_goal_draft: FP('3'),
      legacy_ready_bundle: FP('4'),
      local_theme_config: FP('5'),
      local_module_templates: FP('6'),
    },
    projects_main: { parentThemes: [] },
    goal_template_sources: [
      {
        source_kind: 'module_goal_draft',
        source_key: 'castle-common',
        stable_id: 'castle-common',
        content: {
          display_name: '城堡通用',
          specs: { mixed_u4: {
            module_spec_id: 'mixed_u4',
            targets: mixedTargets([['12x16', 'Book', '02', ['01']]]),
            template_items: [{
              item_id: 'item-001', display_name: '大厅', properties: { owner: 'TA-01' },
              expected_count: 1,
              target_refs: [{ spec_id: 'mixed_u4', size: '12x16', roomType: 'Book', ctg: '02', variant: '01' }],
            }],
          } },
        },
      },
      {
        source_kind: 'projects_main',
        source_key: 'season-collector',
        content: {
          display_name: '赛季收藏家',
          specs: { mixed_u4: mixedTargets([['12x16', 'Specimen', '03', ['01']]]) },
        },
      },
    ],
    theme_goals: [
      {
        theme_id: 'XXGCB',
        target_intent: 'defined',
        specs: {
          mixed_u4: mixedTargets([
            ['12x16', 'Collection', '01', ['01']],
            ['12x16', 'Book', '02', ['01']],
          ]),
        },
      },
      {
        theme_id: 'SCJGB',
        target_intent: 'defined',
        specs: {
          mixed_u4: mixedTargets([
            ['12x16', 'Specimen', '03', ['01']],
            ['12x16', 'Book', '02', ['01']],
          ]),
        },
      },
    ],
    legacy_ready_bundle: {
      theme_config: legacyThemeConfig,
      module_templates: { schema: 'pcg-modules-templates', schema_version: 2, modules: {} },
    },
    local_theme_config: localThemeConfig,
    remote_theme_config: structuredClone(legacyThemeConfig),
    local_module_templates: { schema: 'pcg-modules-templates', schema_version: 2, modules: {} },
    control_revision: 7,
    sync_revision: 3,
    writer_epoch: 7,
  };
}

function shuffledFixture() {
  const input = fixture();
  input.goal_template_sources.reverse();
  input.theme_goals.reverse();
  input.source_fingerprints = Object.fromEntries(Object.entries(input.source_fingerprints).reverse());
  for (const goal of input.theme_goals) {
    goal.specs = Object.fromEntries(Object.entries(goal.specs).reverse());
    for (const [specId, targets] of Object.entries(goal.specs)) {
      goal.specs[specId] = Object.fromEntries(Object.entries(targets).reverse());
    }
  }
  return input;
}

test('dry-run is deterministic and never calls a writer', async () => {
  const writes = [];
  const first = await buildConfigMigrationDryRun(fixture(), { write: value => writes.push(value) });
  const second = await buildConfigMigrationDryRun(shuffledFixture(), { write: value => writes.push(value) });
  assert.deepEqual(first, second);
  assert.equal(first.schema_version, 1);
  assert.match(first.report_fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(writes, []);
});

test('dry-run projects the complete create-if-absent document set without inferred template links', async () => {
  const report = await buildConfigMigrationDryRun(fixture());
  const generatedTemplateId = report.stable_id_mapping
    .find(item => item.source_key === 'season-collector').stable_id;
  assert.deepEqual(report.migration_documents.map(document => document.path), [
    'pcgModuleControl/current',
    'pcgModuleGoalTemplates/castle-common',
    `pcgModuleGoalTemplates/${generatedTemplateId}`,
    'pcgModuleReadyConfigs/control-r7',
    'pcgModuleThemeGoals/SCJGB',
    'pcgModuleThemeGoals/XXGCB',
    'pcgModulesConfig/current',
  ]);
  const documents = Object.fromEntries(report.migration_documents.map(item => [item.path, item.value]));
  assert.deepEqual(documents['pcgModuleControl/current'], {
    conflicts: [],
    control_revision: 7,
    managed_theme_config_patch: report.expected_ready_bundle.managed_theme_config_patch,
    status: 'current',
    writer_epoch: 7,
    writer_state: 'legacy_enabled',
  });
  assert.deepEqual(documents['pcgModuleThemeGoals/SCJGB'], {
    association_state: 'unlinked',
    draft_revision: 1,
    effective_revision: 1,
    module_spec_id: 'mixed_u4',
    selected_spec_id: 'mixed_u4',
    target_intent: 'defined',
    targets: fixture().theme_goals.find(goal => goal.theme_id === 'SCJGB').specs.mixed_u4,
    template_id: null,
    theme_id: 'SCJGB',
  });
  assert.equal(documents['pcgModuleGoalTemplates/castle-common'].display_name, '城堡通用');
  assert.equal(documents['pcgModuleGoalTemplates/castle-common'].template_revision, 1);
  assert.deepEqual(documents['pcgModuleGoalTemplates/castle-common'].specs.mixed_u4.template_items, [{
    item_id: 'item-001', display_name: '大厅', properties: { owner: 'TA-01' }, expected_count: 1,
    target_refs: [{ spec_id: 'mixed_u4', size: '12x16', roomType: 'Book', ctg: '02', variant: '01' }],
  }]);
  assert.deepEqual(documents['pcgModuleReadyConfigs/control-r7'], report.expected_ready_bundle);
  assert.deepEqual(documents['pcgModulesConfig/current'], {
    bundle_id: 'control-r7',
    error_code: null,
    pending_theme_ids: [],
    source_control_revision: 7,
    status: 'ready',
    sync_revision: 3,
  });
});

test('migration document values are covered by the report fingerprint', async () => {
  const report = await buildConfigMigrationDryRun(fixture());
  const changed = structuredClone(report);
  changed.migration_documents.find(item => item.path === 'pcgModuleControl/current')
    .value.writer_epoch = 8;
  assert.notEqual(
    await fingerprintMigrationReport(report),
    await fingerprintMigrationReport(changed),
  );
});

test('migration document business paths remain covered by the report fingerprint', async () => {
  const first = await fingerprintMigrationReport({
    migration_documents: [{
      path: 'pcgModuleGoalTemplates/castle-common',
      value: { specs: { mixed_u4: { hda_asset_path: '/CastlePlugin/HDA/A' } } },
    }],
  });
  const second = await fingerprintMigrationReport({
    migration_documents: [{
      path: 'pcgModuleGoalTemplates/castle-common',
      value: { specs: { mixed_u4: { hda_asset_path: '/CastlePlugin/HDA/B' } } },
    }],
  });
  assert.notEqual(first, second);
});

test('fresh local SCJGB managed fields win over the stale ready bundle', async () => {
  const report = await buildConfigMigrationDryRun(fixture());
  assert.equal(report.expected_ready_bundle.managed_theme_config_patch.upserts
    .some(item => item.path === '/Theme_Registry/mixed/SCJGB'), true);
  assert.equal(report.expected_ready_bundle.managed_theme_config_patch.upserts
    .some(item => item.path === '/Mode_Configs/mixed/themes/SCJGB'), true);
  assert.equal(report.pending_theme_ids.includes('SCJGB'), false);
});

test('schema 3 canonicalization keeps per-theme targets and builds a stable union', () => {
  const result = canonicalizeSchema3Targets([
    {
      theme_id: 'SCJGB',
      target_intent: 'defined',
      specs: {
        mixed_u4: mixedTargets([
          ['12x16', 'Specimen', '03', ['01']],
          ['12x16', 'Book', '02', ['01']],
        ]),
        modular_m28_u4_r12: { Area: { '1x1': { Base: { 3: [2, 1, 1] } } } },
      },
    },
    {
      theme_id: 'XXGCB',
      target_intent: 'defined',
      specs: {
        mixed_u4: mixedTargets([
          ['12x16', 'Collection', '01', ['01']],
          ['12x16', 'Book', '02', ['01']],
        ]),
      },
    },
  ]);

  assert.deepEqual(result.theme_modules.SCJGB.mixed_u4, mixedTargets([
    ['12x16', 'Book', '02', ['01']],
    ['12x16', 'Specimen', '03', ['01']],
  ]));
  assert.deepEqual(result.modules.mixed_u4, mixedTargets([
    ['12x16', 'Book', '02', ['01']],
    ['12x16', 'Collection', '01', ['01']],
    ['12x16', 'Specimen', '03', ['01']],
  ]));
  assert.deepEqual(result.modules.modular_m28_u4_r12, {
    Area: { '1x1': { Base: { 3: [1, 2] } } },
  });
});

test('target intent distinguishes defined, explicit empty, and incomplete', () => {
  assert.throws(
    () => canonicalizeSchema3Targets([
      { theme_id: 'EMPTY', target_intent: 'defined', specs: { mixed_u4: {} } },
    ]),
    error => error.code === 'theme-goal-incomplete',
  );
  assert.deepEqual(canonicalizeSchema3Targets([
    { theme_id: 'EMPTY', target_intent: 'explicit_empty', specs: { mixed_u4: {} } },
  ]), {
    modules: {},
    theme_modules: { EMPTY: { mixed_u4: {} } },
  });
  assert.throws(
    () => canonicalizeSchema3Targets([{ theme_id: 'EMPTY', specs: { mixed_u4: {} } }]),
    error => error.code === 'theme-goal-incomplete',
  );
});

test('schema 3 rejects invalid mixed and modular numeric leaves', () => {
  assert.throws(
    () => canonicalizeSchema3Targets([{
      theme_id: 'BAD', target_intent: 'defined',
      specs: { mixed_u4: mixedTargets([['12x16', 'Book', '00', ['01']]]) },
    }]),
    error => error.code === 'mixed-ctg-invalid',
  );
  assert.throws(
    () => canonicalizeSchema3Targets([{
      theme_id: 'BAD', target_intent: 'defined',
      specs: { modular_m28_u4_r12: { Area: { '1x1': { Base: { 3: [0] } } } } },
    }]),
    error => error.code === 'modular-variant-invalid',
  );
});

test('stable IDs preserve existing IDs and suffix deterministic hash collisions', async () => {
  const input = fixture();
  input.goal_template_sources = [
    { source_kind: 'z', source_key: 'kept', stable_id: 'existing-id', content: { value: 0 } },
    { source_kind: 'a', source_key: 'second', content: { value: 2 } },
    { source_kind: 'a', source_key: 'first', content: { value: 1 } },
  ];
  const report = await buildConfigMigrationDryRun(input, {
    hashCanonical: async () => 'a'.repeat(64),
  });
  assert.deepEqual(report.stable_id_mapping, [
    { source_kind: 'a', source_key: 'first', stable_id: 'goal-aaaaaaaaaaaaaaaa' },
    { source_kind: 'a', source_key: 'second', stable_id: 'goal-aaaaaaaaaaaaaaaa-2' },
    { source_kind: 'z', source_key: 'kept', stable_id: 'existing-id' },
  ]);
});

test('a missing ID reuses the same-content generated ID already held by an existing source', async () => {
  const input = fixture();
  input.goal_template_sources = [
    {
      source_kind: 'a', source_key: 'existing', stable_id: 'goal-aaaaaaaaaaaaaaaa',
      content: { value: 1 },
    },
    { source_kind: 'b', source_key: 'missing', content: { value: 1 } },
  ];
  const report = await buildConfigMigrationDryRun(input, {
    hashCanonical: async () => 'a'.repeat(64),
  });
  assert.deepEqual(report.stable_id_mapping.map(item => item.stable_id), [
    'goal-aaaaaaaaaaaaaaaa',
    'goal-aaaaaaaaaaaaaaaa',
  ]);
});

test('different content cannot silently reuse one existing stable ID', async () => {
  const input = fixture();
  input.goal_template_sources = [
    { source_kind: 'a', source_key: 'first', stable_id: 'duplicate-id', content: { value: 1 } },
    { source_kind: 'b', source_key: 'second', stable_id: 'duplicate-id', content: { value: 2 } },
  ];
  const report = await buildConfigMigrationDryRun(input);
  assert.equal(report.conflicts.some(item => item.code === 'goal-template-id-conflict'), true);
  assert.equal(report.writer_cutover_eligible, false);
});

test('three-way managed conflicts have a fixed shape and stable path ordering', async () => {
  const input = fixture();
  input.remote_theme_config.Theme_Registry.mixed.XXGCB.display_name = 'Remote';
  input.local_theme_config.Theme_Registry.mixed.XXGCB.display_name = 'Local';
  const report = await buildConfigMigrationDryRun(input);
  const conflict = report.conflicts.find(item => item.path === '/Theme_Registry/mixed/XXGCB');
  assert.deepEqual(conflict, {
    code: 'managed-theme-config-conflict',
    path: '/Theme_Registry/mixed/XXGCB',
    base: baseThemeConfig().Theme_Registry.mixed.XXGCB,
    local: input.local_theme_config.Theme_Registry.mixed.XXGCB,
    remote: input.remote_theme_config.Theme_Registry.mixed.XXGCB,
    resolution: 'unresolved',
  });
  assert.equal(report.writer_cutover_eligible, false);
  assert.deepEqual(report.conflicts.map(item => item.path),
    [...report.conflicts.map(item => item.path)].sort());
});

test('Format_Rules uses the remote side when local still equals base', async () => {
  const input = fixture();
  input.local_theme_config.Format_Rules[0].themes = ['XXGCB'];
  input.remote_theme_config.Format_Rules[0].themes = ['XXGCB', 'REMOTE'];
  const report = await buildConfigMigrationDryRun(input);
  assert.deepEqual(
    report.expected_ready_bundle.managed_theme_config_patch.format_rule_membership,
    [{ format: 'Room_XXGCB', theme_ids: ['XXGCB', 'REMOTE'] }],
  );
  assert.equal(report.conflicts.some(item => item.path === '/Format_Rules'), false);
});

test('Format_Rules divergent local and remote changes produce a fixed conflict', async () => {
  const input = fixture();
  input.local_theme_config.Format_Rules[0].themes = ['XXGCB', 'LOCAL'];
  input.remote_theme_config.Format_Rules[0].themes = ['XXGCB', 'REMOTE'];
  const report = await buildConfigMigrationDryRun(input);
  assert.deepEqual(report.conflicts.find(item => item.path === '/Format_Rules'), {
    code: 'managed-theme-config-conflict',
    path: '/Format_Rules',
    base: [{ format: 'Room_XXGCB', theme_ids: ['XXGCB'] }],
    local: [{ format: 'Room_XXGCB', theme_ids: ['XXGCB', 'LOCAL'] }],
    remote: [{ format: 'Room_XXGCB', theme_ids: ['XXGCB', 'REMOTE'] }],
    resolution: 'unresolved',
  });
});

test('report fingerprint excludes its own value and runtime-only noise', async () => {
  const report = { schema_version: 1, value: { b: 2, a: 1 } };
  const first = await fingerprintMigrationReport({
    ...report,
    report_fingerprint: FP('f'),
    generated_at: '2026-08-21T00:00:00Z',
    run_id: 'run-one',
    diagnostic_file: 'F:\\temp\\first.json',
  });
  const second = await fingerprintMigrationReport({
    ...report,
    report_fingerprint: FP('0'),
    generated_at: '2026-08-22T00:00:00Z',
    run_id: 'run-two',
    diagnostic_file: 'C:\\other\\second.json',
  });
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});

test('report fingerprint excludes absolute paths nested in arrays and ordinary path fields', async () => {
  const first = await fingerprintMigrationReport({
    schema_version: 1,
    diagnostic_files: ['C:\\temp\\first.json', '/tmp/first.log'],
    diagnostic: { path: '/var/tmp/first.json' },
  });
  const second = await fingerprintMigrationReport({
    schema_version: 1,
    diagnostic_files: ['D:\\other\\second.json', '/tmp/second.log'],
    diagnostic: { path: '/var/tmp/second.json' },
  });
  assert.equal(first, second);
});

test('report fingerprint retains UE package paths as business values', async () => {
  const first = await fingerprintMigrationReport({
    schema_version: 1,
    expected_ready_bundle: { managed_value: { hda_asset_path: '/Game/PCG/HDA/A' } },
  });
  const second = await fingerprintMigrationReport({
    schema_version: 1,
    expected_ready_bundle: { managed_value: { hda_asset_path: '/Game/PCG/HDA/B' } },
  });
  const engine = await fingerprintMigrationReport({
    schema_version: 1,
    expected_ready_bundle: { managed_value: { hda_asset_path: '/Engine/PCG/HDA/A' } },
  });
  assert.notEqual(first, second);
  assert.notEqual(first, engine);
});

test('report fingerprint retains custom UE plugin mount paths inside ready business data', async () => {
  const first = await fingerprintMigrationReport({
    schema_version: 1,
    expected_ready_bundle: {
      managed_value: { hda_asset_path: '/HoudiniEngine/Content/HDA/A' },
    },
  });
  const second = await fingerprintMigrationReport({
    schema_version: 1,
    expected_ready_bundle: {
      managed_value: { hda_asset_path: '/HoudiniEngine/Content/HDA/B' },
    },
  });
  assert.notEqual(first, second);
});

test('report fingerprint still excludes POSIX machine paths in HDA fields', async () => {
  const first = await fingerprintMigrationReport({
    schema_version: 1,
    source_hda_path: '/home/worker-a/project/tool.hda',
  });
  const second = await fingerprintMigrationReport({
    schema_version: 1,
    source_hda_path: '/mnt/build-worker-b/project/tool.hda',
  });
  assert.equal(first, second);
});

test('report fingerprint retains JSON Pointer paths and report keys stay canonical', async () => {
  const first = await fingerprintMigrationReport({
    schema_version: 1,
    conflicts: [{ code: 'conflict', path: '/Theme_Registry/mixed/A' }],
  });
  const second = await fingerprintMigrationReport({
    schema_version: 1,
    conflicts: [{ code: 'conflict', path: '/Theme_Registry/mixed/B' }],
  });
  assert.notEqual(first, second);

  const report = await buildConfigMigrationDryRun(fixture());
  assert.deepEqual(Object.keys(report), [...Object.keys(report)].sort());
});
