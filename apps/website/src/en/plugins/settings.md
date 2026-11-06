---
title: "Settings and state"
description: "Separate native configuration, private data, instance state and document content."
---

# Settings and state

Decide whether state belongs to the plugin, a particular view or a document before choosing persistence and synchronization.

## Native settings

API 3 contributes.settings contains modules, groups and items. Groups may connect to the plugin's modules or public host settings locations; they cannot insert into another plugin's settings.

Items support boolean, string, number, select and model values with valid defaults. The host renders and saves them; the background reads configuration.get().

Register configuration.onChange for immediate application and return a Promise that resolves when applying finishes. The ordinary configuration:changed event only observes saved data. Missing handlers, failure or timeout can cause the host to restart the plugin with the saved configuration.

## Custom settings header actions

A module's `view` may reference its own resource-free page view. Supporting hosts expose `ViewContext.setSettingsHeaderActions([{id,title,icon?,disabled?,progress?}])` and `onSettingsHeaderAction(id => ...)`. The host renders buttons beside the settings title; clicks return only to the originating view, which owns navigation.

Each call replaces the list with up to four actions. IDs must be unique (up to 64 characters), with single-line titles up to 40 characters. Icons are `settings`, `download`, `refresh`, `add`, `back` or `more`. For example, submit `[{id:'downloads',title:'Downloads 2',icon:'download'}]`, resubmit when the count changes, and use `[]` to clear.

Omit `progress` for the regular icon, use `null` for an indeterminate ring, or a finite number from `0` to `100` for a ring with an integer percentage. Counts remain in the title (for example, `Download history 3`). Supply real progress only; do not estimate a percentage with an unknown total. Prompt users to upgrade if an older host rejects the field.

Subscribe before submitting actions. Navigation away, disabling or view disposal removes them; fetch current business state and submit again on return. Only settings-module view instances qualify, not regular navigation pages. Parent DOM access and custom HTML are not supported. Keep the API 3 manifest and check that both methods exist; prompt users to upgrade older hosts.

## Private business data

Background storage get/set persists private JSON. Views read and write through their own commands; use broadcasts for changes and fetch an initial snapshot.

Do not duplicate native settings in storage. Increment `dataVersion` and implement `migrate(previous,from,to)` for structural changes, preserving old data when migration fails.

Manage engines and weights with [inference resources](./inference#prepare-resources). Store inference credentials through `inference.credentials`; [host connection settings](./capabilities#mcp) own MCP credentials. Do not put secrets in configuration, storage or view state.

Store binary content in resources or documents, with IDs and revisions in JSON. Do not encode large files into ordinary state.

## Instance state

Resource tabs and regular mounted panels may use state/setState for reading positions and filters. Navigation pages, decorations, slots and replacement controls do not use this persistence channel.

Compare stateVersion with expectedStateVersion when upgrading, convert and save. Keep layout separate from business data and avoid one global reading position for multiple files.

## Conditions and events

The UI when declaration uses public page context. For settings drafts, model or task availability, declare a condition function and its inputs and register it through conditions.register. Conditions grant no additional data access.

Events on supports exact names and scoped namespace matching. Read a snapshot before changes; ordinary events do not replay history or await asynchronous listeners. See the [API reference](./api) for event types. For [view data](./views#read-only-data-and-bound-scope), `data.observe` delivers the initial snapshot itself: do not add read-then-observe or replace subscriptions with polling.

## Verify restoration

Check immediate application, navigation away and back, disabling and enabling, and application restart. Preserve a repair path for old configuration outside a new valid range; one invalid field should not erase other settings or user content.
