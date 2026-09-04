import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalTemplateFirestoreAdapter } from './goal-template-firestore-adapter.js';

function makeDb(state) {
  const writes = [];
  const doc = path => ({ path, id: path.split('/').pop(), _isDoc: true, get: async () => ({ exists: state[path] !== undefined, data: () => structuredClone(state[path]) }), });
  const collection = name => ({
    path: name,
    get: async () => ({ docs: Object.entries(state).filter(([path]) => path.startsWith(`${name}/`)).map(([path, value]) => ({ id: path.split('/').pop(), data: () => structuredClone(value) })) }),
  });
  return {
    writes,
    doc,
    runTransaction: async handler => handler({
      get: async ref => ref._isDoc ? ({ exists: state[ref.path] !== undefined, data: () => structuredClone(state[ref.path]) }) : ref.get(),
      set: (ref, value) => { writes.push(['set', ref.path, value]); state[ref.path] = structuredClone(value); },
      delete: ref => { writes.push(['delete', ref.path]); delete state[ref.path]; },
    }),
    collection,
  };
}

test('adapter maps the V26 control-plane collections to the domain transaction contract', async () => {
  const db = makeDb({
    'pcgModuleGoalTemplates/t1': { template_id: 't1' },
    'pcgModuleThemeGoals/SCJGB': { theme_id: 'SCJGB' },
    'pcgModuleControl/current': { control_revision: 3, status: 'current' },
  });
  const adapter = createGoalTemplateFirestoreAdapter(db);
  const result = await adapter.runTransaction(async tx => ({
    templates: await tx.listGoalTemplates(),
    themes: await tx.listThemeGoals(),
    control: await tx.getControlHead(),
  }));
  assert.deepEqual(result.templates, { t1: { template_id: 't1' } });
  assert.deepEqual(result.themes, { SCJGB: { theme_id: 'SCJGB' } });
  assert.equal(result.control.control_revision, 3);
});

test('adapter exposes transactional delete primitives and never uses a client-side collection delete', async () => {
  const db = makeDb({ 'pcgModuleGoalTemplates/t1': { template_id: 't1' } });
  const adapter = createGoalTemplateFirestoreAdapter(db);
  await adapter.runTransaction(async tx => {
    tx.deleteGoalTemplate('t1');
    return { code: 'ok' };
  });
  assert.deepEqual(db.writes.map(item => item.slice(0, 2)), [['delete', 'pcgModuleGoalTemplates/t1']]);
  assert.equal(typeof db.collection('pcgModuleGoalTemplates').get().then, 'function');
});
