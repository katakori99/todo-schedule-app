const COMPACT_DRAFT_STORAGE_PREFIX = "todo-schedule.compact-draft.v1";

export function compactMarkdownDraftKey(scope: "schedule" | "todo", id: string) {
  return `${COMPACT_DRAFT_STORAGE_PREFIX}.${scope}.${id}`;
}

export function readCompactMarkdownDraft(key: string, fallback: string) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function storeCompactMarkdownDraft(key: string, markdown: string) {
  try {
    window.localStorage.setItem(key, markdown);
  } catch {
    // Cloud saving remains available when local storage is unavailable.
  }
}

export function discardCompactMarkdownDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing else is required if local storage is unavailable.
  }
}
