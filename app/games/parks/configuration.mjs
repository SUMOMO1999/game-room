// Public presentation and creation presets. The domain judge validates every
// server submission; these labels never grant permission to start or act.
export const DEFAULT_PARKS_CONFIGURATION = Object.freeze({mode:'standard',camping:false,volunteerCount:0,passionChoice:'random'});
export const PARKS_MODES = Object.freeze({standard:'朋友徒步 · 2～5人',teddy:'Teddy同行 · 2人',solo:'单人挑战 · 1人'});
export const PARKS_PASSION_CHOICES = Object.freeze({random:'随机热忱',choose:'二选一热忱'});
export function parksCreationConfiguration(document) {
  return {parksConfig:{mode:document.getElementById('create-parks-mode')?.value ?? DEFAULT_PARKS_CONFIGURATION.mode,
    camping:document.getElementById('create-parks-camping')?.checked ?? DEFAULT_PARKS_CONFIGURATION.camping,
    volunteerCount:Number(document.getElementById('create-parks-volunteers')?.value ?? DEFAULT_PARKS_CONFIGURATION.volunteerCount),
    passionChoice:document.getElementById('create-parks-passion')?.value ?? DEFAULT_PARKS_CONFIGURATION.passionChoice}};
}
