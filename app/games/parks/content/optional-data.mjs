import { deepFreeze } from './immutable.mjs';

// Static rule facts transcribed in the project catalog; no third-party code or art.
export const OPTIONAL_DATA = deepFreeze({
  "camping": {
    "physicalTileCount": 4,
    "facesPerPhysicalTile": 2,
    "physicalPairing": [
      {
        "physicalTileId": "camp.tile.1",
        "sourceFaceIds": [
          1,
          12
        ],
        "sourceObjectPath": "/ObjectStates/21/ContainedObjects/0",
        "sourceObjectGuid": "e7b07e",
        "sourceRefs": [
          "tts-public-components"
        ],
        "evidenceStatus": "secondary-digital-explicit; physical-flip-not-independently-verified"
      },
      {
        "physicalTileId": "camp.tile.2",
        "sourceFaceIds": [
          2,
          11
        ],
        "sourceObjectPath": "/ObjectStates/21/ContainedObjects/1",
        "sourceObjectGuid": "7396f2",
        "sourceRefs": [
          "tts-public-components"
        ],
        "evidenceStatus": "secondary-digital-explicit; physical-flip-not-independently-verified"
      },
      {
        "physicalTileId": "camp.tile.3",
        "sourceFaceIds": [
          3,
          13
        ],
        "sourceObjectPath": "/ObjectStates/21/ContainedObjects/2",
        "sourceObjectGuid": "4dc187",
        "sourceRefs": [
          "tts-public-components"
        ],
        "evidenceStatus": "secondary-digital-explicit; physical-flip-not-independently-verified"
      },
      {
        "physicalTileId": "camp.tile.4",
        "sourceFaceIds": [
          4,
          14
        ],
        "sourceObjectPath": "/ObjectStates/21/ContainedObjects/3",
        "sourceObjectGuid": "6d7d80",
        "sourceRefs": [
          "tts-public-components"
        ],
        "evidenceStatus": "secondary-digital-explicit; physical-flip-not-independently-verified"
      }
    ],
    "physicalPairingStatus": "adopted-explicit-secondary-digital-relationships",
    "pairingWarning": "配对有明确公开TTS对象与8图对应，实物四板照片无冲突；尚无逐板实物翻面或发行商确认。按此冻结本项目内容版本，不按编号猜配，不抽重复实体；更强证据只修订新版本。",
    "faces": [
      {
        "id": "camp.face.1",
        "sourceFaceId": 1,
        "sourceSpriteRow": 1,
        "physicalTileId": "camp.tile.1",
        "physicalPairingReview": "adopted explicit TTS object pairing, both face images visually matched; non-publisher evidence",
        "slots": [
          {
            "id": "camp.face.1.slot.1",
            "position": 1,
            "outerCost": {
              "type": "spend_photo",
              "resource": "photo",
              "amount": 1,
              "descriptionZh": "支付1照片",
              "sourceCode": 6
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "sun",
                "amount": 1,
                "descriptionZh": "获得1太阳",
                "sourceCode": 103
              },
              {
                "type": "gain_resource",
                "resource": "water",
                "amount": 1,
                "descriptionZh": "获得1水",
                "sourceCode": 104
              },
              {
                "type": "gain_resource",
                "resource": "mountain",
                "amount": 1,
                "descriptionZh": "获得1山",
                "sourceCode": 102
              },
              {
                "type": "gain_resource",
                "resource": "forest",
                "amount": 1,
                "descriptionZh": "获得1森林",
                "sourceCode": 101
              }
            ],
            "sourceEffectCodes": [
              103,
              104,
              102,
              101
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.1.slot.2",
            "position": 2,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "gain_canteen",
                "amount": 1,
                "descriptionZh": "获得1枚水壶标记",
                "sourceCode": 203
              },
              {
                "type": "buy_gear",
                "opportunities": 1,
                "descriptionZh": "购买1件装备，仍按装备动作支付",
                "sourceCode": 202
              }
            ],
            "sourceEffectCodes": [
              203,
              202
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.1.slot.3",
            "position": 3,
            "outerCost": {
              "type": "spend_resource",
              "resource": "mountain",
              "amount": 1,
              "descriptionZh": "支付1山",
              "sourceCode": 2
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "sun",
                "amount": 5,
                "descriptionZh": "获得5太阳",
                "sourceCode": 103
              }
            ],
            "sourceEffectCodes": [
              103,
              103,
              103,
              103,
              103
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.1.slot.4",
            "position": 4,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "parks_action",
                "opportunities": 1,
                "descriptionZh": "执行公园动作：预订1张，或游览任意多张可支付的公园",
                "sourceCode": 221
              },
              {
                "type": "take_photo",
                "payment": {
                  "anyResource": 1
                },
                "photos": 1,
                "descriptionZh": "支付1资源拍1照片",
                "sourceCode": 212
              }
            ],
            "sourceEffectCodes": [
              221,
              212
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          }
        ]
      },
      {
        "id": "camp.face.2",
        "sourceFaceId": 2,
        "sourceSpriteRow": 2,
        "physicalTileId": "camp.tile.2",
        "physicalPairingReview": "adopted explicit TTS object pairing, both face images visually matched; non-publisher evidence",
        "slots": [
          {
            "id": "camp.face.2.slot.1",
            "position": 1,
            "outerCost": {
              "type": "spend_photo",
              "resource": "photo",
              "amount": 1,
              "descriptionZh": "支付1照片",
              "sourceCode": 6
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "wildlife",
                "amount": 2,
                "descriptionZh": "获得2野生动物",
                "sourceCode": 105
              }
            ],
            "sourceEffectCodes": [
              105,
              105
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.2.slot.2",
            "position": 2,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "choose_resource",
                "choices": [
                  "forest",
                  "mountain"
                ],
                "amount": 1,
                "descriptionZh": "获得1森林或1山",
                "sourceCode": 240
              },
              {
                "type": "choose_resource",
                "choices": [
                  "sun",
                  "water"
                ],
                "amount": 1,
                "descriptionZh": "获得1太阳或1水",
                "sourceCode": 241
              }
            ],
            "sourceEffectCodes": [
              240,
              241
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.2.slot.3",
            "position": 3,
            "outerCost": {
              "type": "spend_resource",
              "resource": "forest",
              "amount": 1,
              "descriptionZh": "支付1森林",
              "sourceCode": 1
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "water",
                "amount": 5,
                "descriptionZh": "获得5水",
                "sourceCode": 104
              }
            ],
            "sourceEffectCodes": [
              104,
              104,
              104,
              104,
              104
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.2.slot.4",
            "position": 4,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "take_shutterbug_badge",
                "descriptionZh": "取得摄影徽章",
                "sourceCode": 111
              },
              {
                "type": "take_photo",
                "payment": {
                  "anyResource": 1
                },
                "photos": 1,
                "descriptionZh": "支付1资源拍1照片",
                "sourceCode": 212
              }
            ],
            "sourceEffectCodes": [
              111,
              212
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          }
        ]
      },
      {
        "id": "camp.face.3",
        "sourceFaceId": 3,
        "sourceSpriteRow": 3,
        "physicalTileId": "camp.tile.3",
        "physicalPairingReview": "adopted explicit TTS object pairing, both face images visually matched; non-publisher evidence",
        "slots": [
          {
            "id": "camp.face.3.slot.1",
            "position": 1,
            "outerCost": {
              "type": "spend_resource",
              "resource": "wildlife",
              "amount": 1,
              "descriptionZh": "支付1野生动物",
              "sourceCode": 5
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "forest",
                "amount": 3,
                "descriptionZh": "获得3森林",
                "sourceCode": 101
              }
            ],
            "sourceEffectCodes": [
              101,
              101,
              101
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.3.slot.2",
            "position": 2,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "mountain",
                "amount": 1,
                "descriptionZh": "获得1山",
                "sourceCode": 102
              },
              {
                "type": "take_photo",
                "payment": {
                  "anyResource": 1
                },
                "photos": 1,
                "descriptionZh": "支付1资源拍1照片",
                "sourceCode": 212
              }
            ],
            "sourceEffectCodes": [
              102,
              212
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.3.slot.3",
            "position": 3,
            "outerCost": {
              "type": "spend_resource",
              "resource": "water",
              "amount": 1,
              "descriptionZh": "支付1水",
              "sourceCode": 4
            },
            "effectSteps": [
              {
                "type": "gain_any_resources",
                "amount": 2,
                "descriptionZh": "获得任意2资源；五类包含野生动物，可同种，受库存及项目即时上限限制",
                "interpretationStatus": "official-p5-generic-resource-definition-plus-printed-campsite-icon",
                "contractRef": "modes.md#5-露营完整流程",
                "sourceCode": 242,
                "allowedResources": [
                  "mountain",
                  "forest",
                  "sun",
                  "water",
                  "wildlife"
                ],
                "sameTypeAllowed": true,
                "resourceDefinitionSource": "official-1.1:p5"
              }
            ],
            "sourceEffectCodes": [
              242
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.3.slot.4",
            "position": 4,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "sun",
                "amount": 2,
                "descriptionZh": "获得2太阳",
                "sourceCode": 103
              },
              {
                "type": "buy_gear",
                "opportunities": 1,
                "descriptionZh": "购买1件装备，仍按装备动作支付",
                "sourceCode": 202
              }
            ],
            "sourceEffectCodes": [
              103,
              103,
              202
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          }
        ]
      },
      {
        "id": "camp.face.4",
        "sourceFaceId": 4,
        "sourceSpriteRow": 4,
        "physicalTileId": "camp.tile.4",
        "physicalPairingReview": "adopted explicit TTS object pairing, both face images visually matched; non-publisher evidence",
        "slots": [
          {
            "id": "camp.face.4.slot.1",
            "position": 1,
            "outerCost": {
              "type": "spend_resource",
              "resource": "wildlife",
              "amount": 1,
              "descriptionZh": "支付1野生动物",
              "sourceCode": 5
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "mountain",
                "amount": 3,
                "descriptionZh": "获得3山",
                "sourceCode": 102
              }
            ],
            "sourceEffectCodes": [
              102,
              102,
              102
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.4.slot.2",
            "position": 2,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "forest",
                "amount": 1,
                "descriptionZh": "获得1森林",
                "sourceCode": 101
              },
              {
                "type": "take_photo",
                "payment": {
                  "anyResource": 1
                },
                "photos": 1,
                "descriptionZh": "支付1资源拍1照片",
                "sourceCode": 212
              }
            ],
            "sourceEffectCodes": [
              101,
              212
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.4.slot.3",
            "position": 3,
            "outerCost": {
              "type": "spend_resource",
              "resource": "sun",
              "amount": 1,
              "descriptionZh": "支付1太阳",
              "sourceCode": 3
            },
            "effectSteps": [
              {
                "type": "roll_trail_die",
                "times": 2,
                "descriptionZh": "掷步道骰2次，分别结算",
                "sourceCode": 110
              }
            ],
            "sourceEffectCodes": [
              110,
              110
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.4.slot.4",
            "position": 4,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "trade_resources",
                "payment": {
                  "anyResource": 2
                },
                "gain": {
                  "wildlife": 2
                },
                "descriptionZh": "支付任意2资源，获得2野生动物",
                "contractRef": "modes.md#5-露营完整流程",
                "sourceCode": 214
              }
            ],
            "sourceEffectCodes": [
              214
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          }
        ]
      },
      {
        "id": "camp.face.11",
        "sourceFaceId": 11,
        "sourceSpriteRow": 5,
        "physicalTileId": "camp.tile.2",
        "physicalPairingReview": "adopted explicit TTS object pairing, both face images visually matched; non-publisher evidence",
        "slots": [
          {
            "id": "camp.face.11.slot.1",
            "position": 1,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "wildlife",
                "amount": 1,
                "descriptionZh": "获得1野生动物",
                "sourceCode": 105
              }
            ],
            "sourceEffectCodes": [
              105
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.11.slot.2",
            "position": 2,
            "outerCost": {
              "type": "spend_photo",
              "resource": "photo",
              "amount": 1,
              "descriptionZh": "支付1照片",
              "sourceCode": 6
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "sun",
                "amount": 1,
                "descriptionZh": "获得1太阳",
                "sourceCode": 103
              },
              {
                "type": "gain_resource",
                "resource": "water",
                "amount": 1,
                "descriptionZh": "获得1水",
                "sourceCode": 104
              },
              {
                "type": "gain_resource",
                "resource": "mountain",
                "amount": 1,
                "descriptionZh": "获得1山",
                "sourceCode": 102
              },
              {
                "type": "gain_resource",
                "resource": "forest",
                "amount": 1,
                "descriptionZh": "获得1森林",
                "sourceCode": 101
              }
            ],
            "sourceEffectCodes": [
              103,
              104,
              102,
              101
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.11.slot.3",
            "position": 3,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "forest",
                "amount": 1,
                "descriptionZh": "获得1森林",
                "sourceCode": 101
              },
              {
                "type": "take_photo",
                "payment": {
                  "anyResource": 1
                },
                "photos": 1,
                "descriptionZh": "支付1资源拍1照片",
                "sourceCode": 212
              }
            ],
            "sourceEffectCodes": [
              101,
              212
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.11.slot.4",
            "position": 4,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "sun",
                "amount": 2,
                "descriptionZh": "获得2太阳",
                "sourceCode": 103
              },
              {
                "type": "buy_gear",
                "opportunities": 1,
                "descriptionZh": "购买1件装备，仍按装备动作支付",
                "sourceCode": 202
              }
            ],
            "sourceEffectCodes": [
              103,
              103,
              202
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          }
        ]
      },
      {
        "id": "camp.face.12",
        "sourceFaceId": 12,
        "sourceSpriteRow": 6,
        "physicalTileId": "camp.tile.1",
        "physicalPairingReview": "adopted explicit TTS object pairing, both face images visually matched; non-publisher evidence",
        "slots": [
          {
            "id": "camp.face.12.slot.1",
            "position": 1,
            "outerCost": {
              "type": "spend_photo",
              "resource": "photo",
              "amount": 1,
              "descriptionZh": "支付1照片",
              "sourceCode": 6
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "wildlife",
                "amount": 2,
                "descriptionZh": "获得2野生动物",
                "sourceCode": 105
              }
            ],
            "sourceEffectCodes": [
              105,
              105
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.12.slot.2",
            "position": 2,
            "outerCost": {
              "type": "spend_resource",
              "resource": "wildlife",
              "amount": 1,
              "descriptionZh": "支付1野生动物",
              "sourceCode": 5
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "forest",
                "amount": 3,
                "descriptionZh": "获得3森林",
                "sourceCode": 101
              }
            ],
            "sourceEffectCodes": [
              101,
              101,
              101
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.12.slot.3",
            "position": 3,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "mountain",
                "amount": 1,
                "descriptionZh": "获得1山",
                "sourceCode": 102
              },
              {
                "type": "take_photo",
                "payment": {
                  "anyResource": 1
                },
                "photos": 1,
                "descriptionZh": "支付1资源拍1照片",
                "sourceCode": 212
              }
            ],
            "sourceEffectCodes": [
              102,
              212
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.12.slot.4",
            "position": 4,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "trade_resources",
                "payment": {
                  "anyResource": 2
                },
                "gain": {
                  "wildlife": 2
                },
                "descriptionZh": "支付任意2资源，获得2野生动物",
                "contractRef": "modes.md#5-露营完整流程",
                "sourceCode": 214
              }
            ],
            "sourceEffectCodes": [
              214
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          }
        ]
      },
      {
        "id": "camp.face.13",
        "sourceFaceId": 13,
        "sourceSpriteRow": 7,
        "physicalTileId": "camp.tile.3",
        "physicalPairingReview": "adopted explicit TTS object pairing, both face images visually matched; non-publisher evidence",
        "slots": [
          {
            "id": "camp.face.13.slot.1",
            "position": 1,
            "outerCost": {
              "type": "spend_resource",
              "resource": "forest",
              "amount": 1,
              "descriptionZh": "支付1森林",
              "sourceCode": 1
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "sun",
                "amount": 5,
                "descriptionZh": "获得5太阳",
                "sourceCode": 103
              }
            ],
            "sourceEffectCodes": [
              103,
              103,
              103,
              103,
              103
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.13.slot.2",
            "position": 2,
            "outerCost": {
              "type": "spend_resource",
              "resource": "water",
              "amount": 1,
              "descriptionZh": "支付1水",
              "sourceCode": 4
            },
            "effectSteps": [
              {
                "type": "roll_trail_die",
                "times": 2,
                "descriptionZh": "掷步道骰2次，分别结算",
                "sourceCode": 110
              }
            ],
            "sourceEffectCodes": [
              110,
              110
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.13.slot.3",
            "position": 3,
            "outerCost": {
              "type": "spend_resource",
              "resource": "wildlife",
              "amount": 1,
              "descriptionZh": "支付1野生动物",
              "sourceCode": 5
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "mountain",
                "amount": 3,
                "descriptionZh": "获得3山",
                "sourceCode": 102
              }
            ],
            "sourceEffectCodes": [
              102,
              102,
              102
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.13.slot.4",
            "position": 4,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "take_shutterbug_badge",
                "descriptionZh": "取得摄影徽章",
                "sourceCode": 111
              },
              {
                "type": "take_photo",
                "payment": {
                  "anyResource": 1
                },
                "photos": 1,
                "descriptionZh": "支付1资源拍1照片",
                "sourceCode": 212
              }
            ],
            "sourceEffectCodes": [
              111,
              212
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          }
        ]
      },
      {
        "id": "camp.face.14",
        "sourceFaceId": 14,
        "sourceSpriteRow": 8,
        "physicalTileId": "camp.tile.4",
        "physicalPairingReview": "adopted explicit TTS object pairing, both face images visually matched; non-publisher evidence",
        "slots": [
          {
            "id": "camp.face.14.slot.1",
            "position": 1,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "choose_resource",
                "choices": [
                  "forest",
                  "mountain"
                ],
                "amount": 1,
                "descriptionZh": "获得1森林或1山",
                "sourceCode": 240
              },
              {
                "type": "choose_resource",
                "choices": [
                  "sun",
                  "water"
                ],
                "amount": 1,
                "descriptionZh": "获得1太阳或1水",
                "sourceCode": 241
              }
            ],
            "sourceEffectCodes": [
              240,
              241
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.14.slot.2",
            "position": 2,
            "outerCost": {
              "type": "spend_resource",
              "resource": "mountain",
              "amount": 1,
              "descriptionZh": "支付1山",
              "sourceCode": 2
            },
            "effectSteps": [
              {
                "type": "gain_resource",
                "resource": "water",
                "amount": 5,
                "descriptionZh": "获得5水",
                "sourceCode": 104
              }
            ],
            "sourceEffectCodes": [
              104,
              104,
              104,
              104,
              104
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.14.slot.3",
            "position": 3,
            "outerCost": {
              "type": "spend_resource",
              "resource": "sun",
              "amount": 1,
              "descriptionZh": "支付1太阳",
              "sourceCode": 3
            },
            "effectSteps": [
              {
                "type": "gain_any_resources",
                "amount": 2,
                "descriptionZh": "获得任意2资源；五类包含野生动物，可同种，受库存及项目即时上限限制",
                "interpretationStatus": "official-p5-generic-resource-definition-plus-printed-campsite-icon",
                "contractRef": "modes.md#5-露营完整流程",
                "sourceCode": 242,
                "allowedResources": [
                  "mountain",
                  "forest",
                  "sun",
                  "water",
                  "wildlife"
                ],
                "sameTypeAllowed": true,
                "resourceDefinitionSource": "official-1.1:p5"
              }
            ],
            "sourceEffectCodes": [
              242
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          },
          {
            "id": "camp.face.14.slot.4",
            "position": 4,
            "outerCost": {
              "type": "none",
              "descriptionZh": "无外层费用"
            },
            "effectSteps": [
              {
                "type": "parks_action",
                "opportunities": 1,
                "descriptionZh": "执行公园动作：预订1张，或游览任意多张可支付的公园",
                "sourceCode": 221
              },
              {
                "type": "take_photo",
                "payment": {
                  "anyResource": 1
                },
                "photos": 1,
                "descriptionZh": "支付1资源拍1照片",
                "sourceCode": 212
              }
            ],
            "sourceEffectCodes": [
              221,
              212
            ],
            "sourceRefs": [
              "bga-public-tutorial:CAMPSITES",
              "bga-campsite-faces",
              "bga-effect-labels"
            ],
            "behaviorContract": "modes.md#5-露营完整流程",
            "needsReview": false
          }
        ]
      }
    ],
    "setup": {
      "tilesUsedPerGame": 3,
      "unusedPhysicalTiles": 1,
      "faceChoice": "either side may face up",
      "campsitesPerSeason": 4,
      "behaviorContract": "modes.md#5-露营完整流程"
    },
    "projectInterpretations": {
      "contractRef": "modes.md#5-露营完整流程",
      "compoundActions": "每项基础动作必做；外层费用先付，内部动作费用不免；包含同一基础动作确定的先得后付；有限资源输出按现存及即时上限取得部分，实际可保留资源输出全0时拒绝付费。",
      "anyTwoResourcesPaid": {
        "allowed": [
          "mountain",
          "forest",
          "sun",
          "water",
          "wildlife"
        ],
        "sameTypeAllowed": true,
        "status": "project-decision"
      },
      "anyTwoResourcesGained": {
        "allowed": [
          "mountain",
          "forest",
          "sun",
          "water",
          "wildlife"
        ],
        "sameTypeAllowed": true,
        "wildlifeAllowed": true,
        "status": "official-p5-generic-resource-definition-plus-printed-campsite-icon"
      },
      "specifiedOuterCostWildlifeSubstitution": false,
      "partialOutput": {
        "cost": "must-pay-full",
        "gain": "available-stock-after-payment-subject-to-immediate-project-caps",
        "allZeroResourceOutput": "reject-as-explicit-project-rule",
        "randomOutput": "do-not-predict-or-reroll-unavailable-resource-results",
        "contract": "decisions.md#d05-有限资源与目的地合法性"
      }
    }
  },
  "rangerTeddy": {
    "cards": [
      {
        "id": "teddy.1",
        "referenceNumber": 1,
        "copies": 1,
        "ownBackSelection": "front",
        "ownBackDescriptionZh": "最前徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "parks",
          "trailEndDescriptionZh": "公园终点"
        },
        "sourceFields": {
          "frontRanger": 1,
          "move": 1,
          "trailEnd": 10
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.2",
        "referenceNumber": 2,
        "copies": 1,
        "ownBackSelection": "front",
        "ownBackDescriptionZh": "最前徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "photo",
          "trailEndDescriptionZh": "拍照终点"
        },
        "sourceFields": {
          "frontRanger": 1,
          "move": 1,
          "trailEnd": 11
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.3",
        "referenceNumber": 3,
        "copies": 1,
        "ownBackSelection": "front",
        "ownBackDescriptionZh": "最前徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "gear",
          "trailEndDescriptionZh": "装备终点"
        },
        "sourceFields": {
          "frontRanger": 1,
          "move": 1,
          "trailEnd": 12
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.4",
        "referenceNumber": 4,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "parks",
          "trailEndDescriptionZh": "公园终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 1,
          "trailEnd": 10
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.5",
        "referenceNumber": 5,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "photo",
          "trailEndDescriptionZh": "拍照终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 1,
          "trailEnd": 11
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.6",
        "referenceNumber": 6,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "gear",
          "trailEndDescriptionZh": "装备终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 1,
          "trailEnd": 12
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.7",
        "referenceNumber": 7,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "parks",
          "trailEndDescriptionZh": "公园终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 1,
          "trailEnd": 10
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.8",
        "referenceNumber": 8,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "photo",
          "trailEndDescriptionZh": "拍照终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 1,
          "trailEnd": 11
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.9",
        "referenceNumber": 9,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "next_available_space",
            "distance": null,
            "descriptionZh": "前进到下一个可用的未占用地点"
          },
          "trailEnd": "gear",
          "trailEndDescriptionZh": "装备终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 1,
          "trailEnd": 12
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.10",
        "referenceNumber": 10,
        "copies": 1,
        "ownBackSelection": "front",
        "ownBackDescriptionZh": "最前徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "parks",
          "trailEndDescriptionZh": "公园终点"
        },
        "sourceFields": {
          "frontRanger": 1,
          "move": 2,
          "trailEnd": 10
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.11",
        "referenceNumber": 11,
        "copies": 1,
        "ownBackSelection": "front",
        "ownBackDescriptionZh": "最前徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "photo",
          "trailEndDescriptionZh": "拍照终点"
        },
        "sourceFields": {
          "frontRanger": 1,
          "move": 2,
          "trailEnd": 11
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.12",
        "referenceNumber": 12,
        "copies": 1,
        "ownBackSelection": "front",
        "ownBackDescriptionZh": "最前徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "gear",
          "trailEndDescriptionZh": "装备终点"
        },
        "sourceFields": {
          "frontRanger": 1,
          "move": 2,
          "trailEnd": 12
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.13",
        "referenceNumber": 13,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "parks",
          "trailEndDescriptionZh": "公园终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 2,
          "trailEnd": 10
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.14",
        "referenceNumber": 14,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "photo",
          "trailEndDescriptionZh": "拍照终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 2,
          "trailEnd": 11
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.15",
        "referenceNumber": 15,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "gear",
          "trailEndDescriptionZh": "装备终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 2,
          "trailEnd": 12
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.16",
        "referenceNumber": 16,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "parks",
          "trailEndDescriptionZh": "公园终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 2,
          "trailEnd": 10
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.17",
        "referenceNumber": 17,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "photo",
          "trailEndDescriptionZh": "拍照终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 2,
          "trailEnd": 11
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.18",
        "referenceNumber": 18,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 2,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进2格，必要时与其他徒步者同位"
          },
          "trailEnd": "gear",
          "trailEndDescriptionZh": "装备终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 2,
          "trailEnd": 12
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.19",
        "referenceNumber": 19,
        "copies": 1,
        "ownBackSelection": "back",
        "ownBackDescriptionZh": "最后徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 3,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进3格，必要时与其他徒步者同位"
          },
          "trailEnd": "parks",
          "trailEndDescriptionZh": "公园终点"
        },
        "sourceFields": {
          "frontRanger": 0,
          "move": 3,
          "trailEnd": 10
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.20",
        "referenceNumber": 20,
        "copies": 1,
        "ownBackSelection": "front",
        "ownBackDescriptionZh": "最前徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 3,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进3格，必要时与其他徒步者同位"
          },
          "trailEnd": "photo",
          "trailEndDescriptionZh": "拍照终点"
        },
        "sourceFields": {
          "frontRanger": 1,
          "move": 3,
          "trailEnd": 11
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      },
      {
        "id": "teddy.21",
        "referenceNumber": 21,
        "copies": 1,
        "ownBackSelection": "front",
        "ownBackDescriptionZh": "最前徒步者",
        "front": {
          "movement": {
            "kind": "exact_spaces",
            "distance": 3,
            "shareOccupiedSite": true,
            "descriptionZh": "正好前进3格，必要时与其他徒步者同位"
          },
          "trailEnd": "gear",
          "trailEndDescriptionZh": "装备终点"
        },
        "sourceFields": {
          "frontRanger": 1,
          "move": 3,
          "trailEnd": 12
        },
        "sourceRefs": [
          "bga-public-tutorial:AUTOMA_CARDS",
          "official-1.1:p14-15",
          "bga-card-labels"
        ],
        "needsReview": false
      }
    ],
    "drawContract": {
      "movementSource": "刚翻到弃牌区的新牌正面",
      "rangerSelectionSource": "翻牌之后仍在牌堆最上方的另一张牌背面",
      "onePhysicalCardOwnsBothFaces": true,
      "warning": "不能用同一刚翻牌的ownBackSelection决定本次移动者；也不能把21个正面与背面分别随机。",
      "sourceRefs": [
        "official-1.1:p14-15"
      ],
      "behaviorContract": "modes.md#2-ranger-teddy-共用牌序与移动"
    },
    "backSelectionCounts": {
      "front": 8,
      "back": 13
    },
    "reviewLimit": "21个静态实体已全转录；官方示例与公开说明核动作语义，未逐张独立目视21张实体正反面。"
  },
  "volunteers": {
    "cards": [
      {
        "id": "volunteer.water-conservation",
        "referenceNumber": 1,
        "name": "Water Conservation",
        "zhNameProvisional": "节约用水",
        "copies": 1,
        "ruleZh": "自己的回合中只要获得过太阳，就失去1水（有水可失去时）。",
        "requiredRuleHooks": [
          "resource-gain",
          "per-turn-history"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "具体结算时点与季末奖励窗口见M10。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false
      },
      {
        "id": "volunteer.wildlife-conservation",
        "referenceNumber": 2,
        "name": "Wildlife Conservation",
        "zhNameProvisional": "野生动物保护",
        "copies": 1,
        "ruleZh": "背包中的野生动物任何时候都不能超过1。",
        "requiredRuleHooks": [
          "resource-gain",
          "backpack-capacity"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "即时上限1；付费换2可按预览保留实际1，不足不减费，实际输出全0才拒绝。见M05、M10。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false
      },
      {
        "id": "volunteer.sustainable-transportation",
        "referenceNumber": 3,
        "name": "Sustainable Transportation",
        "zhNameProvisional": "可持续交通",
        "copies": 1,
        "ruleZh": "只能游览自己的预订公园。",
        "requiredRuleHooks": [
          "park-visit-legality"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "公共展示牌须先经独立预订机会取得；不允许同一公园机会先预订再游览。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false
      },
      {
        "id": "volunteer.responsible-consumption",
        "referenceNumber": 4,
        "name": "Responsible Consumption",
        "zhNameProvisional": "负责任消费",
        "copies": 1,
        "ruleZh": "每购买1件装备，背包容量减少1资源。",
        "requiredRuleHooks": [
          "gear-purchase-history",
          "backpack-capacity"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "购买记录、免费获得与容量下界及检查时点见M10。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false
      },
      {
        "id": "volunteer.environmental-studies",
        "referenceNumber": 5,
        "name": "Environmental Studies",
        "zhNameProvisional": "环境研究",
        "copies": 1,
        "ruleZh": "必须持有摄影徽章才可以取得照片。",
        "requiredRuleHooks": [
          "photo-gain-legality"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "对免费照片及营地先取徽章再拍照的统一解释见M10。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false
      },
      {
        "id": "volunteer.climate-action",
        "referenceNumber": 6,
        "name": "Climate Action",
        "zhNameProvisional": "气候行动",
        "copies": 1,
        "ruleZh": "天气不再摆放太阳；水天气仍放在原本的水位置。",
        "requiredRuleHooks": [
          "weather-setup"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "不将空出的太阳位置改放水。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false
      },
      {
        "id": "volunteer.reduce-emissions",
        "referenceNumber": 7,
        "name": "Reduce Emissions",
        "zhNameProvisional": "减排",
        "copies": 1,
        "ruleZh": "从本局公园牌中移除全部印刷2分和3分的牌。",
        "requiredRuleHooks": [
          "park-deck-setup"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "按原始印刷分筛选，不按实际费用或是否有即时奖励筛选。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false,
        "excludedParkIds": [
          "arches",
          "biscayne",
          "canyonlands",
          "carlsbad-caverns",
          "channel-islands",
          "congaree",
          "crater-lake",
          "cuyahoga-valley",
          "death-valley",
          "dry-tortugas",
          "everglades",
          "gates-of-the-arctic",
          "gateway-arch",
          "grand-teton",
          "hot-springs",
          "indiana-dunes",
          "isle-royale",
          "joshua-tree",
          "katmai",
          "kobuk-valley",
          "lake-clark",
          "mammoth-cave",
          "saguaro",
          "white-sands"
        ],
        "excludedParkCount": 24
      },
      {
        "id": "volunteer.leave-no-trace",
        "referenceNumber": 8,
        "name": "Leave No Trace",
        "zhNameProvisional": "无痕山林",
        "copies": 1,
        "ruleZh": "每季开始时营火保持熄灭。",
        "requiredRuleHooks": [
          "season-start",
          "campfire-state"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "是否仍可用装备在季中重新点燃见M10。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false
      },
      {
        "id": "volunteer.carbon-offsetting",
        "referenceNumber": 9,
        "name": "Carbon Offsetting",
        "zhNameProvisional": "碳补偿",
        "copies": 1,
        "ruleZh": "每次游览公园之前，额外支付1山或1森林。",
        "requiredRuleHooks": [
          "park-visit-payment"
        ],
        "behaviorContract": "modes.md#6-志愿项目与规则修正",
        "interpretationNote": "额外费用与普通费用、减免及野生动物替付的统一解释见M10。",
        "sourceRefs": [
          "bga-public-tutorial:VOLUNTEERS",
          "bga-card-labels:getVolunteerData",
          "official-1.1:p16"
        ],
        "needsReview": false
      }
    ],
    "supportedHumanPlayerCounts": [
      1,
      2,
      3,
      4,
      5
    ],
    "projectsPerGame": [
      0,
      1,
      2,
      3,
      4
    ],
    "selection": "shuffle and draw chosen quantity; keep chosen rules active for the game",
    "difficultyLabels": {
      "0": "不使用志愿项目",
      "1": "Beginner",
      "2": "Intermediate",
      "3": "Advanced",
      "4": "Extreme"
    },
    "behaviorContract": "modes.md#6-志愿项目与规则修正",
    "reviewLimit": "9张规则文字来自公开教程的用户说明，官方p16确认数量、适用人数及选用流程；不是9张实体卡逐张官方照片核验。"
  },
  "fixedComponents": {
    "tents": {
      "count": 3,
      "ids": [
        "tent.1",
        "tent.2",
        "tent.3"
      ],
      "initialTrailPositions": [
        5,
        7,
        9
      ],
      "positionConvention": "起点为0，9个普通地点从1到9；第5为主板固定Parks。",
      "sourceRefs": [
        "official-1.1:p2-3,p17",
        "bga-trail-display"
      ],
      "effectZh": "到有帐篷地点时，可照常行动或把该帐篷移到本季空营位并执行营地动作；营地替代该地点的天气、地点动作、地点型装备及取得摄影徽章。季末帐篷回原位置。",
      "behaviorContract": "modes.md#5-露营完整流程"
    },
    "soloReference": {
      "count": 1,
      "id": "solo-reference",
      "sourceRefs": [
        "official-1.1:p16"
      ],
      "actionSummary": [
        {
          "condition": "遇有帐篷地点且启用露营",
          "effect": "移帐篷至最右空营位；不执行该营位收益，并不处理原地点天气、徽章或地点动作。完整优先级见模式合同。"
        },
        {
          "condition": "普通天气地点",
          "effect": "天气资源归池。"
        },
        {
          "condition": "摄影标记地点",
          "effect": "Teddy取得摄影徽章。"
        },
        {
          "condition": "公园动作地点",
          "effect": "移除最右展示公园，剩余右移并补位。"
        },
        {
          "condition": "装备动作地点",
          "effect": "移除最右展示装备，剩余右移并补位。"
        }
      ],
      "seasonQualification": {
        "spring": {
          "minimum": 3,
          "metric": "当季春季块指示的背包资源数量"
        },
        "summer": {
          "minimum": 4,
          "metric": "当季夏季块指示的统计量"
        },
        "fall": {
          "minimum": 5,
          "metric": "当季秋季块指示的已游览公园印刷资源量"
        }
      },
      "scoreRanks": [
        {
          "minimumScore": 30,
          "label": "Dayhiker"
        },
        {
          "minimumScore": 35,
          "label": "Trekker"
        },
        {
          "minimumScore": 40,
          "label": "Explorer"
        },
        {
          "minimumScore": 45,
          "label": "Adventurer"
        },
        {
          "minimumScore": 50,
          "label": "Trailblazer"
        }
      ],
      "photoRankingBonusUsed": false,
      "behaviorContract": "modes.md#4-官方单人"
    }
  }
});
