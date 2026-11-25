import type { ComposerTriggerStyle } from "../shared/settings";

type Listener = (style: ComposerTriggerStyle) => void;

const listeners = new Set<Listener>();
let currentStyle: ComposerTriggerStyle = "compact";

export function getTriggerStyle(): ComposerTriggerStyle {
  return currentStyle;
}

export function setTriggerStyle(next: ComposerTriggerStyle): void {
  if (next === currentStyle) return;
  currentStyle = next;
  for (const listener of listeners) {
    listener(next);
  }
}

export function subscribeTriggerStyle(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
