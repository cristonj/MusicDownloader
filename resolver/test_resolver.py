import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from resolver.app import app, allowed_url, token_for, token_url
from resolver.worker import match_score, resolve


class ResolverTests(unittest.TestCase):
    def test_source_allowlist_rejects_arbitrary_hosts_credentials_and_ports(self):
        for url in [
            "http://youtube.com/watch?v=x",
            "https://youtube.com.attacker.test/x",
            "https://localhost/x",
            "https://user:pass@youtube.com/x",
            "https://youtube.com:1234/x",
            "https://a.b.bandcamp.com/x",
        ]:
            with self.assertRaises(HTTPException):
                allowed_url(url)
        self.assertEqual(
            allowed_url("https://artist.bandcamp.com/album/a"),
            "https://artist.bandcamp.com/album/a",
        )

    def test_signed_urls_are_tamper_proof_and_expire(self):
        url = "https://www.youtube.com/watch?v=abcdefghijk"
        token = token_for(url)
        self.assertEqual(token_url(token), url)
        with self.assertRaises(HTTPException):
            token_url(token + "x")
        with patch("resolver.app.time.time", return_value=10**12):
            with self.assertRaises(HTTPException) as error:
                token_url(token)
            self.assertEqual(error.exception.status_code, 410)

    def test_matches_prefer_the_correct_recording(self):
        exact = {
            "title": "An Artist - My Song (Official Audio)",
            "duration": 200,
            "channel": "An Artist",
        }
        cover = {"title": "Other Artist - My Song (Live Cover)", "duration": 200}
        unrelated = {"title": "Completely unrelated", "duration": 90}
        self.assertGreater(match_score("My Song", "An Artist", 200, exact), 0.9)
        self.assertLess(match_score("My Song", "An Artist", 200, cover), 0.58)
        self.assertLess(match_score("My Song", "An Artist", 200, unrelated), 0.58)

    def test_spotify_preserves_all_tracks_and_playlist_order(self):
        tracks = [{"name": "First"}, {"name": "Second"}]
        with (
            patch(
                "resolver.worker.spotify_tracks", return_value=("A playlist", tracks)
            ),
            patch(
                "resolver.worker.match_spotify_track",
                side_effect=lambda t: {"title": t["name"], "error": "Not found"},
            ),
        ):
            result = resolve("https://open.spotify.com/playlist/1234567890123456789012")
        self.assertEqual([t["title"] for t in result["tracks"]], ["First", "Second"])

    def test_api_signs_sources_and_keeps_unmatched_entries(self):
        result = {
            "tracks": [
                {
                    "title": "Matched",
                    "sourceUrl": "https://www.youtube.com/watch?v=abcdefghijk",
                },
                {"title": "Unmatched", "error": "No close audio match"},
            ]
        }
        with patch("resolver.app.run_worker", new=AsyncMock(return_value=result)):
            response = TestClient(app).post(
                "/resolve",
                json={
                    "url": "https://open.spotify.com/playlist/1234567890123456789012"
                },
            )
        self.assertEqual(response.status_code, 200)
        tracks = response.json()["tracks"]
        self.assertTrue(tracks[0]["mediaUrl"].startswith("/media/"))
        self.assertIn("error", tracks[1])

    def test_origin_and_download_token_are_checked(self):
        client = TestClient(app)
        self.assertEqual(
            client.post(
                "/resolve",
                headers={"Origin": "https://unknown.test"},
                json={"url": "https://youtube.com/x"},
            ).status_code,
            403,
        )
        self.assertEqual(client.get("/media/invalid").status_code, 403)
        self.assertEqual(client.get("/health").json()["status"], "ok")

    def test_media_response_serves_actual_extension_and_cleans_temp_files(self):
        directory = tempfile.mkdtemp()
        Path(directory, "audio.m4a").write_bytes(b"audio-fixture")
        result = {"filename": "audio.m4a", "extension": "m4a"}
        with (
            patch("resolver.app.tempfile.mkdtemp", return_value=directory),
            patch("resolver.app.run_worker", new=AsyncMock(return_value=result)),
        ):
            response = TestClient(app).get(
                "/media/" + token_for("https://www.youtube.com/watch?v=abcdefghijk")
            )
        self.assertEqual(response.content, b"audio-fixture")
        self.assertEqual(response.headers["x-audio-extension"], "m4a")
        self.assertFalse(Path(directory).exists())


if __name__ == "__main__":
    unittest.main()
