import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeTemplateItems } from './goal-template-control.js';

const target = { spec_id: 'mixed_u4', size: '12x12', roomType: 'Book', ctg: '01', variant: '01' };

test('模板项允许自定义名称和属性，且不从 mixed_u4 推导身份', () => {
  const items = canonicalizeTemplateItems([
    {
      item_id: 'item-001',
      display_name: '东侧大厅变体 A',
      properties: { owner: 'TA-01', priority: 2 },
      expected_count: 1,
      target_refs: [target],
    },
  ], 'mixed_u4');

  assert.equal(items[0].display_name, '东侧大厅变体 A');
  assert.equal(items[0].item_id, 'item-001');
  assert.deepEqual(items[0].target_refs, [target]);
  assert.equal(items[0].module_spec_id, undefined);
});

test('模板项属性 canonical 化但保留模板项顺序', () => {
  const items = canonicalizeTemplateItems([
    {
      item_id: 'item-b', display_name: 'B', properties: { z: 1, a: { y: 2, x: 1 } },
      expected_count: 1, target_refs: [target],
    },
    {
      item_id: 'item-a', display_name: 'A', properties: { b: 2, a: 1 },
      expected_count: 1, target_refs: [{ ...target, variant: '02' }],
    },
  ], 'mixed_u4');

  assert.deepEqual(items.map(item => item.item_id), ['item-b', 'item-a']);
  assert.deepEqual(items[0].properties, { a: { x: 1, y: 2 }, z: 1 });
});

test('模板项拒绝重复 ID、零数量和数量与目标引用不一致', () => {
  const base = {
    item_id: 'item-001', display_name: '大厅', properties: {}, expected_count: 1, target_refs: [target],
  };
  assert.throws(() => canonicalizeTemplateItems([base, { ...base }], 'mixed_u4'), /item_id.*重复/);
  assert.throws(() => canonicalizeTemplateItems([{ ...base, expected_count: 0 }], 'mixed_u4'), /expected_count.*正整数/);
  assert.throws(() => canonicalizeTemplateItems([{ ...base, expected_count: 2 }], 'mixed_u4'), /expected_count.*target_refs/);
});
