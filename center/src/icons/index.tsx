/*
 * Icon components for Center.
 *
 * Paths recovered from the archived Humane Center stay inline so they inherit
 * the surrounding control colour and remain crisp at every density.
 */

type IconProps = { size?: number; className?: string };

const block = { display: "block" } as const;

/** The stock Humane Center partial-eclipse mark. */
export function HumaneLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Humane Logo"
      style={block}
    >
      <title>Humane Logo</title>
      <desc>a graphic of a partial eclipse</desc>
      <path
        fill="currentColor"
        d="m25.12,47.71c12.09,-0.55 22.04,-10.5 22.59,-22.59c0.62,-13.62 -10.23,-24.85 -23.72,-24.85c-0.86,12.67 -11.05,22.86 -23.72,23.72l0,0c0,13.49 11.23,24.34 24.85,23.72"
      />
    </svg>
  );
}

/** Decorative account avatar used inside an already-labelled menu button. */
export function AccountAvatar({ size = 25, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      fill="currentColor"
      style={block}
    >
      <path d="M20 39.2C16.51 39.2 13.28 38.33 10.32 36.6C7.35997 34.87 5.01997 32.53 3.29997 29.6C1.57997 26.67 0.719971 23.47 0.719971 20C0.719971 16.53 1.57997 13.33 3.29997 10.38C5.01997 7.43001 7.35997 5.10001 10.32 3.38001C13.28 1.66001 16.51 0.800011 20 0.800011C23.49 0.800011 26.71 1.66001 29.66 3.38001C32.61 5.10001 34.95 7.43001 36.68 10.38C38.41 13.33 39.28 16.53 39.28 20C39.28 23.47 38.41 26.67 36.68 29.6C34.95 32.53 32.61 34.87 29.66 36.6C26.71 38.33 23.49 39.2 20 39.2ZM20 29.44C22.85 29.44 25.29 28.85 27.32 27.68C28.01 28.05 28.57 28.45 29 28.88C29.45 29.33 29.79 29.81 30 30.32C30.21 30.83 30.35 31.41 30.4 32.08C32.11 30.59 33.45 28.79 34.44 26.7C35.43 24.61 35.92 22.37 35.92 20C35.92 17.09 35.2 14.42 33.76 11.98C32.32 9.54001 30.38 7.60001 27.94 6.16001C25.5 4.72001 22.85 4.00001 20 4.00001C17.12 4.00001 14.46 4.72001 12.02 6.16001C9.57997 7.60001 7.64997 9.54001 6.21997 11.98C4.78997 14.42 4.07997 17.09 4.07997 20C4.07997 22.37 4.56997 24.61 5.53997 26.7C6.50997 28.79 7.86997 30.6 9.59997 32.12C9.64997 31.45 9.78997 30.86 9.99997 30.34C10.21 29.82 10.55 29.33 11 28.88C11.43 28.45 11.99 28.05 12.68 27.68C14.71 28.85 17.15 29.44 20 29.44ZM20 23.76C22.29 23.76 24.01 23.25 25.14 22.22C26.27 21.19 26.84 19.64 26.84 17.56C26.84 16.44 26.54 15.39 25.94 14.42C25.34 13.45 24.52 12.67 23.48 12.1C22.44 11.53 21.28 11.24 20 11.24C18.72 11.24 17.55 11.53 16.5 12.1C15.45 12.67 14.62 13.45 14.02 14.42C13.42 15.39 13.12 16.44 13.12 17.56C13.12 21.69 15.41 23.76 20 23.76Z" />
    </svg>
  );
}

export function Upvote({ size = 16, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 19"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Upvote"
      fill="currentColor"
      style={block}
    >
      <path d="M3.312 8.88L7.632 3.36L8.112 0H8.832C9.344 0 9.736.2 10.008.6C10.296 1 10.472 1.488 10.536 2.064C10.6 2.624 10.592 3.136 10.512 3.6L10.032 6.24H13.392C14 6.24 14.504 6.48 14.904 6.96C15.08 7.184 15.2 7.44 15.264 7.728C15.328 8.016 15.328 8.296 15.264 8.568L14.064 14.04C13.872 14.92 13.424 15.64 12.72 16.2C12.016 16.76 11.216 17.04 10.32 17.04H5.712L3.312 8.88ZM4.464 17.496C4.56 17.8 4.512 18.08 4.32 18.336C4.128 18.592 3.872 18.72 3.552 18.72C3.328 18.72 3.128 18.656 2.952 18.528C2.792 18.4 2.688 18.232 2.64 18.024L0 8.904L1.824 8.376L4.464 17.496Z" />
    </svg>
  );
}

export function Downvote({ size = 16, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 19"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Downvote"
      fill="currentColor"
      style={block}
    >
      <path d="M6.792 18.024C6.296 18.024 5.904 17.824 5.616 17.424C5.344 17.008 5.168 16.52 5.088 15.96C5.024 15.384 5.032 14.872 5.112 14.424L5.592 11.784H2.232C1.944 11.784 1.664 11.72 1.392 11.592C1.136 11.464.92 11.288.744 11.064C.552 10.84.424 10.584.36 10.296C.296 10.008.296 9.72.36 9.432L1.56 3.984C1.768 3.104 2.224 2.384 2.928 1.824C3.632 1.264 4.432.984 5.328.984H9.912L12.312 9.144L7.992 14.664L7.512 18.024H6.792ZM12.984 0L15.624 9.12C15.72 9.424 15.672 9.704 15.48 9.96C15.288 10.216 15.032 10.344 14.712 10.344C14.488 10.344 14.288 10.28 14.112 10.152C13.952 10.024 13.848 9.856 13.8 9.648L11.16.528L12.984 0Z" />
    </svg>
  );
}

export function ForgetData({ size = 19, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 19 22"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Forget data"
      fill="currentColor"
      style={block}
    >
      <path d="M8.058 21.92H7.674C6.634 21.92 5.81 21.888 5.202 21.824C4.594 21.76 4.01 21.544 3.45 21.176C2.906 20.824 2.554 20.24 2.394 19.424C2.346 19.2 2.314 18.904 2.298 18.536V7.52H16.698V18.536C16.698 18.904 16.65 19.2 16.602 19.424C16.442 20.24 16.082 20.824 15.522 21.176C14.978 21.544 14.402 21.76 13.794 21.824C13.186 21.888 12.362 21.92 11.322 21.92H8.058ZM4.698 3.68C4.698 2.912 4.722 2.416 4.77 2.192C4.882 1.584 5.146 1.144 5.562.872C5.978.6 6.41.44 6.858.392C7.322.344 7.946.32 8.73.32H10.266C11.066.32 11.69.344 12.138.392C12.586.44 13.018.6 13.434.872C13.85 1.144 14.114 1.584 14.226 2.192C14.274 2.416 14.298 2.912 14.298 3.68H18.138V5.6H.858V3.68H4.698ZM8.298 10.784C8.298 10.512 8.202 10.288 8.01 10.112C7.834 9.92 7.61 9.824 7.338 9.824C7.082 9.824 6.858 9.92 6.666 10.112C6.474 10.288 6.378 10.512 6.378 10.784V17.216C6.378 17.472 6.474 17.696 6.666 17.888C6.858 18.08 7.082 18.176 7.338 18.176C7.61 18.176 7.834 18.08 8.01 17.888C8.202 17.696 8.298 17.472 8.298 17.216V10.784ZM12.618 10.784C12.618 10.512 12.522 10.288 12.33 10.112C12.154 9.92 11.93 9.824 11.658 9.824C11.402 9.824 11.178 9.92 10.986 10.112C10.794 10.288 10.698 10.512 10.698 10.784V17.216C10.698 17.472 10.794 17.696 10.986 17.888C11.178 18.08 11.402 18.176 11.658 18.176C11.93 18.176 12.154 18.08 12.33 17.888C12.522 17.696 12.618 17.472 12.618 17.216V10.784Z" />
    </svg>
  );
}

export function MusicIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 22 22" width={size} height={size} className={className} aria-hidden="true" fill="currentColor" style={block}>
      <path d="M11 11.5L14.585 15.25L11 19L7.415 15.25L11 11.5ZM3.83 4L7.415 7.75L3.83 11.5L.244 7.75L3.83 4ZM18.17 4L21.756 7.75L18.17 11.5L14.585 7.75L11 11.5L7.415 7.75L11 4L14.585 7.75L18.17 4Z" />
    </svg>
  );
}

export function YoutubeMusicIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 22 22" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <circle cx="11" cy="11" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11" cy="11" r="5.4" stroke="currentColor" strokeWidth="1.1" opacity="0.7" />
      <path d="M9.25 7.9L14.2 11L9.25 14.1V7.9Z" fill="currentColor" />
    </svg>
  );
}

export function SpotifyIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 22 22" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <circle cx="11" cy="11" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.9 8.4C9.9 7.55 13.2 7.8 15.7 9.2M7.5 11.15C10 10.5 12.95 10.7 15 11.85M8.1 13.75C10.2 13.25 12.5 13.4 14.25 14.35" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

export function GenericMusicIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 22 22" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <path d="M9 5.5V15.2M9 7L16 5.3V13.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.8" cy="15.7" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="13.8" cy="13.8" r="2.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function TranslationIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 22 22" width={size} height={size} className={className} aria-hidden="true" fill="currentColor" style={block}>
      <path d="M5.036 2H6.906L9.898 10.14H8.116L7.456 8.27H4.398L3.738 10.14H2L5.036 2ZM18.28 19.6V18.5H14.32V19.6H13V11.46H19.6V19.6H18.28ZM6.906 6.752L6.554 5.74L5.938 3.782C5.747 4.442 5.542 5.087 5.322 5.718L4.948 6.752H6.906ZM5.96 11.68V12.472C5.96 13.323 5.967 13.917 5.982 14.254C6.011 14.591 6.085 14.885 6.202 15.134C6.319 15.369 6.525 15.515 6.818 15.574C6.95 15.603 7.155 15.625 7.434 15.64C7.713 15.64 8.101 15.64 8.6 15.64H10.8V17.4H8.6C8.072 17.4 7.639 17.4 7.302 17.4C6.965 17.385 6.693 17.356 6.488 17.312C5.74 17.165 5.197 16.843 4.86 16.344C4.537 15.831 4.347 15.295 4.288 14.738C4.229 14.181 4.2 13.425 4.2 12.472V11.68H5.96ZM15.64 9.92V9.128C15.64 8.277 15.625 7.683 15.596 7.346C15.581 7.009 15.515 6.723 15.398 6.488C15.281 6.239 15.075 6.085 14.782 6.026C14.65 5.997 14.445 5.982 14.166 5.982C13.887 5.967 13.499 5.96 13 5.96H10.8V4.2H13C13.528 4.2 13.961 4.207 14.298 4.222C14.635 4.222 14.907 4.244 15.112 4.288C15.86 4.435 16.395 4.765 16.718 5.278C17.055 5.777 17.253 6.305 17.312 6.862C17.371 7.419 17.4 8.175 17.4 9.128V9.92H15.64ZM18.28 17.18V15.64H14.32V17.18H18.28ZM18.28 14.32V12.78H14.32V14.32H18.28Z" />
    </svg>
  );
}

export function SearchIcon({ size = 18, className }: IconProps) {
  return (
    <svg viewBox="0 0 12 13" width={size} height={size} className={className} aria-hidden="true" fill="currentColor" style={block}>
      <path d="M0.169922 5.22656C0.169922 4.5625 0.294922 3.9375 0.544922 3.35156C0.794922 2.76562 1.14258 2.25195 1.58789 1.81055C2.0332 1.36523 2.54688 1.01758 3.12891 0.767578C3.71484 0.517578 4.3418 0.392578 5.00977 0.392578C5.67773 0.392578 6.30273 0.517578 6.88477 0.767578C7.4707 1.01758 7.98633 1.36523 8.43164 1.81055C8.87695 2.25195 9.22461 2.76562 9.47461 3.35156C9.72461 3.9375 9.84961 4.5625 9.84961 5.22656C9.84961 5.72656 9.77539 6.20312 9.62695 6.65625C9.48242 7.10938 9.2793 7.52539 9.01758 7.9043L11.543 10.4414C11.6367 10.5391 11.707 10.6465 11.7539 10.7637C11.8047 10.8848 11.8301 11.0137 11.8301 11.1504C11.8301 11.3379 11.7871 11.5078 11.7012 11.6602C11.6152 11.8125 11.498 11.9316 11.3496 12.0176C11.2012 12.1074 11.0293 12.1523 10.834 12.1523C10.7012 12.1523 10.5723 12.1289 10.4473 12.082C10.3223 12.0352 10.2109 11.9629 10.1133 11.8652L7.56445 9.31641C7.19727 9.55078 6.79688 9.73633 6.36328 9.87305C5.93359 10.0059 5.48242 10.0723 5.00977 10.0723C4.3418 10.0723 3.71484 9.94727 3.12891 9.69727C2.54688 9.44727 2.0332 9.09961 1.58789 8.6543C1.14258 8.20898 0.794922 7.69336 0.544922 7.10742C0.294922 6.52148 0.169922 5.89453 0.169922 5.22656ZM1.59375 5.22656C1.59375 5.69922 1.68164 6.14258 1.85742 6.55664C2.03711 6.9668 2.2832 7.32812 2.5957 7.64062C2.9082 7.95312 3.26953 8.19922 3.67969 8.37891C4.09375 8.55469 4.53711 8.64258 5.00977 8.64258C5.48242 8.64258 5.92383 8.55469 6.33398 8.37891C6.74805 8.19922 7.11133 7.95312 7.42383 7.64062C7.73633 7.32812 7.98047 6.9668 8.15625 6.55664C8.33594 6.14258 8.42578 5.69922 8.42578 5.22656C8.42578 4.75781 8.33594 4.31836 8.15625 3.9082C7.98047 3.49414 7.73633 3.13086 7.42383 2.81836C7.11133 2.50195 6.74805 2.25586 6.33398 2.08008C5.92383 1.9043 5.48242 1.81641 5.00977 1.81641C4.53711 1.81641 4.09375 1.9043 3.67969 2.08008C3.26953 2.25586 2.9082 2.50195 2.5957 2.81836C2.2832 3.13086 2.03711 3.49414 1.85742 3.9082C1.68164 4.31836 1.59375 4.75781 1.59375 5.22656Z" />
    </svg>
  );
}

export function PlusIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <path d="M12 4v16M4 12h16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronLeft({ size = 20, className }: IconProps) {
  return (
    <svg viewBox="0 0 11 18" width={size} height={size} className={className} aria-hidden="true" fill="currentColor" style={block}>
      <path d="M2.69 8.995c2.23 2.23 4.376 4.37 6.516 6.515.185.185.39.36.545.57.355.49.34 1-.085 1.435-.425.435-.93.46-1.435.12-.17-.115-.31-.28-.46-.43-2.37-2.365-4.735-4.735-7.1-7.1-.88-.885-.89-1.32-.025-2.185C3.03 5.53 5.416 3.145 7.8.76c.095-.095.185-.19.28-.275.51-.45 1.045-.49 1.56-.03.48.425.485 1.095-.02 1.61-1.27 1.3-2.565 2.58-3.85 3.865a916.706 916.706 0 0 1-3.08 3.065Z" />
    </svg>
  );
}

export function CaretDown({ size = 12, className }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Stock compact back glyph used by Center detail headers. */
export function BackIcon({ size = 20, className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} className={className} aria-hidden="true" fill="currentColor" style={block}>
      <path transform="translate(2,1)" d="M0.164062 7.35938C0.169271 7.16146 0.208333 6.98177 0.28125 6.82031C0.354167 6.65365 0.46875 6.49219 0.625 6.33594L6.53125 0.554688C6.77083 0.320312 7.0599 0.203125 7.39844 0.203125C7.6276 0.203125 7.83594 0.260417 8.02344 0.375C8.21615 0.484375 8.36979 0.632812 8.48438 0.820312C8.59896 1.00781 8.65625 1.21615 8.65625 1.44531C8.65625 1.79427 8.52083 2.09896 8.25 2.35938L3.10156 7.35156L8.25 12.3516C8.52083 12.6224 8.65625 12.9297 8.65625 13.2734C8.65625 13.5026 8.59896 13.7109 8.48438 13.8984C8.36979 14.0859 8.21615 14.2344 8.02344 14.3438C7.83594 14.4583 7.6276 14.5156 7.39844 14.5156C7.0599 14.5156 6.77083 14.3958 6.53125 14.1562L0.625 8.375C0.463542 8.21875 0.346354 8.0599 0.273438 7.89844C0.200521 7.73177 0.164062 7.55208 0.164062 7.35938Z" />
    </svg>
  );
}

export function NotesEmptyIcon({ size = 56, className }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <rect x="10" y="6" width="28" height="36" rx="4" stroke="currentColor" strokeWidth="3" />
      <path d="M17 17h14M17 25h14M17 33h9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PlayBadge({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 17 19" width={size} height={size} className={className} aria-hidden="true" fill="currentColor" style={block}>
      <path d="M1.3258 18.6153C1.0618 18.4687 0.849134 18.256 0.687801 17.9773C0.526467 17.684 0.445801 17.3833 0.445801 17.0753V2.64333C0.445801 2.33533 0.519134 2.04933 0.665801 1.78533C0.827134 1.50666 1.04713 1.27933 1.3258 1.10333C1.60447 0.941995 1.90513 0.861328 2.2278 0.861328C2.55047 0.861328 2.85113 0.941995 3.1298 1.10333L15.6478 8.16533C15.9265 8.312 16.1391 8.52466 16.2858 8.80333C16.4471 9.06733 16.5351 9.368 16.5498 9.70533C16.5498 10.0133 16.4691 10.314 16.3078 10.6073C16.1465 10.886 15.9338 11.0987 15.6698 11.2453L3.1518 18.6153C2.87313 18.7767 2.57247 18.8573 2.2498 18.8573C1.92713 18.8573 1.61913 18.7767 1.3258 18.6153Z" />
    </svg>
  );
}

/** Marks a capture whose full-resolution upload is still pending. */
export function LowResBadge({ size = 20, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <rect x="3" y="5" width="18" height="15" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="m5 17 5-5 3 3 2-2 4 4M8 9h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PhoneIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <path d="M7 4 4 7c1.2 6.3 6.7 11.8 13 13l3-3-4-4-2.3 2.3a14 14 0 0 1-5-5L11 8Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AiMicIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function HealthIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" fill="none" style={block}>
      <path d="M3 12h4l2-5 4 10 2-5h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
