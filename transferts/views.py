"""Interface et points d'entrée locaux de l'application Transferts CT.

Trois routes seulement (voir transferts/urls.py) :
    index   la page unique, tout le reste est fait par le JavaScript ;
    rpc     POST /api/rpc/<nom> : un sous-ensemble fermé de fonctions métier ;
    photo   GET/POST /api/photos/<chemin> : stockage des photos JPEG.
"""
import json
import re
from urllib.parse import quote

from django.core.cache import cache
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.http import FileResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .services import RPC_FUNCTIONS, TctError, session_for

# Photos : chemin restreint, JPEG de 1 Mo maximum, 20 envois par minute et par session.
SAFE_OBJECT_PATH = re.compile(r"^[A-Za-z0-9_./-]+$")
MAX_PHOTO_BYTES = 1_048_576
PHOTO_UPLOADS_PER_MINUTE = 20
PHOTO_RATE_WINDOW = 60


def index(request):
    """Sert la page unique ; la session et les données sont gérées côté navigateur."""
    return render(request, "transferts/index.html")


@csrf_exempt
@require_http_methods(["POST"])
def rpc(request, function_name):
    """Expose seulement les opérations métier reprises des fonctions SQL."""
    operation = RPC_FUNCTIONS.get(function_name)
    if operation is None:
        return JsonResponse({"message": "Fonction indisponible"}, status=404)
    try:
        arguments = json.loads(request.body or b"{}")
        if not isinstance(arguments, dict):
            return JsonResponse({"message": "Arguments invalides"}, status=400)
        result = operation(arguments)
        return JsonResponse(result, safe=not isinstance(result, (list, type(None))))
    except json.JSONDecodeError:
        return JsonResponse({"message": "JSON invalide"}, status=400)
    except TctError as exc:
        return JsonResponse({"message": str(exc)}, status=400)
    except (TypeError, ValueError, KeyError):
        return JsonResponse({"message": "Arguments invalides"}, status=400)


def _photo_session(request):
    """Jeton de session fourni en en-tête (envoi) ou en paramètre (affichage)."""
    token = request.headers.get("X-Tct-Token") or request.GET.get("token") or ""
    if not token:
        raise TctError("session_requise")
    return session_for(token)


def _rate_limited(key, limit, window=PHOTO_RATE_WINDOW):
    """Compteur glissant simple appuyé sur le cache Django local."""
    if cache.add(key, 1, window):
        return False
    try:
        count = cache.incr(key)
    except ValueError:
        cache.set(key, 1, window)
        return False
    return count > limit


@csrf_exempt
@require_http_methods(["GET", "POST"])
def photo(request, object_path):
    """Stockage de photos local, limité comme le bucket historique (JPEG, 1 Mo)."""
    try:
        session = _photo_session(request)
    except TctError as exc:
        return JsonResponse({"message": str(exc)}, status=401)
    if not SAFE_OBJECT_PATH.fullmatch(object_path) or ".." in object_path.split("/"):
        return JsonResponse({"message": "Chemin de photo invalide"}, status=400)
    storage_path = f"tct-photos/{object_path}"
    if request.method == "POST":
        if _rate_limited(f"tct-photo-upload:{session.token}", PHOTO_UPLOADS_PER_MINUTE):
            response = JsonResponse({"message": "trop_de_photos"}, status=429)
            response["Retry-After"] = str(PHOTO_RATE_WINDOW)
            return response
        if request.content_type != "image/jpeg" or len(request.body) > MAX_PHOTO_BYTES:
            return JsonResponse({"message": "Photo JPEG invalide ou supérieure à 1 Mo"}, status=400)
        try:
            saved_path = default_storage.save(storage_path, ContentFile(request.body))
        except OSError:
            return JsonResponse({"message": "Enregistrement photo impossible"}, status=500)
        public_path = saved_path.removeprefix("tct-photos/")
        return JsonResponse({"url": "/api/photos/" + quote(public_path, safe="/_-.")}, status=201)
    if not default_storage.exists(storage_path):
        return JsonResponse({"message": "Photo introuvable"}, status=404)
    return FileResponse(default_storage.open(storage_path, "rb"), content_type="image/jpeg")
