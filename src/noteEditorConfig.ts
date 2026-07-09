import { InputRule } from "@tiptap/core";
import type { AnyExtension, Editor } from "@tiptap/core";
import {
  BlockMath,
  createMathMigrateTransaction,
  InlineMath,
} from "@tiptap/extension-mathematics";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

export type NoteMathTarget = {
  latex: string;
  pos: number;
  type: "block" | "inline";
};

type CreateNoteEditorExtensionsOptions = {
  onMathClick?: (target: NoteMathTarget) => void;
  placeholder?: string;
};

const INLINE_MATH_PATTERN = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;

const NoteInlineMath = InlineMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /(?<!\$)(\$([^$\n]+?)\$)(?!\$)$/,
        handler: ({ state, range, match }) => {
          const latex = match[2]?.trim();
          if (!latex) {
            return;
          }

          state.tr.replaceWith(range.from, range.to, this.type.create({ latex }));
        },
      }),
    ];
  },
});

const NoteBlockMath = BlockMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]?.trim();
          if (!latex) {
            return;
          }

          const $from = state.doc.resolve(range.from);
          const node = this.type.create({ latex });
          const consumesHostTextblock =
            $from.depth > 0 &&
            $from.parent.isTextblock &&
            range.from === $from.start() &&
            range.to === $from.end();
          const canReplaceHostTextblock =
            consumesHostTextblock &&
            $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type);
          const replacementRange = canReplaceHostTextblock
            ? { from: $from.before(), to: $from.after() }
            : range;

          state.tr.replaceWith(replacementRange.from, replacementRange.to, node);
        },
      }),
    ];
  },
});

export function createNoteEditorExtensions({
  onMathClick,
  placeholder = "ここにメモを書く",
}: CreateNoteEditorExtensionsOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      link: {
        HTMLAttributes: {
          rel: "noopener noreferrer",
          target: "_blank",
        },
        openOnClick: false,
      },
    }),
    Markdown,
    NoteInlineMath.configure({
      katexOptions: {
        strict: "warn",
        throwOnError: false,
      },
      onClick: (node, pos) => {
        onMathClick?.({
          latex: String(node.attrs.latex ?? ""),
          pos,
          type: "inline",
        });
      },
    }),
    NoteBlockMath.configure({
      katexOptions: {
        strict: "warn",
        throwOnError: false,
      },
      onClick: (node, pos) => {
        onMathClick?.({
          latex: String(node.attrs.latex ?? ""),
          pos,
          type: "block",
        });
      },
    }),
    Placeholder.configure({
      placeholder,
    }),
  ];
}

export function migrateCompletedNoteMath(editor: Editor) {
  const transaction = createMathMigrateTransaction(
    editor,
    editor.state.tr,
    INLINE_MATH_PATTERN,
  );
  const blockMath = editor.schema.nodes.blockMath;
  const blockCandidates: Array<{ from: number; latex: string; to: number }> = [];

  transaction.doc.forEach((node, offset, index) => {
    if (node.type.name !== "paragraph") {
      return;
    }

    const match = node.textContent.match(/^\$\$([^$]+)\$\$$/);
    if (!match?.[1]?.trim()) {
      return;
    }

    if (!transaction.doc.canReplaceWith(index, index + 1, blockMath)) {
      return;
    }

    blockCandidates.push({
      from: offset,
      latex: match[1].trim(),
      to: offset + node.nodeSize,
    });
  });

  for (const candidate of blockCandidates.reverse()) {
    transaction.replaceWith(
      candidate.from,
      candidate.to,
      blockMath.create({ latex: candidate.latex }),
    );
  }

  if (!transaction.docChanged) {
    return false;
  }

  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
  return true;
}
