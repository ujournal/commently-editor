import type { ResolvedPos } from "@tiptap/pm/model";
import { Node } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";

const NESTED_BLOCK_NAMES = [
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
];

/** True when position is inside blockquote, list, or list item (not first-level). */
function isInsideNestedBlock($pos: ResolvedPos): boolean {
  for (let d = 1; d <= $pos.depth; d++) {
    if (NESTED_BLOCK_NAMES.indexOf($pos.node(d).type.name) >= 0) return true;
  }
  return false;
}

export function addListenerForAdjustIframeSize() {
  window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "commently-discover-resize" && typeof event.data.height === "number") {
      // event.source is the window that sent the message (iframe's contentWindow)
      const sourceWindow = event.source as Window | null;
      if (sourceWindow && sourceWindow !== window) {
        const iframes = document.querySelectorAll("iframe.embed-iframe");
        for (const iframe of iframes) {
          if (iframe.contentWindow === sourceWindow) {
            const height = event.data.height + "px";
            const parent = iframe.parentElement;
            if (parent) {
              parent.style.setProperty("--embed-height", height);
            }
            iframe.style.height = height;
            break;
          }
        }
      }
    }
  });
}

export type EmbedProvider = "generic";

export interface EmbedUrlResult {
  embedUrl: string;
  provider: EmbedProvider;
}

/**
 * Matches a single http(s) URL including path and query string (e.g. SoundCloud links with ?si=...&utm_*).
 * Used to extract or validate pasted URL before parsing.
 */
const URL_PATTERN = /^https?:\/\/[^\s]+$/;

/** Extract a single http(s) URL from pasted text (tolerates leading/trailing junk or invisible chars). Prefers URL at start. */
function extractUrlFromPastedText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(https?:\/\/[^\s]+)/);
  return match ? match[1] : null;
}

/** Extract the first http(s) URL found anywhere in the string (e.g. second line of "Title\nhttps://..."). */
function extractUrlAnywhereInText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(https?:\/\/[^\s]+)/);
  return match ? match[1] : null;
}

/**
 * Returns embed result for any valid http(s) URL. Used when pasting a URL on an empty line.
 * No special handling for YouTube, Vimeo, or social sites—all URLs are treated as generic embeds.
 */
export function parseEmbedUrl(input: string): EmbedUrlResult | null {
  const raw = input.trim();
  if (!raw) return null;
  // Ensure the string looks like a single URL (handles query params, long paths, etc.)
  if (!URL_PATTERN.test(raw)) return null;

  try {
    const url = new URL(raw.indexOf("http") === 0 ? raw : `https://${raw}`);
    if (url.protocol === "https:" || url.protocol === "http:")
      return { embedUrl: url.href, provider: "generic" };
  } catch {
    // invalid URL
  }
  return null;
}

/** Placeholder in customEmbedHandler for the encoded embed URL. */
export const EMBED_HANDLER_URL_PLACEHOLDER = "{url}";

/** Extract the first http(s) URL from pasted HTML (e.g. when clipboard has link only in text/html). */
function extractUrlFromHtml(html: string): string | null {
  if (!html.trim()) return null;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const link = doc.querySelector("a[href^='http://'], a[href^='https://']");
    const href = link?.getAttribute("href");
    return href?.trim() ?? null;
  } catch {
    return null;
  }
}

export interface EmbedOptions {
  HTMLAttributes?: Record<string, string>;
  /**
   * URL template for generic embeds. The original URL is substituted where
   * `{url}` appears, as encodeURIComponent(originalUrl).
   * Example: "https://custom-handler.com/embed?url={url}"
   * When not set, generic embeds use the stored URL as the iframe src.
   */
  customEmbedHandler?: string | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    embed: {
      setEmbed: (attrs: {
        src: string;
        provider?: EmbedProvider;
        /** Human-facing URL for markdown output (e.g. x.com/.../status/id). */
        originalUrl?: string | null;
      }) => ReturnType;
    };
  }
}

export const Embed = Node.create<EmbedOptions>({
  name: "embed",

  /** Run before StarterKit/default paste so URL paste → embed is handled first (e.g. SoundCloud with text/html). */
  priority: 1000,

  group: "block",
  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      customEmbedHandler: null as string | null | undefined,
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-embed-src"),
        renderHTML: (attrs) =>
          attrs.src ? { "data-embed-src": attrs.src } : {},
      },
      provider: {
        default: "generic",
        parseHTML: (el) =>
          (el.getAttribute("data-embed-provider") as EmbedProvider) || "generic",
        renderHTML: (attrs) =>
          attrs.provider
            ? { "data-embed-provider": String(attrs.provider) }
            : {},
      },
      originalUrl: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-embed-original-url"),
        renderHTML: (attrs) =>
          attrs.originalUrl
            ? { "data-embed-original-url": attrs.originalUrl }
            : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-node-type="embed"]',
      },
      {
        tag: "div.embed-wrapper",
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    let src = node.attrs.src;
    const provider = node.attrs.provider || "generic";
    const handler = this.options.customEmbedHandler;
    if (provider === "generic" && handler && typeof handler === "string" && src) {
      const encoded = encodeURIComponent(src);
      src = handler.split(EMBED_HANDLER_URL_PLACEHOLDER).join(encoded);
    }
    const merged = { ...this.options.HTMLAttributes, ...HTMLAttributes };
    merged["data-node-type"] = "embed";
    merged["data-embed-src"] = node.attrs.src;
    merged["data-embed-provider"] = provider;
    if (node.attrs.originalUrl)
      merged["data-embed-original-url"] = node.attrs.originalUrl;
    merged["class"] = [
      "embed-wrapper",
      `embed-provider-${provider}`,
      (merged["class"] || "").trim(),
    ]
      .filter(Boolean)
      .join(" ");
    return ["div", merged, ["iframe", { src, class: "embed-iframe", title: "Embed" }]];
  },

  renderMarkdown(node) {
    return node.attrs?.originalUrl ?? node.attrs?.src ?? "";
  },

  addCommands() {
    return {
      setEmbed:
        (attrs: {
          src: string;
          provider?: EmbedProvider;
          originalUrl?: string | null;
        }) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              src: attrs.src,
              provider: attrs.provider ?? "generic",
              originalUrl: attrs.originalUrl ?? attrs.src,
            },
          });
        },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const nodeType = this.type;
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (event.key !== "Enter") return false;
            const { state } = view;
            const { selection } = state;
            const { $from } = selection;
            // At doc start (pos 0): insert new paragraph so Enter creates a new line
            if (selection.from === 0) {
              const paragraph = state.schema.nodes.paragraph.create();
              const tr = state.tr
                .insert(0, paragraph)
                .setSelection(TextSelection.near(tr.doc.resolve(1)));
              view.dispatch(tr);
              editor.commands.focus();
              return true;
            }
            if (isInsideNestedBlock($from)) return false;
            const parent = $from.parent;
            const text = parent.textContent.trim();
            if (!text) return false;
            const parsed = parseEmbedUrl(text);
            if (!parsed) return false;
            // Paragraph is only a URL: replace with embed and new paragraph
            const from = $from.before($from.depth);
            const to = $from.after($from.depth);
            const embedNode = nodeType.create({
              src: parsed.embedUrl,
              provider: parsed.provider,
              originalUrl: text,
            });
            const tr = state.tr
              .replaceWith(from, to, embedNode)
              .insert(from + 1, state.schema.nodes.paragraph.create());
            view.dispatch(tr);
            editor.commands.focus();
            editor.commands.setTextSelection(from + 2);
            return true;
          },
          handlePaste(view, event) {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;
            let text =
              clipboardData.getData("text/plain")?.trim() ?? "";
            // When pasting from some apps (e.g. SoundCloud share), the URL may only be in text/html
            if (!text || text.indexOf("\n") >= 0 || /\s/.test(text)) {
              const html = clipboardData.getData("text/html")?.trim() ?? "";
              const urlFromHtml = extractUrlFromHtml(html);
              if (urlFromHtml) text = urlFromHtml;
            }
            if (!text) return false;
            // Extract URL: at start of text, or anywhere in text (e.g. "Title\nhttps://..." from SoundCloud share)
            let urlToEmbed =
              extractUrlFromPastedText(text) ?? extractUrlAnywhereInText(text);
            if (!urlToEmbed) urlToEmbed = text.indexOf("\n") < 0 && !/\s/.test(text) ? text : "";
            if (/\s/.test(urlToEmbed)) return false;
            const parsed = parseEmbedUrl(urlToEmbed);
            if (!parsed) return false;
            const { state } = view;
            const { from: selFrom, to: selTo } = state.selection;
            const $from = state.doc.resolve(selFrom);
            const $to = state.doc.resolve(selTo);
            // Only embed on first-level blocks; skip when inside blockquote/list
            if (isInsideNestedBlock($from) || isInsideNestedBlock($to))
              return false;
            // When cursor is at doc start (depth 0), use full doc content range
            const from =
              $from.depth === 0 ? 0 : $from.before($from.depth);
            const to =
              $to.depth === 0 ? state.doc.content.size : $to.after($to.depth);
            // Only replace with embed when the selected range has no meaningful content (empty blocks only)
            const slice = state.doc.slice(from, to);
            let hasMeaningfulContent = false;
            slice.content.forEach((node) => {
              if (node.isText && node.text?.trim()) hasMeaningfulContent = true;
              else if (node.content.size > 0) hasMeaningfulContent = true;
            });
            if (hasMeaningfulContent) return false;
            // Replace the full selected block range with the embed
            const embedNode = nodeType.create({
              src: parsed.embedUrl,
              provider: parsed.provider,
              originalUrl: urlToEmbed,
            });
            const tr = state.tr.replaceWith(from, to, embedNode);
            view.dispatch(tr);
            editor.commands.focus();
            return true;
          },
        },
      }),
    ];
  },
});
