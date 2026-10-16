import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLegacyModuleArtifactMapping, buildLegacyModuleArtifactPlan, normalizeModuleArtifactPlan, resolveModuleArtifactStatuses, summarizeLegacyMapping } from './module-artifacts.js';

test('统一模块产物模型固定五类基础产物，可选风格变体最多四组', () => {
  const plan = normalizeModuleArtifactPlan({
    schema: 'pcg-module-artifacts',
    schema_version: 1,
    theme_id: 'SCJGB',
    modules: [{
      module_key: '24x24_01_01',
      base: {
        template_map: { status: 'present', source: 'scanner' },
        boxed_map: { status: 'missing', source: 'scanner' },
        boxed_bp: { status: 'present', source: 'scanner' },
        production_map: { status: 'planned' },
        production_bp: { status: 'planned' },
      },
      variants: [{ variant_id: 'style_01', label: '藏品区', artifacts: { map: {}, bp: {} } }],
    }],
  });
  assert.deepEqual(Object.keys(plan.modules[0].artifacts), [
    'template_map',
    'boxed_map',
    'boxed_bp',
    'production_map',
    'production_bp',
  ]);
  assert.equal(plan.modules[0].variants[0].variant_id, 'style_01');
  assert.throws(() => normalizeModuleArtifactPlan({
    schema: 'pcg-module-artifacts',
    schema_version: 1,
    theme_id: 'SCJGB',
    modules: [{
      module_key: 'm',
      variants: [1, 2, 3, 4, 5],
    }],
  }), /不能超过 4 组/);
});

test('状态解析区分固定产物和已配置变体，未配置变体不进分母', () => {
  const resolved = resolveModuleArtifactStatuses({
    schema: 'pcg-module-artifacts',
    schema_version: 1,
    theme_id: 'SCJGB',
    modules: [{
      module_key: 'm',
      base: {},
      variants: [{ variant_id: 'style_01', artifacts: { map: {}, bp: {} } }],
    }],
  }, {
    m: {
      template_map: true,
      boxed_map: true,
      boxed_bp: true,
      production_map: false,
      production_bp: false,
      variants: { style_01: { map: true, bp: false } },
    },
  });
  assert.equal(resolved.summary.required, 7);
  assert.equal(resolved.summary.present, 4);
  assert.equal(resolved.summary.by_group.base.required, 5);
  assert.equal(resolved.summary.by_group.style_variant.required, 2);
  assert.equal(resolved.summary.completion_pct, 57.1);
});

test('SCJGB 旧工作项只生成候选映射，不自动确认语义', async () => {
  const store = JSON.parse(await readFile(new URL('../data/store.json', import.meta.url), 'utf8'));
  const mapping = buildLegacyModuleArtifactMapping(store, 'SCJGB');
  const summary = summarizeLegacyMapping(mapping);
  assert.equal(mapping.confirmed, false);
  assert.equal(summary.theme_id, 'SCJGB');
  assert.ok(summary.module_count > 0);
  assert.ok(summary.variant_group_count >= 1);
  assert.ok(summary.fixed_candidate_counts.template_map > 0);
  assert.ok(summary.fixed_candidate_counts.template_map <= summary.module_count);
  assert.equal(summary.fixed_candidate_counts.boxed_map, summary.fixed_candidate_counts.boxed_bp);
  assert.ok(summary.collision_candidate_count > 0);
  assert.ok(mapping.assumptions.some(item => item.includes('临时BP')));
});

test('已确认的 SCJGB 映射生成五类基础产物和四组变体计划', async () => {
  const store = JSON.parse(await readFile(new URL('../data/store.json', import.meta.url), 'utf8'));
  const mapping = buildLegacyModuleArtifactMapping(store, 'SCJGB');
  const plan = buildLegacyModuleArtifactPlan(mapping);
  assert.equal(plan.confirmed, true);
  assert.equal(plan.mapping_state, 'confirmed_partial');
  assert.equal(plan.modules[0].variants.length, 4);
  assert.equal(plan.modules[0].base.template_map.required, true);
  assert.equal(plan.modules[0].base.boxed_map.required, true);
  assert.equal(plan.modules[0].base.boxed_bp.required, true);
  assert.equal(plan.modules[0].base.production_map.status, 'planned');
  assert.equal(plan.modules[0].base.production_bp.status, 'planned');
});

test('部署副本与源码解析器保持一致', async () => {
  const source = await readFile(new URL('./module-artifacts.js', import.meta.url), 'utf8');
  const deploy = await readFile(new URL('../deploy/vendor/pcg/module-artifacts.js', import.meta.url), 'utf8');
  assert.equal(deploy, source);
});
