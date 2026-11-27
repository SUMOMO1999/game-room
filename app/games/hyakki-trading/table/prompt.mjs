/** The game supplies the legal controls. Their positions and the printed card stay steady between choices. */
export function tablePrompt({
  visual,
  title,
  context = '',
  description = '',
  actions = '',
  secondary = '',
  kind = 'moment',
  label = '',
  step = ''
}) {
  const source = visual ? `<div class="nt-object" data-source-kind="${kind}">${visual}</div>` : '';
  const heading = `<div class="nt-prompt-title"><h2>${title}</h2>${secondary}</div>`;
  return `<section class="nt-moment" data-prompt="${kind}"${step ? ` data-step-kind="${step}"` : ''}${label ? ` aria-label="${label}"` : ''}>${source}<div class="nt-moment-copy">${context ? `<small>${context}</small>` : ''}${heading}<div class="nt-description">${description}</div>${actions ? `<div class="nt-moment-actions">${actions}</div>` : ''}</div></section>`;
}
