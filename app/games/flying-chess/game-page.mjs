import { mountFlyingPage } from './page-ui.mjs';
import { RoomClient, api, loadMembership, forgetMembership } from '../../room-client.mjs';
import { accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle, loginHref, reauthenticationHref, logoutAccount } from '../../account-client.mjs';
import { createRoomSession, createRoomExit } from '../../platform/room-session.mjs';
import { mountRoomChat } from '../../room-chat.mjs';
import { gameErrorMessage } from '../../platform/room-presentation.mjs';
import { roomHref } from '../../game-routing.mjs';

const roomCode = new URLSearchParams(location.search).get('code') || '';
let client=null, view=null, chat=null, baseline=true, leaving=false, seatScope=null;
const session=createRoomSession({document,accountGeneration,accountState,getClient:()=>client});
const ui=mountFlyingPage({mode:'room',
  onAction:async(type,fields)=>{
    const current=client,fence=session.capture(current);
    if(!current || !session.current(fence))throw new Error('请恢复房间后继续。');
    try{await current.action(type,fields);}
    catch(error){if(session.current(fence)&&[401,503].includes(error.status))clearPrivate(error);throw error;}
  },
  getPending:()=>client?.pendingAction(),getStorageReady:()=>client?.actionStorageReady() ?? true,
  onRefresh:()=>client?.refresh(),onRetry:()=>client?.retryAction(),onRecover:()=>lifecycle.refresh(),
  onLeave:()=>exit.run(),
});
const exit=createRoomExit({session,roomCode,getClient:()=>client,getView:()=>view,forgetMembership,requireAcknowledgement:true,
  onPending:()=>{leaving=true;},onFailure:error=>{leaving=false;ui.leaveFailure(gameErrorMessage(error));},
  onLeft:()=>{exit.reset();seatScope=null;clearPrivate();location.href='./';},
});
function clearPrivate(error={}, {preserveDraft=error.status===503}={}){
  session.invalidate();client?.stop();chat?.clear({preserveDraft});client=null;view=null;baseline=true;leaving=false;
  ui.setConnection('offline');ui.conceal({message:error.status===503?'暂时无法核验账号，原骰面、席位和已确认棋位保留。请重新连接。':error.status===401?'请重新登录后恢复原席位和骰面。':error.status===404?'房间或原席位已关闭，请返回大厅。':error.message||'正在核验账号并恢复原席位…',
    loginHref:error.status===401?loginHref(`/?room=${roomCode}`):null,reauthHref:error.status===401?reauthenticationHref():null,preserveSelection:preserveDraft});
}
function boot(verifiedState){
  return session.bootstrap(()=>clearPrivate({}, {preserveDraft:true}),async task=>{
    try{
      const state=verifiedState||await loadAccount();
      if(!session.current(task,{account:false,verified:false})||state.verification!=='verified')return;
      if(!/^\d{6}$/.test(roomCode)){location.replace('./');return;}
      const legacy=state.mode==='legacy';
      if(!legacy&&!state.authenticated){clearPrivate({status:state.failureStatus===503||!state.loginReady?503:401});return;}
      let membership=legacy?loadMembership(roomCode):null,firstView=null;
      if(!legacy){
        try{firstView=(await api(`/api/rooms/${roomCode}`,{signal:task.controller.signal})).view;membership={roomCode,playerId:firstView.selfId,userKey:state.userKey};}
        catch(error){if(!session.current(task))return;if([403,404].includes(error.status)){location.replace(`./?room=${roomCode}`);return;}throw error;}
      }
      if(!session.current(task))return;
      if(!membership){location.replace(`./?room=${roomCode}`);return;}
      const nextScope=JSON.stringify([state.userKey || 'legacy',roomCode,membership.playerId]);
      if(seatScope!==null&&seatScope!==nextScope)exit.reset();seatScope=nextScope;
      const next=new RoomClient(roomCode,membership,{
        onView:value=>{
          if(!session.current(fence))return;
          if(value.gameType!=='flying-chess'){location.replace(roomHref(roomCode,value.gameType));return;}
          view=value;ui.applyView(value,{baseline});baseline=false;
        },
        onConnection:status=>{if(!session.current(fence))return;if(status!=='online')baseline=true;ui.setConnection(status);chat?.connection(status);},
        onChat:packet=>{if(session.current(fence))chat?.receive(packet);},
        onError:error=>{
          if(!session.current(fence)||leaving&&error.status===404)return;
          if(error.status===404&&view)forgetMembership(roomCode,view.selfId);
          if(error.status===404||!legacy&&[401,503].includes(error.status))clearPrivate(error);
          else ui.setMessage(gameErrorMessage(error));
        },
      });
      client=next;const fence=session.capture(next);
      if(firstView)next.receive(firstView);else await next.refresh();
      if(session.current(fence)){chat.attach(next,next.view,state);next.connect();}
    }catch(error){if(session.current(task,{verified:false}))clearPrivate(error);}
  });
}
chat=mountRoomChat({onCue:kind=>ui.audio.play(kind),onUnavailable:error=>clearPrivate(error.status===403?{...error,status:404}:error)});
const logout=document.createElement('button');logout.id='flying-logout';logout.textContent='退出棋牌室登录';document.querySelector('.room-menu-actions').append(logout);
logout.addEventListener('click',async()=>{exit.reset();seatScope=null;clearPrivate();try{await logoutAccount();location.href='./';}catch{clearPrivate({status:503});}});
onAccountChange(state=>{logout.hidden=state.mode==='legacy';if(!state.authenticated&&state.mode!=='legacy'||client&&client.accountEpoch!==accountGeneration())clearPrivate({status:state.failureStatus===503?503:401});});
const lifecycle=watchAccountLifecycle({onSuspend:()=>clearPrivate({message:'正在重新核验账号…'},{preserveDraft:true}),onVerified:state=>{logout.hidden=state.mode==='legacy';if(!client)boot(state);},onError:error=>clearPrivate(error)});
window.addEventListener('pagehide',event=>{if(!event.persisted){client?.stop();session.destroy();ui.destroy();}});
lifecycle.refresh();
