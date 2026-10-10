/** Public digital content only. Original photographs and source paths are never imported. */
export const DIGITAL_RULE_VERSION = 'yousei-digital-v1';
export const CONTENT_VERSION = 'yousei-content-v1';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const GOODS = deepFreeze([{"id": "firearms", "name": "火器", "initialStock": 6}, {"id": "imports", "name": "番货", "initialStock": 6}, {"id": "curios", "name": "奇物", "initialStock": 6}, {"id": "beasts", "name": "异兽", "initialStock": 6}, {"id": "antiques", "name": "文玩", "initialStock": 6}, {"id": "salt-iron", "name": "盐铁", "initialStock": 6}]);
export const INITIAL_STOCK = deepFreeze(Object.fromEntries(GOODS.map(good => [good.id, good.initialStock])));
export const CATEGORIES = deepFreeze([
  { id: 'goods', name: '货物牌' },
  { id: 'stall_permit', name: '摊位许可' },
  { id: 'ordinary_character', name: '普通人物' },
  { id: 'monitored_character', name: '监视人物' },
  { id: 'tool', name: '道具' },
]);

export const CARDS = deepFreeze([
  {
    "id": "yousei.g01",
    "name": "火器×3",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G01",
    "goods": {
      "firearms": 3
    },
    "buySilver": 3,
    "sellSilver": 10,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价3两、卖价10两。",
    "compactText": "整组买卖",
    "details": [
      "配方：火器×3；买入支付3两，卖出获得10两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g02",
    "name": "番货×1＋奇物×2",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G02",
    "goods": {
      "imports": 1,
      "curios": 2
    },
    "buySilver": 4,
    "sellSilver": 11,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价4两、卖价11两。",
    "compactText": "整组买卖",
    "details": [
      "配方：番货×1＋奇物×2；买入支付4两，卖出获得11两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g03",
    "name": "异兽×3",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G03",
    "goods": {
      "beasts": 3
    },
    "buySilver": 3,
    "sellSilver": 10,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价3两、卖价10两。",
    "compactText": "整组买卖",
    "details": [
      "配方：异兽×3；买入支付3两，卖出获得10两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g04",
    "name": "番货×3",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G04",
    "goods": {
      "imports": 3
    },
    "buySilver": 3,
    "sellSilver": 10,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价3两、卖价10两。",
    "compactText": "整组买卖",
    "details": [
      "配方：番货×3；买入支付3两，卖出获得10两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g05",
    "name": "文玩×1＋异兽×2",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G05",
    "goods": {
      "antiques": 1,
      "beasts": 2
    },
    "buySilver": 4,
    "sellSilver": 11,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价4两、卖价11两。",
    "compactText": "整组买卖",
    "details": [
      "配方：文玩×1＋异兽×2；买入支付4两，卖出获得11两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g06",
    "name": "火器×1＋文玩×2",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G06",
    "goods": {
      "firearms": 1,
      "antiques": 2
    },
    "buySilver": 4,
    "sellSilver": 11,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价4两、卖价11两。",
    "compactText": "整组买卖",
    "details": [
      "配方：火器×1＋文玩×2；买入支付4两，卖出获得11两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g07",
    "name": "奇物×1＋火器×1＋文玩×1",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G07",
    "goods": {
      "curios": 1,
      "firearms": 1,
      "antiques": 1
    },
    "buySilver": 5,
    "sellSilver": 12,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价5两、卖价12两。",
    "compactText": "整组买卖",
    "details": [
      "配方：奇物×1＋火器×1＋文玩×1；买入支付5两，卖出获得12两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g08",
    "name": "盐铁×1＋番货×2",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G08",
    "goods": {
      "salt-iron": 1,
      "imports": 2
    },
    "buySilver": 4,
    "sellSilver": 11,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价4两、卖价11两。",
    "compactText": "整组买卖",
    "details": [
      "配方：盐铁×1＋番货×2；买入支付4两，卖出获得11两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g09",
    "name": "奇物×3",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G09",
    "goods": {
      "curios": 3
    },
    "buySilver": 3,
    "sellSilver": 10,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价3两、卖价10两。",
    "compactText": "整组买卖",
    "details": [
      "配方：奇物×3；买入支付3两，卖出获得10两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g10",
    "name": "奇物×1＋文玩×1＋盐铁×1",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G10",
    "goods": {
      "curios": 1,
      "antiques": 1,
      "salt-iron": 1
    },
    "buySilver": 5,
    "sellSilver": 12,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价5两、卖价12两。",
    "compactText": "整组买卖",
    "details": [
      "配方：奇物×1＋文玩×1＋盐铁×1；买入支付5两，卖出获得12两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g11",
    "name": "奇物×1＋火器×2",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G11",
    "goods": {
      "curios": 1,
      "firearms": 2
    },
    "buySilver": 4,
    "sellSilver": 11,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价4两、卖价11两。",
    "compactText": "整组买卖",
    "details": [
      "配方：奇物×1＋火器×2；买入支付4两，卖出获得11两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g12",
    "name": "火器×1＋文玩×1＋异兽×1",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G12",
    "goods": {
      "firearms": 1,
      "antiques": 1,
      "beasts": 1
    },
    "buySilver": 5,
    "sellSilver": 12,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价5两、卖价12两。",
    "compactText": "整组买卖",
    "details": [
      "配方：火器×1＋文玩×1＋异兽×1；买入支付5两，卖出获得12两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g13",
    "name": "火器×1＋番货×1＋异兽×1",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G13",
    "goods": {
      "firearms": 1,
      "imports": 1,
      "beasts": 1
    },
    "buySilver": 5,
    "sellSilver": 12,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价5两、卖价12两。",
    "compactText": "整组买卖",
    "details": [
      "配方：火器×1＋番货×1＋异兽×1；买入支付5两，卖出获得12两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g14",
    "name": "番货×1＋盐铁×1＋奇物×1",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G14",
    "goods": {
      "imports": 1,
      "salt-iron": 1,
      "curios": 1
    },
    "buySilver": 5,
    "sellSilver": 12,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价5两、卖价12两。",
    "compactText": "整组买卖",
    "details": [
      "配方：番货×1＋盐铁×1＋奇物×1；买入支付5两，卖出获得12两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g15",
    "name": "异兽×1＋盐铁×2",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G15",
    "goods": {
      "beasts": 1,
      "salt-iron": 2
    },
    "buySilver": 4,
    "sellSilver": 11,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价4两、卖价11两。",
    "compactText": "整组买卖",
    "details": [
      "配方：异兽×1＋盐铁×2；买入支付4两，卖出获得11两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g16",
    "name": "异兽×1＋番货×1＋盐铁×1",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G16",
    "goods": {
      "beasts": 1,
      "imports": 1,
      "salt-iron": 1
    },
    "buySilver": 5,
    "sellSilver": 12,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价5两、卖价12两。",
    "compactText": "整组买卖",
    "details": [
      "配方：异兽×1＋番货×1＋盐铁×1；买入支付5两，卖出获得12两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g17",
    "name": "文玩×3",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G17",
    "goods": {
      "antiques": 3
    },
    "buySilver": 3,
    "sellSilver": 10,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价3两、卖价10两。",
    "compactText": "整组买卖",
    "details": [
      "配方：文玩×3；买入支付3两，卖出获得10两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g18",
    "name": "盐铁×3",
    "category": "goods",
    "copies": 2,
    "sourceCode": "G18",
    "goods": {
      "salt-iron": 3
    },
    "buySilver": 3,
    "sellSilver": 10,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价3两、卖价10两。",
    "compactText": "整组买卖",
    "details": [
      "配方：盐铁×3；买入支付3两，卖出获得10两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.g19",
    "name": "番货×1＋盐铁×1＋奇物×1＋火器×1＋异兽×1＋文玩×1",
    "category": "goods",
    "copies": 4,
    "sourceCode": "G19",
    "goods": {
      "imports": 1,
      "salt-iron": 1,
      "curios": 1,
      "firearms": 1,
      "beasts": 1,
      "antiques": 1
    },
    "buySilver": 10,
    "sellSilver": 18,
    "artId": null,
    "summary": "按牌面整组买入或卖出：基础买价10两、卖价18两。",
    "compactText": "六种各1件",
    "details": [
      "配方：番货×1＋盐铁×1＋奇物×1＋火器×1＋异兽×1＋文玩×1；买入支付10两，卖出获得18两。",
      "普通买卖每次耗1步。买入须有整组公库货物、银两和可用位置；卖出须持有完整配方。钱、货或位置不足时整笔不成交。",
      "本回合每层书算令整张货物牌买价减2两（最低0）、卖价加2两；临时格费用另付，不受书算影响。",
      "交易完成后开放对手番商回应；没有人取走时，此货物牌弃置。",
      "六种货物各1件，共6件；此牌不能用于买办的三件货物交易。"
    ],
    "costText": "交易1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use"
  },
  {
    "id": "yousei.c01",
    "name": "把戏人",
    "category": "ordinary_character",
    "copies": 1,
    "sourceCode": "C01",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c01",
    "summary": "自己选抽牌或收同种货物，对手获得另一项收益。",
    "compactText": "分取牌与货",
    "details": [
      "自己先选抽最多2张牌，或从公库取得最多2件同种货物；对手获得另一项收益。",
      "先结算自己，再结算对手；拿货的人自行选择货种，不足2件按可得数取得。牌与货均无可得收益时不可发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。",
      "人物收货时，可从原库存和本次所得中挑选保留；舍弃货物回公库。临时格空变占用另付2两，付不起时只保留普通容量。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c02",
    "name": "卦师",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C02",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c02",
    "summary": "私看牌堆顶最多6张，留1张，其余按原顺序放回。",
    "compactText": "看6张 · 留1张",
    "details": [
      "私看牌堆顶最多6张，选择1张加入手牌，其余按原相对顺序背面向上放回堆顶。",
      "至少有1张可抽牌才能发动；整批看牌只计人物的1步，不进入普通留弃流程。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c03",
    "name": "书算",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C03",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c03",
    "summary": "本回合货物牌每张买价减2两、卖价加2两，可叠加。",
    "compactText": "买减2 · 卖加2",
    "details": [
      "每用一张书算，本回合每张货物牌总买价减2两、总卖价加2两；多张书算叠加，买价最低0。",
      "只修正货物牌总价；不按货物件数叠加，也不改变临时格费、许可、道具、竞拍或人物的固定收支。",
      "买办所用的三件货物牌也享受卖价修正；本回合结束时全部书算效果消失。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c04",
    "name": "番商",
    "category": "ordinary_character",
    "copies": 3,
    "sourceCode": "C04",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c04",
    "summary": "对手完成货物交易后，免费回应并取得那张货物牌。",
    "compactText": "交易后取牌",
    "details": [
      "只在对手已完成货物交易、该货物牌尚未弃置的回应窗口使用；也适用于买办的货物子交易。",
      "不耗行动，取走该货物牌加入自己的手牌；番商弃置，对手已经完成的银两和货物交易保留。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "回应0步",
    "timingLabel": "对手货物交易完成后",
    "actionIncrement": 0,
    "timing": "opponent-goods-response",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c05",
    "name": "买办",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C05",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c05",
    "summary": "搭配三件货物牌，交回任意3件库存并取得该牌卖价。",
    "compactText": "任意3货换卖价",
    "details": [
      "另打出一张标有3件货物的货物牌，交回自己的任意3件库存，收取该牌卖价；所交货种不必与牌面相同。",
      "买办计1步，配套货物牌不另计步；书算卖价修正生效。G19的六件配方不可使用。",
      "交易后开放番商回应；番商只取配套货物牌，买办仍弃置，已经取得的收入不回退。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c06",
    "name": "货郎",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C06",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c06",
    "summary": "把自己某一种库存全部换成公库另一种等量货物。",
    "compactText": "整类等量换货",
    "details": [
      "选择自己至少有1件的一种货物，把该种全部交回公库，换取另一种等量货物。",
      "目标货种必须足额，不能只换一部分；按一次完整交换结算占位，临时位持续占用不重复收费。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c07",
    "name": "锦衣卫",
    "category": "ordinary_character",
    "copies": 6,
    "sourceCode": "C07",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c07",
    "summary": "免费回应监视人物，取消其效果；对手已用行动不退。",
    "compactText": "取消监视人物",
    "details": [
      "对手发动带监视标记的人物后，在牌效执行、秘密牌公开或材料转移前回应。",
      "不耗行动，取消整张人物效果；对手已耗的1步不退，尚未执行的效果费用不支付。",
      "被取消的人物先弃，锦衣卫后弃；普通人物和道具不能被锦衣卫取消。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "回应0步",
    "timingLabel": "对手发动监视人物时",
    "actionIncrement": 0,
    "timing": "opponent-monitored-response",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c08",
    "name": "典史",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C08",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c08",
    "summary": "自己补牌至5张，或由对手自己弃牌至3张。",
    "compactText": "补至5 · 弃至3",
    "details": [
      "选择一项合法分支：自己补手牌至5张，或让对手从自己的手牌中选择弃牌，直到剩3张。",
      "计算自己手牌时不包括已经打出的典史；补牌只取可抽到的数量。",
      "自己已达5张、对手不多于3张等没有变化的分支不可选；双方都没有可执行分支时不能发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c09",
    "name": "牙郎",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C09",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c09",
    "summary": "从公库选2件货物作为一个拍品，由自己先竞价。",
    "compactText": "拍卖2件货物",
    "details": [
      "从公库选择任意2件同种或异种货物，全部公开并作为一个拍品，不能拆分。",
      "自己先报至少1两，双方交替加价至少1两；一方放弃后，另一方按最高价向银行付款，取得整组货物。",
      "双方初次均放弃则两件回公库；人物和已用行动不退。发动前须有足额2件货物，且至少一人有1两。报价不得超过现有银两；付标金后的余钱决定能否支付临时格费。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。",
      "人物收货时，可从原库存和本次所得中挑选保留；舍弃货物回公库。临时格空变占用另付2两，付不起时只保留普通容量。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c10",
    "name": "匠人",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C10",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c10",
    "summary": "支付2两，从公库取得同一种货物2件。",
    "compactText": "2两取同种2件",
    "details": [
      "支付2两，选择公库足额的一种货物，取得该种2件，不能混取两种。",
      "钱不足2两或没有足额货种时不能发动；临时格费用另计。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。",
      "人物收货时，可从原库存和本次所得中挑选保留；舍弃货物回公库。临时格空变占用另付2两，付不起时只保留普通容量。"
    ],
    "costText": "1步 · 2两",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c11",
    "name": "团头",
    "category": "ordinary_character",
    "copies": 1,
    "sourceCode": "C11",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c11",
    "summary": "从全部弃牌中选择1张道具加入手牌。",
    "compactText": "拾回1张道具",
    "details": [
      "从整个弃牌区选择1张道具牌加入自己的手牌，不限弃牌堆顶。",
      "没有道具可选时不能发动；所得道具不会自动安装，之后安装仍计1步。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c12",
    "name": "花魁",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C12",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c12",
    "summary": "公开抽出3张牌作为一个拍品，自己先竞价，整组成交。",
    "compactText": "拍卖3张明牌",
    "details": [
      "抽3张并全部公开，作为一个不可拆分的拍品；至少能抽齐3张，且至少一人有1两才能发动。",
      "自己先报至少1两，双方交替加价至少1两；一方放弃后，另一方向银行付款，全部3张加入其手牌。",
      "双方初次均放弃，三张拍品依原抽取顺序弃置；人物和已耗行动不退。报价须为不超过现有银两的整数。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.c13",
    "name": "朝奉",
    "category": "ordinary_character",
    "copies": 2,
    "sourceCode": "C13",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "c13",
    "summary": "交回任意数量库存，每件取得2两，至少交1件。",
    "compactText": "每交1货得2两",
    "details": [
      "选择自己的至少1件库存交回公库，可以跨货种或交回全部；每件取得2两。",
      "不需搭配货物牌，不受书算加价；腾空临时格不退原已付费用。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": false
  },
  {
    "id": "yousei.m01",
    "name": "梁上君子",
    "category": "monitored_character",
    "copies": 2,
    "sourceCode": "M01",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "m01",
    "summary": "取走对手库存中的1件货物，转入自己的商铺。",
    "compactText": "取对手1件货",
    "details": [
      "带监视标记：对手可先用锦衣卫取消。回应结束前不执行效果、不公开秘密材料。",
      "公开选择对手商铺或摊位中的1件货物；通过锦衣卫回应后转给自己。",
      "取得的是实际库存，不是手牌；对手没有库存时不能发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。",
      "人物收货时，可从原库存和本次所得中挑选保留；舍弃货物回公库。临时格空变占用另付2两，付不起时只保留普通容量。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": true
  },
  {
    "id": "yousei.m02",
    "name": "县丞",
    "category": "monitored_character",
    "copies": 1,
    "sourceCode": "M02",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "m02",
    "summary": "双方手牌合并公开，由自己先选，每次1张轮流分完。",
    "compactText": "公开重分手牌",
    "details": [
      "带监视标记：对手可先用锦衣卫取消。回应结束前不执行效果、不公开秘密材料。",
      "通过锦衣卫回应后，双方剩余手牌合成一个公开牌池；发动的县丞不在牌池内。",
      "由自己先选，双方轮流每次取1张加入手牌，直到分完；每次选择不另耗行动。",
      "两人的剩余手牌合计为0时不能发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": true
  },
  {
    "id": "yousei.m03",
    "name": "魁首",
    "category": "monitored_character",
    "copies": 1,
    "sourceCode": "M03",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "m03",
    "summary": "双方各自只保留1张已安装道具，其余全部弃置。",
    "compactText": "双方各留1道具",
    "details": [
      "带监视标记：对手可先用锦衣卫取消。回应结束前不执行效果、不公开秘密材料。",
      "通过回应后，双方各自从自己的道具区保留1张，其余弃置；只有0或1张的一方保持原样。",
      "保留的道具维持原来竖直或横置状态；至少一方已安装超过1张道具才能发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": true
  },
  {
    "id": "yousei.m04",
    "name": "蛊婆",
    "category": "monitored_character",
    "copies": 1,
    "sourceCode": "M04",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "m04",
    "summary": "由对手选择付给自己2两，或让自己抽最多2张牌。",
    "compactText": "对手选钱或牌",
    "details": [
      "带监视标记：对手可先用锦衣卫取消。回应结束前不执行效果、不公开秘密材料。",
      "通过回应后，由对手选择：支付给自己2两，或让自己抽最多2张牌。",
      "对手不足2两不能选付钱；没有可抽牌不能选抽牌。两个分支都无法产生收益时不能发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": true
  },
  {
    "id": "yousei.m05",
    "name": "船老大",
    "category": "monitored_character",
    "copies": 1,
    "sourceCode": "M05",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "m05",
    "summary": "双方库存合并，由自己先选，每次1件轮流重新分配。",
    "compactText": "轮流重分货物",
    "details": [
      "带监视标记：对手可先用锦衣卫取消。回应结束前不执行效果、不公开秘密材料。",
      "通过回应后，双方所有库存进入公开分配池；由自己先选，轮流每次拿1件放进自己的合法位置。",
      "放不下且无力支付临时费的一方跳过，另一方继续；双方都放不下的余货回公库。",
      "已持续占用的临时格不重复收费；不能领货后再弃回池反复选择。双方均无库存时不能发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": true
  },
  {
    "id": "yousei.m06",
    "name": "光棍",
    "category": "monitored_character",
    "copies": 1,
    "sourceCode": "M06",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "m06",
    "summary": "双方已安装道具合并，由自己先选并逐张竖直重分。",
    "compactText": "竖直重分道具",
    "details": [
      "带监视标记：对手可先用锦衣卫取消。回应结束前不执行效果、不公开秘密材料。",
      "通过回应后，把双方已安装道具合成公开池；由自己先选，双方交替每次取1张竖直放入道具区，最多各3张。",
      "重分不进入手牌，也不收安装行动；同名道具仍是独立的牌。自己尚有行动时可再次激活取得的道具。",
      "纸上仙仍受抽牌前窗口限制。双方都没有已安装道具时不能发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": true
  },
  {
    "id": "yousei.m07",
    "name": "堪舆师",
    "category": "monitored_character",
    "copies": 2,
    "sourceCode": "M07",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "m07",
    "summary": "盲抽对手1张手牌，再从现在手牌中选1张交回。",
    "compactText": "先盲抽 · 后交还",
    "details": [
      "带监视标记：对手可先用锦衣卫取消。回应结束前不执行效果、不公开秘密材料。",
      "通过回应后，随机取得对手1张手牌，再从自己此时的手牌中选择1张交给对手，允许交回刚得到的牌。",
      "抽到的牌仅向自己显示；对手没有手牌时不能发动。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": true
  },
  {
    "id": "yousei.m08",
    "name": "术士",
    "category": "monitored_character",
    "copies": 5,
    "sourceCode": "M08",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "m08",
    "summary": "弃掉对手1张已安装道具，可立即借用一次其效果。",
    "compactText": "拆道具 · 可借用",
    "details": [
      "带监视标记：对手可先用锦衣卫取消。回应结束前不执行效果、不公开秘密材料。",
      "选择对手任意1张已安装道具，无论是否横置；通过回应后弃掉它，再决定是否借用一次效果。",
      "借用不安装，也不额外计行动，但效果费用和使用条件仍由自己承担。纸上仙可以拆除，不能借用。",
      "借九转金炉或贪嘴泥翁时，已弃的对方道具和正在结算的术士均不能再当成本；只能支付自己的手牌或已安装道具。没有可行支付时可只拆不借。",
      "人物效果完成后弃置；效果中的选择、拍卖和分配不重复消耗行动。"
    ],
    "costText": "1步 · 借用费用另付",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "cancelableByJinyiwei": true
  },
  {
    "id": "yousei.t01",
    "name": "貔貅袋",
    "category": "tool",
    "copies": 2,
    "sourceCode": "T01",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t01",
    "summary": "公开寻找首张货物牌，再付1两或弃1张手牌取得它。",
    "compactText": "寻货牌 · 再支付",
    "details": [
      "逐张公开翻牌，找到第一张货物牌即停止；其余翻出的牌在搜索结束后弃置，每张候选本次最多查看一次。",
      "找到后须支付1两或弃自己的1张手牌，才将目标加入手牌；不能用尚未取得的目标牌支付。",
      "发动前须至少有1张可搜索牌，并具备一种支付方式。未找到货物牌则不支付取得费，但已耗行动和横置仍保留。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t02",
    "name": "许愿井",
    "category": "tool",
    "copies": 2,
    "sourceCode": "T02",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t02",
    "summary": "选自己和对手各1件库存，完整交换。",
    "compactText": "双方各换1件",
    "details": [
      "选择自己的1件货物与对手商铺或摊位中的1件货物，完整交换；允许交换同种货物。",
      "双方都须有库存，不能只给或只拿；按交换后的占位结算，临时位持续占用不重复收费。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t03",
    "name": "鹤骨笛",
    "category": "tool",
    "copies": 2,
    "sourceCode": "T03",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t03",
    "summary": "先弃1或2张手牌，再抽取相同张数。",
    "compactText": "弃1／2 · 抽同数",
    "details": [
      "先从自己手牌选择1张或2张弃置，再抽相同数量的牌；不能先抽再决定弃什么。",
      "牌堆空时可洗刚弃的牌，因此可能抽回原牌；整批只计1次激活行动，不进入普通留弃流程。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t04",
    "name": "两仪灯",
    "category": "tool",
    "copies": 2,
    "sourceCode": "T04",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t04",
    "summary": "私看新抽的2张牌，自己留1张，另一张交给对手。",
    "compactText": "抽2张 · 各得1张",
    "details": [
      "至少能抽齐2张才能发动。自己私看新抽的2张，选择1张加入手牌，另一张交给对手。",
      "只能在刚抽到的2张中选择；对手只看自己获得的一张，观众不看这批私牌。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t05",
    "name": "梅花令牌",
    "category": "tool",
    "copies": 3,
    "sourceCode": "T05",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t05",
    "summary": "支付1两，抽1张牌。",
    "compactText": "1两抽1张",
    "details": [
      "激活时支付1两并抽1张牌；这是效果费用，安装本道具不花这1两。",
      "至少有1两和1张可抽牌才能激活，不进入普通留弃流程。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t06",
    "name": "西域迷香",
    "category": "tool",
    "copies": 2,
    "sourceCode": "T06",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t06",
    "summary": "交回自己的1件库存货物，抽1张牌。",
    "compactText": "交1货 · 抽1牌",
    "details": [
      "选择自己库存中的1件货物交回公库，再抽1张牌。",
      "须有实际库存和可抽牌；货物牌不能代替库存付费。腾空临时格不退原费用。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t07",
    "name": "纸上仙",
    "category": "tool",
    "copies": 2,
    "sourceCode": "T07",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t07",
    "summary": "普通取牌前，把自己的1张手牌与弃牌堆顶交换。",
    "compactText": "取牌前换顶牌",
    "details": [
      "仅在本回合第一次普通看牌之前、且尚未关闭取牌阶段时激活；把自己的1张手牌与弃牌堆顶交换。",
      "自己的牌成为新的弃牌堆顶，原顶牌加入手牌；只可换顶牌，不能选择弃牌中间的牌。",
      "交换计1步并横置，其后仍可取牌或进入用牌；当回合进入用牌后新安装的纸上仙不能立即激活。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "本回合普通取牌前",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "before-draw",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t08",
    "name": "九转金炉",
    "category": "tool",
    "copies": 2,
    "sourceCode": "T08",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t08",
    "summary": "弃本道具、1张自己手牌或已安装道具，获得2两。",
    "compactText": "弃1张 · 得2两",
    "details": [
      "从本道具、自己的1张手牌、自己道具区的1张道具中选择一张弃掉，获得2两。",
      "三选一支付，其他已横置道具也可支付；不能弃对手的牌。弃别的牌时本道具横置留场，弃自身则离场。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t09",
    "name": "采珠图",
    "category": "tool",
    "copies": 2,
    "sourceCode": "T09",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t09",
    "summary": "支付2两，从公库取得任意1件货物。",
    "compactText": "2两取1件货",
    "details": [
      "支付2两，选择公库有库存的一种货物，取得1件并放入合法空位。",
      "发动前须能支付效果费用和位置费用；普通位已满而临时位空时需共4两。不适用人物得货后任意换留库存的例外。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.t10",
    "name": "贪嘴泥翁",
    "category": "tool",
    "copies": 3,
    "sourceCode": "T10",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "t10",
    "summary": "弃本道具、1张自己手牌或已安装道具，取得1件货物。",
    "compactText": "弃1张 · 取1货",
    "details": [
      "从本道具、自己的1张手牌、自己已安装的1张道具中选一张弃掉，取得公库中所选的1件货物。",
      "发动前须有货源与可负担的位置；普通位已满时临时位费另付。不适用人物换留库存的例外。",
      "弃其他牌时本道具横置留场，弃自身则离场；不能用对手的牌支付。",
      "先花1步安装到自己的道具区（最多3张，可弃旧换新）；竖直时再花1步激活，随后横置。未被牺牲的道具留场，在自己回合结束时恢复竖直。"
    ],
    "costText": "安装1步 · 激活1步",
    "timingLabel": "自己的用牌阶段",
    "placementActionIncrement": 1,
    "activationActionIncrement": 1,
    "timing": "own-use",
    "tapOnActivation": true,
    "untapAt": "owner-turn-end"
  },
  {
    "id": "yousei.stall-permit",
    "name": "摊位许可牌",
    "category": "stall_permit",
    "copies": 5,
    "sourceCode": "P01",
    "goods": {},
    "buySilver": null,
    "sellSilver": null,
    "artId": "stall-permit",
    "summary": "购买1块三格扩展摊位；整局首次6两，之后每次3两。",
    "compactText": "增3格 · 首6后3",
    "details": [
      "使用许可牌购买1块公共扩展摊位板，永久增加自己的3个普通货位，耗1步。",
      "整局第一块板6两，此后无论由谁购买均为3两；公共板一共5块，无板或钱不足不能使用。",
      "扩容后自动腾空已付费的临时格，但不退费；许可牌用后弃置。"
    ],
    "costText": "1步 · 全局首6两／后3两",
    "timingLabel": "自己的用牌阶段",
    "actionIncrement": 1,
    "timing": "own-use",
    "firstGlobalPurchaseSilver": 6,
    "laterPurchaseSilver": 3,
    "slotsAdded": 3,
    "sharedBoards": 5
  }
]);

const cardsById = new Map(CARDS.map(card => [card.id, card]));
const goodsById = new Map(GOODS.map(good => [good.id, good]));
const categoriesById = new Map(CATEGORIES.map(category => [category.id, category]));

export function getCard(id) {
  const card = cardsById.get(id);
  if (!card) throw new RangeError('未知的幽街商人牌面');
  return card;
}

export function getGood(id) {
  const good = goodsById.get(id);
  if (!good) throw new RangeError('未知的幽街商人货物');
  return good;
}

export function getCategory(id) {
  const category = categoriesById.get(id);
  if (!category) throw new RangeError('未知的幽街商人牌类');
  return category;
}

/** Fixed material construction, without shuffling. Entity IDs stay inside trusted state. */
export function createDeck() {
  return deepFreeze(CARDS.flatMap(card => Array.from({ length: card.copies }, (_, index) => ({
    id: `${card.id}#${String(index + 1).padStart(2, '0')}`,
    definitionId: card.id,
  }))));
}

export function assertContentVersion(version) {
  if (version !== CONTENT_VERSION) throw new RangeError('不支持的幽街商人内容版本');
  return true;
}

export function assertRuleVersion(version) {
  if (version !== DIGITAL_RULE_VERSION) throw new RangeError('不支持的幽街商人规则版本');
  return true;
}
