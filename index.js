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

const EMPTY_ARRAY = []
let cachedConfig = null
let cachedConfigMtime = 0
let pluginApi = null

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
    rejectUnauthorized: parsed.rejectUnauthorized !== false
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

function formatNotes(item) {
  return normalizeText(item.notes || item.Notes)
}

function formatCustomFields(item) {
  const customFields = item.customFields || item.CustomFields || {}
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields)) {
    return EMPTY_ARRAY
  }

  return Object.entries(customFields).map(([key, value]) => `${key}: ${normalizeText(value)}`)
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
    "customFields"
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
  const notes = formatNotes(item)
  const customFieldLines = formatCustomFields(item)
  const extraFieldLines = collectExtraFields(item)

  lines.push(`# ${title}`)
  lines.push("")
  if (entryUuid) lines.push(`- UUID: ${entryUuid}`)
  if (userName) lines.push(`- UserName: ${userName}`)
  if (url) lines.push(`- URL: ${url}`)
  if (database) lines.push(`- Database: ${database}`)
  if (groupPath) lines.push(`- GroupPath: ${groupPath}`)

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

    return await response.json()
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

function createSubtitle(item) {
  const parts = []
  const userName = getUserName(item)
  const url = getUrl(item)
  const groupPath = getGroupPath(item)
  const notes = formatNotes(item)
  const customFieldLines = formatCustomFields(item)

  if (userName) parts.push(`User: ${userName}`)
  if (url) parts.push(`URL: ${url}`)
  if (groupPath) parts.push(`Group: ${groupPath}`)
  if (notes) parts.push(`Notes: ${notes.replace(/\s+/g, " ").slice(0, 48)}`)
  if (customFieldLines.length > 0) parts.push(`Fields: ${customFieldLines.length}`)

  return parts.join(" | ")
}

async function logInfo(ctx, message) {
  if (pluginApi) {
    await pluginApi.Log(ctx, "Info", message)
  }
}

function createResult(item, index, total, ctx) {
  const title = getTitle(item)
  const entryUuid = getEntryUuid(item)
  const userName = getUserName(item)
  const url = getUrl(item)

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
      {
        Id: "copy-username",
        Name: "复制用户名",
        IsDefault: true,
        ContextData: { value: userName, title },
        Action: async (_actionCtx, actionContext) => {
          if (!actionContext.ContextData.value) {
            throw new Error("UserName is empty")
          }
          await copyToClipboard(actionContext.ContextData.value)
          await logInfo(ctx, `Copied username for ${actionContext.ContextData.title}`)
        }
      },
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
        }
      },
      ...(url
        ? [{
            Id: "copy-url",
            Name: "复制 URL",
            ContextData: { value: url },
            Action: async (_actionCtx, actionContext) => {
              await copyToClipboard(actionContext.ContextData.value)
            }
          }]
        : []),
      {
        Id: "copy-preview",
        Name: "复制详情",
        ContextData: { value: buildPreview(item) },
        Action: async (_actionCtx, actionContext) => {
          await copyToClipboard(actionContext.ContextData.value)
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
