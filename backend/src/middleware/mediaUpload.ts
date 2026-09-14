import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  WHATSAPP_MEDIA_RULES,
  WHATSAPP_ALLOWED_MIME_TYPES,
  WHATSAPP_MAX_ANY_BYTES,
} from '@eventreach/shared';

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

export const UPLOAD_DIR = uploadDir;

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    /**
     * The stored name is generated, never taken from the client. Only the
     * extension is carried over, and it is validated against the declared
     * type first — otherwise "photo.png.exe" or a name containing path
     * separators would be written verbatim. path.extname on the original
     * name cannot itself contain a separator, but the extension is also
     * checked against the allow-list below before it is used.
     */
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase();
    const rule = WHATSAPP_MEDIA_RULES[file.mimetype];
    const safeExt = rule && rule.extensions.includes(ext) ? ext : '';
    cb(null, uniqueSuffix + safeExt);
  },
});

const fileFilter = (req: any, file: any, cb: any) => {
  /**
   * First gate only. This sees the browser-declared MIME, which is
   * caller-controlled, so passing it proves nothing about the contents —
   * uploadMedia re-checks the file's actual magic bytes and its real size on
   * disk before the upload is accepted.
   *
   * Excel was previously allowed here but is not offered by the UI and is not
   * one of the types this integration sends, so it is no longer accepted.
   */
  if (!WHATSAPP_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(
      new Error(`Unsupported file type. Allowed: ${WHATSAPP_ALLOWED_MIME_TYPES.join(', ')}`),
      false
    );
  }

  const ext = path.extname(file.originalname).toLowerCase();
  const rule = WHATSAPP_MEDIA_RULES[file.mimetype];
  if (!rule.extensions.includes(ext)) {
    return cb(
      new Error(`File extension "${ext || '(none)'}" does not match its type. Expected: ${rule.extensions.join(', ')}`),
      false
    );
  }

  cb(null, true);
};

export const mediaUpload = multer({
  storage,
  fileFilter,
  limits: {
    /**
     * The largest any supported type permits (PDF, 100 MB) — a hard ceiling so
     * a huge upload is cut off at the socket rather than buffered to disk.
     * The tighter per-type limit (5 MB for an image, for instance) is applied
     * in uploadMedia against the real size on disk.
     */
    fileSize: WHATSAPP_MAX_ANY_BYTES,
    files: 1,
  },
});
