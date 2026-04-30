/**
 * idea-preview-orphan-rescue-smoke — verifies the orphan-rescue branch in
 * MarkdownPreview.commitEdits handles the cases the bug report flagged:
 *
 *   1. Pasted content (multi-line plain text) lands in source, not just DOM.
 *   2. Enter-splitting an existing paragraph keeps the second half in source.
 *   3. Pure-typing inside an existing paragraph still hits the fast splice
 *      path and doesn't trip the orphan rescue.
 *
 * The frontend has no test runner today; this script duplicates the rescue
 * algorithm and runs it against synthetic JSDOM trees that mirror what
 * Chrome produces post-Enter / post-paste. If the algorithm-under-test
 * diverges from the production copy in MarkdownPreview.tsx, that's a
 * porting bug to fix in BOTH places — this smoke is a tripwire, not a
 * source of truth.
 *
 * Run:
 *   cd backend && npx tsx src/scripts/idea-preview-orphan-rescue-smoke.ts
 */

import { JSDOM } from "jsdom";

// ─── Algorithm under test (mirrors MarkdownPreview.commitEdits) ────────

interface CommitInput {
  /** The contenteditable root element. */
  root: HTMLElement;
  /** Last-seen source string (the snapshot we splice deltas against). */
  sourceSnapshot: string;
}

interface CommitOutput {
  /** Updated source after splicing block edits + rescuing orphans. */
  newSource: string;
  /** True if the rescue branch fired. */
  rescuedOrphan: boolean;
}

/**
 * Pure-function port of MarkdownPreview's commitEdits. Limits:
 *   - No mention chips / inline atomics in the test fixtures (the production
 *     rebuildFromDom path uses data-md-inline-src which the orphan rescue
 *     also handles; we're targeting orphan rescue specifically).
 *   - No IME composition guard (the tests run synchronously).
 */
function runCommit({ root, sourceSnapshot }: CommitInput): CommitOutput {
  const blocks = root.querySelectorAll<HTMLElement>("[data-md-start]");

  // Empty-doc root fallback.
  if (blocks.length === 0) {
    const currentText = (root.textContent || "").replace(/ /g, " ");
    return { newSource: currentText, rescuedOrphan: false };
  }

  // Per-block edits.
  const edits: Array<{ start: number; end: number; newSlice: string }> = [];
  blocks.forEach((block) => {
    const startStr = block.getAttribute("data-md-start");
    const endStr = block.getAttribute("data-md-end");
    const origText = block.getAttribute("data-md-orig-text") ?? "";
    if (!startStr || !endStr) return;
    const start = Number(startStr);
    const end = Number(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    if (block.querySelector("[data-md-start]") !== null) return;
    const currentText = (block.textContent || "").replace(/ /g, " ");
    if (currentText === origText) return;
    if (currentText.replace(/^\s+|\s+$/g, "") === origText.replace(/^\s+|\s+$/g, "")) return;
    const srcSlice = sourceSnapshot.slice(start, end);
    const idx = srcSlice.indexOf(origText);
    if (idx < 0) return; // simplification — tests don't exercise rebuildFromDom
    const newSlice = srcSlice.slice(0, idx) + currentText + srcSlice.slice(idx + origText.length);
    if (newSlice === srcSlice) return;
    edits.push({ start, end, newSlice });
  });

  // Orphan detection — the bug fix being verified.
  let hasOrphan = false;
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1) continue; // ELEMENT_NODE
    const el = child as HTMLElement;
    if (el.tagName === "BR") continue;
    if (el.hasAttribute("data-md-start")) continue;
    if (el.hasAttribute("data-idea-empty-line")) continue;
    hasOrphan = true;
    break;
  }

  if (edits.length === 0 && !hasOrphan) {
    return { newSource: sourceSnapshot, rescuedOrphan: false };
  }

  // Splice per-block edits.
  edits.sort((a, b) => b.start - a.start);
  let newSource = sourceSnapshot;
  for (const e of edits) {
    newSource = newSource.slice(0, e.start) + e.newSlice + newSource.slice(e.end);
  }

  // Propagate offsets.
  const editsByStart = new Map<number, number>();
  for (const e of edits) editsByStart.set(e.start, e.newSlice.length);
  let delta = 0;
  blocks.forEach((block) => {
    const oldStart = Number(block.getAttribute("data-md-start"));
    const oldEnd = Number(block.getAttribute("data-md-end"));
    if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd)) return;
    const newLen = editsByStart.get(oldStart);
    block.setAttribute("data-md-start", String(oldStart + delta));
    if (newLen !== undefined) {
      block.setAttribute("data-md-end", String(oldStart + delta + newLen));
      delta += newLen - (oldEnd - oldStart);
    } else {
      block.setAttribute("data-md-end", String(oldEnd + delta));
    }
  });

  // Orphan rescue: rebuild source by walking root in DOM order.
  if (hasOrphan) {
    const flattenOrphan = (n: Node, into: string[]) => {
      if (n.nodeType === 3) { // TEXT_NODE
        into.push((n.textContent || "").replace(/ /g, " "));
        return;
      }
      if (n.nodeType === 1) { // ELEMENT_NODE
        const el = n as HTMLElement;
        const inSrc = el.getAttribute("data-md-inline-src");
        if (inSrc != null) { into.push(inSrc); return; }
        if (el.tagName === "BR") { into.push("\n"); return; }
        for (const c of Array.from(el.childNodes)) flattenOrphan(c, into);
      }
    };

    const parts: string[] = [];
    const childrenInOrder = Array.from(root.childNodes).filter(
      (n): n is HTMLElement => n.nodeType === 1,
    );
    for (const child of childrenInOrder) {
      if (child.tagName === "BR") continue;
      if (child.hasAttribute("data-md-start")) {
        const s = Number(child.getAttribute("data-md-start"));
        const e = Number(child.getAttribute("data-md-end"));
        if (Number.isFinite(s) && Number.isFinite(e)) {
          const slice = newSource.slice(s, e).replace(/\n*$/, "") + "\n\n";
          parts.push(slice);
          continue;
        }
      }
      const buf: string[] = [];
      for (const c of Array.from(child.childNodes)) flattenOrphan(c, buf);
      let content = buf.join("");
      content = content.replace(/\n+$/, "");
      const tag = child.tagName.toLowerCase();
      let prefix = "";
      if (/^h[1-6]$/.test(tag)) {
        prefix = "#".repeat(Number(tag[1])) + " ";
      } else if (tag === "blockquote") {
        prefix = "> ";
      } else if (tag === "li") {
        prefix = "- ";
      }
      if (content.length === 0 && prefix === "") {
        parts.push("\n");
      } else {
        parts.push(prefix + content + "\n\n");
      }
    }
    newSource = parts.join("");
  }

  return { newSource, rescuedOrphan: hasOrphan };
}

// ─── Test harness ──────────────────────────────────────────────────────

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const document = dom.window.document;
type DocLike = typeof document;
type ElLike = HTMLElement;

function makeRoot(): ElLike {
  const r = document.createElement("div") as unknown as ElLike;
  return r;
}

function makeBlock(
  doc: DocLike,
  tag: string,
  text: string,
  start: number,
  end: number,
): ElLike {
  const el = doc.createElement(tag) as unknown as ElLike;
  el.setAttribute("data-md-start", String(start));
  el.setAttribute("data-md-end", String(end));
  el.setAttribute("data-md-orig-text", text);
  el.textContent = text;
  return el;
}

function makeOrphan(doc: DocLike, tag: string, text: string): ElLike {
  const el = doc.createElement(tag) as unknown as ElLike;
  if (text === "") {
    el.appendChild(doc.createElement("br"));
  } else {
    el.textContent = text;
  }
  return el;
}

let pass = 0;
let fail = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : err}`);
    fail++;
  }
};

const eq = <T>(actual: T, expected: T, what: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what} mismatch:\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
};

console.log("\nidea-preview orphan-rescue smoke");
console.log("=================================");

// Case 1: Pure typing inside existing block — fast path, no rescue.
test("pure typing in existing paragraph splices delta, no rescue", () => {
  const root = makeRoot();
  const block = makeBlock(document, "p", "Hello", 0, 7);
  // User typed "X" — innerText is now "HelloX".
  block.textContent = "HelloX";
  root.appendChild(block);
  const out = runCommit({ root, sourceSnapshot: "Hello\n\n" });
  eq(out.rescuedOrphan, false, "should not rescue");
  eq(out.newSource, "HelloX\n\n", "newSource");
});

// Case 2: Enter at end of "Hello" creates orphan empty <p><br></p>.
test("Enter at end of paragraph adds blank line via rescue", () => {
  const root = makeRoot();
  const block = makeBlock(document, "p", "Hello", 0, 7);
  root.appendChild(block);
  // Browser inserted an orphan empty paragraph.
  root.appendChild(makeOrphan(document, "p", ""));
  const out = runCommit({ root, sourceSnapshot: "Hello\n\n" });
  eq(out.rescuedOrphan, true, "should rescue");
  // Rescue picks Block1 slice + orphan-as-blank-line. Orphan is empty so
  // rescue emits a single "\n" placeholder so the user can keep typing.
  eq(out.newSource, "Hello\n\n\n", "newSource");
});

// Case 3: Enter then typing — orphan now has content.
test("Enter + typing preserves new paragraph content via rescue", () => {
  const root = makeRoot();
  const block = makeBlock(document, "p", "Hello", 0, 7);
  root.appendChild(block);
  root.appendChild(makeOrphan(document, "p", "world"));
  const out = runCommit({ root, sourceSnapshot: "Hello\n\n" });
  eq(out.rescuedOrphan, true, "should rescue");
  eq(out.newSource, "Hello\n\nworld\n\n", "newSource");
});

// Case 4: Multi-line paste at end of paragraph — Chrome typically inserts
// "foo" inline + creates a sibling for "bar". The first half lives inside
// the existing block's textContent, the second half is an orphan <p>.
test("multi-line paste keeps both halves via splice + rescue", () => {
  const root = makeRoot();
  const block = makeBlock(document, "p", "Hello", 0, 7);
  // Caret at end → first line of paste joined to existing block.
  block.textContent = "Hellofoo";
  root.appendChild(block);
  // Second line lands as orphan paragraph.
  root.appendChild(makeOrphan(document, "p", "bar"));
  const out = runCommit({ root, sourceSnapshot: "Hello\n\n" });
  eq(out.rescuedOrphan, true, "should rescue");
  eq(out.newSource, "Hellofoo\n\nbar\n\n", "newSource");
});

// Case 5: Paste 3 lines at end — TWO orphan paragraphs.
test("3-line paste creates 2 orphans, both rescued", () => {
  const root = makeRoot();
  const block = makeBlock(document, "p", "Hello", 0, 7);
  block.textContent = "Hellofoo";
  root.appendChild(block);
  root.appendChild(makeOrphan(document, "p", "bar"));
  root.appendChild(makeOrphan(document, "p", "baz"));
  const out = runCommit({ root, sourceSnapshot: "Hello\n\n" });
  eq(out.rescuedOrphan, true, "should rescue");
  eq(out.newSource, "Hellofoo\n\nbar\n\nbaz\n\n", "newSource");
});

// Case 6: Multiple known blocks + orphan inserted between them — the
// orphan rescue must walk in DOM order so the orphan content lands in the
// right position.
test("orphan between two known blocks lands at the right offset", () => {
  const root = makeRoot();
  const block1 = makeBlock(document, "p", "Hello", 0, 7);
  const block2 = makeBlock(document, "p", "World", 7, 14);
  root.appendChild(block1);
  // Orphan inserted between (e.g. user pressed Enter at end of block1
  // and typed "MID" — Chrome may render this as an orphan <p> sibling).
  root.appendChild(makeOrphan(document, "p", "MID"));
  root.appendChild(block2);
  const out = runCommit({ root, sourceSnapshot: "Hello\n\nWorld\n\n" });
  eq(out.rescuedOrphan, true, "should rescue");
  eq(out.newSource, "Hello\n\nMID\n\nWorld\n\n", "newSource");
});

// Case 7: Heading-tagged orphan keeps heading prefix.
test("orphan <h2> rescued with `## ` prefix", () => {
  const root = makeRoot();
  const block = makeBlock(document, "p", "Hello", 0, 7);
  root.appendChild(block);
  root.appendChild(makeOrphan(document, "h2", "New Heading"));
  const out = runCommit({ root, sourceSnapshot: "Hello\n\n" });
  eq(out.rescuedOrphan, true, "should rescue");
  eq(out.newSource, "Hello\n\n## New Heading\n\n", "newSource");
});

// Case 8: Entirely-empty doc with single placeholder — root fallback path,
// not orphan rescue. Verifies the placeholder isn't incorrectly classified.
test("empty doc with placeholder doesn't trigger rescue", () => {
  const root = makeRoot();
  const placeholder = document.createElement("p");
  placeholder.setAttribute("data-md-start", "0");
  placeholder.setAttribute("data-md-end", "0");
  placeholder.setAttribute("data-md-orig-text", "");
  placeholder.setAttribute("data-idea-empty-line", "");
  placeholder.appendChild(document.createElement("br"));
  // User typed "h" → placeholder block has textContent "h".
  placeholder.textContent = "h";
  root.appendChild(placeholder);
  const out = runCommit({ root, sourceSnapshot: "" });
  eq(out.rescuedOrphan, false, "should not rescue (known block)");
  eq(out.newSource, "h", "newSource");
});

// Case 9: Trailing-empty placeholder + user typed in main block.
test("trailing-empty placeholder doesn't get re-rescued as orphan", () => {
  const root = makeRoot();
  const block = makeBlock(document, "p", "Hello", 0, 7);
  block.textContent = "HelloX";
  root.appendChild(block);
  const trailing = document.createElement("p");
  trailing.setAttribute("data-md-start", "7");
  trailing.setAttribute("data-md-end", "7");
  trailing.setAttribute("data-md-orig-text", "");
  trailing.setAttribute("data-idea-empty-line", "");
  trailing.appendChild(document.createElement("br"));
  root.appendChild(trailing);
  const out = runCommit({ root, sourceSnapshot: "Hello\n\n" });
  eq(out.rescuedOrphan, false, "trailing placeholder is a known block");
  eq(out.newSource, "HelloX\n\n", "newSource");
});

// Case 10: Pure paste into empty doc.
test("paste into empty doc captures full text", () => {
  const root = makeRoot();
  // Empty doc placeholder absorbs first line; remaining lines become
  // orphans.
  const placeholder = document.createElement("p");
  placeholder.setAttribute("data-md-start", "0");
  placeholder.setAttribute("data-md-end", "0");
  placeholder.setAttribute("data-md-orig-text", "");
  placeholder.setAttribute("data-idea-empty-line", "");
  placeholder.textContent = "first";
  root.appendChild(placeholder);
  root.appendChild(makeOrphan(document, "p", "second"));
  root.appendChild(makeOrphan(document, "p", "third"));
  const out = runCommit({ root, sourceSnapshot: "" });
  eq(out.rescuedOrphan, true, "should rescue");
  eq(out.newSource, "first\n\nsecond\n\nthird\n\n", "newSource");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
