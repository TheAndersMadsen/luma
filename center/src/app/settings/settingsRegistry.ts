export const ACCOUNT_GROUP = "Account & privacy";
export const PIN_GROUP = "Your Pin";
export const PIN_DEVICE_DATA_GROUP = "Everyday";
export const PIN_SETTINGS_GROUP = "Connections";
export const PIN_ADVANCED_GROUP = "Advanced";

export interface SettingsRoute {
  readonly title: string;
  readonly label: string;
  readonly href: string;
  readonly description: string;
  readonly testid: string;
  readonly matchChildren?: boolean;
  readonly keywords?: readonly string[];
  readonly operatorOnly?: boolean;
}

export interface SettingsGroup {
  readonly header: string;
  readonly description: string;
  readonly routes: readonly SettingsRoute[];
}

/** INFERRED: Luma's task-based navigation. Old technical names remain searchable. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    header: PIN_GROUP,
    description: "Make it work the way you like.",
    routes: [
      { title: "My Ai Pin", label: "My Ai Pin", href: "/settings/account/devices", description: "Battery, connection and your paired Pins.", testid: "menu-my-devices-link", keywords: ["device", "pair", "battery", "lost", "remove"] },
      { title: "Setup guide", label: "Set up a Pin", href: "/settings/pin/setup", description: "Connect your Pin and follow the steps to get it ready.", testid: "menu-pin-setup-link", keywords: ["setup", "start", "reconnect", "help", "usb", "activate"] },
      { title: "Assistant & voice", label: "Assistant & voice", href: "/settings/account/services", description: "How your Pin answers, speaks and finds things.", testid: "menu-services-link", keywords: ["services", "cosmos", "providers", "model", "api", "keys", "search", "maps", "speech", "weather", "azure", "google", "codex", "os3"] },
      { title: "Pin features", label: "Pin features", href: "/settings/account/features", description: "Choose the experiences you want on your Pin.", testid: "menu-features-link", keywords: ["controls", "behavior", "touchcode", "vision", "catch me up"] },
    ],
  },
  {
    header: PIN_SETTINGS_GROUP,
    description: "Stay connected, wherever you go.",
    routes: [
      { title: "Music", label: "Music", href: "/settings/account/music", description: "Connect a music account and choose where to play from.", testid: "menu-music-link", keywords: ["spotify", "youtube", "tidal", "playback", "streaming", "default"] },
      { title: "Wi-Fi", label: "Wi-Fi", href: "/wifi", description: "Add a network for your Pin to join.", testid: "menu-wifi-link", keywords: ["network", "qr", "internet", "wireless"] },
      { title: "Mobile connection", label: "Mobile connection", href: "/settings/pin/esim", description: "Mobile service, your number and eSIM profiles.", testid: "menu-pin-esim-link", keywords: ["cellular", "mobile", "network", "sim", "esim", "lte", "carrier"] },
    ],
  },
  {
    header: PIN_DEVICE_DATA_GROUP,
    description: "People, routines and things that matter to you.",
    routes: [
      { title: "Contacts", label: "Contacts", href: "/settings/contacts", description: "The people you call and message.", testid: "menu-contacts-link", keywords: ["people", "trusted", "calls", "messages", "inbound"] },
      { title: "Food & nutrition", label: "Food & nutrition", href: "/settings/food", description: "Your goals, food log and dietary preferences.", testid: "menu-food-link", keywords: ["goals", "totals", "diet", "allergies", "nutrition", "calories", "restrictions"] },
      { title: "Fitness", label: "Fitness", href: "/settings/pin/fitness", description: "Activity and workouts recorded by your Pin.", testid: "menu-pin-fitness-link", keywords: ["health", "steps", "activity", "exercise"] },
    ],
  },
  {
    header: ACCOUNT_GROUP,
    description: "Your identity, security and personal data.",
    routes: [
      { title: "Name & profile", label: "Name & profile", href: "/settings/account/details", description: "What your Pin calls you and how it says your name.", testid: "menu-details-link", keywords: ["details", "profile", "account", "email", "pronunciation"] },
      { title: "Passcode & password", label: "Passcode & password", href: "/settings/account/security", description: "Your Pin’s setup passcode and your Center sign-in.", testid: "menu-passcode-link", keywords: ["pin", "pincode", "code", "lock", "security", "unlock", "password", "sign in"] },
      { title: "Privacy & data", label: "Privacy & data", href: "/settings/privacy", description: "Choose what you share and manage your account data.", testid: "menu-privacy-link", keywords: ["delete", "data", "account", "privacy", "consent"] },
    ],
  },
  {
    header: PIN_ADVANCED_GROUP,
    description: "Software, troubleshooting and the finer details.",
    routes: [
      { title: "Software & updates", label: "Software & updates", href: "/settings/pin/install", description: "Check, install or repair the software on your Pin.", testid: "menu-pin-install-link", keywords: ["release", "version", "update", "upgrade", "recovery", "apk", "installer"] },
      { title: "Connection settings", label: "Connection settings", href: "/settings/pin/server", description: "Your Pin’s name, server address and network access.", testid: "menu-pin-server-link", keywords: ["pin server", "backend", "address", "certificate", "port", "remote", "iroh"] },
      { title: "Experimental features", label: "Experimental features", href: "/settings/pin/flags", description: "Explore additional controls for this Pin.", testid: "menu-pin-flags-link", keywords: ["device flags", "features", "developer", "experimental"] },
      { title: "Help & diagnostics", label: "Help & diagnostics", href: "/settings/pin/diagnostics", description: "Check installed software and collect logs for support.", testid: "menu-pin-diagnostics-link", keywords: ["support", "errors", "debug", "logs", "troubleshoot"] },
      { title: "Connect to your server", label: "Connect to your server", href: "/settings/pin/provision", description: "Pair a Pin with your account and connect it to this Luma.", testid: "menu-pin-provision-link", keywords: ["provisioning", "activate", "enroll", "operator", "credential", "cosmos", "identity"], operatorOnly: true },
      { title: "Software updates", label: "Software updates", href: "/settings/updates", description: "The Luma release on your server and what is new.", testid: "menu-updates-link", keywords: ["update", "upgrade", "release", "version", "server", "automatic", "notes"], operatorOnly: true },
      { title: "About Center", label: "About Center", href: "/settings/about", description: "The version of Luma running your Center.", testid: "menu-about-link", keywords: ["version", "release"] },
    ],
  },
] as const;

export const SETTINGS_ROUTES = SETTINGS_GROUPS.flatMap((group) => group.routes);

export function settingsGroupsFor(operator: boolean): readonly SettingsGroup[] {
  return SETTINGS_GROUPS.map((group) => ({ ...group, routes: group.routes.filter((route) => !route.operatorOnly || operator) }))
    .filter((group) => group.routes.length > 0);
}

const FLOW_PANES: Record<string, { title: string; group: string }> = {
  "/settings": { title: "Settings", group: "" },
  "/settings/pin": { title: "Connect your Pin", group: PIN_GROUP },
};

export function routeIsActive(pathname: string, route: SettingsRoute): boolean {
  return pathname === route.href || Boolean(route.matchChildren && pathname.startsWith(`${route.href}/`));
}

export function resolveSettingsPane(pathname: string): { title: string; group: string } {
  const flow = FLOW_PANES[pathname];
  if (flow) return flow;
  for (const group of SETTINGS_GROUPS) {
    const route = group.routes.find((candidate) => routeIsActive(pathname, candidate));
    if (route) return { title: route.title, group: group.header };
  }
  return { title: "Settings", group: "" };
}

export function routeMatchesSearch(route: SettingsRoute, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/u);
  const haystack = [route.label, route.description, ...(route.keywords ?? [])].join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}
