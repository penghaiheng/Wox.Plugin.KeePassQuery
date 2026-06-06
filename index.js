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
  baseUrl: "https://127.0.0.1:19456",
  token: "",
  searchPath: "/search",
  passwordPathTemplate: "/entries/{uuid}/password",
  searchQueryParam: "term",
  timeoutMs: 1000,
  maxResults: 20,
  rejectUnauthorized: true,
  clearClipboardAfterCopyPassword: true,
  clearClipboardDelayMs: 10000
}
const MIN_TIMEOUT_MS = 500
const MIN_MAX_RESULTS = 1
const MIN_CLIPBOARD_CLEAR_DELAY_MS = 500
const MAX_CUSTOM_FIELD_ACTIONS = 10
const MAX_DIAGNOSTIC_CHARS = 260

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
  try {
    return JSON.stringify(value)
  } catch (_error) {
    return String(value)
  }
}

function stripUtf8BomBuffer(buffer) {
  if (
    Buffer.isBuffer(buffer)
    && buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf
  ) {
    return buffer.subarray(3)
  }

  return buffer
}

function decodeUtf8Sig(value) {
  if (Buffer.isBuffer(value)) {
    return stripUtf8BomBuffer(value).toString("utf8")
  }

  const text = normalizeText(value)
  return text.replace(/^\uFEFF/, "")
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

  merged.timeoutMs = Math.max(MIN_TIMEOUT_MS, merged.timeoutMs)
  merged.maxResults = Math.max(MIN_MAX_RESULTS, merged.maxResults)
  merged.clearClipboardDelayMs = Math.max(MIN_CLIPBOARD_CLEAR_DELAY_MS, merged.clearClipboardDelayMs)

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

function sanitizeUrlForDiagnostics(rawUrl) {
  try {
    const url = new URL(rawUrl)
    url.search = ""
    return url.toString()
  } catch (_error) {
    return normalizeText(rawUrl)
  }
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
    `contentType: ${diagnostic.contentType || ""}`,
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
            Action: async (actionCtx, actionContext) => {
              await copyToClipboard(actionContext.ContextData.value)
              await logInfo(actionCtx, "Copied diagnostics")
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

function getMatchStart(item) {
  return parseNumberValue(item.matchStart ?? item.MatchStart)
}

function getMatchLength(item) {
  return parseNumberValue(item.matchLength ?? item.MatchLength)
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

function normalizeFieldKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]/gi, "").toLowerCase()
}

function escapeMarkdownInlineCode(value) {
  return normalizeText(value).replace(/`/g, "\\`")
}

function highlightMatchedText(value, item, fieldKey) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }

  const matchedField = getMatchedField(item)
  if (normalizeFieldKey(matchedField) !== normalizeFieldKey(fieldKey)) {
    return text
  }

  const matchStart = getMatchStart(item)
  const matchLength = getMatchLength(item)

  if (
    Number.isInteger(matchStart)
    && Number.isInteger(matchLength)
    && matchStart >= 0
    && matchLength > 0
    && matchStart < text.length
  ) {
    const safeEnd = Math.min(text.length, matchStart + matchLength)
    return `${text.slice(0, matchStart)}\`${escapeMarkdownInlineCode(text.slice(matchStart, safeEnd))}\`${text.slice(safeEnd)}`
  }

  const matchedValue = getMatchedValue(item)
  if (matchedValue) {
    const index = text.indexOf(matchedValue)
    if (index >= 0) {
      return `${text.slice(0, index)}\`${escapeMarkdownInlineCode(matchedValue)}\`${text.slice(index + matchedValue.length)}`
    }
  }

  return text
}

function formatPreviewField(label, value, item, fieldKey) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }

  const isMatched = normalizeFieldKey(getMatchedField(item)) === normalizeFieldKey(fieldKey)
  const displayLabel = isMatched ? `**${label}**` : label
  const displayValue = highlightMatchedText(text, item, fieldKey)

  return `- ${displayLabel}: ${displayValue}`
}

function buildPreview(item) {
  const lines = []
  const title = getTitle(item)
  const groupPath = getGroupPath(item)
  const userName = getUserName(item)
  const url = getUrl(item)
  const notes = formatNotes(item)
  const detailLines = []

  lines.push(`# ${title}`)

  const standardFields = [
    formatPreviewField("GroupPath", groupPath, item, "GroupPath"),
    formatPreviewField("UserName", userName, item, "UserName"),
    formatPreviewField("URL", url, item, "URL"),
    formatPreviewField("Notes", notes, item, "Notes")
  ].filter(Boolean)

  detailLines.push(...standardFields)

  for (const [key, value] of Object.entries(getCustomFieldsObject(item))) {
    const normalizedKey = normalizeText(key)
    const normalizedValue = normalizeText(value)
    if (normalizedKey && normalizedValue) {
      detailLines.push(formatPreviewField(normalizedKey, normalizedValue, item, normalizedKey))
    }
  }

  if (detailLines.length > 0) {
    lines.push("")
    lines.push(...detailLines)
  }

  return lines.join("\n")
}

function requestText(url, token, timeoutMs, rejectUnauthorized) {
  const urlObj = new URL(url)
  const isHttps = urlObj.protocol === "https:"
  const client = isHttps ? https : http

  return new Promise((resolve, reject) => {
    let settled = false
    const resolveOnce = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

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
          const bodyBuffer = Buffer.concat(chunks)
          const body = decodeUtf8Sig(bodyBuffer)
          resolveOnce({
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

    request.on("error", rejectOnce)
    request.end()
  })
}

function parsePayloadFromResponse(response) {
  const bodyText = normalizeText(response.body)
  const hasJsonContentType = response.contentType.includes("application/json")
  const contentTypeMissing = !response.contentType
  const looksLikeJson = hasJsonContentType || (contentTypeMissing && /^\s*[\[{]/.test(bodyText))

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
  const compact = normalizeText(value).replace(/\s+/g, " ").trim()
  if (compact.length <= MAX_DIAGNOSTIC_CHARS) {
    return compact
  }
  return `${compact.slice(0, MAX_DIAGNOSTIC_CHARS - 3)}...`
}

async function fetchRemotePayload(operation, url, config) {
  const baseDiagnostic = {
    operation,
    method: "GET",
    // Do not include query text in diagnostics to avoid exposing sensitive search input.
    url: sanitizeUrlForDiagnostics(url),
    timeoutMs: config.timeoutMs,
    rejectUnauthorized: config.rejectUnauthorized
  }

  try {
    const response = await requestText(url, config.token, config.timeoutMs, config.rejectUnauthorized)
    const statusText = `${response.statusCode} ${response.statusMessage}`.trim()
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw createRemoteError(
        `HTTP ${statusText}`,
        {
          ...baseDiagnostic,
          status: statusText,
          contentType: response.contentType,
          responseSnippet: compactResponseSnippet(response.body)
        }
      )
    }

    try {
      return parsePayloadFromResponse(response)
    } catch (error) {
      throw createRemoteError(
        error instanceof Error ? error.message : String(error),
        {
          ...baseDiagnostic,
          status: statusText,
          contentType: response.contentType,
          responseSnippet: compactResponseSnippet(response.body),
          error: error instanceof Error ? error.message : String(error),
          cause: normalizeErrorCause(error)
        },
        error
      )
    }
  } catch (error) {
    if (error && error.diagnostic) {
      throw error
    }

    throw createRemoteError(
      error instanceof Error ? error.message : String(error),
      {
        ...baseDiagnostic,
        error: error instanceof Error ? error.message : String(error),
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

async function fetchOtp(ctx, entryUuid) {
  const config = await loadConfig(ctx)
  validateConfig(config)

  const otpPath = `/entries/${encodeURIComponent(entryUuid)}/otp`
  const url = new URL(otpPath, `${config.baseUrl}/`)
  const payload = await fetchRemotePayload("otp", url.toString(), config)

  if (payload && typeof payload.otpCurrent === "string" && payload.otpCurrent) {
    return payload.otpCurrent
  }

  throw new Error("OTP response does not contain OtpCurrent")
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
  }, Math.max(MIN_CLIPBOARD_CLEAR_DELAY_MS, delayMs))
}

function createSubtitle(item) {
  const groupPath = getGroupPath(item)
  const userName = getUserName(item)

  if (groupPath && userName) {
    return `${groupPath} - ${userName}`
  }

  return groupPath || userName || getMatchedValue(item)
}

function buildDefaultAction(entryUuid, title) {
  return {
    Id: "copy-password",
    Name: "复制密码",
    IsDefault: true,
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
    .slice(0, MAX_CUSTOM_FIELD_ACTIONS)
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
      buildDefaultAction(entryUuid, title),
      {
        Id: "copy-username",
        Name: "复制用户名",
        Hotkey: "ctrl+enter",
        ContextData: { userName, title },
        Action: async (actionCtx, actionContext) => {
          if (!actionContext.ContextData.userName) {
            throw new Error("UserName is empty")
          }
          await copyToClipboard(actionContext.ContextData.userName)
          await logInfo(actionCtx, `Copied userName for ${actionContext.ContextData.title}`)
        }
      },
      {
        Id: "copy-otp",
        Name: "复制 OTP",
        Hotkey: "ctrl+t",
        ContextData: { entryUuid, title },
        Action: async (actionCtx, actionContext) => {
          if (!actionContext.ContextData.entryUuid) {
            throw new Error("Entry UUID is empty")
          }
          const otp = await fetchOtp(actionCtx, actionContext.ContextData.entryUuid)
          await copyToClipboard(otp)
          await logInfo(actionCtx, `Copied OTP for ${actionContext.ContextData.title}`)
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
