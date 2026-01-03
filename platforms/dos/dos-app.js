(() => {
  "use strict";

  // Auto bundle (served by your local dev server)
  const DEFAULT_BUNDLE_URL = "bios/win98.jsdos";
  const AUTO_BOOT_TEXT = "BOOT C:";

  const els = {
    fileBundle: document.getElementById("fileBundle"),
    btnStart: document.getElementById("btnStart"),
    btnStop: document.getElementById("btnStop"),
    status: document.getElementById("status"),
    mount: document.getElementById("dos"),
    screen: document.querySelector(".screen"),
  };

  /** @type {any} */
  let dosInstance = null;
  /** @type {string} */
  let bundleObjectUrl = "";
  /** @type {{mode: "file" | "url", label: string, url?: string} | null} */
  let activeSource = null;

  // === Touch controls (mobile/iPad) ===

  const touchPressedKeys = new Set();

  function dispatchSyntheticKey(type, key) {
    if (!key) return;
    const ev = new KeyboardEvent(type, {
      key,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
  }

  function pressBrowserKey(key) {
    if (!key || touchPressedKeys.has(key)) return;
    touchPressedKeys.add(key);
    dispatchSyntheticKey("keydown", key);
  }

  function releaseBrowserKey(key) {
    if (!key || !touchPressedKeys.has(key)) return;
    touchPressedKeys.delete(key);
    dispatchSyntheticKey("keyup", key);
  }

  function bindTouchButton(btn, key) {
    let activePointerId = null;

    const onDown = (e) => {
      if (!e || (e.pointerType && e.pointerType === "mouse")) return;
      e.preventDefault();
      e.stopPropagation();

      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      activePointerId = e.pointerId;
      pressBrowserKey(key);
      btn.classList.add("touchBtn--active");
    };

    const onUp = (e) => {
      if (activePointerId == null) return;
      if (e && e.pointerId != null && e.pointerId !== activePointerId) return;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      releaseBrowserKey(key);
      activePointerId = null;
      btn.classList.remove("touchBtn--active");
    };

    btn.addEventListener("pointerdown", onDown);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onUp);
    btn.addEventListener("lostpointercapture", onUp);
  }

  function ensureDosTouchControls() {
    if (!els.screen) return;
    if (els.screen.querySelector(".touchControls")) return;

    const root = document.createElement("div");
    root.className = "touchControls";
    root.setAttribute("aria-label", "Touch controls");
    root.innerHTML = `
      <div class="touchControls__left">
        <div class="dpad" aria-label="D-pad">
          <span class="touchSpacer"></span>
          <button type="button" class="touchBtn" data-action="up">↑</button>
          <span class="touchSpacer"></span>
          <button type="button" class="touchBtn" data-action="left">←</button>
          <span class="touchSpacer"></span>
          <button type="button" class="touchBtn" data-action="right">→</button>
          <span class="touchSpacer"></span>
          <button type="button" class="touchBtn" data-action="down">↓</button>
          <span class="touchSpacer"></span>
        </div>
      </div>
      <div class="touchControls__right">
        <div class="touchRow">
          <button type="button" class="touchBtn touchBtn--wide" data-action="esc">Esc</button>
          <button type="button" class="touchBtn touchBtn--wide" data-action="enter">Enter</button>
        </div>
      </div>
    `;

    els.screen.appendChild(root);

    const map = {
      up: "ArrowUp",
      down: "ArrowDown",
      left: "ArrowLeft",
      right: "ArrowRight",
      enter: "Enter",
      esc: "Escape",
    };

    const buttons = root.querySelectorAll("button[data-action]");
    buttons.forEach((btn) => {
      const action = btn.getAttribute("data-action");
      const key = map[action] || "";
      bindTouchButton(btn, key);
    });
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function enableRunControls(canStart, canStop) {
    els.btnStart.disabled = !canStart;
    els.btnStop.disabled = !canStop;
  }

  function revokeBundleUrl() {
    if (bundleObjectUrl) {
      URL.revokeObjectURL(bundleObjectUrl);
      bundleObjectUrl = "";
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function fileExists(url) {
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function typeBootCommand(ci) {
    // Use CI key events to type: BOOT C: + Enter
    // Key codes are DOM keyCode values.
    const press = (code) => ci.sendKeyEvent(code, true);
    const release = (code) => ci.sendKeyEvent(code, false);
    const tap = async (code) => {
      press(code);
      await sleep(10);
      release(code);
      await sleep(25);
    };

    const tapShifted = async (code) => {
      press(16); // Shift
      await sleep(10);
      press(code);
      await sleep(10);
      release(code);
      await sleep(10);
      release(16);
      await sleep(25);
    };

    // BOOT C:
    const letters = [66, 79, 79, 84]; // B O O T
    for (const code of letters) await tap(code);
    await tap(32); // space
    await tap(67); // C
    await tapShifted(186); // ':' (shift + ';')
    await tap(13); // Enter
  }

  async function stop() {
    enableRunControls(false, false);

    try {
      if (dosInstance && typeof dosInstance.stop === "function") {
        await dosInstance.stop();
      }
    } catch {
      // ignore
    }

    dosInstance = null;
    // Clear mount to avoid overlapping canvases
    els.mount.innerHTML = "";
    revokeBundleUrl();

    if (activeSource?.mode === "url") {
      setStatus(`Đã dừng. Auto: ${activeSource.label}`);
      enableRunControls(true, false);
    } else {
      const file = els.fileBundle.files && els.fileBundle.files[0];
      setStatus(file ? `Đã dừng. File: ${file.name}` : "Đã dừng.");
      enableRunControls(!!file, false);
    }
  }

  async function startFromUrl(url, label) {
    if (typeof window.Dos !== "function") {
      setStatus("Thiếu js-dos (CDN chưa load). Hãy thử reload trang.");
      return;
    }

    await stop();

    activeSource = { mode: "url", url, label };
    setStatus("Đang khởi động...");
    enableRunControls(false, true);

    try {
      const maybeProps = window.Dos(els.mount, {
        url,
        autoStart: true,
        theme: "dark",
        backend: "dosboxX",
        backendLocked: true,
        renderAspect: "4/3",
        imageRendering: "smooth",
        kiosk: true,
        noNetworking: true,
        noCloud: true,
        scaleControls: 0.16,
        mouseCapture: false,
        onEvent: async (event, ci) => {
          if (event === "ci-ready" && ci) {
            // Give DOSBox-X a bit of time to show the prompt.
            await sleep(1200);
            try {
              await typeBootCommand(ci);
            } catch {
              // ignore
            }
          }
        },
      });

      dosInstance =
        maybeProps && typeof maybeProps.then === "function"
          ? await maybeProps
          : maybeProps;

      setStatus(`Đang chạy: ${label}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Lỗi: ${msg}`);
      enableRunControls(true, false);
    }
  }

  async function startFromFile() {
    const file = els.fileBundle.files && els.fileBundle.files[0];
    if (!file) return;

    if (typeof window.Dos !== "function") {
      setStatus("Thiếu js-dos (CDN chưa load). Hãy thử reload trang.");
      return;
    }

    await stop();

    setStatus("Đang khởi động...");
    enableRunControls(false, true);

    activeSource = { mode: "file", label: file.name };

    // Create an object URL for local bundle
    bundleObjectUrl = URL.createObjectURL(file);

    try {
      // js-dos v8 entrypoint: Dos(element, options)
      // The simplest v8 usage is to provide `url` in options (no need to call .run()).
      const maybeProps = window.Dos(els.mount, {
        url: bundleObjectUrl,
        autoStart: true,
        theme: "dark",
        backend: "dosboxX",
        backendLocked: true,
        renderAspect: "4/3",
        imageRendering: "smooth",
        kiosk: true,
        noNetworking: true,
        noCloud: true,
        scaleControls: 0.16,
        mouseCapture: false,
        onEvent: async (event, ci) => {
          if (event === "ci-ready" && ci) {
            await sleep(1200);
            try {
              await typeBootCommand(ci);
            } catch {
              // ignore
            }
          }
        },
      });

      dosInstance =
        maybeProps && typeof maybeProps.then === "function"
          ? await maybeProps
          : maybeProps;

      setStatus(`Đang chạy: ${file.name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Lỗi: ${msg}`);
      enableRunControls(!!file, false);
    }
  }

  els.fileBundle.addEventListener("change", () => {
    const file = els.fileBundle.files && els.fileBundle.files[0];
    if (!file) {
      setStatus("Chưa chọn file.");
      enableRunControls(false, false);
      return;
    }

    setStatus(`Đã chọn: ${file.name}`);
    enableRunControls(true, false);
  });

  els.btnStart.addEventListener("click", () => {
    if (activeSource?.mode === "url" && activeSource.url) {
      void startFromUrl(activeSource.url, activeSource.label);
      return;
    }
    void startFromFile();
  });

  els.btnStop.addEventListener("click", () => {
    stop();
  });

  // Initial state
  setStatus("Chưa chọn file.");
  enableRunControls(false, false);

  ensureDosTouchControls();

  // Auto-load default bundle if present
  void (async () => {
    const exists = await fileExists(DEFAULT_BUNDLE_URL);
    if (!exists) return;

    // Hide file picker (still can be shown later if you want)
    if (els.fileBundle) els.fileBundle.style.display = "none";
    activeSource = {
      mode: "url",
      url: DEFAULT_BUNDLE_URL,
      label: "win98.jsdos",
    };
    setStatus("Tự động load Win98...");
    enableRunControls(true, false);
    await startFromUrl(DEFAULT_BUNDLE_URL, "win98.jsdos");
  })();
})();
