/**
 * The canonical managed-package identities.
 *
 * This is the authority for both the installer brain and the device layer's
 * `packageManager`. Keep it here so `@/lib/pin-device` never has to import back
 * into the installer for anything but this frozen constant.
 */
export const MANAGED_PACKAGES = Object.freeze({
  installer: "com.penumbraos.systeminjector",
  bootstrapHelper: "com.penumbraos.systeminjector.exploit",
  hook: "com.penumbraos.hook",
  server: "com.penumbraos.server",
  loader: "com.penumbraos.hook.injector",
} as const);
