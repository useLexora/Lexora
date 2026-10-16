import { PERMISSIONS, ROLES } from '@haohaoxue/lexora-contracts'

export const DEFAULT_RBAC_SEED = {
  permissions: [
    {
      code: PERMISSIONS.USER_READ_SELF,
      description: '读取当前用户信息',
    },
    {
      code: PERMISSIONS.USER_UPDATE_SELF,
      description: '更新当前用户信息',
    },
    {
      code: PERMISSIONS.USER_DELETE_SELF,
      description: '删除当前用户账号',
    },
    {
      code: PERMISSIONS.WORKSPACE_READ_SELF,
      description: '读取当前用户工作区信息',
    },
    {
      code: PERMISSIONS.WORKSPACE_CREATE_SELF,
      description: '创建当前用户团队空间',
    },
    {
      code: PERMISSIONS.WORKSPACE_UPDATE_SELF,
      description: '更新当前用户团队空间信息',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_OVERVIEW_READ,
      description: '查看系统后台概览',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_USER_LIST,
      description: '查看系统后台用户列表',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_USER_UPDATE_STATUS,
      description: '更新用户状态',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_AUTH_GOVERNANCE_READ,
      description: '读取认证治理配置',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_AUTH_GOVERNANCE_UPDATE,
      description: '更新认证治理配置',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_EMAIL_CONFIG_READ,
      description: '读取系统发件配置',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_EMAIL_CONFIG_UPDATE,
      description: '更新系统发件配置',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_READ,
      description: '查看系统站内信',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_UPDATE,
      description: '创建和发布系统站内信',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_DELETE,
      description: '删除系统站内信',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_READ,
      description: '读取平台 AI 配置',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE,
      description: '更新平台 AI 配置',
    },
    {
      code: PERMISSIONS.SYSTEM_ADMIN_AUDIT_LOG_LIST,
      description: '查看系统审计日志',
    },
  ],
  roles: [
    {
      code: ROLES.USER,
      name: '普通用户',
      permissions: [
        PERMISSIONS.USER_READ_SELF,
        PERMISSIONS.USER_UPDATE_SELF,
        PERMISSIONS.USER_DELETE_SELF,
        PERMISSIONS.WORKSPACE_READ_SELF,
        PERMISSIONS.WORKSPACE_CREATE_SELF,
        PERMISSIONS.WORKSPACE_UPDATE_SELF,
      ],
    },
    {
      code: ROLES.SYSTEM_ADMIN,
      name: '系统管理员',
      permissions: [
        PERMISSIONS.USER_READ_SELF,
        PERMISSIONS.USER_UPDATE_SELF,
        PERMISSIONS.WORKSPACE_READ_SELF,
        PERMISSIONS.WORKSPACE_CREATE_SELF,
        PERMISSIONS.WORKSPACE_UPDATE_SELF,
        PERMISSIONS.SYSTEM_ADMIN_OVERVIEW_READ,
        PERMISSIONS.SYSTEM_ADMIN_USER_LIST,
        PERMISSIONS.SYSTEM_ADMIN_USER_UPDATE_STATUS,
        PERMISSIONS.SYSTEM_ADMIN_AUTH_GOVERNANCE_READ,
        PERMISSIONS.SYSTEM_ADMIN_AUTH_GOVERNANCE_UPDATE,
        PERMISSIONS.SYSTEM_ADMIN_EMAIL_CONFIG_READ,
        PERMISSIONS.SYSTEM_ADMIN_EMAIL_CONFIG_UPDATE,
        PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_READ,
        PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_UPDATE,
        PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_DELETE,
        PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_READ,
        PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE,
        PERMISSIONS.SYSTEM_ADMIN_AUDIT_LOG_LIST,
      ],
    },
  ],
} as const
