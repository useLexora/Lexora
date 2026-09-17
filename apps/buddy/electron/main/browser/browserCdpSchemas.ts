import { z } from 'zod'

export const cdpAxValueSchema = z.object({
  value: z.unknown().optional(),
}).passthrough()

export const cdpAxPropertySchema = z.object({
  name: z.string(),
  value: cdpAxValueSchema,
}).passthrough()

export const cdpAxNodeSchema = z.object({
  backendDOMNodeId: z.number().int().positive().optional(),
  description: cdpAxValueSchema.optional(),
  frameId: z.string().min(1).optional(),
  ignored: z.boolean(),
  name: cdpAxValueSchema.optional(),
  nodeId: z.string().min(1),
  parentId: z.string().min(1).optional(),
  properties: z.array(cdpAxPropertySchema).optional(),
  role: cdpAxValueSchema.optional(),
  value: cdpAxValueSchema.optional(),
}).passthrough()

export const cdpAxTreeSchema = z.object({
  nodes: z.array(cdpAxNodeSchema),
}).passthrough()

export const cdpDocumentSchema = z.object({
  root: z.object({
    frameId: z.string().min(1).optional(),
  }).passthrough(),
}).passthrough()

export const cdpFrameTreeNodeSchema = z.object({
  childFrames: z.array(z.unknown()).optional(),
  frame: z.object({
    id: z.string().min(1),
  }).passthrough(),
}).passthrough()

export const cdpFrameTreeSchema = z.object({
  frameTree: z.unknown(),
}).passthrough()

export const cdpRectangleSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
])

export const cdpDomSnapshotSchema = z.object({
  documents: z.array(z.object({
    frameId: z.number().int().nonnegative(),
    layout: z.object({
      bounds: z.array(cdpRectangleSchema),
      nodeIndex: z.array(z.number().int().nonnegative()),
      text: z.array(z.number().int()).optional(),
    }),
    nodes: z.object({
      attributes: z.array(z.array(z.number().int().min(-1))).optional(),
      backendNodeId: z.array(z.number().int().nonnegative()),
      nodeName: z.array(z.number().int().nonnegative()).optional(),
    }),
  })),
  strings: z.array(z.string()),
})

export const cdpLayoutMetricsSchema = z.object({
  cssVisualViewport: z.object({
    clientHeight: z.number().nonnegative(),
    clientWidth: z.number().nonnegative(),
    pageX: z.number(),
    pageY: z.number(),
  }),
})

export const cdpResolveNodeSchema = z.object({
  object: z.object({
    objectId: z.string().min(1),
  }).passthrough(),
}).passthrough()

export const cdpRuntimeResultSchema = z.object({
  exceptionDetails: z.unknown().optional(),
  result: z.object({
    value: z.unknown().optional(),
  }).passthrough(),
}).passthrough()

export const cdpBoxModelSchema = z.object({
  model: z.object({
    border: z.array(z.number()).length(8),
    content: z.array(z.number()).length(8),
  }).passthrough(),
}).passthrough()

export const browserTargetFieldMetadataSchema = z.object({
  ariaLabel: z.string().max(1_024),
  autocomplete: z.string().max(1_024),
  id: z.string().max(1_024),
  label: z.string().max(1_024),
  name: z.string().max(1_024),
  placeholder: z.string().max(1_024),
  type: z.string().max(1_024),
}).strict()

export const browserTargetActionabilitySchema = z.object({
  connected: z.boolean(),
  covered: z.boolean(),
  disabled: z.boolean(),
  editable: z.boolean(),
  fieldMetadata: browserTargetFieldMetadataSchema,
  focusable: z.boolean(),
  readOnly: z.boolean(),
  selectable: z.boolean(),
  stable: z.boolean(),
  visible: z.boolean(),
}).strict()

export type CdpAxNode = z.infer<typeof cdpAxNodeSchema>
export type CdpAxProperty = z.infer<typeof cdpAxPropertySchema>
