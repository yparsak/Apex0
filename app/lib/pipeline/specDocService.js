// Spec/Communication Protocol doc regeneration, rewritten for the trunk-staleness
// rework - see specDocScanService.js (detects staleness, enqueues a job),
// specDocJobService.js (the queue), and worker.js (drains it). This is no longer part
// of the per-session pipeline: it runs against a repo's default (trunk) branch tree
// directly (app/lib/pipeline/workingTreeService.js's downloadAndExtractTree, same as
// pipelineService.js uses, just against trunk instead of a dev branch), with no branch,
// CO number, or diff involved at all - one doc per repo, always describing trunk's
// current state.
//
// A repo-scan job has no `session`/`actingUserId` the way a user-driven pipeline run
// does, so unlike Phase 3/4/5's model calls this does NOT go through
// app/lib/branches/sessionService.js's runChatTurn (which persists to `conversations`/
// `audit_log`, both scoped to a user session) - it calls the model adapter directly.
// Observability is via `logger`, the same as worker.js's own poll/claim/scan logging.

const fs = require('fs/promises');
const path = require('path');
const logger = require('../logger');
const { getModelAdapter } = require('../model');
const { listFilePaths } = require('./workingTreeService');
const { getDocument, upsertDocument, DOC_TYPES } = require('./documentsService');
const {
  buildSpecDecisionMessages,
  buildSpecFileSelectionMessages,
  buildSpecDocumentMessages,
  SPEC_DECISION_TAG,
  SPEC_DOCUMENT_TAG,
} = require('./specDocPrompts');
const { parseSpecDecision, parseSpecDocument } = require('./specDocResponseParsing');
const { parseFilesNeeded } = require('./pipelineResponseParsing');
const { FILES_NEEDED_TAG } = require('./pipelinePrompts');

function makeSpecDocError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function chat(messages) {
  const { content } = await getModelAdapter().chat({ messages });
  return content;
}

async function decideSpecDocAction({ repo, fileListing, existingDoc }) {
  const reply = await chat(buildSpecDecisionMessages({ repo, fileListing, existingDoc }));

  const decision = parseSpecDecision(reply);
  if (decision === null) {
    throw makeSpecDocError(
      `Model reply for spec-doc decision (expected a fenced "${SPEC_DECISION_TAG}" block) could not be parsed`,
      'SPEC_DECISION_PARSE_FAILED'
    );
  }
  return decision;
}

async function selectFilesForSpecDoc({ repo, treeDir, fileListing }) {
  const reply = await chat(buildSpecFileSelectionMessages({ repo, fileListing }));

  const selected = parseFilesNeeded(reply);
  if (selected === null) {
    throw makeSpecDocError(
      `Model reply for spec-doc file selection (expected a fenced "${FILES_NEEDED_TAG}" block) could not be parsed`,
      'SPEC_DECISION_PARSE_FAILED'
    );
  }

  for (const relPath of selected) {
    try {
      await fs.access(path.join(treeDir, relPath));
    } catch (err) {
      throw makeSpecDocError(
        `Model requested a file for the spec doc that does not exist in the working tree: ${relPath}`,
        'SPEC_DECISION_PARSE_FAILED'
      );
    }
  }
  return selected;
}

async function generateSpecDocument({ repo, fileListing, fileContents }) {
  const reply = await chat(buildSpecDocumentMessages({ repo, fileListing, fileContents }));

  const document = parseSpecDocument(reply);
  if (document === null) {
    throw makeSpecDocError(
      `Model reply for spec document (expected a fenced "${SPEC_DOCUMENT_TAG}" block) could not be parsed`,
      'SPEC_DOCUMENT_PARSE_FAILED'
    );
  }
  return document;
}

// Regenerates repo's Spec/Communication Protocol doc from treeDir (trunk's current
// state) and persists it. Returns true if a doc was written, false if the decision step
// judged this repo has no API surface worth documenting (the doc, if any existed from a
// time the repo did have one, is left as-is rather than deleted - a repo losing its API
// surface is rare and worth a human noticing via a now-stale doc, not silent deletion).
async function regenerateSpecDoc({ repo, treeDir }) {
  const fileListing = await listFilePaths(treeDir);
  const existingDoc = await getDocument({ repoId: repo.id, docType: DOC_TYPES.SPEC_COMMUNICATION_PROTOCOL });

  const decision = await decideSpecDocAction({ repo, fileListing, existingDoc });
  if (!decision.hasApiSurface) {
    logger.info('spec doc regeneration skipped: no API surface', { repoId: repo.id, repoName: repo.name });
    return false;
  }

  const selectedFiles = await selectFilesForSpecDoc({ repo, treeDir, fileListing });
  const fileContents = {};
  for (const relPath of selectedFiles) {
    fileContents[relPath] = await fs.readFile(path.join(treeDir, relPath), 'utf-8');
  }

  const content = await generateSpecDocument({ repo, fileListing, fileContents });
  await upsertDocument({ repoId: repo.id, docType: DOC_TYPES.SPEC_COMMUNICATION_PROTOCOL, content });

  logger.info('spec doc regenerated', { repoId: repo.id, repoName: repo.name });
  return true;
}

module.exports = { regenerateSpecDoc };
