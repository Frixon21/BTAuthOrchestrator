// BT Auth Orchestrator admin console: theme preference (CONTRACT-010 §7).
// Loaded in <head> so an explicit Light or Dark choice applies before the
// first paint. Only the theme preference is stored in localStorage; it is not
// secret. If storage is unavailable the choice lasts for this page only.
(function () {
  "use strict";
  var KEY = "btConsole.theme";
  var memory = null;

  function isTheme(value) {
    return value === "system" || value === "light" || value === "dark";
  }

  function storage() {
    try {
      return window.localStorage || null;
    } catch (error) {
      return null;
    }
  }

  function get() {
    if (memory !== null) return memory;
    var store = storage();
    var value = null;
    if (store) {
      try {
        value = store.getItem(KEY);
      } catch (error) {
        value = null;
      }
    }
    return isTheme(value) ? value : "system";
  }

  function apply(value) {
    var root = document.documentElement;
    if (value === "light" || value === "dark") root.setAttribute("data-theme", value);
    else root.removeAttribute("data-theme");
  }

  function set(value) {
    var theme = isTheme(value) ? value : "system";
    memory = theme;
    var store = storage();
    if (store) {
      try {
        store.setItem(KEY, theme);
      } catch (error) {
        // Storage refused: the in-memory choice still applies to this page.
      }
    }
    apply(theme);
    return theme;
  }

  apply(get());
  window.BTConsoleTheme = { get: get, set: set };
})();
