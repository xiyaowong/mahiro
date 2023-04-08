import {
  DATABASE_APIS,
  EVersion,
  IDataCache,
  IDataPlugin,
  IDataRegisterGroupOpts,
  IDataRegisterPluginOpts,
  IDatabaseOpts,
  IMvcGroup,
  IMvcPlugin,
  getCacheTime,
} from './interface'
import knex from 'knex'
import { consola } from 'consola'
import { toArrayNumber } from '../utils'
import dayjs from 'dayjs'
import { type Express } from 'express'
import { uniq } from 'lodash'

export class Database {
  private path!: string
  private db!: ReturnType<typeof knex>
  private logger = consola.withTag('Database') as typeof consola

  // runtime
  private registeredPlugins: string[] = [] // name list
  private registeredExternalPlugins: string[] = [] // name list

  // cache
  private cacheTime = getCacheTime()
  private groupCache: IDataCache<IMvcGroup> = new Map()
  private pluginCache!: IMvcPlugin[]
  private cacheTimeMap = new Map<string, number>()
  private cacheKeys = {
    plugins: 'plugins',
    groups: 'groups',
  }

  private table = {
    plugins: 'plugins',
    groups: 'groups',
    version: 'version',
  }

  constructor(opts: IDatabaseOpts) {
    this.path = opts.path
  }

  async init() {
    this.connect()
    await this.checkTables()
  }

  private connect() {
    this.db = knex({
      client: 'better-sqlite3',
      connection: {
        filename: this.path,
      },
      useNullAsDefault: true,
      pool: {
        min: 2,
        max: 10,
      },
    })
  }

  private async checkTables() {
    const db = this.db
    const table = this.table
    const pluginsExists = await db.schema.hasTable(table.plugins)
    if (!pluginsExists) {
      await this.db.schema.createTable(table.plugins, (table) => {
        table.increments('id')
        table.string('name').unique()
        table.boolean('enabled')
        table.string('white_list_users')
        table.string('black_list_users')
        table.boolean('internal').defaultTo(false)
        // todo: 下一期再做
        table.integer('threshold').defaultTo(2)
      })
    }
    const groupsExists = await db.schema.hasTable(table.groups)
    if (!groupsExists) {
      await this.db.schema.createTable(table.groups, (table) => {
        table.increments('id')
        table.string('name')
        table.bigint('group_id').unique()
        table.string('admins')
        table.string('expired_at')
        table.string('plugins')
      })
    }
    const versionExists = await db.schema.hasTable(table.version)
    if (!versionExists) {
      await this.db.schema.createTable(table.version, (table) => {
        table.increments('id')
        table.string('version')
      })
      await this.db(this.table.version).insert({
        version: EVersion.v1,
      })
    } else {
      // todo: check version and upgrade columns
    }
  }

  async registerPlugin(
    opts: IDataRegisterPluginOpts,
    configs: {
      external?: boolean
    } = {},
  ) {
    const { external = false } = configs
    const { name, internal = false } = opts
    const has = await this.db.table(this.table.plugins).where({ name }).first()
    if (!has) {
      this.logger.info(`Registering plugin ${name}`)
      await this.db(this.table.plugins).insert({
        name,
        enabled: true,
        white_list_users: '',
        black_list_users: '',
        internal,
      } satisfies IDataPlugin)
    }
    // add to runtime
    if (!this.registeredPlugins.includes(name)) {
      this.registeredPlugins.push(name)
    }
    // add to external runtime
    if (external && !this.registeredExternalPlugins.includes(name)) {
      this.registeredExternalPlugins.push(name)
    }
  }

  clearExternalPlugins() {
    // remove external plugins from runtime
    this.registeredPlugins = this.registeredPlugins.filter((name) => {
      return !this.registeredExternalPlugins.includes(name)
    })
    // clear external plugins
    this.registeredExternalPlugins = []
  }

  async registerGroup(opts: IDataRegisterGroupOpts) {
    const { name, group_id, expired_at } = opts
    const has = await this.db
      .table(this.table.groups)
      .where({ group_id })
      .first()
    if (!has) {
      this.logger.info(`Registering group ${name}`)
      await this.db(this.table.groups).insert({
        name,
        group_id,
        admins: '',
        expired_at,
        plugins: '',
      })
    }
  }

  private isCacheExpired(key: string) {
    const latest = this.cacheTimeMap.get(key)
    if (latest) {
      const now = Date.now()
      if (now - latest < this.cacheTime) {
        return false
      }
    }
    return true
  }

  private updateCacheTimeMap(key: string) {
    this.cacheTimeMap.set(key, Date.now())
  }

  private async getPlugins() {
    const plugins = await this.db(this.table.plugins).select('*')
    const mvcPlugins = plugins
      .map((plugin) => {
        const mvc = {
          id: plugin.id,
          name: plugin.name,
          enabled: !!plugin.enabled,
          internal: !!plugin.internal,
          threshold: plugin.threshold,
          white_list_users: toArrayNumber(plugin.white_list_users),
          black_list_users: toArrayNumber(plugin.black_list_users),
        } as IMvcPlugin
        return mvc
      })
      .filter((p) => {
        const name = p.name
        if (this.registeredPlugins.includes(name)) {
          return true
        }
      })
    return mvcPlugins
  }

  private async updatePlugin(plugin: Partial<IMvcPlugin>) {
    const id = plugin.id!
    const has = await this.db.table(this.table.plugins).where({ id }).first()
    if (has) {
      // fields to string
      if (plugin.black_list_users) {
        // @ts-ignore
        plugin.black_list_users = plugin.black_list_users.join(',')
      }
      if (plugin.white_list_users) {
        // @ts-ignore
        plugin.white_list_users = plugin.white_list_users.join(',')
      }
      const res = await this.db(this.table.plugins).where({ id }).update(plugin)
      return res
    }
  }

  private async getGroups() {
    const groups = await this.db(this.table.groups).select('*')
    const mvcGroups = groups.map((g) => {
      return {
        id: g.id,
        name: g.name,
        group_id: g.group_id,
        expired_at: g.expired_at,
        admins: toArrayNumber(g.admins),
        plugins: toArrayNumber(g.plugins),
      } as IMvcGroup
    })
    return mvcGroups
  }

  private async getInternalPluginIds() {
    const plugins = await this.getPlugins()
    const internalPluginIds = plugins
      .filter((p) => p?.internal)
      .map((p) => p.id)
    return internalPluginIds
  }

  private async updateGroup(group: Partial<IMvcGroup>) {
    const id = group.id!
    const has = await this.db.table(this.table.groups).where({ id }).first()
    if (has) {
      if (group.admins) {
        // @ts-ignore
        group.admins = group.admins.join(',')
      }
      if (group.plugins) {
        const internalIds = await this.getInternalPluginIds()
        // ensure internal plugins
        group.plugins = uniq([...internalIds, ...(group.plugins || [])])
        // @ts-ignore
        group.plugins = group.plugins.join(',')
      }
      const res = await this.db(this.table.groups).where({ id }).update(group)
      return res
    }
  }

  private async addGroup(group: IMvcGroup) {
    // auto add internal plugins
    const internalPluginIds = await this.getInternalPluginIds()
    group.plugins = uniq([...internalPluginIds, ...(group.plugins || [])])
    // stringify
    // @ts-ignore
    group.admins = group.admins.join(',')
    // @ts-ignore
    group.plugins = group.plugins.join(',')
    const res = await this.db(this.table.groups).insert(group)
    return res
  }

  private async deleteGroup(id: number) {
    const res = await this.db(this.table.groups).where({ id }).del()
    return res
  }

  private async getPluginListFromCache() {
    const cache = this.pluginCache
    const update = async () => {
      const plugins = await this.getPlugins()
      this.pluginCache = plugins.filter((p) => p.enabled)
      this.updateCacheTimeMap(this.cacheKeys.plugins)
    }
    if (cache && !this.isCacheExpired(this.cacheKeys.plugins)) {
      return cache
    }
    await update()
    return this.pluginCache
  }

  private async getGroupMapFromCache(groupId: number) {
    const cache = this.groupCache.get(groupId)
    const update = async () => {
      const groups = await this.getGroups()
      groups.forEach((g) => {
        this.groupCache.set(g.group_id, g)
      })
      this.updateCacheTimeMap(this.cacheKeys.groups)
    }
    if (cache && !this.isCacheExpired(this.cacheKeys.groups)) {
      return cache
    }
    await update()
    return this.groupCache.get(groupId)
  }

  // todo: 管理插件
  async isGroupAdmin(groupId: number, userId: number) {
    const group = await this.getGroupMapFromCache(groupId)
    if (group) {
      return group.admins.includes(userId)
    }
    return false
  }

  async isGroupValid(groupId: number) {
    const group = await this.getGroupMapFromCache(groupId)
    if (group) {
      const expiredAt = dayjs(group.expired_at).valueOf()
      const now = Date.now()
      return now <= expiredAt
    }
    return false
  }

  async getAvailablePlugins(opts: { groupId: number; userId?: number }) {
    const { groupId, userId } = opts
    const group = await this.getGroupMapFromCache(groupId)
    if (group) {
      const groupAvaliablePluginsIds = group.plugins
      const pluginsList = await this.getPluginListFromCache()
      const pluginMap = pluginsList.reduce<Record<string, IMvcPlugin>>(
        (acc, cur) => {
          acc[cur.id] = cur
          return acc
        },
        {},
      )
      if (userId) {
        pluginsList.forEach((p) => {
          const isWhiteList = p.white_list_users.includes(userId)
          if (isWhiteList && !groupAvaliablePluginsIds.includes(p.id)) {
            groupAvaliablePluginsIds.push(p.id)
          }
          const isBlackList = p.black_list_users.includes(userId)
          if (isBlackList && groupAvaliablePluginsIds.includes(p.id)) {
            const index = groupAvaliablePluginsIds.indexOf(p.id)
            groupAvaliablePluginsIds.splice(index, 1)
          }
        })
      }
      const groupAvaliablePluginsNames = groupAvaliablePluginsIds.map((id) => {
        const plugin = pluginMap[id]
        if (plugin) {
          return plugin.name
        }
      })
      return groupAvaliablePluginsNames.filter(Boolean) as string[]
    }
    return []
  }

  async createMiddleware(app: Express) {
    // get plugins list
    app.get(DATABASE_APIS.getPlugins, async (req, res, next) => {
      res.status(200)
      try {
        const plugins = await this.getPlugins()
        res.json({
          code: 200,
          data: plugins,
        })
      } catch (e: any) {
        res.json({
          code: 500,
          message: e?.message || 'Internal Server Error',
        })
      }
    })
    // update plugin
    app.post(DATABASE_APIS.updatePlugin, async (req, res, next) => {
      const json = req.body
      res.status(200)
      try {
        const apiRes = await this.updatePlugin(json)
        res.json({
          code: 200,
          data: apiRes,
        })
      } catch (e: any) {
        res.json({
          code: 500,
          message: e?.message || 'Internal Server Error',
        })
      }
    })
    // get groups list
    app.get(DATABASE_APIS.getGroups, async (req, res, next) => {
      res.status(200)
      try {
        const groups = await this.getGroups()
        res.json({
          code: 200,
          data: groups,
        })
      } catch (e: any) {
        res.json({
          code: 500,
          message: e?.message || 'Internal Server Error',
        })
      }
    })
    // update group
    app.post(DATABASE_APIS.updateGroup, async (req, res, next) => {
      const json = req.body
      res.status(200)
      try {
        const apiRes = await this.updateGroup(json)
        res.json({
          code: 200,
          data: apiRes,
        })
      } catch (e: any) {
        res.json({
          code: 500,
          message: e?.message || 'Internal Server Error',
        })
      }
    })
    // add group
    app.post(DATABASE_APIS.addGroup, async (req, res, next) => {
      const json = req.body
      res.status(200)
      try {
        const apiRes = await this.addGroup(json)
        res.json({
          code: 200,
          data: apiRes,
        })
      } catch (e: any) {
        res.json({
          code: 500,
          message: e?.message || 'Internal Server Error',
        })
      }
    })
    // delete group
    app.post(DATABASE_APIS.deleteGroup, async (req, res, next) => {
      const json = req.body
      res.status(200)
      try {
        const apiRes = await this.deleteGroup(json.id)
        res.json({
          code: 200,
          data: apiRes,
        })
      } catch (e: any) {
        res.json({
          code: 500,
          message: e?.message || 'Internal Server Error',
        })
      }
    })
    // register plugin from external (e.g. python)
    app.post(DATABASE_APIS.registerPlugin, async (req, res, next) => {
      const json = req.body
      res.status(200)
      try {
        const apiRes = await this.registerPlugin(json, {
          external: true,
        })
        res.json({
          code: 200,
          data: apiRes,
        })
      } catch (e: any) {
        res.json({
          code: 500,
          message: e?.message || 'Internal Server Error',
        })
      }
    })
  }

  // todo: 发卡
  // todo: js interpreter
}