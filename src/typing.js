// @ts-check
// Pure text logic: predicting a file after Claude's edit, finding the span that
// changes, and planning human-like keystrokes. No VS Code APIs, so it is unit-tested
// with plain Node.

/** 1-based line where `needle` starts in `text`, or 1 when it isn't found. */
function lineOf(text, needle) {
  if (!needle) return 1;
  const idx = text.indexOf(needle);
  return idx >= 0 ? text.slice(0, idx).split("\n").length : 1;
}

/**
 * The file's content once Claude's tool has run, or null when it can't be predicted
 * (unknown tool, or an old_string that isn't in the file).
 * @param {string} content current file content
 * @param {string} toolName "Edit" | "MultiEdit" | "Write"
 * @param {any} toolInput the tool's input as sent to the hook
 * @returns {string | null}
 */
function predictFinalText(content, toolName, toolInput) {
  if (toolName === "Write") return typeof toolInput.content === "string" ? toolInput.content : null;
  if (toolName !== "Edit" && toolName !== "MultiEdit") return null;
  let out = content;
  for (const e of toolInput.edits || [toolInput]) {
    let o = e.old_string;
    let n = e.new_string;
    if (typeof o !== "string" || typeof n !== "string" || !o) return null;
    if (!out.includes(o) && out.includes("\r\n")) {
      o = o.replace(/\r?\n/g, "\r\n");
      n = n.replace(/\r?\n/g, "\r\n");
    }
    if (!out.includes(o)) return null;
    out = e.replace_all ? out.split(o).join(n) : out.replace(o, () => n);
  }
  return out;
}

/**
 * The one span that differs between `cur` and `fin`, never splitting a CRLF.
 * Replacing cur[start, end) with `insert` turns `cur` into `fin`.
 * @returns {{ start: number, end: number, insert: string }}
 */
function changedRegion(cur, fin) {
  const max = Math.min(cur.length, fin.length);
  let start = 0;
  while (start < max && cur[start] === fin[start]) start++;
  if (start > 0 && cur[start - 1] === "\r") start--;
  let same = 0;
  while (same < max - start && cur[cur.length - 1 - same] === fin[fin.length - 1 - same]) same++;
  if (same > 0 && cur[cur.length - same] === "\n" && cur[cur.length - same - 1] === "\r") same--;
  return { start, end: cur.length - same, insert: fin.slice(start, fin.length - same) };
}

/** @typedef {{ size: number, text?: string, delay: number }} Keystroke */

const jitter = (ms, spread, random) => ms * (1 - spread + random() * 2 * spread);

/**
 * Keystrokes for typing `text` like a person: uneven rhythm, a beat after
 * punctuation, a longer one at line ends; indentation arrives at once like auto-indent.
 * @returns {Keystroke[]}
 */
function typingPlan(text, msPerChar, random = Math.random) {
  /** @type {Keystroke[]} */
  const steps = [];
  for (let i = 0; i < text.length; ) {
    let chunk = text[i] === "\r" && text[i + 1] === "\n" ? "\r\n" : text[i];
    i += chunk.length;
    if (chunk.endsWith("\n")) {
      let j = i;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
      chunk += text.slice(i, j);
      i = j;
    }
    let delay = jitter(msPerChar, 0.4, random);
    if (/[.,;:!?)}\]>]$/.test(chunk)) delay += msPerChar * 2;
    if (chunk.includes("\n")) delay += msPerChar * 4;
    steps.push({ size: chunk.length, text: chunk, delay });
  }
  return steps;
}

/**
 * Keystrokes for deleting `text` from its end: backspace letter by letter, or line
 * by line when the removal is longer than `lineModeAbove` characters.
 * @returns {Keystroke[]}
 */
function deletionPlan(text, msPerChar, random = Math.random, lineModeAbove = 200) {
  /** @type {Keystroke[]} */
  const steps = [];
  if (text.length <= lineModeAbove) {
    for (let i = text.length; i > 0; ) {
      const n = i >= 2 && text[i - 2] === "\r" && text[i - 1] === "\n" ? 2 : 1;
      steps.push({ size: n, delay: jitter(msPerChar, 0.3, random) });
      i -= n;
    }
  } else {
    const lines = text.split(/(?<=\n)/);
    for (let k = lines.length - 1; k >= 0; k--) steps.push({ size: lines[k].length, delay: msPerChar * 5 });
  }
  return steps;
}

/**
 * Plays keystrokes in real time. If the total would pass `maxMs`, everything speeds
 * up evenly; keystrokes closer together than one frame are applied as one batch.
 * Once `rush()` returns true, all remaining keystrokes are applied at once.
 * @param {Keystroke[]} steps
 * @param {number} maxMs
 * @param {(batch: Keystroke[]) => Promise<void>} apply
 * @param {(ms: number) => Promise<void>} sleep
 * @param {() => boolean} [rush]
 */
async function play(steps, maxMs, apply, sleep, rush = () => false, frameMs = 16) {
  const total = steps.reduce((t, s) => t + s.delay, 0);
  const scale = total > maxMs ? maxMs / total : 1;
  let batch = [];
  let wait = 0;
  for (let k = 0; k < steps.length; k++) {
    if (rush()) {
      batch.push(...steps.slice(k));
      await apply(batch);
      return;
    }
    batch.push(steps[k]);
    wait += steps[k].delay * scale;
    if (wait >= frameMs || k === steps.length - 1) {
      await apply(batch);
      await sleep(wait);
      batch = [];
      wait = 0;
    }
  }
}

module.exports = { lineOf, predictFinalText, changedRegion, typingPlan, deletionPlan, play };
