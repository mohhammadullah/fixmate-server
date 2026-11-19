import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { MAX_IMAGE_BYTES, parseImageUpload, uploadImageToHost } from "../utils/image-upload.js";

export { MAX_IMAGE_BYTES };

const safeMessage = (message: string): { success: false; message: string } => ({
  success: false,
  message,
});

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

  const parsed = await parseImageUpload(req);
  if (!parsed.ok) {
    res.status(parsed.status).json(safeMessage(parsed.message));
    return;
  }

  // Send the bytes to ImgBB from the server. The API key and any upstream
  // error details are never returned to the client or logged.
  const uploaded = await uploadImageToHost(parsed.value, "service");
  if (!uploaded.ok) {
    res.status(uploaded.status).json(safeMessage(uploaded.message));
    return;
  }

  // Only the resulting URL and safe metadata — never the key or raw upstream body.
  res.status(200).json({
    success: true,
    data: {
      url: uploaded.url,
      mime: uploaded.mime,
      size: uploaded.size,
    },
  });
};
