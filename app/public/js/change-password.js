// Change-password page behavior - posts to POST /auth/change-password and
// shows a success/error alert in place, matching login.js's error-handling
// pattern for the ApexApi envelope.

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('change-password-form');
  const errorBox = document.getElementById('change-password-error');
  const successBox = document.getElementById('change-password-success');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('d-none');
    successBox.classList.add('d-none');

    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;

    if (newPassword !== confirmPassword) {
      errorBox.textContent = 'New password and confirmation do not match';
      errorBox.classList.remove('d-none');
      return;
    }

    try {
      await window.ApexApi.post('/auth/change-password', { currentPassword, newPassword });
      form.reset();
      successBox.textContent = 'Password changed successfully';
      successBox.classList.remove('d-none');
    } catch (err) {
      errorBox.textContent = err.message || 'Failed to change password';
      errorBox.classList.remove('d-none');
    }
  });
});
