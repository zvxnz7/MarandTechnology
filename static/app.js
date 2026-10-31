'use strict';
let dirty=false,submitting=false;
document.querySelectorAll('[data-print-page]').forEach(button=>button.addEventListener('click',()=>{
 const timestamp=document.querySelector('[data-print-timestamp]');
 if(timestamp)timestamp.textContent=new Intl.DateTimeFormat('pl-PL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date());
 window.print();
}));
document.querySelectorAll('[data-finishing-order-form]').forEach(form=>{
 const sale=form.querySelector('[data-finishing-raw-sale]'),plant=form.querySelector('[data-finishing-plant]'),recipe=form.querySelector('[data-finishing-recipe]');
 const applyRecipe=()=>{const option=recipe.selectedOptions[0];for(const [field,key] of [['target_color','color'],['target_stiffening','stiffening'],['target_width_cm','width'],['target_grammage','grammage']]){const input=form.elements[field];if(input&&option?.dataset[key])input.value=option.dataset[key];}if(option?.dataset.plant)plant.value=option.dataset.plant;};
 const sync=()=>{const raw=sale.checked;plant.required=!raw;recipe.required=!raw;};
 recipe.addEventListener('change',applyRecipe);sale.addEventListener('change',sync);sync();
});
document.querySelectorAll('[data-finishing-batch-form]').forEach(form=>{
 const meters=form.elements.meters_list,weights=form.elements.weights_list,preview=form.querySelector('[data-finishing-bale-preview]');
 const parse=input=>input.value.split(/[+\n\r;]+/).map(part=>part.trim()).filter(Boolean);
 const update=()=>{const m=parse(meters),w=parse(weights);if(!m.length&&!w.length){preview.textContent='Wprowadź metry i kg. Liczba wartości musi być taka sama.';preview.classList.remove('is-valid','is-invalid');return;}if(m.length!==w.length){preview.textContent=`Różna liczba wpisów: ${m.length} wartości metrów i ${w.length} wartości kg.`;preview.classList.add('is-invalid');preview.classList.remove('is-valid');return;}preview.textContent=`${m.length} belek · wpisano ręcznie ${m.length} wartości metrów i ${w.length} wartości kg.`;preview.classList.add('is-valid');preview.classList.remove('is-invalid');};
 meters.addEventListener('input',update);weights.addEventListener('input',update);form.addEventListener('submit',event=>{update();if(preview.classList.contains('is-invalid')){event.preventDefault();alert(preview.textContent);}});update();
});
document.querySelectorAll('[data-update-refresh]').forEach(marker=>{
 const target=marker.dataset.updateVersion;
 const poll=async()=>{
  try{
   const response=await fetch('/admin/update/status',{cache:'no-store',headers:{'X-Requested-With':'fetch'}});
   if(response.ok){const result=await response.json();if(result.status?.pending!==true||result.version===target){location.reload();return;}}
  }catch{}
  setTimeout(poll,1000);
 };
 setTimeout(poll,1000);
});
document.querySelectorAll('form[data-dirty]').forEach(f=>{f.addEventListener('input',()=>dirty=true);f.addEventListener('submit',()=>{submitting=true;});});
document.querySelectorAll('select[data-auto-submit]').forEach(select=>select.addEventListener('change',()=>select.form?.requestSubmit()));
document.querySelectorAll('.nav-group').forEach(group=>{const active=[...group.querySelectorAll('.nav-link')].find(link=>location.pathname===link.pathname||link.pathname!=='/'&&location.pathname.startsWith(`${link.pathname}/`));if(active){active.classList.add('nav-current');group.open=true;}});
document.querySelectorAll('[data-range-selection]').forEach(form=>{
 const boxes=[...form.querySelectorAll('[data-range-select]')],hidden=form.querySelector('[data-range-values]'),all=form.querySelector('[data-range-all]'),pickedRows=form.querySelector('[data-range-picked-rows]'),selectedCount=form.querySelector('[data-range-selected-count]');let last=null;
 const save=()=>{
  const selected=boxes.filter(box=>box.checked);
  hidden.value=selected.map(box=>box.value).join(',');
  if(all)all.checked=boxes.length>0&&selected.length===boxes.length;
  if(selectedCount)selectedCount.textContent=String(selected.length);
  if(pickedRows){
   pickedRows.replaceChildren();
   if(!selected.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=9;cell.textContent='Zaznacz belki z tabeli po lewej.';row.append(cell);pickedRows.append(row);}
   selected.forEach((box,index)=>{
    const row=document.createElement('tr');
    [String(index+1),box.dataset.baleNumber||'',box.dataset.weight||'',box.dataset.meters||'',box.dataset.errors||'0',box.dataset.stops||'0',box.dataset.lot||'',box.dataset.date||''].forEach((value,column)=>{
     const cell=document.createElement('td');
     if(column===1){const link=document.createElement('a');link.href=box.dataset.detailUrl||'#';link.target='_blank';link.rel='noopener';link.textContent=value;cell.append(link);}
     else cell.textContent=value;
     row.append(cell);
    });
    const removeCell=document.createElement('td'),removeButton=document.createElement('button');removeButton.type='button';removeButton.className='shipment-picked-remove';removeButton.dataset.rangeRemove=box.value;removeButton.textContent='Usuń';removeCell.append(removeButton);row.append(removeCell);
    pickedRows.append(row);
   });
  }
 };
 boxes.forEach(box=>box.addEventListener('click',event=>{if(event.shiftKey&&last){const from=boxes.indexOf(last),to=boxes.indexOf(box),checked=box.checked;for(let i=Math.min(from,to);i<=Math.max(from,to);i++)boxes[i].checked=checked;}last=box;save();}));
 if(all)all.addEventListener('change',()=>{boxes.forEach(box=>box.checked=all.checked);save();});
 form.addEventListener('click',event=>{const remove=event.target.closest('[data-range-remove]');if(!remove)return;const box=boxes.find(item=>item.value===remove.dataset.rangeRemove);if(box){box.checked=false;save();}});
 form.addEventListener('submit',event=>{save();if(!hidden.value&&!form.hasAttribute('data-allow-empty-selection')){event.preventDefault();alert('Zaznacz przynajmniej jedną belkę.');}});
});
document.querySelectorAll('[data-shipment-correction-form]').forEach(form=>{
 const preview=form.querySelector('[data-correction-specification-preview]'),count=form.querySelector('[data-correction-spec-count]');
 const updatePreview=()=>{
  const removed=[...form.querySelectorAll('[data-correction-remove]')].filter(box=>box.checked);
  form.querySelectorAll('[data-correction-current-row]').forEach(row=>{const selected=Boolean(row.querySelector('[data-correction-remove]')?.checked),status=row.querySelector('[data-correction-disposition]');row.classList.toggle('shipment-correction-removed',selected);if(status){status.hidden=!selected;status.disabled=!selected;}});
  form.querySelectorAll('.shipment-correction-preview-added').forEach(row=>row.remove());
  const added=[...form.querySelectorAll('[data-correction-add]:checked')];
  if(preview){
   added.forEach((box,index)=>{
    const row=document.createElement('tr');row.className='shipment-correction-preview-added';
    const values=['Dodana',String(Math.max(0,preview.querySelectorAll('[data-correction-current-row]').length-removed.length)+index+1),box.dataset.baleNumber||'',box.dataset.weight||'',box.dataset.meters||'',box.dataset.lot||'—','Wybrana do dodania do specyfikacji wysyłkowej'];
    values.forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell);});preview.append(row);
   });
  }
  if(count)count.textContent=String(Math.max(0,(preview?.querySelectorAll('[data-correction-current-row]').length||0)-removed.length+added.length));
 };
 form.addEventListener('change',event=>{if(event.target.matches('[data-correction-remove],[data-correction-add]'))updatePreview();});
 form.addEventListener('submit',event=>{
  const removed=[...form.querySelectorAll('[data-correction-remove]:checked')].map(box=>({id:box.value,disposition:box.closest('tr')?.querySelector('[data-correction-disposition]')?.value||'returned'}));
  const added=[...form.querySelectorAll('[data-correction-add]:checked')].map(box=>box.value);
  if(!removed.length&&!added.length){event.preventDefault();alert('Zaznacz przynajmniej jedną belkę do usunięcia lub dodania.');return;}
  form.querySelector('[name="removed_items"]').value=JSON.stringify(removed);
  form.querySelector('[data-correction-added-values]').value=added.join(',');
 });
 updatePreview();
});
const warehouseBulkStatus=document.querySelector('#warehouse-bulk-status');
if(warehouseBulkStatus){const selected=warehouseBulkStatus.querySelector('[data-warehouse-selected]');warehouseBulkStatus.addEventListener('submit',event=>{selected.value=[...document.querySelectorAll('[data-warehouse-check]:checked')].map(box=>box.value).join(',');if(!selected.value){event.preventDefault();alert('Zaznacz przynajmniej jedną belkę.');}});}
document.querySelectorAll('[data-warehouse-live-search]').forEach(form=>{
 const input=form.querySelector('input[name="q"]'),results=form.querySelector('[data-warehouse-search-results]');let timer=null,controller=null,activeIndex=-1;
 const options=()=>[...results.querySelectorAll('[role="option"]')];
 const setActive=index=>{
  const items=options();if(!items.length){activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');return;}
  activeIndex=(index+items.length)%items.length;
  items.forEach((item,i)=>{const active=i===activeIndex;item.setAttribute('aria-selected',String(active));item.classList.toggle('selected',active);});
  input.setAttribute('aria-activedescendant',items[activeIndex].id);input.setAttribute('aria-expanded','true');items[activeIndex].scrollIntoView({block:'nearest'});
 };
 const search=async()=>{
  const q=input.value.trim();controller?.abort();controller=null;
   if(!q){results.replaceChildren();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');return;}
  controller=new AbortController();
  try{
   const response=await fetch(`/warehouse?partial=search&q=${encodeURIComponent(q)}`,{headers:{'X-Requested-With':'fetch'},signal:controller.signal});
   if(!response.ok)throw new Error('Nie udało się wyszukać artykułów.');
   results.innerHTML=await response.text();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded',String(Boolean(options().length)));
  }catch(error){if(error.name!=='AbortError'){results.textContent='Nie udało się wyszukać artykułów.';input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');}}
 };
 input.addEventListener('input',()=>{activeIndex=-1;controller?.abort();results.replaceChildren();input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');clearTimeout(timer);timer=setTimeout(search,180);});
 input.addEventListener('keydown',event=>{
  const items=options();
  if(event.key==='ArrowDown'&&items.length){event.preventDefault();setActive(activeIndex<0?0:activeIndex+1);}
  else if(event.key==='ArrowUp'&&items.length){event.preventDefault();setActive(activeIndex<0?items.length-1:activeIndex-1);}
  else if(event.key==='Enter'&&activeIndex>=0&&items[activeIndex]){event.preventDefault();items[activeIndex].click();}
  else if(event.key==='Escape'){event.preventDefault();results.replaceChildren();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');}
 });
 form.addEventListener('submit',event=>{event.preventDefault();clearTimeout(timer);search();});
 document.addEventListener('click',event=>{if(!form.contains(event.target)){clearTimeout(timer);controller?.abort();results.replaceChildren();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');}});
});
document.querySelectorAll('[data-shipment-live-search]').forEach(form=>{
 const input=form.querySelector('input[name="q"]'),results=form.querySelector('[data-shipment-search-results]');let timer=null,controller=null,activeIndex=-1;
 const options=()=>[...results.querySelectorAll('[role="option"]')];
 const setActive=index=>{
  const items=options();if(!items.length){activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');return;}
  activeIndex=(index+items.length)%items.length;
  items.forEach((item,i)=>{const active=i===activeIndex;item.setAttribute('aria-selected',String(active));item.classList.toggle('selected',active);});
  input.setAttribute('aria-activedescendant',items[activeIndex].id);input.setAttribute('aria-expanded','true');items[activeIndex].scrollIntoView({block:'nearest'});
 };
 const search=async()=>{
  const q=input.value.trim();controller?.abort();controller=null;
  if(!q){results.replaceChildren();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');return;}
  controller=new AbortController();
  try{const spec=form.querySelector('input[name="specification_id"]')?.value||'',article=form.querySelector('input[name="article_id"]')?.value||'';const response=await fetch(`${form.action}?partial=search&q=${encodeURIComponent(q)}${spec?`&specification_id=${encodeURIComponent(spec)}`:''}${article?`&article_id=${encodeURIComponent(article)}`:''}`,{headers:{'X-Requested-With':'fetch'},signal:controller.signal});if(!response.ok)throw new Error();results.innerHTML=await response.text();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded',String(Boolean(options().length)));}
  catch(error){if(error.name!=='AbortError'){results.textContent='Nie udało się wyszukać artykułów.';input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');}}
 };
 input.addEventListener('input',()=>{activeIndex=-1;controller?.abort();results.replaceChildren();input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');clearTimeout(timer);timer=setTimeout(search,180);});
 input.addEventListener('keydown',event=>{
  const items=options();
  if(event.key==='ArrowDown'&&items.length){event.preventDefault();setActive(activeIndex<0?0:activeIndex+1);}
  else if(event.key==='ArrowUp'&&items.length){event.preventDefault();setActive(activeIndex<0?items.length-1:activeIndex-1);}
  else if(event.key==='Enter'&&activeIndex>=0&&items[activeIndex]){event.preventDefault();items[activeIndex].click();}
  else if(event.key==='Escape'){event.preventDefault();results.replaceChildren();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');}
 });
 form.addEventListener('submit',event=>{event.preventDefault();clearTimeout(timer);search();});
 document.addEventListener('click',event=>{if(!form.contains(event.target)){clearTimeout(timer);controller?.abort();results.replaceChildren();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');}});
});
document.querySelectorAll('[data-warehouse-note-form]').forEach(form=>{
 const input=form.querySelector('[data-warehouse-note]'),status=form.querySelector('.warehouse-note-status');let saved=input.value,timer=null,busy=false,pending=false;
 const persist=async()=>{
  clearTimeout(timer);if(busy){pending=true;return;}if(input.value===saved){status.textContent='';return;}
  busy=true;
  do{
   pending=false;const value=input.value;status.textContent='Zapisywanie…';
   try{
    const body=new URLSearchParams(new FormData(form));
    const response=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-Requested-With':'fetch'},body});
    const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Błąd zapisu.');
    saved=value;if(input.value!==saved)pending=true;else status.textContent='Zapisano';
   }catch{status.textContent='Błąd zapisu';break;}
  }while(pending);
  busy=false;
 };
 input.addEventListener('input',()=>{status.textContent='Niezapisane zmiany';clearTimeout(timer);timer=setTimeout(persist,500);});
 input.addEventListener('change',persist);input.addEventListener('blur',persist);
 form.addEventListener('submit',event=>{event.preventDefault();persist();});
});
const sourceImportUpload=document.querySelector('form[data-source-import-upload]');
if(sourceImportUpload){
 const fileInput=sourceImportUpload.querySelector('[data-source-import-file]'),status=sourceImportUpload.querySelector('[data-source-import-status]'),uploadButton=sourceImportUpload.querySelector('[data-import-upload-button]');
 const preview=document.querySelector('[data-source-import-preview]'),applyForm=document.querySelector('[data-source-import-apply]');
 const list=(selector,values)=>{const target=document.querySelector(selector);if(!target)return;target.replaceChildren();for(const value of values){const item=document.createElement('li');item.textContent=value;target.appendChild(item);}};
 sourceImportUpload.addEventListener('submit',async event=>{
  event.preventDefault();const file=fileInput.files[0];if(!file)return;
  if(file.size>25*1024*1024){status.textContent='Plik przekracza limit 25 MB.';return;}
  uploadButton.disabled=true;status.textContent='Sprawdzanie pliku i porównywanie z bazą…';preview.hidden=true;
  try{
   const response=await fetch('/admin/import/preview',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':sourceImportUpload.dataset.csrf},body:await file.text()});
   const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Nie udało się sprawdzić paczki.');
   const report=result.preview,existing=report.existing,incoming=report.incoming,archive=report.will_archive;
   document.querySelector('[data-import-summary]').textContent=report.package_type==='finishing'
    ? `Paczka wykańczania · okresy ${report.periods.join(', ')} · SHA-256 ${report.package_sha256.slice(0,16)}…`
    : `Plik ${file.name} · ${report.package_sha256.slice(0,16)}…`;
   const archiveSection=document.querySelector('[data-import-archive-section]'),confirmation=document.querySelector('[data-import-confirmation]');
   if(report.package_type==='finishing'){
    list('[data-import-existing]',[`Receptury wykończeń: ${existing.finishing_recipes}`,`Zlecenia wykończenia: ${existing.finishing_orders}`,`Partie: ${existing.finishing_batches}`,`Przyjęcia: ${existing.finishing_receipts}`]);
    list('[data-import-incoming]',[`Receptury: ${incoming.finishing_recipes}`,`Zlecenia wykończenia: ${incoming.finishing_orders}`,`Partie wykończalnicze: ${incoming.finishing_batches}`,`Przyjęcia: ${incoming.finishing_receipts}`,`Wiersze belek z indywidualnymi metrami i kg: ${incoming.returned_bales}`]);
    list('[data-import-archive]',[]);list('[data-import-preserved]',report.preserved);archiveSection.hidden=true;
    document.querySelector('[data-import-ai-notice]').textContent=report.ai_notice;
    const conflictBox=document.querySelector('[data-import-conflict-box]'),conflicts=document.querySelector('[data-import-conflicts]');conflicts.replaceChildren();for(const conflict of report.conflicts){const item=document.createElement('li');item.textContent=[conflict.symbol,conflict.message].filter(Boolean).join(': ');conflicts.appendChild(item);}conflictBox.hidden=report.conflicts.length===0;
    document.querySelector('[data-import-info]').textContent='Import nie dopisze kosztów ani powiązań zwróconych belek z konkretnymi belkami surowymi. Sumy metrów i kg pozostają sumami; bez danych kg dla każdej belki nie powstaną etykiety z wymyśloną wagą.';
    confirmation.textContent='Rozumiem, że import doda wskazane receptury i historyczne zlecenia wykończenia. Program zrobi kopię bazy przed zapisem.';
    applyForm.elements.token.value=result.token;applyForm.hidden=report.conflicts.length>0;preview.hidden=false;status.textContent=report.conflicts.length?'Paczka nie może być zaimportowana. Sprawdź konflikty powyżej.':'Podgląd gotowy. Baza pozostaje bez zmian do chwili potwierdzenia.';preview.scrollIntoView({behavior:'smooth',block:'start'});return;
   }
   archiveSection.hidden=false;confirmation.textContent='Rozumiem, że niepasujące artykuły, projekty i robocze wpisy bez wydanej karty zostaną przeniesione do archiwum na 30 dni. Zatwierdzone specyfikacje i wydane karty pozostaną bez zmian.';
   list('[data-import-existing]',[
    `Artykuły: ${existing.active_articles}`,
    `Projekty/próby: ${existing.active_projects}`,
    `Użytkownicy: ${existing.users}`,
    `Zatwierdzone specyfikacje: ${existing.approved_records}`,
    `Wydane karty: ${existing.issued_cards}`
   ]);
   list('[data-import-incoming]',[
    `Artykuły: ${incoming.articles}`,
    `Specyfikacje robocze: ${incoming.specifications}`,
    `Projekty/próby: ${incoming.projects}`,
    `Wpisy prób: ${incoming.trial_records}`,
    `Dopasowane artykuły z obecnej kartoteki: ${report.article_matches_to_existing}`,
    `Opisy dopasowanych artykułów zaktualizowane z paczki: ${report.article_descriptions_updated}`,
    'Automatyczna numeracja prób: ' + incoming.projects + ' · przykłady: ' + report.trial_number_examples.map(item=>item.from + ' → ' + item.to).join(', '),
    'Powtórzone oznaczenia źródłowe prób: ' + report.duplicate_source_trial_numbers + ' · każda próba dostanie unikalny numer programu.',
    `Nazwy prób wymagające dopisku: ${report.project_names_that_need_a_unique_import_label}`
   ]);
   list('[data-import-archive]',[
    `Aktywne projekty/próby: ${archive.active_projects}`,
    `Robocze wpisy bez wydanej karty: ${archive.unapproved_records_without_issued_cards}`,
    'Niepasujące artykuły: '+archive.unmatched_articles
   ]);
   list('[data-import-preserved]',report.preserved);
   document.querySelector('[data-import-ai-notice]').textContent=report.ai_notice;
   const conflictBox=document.querySelector('[data-import-conflict-box]'),conflicts=document.querySelector('[data-import-conflicts]');
   conflicts.replaceChildren();for(const conflict of report.conflicts){const item=document.createElement('li');item.textContent=[conflict.symbol,conflict.message].filter(Boolean).join(': ');conflicts.appendChild(item);}
   conflictBox.hidden=report.conflicts.length===0;
   const info=document.querySelector('[data-import-info]');
   info.textContent=`Wczytane specyfikacje pozostaną robocze i nie zastąpią obowiązującej technologii. ${incoming.review_flags} oznaczeń wymaga sprawdzenia ze starym katalogiem.`;
   applyForm.elements.token.value=result.token;applyForm.hidden=report.conflicts.length>0;
   preview.hidden=false;status.textContent=report.conflicts.length?'Wykryto niezgodności. Import jest zablokowany do czasu ich wyjaśnienia.':'Podgląd gotowy. Baza pozostaje bez zmian do chwili potwierdzenia.';
   preview.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){status.textContent=error.message;}
  finally{uploadButton.disabled=false;}
 });
 applyForm?.addEventListener('submit',()=>{const button=applyForm.querySelector('button[type="submit"],button:not([type])');if(button){button.disabled=true;button.textContent='Tworzenie kopii i import danych…';}});
}
document.querySelectorAll('form[data-inherited-values]').forEach(form=>form.querySelectorAll('input:not([type=hidden]),textarea').forEach(control=>{
  if(control.value.trim())control.classList.add('inherited-value');
  control.addEventListener('input',()=>control.classList.remove('inherited-value'));
}));
window.addEventListener('beforeunload',e=>{if(dirty&&!submitting){e.preventDefault();e.returnValue='';}});
document.querySelectorAll('[data-project-article-mode]').forEach(select=>{
  const update=()=>select.form.querySelectorAll('[data-project-article-panel]').forEach(panel=>{
    const active=panel.dataset.projectArticlePanel===select.value;panel.hidden=!active;
    panel.querySelectorAll('input,select').forEach(control=>{control.required=active;});
  });
  select.addEventListener('change',update);update();
});
document.querySelectorAll('[data-open-dialog]').forEach(button=>button.addEventListener('click',()=>{
 const dialog=document.getElementById(button.dataset.openDialog);
 if(dialog&&typeof dialog.showModal==='function')dialog.showModal();
}));
document.querySelectorAll('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog')?.close()));
document.querySelectorAll('[data-show-modal]').forEach(dialog=>{
 dialog.addEventListener('cancel',event=>{
  const cancelUrl=dialog.dataset.cancelUrl;
  if(cancelUrl){event.preventDefault();location.assign(cancelUrl);}
 });
 if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
});
document.querySelectorAll('[data-stage-select]').forEach(button=>button.addEventListener('click',()=>{
 const selected=document.getElementById(button.getAttribute('aria-controls'));
 if(!selected)return;
 document.querySelectorAll('details.stage-card').forEach(stage=>{stage.open=stage===selected;});
 document.querySelectorAll('[data-stage-select]').forEach(item=>{
  const active=item===button;item.classList.toggle('selected',active);item.setAttribute('aria-pressed',String(active));
 });
 selected.scrollIntoView({behavior:'smooth',block:'start'});
}));
document.querySelectorAll('[data-stage-description-input]').forEach(input=>input.addEventListener('input',()=>{
 const heading=document.querySelector(`[data-stage-description-label="${input.dataset.stageDescriptionInput}"]`);
 if(heading)heading.textContent=input.value.trim()||'Etap bez opisu';
}));
document.querySelectorAll('[data-print]').forEach(b=>b.addEventListener('click',()=>{
  const alert=document.querySelector('[data-update-alert]');
  if(alert && !window.confirm(alert.innerText+'\n\nCzy zapoznano się ze zmianami i kontynuować drukowanie?'))return;
  window.print();
}));
document.querySelectorAll('[data-instruction-editor]').forEach(editor=>{
 const content=editor.querySelector('[data-instruction-content]'),value=editor.querySelector('[data-instruction-value]'),form=editor.closest('form'),bold=editor.querySelector('[data-instruction-bold]'),size=editor.querySelector('[data-instruction-size]');
 if(!content||!value)return;
 let savedRange=null;
 const captureSelection=()=>{const selection=window.getSelection();if(selection?.rangeCount&&content.contains(selection.anchorNode))savedRange=selection.getRangeAt(0).cloneRange();};
 const restoreSelection=()=>{content.focus();if(savedRange){const selection=window.getSelection();selection.removeAllRanges();selection.addRange(savedRange);}};
 const runs=[];
 const append=(text,state)=>{if(!text)return;const last=runs[runs.length-1];if(last&&last.bold===state.bold&&last.size===state.size)last.text+=text;else runs.push({text,bold:state.bold,size:state.size});};
 const walk=(node,state)=>{
  if(node.nodeType===Node.TEXT_NODE){append(node.nodeValue,{...state});return;}
  if(node.nodeType!==Node.ELEMENT_NODE)return;
  const tag=node.tagName.toLowerCase(),block=/^(div|p|li)$/.test(tag);
  if(block&&runs.length&& !runs[runs.length-1].text.endsWith('\n'))append('\n',{...state});
  const styleSize=parseInt(node.dataset.instructionSize||node.style.fontSize,10);
  const next={bold:state.bold||tag==='b'||tag==='strong'||node.style.fontWeight==='bold'||Number(node.style.fontWeight)>=600,size:[12,14,16,18,20,24,28,32].includes(styleSize)?styleSize:state.size};
  if(tag==='br')append('\n',next);else [...node.childNodes].forEach(child=>walk(child,next));
  if(block&&!runs[runs.length-1]?.text.endsWith('\n'))append('\n',{...state});
 };
 const sync=()=>{runs.length=0;[...content.childNodes].forEach(node=>walk(node,{bold:false,size:16}));while(runs.length&&runs[runs.length-1].text==='\n')runs.pop();value.value=JSON.stringify({format:'marand-instructions-v1',runs});};
 content.addEventListener('keyup',captureSelection);content.addEventListener('mouseup',captureSelection);content.addEventListener('input',sync);
 document.addEventListener('selectionchange',captureSelection);
 form?.addEventListener('submit',sync);
 bold?.addEventListener('mousedown',event=>event.preventDefault());
 bold?.addEventListener('click',()=>{restoreSelection();const selection=window.getSelection();if(selection?.rangeCount&&!selection.getRangeAt(0).collapsed){document.execCommand('bold');sync();captureSelection();}});
 size?.addEventListener('change',()=>{const fontSize=Number(size.value);restoreSelection();const selection=window.getSelection();if(!selection?.rangeCount||selection.getRangeAt(0).collapsed)return;const range=selection.getRangeAt(0);const span=document.createElement('span');span.dataset.instructionSize=String(fontSize);span.style.fontSize=`${fontSize}px`;span.appendChild(range.extractContents());range.insertNode(span);selection.removeAllRanges();const cursor=document.createRange();cursor.setStartAfter(span);cursor.collapse(true);selection.addRange(cursor);savedRange=cursor.cloneRange();sync();});
});
const gbList=document.querySelector('[data-gb-list]');
const gbRows=()=>gbList?[...gbList.querySelectorAll('[data-gb-index]')]:[];
const threadingMarkup=(index,full)=>{
 const position=index+1,state=full?'full':'empty',label=full?'pełna':'pusta',wrap=document.createElement('span'),toggle=document.createElement('button'),remove=document.createElement('button');
 wrap.className='threading-position';
 toggle.type='button';toggle.className=`threading-cell ${state}`;toggle.dataset.threadingCell='';toggle.dataset.threadingState=state;toggle.setAttribute('aria-pressed',String(full));toggle.setAttribute('aria-label',`Pozycja ${position} — nitka ${label}`);toggle.title=`Kliknij, aby zmienić na nitkę ${full?'pustą':'pełną'}`;toggle.textContent=full?'|':'○';
 remove.type='button';remove.className='threading-remove-cell';remove.dataset.removeThreadingCell='';remove.setAttribute('aria-label',`Usuń pozycję ${position}`);remove.title='Usuń pozycję';remove.textContent='×';
 wrap.append(toggle,remove);return wrap;
};
const syncThreading=editor=>{
 const cells=[...editor.querySelectorAll('[data-threading-cell]')],sequence=cells.map(cell=>cell.dataset.threadingState==='full'?'|':'.').join('');
 editor.querySelector('[data-threading-value]').value=sequence;
 editor.querySelector('[data-threading-display]').textContent=sequence;
 const legacy=editor.querySelector('[data-threading-legacy]');if(legacy){legacy.hidden=true;legacy.textContent='';}
 cells.forEach((cell,index)=>{const full=cell.dataset.threadingState==='full';cell.setAttribute('aria-label',`Pozycja ${index+1} — nitka ${full?'pełna':'pusta'}`);cell.title=`Kliknij, aby zmienić na nitkę ${full?'pustą':'pełną'}`;cell.nextElementSibling.setAttribute('aria-label',`Usuń pozycję ${index+1}`);});
};
const updateGbRows=()=>{
  const rows=gbRows();
  rows.forEach((row,index)=>{
    row.dataset.gbIndex=String(index);
    row.querySelectorAll('[name^="gb_"]').forEach(control=>{control.name=control.name.replace(/^gb_\d+_/,`gb_${index}_`);});
    const remove=row.querySelector('[data-remove-gb]');
    if(remove){const number=row.dataset.gbNumber;remove.setAttribute('aria-label',`Usuń GB ${number}`);remove.title=`Usuń GB ${number}`;remove.hidden=rows.length<=1;}
  });
};
if(gbList)gbList.addEventListener('click',event=>{
  const addThreading=event.target.closest('[data-add-threading-cell]');
  if(addThreading){const editor=addThreading.closest('[data-threading-editor]'),positions=editor.querySelector('[data-threading-positions]');positions.append(threadingMarkup(positions.children.length,false));syncThreading(editor);dirty=true;return;}
  const removeThreading=event.target.closest('[data-remove-threading-cell]');
  if(removeThreading){const editor=removeThreading.closest('[data-threading-editor]');removeThreading.closest('.threading-position').remove();syncThreading(editor);dirty=true;return;}
  const toggleThreading=event.target.closest('[data-threading-cell]');
  if(toggleThreading){const full=toggleThreading.dataset.threadingState!=='full';toggleThreading.dataset.threadingState=full?'full':'empty';toggleThreading.classList.toggle('full',full);toggleThreading.classList.toggle('empty',!full);toggleThreading.setAttribute('aria-pressed',String(full));toggleThreading.textContent=full?'|':'○';syncThreading(toggleThreading.closest('[data-threading-editor]'));dirty=true;return;}
  const remove=event.target.closest('[data-remove-gb]');
  if(!remove)return;
  const row=remove.closest('[data-gb-index]');
  if(!row||gbRows().length<=1)return;
  row.remove();updateGbRows();dirty=true;
});
const addGB=document.querySelector('[data-add-gb]');
if(addGB)addGB.addEventListener('click',()=>{
  const list=gbList;const rows=gbRows();
  if(rows.length>=12){alert('Maksymalnie 12 GB w jednym wpisie.');return;}
  const number=Math.max(0,...rows.map(r=>Number(r.dataset.gbNumber)))+1;
  if(number>32){alert('Osiągnięto maksymalne oznaczenie GB32.');return;}
  const next=rows[0].cloneNode(true);next.dataset.gbIndex=rows.length;next.dataset.gbNumber=number;next.querySelector('h3').textContent='GB'+number;
  next.querySelectorAll('input,textarea').forEach(c=>{c.name=c.name.replace(/^gb_\d+_/,`gb_${rows.length}_`);c.value=c.type==='hidden'&&c.name.endsWith('_number')?String(number):c.name.endsWith('_threading')?'|':'';c.classList.remove('inherited-value');});
  const threadingEditor=next.querySelector('[data-threading-editor]'),threadingPositions=next.querySelector('[data-threading-positions]');threadingPositions.replaceChildren(threadingMarkup(0,true));next.querySelector('[data-threading-display]').textContent='|';const legacy=next.querySelector('[data-threading-legacy]');if(legacy){legacy.hidden=true;legacy.textContent='';}syncThreading(threadingEditor);
  list.appendChild(next);updateGbRows();dirty=true;next.querySelector('input:not([type=hidden])').focus();
});
document.querySelectorAll('[data-photo]').forEach(form=>form.addEventListener('submit',async event=>{
 event.preventDefault();const status=form.querySelector('[data-photo-status]'),button=form.querySelector('button');button.disabled=true;
 try{
  const file=form.querySelector('[data-photo-file]').files[0];
  if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Wybierz zdjęcie JPEG, PNG lub WebP.');
  if(file.size>25*1024*1024)throw new Error('Zdjęcie źródłowe przekracza 25 MB.');
  status.textContent='Zmniejszanie zdjęcia…';
  const bitmap=await createImageBitmap(file);const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const data=canvas.toDataURL('image/jpeg',0.82);if(data.length>2800000)throw new Error('Zdjęcie nadal jest za duże. Wybierz mniejsze.');
  form.elements.image.value=data;status.textContent='Wysyłanie…';submitting=true;HTMLFormElement.prototype.submit.call(form);
 }catch(err){status.textContent=err.message;button.disabled=false;}
}));

// Search and sort controls update the current result page as soon as a value changes.
document.querySelectorAll('form[data-live-search]').forEach(liveSearch=>{
 let searchTimer=null,searchSequence=0;
 const results=liveSearch.parentElement.querySelector('[data-live-results]')||document.querySelector('[data-live-results]'),count=liveSearch.querySelector('[data-live-count]')||document.querySelector('[data-live-count]'),searchInput=liveSearch.querySelector('input[name="q"]');let activeRow=-1;
 const resultRows=()=>results?[...results.querySelectorAll('tbody tr')].filter(row=>row.querySelector('a[href]')):[];
 const clearActiveRow=()=>{resultRows().forEach(row=>row.classList.remove('keyboard-active'));activeRow=-1;};
 const currentSearchUrl=()=>{
  const params=new URLSearchParams();
  for(const [key,value] of new FormData(liveSearch))if(String(value).trim())params.set(key,String(value).trim());
  const query=params.toString();return `${location.pathname}${query?`?${query}`:''}`;
 };
 const syncControls=url=>{
  const params=new URL(url,location.href).searchParams;
  for(const control of liveSearch.elements){if(!control.name)continue;if(params.has(control.name))control.value=params.get(control.name);else if(control.type==='text'||control.type==='search'||control.type==='date')control.value='';}
 };
 const loadResults=async(url,sequence=++searchSequence)=>{
  if(!results)return;
  results.setAttribute('aria-busy','true');
  try{
   const response=await fetch(url,{headers:{'X-Requested-With':'fetch'}});
   if(!response.ok)throw new Error('Nie udało się pobrać wyników.');
   const html=await response.text(),doc=new DOMParser().parseFromString(html,'text/html'),next=doc.querySelector('[data-live-results]'),nextCount=doc.querySelector('[data-live-count]');
   if(!next)throw new Error('Brak wyników w odpowiedzi.');
   if(sequence!==searchSequence)return;
   results.innerHTML=next.innerHTML;
   if(count&&nextCount)count.textContent=nextCount.textContent;
   syncControls(url);history.replaceState({},'',url);activeRow=-1;
  }catch(error){if(sequence===searchSequence)location.assign(url);}
  finally{if(sequence===searchSequence)results.removeAttribute('aria-busy');}
 };
 const scheduleSearch=delay=>{clearTimeout(searchTimer);const sequence=++searchSequence;searchTimer=setTimeout(()=>loadResults(currentSearchUrl(),sequence),delay);};
 liveSearch.addEventListener('input',event=>{if(event.target.matches('input[name="q"]')){clearActiveRow();scheduleSearch(220);}});
 liveSearch.addEventListener('change',event=>{if(!event.target.matches('input[name="q"]'))scheduleSearch(0);});
 liveSearch.addEventListener('submit',event=>{event.preventDefault();scheduleSearch(0);});
 searchInput?.addEventListener('keydown',event=>{
  const rows=resultRows();if(!rows.length)return;
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();activeRow=event.key==='ArrowDown'?(activeRow+1)%rows.length:(activeRow<=0?rows.length-1:activeRow-1);
   rows.forEach((row,index)=>row.classList.toggle('keyboard-active',index===activeRow));rows[activeRow].scrollIntoView({block:'nearest'});
  }else if(event.key==='Enter'&&activeRow>=0&&rows[activeRow]){event.preventDefault();rows[activeRow].querySelector('a[href]')?.click();}
 });
 document.addEventListener('click',event=>{
  const link=event.target.closest('[data-live-results] .pagination a');
  if(!link)return;
  event.preventDefault();clearTimeout(searchTimer);const sequence=++searchSequence;loadResults(link.href,sequence);
 });
});

document.querySelectorAll('[data-article-description]').forEach(container=>{
 const view=container.querySelector('[data-article-description-view]'),form=container.querySelector('[data-article-description-form]'),input=container.querySelector('[data-article-description-input]'),status=container.querySelector('[data-article-description-status]');
 if(!view||!form||!input||!status)return;
 let saved=input.value,timer=null,busy=false,pending=false;
 const setStatus=(message,error=false)=>{status.textContent=message;status.classList.toggle('save-error',error);};
 const showSaved=()=>{view.textContent=saved;if(!saved){view.innerHTML='<span class="muted">Kliknij, aby dodać opis artykułu</span>';}view.hidden=false;form.hidden=true;};
 const open=()=>{if(!form.hidden)return;input.value=saved;view.hidden=true;form.hidden=false;setStatus('');input.focus();input.setSelectionRange(input.value.length,input.value.length);};
 const persist=async()=>{
  if(busy){pending=true;return;}
  if(input.value===saved){showSaved();return;}
  busy=true;
  do{
   pending=false;const snapshot=input.value;setStatus('Zapisywanie…');
   try{
    const response=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-Requested-With':'fetch'},body:new URLSearchParams(new FormData(form))});
    const raw=await response.text();let result={};try{result=JSON.parse(raw);}catch{}
    if(!response.ok||!result.ok)throw new Error(result.error||'Nie udało się zapisać opisu. Odśwież stronę i spróbuj ponownie.');
    saved=result.description;input.value=input.value===snapshot?saved:input.value;form.elements.updated_at.value=result.updated_at;
    if(input.value!==saved||pending)pending=true;
    else {setStatus('Zapisano automatycznie.');showSaved();}
   }catch(error){setStatus(error.message||'Błąd zapisu. Spróbuj ponownie.',true);break;}
  }while(pending);
  busy=false;
 };
 view.addEventListener('click',open);
 view.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
 input.addEventListener('input',()=>{clearTimeout(timer);setStatus('Niezapisane zmiany…');timer=setTimeout(persist,700);});
 input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();if(busy){setStatus('Zapis trwa — poczekaj.');return;}clearTimeout(timer);input.value=saved;setStatus('');showSaved();}});
 form.addEventListener('focusout',()=>setTimeout(()=>{if(form.hidden||form.contains(document.activeElement))return;clearTimeout(timer);persist();},0));
});

document.querySelectorAll('[data-autosave]').forEach(form=>{
 const control=form.querySelector('[data-autosave-value]'),status=form.querySelector('[data-autosave-status]');
 if(!control||!status)return;
 let timer=null,sequence=0,busy=false,queued=false;
 const setStatus=(message,error=false)=>{status.textContent=message;status.classList.toggle('save-error',error);};
 const persist=async()=>{
  if(busy){queued=true;return;}
  busy=true;
  do{
   queued=false;const value=control.value,version=sequence;
   setStatus('Zapisywanie…');
   try{
    const body=new URLSearchParams(new FormData(form));body.set('value',value);
    const response=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-Requested-With':'fetch'},body});
    const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Nie udało się zapisać.');
    if(version===sequence&&!queued)setStatus('Zapisano automatycznie.');else queued=true;
   }catch{setStatus('Błąd zapisu. Spróbuj ponownie.',true);break;}
  }while(queued);
  busy=false;
 };
 const schedule=delay=>{sequence++;queued=true;clearTimeout(timer);setStatus('Niezapisane zmiany…');timer=setTimeout(persist,delay);};
 control.addEventListener('input',()=>schedule(650));
 control.addEventListener('change',()=>{clearTimeout(timer);persist();});
 control.addEventListener('blur',()=>{clearTimeout(timer);if(queued)persist();});
});

document.querySelectorAll('[data-comment-composer]').forEach(form=>{
 const journal=form.closest('[data-comment-journal]'),input=form.querySelector('[data-comment-input]'),status=form.querySelector('[data-comment-status]'),list=journal?.querySelector('[data-comment-list]');
 if(!input||!status||!list)return;
 let commentId=null,savedContent='',timer=null,sequence=0,busy=false,queued=false,finalize=false;
 const setStatus=(message,error=false)=>{status.textContent=message;status.classList.toggle('save-error',error);};
 const renderComment=comment=>{
  if(!comment)return;
  journal.querySelector('[data-comment-empty]')?.remove();
  let row=list.querySelector(`[data-comment-entry="${comment.id}"]`);
  if(!row){
   row=document.createElement('article');row.className='project-comment';row.dataset.commentEntry=String(comment.id);
   const meta=document.createElement('div');meta.className='project-comment-meta';
   const author=document.createElement('strong');author.dataset.commentAuthor='';
   const time=document.createElement('time');time.dataset.commentTime='';meta.append(author,time);
   const remove=document.createElement('a');remove.className='delete-x project-comment-delete';remove.setAttribute('aria-label','Usuń komentarz');remove.setAttribute('title','Usuń komentarz');
   remove.href=form.dataset.commentDeleteBase+comment.id+'/delete';remove.textContent='×';meta.append(remove);
   const text=document.createElement('p');text.className='preline';text.dataset.commentContent='';row.append(meta,text);list.appendChild(row);
  }
  row.querySelector('[data-comment-author]').textContent=comment.author_name;
  row.querySelector('[data-comment-time]').textContent=new Date(comment.created_at).toLocaleString('pl-PL');
  row.querySelector('[data-comment-content]').textContent=comment.content;
 };
 const persist=async()=>{
  if(busy){queued=true;return;}
  busy=true;
  do{
   queued=false;const content=input.value,version=sequence;
   if(!content.trim()){
    if(finalize){input.value='';commentId=null;savedContent='';setStatus('Komentarz zapisany.');finalize=false;}
    break;
   }
   setStatus('Zapisywanie komentarza…');
   try{
    const body=new URLSearchParams(new FormData(form));body.set('content',content);if(commentId)body.set('comment_id',String(commentId));else body.delete('comment_id');
    const response=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-Requested-With':'fetch'},body});
    const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Nie udało się zapisać komentarza.');
    if(result.comment){commentId=result.comment.id;savedContent=result.comment.content;renderComment(result.comment);}
    if(version===sequence&&!queued){
     if(finalize){input.value='';commentId=null;savedContent='';finalize=false;setStatus('Komentarz zapisany.');}
     else setStatus('Zapisano automatycznie.');
    }else queued=true;
   }catch{setStatus('Błąd zapisu. Komentarz nadal jest w polu.',true);break;}
  }while(queued);
  busy=false;
 };
 const schedule=delay=>{sequence++;queued=true;finalize=false;clearTimeout(timer);setStatus('Niezapisane zmiany…');timer=setTimeout(persist,delay);};
 input.addEventListener('input',()=>schedule(650));
 input.addEventListener('change',()=>{clearTimeout(timer);persist();});
 input.addEventListener('blur',()=>{
  clearTimeout(timer);finalize=true;
  if(!input.value.trim()&&commentId&&savedContent){input.value=savedContent;commentId=null;savedContent='';finalize=true;}
  if(queued||input.value.trim())persist();else{input.value='';finalize=false;}
 });
});

document.addEventListener('click',event=>{const link=event.target.closest('[data-stage-delete-link]');if(link){event.preventDefault();event.stopPropagation();location.assign(link.href);}},true);
