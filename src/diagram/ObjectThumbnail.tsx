import { colors, type Item, type Person } from "../../core/diagram/model.ts";
import { mark } from "./captions.ts";

// Lightweight SVGs mirror the shapes used on the editing canvas.
export default function ObjectThumbnail({
  kind,
  body,
  sex,
}: {
  kind?: Item["kind"];
  body?: boolean;
  sex?: Person["sex"];
}) {
  return (
    <svg viewBox="0 0 100 58" aria-hidden="true" focusable="false">
      {sex ? (
        <g fill="white" stroke="#172b3d" strokeWidth="3">
          {sex === "female" ? (
            <circle cx="50" cy="29" r="23" />
          ) : sex === "male" ? (
            <rect x="27" y="6" width="46" height="46" />
          ) : (
            <path d="M50 4 75 29 50 54 25 29Z" />
          )}
        </g>
      ) : body && kind ? (
        <text
          x="50"
          y="43"
          textAnchor="middle"
          fontSize={kind === "note" ? "25" : "46"}
          fill="#111"
        >
          {kind === "note" ? "メモ" : mark(kind)}
        </text>
      ) : kind ? (
        <g stroke="#6e8b80" strokeWidth="2">
          <rect
            x={kind === "bed" ? 35 : 8}
            y={kind === "wall" ? 23 : kind === "rail" ? 17 : 5}
            width={kind === "bed" ? 30 : 84}
            height={kind === "wall" ? 9 : kind === "rail" ? 25 : 48}
            fill={colors[kind]}
            opacity={kind === "room" ? 0.5 : 0.9}
            rx={kind === "room" ? 0 : 3}
            strokeDasharray={kind === "step" ? "5 3" : undefined}
          />
          {kind === "bed" && (
            <rect x="38" y="9" width="24" height="10" fill="white" rx="2" />
          )}
          {kind === "rail" && (
            <path
              d="M15 29H85"
              stroke="#165b50"
              strokeWidth="5"
              strokeLinecap="round"
            />
          )}
          {kind === "step" && (
            <text
              x="50"
              y="36"
              textAnchor="middle"
              stroke="none"
              fill="#172b3d"
              fontSize="30"
            >
              ▲
            </text>
          )}
        </g>
      ) : null}
    </svg>
  );
}
