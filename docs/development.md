# 开发与验证

## 三种运行范围

`npm start` 是仅本机的匿名、内存预览；`npm run preview:identity` 是仅本机的虚构身份、加密持久预览；正式入口使用独立 Cognito BFF、真实成员检查与保护密钥。不能用前两者证明真实账号联合登录已经通过，也不能把它们暴露成公开生产服务。

默认端口分别是 4177 和 4187，可使用 `GAME_ROOM_PORT` 改变本机预览端口。练习进度保存在浏览器，本机虚构身份预览的服务器记录在 `.local/`，两者不是同一种跨设备存档。

生产环境模板见 [.env.example](../.env.example) 与 [runtime.env.example](../infra/runtime.env.example)。这些是未填完整的正式配置参考，不适合作为首次预览 `.env`。当前提供方与身份检查端点有意固定为 Agora 契约，独立生态需要另行实现并验证自己的适配。

## 可重复的测试入口

`npm test` 会构建当前源码的临时运行包，生成临时描述并运行 `app/` 中的测试，随后清理自己创建的目录。它不读取内部部署清单。测试子进程不继承账号令牌或云凭据，AWS 配置指向空文件，实例元数据访问关闭。

发布包测试校验原始压缩包成员、内容散列与准确清单，再解包验证 HTTP、私有状态和存档。默认测试复用当前项目已安装的依赖；完整模式 `npm run test:release` 在独立解包目录使用锁文件再次安装依赖，并要求零失败、取消、跳过和待办。

两项代理测试需要指定官方来源且已校验的 Caddy 二进制和明确 SHA-256。它们使用临时自签测试证书，但只把该证书作为本次客户端的信任参数；不关闭 TLS 校验、不写系统信任库、不请求公网证书，也不访问真实 Agora。Caddy 校验不匹配会在执行前失败。

所需工具：Node.js ≥22.23.2、npm、Python 3、tar。代理测试还需要 OpenSSL，必须支持 `req -addext`。可使用 `OPENSSL_TEST_BINARY` 指定本机兼容版本。当前测试使用 Node 的 SQLite 接口，experimental 提示本身不是测试失败。

测试源码按顺序执行，输出 TAP 结果。真实移动端手势、iOS 软键盘、音效听感和后台恢复需要设备实测；合成 viewport 或模拟音频测试只证明对应的布局与触发逻辑。

## 模块与变更边界

- 规则与实体守恒：[rules.mjs](../app/rules.mjs)、[twist-rules.mjs](../app/twist-rules.mjs)、[army-board.mjs](../app/army-board.mjs)。
- 房间与授权：[rooms.mjs](../app/rooms.mjs)、[durable-rooms.mjs](../server/durable-rooms.mjs)、[unified-http.mjs](../server/unified-http.mjs)。
- 本域身份与安全：[auth.mjs](../server/auth.mjs)、[identity-policy-client.mjs](../server/identity-policy-client.mjs)、[config.mjs](../server/config.mjs)。
- 存档与恢复：[storage.mjs](../server/storage.mjs)、[backup.mjs](../server/backup.mjs)。
- 呈现与输入：[game-viewport.mjs](../app/game-viewport.mjs)、[table-layout.mjs](../app/table-layout.mjs)、[rack-layout.mjs](../app/rack-layout.mjs)、[room-chat.mjs](../app/room-chat.mjs)、[game-audio.mjs](../app/game-audio.mjs)。
- 游戏接入：[game-registry.mjs](../app/game-registry.mjs)。

正式保存以服务端已确认状态为准，账号退出不删除业务记录。临时预览、设备手牌顺序和聊天草稿各有自己的生命周期；不能在通用恢复中混为一份状态。

## 运行包与基础设施

`npm run build:release` 产生 `dist/` 中的内容寻址压缩包及散列文件。相同源码已经生成包时会拒绝覆盖，先使用新的明确输出目录或保留原包进行核对。构建脚本不部署资源，也不发送账号或用户数据。

[生产预检](../scripts/production-preflight.mjs)、[启动](../scripts/production-start.mjs)、[备份](../scripts/store-backup.mjs)、[恢复](../scripts/store-restore.mjs) 与 [激活脚本](../infra/activate-release.sh) 各自承担运行步骤。它们不是为陌生服务器提供的一键安装承诺；必须先核对平台、可信入口、文件权限、稳定密钥、数据兼容、备份与回退边界。

`infra/lightsail.cfn.json` 是本项目托管参考，可能创建计费的主机、快照和存储。资源设置了 Retain，删除模板不代表停止收费。首次本机使用无需部署它；公开源码不授予对正式云资源的操作权限。
