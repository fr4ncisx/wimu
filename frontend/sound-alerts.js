"use strict";

(() => {
  const audioFiles = {
    reset: "./assets/sounds/reset.mp3",
    threshold: "./assets/sounds/threshold.mp3",
  };
  const audioPlayers = new Map();
  let lastRevision = -1;
  let previous = null;

  function validWindow(windowData) {
    if (!windowData || typeof windowData !== "object") return null;
    const remaining = Number(windowData.remainingPercent);
    const resetsAt = Number(windowData.resetsAt);
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100
      || !Number.isSafeInteger(resetsAt) || resetsAt <= 0) return null;
    return { remaining, resetsAt };
  }

  function play(name) {
    let player = audioPlayers.get(name);
    if (!player) {
      player = new Audio(new URL(audioFiles[name], document.baseURI));
      player.preload = "none";
      audioPlayers.set(name, player);
    }
    player.currentTime = 0;
    player.play()?.catch(() => {});
  }

  function accept(state, thresholds, enabled) {
    if (!state || !Number.isSafeInteger(state.revision) || state.revision <= lastRevision) return;
    lastRevision = state.revision;
    if (state.status !== "online") {
      previous = null;
      return;
    }

    const current = {
      fiveHour: validWindow(state.fiveHour),
      weekly: validWindow(state.weekly),
      updatedAt: Number(state.lastUpdatedAt),
      thresholds: {
        fiveHour: Number(thresholds.fiveHour),
        weekly: Number(thresholds.weekly),
      },
    };
    if (!Number.isSafeInteger(current.updatedAt) || current.updatedAt <= 0) {
      previous = null;
      return;
    }
    if (previous && current.updatedAt < previous.updatedAt) return;
    const sounds = new Set();
    if (previous) {
      for (const period of ["fiveHour", "weekly"]) {
        const before = previous[period];
        const after = current[period];
        if (!before || !after) continue;
        const resetBoundary = before.resetsAt * 1_000;
        if (Number.isSafeInteger(resetBoundary)
          && previous.updatedAt < resetBoundary
          && current.updatedAt >= resetBoundary
          && after.resetsAt > before.resetsAt) {
          sounds.add("reset");
        } else if (previous.thresholds[period] === current.thresholds[period]
          && before.remaining > current.thresholds[period]
          && after.remaining <= current.thresholds[period]) {
          sounds.add("threshold");
        }
      }
    }
    previous = current;
    if (enabled) for (const sound of sounds) play(sound);
  }

  window.WimuSoundAlerts = { accept };
})();
