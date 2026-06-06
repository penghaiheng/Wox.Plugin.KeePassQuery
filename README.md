# Wox.Plugin.RemoteSearch

一个基于 **Node.js / JavaScript** 的 Wox 插件：通过远程 API 搜索 KeePass 条目，并按 UUID 单独获取密码。

## 当前版本能力

- 支持 Wox 原生设置页（`plugin.json` 的 `SettingDefinitions`）
- 配置读取优先级：**Wox 设置页 > `config.json` > 内置默认值**
- 搜索接口：`GET {baseUrl}{searchPath}?{searchQueryParam}=...`
- 密码接口：`GET {baseUrl}{passwordPathTemplate}`（模板内 `{uuid}` 自动替换）
- 动作：
  - `Enter`：复制用户名（缺失时回退 URL，再回退 UUID）
  - `Ctrl+Enter`：获取并复制密码
  - 复制 UUID / URL / 详情 / 自定义字段
- 可选：复制密码后延时清空剪贴板
- 失败时结果中显示可操作诊断信息，并支持一键复制诊断

## 在 Wox 设置页配置（推荐）

打开插件设置后可直接配置：

- `baseUrl`
- `token`
- `searchPath`
- `passwordPathTemplate`
- `searchQueryParam`
- `timeoutMs`
- `maxResults`
- `rejectUnauthorized`
- `clearClipboardAfterCopyPassword`
- `clearClipboardDelayMs`

> 如果某项在 Wox 设置页留空，插件会回退读取 `config.json`。

## `config.json`（兼容回退）

将 `config.json.example` 复制为 `config.json`：

```json
{
  "baseUrl": "https://127.0.0.1:8443",
  "token": "replace-with-your-bearer-token",
  "searchPath": "/search",
  "passwordPathTemplate": "/entries/{uuid}/password",
  "searchQueryParam": "term",
  "timeoutMs": 4000,
  "maxResults": 20,
  "rejectUnauthorized": true,
  "clearClipboardAfterCopyPassword": true,
  "clearClipboardDelayMs": 10000
}
```

## 使用方式

在 Wox 输入：

```text
kp 关键词
```

选中结果后：

- `Enter`：复制用户名（无用户名则回退 URL，再回退 UUID）
- `Ctrl+Enter`：请求密码并复制
- 其他动作：复制 UUID / URL / 详情 / 自定义字段

## 结果与 Preview

- 列表副标题会展示 User、URL、Group、Notes 摘要、匹配字段、字段数量
- Preview 分块展示：基本信息 / Notes / Custom Fields / Extra Fields

## 排查 `fetch failed` / 请求失败

当前版本已改为 Node.js 内置 `http/https.request`，不再依赖 `fetch` 运行时行为。

若仍失败，请按以下顺序排查：

1. **确认最终 URL 是否正确**
   - `baseUrl`、`searchPath`、`searchQueryParam` 组合后是否符合你的后端
   - 注意路径前后斜杠
2. **确认 TLS 选项是否匹配服务证书**
   - 自签名证书调试时可将 `rejectUnauthorized=false`
   - 生产环境建议开启 `rejectUnauthorized=true`
3. **确认超时设置**
   - 将 `timeoutMs` 适当调大（如 8000 或 10000）
4. **确认认证信息有效**
   - `token` 正确且仍有效

当请求失败时：

- 结果会显示：错误信息 + URL + timeout + TLS 校验状态 + HTTP 状态（若有）
- 动作中可点击 **Copy diagnostics** 复制完整诊断（不会包含 token）
- 插件日志也会写入同样的诊断上下文

## 接口返回格式

### 搜索接口

支持：

- 直接返回数组 `[]`
- 或对象 `{ "items": [] }`

条目常用字段示例：

```json
{
  "entryUuid": "xxxx",
  "title": "My Account",
  "userName": "demo",
  "url": "https://example.com",
  "notes": "备注",
  "matchedField": "title",
  "matchedValue": "my",
  "customFields": {
    "otp": "******"
  }
}
```

### 密码接口

支持：

- JSON：`{"password":"..."}`
- 纯文本：`...`

## 依赖与运行

```bash
npm install
```

该项目为纯 JavaScript，无需编译步骤。

## 注意事项

- `config.json` 为本地配置文件，不应提交到仓库
- 当前剪贴板实现依赖 Windows `clip.exe`
- 搜索阶段不会批量请求密码接口
- 插件不会输出 token 到 UI 或诊断日志
- 已兼容 UTF-8 BOM（`utf-8-sig`）响应：会先按 UTF-8 解码并去除开头 BOM，再进行 JSON 解析
