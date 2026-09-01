export const PUBLIC_SITE_NAME = "Ai Pin Revival Center";
export const PUBLIC_PROJECT_NAME = "Ai Pin Revival";
export const PUBLIC_REPOSITORY_URL =
  "https://github.com/TheAndersMadsen/ai-pin-revival";

export interface PublicLink {
  readonly href: string;
  readonly label: string;
  readonly description: string;
}

export interface PublicSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly links?: readonly PublicLink[];
}

export interface PublicPageDefinition {
  readonly path: "/" | "/about" | "/contact" | "/privacy" | "/developers";
  readonly title: string;
  readonly eyebrow: string;
  readonly headline: string;
  readonly description: string;
  readonly sections: readonly PublicSection[];
}

export const PUBLIC_PAGES: Readonly<Record<PublicPageDefinition["path"], PublicPageDefinition>> = {
  "/": {
    path: "/",
    title: PUBLIC_SITE_NAME,
    eyebrow: "Center + Cosmos",
    headline: "Your Ai Pin. Yours again.",
    description:
      "Run the services behind your Ai Pin on a server you control. Center gives you the owner experience; Cosmos brings the device back online.",
    sections: [
      {
        heading: "Keep the experience. Change the cloud.",
        paragraphs: [
          "Ai Pin Revival reconnects the stock Humane Ai Pin experience to services you operate. Center is the owner-facing web app. Cosmos supplies the device APIs, assistant tools, search, and media services. The signed Pin software joins them to the original voice, camera, settings, navigation, and music interfaces.",
          "There is no shared Ai Pin Revival cloud. Accounts, provider credentials, device identity, captures, notes, and operational data stay with your deployment. You choose the server, providers, domain, and retention. Installing the project creates no relationship with Humane.",
        ],
      },
      {
        heading: "One private place for your Pin.",
        paragraphs: [
          "Sign in to review memories and captures, manage notes and contacts, connect assistant and media providers, install the signed five-application Pin release, and activate one exact device against one exact Cosmos server. Center also shows the immutable release identity the deployment is serving.",
          "The public site is intentionally small. People and software agents can read the overview, privacy details, developer guidance, OpenAPI contract, sitemap, and llms.txt without JavaScript or an account. Wearer data and administrative actions remain behind your deployment's authentication boundary.",
        ],
      },
      {
        heading: "Start from a release, not a repo.",
        paragraphs: [
          "Production starts with the checksum-verified operator archive attached to a tagged GitHub release. Your server does not clone this repository or build Android software. The bundled revival command creates external configuration, checks provider settings, deploys digest-pinned images, imports the matching signed Pin archive, and verifies the public release identity.",
        ],
        links: [
          {
            href: "/install.sh",
            label: "Download server setup",
            description: "Run one guided bootstrap on a fresh Ubuntu 24.04 server.",
          },
          {
            href: `${PUBLIC_REPOSITORY_URL}/releases`,
            label: "Get a verified release",
            description: "Download the verified operator release; setup acquires its exact signed Pin archive.",
          },
        ],
      },
    ],
  },
  "/about": {
    path: "/about",
    title: `About ${PUBLIC_PROJECT_NAME}`,
    eyebrow: "Independent by design",
    headline: "A second life for Ai Pin.",
    description:
      "Ai Pin Revival is community-built software that reconnects a Humane Ai Pin to owner-operated Center and Cosmos services.",
    sections: [
      {
        heading: "Three parts. One product.",
        paragraphs: [
          "Ai Pin Revival exists for people who still own a Humane Ai Pin and want to use it after the original cloud service ended. It is not Humane, is not affiliated with Humane, and is not endorsed by Humane. Exact humane.* protocol names and Android package identifiers remain only where the stock software requires them for compatibility.",
          "Center is the browser home for owners and operators. Cosmos provides stock-compatible device services, identity, assistant tools, search, media, and storage. The Pin release carries the installer, bootstrap application, injected Hook, Server, and injector needed to connect the physical device. All three parts ship as one release-coupled product.",
        ],
      },
      {
        heading: "Operated by you.",
        paragraphs: [
          "Every deployment belongs to its operator. Accounts, certificates, provider credentials, databases, device identities, and runtime data live in that operator's environment. The project publishes software and release artifacts; it does not run a central account system, retain a copy of self-hosted wearer data, or substitute its own third-party credentials.",
          "Work happens in the public repository and ships as immutable, checksum-verified releases. Center exposes the active release identity so people and automated checks can confirm the exact build in use. Contributions favor direct code, remove dead paths, and preserve only the wire contracts the stock Pin actually needs.",
        ],
        links: [
          {
            href: PUBLIC_REPOSITORY_URL,
            label: "See how it is built",
            description: "Read the source, release history, issues, and contributor workflow.",
          },
        ],
      },
    ],
  },
  "/contact": {
    path: "/contact",
    title: `Contact and support for ${PUBLIC_PROJECT_NAME}`,
    eyebrow: "Open-source support",
    headline: "Help starts here.",
    description:
      "Choose the right place for setup questions, reproducible bugs, deployment help, or a private security report.",
    sections: [
      {
        heading: "Bring the useful details.",
        paragraphs: [
          "Ai Pin Revival is an open-source, self-hosted project, not a central customer service. Use the public GitHub issue tracker for reproducible bugs, installation failures, documentation fixes, and feature ideas. Include the release identifier, the command that failed, and redacted output. Leave out passwords, tokens, certificates, device credentials, and wearer content.",
          "Questions about one private deployment belong to that deployment's operator. The public project cannot inspect a private server, reset its accounts, recover provider secrets, or read data stored by its Pin. If you are a wearer rather than the operator, use the contact route your operator provided instead of publishing device details in an issue.",
        ],
      },
      {
        heading: "Keep security reports private.",
        paragraphs: [
          "Never put an exploitable report or sensitive evidence in a public issue. Use GitHub's private security-advisory flow when it is available. Name the affected component and release, explain the impact, and provide the smallest safe reproduction without real credentials or personal data. Reports about Humane systems outside this repository belong with their current owner.",
          "Maintainers cannot offer emergency service guarantees. Keep control of your domain, server access, provider accounts, and signing material so you can inspect or stop your deployment without waiting for a project maintainer. Public status pages and machine-readable documentation are informational and never grant access to wearer or administrator data.",
        ],
        links: [
          {
            href: `${PUBLIC_REPOSITORY_URL}/issues`,
            label: "Open a public issue",
            description: "Share a non-sensitive bug, setup problem, or documentation fix.",
          },
          {
            href: `${PUBLIC_REPOSITORY_URL}/security/advisories/new`,
            label: "Report privately",
            description: "Send a vulnerability without exposing it in the issue tracker.",
          },
        ],
      },
    ],
  },
  "/privacy": {
    path: "/privacy",
    title: `${PUBLIC_PROJECT_NAME} privacy`,
    eyebrow: "Operator-owned",
    headline: "Your Pin. Your data.",
    description:
      "A plain-language view of what stays inside your Center and Cosmos deployment, what is public, and who controls each part.",
    sections: [
      {
        heading: "Your server sets the rules.",
        paragraphs: [
          "Ai Pin Revival is self-hosted. The operator decides where Center and Cosmos run, who can sign in, which assistant and media providers are connected, how long data is kept, and who can administer the Pin. That operator—not a shared Ai Pin Revival cloud—owns the privacy notice, lawful basis, access controls, retention choices, and wearer requests.",
          "Enabled features can process account details, device identity, assistant conversations, captures, notes, contacts, calls, music activity, settings, diagnostics, and provider tokens. Private routes require the deployment's authentication. Secrets and runtime data live outside the release archive, and normal deployments preserve them without publishing them.",
        ],
      },
      {
        heading: "Public by choice.",
        paragraphs: [
          "The public site exposes product information, documentation, a sitemap, llms.txt, an OpenAPI description, release metadata, and any signed Pin artifacts the operator chooses to publish. Those routes contain no wearer records or provider credentials. Requests still pass through the operator's host, DNS, reverse proxy, and content-delivery provider, each with its own logs and policies.",
          "The source repository is separate from every running deployment. Anything intentionally submitted to GitHub issues, discussions, pull requests, or security reports is handled under GitHub's terms and follows the visibility of that channel. Never submit live credentials, private keys, unredacted diagnostics, captures, conversations, or personal contact data.",
        ],
      },
      {
        heading: "Access follows ownership.",
        paragraphs: [
          "For data held by a specific Center or Cosmos deployment, contact that deployment's operator. Open-source maintainers cannot view or delete records on a server they do not operate. The operator can use Center and its administrative tools to manage accounts and data, and remains responsible for infrastructure logs or copies created by the services they selected.",
        ],
        links: [
          {
            href: "/contact",
            label: "Find the right contact",
            description: "Choose between public project support and your deployment operator.",
          },
        ],
      },
    ],
  },
  "/developers": {
    path: "/developers",
    title: `${PUBLIC_PROJECT_NAME} developers`,
    eyebrow: "Build with Cosmos",
    headline: "Make the next chapter.",
    description:
      "A direct path to deployment, the small public API, contributor checks, and the context a coding agent needs.",
    sections: [
      {
        heading: "Deploy the release.",
        paragraphs: [
          "Production uses the revival CLI inside a checksum-verified operator archive. It writes external configuration, acquires and verifies the exact descriptor-bound signed five-application Pin archive, checks prerequisites, shows a dry run, deploys digest-pinned images, and verifies the live release. A production server never compiles this repository or deploys a mutable checkout.",
          "Contributors clone the repository and use the same root command for focused checks. Run the owning component while you iterate, then run its broad gate once before handoff. Tool versions and setup contracts are machine-owned, so a coding agent should read command help and the canonical contracts instead of inferring behavior from old prose.",
        ],
        links: [
          {
            href: `${PUBLIC_REPOSITORY_URL}#deploy-cosmos`,
            label: "Deploy Cosmos",
            description: "Install Center and Cosmos from an immutable GitHub release.",
          },
          {
            href: `${PUBLIC_REPOSITORY_URL}#development`,
            label: "Change the code",
            description: "Use focused checks, pinned tools, and external build caches.",
          },
        ],
      },
      {
        heading: "A small public API.",
        paragraphs: [
          "GET /api/version returns the product, immutable release identifier, and runtime environment. GET /api/pin/releases/current returns the imported signed Pin manifest when the operator enables that surface. These read-only operations need no API key. Their typed contract, unique operation IDs, response schemas, and errors live at /openapi.json.",
          "Wearer and operator APIs are not general public integrations. They use the Center browser session and enforce wearer or operator authorization. The OpenAPI description does not invent a reusable public key. Automated clients should call only documented public operations unless they are inside an operator-controlled authenticated browser workflow.",
        ],
        links: [
          {
            href: "/openapi.json",
            label: "Read the OpenAPI contract",
            description: "Parse the public read operations and their typed responses.",
          },
          {
            href: "/api/version",
            label: "Check this deployment",
            description: "Verify the release identity and runtime environment now being served.",
          },
        ],
      },
      {
        heading: "Let agents handle the repeatable parts.",
        paragraphs: [
          "Use Ai Pin Revival when the job is to self-host services for a Humane Ai Pin, deploy or verify Center and Cosmos, build the five signed Pin applications, connect supported assistant or media providers, diagnose a documented installation failure, or contribute code. It is not a hosted Humane service, a generic assistant API, or a way to reach someone else's Pin.",
          "A setup agent should ask only for missing deployment inputs, secrets entered through standard input, DNS or firewall changes, and physical device actions it cannot perform. It should preserve external provider settings, never print secrets, use a verified release for production, and finish by confirming that /api/version reports the intended release with environment production.",
        ],
        links: [
          {
            href: "/llms.txt",
            label: "Give an agent the context",
            description: "Start with concise when-to-use guidance and canonical public resources.",
          },
        ],
      },
    ],
  },
};

export const PUBLIC_CONTENT_PATHS = new Set([
  "/",
  "/welcome",
  "/about",
  "/contact",
  "/privacy",
  "/developers",
]);

export function publicPage(pathname: string): PublicPageDefinition | null {
  const canonical = pathname === "/welcome" ? "/" : pathname;
  return Object.prototype.hasOwnProperty.call(PUBLIC_PAGES, canonical)
    ? PUBLIC_PAGES[canonical as PublicPageDefinition["path"]]
    : null;
}

export function publicPageFromMarkdownPath(pathname: string): PublicPageDefinition | null {
  if (pathname === "/index.md") return PUBLIC_PAGES["/"];
  if (!pathname.endsWith(".md")) return null;
  return publicPage(pathname.slice(0, -3));
}

export function publicOrigin(environment: Record<string, string | undefined> = process.env): string {
  const candidate = environment.REVIVAL_PUBLIC_ORIGIN?.trim() || "http://localhost:4000";
  try {
    const url = new URL(candidate);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "") {
      return url.origin;
    }
  } catch {
    // The production configuration validator owns the operator-facing error.
  }
  return "http://localhost:4000";
}

export function publicPageMarkdown(pathname: string, origin = publicOrigin()): string | null {
  const page = publicPage(pathname);
  if (!page) return null;
  const lines = [`# ${page.title}`, "", `> ${page.description}`, ""];
  for (const section of page.sections) {
    lines.push(`## ${section.heading}`, "", ...section.paragraphs.flatMap((paragraph) => [paragraph, ""]));
    for (const link of section.links ?? []) {
      const href = link.href.startsWith("/") ? new URL(link.href, origin).toString() : link.href;
      lines.push(`- [${link.label}](${href}): ${link.description}`);
    }
    if ((section.links?.length ?? 0) > 0) lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

export type PublicRepresentation = "html" | "markdown" | null;

/** Choose between the two public representations using q-value and specificity order. */
export function preferredPublicRepresentation(accept: string | null): PublicRepresentation {
  if (!accept?.trim()) return "html";
  const ranges = accept
    .split(",")
    .map((raw, order) => {
      const [media = "", ...parameters] = raw.trim().toLowerCase().split(";");
      let quality = 1;
      for (const parameter of parameters) {
        const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/u.exec(parameter);
        if (/^\s*q\s*=/u.test(parameter)) quality = match ? Number(match[1]) : 0;
      }
      const specificity = media === "*/*" ? 0 : media.endsWith("/*") ? 1 : 2;
      return { media, quality, specificity, order };
    });

  function preference(media: "text/html" | "text/markdown") {
    return ranges
      .filter((range) =>
        range.media === media || range.media === "text/*" || range.media === "*/*",
      )
      .sort((left, right) => right.specificity - left.specificity || left.order - right.order)[0] ?? null;
  }

  const candidates = [
    { representation: "html" as const, match: preference("text/html"), fallback: 0 },
    { representation: "markdown" as const, match: preference("text/markdown"), fallback: 1 },
  ]
    .filter((candidate) => candidate.match && candidate.match.quality > 0)
    .sort((left, right) =>
      right.match!.quality - left.match!.quality ||
      right.match!.specificity - left.match!.specificity ||
      left.match!.order - right.match!.order ||
      left.fallback - right.fallback,
    );
  return candidates[0]?.representation ?? null;
}
