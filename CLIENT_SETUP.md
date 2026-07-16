# CodeCrafter client setup

This package is the WhatsApp/social bridge. It is separate from the transcription app and CRM,
which should be delivered as their own web-app links so the client can use them on any device.

## Windows setup

1. Install Google Chrome and Ollama.
2. In a terminal, run `ollama pull llama3.1:8b` once.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the
   `chrome_extension` folder from this package.
4. Run `CodeCrafterSocialBridge.exe`. Windows Firewall may ask permission for local/private access;
   the bridge listens only on `127.0.0.1` and is not exposed to other computers.
5. Sign in to WhatsApp Web in the client's normal Chrome profile.
6. In CodeCrafter CRM, open **Settings → Integrations** and click **Copy desktop-app setup code**.
7. Open the extension settings, choose **CodeCrafter CRM**, and click **Paste setup code and connect**.
   The bridge saves and tests the endpoint and token automatically.

Run `CodeCrafterSocialBridge.exe --version` in a terminal to verify the packaged bridge version
without starting Ollama or the automation server.

## What is portable

- The package contains the Windows bridge executable and an independent Chrome extension folder.
- Client settings and CRM credentials stay in that client's Chrome profile.
- WhatsApp authentication stays in the client's own WhatsApp Web session.
- The CRM and transcription app can be used as separate HTTPS links on Windows, macOS, Linux,
  Android, or iOS. This bridge itself needs desktop Chrome/Edge because phone browsers do not run
  this extension or expose the WhatsApp Web page it controls.

## Safe send behavior

Each inbound WhatsApp message receives one durable send transaction. If WhatsApp does not expose a
confirmed outgoing bubble, the bridge marks the result uncertain and does not fill or click Send
again. Review the open chat manually before clearing browser storage or retrying.

If a pre-send attempt failed and the panel reports a retry cooldown, click **Retry this message
once** in the WhatsApp status panel. This button only clears failed attempts; it cannot repeat a
confirmed or uncertain send. The extension settings also include **Clear failed WhatsApp retry**.

## CRM synchronization

The extension can target CodeCrafter CRM, CreativeCRM, or another CodeCrafter-compatible webhook. Paste the endpoint and API token from the client's CRM, enable **Sync confirmed replies and follow-ups**, and run the connection test.

After LinkedIn, Instagram, Facebook, or WhatsApp visibly confirms a reply, the bridge sends the contact identity, incoming context, outgoing reply, and a seven-day follow-up task to that CRM. Compatible CRMs match existing contacts and create missing ones. Credentials remain in the client's Chrome profile.
