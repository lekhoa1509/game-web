(() => {
  "use strict";

  // Gamepad -> synthetic keyboard events.
  // This intentionally reuses each page's existing keyboard bindings.

  const DEFAULT_BINDS = Object.freeze({
    up: "up",
    down: "down",
    left: "left",
    right: "right",
    a: "z",
    b: "x",
    x: "s",
    y: "a",
    l: "q",
    r: "e",
    start: "enter",
    select: "shift",
  });

  const DEADZONE = 0.45;
  const TRIGGER_THRESHOLD = 0.35;

  /** @type {Record<string, string>} */
  let binds = { ...DEFAULT_BINDS };

  /** @type {Record<string, boolean>} */
  const lastPressed = Object.create(null);

  let enabled = true;
  let rafId = 0;

  function isTextInputActive() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input") {
      const type = String(el.getAttribute("type") || "").toLowerCase();
      // Treat most input types as text-like; allow buttons/checkboxes.
      if (
        !type ||
        [
          "text",
          "search",
          "email",
          "password",
          "number",
          "tel",
          "url",
          "date",
          "datetime-local",
          "month",
          "time",
          "week",
        ].includes(type)
      ) {
        return true;
      }
    }
    if (tag === "textarea") return true;
    // @ts-ignore
    if (el.isContentEditable) return true;
    return false;
  }

  function retroKeyToDomKey(retroKey) {
    const k = String(retroKey || "").trim();
    if (!k) return "";
    const lower = k.toLowerCase();

    if (lower === "up") return "ArrowUp";
    if (lower === "down") return "ArrowDown";
    if (lower === "left") return "ArrowLeft";
    if (lower === "right") return "ArrowRight";

    if (lower === "enter") return "Enter";
    if (lower === "shift") return "Shift";
    if (lower === "escape") return "Escape";
    if (lower === "space") return " ";
    if (lower === "tab") return "Tab";
    if (lower === "backspace") return "Backspace";
    if (lower === "delete") return "Delete";
    if (lower === "ctrl" || lower === "control") return "Control";
    if (lower === "alt") return "Alt";
    if (lower === "meta") return "Meta";

    // letters/digits and other printable keys
    return lower;
  }

  function makeKeyboardEvent(type, domKey) {
    const k = String(domKey || "");

    /** @type {KeyboardEventInit} */
    const init = {
      key: k,
      bubbles: true,
      cancelable: true,
    };

    // Provide a best-effort code for common keys.
    if (k === "ArrowUp") init.code = "ArrowUp";
    else if (k === "ArrowDown") init.code = "ArrowDown";
    else if (k === "ArrowLeft") init.code = "ArrowLeft";
    else if (k === "ArrowRight") init.code = "ArrowRight";
    else if (k === "Enter") init.code = "Enter";
    else if (k === "Shift") init.code = "ShiftLeft";
    else if (k === "Escape") init.code = "Escape";
    else if (k === " ") init.code = "Space";
    else if (k === "Tab") init.code = "Tab";
    else if (k === "Backspace") init.code = "Backspace";
    else if (k === "Delete") init.code = "Delete";
    else if (k === "Control") init.code = "ControlLeft";
    else if (k === "Alt") init.code = "AltLeft";
    else if (k === "Meta") init.code = "MetaLeft";
    else if (k.length === 1) {
      const c = k.toUpperCase();
      if (c >= "A" && c <= "Z") init.code = `Key${c}`;
      else if (c >= "0" && c <= "9") init.code = `Digit${c}`;
    }

    return new KeyboardEvent(type, init);
  }

  function dispatchSyntheticKey(type, domKey) {
    if (!domKey) return;
    const ev = makeKeyboardEvent(type, domKey);

    // Some libs listen on window, some on document.
    try {
      window.dispatchEvent(ev);
    } catch {
      // ignore
    }
    try {
      document.dispatchEvent(ev);
    } catch {
      // ignore
    }
  }

  function buttonPressed(btn) {
    if (!btn) return false;
    if (typeof btn === "object" && "pressed" in btn) return !!btn.pressed;
    return false;
  }

  function axis(gp, idx) {
    try {
      const v = gp && Array.isArray(gp.axes) ? gp.axes[idx] : 0;
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  function buttonValue(gp, idx) {
    try {
      const b = gp && Array.isArray(gp.buttons) ? gp.buttons[idx] : null;
      if (!b) return 0;
      if (typeof b === "object" && "value" in b) {
        const v = Number(b.value);
        return Number.isFinite(v) ? v : buttonPressed(b) ? 1 : 0;
      }
      return buttonPressed(b) ? 1 : 0;
    } catch {
      return 0;
    }
  }

  function computeActionPressed(gpList, action) {
    for (const gp of gpList) {
      if (!gp) continue;
      const btn = (i) => buttonPressed(gp.buttons && gp.buttons[i]);

      if (action === "up") {
        if (btn(12) || axis(gp, 1) < -DEADZONE) return true;
      } else if (action === "down") {
        if (btn(13) || axis(gp, 1) > DEADZONE) return true;
      } else if (action === "left") {
        if (btn(14) || axis(gp, 0) < -DEADZONE) return true;
      } else if (action === "right") {
        if (btn(15) || axis(gp, 0) > DEADZONE) return true;
      } else if (action === "a") {
        if (btn(0)) return true;
      } else if (action === "b") {
        if (btn(1)) return true;
      } else if (action === "x") {
        if (btn(2)) return true;
      } else if (action === "y") {
        if (btn(3)) return true;
      } else if (action === "l") {
        if (btn(4) || buttonValue(gp, 6) > TRIGGER_THRESHOLD) return true;
      } else if (action === "r") {
        if (btn(5) || buttonValue(gp, 7) > TRIGGER_THRESHOLD) return true;
      } else if (action === "select") {
        if (btn(8)) return true;
      } else if (action === "start") {
        if (btn(9)) return true;
      }
    }

    return false;
  }

  function listConnectedGamepads() {
    try {
      const gps =
        typeof navigator.getGamepads === "function"
          ? navigator.getGamepads()
          : [];
      return Array.from(gps || []).filter(Boolean);
    } catch {
      return [];
    }
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!enabled) return;
    if (isTextInputActive()) return;

    const gpList = listConnectedGamepads();
    if (!gpList.length) return;

    // Use binds' keys to know what actions to handle.
    const actions = Object.keys(binds);
    for (const action of actions) {
      const pressed = computeActionPressed(gpList, action);
      const prev = !!lastPressed[action];
      if (pressed === prev) continue;

      lastPressed[action] = pressed;

      const retroKey = binds[action];
      const domKey = retroKeyToDomKey(retroKey);
      if (!domKey) continue;

      dispatchSyntheticKey(pressed ? "keydown" : "keyup", domKey);
    }
  }

  function start() {
    if (rafId) return;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function setBinds(next) {
    if (!next || typeof next !== "object") return;
    // Merge to keep defaults for missing keys.
    binds = { ...DEFAULT_BINDS, ...next };
  }

  function setEnabled(nextEnabled) {
    enabled = !!nextEnabled;
    if (!enabled) {
      // Release any currently held keys.
      for (const action of Object.keys(lastPressed)) {
        if (!lastPressed[action]) continue;
        lastPressed[action] = false;
        const domKey = retroKeyToDomKey(binds[action]);
        dispatchSyntheticKey("keyup", domKey);
      }
    }
  }

  // Expose a small API for each platform page to sync keybinds.
  window.GameWebGamepad = Object.freeze({
    setBinds,
    setEnabled,
    start,
    stop,
    getBinds: () => ({ ...binds }),
    getConnectedGamepads: () =>
      listConnectedGamepads().map((g) => ({
        index: g.index,
        id: g.id,
        mapping: g.mapping,
      })),
  });

  // Start polling immediately.
  start();

  // Keep browser recognizing pads (some browsers only update after events).
  window.addEventListener("gamepadconnected", () => {
    // no-op: polling will pick it up
  });

  window.addEventListener("gamepaddisconnected", () => {
    // Release all keys to avoid stuck input.
    setEnabled(enabled);
  });
})();
