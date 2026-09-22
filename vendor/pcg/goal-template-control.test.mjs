import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThemeCompatibilityContext,
  createGoalTemplateService,
} from './goal-template-control.js';

const mixedA = { '4x4': { Book: { '01': ['01'] } } };
const mixedB = { '4x4': { Book: { '01': ['01', '02'] } } };
const mixedC = { '8x8': { Armament: { '02': ['01'] } } };
const modularA = { Area: { '1x1': { Base: { '3': [1] } } } };

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function linkedFixture() {
  return {
    goalTemplates: {
      'castle-common': {
        template_id: 'castle-common', display_name: '城堡通用', status: 'active',
        template_revision: 4,
        specs: { mixed_u4: clone(mixedA), modular_m28_u4_r12: clone(modularA) },
      },
      'season-copy': {
        template_id: 'season-copy', display_name: '赛季副本', status: 'active',
        template_revision: 2, specs: { mixed_u4: clone(mixedA) },
      },
    },
    themeGoals: {
      XXGCB: linkedTheme('XXGCB', 'castle-common', 'mixed_u4', mixedA, 5, 5),
      CB_COMMON: linkedTheme('CB_COMMON', 'castle-common', 'mixed_u4', mixedA, 6, 6),
      MODULAR_A: linkedTheme('MODULAR_A', 'castle-common', 'modular_m28_u4_r12', modularA, 3, 3),
      SCJGB: linkedTheme('SCJGB', 'season-copy', 'mixed_u4', mixedA, 2, 2),
      EMPTY: {
        theme_id: 'EMPTY', association_state: 'unlinked', template_id: null,
        selected_spec_id: 'mixed_u4', target_intent: 'explicit_empty', targets: {},
        draft_revision: 0, effective_revision: 0,
      },
    },
    controlHead: { control_revision: 9, status: 'current' },
  };
}

function linkedTheme(themeId, templateId, specId, targets, draftRevision, effectiveRevision) {
  return {
    theme_id: themeId, association_state: 'linked_synced', template_id: templateId,
    selected_spec_id: specId, target_intent: 'defined', targets: clone(targets),
    draft_revision: draftRevision, effective_revision: effectiveRevision,
  };
}

function expectedFor(state, templateId, memberIds) {
  return {
    control_revision: state.controlHead.control_revision,
    template_revision: state.goalTemplates[templateId]?.template_revision,
    member_theme_ids: [...memberIds],
    theme_revisions: Object.fromEntries(memberIds.map(themeId => [themeId, {
      draft_revision: state.themeGoals[themeId].draft_revision,
      effective_revision: state.themeGoals[themeId].effective_revision,
    }])),
  };
}

function memoryAdapter(initial, maxAtomicWrites = 500) {
  let state = clone(initial);
  const adapter = {
    max_atomic_writes: maxAtomicWrites,
    commitCount: 0,
    writeHistory: [],
    snapshot: () => clone(state),
    async runTransaction(handler) {
      const writes = [];
      const tx = {
        listGoalTemplates: () => clone(state.goalTemplates),
        getGoalTemplate: id => clone(state.goalTemplates[id]),
        listThemeGoals: () => clone(state.themeGoals),
        getThemeGoal: id => clone(state.themeGoals[id]),
        getControlHead: () => clone(state.controlHead),
        setGoalTemplate: (id, value) => writes.push(['setGoalTemplate', id, clone(value)]),
        deleteGoalTemplate: id => writes.push(['deleteGoalTemplate', id]),
        setThemeGoal: (id, value) => writes.push(['setThemeGoal', id, clone(value)]),
        setControlHead: value => writes.push(['setControlHead', clone(value)]),
      };
      const result = await handler(tx);
      if (result.code !== 'ok' || writes.length === 0) {
        return { ...result, state: clone(state) };
      }
      for (const write of writes) {
        if (write[0] === 'setGoalTemplate') state.goalTemplates[write[1]] = write[2];
        if (write[0] === 'deleteGoalTemplate') delete state.goalTemplates[write[1]];
        if (write[0] === 'setThemeGoal') state.themeGoals[write[1]] = write[2];
        if (write[0] === 'setControlHead') state.controlHead = write[1];
      }
      adapter.commitCount += 1;
      adapter.writeHistory.push(clone(writes));
      return { ...result, state: clone(state) };
    },
  };
  return adapter;
}

function fixedOptions(ids = ['template-new']) {
  let index = 0;
  return { idGenerator: () => ids[index++] };
}

function mixedContext(sizes = ['4x4', '8x8'], roomTypes = ['Book', 'Armament']) {
  return { profile: 'mixed', Unit_Size: 4, Room_Sizes: sizes, room_types: roomTypes };
}

test('editing one linked theme writes through the selected branch only', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const expected = expectedFor(initial, 'castle-common', ['CB_COMMON', 'XXGCB']);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveLinkedTheme({
    theme_id: 'XXGCB', target_intent: 'defined', targets: mixedB, expected,
  });

  assert.equal(result.code, 'ok');
  assert.deepEqual(result.state.themeGoals.XXGCB.targets, result.state.themeGoals.CB_COMMON.targets);
  assert.deepEqual(result.state.themeGoals.XXGCB.targets, mixedB);
  assert.deepEqual(result.state.themeGoals.MODULAR_A, initial.themeGoals.MODULAR_A);
  assert.deepEqual(result.state.goalTemplates['castle-common'].specs.modular_m28_u4_r12, modularA);
  assert.equal(result.state.goalTemplates['castle-common'].template_revision, 5);
  assert.equal(result.state.controlHead.control_revision, 10);
  assert.equal(result.materialization_output_changed, true);
});

test('editing a template branch directly writes through the same synchronized group', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const expected = expectedFor(initial, 'castle-common', ['CB_COMMON', 'XXGCB']);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveTemplateBranch({
    template_id: 'castle-common', selected_spec_id: 'mixed_u4',
    target_intent: 'defined', targets: mixedB, expected,
  });
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.state.goalTemplates['castle-common'].specs.mixed_u4, mixedB);
  assert.deepEqual(result.state.themeGoals.XXGCB.targets, mixedB);
  assert.deepEqual(result.state.themeGoals.CB_COMMON.targets, mixedB);
  assert.deepEqual(result.state.themeGoals.MODULAR_A, initial.themeGoals.MODULAR_A);
});

test('stale group membership produces zero remote writes and a conflict draft', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const expected = expectedFor(initial, 'castle-common', ['XXGCB']);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveLinkedTheme({
    theme_id: 'XXGCB', target_intent: 'defined', targets: mixedB, expected,
    base: mixedA,
  });

  assert.equal(result.code, 'goal-template-impact-scope-stale');
  assert.equal(adapter.commitCount, 0);
  assert.equal(result.local_draft.status, 'conflict');
  assert.deepEqual(result.local_draft, { status: 'conflict', base: mixedA, local: mixedB, remote: mixedA });
});

test('a stale control or theme revision produces zero remote writes', async () => {
  for (const mutation of ['control', 'theme']) {
    const initial = linkedFixture();
    const adapter = memoryAdapter(initial);
    const expected = expectedFor(initial, 'castle-common', ['CB_COMMON', 'XXGCB']);
    if (mutation === 'control') expected.control_revision -= 1;
    else expected.theme_revisions.CB_COMMON.effective_revision -= 1;
    const result = await createGoalTemplateService(adapter, fixedOptions()).saveLinkedTheme({
      theme_id: 'XXGCB', target_intent: 'defined', targets: mixedB, expected, base: mixedA,
    });
    assert.equal(result.code, mutation === 'control' ? 'control-revision-conflict' : 'theme-revision-conflict');
    assert.equal(adapter.commitCount, 0);
    assert.equal(result.local_draft.status, 'conflict');
  }
});

test('canonical no-op performs no writes and advances no revisions', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const expected = expectedFor(initial, 'castle-common', ['CB_COMMON', 'XXGCB']);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveLinkedTheme({
    theme_id: 'XXGCB', target_intent: 'defined',
    targets: { '4x4': { Book: { '01': ['01'] } } }, expected,
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.no_op, true);
  assert.equal(adapter.commitCount, 0);
  assert.deepEqual(result.state, initial);
});

test('atomic write limit is checked before the adapter receives writes', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial, 3);
  const expected = expectedFor(initial, 'castle-common', ['CB_COMMON', 'XXGCB']);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveLinkedTheme({
    theme_id: 'XXGCB', target_intent: 'defined', targets: mixedB, expected,
  });
  assert.deepEqual(result, {
    code: 'goal-template-atomic-write-limit', required_writes: 4, max_atomic_writes: 3,
    state: initial,
  });
  assert.equal(adapter.commitCount, 0);
});

test('apply chooses the only compatible branch and only effective changes advance it', async () => {
  const initial = linkedFixture();
  initial.themeGoals.NEW_THEME = {
    theme_id: 'NEW_THEME', association_state: 'unlinked', template_id: null,
    selected_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedC),
    draft_revision: 0, effective_revision: 0,
  };
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).applyTemplateToTheme({
    theme_id: 'NEW_THEME', template_id: 'season-copy', selected_spec_id: null,
    theme_context: mixedContext(['4x4'], ['Book']),
    expected: {
      control_revision: 9,
      theme_revisions: { NEW_THEME: { draft_revision: 0, effective_revision: 0 } },
    },
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.state.themeGoals.NEW_THEME.selected_spec_id, 'mixed_u4');
  assert.equal(result.state.themeGoals.NEW_THEME.association_state, 'linked_synced');
  assert.deepEqual(result.state.themeGoals.NEW_THEME.targets, mixedA);
  assert.equal(result.state.themeGoals.NEW_THEME.draft_revision, 1);
  assert.equal(result.state.themeGoals.NEW_THEME.effective_revision, 1);
  assert.equal(result.materialization_output_changed, true);
});

test('compatibility context follows the Theme Config format and room map chain', async () => {
  const themeConfig = {
    Format_Rules: [{ themes: ['SCJGB'], types: ['Room'], format: 'Room_CB' }],
    Asset_Name_Formats: {
      Room_CB: {
        post_parse: [{ hook: 'map_string_to_id', args: { map_key: 'Room_Type' } }],
      },
    },
    Asset_Name_Maps: { Room_Type: { SCJGB: ['Collection', 'Book'] } },
    Theme_Registry: { modular: {}, mixed: { SCJGB: { sub_theme: 'SCJGB' } } },
    Mode_Configs: {
      modular: { themes: {} },
      mixed: { themes: { SCJGB: { Unit_Size: 4, Room_Sizes: { 0: [4, 4], 1: [4, 8] } } } },
    },
  };
  assert.deepEqual(buildThemeCompatibilityContext(themeConfig, 'SCJGB'), {
    profile: 'mixed', Unit_Size: 4, Room_Sizes: ['4x4', '4x8'],
    room_types: ['Book', 'Collection'],
  });

  const initial = linkedFixture();
  initial.themeGoals.NEW_THEME = {
    theme_id: 'NEW_THEME', association_state: 'unlinked', template_id: null,
    selected_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedC),
    draft_revision: 0, effective_revision: 0,
  };
  themeConfig.Theme_Registry.mixed.NEW_THEME = { sub_theme: 'NEW_THEME' };
  themeConfig.Mode_Configs.mixed.themes.NEW_THEME = { Unit_Size: 4, Room_Sizes: { 0: [4, 4] } };
  themeConfig.Format_Rules[0].themes.push('NEW_THEME');
  themeConfig.Asset_Name_Maps.Room_Type.NEW_THEME = ['Book'];
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).applyTemplateToTheme({
    theme_id: 'NEW_THEME', template_id: 'season-copy', selected_spec_id: null,
    theme_config: themeConfig,
    expected: { control_revision: 9, theme_revisions: { NEW_THEME: { draft_revision: 0, effective_revision: 0 } } },
  });
  assert.equal(result.code, 'ok');
});

test('apply reports zero, ambiguous, and explicitly incompatible branches without writes', async () => {
  const cases = [
    [mixedContext(['8x8'], ['Book']), null, 'goal-template-no-compatible-spec'],
    [mixedContext(['4x4'], ['Book']), null, 'goal-template-spec-selection-required'],
    [mixedContext(['4x4'], ['Book']), 'modular_m28_u4_r12', 'goal-template-spec-incompatible'],
  ];
  for (const [themeContext, selectedSpecId, code] of cases) {
    const initial = linkedFixture();
    initial.goalTemplates.MULTI = {
      template_id: 'MULTI', display_name: '多个分支', status: 'active', template_revision: 1,
      specs: {
        'mixed-branch-a': { module_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedA) },
        'mixed-branch-b': { module_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedA) },
      },
    };
    if (code !== 'goal-template-spec-selection-required') {
      initial.goalTemplates.MULTI.specs = {
        mixed_u4: clone(mixedA), modular_m28_u4_r12: clone(modularA),
      };
    }
    initial.themeGoals.NEW_THEME = {
      theme_id: 'NEW_THEME', association_state: 'unlinked', template_id: null,
      selected_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedC),
      draft_revision: 0, effective_revision: 0,
    };
    const adapter = memoryAdapter(initial);
    const result = await createGoalTemplateService(adapter, fixedOptions()).applyTemplateToTheme({
      theme_id: 'NEW_THEME', template_id: 'MULTI', selected_spec_id: selectedSpecId,
      theme_context: themeContext,
      expected: { control_revision: 9, theme_revisions: { NEW_THEME: { draft_revision: 0, effective_revision: 0 } } },
    });
    assert.equal(result.code, code);
    assert.equal(adapter.commitCount, 0);
  }
});

test('switching to an equal template changes only association revisions', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).applyTemplateToTheme({
    theme_id: 'XXGCB', template_id: 'season-copy', selected_spec_id: 'mixed_u4',
    theme_context: mixedContext(['4x4'], ['Book']),
    expected: { control_revision: 9, theme_revisions: { XXGCB: { draft_revision: 5, effective_revision: 5 } } },
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.state.themeGoals.XXGCB.template_id, 'season-copy');
  assert.equal(result.state.themeGoals.XXGCB.draft_revision, 6);
  assert.equal(result.state.themeGoals.XXGCB.effective_revision, 5);
  assert.equal(result.materialization_output_changed, false);
  assert.equal(result.state.goalTemplates['castle-common'].template_revision, 4);
  assert.equal(result.state.goalTemplates['season-copy'].template_revision, 2);
});

test('applying the current synchronized branch again is a canonical no-op', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).applyTemplateToTheme({
    theme_id: 'XXGCB', template_id: 'castle-common', selected_spec_id: 'mixed_u4',
    theme_context: mixedContext(['4x4'], ['Book']),
    expected: { control_revision: 9, theme_revisions: { XXGCB: { draft_revision: 5, effective_revision: 5 } } },
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.no_op, true);
  assert.equal(adapter.commitCount, 0);
  assert.deepEqual(result.state, initial);
});

test('explicit empty requires confirmation and confirmed empty is persisted', async () => {
  const initial = linkedFixture();
  initial.themeGoals.EMPTY = {
    theme_id: 'EMPTY', association_state: 'unlinked', template_id: null,
    selected_spec_id: 'mixed_u4', module_spec_id: 'mixed_u4',
    target_intent: 'defined', targets: clone(mixedA),
    draft_revision: 0, effective_revision: 0,
  };
  for (const confirmed of [false, true]) {
    const adapter = memoryAdapter(initial);
    const result = await createGoalTemplateService(adapter, fixedOptions()).saveUnlinkedTheme({
      theme_id: 'EMPTY', selected_spec_id: 'mixed_u4', target_intent: 'explicit_empty', targets: {},
      explicit_empty_confirmed: confirmed,
      expected: { control_revision: 9, theme_revisions: { EMPTY: { draft_revision: 0, effective_revision: 0 } } },
    });
    assert.equal(result.code, confirmed ? 'ok' : 'explicit-empty-confirmation-required');
    assert.equal(adapter.commitCount, confirmed ? 1 : 0);
    if (confirmed) assert.deepEqual(result.state.themeGoals.EMPTY.targets, {});
  }
});

test('saving a valid unlinked theme advances draft, effective, and control once', async () => {
  const initial = linkedFixture();
  initial.themeGoals.INDEPENDENT = {
    theme_id: 'INDEPENDENT', association_state: 'unlinked', template_id: null,
    selected_spec_id: 'mixed_u4', module_spec_id: 'mixed_u4',
    target_intent: 'defined', targets: clone(mixedA),
    draft_revision: 0, effective_revision: 0,
  };
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveUnlinkedTheme({
    theme_id: 'INDEPENDENT', selected_spec_id: 'mixed_u4', module_spec_id: 'mixed_u4',
    target_intent: 'defined', targets: mixedB,
    expected: { control_revision: 9, theme_revisions: { INDEPENDENT: { draft_revision: 0, effective_revision: 0 } } },
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.state.themeGoals.INDEPENDENT.association_state, 'unlinked');
  assert.equal(result.state.themeGoals.INDEPENDENT.draft_revision, 1);
  assert.equal(result.state.themeGoals.INDEPENDENT.effective_revision, 1);
  assert.equal(result.state.controlHead.control_revision, 10);
});

test('defined empty targets are incomplete and produce no writes', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveUnlinkedTheme({
    theme_id: 'EMPTY', selected_spec_id: 'mixed_u4', target_intent: 'defined', targets: {},
    expected: { control_revision: 9, theme_revisions: { EMPTY: { draft_revision: 0, effective_revision: 0 } } },
  });
  assert.equal(result.code, 'theme-goal-incomplete');
  assert.equal(adapter.commitCount, 0);
});

test('save as template atomically isolates one theme from its old group', async () => {
  const initial = linkedFixture();
  initial.themeGoals.SCJGB = linkedTheme('SCJGB', 'castle-common', 'mixed_u4', mixedA, 2, 2);
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions(['season-collector'])).saveAsTemplate({
    theme_id: 'SCJGB', display_name: '赛季收藏家', selected_spec_id: 'mixed_u4',
    target_intent: 'defined', targets: mixedC, theme_context: mixedContext(['8x8'], ['Armament']),
    expected: { control_revision: 9, theme_revisions: { SCJGB: { draft_revision: 2, effective_revision: 2 } } },
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.state.themeGoals.SCJGB.template_id, 'season-collector');
  assert.equal(result.state.goalTemplates['season-collector'].template_revision, 1);
  assert.deepEqual(result.state.goalTemplates['castle-common'], initial.goalTemplates['castle-common']);
  assert.deepEqual(result.state.themeGoals.XXGCB, initial.themeGoals.XXGCB);
});

test('save as template conflict leaves no orphan template', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions(['season-collector'])).saveAsTemplate({
    theme_id: 'SCJGB', display_name: '赛季收藏家', selected_spec_id: 'mixed_u4',
    target_intent: 'defined', targets: mixedC, theme_context: mixedContext(['8x8'], ['Armament']),
    expected: { control_revision: 9, theme_revisions: { SCJGB: { draft_revision: 1, effective_revision: 2 } } },
  });
  assert.equal(result.code, 'theme-revision-conflict');
  assert.equal(adapter.commitCount, 0);
  assert.equal(result.state.goalTemplates['season-collector'], undefined);
});

test('save as template checks its three-document write set before writing', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial, 2);
  const result = await createGoalTemplateService(adapter, fixedOptions(['season-collector'])).saveAsTemplate({
    theme_id: 'SCJGB', display_name: '赛季收藏家', selected_spec_id: 'mixed_u4',
    target_intent: 'defined', targets: mixedC, theme_context: mixedContext(['8x8'], ['Armament']),
    expected: { control_revision: 9, theme_revisions: { SCJGB: { draft_revision: 2, effective_revision: 2 } } },
  });
  assert.equal(result.code, 'goal-template-atomic-write-limit');
  assert.equal(result.required_writes, 3);
  assert.equal(adapter.commitCount, 0);
});

test('template create, copy, rename, export, and import preserve stable lifecycle rules', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const service = createGoalTemplateService(adapter, fixedOptions(['created-id', 'copied-id', 'remapped-id']));

  let result = await service.createTemplate({
    display_name: '新模板', specs: { mixed_u4: mixedA }, expected: { control_revision: 9 },
  });
  assert.equal(result.state.goalTemplates['created-id'].template_revision, 1);
  result = await service.copyTemplate({
    template_id: 'created-id', display_name: '副本', expected: { control_revision: 10, template_revision: 1 },
  });
  assert.deepEqual(result.state.goalTemplates['copied-id'].specs, { mixed_u4: mixedA });
  result = await service.renameTemplate({
    template_id: 'copied-id', display_name: '改名副本', expected: { control_revision: 11, template_revision: 1 },
  });
  assert.equal(result.state.goalTemplates['copied-id'].template_revision, 2);
  const exported = await service.exportTemplate({ template_id: 'copied-id' });
  assert.deepEqual(Object.keys(exported.template), [
    'schema_version', 'template_id', 'display_name', 'status', 'template_revision', 'specs',
  ]);
  result = await service.importTemplate({
    template: { ...exported.template, template_id: 'external-id', template_revision: 99 },
    expected: { control_revision: 12 },
  });
  assert.equal(result.state.goalTemplates['external-id'].template_revision, 1);
  assert.equal(result.state.controlHead.control_revision, 13);
});

test('template item catalog survives copy, export, and import', async () => {
  const initial = linkedFixture();
  const item = {
    item_id: 'item-001', display_name: '东侧大厅', properties: { owner: 'TA-01' },
    expected_count: 1, target_refs: [{
      spec_id: 'mixed_u4', size: '4x4', roomType: 'Book', ctg: '01', variant: '01',
    }],
  };
  initial.goalTemplates['season-copy'].specs.mixed_u4 = {
    module_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedA), template_items: [item],
  };
  const adapter = memoryAdapter(initial);
  const service = createGoalTemplateService(adapter, fixedOptions(['copy-with-items', 'import-with-items']));
  let result = await service.copyTemplate({
    template_id: 'season-copy', expected: { control_revision: 9, template_revision: 2 },
  });
  assert.deepEqual(result.state.goalTemplates['copy-with-items'].specs.mixed_u4.template_items, [item]);
  const exported = await service.exportTemplate({ template_id: 'copy-with-items' });
  assert.deepEqual(exported.template.specs.mixed_u4.template_items, [item]);
  result = await service.importTemplate({
    template: { ...exported.template, template_id: 'import-with-items' },
    expected: { control_revision: 10 },
  });
  assert.deepEqual(result.state.goalTemplates['import-with-items'].specs.mixed_u4.template_items, [item]);
});

test('same mixed_u4 specification keeps different theme item counts isolated', async () => {
  const initial = linkedFixture();
  const item = suffix => ({
    item_id: `item-${suffix}`, display_name: `主题项 ${suffix}`, properties: {}, expected_count: 1,
    target_refs: [{ spec_id: 'mixed_u4', size: '4x4', roomType: 'Book', ctg: '01', variant: suffix }],
  });
  initial.goalTemplates['castle-common'].specs.mixed_u4 = {
    module_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedA),
    template_items: [item('01')],
  };
  initial.goalTemplates['season-copy'].specs.mixed_u4 = {
    module_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedB),
    template_items: [item('01'), item('02')],
  };
  const adapter = memoryAdapter(initial);
  const service = createGoalTemplateService(adapter, fixedOptions());
  let result = await service.applyTemplateToTheme({
    theme_id: 'XXGCB', template_id: 'castle-common', selected_spec_id: 'mixed_u4',
    theme_context: mixedContext(['4x4'], ['Book']),
    expected: { control_revision: 9, theme_revisions: { XXGCB: { draft_revision: 5, effective_revision: 5 } } },
  });
  assert.equal(result.code, 'ok');
  result = await service.applyTemplateToTheme({
    theme_id: 'CB_COMMON', template_id: 'season-copy', selected_spec_id: 'mixed_u4',
    theme_context: mixedContext(['4x4'], ['Book']),
    expected: { control_revision: 10, theme_revisions: { CB_COMMON: { draft_revision: 6, effective_revision: 6 } } },
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.state.themeGoals.XXGCB.template_items.length, 1);
  assert.equal(result.state.themeGoals.CB_COMMON.template_items.length, 2);
  assert.deepEqual(result.state.themeGoals.XXGCB.targets, mixedA);
  assert.deepEqual(result.state.themeGoals.CB_COMMON.targets, mixedB);
});

test('exporting a missing template returns a stable not-found result', async () => {
  const adapter = memoryAdapter(linkedFixture());
  const result = await createGoalTemplateService(adapter, fixedOptions()).exportTemplate({
    template_id: 'missing-template',
  });
  assert.equal(result.code, 'goal-template-not-found');
  assert.equal(adapter.commitCount, 0);
});

test('import collision remaps only with confirmation and equal canonical content is no-op', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const service = createGoalTemplateService(adapter, fixedOptions(['template-remap-001']));
  const same = await service.importTemplate({
    template: { schema_version: 1, ...clone(initial.goalTemplates['season-copy']) },
    expected: { control_revision: 9 },
  });
  assert.equal(same.code, 'goal-template-import-no-op');
  assert.equal(adapter.commitCount, 0);

  const conflict = await service.importTemplate({
    template: {
      schema_version: 1, template_id: 'season-copy', display_name: '其它内容',
      status: 'active', template_revision: 8, specs: { mixed_u4: mixedB },
    },
    confirm_id_remap: true, expected: { control_revision: 9 },
  });
  assert.equal(conflict.code, 'ok');
  assert.deepEqual(conflict.id_mapping, { 'season-copy': 'template-remap-001' });
  assert.deepEqual(conflict.state.goalTemplates['season-copy'], initial.goalTemplates['season-copy']);
});

test('invalid import is rejected without writes', async () => {
  const initial = linkedFixture();
  for (const template of [
    { template_id: 'bad', display_name: '缺 schema', status: 'active', specs: { mixed_u4: mixedA } },
    { schema_version: 1, template_id: 'bad', display_name: '坏叶子', status: 'active', specs: { mixed_u4: { '4x4': { Book: { '01': ['00'] } } } } },
    { schema_version: 1, template_id: 'bad', display_name: '坏 CTG', status: 'active', specs: { mixed_u4: { '4x4': { Book: { '00': ['01'] } } } } },
    { schema_version: 1, template_id: 'bad', display_name: '带关联', status: 'active', specs: { mixed_u4: mixedA }, linked_theme_ids: ['SCJGB'] },
  ]) {
    const adapter = memoryAdapter(initial);
    const result = await createGoalTemplateService(adapter, fixedOptions()).importTemplate({
      template, expected: { control_revision: 9 },
    });
    assert.equal(result.code, 'goal-template-import-invalid');
    assert.equal(adapter.commitCount, 0);
  }
});

test('editing an unused template changes control metadata but not materialized output', async () => {
  const initial = linkedFixture();
  initial.goalTemplates.UNUSED = {
    template_id: 'UNUSED', display_name: '未使用', status: 'active',
    template_revision: 1, specs: { mixed_u4: clone(mixedA) },
  };
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveTemplateBranch({
    template_id: 'UNUSED', selected_spec_id: 'mixed_u4',
    target_intent: 'defined', targets: mixedB,
    expected: { control_revision: 9, template_revision: 1, member_theme_ids: [] },
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.state.goalTemplates.UNUSED.template_revision, 2);
  assert.equal(result.state.controlHead.control_revision, 10);
  assert.equal(result.materialization_output_changed, false);
});

test('deleting a template freezes targets and unlinks only its branch members', async () => {
  const initial = linkedFixture();
  const adapter = memoryAdapter(initial);
  const expected = expectedFor(initial, 'castle-common', ['CB_COMMON', 'MODULAR_A', 'XXGCB']);
  const result = await createGoalTemplateService(adapter, fixedOptions()).deleteTemplate({
    template_id: 'castle-common', expected,
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.state.goalTemplates['castle-common'], undefined);
  for (const themeId of ['CB_COMMON', 'MODULAR_A', 'XXGCB']) {
    assert.equal(result.state.themeGoals[themeId].association_state, 'unlinked');
    assert.equal(result.state.themeGoals[themeId].template_id, null);
    assert.equal(result.state.themeGoals[themeId].draft_revision, initial.themeGoals[themeId].draft_revision + 1);
    assert.equal(result.state.themeGoals[themeId].effective_revision, initial.themeGoals[themeId].effective_revision);
    assert.deepEqual(result.state.themeGoals[themeId].targets, initial.themeGoals[themeId].targets);
  }
  assert.deepEqual(result.state.themeGoals.SCJGB, initial.themeGoals.SCJGB);
  assert.equal(result.materialization_output_changed, false);
});

test('deleting a template observes theme revision and atomic capacity before writing', async () => {
  for (const [maxWrites, mutate, expectedCode] of [
    [10, true, 'theme-revision-conflict'],
    [4, false, 'goal-template-atomic-write-limit'],
  ]) {
    const initial = linkedFixture();
    const adapter = memoryAdapter(initial, maxWrites);
    const expected = expectedFor(initial, 'castle-common', ['CB_COMMON', 'MODULAR_A', 'XXGCB']);
    if (mutate) expected.theme_revisions.CB_COMMON.effective_revision -= 1;
    const result = await createGoalTemplateService(adapter, fixedOptions()).deleteTemplate({
      template_id: 'castle-common', expected,
    });
    assert.equal(result.code, expectedCode);
    assert.equal(adapter.commitCount, 0);
  }
});

test('deleting an unused template needs no synthetic theme revision map', async () => {
  const initial = linkedFixture();
  initial.goalTemplates.UNUSED = {
    template_id: 'UNUSED', display_name: '未使用', status: 'active',
    template_revision: 1, specs: { mixed_u4: clone(mixedA) },
  };
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).deleteTemplate({
    template_id: 'UNUSED',
    expected: { control_revision: 9, template_revision: 1, member_theme_ids: [] },
  });
  assert.equal(result.code, 'ok');
  assert.equal(result.state.goalTemplates.UNUSED, undefined);
  assert.equal(result.state.controlHead.control_revision, 10);
});

test('metadata-only template item edit syncs the group without changing effective output', async () => {
  const initial = linkedFixture();
  const item = {
    item_id: 'item-001', display_name: '大厅 A', properties: { owner: 'TA-01' },
    expected_count: 1, target_refs: [{
      spec_id: 'mixed_u4', size: '4x4', roomType: 'Book', ctg: '01', variant: '01',
    }],
  };
  initial.goalTemplates['castle-common'].specs.mixed_u4 = {
    module_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedA), template_items: [item],
  };
  initial.themeGoals.XXGCB.template_items = [item];
  initial.themeGoals.CB_COMMON.template_items = [item];
  const adapter = memoryAdapter(initial);
  const expected = expectedFor(initial, 'castle-common', ['CB_COMMON', 'XXGCB']);
  const result = await createGoalTemplateService(adapter, fixedOptions()).saveLinkedTheme({
    theme_id: 'XXGCB', selected_spec_id: 'mixed_u4', target_intent: 'defined', targets: mixedA,
    template_items: [{ ...item, display_name: '东侧大厅变体 A' }], expected,
  });

  assert.equal(result.code, 'ok');
  assert.equal(result.materialization_output_changed, false);
  assert.equal(result.state.goalTemplates['castle-common'].template_revision, 5);
  assert.equal(result.state.themeGoals.XXGCB.effective_revision, 5);
  assert.equal(result.state.themeGoals.CB_COMMON.effective_revision, 6);
  assert.equal(result.state.themeGoals.CB_COMMON.template_items[0].display_name, '东侧大厅变体 A');
});

test('applying a template copies its item catalog into the theme snapshot', async () => {
  const initial = linkedFixture();
  const item = {
    item_id: 'item-001', display_name: '大厅 A', properties: { owner: 'TA-01' },
    expected_count: 1, target_refs: [{
      spec_id: 'mixed_u4', size: '4x4', roomType: 'Book', ctg: '01', variant: '01',
    }],
  };
  initial.goalTemplates['season-copy'].specs.mixed_u4 = {
    module_spec_id: 'mixed_u4', target_intent: 'defined', targets: clone(mixedA), template_items: [item],
  };
  initial.themeGoals.NEW_THEME = {
    theme_id: 'NEW_THEME', association_state: 'unlinked', template_id: null,
    selected_spec_id: 'mixed_u4', module_spec_id: 'mixed_u4', target_intent: 'defined',
    targets: clone(mixedB), draft_revision: 0, effective_revision: 0,
  };
  const adapter = memoryAdapter(initial);
  const result = await createGoalTemplateService(adapter, fixedOptions()).applyTemplateToTheme({
    theme_id: 'NEW_THEME', template_id: 'season-copy', selected_spec_id: 'mixed_u4',
    theme_context: mixedContext(['4x4'], ['Book']),
    expected: { control_revision: 9, theme_revisions: { NEW_THEME: { draft_revision: 0, effective_revision: 0 } } },
  });

  assert.equal(result.code, 'ok');
  assert.deepEqual(result.state.themeGoals.NEW_THEME.template_items, [item]);
  assert.equal(result.state.themeGoals.NEW_THEME.effective_revision, 1);
});
