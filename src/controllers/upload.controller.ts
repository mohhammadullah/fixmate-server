import type { Request, Response } from "express";
import { env } from "../config/env.js";

// Allowed image types and limits. The file never touches the application
// server's disk — it is streamed from memory straight to ImgBB.
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

type ImageKind = keyof typeof ALLOWED_MIME_TYPES;

const safeMessage = (message: string): { success: false; message: string } => ({
  success: false,
  message,
});

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

/** POST /api/uploads/image — technician-only, multipart/form-data with a
 *  single `image` file. The raw multipart body is collected by middleware and
 *  parsed with the platform's native FormData; no upload package is needed. */
export const uploadImage = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!env.IMGBB_API_KEY) {
    res.status(503).json(safeMessage("Image uploads aren't configured on this server yet."));
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data") || !Buffer.isBuffer(req.body)) {
    res.status(400).json(safeMessage("Send one image as multipart/form-data."));
    return;
  }

  let file: File | null = null;
  try {
    // Native Request/FormData parse of the raw multipart payload.
    const parsed = await new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      // Copy the raw multipart bytes into a Blob for the native FormData parser.
      body: new Blob([new Uint8Array(req.body)], { type: contentType }),
    }).formData();

    const entry = parsed.get("image");
    if (entry instanceof File && entry.name) file = entry;
    // Ignore any extra fields — only the single `image` file is used.
  } catch {
    res.status(400).json(safeMessage("The upload could not be read. Try selecting the image again."));
    return;
  }

  if (!file) {
    res.status(400).json(safeMessage("No image file was provided."));
    return;
  }
  const kind = file.type.toLowerCase() as ImageKind;
  if (!(kind in ALLOWED_MIME_TYPES)) {
    res.status(400).json(safeMessage("Only JPEG, PNG and WebP images are supported."));
    return;
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    res.status(400).json(safeMessage("The image must be between 1 byte and 5 MB."));
    return;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasExpectedMagic(bytes, kind)) {
    res.status(400).json(safeMessage("The file contents don't match its image type."));
    return;
  }

  // Send the bytes to ImgBB from the server. The API key and any upstream
  // error details are never returned to the client or logged.
  const formData = new FormData();
  formData.append("image", new Blob([bytes], { type: kind }), file.name || `service.${ALLOWED_MIME_TYPES[kind].extension}`);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.IMGBB_UPLOAD_URL}?key=${encodeURIComponent(env.IMGBB_API_KEY)}`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    res.status(502).json(safeMessage("The image host couldn't be reached. Please try again."));
    return;
  }

  let payload: unknown = null;
  try {
    payload = await upstream.json();
  } catch {
    res.status(502).json(safeMessage("The image host returned an invalid response."));
    return;
  }

  const url =
    isRecord(payload) && payload.success === true && isRecord(payload.data)
      ? payload.data.url
      : null;

  if (!upstream.ok || typeof url !== "string" || !/^https?:\/\//.test(url)) {
    res.status(502).json(safeMessage("The image couldn't be uploaded right now. Please try again."));
    return;
  }

  // Only the resulting URL and safe metadata — never the key or raw upstream body.
  res.status(200).json({
    success: true,
    data: {
      url,
      mime: kind,
      size: file.size,
    },
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
