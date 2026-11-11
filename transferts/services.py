"""Port Django des fonctions SQL tct_* ; mêmes rôles, filtres et payloads.

Ce module porte toute la logique métier côté serveur, appelée par la vue
`transferts.views.rpc` sous le nom de fonction RPC (voir RPC_FUNCTIONS).
Les erreurs métier sont levées en TctError et renvoyées en JSON au client.

Fonctions disponibles :
    tct_connect      ouvre une session à partir d'un code (4 à 8 chiffres) ;
    tct_session_set  précise site ou mode pointeur après la connexion ;
    tct_logout       invalide la session ;
    tct_pull         renvoie le journal de synchronisation depuis un seq ;
    tct_push         enregistre les modifications locales du client ;
    tct_set_code     remplace un code d'accès (réservé au donneur d'ordre).
"""
from datetime import timedelta
import re
import time

import bcrypt
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .models import TctCode, TctLoginFail, TctRecord, TctSession

SESSION_LIFETIME = timedelta(days=30)
ROLES = {"ct", "agent", "hse", "site", "presta", "pointeur"}
CODE_ROLES = {"ct", "agent", "hse", "site", "presta"}


class TctError(Exception):
    """Erreur métier renvoyée comme message JSON par l'ancienne API RPC."""


def _session(token):
    """Session active correspondant au jeton, ou TctError('session_expiree')."""
    try:
        session = TctSession.objects.get(token=token, expires_at__gt=timezone.now())
    except (TctSession.DoesNotExist, ValueError, TypeError, ValidationError):
        raise TctError("session_expiree") from None
    return session


def session_for(p_token):
    """Session active correspondant au jeton, ou TctError('session_expiree')."""
    return _session(p_token)


def _code_entity(role, entity):
    """Entité qui porte un code d'accès : seulement les prestataires en ont une."""
    return (entity or "") if role == "presta" else ""


def tct_connect(p_code, p_operateur):
    """
    Ouvre une session en comparant le code à chaque empreinte bcrypt connue.

    Protections : nom d'opérateur obligatoire, 30 échecs maximum sur 10 minutes,
    une seconde de délai sur code erroné. Un code peut être partagé par
    plusieurs personnes : le rôle et l'entité viennent du code trouvé.
    """
    operator = (p_operateur or "").strip()
    if not operator:
        raise TctError("nom_requis")
    now = timezone.now()
    if TctLoginFail.objects.filter(ts__gt=now - timedelta(minutes=10)).count() >= 30:
        raise TctError("trop_de_tentatives")
    matched = None
    for candidate in TctCode.objects.all().order_by("role", "entity"):
        try:
            if bcrypt.checkpw((p_code or "").encode("utf-8"), candidate.code_hash.encode("ascii")):
                matched = candidate
                break
        except (ValueError, TypeError):
            continue
    if matched is None:
        TctLoginFail.objects.create()
        TctLoginFail.objects.filter(ts__lt=now - timedelta(days=1)).delete()
        time.sleep(1)  # même frein que la fonction SQL sur code erroné
        raise TctError("code_incorrect")
    TctSession.objects.filter(expires_at__lt=now).delete()
    role, entity = matched.role, matched.entity or None
    session = TctSession.objects.create(
        role=role, entity=entity, operateur=operator[:60],
        expires_at=now + SESSION_LIFETIME,
    )
    return {"token": str(session.token), "role": role, "entity": entity,
            "site": None, "operateur": operator}


def tct_session_set(p_token, p_role, p_entity, p_site):
    """
    Complète la session après la connexion.

    Cas autorisés : un agent choisit son site (CT ou PSK), un chef de site son
    site (PSK, BU, KI), un prestataire reste sur sa société, et un prestataire
    peut passer en mode « pointeur » sur un site donné. Toute autre combinaison
    est refusée (non_autorise).
    """
    session = _session(p_token)
    entity, site = p_entity or "", p_site or ""
    if session.role == "agent" and p_role == "agent" and entity in ("CT", "PSK"):
        session.entity = entity
    elif session.role == "site" and p_role == "site" and entity in ("PSK", "BU", "KI"):
        session.entity = entity
    elif session.role == "presta" and p_role == "presta" and entity == session.entity:
        pass
    elif session.role == "presta" and p_role == "pointeur" and entity == session.entity and site:
        session.role = "pointeur"
        session.site = site[:60]
    else:
        raise TctError("non_autorise")
    session.save(update_fields=("role", "entity", "site"))
    return {"token": str(session.token), "role": session.role, "entity": session.entity,
            "site": session.site, "operateur": session.operateur}


def tct_logout(p_token):
    """Supprime la session ; un jeton invalide est simplement ignoré."""
    try:
        TctSession.objects.filter(token=p_token).delete()
    except (ValueError, TypeError, ValidationError):
        pass
    return None


def tct_pull(p_token, p_since, p_limit=300):
    """
    Journal de synchronisation postérieur à `p_since`, dans l'ordre des seq.

    Le périmètre dépend du rôle : le CT voit tout (sauf les réglages des
    autres), l'agent et le HSE voient tout le terrain, le chef de site les
    programmes et pointages, le prestataire ses propres enregistrements, le
    pointeur ses seuls pointages. Les référentiels sont toujours transmis.
    """
    session = _session(p_token)
    role = session.role
    records = TctRecord.objects.filter(seq__gt=max(int(p_since or 0), 0))
    if role != "ct":
        records = records.exclude(type="settings")
    if role in ("ct", "agent", "hse"):
        access = Q()
    elif role == "site":
        access = Q(type__in=("programmes", "pointages"))
    elif role == "presta":
        access = Q(entity=session.entity, type__in=("programmes", "flotte", "retraits", "voyages", "pointages"))
    elif role == "pointeur":
        access = Q(entity=session.entity, type="pointages")
    else:
        access = Q(pk__in=[])
    records = records.filter(Q(type="referentiels") | access)
    limit = min(max(int(p_limit or 300), 1), 500)
    return [{"id": r.id, "type": r.type, "entity": r.entity, "data": r.data,
             "deleted": r.deleted, "seq": r.seq, "updated_at": r.updated_at.isoformat(),
             "updated_by": r.updated_by} for r in records.order_by("seq")[:limit]]


def tct_push(p_token, p_rows):
    """
    Enregistre les lignes modifiées hors ligne envoyées par le client.

    Chaque ligne est {id, type, data, deleted}. Une ligne n'est acceptée que si
    son type est autorisé pour le rôle, qu'elle n'essaie pas de changer le type
    d'un enregistrement existant et qu'un prestataire ne touche pas aux données
    d'une autre société. Une modification remplace la ligne (nouveau `seq`),
    ce qui la fait ressortir pour tous les autres appareils au prochain pull.

    Returns:
        dict: {"ok": [ids acceptés], "rejected": [ids refusés]}
    """
    session = _session(p_token)
    if not isinstance(p_rows, list):
        raise TctError("arguments_invalides")
    allowed = {
        "ct": ("programmes", "flotte", "retraits", "voyages", "pointages", "convois", "settings", "referentiels"),
        "agent": ("voyages", "pointages", "convois"),
        "hse": ("convois", "voyages"),
        "site": ("pointages",),
        "presta": ("programmes", "flotte", "retraits", "voyages"),
        "pointeur": ("pointages",),
    }.get(session.role, ())
    actor = f"{session.role}{(':' + session.entity) if session.entity else ''} / {session.operateur or ''}"
    ok_ids, rejected = [], []
    with transaction.atomic():
        for row in p_rows or []:
            kind = row.get("type")
            record_id = row.get("id")
            data = row.get("data") if isinstance(row.get("data"), dict) else {}
            entity = data.get("prestataire") or None
            current = TctRecord.objects.filter(id=record_id).first() if record_id else None
            invalid = (
                not record_id or kind not in allowed
                or (current is not None and current.type != kind)
                or (session.role in ("presta", "pointeur") and
                    (entity != session.entity or (current is not None and current.entity != session.entity)))
                or (session.role == "presta" and kind == "programmes" and current is None)
                or (session.role == "site" and current is None)
            )
            if invalid:
                rejected.append(record_id or "?")
                continue
            if current is not None:
                # A fresh sequence number marks the updated row for all clients.
                current.delete()
            TctRecord.objects.create(
                id=record_id, type=kind, entity=entity, data=data,
                deleted=bool(row.get("deleted", False)), updated_at=timezone.now(), updated_by=actor,
            )
            ok_ids.append(record_id)
    return {"ok": ok_ids, "rejected": rejected}


def tct_set_code(p_token, p_role, p_entity, p_code):
    """
    Remplace le code d'accès d'un rôle (et d'un prestataire le cas échéant).

    Réservé au CT. Le code doit compter 4 à 8 chiffres et ne doit pas déjà être
    utilisé par un autre accès. Seule l'empreinte bcrypt est conservée : un code
    existant ne peut donc jamais être relu, seulement remplacé.
    """
    session = _session(p_token)
    if session.role != "ct":
        raise TctError("non_autorise")
    if not isinstance(p_code, str) or not re.fullmatch(r"[0-9]{4,8}", p_code):
        raise TctError("code_format")
    if p_role not in CODE_ROLES:
        raise TctError("role_inconnu")
    entity = _code_entity(p_role, p_entity)
    for code in TctCode.objects.exclude(role=p_role, entity=entity):
        if bcrypt.checkpw(p_code.encode("utf-8"), code.code_hash.encode("ascii")):
            raise TctError("code_deja_utilise")
    encoded = bcrypt.hashpw(p_code.encode("utf-8"), bcrypt.gensalt()).decode("ascii")
    TctCode.objects.update_or_create(role=p_role, entity=entity, defaults={"code_hash": encoded})
    return None


# Table des fonctions exposées via POST /api/rpc/<nom> ; clé = nom appelé par le JS.
RPC_FUNCTIONS = {
    "tct_connect": lambda a: tct_connect(a.get("p_code"), a.get("p_operateur")),
    "tct_session_set": lambda a: tct_session_set(a.get("p_token"), a.get("p_role"), a.get("p_entity"), a.get("p_site")),
    "tct_pull": lambda a: tct_pull(a.get("p_token"), a.get("p_since"), a.get("p_limit", 300)),
    "tct_push": lambda a: tct_push(a.get("p_token"), a.get("p_rows", [])),
    "tct_set_code": lambda a: tct_set_code(a.get("p_token"), a.get("p_role"), a.get("p_entity"), a.get("p_code")),
    "tct_logout": lambda a: tct_logout(a.get("p_token")),
}
