"""Local HTTP bridge between the Chrome extension and Ollama decisions."""
from __future__ import annotations

import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def run_server(bot) -> None:
    extension_status = {"seen": False}

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
            if self.path == "/extension-status":
                return self.reply(extension_status)
            self.reply({"ok": True, "version": bot.APP_VERSION})

        def do_POST(self):
            size = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(size) or b"{}")
            if self.path == "/extension-heartbeat":
                site = data.get("site", "unknown")
                status = {
                    "seen": True,
                    "version": data.get("extensionVersion", "old/unknown"),
                    "build": data.get("extensionBuild", "old/unknown"),
                    "url": data.get("url", "?"),
                    "seen_at": bot.datetime.now().isoformat(timespec="seconds"),
                }
                extension_status.update(status)
                extension_status.setdefault("sites", {})[site] = status
                logging.info("Extension heartbeat: site=%s version=%s build=%s url=%s",
                             site, status["version"], status["build"], status["url"])
                return self.reply({"received": True, "site": site})
            if self.path == "/result":
                level = logging.INFO if data.get("ok") else logging.ERROR
                logging.log(level, "Browser action result: ok=%s reason=%s", data.get("ok"), data.get("reason"))
                supported = {"like", "comment", "message", "connection", "notification_reply",
                             "instagram_like", "instagram_story_view"}
                if data.get("ok") and data.get("kind") in supported:
                    state = bot.load_state()
                    counter = {"like": "likes", "comment": "comments",
                               "message": "messages", "connection": "connections",
                               "notification_reply": "notification_replies",
                               "instagram_like": "instagram_likes",
                               "instagram_story_view": "instagram_story_views"}[data["kind"]]
                    state[counter] += 1
                    if data["kind"] == "instagram_like":
                        state["instagram_likes_since_stories"] += 1
                    url = data.get("url", "")
                    if data["kind"] == "connection" and url:
                        state["pending_connections"] = [p for p in state["pending_connections"] if p.get("url") != url]
                        state["pending_connections"].append({"url": url, "last_checked": ""})
                    elif data["kind"] == "message" and url:
                        state["pending_connections"] = [p for p in state["pending_connections"] if p.get("url") != url]
                    elif data["kind"] == "notification_reply":
                        notification_id = data.get("notificationId", "")
                        if notification_id and notification_id not in state["replied_notification_ids"]:
                            state["replied_notification_ids"].append(notification_id)
                            state["replied_notification_ids"] = state["replied_notification_ids"][-1000:]
                    bot.save_state(state)
                    bot.record_metric(f"confirmed_{data['kind']}", count=state[counter])
                    logging.info("Confirmed daily counter updated: %s=%s", counter, state[counter])
                return self.reply({"received": True})
            if self.path == "/instagram-status":
                diagnostics = data.get("diagnostics", {})
                extension_status.update({
                    "seen": True,
                    "version": diagnostics.get("extensionVersion", "old/unknown"),
                    "build": diagnostics.get("extensionBuild", "old/unknown"),
                    "url": "https://www.instagram.com/",
                    "seen_at": bot.datetime.now().isoformat(timespec="seconds"),
                })
                state = bot.load_state()
                interval = bot.STRATEGY["instagram"].get("story_interval_likes", 100)
                return self.reply({
                    "shouldWatchStories": state["instagram_likes_since_stories"] >= interval,
                    "confirmedLikesSinceStories": state["instagram_likes_since_stories"],
                    "likesUntilStories": max(0, interval - state["instagram_likes_since_stories"]),
                })
            if self.path == "/instagram-story-batch-complete":
                state = bot.load_state()
                completed_likes = state["instagram_likes_since_stories"]
                interval = bot.STRATEGY["instagram"].get("story_interval_likes", 100)
                state["instagram_likes_since_stories"] = 0
                bot.save_state(state)
                bot.record_metric("instagram_story_batch_complete", likes=completed_likes,
                                  story_views=state["instagram_story_views"])
                return self.reply({"completed": True, "nextStoryBatchAfterLikes": interval})
            if self.path == "/daily-followups":
                state = bot.load_state()
                due = bot.begin_daily_followups(state)
                bot.save_state(state)
                return self.reply({
                    "due": due,
                    "pendingConnections": [item.get("url", "") for item in
                                           state.get("pending_connections", []) if item.get("url")],
                })
            if self.path == "/notification-replies":
                state = bot.load_state()
                seen = set(state.get("replied_notification_ids", []))
                remaining = max(0, bot.STRATEGY["daily_limits"].get("notification_replies", 10)
                                - state.get("notification_replies", 0))
                candidates = [item for item in data.get("candidates", [])
                              if item.get("id") and item.get("id") not in seen]
                return self.reply({"candidates": candidates[:remaining]})
            if self.path == "/draft-notification-reply":
                result = bot.draft_notification_reply(
                    data.get("context", ""), data.get("notificationText", "")
                )
                bot.record_metric("notification_reply_drafted", allowed=result.get("allowed"),
                                  notification_id=data.get("notificationId", ""))
                return self.reply(result)
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
            if self.path != "/cycle": return self.reply({"error": "not found"}, 404)
            diagnostics = data.get("diagnostics", {})
            extension_status.update({
                "seen": True,
                "version": diagnostics.get("extensionVersion", "old/unknown"),
                "build": diagnostics.get("extensionBuild", "old/unknown"),
                "url": diagnostics.get("url", "?"),
                "seen_at": bot.datetime.now().isoformat(timespec="seconds"),
            })
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
            skipped = []
            logging.info("Scan received %d visible non-promoted posts", received)
            for item in data.get("posts", []):
                analysis = bot.relevant_post(item.get("text", ""))
                checked += 1
                last_reason = f"post {checked}: {analysis.get('score', 0)}/100 — {analysis.get('reason', 'no reason')}"
                logging.info("Ollama checked %s", last_reason)
                bot.record_metric("post_scored", score=analysis.get("score", 0), relevant=analysis.get("relevant", False))
                threshold = int(bot.STRATEGY.get("min_relevance_score", 55))
                if not analysis.get("relevant") or int(analysis.get("score", 0)) < threshold:
                    bot.record_skipped_post(item.get("text", ""), analysis)
                    skipped.append({"index": item.get("index"), "score": analysis.get("score", 0),
                                    "reason": analysis.get("reason", "no reason"),
                                    "topics": analysis.get("topics", [])})
                    continue
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
                    skipped.append({"index": item.get("index"), "score": analysis.get("score", 0),
                                    "reason": "already liked/commented or daily limit reached",
                                    "topics": analysis.get("topics", [])})
                    continue
                logging.info("Extension action selected: %s", action)
                return self.reply({"action": action, "received": received, "checked": checked,
                                   "last_reason": last_reason, "skipped": skipped})
            self.reply({"action": None, "received": received, "checked": checked,
                        "last_reason": last_reason, "skipped": skipped,
                        "skip_log": str(bot.SKIPPED_POST_TOPICS_FILE)})

    port = int(os.getenv("BRIDGE_PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("Connected mode ready. Keep normal Chrome open on https://www.linkedin.com/feed/")
    print("Press Ctrl+C or create STOP to stop Python. Use the browser Pause button to pause.")
    try: server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt: pass
    finally: server.server_close()
