#!/usr/bin/env node

import {
  bootstrap,
  installApks,
  recoverReplacementStage2,
  replaceInstaller,
  status,
} from "./install.js";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "install": {
      const apkPaths = args.slice(1);
      if (apkPaths.length === 0) {
        console.error("Usage: system-injector install <apk-path> [apk-path ...]");
        process.exit(1);
      }
      await installApks(apkPaths);
      break;
    }

    case "bootstrap": {
      const installerApk = args[1]; // optional
      const exploitApk = args[2]; // optional
      await bootstrap(installerApk, exploitApk);
      break;
    }

    case "replace-installer": {
      const installerApk = args[1];
      if (!installerApk) {
        console.error(
          "Usage: system-injector replace-installer <installer.apk> [exploit.apk]\n" +
            "Physical USB/ADB maintenance only; never exposed through the LAN dashboard."
        );
        process.exit(1);
      }
      await replaceInstaller(installerApk, args[2]);
      break;
    }

    case "recover-replacement-stage2": {
      const installerApk = args[1];
      if (!installerApk) {
        console.error(
          "Usage: system-injector recover-replacement-stage2 <installer.apk> [exploit.apk]\n" +
            "Physical USB only. Requires exactly one untouched orphan Stage-1 session pair."
        );
        process.exit(1);
      }
      await recoverReplacementStage2(installerApk, args[2]);
      break;
    }

    case "status": {
      await status();
      break;
    }

    default: {
      console.log("system-injector — Install APKs as system UID (1000) on the Humane AI Pin\n");
      console.log("Commands:");
      console.log("  install <apk-path> [apk-path ...]        Install APKs as system UID");
      console.log("  bootstrap [installer.apk] [exploit.apk]  One-time physical USB bootstrap");
      console.log("  replace-installer <installer.apk> [exploit.apk]");
      console.log("                                           Rare physical USB trust-anchor recovery");
      console.log("  recover-replacement-stage2 <installer.apk> [exploit.apk]");
      console.log("                                           Resume one verified orphan Stage-1 pair");
      console.log("  status                                   Check installation status");
      process.exit(command ? 1 : 0);
    }
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
