"""Importe une sauvegarde JSON produite par le bouton Sauvegarde de l'app."""
import json

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from transferts.models import TctRecord

DATA_TYPES = {"programmes", "flotte", "retraits", "voyages", "pointages", "convois"}


class Command(BaseCommand):
    help = "Importe les données d'un fichier sauvegarde_transferts_ct_*.json."

    def add_arguments(self, parser):
        parser.add_argument("fichier", help="Chemin vers le fichier de sauvegarde JSON.")
        parser.add_argument("--replace", action="store_true", help="Efface d'abord tous les enregistrements métier locaux.")

    def handle(self, *args, **options):
        try:
            payload = json.load(open(options["fichier"], encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CommandError(f"Impossible de lire la sauvegarde : {exc}") from exc
        if payload.get("application") != "Transferts CT" or not isinstance(payload.get("donnees"), dict):
            raise CommandError("Ce fichier ne correspond pas à une sauvegarde Transferts CT.")
        prepared = []
        for kind in DATA_TYPES:
            rows = payload["donnees"].get(kind, {})
            if not isinstance(rows, dict):
                raise CommandError(f"Format invalide pour le type {kind}.")
            for record_id, data in rows.items():
                if not isinstance(data, dict) or not record_id:
                    raise CommandError(f"Enregistrement invalide dans {kind}.")
                prepared.append((str(record_id), kind, data, data.get("prestataire") or None))
        settings_data = payload.get("reglages")
        refs_data = payload.get("referentiels")
        if not isinstance(settings_data, dict) or not isinstance(refs_data, dict):
            raise CommandError("La sauvegarde doit contenir les réglages et référentiels.")
        prepared.extend([
            ("__settings__", "settings", settings_data, None),
            ("__referentiels__", "referentiels", refs_data, None),
        ])
        with transaction.atomic():
            if options["replace"]:
                TctRecord.objects.all().delete()
            for record_id, kind, data, entity in prepared:
                TctRecord.objects.filter(id=record_id).delete()
                TctRecord.objects.create(
                    id=record_id, type=kind, entity=entity, data=data,
                    updated_by="import sauvegarde",
                )
        self.stdout.write(self.style.SUCCESS(f"{len(prepared)} enregistrements importés."))
