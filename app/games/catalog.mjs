// Browser-safe presentation metadata only. Never import a server game engine here.
const entries = [
  { gameType: 'rummikub', name: '拉密', page: 'room.html', minPlayers: 2, maxPlayers: 7,
    createHint: '每人回合 30 分钟', availabilityFlag: null,
    practicePage: 'practice.html', practiceSummary: '摆牌、整理组合，练会基础与特殊鬼牌。', scoreKind: 'points',
    timeout: { action: '超时摸牌', hint: '时间到后自动摸一张牌；牌池空时按过牌规则处理' },
    assets: ['practice.html', 'room.html', 'app.mjs', 'rules.mjs', 'twist-rules.mjs',
      'table-layout.mjs', 'rack-layout.mjs', 'rummikub-feedback.mjs', 'rummikub-assist.mjs',
      'rummikub-preview-client.mjs', 'assets/joker-mark.png',
      'assets/joker-normal-v2.png', 'assets/joker-mirror-v2.png',
      'assets/joker-color-change-v2.png', 'assets/joker-double-v2.png',
      'games/rummikub/game-page.mjs', 'games/rummikub/rules.mjs', 'games/rummikub/jokers.mjs',
      'games/rummikub/table-layout.mjs', 'games/rummikub/rack-layout.mjs',
      'games/rummikub/feedback.mjs', 'games/rummikub/assist.mjs',
      'games/rummikub/preview-client.mjs', 'games/rummikub/presentation.mjs',
      'games/rummikub/motion-ui.mjs', 'games/rummikub/motion.css'] },
  { gameType: 'army-flip', name: '翻棋军棋', page: 'army.html', minPlayers: 2, maxPlayers: 2,
    createHint: '每人回合 30 分钟', availabilityFlag: null,
    practicePage: 'army-practice.html', practiceSummary: '翻开棋子，练习移动、吃子与攻守。', scoreKind: 'outcome',
    timeout: { action: '超时跳过', hint: '时间到后自动跳过当前回合' },
    assets: ['army.html', 'army-room.mjs', 'army-presentation.mjs', 'army.css', 'army-board.mjs',
      'army-practice.html', 'army-practice.mjs', 'army-practice-engine.mjs',
      'games/army-flip/game-page.mjs', 'games/army-flip/practice-page.mjs',
      'games/army-flip/board.mjs', 'games/army-flip/presentation.mjs',
      'games/army-flip/practice-engine.mjs', 'games/army-flip/ui.css', 'games/army-flip/motion-ui.mjs'] },
  { gameType: 'flying-chess', name: '飞行棋', page: 'flying.html', minPlayers: 2, maxPlayers: 4,
    createHint: '每人回合 30 分钟', availabilityFlag: null,
    practicePage: 'flying-practice.html', practiceSummary: '掷骰、选飞机；从六个教学场景起飞。', scoreKind: 'outcome',
    timeout: { action: '超时换人', hint: '时间到弃未使用骰子并换人，已经确认的飞机位置保留' },
    assets: ['flying.html', 'flying-practice.html', 'games/flying-chess/board.mjs',
      'games/flying-chess/routes.mjs', 'games/flying-chess/rules.mjs', 'games/flying-chess/art.mjs',
      'games/flying-chess/presentation.mjs', 'games/flying-chess/ui.css',
      'games/flying-chess/page-ui.mjs', 'games/flying-chess/game-page.mjs', 'games/flying-chess/motion-ui.mjs',
      'games/flying-chess/practice-engine.mjs', 'games/flying-chess/practice-page.mjs'] },
  { gameType: 'draw-and-guess', name: '你画我猜', page: 'drawing.html', minPlayers: 2, maxPlayers: 8,
    createHint: '一人画，大家同时猜', availabilityFlag: 'drawingEnabled',
    practicePage: 'drawing-practice.html', practiceSummary: '拿起画笔，试试笔刷、颜色与撤销。', scoreKind: 'score',
    timeout: { action: '阶段自动继续', hint: '选词、绘画和揭晓按各自倒计时自动推进' },
    assets: [
      ...["vendor/excalidraw-0.18.1/chunk-2FWNOOB3.js", "vendor/excalidraw-0.18.1/chunk-2M7NTMMM.js", "vendor/excalidraw-0.18.1/chunk-2VWMECTD.js", "vendor/excalidraw-0.18.1/chunk-2YP7KB3F.js", "vendor/excalidraw-0.18.1/chunk-32NUPQUX.js", "vendor/excalidraw-0.18.1/chunk-32VZIUF5.js", "vendor/excalidraw-0.18.1/chunk-36RMN3AS.js", "vendor/excalidraw-0.18.1/chunk-3HKAOI3V.js", "vendor/excalidraw-0.18.1/chunk-3UY5HV24.js", "vendor/excalidraw-0.18.1/chunk-43GPSOTP.js", "vendor/excalidraw-0.18.1/chunk-465XZC7Y.js", "vendor/excalidraw-0.18.1/chunk-4CB27MBK.js", "vendor/excalidraw-0.18.1/chunk-4GHTEAFF.js", "vendor/excalidraw-0.18.1/chunk-4HNPQCQZ.js", "vendor/excalidraw-0.18.1/chunk-4NTUQCFX.js", "vendor/excalidraw-0.18.1/chunk-4SMH6DHP.js", "vendor/excalidraw-0.18.1/chunk-4YXWEIGP.js", "vendor/excalidraw-0.18.1/chunk-52K7SHYX.js", "vendor/excalidraw-0.18.1/chunk-5CG7MJDZ.js", "vendor/excalidraw-0.18.1/chunk-5G73CHGO.js", "vendor/excalidraw-0.18.1/chunk-5M7GFYVL.js", "vendor/excalidraw-0.18.1/chunk-5NC34QDK.js", "vendor/excalidraw-0.18.1/chunk-5NFGATOV.js", "vendor/excalidraw-0.18.1/chunk-5OA4PHKG.js", "vendor/excalidraw-0.18.1/chunk-5Z5PDYGB.js", "vendor/excalidraw-0.18.1/chunk-6ILVHYFL.js", "vendor/excalidraw-0.18.1/chunk-6JMVJ6VY.js", "vendor/excalidraw-0.18.1/chunk-6JPW2NJF.js", "vendor/excalidraw-0.18.1/chunk-7627X34R.js", "vendor/excalidraw-0.18.1/chunk-7A7BB6RA.js", "vendor/excalidraw-0.18.1/chunk-A2ASX6K6.js", "vendor/excalidraw-0.18.1/chunk-ACVR26MA.js", "vendor/excalidraw-0.18.1/chunk-AO4RVRJ5.js", "vendor/excalidraw-0.18.1/chunk-AX2LHRZU.js", "vendor/excalidraw-0.18.1/chunk-BK7BHBZU.js", "vendor/excalidraw-0.18.1/chunk-C4LWQERQ.js", "vendor/excalidraw-0.18.1/chunk-CDENLQJG.js", "vendor/excalidraw-0.18.1/chunk-CDXOXHQ2.js", "vendor/excalidraw-0.18.1/chunk-CTX5GNXB.js", "vendor/excalidraw-0.18.1/chunk-D5SSM7LY.js", "vendor/excalidraw-0.18.1/chunk-D6NH6BMT.js", "vendor/excalidraw-0.18.1/chunk-DHDPGCFJ.js", "vendor/excalidraw-0.18.1/chunk-DROZKKOU.js", "vendor/excalidraw-0.18.1/chunk-DSVXNT5J.js", "vendor/excalidraw-0.18.1/chunk-DTR4ZNCZ.js", "vendor/excalidraw-0.18.1/chunk-DYE6USRA.js", "vendor/excalidraw-0.18.1/chunk-DYPLZSAU.js", "vendor/excalidraw-0.18.1/chunk-EFJ6ODIJ.js", "vendor/excalidraw-0.18.1/chunk-ELSDR42H.js", "vendor/excalidraw-0.18.1/chunk-EPTMRCFD.js", "vendor/excalidraw-0.18.1/chunk-EQ5IIDOR.js", "vendor/excalidraw-0.18.1/chunk-EVXBPNXK.js", "vendor/excalidraw-0.18.1/chunk-EXCJSTSL.js", "vendor/excalidraw-0.18.1/chunk-FBAQ5AY6.js", "vendor/excalidraw-0.18.1/chunk-FCDCUKRO.js", "vendor/excalidraw-0.18.1/chunk-FDCNN5JV.js", "vendor/excalidraw-0.18.1/chunk-FRGF2QYV.js", "vendor/excalidraw-0.18.1/chunk-FVI7ETK2.js", "vendor/excalidraw-0.18.1/chunk-FVYZW3OW.js", "vendor/excalidraw-0.18.1/chunk-FW42CB2Y.js", "vendor/excalidraw-0.18.1/chunk-G4GU5CJU.js", "vendor/excalidraw-0.18.1/chunk-GCICUUPB.js", "vendor/excalidraw-0.18.1/chunk-GDGZBOQC.js", "vendor/excalidraw-0.18.1/chunk-GR52EX54.js", "vendor/excalidraw-0.18.1/chunk-GZZSMIRK.js", "vendor/excalidraw-0.18.1/chunk-H2LVBNLV.js", "vendor/excalidraw-0.18.1/chunk-H2QZKEWB.js", "vendor/excalidraw-0.18.1/chunk-H6QSSVCQ.js", "vendor/excalidraw-0.18.1/chunk-HDKR6WI7.js", "vendor/excalidraw-0.18.1/chunk-HF23YDYY.js", "vendor/excalidraw-0.18.1/chunk-HMU2STN7.js", "vendor/excalidraw-0.18.1/chunk-HVAPFW6D.js", "vendor/excalidraw-0.18.1/chunk-HWM2YAFL.js", "vendor/excalidraw-0.18.1/chunk-I22BPWU2.js", "vendor/excalidraw-0.18.1/chunk-I53GXBBZ.js", "vendor/excalidraw-0.18.1/chunk-IFBMVVXH.js", "vendor/excalidraw-0.18.1/chunk-IPEWMBNG.js", "vendor/excalidraw-0.18.1/chunk-IV5PQ4PS.js", "vendor/excalidraw-0.18.1/chunk-IWJZI6D3.js", "vendor/excalidraw-0.18.1/chunk-J23VM3NY.js", "vendor/excalidraw-0.18.1/chunk-J3FDXRJS.js", "vendor/excalidraw-0.18.1/chunk-J44QBYHG.js", "vendor/excalidraw-0.18.1/chunk-JBFFNVXI.js", "vendor/excalidraw-0.18.1/chunk-JCOJYLVR.js", "vendor/excalidraw-0.18.1/chunk-JOLQ26LH.js", "vendor/excalidraw-0.18.1/chunk-K7Z5NVFO.js", "vendor/excalidraw-0.18.1/chunk-KNAXSFFV.js", "vendor/excalidraw-0.18.1/chunk-L3QZAPP7.js", "vendor/excalidraw-0.18.1/chunk-LR3R6XQQ.js", "vendor/excalidraw-0.18.1/chunk-MID7EFL6.js", "vendor/excalidraw-0.18.1/chunk-MIUZVYEB.js", "vendor/excalidraw-0.18.1/chunk-MJ2KXO7H.js", "vendor/excalidraw-0.18.1/chunk-MJ4BNB7V.js", "vendor/excalidraw-0.18.1/chunk-MSGGTKQ2.js", "vendor/excalidraw-0.18.1/chunk-N2R4L3WT.js", "vendor/excalidraw-0.18.1/chunk-N5XXF3JG.js", "vendor/excalidraw-0.18.1/chunk-NJ27S7EV.js", "vendor/excalidraw-0.18.1/chunk-NJZNHFPT.js", "vendor/excalidraw-0.18.1/chunk-NTFDCHIR.js", "vendor/excalidraw-0.18.1/chunk-NXJNVEOD.js", "vendor/excalidraw-0.18.1/chunk-NYO7JO2R.js", "vendor/excalidraw-0.18.1/chunk-O4NEB57V.js", "vendor/excalidraw-0.18.1/chunk-O6ZTGXNT.js", "vendor/excalidraw-0.18.1/chunk-P2VJZSP3.js", "vendor/excalidraw-0.18.1/chunk-P435SQS7.js", "vendor/excalidraw-0.18.1/chunk-PDBBDADD.js", "vendor/excalidraw-0.18.1/chunk-PE2IKNZL.js", "vendor/excalidraw-0.18.1/chunk-PECUGBJT.js", "vendor/excalidraw-0.18.1/chunk-PFDYL5E6.js", "vendor/excalidraw-0.18.1/chunk-PFO5SWD6.js", "vendor/excalidraw-0.18.1/chunk-PRPRY4BR.js", "vendor/excalidraw-0.18.1/chunk-Q4KTZTDV.js", "vendor/excalidraw-0.18.1/chunk-QANYTB7Z.js", "vendor/excalidraw-0.18.1/chunk-QAX6HCCA.js", "vendor/excalidraw-0.18.1/chunk-QCYGDWM2.js", "vendor/excalidraw-0.18.1/chunk-QKEFMVZH.js", "vendor/excalidraw-0.18.1/chunk-QL57DF4Y.js", "vendor/excalidraw-0.18.1/chunk-QP3MATMC.js", "vendor/excalidraw-0.18.1/chunk-QWQSIJAU.js", "vendor/excalidraw-0.18.1/chunk-QXJ5PHX4.js", "vendor/excalidraw-0.18.1/chunk-QZDQXRO2.js", "vendor/excalidraw-0.18.1/chunk-QZP5JFOV.js", "vendor/excalidraw-0.18.1/chunk-RBEFHGZZ.js", "vendor/excalidraw-0.18.1/chunk-RD3ECCYA.js", "vendor/excalidraw-0.18.1/chunk-REAZ4YVB.js", "vendor/excalidraw-0.18.1/chunk-RLWMUBCR.js", "vendor/excalidraw-0.18.1/chunk-ROBCHRRH.js", "vendor/excalidraw-0.18.1/chunk-S3VUBUDF.js", "vendor/excalidraw-0.18.1/chunk-S54BITZA.js", "vendor/excalidraw-0.18.1/chunk-SCADR3VL.js", "vendor/excalidraw-0.18.1/chunk-SD3S5IAL.js", "vendor/excalidraw-0.18.1/chunk-SIGEVYHX.js", "vendor/excalidraw-0.18.1/chunk-SNQQ7ZWW.js", "vendor/excalidraw-0.18.1/chunk-SVMB4Q3T.js", "vendor/excalidraw-0.18.1/chunk-T5XHCMBB.js", "vendor/excalidraw-0.18.1/chunk-TDQRHG7Q.js", "vendor/excalidraw-0.18.1/chunk-TG2EFSSX.js", "vendor/excalidraw-0.18.1/chunk-TODEKKD2.js", "vendor/excalidraw-0.18.1/chunk-TSAKIPY3.js", "vendor/excalidraw-0.18.1/chunk-TYTGRWJ7.js", "vendor/excalidraw-0.18.1/chunk-U62UUARJ.js", "vendor/excalidraw-0.18.1/chunk-UWUOMQYU.js", "vendor/excalidraw-0.18.1/chunk-V2USAHUW.js", "vendor/excalidraw-0.18.1/chunk-VCWV4YKS.js", "vendor/excalidraw-0.18.1/chunk-VDJQGAIN.js", "vendor/excalidraw-0.18.1/chunk-VISMLDXX.js", "vendor/excalidraw-0.18.1/chunk-VIZTADHD.js", "vendor/excalidraw-0.18.1/chunk-VPG5J753.js", "vendor/excalidraw-0.18.1/chunk-VXRR7SEC.js", "vendor/excalidraw-0.18.1/chunk-VZTDW5VJ.js", "vendor/excalidraw-0.18.1/chunk-VZTIZRKF.js", "vendor/excalidraw-0.18.1/chunk-VZZ5VDVD.js", "vendor/excalidraw-0.18.1/chunk-WEFT5RIU.js", "vendor/excalidraw-0.18.1/chunk-WJXU4IYB.js", "vendor/excalidraw-0.18.1/chunk-WN5JZMCT.js", "vendor/excalidraw-0.18.1/chunk-WOWB44L7.js", "vendor/excalidraw-0.18.1/chunk-WS5BKERL.js", "vendor/excalidraw-0.18.1/chunk-WTGUPGQ6.js", "vendor/excalidraw-0.18.1/chunk-WTLWBTAG.js", "vendor/excalidraw-0.18.1/chunk-X2XZZSYZ.js", "vendor/excalidraw-0.18.1/chunk-X3VWMD6E.js", "vendor/excalidraw-0.18.1/chunk-XDAIGNFR.js", "vendor/excalidraw-0.18.1/chunk-XGSPIUED.js", "vendor/excalidraw-0.18.1/chunk-XJIJELNM.js", "vendor/excalidraw-0.18.1/chunk-XPJ3KUM4.js", "vendor/excalidraw-0.18.1/chunk-XQNYQ7MA.js", "vendor/excalidraw-0.18.1/chunk-XTHDOWNT.js", "vendor/excalidraw-0.18.1/chunk-XV3UORG4.js", "vendor/excalidraw-0.18.1/chunk-YAOWAIBG.js", "vendor/excalidraw-0.18.1/chunk-YH2NYTFO.js", "vendor/excalidraw-0.18.1/chunk-YQUOABU4.js", "vendor/excalidraw-0.18.1/chunk-YSQYYCZ3.js", "vendor/excalidraw-0.18.1/chunk-YSWQ6J34.js", "vendor/excalidraw-0.18.1/chunk-YUSHYV7C.js", "vendor/excalidraw-0.18.1/chunk-Z5UOWJHR.js", "vendor/excalidraw-0.18.1/chunk-Z6ZIO25B.js", "vendor/excalidraw-0.18.1/chunk-ZHPOEQKV.js", "vendor/excalidraw-0.18.1/chunk-ZWRDP37E.js", "vendor/excalidraw-0.18.1/editor.css", "vendor/excalidraw-0.18.1/editor.js"],
      'vendor/excalidraw-0.18.1/license.html', 'drawing.html', 'drawing-practice.html', 'words.html', 'games/draw-and-guess/game-page.mjs',
      'games/draw-and-guess/excalidraw-surface.mjs', 'games/draw-and-guess/paint-colors.mjs', 'games/draw-and-guess/content-defaults.mjs', 'games/draw-and-guess/canvas-view.mjs', 'games/draw-and-guess/paper-camera.mjs', 'games/draw-and-guess/experience-ui.mjs', 'games/draw-and-guess/styles.css',
      'games/draw-and-guess/practice-page.mjs', 'games/draw-and-guess/practice-engine.mjs', 'draw-and-guess-practice.mjs', 'games/draw-and-guess/wordbank-page.mjs',
      'games/draw-and-guess/wordbank.css', 'games/draw-and-guess/matcher.mjs',
      'games/draw-and-guess/request-intent.mjs'] },
  { gameType: 'poker414-2', name: '414 · 两副牌', page: 'poker414.html', minPlayers: 3, maxPlayers: 8,
    createHint: '普通出牌不限时 · 勾叉机会 5 秒', availabilityFlag: 'poker414Enabled',
    practicePage: 'poker414-practice.html', practiceSummary: '和电脑打一局，熟悉出牌、勾叉与火箭。', scoreKind: 'score',
    timeout: { action: '阶段自动继续', hint: '发牌及勾叉机会按阶段倒计时，普通出牌不限时' },
    assets: ['poker414.html', 'poker414-practice.html', 'games/poker414-2/practice-page.mjs',
      'games/poker414-2/practice-engine.mjs', 'games/poker414-2/practice-bot.mjs', 'games/poker414-2/rules.mjs', 'games/poker414-2/art.mjs', 'games/poker414-2/cards.mjs', 'games/poker414-2/patterns.mjs',
      'games/poker414-2/presentation.mjs', 'games/poker414-2/page-ui.mjs', 'games/poker414-2/layout.mjs',
      'games/poker414-2/styles.css', 'games/poker414-2/game-page.mjs', 'games/poker414-2/room-controller.mjs', 'games/poker414-2/motion-ui.mjs'] },
  { gameType: 'hyakki-trading', name: '幽街商人', page: 'hyakki.html', minPlayers: 2, maxPlayers: 6,
    createHint: '2～6人经营 · 每回合行动可调', availabilityFlag: 'hyakkiEnabled',
    practicePage: 'hyakki-practice.html', practiceSummary: '和电脑经营夜市，买卖货物、使用人物与道具。', scoreKind: 'outcome',
    timeout: { action: '按当前步骤默认选择', hint: '主动回合30分钟，对方回应60秒；掉线保留当前材料并挂起' },
    assets: ['hyakki.html', 'hyakki-practice.html', 'hyakki-catalog.html', 'assets/hyakki-night-market.webp', 'assets/hyakki-night-market-lantern.png', 'assets/hyakki-night-market-rain.png',
      ...['game-page.mjs', 'room-controller.mjs', 'presentation.mjs', 'game-ui.mjs', 'game-ui-model.mjs', 'game-ui.css', 'game-dialog-ui.mjs', 'battle-report-ui.mjs', 'battle-report-ui.css', 'battle-report-model.mjs', 'battle-public-metadata.mjs', 'hand-drag-ui.mjs', 'table-motion-ui.mjs',
        'table-decision-ui.mjs', 'card-draft.mjs', 'benefit-draft-ui.mjs', 'practice-page.mjs', 'practice-engine.mjs', 'practice-bot.mjs', 'rules.mjs', 'model.mjs', 'effects.mjs', 'tools.mjs',
        'auction.mjs', 'decision.mjs', 'lifecycle.mjs', 'validation.mjs', 'view.mjs', 'content/definitions.mjs', 'content/manifest.mjs', 'content/player-count-profile.mjs',
        'presentation-content.mjs', 'expansion-card-ui.mjs', 'expansion-table.css', 'opening.mjs', 'opening-game.mjs', 'trade-contract.mjs', 'practice-session.mjs', 'practice-legacy.mjs', 'configured/history.mjs', 'configured/view.mjs', 'configured/base.mjs', 'configured/effects.mjs', 'configured/role-effects.mjs', 'configured/validation.mjs', 'configured/auction.mjs', 'configured/new-characters.mjs', 'configured/rules.mjs', 'configured/practice-bot.mjs', 'configured/material.mjs', 'configured/practice-runtime.mjs', 'configured/table-ui.mjs', 'configured/public-metadata.mjs', 'configured/new-tools.mjs', 'configured/tools.mjs', 'configured/model.mjs', 'configured/role-state.mjs', 'configured/tool-cost.mjs', 'battle-history4.mjs', 'public-history-v4.mjs', 'expansion-public-history.mjs', 'opening-configuration.mjs', 'content/expansion-one.mjs', 'content/expansion-one-data.mjs',
        'night-market-ui.mjs', 'night-market-motion.mjs', 'night-market.css', 'night-market-background.mjs', 'night-market-background.css', 'digital-page-ui.mjs', 'digital-card-ui.mjs', 'digital-card.css', 'digital-styles.css', 'digital-catalog.mjs', 'digital-catalog-page.mjs', 'digital-catalog.css']
        .map(file => `games/hyakki-trading/${file}`),
      'assets/hyakki/expansion-one/goods/herb.svg', 'assets/hyakki/expansion-one/goods/mechanism.svg', 'assets/hyakki/expansion-one/goods/painting.svg', 'assets/hyakki/expansion-one/goods/pearl.svg', 'assets/hyakki/expansion-one/goods/silk.svg', 'assets/hyakki/expansion-one/goods/timber.svg', 'assets/hyakki/expansion-one/illustrations/r01.webp', 'assets/hyakki/expansion-one/illustrations/r02.webp', 'assets/hyakki/expansion-one/illustrations/r03.webp', 'assets/hyakki/expansion-one/illustrations/r04.webp', 'assets/hyakki/expansion-one/illustrations/r05.webp', 'assets/hyakki/expansion-one/illustrations/r06.webp', 'assets/hyakki/expansion-one/illustrations/r07.webp', 'assets/hyakki/expansion-one/illustrations/r08.webp', 'assets/hyakki/expansion-one/illustrations/r09.webp', 'assets/hyakki/expansion-one/illustrations/r10.webp', 'assets/hyakki/expansion-one/illustrations/r11.webp', 'assets/hyakki/expansion-one/illustrations/r12.webp', 'assets/hyakki/expansion-one/illustrations/r13.webp', 'assets/hyakki/expansion-one/illustrations/r14.webp', 'assets/hyakki/expansion-one/illustrations/r15.webp', 'assets/hyakki/expansion-one/illustrations/r16.webp', 'assets/hyakki/expansion-one/illustrations/r17.webp', 'assets/hyakki/expansion-one/illustrations/r18.webp', 'assets/hyakki/expansion-one/illustrations/r19.webp', 'assets/hyakki/expansion-one/illustrations/r20.webp', 'assets/hyakki/expansion-one/illustrations/r21.webp', 'assets/hyakki/expansion-one/illustrations/r22.webp', 'assets/hyakki/expansion-one/illustrations/r23.webp', 'assets/hyakki/expansion-one/illustrations/r24.webp', 'assets/hyakki/expansion-one/illustrations/xt-contract-family.webp', 'assets/hyakki/expansion-one/illustrations/xt-lot-family.webp', 'assets/hyakki/expansion-one/illustrations/xt01.webp', 'assets/hyakki/expansion-one/illustrations/xt13.webp', 'assets/hyakki/expansion-one/illustrations/xt14.webp',
      ...['firearms', 'imports', 'curios', 'beasts', 'antiques', 'salt-iron', 'card-back'].map(id => `assets/hyakki/v2/${id}.svg`),
      ...['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09', 'c10', 'c11', 'c12', 'c13',
        'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 't01', 't02', 't03', 't04', 't05', 't06', 't07', 't08', 't09', 't10', 'stall-permit']
        .map(id => `assets/hyakki/v2/${id}.webp`)] },
  { gameType:'parks',name:'国家公园',page:'parks.html',minPlayers:1,maxPlayers:5,
    createHint:'朋友徒步、Teddy同行与单人挑战',availabilityFlag:'parksEnabled',
    practicePage:'parks-practice.html',practiceSummary:'沿步道徒步，收集资源、参观公园。初次来玩可以先上教学。',
    practiceLinks:[{label:'从教学开始',page:'parks-tutorial.html'},{label:'官方单人',page:'parks-practice.html?mode=solo'},{label:'规则与图鉴',page:'parks-catalog.html'}],scoreKind:'score',
    timeout:{action:'暂停等待本人选择',hint:'决策时间到后保留材料并暂停，由当前责任人继续选择'},
    assets:['parks.html','parks-practice.html','parks-tutorial.html','parks-catalog.html',
      ...['configuration.mjs','game-ui.mjs','game-ui.css','game-ui-model.mjs','presentation.mjs','room-controller.mjs','game-page.mjs','practice-page.mjs',
        'tutorial-page.mjs','tutorial-model.mjs','card-ui.mjs','catalog-page.mjs','styles.css','view.mjs','practice-engine.mjs','practice-bot.mjs','practice-session.mjs',
        ...['index','model','scoring','flow','effects','resources','actions','legality','validation'].map(name=>`rules/${name}.mjs`),
        ...['behavior-data','optional-data','component-data','asset-manifest','vector-art','sample-assets','art-subjects','catalog','provenance',
          'park-data','immutable','passion-data','original-art-assets'].map(name=>`content/${name}.mjs`)]
        .map(file=>`games/parks/${file}`),
      ...['parks-atlas-01','parks-atlas-02','parks-atlas-03','parks-atlas-04','parks-atlas-05','parks-atlas-06','parks-atlas-07',
        'gear-atlas-01','gear-atlas-02','park-arches','park-grand-teton','park-acadia','park-black-canyon-of-the-gunnison','gear-flint-and-tinder','gear-camp-mug']
        .flatMap(name=>[`assets/parks/v2/${name}.webp`,`assets/parks/v2/${name}-thumb.webp`])] },
];

function safePage(page) { return typeof page === 'string' && /^[a-z][a-z0-9-]*\.html$/.test(page); }
function safePracticeLink(page) { return typeof page === 'string' && /^[a-z][a-z0-9-]*\.html(?:\?[a-z][a-z0-9-]*=[a-z0-9-]+(?:&[a-z][a-z0-9-]*=[a-z0-9-]+)*)?$/.test(page); }

/** One presentation registration per game. Execution and private state are server-owned. */
export function createPresentationCatalog(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) throw new TypeError('游戏目录不能为空。');
  const catalog = new Map();
  const fields = new Set(['gameType', 'name', 'page', 'minPlayers', 'maxPlayers', 'practicePage', 'practiceSummary', 'practiceLinks', 'scoreKind', 'timeout', 'assets', 'createHint', 'availabilityFlag']);
  for (const item of definitions) {
    const practiceSummary = item?.practiceSummary ?? '熟悉玩法与操作，再约朋友一起玩。';
    const practiceLinks = item?.practiceLinks ?? [];
    if (!item || Object.keys(item).some(field => !fields.has(field))
      || !/^[a-z][a-z0-9-]*$/.test(item.gameType) || catalog.has(item.gameType)
      || typeof item.name !== 'string' || !item.name.trim() || !safePage(item.page)
      || !Number.isSafeInteger(item.minPlayers) || !Number.isSafeInteger(item.maxPlayers)
      || item.minPlayers < 1 || item.maxPlayers < item.minPlayers
      || item.practicePage !== null && !safePage(item.practicePage)
      || typeof practiceSummary !== 'string' || !practiceSummary.trim() || practiceSummary.length > 120
      || !Array.isArray(practiceLinks) || practiceLinks.length > 5
      || practiceLinks.some(link => !link || Object.keys(link).some(field => !['label', 'page'].includes(field))
        || typeof link.label !== 'string' || !link.label.trim() || link.label.length > 30 || !safePracticeLink(link.page))
      || new Set(practiceLinks.map(link => link.page)).size !== practiceLinks.length
      || !['points', 'outcome', 'score'].includes(item.scoreKind)
      || typeof item.createHint !== 'string' || !item.createHint.trim()
      || ![null, 'drawingEnabled', 'poker414Enabled', 'hyakkiEnabled','parksEnabled'].includes(item.availabilityFlag)
      || !item.timeout || typeof item.timeout.action !== 'string' || !item.timeout.action
      || typeof item.timeout.hint !== 'string' || !item.timeout.hint
      || Object.keys(item.timeout).some(field => !['action', 'hint'].includes(field))
      || !Array.isArray(item.assets) || !item.assets.every(path => typeof path === 'string')) {
      throw new TypeError('游戏公开目录定义无效。');
    }
    const route = Object.freeze({ name: item.name, page: item.page,
      minPlayers: item.minPlayers, maxPlayers: item.maxPlayers });
    catalog.set(item.gameType, Object.freeze({ ...item, route, practiceSummary,
      practiceLinks: Object.freeze(practiceLinks.map(link => Object.freeze({ ...link }))),
      timeout: Object.freeze({ ...item.timeout }), assets: Object.freeze([...item.assets]) }));
  }
  return Object.freeze({
    has: gameType => typeof gameType === 'string' && catalog.has(gameType),
    get(gameType = 'rummikub') {
      if (typeof gameType !== 'string' || !catalog.has(gameType)) throw new TypeError('无法识别这个房间的游戏。');
      return catalog.get(gameType);
    },
    list: () => Object.freeze([...catalog.values()]),
  });
}

export const presentationCatalog = createPresentationCatalog(entries);
export const gamePresentation = (gameType = 'rummikub') => presentationCatalog.get(gameType);
export const gamePresentations = () => presentationCatalog.list();
export const creatableGamePresentations = (capabilities = {}) => presentationCatalog.list()
  .filter(game => game.availabilityFlag === null || capabilities[game.availabilityFlag] === true);
