const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/u;

export class SiteReverseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteReverseError";
  }
}

export function normalizeHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SiteReverseError(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SiteReverseError(
      `Only http and https URLs are supported; got ${parsed.protocol}`,
    );
  }
  parsed.hash = "";
  if (parsed.pathname === "") parsed.pathname = "/";
  return parsed.toString();
}

export function normalizeDiscoveredUrl(
  rawHref: string,
  baseUrl: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawHref, baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  parsed.hash = "";
  if (parsed.pathname === "") parsed.pathname = "/";
  return parsed.toString();
}

export function isSameOrigin(candidateUrl: string, origin: string): boolean {
  try {
    return new URL(candidateUrl).origin === origin;
  } catch {
    return false;
  }
}

export function defaultSlugFromUrl(rawUrl: string): string {
  const normalized = normalizeHttpUrl(rawUrl);
  const url = new URL(normalized);
  const host = url.hostname.replace(/^www\./u, "");
  const pathPart = url.pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 2)
    .join("-");
  return toSafeSlug(pathPart ? `${host}-${pathPart}` : host);
}

export function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG_REGEX.test(slug)) {
    throw new SiteReverseError(
      `Invalid slug "${slug}". Use 3-80 lowercase letters, numbers, and hyphens.`,
    );
  }
}

export function toSafeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 80)
    .replace(/-+$/u, "");
  if (slug.length >= 3) return slug;
  return "site-rebuild";
}

export function screenshotFilename(url: string, viewport: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === "/" ? "home" : parsed.pathname;
  const suffix = parsed.search ? `-${parsed.search}` : "";
  const base = toSafeSlug(`${parsed.hostname}-${path}${suffix}`);
  return `${base}-${viewport}.png`;
}
