export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const CHATGPT_HOME = `${CHATGPT_ORIGIN}/`;

export type BrowserLocator = {
  click?: (options?: { timeoutMs?: number }) => Promise<void>;
  press?: (key: string, options?: unknown) => Promise<void>;
  fill?: (value: string, options?: unknown) => Promise<void>;
  count?: () => Promise<number>;
  nth?: (index: number) => BrowserLocator;
  first?: () => BrowserLocator;
  last?: () => BrowserLocator;
  filter?: (options: Record<string, unknown>) => BrowserLocator;
  locator?: (selector: string) => BrowserLocator;
  getByRole?: (role: string, options?: Record<string, unknown>) => BrowserLocator;
  isVisible?: (options?: unknown) => Promise<boolean>;
  innerText?: (options?: unknown) => Promise<string>;
  textContent?: (options?: unknown) => Promise<string | null>;
  evaluate?: <T>(fn: (element: Element) => T) => Promise<T>;
};

export type BrowserPage = {
  id?: string;
  tabId?: string;
  providerTabId?: string;
  url?: () => string | Promise<string>;
  title?: () => string | Promise<string>;
  goto?: (url: string, options?: unknown) => Promise<unknown>;
  locator?: (selector: string) => BrowserLocator;
  getByRole?: (role: string, options?: Record<string, unknown>) => BrowserLocator;
  getByText?: (text: string | RegExp, options?: Record<string, unknown>) => BrowserLocator;
  waitForTimeout?: (ms: number) => Promise<void>;
  waitForEvent?: (event: string, options?: unknown) => Promise<unknown>;
  evaluate?: <T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg?: A) => Promise<T>;
  keyboard?: { press?: (key: string) => Promise<void> };
  capabilities?: { get?: (id: string) => Promise<unknown> | unknown };
  /** Host-scoped clipboard exposed by controlled in-app/Chrome tabs. */
  clipboard?: BrowserClipboard;
  playwright?: Record<string, unknown>;
};

export type BrowserClipboard = {
  /** Read every clipboard item so it can be restored without losing formats. */
  read?: () => unknown | Promise<unknown>;
  readText?: () => string | undefined | Promise<string | undefined>;
  /** Restore the opaque value returned by read(). */
  write?: (items: unknown) => void | Promise<void>;
  writeText?: (text: string) => void | Promise<void>;
};

export type BrowserTab = Omit<BrowserPage, "url" | "title" | "playwright"> & {
  title?: string | (() => string | Promise<string>);
  url?: string | (() => string | Promise<string>);
  playwright?: BrowserPage;
};

export type Browser = {
  name?: string;
  tabs?: {
    list?: () => BrowserTab[] | Promise<BrowserTab[]>;
    get?: (id: string) => BrowserTab | Promise<BrowserTab>;
    create?: (url: string) => BrowserTab | Promise<BrowserTab>;
    new?: (url?: string) => BrowserTab | Promise<BrowserTab>;
  };
  newPage?: () => BrowserTab | Promise<BrowserTab>;
};

export type BrowserEnv = {
  browser?: Browser;
  page?: BrowserPage;
  expectedTabId?: string;
  clipboard?: {
    read: () => Promise<string | undefined>;
    waitForChange: (before: string | undefined, timeoutMs: number) => Promise<string | undefined>;
    snapshot?: () => Promise<unknown>;
    restore?: (snapshot: unknown) => Promise<void>;
    writeText?: (text: string) => Promise<void>;
  };
};

export type VisibleAuthState = "signed_in" | "login_required" | "unknown";

export type AcquiredChatGPTPage = {
  browser?: Browser;
  page: BrowserPage;
  tabId: string;
  url: string;
  auth: VisibleAuthState;
};

export type AcquireBrowserOptions = {
  createIfMissing?: boolean;
  /** Always create a dedicated ChatGPT home tab when a browser is available. */
  fresh?: boolean;
  /** Reclaim this exact controlled tab; never substitute another tab. */
  expectedTabId?: string;
};

export type BrowserRuntimeErrorCode =
  | "browser_unavailable"
  | "page_unavailable"
  | "unsafe_origin"
  | "tab_id_unavailable"
  | "ambiguous_chatgpt_tabs"
  | "login_required";

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code: BrowserRuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BrowserRuntimeError";
  }
}

/**
 * Acquires one exact visible ChatGPT page. Explicit env.page always wins; otherwise
 * exactly one controlled ChatGPT tab is reused, or a fresh home tab is created.
 * Ambiguous tabs and unverifiable tab identities fail closed.
 */
export async function acquireChatGPTPage(
  env: BrowserEnv,
  options: AcquireBrowserOptions = {}
): Promise<AcquiredChatGPTPage> {
  const browser = env.browser;
  let page: BrowserPage;
  const expectedTabId = options.fresh === true
    ? undefined
    : options.expectedTabId ?? env.expectedTabId;
  if (options.fresh === true && browser !== undefined) {
    page = await createHomePage(browser);
  } else if (expectedTabId !== undefined
    && (env.page === undefined || exactTabIdOrUndefined(env.page) !== expectedTabId)) {
    page = await exactBrowserTab(browser, expectedTabId);
  } else if (env.page !== undefined) {
    page = normalizeBrowserPage(env.page);
  } else {
    if (browser === undefined) {
      throw new BrowserRuntimeError(
        "browser_unavailable",
        "No selected visible browser is available from env.browser."
      );
    }
    page = await existingOrCreatedPage(browser, options.createIfMissing !== false);
  }
  const url = await exactChatGPTPageUrl(page);
  const tabId = exactTabId(page);
  if (expectedTabId !== undefined && expectedTabId !== tabId) {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      `Controlled tab ${JSON.stringify(tabId)} does not match expected tab ${JSON.stringify(expectedTabId)}.`
    );
  }

  const auth = await readVisibleAuthState(page);
  if (auth === "login_required") {
    throw new BrowserRuntimeError(
      "login_required",
      "The visible ChatGPT page requires the user to sign in."
    );
  }

  if (browser !== undefined) env.browser = browser;
  env.page = page;
  env.expectedTabId = tabId;
  return {
    ...(browser === undefined ? {} : { browser }),
    page,
    tabId,
    url,
    auth
  };
}

async function exactBrowserTab(
  browser: Browser | undefined,
  expectedTabId: string
): Promise<BrowserPage> {
  if (browser === undefined || typeof browser.tabs?.get !== "function") {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      `Controlled tab ${JSON.stringify(expectedTabId)} cannot be reclaimed.`
    );
  }
  let raw: BrowserTab;
  try {
    raw = await browser.tabs.get(expectedTabId);
  } catch {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      `Controlled tab ${JSON.stringify(expectedTabId)} cannot be reclaimed.`
    );
  }
  const page = normalizeBrowserPage(raw);
  if (exactTabId(page) !== expectedTabId) {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      `Reclaimed tab did not match ${JSON.stringify(expectedTabId)}.`
    );
  }
  return page;
}

/**
 * Turns a raw controlled Tab into the page-shaped object used by the bridge. Codex
 * tabs expose Playwright methods under Tab.playwright while tab identity remains on
 * the outer object, so the proxy intentionally reads from both without copying them.
 */
export function normalizeBrowserPage(raw: unknown): BrowserPage {
  if (!isRecord(raw)) {
    throw new BrowserRuntimeError("page_unavailable", "Browser tab is not an object.");
  }
  const inner = isRecord(raw.playwright) ? raw.playwright : raw;

  return new Proxy(inner, {
    get(target, property) {
      if (property === "url" || property === "title") {
        const value = property in target ? target[property] : raw[property];
        if (typeof value === "function") return value.bind(property in target ? target : raw);
        if (typeof value === "string") return () => value;
        return undefined;
      }

      const value = property in target ? target[property] : raw[property];
      return typeof value === "function"
        ? value.bind(property in target ? target : raw)
        : value;
    }
  }) as BrowserPage;
}

export function exactTabId(page: BrowserPage): string {
  const candidate = page.providerTabId ?? page.tabId ?? page.id;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      "Controlled ChatGPT page does not expose an exact tab ID."
    );
  }
  return candidate;
}

export function exactChatGPTUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserRuntimeError("unsafe_origin", "Controlled page URL is invalid.");
  }
  if (
    parsed.origin !== CHATGPT_ORIGIN
    || parsed.username.length > 0
    || parsed.password.length > 0
  ) {
    throw new BrowserRuntimeError(
      "unsafe_origin",
      `Visible bridge access requires the exact ${CHATGPT_ORIGIN} origin.`
    );
  }
  return parsed;
}

export async function readVisibleAuthState(page: BrowserPage): Promise<VisibleAuthState> {
  if (typeof page.evaluate !== "function") return "unknown";
  try {
    const snapshot = await page.evaluate(() => {
      const messageSelector = "[data-message-author-role], [data-testid^='conversation-turn']";
      const visible = (element: Element): boolean => {
        if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && element.getClientRects().length > 0;
      };
      const normalizedName = (element: Element): string => {
        const html = element as HTMLElement;
        return (
          element.getAttribute("aria-label")
          ?? element.getAttribute("value")
          ?? html.innerText
          ?? element.textContent
          ?? ""
        ).replace(/\s+/g, " ").trim().toLocaleLowerCase();
      };
      const accountSelector = [
        "[data-testid*='account' i]",
        "[data-testid*='profile' i]",
        "button[aria-label*='account' i]",
        "button[aria-label*='profile' i]"
      ].join(", ");
      const composerSelector = [
        "#prompt-textarea",
        "textarea[data-id='root']",
        "[contenteditable='true'][data-testid*='composer' i]"
      ].join(", ");
      const controls = Array.from(document.querySelectorAll(
        "button, a, [role='button'], input[type='button'], input[type='submit']"
      )).filter(element => element.closest(messageSelector) === null && visible(element));
      return {
        account: Array.from(document.querySelectorAll(accountSelector)).some(visible),
        composer: Array.from(document.querySelectorAll(composerSelector)).some(visible),
        conversationLinks: Array.from(document.querySelectorAll("a[href^='/c/']")).filter(visible).length,
        messages: Array.from(document.querySelectorAll(messageSelector)).some(visible),
        login: controls.some(element => {
          const name = normalizedName(element);
          return name === "log in" || name === "sign in";
        })
      };
    });
    if (!isAuthSnapshot(snapshot)) return "unknown";
    if (snapshot.login) return "login_required";
    const signedIn = snapshot.account
      || (snapshot.conversationLinks > 0 && (snapshot.composer || snapshot.messages));
    return signedIn ? "signed_in" : "unknown";
  } catch {
    return "unknown";
  }
}

async function existingOrCreatedPage(browser: Browser, createIfMissing: boolean): Promise<BrowserPage> {
  const listed = await Promise.resolve(browser.tabs?.list?.() ?? []);
  const matches: BrowserTab[] = [];
  for (const tab of listed) {
    const page = await hydrateTab(browser, tab);
    const url = await readPageUrl(page);
    if (url !== undefined && isExactChatGPTUrl(url)) matches.push(tab);
  }

  if (matches.length > 1) {
    throw new BrowserRuntimeError(
      "ambiguous_chatgpt_tabs",
      `Found ${matches.length} controlled ChatGPT tabs; bind an exact page instead of guessing.`
    );
  }
  if (matches.length === 1) return hydrateTab(browser, matches[0]!);
  if (!createIfMissing) {
    throw new BrowserRuntimeError("page_unavailable", "No controlled ChatGPT tab is available.");
  }
  return createHomePage(browser);
}

async function createHomePage(browser: Browser): Promise<BrowserPage> {
  let raw: BrowserTab | undefined;
  if (typeof browser.tabs?.create === "function") {
    raw = await browser.tabs.create(CHATGPT_HOME);
  } else if (typeof browser.tabs?.new === "function") {
    raw = await browser.tabs.new(CHATGPT_HOME);
  } else if (typeof browser.newPage === "function") {
    raw = await browser.newPage();
  }
  if (raw === undefined) {
    throw new BrowserRuntimeError(
      "page_unavailable",
      "Visible browser does not expose controlled tab creation."
    );
  }

  const page = await hydrateTab(browser, raw);
  const initialUrl = await readPageUrl(page);
  if (initialUrl === undefined || initialUrl === "" || initialUrl === "about:blank") {
    if (typeof page.goto !== "function") {
      throw new BrowserRuntimeError(
        "page_unavailable",
        "New controlled tab cannot navigate to ChatGPT home."
      );
    }
    await page.goto(CHATGPT_HOME);
  }
  await exactChatGPTPageUrl(page);
  exactTabId(page);
  return page;
}

async function hydrateTab(browser: Browser, raw: BrowserTab): Promise<BrowserPage> {
  if (!isRecord(raw.playwright) && typeof raw.id === "string" && typeof browser.tabs?.get === "function") {
    try {
      return normalizeBrowserPage(await browser.tabs.get(raw.id));
    } catch {
      // The listed tab may already expose enough page methods; verify it downstream.
    }
  }
  return normalizeBrowserPage(raw);
}

async function exactChatGPTPageUrl(page: BrowserPage): Promise<string> {
  const value = await readPageUrl(page);
  if (value === undefined) {
    throw new BrowserRuntimeError("unsafe_origin", "Controlled page URL cannot be verified.");
  }
  return exactChatGPTUrl(value).toString();
}

async function readPageUrl(page: BrowserPage): Promise<string | undefined> {
  if (typeof page.url !== "function") return undefined;
  try {
    const value = await page.url();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isExactChatGPTUrl(value: string): boolean {
  try {
    exactChatGPTUrl(value);
    return true;
  } catch {
    return false;
  }
}

function exactTabIdOrUndefined(page: BrowserPage): string | undefined {
  try {
    return exactTabId(page);
  } catch {
    return undefined;
  }
}

function isAuthSnapshot(value: unknown): value is {
  account: boolean;
  composer: boolean;
  conversationLinks: number;
  messages: boolean;
  login: boolean;
} {
  if (!isRecord(value)) return false;
  return typeof value.account === "boolean"
    && typeof value.composer === "boolean"
    && typeof value.conversationLinks === "number"
    && Number.isInteger(value.conversationLinks)
    && value.conversationLinks >= 0
    && typeof value.messages === "boolean"
    && typeof value.login === "boolean";
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
