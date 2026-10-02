import styles from "./page.module.css";

export function Page({
  children,
  width = "wide",
  className,
}: {
  children: React.ReactNode;
  width?: "wide" | "content" | "narrow";
  className?: string;
}) {
  return (
    <div className={[styles.page, styles[width], className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.heading}>
        <div className={styles.titleRow}>
          <h1>{title}</h1>
          {meta ? <span className={styles.meta}>{meta}</span> : null}
        </div>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

export function ListRow({
  title,
  description,
  leading,
  value,
  action,
  testId,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  leading?: React.ReactNode;
  value?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className={styles.listRow} data-testid={testId}>
      {leading ? <span className={styles.listLeading}>{leading}</span> : null}
      <span className={styles.listCopy}>
        <span className={styles.listTitle}>{title}</span>
        {description ? <span className={styles.listDescription}>{description}</span> : null}
      </span>
      {value ? <span className={styles.listValue}>{value}</span> : null}
      {action ? <span className={styles.listAction}>{action}</span> : null}
    </div>
  );
}
