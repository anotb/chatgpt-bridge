import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  ChatGPTBrowserPort,
  createBrowserBridgePort,
  promptPresentationSha256s,
  readExactComposerPrompt,
  renderedPromptMatches
} from "../../src/bridge/browser-port.js";
import type { BrowserLocator, BrowserPage } from "../../src/bridge/browser-runtime.js";
import type { BridgeHandle } from "../../src/bridge/types.js";

describe("ChatGPTBrowserPort", () => {
  it("accepts only exact multiline presentation and verified attachment wrappers", () => {
    expect(renderedPromptMatches("first\n  second", "first second")).toBe(true);
    expect(renderedPromptMatches("first  second", "first second")).toBe(false);
    expect(renderedPromptMatches("safe space", "safe\u00a0space")).toBe(true);
    expect(renderedPromptMatches("long prompt", "long prompt\nShow more")).toBe(true);
    expect(renderedPromptMatches("long\nprompt", "long prompt\nShow more")).toBe(true);
    expect(renderedPromptMatches("long prompt", "long prompt Show more")).toBe(false);
    expect(renderedPromptMatches("long prompt", "prefix\nlong prompt\nShow more")).toBe(false);
    expect(renderedPromptMatches("long prompt", "long prompt\nShow More")).toBe(false);
    expect(renderedPromptMatches(
      "read both\nexactly",
      "read both exactly\nShow more"
    )).toBe(true);
    expect(renderedPromptMatches(
      "read both exactly",
      "notes(9).md\nDocument\nNow interactive!\nread both exactly"
    )).toBe(false);
    expect(renderedPromptMatches(
      "read both\nexactly",
      "unknown.md File notes.md File data.csv File read both exactly Show more"
    )).toBe(false);
    expect(promptPresentationSha256s("read both\nexactly")).toHaveLength(3);
  });

  it("preflights local files without acquiring browser state", async () => {
    const port = new ChatGPTBrowserPort({
      page: new FakePage("https://chatgpt.com.evil.example/")
    });

    await expect(port.preflightFiles(["relative.txt"])).rejects.toMatchObject({
      code: "file_path_not_absolute",
      uncertain: false
    });
  });

  it("binds only exact ChatGPT home and conversation routes", async () => {
    await expect(new ChatGPTBrowserPort({
      page: new FakePage("https://chatgpt.com.evil.example/c/thread")
    }).bindThread("current")).rejects.toThrow("exact https://chatgpt.com origin");

    const page = new FakePage("https://chatgpt.com/");
    page.onNavigate = () => {
      page.users = ["existing prompt"];
      page.userTurnIds = ["existing-user"];
      page.assistants = ["existing answer"];
      page.assistantTurnIds = ["existing-assistant"];
      page.generating = true;
      page.onWait = () => {
        if (page.waits >= 2) {
          page.generating = false;
          page.responseActions = true;
        }
      };
    };
    const binding = await new ChatGPTBrowserPort({ page }, { pollMs: 1 })
      .bindThread({ conversationId: "thread-1" });
    expect(page.navigations).toEqual(["https://chatgpt.com/c/thread-1"]);
    expect(binding).toMatchObject({
      tabId: "tab-1",
      conversationId: "thread-1",
      userTurnCount: 1,
      assistantTurnCount: 1,
      lastUserTurnId: "existing-user",
      lastAssistantTurnId: "existing-assistant"
    });
    expect(page.waits).toBeGreaterThanOrEqual(3);
  });

  it("uses an explicit page for new Chat and verifies exact prompt fill", async () => {
    const page = new FakePage("https://chatgpt.com/c/old-thread");
    const port = new ChatGPTBrowserPort({ page });
    await port.bindThread("new");
    expect(page.currentUrl).toBe("https://chatgpt.com/");
    await port.composePrompt("first line\n  exact indentation\n");
    expect(page.composer).toBe("first line\n  exact indentation\n");
    await expect(port.composePrompt("   ")).rejects.toThrow("nonempty");
  });

  it("replaces an existing text draft with the exact requested prompt", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.composer = "unrelated draft";
    const port = new ChatGPTBrowserPort({ page });

    await port.bindThread("current");
    await port.composePrompt("exact requested prompt");

    expect(page.composer).toBe("exact requested prompt");
  });

  it("computes prompt presentation hashes without a pre-Send composer gate", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    const port = new ChatGPTBrowserPort({ page });
    await port.bindThread("new");
    await port.composePrompt("exact prepared prompt");

    await expect(port.submissionPresentationSha256s("exact prepared prompt"))
      .resolves.toEqual([sha256("exact\0exact prepared prompt"), sha256("show-more\0exact prepared prompt")]);
    expect(page.sendClicks).toBe(0);
  });

  it("reads live multiline contenteditable text when no inline tool pill exists", () => {
    let cloneCalls = 0;
    const first = "a".repeat(2_600);
    const second = "b".repeat(2_656);
    const prompt = `${first}\n\n${second}`;
    const paragraph = (text: string, empty = false) => ({
      nodeType: 1,
      tagName: "P",
      classList: { contains: () => false },
      getAttribute: (name: string) => name === "data-empty-paragraph" && empty
        ? "true"
        : null,
      childNodes: empty
        ? [{
            nodeType: 1,
            tagName: "BR",
            classList: { contains: () => true },
            childNodes: []
          }]
        : [{ nodeType: 3, textContent: text }]
    });
    const editor = {
      tagName: "DIV",
      children: [paragraph(first), paragraph("", true), paragraph(second)],
      innerText: `${first}\n\n\n\n\n${second}`,
      textContent: prompt.replaceAll("\n", ""),
      querySelectorAll: () => [],
      cloneNode: () => {
        cloneCalls += 1;
        throw new Error("plain prompts must not be cloned");
      }
    } as unknown as Element;

    expect(prompt).toHaveLength(5_258);
    expect(readExactComposerPrompt(editor)).toBe(prompt);
    expect(cloneCalls).toBe(0);
  });

  it("keeps clone-based inline tool-pill stripping", () => {
    const cursorTarget = { matches: () => true, remove: vi.fn() };
    const nextText = { nodeType: 3, textContent: " exact tool prompt" };
    const pill = {
      nextSibling: nextText,
      previousElementSibling: cursorTarget,
      remove: vi.fn()
    };
    const remainingCursor = { remove: vi.fn() };
    const clone = {
      children: [],
      innerText: "exact tool prompt",
      textContent: "exact tool prompt",
      querySelectorAll: (selector: string) => selector.includes("data-keyword")
        ? [pill]
        : [remainingCursor]
    };
    const editor = {
      tagName: "DIV",
      children: [],
      innerText: "Web search exact tool prompt",
      textContent: "Web search exact tool prompt",
      querySelectorAll: () => [{}],
      cloneNode: () => clone
    } as unknown as Element;

    expect(readExactComposerPrompt(editor)).toBe("exact tool prompt");
    expect(nextText.textContent).toBe("exact tool prompt");
    expect(cursorTarget.remove).toHaveBeenCalledOnce();
    expect(pill.remove).toHaveBeenCalledOnce();
    expect(remainingCursor.remove).toHaveBeenCalledOnce();
  });

  it("submits one 5,258-character multiline prompt without cloning the plain editor", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    const port = new ChatGPTBrowserPort({ page });
    const prompt = `${"a".repeat(2_600)}\n\n${"b".repeat(2_656)}`;
    page.renderedOnSend = prompt;
    page.onSend = () => { page.currentUrl = "https://chatgpt.com/c/thread-long-multiline"; };
    await port.bindThread("new");
    await port.composePrompt(prompt);

    await expect(port.submissionPresentationSha256s(prompt)).resolves.toHaveLength(3);
    await expect(port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0
    })).resolves.toMatchObject({
      confirmed: true,
      conversationId: "thread-long-multiline"
    });
    expect(page.sendClicks).toBe(1);
  });

  it("does not revalidate composer state while computing prompt presentation hashes", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    const port = new ChatGPTBrowserPort({ page });
    await port.bindThread("new");
    await port.composePrompt("prompt-only request");
    page.attachmentNames = ["manual-secret.txt"];

    await expect(port.submissionPresentationSha256s("prompt-only request"))
      .resolves.toHaveLength(2);
    expect(page.sendClicks).toBe(0);
  });

  it("refuses an unrequested staged attachment before filling the prompt", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.attachmentNames = ["manual-secret.txt"];
    const port = new ChatGPTBrowserPort({ page });
    await port.bindThread("new");

    await expect(port.composePrompt("prompt-only request"))
      .rejects.toThrow("unrequested staged attachment");
    expect(page.composer).toBe("");
    expect(page.sendClicks).toBe(0);
  });

  it("creates a distinct fresh tab for sequential new operations on one port", async () => {
    let next = 0;
    const create = vi.fn(async () => {
      const page = new FakePage("https://chatgpt.com/");
      page.id = `fresh-${++next}`;
      return page;
    });
    const port = new ChatGPTBrowserPort({ browser: { tabs: { create } } });

    const first = await port.bindThread("new");
    const second = await port.bindThread("new");
    expect(create).toHaveBeenCalledTimes(2);
    expect(first.tabId).toBe("fresh-1");
    expect(second.tabId).toBe("fresh-2");
  });

  it("reuses one exact zero-turn target-preflight tab for the following new thread", async () => {
    let next = 0;
    const pages: FakePage[] = [];
    const create = vi.fn(async () => {
      const page = new FakePage("https://chatgpt.com/");
      page.id = `preflight-${++next}`;
      page.mainReady = false;
      page.composerReady = false;
      page.onWait = () => {
        if (page.waits >= 1) page.mainReady = true;
        if (page.waits >= 2) page.composerReady = true;
      };
      pages.push(page);
      return page;
    });
    const list = vi.fn(async () => [
      new FakePage("https://chatgpt.com/c/leftover-1"),
      new FakePage("https://chatgpt.com/c/leftover-2")
    ]);
    const port = new ChatGPTBrowserPort({ browser: { tabs: { list, create } } });

    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });
    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });
    const binding = await port.bindThread("new");

    expect(create).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(binding.tabId).toBe("preflight-1");
    expect(pages[0]?.waits).toBeGreaterThanOrEqual(2);
    expect(pages[0]?.powerMenuVisible).toBe(false);
  });

  it("reuses the same zero-turn tab after a reversible Power inspection failure", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.id = "retry-preflight";
    page.throwBeforePowerOpen = true;
    const create = vi.fn(async () => page);
    const port = new ChatGPTBrowserPort({ browser: { tabs: { create } } });
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now += 11_000);

    try {
      await expect(port.inspectTargets()).rejects.toThrow("transport failed before Power toggle");
    } finally {
      clock.mockRestore();
    }
    page.throwBeforePowerOpen = false;
    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });

    expect(create).toHaveBeenCalledTimes(1);
    expect(page.powerMenuVisible).toBe(false);
  });

  it("closes the live Power menu with one exact opener toggle instead of Escape", async () => {
    const page = new FakePage("https://chatgpt.com/");
    const port = new ChatGPTBrowserPort({
      browser: { tabs: { create: async () => page } }
    });

    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });

    expect(page.powerMenuVisible).toBe(false);
    expect(page.powerOpenerClicks).toBe(2);
    expect(page.powerSliderPresses).toBe(0);
  });

  it("targets Power when the attachment menu button is also visible", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.attachmentMenuVisible = true;
    page.powerLabel = "Extra High";
    const port = new ChatGPTBrowserPort({
      browser: { tabs: { create: async () => page } }
    });

    await expect(port.inspectTargets()).resolves.toMatchObject({
      active: { power: "Extra High" },
      options: { power: [{ label: "Extra High", selected: true }] }
    });

    expect(page.powerMenuVisible).toBe(false);
    expect(page.powerOpenerClicks).toBe(2);
  });

  it("fails before toggling when the semantic Power opener is genuinely ambiguous", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.attachmentMenuVisible = true;
    page.powerOpenerCount = 2;
    const port = new ChatGPTBrowserPort({
      browser: { tabs: { create: async () => page } }
    });
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now += 11_000);

    try {
      await expect(port.inspectTargets()).rejects.toThrow(
        "ChatGPT Power opener is not uniquely visible."
      );
    } finally {
      clock.mockRestore();
    }

    expect(page.powerOpenerClicks).toBe(0);
  });

  it("uses one scoped pointer activation per Power toggle when CDP is available", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    const port = new ChatGPTBrowserPort({
      browser: { tabs: { create: async () => page } }
    });

    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });

    expect(page.powerMenuVisible).toBe(false);
    expect(page.powerOpenerClicks).toBe(0);
    expect(page.cdpCommands).toEqual([
      "Page.bringToFront:",
      "Input.dispatchMouseEvent:mouseMoved",
      "Input.dispatchMouseEvent:mousePressed",
      "Input.dispatchMouseEvent:mouseReleased",
      "Page.bringToFront:",
      "Input.dispatchMouseEvent:mouseMoved",
      "Input.dispatchMouseEvent:mousePressed",
      "Input.dispatchMouseEvent:mouseReleased"
    ]);
  });

  it("uses the opener state instead of a stale mounted Power portal", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.powerControlStaleVisible = true;
    const port = new ChatGPTBrowserPort({
      browser: { tabs: { create: async () => page } }
    });

    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });

    expect(page.powerMenuVisible).toBe(false);
    expect(page.powerControlStaleVisible).toBe(true);
    expect(page.powerOpenerClicks).toBe(2);
  });

  it("reconciles an opener click error only after the Power menu disappeared", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.throwAfterPowerClose = true;
    const port = new ChatGPTBrowserPort({
      browser: { tabs: { create: async () => page } }
    });

    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });
    expect(page.powerMenuVisible).toBe(false);
    expect(page.powerOpenerClicks).toBe(2);
  });

  it("does not reconcile an opener click error while the Power menu remains visible", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.throwBeforePowerClose = true;
    const port = new ChatGPTBrowserPort({
      browser: { tabs: { create: async () => page } }
    });
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now += 4_000);

    try {
      await expect(port.inspectTargets()).rejects.toThrow("transport failed before Power toggle");
    } finally {
      clock.mockRestore();
    }
    expect(page.powerMenuVisible).toBe(true);
    expect(page.powerOpenerClicks).toBe(2);
  });

  it("waits boundedly when a zero-turn inspected tab is transiently reloading", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.id = "preflight-reload";
    const create = vi.fn(async () => page);
    const port = new ChatGPTBrowserPort(
      { browser: { tabs: { create } } },
      { pollMs: 1 }
    );

    await port.inspectTargets();
    page.mainReady = false;
    page.composerReady = false;
    const before = page.waits;
    page.onWait = () => {
      if (page.waits >= before + 1) page.mainReady = true;
      if (page.waits >= before + 2) page.composerReady = true;
    };

    const binding = await port.bindThread("new");
    expect(binding.tabId).toBe("preflight-reload");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("waits for home readiness after navigating an explicit page", async () => {
    const page = new FakePage("https://chatgpt.com/c/old-thread");
    page.onNavigate = () => {
      page.mainReady = false;
      page.composerReady = false;
      const before = page.waits;
      page.onWait = () => {
        if (page.waits >= before + 1) page.mainReady = true;
        if (page.waits >= before + 2) page.composerReady = true;
      };
    };
    const port = new ChatGPTBrowserPort({ page }, { pollMs: 1 });

    await expect(port.bindThread("new")).resolves.toMatchObject({ tabId: "tab-1" });
    expect(page.currentUrl).toBe("https://chatgpt.com/");
    expect(page.waits).toBeGreaterThanOrEqual(2);
  });

  it("creates a fresh isolated tab when the inspected preflight page gains a turn", async () => {
    let next = 0;
    const pages: FakePage[] = [];
    const create = vi.fn(async () => {
      const page = new FakePage("https://chatgpt.com/");
      page.id = `fresh-${++next}`;
      pages.push(page);
      return page;
    });
    const port = new ChatGPTBrowserPort({ browser: { tabs: { create } } });

    await port.inspectTargets();
    pages[0]!.composer = "manual draft";
    pages[0]!.users.push("manual turn");
    const binding = await port.bindThread("new");

    expect(create).toHaveBeenCalledTimes(2);
    expect(binding.tabId).toBe("fresh-2");
    expect(pages[0]?.composer).toBe("manual draft");
  });

  it("reuses a zero-turn inspected page and replaces a draft with the requested prompt", async () => {
    const page = new FakePage("https://chatgpt.com/");
    const port = new ChatGPTBrowserPort({ page });

    await port.inspectTargets();
    page.composer = "manual draft";

    await expect(port.bindThread("new")).resolves.toMatchObject({ tabId: "tab-1" });
    await port.composePrompt("bridge request");
    expect(page.composer).toBe("bridge request");
  });

  it("preflights and binds a fresh zero-turn tab even when ChatGPT restores draft text", async () => {
    const page = new FakePage("https://chatgpt.com/");
    page.id = "restored-draft";
    page.composer = "restored by ChatGPT";
    const create = vi.fn(async () => page);
    const port = new ChatGPTBrowserPort({ browser: { tabs: { create } } });

    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });
    await expect(port.bindThread("new")).resolves.toMatchObject({ tabId: "restored-draft" });
    await port.composePrompt("exact bridge request");

    expect(create).toHaveBeenCalledTimes(1);
    expect(page.composer).toBe("exact bridge request");
  });

  it("activates Send once and records the exact rendered user-turn hash", async () => {
    const prompt = "composer text transformed by rendering  ";
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    page.composer = prompt;
    page.renderedOnSend = "composer text transformed by rendering";
    page.onSend = () => { page.currentUrl = "https://chatgpt.com/c/thread-2"; };
    const port = new ChatGPTBrowserPort({ page }, { acknowledgementTimeoutMs: 50, pollMs: 1 });
    await port.bindThread("current");
    const receipt = await port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0
    });
    expect(receipt).toMatchObject({
      confirmed: true,
      conversationId: "thread-2",
      renderedPromptSha256: sha256(page.renderedOnSend)
    });
    expect(page.sendClicks).toBe(1);
    expect(page.sendKeyPresses).toBe(0);
  });

  it("clicks the visible Send control once without a CDP envelope predicate", async () => {
    const prompt = "front-bound semantic submission";
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    page.composer = prompt;
    page.renderedOnSend = prompt;
    page.onSend = () => { page.currentUrl = "https://chatgpt.com/c/thread-cdp-send"; };
    const port = new ChatGPTBrowserPort({ page }, { acknowledgementTimeoutMs: 50, pollMs: 1 });
    await port.bindThread("current");

    await expect(port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0
    })).resolves.toMatchObject({ confirmed: true, conversationId: "thread-cdp-send" });

    expect(page.sendClicks).toBe(1);
    expect(page.sendKeyPresses).toBe(0);
    expect(page.cdpCommands).toEqual([]);
  });

  it("discovers Power beside attachments and still activates Send exactly once", async () => {
    const prompt = "coexisting composer menus";
    const page = new FakePage("https://chatgpt.com/");
    page.attachmentMenuVisible = true;
    page.cdpSupported = true;
    page.renderedOnSend = prompt;
    page.onSend = () => { page.currentUrl = "https://chatgpt.com/c/thread-menu-coexistence"; };
    const port = new ChatGPTBrowserPort({
      browser: { tabs: { create: async () => page } }
    }, { acknowledgementTimeoutMs: 50, pollMs: 1 });

    await expect(port.inspectTargets()).resolves.toMatchObject({ active: { power: "Instant" } });
    await port.bindThread("new");
    await port.selectTarget("power", "Instant");
    await port.composePrompt(prompt);
    await expect(port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0
    })).resolves.toMatchObject({
      confirmed: true,
      conversationId: "thread-menu-coexistence"
    });

    expect(page.sendClicks).toBe(1);
    expect(page.powerMenuVisible).toBe(false);
  });

  it("reconciles an activation that acts and then throws without a second activation", async () => {
    const prompt = "ambiguous browser acknowledgement";
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    page.composer = prompt;
    page.renderedOnSend = prompt;
    page.onSend = () => {
      page.currentUrl = "https://chatgpt.com/c/thread-3";
      throw new Error("transport closed after click");
    };
    const port = new ChatGPTBrowserPort({ page }, { acknowledgementTimeoutMs: 50, pollMs: 1 });
    await port.bindThread("current");
    await expect(port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0
    })).resolves.toMatchObject({ confirmed: true, conversationId: "thread-3" });
    expect(page.sendClicks).toBe(1);
    expect(page.sendKeyPresses).toBe(0);
  });

  it("returns confirmed false when one Send produces no owned turn", async () => {
    const prompt = "no-op click";
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    page.composer = prompt;
    page.renderedOnSend = undefined;
    const port = new ChatGPTBrowserPort({ page }, { acknowledgementTimeoutMs: 2, pollMs: 1 });
    await port.bindThread("current");
    await expect(port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0
    })).resolves.toMatchObject({ confirmed: false });
    expect(page.sendClicks).toBe(1);
    expect(page.sendKeyPresses).toBe(0);
  });

  it.each([
    ["prompt", (page: FakePage) => { page.composer = "changed prompt"; }],
    ["attachment", (page: FakePage) => { page.attachmentNames = ["staged.txt"]; }],
    ["tool", (page: FakePage) => { page.activeToolLabels = ["Web search"]; }],
    ["route", (page: FakePage) => { page.currentUrl = "https://chatgpt.com/c/other"; }],
    ["user baseline", (page: FakePage) => { page.users = ["intervening user"]; }],
    ["assistant baseline", (page: FakePage) => { page.assistants = ["intervening answer"]; }]
  ])("does not gate Send on a changed %s composer snapshot", async (_name, mutate) => {
    const prompt = "direct request";
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    const port = new ChatGPTBrowserPort({ page }, { acknowledgementTimeoutMs: 2, pollMs: 1 });
    await port.bindThread("new");
    await port.composePrompt(prompt);
    mutate(page);

    await expect(port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0
    })).resolves.toMatchObject({ confirmed: false });
    expect(page.sendClicks).toBe(1);
  });

  it("does not revalidate a requested Power echo before Send", async () => {
    const prompt = "direct Power request";
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    page.composer = prompt;
    const port = new ChatGPTBrowserPort({ page }, { acknowledgementTimeoutMs: 2, pollMs: 1 });
    await port.bindThread("current");

    await expect(port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0,
      power: "Pro"
    })).resolves.toMatchObject({ confirmed: false });
    expect(page.sendClicks).toBe(1);
  });

  it("does not claim a different user turn that appears after Send", async () => {
    const prompt = "bridge-owned prompt";
    const page = new FakePage("https://chatgpt.com/");
    page.cdpSupported = true;
    page.composer = prompt;
    page.renderedOnSend = "manual concurrent prompt";
    page.onSend = () => { page.currentUrl = "https://chatgpt.com/c/thread-other"; };
    const port = new ChatGPTBrowserPort({ page }, { acknowledgementTimeoutMs: 2, pollMs: 1 });
    await port.bindThread("current");

    await expect(port.submitPrompt({
      prompt,
      promptSha256: sha256(prompt),
      userTurnBefore: 0,
      assistantTurnBefore: 0
    })).resolves.toMatchObject({ confirmed: false });
    expect(page.sendClicks).toBe(1);
    expect(page.sendKeyPresses).toBe(0);
  });

  it("owns observation and output by tab, conversation, rendered prompt, and baselines", async () => {
    const prompt = "ownership prompt";
    const page = new FakePage("https://chatgpt.com/c/thread-owned");
    page.users = [prompt];
    page.assistants = ["# Exact answer\n"];
    page.assistantTurnIds = ["conversation-turn-2"];
    page.responseActions = true;
    const port = new ChatGPTBrowserPort({
      page,
      clipboard: {
        snapshot: async () => ({ formats: ["text/plain"] }),
        restore: async () => undefined,
        read: async () => "old",
        waitForChange: async () => "# Exact answer\n"
      }
    });
    const owned = handle(prompt, "thread-owned");
    await port.bindHandle(owned);
    await expect(port.observe(owned)).resolves.toEqual({
      phase: "completed",
      responseOwned: true,
      assistantTurnId: "conversation-turn-2"
    });
    await expect(port.copyResponseMarkdown()).resolves.toBe("# Exact answer\n");
    expect(page.copyClicks).toBe(1);

    page.users[0] = "different";
    await port.bindHandle(owned);
    await expect(port.observe(owned)).resolves.toMatchObject({
      phase: "uncertain",
      responseOwned: false,
      uncertainty: expect.stringContaining("prompt hash")
    });
  });

  it("fails closed for a legacy file handle without an exact rendered receipt", async () => {
    const prompt = "read both exactly";
    const page = new FakePage("https://chatgpt.com/c/thread-owned");
    page.users = ["notes(9).md\nDocument\nNow interactive!\nread both exactly"];
    page.assistants = ["done"];
    page.assistantTurnIds = ["assistant-file-turn"];
    page.responseActions = true;
    const { renderedPromptSha256: _rendered, ...base } = handle(prompt, "thread-owned");
    const legacy: BridgeHandle = {
      ...base,
      promptPresentationSha256s: [
        sha256(`exact\0${prompt}`),
        sha256(`flat\0notes.md File ${prompt}`),
        sha256(`flat\0notes.md File ${prompt} Show more`)
      ]
    };
    const port = new ChatGPTBrowserPort({ page });

    await port.bindHandle(legacy);
    await expect(port.observe(legacy)).resolves.toMatchObject({
      phase: "uncertain",
      responseOwned: false,
      uncertainty: expect.stringContaining("prompt hash")
    });
  });

  it("uses and losslessly restores the bound tab clipboard for repeated Copy output", async () => {
    const prompt = "ownership prompt";
    const page = new FakePage("https://chatgpt.com/c/thread-owned");
    page.users = [prompt];
    page.assistants = ["answer"];
    page.assistantTurnIds = ["assistant-message-1"];
    page.responseActions = true;
    const opaque = [{ types: ["text/plain", "text/html"], marker: "full-items" }];
    let current = "same Markdown";
    const read = vi.fn(async () => opaque);
    const write = vi.fn(async (_items: unknown) => { current = "same Markdown"; });
    const readText = vi.fn(async () => current);
    const writeText = vi.fn(async (text: string) => { current = text; });
    Object.assign(page, { clipboard: { read, write, readText, writeText } });
    page.onCopy = () => { current = "same Markdown"; };
    const port = new ChatGPTBrowserPort({ page });
    const owned = {
      ...handle(prompt, "thread-owned"),
      assistantTurnId: "assistant-message-1"
    };

    await port.bindHandle(owned);
    await expect(port.copyResponseMarkdown()).resolves.toBe("same Markdown");
    await expect(port.copyResponseMarkdown()).resolves.toBe("same Markdown");
    expect(page.copyClicks).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, opaque);
    expect(write).toHaveBeenNthCalledWith(2, opaque);
  });

  it("prefers an explicit custom clipboard over the bound tab clipboard", async () => {
    const prompt = "ownership prompt";
    const page = new FakePage("https://chatgpt.com/c/thread-owned");
    page.users = [prompt];
    page.assistants = ["answer"];
    page.assistantTurnIds = ["assistant-message-1"];
    page.responseActions = true;
    const virtualRead = vi.fn(async () => "virtual");
    Object.assign(page, { clipboard: { readText: virtualRead } });
    const explicitRead = vi.fn(async () => "before");
    const port = new ChatGPTBrowserPort({
      page,
      clipboard: {
        snapshot: async () => ({ formats: ["text/plain"] }),
        restore: async () => undefined,
        read: explicitRead,
        waitForChange: async () => "explicit Markdown"
      }
    });
    const owned = {
      ...handle(prompt, "thread-owned"),
      assistantTurnId: "assistant-message-1"
    };

    await port.bindHandle(owned);
    await expect(port.copyResponseMarkdown()).resolves.toBe("explicit Markdown");
    expect(explicitRead).toHaveBeenCalledTimes(1);
    expect(virtualRead).not.toHaveBeenCalled();
  });

  it("keeps an exact ID-bound turn owned after later same-thread turns", async () => {
    const prompt = "owned prompt";
    const page = new FakePage("https://chatgpt.com/c/thread-owned");
    page.users = [prompt, "later follow-up"];
    page.userTurnIds = ["user-message-1", "user-message-2"];
    page.assistants = ["owned answer", "later answer"];
    page.assistantTurnIds = ["assistant-message-1", "assistant-message-2"];
    page.responseActions = true;
    const port = new ChatGPTBrowserPort({ page });
    const owned = {
      ...handle(prompt, "thread-owned"),
      userTurnId: "user-message-1",
      assistantTurnId: "assistant-message-1"
    };

    await port.bindHandle(owned);
    await expect(port.observe(owned)).resolves.toMatchObject({
      phase: "completed",
      responseOwned: true,
      userTurnId: "user-message-1",
      assistantTurnId: "assistant-message-1"
    });

    page.assistantTurnIds[0] = "replacement-branch";
    await port.bindHandle(owned);
    await expect(port.observe(owned)).resolves.toMatchObject({
      phase: "uncertain",
      responseOwned: false,
      uncertainty: expect.stringContaining("assistant-turn identity")
    });
  });

  it("recovers exact multiline and attachment presentations from pre-Send hashes", async () => {
    const page = new FakePage("https://chatgpt.com/c/thread-owned");
    page.assistants = ["answer"];
    page.assistantTurnIds = ["assistant-message-1"];
    page.responseActions = true;
    const port = new ChatGPTBrowserPort({ page });

    const multiline = "first line\nsecond line";
    page.users = ["first line second line"];
    const multilineHandle = recoveryHandle(multiline, []);
    await port.bindHandle(multilineHandle);
    await expect(port.observe(multilineHandle)).resolves.toMatchObject({
      phase: "completed",
      responseOwned: true
    });

    page.users = ["long prompt\nShow more"];
    const showMoreHandle = recoveryHandle("long prompt", []);
    await port.bindHandle(showMoreHandle);
    await expect(port.observe(showMoreHandle)).resolves.toMatchObject({
      phase: "completed",
      responseOwned: true
    });

    const attached = "read both\nexactly";
    page.users = ["notes.md\nFile\ndata.csv\nFile\nread both exactly\nShow more"];
    const attachmentHandle = recoveryHandle(attached, ["notes.md", "data.csv"]);
    await port.bindHandle(attachmentHandle);
    await expect(port.observe(attachmentHandle)).resolves.toMatchObject({
      phase: "uncertain",
      responseOwned: false
    });

    page.users = ["unknown.md File notes.md File data.csv File read both exactly Show more"];
    await port.bindHandle(attachmentHandle);
    await expect(port.observe(attachmentHandle)).resolves.toMatchObject({
      phase: "uncertain",
      responseOwned: false,
      uncertainty: expect.stringContaining("prompt hash")
    });
  });

  it("reopens an exact journaled conversation when its original tab closed", async () => {
    const replacement = new FakePage("https://chatgpt.com/");
    replacement.id = "tab-replacement";
    replacement.users = ["ownership prompt"];
    const create = vi.fn(async () => replacement);
    const port = new ChatGPTBrowserPort({
      browser: {
        tabs: {
          get: async () => { throw new Error("closed"); },
          create
        }
      }
    });

    const binding = await port.bindHandle(handle("ownership prompt", "thread-owned"));
    expect(create).toHaveBeenCalledExactlyOnceWith("https://chatgpt.com/");
    expect(replacement.navigations).toEqual(["https://chatgpt.com/c/thread-owned"]);
    expect(binding).toMatchObject({
      tabId: "tab-replacement",
      conversationId: "thread-owned"
    });
  });

  it("waits for a replacement conversation tab to hydrate the owned user turn", async () => {
    const replacement = new FakePage("https://chatgpt.com/");
    replacement.id = "tab-hydrating";
    replacement.onNavigate = () => {
      const before = replacement.waits;
      replacement.onWait = () => {
        if (replacement.waits >= before + 2) replacement.users = ["ownership prompt"];
      };
    };
    const port = new ChatGPTBrowserPort({
      browser: {
        tabs: {
          get: async () => { throw new Error("closed"); },
          create: async () => replacement
        }
      }
    }, { pollMs: 1 });

    await expect(port.bindHandle(handle("ownership prompt", "thread-owned")))
      .resolves.toMatchObject({ tabId: "tab-hydrating", conversationId: "thread-owned" });
    expect(replacement.waits).toBeGreaterThanOrEqual(2);
  });

  it("exposes a narrow BridgePort factory", () => {
    expect(createBrowserBridgePort({ page: new FakePage("https://chatgpt.com/") }))
      .toBeInstanceOf(ChatGPTBrowserPort);
  });
});

class FakePage implements BrowserPage {
  id = "tab-1";
  currentUrl: string;
  users: string[] = [];
  userTurnIds: Array<string | null> = [];
  assistants: string[] = [];
  assistantTurnIds: Array<string | null> = [];
  composer = "";
  attachmentNames: string[] = [];
  attachmentMenuVisible = false;
  activeToolLabels: string[] = [];
  powerLabel = "Instant";
  powerOpenerCount = 1;
  renderedOnSend: string | undefined;
  responseActions = false;
  generating = false;
  sendClicks = 0;
  sendKeyPresses = 0;
  copyClicks = 0;
  powerMenuVisible = false;
  powerControlStaleVisible = false;
  powerOpenerClicks = 0;
  cdpSupported = false;
  cdpCommands: string[] = [];
  powerSliderPresses = 0;
  throwBeforePowerClose = false;
  throwBeforePowerOpen = false;
  throwAfterPowerClose = false;
  mainReady = true;
  composerReady = true;
  waits = 0;
  navigations: string[] = [];
  onSend: () => void = () => undefined;
  onCopy: () => void = () => undefined;
  onWait: () => void = () => undefined;
  onNavigate: () => void = () => undefined;

  constructor(url: string) { this.currentUrl = url; }

  url = () => this.currentUrl;
  goto = async (url: string) => {
    this.navigations.push(url);
    this.currentUrl = url;
    this.onNavigate();
  };
  waitForTimeout = async () => {
    this.waits += 1;
    this.onWait();
  };
  capabilities = {
    get: async (id: string) => id === "cdp" && this.cdpSupported
      ? {
        send: async (
          method: string,
          params?: Record<string, unknown>,
          options?: { timeoutMs?: number }
        ) => {
          expect(options).toEqual({ timeoutMs: 10_000 });
          const type = String(params?.type ?? "");
          this.cdpCommands.push(`${method}:${type}`);
          if (method === "Input.dispatchMouseEvent" && type === "mouseReleased") {
            if (params?.x === 140) {
              this.powerMenuVisible = !this.powerMenuVisible;
            }
          }
        }
      }
      : undefined
  };

  locator = (selector: string): BrowserLocator => {
    if (selector === "main") {
      return {
        count: async () => this.mainReady ? 1 : 0,
        isVisible: async () => this.mainReady
      };
    }
    if (selector === "main form:has(#prompt-textarea), form:has(#prompt-textarea)") {
      return {
        count: async () => this.composerReady ? 1 : 0,
        isVisible: async () => this.composerReady,
        filter() { return this; },
        evaluate: async <T>() => ({
          attachmentNames: [...this.attachmentNames],
          toolLabels: [...this.activeToolLabels]
        }) as T
      };
    }
    if (selector === "#prompt-textarea") return this.composerLocator();
    if (selector === "button[data-testid='send-button']") return this.sendLocator();
    if (selector === "[role='menuitem'][aria-label='Power']") {
      return this.powerControlLocator();
    }
    if (selector === "[role='menuitem'][aria-label='Power'] [role='slider']") {
      return {
        count: async () => this.powerMenuVisible ? 1 : 0,
        press: async () => { this.powerSliderPresses += 1; }
      };
    }
    if (selector === "form:has(#prompt-textarea) button[aria-haspopup='menu']"
      && this.attachmentMenuVisible) {
      return {
        count: async () => 2,
        isVisible: async () => true,
        filter() { return this; }
      };
    }
    if (selector === "form:has(#prompt-textarea) button.__composer-pill[aria-haspopup='menu']") {
      return {
        count: async () => this.powerOpenerCount,
        isVisible: async () => true,
        filter() { return this; },
        click: async () => {
          const wasOpen = this.powerMenuVisible;
          this.powerOpenerClicks += 1;
          if (!wasOpen && this.throwBeforePowerOpen) {
            throw new Error("transport failed before Power toggle");
          }
          if (wasOpen && this.throwBeforePowerClose) {
            throw new Error("transport failed before Power toggle");
          }
          this.powerMenuVisible = !wasOpen;
          if (wasOpen && this.throwAfterPowerClose) {
            throw new Error("transport closed after Power toggle");
          }
        },
        evaluate: async <T>(fn: (element: Element) => T) =>
          String(fn).includes("aria-expanded") && String(fn).includes("tagName")
            ? ({
                tagName: "BUTTON",
                role: null,
                hasPopup: "menu",
                expanded: this.powerMenuVisible ? "true" : "false",
                label: this.powerLabel
              } as T)
            : String(fn).includes("getBoundingClientRect")
              ? ({ x: 100, y: 100, width: 80, height: 36 } as T)
              : (this.powerLabel as T)
      };
    }
    if (selector === 'main [data-message-author-role="assistant"]') {
      const only = this.assistantLocator(0);
      return {
        count: async () => this.assistants.length,
        nth: index => this.assistantLocator(index),
        isVisible: only.isVisible!,
        evaluate: only.evaluate!,
        locator: only.locator!
      };
    }
    return { count: async () => 0, filter() { return this; } };
  };

  evaluate = async <T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> => {
    const source = String(fn);
    if (source.includes("accountSelector") && source.includes("conversationLinks")) {
      return {
        account: true,
        composer: true,
        conversationLinks: this.currentUrl.includes("/c/") ? 1 : 0,
        messages: this.users.length + this.assistants.length > 0,
        login: false
      } as T;
    }
    if (source.includes("artifactCandidates") && source.includes("responseActionsVisible")) {
      const requested = (arg ?? {}) as {
        userIndex?: number;
        assistantIndex?: number;
        includeAssistantText?: boolean;
      };
      const assistantIndex = requested.assistantIndex;
      return {
        userCount: this.users.length,
        assistantCount: this.assistants.length,
        ...(requested.userIndex === undefined || this.users[requested.userIndex] === undefined
          ? {}
          : { userText: this.users[requested.userIndex] }),
        ...(requested.userIndex === undefined || this.userTurnIds[requested.userIndex] === undefined
          ? {}
          : { userTurnId: this.userTurnIds[requested.userIndex] }),
        ...(requested.includeAssistantText !== true
          || assistantIndex === undefined
          || this.assistants[assistantIndex] === undefined
          ? {}
          : { assistantText: this.assistants[assistantIndex] }),
        ...(assistantIndex === undefined || this.assistantTurnIds[assistantIndex] === undefined
          ? {}
          : { assistantTurnId: this.assistantTurnIds[assistantIndex] }),
        pageStopVisible: this.generating,
        responseActionsVisible: this.responseActions,
        artifactCandidates: []
      } as T;
    }
    throw new Error(`Unexpected page evaluation: ${source.slice(0, 80)}`);
  };

  private composerLocator(): BrowserLocator {
    return {
      count: async () => this.composerReady ? 1 : 0,
      isVisible: async () => this.composerReady,
      filter() { return this; },
      fill: async value => { this.composer = value; },
      press: async key => {
        expect(key).toBe("Enter");
        this.sendKeyPresses += 1;
        if (this.renderedOnSend !== undefined) this.users.push(this.renderedOnSend);
        this.onSend();
      },
      evaluate: async <T>(fn: (element: Element) => T) => {
        const source = String(fn);
        if (source.includes("tagName.toLowerCase")) return this.composer as T;
        throw new Error("Unexpected composer evaluation");
      }
    };
  }

  private sendLocator(): BrowserLocator {
    return {
      count: async () => 1,
      isVisible: async () => true,
      filter() { return this; },
      evaluate: async <T>(fn: (element: Element) => T) =>
        String(fn).includes("getBoundingClientRect")
          ? ({ x: 300, y: 100, width: 80, height: 36 } as T)
          : ({ disabled: false, busy: false } as T),
      click: async () => {
        this.sendClicks += 1;
        if (this.renderedOnSend !== undefined) this.users.push(this.renderedOnSend);
        this.onSend();
      }
    };
  }

  private powerControlLocator(): BrowserLocator {
    return {
      count: async () => this.powerMenuVisible || this.powerControlStaleVisible ? 1 : 0,
      isVisible: async () => this.powerMenuVisible || this.powerControlStaleVisible,
      filter() { return this; },
      press: async () => undefined,
      evaluate: async <T>(fn: (element: Element) => T) => {
        const source = String(fn);
        if (source.includes("aria-valuemin")) {
          return { min: "0", max: "0", now: "0" } as T;
        }
        if (source.includes("aria-describedby")) {
          return [{ text: `${this.powerLabel}, 1 of 1.`, announcement: true }] as T;
        }
        throw new Error("Unexpected Power evaluation");
      }
    };
  }

  private assistantLocator(index: number): BrowserLocator {
    const copy: BrowserLocator = {
      count: async () => this.responseActions ? 1 : 0,
      isVisible: async () => this.responseActions,
      click: async () => {
        this.copyClicks += 1;
        this.onCopy();
      }
    };
    const container: BrowserLocator = {
      count: async () => 1,
      locator: selector => selector === 'button[data-testid="copy-turn-action-button"]'
        ? copy
        : { count: async () => 0 }
    };
    return {
      isVisible: async () => true,
      evaluate: async <T>() => this.assistantTurnIds[index] as T,
      locator: () => container
    };
  }
}

function handle(prompt: string, conversationId: string): BridgeHandle {
  return {
    version: 1,
    operationId: "operation-1",
    promptSha256: sha256(prompt),
    renderedPromptSha256: sha256(prompt),
    createdAt: "2026-08-14T12:00:00.000Z",
    threadUrl: `https://chatgpt.com/c/${conversationId}`,
    conversationId,
    tabId: "tab-1",
    userTurnBefore: 0,
    assistantTurnBefore: 0
  };
}

function recoveryHandle(prompt: string, names: readonly string[]): BridgeHandle {
  const { renderedPromptSha256: _rendered, ...base } = handle(prompt, "thread-owned");
  return {
    ...base,
    ...(names.length === 0 ? {} : { attachmentCount: names.length }),
    promptPresentationSha256s: promptPresentationSha256s(prompt)
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
