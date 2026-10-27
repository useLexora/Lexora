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

## Private business data

Background storage get/set persists private JSON. Views read and write through their own commands; use broadcasts for changes and fetch an initial snapshot.

Do not duplicate native settings in storage. Increment dataVersion and implement migrate(previous,from,to) for structural changes, preserving old data when migration fails.

Store binary content in resources or documents, with IDs and revisions in JSON. Do not encode large files into ordinary state.

## Instance state

Resource tabs and regular mounted panels may use state/setState for reading positions and filters. Navigation pages, decorations, slots and replacement controls do not use this persistence channel.

Compare stateVersion with expectedStateVersion when upgrading, convert and save. Keep layout separate from business data and avoid one global reading position for multiple files.

## Conditions and events

The UI when declaration uses public page context. For settings drafts, model or task availability, declare a condition function and its inputs and register it through conditions.register. Conditions grant no additional data access.

Events on supports exact names and scoped namespace matching. Read a snapshot before changes; ordinary events do not replay history or await asynchronous listeners. See the [API reference](./api) for event types.

## Verify restoration

Check immediate application, navigation away and back, disabling and enabling, and application restart. Preserve a repair path for old configuration outside a new valid range; one invalid field should not erase other settings or user content.
