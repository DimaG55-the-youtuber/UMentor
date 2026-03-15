"""
config.py - Application configuration settings.

Contains configuration classes for different environments (development, production).
Sensitive values should be set via environment variables in production.
"""

import os
from datetime import timedelta


class Config:
    """Base configuration with secure defaults."""

    # Secret key for session signing – MUST be overridden in production via env var
    SECRET_KEY = os.environ.get("SECRET_KEY") or "change-me-in-production-use-random-32-bytes"

    # ---------------------------------------------------------------------------
    # Database
    # ---------------------------------------------------------------------------
    # Prefer PostgreSQL in production; fall back to SQLite for development
    SQLALCHEMY_DATABASE_URI = (
        os.environ.get("DATABASE_URL")
        or "sqlite:///videocall.db"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,       # Detect stale connections
        "pool_recycle": 300,          # Recycle connections every 5 minutes
    }

    # ---------------------------------------------------------------------------
    # Session / Cookie security
    # ---------------------------------------------------------------------------
    SESSION_COOKIE_HTTPONLY = True       # Prevent JS access to session cookie
    SESSION_COOKIE_SAMESITE = "Lax"     # CSRF mitigation
    SESSION_COOKIE_SECURE = False        # Set True only with real HTTPS (not needed behind ngrok)
    PERMANENT_SESSION_LIFETIME = timedelta(hours=24)

    # ---------------------------------------------------------------------------
    # Flask-WTF CSRF
    # ---------------------------------------------------------------------------
    WTF_CSRF_ENABLED = True
    WTF_CSRF_TIME_LIMIT = 3600  # 1 hour

    # ---------------------------------------------------------------------------
    # SocketIO
    # ---------------------------------------------------------------------------
    # Allow all origins in development; restrict in production
    SOCKETIO_CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ORIGINS") or "*"

    # ---------------------------------------------------------------------------
    # Transcription backend
    # ---------------------------------------------------------------------------
    # assemblyai (default): managed speech-to-text API
    # gemini: remote model API (uses GOOGLE_API_KEY quota)
    TRANSCRIBE_PROVIDER = os.environ.get("TRANSCRIBE_PROVIDER", "assemblyai")
    ASSEMBLYAI_API_KEY = os.environ.get("ASSEMBLYAI_API_KEY", "")
    ASSEMBLYAI_SPEECH_MODEL = os.environ.get("ASSEMBLYAI_SPEECH_MODEL", "universal-2")
    ASSEMBLYAI_LANGUAGE_CODE = os.environ.get("ASSEMBLYAI_LANGUAGE_CODE", "")
    ASSEMBLYAI_FILTER_PROFANITY = os.environ.get("ASSEMBLYAI_FILTER_PROFANITY", "true").lower() == "true"

    # ---------------------------------------------------------------------------
    # Flask-Mail  (used for parent-approval and kid-setup emails)
    # Set these via environment variables or a .env file.
    # In development without email configured, tokens are shown in flash messages.
    # ---------------------------------------------------------------------------
    MAIL_SERVER   = os.environ.get("MAIL_SERVER",   "smtp.gmail.com")
    MAIL_PORT     = int(os.environ.get("MAIL_PORT",  "587"))
    MAIL_USE_TLS  = os.environ.get("MAIL_USE_TLS",  "true").lower() == "true"
    MAIL_USERNAME = os.environ.get("MAIL_USERNAME")
    MAIL_PASSWORD = os.environ.get("MAIL_PASSWORD")
    MAIL_DEFAULT_SENDER = os.environ.get("MAIL_DEFAULT_SENDER", "noreply@umentor.app")
    # If True, emails are only printed to the console (useful in dev)
    MAIL_SUPPRESS_SEND = os.environ.get("MAIL_SUPPRESS_SEND", "false").lower() == "true"


class DevelopmentConfig(Config):
    """Development-specific overrides."""
    DEBUG = True
    SESSION_COOKIE_SECURE = False


class ProductionConfig(Config):
    """Production-specific overrides."""
    DEBUG = False
    SESSION_COOKIE_SECURE = True
    # Enforce a real secret key in production
    SECRET_KEY = os.environ.get("SECRET_KEY")  # Will be None if not set → app will warn


# Map environment names to config classes
config_by_name = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "default": DevelopmentConfig,
}
