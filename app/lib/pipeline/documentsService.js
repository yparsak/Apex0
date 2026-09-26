// DB-backed storage for Apex-generated delivery docs (the user requirements log and the
// Spec/Communication Protocol doc). These used to be committed straight into the
// customer's repo alongside the pipeline's code changes (see git history on
// pipelineService.js/commitService.js) - they no longer are. Apex now owns them itself:
// one row per (repo, doc_type, co_number) in db/schema.sql's `repo_documents` table,
// browsable/downloadable from the Documents UI, left for the user to add to their repo
// by hand if they want that.
//
// `co_number` uses `''` as the sentinel for repo-level docs (the requirements log is one
// cumulative record per repo, not per CO) rather than NULL - see db/schema.sql's comment
// on this table for why NULL would break the UNIQUE constraint's dedup.

const db = require('../db');
const { extractSectionForCo } = require('./requirementsLogService');

const DOC_TYPES = {
  REQUIREMENTS_LOG: 'requirements_log',
  SPEC_COMMUNICATION_PROTOCOL: 'spec_communication_protocol',
};

async function getDocument({ repoId, docType, coNumber = '' }) {
  const rows = await db.query(
    `SELECT content FROM repo_documents WHERE repo_id = ? AND doc_type = ? AND co_number = ?`,
    [repoId, docType, coNumber]
  );
  return rows[0] ? rows[0].content : null;
}

async function upsertDocument({ repoId, docType, coNumber = '', content }) {
  await db.query(
    `INSERT INTO repo_documents (repo_id, doc_type, co_number, content) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = NOW()`,
    [repoId, docType, coNumber, content]
  );
}

async function listDocumentsForRepo(repoId) {
  return db.query(
    `SELECT id, doc_type AS docType, co_number AS coNumber, content, updated_at AS updatedAt
     FROM repo_documents WHERE repo_id = ? ORDER BY updated_at DESC`,
    [repoId]
  );
}

// Scoped to repoId so a docId from one repo can never be used to read/download another
// repo's document - same "never trust a bare id across a permission boundary" discipline
// repoAccess.js's getRepoForUser already applies to repos themselves.
async function getDocumentForRepoById({ repoId, docId }) {
  const rows = await db.query(
    `SELECT id, doc_type AS docType, co_number AS coNumber, content, updated_at AS updatedAt
     FROM repo_documents WHERE repo_id = ? AND id = ?`,
    [repoId, docId]
  );
  return rows[0] || null;
}

// Cross-repo lookup for the global CO-scoped search: every document, in every repo the
// user has permission to see, that actually concerns this CO. The Spec/Communication
// Protocol doc matches directly on co_number. The requirements log doesn't - it's one
// cumulative row per repo covering every CO ever logged on that branch - so each
// accessible repo's log is run through extractSectionForCo and dropped if that CO never
// appears in it, rather than returning the whole multi-CO file for every repo.
async function listDocumentsForUserAndCo({ userId, coNumber }) {
  const specRows = await db.query(
    `SELECT rd.id, rd.repo_id AS repoId, r.name AS repoName, rd.doc_type AS docType,
            rd.co_number AS coNumber, rd.content, rd.updated_at AS updatedAt
     FROM repo_documents rd
     JOIN repos r ON r.id = rd.repo_id
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN user_repo_group_permissions p ON p.repo_group_id = rg.id
     WHERE p.user_id = ? AND rd.doc_type = ? AND rd.co_number = ?`,
    [userId, DOC_TYPES.SPEC_COMMUNICATION_PROTOCOL, coNumber]
  );

  const logRows = await db.query(
    `SELECT rd.id, rd.repo_id AS repoId, r.name AS repoName, rd.doc_type AS docType,
            rd.co_number AS coNumber, rd.content, rd.updated_at AS updatedAt
     FROM repo_documents rd
     JOIN repos r ON r.id = rd.repo_id
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN user_repo_group_permissions p ON p.repo_group_id = rg.id
     WHERE p.user_id = ? AND rd.doc_type = ?`,
    [userId, DOC_TYPES.REQUIREMENTS_LOG]
  );

  const logMatches = logRows
    .map((row) => ({ ...row, content: extractSectionForCo(row.content, coNumber) }))
    .filter((row) => row.content !== null);

  return [...specRows, ...logMatches];
}

function getDownloadFilename({ docType, coNumber }) {
  if (docType === DOC_TYPES.REQUIREMENTS_LOG) return 'USER_REQ_LOG.md';
  if (docType === DOC_TYPES.SPEC_COMMUNICATION_PROTOCOL) return `SPEC_COM_PROTOCOL-${coNumber}.md`;
  return 'document.md';
}

module.exports = {
  DOC_TYPES,
  getDocument,
  upsertDocument,
  listDocumentsForRepo,
  getDocumentForRepoById,
  listDocumentsForUserAndCo,
  getDownloadFilename,
};
