"""Tables Django équivalentes au stockage métier historique `tct_records`."""
import uuid

from django.db import models
from django.utils import timezone


class TctCode(models.Model):
    """Code bcrypt associé à un rôle, et à une société pour les prestataires."""
    role = models.CharField(max_length=20)
    entity = models.CharField(max_length=100, blank=True, default="")
    code_hash = models.CharField(max_length=100)

    class Meta:
        constraints = [models.UniqueConstraint(fields=("role", "entity"), name="tct_code_role_entity_uniq")]


class TctSession(models.Model):
    """Session ouverte par un code : rôle, entité (prestataire ou site) et expiration."""

    token = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    role = models.CharField(max_length=20)
    entity = models.CharField(max_length=100, null=True, blank=True)
    site = models.CharField(max_length=60, null=True, blank=True)
    operateur = models.CharField(max_length=60, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()


class TctRecord(models.Model):
    """État courant par identifiant; `seq` forme le journal de synchronisation."""
    seq = models.BigAutoField(primary_key=True)
    id = models.CharField(max_length=160, unique=True)
    type = models.CharField(max_length=40)
    entity = models.CharField(max_length=100, null=True, blank=True)
    data = models.JSONField(default=dict)
    deleted = models.BooleanField(default=False)
    updated_at = models.DateTimeField(default=timezone.now)
    updated_by = models.CharField(max_length=200, blank=True, default="")

    class Meta:
        indexes = [
            models.Index(fields=("entity", "seq"), name="tct_rec_entity_seq_idx"),
        ]


class TctLoginFail(models.Model):
    """Trace des connexions échouées, utilisée pour limiter les tentatives."""

    ts = models.DateTimeField(default=timezone.now, db_index=True)
