const voiceGames = new Set(['rummikub','army-flip','flying-chess','draw-and-guess','poker414-2','hyakki-trading']);
/** Explicit product boundary: Parks and unpublished games never acquire media. */
export const supportsRoomVoice = gameType => voiceGames.has(gameType);
export const roomVoicePages = Object.freeze(['room.html','army.html','flying.html','drawing.html','poker414.html','hyakki.html']);
