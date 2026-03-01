import type { ResolvedPos } from "@tiptap/pm/model";
import { Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

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
          handlePaste(view, event) {
            const clipboardData = event.clipboardData;
            console.log({'!clipboardData': !clipboardData});
            if (!clipboardData) return false;
            let text =
              clipboardData.getData("text/plain")?.trim() ?? "";
            // When pasting from some apps (e.g. SoundCloud share), the URL may only be in text/html
            console.log({ '!text || text.indexOf("\n")': !text || text.indexOf("\n") >= 0 || /\s/.test(text) })
            if (!text || text.indexOf("\n") >= 0 || /\s/.test(text)) {
              const html = clipboardData.getData("text/html")?.trim() ?? "";
              const urlFromHtml = extractUrlFromHtml(html);
              if (urlFromHtml) text = urlFromHtml;
            }
            console.log({ '!text': !text });
            if (!text) return false;
            // Extract URL: at start of text, or anywhere in text (e.g. "Title\nhttps://..." from SoundCloud share)
            let urlToEmbed =
              extractUrlFromPastedText(text) ?? extractUrlAnywhereInText(text);
            if (!urlToEmbed) urlToEmbed = text.indexOf("\n") < 0 && !/\s/.test(text) ? text : "";
            console.log({ space: /\s/.test(urlToEmbed) });
            if (/\s/.test(urlToEmbed)) return false;
            const parsed = parseEmbedUrl(urlToEmbed);
            console.log({ parsed })
            if (!parsed) return false;
            const { state } = view;
            const pos = state.selection.from;
            const $pos = state.doc.resolve(pos);
            const parent = $pos.parent;
            const isEmptyLine =
              parent.content.size === 0 || parent.textContent.trim() === "";
            console.log({ isEmptyLine });
            if (!isEmptyLine) return false;
            // Only embed on empty first-level lines; skip when inside blockquote/list
            if (isInsideNestedBlock($pos)) return false;
            // Replace the empty paragraph with the embed only (no extra line break)
            const from = $pos.before();
            const to = $pos.after();
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
