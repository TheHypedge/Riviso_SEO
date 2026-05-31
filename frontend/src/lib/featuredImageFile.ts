import { api } from "@/lib/api";

function dataUrlToFile(dataUrl: string, filename = "featured.png"): File | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec((dataUrl || "").trim());
  if (!m) return null;
  try {
    const binary = atob(m[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: m[1] || "image/png" });
  } catch {
    return null;
  }
}

function extForMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

async function blobToFeaturedFile(blob: Blob): Promise<File> {
  const type = blob.type || "image/png";
  return new File([blob], `featured.${extForMime(type)}`, { type });
}

/** Build a File for WordPress upload from editor preview or stored featured image. */
export async function resolveFeaturedImageFileForWordPress(opts: {
  projectId: string;
  articleId: string;
  generatedImageUrl: string;
  hasFeaturedImage: boolean;
}): Promise<File | null> {
  const url = (opts.generatedImageUrl || "").trim();
  if (url.startsWith("data:image/")) {
    return dataUrlToFile(url);
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return blobToFeaturedFile(await res.blob());
    } catch {
      /* fall through */
    }
  }
  if (!opts.hasFeaturedImage) return null;
  try {
    const img = await api.getArticleFeaturedImage(opts.projectId, opts.articleId, { fresh: true });
    const stored = (img.image_url || "").trim();
    if (stored.startsWith("data:image/")) {
      return dataUrlToFile(stored);
    }
    if (stored.startsWith("http://") || stored.startsWith("https://")) {
      const res = await fetch(stored);
      if (!res.ok) return null;
      return blobToFeaturedFile(await res.blob());
    }
  } catch {
    /* optional */
  }
  return null;
}
