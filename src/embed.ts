import { Node } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";

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
    if (
      event.data &&
      event.data.type === "commently-discover-resize" &&
      typeof event.data.height === "number"
    ) {
      // event.source is the window that sent the message (iframe's contentWindow)
      const sourceWindow = event.source as Window | null;
      if (sourceWindow && sourceWindow !== window) {
        const iframes = document.querySelectorAll(
          "iframe.embed-iframe",
        );
        for (let i = 0; i < iframes.length; i++) {
          const iframe = iframes[i] as HTMLIFrameElement;
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

/** Placeholder in customEmbedHandler for the encoded embed URL (query/form style). */
export const EMBED_HANDLER_URL_PLACEHOLDER = "{url}";
/** Placeholder for the embed URL as URL-safe base64 (path segment). */
export const EMBED_HANDLER_BASE64_PLACEHOLDER = "{base64_url}";

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
   * URL template for generic embeds. Placeholders:
   * - `{url}`: embed URL as encodeURIComponent (query/form style).
   * - `{base64_url}`: embed URL as URL-safe base64 (path segment).
   * Example: "https://discover.commently.top/{base64_url}" or "https://handler.com/?url={url}"
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
          (el.getAttribute("data-embed-provider") as EmbedProvider) ||
          "generic",
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
    if (
      provider === "generic" &&
      handler &&
      typeof handler === "string" &&
      src
    ) {
      const encoded = encodeURIComponent(src);
      const base64Url = btoa(encodeURIComponent(src))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      src = handler
        .split(EMBED_HANDLER_URL_PLACEHOLDER)
        .join(encoded)
        .split(EMBED_HANDLER_BASE64_PLACEHOLDER)
        .join(base64Url);
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
    return [
      "div",
      merged,
      ["iframe", { src, class: "embed-iframe", title: "Embed" }],
    ];
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
              const tr0 = state.tr.insert(0, paragraph);
              const tr = tr0.setSelection(
                TextSelection.near(tr0.doc.resolve(1)),
              );
              view.dispatch(tr);
              editor.commands.focus();
              return true;
            }
            // When embed is selected, Enter inserts a paragraph after it and moves cursor there
            if (
              selection instanceof NodeSelection &&
              selection.node.type === nodeType
            ) {
              const afterEmbed = selection.to;
              const tr0 = state.tr.insert(
                afterEmbed,
                state.schema.nodes.paragraph.create(),
              );
              const tr = tr0.setSelection(
                TextSelection.near(tr0.doc.resolve(afterEmbed + 1)),
              );
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
            const text = clipboardData.getData("text/plain")?.trim() ?? "";
            const html = clipboardData.getData("text/html")?.trim() ?? "";

            // We only intercept when we can extract a valid http(s) URL.
            // Plain-text paste: detect anywhere in the string.
            // HTML paste: detect from the first <a href="...http(s)...">.
            const urlFromText =
              extractUrlFromPastedText(text) ?? extractUrlAnywhereInText(text);
            const urlFromHtml = html ? extractUrlFromHtml(html) : null;
            const urlToEmbed = urlFromText ?? urlFromHtml;
            if (!urlToEmbed) return false;
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

            // Case 1: cursor (or selection) is within the same textblock.
            // Replace that textblock with: [leftText, embed, rightText]
            // so embeds land on their own newline even when the line already has text.
            if ($from.sameParent($to) && $from.parent.isTextblock) {
              const parent = $from.parent;
              const from = $from.before($from.depth);
              const to = $from.after($from.depth);
              const startOffset = $from.parentOffset;
              const endOffset = $to.parentOffset;

              const embedNode = nodeType.create({
                src: parsed.embedUrl,
                provider: parsed.provider,
                originalUrl: urlToEmbed,
              });

              const fullBlockSelected =
                startOffset === 0 && endOffset === parent.content.size;

              if (fullBlockSelected) {
                const tr = state.tr.replaceWith(from, to, embedNode);
                view.dispatch(tr);
                editor.commands.focus();
                return true;
              }

              const leftFragment = parent.content.cut(0, startOffset);
              const rightFragment = parent.content.cut(
                endOffset,
                parent.content.size,
              );

              const leftBlock = parent.type.create(parent.attrs, leftFragment);
              const rightBlock = parent.type.create(parent.attrs, rightFragment);

              // If the cursor is at the very start, avoid inserting an extra
              // leading empty textblock before the embed.
              const includeLeftBlock = leftFragment.size > 0;

              const replacementNodes = [
                ...(includeLeftBlock ? [leftBlock] : []),
                embedNode,
                rightBlock,
              ];

              const tr = state.tr.replaceRange(
                from,
                to,
                new Slice(Fragment.fromArray(replacementNodes), 0, 0),
              );

              // Place cursor at the start of the right-hand text (after the embed).
              const rightContentPos =
                includeLeftBlock
                  ? from + leftBlock.nodeSize + embedNode.nodeSize + 1
                  : from + embedNode.nodeSize + 1;
              const resolved = tr.doc.resolve(
                Math.min(rightContentPos, tr.doc.content.size),
              );
              tr.setSelection(TextSelection.near(resolved));

              view.dispatch(tr);
              editor.commands.focus();
              return true;
            }

            // Case 2: fallback (doc-start / block-boundary paste). Keep the previous
            // safety check so we don't delete unrelated content.
            const from = $from.depth === 0 ? 0 : $from.before($from.depth);
            const to =
              $to.depth === 0 ? state.doc.content.size : $to.after($to.depth);
            const embedNode = nodeType.create({
              src: parsed.embedUrl,
              provider: parsed.provider,
              originalUrl: urlToEmbed,
            });

            const slice = state.doc.slice(from, to);
            let hasMeaningfulContent = false;
            slice.content.forEach((node) => {
              if (node.isText && node.text?.trim()) hasMeaningfulContent = true;
              else if (node.content.size > 0) hasMeaningfulContent = true;
            });
            if (hasMeaningfulContent) return false;

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
