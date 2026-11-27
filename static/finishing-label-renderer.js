'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof window !== 'undefined') root.MarandLabelRenderer = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const render = ({language='pl', brandMode='none', brandText='', clientLogo='', fields=[], quantity={}, preview=false, rootClass='', rootAttributes=''}={}) => {
    const brand = brandMode === 'logo'
      ? '<img class="label-logo" data-label-brand src="/static/marand-label-logo.png" alt="MARAND Technical textiles">'
      : brandMode === 'client-logo' && clientLogo
        ? `<img class="label-logo" data-label-brand src="${escapeHtml(clientLogo)}" alt="Logo klienta">`
        : brandMode === 'text' && brandText
          ? `<div class="label-custom-brand" data-label-brand>${escapeHtml(brandText)}</div>` : '';
    const rows = fields.filter(field => field.show || preview).map(field => {
      const hidden = field.show ? '' : ' hidden';
      const extra = field.key === 'extra-text';
      return `<div class="label-row${extra ? ' label-extra-text' : ''}" data-label-key="${escapeHtml(field.key)}" data-label-value="${escapeHtml(field.value || '—')}${escapeHtml(field.unit || '')}"${hidden}>${extra ? '' : `<span>${escapeHtml(field.label || '')}</span>`}<strong>${escapeHtml(field.value || '—')}${escapeHtml(field.unit || '')}</strong></div>`;
    });
    if (rows.length && !fields.some(field => field.key === 'extra-text' && field.show && field.value)) {
      const last = fields.filter(field => field.show || preview).at(-1);
      if (last && last.key !== 'extra-text') {
        const index = rows.length - 1;
        rows[index] = rows[index].replace('class="label-row"', 'class="label-row label-row-before-quantity"');
      }
    }
    const q = quantity || {};
    const secondary = q.secondaryValue === null || q.secondaryValue === undefined || q.secondaryValue === '' ? '' : `<small class="label-secondary-quantity">${escapeHtml(q.secondaryLabel || '')}${q.secondaryLabel ? ': ' : ''}${escapeHtml(q.secondaryValue)}</small>`;
    const classes = ['label', rootClass].filter(Boolean).join(' ');
    return `<article class="${classes}" lang="${escapeHtml(language)}" ${rootAttributes}>${brand}<div class="label-content">${rows.join('')}<div class="label-quantity" data-label-key="quantity" data-quantity-meters="${escapeHtml(q.meters ?? '—')}" data-quantity-kg="${escapeHtml(q.kg ?? '—')}"><div><span>${escapeHtml(q.label || '')}</span></div><div class="label-quantity-values"><strong>${escapeHtml(q.value ?? '—')}</strong>${secondary}</div></div></div></article>`;
  };
  const renderInto = (element, data) => {
    if (!element) return;
    const markup = render({...data, rootClass: element.className.replace(/\blabel\b/g, '').trim(), rootAttributes: element.hasAttribute('data-manual-label') ? 'data-manual-label' : ''});
    const template = element.ownerDocument.createElement('template');
    template.innerHTML = markup;
    const replacement = template.content.firstElementChild;
    if (replacement) element.replaceWith(replacement);
    return replacement;
  };
  const fit = label => {
    const content = label?.querySelector('.label-content');
    if (!content) return;
    const quantity = content.querySelector('.label-quantity');
    if (!quantity) return;
    let scale = 1;
    label.style.setProperty('--label-data-scale', '1');
    const overflow = () => {
      const last = quantity.previousElementSibling;
      return content.scrollHeight > content.clientHeight + 1 || last && last.getBoundingClientRect().bottom > quantity.getBoundingClientRect().top - 1;
    };
    while (overflow() && scale > .24) {
      scale = Math.max(.22, scale - .04);
      label.style.setProperty('--label-data-scale', scale.toFixed(2));
      content.style.gap = `${Math.max(.25, 1.1 * scale)}mm`;
      content.querySelectorAll('.label-row').forEach(row => { row.style.paddingBottom = `${Math.max(.1, .6 * scale)}mm`; });
    }
    content.querySelectorAll('.label-row').forEach(row => {
      const value = row.querySelector('strong'), title = row.querySelector('span');
      if (!value || !row.getClientRects().length) return;
      let rowScale = 1;
      row.style.setProperty('--label-row-scale', '1');
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const available = () => Math.max(0, row.clientWidth - (title ? title.getBoundingClientRect().width + gap : 0));
      while (value.scrollWidth > available() + 1 && rowScale > .24) {
        rowScale = Math.max(.22, rowScale - .05);
        row.style.setProperty('--label-row-scale', rowScale.toFixed(2));
      }
    });
    const value = quantity.querySelector('.label-quantity-values strong'), summary = quantity.querySelector(':scope > div:first-child');
    if (value) {
      let quantityScale = 1;
      quantity.style.setProperty('--label-quantity-scale', '1');
      const available = () => Math.max(0, quantity.clientWidth - (summary?.getBoundingClientRect().width || 0) - 8);
      while (value.scrollWidth > available() + 1 && quantityScale > .59) {
        quantityScale = Math.max(.55, quantityScale - .05);
        quantity.style.setProperty('--label-quantity-scale', quantityScale.toFixed(2));
      }
    }
  };
  const fitAll = scope => (scope || document).querySelectorAll('.label').forEach(fit);
  return {escapeHtml, render, renderInto, fit, fitAll};
});
