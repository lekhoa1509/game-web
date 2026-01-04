(() => {
  "use strict";

  const ua = String(navigator.userAgent || "");

  // Prefer UA-CH when available.
  const uaData = /** @type {{ mobile?: boolean }|undefined} */ (
    navigator.userAgentData
  );

  const isUaMobile =
    !!(uaData && uaData.mobile) ||
    /Android|iPhone|iPad|iPod|Windows Phone|webOS|Mobile/i.test(ua);

  // iPadOS 13+ often reports as "Macintosh"; detect via touch points.
  const isIpadOs = navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua);

  const isMobile = isUaMobile || isIpadOs;

  document.documentElement.classList.toggle("isMobile", isMobile);
})();
