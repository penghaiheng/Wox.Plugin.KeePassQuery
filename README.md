# Wox.Plugin.RemoteSearch

一个基于 **Node.js / JavaScript** 的 Wox 插件，用于通过 **Bearer Token 认证的 HTTPS API** 搜索 KeePass 条目，并在需要时按条目 UUID 单独获取密码。

这个项目的插件结构参考了 `qianlifeng/Wox.Plugin.Everything`，但实现方式更适合当前场景：

- 不依赖本地 DLL
- 不需要 TypeScript 编译
- 直接使用纯 JavaScript
- 专注于 **远程搜索 + 按需获取密码**

## 功能说明

- 使用 `GET /search?term=...` 搜索远程条目
- 支持 `Authorization: Bearer <token>`
- 列表中展示搜索结果
- Preview 中展示条目详情
- 动态展示 `Notes`
- 动态展示 `CustomFields`
- 自动展示返回结果中的其他额外字段
- **Enter** 默认复制用户名
- **Ctrl+Enter** 根据条目 UUID 请求密码并复制到剪贴板
- 支持额外动作：复制 UUID、复制 URL、复制详情

## 快捷键与默认动作

在 Wox 中输入：

```text
kp 关键词
```

选中某个条目后：

- `Enter`：复制用户名
- `Ctrl+Enter`：获取密码并复制
- 其他动作：
  - 复制 UUID
  - 复制 URL
  - 复制详情

## 配置方式

1. 将 `config.json.example` 复制为 `config.json`
2. 按你的服务地址和 Token 修改配置

示例：

```json
{
  "baseUrl": "https://127.0.0.1:8443",
  "token": "your-bearer-token",
  "searchPath": "/search",
  "passwordPathTemplate": "/entries/{uuid}/password",
  "searchQueryParam": "term",
  "timeoutMs": 4000,
  "maxResults": 20,
  "rejectUnauthorized": true
}
```

### 配置项说明

- `baseUrl`：接口基础地址，例如 `https://127.0.0.1:8443`
- `token`：Bearer Token
- `searchPath`：搜索接口路径，默认 `/search`
- `passwordPathTemplate`：按 UUID 获取密码的接口路径模板，默认 `/entries/{uuid}/password`
- `searchQueryParam`：搜索关键字参数名，默认 `term`
- `timeoutMs`：请求超时时间，单位毫秒
- `maxResults`：最多展示多少条结果
- `rejectUnauthorized`：是否校验证书；如果本地开发使用自签名证书，可临时设为 `false`

## 搜索接口

插件会调用：

```text
GET {baseUrl}{searchPath}?{searchQueryParam}={search}
Authorization: Bearer {token}
```

例如：

```text
GET https://127.0.0.1:8443/search?term=123
Authorization: Bearer xxxxx
```

### 搜索返回格式

支持两种格式。

### 格式 1：直接返回数组

```json
[
  {
    "entryUuid": "xxxxxxx",
    "title": "12306",
    "userName": "demo_user",
    "url": "https://12306.cn",
    "notes": "测试备注",
    "customFields": {
      "otp": "123456",
      "remark": "vip"
    }
  }
]
```

### 格式 2：对象中包含 `items`

```json
{
  "items": [
    {
      "entryUuid": "xxxxxxx",
      "title": "12306",
      "userName": "demo_user",
      "url": "https://12306.cn",
      "notes": "测试备注",
      "customFields": {
        "otp": "123456"
      }
    }
  ]
}
```

> 注意：搜索接口用于“按任意字段搜索条目”，主要返回条目摘要信息。密码不依赖搜索接口返回，而是通过单独的密码接口按 UUID 获取。

## 密码接口

当你按下 `Ctrl+Enter` 时，插件会调用：

```text
GET {baseUrl}/entries/{uuid}/password
Authorization: Bearer {token}
```

例如：

```text
GET https://127.0.0.1:8443/entries/xxxxxxx/password
Authorization: Bearer xxxxx
```

### 密码返回格式

支持以下两种：

#### 格式 1：JSON 对象

```json
{
  "password": "xxxxxx"
}
```

#### 格式 2：纯字符串

```text
xxxxxx
```

## Preview 展示说明

每个搜索结果的 Preview 会展示：

- UUID
- UserName
- URL
- Database
- GroupPath
- Notes
- Custom Fields
- 其他未预定义但接口返回的字段

这样即使你的 API 后续新增字段，也可以直接在 Preview 中看到，不需要马上改代码。

## 使用示例

输入：

```text
kp 123
```

如果接口返回：

```json
{
  "items": [
    {
      "entryUuid": "x123",
      "title": "12306",
      "userName": "demo_user",
      "url": "https://12306.cn",
      "notes": "铁路账号",
      "customFields": {
        "otp": "123456",
        "remark": "常用"
      }
    }
  ]
}
```

那么你可以：

- 在列表中看到 `12306`
- 在副标题中看到用户名、URL、备注等摘要
- 在 Preview 中看到完整详情
- 按 `Enter` 复制用户名
- 按 `Ctrl+Enter` 获取并复制密码

## 依赖与运行

安装依赖：

```bash
npm install
```

这个项目使用纯 JavaScript，不需要额外 TypeScript 编译步骤。

## 注意事项

- `config.json` 不会提交到仓库，请自行创建
- 如果本地 HTTPS 服务使用自签名证书，开发阶段可将 `rejectUnauthorized` 设为 `false`
- 当前剪贴板实现依赖 Windows 的 `clip.exe`，因此此插件主要面向 Windows 使用
- 搜索阶段只请求搜索接口，不会批量请求密码接口，这样响应会更快

## 参考

本项目的 Wox 插件结构参考：

- `qianlifeng/Wox.Plugin.Everything`
