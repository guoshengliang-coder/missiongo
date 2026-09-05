#!/usr/bin/env node

import { randomBytes, scryptSync } from "node:crypto";

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    process.stdout.write(prompt);
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run this command in an interactive terminal so the password can stay hidden.");
  process.exit(1);
}

try {
  const password = await readHidden("Admin password: ");
  const confirmation = await readHidden("Confirm password: ");

  if (password !== confirmation) throw new Error("Passwords do not match.");
  if (password.length < 12) throw new Error("Use at least 12 characters.");
  if (password.length > 1_024) throw new Error("Password is too long.");

  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  process.stdout.write(`ADMIN_PASSWORD_SCRYPT=scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
