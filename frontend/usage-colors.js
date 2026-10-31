"use strict";

const defaultFallbackPalette = {
  deep: [40, 44, 52],
  mid: [105, 107, 116],
  light: [170, 174, 184],
};

function isValidSpec(spec) {
  return Boolean(
    spec
      && typeof spec === "object"
      && Array.isArray(spec.steps)
      && spec.steps.length === 10
      && spec.warning
      && spec.threshold
      && spec.zero,
  );
}

function usagePalette(spec, remaining, threshold) {
  if (!isValidSpec(spec)) return defaultFallbackPalette;
  const value = Math.max(0, Math.min(100, remaining));
  const limit = Math.max(0, Math.min(100, threshold));
  if (value > limit + 5) return spec.steps[Math.min(9, Math.floor(value / 10))];
  const from = value > limit ? spec.warning : spec.threshold;
  const to = value > limit ? spec.threshold : spec.zero;
  const amount = value > limit ? (limit + 5 - value) / 5 : limit === 0 ? 1 : (limit - value) / limit;
  return Object.fromEntries(["deep", "mid", "light"].map((key) => [key,
    from[key].map((channel, index) => Math.round(channel + (to[key][index] - channel) * amount)),
  ]));
}

if (typeof module !== "undefined") module.exports = { usagePalette };
if (typeof window !== "undefined") {
  window.UsageColors = {
    spec: null,
    ready: fetch("./usage-colors.json").then((response) => {
      if (!response.ok) throw new Error("Color specification unavailable");
      return response.json();
    }).then((spec) => { window.UsageColors.spec = spec; }),
    palette(remaining, threshold) {
      return this.spec ? usagePalette(this.spec, remaining, threshold) : null;
    },
    hex(channels) {
      return "#" + channels.map((value) => value.toString(16).padStart(2, "0")).join("");
    },
  };
}
