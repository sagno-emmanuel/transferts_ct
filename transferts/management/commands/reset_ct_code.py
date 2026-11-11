"""Réinitialise le code du donneur d'ordre (CT) sans passer par l'application.

Utile lorsque plus personne ne connaît le code CT : la commande s'exécute sur
le serveur, remplace l'empreinte bcrypt du rôle « ct » et n'a besoin d'aucune
session. Les autres codes d'accès ne sont pas modifiés.

Avec --logout, toutes les sessions CT ouvertes sont supprimées : utile si le
code a circulé et que les personnes déjà connectées ne doivent plus y avoir accès.
"""
from getpass import getpass

import bcrypt
from django.core.management.base import BaseCommand

from transferts.models import TctCode, TctSession


def _used_elsewhere(code):
    """True si un autre accès que le CT utilise déjà ce code (comparaison bcrypt)."""
    for item in TctCode.objects.exclude(role="ct", entity=""):
        try:
            if bcrypt.checkpw(code.encode("utf-8"), item.code_hash.encode("ascii")):
                return True
        except (ValueError, TypeError):
            continue
    return False


class Command(BaseCommand):
    help = "Réinitialise le code d'accès du donneur d'ordre (CT) sans session ouverte."

    def add_arguments(self, parser):
        parser.add_argument(
            "--logout",
            action="store_true",
            help="Ferme aussi toutes les sessions CT déjà ouvertes.",
        )

    def handle(self, *args, **options):
        existing = TctCode.objects.filter(role="ct", entity="").first()
        self.stdout.write(
            "Un code CT existe déjà : il va être remplacé." if existing else "Aucun code CT n'est configuré."
        )
        while True:
            code = getpass("Nouveau code CT (4 à 8 chiffres) : ")
            confirm = getpass("Confirmer le nouveau code : ")
            if not code.isdigit() or not 4 <= len(code) <= 8:
                self.stderr.write("Le code doit compter de 4 à 8 chiffres.")
                continue
            if code != confirm:
                self.stderr.write("Les deux saisies sont différentes.")
                continue
            if _used_elsewhere(code):
                self.stderr.write("Ce code est déjà attribué à un autre accès : choisis-en un autre.")
                continue
            break
        encoded = bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt()).decode("ascii")
        TctCode.objects.update_or_create(role="ct", entity="", defaults={"code_hash": encoded})
        if options["logout"]:
            closed, _ = TctSession.objects.filter(role="ct").delete()
            self.stdout.write(self.style.SUCCESS(f"Code CT réinitialisé. {closed} session(s) CT fermée(s)."))
        else:
            self.stdout.write(
                self.style.SUCCESS("Code CT réinitialisé. Les sessions CT déjà ouvertes restent valides (--logout).")
            )
