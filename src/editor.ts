import { Editor, Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { BubbleMenu } from "@tiptap/extension-bubble-menu";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import { cleanupMarkdownOutput } from "./utils/string";
import { Embed, parseEmbedUrl } from "./embed";

/** Heuristic: does the pasted text look like markdown we can convert? */
function looksLikeMarkdown(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return false;
  // Headings: # ## ### etc.
  if (/^#{1,6}\s+/m.test(t)) return true;
  // Bold ** or __
  if (/\*\*[^*]+\*\*|__[^_]+__/.test(t)) return true;
  // Italic * or _ (single, not double)
  if (/(?<!\*)\*[^*]+\*(?!\*)|(?<!_)_[^_]+_(?!_)/.test(t)) return true;
  // List: - or * or 1. at line start
  if (/^[\s]*[-*]\s+/m.test(t) || /^[\s]*\d+\.\s+/m.test(t)) return true;
  // Link [text](url)
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) return true;
  // Inline code `code`
  if (/`[^`]+`/.test(t)) return true;
  // Blockquote >
  if (/^>\s+/m.test(t)) return true;
  // Code block ```
  if (/^```[\s\S]*```/m.test(t)) return true;
  return false;
}

/** Allowed heading levels for pasted markdown (e.g. [2, 3, 4, 5, 6]). Pasted headings are clamped to the nearest allowed level. */
const DEFAULT_MARKDOWN_PASTE_HEADING_LEVELS = [2, 3, 4, 5, 6] as const;

type JSONContent = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JSONContent[];
  [key: string]: unknown;
};

function clampHeadingLevel(level: number, allowed: number[]): number {
  if (allowed.length === 0) return level;
  if (allowed.indexOf(level) !== -1) return level;
  const min = Math.min(...allowed);
  const max = Math.max(...allowed);
  if (level < min) return min;
  if (level > max) return max;
  return allowed.reduce((prev, curr) =>
    Math.abs(curr - level) < Math.abs(prev - level) ? curr : prev,
  );
}

function normalizeHeadingLevelsInContent(
  node: JSONContent,
  allowedLevels: number[],
): void {
  if (node.type === "heading" && node.attrs && typeof node.attrs.level === "number") {
    node.attrs = {
      ...node.attrs,
      level: clampHeadingLevel(node.attrs.level, allowedLevels),
    };
  }
  node.content?.forEach((child) =>
    normalizeHeadingLevelsInContent(child, allowedLevels),
  );
}

/** Normalize heading levels in the current doc so they match allowed levels (e.g. clamp h1 → h2). */
function normalizeDocHeadingLevels(editor: Editor, allowedLevels: number[]): void {
  const minLevel = allowedLevels.length > 0 ? Math.min(...allowedLevels) : 1;
  const updates: { pos: number; attrs: Record<string, unknown> }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading" && typeof node.attrs.level === "number" && node.attrs.level < minLevel) {
      updates.push({ pos, attrs: { ...node.attrs, level: minLevel } });
    }
  });
  if (updates.length === 0) return;
  updates.sort((a, b) => b.pos - a.pos);
  let tr = editor.state.tr;
  for (const { pos, attrs } of updates) {
    tr = tr.setNodeMarkup(pos, undefined, attrs);
  }
  editor.view.dispatch(tr);
}

/** On copy, puts the selected content as markdown in the clipboard (text/plain). */
const MarkdownCopy = Extension.create({
  name: "markdownCopy",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            copy(view, event) {
              const { state } = view;
              const { selection } = state;
              const { from, to } = selection;
              if (from === to || !editor.markdown) return false;
              const slice = state.doc.slice(from, to);
              if (slice.content.size === 0) return false;
              const content = slice.content.content.map((node) => node.toJSON());
              const docJson = { type: "doc", content };
              let markdown = editor.markdown.serialize(docJson);
              markdown = cleanupMarkdownOutput(markdown);
              event.preventDefault();
              event.clipboardData?.clearData();
              event.clipboardData?.setData("text/plain", markdown);
              return true;
            },
          },
        },
      }),
    ];
  },
});

/** Intercepts paste of plain-text markdown and inserts formatted content. */
const MarkdownPaste = Extension.create<{
  headingLevels: number[];
}>({
  name: "markdownPaste",

  addOptions() {
    return {
      headingLevels: [...DEFAULT_MARKDOWN_PASTE_HEADING_LEVELS],
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const allowedLevels = this.options.headingLevels;
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;
            const html = clipboardData.getData("text/html")?.trim() ?? "";
            if (html) return false;
            const text = clipboardData.getData("text/plain")?.trim() ?? "";
            if (!text || !editor.markdown || !looksLikeMarkdown(text)) {
              return false;
            }
            const parsed = editor.markdown.parse(text) as JSONContent;
            normalizeHeadingLevelsInContent(parsed, allowedLevels);
            editor.chain().focus().insertContent(parsed).run();
            return true;
          },
        },
      }),
    ];
  },
});

interface EditorOptions {
  element: HTMLElement;
  content: string;
  /** Element for the bubble menu (image alt + embed URL). If provided, BubbleMenu is registered. */
  bubbleMenuElement?: HTMLElement;
  /**
   * URL template for generic embeds. Use {url} where the encoded embed URL should go.
   * Example: "https://custom-handler.com/embed?url={url}"
   */
  embedHandlerTemplate?: string | null;
  /**
   * Heading levels allowed when pasting markdown (e.g. [2, 3, 4, 5, 6]). Pasted headings
   * are clamped to the nearest allowed level. Defaults to [2, 3, 4, 5, 6] to match StarterKit.
   */
  markdownPasteHeadingLevels?: number[];
}

export function initEditor({
  element,
  content,
  bubbleMenuElement,
  embedHandlerTemplate,
  markdownPasteHeadingLevels,
}: EditorOptions) {
  const headingLevels = markdownPasteHeadingLevels ?? [...DEFAULT_MARKDOWN_PASTE_HEADING_LEVELS];
  const extensions = [
    // Embed uses priority: 1000 so its handlePaste runs before other plugins and can turn pasted URLs into embeds
    // (otherwise default/StarterKit paste consumes the event when clipboard has text/html, e.g. SoundCloud).
    Embed.configure({
      customEmbedHandler: embedHandlerTemplate ?? null,
    }),
    StarterKit.configure({
      heading: {
        levels: headingLevels as (1 | 2 | 3 | 4 | 5 | 6)[],
      },
      link: {
        openOnClick: false,
        enableClickSelection: true,
        HTMLAttributes: { rel: "noopener noreferrer" },
      },
    }),
    Image,
    Markdown,
    MarkdownCopy,
    MarkdownPaste.configure({ headingLevels }),
    ...(bubbleMenuElement
      ? [
          BubbleMenu.configure({
            element: bubbleMenuElement,
            shouldShow: ({ state, editor }) => {
              const { selection } = state;
              if (selection instanceof NodeSelection) {
                const name = selection.node.type.name;
                return name === "image" || name === "embed";
              }
              return editor.isActive("link");
            },
          }),
        ]
      : []),
  ];

  const editor = new Editor({
    element,
    extensions,
    content,
    contentType: "markdown",
    editorProps: {
      handleClick(view, _pos, event) {
        const target = event.target as HTMLElement;
        if (target.closest("a") || target.closest(".embed-iframe")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  });
  // Initial markdown is parsed by @tiptap/markdown and can produce h1; schema only allows headingLevels (e.g. 2–6). Normalize so markdown output matches.
  normalizeDocHeadingLevels(editor, headingLevels);
  return editor;
}

function getBubblePanels(menuElement: HTMLElement) {
  return {
    image: menuElement.querySelector<HTMLElement>('[data-bubble-panel="image"]'),
    embed: menuElement.querySelector<HTMLElement>('[data-bubble-panel="embed"]'),
    link: menuElement.querySelector<HTMLElement>('[data-bubble-panel="link"]'),
  };
}

/**
 * Binds the image alt-text panel to the editor: syncs input with
 * selected image alt and updates the image when the user edits alt text.
 */
export function attachImageAltMenu(
  editor: Editor,
  menuElement: HTMLElement,
): () => void {
  const input = menuElement.querySelector<HTMLInputElement>(
    'input[data-image-alt]',
  );
  const panels = getBubblePanels(menuElement);
  if (!input) return () => {};

  const syncFromSelection = () => {
    const { state } = editor;
    const { selection } = state;
    if (
      selection instanceof NodeSelection &&
      selection.node.type.name === "image"
    ) {
      if (panels.image) panels.image.style.display = "";
      if (panels.embed) panels.embed.style.display = "none";
      if (panels.link) panels.link.style.display = "none";
      input.value = selection.node.attrs.alt ?? "";
      input.placeholder = "Describe the image";
    } else if (panels.image) {
      panels.image.style.display = "none";
    }
  };

  const commitAlt = () => {
    const alt = input.value.trim();
    if (editor.isActive("image")) {
      editor.chain().focus().updateAttributes("image", { alt }).run();
    }
  };

  editor.on("selectionUpdate", syncFromSelection);
  input.addEventListener("change", commitAlt);
  input.addEventListener("blur", commitAlt);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
  });

  return function detach() {
    editor.off("selectionUpdate", syncFromSelection);
    input.removeEventListener("change", commitAlt);
    input.removeEventListener("blur", commitAlt);
  };
}

/**
 * Binds the embed URL panel to the editor: syncs input with the selected
 * embed and updates the embed when the user edits the URL.
 */
export function attachEmbedEditMenu(
  editor: Editor,
  menuElement: HTMLElement,
): () => void {
  const srcInput = menuElement.querySelector<HTMLInputElement>(
    'input[data-embed-src]',
  );
  const panels = getBubblePanels(menuElement);
  if (!srcInput) return () => {};

  const syncFromSelection = () => {
    const { state } = editor;
    const { selection } = state;
    if (
      selection instanceof NodeSelection &&
      selection.node.type.name === "embed"
    ) {
      if (panels.embed) panels.embed.style.display = "";
      if (panels.image) panels.image.style.display = "none";
      if (panels.link) panels.link.style.display = "none";
      srcInput.value =
        selection.node.attrs.originalUrl ?? selection.node.attrs.src ?? "";
    } else if (panels.embed) {
      panels.embed.style.display = "none";
    }
  };

  const commit = () => {
    if (!editor.isActive("embed")) return;
    const urlRaw = srcInput.value.trim();
    const parsed = urlRaw ? parseEmbedUrl(urlRaw) : null;
    if (parsed) {
      editor
        .chain()
        .focus()
        .updateAttributes("embed", {
          src: parsed.embedUrl,
          provider: parsed.provider,
          originalUrl: urlRaw,
        })
        .run();
    }
  };

  editor.on("selectionUpdate", syncFromSelection);
  srcInput.addEventListener("change", commit);
  srcInput.addEventListener("blur", commit);
  srcInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      srcInput.blur();
    }
  });

  return function detach() {
    editor.off("selectionUpdate", syncFromSelection);
    srcInput.removeEventListener("change", commit);
    srcInput.removeEventListener("blur", commit);
  };
}

/**
 * Binds the link URL/label panel to the editor: shows when selection is in a
 * link, syncs inputs with the link href and text, and updates the link on commit.
 */
export function attachLinkEditMenu(
  editor: Editor,
  menuElement: HTMLElement,
): () => void {
  const urlInput = menuElement.querySelector<HTMLInputElement>(
    'input[data-link-url]',
  );
  const labelInput = menuElement.querySelector<HTMLInputElement>(
    'input[data-link-label]',
  );
  const panels = getBubblePanels(menuElement);
  if (!urlInput || !labelInput) return () => {};

  /** Only extend to full link when we first show the panel (to read label); never on every cursor move. */
  let linkPanelWasVisible = false;

  const syncFromSelection = () => {
    if (!editor.isActive("link")) {
      if (panels.link) panels.link.style.display = "none";
      linkPanelWasVisible = false;
      return;
    }

    const wasVisible = linkPanelWasVisible;
    linkPanelWasVisible = true;

    if (panels.link) panels.link.style.display = "";
    if (panels.image) panels.image.style.display = "none";
    if (panels.embed) panels.embed.style.display = "none";

    const attrs = editor.getAttributes("link");
    urlInput.value = attrs.href ?? "";

    const { from, to } = editor.state.selection;
    if (from !== to) {
      labelInput.value = editor.state.doc.textBetween(from, to);
    } else if (!wasVisible) {
      // First time showing panel with a cursor in the link: extend once to read full label
      editor.chain().extendMarkRange("link").run();
    }
    // If wasVisible and cursor: do not extend — allows user to move cursor out of the link
  };

  const commit = () => {
    if (!editor.isActive("link")) return;
    const href = urlInput.value.trim();
    const label = labelInput.value.trim();
    if (!href) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").run();
    editor
      .chain()
      .focus()
      .deleteSelection()
      .insertContent({
        type: "text",
        text: label || href,
        marks: [{ type: "link", attrs: { href } }],
      })
      .run();
  };

  editor.on("selectionUpdate", syncFromSelection);
  urlInput.addEventListener("change", commit);
  urlInput.addEventListener("blur", commit);
  labelInput.addEventListener("change", commit);
  labelInput.addEventListener("blur", commit);
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  };
  urlInput.addEventListener("keydown", handleKeydown);
  labelInput.addEventListener("keydown", handleKeydown);

  return function detach() {
    editor.off("selectionUpdate", syncFromSelection);
    urlInput.removeEventListener("change", commit);
    urlInput.removeEventListener("blur", commit);
    labelInput.removeEventListener("change", commit);
    labelInput.removeEventListener("blur", commit);
    urlInput.removeEventListener("keydown", handleKeydown);
    labelInput.removeEventListener("keydown", handleKeydown);
  };
}

export function attachMarkdownOutput(
  editor: Editor,
  element: HTMLElement,
): () => void {
  const updateMarkdownOutput = () => {
    if (element) {
      element.textContent = cleanupMarkdownOutput(editor.getMarkdown());
    }
  };

  editor.on("update", updateMarkdownOutput);
  updateMarkdownOutput();

  return function detachMarkdownOutput() {
    editor.off("update", updateMarkdownOutput);
    if (element) {
      element.textContent = "";
    }
  };
}
