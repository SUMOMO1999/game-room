import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createResumablePeers, resumeProtocol } from './resumable-peer.mjs';

export const relaySourceSha256 = '50a3bdb3575603d3eab9b5f8083654d9a9ccf3d6e68706703859e9e675faed51';
export const relayProtocol = 'sumomo-noname-v1';

// Presence counts people. Each tab still owns its native connection, seat and
// reconnect window. Return the viewer's own native id for the blue "me" row.
function lobbyRoster(clients) {
  const byPlayer = new Map();
  for (const client of clients) {
    // clientIp here is the authenticated platform player id installed below.
    const previous = byPlayer.get(client.clientIp);
    if (!previous || client.room || !previous.room && (client.nickname || !previous.nickname)) {
      byPlayer.set(client.clientIp, client);
    }
  }
  const row = c => [c.nickname, c.avatar, !c.room, c.status, c.wsid, c.onlineKey];
  const people = [...byPlayer.values()];
  const rows = people.map(row);
  const indices = new Map(people.map((c, i) => [c.clientIp, i]));
  return viewer => {
    const index = indices.get(viewer.clientIp);
    if (index === undefined || people[index] === viewer) return rows;
    const ownView = rows.slice();
    ownView[index] = row(viewer);
    return ownView;
  };
}

// These context-checked edits are applied to packages/server/src/server/createServer.ts
// from libnoname/noname v1.11.6.1. Distribute the original source and its GPL notice
// with the candidate. An unreviewed upstream change cannot become a deployed relay.
function patchedModule(source) {
  if (createHash('sha256').update(source).digest('hex') !== relaySourceSha256) {
    throw new Error('Unsupported Noname relay source. Review the upstream changes before upgrading.');
  }
  const edits = [
    ['from "ws"', 'from ' + JSON.stringify(import.meta.resolve('ws'))],
    ['const port = options.port ?? 8082;', 'const port = options.port ?? 8082;\n\tconst { bridge } = options;'],
    ['if (client.onlineKey !== key) return;', `if (typeof key !== "string" || !key || client.onlineKey !== key) return;
      if (!bridge.canCreate() || client.room) return util.sendl(client, "enterroomfailed");
      if (managed) return managed.create(client, key, nickname, avatar, config, mode);
      if (rooms.has(key)) return util.sendl(client, "enterroomfailed");`],
    ['const handlers: Record', 'const managed = bridge.bindManaged({rooms, util});\n\tconst handlers: Record'],
    ['\t\tcreate(client: Client, key: string,', `    myTable(client: Client) { return managed?.myTable(client); },
    returnToTable(client: Client, id: string, nickname: string, avatar: string) {
      if (typeof id === "string" && typeof nickname === "string" && typeof avatar === "string") {
        return managed?.returnToTable(client, id, nickname, avatar);
      }
    },
    async leaveFinished(client: Client, id: string) {
      if (!managed || typeof id !== "string") return;
      if (!await managed.leaveFinished(client, id)) {
        await managed.myTable(client);
        util.sendl(client, "sumomoNoSavedTable");
      }
    },
    create(client: Client, key: string,`],
    ['create(client: Client, key: string,', 'async create(client: Client, key: string,'],
    ['rooms.set(key, room);', `if (!await bridge.created(client, room)) return util.sendl(client, "enterroomfailed");
      rooms.set(key, room);`],
    ['config(client: Client, config: any) {', `async finishMatch(client: Client) {
      await bridge.completed(client);
    },
    async config(client: Client, config: any) {`],
    ['room.config = config;', 'if (config?.gameStarted === true) await bridge.started(client);\n      room.config = config;'],
    ['enter(client: Client, key: string, nickname: string, avatar: string)', 'enter(client: Client, key: string, nickname: string, avatar: string, intent?: string)'],
    ['const room = rooms.get(key);', `if (client.owner || client.room?.owner === client) return util.sendl(client, "enterroomfailed");
      const room = rooms.get(key);
      if (room?.managed) return managed.enter(client,room,nickname,avatar,intent);`],
    ['const count = clientCount.get(key) || 0;', 'const count = room.managed ? room.seated : clientCount.get(key) || 0;'],
    ['roomList.push([room.owner.nickname, room.owner.avatar, room.config, count, room.key]);', `const config = room.config;
          if (!room.managed || (!config.sumomoFinished && (config.gameStarted
              ? config.observe && config.observeReady
              : count < Number(config.number)))) {
            roomList.push([room.owner.nickname, room.owner.avatar, config, count, room.key]);
          }`],
    ['if (count === 0) {','if (count === 0 && !room.managed) {'],
    ['if (client.owner) util.sendl(client.owner, "onclose", client.wsid);',
      'if (client.owner && !client.room?.managed) util.sendl(client.owner, "onclose", client.wsid);'],
    ['client.avatar = avatar;\n\t\t\tclient.room = room;\n\t\t\tdelete client.status;', 'client.avatar = avatar;'],
    ['room.config.gameStarted && (!room.config.observe || !room.config.observeReady)',
      'room.config.gameStarted && (!room.config.observe || !room.config.observeReady) && !bridge.mayReconnect(client, room)'],
    ['client.owner = room.owner;', 'client.room = room;\n\t\t\tdelete client.status;\n\t\t\tclient.owner = room.owner;\n\t\t\tbridge.entered(client, room);'],
    ['send(client: Client, id: string, message: string) {', 'async send(client: Client, id: string, message: string) {'],
    ['target.send(message);', `if (!await bridge.hostMessage(client, target, message)) {
          util.sendl(target, "denied", "banned");
          bridge.kicked(target);
          target.close();
          return;
        }
        target.send(message);`],
    ['if (target && target.owner === client) target.close();', `if (target && target.owner === client) {
        bridge.kicked(target);
        target.close();
      }`],
    ['const client = ws as Client;', `const client = ws as Client;
    const platformPeer = options.attach(ws, req);
    if (!platformPeer) return ws.close(1008);
    ws.on("transport", () => bridge.transportChanged(ws));
    ws.once("close", () => bridge.detach(ws));`],
    // The edge owns the loopback TCP peer. Native ban accounting must distinguish
    // authenticated players behind that single proxy address.
    ['const ip = req.socket.remoteAddress ?? "";', 'const ip = platformPeer;'],
    ['client.wsid = util.newId();', 'do { client.wsid = util.newId(); } while (clients.has(client.wsid));'],
    [`buildClientList(): any[] {
			const out: any[] = [];
			clients.forEach(c => {
				out.push([c.nickname, c.avatar, !c.room, c.status, c.wsid, c.onlineKey]);
			});
			return out;
		}`, 'buildClientList() { return options.lobbyRoster(clients.values()); }'],
    ['"updaterooms", roomList, clientList)', '"updaterooms", roomList, clientList(c))'],
    ['"updateclients", list)', '"updateclients", list(c))'],
    ['util.checkEvents(), util.buildClientList(), client.wsid', 'util.checkEvents(), util.buildClientList()(client), client.wsid'],
    ['util.sendl(client.owner, "onmessage", client.wsid, raw);', `if (client.room?.managed) return managed.receive(client, raw);
          const forwarded = bridge.guestMessage(client, raw);
          if (forwarded === null) {
            util.sendl(client, "denied", "banned");
            bridge.kicked(client);
            client.close();
            return;
          }
          util.sendl(client.owner, "onmessage", client.wsid, forwarded);`],
    ['const handler = handlers[type];', 'const handler = Object.hasOwn(handlers, type) && handlers[type];'],
    ['client.on("message", msg => {', `let delivery = Promise.resolve();
    client.on("message", msg => {
      delivery = delivery.then(() => receive(msg)).catch(() => process.emitWarning("Noname message could not be delivered"));
    });
    async function receive(msg) {`],
    ['\n\t\t});\n\n\t\t// disconnect handler', '\n\t\t}\n\n\t\t// disconnect handler'],
    ['handler(client, ...arr);', `await Promise.resolve(handler(client, ...arr)).catch(error => {
      options.onOperationError(error, type);
      if (type === "create") util.sendl(client, "enterroomfailed");
    });`],
    ['new WebSocketServer({ port })', 'new WebSocketServer({ ...options.webSocketOptions, port })'],
    ['server.on("connection", handleConnection);', 'server.on("connection", (ws, req) => options.connect(ws, req, handleConnection));'],
    ['server.off("error", handleError);', 'server.off("error", handleError);\n\t\t\t\t\toptions.onListening(server.address());'],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Unexpected Noname relay patch context.');
    source = source.replace(before, () => after);
  }
  // Native Node deployment uses no compiler service or writable source checkout.
  // Both type-only imports disappear here. The only runtime dependency is pinned ws.
  const js = stripTypeScriptTypes(source);
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}

export async function startNonameRelay({
  sourcePath, bridge, gameOrigin, host = '127.0.0.1', port = 8082, path = '/lobby',
}) {
  const origin = new URL(gameOrigin);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.hostname.endsWith('.localhost');
  if (origin.origin !== gameOrigin || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))
      || !['127.0.0.1', '::1'].includes(host) || !/^\/[A-Za-z0-9_/-]*$/.test(path)
      || !Number.isInteger(port) || port < 0 || port > 65535 || !bridge?.consume) {
    throw new TypeError('Expected an isolated game origin, loopback relay endpoint and a room bridge.');
  }
  const { createServer } = await patchedModule(await readFile(sourcePath, 'utf8'));
  const pending = new WeakMap();
  const resumable = createResumablePeers({leaveSeat:socket => bridge.leaveSeat(socket),
    hasOtherTerminal:claim => bridge.hasOtherTerminal(claim)});
  let address;
  const server = createServer({
    bridge, port, lobbyRoster, onOperationError(error, type) {
      if (process.env.NONAME_LOCAL_DIAGNOSTICS === '1' && local) console.error(type, error.message);
      else process.emitWarning("Noname room operation could not be committed");
    },
    webSocketOptions: {
      host, path,
      verifyClient({ req }, done) {
        const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
        if (req.url !== path || req.headers.origin !== gameOrigin || protocols.length !== 2
            || ![relayProtocol, resumeProtocol].includes(protocols[0]) || !/^ticket\.[\w-]{43}$/.test(protocols[1])) {
          return done(false, 403, 'Forbidden');
        }
        const claim = bridge.consume(protocols[1].slice(7));
        if (!claim) return done(false, 403, 'Forbidden');
        pending.set(req, claim);
        done(true);
      },
      handleProtocols: protocols => protocols.has(resumeProtocol) ? resumeProtocol : relayProtocol,
    },
    connect(socket, req, nativeConnect) {
      if (socket.protocol !== resumeProtocol) return nativeConnect(socket, req);
      const claim = pending.get(req);
      if (!claim) return socket.close(1008);
      resumable.accept(socket, claim, peer => nativeConnect(peer, req));
    },
    attach(socket, req) {
      const claim = pending.get(req);
      pending.delete(req);
      return bridge.attach(socket, claim) ? claim.playerId : null;
    },
    onListening(value) { address = value; },
  });
  await server.start();
  return { port: address.port, stop() { resumable.close(); return server.stop(); } };
}
