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
document.querySelector('[data-label-print]')?.addEventListener('click', () => {
  fitAllLabelRows();
  const manualLabels=document.querySelector('[data-manual-labels]');
  if(!manualLabels){window.print();return;}
  const printWindow=window.open('','_blank');
  if(!printWindow){window.print();return;}
  const printLanguage=manualLabels.querySelector('[data-manual-label]')?.lang||'pl';
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html lang="${printLanguage}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Etykiety</title><link rel="icon" type="image/png" href="/static/favicon.png"><style>
    @page{size:50mm 74mm;margin:0}
    *{box-sizing:border-box}
    html,body{width:50mm;margin:0;padding:0;background:#fff;color:#111;font-family:Arial,sans-serif}
    .labels{display:block;width:50mm;margin:0;padding:0}
    .label{box-sizing:border-box;width:50mm;height:73mm;margin:0;padding:2.5mm 3mm;overflow:hidden;position:relative;display:flex;flex-direction:column;background:#fff;color:#111;font:8pt/1.18 Arial,sans-serif;page-break-inside:avoid;break-inside:avoid}
    .label+.label{page-break-before:always;break-before:page}
    .label-logo{display:block;max-width:44mm!important;width:auto!important;height:auto!important;max-height:13mm!important;object-fit:contain;object-position:center;margin:0 auto 2mm}
    .label-custom-brand{min-height:12mm;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12pt;font-weight:700;margin:0 0 2mm;overflow:hidden}
    .label-content{display:flex;flex:1;flex-direction:column;gap:1.1mm;min-height:0;position:relative;padding-bottom:13mm;overflow:hidden}
    .label-row{display:flex;flex:0 0 auto;flex-wrap:nowrap;justify-content:space-between;align-items:baseline;gap:2mm;border-bottom:.2mm solid #d5d8da;padding-bottom:.6mm}
    .label-row-before-quantity{border-bottom:0;padding-bottom:0}
    .label-row span{flex:0 0 auto;font-size:6.2pt;color:#525a62;white-space:nowrap}
    .label-row strong{min-width:0;font-size:calc(10.5pt * var(--label-data-scale,1) * var(--label-row-scale,1));line-height:1.05;text-align:right;white-space:nowrap;overflow-wrap:normal}
    .label-extra-text{justify-content:flex-start;white-space:nowrap;overflow-wrap:normal}
    .label-quantity{position:absolute;left:0;right:0;bottom:0;margin:0;padding-top:1.5mm;display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;grid-template-rows:auto auto!important;align-items:baseline;column-gap:2mm;border-top:.5mm solid #222}
    .label-quantity>div:first-child{grid-column:1;grid-row:1;display:grid;gap:.5mm;white-space:nowrap}
    .label-quantity span{font-size:7pt;font-weight:700}
    .label-quantity-values{grid-column:2;grid-row:1/span 2;display:flex;flex-direction:column;align-items:flex-end;gap:.3mm;min-width:0;white-space:nowrap}
    .label-quantity-values strong{font-size:calc(18pt * var(--label-quantity-scale,1));line-height:1.1;text-align:right;white-space:nowrap}
    .label-secondary-quantity{text-align:right;font-size:7pt;font-weight:600;white-space:nowrap}
  </style></head><body><div class="manual-label-page">${manualLabels.outerHTML}</div></body></html>`);
  printWindow.document.close();
  setTimeout(async()=>{
    await Promise.all([...printWindow.document.images].map(image=>image.decode().catch(()=>{})));
    printWindow.focus();
    printWindow.print();
  },100);
});

const labelSettingsForm = labelSettingsDialog?.querySelector('form');
const labelPreview = labelSettingsDialog?.querySelector('.finishing-label-preview');
const escapeLabelHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const fitLabelRows = label => {
  const content = label.querySelector('.label-content');
  if (content) {
    const quantity = content.querySelector('.label-quantity'), lastDataRow = quantity?.previousElementSibling;
    label.style.setProperty('--label-data-scale', '1');
    let scale = 1;
    while ((content.scrollHeight > content.clientHeight + 1 || lastDataRow && lastDataRow.getBoundingClientRect().bottom > quantity.getBoundingClientRect().top - 1) && scale > .24) {
      scale = Math.max(.22, scale - .04);
      label.style.setProperty('--label-data-scale', scale.toFixed(2));
      content.style.gap = `${Math.max(.25, 1.1 * scale)}mm`;
      content.querySelectorAll('.label-row').forEach(row => { row.style.paddingBottom = `${Math.max(.1, .6 * scale)}mm`; });
    }
  }
  label.querySelectorAll('.label-row').forEach(row => {
    const value = row.querySelector('strong'), title = row.querySelector('span');
    if (!value || !row.getClientRects().length) return;
    row.style.setProperty('--label-row-scale', '1');
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const available = () => Math.max(0, row.clientWidth - (title ? title.getBoundingClientRect().width + gap : 0));
    let scale = 1;
    while (value.scrollWidth > available() + 1 && scale > .25) { scale = Math.max(.22, scale - .05); row.style.setProperty('--label-row-scale', scale.toFixed(2)); }
  });
  const quantity = label.querySelector('.label-quantity'), value = quantity?.querySelector('strong'), summary = quantity?.querySelector(':scope > div');
  if (quantity && value) {
    quantity.style.setProperty('--label-quantity-scale', '1');
    const available = () => Math.max(0, quantity.clientWidth - (summary?.getBoundingClientRect().width || 0) - 8);
    let scale = 1;
    while (value.scrollWidth > available() + 1 && scale > .65) { scale = Math.max(.6, scale - .05); quantity.style.setProperty('--label-quantity-scale', scale.toFixed(2)); }
  }
};
const fitAllLabelRows = () => document.querySelectorAll('.labels .label, .label-settings .finishing-label-preview').forEach(fitLabelRows);
window.fitFinishingLabelRows = fitAllLabelRows;
const refreshLabelPreview = () => {
  if (!labelSettingsForm || !labelPreview) return;
  const checked = new Set([...labelSettingsForm.querySelectorAll('input[type="checkbox"][name^="label_field_"]:checked')].map(input => input.name.replace('label_field_', '').replaceAll('_', '-')));
  labelPreview.querySelectorAll('[data-label-key]').forEach(row => { if (row.dataset.labelKey === 'quantity') return; row.hidden = !checked.has(row.dataset.labelKey); row.style.display = row.hidden ? 'none' : ''; });
  const extra = labelSettingsForm.elements.namedItem('extra_text')?.value.trim();
  const extraRow = labelPreview.querySelector('[data-label-key="extra-text"]');
  if (extraRow) { extraRow.hidden = !checked.has('extra-text') || !extra; extraRow.style.display = extraRow.hidden ? 'none' : ''; extraRow.querySelector('strong').textContent = extra; }
  const color = labelSettingsForm.elements.namedItem('color_text')?.value.trim();
  const colorRow = labelPreview.querySelector('[data-label-key="color"]');
  if (colorRow) colorRow.querySelector('strong').textContent = color || colorRow.dataset.labelValue;
  const distance = labelSettingsForm.elements.namedItem('distance')?.value.trim();
  const distanceRow = labelPreview.querySelector('[data-label-key="distance"]');
  if (distanceRow) distanceRow.querySelector('strong').textContent = distance ? `${distance} mm` : distanceRow.dataset.labelValue;
  const clientRow = labelPreview.querySelector('[data-label-key="client"]');
  if (clientRow) clientRow.querySelector('strong').textContent = labelSettingsForm.elements.namedItem('client_name')?.value.trim() || '—';
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
    else { brand.src = brandMode === 'logo' ? '/static/marand-label-logo.png' : labelSettingsDialog.dataset.clientLogo || ''; brand.alt = brandMode === 'logo' ? 'MARAND Technical textiles' : 'Logo klienta'; }
    brand.hidden = brandMode === 'text' && !brand.textContent.trim() || brandMode === 'client-logo' && !brand.getAttribute('src');
    brand.style.display = brand.hidden ? 'none' : '';
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
  const language = labelSettingsForm.elements.namedItem('lang')?.value === 'en' ? 'en' : 'pl';
  const translated = language === 'en' ? {symbol:'INDEX',raw:'GREIGE INDEX',color:'COLOR',lot:'BATCH NO.',width:'WIDTH',grammage:'WEIGHT',client:'CLIENT',weight:'WEIGHT [kg]',distance:'DISTANCE'} : {symbol:'SYMBOL',raw:'SYMBOL SUROWY',color:'KOLOR',lot:'NR PARTII',width:'SZEROKOŚĆ',grammage:'GRAMATURA',client:'KLIENT',weight:'WAGA [kg]',distance:'DYSTANS'};
  labelPreview.querySelectorAll('[data-label-key]').forEach(row => { const title = row.querySelector('span'); if (title && translated[row.dataset.labelKey]) title.textContent = translated[row.dataset.labelKey]; });
  fitLabelRows(labelPreview);
};
labelSettingsForm?.addEventListener('input', refreshLabelPreview);
labelSettingsForm?.addEventListener('change', refreshLabelPreview);
refreshLabelPreview();
fitAllLabelRows();
