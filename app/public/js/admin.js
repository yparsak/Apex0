// Admin page behavior (Phase 6) - user list with inline initials editing,
// and repo-group access grant/revoke. All three lists (users, repo groups,
// permissions) are re-fetched after any mutation, same "reload the source
// of truth rather than hand-patch client state" convention branches.js's
// resolveCo() already follows.

document.addEventListener('DOMContentLoaded', () => {
  const escapeHtml = window.ApexDom.escapeHtml;

  const errorBox = document.getElementById('admin-error');
  const successBox = document.getElementById('admin-success');
  const userRowsEl = document.getElementById('user-rows');
  const permissionRowsEl = document.getElementById('permission-rows');
  const grantUserSelect = document.getElementById('grant-user-select');
  const grantRepoGroupSelect = document.getElementById('grant-repo-group-select');
  const grantBtn = document.getElementById('grant-btn');
  const alertRowsEl = document.getElementById('alert-rows');
  const activeLockRowsEl = document.getElementById('active-lock-rows');
  const lockContentionRowsEl = document.getElementById('lock-contention-rows');

  let currentUsers = [];

  function showError(message) {
    successBox.classList.add('d-none');
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  function showSuccess(message) {
    errorBox.classList.add('d-none');
    successBox.textContent = message;
    successBox.classList.remove('d-none');
  }

  function hideMessages() {
    errorBox.classList.add('d-none');
    successBox.classList.add('d-none');
  }

  function renderUserOptions(select) {
    select.innerHTML = currentUsers
      .map((u) => `<option value="${u.id}">${escapeHtml(u.username)} (${escapeHtml(u.initials)})</option>`)
      .join('');
  }

  function renderUserRows() {
    if (currentUsers.length === 0) {
      userRowsEl.innerHTML = '<tr><td colspan="4" class="text-muted">No users yet.</td></tr>';
      return;
    }

    userRowsEl.innerHTML = currentUsers
      .map(
        (u) => `
          <tr>
            <td>${escapeHtml(u.username)}</td>
            <td>
              <input type="text" class="form-control form-control-sm initials-input" style="max-width: 6rem"
                     data-user-id="${u.id}" value="${escapeHtml(u.initials)}" maxlength="10">
            </td>
            <td>${u.isAdmin ? '<span class="badge bg-primary">Admin</span>' : '<span class="text-muted">&mdash;</span>'}</td>
            <td><button type="button" class="btn btn-sm btn-outline-primary save-initials-btn" data-user-id="${u.id}">Save</button></td>
          </tr>`
      )
      .join('');

    userRowsEl.querySelectorAll('.save-initials-btn').forEach((btn) => {
      btn.addEventListener('click', () => saveInitials(Number(btn.dataset.userId)));
    });
  }

  function renderPermissionRows(permissions) {
    if (permissions.length === 0) {
      permissionRowsEl.innerHTML = '<tr><td colspan="5" class="text-muted">No access granted yet.</td></tr>';
      return;
    }

    permissionRowsEl.innerHTML = permissions
      .map((p) => {
        const granted = new Date(p.createdAt).toLocaleString();
        return `<tr>
          <td>${escapeHtml(p.username)} (${escapeHtml(p.initials)})</td>
          <td>${escapeHtml(p.orgName)}</td>
          <td>${escapeHtml(p.repoGroupName)}</td>
          <td>${escapeHtml(granted)}</td>
          <td><button type="button" class="btn btn-sm btn-outline-danger revoke-btn" data-permission-id="${p.id}">Revoke</button></td>
        </tr>`;
      })
      .join('');

    permissionRowsEl.querySelectorAll('.revoke-btn').forEach((btn) => {
      btn.addEventListener('click', () => revokePermission(Number(btn.dataset.permissionId)));
    });
  }

  async function loadUsers() {
    const { users } = await window.ApexApi.get('/api/admin/users');
    currentUsers = users;
    renderUserRows();
    renderUserOptions(grantUserSelect);
  }

  async function loadRepoGroups() {
    const { repoGroups } = await window.ApexApi.get('/api/admin/repo-groups');
    grantRepoGroupSelect.innerHTML = repoGroups
      .map((rg) => `<option value="${rg.id}">${escapeHtml(rg.orgName)} / ${escapeHtml(rg.name)}</option>`)
      .join('');
  }

  async function loadPermissions() {
    const { permissions } = await window.ApexApi.get('/api/admin/permissions');
    renderPermissionRows(permissions);
  }

  // Phase 7 - blocked-allowlist alerts + lock-contention dashboard. Same
  // "reload the source of truth" convention as the rest of this file; these
  // are read-only, so there's no mutation to trigger a reload from - they
  // just load once with everything else.

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
      await Promise.all([
        loadUsers(),
        loadRepoGroups(),
        loadPermissions(),
        loadAlerts(),
        loadActiveLocks(),
        loadLockContention(),
      ]);
    } catch (err) {
      showError(err.message || 'Failed to load admin data');
    }
  }

  async function saveInitials(userId) {
    hideMessages();
    const input = userRowsEl.querySelector(`.initials-input[data-user-id="${userId}"]`);
    const initials = input.value.trim();
    if (!initials) {
      showError('Initials cannot be empty.');
      return;
    }

    try {
      await window.ApexApi.put(`/api/admin/users/${userId}/initials`, { initials });
      showSuccess('Initials updated.');
      await loadUsers();
    } catch (err) {
      showError(err.message || 'Failed to update initials');
    }
  }

  async function grantAccess() {
    hideMessages();
    const userId = Number(grantUserSelect.value);
    const repoGroupId = Number(grantRepoGroupSelect.value);
    if (!userId || !repoGroupId) {
      showError('Select both a user and a repo group.');
      return;
    }

    try {
      await window.ApexApi.post('/api/admin/permissions', { userId, repoGroupId });
      showSuccess('Access granted.');
      await loadPermissions();
    } catch (err) {
      showError(err.message || 'Failed to grant access');
    }
  }

  async function revokePermission(permissionId) {
    hideMessages();
    try {
      await window.ApexApi.delete(`/api/admin/permissions/${permissionId}`);
      showSuccess('Access revoked.');
      await loadPermissions();
    } catch (err) {
      showError(err.message || 'Failed to revoke access');
    }
  }

  grantBtn.addEventListener('click', grantAccess);

  loadAll();
});
