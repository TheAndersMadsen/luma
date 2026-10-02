import type { DeviceRecognitionInput } from "./types";

export const RECOGNIZED_MANUFACTURER = "Humane";
export const RECOGNIZED_MODEL = "Ai Pin";

export function isRecognizedAiPin(input: DeviceRecognitionInput): boolean {
  return (
    input.manufacturer === RECOGNIZED_MANUFACTURER &&
    input.model === RECOGNIZED_MODEL
  );
}
