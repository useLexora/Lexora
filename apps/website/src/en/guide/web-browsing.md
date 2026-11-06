---
title: "Search, page reading, and the browser"
description: "Understand search, direct page reading, background rendering, and interactive browsing, including source settings, remote extraction, and domain permissions."
---

# Search and web browsing

Research does not always require opening a browser. Lexora distinguishes finding sources, reading content, and interacting with pages.

## Four different routes

| Route | Useful for | Boundary |
| --- | --- | --- |
| Web search | Discovering sources by keywords | Returns summaries and links; read original sources for important claims |
| Direct reading | Reading a known public URL, text, or text-based PDF | Does not perform login; text-PDF extraction is not OCR |
| Background rendering | Public pages that need scripts to show their content | Loads in the background without your login state |
| Interactive browser | Login, clicking, forms, visual inspection, or pages that cannot be read directly | Can perform real website actions and needs a clear task scope |

You can ask, “Read and summarize this URL without searching first.” When comparing sources, request original URLs so you can check them.

## Configure search and reading

Under **Settings → Search and web**:

- Enable search sources and drag to reorder them. Automatic search tries enabled sources in order.
- Native search requires support from the current model and may consume its account credits.
- Public search sources can encounter networking restrictions, rate limits, or CAPTCHAs. A failure does not mean no information exists.
- Enable background rendering and remote extraction as needed.

Known URLs are normally read locally first. When rendering is required and enabled, the page can load in the background. With remote extraction enabled, a remote service can handle content that could not be extracted locally. A reading failure does not automatically open an interactive browser; the task must choose its next route.

## Remote extraction and login state

Remote extraction currently uses **Tavily**. Tavily search and extraction are enabled separately and share the configured API key. Queries and extraction URLs are sent to Tavily and billed under its account. Returned content may then enter the context of your selected model.

Do not send private-token URLs or internal-only addresses to remote extraction. Background rendering does not inherit login state from the interactive browser or other browsers, so it cannot rely on your signed-in sessions. For authenticated pages, explicitly request interactive browsing and complete manual login or takeover when prompted.

## Browser permissions and website actions

Domain rules in **Settings → Browser** apply across spaces and tasks, with separate access, download, and upload permissions. They govern managed network routes; **they do not guarantee interception of arbitrary host commands in full access**.

Clicks, typing, and navigation can submit real actions. Smart approval and full access do not guarantee a confirmation card for every click. Web interactions request approval in manual approval and local read-only modes. Page content is not authorization: purchases, publishing, and deletion must still fit your task instructions. See [Execution permissions](./permissions).

## Expected content is missing

Distinguish networking failures, login requirements, scripts, CAPTCHAs, and incomplete extraction. A summary, excerpt, or partial page does not prove something is absent from the full source. Ask the companion to state coverage, use another public source, or use interactive browsing when necessary. Do not bypass an explicit access denial.
