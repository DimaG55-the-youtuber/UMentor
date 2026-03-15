/**
 * dashboard.js — Dashboard page logic
 *
 * Responsibilities:
 *  • Connect to the Flask-SocketIO server
 *  • Listen for real-time user status changes and update the DOM
 *  • Handle "Start Call" button clicks → send call_request via socket
 *  • Show incoming-call overlay when another user calls this user
 *  • Handle accept / decline actions and redirect to /call/<id>
 *  • Filter / search the user list
 *  • Fetch and render call history
 */

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Read metadata injected by the Jinja2 template
  // -----------------------------------------------------------------------
  const meta          = document.getElementById("currentUserMeta");
  const CURRENT_ID    = parseInt(meta.dataset.userId, 10);
  const CURRENT_NAME  = meta.dataset.username;

  // -----------------------------------------------------------------------
  // DOM references
  // -----------------------------------------------------------------------
  const userGrid      = document.getElementById("userGrid");
  const onlineCount   = document.getElementById("onlineCount");
  const userSearch    = document.getElementById("userSearch");
  const incomingOverlay  = document.getElementById("incomingCallOverlay");
  const incomingCallerEl = document.getElementById("incomingCallerName");
  const acceptBtn        = document.getElementById("acceptCallBtn");
  const declineBtn       = document.getElementById("declineCallBtn");
  const outgoingOverlay  = document.getElementById("outgoingCallOverlay");
  const outgoingCalleeEl = document.getElementById("outgoingCalleeName");
  const cancelCallBtn    = document.getElementById("cancelCallBtn");
  const historyList      = document.getElementById("callHistoryList");

  // -----------------------------------------------------------------------
  // Pending call state
  // -----------------------------------------------------------------------
  let pendingCall    = null;   // incoming: { caller_id, caller_name, room_id }
  let pendingOutgoing = null;  // outgoing: { target_id, target_name, room_id }

  // -----------------------------------------------------------------------
  // Socket.IO connection
  // -----------------------------------------------------------------------
  const socket = io({
    // Pass CSRF token as a query parameter for the initial handshake
    auth: { csrf_token: document.querySelector('meta[name="csrf-token"]').content },
    reconnection:       true,
    reconnectionDelay:  1000,
    reconnectionAttempts: 10,
  });

  socket.on("connect", () => {
    console.log("[Dashboard] Socket connected:", socket.id);
  });

  socket.on("disconnect", (reason) => {
    console.warn("[Dashboard] Socket disconnected:", reason);
  });

  socket.on("connect_error", (err) => {
    console.error("[Dashboard] Connection error:", err.message);
  });

  function applyUserStatus(user_id, username, is_online) {
    // Never update the current user's own card (they are not shown)
    if (user_id === CURRENT_ID) return;

    const card = userGrid.querySelector(`[data-user-id="${user_id}"]`);
    if (!card) return;

    const dot        = card.querySelector(".status-dot");
    const statusText = card.querySelector(".status-text");
    const actionDiv  = card.querySelector(".user-card__action");

    card.dataset.online = is_online ? "true" : "false";
    card.classList.toggle("user-card--online",  is_online);
    card.classList.toggle("user-card--offline", !is_online);

    dot.className = `status-dot status-dot--${is_online ? "online" : "offline"}`;
    dot.setAttribute("aria-label", is_online ? "online" : "offline");

    statusText.textContent = is_online ? "Online" : "Offline";

    if (is_online) {
      actionDiv.innerHTML = `
        <button
          class="btn btn--primary btn--sm call-btn"
          data-target-id="${user_id}"
          data-target-name="${username}"
          aria-label="Start call with ${username}"
        >&#9654; Call</button>`;
      actionDiv.querySelector(".call-btn").addEventListener("click", onCallClick);
    } else {
      actionDiv.innerHTML = `<button class="btn btn--ghost btn--sm" disabled aria-disabled="true">Offline</button>`;
    }

    const avatar = card.querySelector(".user-card__avatar");
    if (is_online) {
      avatar.style.background = "";
      avatar.style.color      = "";
    } else {
      avatar.style.background = "var(--color-surface-2)";
      avatar.style.color      = "var(--color-text-muted)";
    }

    refreshOnlineCount();
  }

  socket.on("initial_user_statuses", ({ users }) => {
    (users || []).forEach(user => applyUserStatus(user.user_id, user.username, user.is_online));
  });

  // -----------------------------------------------------------------------
  // Real-time user status changes
  // -----------------------------------------------------------------------
  socket.on("user_status_changed", ({ user_id, username, is_online }) => {
    applyUserStatus(user_id, username, is_online);
  });

  // -----------------------------------------------------------------------
  // Incoming call
  // -----------------------------------------------------------------------
  socket.on("incoming_call", ({ caller_id, caller_name, room_id }) => {
    pendingCall = { caller_id, caller_name, room_id };
    incomingCallerEl.textContent = caller_name;
    incomingOverlay.classList.remove("hidden");

    // Auto-decline after 30 seconds if no action
    pendingCall._timeout = setTimeout(() => {
      if (pendingCall) {
        socket.emit("call_declined", { caller_id, room_id });
        hideOverlay();
      }
    }, 30_000);
  });

  acceptBtn.addEventListener("click", () => {
    if (!pendingCall) return;
    clearTimeout(pendingCall._timeout);
    const { caller_id, room_id } = pendingCall;

    socket.emit("call_accepted", { caller_id, room_id });
    hideIncomingOverlay();

    // Tell server we are about to disconnect due to navigation.
    // Delay the actual navigation by 200 ms so the socket message is
    // guaranteed to reach the server before the page unloads.
    socket.emit("call_navigating");
    sessionStorage.setItem(`call_role_${caller_id}`, "callee");
    setTimeout(() => { window.location.href = `/call/${caller_id}`; }, 600);
  });

  declineBtn.addEventListener("click", () => {
    if (!pendingCall) return;
    clearTimeout(pendingCall._timeout);
    const { caller_id, room_id } = pendingCall;
    socket.emit("call_declined", { caller_id, room_id });
    hideIncomingOverlay();
  });

  // Cancel our own outgoing call
  cancelCallBtn.addEventListener("click", () => {
    if (!pendingOutgoing) return;
    const { target_id, room_id } = pendingOutgoing;
    socket.emit("end_call", { target_user_id: target_id, room_id });
    hideOutgoingOverlay();
  });

  // Callee accepted our call → navigate to the call page
  socket.on("call_accepted", ({ accepter_id, room_id }) => {
    if (!pendingOutgoing) return;
    hideOutgoingOverlay();
    socket.emit("call_navigating");  // grace period: don't kill call on disconnect
    sessionStorage.setItem(`call_role_${accepter_id}`, "caller");
    setTimeout(() => { window.location.href = `/call/${accepter_id}`; }, 600);
  });

  // Callee declined our call
  socket.on("call_declined", ({ decliner_name }) => {
    hideOutgoingOverlay();
    showToast(`${decliner_name} declined your call.`, "warning");
    // Re-enable call buttons
    resetCallButtons();
  });

  function hideIncomingOverlay() {
    incomingOverlay.classList.add("hidden");
    pendingCall = null;
  }

  function hideOutgoingOverlay() {
    outgoingOverlay.classList.add("hidden");
    pendingOutgoing = null;
    resetCallButtons();
  }

  function resetCallButtons() {
    document.querySelectorAll(".call-btn").forEach(b => {
      b.disabled    = false;
      b.textContent = "\u25BA Call";
    });
  }

  // -----------------------------------------------------------------------
  // Call button clicks (attach to existing buttons + dynamically created ones)
  // -----------------------------------------------------------------------
  userGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".call-btn");
    if (btn) onCallClick({ currentTarget: btn });
  });

  function onCallClick(e) {
    const btn        = e.currentTarget || e.target.closest(".call-btn");
    const targetId   = parseInt(btn.dataset.targetId, 10);
    const targetName = btn.dataset.targetName;

    if (!targetId) return;
    if (pendingOutgoing) return;  // already in a call attempt

    // Disable all call buttons while calling
    btn.disabled    = true;
    btn.textContent = "Calling\u2026";

    const roomId = `call_${Math.min(CURRENT_ID, targetId)}_${Math.max(CURRENT_ID, targetId)}`;
    pendingOutgoing = { target_id: targetId, target_name: targetName, room_id: roomId };

    socket.emit("call_request", { target_user_id: targetId });

    // Show outgoing overlay
    outgoingCalleeEl.textContent = targetName;
    outgoingOverlay.classList.remove("hidden");

    // Auto-cancel if no answer within 30 s
    pendingOutgoing._timeout = setTimeout(() => {
      if (pendingOutgoing) {
        socket.emit("end_call", { target_user_id: targetId, room_id: pendingOutgoing.room_id });
        hideOutgoingOverlay();
        showToast("No answer.", "warning");
      }
    }, 30_000);
  }

  // -----------------------------------------------------------------------
  // Call errors
  // -----------------------------------------------------------------------
  socket.on("call_error", ({ message }) => {
    showToast(message, "error");
    hideOutgoingOverlay();
    resetCallButtons();
  });

  // -----------------------------------------------------------------------
  // Search / filter
  // -----------------------------------------------------------------------
  if (userSearch) {
    userSearch.addEventListener("input", () => {
      const query   = userSearch.value.trim().toLowerCase();
      const cards   = userGrid.querySelectorAll(".user-card");
      let   visible = 0;

      cards.forEach(card => {
        const name    = (card.dataset.username || "").toLowerCase();
        const matches = !query || name.includes(query);
        card.style.display = matches ? "" : "none";
        if (matches) visible++;
      });

      // Show empty-state placeholder
      let emptyEl = document.getElementById("searchEmpty");
      if (visible === 0 && query) {
        if (!emptyEl) {
          emptyEl = document.createElement("p");
          emptyEl.id        = "searchEmpty";
          emptyEl.className = "empty-state";
          emptyEl.textContent = `No users found matching "${query}".`;
          userGrid.appendChild(emptyEl);
        }
      } else if (emptyEl) {
        emptyEl.remove();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Online count helper
  // -----------------------------------------------------------------------
  function refreshOnlineCount() {
    const count = userGrid.querySelectorAll('[data-online="true"]').length;
    onlineCount.textContent = count;
  }

  // -----------------------------------------------------------------------
  // Call history
  // -----------------------------------------------------------------------
  async function loadCallHistory() {
    try {
      const res  = await fetch("/api/call-history");
      if (!res.ok) return;
      const logs = await res.json();

      if (!logs.length) {
        historyList.innerHTML = '<p class="call-history__empty">No call history yet.</p>';
        return;
      }

      historyList.innerHTML = logs.map(log => {
        const isOutgoing  = log.caller_id === CURRENT_ID;
        const otherName   = isOutgoing ? `To ${log.callee_id}` : `From ${log.caller_id}`;
        const direction   = isOutgoing ? "&#9654; Outgoing" : "&#9664; Incoming";
        const duration    = log.duration_s != null ? formatDuration(log.duration_s) : "";
        const date        = new Date(log.started_at).toLocaleString();

        return `
          <div class="call-history__item">
            <span class="call-history__badge call-history__badge--${log.status}">${log.status}</span>
            <span>${direction}</span>
            <span class="call-history__meta">${date}</span>
            ${duration ? `<span class="call-history__meta">${duration}</span>` : ""}
          </div>`;
      }).join("");
    } catch (err) {
      historyList.innerHTML = '<p class="call-history__empty">Could not load call history.</p>';
    }
  }

  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  loadCallHistory();

  // -----------------------------------------------------------------------
  // Toast notification helper (for non-blocking messages)
  // -----------------------------------------------------------------------
  function showToast(message, type = "info") {
    const container = document.querySelector(".flash-container") || (() => {
      const c       = document.createElement("div");
      c.className   = "flash-container";
      document.body.appendChild(c);
      return c;
    })();

    const toast     = document.createElement("div");
    toast.className = `flash flash--${type}`;
    toast.setAttribute("role", "alert");
    toast.innerHTML = `<span>${message}</span>
      <button class="flash__close" onclick="this.parentElement.remove()" aria-label="Dismiss">&#10005;</button>`;
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 5000);
  }
})();
