// Global, CO-scoped documents search page behavior. Complements the per-repo
// documents.js page: instead of "everything for this repo," this is "everything for
// this CO, across every repo I can access" - see app/routes/documents.js.

document.addEventListener('DOMContentLoaded', () => {
  const CO_PATTERN = /^C[0-9]{8}$/;
  const escapeHtml = window.ApexDom.escapeHtml;

  const coInput = document.getElementById('co-input');
  const searchBtn = document.getElementById('search-btn');
  const errorBox = document.getElementById('search-error');
  const resultsTable = document.getElementById('results-table');
  const rowsEl = document.getElementById('result-rows');
  const viewer = document.getElementById('document-viewer');
  const viewerTitle = document.getElementById('document-viewer-title');
  const viewerBody = document.getElementById('document-viewer-body');

  const DOC_TYPE_LABELS = {
    requirements_log: 'User requirements log (excerpt for this CO)',
    spec_communication_protocol: 'Spec / Communication Protocol',
  };

  function docTypeLabel(docType) {
    return DOC_TYPE_LABELS[docType] || docType;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  function hideError() {
    errorBox.classList.add('d-none');
  }

  function showDocument(doc) {
    viewerTitle.textContent = `${doc.repoName} — ${docTypeLabel(doc.docType)}`;
    viewerBody.innerHTML = window.ApexMarkdown.renderSafeHtml(doc.content);
    viewer.classList.remove('d-none');
    viewer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderRows(documents) {
    if (documents.length === 0) {
      resultsTable.classList.add('d-none');
      showError('No documents found for this CO in any repo you have access to.');
      return;
    }

    resultsTable.classList.remove('d-none');
    rowsEl.innerHTML = documents
      .map((doc) => {
        const updated = new Date(doc.updatedAt).toLocaleString();
        return `<tr>
          <td>${escapeHtml(doc.repoName)}</td>
          <td>${escapeHtml(docTypeLabel(doc.docType))}</td>
          <td>${escapeHtml(updated)}</td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-outline-primary view-btn" data-doc-id="${doc.id}">View</button>
            <a href="/api/repos/${doc.repoId}/documents/${doc.id}/download" class="btn btn-sm btn-outline-secondary">Download</a>
            <a href="/repos/${doc.repoId}/documents" class="btn btn-sm btn-outline-secondary">Full repo docs &rarr;</a>
          </td>
        </tr>`;
      })
      .join('');

    rowsEl.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const doc = documents.find((d) => String(d.id) === btn.dataset.docId);
        if (doc) showDocument(doc);
      });
    });
  }

  async function search() {
    const co = coInput.value.trim().toUpperCase();
    if (!CO_PATTERN.test(co)) {
      showError('Enter a valid CO number (format C followed by 8 digits).');
      return;
    }

    hideError();
    viewer.classList.add('d-none');
    resultsTable.classList.add('d-none');

    try {
      const data = await window.ApexApi.get(`/api/documents?co=${encodeURIComponent(co)}`);
      renderRows(data.documents);
    } catch (err) {
      showError(err.message || 'Failed to search documents');
    }
  }

  searchBtn.addEventListener('click', search);
  coInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') search();
  });
});
