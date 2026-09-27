import { fingerprintMigrationReport } from './config-migration.js';
import { canonicalJsonText } from './modules-templates.js';

const WRITER_STATES = new Set(['legacy_enabled', 'control_enabled']);
const MIGRATION_PATHS = [
  /^pcgModuleGoalTemplates\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
  /^pcgModuleThemeGoals\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
  /^pcgModuleControl\/current$/,
  /^pcgModuleReadyConfigs\/control-r\d+$/,
  /^pcgModulesConfig\/current$/,
];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equal(left, right) {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function validFingerprint(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function resultRecord(reportFingerprint, status, values = {}) {
  return {
    report_fingerprint: reportFingerprint,
    status,
    created_paths: values.created_paths || [],
    existing_paths: values.existing_paths || [],
    error_code: values.error_code || null,
    retry_report_fingerprint: values.error_code ? reportFingerprint : null,
  };
}

function validateMigrationDocuments(documents) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return { code: 'migration-report-invalid' };
  }
  const paths = documents.map(item => item?.path);
  if (paths.some((path, index) => typeof path !== 'string'
      || !isObject(documents[index]?.value)
      || !MIGRATION_PATHS.some(pattern => pattern.test(path)))) {
    return { code: 'migration-report-invalid' };
  }
  if (new Set(paths).size !== paths.length) return { code: 'migration-report-invalid' };
  const sortedPaths = [...paths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!equal(paths, sortedPaths)) return { code: 'migration-report-invalid' };
  if (paths.filter(path => path === 'pcgModuleControl/current').length !== 1
      || paths.filter(path => path === 'pcgModulesConfig/current').length !== 1
      || paths.filter(path => path.startsWith('pcgModuleReadyConfigs/')).length !== 1) {
    return { code: 'migration-report-invalid' };
  }
  const byPath = new Map(documents.map(document => [document.path, document.value]));
  for (const document of documents) {
    if (document.path.startsWith('pcgModuleGoalTemplates/')) {
      const templateId = document.path.slice('pcgModuleGoalTemplates/'.length);
      if (document.value.template_id !== templateId || document.value.status !== 'active'
          || document.value.template_revision !== 1) return { code: 'migration-report-invalid' };
    }
    if (document.path.startsWith('pcgModuleThemeGoals/')) {
      const themeId = document.path.slice('pcgModuleThemeGoals/'.length);
      if (document.value.theme_id !== themeId || document.value.association_state !== 'unlinked'
          || document.value.template_id !== null || document.value.draft_revision !== 1
          || document.value.effective_revision !== 1) return { code: 'migration-report-invalid' };
    }
    if (document.path.startsWith('pcgModuleReadyConfigs/')) {
      const bundleId = document.path.slice('pcgModuleReadyConfigs/'.length);
      if (document.value.bundle_id !== bundleId) return { code: 'migration-report-invalid' };
    }
  }
  const control = byPath.get('pcgModuleControl/current');
  const pointer = byPath.get('pcgModulesConfig/current');
  const [readyDocument] = documents.filter(document => document.path.startsWith('pcgModuleReadyConfigs/'));
  if (!validEpoch(control?.control_revision) || control.status !== 'current'
      || control.writer_state !== 'legacy_enabled' || !validEpoch(control.writer_epoch)
      || pointer?.status !== 'ready' || pointer.bundle_id !== readyDocument.value.bundle_id
      || pointer.source_control_revision !== readyDocument.value.source_control_revision
      || pointer.sync_revision !== readyDocument.value.sync_revision
      || control.control_revision !== readyDocument.value.source_control_revision) {
    return { code: 'migration-report-invalid' };
  }
  return { code: 'ok' };
}

async function validateReport(report, expectedFingerprint, requireEligible = true) {
  if (!isObject(report) || !validFingerprint(expectedFingerprint)
      || report.report_fingerprint !== expectedFingerprint) {
    return { code: 'migration-report-fingerprint-mismatch' };
  }
  const actualFingerprint = await fingerprintMigrationReport(report);
  if (actualFingerprint !== expectedFingerprint) {
    return { code: 'migration-report-fingerprint-mismatch' };
  }
  const documents = validateMigrationDocuments(report.migration_documents);
  if (documents.code !== 'ok') return documents;
  if (requireEligible && (report.writer_cutover_eligible !== true
      || !Array.isArray(report.conflicts) || report.conflicts.length > 0)) {
    return { code: 'migration-report-not-eligible' };
  }
  return { code: 'ok' };
}

function verificationCode(path) {
  return path.startsWith('pcgModuleReadyConfigs/')
    ? 'migration-ready-bundle-verify-failed'
    : 'migration-document-verify-failed';
}

export function validateConfigWriterEpoch(writerEntry, expectedWriterEpoch) {
  if (!isObject(writerEntry) || !WRITER_STATES.has(writerEntry.writer_state)
      || !validEpoch(writerEntry.writer_epoch) || !validEpoch(expectedWriterEpoch)
      || writerEntry.writer_epoch !== expectedWriterEpoch) {
    return { code: 'writer-fenced' };
  }
  return {
    code: 'ok',
    state: writerEntry.writer_state,
    writer_epoch: writerEntry.writer_epoch,
  };
}

export async function verifyMigrationDocuments(adminAdapter, report, expectedFingerprint) {
  const validation = await validateReport(report, expectedFingerprint);
  if (validation.code !== 'ok') return validation;
  if (!adminAdapter || typeof adminAdapter.readDocuments !== 'function') {
    throw new Error('adminAdapter.readDocuments 必须存在');
  }
  const paths = report.migration_documents.map(item => item.path);
  const current = await adminAdapter.readDocuments(paths);
  for (const document of report.migration_documents) {
    if (!equal(current?.[document.path], document.value)) {
      const code = verificationCode(document.path);
      return {
        code,
        mismatch_path: document.path,
        writer_cutover_eligible: false,
        migration_record: resultRecord(expectedFingerprint, 'failed', { error_code: code }),
      };
    }
  }
  return {
    code: 'ok',
    writer_cutover_eligible: true,
    migration_record: resultRecord(expectedFingerprint, 'verified', { existing_paths: paths }),
  };
}

export async function createIfAbsentMigration(adminAdapter, report, expectedFingerprint) {
  const validation = await validateReport(report, expectedFingerprint);
  if (validation.code !== 'ok') return validation;
  if (!adminAdapter || typeof adminAdapter.readSourceFingerprints !== 'function'
      || typeof adminAdapter.runTransaction !== 'function') {
    throw new Error('adminAdapter 缺少 source fingerprint 或事务接口');
  }
  const currentFingerprints = await adminAdapter.readSourceFingerprints();
  if (!equal(currentFingerprints, report.source_fingerprints)) {
    return { code: 'migration-source-changed' };
  }
  const transactionResult = await adminAdapter.runTransaction(async tx => {
    const existingPaths = [];
    const missingDocuments = [];
    for (const document of report.migration_documents) {
      const existing = await tx.getDocument(document.path);
      if (existing === undefined || existing === null) {
        missingDocuments.push(document);
      } else if (!equal(existing, document.value)) {
        return {
          code: 'migration-existing-document-conflict',
          conflict_path: document.path,
        };
      } else {
        existingPaths.push(document.path);
      }
    }
    for (const document of missingDocuments) {
      tx.createDocument(document.path, clone(document.value));
    }
    return {
      code: 'ok',
      existing_paths: existingPaths,
      created_paths: missingDocuments.map(document => document.path),
    };
  });
  if (transactionResult.code !== 'ok') return transactionResult;
  const verification = await verifyMigrationDocuments(adminAdapter, report, expectedFingerprint);
  if (verification.code !== 'ok') {
    verification.migration_record.created_paths = transactionResult.created_paths;
    verification.migration_record.existing_paths = transactionResult.existing_paths;
    return verification;
  }
  return {
    code: 'ok',
    writer_cutover_eligible: true,
    migration_record: resultRecord(expectedFingerprint, 'complete', transactionResult),
  };
}

export async function cutoverConfigWriter(adminAdapter, command) {
  if (!adminAdapter || typeof adminAdapter.readSourceFingerprints !== 'function'
      || typeof adminAdapter.runTransaction !== 'function') {
    throw new Error('adminAdapter 缺少 source fingerprint 或事务接口');
  }
  if (!isObject(command)) {
    return { code: 'migration-report-invalid' };
  }
  const reportValidation = await validateReport(
    command.report, command.expected_report_fingerprint,
  );
  if (reportValidation.code !== 'ok') return reportValidation;
  const report = command.report;
  const currentFingerprints = await adminAdapter.readSourceFingerprints();
  if (!equal(currentFingerprints, report.source_fingerprints)) {
    return { code: 'migration-source-changed' };
  }
  return adminAdapter.runTransaction(async tx => {
    const controlPath = 'pcgModuleControl/current';
    const controlHead = await tx.getDocument(controlPath);
    const epoch = validateConfigWriterEpoch(controlHead, command.expected_writer_epoch);
    if (epoch.code !== 'ok') return epoch;
    for (const document of report.migration_documents) {
      const current = await tx.getDocument(document.path);
      if (!equal(current, document.value)) {
        const code = verificationCode(document.path);
        return {
          code,
          mismatch_path: document.path,
          writer_cutover_eligible: false,
          migration_record: resultRecord(report.report_fingerprint, 'failed', { error_code: code }),
        };
      }
    }
    const nextWriterEpoch = controlHead.writer_epoch + 1;
    tx.setDocument(controlPath, {
      ...clone(controlHead),
      writer_state: 'control_enabled',
      writer_epoch: nextWriterEpoch,
    });
    return {
      code: 'ok',
      state: 'control_enabled',
      writer_epoch: nextWriterEpoch,
      report_fingerprint: report.report_fingerprint,
    };
  });
}
