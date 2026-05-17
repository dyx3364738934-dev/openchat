/**
 * session-store.js — context_token 和 get_updates_buf 的持久化存储
 *
 * 两个关键概念：
 * 1. context_token：每个用户的消息都带一个 token，回复必须原样回传
 * 2. get_updates_buf：长轮询的同步游标，重启后可以接着收消息
 *
 * 存储位置：{stateDir}/{accountId}.context-tokens.json 和 {stateDir}/{accountId}.sync.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { getConfig } from "./config.js";

// ======== Context Token Store ========

/** 内存缓存：key = "accountId:userId" → token */
const contextTokenStore = new Map();

function contextTokenKey(accountId, userId) {
  return `${accountId}:${userId}`;
}

function resolveContextTokenPath(accountId) {
  const { stateDir } = getConfig();
  return resolve(stateDir, `${accountId}.context-tokens.json`);
}

/** 持久化某个 account 的所有 context token 到磁盘 */
function persistContextTokens(accountId) {
  const prefix = `${accountId}:`;
  const tokens = {};
  for (const [k, v] of contextTokenStore) {
    if (k.startsWith(prefix)) {
      tokens[k.slice(prefix.length)] = v;
    }
  }
  const filePath = resolveContextTokenPath(accountId);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(tokens, null, 0), "utf-8");
  } catch (err) {
    console.error(`persistContextTokens: 写入失败 ${filePath}: ${err.message}`);
  }
}

/** 从磁盘恢复 context token 到内存 */
export function restoreContextTokens(accountId) {
  const filePath = resolveContextTokenPath(accountId);
  try {
    if (!existsSync(filePath)) return;
    const tokens = JSON.parse(readFileSync(filePath, "utf-8"));
    let count = 0;
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === "string" && token) {
        contextTokenStore.set(contextTokenKey(accountId, userId), token);
        count++;
      }
    }
    if (count > 0) {
      console.log(`📋 恢复 ${count} 个 context token (account=${accountId})`);
    }
  } catch (err) {
    console.warn(`restoreContextTokens: 读取失败 ${filePath}: ${err.message}`);
  }
}

/** 存储 context token */
export function setContextToken(accountId, userId, token) {
  contextTokenStore.set(contextTokenKey(accountId, userId), token);
  persistContextTokens(accountId);
}

/** 读取 context token */
export function getContextToken(accountId, userId) {
  return contextTokenStore.get(contextTokenKey(accountId, userId));
}

// ======== Sync Buffer Store ========

function resolveSyncBufPath(accountId) {
  const { stateDir } = getConfig();
  return resolve(stateDir, `${accountId}.sync.json`);
}

/** 保存 get_updates_buf */
export function saveGetUpdatesBuf(accountId, buf) {
  const filePath = resolveSyncBufPath(accountId);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ buf, savedAt: new Date().toISOString() }), "utf-8");
  } catch (err) {
    console.error(`saveGetUpdatesBuf: 写入失败 ${filePath}: ${err.message}`);
  }
}

/** 读取 get_updates_buf */
export function loadGetUpdatesBuf(accountId) {
  const filePath = resolveSyncBufPath(accountId);
  try {
    if (!existsSync(filePath)) return null;
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return typeof data.buf === "string" ? data.buf : null;
  } catch (err) {
    console.warn(`loadGetUpdatesBuf: 读取失败 ${filePath}: ${err.message}`);
    return null;
  }
}
