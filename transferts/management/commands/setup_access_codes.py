"""Configure les codes initiaux sans les écrire en clair dans le projet."""
from getpass import getpass

import bcrypt
from django.core.management.base import BaseCommand, CommandError

from transferts.models import TctCode


class Command(BaseCommand):
    help = "Configure les codes initiaux des accès Transferts CT."

    def add_arguments(self, parser):
        parser.add_argument("--replace", action="store_true", help="Remplace aussi les codes déjà configurés.")

    def handle(self, *args, **options):
        accesses = [("ct", ""), ("agent", ""), ("hse", ""), ("site", "")]
        accesses += [("presta", entity) for entity in ("AGL", "EDT", "GOS", "GSL", "COPRELOG", "IKT", "NLS")]
        chosen = []
        for role, entity in accesses:
            existing = TctCode.objects.filter(role=role, entity=entity).first()
            if existing and not options["replace"]:
                self.stdout.write(f"{role}{':' + entity if entity else ''} : déjà configuré, conservé")
                continue
            label = role + (f" ({entity})" if entity else "")
            while True:
                code = getpass(f"Code initial {label} (4 à 8 chiffres) : ")
                confirm = getpass("Confirmer le code : ")
                if not code.isdigit() or not 4 <= len(code) <= 8:
                    self.stderr.write("Le code doit compter de 4 à 8 chiffres.")
                    continue
                if code != confirm:
                    self.stderr.write("Les deux saisies sont différentes.")
                    continue
                if any(code == prior for _, _, prior in chosen):
                    self.stderr.write("Ce code est déjà utilisé pour un autre accès.")
                    continue
                duplicates = False
                for item in TctCode.objects.exclude(role=role, entity=entity):
                    if bcrypt.checkpw(code.encode("utf-8"), item.code_hash.encode("ascii")):
                        duplicates = True
                        break
                if duplicates:
                    self.stderr.write("Ce code est déjà attribué à un autre accès.")
                    continue
                chosen.append((role, entity, code))
                break
        for role, entity, code in chosen:
            encoded = bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt()).decode("ascii")
            TctCode.objects.update_or_create(role=role, entity=entity, defaults={"code_hash": encoded})
        self.stdout.write(self.style.SUCCESS("Codes initiaux enregistrés sous forme bcrypt."))
