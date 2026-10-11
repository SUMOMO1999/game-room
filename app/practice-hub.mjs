import { presentationCatalog } from './games/catalog.mjs';

// Decorative, locally drawn game objects. Navigation comes from the public
// presentation catalog; these pictures never decide which games are available.
const illustrations = Object.freeze({
  rummikub: '<g transform="translate(43 29) rotate(-10 25 43)"><rect width="48" height="82" rx="7" fill="#fffaf0" stroke="#cabda2" stroke-width="2"/><text x="24" y="51" text-anchor="middle" fill="#b7483b" font-size="36" font-weight="700">10</text></g><g transform="translate(90 22)"><rect width="48" height="82" rx="7" fill="#fffaf0" stroke="#cabda2" stroke-width="2"/><text x="24" y="51" text-anchor="middle" fill="#42688a" font-size="36" font-weight="700">10</text></g><g transform="translate(139 31) rotate(10 25 43)"><rect width="48" height="82" rx="7" fill="#fffaf0" stroke="#cabda2" stroke-width="2"/><text x="24" y="51" text-anchor="middle" fill="#344d43" font-size="36" font-weight="700">10</text></g>',
  'army-flip': '<path d="M28 49H195M28 89H195M70 18V119M150 18V119" stroke="#c7b897" stroke-width="2"/><g fill="#f9f0dc" stroke="#aa9063" stroke-width="3"><circle cx="70" cy="49" r="26"/><circle cx="150" cy="89" r="26"/></g><g text-anchor="middle" font-size="30" font-weight="650"><text x="70" y="60" fill="#405a47">军</text><text x="150" y="100" fill="#a9473d">旗</text></g>',
  'flying-chess': '<path d="M34 107Q85 137 139 79T198 31" fill="none" stroke="#8aa798" stroke-width="2" stroke-dasharray="5 7"/><g transform="translate(74 50) rotate(-23 36 24)"><path d="M0 27L26 20L35 0H43L45 19L68 27V33L45 32L42 49H36L31 33L0 35Z" fill="#43695b" stroke="#304d43" stroke-width="2"/></g><rect x="144" y="18" width="41" height="41" rx="9" fill="#fffaf0" stroke="#b4c8bd" stroke-width="2"/><g fill="#426759"><circle cx="155" cy="29" r="3"/><circle cx="174" cy="29" r="3"/><circle cx="155" cy="48" r="3"/><circle cx="174" cy="48" r="3"/></g>',
  'draw-and-guess': '<path d="M43 32H170V112H43Z" fill="#fffaf0" stroke="#c7bfa9" stroke-width="2"/><path d="M56 84Q74 60 92 77T147 57" fill="none" stroke="#bb7450" stroke-width="8" stroke-linecap="round"/><path d="M106 29L152 83L144 90L98 36Z" fill="#dfb65c" stroke="#ad8838" stroke-width="2"/><path d="M145 90L160 99L152 83Z" fill="#314c40"/><circle cx="66" cy="48" r="8" fill="#7d9d8a"/>',
  'poker414-2': '<g transform="translate(45 31) rotate(-13 24 40)"><rect width="52" height="82" rx="7" fill="#fffaf0" stroke="#c7b5aa" stroke-width="2"/><text x="11" y="28" fill="#ad4b43" font-size="26" font-weight="700">4</text><path d="M27 42L37 53L27 65L17 53Z" fill="#ad4b43"/></g><g transform="translate(93 20)"><rect width="52" height="82" rx="7" fill="#fffaf0" stroke="#c7b5aa" stroke-width="2"/><text x="11" y="28" fill="#385549" font-size="26" font-weight="700">A</text><path d="M27 42L16 57Q19 69 27 60Q35 69 38 57Z" fill="#385549"/></g><g transform="translate(138 30) rotate(13 24 40)"><rect width="52" height="82" rx="7" fill="#fffaf0" stroke="#c7b5aa" stroke-width="2"/><text x="11" y="28" fill="#ad4b43" font-size="26" font-weight="700">4</text><path d="M18 51Q18 38 28 46Q39 38 39 51Q36 59 28 65Q21 59 18 51Z" fill="#ad4b43"/></g>',
  'hyakki-trading': '<path d="M47 53H173V116H47Z" fill="#496a51"/><path d="M34 53L49 26H171L186 53Z" fill="#ab764b"/><path d="M45 53V39M66 53V32M88 53V29M110 53V27M132 53V29M154 53V32M175 53V40" stroke="#efd49e" stroke-width="10"/><path d="M67 74H153V116H67Z" fill="#f5e2b9"/><circle cx="113" cy="90" r="17" fill="#d7b467" stroke="#9c7b3e" stroke-width="2"/><path d="M109 86H117V94H109Z" fill="#f5e2b9"/>',
  parks: '<circle cx="163" cy="34" r="15" fill="#e1bf6e"/><path d="M25 109L85 31L146 109Z" fill="#839d83"/><path d="M86 31L108 60L83 50L65 59Z" fill="#f5f4e9"/><path d="M104 112L145 60L190 112Z" fill="#456b57"/><path d="M145 60L160 79L144 74L131 80Z" fill="#f5f4e9"/><path d="M88 124Q143 95 99 84Q71 78 89 63" fill="none" stroke="#f2deb2" stroke-width="5" stroke-linecap="round"/><path d="M29 96L38 74L47 96Z" fill="#315747"/>',
});
const fallbackIllustration = '<rect x="59" y="31" width="62" height="84" rx="8" fill="#fffaf0" stroke="#acbda9" stroke-width="2" transform="rotate(-10 90 73)"/><rect x="104" y="22" width="62" height="84" rx="8" fill="#315b50"/><text x="135" y="80" text-anchor="middle" fill="#fffaf0" font-size="44" font-family="Georgia,serif">3</text>';

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function gameCard(document, game) {
  const card = element(document, 'article', 'hub-game');
  card.dataset.game = game.gameType;
  const art = element(document, 'div', 'hub-art');
  art.dataset.art = game.gameType;
  art.setAttribute('aria-hidden', 'true');
  // Only fixed local illustrations reach innerHTML. Game labels use textContent.
  const drawing = Object.hasOwn(illustrations, game.gameType) ? illustrations[game.gameType] : fallbackIllustration;
  art.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 140" focusable="false">${drawing}</svg>`;
  const body = element(document, 'div', 'hub-body');
  const title = element(document, 'h3', '', game.name);
  title.id = `hub-${game.gameType}`;
  card.setAttribute('aria-labelledby', title.id);
  const description = element(document, 'p', 'hub-summary', game.practiceSummary);
  const practice = element(document, 'a', 'hub-primary', '开始练习');
  practice.href = `./${game.practicePage}`;
  practice.setAttribute('aria-label', `${game.name}练习`);
  const arrow = element(document, 'span', '', '→');
  arrow.setAttribute('aria-hidden', 'true'); practice.append(arrow);
  body.append(title, description, practice);
  if (game.practiceLinks.length) {
    const links = element(document, 'nav', 'hub-links');
    links.setAttribute('aria-label', `${game.name}更多玩法`);
    for (const entry of game.practiceLinks) {
      const link = element(document, 'a', '', entry.label);
      link.href = `./${entry.page}`;
      link.setAttribute('aria-label', `${game.name}${entry.label}`);
      links.append(link);
    }
    body.append(links);
  }
  card.append(art, body); return card;
}

/** One game, one group. Room availability and accounts do not gate local practice. */
export function mountPracticeHub({ document, catalog = presentationCatalog } = {}) {
  const grid = document?.getElementById('hub-games');
  if (!grid) return () => {};
  const search = document.getElementById('hub-search');
  const count = document.getElementById('hub-count');
  const empty = document.getElementById('hub-empty');
  const games = catalog.list().filter(game => game.practicePage !== null);
  const records = games.map(game => ({
    searchText: `${game.name} ${game.gameType}`.normalize('NFKC').toLocaleLowerCase('zh-CN'),
    card: gameCard(document, game),
  }));
  grid.replaceChildren(...records.map(record => record.card));
  const filter = () => {
    const query = search.value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
    let visible = 0;
    for (const record of records) {
      record.card.hidden = !record.searchText.includes(query);
      if (!record.card.hidden) visible++;
    }
    count.textContent = query ? `${visible} / ${records.length} 款` : `${records.length} 款游戏`;
    empty.hidden = visible !== 0;
  };
  search.addEventListener('input', filter); filter();
  return () => search.removeEventListener('input', filter);
}

if (typeof document !== 'undefined') mountPracticeHub({ document });
