const wide = [
  [0.34, 0.252],
  [0.67, 0.252],
  [0.797, 0.472],
  [0.716, 0.726],
  [0.286, 0.726],
  [0.202, 0.472],
];
const tall = [
  [0.28, 0.31],
  [0.72, 0.31],
  [0.88, 0.367],
  [0.81, 0.645],
  [0.19, 0.645],
  [0.12, 0.367],
];
const arrangements = {
  2: [0, 1],
  3: [0, 1, 3],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
};
export const dealerPoint = (portrait) => [0.51, portrait ? 0.34 : 0.235];
export function seatPoints(count, portrait) {
  return (arrangements[count] || arrangements[6]).map((i) => (portrait ? tall : wide)[i]);
}
