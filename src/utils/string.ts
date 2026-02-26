/** Allowed Unicode ranges: normal literature-style text + emoji. Newlines allowed. */
const SAFE_TEXT_RANGES: [number, number][] = [
  [0x000a, 0x000a], // LF
  [0x000d, 0x000d], // CR
  [0x0020, 0x007e], // Basic Latin (ASCII printable)
  [0x00a0, 0x00ff], // Latin-1 Supplement
  [0x0100, 0x017f], // Latin Extended-A
  [0x0180, 0x024f], // Latin Extended-B
  // Combining Diacritical Marks (0300-036f) excluded: strips decorative overlays (H̵e̵l̵l̵o̵ → Hello)
  [0x0370, 0x03ff], // Greek and Coptic
  [0x0400, 0x04ff], // Cyrillic
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // General Punctuation
  [0x20a0, 0x20cf], // Currency Symbols
  [0x2100, 0x214f], // Letterlike Symbols
  [0x2150, 0x218f], // Number Forms
  [0x2190, 0x21ff], // Arrows
  [0x2600, 0x26ff], // Miscellaneous Symbols (includes some emoji)
  [0x2700, 0x27bf], // Dingbats
  [0x1f300, 0x1f5ff], // Misc Symbols and Pictographs (emoji)
  [0x1f600, 0x1f64f], // Emoticons
  [0x1f680, 0x1f6ff], // Transport and Map
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
];

/** Decorative / stylized characters to strip even when in safe ranges (e.g. C‗o‗m‗b‗ → Comb). */
const STRIP_CODE_POINTS: Record<number, boolean> = {
  0x2017: true, // DOUBLE LOW LINE (‗)
};

function isAllowedCodePoint(codePoint: number): boolean {
  if (STRIP_CODE_POINTS[codePoint]) return false;
  return SAFE_TEXT_RANGES.some(
    ([lo, hi]) => codePoint >= lo && codePoint <= hi,
  );
}

function getCodePoint(str: string, i: number): { cp: number; length: number } {
  const lead = str.charCodeAt(i);
  if (lead >= 0xd800 && lead <= 0xdbff && i + 1 < str.length) {
    const trail = str.charCodeAt(i + 1);
    if (trail >= 0xdc00 && trail <= 0xdfff) {
      return {
        cp: (lead - 0xd800) * 0x400 + (trail - 0xdc00) + 0x10000,
        length: 2,
      };
    }
  }
  return { cp: lead, length: 1 };
}

/**
 * Keeps only characters in the safe UTF-8 range (normal text + emoji).
 * Strips control characters, private use, and other non-literature/special symbols.
 */
export function filterToSafeText(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const { cp, length } = getCodePoint(str, i);
    if (isAllowedCodePoint(cp)) {
      for (let j = 0; j < length; j++) result += str[i + j];
    }
    i += length - 1;
  }
  return result;
}

/**
 * True if the line is empty, only whitespace, or only &nbsp; (entity or character).
 */
function isBlankLine(line: string): boolean {
  const withoutNbsp = line
    .replace(/\u00A0/g, "")
    .replace(/&nbsp;/gi, "")
    .trim();
  return withoutNbsp === "";
}

/**
 * Transforms raw markdown from the editor: keeps only safe text + emoji,
 * treats lines that are only &nbsp; as empty, then collapses any run of
 * empty lines into a single empty line.
 */
export function cleanupMarkdownOutput(markdown: string): string {
  const safe = filterToSafeText(markdown);
  const lines = safe.split("\n");
  const result: string[] = [];
  let inBlankRun = false;
  for (const line of lines) {
    if (isBlankLine(line)) {
      if (!inBlankRun) {
        result.push("");
        inBlankRun = true;
      }
    } else {
      result.push(line);
      inBlankRun = false;
    }
  }
  return result.join("\n");
}
