import { chromium, type Browser, type Page } from "playwright";

import {
  VIEWPORT_PRESETS,
  type CapturedControl,
  type CapturedForm,
  type CapturedHeading,
  type CapturedLink,
  type CapturedPage,
  type SiteCapture,
  type SiteCaptureOptions,
  type ViewportName,
} from "./types.ts";
import {
  isSameOrigin,
  normalizeDiscoveredUrl,
  normalizeHttpUrl,
  SiteReverseError,
  screenshotFilename,
} from "./url.ts";

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_TIMEOUT_MS = 20_000;

interface BrowserPageFacts {
  title: string;
  textSample: string;
  headings: CapturedHeading[];
  links: CapturedLink[];
  controls: CapturedControl[];
  forms: CapturedForm[];
  landmarks: string[];
}

export async function captureSite(
  options: SiteCaptureOptions,
): Promise<SiteCapture> {
  const normalizedSourceUrl = normalizeHttpUrl(options.url);
  const origin = new URL(normalizedSourceUrl).origin;
  const maxPages = normalizeMaxPages(options.maxPages);
  const viewports = normalizeViewports(options.viewports);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const capturedAt = (options.clock ?? (() => new Date()))().toISOString();

  const browser = await launchChromium();
  try {
    const queue = [normalizedSourceUrl];
    const enqueued = new Set(queue);
    const visited = new Set<string>();
    const pages: CapturedPage[] = [];

    while (queue.length > 0 && visited.size < maxPages) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);

      for (const viewport of viewports) {
        const captured = await capturePage(browser, current, viewport, timeoutMs);
        pages.push(captured);

        if (viewport === viewports[0]) {
          for (const link of captured.links) {
            const normalized = normalizeDiscoveredUrl(link.href, captured.finalUrl);
            if (normalized === null) continue;
            if (!isSameOrigin(normalized, origin)) continue;
            if (visited.has(normalized) || enqueued.has(normalized)) continue;
            if (enqueued.size >= maxPages) continue;
            queue.push(normalized);
            enqueued.add(normalized);
          }
        }
      }
    }

    return {
      sourceUrl: options.url,
      normalizedSourceUrl,
      origin,
      capturedAt,
      maxPages,
      viewports,
      pages,
    };
  } finally {
    await browser.close();
  }
}

async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SiteReverseError(
      "Playwright Chromium is unavailable. Run `npx playwright install chromium` once, then retry reverse-site.\n" +
        detail,
    );
  }
}

async function capturePage(
  browser: Browser,
  url: string,
  viewport: ViewportName,
  timeoutMs: number,
): Promise<CapturedPage> {
  const context = await browser.newContext({
    viewport: VIEWPORT_PRESETS[viewport],
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 5_000) })
      .catch(() => undefined);

    const facts = await readPageFacts(page);
    const accessibilitySnapshot = await readAccessibilitySnapshot(page);
    const finalUrl = normalizeHttpUrl(page.url());
    const screenshot = await page.screenshot({
      fullPage: true,
      type: "png",
    });

    return {
      requestedUrl: url,
      finalUrl,
      viewport,
      title: facts.title,
      status: response?.status() ?? null,
      textSample: facts.textSample,
      headings: facts.headings,
      links: facts.links,
      controls: facts.controls,
      forms: facts.forms,
      landmarks: facts.landmarks,
      accessibilitySnapshot,
      screenshot: {
        filename: screenshotFilename(finalUrl, viewport),
        viewport,
        url: finalUrl,
        content: screenshot,
      },
    };
  } finally {
    await context.close();
  }
}

async function readPageFacts(page: Page): Promise<BrowserPageFacts> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/gu, " ").trim();
    const limited = <T>(items: T[], count: number): T[] => items.slice(0, count);
    const textOf = (element: Element): string => clean(element.textContent);
    const labelOf = (element: Element): string => {
      if (element instanceof HTMLInputElement) {
        const labels = Array.from(element.labels ?? []).map((label) =>
          clean(label.textContent),
        );
        const label = labels.find(Boolean);
        if (label) return label;
      }
      if (element instanceof HTMLSelectElement) {
        const labels = Array.from(element.labels ?? []).map((label) =>
          clean(label.textContent),
        );
        const label = labels.find(Boolean);
        if (label) return label;
      }
      if (element instanceof HTMLTextAreaElement) {
        const labels = Array.from(element.labels ?? []).map((label) =>
          clean(label.textContent),
        );
        const label = labels.find(Boolean);
        if (label) return label;
      }
      if (element instanceof HTMLElement) {
        return (
          clean(element.getAttribute("aria-label")) ||
          clean(element.getAttribute("title")) ||
          clean(element.getAttribute("placeholder")) ||
          textOf(element) ||
          clean(element.getAttribute("name")) ||
          element.tagName.toLowerCase()
        );
      }
      return textOf(element);
    };
    const controlKind = (element: Element): CapturedControl["kind"] => {
      if (element instanceof HTMLButtonElement) return "button";
      if (element instanceof HTMLInputElement) return "input";
      if (element instanceof HTMLSelectElement) return "select";
      if (element instanceof HTMLTextAreaElement) return "textarea";
      return "link-button";
    };
    const controlType = (element: Element): string | undefined => {
      if (element instanceof HTMLInputElement) return element.type || undefined;
      if (element instanceof HTMLButtonElement) return element.type || undefined;
      return undefined;
    };
    const controlPlaceholder = (element: Element): string | undefined => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        const placeholder = clean(element.placeholder);
        return placeholder || undefined;
      }
      return undefined;
    };
    const toControl = (element: Element): CapturedControl => ({
      kind: controlKind(element),
      label: labelOf(element),
      ...(controlType(element) ? { type: controlType(element) } : {}),
      ...(controlPlaceholder(element)
        ? { placeholder: controlPlaceholder(element) }
        : {}),
    });

    const headings = limited(
      Array.from(document.querySelectorAll("h1, h2, h3")).map((element) => {
        const tag = element.tagName.toLowerCase();
        const level: CapturedHeading["level"] =
          tag === "h1" ? 1 : tag === "h2" ? 2 : 3;
        return { level, text: textOf(element) };
      }),
      80,
    ).filter((heading) => heading.text.length > 0);

    const links = limited(
      Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map(
        (anchor) => ({
          text: textOf(anchor) || clean(anchor.getAttribute("aria-label")),
          href: anchor.href,
        }),
      ),
      140,
    ).filter((link) => link.href && link.text);

    const controls = limited(
      Array.from(
        document.querySelectorAll(
          "button, input, select, textarea, a[role='button']",
        ),
      ).map(toControl),
      120,
    ).filter((control) => control.label);

    const forms = limited(
      Array.from(document.querySelectorAll("form")).map((form, index) => ({
        label:
          clean(form.getAttribute("aria-label")) ||
          clean(form.getAttribute("name")) ||
          `Form ${index + 1}`,
        fields: limited(
          Array.from(
            form.querySelectorAll("button, input, select, textarea"),
          ).map(toControl),
          40,
        ).filter((field) => field.label),
      })),
      20,
    );

    const landmarks = limited(
      Array.from(
        document.querySelectorAll(
          "main, nav, header, footer, aside, section, [role]",
        ),
      ).map((element) => {
        const tag = element.tagName.toLowerCase();
        const role = clean(element.getAttribute("role"));
        const label = labelOf(element);
        return clean([role || tag, label].filter(Boolean).join(": "));
      }),
      80,
    ).filter(Boolean);

    return {
      title: document.title,
      textSample: clean(document.body?.innerText).slice(0, 12_000),
      headings,
      links,
      controls,
      forms,
      landmarks,
    };
  });
}

async function readAccessibilitySnapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/gu, " ").trim();
    const nameOf = (element: Element): string => {
      if (element instanceof HTMLElement) {
        return (
          clean(element.getAttribute("aria-label")) ||
          clean(element.getAttribute("title")) ||
          clean(element.textContent)
        );
      }
      return clean(element.textContent);
    };
    return Array.from(
      document.querySelectorAll(
        "main, nav, header, footer, aside, section, button, input, select, textarea, a, [role], [aria-label]",
      ),
    )
      .slice(0, 160)
      .map((element) => ({
        role:
          clean(element.getAttribute("role")) ||
          element.tagName.toLowerCase(),
        name: nameOf(element).slice(0, 180),
      }))
      .filter((entry) => entry.name || entry.role);
  });
}

function normalizeMaxPages(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PAGES;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`maxPages must be a positive integer; got ${value}`);
  }
  return Math.floor(value);
}

function normalizeViewports(
  value: ReadonlyArray<ViewportName> | undefined,
): ReadonlyArray<ViewportName> {
  const viewports = value ?? ["desktop", "mobile"];
  const unique = [...new Set(viewports)];
  if (unique.length === 0) {
    throw new Error("At least one viewport is required.");
  }
  for (const viewport of unique) {
    if (!(viewport in VIEWPORT_PRESETS)) {
      throw new Error(`Unsupported viewport: ${viewport}`);
    }
  }
  return unique;
}
