import { IdentityFailure } from './auth.mjs';

// Only a completed atomic guard check returning false has this meaning.
// Timeouts, cancellation, changed sessions and storage faults remain ordinary
// failures, so callers cannot mistake them for safe read-only preparation.
export class OutputGuardConflict extends IdentityFailure {
  constructor() { super(503); this.name = 'OutputGuardConflict'; }
}

// A current active record has a different version from this event's fresh
// session. Its permission is not transferable: recovery needs a new check.
export class SessionOutputConflict extends IdentityFailure {
  constructor() { super(503); this.name = 'SessionOutputConflict'; }
}

/** Reprepare one private output; only a session conflict needs a new fresh check. */
export async function prepareCurrentRoomOutput({ sessions, session, context, prepare, refreshSession } = {}) {
  if (typeof sessions?.assertCurrent !== 'function' || !session || typeof session !== 'object'
    || typeof context?.assert !== 'function' || typeof context.wait !== 'function'
    || typeof prepare !== 'function' || refreshSession !== undefined && typeof refreshSession !== 'function') {
    throw new TypeError('Room output requires an owned identity context and preparation.');
  }
  const identityFields = ['id', 'userKey', 'issuer', 'sub'];
  const binding = Object.fromEntries(identityFields.map(field => [field, session[field]]));
  const lineage = session.authorizationLineage;
  let currentSession = session;
  for (let attempt = 0; attempt < 2; attempt++) {
    context.assert();
    const prepared = await context.wait(() => prepare(attempt));
    if (prepared === null) return null; // An obsolete packet is intentionally dropped.
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)
      || !Array.isArray(prepared.guards) || !prepared.guards.length) {
      throw new TypeError('Room output preparation requires current guards.');
    }
    try {
      await context.wait(() => sessions.assertCurrent(currentSession, { context, guards: prepared.guards }));
      context.assert();
      return prepared;
    } catch (error) {
      if (attempt !== 0) throw error;
      if (error instanceof SessionOutputConflict && refreshSession) {
        context.assert();
        if (typeof lineage !== 'string' || !/^[a-f0-9]{64}$/.test(lineage)) throw error;
        const refreshed = await context.wait(refreshSession);
        if (!refreshed || identityFields.some(field => refreshed[field] !== binding[field])) throw new IdentityFailure();
        // The same subject with new login/CSRF/token/client metadata is not an
        // idle renewal. Even a new successful check cannot rebase this packet.
        if (refreshed.authorizationLineage !== lineage) throw new IdentityFailure(503);
        currentSession = refreshed;
      } else if (!(error instanceof OutputGuardConflict)) throw error;
      // Keep the first event's deadline and cancellation. A new snapshot must
      // provide new guards; repeating the old guards cannot make it current.
      context.assert();
    }
  }
}
