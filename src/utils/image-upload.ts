import type { Request } from "express";
import { env } from "../config/env.js";

// Shared image upload support (ImgBB via the server — the API key never
// reaches the client). The file never touches the application server's disk:
// it is streamed from memory straight to ImgBB. Used by both the technician
// service-image endpoint (/api/uploads/image) and the per-user profile-image
// endpoint (/api/users/me/image), so validation, limits and failure handling
// are identical everywhere.
//
// Allowed image types and limits.
const ALLOWED_MIME_TYPES = {
  "image/jpeg": { extension: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/png": {
    extension: "png",
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  "image/webp": { extension: "webp", magic: null }, // RIFF....WEBP checked below
} as const;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const UPLOAD_TIMEOUT_MS = 10_000;

export type ImageKind = keyof typeof ALLOWED_MIME_TYPES;

export interface ParsedImageUpload {
  file: File;
  kind: ImageKind;
  bytes: Uint8Array<ArrayBuffer>;
}

export type ImageUploadResult<TSuccess> =
  | ({ ok: true } & TSuccess)
  | { ok: false; status: number; message: string };

function hasExpectedMagic(bytes: Uint8Array, kind: ImageKind): boolean {
  if (kind === "image/webp") {
    return (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  }
  const magic = ALLOWED_MIME_TYPES[kind].magic;
  if (!magic) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** Read and validate the single `image` file from a raw multipart body.
 *  `req.body` must be the raw Buffer produced by `express.raw()` on this
 *  route. Extra multipart fields are ignored — only the `image` file is used,
 *  which is what keeps caller-supplied ownership/identity data out of the
 *  process entirely. */
export async function parseImageUpload(
  req: Request
): Promise<ImageUploadResult<{ value: ParsedImageUpload }>> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data") || !Buffer.isBuffer(req.body)) {
    return { ok: false, status: 400, message: "Send one image as multipart/form-data." };
  }

  let file: File | null = null;
  try {
    // Native Request/FormData parse of the raw multipart payload.
    // Use the global Fetch Request constructor (not the Express Request type).
    const parsed = await new globalThis.Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      // Copy the raw multipart bytes into a Blob for the native FormData parser.
      body: new Blob([new Uint8Array(req.body)], { type: contentType }),
    }).formData();

    const entry = parsed.get("image");
    if (entry instanceof File && entry.name) file = entry;
    // Ignore any extra fields — only the single `image` file is used.
  } catch {
    return { ok: false, status: 400, message: "The upload could not be read. Try selecting the image again." };
  }

  if (!file) {
    return { ok: false, status: 400, message: "No image file was provided." };
  }
  const kind = file.type.toLowerCase() as ImageKind;
  if (!(kind in ALLOWED_MIME_TYPES)) {
    return { ok: false, status: 400, message: "Only JPEG, PNG and WebP images are supported." };
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    return { ok: false, status: 400, message: "The image must be between 1 byte and 5 MB." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasExpectedMagic(bytes, kind)) {
    return { ok: false, status: 400, message: "The file contents don't match its image type." };
  }

  return { ok: true, value: { file, kind, bytes } };
}

/** Send validated image bytes to ImgBB from the server. The API key and any
 *  upstream error details are never returned to the caller or logged. */
export async function uploadImageToHost(
  upload: ParsedImageUpload,
  fallbackName: string
): Promise<ImageUploadResult<{ url: string; mime: ImageKind; size: number }>> {
  const { file, kind, bytes } = upload;
  const formData = new FormData();
  formData.append(
    "image",
    new Blob([bytes], { type: kind }),
    file.name || `${fallbackName}.${ALLOWED_MIME_TYPES[kind].extension}`
  );

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.IMGBB_UPLOAD_URL}?key=${encodeURIComponent(env.IMGBB_API_KEY ?? "")}`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 502, message: "The image host couldn't be reached. Please try again." };
  }

  let payload: unknown = null;
  try {
    payload = await upstream.json();
  } catch {
    return { ok: false, status: 502, message: "The image host returned an invalid response." };
  }

  const url =
    isRecord(payload) && payload.success === true && isRecord(payload.data)
      ? payload.data.url
      : null;

  if (!upstream.ok || typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return { ok: false, status: 502, message: "The image couldn't be uploaded right now. Please try again." };
  }

  return { ok: true, url, mime: kind, size: file.size };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
