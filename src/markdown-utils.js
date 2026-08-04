export function normalizeMistralMath(markdown) {
  const replacements = [
    ["\\[", "$$"],
    ["\\]", "$$"],
    ["\\( ", "$"],
    [" \\)", "$"],
    ["\\(", "$"],
    ["\\)", "$"],
  ];

  let prepared = markdown;
  let replacementCount = 0;

  for (const [search, replacement] of replacements) {
    const occurrences = prepared.split(search).length - 1;
    if (occurrences > 0) {
      prepared = prepared.split(search).join(replacement);
      replacementCount += occurrences;
    }
  }

  return { markdown: prepared, replacementCount };
}

export async function shortContentHash(arrayBuffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", arrayBuffer);
    return Array.from(new Uint8Array(digest).slice(0, 4))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  let hash = 2166136261;
  for (const byte of new Uint8Array(arrayBuffer)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sanitizePathSegment(value, fallback = "document") {
  const sanitized = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return sanitized || fallback;
}

export function imageExtension(imageId, imageBase64) {
  const idMatch = String(imageId || "").match(/\.([a-zA-Z0-9]{2,5})$/);
  if (idMatch) {
    const extension = idMatch[1].toLowerCase();
    return extension === "jpg" ? "jpeg" : extension;
  }

  const mimeMatch = String(imageBase64 || "").match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
  if (mimeMatch) {
    const extension = mimeMatch[1].toLowerCase();
    return extension === "jpg" ? "jpeg" : extension;
  }
  return "png";
}

export function stripDataUrlPrefix(base64) {
  const value = String(base64 || "");
  return value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
}

export function replaceMistralImagePlaceholder(markdown, imageId, embeddedLink) {
  return markdown.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, (fullMatch, _alt, targetWithTitle) => {
    const target = String(targetWithTitle).trim().split(/\s+["']/)[0];
    let decodedTarget = target;
    try {
      decodedTarget = decodeURIComponent(target);
    } catch (_error) {
      // Keep the original target if it is not valid percent-encoded text.
    }
    const basename = decodedTarget.replace(/\\/g, "/").split("/").pop();
    return basename === imageId ? embeddedLink : fullMatch;
  });
}
