// coi.js - Self-contained zero-dependency Cross-Origin Isolation for GitHub Pages
// Enables SharedArrayBuffer on static hosts without server-side header control.
(() => {
  if (typeof window === "undefined") {
    // --------------------------------------------------------------------------
    // 1. Service Worker Context: Intercept requests & inject COOP/COEP headers
    // --------------------------------------------------------------------------
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) =>
      event.waitUntil(self.clients.claim()),
    );

    self.addEventListener("fetch", (event) => {
      const { request } = event;
      if (
        request.cache === "only-if-cached" &&
        request.mode !== "same-origin"
      ) {
        return;
      }

      event.respondWith(
        fetch(request).then((response) => {
          if (response.status === 0) return response; // Opaque cross-origin response

          const newHeaders = new Headers(response.headers);
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
          newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");

          const hasNoBody = [101, 204, 205, 304].includes(response.status);
          return new Response(hasNoBody ? null : response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        }),
      );
    });
  } else {
    // --------------------------------------------------------------------------
    // 2. Window Context: Register itself as the SW if isolation is missing
    // --------------------------------------------------------------------------
    if (window.crossOriginIsolated) {
      window.sessionStorage.removeItem("coiReloaded");
    } else if ("serviceWorker" in navigator) {
      const reloaded = window.sessionStorage.getItem("coiReloaded");
      if (!reloaded) {
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          window.sessionStorage.setItem("coiReloaded", "true");
          window.location.reload();
        });

        const scriptSrc =
          (window.document.currentScript &&
            window.document.currentScript.src) ||
          "coi.js";

        navigator.serviceWorker
          .register(scriptSrc)
          .then((registration) => {
            if (registration.active && !navigator.serviceWorker.controller) {
              window.sessionStorage.setItem("coiReloaded", "true");
              window.location.reload();
            }
          })
          .catch((err) =>
            console.warn("COOP/COEP Service Worker failed to register:", err),
          );
      }
    }
  }
})();
