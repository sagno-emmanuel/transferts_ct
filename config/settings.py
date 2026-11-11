"""Configuration Django du projet Transferts CT (base SQLite locale)."""
import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DEBUG = os.environ.get("DJANGO_DEBUG", "false").lower() == "true"

# Hors développement, l'application refuse de démarrer sans clé explicite :
# une clé connue rendrait les sessions et signatures falsifiables.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "").strip()
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured(
            "DJANGO_SECRET_KEY est obligatoire lorsque DJANGO_DEBUG n'est pas activé."
        )
    SECRET_KEY = "dev-only-change-this-key"

ALLOWED_HOSTS = [h.strip() for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()]
ROOT_URLCONF = "config.urls"
INSTALLED_APPS = ["django.contrib.staticfiles", "transferts"]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
X_FRAME_OPTIONS = "DENY"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [BASE_DIR / "templates"],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": []},
}]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"
# Toutes les données métier résident maintenant dans la base locale Django.
# `timeout` évite les erreurs "database is locked" quand plusieurs postes
# synchronisent en même temps.
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
        "OPTIONS": {"timeout": 20},
    }
}
STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static", BASE_DIR / "logo"]
# Cible de `collectstatic` en production (déjà ignorée par git).
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
MEDIA_ROOT = BASE_DIR / "media"
MEDIA_URL = "/media/"
LANGUAGE_CODE = "fr-fr"
TIME_ZONE = "Africa/Porto-Novo"
USE_I18N = True
USE_TZ = True
if not DEBUG:
    SECURE_CONTENT_TYPE_NOSNIFF = True
