"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const appWindow = getCurrentWindow();
const translations = {
  en: {
    windowTitle: "WIMU",
    versionLoading: "Loading version",
    versionLabel: "Version {version}",
    versionUnavailable: "Version unavailable",
    windowActions: "Window actions",
    alwaysOnTopLabel: "Keep the window on top",
    settingsButton: "Settings",
    soundAlertsOn: "Mute sound alerts",
    soundAlertsOff: "Enable sound alerts",
    back: "Back",
    minimize: "Minimize",
    close: "Close",
    ultraCompactOff: "Turn on ultra-compact mode",
    ultraCompactOn: "Turn off ultra-compact mode",
    windowSizeError: "Could not change the window size.",
    usageLimits: "Usage limits",
    fiveHour: "5 hours",
    weekly: "Weekly",
    remaining: "remaining",
    fiveHourProgress: "Percentage remaining in the 5-hour window",
    weeklyProgress: "Percentage remaining in the weekly window",
    resetUnavailable: "Reset time unavailable",
    resetSameDay: "Resets at {time}",
    resetOtherDay: "Resets {date} at {time}",
    statusConnecting: "Connecting…",
    statusRefreshing: "Updating limits…",
    statusReconnecting: "Reconnecting. Limits unavailable.",
    statusStale: "Could not update usage limits.",
    statusDisconnected: "Could not retrieve usage limits.",
    statusNeedsLogin: "Sign in to Codex to view your limits.",
    statusCliMissing: "Codex CLI not found. Install it and restart the app.",
    statusCliCheckFailed: "Could not check Codex CLI. Retrying automatically.",
    statusIncompatible: "This WIMU build can't read your Codex CLI. Update WIMU or Codex CLI and restart.",
    statusDefault: "Could not retrieve usage limits.",
    quotaUnavailable: "Usage limit unavailable.",
    quotaAria: "{percent} remaining; alert threshold {threshold}.",
    settingsTitle: "Settings",
    settingsTabsLabel: "Settings sections",
    generalTab: "General",
    limitsTab: "Limits",
    languageLabel: "Language",
    closeSettingLabel: "When closing the window",
    rememberedMinimize: "Minimize in the tray",
    rememberedQuit: "Exit WIMU",
    askEveryTime: "Ask every time",
    thresholdPrompt: "Notify me when it drops to",
    fiveHourThresholdLabel: "5-hour remaining threshold, percent",
    weeklyThresholdLabel: "Weekly remaining threshold, percent",
    saveError: "Could not save changes.",
    preferencesError: "Could not load preferences.",
    eventsError: "Could not subscribe to usage updates.",
    presentationError: "Could not load display colors.",
    invalidThreshold: "Enter a whole number from 0 to 100.",
    topmostError: "Could not change always-on-top.",
    closePreferenceError: "Could not save this choice. Please try again.",
    closeActionError: "Could not change the close behavior.",
    closeDialogTitle: "What would you like to do?",
    closeDialogBody: "Minimize to the tray or quit WIMU.",
    rememberCloseChoice: "Remember my choice",
    cancel: "Cancel",
    minimizeAction: "Minimize",
    minimizeToTray: "Minimize in the tray",
    quitAction: "Quit",
    quitWimu: "Quit WIMU",
  },
  es: {
    windowTitle: "WIMU",
    versionLoading: "Cargando versión",
    versionLabel: "Versión {version}",
    versionUnavailable: "Versión no disponible",
    windowActions: "Acciones de la ventana",
    alwaysOnTopLabel: "Mantener la ventana siempre encima",
    settingsButton: "Configuración",
    soundAlertsOn: "Silenciar alertas de sonido",
    soundAlertsOff: "Activar alertas de sonido",
    back: "Volver",
    minimize: "Minimizar",
    close: "Cerrar",
    ultraCompactOff: "Activar modo ultracompacto",
    ultraCompactOn: "Desactivar modo ultracompacto",
    windowSizeError: "No se pudo cambiar el tamaño de la ventana.",
    usageLimits: "Límites de uso",
    fiveHour: "5 horas",
    weekly: "Semanal",
    remaining: "restante",
    fiveHourProgress: "Porcentaje restante en la ventana de 5 horas",
    weeklyProgress: "Porcentaje restante en la ventana semanal",
    resetUnavailable: "Restablecimiento no disponible",
    resetSameDay: "Se restablece a las {time}",
    resetOtherDay: "Se restablece el {date} a las {time}",
    statusConnecting: "Conectando…",
    statusRefreshing: "Actualizando límites…",
    statusReconnecting: "Reconectando. Los límites no están disponibles por ahora.",
    statusStale: "No se pudieron actualizar los límites.",
    statusDisconnected: "No se pudieron consultar los límites.",
    statusNeedsLogin: "Iniciá sesión en Codex para consultar los límites.",
    statusCliMissing: "Falta Codex CLI. Instalalo y reiniciá la app.",
    statusCliCheckFailed: "No se pudo comprobar Codex CLI. WIMU reintentará automáticamente.",
    statusIncompatible: "Esta versión de WIMU no puede leer tu Codex CLI. Actualizá WIMU o Codex CLI y reiniciá.",
    statusDefault: "No se pudieron consultar los límites.",
    quotaUnavailable: "Límite de uso no disponible.",
    quotaAria: "{percent} restante; umbral de aviso {threshold}.",
    settingsTitle: "Configuración",
    settingsTabsLabel: "Secciones de configuración",
    generalTab: "General",
    limitsTab: "Límites",
    languageLabel: "Idioma",
    closeSettingLabel: "Al cerrar la ventana",
    rememberedMinimize: "Minimizar en la bandeja",
    rememberedQuit: "Salir de WIMU",
    askEveryTime: "Preguntar cada vez",
    thresholdPrompt: "Avisarme cuando quede",
    fiveHourThresholdLabel: "Umbral de porcentaje restante para 5 horas",
    weeklyThresholdLabel: "Umbral de porcentaje restante semanal",
    saveError: "No se pudieron guardar los cambios.",
    preferencesError: "No se pudieron cargar las preferencias.",
    eventsError: "No se pudo recibir actualizaciones de uso.",
    presentationError: "No se pudieron cargar los colores.",
    invalidThreshold: "Ingresá un número entero entre 0 y 100.",
    topmostError: "No se pudo cambiar la opción de ventana siempre encima.",
    closePreferenceError: "No se pudo guardar la elección. Probá de nuevo.",
    closeActionError: "No se pudo cambiar el comportamiento al cerrar.",
    closeDialogTitle: "¿Qué querés hacer?",
    closeDialogBody: "Minimizá en la bandeja o salí de WIMU.",
    rememberCloseChoice: "Recordar mi elección",
    cancel: "Cancelar",
    minimizeAction: "Minimizar",
    minimizeToTray: "Minimizar en la bandeja",
    quitAction: "Salir",
    quitWimu: "Salir de WIMU",
  },
};

const initialSettings = {
  threshold5h: 20,
  thresholdWeekly: 20,
  uiScale: 100,
  alwaysOnTop: true,
  soundEnabled: false,
  closeAction: "ask",
  language: "en",
  ultraCompact: false,
};
let settings = { ...initialSettings };
let projectedSettings = { ...initialSettings };
let persistedSettings = { ...initialSettings };
let preferencesError = false;
let eventsError = false;
let presentationError = false;
let lastUsageRevision = -1;
let panelVisible = false;
let settingsFitChain = Promise.resolve();
let lastSettingsHeight = 0;
let settingsFitRevision = 0;
let changingView = false;
let resolveSettingsReady;
const settingsReady = new Promise((resolve) => {
  resolveSettingsReady = resolve;
});
let appVersion = null;
let appVersionStatus = "loading";
let nativeUltraCompact = false;
let nativeResizeListenerPromise = null;
let nativeResizeRevision = 0;
const nativeResizeWaiters = new Set();
let activeSettingsTab = "general";
let saveTimer = null;
let isSavingSettings = false;
let settingsWriteChain = Promise.resolve();
let saveMessageKey = "";
let saveMessageIsError = false;
let windowModeError = false;
let usageState = {
  status: "connecting",
  fiveHour: null,
  weekly: null,
};

const elements = {
  appShell: document.querySelector(".app-shell"),
  appVersionBadge: document.getElementById("app-version-badge"),
  connectionMessage: document.getElementById("connection-message"),
  dashboardView: document.getElementById("dashboard-view"),
  settingsPanel: document.getElementById("settings-panel"),
  settingsButton: document.getElementById("settings-button"),
  settingsIcon: document.querySelector("#settings-button .settings-icon"),
  backIcon: document.querySelector("#settings-button .back-icon"),
  soundToggle: document.getElementById("sound-toggle"),
  soundEnabledIcon: document.querySelector("#sound-toggle .lucide-icon--bell"),
  soundMutedIcon: document.querySelector("#sound-toggle .lucide-icon--bell-off"),
  generalTab: document.getElementById("general-tab"),
  limitsTab: document.getElementById("limits-tab"),
  generalPanel: document.getElementById("general-panel"),
  limitsPanel: document.getElementById("limits-panel"),
  languageEnButton: document.getElementById("language-en"),
  languageEsButton: document.getElementById("language-es"),
  fiveHourCard: document.getElementById("five-hour-card"),
  weeklyCard: document.getElementById("weekly-card"),
  fiveHourPercent: document.getElementById("five-hour-percent"),
  weeklyPercent: document.getElementById("weekly-percent"),
  fiveHourProgress: document.getElementById("five-hour-progress"),
  weeklyProgress: document.getElementById("weekly-progress"),
  fiveHourReset: document.getElementById("five-hour-reset"),
  weeklyReset: document.getElementById("weekly-reset"),
  threshold5hRange: document.getElementById("threshold-5h-range"),
  threshold5hValue: document.getElementById("threshold-5h-value"),
  thresholdWeeklyRange: document.getElementById("threshold-weekly-range"),
  thresholdWeeklyValue: document.getElementById("threshold-weekly-value"),
  alwaysOnTopToggle: document.getElementById("always-on-top-toggle"),
  ultraCompactButton: document.getElementById("ultra-compact-button"),
  ultraCompactIcon: document.querySelector("#ultra-compact-button .lucide-icon--compact"),
  expandIcon: document.querySelector("#ultra-compact-button .lucide-icon--expand"),
  saveMessages: [...document.querySelectorAll("[data-save-message]")],
  rememberedCloseSetting: document.getElementById("remembered-close-setting"),
  rememberedCloseText: document.getElementById("remembered-close-text"),
  resetClosePreferenceButton: document.getElementById("reset-close-preference-button"),
  minimizeButton: document.getElementById("minimize-button"),
  closeButton: document.getElementById("close-button"),
  closeDialog: document.getElementById("close-dialog"),
  rememberCloseChoice: document.getElementById("remember-close-choice"),
  closePreferenceError: document.getElementById("close-preference-error"),
  cancelCloseButton: document.getElementById("cancel-close-button"),
  minimizeCloseButton: document.getElementById("minimize-close-button"),
  quitCloseButton: document.getElementById("quit-close-button"),
};

function copy(key, values = {}) {
  const message = translations[settings.language]?.[key] ?? translations.en[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
}

function applyLocalization() {
  const language = settings.language === "es" ? "es" : "en";
  document.documentElement.lang = language === "es" ? "es-AR" : "en";
  document.title = copy("windowTitle");

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = copy(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
    element.setAttribute("aria-label", copy(element.dataset.i18nAria));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.title = copy(element.dataset.i18nTitle);
  });

  elements.languageEnButton.setAttribute("aria-pressed", String(language === "en"));
  elements.languageEsButton.setAttribute("aria-pressed", String(language === "es"));
  updateAlwaysOnTopToggle();
  updateUltraCompactButton();
  updateSettingsButtonLabel();
  updateSoundToggle();
  updateRememberedCloseSetting();
  renderSaveMessage();
  renderAppVersion();
  scheduleSettingsFit();
}

function renderAppVersion() {
  const loading = appVersionStatus === "loading";
  const label = appVersion
    ? copy("versionLabel", { version: appVersion })
    : copy(loading ? "versionLoading" : "versionUnavailable");
  elements.appVersionBadge.textContent = appVersion ? "v" + appVersion : loading ? "v…" : "v—";
  elements.appVersionBadge.setAttribute("aria-label", label);
  elements.appVersionBadge.title = label;
}

function formatPercent(value) {
  const sourceValue = String(value);
  return settings.language === "es"
    ? sourceValue.replace(".", ",") + " %"
    : sourceValue + "%";
}

function formatReset(epochSeconds) {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return copy("resetUnavailable");
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return copy("resetUnavailable");
  const locale = settings.language === "es" ? "es-AR" : "en-US";
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(reset);
  const now = new Date();
  const sameDay = reset.getFullYear() === now.getFullYear()
    && reset.getMonth() === now.getMonth()
    && reset.getDate() === now.getDate();
  if (sameDay) return copy("resetSameDay", { time });
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(reset);
  return copy("resetOtherDay", { date, time });
}

function statusCopy(status) {
  const keys = {
    connecting: "statusConnecting",
    refreshing: "statusRefreshing",
    reconnecting: "statusReconnecting",
    stale: "statusStale",
    disconnected: "statusDisconnected",
    needsLogin: "statusNeedsLogin",
    cliMissing: "statusCliMissing",
    cliCheckFailed: "statusCliCheckFailed",
    incompatible: "statusIncompatible",
  };
  return copy(keys[status] ?? "statusDefault");
}

function heatState(remaining) {
  const step = Math.min(9, Math.floor(Math.max(0, remaining) / 10));
  return "step-" + step;
}

function setMeterThreshold(meter, threshold) {
  const safeThreshold = Math.max(0, Math.min(100, Number(threshold) || 0));
  meter.style.setProperty("--threshold-position", String(safeThreshold) + "%");
}

function setQuotaHeat(card, meter, heat) {
  card.dataset.heat = heat;
  if (heat === "unavailable") {
    delete card.dataset.alert;
    for (const key of ["deep", "mid", "light"]) card.style.removeProperty("--water-" + key);
  }
  meter.dataset.heat = heat;
}

function renderQuota(card, percentNode, meter, resetNode, windowData, threshold) {
  card.classList.remove("quota--warning", "quota--critical", "quota--unavailable");
  setMeterThreshold(meter, threshold);

  if (!windowData) {
    card.classList.add("quota--unavailable");
    percentNode.textContent = "—";
    setQuotaHeat(card, meter, "unavailable");
    meter.style.setProperty("--meter-value", "0%");
    meter.removeAttribute("aria-valuenow");
    meter.setAttribute("aria-valuetext", copy("quotaUnavailable"));
    resetNode.textContent = copy("resetUnavailable");
    return;
  }

  const remaining = Number(windowData.remainingFraction) * 100;
  const remainingLabel = Number(windowData.remainingPercent);
  if (!Number.isFinite(remaining) || !Number.isFinite(remainingLabel)) {
    card.classList.add("quota--unavailable");
    percentNode.textContent = "—";
    setQuotaHeat(card, meter, "unavailable");
    meter.style.setProperty("--meter-value", "0%");
    meter.removeAttribute("aria-valuenow");
    meter.setAttribute("aria-valuetext", copy("quotaUnavailable"));
    resetNode.textContent = copy("resetUnavailable");
    return;
  }

  const boundedRemaining = Math.max(0, Math.min(100, remainingLabel));
  const remainingText = formatPercent(windowData.remainingPercent);
  percentNode.textContent = remainingText;
  meter.style.setProperty("--meter-value", String(boundedRemaining) + "%");
  setQuotaHeat(card, meter, heatState(boundedRemaining));
  card.dataset.alert = boundedRemaining <= threshold ? "critical" : boundedRemaining <= threshold + 5 ? "warning" : "none";
  const palette = window.UsageColors.palette(boundedRemaining, threshold);
  if (palette) for (const key of ["deep", "mid", "light"]) card.style.setProperty("--water-" + key, window.UsageColors.hex(palette[key]));
  meter.setAttribute("aria-valuenow", String(boundedRemaining));
  meter.setAttribute(
    "aria-valuetext",
    copy("quotaAria", { percent: remainingText, threshold: formatPercent(threshold) }),
  );
  resetNode.textContent = formatReset(Number(windowData.resetsAt));

  if (boundedRemaining <= threshold) card.classList.add("quota--warning");
  if (boundedRemaining <= Math.min(10, threshold)) card.classList.add("quota--critical");
}

function render() {
  if (!panelVisible) return;
  const canShowUsage = usageState.status === "online" || usageState.status === "refreshing";
  const hasUsageError = usageState.status !== "online";
  elements.appShell.dataset.hasStatus = String(hasUsageError || windowModeError || preferencesError || presentationError || eventsError);
  elements.connectionMessage.hidden = !hasUsageError && !windowModeError && !preferencesError && !presentationError && !eventsError;
  elements.connectionMessage.textContent = preferencesError ? copy("preferencesError") : presentationError ? copy("presentationError") : eventsError ? copy("eventsError") : windowModeError
    ? copy("windowSizeError")
    : statusCopy(usageState.status);
  renderQuota(
    elements.fiveHourCard,
    elements.fiveHourPercent,
    elements.fiveHourProgress,
    elements.fiveHourReset,
    canShowUsage ? usageState.fiveHour : null,
    settings.threshold5h,
  );
  renderQuota(
    elements.weeklyCard,
    elements.weeklyPercent,
    elements.weeklyProgress,
    elements.weeklyReset,
    canShowUsage ? usageState.weekly : null,
    settings.thresholdWeekly,
  );
  updateTrayTooltips();
}

function updateTrayTooltips() {
  if (!Number.isSafeInteger(usageState.revision)) return;
  const canShowUsage = usageState.status === "online" || usageState.status === "refreshing";
  const tooltip = (label, data) => `${label}: ${canShowUsage && data ? formatPercent(data.remainingPercent) + " " + copy("remaining") + " · " + formatReset(Number(data.resetsAt)) : copy("quotaUnavailable")}`;
  void invoke("set_tray_tooltips", {
    fiveHour: tooltip(copy("fiveHour"), usageState.fiveHour),
    weekly: tooltip(copy("weekly"), usageState.weekly),
    revision: usageState.revision,
  }).catch(() => {});
}

function acceptUsageState(next) {
  if (!next || !Number.isSafeInteger(next.revision) || next.revision <= lastUsageRevision) return;
  lastUsageRevision = next.revision;
  usageState = next;
  window.WimuSoundAlerts.accept(next, {
    fiveHour: settings.threshold5h,
    weekly: settings.thresholdWeekly,
  }, settings.soundEnabled);
  if (panelVisible) render();
  else updateTrayTooltips();
}

async function synchronizeUsage() {
  try { acceptUsageState(await invoke("get_usage_state")); }
  catch {
    if (lastUsageRevision < 0) { usageState = { status: "disconnected", fiveHour: null, weekly: null }; render(); }
  }
}

function renderSaveMessage() {
  for (const message of elements.saveMessages) {
    message.textContent = saveMessageKey ? copy(saveMessageKey) : "";
    message.hidden = !saveMessageKey;
    if (saveMessageIsError) message.dataset.error = "true";
    else message.removeAttribute("data-error");
  }
  scheduleSettingsFit();
}

function setSaveMessage(messageKey, isError = false) {
  saveMessageKey = messageKey;
  saveMessageIsError = isError;
  renderSaveMessage();
}

function settingsMatch(left, right) {
  return left.threshold5h === right.threshold5h
    && left.thresholdWeekly === right.thresholdWeekly
    && left.uiScale === right.uiScale
    && left.alwaysOnTop === right.alwaysOnTop
    && left.soundEnabled === right.soundEnabled
    && left.closeAction === right.closeAction
    && left.language === right.language
    && left.ultraCompact === right.ultraCompact;
}

function queueSettingsSave(delay = 300) {
  window.clearTimeout(saveTimer);
  setSaveMessage("");
  saveTimer = window.setTimeout(saveLatestSettings, delay);
}

function writeSettings(snapshot) {
  if (preferencesError) return Promise.reject(new Error("Preferences unavailable"));
  const keys = Object.keys(initialSettings);
  const patch = Object.fromEntries(keys.filter((key) => snapshot[key] !== projectedSettings[key]).map((key) => [key, snapshot[key]]));
  projectedSettings = { ...projectedSettings, ...patch };
  const operation = settingsWriteChain.catch(() => {}).then(() => invoke("save_settings", { settings: patch })).then((response) => {
    persistedSettings = { ...persistedSettings, ...response };
    for (const key of Object.keys(patch)) if (settings[key] === snapshot[key]) settings[key] = response[key];
    return { ...settings };
  }).catch((error) => { projectedSettings = { ...persistedSettings }; throw error; });
  settingsWriteChain = operation;
  return operation;
}

async function saveLatestSettings() {
  if (isSavingSettings) return;
  isSavingSettings = true;
  const snapshot = { ...settings };

  try {
    const response = await writeSettings(snapshot);
    if (settingsMatch(settings, snapshot)) {
      settings = { ...settings, ...response };
      setSaveMessage("");
    }
  } catch {
    if (settingsMatch(settings, snapshot)) setSaveMessage("saveError", true);
  } finally {
    isSavingSettings = false;
    if (!settingsMatch(settings, snapshot)) queueSettingsSave(0);
  }
}

function updateThreshold(key, value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) return;
  if (settings[key] === value) return;
  settings = { ...settings, [key]: value };
  render();
  queueSettingsSave();
}

function bindThreshold(range, number, key) {
  range.value = String(settings[key]);
  number.value = String(settings[key]);

  range.addEventListener("input", () => {
    const value = Number(range.value);
    number.value = String(value);
    updateThreshold(key, value);
  });

  number.addEventListener("input", () => {
    const rawValue = number.value.trim();
    const value = Number(rawValue);
    if (rawValue === "" || !/^\d*$/.test(rawValue) || !Number.isInteger(value) || value < 0 || value > 100) {
      if (rawValue !== "" && !/^\d*$/.test(rawValue)) number.value = String(settings[key]);
      setSaveMessage("invalidThreshold", true);
      return;
    }
    range.value = String(value);
    updateThreshold(key, value);
  });

  number.addEventListener("keydown", (event) => {
    if ([".", ",", "e", "E", "+", "-"].includes(event.key)) event.preventDefault();
  });

  number.addEventListener("change", () => {
    const value = Number(number.value);
    if (number.value.trim() === "" || !/^\d+$/.test(number.value.trim()) || !Number.isInteger(value) || value < 0 || value > 100) {
      number.value = String(settings[key]);
      range.value = String(settings[key]);
      setSaveMessage("invalidThreshold", true);
    }
  });
}

function updateAlwaysOnTopToggle() {
  elements.alwaysOnTopToggle.checked = settings.alwaysOnTop;
}

function updateSoundToggle() {
  const enabled = settings.soundEnabled;
  const label = copy(enabled ? "soundAlertsOn" : "soundAlertsOff");
  elements.soundToggle.setAttribute("aria-pressed", String(enabled));
  elements.soundToggle.setAttribute("aria-label", label);
  elements.soundToggle.title = label;
  elements.soundEnabledIcon.hidden = !enabled;
  elements.soundMutedIcon.hidden = enabled;
}

function toggleSoundAlerts() {
  settings = { ...settings, soundEnabled: !settings.soundEnabled };
  updateSoundToggle();
  queueSettingsSave(0);
}

function updateUltraCompactButton() {
  const isEnabled = settings.ultraCompact;
  const label = copy(isEnabled ? "ultraCompactOn" : "ultraCompactOff");
  elements.ultraCompactButton.setAttribute("aria-pressed", String(isEnabled));
  elements.ultraCompactButton.setAttribute("aria-label", label);
  elements.ultraCompactButton.title = label;
  elements.ultraCompactIcon.hidden = isEnabled;
  elements.expandIcon.hidden = !isEnabled;
}

async function ensureNativeResizeListener() {
  if (!nativeResizeListenerPromise) {
    nativeResizeListenerPromise = appWindow.onResized(({ payload }) => {
      nativeResizeRevision += 1;
      for (const waiter of nativeResizeWaiters) waiter(payload, nativeResizeRevision);
    });
  }
  await nativeResizeListenerPromise;
}

async function waitForNativeWindowSize(target, revisionBeforeRequest) {
  await ensureNativeResizeListener();
  const scaleFactor = await appWindow.scaleFactor();
  const expected = {
    width: Math.round(target.width * scaleFactor),
    height: Math.round(target.height * scaleFactor),
  };
  const matches = (size) => size
    && Math.abs(size.width - expected.width) <= 1
    && Math.abs(size.height - expected.height) <= 1;
  const current = await appWindow.innerSize();
  if (matches(current)) return;

  await new Promise((resolve, reject) => {
    let timeout;
    const waiter = (size, revision) => {
      if (revision <= revisionBeforeRequest || !matches(size)) return;
      nativeResizeWaiters.delete(waiter);
      window.clearTimeout(timeout);
      resolve();
    };
    nativeResizeWaiters.add(waiter);
    timeout = window.setTimeout(() => {
      nativeResizeWaiters.delete(waiter);
      reject(new Error("Native window resize was not confirmed"));
    }, 1500);
    void appWindow.innerSize().then((size) => {
      if (!matches(size)) return;
      nativeResizeWaiters.delete(waiter);
      window.clearTimeout(timeout);
      resolve();
    }).catch(() => {});
  });
}

function waitForPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

async function setNativeWindowCompact(
  isCompact,
  preferredUltraCompact = null,
  force = false,
  previousPreference = null,
) {
  if (nativeUltraCompact === isCompact && preferredUltraCompact === null && !force) {
    elements.appShell.dataset.ultraCompact = String(isCompact);
    return null;
  }
  await ensureNativeResizeListener();
  const revisionBeforeRequest = nativeResizeRevision;
  const args = { ultraCompact: isCompact };
  if (typeof preferredUltraCompact === "boolean") {
    args.preferredUltraCompact = preferredUltraCompact;
  }
  let commandSucceeded = false;
  const previousMode = nativeUltraCompact;
  try {
    const targetSize = await invoke("set_ultra_compact", args);
    commandSucceeded = true;
    if (!targetSize || !Number.isFinite(targetSize.width) || !Number.isFinite(targetSize.height)) {
      throw new Error("Native window size was not returned");
    }
    await waitForNativeWindowSize(targetSize, revisionBeforeRequest);
    nativeUltraCompact = isCompact;
    elements.appShell.dataset.ultraCompact = String(isCompact);
    return targetSize;
  } catch (error) {
    if (commandSucceeded) {
      try {
        const rollbackArgs = { ultraCompact: previousMode };
        if (typeof previousPreference === "boolean") {
          rollbackArgs.preferredUltraCompact = previousPreference;
        }
        const rollbackSize = await invoke("set_ultra_compact", rollbackArgs);
        await waitForNativeWindowSize(rollbackSize, nativeResizeRevision);
        nativeUltraCompact = previousMode;
      } catch {
        try {
          nativeUltraCompact = await invoke("get_native_window_mode");
        } catch {
          nativeUltraCompact = previousMode;
        }
      }
    }
    elements.appShell.dataset.ultraCompact = String(nativeUltraCompact);
    throw error;
  }
}

async function toggleUltraCompact() {
  if (changingView) return;
  changingView = true;
  const previousValue = settings.ultraCompact;
  const nextValue = !previousValue;
  const compactDashboard = nextValue && elements.settingsPanel.hidden;
  settings = { ...settings, ultraCompact: nextValue };
  updateUltraCompactButton();
  if (!elements.settingsPanel.hidden) {
    try { await writeSettings({ ...settings }); }
    catch { settings = { ...settings, ultraCompact: previousValue }; updateUltraCompactButton(); setSaveMessage("saveError", true); }
    changingView = false;
    scheduleSettingsFit();
    return;
  }
  const transitioning = nativeUltraCompact !== compactDashboard;
  if (transitioning) elements.appShell.dataset.modeTransition = "true";

  try {
    await settingsWriteChain.catch(() => {});
    await setNativeWindowCompact(compactDashboard, nextValue, false, previousValue);
    windowModeError = false;
    render();
    if (transitioning) {
      await waitForPaint();
      delete elements.appShell.dataset.modeTransition;
    }
  } catch {
    settings = { ...settings, ultraCompact: previousValue };
    updateUltraCompactButton();
    windowModeError = true;
    setSaveMessage("windowSizeError", true);
    render();
    if (transitioning) {
      await waitForPaint();
      delete elements.appShell.dataset.modeTransition;
    }
  }
  changingView = false;
}

async function toggleAlwaysOnTop() {
  const nextValue = elements.alwaysOnTopToggle.checked;
  elements.alwaysOnTopToggle.disabled = true;
  try {
    await invoke("set_always_on_top", { alwaysOnTop: nextValue });
    settings = { ...settings, alwaysOnTop: nextValue };
    queueSettingsSave(0);
  } catch {
    elements.alwaysOnTopToggle.checked = settings.alwaysOnTop;
    setSaveMessage("topmostError", true);
  } finally {
    elements.alwaysOnTopToggle.disabled = false;
  }
}

function updateSettingsButtonLabel() {
  const isVisible = !elements.settingsPanel.hidden;
  const label = copy(isVisible ? "back" : "settingsButton");
  elements.settingsButton.setAttribute("aria-label", label);
  elements.settingsButton.title = label;
  elements.settingsIcon.hidden = isVisible;
  elements.backIcon.hidden = !isVisible;
  elements.settingsButton.setAttribute("aria-expanded", String(isVisible));
}

function activateSettingsTab(tabName, moveFocus = false) {
  activeSettingsTab = tabName === "limits" ? "limits" : "general";
  const isGeneral = activeSettingsTab === "general";
  elements.generalTab.setAttribute("aria-selected", String(isGeneral));
  elements.generalTab.tabIndex = isGeneral ? 0 : -1;
  elements.limitsTab.setAttribute("aria-selected", String(!isGeneral));
  elements.limitsTab.tabIndex = isGeneral ? -1 : 0;
  elements.generalPanel.hidden = !isGeneral;
  elements.limitsPanel.hidden = isGeneral;
  if (moveFocus) (isGeneral ? elements.generalTab : elements.limitsTab).focus();
  scheduleSettingsFit();
}

async function fitSettingsWindow() {
  if (elements.settingsPanel.hidden) return;
  const shellStyle = getComputedStyle(elements.appShell);
  const header = document.querySelector(".window-actions");
  const height = Math.ceil(header.getBoundingClientRect().height + elements.settingsPanel.getBoundingClientRect().height
    + parseFloat(shellStyle.paddingTop) + parseFloat(shellStyle.paddingBottom)
    + parseFloat(shellStyle.borderTopWidth) + parseFloat(shellStyle.borderBottomWidth)
    + parseFloat(getComputedStyle(header).marginBottom)) + 1;
  if (height === lastSettingsHeight) return;
  lastSettingsHeight = height;
  const target = await invoke("fit_settings_window", { contentHeight: Math.max(120, height) });
  await waitForNativeWindowSize(target, nativeResizeRevision);
}

function scheduleSettingsFit() {
  if (changingView || elements.settingsPanel.hidden) return;
  const revision = ++settingsFitRevision;
  elements.appShell.dataset.modeTransition = "true";
  settingsFitChain = settingsFitChain.catch(() => {}).then(fitSettingsWindow).catch(() => {
    windowModeError = true;
    setSaveMessage("windowSizeError", true);
    render();
  }).finally(async () => { await waitForPaint(); if (!changingView && revision === settingsFitRevision) delete elements.appShell.dataset.modeTransition; });
}

new ResizeObserver(scheduleSettingsFit).observe(elements.settingsPanel);

async function setSettingsVisible(visible) {
  if (changingView) return;
  changingView = true;
  elements.appShell.dataset.modeTransition = "true";
  try {
    await settingsFitChain.catch(() => {});
    await setNativeWindowCompact(settings.ultraCompact && !visible, null, true);
    elements.dashboardView.hidden = visible;
    elements.settingsPanel.hidden = !visible;
    elements.appShell.dataset.view = visible ? "settings" : "dashboard";
    updateSettingsButtonLabel();
    windowModeError = false;
    lastSettingsHeight = 0;
    if (visible) {
      activateSettingsTab(activeSettingsTab);
      await waitForPaint();
      await fitSettingsWindow();
      (activeSettingsTab === "general" ? elements.generalTab : elements.limitsTab).focus();
    } else { elements.settingsButton.focus(); }
  } catch {
    if (visible) {
      elements.dashboardView.hidden = false;
      elements.settingsPanel.hidden = true;
      elements.appShell.dataset.view = "dashboard";
      updateSettingsButtonLabel();
      try { await setNativeWindowCompact(settings.ultraCompact, null, true); } catch {}
    }
    windowModeError = true;
    setSaveMessage("windowSizeError", true);
  } finally {
    render();
    await waitForPaint();
    delete elements.appShell.dataset.modeTransition;
    changingView = false;
  }
}

function setLanguage(language) {
  if (!Object.hasOwn(translations, language) || settings.language === language) return;
  settings = { ...settings, language };
  applyLocalization();
  render();
  queueSettingsSave();
}

function updateRememberedCloseSetting() {
  const action = settings.closeAction;
  elements.rememberedCloseSetting.hidden = action === "ask";
  if (action === "minimize") {
    elements.rememberedCloseText.textContent = copy("rememberedMinimize");
  } else if (action === "quit") {
    elements.rememberedCloseText.textContent = copy("rememberedQuit");
  } else {
    elements.rememberedCloseText.textContent = "";
  }
}

async function openCloseDialog() {
  await settingsReady;
  if (settings.closeAction === "minimize") {
    void minimizePanel();
    return;
  }
  if (settings.closeAction === "quit") {
    void quitApplication();
    return;
  }
  elements.rememberCloseChoice.checked = false;
  elements.closePreferenceError.hidden = true;
  if (!elements.closeDialog.open) elements.closeDialog.showModal();
}

document.querySelectorAll("[data-resize-direction]").forEach((edge) => {
  edge.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    appWindow.startResizeDragging(edge.dataset.resizeDirection).catch(() => {});
  });
});

document.querySelectorAll(".window-brand, .drag-handle").forEach((region) => {
  region.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button, input, select, a")) return;
    event.preventDefault();
    appWindow.startDragging().catch(() => {});
  });
});

function closeCloseDialog() {
  if (elements.closeDialog.open) elements.closeDialog.close();
  elements.closeButton.focus();
}

function setPanelVisible(visible) {
  panelVisible = visible;
  elements.appShell.dataset.panelVisible = String(visible);
  if (visible) render();
}

function restorePanel() {
  setPanelVisible(true);
  void synchronizeUsage();
}

async function minimizeFromCloseDialog() {
  await chooseCloseAction("minimize");
}

async function minimizePanel() {
  setPanelVisible(false);
  try {
    await invoke("minimize_panel");
  } catch {
    setPanelVisible(true);
  }
}

async function quitFromCloseDialog() {
  await chooseCloseAction("quit");
}

async function quitApplication() {
  try {
    await invoke("quit_app");
  } catch {
    // The backend owns shutdown; there is no safe frontend-only exit path.
  }
}

async function chooseCloseAction(action) {
  if (elements.rememberCloseChoice.checked) {
    const previousAction = settings.closeAction;
    window.clearTimeout(saveTimer);
    settings = { ...settings, closeAction: action };
    updateRememberedCloseSetting();
    try {
      const savedSettings = await writeSettings({ ...settings });
      settings = { ...settings, ...savedSettings };
      setSaveMessage("");
      updateRememberedCloseSetting();
    } catch {
      settings = { ...settings, closeAction: previousAction };
      updateRememberedCloseSetting();
      elements.closePreferenceError.textContent = copy("closePreferenceError");
      elements.closePreferenceError.hidden = false;
      return;
    }
  }

  closeCloseDialog();
  if (action === "minimize") await minimizePanel();
  else await quitApplication();
}

async function resetClosePreference() {
  const previousAction = settings.closeAction;
  if (previousAction === "ask") return;
  window.clearTimeout(saveTimer);
  settings = { ...settings, closeAction: "ask" };
  updateRememberedCloseSetting();
  setSaveMessage("");
  try {
    const savedSettings = await writeSettings({ ...settings });
    settings = { ...settings, ...savedSettings };
    setSaveMessage("");
    updateRememberedCloseSetting();
  } catch {
    settings = { ...settings, closeAction: previousAction };
    updateRememberedCloseSetting();
    setSaveMessage("closeActionError", true);
  }
}

elements.minimizeButton.addEventListener("click", minimizePanel);
elements.soundToggle.addEventListener("click", toggleSoundAlerts);
elements.alwaysOnTopToggle.addEventListener("change", toggleAlwaysOnTop);
elements.ultraCompactButton.addEventListener("click", toggleUltraCompact);
elements.settingsButton.addEventListener("click", () => {
  void setSettingsVisible(elements.settingsPanel.hidden);
});
elements.closeButton.addEventListener("click", openCloseDialog);
elements.cancelCloseButton.addEventListener("click", closeCloseDialog);
elements.minimizeCloseButton.addEventListener("click", minimizeFromCloseDialog);
elements.quitCloseButton.addEventListener("click", quitFromCloseDialog);
elements.resetClosePreferenceButton.addEventListener("click", resetClosePreference);
elements.languageEnButton.addEventListener("click", () => setLanguage("en"));
elements.languageEsButton.addEventListener("click", () => setLanguage("es"));
elements.generalTab.addEventListener("click", () => activateSettingsTab("general"));
elements.limitsTab.addEventListener("click", () => activateSettingsTab("limits"));
document.querySelector(".settings-tabs").addEventListener("keydown", (event) => {
  const tabs = [elements.generalTab, elements.limitsTab];
  const activeIndex = tabs.indexOf(document.activeElement);
  if (activeIndex < 0) return;
  let nextIndex = activeIndex;
  if (event.key === "ArrowRight") nextIndex = (activeIndex + 1) % tabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (activeIndex + tabs.length - 1) % tabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;
  else return;
  event.preventDefault();
  activateSettingsTab(nextIndex === 0 ? "general" : "limits", true);
});

elements.closeDialog.addEventListener("cancel", () => {
  window.requestAnimationFrame(() => elements.closeButton.focus());
});
elements.closeDialog.addEventListener("click", (event) => {
  if (event.target === elements.closeDialog) closeCloseDialog();
});

bindThreshold(elements.threshold5hRange, elements.threshold5hValue, "threshold5h");
bindThreshold(elements.thresholdWeeklyRange, elements.thresholdWeeklyValue, "thresholdWeekly");

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.settingsPanel.hidden) void setSettingsVisible(false);
});

async function loadAppVersion() {
  try {
    const version = await invoke("get_app_version");
    if (typeof version !== "string" || !version) throw new Error("Invalid app version");
    appVersion = version;
    appVersionStatus = "loaded";
  } catch {
    appVersion = null;
    appVersionStatus = "unavailable";
  }
  renderAppVersion();
}

async function initialize() {
  const versionReady = loadAppVersion();
  try { await window.UsageColors.ready; } catch { presentationError = true; }
  try {
    await listen("usage-state", (event) => acceptUsageState(event.payload));
  } catch { eventsError = true; }
  try { await listen("close-requested", openCloseDialog); } catch {}
  try { await listen("panel-restored", restorePanel); } catch {}
  try {
    const saved = await invoke("load_settings");
    settings = { ...initialSettings, ...saved };
    settings.language = settings.language === "es" ? "es" : "en";
    persistedSettings = { ...settings };
    projectedSettings = { ...settings };
  } catch { preferencesError = true; }
  resolveSettingsReady();
  applyLocalization();
  activateSettingsTab(activeSettingsTab);
  elements.threshold5hRange.value = elements.threshold5hValue.value = String(settings.threshold5h);
  elements.thresholdWeeklyRange.value = elements.thresholdWeeklyValue.value = String(settings.thresholdWeekly);
  try {
    await ensureNativeResizeListener();
    nativeUltraCompact = await invoke("get_native_window_mode");
    elements.appShell.dataset.ultraCompact = String(nativeUltraCompact);
    await setNativeWindowCompact(settings.ultraCompact, null, true);
  } catch { windowModeError = true; }
  try { await invoke("set_always_on_top", { alwaysOnTop: settings.alwaysOnTop }); }
  catch { setSaveMessage("topmostError", true); }
  await synchronizeUsage();
  await versionReady;
  setPanelVisible(true);
  await waitForPaint();
  try { await invoke("show_main_panel"); }
  catch { windowModeError = true; render(); }
}

applyLocalization();
render();
initialize();
