import { createObjectMotion } from '../../platform/object-motion.mjs';
import { GOODS } from './content/definitions.mjs';

/** Public economy feedback, independent of card flight, never an authority clock. */
export function mountMarketMotion({root}) {
  const document=root.ownerDocument,window=document.defaultView;
  const motion=createObjectMotion({root,maxObjects:12});
  const textEffects=new Set(),reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  function cancel(){motion.cancel();for(const effect of textEffects){effect.animation.cancel();effect.node.remove();}textEffects.clear();}
  function capture(){
    motion.cancel();
    return {bank:Object.fromEntries(GOODS.map(g=>[g.id,motion.capture(`[data-market-good="${g.id}"] .yousei-good-icon`)])),
      own:Object.fromEntries(GOODS.map(g=>[g.id,motion.capture(`#yg-stock-slots .yg-owned-good[title="${g.name}"] .yousei-good-icon`)])),
      peers:Object.fromEntries([...root.querySelectorAll('[data-public-player]')].map(node=>[node.dataset.publicPlayer,Object.fromEntries(GOODS.map(g=>[g.id,motion.capture(node.querySelector(`[data-good-id="${g.id}"] .yousei-good-icon`))]))]))};
  }
  function silver(node,delta,unit='两'){
    if(!node||!delta||document.hidden||reduced?.matches||!node.animate)return;
    const box=node.getBoundingClientRect();if(!box.width||!box.height)return;
    const pop=document.createElement('span');pop.className='nm-silver-change';pop.textContent=(delta>0?'+':'')+delta+unit;pop.setAttribute('aria-hidden','true');
    Object.assign(pop.style,{left:(box.x+box.width/2)+'px',top:box.y+'px'});root.append(pop);
    const animation=pop.animate([{opacity:0,transform:'translate(-50%,4px)'},{opacity:1,offset:.2,transform:'translate(-50%,-8px)'},{opacity:0,transform:'translate(-50%,-35px)'}],{duration:850,easing:'ease-out'}),record={node:pop,animation};
    textEffects.add(record);animation.finished.catch(()=>{}).finally(()=>{pop.remove();textEffects.delete(record);});
  }
  function present(snapshot,before,next){
    if(!snapshot||before?.game?.matchId!==next?.game?.matchId)return;
    for(const player of next.game.players){
      const previous=before.game.players.find(p=>p.id===player.id);if(!previous)continue;
      const mine=next.selfRole==='player'&&player.id===next.selfId;
      silver(root.querySelector(mine?'#yg-silver':`[data-public-player="${window.CSS.escape(player.id)}"] .nm-money`),player.silver-previous.silver);
      for(const good of GOODS){
        const delta=player.goods[good.id]-previous.goods[good.id];if(!delta)continue;
        const changed=next.game.players.filter(p=>p.id!==player.id&&p.goods[good.id]!==before.game.players.find(old=>old.id===p.id)?.goods[good.id]);
        const pair=changed.length===1&&next.game.bankGoods[good.id]===before.game.bankGoods[good.id];
        const receiver=pair&&changed.find(p=>p.goods[good.id]>(before.game.players.find(old=>old.id===p.id)?.goods[good.id]??0));
        if(delta<0&&receiver)continue; // The receiver owns this one transfer.
        const donor=delta>0&&pair?changed.find(p=>p.goods[good.id]<(before.game.players.find(old=>old.id===p.id)?.goods[good.id]??0)):null;
        const sourceId=donor?.id??player.id,source=sourceId===next.selfId?snapshot.own:snapshot.peers?.[sourceId];
        const from=delta>0?(donor?source?.[good.id]:snapshot.bank[good.id]):source?.[good.id];
        const owned=mine?`#yg-stock-slots .yg-owned-good[title="${good.name}"] .yousei-good-icon`:`[data-public-player="${window.CSS.escape(player.id)}"] [data-good-id="${good.id}"] .yousei-good-icon`;
        const target=root.querySelector(delta>0?owned:`[data-market-good="${good.id}"] .yousei-good-icon`);
        const bankDelta=next.game.bankGoods[good.id]-before.game.bankGoods[good.id];
        const targetObject=root.querySelector(owned);
        silver(targetObject,delta,'件');
        if(from&&target&&(pair||bankDelta===-delta))void motion.move({from,to:target.getBoundingClientRect(),duration:420});
      }
    }
  }
  const hidden=()=>{if(document.hidden)cancel();};
  document.addEventListener('visibilitychange',hidden);window.addEventListener('resize',cancel);
  return {capture,present,cancel,destroy(){cancel();motion.destroy();document.removeEventListener('visibilitychange',hidden);window.removeEventListener('resize',cancel);}};
}
