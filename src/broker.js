const http = require("http")
const {
  spawn
} = require("node:child_process")
const fs = require("fs")
const {
  default_root,
  roots,
  tools,
  limits
} = require("./config")

const is_allowed_root = r => roots.some(x => x.path === r)
const root_exists = r => {
  try {
    return fs.statSync(r).isDirectory()
  } catch {
    return false
  }
}
const resolve_root = requested => {
  if (!requested) {
    if (!root_exists(default_root)) return {
      ok: false,
      code: 500,
      error: "default root does not exist",
      root: default_root
    }
    return {
      ok: true,
      root: default_root
    }
  }
  if (!is_allowed_root(requested)) return {
    ok: false,
    code: 403,
    error: "root not allowed",
    root: requested
  }
  if (!root_exists(requested)) return {
    ok: false,
    code: 404,
    error: "root does not exist",
    root: requested
  }
  return {
    ok: true,
    root: requested
  }
}

const run = (cmd, args, cwd, stdin_data) => new Promise(res => {
  const p = spawn(cmd, args, {
    cwd
  })
  let out_str = ""
  let carry = ""
  const err = []
  let settled = false

  const push_out = s => {
    if (out_str.length >= limits.output_character_limit) return
    const rem = limits.output_character_limit - out_str.length
    out_str += s.length <= rem ? s : s.slice(0, rem)
  }

  if (stdin_data) {
    p.stdin.write(stdin_data)
    p.stdin.end()
  }

  p.stdout.on("data", b => {
    if (out_str.length >= limits.output_character_limit) return
    carry += b.toString("utf8")
    let i = 0,
      j
    while ((j = carry.indexOf("\n", i)) !== -1) {
      let line = carry.slice(i, j)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      if (line.length <= limits.output_drop_line_limit) push_out(carry.slice(i, j + 1))
      i = j + 1
      if (out_str.length >= limits.output_character_limit) break
    }
    carry = carry.slice(i)
  })

  p.stderr.on("data", b => err.push(b))

  p.on("error", e => {
    if (settled) return
    settled = true
    res({
      code: -1,
      out: out_str,
      err: String(e && e.message ? e.message : e)
    })
  })

  p.on("close", code => {
    if (settled) return
    let line = carry
    if (line.endsWith("\r")) line = line.slice(0, -1)
    if (line.length <= limits.output_drop_line_limit) push_out(carry)
    settled = true
    res({
      code,
      out: out_str,
      err: Buffer.concat(err).toString()
    })
  })
})

const resultSchema = {
  type: "object",
  properties: {
    code: {
      type: "integer"
    },
    out: {
      type: "string"
    },
    err: {
      type: "string"
    }
  },
  required: ["code", "out", "err"]
}

const rootsSchema = {
  type: "object",
  properties: {
    roots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string"
          },
          name: {
            type: "string"
          },
          description: {
            type: "string"
          },
          keywords: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },
        required: ["path", "name"]
      }
    }
  },
  required: ["roots"]
}

const generate_openapi = req => {
  const proto = req.headers["x-forwarded-proto"] || "http"
  const host = req.headers["x-forwarded-host"] || req.headers.host
  const paths = {}
  for (const [name, t] of Object.entries(tools)) {
    const isGet = Object.keys(t.params).length === 0
    const op = {
      operationId: name,
      summary: t.description,
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: isGet ? rootsSchema : resultSchema
            }
          }
        }
      }
    }
    if (!isGet) {
      const properties = {}
      const required = []
      for (const [k, v] of Object.entries(t.params)) {
        const {
          type,
          items,
          enum: en,
          default: dflt,
          example
        } = v
        const prop = {}
        if (type) prop.type = type
        if (items) prop.items = items
        if (en) prop.enum = en
        if (dflt !== undefined) prop.default = dflt
        if (example !== undefined) prop.example = example
        properties[k] = prop
        if (dflt === undefined) required.push(k)
      }
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties,
              required
            }
          }
        }
      }
    }
    paths[t.path] = {
      [isGet ? "get" : "post"]: op
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Local Code Tools",
      version: "1.0.0"
    },
    servers: [{
      url: `${proto}://${host}/broker`
    }],
    paths
  }
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") return preflight(res)
  if (req.method === "GET" && req.url === "/") {
    return send(res, 200, JSON.stringify(generate_openapi(req), null, 2))
  }

  const toolName = Object.keys(tools).find(k => tools[k].path === req.url)
  if (!toolName) return send(res, 404, JSON.stringify({
    error: "unknown path"
  }))

  const tool = tools[toolName]
  const args = tool.args || []
  const isGet = Object.keys(tool.params).length === 0

  if (isGet && req.method === "GET") {
    return send(res, 200, JSON.stringify({
      roots
    }))
  }

  if (!isGet && req.method === "POST") {
    const bufs = []
    req.on("data", c => bufs.push(c))
    req.on("end", async () => {
      const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString()) : {}
      let root
      if (tool.root) {
        if (!root_exists(tool.root)) {
          return send(res, 500, JSON.stringify({
            error: "configured root does not exist",
            root: tool.root
          }))
        }
        root = tool.root
      } else {
        const r = resolve_root(body.root)
        if (!r.ok) return send(res, r.code, JSON.stringify({
          error: r.error,
          root: r.root
        }))
        root = r.root
      }
      let result
      if (tool.mode === "stdin") {
        result = await run(tool.command, args, root, body.input || "")
      } else {
        result = await run(tool.command, [...args, ...(body.keywords || [])], root)
      }
      send(res, 200, JSON.stringify(result))
    })
    return
  }

  send(res, 405, JSON.stringify({
    error: "method not allowed"
  }))
}).listen(12717, "127.0.0.1")

const preflight = res => {
  res.statusCode = 204
  res.end("")
}

const send = (res, code, s) => {
  res.statusCode = code
  res.setHeader("content-type", "application/json")
  res.end(s)
}
