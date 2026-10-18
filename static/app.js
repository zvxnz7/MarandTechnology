'use strict';
let dirty=false,submitting=false;
document.querySelectorAll('form[data-dirty]').forEach(f=>{f.addEventListener('input',()=>dirty=true);f.addEventListener('submit',()=>{submitting=true;});});
window.addEventListener('beforeunload',e=>{if(dirty&&!submitting){e.preventDefault();e.returnValue='';}});
document.querySelectorAll('[data-print]').forEach(b=>b.addEventListener('click',()=>{
  const alert=document.querySelector('[data-update-alert]');
  if(alert && !window.confirm(alert.innerText+'\n\nCzy zapoznano się ze zmianami i kontynuować drukowanie?'))return;
  window.print();
}));
const addGB=document.querySelector('[data-add-gb]');
if(addGB)addGB.addEventListener('click',()=>{
  const list=document.querySelector('[data-gb-list]');const rows=[...list.querySelectorAll('[data-gb-index]')];
  if(rows.length>=12){alert('Maksymalnie 12 GB w jednym wpisie.');return;}
  const number=Math.max(...rows.map(r=>Number(r.dataset.gbNumber)))+1;
  if(number>32){alert('Osiągnięto maksymalne oznaczenie GB32.');return;}
  const next=rows[0].cloneNode(true);next.dataset.gbIndex=rows.length;next.dataset.gbNumber=number;next.querySelector('h3').textContent='GB'+number;
  next.querySelectorAll('input,textarea').forEach(c=>{c.name=c.name.replace(/^gb_\d+_/,`gb_${rows.length}_`);c.value=c.type==='hidden'?String(number):'';});
  list.appendChild(next);dirty=true;next.querySelector('input:not([type=hidden])').focus();
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
