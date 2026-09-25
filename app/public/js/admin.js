// Admin page behavior: default view is the 10 most-recently-added users;
// searching (username LIKE, "*" as the wildcard) shows every match instead.
// Clicking a row navigates to that user's Maintenance page
// (/admin/users/:id), where access grants and initials are managed - see
// user-maintenance.js. This page itself no longer mutates anything.

document.addEventListener('DOMContentLoaded', () => {
  const escapeHtml = window.ApexDom.escapeHtml;

  const errorBox = document.getElementById('admin-error');
  const successBox = document.getElementById('admin-success');
  const userRowsEl = document.getElementById('user-rows');
  const userListCaption = document.getElementById('user-list-caption');
  const searchInput = document.getElementById('user-search-input');
  const searchBtn = document.getElementById('user-search-btn');
  const clearBtn = document.getElementById('user-search-clear-btn');
  const alertRowsEl = document.getElementById('alert-rows');
  const activeLockRowsEl = document.getElementById('active-lock-rows');
  const lockContentionRowsEl = document.getElementById('lock-contention-rows');

  function showError(message) {
    successBox.classList.add('d-none');
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  function hideMessages() {
    errorBox.classList.add('d-none');
    successBox.classList.add('d-none');
  }

  function renderUserRows(users) {
    if (users.length === 0) {
      userRowsEl.innerHTML = '<tr><td colspan="4" class="text-muted">No users found.</td></tr>';
      return;
    }

    userRowsEl.innerHTML = users
      .map((u) => {
        const added = new Date(u.createdAt).toLocaleString();
        return `
          <tr class="user-row" data-user-id="${u.id}" style="cursor: pointer">
            <td>${escapeHtml(u.username)}</td>
            <td>${escapeHtml(u.initials)}</td>
            <td>${u.isAdmin ? '<span class="badge bg-primary">Admin</span>' : '<span class="text-muted">&mdash;</span>'}</td>
            <td>${escapeHtml(added)}</td>
          </tr>`;
      })
      .join('');

    userRowsEl.querySelectorAll('.user-row').forEach((row) => {
      row.addEventListener('click', () => {
        window.location.href = `/admin/users/${row.dataset.userId}`;
      });
    });
  }

  async function loadUsers(search) {
    hideMessages();
    const path = search ? `/api/admin/users?search=${encodeURIComponent(search)}` : '/api/admin/users';
    const { users } = await window.ApexApi.get(path);
    userListCaption.textContent = search
      ? `Showing ${users.length} user${users.length === 1 ? '' : 's'} matching "${search}".`
      : 'Showing the 10 most recently added users.';
    renderUserRows(users);
  }

  // Phase 7 - blocked-allowlist alerts + lock-contention dashboard. Not
  // user-specific, so these stay on this page rather than moving to the
  // per-user Maintenance page.

  function renderAlertRows(alerts) {
    if (alerts.length === 0) {
      alertRowsEl.innerHTML = '<tr><td colspan="6" class="text-muted">No blocked-allowlist attempts recorded.</td></tr>';
      return;
    }

    alertRowsEl.innerHTML = alerts
      .map((a) => {
        const when = new Date(a.createdAt).toLocaleString();
        return `<tr>
          <td>${escapeHtml(a.repoName)}</td>
          <td>${escapeHtml(a.coNumber || '—')}</td>
          <td>${escapeHtml(a.branchName)}</td>
          <td>${escapeHtml(a.operation)}</td>
          <td>${a.httpStatus}</td>
          <td>${escapeHtml(when)}</td>
        </tr>`;
      })
      .join('');
  }

  function renderActiveLockRows(locks) {
    if (locks.length === 0) {
      activeLockRowsEl.innerHTML = '<tr><td colspan="4" class="text-muted">No locks currently held.</td></tr>';
      return;
    }

    activeLockRowsEl.innerHTML = locks
      .map((l) => {
        const lockedAt = new Date(l.lockedAt).toLocaleString();
        return `<tr>
          <td>${escapeHtml(l.repoName)}</td>
          <td>${escapeHtml(l.coNumber)}</td>
          <td>${escapeHtml(l.lockedByUsername)}</td>
          <td>${escapeHtml(lockedAt)}</td>
        </tr>`;
      })
      .join('');
  }

  function renderLockContentionRows(contention) {
    if (contention.length === 0) {
      lockContentionRowsEl.innerHTML = '<tr><td colspan="4" class="text-muted">No lock contention recorded.</td></tr>';
      return;
    }

    lockContentionRowsEl.innerHTML = contention
      .map((c) => {
        const lastContendedAt = new Date(c.lastContentionAt).toLocaleString();
        return `<tr>
          <td>${escapeHtml(c.repoName)}</td>
          <td>${escapeHtml(c.coNumber)}</td>
          <td>${c.contentionCount}</td>
          <td>${escapeHtml(lastContendedAt)}</td>
        </tr>`;
      })
      .join('');
  }

  async function loadAlerts() {
    const { alerts } = await window.ApexApi.get('/api/admin/alerts');
    renderAlertRows(alerts);
  }

  async function loadActiveLocks() {
    const { locks } = await window.ApexApi.get('/api/admin/locks');
    renderActiveLockRows(locks);
  }

  async function loadLockContention() {
    const { contention } = await window.ApexApi.get('/api/admin/lock-contention');
    renderLockContentionRows(contention);
  }

  async function loadAll() {
    try {
      await Promise.all([loadUsers(), loadAlerts(), loadActiveLocks(), loadLockContention()]);
    } catch (err) {
      showError(err.message || 'Failed to load admin data');
    }
  }

  function runSearch() {
    const term = searchInput.value.trim();
    loadUsers(term || undefined).catch((err) => showError(err.message || 'Failed to search users'));
  }

  searchBtn.addEventListener('click', runSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    loadUsers().catch((err) => showError(err.message || 'Failed to load users'));
  });

  loadAll();
});
