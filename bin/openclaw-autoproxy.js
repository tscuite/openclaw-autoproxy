#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const serverEntryPath = path.join(packageRoot, "src", "gateway", "server.ts");
const tsxCliPath = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
const packageJsonPath = path.join(packageRoot, "package.json");

function printHelp() {
  console.log(`openclaw-autoproxy - OpenClaw Auto Gateway CLI

Usage:
  openclaw-autoproxy gateway start
  openclaw-autoproxy gateway dev
  openclaw-autoproxy start
  openclaw-autoproxy dev
  openclaw-autoproxy help
  openclaw-autoproxy --version

Commands:
  gateway   Gateway command group
  start     Legacy alias of: openclaw-autoproxy gateway start
  dev       Legacy alias of: openclaw-autoproxy gateway dev
  help      Show root help
`);
}

function printGatewayHelp() {
  console.log(`openclaw-autoproxy gateway - Gateway command group

Usage:
  openclaw-autoproxy gateway start
  openclaw-autoproxy gateway dev
  openclaw-autoproxy gateway help

Subcommands:
  start     Start gateway server (default)
  dev       Start gateway in watch mode
  help      Show gateway help
`);
}

async function printVersion() {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);
    console.log(pkg.version ?? "unknown");
  } catch {
    console.log("unknown");
  }
}

function runTsxMode(tsxArgs) {
  if (!existsSync(tsxCliPath)) {
    console.error("Missing tsx runtime. Reinstall dependencies and try again.");
    process.exit(1);
  }

  const child = spawn(process.execPath, [tsxCliPath, ...tsxArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

function runDevMode(extraArgs) {
  runTsxMode(["watch", serverEntryPath, ...extraArgs]);
}

function runStartMode(extraArgs) {
  runTsxMode([serverEntryPath, ...extraArgs]);
}

function isHelpFlag(value) {
  return value === "help" || value === "--help" || value === "-h";
}

function isVersionFlag(value) {
  return value === "version" || value === "--version" || value === "-v";
}

function resolveGatewayAction(rawArgs) {
  const subcommand = rawArgs[1] ?? "start";

  if (isHelpFlag(subcommand)) {
    return { type: "gateway-help" };
  }

  if (subcommand === "start") {
    return {
      type: "gateway-start",
      passthrough: rawArgs.slice(2),
    };
  }

  if (subcommand === "dev") {
    return {
      type: "gateway-dev",
      passthrough: rawArgs.slice(2),
    };
  }

  return {
    type: "error",
    message: `Unknown gateway subcommand: ${subcommand}`,
  };
}

function resolveAction(rawArgs) {
  const command = rawArgs[0];

  if (!command) {
    return {
      type: "gateway-start",
      passthrough: [],
    };
  }

  if (isHelpFlag(command)) {
    return { type: "root-help" };
  }

  if (isVersionFlag(command)) {
    return { type: "version" };
  }

  if (command === "gateway") {
    return resolveGatewayAction(rawArgs);
  }

  if (command === "start") {
    return {
      type: "gateway-start",
      passthrough: rawArgs.slice(1),
    };
  }

  if (command === "dev") {
    return {
      type: "gateway-dev",
      passthrough: rawArgs.slice(1),
    };
  }

  return {
    type: "error",
    message: `Unknown command: ${command}`,
  };
}

async function main() {
  const action = resolveAction(args);

  if (action.type === "root-help") {
    printHelp();
    return;
  }

  if (action.type === "gateway-help") {
    printGatewayHelp();
    return;
  }

  if (action.type === "version") {
    await printVersion();
    return;
  }

  if (action.type === "gateway-start") {
    runStartMode(action.passthrough);
    return;
  }

  if (action.type === "gateway-dev") {
    runDevMode(action.passthrough);
    return;
  }

  console.error(action.message);
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? `Failed to run openclaw-autoproxy: ${error.message}`
      : "Failed to run openclaw-autoproxy due to an unknown error.",
  );
  process.exit(1);
});