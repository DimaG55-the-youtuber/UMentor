"""
sockets.py - Flask-SocketIO event handlers.

Responsibilities
----------------
* Track connected socket sessions per user.
* Broadcast real-time online/offline status changes to all clients.
* Relay WebRTC signalling messages (offer, answer, ICE candidates).
* Handle call request / accept / decline / end-call flow.
* Persist call logs to the database.
"""

import functools
import time
from datetime import datetime

from flask import request
from flask_login import current_user
from flask_socketio import SocketIO, disconnect, emit, join_room, leave_room

from models import CallLog, User, db

# ---------------------------------------------------------------------------
# SocketIO instance – initialised by app.py via socketio.init_app(app)
# ---------------------------------------------------------------------------
socketio = SocketIO()

# ---------------------------------------------------------------------------
# In-memory session registry
# user_id (int) → socket session id (str)
# Also tracks active call rooms: call_room_id → {caller_id, callee_id, log_id}
# ---------------------------------------------------------------------------
_user_sessions: dict[int, str]               = {}
_active_calls:  dict[str, dict]              = {}
# Tracks users navigating between pages so their brief socket disconnect
# does not mistakenly terminate an in-progress call.
# user_id → UTC timestamp of when they sent call_navigating
_call_transitions: dict[int, float]          = {}
# Tracks which peers have emitted peer_ready for a given call room.
# room_id → set of user_ids that are connected and ready on the call page.
_room_peers_ready: dict[str, set]            = {}


# ===========================================================================
# Decorator: reject unauthenticated socket connections
# ===========================================================================

def _authenticated_only(f):
    """Disconnect the socket if the user is not authenticated via Flask-Login."""
    @functools.wraps(f)
    def wrapped(*args, **kwargs):
        if not current_user.is_authenticated:
            disconnect()
            return
        return f(*args, **kwargs)
    return wrapped


# ===========================================================================
# Helper utilities
# ===========================================================================

def _room_id(uid_a: int, uid_b: int) -> str:
    """Deterministic room name for a call between two users."""
    lo, hi = sorted([uid_a, uid_b])
    return f"call_{lo}_{hi}"


def _broadcast_status(user_id: int, username: str, is_online: bool) -> None:
    """Emit a status update to every connected client."""
    socketio.emit(
        "user_status_changed",
        {"user_id": user_id, "username": username, "is_online": is_online},
    )


# ===========================================================================
# Connection lifecycle
# ===========================================================================

@socketio.on("connect")
@_authenticated_only
def on_connect():
    """Called when a client opens a WebSocket connection."""
    uid = current_user.id
    sid = request.sid

    # Register session
    _user_sessions[uid] = sid

    # Join user's personal notification room
    join_room(f"user_{uid}")

    # Update database
    user = db.session.get(User, uid)
    if user:
        user.is_online = True
        user.last_seen = datetime.utcnow()
        db.session.commit()

    # Send the newly connected client a snapshot of everyone already online.
    # Without this, existing users see the newcomer come online, but the newcomer
    # does not receive the prior online state for already-connected users.
    initial_statuses = []
    for other_uid in _user_sessions:
        if other_uid == uid:
            continue
        other_user = db.session.get(User, other_uid)
        if other_user:
            initial_statuses.append(
                {
                    "user_id": other_uid,
                    "username": other_user.username,
                    "is_online": True,
                }
            )
    emit("initial_user_statuses", {"users": initial_statuses})

    # Broadcast to all clients (including this one so the sender sees own dot go green)
    _broadcast_status(uid, current_user.username, True)


@socketio.on("call_navigating")
@_authenticated_only
def on_call_navigating():
    """
    Client emits this just before a page navigation that will cause a
    temporary socket disconnect (e.g. caller navigating to call page after
    acceptance, or callee navigating after accepting).  Prevents the
    disconnect handler from terminating the active call.
    """
    _call_transitions[current_user.id] = time.monotonic()


@socketio.on("disconnect")
@_authenticated_only
def on_disconnect():
    """Called when a client disconnects (tab close, network drop, explicit logout)."""
    uid = current_user.id
    _user_sessions.pop(uid, None)

    # If this disconnect is due to a page navigation (grace window = 20 s),
    # skip all side-effects.  The on_connect on the new page will restore
    # the user's online status.  Writing is_online=False to DB here was
    # causing the /call route to see the callee as offline and redirect
    # the caller back to dashboard with a "user is offline" flash.
    navigating_ts = _call_transitions.pop(uid, None)
    if navigating_ts and (time.monotonic() - navigating_ts) < 20:
        return

    # Update database
    user = db.session.get(User, uid)
    if user:
        user.is_online = False
        user.last_seen = datetime.utcnow()
        db.session.commit()

    # If the user was in a call, notify the other participant
    for room_id, info in list(_active_calls.items()):
        if uid in (info["caller_id"], info["callee_id"]):
            other_id = (
                info["callee_id"] if uid == info["caller_id"] else info["caller_id"]
            )
            emit(
                "call_ended",
                {"reason": "peer_disconnected", "ender_name": current_user.username},
                room=f"user_{other_id}",
            )
            # Close the call log
            _close_call_log(info, "completed")
            del _active_calls[room_id]
            break

    _broadcast_status(uid, current_user.username, False)


# ===========================================================================
# Calling flow  (call_request → incoming_call → accepted/declined → WebRTC)
# ===========================================================================

@socketio.on("call_request")
@_authenticated_only
def on_call_request(data: dict):
    """
    Caller sends this event to initiate a call.

    Payload: { target_user_id: int }
    """
    target_id = data.get("target_user_id")
    if not target_id:
        emit("call_error", {"message": "Missing target_user_id."})
        return

    target = db.session.get(User, target_id)
    if not target or not target.is_online:
        emit("call_error", {"message": "User is not available right now."})
        return

    if target_id not in _user_sessions:
        emit("call_error", {"message": "User is not connected."})
        return

    room = _room_id(current_user.id, target_id)

    # Create a provisional call log entry
    log = CallLog(
        caller_id=current_user.id,
        callee_id=target_id,
        status="missed",
    )
    db.session.add(log)
    db.session.commit()

    _active_calls[room] = {
        "caller_id": current_user.id,
        "callee_id": target_id,
        "log_id":    log.id,
        "started_at": datetime.utcnow(),
    }

    # Notify callee
    emit(
        "incoming_call",
        {
            "caller_id":   current_user.id,
            "caller_name": current_user.username,
            "room_id":     room,
        },
        room=f"user_{target_id}",
    )


@socketio.on("call_accepted")
@_authenticated_only
def on_call_accepted(data: dict):
    """
    Callee sends this after accepting an incoming call.

    Payload: { caller_id: int, room_id: str }
    """
    caller_id = data.get("caller_id")
    room_id   = data.get("room_id")

    # Both participants join the shared call room
    join_room(room_id)

    # Pre-mark both parties as "navigating" so their socket disconnect during
    # the page transition is treated as a grace-period event, even when the
    # client-side call_navigating message arrives late or is lost.
    if caller_id:
        _call_transitions[caller_id]       = time.monotonic()
    _call_transitions[current_user.id]     = time.monotonic()  # callee

    # Update call log status
    if room_id in _active_calls:
        log = db.session.get(CallLog, _active_calls[room_id]["log_id"])
        if log:
            log.status = "completed"
            db.session.commit()

    # Tell the caller the call is accepted so they can join the room and start WebRTC
    emit(
        "call_accepted",
        {
            "accepter_id":   current_user.id,
            "accepter_name": current_user.username,
            "room_id":       room_id,
        },
        room=f"user_{caller_id}",
    )


@socketio.on("call_declined")
@_authenticated_only
def on_call_declined(data: dict):
    """
    Callee sends this after declining an incoming call.

    Payload: { caller_id: int, room_id: str }
    """
    caller_id = data.get("caller_id")
    room_id   = data.get("room_id")

    if room_id and room_id in _active_calls:
        log = db.session.get(CallLog, _active_calls[room_id]["log_id"])
        if log:
            log.status = "declined"
            log.ended_at = datetime.utcnow()
            db.session.commit()
        del _active_calls[room_id]

    emit(
        "call_declined",
        {"decliner_name": current_user.username},
        room=f"user_{caller_id}",
    )


@socketio.on("end_call")
@_authenticated_only
def on_end_call(data: dict):
    """
    Either participant sends this to terminate an active call.

    Payload: { target_user_id: int, room_id: str }
    """
    target_id = data.get("target_user_id")
    room_id   = data.get("room_id")

    if room_id and room_id in _active_calls:
        info = _active_calls.pop(room_id)
        _close_call_log(info, "completed")

    emit(
        "call_ended",
        {"ender_name": current_user.username, "reason": "ended_by_peer"},
        room=f"user_{target_id}",
    )

    if room_id:
        leave_room(room_id)


# ===========================================================================
# WebRTC signalling relay
# ===========================================================================

@socketio.on("join_call_room")
@_authenticated_only
def on_join_call_room(data: dict):
    """Join the shared WebRTC signalling room after a call is accepted."""
    room_id = data.get("room_id")
    if room_id:
        join_room(room_id)


@socketio.on("peer_ready")
@_authenticated_only
def on_peer_ready(data: dict):
    """
    Emitted by each side when their call page has loaded, socket reconnected,
    and local media is ready.  Once BOTH peers signal ready, the server tells
    the caller to fire the WebRTC offer so the callee's socket is guaranteed
    to be connected and in the room before the offer arrives.

    Payload: { room_id: str }
    """
    room_id = data.get("room_id")
    if not room_id or room_id not in _active_calls:
        # Tell the client so it shows an error instead of hanging on "awaiting peer"
        emit("call_error", {"message": "Call session not found \u2014 it may have ended when the browser closed. Returning to dashboard\u2026"})
        return

    if room_id not in _room_peers_ready:
        _room_peers_ready[room_id] = set()

    _room_peers_ready[room_id].add(current_user.id)

    info       = _active_calls[room_id]
    caller_id  = info["caller_id"]
    callee_id  = info["callee_id"]

    # Only proceed once BOTH peers are ready
    if {caller_id, callee_id}.issubset(_room_peers_ready[room_id]):
        _room_peers_ready.pop(room_id, None)
        # Tell the caller to create and send the WebRTC offer
        emit("start_offer", {"room_id": room_id}, room=f"user_{caller_id}")


@socketio.on("webrtc_offer")
@_authenticated_only
def on_webrtc_offer(data: dict):
    """
    Relay an SDP offer from the caller to the callee.

    Payload: { target_user_id: int, room_id: str, offer: RTCSessionDescription }
    """
    target_id = data.get("target_user_id")
    emit(
        "webrtc_offer",
        {
            "offer":     data.get("offer"),
            "caller_id": current_user.id,
            "room_id":   data.get("room_id"),
        },
        room=f"user_{target_id}",
    )


@socketio.on("webrtc_answer")
@_authenticated_only
def on_webrtc_answer(data: dict):
    """
    Relay an SDP answer from the callee back to the caller.

    Payload: { target_user_id: int, room_id: str, answer: RTCSessionDescription }
    """
    target_id = data.get("target_user_id")
    emit(
        "webrtc_answer",
        {
            "answer":      data.get("answer"),
            "answerer_id": current_user.id,
            "room_id":     data.get("room_id"),
        },
        room=f"user_{target_id}",
    )


@socketio.on("ice_candidate")
@_authenticated_only
def on_ice_candidate(data: dict):
    """
    Relay an ICE candidate between peers.

    Payload: { target_user_id: int, room_id: str, candidate: RTCIceCandidate }
    """
    target_id = data.get("target_user_id")
    emit(
        "ice_candidate",
        {
            "candidate": data.get("candidate"),
            "sender_id": current_user.id,
            "room_id":   data.get("room_id"),
        },
        room=f"user_{target_id}",
    )


# ===========================================================================
# Internal helpers
# ===========================================================================

def force_end_call_room(room_id: str, reason: str = "policy_violation", ender_name: str = "System") -> None:
    """Force-end an active call room (e.g. moderation policy) and notify both peers."""
    info = _active_calls.pop(room_id, None)
    _room_peers_ready.pop(room_id, None)
    if not info:
        return

    caller_id = info.get("caller_id")
    callee_id = info.get("callee_id")

    payload = {"ender_name": ender_name, "reason": reason}
    if caller_id:
        socketio.emit("call_ended", payload, room=f"user_{caller_id}")
    if callee_id:
        socketio.emit("call_ended", payload, room=f"user_{callee_id}")

    _close_call_log(info, "completed")

def _close_call_log(info: dict, status: str) -> None:
    """Finalise a CallLog entry when a call ends."""
    log = db.session.get(CallLog, info.get("log_id"))
    if log and log.ended_at is None:
        now        = datetime.utcnow()
        log.status = status
        log.ended_at  = now
        started       = info.get("started_at") or now
        log.duration_s = max(0, int((now - started).total_seconds()))
        db.session.commit()
