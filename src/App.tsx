import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
import {
  Bold,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  GripVertical,
  ListChecks,
  LogOut,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import NoteEditor from "./NoteEditor";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase, supabaseConfigError } from "./lib/supabase";

type Mode = "todo" | "schedule" | "note";
type Duration = 1 | 2 | 3;

type Task = {
  id: string;
  markdown: string;
  html: string;
  done: boolean;
  createdAt: number;
};

type ScheduleItem = {
  id: string;
  date: string;
  startHour: number;
  duration: Duration;
  markdown: string;
  titleHtml: string;
  createdAt: number;
  updatedAt: number;
};

type NoteSaveStatus = "idle" | "saving" | "saved" | "error";
type StoredNoteDraft = {
  baseMarkdown: string;
  markdown: string;
  updatedAt: number;
};

type ViewState = {
  mode: Mode;
  selectedDate: string;
  selectedHour: number;
  duration: Duration;
};

type ScheduleError = {
  date: string;
  startHour: number;
  duration: Duration;
  message: string;
  key: number;
};

type AppStatus =
  | "checking-auth"
  | "signed-out"
  | "password-recovery"
  | "loading-data"
  | "ready"
  | "error";
type AuthMode = "sign-in" | "sign-up";

type TodoRow = {
  id: string;
  user_id: string;
  content_html: string;
  done: boolean;
  order_index: number;
  created_at: string;
  updated_at: string;
};

type ScheduleRow = {
  id: string;
  user_id: string;
  date: string;
  title_html: string;
  start_hour: number;
  duration_hours: Duration;
  order_index: number;
  created_at: string;
  updated_at: string;
};

type NoteRow = {
  id: string;
  user_id: string;
  content_markdown: string;
  created_at: string;
  updated_at: string;
};

const VIEW_STORAGE_KEY = "cafe-todo.view.v1";
const NOTE_DRAFT_STORAGE_PREFIX = "todo-schedule.note-draft.v1";
const NOTE_BACKUP_STORAGE_PREFIX = "todo-schedule.note-backup.v1";
const DEFAULT_LOGIN_EMAIL = "nameki.seito@gmail.com";
const USE_LEGACY_NOTE_EDITOR =
  new URLSearchParams(window.location.search).get("note_editor") === "legacy";
const IME_SUBMIT_GUARD_MS = 120;
const START_HOUR = 6;
const END_HOUR = 24;
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, index) => START_HOUR + index);
const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: true,
});

function renderMath(source: string, displayMode: boolean) {
  return katex.renderToString(source, {
    displayMode,
    throwOnError: false,
    trust: false,
    strict: "warn",
    maxExpand: 1000,
    maxSize: 10,
  });
}

function mathInlineRule(state: StateInline, silent: boolean) {
  const marker = state.src[state.pos];

  if (marker !== "$") {
    return false;
  }

  if (state.src[state.pos + 1] === "$") {
    return false;
  }

  let match = state.pos + 1;

  while ((match = state.src.indexOf("$", match)) !== -1) {
    if (state.src[match - 1] !== "\\") {
      break;
    }
    match += 1;
  }

  if (match === -1) {
    return false;
  }

  const content = state.src.slice(state.pos + 1, match);
  if (!content.trim()) {
    return false;
  }

  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.content = content;
    token.markup = "$";
  }

  state.pos = match + 1;
  return true;
}

function mathBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const firstLine = state.src.slice(start, max).trim();

  if (!firstLine.startsWith("$$")) {
    return false;
  }

  let content = firstLine.slice(2);

  if (content.endsWith("$$") && content.length > 2) {
    content = content.slice(0, -2);
    if (!silent) {
      const token = state.push("math_block", "section", 0);
      token.block = true;
      token.content = content.trim();
      token.markup = "$$";
      token.map = [startLine, startLine + 1];
    }
    state.line = startLine + 1;
    return true;
  }

  const lines: string[] = [];
  if (content.trim()) {
    lines.push(content);
  }

  let nextLine = startLine + 1;
  for (; nextLine < endLine; nextLine += 1) {
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineMax = state.eMarks[nextLine];
    const line = state.src.slice(lineStart, lineMax);
    const endIndex = line.indexOf("$$");

    if (endIndex >= 0) {
      lines.push(line.slice(0, endIndex));
      break;
    }

    lines.push(line);
  }

  if (nextLine >= endLine) {
    return false;
  }

  if (!silent) {
    const token = state.push("math_block", "section", 0);
    token.block = true;
    token.content = lines.join("\n").trim();
    token.markup = "$$";
    token.map = [startLine, nextLine + 1];
  }

  state.line = nextLine + 1;
  return true;
}

markdownRenderer.disable("image");
markdownRenderer.inline.ruler.after("escape", "math_inline", mathInlineRule);
markdownRenderer.block.ruler.after("blockquote", "math_block", mathBlockRule, {
  alt: ["paragraph", "reference", "blockquote", "list"],
});

markdownRenderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, index, options);
};

markdownRenderer.renderer.rules.math_inline = (tokens, index) => renderMath(tokens[index].content, false);
markdownRenderer.renderer.rules.math_block = (tokens, index) => renderMath(tokens[index].content, true);

const defaultViewState = (): ViewState => ({
  mode: "todo",
  selectedDate: formatDate(new Date()),
  selectedHour: START_HOUR,
  duration: 1,
});

function stripTrailingBreaks(value: string) {
  return value
    .replace(/(\s|&nbsp;)+$/g, "")
    .replace(/(<br\s*\/?>\s*)+$/gi, "")
    .replace(/^(\s|&nbsp;|<br\s*\/?>)+/gi, "");
}

function sanitizeHtml(input: string) {
  const template = document.createElement("template");
  template.innerHTML = input;

  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      const span = document.createElement("span");
      span.textContent = text.replace(/\u00a0/g, " ");
      return span.innerHTML;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    const children = Array.from(element.childNodes).map(walk).join("");
    const fontWeight = element.style.fontWeight;
    const isBold =
      tag === "b" ||
      tag === "strong" ||
      fontWeight === "bold" ||
      Number.parseInt(fontWeight, 10) >= 600;

    if (tag === "br") {
      return "<br>";
    }

    if (isBold) {
      return `<strong>${children}</strong>`;
    }

    if (tag === "div" || tag === "p") {
      return `${children}<br>`;
    }

    return children;
  };

  return stripTrailingBreaks(Array.from(template.content.childNodes).map(walk).join(""));
}

function textFromHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html.replace(/<br\s*\/?>/gi, "\n");
  return (template.content.textContent ?? "").replace(/\u00a0/g, " ").trim();
}

function looksLikeHtml(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function markdownFromStoredValue(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return looksLikeHtml(normalized) ? textFromHtml(sanitizeHtml(normalized)) : normalized;
}

function renderMarkdown(markdown: string) {
  const rendered = markdownRenderer.render(markdown);

  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS: [
      "a",
      "annotation",
      "blockquote",
      "br",
      "code",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "li",
      "math",
      "mfrac",
      "mi",
      "mn",
      "mo",
      "mover",
      "mpadded",
      "mrow",
      "mspace",
      "msqrt",
      "mstyle",
      "msub",
      "msubsup",
      "msup",
      "mtable",
      "mtd",
      "mtext",
      "mtr",
      "munder",
      "munderover",
      "ol",
      "p",
      "pre",
      "s",
      "semantics",
      "span",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    ALLOWED_ATTR: [
      "aria-hidden",
      "class",
      "encoding",
      "href",
      "rel",
      "style",
      "target",
      "title",
      "xmlns",
    ],
    ALLOW_DATA_ATTR: false,
  });
}

function textFromMarkdown(markdown: string) {
  return textFromHtml(renderMarkdown(markdown));
}

function safeReadJson<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function loadViewState(): ViewState {
  const fallback = defaultViewState();
  const parsed = safeReadJson<Partial<ViewState>>(VIEW_STORAGE_KEY, fallback);
  const mode: Mode =
    parsed.mode === "schedule" || parsed.mode === "note" ? parsed.mode : "todo";

  return {
    mode,
    selectedDate: typeof parsed.selectedDate === "string" ? parsed.selectedDate : fallback.selectedDate,
    selectedHour: clampHour(parsed.selectedHour ?? START_HOUR),
    duration: isDuration(parsed.duration) ? parsed.duration : 1,
  };
}

function isDuration(value: unknown): value is Duration {
  return value === 1 || value === 2 || value === 3;
}

function clampHour(hour: number) {
  return Math.min(Math.max(Math.trunc(hour), START_HOUR), END_HOUR - 1);
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function addDays(value: string, amount: number) {
  const date = parseDate(value);
  date.setDate(date.getDate() + amount);
  return formatDate(date);
}

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatRange(startHour: number, duration: Duration) {
  return `${formatHour(startHour)}-${formatHour(startHour + duration)}`;
}

function formatDayLabel(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(parseDate(value));
}

function isToday(value: string) {
  return value === formatDate(new Date());
}

function getCurrentScheduleSlot() {
  const now = new Date();
  const hour = now.getHours();

  return {
    date: formatDate(now),
    hour: hour >= START_HOUR && hour < END_HOUR ? hour : null,
  };
}

function rangesOverlap(startA: number, durationA: number, startB: number, durationB: number) {
  return startA < startB + durationB && startA + durationA > startB;
}

function hasScheduleConflict(
  items: ScheduleItem[],
  date: string,
  startHour: number,
  duration: Duration,
) {
  if (startHour + duration > END_HOUR) {
    return true;
  }

  return items.some(
    (item) =>
      item.date === date && rangesOverlap(startHour, duration, item.startHour, item.duration),
  );
}

function isHourCovered(item: ScheduleItem, hour: number) {
  return hour >= item.startHour && hour < item.startHour + item.duration;
}

function findNextAvailableHour(
  items: ScheduleItem[],
  date: string,
  fromHour: number,
  duration: Duration,
) {
  const normalizedStart = Math.min(Math.max(fromHour, START_HOUR), END_HOUR - 1);
  const candidates = [
    ...HOURS.filter((hour) => hour >= normalizedStart),
    ...HOURS.filter((hour) => hour < normalizedStart),
  ];

  return candidates.find((hour) => !hasScheduleConflict(items, date, hour, duration)) ?? START_HOUR;
}

function taskFromRow(row: TodoRow): Task {
  const markdown = markdownFromStoredValue(row.content_html);

  return {
    id: row.id,
    markdown,
    html: renderMarkdown(markdown),
    done: row.done,
    createdAt: Date.parse(row.created_at) || Date.now(),
  };
}

function scheduleItemFromRow(row: ScheduleRow): ScheduleItem {
  const duration = isDuration(row.duration_hours) ? row.duration_hours : 1;
  const markdown = markdownFromStoredValue(row.title_html);

  return {
    id: row.id,
    date: row.date,
    startHour: clampHour(row.start_hour),
    duration,
    markdown,
    titleHtml: renderMarkdown(markdown),
    createdAt: Date.parse(row.created_at) || Date.now(),
    updatedAt: Date.parse(row.updated_at) || Date.now(),
  };
}

function noteMarkdownFromRow(row: NoteRow | null | undefined) {
  return row ? row.content_markdown.replace(/\r\n?/g, "\n") : "";
}

function noteStorageKey(prefix: string, userId: string) {
  return `${prefix}.${userId}`;
}

function readStoredNoteDraft(userId: string): StoredNoteDraft | null {
  try {
    const value = window.localStorage.getItem(noteStorageKey(NOTE_DRAFT_STORAGE_PREFIX, userId));
    if (!value) {
      return null;
    }

    const parsed = JSON.parse(value) as Partial<StoredNoteDraft>;
    if (
      typeof parsed.markdown !== "string" ||
      typeof parsed.baseMarkdown !== "string" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }

    return {
      baseMarkdown: parsed.baseMarkdown,
      markdown: parsed.markdown,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function storeNoteDraft(userId: string, draft: StoredNoteDraft) {
  try {
    window.localStorage.setItem(
      noteStorageKey(NOTE_DRAFT_STORAGE_PREFIX, userId),
      JSON.stringify(draft),
    );
  } catch {
    // Cloud saving remains available when local storage is unavailable.
  }
}

function clearStoredNoteDraft(userId: string) {
  try {
    window.localStorage.removeItem(noteStorageKey(NOTE_DRAFT_STORAGE_PREFIX, userId));
  } catch {
    // Nothing else is required if local storage is unavailable.
  }
}

function storeInitialNoteBackup(userId: string, markdown: string) {
  try {
    const key = noteStorageKey(NOTE_BACKUP_STORAGE_PREFIX, userId);
    if (!window.localStorage.getItem(key)) {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          markdown,
          createdAt: Date.now(),
        }),
      );
    }
  } catch {
    // The backup is supplementary; it must not block editing.
  }
}

function getErrorMessage(error: unknown, fallback = "処理に失敗しました") {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      return message;
    }
  }

  return fallback;
}

function readAuthRedirectError() {
  const rawParams = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.search.startsWith("?")
      ? window.location.search.slice(1)
      : "";

  if (!rawParams) {
    return undefined;
  }

  const params = new URLSearchParams(rawParams);
  const error = params.get("error");
  const errorCode = params.get("error_code");
  const description = params.get("error_description");

  if (!error && !errorCode && !description) {
    return undefined;
  }

  const normalized = `${error ?? ""} ${errorCode ?? ""} ${description ?? ""}`.toLowerCase();

  if (
    normalized.includes("otp_expired") ||
    normalized.includes("expired") ||
    normalized.includes("invalid")
  ) {
    return "認証リンクが期限切れ、または既に使用済みです。必要ならパスワード再設定をもう一度行ってください。";
  }

  return `ログインできませんでした: ${description || errorCode || error}`;
}

function clearAuthRedirectErrorFromUrl() {
  const rawParams = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.search.startsWith("?")
      ? window.location.search.slice(1)
      : "";

  if (!rawParams) {
    return;
  }

  const params = new URLSearchParams(rawParams);
  if (!params.has("error") && !params.has("error_code") && !params.has("error_description")) {
    return;
  }

  window.history.replaceState(null, "", window.location.pathname);
}

function isPasswordRecoveryUrl() {
  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get("auth_flow") === "password-recovery") {
    return true;
  }

  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (!hash) {
    return false;
  }

  const hashParams = new URLSearchParams(hash);
  return (
    hashParams.get("type") === "recovery" ||
    hashParams.get("auth_flow") === "password-recovery"
  );
}

function clearPasswordRecoveryMarkerFromUrl() {
  const searchParams = new URLSearchParams(window.location.search);
  if (!searchParams.has("auth_flow")) {
    return;
  }

  searchParams.delete("auth_flow");
  const nextSearch = searchParams.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`,
  );
}

const initialAuthRedirectError =
  typeof window === "undefined" ? undefined : readAuthRedirectError();

function shouldSubmitTextareaWithEnter() {
  if (typeof window === "undefined") {
    return true;
  }

  return !(
    window.matchMedia("(pointer: coarse)").matches ||
    window.navigator.maxTouchPoints > 0
  );
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="mode-switch-wrap" aria-label="機能切り替え">
      <div
        className={`mode-switch ${mode === "schedule" ? "is-schedule" : ""} ${
          mode === "note" ? "is-note" : ""
        }`}
      >
        <span className="mode-thumb" aria-hidden="true" />
        <button
          type="button"
          className={mode === "todo" ? "is-active" : ""}
          aria-pressed={mode === "todo"}
          onClick={() => onChange("todo")}
        >
          <ListChecks size={17} strokeWidth={2.4} />
          <span>ToDo</span>
        </button>
        <button
          type="button"
          className={mode === "schedule" ? "is-active" : ""}
          aria-pressed={mode === "schedule"}
          onClick={() => onChange("schedule")}
        >
          <CalendarDays size={17} strokeWidth={2.4} />
          <span>時間割</span>
        </button>
        <button
          type="button"
          className={mode === "note" ? "is-active" : ""}
          aria-pressed={mode === "note"}
          onClick={() => onChange("note")}
        >
          <FileText size={17} strokeWidth={2.4} />
          <span>Note</span>
        </button>
      </div>
    </div>
  );
}

function Composer({
  ariaLabel,
  context,
  error,
  leading,
  placeholder,
  submitLabel = "追加",
  tools,
  onAdd,
}: {
  ariaLabel: string;
  context?: string;
  error?: string;
  leading?: ReactNode;
  placeholder: string;
  submitLabel?: string;
  tools?: ReactNode;
  onAdd: (markdown: string) => boolean | Promise<boolean>;
}) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const isComposingRef = useRef(false);
  const ignoreSubmitUntilRef = useRef(0);
  const [markdown, setMarkdown] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const hasText = textFromMarkdown(markdown).length > 0;
  const enterSubmits = shouldSubmitTextareaWithEnter();

  const focusEditor = () => {
    editorRef.current?.focus();
  };

  const toggleBold = () => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = markdown.slice(start, end);
    const replacement = selected ? `**${selected}**` : "****";
    const cursor = selected ? start + replacement.length : start + 2;
    const nextMarkdown = `${markdown.slice(0, start)}${replacement}${markdown.slice(end)}`;

    setMarkdown(nextMarkdown);
    requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(cursor, cursor);
    });
  };

  const clearEditor = () => {
    setMarkdown("");
    focusEditor();
  };

  const submit = async () => {
    if (isSubmitting) {
      return;
    }

    const trimmedMarkdown = markdown.trim();
    if (!textFromMarkdown(trimmedMarkdown)) {
      focusEditor();
      return;
    }

    setIsSubmitting(true);
    const didAdd = await onAdd(trimmedMarkdown);
    setIsSubmitting(false);

    if (!didAdd) {
      requestAnimationFrame(focusEditor);
      return;
    }

    setMarkdown("");
    requestAnimationFrame(focusEditor);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const isBoldShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b";
    const nativeEvent = event.nativeEvent as KeyboardEvent;
    const isImeComposing =
      isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    const isImeSettling = Date.now() < ignoreSubmitUntilRef.current;

    if (isBoldShortcut) {
      event.preventDefault();
      toggleBold();
      return;
    }

    if (enterSubmits && event.key === "Enter" && !event.shiftKey) {
      if (isImeComposing) {
        return;
      }

      if (isImeSettling) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      void submit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      clearEditor();
    }
  };

  const handleMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };

  return (
    <form
      className={`composer ${error ? "has-error" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className={`composer-inner ${leading ? "has-leading" : ""}`}>
        {leading && <div className="composer-leading">{leading}</div>}
        <div className="editor-shell" onClick={focusEditor}>
          {context && <span className="composer-context">{context}</span>}
          <textarea
            ref={editorRef}
            className="editor"
            aria-label={ariaLabel}
            placeholder={placeholder}
            value={markdown}
            rows={2}
            onChange={(event) => setMarkdown(event.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              ignoreSubmitUntilRef.current = Date.now() + IME_SUBMIT_GUARD_MS;
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="composer-actions">
          {tools}
          <button
            type="button"
            className="icon-button"
            aria-label="太字"
            title="太字"
            onMouseDown={handleMouseDown}
            onClick={toggleBold}
          >
            <Bold size={18} strokeWidth={2.3} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="入力を消す"
            title="入力を消す"
            disabled={!hasText || isSubmitting}
            onMouseDown={handleMouseDown}
            onClick={clearEditor}
          >
            <X size={18} strokeWidth={2.3} />
          </button>
          <button
            type="submit"
            className="add-button"
            aria-label={submitLabel}
            title={submitLabel}
            disabled={!hasText || isSubmitting}
          >
            <Plus size={20} strokeWidth={2.5} />
          </button>
        </div>
      </div>
      <div className="composer-message" aria-live="polite">
        {error}
      </div>
    </form>
  );
}

function MarkdownEditForm({
  ariaLabel,
  initialValue,
  onCancel,
  onSave,
}: {
  ariaLabel: string;
  initialValue: string;
  onCancel: () => void;
  onSave: (markdown: string) => boolean | Promise<boolean>;
}) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const isComposingRef = useRef(false);
  const ignoreSubmitUntilRef = useRef(0);
  const [markdown, setMarkdown] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);
  const canSave = textFromMarkdown(markdown.trim()).length > 0 && !isSaving;
  const enterSaves = shouldSubmitTextareaWithEnter();

  useEffect(() => {
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  const save = async () => {
    if (!canSave) {
      editorRef.current?.focus();
      return;
    }

    setIsSaving(true);
    const didSave = await onSave(markdown.trim());
    setIsSaving(false);

    if (!didSave) {
      editorRef.current?.focus();
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent as KeyboardEvent;
    const isImeComposing =
      isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    const isImeSettling = Date.now() < ignoreSubmitUntilRef.current;

    if (enterSaves && event.key === "Enter" && !event.shiftKey) {
      if (isImeComposing) {
        return;
      }

      event.preventDefault();

      if (!isImeSettling) {
        void save();
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="markdown-edit">
      <textarea
        ref={editorRef}
        aria-label={ariaLabel}
        value={markdown}
        rows={3}
        onChange={(event) => setMarkdown(event.target.value)}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
          ignoreSubmitUntilRef.current = Date.now() + IME_SUBMIT_GUARD_MS;
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="markdown-edit-actions">
        <button type="button" onClick={() => void save()} disabled={!canSave}>
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={isSaving}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

function TodoView({
  tasks,
  onClearDone,
  onDelete,
  onDragEnd,
  onEdit,
  onToggle,
}: {
  tasks: Task[];
  onClearDone: () => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onDragEnd: (event: DragEndEvent) => void;
  onEdit: (id: string, markdown: string) => boolean | Promise<boolean>;
  onToggle: (id: string) => void | Promise<void>;
}) {
  const completedCount = useMemo(() => tasks.filter((task) => task.done).length, [tasks]);
  const activeCount = tasks.length - completedCount;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  return (
    <main className="workspace todo-workspace" aria-label="タスク一覧">
      <div className="list-toolbar">
        <div className="status-strip" aria-live="polite">
          <span>{tasks.length} 件</span>
          <span>{activeCount} 未完了</span>
          <span>{completedCount} 完了</span>
        </div>
        <button
          type="button"
          className="clear-button"
          disabled={completedCount === 0}
          onClick={onClearDone}
        >
          完了を削除
        </button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
          <ul className="task-list">
            {tasks.map((task) => (
              <SortableTask
                key={task.id}
                task={task}
                onEdit={onEdit}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {tasks.length === 0 && <div className="empty-state">未登録</div>}
    </main>
  );
}

function SortableTask({
  task,
  onEdit,
  onToggle,
  onDelete,
}: {
  task: Task;
  onEdit: (id: string, markdown: string) => boolean | Promise<boolean>;
  onToggle: (id: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: isEditing,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`task-row ${task.done ? "is-done" : ""} ${isDragging ? "is-dragging" : ""}`}
    >
      <button
        className="drag-handle"
        type="button"
        aria-label="並び替え"
        title="並び替え"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={20} strokeWidth={2.2} />
      </button>

      <label className="check-wrap">
        <input
          type="checkbox"
          checked={task.done}
          onChange={() => void onToggle(task.id)}
          aria-label="完了"
        />
        <span className="check-visual" aria-hidden="true">
          {task.done && <Check size={17} strokeWidth={2.7} />}
        </span>
      </label>

      {isEditing ? (
        <MarkdownEditForm
          ariaLabel="タスクを編集"
          initialValue={task.markdown}
          onCancel={() => setIsEditing(false)}
          onSave={async (markdown) => {
            const didSave = await onEdit(task.id, markdown);
            if (didSave) {
              setIsEditing(false);
            }
            return didSave;
          }}
        />
      ) : (
        <div
          className="task-content markdown-content"
          title="ダブルクリックで編集"
          onDoubleClick={() => setIsEditing(true)}
          dangerouslySetInnerHTML={{ __html: task.html }}
        />
      )}

      <button
        type="button"
        className="delete-button"
        aria-label="削除"
        title="削除"
        onClick={() => void onDelete(task.id)}
      >
        <Trash2 size={18} strokeWidth={2.2} />
      </button>
    </li>
  );
}

function ScheduleView({
  currentSlot,
  duration,
  error,
  items,
  selectedDate,
  selectedHour,
  onDelete,
  onEdit,
  onMoveDate,
  onSelectSlot,
  onToday,
}: {
  currentSlot: { date: string; hour: number | null };
  duration: Duration;
  error: ScheduleError | null;
  items: ScheduleItem[];
  selectedDate: string;
  selectedHour: number;
  onDelete: (id: string) => void | Promise<void>;
  onEdit: (id: string, markdown: string) => boolean | Promise<boolean>;
  onMoveDate: (amount: number) => void;
  onSelectSlot: (date: string, hour: number) => void;
  onToday: () => void;
}) {
  const visibleDays = [
    { date: addDays(selectedDate, -1), tone: "side", label: "前日" },
    { date: selectedDate, tone: "center", label: "選択日" },
    { date: addDays(selectedDate, 1), tone: "side", label: "翌日" },
  ] as const;

  return (
    <main className="workspace schedule-workspace" aria-label="時間割">
      <div className="schedule-toolbar">
        <button type="button" className="date-nav-button" aria-label="前日" onClick={() => onMoveDate(-1)}>
          <ChevronLeft size={19} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          className={`today-button ${isToday(selectedDate) ? "is-today" : ""}`}
          onClick={onToday}
        >
          {formatDayLabel(selectedDate)}
        </button>
        <button type="button" className="date-nav-button" aria-label="翌日" onClick={() => onMoveDate(1)}>
          <ChevronRight size={19} strokeWidth={2.5} />
        </button>
      </div>

      <div className="schedule-board">
        {visibleDays.map((day) => (
          <ScheduleDay
            key={day.date}
            currentSlot={currentSlot}
            date={day.date}
            duration={duration}
            error={error}
            items={items.filter((item) => item.date === day.date)}
            label={day.label}
            selectedDate={selectedDate}
            selectedHour={selectedHour}
            tone={day.tone}
            onDelete={onDelete}
            onEdit={onEdit}
            onSelectSlot={onSelectSlot}
          />
        ))}
      </div>
    </main>
  );
}

function ScheduleDay({
  currentSlot,
  date,
  duration,
  error,
  items,
  label,
  selectedDate,
  selectedHour,
  tone,
  onDelete,
  onEdit,
  onSelectSlot,
}: {
  currentSlot: { date: string; hour: number | null };
  date: string;
  duration: Duration;
  error: ScheduleError | null;
  items: ScheduleItem[];
  label: string;
  selectedDate: string;
  selectedHour: number;
  tone: "side" | "center";
  onDelete: (id: string) => void | Promise<void>;
  onEdit: (id: string, markdown: string) => boolean | Promise<boolean>;
  onSelectSlot: (date: string, hour: number) => void;
}) {
  const sortedItems = [...items].sort((a, b) => a.startHour - b.startHour || a.createdAt - b.createdAt);
  const today = isToday(date);

  return (
    <section
      className={`schedule-day is-${tone} ${today ? "is-today" : ""}`}
      aria-label={`${today ? "今日" : label} ${formatDayLabel(date)}`}
    >
      <div className="schedule-grid">
        {HOURS.map((hour) => {
          const selected = date === selectedDate && hour === selectedHour;
          const current = currentSlot.date === date && currentSlot.hour === hour;
          const covered = items.some((item) => isHourCovered(item, hour));
          const blockedPreview =
            date === selectedDate &&
            hour >= selectedHour &&
            hour < Math.min(selectedHour + duration, END_HOUR);
          const errorSlot =
            error &&
            error.date === date &&
            hour >= error.startHour &&
            hour < Math.min(error.startHour + error.duration, END_HOUR);

          return (
            <button
              key={hour}
              type="button"
              className={[
                "schedule-slot",
                current ? "is-current" : "",
                selected ? "is-selected" : "",
                covered ? "is-covered" : "",
                blockedPreview ? "is-preview" : "",
                errorSlot ? "is-error" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelectSlot(date, hour)}
            >
              <span>{formatHour(hour)}</span>
            </button>
          );
        })}

        <div className="schedule-block-layer" aria-hidden={items.length === 0}>
          {sortedItems.map((item) => (
            <ScheduleItemBlock key={item.id} item={item} onDelete={onDelete} onEdit={onEdit} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ScheduleItemBlock({
  item,
  onDelete,
  onEdit,
}: {
  item: ScheduleItem;
  onDelete: (id: string) => void | Promise<void>;
  onEdit: (id: string, markdown: string) => boolean | Promise<boolean>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const index = item.startHour - START_HOUR;
  const style = {
    top: `calc(${index} * (var(--schedule-slot-height) + var(--schedule-slot-gap)))`,
    height: `calc(${item.duration} * var(--schedule-slot-height) + ${
      item.duration - 1
    } * var(--schedule-slot-gap))`,
  };

  return (
    <article
      className={`schedule-block ${isEditing ? "is-editing" : ""}`}
      style={style}
      title={formatRange(item.startHour, item.duration)}
      onDoubleClick={() => setIsEditing(true)}
    >
      {isEditing ? (
        <MarkdownEditForm
          ariaLabel="予定を編集"
          initialValue={item.markdown}
          onCancel={() => setIsEditing(false)}
          onSave={async (markdown) => {
            const didSave = await onEdit(item.id, markdown);
            if (didSave) {
              setIsEditing(false);
            }
            return didSave;
          }}
        />
      ) : (
        <>
          <div>
            <div
              className="schedule-title markdown-content"
              title="ダブルクリックで編集"
              dangerouslySetInnerHTML={{ __html: item.titleHtml }}
            />
          </div>
          <button
            type="button"
            className="schedule-delete"
            aria-label="予定を削除"
            title="予定を削除"
            onClick={() => void onDelete(item.id)}
          >
            <Trash2 size={16} strokeWidth={2.3} />
          </button>
        </>
      )}
    </article>
  );
}

function LegacyNoteView({
  markdown,
  saveError,
  saveStatus,
  updatedAt,
  onChange,
}: {
  markdown: string;
  saveError?: string;
  saveStatus: NoteSaveStatus;
  updatedAt?: number;
  onChange: (markdown: string) => void;
}) {
  const [view, setView] = useState<"edit" | "preview">("edit");
  const previewHtml = useMemo(() => renderMarkdown(markdown || " "), [markdown]);
  const statusLabel = saveError
    ? "保存エラー"
    : saveStatus === "saving"
      ? "保存中"
      : saveStatus === "saved" || updatedAt
        ? "保存済み"
        : "未保存";

  return (
    <main className="workspace note-workspace is-legacy" aria-label="Note">
      <div className="note-toolbar">
        <div className="note-title">
          <FileText size={18} strokeWidth={2.3} />
          <span>Note</span>
        </div>
        <div className="note-controls" aria-label="Note表示切替">
          <button
            type="button"
            className={view === "edit" ? "is-active" : ""}
            aria-pressed={view === "edit"}
            onClick={() => setView("edit")}
          >
            編集
          </button>
          <button
            type="button"
            className={view === "preview" ? "is-active" : ""}
            aria-pressed={view === "preview"}
            onClick={() => setView("preview")}
          >
            プレビュー
          </button>
        </div>
        <span className={`note-save-status is-${saveError ? "error" : saveStatus}`}>
          {statusLabel}
        </span>
      </div>

      {view === "edit" ? (
        <textarea
          className="note-editor"
          aria-label="Note本文"
          value={markdown}
          placeholder="ここにメモを書く"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <article
          className="note-preview markdown-content"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      )}
    </main>
  );
}

function NoteView({
  markdown,
  saveError,
  saveStatus,
  updatedAt,
  onChange,
}: {
  markdown: string;
  saveError?: string;
  saveStatus: NoteSaveStatus;
  updatedAt?: number;
  onChange: (markdown: string) => void;
}) {
  const statusLabel = saveError
    ? "保存エラー"
    : saveStatus === "saving"
      ? "保存中"
      : saveStatus === "saved" || updatedAt
        ? "保存済み"
        : "未保存";

  return (
    <main className="workspace note-workspace" aria-label="Note">
      <div className="note-toolbar">
        <div className="note-title">
          <FileText size={18} strokeWidth={2.3} />
          <span>Note</span>
        </div>
        <span className={`note-save-status is-${saveError ? "error" : saveStatus}`}>
          {statusLabel}
        </span>
      </div>

      <NoteEditor markdown={markdown} onChange={onChange} />
    </main>
  );
}

function LoginView({
  error,
  isBusy,
  message,
  onResetPassword,
  onSignIn,
  onSignUp,
}: {
  error?: string;
  isBusy: boolean;
  message?: string;
  onResetPassword: (email: string) => Promise<void>;
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState(DEFAULT_LOGIN_EMAIL);
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const canSubmit = email.trim().length > 0 && password.length >= 6 && !isBusy;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextEmail = email.trim();
    if (mode === "sign-up") {
      void onSignUp(nextEmail, password);
      return;
    }
    void onSignIn(nextEmail, password);
  };

  return (
    <main className="auth-screen" aria-label="ログイン">
      <form className="auth-panel" onSubmit={handleSubmit}>
        <div className="auth-heading">
          <span>v2.0</span>
          <h1>{mode === "sign-up" ? "アカウント作成" : "ログイン"}</h1>
        </div>
        <label className="auth-field">
          <span>メールアドレス</span>
          <input
            type="email"
            value={email}
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder={DEFAULT_LOGIN_EMAIL}
            required
          />
        </label>
        <label className="auth-field">
          <span>パスワード</span>
          <input
            type="password"
            value={password}
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            minLength={6}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="6文字以上"
            required
          />
        </label>
        <button type="submit" className="auth-submit" disabled={!canSubmit}>
          {isBusy ? "処理中" : mode === "sign-up" ? "作成する" : "ログイン"}
        </button>
        <div className="auth-actions">
          <button
            type="button"
            className="auth-text-button"
            disabled={isBusy}
            onClick={() => {
              setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
            }}
          >
            {mode === "sign-up" ? "ログインに戻る" : "初回登録"}
          </button>
          <button
            type="button"
            className="auth-text-button"
            disabled={isBusy || !email.trim()}
            onClick={() => void onResetPassword(email.trim())}
          >
            パスワード再設定
          </button>
        </div>
        <div className="auth-message" aria-live="polite">
          {error || message || "PWA内でログインできます。初回はアカウント作成を使ってください。"}
        </div>
      </form>
    </main>
  );
}

function PasswordRecoveryView({
  error,
  isBusy,
  message,
  onSignOut,
  onUpdatePassword,
}: {
  error?: string;
  isBusy: boolean;
  message?: string;
  onSignOut: () => void;
  onUpdatePassword: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const canSubmit = password.length >= 6 && password === confirmPassword && !isBusy;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onUpdatePassword(password);
  };

  return (
    <main className="auth-screen" aria-label="パスワード再設定">
      <form className="auth-panel" onSubmit={handleSubmit}>
        <div className="auth-heading">
          <span>v2.0</span>
          <h1>パスワード再設定</h1>
        </div>
        <label className="auth-field">
          <span>新しいパスワード</span>
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            minLength={6}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="6文字以上"
            required
          />
        </label>
        <label className="auth-field">
          <span>確認</span>
          <input
            type="password"
            value={confirmPassword}
            autoComplete="new-password"
            minLength={6}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="もう一度入力"
            required
          />
        </label>
        <button type="submit" className="auth-submit" disabled={!canSubmit}>
          {isBusy ? "更新中" : "更新する"}
        </button>
        <button type="button" className="secondary-button" disabled={isBusy} onClick={onSignOut}>
          ログインに戻る
        </button>
        <div className="auth-message" aria-live="polite">
          {error ||
            message ||
            (password && confirmPassword && password !== confirmPassword
              ? "確認用パスワードが一致していません。"
              : "新しいパスワードを設定してください。")}
        </div>
      </form>
    </main>
  );
}

function AppStateScreen({
  action,
  message,
  onAction,
  onSignOut,
  title,
  userEmail,
}: {
  action?: string;
  message?: string;
  onAction?: () => void;
  onSignOut?: () => void;
  title: string;
  userEmail?: string;
}) {
  return (
    <main className="auth-screen" aria-label={title}>
      <section className="auth-panel">
        <div className="auth-heading">
          {userEmail && <span>{userEmail}</span>}
          <h1>{title}</h1>
        </div>
        {message && <p className="state-message">{message}</p>}
        <div className="state-actions">
          {action && onAction && (
            <button type="button" className="auth-submit" onClick={onAction}>
              {action}
            </button>
          )}
          {onSignOut && (
            <button type="button" className="secondary-button" onClick={onSignOut}>
              ログアウト
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

function AccountBar({ message, onSignOut }: { message?: string; onSignOut: () => void }) {
  return (
    <div className="account-bar">
      {message && <span>{message}</span>}
      <button type="button" aria-label="ログアウト" title="ログアウト" onClick={onSignOut}>
        <LogOut size={17} strokeWidth={2.4} />
      </button>
    </div>
  );
}

export default function App() {
  const initialViewRef = useRef<ViewState | null>(null);
  if (initialViewRef.current === null) {
    initialViewRef.current = loadViewState();
  }

  const initialView = initialViewRef.current;
  const [mode, setMode] = useState<Mode>(initialView.mode);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scheduleItems, setScheduleItems] = useState<ScheduleItem[]>([]);
  const [noteMarkdown, setNoteMarkdown] = useState("");
  const [noteUpdatedAt, setNoteUpdatedAt] = useState<number | undefined>();
  const [noteSaveStatus, setNoteSaveStatus] = useState<NoteSaveStatus>("idle");
  const [noteSaveError, setNoteSaveError] = useState<string | undefined>();
  const [selectedDate, setSelectedDate] = useState(initialView.selectedDate);
  const [selectedHour, setSelectedHour] = useState(initialView.selectedHour);
  const [duration, setDuration] = useState<Duration>(initialView.duration);
  const [scheduleError, setScheduleError] = useState<ScheduleError | null>(null);
  const [currentSlot, setCurrentSlot] = useState(() => getCurrentScheduleSlot());
  const [session, setSession] = useState<Session | null>(null);
  const [appStatus, setAppStatus] = useState<AppStatus>("checking-auth");
  const [appError, setAppError] = useState<string | undefined>(supabaseConfigError ?? undefined);
  const [authMessage, setAuthMessage] = useState<string | undefined>();
  const [authError, setAuthError] = useState<string | undefined>(initialAuthRedirectError);
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const lastSavedNoteRef = useRef("");
  const noteCloudLoadedRef = useRef(false);
  const noteEditRevisionRef = useRef(0);
  const noteSaveRequestRef = useRef(0);

  useEffect(() => {
    clearAuthRedirectErrorFromUrl();
  }, []);

  useEffect(() => {
    const viewState: ViewState = {
      mode,
      selectedDate,
      selectedHour,
      duration,
    };
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(viewState));
  }, [duration, mode, selectedDate, selectedHour]);

  useEffect(() => {
    if (!scheduleError) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setScheduleError(null);
    }, 1100);

    return () => window.clearTimeout(timeout);
  }, [scheduleError]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setCurrentSlot(getCurrentScheduleSlot());
    }, 60_000);

    return () => window.clearInterval(interval);
  }, []);

  const loadCloudData = useCallback(async (user: User) => {
    if (!supabase) {
      setAppStatus("error");
      setAppError(supabaseConfigError ?? "Supabase設定を確認してください");
      return;
    }

    setAppStatus("loading-data");
    setAppError(undefined);
    setSaveError(undefined);

    try {
      const [todoResult, scheduleResult, noteResult] = await Promise.all([
        supabase
          .from("todo_items")
          .select("*")
          .eq("user_id", user.id)
          .order("order_index", { ascending: true })
          .order("created_at", { ascending: true }),
        supabase
          .from("schedule_items")
          .select("*")
          .eq("user_id", user.id)
          .order("date", { ascending: true })
          .order("start_hour", { ascending: true }),
        supabase
          .from("notes")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle(),
      ]);

      if (todoResult.error) {
        throw todoResult.error;
      }

      if (scheduleResult.error) {
        throw scheduleResult.error;
      }

      const cloudNote = noteResult.error
        ? ""
        : noteMarkdownFromRow(noteResult.data as NoteRow | null);
      const cloudUpdatedAt =
        !noteResult.error && noteResult.data
          ? Date.parse((noteResult.data as NoteRow).updated_at) || 0
          : 0;
      const storedDraft = readStoredNoteDraft(user.id);
      const shouldRestoreDraft =
        !noteResult.error &&
        storedDraft !== null &&
        storedDraft.updatedAt > cloudUpdatedAt &&
        storedDraft.markdown !== cloudNote;
      const loadedNote = shouldRestoreDraft ? storedDraft.markdown : cloudNote;

      setTasks(((todoResult.data ?? []) as TodoRow[]).map(taskFromRow));
      setScheduleItems(((scheduleResult.data ?? []) as ScheduleRow[]).map(scheduleItemFromRow));
      setNoteMarkdown(loadedNote);
      setNoteUpdatedAt(cloudUpdatedAt || undefined);
      lastSavedNoteRef.current = cloudNote;
      noteCloudLoadedRef.current = !noteResult.error;
      noteEditRevisionRef.current = shouldRestoreDraft ? 1 : 0;
      noteSaveRequestRef.current = 0;
      setNoteSaveStatus(
        noteResult.error ? "error" : shouldRestoreDraft ? "saving" : noteResult.data ? "saved" : "idle",
      );
      setNoteSaveError(
        noteResult.error
          ? `Noteを読み込めませんでした: ${noteResult.error.message}`
          : shouldRestoreDraft
            ? "この端末に残っていた未保存内容を復元しました"
            : undefined,
      );
      setAppStatus("ready");
    } catch (error) {
      setAppStatus("error");
      setAppError(`データを読み込めませんでした: ${getErrorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      setAppStatus("error");
      setAppError(supabaseConfigError ?? "Supabase設定を確認してください");
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) {
        return;
      }

      if (error) {
        setAppStatus("error");
        setAppError(`ログイン状態を確認できませんでした: ${error.message}`);
        return;
      }

      setSession(data.session);
      setAppStatus(
        data.session
          ? isPasswordRecoveryUrl()
            ? "password-recovery"
            : "loading-data"
          : "signed-out",
      );
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      setAuthMessage(undefined);
      setSaveError(undefined);

      if (event === "PASSWORD_RECOVERY" || (nextSession && isPasswordRecoveryUrl())) {
        setAuthError(undefined);
        setAppStatus("password-recovery");
        return;
      }

      if (nextSession) {
        setAuthError(undefined);
        setAppStatus("loading-data");
        return;
      }

      setTasks([]);
      setScheduleItems([]);
      setNoteMarkdown("");
      setNoteUpdatedAt(undefined);
      lastSavedNoteRef.current = "";
      setAppStatus("signed-out");
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (appStatus === "loading-data" && session?.user) {
      void loadCloudData(session.user);
    }
  }, [appStatus, loadCloudData, session?.user]);

  const signInWithPassword = async (email: string, password: string) => {
    if (!supabase) {
      setAuthError(supabaseConfigError ?? "Supabase設定を確認してください");
      return;
    }

    setIsAuthBusy(true);
    setAuthError(undefined);
    setAuthMessage(undefined);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setIsAuthBusy(false);

    if (error) {
      setAuthError(`ログインできませんでした: ${error.message}`);
      return;
    }
  };

  const signUpWithPassword = async (email: string, password: string) => {
    if (!supabase) {
      setAuthError(supabaseConfigError ?? "Supabase設定を確認してください");
      return;
    }

    setIsAuthBusy(true);
    setAuthError(undefined);
    setAuthMessage(undefined);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    setIsAuthBusy(false);

    if (error) {
      setAuthError(`アカウントを作成できませんでした: ${error.message}`);
      return;
    }

    if (data.session) {
      return;
    }

    setAuthMessage(`${email} に確認メールを送信しました。メール内のリンクを開いてください。`);
  };

  const resetPassword = async (email: string) => {
    if (!supabase) {
      setAuthError(supabaseConfigError ?? "Supabase設定を確認してください");
      return;
    }

    if (!email) {
      setAuthError("メールアドレスを入力してください。");
      return;
    }

    setIsAuthBusy(true);
    setAuthError(undefined);
    setAuthMessage(undefined);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/?auth_flow=password-recovery`,
    });

    setIsAuthBusy(false);

    if (error) {
      setAuthError(`パスワード再設定メールを送信できませんでした: ${error.message}`);
      return;
    }

    setAuthMessage(`${email} にパスワード再設定メールを送信しました。`);
  };

  const updatePassword = async (password: string) => {
    if (!supabase) {
      setAuthError(supabaseConfigError ?? "Supabase設定を確認してください");
      return;
    }

    setIsAuthBusy(true);
    setAuthError(undefined);
    setAuthMessage(undefined);

    const { error } = await supabase.auth.updateUser({ password });

    setIsAuthBusy(false);

    if (error) {
      setAuthError(`パスワードを更新できませんでした: ${error.message}`);
      return;
    }

    setAuthMessage("パスワードを更新しました。");
    clearPasswordRecoveryMarkerFromUrl();
    setAppStatus(session?.user ? "loading-data" : "signed-out");
  };

  const signOut = async () => {
    setSaveError(undefined);
    setAuthMessage(undefined);
    setAuthError(undefined);

    if (supabase) {
      await supabase.auth.signOut();
    }

    setSession(null);
    setTasks([]);
    setScheduleItems([]);
    setNoteMarkdown("");
    setNoteUpdatedAt(undefined);
    setNoteSaveStatus("idle");
    setNoteSaveError(undefined);
    lastSavedNoteRef.current = "";
    noteCloudLoadedRef.current = false;
    noteEditRevisionRef.current = 0;
    noteSaveRequestRef.current = 0;
    setAppStatus("signed-out");
  };

  const activeUser = session?.user ?? null;
  const activeUserId = activeUser?.id;

  const saveNote = useCallback(
    async (markdown: string, revision: number) => {
      if (!supabase || !activeUserId) {
        setNoteSaveStatus("error");
        setNoteSaveError("ログイン状態を確認してください");
        return;
      }

      if (!noteCloudLoadedRef.current) {
        setNoteSaveStatus("error");
        setNoteSaveError("Noteの読み込みに失敗しているため保存を停止しました");
        return;
      }

      const requestId = noteSaveRequestRef.current + 1;
      noteSaveRequestRef.current = requestId;
      setNoteSaveStatus("saving");
      setNoteSaveError(undefined);

      const { data, error } = await supabase
        .from("notes")
        .upsert(
          {
            user_id: activeUserId,
            content_markdown: markdown,
          },
          { onConflict: "user_id" },
        )
        .select("*")
        .single();

      if (error || !data) {
        if (
          requestId === noteSaveRequestRef.current &&
          revision === noteEditRevisionRef.current
        ) {
          setNoteSaveStatus("error");
          setNoteSaveError(
            `Noteを保存できませんでした: ${error?.message ?? "データが返りませんでした"}`,
          );
        }
        return;
      }

      if (
        requestId !== noteSaveRequestRef.current ||
        revision !== noteEditRevisionRef.current
      ) {
        return;
      }

      const savedNote = noteMarkdownFromRow(data as NoteRow);
      lastSavedNoteRef.current = savedNote;
      clearStoredNoteDraft(activeUserId);
      setNoteUpdatedAt(Date.parse((data as NoteRow).updated_at) || Date.now());
      setNoteSaveStatus("saved");
      setNoteSaveError(undefined);
    },
    [activeUserId],
  );

  useEffect(() => {
    if (appStatus !== "ready" || !activeUserId) {
      return;
    }

    if (noteMarkdown === lastSavedNoteRef.current) {
      return;
    }

    setNoteSaveStatus("saving");
    setNoteSaveError(undefined);

    const timeout = window.setTimeout(() => {
      void saveNote(noteMarkdown, noteEditRevisionRef.current);
    }, 900);

    return () => window.clearTimeout(timeout);
  }, [activeUserId, appStatus, noteMarkdown, saveNote]);

  const updateNoteMarkdown = useCallback(
    (markdown: string) => {
      if (!activeUserId || markdown === noteMarkdown) {
        return;
      }

      noteEditRevisionRef.current += 1;
      storeInitialNoteBackup(activeUserId, lastSavedNoteRef.current);
      storeNoteDraft(activeUserId, {
        baseMarkdown: lastSavedNoteRef.current,
        markdown,
        updatedAt: Date.now(),
      });
      setNoteMarkdown(markdown);
    },
    [activeUserId, noteMarkdown],
  );

  const addTask = async (markdown: string) => {
    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return false;
    }

    setSaveError(undefined);

    const { data, error } = await supabase
      .from("todo_items")
      .insert({
        user_id: activeUser.id,
        content_html: markdown,
        done: false,
        order_index: tasks.length,
      })
      .select("*")
      .single();

    if (error || !data) {
      setSaveError(`ToDoを保存できませんでした: ${error?.message ?? "データが返りませんでした"}`);
      return false;
    }

    setTasks((current) => [...current, taskFromRow(data as TodoRow)]);
    return true;
  };

  const editTask = async (id: string, markdown: string) => {
    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return false;
    }

    const previous = tasks;
    const nextTask = {
      markdown,
      html: renderMarkdown(markdown),
    };

    setTasks((current) => current.map((task) => (task.id === id ? { ...task, ...nextTask } : task)));
    setSaveError(undefined);

    const { error } = await supabase
      .from("todo_items")
      .update({ content_html: markdown })
      .eq("id", id)
      .eq("user_id", activeUser.id);

    if (error) {
      setTasks(previous);
      setSaveError(`ToDoを更新できませんでした: ${error.message}`);
      return false;
    }

    return true;
  };

  const toggleTask = async (id: string) => {
    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return;
    }

    const target = tasks.find((task) => task.id === id);
    if (!target) {
      return;
    }

    const nextDone = !target.done;
    const previous = tasks;
    setTasks((current) =>
      current.map((task) => (task.id === id ? { ...task, done: nextDone } : task)),
    );
    setSaveError(undefined);

    const { error } = await supabase
      .from("todo_items")
      .update({ done: nextDone })
      .eq("id", id)
      .eq("user_id", activeUser.id);

    if (error) {
      setTasks(previous);
      setSaveError(`ToDoを更新できませんでした: ${error.message}`);
    }
  };

  const deleteTask = async (id: string) => {
    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return;
    }

    const previous = tasks;
    setTasks((current) => current.filter((task) => task.id !== id));
    setSaveError(undefined);

    const { error } = await supabase
      .from("todo_items")
      .delete()
      .eq("id", id)
      .eq("user_id", activeUser.id);

    if (error) {
      setTasks(previous);
      setSaveError(`ToDoを削除できませんでした: ${error.message}`);
    }
  };

  const clearDone = async () => {
    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return;
    }

    const doneIds = tasks.filter((task) => task.done).map((task) => task.id);
    if (doneIds.length === 0) {
      return;
    }

    const previous = tasks;
    setTasks((current) => current.filter((task) => !task.done));
    setSaveError(undefined);

    const { error } = await supabase
      .from("todo_items")
      .delete()
      .eq("user_id", activeUser.id)
      .in("id", doneIds);

    if (error) {
      setTasks(previous);
      setSaveError(`完了済みToDoを削除できませんでした: ${error.message}`);
    }
  };

  const handleTaskDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return;
    }

    const activeId = String(active.id);
    const overId = String(over.id);
    const oldIndex = tasks.findIndex((task) => task.id === activeId);
    const newIndex = tasks.findIndex((task) => task.id === overId);

    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const previous = tasks;
    const nextTasks = arrayMove(tasks, oldIndex, newIndex);
    const client = supabase;
    setTasks(nextTasks);
    setSaveError(undefined);

    const results = await Promise.all(
      nextTasks.map((task, orderIndex) =>
        client
          .from("todo_items")
          .update({ order_index: orderIndex })
          .eq("id", task.id)
          .eq("user_id", activeUser.id),
      ),
    );

    const failed = results.find((result) => result.error);
    if (failed?.error) {
      setTasks(previous);
      setSaveError(`並び順を保存できませんでした: ${failed.error.message}`);
    }
  };

  const selectSlot = (date: string, hour: number) => {
    setScheduleError(null);
    setSelectedDate(date);
    setSelectedHour(clampHour(hour));
  };

  const addScheduleItem = async (markdown: string) => {
    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return false;
    }

    const message =
      selectedHour + duration > END_HOUR ? "時間外です" : "入れられません";

    if (hasScheduleConflict(scheduleItems, selectedDate, selectedHour, duration)) {
      setScheduleError({
        date: selectedDate,
        startHour: selectedHour,
        duration,
        message,
        key: Date.now(),
      });
      return false;
    }

    setSaveError(undefined);

    const orderIndex = scheduleItems.filter((item) => item.date === selectedDate).length;
    const { data, error } = await supabase
      .from("schedule_items")
      .insert({
        user_id: activeUser.id,
        date: selectedDate,
        title_html: markdown,
        start_hour: selectedHour,
        duration_hours: duration,
        order_index: orderIndex,
      })
      .select("*")
      .single();

    if (error || !data) {
      setScheduleError({
        date: selectedDate,
        startHour: selectedHour,
        duration,
        message,
        key: Date.now(),
      });
      setSaveError(`予定を保存できませんでした: ${error?.message ?? "データが返りませんでした"}`);
      return false;
    }

    const item = scheduleItemFromRow(data as ScheduleRow);
    const nextItems = [...scheduleItems, item];

    setScheduleItems(nextItems);
    setScheduleError(null);
    setSelectedHour(findNextAvailableHour(nextItems, selectedDate, selectedHour + duration, duration));
    return true;
  };

  const editScheduleItem = async (id: string, markdown: string) => {
    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return false;
    }

    const previous = scheduleItems;
    const nextItem = {
      markdown,
      titleHtml: renderMarkdown(markdown),
      updatedAt: Date.now(),
    };

    setScheduleItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...nextItem } : item)),
    );
    setSaveError(undefined);

    const { error } = await supabase
      .from("schedule_items")
      .update({ title_html: markdown })
      .eq("id", id)
      .eq("user_id", activeUser.id);

    if (error) {
      setScheduleItems(previous);
      setSaveError(`予定を更新できませんでした: ${error.message}`);
      return false;
    }

    return true;
  };

  const deleteScheduleItem = async (id: string) => {
    if (!supabase || !activeUser) {
      setSaveError("ログイン状態を確認してください");
      return;
    }

    const previous = scheduleItems;
    setScheduleItems((current) => current.filter((item) => item.id !== id));
    setSaveError(undefined);

    const { error } = await supabase
      .from("schedule_items")
      .delete()
      .eq("id", id)
      .eq("user_id", activeUser.id);

    if (error) {
      setScheduleItems(previous);
      setSaveError(`予定を削除できませんでした: ${error.message}`);
    }
  };

  const cycleDuration = () => {
    setDuration((current) => {
      const next = current === 1 ? 2 : current === 2 ? 3 : 1;
      setSelectedHour((hour) => Math.min(hour, END_HOUR - next));
      setScheduleError(null);
      return next;
    });
  };

  const moveDate = (amount: number) => {
    setSelectedDate((current) => addDays(current, amount));
    setSelectedHour(START_HOUR);
    setScheduleError(null);
  };

  const goToday = () => {
    setSelectedDate(formatDate(new Date()));
    setSelectedHour(START_HOUR);
    setScheduleError(null);
  };

  const retryLoad = () => {
    if (activeUser) {
      void loadCloudData(activeUser);
      return;
    }

    window.location.reload();
  };

  if (appStatus === "checking-auth") {
    return <AppStateScreen title="ログイン状態を確認中" />;
  }

  if (appStatus === "password-recovery") {
    return (
      <PasswordRecoveryView
        error={authError}
        isBusy={isAuthBusy}
        message={authMessage}
        onSignOut={() => void signOut()}
        onUpdatePassword={updatePassword}
      />
    );
  }

  if (appStatus === "signed-out" || !session) {
    return (
      <LoginView
        error={authError || appError}
        isBusy={isAuthBusy}
        message={authMessage}
        onResetPassword={resetPassword}
        onSignIn={signInWithPassword}
        onSignUp={signUpWithPassword}
      />
    );
  }

  if (appStatus === "loading-data") {
    return (
      <AppStateScreen
        title="データを読み込み中"
        userEmail={session.user.email}
        onSignOut={() => void signOut()}
      />
    );
  }

  if (appStatus === "error") {
    return (
      <AppStateScreen
        title="接続を確認してください"
        message={appError}
        action="再試行"
        onAction={retryLoad}
        userEmail={session.user.email}
        onSignOut={() => void signOut()}
      />
    );
  }

  const scheduleErrorMessage = scheduleError?.message;
  const composerError = saveError ?? (mode === "schedule" ? scheduleErrorMessage : undefined);
  const accountMessage = saveError || (mode === "note" && noteSaveError) ? "保存エラー" : undefined;

  return (
    <div className={`app-shell mode-${mode}`}>
      <ModeSwitch mode={mode} onChange={setMode} />
      <AccountBar
        message={accountMessage}
        onSignOut={() => void signOut()}
      />

      {mode === "todo" ? (
        <TodoView
          tasks={tasks}
          onClearDone={clearDone}
          onDelete={deleteTask}
          onDragEnd={(event) => void handleTaskDragEnd(event)}
          onEdit={editTask}
          onToggle={toggleTask}
        />
      ) : mode === "schedule" ? (
        <ScheduleView
          currentSlot={currentSlot}
          duration={duration}
          error={scheduleError}
          items={scheduleItems}
          selectedDate={selectedDate}
          selectedHour={selectedHour}
          onDelete={deleteScheduleItem}
          onEdit={editScheduleItem}
          onMoveDate={moveDate}
          onSelectSlot={selectSlot}
          onToday={goToday}
        />
      ) : (
        <>
          {USE_LEGACY_NOTE_EDITOR ? (
            <LegacyNoteView
              markdown={noteMarkdown}
              saveError={noteSaveError}
              saveStatus={noteSaveStatus}
              updatedAt={noteUpdatedAt}
              onChange={updateNoteMarkdown}
            />
          ) : (
            <NoteView
              markdown={noteMarkdown}
              saveError={noteSaveError}
              saveStatus={noteSaveStatus}
              updatedAt={noteUpdatedAt}
              onChange={updateNoteMarkdown}
            />
          )}
        </>
      )}

      {mode !== "note" && (
        <Composer
          key={mode}
          ariaLabel={mode === "todo" ? "タスク入力" : "時間割入力"}
          error={composerError}
          tools={
            mode === "schedule" ? (
              <button
                type="button"
                className="duration-button"
                aria-label={`長さ ${duration}時間`}
                title="長さ"
                onMouseDown={(event) => event.preventDefault()}
                onClick={cycleDuration}
              >
                <Clock3 size={18} strokeWidth={2.4} />
                <span>{duration}h</span>
              </button>
            ) : undefined
          }
          placeholder={mode === "todo" ? "次にやること" : "予定を入力"}
          onAdd={mode === "todo" ? addTask : addScheduleItem}
        />
      )}
    </div>
  );
}
