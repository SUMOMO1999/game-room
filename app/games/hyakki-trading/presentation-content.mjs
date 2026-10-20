/** Presentation catalog only. Legacy rule material catalogs retain their original bounds. */
import * as base from './content/definitions.mjs';
import * as expansion from './content/expansion-one.mjs';
export const GOODS=expansion.GOODS;
export const CARDS=base.CARDS,CATEGORIES=base.CATEGORIES;
export const isExpansion=value=>(value?.configuration??value?.opening?.configuration??value)?.packId===expansion.EXPANSION_PACK_ID;
export const goodsFor=value=>isExpansion(value)?GOODS:base.GOODS;
export const cardsFor=value=>isExpansion(value)?expansion.CARDS:base.CARDS;
export function getCard(id){if(expansion.ROLES.some(r=>r.id===id))return {...expansion.getRole(id),category:'role',timingLabel:'常驻角色',costText:'不占装备槽',copies:1};
  const found=expansion.CARDS.find(c=>c.id===id);return found&&!found.original?{...found,copies:found.copiesByPlayerCount[2],timingLabel:found.category==='tool'?'自己回合使用':'自己回合用牌阶段'}:base.getCard(id);}
export const getGood=id=>GOODS.find(g=>g.id===id)??base.getGood(id);
export const getCategory=id=>id==='role'?{id,name:'常驻角色'}:base.getCategory(id);
export const getRole=expansion.getRole;
export const categoryName=id=>expansion.CATEGORIES.find(c=>c.id===id)?.name??id;
export const expansionAsset=path=>'.'+path;
