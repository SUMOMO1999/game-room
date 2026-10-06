# 分类模板参考与采用范围

查阅日期：2026-10-06。借鉴官方文档拆解问题的方法；本项目未因此接入新框架、万能卡牌引擎或商业游戏内容。以下是本项目设计判断，不是参考平台的完整规则。

## 采用的做法

**内容定义与对局状态分开。** BGA [材料定义说明](https://en.doc.boardgamearena.com/Game_material_description:_material.inc.php)把类型、说明和费用作为静态资料。模板要求完整的本轮内容目录；本项目另外要求旧局绑定版本，避免新卡文本重解释旧存档。

**类型与每个副本分开。** BGA 当前[ItemManager](https://en.doc.boardgamearena.com/ItemManager)区分唯一编号、位置与顺序，适用于卡牌之外的物件。模板分别定义一种卡是什么、这张副本在哪里、谁拥有/控制以及状态；相同副本共用定义。旧 Deck 已标弃用，不将其接口写成实施要求。

**谁能做、何时做、做后去哪里。** BGA 当前[状态类文档](https://en.doc.boardgamearena.com/State_classes:_State_directory)区分单人、多人、私有并行与自动阶段。模板逐阶段写行动者和出口；不照抄PHP结构，没有多人回应的游戏可省去相关章节。

**回合内可能有他人的回应。** boardgame.io [阶段](https://raw.githubusercontent.com/boardgameio/boardgame.io/main/docs/documentation/phases.md)与[回合子阶段](https://raw.githubusercontent.com/boardgameio/boardgame.io/main/docs/documentation/stages.md)展示阶段动作及多玩家在同回合行动。模板要求回应者、完成条件、截止和恢复点，具体优先级由本游戏确认。

**秘密由服务器控制发送范围。** boardgame.io [私有状态文档](https://raw.githubusercontent.com/boardgameio/boardgame.io/main/docs/documentation/secret-state.md)说明按玩家过滤，以及服务器执行依赖秘密的动作。模板沿用共通投影，并独立查提示、日志、错误、预览与观众；画面隐藏不等于权限保护。

**卡牌文字需要可执行的解释。** Magic [官方规则入口](https://magic.wizards.com/en/rules)区分入门规则与边界参考。桌游模板借鉴成本、触发、结算与替换分类：何时付费、谁选择、目标失效怎么办、多效果怎样排顺序。具体规则由本游戏确认，简单游戏不强制使用其栈、层或优先权。

**先选版本，再分机制与内容。** [三国杀国战进行游戏说明](https://guozhan.sanguosha.com/game_rule/game.html)分别讲阶段内行为并指向逐牌效果。该页只代表特定国战说明，不能当作所有三国杀的统一规则。[游戏名拆解指引](from-game-name.md)据此要求先限定模式与初版目录，再定义机制、内容与验收。

## 本项目补充的门槛

- [Step 0](resource-stage.md)来自实际资源与交互迭代：样板先上屏，整套资源在完整接入前齐备，数字/花色统一绘制，特殊类型有可辨图形。
- [逐卡定义](templates/card-definition.md)连接玩家说明、权威效果、资源和合法/非法例子。定义单位是具有独特行为的一种卡，不是每个重复副本。
- 每版定义所有可入局内容；未来扩展留接入方式，新机制仍需设计、实现与验证，不能承诺只填数据就能实现任意玩法。
- 用可检查清单和例子覆盖常见问题。尚未用模板完成新游戏验收，不给出70%或80%的覆盖率，也不保证所有设备一次完成。
- 本项目主游戏不滚动、一屏操作的约定保持；其他平台允许的滚动或默认布局不自动成为这里的产品要求。

详细参考只在相关机制出现时阅读。规则、内容、资源与模块各有来源和责任，不复制商业卡面、品牌、插画、音频或完整规则书作为自己的资产。
