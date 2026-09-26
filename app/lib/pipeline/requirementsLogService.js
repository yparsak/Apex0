// Phase 5: mechanical, model-free maintenance of the branch's requirements
// log (see roadmap.md's "User requirements log" row and agent-prompts.md's
// "Phase 5" section). This is a RAW, user-authored record - "what was
// asked" - built entirely from this session's already-confirmed
// session_requirements content plus a heading per CO number. No model call
// is made here, unlike specDocService.js: there is no judgment to make,
// only "append this session's confirmed text under this CO's heading."
//
// Distinct artifact from the Spec/Communication Protocol doc
// (specDocService.js), which IS model-authored from code analysis - see
// roadmap.md's explicit "Distinct from the requirements log" note on that
// row.
//
// Text manipulation is intentionally simple, not a Markdown parser: find the
// "## {CO}" heading (or create one at EOF if this CO hasn't been logged on
// this branch yet), then insert the new entry immediately before the next
// "## " heading (or at EOF if this is the last section). That's sufficient
// because this module is the only writer of this file's structure - it never
// has to cope with arbitrary heading levels or formatting some other tool
// produced.
//
// This module stays a pure text-transform module with zero dependencies -
// deliberately unaware of the DB (documentsService.js, which stores the
// result) or the filesystem. pipelineService.js is the one place that wires
// "read existing content from the DB" and "call these transforms" together;
// keeping that DB access out of here also avoids a require cycle, since
// documentsService.js needs extractSectionForCo below for its own
// cross-repo CO lookup.

const HEADING_PATTERN = /^##\s+(.+)$/;

const FILE_HEADER =
  '# Apex user requirements log\n\n' +
  'Raw, chronological record of what was asked, organized under a heading per change order. Append-only - ' +
  'entries are never edited or removed by Apex. Distinct from the Spec/Communication Protocol document (under ' +
  'docs/apex-spec/), which is model-authored from code analysis, not from raw user input - see ' +
  "agent-prompts.md's \"Phase 5\" section.\n";

// Finds the "## {heading}" line and returns the index range [start, end) of
// its section's *body* (everything after the heading line, up to but not
// including the next "## " heading, or EOF) - or null if no such heading
// exists yet.
function findSectionBodyRange(lines, heading) {
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADING_PATTERN);
    if (match && match[1].trim() === heading) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) return null;

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (HEADING_PATTERN.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  return { start: headingIndex + 1, end: sectionEnd };
}

// Appends `entryText` under the "## {heading}" section of `content`,
// creating that heading at the end of the file if it doesn't exist yet.
// Never touches any other section's content.
function appendEntryUnderHeading(content, heading, entryText) {
  const lines = content.length > 0 ? content.split('\n') : [];
  const range = findSectionBodyRange(lines, heading);

  if (range === null) {
    const trimmed = content.replace(/\s+$/, '');
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
    return `${prefix}## ${heading}\n\n${entryText}\n`;
  }

  const before = lines.slice(0, range.end);
  const after = lines.slice(range.end);
  // Trim trailing blank lines from this section's existing body so we don't
  // accumulate ever-growing gaps between entries on repeated appends.
  while (before.length > range.start && before[before.length - 1].trim() === '') before.pop();

  return [...before, '', entryText, '', ...after].join('\n');
}

function formatEntry({ branch, session, submittedBy, requirements }) {
  const timestamp = new Date().toISOString();
  const bullets = requirements.map((r) => `- ${r}`).join('\n');
  return (
    `### ${branch.branchName} — session ${session.id} — ${timestamp}\n\n` +
    `Submitted by ${submittedBy.username} (${submittedBy.initials}).\n\n` +
    `${bullets}`
  );
}

// Pure text transform (exported for testability) - given the log's current
// content (or null if the record doesn't exist yet) and this session's
// confirmed requirements, returns the full updated log content.
function buildUpdatedRequirementsLog({ existingContent, branch, session, submittedBy, requirements }) {
  const base = existingContent === null ? `${FILE_HEADER}\n` : existingContent;
  const entry = formatEntry({ branch, session, submittedBy, requirements });
  return appendEntryUnderHeading(base, branch.coNumber, entry);
}

// Read-side counterpart to appendEntryUnderHeading's heading-range logic: returns just
// one CO's section body (trimmed), or null if this log has no entry for that CO. Used by
// documentsService.js's cross-repo CO search, which can't show a repo's entire
// multi-CO log for every CO someone searches for.
function extractSectionForCo(content, coNumber) {
  if (!content) return null;
  const lines = content.split('\n');
  const range = findSectionBodyRange(lines, coNumber);
  if (range === null) return null;
  return lines.slice(range.start, range.end).join('\n').trim();
}

module.exports = { buildUpdatedRequirementsLog, extractSectionForCo };
