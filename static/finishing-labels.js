'use strict';

const labelSettingsDialog = document.getElementById('label-settings');
document.querySelector('[data-label-settings-open]')?.addEventListener('click', () => {
  if (typeof labelSettingsDialog?.showModal === 'function') labelSettingsDialog.showModal();
  else labelSettingsDialog?.setAttribute('open', '');
});
document.querySelector('[data-label-settings-close]')?.addEventListener('click', () => {
  if (typeof labelSettingsDialog?.close === 'function') labelSettingsDialog.close();
  else labelSettingsDialog?.removeAttribute('open');
});
document.querySelector('[data-label-print]')?.addEventListener('click', () => window.print());
