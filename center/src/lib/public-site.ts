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
  readonly description: string;
  readonly sections: readonly PublicSection[];
}

export const PUBLIC_PAGES: Readonly<Record<PublicPageDefinition["path"], PublicPageDefinition>> = {
  "/": {
    path: "/",
    title: PUBLIC_SITE_NAME,
    description:
      "A self-hosted control center and replacement service for a Humane Ai Pin, maintained by its operator and independent of Humane.",
    sections: [
      {
        heading: "Keep an Ai Pin useful",
        paragraphs: [
          "Ai Pin Revival reconnects the stock Humane Ai Pin experience to services you operate. Center is the owner-facing web application, Cosmos supplies the device APIs and assistant orchestration, and the Pin software integrates those services with the original voice, camera, settings, navigation, and music interfaces.",
          "The project is designed for self-hosting. Your deployment owns its accounts, provider credentials, device identity, captures, notes, and operational data. It does not send those records to a shared Ai Pin Revival cloud, and installing this project does not create a relationship with Humane.",
        ],
      },
      {
        heading: "What Center provides",
        paragraphs: [
          "After signing in, an owner can review memories and captures, manage notes and contacts, connect supported assistant and media providers, install the signed five-application Pin release, and activate one exact device against one exact Cosmos server. Operators also get a deployment identity that names the immutable release currently being served.",
          "Public visitors and software agents can read this overview, the project and privacy explanations, developer guidance, the OpenAPI description, the sitemap, and llms.txt without running JavaScript or creating an account. Wearer data and administrative actions remain behind the deployment's own authentication boundary.",
        ],
      },
      {
        heading: "Start with a verified release",
        paragraphs: [
          "Production is installed from the checksum-verified operator archive attached to a tagged GitHub release. The server does not need a source checkout or Android toolchain. The bundled revival command creates external configuration, validates provider settings, deploys digest-pinned images, imports the signed Pin archive, and verifies the public release identity.",
        ],
        links: [
          {
            href: "/developers",
            label: "Developer and deployment guide",
            description: "Discover the CLI, public API, authentication model, and agent instructions.",
          },
          {
            href: `${PUBLIC_REPOSITORY_URL}/releases`,
            label: "Verified releases",
            description: "Download source-independent operator and Pin release artifacts.",
          },
        ],
      },
    ],
  },
  "/about": {
    path: "/about",
    title: `About ${PUBLIC_PROJECT_NAME}`,
    description:
      "How the independent Ai Pin Revival project keeps a Humane Ai Pin usable through Center, Cosmos, and device software.",
    sections: [
      {
        heading: "An independent revival project",
        paragraphs: [
          "Ai Pin Revival is community software for people who still own a Humane Ai Pin and want to operate it after the original cloud service ended. It is not Humane, is not affiliated with Humane, and is not endorsed by Humane. The project preserves protocol and Android identifiers only where the stock software requires exact compatibility.",
          "The product has three release-coupled parts. Center is the browser interface for owners and operators. Cosmos provides stock-compatible device services, identity, assistant tools, search, media, and storage. The Pin release contains the Android installer, bootstrap application, injected Hook, Server, and injector required to connect the physical device.",
        ],
      },
      {
        heading: "Operator ownership",
        paragraphs: [
          "Each deployment belongs to its operator. Accounts, certificates, provider credentials, databases, device identities, and runtime data live in that operator's environment. The project publishes software and deployment artifacts; it does not provide a central hosted account, retain a copy of a self-hosted deployment's wearer data, or silently substitute third-party provider credentials.",
          "Changes are developed in the public repository and shipped as immutable, checksum-verified releases. The release identity exposed by Center lets people and automated verification tools confirm which exact build is running. Contributions should keep the implementation direct, remove dead paths, and preserve the wire contracts the stock Pin actually uses.",
        ],
        links: [
          {
            href: PUBLIC_REPOSITORY_URL,
            label: "Source repository",
            description: "Read the code, release history, issue tracker, and contribution workflow.",
          },
        ],
      },
    ],
  },
  "/contact": {
    path: "/contact",
    title: `Contact and support for ${PUBLIC_PROJECT_NAME}`,
    description:
      "Where operators, users, security researchers, and contributors should report Ai Pin Revival questions or problems.",
    sections: [
      {
        heading: "Project support",
        paragraphs: [
          "Ai Pin Revival is an open-source, self-hosted project rather than a centralized customer service. For reproducible software defects, installation problems, documentation corrections, and feature proposals, use the public GitHub issue tracker. Include the affected release identifier, the command that failed, and redacted output that contains no passwords, tokens, certificates, device credentials, or wearer content.",
          "Questions about a particular private deployment belong to that deployment's operator. The public project cannot inspect an operator's server, reset its accounts, recover its provider secrets, or access data stored by its Pin. If you are a wearer rather than the operator, use the contact route your operator gave you instead of publishing private device information in an issue.",
        ],
      },
      {
        heading: "Security and responsible reporting",
        paragraphs: [
          "Do not place an exploitable security report or sensitive evidence in a public issue. Use GitHub's private security-advisory reporting flow for the repository when it is available. Describe the affected component, release, impact, and minimum reproduction while withholding real credentials and personal data. Reports about Humane services or hardware outside this project's code should be directed to the appropriate owner of those systems.",
          "The maintainers cannot provide emergency service guarantees. Operators should keep control of their own domain, server access, provider accounts, and signing material so they can diagnose or stop their deployment without depending on a project maintainer. Public status and machine-readable documentation on this site are informational and never grant access to wearer or administrator data.",
        ],
        links: [
          {
            href: `${PUBLIC_REPOSITORY_URL}/issues`,
            label: "Public issue tracker",
            description: "Report non-sensitive bugs, setup problems, and documentation issues.",
          },
          {
            href: `${PUBLIC_REPOSITORY_URL}/security/advisories/new`,
            label: "Private security report",
            description: "Report a vulnerability without disclosing it in a public issue.",
          },
        ],
      },
    ],
  },
  "/privacy": {
    path: "/privacy",
    title: `${PUBLIC_PROJECT_NAME} privacy`,
    description:
      "A plain-language explanation of what the public project publishes and what a self-hosted Center and Cosmos deployment controls.",
    sections: [
      {
        heading: "Your operator controls the deployment",
        paragraphs: [
          "Ai Pin Revival is self-hosted software. The operator of a particular Center and Cosmos instance determines where it runs, who can sign in, which assistant or media providers are connected, how long data is retained, and who can administer the Pin. That operator—not a shared Ai Pin Revival cloud—is responsible for the deployment's privacy notice, lawful basis, access controls, retention choices, and responses to wearer requests.",
          "Depending on enabled features, a deployment can process account details, device identity, assistant conversations, captures, notes, contacts, calls, music activity, settings, diagnostics, and provider tokens. Private routes require the deployment's authentication. Secrets and runtime data are stored outside the release archive, and normal deployments preserve rather than publish them.",
        ],
      },
      {
        heading: "Public project surfaces",
        paragraphs: [
          "This public site exposes product information, documentation, a sitemap, llms.txt, an OpenAPI description, release metadata, and downloadable signed Pin artifacts selected by the operator. Those surfaces contain no wearer records or provider credentials. Requests still pass through the operator's hosting, DNS, reverse proxy, and any content-delivery service, whose logs and policies are controlled by that operator and its infrastructure providers.",
          "The public source repository is separate from every running deployment. Information intentionally submitted to GitHub issues, discussions, pull requests, or security reports is handled under GitHub's terms and is visible according to the chosen submission channel. Never submit live credentials, private keys, unredacted diagnostics, captures, conversation content, or personal contact data to the public repository.",
        ],
      },
      {
        heading: "Data access and deletion",
        paragraphs: [
          "For data held by a specific Center or Cosmos deployment, contact that deployment's operator. The open-source maintainers cannot view or delete records on a server they do not operate. An operator can use Center and the deployment's own administrative tools to manage accounts and data, and remains responsible for infrastructure-level logs or copies created by services they selected.",
        ],
        links: [
          {
            href: "/contact",
            label: "Contact and support",
            description: "Choose the correct public or deployment-specific support route.",
          },
        ],
      },
    ],
  },
  "/developers": {
    path: "/developers",
    title: `${PUBLIC_PROJECT_NAME} developers`,
    description:
      "Deployment quickstart, CLI discovery, public API contracts, authentication boundaries, and guidance for coding agents.",
    sections: [
      {
        heading: "Use the release CLI",
        paragraphs: [
          "The supported production interface is the revival CLI inside the checksum-verified operator archive. It sets up external configuration, checks prerequisites, renders a dry run, deploys digest-pinned images, verifies the live release, and imports the signed five-application Pin archive. Production servers do not compile this repository and should not deploy a mutable source checkout.",
          "Developers who are changing source can clone the repository and use the same root command for focused checks. Run the owning component while iterating, then run the relevant broad gate once before handoff. Tool versions and generated setup contracts are machine-owned so an agent should read command help and those contracts instead of inferring behavior from old prose.",
        ],
        links: [
          {
            href: `${PUBLIC_REPOSITORY_URL}#deploy-cosmos`,
            label: "Deployment quickstart",
            description: "Install Cosmos and Center from an immutable GitHub release.",
          },
          {
            href: `${PUBLIC_REPOSITORY_URL}#development`,
            label: "Contributor workflow",
            description: "Use fast focused checks and external build caches.",
          },
        ],
      },
      {
        heading: "Public HTTP API",
        paragraphs: [
          "GET /api/version returns the product name, immutable release identifier, and runtime environment. GET /api/pin/releases/current returns the currently imported signed Pin manifest when the operator has enabled that surface. These read-only endpoints require no API key. The complete typed contract, unique operation identifiers, response schemas, and error shapes are published at /openapi.json.",
          "Wearer and operator APIs are intentionally not general public integrations. They use the Center browser session and enforce wearer or operator authorization; the OpenAPI description does not pretend that a reusable public API key exists. Automated clients should use only documented public operations unless they are acting inside an operator-controlled authenticated browser workflow.",
        ],
        links: [
          {
            href: "/openapi.json",
            label: "OpenAPI 3.1 description",
            description: "Parse the public read API and its typed response schemas.",
          },
          {
            href: "/api/version",
            label: "Live deployment identity",
            description: "Verify the release and production environment currently served.",
          },
        ],
      },
      {
        heading: "When an agent should use this project",
        paragraphs: [
          "Use Ai Pin Revival when the goal is to self-host replacement services for a Humane Ai Pin, deploy or verify Center and Cosmos, build the five signed Pin applications, connect supported assistant or media providers, diagnose a documented installation failure, or contribute to the implementation. It is not a hosted Humane service, a generic assistant API, or a way to access someone else's Pin.",
          "A setup agent should ask only for missing deployment inputs, credentials entered through standard input, DNS or firewall changes, and physical device interactions it cannot perform. It should preserve external provider configuration, avoid printing secrets, use the verified release archive for production, and finish by checking that /api/version reports the intended release with environment production.",
        ],
        links: [
          {
            href: "/llms.txt",
            label: "Agent instruction index",
            description: "Read the concise when-to-use guidance and canonical public resources.",
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
