/**
 * call.js — Video call page logic
 *
 * Responsibilities:
 *  • Connect to Flask-SocketIO
 *  • Determine role: caller (navigated here via Start Call) vs callee (accepted)
 *  • Acquire local camera + microphone via getUserMedia
 *  • Perform WebRTC signalling (offer → answer → ICE candidates) via SocketIO
 *  • Render local and remote video streams
 *  • Provide mute, camera toggle, and end-call controls
 *  • Implement a live call timer
 *  • Optional in-call text chat over DataChannel
 */

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Metadata from template
  // -----------------------------------------------------------------------
  const callMeta       = document.getElementById("callMeta");
  const OTHER_USER_ID  = parseInt(callMeta.dataset.otherUserId, 10);
  const OTHER_USERNAME = callMeta.dataset.otherUsername;
  const MY_ID          = parseInt(callMeta.dataset.currentUserId, 10);
  const MY_NAME        = callMeta.dataset.currentUsername;

  // Determine role:
  // • "caller"  — we navigated here by clicking Start Call
  // • "callee"  — we navigated here after accepting via the overlay
  // The server's call_accepted event tells the CALLER to join; the callee
  // is already here because they accepted.  We store a flag in sessionStorage.
  const ROLE_KEY  = `call_role_${OTHER_USER_ID}`;
  let   isCaller  = sessionStorage.getItem(ROLE_KEY) !== "callee";
  // Clean up flag
  sessionStorage.removeItem(ROLE_KEY);

  // The room id is deterministic (same formula as server)
  const roomId = `call_${Math.min(MY_ID, OTHER_USER_ID)}_${Math.max(MY_ID, OTHER_USER_ID)}`;

  // -----------------------------------------------------------------------
  // DOM references
  // -----------------------------------------------------------------------
  const localVideo           = document.getElementById("localVideo");
  const remoteVideo          = document.getElementById("remoteVideo");
  const remotePH             = document.getElementById("remotePlaceholder");
  const callStatus           = document.getElementById("callStatus");
  const callTimer            = document.getElementById("callTimer");
  const peerName             = document.getElementById("peerName");
  const muteBtn              = document.getElementById("muteBtn");
  const cameraBtn             = document.getElementById("cameraBtn");
  const hangUpBtn             = document.getElementById("hangUpBtn");
  const stopBtn               = document.getElementById("stopBtn");
  const backBtn               = document.getElementById("backBtn");
  const downloadTranscriptBtn = document.getElementById("downloadTranscriptBtn");
  const aiMessages            = document.getElementById("aiMessages");
  const aiForm                = document.getElementById("aiForm");
  const aiInput               = document.getElementById("aiInput");
  const transcriptBody        = document.getElementById("transcriptBody"); // hidden data collector

  // -----------------------------------------------------------------------
  // Ban check — if emergency-stopped, block re-entry until ban expires
  // -----------------------------------------------------------------------
  const BAN_KEY = "umentor_ban_until";
  const banUntil = parseInt(localStorage.getItem(BAN_KEY) || "0", 10);
  if (banUntil > Date.now()) {
    const secsLeft = Math.ceil((banUntil - Date.now()) / 1000);
    document.body.innerHTML =
      `<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#080f1e;color:#f97316;font-family:sans-serif;flex-direction:column;gap:1rem">
        <h1 style="font-size:3rem;">&#9940;</h1>
        <p style="font-size:1.2rem;font-weight:600;">Calls blocked for ${secsLeft}s (emergency stop active).</p>
        <a href="/" style="color:#f97316;text-decoration:underline;">Back to dashboard</a>
      </div>`;
    throw new Error("call banned");
  }

  peerName.textContent = OTHER_USERNAME;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let localStream       = null;    // MediaStream from getUserMedia
  let peerConn          = null;    // RTCPeerConnection
  let dataChannel       = null;    // RTCDataChannel (kept for extensibility)
  let isMuted           = false;
  let isCameraOff       = false;
  let callStartTime     = null;    // Date when call became active
  let timerInterval     = null;
  let callActive        = false;
  let localStreamReady  = false;   // true once getUserMedia resolves
  let startOfferSignal  = false;   // true once server sends start_offer
  let pendingCandidates = [];      // ICE candidates buffered before remote desc

  // Transcription state
  let transcriptLines      = [];     // { time, speaker, text }[]
  let selfRecognition      = null;
  let remoteRecognition    = null;
  let transcriptionStopped = false;  // true once we deliberately stop
  let selfTranscriptionPaused = false;
  let profanityTerminationTriggered = false;

  // Diagnostics
  const DEBUG_LOG_KEY      = "umentor_call_debug_log";
  const DEBUG_SESSION_ID   = `${roomId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const DEBUG_LOG_LIMIT    = 150;
  let debugLogBuffer       = [];
  let debugFlushTimer      = null;
  let diagnosticsInterval  = null;
  let lagInterval          = null;

  function shouldConsoleLog(kind) {
    return !(
      kind === "signal.ice_candidate" ||
      kind === "webrtc.pc.onicecandidate" ||
      kind === "datachannel.message" ||
      kind === "webrtc.stats" ||
      kind === "runtime.snapshot" ||
      kind === "sr.start" ||
      kind === "sr.end" ||
      kind === "sr.instance.create" ||
      kind === "sr.soundstart" ||
      kind === "sr.speechstart"
    );
  }

  function debugLog(kind, details = {}) {
    const entry = {
      ts: new Date().toISOString(),
      ms: Math.round(performance.now()),
      session: DEBUG_SESSION_ID,
      kind,
      details,
    };
    debugLogBuffer.push(entry);
    if (debugLogBuffer.length > DEBUG_LOG_LIMIT) {
      debugLogBuffer = debugLogBuffer.slice(-DEBUG_LOG_LIMIT);
    }

    if (shouldConsoleLog(kind)) {
      const method = /error|failed|exception|crash/i.test(kind) ? "error"
        : /warn|lag|disconnect|timeout/i.test(kind) ? "warn"
        : "log";
      console[method](`[CallDiag] ${kind}`, details);
    }

    if (!debugFlushTimer) {
      debugFlushTimer = setTimeout(() => {
        debugFlushTimer = null;
        try {
          localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLogBuffer));
        } catch (e) {
          console.warn("[CallDiag] Failed to persist debug log", e);
        }
      }, 250);
    }
  }

  function installRecoveredDebugDump() {
    try {
      const raw = localStorage.getItem(DEBUG_LOG_KEY);
      if (!raw) return;
      const previous = JSON.parse(raw);
      if (!Array.isArray(previous) || previous.length === 0) return;
      const tail = previous.slice(-12);
      console.groupCollapsed(`[CallDiag] Recovered previous session log (${previous.length} entries, showing last ${tail.length})`);
      tail.forEach(entry => console.log(entry));
      console.groupEnd();
    } catch (e) {
      console.warn("[CallDiag] Failed to load previous debug log", e);
    }
  }

  function snapshotMemory() {
    const perfMem = performance.memory;
    return {
      deviceMemoryGB: navigator.deviceMemory || null,
      jsHeapUsedMB: perfMem ? Math.round((perfMem.usedJSHeapSize / 1024 / 1024) * 10) / 10 : null,
      jsHeapTotalMB: perfMem ? Math.round((perfMem.totalJSHeapSize / 1024 / 1024) * 10) / 10 : null,
      jsHeapLimitMB: perfMem ? Math.round((perfMem.jsHeapSizeLimit / 1024 / 1024) * 10) / 10 : null,
    };
  }

  async function collectPeerStats() {
    if (!peerConn) return;
    try {
      const stats = await peerConn.getStats();
      let inboundVideo = null;
      let inboundAudio = null;
      let candidatePair = null;
      stats.forEach(report => {
        if (report.type === "inbound-rtp" && report.kind === "video") inboundVideo = report;
        if (report.type === "inbound-rtp" && report.kind === "audio") inboundAudio = report;
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) candidatePair = report;
      });
      debugLog("webrtc.stats", {
        connectionState: peerConn.connectionState,
        iceState: peerConn.iceConnectionState,
        signalingState: peerConn.signalingState,
        bytesReceivedVideo: inboundVideo?.bytesReceived || null,
        framesDecoded: inboundVideo?.framesDecoded || null,
        packetsLostVideo: inboundVideo?.packetsLost || null,
        bytesReceivedAudio: inboundAudio?.bytesReceived || null,
        packetsLostAudio: inboundAudio?.packetsLost || null,
        currentRtt: candidatePair?.currentRoundTripTime || null,
        availableBitrate: candidatePair?.availableIncomingBitrate || null,
      });
    } catch (e) {
      debugLog("webrtc.stats.error", { message: e.message });
    }
  }

  function monitorMediaStream(stream, label) {
    if (!stream) return;
    debugLog(`${label}.stream`, {
      id: stream.id,
      active: stream.active,
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
    });
    stream.getTracks().forEach(track => {
      debugLog(`${label}.track.init`, {
        kind: track.kind,
        id: track.id,
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        settings: typeof track.getSettings === "function" ? track.getSettings() : null,
      });
      track.addEventListener("ended", () => debugLog(`${label}.track.ended`, { kind: track.kind, id: track.id }));
      track.addEventListener("mute", () => debugLog(`${label}.track.mute`, { kind: track.kind, id: track.id }));
      track.addEventListener("unmute", () => debugLog(`${label}.track.unmute`, { kind: track.kind, id: track.id }));
    });
  }

  function installDiagnostics() {
    installRecoveredDebugDump();
    debugLog("page.init", {
      href: window.location.href,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      visibilityState: document.visibilityState,
      ...snapshotMemory(),
    });

    window.addEventListener("error", (event) => {
      debugLog("window.error", {
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error?.stack || null,
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      debugLog("window.unhandledrejection", {
        reason: event.reason?.message || String(event.reason),
        stack: event.reason?.stack || null,
      });
    });

    window.addEventListener("offline", () => debugLog("network.offline"));
    window.addEventListener("online", () => debugLog("network.online"));
    window.addEventListener("beforeunload", () => debugLog("page.beforeunload"));
    window.addEventListener("pagehide", () => debugLog("page.pagehide", { persisted: false }));
    document.addEventListener("visibilitychange", () => debugLog("page.visibility", { state: document.visibilityState }));

    diagnosticsInterval = setInterval(() => {
      debugLog("runtime.snapshot", {
        callActive,
        localStreamReady,
        startOfferSignal,
        pendingCandidates: pendingCandidates.length,
        transcriptLines: transcriptLines.length,
        selfRecognitionActive: Boolean(selfRecognition),
        dataChannelState: dataChannel?.readyState || null,
        ...snapshotMemory(),
      });
      collectPeerStats();
    }, 5000);

    let lastTick = performance.now();
    lagInterval = setInterval(() => {
      const now = performance.now();
      const drift = Math.round(now - lastTick - 1000);
      lastTick = now;
      if (drift > 500) {
        debugLog("runtime.lag.warn", { driftMs: drift });
      }
    }, 1000);
  }

  function stopDiagnostics() {
    clearInterval(diagnosticsInterval);
    clearInterval(lagInterval);
    diagnosticsInterval = null;
    lagInterval = null;
    debugLog("page.cleanup");
  }

  function downloadDebugLog() {
    try {
      const raw = localStorage.getItem(DEBUG_LOG_KEY) || JSON.stringify(debugLogBuffer);
      const blob = new Blob([raw], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `call_debug_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      debugLog("debug.download");
    } catch (e) {
      console.error("[CallDiag] Failed to download debug log", e);
    }
  }

  installDiagnostics();

  // -----------------------------------------------------------------------
  // WebRTC configuration
  // TURN removed: OpenRelay free TURN servers (openrelay.metered.ca) were
  // sending malformed packets that crashed Chromium's native ICE C++ stack.
  // STUN-only is sufficient for same-machine / LAN testing.
  // Add a proper paid TURN (e.g. Twilio, Metered.ca paid plan) for production
  // cross-network calls.
  // -----------------------------------------------------------------------
  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
    iceCandidatePoolSize: 0,  // no pre-gathering — gather on demand only
  };

  // Abort SR cleanly on page unload so the browser doesn't keep a zombie SR alive
  window.addEventListener("beforeunload", () => {
    transcriptionStopped = true;
    try { if (selfRecognition) selfRecognition.abort(); } catch (e) {}
  });

  // Catch unhandled promise rejections and surface them in the transcript panel
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[Call] Unhandled rejection:", e.reason);
    appendTranscriptSystem(`⚠ Internal error: ${e.reason?.message || e.reason}`);
  });

  // -----------------------------------------------------------------------
  // Socket.IO connection
  // -----------------------------------------------------------------------
  const socket = io({
    auth: { csrf_token: document.querySelector('meta[name="csrf-token"]').content },
    reconnection:       false,   // Don't auto-reconnect mid-call; show ended UI instead
  });

  socket.on("connect_error", (error) => {
    debugLog("socket.connect_error", { message: error.message, stack: error.stack || null });
  });

  socket.on("connect", async () => {
    debugLog("socket.connect", { socketId: socket.id });
    console.log("[Call] Socket connected:", socket.id);
    // Join the signalling room first, then announce we're ready
    socket.emit("join_call_room", { room_id: roomId });
    // Acquire media in parallel — peer_ready is sent after media is ready
    await initLocalStream();
  });

  socket.on("disconnect", () => {
    debugLog("socket.disconnect");
    console.warn("[Call] Socket disconnected");
    handleCallEnded("Connection lost");
  });

  // -----------------------------------------------------------------------
  // Signalling events
  // -----------------------------------------------------------------------

  /**
   * Server sends this once BOTH peers have emitted peer_ready.
   * Only the caller receives it; this guarantees the callee's socket is
   * fully connected before the offer is sent.
   */
  socket.on("start_offer", async ({ room_id }) => {
    if (room_id !== roomId) return;
    debugLog("signal.start_offer", { roomId: room_id });
    console.log("[Call] start_offer received from server");
    startOfferSignal = true;
    if (localStreamReady) {
      await createOffer();
    }
    // else: initLocalStream will check startOfferSignal when it finishes
  });

  /** Callee receives the SDP offer from the caller. */
  socket.on("webrtc_offer", async ({ offer, caller_id, room_id }) => {
    if (room_id !== roomId) return;
    debugLog("signal.webrtc_offer", { callerId: caller_id, type: offer?.type || null });
    console.log("[Call] webrtc_offer received from", caller_id);
    await handleOffer(offer, caller_id);
  });

  /** Caller receives the SDP answer from the callee. */
  socket.on("webrtc_answer", async ({ answer, answerer_id }) => {
    debugLog("signal.webrtc_answer", { answererId: answerer_id, type: answer?.type || null });
    console.log("[Call] webrtc_answer received from", answerer_id);
    if (peerConn && peerConn.signalingState !== "stable") {
      await peerConn.setRemoteDescription(new RTCSessionDescription(answer));

      // Drain any ICE candidates buffered before remote description was set
      for (const c of pendingCandidates) {
        try { await peerConn.addIceCandidate(new RTCIceCandidate(c)); }
        catch (e) { console.warn("[Call] Buffered ICE candidate failed (answer)", e); }
      }
      pendingCandidates = [];
    }
  });

  /** Both sides trickle ICE candidates to each other. */
  socket.on("ice_candidate", async ({ candidate, sender_id }) => {
    if (!candidate) return;
    debugLog("signal.ice_candidate", {
      senderId: sender_id,
      candidateType: candidate.candidate || null,
      sdpMid: candidate.sdpMid || null,
    });
    if (peerConn && peerConn.remoteDescription) {
      // Remote description already set — add immediately
      try {
        await peerConn.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("[Call] Failed to add ICE candidate", e);
      }
    } else {
      // Buffer until remote description is set
      console.log("[Call] Buffering ICE candidate (no remote desc yet)");
      pendingCandidates.push(candidate);
    }
  });

  /** Server or server-detected error — e.g. call session no longer exists. */
  socket.on("call_error", ({ message }) => {
    debugLog("signal.call_error", { message });
    console.warn("[Call] call_error:", message);
    setStatus("ended", message);
    appendTranscriptSystem(`⚠ ${message}`);
    stopTranscription();
    setTimeout(() => { window.location.href = "/"; }, 3000);
  });

  /** Remote side ended the call. */
  socket.on("call_ended", ({ ender_name, reason }) => {
    debugLog("signal.call_ended", { enderName: ender_name, reason });
    handleCallEnded(`${ender_name} ended the call`);
  });

  /** Remote side declined (rare on call page, but handle gracefully). */
  socket.on("call_declined", ({ decliner_name }) => {
    debugLog("signal.call_declined", { declinerName: decliner_name });
    handleCallEnded(`${decliner_name} declined the call`);
  });

  // -----------------------------------------------------------------------
  // Local media acquisition
  // -----------------------------------------------------------------------
  async function initLocalStream() {
    setStatus("connecting", "Accessing camera…");
    debugLog("media.getUserMedia.start", {
      constraints: {
        video: { width: { ideal: 320 }, height: { ideal: 240 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      },
    });
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 } },
        // Force browser audio processing OFF. Logs showed Chromium was still
        // enabling echoCancellation/noiseSuppression/autoGainControl by default,
        // which is the most likely cause of external SpeechRecognition aborts.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      localVideo.srcObject = localStream;
      monitorMediaStream(localStream, "local");
      debugLog("media.getUserMedia.success", {
        streamId: localStream.id,
        tracks: localStream.getTracks().map(track => ({
          kind: track.kind,
          id: track.id,
          label: track.label,
          settings: typeof track.getSettings === "function" ? track.getSettings() : null,
        })),
      });
      const localAudioTrack = localStream.getAudioTracks()[0] || null;
      const audioSettings = localAudioTrack && typeof localAudioTrack.getSettings === "function"
        ? localAudioTrack.getSettings()
        : null;
      if (audioSettings && (audioSettings.echoCancellation || audioSettings.noiseSuppression || audioSettings.autoGainControl)) {
        appendTranscriptSystem("⚠ Browser ignored requested audio constraints and kept echo/noise/AGC enabled. That likely breaks browser live transcription here.");
        debugLog("media.audio_processing_forced_on", {
          echoCancellation: audioSettings.echoCancellation || false,
          noiseSuppression: audioSettings.noiseSuppression || false,
          autoGainControl: audioSettings.autoGainControl || false,
        });
      }

      localStreamReady = true;

      setStatus("connecting", "Waiting for peer\u2026");
      console.log(`[Call] Local stream ready. Role: ${isCaller ? "caller" : "callee"}, room: ${roomId}`);

      // NOTE: SR is started in onCallConnected(), NOT here.
      // Starting SR while WebRTC is still negotiating causes an audio-pipeline
      // conflict on Windows that crashes the renderer process.

      // Notify server we are ready; when the server confirms both peers are
      // ready it will send start_offer to the caller only.
      socket.emit("peer_ready", { room_id: roomId });
      debugLog("signal.peer_ready.emit", { roomId });

      if (isCaller && startOfferSignal) {
        // start_offer already arrived before getUserMedia finished
        await createOffer();
      }
      // Callee: wait passively for the webrtc_offer event.
    } catch (err) {
      debugLog("media.getUserMedia.error", { name: err.name, message: err.message, stack: err.stack || null });
      console.error("[Call] getUserMedia error:", err);
      const msg = err.name === "NotAllowedError"
        ? "Camera/microphone permission denied. Please allow access and reload."
        : `Could not access media devices: ${err.message}`;
      setStatus("ended", msg);
      showError(msg);
    }
  }

  // -----------------------------------------------------------------------
  // RTCPeerConnection creation
  // -----------------------------------------------------------------------

  /** Resolves as soon as getUserMedia has finished, or rejects after 30 s. */
  function waitForLocalStream() {
    if (localStreamReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(id);
        reject(new Error("Timed out waiting for local media stream"));
      }, 30_000);
      const id = setInterval(() => {
        if (localStreamReady) {
          clearInterval(id);
          clearTimeout(deadline);
          resolve();
        }
      }, 50);
    });
  }

  function createPeerConnection() {
    if (peerConn) return peerConn;

    peerConn = new RTCPeerConnection(RTC_CONFIG);
    debugLog("webrtc.pc.create", { config: RTC_CONFIG });

    // Add local tracks
    localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));
    debugLog("webrtc.pc.local_tracks_added", {
      count: localStream.getTracks().length,
      tracks: localStream.getTracks().map(track => ({ kind: track.kind, id: track.id })),
    });

    // ICE candidate handler — send to peer via SocketIO
    peerConn.onicecandidate = ({ candidate }) => {
      if (candidate) {
        debugLog("webrtc.pc.onicecandidate", {
          type: candidate.type || null,
          protocol: candidate.protocol || null,
          candidate: candidate.candidate,
        });
        socket.emit("ice_candidate", {
          target_user_id: OTHER_USER_ID,
          room_id:        roomId,
          candidate:      candidate.toJSON(),
        });
      }
    };

    peerConn.onicecandidateerror = (event) => {
      debugLog("webrtc.pc.onicecandidateerror", {
        address: event.address || null,
        port: event.port || null,
        url: event.url || null,
        errorCode: event.errorCode || null,
        errorText: event.errorText || null,
      });
    };

    peerConn.onicegatheringstatechange = () => {
      debugLog("webrtc.pc.ice_gathering_state", { state: peerConn.iceGatheringState });
    };

    peerConn.onsignalingstatechange = () => {
      debugLog("webrtc.pc.signaling_state", { state: peerConn.signalingState });
    };

    peerConn.onconnectionstatechange = () => {
      debugLog("webrtc.pc.connection_state", { state: peerConn.connectionState });
    };

    peerConn.onnegotiationneeded = () => {
      debugLog("webrtc.pc.negotiation_needed");
    };

    peerConn.oniceconnectionstatechange = () => {
      const state = peerConn.iceConnectionState;
      debugLog("webrtc.pc.ice_connection_state", { state });
      console.log("[Call] ICE state:", state);
      if (state === "checking") {
        appendTranscriptSystem("\u231b Connecting to peer\u2026");
      } else if (state === "connected" || state === "completed") {
        onCallConnected();
      } else if (state === "disconnected") {
        setStatus("connecting", "Reconnecting\u2026");
        appendTranscriptSystem("\u26a0 Connection interrupted \u2014 reconnecting\u2026");
      } else if (state === "failed") {
        appendTranscriptSystem("\u274c Connection failed \u2014 could not reach peer.");
        handleCallEnded("Connection failed");
      }
    };

    // Remote stream — render in remoteVideo element
    // NOTE: We do NOT call tryRemoteTranscription() here. Chrome only allows
    // one SpeechRecognition at a time; starting a second instance aborts the
    // first (self) recognition. Remote speech is captured on the remote
    // device and sent here via the DataChannel instead.
    peerConn.ontrack = (event) => {
      const [stream] = event.streams;
      debugLog("webrtc.pc.ontrack", {
        trackKind: event.track?.kind || null,
        trackId: event.track?.id || null,
        streamId: stream?.id || null,
        streams: event.streams.map(s => s.id),
      });
      if (remoteVideo.srcObject !== stream) {
        remoteVideo.srcObject = stream;
        remotePH.style.display = "none";
        monitorMediaStream(stream, "remote");
        appendTranscriptSystem("\u25cf Peer video/audio connected");
      }
    };

    // DataChannel (created by caller)
    if (isCaller) {
      dataChannel = peerConn.createDataChannel("chat", { ordered: true });
      setupDataChannel(dataChannel);
    } else {
      peerConn.ondatachannel = ({ channel }) => {
        dataChannel = channel;
        setupDataChannel(dataChannel);
      };
    }

    return peerConn;
  }

  // -----------------------------------------------------------------------
  // WebRTC signalling
  // -----------------------------------------------------------------------
  async function createOffer() {
    await waitForLocalStream();
    createPeerConnection();
    try {
      debugLog("webrtc.offer.create.start");
      const offer = await peerConn.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true,
      });
      await peerConn.setLocalDescription(offer);
      debugLog("webrtc.offer.create.success", { type: offer.type, sdpLength: offer.sdp?.length || 0 });

      socket.emit("webrtc_offer", {
        target_user_id: OTHER_USER_ID,
        room_id:        roomId,
        offer:          peerConn.localDescription.toJSON(),
      });
    } catch (err) {
      debugLog("webrtc.offer.create.error", { message: err.message, stack: err.stack || null });
      console.error("[Call] createOffer error:", err);
    }
  }

  async function handleOffer(offer, callerId) {
    await waitForLocalStream();  // callee may receive offer before getUserMedia finishes
    createPeerConnection();
    try {
      debugLog("webrtc.offer.handle.start", { callerId, type: offer?.type || null, sdpLength: offer?.sdp?.length || 0 });
      await peerConn.setRemoteDescription(new RTCSessionDescription(offer));

      // Flush any ICE candidates that arrived before remote desc was set
      for (const c of pendingCandidates) {
        try { await peerConn.addIceCandidate(new RTCIceCandidate(c)); }
        catch (e) { console.warn("[Call] Buffered ICE candidate failed", e); }
      }
      pendingCandidates = [];

      const answer = await peerConn.createAnswer();
      await peerConn.setLocalDescription(answer);
      debugLog("webrtc.answer.create.success", { type: answer.type, sdpLength: answer.sdp?.length || 0 });

      socket.emit("webrtc_answer", {
        target_user_id: callerId,
        room_id:        roomId,
        answer:         peerConn.localDescription.toJSON(),
      });
    } catch (err) {
      debugLog("webrtc.offer.handle.error", { message: err.message, stack: err.stack || null });
      console.error("[Call] handleOffer error:", err);
    }
  }

  // -----------------------------------------------------------------------
  // Call connected callback
  // -----------------------------------------------------------------------
  function onCallConnected() {
    if (callActive) return;
    debugLog("call.connected");
    callActive    = true;
    callStartTime = Date.now();
    setStatus("active", "Connected");
    startTimer();
    callTimer.classList.remove("hidden");
    appendTranscriptSystem("\u25cf Call connected");
    // Start SR now — WebRTC negotiation is complete, audio pipeline is stable.
    startSelfTranscription();
  }

  function syncSelfTranscriptionWithMute() {
    if (isMuted) {
      selfTranscriptionPaused = true;
      debugLog("sr.pause_for_mute");
      if (mediaRecorderForTranscript && mediaRecorderForTranscript.state === "recording") {
        try { mediaRecorderForTranscript.stop(); } catch (e) {}
      }
      appendTranscriptSystem("🔇 Your transcription paused while muted");
      return;
    }

    const wasPaused = selfTranscriptionPaused;
    selfTranscriptionPaused = false;
    if (wasPaused && callActive && !transcriptionStopped) {
      debugLog("sr.resume_after_unmute");
      startSelfTranscription();
      appendTranscriptSystem("🎤 Your transcription resumed");
    }
  }

  // -----------------------------------------------------------------------
  // Controls
  // -----------------------------------------------------------------------

  // Mute / unmute
  muteBtn.addEventListener("click", () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
    syncSelfTranscriptionWithMute();
    muteBtn.classList.toggle("active", isMuted);
    muteBtn.setAttribute("aria-pressed", isMuted.toString());
    muteBtn.querySelector(".call-ctrl-btn__label").textContent = isMuted ? "Unmute" : "Mute";
  });

  // Camera on / off
  cameraBtn.addEventListener("click", () => {
    if (!localStream) return;
    isCameraOff = !isCameraOff;
    localStream.getVideoTracks().forEach(t => (t.enabled = !isCameraOff));
    cameraBtn.classList.toggle("active", isCameraOff);
    cameraBtn.setAttribute("aria-pressed", isCameraOff.toString());
    cameraBtn.querySelector(".call-ctrl-btn__label").textContent = isCameraOff ? "Cam Off" : "Camera";
  });

  // Hang Up — normal end
  if (hangUpBtn) hangUpBtn.addEventListener("click", endCall);

  // Emergency STOP — 1-minute ban
  if (stopBtn) stopBtn.addEventListener("click", () => {
    const BAN_DURATION_MS = 1 * 60 * 1000;  // 1 minute
    localStorage.setItem(BAN_KEY, String(Date.now() + BAN_DURATION_MS));
    socket.emit("end_call", { target_user_id: OTHER_USER_ID, room_id: roomId });
    handleCallEnded("Emergency stop — calls blocked for 1 minute");
  });

  // Back button — confirm before leaving if call is active
  backBtn.addEventListener("click", (e) => {
    if (callActive) {
      e.preventDefault();
      if (confirm("Are you sure you want to leave? This will end the call.")) {
        endCall();
      }
    }
  });

  function endCall() {
    debugLog("call.end.self");
    socket.emit("end_call", { target_user_id: OTHER_USER_ID, room_id: roomId });
    handleCallEnded("You ended the call");
  }

  function handleCallEnded(reason) {
    debugLog("call.ended", { reason, transcriptLines: transcriptLines.length });
    if (!callActive && reason !== "You ended the call") {
      setTimeout(() => (window.location.href = "/"), 1500);
    }
    callActive = false;
    stopTimer();
    setStatus("ended", reason);
    stopTranscription();
    saveTranscriptToServer();
    if (transcriptLines.length > 0) downloadTranscript();
    cleanup();
    setTimeout(() => (window.location.href = "/"), 3500);
  }

  function cleanup() {
    debugLog("call.cleanup.start", {
      hasLocalStream: Boolean(localStream),
      hasPeerConn: Boolean(peerConn),
      hasDataChannel: Boolean(dataChannel),
    });
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream          = null;
      localVideo.srcObject = null;
    }
    if (peerConn) {
      peerConn.close();
      peerConn = null;
    }
    if (dataChannel) {
      dataChannel.close();
      dataChannel = null;
    }
    stopDiagnostics();
  }

  // -----------------------------------------------------------------------
  // Timer
  // -----------------------------------------------------------------------
  function startTimer() {
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
      const s = (elapsed % 60).toString().padStart(2, "0");
      callTimer.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // -----------------------------------------------------------------------
  // Status helpers
  // -----------------------------------------------------------------------
  function setStatus(type, text) {
    callStatus.className = `call-status call-status--${type}`;
    callStatus.textContent = text;
  }

  function showError(msg) {
    const div     = document.createElement("div");
    div.className = "flash flash--error";
    div.setAttribute("role", "alert");
    div.innerHTML = `<span>${msg}</span>`;
    document.querySelector(".main-content").prepend(div);
  }

  // -----------------------------------------------------------------------
  // DataChannel (kept for future use)
  // -----------------------------------------------------------------------
  function setupDataChannel(channel) {
    debugLog("datachannel.setup", { label: channel.label, readyState: channel.readyState });
    channel.onopen  = () => { console.log("[DataChannel] open"); debugLog("datachannel.open", { label: channel.label }); };
    channel.onclose = () => { console.log("[DataChannel] closed"); debugLog("datachannel.close", { label: channel.label }); };
    channel.onerror = (event) => { debugLog("datachannel.error", { type: event.type || "error" }); };
    // Receive transcript lines sent by the remote peer
    channel.onmessage = (event) => {
      debugLog("datachannel.message", { size: event.data?.length || 0 });
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "transcript" && msg.text) {
          if (msg.sender_id && msg.sender_id !== OTHER_USER_ID) {
            debugLog("datachannel.message.ignored", { senderId: msg.sender_id, expectedSenderId: OTHER_USER_ID });
            return;
          }
          // Always label remote speech using the peer identity from this page.
          // Do not trust the sender-provided display name, since that can drift
          // or be stale across sessions/profiles.
          logTranscriptLine(OTHER_USERNAME, msg.text, "remote");
        }
      } catch (e) { /* ignore malformed messages */ }
    };
  }

  // -----------------------------------------------------------------------
  // Live transcription (MediaRecorder → backend STT)
  // -----------------------------------------------------------------------

  // Transcribes YOUR microphone by recording 4-second WebM/Opus chunks and
  // POSTing them to /api/transcribe (backend STT).  This is far more reliable
  // inside a WebRTC call than the Web Speech API, which Chrome keeps aborting
  // due to audio-pipeline conflicts.
  let transcriptionInitialized      = false;
  let mediaRecorderForTranscript    = null;
  let transcriptRecordingActive     = false;
  let transcriptAudioStream         = null;
  let transcriptChunkTimer          = null;
  const TRANSCRIBE_CHUNK_MS         = 4000;

  function scheduleRecorderStop(recorder) {
    clearTimeout(transcriptChunkTimer);
    transcriptChunkTimer = setTimeout(() => {
      try {
        if (recorder && recorder.state === "recording") recorder.stop();
      } catch (e) {
        debugLog("transcribe.stop_timer.error", { message: e.message });
      }
    }, TRANSCRIBE_CHUNK_MS);
  }

  function startRecorderSegment() {
    if (!transcriptRecordingActive || transcriptionStopped || selfTranscriptionPaused || isMuted) {
      return;
    }
    if (!transcriptAudioStream) {
      return;
    }

    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"]
      .find(m => MediaRecorder.isTypeSupported(m)) || "";

    const recorder = new MediaRecorder(transcriptAudioStream, mimeType ? { mimeType } : {});
    mediaRecorderForTranscript = recorder;
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";

    recorder.ondataavailable = async (e) => {
      if (selfTranscriptionPaused || isMuted) return;
      if (!e.data || e.data.size < 1000) return;  // skip empty/near-silent chunks
      debugLog("transcribe.chunk", { sizeBytes: e.data.size, mimeType: e.data.type || mimeType });
      try {
        const startedAt = performance.now();
        const arrayBuffer = await e.data.arrayBuffer();
        debugLog("transcribe.request", {
          bytes: arrayBuffer.byteLength,
          contentType: e.data.type || mimeType || "audio/webm",
        });
        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: {
            "Content-Type": e.data.type || mimeType || "audio/webm",
            "X-CSRFToken": csrfToken,
            "X-Call-Room-Id": roomId,
            "X-Call-Target-User-Id": String(OTHER_USER_ID),
          },
          body: arrayBuffer,
        });
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (res.ok) {
          const data = await res.json();
          debugLog("transcribe.response", {
            status: res.status,
            elapsedMs,
            hasText: Boolean(data.text && data.text.trim()),
            textLength: (data.text || "").trim().length,
            provider: data.provider || null,
            speechModel: data.speech_model || null,
            profanityDetected: Boolean(data.profanity_detected),
            moderationAction: data.moderation_action || null,
          });
          if (data.text && data.text.trim()) {
            debugLog("transcribe.result", { text: data.text.trim() });
            logTranscriptLine(MY_NAME, data.text.trim(), "self");
          } else {
            debugLog("transcribe.empty", { elapsedMs, reason: data.error || "no_speech" });
          }
        } else {
          let errText = "";
          try {
            errText = await res.text();
          } catch (_) {
            errText = "";
          }
          debugLog("transcribe.http_error", {
            status: res.status,
            elapsedMs,
            body: (errText || "").slice(0, 250),
          });
        }
      } catch (err) {
        debugLog("transcribe.error", { message: err.message, stack: err.stack || null });
      }
    };

    recorder.onerror = (e) => {
      debugLog("transcribe.recorder_error", { error: e.error?.name || "unknown" });
    };

    recorder.onstop = () => {
      if (mediaRecorderForTranscript === recorder) {
        mediaRecorderForTranscript = null;
      }
      if (transcriptRecordingActive && !transcriptionStopped && !selfTranscriptionPaused && !isMuted) {
        startRecorderSegment();
      }
    };

    recorder.start();
    debugLog("transcribe.segment_start", { mimeType, durationMs: TRANSCRIBE_CHUNK_MS });
    scheduleRecorderStop(recorder);
  }

  function startSelfTranscription() {
    if (selfTranscriptionPaused || transcriptionStopped) return;
    if (!window.MediaRecorder || !localStream) {
      appendTranscriptSystem("⚠ Audio transcription unavailable (MediaRecorder not supported).");
      return;
    }

    if (transcriptRecordingActive && mediaRecorderForTranscript) {
      return;
    }

    if (!transcriptionInitialized) {
      transcriptionInitialized = true;
      transcriptBody.innerHTML = "";
      appendTranscriptSystem("● Transcription started — updates every few seconds");
      debugLog("transcribe.init");
    }

    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) {
      appendTranscriptSystem("⚠ No audio track found for transcription.");
      return;
    }

    transcriptAudioStream = new MediaStream(audioTracks);
    transcriptRecordingActive = true;
    startRecorderSegment();
    debugLog("transcribe.start", { chunkMs: TRANSCRIBE_CHUNK_MS });
    appendTranscriptSystem("🎤 Listening — transcript updates every ~4 seconds");
  }

  function stopTranscription() {
    transcriptionStopped = true;
    transcriptRecordingActive = false;
    clearTimeout(transcriptChunkTimer);
    transcriptChunkTimer = null;
    debugLog("sr.stop");
    if (mediaRecorderForTranscript && mediaRecorderForTranscript.state !== "inactive") {
      try { mediaRecorderForTranscript.stop(); } catch (e) {}
    }
    mediaRecorderForTranscript = null;
    transcriptAudioStream = null;
    try { if (selfRecognition) selfRecognition.abort(); } catch (e) {}
  }

  function hasCensoredProfanity(text) {
    return /\*/.test(text || "");
  }

  function enforceProfanityPolicy(speaker, text, side) {
    if (!hasCensoredProfanity(text)) return false;
    if (profanityTerminationTriggered) return true;
    profanityTerminationTriggered = true;

    debugLog("moderation.profanity_detected", {
      speaker,
      side,
      sample: (text || "").slice(0, 160),
    });

    appendTranscriptSystem("⛔ Profanity detected in transcript. Ending call automatically.");
    socket.emit("end_call", { target_user_id: OTHER_USER_ID, room_id: roomId });
    handleCallEnded("Call ended automatically due to profanity policy");
    return true;
  }

  function logTranscriptLine(speaker, text, side) {
    debugLog("transcript.line", { speaker, side, length: text.length });
    if (enforceProfanityPolicy(speaker, text, side)) return;

    const now  = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    transcriptLines.push({ time, speaker, text });

    // Share own speech with the remote peer via DataChannel
    if (side === "self" && dataChannel && dataChannel.readyState === "open") {
      try { dataChannel.send(JSON.stringify({ type: "transcript", sender_id: MY_ID, speaker, text })); }
      catch (e) { console.warn("[DataChannel] send failed:", e); }
    }

    const entry = document.createElement("div");
    entry.className = "transcript-entry";
    entry.innerHTML =
      `<span class="transcript-entry__time">${escapeHtml(time)}</span>` +
      `<span class="transcript-entry__speaker transcript-entry__speaker--${side}">${escapeHtml(speaker)}</span>` +
      `<p class="transcript-entry__text">${escapeHtml(text)}</p>`;
    transcriptBody.appendChild(entry);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }

  function createInterimEl(speaker, side) {
    const el = document.createElement("div");
    el.className = "transcript-entry transcript-entry--interim";
    el.innerHTML =
      `<span class="transcript-entry__speaker transcript-entry__speaker--${side}">${escapeHtml(speaker)}</span>` +
      `<p class="transcript-entry__text"></p>`;
    return el;
  }

  function appendTranscriptSystem(text) {
    const el = document.createElement("p");
    el.className = "transcript-system";
    el.textContent = text;
    transcriptBody.appendChild(el);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }

  function buildTranscriptText() {
    const header =
      `UMentor Call Transcript\n` +
      `Call with: ${OTHER_USERNAME}\n` +
      `Date: ${new Date().toLocaleString()}\n` +
      `${"-".repeat(50)}\n\n`;
    const body = transcriptLines
      .map(l => `[${l.time}] ${l.speaker}: ${l.text}`)
      .join("\n");
    return header + (body || "(No speech detected)");
  }

  function downloadTranscript() {
    const text = buildTranscriptText();
    const blob  = new Blob([text], { type: "text/plain" });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement("a");
    a.href      = url;
    a.download  = `transcript_${OTHER_USERNAME}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function saveTranscriptToServer() {
    if (transcriptLines.length === 0) return;
    debugLog("transcript.save.start", { lines: transcriptLines.length });
    const text = buildTranscriptText();
    const csrf = document.querySelector('meta[name="csrf-token"]').content;
    fetch("/api/save-transcript", {
      method:   "POST",
      keepalive: true,
      headers:  { "Content-Type": "application/json", "X-CSRFToken": csrf },
      body:     JSON.stringify({ text, room_id: roomId }),
    }).then(() => {
      debugLog("transcript.save.success");
    }).catch((err) => {
      debugLog("transcript.save.error", { message: err.message || String(err) });
    });
  }

  if (downloadTranscriptBtn) {
    downloadTranscriptBtn.addEventListener("click", downloadTranscript);
    const debugBtn = document.createElement("button");
    debugBtn.className = downloadTranscriptBtn.className;
    debugBtn.type = "button";
    debugBtn.title = "Download debug log";
    debugBtn.textContent = "DBG";
    debugBtn.addEventListener("click", downloadDebugLog);
    downloadTranscriptBtn.parentElement?.appendChild(debugBtn);
  }

  // -----------------------------------------------------------------------
  // Google Gemini AI assistant
  // -----------------------------------------------------------------------

  let aiThinking = false;

  function appendAiMsg(text, role) {
    // role: 'user' | 'ai' | 'system'
    const div = document.createElement("div");
    div.className = `ai-msg ai-msg--${role}`;
    div.textContent = text;
    aiMessages.appendChild(div);
    aiMessages.scrollTop = aiMessages.scrollHeight;
  }

  function setAiThinking(on) {
    aiThinking = on;
    const existing = aiMessages.querySelector(".ai-msg--thinking");
    if (on && !existing) {
      const el = document.createElement("div");
      el.className = "ai-msg ai-msg--thinking";
      el.textContent = "AI is thinking…";
      aiMessages.appendChild(el);
      aiMessages.scrollTop = aiMessages.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  if (aiForm) {
    aiForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = aiInput.value.trim();
      if (!msg || aiThinking) return;
      aiInput.value = "";

      appendAiMsg(msg, "user");
      setAiThinking(true);

      const transcriptContext = transcriptLines
        .map(l => `[${l.time}] ${l.speaker}: ${l.text}`)
        .join("\n") || "(No speech yet)";

      const csrf = document.querySelector('meta[name="csrf-token"]').content;
      try {
        const res = await fetch("/api/gemini-chat", {
          method:  "POST",
          headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
          body:    JSON.stringify({ message: msg, transcript: transcriptContext }),
        });
        const data = await res.json();
        setAiThinking(false);
        if (data.reply) {
          appendAiMsg(data.reply, "ai");
        } else {
          appendAiMsg(data.error || "No response from AI.", "system");
        }
      } catch (err) {
        setAiThinking(false);
        appendAiMsg("Error contacting AI service.", "system");
      }
    });
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // -----------------------------------------------------------------------
  // Page unload — clean up tracks so camera LED turns off
  // -----------------------------------------------------------------------
  window.addEventListener("beforeunload", cleanup);

})();
