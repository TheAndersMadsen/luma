import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { HumaneLogo } from "@/icons";
import {
  PUBLIC_PROJECT_NAME,
  PUBLIC_REPOSITORY_URL,
  publicPage,
  type PublicPageDefinition,
} from "@/lib/public-site";
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
      images: [{
        url: "/revival-hero.webp",
        width: 1600,
        height: 640,
        alt: "Ai Pin Revival connecting a Pin to a private Cosmos server",
      }],
    },
  };
}

function PublicHref({ href, children }: { href: string; children: React.ReactNode }) {
  return href.startsWith("/") ? <Link href={href}>{children}</Link> : <a href={href}>{children}</a>;
}

export function PublicPage({ path }: { path: PublicPageDefinition["path"] }) {
  const page = publicPage(path);
  if (!page) throw new Error(`Unknown public page: ${path}`);
  const isHome = path === "/";

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/" aria-label={`${PUBLIC_PROJECT_NAME} home`}>
            <HumaneLogo size={25} />
            <span>{PUBLIC_PROJECT_NAME}</span>
          </Link>
          <nav className={styles.nav} aria-label="Public information">
            <Link aria-current={path === "/about" ? "page" : undefined} href="/about">About</Link>
            <Link aria-current={path === "/developers" ? "page" : undefined} href="/developers">Developers</Link>
            <Link aria-current={path === "/privacy" ? "page" : undefined} href="/privacy">Privacy</Link>
            <Link aria-current={path === "/contact" ? "page" : undefined} href="/contact">Contact</Link>
            <Link className={styles.signIn} href="/login">Open Center</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className={`${styles.hero} ${isHome ? styles.heroHome : styles.heroInner}`}>
          {isHome ? (
            <div className={styles.heroMedia}>
              <Image
                src="/revival-hero.webp"
                width={1600}
                height={640}
                sizes="100vw"
                priority
                alt="A Pin connected by a cyan beam to a private Cosmos server"
              />
            </div>
          ) : <div className={styles.orbit} aria-hidden="true" />}
          <div className={styles.heroShade} aria-hidden="true" />
          <div className={styles.heroContent}>
            <p className={styles.eyebrow}>{page.eyebrow}</p>
            <h1>{page.headline}</h1>
            <p className={styles.lede}>{page.description}</p>
            {isHome ? (
              <div className={styles.heroActions}>
                <Link className={styles.primaryAction} href="/login">Open Center</Link>
                <Link className={styles.secondaryAction} href="/developers">Set up Cosmos</Link>
              </div>
            ) : null}
          </div>
          {isHome ? <p className={styles.heroCaption}>Center · Cosmos · Pin</p> : null}
        </section>

        <div className={styles.main}>
          <div className={styles.sections}>
            {page.sections.map((section, index) => (
              <section key={section.heading} className={styles.section}>
                <div className={styles.sectionHeading}>
                  <span className={styles.sectionNumber} aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h2>{section.heading}</h2>
                </div>
                <div className={styles.sectionBody}>
                  {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                  {(section.links?.length ?? 0) > 0 ? (
                    <ul className={styles.links}>
                      {section.links?.map((link) => (
                        <li key={link.href}>
                          <PublicHref href={link.href}>
                            <strong>{link.label}</strong>
                            <span>{link.description}</span>
                            <span className={styles.linkArrow} aria-hidden="true">
                              {link.href.startsWith("/") ? "→" : "↗"}
                            </span>
                          </PublicHref>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <HumaneLogo size={22} />
            <span>Independent community software.<br />Not affiliated with Humane.</span>
          </div>
          <nav className={styles.footerNav} aria-label="Machine-readable resources">
            <Link href="/llms.txt">llms.txt</Link>
            <Link href="/sitemap.xml">Sitemap</Link>
            <Link href="/openapi.json">OpenAPI</Link>
            <a href={PUBLIC_REPOSITORY_URL}>Source</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
