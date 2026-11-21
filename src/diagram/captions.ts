import type { Item } from '../../core/diagram/model.ts'
export const mark = (kind: Item["kind"]) =>
  kind === "note"
    ? ""
    : kind === "loss"
      ? "×"
      : kind === "pressure"
        ? "●"
        : kind === "step"
          ? "▲"
          : "△";
