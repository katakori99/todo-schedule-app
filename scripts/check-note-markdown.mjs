import assert from "node:assert/strict";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

const manager = new MarkdownManager({
  extensions: [StarterKit, InlineMath, BlockMath],
});

const fixtures = [
  {
    name: "formatting",
    source: [
      "# 見出し",
      "",
      "通常の文章",
      "",
      "**太字** と *斜体* と ~~取り消し線~~",
      "",
      "- 箇条書き",
      "- 2行目",
      "",
      "> 引用",
      "",
      "`inline code`",
    ].join("\n"),
  },
  {
    name: "math",
    source: [
      "本論文における主張において $m^2$",
      "",
      "$$",
      "\\int_0^1 x^2\\,dx",
      "$$",
    ].join("\n"),
  },
  {
    name: "unsafe html is text",
    source: "<script>alert(1)</script>",
  },
];

for (const fixture of fixtures) {
  const parsed = manager.parse(fixture.source);
  const serialized = manager.serialize(parsed);
  const reparsed = manager.parse(serialized);

  assert.deepEqual(reparsed, parsed, `${fixture.name}: parse/serialize round trip changed content`);
}

const mathDocument = manager.parse(fixtures[1].source);
assert.equal(mathDocument.content?.[0]?.content?.[1]?.type, "inlineMath");
assert.equal(mathDocument.content?.[0]?.content?.[1]?.attrs?.latex, "m^2");
assert.equal(mathDocument.content?.[1]?.type, "blockMath");
assert.equal(mathDocument.content?.[1]?.attrs?.latex, "\\int_0^1 x^2\\,dx");

console.log(`Note Markdown round-trip checks passed (${fixtures.length} fixtures).`);
