# Canvas MCP — setup

Gives Claude the Canvas LMS API: 144 spec files to search, and live calls made **as you**, with your own permissions. Nothing you cannot already see in Canvas.

Server: `https://mcp-canvas-openapi.ismysimpleproject.com/mcp`

Everyone needs one thing first: a Canvas access token.

## Step 0 — make a Canvas token

1. Open <https://na.instructure.com/profile/settings>
2. Scroll to **Approved Integrations** → **+ New Access Token**
3. Purpose: anything (`Claude`). Expires: leave blank.
4. **Generate Token**, then copy it — Canvas shows it once.

Keep it handy for the next step. If you lose it, delete that entry and make another.

---

## Claude on the web (claude.ai)

1. **Settings → Connectors → Add custom connector**
2. Name it `Canvas`, URL:
   ```
   https://mcp-canvas-openapi.ismysimpleproject.com/mcp
   ```
3. On the next screen take the two options marked **Detected**:
   - Authentication → **Always required**
   - OAuth client → **No client ID — register one automatically**

   Leave *Additional request headers* empty and the transport on *Streamable HTTP*.
4. Click **Connect**. A page opens with a single box — paste your Canvas token and press **Connect**.
5. Done. The connector shows as connected and the Canvas tools appear in chat.

That page is intentionally bare. If the token is wrong it says so and you can paste again.

## Claude Code (CLI)

One command, with the Canvas token as a header:

```bash
claude mcp add --transport http canvas \
  https://mcp-canvas-openapi.ismysimpleproject.com/mcp \
  --header "Authorization: Bearer <your Canvas token>"
```

Check it: `claude mcp list` → `canvas: ✓ connected`.

No OAuth involved here — the CLI can set headers, so it sends the Canvas token directly. Both methods work at the same time against the same server.

---

## Using it

Ask in plain language: *"find the Canvas endpoint for listing a course's assignments"*, *"what's my Canvas profile"*, *"list my active courses"*.

Tools: `list_services`, `search_endpoints`, `get_endpoint`, `list_schemas`, `get_schema`, `call_endpoint` (the live one).

**One quirk**: spec paths start at `/v1/...`, not `/api/v1/...` — the server already includes `/api` in the base URL. A wall of HTML instead of JSON usually means a doubled prefix.

## When something breaks

| Symptom | Cause | Fix |
|---|---|---|
| "Your stored API token is no longer valid" | Token deleted or expired in Canvas | Make a new token, reconnect the connector |
| Consent page says Canvas refused the token | Partial copy, or the token was deleted | Copy it again from Canvas settings |
| `401` in Claude Code | Header missing or wrong token | Re-run `claude mcp add` with the right token |
| A call returns `401` but tools work | Admin-only endpoint (e.g. `accounts`, `sis_imports`) | Nothing to fix — your account lacks that permission |

To disconnect: delete the connector in claude.ai, and delete the token under **Approved Integrations** in Canvas. Deleting the Canvas token alone is enough to cut off access immediately.
