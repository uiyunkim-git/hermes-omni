"""Unit tests for the v3 backend: protocol helpers, target resolution, folder assignment,
passthrough allowlist and file-path containment. Stdlib only; no Hermes, hub or network needed.

Run from the repository root:  python -m unittest discover -s omni/tests -t .
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from typing import Any

from omni.proto import (Forbidden, check_rest, check_rpc, format_reply_text, format_request_text,
                        parse_omni_header, try_parse_address)


class ProtoTests(unittest.TestCase):
    def test_request_header_round_trip(self) -> None:
        text = format_request_text("d_0123456789abcdef", "alpha#20261013_101500_ab12cd", "Fix the loader.\n\nThanks",
                                   True, from_title='Data "loader" OOM')
        h = parse_omni_header(text)
        assert h is not None
        self.assertEqual(h["delivery_id"], "d_0123456789abcdef")
        self.assertEqual(h["kind"], "message")
        self.assertEqual(h["from"], "alpha#20261013_101500_ab12cd")
        self.assertEqual(h["from_title"], "Data 'loader' OOM")
        self.assertEqual(h["body"], "Fix the loader.\n\nThanks")

    def test_reply_and_legacy_headers(self) -> None:
        h = parse_omni_header(format_reply_text("d_aaaaaaaaaaaaaaaa", "d_bbbbbbbbbbbbbbbb", "beta#x1", "6543", "db"))
        assert h is not None
        self.assertEqual((h["kind"], h["from"], h["from_title"], h["body"]), ("reply", "beta#x1", "db", "6543"))
        legacy = "⟦omni:d_cccccccccccccccc⟧ Message from alpha/proj (via hermes-omni)\n\nhello\n\n— No reply is expected."
        h = parse_omni_header(legacy)
        assert h is not None
        self.assertEqual((h["from"], h["from_title"], h["body"]), ("alpha/proj", None, "hello"))
        self.assertIsNone(parse_omni_header("plain prompt"))
        self.assertIsNone(parse_omni_header(None))

    def test_try_parse_address(self) -> None:
        self.assertEqual(try_parse_address("@alpha#s1"), {"node": "alpha", "project": None, "stored_id": "s1"})
        self.assertEqual(try_parse_address("omni:ALPHA/ml-train"), {"node": "alpha", "project": "ml-train",
                                                                    "stored_id": None})
        self.assertEqual(try_parse_address(" alpha/ml-train#s2 ")["stored_id"], "s2")
        for bad in ("Data loader OOM", "alpha", "", None, 3, "alpha:title", "a b#c"):
            self.assertIsNone(try_parse_address(bad), bad)

    def test_rpc_allowlist(self) -> None:
        check_rpc("model.options", {}, False)
        check_rpc("model.options", {}, True)
        check_rpc("config.set", {"key": "reasoning", "value": "high"}, True)
        check_rpc("config.set", {"key": "approvals.mode", "value": "smart"}, False)
        check_rpc("slash.exec", {"command": "/usage"}, True)
        check_rpc("command.dispatch", {"name": "standup", "arg": "x"}, True)
        bad = [("shell.exec", {}, False), ("config.set", {"key": "approvals.mode", "value": "yes"}, False),
               ("config.set", {"key": "terminal.cwd", "value": "/"}, True), ("config.get", {"key": "model"}, False),
               ("slash.exec", {"command": "/new"}, True), ("slash.exec", {"command": "usage"}, True),
               ("session.usage", {}, False), ("profiles.list", {}, True), ("session.compress", {"x": 1}, True),
               ("command.dispatch", {"name": "yolo"}, True)]
        for method, params, has in bad:
            with self.assertRaises(Forbidden, msg=method):
                check_rpc(method, params, has)

    def test_rest_allowlist(self) -> None:
        for method, path in (("GET", "/api/status"), ("GET", "/api/logs?file=agent"), ("PUT", "/api/skills/toggle"),
                             ("DELETE", "/api/learning/node"), ("POST", "/api/cron/jobs/abc-1/pause"),
                             ("PUT", "/api/cron/jobs/abc"), ("GET", "/api/cron/jobs/abc/runs")):
            check_rest(method, path)
        for method, path in (("GET", "/api/env"), ("GET", "/api/config/raw"), ("POST", "/api/gateway/restart"),
                             ("POST", "/api/status"), ("GET", "/api/cron/jobs/../env"), ("GET", "/api/skills/x"),
                             ("DELETE", "/api/cron/jobs"), ("GET", "/api/status/../env")):
            with self.assertRaises(Forbidden, msg=f"{method} {path}"):
                check_rest(method, path)


class FilesTests(unittest.TestCase):
    def setUp(self) -> None:
        from omni.link.files import FileOpError, Files
        self.FileOpError = FileOpError
        self.tmp = tempfile.TemporaryDirectory()
        base = os.path.realpath(self.tmp.name)
        self.root = os.path.join(base, "root")
        self.outside = os.path.join(base, "outside")
        os.makedirs(os.path.join(self.root, "proj", ".git"))
        os.makedirs(self.outside)
        for p, data in (("proj/a.py", "x"), ("proj/.env", "S=1"), ("proj/k.pem", "k"), ("proj/.git/config", "c"),
                        ("../outside/secret.txt", "s")):
            with open(os.path.join(self.root, p), "w") as f:
                f.write(data)
        os.symlink(self.outside, os.path.join(self.root, "proj", "out_dir"))
        os.symlink(os.path.join(self.outside, "secret.txt"), os.path.join(self.root, "proj", "out_file"))
        self.files = Files([self.root], os.path.join(base, "tmp"))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def code(self, fn: Any, *args: Any) -> str:
        with self.assertRaises(self.FileOpError) as cm:
            fn(*args)
        return cm.exception.code

    def test_listing_filters(self) -> None:
        names = {e["name"] for e in self.files.list(os.path.join(self.root, "proj"))["entries"]}
        self.assertEqual(names, {"a.py", ".git"})

    def test_containment(self) -> None:
        proj = os.path.join(self.root, "proj")
        self.assertEqual(self.code(self.files.list, proj + "/../../outside"), "outside_roots")
        self.assertEqual(self.code(self.files.list, proj + "/out_dir"), "outside_roots")
        self.assertEqual(self.code(self.files.read_text, proj + "/out_file"), "outside_roots")
        self.assertEqual(self.code(self.files.read_text, proj + "/.env"), "sensitive")
        self.assertEqual(self.code(self.files.read_text, proj + "/k.pem"), "sensitive")
        self.assertEqual(self.code(self.files.read_text, proj + "/.git/config"), "sensitive")
        self.assertEqual(self.code(self.files.list, proj + "/.git"), "sensitive")
        self.assertEqual(self.code(self.files.list, "relative/path"), "bad_request")
        self.assertEqual(self.files.read_text(proj + "/a.py")["text"], "x")

    def test_upload_round_trip(self) -> None:
        import base64
        proj = os.path.join(self.root, "proj")
        uid = self.files.open_upload(proj, "b.txt", 5, False)["upload_id"]
        self.files.write(uid, 0, base64.b64encode(b"hel").decode())
        self.files.write(uid, 3, base64.b64encode(b"lo").decode())
        self.assertEqual(self.files.commit_file(uid)["size"], 5)
        self.assertEqual(self.files.read_text(proj + "/b.txt")["text"], "hello")
        self.assertEqual(self.code(self.files.open_upload, proj, "b.txt", 1, False), "exists")
        self.assertEqual(self.code(self.files.open_upload, proj, ".env", 1, True), "sensitive")
        self.assertEqual(self.code(self.files.open_upload, proj, "../x", 1, True), "bad_request")


class LinkIndexTests(unittest.TestCase):
    def test_folder_assignment_and_preview(self) -> None:
        from omni.link.index import SessionIndex, preview_from_rows
        from omni.link.projects import ProjectDir
        folders = [ProjectDir("workspace", "/w", "/w", True, False, None),
                   ProjectDir("ml", "/p/ml", "/p", False, True, "main"),
                   ProjectDir("ml-train", "/p/ml-train", "/p", False, False, None)]
        idx = SessionIndex(sessions=None, folders=lambda: folders, emit=lambda f: True, workspace="/w")  # type: ignore[arg-type]
        self.assertEqual(idx.folder_for("/p/ml-train/src/x"), {"name": "ml-train", "path": "/p/ml-train"})
        self.assertEqual(idx.folder_for("/p/ml"), {"name": "ml", "path": "/p/ml"})
        self.assertIsNone(idx.folder_for("/w"))            # the workspace root is "no folder"
        self.assertEqual(idx.folder_for("/w/sub/..//sub"), None)
        self.assertIsNone(idx.folder_for(None))
        self.assertIsNone(idx.folder_for("/elsewhere"))
        self.assertTrue(idx.is_no_folder(None))            # Desktop rows keep cwd NULL
        self.assertTrue(idx.is_no_folder("/w/"))           # Hermes stamps the default cwd on the others
        self.assertFalse(idx.is_no_folder("/p/ml"))
        msg = format_request_text("d_0123456789abcdef", "alpha#s", "Please check", True, from_title="A")
        p, unfinished = preview_from_rows([{"role": "user", "content": msg, "timestamp": 5}])
        self.assertEqual((p["role"], p["text"], p["from"], unfinished), ("agent", "Please check", "A", True))
        p, unfinished = preview_from_rows([{"role": "user", "content": "hi"}, {"role": "assistant", "content": "done"}])
        self.assertEqual((p["role"], p["text"], unfinished), ("assistant", "done", False))
        p, unfinished = preview_from_rows([{"role": "user", "content": "hi"},
                                           {"role": "assistant", "content": "", "tool_calls": [{}]}])
        self.assertEqual((p["role"], unfinished), ("user", True))

    def test_search_snippet(self) -> None:
        from omni.link.agent import search_snippet
        text, hl = search_snippet("...port is >>>6543<<< and ⟦omni:d_0123456789abcdef⟧ >>>orbit<<<...")
        self.assertNotIn("⟦omni", text)
        self.assertEqual([text[a:b] for a, b in hl], ["6543", "orbit"])


class QueueResubmitTests(unittest.TestCase):
    """Prompts Hermes dropped from its queue (중단 clears it) are submitted again, never lost silently."""

    def test_resubmit_paths(self) -> None:
        from omni.link.hermes import HermesError, HermesUnavailable
        from omni.link.sessions import Attached, SessionManager, SessionOpError
        from omni.link.state import LinkState

        async def run(d: str) -> tuple[list[str], list[str], list[dict], list[dict], LinkState]:
            emitted: list[dict] = []
            done: list[dict] = []
            state = LinkState(d)
            state.load()
            sm = SessionManager(None, state, emitted.append, done.append)  # type: ignore[arg-type]
            a = Attached(stored_id="S1", runtime_id="r1")
            sm.by_stored["S1"], sm.by_runtime["r1"] = a, a
            for did in ("D1", "D2"):
                state.inflight[did] = {"stored_id": "S1", "status": "queued", "user_row_id": None, "submitted_at": 0}
            plan: dict[str, Any] = {
                "h-ok": {"status": "streaming", "user_row_id": 7}, "h-q": {"status": "queued"},
                "h-locked": SessionOpError("session_locked", "open elsewhere"), "d1": HermesError(4000, "no"),
                "h-amb": HermesUnavailable("timeout", sent=True), "d2": {"status": "queued"}}
            calls: list[str] = []

            async def fake_call(stored_id: str, method: str, params: dict | None = None, timeout: float = 30):
                assert method == "prompt.submit" and params and params["queued"] is True
                calls.append(params["text"])
                r = plan[params["text"]]
                if isinstance(r, Exception):
                    raise r
                return a, r

            sm.call_session = fake_call  # type: ignore[method-assign]

            def item(kind: str, text: str, did: str | None = None) -> dict[str, Any]:
                return {"kind": kind, "text": text, "prompt": text, "delivery_id": did, "at": 1.0, "completes": 0}

            await sm._resubmit_queue("S1", [
                item("human", "h-ok"), item("human", "h-q"), item("human", "h-locked"), item("delivery", "d1", "D1"),
                item("delivery", "d2", "D2"), item("delivery", "settled", "D9")])
            return calls, [i["text"] for i in a.queue], emitted, done, state

        with tempfile.TemporaryDirectory() as d:
            calls, queue, emitted, done, state = asyncio.run(run(d))
        self.assertEqual(calls, ["h-ok", "h-q", "h-locked", "d1", "d2"])   # D9 is settled: skipped
        self.assertEqual(queue, ["h-q", "d2"])                             # queued again, FIFO
        frames = [f for f in emitted if f.get("kind") == "session.queue"]
        self.assertEqual(len(frames), 1)
        self.assertEqual([i["text"] for i in frames[0]["items"]], ["h-q"])
        self.assertEqual(frames[0]["dropped"], ["h-locked"])              # returned to the composer
        self.assertEqual([(f["delivery_id"], f["status"]) for f in done], [("D1", "error")])
        self.assertEqual(state.inflight["D2"]["status"], "queued")


class TitleLanguageTests(unittest.TestCase):
    """A Korean first prompt keeps a Korean title even when Hermes' title model answers in English."""

    def test_helpers(self) -> None:
        from omni.link.titles import derive_title, has_hangul, mostly_hangul, title_hint_for
        self.assertTrue(mostly_hangul("README.md 를 읽고 두 줄로 요약해줘."))
        self.assertTrue(mostly_hangul("src/omni/link/sessions.py 의 title 처리 버그 고쳐줘"))
        self.assertTrue(mostly_hangul("README.md를 요약해"))                    # particle glued to a filename
        self.assertFalse(mostly_hangul("Please fix the login bug 빨리"))
        self.assertFalse(mostly_hangul("npm test 123"))
        self.assertFalse(mostly_hangul(""))
        self.assertTrue(has_hangul("backup.sh 스크립트 동작 설명"))
        self.assertFalse(has_hangul("README.md two-line summary"))
        # Same output as Hermes' agent/title_generator.derive_title (48-char cap, word boundary, ellipsis).
        self.assertEqual(derive_title("\n  README.md 를 읽고   두 줄로 요약해줘.\n둘째 줄"), "README.md 를 읽고 두 줄로 요약해줘.")
        long = "folio-api 의 페이지네이션 버그를 찾아서 원인을 설명하고 고칠 방법을 제안해줘 그리고 테스트도"
        self.assertEqual(derive_title(long), "folio-api 의 페이지네이션 버그를 찾아서 원인을 설명하고 고칠 방법을 제안해줘…")
        self.assertIsNone(title_hint_for("/model gpt-5"))                     # slash commands are not titled
        self.assertIsNone(title_hint_for("Summarize README.md"))
        self.assertEqual(title_hint_for("안녕"), "안녕")

    def test_index_keeps_korean_title(self) -> None:
        from omni.link.index import SessionIndex
        from omni.link.sessions import SessionManager, SessionOpError
        from omni.link.state import LinkState

        async def run(d: str) -> tuple[list[tuple[str, str]], list[Any], LinkState, list[str | None]]:
            state = LinkState(d)
            state.load()
            sm = SessionManager(None, state, lambda f: None, lambda f: None)  # type: ignore[arg-type]
            renames: list[tuple[str, str]] = []
            taken = {"README.md 를 읽고 두 줄로 요약해줘."}

            async def fake_update(sid: str, title: str | None, pinned: bool | None) -> None:
                renames.append((sid, title or ""))
                if title in taken:
                    raise SessionOpError("duplicate_title", "title already in use")

            sm.update = fake_update  # type: ignore[method-assign]
            idx = SessionIndex(sessions=sm, folders=lambda: [], emit=lambda f: True, workspace="/w")
            idx.trigger = lambda: None  # type: ignore[method-assign]
            idx.note_first_prompt("S1", "README.md 를 읽고 두 줄로 요약해줘.")
            idx.note_first_prompt("S2", "Summarize README.md in two lines")     # English: no hint
            idx.note_first_prompt("S3", "backup.sh 를 설명해줘")
            idx.note_first_prompt("S4", "todo.md 를 정리해줘")
            shown: list[Any] = []

            def build(sid: str, title: str, source: str) -> Any:
                return idx._build_row(sid, {"title": title, "title_source": source}, {}, 0.0)["title"]

            idx.rows = {s: {"stored_id": s, "title": None} for s in ("S1", "S2", "S3", "S4")}
            shown.append(build("S1", "README.md 를 읽고 두 줄로 요약해줘.", "derived"))  # instant title: kept
            shown.append(build("S1", "Friendly greeting", "derived"))       # placeholder: shown as the hint
            shown.append(build("S1", "README.md two-line summary", "llm"))  # English model title: replaced
            shown.append(build("S2", "README.md two-line summary", "llm"))  # English prompt: untouched
            shown.append(build("S3", "backup.sh 스크립트 설명", "llm"))       # Korean model title: kept
            shown.append(build("S4", "Todo cleanup", "user"))               # typed by the user: kept
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            # The chat header (session.state from session.info) hides the English title the same way.
            idx.note_first_prompt("S5", "로그 좀 봐줘")
            shown.append(sm.shown_title("S5", "Log review"))
            shown.append(sm.shown_title("S5", "로그 분석"))
            idx.drop_title_hint("S5")
            return renames, shown, state, [idx.rows[s].get("title") for s in ("S1",)]

        with tempfile.TemporaryDirectory() as d:
            renames, shown, state, rows = asyncio.run(run(d))
        hint = "README.md 를 읽고 두 줄로 요약해줘."
        self.assertEqual(shown, [hint, hint, hint, "README.md two-line summary", "backup.sh 스크립트 설명", "Todo cleanup",
                                 "로그 좀 봐줘", "로그 분석"])
        self.assertEqual(renames, [("S1", hint), ("S1", hint + " (2)")])    # numbered when the name is taken
        self.assertEqual(rows, [hint + " (2)"])
        self.assertEqual(state.title_hints, {})                            # every hint settled


class _Links:
    def __init__(self, nodes: list[str]):
        from omni.hub.links import NodeState
        self.nodes = {n: NodeState(n, {"display_name": n, "projects": [
            {"name": "ml-train", "path": f"/{n}/ml-train"}, {"name": "empty", "path": f"/{n}/empty"}]}) for n in nodes}
        self.conns: dict[str, Any] = {}

    def is_online(self, node: str) -> bool:
        return False


class _Live:
    buffers: dict[Any, Any] = {}


class RouterResolveTests(unittest.TestCase):
    def setUp(self) -> None:
        from omni.hub.router import Router
        from omni.hub.sessions import SessionIndex
        links = _Links(["alpha", "beta"])
        index = SessionIndex(store=None, links=links)  # type: ignore[arg-type]
        index.live = _Live()  # type: ignore[assignment]

        def row(sid: str, title: str | None, last: float, folder: str | None = None, hidden: bool = False) -> dict:
            return {"stored_id": sid, "title": title, "last_active": last, "hidden": hidden,
                    "folder": {"name": folder, "path": f"/x/{folder}"} if folder else None}
        index.rows = {
            "alpha": {"a1": row("a1", "Data loader OOM", 10), "a2": row("a2", "Planner", 20),
                      "a3": row("a3", "Bot Chat", 30, hidden=True)},
            "beta": {"b1": row("b1", "Trainer", 5), "b2": row("b2", "Trainer", 6), "b3": row("b3", "Docs writer", 7)},
        }
        for n in ("alpha", "beta"):
            for r in index.rows[n].values():
                if r["stored_id"] in ("a1", "b3"):
                    r["folder"] = {"name": "ml-train", "path": f"/{n}/ml-train"}
        self.router = Router(store=None, links=links, index=index)  # type: ignore[arg-type]

    def resolve(self, to: str, sender: tuple[str, str] | None = ("alpha", "a2")) -> Any:
        return asyncio.run(self.router.resolve(to, sender))

    def reason(self, to: str, sender: tuple[str, str] | None = ("alpha", "a2")) -> Any:
        from omni.hub.router import Rejected
        with self.assertRaises(Rejected) as cm:
            self.resolve(to, sender)
        return cm.exception

    def test_address_forms(self) -> None:
        t = self.resolve("beta#b3")
        self.assertEqual((t.node, t.stored, t.title), ("beta", "b3", "Docs writer"))
        t = self.resolve("@Docs writer (beta#b3)")
        self.assertEqual(t.stored, "b3")
        t = self.resolve("omni:alpha/ml-train#a1")
        self.assertEqual(t.stored, "a1")

    def test_folder_target(self) -> None:
        t = self.resolve("beta/ml-train")
        self.assertEqual((t.node, t.stored), ("beta", "b3"))       # most recent session in the folder
        t = self.resolve("beta/empty")                              # offline node: bound at dispatch
        self.assertEqual((t.stored, t.path, t.folder), (None, "/beta/empty", "empty"))
        self.assertEqual(self.reason("beta/nope").reason, "unknown_target")

    def test_titles(self) -> None:
        self.assertEqual(self.resolve("data loader oom").stored, "a1")       # exact, case-insensitive
        self.assertEqual(self.resolve("Docs").stored, "b3")                  # unique prefix
        self.assertEqual(self.resolve("beta:docs w").stored, "b3")           # node:title
        e = self.reason("Trainer")
        self.assertEqual(e.reason, "ambiguous_target")
        self.assertEqual({c["address"] for c in e.extra["candidates"]}, {"beta#b1", "beta#b2"})
        self.assertEqual(self.reason("Bot Chat").reason, "unknown_target")   # hidden rows are not targets
        e = self.reason("Plann3r")
        self.assertEqual(e.reason, "unknown_target")
        self.assertIn("suggestions", e.extra)

    def test_self(self) -> None:
        self.assertEqual(self.reason("Planner").reason, "self")
        self.assertEqual(self.reason("alpha#a2").reason, "self")


class StoreTests(unittest.TestCase):
    def test_pair_count_and_session_index(self) -> None:
        from pathlib import Path
        from omni.hub.store import Store
        with tempfile.TemporaryDirectory() as d:
            s = Store(Path(d) / "hub.db")
            s._open()
            a, b, c = ("alpha", "a1"), ("beta", "b1"), ("beta", "b2")
            for i in range(5):
                src, dst = (a, b) if i % 2 == 0 else (b, a)
                s.insert_delivery({"id": f"d_{i:016d}", "kind": "message", "from_node": src[0], "from_stored": src[1],
                                   "from_addr": "x", "to_node": dst[0], "to_addr": "y", "to_stored": dst[1],
                                   "message": "m", "conv_id": "conv1"})
            s.insert_delivery({"id": "d_reply000000000a", "kind": "reply", "from_node": "beta", "from_stored": "b1",
                               "from_addr": "x", "to_node": "alpha", "to_addr": "y", "to_stored": "a1", "message": "r",
                               "conv_id": "conv1"})
            s.insert_delivery({"id": "d_other0000000000", "kind": "message", "from_node": "alpha", "from_stored": "a1",
                               "from_addr": "x", "to_node": "beta", "to_addr": "y", "to_stored": "b2", "message": "m",
                               "conv_id": "conv1"})
            self.assertEqual(s.count_pair_messages("conv1", a, b), 5)
            self.assertEqual(s.count_pair_messages("conv1", b, a), 5)
            self.assertEqual(s.count_pair_messages("conv1", a, c), 1)
            self.assertEqual(s.count_pair_messages("conv2", a, b), 0)
            s.replace_node_sessions("alpha", [{"stored_id": "a1", "title": "t"}, {"stored_id": "a2"}])
            s.upsert_node_sessions("alpha", [{"stored_id": "a3"}], ["a1"])
            self.assertEqual(sorted(sid for n, sid, _ in s.load_node_sessions()), ["a2", "a3"])
            s.delete_node("alpha")
            self.assertEqual(s.load_node_sessions(), [])
            s.db.close()


class CollabLimitTests(unittest.TestCase):
    def test_pair_cap_within_a_conversation(self) -> None:
        from pathlib import Path
        from omni.hub.router import Router
        from omni.hub.sessions import SessionIndex
        from omni.hub.store import Store
        from omni.proto import PAIR_MESSAGE_CAP

        async def run(d: str) -> list[str]:
            store = Store(Path(d) / "hub.db")
            await store.open()
            links = _Links(["alpha", "beta"])
            index = SessionIndex(store=store, links=links)  # type: ignore[arg-type]
            index.live = _Live()  # type: ignore[assignment]
            index.rows = {"alpha": {"a1": {"stored_id": "a1", "title": "Planner"}},
                          "beta": {"b1": {"stored_id": "b1", "title": "Expert"}}}
            router = Router(store=store, links=links, index=index)  # type: ignore[arg-type]
            router.live = _Live()  # type: ignore[assignment]
            router.live.is_running = lambda n, s: False  # type: ignore[attr-defined]
            router.live.publish_delivery = lambda d: None  # type: ignore[attr-defined]
            router.kick = lambda: None  # type: ignore[method-assign]
            index.deliveries_changed = lambda: None  # type: ignore[method-assign]
            out = []
            cause = None
            for i in range(PAIR_MESSAGE_CAP + 2):
                res = await router.agent_send("alpha", {"delivery_id": f"d_{i:016d}", "from_stored_id": "a1",
                                                        "to": "Expert", "message": "q", "cause_id": cause})
                out.append(res["status"] if res["status"] != "rejected" else res["reason"])
                cause = cause or res["delivery_id"]   # later messages are sent from delivery turns
            res = await router.agent_send("alpha", {"delivery_id": "d_newconversation", "from_stored_id": "a1",
                                                    "to": "Expert", "message": "q"})
            out.append(res["status"])
            await store.close()
            return out

        with tempfile.TemporaryDirectory() as d:
            out = asyncio.run(run(d))
        self.assertEqual(out[:PAIR_MESSAGE_CAP], ["queued"] * PAIR_MESSAGE_CAP)
        self.assertEqual(out[PAIR_MESSAGE_CAP:PAIR_MESSAGE_CAP + 2], ["collab_limit"] * 2)
        self.assertEqual(out[-1], "queued")   # a new conversation (user turn) starts a fresh count


if __name__ == "__main__":
    unittest.main()
