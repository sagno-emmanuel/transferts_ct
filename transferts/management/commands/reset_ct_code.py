"""Réinitialise le code du donneur d'ordre (CT) sans passer par l'application.

Utile lorsque plus personne ne connaît le code CT : la commande s'exécute sur
le serveur, remplace l'empreinte bcrypt du rôle « ct » et n'a besoin d'aucune
session. Les autres codes d'accès ne sont pas modifiés.

Avec --logout, toutes les sessions CT ouvertes sont supprimées : utile si le
code a circulé et que les personnes déjà connectées ne doivent plus y avoir accès.

La validation (format) et le hachage sont partagés avec l'API tct_set_access_code,
via les fonctions validate_access_code_format() et set_access_code().
"""

from getpass import getpass

from django.core.management.base import BaseCommand

from transferts.models import TctCode, TctSession
from transferts.services import TctError, set_access_code, validate_access_code_format


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
            try:
                validate_access_code_format(code)
            except TctError:
                self.stderr.write("Le code doit compter de 4 à 8 chiffres.")
                continue
            if code != confirm:
                self.stderr.write("Les deux saisies sont différentes.")
                continue
            try:
                set_access_code("ct", "", code)
            except TctError as err:
                if err.args and err.args[0] == "code_deja_utilise":
                    self.stderr.write("Ce code est déjà attribué à un autre accès : choisis-en un autre.")
                    continue
                raise
            break
        if options["logout"]:
            closed, _ = TctSession.objects.filter(role="ct").delete()
            self.stdout.write(self.style.SUCCESS(f"Code CT réinitialisé. {closed} session(s) CT fermée(s)."))
        else:
            self.stdout.write(
                self.style.SUCCESS("Code CT réinitialisé. Les sessions CT déjà ouvertes restent valides (--logout).")
            )
