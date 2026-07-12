"""Local HTTP bridge between the Chrome extension and Ollama decisions."""
from __future__ import annotations

import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def run_server(bot) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            logging.info("Extension: " + fmt, *args)

        def reply(self, payload, status=200):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)

        def do_GET(self):
            self.reply({"ok": True, "version": bot.APP_VERSION})

        def do_POST(self):
            size = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(size) or b"{}")
            if self.path == "/result":
                level = logging.INFO if data.get("ok") else logging.ERROR
                logging.log(level, "Browser action result: ok=%s reason=%s", data.get("ok"), data.get("reason"))
                if data.get("ok") and data.get("kind") in {"like", "comment", "post", "message", "connection"}:
                    state = bot.load_state()
                    counter = {"like": "likes", "comment": "comments", "post": "posts",
                               "message": "messages", "connection": "connections"}[data["kind"]]
                    state[counter] += 1
                    url = data.get("url", "")
                    if data["kind"] == "connection" and url:
                        state["pending_connections"] = [p for p in state["pending_connections"] if p.get("url") != url]
                        state["pending_connections"].append({"url": url, "last_checked": ""})
                    elif data["kind"] == "message" and url:
                        state["pending_connections"] = [p for p in state["pending_connections"] if p.get("url") != url]
                    bot.save_state(state)
                    bot.record_metric(f"confirmed_{data['kind']}", count=state[counter])
                    logging.info("Confirmed daily counter updated: %s=%s", counter, state[counter])
                return self.reply({"received": True})
            if self.path == "/next-pending-connection":
                state = bot.load_state()
                pending = state.get("pending_connections", [])
                if not pending:
                    return self.reply({"url": ""})
                candidate = min(pending, key=lambda item: item.get("last_checked", ""))
                candidate["last_checked"] = bot.datetime.now().isoformat(timespec="seconds")
                bot.save_state(state)
                return self.reply({"url": candidate.get("url", "")})
            if self.path == "/draft-message":
                state = bot.load_state()
                if state["messages"] >= bot.STRATEGY["daily_limits"]["messages"]:
                    return self.reply({"allowed": False, "reason": "daily message limit reached"})
                result = bot.draft_relationship_message(data.get("context", ""), data.get("stage", "accepted"))
                bot.record_metric("message_drafted", stage=data.get("stage", "accepted"), allowed=result.get("allowed"))
                return self.reply(result)
            if self.path == "/draft-connection":
                state = bot.load_state()
                if state["connections"] >= bot.STRATEGY["daily_limits"]["connections"]:
                    return self.reply({"allowed": False, "reason": "daily connection limit reached"})
                result = bot.draft_relationship_message(data.get("profile", ""), "connection")
                bot.record_metric("connection_drafted", allowed=result.get("allowed"), profile_url=data.get("url"))
                return self.reply(result)
            if self.path == "/daily-post":
                state = bot.load_state()
                try:
                    result = bot.generate_daily_post(data.get("samples", []), state)
                except Exception as exc:
                    logging.exception("Daily post generation failed")
                    return self.reply({"allowed": False, "reason": str(exc)}, 500)
                bot.record_metric("daily_post_drafted", allowed=result.get("allowed"), category=result.get("category"))
                return self.reply(result)
            if self.path != "/cycle": return self.reply({"error": "not found"}, 404)
            diagnostics = data.get("diagnostics", {})
            logging.info(
                "Browser diagnostics: extension=%s headings=%s listitems=%s scroll=%s url=%s",
                diagnostics.get("extensionVersion", "old/unknown"),
                diagnostics.get("feedHeadings", "?"),
                diagnostics.get("listItems", "?"),
                diagnostics.get("scrollTop", "?"),
                diagnostics.get("url", "?"),
            )
            state = bot.load_state()
            received = len(data.get("posts", []))
            checked = 0
            last_reason = "No visible posts found"
            logging.info("Scan received %d visible non-promoted posts", received)
            for item in data.get("posts", []):
                analysis = bot.relevant_post(item.get("text", ""))
                checked += 1
                last_reason = f"post {checked}: {analysis.get('score', 0)}/100 — {analysis.get('reason', 'no reason')}"
                logging.info("Ollama checked %s", last_reason)
                bot.record_metric("post_scored", score=analysis.get("score", 0), relevant=analysis.get("relevant", False))
                if not analysis.get("relevant") or int(analysis.get("score", 0)) < 70: continue
                action = {"index": item["index"], "like": False, "comment": "", "authorUrl": item.get("authorUrl", "")}
                if state["likes"] < bot.SETTINGS.max_likes_per_day and not item.get("liked"):
                    action["like"] = True
                if state["comments"] < bot.SETTINGS.max_comments_per_day and not item.get("alreadyCommented"):
                    draft = bot.generate_comment(item["text"])
                    review = bot.evaluate_comment(item["text"], draft)
                    if review.get("pass") and int(review.get("confidence", 0)) >= 75:
                        action["comment"] = draft
                if not action["like"] and not action["comment"]:
                    logging.info("Post %s was already handled; moving on", checked)
                    continue
                logging.info("Extension action selected: %s", action)
                return self.reply({"action": action, "received": received, "checked": checked, "last_reason": last_reason})
            self.reply({"action": None, "received": received, "checked": checked, "last_reason": last_reason})

    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print("Connected mode ready. Keep normal Chrome open on https://www.linkedin.com/feed/")
    print("Press Ctrl+C or create STOP to stop Python. Use the browser Pause button to pause.")
    try: server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt: pass
    finally: server.server_close()
