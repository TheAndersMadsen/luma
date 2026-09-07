export const ACCOUNT_GROUP = "Account";
export const PIN_GROUP = "My Ai Pin";
export const PIN_DEVICE_DATA_GROUP = "On this Pin";
export const PIN_SETTINGS_GROUP = "Pin settings";
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
  readonly routes: readonly SettingsRoute[];
}

/**
 * The single source of truth for settings navigation, pane titles and search.
 * Routes used only inside a flow (connect, setup and recovery) stay linked from
 * the owning My Ai Pin pane instead of becoming permanent sidebar items.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    header: ACCOUNT_GROUP,
    routes: [
      {
        title: "Devices",
        label: "Devices",
        href: "/settings/account/surfaces",
        description: "Phones, TVs and computers that show Cosmos replies.",
        testid: "menu-surfaces-link",
        keywords: ["browser", "display", "ambiance", "surfaces", "phone", "tv", "mac", "linux"],
      },
      {
        title: "Activity",
        label: "Activity",
        href: "/settings/account/activity",
        description: "Where recent requests were asked and where the replies went.",
        testid: "menu-activity-link",
        keywords: ["turns", "history", "ledger", "replies", "why", "routing"],
      },
      {
        title: "Details",
        label: "Details",
        href: "/settings/account/details",
        description: "Name, email and account details.",
        testid: "menu-details-link",
        keywords: ["profile", "account", "email"],
      },
      {
        title: "About Center",
        label: "About Center",
        href: "/settings/about",
        description: "Version and release information.",
        testid: "menu-about-link",
        keywords: ["version", "release"],
      },
    ],
  },
  {
    header: PIN_GROUP,
    routes: [
      {
        title: "My Ai Pin",
        label: "My Ai Pin",
        href: "/settings/account/devices",
        description: "Connection, battery, software and setup.",
        testid: "menu-my-devices-link",
        keywords: ["device", "pair", "setup", "install", "recovery", "battery"],
      },
      {
        title: "Provisioning",
        label: "Provisioning",
        href: "/settings/pin/provision",
        description: "Enroll a Pin with Cosmos.",
        testid: "menu-pin-provision-link",
        keywords: ["activate", "enroll", "operator", "credential"],
        operatorOnly: true,
      },
      {
        title: "Features",
        label: "Features",
        href: "/settings/account/features",
        description: "Turn available Pin features on or off.",
        testid: "menu-features-link",
        keywords: ["controls", "behavior"],
      },
      {
        title: "Services",
        label: "Services",
        href: "/settings/account/services",
        description: "Cosmos providers and connected music accounts.",
        testid: "menu-services-link",
        keywords: ["assistant", "search", "maps", "speech", "azure", "google", "spotify", "music"],
      },
      {
        title: "Wi-Fi",
        label: "Wi-Fi",
        href: "/wifi",
        description: "Create a network QR code for your Pin.",
        testid: "menu-wifi-link",
        keywords: ["network", "qr", "internet"],
      },
      {
        title: "Contacts",
        label: "Contacts",
        href: "/settings/contacts",
        description: "People saved to your account.",
        testid: "menu-contacts-link",
        keywords: ["people", "trusted"],
      },
      {
        title: "Privacy",
        label: "Privacy",
        href: "/settings/privacy",
        description: "Account privacy and stored data.",
        testid: "menu-privacy-link",
        keywords: ["delete", "data"],
      },
    ],
  },
  {
    header: PIN_DEVICE_DATA_GROUP,
    routes: [
      {
        title: "Captures",
        label: "Captures",
        href: "/settings/pin/gallery",
        description: "Photos and videos stored on this Pin.",
        testid: "menu-pin-gallery-link",
        matchChildren: true,
        keywords: ["gallery", "photos", "videos"],
      },
      {
        title: "Fitness",
        label: "Fitness",
        href: "/settings/pin/fitness",
        description: "Activity recorded by this Pin.",
        testid: "menu-pin-fitness-link",
        keywords: ["health", "steps", "activity"],
      },
      {
        title: "Contacts on Pin",
        label: "Contacts on Pin",
        href: "/settings/pin/contacts",
        description: "Contacts currently stored on this Pin.",
        testid: "menu-pin-contacts-link",
        keywords: ["people", "device"],
      },
    ],
  },
  {
    header: PIN_SETTINGS_GROUP,
    routes: [
      {
        title: "Calls & messages",
        label: "Calls & messages",
        href: "/settings/pin/services",
        description: "Who may call or message this Pin.",
        testid: "menu-pin-services-link",
        keywords: ["calls", "messages", "contacts", "inbound"],
      },
      {
        title: "Cellular & eSIM",
        label: "Cellular & eSIM",
        href: "/settings/pin/esim",
        description: "Mobile service and eSIM status.",
        testid: "menu-pin-esim-link",
        keywords: ["mobile", "network", "sim"],
      },
    ],
  },
  {
    header: PIN_ADVANCED_GROUP,
    routes: [
      {
        title: "Pin server",
        label: "Pin server",
        href: "/settings/pin/server",
        description: "Connection to your Pin services.",
        testid: "menu-pin-server-link",
        keywords: ["backend", "address", "certificate"],
      },
      {
        title: "Device flags",
        label: "Device flags",
        href: "/settings/pin/flags",
        description: "Low-level behavior available on this Pin.",
        testid: "menu-pin-flags-link",
        keywords: ["features", "developer"],
      },
      {
        title: "Diagnostics & logs",
        label: "Diagnostics & logs",
        href: "/settings/pin/diagnostics",
        description: "Connection details and recent device logs.",
        testid: "menu-pin-diagnostics-link",
        keywords: ["support", "errors", "debug"],
      },
    ],
  },
] as const;

export const SETTINGS_ROUTES = SETTINGS_GROUPS.flatMap((group) => group.routes);

export function settingsGroupsFor(operator: boolean): readonly SettingsGroup[] {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    routes: group.routes.filter((route) => !route.operatorOnly || operator),
  })).filter((group) => group.routes.length > 0);
}

const FLOW_PANES: Record<string, { title: string; group: string }> = {
  "/settings": { title: "Settings", group: "" },
  "/settings/pin": { title: "Connect your Pin", group: PIN_GROUP },
  "/settings/pin/setup": { title: "Setup guide", group: PIN_GROUP },
  "/settings/pin/install": { title: "Software & recovery", group: PIN_GROUP },
};

export function routeIsActive(pathname: string, route: SettingsRoute): boolean {
  return (
    pathname === route.href ||
    Boolean(route.matchChildren && pathname.startsWith(`${route.href}/`))
  );
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
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [route.label, route.description, ...(route.keywords ?? [])]
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}
