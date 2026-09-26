// Per-repo Documents page behavior. Lists every delivery doc documentsService.js has
// stored for this repo (the one cumulative requirements log plus each CO's
// Spec/Communication Protocol doc), lets the user view a rendered preview or download
// the raw markdown. Follows the same ApexApi/ApexDom conventions as branches.js.

document.addEventListener('DOMContentLoaded', () => {
  const escapeHtml = window.ApexDom.escapeHtml;

  const repoId = document.body.dataset.repoId;
  const errorBox = document.getElementById('documents-error');
  const rowsEl = document.getElementById('document-rows');
  const viewer = document.getElementById('document-viewer');
  const viewerTitle = document.getElementById('document-viewer-title');
  const viewerBody = document.getElementById('document-viewer-body');

  const DOC_TYPE_LABELS = {
    requirements_log: 'User requirements log',
    spec_communication_protocol: 'Spec / Communication Protocol',
  };

  function docTypeLabel(docType) {
    return DOC_TYPE_LABELS[docType] || docType;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  function showDocument(doc) {
    viewerTitle.textContent = `${docTypeLabel(doc.docType)}${doc.coNumber ? ` — ${doc.coNumber}` : ''}`;
    viewerBody.innerHTML = window.ApexMarkdown.renderSafeHtml(doc.content);
    viewer.classList.remove('d-none');
    viewer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderRows(documents) {
    if (documents.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="4" class="text-muted">No documents yet for this repo.</td></tr>';
      return;
    }

    rowsEl.innerHTML = documents
      .map((doc) => {
        const updated = new Date(doc.updatedAt).toLocaleString();
        return `<tr>
          <td>${escapeHtml(docTypeLabel(doc.docType))}</td>
          <td>${doc.coNumber ? escapeHtml(doc.coNumber) : '<span class="text-muted">&mdash;</span>'}</td>
          <td>${escapeHtml(updated)}</td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-outline-primary view-btn" data-doc-id="${doc.id}">View</button>
            <a href="/api/repos/${repoId}/documents/${doc.id}/download" class="btn btn-sm btn-outline-secondary">Download</a>
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

  async function loadDocuments() {
    rowsEl.innerHTML = '<tr><td colspan="4" class="text-muted">Loading&hellip;</td></tr>';
    try {
      const data = await window.ApexApi.get(`/api/repos/${repoId}/documents`);
      renderRows(data.documents);
    } catch (err) {
      showError(err.message || 'Failed to load documents');
      rowsEl.innerHTML = '';
    }
  }

  loadDocuments();
});
