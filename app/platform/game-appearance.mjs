import { entryStorageKey } from '../entry-path.mjs';
import { initializeGameTheme, themeById, GAME_THEMES } from './game-theme.mjs';
import { APPEARANCE_MENU_HTML } from './appearance-menu-template.mjs';
import { COLOR_PALETTES, chooseColorPalette, currentColorPalette, safeAppearancePanelColors, APPEARANCE_STYLES, APPEARANCE_PRESETS, GLASS_BACKGROUNDS,
  createInitialAppearanceState, chooseDefaultAppearance, validateAppearanceState, chooseAppearance, choosePreset,
  updateAppearanceColors, chooseGlassBackground, contrastingForeground, contrastRatio } from './appearance-data.mjs';

// Device presentation only. Explicit consumers own their existing layout,
// controls and lifecycle; Sanguosha never enters this module's mount path.
export const APPEARANCE_STORAGE_KEY=entryStorageKey('game-room.appearance.v1');
export const APPEARANCE_SCOPES=Object.freeze(['rummikub','army-flip','flying-chess','draw-and-guess','poker414-2','hyakki-trading','parks','lobby','practice-hub','wordbank','catalog']);
const installed=new WeakMap(),pickers=new WeakMap(),menus=new WeakMap();
const clone=value=>structuredClone(value);
const errorText=result=>typeof result.error==='string'?result.error:result.error?.message||'无法采用这份外观。';
const variables=['bg','surface','panel','functional-surface','functional-line','input','accent','on-accent','ink','muted','line','shadow','inset','blur','radius','environment','saturation','duration','easing','good','bad','scheme'];
const environmentBases=['#e5ebf1','#c4cedc','#f0f4f8','#f3efe7','#eeeee5','#f1eee3','#ecebe6','#dfdfdc'];
const mix=(a,b,amount)=>'#'+[0,2,4].map(i=>Math.round(parseInt(a.slice(1+i,3+i),16)*amount+parseInt(b.slice(1+i,3+i),16)*(1-amount)).toString(16).padStart(2,'0')).join('');
const readable=(a,b,background)=>contrastRatio(a,background)>=contrastRatio(b,background)?a:b;

export function appearancePaint(state,{opaque=false,reducedTransparency=false,reducedMotion=false}={}) {
  const checked=validateAppearanceState(state);if(!checked.ok)throw new TypeError(errorText(checked));
  state=checked.value;
  if(!state.activeStyle)return null;
  const style=state.activeStyle,set=state.sets[style],t=set.tokens;
  const glass=style==='glass',soft=style==='soft';
  const panel=glass?`color-mix(in srgb,${t.surface} ${opaque?96:Math.min(90,20+t.opacity*.65+t.protection*.35)}%,transparent)`:t.surface;
  const functional=glass?`color-mix(in srgb,${t.surface} ${reducedTransparency?97:opaque?96:Math.min(96,78+t.opacity*.07+t.protection*.07)}%,transparent)`:t.surface;
  const functionalLine=glass?`color-mix(in srgb,#fff ${t.highlight}%,#405b7620)`:`color-mix(in srgb,${t.ink} 17%,${t.surface})`;
  const input=glass?`color-mix(in srgb,${t.surface} ${opaque?97:Math.min(94,30+t.protection*.55)}%,transparent)`:`color-mix(in srgb,${t.surface} 96%,${t.ink})`;
  const bg=glass?environmentBases[t.background]:soft?t.surface:mix(t.surface,t.ink,.94);
  const shadow=glass?`inset 0 1px 0 #ffffff${Math.round(t.highlight*.55/100*255).toString(16).padStart(2,'0')},0 ${t.shadow*.14}px ${t.shadow*.72}px #304c6614`:
    soft?`8px 8px 22px color-mix(in srgb,${t.surface} 82%,${t.ink}),-8px -8px 22px color-mix(in srgb,${t.surface} 28%,#ffffff)`:`0 1px 2px color-mix(in srgb,${t.ink} 5%,transparent),0 12px 36px color-mix(in srgb,${t.ink} 4%,transparent)`;
  return {style,setId:set.id,meta:bg,values:{bg,surface:t.surface,panel,'functional-surface':functional,'functional-line':functionalLine,input,accent:t.accent,'on-accent':contrastingForeground(t.accent),ink:t.ink,muted:t.muted,
    line:`color-mix(in srgb,${t.ink} 17%,${t.surface})`,shadow,
    inset:soft?`inset 3px 3px 7px color-mix(in srgb,${t.surface} 82%,${t.ink}),inset -3px -3px 7px color-mix(in srgb,${t.surface} 28%,#ffffff)`:`inset 0 1px 2px color-mix(in srgb,${t.ink} 3%,transparent)`,
    blur:glass&&!opaque?t.blur+'px':'0px',radius:t.radius+'px',environment:glass?GLASS_BACKGROUNDS.find(b=>b.id===t.background).background:'none',
    saturation:glass?t.saturation+'%':'100%',duration:reducedMotion||t.motion===0?'0ms':t.duration+'ms',easing:['cubic-bezier(.2,0,.38,.9)','cubic-bezier(.16,1,.3,1)','linear'][t.easing],
    good:readable('#386541','#cce5c4',t.surface),bad:readable('#963b31','#ffd3bd',t.surface),scheme:contrastRatio('#ffffff',t.surface)>contrastRatio('#000000',t.surface)?'dark':'light'}};
}

export function initializeGameAppearance(documentRef,{scope}={}) {
  if(scope==='sanguosha')return null;
  if(!APPEARANCE_SCOPES.includes(scope))throw new TypeError('外观需要明确的已支持页面。');
  if(!documentRef?.documentElement?.style||!documentRef.defaultView)return null;
  if(installed.has(documentRef))return installed.get(documentRef);
  const root=documentRef.documentElement,win=documentRef.defaultView,subscribers=new Set(),removers=[];
  const initialMeta=documentRef.querySelector('meta[name="theme-color"]')?.getAttribute('content');
  let state=createInitialAppearanceState(),storage,issue='',destroyed=false,legacyConnected=false;
  function read(raw){
    // Old theme storage predates appearance selection. It remains available in
    // settings, but only an explicit appearance record can opt out of the default.
    if(raw===null)return createInitialAppearanceState();
    if(typeof raw!=='string'||raw.length>110000)throw Error('本机外观记录无法读取，保留当前外观。');
    let value;try{value=JSON.parse(raw);}catch{throw Error('本机外观记录无法读取，保留当前外观。');}
    const result=validateAppearanceState(value);if(!result.ok)throw Error('本机外观记录暂不支持，保留当前外观。');return result.value;
  }
  try{storage=win.localStorage;}catch{issue='本机设置暂不可用，外观仅在本次有效。';}
  if(storage){
    try{state=read(storage.getItem(APPEARANCE_STORAGE_KEY));}catch{issue='本机外观记录无法读取，保留可用外观。';}
  }
  const transparency=win.matchMedia?.('(prefers-reduced-transparency: reduce)'),motion=win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const supportsFilter=()=>Boolean(win.CSS?.supports?.('backdrop-filter','blur(1px)')||win.CSS?.supports?.('-webkit-backdrop-filter','blur(1px)'));
  function notify(){for(const callback of subscribers)callback(clone(state),issue);}
  function apply(){
    if(destroyed)return;
    const paint=appearancePaint(state,{opaque:transparency?.matches||!supportsFilter(),reducedTransparency:transparency?.matches,reducedMotion:motion?.matches});
    if(paint){
      root.dataset.gameAppearance=paint.style;root.dataset.appearance=paint.style;root.dataset.gameUiSet=paint.setId;
      root.style.setProperty('--glass-blur',paint.values.blur);
      root.dataset.appearanceFallback=paint.style==='glass'&&(transparency?.matches||!supportsFilter())?'opaque':'none';
      for(const [name,value]of Object.entries(paint.values))root.style.setProperty('--appearance-'+name,value);
      documentRef.querySelector('meta[name="theme-color"]')?.setAttribute('content',paint.meta);
    }else{
      delete root.dataset.gameAppearance;delete root.dataset.appearance;root.style.removeProperty('--glass-blur');delete root.dataset.gameUiSet;delete root.dataset.appearanceFallback;
      for(const name of variables)root.style.removeProperty('--appearance-'+name);
      const color=root.dataset.gameTheme?themeById(root.dataset.gameTheme).base:initialMeta;
      if(color)documentRef.querySelector('meta[name="theme-color"]')?.setAttribute('content',color);
    }
    notify();
  }
  function change(result){
    if(destroyed)throw Error('外观面板已关闭。');
    if(!result.ok){issue=errorText(result);notify();return result;}
    state=result.value;issue='';
    try{if(!storage)throw Error();storage.setItem(APPEARANCE_STORAGE_KEY,JSON.stringify(state));}
    catch{issue='无法保存到本机，本次外观仍有效。';}
    apply();return {ok:true,value:clone(state)};
  }
  function listen(target,type,callback,options){target?.addEventListener?.(type,callback,options);removers.push(()=>target?.removeEventListener?.(type,callback,options));}
  function connectLegacy(){
    if(destroyed||legacyConnected||!root.dataset.gameTheme)return;
    const legacy=initializeGameTheme(documentRef);if(!legacy)return;
    legacyConnected=true;removers.push(legacy.subscribe(()=>apply()));
  }
  const controller={state:()=>clone(state),issue:()=>issue,select:style=>change(chooseAppearance(state,style)),preset:id=>change(choosePreset(state,id)),colors:values=>change(updateAppearanceColors(state,values)),background:id=>change(chooseGlassBackground(state,id)),palette:id=>change(chooseColorPalette(state,id)),
    replace:value=>change(validateAppearanceState(value)),reset:()=>change({ok:true,value:createInitialAppearanceState()}),defaultPreset:()=>change(chooseDefaultAppearance(state)),
    refresh(){connectLegacy();apply();},subscribe(callback){subscribers.add(callback);callback(clone(state),issue);return()=>subscribers.delete(callback);},
    destroy(){if(destroyed)return;destroyed=true;removers.forEach(remove=>remove());subscribers.clear();installed.delete(documentRef);}};
  installed.set(documentRef,controller);
  connectLegacy();
  listen(transparency,'change',apply);listen(motion,'change',apply);
  listen(documentRef,'click',event=>{if(state.activeStyle&&event.target.closest?.('[data-theme-choice]'))controller.select(null);},{capture:true});
  listen(documentRef,'change',event=>{if(state.activeStyle&&event.target.matches?.('[data-catalog-theme],#catalog-theme'))controller.select(null);},{capture:true});
  listen(win,'storage',event=>{if(event.key!==APPEARANCE_STORAGE_KEY||event.storageArea!==storage)return;try{state=read(event.newValue);issue='';apply();}catch(error){issue=error.message;notify();}});
  listen(win,'pageshow',()=>apply());listen(win,'pagehide',event=>{if(!event.persisted)controller.destroy();});
  apply();return controller;
}

// Exactly one shared dialog per document. Settings factories lease entries;
// their teardown never transfers ownership of the original settings controls.
function createAppearanceMenu(documentRef,controller) {
  const template=documentRef.createElement('template');template.innerHTML=APPEARANCE_MENU_HTML;
  const dialog=template.content.firstElementChild;
  documentRef.body.append(dialog);
  const field=id=>dialog.querySelector('#appearance-'+id);
  const listeners=[];
  const listen=(target,type,callback)=>{target.addEventListener(type,callback);listeners.push(()=>target.removeEventListener(type,callback));};
  const make=(tag,text)=>{const node=documentRef.createElement(tag);if(text)node.textContent=text;return node;};
  const originalColors=()=>{
    const id=documentRef.documentElement.dataset.gameTheme;
    if(id){const t=themeById(id);return {accent:t.accent,ink:t.ink,muted:t.muted,surface:t.surface};}
    return {accent:'#315b50',ink:'#26362f',muted:'#7b8278',surface:'#f5f3ec'};
  };
  let opener=null,optionKey='',references=0;
  function editableState(){
    const state=controller.state();if(state.activeStyle)return state;
    const selected=chooseAppearance(state,'paper');
    return updateAppearanceColors(selected.value,originalColors()).value;
  }
  function applyEdit(operation){controller.replace(operation(editableState()));}
  for(const palette of COLOR_PALETTES){
    const label=make('label'),radio=make('input'),swatch=make('span');label.className='appearance-palette';
    radio.type='radio';radio.name='appearance-palette';radio.value=palette.id;
    swatch.className='appearance-palette-swatch';swatch.style.setProperty('--appearance-swatch',palette.accent);swatch.setAttribute('aria-hidden','true');
    label.append(radio,swatch,make('span',palette.name));field('palette-options').append(label);
    listen(radio,'change',()=>applyEdit(state=>chooseColorPalette(state,palette.id).value));
  }
  for(const background of GLASS_BACKGROUNDS){
    const label=make('label'),radio=make('input'),swatch=make('span');label.className='appearance-background';
    radio.type='radio';radio.name='appearance-background';radio.value=String(background.id);
    swatch.className='appearance-background-image';swatch.style.backgroundImage=background.background;swatch.setAttribute('aria-hidden','true');
    label.append(radio,swatch,make('span',background.label));field('background-options').append(label);
    listen(radio,'change',()=>controller.background(background.id));
  }
  function render(state,issue){
    const active=state.activeStyle,style=active||'paper';
    const set=active?state.sets[style]:{tokens:originalColors()};
    const safe=safeAppearancePanelColors(set.tokens);
    for(const [key,value]of Object.entries(safe))dialog.style.setProperty('--appearance-panel-'+key.replace('onAccent','on-accent'),value);
    for(const radio of dialog.querySelectorAll('[name="appearance-style"]'))radio.checked=radio.value===style;
    const legacyId=documentRef.documentElement.dataset.gameTheme;
    const nextKey=style+':'+Boolean(legacyId);
    const select=field('preset');
    if(nextKey!==optionKey){
      optionKey=nextKey;select.replaceChildren();
      const preferred=make('option','默认 · 柔感松绿');preferred.value='default';select.append(preferred);
      const original=make('option','棋牌室原样');original.value='original';select.append(original);
      for(const preset of APPEARANCE_PRESETS.filter(item=>item.styleId===style)){
        const option=make('option',preset.name);option.value=preset.id;select.append(option);
      }
      if(legacyId){
        const group=make('optgroup');group.label='原棋牌主题';
        for(const theme of GAME_THEMES){const option=make('option',theme.name);option.value='legacy:'+theme.id;group.append(option);}select.append(group);
      }
      const custom=make('option','自定义');custom.value='custom';custom.hidden=true;select.append(custom);
    }
    const preferred=active==='soft'&&state.presetIds.soft==='builtin-soft-quiet'&&JSON.stringify(set.tokens)===JSON.stringify(createInitialAppearanceState().sets.soft.tokens);
    select.value=preferred?'default':active?(state.presetIds[style]||'custom'):(legacyId?'legacy:'+legacyId:'original');
    const preset=active?APPEARANCE_PRESETS.find(item=>item.id===state.presetIds[style]):null;
    field('modified').hidden=preferred||!preset||JSON.stringify(preset.tokens)===JSON.stringify(set.tokens);
    const paletteId=active?currentColorPalette(state):null;
    for(const radio of dialog.querySelectorAll('[name="appearance-palette"]'))radio.checked=radio.value===paletteId;
    field('palette-name').textContent=COLOR_PALETTES.find(row=>row.id===paletteId)?.name||'当前自定义';
    for(const key of ['accent','ink','muted','surface']){field(key).value=set.tokens[key];field(key+'-value').textContent=set.tokens[key].toUpperCase();}
    field('contrast-note').hidden=!active||!['ink','muted','accent'].some(key=>safe[key].toLowerCase()!==set.tokens[key].toLowerCase());
    field('backgrounds').hidden=style!=='glass';
    for(const radio of dialog.querySelectorAll('[name="appearance-background"]'))radio.checked=active==='glass'&&Number(radio.value)===set.tokens.background;
    field('current').textContent=preferred?'默认 · 柔感松绿':active?APPEARANCE_STYLES.find(item=>item.id===style).label+' · '+(preset?.name||'自定义'):
      legacyId?'原棋牌主题 · '+themeById(legacyId).name:'棋牌室原样';
    field('status').textContent=issue||'仅保存在当前设备的浏览器，不修改账号资料。';
  }
  for(const radio of dialog.querySelectorAll('[name="appearance-style"]'))listen(radio,'change',()=>controller.select(radio.value));
  listen(field('preset'),'change',event=>{
    const id=event.target.value;
    if(id==='default'){controller.defaultPreset();return;}
    if(id==='original'){controller.select(null);return;}
    if(id.startsWith('legacy:')){initializeGameTheme(documentRef)?.set(id.slice(7));controller.select(null);return;}
    if(id==='custom')return;
    let state=controller.state();if(!state.activeStyle)state=chooseAppearance(state,'paper').value;
    controller.replace(choosePreset(state,id).value);
  });
  for(const key of ['accent','ink','muted','surface'])listen(field(key),'input',event=>applyEdit(state=>updateAppearanceColors(state,{[key]:event.target.value}).value));
  for(const button of dialog.querySelectorAll('[data-close-appearance]'))listen(button,'click',()=>dialog.close());
  listen(field('reset'),'click',()=>controller.reset());
  listen(dialog,'close',()=>{if(opener?.isConnected&&!opener.hidden)opener.focus({preventScroll:true});});
  const unsubscribe=controller.subscribe(render);
  const menu={dialog,
    acquire(){references++;},
    open(button,settingsDialog){
      const details=button.closest('details');
      opener=details?.querySelector('summary')||button;
      if(details)details.open=false;
      if(settingsDialog?.open){
        opener=[...documentRef.querySelectorAll('[aria-controls]')].find(node=>node.getAttribute('aria-controls')===settingsDialog.id)||button;
        settingsDialog.close();
      }
      render(controller.state(),controller.issue());
      if(!dialog.open)dialog.showModal();
    },
    release(){if(--references>0)return;unsubscribe();listeners.forEach(remove=>remove());if(dialog.open)dialog.close();dialog.remove();menus.delete(documentRef);controller.destroy();}
  };
  menus.set(documentRef,menu);return menu;
}

export function mountGameAppearanceEntry(documentRef,container,{scope,settingsDialog=null}={}){
  const controller=initializeGameAppearance(documentRef,{scope});
  if(!controller||!container?.append)return()=>{};
  controller.refresh();
  const menu=menus.get(documentRef)||createAppearanceMenu(documentRef,controller);menu.acquire();
  const button=documentRef.createElement('button');button.type='button';
  button.className='user-menu-item appearance-open';button.dataset.openAppearance='';
  button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls','appearance-dialog');
  button.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 1.4-3.4A1.5 1.5 0 0 1 16.5 15H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z"/><circle cx="7.5" cy="10" r=".6"/><circle cx="12" cy="6.5" r=".6"/><circle cx="16.5" cy="10" r=".6"/></svg><span><strong>外观</strong><small>纸感、玻璃与柔感</small></span>';
  container.append(button);
  const open=()=>menu.open(button,settingsDialog);button.addEventListener('click',open);
  let removed=false;return()=>{if(removed)return;removed=true;button.removeEventListener('click',open);button.remove();menu.release();};
}

export function mountGameAppearancePicker(documentRef,dialog,{scope}={}){
  if(scope==='sanguosha')return()=>{};
  if(!dialog?.querySelector||pickers.has(dialog))return()=>{};
  const old=dialog.querySelector('[data-theme-picker]'),wasHidden=old?.hidden;
  const removeEntry=mountGameAppearanceEntry(documentRef,dialog.querySelector('.game-settings-body')||dialog,{scope,settingsDialog:dialog});
  const note=old?.querySelector('.theme-note'),originalNote=note?.textContent;
  const entry=dialog.querySelector('[data-open-appearance]');
  if(old){
    old.hidden=false;
    if(entry)old.parentNode.insertBefore(entry,old);
  }
  // The existing picker still owns the six themes and their device key. Keep
  // the two presentations exclusive without discarding any material edits.
  const controller=installed.get(documentRef);
  const renderLegacy=state=>{
    const active=Boolean(state.activeStyle),id=documentRef.documentElement.dataset.gameTheme;
    if(note)note.textContent=active?'选择桌面主题会切回原棋牌画面；当前外观的材质与配色会保留。':`当前：${themeById(id).name}。只记住这台设备的选择，不影响其他玩家。`;
    for(const choice of old.querySelectorAll('[data-theme-choice]'))choice.setAttribute('aria-pressed',String(!active&&choice.dataset.themeChoice===id));
  };
  const unsubscribe=old&&controller?controller.subscribe(renderLegacy):()=>{};
  const unsubscribeLegacy=old&&controller?initializeGameTheme(documentRef).subscribe(()=>renderLegacy(controller.state())):()=>{};
  let removed=false;const remove=()=>{
    if(removed)return;removed=true;unsubscribe();unsubscribeLegacy();
    if(old){
      old.hidden=wasHidden;if(note)note.textContent=originalNote;
      for(const choice of old.querySelectorAll('[data-theme-choice]'))choice.setAttribute('aria-pressed',String(choice.dataset.themeChoice===documentRef.documentElement.dataset.gameTheme));
    }
    removeEntry();pickers.delete(dialog);
  };
  pickers.set(dialog,remove);return remove;
}
