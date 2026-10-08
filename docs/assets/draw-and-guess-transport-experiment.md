# 你画我猜 Step 0 传输与事务实验

下文为2026-10-07阶段实验的历史记录，不能视为当前是否上线的结论；经典模式已上线，实际范围见[实现与发布范围](../development-drawing.md)。

2026-10-07，本机隔离实验。高频传输结论仍为 **P1_BLOCKED**：500ms 远端体验和现有 E3 共享容量尚未通过。用户随后授权继续完成本地正式模块，已补共通事务底座和画布服务／HTTP合同，下文分开记录其验证；这些局部证明不代替高频容量验收。Step 0 本身没有改生产注册、身份、旧三款、九 scope 备份、云配置或 Git；后续共通装配与备份工作由主任务另记。

## 可复跑入口与证据边界

```sh
node --test --test-concurrency=1 app/draw-and-guess-transport.test.mjs
node tools/draw-and-guess-step0/transport-experiment.mjs > /private/tmp/draw-step0-report.json
```

Node v22.23.2、SQLite 3.53.4、真实 AES-GCM SQLite/WAL、本机 HTTP 与 SSE。脚本只在 127.0.0.1 随机端口监听，使用虚构 drawer、7 guesser、8 spectator；数据库与密钥由本轮生成，关闭后精确清理。服务不读取环境秘密或访问 Agora、Cognito、AWS。默认沙箱不允许监听时，需要批准本机端口执行权限；这不是云或费用授权。

120/600 秒是固定轨迹的**等效输入时间**，不是实际连续运行时长。每秒 60 点，三角函数轨迹、每两秒新笔画；真实每批 POST 和全部 16 条 SSE 均实际发送、解析并等收件人到齐。每 10 秒七位猜者各提交一次合成猜测，每 15 秒八位参赛者各发一次持久聊天，中途一位观众真实断流重连。猜测仅有合成流量回包，没有答案、判词或计分；键盘/浏览器绘制由页面实验另验。

身份台账中的 `actualIdentityChecks` 是实际调用的**fresh 合成授权函数数量**，不是向真实中央发送的次数。主负载替身没有生产 4rps 排队，因而快延迟只证明本机存储/传输；没有把成功替身当缓存。15 秒 watchdog 在压缩墙钟下不运行，另按等效时长增加 128/640 次，分列保存。另用**未修改的** `IdentityPolicyClient`、虚拟调度器和 50ms 合成六字段响应做两次16主体突发：32 次逻辑检查仅发送 20 次合成上游，保留精确 token 的在途合并、没有成功缓存；核验 p95 为 3800ms。没有假称32次必然32次真实上游，也没有假称在途合并能满足500ms。

`actualSseReceiveP*` 是批次发起→客户端 SSE JSON 解析；`equivalentPointToReceiveP*` 另加入该点在固定批周期内的等候时间。它不是浏览器绘制、手机触摸或公网延迟。本机落笔≤50ms尚须页面测量，不能从这些数字推出。

## 五场实际观测

最终复跑的完整 JSON 含每场计数、身份用途、请求桶、每批/快照 payload p95、CPU、RSS、WAL、提交/ack时延及独立 SQLite 副本读回。下列数字由该实际结果回写，毫秒/资源量随主机负载变化，不是 SLA。其后增加 `bootId` 实例围栏，当前专项24/24通过；原JSON和以下p95/字节数字保留为该字段增补前测量，没有重跑或把旧字节数冒称当前字段实测。

<!-- measurement-summary:start -->
最终复跑时间 `2026-10-07T02:52:34.288Z`；专项22/22通过，fail/cancelled/skipped/todo全部0。以下流量为字节，RSS/WAL保持原始字节可复核。

- **120秒、1房、1000ms增量**：实际墙钟1257.28ms，CPU1041.97ms；HTTP286（POST269/GET17），实际fresh3549、含等效watchdog3677，即30.642/s。SSE2994次/2673515B；HTTP入144851B/出40420B。实际SSE解析p50/p95=6.08/9.32ms，含等效点等候501.82/951.82ms；持久ack p95=6.80ms，185次事务、COMMIT p95=0.505ms。WAL峰4239512B、主库409600B；payload p95身体1153B、画布增量1169B、完整快照112100B。RSS从53297152B至峰159612928B。一致副本3.61ms/266240B，读回120序号/7200点。
- **600秒、1房、1000ms增量**：墙钟16467.29ms，CPU15818.57ms；HTTP1359（1341/18），fresh17471、含watchdog18111，即30.185/s。SSE14770次/13071148B；HTTP入726926B/出498773B。实际解析p50/p95=20.24/37.75ms，点等候520.54/970.54ms；ack p95=32.45ms，921事务、COMMIT p95=2.433ms。WAL4976992B、主库2162688B；身体1157B、增量1172B、快照560840B。RSS165511168→峰372228096B。一致副本12.13ms/1200128B，600序号/36000点。中途完整图超流预算后真实GET只读恢复，GET因此为18。
- **120秒、1房、600ms增量**：墙钟1806.41ms，CPU1311.42ms；HTTP366（349/17），fresh4989、含watchdog5117，即42.642/s。SSE4274次/2981596B；HTTP入161368B/出52516B。实际解析p50/p95=5.96/10.13ms，点等候305.24/578.94ms；ack p95=7.57ms，265事务、COMMIT p95=0.628ms；WAL4284832B、主库491520B。身体776B/增量790B/快照112100B；本场起始及峰RSS394510336B，含前场未释放统计/运行时。副本3.88ms/286720B，200序号/7200点。
- **120秒、1房、1000ms完整快照对照**：墙钟4403.87ms，CPU4702.97ms；请求及核验同第一场，SSE2994次/114850651B，增量对照的42.96倍。解析p50/p95=29.16/56.88ms，点等候530.19/980.19ms；ack p95=41.62ms，COMMIT p95=0.845ms；画布事件p95=112117B。RSS365871104→峰367706112B；WAL4239512B。副本4.07ms，120序号/7200点。
- **120秒、2独立房、1000ms增量对照**：墙钟2499.51ms，CPU1845.00ms；HTTP572（538/34），fresh7098、含watchdog7354，即61.283/s；SSE5988次/5347030B。解析p50/p95=6.17/9.98ms，点等候503.65/953.65ms；两库各185事务、ack p95=7.01/7.05ms，COMMIT p95=0.595/0.556ms、WAL各4239512B。RSS366280704→峰375701504B；副本8.42/5.38ms、各120序号/7200点。

五场锁错误和流背压断开均0；写入队列观测峰均1条、最大1162B（测试另验证SSE慢消费者断开）。主负载用户/IP桶按现规则实际执行，成功请求和拒绝计数保留在JSON；未取消限流。负载中持续连接17/34是累计打开次数，每房同时最多16。批次轨迹全部收到，没有用预览成功填持久ack。
<!-- measurement-summary:end -->

每条已提交画布更新实际 fan-out 为16；120秒/1s有120批、1920次画布交付，初始接管还有16次替换交付。流事件总数另含初包、聊天与重连。持续连接保持最多16，累计17；两房对照累计34。主实验两房各有独立 SQLite 与请求桶，两房的流同时打开，逐批对照不证明同库多房竞争、统一全服务限额或20真人联合容量，所以不能冻结“允许两房”。

CPU 和 RSS 包含同一个 Node 进程中的服务器、16/32个合成接收端、轨迹和统计数组；不是生产服务单独的内存需求。WAL取每次实验事务后实际文件长度峰值；提交时延含同步 `BEGIN IMMEDIATE`、写入、COMMIT，不独立拆锁等待。本轮负载没有锁错误；另用二连接持锁与1ms实验忙等验证失败不部分写，不能当生产5秒忙等时延实证。SQLite `VACUUM INTO` 一致副本读回证明本实验图/序号能恢复，不是正式签名 manifest、九/十三scope兼容或故障灾备验收。

## 事务决定与已证实边界

Step 0 当时保留 `server/storage.mjs` 原样，其 `guardedCAS` 只有一个版本前提，不能宣称已经满足新游戏。实验的独立 `LabSQLite.transaction` 在一个短、同步 `BEGIN IMMEDIATE` 内检查 room、presence、writer lease、canvas 四个存储版本及记录存活，再原子写 canvas + renewed lease；开始与提交前均要求时钟严格小于绘画期限和原租约期限。房间状态必须预读为 drawing/未暂停/本人画者，版本在事务内锁定；状态改变会令旧版本提交失败。实验只在写入 COMMIT 成功后广播和回复持久 ack。后续正式底座使用下节的新合同，没有把这个实验子类搬到生产。

24项专项证明：原22项包括精确重放不追加、同编号改正文拒绝、缺序只读恢复、清空后旧包不复活、撤销/重做持久化、设备接管代际、截止恰好相等/暂停/揭晓拒绝、四种前提由第二 SQLite 连接在准备后改版本均冲突、提交前越过期限全回滚、点数/坐标/角色限制、真实HTTP/SSE提交先于交付、120用户/240IP限额、慢接收队列断开、大图恢复提示、fresh 401不输出图及提交后401为未知结果、原E3client突发、SQLite写锁拒绝不部分成功。新增两项验证实例UUID重开稳定、新建实例不同；并增强真实HTTP/SSE测试，核对快照、增量、替换、恢复提示、acquire、ack与duplicate的 `bootId` 一致。fail/cancelled/skipped/todo全部0。

这个证明依赖所有相关业务修改都更新自己的存储版本。后续共通底座分别验证 Memory/SQLite 和第三个不同业务的合成库存模型；业务可用 `guards:[]`，但每条 change 都有明确 expectedVersion，未知或不规范版本、重复change以及冲突的guard/change组合会拒绝。不能让房间阶段/presence在事务外改内存而不改版本。活动身份本身是外部 E3 核验，不可能宣称与本机 SQLite 共享原子提交；提交后授权失败必须返回未知结果、停私人输出并只读对账，不能回滚已确认数据或自动重发。

restart测试是在**同一对象内持有临时key、关闭并重新打开SQLite adapter**；确认图恢复而 `boot` 变化使旧租约失效。没有跨 Node 新进程、正式密钥交接、备份恢复、401后真实新登录会话代际或原账号生命周期的证明。这些仍是P3/P5门槛。

本机服务重新创建会产生新临时库，sequence/leaseGeneration/clearGeneration都可能从0开始，客户端不能仅因新值较低就沿用旧图。实验公开 `bootId` 在每次 `createCanvasLab` 时生成一次UUID；同一对象重开adapter保持，新的lab对象必不同，且它不从SQLite或业务备份恢复。它与私有writer `boot` 分开：writer `boot` 重开时变化并作废旧租约，公开 `bootId` 仅区分这次临时实验实例。所有快照、画布增量/替换、recovery hint、ack（包括duplicate）、acquire携带同值，聊天包/回执也携带，便于页面统一围栏。

页面收到新SSE snapshot/recovery的不同 `bootId` 时，应切换实例并清旧确认图、本机未确认笔迹、序号、清空代际和设备授权，然后只读恢复；来自被替换实例的迟到HTTP/ack/SSE不得修改新实例状态。该编号不是身份、房间资格、租约或持久恢复证明。本实验新增测试证明服务端字段语义与重开/新建行为，页面迟到包和清理行为由页面测试另验。

## 后续正式底座与画布本地证明

用户授权后新增 [共通事务底座](../../server/storage.mjs)、[画布领域服务](../../server/games/draw-and-guess/canvas-service.mjs) 和 [画布HTTP桥接](../../server/games/draw-and-guess/canvas-http.mjs)，没有直接改注册、云配置或中央身份协议。

```sh
node --test --test-concurrency=1 app/storage-many-transaction.test.mjs app/storage-v1.test.mjs app/chat-server.test.mjs app/store-backup.test.mjs
node --test --test-concurrency=1 app/draw-and-guess-canvas-service.test.mjs app/draw-and-guess-canvas-http.test.mjs
```

第一组66/66通过：新事务33项、旧storage6项以及聊天／备份回归。第二组42/42通过：30项画布领域与12项HTTP合同，Memory和真实SQLite都保存加密数据。HTTP合同测试直接调用真实桥接、SessionService与SQLite，身份上游仅合成provider，不监听网络；真实统一HTTP/SSE生命周期由主任务的装配测试另验。没有重新执行前述p95负载，不能把这些42项当当前生产吞吐测量。

共通 API 为 `storage.compareAndSwapMany({changes,guards,validUntil}) -> boolean`。change包含 `scope/id/expectedVersion/value/expiresAt?`；`value:null`按版删除，`expectedVersion:null`表示逻辑不存在或已过期。guard包含 `scope/id/expectedVersion/validUntil?`。真实版本须是read返回的43字符revision，scope拒绝非法语法，业务scope白名单留给所属领域。全事务最多64个不同key、32MiB密文；调用方不能传另一个now绕过存储时钟。旧guardedCAS接口保持。

SQLite在 `BEGIN IMMEDIATE` 后和COMMIT前分别检查全部原版本、原记录有效期限、guard/global期限和将写记录期限；原记录即使被覆盖或删除，也必须一直存活到COMMIT。Memory同步检查后一次替换Map。失败条件返回false且零部分写；语句／COMMIT故障抛出并回滚。若COMMIT确实成功但确认过程抛出，结果属于未知，不返回false、不释放已用额度、不盲重试。测试实际使用同库两个SQLite连接、锁争用、跨期限、epoch变化、COMMIT前后故障、重开adapter和新Node进程同合成key，验证第三个库存业务合同没有依赖游戏名。

画布绑定 `roomId+matchId+turnId`，其canvasId由三者确定；只在 roomPhase=playing、stage=drawing、未暂停、本人当前画者且严格now<deadline时写。每次提交原子更新canvas与同scope的quota，guard当前rooms版本、presence版本（包括不存在）和房间有效期限，不续房间TTL。quota固定id=`quota`、kind=`quota`，画布kind=`canvas`；没有增加第十四个scope。quota登记每条实体逻辑JSON字节，初始化／重建有原版本守卫，损坏关系失败关闭。

当前服务冻结本地硬限制：每图1500笔／50000点／4096点每笔／2MiB（含重做和128个持久回执）；每批最多16笔／256点／32KiB。活动画布总数32、逻辑16MiB；写队列32条／1MiB；最多128watcher，领域交付队列每连接4条、单事件64KiB、领域交付合计2MiB。大完整图转小recovery提示再受权GET。**领域交付预算只覆盖callback尚未完成的packet；BFF callback若立即把packet放入自己的异步队列，后者必须另设共享字节预算，不能冒称也计入这2MiB。** 主任务拥有这层HTTP/SSE队列和并发容量门。

书写授权仅内存，绑定 `bootId + userKey + seatId + authorizationId(session.id) + deviceId + leaseGeneration`；持久化的只有leaseGeneration。每次服务factory生成新公开bootId；新Node进程同密钥恢复已确认图，bootId改变、所有旧writer失效。真实专项启动了另一个Node，读回3点、旧writer拒绝、新拿笔generation由1变2；原父进程旧lease也因持久代际变化被拒绝。这个证明使用合成key，不等于生产密钥保管、备份恢复或真实账号验收。401／503／会话失效通过 invalidateActor / invalidateAuthorization 仅撤临时授权，已确认图仍在。

所有写请求，包括acquire，必填本人只读snapshot返回的 `canvasId+bootId`。即使下一题租约和序号再次从1／0开始，旧题迟到append或acquire也不能抢新题或补旧点。15秒lease每次成功变更后续期且不超过阶段／房间期限；duplicate只返回当前有效lease期限，不因重放续租。保留本人最近128个指纹回执，精确重放零追加；已驱逐的未知请求因原expectedSequence不符只能恢复，不能生成新编号自动补写。同strokeId可分批，工具不变，undo撤整笔；clear增加clearGeneration，旧清空包不能复活。

HTTP为 `GET /api/rooms/:六位code/canvas` 和 `POST /canvas/{acquire|append|undo|redo|clear}`，允许以0开头房间码。每次前后明确fresh授权，写入同源CSRF，body禁止账号和会话字段。BFF第四参数传可信authorizationId，第二次核验后再次检查当前room成员和题目；提交后401/503不返回ack或画布，明确只读对账。acquire返回外层 `bootId/canvasId/sequence/clearGeneration/leaseGeneration/leaseValidUntil/validUntil/persisted`；其他操作返回 `{ack:{同公共围栏与leaseValidUntil,persisted:true},duplicate}`。append额外operations；点为0～1归一化坐标，tool为pen/eraser，6位颜色、宽度1～32。read只含公开线条和阶段／期限，不发答案、别名、候选、内部身份或持久回执。

后续独立画布用户桶按主任务明确选择180/min，IP360/min和全局300/min由统一BFF拥有；这与Step 0的120/240历史实验分开。提高本地桶不改变fresh中央核验次数，也不是500ms门槛的解决办法。正式节奏和上线许可仍待共同有界容量模型与真实身份合同验收。

清理先执行rooms.sweep（房间所有者计算有效期限），再canvases.sweep。当前暂停题保持，即使记录本身是FOREVER；旧题或已清理房间通过room版本guard原子删canvas+更新quota。不复制房间TTL算法，不用画布读写／心跳续房。`validateCanvasRecord`与`validateCanvasCollection`只证明记录和quota内部关系，十三scope备份还必须由备份所有者检查room↔canvas、等待局↔release，以及旧6/7/9scope兼容。一个canvas service实例只广播本实例提交；双连接测试证明数据CAS／额度，不证明跨Node实时广播集群。

## 当前只冻结的实验参数

推荐继续比较 **1000ms、60点/批**：画者通常60 POST/min，600ms为100 POST/min；前者给读回、接管、聊天等留下足够用户120/min余量。现负载同IP约143请求/min，600ms约183/min，未取消240/min限制；冷启动/状态/真实房间恢复等额外请求本次没有假填0。1000ms合成点等待p95约950ms，600ms约570ms，均未达500ms，不能作为产品最终批节奏。

原型值是：每批256点/64KiB、每笔4096点、每题1500笔/50000点/2MiB、2048持久请求回执；单连接最多4待发事件/256KiB、最多16流；总写入队列32项/1MiB，一个活动实验画布。写租期15秒且每次已提交append续租；返回 `leaseValidUntil`，过期/换设备/restart须明确重新接管。未确认本机笔迹不自动补发；未知ack、序号缺口和断流只读已确认图。超过SSE预算的完整图发送小型 `recovery` 提示，通过受权HTTP读取≤2MiB的确认快照，不扩大流队列。结束/旧题清理和全服务多房存储预算尚未形成生产合同。

生产共通JSON读取上限实际为32KiB，[实现与发布范围](../development-drawing.md)建议64KiB不是现接口能力。可先冻结更窄的32KiB身体上限与≤256点；若确需64KiB，应在装配层明确新端点限定、回归旧接口，而非全局放宽。实验只保存公开笔迹，没有公共/私人词库、候选和答案。

## 容量停止条件与Agora配合

单是16收件人每秒一批画布，就产生16次fresh私有交付核验/秒。计入本实验HTTP、聊天及watchdog后约30次逻辑检查/秒，远超棋牌4rps调度和中央共享stage 5rps/burst10；真实在途合并可以减少上游发送，但原client突发p95 3.8秒也已超过500ms，不能依赖合并宣称实时已过。增加房间会扩大扇出。中央最新本地三项目容量结论仍“未通过”，J06有界预算200曾停止；本实验不修改该预算或当前安全门。

另比较完整快照 SSE 与增量 SSE：前者带宽/解析明显更多；持续WebSocket或上传长连接能减少HTTP建立和请求桶次数，但**不能消除每私有交付fresh核验**，也不凭更换传输获得例外。未实现WebSocket，不将这个推论写成实测。

需要Agora审查并冻结：新画布的私有交付执行点、准确token在途合并范围、撤销后停流/接管代际、当前三项目总量和冷/热恢复排队公平性；共同有界模型必须真实挂载HTTP/SSE生命周期、房间/聊天恢复与新画布。若改变身份协议/容量/预算要有具体合同和授权，不能偷加成功缓存、延长撤销期限、共享其他用户资格或先上线再看。当前没有发消息、调用中央或购买/扩容。

## 尚未证明与计划歧义

- 第8节“低延迟”须明确统计的是点输入、持久ack或浏览器绘制，不能只拿批次提交后延迟通过500ms；本实验保留两种时间线。
- 第7节多前提事务的等效“串行提交”必须含跨SQLite连接/外部房间修改。本对象Promise串行仅防本对象重入，不能取代数据库前提。
- 同画者不同阶段期限、真实猜词与末人到期并发、聊天答案/别名秘密策略没有实现；合成 `guess` 明确未判词，公开合成聊天没有正式秘密策略，不算P3通过。
- Step 0两房台账不证明共享SQLite多房争用和全局队列公平；后续正式服务新增同库额度与新进程持久恢复的专项，仍不证明多进程实时广播或生产并发许可。十三scope/签名manifest、旧scope与schema10联合恢复以主任务实际测试记录为准，不能从Step 0副本读回推导。
- 高频P1门失败时，第11节禁止进入P2；词库内容准备、隔离UI及合同修正可以继续，但不能把这次24项局部测试、旧回归或本机快替身数字写成完整P1完成。

本报告的唯一阶段结论保持 **P1_BLOCKED**；继续工作应先收敛身份/传输方案与体验目标并重测。
