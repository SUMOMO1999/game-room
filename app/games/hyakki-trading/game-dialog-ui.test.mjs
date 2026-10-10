import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, GOODS } from './content/definitions.mjs';
import { renderCompactCard, dialogPage } from './game-dialog-ui.mjs';
import { renderChoiceForm } from './game-ui.mjs';
import { buildChoiceSelection } from './game-ui-model.mjs';

test('compact decisions retain every goods quantity and trade price, with a separate full-rules entry', () => {
  for (const face of CARDS) {
    const markup=renderCompactCard({cardId:'candidate',definitionId:face.id});
    assert.ok(markup.includes('完整牌文'));
    assert.ok(markup.includes(face.category==='goods'?face.sourceCode:face.name));
    if(face.category==='goods') {
      assert.ok(markup.includes(`买${face.buySilver} · 卖${face.sellSilver}两`));
      for(const [id,count] of Object.entries(face.goods)) {
        assert.ok(markup.includes(GOODS.find(good=>good.id===id).name));
        assert.ok(markup.includes(`×${count}`));
      }
    }
    assert.doesNotMatch(markup,/undefined|\[object Object\]/u);
  }
  assert.match(renderCompactCard(CARDS.find(card=>card.category==='goods'),{inline:true}),/货物交易/u);
});

test('a long choice exposes original option indexes on later pages and submits that exact option', () => {
  const cards=Array.from({length:14},(_,i)=>({cardId:`card-${i}`,definitionId:CARDS[i].id}));
  const pending={choice:{kind:'draft-card',options:cards.map(card=>({cardId:card.cardId})),defaultSelection:{cardId:'card-0'}}};
  const game={players:[{hand:cards,tools:[]}],discard:[],pending};
  const html=renderChoiceForm(pending,game,{optionIndex:13},2);
  assert.match(html,/name="optionIndex" value="13" checked/u);
  assert.doesNotMatch(html,/name="optionIndex" value="[0-9]"/u);
  assert.deepEqual(buildChoiceSelection(pending,{optionIndex:13}),{cardId:'card-13'});
  const pages=[0,1,2].flatMap(page=>dialogPage(cards,page).items);
  assert.deepEqual(pages,cards);
  assert.equal(dialogPage(cards,99).current,2);
  assert.equal(dialogPage([],1).pages,1);
});

test('compact face text always comes from canonical definitions and escapes candidate references', () => {
  const markup=renderCompactCard({cardId:'" onclick="bad',definitionId:'yousei.c07',name:'<script>bad</script>'});
  assert.match(markup,/锦衣卫/u);
  assert.doesNotMatch(markup,/<script| onclick="/u);
  assert.match(markup,/&quot; onclick=&quot;/u);
});
