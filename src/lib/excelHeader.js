// Excel header colour = Bashaier's signature.
//
// Any spreadsheet generated under Bashaier's PSN (H94830) gets a baby-pink
// header band with black text, so the file visibly reads "prepared by HR /
// Bashaier" the moment it is opened. Everyone else keeps the default brand
// header (green band, white text) passed in by the caller.
//
// rgb values are bare 6-hex strings (no '#') to match the SheetJS / xlsx-js-style
// `fill.fgColor.rgb` and `font.color.rgb` convention used across the exporters.

export const BASHAIER_PSN = 'H94830';
export const BASHAIER_HEADER_BG = 'F7C5D0'; // baby pink
export const BASHAIER_HEADER_FG = '0A0A0A'; // black

// Returns { bg, fg } hex strings for header cells.
export function excelHeaderRgb(me, defaultBg = '0F4C2A', defaultFg = 'FFFFFF') {
  return me?.id === BASHAIER_PSN
    ? { bg: BASHAIER_HEADER_BG, fg: BASHAIER_HEADER_FG }
    : { bg: defaultBg, fg: defaultFg };
}
