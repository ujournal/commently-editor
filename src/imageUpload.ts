import imageCompression from "browser-image-compression";
import { rgbaToThumbHash, thumbHashToRGBA } from "thumbhash";

const UPLOAD_ENDPOINT = "https://uploads.commently.top/upload";

// NOTE: This is a sensitive credential. Prefer putting it in `VITE_IMAGE_UPLOAD_JWT`
// (and redeploy) rather than hardcoding.
const FALLBACK_JWT =
  "bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiMSIsInN1YiI6IjEiLCJpYXQiOjE3NzM4NzI0MTksImV4cCI6MTc3MzkwODQxOX0.tuWrGVWXuiWsyFnD2ojrdCGGa1OdVXtZmPTcx2oGzuY";

function getJwt(): string {
  return FALLBACK_JWT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function extractUrlFromUnknownResponse(
  payload: unknown,
  rawText: string,
): string | null {
  if (typeof payload === "string") {
    // Sometimes APIs respond with plain text (maybe a URL).
    const m = payload.match(/https?:\/\/[^\s"']+/);
    return m?.[0] ?? null;
  }

  if (isRecord(payload)) {
    const url =
      (payload as { url?: unknown }).url ??
      (payload as { data?: { url?: unknown } }).data?.url ??
      (payload as { result?: { url?: unknown } }).result?.url;
    if (typeof url === "string" && url.trim()) return url.trim();

    // Fallback: scan any string values for an URL.
    const visit = (obj: unknown): string | null => {
      if (typeof obj === "string") {
        const m = obj.match(/https?:\/\/[^\s"']+/);
        return m?.[0] ?? null;
      }
      if (!isRecord(obj) && !Array.isArray(obj)) return null;
      if (Array.isArray(obj)) {
        for (const v of obj) {
          const got = visit(v);
          if (got) return got;
        }
        return null;
      }
      for (const key in obj) {
        const got = visit((obj as Record<string, unknown>)[key]);
        if (got) return got;
      }
      return null;
    };

    return visit(payload);
  }

  const m = rawText.match(/https?:\/\/[^\s"']+/);
  return m?.[0] ?? null;
}

function readResponseBodyAsText(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

function tryUploadRaw(file: File, jwt: string): Promise<string | null> {
  const contentType = file.type || "application/octet-stream";
  return fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: jwt,
      "Content-Type": contentType,
    },
    body: file,
  })
    .then((res) => {
      if (!res.ok) return null;
      return readResponseBodyAsText(res).then((rawText) => {
        if (!rawText) return null;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          // ignore non-JSON
        }
        return extractUrlFromUnknownResponse(parsed, rawText);
      });
    })
    .catch(() => null);
}

function tryUploadMultipart(file: File, jwt: string): Promise<string | null> {
  const form = new FormData();
  form.append("file", file, file.name || "image");

  return fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: jwt,
    },
    body: form,
  })
    .then((res) => {
      if (!res.ok) return null;
      return readResponseBodyAsText(res).then((rawText) => {
        if (!rawText) return null;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          // ignore non-JSON
        }
        return extractUrlFromUnknownResponse(parsed, rawText);
      });
    })
    .catch(() => null);
}

function maybeCompressImageFile(file: File): Promise<File> {
  // Only compress images; other file types should be uploaded as-is.
  if (!file.type || file.type.indexOf("image/") !== 0) {
    // Avoid `Promise.resolve` to satisfy stricter TS lib settings.
    return {
      then: (onFulfilled: (value: File) => unknown) => onFulfilled(file),
    } as unknown as Promise<File>;
  }

  // Default heuristics: keep acceptable quality while drastically reducing
  // transfer size for typical photos from mobile cameras.
  return imageCompression(file, {
    maxSizeMB: 1,
    maxWidthOrHeight: 1600,
    initialQuality: 0.85,
    useWebWorker: true,
    // Ensure the result is a broadly supported format for most servers/CDNs.
    fileType: "image/jpeg",
  })
    .then((compressedBlob) => {
      // Ensure we return a File (not just a Blob) because multipart upload
      // attaches the filename.
      return new File([compressedBlob], file.name || "image", {
        type: compressedBlob.type || file.type,
      });
    })
    .catch((err) => {
      console.warn("Image compression failed; uploading original.", err);
      return file;
    });
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Convert to binary string, then btoa.
  // Thumbhashes are small, so this is fine performance-wise.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Encode(bytes: Uint8Array): string {
  return uint8ToBase64(bytes);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Renders ThumbHash to a blob: URL so <img> works under CSP that blocks data: images.
 */
function thumbhashBase64ToPlaceholderBlobUrl(thumbhashB64: string) {
  const NativePromise = (globalThis as unknown as { Promise?: unknown })
    .Promise as new <T>(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: unknown) => void,
    ) => void,
  ) => Promise<T>;

  const hash = base64ToUint8Array(thumbhashB64);
  const { w, h, rgba } = thumbHashToRGBA(hash);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return new NativePromise((_, reject) => {
      reject(new Error("Canvas 2D context not available."));
    });
  }
  const clamped = new Uint8ClampedArray(rgba.length);
  clamped.set(rgba);
  ctx.putImageData(new ImageData(clamped, w, h), 0, 0);

  return new NativePromise<{ url: string; revoke: () => void }>(
    (resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("ThumbHash preview encode failed."));
          return;
        }
        const url = URL.createObjectURL(blob);
        resolve({
          url,
          revoke: () => URL.revokeObjectURL(url),
        });
      }, "image/png");
    },
  );
}

function uploadCompressedWithThumbhash(
  compressedFile: File,
  jwt: string,
  thumbhashBase64: string,
): Promise<string> {
  return tryUploadRaw(compressedFile, jwt).then((rawUrl) => {
    if (rawUrl) return addThumbhashQueryParam(rawUrl, thumbhashBase64);

    return tryUploadMultipart(compressedFile, jwt).then((multipartUrl) => {
      if (!multipartUrl) {
        throw new Error(
          "Image upload failed: could not extract `url` from response.",
        );
      }
      return addThumbhashQueryParam(multipartUrl, thumbhashBase64);
    });
  });
}

function generateThumbhashForImageFile(file: File): Promise<string> {
  if (!file.type || file.type.indexOf("image/") !== 0) {
    throw new Error("Thumbhash generation requires an image/* file.");
  }

  // Thumbhash encoding is defined for <=100px dimensions.
  const MAX_DIM = 100;

  const objectUrl = URL.createObjectURL(file);
  const NativePromise = (globalThis as unknown as { Promise?: unknown })
    .Promise as unknown as
    | (new <T>(
        executor: (
          resolve: (value: T | PromiseLike<T>) => void,
          reject: (reason?: unknown) => void,
        ) => void,
      ) => Promise<T>)
    | undefined;

  // Keep behavior compatible with older TS lib targets by avoiding direct
  // `new Promise(...)` usage, and using `async/await`-free control flow.
  if (!NativePromise) {
    URL.revokeObjectURL(objectUrl);
    throw new Error("Promise constructor not available.");
  }

  return new NativePromise<string>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
    };

    img.onload = () => {
      try {
        const naturalW =
          typeof img.naturalWidth === "number" ? img.naturalWidth : 0;
        const naturalH =
          typeof img.naturalHeight === "number" ? img.naturalHeight : 0;
        if (!(naturalW > 0 && naturalH > 0)) {
          throw new Error("Decoded image has invalid dimensions.");
        }

        const scale = Math.min(MAX_DIM / naturalW, MAX_DIM / naturalH, 1);
        const w = Math.max(1, Math.round(naturalW * scale));
        const h = Math.max(1, Math.round(naturalH * scale));

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvas 2D context not available.");

        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);

        const thumbBytes = rgbaToThumbHash(w, h, imageData.data);
        resolve(base64Encode(thumbBytes));
      } catch (err) {
        reject(err);
      } finally {
        cleanup();
      }
    };

    img.onerror = () => {
      try {
        reject(new Error("Failed to decode image."));
      } finally {
        cleanup();
      }
    };

    img.src = objectUrl;
  });
}

function addThumbhashQueryParam(url: string, thumbhash: string): string {
  if (!thumbhash) return url;
  // Avoid messing with data/blob URLs or environments without `window`.
  if (url.indexOf("data:") === 0 || url.indexOf("blob:") === 0) return url;
  if (typeof window === "undefined") return url;

  try {
    const u = new URL(url, window.location.href);
    u.searchParams.set("th", thumbhash);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Compress, render ThumbHash as a blob URL for the editor preview, upload in the background.
 * Call {@link revokePlaceholder} after the real URL is applied (or on failure if the node was removed).
 */
export function startImageUploadWithThumbhashPreview(file: File): Promise<{
  placeholderUrl: string;
  revokePlaceholder: () => void;
  finishUpload: () => Promise<string>;
}> {
  const jwt = getJwt();
  return maybeCompressImageFile(file).then((compressedFile) =>
    generateThumbhashForImageFile(compressedFile).then((thumbhash) =>
      thumbhashBase64ToPlaceholderBlobUrl(thumbhash).then(({ url, revoke }) => ({
        placeholderUrl: url,
        revokePlaceholder: revoke,
        finishUpload: () =>
          uploadCompressedWithThumbhash(compressedFile, jwt, thumbhash),
      })),
    ),
  );
}

export function uploadImageFileToUrl(file: File): Promise<string> {
  const jwt = getJwt();
  return maybeCompressImageFile(file).then((compressedFile) =>
    generateThumbhashForImageFile(compressedFile).then((thumbhash) =>
      uploadCompressedWithThumbhash(compressedFile, jwt, thumbhash),
    ),
  );
}
