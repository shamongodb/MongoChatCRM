# Troubleshooting: "Technical error" when prepending notes to a Google Doc

When you see a message like *"I encountered a technical error while trying to prepend your notes to the Ongoing notes document"* (Drive/Docs integration), the script’s `appendNotesToDoc` call failed. Use the steps below to find and fix the cause.

---

## 1. Check the exact error (Apps Script Executions)

The script returns an `error` string to the caller. To see the real message:

1. Open [script.google.com](https://script.google.com) and open your Apps Script project (or run `clasp open` from this repo).
2. Go to **Executions** (left sidebar, clock icon).
3. Find the most recent execution for the time you tried to prepend.
4. Open it and look at the **Error** or at the returned value; the message will indicate what failed.

After the latest script changes, errors are more descriptive (e.g. permission vs. document not found).

---

## 2. Most common cause: **Permission**

The script runs as the **Google account that authorized the Web App** (or the owner, depending on deployment). That account must be able to **edit** the Doc.

**Fix:**

- Open the Doc (e.g. [your doc](https://docs.google.com/document/d/1RBAYAdCvpkdUAvg2ZgE7h8sISiX0iKVKKZXDckTT3e4/edit)).
- Click **Share**.
- Add the **same Google account that runs the script** with **Editor** access (or ensure it’s already there with Editor).
- If the Doc is in a **Shared Drive**, that account must have edit access to the Shared Drive/folder as well.

Then try prepending again.

---

## 3. Wrong or invalid document ID

If the tool receives a folder ID, a truncated ID, or a wrong link, `DocumentApp.openById()` can throw (e.g. "Document is missing" or "Invalid argument").

**Fix:**

- The script now accepts either:
  - The document ID only, e.g. `1RBAYAdCvpkdUAvg2ZgE7h8sISiX0iKVKKZXDckTT3e4`
  - Or the full Doc URL; the ID is extracted automatically.
- Ensure the flow that calls `appendNotesToDoc` passes the **Doc’s fileId** (from `getOrCreateNotesDoc` / `findNotesInFolder`), not a folder ID or a different file.

For your Echostar “Ongoing notes” doc, the correct ID from the link is:  
`1RBAYAdCvpkdUAvg2ZgE7h8sISiX0iKVKKZXDckTT3e4`.

---

## 4. Document deleted or moved

If the Doc was deleted or the link points to a file that no longer exists, the API returns an error.

**Fix:** Confirm the Doc still exists at the same link and that the script is using that document’s ID.

---

## 5. Deploy and push the latest script

If you pulled the latest code that improves error handling:

1. From the repo: `clasp push` (from the repo root; only `appsscript-backend/` is pushed per `.clasp.json`).
2. In the Apps Script editor: **Deploy → Manage deployments → Edit (pencil) → New version → Deploy.**

Then reproduce the prepend; the error message in the tool response (or in Executions) should be clearer.

---

## Quick checklist

| Check | Action |
|-------|--------|
| Script has Editor access to the Doc | Share the Doc with the script’s Google account (Editor). |
| Shared Drive | Script account must have edit access on the drive/folder. |
| Correct fileId | Use the Doc ID (or full Doc URL), not a folder ID. |
| Doc still exists | Open the link and confirm the file is there. |
| See exact error | Apps Script → Executions → latest run → Error or return value. |

If you want to retry prepending, use “try again later” in the assistant; after fixing sharing or the fileId, it should succeed. You can also use “provide the formatted notes for manual use” and paste them into the Doc yourself.

---

## 6. Document has Google Docs "tabs"

If the Doc uses **tabs** (the organizational tabs feature in Docs, like sheets in a spreadsheet), the script only inserts into **one** tab:

- **Without** `tabId` or `tabTitle`: content is inserted into the **first tab** (same as `Document.getBody()`).
- If your "Meeting notes" (or "Ongoing notes") content lives in a **different tab**, prepend would go into the first tab instead.

**Fix:**

- Use **`tabTitle`** when calling the tool: e.g. set `tabTitle` to the exact tab name (e.g. `"Meeting notes"`). The script will find that tab and prepend there. Matching is case-insensitive.
- Or use **`tabId`** if you have it (from the tab's URL when you open that tab in the Doc).

After the latest script update, the `appendNotesToDoc` tool accepts optional **`tabId`** and **`tabTitle`**. For the "Meeting notes" section in a tabbed Echostar doc, the flow should pass `tabTitle: "Meeting notes"` (or whatever that tab is named) so notes go into the correct tab.
