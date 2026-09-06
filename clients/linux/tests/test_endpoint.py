import hashlib
import json
import unittest

from cosmos_linux.endpoint import (
    InvalidServer, approval_url, base64url, canonical_origin, debase64url, descriptor_json, display_host,
    fingerprint, fingerprint_of_encoded, group_fingerprint, surfaces_url, valid_text,
)
from cosmos_linux.events import APPROVAL_PROFILE, PLATFORM

from .fixtures import ENROLLMENT_ID, PUBLIC_KEY, PUBLIC_KEY_SEC1


class EndpointTest(unittest.TestCase):
    def test_origins_are_canonical_https_only(self):
        self.assertEqual(canonical_origin(" https://Center.Andersmadsen.dk/ "), "https://center.andersmadsen.dk")
        self.assertEqual(canonical_origin("https://center.andersmadsen.dk:443"), "https://center.andersmadsen.dk")
        self.assertEqual(canonical_origin("https://center.example:8443/"), "https://center.example:8443")
        for invalid in ("http://center.example", "center.example", "https://", "https://user@center.example",
                        "https://center.example/settings", "https://center.example/?x=1",
                        "https://center.example/#frag", "https://center.example:0", "https://cen ter.example",
                        "https://center.example%2f", "https://center.example\\x"):
            with self.assertRaises(InvalidServer, msg=invalid):
                canonical_origin(invalid)

    def test_display_host_and_surfaces_url(self):
        self.assertEqual(display_host("https://center.andersmadsen.dk"), "center.andersmadsen.dk")
        self.assertEqual(surfaces_url("https://center.andersmadsen.dk"),
                         "https://center.andersmadsen.dk/settings/account/surfaces")

    def test_descriptor_json_is_sorted_and_bounded(self):
        encoded = descriptor_json(ENROLLMENT_ID, PUBLIC_KEY, PLATFORM, APPROVAL_PROFILE)
        self.assertLessEqual(len(encoded), 1024)
        self.assertEqual(list(json.loads(encoded)), ["approval", "enrollmentId", "platform", "publicKey"])
        self.assertEqual(json.loads(encoded)["platform"], "linux")
        with self.assertRaises(ValueError):
            descriptor_json(ENROLLMENT_ID, "k" * 2000, PLATFORM, APPROVAL_PROFILE)

    def test_approval_link_carries_the_descriptor_as_a_fragment(self):
        encoded = descriptor_json(ENROLLMENT_ID, PUBLIC_KEY, PLATFORM, APPROVAL_PROFILE)
        link = approval_url("https://center.andersmadsen.dk", encoded)
        prefix = "https://center.andersmadsen.dk/settings/account/surfaces#descriptor="
        self.assertTrue(link.startswith(prefix))
        fragment = link[len(prefix):]
        self.assertRegex(fragment, r"^[A-Za-z0-9_-]{1,1400}$")
        self.assertEqual(debase64url(fragment), encoded)
        self.assertNotIn("?", link)

    def test_fingerprint_matches_center_and_groups_by_four(self):
        digest = fingerprint(PUBLIC_KEY_SEC1)
        self.assertEqual(digest, hashlib.sha256(PUBLIC_KEY_SEC1).hexdigest())
        self.assertEqual(fingerprint_of_encoded(PUBLIC_KEY), digest)
        grouped = group_fingerprint(digest)
        self.assertEqual(len(grouped.split(" ")), 16)
        self.assertTrue(all(len(group) == 4 for group in grouped.split(" ")))
        self.assertEqual(grouped.replace(" ", ""), digest)
        with self.assertRaises(ValueError):
            fingerprint(b"\x02" + PUBLIC_KEY_SEC1[1:])

    def test_base64url_round_trip_without_padding(self):
        for length in range(0, 6):
            data = bytes(range(length))
            self.assertNotIn("=", base64url(data))
            self.assertEqual(debase64url(base64url(data)), data)

    def test_public_text_bounds(self):
        self.assertTrue(valid_text("hello"))
        self.assertFalse(valid_text("   "))
        self.assertFalse(valid_text("a\0b"))
        self.assertTrue(valid_text("ø" * 2000))
        self.assertFalse(valid_text("ø" * 2001))


if __name__ == "__main__":
    unittest.main()
