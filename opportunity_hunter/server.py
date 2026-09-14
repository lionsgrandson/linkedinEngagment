from __future__ import annotations

import argparse
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import engine, resume_jobs


STATIC = Path(__file__).resolve().parent / "static"
MAX_BODY = 10_000_000


def _edit_pending_approval(approval_id: str, expected_kind: str, updates: dict[str, str]) -> None:
    """Apply the user's final edits immediately before the approved action runs."""
    state = engine.load_state()
    for item in state.get("approvals", []):
        if item.get("id") != approval_id:
            continue
        if item.get("kind") != expected_kind:
            raise ValueError("Approval does not match this action")
        if item.get("consumedAt"):
            raise ValueError("Approval was already used")
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        for key, value in updates.items():
            if value is not None:
                payload[key] = value
        item["payload"] = payload
        engine.save_state(state)
        return
    raise ValueError("Approval was not found")


class HunterHandler(BaseHTTPRequestHandler):
    server_version = "CodeCrafterOpportunityHunter/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"hunter | {self.address_string()} | {fmt % args}")

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 400) -> None:
        self._json({"ok": False, "error": message}, status)

    def _read_json(self) -> dict:
        if self.headers.get("X-Hunter-Request") != "1":
            raise PermissionError("Missing local Hunter request header")
        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type.lower():
            raise ValueError("Content-Type must be application/json")
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if size < 0 or size > MAX_BODY:
            raise ValueError("Request body is too large")
        raw = self.rfile.read(size) if size else b"{}"
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Request body is not valid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("JSON body must be an object")
        return value

    def _serve_static(self, request_path: str) -> None:
        relative = request_path.strip("/") or "index.html"
        candidate = (STATIC / relative).resolve()
        if STATIC.resolve() not in candidate.parents and candidate != STATIC.resolve():
            return self._error("not found", 404)
        if not candidate.exists() or not candidate.is_file():
            return self._error("not found", 404)
        body = candidate.read_bytes()
        mime = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith("text/") or mime in {"application/javascript", "application/json"} else mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/status":
            return self._json({"ok": True, **engine.state_snapshot()})
        if path == "/api/approvals":
            return self._json({"ok": True, "approvals": engine.list_approvals()})
        if path.startswith("/api/"):
            return self._error("not found", 404)
        return self._serve_static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/api/resume/upload":
                result = engine.extract_resume(str(data.get("name", "")), str(data.get("content", "")))
                return self._json({"ok": True, "resume": result})
            if path == "/api/resume/text":
                result = engine.set_resume_text(str(data.get("name", "Pasted resume")), str(data.get("text", "")))
                return self._json({"ok": True, "resume": result})
            if path == "/api/jobs/search":
                result = engine.search_jobs(
                    str(data.get("query", "")),
                    str(data.get("location", "")),
                    country=str(data.get("country", "")),
                    limit=int(data.get("limit", 15) or 15),
                    provider=str(data.get("provider", "auto")),
                )
                return self._json({"ok": True, **result})
            if path == "/api/jobs/from-resume":
                result = resume_jobs.find_from_resume(
                    str(data.get("location", "")),
                    country=str(data.get("country", "")),
                    limit=int(data.get("limit", 25) or 25),
                )
                return self._json({"ok": True, **result})
            if path == "/api/jobs/application-pack":
                job = data.get("job") if isinstance(data.get("job"), dict) else {}
                result = engine.make_application_pack(job)
                return self._json({"ok": True, "application": result})
            if path == "/api/clients/search":
                result = engine.search_clients(
                    str(data.get("serviceType", "")),
                    str(data.get("location", "")),
                    country=str(data.get("country", "")),
                    limit=int(data.get("limit", 12) or 12),
                )
                return self._json({"ok": True, **result})
            if path == "/api/clients/research":
                client = data.get("client") if isinstance(data.get("client"), dict) else {}
                result = engine.research_client(client, str(data.get("serviceType", "")))
                return self._json({"ok": True, "client": result})
            if path == "/api/outreach/email/draft":
                client = data.get("client") if isinstance(data.get("client"), dict) else {}
                result = engine.draft_client_email(
                    client,
                    str(data.get("serviceType", "")),
                    sender_context=str(data.get("senderContext", "")),
                )
                return self._json({"ok": True, "draft": result})
            if path == "/api/outreach/email/send":
                approval_id = str(data.get("approvalId", ""))
                _edit_pending_approval(approval_id, "email", {
                    "to": str(data.get("to", "")).strip(),
                    "subject": str(data.get("subject", ""))[:300],
                    "body": str(data.get("body", ""))[:12000],
                })
                result = engine.send_approved_email(approval_id)
                return self._json({"ok": True, **result})
            if path == "/api/outreach/whatsapp/draft":
                client = data.get("client") if isinstance(data.get("client"), dict) else {}
                result = engine.draft_whatsapp(
                    client,
                    str(data.get("serviceType", "")),
                    sender_context=str(data.get("senderContext", "")),
                )
                return self._json({"ok": True, "draft": result})
            if path == "/api/outreach/whatsapp/open":
                approval_id = str(data.get("approvalId", ""))
                _edit_pending_approval(approval_id, "whatsapp", {
                    "phone": str(data.get("phone", "")).strip(),
                    "message": str(data.get("message", ""))[:4000],
                })
                result = engine.approved_whatsapp_link(approval_id)
                return self._json({"ok": True, **result})
            if path == "/api/outreach/call/draft":
                client = data.get("client") if isinstance(data.get("client"), dict) else {}
                result = engine.draft_call(
                    client,
                    str(data.get("serviceType", "")),
                    sender_context=str(data.get("senderContext", "")),
                )
                return self._json({"ok": True, "draft": result})
            if path == "/api/outreach/call/start":
                approval_id = str(data.get("approvalId", ""))
                _edit_pending_approval(approval_id, "call", {
                    "phone": str(data.get("phone", "")).strip(),
                    "script": str(data.get("script", ""))[:3000],
                })
                result = engine.start_approved_call(approval_id)
                return self._json({"ok": True, **result})
            return self._error("not found", 404)
        except PermissionError as exc:
            return self._error(str(exc), 403)
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            return self._error(str(exc), 500)


def run(host: str = "127.0.0.1", port: int = 8770) -> None:
    if host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("Opportunity Hunter may only bind to localhost")
    server = ThreadingHTTPServer(("127.0.0.1", port), HunterHandler)
    print(f"Opportunity Hunter: http://127.0.0.1:{port}")
    print("Search and drafting are automatic; email/WhatsApp/call actions require explicit approval.")
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local CodeCrafter Opportunity Hunter")
    parser.add_argument("--port", type=int, default=int(os.getenv("HUNTER_PORT", "8770")))
    args = parser.parse_args()
    run(port=args.port)


if __name__ == "__main__":
    main()
