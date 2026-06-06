const fs = require("fs")
const path = require("path")
const http = require("http")
const https = require("https")
const { spawn } = require("child_process")

const DEFAULT_ICON = {
  ImageType: "emoji",
  ImageData: "🔐"
}

const ERROR_ICON = {
  ImageType: "emoji",
  ImageData: "⚠️"
}

const CONFIG_DEFAULTS = {
  baseUrl: "",
  token: "",
  searchPath: "/search",
  passwordPathTemplate: "/entries/{uuid}/password",
  searchQueryParam: "term",
  timeoutMs: 4000,
  maxResults: 20,
  rejectUnauthorized: true,
  clearClipboardAfterCopyPassword: true,
  clearClipboardDelayMs: 10000
}

const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS)
const STRING_KEYS = new Set([
  "baseUrl",
  "token",
  "searchPath",
  "passwordPathTemplate",
  "searchQueryParam"
])
const NUMBER_KEYS = new Set([
  "timeoutMs",
  "maxResults",
  "clearClipboardDelayMs"
])
const BOOLEAN_KEYS = new Set([
  "rejectUnauthorized",
  "clearClipboardAfterCopyPassword"
])

let cachedConfigFile = null
let cachedConfigMtime = 0
let pluginApi = null
let clearClipboardTimer = null

function getConfigPath() {
  return path.join(__dirname, "config.json")
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

function parseBooleanValue(value) {
  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "number") {
    return value !== 0
  }

  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (["true", "1", "yes", "on"].includes(text)) {
      return true
    }
    if (["false", "0", "no", "off"].includes(text)) {
      return false
    }
  }

  return undefined
}

function parseNumberValue(value) {
  if (value === null || value === undefined || value === "") {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizePartialConfig(raw) {
  const normalized = {}
  if (!raw || typeof raw !== "object") {
    return normalized
  }

  for (const key of CONFIG_KEYS) {
    const rawValue = raw[key]
    if (rawValue === undefined || rawValue === null || rawValue === "") {
      continue
    }

    if (STRING_KEYS.has(key)) {
      const text = normalizeText(rawValue)
      if (key === "baseUrl") {
        normalized[key] = text.replace(/\/+$/, "")
      } else {
        normalized[key] = text
      }
      continue
    }

    if (NUMBER_KEYS.has(key)) {
      const numberValue = parseNumberValue(rawValue)
      if (numberValue !== undefined) {
        normalized[key] = numberValue
      }
      continue
    }

    if (BOOLEAN_KEYS.has(key)) {
      const boolValue = parseBooleanValue(rawValue)
      if (boolValue !== undefined) {
        normalized[key] = boolValue
      }
    }
  }

  return normalized
}

function readConfigFile() {
  const configPath = getConfigPath()

  try {
    const stat = fs.statSync(configPath)
    if (cachedConfigFile && cachedConfigMtime === stat.mtimeMs) {
      return cachedConfigFile
    }

    const raw = fs.readFileSync(configPath, "utf8")
    const parsed = JSON.parse(raw)
    cachedConfigFile = normalizePartialConfig(parsed)
    cachedConfigMtime = stat.mtimeMs
    return cachedConfigFile
  } catch (error) {
    if (error && error.code === "ENOENT") {
      cachedConfigFile = {}
      cachedConfigMtime = 0
      return cachedConfigFile
    }
    throw error
  }
}

async function readWoxSettings(ctx) {
  if (!pluginApi || typeof pluginApi.GetSetting !== "function") {
    return {}
  }

  const rawSettings = {}

  for (const key of CONFIG_KEYS) {
    try {
      const value = await pluginApi.GetSetting(ctx, key)
      if (value !== undefined && value !== null && String(value) !== "") {
        rawSettings[key] = value
      }
    } catch (_error) {
    }
  }

  return normalizePartialConfig(rawSettings)
}

function mergeConfig(woxSettings, fileConfig) {
  const merged = {}

  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(woxSettings, key)) {
      merged[key] = woxSettings[key]
    } else if (Object.prototype.hasOwnProperty.call(fileConfig, key)) {
      merged[key] = fileConfig[key]
    } else {
      merged[key] = CONFIG_DEFAULTS[key]
    }
  }

  merged.timeoutMs = Math.max(500, Number(merged.timeoutMs) || CONFIG_DEFAULTS.timeoutMs)
  merged.maxResults = Math.max(1, Number(merged.maxResults) || CONFIG_DEFAULTS.maxResults)
  merged.clearClipboardDelayMs = Math.max(500, Number(merged.clearClipboardDelayMs) || CONFIG_DEFAULTS.clearClipboardDelayMs)

  return merged
}

async function loadConfig(ctx) {
  const fileConfig = readConfigFile()
  const woxSettings = await readWoxSettings(ctx)
  return mergeConfig(woxSettings, fileConfig)
}

function validateConfig(config) {
  if (!config.baseUrl) {
    throw new Error("Missing baseUrl. Please configure it in Wox settings or config.json")
  }

  if (!config.token) {
    throw new Error("Missing token. Please configure it in Wox settings or config.json")
  }
}

function createRemoteError(message, diagnostic, cause) {
  const error = new Error(message)
  error.diagnostic = diagnostic
  if (cause) {
    error.cause = cause
  }
  return error
}

function normalizeErrorCause(error) {
  if (!error || typeof error !== "object") {
    return undefined
  }

  return normalizeText(error.cause || error.code || error.errno || "") || undefined
}

function buildDiagnosticText(diagnostic) {
  if (!diagnostic) {
    return ""
  }

  return [
    `operation: ${diagnostic.operation || "unknown"}`,
    `method: ${diagnostic.method || "GET"}`,
    `url: ${diagnostic.url || ""}`,
    `timeoutMs: ${diagnostic.timeoutMs || ""}`,
    `rejectUnauthorized: ${diagnostic.rejectUnauthorized}`,
    `status: ${diagnostic.status || ""}`,
    `error: ${diagnostic.error || ""}`,
    `cause: ${diagnostic.cause || ""}`,
    `responseSnippet: ${diagnostic.responseSnippet || ""}`
  ].join("\n")
}

function createErrorResult(message, diagnosticText) {
  return {
    Title: "Remote Search Error",
    SubTitle: message,
    Icon: ERROR_ICON,
    Actions: diagnosticText
      ? [
          {
            Id: "copy-diagnostics",
            Name: "Copy diagnostics",
            ContextData: { value: diagnosticText },
            Action: async (_actionCtx, actionContext) => {
              await copyToClipboard(actionContext.ContextData.value)
            }
          }
        ]
      : []
  }
}

async function logInfo(ctx, message) {
  if (pluginApi) {
    await pluginApi.Log(ctx, "Info", message)
  }
}

async function logError(ctx, message) {
  if (pluginApi) {
    await pluginApi.Log(ctx, "Error", message)
  }
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

function requestText(url, token, timeoutMs, rejectUnauthorized) {
  const urlObj = new URL(url)
  const isHttps = urlObj.protocol === "https:"
  const client = isHttps ? https : http

  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || undefined,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "GET",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json"
        },
        rejectUnauthorized: isHttps ? rejectUnauthorized : undefined
      },
      (response) => {
        const chunks = []

        response.on("data", (chunk) => {
          chunks.push(chunk)
        })

        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8")
          resolve({
            statusCode: response.statusCode || 0,
            statusMessage: response.statusMessage || "",
            contentType: normalizeText(response.headers["content-type"]),
            body
          })
        })
      }
    )

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timeout after ${timeoutMs}ms`))
    })

    request.on("error", reject)
    request.end()
  })
}

function parsePayloadFromResponse(response) {
  const bodyText = normalizeText(response.body)
  const looksLikeJson = response.contentType.includes("application/json") || /^\s*[[{]/.test(bodyText)

  if (!looksLikeJson) {
    return bodyText
  }

  try {
    return JSON.parse(bodyText)
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error.message}`)
  }
}

function compactResponseSnippet(value) {
  return normalizeText(value).replace(/\s+/g, " ").trim().slice(0, 260)
}

async function fetchRemotePayload(operation, url, config) {
  const baseDiagnostic = {
    operation,
    method: "GET",
    url,
    timeoutMs: config.timeoutMs,
    rejectUnauthorized: config.rejectUnauthorized
  }

  try {
    const response = await requestText(url, config.token, config.timeoutMs, config.rejectUnauthorized)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw createRemoteError(
        `HTTP ${response.statusCode} ${response.statusMessage}`.trim(),
        {
          ...baseDiagnostic,
          status: `${response.statusCode} ${response.statusMessage}`.trim(),
          responseSnippet: compactResponseSnippet(response.body)
        }
      )
    }

    return parsePayloadFromResponse(response)
  } catch (error) {
    if (error && error.diagnostic) {
      throw error
    }

    throw createRemoteError(
      error instanceof Error ? error.message : String(error),
      {
        ...baseDiagnostic,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        cause: normalizeErrorCause(error)
      },
      error
    )
  }
}

async function searchEntries(ctx, term) {
  const config = await loadConfig(ctx)
  validateConfig(config)

  const url = new URL(config.searchPath, `${config.baseUrl}/`)
  url.searchParams.set(config.searchQueryParam, term)

  const payload = await fetchRemotePayload("search", url.toString(), config)
  const items = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : []
  return items.slice(0, config.maxResults)
}

async function fetchPassword(ctx, entryUuid) {
  const config = await loadConfig(ctx)
  validateConfig(config)

  const passwordPath = config.passwordPathTemplate.replace("{uuid}", encodeURIComponent(entryUuid))
  const url = new URL(passwordPath, `${config.baseUrl}/`)
  const payload = await fetchRemotePayload("password", url.toString(), config)

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

function buildDefaultAction(userName, url, entryUuid, title) {
  const fallbackValue = userName || url || entryUuid
  const fallbackLabel = userName ? "复制用户名" : url ? "复制 URL" : "复制 UUID"

  return {
    Id: "default-copy",
    Name: fallbackLabel,
    IsDefault: true,
    ContextData: { value: fallbackValue, title, label: fallbackLabel },
    Action: async (actionCtx, actionContext) => {
      if (!actionContext.ContextData.value) {
        throw new Error("No fallback value available")
      }
      await copyToClipboard(actionContext.ContextData.value)
      await logInfo(actionCtx, `${actionContext.ContextData.label}: ${actionContext.ContextData.title}`)
    }
  }
}

function buildCustomFieldActions(item) {
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
      Action: async (actionCtx, actionContext) => {
        await copyToClipboard(actionContext.ContextData.value)
        await logInfo(actionCtx, `Copied custom field ${actionContext.ContextData.key} for ${actionContext.ContextData.title}`)
      }
    }))
    .slice(0, 10)
}

function createResult(item, index, total) {
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
      buildDefaultAction(userName, url, entryUuid, title),
      {
        Id: "copy-password",
        Name: "复制密码",
        Hotkey: "ctrl+enter",
        ContextData: { entryUuid, title },
        Action: async (actionCtx, actionContext) => {
          if (!actionContext.ContextData.entryUuid) {
            throw new Error("Entry UUID is empty")
          }
          const password = await fetchPassword(actionCtx, actionContext.ContextData.entryUuid)
          await copyToClipboard(password)

          const config = await loadConfig(actionCtx)
          if (config.clearClipboardAfterCopyPassword) {
            scheduleClipboardClear(config.clearClipboardDelayMs)
          }

          await logInfo(actionCtx, `Copied password for ${actionContext.ContextData.title}`)
        }
      },
      {
        Id: "copy-uuid",
        Name: "复制 UUID",
        ContextData: { value: entryUuid },
        Action: async (actionCtx, actionContext) => {
          if (!actionContext.ContextData.value) {
            throw new Error("Entry UUID is empty")
          }
          await copyToClipboard(actionContext.ContextData.value)
          await logInfo(actionCtx, `Copied UUID for ${title}`)
        }
      },
      ...(url
        ? [{
            Id: "copy-url",
            Name: "复制 URL",
            ContextData: { value: url, title },
            Action: async (actionCtx, actionContext) => {
              await copyToClipboard(actionContext.ContextData.value)
              await logInfo(actionCtx, `Copied URL for ${actionContext.ContextData.title}`)
            }
          }]
        : []),
      ...buildCustomFieldActions(item),
      {
        Id: "copy-preview",
        Name: "复制详情",
        ContextData: { value: buildPreview(item), title },
        Action: async (actionCtx, actionContext) => {
          await copyToClipboard(actionContext.ContextData.value)
          await logInfo(actionCtx, `Copied details for ${actionContext.ContextData.title}`)
        }
      }
    ]
  }
}

function buildErrorSubtitle(error) {
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = error && error.diagnostic ? error.diagnostic : null

  if (!diagnostic) {
    return message
  }

  const parts = [message]
  if (diagnostic.url) parts.push(`url=${diagnostic.url}`)
  if (diagnostic.timeoutMs) parts.push(`timeout=${diagnostic.timeoutMs}ms`)
  if (typeof diagnostic.rejectUnauthorized === "boolean") parts.push(`tlsVerify=${diagnostic.rejectUnauthorized}`)
  if (diagnostic.status) parts.push(`status=${diagnostic.status}`)
  return parts.join(" | ")
}

const plugin = {
  init: async (ctx, initParams) => {
    pluginApi = initParams.API

    try {
      await loadConfig(ctx)
      await logInfo(ctx, "Remote Search plugin initialized")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await logError(ctx, `Remote Search config error: ${message}`)
    }

    if (pluginApi && typeof pluginApi.OnSettingChanged === "function") {
      await pluginApi.OnSettingChanged(ctx, async (callbackCtx, key) => {
        if (CONFIG_KEYS.includes(key)) {
          await logInfo(callbackCtx, `Setting changed: ${key}`)
        }
      })
    }
  },

  query: async (ctx, query) => {
    const term = String(query.Search || "").trim()
    if (!term) {
      return []
    }

    try {
      const items = await searchEntries(ctx, term)
      return items.map((item, index, arr) => createResult(item, index, arr.length))
    } catch (error) {
      const subtitle = buildErrorSubtitle(error)
      const diagnostic = error && error.diagnostic ? error.diagnostic : null
      const diagnosticText = buildDiagnosticText(diagnostic)

      await logError(ctx, `Remote Search query failed: ${subtitle}${diagnosticText ? `\n${diagnosticText}` : ""}`)

      return [createErrorResult(subtitle, diagnosticText)]
    }
  }
}

module.exports = {
  plugin
}
