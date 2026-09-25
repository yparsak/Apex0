// User Maintenance page behavior: the same initials-editing and
// repo-group-access grant/revoke that used to live on the flat /admin page
// (see app/public/js/admin.js's history), but scoped to a single user via
// the :userId in the URL. Same "reload the source of truth after any
// mutation" convention as admin.js.

document.addEventListener('DOMContentLoaded', () => {
  const escapeHtml = window.ApexDom.escapeHtml;
  const userId = Number(document.body.dataset.userId);

  const errorBox = document.getElementById('maintenance-error');
  const successBox = document.getElementById('maintenance-success');
  const userHeading = document.getElementById('user-heading');
  const initialsInput = document.getElementById('initials-input');
  const saveInitialsBtn = document.getElementById('save-initials-btn');
  const grantRepoGroupSelect = document.getElementById('grant-repo-group-select');
  const grantBtn = document.getElementById('grant-btn');
  const permissionRowsEl = document.getElementById('permission-rows');

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

  function renderUserHeading(targetUser) {
    const adminBadge = targetUser.isAdmin ? ' <span class="badge bg-primary">Admin</span>' : '';
    userHeading.innerHTML = `${escapeHtml(targetUser.username)}${adminBadge}`;
    initialsInput.value = targetUser.initials;
  }

  function renderPermissionRows(permissions) {
    if (permissions.length === 0) {
      permissionRowsEl.innerHTML = '<tr><td colspan="4" class="text-muted">No access granted yet.</td></tr>';
      return;
    }

    permissionRowsEl.innerHTML = permissions
      .map((p) => {
        const granted = new Date(p.createdAt).toLocaleString();
        return `<tr>
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

  async function loadUser() {
    const { user: targetUser } = await window.ApexApi.get(`/api/admin/users/${userId}`);
    renderUserHeading(targetUser);
  }

  async function loadRepoGroups() {
    const { repoGroups } = await window.ApexApi.get('/api/admin/repo-groups');
    grantRepoGroupSelect.innerHTML = repoGroups
      .map((rg) => `<option value="${rg.id}">${escapeHtml(rg.orgName)} / ${escapeHtml(rg.name)}</option>`)
      .join('');
  }

  async function loadPermissions() {
    const { permissions } = await window.ApexApi.get(`/api/admin/permissions?userId=${userId}`);
    renderPermissionRows(permissions);
  }

  async function loadAll() {
    try {
      await Promise.all([loadUser(), loadRepoGroups(), loadPermissions()]);
    } catch (err) {
      showError(err.message || 'Failed to load user');
    }
  }

  async function saveInitials() {
    hideMessages();
    const initials = initialsInput.value.trim();
    if (!initials) {
      showError('Initials cannot be empty.');
      return;
    }

    try {
      await window.ApexApi.put(`/api/admin/users/${userId}/initials`, { initials });
      showSuccess('Initials updated.');
      await loadUser();
    } catch (err) {
      showError(err.message || 'Failed to update initials');
    }
  }

  async function grantAccess() {
    hideMessages();
    const repoGroupId = Number(grantRepoGroupSelect.value);
    if (!repoGroupId) {
      showError('Select a repo group.');
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

  saveInitialsBtn.addEventListener('click', saveInitials);
  grantBtn.addEventListener('click', grantAccess);

  loadAll();
});
