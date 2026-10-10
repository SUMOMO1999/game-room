import { createCardRoomController } from '../../platform/card-room-controller.mjs';
import { parksCommand, parksCues, PARKS_BUSINESS_TYPES } from './presentation.mjs';

export function createParksRoomController(options) {
  return createCardRoomController({ ...options,
    policy: { gameType: 'parks', businessTypes: PARKS_BUSINESS_TYPES, command: parksCommand, cues: parksCues } });
}
