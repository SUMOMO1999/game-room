import {categoryName,expansionAsset} from './presentation-content.mjs';
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={goods:'货物牌',ordinary_character:'普通人物',monitored_character:'监视人物',tool:'道具',role:'常驻角色',stall_permit:'摊位许可'};

/** A physical card has one print composition. SVG viewBox scales the complete
 * face atomically; device CSS allocates its frame, never reflows its contents. */
export function renderExpansionPrint(card,{goods,classes}) {
  const esc=escapeHtml;
  const text=(value,x,y,size=11,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" ${extra}>${esc(value)}</text>`;
  const picture=(src,x,y,w,h)=>`<image href="${esc(expansionAsset(src))}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
  const icon=(id,x,y,w)=>picture(goods.find(g=>g.id===id).icon,x,y,w,w);
  let media,summary=card.summary;
  if(card.category==='goods') {
    const r=card.recipe;
    if(r.type==='fixed') {
      const [id,n]=Object.entries(r.goods)[0];media=icon(id,27,34,46)+text('×'+n,50,91,17);
    } else if(r.category) {
      const pair=goods.filter(g=>g.category===r.category);
      media=pair.map((g,i)=>icon(g.id,17+i*38,35,28)).join('')+text(categoryName(r.category)+'类×'+(r.type==='mixed'?2:3),50,84,14.5)+(r.type==='mixed'?text('其他类×1',50,103,14.5):'');
    } else {
      media=classes.map((c,i)=>{const x=29+(i%3)*21,y=44+Math.floor(i/3)*17;return `<circle cx="${x}" cy="${y}" r="7.5" fill="#ddcca3" stroke="#9f8b5b" stroke-width=".6"/>`+text(c.name[0],x,y+3,10);}).join('')+text(r.type==='distinct'?'三类各1':'任意3件',50,86,15);
    }
  } else {
    media=picture(card.artPath,5,30,90,61);
  }
  const glyphs=Array.from(card.compactText??summary),lines=[];
  for(let i=0;i<glyphs.length;i+=8)lines.push(glyphs.slice(i,i+8).join(''));
  if(lines.length>3)throw new Error('卡面摘要超过固定印刷预算：'+card.id);
  const effect=card.category==='goods'?'':lines.map((line,i)=>text(line,50,103+i*11,10.5)).join('');
  const band={goods:'#49614f',ordinary_character:'#70575c',monitored_character:'#8e493c',tool:'#4b6473',role:'#49614f'}[card.category];
  const footer=card.category==='role'?text(`${card.initialSilver}两开局 · 不占槽`,50,144,9):card.category==='goods'?text('买',17,144,10)+text(card.buySilver,34,145,17)+text('卖',67,144,10,'fill="#8e4035"')+text(card.sellSilver,85,145,17,'fill="#8e4035"'):text(card.category==='tool'?'装0步 · 用1步':'行动 · 1步',50,144,11.5);
  return `<article class="yousei-card ex-new-card" data-card-category="${card.category}" data-expansion-card="${esc(card.id)}" aria-label="${esc(card.name)}"><svg class="ex-print-face" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 148" preserveAspectRatio="xMidYMid meet" aria-hidden="true" text-anchor="middle" font-family="system-ui, sans-serif" fill="#3a3428"><rect width="100" height="12" fill="${band}"/>${text(labels[card.category],3,8.5,7,'text-anchor="start" fill="#f6e4bd"')}${text(card.sourceCode,97,8.5,6,'text-anchor="end" fill="#f6e4bd"')}${text(card.name,50,25,14,'font-family="Songti SC, SimSun, serif" font-weight="600"')}${media}${effect}<path d="M5 130H95" stroke="#b6a077" stroke-width=".7"/>${footer}</svg></article>`;
}
