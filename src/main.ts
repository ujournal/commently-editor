import "./content.css";
import exampleMd from "./data/example.md?raw";
import {
  attachEmbedEditMenu,
  attachImageAltMenu,
  attachMarkdownOutput,
  initEditor,
} from "./editor";
import { addListenerForAdjustIframeSize, parseEmbedUrl } from "./embed";
import { insertImageWithThumbhashUpload } from "./editor";

const editorEl = document.querySelector(".element") as HTMLElement;
const bubbleMenuEl = document.querySelector("#bubble-menu") as HTMLElement;

export const editor = initEditor({
  element: editorEl,
  content: exampleMd,
  bubbleMenuElement: bubbleMenuEl,
  // Pipe generic embed URLs through your backend. Use {base64_url} (path) or {url} (query).
  embedHandlerTemplate: "https://discover.commently.top/{base64_url}",
});

attachMarkdownOutput(editor, document.querySelector("#markdown-output")!);
attachImageAltMenu(editor, bubbleMenuEl);
attachEmbedEditMenu(editor, bubbleMenuEl);
addListenerForAdjustIframeSize();

const insertImageBtn = document.querySelector<HTMLButtonElement>(
  "#insert-image-btn",
);
if (insertImageBtn) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  const setUploading = (isUploading: boolean) => {
    insertImageBtn.disabled = isUploading;
    insertImageBtn.textContent = isUploading ? "Uploading..." : "Image";
  };

  insertImageBtn.addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click(); // native "select image from disk" picker
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    setUploading(true);
    insertImageWithThumbhashUpload(editor, file, "", {
      onSettled: () => setUploading(false),
    });
  });
}

const insertEmbedBtn = document.querySelector("#insert-embed-btn");
if (insertEmbedBtn) {
  insertEmbedBtn.addEventListener("click", () => {
    const raw = prompt("Paste a link (any URL will be embedded):");
    if (raw == null || raw.trim() === "") return;
    const parsed = parseEmbedUrl(raw);
    if (!parsed) {
      alert("Could not recognize a valid URL.");
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

// Link editing is disabled.
