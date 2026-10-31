const { test: base, expect } = require("@playwright/test");
const { version: appVersion } = require("../../tauri.conf.json");

const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [], httpErrors: [] };
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      diagnostics.failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText ?? "unknown request failure",
      });
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        diagnostics.httpErrors.push({ status: response.status(), url: response.url() });
      }
    });

    await use(page);

    const hasBrowserDiagnostics = Object.values(diagnostics).some((items) => items.length > 0);
    if (testInfo.status === "failed" || hasBrowserDiagnostics) {
      await testInfo.attach("browser-diagnostics.json", {
        body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
        contentType: "application/json",
      });
    }
    expect(diagnostics.pageErrors, "uncaught browser exceptions").toEqual([]);
    expect(diagnostics.consoleErrors, "browser console errors").toEqual([]);
    expect(diagnostics.failedRequests, "failed browser requests").toEqual([]);
    expect(diagnostics.httpErrors, "HTTP responses with an error status").toEqual([]);
  },
});

function quota(remaining, windowDurationMins) {
  return {
    remainingPercent: String(remaining),
    resetsAt: 1_792_000_000,
    windowDurationMins,
    usedPercent: String(100 - remaining),
  };
}

function usageState(remaining5h = 72, remainingWeekly = 64, status = "online") {
  return {
    status,
    lastUpdatedAt: 1_791_999_000_000,
    fiveHour: remaining5h === null ? null : quota(remaining5h, 300),
    weekly: remainingWeekly === null ? null : quota(remainingWeekly, 10_080),
  };
}

async function installTauriMock(page, options = {}, route = "/") {
  const initialMode = options.settings?.ultraCompact === true;
  const initialSize = initialMode
    ? options.settings?.ultraCompactWindowSize ?? { width: 300, height: 156 }
    : options.settings?.normalWindowSize ?? { width: 360, height: 220 };
  await page.setViewportSize(route.endsWith("/tray.html")
    ? { width: 320, height: 128 }
    : initialSize);
  await page.exposeFunction("__mockResizeNativeWindow", async (size) => {
    await page.setViewportSize({ width: size.width, height: size.height });
  });
  await page.addInitScript((config) => {
    const defaults = {
      threshold5h: 20,
      thresholdWeekly: 20,
      alwaysOnTop: true,
      closeAction: "ask",
      language: "en",
      soundEnabled: false,
      ultraCompact: false,
      normalWindowSize: { width: 360, height: 220 },
      ultraCompactWindowSize: { width: 300, height: 156 },
    };
    let settings;
    try {
      settings = JSON.parse(localStorage.getItem("wimu-ui-settings"));
    } catch {
      settings = null;
    }
    if (!settings || typeof settings !== "object") {
      settings = config.settings && typeof config.settings === "object"
        ? { ...defaults, ...config.settings }
        : { ...defaults };
    }
    let currentUsage = config.usageState ?? {
      status: "online",
      lastUpdatedAt: 1_791_999_000_000,
      fiveHour: {
        windowDurationMins: 300,
        usedPercent: "28",
        remainingPercent: "72",
        resetsAt: 1_792_000_000,
      },
      weekly: {
        windowDurationMins: 10_080,
        usedPercent: "36",
        remainingPercent: "64",
        resetsAt: 1_792_000_000,
      },
    };
    let usageRevision = currentUsage.revision ?? 1;
    currentUsage = { ...currentUsage, revision: usageRevision };
    const listeners = new Map();
    const resizeListeners = new Set();
    const calls = [];
    const failures = new Set(config.failures ?? []);
    const scaleFactor = Number.isFinite(config.scaleFactor) && config.scaleFactor > 0
      ? config.scaleFactor
      : 1;
    let nativeUltraCompact = settings.ultraCompact === true;
    let settingsLoaded = false;
    let skipNativeResize = config.resizeFailure === true;

    window.__mockCalls = calls;
    window.__mockAudioCalls = [];
    window.Audio = class {
      constructor(source) {
        this.src = new URL(source, window.location.href).toString();
      }
      play() {
        window.__mockAudioCalls.push(this.src);
        return Promise.resolve();
      }
    };
    window.__mockFailures = failures;
    window.__mockCurrentUsage = currentUsage;
    window.__mockGetSettings = () => ({ ...settings });
    window.__mockTooltipValues = [];
    window.__mockDragCalls = [];
    window.__mockPanelShown = false;
    window.__mockPanelStateAtShow = null;
    window.__mockWindowResizeEvents = [];
    window.__mockEmitPreferences = (payload) => {
      settings = { ...settings, ...payload };
      for (const listener of listeners.get("preferences-updated") ?? []) listener({ payload });
    };
    window.__mockEmitUsage = (payload) => {
      const revision = payload.revision ?? usageRevision + 1;
      usageRevision = Math.max(usageRevision, revision);
      const next = { ...payload, revision };
      if (revision >= (currentUsage.revision ?? 0)) currentUsage = next;
      window.__mockCurrentUsage = currentUsage;
      for (const listener of listeners.get("usage-state") ?? []) listener({ payload: next });
    };
    window.__mockEmitRestored = () => { for (const listener of listeners.get("panel-restored") ?? []) listener({ payload: null }); };
    window.__mockEmitCloseRequested = () => {
      for (const listener of listeners.get("close-requested") ?? []) listener({ payload: null });
    };

    window.__TAURI__ = {
      core: {
        invoke: async (command, args = {}) => {
          calls.push({ command, args });
          if (failures.has(command)) throw new Error(`Mock failure: ${command}`);
          switch (command) {
            case "get_app_version":
              return config.versionFailure
                ? Promise.reject(new Error("Version unavailable"))
                : (config.appVersion ?? config.buildVersion);
            case "get_usage_state": {
              const snapshot = { ...currentUsage };
              if (config.usageReadDelayMs) await new Promise((resolve) => setTimeout(resolve, config.usageReadDelayMs));
              if (config.usageFailure) throw new Error("Usage limits unavailable");
              return snapshot;
            }
            case "load_settings":
              if (config.loadFailure) throw new Error("Settings unavailable");
              if (config.settingsLoadDelayMs) {
                await new Promise((resolve) => window.setTimeout(resolve, config.settingsLoadDelayMs));
              }
              settingsLoaded = true;
              return { ...settings };
            case "save_settings":
              if (config.saveFailure) throw new Error("Settings could not be saved");
              if (config.saveDelayMs) await new Promise((resolve) => setTimeout(resolve, config.saveDelayMs));
              settings = {
                ...settings,
                ...args.settings,
                normalWindowSize: settings.normalWindowSize,
                ultraCompactWindowSize: settings.ultraCompactWindowSize,
              };
              localStorage.setItem("wimu-ui-settings", JSON.stringify(settings));
              return { ...settings };
            case "set_ultra_compact": {
              const previousMode = nativeUltraCompact;
              nativeUltraCompact = args.ultraCompact;
              if (typeof args.preferredUltraCompact === "boolean") {
                settings = { ...settings, ultraCompact: args.preferredUltraCompact };
                localStorage.setItem("wimu-ui-settings", JSON.stringify(settings));
              }
              const defaults = args.ultraCompact
                ? { width: 300, height: 156 }
                : { width: 360, height: 220 };
              const savedSize = args.ultraCompact
                ? settings.ultraCompactWindowSize
                : settings.normalWindowSize;
              const size = savedSize ?? defaults;
              const payload = {
                width: Math.round(size.width * scaleFactor),
                height: Math.round(size.height * scaleFactor),
              };
              if (skipNativeResize && args.ultraCompact !== previousMode) {
                skipNativeResize = false;
              } else {
                await window.__mockResizeNativeWindow(size);
                window.__mockWindowResizeEvents.push(payload);
                for (const listener of resizeListeners) listener({ payload });
              }
              return { width: size.width, height: size.height };
            }
            case "fit_settings_window": {
              const size = { width: innerWidth, height: Math.ceil(args.contentHeight) };
              await window.__mockResizeNativeWindow(size);
              for (const listener of resizeListeners) listener({ payload: { width: Math.round(size.width * scaleFactor), height: Math.round(size.height * scaleFactor) } });
              return size;
            }
            case "get_native_window_mode":
              return nativeUltraCompact;
            case "show_main_panel":
              window.__mockPanelShown = true;
              window.__mockPanelStateAtShow = {
                ultraCompact: document.querySelector(".app-shell")?.dataset.ultraCompact,
                viewport: { width: innerWidth, height: innerHeight },
                settingsLoaded,
              };
              return undefined;
            case "set_always_on_top":
              return undefined;
            case "set_tray_tooltips":
              window.__mockTooltipValues.push({ ...args });
              return undefined;
            case "hide_tray_popup":
              return undefined;
            case "minimize_panel":
              return undefined;
            case "quit_app":
              return undefined;
            default:
              throw new Error(`Unexpected Tauri command: ${command}`);
          }
        },
      },
      event: {
        listen: async (eventName, callback) => {
          if (config.listenFailure) throw new Error("Event listener unavailable");
          const eventListeners = listeners.get(eventName) ?? [];
          eventListeners.push(callback);
          listeners.set(eventName, eventListeners);
          if (eventName === "usage-state" && config.usageEventOnListen) {
            window.__mockEmitUsage(config.usageEventOnListen);
          }
          return () => {};
        },
      },
      window: {
        getCurrentWindow: () => ({
          onResized: async (callback) => {
            resizeListeners.add(callback);
            return () => resizeListeners.delete(callback);
          },
          innerSize: async () => ({
            width: Math.round(innerWidth * scaleFactor),
            height: Math.round(innerHeight * scaleFactor),
          }),
          scaleFactor: async () => scaleFactor,
          startResizeDragging: async () => {},
          startDragging: async () => {
            window.__mockDragCalls.push("start");
          },
        }),
      },
    };
  }, { buildVersion: appVersion, ...options });

  await page.goto(route);
  if (options.waitForInitialization !== false) {
    if (route.endsWith("/tray.html")) {
      await page.waitForFunction(() => window.__mockCalls?.some((call) => call.command === "load_settings")
        && window.__mockCalls?.some((call) => call.command === "get_usage_state")
        && window.__mockTooltipValues?.length > 1);
    } else {
      await page.waitForFunction(() => window.__mockPanelShown === true);
    }
  }
}

module.exports = { test, expect, installTauriMock, usageState, appVersion };
