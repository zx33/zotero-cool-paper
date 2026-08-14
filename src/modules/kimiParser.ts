export function normalizeKimiHTML(text: string) {
  const urlRegex =
    /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])/gi;
  return stripFaqWrapper(text)
    .replace(urlRegex, " $1 ")
    .replace(/---\r?\n/g, "")
    .replace(/(-|\n)&gt;/g, "$1>")
    .replace(/&lt;(\/{0,1}[a-z]{2,4})&gt;/g, "<$1>");
}

function stripFaqWrapper(text: string) {
  const trimmed = text.trim();
  const opening = trimmed.match(/^<div\b([\s\S]*?)>/i);
  if (!opening || !hasHTMLClass(opening[1], "faq-a")) {
    return text;
  }

  const closingIndex = trimmed.toLowerCase().lastIndexOf("</div>");
  if (
    closingIndex < opening[0].length ||
    trimmed.slice(closingIndex + "</div>".length).trim()
  ) {
    return text;
  }

  return trimmed.slice(opening[0].length, closingIndex).trim();
}

function hasHTMLClass(attributes: string, className: string) {
  const quoted = attributes.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i);
  const unquoted = attributes.match(/\bclass\s*=\s*([^\s>]+)/i);
  const value = quoted?.[2] ?? unquoted?.[1] ?? "";
  return value.split(/\s+/).includes(className);
}
