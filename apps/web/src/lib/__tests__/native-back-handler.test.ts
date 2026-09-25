// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native-platform", () => ({
  isNativePlatform: () => true,
}));

interface BackButtonPlugin {
  addListener: (event: string, handler: (data: { canGoBack: boolean }) => void) => Promise<{ remove: () => void }>;
  exitApp: () => Promise<void>;
}

async function loadModule() {
  vi.resetModules();
  return import("../native-back-handler");
}

describe("native-back-handler", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("registers the back button listener and navigates back for an active thread", async () => {
    let backButtonHandler: ((data: { canGoBack: boolean }) => void) | null = null;
    const exitApp = vi.fn(async () => {});
    const addListener = vi.fn(async (_event: string, handler: (data: { canGoBack: boolean }) => void) => {
      backButtonHandler = handler;
      return { remove: () => {} };
    });

    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      value: {
        isNativePlatform: () => true,
        App: {
          addListener,
          exitApp,
        },
      },
    });

    window.history.pushState(null, "", "/?chat=user-1");
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});

    const { initNativeBackHandler } = await loadModule();
    initNativeBackHandler();

    expect(addListener).toHaveBeenCalledWith("backButton", expect.any(Function));
    expect(backButtonHandler).not.toBeNull();

    backButtonHandler?.({ canGoBack: false });

    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("navigates back when the active thread param is not the first query param", async () => {
    let backButtonHandler: ((data: { canGoBack: boolean }) => void) | null = null;
    const exitApp = vi.fn(async () => {});
    const addListener = vi.fn(async (_event: string, handler: (data: { canGoBack: boolean }) => void) => {
      backButtonHandler = handler;
      return { remove: () => {} };
    });

    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      value: {
        isNativePlatform: () => true,
        App: {
          addListener,
          exitApp,
        },
      },
    });

    window.history.pushState(null, "", "/?devtools=1&chat=user-1");
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});

    const { initNativeBackHandler } = await loadModule();
    initNativeBackHandler();
    backButtonHandler?.({ canGoBack: false });

    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("navigates back from saved messages when saved is not the first query param", async () => {
    let backButtonHandler: ((data: { canGoBack: boolean }) => void) | null = null;
    const exitApp = vi.fn(async () => {});
    const addListener = vi.fn(async (_event: string, handler: (data: { canGoBack: boolean }) => void) => {
      backButtonHandler = handler;
      return { remove: () => {} };
    });

    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      value: {
        isNativePlatform: () => true,
        App: {
          addListener,
          exitApp,
        },
      },
    });

    window.history.pushState(null, "", "/?devtools=1&saved=1");
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});

    const { initNativeBackHandler } = await loadModule();
    initNativeBackHandler();
    backButtonHandler?.({ canGoBack: false });

    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("closes the topmost registered overlay before navigating back or exiting", async () => {
    let backButtonHandler: ((data: { canGoBack: boolean }) => void) | null = null;
    const exitApp = vi.fn(async () => {});
    const addListener = vi.fn(async (_event: string, handler: (data: { canGoBack: boolean }) => void) => {
      backButtonHandler = handler;
      return { remove: () => {} };
    });

    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      value: {
        isNativePlatform: () => true,
        App: {
          addListener,
          exitApp,
        },
      },
    });

    const { initNativeBackHandler, pushBackHandler } = await loadModule();
    const lowerHandler = vi.fn();
    const topHandler = vi.fn();
    pushBackHandler(lowerHandler);
    pushBackHandler(topHandler);

    initNativeBackHandler();
    backButtonHandler?.({ canGoBack: false });

    expect(topHandler).toHaveBeenCalledTimes(1);
    expect(lowerHandler).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });
});
