"""
app.py - Application factory and entry point.

Run with:
    python app.py                     # development (eventlet)
    gunicorn -k eventlet -w 1 app:app # production
"""
from dotenv import load_dotenv
load_dotenv()

import os
import warnings

from flask import Flask
from flask_login import LoginManager
from flask_mail import Mail
from flask_wtf.csrf import CSRFProtect
from werkzeug.middleware.proxy_fix import ProxyFix

from config import config_by_name
from models import User, db
from routes import auth_bp, main_bp
from sockets import socketio

# ---------------------------------------------------------------------------
# Extension instances
# ---------------------------------------------------------------------------
csrf = CSRFProtect()
mail = Mail()


def create_app(env_name: str | None = None) -> Flask:
    """
    Application factory.

    Parameters
    ----------
    env_name : str, optional
        One of 'development', 'production', or 'default'.
        Falls back to the FLASK_ENV environment variable, then 'default'.
    """
    if env_name is None:
        env_name = os.environ.get("FLASK_ENV", "default")

    app = Flask(__name__, static_folder="static", template_folder="templates")

    # Trust 1 level of reverse-proxy headers (ngrok / nginx / etc.)
    # This ensures url_for() generates https:// URLs when behind ngrok
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    # -------------------------------------------------------------------
    # Load config
    # -------------------------------------------------------------------
    cfg = config_by_name.get(env_name, config_by_name["default"])
    app.config.from_object(cfg)

    # Warn loudly if running in production without a real SECRET_KEY
    if env_name == "production" and not app.config.get("SECRET_KEY"):
        warnings.warn(
            "SECRET_KEY is not set! Set the SECRET_KEY environment variable "
            "before deploying to production.",
            RuntimeWarning,
            stacklevel=2,
        )

    # -------------------------------------------------------------------
    # Initialise extensions
    # -------------------------------------------------------------------
    db.init_app(app)

    csrf.init_app(app)
    mail.init_app(app)

    # Flask-SocketIO – use eventlet async mode for production-grade performance.
    # manage_session=False lets Flask-Login handle sessions independently of
    # the WebSocket upgrade.
    socketio.init_app(
        app,
        cors_allowed_origins="*",   # allow LAN, ngrok, and any other proxy
        manage_session=False,
        async_mode="eventlet",
        engineio_logger=False,
        logger=False,
    )

    # -------------------------------------------------------------------
    # Flask-Login
    # -------------------------------------------------------------------
    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view        = "auth.login"         # type: ignore[assignment]
    login_manager.login_message     = "Please sign in to continue."
    login_manager.login_message_category = "warning"

    @login_manager.user_loader
    def load_user(user_id: str) -> User | None:  # noqa: D401
        """Load user from DB by primary key (called by Flask-Login on each request)."""
        return db.session.get(User, int(user_id))

    # -------------------------------------------------------------------
    # Register blueprints
    # -------------------------------------------------------------------
    app.register_blueprint(auth_bp)
    app.register_blueprint(main_bp)

    # -------------------------------------------------------------------
    # Create database tables (idempotent)
    # -------------------------------------------------------------------
    with app.app_context():
        db.create_all()

    return app


# ---------------------------------------------------------------------------
# Module-level app instance for Gunicorn / WSGI servers
# ---------------------------------------------------------------------------
app = create_app()


if __name__ == "__main__":
    # Development server via eventlet
    port = int(os.environ.get("PORT", 5000))
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=True,
        use_reloader=False,        # reloader conflicts with eventlet — leave off
        allow_unsafe_werkzeug=True, # required by newer Flask-SocketIO in dev mode
    )
