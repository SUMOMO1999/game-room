# PARKS 资料来源与开源调查

调查基线：2026-10-09；2026-10-11增加[独立规则资料复核](independent-review.md)。结论：**二版基础内容与全部可选模块已逐项定义；露营配对在v0.4采用有明确对象关联的公开数字组件，来源置信边界单列。公园取得两来源交叉核验及独立逐图441字段核对，其余目录的具体核验层级分别记录。原次核查的四个公开仓库，没有可直接接入的完整 PARKS 二版实现。** 原书少数边界仍需采用明确项目解释。公开可见、允许改代码、允许发布卡图是三件事。

## 1. 规则与完整卡面来源

### 发行商及官方规则书

- [Keymaster 二版产品页](https://keymaster.fun/products/parks-2nd-edition)：明确1～5人、40～70分钟、63座公园；比较表区分一版48张与二版63张。
- [PARKS 2nd Edition 1.1 官方规则书](https://cdn.shopify.com/s/files/1/1898/8501/files/Parks-2nd-Edition-1.1-Rules_Online.pdf?v=1755706180)：本次实际读取组件页1、开局2～3、徒步4～5、公园6～7、照片／水壶／装备8～9、热忱10～11、季末与计分12～13及末页速查。最终RV另逐页读取14～17的双人Teddy、官方单人、志愿项目与露营；普通电脑与Teddy分开定义。规则PDF共11个跨页；本文页码均指印刷页码。
- [官方全63公园牌图](https://keymaster.fun/cdn/shop/files/All-63-white_45353b61-4374-415b-9e62-0de83605bd1b.jpg?v=1747268405)：来自上述产品页，实际取得3000×6463原图、7列×9行。63张名称、分值、费用与即时效果已逐格目视转录；与公开教学目录每张7项规则字段合计441项一致，0规则差异。名称以官方图为准，BGA的King's Canyon／Cuyahoga两个差异记录在JSON。2026-10-11另一规则阅读角色实际看完18份裁剪，先另录63元组再读目录，独立441字段比较0差异；原图与元组摘要、方法及未验范围见[独立复核](independent-review.md)。
- 规则书印刷页11有完整10种热忱目标／分支表；所以不能再笼统称“规则书没有逐卡表”。它仍未覆盖全部装备、水壶和季节目录。

原PDF及查证图片仅在本地临时资料区保存，未放入项目资产、公开文档附件或发布包。按规则事实自行组织设计，不整份翻译／复制原规则书作为产品文案。

### 已授权数字版与其他局部资料

- [BGA 二版发布说明](https://en.boardgamearena.com/news?id=936)，2025-07-04：明确感谢Keymaster及Henry Audubon授权。证明存在成熟数字实现，可用于参考；不证明源码或素材向第三方开放。
- [BGA 公开规则帮助](https://en.doc.boardgamearena.com/Gamehelpparks)：实际读到二版三季、营火、水壶、装备等摘要。与官方书的概括差异需回源核对，不把它当完整牌库或优先于印刷规则的勘误。
- **[BGA匿名公开教程](https://boardgamearena.com/tutorial?game=parks)**：本轮新增完整来源。无需登录的教学HTML包含固定版本 `250417-1214` 静态公园、装备、水壶、热忱、季节和地点字典。只读并独立转述规则事实，没有访问私局、取得真实账号资料、运行引入其服务代码或复制图片入库。由此核得37种装备定义／13名称、6类24水壶、春夏秋各4块，以及骰面／地点映射；公园与官方图交叉校验。该教学版本早于官方1.1文件，不能把它的存在当成当前BGA全部行为或后续勘误证据。
- **季节映射的校正与依据**：公开教程实际页面的 `s2-n2` 夏季块目视为“水壶最多”，对应静态指标502；官方印刷页2示例明确有“装备上的太阳最多”。其余两类已由资源／即时公园定义确认，此前501通过穷尽对照对应装备印刷太阳合计。最终RV另只读教程公开引用的`pks-effects.js`帮助文字，501直接描述装备合计太阳费用、502直接描述水壶枚数，现有直接文本佐证，不再仅为排除推导；没有执行脚本。完整37装备的独立实体图复核尚未完成。
- [Josh Emrich 二版美术访谈](https://www.moregamesplease.com/art-in-boardgames/2025/4/18/josh-emrich-parks-2nd-edition-art-in-board-games-72)：实际观察到少量装备图。Camp Mug、Telephoto Lens的费用与效果图标可读；Field Guide部分费用被裁，不能补猜。此类照片不证明37张装备与重复数量已齐。
- [BGG 一二版组件比较](https://boardgamegeek.com/filepage/299364/parks-comparison-of-1st-and-2nd-edition-components)：搜索索引说明作者coasteray整理11页，涉及装备、公园、季节、热忱、水壶等。**附件未取得并逐页复核，不能作为齐套结论。** 后续能正常取得则优先核验，不反复绕过403。
- [BGG 二版规则附件讨论](https://boardgamegeek.com/filepage/293507/parks-2nd-edition-rulebook)：本轮读到署名设计者Mattox Shuler关于地点触发／动作触发的完整检索答复；原页直读仍未成功。用作与官方p9一致的有限佐证，保留“检索文本”证据层级，不标为直接验证的官方勘误，也不外推到照片并列或热忱限次。

## 2. 四个公开仓库的实际内容

通过公开GitHub仓库元数据、目录、包声明和相关源码只读核查；没有运行、安装或引入任何候选代码。固定提交便于复查，不使用以后可能变化的首页描述充当证据。

### DefBo/parks-board-game

[仓库](https://github.com/DefBo/parks-board-game)，默认分支main，核查提交 `338c08a00a03145426d43ac502263e371340ae1d`。

已看全树、package.json、[首页](https://github.com/DefBo/parks-board-game/blob/338c08a00a03145426d43ac502263e371340ae1d/src/app/page.tsx)及`src/app/components/trail/trail-site/trail-site.tsx`。实际是Next.js／Storybook起步，地点组件仅显示一段文字；没有可玩的规则、卡库或多人流程，无法认定版次。全树无LICENSE，包声明无许可字段。

**采用结论：不作为引擎或内容依赖。** 同名仓库不等于有完成的游戏。

### shanks2502/Parks-Board-Game-Scorer

[仓库](https://github.com/shanks2502/Parks-Board-Game-Scorer)，默认分支main，核查提交 `6832f2585b84678e84ec3d487c002ce688cae08f`。

已看全树、replit.md、包声明及[计分页面](https://github.com/shanks2502/Parks-Board-Game-Scorer/blob/6832f2585b84678e84ec3d487c002ce688cae08f/artifacts/parks-scorer/src/App.tsx)。让人手填公园、热忱、照片等数值，计算奖励；从术语与4／2分照片奖励推断偏二版，仓库未明示版次。没有路径移动、动作合法性、季节状态机、完整卡组或电脑对手，计分边界本轮未验收。

根package.json有`license: MIT`字段；全树未见LICENSE正文，应用包没有独立许可字段，GitHub元数据为`license=null`。如未来确要复制代码，先核清适用许可和保留声明；本次不复制。MIT字段不能授予官方卡图或品牌的权限。

**采用结论：可看计分信息组织，不把它当已验证的规则或引擎。**

### pandaking04/ParksBoardgame

[仓库](https://github.com/pandaking04/ParksBoardgame)，默认分支master，核查提交 `50cd4957fe71351e91f38124f0900af9b691025a`。

已看全树、[游戏规则](https://github.com/pandaking04/ParksBoardgame/blob/50cd4957fe71351e91f38124f0900af9b691025a/GAME_RULES.md)、`js/game.js`和`js/data.js`。这是80张泰国公园、任务和效果的同主题改编；文档12回合，代码`MAX_TURNS=20`、背包上限8、单个player状态。不是Keymaster一版或二版。全树无LICENSE，未见官方卡图授权。

**采用结论：不移植规则、卡库或美术。** 季节和装备同名不能证明底层相同。

### nilsdi/parks_cards

[仓库](https://github.com/nilsdi/parks_cards)，默认分支main，核查提交 `eb90b40b4803877279bdb68b0d862660426e990c`。

描述为挪威国家公园自制新卡工具。已看全树、setup.py、`parks_cards/generate_original_json.py`和[original_cards_costs.json](https://github.com/nilsdi/parks_cards/blob/eb90b40b4803877279bdb68b0d862660426e990c/data/card_details/original_cards_costs.json)。后者实际100条，命名条目0、非零费用条目0；生成脚本也生成空白记录。它不是一版48卡或二版63卡的真实费用目录。没有游戏引擎，全树无LICENSE。

**采用结论：不能用作卡库。** 文件名包含original或costs不代表数据有效。

以上是本次有界调查的结论，**不是“全网绝不存在”的证明**。未找到成熟代码不影响独立实现；公开教学现已补足目录事实，不再为寻找可抄引擎无限扩大搜索，也不更换现有棋牌室框架。独立定义内容不等于取得BGA源码或美术许可。

## 3. 美术与公开发布边界

- [Fifty-Nine Parks FAQ](https://59parks.net/pages/faq)明确其作品有版权、不是公共领域，并提供合作授权渠道；[其PARKS商品页](https://59parks.net/products/parks-board-game)说明原版停印后新版使用其他美术。这个声明直接对应一版美术，不代表该作者拥有二版插画。
- 二版官方页和美术访谈能用于研究，未发现开放再分发许可；BGA获得的授权也不自动转授我们。公开源码许可和其目录中美术的许可分开核对。
- [NPS 图片入口](https://www.nps.gov/aboutus/news/photosmultimedia.htm)及[使用说明](https://www.nps.gov/aboutus/disclaimer.htm)提供备选；具体照片按作者、权利说明和署名条件逐张选择，不能把整个NPS站点的所有内容当公共领域。标志另有边界。
- 本项目建议原创牌框、图标和自行表述规则，风景采用原创或许可清楚的来源。官方品牌名称、整套原版视觉和公开发行范围须单独明确；换几幅图不自动等于取得原版授权。

## 4. v0.4收口审查范围

已形成共同主稿、146份基础牌／标记的事实清单、地点与骰面、全部可选面效果／Teddy正反配对／9志愿项目、三个结构化目录、功能合同、完整交付清单及D01～D11／M01～M10项目解释。公开教程的静态帮助补齐项目逐卡文字和营位语义；只摘录事实、自行组织定义，不引入第三方执行逻辑或美术。

本轮取得[公开二版TTS组件](https://steamcommunity.com/sharedfiles/filedetails/?id=3553489350)的4个明确FaceURL/BackURL对象，8图逐面对应后采用1/12、2/11、3/13、4/14；实物照片的可见四面无冲突。作者Kosjenka并非发行商，这项是明确二手数字关系，未提升成官方实物独立认证，详见[配对证据](camping-pairing.md)。本次没有把TTS作为可运行依赖。

另以官方p5纠正任意资源排除野生动物及付费奖励必须拿足的错误解释；逐枚新水、复合动作先得后付、无人可前进及照片事件分别固定出口。[Cameron Art的Wildlife署名答复检索文本](https://boardgamegeek.com/thread/3521562/wildlife-passion-gear-effect-question)佐证一次和3张上限，原页直读403，仍只作有限佐证。

原次v0.4调查没有制作美术、复制游戏程序、实现引擎、跑完整对局或发布。后续Step 0已制作自有代表资源与隔离样板，当前实施状态见[技术计划](../../plans/parks-v1.md#10-当前进度与交接记录)；全部资源与运行验收仍分别把关。公开资料的版权及发布表述边界仍按第3节，不能把设计完成当作公开原作素材的许可。
