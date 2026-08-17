"use client";

/**
 * The confirmation modal in front of every destructive device action. Ported
 * from the retired Setup SPA's `install/components/ConfirmActionModal.tsx`.
 *
 * Deliberately not dismissible by a backdrop click (see InstallDialog): the
 * only ways out are Cancel, Escape, or choosing an action.
 */

import { useRef } from "react";
import styles from "./install.module.css";
import { InstallDialog } from "./InstallDialog";
import type {
  InstallConfirmationChoiceAction,
  InstallConfirmationDialog,
  InstallConfirmationRequirement,
} from "./useInstallActionConfirmation";

function getRequirementToneClass(requirement: InstallConfirmationRequirement) {
  if (requirement.kind === "risk") {
    return styles.requirementDanger;
  }

  if (
    requirement.kind === "known-conflicts" ||
    requirement.kind === "remove-conflicts" ||
    requirement.kind === "bootstrap-recovery" ||
    requirement.kind === "unsupported-device" ||
    requirement.kind === "newer-than-target"
  ) {
    return styles.requirementWarning;
  }

  return "";
}

export function ConfirmActionModal({
  dialog,
  onCancel,
  onConfirm,
}: {
  dialog: InstallConfirmationDialog | null;
  onCancel: () => void;
  onConfirm: (action: InstallConfirmationChoiceAction) => void | Promise<void>;
}) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <InstallDialog
      open={Boolean(dialog)}
      role="alertdialog"
      labelledBy="install-confirm-title"
      describedBy="install-confirm-copy"
      initialFocusRef={confirmButtonRef}
      onDismiss={onCancel}
      closeOnEscape
      lockBodyScroll
    >
      {dialog ? (
        <>
          <div className={styles.heading}>
            <h2 id="install-confirm-title" className={styles.dialogTitle}>
              {dialog.title}
            </h2>
            <p id="install-confirm-copy" className={styles.dialogCopy}>
              {dialog.body}
            </p>
          </div>

          {dialog.requirements.length > 0 ? (
            <ul className={styles.requirements}>
              {dialog.requirements.map((requirement) => (
                <li
                  key={requirement.kind}
                  className={[styles.requirement, getRequirementToneClass(requirement)]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <h3 className={styles.requirementTitle}>{requirement.title}</h3>
                  <p className={styles.requirementCopy}>{requirement.description}</p>
                </li>
              ))}
            </ul>
          ) : null}

          <div className={styles.dialogActions}>
            <button type="button" className={styles.dialogGhost} onClick={onCancel}>
              Cancel
            </button>
            {dialog.choices.map((choice) => (
              <button
                key={`${choice.action}-${choice.label}`}
                ref={choice.recommended ? confirmButtonRef : undefined}
                type="button"
                className={
                  choice.tone === "primary" ? styles.dialogPrimary : styles.dialogSecondary
                }
                onClick={() => {
                  void onConfirm(choice.action);
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </InstallDialog>
  );
}
