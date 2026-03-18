import { Editor, Extension } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/extension-bubble-menu";
import Image from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Embed, parseEmbedUrl } from "./embed";
import { uploadImageFileToUrl } from "./imageUpload";
import {
  cleanupMarkdownOutput,
  rewriteMarkdownImageSrcsWithDims,
} from "./utils/string";

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

function getMeasuredImageDims(
  img: HTMLImageElement | null,
): { width: number | null; height: number | null } {
  if (!img) return { width: null, height: null };

  const naturalW = typeof img.naturalWidth === "number" ? img.naturalWidth : 0;
  const naturalH = typeof img.naturalHeight === "number" ? img.naturalHeight : 0;

  let w = naturalW;
  let h = naturalH;

  // Fallback to rendered size if the image isn't loaded yet.
  if (w <= 0 || h <= 0) {
    const rect = img.getBoundingClientRect();
    w = Math.round(rect.width);
    h = Math.round(rect.height);
  }

  // Final fallback: parse w/h from the URL query string (if already present).
  if (w <= 0 || h <= 0) {
    const rawSrc = img.currentSrc || img.src || "";
    try {
      const url = new URL(rawSrc, window.location.href);
      const wParam = url.searchParams.get("w");
      const hParam = url.searchParams.get("h");
      const parsedW = wParam ? Number(wParam) : NaN;
      const parsedH = hParam ? Number(hParam) : NaN;
      if (typeof parsedW === "number" && isFinite(parsedW) && parsedW > 0)
        w = Math.round(parsedW);
      if (typeof parsedH === "number" && isFinite(parsedH) && parsedH > 0)
        h = Math.round(parsedH);
    } catch {
      // ignore invalid URL
    }
  }

  if (w <= 0 || h <= 0) return { width: null, height: null };
  return { width: w, height: h };
}

function normalizeHeadingLevelsInContent(
  node: JSONContent,
  allowedLevels: number[],
): void {
  if (
    node.type === "heading" &&
    node.attrs &&
    typeof node.attrs.level === "number"
  ) {
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
function normalizeDocHeadingLevels(
  editor: Editor,
  allowedLevels: number[],
): void {
  const minLevel = allowedLevels.length > 0 ? Math.min(...allowedLevels) : 1;
  const updates: { pos: number; attrs: Record<string, unknown> }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (
      node.type.name === "heading" &&
      typeof node.attrs.level === "number" &&
      node.attrs.level < minLevel
    ) {
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
              const content = slice.content.content.map((node) =>
                node.toJSON(),
              );
              const docJson = { type: "doc", content };
              let markdown = editor.markdown.serialize(docJson);

              // Replace image URLs with resized versions using measured dims.
              // We align image order with ProseMirror doc traversal order.
              const imageDims: Array<{
                width: number | null;
                height: number | null;
              }> = [];
              state.doc.nodesBetween(from, to, (node, pos) => {
                if (node.type.name !== "image") return;
                const dom = editor.view.nodeDOM(pos) as HTMLImageElement | null;
                imageDims.push(getMeasuredImageDims(dom));
              });

              markdown = rewriteMarkdownImageSrcsWithDims(
                markdown,
                imageDims,
              );
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

/** Intercepts clipboard image pastes, uploads the image, then inserts `image`. */
const PasteImageUpload = Extension.create({
  name: "pasteImageUpload",

  addProseMirrorPlugins() {
    const editor = this.editor;

    const getFirstImageFile = (
      clipboardData: DataTransfer,
    ): File | null => {
      const items = clipboardData.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = (items as unknown as Record<number, DataTransferItem>)[i];
          if (!item) continue;
          if (
            item.kind === "file" &&
            typeof item.type === "string" &&
            item.type.indexOf("image/") === 0
          ) {
            const file = item.getAsFile();
            if (file) return file;
          }
        }
      }

      // Some browsers may expose clipboard images via `files`.
      const files = (clipboardData as unknown as { files?: FileList }).files;
      if (files && files.length > 0) return files[0];

      return null;
    };

    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;

            const extractAltFromClipboard = (): string => {
              const html = clipboardData.getData("text/html") ?? "";
              if (!html) return "";

              try {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, "text/html");
                const imgs = doc.getElementsByTagName("img");
                for (let i = 0; i < imgs.length; i++) {
                  const alt = imgs[i].getAttribute("alt");
                  if (alt && alt.trim()) return alt.trim();
                }
              } catch {
                // ignore parsing errors
              }
              return "";
            };

            const file = getFirstImageFile(clipboardData);
            if (!file) return false;

            const alt = extractAltFromClipboard();

            // Upload asynchronously, then insert.
            event.preventDefault();

            uploadImageFileToUrl(file)
              .then((url) => {
                editor
                  .chain()
                  .focus()
                  .setImage({ src: url, alt })
                  .run();
              })
              .catch((err) => {
                console.error(err);
                alert("Image upload failed. Please try again.");
              });

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
   * URL template for generic embeds. Use {base64_url} (path) or {url} (query).
   * Example: "https://discover.commently.top/{base64_url}" or "https://handler.com/?url={url}"
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
  const headingLevels = markdownPasteHeadingLevels ?? [
    ...DEFAULT_MARKDOWN_PASTE_HEADING_LEVELS,
  ];
  const extensions = [
    // Embed uses priority: 1000 so its handlePaste runs before other plugins and can turn pasted URLs into embeds
    // (otherwise default/StarterKit paste consumes the event when clipboard has text/html, e.g. SoundCloud).
    Embed.configure({
      customEmbedHandler: embedHandlerTemplate ?? null,
    }),
    Placeholder.configure({
      placeholder: "Write something…",
      showOnlyCurrent: false,
    }),
    StarterKit.configure({
      heading: {
        levels: headingLevels as (1 | 2 | 3 | 4 | 5 | 6)[],
      },
      // Link editing is intentionally disabled. We still embed pasted URLs
      // via the custom `Embed` extension.
      link: false,
    }),
    Image,
    Markdown,
    MarkdownCopy,
    PasteImageUpload,
    MarkdownPaste.configure({ headingLevels }),
    ...(bubbleMenuElement
      ? [
          BubbleMenu.configure({
            element: bubbleMenuElement,
            shouldShow: ({ state, editor }) => {
              const { selection } = state;
              const doc = state.doc;
              // Never show at doc start when there's no real content (avoids "Embed URL" popup
              // when cursor at 0 or when only node is an embed at 0).
              if (selection.from <= 1) {
                if (doc.childCount === 1 && doc.firstChild?.content.size === 0)
                  return false;
                if (
                  doc.childCount === 2 &&
                  ["embed", "image"].indexOf(
                    doc.firstChild?.type.name ?? "",
                  ) !== -1 &&
                  doc.child(1)?.content.size === 0
                )
                  return false;
              }
              if (selection instanceof NodeSelection) {
                const name = selection.node.type.name;
                if (name === "image") return true;
                if (name === "embed") {
                  const url =
                    selection.node.attrs.src ??
                    selection.node.attrs.originalUrl;
                  return Boolean(url?.trim());
                }
                return false;
              }
              return false;
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
      attributes: {
        class: "tiptap",
      },
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
  // Sync empty state to wrapper so placeholder CSS can target it
  const placeholderText = "Write something…";
  if (!element.getAttribute("data-placeholder")) {
    element.setAttribute("data-placeholder", placeholderText);
  }
  const isEmpty = () => editor.state.doc.textContent.trim().length === 0;
  const syncEmptyClass = () => {
    element.classList.toggle("is-editor-empty", isEmpty());
  };
  editor.on("update", syncEmptyClass);
  editor.on("selectionUpdate", syncEmptyClass);
  syncEmptyClass();
  // Initial markdown is parsed by @tiptap/markdown and can produce h1; schema only allows headingLevels (e.g. 2–6). Normalize so markdown output matches.
  normalizeDocHeadingLevels(editor, headingLevels);
  return editor;
}

function getBubblePanels(menuElement: HTMLElement) {
  return {
    image: menuElement.querySelector<HTMLElement>(
      '[data-bubble-panel="image"]',
    ),
    embed: menuElement.querySelector<HTMLElement>(
      '[data-bubble-panel="embed"]',
    ),
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
    "input[data-image-alt]",
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
    "input[data-embed-src]",
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
  _editor: Editor,
  _menuElement: HTMLElement,
): () => void {
  // Link editing is disabled (we only support converting pasted URLs to `embed` nodes).
  return () => {};
}

const MARKDOWN_OUTPUT_PLACEHOLDER = "No content yet";

export function attachMarkdownOutput(
  editor: Editor,
  element: HTMLElement,
): () => void {
  const editorRoot = editor.view.dom as HTMLElement;

  let rafId: number | null = null;
  const scheduleUpdate = () => {
    if (rafId != null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      updateMarkdownOutput();
    });
  };

  const shouldRemoveBrokenImage = (img: HTMLImageElement) => {
    // Remove images that can't be loaded (either via `error` event or
    // `complete` but missing dimensions). This prevents broken images from
    // persisting in the editor/markdown output.
    return true;
  };

  const knownImgs: HTMLImageElement[] = [];

  const removeBrokenImageFromDoc = (img: HTMLImageElement) => {
    // Find the matching `image` node by DOM identity.
    let found:
      | {
          pos: number;
          nodeSize: number;
        }
      | null = null;

    editor.state.doc.descendants((node, pos) => {
      if (found) return;
      if (node.type.name !== "image") return;
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
      if (!dom) return;
      if (dom === img) {
        found = { pos, nodeSize: node.nodeSize };
        return;
      }
      const innerImg = dom.querySelector("img");
      if (innerImg === img) {
        found = { pos, nodeSize: node.nodeSize };
      }
    });

    if (!found) return false;

    // Remove event listeners + remove from our "known" set, to avoid leaks.
    const knownIdx = knownImgs.indexOf(img);
    if (knownIdx !== -1) knownImgs.splice(knownIdx, 1);
    img.removeEventListener("load", onImageLoadOrError);
    img.removeEventListener("error", onImageLoadOrError);

    const tr = editor.state.tr.delete(found.pos, found.pos + found.nodeSize);
    editor.view.dispatch(tr);
    scheduleUpdate();
    return true;
  };

  const onImageLoadOrError = (event?: Event) => {
    const target = event?.target;
    if (!(target instanceof HTMLImageElement)) {
      scheduleUpdate();
      return;
    }

    // Remove broken pasted images.
    // - `error` event: image failed to load.
    // - `load` event but 0 natural dims: indicates an invalid/broken data URL.
    if (shouldRemoveBrokenImage(target)) {
      const naturalW = target.naturalWidth || 0;
      const naturalH = target.naturalHeight || 0;
      const isErrorEvent = event?.type === "error";
      const isLoadedButEmpty = event?.type === "load" && naturalW <= 0 && naturalH <= 0;
      if (isErrorEvent || isLoadedButEmpty) {
        removeBrokenImageFromDoc(target);
        return;
      }
    }

    scheduleUpdate();
  };

  const updateMarkdownOutput = () => {
    if (element) {
      const raw = editor.getMarkdown();

      // Measure images from the live DOM so `w`/`h` in markdown are real.
      const imageDims: Array<{
        width: number | null;
        height: number | null;
      }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "image") return;
        const dom = editor.view.nodeDOM(pos) as HTMLImageElement | null;
        imageDims.push(getMeasuredImageDims(dom));
      });

      const markdown = cleanupMarkdownOutput(
        rewriteMarkdownImageSrcsWithDims(raw, imageDims),
      );

      element.textContent = markdown || MARKDOWN_OUTPUT_PLACEHOLDER;
      element.classList.toggle("is-empty", !markdown);
    }

    // Ensure we re-render once images finish loading (dimensions may be 0
    // until `naturalWidth/Height` are available).
    const imgNodes = editorRoot.querySelectorAll("img");
    for (let i = 0; i < imgNodes.length; i++) {
      const img = imgNodes[i] as HTMLImageElement;
      if (knownImgs.indexOf(img) !== -1) continue;
      knownImgs.push(img);
      img.addEventListener("load", onImageLoadOrError);
      img.addEventListener("error", onImageLoadOrError);

      // If the image already completed but has no dimensions, treat it as broken.
      if (shouldRemoveBrokenImage(img) && img.complete) {
        const naturalW = img.naturalWidth || 0;
        const naturalH = img.naturalHeight || 0;
        if (naturalW <= 0 || naturalH <= 0) {
          removeBrokenImageFromDoc(img);
          continue;
        }
      }

      // If the image is already loaded, `load` won't fire again.
      // Schedule an update so we can use its natural dimensions.
      if (
        img.complete &&
        typeof img.naturalWidth === "number" &&
        typeof img.naturalHeight === "number" &&
        img.naturalWidth > 0 &&
        img.naturalHeight > 0
      ) {
        scheduleUpdate();
      }
    }
  };

  // Catch fast image failures: attach listeners as soon as new <img> nodes appear.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (let i = 0; i < mutation.addedNodes.length; i++) {
        const node = mutation.addedNodes[i];
        if (!(node instanceof HTMLElement)) continue;
        const imgs = node.tagName === "IMG" ? [node] : node.querySelectorAll("img");
        for (let j = 0; j < imgs.length; j++) {
          const img = imgs[j] as HTMLImageElement;
          if (knownImgs.indexOf(img) !== -1) continue;
          knownImgs.push(img);
          img.addEventListener("load", onImageLoadOrError);
          img.addEventListener("error", onImageLoadOrError);

          if (shouldRemoveBrokenImage(img) && img.complete) {
            const naturalW = img.naturalWidth || 0;
            const naturalH = img.naturalHeight || 0;
            if (naturalW <= 0 || naturalH <= 0) {
              removeBrokenImageFromDoc(img);
            }
          }
        }
      }
    }
  });

  observer.observe(editorRoot, { childList: true, subtree: true });

  editor.on("update", scheduleUpdate);
  editor.on("selectionUpdate", scheduleUpdate);
  updateMarkdownOutput();

  return function detachMarkdownOutput() {
    editor.off("update", scheduleUpdate);
    editor.off("selectionUpdate", scheduleUpdate);
    if (element) {
      element.textContent = "";
      element.classList.remove("is-empty");
    }
    observer.disconnect();
    for (let i = 0; i < knownImgs.length; i++) {
      const img = knownImgs[i] as HTMLImageElement;
      img.removeEventListener("load", onImageLoadOrError);
      img.removeEventListener("error", onImageLoadOrError);
    }
    knownImgs.length = 0;
    if (rafId != null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}
