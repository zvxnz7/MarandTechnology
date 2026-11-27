'use strict';

const generatorForm = document.querySelector('.manual-label-controls');
const labelList = document.querySelector('[data-manual-labels]');
const inputValue = key => generatorForm?.querySelector(`[data-label-input="${key}"]`)?.value.trim() || '';
const splitValues = value => value.split(/[;\n]+/).map(item => item.trim()).filter(Boolean);
const parseMeters = value => value ? value.split(/[;,\n]+/).map(item => item.trim()).filter(Boolean) : [];
const parseWeights = (value, expectedCount=0) => {
  if (!value) return [];
  if (/[;\n]/.test(value)) return splitValues(value).map(item => item.replace(',', '.'));
  const parts = value.split(',').map(item => item.trim());
  if (parts.length === 1) return parts;
  const pairDecimals = parts.length % 2 === 0 && parts.every((part,index) => /^\d+(?:\.\d+)?$/.test(part) && (index % 2 === 1 ? /^\d{1,2}$/.test(part) : /^\d+$/.test(part)));
  if (pairDecimals && (parts.length === expectedCount * 2 || !expectedCount)) {
    return Array.from({length:parts.length/2},(_,index) => `${parts[index*2]}.${parts[index*2+1]}`);
  }
  if (expectedCount === 1) return [parts.join('.')];
  return parts;
};
const setValidation = message => {
  const validation = generatorForm?.querySelector('[data-label-validation]');
  const print = document.querySelector('[data-label-print]');
  if (validation) { validation.textContent = message; validation.hidden = !message; }
  if (print) print.disabled = Boolean(message);
};
const renderManualLabel = () => {
  if (!generatorForm || !labelList) return;
  const language = document.querySelector('[name="manual_language"]:checked')?.value === 'en' ? 'en' : 'pl';
  const enabled = new Set([...generatorForm.querySelectorAll('[data-manual-field]:checked')].map(input => input.dataset.manualField));
  const meters = parseMeters(inputValue('meters'));
  const weights = parseWeights(inputValue('weight'), meters.length);
  const hasMeters = meters.length > 0, hasWeights = weights.length > 0;
  const count = Math.max(meters.length, weights.length, 1);
  const invalidMeters = inputValue('meters') && meters.some(value => !/^\d+(?:\.\d+)?$/.test(value));
  const invalidWeights = inputValue('weight') && weights.some(value => !/^\d+(?:\.\d+)?$/.test(value));
  const validation = invalidMeters ? 'Sprawdź format metrów. Wartości oddziel przecinkami.'
    : invalidWeights ? 'Sprawdź format wag. Przecinek dziesiętny zapisuj w parach (np. 22,1,22,2) lub oddzielaj wagi średnikiem.'
      : hasMeters && hasWeights && meters.length !== weights.length ? `Wpisano ${meters.length} wartości metrów i ${weights.length} wag. Podaj tyle samo wartości, w tej samej kolejności, albo usuń wagi.`
        : !hasMeters && !hasWeights ? 'Wpisz metry lub kilogramy, aby wydrukować etykietę.' : '';
  setValidation(validation);
  const unit = generatorForm.querySelector('[name="manual_quantity_unit"]:checked')?.value || 'meters';
  const secondaryEnabled = generatorForm.querySelector('[data-label-secondary]')?.checked;
  const brandMode = generatorForm.querySelector('[name="manual_brand_mode"]:checked')?.value || 'logo';
  const brandText = inputValue('brand');
  const extraText = inputValue('extra');
  const exampleMode = !hasMeters && !hasWeights;
  const definitions = language === 'en'
    ? [['symbol','INDEX','symbol',''],['raw','GREIGE INDEX','raw',''],['color','COLOR','color',''],['lot','BATCH NO.','lot',''],['width','WIDTH','width',' cm'],['grammage','WEIGHT','grammage',' g/m²'],['distance','DISTANCE','distance',' mm'],['client','CLIENT','client',''],['extra','', 'extra','']]
    : [['symbol','SYMBOL','symbol',''],['raw','SYMBOL SUROWY','raw',''],['color','KOLOR','color',''],['lot','NR PARTII','lot',''],['width','SZEROKOŚĆ','width',' cm'],['grammage','GRAMATURA','grammage',' g/m²'],['distance','DYSTANS','distance',' mm'],['client','KLIENT','client',''],['extra','', 'extra','']];
  const labels = [];
  for (let index=0;index<count;index++) {
    const metersValue = meters[index] || '';
    const weightValue = weights[index] || '';
    const mainValue = unit === 'weight' ? (weightValue || (exampleMode?'22,1':'')) : (metersValue || (exampleMode?'100':''));
    const otherValue = unit === 'weight' ? (metersValue || (exampleMode?'100':'')) : (weightValue || (exampleMode?'22,1':''));
    const fields = definitions.filter(([key]) => enabled.has(key)).map(([key,title,input,unitLabel]) => ({key:key==='extra'?'extra-text':key,label:title,value:inputValue(input),unit:key==='distance'&&inputValue(input)?unitLabel:'',show:key==='extra'?Boolean(inputValue(input)):true}));
    const rendered = window.MarandLabelRenderer.render({language,brandMode,brandText,fields,quantity:{
      label:unit==='weight'?(language==='en'?'QUANTITY [kg]':'ILOŚĆ [kg]'):(language==='en'?'QUANTITY [m]':'ILOŚĆ [mb]'),
      value:mainValue||'—',secondaryLabel:unit==='weight'?(language==='en'?'LENGTH [m]':'DŁUGOŚĆ [m]'):(language==='en'?'WEIGHT [kg]':'WAGA [kg]'),secondaryValue:secondaryEnabled?otherValue:'',
    },rootClass:'manual-label-preview',rootAttributes:'data-manual-label'});
    const template=document.createElement('template');template.innerHTML=rendered;
    const label=template.content.firstElementChild;
    if(exampleMode)label?.querySelectorAll('.label-quantity-values strong,.label-secondary-quantity').forEach(value=>value.classList.add('label-example-value'));
    if(label)labels.push(label);
  }
  labelList.replaceChildren(...labels);
  const countLabel = document.querySelector('[data-label-count]');
  if (countLabel) countLabel.textContent = `${count} ${count===1?'etykieta':'etykiet'} · 50 × 74 mm`;
  window.MarandLabelRenderer.fitAll(labelList);
};

generatorForm?.addEventListener('input',renderManualLabel);
document.querySelectorAll('[name="manual_language"]').forEach(input=>input.addEventListener('change',renderManualLabel));
generatorForm?.addEventListener('change',event => {
  const fieldToggle = event.target.closest('[data-manual-field]');
  if (fieldToggle) {
    const input = generatorForm.querySelector(`[data-input-for="${fieldToggle.dataset.manualField}"]`);
    if (input) input.hidden = !fieldToggle.checked;
  }
  const brandMode = event.target.closest('[name="manual_brand_mode"]');
  if (brandMode) {
    const brandInput = generatorForm.querySelector('[data-brand-text-field]');
    if (brandInput) brandInput.hidden = brandMode.value !== 'text';
  }
  renderManualLabel();
});
renderManualLabel();
