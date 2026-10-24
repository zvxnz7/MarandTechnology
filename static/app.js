'use strict';
let dirty=false,submitting=false;
document.querySelectorAll('form[data-dirty]').forEach(f=>{f.addEventListener('input',()=>dirty=true);f.addEventListener('submit',()=>{submitting=true;});});
document.querySelectorAll('select[data-auto-submit]').forEach(select=>select.addEventListener('change',()=>select.form?.requestSubmit()));
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
   document.querySelector('[data-import-summary]').textContent=`Plik ${file.name} · ${report.package_sha256.slice(0,16)}…`;
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
  next.querySelectorAll('input,textarea').forEach(c=>{c.name=c.name.replace(/^gb_\d+_/,`gb_${rows.length}_`);c.value=c.type==='hidden'?String(number):'';c.classList.remove('inherited-value');});
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
const liveSearch=document.querySelector('form[data-live-search]');
if(liveSearch){
 let searchTimer=null,searchSequence=0;
 const results=document.querySelector('[data-live-results]'),count=document.querySelector('[data-live-count]');
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
   syncControls(url);history.replaceState({},'',url);
  }catch(error){if(sequence===searchSequence)location.assign(url);}
  finally{if(sequence===searchSequence)results.removeAttribute('aria-busy');}
 };
 const scheduleSearch=delay=>{clearTimeout(searchTimer);const sequence=++searchSequence;searchTimer=setTimeout(()=>loadResults(currentSearchUrl(),sequence),delay);};
 liveSearch.addEventListener('input',event=>{if(event.target.matches('input[name="q"]'))scheduleSearch(220);});
 liveSearch.addEventListener('change',event=>{if(!event.target.matches('input[name="q"]'))scheduleSearch(0);});
 liveSearch.addEventListener('submit',event=>{event.preventDefault();scheduleSearch(0);});
 document.addEventListener('click',event=>{
  const link=event.target.closest('[data-live-results] .pagination a');
  if(!link)return;
  event.preventDefault();clearTimeout(searchTimer);const sequence=++searchSequence;loadResults(link.href,sequence);
 });
}

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
