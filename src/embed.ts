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

export type EmbedProvider = "youtube" | "vimeo" | "twitter" | "generic";

export interface EmbedUrlResult {
  embedUrl: string;
  provider: EmbedProvider;
}

/**
 * Normalizes shared URLs to their embed form (iframe-friendly).
 * Returns null if the URL is not supported.
 */
export function parseEmbedUrl(input: string): EmbedUrlResult | null {
  const raw = input.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw.indexOf("http") === 0 ? raw : `https://${raw}`);

    // YouTube: watch, shorts, embed
    if (
      /^(www\.)?youtube\.com$/.test(url.hostname) ||
      url.hostname === "youtu.be"
    ) {
      let videoId: string | null = null;
      if (url.hostname === "youtu.be") {
        videoId = url.pathname.slice(1).split("/")[0] || null;
      } else {
        videoId =
          url.searchParams.get("v") ||
          (url.pathname.indexOf("/shorts/") === 0
            ? url.pathname.replace(/^\/shorts\//, "").split("/")[0]
            : null);
      }
      if (videoId)
        return {
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
          provider: "youtube",
        };
    }

    // Vimeo
    if (/^(www\.)?vimeo\.com$/.test(url.hostname)) {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      if (id && /^\d+$/.test(id))
        return {
          embedUrl: `https://player.vimeo.com/video/${id}`,
          provider: "vimeo",
        };
    }

    // Twitter/X: extract status id for embed URL
    if (
      (url.hostname === "twitter.com" || url.hostname === "x.com") &&
      /^\/\w+\/status\/\d+/.test(url.pathname)
    ) {
      const match = url.pathname.match(/\/status\/(\d+)/);
      if (match)
        return {
          embedUrl: `https://platform.twitter.com/embed/tweet.html?id=${match[1]}`,
          provider: "twitter",
        };
    }

    // Any other https/http URL as generic embed (e.g. other sites, articles)
    if (url.protocol === "https:" || url.protocol === "http:")
      return { embedUrl: url.href, provider: "generic" };
  } catch {
    // invalid URL
  }
  return null;
}

/** Placeholder in customEmbedHandler for the encoded embed URL. */
export const EMBED_HANDLER_URL_PLACEHOLDER = "{url}";

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
            const text =
              event.clipboardData?.getData?.("text/plain")?.trim?.() ?? "";
            if (!text || text.indexOf("\n") >= 0) return false;
            // Only treat as embed when the pasted content is solely a URL (empty line + nothing but URL)
            if (/\s/.test(text)) return false;
            const parsed = parseEmbedUrl(text);
            if (!parsed) return false;
            const { state } = view;
            const pos = state.selection.from;
            const $pos = state.doc.resolve(pos);
            const parent = $pos.parent;
            const isEmptyLine =
              parent.content.size === 0 || parent.textContent.trim() === "";
            if (!isEmptyLine) return false;
            // Only embed on empty first-level lines; skip when inside blockquote/list
            if (isInsideNestedBlock($pos)) return false;
            editor
              .chain()
              .focus()
              .insertContentAt(pos, {
                type: nodeType.name,
                attrs: {
                  src: parsed.embedUrl,
                  provider: parsed.provider,
                  originalUrl: text,
                },
              })
              .run();
            return true;
          },
        },
      }),
    ];
  },
});
