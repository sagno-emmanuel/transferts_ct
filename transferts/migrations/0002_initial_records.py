"""Précharge les deux lignes de configuration présentes dans le SQL source."""
import json
from pathlib import Path

from django.db import migrations


def seed_records(apps, schema_editor):
    Record = apps.get_model("transferts", "TctRecord")
    fixture = Path(__file__).resolve().parent.parent / "fixtures" / "initial_records.json"
    for item in json.loads(fixture.read_text(encoding="utf-8")):
        fields = item["fields"]
        Record.objects.get_or_create(
            id=fields["id"],
            defaults={
                "type": fields["type"], "entity": fields["entity"],
                "data": fields["data"], "deleted": fields["deleted"],
                "updated_by": fields["updated_by"],
            },
        )


class Migration(migrations.Migration):
    dependencies = [("transferts", "0001_initial")]
    operations = [migrations.RunPython(seed_records, migrations.RunPython.noop)]
