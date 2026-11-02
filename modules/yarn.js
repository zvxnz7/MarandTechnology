'use strict';

const decimal = value => {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(raw) || Number(raw) <= 0) return '';
  return raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};

function parseLegacy(value = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.+?)\s*(\d+(?:[.,]\d+)?)\s*(?:dtex\s*)?(?:\/|f)\s*(\d+)\s*(?:dtex)?\s*(FDY|DTY|DTI)?$/i);
  if (!match) return null;
  const dtex = decimal(match[2]);
  const filaments = String(Number(match[3]));
  if (!dtex || Number(filaments) < 1) return null;
  return { material: match[1].trim().replace(/[\s/-]+$/, ''), dtex, filaments, process: (match[4] || '').toUpperCase() };
}

function fields(row = {}) {
  const parsed = parseLegacy(row.yarn);
  const structured = row.yarn_material || row.yarn_dtex || row.yarn_filaments || row.yarn_process || row.yarn2_material || row.yarn2_dtex || row.yarn2_filaments || row.yarn2_process;
  if (structured) return {
    material: row.yarn_material || '', dtex: row.yarn_dtex || '',
    filaments: row.yarn_filaments || '', process: row.yarn_process || '',
    secondMaterial: row.yarn2_material || '', secondDtex: row.yarn2_dtex || '',
    secondFilaments: row.yarn2_filaments || '', secondProcess: row.yarn2_process || '',
    legacy: row.yarn_legacy || (!row.yarn_material && !row.yarn_dtex ? row.yarn || '' : ''),
  };
  return parsed ? { ...parsed, secondMaterial: '', secondDtex: '', secondFilaments: '', secondProcess: '', legacy: '' } : { material: '', dtex: '', filaments: '', process: '', secondMaterial: '', secondDtex: '', secondFilaments: '', secondProcess: '', legacy: row.yarn || '' };
}

function compose({ material = '', dtex = '', filaments = '', process = '' } = {}) {
  const part = (fiberValue, dtexValue, filamentValue, processValue) => {
    const fiber = String(fiberValue || '').trim(), weight = decimal(dtexValue);
    if (!fiber || !weight) return '';
    const filamentCount = String(filamentValue || '').trim();
    const filamentLabel = /^\d+$/.test(filamentCount) && Number(filamentCount) > 0
      ? (Number(filamentCount) === 1 ? 'mono' : `${Number(filamentCount)}f`)
      : '';
    return [fiber, `${weight} dtex`, filamentLabel, String(processValue || '').trim().toUpperCase()].filter(Boolean).join(' · ');
  };
  const first = part(material, dtex, filaments, process);
  const second = part(arguments[0]?.secondMaterial, arguments[0]?.secondDtex, arguments[0]?.secondFilaments, arguments[0]?.secondProcess);
  return [first, second].filter(Boolean).join(' + ');
}

module.exports = { decimal, parseLegacy, fields, compose };
