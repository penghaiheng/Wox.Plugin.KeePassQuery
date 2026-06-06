# Wox.Plugin.RemoteSearch

A pure JavaScript Wox plugin that queries a bearer-authenticated HTTPS API and displays KeePass search results.

## Features

- Search remote entries with `GET /search?term=...`
- Show preview details for each result
- Render Notes and CustomFields dynamically
- Copy UUID with Enter
- Copy password with `Ctrl+Enter` via `GET /entries/{uuid}/password`
- Copy URL and full details from extra actions

## Setup

1. Copy `config.json.example` to `config.json`
2. Update the values:

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

## Expected search response

The plugin accepts either:

```json
[
  {
    "entryUuid": "xxxxxxx",
    "title": "example",
    "password": "hidden",
    "notes": "optional",
    "customFields": {
      "otp": "123456"
    }
  }
]
```

or:

```json
{
  "items": [
    {
      "entryUuid": "xxxxxxx",
      "title": "example"
    }
  ]
}
```

## Expected password response

```json
{
  "password": "xxxxxx"
}
```

A plain string response is also accepted.

## Default keyword

The plugin trigger keyword is:

```text
kp
```

Example:

```text
kp 123
```

## Notes

- `config.json` is intentionally not committed.
- If you use a self-signed certificate during development, set `rejectUnauthorized` to `false`.
- This plugin targets Windows because clipboard actions use `clip.exe`.
