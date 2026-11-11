"""Tests des accès, du relais JSON et des règles portées depuis les RPC SQL."""
import bcrypt
import json
from io import StringIO
from tempfile import TemporaryDirectory
from unittest import mock
from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from datetime import timedelta

from .models import TctCode, TctRecord, TctSession
from .services import TctError, tct_access_code_status, tct_connect, tct_pull, tct_push, tct_session_set


class InterfaceTests(TestCase):
    def test_home_page_serves_original_application_shell(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Transferts CT")
        self.assertContains(response, "transferts/js/core.js")
        self.assertNotContains(response, "SUPABASE")


class BusinessRuleTests(TestCase):
    def setUp(self):
        # pgcrypto bcrypt hashes use the legacy $2a$ prefix.
        code_hash = bcrypt.hashpw(b"123456", bcrypt.gensalt()).replace(b"$2b$", b"$2a$", 1).decode("ascii")
        TctCode.objects.create(role="ct", entity="", code_hash=code_hash)
        self.session = TctSession.objects.create(
            role="ct", operateur="Test", expires_at=timezone.now() + timedelta(days=1),
        )

    def test_login_returns_30_day_session(self):
        result = tct_connect("123456", "A. Diallo")
        self.assertEqual(result["role"], "ct")
        self.assertEqual(result["operateur"], "A. Diallo")
        self.assertEqual(TctSession.objects.get(token=result["token"]).expires_at.date(),
                         (timezone.now() + timedelta(days=30)).date())

    def test_site_may_update_existing_pointage_but_not_create_one(self):
        self.session.role = "site"
        self.session.entity = "PSK"
        self.session.save()
        TctRecord.objects.create(id="pt-1", type="pointages", entity="AGL", data={"prestataire": "AGL"})
        result = tct_push(str(self.session.token), [{"id": "pt-2", "type": "pointages", "data": {"prestataire": "AGL"}}])
        self.assertEqual(result["rejected"], ["pt-2"])
        result = tct_push(str(self.session.token), [{"id": "pt-1", "type": "pointages", "data": {"prestataire": "AGL", "contreSigne": True}}])
        self.assertEqual(result["ok"], ["pt-1"])
        self.assertTrue(TctRecord.objects.get(id="pt-1").data["contreSigne"])

    def test_referentials_are_visible_to_all_and_settings_only_to_ct(self):
        TctRecord.objects.get_or_create(id="__settings__", defaults={"type": "settings", "data": {"objTeu": 250}})
        TctRecord.objects.get_or_create(id="__referentiels__", defaults={"type": "referentiels", "data": {"prestataires": ["AGL"]}})
        self.session.role = "pointeur"
        self.session.entity = "AGL"
        self.session.save()
        rows = tct_pull(str(self.session.token), 0)
        self.assertEqual([row["type"] for row in rows], ["referentiels"])


class LocalApiTests(TestCase):
    def setUp(self):
        cache.clear()
        self.session = TctSession.objects.create(
            role="ct", operateur="Test", expires_at=timezone.now() + timedelta(days=1),
        )
        self.token = str(self.session.token)

    def test_photo_upload_and_read_are_local(self):
        with TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            response = self.client.post(
                "/api/photos/test.jpg", data=b"jpeg-bytes", content_type="image/jpeg",
                HTTP_X_TCT_TOKEN=self.token,
            )
            self.assertEqual(response.status_code, 201)
            photo_url = response.json()["url"]
            response = self.client.get(photo_url, {"token": self.token})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(b"".join(response.streaming_content), b"jpeg-bytes")
            response.close()

    def test_photo_requires_an_active_session(self):
        with TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            self.assertEqual(self.client.get("/api/photos/test.jpg").status_code, 401)
            self.assertEqual(
                self.client.post("/api/photos/test.jpg", data=b"jpeg", content_type="image/jpeg").status_code, 401
            )
            self.assertEqual(self.client.get("/api/photos/test.jpg", {"token": "inconnu"}).status_code, 401)

    def test_photo_upload_rate_is_limited(self):
        with TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            statuses = [
                self.client.post(
                    f"/api/photos/photo-{index}.jpg", data=b"jpeg", content_type="image/jpeg",
                    HTTP_X_TCT_TOKEN=self.token,
                ).status_code
                for index in range(21)
            ]
        self.assertEqual(statuses[:20], [201] * 20)
        self.assertEqual(statuses[20], 429)

    def test_photo_path_traversal_is_rejected(self):
        response = self.client.get("/api/photos/%2E%2E/private.jpg", {"token": self.token})
        self.assertEqual(response.status_code, 400)

    def test_unknown_rpc_and_malformed_json_are_rejected(self):
        response = self.client.post("/api/rpc/tct_arbitrary", data="{}", content_type="application/json")
        self.assertEqual(response.status_code, 404)
        response = self.client.post("/api/rpc/tct_connect", data="{", content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_rpc_runs_against_the_local_database(self):
        response = self.client.post("/api/rpc/tct_connect", data='{"p_code":"","p_operateur":""}', content_type="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "nom_requis")


class AccessCodeTests(TestCase):
    """État des codes et commande de secours qui réinitialise le code CT."""

    def setUp(self):
        for role, entity, code in (("ct", "", b"123456"), ("agent", "", b"654321"), ("presta", "AGL", b"111111")):
            TctCode.objects.create(
                role=role, entity=entity, code_hash=bcrypt.hashpw(code, bcrypt.gensalt()).decode("ascii")
            )
        expires = timezone.now() + timedelta(days=1)
        self.ct_token = str(TctSession.objects.create(role="ct", operateur="CT", expires_at=expires).token)
        self.agent_token = str(TctSession.objects.create(role="agent", operateur="Agent", expires_at=expires).token)

    def _reset(self, answers, *args):
        with mock.patch("transferts.management.commands.reset_ct_code.getpass", side_effect=answers):
            out, err = StringIO(), StringIO()
            call_command("reset_ct_code", *args, stdout=out, stderr=err)
        return out.getvalue() + err.getvalue()

    def test_codes_status_lists_configured_accesses_only(self):
        rows = tct_access_code_status(self.ct_token)
        self.assertIn({"role": "presta", "entity": "AGL"}, rows)
        self.assertIn({"role": "agent", "entity": ""}, rows)
        self.assertNotIn({"role": "presta", "entity": "GSL"}, rows)
        self.assertNotIn({"role": "hse", "entity": ""}, rows)
        self.assertNotIn("code_hash", str(rows))

    def test_codes_status_is_reserved_to_ct(self):
        with self.assertRaises(TctError):
            tct_access_code_status(self.agent_token)
        response = self.client.post(
            "/api/rpc/tct_access_code_status",
            data=json.dumps({"p_token": self.agent_token}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "non_autorise")

    def test_codes_status_rpc_lists_presence_for_ct(self):
        response = self.client.post(
            "/api/rpc/tct_access_code_status",
            data=json.dumps({"p_token": self.ct_token}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 3)

    def test_reset_replaces_code_and_old_one_is_refused(self):
        self._reset(["777777", "777777"])
        self.assertEqual(tct_connect("777777", "Test")["role"], "ct")
        with self.assertRaises(TctError):
            tct_connect("123456", "Test")

    def test_reset_refuses_duplicate_bad_format_and_mismatch(self):
        out = self._reset(["111111", "111111", "12ab", "12ab", "333333", "444444", "555555", "555555"])
        self.assertIn("déjà attribué", out)
        self.assertIn("4 à 8 chiffres", out)
        self.assertIn("différentes", out)
        self.assertEqual(tct_connect("555555", "Test")["role"], "ct")

    def test_reset_logout_closes_ct_sessions_only(self):
        TctSession.objects.create(role="ct", operateur="CT 2", expires_at=timezone.now() + timedelta(days=1))
        out = self._reset(["987654", "987654"], "--logout")
        self.assertIn("2 session(s) CT fermée(s)", out)
        self.assertFalse(TctSession.objects.filter(role="ct").exists())
        self.assertTrue(TctSession.objects.filter(role="agent").exists())

    def test_reset_without_logout_keeps_sessions(self):
        out = self._reset(["987654", "987654"])
        self.assertIn("restent valides", out)
        self.assertTrue(TctSession.objects.filter(role="ct").exists())
