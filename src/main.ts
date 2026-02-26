import "./content.css";
import exampleMd from "./data/example.md?raw";
import {
  attachEmbedEditMenu,
  attachImageAltMenu,
  attachLinkEditMenu,
  attachMarkdownOutput,
  initEditor,
} from "./editor";
import { parseEmbedUrl } from "./embed";

const editorEl = document.querySelector(".element") as HTMLElement;
const bubbleMenuEl = document.querySelector("#bubble-menu") as HTMLElement;

export const editor = initEditor({
  element: editorEl,
  content: exampleMd,
  bubbleMenuElement: bubbleMenuEl,
  // Pipe generic embed URLs through your backend; use {url} in the template.
  embedHandlerTemplate: "https://custom-handler.com/embed?url={url}",
});

attachMarkdownOutput(editor, document.querySelector("#markdown-output")!);
attachImageAltMenu(editor, bubbleMenuEl);
attachEmbedEditMenu(editor, bubbleMenuEl);
attachLinkEditMenu(editor, bubbleMenuEl);

const insertImageBtn = document.querySelector("#insert-image-btn");
if (insertImageBtn) {
  insertImageBtn.addEventListener("click", () => {
    const src = prompt("Image URL:");
    if (src == null || src.trim() === "") return;
    const alt = prompt("Alt text (optional):") ?? "";
    editor.chain().focus().setImage({ src: src.trim(), alt: alt.trim() }).run();
  });
}

const insertEmbedBtn = document.querySelector("#insert-embed-btn");
if (insertEmbedBtn) {
  insertEmbedBtn.addEventListener("click", () => {
    const raw = prompt(
      "Paste a link (YouTube, Vimeo, Twitter/X, or any embed URL):",
    );
    if (raw == null || raw.trim() === "") return;
    const parsed = parseEmbedUrl(raw);
    if (!parsed) {
      alert(
        "Could not recognize an embed URL. Try a full YouTube, Vimeo, or Twitter link.",
      );
      return;
    }
    editor
      .chain()
      .focus()
      .setEmbed({
        src: parsed.embedUrl,
        provider: parsed.provider,
        originalUrl: raw.trim(),
      })
      .run();
  });
}

const linkBtn = document.querySelector("#link-btn");
if (linkBtn) {
  linkBtn.addEventListener("click", () => {
    const { from, to } = editor.state.selection;
    const hasSelection = from !== to;

    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }

    const url = prompt("Link URL:");
    if (url == null || url.trim() === "") return;

    if (hasSelection) {
      editor.chain().focus().setLink({ href: url.trim() }).run();
    } else {
      const text = prompt("Link text (optional):")?.trim() || url.trim();
      editor
        .chain()
        .focus()
        .insertContent({
          type: "text",
          text,
          marks: [{ type: "link", attrs: { href: url.trim() } }],
        })
        .run();
    }
  });
}
