import { z } from 'zod'
import { AuditUserSummarySchema } from '../identity'
import { TiptapJsonContentPayloadSchema } from '../tiptap/core'
import {
  DOCUMENT_PUBLICATION_ENTRY_STATUS,
  DOCUMENT_PUBLICATION_ENTRY_STATUS_VALUES,
  DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET_VALUES,
  DOCUMENT_PUBLICATION_NAV_ITEM_ICON_MAX_LENGTH,
  DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET,
  DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET_VALUES,
  DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH,
  DOCUMENT_PUBLICATION_NAV_ITEM_MAX_COUNT,
  DOCUMENT_PUBLICATION_NAV_ITEM_TYPE,
  DOCUMENT_PUBLICATION_NAV_ITEM_TYPE_VALUES,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE_VALUES,
  DOCUMENT_PUBLICATION_SITE_FOOTER_COPYRIGHT_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_FOOTER_MESSAGE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_ACTION_HREF_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_ACTION_LABEL_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_ACTION_MAX_COUNT,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_DETAILS_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_ICON_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_MAX_COUNT,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_TITLE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_MODE_VALUES,
  DOCUMENT_PUBLICATION_SITE_HOME_NAME_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_TAGLINE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_TEXT_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_MEDIA_KIND_VALUES,
  DOCUMENT_PUBLICATION_SITE_STATUS_VALUES,
  DOCUMENT_PUBLICATION_SITE_THEME_VALUES,
  DOCUMENT_PUBLICATION_SITE_TITLE_MAX_LENGTH,
  DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE_VALUES,
  DOCUMENT_SINGLE_PUBLICATION_SCOPE_VALUES,
  DOCUMENT_SINGLE_PUBLICATION_STATE_VALUES,
  DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE_VALUES,
} from './publication/constants'

export {
  DOCUMENT_PUBLICATION_DEFAULT_SITE_HOME_CONFIG,
  DOCUMENT_PUBLICATION_ENTRY_STATUS,
  DOCUMENT_PUBLICATION_ENTRY_STATUS_VALUES,
  DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET,
  DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET_VALUES,
  DOCUMENT_PUBLICATION_NAV_ITEM_ICON_MAX_LENGTH,
  DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET,
  DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET_VALUES,
  DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH,
  DOCUMENT_PUBLICATION_NAV_ITEM_MAX_COUNT,
  DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH,
  DOCUMENT_PUBLICATION_NAV_ITEM_TYPE,
  DOCUMENT_PUBLICATION_NAV_ITEM_TYPE_VALUES,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE_VALUES,
  DOCUMENT_PUBLICATION_SITE_FOOTER_COPYRIGHT_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_FOOTER_MESSAGE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_ACTION_HREF_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_ACTION_LABEL_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_ACTION_MAX_COUNT,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_DETAILS_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_ICON_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_ICON_MEDIA_MAX_BYTES,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_MAX_COUNT,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_TITLE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_LOGO_MEDIA_MAX_BYTES,
  DOCUMENT_PUBLICATION_SITE_HOME_MODE,
  DOCUMENT_PUBLICATION_SITE_HOME_MODE_VALUES,
  DOCUMENT_PUBLICATION_SITE_HOME_NAME_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_TAGLINE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_TEXT_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_LOGO_MEDIA_MAX_BYTES,
  DOCUMENT_PUBLICATION_SITE_MEDIA_KIND,
  DOCUMENT_PUBLICATION_SITE_MEDIA_KIND_VALUES,
  DOCUMENT_PUBLICATION_SITE_MEDIA_MAX_BYTES_BY_KIND,
  DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES,
  DOCUMENT_PUBLICATION_SITE_STATUS,
  DOCUMENT_PUBLICATION_SITE_STATUS_VALUES,
  DOCUMENT_PUBLICATION_SITE_THEME,
  DOCUMENT_PUBLICATION_SITE_THEME_VALUES,
  DOCUMENT_PUBLICATION_SITE_TITLE_MAX_LENGTH,
  DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE,
  DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE_LABELS,
  DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE_VALUES,
  DOCUMENT_SINGLE_PUBLICATION_ROUTE_PREFIX,
  DOCUMENT_SINGLE_PUBLICATION_SCOPE,
  DOCUMENT_SINGLE_PUBLICATION_SCOPE_LABELS,
  DOCUMENT_SINGLE_PUBLICATION_SCOPE_VALUES,
  DOCUMENT_SINGLE_PUBLICATION_STATE,
  DOCUMENT_SINGLE_PUBLICATION_STATE_VALUES,
  DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE,
  DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE_LABELS,
  DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE_VALUES,
  DOCUMENT_SITE_PUBLICATION_ROUTE_PREFIX,
} from './publication/constants'

export const DocumentSinglePublicationStateSchema = z.enum(DOCUMENT_SINGLE_PUBLICATION_STATE_VALUES)
export const DocumentSinglePublicationEffectiveStateSchema = z.enum(DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE_VALUES)
export const DocumentSinglePublicationScopeSchema = z.enum(DOCUMENT_SINGLE_PUBLICATION_SCOPE_VALUES)
export const PublicationSiteStatusSchema = z.enum(DOCUMENT_PUBLICATION_SITE_STATUS_VALUES)
export const PublicationEntryStatusSchema = z.enum(DOCUMENT_PUBLICATION_ENTRY_STATUS_VALUES)
export const PublicationSiteThemeSchema = z.enum(DOCUMENT_PUBLICATION_SITE_THEME_VALUES)
export const PublicationSiteHomeModeSchema = z.enum(DOCUMENT_PUBLICATION_SITE_HOME_MODE_VALUES)
export const PublicationSitePageScopeSchema = z.enum(DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE_VALUES)
export const PublicationSiteMediaKindSchema = z.enum(DOCUMENT_PUBLICATION_SITE_MEDIA_KIND_VALUES)
export const PublicationSiteCustomMediaScopeSchema = z.enum(DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE_VALUES)
export const PublicationNavItemTypeSchema = z.enum(DOCUMENT_PUBLICATION_NAV_ITEM_TYPE_VALUES)
export const PublicationNavItemInternalTargetSchema = z.enum(DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET_VALUES)
export const PublicationNavItemExternalTargetSchema = z.enum(DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET_VALUES)

const PublicationAuditFieldsSchema = {
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
}

function PublicationSafeHrefSchema(maxLength: number) {
  return z.string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine(isSafePublicationHrefValue, '仅支持 http(s) 链接或站内绝对路径')
}

const PublicationSiteHomeActionSchema = z.object({
  label: z.string().trim().min(1).max(DOCUMENT_PUBLICATION_SITE_HOME_ACTION_LABEL_MAX_LENGTH),
  href: PublicationSafeHrefSchema(DOCUMENT_PUBLICATION_SITE_HOME_ACTION_HREF_MAX_LENGTH),
  theme: z.enum(['brand', 'alt']).default('brand'),
}).strict()

const PublicationSiteHomeFeatureSchema = z.object({
  title: z.string().trim().min(1).max(DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_TITLE_MAX_LENGTH),
  details: z.string().trim().max(DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_DETAILS_MAX_LENGTH).nullable(),
  icon: z.string().trim().max(DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_ICON_MAX_LENGTH).nullable(),
}).strict()

export const PublicationSiteHomeConfigSchema = z.object({
  hero: z.object({
    name: z.string().trim().min(1).max(DOCUMENT_PUBLICATION_SITE_HOME_NAME_MAX_LENGTH),
    text: z.string().trim().min(1).max(DOCUMENT_PUBLICATION_SITE_HOME_TEXT_MAX_LENGTH),
    tagline: z.string().trim().max(DOCUMENT_PUBLICATION_SITE_HOME_TAGLINE_MAX_LENGTH).nullable(),
    imageUrl: z.string().trim().max(500).nullable(),
  }).strict(),
  actions: z.array(PublicationSiteHomeActionSchema).max(DOCUMENT_PUBLICATION_SITE_HOME_ACTION_MAX_COUNT),
  features: z.array(PublicationSiteHomeFeatureSchema).max(DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_MAX_COUNT),
  footer: z.object({
    message: z.string().trim().max(DOCUMENT_PUBLICATION_SITE_FOOTER_MESSAGE_MAX_LENGTH).nullable(),
    copyright: z.string().trim().max(DOCUMENT_PUBLICATION_SITE_FOOTER_COPYRIGHT_MAX_LENGTH).nullable(),
  }).strict(),
}).strict()

export const PublicationSiteCustomMediaResponseSchema = z.object({
  mediaUrl: z.string().trim().min(1).max(500),
}).strict()

export const UpsertPublicationSiteSettingsSchema = z.object({
  workspaceId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(DOCUMENT_PUBLICATION_SITE_TITLE_MAX_LENGTH).optional(),
  description: z.string().trim().max(240).nullable().optional(),
  logoUrl: z.string().trim().max(500).nullable().optional(),
  theme: PublicationSiteThemeSchema.optional(),
  homeMode: PublicationSiteHomeModeSchema.optional(),
  homeDocumentId: z.string().trim().nullable().optional(),
  homeConfig: PublicationSiteHomeConfigSchema.optional(),
  allowIndexing: z.boolean().optional(),
  status: PublicationSiteStatusSchema.optional(),
}).strict()

export const DocumentSinglePublicationSettingSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  state: DocumentSinglePublicationStateSchema,
  scope: DocumentSinglePublicationScopeSchema,
  ...PublicationAuditFieldsSchema,
}).strict()

export const UpdateDocumentSinglePublicationSettingSchema = z.object({
  state: DocumentSinglePublicationStateSchema,
  scope: DocumentSinglePublicationScopeSchema.optional(),
}).strict()

export const DocumentSinglePublicationInfoSchema = z.object({
  documentId: z.string(),
  setting: DocumentSinglePublicationSettingSchema.nullable(),
  singlePublicationState: DocumentSinglePublicationStateSchema,
  singlePublicationScope: DocumentSinglePublicationScopeSchema,
  effectivePublicationState: DocumentSinglePublicationEffectiveStateSchema,
  inheritedFromDocumentId: z.string().nullable(),
}).strict()

export interface DocumentSinglePublicationTreeItem {
  id: string
  title: string
  parentId: string | null
  hasChildren: boolean
  hasContent: boolean
  singlePublicationState: DocumentSinglePublicationState
  singlePublicationScope: DocumentSinglePublicationScope
  effectivePublicationState: DocumentSinglePublicationEffectiveState
  inheritedFromDocumentId: string | null
  children: DocumentSinglePublicationTreeItem[]
}

export const DocumentSinglePublicationTreeItemSchema: z.ZodType<DocumentSinglePublicationTreeItem> = z.lazy(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    parentId: z.string().nullable(),
    hasChildren: z.boolean(),
    hasContent: z.boolean(),
    singlePublicationState: DocumentSinglePublicationStateSchema,
    singlePublicationScope: DocumentSinglePublicationScopeSchema,
    effectivePublicationState: DocumentSinglePublicationEffectiveStateSchema,
    inheritedFromDocumentId: z.string().nullable(),
    children: z.array(DocumentSinglePublicationTreeItemSchema),
  }).strict(),
)

export const ListDocumentSinglePublicationsQuerySchema = z.object({
  workspaceId: z.string().trim().min(1),
}).strict()

export const ListDocumentSinglePublicationsResponseSchema = z.object({
  tree: z.array(DocumentSinglePublicationTreeItemSchema),
}).strict()

export const PublicationSiteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().trim().min(1).max(DOCUMENT_PUBLICATION_SITE_TITLE_MAX_LENGTH),
  description: z.string().trim().max(240).nullable(),
  logoUrl: z.string().trim().max(500).nullable(),
  theme: PublicationSiteThemeSchema,
  homeMode: PublicationSiteHomeModeSchema,
  homeDocumentId: z.string().nullable(),
  homeConfig: PublicationSiteHomeConfigSchema,
  allowIndexing: z.boolean(),
  status: PublicationSiteStatusSchema,
  ...PublicationAuditFieldsSchema,
}).strict()

export const CreatePublicationSectionSchema = z.object({
  workspaceId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(80),
  order: z.number().int().min(0).optional(),
}).strict()

export const UpdatePublicationSectionSchema = z.object({
  workspaceId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(80).optional(),
  order: z.number().int().min(0).optional(),
  collapsed: z.boolean().optional(),
  status: PublicationEntryStatusSchema.optional(),
}).strict()

export const CreatePublicationPageSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sectionId: z.string().trim().min(1),
  documentId: z.string().trim().min(1),
  scope: PublicationSitePageScopeSchema,
  order: z.number().int().min(0).optional(),
}).strict()

export const UpdatePublicationPageSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sectionId: z.string().trim().min(1).optional(),
  scope: PublicationSitePageScopeSchema.optional(),
  order: z.number().int().min(0).optional(),
  status: PublicationEntryStatusSchema.optional(),
}).strict()

const PublicationNavItemInputBaseSchema = z.object({
  id: z.string().trim().min(1).optional(),
  parentId: z.string().trim().nullable().optional(),
  label: z.string().trim().max(DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH).nullable().optional(),
  icon: z.string().trim().max(DOCUMENT_PUBLICATION_NAV_ITEM_ICON_MAX_LENGTH).nullable().optional(),
  order: z.number().int().min(0),
  status: PublicationEntryStatusSchema.default(DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE),
}).strict()

export const PublicationGroupNavItemInputSchema = PublicationNavItemInputBaseSchema.extend({
  type: z.literal(DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP),
  label: z.string().trim().min(1).max(DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH),
  target: z.null().optional(),
  targetId: z.null().optional(),
  url: z.null().optional(),
  openTarget: z.null().optional(),
}).strict()

export const PublicationInternalNavItemInputSchema = PublicationNavItemInputBaseSchema.extend({
  type: z.literal(DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL),
  target: PublicationNavItemInternalTargetSchema,
  targetId: z.string().trim().nullable(),
  url: z.null().optional(),
  openTarget: z.null().optional(),
}).strict().superRefine((item, ctx) => {
  if (!hasPublicationNavItemVisibleIdentity(item)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '导航名称和图标至少填写一个',
      path: ['label'],
    })
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME) {
    if (item.targetId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '首页导航不能携带目标 ID',
        path: ['targetId'],
      })
    }

    return
  }

  if (!item.targetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '内部导航目标不能为空',
      path: ['targetId'],
    })
  }
})

export const PublicationExternalNavItemInputSchema = PublicationNavItemInputBaseSchema.extend({
  type: z.literal(DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL),
  target: z.null().optional(),
  targetId: z.null().optional(),
  url: PublicationSafeHrefSchema(500),
  openTarget: PublicationNavItemExternalTargetSchema,
}).strict().superRefine((item, ctx) => {
  if (!hasPublicationNavItemVisibleIdentity(item)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '导航名称和图标至少填写一个',
      path: ['label'],
    })
  }
})

export const PublicationNavItemInputSchema = z.discriminatedUnion('type', [
  PublicationGroupNavItemInputSchema,
  PublicationInternalNavItemInputSchema,
  PublicationExternalNavItemInputSchema,
])

export const ReplacePublicationNavItemsSchema = z.object({
  workspaceId: z.string().trim().min(1),
  items: z.array(PublicationNavItemInputSchema).max(DOCUMENT_PUBLICATION_NAV_ITEM_MAX_COUNT),
}).strict()

export const PublicationSectionSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  title: z.string().trim().min(1).max(80),
  order: z.number().int().min(0),
  collapsed: z.boolean(),
  status: PublicationEntryStatusSchema,
  ...PublicationAuditFieldsSchema,
}).strict()

export const PublicationPageSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  sectionId: z.string(),
  documentId: z.string(),
  title: z.string().trim().min(1).max(120),
  scope: PublicationSitePageScopeSchema,
  order: z.number().int().min(0),
  status: PublicationEntryStatusSchema,
  ...PublicationAuditFieldsSchema,
}).strict()

export const PublicationGroupNavItemSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  parentId: z.string().nullable(),
  type: z.literal(DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP),
  label: z.string().trim().min(1).max(DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH),
  icon: z.string().trim().max(DOCUMENT_PUBLICATION_NAV_ITEM_ICON_MAX_LENGTH).nullable(),
  target: z.null(),
  targetId: z.null(),
  url: z.null(),
  openTarget: z.null(),
  order: z.number().int().min(0),
  status: PublicationEntryStatusSchema,
  ...PublicationAuditFieldsSchema,
}).strict()

export const PublicationInternalNavItemSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  parentId: z.string().nullable(),
  type: z.literal(DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL),
  label: z.string().trim().max(DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH).nullable(),
  icon: z.string().trim().max(DOCUMENT_PUBLICATION_NAV_ITEM_ICON_MAX_LENGTH).nullable(),
  target: PublicationNavItemInternalTargetSchema,
  targetId: z.string().nullable(),
  url: z.null(),
  openTarget: z.null(),
  order: z.number().int().min(0),
  status: PublicationEntryStatusSchema,
  ...PublicationAuditFieldsSchema,
}).strict()

export const PublicationExternalNavItemSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  parentId: z.string().nullable(),
  type: z.literal(DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL),
  label: z.string().trim().max(DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH).nullable(),
  icon: z.string().trim().max(DOCUMENT_PUBLICATION_NAV_ITEM_ICON_MAX_LENGTH).nullable(),
  target: z.null(),
  targetId: z.null(),
  url: PublicationSafeHrefSchema(500),
  openTarget: PublicationNavItemExternalTargetSchema,
  order: z.number().int().min(0),
  status: PublicationEntryStatusSchema,
  ...PublicationAuditFieldsSchema,
}).strict()

export const PublicationNavItemSchema = z.discriminatedUnion('type', [
  PublicationGroupNavItemSchema,
  PublicationInternalNavItemSchema,
  PublicationExternalNavItemSchema,
])

export const PublicationSiteManagementResponseSchema = z.object({
  site: PublicationSiteSchema.nullable(),
  sections: z.array(PublicationSectionSchema),
  pages: z.array(PublicationPageSchema),
  navItems: z.array(PublicationNavItemSchema),
}).strict()

export const PublicationRenderedDocumentSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  owner: AuditUserSummarySchema.nullable(),
  body: TiptapJsonContentPayloadSchema,
}).strict()

export const PublicationInternalLinkResolutionSchema = z.object({
  targetDocumentId: z.string(),
  label: z.string(),
  href: z.string().nullable(),
  published: z.boolean(),
  disabledReason: z.string().nullable(),
}).strict()

export const PublicationSiteMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  logoUrl: z.string().nullable(),
  theme: PublicationSiteThemeSchema,
  allowIndexing: z.boolean(),
}).strict()

export interface PublicationSidebarPage {
  id: string
  documentId: string
  title: string
  href: string
  children: PublicationSidebarPage[]
}

export const PublicationSidebarPageSchema: z.ZodType<PublicationSidebarPage> = z.lazy(() =>
  z.object({
    id: z.string(),
    documentId: z.string(),
    title: z.string(),
    href: z.string(),
    children: z.array(PublicationSidebarPageSchema),
  }).strict(),
)

export const PublicationSidebarGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  collapsed: z.boolean(),
  pages: z.array(PublicationSidebarPageSchema),
}).strict()

export interface PublicationPageOutlineItem {
  id: string
  level: number
  title: string
  children: PublicationPageOutlineItem[]
}

export const PublicationPageOutlineItemSchema: z.ZodType<PublicationPageOutlineItem> = z.lazy(() =>
  z.object({
    id: z.string(),
    level: z.number().int().min(2).max(4),
    title: z.string(),
    children: z.array(PublicationPageOutlineItemSchema),
  }).strict(),
)

export const PublicationSiteRenderResponseSchema = z.object({
  site: PublicationSiteMetaSchema,
  home: PublicationSiteHomeConfigSchema,
  navItems: z.array(PublicationNavItemSchema),
  sidebarGroups: z.array(PublicationSidebarGroupSchema),
  currentPage: PublicationRenderedDocumentSchema.nullable(),
  outline: z.array(PublicationPageOutlineItemSchema),
  internalLinks: z.array(PublicationInternalLinkResolutionSchema),
}).strict()

export const PublicationSingleDocumentResponseSchema = z.object({
  document: PublicationRenderedDocumentSchema,
  outline: z.array(PublicationPageOutlineItemSchema),
  assetIds: z.array(z.string()),
  internalLinks: z.array(PublicationInternalLinkResolutionSchema),
}).strict()

export type DocumentSinglePublicationState = z.infer<typeof DocumentSinglePublicationStateSchema>
export type DocumentSinglePublicationEffectiveState = z.infer<typeof DocumentSinglePublicationEffectiveStateSchema>
export type DocumentSinglePublicationScope = z.infer<typeof DocumentSinglePublicationScopeSchema>
export type PublicationSiteStatus = z.infer<typeof PublicationSiteStatusSchema>
export type PublicationEntryStatus = z.infer<typeof PublicationEntryStatusSchema>
export type PublicationSiteTheme = z.infer<typeof PublicationSiteThemeSchema>
export type PublicationSiteHomeMode = z.infer<typeof PublicationSiteHomeModeSchema>
export type PublicationSitePageScope = z.infer<typeof PublicationSitePageScopeSchema>
export type PublicationSiteMediaKind = z.infer<typeof PublicationSiteMediaKindSchema>
export type PublicationSiteCustomMediaScope = z.infer<typeof PublicationSiteCustomMediaScopeSchema>
export type PublicationSiteCustomMediaResponse = z.infer<typeof PublicationSiteCustomMediaResponseSchema>
export type PublicationNavItemType = z.infer<typeof PublicationNavItemTypeSchema>
export type PublicationNavItemInternalTarget = z.infer<typeof PublicationNavItemInternalTargetSchema>
export type PublicationNavItemExternalTarget = z.infer<typeof PublicationNavItemExternalTargetSchema>
export type PublicationSiteHomeConfig = z.infer<typeof PublicationSiteHomeConfigSchema>
export type UpsertPublicationSiteSettingsRequest = z.infer<typeof UpsertPublicationSiteSettingsSchema>
export type DocumentSinglePublicationSetting = z.infer<typeof DocumentSinglePublicationSettingSchema>
export type UpdateDocumentSinglePublicationSettingRequest = z.infer<typeof UpdateDocumentSinglePublicationSettingSchema>
export type DocumentSinglePublicationInfo = z.infer<typeof DocumentSinglePublicationInfoSchema>
export type ListDocumentSinglePublicationsQuery = z.infer<typeof ListDocumentSinglePublicationsQuerySchema>
export type ListDocumentSinglePublicationsResponse = z.infer<typeof ListDocumentSinglePublicationsResponseSchema>
export type PublicationSite = z.infer<typeof PublicationSiteSchema>
export type PublicationSiteManagementResponse = z.infer<typeof PublicationSiteManagementResponseSchema>
export type PublicationSection = z.infer<typeof PublicationSectionSchema>
export type PublicationPage = z.infer<typeof PublicationPageSchema>
export type PublicationGroupNavItem = z.infer<typeof PublicationGroupNavItemSchema>
export type PublicationInternalNavItem = z.infer<typeof PublicationInternalNavItemSchema>
export type PublicationExternalNavItem = z.infer<typeof PublicationExternalNavItemSchema>
export type PublicationNavItem = z.infer<typeof PublicationNavItemSchema>
export type CreatePublicationSectionRequest = z.infer<typeof CreatePublicationSectionSchema>
export type UpdatePublicationSectionRequest = z.infer<typeof UpdatePublicationSectionSchema>
export type CreatePublicationPageRequest = z.infer<typeof CreatePublicationPageSchema>
export type UpdatePublicationPageRequest = z.infer<typeof UpdatePublicationPageSchema>
export type PublicationInternalNavItemInput = z.infer<typeof PublicationInternalNavItemInputSchema>
export type PublicationExternalNavItemInput = z.infer<typeof PublicationExternalNavItemInputSchema>
export type PublicationNavItemInput = z.infer<typeof PublicationNavItemInputSchema>
export type ReplacePublicationNavItemsRequest = z.infer<typeof ReplacePublicationNavItemsSchema>
export type PublicationRenderedDocument = z.infer<typeof PublicationRenderedDocumentSchema>
export type PublicationInternalLinkResolution = z.infer<typeof PublicationInternalLinkResolutionSchema>
export type PublicationSiteMeta = z.infer<typeof PublicationSiteMetaSchema>
export type PublicationSidebarGroup = z.infer<typeof PublicationSidebarGroupSchema>
export type PublicationSiteRenderResponse = z.infer<typeof PublicationSiteRenderResponseSchema>
export type PublicationSingleDocumentResponse = z.infer<typeof PublicationSingleDocumentResponseSchema>

function hasPublicationNavItemVisibleIdentity(item: { icon?: string | null, label?: string | null }): boolean {
  return Boolean(item.label?.trim() || item.icon?.trim())
}

function isSafePublicationHrefValue(value: string): boolean {
  const href = value.trim()

  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href)

      return url.protocol === 'http:' || url.protocol === 'https:'
    }
    catch {
      return false
    }
  }

  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')
}
