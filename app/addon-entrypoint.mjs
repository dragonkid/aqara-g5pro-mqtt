#!/usr/bin/env node
// Runtime entrypoint for the stock node:slim add-on image.
//
// Replaces the bashio/jq-based addon.sh so the image needs no extra system
// tools and NO credentials baked into image layers. It reads the Supervisor
// options.json, generates /data/.env (persistent volume) via setup.js on first
// run or when the Aqara config changes, refreshes MQTT credentials from the
// Supervisor service on every boot, then starts the app.
//
// .env lives in /data so it survives image rebuilds/restarts; a clean rebuild
// no longer depends on a manually injected /app/.env.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // /app
const DATA = process.env.DATA_DIR || "/data";
const OPTIONS = path.join(DATA, "options.json");
const ENV_FILE = path.join(DATA, ".env");

function readOptions() {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS, "utf8"));
  } catch {
    return {};
  }
}

async function supervisorMqtt() {
  const tok = process.env.SUPERVISOR_TOKEN;
  if (!tok) return null;
  try {
    const r = await fetch("http://supervisor/services/mqtt", {
      headers: { Authorization: "Bearer " + tok },
    });
    const j = await r.json();
    if (j.result !== "ok" || !j.data) return null;
    return j.data; // { host, port, username, password, ssl }
  } catch {
    return null;
  }
}

function parseEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {}
  return out;
}

const o = readOptions();
const username = o.username || "";
const password = o.password || "";
const area = o.area || "CN";
const pollInterval = String(o.poll_interval ?? 1);
const logLevel = o.log_level || "info";
const cameraIps = o.camera_ips || "";
const disableMqttWithHaus = o.disable_mqtt_with_haus === false ? "false" : "true";

// MQTT: prefer explicit options, else the Supervisor-provisioned service.
const sys = await supervisorMqtt();
const mqttUrl = o.mqtt_url || `mqtt://${sys?.host || "core-mosquitto"}:${sys?.port || 1883}`;
const mqttUser = o.mqtt_user || sys?.username || "";
const mqttPass = o.mqtt_pass || sys?.password || "";

// Hash only the Aqara-side config. MQTT creds are refreshed from the Supervisor
// on every boot, so their rotation must not force a needless Aqara re-login.
const hashInput = [username, password, area, pollInterval, logLevel, cameraIps].join("|");
const currentHash = crypto.createHash("sha256").update(hashInput).digest("hex");

let env = parseEnv(ENV_FILE);
const needsRegen = !fs.existsSync(ENV_FILE) || !env.TOKEN || env.CONFIG_HASH !== currentHash;

if (needsRegen) {
  if (!username || !password) {
    console.error("❌ No Aqara username/password in options.json; cannot generate .env");
    process.exit(1);
  }
  console.log("🔑 Generating new .env (config changed or missing)");
  const args = [
    "dist/scripts/setup.js",
    "--auto",
    "--username", username,
    "--password", password,
    "--area", area,
    "--mqtt-url", mqttUrl,
    "--mqtt-user", mqttUser,
    "--mqtt-pass", mqttPass,
    "--poll-interval", pollInterval,
    "--log-level", logLevel,
  ];
  if (cameraIps) args.push("--camera-ips", cameraIps);
  const r = spawnSync(process.execPath, args, {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, ENV_FILE },
  });
  if (r.status !== 0) {
    console.error("❌ setup.js failed; aborting startup");
    process.exit(r.status || 1);
  }
  fs.appendFileSync(ENV_FILE, `CONFIG_HASH=${currentHash}\n`);
  env = parseEnv(ENV_FILE);
} else {
  console.log("✅ Existing .env is valid and matches config, skipping setup");
}

// Inject persisted values (TOKEN, AQARA_USER/PASS, AQUARA_URL, APPID, ...).
// dotenv/config in index.js does not override already-set process.env vars.
for (const [k, v] of Object.entries(env)) {
  if (k === "CONFIG_HASH") continue;
  if (process.env[k] === undefined) process.env[k] = v;
}
// Always-refresh runtime settings from current options + Supervisor service.
process.env.NODE_ENV = "production";
process.env.DATA_DIR = DATA;
process.env.MQTT_URL = mqttUrl;
process.env.MQTT_USER = mqttUser;
process.env.MQTT_PASS = mqttPass;
process.env.POLL_INTERVAL = pollInterval;
process.env.LOG_LEVEL = logLevel;
process.env.DISABLE_MQTT_WITH_HAUS = disableMqttWithHaus;
if (cameraIps) process.env.CAMERA_IPS = cameraIps;

console.log("🚀 Starting Aqara G5 Pro integration...");
await import("./dist/index.js");
