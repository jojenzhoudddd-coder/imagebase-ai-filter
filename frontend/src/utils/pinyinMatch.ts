import { pinyin } from "pinyin-pro";

/**
 * Pinyin fuzzy match: returns true if `query` matches `text` via any of:
 *  1. Original text contains query (case-insensitive)
 *  2. Full pinyin (no spaces) contains query
 *  3. Pinyin initials contain query
 */
export function pinyinMatch(text: string, query: string): boolean {
  const q = query.toLowerCase();

  // Strategy 1: original text
  if (text.toLowerCase().includes(q)) return true;

  // Strategy 2: full pinyin (no spaces, no tones)
  const fullPy = pinyin(text, { toneType: "none", type: "array" }).join("").toLowerCase();
  if (fullPy.includes(q)) return true;

  // Strategy 3: pinyin initials
  const initials = pinyin(text, { pattern: "first", toneType: "none", type: "array" }).join("").toLowerCase();
  if (initials.includes(q)) return true;

  return false;
}
