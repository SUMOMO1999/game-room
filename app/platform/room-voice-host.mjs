/** Stable, shared media slots. They are page furniture, never part of a game
 * state renderer. Both controls remain reachable in waiting and playing views. */
export function mountRoomVoiceHost({document:doc=globalThis.document,gameType}={}) {
  const toolbar=doc.querySelector('.room-toolbar-actions'),settings=doc.querySelector('.game-settings-body');
  if(!toolbar||!settings)throw new Error('房间语音缺少固定的工具栏或设置入口。');
  const group=doc.createElement('span');group.className='room-voice-toolbar';group.dataset.voiceGame=gameType;
  const joinRoot=doc.createElement('span'),microphoneRoot=doc.createElement('span');
  group.append(joinRoot,microphoneRoot);toolbar.insertBefore(group,toolbar.firstElementChild);
  const section=doc.createElement('section');section.className='room-voice-settings';
  const title=doc.createElement('h3');title.textContent='房间语音';
  const root=doc.createElement('div'),statusRoot=doc.createElement('div'),peers=doc.createElement('div');
  peers.className='room-voice-peers';section.append(title,root,statusRoot,peers);settings.append(section);
  // Flying chess's landscape header is the narrow right rail. Keep the
  // existing connection text in its persistent footer instead of squeezing
  // either the board or the exit. Restore the same node when media retires.
  const connection=gameType==='flying-chess'?doc.querySelector('#flying-connection'):null;
  const footer=gameType==='flying-chess'?doc.querySelector('.flying-footer'):null;
  const parent=connection?.parentNode,next=connection?.nextSibling;
  if(connection&&footer)footer.insertBefore(connection,footer.firstElementChild);
  return {root,joinRoot,microphoneRoot,statusRoot,peers,destroy(){group.remove();section.remove();if(connection&&parent&&footer)parent.insertBefore(connection,next??null);}};
}
