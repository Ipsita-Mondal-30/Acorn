import type { MetadataRoute } from "next";

// Installing Acorn to the home screen (Android Chrome) makes it appear in the share sheet: sharing a link, text or
// image/PDF from another app POSTs it to /share. iOS Safari has no Web Share Target; see docs/capture.md.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Acorn",
    short_name: "Acorn",
    description: "Save anything. Acorn understands it, remembers it and helps you act on it.",
    id: "/",
    lang: "en",
    categories: ["productivity"],
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbf6ea",
    theme_color: "#5f9340",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
    share_target: {
      action: "/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "file", accept: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"] }],
      },
    },
  };
}
