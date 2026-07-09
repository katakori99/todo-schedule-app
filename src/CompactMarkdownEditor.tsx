import { BubbleMenu } from "@tiptap/react/menus";
import { EditorContent, useEditor } from "@tiptap/react";
import { Bold, Check, Code, Italic, Strikethrough, X } from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  discardCompactMarkdownDraft,
  readCompactMarkdownDraft,
  storeCompactMarkdownDraft,
} from "./compactDraftStorage";
import {
  createNoteEditorExtensions,
  migrateCompletedNoteMath,
  NoteMathTarget,
} from "./noteEditorConfig";

type FocusPoint = {
  x: number;
  y: number;
};

type CompactMarkdownEditorProps = {
  ariaLabel: string;
  className: string;
  draftStorageKey: string;
  focusPoint?: FocusPoint;
  initialMarkdown: string;
  onSave: (markdown: string) => boolean | Promise<boolean>;
};

export default function CompactMarkdownEditor({
  ariaLabel,
  className,
  draftStorageKey,
  focusPoint,
  initialMarkdown,
  onSave,
}: CompactMarkdownEditorProps) {
  const initialContentRef = useRef(
    readCompactMarkdownDraft(draftStorageKey, initialMarkdown),
  );
  const onSaveRef = useRef(onSave);
  const lastSavedRef = useRef(initialMarkdown);
  const revisionRef = useRef(0);
  const requestRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [saveState, setSaveState] = useState<"error" | "idle" | "saving">("idle");
  const [mathTarget, setMathTarget] = useState<NoteMathTarget | null>(null);
  const [mathLatex, setMathLatex] = useState("");

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const persist = async (markdown: string, revision: number) => {
    const normalized = markdown.trim();
    if (!normalized) {
      if (mountedRef.current && revision === revisionRef.current) {
        setSaveState("error");
      }
      return;
    }

    if (normalized === lastSavedRef.current) {
      discardCompactMarkdownDraft(draftStorageKey);
      if (mountedRef.current) {
        setSaveState("idle");
      }
      return;
    }

    const request = requestRef.current + 1;
    requestRef.current = request;
    if (mountedRef.current) {
      setSaveState("saving");
    }

    const didSave = await onSaveRef.current(normalized);
    if (
      !mountedRef.current ||
      request !== requestRef.current ||
      revision !== revisionRef.current
    ) {
      return;
    }

    if (!didSave) {
      setSaveState("error");
      return;
    }

    lastSavedRef.current = normalized;
    discardCompactMarkdownDraft(draftStorageKey);
    setSaveState("idle");
  };

  const scheduleSave = (markdown: string, revision: number) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persist(markdown, revision);
    }, 500);
  };

  const editor = useEditor({
    content: initialContentRef.current,
    contentType: "markdown",
    extensions: createNoteEditorExtensions({
      onMathClick: (target) => {
        setMathTarget(target);
        setMathLatex(target.latex);
      },
      placeholder: "内容を入力",
    }),
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        class: "compact-markdown-content markdown-content",
        spellcheck: "true",
      },
    },
    immediatelyRender: false,
    onBlur: ({ editor: currentEditor }) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void persist(currentEditor.getMarkdown(), revisionRef.current);
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (migrateCompletedNoteMath(currentEditor)) {
        return;
      }

      const markdown = currentEditor.getMarkdown();
      revisionRef.current += 1;
      storeCompactMarkdownDraft(draftStorageKey, markdown);
      setSaveState("idle");
      scheduleSave(markdown, revisionRef.current);
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (focusPoint) {
        const position = editor.view.posAtCoords({
          left: focusPoint.x,
          top: focusPoint.y,
        });
        if (position) {
          editor.commands.setTextSelection(position.pos);
        }
      }
      editor.commands.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [editor, focusPoint]);

  useEffect(() => {
    if (initialMarkdown === editor?.getMarkdown()) {
      lastSavedRef.current = initialMarkdown;
    }
  }, [editor, initialMarkdown]);

  if (!editor) {
    return <div className={`${className} compact-markdown-editor`} aria-label={ariaLabel} />;
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
    <div
      className={[
        className,
        "compact-markdown-editor",
        saveState === "saving" ? "is-saving" : "",
        saveState === "error" ? "has-save-error" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={saveState === "error" ? "保存できませんでした。内容はこの端末に保持されています" : undefined}
    >
      <BubbleMenu
        editor={editor}
        pluginKey={`compactTextMenu-${draftStorageKey}`}
        updateDelay={100}
        options={{
          flip: true,
          offset: 7,
          placement: "bottom",
          shift: {
            padding: 8,
          },
        }}
        shouldShow={({ editor: currentEditor, from, to }) =>
          currentEditor.isEditable && from !== to && !currentEditor.isActive("codeBlock")
        }
        className="compact-bubble-menu"
      >
        <button
          type="button"
          className={editor.isActive("bold") ? "is-active" : ""}
          aria-label="太字"
          title="太字"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={15} />
        </button>
        <button
          type="button"
          className={editor.isActive("italic") ? "is-active" : ""}
          aria-label="斜体"
          title="斜体"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={15} />
        </button>
        <button
          type="button"
          className={editor.isActive("strike") ? "is-active" : ""}
          aria-label="取り消し線"
          title="取り消し線"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={15} />
        </button>
        <button
          type="button"
          className={editor.isActive("code") ? "is-active" : ""}
          aria-label="インラインコード"
          title="インラインコード"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code size={15} />
        </button>
      </BubbleMenu>

      {mathTarget && (
        <div className="compact-math-editor">
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
            <Check size={16} />
          </button>
          <button
            type="button"
            aria-label="数式編集を閉じる"
            title="閉じる"
            onClick={closeMathEditor}
          >
            <X size={16} />
          </button>
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}
