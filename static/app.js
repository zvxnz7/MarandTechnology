'use strict';
let dirty=false,submitting=false;
const correctionParentUrl=document.body?.dataset.correctionParentUrl;
if(correctionParentUrl&&window.opener&&!window.opener.closed){try{window.opener.location.replace(correctionParentUrl);}catch{}}
document.querySelectorAll('[data-finishing-batch-delete]').forEach(form=>form.addEventListener('submit',event=>{
 const batchLabel=form.dataset.batchLabel||'tej partii';
 if(!window.confirm(`Usunąć ${batchLabel}? Zapisane przyjęcia i dane belek z tej partii zostaną usunięte. Wpis audytowy pozostanie, a zgłoszone problemy zostaną zachowane i odłączone od partii.`))event.preventDefault();
}));
document.querySelectorAll('[data-finishing-lot-autosave]').forEach(form=>{
 const input=form.elements.finishing_lot;let timer=null,saving=false,queued=false,lastSaved=input.value.trim();
 const matchingRemoveForm=()=>[...form.closest('.finishing-order-lot-list')?.querySelectorAll('[data-finishing-batch-delete]')||[]].find(removeForm=>removeForm.elements.remove_batch_id?.value===form.elements.batch_id?.value);
 const updateRemoveForm=()=>{const removeForm=matchingRemoveForm();if(!removeForm)return;removeForm.hidden=false;const button=removeForm.querySelector('button');if(button)button.disabled=saving||input.value.trim()!==lastSaved;};
 const updateReceiveButton=savedValue=>{
  const batchId=String(form.elements.batch_id?.value||''),button=[...document.querySelectorAll('[data-batch-receive]')].find(item=>item.dataset.batchReceive===batchId);
  if(!button||input.value.trim()!==savedValue)return;
  const dialog=document.getElementById(`finishing-receive-${batchId}`);if(!dialog)return;
  const orderNumber=dialog.querySelector('[data-receipt-order-number]');if(orderNumber)orderNumber.textContent=savedValue;
  button.disabled=false;button.dataset.openDialog=`finishing-receive-${batchId}`;button.title='Przyjmij sztuki';button.setAttribute('aria-label',`Przyjmij sztuki · nr zlecenia ${savedValue}`);
 };
 const save=async()=>{
  const value=input.value.trim();if(!value||value===lastSaved)return;if(saving){queued=true;return;}saving=true;
  try{
   const response=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json'},body:new URLSearchParams(new FormData(form))});
   const result=await response.json();if(!response.ok||!result.ok)throw new Error('Nie udało się zapisać numeru LOT.');
   lastSaved=value;form.dataset.saveState='saved';input.title='Nr zlecenia zapisany';updateRemoveForm();updateReceiveButton(value);
   const orderRow=form.closest('tr'),statusBadge=orderRow?.querySelector('td:nth-child(8) .badge');
   if(statusBadge&&result.status_label){statusBadge.textContent=result.status_label;statusBadge.className=`badge ${result.status_class||'submitted'}`;}
  }catch{form.dataset.saveState='error';input.title='Nie udało się zapisać numeru LOT. Sprawdź połączenie i spróbuj ponownie.';}
  finally{saving=false;updateRemoveForm();if(queued){queued=false;timer=setTimeout(save,150);}}
 };
 const schedule=()=>{clearTimeout(timer);updateRemoveForm();if(!input.value.trim()){form.dataset.saveState='';return;}form.dataset.saveState='pending';timer=setTimeout(save,350);};
 input.addEventListener('input',schedule);input.addEventListener('change',()=>{clearTimeout(timer);save();});
 form.addEventListener('submit',event=>{event.preventDefault();clearTimeout(timer);save();});
});
document.querySelectorAll('[data-print-page]').forEach(button=>button.addEventListener('click',()=>{
 const timestamp=document.querySelector('[data-print-timestamp]');
 if(timestamp)timestamp.textContent=new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date());
 window.print();
}));
document.querySelectorAll('[data-finishing-order-form]').forEach(form=>{
 const orderTypeInputs=[...form.querySelectorAll('[name="order_type"]')],plant=form.querySelector('[data-finishing-plant]'),recipe=form.querySelector('[data-finishing-recipe]'),recipeSearch=form.querySelector('[data-finishing-recipe-search]'),recipeResults=form.querySelector('[data-finishing-recipe-results]'),recipeSelected=form.querySelector('[data-finishing-recipe-selected]'),recipeEditShortcut=form.querySelector('[data-finishing-recipe-edit-shortcut]'),selectedRecipeDetails=form.querySelector('[data-finishing-selected-recipe]'),selectedRecipeText=form.querySelector('[data-finishing-selected-recipe-text]'),source=form.querySelector('[data-finishing-source]'),sourceDetails=form.querySelector('[data-finishing-source-details]'),lastProductionNote=form.querySelector('[data-finishing-last-production-note]');
 const checkDialog=document.querySelector('[data-finishing-production-check]'),checkContent=checkDialog?.querySelector('[data-finishing-production-check-content]'),checkConfirm=checkDialog?.querySelector('[data-finishing-production-check-confirm]'),confirmValue=form.elements.namedItem('confirm_last_production'),submitButton=form.querySelector('[type="submit"]');
 let recipeTimer=null,recipeController=null,sourceController=null,activeRecipeIndex=-1;
 const recipeOptions=()=>[...recipeResults.querySelectorAll('[data-finishing-recipe-option]')];
 const setActiveRecipe=index=>{
  const options=recipeOptions();activeRecipeIndex=options.length?Math.max(0,Math.min(index,options.length-1)):-1;
  options.forEach((option,i)=>option.setAttribute('aria-selected',String(i===activeRecipeIndex)));
  const active=options[activeRecipeIndex];
  if(active){recipeSearch.setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'});}
  else recipeSearch.removeAttribute('aria-activedescendant');
 };
 const closeRecipeResults=()=>{recipeResults.replaceChildren();recipeSearch.setAttribute('aria-expanded','false');recipeSearch.removeAttribute('aria-activedescendant');activeRecipeIndex=-1;};
 const clearRecipe=()=>{recipe.value='';delete recipe.dataset.selectedLabel;delete recipe.dataset.plant;recipeSelected.textContent='';recipeEditShortcut.href='/finishing/recipes?return_to_order=1';recipeEditShortcut.setAttribute('aria-label','Otwórz bibliotekę receptur do edycji');recipeEditShortcut.title='Otwórz bibliotekę receptur do edycji';selectedRecipeDetails.hidden=true;selectedRecipeDetails.open=false;selectedRecipeText.textContent='';form.elements.trade_symbol.value='';};
 const sync=()=>{const raw=orderTypeInputs.find(input=>input.checked)?.value==='raw_sale';plant.required=!raw;recipeSearch.required=!raw;};
 const applyRecipe=button=>{
  const label=button.dataset.recipeLabel||button.querySelector('strong')?.textContent||'';
  recipe.value=button.dataset.recipeId||'';recipe.dataset.selectedLabel=label;recipe.dataset.plant=button.dataset.plant||'';recipeSearch.value=label;recipeSearch.setCustomValidity('');
  recipeEditShortcut.href=`/finishing/recipes/${recipe.value}/edit?return_to_order=1`;recipeEditShortcut.setAttribute('aria-label','Edytuj wybraną recepturę');recipeEditShortcut.title='Edytuj wybraną recepturę';
  recipeSelected.textContent=`Wybrano recepturę: ${label}`;
  selectedRecipeText.textContent=button.dataset.recipeText||'Brak tekstowego opisu receptury.';selectedRecipeDetails.hidden=false;selectedRecipeDetails.open=false;
  for(const [field,key] of [['target_color','color'],['target_stiffening','stiffening'],['target_width_cm','width'],['target_grammage','grammage']]){const input=form.elements[field],value=button.dataset[key];if(input)input.value=value||'';}
  if(form.elements.trade_symbol)form.elements.trade_symbol.value=button.dataset.tradeSymbol||'';
  if(button.dataset.plant)plant.value=button.dataset.plant;
  closeRecipeResults();
 };
 window.addEventListener('message',event=>{
  const updated=event.data?.type==='finishing-recipe-updated'&&event.data.recipe;
  if(event.origin!==location.origin||!updated)return;
  const option=document.createElement('button');option.dataset.recipeId=String(updated.id);option.dataset.recipeLabel=`${updated.name}${updated.rawSymbol?` · ${updated.rawSymbol}`:''}`;option.dataset.recipeText=updated.recipeText||'';option.dataset.plant=String(updated.plant||'');option.dataset.color=updated.color||'';option.dataset.stiffening=updated.stiffening||'';option.dataset.width=updated.width??'';option.dataset.grammage=updated.grammage??'';option.dataset.tradeSymbol=updated.tradeSymbol||'';applyRecipe(option);
 });
 const searchRecipes=async()=>{
  const query=recipeSearch.value.trim();recipeController?.abort();recipeController=null;
  if(query.length<1){recipeResults.replaceChildren();recipeSearch.setAttribute('aria-expanded','false');return;}
  recipeController=new AbortController();const params=new URLSearchParams({q:query,plant_id:plant.value||''});
  try{const response=await fetch(`${recipeSearch.dataset.searchUrl}&${params}`,{headers:{'X-Requested-With':'fetch'},signal:recipeController.signal});if(!response.ok)throw new Error();recipeResults.innerHTML=await response.text();activeRecipeIndex=-1;recipeSearch.removeAttribute('aria-activedescendant');recipeSearch.setAttribute('aria-expanded',String(Boolean(recipeResults.querySelector('[data-finishing-recipe-option]'))));}
  catch(error){if(error.name!=='AbortError'){recipeResults.textContent='Nie udało się wyszukać receptur.';recipeSearch.setAttribute('aria-expanded','false');}}
 };
 const loadSource=async()=>{
  sourceController?.abort();sourceController=null;
  const option=source.selectedOptions[0];plant.value=option?.dataset.plant||'';
  if(recipe.value&&recipe.dataset.plant&&recipe.dataset.plant!==plant.value){clearRecipe();recipeSearch.value='';}
  if(!source.value){sourceDetails.innerHTML='<p class="muted finishing-source-placeholder">Po wybraniu specyfikacji zostaną załadowane sztuki z tej wysyłki.</p>';return;}
  sourceDetails.innerHTML='<p class="muted">Ładowanie sztuk ze specyfikacji…</p>';sourceController=new AbortController();
  const params=new URLSearchParams({partial:'source',shipment_article_id:source.value});
  try{const response=await fetch(`${form.dataset.sourceUrl.split('?')[0]}?${params}`,{headers:{'X-Requested-With':'fetch'},signal:sourceController.signal});sourceDetails.innerHTML=await response.text();if(!response.ok)source.value='';}
  catch(error){if(error.name!=='AbortError')sourceDetails.innerHTML='<p class="notice warning">Nie udało się załadować sztuk ze specyfikacji.</p>';}
 };
 recipeSearch.addEventListener('input',()=>{recipeSearch.setCustomValidity('');if(recipe.value&&recipeSearch.value!==recipe.dataset.selectedLabel)clearRecipe();closeRecipeResults();clearTimeout(recipeTimer);recipeTimer=setTimeout(searchRecipes,180);});
 recipeSearch.addEventListener('keydown',event=>{
  const options=recipeOptions();
  if(event.key==='ArrowDown'&&options.length){event.preventDefault();setActiveRecipe(activeRecipeIndex<0?0:activeRecipeIndex+1);}
  else if(event.key==='ArrowUp'&&options.length){event.preventDefault();setActiveRecipe(activeRecipeIndex<0?options.length-1:activeRecipeIndex-1);}
  else if(event.key==='Enter'&&activeRecipeIndex>=0&&options[activeRecipeIndex]){event.preventDefault();applyRecipe(options[activeRecipeIndex]);}
  else if(event.key==='Escape'&&recipeResults.childElementCount){event.preventDefault();closeRecipeResults();}
 });
 recipeResults.addEventListener('click',event=>{const option=event.target.closest('[data-finishing-recipe-option]');if(option)applyRecipe(option);});
 plant.addEventListener('change',()=>{if(recipe.value&&recipe.dataset.plant&&recipe.dataset.plant!==plant.value){clearRecipe();recipeSearch.value='';}clearTimeout(recipeTimer);recipeTimer=setTimeout(searchRecipes,120);});
 source.addEventListener('change',loadSource);orderTypeInputs.forEach(input=>input.addEventListener('change',sync));
 const addCheckRow=(label,value,highlight='')=>{const row=document.createElement('div');row.className=`finishing-production-check-row${highlight?` ${highlight}`:''}`;const title=document.createElement('strong'),text=document.createElement('span');title.textContent=label;text.textContent=value||'—';row.append(title,text);checkContent.appendChild(row);};
 const addCheckIssues=issues=>{const panel=document.createElement('section');panel.className=`finishing-production-check-issues${issues?.length?' has-issues':' is-clear'}`;const title=document.createElement('strong');title.textContent=issues?.length?'Wykryte niezgodności i braki danych':'Nie wykryto niezgodności';panel.appendChild(title);if(issues?.length){const list=document.createElement('ul');issues.forEach(issue=>{const item=document.createElement('li');item.textContent=issue;list.appendChild(item);});panel.appendChild(list);}else{const text=document.createElement('p');text.textContent='Dane z PM, receptury i ostatniej produkcji są zgodne w sprawdzonych punktach.';panel.appendChild(text);}checkContent.appendChild(panel);};
 const showCheck=async()=>{
  checkConfirm.disabled=true;checkContent.replaceChildren();const loading=document.createElement('p');loading.textContent='Sprawdzam dane ostatniej produkcji…';checkContent.appendChild(loading);checkDialog.showModal();
  const params=new URLSearchParams({partial:'last-production',shipment_article_id:source.value,recipe_id:recipe.value||''});
  try{
   const response=await fetch(`${form.dataset.productionCheckUrl.split('?')[0]}?${params}`,{headers:{'X-Requested-With':'fetch'}}),data=await response.json();checkContent.replaceChildren();
   if(!response.ok)throw new Error(data.error||'Nie udało się pobrać informacji o ostatniej produkcji.');
   addCheckIssues(data.issues||[]);
   addCheckRow('Receptura wykańczania',data.recipeName||'Brak nazwy receptury');
   if(!data.found){const note=document.createElement('p');note.className='finishing-production-check-empty';note.textContent='Nie ma zapisanej wcześniejszej produkcji tej receptury. Poniżej sprawdź LOT z wybranego PM.';checkContent.appendChild(note);}
   else{
    const lastOrder=[data.pm,data.finishingOrder?`zlecenie farbiarskie ${data.finishingOrder}`:''].filter(Boolean).join(' · ');
    addCheckRow('Ostatnie zlecenie',lastOrder||'Brak danych');
    addCheckRow('Data',data.date);
    if(data.colorResult==='Kolor różni się od receptury')addCheckRow('Kolor niezgodny',data.color||'NOK','is-warning');
    addCheckRow('Komentarze',data.comments);
    addCheckRow('LOT z poprzedniej produkcji',data.previousLot||'Brak');
   }
   addCheckRow('LOT z wybranego PM',data.currentLot);
   addCheckRow('Porównanie LOT-u',data.lotComparison,data.lotComparison==='Ten sam LOT'?'is-ok':data.lotComparison==='LOT się zmienił'?'is-warning':'');
   const noteLabel=document.createElement('label');noteLabel.className='finishing-production-check-note';noteLabel.textContent='Notatka dla wykańczalni';
   const noteInput=document.createElement('textarea');noteInput.rows=3;noteInput.maxLength=3000;noteInput.placeholder='Wpisz dodatkową informację dla wykańczalni';noteInput.dataset.finishingLastProductionNoteInput='';noteLabel.appendChild(noteInput);checkContent.appendChild(noteLabel);checkConfirm.disabled=false;
  }catch(error){checkContent.replaceChildren();const note=document.createElement('p');note.className='notice warning';note.textContent=error.message;checkContent.appendChild(note);}
 };
 form.addEventListener('submit',event=>{
  const raw=orderTypeInputs.find(input=>input.checked)?.value==='raw_sale';
  if(!raw&&!recipe.value){event.preventDefault();recipeSearch.setCustomValidity('Wybierz recepturę z wyników wyszukiwania.');recipeSearch.reportValidity();return;}
  recipeSearch.setCustomValidity('');
  if(confirmValue?.value==='1')return;
  event.preventDefault();showCheck();
 });
 checkConfirm?.addEventListener('click',()=>{if(checkConfirm.disabled)return;lastProductionNote.value=checkContent.querySelector('[data-finishing-last-production-note-input]')?.value.trim()||'';confirmValue.value='1';form.requestSubmit(submitButton);});
 checkDialog?.querySelectorAll('[data-finishing-production-check-close],[data-finishing-production-check-cancel]').forEach(button=>button.addEventListener('click',()=>checkDialog.close()));
 document.addEventListener('click',event=>{if(!form.contains(event.target))closeRecipeResults();});
 sync();
});
document.querySelectorAll('[data-finishing-recipe-copy-button]').forEach(button=>{
 const form=button.form,search=form.querySelector('[data-finishing-recipe-copy-search]'),status=form.querySelector('[data-finishing-recipe-copy-status]');
 let sources=[];try{sources=JSON.parse(form.querySelector('[data-finishing-recipe-copy-data]')?.textContent||'[]');}catch{}
 const selected=()=>sources.find(source=>source.label===search.value);
 const update=()=>{const source=selected();button.disabled=!source;if(source)status.textContent=`Wybrano: ${source.label}`;else if(search.value)status.textContent='Wybierz recepturę z listy podpowiedzi.';else status.textContent=sources.length?'Wybierz recepturę z listy podpowiedzi.':'Brak receptur do skopiowania.';};
 search.addEventListener('input',update);search.addEventListener('change',update);
 button.addEventListener('click',()=>{
  const source=selected();if(!source)return;
  for(const [name,value] of Object.entries(source.values)){
   const checkbox=form.querySelector(`input[type="checkbox"][name="${name}"]`);
   if(checkbox){checkbox.checked=Boolean(value);checkbox.dispatchEvent(new Event('change',{bubbles:true}));continue;}
   const field=form.elements.namedItem(name);if(field&&'value'in field){field.value=value??'';field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
  }
  status.textContent=`Skopiowano parametry receptury: ${source.label}`;
 });
 update();
});
const recipeReturn=document.querySelector('[data-return-recipe-to-order]');
if(recipeReturn&&window.opener&&!window.opener.closed){
 try{const recipe=JSON.parse(recipeReturn.textContent);window.opener.postMessage({type:'finishing-recipe-updated',recipe},location.origin);window.close();}catch{}
}
document.querySelectorAll('.finishing-recipe-form').forEach(form=>{
 const symbol=form.querySelector('[data-article-symbol]'),composition=form.querySelector('[data-article-composition]');
 let map={};try{map=JSON.parse(form.querySelector('[data-article-composition-map]')?.textContent||'{}');}catch{}
 if(!symbol||!composition)return;
 let lastAuto=composition.value;
 const fill=()=>{
  const value=map[symbol.value.trim()];
  if(value&&(composition.value.trim()===''||composition.value===lastAuto)){composition.value=value;lastAuto=value;composition.dispatchEvent(new Event('input',{bubbles:true}));}
  else if(!value&&composition.value===lastAuto){composition.value='';lastAuto='';composition.dispatchEvent(new Event('input',{bubbles:true}));}
 };
 symbol.addEventListener('input',fill);symbol.addEventListener('change',fill);fill();
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
document.querySelectorAll('.shipment-article-actions a').forEach(link=>link.addEventListener('click',event=>event.stopPropagation()));
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
 const preview=form.querySelector('[data-correction-specification-preview]'),stockPreview=form.querySelector('[data-correction-stock-preview]'),count=form.querySelector('[data-correction-spec-count]');
 const updatePreview=()=>{
  const removed=[...form.querySelectorAll('[data-correction-remove]')].filter(box=>box.checked);
  form.querySelectorAll('[data-correction-current-row]').forEach(row=>{const selected=Boolean(row.querySelector('[data-correction-remove]')?.checked),status=row.querySelector('[data-correction-disposition]');row.classList.toggle('shipment-correction-removed',selected);if(status){status.hidden=!selected;status.disabled=!selected;}});
  form.querySelectorAll('.shipment-correction-preview-added').forEach(row=>row.remove());
  stockPreview?.querySelectorAll('.shipment-correction-stock-return').forEach(row=>row.remove());
  const added=[...form.querySelectorAll('[data-correction-add]:checked')];
  const returning=removed.filter(box=>box.closest('tr')?.querySelector('[data-correction-disposition]')?.value==='returned');
  if(stockPreview){
   if(returning.length)stockPreview.querySelector('[data-correction-stock-empty]')?.remove();
   const firstAvailableRow=stockPreview.querySelector('[data-correction-add]')?.closest('tr')||null;
   returning.forEach(box=>{
    const sourceRow=box.closest('tr'),row=document.createElement('tr');row.className='shipment-correction-stock-return';
    const values=['↩','—',sourceRow?.cells[2]?.textContent?.trim()||'',sourceRow?.cells[3]?.textContent?.trim()||'',sourceRow?.cells[4]?.textContent?.trim()||'',sourceRow?.cells[5]?.textContent?.trim()||'—',box.dataset.productionDate||'—'];
    values.forEach((value,index)=>{const cell=document.createElement('td');cell.textContent=value;if(index===0){cell.title='Potencjalnie wraca do stanu';cell.setAttribute('aria-label','Potencjalnie wraca do stanu');}if(index===6){const note=document.createElement('small');note.className='shipment-correction-return-note';note.textContent='Potencjalnie wraca do stanu';cell.append(note);}row.append(cell);});stockPreview.insertBefore(row,firstAvailableRow);
   });
   if(!stockPreview.querySelector('[data-correction-add]')&&!stockPreview.querySelector('.shipment-correction-stock-return')&&!stockPreview.querySelector('[data-correction-stock-empty]')){const row=document.createElement('tr');row.dataset.correctionStockEmpty='';const cell=document.createElement('td');cell.colSpan=7;cell.textContent='Brak dostępnych belek tego artykułu.';row.append(cell);stockPreview.append(row);}
  }
  if(preview){
   added.forEach((box,index)=>{
    const row=document.createElement('tr');row.className='shipment-correction-preview-added';
    const values=['Dodana',String(Math.max(0,preview.querySelectorAll('[data-correction-current-row]').length-removed.length)+index+1),box.dataset.baleNumber||'',box.dataset.weight||'',box.dataset.meters||'',box.dataset.lot||'—','Wybrana do dodania do specyfikacji wysyłkowej'];
    values.forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell);});preview.append(row);
   });
  }
  if(count)count.textContent=String(Math.max(0,(preview?.querySelectorAll('[data-correction-current-row]').length||0)-removed.length+added.length));
 };
 form.addEventListener('change',event=>{if(event.target.matches('[data-correction-remove],[data-correction-add],[data-correction-disposition]'))updatePreview();});
 form.addEventListener('submit',event=>{
  const removed=[...form.querySelectorAll('[data-correction-remove]:checked')].map(box=>({id:box.value,disposition:box.closest('tr')?.querySelector('[data-correction-disposition]')?.value||'returned'}));
  const added=[...form.querySelectorAll('[data-correction-add]:checked')].map(box=>box.value);
  if(!removed.length&&!added.length){event.preventDefault();alert('Zaznacz przynajmniej jedną belkę do usunięcia lub dodania.');return;}
  form.querySelector('[name="removed_items"]').value=JSON.stringify(removed);
  form.querySelector('[data-correction-added-values]').value=added.join(',');
  const popupName=form.target,width=Math.min(1180,Math.max(800,screen.availWidth-80)),height=Math.min(820,Math.max(600,screen.availHeight-80));
  const left=Math.max(0,Math.round((screen.availWidth-width)/2)),top=Math.max(0,Math.round((screen.availHeight-height)/2));
  const popup=window.open('about:blank',popupName,`popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`);
  if(popup)popup.focus();
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
  try{const spec=form.querySelector('input[name="specification_id"]')?.value||'',article=form.querySelector('input[name="article_id"]')?.value||'',plant=form.querySelector('select[name="plant_id"]')?.value||'',status=form.querySelector('input[name="status"]')?.value||'';const response=await fetch(`${form.action}?partial=search&q=${encodeURIComponent(q)}${spec?`&specification_id=${encodeURIComponent(spec)}`:''}${article?`&article_id=${encodeURIComponent(article)}`:''}${plant&&plant!=='0'?`&plant_id=${encodeURIComponent(plant)}`:''}${status?`&status=${encodeURIComponent(status)}`:''}`,{headers:{'X-Requested-With':'fetch'},signal:controller.signal});if(!response.ok)throw new Error();results.innerHTML=await response.text();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded',String(Boolean(options().length)));}
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
 form.querySelector('select[name="plant_id"]')?.addEventListener('change',()=>{activeIndex=-1;clearTimeout(timer);search();});
 form.addEventListener('submit',event=>{event.preventDefault();clearTimeout(timer);search();});
 document.addEventListener('click',event=>{if(!form.contains(event.target)){clearTimeout(timer);controller?.abort();results.replaceChildren();activeIndex=-1;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');}});
});
document.querySelectorAll('[data-finishing-recipe-library]').forEach(library=>{
 const searchInput=document.querySelector('#finishing-recipe-search'),rows=[...library.querySelectorAll('[data-finishing-recipe-row]')],empty=library.querySelector('[data-finishing-recipe-empty]');
 if(!searchInput)return;
 const normalize=value=>String(value||'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 const filter=()=>{
  const terms=normalize(searchInput.value).trim().split(/\s+/).filter(Boolean);let visible=0;
  for(const row of rows){const haystack=normalize(row.dataset.recipeSearch);const matches=terms.every(term=>haystack.includes(term));row.hidden=!matches;if(matches)visible++;}
  empty.hidden=visible>0;
 };
 searchInput.addEventListener('input',filter);filter();
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
    list('[data-import-existing]',[`Receptury wykańczania: ${existing.finishing_recipes}`,`Zlecenia wykańczania: ${existing.finishing_orders}`,`Partie: ${existing.finishing_batches}`,`Przyjęcia: ${existing.finishing_receipts}`]);
    list('[data-import-incoming]',[`Receptury: ${incoming.finishing_recipes}`,`Zlecenia wykańczania: ${incoming.finishing_orders}`,`Partie wykańczalnicze: ${incoming.finishing_batches}`,`Przyjęcia: ${incoming.finishing_receipts}`,`Wiersze belek z indywidualnymi metrami i kg: ${incoming.returned_bales}`]);
    list('[data-import-archive]',[]);list('[data-import-preserved]',report.preserved);archiveSection.hidden=true;
    document.querySelector('[data-import-ai-notice]').textContent=report.ai_notice;
    const conflictBox=document.querySelector('[data-import-conflict-box]'),conflicts=document.querySelector('[data-import-conflicts]');conflicts.replaceChildren();for(const conflict of report.conflicts){const item=document.createElement('li');item.textContent=[conflict.symbol,conflict.message].filter(Boolean).join(': ');conflicts.appendChild(item);}conflictBox.hidden=report.conflicts.length===0;
    document.querySelector('[data-import-info]').textContent='Import nie dopisze kosztów ani powiązań zwróconych belek z konkretnymi belkami surowymi. Sumy metrów i kg pozostają sumami; bez danych kg dla każdej belki nie powstaną etykiety z wymyśloną wagą.';
    confirmation.textContent='Rozumiem, że import doda wskazane receptury i historyczne zlecenia wykańczania. Program zrobi kopię bazy przed zapisem.';
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
const finishingCalculationUpload=document.querySelector('form[data-finishing-calculation-upload]');
if(finishingCalculationUpload){
 const fileInput=finishingCalculationUpload.querySelector('[data-finishing-calculation-file]'),status=finishingCalculationUpload.querySelector('[data-finishing-calculation-upload-status]'),button=finishingCalculationUpload.querySelector('[data-finishing-calculation-upload-button]');
 finishingCalculationUpload.addEventListener('submit',async event=>{
  event.preventDefault();const file=fileInput.files?.[0];if(!file)return;
  if(file.size>25*1024*1024){status.textContent='Plik przekracza limit 25 MB.';return;}
  button.disabled=true;status.textContent='Wczytuję ceny i sprawdzam arkusz…';
  try{
   const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(offset+32768,bytes.length)));
   const response=await fetch('/finishing/calculations/import',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':finishingCalculationUpload.dataset.csrf},body:JSON.stringify({name:file.name,calculation_date:finishingCalculationUpload.elements.calculation_date?.value||'',file_base64:btoa(binary)})});
   const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Nie udało się wczytać kalkulacji.');
   status.textContent=`Wczytano ${result.imported.item_count} symboli z arkusza ${result.imported.sheet}.`;location.reload();
  }catch(error){status.textContent=error.message;}
  finally{button.disabled=false;}
 });
}
const settlementFormFor=element=>element?.closest('[data-finishing-settlement-form]')||document.getElementById(element?.getAttribute?.('form')||'');
const updateSettlementSelection=form=>{
 if(!form)return;const all=document.querySelector('[data-finishing-settlement-all]'),hiddenIds=form.querySelector('[data-finishing-settlement-ids]'),selection=form.querySelector('[data-finishing-settlement-selection]'),checks=[...document.querySelectorAll('[data-finishing-settlement-select]:not(:disabled)')],selected=checks.filter(input=>input.checked);
 if(hiddenIds)hiddenIds.value=selected.map(input=>input.value).join(',');if(selection)selection.textContent=selected.length?`Wybrano ${selected.length} zleceń barwiarskich.`:'Wybierz zlecenia barwiarskie.';if(all){all.checked=checks.length>0&&selected.length===checks.length;all.indeterminate=selected.length>0&&selected.length<checks.length;}
};
document.addEventListener('change',event=>{
 if(event.target.matches('[data-finishing-settlement-all]')){const form=settlementFormFor(event.target);document.querySelectorAll('[data-finishing-settlement-select]:not(:disabled)').forEach(input=>input.checked=event.target.checked);updateSettlementSelection(form);}
 else if(event.target.matches('[data-finishing-settlement-select]'))updateSettlementSelection(settlementFormFor(event.target));
});
document.addEventListener('submit',event=>{
 const form=event.target.closest('[data-finishing-settlement-form]');if(!form)return;updateSettlementSelection(form);
 if(!form.querySelector('[data-finishing-settlement-ids]')?.value){event.preventDefault();const selection=form.querySelector('[data-finishing-settlement-selection]');selection?.classList.add('is-error');selection?.focus?.();}
});
const recalculateSettlementRow=row=>{
 const controls={used:row.querySelector('input[name^="used_"]'),price:row.querySelector('input[name^="price_"]'),theoretical:row.querySelector('input[name^="theoretical_"]'),finishing:row.querySelector('input[name^="finishing_"]')},actual=row.querySelector('[data-live-actual]'),theory=row.querySelector('[data-live-theoretical]'),delta=row.querySelector('[data-live-delta]'),qty=Number(row.dataset.outputQuantity),unit=row.dataset.outputUnit;
 if(!actual||!theory||!delta)return;
 const format=value=>new Intl.NumberFormat('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
 const recalculate=()=>{
  const values=Object.fromEntries(Object.entries(controls).map(([key,input])=>[key,input?.value.trim()===''?null:Number(String(input?.value||'').replace(',','.'))]));
  if(!(qty>0)||Object.values(values).some(value=>value===null||!Number.isFinite(value))){actual.textContent='—';theory.textContent='';delta.textContent='';return;}
  const actualCost=(values.used*(values.price+values.finishing))/qty,theoreticalCost=(values.used*(values.theoretical+values.finishing))/qty;
  actual.textContent=`${format(actualCost)} zł/${unit}`;theory.textContent=`Teoria ${format(theoreticalCost)} zł/${unit}`;
  const previous=String(row.dataset.previousActual||'').trim()===''?NaN:Number(row.dataset.previousActual);delta.textContent=Number.isFinite(previous)?`Różnica: ${format(actualCost-previous)} zł/${unit}`:'';
 };
 recalculate();
};
document.querySelectorAll('[data-settlement-row]').forEach(recalculateSettlementRow);
document.addEventListener('input',event=>{const row=event.target.closest('[data-settlement-row]');if(row&&event.target.matches('input[name^="used_"],input[name^="price_"],input[name^="theoretical_"],input[name^="finishing_"]'))recalculateSettlementRow(row);});
document.addEventListener('keydown',event=>{if(event.target.matches('input[type="number"]')&&(event.key==='ArrowUp'||event.key==='ArrowDown'))event.preventDefault();});
document.addEventListener('wheel',event=>{if(event.target.matches('input[type="number"]')&&document.activeElement===event.target)event.target.blur();},{passive:true});
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
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-open-dialog]');if(!button)return;
 const dialog=document.getElementById(button.dataset.openDialog);
 if(!dialog)return;
 if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
});
document.querySelectorAll('dialog[data-draggable-dialog]').forEach(dialog=>{
 const handle=dialog.querySelector('[data-dialog-drag-handle]');if(!handle)return;
 let drag=null;
 handle.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.target.closest('button,input,a,label'))return;
  const rect=dialog.getBoundingClientRect();
  dialog.style.position='fixed';dialog.style.inset='auto';dialog.style.margin='0';dialog.style.left=`${rect.left}px`;dialog.style.top=`${rect.top}px`;
  drag={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
  try{handle.setPointerCapture(event.pointerId)}catch{}
 });
 handle.addEventListener('pointermove',event=>{
  if(!drag)return;
  const left=Math.max(0,Math.min(window.innerWidth-dialog.offsetWidth,drag.left+event.clientX-drag.x));
  const top=Math.max(0,Math.min(window.innerHeight-dialog.offsetHeight,drag.top+event.clientY-drag.y));
  dialog.style.left=`${left}px`;dialog.style.top=`${top}px`;
 });
 const stop=()=>{drag=null;};handle.addEventListener('pointerup',stop);handle.addEventListener('pointercancel',stop);
});
document.querySelectorAll('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog')?.close()));
document.querySelectorAll('[data-finishing-receive-form]').forEach(form=>{
 const entryInput=form.querySelector('[data-receipt-entry-input]'),entryPrompt=form.querySelector('[data-receipt-entry-prompt]'),entryCount=form.querySelector('[data-receipt-entry-count]'),entryStatus=form.querySelector('[data-receipt-entry-status]'),modeInputs=[...form.querySelectorAll('[data-receipt-mode]')],baleList=form.querySelector('[data-receipt-bale-list]'),printLabelsButton=form.querySelector('[data-receipt-print-labels]'),measureMeters=form.querySelector('[data-receipt-measure-meters]'),measureWeight=form.querySelector('[data-receipt-measure-weight]'),metersList=form.querySelector('[data-receipt-meters-list]'),weightsList=form.querySelector('[data-receipt-weights-list]'),rawPieces=form.elements.raw_pieces_received,receivedWeightInput=form.elements.finished_weight_kg,weightOverride=form.elements.finished_weight_override;
 form.querySelectorAll('input[type="number"]').forEach(input=>{
  input.addEventListener('keydown',event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown')event.preventDefault();});
  input.addEventListener('wheel',()=>{if(document.activeElement===input)input.blur();},{passive:true});
 });
 const bales=[];let pendingMeters=null,pendingCount=1;
 const parsePositive=value=>{const normalized=String(value??'').trim().replace(',','.');if(!/^\d+(?:\.\d+)?$/.test(normalized))return null;const parsed=Number(normalized);return Number.isFinite(parsed)&&parsed>0?parsed:null;};
 const parseCount=value=>{const normalized=String(value??'').trim();if(!/^\d{1,3}$/.test(normalized))return null;const parsed=Number(normalized);return Number.isInteger(parsed)&&parsed>0&&parsed<=999?parsed:null;};
 const fmt=value=>new Intl.NumberFormat('pl-PL',{maximumFractionDigits:2}).format(value);
 const mode=()=>form.querySelector('[data-receipt-mode]:checked')?.value||'meters';
 const usesMeters=()=>mode()!=='weight',usesWeight=()=>mode()!=='meters';
 const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const updateEntryPrompt=()=>{const unit=mode()==='weight'?'kg':mode()==='both'&&pendingMeters!==null?'kg':'metry (mb)';entryPrompt.textContent=`Sztuka ${bales.length+1} — ${unit}`;};
 const updateModeLock=()=>modeInputs.forEach(input=>{input.disabled=bales.length>0||pendingMeters!==null;});
 const rowHtml=(bale,index)=>`<div class="finishing-receive-bale-row" data-receipt-bale-row><span class="finishing-receive-bale-index">${index+1}</span>${usesMeters()?`<label><span>mb</span><input type="text" inputmode="decimal" maxlength="5" autocomplete="off" data-receipt-meter aria-label="Metry sztuki ${index+1}" value="${escapeHtml(bale.meters)}"></label>`:''}${usesWeight()?`<label><span>kg</span><input type="text" inputmode="decimal" maxlength="5" autocomplete="off" data-receipt-weight aria-label="Masa sztuki ${index+1}" value="${escapeHtml(bale.weight)}"></label>`:''}<button type="button" class="finishing-receive-remove" data-receipt-remove aria-label="Usuń sztukę ${index+1}" title="Usuń sztukę">×</button></div>`;
 const renderBales=()=>{baleList.innerHTML=bales.map(rowHtml).join('');baleList.querySelectorAll('[data-receipt-meter],[data-receipt-weight]').forEach(input=>{input.addEventListener('input',()=>{const row=input.closest('[data-receipt-bale-row]'),index=[...baleList.children].indexOf(row),key=input.hasAttribute('data-receipt-meter')?'meters':'weight';bales[index][key]=input.value.slice(0,5);if(input.value.length>5)input.value=input.value.slice(0,5);if(key==='weight')weightOverride.value='0';refresh();});input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();entryInput.focus();}});});baleList.querySelectorAll('[data-receipt-remove]').forEach(button=>button.addEventListener('click',()=>{const index=[...baleList.children].indexOf(button.closest('[data-receipt-bale-row]'));bales.splice(index,1);renderBales();refresh();}));updateModeLock();updateEntryPrompt();};
 const paramRows=[...form.querySelectorAll('[data-finishing-param-row]')];
 const refreshParamRows=()=>paramRows.forEach(row=>{
  const input=row.querySelector('input'),status=row.querySelector('[data-param-status]'),actual=Number(String(input.value||'').trim().replace(',','.')),target=Number(row.dataset.paramTarget),minusRaw=row.dataset.paramMinus,plusRaw=row.dataset.paramPlus;
  status.className='finishing-receive-param-status';status.textContent='';
  if(!input.value.trim()||!Number.isFinite(actual)||actual<=0||!Number.isFinite(target)||target<=0)return;
  const minus=minusRaw===''?0:Number(minusRaw),plus=plusRaw===''?0:Number(plusRaw),min=target-minus,max=target+plus;
  if(actual>=min&&actual<=max){status.textContent='W tolerancji';status.classList.add('is-ok');return;}
  const excess=actual<min?min-actual:actual-max,percentage=excess/target*100;
  status.textContent='Poza wymaganą tolerancją · '+fmt(percentage)+'%';
  status.classList.add('is-danger');
 });
 paramRows.forEach(row=>row.querySelector('input')?.addEventListener('input',refreshParamRows));
 const refresh=()=>{
  const useMeters=usesMeters(),useWeight=usesWeight();
  form.dataset.measureMeters=String(useMeters);form.dataset.measureWeight=String(useWeight);
  measureMeters.value=useMeters?'1':'0';measureWeight.value=useWeight?'1':'0';
  form.querySelector('[data-receipt-weight-difference]').hidden=!useWeight;
  const meterValues=bales.map(bale=>parsePositive(bale.meters)),weightValues=bales.map(bale=>parsePositive(bale.weight));
  metersList.value=meterValues.map(value=>value===null?'':String(value)).join('+');
  weightsList.value=weightValues.map(value=>value===null?'':String(value)).join('+');
  const meterTotal=meterValues.reduce((sum,value)=>sum+(value||0),0),weightTotal=weightValues.reduce((sum,value)=>sum+(value||0),0);
  form.querySelector('[data-receipt-total-meters]').textContent=meterValues.some(value=>value!==null)?fmt(meterTotal)+' mb':'—';
  const weightsComplete=weightValues.length>0&&weightValues.every(value=>value!==null);
  if(useWeight&&weightsComplete&&weightOverride.value!=='1'){receivedWeightInput.value=String(Math.round(weightTotal*100)/100);weightOverride.value='0';}
  const typedWeight=String(receivedWeightInput.value||'').trim().replace(',','.');
  const receivedKg=typedWeight!==''&&Number.isFinite(Number(typedWeight))?Number(typedWeight):useWeight&&weightsComplete?weightTotal:null;
  const weightDifference=form.querySelector('[data-receipt-weight-difference-value]');
  if(receivedKg===null)weightDifference.textContent='—';
  else{const difference=Number(form.dataset.rawWeight)-receivedKg;weightDifference.textContent=difference>0.005?'Strata '+fmt(difference)+' kg':difference< -0.005?'Zysk '+fmt(Math.abs(difference))+' kg':'0 kg · bez straty';}
  const planGrammage=Number(form.dataset.planGrammage),planWidth=Number(form.dataset.planWidth),rawWeight=Number(form.dataset.rawWeight),sentPieces=Number(form.dataset.sentPieces),returned=Number(rawPieces.value);
  const expected=planGrammage>0&&planWidth>0&&rawWeight>0&&sentPieces>0&&returned>=0?rawWeight*Math.min(returned/sentPieces,1)*100000/(planGrammage*planWidth):0;
  const theory=form.querySelector('[data-receipt-theoretical]'),loss=form.querySelector('[data-receipt-loss]'),note=form.querySelector('[data-receipt-calculation-note]');
  theory.textContent=expected?new Intl.NumberFormat('pl-PL',{maximumFractionDigits:0}).format(Math.round(expected))+' mb':'—';
  if(!expected){loss.textContent='—';note.textContent='Do wyliczenia potrzebne są planowana gramatura, planowana szerokość i liczba odebranych sztuk surowych.';}
  else if(!useMeters||!meterValues.length){loss.textContent='—';note.textContent='Wybierz tryb mb, aby porównać uzyskaną długość z wartością teoretyczną.';}
  else{const percentage=(expected-meterTotal)/expected*100;loss.textContent=percentage>0.005?'Strata '+fmt(percentage)+'%':percentage< -0.005?'Zysk '+fmt(Math.abs(percentage))+'%':'0% · bez straty';note.textContent='Porównanie uzyskanych metrów z długością teoretyczną dla odebranych sztuk.';}
  const receivedForClose=receivedKg===null?null:receivedKg,previousPieces=Number(form.dataset.previousReceivedPieces),previousWeight=Number(form.dataset.previousReceivedWeight);
  const closesByMatch=sentPieces>0&&Number.isFinite(returned)&&previousPieces+returned===sentPieces&&rawWeight>0&&receivedForClose!==null&&Math.abs(previousWeight+receivedForClose-rawWeight)<=0.01;
  form.querySelector('[data-receipt-auto-close-message]').hidden=!closesByMatch;
  const incomplete=bales.some(bale=>(useMeters&&parsePositive(bale.meters)===null)||(useWeight&&parsePositive(bale.weight)===null));
  form.querySelector('button[type="submit"]').disabled=bales.length===0||pendingMeters!==null||incomplete;
  printLabelsButton.disabled=bales.length===0||pendingMeters!==null||incomplete;
 };
 entryCount.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();entryInput.focus();}});
 const rawGrammage=form.elements.actual_grammage,rawWidth=form.elements.actual_width_cm;
 receivedWeightInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();rawPieces.focus();}});
 rawPieces.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();entryInput.focus();}});
 rawGrammage?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();rawWidth?.focus();}});
 rawWidth?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();entryInput.focus();}});
 modeInputs.forEach(input=>input.addEventListener('change',()=>{bales.splice(0,bales.length);pendingMeters=null;pendingCount=1;entryInput.value='';entryCount.value='1';entryStatus.textContent='';receivedWeightInput.value='';weightOverride.value='0';renderBales();refresh();entryInput.focus();}));
 entryInput.addEventListener('input',()=>{entryStatus.textContent='';});
 entryInput.addEventListener('keydown',event=>{
  if(event.key!=='Enter')return;
  event.preventDefault();
  const value=parsePositive(entryInput.value);
  if(value===null){entryStatus.textContent='Wpisz liczbę większą od zera.';entryInput.focus();return;}
  const count=parseCount(entryCount.value);
  if(count===null){entryStatus.textContent='Wpisz liczbę jednakowych sztuk od 1 do 999.';entryCount.focus();return;}
  entryInput.value='';
  if(mode()==='both'&&pendingMeters===null){pendingMeters=value;pendingCount=count;entryCount.disabled=true;entryStatus.textContent=`Metry zapisane. Teraz wpisz kg dla ${count} ${count===1?'sztuki':'sztuk'}.`;updateEntryPrompt();entryInput.focus();return;}
  const repeat=mode()==='both'?pendingCount:count;
  for(let index=0;index<repeat;index++){
   if(mode()==='both')bales.push({meters:pendingMeters,weight:value});
   else if(mode()==='meters')bales.push({meters:value,weight:null});
   else bales.push({meters:null,weight:value});
  }
  pendingMeters=null;pendingCount=1;entryCount.value='1';entryCount.disabled=false;
  entryStatus.textContent=`Dodano ${repeat} ${repeat===1?'sztukę':'sztuk'} o tej samej wartości.`;renderBales();refresh();entryInput.focus();
  if(mode()==='meters'&&bales.length===repeat)rawGrammage?.focus();
 });
 rawPieces.addEventListener('input',refresh);
 receivedWeightInput.addEventListener('input',()=>{weightOverride.value='1';refresh();});
 printLabelsButton.addEventListener('click',()=>{
  if(!bales.length)return;
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const actualWidth=String(form.elements.actual_width_cm.value||'').trim()||form.dataset.planWidth||'—';
  const actualGrammage=String(form.elements.actual_grammage.value||'').trim()||form.dataset.planGrammage||'—';
  const symbol=form.dataset.tradeSymbol||form.dataset.rawSymbol||'—',color=form.dataset.targetColor||'—',orderNumber=form.dataset.orderNumber||'—';
  const labels=bales.map((bale,index)=>`<article class="label"><strong class="symbol">${esc(symbol)}</strong><div><b>Kolor:</b> ${esc(color)}</div><div><b>Nr zlecenia:</b> ${esc(orderNumber)}</div><div><b>Szerokość:</b> ${esc(actualWidth)} cm</div><div><b>Gramatura:</b> ${esc(actualGrammage)} g/m²</div><div class="qty"><b>Ilość mb:</b> ${bale.meters===null?'—':esc(fmt(bale.meters))}</div>${usesWeight()?`<div class="qty"><b>Waga kg:</b> ${esc(fmt(bale.weight))}</div>`:''}<small>${index+1}/${bales.length}</small></article>`).join('');
  const printWindow=window.open('','_blank','width=700,height=900');
  if(!printWindow){alert('Przeglądarka zablokowała okno etykiet. Zezwól na wyskakujące okna i spróbuj ponownie.');return;}
  printWindow.onload=()=>{printWindow.focus();printWindow.print();};
  printWindow.document.open();printWindow.document.write(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Etykiety ${esc(orderNumber)}</title><style>@page{size:50mm 74mm;margin:0}*{box-sizing:border-box}body{margin:0;font:10pt/1.22 Arial,sans-serif;color:#111}.label{width:50mm;height:74mm;padding:4mm 3.5mm;overflow:hidden;page-break-after:always;break-after:page;border:1px solid #bbb;position:relative}.symbol{display:block;font-size:15pt;text-align:center;margin:0 0 3mm}.label>div{margin:1.6mm 0}.qty{font-size:13pt;font-weight:700;margin-top:3mm!important}.label small{position:absolute;bottom:2mm;right:3mm;font-size:7pt}@media print{.label{border:0}}</style></head><body>${labels}</body></html>`);printWindow.document.close();
 });
 form.addEventListener('submit',event=>{
  refresh();
  if(pendingMeters!==null){event.preventDefault();entryStatus.textContent='Wpisz kg dla rozpoczętej sztuki.';entryInput.focus();return;}
  const useMeters=usesMeters(),useWeight=usesWeight(),incompleteIndex=bales.findIndex(bale=>(useMeters&&parsePositive(bale.meters)===null)||(useWeight&&parsePositive(bale.weight)===null));
  if(!bales.length||incompleteIndex!==-1){event.preventDefault();entryStatus.textContent='Uzupełnij brakującą wartość sztuki '+(incompleteIndex+1)+'.';entryInput.focus();return;}
 });
 form.closest('dialog')?.addEventListener('close',()=>{
  form.reset();bales.splice(0,bales.length);pendingMeters=null;pendingCount=1;entryCount.disabled=false;entryStatus.textContent='';
  renderBales();refreshParamRows();refresh();
 });
 renderBales();refresh();refreshParamRows();
});document.querySelectorAll('[data-show-modal]').forEach(dialog=>{
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
 const updateBoldState=()=>{const selection=window.getSelection();if(selection?.rangeCount&&content.contains(selection.anchorNode))bold?.setAttribute('aria-pressed',String(document.queryCommandState('bold')));};
 content.addEventListener('keyup',()=>{captureSelection();updateBoldState();});content.addEventListener('mouseup',()=>{captureSelection();updateBoldState();});content.addEventListener('input',()=>{sync();updateBoldState();});
 document.addEventListener('selectionchange',()=>{captureSelection();updateBoldState();});
 form?.addEventListener('submit',sync);
 bold?.addEventListener('mousedown',event=>event.preventDefault());
 bold?.addEventListener('click',()=>{restoreSelection();const selection=window.getSelection();if(selection?.rangeCount){document.execCommand('bold');sync();captureSelection();updateBoldState();}});
 size?.addEventListener('change',()=>{const fontSize=Number(size.value);restoreSelection();const selection=window.getSelection();if(!selection?.rangeCount||selection.getRangeAt(0).collapsed)return;const range=selection.getRangeAt(0);const span=document.createElement('span');span.dataset.instructionSize=String(fontSize);span.style.fontSize=`${fontSize}px`;span.appendChild(range.extractContents());range.insertNode(span);selection.removeAllRanges();const cursor=document.createRange();cursor.setStartAfter(span);cursor.collapse(true);selection.addRange(cursor);savedRange=cursor.cloneRange();sync();});
});
document.querySelectorAll('[data-finishing-notes-editor]').forEach(editor=>{
 const content=editor.querySelector('[data-finishing-notes-content]'),value=editor.querySelector('[data-finishing-notes-value]'),form=editor.closest('form');
 const bold=editor.querySelector('[data-finishing-notes-bold]'),underline=editor.querySelector('[data-finishing-notes-underline]'),italic=editor.querySelector('[data-finishing-notes-italic]'),size=editor.querySelector('[data-finishing-notes-size]');
 if(!content||!value)return;
 const allowedSizes=[14,16,18,20,24,28];let savedRange=null;
 const noteText=value=>{
  if(typeof value==='string'||typeof value==='number')return String(value).replace(/\[object Object\]/g,'');
  if(Array.isArray(value))return value.map(noteText).join('');
  if(value&&typeof value==='object'){
   if(typeof value.text==='string')return noteText(value.text);
   if(typeof value.value==='string')return noteText(value.value);
   if(Array.isArray(value.runs))return value.runs.map(run=>noteText(run?.text??run)).join('');
  }
  return '';
 };
 const captureSelection=()=>{const selection=window.getSelection();if(selection?.rangeCount&&content.contains(selection.anchorNode))savedRange=selection.getRangeAt(0).cloneRange();};
 const restoreSelection=()=>{content.focus();if(savedRange){const selection=window.getSelection();selection.removeAllRanges();selection.addRange(savedRange);}};
 const runs=[];
 const append=(text,state)=>{if(!text)return;const last=runs[runs.length-1];if(last&&last.bold===state.bold&&last.underline===state.underline&&last.italic===state.italic&&last.size===state.size)last.text+=text;else runs.push({text,bold:state.bold,underline:state.underline,italic:state.italic,size:state.size});};
 const walk=(node,state)=>{
  if(node.nodeType===Node.TEXT_NODE){append(node.nodeValue,{...state});return;}
  if(node.nodeType!==Node.ELEMENT_NODE)return;
  const tag=node.tagName.toLowerCase(),block=/^(div|p|li)$/.test(tag);
  if(block&&runs.length&&!runs[runs.length-1].text.endsWith('\n'))append('\n',{...state});
  const rawSize=parseInt(node.dataset.finishingNotesSize||node.style.fontSize,10);
  const decoration=node.style.textDecoration||'';
  const next={bold:state.bold||tag==='b'||tag==='strong'||node.style.fontWeight==='bold'||Number(node.style.fontWeight)>=600,underline:state.underline||tag==='u'||decoration.includes('underline'),italic:state.italic||tag==='i'||tag==='em'||node.style.fontStyle==='italic',size:allowedSizes.includes(rawSize)?rawSize:state.size};
  if(tag==='br')append('\n',next);else [...node.childNodes].forEach(child=>walk(child,next));
  if(block&&!runs[runs.length-1]?.text.endsWith('\n'))append('\n',{...state});
 };
 const sync=()=>{runs.length=0;[...content.childNodes].forEach(node=>walk(node,{bold:false,underline:false,italic:false,size:16}));while(runs.length&&runs[runs.length-1].text==='\n')runs.pop();value.value=JSON.stringify({format:'marand-finishing-notes-v1',runs});};
 const render=()=>{
  let data;try{data=JSON.parse(value.value);}catch{}
  const source=data?.format==='marand-finishing-notes-v1'&&Array.isArray(data.runs)?data.runs:[{text:value.value,bold:false,underline:false,italic:false,size:16}];
  content.replaceChildren();
  for(const run of source){const span=document.createElement('span'),fontSize=Number(run.size);if(allowedSizes.includes(fontSize)&&fontSize!==16)span.style.fontSize=`${fontSize}px`;let node=span;
   if(run.bold){const strong=document.createElement('strong');node.appendChild(strong);node=strong;}
   if(run.underline){const u=document.createElement('u');node.appendChild(u);node=u;}
   if(run.italic){const em=document.createElement('em');node.appendChild(em);node=em;}
   noteText(run.text).split('\n').forEach((line,index)=>{if(index)node.appendChild(document.createElement('br'));if(line)node.appendChild(document.createTextNode(line));});content.appendChild(span);
  }
 };
 const commands=[[bold,'bold'],[underline,'underline'],[italic,'italic']];
 const updateCommandStates=()=>{const selection=window.getSelection();if(!selection?.rangeCount||!content.contains(selection.anchorNode))return;for(const [button,command] of commands)button?.setAttribute('aria-pressed',String(document.queryCommandState(command)));};
 content.addEventListener('keyup',()=>{captureSelection();updateCommandStates();});content.addEventListener('mouseup',()=>{captureSelection();updateCommandStates();});content.addEventListener('input',()=>{sync();updateCommandStates();});document.addEventListener('selectionchange',()=>{captureSelection();updateCommandStates();});form?.addEventListener('submit',sync);
 value.addEventListener('input',render);
 const applyCommand=(button,command)=>{button?.addEventListener('mousedown',event=>event.preventDefault());button?.addEventListener('click',()=>{restoreSelection();const selection=window.getSelection();if(selection?.rangeCount){document.execCommand(command);sync();captureSelection();updateCommandStates();}});};
 applyCommand(bold,'bold');applyCommand(underline,'underline');applyCommand(italic,'italic');
 size?.addEventListener('mousedown',captureSelection);
 size?.addEventListener('change',()=>{const fontSize=Number(size.value);restoreSelection();const selection=window.getSelection();if(!allowedSizes.includes(fontSize)||!selection?.rangeCount||selection.getRangeAt(0).collapsed)return;const range=selection.getRangeAt(0),span=document.createElement('span');span.dataset.finishingNotesSize=String(fontSize);span.style.fontSize=`${fontSize}px`;span.appendChild(range.extractContents());range.insertNode(span);selection.removeAllRanges();const cursor=document.createRange();cursor.setStartAfter(span);cursor.collapse(true);selection.addRange(cursor);savedRange=cursor.cloneRange();sync();});
});
const gbList=document.querySelector('[data-gb-list]');
const gbRows=()=>gbList?[...gbList.querySelectorAll('[data-gb-index]')]:[];
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
  const yarnCode=event.target.closest('[data-yarn-code]');
  if(yarnCode){
    const picker=yarnCode.closest('[data-yarn-process-picker]');
    const input=picker?.querySelector('input[type="hidden"]');
    if(!input)return;
    const codes=[...picker.querySelectorAll('[data-yarn-code]')].map(button=>button.dataset.yarnCode);
    const tokens=input.value.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    const selected=new Set(tokens.filter(code=>codes.includes(code)));
    const extras=tokens.filter(code=>!codes.includes(code));
    const code=yarnCode.dataset.yarnCode;
    const group=code==='FDY'||code==='DTY'?['FDY','DTY']:['FD','SD','BR'];
    if(!selected.has(code)){group.forEach(item=>selected.delete(item));selected.add(code);}
    input.value=[...codes.filter(item=>selected.has(item)),...extras].join(' ');
    picker.querySelectorAll('[data-yarn-code]').forEach(button=>{
      const active=selected.has(button.dataset.yarnCode);
      button.setAttribute('aria-pressed',String(active));
      button.classList.toggle('selected',active);
    });
    dirty=true;
    return;
  }
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
  next.querySelectorAll('input,textarea').forEach(c=>{c.name=c.name.replace(/^gb_\d+_/,`gb_${rows.length}_`);c.value=c.type==='hidden'&&c.name.endsWith('_number')?String(number):'';c.classList.remove('inherited-value');});
  next.querySelectorAll('[data-yarn-code]').forEach(button=>{const active=button.dataset.yarnCode==='FDY'||button.dataset.yarnCode==='SD';button.setAttribute('aria-pressed',String(active));button.classList.toggle('selected',active);});
  const processInput=next.querySelector('input[name$="_yarn_process"]');if(processInput)processInput.value='FDY SD';
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
  const minimum=Number(liveSearch.dataset.liveSearchMin||0);
  for(const [key,value] of new FormData(liveSearch)){const text=String(value).trim();if(!text||key==='q'&&minimum>0&&text.length<minimum)continue;params.set(key,text);}
  const query=params.toString();return `${location.pathname}${query?`?${query}`:''}`;
 };
 const syncControls=url=>{
  const params=new URL(url,location.href).searchParams;
  const minimum=Number(liveSearch.dataset.liveSearchMin||0);
  for(const control of liveSearch.elements){if(!control.name)continue;if(params.has(control.name))control.value=params.get(control.name);else if(control.name==='q'&&minimum>0&&control.value.trim().length<minimum)continue;else if(control.type==='text'||control.type==='search'||control.type==='date')control.value='';}
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
  row.querySelector('[data-comment-time]').textContent=new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(comment.created_at));
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
