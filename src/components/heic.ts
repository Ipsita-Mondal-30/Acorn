// Apple HEIC photos: Acorn's server can't read them. Safari (on iPhone, iPad and Mac) can DECODE HEIC itself, so a HEIC file that
// reaches the capture form is turned into a JPEG on the device before upload. Browsers that can't decode HEIC (Chrome and Firefox on
// desktop and Android) fail cleanly with a message; nothing is converted on the server, because no server-side decoder is installed.
// Whether iOS hands the form a JPEG already (the usual case for the Photos picker) or a HEIC (e.g. from Files) is not controlled here.

export class HeicError extends Error {
  name = "HeicError";
}

export const isHeicFile = (f: Pick<File, "name" | "type">) => /^image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

export type Decoded = { width: number; height: number; release?: () => void };
export type HeicDeps = {
  decode: (file: Blob) => Promise<Decoded>;
  /** draw the decoded image at `width` x `height` and encode it as JPEG; null if the browser can't encode */
  encode: (img: Decoded, width: number, height: number) => Promise<Blob | null>;
};

export const MAX_SIDE = 4096;
export const JPEG_QUALITY = 0.9;

function browserDeps(): HeicDeps {
  const holder = new WeakMap<Decoded, CanvasImageSource>();
  return {
    async decode(file) {
      if (typeof createImageBitmap !== "function") throw new HeicError("This browser can't open HEIC photos.");
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(file);
      } catch {
        throw new HeicError("This browser can't open HEIC photos.");
      }
      const d: Decoded = { width: bmp.width, height: bmp.height, release: () => bmp.close() };
      holder.set(d, bmp);
      return d;
    },
    async encode(img, w, h) {
      const src = holder.get(img);
      if (!src) return null;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(src, 0, 0, w, h);
      return new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", JPEG_QUALITY));
    },
  };
}

/** The JPEG version of a HEIC photo, with the same name and a .jpg extension. Throws HeicError (message safe to show). */
export async function convertHeicToJpeg(file: File, deps: HeicDeps = browserDeps()): Promise<File> {
  if (!isHeicFile(file)) throw new HeicError("That isn't a HEIC photo.");
  const img = await deps.decode(file);
  try {
    if (!(img.width > 0 && img.height > 0)) throw new HeicError("That photo couldn't be read.");
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const blob = await deps.encode(img, Math.round(img.width * scale), Math.round(img.height * scale));
    if (!blob || blob.size === 0) throw new HeicError("That photo couldn't be converted in this browser.");
    return new File([blob], file.name.replace(/\.hei[cf]$/i, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
  } finally {
    img.release?.();
  }
}

export const HEIC_HELP =
  "This browser can't convert HEIC photos. On iPhone, open the capture page in Safari and pick the photo from Photos, or change Settings > Camera > Formats to Most Compatible and share it as a JPEG.";
