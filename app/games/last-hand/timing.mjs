import { timerFields } from './rules/table.mjs';
import { esc } from './widgets.mjs';

const valueOf = (config, key) => config?.[key] ?? timerFields[key].initial;
const duration = (seconds) => seconds % 60 === 0 ? seconds / 60 + ' 分钟' : seconds + ' 秒';

export function decisionSummary(config) {
  return '每次行动 ' + duration(valueOf(config, 'actionSeconds')) +
    '，摸二留一 ' + duration(valueOf(config, 'peekSeconds')) +
    '，组主手 ' + duration(valueOf(config, 'buildSeconds')) + '。';
}
export function matchSummary(config) {
  const minutes = valueOf(config, 'matchMinutes');
  return minutes ? '整桌 ' + minutes + ' 分钟，到点打完当前一战。' : '整桌不限时。';
}
function field(config, key, requiredLimit = false, disabled = false) {
  const { label, unit, min, max } = timerFields[key];
  const value = valueOf(config, key);
  const optional = key === 'matchMinutes';
  return '<label><span>' + label + ' <small>（' + unit + '）</small></span>' +
    '<input name="' + key + '" type="number" inputmode="numeric" step="1" min="' + (requiredLimit ? 1 : min) +
    '" max="' + max + '" value="' + esc(optional && !value ? '' : value) + '"' +
    (optional && !requiredLimit ? ' placeholder="不限时"' : ' required') + (disabled ? ' disabled' : '') + '></label>';
}
export function timeControls(config, expanded = false, practice = false) {
  const minutes = valueOf(config, 'matchMinutes');
  const limit = practice ? '<label class="check practiceLimit"><input type="checkbox" name="useMatchLimit"' +
    (minutes ? ' checked' : '') + '> 另设整场限时</label>' : '';
  return '<div class="timeControls span">' + limit + '<div class="matchDuration"' +
    (practice && !minutes ? ' hidden' : '') + '>' + field(config, 'matchMinutes', practice && !!minutes, practice && !minutes) +
    '<small>到点打完当前一战，战间到点直接结算。</small></div>' +
    '<details class="decisionTimes"' + (expanded ? ' open' : '') + '><summary>回合倒计时</summary><div>' +
    Object.keys(timerFields).filter((key) => key !== 'matchMinutes').map((key) => field(config, key)).join('') +
    '</div></details></div>';
}
export function readTimers(form) {
  // Reopen the group so the browser can focus an invalid field after it was collapsed.
  if (form.querySelector('.decisionTimes input:invalid')) form.querySelector('.decisionTimes').open = true;
  if (!form.reportValidity()) return null;
  const timers = Object.fromEntries(Object.keys(timerFields).map((key) => [key, Number(form.elements[key].value)]));
  if (form.elements.useMatchLimit && !form.elements.useMatchLimit.checked) timers.matchMinutes = 0;
  return timers;
}
export function togglePracticeLimit(control) {
  const form = control.form;
  const field = form.elements.matchMinutes;
  form.querySelector('.matchDuration').hidden = !control.checked;
  field.disabled = !control.checked;
  if (control.checked && !Number(field.value)) field.value = '60';
  field.min = control.checked ? '1' : '0';
  field.required = control.checked;
}
