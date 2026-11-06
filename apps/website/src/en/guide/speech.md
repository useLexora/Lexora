---
title: "Speech input and read-aloud"
description: "Configure transcription and read-aloud sources, test microphones and voices, and understand system speech, model services, and local plugins."
---

# Speech input and read-aloud

Speech input turns your voice into text; read-aloud turns reply text into audio. Enable them separately and choose different sources. Your chat model does not need to support both.

## Choose a source

Open **Settings → Voice**.

| Capability | Sources | Prepare |
| --- | --- | --- |
| Speech input | Available transcription models, including capable plugins | An enabled model, microphone permission, and an input device |
| Read-aloud | System voices, or available speech-synthesis models and plugins | A usable voice and audio output device |

Speech models need the correct purpose, authentication, and protocol support. Enabling a chat model alone is not enough. A service's chat login does not necessarily provide a separate speech API. System languages and voices depend on your operating system and device.

## Configure speech input

1. Enable speech input and select a transcription model.
2. Allow microphone access in the operating system. Use **Test microphone** and check the level meter.
3. Use the short transcription test, finish recording, and inspect the text. Select a language if the source supports it.
4. Use speech input in a task, then check the transcript before sending.

A microphone test confirms audio capture, not transcription availability. Test a short phrase before a long recording. Recognized text may remain after an interruption; check it before adding the same words again.

## Configure read-aloud

1. Enable speech output and choose a system voice or synthesis model.
2. Choose a voice, enter a voice ID, or adjust the supported rate settings.
3. Use **Preview** to check volume, language, and pronunciation.
4. Use read-aloud on a reply with readable text. Cancel during preparation or stop playback.

If the voice list fails to load, enter an ID manually only when you know a valid one. If no system voices are available, check the system's speech components or choose a configured model source.

## Where the data goes

Remote transcription sends recordings to the selected service; remote synthesis sends the text to be read. System read-aloud does not use your selected chat model; its capabilities come from the operating system. Corresponding [local plugin](./local-models) inference runs on your computer, but preparing resources may use networking.

Transcription tests and previews make real calls to the selected source and may incur remote-service charges. Local speech does not make chat, web tools, or other features offline.

## Recording or playback fails

- **No microphone level:** check system permission, the default input device, mute settings, and device availability.
- **Recording works but no text appears:** check model availability, language, credentials, credits, and networking; check the engine for local sources.
- **No playback:** test the output device and volume, then check the voice ID, model availability, and error.
- **Interrupted connection:** keep recognized text and retry manually after fixing the cause. Interruption does not establish that no charges occurred.

See [Troubleshooting](./troubleshooting#speech-input-or-read-aloud-is-unavailable).
