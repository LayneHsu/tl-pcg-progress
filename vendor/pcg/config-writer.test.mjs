import test from 'node:test';
import assert from 'node:assert/strict';

import { fingerprintMigrationReport } from './config-migration.js';
import {
  createIfAbsentMigration,
  cutoverConfigWriter,
  validateConfigWriterEpoch,
  verifyMigrationDocuments,
} from './config-writer.js';

const FP = value => `sha256:${value.repeat(64)}`;

async function reportFixture() {
  const report = {
    schema_version: 1,
    source_fingerprints: { projects_main: FP('1'), local_theme_config: FP('2') },
    migration_documents: [
      {
        path: 'pcgModuleControl/current',
        value: {
          control_revision: 7,
          status: 'current',
          managed_theme_config_patch: { upserts: [], deletes: [], format_rule_membership: [] },
          conflicts: [],
          writer_state: 'legacy_enabled',
          writer_epoch: 7,
        },
      },
      {
        path: 'pcgModuleReadyConfigs/control-r7',
        value: { bundle_id: 'control-r7', source_control_revision: 7, sync_revision: 3 },
      },
      {
        path: 'pcgModulesConfig/current',
        value: {
          status: 'ready', bundle_id: 'control-r7', source_control_revision: 7,
          sync_revision: 3, error_code: null, pending_theme_ids: [],
        },
      },
    ],
    conflicts: [],
    writer_cutover_eligible: true,
  };
  report.report_fingerprint = await fingerprintMigrationReport(report);
  return report;
}

function memoryAdmin(initialDocuments = {}, sourceFingerprints = {}) {
  const state = {
    documents: structuredClone(initialDocuments),
    sourceFingerprints: structuredClone(sourceFingerprints),
  };
  return {
    state,
    writeCount: 0,
    commitCount: 0,
    async readDocuments(paths) {
      return Object.fromEntries(paths.map(path => [path, structuredClone(state.documents[path])]));
    },
    async readSourceFingerprints() {
      return structuredClone(state.sourceFingerprints);
    },
    async runTransaction(handler) {
      const staged = [];
      const result = await handler({
        getDocument: path => structuredClone(state.documents[path]),
        createDocument: (path, value) => staged.push(['create', path, structuredClone(value)]),
        setDocument: (path, value) => staged.push(['set', path, structuredClone(value)]),
      });
      if (result.code === 'ok') {
        for (const [, path, value] of staged) state.documents[path] = value;
        this.writeCount += staged.length;
        this.commitCount += 1;
      }
      return result;
    },
  };
}

function documentMap(report) {
  return Object.fromEntries(report.migration_documents.map(item => [item.path, item.value]));
}

test('report fingerprint mismatch is rejected before a transaction starts', async () => {
  const report = await reportFixture();
  const adapter = memoryAdmin({}, report.source_fingerprints);
  const result = await createIfAbsentMigration(adapter, report, FP('f'));
  assert.equal(result.code, 'migration-report-fingerprint-mismatch');
  assert.equal(adapter.commitCount, 0);
  assert.equal(adapter.writeCount, 0);
});

test('migration document path identity must match its embedded document identity', async () => {
  const report = await reportFixture();
  report.migration_documents.find(item => item.path === 'pcgModuleReadyConfigs/control-r7')
    .value.bundle_id = 'control-r8';
  report.report_fingerprint = await fingerprintMigrationReport(report);
  const adapter = memoryAdmin({}, report.source_fingerprints);
  const result = await createIfAbsentMigration(adapter, report, report.report_fingerprint);
  assert.equal(result.code, 'migration-report-invalid');
  assert.equal(adapter.commitCount, 0);
  assert.equal(adapter.writeCount, 0);
});

test('one mismatched create-if-absent document makes the migration zero-write', async () => {
  const report = await reportFixture();
  const documents = documentMap(report);
  documents['pcgModuleReadyConfigs/control-r7'] = { ...documents['pcgModuleReadyConfigs/control-r7'], sync_revision: 99 };
  const adapter = memoryAdmin(documents, report.source_fingerprints);
  const result = await createIfAbsentMigration(adapter, report, report.report_fingerprint);
  assert.equal(result.code, 'migration-existing-document-conflict');
  assert.equal(result.conflict_path, 'pcgModuleReadyConfigs/control-r7');
  assert.equal(adapter.writeCount, 0);
});

test('source fingerprint change blocks create-if-absent before a transaction starts', async () => {
  const report = await reportFixture();
  const adapter = memoryAdmin({}, {
    ...report.source_fingerprints,
    projects_main: FP('9'),
  });
  const result = await createIfAbsentMigration(adapter, report, report.report_fingerprint);
  assert.equal(result.code, 'migration-source-changed');
  assert.equal(adapter.commitCount, 0);
  assert.equal(adapter.writeCount, 0);
});

test('create-if-absent retry preserves matching documents and creates only missing paths', async () => {
  const report = await reportFixture();
  const documents = documentMap(report);
  const [firstPath] = report.migration_documents.map(item => item.path);
  const adapter = memoryAdmin({ [firstPath]: documents[firstPath] }, report.source_fingerprints);
  const result = await createIfAbsentMigration(adapter, report, report.report_fingerprint);
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.migration_record.existing_paths, [firstPath]);
  assert.deepEqual(result.migration_record.created_paths, report.migration_documents
    .map(item => item.path).filter(path => path !== firstPath));
  assert.equal(result.migration_record.report_fingerprint, report.report_fingerprint);
  assert.equal(adapter.writeCount, report.migration_documents.length - 1);
  assert.deepEqual(adapter.state.documents, documents);
});

test('ready bundle readback mismatch fails verification and records the stable retry fingerprint', async () => {
  const report = await reportFixture();
  const documents = documentMap(report);
  documents['pcgModuleReadyConfigs/control-r7'] = { ...documents['pcgModuleReadyConfigs/control-r7'], sync_revision: 4 };
  const adapter = memoryAdmin(documents, report.source_fingerprints);
  const result = await verifyMigrationDocuments(adapter, report, report.report_fingerprint);
  assert.equal(result.code, 'migration-ready-bundle-verify-failed');
  assert.equal(result.migration_record.error_code, 'migration-ready-bundle-verify-failed');
  assert.equal(result.migration_record.retry_report_fingerprint, report.report_fingerprint);
  assert.equal(adapter.writeCount, 0);
});

test('source fingerprint change blocks writer cutover without writes', async () => {
  const report = await reportFixture();
  const adapter = memoryAdmin(documentMap(report), {
    ...report.source_fingerprints,
    projects_main: FP('9'),
  });
  const result = await cutoverConfigWriter(adapter, {
    expected_writer_epoch: 7,
    report,
    expected_report_fingerprint: report.report_fingerprint,
  });
  assert.equal(result.code, 'migration-source-changed');
  assert.equal(adapter.writeCount, 0);
  assert.equal(adapter.state.documents['pcgModuleControl/current'].writer_state, 'legacy_enabled');
});

test('cutover independently rejects a report changed after fingerprinting', async () => {
  const report = await reportFixture();
  const adapter = memoryAdmin(documentMap(report), report.source_fingerprints);
  const changed = structuredClone(report);
  changed.migration_documents.find(item => item.path === 'pcgModulesConfig/current')
    .value.sync_revision = 4;
  const result = await cutoverConfigWriter(adapter, {
    expected_writer_epoch: 7,
    report: changed,
    expected_report_fingerprint: report.report_fingerprint,
    source_fingerprints: report.source_fingerprints,
    report_fingerprint: report.report_fingerprint,
    migration_documents: report.migration_documents,
  });
  assert.equal(result.code, 'migration-report-fingerprint-mismatch');
  assert.equal(adapter.writeCount, 0);
});

test('ordinary config writes accept only the current writer epoch', () => {
  const entry = { writer_state: 'legacy_enabled', writer_epoch: 7 };
  assert.equal(validateConfigWriterEpoch(entry, 6).code, 'writer-fenced');
  assert.equal(validateConfigWriterEpoch(entry, 7).code, 'ok');
  assert.equal(validateConfigWriterEpoch(entry, 8).code, 'writer-fenced');
});

test('cutover accepts the current expected epoch and generates exactly next epoch', async () => {
  const report = await reportFixture();
  const adapter = memoryAdmin(documentMap(report), report.source_fingerprints);
  const command = {
    report,
    expected_report_fingerprint: report.report_fingerprint,
  };
  for (const expected of [6, 8]) {
    const rejected = await cutoverConfigWriter(adapter, { ...command, expected_writer_epoch: expected });
    assert.equal(rejected.code, 'writer-fenced');
    assert.equal(adapter.writeCount, 0);
  }
  const result = await cutoverConfigWriter(adapter, { ...command, expected_writer_epoch: 7 });
  assert.equal(result.code, 'ok');
  assert.equal(result.writer_epoch, 8);
  assert.equal(result.state, 'control_enabled');
  assert.equal(adapter.writeCount, 1);
  assert.deepEqual(adapter.state.documents['pcgModuleControl/current'], {
    ...documentMap(report)['pcgModuleControl/current'],
    writer_state: 'control_enabled',
    writer_epoch: 8,
  });
});
