const fs = require("node:fs/promises");
const path = require("node:path");
const { test, expect, installTauriMock, usageState, appVersion } = require("./fixtures");

const previewDirectory = path.resolve("artifacts/ui-previews");

async function verifyVisibleLayout(page, expectedSize) {
  await expect(page.locator("#dashboard-view")).toBeVisible();
  await expect(page.locator(".app-shell")).not.toHaveAttribute("data-mode-transition", "true");
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(expectedSize);
  const isCompact = expectedSize.height === 156;
  if (isCompact) {
    await expect.poll(() => page.locator("#five-hour-title").evaluate((node) => getComputedStyle(node).fontSize))
      .toBe("13px");
  }
  const layout = await page.evaluate(() => {
    const shellNode = document.querySelector(".app-shell");
    const titleNode = document.querySelector("#five-hour-title");
    const shell = shellNode.getBoundingClientRect();
    const cards = [...document.querySelectorAll(".quota-card")].map((card) => {
      const cardRect = card.getBoundingClientRect();
      const meter = card.querySelector(".quota-meter").getBoundingClientRect();
      const marker = card.querySelector(".threshold-marker").getBoundingClientRect();
      const segments = [...card.querySelectorAll(".threshold-marker i")].map((segment) => {
        const rect = segment.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, width: rect.width };
      });
      const threshold = Number.parseFloat(
        getComputedStyle(card.querySelector(".quota-meter")).getPropertyValue("--threshold-position"),
      );
      return {
        card: { left: cardRect.left, right: cardRect.right, top: cardRect.top, bottom: cardRect.bottom },
        cardBottom: cardRect.bottom,
        meterLeft: meter.left,
        meterRight: meter.right,
        meterTop: meter.top,
        meterBottom: meter.bottom,
        meterWidth: meter.width,
        fillWidth: card.querySelector(".meter-fill").getBoundingClientRect().width,
        markerCenter: marker.left + marker.width / 2,
        expectedMarkerCenter: meter.left + meter.width * threshold / 100,
        segments,
        title: card.querySelector(".quota-heading h1, .quota-heading h2").getBoundingClientRect(),
        percent: card.querySelector(".remaining-block strong").getBoundingClientRect(),
        remaining: card.querySelector(".remaining-block span").getBoundingClientRect(),
        reset: card.querySelector(".quota-reset").getBoundingClientRect(),
      };
    });
    const brand = document.querySelector(".window-brand").getBoundingClientRect();
    const actions = document.querySelector(".header-actions").getBoundingClientRect();
    const buttons = [...document.querySelectorAll(".header-actions button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      ultraCompact: shellNode.dataset.ultraCompact,
      titleFontSize: getComputedStyle(titleNode).fontSize,
      shell: { width: shell.width, height: shell.height, bottom: shell.bottom },
      header: { brandRight: brand.right, actionsLeft: actions.left, actionsRight: actions.right, buttons },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      cards,
    };
  });
  expect(layout.viewport).toEqual(expectedSize);
  expect(layout.ultraCompact).toBe(isCompact ? "true" : "false");
  if (isCompact) expect(layout.titleFontSize, JSON.stringify(layout)).toBe("13px");
  expect(layout.shell.width).toBe(expectedSize.width);
  expect(layout.shell.height).toBe(expectedSize.height);
  expect(layout.document.width).toBeLessThanOrEqual(expectedSize.width);
  expect(layout.document.height).toBeLessThanOrEqual(expectedSize.height);
  expect(layout.header.brandRight).toBeLessThanOrEqual(layout.header.actionsLeft);
  expect(layout.header.actionsRight).toBeLessThanOrEqual(expectedSize.width);
  expect(layout.header.buttons).toHaveLength(5);
  for (const button of layout.header.buttons) {
    expect(button.width).toBeGreaterThanOrEqual(26);
    expect(button.height).toBeGreaterThanOrEqual(26);
  }
  for (const card of layout.cards) {
    expect(card.cardBottom, JSON.stringify(layout)).toBeLessThanOrEqual(layout.shell.bottom);
    expect(Math.abs(card.markerCenter - card.expectedMarkerCenter)).toBeLessThanOrEqual(1);
    expect(card.meterLeft).toBeGreaterThanOrEqual(card.card.left);
    expect(card.meterRight).toBeLessThanOrEqual(card.card.right);
    expect(card.meterTop).toBeGreaterThan(card.title.bottom);
    expect(card.meterBottom).toBeLessThan(card.reset.top);
    expect(card.reset.bottom).toBeLessThanOrEqual(layout.shell.bottom);
    expect(card.reset.right).toBeLessThanOrEqual(layout.shell.width);
    expect(card.segments).toHaveLength(3);
    for (const segment of card.segments) {
      expect(segment.width).toBe(2);
      expect(segment.bottom - segment.top).toBe(3);
    }
    expect(card.segments[1].top - card.segments[0].bottom).toBe(2);
    expect(card.segments[2].top - card.segments[1].bottom).toBe(2);
    if (isCompact) {
      expect(card.percent.right).toBeLessThanOrEqual(card.remaining.left + 0.5);
    }
  }
  return layout;
}

async function commandCalls(page, command) {
  return page.evaluate((name) => window.__mockCalls.filter((call) => call.command === name), command);
}

async function expectLimitsUnavailable(page, expectedSize) {
  for (const selector of ["#five-hour", "#weekly"]) {
    await expect(page.locator(`${selector}-percent`)).toHaveText("—");
    const meter = page.locator(`${selector}-progress`);
    await expect(meter).toHaveAttribute("data-heat", "unavailable");
    await expect.poll(() => page.locator(`${selector}-percent`).evaluate((node) => getComputedStyle(node).color))
      .toBe("rgb(105, 107, 116)");
    await expect(meter).not.toHaveAttribute("aria-valuenow", /.+/);
    await expect(meter).toHaveAttribute("aria-valuetext", "Usage limit unavailable.");
    const colors = await meter.evaluate((node) => {
      const style = getComputedStyle(node);
      return ["--water-deep", "--water-mid", "--water-light"]
        .map((property) => style.getPropertyValue(property).trim());
    });
    expect(colors).toEqual(["#4d535b", "#696b74", "#9696a0"]);
    await expect(page.locator(`${selector}-reset`)).toHaveText("Reset time unavailable");
    await expect(page.locator(`${selector}-card`)).toHaveClass(/quota--unavailable/);
  }

  return verifyVisibleLayout(page, expectedSize);
}

async function verifyCloseDialogLayout(page) {
  const layout = await page.locator("#close-dialog").evaluate((dialog) => {
    const dialogRect = dialog.getBoundingClientRect();
    const actions = dialog.querySelector(".close-dialog-actions").getBoundingClientRect();
    const buttons = [...dialog.querySelectorAll(".close-dialog-actions button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return {
      dialog: {
        inViewport: dialogRect.left >= 0 && dialogRect.top >= 0
          && dialogRect.right <= innerWidth && dialogRect.bottom <= innerHeight,
        noOverflow: dialog.scrollWidth <= dialog.clientWidth && dialog.scrollHeight <= dialog.clientHeight,
      },
      actions: { left: actions.left, right: actions.right, top: actions.top, bottom: actions.bottom },
      buttons,
    };
  });

  expect(layout.dialog).toEqual({ inViewport: true, noOverflow: true });
  expect(layout.buttons).toHaveLength(3);
  const rowTop = layout.buttons[0].top;
  for (const button of layout.buttons) {
    expect(Math.abs(button.top - rowTop)).toBeLessThanOrEqual(1);
    expect(button.left).toBeGreaterThanOrEqual(layout.actions.left);
    expect(button.right).toBeLessThanOrEqual(layout.actions.right);
    expect(button.bottom).toBeLessThanOrEqual(layout.actions.bottom);
  }
}

test("renders the normal panel at 360 by 220 without overflow or excess bottom space", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T15:00:00.000Z"));
  await installTauriMock(page, {});

  await expect(page.locator("#app-version-badge")).toHaveText(`v${appVersion}`);
  expect(await page.evaluate(() => window.__mockPanelStateAtShow)).toEqual({
    ultraCompact: "false",
    viewport: { width: 360, height: 220 },
    settingsLoaded: true,
  });
  expect(await commandCalls(page, "get_app_version")).toHaveLength(1);
  await expect(page.locator(".app-name")).toHaveText("WIMU");
  await expect(page.locator("#five-hour-percent")).toHaveText("72%");
  await expect(page.locator("#weekly-percent")).toHaveText("64%");
  const layout = await verifyVisibleLayout(page, { width: 360, height: 220 });
  expect(layout.cards[0].remaining.top).toBeGreaterThanOrEqual(layout.cards[0].percent.top);
  expect(layout.shell.bottom - layout.cards[1].reset.bottom).toBeLessThanOrEqual(8);
});

test("waits for compact preferences and the DPI-scaled native size before showing the panel", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T15:00:00.000Z"));
  await installTauriMock(page, {
    settings: { ultraCompact: true, language: "es" },
    settingsLoadDelayMs: 120,
    scaleFactor: 1.5,
  });

  expect(await page.evaluate(() => window.__mockPanelStateAtShow)).toEqual({
    ultraCompact: "true",
    viewport: { width: 300, height: 156 },
    settingsLoaded: true,
  });
  expect(await page.evaluate(() => window.__mockWindowResizeEvents.at(-1))).toEqual({
    width: 450,
    height: 234,
  });
  const layout = await verifyVisibleLayout(page, { width: 300, height: 156 });
  expect(layout.cards[1].reset.bottom).toBeLessThanOrEqual(layout.shell.bottom);
  await expect(page.locator("#weekly-reset")).toContainText("Se restablece");
  await expect(page.locator("#weekly-reset")).toHaveCSS("text-overflow", "clip");
});

test("only exposes horizontal window resize edges", async ({ page }) => {
  await installTauriMock(page, {});
  const resizeDirections = await page.locator("[data-resize-direction]").evaluateAll((edges) =>
    edges.map((edge) => edge.dataset.resizeDirection).sort(),
  );
  expect(resizeDirections).toEqual(["East", "West"]);

  await page.getByRole("button", { name: "Turn on ultra-compact mode" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
  await expect(page.locator("[data-resize-direction]")).toHaveCount(2);
  await verifyVisibleLayout(page, { width: 300, height: 156 });
});

test("keeps the normal layout complete at minimum and expanded widths", async ({ page }) => {
  await installTauriMock(page, {});

  for (const width of [320, 520]) {
    await page.setViewportSize({ width, height: 220 });
    const layout = await verifyVisibleLayout(page, { width, height: 220 });
    expect(layout.shell.bottom - layout.cards[1].reset.bottom).toBeLessThanOrEqual(8);
  }
});

test("edits whole-number thresholds and applies marker positions immediately", async ({ page }) => {
  await installTauriMock(page, {});
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Limits" }).click();
  await page.locator("#threshold-5h-value").fill("42");
  await page.locator("#threshold-weekly-value").fill("71");
  await expect(page.locator("#threshold-5h-range")).toHaveValue("42");
  await expect(page.locator("#threshold-weekly-range")).toHaveValue("71");
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("wimu-ui-settings")))
    .toContain('"threshold5h":42');

  await page.getByRole("button", { name: "Back" }).click();
  const layout = await verifyVisibleLayout(page, { width: 360, height: 220 });
  expect(layout.cards[0].expectedMarkerCenter).toBeCloseTo(
    layout.cards[0].meterLeft + layout.cards[0].meterWidth * 0.42,
    2,
  );
  expect(layout.cards[1].expectedMarkerCenter).toBeCloseTo(
    layout.cards[1].meterLeft + layout.cards[1].meterWidth * 0.71,
    2,
  );
});

test("rejects decimal and out-of-range thresholds while keeping the slider synchronized", async ({ page }) => {
  await installTauriMock(page, {});
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Limits" }).click();
  const thresholds = [
    { value: "#threshold-5h-value", slider: "#threshold-5h-range" },
    { value: "#threshold-weekly-value", slider: "#threshold-weekly-range" },
  ];
  for (const selectors of thresholds) {
    const threshold = page.locator(selectors.value);
    const slider = page.locator(selectors.slider);
    for (const control of [threshold, slider]) {
      await expect(control).toHaveAttribute("min", "0");
      await expect(control).toHaveAttribute("max", "100");
      await expect(control).toHaveAttribute("step", "1");
    }

    await threshold.fill("20.5");
    await expect(threshold).toHaveValue("20");
    await expect(slider).toHaveValue("20");
    await expect(page.locator("#limits-panel .save-message"))
      .toHaveText("Enter a whole number from 0 to 100.");

    await threshold.fill("101");
    await threshold.blur();
    await expect(threshold).toHaveValue("20");
    await expect(slider).toHaveValue("20");
  }

  await page.locator("#threshold-5h-range").evaluate((node) => {
    node.value = "0";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#threshold-5h-value")).toHaveValue("0");
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("wimu-ui-settings")))
    .toContain('"threshold5h":0');
});

test("loads legacy preferences with defaults and preserves saved thresholds after restart", async ({ page }) => {
  await installTauriMock(page, { settings: { threshold5h: 37, thresholdWeekly: 62 } });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "false");
  await expect(page.locator("#ultra-compact-button")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#language-en")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Limits" }).click();
  await expect(page.locator("#threshold-5h-value")).toHaveValue("37");
  await expect(page.locator("#threshold-weekly-value")).toHaveValue("62");
  await page.locator("#threshold-5h-value").fill("38");
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("wimu-ui-settings")))
    .toContain('"threshold5h":38');
  await page.reload();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Limits" }).click();
  await expect(page.locator("#threshold-5h-value")).toHaveValue("38");
  await expect(page.locator("#threshold-weekly-value")).toHaveValue("62");
  await expect(page.locator("#language-en")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#ultra-compact-button")).toHaveAttribute("aria-pressed", "false");
});

test("renders ultracompact panel at 300 by 156 with inline remaining labels", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T15:00:00.000Z"));
  await installTauriMock(page, { settings: { ultraCompact: true, threshold5h: 33, thresholdWeekly: 67 } });

  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
  await expect(page.locator("#app-version-badge")).toHaveText(`v${appVersion}`);
  await expect(page.locator("#always-on-top-button")).toHaveCount(0);
  const layout = await verifyVisibleLayout(page, { width: 300, height: 156 });
  await expect.poll(async () => page.locator("#weekly-title").evaluate((node) => getComputedStyle(node).fontSize))
    .toBe("13px");
  expect(layout.shell.bottom - layout.cards[1].reset.bottom).toBeLessThanOrEqual(8);
  for (const card of layout.cards) {
    expect(Math.abs(card.percent.top - card.remaining.top)).toBeLessThanOrEqual(2);
    expect(card.percent.left).toBeLessThan(card.remaining.left);
  }
});

test("keeps ultracompact height fixed while allowing horizontal resizing", async ({ page }) => {
  await installTauriMock(page, {
    settings: { ultraCompact: true, threshold5h: 33, thresholdWeekly: 67 },
  });
  await page.setViewportSize({ width: 480, height: 156 });

  const layout = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell").getBoundingClientRect();
    const title = document.querySelector("#five-hour-title");
    const meter = document.querySelector("#five-hour-progress").getBoundingClientRect();
    return {
      shellWidth: shell.width,
      shellHeight: shell.height,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      titleFontSize: getComputedStyle(title).fontSize,
      meterWidth: meter.width,
    };
  });

  expect(layout.shellWidth).toBe(480);
  expect(layout.shellHeight).toBe(156);
  expect(layout.documentWidth).toBeLessThanOrEqual(480);
  expect(layout.documentHeight).toBeLessThanOrEqual(156);
  expect(layout.titleFontSize).toBe("13px");
  expect(layout.meterWidth).toBeGreaterThan(400);
});

test("captures deterministic normal and ultracompact panels", async ({ page }) => {
  await fs.mkdir(previewDirectory, { recursive: true });
  await page.clock.setFixedTime(new Date("2026-10-14T15:00:00.000Z"));
  await installTauriMock(page, { usageState: usageState(23, 73) });
  await expect(page.locator("#app-version-badge")).toHaveText(`v${appVersion}`);
  await page.locator(".app-shell").screenshot({
    path: path.join(previewDirectory, "normal.png"),
    animations: "disabled",
    caret: "hide",
  });

  await page.locator("#ultra-compact-button").click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
  await expect.poll(async () => page.locator("#five-hour-title").evaluate((node) => getComputedStyle(node).fontSize))
    .toBe("13px");
  await verifyVisibleLayout(page, { width: 300, height: 156 });
  await page.locator(".app-shell").screenshot({
    path: path.join(previewDirectory, "ultra-compact.png"),
    animations: "disabled",
    caret: "hide",
  });
});

test("uses ten heat color steps at each 10-point boundary", async ({ page }) => {
  await installTauriMock(page, { settings: { threshold5h: 0, thresholdWeekly: 0 } });
  // Measure the rendered target width, not the intermediate frames of the UI transition.
  await page.addStyleTag({ content: ".meter-fill { transition: none !important; }" });
  const palette = {
    "step-0": ["#873641", "#d35760", "#f49a91"],
    "step-1": ["#963a36", "#d75c55", "#f49d83"],
    "step-2": ["#a14330", "#dc624b", "#f3a175"],
    "step-3": ["#a84f2a", "#dc7040", "#f2a76f"],
    "step-4": ["#a4612a", "#d78a3f", "#eeb772"],
    "step-5": ["#92722f", "#cba142", "#e8c976"],
    "step-6": ["#7b7937", "#b4ac48", "#ded57c"],
    "step-7": ["#5e7a43", "#8db75b", "#c0dc86"],
    "step-8": ["#3d7750", "#63b583", "#a0dcb2"],
    "step-9": ["#267455", "#40b783", "#8de0b9"],
  };
  const cases = [];
  for (let step = 0; step < 10; step += 1) {
    cases.push([step * 10, `step-${step}`]);
    cases.push([step * 10 + 9, `step-${step}`]);
  }
  cases.push([100, "step-9"]);
  const modes = [
    { compact: false, size: { width: 360, height: 220 } },
    { compact: true, size: { width: 300, height: 156 } },
  ];
  for (const mode of modes) {
    if (mode.compact) {
      await page.getByRole("button", { name: "Turn on ultra-compact mode" }).click();
      await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
    }

    await verifyVisibleLayout(page, mode.size);
    for (const [remaining, heat] of cases) {
      await page.evaluate((value) => window.__mockEmitUsage({
        status: "online",
        fiveHour: {
          windowDurationMins: 300,
          usedPercent: String(100 - value),
          remainingPercent: String(value),
          remainingFraction: value / 100,
          resetsAt: 1_792_000_000,
        },
        weekly: {
          windowDurationMins: 10_080,
          usedPercent: String(100 - value),
          remainingPercent: String(value),
          remainingFraction: value / 100,
          resetsAt: 1_792_000_000,
        },
      }), remaining);

      for (const selector of ["#five-hour-progress", "#weekly-progress"]) {
        const meter = page.locator(selector);
        await expect(meter).toHaveAttribute("data-heat", heat);
        const expectedPalette = remaining === 0 ? ["#a8192d", "#ff3048", "#ff7785"] : palette[heat];
        const mid = expectedPalette[1];
        const [red, green, blue] = mid.match(/[\da-f]{2}/gi).map((channel) => Number.parseInt(channel, 16));
        const expectedTextColor = `rgb(${red}, ${green}, ${blue})`;
        await expect.poll(() => meter.evaluate((node) => {
          const percentage = node.closest(".quota-card").querySelector(".remaining-block strong");
          return getComputedStyle(percentage).color;
        })).toBe(expectedTextColor);
        const actual = await meter.evaluate((node) => {
          const style = getComputedStyle(node);
          const card = node.closest(".quota-card");
          const percentage = card.querySelector(".remaining-block strong");
          const track = node.querySelector(".meter-track").getBoundingClientRect();
          const fill = node.querySelector(".meter-fill").getBoundingClientRect();
          return {
            cardHeat: card.dataset.heat,
            colors: ["--water-deep", "--water-mid", "--water-light"]
              .map((property) => style.getPropertyValue(property).trim()),
            percentageColor: getComputedStyle(percentage).color,
            value: Number(node.getAttribute("aria-valuenow")),
            fillRatio: track.width === 0 ? 0 : fill.width / track.width * 100,
          };
        });
        expect(actual.cardHeat).toBe(heat);
        expect(actual.colors).toEqual(expectedPalette);
        expect(actual.percentageColor, JSON.stringify(actual)).toBe(expectedTextColor);
        expect(actual.value).toBeCloseTo(remaining, 2);
        expect(Math.abs(actual.fillRatio - remaining)).toBeLessThanOrEqual(0.1);
      }
    }

    await page.evaluate((state) => window.__mockEmitUsage(state), usageState(54, 38));
    await expect(page.locator("#five-hour-percent")).toHaveText("54%");
    await expect(page.locator("#weekly-percent")).toHaveText("38%");
    const expectedColors = ["rgb(203, 161, 66)", "#cba142", "rgb(220, 112, 64)", "#dc7040"];
    await expect.poll(() => page.evaluate(() => [
      getComputedStyle(document.querySelector("#five-hour-percent")).color,
      getComputedStyle(document.querySelector("#five-hour-progress")).getPropertyValue("--water-mid").trim(),
      getComputedStyle(document.querySelector("#weekly-percent")).color,
      getComputedStyle(document.querySelector("#weekly-progress")).getPropertyValue("--water-mid").trim(),
    ])).toEqual(expectedColors);
  }
});

test("keeps the divider between periods and removes the line under weekly reset", async ({ page }) => {
  await installTauriMock(page, {});
  await expect.poll(async () => page.locator("#five-hour-card").evaluate((card) => getComputedStyle(card).borderBottomWidth))
    .toBe("1px");
  await expect.poll(async () => page.locator("#weekly-card").evaluate((card) => getComputedStyle(card).borderBottomWidth))
    .toBe("0px");
});

test("renders quota events immediately, keeps source precision, and recovers from stale data", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T15:00:00.000Z"));
  await installTauriMock(page, {});
  const updated = usageState(3, 82, "online");
  updated.fiveHour.remainingFraction = 0.03125;
  updated.fiveHour.remainingPercent = "3.125";
  updated.weekly.remainingFraction = 0.8275;
  updated.weekly.remainingPercent = "82.75";
  await page.evaluate((state) => window.__mockEmitUsage(state), updated);

  await expect(page.locator("#five-hour-percent")).toHaveText("3.125%");
  await expect(page.locator("#weekly-percent")).toHaveText("82.75%");
  await expect(page.locator("#five-hour-progress")).toHaveAttribute("aria-valuenow", "3.125");
  await expect(page.locator("#weekly-progress")).toHaveAttribute("aria-valuenow", "82.75");
  await expect(page.locator("#five-hour-card")).toHaveClass(/quota--critical/);
  await expect(page.locator("#weekly-card")).not.toHaveClass(/quota--warning/);
  await expect(page.locator("#connection-message")).toBeHidden();

  await page.evaluate((state) => window.__mockEmitUsage({ ...state, status: "reconnecting" }), updated);
  await expect(page.locator("#connection-message")).toHaveText("Reconnecting. Limits unavailable.");
  await expectLimitsUnavailable(page, { width: 360, height: 220 });

  await page.evaluate((state) => window.__mockEmitUsage(state), usageState(18, 12, "online"));
  await expect(page.locator("#five-hour-percent")).toHaveText("18%");
  await expect(page.locator("#connection-message")).toBeHidden();
  await expect(page.locator("#five-hour-card")).not.toHaveClass(/quota--unavailable/);
  await expect(page.locator("#weekly-card")).not.toHaveClass(/quota--unavailable/);
});

test("marks missing and malformed windows unavailable without inventing percentages", async ({ page }) => {
  await installTauriMock(page, { usageState: usageState(51, null) });
  await expect(page.locator("#five-hour-percent")).toHaveText("51%");
  await expect(page.locator("#weekly-percent")).toHaveText("—");
  await expect(page.locator("#weekly-progress")).not.toHaveAttribute("aria-valuenow", /.+/);
  await expect(page.locator("#weekly-progress")).toHaveAttribute("aria-valuetext", "Usage limit unavailable.");
  await expect(page.locator("#weekly-reset")).toHaveText("Reset time unavailable");

  await page.evaluate(() => window.__mockEmitUsage({
    status: "online",
    fiveHour: {
      windowDurationMins: 300,
      remainingFraction: Number.NaN,
      remainingPercent: "not-a-number",
      resetsAt: 0,
    },
    weekly: null,
  }));
  await expect(page.locator("#five-hour-percent")).toHaveText("—");
  await expect(page.locator("#five-hour-progress")).toHaveAttribute("data-heat", "unavailable");
  await expect(page.locator("#five-hour-reset")).toHaveText("Reset time unavailable");
  await expect(page.locator("#weekly-progress")).toHaveAttribute("data-heat", "unavailable");
});

test("uses independent alert thresholds at warning and critical boundaries", async ({ page }) => {
  await installTauriMock(page, {
    settings: { threshold5h: 25, thresholdWeekly: 50 },
    usageState: usageState(25, 50),
  });
  await expect(page.locator("#five-hour-card")).toHaveClass(/quota--warning/);
  await expect(page.locator("#weekly-card")).toHaveClass(/quota--warning/);
  await expect(page.locator("#five-hour-card")).not.toHaveClass(/quota--critical/);
  await expect(page.locator("#weekly-card")).not.toHaveClass(/quota--critical/);

  await page.evaluate((state) => window.__mockEmitUsage(state), usageState(10, 10));
  await expect(page.locator("#five-hour-card")).toHaveClass(/quota--critical/);
  await expect(page.locator("#weekly-card")).toHaveClass(/quota--critical/);
  await page.evaluate((state) => window.__mockEmitUsage(state), usageState(26, 51));
  await expect(page.locator("#five-hour-card")).not.toHaveClass(/quota--warning/);
  await expect(page.locator("#weekly-card")).not.toHaveClass(/quota--warning/);
});

test("keeps sound alerts off by default and persists the localized bell control", async ({ page }) => {
  await installTauriMock(page, {});

  const bell = page.locator("#sound-toggle");
  await expect(bell).toHaveAttribute("aria-pressed", "false");
  await expect(bell).toHaveAttribute("aria-label", "Enable sound alerts");
  await expect(page.locator("#settings-button .lucide-icon--settings")).toHaveCSS(
    "-webkit-mask-image",
    /settings\.svg/,
  );
  await expect.poll(() => page.evaluate(() => window.__mockGetSettings().soundEnabled)).toBe(false);
  expect(await page.evaluate(() => window.__mockAudioCalls)).toEqual([]);

  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  await expect(bell).toHaveAttribute("aria-label", "Mute sound alerts");
  await expect.poll(() => page.evaluate(() => window.__mockGetSettings().soundEnabled)).toBe(true);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Español" }).click();
  await expect(page.locator("#sound-toggle")).toHaveAttribute("aria-label", "Silenciar alertas de sonido");
  await expect.poll(() => page.evaluate(() => window.__mockGetSettings().language)).toBe("es");

  await page.reload();
  await page.waitForFunction(() => window.__mockPanelShown === true);
  await expect(page.locator("#sound-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#sound-toggle")).toHaveAttribute("aria-label", "Silenciar alertas de sonido");
  expect(await page.evaluate(() => window.__mockAudioCalls)).toEqual([]);
});

test("serves both bundled alert sounds as decodable short audio", async ({ page }) => {
  await installTauriMock(page, {});
  const durations = await page.evaluate(async () => {
    const context = new AudioContext();
    try {
      const values = [];
      for (const file of ["./assets/sounds/reset.mp3", "./assets/sounds/threshold.mp3"]) {
        const response = await fetch(file);
        if (!response.ok) throw new Error(`Could not load ${file}`);
        const audio = await context.decodeAudioData(await response.arrayBuffer());
        values.push(audio.duration);
      }
      return values;
    } finally {
      await context.close();
    }
  });
  expect(durations).toHaveLength(2);
  for (const duration of durations) {
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThan(5);
  }
});

test("plays one reset or threshold sound only for a fresh valid crossing", async ({ page }) => {
  await installTauriMock(page, { settings: { soundEnabled: true } });
  expect(await page.evaluate(() => window.__mockAudioCalls)).toEqual([]);

  const thresholdCrossing = usageState(20, 20);
  thresholdCrossing.lastUpdatedAt += 1_000;
  await page.evaluate((state) => window.__mockEmitUsage(state), thresholdCrossing);
  await expect.poll(() => page.evaluate(() => window.__mockAudioCalls.length)).toBe(1);
  expect(await page.evaluate(() => window.__mockAudioCalls[0])).toContain("threshold.mp3");

  const repeated = await page.evaluate(() => window.__mockCurrentUsage);
  await page.evaluate((state) => window.__mockEmitUsage(state), repeated);
  await page.evaluate((state) => window.__mockEmitUsage({ ...state, revision: 1 }), repeated);
  await page.waitForTimeout(25);
  expect(await page.evaluate(() => window.__mockAudioCalls)).toHaveLength(1);

  const reset = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.fiveHour.remainingFraction = 1;
    state.fiveHour.remainingPercent = "100";
    state.fiveHour.usedPercent = "0";
    const previousReset = state.fiveHour.resetsAt;
    state.lastUpdatedAt = previousReset * 1_000 + 1_000;
    state.fiveHour.resetsAt += 18_000;
    state.weekly.remainingFraction = 1;
    state.weekly.remainingPercent = "100";
    state.weekly.usedPercent = "0";
    state.weekly.resetsAt += 604_800;
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), reset);
  await expect.poll(() => page.evaluate(() => window.__mockAudioCalls.length)).toBe(2);
  expect(await page.evaluate(() => window.__mockAudioCalls[1])).toContain("reset.mp3");

  const lateReconciliation = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.lastUpdatedAt += 1_000;
    state.fiveHour.resetsAt += 1;
    state.weekly.resetsAt += 1;
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), lateReconciliation);
  await page.waitForTimeout(25);
  expect(await page.evaluate(() => window.__mockAudioCalls)).toHaveLength(2);

  const thresholdAfterReset = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.lastUpdatedAt += 1_000;
    state.fiveHour.remainingFraction = 0.19;
    state.fiveHour.remainingPercent = "19";
    state.fiveHour.usedPercent = "81";
    state.weekly.remainingFraction = 0.2;
    state.weekly.remainingPercent = "20";
    state.weekly.usedPercent = "80";
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), thresholdAfterReset);
  await expect.poll(() => page.evaluate(() => window.__mockAudioCalls.length)).toBe(3);
  expect(await page.evaluate(() => window.__mockAudioCalls[2])).toContain("threshold.mp3");

  const invalid = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.lastUpdatedAt += 1_000;
    state.fiveHour = null;
    state.weekly = null;
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), invalid);
  const recovered = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.lastUpdatedAt += 1_000;
    state.fiveHour = {
      windowDurationMins: 300,
      usedPercent: "100",
      remainingPercent: "0",
      remainingFraction: 0,
      resetsAt: 1_792_000_000,
    };
    state.weekly = {
      windowDurationMins: 10_080,
      usedPercent: "100",
      remainingPercent: "0",
      remainingFraction: 0,
      resetsAt: 1_792_000_000,
    };
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), recovered);
  const disconnected = await page.evaluate(() => ({
    ...window.__mockCurrentUsage,
    revision: undefined,
    status: "stale",
    lastUpdatedAt: window.__mockCurrentUsage.lastUpdatedAt + 1_000,
  }));
  await page.evaluate((state) => window.__mockEmitUsage(state), disconnected);
  const resumed = await page.evaluate(() => ({
    ...window.__mockCurrentUsage,
    revision: undefined,
    status: "online",
    lastUpdatedAt: window.__mockCurrentUsage.lastUpdatedAt + 1_000,
  }));
  await page.evaluate((state) => window.__mockEmitUsage(state), resumed);
  await page.waitForTimeout(25);
  expect(await page.evaluate(() => window.__mockAudioCalls)).toHaveLength(3);
});

test("detects each reset boundary once across delayed reconciliation snapshots", async ({ page }) => {
  const initial = usageState(70, 80);
  initial.weekly.resetsAt += 3_600;
  initial.lastUpdatedAt = initial.fiveHour.resetsAt * 1_000 - 2_000;
  await installTauriMock(page, { settings: { soundEnabled: true }, usageState: initial });
  expect(await page.evaluate(() => window.__mockAudioCalls)).toEqual([]);

  const fiveHourReset = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.lastUpdatedAt = state.fiveHour.resetsAt * 1_000 + 1_000;
    state.fiveHour.resetsAt += 18_000;
    state.fiveHour.remainingFraction = 1;
    state.fiveHour.remainingPercent = "100";
    state.fiveHour.usedPercent = "0";
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), fiveHourReset);
  await expect.poll(() => page.evaluate(() => window.__mockAudioCalls.length)).toBe(1);

  const reconciliation = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.lastUpdatedAt += 1_000;
    state.fiveHour.resetsAt += 1;
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), reconciliation);
  await page.waitForTimeout(25);
  expect(await page.evaluate(() => window.__mockAudioCalls)).toHaveLength(1);

  const weeklyReset = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.lastUpdatedAt = state.weekly.resetsAt * 1_000 + 1_000;
    state.weekly.resetsAt += 604_800;
    state.weekly.remainingFraction = 1;
    state.weekly.remainingPercent = "100";
    state.weekly.usedPercent = "0";
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), weeklyReset);
  await expect.poll(() => page.evaluate(() => window.__mockAudioCalls.length)).toBe(2);

  const repeatedWeeklyRead = await page.evaluate(() => {
    const state = structuredClone(window.__mockCurrentUsage);
    state.lastUpdatedAt += 1_000;
    state.weekly.resetsAt += 1;
    delete state.revision;
    return state;
  });
  await page.evaluate((state) => window.__mockEmitUsage(state), repeatedWeeklyRead);
  await page.waitForTimeout(25);
  expect(await page.evaluate(() => window.__mockAudioCalls)).toHaveLength(2);
  expect(await page.evaluate(() => window.__mockAudioCalls.every((source) => source.includes("reset.mp3")))).toBe(true);
});

test("does not alert on an initial state already past reset and below threshold", async ({ page }) => {
  const initial = usageState(10, 15);
  initial.lastUpdatedAt = (initial.fiveHour.resetsAt + 1) * 1_000;
  initial.fiveHour.resetsAt += 18_000;
  initial.weekly.resetsAt += 604_800;
  await installTauriMock(page, { settings: { soundEnabled: true }, usageState: initial });
  await page.waitForTimeout(25);
  expect(await page.evaluate(() => window.__mockAudioCalls)).toEqual([]);
});

test("ignores an older timestamp even when a newer revision crosses the threshold", async ({ page }) => {
  const initial = usageState(70, 70);
  await installTauriMock(page, { settings: { soundEnabled: true }, usageState: initial });

  const delayedRead = usageState(19, 70);
  delayedRead.lastUpdatedAt = initial.lastUpdatedAt - 1_000;
  await page.evaluate((state) => window.__mockEmitUsage(state), delayedRead);
  await page.waitForTimeout(25);
  expect(await page.evaluate(() => window.__mockAudioCalls)).toEqual([]);

  const confirmedRead = usageState(19, 70);
  confirmedRead.lastUpdatedAt = initial.lastUpdatedAt + 1_000;
  await page.evaluate((state) => window.__mockEmitUsage(state), confirmedRead);
  await expect.poll(() => page.evaluate(() => window.__mockAudioCalls.length)).toBe(1);
  expect(await page.evaluate(() => window.__mockAudioCalls[0])).toContain("threshold.mp3");
});

test("pauses panel rendering in the tray while keeping sounds and tray data current", async ({ page }) => {
  await installTauriMock(page, { settings: { soundEnabled: true } });
  await page.locator("#minimize-button").click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-panel-visible", "false");
  await expect(page.locator("#five-hour-progress .meter-fill")).toHaveCSS("animation-play-state", "paused");
  await expect(page.locator("#five-hour-percent")).toHaveText("72%");

  await page.evaluate((state) => window.__mockEmitUsage(state), usageState(20, 64));
  await expect.poll(() => page.evaluate(() => window.__mockAudioCalls.length)).toBe(1);
  await expect(page.locator("#five-hour-percent")).toHaveText("72%");
  await expect.poll(async () => (await page.evaluate(() => window.__mockTooltipValues.at(-1)?.fiveHour)) ?? "")
    .toContain("20%");

  await page.evaluate(() => window.__mockEmitRestored());
  await expect(page.locator(".app-shell")).toHaveAttribute("data-panel-visible", "true");
  await expect(page.locator("#five-hour-percent")).toHaveText("20%");
  await expect(page.locator("#five-hour-progress .meter-fill")).toHaveCSS("animation-play-state", "running");
});

test("supports keyboard navigation and localized quota labels", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T15:00:00.000Z"));
  await installTauriMock(page, {});
  await page.getByRole("button", { name: "Settings" }).click();
  const generalTab = page.getByRole("tab", { name: "General" });
  const limitsTab = page.getByRole("tab", { name: "Limits" });
  await expect(page.locator(".app-shell")).not.toHaveAttribute("data-mode-transition", "true");
  await generalTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(limitsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".app-shell")).not.toHaveAttribute("data-mode-transition", "true");
  await expect(limitsTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(generalTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".app-shell")).not.toHaveAttribute("data-mode-transition", "true");
  await expect(generalTab).toBeFocused();

  await page.getByRole("button", { name: "Español" }).click();
  await page.getByRole("button", { name: "Volver" }).click();
  await expect(page.locator("#five-hour-progress")).toHaveAttribute(
    "aria-label",
    "Porcentaje restante en la ventana de 5 horas",
  );
  await expect(page.locator("#five-hour-reset")).toContainText("Se restablece");
  await expect(page.locator("#weekly-percent")).toHaveText("64 %");
  await verifyVisibleLayout(page, { width: 360, height: 220 });

  await page.getByRole("button", { name: "Configuración" }).click();
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#language-en")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#five-hour-progress")).toHaveAttribute(
    "aria-label",
    "Percentage remaining in the 5-hour window",
  );
  await expect(page.locator("#weekly-percent")).toHaveText("64%");
});

test("opens settings from persisted ultracompact mode and returns without blocking", async ({ page }) => {
  await installTauriMock(page, {
    settings: { ultraCompact: true, threshold5h: 33, thresholdWeekly: 67 },
  });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.getByRole("tab", { name: "General" })).toBeFocused();
  await expect.poll(async () => (await commandCalls(page, "set_ultra_compact")).length).toBe(2);

  const settingsBounds = await page.locator("#settings-panel").evaluate((panel) => {
    const bounds = panel.getBoundingClientRect();
    return {
      right: bounds.right,
      bottom: bounds.bottom,
      viewportWidth: document.documentElement.scrollWidth,
      viewportHeight: document.documentElement.scrollHeight,
    };
  });
  expect(settingsBounds.right).toBeLessThanOrEqual(360);
  expect(settingsBounds.bottom).toBeLessThanOrEqual(220);
  expect(settingsBounds.viewportWidth).toBeLessThanOrEqual(360);
  expect(settingsBounds.viewportHeight).toBeLessThanOrEqual(220);

  await page.getByRole("tab", { name: "Limits" }).click();
  await expect(page.locator("#limits-panel")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
  await expect.poll(async () => (await commandCalls(page, "set_ultra_compact")).length).toBe(3);
  await verifyVisibleLayout(page, { width: 300, height: 156 });
});

test("toggles ultracompact mode, expands settings temporarily, and restores it", async ({ page }) => {
  await installTauriMock(page, {});
  const compactButton = page.getByRole("button", { name: "Turn on ultra-compact mode" });
  await compactButton.click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
  await expect.poll(async () => (await commandCalls(page, "set_ultra_compact")).length).toBe(2);
  expect(await commandCalls(page, "set_ultra_compact")).toEqual([
    { command: "set_ultra_compact", args: { ultraCompact: false } },
    { command: "set_ultra_compact", args: { ultraCompact: true, preferredUltraCompact: true } },
  ]);
  await expect.poll(async () => page.locator("#five-hour-title").evaluate((node) => getComputedStyle(node).fontSize))
    .toBe("13px");
  await verifyVisibleLayout(page, { width: 300, height: 156 });
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("wimu-ui-settings")))
    .toContain('"ultraCompact":true');
  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "false");
  expect(await commandCalls(page, "set_ultra_compact")).toEqual([
    { command: "set_ultra_compact", args: { ultraCompact: true } },
    { command: "set_ultra_compact", args: { ultraCompact: false } },
  ]);

  await page.getByRole("tab", { name: "Limits" }).click();
  await expect(page.locator("#limits-panel")).toBeVisible();
  await page.getByRole("tab", { name: "General" }).click();
  await page.getByRole("button", { name: "Español" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es-AR");
  await expect(page.locator("#settings-title")).toHaveText("Configuración");
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("wimu-ui-settings")))
    .toContain('"language":"es"');

  await page.getByRole("switch", { name: "Mantener la ventana siempre encima" }).click();
  const alwaysOnTopSwitch = page.getByRole("switch", { name: "Mantener la ventana siempre encima" });
  await expect(alwaysOnTopSwitch).not.toBeChecked();
  await expect.poll(async () => (await commandCalls(page, "set_always_on_top")).length).toBe(2);
  expect((await commandCalls(page, "set_always_on_top")).at(-1)).toEqual({
    command: "set_always_on_top",
    args: { alwaysOnTop: false },
  });
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("wimu-ui-settings")))
    .toContain('"alwaysOnTop":false');
  await page.getByRole("button", { name: "Volver" }).click();
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
  await verifyVisibleLayout(page, { width: 300, height: 156 });

  await page.getByRole("button", { name: "Minimizar" }).click();
  await expect.poll(async () => (await commandCalls(page, "minimize_panel")).length).toBe(1);
  await page.getByRole("button", { name: "Cerrar" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await verifyCloseDialogLayout(page);
  await expect(page.getByRole("button", { name: "Cancelar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Minimizar en la bandeja" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Salir de WIMU" })).toBeVisible();
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Cerrar" }).click();
  await page.getByRole("button", { name: "Salir de WIMU" }).click();
  await expect.poll(async () => (await commandCalls(page, "quit_app")).length).toBe(1);
});

test("persists the selected compact mode in the native resize operation", async ({ page }) => {
  await installTauriMock(page, { failures: ["save_settings"] });
  await page.getByRole("button", { name: "Turn on ultra-compact mode" }).click();

  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
  await expect.poll(async () => (await commandCalls(page, "set_ultra_compact")).length).toBe(2);
  expect(await commandCalls(page, "set_ultra_compact")).toEqual([
    { command: "set_ultra_compact", args: { ultraCompact: false } },
    { command: "set_ultra_compact", args: { ultraCompact: true, preferredUltraCompact: true } },
  ]);
  await expect.poll(async () => page.evaluate(() => window.__mockGetSettings().ultraCompact)).toBe(true);
  expect(await commandCalls(page, "save_settings")).toHaveLength(0);

  await page.reload();

  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
});

test("keeps every compact close action visible together when saving the choice fails", async ({ page }) => {
  await installTauriMock(page, { settings: { ultraCompact: true }, failures: ["save_settings"] });
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("checkbox", { name: "Remember my choice" }).check();
  await page.getByRole("button", { name: "Minimize in the tray" }).click();

  await expect(page.locator("#close-preference-error"))
    .toHaveText("Could not save this choice. Please try again.");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Minimize in the tray" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quit WIMU" })).toBeVisible();
  await verifyCloseDialogLayout(page);

  await fs.mkdir(previewDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(previewDirectory, "close-dialog-ultracompact-error.png"),
    animations: "disabled",
    caret: "hide",
  });
});

test("remembers the close action across restart and can restore asking each time", async ({ page }) => {
  await installTauriMock(page, {});
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("checkbox", { name: "Remember my choice" }).check();
  await page.getByRole("button", { name: "Minimize in the tray" }).click();
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("wimu-ui-settings")))
    .toContain('"closeAction":"minimize"');
  await expect.poll(async () => (await commandCalls(page, "minimize_panel")).length).toBe(1);

  await page.reload();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(async () => (await commandCalls(page, "minimize_panel")).length).toBe(1);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#remembered-close-setting")).toBeVisible();
  await expect(page.locator("#remembered-close-text")).toHaveText("Minimize in the tray");
  await page.getByRole("button", { name: "Ask every time" }).click();
  await expect(page.locator("#remembered-close-setting")).toBeHidden();
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("wimu-ui-settings")))
    .toContain('"closeAction":"ask"');

  await page.reload();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("applies the remembered close action when the native window close event fires", async ({ page }) => {
  await installTauriMock(page, {});
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("checkbox", { name: "Remember my choice" }).check();
  await page.getByRole("button", { name: "Minimize in the tray" }).click();
  await expect.poll(async () => (await commandCalls(page, "minimize_panel")).length).toBe(1);

  await page.evaluate(() => window.__mockEmitCloseRequested());

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(async () => (await commandCalls(page, "minimize_panel")).length).toBe(2);
});

test("waits for the saved close choice before handling an early close", async ({ page }) => {
  await installTauriMock(page, {
    settings: { closeAction: "minimize" },
    settingsLoadDelayMs: 250,
    waitForInitialization: false,
  });

  await page.getByRole("button", { name: "Close" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(async () => (await commandCalls(page, "minimize_panel")).length).toBe(1);
});

test("does not minimize or quit when remembering a close choice fails to save", async ({ page }) => {
  await installTauriMock(page, {});
  await page.evaluate(() => window.__mockFailures.add("save_settings"));
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("checkbox", { name: "Remember my choice" }).check();
  await page.getByRole("button", { name: "Minimize in the tray" }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#close-preference-error")).toHaveText("Could not save this choice. Please try again.");
  expect(await commandCalls(page, "minimize_panel")).toHaveLength(0);
  expect(await commandCalls(page, "quit_app")).toHaveLength(0);
});

test("reverts the always-on-top control and shows an error when the native change fails", async ({ page }) => {
  await installTauriMock(page, {});
  await page.evaluate(() => window.__mockFailures.add("set_always_on_top"));
  await page.getByRole("button", { name: "Settings" }).click();
  const alwaysOnTop = page.getByRole("switch", { name: "Keep the window on top" });
  await expect(alwaysOnTop).toBeChecked();
  await alwaysOnTop.click();
  await expect(alwaysOnTop).toBeChecked();
  await expect(page.locator("#general-panel .save-message")).toHaveText("Could not change always-on-top.");
});

test("hides cached percentages whenever limits are unavailable in both layouts", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T15:00:00.000Z"));
  await installTauriMock(page, {
    usageState: usageState(61, 69, "online"),
  });

  const unavailableStatuses = [
    "connecting",
    "reconnecting",
    "stale",
    "disconnected",
    "needsLogin",
    "cliMissing",
    "cliCheckFailed",
    "incompatible",
  ];

  await expect(page.locator("#five-hour-percent")).toHaveText("61%");
  await expect(page.locator("#weekly-percent")).toHaveText("69%");
  await page.evaluate((state) => window.__mockEmitUsage(state), usageState(61, 69, "stale"));
  await expect(page.locator("#connection-message")).toHaveText("Could not update usage limits.");
  await expectLimitsUnavailable(page, { width: 360, height: 220 });
  for (const status of unavailableStatuses) {
    await page.evaluate((value) => window.__mockEmitUsage({
      ...window.__mockCurrentUsage,
      status: value,
    }), status);
    await expectLimitsUnavailable(page, { width: 360, height: 220 });
  }
  await page.evaluate(() => window.__mockEmitUsage({
    ...window.__mockCurrentUsage,
    status: "stale",
  }));
  await expectLimitsUnavailable(page, { width: 360, height: 220 });
  const unavailableColors = await page.locator("#five-hour-progress").evaluate((meter) => {
    const style = getComputedStyle(meter);
    return ["--water-deep", "--water-mid", "--water-light"]
      .map((property) => style.getPropertyValue(property).trim());
  });
  expect(unavailableColors).toEqual(["#4d535b", "#696b74", "#9696a0"]);

  await fs.mkdir(previewDirectory, { recursive: true });
  await page.locator(".app-shell").screenshot({
    path: path.join(previewDirectory, "unavailable-limits-normal.png"),
    animations: "disabled",
    caret: "hide",
  });

  await page.locator("#ultra-compact-button").click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "true");
  await expectLimitsUnavailable(page, { width: 300, height: 156 });
  await page.locator(".app-shell").screenshot({
    path: path.join(previewDirectory, "unavailable-limits-ultracompact.png"),
    animations: "disabled",
    caret: "hide",
  });
  for (const status of unavailableStatuses) {
    await page.evaluate((value) => window.__mockEmitUsage({
      ...window.__mockCurrentUsage,
      status: value,
    }), status);
    await expectLimitsUnavailable(page, { width: 300, height: 156 });
  }
});

test("shows only the fresh window while a partial usage event is being reconciled", async ({ page }) => {
  await installTauriMock(page, {});
  await page.evaluate(() => window.__mockEmitUsage({
    status: "refreshing",
    fiveHour: {
      windowDurationMins: 300,
      usedPercent: "69",
      remainingPercent: "31",
      remainingFraction: 0.31,
      resetsAt: 1_792_000_000,
    },
    weekly: null,
  }));

  await expect(page.locator("#five-hour-percent")).toHaveText("31%");
  await expect(page.locator("#weekly-percent")).toHaveText("—");
  await expect(page.locator("#weekly-progress")).toHaveAttribute("data-heat", "unavailable");
  await expect(page.locator("#weekly-progress")).not.toHaveAttribute("aria-valuenow", /.+/);
  await expect(page.locator("#weekly-reset")).toHaveText("Reset time unavailable");
});

test("shows useful messages for sign-in, missing CLI, and incompatible CLI states", async ({ page }) => {
  await installTauriMock(page, {});
  const states = [
    ["needsLogin", "Sign in to Codex to view your limits."],
    ["cliMissing", "Codex CLI not found. Install it and restart the app."],
    ["cliCheckFailed", "Could not check Codex CLI. Retrying automatically."],
    ["incompatible", "This WIMU build can't read your Codex CLI. Update WIMU or Codex CLI and restart."],
  ];
  for (const [status, message] of states) {
    await page.evaluate((value) => window.__mockEmitUsage({
      status: value,
      fiveHour: null,
      weekly: null,
    }), status);
    await expect(page.locator("#connection-message")).toHaveText(message);
    await expect(page.locator("#five-hour-percent")).toHaveText("—");
    await expect(page.locator("#weekly-percent")).toHaveText("—");
  }
});

test("keeps the build version visible when startup cannot read usage", async ({ page }) => {
  await installTauriMock(page, { usageFailure: true });
  await expect(page.locator("#connection-message")).toHaveText("Could not retrieve usage limits.");
  await expect(page.locator("#app-version-badge")).toHaveText(`v${appVersion}`);
  await expect(page.locator("#five-hour-percent")).toHaveText("—");
  await expect(page.locator("#weekly-percent")).toHaveText("—");
});

test("preserves a fresh event if the initial usage request fails", async ({ page }) => {
  await installTauriMock(page, { usageFailure: true, usageEventOnListen: usageState(61, 69, "online") });
  await expect(page.locator("#connection-message")).toBeHidden();
  await expect(page.locator("#five-hour-percent")).toHaveText("61%");
  await expect(page.locator("#weekly-percent")).toHaveText("69%");
});

test("keeps a valid snapshot while reporting an unavailable event subscription", async ({ page }) => {
  await installTauriMock(page, { listenFailure: true });
  await expect(page.locator("#connection-message")).toHaveText("Could not subscribe to usage updates.");
  await expect(page.locator("#five-hour-percent")).toHaveText("72%");
  await expect(page.locator("#weekly-percent")).toHaveText("64%");
});

test("keeps the version badge visible if version lookup fails", async ({ page }) => {
  await installTauriMock(page, { versionFailure: true });
  const badge = page.locator("#app-version-badge");
  await expect(badge).toHaveText("v—");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("aria-label", "Version unavailable");
});

test("reports settings load and save failures", async ({ page }) => {
  await installTauriMock(page, { loadFailure: true, saveFailure: true });
  await expect(page.locator("#connection-message")).toBeVisible();
  await expect(page.locator("#app-version-badge")).toHaveText(`v${appVersion}`);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Español" }).click();
  await expect(page.locator("#general-panel .save-message")).toHaveText("No se pudieron guardar los cambios.");
});

test("reports failure to resize without persisting compact mode", async ({ page }) => {
  await installTauriMock(page, { failures: ["set_ultra_compact"] });
  await page.getByRole("button", { name: "Turn on ultra-compact mode" }).click();
  await expect(page.locator("#connection-message")).toHaveText("Could not change the window size.");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "false");
  await expect(page.locator("#ultra-compact-button")).toHaveAttribute("aria-pressed", "false");
});

test("keeps the old layout and preference when the native resize is not confirmed", async ({ page }) => {
  await installTauriMock(page, { resizeFailure: true });
  await page.getByRole("button", { name: "Turn on ultra-compact mode" }).click();

  await expect(page.locator("#connection-message")).toHaveText("Could not change the window size.");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ultra-compact", "false");
  await expect(page.locator("#ultra-compact-button")).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual({ width: 360, height: 220 });
  await expect.poll(async () => page.evaluate(() => window.__mockGetSettings().ultraCompact)).toBe(false);
  await verifyVisibleLayout(page, { width: 360, height: 220 });
});

test("starts native dragging from the app name and open header space, never from controls", async ({ page }) => {
  await installTauriMock(page, {});
  await page.locator(".app-name").dispatchEvent("pointerdown", { button: 0 });
  await page.locator(".drag-handle").dispatchEvent("pointerdown", { button: 0 });
  await page.locator("#settings-button").dispatchEvent("pointerdown", { button: 0 });

  await expect.poll(async () => page.evaluate(() => window.__mockDragCalls.length)).toBe(2);
  expect(await page.evaluate(() => window.__mockDragCalls)).toEqual(["start", "start"]);
});

async function verifySettingsContent(page) {
  await expect.poll(() => page.locator(".app-shell").getAttribute("data-mode-transition")).toBeNull();
  const bounds = await page.locator("#settings-panel").evaluate((panel) => {
    const nodes = [...panel.querySelectorAll("button, input, label, legend, .setting-label, #remembered-close-text, .save-message")]
      .filter((node) => node.getClientRects().length > 0);
    return {
      width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      nodes: nodes.map((node) => { const r = node.getBoundingClientRect(); return { text: node.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; }),
      bottom: panel.getBoundingClientRect().bottom,
    };
  });
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
  expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.height);
  for (const node of bounds.nodes) {
    expect(node.left, JSON.stringify(node)).toBeGreaterThanOrEqual(0);
    expect(node.right, JSON.stringify(node)).toBeLessThanOrEqual(bounds.width);
    expect(node.bottom, JSON.stringify(node)).toBeLessThanOrEqual(bounds.height);
  }
  expect(bounds.height - bounds.bottom).toBeLessThanOrEqual(8);
  return bounds;
}

for (const compact of [false, true]) {
  for (const language of ["en", "es"]) {
    test(`fits all Settings controls and errors from ${compact ? "compact" : "normal"} in ${language}`, async ({ page }) => {
      await installTauriMock(page, { settings: { ultraCompact: compact, language, closeAction: "minimize" } });
      await page.locator("#settings-button").click();
      await verifySettingsContent(page);
      await expect(page.locator("#remembered-close-text")).toBeVisible();
      if (compact && language === "en") await page.screenshot({ path: path.join(previewDirectory, "settings-general.png"), animations: "disabled" });
      await page.locator("#limits-tab").click();
      await verifySettingsContent(page);
      await page.locator("#threshold-5h-value").fill("101");
      await page.locator("#threshold-5h-value").blur();
      await expect(page.locator("#limits-panel .save-message")).toBeVisible();
      await verifySettingsContent(page);
      await page.locator("#settings-button").click();
      await verifyVisibleLayout(page, compact ? { width: 300, height: 156 } : { width: 360, height: 220 });
    });
  }
}

const alertCases = require("../usage-color-cases.json");
for (const threshold of [0, 20, 50, 100]) {
  test(`matches native alert colors and bubble boundaries at threshold ${threshold}`, async ({ page }) => {
    await installTauriMock(page, { settings: { threshold5h: threshold, thresholdWeekly: threshold } });
    await page.addStyleTag({ content: ".meter-fill { transition: none !important; }" });
    for (const compact of [false, true]) {
      if (compact) await page.locator("#ultra-compact-button").click();
      for (const sample of alertCases.filter((sample) => sample.threshold === threshold)) {
        await page.evaluate((state) => window.__mockEmitUsage(state), usageState(sample.remaining, sample.remaining));
        for (const selector of ["#five-hour", "#weekly"]) {
          const card = page.locator(`${selector}-card`);
          await expect(card).toHaveAttribute("data-alert", sample.alert);
          await expect(page.locator(`${selector}-percent`)).toHaveCSS("color", `rgb(${sample.mid.join(", ")})`);
          const result = await card.evaluate((node) => ({
            mid: getComputedStyle(node).getPropertyValue("--water-mid").trim(),
            bubbles: [...node.querySelectorAll(".meter-bubble")].map((bubble) => getComputedStyle(bubble).display),
            fillWidth: node.querySelector(".meter-fill").getBoundingClientRect().width,
            clip: getComputedStyle(node.querySelector(".meter-fill")).overflow,
            marker: getComputedStyle(node.querySelector(".threshold-marker i")).backgroundColor,
          }));
          expect(result.mid).toBe("#" + sample.mid.map((channel) => channel.toString(16).padStart(2, "0")).join(""));
          expect(result.bubbles).toEqual(Array(4).fill(sample.alert === "critical" ? "block" : "none"));
          expect(result.clip).toBe("hidden");
          expect(result.marker).toBe("rgb(182, 186, 194)");
          if (sample.remaining === 0) expect(result.fillWidth).toBe(0);
        }
      }
    }
  });
}

test("uses independent threshold colors and respects reduced motion", async ({ page }) => {
  await installTauriMock(page, { settings: { threshold5h: 20, thresholdWeekly: 50 }, usageState: usageState(25, 25) });
  await expect(page.locator("#five-hour-percent")).toHaveCSS("color", "rgb(220, 112, 64)");
  await expect(page.locator("#weekly-percent")).toHaveCSS("color", "rgb(242, 66, 78)");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("#weekly-card .meter-bubble").first()).toHaveCSS("animation-name", "bubble-rise");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#weekly-card .meter-bubble").first()).toHaveCSS("animation-name", "none");
  await page.screenshot({ path: path.join(previewDirectory, "threshold-alerts.png"), animations: "disabled" });
});

test("ignores an older startup response and older events after a newer event", async ({ page }) => {
  await installTauriMock(page, { usageReadDelayMs: 300, waitForInitialization: false });
  await expect.poll(() => commandCalls(page, "get_usage_state")).not.toHaveLength(0);
  await page.evaluate((state) => window.__mockEmitUsage({ ...state, revision: 10 }), usageState(31, 82));
  await page.waitForFunction(() => window.__mockPanelShown);
  await expect(page.locator("#five-hour-percent")).toHaveText("31%");
  await page.evaluate((state) => window.__mockEmitUsage({ ...state, revision: 2 }), usageState(61, 69));
  await expect(page.locator("#five-hour-percent")).toHaveText("31%");
});

test("a native initialization failure preserves valid usage and the saved close choice", async ({ page }) => {
  await installTauriMock(page, { settings: { closeAction: "minimize" }, failures: ["get_native_window_mode"] });
  await expect(page.locator("#connection-message")).toHaveText("Could not change the window size.");
  await expect(page.locator("#five-hour-percent")).toHaveText("72%");
  await page.locator("#close-button").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(() => commandCalls(page, "minimize_panel")).toHaveLength(1);
});

test("preferences load failure keeps fresh usage and reports the correct cause", async ({ page }) => {
  await installTauriMock(page, { loadFailure: true });
  await expect(page.locator("#connection-message")).toHaveText("Could not load preferences.");
  await expect(page.locator("#five-hour-percent")).toHaveText("72%");
  await expect(page.locator("#weekly-percent")).toHaveText("64%");
});

test("pending preference saves cannot overwrite a remembered close action", async ({ page }) => {
  await installTauriMock(page, { saveDelayMs: 150 });
  await page.locator("#settings-button").click();
  await page.locator("#language-es").click();
  await expect.poll(() => commandCalls(page, "save_settings")).not.toHaveLength(0);
  await page.locator("#close-button").click();
  await page.locator("#remember-close-choice").check();
  await page.locator("#minimize-close-button").click();
  await expect.poll(() => commandCalls(page, "minimize_panel")).toHaveLength(1);
  await page.evaluate(() => window.__mockEmitRestored());
  await page.locator("#close-button").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(() => commandCalls(page, "minimize_panel")).toHaveLength(2);
  await page.reload();
  await page.waitForFunction(() => window.__mockPanelShown);
  await page.locator("#close-button").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(() => commandCalls(page, "minimize_panel")).toHaveLength(1);
  expect(await page.evaluate(() => window.__mockGetSettings())).toMatchObject({ language: "es", closeAction: "minimize" });
});

test("restoring the main panel resynchronizes usage without removing its controls", async ({ page }) => {
  await installTauriMock(page, {});
  await page.locator("#minimize-button").click();
  await page.evaluate(() => { window.__mockCurrentUsage.status = "stale"; window.__mockCurrentUsage.revision += 1; window.__mockEmitRestored(); });
  await expect(page.locator("#five-hour-percent")).toHaveText("—");
  for (const name of ["Settings", "Minimize", "Close", "Turn on ultra-compact mode"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(page.locator("[data-resize-direction]")).toHaveCount(2);
});

test("shows panel when initialize rejects", async ({ page }) => {
  await page.addInitScript(() => {
    let armed = false;
    window.addEventListener("DOMContentLoaded", () => {
      armed = true;
    });
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (armed && this.id === "general-tab" && name === "aria-selected") {
        throw new Error("Simulated initialize failure");
      }
      return originalSetAttribute.call(this, name, value);
    };
  });
  await installTauriMock(page);
  await page.waitForFunction(() => window.__mockPanelShown);
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("shared fixtures and app settings match defaults", async ({ page }) => {
  await installTauriMock(page, {});
  const appSettings = await page.evaluate(() => window.__mockGetSettings());
  expect(appSettings.threshold5h).toBe(20);
  expect(appSettings.thresholdWeekly).toBe(20);
  expect(appSettings.alwaysOnTop).toBe(true);
  expect(appSettings.soundEnabled).toBe(false);
  expect(appSettings.closeAction).toBe("ask");
  expect(appSettings.ultraCompact).toBe(false);
  expect(appSettings.normalWindowSize).toEqual({ width: 360, height: 220 });
  expect(appSettings.ultraCompactWindowSize).toEqual({ width: 300, height: 156 });
});

test("js palette matches shared cases", () => {
  const spec = require("../../frontend/usage-colors.json");
  const cases = require("../usage-color-cases.json");
  const { usagePalette } = require("../../frontend/usage-colors.js");
  for (const item of cases) {
    const result = usagePalette(spec, item.remaining, item.threshold);
    expect(result.mid).toEqual(item.mid);
  }
});

test("malformed palette uses fallback", () => {
  const { usagePalette } = require("../../frontend/usage-colors.js");
  const fallback = usagePalette(null, 50, 20);
  expect(Array.isArray(fallback.mid)).toBe(true);
  expect(fallback.mid).toHaveLength(3);
  const broken = usagePalette({}, 50, 20);
  expect(Array.isArray(broken.mid)).toBe(true);
  expect(broken.mid).toHaveLength(3);
});
