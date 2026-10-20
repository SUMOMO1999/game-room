import { initializeGameAppearance, mountGameAppearanceEntry, mountGameAppearancePicker } from './game-appearance.mjs';

// Opt-in presentation only. Existing game factories own their dynamic settings;
// standalone documents lease the same menu through their established tools.
export function mountDocumentAppearance(documentRef) {
  const scope=documentRef?.body?.dataset.appearanceScope;
  if(!scope||scope==='sanguosha')return()=>{};
  const controller=initializeGameAppearance(documentRef,{scope});if(!controller)return()=>{};
  const removers=[];
  const dialogs=[...new Set([...documentRef.querySelectorAll('[data-theme-picker]')].map(section=>section.closest('dialog')).filter(Boolean))];
  for(const dialog of dialogs)removers.push(mountGameAppearancePicker(documentRef,dialog,{scope}));
  if(!dialogs.length&&['lobby','practice-hub','wordbank','catalog'].includes(scope)){
    const target=['[data-app-shell-menu]','.yousei-catalog__filters','.pk-catalog-tools','.wordbank-heading','.site-header']
      .map(selector=>documentRef.querySelector(selector)).find(Boolean);
    // Catalogs with dynamic game UI get their entry from the owning factory.
    if(target)removers.push(mountGameAppearanceEntry(documentRef,target,{scope}));
  }
  let removed=false;const destroy=event=>{if(event?.persisted||removed)return;removed=true;removers.forEach(remove=>remove());documentRef.defaultView.removeEventListener('pagehide',destroy);};
  documentRef.defaultView.addEventListener('pagehide',destroy);return destroy;
}
if(typeof document!=='undefined'&&document.body?.dataset.appearanceScope){
  initializeGameAppearance(document,{scope:document.body.dataset.appearanceScope});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>mountDocumentAppearance(document),{once:true});
  else mountDocumentAppearance(document);
}
