// BT Auth Orchestrator admin console (CONTRACT-010).
//
// Safety rules for this file:
// - All dynamic text is written with textContent or text nodes. HTML-parsing
//   APIs and string-built code are never used.
// - Element styling changes only through classes and the hidden attribute.
// - Each bearer token is sent only to its own endpoints (see tokenKindFor).
// - Tokens and the acting-as label live in sessionStorage, or in memory when
//   sessionStorage is unavailable. Passwords are never stored.
(function () {
  "use strict";

  var doc = document;
  var USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;
  var MIN_PASSWORD_LENGTH = 12;
  var ROTATE_WORD = "ROTATE";
  var STORAGE_KEYS = {
    admin: "btConsole.userAdminToken",
    emergency: "btConsole.emergencyToken",
    actingAs: "btConsole.actingAs"
  };
  var TOKEN_NAMES = { admin: "User-admin token", emergency: "Emergency token" };
  var SECTIONS = ["overview", "users", "keys", "settings"];
  var NETWORK_ERROR = "Unable to reach the service. Check the connection and try again.";

  function byId(id) { return doc.getElementById(id); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function el(tag, className, text) {
    var element = doc.createElement(tag);
    if (className) element.setAttribute("class", className);
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function formatTime(value) {
    if (typeof value !== "string" || value === "") return "Unknown";
    var date = new Date(value);
    return isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  // ---------------------------------------------------------------------
  // Session storage for tokens and the acting-as label, with an in-memory
  // fallback when the browser refuses storage (CONTRACT-010 §2, Failure
  // behavior).
  // ---------------------------------------------------------------------
  var sessionStore = (function () {
    var backing = null;
    var memory = Object.create(null);
    try {
      var candidate = window.sessionStorage;
      var probe = "btConsole.probe";
      candidate.setItem(probe, "1");
      candidate.removeItem(probe);
      backing = candidate;
    } catch (error) {
      backing = null;
    }
    function fallBack() { backing = null; }
    return {
      persistent: function () { return backing !== null; },
      get: function (key) {
        if (backing) {
          try { return backing.getItem(key); } catch (error) { fallBack(); }
        }
        return hasOwn(memory, key) ? memory[key] : null;
      },
      set: function (key, value) {
        if (backing) {
          try { backing.setItem(key, value); return; } catch (error) { fallBack(); }
        }
        memory[key] = value;
      },
      remove: function (key) {
        delete memory[key];
        if (backing) {
          try { backing.removeItem(key); } catch (error) { fallBack(); }
        }
      }
    };
  })();

  function getToken(kind) { return sessionStore.get(STORAGE_KEYS[kind]) || ""; }
  function hasToken(kind) { return getToken(kind) !== ""; }
  function actingAs() {
    var label = sessionStore.get(STORAGE_KEYS.actingAs) || "";
    return label.trim() === "" ? "" : label;
  }

  // ---------------------------------------------------------------------
  // Status messages. Every message is rendered as text and also announced
  // through the aria-live region.
  // ---------------------------------------------------------------------
  var lastAnnouncement = "";
  function announce(text) {
    var announcer = byId("announcer");
    // Repeated identical text would not be re-announced, so vary it slightly.
    var value = text === lastAnnouncement ? text + " " : text;
    lastAnnouncement = value;
    announcer.textContent = value;
  }

  function setMessage(id, text, kind) {
    var element = byId(id);
    element.textContent = text || "";
    element.classList.remove("is-error", "is-success", "is-info");
    if (text) {
      element.classList.add(kind === "error" ? "is-error" : kind === "success" ? "is-success" : "is-info");
      announce(text);
    }
  }

  function showToast(text, kind, settingsAction) {
    var toast = byId("toast");
    byId("toast-text").textContent = text;
    toast.classList.remove("is-error", "is-success", "is-info");
    toast.classList.add(kind === "error" ? "is-error" : kind === "success" ? "is-success" : "is-info");
    byId("toast-action").hidden = !settingsAction;
    toast.hidden = false;
    announce(text);
  }

  function hideToast() {
    byId("toast").hidden = true;
    byId("toast-text").textContent = "";
  }

  function setListState(id, text, kind) {
    var element = byId(id);
    element.textContent = text || "";
    element.hidden = !text;
    element.classList.remove("is-error", "is-loading");
    if (kind === "error") element.classList.add("is-error");
    if (kind === "loading") element.classList.add("is-loading");
  }

  // ---------------------------------------------------------------------
  // API client. tokenKindFor is the only place that decides whether a
  // request carries a token, and which one (CONTRACT-010 Inputs and outputs).
  // ---------------------------------------------------------------------
  function tokenKindFor(method, path) {
    if (method === "POST" && path === "/admin/emergency-rotate-keys") return "emergency";
    if (path === "/admin/users") return method === "POST" ? null : "admin";
    if (path.indexOf("/admin/users/") === 0) return "admin";
    return null;
  }

  function userPath(id) { return "/admin/users/" + encodeURIComponent(id); }

  async function api(method, path, body) {
    var kind = tokenKindFor(method, path);
    var headers = {};
    if (kind !== null) {
      if (!hasToken(kind)) {
        return { ok: false, status: 0, missingToken: kind,
          error: "Add the " + TOKEN_NAMES[kind].toLowerCase() + " in Settings first." };
      }
      headers.Authorization = "Bearer " + getToken(kind);
    }
    var init = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      return { ok: false, status: 0, network: true, error: NETWORK_ERROR };
    }
    var data = null;
    var parsed = false;
    try {
      data = await response.json();
      parsed = data !== null && typeof data === "object";
    } catch (error) {
      parsed = false;
    }
    var status = response.status;
    if (status === 401 && kind !== null) {
      rejectToken(kind);
      return { ok: false, status: status, unauthorized: kind,
        error: TOKEN_NAMES[kind] + " was rejected and has been forgotten. Enter it again in Settings." };
    }
    if (response.ok && parsed) return { ok: true, status: status, data: data };
    if (!response.ok && parsed && status < 500 && typeof data.error === "string" && data.error !== "") {
      return { ok: false, status: status, error: data.error };
    }
    return { ok: false, status: status,
      error: "The service could not complete the request" + (status ? " (HTTP " + status + ")" : "") + ". Try again later." };
  }

  // ---------------------------------------------------------------------
  // Token handling (CONTRACT-010 §2).
  // ---------------------------------------------------------------------
  function tokenInput(kind) { return byId(kind + "-token-input"); }

  function saveToken(kind) {
    var value = tokenInput(kind).value.trim();
    if (value === "") {
      setMessage(kind + "-token-message", "Enter a token to save.", "error");
      return;
    }
    sessionStore.set(STORAGE_KEYS[kind], value);
    tokenInput(kind).value = value;
    setMessage(kind + "-token-message",
      TOKEN_NAMES[kind] + (sessionStore.persistent() ? " saved for this browser tab." : " kept in memory for this page."), "success");
    syncControls();
    if (kind === "admin" && state.section === "users") loadUsers();
  }

  function forgetToken(kind, quiet) {
    sessionStore.remove(STORAGE_KEYS[kind]);
    tokenInput(kind).value = "";
    setReveal(kind, false);
    if (!quiet) setMessage(kind + "-token-message", TOKEN_NAMES[kind] + " forgotten.", "info");
    if (kind === "admin") resetUsersData();
    syncControls();
  }

  function rejectToken(kind) {
    forgetToken(kind, true);
    var text = TOKEN_NAMES[kind] + " was rejected by the service and has been forgotten. Enter it again in Settings.";
    setMessage(kind + "-token-message", text, "error");
    showToast(text, "error", true);
  }

  function setReveal(kind, show) {
    var input = tokenInput(kind);
    var button = byId(kind + "-token-reveal");
    input.setAttribute("type", show ? "text" : "password");
    button.setAttribute("aria-pressed", show ? "true" : "false");
    button.textContent = show ? "Hide" : "Show";
  }

  function forgetAll() {
    forgetToken("admin", true);
    forgetToken("emergency", true);
    sessionStore.remove(STORAGE_KEYS.actingAs);
    byId("acting-input").value = "";
    each(["admin-token-message", "emergency-token-message", "acting-message"], function (id) { setMessage(id, ""); });
    setMessage("forget-all-message", "Both tokens and the acting-as label were removed from this tab.", "success");
    syncControls();
  }

  // ---------------------------------------------------------------------
  // Shared control state: token presence, in-flight actions and typed
  // confirmations all feed the disabled state of each control.
  // ---------------------------------------------------------------------
  var busy = Object.create(null);
  var state = {
    section: "overview",
    users: null,
    usersLoading: false,
    detail: null,
    detailId: null,
    keys: null
  };

  function syncControls() {
    var admin = hasToken("admin");
    var emergency = hasToken("emergency");
    each([["admin", admin], ["emergency", emergency]], function (pair) {
      var kind = pair[0];
      var present = pair[1];
      var label = TOKEN_NAMES[kind] + ": " + (present ? "set" : "not set");
      var chip = byId("chip-" + kind);
      chip.textContent = label;
      chip.classList.toggle("chip-on", present);
      byId("overview-" + kind + "-token").textContent = label;
      byId(kind + "-token-status").textContent = present
        ? (sessionStore.persistent() ? "Saved for this tab" : "Held in memory for this page")
        : "Not set";
      byId(kind + "-token-status").classList.toggle("is-set", present);
    });

    byId("users-token-prompt").hidden = admin;
    byId("users-refresh").disabled = !admin || state.usersLoading;
    byId("users-filter").disabled = !admin;
    var detail = state.detail;
    var detailReady = admin && detail !== null;
    byId("email-submit").disabled = !detailReady || busy.email === true;
    byId("status-toggle").disabled = !detailReady || busy.status === true;
    byId("reset-submit").disabled = !detailReady || busy.reset === true;
    byId("delete-open").disabled = !detailReady;
    if (busy.status !== true) {
      byId("status-toggle").textContent = detail !== null && detail.isActive === false ? "Enable user" : "Disable user";
    }
    byId("delete-submit").disabled = !detailReady || busy.delete === true ||
      byId("delete-confirm").value !== detail.username;
    byId("create-submit").disabled = busy.create === true;

    byId("rotate-token-prompt").hidden = emergency;
    byId("rotate-open").disabled = !emergency;
    byId("rotate-submit").disabled = !emergency || busy.rotate === true ||
      byId("rotate-confirm").value !== ROTATE_WORD;
  }

  // Runs one request-backed action at a time per key. The control is disabled
  // and relabelled while the request is in flight, so it cannot be submitted
  // twice. Nothing is retried automatically.
  async function runAction(key, button, pendingLabel, work) {
    if (busy[key] === true) return;
    busy[key] = true;
    var label = button.textContent;
    button.textContent = pendingLabel;
    button.setAttribute("aria-busy", "true");
    syncControls();
    try {
      await work();
    } finally {
      busy[key] = false;
      button.removeAttribute("aria-busy");
      button.textContent = label;
      syncControls();
    }
  }

  // ---------------------------------------------------------------------
  // Navigation between the four areas.
  // ---------------------------------------------------------------------
  function showSection(name, moveFocus) {
    if (SECTIONS.indexOf(name) === -1) return;
    closeDialog();
    state.section = name;
    each(SECTIONS, function (section) { byId("section-" + section).hidden = section !== name; });
    each(doc.querySelectorAll(".tab"), function (tab) {
      if (tab.getAttribute("data-section") === name) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    if (moveFocus) byId(name + "-heading").focus();
    if (name === "users" && hasToken("admin") && state.users === null && !state.usersLoading) loadUsers();
    if (name === "keys" && state.keys === null) loadKeys();
  }

  // ---------------------------------------------------------------------
  // Dialogs: modal, focus trapped, closed with Escape, focus restored.
  // ---------------------------------------------------------------------
  var openDialogState = null;

  function focusableIn(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll("a[href], button, input, select, textarea"),
      function (element) { return !element.disabled && !element.hidden && element.getAttribute("tabindex") !== "-1"; });
  }

  function openDialog(dialog, initialFocus, opener) {
    closeDialog();
    openDialogState = { dialog: dialog, opener: opener || doc.activeElement };
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    initialFocus.focus();
  }

  // Focus returns to the control that opened the dialog. If that control is
  // now hidden (for example after a delete), focus goes to the heading of the
  // current area instead.
  function closeDialog(focusTarget) {
    var current = openDialogState;
    if (current === null) return;
    openDialogState = null;
    if (typeof current.dialog.close === "function") {
      if (current.dialog.open) current.dialog.close();
    } else {
      current.dialog.removeAttribute("open");
    }
    var target = focusTarget || current.opener;
    if (!target || typeof target.focus !== "function" || target.disabled || target.closest("[hidden]") !== null) {
      target = byId(state.section + "-heading");
    }
    target.focus();
  }

  function onDialogKeydown(event) {
    if (openDialogState === null) return;
    if (event.key === "Escape" || event.key === "Esc") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    var focusable = focusableIn(openDialogState.dialog);
    if (focusable.length === 0) { event.preventDefault(); return; }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    var active = doc.activeElement;
    var inside = focusable.indexOf(active) !== -1;
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------------
  // Overview (CONTRACT-010 §3).
  // ---------------------------------------------------------------------
  function setStatus(id, text, kind) {
    var element = byId(id);
    element.textContent = text;
    element.classList.remove("status-ok", "status-bad", "status-pending", "status-unknown");
    element.classList.add("status-" + kind);
  }

  function detectMode(documentValue) {
    if (documentValue === null || typeof documentValue !== "object") return "unknown";
    var paths = documentValue.paths;
    if (paths === null || typeof paths !== "object") return "unknown";
    return hasOwn(paths, "/auth/local-login") ? "local" : "entra";
  }

  async function loadOverview() {
    setStatus("health-status", "Checking...", "pending");
    setStatus("mode-status", "Checking...", "pending");
    byId("health-detail").textContent = "";
    byId("mode-detail").textContent = "";
    var results = await Promise.all([api("GET", "/health"), api("GET", "/api/openapi.json")]);
    var health = results[0];
    if (health.ok && health.data.status === "ok") {
      setStatus("health-status", "Healthy", "ok");
      byId("health-detail").textContent = "Checked " + new Date().toLocaleTimeString() + ".";
    } else {
      setStatus("health-status", "Unreachable", "bad");
      byId("health-detail").textContent = health.error || "The health check did not report ok.";
    }
    var mode = results[1].ok ? detectMode(results[1].data) : "unknown";
    if (mode === "local") {
      setStatus("mode-status", "Local username and password", "ok");
      byId("mode-detail").textContent = "LOCAL_LOGIN=true. Microsoft Entra routes are off.";
    } else if (mode === "entra") {
      setStatus("mode-status", "Microsoft Entra", "ok");
      byId("mode-detail").textContent = "LOCAL_LOGIN=false. Local sign-in routes are off.";
    } else {
      setStatus("mode-status", "Unknown", "unknown");
      byId("mode-detail").textContent = "The API description could not be loaded, so mode-specific links are hidden.";
    }
    each(doc.querySelectorAll("[data-mode]"), function (item) {
      item.hidden = item.getAttribute("data-mode") !== mode;
    });
  }

  // ---------------------------------------------------------------------
  // Users (CONTRACT-010 §4).
  // ---------------------------------------------------------------------
  var manageButtons = Object.create(null);

  function resetUsersData() {
    state.users = null;
    state.detail = null;
    state.detailId = null;
    clear(byId("users-tbody"));
    byId("users-table-wrap").hidden = true;
    byId("users-count").textContent = "";
    setListState("users-state", "Add the user-admin token to load users.");
    showListView(false);
  }

  function isUser(value) {
    return value !== null && typeof value === "object" && typeof value.id === "string";
  }

  async function loadUsers() {
    if (!hasToken("admin")) { resetUsersData(); return; }
    state.usersLoading = true;
    syncControls();
    setListState("users-state", "Loading users...", "loading");
    var result = await api("GET", "/admin/users");
    state.usersLoading = false;
    if (result.ok && Array.isArray(result.data.users)) {
      state.users = result.data.users.filter(isUser);
      renderUsers();
    } else if (result.ok) {
      setListState("users-state", "The service returned an unexpected user list.", "error");
    } else {
      if (!result.unauthorized) state.users = null;
      byId("users-table-wrap").hidden = true;
      setListState("users-state", result.error, "error");
      announce(result.error);
    }
    syncControls();
  }

  function filteredUsers() {
    var query = byId("users-filter").value.trim().toLowerCase();
    if (query === "") return state.users;
    return state.users.filter(function (user) {
      return String(user.username).toLowerCase().indexOf(query) !== -1 ||
        String(user.email).toLowerCase().indexOf(query) !== -1;
    });
  }

  function cell(label, content, className) {
    var td = el("td", className);
    td.setAttribute("role", "cell");
    td.setAttribute("data-label", label);
    if (typeof content === "string") td.textContent = content;
    else td.appendChild(content);
    return td;
  }

  function statusBadge(user) {
    return el("span", user.isActive === false ? "badge badge-off" : "badge badge-on",
      user.isActive === false ? "Disabled" : "Active");
  }

  function renderUsers() {
    var tbody = byId("users-tbody");
    clear(tbody);
    manageButtons = Object.create(null);
    if (state.users === null) return;
    var users = filteredUsers();
    users.forEach(function (user) {
      var row = el("tr");
      row.setAttribute("role", "row");
      var name = el("span", "strong", String(user.username));
      row.appendChild(cell("Username", name));
      row.appendChild(cell("Email", String(user.email), "wrap"));
      row.appendChild(cell("Status", statusBadge(user)));
      row.appendChild(cell("Created", formatTime(user.createdAt)));
      row.appendChild(cell("Updated", formatTime(user.updatedAt)));
      var manage = el("button", "btn btn-small", "Manage");
      manage.setAttribute("type", "button");
      manage.setAttribute("aria-label", "Manage " + String(user.username));
      manage.addEventListener("click", function () { openDetail(user.id); });
      manageButtons[user.id] = manage;
      row.appendChild(cell("Actions", manage, "cell-actions"));
      tbody.appendChild(row);
    });
    var total = state.users.length;
    byId("users-table-wrap").hidden = users.length === 0;
    if (total === 0) setListState("users-state", "No local users yet.");
    else if (users.length === 0) setListState("users-state", "No users match “" + byId("users-filter").value.trim() + "”.");
    else setListState("users-state", "");
    byId("users-count").textContent = total === 0 ? "" :
      "Showing " + users.length + " of " + total + (total === 1 ? " user." : " users.");
  }

  function upsertUser(user) {
    if (!isUser(user) || state.users === null) return;
    var replaced = false;
    state.users = state.users.map(function (existing) {
      if (existing.id !== user.id) return existing;
      replaced = true;
      return user;
    });
    if (!replaced) state.users.push(user);
    renderUsers();
  }

  function removeUser(id) {
    if (state.users === null) return;
    state.users = state.users.filter(function (user) { return user.id !== id; });
    renderUsers();
  }

  function showListView(moveFocus) {
    byId("user-detail-view").hidden = true;
    byId("users-list-view").hidden = false;
    var returnTo = state.detailId !== null ? manageButtons[state.detailId] : undefined;
    state.detail = null;
    state.detailId = null;
    syncControls();
    if (moveFocus) (returnTo || byId("users-heading")).focus();
  }

  async function openDetail(id) {
    state.detailId = id;
    state.detail = null;
    byId("users-list-view").hidden = true;
    byId("user-detail-view").hidden = false;
    byId("detail-body").hidden = true;
    each(["email-message", "status-message", "reset-message"], function (messageId) { setMessage(messageId, ""); });
    setListState("detail-state", "Loading user...", "loading");
    syncControls();
    byId("detail-heading").focus();
    var result = await api("GET", userPath(id));
    if (state.detailId !== id) return;
    if (result.ok && isUser(result.data)) {
      showDetail(result.data);
    } else {
      setListState("detail-state", result.ok ? "The service returned an unexpected user." : result.error, "error");
      announce(result.ok ? "The service returned an unexpected user." : result.error);
    }
  }

  function showDetail(user) {
    state.detail = user;
    state.detailId = user.id;
    byId("detail-heading").textContent = String(user.username);
    byId("detail-username").textContent = String(user.username);
    byId("detail-email").textContent = String(user.email);
    var status = byId("detail-status");
    clear(status);
    status.appendChild(statusBadge(user));
    byId("detail-created").textContent = formatTime(user.createdAt);
    byId("detail-updated").textContent = formatTime(user.updatedAt);
    byId("detail-id").textContent = user.id;
    byId("email-input").value = String(user.email);
    setListState("detail-state", "");
    byId("detail-body").hidden = false;
    syncControls();
  }

  function patchBody(fields) {
    var label = actingAs();
    if (label) fields.actedBy = label;
    return fields;
  }

  function applyUserUpdate(result, messageId, successText) {
    if (result.ok && isUser(result.data)) {
      upsertUser(result.data);
      if (state.detailId === result.data.id) showDetail(result.data);
      setMessage(messageId, successText, "success");
      showToast(successText, "success");
    } else if (result.ok) {
      setMessage(messageId, "The service returned an unexpected response.", "error");
    } else {
      setMessage(messageId, result.error, "error");
    }
  }

  function submitEmail(event) {
    event.preventDefault();
    var user = state.detail;
    if (user === null) return;
    var email = byId("email-input").value.trim();
    if (email === "") { setMessage("email-message", "Enter an email address.", "error"); return; }
    runAction("email", byId("email-submit"), "Saving...", async function () {
      var result = await api("PATCH", userPath(user.id), patchBody({ email: email }));
      applyUserUpdate(result, "email-message", "Email updated for " + String(user.username) + ".");
    });
  }

  function toggleStatus() {
    var user = state.detail;
    if (user === null) return;
    var enable = user.isActive === false;
    runAction("status", byId("status-toggle"), enable ? "Enabling..." : "Disabling...", async function () {
      var result = await api("PATCH", userPath(user.id), patchBody({ isActive: enable }));
      applyUserUpdate(result, "status-message", enable
        ? String(user.username) + " is enabled."
        : String(user.username) + " is disabled. Existing sessions stay valid until they expire.");
    });
  }

  function clearResetPasswords() {
    byId("reset-password").value = "";
    byId("reset-confirm").value = "";
  }

  function submitReset(event) {
    event.preventDefault();
    var user = state.detail;
    if (user === null) return;
    var password = byId("reset-password").value;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setMessage("reset-message", "The new password must be at least " + MIN_PASSWORD_LENGTH + " characters.", "error");
      return;
    }
    if (password !== byId("reset-confirm").value) {
      setMessage("reset-message", "The passwords do not match.", "error");
      return;
    }
    runAction("reset", byId("reset-submit"), "Resetting...", async function () {
      try {
        var result = await api("PATCH", userPath(user.id), patchBody({ password: password }));
        applyUserUpdate(result, "reset-message", "Password reset for " + String(user.username) +
          ". The account is unlocked; its enabled status and existing sessions are unchanged.");
      } finally {
        password = "";
        clearResetPasswords();
      }
    });
  }

  function openDelete() {
    var user = state.detail;
    if (user === null) return;
    byId("delete-target").textContent = String(user.username);
    byId("delete-confirm").value = "";
    setMessage("delete-message", "");
    syncControls();
    openDialog(byId("delete-dialog"), byId("delete-confirm"), byId("delete-open"));
  }

  function submitDelete(event) {
    event.preventDefault();
    var user = state.detail;
    if (user === null || byId("delete-confirm").value !== user.username || !hasToken("admin")) return;
    runAction("delete", byId("delete-submit"), "Deleting...", async function () {
      var result = await api("DELETE", userPath(user.id));
      if (result.ok) {
        var text = "Deleted " + String(user.username) + ". Audit history is kept.";
        byId("delete-confirm").value = "";
        removeUser(user.id);
        showListView(false);
        closeDialog(byId("users-heading"));
        showToast(text, "success");
      } else {
        setMessage("delete-message", result.error, "error");
      }
    });
  }

  function openCreate() {
    setMessage("create-message", "");
    openDialog(byId("create-dialog"), byId("create-username"), byId("users-new"));
  }

  function clearCreatePasswords() {
    byId("create-password").value = "";
    byId("create-confirm").value = "";
  }

  function submitCreate(event) {
    event.preventDefault();
    if (busy.create === true) return;
    var rawUsername = byId("create-username").value;
    var email = byId("create-email").value.trim();
    var password = byId("create-password").value;
    if (!USERNAME_PATTERN.test(rawUsername.trim().toLowerCase())) {
      setMessage("create-message", "The username must be 3 to 64 characters using a-z, 0-9, dot, hyphen or underscore.", "error");
      return;
    }
    if (email === "") { setMessage("create-message", "Enter an email address.", "error"); return; }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setMessage("create-message", "The password must be at least " + MIN_PASSWORD_LENGTH + " characters.", "error");
      return;
    }
    if (password !== byId("create-confirm").value) {
      setMessage("create-message", "The passwords do not match.", "error");
      return;
    }
    runAction("create", byId("create-submit"), "Creating...", async function () {
      try {
        var body = { username: rawUsername, email: email, password: password };
        var label = actingAs();
        if (label) body.actedBy = label;
        var result = await api("POST", "/admin/users", body);
        if (result.ok && isUser(result.data)) {
          var text = "Created user " + String(result.data.username) + ".";
          byId("create-username").value = "";
          byId("create-email").value = "";
          upsertUser(result.data);
          setMessage("create-message", "");
          closeDialog();
          showToast(text, "success");
        } else if (result.status === 403) {
          setMessage("create-message", "Creating users needs ALLOW_NEW_LOCAL_LOGIN_CREATION=true in the service configuration, followed by a restart. The service said: " + result.error, "error");
        } else {
          setMessage("create-message", result.ok ? "The service returned an unexpected response." : result.error, "error");
        }
      } finally {
        password = "";
        clearCreatePasswords();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Signing keys (CONTRACT-010 §5).
  // ---------------------------------------------------------------------
  function metaRow(term, value, mono) {
    var wrapper = el("div");
    wrapper.appendChild(el("dt", null, term));
    wrapper.appendChild(el("dd", mono ? "mono" : null, value));
    return wrapper;
  }

  function renderKeys() {
    var list = byId("keys-list");
    clear(list);
    if (state.keys === null) return;
    if (state.keys.length === 0) { setListState("keys-state", "No keys are published."); return; }
    setListState("keys-state", "");
    state.keys.forEach(function (key, index) {
      var item = el("li", "key-card");
      var meta = el("dl", "meta meta-compact");
      meta.appendChild(metaRow("Key ID (kid)", String(key.kid), true));
      meta.appendChild(metaRow("Algorithm", String(key.alg)));
      meta.appendChild(metaRow("Use", String(key.use)));
      item.appendChild(meta);
      var modulusId = "key-modulus-" + index;
      var modulus = el("pre", "mono modulus", String(key.n));
      modulus.setAttribute("id", modulusId);
      modulus.hidden = true;
      var actions = el("div", "actions");
      var toggle = el("button", "btn btn-small", "Show modulus");
      toggle.setAttribute("type", "button");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", modulusId);
      toggle.addEventListener("click", function () {
        var show = modulus.hidden;
        modulus.hidden = !show;
        toggle.setAttribute("aria-expanded", show ? "true" : "false");
        toggle.textContent = show ? "Hide modulus" : "Show modulus";
      });
      var copy = el("button", "btn btn-small", "Copy modulus");
      copy.setAttribute("type", "button");
      copy.addEventListener("click", function () { copyText(String(key.n), String(key.kid)); });
      actions.appendChild(toggle);
      actions.appendChild(copy);
      item.appendChild(actions);
      item.appendChild(modulus);
      list.appendChild(item);
    });
  }

  async function copyText(text, kid) {
    var clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      showToast("Copying is not available here. Show the modulus and select it to copy.", "info");
      return;
    }
    try {
      await clipboard.writeText(text);
      showToast("Modulus for key " + kid + " copied.", "success");
    } catch (error) {
      showToast("Copying was blocked by the browser. Show the modulus and select it to copy.", "error");
    }
  }

  async function loadKeys() {
    busy.keys = true;
    byId("keys-refresh").disabled = true;
    setListState("keys-state", "Loading keys...", "loading");
    clear(byId("keys-list"));
    var result = await api("GET", "/.well-known/jwks.json");
    busy.keys = false;
    byId("keys-refresh").disabled = false;
    if (result.ok && Array.isArray(result.data.keys)) {
      state.keys = result.data.keys.filter(function (key) { return key !== null && typeof key === "object"; });
      renderKeys();
    } else {
      state.keys = null;
      var text = result.ok ? "The service returned an unexpected key list." : result.error;
      setListState("keys-state", text, "error");
      announce(text);
    }
  }

  function openRotate() {
    byId("rotate-confirm").value = "";
    setMessage("rotate-message", "");
    syncControls();
    openDialog(byId("rotate-dialog"), byId("rotate-confirm"), byId("rotate-open"));
  }

  function submitRotate(event) {
    event.preventDefault();
    if (byId("rotate-confirm").value !== ROTATE_WORD || !hasToken("emergency")) return;
    runAction("rotate", byId("rotate-submit"), "Rotating...", async function () {
      var label = actingAs();
      var result = await api("POST", "/admin/emergency-rotate-keys", label ? { triggeredBy: label } : undefined);
      if (result.ok) {
        byId("rotate-confirm").value = "";
        byId("rotate-previous").textContent = String(result.data.previousKid);
        byId("rotate-new").textContent = String(result.data.newKid);
        byId("rotate-at").textContent = formatTime(result.data.rotatedAt);
        byId("rotate-result").hidden = false;
        closeDialog();
        showToast("Signing key rotated. New key " + String(result.data.newKid) + ".", "success");
        loadKeys();
      } else {
        setMessage("rotate-message", result.error, "error");
      }
    });
  }

  // ---------------------------------------------------------------------
  // Wiring.
  // ---------------------------------------------------------------------
  function on(id, type, handler) { byId(id).addEventListener(type, handler); }

  function init() {
    var theme = window.BTConsoleTheme;
    var themeSelect = byId("theme-select");
    themeSelect.value = theme ? theme.get() : "system";
    themeSelect.addEventListener("change", function () {
      if (theme) themeSelect.value = theme.set(themeSelect.value);
    });

    each(doc.querySelectorAll(".tab"), function (tab) {
      tab.addEventListener("click", function () { showSection(tab.getAttribute("data-section"), true); });
    });
    each(doc.querySelectorAll("[data-goto]"), function (button) {
      button.addEventListener("click", function () { showSection(button.getAttribute("data-goto"), true); });
    });
    each(doc.querySelectorAll("dialog"), function (dialog) {
      dialog.addEventListener("keydown", onDialogKeydown);
      dialog.addEventListener("cancel", function (event) { event.preventDefault(); closeDialog(); });
      dialog.addEventListener("click", function (event) { if (event.target === dialog) closeDialog(); });
    });
    each(doc.querySelectorAll("[data-close]"), function (button) {
      button.addEventListener("click", function () { closeDialog(); });
    });
    on("toast-dismiss", "click", hideToast);

    on("overview-refresh", "click", function () { loadOverview(); });

    on("users-refresh", "click", function () { loadUsers(); });
    on("users-filter", "input", function () { if (state.users !== null) renderUsers(); });
    on("users-new", "click", openCreate);
    on("detail-back", "click", function () { showListView(true); });
    on("email-form", "submit", submitEmail);
    on("status-toggle", "click", toggleStatus);
    on("reset-form", "submit", submitReset);
    on("delete-open", "click", openDelete);
    on("delete-confirm", "input", syncControls);
    on("delete-form", "submit", submitDelete);
    on("create-form", "submit", submitCreate);

    on("keys-refresh", "click", function () { loadKeys(); });
    on("rotate-open", "click", openRotate);
    on("rotate-confirm", "input", syncControls);
    on("rotate-form", "submit", submitRotate);

    each(["admin", "emergency"], function (kind) {
      tokenInput(kind).value = getToken(kind);
      on(kind + "-token-form", "submit", function (event) { event.preventDefault(); saveToken(kind); });
      on(kind + "-token-forget", "click", function () { forgetToken(kind); });
      on(kind + "-token-reveal", "click", function () {
        setReveal(kind, tokenInput(kind).getAttribute("type") === "password");
      });
    });
    byId("acting-input").value = sessionStore.get(STORAGE_KEYS.actingAs) || "";
    on("acting-form", "submit", function (event) {
      event.preventDefault();
      var label = byId("acting-input").value.trim();
      if (label === "") {
        sessionStore.remove(STORAGE_KEYS.actingAs);
        setMessage("acting-message", "Acting-as label cleared.", "info");
      } else {
        sessionStore.set(STORAGE_KEYS.actingAs, label);
        byId("acting-input").value = label;
        setMessage("acting-message", "Acting-as label saved. It is not verified.", "success");
      }
    });
    on("acting-clear", "click", function () {
      sessionStore.remove(STORAGE_KEYS.actingAs);
      byId("acting-input").value = "";
      setMessage("acting-message", "Acting-as label cleared.", "info");
    });
    on("forget-all", "click", forgetAll);

    byId("storage-notice").hidden = sessionStore.persistent();
    syncControls();
    showSection("overview", false);
    loadOverview();
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})();
