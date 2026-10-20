// A published category owns its default; room selections remain explicit.
// Missing metadata preserves the original server behavior for older releases.
const legacyOptInCategories = new Set(['friends','screen','idiom-abstract']);
export const categorySelectedByDefault = (category, packId = 'dg-base') => category.defaultSelected ?? (packId !== 'dg-base' || !legacyOptInCategories.has(category.id));
export const defaultDrawingCategoryIds = (categories, packId = 'dg-base') => categories
  .filter(category => category.status === 'active' && categorySelectedByDefault(category, packId))
  .map(category => category.id);
