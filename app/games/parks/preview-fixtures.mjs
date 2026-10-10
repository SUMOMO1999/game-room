// Fixed views exercise the page, not a substitute game engine or real account.
export const SCENES = Object.freeze([
  ['active','本人行动'],['waiting','准备室'],['opponent','对手行动'],['spectator','观战'],
  ['passion','热忱选择'],['camping','露营支付'],['teddy','Teddy顺序'],['season','季末奖励'],
  ['payment','项目附费与支付'],['empty-pool','空池不能支付'],['dense','密集个人区'],['paused','超时暂停'],['result','多人结算'],['solo-result','单人结算'],['missing','插画加载失败']
]);
export const SAMPLE_PARKS = Object.freeze(['arches','grand-teton','acadia','black-canyon-of-the-gunnison']);
export const SITE_VIEWS = Object.freeze([
  ['site.mountain','mountain'],['site.water','water'],['site.forest','forest'],['site.sun','sun'],
  ['site.parks','trail'],['site.canteen-or-photo','camera'],['site.gear','gear'],
  ['site.wildlife-trade','wildlife'],['site.trail-die','die'],
].map(([id,symbol])=>({id,symbol})));
export function previewFixture(scene = 'active') {
  if (!SCENES.some(([id])=>id===scene)) scene='active';
  return { scene, roomId:'parks-step0-room',roomCode:'120063',selfId:'parks-preview-a',selfRole:scene==='spectator'?'spectator':'player',
    phase:scene==='waiting'?'waiting':scene==='paused'?'paused':scene.includes('result')?'finished':'playing',
    players:[{id:'parks-preview-a',name:'我 · 林间散步',ready:false},{id:'parks-preview-b',name:'山野里的漫游伙伴',ready:true}],
    resources:{mountain:2,forest:2,sun:3,water:2,wildlife:1},capacity:10,photos:2,selectedHiker:1,selectedSite:null,selectedCard:null,season:1,
  };
}

// Authored payment exhibit, not a client-side rule calculator.
export const PAYMENT_SAMPLE=Object.freeze({parkId:'arches',projectId:'volunteer.carbon-offsetting',
 before:{mountain:2,forest:2,sun:3,water:2,wildlife:1},printed:{mountain:1,sun:2},surcharge:{forest:1},
 after:{mountain:1,forest:1,sun:1,water:2,wildlife:1},points:3});
