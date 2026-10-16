import { z } from 'zod'

export const AGENT_AMAP_MCP_SKILL_KEY = 'amap.maps' as const

export const AGENT_AMAP_MCP_TOOL_PREFIX = 'amap' as const

export const AGENT_AMAP_MCP_ENDPOINT = 'https://mcp.amap.com/mcp' as const

export const AGENT_AMAP_MCP_REQUEST_TIMEOUT_MS = 30_000 as const

export const AgentAmapMcpSkillConfigSchema = z.object({}).strict().default({})

export const AgentAmapMcpSkillCredentialConfigSchema = z.object({
  apiKey: z.string().optional(),
}).strict()

export const AgentAmapMcpSkillCardConfigSchema = z.object({
  apiKeyConfigured: z.boolean().default(false),
}).strict()

export const AGENT_AMAP_MCP_TOOL_DEFINITIONS = [
  {
    name: 'maps_direction_bicycling',
    title: '骑行路线规划',
    description: '根据起点和终点经纬度规划骑行路线。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '起点经纬度，格式为 经度,纬度。' },
        destination: { type: 'string', description: '终点经纬度，格式为 经度,纬度。' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'maps_direction_driving',
    title: '驾车路线规划',
    description: '根据起点和终点经纬度规划驾车路线。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '起点经纬度，格式为 经度,纬度。' },
        destination: { type: 'string', description: '终点经纬度，格式为 经度,纬度。' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'maps_direction_transit_integrated',
    title: '公交路线规划',
    description: '根据起点、终点和城市信息规划公共交通路线。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '起点经纬度，格式为 经度,纬度。' },
        destination: { type: 'string', description: '终点经纬度，格式为 经度,纬度。' },
        city: { type: 'string', description: '起点所在城市。' },
        cityd: { type: 'string', description: '终点所在城市。' },
      },
      required: ['origin', 'destination', 'city', 'cityd'],
    },
  },
  {
    name: 'maps_direction_walking',
    title: '步行路线规划',
    description: '根据起点和终点经纬度规划步行路线。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '起点经纬度，格式为 经度,纬度。' },
        destination: { type: 'string', description: '终点经纬度，格式为 经度,纬度。' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'maps_distance',
    title: '距离测量',
    description: '计算一个或多个起点到终点的距离。',
    inputSchema: {
      type: 'object',
      properties: {
        origins: { type: 'string', description: '起点经纬度，多个起点用竖线分隔。' },
        destination: { type: 'string', description: '终点经纬度。' },
        type: { type: 'string', description: '距离类型，可按高德支持值传入。' },
      },
      required: ['origins', 'destination'],
    },
  },
  {
    name: 'maps_geo',
    title: '地理编码',
    description: '将结构化地址转换为经纬度坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '待解析的结构化地址。' },
        city: { type: 'string', description: '地址所在城市，可选。' },
      },
      required: ['address'],
    },
  },
  {
    name: 'maps_regeocode',
    title: '逆地理编码',
    description: '将经纬度坐标转换为结构化地址。',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '经纬度，格式为 经度,纬度。' },
      },
      required: ['location'],
    },
  },
  {
    name: 'maps_ip_location',
    title: 'IP 定位',
    description: '根据 IP 地址查询粗略地理位置。',
    inputSchema: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: '待定位的 IP 地址。' },
      },
      required: ['ip'],
    },
  },
  {
    name: 'maps_schema_personal_map',
    title: '个人地图唤起链接',
    description: '根据组织名称和路线列表生成高德个人地图唤起链接。',
    inputSchema: {
      type: 'object',
      properties: {
        orgName: { type: 'string', description: '组织或地图名称。' },
        lineList: { type: 'array', description: '路线列表。' },
      },
      required: ['orgName', 'lineList'],
    },
  },
  {
    name: 'maps_around_search',
    title: '周边搜索',
    description: '基于关键词和中心点查询周边 POI。',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'POI 搜索关键词。' },
        location: { type: 'string', description: '中心点经纬度，格式为 经度,纬度。' },
        radius: { type: 'string', description: '搜索半径，可选。' },
        strategy: { type: 'string', description: '搜索策略，可选。' },
      },
      required: ['keywords', 'location'],
    },
  },
  {
    name: 'maps_search_detail',
    title: 'POI 详情',
    description: '根据 POI ID 查询地点详情。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '高德 POI ID。' },
      },
      required: ['id'],
    },
  },
  {
    name: 'maps_text_search',
    title: '关键词搜索',
    description: '基于关键词和可选城市查询 POI。',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'POI 搜索关键词。' },
        city: { type: 'string', description: '搜索城市，可选。' },
        citylimit: { type: 'boolean', description: '是否限制在指定城市内搜索。' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'maps_schema_navi',
    title: '导航唤起链接',
    description: '根据目标经纬度生成高德导航唤起链接。',
    inputSchema: {
      type: 'object',
      properties: {
        lon: { type: 'string', description: '目标经度。' },
        lat: { type: 'string', description: '目标纬度。' },
      },
      required: ['lon', 'lat'],
    },
  },
  {
    name: 'maps_schema_take_taxi',
    title: '打车唤起链接',
    description: '根据起终点生成高德打车唤起链接。',
    inputSchema: {
      type: 'object',
      properties: {
        dlon: { type: 'string', description: '终点经度。' },
        dlat: { type: 'string', description: '终点纬度。' },
        dname: { type: 'string', description: '终点名称。' },
        slon: { type: 'string', description: '起点经度，可选。' },
        slat: { type: 'string', description: '起点纬度，可选。' },
        sname: { type: 'string', description: '起点名称，可选。' },
      },
      required: ['dlon', 'dlat', 'dname'],
    },
  },
  {
    name: 'maps_weather',
    title: '天气查询',
    description: '查询指定城市的天气信息。',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名称或行政区划编码。' },
      },
      required: ['city'],
    },
  },
] as const

export const AGENT_AMAP_MCP_SKILL_MANIFEST = {
  title: '高德地图',
  description: '通过高德查询地图、地理编码、POI、路线、天气等位置相关信息。',
  tools: AGENT_AMAP_MCP_TOOL_DEFINITIONS.map(tool => ({
    name: `${AGENT_AMAP_MCP_TOOL_PREFIX}_${tool.name}`,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
} as const

export type AgentAmapMcpSkillConfig = z.infer<typeof AgentAmapMcpSkillConfigSchema>
export type AgentAmapMcpSkillCredentialConfig = z.infer<typeof AgentAmapMcpSkillCredentialConfigSchema>
export type AgentAmapMcpSkillCardConfig = z.infer<typeof AgentAmapMcpSkillCardConfigSchema>
