import {isExpansionContentVersion} from './content/expansion-one.mjs';
import {decodeHistory4Metadata} from './public-history-v4.mjs';
import {decodeHistory5Metadata,PUBLIC_ORDER_HISTORY_VERSION} from './public-history-v5.mjs';
/** Decode only the already validated public vocabulary. Keep opening separate from a player's turn. */
export function readableBattleGroup(group){
  const orders=group?.schemaVersion===PUBLIC_ORDER_HISTORY_VERSION;
  if(group?.schemaVersion!==4&&!orders)return group;
  const context={contentVersion:group.contentVersion,participantIds:group.participantIds};
  const metadata=orders?decodeHistory5Metadata(group.metadata,{...context,modules:group.modules}):decodeHistory4Metadata(group.metadata,context);
  if(!orders&&!isExpansionContentVersion(group.contentVersion))return {...group,...metadata};
  const source=metadata.source;
  const discard={...metadata.discard,removed:metadata.discard.removed.map(i=>({index:i.index,cardId:i.definitionId})),
    added:metadata.discard.added.map(i=>({...i,cardId:i.definitionId,sourceCardId:i.source?.kind==='card'?i.source.definitionId:null,
      ...(i.source?.kind==='role'?{sourceRoleId:i.source.roleId}:{} )}))};
  return {...group,opening:metadata.anchor.kind==='opening',rolesRevealed:metadata.rolesRevealed,
    turn:metadata.anchor.kind==='turn'?Object.fromEntries(Object.entries(metadata.anchor).filter(([key])=>key!=='kind')):null,
    sourceCardId:source?.kind==='card'?source.definitionId:null,sourceRole:source?.kind==='role'?source:null,
    changes:metadata.changes,discard};
}
