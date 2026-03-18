import imageCompression from "browser-image-compression";

const UPLOAD_ENDPOINT = "https://uploads.commently.top/upload";

// NOTE: This is a sensitive credential. Prefer putting it in `VITE_IMAGE_UPLOAD_JWT`
// (and redeploy) rather than hardcoding.
const FALLBACK_JWT =
  "bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiMSIsInN1YiI6IjEiLCJpYXQiOjE3NzM4NjM3OTgsImV4cCI6MTc3Mzg2NzM5OH0.lj7rJjZPEdQiszsAdaeODoopkWOY4-1QYkBDstudJU4";

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

export function uploadImageFileToUrl(file: File): Promise<string> {
  const jwt = getJwt();

  return maybeCompressImageFile(file).then((compressedFile) => {
    // Try raw upload first (more likely when the endpoint says "upload" and
    // doesn't mention multipart).
    return tryUploadRaw(compressedFile, jwt).then((rawUrl) => {
      if (rawUrl) return rawUrl;
      return tryUploadMultipart(compressedFile, jwt).then((multipartUrl) => {
        if (multipartUrl) return multipartUrl;
        throw new Error(
          "Image upload failed: could not extract `url` from response.",
        );
      });
    });
  });
}
