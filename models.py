"""
models.py - SQLAlchemy ORM models for UMentor.

Tables
------
users                  Registered parent/kid accounts.
call_logs              Record of every call (start, end, duration, status).
pending_registrations  Temporary table for kids awaiting parent approval.
"""

import secrets
from datetime import datetime, timedelta

import bcrypt
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin

# -------------------------------------------------------------------
# Shared db instance – initialised in app.py via db.init_app(app)
# -------------------------------------------------------------------
db = SQLAlchemy()

# ---------------------------------------------------------------------------
# Role constants
# ---------------------------------------------------------------------------
ROLE_PARENT = "parent"
ROLE_KID    = "kid"


class User(UserMixin, db.Model):
    """
    Registered account — either a parent or a kid tutor.

    Columns
    -------
    role           'parent' | 'kid'
    account_active False disables login (Flask-Login checks is_active).
    parent_id      FK → the parent User who approved this kid account (nullable).
    """

    __tablename__ = "users"

    id             = db.Column(db.Integer,     primary_key=True)
    username       = db.Column(db.String(80),  unique=True, nullable=False, index=True)
    email          = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash  = db.Column(db.String(255), nullable=False)
    role           = db.Column(db.String(10),  nullable=False, default=ROLE_PARENT)
    account_active = db.Column(db.Boolean,     nullable=False, default=True)
    parent_id      = db.Column(db.Integer,     db.ForeignKey("users.id"), nullable=True)
    is_online      = db.Column(db.Boolean,     nullable=False, default=False)
    last_seen      = db.Column(db.DateTime,    nullable=True,  default=datetime.utcnow)
    created_at     = db.Column(db.DateTime,    nullable=False, default=datetime.utcnow)

    # Parent ↔ children relationship
    children = db.relationship(
        "User",
        backref=db.backref("parent_user", remote_side="User.id"),
        foreign_keys=[parent_id],
    )

    # ------------------------------------------------------------------
    # Flask-Login integration
    # ------------------------------------------------------------------
    @property
    def is_active(self) -> bool:  # type: ignore[override]
        """Flask-Login uses this; False prevents login."""
        return self.account_active

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------
    @property
    def is_parent(self) -> bool:
        return self.role == ROLE_PARENT

    @property
    def is_kid(self) -> bool:
        return self.role == ROLE_KID

    # ------------------------------------------------------------------
    # Password helpers
    # ------------------------------------------------------------------
    def set_password(self, plain_text: str) -> None:
        salt   = bcrypt.gensalt(rounds=12)
        hashed = bcrypt.hashpw(plain_text.encode("utf-8"), salt)
        self.password_hash = hashed.decode("utf-8")

    def check_password(self, plain_text: str) -> bool:
        return bcrypt.checkpw(
            plain_text.encode("utf-8"),
            self.password_hash.encode("utf-8"),
        )

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "id":        self.id,
            "username":  self.username,
            "role":      self.role,
            "is_online": self.is_online,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
        }

    def __repr__(self) -> str:
        return f"<User id={self.id} username={self.username!r} role={self.role}>"


class CallLog(db.Model):
    """One row per call attempt."""

    __tablename__ = "call_logs"

    id          = db.Column(db.Integer,    primary_key=True)
    caller_id   = db.Column(db.Integer,    db.ForeignKey("users.id"), nullable=False, index=True)
    callee_id   = db.Column(db.Integer,    db.ForeignKey("users.id"), nullable=False, index=True)
    status      = db.Column(db.String(20), nullable=False, default="missed")
    started_at  = db.Column(db.DateTime,   nullable=False, default=datetime.utcnow)
    ended_at    = db.Column(db.DateTime,   nullable=True)
    duration_s  = db.Column(db.Integer,    nullable=True)

    caller = db.relationship("User", foreign_keys=[caller_id], backref="outgoing_calls")
    callee = db.relationship("User", foreign_keys=[callee_id], backref="incoming_calls")

    def to_dict(self) -> dict:
        return {
            "id":         self.id,
            "caller_id":  self.caller_id,
            "callee_id":  self.callee_id,
            "status":     self.status,
            "started_at": self.started_at.isoformat(),
            "ended_at":   self.ended_at.isoformat() if self.ended_at else None,
            "duration_s": self.duration_s,
        }

    def __repr__(self) -> str:
        return f"<CallLog id={self.id} caller={self.caller_id} callee={self.callee_id}>"


# ---------------------------------------------------------------------------
# Pending kid registration
# ---------------------------------------------------------------------------

PARENT_TOKEN_EXPIRY_HOURS = 48
KID_TOKEN_EXPIRY_HOURS    = 72


class PendingRegistration(db.Model):
    """
    Temporary row holding a kid's signup request until parent approves.

    Flow
    ----
    1. Kid submits /register/kid  →  row created, parent_token emailed to parent.
    2. Parent visits /register/parent-approve/<parent_token>
       →  parent_approved=True, kid_token generated, emailed to kid.
    3. Kid visits /register/kid-setup/<kid_token>
       →  User row created, this row deleted.

    OR (parent-initiated flow):
    1. Logged-in parent visits /settings → fills in child name + email.
    2. System creates row with parent_approved=True, kid_token sent directly to kid.
    3. Kid visits /register/kid-setup/<kid_token> → sets username + password.
    """

    __tablename__ = "pending_registrations"

    id                  = db.Column(db.Integer,     primary_key=True)
    kid_name            = db.Column(db.String(80),  nullable=False)
    kid_email           = db.Column(db.String(120), nullable=False, index=True)
    parent_email        = db.Column(db.String(120), nullable=False)
    # FK to the parent User who initiated this invite (null for kid-initiated flow)
    invited_by_user_id  = db.Column(db.Integer,     db.ForeignKey("users.id"), nullable=True)
    parent_token        = db.Column(db.String(80),  unique=True, nullable=True,  index=True)
    kid_token           = db.Column(db.String(80),  unique=True, nullable=True,  index=True)
    parent_approved     = db.Column(db.Boolean,     nullable=False, default=False)
    created_at          = db.Column(db.DateTime,    nullable=False, default=datetime.utcnow)
    expires_at          = db.Column(db.DateTime,    nullable=False)

    invited_by = db.relationship("User", foreign_keys=[invited_by_user_id], backref="sent_invites")

    @staticmethod
    def generate_token() -> str:
        return secrets.token_urlsafe(48)

    @property
    def is_expired(self) -> bool:
        return datetime.utcnow() > self.expires_at

    @classmethod
    def create_for_kid(cls, kid_name: str, kid_email: str, parent_email: str) -> "PendingRegistration":
        """Kid-initiated: awaits parent approval via email."""
        return cls(
            kid_name     = kid_name,
            kid_email    = kid_email.lower(),
            parent_email = parent_email.lower(),
            parent_token = cls.generate_token(),
            expires_at   = datetime.utcnow() + timedelta(hours=PARENT_TOKEN_EXPIRY_HOURS),
        )

    @classmethod
    def create_by_parent(cls, parent_user: "User", kid_name: str, kid_email: str) -> "PendingRegistration":
        """Parent-initiated: already approved, kid_token sent straight to kid."""
        return cls(
            kid_name           = kid_name,
            kid_email          = kid_email.lower(),
            parent_email       = parent_user.email,
            invited_by_user_id = parent_user.id,
            kid_token          = cls.generate_token(),
            parent_approved    = True,
            expires_at         = datetime.utcnow() + timedelta(hours=KID_TOKEN_EXPIRY_HOURS),
        )

    def approve_by_parent(self) -> None:
        """Mark approved, generate kid's setup token. Caller must commit."""
        self.parent_approved = True
        self.kid_token       = self.generate_token()
        self.expires_at      = datetime.utcnow() + timedelta(hours=KID_TOKEN_EXPIRY_HOURS)

    def __repr__(self) -> str:
        return f"<PendingRegistration kid_email={self.kid_email!r} approved={self.parent_approved}>"
