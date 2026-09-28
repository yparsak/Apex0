// System-prompt / conversation-strategy content for the Spec/Communication Protocol
// doc, rewritten for the trunk-staleness rework (see specDocScanService.js /
// specDocJobService.js / specDocService.js). This doc is no longer branch- or
// CO-scoped and no longer framed around a diff: it always describes the CURRENT state
// of a repo's default (trunk) branch, one doc per repo, regenerated whenever trunk
// moves. Same two-step, non-tool-calling, fenced-code-block-plus-deterministic-parse
// convention the rest of this project already uses.
//
// Reuses app/lib/pipeline/pipelinePrompts.js's formatFileListForPrompt/FILES_NEEDED_TAG
// rather than re-implementing either - same reuse-before-new-helper discipline this
// project already follows.

const { formatFileListForPrompt, FILES_NEEDED_TAG } = require('./pipelinePrompts');

const SPEC_DECISION_TAG = 'spec-decision';
const SPEC_DOCUMENT_TAG = 'spec-document';

function formatExistingDocForPrompt(existingDoc) {
  return existingDoc === null
    ? 'No existing Spec/Communication Protocol document was found for this repo.'
    : `Existing Spec/Communication Protocol document content:\n${existingDoc}`;
}

// Step 1: decide whether this repo's trunk branch has an API surface worth documenting
// at all, before spending a file-selection call and a generation call on one that
// doesn't. Staleness itself (has trunk moved since the doc was last generated) is
// already established by the scanner via commit-sha comparison before this job was
// enqueued - this step is not a second "is it still current" judgment competing with
// that, only "is there anything here to document in the first place."
function buildSpecDecisionMessages({ repo, fileListing, existingDoc }) {
  const system = [
    `You are Apex, judging whether repo ${repo.name}'s ${repo.defaultBranchName} branch has an API surface ` +
      'worth documenting in a Spec/Communication Protocol document.',
    'This document exists to describe the API surface (HTTP endpoints, request/response contracts, message ' +
      `formats, or any other externally-callable interface) that ${repo.defaultBranchName} currently exposes, so ` +
      'downstream reviewers/integrators do not have to read every file to understand what is callable.',
    'You have no tools and cannot execute code or fetch anything further - judge only from the file listing and ' +
      'the existing document (if any) given to you below.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${SPEC_DECISION_TAG}" containing a JSON object with exactly one boolean field:\n` +
      '```' +
      SPEC_DECISION_TAG +
      '\n{"hasApiSurface": true}\n' +
      '```',
    '"hasApiSurface" is true if this repo\'s code currently exposes some kind of API surface at all (HTTP ' +
      'routes/endpoints, public functions meant to be called externally, a message/event contract, etc.) - false ' +
      'for a repo with no such surface (e.g. only internal tooling, styling, docs, or config).',
  ].join('\n\n');

  const user = [formatFileListForPrompt(fileListing), formatExistingDocForPrompt(existingDoc)].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Step 2 (only reached when step 1 says hasApiSurface): same "which files do you need to
// read in full" shape Phase 4's code-gen already uses (buildFileSelectionMessages in
// pipelinePrompts.js), reusing the exact same FILES_NEEDED_TAG/parseFilesNeeded pair
// rather than a doc-specific duplicate.
function buildSpecFileSelectionMessages({ repo, fileListing }) {
  const system = [
    `You are Apex, about to write the Spec/Communication Protocol document for repo ${repo.name}'s ` +
      `${repo.defaultBranchName} branch. This document must describe the CURRENT API surface ${repo.defaultBranchName} ` +
      'exposes right now.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${FILES_NEEDED_TAG}" containing a JSON array of repo-relative file paths, copied exactly as they appear ` +
      'in the file listing below - every file you need to read in full to describe the current API surface ' +
      'completely and accurately (route/controller files, schema/contract definitions, request handlers, etc.). ' +
      'An empty array is a valid reply if you judge the file listing alone is enough (unusual, but not an error).',
    'Only name paths that appear in the listing below - a path that is not in the listing cannot be resolved and ' +
      'will fail this step rather than being guessed at or skipped.',
  ].join('\n\n');

  const user = formatFileListForPrompt(fileListing);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Step 3: emit the ENTIRE document as plain Markdown prose (not JSON - this is document
// content, not structured data), given the content of whatever files step 2 asked for.
function buildSpecDocumentMessages({ repo, fileListing, fileContents }) {
  const system = [
    `You are Apex, writing the entire Spec/Communication Protocol document for repo ${repo.name}'s ` +
      `${repo.defaultBranchName} branch.`,
    `This document must describe the CURRENT API surface ${repo.defaultBranchName} exposes as of right now. Write ` +
      'it so a new engineer or integrator could read only this document and understand every externally-callable ' +
      'interface this repo provides: endpoints/routes, request/response shapes, authentication expectations, and ' +
      'anything else a caller needs to know.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${SPEC_DOCUMENT_TAG}" containing the ENTIRE document as plain Markdown prose (not JSON - this is ` +
      'document content, not structured data). The block must fully replace any prior version of this document ' +
      '- do not write "unchanged" or refer to a prior version for any section; describe the current, complete state.',
  ].join('\n\n');

  const fileBlocks =
    Object.keys(fileContents).length === 0
      ? '(no files were requested in the previous step)'
      : Object.entries(fileContents)
          .map(([filePath, content]) => `--- ${filePath} ---\n${content}`)
          .join('\n\n');

  const user = [formatFileListForPrompt(fileListing), `Full content of the files you requested:\n${fileBlocks}`].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

module.exports = {
  buildSpecDecisionMessages,
  buildSpecFileSelectionMessages,
  buildSpecDocumentMessages,
  SPEC_DECISION_TAG,
  SPEC_DOCUMENT_TAG,
};
