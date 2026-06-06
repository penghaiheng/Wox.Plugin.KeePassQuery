const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const https = require("https")

const DEFAULT_ICON = {
  ImageType: "emoji",
  ImageData: "🔐"
}

const ERROR_ICON = {
  ImageType: "emoji",
  ImageData: "⚠️"
}

const INFO_ICON = {
  ImageType: "emoji",
  ImageData: "ℹ️"
}

const EMPTY_ARRAY = []
let cachedConfig = null
let cachedConfigMtime = 0
let pluginApi = null
let clearClipboardTimer = null

function getConfigPath() {
  return path.join(__dirname, "config.json")
}

function readConfigFile() {
  const configPath = getConfigPath()
  const stat = fs.statSync(configPath)
  if (cachedConfig && cachedConfigMtime === stat.mtimeMs) {
    return cachedConfig
  }

  const raw = fs.readFileSync(configPath, "utf8")
  const parsed = JSON.parse(raw)
  cachedConfig = {
    baseUrl: String(parsed.baseUrl || "").replace(/\/$/, ""),
    token: String(parsed.token || ""),
    searchPath: String(parsed.searchPath || "/search"),
    passwordPathTemplate: String(parsed.passwordPathTemplate || "/entries/{uuid}/password"),
    searchQueryParam: String(parsed.searchQueryParam || "term"),
    timeoutMs: Number(parsed.timeoutMs || 4000),
    maxResults: Number(parsed.maxResults || 20),
    rejectUnauthorized: parsed.rejectUnauthorized !== false,
    clearClipboardAfterCopyPassword: parsed.clearClipboardAfterCopyPassword !== false,
    clearClipboardDelayMs: Number(parsed.clearClipboardDelayMs || 10000),
    autoCopySingleCustomField: parsed.autoCopySingleCustomField === true
  }
  cachedConfigMtime = stat.mtimeMs
  return cachedConfig
}

function createErrorResult(message) {
  return {
    Title: "Remote Search Error",
    SubTitle: message,
    Icon: ERROR_ICON,
    Actions: []
  }
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return JSON.stringify(value)
}

function getEntryUuid(item) {
  return normalizeText(item.entryUuid || item.Uuid || item.uuid)
}

function getTitle(item) {
  return normalizeText(item.title || item.Title || "(untitled)")
}

function getUserName(item) {
  return normalizeText(item.userName || item.UserName || item.username)
}

function getUrl(item) {
  return normalizeText(item.url || item.URL)
}

function getDatabase(item) {
  return normalizeText(item.database || item.Database)
}

function getGroupPath(item) {
  return normalizeText(item.groupPath || item.GroupPath)
}

function getMatchedField(item) {
  return normalizeText(item.matchedField || item.MatchedField)
}

function getMatchedValue(item) {
  return normalizeText(item.matchedValue || item.MatchedValue)
}

function formatNotes(item) {
  return normalizeText(item.notes || item.Notes)
}

function getCustomFieldsObject(item) {
  const customFields = item.customFields || item.CustomFields || {}
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields)) {
    return {}
  }
  return customFields
}

function formatCustomFields(item) {
  return Object.entries(getCustomFieldsObject(item)).map(([key, value]) => `${key}: ${normalizeText(value)}`)
}

function collectExtraFields(item) {
  const hiddenKeys = new Set([
    "entryUuid",
    "Uuid",
    "uuid",
    "title",
    "Title",
    "password",
    "UserName",
    "userName",
    "username",
    "URL",
    "url",
    "Database",
    "database",
    "GroupPath",
    "groupPath",
    "Notes",
    "notes",
    "CustomFields",
    "customFields",
    "MatchedField",
    "matchedField",
    "MatchedValue",
    "matchedValue"
  ])

  return Object.entries(item)
    .filter(([key]) => !hiddenKeys.has(key))
    .map(([key, value]) => `${key}: ${normalizeText(value)}`)
}

function buildPreview(item) {
  const lines = []
  const title = getTitle(item)
  const entryUuid = getEntryUuid(item)
  const userName = getUserName(item)
  const url = getUrl(item)
  const database = getDatabase(item)
  const groupPath = getGroupPath(item)
  const matchedField = getMatchedField(item)
  const matchedValue = getMatchedValue(item)
  const notes = formatNotes(item)
  const customFieldLines = formatCustomFields(item)
  const extraFieldLines = collectExtraFields(item)

  lines.push(`# ${title}`)
  lines.push("")
  lines.push("## 基本信息")
  if (entryUuid) lines.push(`- UUID: ${entryUuid}`)
  if (userName) lines.push(`- 用户名: ${userName}`)
  if (url) lines.push(`- URL: ${url}`)
  if (database) lines.push(`- 数据库: ${database}`)
  if (groupPath) lines.push(`- 分组路径: ${groupPath}`)
  if (matchedField || matchedValue) {
    lines.push(`- 匹配信息: ${matchedField || "(unknown)"} = ${matchedValue || ""}`)
  }

  if (notes) {
    lines.push("")
    lines.push("## Notes")
    lines.push(notes)
  }

  if (customFieldLines.length > 0) {
    lines.push("")
    lines.push("## Custom Fields")
    for (const line of customFieldLines) {
      lines.push(`- ${line}`)
    }
  }

  if (extraFieldLines.length > 0) {
    lines.push("")
    lines.push("## Extra Fields")
    for (const line of extraFieldLines) {
      lines.push(`- ${line}`)
    }
  }

  return lines.join("\n")
}

async function fetchJson(url, token, timeoutMs, rejectUnauthorized) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const agent = url.startsWith("https://")
    ? new https.Agent({ keepAlive: true, rejectUnauthorized })
    : undefined

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: controller.signal,
      agent
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("application/json")) {
      return await response.json()
    }

    return await response.text()
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

async function searchEntries(term) {
  const config = readConfigFile()
  if (!config.baseUrl) {
    throw new Error("config.json is missing baseUrl")
  }
  if (!config.token) {
    throw new Error("config.json is missing token")
  }

  const url = new URL(config.searchPath, `${config.baseUrl}/`)
  url.searchParams.set(config.searchQueryParam, term)

  const payload = await fetchJson(url.toString(), config.token, config.timeoutMs, config.rejectUnauthorized)
  const items = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : []
  return items.slice(0, Math.max(config.maxResults, 1))
}

async function fetchPassword(entryUuid) {
  const config = readConfigFile()
  if (!config.baseUrl) {
    throw new Error("config.json is missing baseUrl")
  }
  if (!config.token) {
    throw new Error("config.json is missing token")
  }

  const passwordPath = config.passwordPathTemplate.replace("{uuid}", encodeURIComponent(entryUuid))
  const url = new URL(passwordPath, `${config.baseUrl}/`)
  const payload = await fetchJson(url.toString(), config.token, config.timeoutMs, config.rejectUnauthorized)

  if (typeof payload === "string") {
    return payload
  }

  if (payload && typeof payload.password === "string") {
    return payload.password
  }

  throw new Error("Password response does not contain a password field")
}

function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("Clipboard action is only supported on Windows"))
      return
    }

    const child = spawn("clip.exe", [], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true
    })

    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`clip.exe exited with code ${code}`))
      }
    })

    child.stdin.end(text, "utf8")
  })
}

function scheduleClipboardClear(delayMs) {
  if (clearClipboardTimer) {
    clearTimeout(clearClipboardTimer)
  }

  clearClipboardTimer = setTimeout(async () => {
    try {
      await copyToClipboard("")
    } catch (_error) {
    }
  }, Math.max(500, delayMs))
}

function createSubtitle(item) {
  const parts = []
  const userName = getUserName(item)
  const url = getUrl(item)
  const groupPath = getGroupPath(item)
  const notes = formatNotes(item)
  const customFieldLines = formatCustomFields(item)
  const matchedField = getMatchedField(item)
  const matchedValue = getMatchedValue(item)

  if (userName) parts.push(`User: ${userName}`)
  if (url) parts.push(`URL: ${url}`)
  if (groupPath) parts.push(`Group: ${groupPath}`)
  if (notes) parts.push(`Notes: ${notes.replace(/\s+/g, " ").slice(0, 48)}`)
  if (matchedField || matchedValue) parts.push(`Matched: ${matchedField || "?"}=${matchedValue || ""}`)
  if (customFieldLines.length > 0) parts.push(`Fields: ${customFieldLines.length}`)

  return parts.join(" | ")
}

async function logInfo(ctx, message) {
  if (pluginApi) {
    await pluginApi.Log(ctx, "Info", message)
  }
}

function buildDefaultAction(userName, url, entryUuid, title, ctx) {
  const fallbackValue = userName || url || entryUuid
  const fallbackLabel = userName ? "复制用户名" : url ? "复制 URL" : "复制 UUID"

  return {
    Id: "default-copy",
    Name: fallbackLabel,
    IsDefault: true,
    ContextData: { value: fallbackValue, title, label: fallbackLabel },
    Action: async (_actionCtx, actionContext) => {
      if (!actionContext.ContextData.value) {
        throw new Error("No fallback value available")
      }
      await copyToClipboard(actionContext.ContextData.value)
      await logInfo(ctx, `${actionContext.ContextData.label}: ${actionContext.ContextData.title}`)
    }
  }
}

function buildCustomFieldActions(item, ctx) {
  const config = readConfigFile()
  const customFields = getCustomFieldsObject(item)
  const entries = Object.entries(customFields)

  if (entries.length === 0) {
    return []
  }

  return entries
    .filter(([key]) => key && normalizeText(customFields[key]))
    .map(([key, value], index) => ({
      Id: `copy-custom-field-${index}`,
      Name: `复制字段: ${key}`,
      ContextData: { key, value: normalizeText(value), title: getTitle(item) },
      Action: async (_actionCtx, actionContext) => {
        await copyToClipboard(actionContext.ContextData.value)
        await logInfo(ctx, `Copied custom field ${actionContext.ContextData.key} for ${actionContext.ContextData.title}`)
      }
    }))
    .slice(0, config.autoCopySingleCustomField ? 10 : 10)
}

function createResult(item, index, total, ctx) {
  const title = getTitle(item)
  const entryUuid = getEntryUuid(item)
  const userName = getUserName(item)
  const url = getUrl(item)
  const config = readConfigFile()

  return {
    Title: title,
    SubTitle: createSubtitle(item),
    Score: total - index,
    Icon: DEFAULT_ICON,
    Preview: {
      PreviewType: "markdown",
      PreviewData: buildPreview(item)
    },
    ContextData: item,
    Actions: [
      buildDefaultAction(userName, url, entryUuid, title, ctx),
      {
        Id: "copy-password",
        Name: "复制密码",
        Hotkey: "ctrl+enter",
        ContextData: { entryUuid, title },
        Action: async (_actionCtx, actionContext) => {
          if (!actionContext.ContextData.entryUuid) {
            throw new Error("Entry UUID is empty")
          }
          const password = await fetchPassword(actionContext.ContextData.entryUuid)
          await copyToClipboard(password)
          if (config.clearClipboardAfterCopyPassword) {
            scheduleClipboardClear(config.clearClipboardDelayMs)
          }
          await logInfo(ctx, `Copied password for ${actionContext.ContextData.title}`)
        }
      },
      {
        Id: "copy-uuid",
        Name: "复制 UUID",
        ContextData: { value: entryUuid },
        Action: async (_actionCtx, actionContext) => {
          if (!actionContext.ContextData.value) {
            throw new Error("Entry UUID is empty")
          }
          await copyToClipboard(actionContext.ContextData.value)
          await logInfo(ctx, `Copied UUID for ${title}`)
        }
      },
      ...(url
        ? [{
            Id: "copy-url",
            Name: "复制 URL",
            ContextData: { value: url, title },
            Action: async (_actionCtx, actionContext) => {
              await copyToClipboard(actionContext.ContextData.value)
              await logInfo(ctx, `Copied URL for ${actionContext.ContextData.title}`)
            }
          }]
        : []),
      ...buildCustomFieldActions(item, ctx),
      {
        Id: "copy-preview",
        Name: "复制详情",
        ContextData: { value: buildPreview(item), title },
        Action: async (_actionCtx, actionContext) => {
          await copyToClipboard(actionContext.ContextData.value)
          await logInfo(ctx, `Copied details for ${actionContext.ContextData.title}`)
        }
      }
    ]
  }
}

const plugin = {
  init: async (ctx, initParams) => {
    pluginApi = initParams.API
    try {
      readConfigFile()
      await pluginApi.Log(ctx, "Info", "Remote Search plugin initialized")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await pluginApi.Log(ctx, "Error", `Remote Search config error: ${message}`)
    }
  },

  query: async (ctx, query) => {
    const term = String(query.Search || "").trim()
    if (!term) {
      return []
    }

    try {
      const items = await searchEntries(term)
      return items.map((item, index, arr) => createResult(item, index, arr.length, ctx))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return [createErrorResult(message)]
    }
  }
}

module.exports = {
  plugin
}
