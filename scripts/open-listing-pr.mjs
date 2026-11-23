#!/usr/bin/env node
/**
 * 在 fork 上创建分支，只添加一个条目文件，然后开 PR。
 *
 * 走 GitHub Contents/Trees API，不 clone —— 榜单仓库 data/plugins 有上万文件，
 * clone 一遍只为加一个文件不划算，也更容易出岔子。
 */
import { readFileSync } from 'node:fs'

const TOKEN = process.env.GH_TOKEN
const OWNER = 'jiaxinchayedan'
const REPO = 'awesome-dsh-plugin'
const UPSTREAM = 'awesome-dsh-plugin'
const BRANCH = 'add-dsh-bmad-method'
const ENTRY_PATH = 'data/plugins/jiaxinchayedan__dsh-bmad-method.yml'

if (!TOKEN) {
  console.error('missing GH_TOKEN')
  process.exit(2)
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
    err.status = res.status
    err.body = json
    throw err
  }
  return json
}

const content = readFileSync(`data-plugins/${OWNER}__dsh-bmad-method.yml`, 'utf8')
const prBody = readFileSync('data-plugins/PR.md', 'utf8')

// 1) fork 的 main 头 commit
const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
const baseSha = ref.object.sha
console.log('base main:', baseSha)

// 2) 建分支（已存在则复用）
let branchSha = baseSha
try {
  const created = await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
    ref: `refs/heads/${BRANCH}`,
    sha: baseSha,
  })
  console.log('branch created:', BRANCH)
  branchSha = created.object.sha
} catch (error) {
  if (error.status === 422) {
    const existing = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
    branchSha = existing.object.sha
    console.log('branch already exists:', BRANCH, branchSha)
  } else {
    throw error
  }
}

// 3) 文件是否已存在（幂等）
let fileSha
try {
  const existing = await api('GET', `/repos/${OWNER}/${REPO}/contents/${ENTRY_PATH}?ref=${BRANCH}`)
  fileSha = existing.sha
  console.log('entry already on branch, will update')
} catch (error) {
  if (error.status !== 404) throw error
}

// 4) 只加这一个文件
const put = await api('PUT', `/repos/${OWNER}/${REPO}/contents/${ENTRY_PATH}`, {
  message: `Add ${OWNER}/dsh-bmad-method`,
  content: Buffer.from(content, 'utf8').toString('base64'),
  branch: BRANCH,
  ...(fileSha ? { sha: fileSha } : {}),
})
console.log('committed:', put.commit.sha)

// 5) 确认这次提交只碰了一个文件
const commit = await api('GET', `/repos/${OWNER}/${REPO}/commits/${put.commit.sha}`)
const files = commit.files ?? []
console.log('files in commit:', files.length, files.map((f) => `${f.status} ${f.filename}`).join(', '))
if (files.length !== 1 || files[0].filename !== ENTRY_PATH) {
  console.error('refusing to open PR: commit touches more than the single entry file')
  process.exit(1)
}

// 6) 开 PR（已存在则报告）
try {
  const pr = await api('POST', `/repos/${UPSTREAM}/${REPO}/pulls`, {
    title: `Add ${OWNER}/dsh-bmad-method`,
    head: `${OWNER}:${BRANCH}`,
    base: 'main',
    body: prBody,
  })
  console.log('PR:', pr.html_url)
} catch (error) {
  if (error.status === 422 && /already exists/i.test(String(error.message))) {
    console.log('PR already open for this branch')
  } else {
    throw error
  }
}
