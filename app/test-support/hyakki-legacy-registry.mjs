import { createGameRegistry, defaultGameRegistry } from '../game-registry.mjs';
import { createHyakkiAdapter } from '../../server/games/hyakki-trading/adapter.mjs';

// These fixtures pin the pre-expansion v2 contracts. New-room defaults and
// full expansion play are exercised separately against the actual registry.
export const legacyHyakkiRegistry = createGameRegistry(defaultGameRegistry.knownTypes().map(type =>
  type === 'hyakki-trading' ? createHyakkiAdapter() : defaultGameRegistry.gameAdapter(type)),
{ creationTypes: defaultGameRegistry.creationTypes() });
