/**
 * The canonical managed-package identities.
 *
 * This is the authority for both the installer brain and the device layer's
 * `packageManager`; keep it here so `@/lib/pin-device` never has to import back
 * into the installer for anything but this frozen constant.
 */
export const MANAGED_PACKAGES = Object.freeze({
  installer: "com.penumbraos.systeminjector",
  exploitHelper: "com.penumbraos.systeminjector.exploit",
  hook: "com.penumbraos.hook",
  server: "com.penumbraos.server",
  injector: "com.penumbraos.hook.injector",
} as const);
