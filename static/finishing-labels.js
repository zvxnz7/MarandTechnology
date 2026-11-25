'use strict';

const labelSettingsDialog = document.getElementById('label-settings');
document.querySelector('[data-label-settings-open]')?.addEventListener('click', () => {
  if (typeof labelSettingsDialog?.showModal === 'function') labelSettingsDialog.showModal();
  else labelSettingsDialog?.setAttribute('open', '');
});
document.querySelectorAll('[data-label-settings-close]').forEach(button => button.addEventListener('click', () => {
  if (typeof labelSettingsDialog?.close === 'function') labelSettingsDialog.close();
  else labelSettingsDialog?.removeAttribute('open');
}));
document.querySelector('[data-label-print]')?.addEventListener('click', () => window.print());

const labelSettingsForm = labelSettingsDialog?.querySelector('form');
const labelPreview = labelSettingsDialog?.querySelector('.finishing-label-preview');
const escapeLabelHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const refreshLabelPreview = () => {
  if (!labelSettingsForm || !labelPreview) return;
  const checked = new Set([...labelSettingsForm.querySelectorAll('input[type="checkbox"][name^="label_field_"]:checked')].map(input => input.name.replace('label_field_', '').replaceAll('_', '-')));
  labelPreview.querySelectorAll('[data-label-key]').forEach(row => { row.hidden = !checked.has(row.dataset.labelKey); });
  const extra = labelSettingsForm.elements.namedItem('extra_text')?.value.trim();
  const extraRow = labelPreview.querySelector('[data-label-key="extra-text"]');
  if (extraRow) { extraRow.hidden = !checked.has('extra-text') || !extra; extraRow.querySelector('strong').textContent = extra; }
  const color = labelSettingsForm.elements.namedItem('color_text')?.value.trim();
  const colorRow = labelPreview.querySelector('[data-label-key="color"]');
  if (colorRow && color) colorRow.querySelector('strong').textContent = color;
  const brandMode = labelSettingsForm.elements.namedItem('brand_mode')?.value || 'logo';
  let brand = labelPreview.querySelector('[data-label-brand]');
  if (brandMode === 'logo' || brandMode === 'client-logo' || brandMode === 'text') {
    if (!brand || (brandMode === 'text') !== brand.classList.contains('label-custom-brand')) {
      brand?.remove();
      brand = document.createElement(brandMode === 'text' ? 'div' : 'img');
      brand.dataset.labelBrand = '';
      brand.className = brandMode === 'text' ? 'label-custom-brand' : 'label-logo';
      labelPreview.prepend(brand);
    }
    if (brandMode === 'text') brand.textContent = labelSettingsForm.elements.namedItem('brand_text')?.value.trim() || '';
    else { brand.src = brandMode === 'logo' ? '/static/marand-label-logo.png' : labelSettingsForm.elements.namedItem('client_logo')?.value || ''; brand.alt = brandMode === 'logo' ? 'MARAND Technical textiles' : 'Logo klienta'; }
    brand.hidden = brandMode === 'text' && !brand.textContent.trim() || brandMode === 'client-logo' && !brand.getAttribute('src');
  } else brand?.remove();
  const quantity = labelSettingsForm.elements.namedItem('quantity_unit')?.value || 'meters';
  const quantityRow = labelPreview.querySelector('[data-label-key="quantity"]');
  const quantityData = quantityRow?.querySelector('strong');
  if (quantityRow && quantityData) {
    quantityData.textContent = quantity === 'weight' ? quantityRow.dataset.quantityKg : quantityRow.dataset.quantityMeters;
    const title = quantityRow.querySelector('span');
    if (title) title.textContent = quantity === 'weight' ? (labelSettingsForm.elements.namedItem('lang')?.value === 'en' ? 'QUANTITY [kg]' : 'ILOŚĆ [kg]') : (labelSettingsForm.elements.namedItem('lang')?.value === 'en' ? 'QUANTITY [m]' : 'ILOŚĆ [mb]');
    const includeMeters = labelSettingsForm.elements.namedItem('include_meters')?.checked;
    let secondary = quantityRow.querySelector('.label-secondary-quantity');
    if (quantity === 'weight' && includeMeters) {
      if (!secondary) { secondary = document.createElement('small'); secondary.className = 'label-secondary-quantity'; quantityRow.querySelector('div')?.append(secondary); }
      secondary.textContent = `${labelSettingsForm.elements.namedItem('lang')?.value === 'en' ? 'LENGTH [m]' : 'DŁUGOŚĆ [m]'}: ${quantityRow.dataset.quantityMeters}`;
    } else secondary?.remove();
  }
};
labelSettingsForm?.addEventListener('input', refreshLabelPreview);
labelSettingsForm?.addEventListener('change', refreshLabelPreview);
refreshLabelPreview();
