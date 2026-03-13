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

  socket.on("connect", async () => {
    console.log("[Call] Socket connected:", socket.id);
    // Join the signalling room first, then announce we're ready
    socket.emit("join_call_room", { room_id: roomId });
    // Acquire media in parallel — peer_ready is sent after media is ready
    await initLocalStream();
  });

  socket.on("disconnect", () => {
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
    console.log("[Call] webrtc_offer received from", caller_id);
    await handleOffer(offer, caller_id);
  });

  /** Caller receives the SDP answer from the callee. */
  socket.on("webrtc_answer", async ({ answer, answerer_id }) => {
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
    console.warn("[Call] call_error:", message);
    setStatus("ended", message);
    appendTranscriptSystem(`⚠ ${message}`);
    stopTranscription();
    setTimeout(() => { window.location.href = "/"; }, 3000);
  });

  /** Remote side ended the call. */
  socket.on("call_ended", ({ ender_name, reason }) => {
    handleCallEnded(`${ender_name} ended the call`);
  });

  /** Remote side declined (rare on call page, but handle gracefully). */
  socket.on("call_declined", ({ decliner_name }) => {
    handleCallEnded(`${decliner_name} declined the call`);
  });

  // -----------------------------------------------------------------------
  // Local media acquisition
  // -----------------------------------------------------------------------
  async function initLocalStream() {
    setStatus("connecting", "Accessing camera…");
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 } },
        // No echoCancellation / noiseSuppression — these audio-processing filters
        // conflict with the Web Speech API on Windows: both try to own the mic's
        // AudioProcessingGraph, causing a renderer crash within seconds.
        audio: true,
      });
      localVideo.srcObject = localStream;

      localStreamReady = true;

      setStatus("connecting", "Waiting for peer\u2026");
      console.log(`[Call] Local stream ready. Role: ${isCaller ? "caller" : "callee"}, room: ${roomId}`);

      // NOTE: SR is started in onCallConnected(), NOT here.
      // Starting SR while WebRTC is still negotiating causes an audio-pipeline
      // conflict on Windows that crashes the renderer process.

      // Notify server we are ready; when the server confirms both peers are
      // ready it will send start_offer to the caller only.
      socket.emit("peer_ready", { room_id: roomId });

      if (isCaller && startOfferSignal) {
        // start_offer already arrived before getUserMedia finished
        await createOffer();
      }
      // Callee: wait passively for the webrtc_offer event.
    } catch (err) {
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

    // Add local tracks
    localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));

    // ICE candidate handler — send to peer via SocketIO
    peerConn.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit("ice_candidate", {
          target_user_id: OTHER_USER_ID,
          room_id:        roomId,
          candidate:      candidate.toJSON(),
        });
      }
    };

    peerConn.oniceconnectionstatechange = () => {
      const state = peerConn.iceConnectionState;
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
      if (remoteVideo.srcObject !== stream) {
        remoteVideo.srcObject = stream;
        remotePH.style.display = "none";
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
      const offer = await peerConn.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true,
      });
      await peerConn.setLocalDescription(offer);

      socket.emit("webrtc_offer", {
        target_user_id: OTHER_USER_ID,
        room_id:        roomId,
        offer:          peerConn.localDescription.toJSON(),
      });
    } catch (err) {
      console.error("[Call] createOffer error:", err);
    }
  }

  async function handleOffer(offer, callerId) {
    await waitForLocalStream();  // callee may receive offer before getUserMedia finishes
    createPeerConnection();
    try {
      await peerConn.setRemoteDescription(new RTCSessionDescription(offer));

      // Flush any ICE candidates that arrived before remote desc was set
      for (const c of pendingCandidates) {
        try { await peerConn.addIceCandidate(new RTCIceCandidate(c)); }
        catch (e) { console.warn("[Call] Buffered ICE candidate failed", e); }
      }
      pendingCandidates = [];

      const answer = await peerConn.createAnswer();
      await peerConn.setLocalDescription(answer);

      socket.emit("webrtc_answer", {
        target_user_id: callerId,
        room_id:        roomId,
        answer:         peerConn.localDescription.toJSON(),
      });
    } catch (err) {
      console.error("[Call] handleOffer error:", err);
    }
  }

  // -----------------------------------------------------------------------
  // Call connected callback
  // -----------------------------------------------------------------------
  function onCallConnected() {
    if (callActive) return;
    callActive    = true;
    callStartTime = Date.now();
    setStatus("active", "Connected");
    startTimer();
    callTimer.classList.remove("hidden");
    appendTranscriptSystem("\u25cf Call connected");
    // Start SR now — WebRTC negotiation is complete, audio pipeline is stable.
    startSelfTranscription();
  }

  // -----------------------------------------------------------------------
  // Controls
  // -----------------------------------------------------------------------

  // Mute / unmute
  muteBtn.addEventListener("click", () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
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
    socket.emit("end_call", { target_user_id: OTHER_USER_ID, room_id: roomId });
    handleCallEnded("You ended the call");
  }

  function handleCallEnded(reason) {
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
    channel.onopen  = () => console.log("[DataChannel] open");
    channel.onclose = () => console.log("[DataChannel] closed");
    // Receive transcript lines sent by the remote peer
    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "transcript" && msg.speaker && msg.text) {
          logTranscriptLine(msg.speaker, msg.text, "remote");
        }
      } catch (e) { /* ignore malformed messages */ }
    };
  }

  // -----------------------------------------------------------------------
  // Live transcription (Web Speech API)
  // -----------------------------------------------------------------------

  // Starts transcribing YOUR microphone immediately (called as soon as mic is granted).
  let transcriptionInitialized = false;  // true after first startSelfTranscription call

  // Uses a factory pattern: each restart creates a FRESH SpeechRecognition instance
  // so we never call .start() on a stale/ended object (that throws InvalidStateError
  // which was silently swallowed, killing SR permanently and crashing Chrome).
  function startSelfTranscription() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      appendTranscriptSystem("⚠ Live transcription not supported in this browser.");
      return;
    }
    if (selfRecognition) return;

    if (!transcriptionInitialized) {
      transcriptionInitialized = true;
      transcriptBody.innerHTML = "";
      appendTranscriptSystem("● Recording started");
      appendTranscriptSystem("💬 If no speech appears: Windows Settings → Privacy & security → Speech → ON");
    }

    // Quick SR self-test — pauses the live SR first so test gets exclusive mic access
    const testBtn = document.createElement("button");
    testBtn.textContent = "🧪 Test mic (say something)";
    testBtn.style.cssText = "font-size:0.65rem;padding:2px 6px;margin:4px 0;background:#1e3a5f;color:#fff;border:1px solid #2563eb;border-radius:4px;cursor:pointer";
    testBtn.onclick = () => {
      testBtn.remove();
      // Abort main SR so test gets exclusive mic access (browser allows only one SR at a time)
      const savedSR = selfRecognition;
      if (savedSR) { try { savedSR.abort(); } catch(e) {} selfRecognition = null; }
      appendTranscriptSystem("🧪 Speak now — testing SR alone...");
      const t = new SR();
      t.continuous = false; t.interimResults = false; t.lang = "en-US";
      t.onresult = (e) => {
        appendTranscriptSystem("✅ SR works! Heard: " + e.results[0][0].transcript);
      };
      t.onerror = (e) => {
        appendTranscriptSystem("❌ SR test error: " + e.error);
        if (!transcriptionStopped) setTimeout(() => { selfRecognition = null; startSelfTranscription(); }, 500);
      };
      t.onend = () => {
        if (!transcriptionStopped) setTimeout(() => { selfRecognition = null; startSelfTranscription(); }, 300);
      };
      try { t.start(); } catch(startErr) {
        appendTranscriptSystem("❌ t.start() threw: " + startErr.message);
      }
    };
    transcriptBody.appendChild(testBtn);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;

    let hasGottenAnyResult   = false;
    let consecutiveNoSpeech  = 0;
    let restartDelayMs       = 500;
    let selfInterimEl        = null;
    let soundMsgShown        = false;
    let speechMsgShown       = false;
    let instanceCount        = 0;   // guard against double-start races

    function createInstance() {
      if (transcriptionStopped) return;
      instanceCount++;
      const myInstance = instanceCount;

      const rec = new SR();
      // continuous=false avoids the high-frequency interim flood that crashes Chromium;
      // we restart manually after each utterance which is equally seamless to the user.
      rec.continuous     = false;
      rec.interimResults = true;
      rec.lang           = "en-US";
      rec.maxAlternatives = 1;
      selfRecognition    = rec;

      rec.onsoundstart = () => {
        if (!soundMsgShown) { soundMsgShown = true; appendTranscriptSystem("🔊 Sound detected…"); }
      };
      rec.onspeechstart = () => {
        if (!speechMsgShown) { speechMsgShown = true; appendTranscriptSystem("🗣 Speech detected — transcribing…"); }
      };

      rec.onresult = (event) => {
        consecutiveNoSpeech = 0;
        restartDelayMs      = 300;
        hasGottenAnyResult  = true;
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) {
            const text = r[0].transcript.trim();
            if (text) {
              if (selfInterimEl) { selfInterimEl.remove(); selfInterimEl = null; }
              logTranscriptLine(MY_NAME, text, "self");
            }
          } else {
            interim += r[0].transcript;
          }
        }
        if (interim) {
          if (!selfInterimEl) {
            selfInterimEl = createInterimEl(MY_NAME, "self");
            transcriptBody.appendChild(selfInterimEl);
          }
          selfInterimEl.querySelector(".transcript-entry__text").textContent = interim;
          transcriptBody.scrollTop = transcriptBody.scrollHeight;
        }
      };

      rec.onerror = (e) => {
        if (e.error === "aborted") return;
        if (e.error === "no-speech") {
          consecutiveNoSpeech++;
          restartDelayMs = Math.min(restartDelayMs * 1.4, 4000);
          if (!hasGottenAnyResult && consecutiveNoSpeech === 4) {
            appendTranscriptSystem("⚠ Still no speech. Check: Windows Privacy & security → Speech is ON, and your mic is not muted in system settings.");
          }
          return;
        }
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          appendTranscriptSystem("⚠ SR blocked. Fix: Site settings → allow Microphone + Speech recognition; AND Windows Settings → Privacy → Speech → ON.");
          transcriptionStopped = true;
          return;
        }
        if (e.error === "network") {
          appendTranscriptSystem("⚠ SR network error — speech server unreachable. Will retry.");
          return;
        }
        appendTranscriptSystem(`⚠ SR error: ${e.error}`);
      };

      rec.onend = () => {
        // Only restart if this is the current instance (guards against races)
        if (myInstance !== instanceCount) return;
        selfRecognition = null;
        if (!transcriptionStopped) {
          setTimeout(createInstance, restartDelayMs);
        }
      };

      try {
        rec.start();
      } catch (startErr) {
        console.warn("[SR] start() threw:", startErr.message);
        selfRecognition = null;
        if (!transcriptionStopped) setTimeout(createInstance, 1000);
      }
    }

    createInstance();
    appendTranscriptSystem("🎤 Listening…");
  }

  function stopTranscription() {
    transcriptionStopped = true;
    try { if (selfRecognition)   selfRecognition.abort();   } catch(e) {}
    try { if (remoteRecognition) remoteRecognition.abort(); } catch(e) {}
  }

  function logTranscriptLine(speaker, text, side) {
    const now  = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    transcriptLines.push({ time, speaker, text });

    // Share own speech with the remote peer via DataChannel
    if (side === "self" && dataChannel && dataChannel.readyState === "open") {
      try { dataChannel.send(JSON.stringify({ type: "transcript", speaker, text })); }
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
    const text = buildTranscriptText();
    const csrf = document.querySelector('meta[name="csrf-token"]').content;
    fetch("/api/save-transcript", {
      method:   "POST",
      keepalive: true,
      headers:  { "Content-Type": "application/json", "X-CSRFToken": csrf },
      body:     JSON.stringify({ text, room_id: roomId }),
    }).catch(() => {});
  }

  if (downloadTranscriptBtn) {
    downloadTranscriptBtn.addEventListener("click", downloadTranscript);
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
