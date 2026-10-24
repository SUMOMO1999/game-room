import {isExpansionContentVersion} from './content/expansion-one.mjs';
import {decodeHistory4Metadata} from './public-history-v4.mjs';
/** Decode only the already validated public vocabulary. Keep opening separate from a player's turn. */
export function readableBattleGroup(group){
  if(group?.schemaVersion!==4)return group;
  const metadata=decodeHistory4Metadata(group.metadata,{contentVersion:group.contentVersion,participantIds:group.participantIds});
  if(!isExpansionContentVersion(group.contentVersion))return {...group,...metadata};
  const source=metadata.source;
  const discard={...metadata.discard,removed:metadata.discard.removed.map(i=>({index:i.index,cardId:i.definitionId})),
    added:metadata.discard.added.map(i=>({...i,cardId:i.definitionId,sourceCardId:i.source?.kind==='card'?i.source.definitionId:null,
      ...(i.source?.kind==='role'?{sourceRoleId:i.source.roleId}:{} )}))};
  return {...group,opening:metadata.anchor.kind==='opening',rolesRevealed:metadata.rolesRevealed,
    turn:metadata.anchor.kind==='turn'?Object.fromEntries(Object.entries(metadata.anchor).filter(([key])=>key!=='kind')):null,
    sourceCardId:source?.kind==='card'?source.definitionId:null,sourceRole:source?.kind==='role'?source:null,
    changes:metadata.changes,discard};
}
