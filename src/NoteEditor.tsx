import { BubbleMenu } from "@tiptap/react/menus";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  Bold,
  Check,
  Code,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  X,
} from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  createNoteEditorExtensions,
  migrateCompletedNoteMath,
  NoteMathTarget,
} from "./noteEditorConfig";

type NoteEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
};

type ToolbarButtonProps = {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
};

function ToolbarButton({
  active = false,
  children,
  disabled = false,
  label,
  onClick,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={active ? "is-active" : ""}
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function NoteEditor({ markdown, onChange }: NoteEditorProps) {
  const onChangeRef = useRef(onChange);
  const [mathTarget, setMathTarget] = useState<NoteMathTarget | null>(null);
  const [mathLatex, setMathLatex] = useState("");

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const editor = useEditor({
    content: markdown || "",
    contentType: "markdown",
    extensions: createNoteEditorExtensions({
      onMathClick: (target) => {
        setMathTarget(target);
        setMathLatex(target.latex);
      },
    }),
    editorProps: {
      attributes: {
        "aria-label": "Note本文",
        class: "note-rich-content markdown-content",
        spellcheck: "true",
      },
    },
    immediatelyRender: false,
    onUpdate: ({ editor: currentEditor }) => {
      if (migrateCompletedNoteMath(currentEditor)) {
        return;
      }

      onChangeRef.current(currentEditor.getMarkdown());
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed || editor.isFocused) {
      return;
    }

    const currentMarkdown = editor.getMarkdown();
    if (currentMarkdown !== markdown) {
      editor.commands.setContent(markdown || "", {
        contentType: "markdown",
        emitUpdate: false,
      });
    }
  }, [editor, markdown]);

  if (!editor) {
    return <div className="note-rich-editor is-loading" aria-label="Note本文" />;
  }

  const closeMathEditor = () => {
    setMathTarget(null);
    setMathLatex("");
    editor.commands.focus();
  };

  const saveMath = () => {
    if (!mathTarget || !mathLatex.trim()) {
      return;
    }

    const didUpdate =
      mathTarget.type === "inline"
        ? editor.commands.updateInlineMath({
            latex: mathLatex.trim(),
            pos: mathTarget.pos,
          })
        : editor.commands.updateBlockMath({
            latex: mathLatex.trim(),
            pos: mathTarget.pos,
          });

    if (didUpdate) {
      closeMathEditor();
    }
  };

  const handleMathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      saveMath();
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMathEditor();
    }
  };

  return (
    <section className="note-rich-editor">
      <BubbleMenu
        editor={editor}
        pluginKey="noteTextMenu"
        updateDelay={100}
        options={{
          flip: true,
          offset: 8,
          placement: "bottom",
          shift: {
            padding: 8,
          },
        }}
        shouldShow={({ editor: currentEditor, from, to }) =>
          currentEditor.isEditable && from !== to && !currentEditor.isActive("codeBlock")
        }
        className="note-bubble-menu"
      >
        <ToolbarButton
          active={editor.isActive("bold")}
          label="太字"
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={16} />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          label="斜体"
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={16} />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("strike")}
          label="取り消し線"
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={16} />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("code")}
          label="インラインコード"
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code size={16} />
        </ToolbarButton>
        <span className="note-bubble-divider" />
        <ToolbarButton
          active={editor.isActive("heading", { level: 2 })}
          label="見出し"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 size={16} />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("bulletList")}
          label="箇条書き"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={16} />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("orderedList")}
          label="番号付きリスト"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={16} />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("blockquote")}
          label="引用"
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={16} />
        </ToolbarButton>
      </BubbleMenu>

      {mathTarget && (
        <div className="note-math-editor">
          <input
            autoFocus
            aria-label="数式を編集"
            value={mathLatex}
            onChange={(event) => setMathLatex(event.target.value)}
            onKeyDown={handleMathKeyDown}
          />
          <button
            type="button"
            aria-label="数式を保存"
            title="数式を保存"
            disabled={!mathLatex.trim()}
            onClick={saveMath}
          >
            <Check size={17} />
          </button>
          <button
            type="button"
            aria-label="数式編集を閉じる"
            title="閉じる"
            onClick={closeMathEditor}
          >
            <X size={17} />
          </button>
        </div>
      )}

      <EditorContent editor={editor} />
    </section>
  );
}
