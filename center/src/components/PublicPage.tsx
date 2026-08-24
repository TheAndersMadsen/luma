import type { Metadata } from "next";
import Link from "next/link";

import { HumaneLogo } from "@/icons";
import { PUBLIC_PROJECT_NAME, publicPage, type PublicPageDefinition } from "@/lib/public-site";
import styles from "./public-page.module.css";

export function publicPageMetadata(path: PublicPageDefinition["path"]): Metadata {
  const page = publicPage(path);
  if (!page) throw new Error(`Unknown public page: ${path}`);
  return {
    title: path === "/" ? { absolute: page.title } : page.title,
    description: page.description,
    alternates: {
      canonical: path,
      types: { "text/markdown": path === "/" ? "/index.md" : `${path}.md` },
    },
    openGraph: {
      type: "website",
      url: path,
      title: page.title,
      description: page.description,
      images: [{ url: "/icon-512.png", width: 512, height: 512, alt: PUBLIC_PROJECT_NAME }],
    },
  };
}

function PublicHref({ href, children }: { href: string; children: React.ReactNode }) {
  return href.startsWith("/") ? <Link href={href}>{children}</Link> : <a href={href}>{children}</a>;
}

export function PublicPage({ path }: { path: PublicPageDefinition["path"] }) {
  const page = publicPage(path);
  if (!page) throw new Error(`Unknown public page: ${path}`);

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label={`${PUBLIC_PROJECT_NAME} home`}>
          <HumaneLogo size={26} />
          <span>{PUBLIC_PROJECT_NAME}</span>
        </Link>
        <nav className={styles.nav} aria-label="Public information">
          <Link href="/about">About</Link>
          <Link href="/developers">Developers</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/contact">Contact</Link>
          <Link className={styles.signIn} href="/login">Sign in</Link>
        </nav>
      </header>

      <main className={styles.main}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Self-hosted Ai Pin services</p>
          <h1>{page.title}</h1>
          <p className={styles.lede}>{page.description}</p>
        </div>

        <div className={styles.sections}>
          {page.sections.map((section) => (
            <section key={section.heading} className={styles.section}>
              <h2>{section.heading}</h2>
              {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              {(section.links?.length ?? 0) > 0 ? (
                <ul className={styles.links}>
                  {section.links?.map((link) => (
                    <li key={link.href}>
                      <PublicHref href={link.href}><strong>{link.label}</strong></PublicHref>
                      <span>{link.description}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      </main>

      <footer className={styles.footer}>
        <span>Independent community software. Not affiliated with Humane.</span>
        <span><Link href="/llms.txt">llms.txt</Link> · <Link href="/sitemap.xml">Sitemap</Link> · <Link href="/openapi.json">OpenAPI</Link></span>
      </footer>
    </div>
  );
}
