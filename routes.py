"""
routes.py - HTTP route handlers for UMentor.

Blueprints
----------
auth_bp  /register*, /login, /logout
main_bp  /, /call/<id>, /subjects, /api/*
"""

import re
from datetime import datetime

from flask import (
    Blueprint,
    abort,
    current_app,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
)
from flask_login import current_user, login_required, login_user, logout_user

from models import CallLog, PendingRegistration, User, ROLE_PARENT, ROLE_KID, db

# ---------------------------------------------------------------------------
# Blueprints
# ---------------------------------------------------------------------------
auth_bp = Blueprint("auth", __name__)
main_bp = Blueprint("main", __name__)


# ===========================================================================
# Input validators
# ===========================================================================

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,80}$")
_EMAIL_RE    = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


def _validate_username(value: str) -> tuple[bool, str]:
    if not value or not _USERNAME_RE.match(value):
        return False, "Username must be 3–80 characters (letters, numbers, underscores)."
    return True, ""


def _validate_email(value: str) -> tuple[bool, str]:
    if not value or not _EMAIL_RE.match(value):
        return False, "Please enter a valid email address."
    return True, ""


def _validate_password(value: str) -> tuple[bool, str]:
    if not value or len(value) < 8:
        return False, "Password must be at least 8 characters long."
    if not re.search(r"[A-Z]", value):
        return False, "Password must contain at least one uppercase letter."
    if not re.search(r"[0-9]", value):
        return False, "Password must contain at least one digit."
    if not re.search(r"[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>\/?]", value):
        return False, "Password must contain at least one special character."
    return True, ""


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _valid_email(value: str) -> bool:
    return bool(_EMAIL_RE.match(value))


# ===========================================================================
# Email helper
# ===========================================================================

def _send_email(to: str, subject: str, body: str) -> bool:
    """
    Send an email via Flask-Mail.

    In development (MAIL_USERNAME not set), prints the email to the console
    and returns False so callers can show the link in a flash message instead.
    """
    username = current_app.config.get("MAIL_USERNAME")
    if not username:
        # Dev fallback: print token to console
        print(f"\n{'='*60}\n[DEV EMAIL]\nTo:      {to}\nSubject: {subject}\n\n{body}\n{'='*60}\n")
        return False

    try:
        from flask_mail import Message
        mail_ext = current_app.extensions.get("mail")
        if mail_ext is None:
            return False
        msg = Message(subject=subject, recipients=[to], body=body)
        mail_ext.send(msg)
        return True
    except Exception as exc:
        current_app.logger.error("Email send failed: %s", exc)
        return False


# ===========================================================================
# Auth routes
# ===========================================================================

@auth_bp.route("/register")
def register():
    """Landing page: choose Parent or Kid registration."""
    if current_user.is_authenticated:
        return redirect(url_for("main.dashboard"))
    return render_template("register_choose.html")


# ---------------------------------------------------------------------------
# Parent registration
# ---------------------------------------------------------------------------

@auth_bp.route("/register/parent", methods=["GET", "POST"])
def register_parent():
    """Standard account creation for a parent/guardian."""
    if current_user.is_authenticated:
        return redirect(url_for("main.dashboard"))

    if request.method == "POST":
        username         = request.form.get("username", "").strip()
        email            = request.form.get("email",    "").strip().lower()
        password         = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")

        errors = []

        ok, msg = _validate_username(username)
        if not ok:
            errors.append(msg)

        ok, msg = _validate_email(email)
        if not ok:
            errors.append(msg)

        ok, msg = _validate_password(password)
        if not ok:
            errors.append(msg)

        if password != confirm_password:
            errors.append("Passwords do not match.")

        if User.query.filter_by(username=username).first():
            errors.append("That username is already taken.")

        if User.query.filter_by(email=email).first():
            errors.append("That email address is already registered.")

        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("register_parent.html", username=username, email=email)

        user = User(username=username, email=email, role=ROLE_PARENT)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        login_user(user, remember=True)
        flash("Welcome to UMentor! Your parent account is ready.", "success")
        return redirect(url_for("main.dashboard"))

    return render_template("register_parent.html")


# ---------------------------------------------------------------------------
# Kid registration  (step 1 of 3)
# ---------------------------------------------------------------------------

@auth_bp.route("/register/kid", methods=["GET", "POST"])
def register_kid():
    """Kid fills in their name, email, and parent's email."""
    if current_user.is_authenticated:
        return redirect(url_for("main.dashboard"))

    if request.method == "POST":
        kid_name     = request.form.get("kid_name",     "").strip()
        kid_email    = request.form.get("kid_email",    "").strip().lower()
        parent_email = request.form.get("parent_email", "").strip().lower()

        errors = []

        if not kid_name or len(kid_name) < 2:
            errors.append("Please enter your first name (at least 2 characters).")

        ok, msg = _validate_email(kid_email)
        if not ok:
            errors.append("Kid email: " + msg)

        ok, msg = _validate_email(parent_email)
        if not ok:
            errors.append("Parent email: " + msg)

        if kid_email == parent_email:
            errors.append("Your email and your parent's email must be different.")

        if User.query.filter_by(email=kid_email).first():
            errors.append("That email address is already registered.")

        # Check if there is already a pending request for this kid email
        existing = PendingRegistration.query.filter_by(kid_email=kid_email).first()
        if existing and not existing.is_expired:
            errors.append(
                "A registration request for that email is already pending. "
                "Ask your parent to check their inbox."
            )

        if errors:
            for e in errors:
                flash(e, "error")
            return render_template(
                "register_kid.html",
                kid_name=kid_name,
                kid_email=kid_email,
                parent_email=parent_email,
            )

        # Remove any expired previous attempts for this email
        PendingRegistration.query.filter_by(kid_email=kid_email).delete()

        pending = PendingRegistration.create_for_kid(kid_name, kid_email, parent_email)
        db.session.add(pending)
        db.session.commit()

        # Build approval URL and email body
        approve_url = url_for(
            "auth.parent_approve",
            token=pending.parent_token,
            _external=True,
        )
        email_body = (
            f"Hi,\n\nYour child {kid_name} ({kid_email}) wants to join UMentor — "
            f"a peer tutoring platform for students.\n\n"
            f"Click the link below to review and approve their account:\n\n"
            f"  {approve_url}\n\n"
            f"This link expires in 48 hours.\n\n"
            f"If you did not expect this email, you can safely ignore it.\n\n"
            f"— The UMentor Team"
        )

        sent = _send_email(
            to=parent_email,
            subject=f"UMentor: Approve {kid_name}'s account",
            body=email_body,
        )

        if not sent:
            # Dev mode: show the link directly so testers can proceed
            flash(
                f"[Dev mode — email not sent] Parent approval link: {approve_url}",
                "warning",
            )

        return redirect(url_for("auth.register_pending", kid_name=kid_name))

    return render_template("register_kid.html")


@auth_bp.route("/register/pending")
def register_pending():
    """Confirmation page shown to the kid after they submit step 1."""
    kid_name = request.args.get("kid_name", "")
    return render_template("register_pending.html", kid_name=kid_name)


# ---------------------------------------------------------------------------
# Parent approval  (step 2 of 3)
# ---------------------------------------------------------------------------

@auth_bp.route("/register/parent-approve/<token>", methods=["GET", "POST"])
def parent_approve(token: str):
    """Parent visits this page to approve their child's account."""
    pending = PendingRegistration.query.filter_by(parent_token=token).first()

    if pending is None:
        flash("This approval link is invalid.", "error")
        return redirect(url_for("auth.register"))

    if pending.is_expired:
        flash("This approval link has expired. Ask your child to register again.", "error")
        db.session.delete(pending)
        db.session.commit()
        return redirect(url_for("auth.register"))

    if pending.parent_approved:
        flash(
            f"You already approved {pending.kid_name}'s account. "
            "They should have received a setup email.",
            "info",
        )
        return redirect(url_for("auth.register"))

    if request.method == "POST":
        pending.approve_by_parent()
        db.session.commit()

        setup_url = url_for(
            "auth.kid_setup",
            token=pending.kid_token,
            _external=True,
        )
        email_body = (
            f"Hi {pending.kid_name},\n\n"
            f"Great news! Your parent has approved your UMentor account.\n\n"
            f"Click the link below to choose your username and set a password:\n\n"
            f"  {setup_url}\n\n"
            f"This link expires in 72 hours.\n\n"
            f"— The UMentor Team"
        )

        sent = _send_email(
            to=pending.kid_email,
            subject="UMentor: Set up your account",
            body=email_body,
        )

        if not sent:
            flash(
                f"[Dev mode — email not sent] Kid setup link: {setup_url}",
                "warning",
            )

        flash(
            f"You approved {pending.kid_name}'s account! "
            "They will receive an email to complete their setup.",
            "success",
        )
        return render_template("register_parent_approved.html", pending=pending)

    return render_template("register_parent_approve.html", pending=pending)


# ---------------------------------------------------------------------------
# Kid account setup  (step 3 of 3)
# ---------------------------------------------------------------------------

@auth_bp.route("/register/kid-setup/<token>", methods=["GET", "POST"])
def kid_setup(token: str):
    """Kid sets their username and password after parent approves."""
    pending = PendingRegistration.query.filter_by(kid_token=token).first()

    if pending is None or not pending.parent_approved:
        flash("This setup link is invalid or parent approval is still pending.", "error")
        return redirect(url_for("auth.register"))

    if pending.is_expired:
        flash("This setup link has expired. Ask your parent to re-approve.", "error")
        db.session.delete(pending)
        db.session.commit()
        return redirect(url_for("auth.register"))

    if request.method == "POST":
        username         = request.form.get("username", "").strip()
        password         = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")

        errors = []

        ok, msg = _validate_username(username)
        if not ok:
            errors.append(msg)

        ok, msg = _validate_password(password)
        if not ok:
            errors.append(msg)

        if password != confirm_password:
            errors.append("Passwords do not match.")

        if User.query.filter_by(username=username).first():
            errors.append("That username is already taken. Try another.")

        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("register_kid_setup.html", username=username, pending=pending)

        # Find parent user by email (link if they have an account)
        parent_user = User.query.filter_by(email=pending.parent_email).first()

        kid_user = User(
            username       = username,
            email          = pending.kid_email,
            role           = ROLE_KID,
            account_active = True,
            parent_id      = parent_user.id if parent_user else None,
        )
        kid_user.set_password(password)
        db.session.add(kid_user)
        db.session.delete(pending)
        db.session.commit()

        login_user(kid_user, remember=True)
        flash(f"Welcome to UMentor, {username}! Your account is all set. 🎉", "success")
        return redirect(url_for("main.dashboard"))

    return render_template("register_kid_setup.html", pending=pending)


# ---------------------------------------------------------------------------
# Login / Logout
# ---------------------------------------------------------------------------

@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("main.dashboard"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        if not username or not password:
            flash("Please enter your username and password.", "error")
            return render_template("login.html")

        user = User.query.filter_by(username=username).first()

        if user is None or not user.check_password(password):
            flash("Invalid username or password.", "error")
            return render_template("login.html")

        if not user.account_active:
            flash("Your account is currently inactive. Please contact support.", "error")
            return render_template("login.html")

        user.is_online = True
        user.last_seen = datetime.utcnow()
        db.session.commit()

        login_user(user, remember=True)

        next_page = request.args.get("next")
        if next_page and not next_page.startswith("/"):
            next_page = None
        return redirect(next_page or url_for("main.dashboard"))

    return render_template("login.html")


@auth_bp.route("/logout")
@login_required
def logout():
    current_user.is_online = False
    current_user.last_seen = datetime.utcnow()
    db.session.commit()
    logout_user()
    flash("You have been signed out.", "info")
    return redirect(url_for("auth.login"))


# ===========================================================================
# Main application routes
# ===========================================================================

@main_bp.route("/")
@login_required
def dashboard():
    users = User.query.filter(User.id != current_user.id).order_by(
        User.is_online.desc(), User.username.asc()
    ).all()
    return render_template("dashboard.html", users=users)


@main_bp.route("/subjects")
@login_required
def subjects():
    """Browse school subjects and find tutors."""
    return render_template("subjects.html")


@main_bp.route("/call/<int:user_id>")
@login_required
def call_page(user_id: int):
    if user_id == current_user.id:
        abort(400, "You cannot call yourself.")

    other_user = User.query.get_or_404(user_id)

    if not other_user.is_online:
        flash(f"{other_user.username} is currently offline.", "warning")
        return redirect(url_for("main.dashboard"))

    return render_template("call.html", other_user=other_user)


# ---------------------------------------------------------------------------
# JSON API
# ---------------------------------------------------------------------------

@main_bp.route("/api/users")
@login_required
def api_users():
    users = User.query.filter(User.id != current_user.id).all()
    return jsonify([u.to_dict() for u in users])


@main_bp.route("/api/call-history")
@login_required
def api_call_history():
    logs = (
        CallLog.query
        .filter(
            (CallLog.caller_id == current_user.id) |
            (CallLog.callee_id == current_user.id)
        )
        .order_by(CallLog.started_at.desc())
        .limit(50)
        .all()
    )
    return jsonify([log.to_dict() for log in logs])


@main_bp.route("/api/save-transcript", methods=["POST"])
@login_required
def save_transcript():
    import os
    data    = request.get_json(silent=True) or {}
    text    = data.get("text", "").strip()
    room_id = data.get("room_id", "unknown")
    if not text:
        return jsonify({"ok": False, "error": "empty"}), 400

    transcript_dir = os.path.join(current_app.root_path, "transcripts")
    os.makedirs(transcript_dir, exist_ok=True)

    ts       = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"call_{room_id}_{ts}.txt"
    filepath = os.path.join(transcript_dir, filename)

    with open(filepath, "w", encoding="utf-8") as fh:
        fh.write(text)

    current_app.logger.info("Transcript saved: %s", filename)
    return jsonify({"ok": True, "filename": filename})


@main_bp.route("/api/gemini-chat", methods=["POST"])
@login_required
def gemini_chat():
    import os
    try:
        from google import genai
    except ImportError:
        return jsonify({"error": "google-genai not installed — run: pip install google-genai"}), 503

    data       = request.get_json(silent=True) or {}
    message    = data.get("message", "").strip()
    transcript = data.get("transcript", "").strip()

    if not message:
        return jsonify({"error": "empty message"}), 400

    api_key = os.environ.get("GOOGLE_API_KEY") or current_app.config.get("GOOGLE_API_KEY")
    if not api_key:
        return jsonify({"error": "GOOGLE_API_KEY not set in .env"}), 503

    client = genai.Client(api_key=api_key)

    prompt = (
        f"You are a helpful AI tutoring assistant embedded in UMentor, a peer-tutoring video call platform. "
        f"You are observing a live call between {current_user.username} and their peer. "
        f"Be concise and friendly. Answer in plain text (no markdown).\n\n"
        f"Live call transcript so far:\n{transcript or '(no speech captured yet)'}\n\n"
        f"The user asks: {message}"
    )

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash-lite",
            contents=prompt,
        )
        return jsonify({"reply": response.text})
    except Exception as exc:
        current_app.logger.error("Gemini error: %s", exc)
        return jsonify({"error": str(exc)}), 500


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@main_bp.route("/settings")
@login_required
def settings():
    children = (
        User.query.filter_by(parent_id=current_user.id).all()
        if current_user.role == ROLE_PARENT else []
    )
    pending_invites = (
        PendingRegistration.query
        .filter_by(invited_by_user_id=current_user.id)
        .order_by(PendingRegistration.created_at.desc())
        .all()
        if current_user.role == ROLE_PARENT else []
    )
    parent = (
        User.query.get(current_user.parent_id)
        if current_user.role == ROLE_KID and current_user.parent_id else None
    )
    return render_template(
        "settings.html",
        children=children,
        pending_invites=pending_invites,
        parent=parent,
    )


@main_bp.route("/settings/invite-child", methods=["POST"])
@login_required
def invite_child():
    if current_user.role != ROLE_PARENT:
        abort(403)

    kid_name  = request.form.get("kid_name",  "").strip()
    kid_email = request.form.get("kid_email", "").strip().lower()

    # Basic validation
    if not kid_name or not kid_email:
        flash("Please fill in both the child's name and email.", "warning")
        return redirect(url_for("main.settings"))

    if not _valid_email(kid_email):
        flash("That doesn't look like a valid email address.", "warning")
        return redirect(url_for("main.settings"))

    # Duplicate checks
    if User.query.filter_by(email=kid_email).first():
        flash("An account with that email already exists.", "warning")
        return redirect(url_for("main.settings"))

    existing = PendingRegistration.query.filter_by(kid_email=kid_email, parent_approved=True).first()
    if existing and not existing.is_expired:
        flash("An active invitation for that email already exists.", "warning")
        return redirect(url_for("main.settings"))

    # Create the invite
    pending = PendingRegistration.create_by_parent(current_user, kid_name, kid_email)
    db.session.add(pending)
    db.session.commit()

    setup_url = url_for("auth.kid_setup", token=pending.kid_token, _external=True)
    body = (
        f"Hi {kid_name},\n\n"
        f"{current_user.username} has invited you to join UMentor!\n\n"
        f"Click the link below to set up your account (valid for 48 hours):\n"
        f"{setup_url}\n\n"
        f"— The UMentor Team"
    )
    sent = _send_email(kid_email, "You've been invited to UMentor!", body)

    if sent:
        flash(f"Invitation sent to {kid_email}.", "success")
    else:
        flash(
            f"Email delivery is not configured. Share this link manually: {setup_url}",
            "info",
        )

    return redirect(url_for("main.settings"))
