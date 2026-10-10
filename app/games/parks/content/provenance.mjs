import { deepFreeze } from './immutable.mjs';

export const SOURCE_RECORDS = deepFreeze([
  {
    "id": "park",
    "path": "docs/proposals/parks/park-catalog.json",
    "sha256": "30b5286f961cbb01c511dc923dd471b24462b008ff45bebbe037498946a8d660"
  },
  {
    "id": "component",
    "path": "docs/proposals/parks/component-catalog.json",
    "sha256": "86562380f7c6dc506f2485832b87c4173fbd216e602aa25e8c603c22307be2e9"
  },
  {
    "id": "optional",
    "path": "docs/proposals/parks/optional-catalog.json",
    "sha256": "cf539a1f7cf967a240a742cc88769834dd995288f37e0fb2470c48f407e848da"
  }
]);

export const SOURCE_CITATIONS = deepFreeze({
  "official-all-63-parks-image": {
    "id": "official-all-63-parks-image",
    "url": "https://keymaster.fun/cdn/shop/files/All-63-white_45353b61-4374-415b-9e62-0de83605bd1b.jpg?v=1747268405",
    "publisher": "Keymaster",
    "width": 3000,
    "height": 6463,
    "rows": 9,
    "columns": 7,
    "sourceCellConvention": "从图左上角起，行列均从1计数；卡牌按先行后列排序。",
    "readMethod": "逐行查看原尺寸局部图，逐张读卡名、积分、费用栏和闪电后奖励；原图及阅读裁图仅在临时资料区保存。",
    "sha256": "29518e63ea96fe608882e75b35f38ec99d2e45ddcf67024bade38f8e4e0650f2"
  },
  "official-rules-1-1": {
    "id": "official-rules-1-1",
    "url": "https://cdn.shopify.com/s/files/1/1898/8501/files/Parks-2nd-Edition-1.1-Rules_Online.pdf?v=1755706180",
    "printedPages": [
      6,
      7
    ],
    "purpose": "核对费用与即时奖励分区、步道骰、水壶及摄影徽章图标，以及Grand Teton、Joshua Tree、Everglades示例。"
  },
  "bga-public-tutorial": {
    "url": "https://boardgamearena.com/tutorial?game=parks",
    "version": "250417-1214",
    "readLevel": "anonymous public static CAMPSITES, AUTOMA_CARDS and VOLUNTEERS fields read; no game action performed",
    "role": "complete static entity definitions",
    "sha256": "98a06178a1e23283082b1907da363e6941e71e57444b0392034a0a4857b72b52"
  },
  "official-1.1": {
    "url": "https://cdn.shopify.com/s/files/1/1898/8501/files/Parks-2nd-Edition-1.1-Rules_Online.pdf?v=1755706180",
    "readLevel": "printed pages 2-5, 8-11, 14-17 and quick reference visually read",
    "role": "primary component counts, mode rules, Teddy front/back procedure, solo reference and camping"
  },
  "artist-photo": {
    "url": "https://www.moregamesplease.com/art-in-boardgames/2025/4/18/josh-emrich-parks-2nd-edition-art-in-board-games-72",
    "readLevel": "photo visually read",
    "role": "Camp Mug #10, Telephoto Lens #11, partial Field Guide card corroboration"
  },
  "bga-help": {
    "url": "https://en.doc.boardgamearena.com/Gamehelpparks",
    "readLevel": "public text read",
    "role": "site actions and die faces"
  },
  "designer-index": {
    "url": "https://boardgamegeek.com/filepage/293507/parks-2nd-edition-rulebook",
    "readLevel": "search-engine indexed complete comment read; direct page not read",
    "role": "supporting clue for site-vs-action trigger; not independently verified erratum"
  },
  "bga-public-effects-help": {
    "url": "https://x.boardgamearena.net/data/themereleases/current/games/parks/250417-1214/modules/pks-effects.js",
    "readLevel": "public help descriptions read as text, not executed; direct mapping of 501 to printed gear sun cost and 502 to canteen count"
  },
  "bga-card-labels": {
    "url": "https://x.boardgamearena.net/data/themereleases/current/games/parks/250417-1214/modules/pks-cards.js",
    "readLevel": "public user-facing card descriptions read as text; not executed",
    "role": "all nine volunteer rule descriptions and Teddy movement labels",
    "sha256": "36794c0c109e75b2cc2fda60e1f8c62160a042c2c0451492536b6e1e921350e4"
  },
  "bga-effect-labels": {
    "url": "https://x.boardgamearena.net/data/themereleases/current/games/parks/250417-1214/modules/pks-effects.js",
    "readLevel": "public user-facing effect descriptions read as text; not executed",
    "role": "camping choices, purchases, photos and generic-resource labels",
    "sha256": "7be4873ace9611cecd71ad02d702046caaa313236860ce24a6026bde6f7bbddb"
  },
  "bga-campsite-faces": {
    "url": "https://x.boardgamearena.net/data/themereleases/current/games/parks/250417-1214/img/campsites.jpg",
    "readLevel": "all eight rows and all 32 campsite boxes visually compared in temporary image",
    "role": "camping printed costs, icons, counts and left-to-right order; not physical opposite-side pairing",
    "sha256": "886e0996a12c8a1140793ff77154023085254642bd6e000cfded3b5f9cdac97c"
  },
  "bga-trail-display": {
    "url": "https://x.boardgamearena.net/data/themereleases/current/games/parks/250417-1214/modules/pks-ui.js",
    "readLevel": "static display mapping read, not executed",
    "role": "corroborates tent positions 5,7,9 against official setup image"
  },
  "tts-public-components": {
    "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=3553489350",
    "author": "Kosjenka",
    "fileUrl": "https://cdn.steamusercontent.com/ugc/17088593081606538387/2DD386A3A52B9B504F85BB6355F859248D2C98B1/",
    "sha256": "06eb5069fe15ad70c8025c4f62b88ba10049a25843c178d3560ae4d92c7380ee",
    "readLevel": "public BSON data decoded only; four FaceURL/BackURL relationships read; all eight images visually mapped to BGA face IDs by researcher and reviewer",
    "role": "secondary explicit opposite-side relationships adopted for design; not publisher verification; no scripts or art imported"
  },
  "project": {
    "url": null,
    "path": "docs/proposals/parks/",
    "role": "本项目规则解释；不冒称官方裁定"
  }
});
