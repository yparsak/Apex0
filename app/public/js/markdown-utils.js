// Shared markdown render+sanitize helper for the Documents pages (documents.js,
// documents-search.js). Content here is either LLM-generated (the Spec/Communication
// Protocol doc, from specDocService.js's model calls) or mechanically assembled from
// user-submitted text (the requirements log) - either way it's untrusted before going
// into innerHTML, so this always runs marked's output through DOMPurify, never raw.

window.ApexMarkdown = {
  renderSafeHtml(markdownText) {
    const rawHtml = window.marked.parse(markdownText || '');
    return window.DOMPurify.sanitize(rawHtml);
  },
};
