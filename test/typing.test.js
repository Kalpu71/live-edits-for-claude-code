const test = require("node:test");
const assert = require("node:assert");
const { lineOf, predictFinalText, changedRegion, typingPlan, deletionPlan, play } = require("../src/typing");

const apply = (cur, fin) => {
  const { start, end, insert } = changedRegion(cur, fin);
  return cur.slice(0, start) + insert + cur.slice(end);
};

test("predictFinalText applies Edit, replace_all, MultiEdit and Write", () => {
  assert.strictEqual(predictFinalText("a = 1\nb = 2\n", "Edit", { old_string: "b = 2", new_string: "b = 42" }), "a = 1\nb = 42\n");
  assert.strictEqual(predictFinalText("x x x", "Edit", { old_string: "x", new_string: "y", replace_all: true }), "y y y");
  assert.strictEqual(
    predictFinalText("abc", "MultiEdit", { edits: [{ old_string: "a", new_string: "A" }, { old_string: "c", new_string: "CC" }] }),
    "AbCC"
  );
  assert.strictEqual(predictFinalText("old", "Write", { content: "new" }), "new");
  assert.strictEqual(predictFinalText("$1 here", "Edit", { old_string: "here", new_string: "$& $1" }), "$1 $& $1");
});

test("predictFinalText matches LF edits against CRLF files", () => {
  assert.strictEqual(
    predictFinalText("l1\r\nl2\r\nl3\r\n", "Edit", { old_string: "l2\nl3", new_string: "L2\nl3\nl4" }),
    "l1\r\nL2\r\nl3\r\nl4\r\n"
  );
});

test("predictFinalText gives up when it can't predict", () => {
  assert.strictEqual(predictFinalText("hello", "Edit", { old_string: "missing", new_string: "z" }), null);
  assert.strictEqual(predictFinalText("hello", "NotebookEdit", {}), null);
  assert.strictEqual(predictFinalText("hello", "Edit", { old_string: "", new_string: "z" }), null);
});

test("changedRegion animates only the differing middle", () => {
  assert.deepStrictEqual(changedRegion("b = 2;\n", "b = 42;\n"), { start: 4, end: 4, insert: "4" });
  assert.deepStrictEqual(changedRegion("hello\n", "hello world\n"), { start: 5, end: 5, insert: " world" });
  assert.deepStrictEqual(changedRegion("same", "same"), { start: 4, end: 4, insert: "" });
});

test("changedRegion round-trips, including CRLF boundaries", () => {
  const pairs = [
    ["", "brand new file\n"],
    ["delete all of this\n", ""],
    ["a\r\nfunction f() {\r\n  return 1;\r\n}\r\n", "a\r\nfunction f(x) {\r\n  if (x) {\r\n    return 2;\r\n  }\r\n  return 1;\r\n}\r\n"],
    ["x\r\ny\r\n", "x\r\n\r\ny\r\n"],
    ["aaaa", "aa"],
  ];
  for (const [cur, fin] of pairs) {
    assert.strictEqual(apply(cur, fin), fin);
    const { start, end } = changedRegion(cur, fin);
    assert.ok(!(cur[start - 1] === "\r" && cur[start] === "\n"), "start splits CRLF");
    assert.ok(!(cur[end - 1] === "\r" && cur[end] === "\n"), "end splits CRLF");
  }
});

test("typingPlan reproduces the text and brings indentation with the newline", () => {
  const text = "if (x) {\n    return 2;\n}\n";
  const steps = typingPlan(text, 70, () => 0.5);
  assert.strictEqual(steps.map((s) => s.text).join(""), text);
  assert.ok(steps.some((s) => s.text === "\n    "));
  const letter = steps.find((s) => s.text === "r").delay;
  const lineEnd = steps.find((s) => s.text === "\n    ").delay;
  const semicolon = steps.find((s) => s.text === ";").delay;
  assert.ok(lineEnd > semicolon && semicolon > letter);
});

test("deletionPlan backspaces letters, or whole lines for long removals", () => {
  const short = deletionPlan("ab\r\ncd", 60, () => 0.5);
  assert.deepStrictEqual(short.map((s) => s.size), [1, 1, 2, 1, 1]);
  const long = "x".repeat(50) + "\n" + "y".repeat(200) + "\n";
  const lines = deletionPlan(long, 60, () => 0.5);
  assert.deepStrictEqual(lines.map((s) => s.size), [201, 51]);
});

test("play keeps real-time delays but caps the total", async () => {
  let clock = 0;
  const sleep = async (ms) => {
    clock += ms;
  };
  let out = "";
  const steps = typingPlan("hello world", 70, () => 0.5);
  await play(steps, 60_000, async (b) => (out += b.map((s) => s.text).join("")), sleep);
  assert.strictEqual(out, "hello world");
  assert.ok(clock > 11 * 60, `took ${clock}ms`);

  clock = 0;
  out = "";
  const big = "z".repeat(5000);
  await play(typingPlan(big, 70), 2000, async (b) => (out += b.map((s) => s.text).join("")), sleep);
  assert.strictEqual(out, big);
  assert.ok(Math.abs(clock - 2000) < 5, `took ${clock}ms`);
});

test("play applies everything left at once when rushed", async () => {
  let out = "";
  let batches = 0;
  const steps = typingPlan("skip the rest of this", 70, () => 0.5);
  await play(
    steps,
    60_000,
    async (b) => {
      batches++;
      out += b.map((s) => s.text).join("");
    },
    async () => {},
    () => out.length >= 4
  );
  assert.strictEqual(out, "skip the rest of this");
  assert.strictEqual(batches, 5, "4 letters one by one, then the rest in one batch");
});

test("lineOf finds the 1-based line", () => {
  assert.strictEqual(lineOf("a\nb\nc", "c"), 3);
  assert.strictEqual(lineOf("a\nb", "zz"), 1);
});
