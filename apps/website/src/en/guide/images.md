---
title: "Image understanding, generation, and OCR"
description: "Configure native vision, independent image reading, image generation, reference images, and OCR, and verify generated results."
---

# Images

Image input, image reading, and image generation are different capabilities. Decide whether you need to understand an image, transcribe text, or create or edit an image.

## Choose the right capability

| Goal | Use | Keep in mind |
| --- | --- | --- |
| Understand a screenshot, photo, or chart | Native vision in the current model, or an independent image reader | The actual image is needed, not just its name or a summary |
| Compare images or inspect UI states | Supply related images together and specify the comparison | OCR cannot establish colors, layout, or switch states |
| Extract visible text | OCR or text extraction through an image reader | Transcription does not replace visual understanding |
| Create an image from a description | An image-generation model | Select it separately from the chat model |
| Generate or edit using an existing image | A reference-capable editing route | Image counts and parameters depend on the service |

## Native vision and independent reading

Add an image to a task and describe what to inspect. A vision-capable current model can directly understand images that fit its protocol and budget. A path reference alone still requires reading the image.

Open **Settings → Model services** and find the **Images** section. **Image understanding** offers:

- **Auto**: native vision can be preferred when supported, alongside configured image-reading targets.
- **Current model**: use the task model's image capability; this does not give a text-only model vision.
- **Selected**: send image reading to a separately chosen model and use its result in the task.

An independent reader is useful when the main model lacks vision or you prefer another visual model. Images may go to another service; check the selection and data scope. A previous textual reading is not permanently complete evidence of the original image.

## Generation and reference images

Select an available model under **Settings → Model services → Images → Image generation**. Online services need authentication and the relevant enabled model. [Local model plugins](./local-models) need prepared engines and resources.

Describe the subject, purpose, style, and output location. For references, add images and explain what to preserve and change. Give each image a role when supplying several. Editing requires an available reference-capable route; not every generator supports it.

Size, quality, and transparency parameters are requests, not guarantees. After generation, open the actual file and check its content, dimensions, and transparency before delivery.

## OCR and document images

Enable and configure independent OCR under **OCR** in the same **Images** section. When disabled, text extraction follows image-reading settings. Independent OCR sends images to the configured OCR endpoint.

“Transcribe this screenshot” suits OCR. “Is this option enabled?” or “Compare these layouts” needs visual understanding. For scanned pages and document structure, also see [Documents](./documents).

## Failed, unknown, and incomplete saves

| Status | What to do |
| --- | --- |
| Generation failed | Check the failure stage, credentials, credits, and parameters before retrying |
| Generation result unknown | The request may have been submitted; check service records and existing outputs before resubmitting |
| Image saving incomplete | Images were returned; inspect saved files, destination permissions, and free space before paying for another generation |
| Duplicate generation blocked | A request in this turn is still running or unresolved; resolve that request first |

Stopping a task or losing a connection does not prove that remote generation was cancelled or charges refunded. See [Troubleshooting](./troubleshooting#images-cannot-be-read-or-generated).
